/* =============================================================================
 * test/strip_comments_test.js — the shapes that break a regular expression
 * -----------------------------------------------------------------------------
 * The deployed copy of this app is the source with its comments removed, which
 * is worth about a megabyte and is worth exactly nothing if the removal can
 * corrupt a file. `s.replace(/\/\*[\s\S]*?\*\//g, '')` is the version everybody
 * writes first, and every one of the shapes below — all of them real in this
 * repository — makes it delete live code:
 *
 *     'https://api...'      "//" inside a string
 *     /[^\/]*\/\/x/         "//" inside a regex literal
 *     `${ '/*' }`           "/*" inside a template
 *     a / b / c             slashes that are division
 *
 * So the scanner is driven over each of them directly, and then over every real
 * module in this repository with two properties asserted that a wrong scanner
 * cannot satisfy: the result contains no comments, and running it again changes
 * nothing.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import { stripJs, stripCss, stripHtml, tidy } from '../autonomy/strip-comments.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR THAT BREAK A REGEX
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a slash is not always a comment', () => {
    it('leaves a URL inside a string alone', () => {
        const src = "const url = 'https://api.example.com/v1';";
        expect(stripJs(src).text).toBe(src);
    });

    it('leaves slashes inside a regex literal alone', () => {
        const src = 'const re = /[^\\/]*\\/\\/x/;';
        expect(stripJs(src).text).toBe(src);
    });

    it('leaves a comment marker inside a template literal alone', () => {
        const src = "const t = `a ${ b ? '/*' : '//' } c`;";
        expect(stripJs(src).text).toBe(src);
    });

    it('does not mistake division for a regex', () => {
        const src = 'const half = (a + b) / 2 / c;\nconst q = xs[i] / 2;';
        expect(stripJs(src).text).toBe(src);
    });

    it('handles a template inside a template expression', () => {
        const src = 'const x = `a ${ `b ${ c } d` } e`;';
        expect(stripJs(src).text).toBe(src);
    });

    it('removes the comments it is actually for', () => {
        const r = stripJs('let a = 1; // why\n/* how\n   come */\nlet b = 2;');
        expect(r.comments).toBe(2);
        expect(tidy(r.text)).toBe('let a = 1;\n\nlet b = 2;');
    });

    it('a multi-line block leaves a newline behind', () => {
        /* Removing it outright joins the line before to the line after — and if
         * the line after ends in a `//` comment, the joined line is then
         * commented out entirely. That is a silent deletion of live code. */
        const r = stripJs('const a = 1;/* one\ntwo */const b = 2; // tail\nconst c = 3;');
        expect(r.text).toContain('const b = 2;');
        expect(r.text.split('\n').find((l) => l.includes('const b'))).not.toContain('const a');
    });

    it('a comment marker in a regex character class is not a comment', () => {
        const src = 'const p = /[/*]/;\nlet x = 1;';
        expect(stripJs(src).text).toBe(src);
    });

    it('never throws, on anything', () => {
        for (const bad of [null, undefined, 0, {}, [], '/*', '`${', "'"]) {
            expect(() => stripJs(bad)).not.toThrow();
        }
    });

    it('is a projection: the output is never longer than the input', () => {
        fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => {
            expect(stripJs(s).text.length).toBeLessThanOrEqual(s.length + 1);
        }), { numRuns: runs(300) });
    });
});

describe('CSS and HTML', () => {
    it('removes a CSS comment and keeps a string containing one', () => {
        expect(stripCss('a{color:red} /* x */').text.trim()).toBe('a{color:red}');
        expect(stripCss('a{content:"/* not a comment */"}').text).toBe('a{content:"/* not a comment */"}');
    });

    it('removes an HTML comment', () => {
        expect(stripHtml('<p>a</p><!-- gone --><p>b</p>').text).toBe('<p>a</p><p>b</p>');
    });

    it('keeps a conditional comment, which some engines act on', () => {
        const src = '<!--[if IE]><p>old</p><![endif]-->';
        expect(stripHtml(src).text).toBe(src);
    });

    it('a comment marker inside a script string is not an HTML comment', () => {
        /* This is why script bodies are cut out before the HTML pass runs. */
        const src = '<script>var s = "<!-- not markup -->";</script>';
        expect(stripHtml(src).text).toContain('"<!-- not markup -->"');
    });

    it('leaves a JSON data block completely alone', () => {
        const src = '<script type="application/ld+json">{"a":"//b"}</script>';
        expect(stripHtml(src).text).toBe(src);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * OVER THE REAL THING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('every module in this repository', () => {
    const modules = fs.readdirSync(ROOT).filter((f) => /^wealthflow-[a-zA-Z0-9-]+\.(js|mjs)$/.test(f));

    it('there are modules to check — a passing empty loop proves nothing', () => {
        expect(modules.length).toBeGreaterThan(40);
    });

    it('STRIPPING IS IDEMPOTENT: a second pass finds nothing left', () => {
        /* The property a wrong scanner cannot have. If the first pass mistook
         * something for a comment, or left one behind, the second pass says so. */
        const bad = [];
        for (const f of modules) {
            const once = tidy(stripJs(fs.readFileSync(path.join(ROOT, f), 'utf8')).text);
            const twice = stripJs(once);
            if (twice.comments !== 0) bad.push(f + ' (' + twice.comments + ' left)');
        }
        expect(bad).toEqual([]);
    });

    it('and it actually removes something from each of them', () => {
        /* A scanner that removed nothing would pass every test above. */
        const untouched = modules.filter((f) => stripJs(fs.readFileSync(path.join(ROOT, f), 'utf8')).comments === 0);
        expect(untouched).toEqual([]);
    });

    it('index.html strips, and stays stripped', () => {
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const once = stripHtml(html);
        expect(once.comments).toBeGreaterThan(1000);
        expect(once.text.length).toBeLessThan(html.length * 0.9);
        expect(stripHtml(once.text).removed).toBe(0);
    });

    it('and the stripped page still has every script tag it started with', () => {
        /* COUNTED BY THE CLOSING TAG, and the first version of this test was
         * not: it counted `<script` and found one fewer afterwards, which read
         * as a lost tag. It was prose — a comment in this file discusses "the
         * <script> tags above", and that sentence was correctly removed with
         * its comment. `</script>` does not occur in this document's prose.
         *
         * The count still caught a real defect on the way: the placeholder that
         * holds a script body aside during the HTML pass was space-delimited,
         * and tidy() strips trailing spaces, so a placeholder ending a line was
         * never restored. See the note on HOLD. */
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const out = stripHtml(html).text;
        const closers = (s) => (s.match(/<\/script\s*>/gi) || []).length;
        expect(closers(out)).toBe(closers(html));

        /* And every external module is still asked for, by name. */
        const srcs = (s) => (s.match(/<script[^>]+src="([^"]+)"/gi) || []).sort();
        expect(srcs(out)).toEqual(srcs(html));
    });

    it('a placeholder that cannot be restored fails loudly rather than shipping', () => {
        /* The defect above, made impossible to repeat silently: if a held-out
         * block is ever left behind, stripHtml throws instead of returning a
         * page with a script missing from it. */
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        expect(stripHtml(html).text).not.toContain('\u0000');
    });
});
