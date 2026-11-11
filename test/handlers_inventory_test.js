/* =============================================================================
 * test/handlers_inventory_test.js — every inline handler the page ships can be run without eval
 * -----------------------------------------------------------------------------
 * The page cannot drop 'unsafe-inline' from its CSP while handlers are inline text. The build
 * (build.mjs) therefore renames them and wealthflow-handlers.js runs them. That only works if
 * EVERY handler in the shipped text is something that interpreter understands, and if every
 * function a handler names is one the interpreter can reach (a property of `window`: a
 * top-level `const` is not, though an inline handler could use it).
 *
 * A handler that fails here is a button that would do nothing in production, so this fails the
 * suite the moment someone writes one the interpreter cannot run. The fix is to write it in the
 * plain form the rest use (a call, with literal arguments) or to add the missing piece to the
 * interpreter, with a test in handlers_interpreter_test.js.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripJs, stripHtml } from '../build-strip.mjs';
import { extractHandlers, renameHandlerAttributes, normalizeHandler } from '../wf-handler-extract.mjs';
import { parseHandler, handlerShape } from '../wealthflow-handlers.js';

const root = new URL('..', import.meta.url).pathname;
const browserJs = fs.readdirSync(root).filter((f) => /^wealthflow-.*\.js$/.test(f));
const pages = ['index.html', 'landing.html', 'tenant.html', 'privacy.html', 'terms.html', 'share-target.html', '404.html'].filter((f) => fs.existsSync(root + f));

const shipped = [];
for (const f of pages) shipped.push([f, stripHtml(fs.readFileSync(root + f, 'utf8')).text]);
for (const f of browserJs) shipped.push([f, stripJs(fs.readFileSync(root + f, 'utf8')).text]);

const found = [];
for (const [file, text] of shipped) for (const h of extractHandlers(text)) found.push({ file, ...h });

// what a handler may name besides the page's own functions
const BROWSER_GLOBALS = new Set(['document', 'window', 'parseInt', 'parseFloat', 'Math', 'Number', 'String', 'JSON', 'Date', 'event', 'setTimeout', 'navigator', 'location', 'history', 'console']);
const allSource = shipped.map(([, t]) => t).join('\n');
const esc = (n) => n.replace(/\$/g, '\\$');
// `function name(`, or `<anything>.name =` (window.name = / W.name = / WF.name =), or `x['name'] =`
const declared = (name) => new RegExp('(?:function\\s+' + esc(name) + '\\s*\\(|\\.' + esc(name) + '\\s*=[^=]|\\[[\'"]' + esc(name) + '[\'"]\\]\\s*=[^=])').test(allSource);

function rootsOf(ast) {
    const names = new Set();
    const walk = (n, bound) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach((x) => walk(x, bound)); return; }
        if (n.t === 'fn') { const b = new Set([...bound, ...n.params]); walk(n.body, b); walk(n.expr, b); return; }
        if (n.t === 'id' && !bound.has(n.n)) names.add(n.n);
        for (const k of Object.keys(n)) if (k !== 't' && k !== 'n') walk(n[k], bound);
    };
    walk(ast, new Set(['event']));
    return names;
}

describe('the handlers the page ships', () => {
    it('finds them (the extraction is not silently empty)', () => {
        expect(found.length).toBeGreaterThan(400);
    });

    it('every one parses', () => {
        const bad = [];
        for (const h of found) { try { parseHandler(h.code); } catch (e) { bad.push(h.file + ': ' + h.code.slice(0, 80) + '  (' + e.message + ')'); } }
        expect(bad).toEqual([]);
    });

    it('every function one names is assigned to a global somewhere (the browser check in build-boot proves it is on window)', () => {
        const missing = new Map();
        for (const h of found) {
            let ast; try { ast = parseHandler(h.code); } catch (_) { continue; }
            for (const n of rootsOf(ast)) if (!BROWSER_GLOBALS.has(n) && !declared(n)) missing.set(n, h.file);
        }
        expect([...missing].map(([n, f]) => n + ' (' + f + ')')).toEqual([]);
    });

    it('has a bounded set of shapes (a handful of patterns, not one per button)', () => {
        const shapes = new Set(found.map((h) => handlerShape(h.code)));
        expect(shapes.size).toBeGreaterThan(50);
        expect(shapes.size).toBeLessThan(700);
    });
});

describe('extraction and renaming', () => {
    it('reads a handler as the browser would', () => {
        expect(normalizeHandler("selectAILanguage(\\'' + code + '\\')")).toBe("selectAILanguage('X')");
        expect(normalizeHandler("open('${_esc(l.id)}', ${n})")).toBe("open('X', 0)");
        expect(normalizeHandler('go(&quot;a&quot;)')).toBe('go("a")');
    });

    it('renames attribute names in markup and leaves property assignments alone', () => {
        const src = `<button onclick="a('x')" class="b">ok</button> el.onclick = fn; el.setAttribute('onclick', "WFCrib.open()"); n.getAttribute('onclick'); {onclick: f}`;
        const out = renameHandlerAttributes(src);
        expect(out.text).toContain(' data-wf-on-click="a(\'x\')"');
        expect(out.text).toContain("el.onclick = fn;");
        expect(out.text).toContain("setAttribute('data-wf-on-click', \"WFCrib.open()\")");
        expect(out.text).toContain("getAttribute('data-wf-on-click')");
        expect(out.text).toContain('{onclick: f}');
        expect(out.renamed).toBe(3);
    });

    it('leaves no handler attribute behind after renaming the shipped text', () => {
        const left = [];
        for (const [file, text] of shipped) {
            const out = renameHandlerAttributes(text).text;
            if (extractHandlers(out).length) left.push(file);
        }
        expect(left).toEqual([]);
    });
});
