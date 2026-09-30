import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { smart, rows, consolidated, savings, current } from './helpers/smart-statements.js';
import { submitRenderedStatement, inspectRenderSource, continueMappedLayout, runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

// The server half of the owner's emailed Smart Statements, end to end and
// against an in-memory Firestore: the attachment is a script-drawn shell the
// server alone reads no rows from, the device sends back what it rendered, and
// the statement must reach the ledger — including from the stale state an
// earlier reader left behind.
const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com';
const sha = value => createHash('sha256').update(value).digest('hex');
const shell = '<html><body><div>Statement Period: 11-Jul-2026 to 10-Aug-2026</div><div id="app"></div><script>document.getElementById("app").innerHTML="rows"</script></body></html>';
const gz = html => gzipSync(Buffer.from(html)).toString('base64');

function setup({ bank, filename, extraSource = {}, extraReview = {}, from = 'Statements@bank.example' } = {}) {
    const sourcePath = `${mailPath}/items/item0`, reviewId = sha(sourcePath);
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: from.toLowerCase(), kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
        [sourcePath]: { uid: 'u', bank, filename, from, messageId: 'm0', status: 'needs_review', hasReview: true, filed: false, cursor: 0, ...extraSource },
        [`users/u/statementReview/${reviewId}`]: { uid: 'u', sourcePath, index: -1, status: 'pending', reason: 'statement-layout-or-reconciliation-needs-review', bank, filename, ...extraReview },
    });
    const open = async () => [{ password: '01021990', bank }];
    const loadAttachment = async () => ({ bytes: Buffer.from(shell), filename, contentSha256: 'x' });
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const board = async () => { throw new Error('ai-consensus-unavailable'); };
    const enqueue = args => runStatementSync({ action: 'drain', ...args, db, owner, env: {}, f, read: readStatement, open, settle: settleStatement, board, loadAttachment });
    return { db, data, sourcePath, reviewId, open, loadAttachment, f, enqueue };
}

describe('an emailed Smart Statement reaches the ledger', () => {
    it('files a card statement the server alone cannot read, into the card tabs', async () => {
        const s = setup({ bank: 'AMEX', filename: 'eStatement_0276.html' });
        const source = await inspectRenderSource({ db: s.db, owner, id: s.reviewId, env: {}, f: s.f, open: s.open, attachment: s.loadAttachment });
        expect(source).toMatchObject({ ok: true, bank: 'AMEX' });
        const result = await submitRenderedStatement({ db: s.db, owner, id: s.reviewId, htmlGz: gz(smart({ rows })), env: {}, f: s.f, enqueue: s.enqueue });
        expect(result).toMatchObject({ mapped: true, replayStatus: 'filed', needsLayout: false });
        const user = s.data.get('users/u');
        expect(user.cconetime.map(r => [r.date, r.amount])).toEqual([['2026-07-13', 1000], ['2026-07-21', 1500], ['2026-07-21', 1500]]);
        expect(user.ccPayments.map(r => [r.date, r.amount])).toEqual([['2026-07-16', 300]]);
        expect(user.cconetime[0]).toMatchObject({ card_last4: '0276', bank: 'AMEX' });
        expect(s.data.get(s.sourcePath).status).toBe('filed');
        expect(s.data.get(`users/u/statementReview/${s.reviewId}`).status).toBe('resolved');
    });
    it('files a consolidated NTB statement — every account — into expenses and income with the real amounts', async () => {
        const s = setup({ bank: 'NTB', filename: 'Consolidated_eStatement_2026JAN.html' });
        const result = await submitRenderedStatement({ db: s.db, owner, id: s.reviewId, htmlGz: gz(consolidated([savings, current])), env: {}, f: s.f, enqueue: s.enqueue });
        expect(result).toMatchObject({ mapped: true, filed: 4, review: 0, replayStatus: 'filed' });
        const user = s.data.get('users/u');
        expect(user.expenses.map(r => [r.date, r.amount, r.ref])).toEqual([['2026-01-02', 300, 'S1'], ['2026-01-03', 500, 'S4']]);
        expect(user.incomeRecv.map(r => [r.date, r.amount])).toEqual([['2026-01-06', 5000], ['2026-02-01', 10]]);
        expect(user.expenses[0].desc).toBe('POS Transaction - SHOP ONE');
        expect(user.cconetime).toEqual([]);
    });
    it('recovers a statement an OLDER reader left stuck behind wrong stored text', async () => {
        // The owner\'s state: reviewed once (renderedRead: true), with text in which
        // "13 JUL 13 JUL" had been read as the year 2013.
        const s = setup({ bank: 'AMEX', filename: 'eStatement_0276.html',
            extraSource: { renderedText: '13 JUL 13 JUL Cash advance LKR 1,000.00 1,000.00 Dr', renderedVerified: false, learnedTemplate: 'old' },
            extraReview: { renderedRead: true, statementText: '13 JUL 13 JUL Cash advance' } });
        const result = await submitRenderedStatement({ db: s.db, owner, id: s.reviewId, htmlGz: gz(smart({ rows })), env: {}, f: s.f, enqueue: s.enqueue });
        expect(result).toMatchObject({ replayStatus: 'filed' });
        expect(s.data.get('users/u').cconetime).toHaveLength(3);
        expect(s.data.get(s.sourcePath)).toMatchObject({ renderedVersion: 2, status: 'filed' });
    });
    it('ignores stored text from an older reader when reprocessing', async () => {
        const s = setup({ bank: 'AMEX', filename: 'eStatement_0276.html',
            extraSource: { status: 'pending', renderedText: '13 JUL 13 JUL Cash advance LKR 1,000.00 1,000.00 Dr', renderedVerified: true } });
        const done = await s.enqueue({ sourcePath: s.sourcePath, maxSteps: 1 });
        expect(s.data.get('users/u').cconetime).toEqual([]);
        expect(done.status).toBe('needs_review');
    });
    it('keeps a statement that will not reconcile in review, with its rendered rows, instead of filing it', async () => {
        const s = setup({ bank: 'AMEX', filename: 'eStatement_0276.html' });
        const result = await submitRenderedStatement({ db: s.db, owner, id: s.reviewId, htmlGz: gz(smart({ rows, closing: '4,701.00' })), env: {}, f: s.f, enqueue: s.enqueue });
        expect(result).toMatchObject({ mapped: true, filed: 0, needsLayout: true });
        expect(s.data.get('users/u').cconetime).toEqual([]);
        expect(s.data.get(`users/u/statementReview/${s.reviewId}`)).toMatchObject({ status: 'pending', renderedRead: 2 });
    });
    it('does not keep asking about a source that can make no more progress', async () => {
        const s = setup({ bank: 'AMEX', filename: 'eStatement_0276.html' });
        s.data.set(`users/u/statementReview/${s.reviewId}`, { ...s.data.get(`users/u/statementReview/${s.reviewId}`), status: 'mapped' });
        s.data.set(s.sourcePath, { ...s.data.get(s.sourcePath), status: 'rejected_unapproved_sender', learnedTemplate: 'x' });
        const enqueue = vi.fn();
        expect(await continueMappedLayout({ db: s.db, owner, id: s.reviewId, enqueue })).toMatchObject({ replayStatus: 'rejected_unapproved_sender', queued: false });
        expect(enqueue).not.toHaveBeenCalled();
    });
});
