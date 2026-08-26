/* =============================================================================
 * test/sweep_ledger_wiring_test.js — the module is correct; is it plugged in?
 * -----------------------------------------------------------------------------
 * wealthflow-sweep-ledger.js is covered by test/sweep_ledger_test.js, which
 * imports it directly. That suite passes whether or not index.html ever calls
 * it, whether or not the projection is given the sweep legs, and whether or not
 * `sweeps` survives a sync. Every defect below was live with that suite green.
 *
 * TWO OF THESE ARE NOT HYPOTHETICAL.
 *
 * 1. `_wfCashOpts` — the one place the projection options are built — was
 *    written inside another function's body. A nested function declaration is
 *    scoped to its parent, so the identifier did not exist for the four callers
 *    that use it, and `window._wfCashOpts` was only ever assigned if that
 *    unrelated parent happened to run. The visible symptom was the Smart Wealth
 *    Sweeper card silently disappearing: renderSweeper() catches, logs to a
 *    console nobody was reading, and hides itself. Every unit test stayed green
 *    because none of them execute index.html. It was caught by opening the page.
 *
 * 2. The app already contained a `toast(...)` call for a function that has never
 *    existed in this file, wrapped in try/catch — so the message it was written
 *    to show has never once appeared, directly above a comment about not burying
 *    it. Same shape: a call that cannot work, silenced.
 *
 * So these tests ask structural questions about index.html itself: is the
 * function reachable, does every caller go through the one choke point, and does
 * a new record key reach the machinery that syncs and resets it.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanRegions, tokenizeRegion } from '../autonomy/classify-index-diff.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const LINES = HTML.split('\n');

/* The brace depth of every line inside the script, borrowed from the gate's own
 * tokeniser rather than counted again here — it already knows that a brace in a
 * string or a template literal is not a brace. Depth 0 is the top level of the
 * script, which is the only place a function declaration is reachable from
 * everywhere else in it. */
const DEPTH = (() => {
    const regions = scanRegions(LINES);
    const script = [];
    for (let i = 0; i < LINES.length; i++) if (regions[i] === 'script') script.push(i);
    const text = script.map((i) => LINES[i]).join('\n');
    const tok = tokenizeRegion(text);
    expect(tok.ok, `the tokeniser could not read index.html's script: ${tok.reason}`).toBe(true);
    const byLine = new Map();
    script.forEach((lineNo, k) => byLine.set(lineNo, tok.lineDepth[k]));
    return byLine;
})();

/** The brace depth of the line declaring `name`, or null if it is not there. */
function declDepth(name) {
    const re = new RegExp(`^\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`);
    for (let i = 0; i < LINES.length; i++) {
        if (re.test(LINES[i]) && DEPTH.has(i)) return DEPTH.get(i);
    }
    return null;
}

describe('the functions the page calls are actually reachable', () => {
    /* A nested declaration is invisible to every other function in the file, and
     * the failure is silent: the caller throws, a render wrapper catches, and a
     * card quietly stops existing. */
    for (const fn of [
        '_wfCashOpts',
        'renderSweepLedger',
        'wfSweepRecord',
        'wfSweepSettle',
        'wfSweepWithdraw',
        'wfSweepDelete',
        'wfSweepSetRate',
        '_wfRecordObservation',
        '_wfObservations',
        '_wfSweepPatch',
    ]) {
        it(`${fn} is declared at the top level of the script`, () => {
            const d = declDepth(fn);
            expect(d, `${fn} is not declared in index.html's script at all`).not.toBe(null);
            expect(d, `${fn} is nested inside another function, so it does not exist for `
                + 'the code that calls it — this is the defect that made the sweeper card vanish')
                .toBe(0);
        });
    }

    it('and every one the markup calls is exposed on window', () => {
        // An onclick handler resolves against the global object, not the script's
        // scope, so a top-level declaration alone is not enough.
        for (const fn of ['wfSweepRecord', 'wfSweepSettle', 'wfSweepWithdraw', 'wfSweepDelete', 'wfSweepSetRate']) {
            expect(HTML, `${fn} is used in markup but never assigned to window`)
                .toContain(`window.${fn} = ${fn};`);
        }
    });
});

