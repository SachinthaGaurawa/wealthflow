/* =============================================================================
 * test/markup_escaping_test.js — two contexts, two escapers, no exceptions
 * -----------------------------------------------------------------------------
 * index.html builds its entire interface from template literals, so every
 * stored value reaches the DOM through string interpolation. There are two
 * distinct places a value can land, and they need different treatment:
 *
 *   1. HTML text or an attribute VALUE        ->  _wfEsc
 *   2. a JS string literal inside an attribute -> _wfJsAttr
 *      (onclick="fn('HERE')")
 *
 * The second is the one that looks handled and is not. A value there passes
 * through TWO parsers: the HTML parser decodes entities before the JS parser
 * ever sees the text, so an apostrophe written as &#39; arrives at the engine
 * as a real quote and ends the string early. _wfEsc is correct for context 1
 * and insufficient for context 2, which is exactly the sort of distinction that
 * gets lost when 70 call sites are written by hand over two years.
 *
 * WHY A TEST AND NOT A CODE REVIEW
 *
 * Before this sweep the file had both shapes side by side, and in three places
 * a field was interpolated raw while the field NEXT TO IT on the same line was
 * escaped. Nobody chose that; it accumulated. A rule that lives only in
 * reviewers' heads produces exactly this, so the rule lives here instead.
 *
 * THE EXCEPTIONS ARE NAMED, NOT BLANKET
 *
 * Three sites deliberately do NOT escape, because their output is not HTML and
 * escaping would corrupt it — a notification body renders `&amp;` as literal
 * text, and a CSV cell is not markup. Each is listed below by the expression it
 * carries. A new unescaped site does not join them by accident: it fails until
 * somebody adds it here on purpose and says why.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const LINES = HTML.split('\n');

/* ═══════════════════════════════════════════════════════════════════════════
 * CONTEXT 2 — a value inside a JS string literal inside an attribute
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('inline handlers escape for the JS-string context', () => {
    const ATTR = /on[a-z]+="([^"]*)"/g;
    const INNER = /'\$\{([^'"{}]+)\}'/g;

    const sites = [];
    for (let i = 0; i < LINES.length; i++) {
        for (const a of LINES[i].matchAll(ATTR)) {
            for (const m of a[1].matchAll(INNER)) {
                sites.push({ line: i + 1, expr: m[1].trim() });
            }
        }
    }

    it('finds the handlers, so this file cannot pass by matching nothing', () => {
        // If a refactor moves the interface to delegated listeners this drops to
        // zero and the test should be retired deliberately, not silently.
        expect(sites.length).toBeGreaterThan(50);
    });

    it('every interpolated argument goes through _wfJsAttr', () => {
        const bare = sites.filter((s) => !s.expr.startsWith('_wfJsAttr('));
        expect(bare.map((s) => `index.html:${s.line}  ${s.expr}`),
            'these land in a JS string literal inside an HTML attribute, where _wfEsc '
            + 'is not enough — the HTML parser decodes its entities before the JS parser reads them')
            .toEqual([]);
    });

    it('and _wfJsAttr is not used where plain HTML escaping is what is wanted', () => {
        // The reverse mistake: backslash-escaping a value that is only ever read
        // as HTML text would show the backslashes to the user.
        const misuse = [];
        for (let i = 0; i < LINES.length; i++) {
            for (const m of LINES[i].matchAll(/>\s*\$\{_wfJsAttr\(/g)) {
                misuse.push(`index.html:${i + 1}`);
            }
        }
        expect(misuse, '_wfJsAttr is being used for HTML text, where _wfEsc is correct').toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CONTEXT 1 — user text interpolated into markup
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('user text interpolated into markup is escaped', () => {
    /* Fields that hold text a person typed, or that arrives from an import or a
     * synced document. Not an exhaustive list of the app's fields — a list of
     * the ones that carry free text. */
    const FIELDS = '(?:name|product|party|desc|description|note|notes|label|bank'
        + '|company|title|no|cat|category|merchant|payee|reason|why|text)';
    const PAT = new RegExp(String.raw`\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*\.${FIELDS})\s*(?:\|\|[^}]*)?\}`, 'g');
    const WRAPPERS = ['_wfEsc(', '_wfJsAttr(', 'fmt', 'String('];

    /* DELIBERATELY UNESCAPED, because the output is not HTML.
     *
     * Keyed by the expression, with the reason, so adding one is a decision
     * somebody wrote down rather than a regex quietly widening. */
    const NOT_MARKUP = {
        'cause.label': 'the body of a system Notification, which is plain text — '
            + 'escaping would show a payee as &amp; rather than &',
        'e.cat': 'a CSV cell, where an HTML entity would be written into the spreadsheet',
        'c.product': 'a plain-text summary assembled for the assistant, not markup',
    };

    const unescaped = [];
    for (let i = 0; i < LINES.length; i++) {
        for (const m of LINES[i].matchAll(PAT)) {
            const pre = LINES[i].slice(Math.max(0, m.index - 12), m.index);
            if (WRAPPERS.some((w) => pre.includes(w))) continue;
            unescaped.push({ line: i + 1, expr: m[1] });
        }
    }

    it('finds interpolations at all', () => {
        /* Guards against the pattern silently ceasing to match after a refactor,
         * which would make every assertion above vacuously true.
         *
         * PAT deliberately matches only the UNWRAPPED form, so counting it here
         * would count the exceptions and nothing else — which is what a correct
         * file looks like, and would make this guard fire on success. The guard
         * needs the wider question: does the file still interpolate these fields
         * at all, escaped or not? */
        const ANY = new RegExp(String.raw`\$\{[^}]*\b[A-Za-z_$][A-Za-z0-9_$]*\.${FIELDS}\b`, 'g');
        expect([...HTML.matchAll(ANY)].length).toBeGreaterThan(20);
    });

    it('every one is escaped, or is a named exception', () => {
        const rogue = unescaped.filter((u) => !(u.expr in NOT_MARKUP));
        expect(rogue.map((u) => `index.html:${u.line}  \${${u.expr}}`),
            'these reach innerHTML unescaped while neighbouring fields on the same '
            + 'line are escaped — add _wfEsc, or add the expression to NOT_MARKUP with a reason')
            .toEqual([]);
    });

    it('and every named exception is still actually there', () => {
        /* An allowlist entry for a site that no longer exists is dead
         * permission: it stops describing the code and starts hiding whatever
         * takes that name next. */
        const present = new Set(unescaped.map((u) => u.expr));
        for (const expr of Object.keys(NOT_MARKUP)) {
            expect(present.has(expr),
                `NOT_MARKUP lists ${expr}, but nothing in index.html matches it any more — `
                + 'remove the entry rather than leaving an exemption nobody uses').toBe(true);
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ESCAPERS THEMSELVES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the two escapers', () => {
    /** Pull a function's source out of index.html and make it callable here. */
    function extract(name) {
        const at = HTML.indexOf(`function ${name}(`);
        expect(at, `${name} is not in index.html`).toBeGreaterThan(-1);
        let depth = 0;
        let i = HTML.indexOf('{', at);
        const start = i;
        for (; i < HTML.length; i++) {
            if (HTML[i] === '{') depth++;
            else if (HTML[i] === '}') { depth--; if (!depth) break; }
        }
        return HTML.slice(at, i + 1);
    }

    // eslint-disable-next-line no-new-func
    const mk = new Function(`${extract('_wfEsc')}\n${extract('_wfJsAttr')}\nreturn { _wfEsc, _wfJsAttr };`);
    const { _wfEsc, _wfJsAttr } = mk();

    it('_wfEsc neutralises the five characters that matter in markup', () => {
        expect(_wfEsc('<img src=x onerror="a">&\'')).toBe(
            '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
    });

    it('_wfJsAttr keeps a quote inside the JS literal after the HTML parser has run', () => {
        /* The round trip that matters: escape, then decode the entities the way
         * the HTML parser will, then check the result is still one string
         * literal rather than a literal plus whatever follows. */
        const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

        for (const raw of ["sw_abc123", "');alert(1);//", "O'Brien", 'a\\b', "\\'", '<x>&"']) {
            const asJs = decode(_wfJsAttr(raw));
            // eslint-disable-next-line no-new-func
            const roundTripped = new Function(`return '${asJs}';`)();
            expect(roundTripped, `${JSON.stringify(raw)} did not survive the round trip intact`)
                .toBe(raw);
        }
    });

    it('_wfEsc alone would NOT survive that round trip — which is why the second one exists', () => {
        const decode = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
        const asJs = decode(_wfEsc("');alert(1);//"));
        expect(() => new Function(`return '${asJs}';`)(),
            '_wfEsc turned out to be sufficient here, which would make _wfJsAttr pointless — '
            + 'check the reasoning before deleting anything').toThrow();
    });

    it('both coerce null and undefined rather than printing them', () => {
        for (const f of [_wfEsc, _wfJsAttr]) {
            expect(f(null)).toBe('');
            expect(f(undefined)).toBe('');
        }
    });
});
