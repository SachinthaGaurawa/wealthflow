/* =============================================================================
 * The statement review modal must have a bounded LIVE DOM.
 *
 * This executes the real _showCCReviewModal against linkedom with a 200-row
 * statement. It proves both halves of the contract: iOS only has to own one
 * 12-row control window, while Save still receives every row, including edits
 * made before paging away. A source-pattern test cannot prove either fact.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extractFunction(name) {
    const re = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
    const match = re.exec(HTML);
    if (!match) return '';
    // This is the final named function in the main script and is followed by
    // its explicit public assignment. Using that stable boundary avoids a
    // home-grown JS parser being confused by braces in comments/regex/template
    // literals inside this deliberately large function.
    const end = HTML.indexOf('\n        window._showCCReviewModal =', match.index);
    return end > match.index ? HTML.slice(match.index, end).trim() : '';
}

const BODY = extractFunction('_showCCReviewModal');

function makeHarness(count = 200) {
    const { window, document } = parseHTML('<html><body></body></html>');
    window.WFRoute = null;
    window.WFMerchants = null;
    window.wfQueue = {};
    let queued = null;
    window.wfStatementToQueue = (rows) => { queued = rows; };
    const notifications = [];
    const DB = { get: () => [], set: () => true };
    const parseMoney = (v) => Number(String(v || '').replace(/,/g, '')) || 0;
    const fmtN = (v) => Number(v || 0).toFixed(2);
    const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const factory = new Function(
        'window', 'document', 'DB', 'requestAnimationFrame', 'parseMoney',
        'fmtN', '_wfEsc', 'notify', 'today', 'triggerHaptic',
        `${BODY}; return _showCCReviewModal;`,
    );
    const show = factory(
        window, document, DB, (fn) => fn(), parseMoney, fmtN, esc,
        (message, kind) => notifications.push({ message, kind }),
        () => '2026-09-13', () => {},
    );
    const transactions = Array.from({ length: count }, (_, i) => ({
        date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
        description: `Transaction ${i}`,
        amount: 100 + i,
        direction: 'debit',
        type: 'purchase',
    }));
    return { window, document, show, transactions, notifications, queued: () => queued };
}

describe('statement review live-DOM windowing', () => {
    it('extracts the real modal function', () => {
        expect(BODY.length).toBeGreaterThan(1000);
    });

    it('mounts at most 12 of 200 heavy form rows throughout rapid navigation', () => {
        const h = makeHarness();
        h.show({ transactions: h.transactions, cloudReview: async () => {} }, 'HNB');
        const rows = () => h.document.querySelectorAll('#_ccr_body tr');
        expect(rows().length).toBe(12);
        expect(h.document.querySelector('#_ccr_page_status').textContent).toBe('1–12 of 200');
        const next = h.document.querySelector('#_ccr_next');
        for (let i = 0; i < 30; i += 1) {
            next.click();
            expect(rows().length).toBeLessThanOrEqual(12);
        }
        expect(rows()[0].dataset.idx).toBe('192');
        expect(rows().length).toBe(8);
    });

    it('keeps edits made on an old page and submits all hidden rows', async () => {
        const h = makeHarness();
        let saved = null;
        h.show({
            transactions: h.transactions,
            cloudReview: async (choices) => { saved = choices; },
        }, 'HNB');

        // linkedom does not reflect the HTML `checked` attribute into the
        // checkbox property the way WebKit/Chromium do. Mirror the browser
        // state explicitly before each capture.
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach(el => { el.checked = true; });
        const firstDesc = h.document.querySelector('#_ccr_body tr[data-idx="0"] ._ccr_desc');
        firstDesc.value = 'Edited on page one';
        h.document.querySelector('#_ccr_next').click();
        expect(h.document.querySelector('#_ccr_body tr[data-idx="12"]')).toBeTruthy();
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach(el => { el.checked = true; });
        h.document.querySelector('#_ccr_save').click();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(saved).toHaveLength(200);
        expect(saved[0].row.description).toBe('Edited on page one');
        expect(saved[199].row.description).toBe('Transaction 199');
    });

    it('auto-sort receives every selected model row, not only the visible window', () => {
        const h = makeHarness();
        h.show({ transactions: h.transactions }, 'HNB');
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach(el => { el.checked = true; });
        h.document.querySelector('#_ccr_ai').click();
        expect(h.queued()).toHaveLength(200);
        expect(h.queued()[199].description).toBe('Transaction 199');
    });

    it('the normal filing path processes all hidden rows from model state', async () => {
        const h = makeHarness();
        h.show({ transactions: h.transactions }, 'HNB');
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach(el => { el.checked = true; });
        const bulk = h.document.querySelector('#_ccr_bulkDest');
        Object.defineProperty(bulk, 'value', { configurable: true, value: 'skip' });
        h.document.querySelector('#_ccr_bulkApply').click();
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach(el => { el.checked = true; });
        h.document.querySelector('#_ccr_save').click();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(h.notifications.some(n => /200 skipped/.test(n.message)), JSON.stringify(h.notifications)).toBe(true);
    });
});
