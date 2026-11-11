/* test/inline_extract_test.js — moving inline <script> blocks into files (wf-inline-extract.mjs) */
import { describe, it, expect } from 'vitest';
import { extractInlineScripts, inlineScriptsLeft } from '../wf-inline-extract.mjs';

const hashOf = (t) => String(t.length).padStart(8, '0');
const run = (html, page = 'index.html') => extractInlineScripts(html, { page, hashOf });

describe('extractInlineScripts', () => {
    it('replaces each inline block in place, in order, with an absolute src', () => {
        const r = run('<head><script>var a=1;</script></head><body>x<script>\nvar b=2;\n</script></body>');
        expect(r.files.map((f) => f.text)).toEqual(['var a=1;', 'var b=2;\n']);
        expect(r.html).toBe('<head><script src="/' + r.files[0].name + '"></script></head><body>x<script src="/' + r.files[1].name + '"></script></body>');
        expect(r.files[0].name).toMatch(/^wealthflow-inline-index-1-\d{8}\.js$/);
        expect(r.files[1].name).toMatch(/^wealthflow-inline-index-2-/);
    });
    it('leaves alone: external, JSON-LD, module, empty, and a data block', () => {
        const html = '<script src="a.js"></script><script type="application/ld+json">{"a":1}</script><script type="module">import "x"</script><script>  </script><script type="speculationrules">{}</script>';
        const r = run(html);
        expect(r.files).toEqual([]);
        expect(r.html).toBe(html);
    });
    it('drops defer and async, which an inline script ignores and an external one would honour', () => {
        const r = run('<script defer async>var a=1;</script>');
        expect(r.html).toMatch(/^<script src="\/wealthflow-inline-[^"]+"><\/script>$/);
    });
    it('keeps text byte for byte, including an escaped closing tag inside a string', () => {
        const body = 'var s = "<\\/script>"; var t = `a${1}b`;';
        const r = run('<script>' + body + '</script>');
        expect(r.files[0].text).toBe(body);
    });
    it('the same text on two pages is one file', () => {
        const a = run('<script>document.documentElement.className+=" js";</script>', 'privacy.html');
        const b = run('<script>document.documentElement.className+=" js";</script>', 'privacy.html');
        expect(a.files[0].name).toBe(b.files[0].name);
    });
    it('the extracted file parses as a classic script', () => {
        const r = run('<script>(function(){ "use strict"; window.__x = 1; })();</script>');
        expect(() => new Function(r.files[0].text)).not.toThrow();
    });
});

describe('inlineScriptsLeft', () => {
    it('lists only blocks that still run as script', () => {
        expect(inlineScriptsLeft('<script src="a.js"></script><script type="application/ld+json">{}</script>')).toEqual([]);
        expect(inlineScriptsLeft('<script>var a;</script>')).toEqual(['var a;']);
    });
});
