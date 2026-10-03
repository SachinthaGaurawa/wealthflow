/* =============================================================================
 * test/scanned_page_guard_test.js — a photographed or scanned statement meets the same one-statement-once lock
 * -----------------------------------------------------------------------------
 * The statement registry (statement-registry.mjs, /api/statement-guard) is asked by every door a statement can come through. The e-statement and the text-PDF paths of the upload
 * screen asked it once the page was read; the SCANNED-PAGE path (a photo, or a PDF with no text layer, read by the AI) went straight to the review modal. So a statement already in
 * the books — by email sync or by an earlier upload — was added a second time from its photo (the rows' words differ from one reading to the next, so the row-level matcher
 * does not always catch it), and the photo took no claim, so a later email of the same month was not held either.
 *
 * The registry already treats "a photo" as a copy of the same statement; it only needs the bank (the ISSUER label, nothing when unidentified), the account's last four and the
 * transactions' dates. This pins that the scanned path now asks, with those, before the review opens, and that a duplicate stops it.
 * ===========================================================================*/

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const V4 = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'wealthflow-ai-v4.js'), 'utf8');

const source = (header) => {
    const at = V4.indexOf(header);
    expect(at, `${header} is gone from wealthflow-ai-v4.js`).toBeGreaterThan(-1);
    let depth = 0, i = V4.indexOf('{', at);
    for (; i < V4.length; i++) { if (V4[i] === '{') depth++; else if (V4[i] === '}' && --depth === 0) break; }
    return V4.slice(at, i + 1);
};

/** The three functions that talk to the registry, run against a fake guard that records what it is asked. */
function harness({ duplicate = false } = {}) {
    const asked = [];
    const notices = [];
    const sandbox = {
        window: {
            WFStatementCloud: { guard: {
                accountTailOf: (text) => (/ending (\d{4})/.exec(text || '') || [])[1] || '',
                parsed: async (args) => { asked.push(args); return duplicate ? { duplicate: true, via: 'email', notice: 'Already Added' } : { info: { ...args, token: 'T' } }; },
            } },
            notify: (message, kind) => notices.push([message, kind]),
            _hideScanOverlay: vi.fn(),
        },
        Array, String,
    };
    vm.createContext(sandbox);
    vm.runInContext([source('function _wfStatementGuard('), source('function _wfSayDuplicate('), source('async function _wfGuardParsed(')].join('\n'), sandbox);
    return { asked, notices, sandbox, guard: (parsed, ctx) => vm.runInContext('_wfGuardParsed', sandbox)(parsed, ctx) };
}
const page = (rows) => ({ transactions: rows, statement_period: '', _wfBank: null });
const file = { name: 'IMG_2041.jpg', size: 183000 };

describe('the registry is asked about a scanned page', () => {
    it('with the issuer label, the account tail the AI read off the page, the dates and the row count', async () => {
        const h = harness();
        const parsed = page([{ date: '2026-09-02', description: 'KEELLS', amount: 1500 }, { date: '2026-09-14', description: 'DIALOG', amount: 990 }]);
        const blocked = await h.guard(parsed, { file, sha: 'a'.repeat(64), bank: 'Nations Trust Bank', last4: '4421', text: '' });
        expect(blocked).toBe(false);
        expect(h.asked).toHaveLength(1);
        expect(h.asked[0]).toMatchObject({ sha: 'a'.repeat(64), bank: 'Nations Trust Bank', last4: '4421', dates: ['2026-09-02', '2026-09-14'], rows: 2, filename: 'IMG_2041.jpg', size: 183000 });
        expect(parsed._wfGuard).toMatchObject({ bank: 'Nations Trust Bank', last4: '4421', token: 'T' });   // the claim at Save carries it
    });
    it('with no bank when none was identified (the lock never guesses one), and the tail read from OCR text when the AI gave none', async () => {
        const h = harness();
        const parsed = page([{ date: '2026-09-02', description: 'KEELLS', amount: 1500 }]);
        await h.guard(parsed, { file, sha: '', bank: '', last4: '', text: 'Card ending 8812' });
        expect(h.asked[0]).toMatchObject({ bank: '', last4: '8812' });
        expect(parsed._wfGuard).toBeTruthy();                                // still carried, so choosing the bank in the review asks again
    });
    it('a statement already in the books stops the scan: it says so, and the review does not open', async () => {
        const h = harness({ duplicate: true });
        const parsed = page([{ date: '2026-09-02', description: 'KEELLS', amount: 1500 }]);
        expect(await h.guard(parsed, { file, sha: '', bank: 'Nations Trust Bank', last4: '4421', text: '' })).toBe(true);
        expect(h.notices).toHaveLength(1);
        expect(h.notices[0][0]).toContain('already in your books');
        expect(parsed._wfGuard).toBeUndefined();
        expect(h.sandbox.window._hideScanOverlay).toHaveBeenCalled();
    });
    it('an unreachable registry never stops the owner', async () => {
        const h = harness();
        h.sandbox.window.WFStatementCloud.guard.parsed = async () => { throw new Error('offline'); };
        expect(await h.guard(page([{ date: '2026-09-02', description: 'KEELLS', amount: 1500 }]), { file, sha: '', bank: 'Nations Trust Bank', last4: '4421', text: '' })).toBe(false);
    });
});

describe('the scanned path asks before it opens the review', () => {
    const scanned = V4.slice(V4.indexOf('var normalised = ccotTxns.map('), V4.indexOf('var normalised = ccotTxns.map(') + 4200);
    it('the guard sits between the rows being read and the review opening, and the review gets the guarded object', () => {
        const guard = scanned.indexOf('_wfGuardParsed(_parsedS');
        const review = scanned.indexOf('_showCCReviewModal(_parsedS, ccotBank)');
        expect(guard, 'the scanned path no longer asks the registry').toBeGreaterThan(-1);
        expect(review).toBeGreaterThan(guard);
        expect(scanned.indexOf('if (!normalised.length)')).toBeLessThan(guard);
        expect(scanned.slice(guard, scanned.indexOf('\n', guard))).toMatch(/inputEl\.value = ''; return;/);        // a duplicate ends the scan
    });
    it('it gives the registry the issuer label and the AI\'s account tail, like the other two paths', () => {
        const call = /_wfGuardParsed\(_parsedS, \{[^}]*\}/.exec(scanned);
        expect(call).toBeTruthy();
        expect(call[0]).toMatch(/bank: _wfBank && _wfBank\.ok \? _wfBank\.lockName : ''/);
        expect(call[0]).toMatch(/last4: \(_aiBank && _aiBank\.last4\) \|\| ''/);
        expect(call[0]).toMatch(/sha: _wfSha/);
    });
});
