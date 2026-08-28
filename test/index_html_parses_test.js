/* =============================================================================
 * test/index_html_parses_test.js
 * -----------------------------------------------------------------------------
 * Nothing in this suite syntax-checked index.html, and the file is 27,000 lines
 * of inline script that ships to a browser with no build step. A parse error
 * there is not a degraded feature — it is a blank application, every screen at
 * once, on a personal-finance app people open to check whether they can pay
 * rent.
 *
 * It has happened twice, both times the same way. `WFIcon('x')` spelled out as
 * `${(window.WFIcon ? WFIcon('x') : '')}` only interpolates inside a TEMPLATE
 * literal. Pasted into an ordinary single-quoted string it is literal text
 * whose nested quotes terminate the string early:
 *
 *     '<div>${_ic('target')} TARGET</div>'
 *             ^ string ends here          ^ and the rest is garbage
 *
 * The Settings migration did it in six places at once. The Debt Demolisher
 * migration did it again in one. Both were caught by a check run BY HAND before
 * pushing, which is exactly the kind of discipline that holds until the day it
 * doesn't.
 *
 * So: parse every inline block, the way the browser would.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Inline blocks only — a `src=` script is a separate file with its own tests. */
function inlineScripts(html) {
    const out = [];
    const rx = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = rx.exec(html))) {
        const attrs = m[1] || '';
        // Skip anything that is not JavaScript: JSON-LD, templates, importmaps.
        if (/type\s*=\s*["'](?!text\/javascript|application\/javascript|module)/i.test(attrs)) continue;
        out.push({
            attrs: attrs.trim(),
            body: m[2],
            line: html.slice(0, m.index).split('\n').length,
            module: /type\s*=\s*["']module["']/i.test(attrs),
        });
    }
    return out;
}

const BLOCKS = inlineScripts(HTML);

describe('index.html is syntactically valid JavaScript', () => {
    it('has inline script blocks to check', () => {
        /* If the extraction ever finds nothing — a changed tag shape, a regex
         * that stopped matching — every assertion below would pass while
         * checking an empty list. That is the failure mode this repository has
         * hit four times in its harnesses, so it gets its own assertion. */
        expect(BLOCKS.length, 'no inline <script> blocks found — the extractor is broken')
            .toBeGreaterThanOrEqual(3);
        const bytes = BLOCKS.reduce((n, b) => n + b.body.length, 0);
        expect(bytes, 'the blocks found are too small to be this application')
            .toBeGreaterThan(500_000);
    });

    it.each(BLOCKS.map((b, i) => [i + 1, b.line]))(
        'block %i (line %i) parses',
        (i, line) => {
            const b = BLOCKS[i - 1];
            let err = null;
            try {
                if (b.module) new vm.SourceTextModule(b.body);   // only if --experimental-vm-modules
                else new vm.Script(b.body);
            } catch (e) {
                /* SourceTextModule needs a flag; a ReferenceError for it is a
                 * missing capability, not a syntax error in the page. */
                if (!/SourceTextModule/.test(String(e && e.message))) err = e;
            }
            expect(err && err.message, `index.html would not parse in a browser, from line ${line}`)
                .toBeNull();
        },
    );

    it('carries no interpolation stranded inside a quoted string', () => {
        /* The silent half of the same bug. When the nested quotes happen not to
         * collide, the page still parses and the reader is shown the literal
         * text `${_ic('target')}` on the screen. A parse check cannot see that.
         *
         * Narrow on purpose: a ternary branch that builds markup as a quoted
         * string AND contains an icon interpolation. All three together is the
         * shape that has gone wrong; each alone is ordinary code. */
        const bad = [];
        HTML.split('\n').forEach((l, i) => {
            if (/\?\s*'[^']*\$\{_ic\(/.test(l) || /\?\s*"[^"]*\$\{_ic\(/.test(l)) {
                bad.push(`${i + 1}: ${l.trim().slice(0, 100)}`);
            }
        });
        expect(bad, `interpolation inside a quoted string — use concatenation:\n${bad.join('\n')}`)
            .toEqual([]);
    });
});
