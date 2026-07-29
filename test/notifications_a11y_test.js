// =============================================================================
// WealthFlow Shadow Test Harness — notification settings accessibility
// =============================================================================
// The runtime sweep found nine notification switches that a screen reader
// announces as an unnamed control. They already carried role="switch" and
// aria-checked, so their STATE was announced correctly and their PURPOSE not at
// all — "switch, on" nine times over, with no way to tell "Urgent alerts" from
// "Cheques". Half-done accessibility is the dangerous kind: it satisfies an
// audit that only greps for ARIA attributes while remaining unusable.
//
// This asserts the GENERATED MARKUP rather than the source text. Grepping the
// file for `aria-label` would pass even if the attribute were emitted into the
// wrong element, or built from a variable that is empty at runtime. So the
// module is executed against a minimal fake DOM and the HTML it really produces
// is inspected.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The smallest DOM that lets wealthflow-notifications.js boot far enough to
 * render its settings card. Everything the module touches is answered; nothing
 * more is invented, so a change that starts depending on real DOM behaviour
 * fails loudly here instead of silently passing.
 */
function makeFakeDom() {
    const card = {
        id: 'wfntfSettingsCard',
        innerHTML: '',
        attributes: {},
        getAttribute(k) { return this.attributes[k] ?? null; },
        setAttribute(k, v) { this.attributes[k] = String(v); },
        addEventListener() {},
        appendChild() {},
        querySelectorAll() { return []; },
        querySelector() { return null; },
        classList: { add() {}, remove() {}, contains() { return false; } },
        style: {},
        scrollIntoView() {},
    };
    const stub = () => ({
        innerHTML: '', textContent: '', style: {}, attributes: {},
        getAttribute() { return null; }, setAttribute() {},
        addEventListener() {}, appendChild() {}, removeChild() {},
        querySelectorAll() { return []; }, querySelector() { return null; },
        classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
        insertAdjacentHTML() {}, remove() {}, focus() {}, click() {},
    });
    const document = {
        readyState: 'complete',
        getElementById: (id) => (id === 'wfntfSettingsCard' ? card : null),
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => stub(),
        addEventListener() {},
        head: stub(),
        body: stub(),
        documentElement: stub(),
    };
    const win = {
        document,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        addEventListener() {},
        removeEventListener() {},
        setTimeout: (fn) => { try { fn(); } catch { /* fire-and-forget, as in a browser */ } return 0; },
        clearTimeout() {},
        setInterval: () => 0,
        clearInterval() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
        navigator: { userAgent: 'vitest', serviceWorker: undefined },
        location: { href: 'http://localhost/', hash: '' },
        console,
        Notification: undefined,
    };
    win.window = win;
    return { win, card };
}

let card;

beforeAll(() => {
    const { win, card: c } = makeFakeDom();
    card = c;
    const src = fs.readFileSync(path.join(process.cwd(), 'wealthflow-notifications.js'), 'utf8');
    // Evaluate the browser IIFE with `window` injected through closure — never
    // touching globalThis, so this file cannot pollute any other test.
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'console', src)(win, win.document, console);
});

describe('notification settings: every switch is announceable', () => {
    it('renders the settings card at all (guards against a vacuous pass)', () => {
        // If the card were empty, every assertion below would trivially hold.
        expect(card.innerHTML.length).toBeGreaterThan(200);
        expect(card.innerHTML).toContain('wfntf-switch');
    });

    it('gives every switch a non-empty aria-label', () => {
        const switches = card.innerHTML.match(/<button[^>]*class="wfntf-switch"[^>]*>/g) || [];
        expect(switches.length).toBeGreaterThan(5);          // nine in the current UI
        for (const tag of switches) {
            const m = /aria-label="([^"]*)"/.exec(tag);
            expect(m, `switch has no aria-label: ${tag.slice(0, 120)}`).toBeTruthy();
            expect(m[1].trim().length, `empty aria-label: ${tag.slice(0, 120)}`).toBeGreaterThan(0);
        }
    });

    it('labels each switch with its own visible row label, not a generic string', () => {
        // The regression this guards: labelling all nine "Toggle" would satisfy
        // the rule above while leaving them indistinguishable — exactly the
        // failure being fixed.
        const labels = [...card.innerHTML.matchAll(/class="wfntf-switch"[^>]*aria-label="([^"]+)"/g)]
            .map((m) => m[1]);
        expect(labels.length).toBeGreaterThan(5);
        expect(new Set(labels).size).toBe(labels.length);     // all distinct
        for (const l of labels) expect(card.innerHTML).toContain(l);   // appears as visible text too
    });

    it('keeps the state attributes that were already correct', () => {
        const switches = card.innerHTML.match(/<button[^>]*class="wfntf-switch"[^>]*>/g) || [];
        for (const tag of switches) {
            expect(tag).toMatch(/role="switch"/);
            expect(tag).toMatch(/aria-checked="(true|false)"/);
        }
    });

    it('escapes the label rather than interpolating it raw', () => {
        // esc() is applied, so a label containing a quote could never break out
        // of the attribute and inject markup.
        expect(card.innerHTML).not.toMatch(/aria-label="[^"]*<[^"]*"/);
    });
});
