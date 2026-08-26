/* =============================================================================
 * test/module_loading_test.js
 * -----------------------------------------------------------------------------
 * THE BUG THIS PINS, WHICH SHIPPED FOR ABOUT TEN MINUTES
 *
 * wealthflow-cashflow-engine.js uses ESM `export` so the suite can import its
 * functions directly. It was added to index.html as
 *
 *     <script src="wealthflow-cashflow-engine.js" defer></script>
 *
 * A classic script cannot contain `export`. The browser throws
 * "Unexpected token 'export'" at the first one, the file never executes,
 * `window.WFCashflow` is never assigned — and the card that uses it hides
 * itself when the engine is absent, exactly as designed. So the visible symptom
 * of a completely dead module was: nothing.
 *
 * Every unit test still passed, because vitest imports the file through Node,
 * where it is a perfectly good module. It was found only by loading the real
 * page in a real browser.
 *
 * That is this repository's most expensive recurring shape — a thing that
 * looks wired, reports nothing, and does nothing: the vitest config that
 * matched no files, the `auto-safe` label nobody applied, wealthflow-
 * intelligence.js never loaded, the update system claiming installs it never
 * made. This test closes one more entrance to it.
 *
 * -----------------------------------------------------------------------------
 * THE CHECK IS RUN AGAINST KNOWN-BAD INPUT
 *
 * A structural rule that is only ever evaluated on a correct codebase proves
 * nothing — deleting its body would leave the suite green. So the detector
 * below is also run against synthetic markup and synthetic sources that are
 * deliberately wrong, and asserted to reject them.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Strip comments and string literals so `export` inside either is not a match. */
export function stripNonCode(src) {
    return String(src)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' ')
        .replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, "''");
}

