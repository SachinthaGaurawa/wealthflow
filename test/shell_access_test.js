// What a screen reader and a keyboard get from the frame (wealthflow-shell.js): names for controls the screens draw without one,
// Space/Enter on a switch, dialog roles on pop-ups, a way past the sidebar. Found by test/e2e/a11y-audit.mjs on 2026-11-07.
import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';

const HTML = `
<div class="sidebar"><div class="sb-nav"></div></div>
<div class="main"><div class="content">
  <div class="page" id="page-settings">
    <div class="setting-row"><div class="setting-info"><div class="setting-label">Haptic feedback</div></div><div class="toggle on" role="switch" tabindex="0" aria-checked="true" id="t1"></div></div>
    <div class="setting-row"><div class="setting-info"><div class="setting-label">Already named</div></div><div class="toggle" role="switch" aria-label="Own name" id="t2"></div></div>
    <div class="setting-row"><div class="setting-info"><div class="setting-label">Display currency</div></div><select class="fi" id="cur"></select></div>
    <div class="fg"><label class="fl">Projection Years</label><input class="fi" id="mcYears"></div>
    <div class="fg"><label for="named">Has a real label</label><input id="named"></div>
    <select id="dashYear"></select>
    <input id="search" placeholder="Search records">
  </div>
  <div class="mo" id="modalA"><div class="modal-title">Add expense</div></div>
  <div class="mo" id="modalB" role="alertdialog"></div>
</div></div>`;

function boot() {
    const m = loadBrowserModule('wealthflow-shell.js', { html: HTML });
    return { ...m, byId: (id) => m.document.getElementById(id) };
}

describe('names for controls that have none', () => {
    it('a switch takes the label written beside it; one that already has a name keeps it', () => {
        const t = boot();
        expect(t.byId('t1').getAttribute('aria-label')).toBe('Haptic feedback');
        expect(t.byId('t2').getAttribute('aria-label')).toBe('Own name');
    });
    it('a field takes the label of its row, a known id its fixed name, else its placeholder; a field with a real label is left alone', () => {
        const t = boot();
        expect(t.byId('cur').getAttribute('aria-label')).toBe('Display currency');
        expect(t.byId('mcYears').getAttribute('aria-label')).toBe('Projection Years');
        expect(t.byId('dashYear').getAttribute('aria-label')).toBe('Year');
        expect(t.byId('search').getAttribute('aria-label')).toBe('Search records');
        expect(t.byId('named').getAttribute('aria-label')).toBe(null);
    });
    it('a pop-up with no role becomes a named modal dialog; one that has a role is not touched', () => {
        const t = boot();
        const a = t.byId('modalA');
        expect(a.getAttribute('role')).toBe('dialog');
        expect(a.getAttribute('aria-modal')).toBe('true');
        expect(a.getAttribute('aria-label')).toBe('Add expense');
        expect(t.byId('modalB').getAttribute('role')).toBe('alertdialog');
    });
});

describe('the keyboard', () => {
    it('Space and Enter flip a focused switch, other keys do not', () => {
        const t = boot();
        let clicks = 0;
        t.byId('t1').addEventListener('click', () => { clicks++; });
        const press = (key) => { const e = new t.window.Event('keydown', { bubbles: true, cancelable: true }); e.key = key; t.byId('t1').dispatchEvent(e); return e.defaultPrevented; };
        expect(press(' ')).toBe(true);
        expect(press('Enter')).toBe(true);
        expect(press('a')).toBe(false);
        expect(clicks).toBe(2);
    });
    it('there is a skip link first on the page, and it points at the main area', () => {
        const t = boot();
        const a = t.document.body.firstChild;
        expect(a.className).toBe('wf-skip');
        expect(a.getAttribute('href')).toBe('#wfMainContent');
        expect(t.document.querySelector('.main').getAttribute('role')).toBe('main');
        expect(t.document.querySelectorAll('.wf-skip').length).toBe(1);
    });
});
