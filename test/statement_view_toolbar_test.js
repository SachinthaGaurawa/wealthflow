/* test/statement_view_toolbar_test.js - a shared loan statement keeps working buttons without inline handlers.
 *
 * The page is a stored HTML document served under a Content-Security-Policy that must not allow
 * inline script. statement-view.js adds /wf-stmt-toolbar.js to it, and that file wires Print, Share
 * and Close by id.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { withToolbarScript } from '../statement-view.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wf-stmt-toolbar.js'), 'utf8');

function run(buttons, win) {
    const doc = { title: 'Loan Statement', getElementById: (id) => buttons[id] || null };
    vm.runInNewContext(SRC, { document: doc, window: win, navigator: win.navigator || {}, console });
}

describe('withToolbarScript', () => {
    it('adds the script tag before </body>, whatever the case', () => {
        expect(withToolbarScript('<html><body><p>x</p></body></html>')).toBe('<html><body><p>x</p><script src="/wf-stmt-toolbar.js"></script></body></html>');
        expect(withToolbarScript('<BODY>a</BODY  >')).toContain('a<script src="/wf-stmt-toolbar.js"></script></BODY');
    });
    it('appends it when there is no body tag, and survives empty input', () => {
        expect(withToolbarScript('<p>x</p>')).toBe('<p>x</p><script src="/wf-stmt-toolbar.js"></script>');
        expect(withToolbarScript('')).toBe('<script src="/wf-stmt-toolbar.js"></script>');
        expect(withToolbarScript(null)).toBe('<script src="/wf-stmt-toolbar.js"></script>');
    });
    it('is a same-origin file the page policy allows, and adds no inline script', () => {
        const out = withToolbarScript('<body></body>');
        expect(out).toMatch(/<script src="\/wf-stmt-toolbar\.js"><\/script>/);
        expect(/<script(?![^>]*\ssrc=)[^>]*>/.test(out)).toBe(false);
    });
    it('the real loan statement the app builds carries no inline handler or script', () => {
        const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const a = idx.indexOf('function _buildLoanStatementHTML');
        const body = idx.slice(a, idx.indexOf('</html>`', a));
        expect(/\son[a-z]+\s*=/.test(body)).toBe(false);
        expect(/<script/i.test(body)).toBe(false);
        for (const id of ['btnPrint', 'btnShare', 'btnClose']) expect(body).toContain('id="' + id + '"');
    });
});

describe('wf-stmt-toolbar.js', () => {
    it('Print prints, Close closes', () => {
        const calls = [];
        const buttons = { btnPrint: {}, btnShare: {}, btnClose: {} };
        run(buttons, { print: () => calls.push('print'), close: () => calls.push('close'), location: { href: 'https://www.wealthflow.lk/r/abc12345' }, navigator: {} });
        buttons.btnPrint.onclick(); buttons.btnClose.onclick();
        expect(calls).toEqual(['print', 'close']);
    });
    it('Share uses the share sheet when there is one, else copies the link', async () => {
        const shared = [];
        const b1 = { btnShare: {} };
        run(b1, { location: { href: 'https://x/r/1' }, navigator: { share: (d) => { shared.push(d.url); return Promise.resolve(); } } });
        b1.btnShare.onclick();
        expect(shared).toEqual(['https://x/r/1']);
        const copied = [];
        const b2 = { btnShare: {} };
        run(b2, { location: { href: 'https://x/r/2' }, navigator: { clipboard: { writeText: (u) => { copied.push(u); return Promise.resolve(); } } } });
        b2.btnShare.onclick();
        expect(copied).toEqual(['https://x/r/2']);
    });
    it('leaves a button that already has a handler alone, and a page without the buttons', () => {
        const mine = () => 'mine';
        const buttons = { btnPrint: { onclick: mine } };
        run(buttons, { print: () => {}, location: { href: '' }, navigator: {} });
        expect(buttons.btnPrint.onclick).toBe(mine);
        expect(() => run({}, { location: { href: '' }, navigator: {} })).not.toThrow();
    });
});
