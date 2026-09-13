/* =============================================================================
 * test/wealthflow_history_cap_test.js
 * -----------------------------------------------------------------------------
 * wealthflow-history.js aggregates EVERY expense, income, card charge, cheque,
 * loan payment, installment payment and subscription charge ever recorded, and
 * drew every resulting "place" into its own nested <details> tree with no cap
 * at all — the same "renderer kill on a phone" shape that every other long list
 * in this app was already fixed for (see resilience_test.js and its measured
 * 146,027-node example), just in a module deliberately kept self-contained from
 * the rest of the app and so unable to reach that shared helper.
 *
 * A few years of statement imports realistically leaves hundreds of distinct
 * payees. This proves the fix draws a bounded page of places while still
 * reporting the TRUE total in the summary strip and the "show more" bar — a
 * cap that lied about the total would be worse than no cap at all.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/** A DOM stand-in just rich enough for open()/repaint(): every element supports
 *  innerHTML, a captured click listener, and a `.closest`-aware synthetic
 *  target for simulating a tap on the "show more" button. */
function fakeDom() {
    let capturedContent = null;
    let clickHandler = null;
    function mkEl() {
        return {
            _html: '', id: '', className: '', style: {},
            get innerHTML() { return this._html; },
            set innerHTML(v) { this._html = String(v); },
            set textContent(v) { this._html = String(v); },
            appendChild() {}, setAttribute() {}, removeAttribute() {},
            classList: { add() {}, remove() {}, contains() { return false; } },
            addEventListener(type, fn) { if (type === 'click') clickHandler = fn; },
            removeEventListener() {},
            querySelector() {
                // open() only ever queries for #wfh-content; hand back a fresh
                // child and remember it so the test can read what bodyHTML()
                // produced.
                capturedContent = mkEl();
                return capturedContent;
            },
        };
    }
    const doc = {
        createElement: mkEl,
        // repaint() looks the content host back up by id rather than keeping the
        // reference open() captured — without this, "show more" and the filter
        // chips would silently no-op against a null host and the test would not
        // be exercising the real click-to-expand wiring at all.
        getElementById: (id) => (id === 'wfh-content' ? capturedContent : null),
        body: { appendChild() {} },
        head: { appendChild() {} },
        addEventListener() {}, removeEventListener() {},
        readyState: 'complete',
    };
    return {
        doc,
        raf: (fn) => fn(),
        getContentHTML: () => (capturedContent ? capturedContent.innerHTML : ''),
        /** Simulate a tap on the element matching `selector` (only
         *  '[data-wfh-more]' and '.wfh-chip' are exercised here). */
        click(selector) {
            const target = { closest: (sel) => (sel === selector ? { getAttribute: () => 'all' } : null) };
            clickHandler({ target });
        },
    };
}

/** Load the shipped IIFE with a controllable data layer, exactly the pattern
 *  test/insights_actions_test.js already established for a self-contained
 *  module. */
function loadHistory(expenses) {
    const { doc, raf, getContentHTML, click } = fakeDom();
    const DB = { get: (k) => (k === 'expenses' ? expenses : []) };
    const win = { DB };
    // DBget() checks `window.DB` truthy but then reads the BARE global `DB` —
    // true in a real page, where both names resolve to the same object, so it
    // is passed here explicitly rather than "fixed" out from under the module.
    new Function('window', 'document', 'console', 'requestAnimationFrame', 'DB', fs.readFileSync('wealthflow-history.js', 'utf8'))(
        win, doc, { log() {}, warn() {}, error() {} }, raf, DB,
    );
    return { WFHistory: win.WFHistory, getContentHTML, click };
}

function places(n) {
    return Array.from({ length: n }, (_, i) => ({
        id: 'e' + i, cat: 'Test', desc: 'Merchant ' + String(i).padStart(3, '0'),
        month: '2026-01', date: '2026-01-15', amount: 100 + i, source: 'manual',
    }));
}

describe('the history modal caps how many places it draws', () => {
    it('the extraction loaded the real module (guards a vacuous suite)', () => {
        const { WFHistory } = loadHistory(places(3));
        expect(typeof WFHistory.open).toBe('function');
        expect(typeof WFHistory.collect).toBe('function');
    });

    it('a short list is drawn whole, with no "show more" bar', () => {
        const { WFHistory, getContentHTML } = loadHistory(places(5));
        WFHistory.open({});
        const html = getContentHTML();
        expect((html.match(/class="wfh-place"/g) || [])).toHaveLength(5);
        expect(html).not.toContain('data-wfh-more');
    });

    it('bounds a long list of places instead of drawing all of them', () => {
        const { WFHistory, getContentHTML } = loadHistory(places(500));
        WFHistory.open({});
        const html = getContentHTML();
        const drawn = (html.match(/class="wfh-place"/g) || []).length;
        expect(drawn, '500 distinct payees were drawn into one <details> tree — '
            + 'the same renderer-kill shape every other long list in this app was '
            + 'already fixed for').toBeLessThanOrEqual(60);
        expect(html).toContain('data-wfh-more');
    });

    it('reports the REAL total, not the number of places it drew', () => {
        const { WFHistory, getContentHTML } = loadHistory(places(500));
        WFHistory.open({});
        const html = getContentHTML();
        // The summary strip's own "Places" count must be the true total.
        expect(html).toMatch(/Places<b>500<\/b>/);
        expect(html).toContain('Showing 60 of 500 places');
        expect(html, 'the bar does not say the totals above are unaffected')
            .toContain('the totals above cover all 500');
    });

    it('tapping "show more" reveals more places without re-fetching or reordering', () => {
        const { WFHistory, getContentHTML, click } = loadHistory(places(500));
        WFHistory.open({});
        expect((getContentHTML().match(/class="wfh-place"/g) || [])).toHaveLength(60);
        click('[data-wfh-more]');
        const drawnAfter = (getContentHTML().match(/class="wfh-place"/g) || []).length;
        expect(drawnAfter, 'show more only adds a page; anything else moves rows under '
            + 'the finger that is tapping').toBe(120);
    });

    it('changing the category filter resets back to one page', () => {
        const { WFHistory, getContentHTML, click } = loadHistory(places(500));
        WFHistory.open({});
        click('[data-wfh-more]');
        expect((getContentHTML().match(/class="wfh-place"/g) || [])).toHaveLength(120);
        click('.wfh-chip');
        expect((getContentHTML().match(/class="wfh-place"/g) || []), 'a filter change kept the '
            + 'previous view\'s expanded page size instead of starting over').toHaveLength(60);
    });

    it('survives an empty store', () => {
        const { WFHistory, getContentHTML } = loadHistory([]);
        WFHistory.open({});
        expect(getContentHTML()).toContain('No transactions yet');
        expect(getContentHTML()).not.toContain('data-wfh-more');
    });
});