/** Does this source use top-level ESM syntax, and therefore REQUIRE type="module"? */
export function usesEsm(src) {
    const code = stripNonCode(src);
    return /^[ \t]*export[ \t\n{*]/m.test(code)
        || /^[ \t]*import[ \t\n{*][^;\n]*\bfrom\b/m.test(code);
}

/** Every `<script src=…>` tag in the HTML, with whether it is a module. */
export function scriptTags(html) {
    return [...String(html).matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
        .map((m) => ({
            src: m[1],
            isModule: /type\s*=\s*["']module["']/i.test(m[0]),
            tag: m[0],
        }));
}

describe('the detector itself', () => {
    it('recognises ESM syntax', () => {
        expect(usesEsm('export function a() {}')).toBe(true);
        expect(usesEsm('export const A = 1;')).toBe(true);
        expect(usesEsm('export default X;')).toBe(true);
        expect(usesEsm('export { a, b };')).toBe(true);
        expect(usesEsm("import fs from 'node:fs';")).toBe(true);
        expect(usesEsm("import { a } from './b.js';")).toBe(true);
    });

    it('is not fooled by the word appearing in a comment or a string', () => {
        expect(usesEsm('// export function a() {}')).toBe(false);
        expect(usesEsm('/* export const A = 1; */')).toBe(false);
        expect(usesEsm('var s = "export function a() {}";')).toBe(false);
        expect(usesEsm("var s = 'import x from y';")).toBe(false);
    });

    it('does not flag a classic IIFE module', () => {
        expect(usesEsm('(function (W) { W.X = {}; })(window);')).toBe(false);
        expect(usesEsm('window.exportData = function () {};')).toBe(false);
    });

    it('reads script tags, with or without the module type', () => {
        const t = scriptTags(
            '<script src="a.js" defer></script>'
            + '<script type="module" src="b.js"></script>'
            + "<script src='c.js' type = \"module\"></script>");
        expect(t.map((x) => x.src)).toEqual(['a.js', 'b.js', 'c.js']);
        expect(t.map((x) => x.isModule)).toEqual([false, true, true]);
    });
});

describe('every module index.html loads is loaded the right way', () => {
    const tags = scriptTags(HTML);
    const local = tags.filter((t) => /^[\w.-]+\.m?js$/.test(t.src));

    it('found the script tags at all', () => {
        // If this regex ever stops matching, every assertion below passes
        // vacuously — which is the failure mode this whole file is about.
        expect(local.length).toBeGreaterThan(20);
    });

    for (const t of local) {
        const file = path.join(ROOT, t.src);
        if (!fs.existsSync(file)) continue;
        const esm = usesEsm(fs.readFileSync(file, 'utf8'));

        it(`${t.src} — ${esm ? 'ESM, needs type="module"' : 'classic script'}`, () => {
            if (esm) {
                expect(t.isModule,
                    `${t.src} uses ESM syntax but is loaded as a classic script. The browser `
                    + 'will throw "Unexpected token \'export\'" and the file will never run.')
                    .toBe(true);
            } else {
                expect(t.isModule,
                    `${t.src} is a classic script loaded as type="module". Module scope is not `
                    + 'global scope, so any top-level `var`/`function` it relies on being global '
                    + 'silently stops being visible.')
                    .toBe(false);
            }
        });
    }

    it('a script referenced by index.html actually exists on disk', () => {
        const missing = local.filter((t) => !fs.existsSync(path.join(ROOT, t.src)));
        expect(missing.map((t) => t.src)).toEqual([]);
    });
});

describe('the rule rejects the mistake it was written for', () => {
    /* Known-bad input. Without these, deleting the loop above would not fail. */
    const ESM_SOURCE = 'export function project() { return 1; }\nexport default { project };\n';
    const CLASSIC_SOURCE = '(function (W) { W.Thing = {}; })(window);\n';

    const verdictFor = (html, src, source) => {
        const tag = scriptTags(html).find((t) => t.src === src);
        if (!tag) return 'no-tag';
        const esm = usesEsm(source);
        if (esm && !tag.isModule) return 'esm-as-classic';
        if (!esm && tag.isModule) return 'classic-as-module';
        return 'ok';
    };

    it('catches an ESM file loaded as a classic script — the exact bug', () => {
        expect(verdictFor('<script src="e.js" defer></script>', 'e.js', ESM_SOURCE))
            .toBe('esm-as-classic');
    });

    it('accepts the same file once type="module" is present', () => {
        expect(verdictFor('<script type="module" src="e.js"></script>', 'e.js', ESM_SOURCE))
            .toBe('ok');
    });

    it('catches a classic script loaded as a module', () => {
        expect(verdictFor('<script type="module" src="c.js"></script>', 'c.js', CLASSIC_SOURCE))
            .toBe('classic-as-module');
    });

    it('accepts a classic script loaded as a classic script', () => {
        expect(verdictFor('<script src="c.js" defer></script>', 'c.js', CLASSIC_SOURCE))
            .toBe('ok');
    });
});

describe('the cash flow engine specifically', () => {
    // Named, because this is the file the bug was found in and the one whose
    // absence is silent by design — renderRunwayCard() hides the card when
    // window.WFCashflow is missing, so a regression here has no symptom.
    const tag = scriptTags(HTML).find((t) => t.src === 'wealthflow-cashflow-engine.js');

    it('is loaded by index.html', () => {
        expect(tag, 'the engine is not referenced by index.html at all').toBeTruthy();
    });

    it('is loaded as a module', () => {
        expect(tag.isModule).toBe(true);
    });

    it('assigns the browser global the card looks for', () => {
        const src = fs.readFileSync(path.join(ROOT, 'wealthflow-cashflow-engine.js'), 'utf8');
        expect(stripNonCode(src)).toMatch(/window\.WFCashflow\s*=/);
        expect(HTML).toMatch(/window\.WFCashflow/);
    });

    it('is only ever called through a guard, since the card must degrade silently', () => {
        const call = /if \(!window\.WFCashflow\) return hide\(\);/;
        expect(call.test(HTML),
            'renderRunwayCard() must check for the engine before using it').toBe(true);
    });
});