describe('every projection is built from the same options', () => {
    /* Four call sites assembling their own options is how this repository
     * produces its most frequent defect — one gets a fix, the others keep
     * answering the old way, and two screens disagree about the same money. */
    const CALLS = [...HTML.matchAll(/window\.(WFCashflow|WFSweeper)\.(\w+)\(appData,\s*([^\n]*)/g)];

    it('finds the call sites at all, so this test cannot pass by matching nothing', () => {
        expect(CALLS.length).toBeGreaterThanOrEqual(4);
    });

    for (const m of CALLS) {
        it(`${m[1]}.${m[2]} goes through _wfCashOpts`, () => {
            expect(m[3].trimStart().startsWith('_wfCashOpts('),
                `${m[1]}.${m[2]}() builds its own options (${m[3].trim().slice(0, 60)}) instead of `
                + 'using the shared builder, so it will not see recorded sweeps').toBe(true);
        });
    }

    it('the builder hands the sweep legs to the engine', () => {
        const body = /function _wfCashOpts\(extra\) \{([\s\S]*?)\n        \}/.exec(HTML);
        expect(body, '_wfCashOpts not found — retarget this test').not.toBe(null);
        expect(body[1]).toContain('extraCommitments');
        expect(body[1]).toContain('WFSweepLedger');
    });

    it('and survives the ledger module being absent', () => {
        // A broken or unloaded ledger must degrade to the pre-sweep projection,
        // not take the runway card down with it.
        const body = /function _wfCashOpts\(extra\) \{([\s\S]*?)\n        \}/.exec(HTML)[1];
        expect(/try\s*\{/.test(body), '_wfCashOpts does not guard the ledger call').toBe(true);
        expect(/if \(window\.WFSweepLedger\)/.test(body)).toBe(true);
    });
});

describe('sweeps is a first-class record key', () => {
    const keys = (() => {
        const m = /const _WF_RECORD_KEYS = \[([^\]]*)\]/.exec(HTML);
        expect(m, '_WF_RECORD_KEYS not found — retarget this test').not.toBe(null);
        return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    })();

    /** Both places appData is built from nothing: first load, and factory reset. */
    const initialisers = (() => {
        const out = [];
        const re = /\bappData = \{/g;
        let m;
        while ((m = re.exec(HTML))) {
            let depth = 0;
            let i = m.index + m[0].length - 1;
            for (; i < HTML.length; i++) {
                if (HTML[i] === '{') depth++;
                else if (HTML[i] === '}') { depth--; if (!depth) break; }
            }
            out.push(HTML.slice(m.index, i + 1));
        }
        return out;
    })();

    it('there are exactly two appData initialisers, and this test reads both', () => {
        // If a third appears, it needs the same keys and this test should say so
        // rather than silently checking two of three.
        expect(initialisers).toHaveLength(2);
    });

    it('is registered for sync, tombstoning and reset', () => {
        expect(keys, "'sweeps' is not in _WF_RECORD_KEYS, so it is never stamped, "
            + 'never merged across devices and never cleared by a factory reset')
            .toContain('sweeps');
    });

    it.each([0, 1])('initialiser %i declares every record key', (idx) => {
        // The general property, not just sweeps: a key in the registry that no
        // initialiser creates starts life as undefined, and the merge has
        // nothing to merge into.
        for (const k of keys) {
            expect(initialisers[idx], `initialiser ${idx} never creates \`${k}\``)
                .toMatch(new RegExp(`\\b${k}\\s*:\\s*\\[`));
        }
    });
});

describe('the ledger module is loaded the way an ES module has to be', () => {
    it('is referenced from index.html', () => {
        expect(HTML).toContain('src="wealthflow-sweep-ledger.js"');
    });

    it('carries type="module"', () => {
        /* Without it the browser parses an ESM file as a classic script, throws
         * on the first `export`, never assigns window.WFSweepLedger, and the
         * card hides itself by design. That exact failure shipped once already
         * with the cash flow engine. */
        expect(HTML).toMatch(/<script type="module" src="wealthflow-sweep-ledger\.js"><\/script>/);
    });
});

describe('ids that end up inside an onclick are escaped for that context', () => {
    /* _wfEsc is correct for HTML text and for an attribute VALUE, but a value
     * going into a JS string literal inside an attribute passes through two
     * parsers. The HTML one decodes entities before the JS one sees them, so an
     * apostrophe encoded as &#39; arrives as a real quote. */
    const handlers = [...HTML.matchAll(/onclick="(wfSweep\w+)\(\\'' \+ (\w+)\(/g)];

    it('finds the handlers, so this cannot pass by matching nothing', () => {
        expect(handlers.length).toBeGreaterThanOrEqual(4);
    });

    for (const m of handlers) {
        it(`${m[1]} escapes its argument with _wfJsAttr`, () => {
            expect(m[2], `${m[1]} interpolates with ${m[2]}, which does not escape for the `
                + 'JS string context').toBe('_wfJsAttr');
        });
    }

    it('and _wfJsAttr escapes the backslash before the quote', () => {
        // Reversed, the backslash rule would re-escape the escapes it just added.
        const body = /function _wfJsAttr\(s\) \{([\s\S]*?)\n\}/.exec(HTML);
        expect(body, '_wfJsAttr not found — retarget this test').not.toBe(null);
        const backslashAt = body[1].indexOf('\\\\\\\\');
        const quoteAt = body[1].indexOf("\\\\'");
        expect(backslashAt).toBeGreaterThan(-1);
        expect(quoteAt).toBeGreaterThan(-1);
        expect(backslashAt, 'the quote is escaped before the backslash, so the escapes get escaped')
            .toBeLessThan(quoteAt);
    });
});

describe('no call to a function this file does not have', () => {
    it('every bare fn(...) used by the sweep UI exists', () => {
        /* The `toast(...)` shape: a call to something that was never defined,
         * wrapped in try/catch so it fails in silence. Checked for the helpers
         * this feature leans on rather than for the whole file. */
        // Declared either way in this file — `function notify(` but
        // `const fmtS =` — so both forms count as defined.
        for (const fn of ['notify', 'fmtS', 'fmtDatePretty', '_wfEsc', '_wfJsAttr', '_persistRaw']) {
            const declared = new RegExp(`\\b(?:function\\s+${fn}\\s*\\(|(?:const|let|var)\\s+${fn}\\s*=)`).test(HTML);
            expect(declared,
                `the sweep ledger UI calls ${fn}(), which is not defined in index.html`).toBe(true);
        }
    });

    it('and `toast` is not called anywhere, because it is not defined anywhere', () => {
        expect(/\bfunction toast\s*\(/.test(HTML)).toBe(false);
        expect(/[^.\w]toast\(/.test(HTML), 'a call to the undefined toast() is back').toBe(false);
    });
});
