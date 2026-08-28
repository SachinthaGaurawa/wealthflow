/* =============================================================================
 * test/override_arity_test.js
 * -----------------------------------------------------------------------------
 * index.html declares its functions at global scope, so a sibling file doing
 *
 *     window.sendAIMessage = sendAIMessageV5;
 *
 * does not add an alias. At global scope the declaration IS the window
 * property, so the assignment replaces the binding index.html's own call sites
 * resolve. Nine host functions are replaced this way.
 *
 * WHEN THE SIGNATURES DISAGREE, NOTHING WARNS. JavaScript discards extra
 * arguments in silence. The caller keeps passing, the callee never receives,
 * and the feature is simply dead — no error, no console line, nothing to grep
 * for. This has now happened twice in this repository:
 *
 *   _showScanOverlay(stage, detail, pct, icon)  ->  V5 took three.
 *       Every scan stage lost its icon. Caught only by driving a browser.
 *
 *   sendAIMessage(msgOverride)                  ->  V5 took none.
 *       Seven call sites pass a message: every follow-up pill and every
 *       suggested question in the AI chat. The override was dropped, the empty
 *       input was read instead, and the guard for "nothing to send" returned.
 *       Clicking a pill did nothing at all. Verified in a browser before the
 *       fix: window.sendAIMessage.length was 0 and the call added no message.
 *
 * Twice is a pattern, and a pattern belongs in a test rather than in a habit.
 * The map is DERIVED, so an override added tomorrow is checked tomorrow.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SIBLINGS = fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f));

/** Declared parameter names of `function NAME(...)`, or null if not found. */
function params(src, name) {
    const m = src.match(new RegExp(`function\\s+${name}\\s*\\(([^)]*)\\)`));
    if (!m) return null;
    return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** Every `window.HOST = REPLACEMENT;` where both sides are real functions. */
function overrides() {
    const out = [];
    for (const file of SIBLINGS) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
            const [, host, replacement] = m;
            if (host === replacement) continue;
            const hostParams = params(HTML, host);
            const replParams = params(src, replacement);
            if (!hostParams || !replParams) continue;
            out.push({ file, host, replacement, hostParams, replParams });
        }
    }
    return out;
}

const OVERRIDES = overrides();

describe('a replaced function still accepts what its callers pass', () => {
    it('found the overrides to check', () => {
        /* A derivation that quietly returns nothing would make every assertion
         * below pass while checking an empty list — the harness failure this
         * repository has hit repeatedly. */
        expect(OVERRIDES.length, 'no host/replacement pairs found at all').toBeGreaterThanOrEqual(5);
        const names = OVERRIDES.map((o) => o.host);
        expect(names, 'the two known overrides are missing from the map')
            .toEqual(expect.arrayContaining(['sendAIMessage', '_showScanOverlay']));
    });

    it.each(OVERRIDES.map((o) => [o.host, o.replacement, o.file]))(
        '%s -> %s (%s)',
        (host, replacement) => {
            const o = OVERRIDES.find((x) => x.host === host && x.replacement === replacement);
            expect(
                o.replParams.length,
                `${replacement} takes ${o.replParams.length} parameter(s) but replaces `
                + `${host}, which takes ${o.hostParams.length} — [${o.hostParams.join(', ')}]. `
                + 'Arguments past the shorter signature are discarded silently.',
            ).toBeGreaterThanOrEqual(o.hostParams.length);
        },
    );
});

describe('the AI chat send path carries its message', () => {
    const V4 = fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v4.js'), 'utf8');

    /* Brace-counted, not sliced between two landmarks: the first version of
     * this file cut from `sendAIMessageV5` to `parseUserIntent`, which occurs
     * EARLIER in the file, so every slice came back empty and three assertions
     * were checking the empty string. */
    const BODY = (() => {
        const at = V4.indexOf('async function sendAIMessageV5');
        expect(at, 'sendAIMessageV5 is gone').toBeGreaterThan(-1);
        let depth = 0;
        for (let j = V4.indexOf('{', at); j < V4.length; j += 1) {
            if (V4[j] === '{') depth += 1;
            else if (V4[j] === '}') { depth -= 1; if (depth === 0) return V4.slice(at, j + 1); }
        }
        return '';
    })();

    it('the extracted body is the whole function, not an empty slice', () => {
        expect(BODY.length, 'the extractor returned nothing').toBeGreaterThan(400);
        expect(BODY.trimEnd().endsWith('}')).toBe(true);
    });

    it('the callers that make this matter are still wired', () => {
        /* If these disappeared, the guard above would still pass while the
         * feature it protects no longer existed. */
        const withArg = (HTML.match(/sendAIMessage\(\s*[^)\s]/g) || []).length;
        expect(withArg, 'no call site passes a message any more').toBeGreaterThanOrEqual(5);
    });

    it('the live handler takes the override', () => {
        expect(params(V4, 'sendAIMessageV5')).toEqual(['msgOverride']);
    });

    it('uses the override in preference to the input box', () => {
        expect(BODY).toContain('override || inputEl.value.trim()');
    });

    it('only accepts a STRING override', () => {
        /* A call site handing this an Event must fall back to the input box,
         * not stringify an object into the chat. Driven in a browser: passing
         * an Event adds no message. */
        expect(BODY).toContain("typeof msgOverride === 'string'");
    });

    it('passes the override on when it defers to the original handler', () => {
        /* The bug had two halves. Accepting the argument and then calling
         * _originalSendAIMessage() with nothing would have fixed neither. */
        expect(BODY).toContain('_originalSendAIMessage(override');
        expect(BODY, 'the deferral still drops the message').not.toMatch(/_originalSendAIMessage\(\s*\)/);
    });
});
