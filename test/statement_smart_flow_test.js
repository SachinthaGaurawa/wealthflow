import { describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { smart, rows, consolidated, savings, current } from './helpers/smart-statements.js';
import { ntbDoc, amexDoc, savingsRows, textPdf } from './helpers/embedded-statements.js';
import { submitRenderedStatement, inspectRenderSource, continueMappedLayout, runStatementSync, dismissZeroAmountReviews, reopenEmptyStatement } from '../statement-sync.js';
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
        // The bank is filed under its one canonical name whichever spelling the mail carried.
        expect(user.cconetime[0]).toMatchObject({ card_last4: '0276', bank: 'American Express (AMEX)' });
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
        expect(s.data.get(s.sourcePath)).toMatchObject({ renderedVersion: 3, status: 'filed' });
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
        expect(s.data.get(`users/u/statementReview/${s.reviewId}`)).toMatchObject({ status: 'pending', renderedRead: 3 });
    });
    it('closes a month whose own balances prove nothing moved, instead of leaving it in review', async () => {
        const s = setup({ bank: 'AMEX', filename: 'eStatement_0276.html' });
        const result = await submitRenderedStatement({ db: s.db, owner, id: s.reviewId, htmlGz: gz(smart({ rows: [], opening: '4,700.00', closing: '4,700.00' })), env: {}, f: s.f, enqueue: s.enqueue });
        expect(result).toMatchObject({ mapped: true, filed: 0, review: 0, replayStatus: 'filed', needsLayout: false, why: { noMovement: true, rows: 0 } });
        expect(s.data.get(s.sourcePath)).toMatchObject({ status: 'filed', filed: true, emptyStatement: true, hasReview: false });
        expect(s.data.get(`users/u/statementReview/${s.reviewId}`).status).toBe('resolved');
        expect(s.data.get('users/u').cconetime).toEqual([]);
    });
    it('does not close an empty-looking statement whose balances moved, or that printed none', async () => {
        for (const html of [smart({ rows: [], opening: '4,700.00', closing: '5,000.00' }),
            '<html><body><div>Nations Trust Bank American Express</div><div>Statement Period: 11-Jul-2026 to 10-Aug-2026</div></body></html>']) {
            const s = setup({ bank: 'AMEX', filename: 'eStatement_0276.html' });
            await expect(submitRenderedStatement({ db: s.db, owner, id: s.reviewId, htmlGz: gz(html), env: {}, f: s.f, enqueue: s.enqueue })).rejects.toThrow(/rendered-statement-has-no-rows|reconcil/);
            expect(s.data.get(s.sourcePath).status).toBe('needs_review');
            expect(s.data.get(`users/u/statementReview/${s.reviewId}`).status).toBe('pending');
        }
    });
    it('files a consolidated NTB statement whose ledgers carry zero-amount memo lines', async () => {
        const s = setup({ bank: 'NTB', filename: 'Consolidated_eStatement_2026MAR.html' });
        const withMemo = { ...savings, rows: [...savings.rows, ['31-Jan', 'WTax.Pd', 'S9', '0.00', '', '5,710.00'], ['31-Jan', 'Int.Pd', 'S10', '', '0.00', '5,710.00']] };
        const result = await submitRenderedStatement({ db: s.db, owner, id: s.reviewId, htmlGz: gz(consolidated([withMemo, current])), env: {}, f: s.f, enqueue: s.enqueue });
        expect(result).toMatchObject({ mapped: true, filed: 4, review: 0, replayStatus: 'filed' });
        expect(s.data.get('users/u').expenses.map(r => r.amount)).toEqual([300, 500]);
    });
    it('says, in counts only, what the reading made of a statement it could not file', async () => {
        const s = setup({ bank: 'AMEX', filename: 'eStatement_0276.html' });
        const result = await submitRenderedStatement({ db: s.db, owner, id: s.reviewId, htmlGz: gz(smart({ rows, closing: '4,701.00' })), env: {}, f: s.f, enqueue: s.enqueue });
        expect(result.needsLayout).toBe(true);
        expect(result.why).toMatchObject({ verdict: 'unverified', rows: 4, reconciled: false, noMovement: false });
        expect(JSON.stringify(result.why)).not.toMatch(/FOREIGN|Cash advance|0276/);
    });
    it('clears, by itself, the old per-row reviews raised for lines that moved no money', async () => {
        const s = setup({ bank: 'NTB', filename: 'Consolidated_eStatement_2026MAR.html', extraSource: { status: 'needs_review', totalRows: 2, cursor: 2, hasReview: true } });
        const mk = (index, amount) => {
            const id = sha(`ledger-${index}`);
            s.data.set(`users/u/statementReview/${id}`, { uid: 'u', sourcePath: s.sourcePath, index, status: 'pending', reason: 'invalid-transaction', row: { date: '2026-03-31', amount, description: index ? 'Odd' : 'WTax.Pd', direction: 'debit' } });
            s.data.set(`users/u/statementLedger/${id}`, { uid: 'u', sourcePath: s.sourcePath, index, status: 'review' });
            return id;
        };
        const zero = mk(0, 0), misread = mk(1, NaN);
        expect(await dismissZeroAmountReviews({ db: s.db, uid: 'u' })).toBe(1);
        expect(s.data.get(`users/u/statementReview/${zero}`)).toMatchObject({ status: 'dismissed', dismissedBy: 'zero-amount-line' });
        expect(s.data.get(`users/u/statementReview/${misread}`).status).toBe('pending');
    });
    describe('with the app closed — the server reads the bank\'s own data by itself', () => {
        // The attachment is the decrypted Smart Statement. No device renders anything: no render-source, no rendered call.
        const drain = async (bank, filename, html) => {
            const s = setup({ bank, filename, extraSource: { status: 'pending', hasReview: false }, extraReview: {} });
            s.data.delete(`users/u/statementReview/${s.reviewId}`);
            const loadAttachment = async () => ({ bytes: Buffer.from(html), filename, contentSha256: 'x' });
            const enqueue = args => runStatementSync({ action: 'drain', ...args, db: s.db, owner, env: {}, f: s.f, read: readStatement, open: s.open, settle: settleStatement, board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment });
            let last;
            for (let i = 0; i < 6; i++) { last = await enqueue({ sourcePath: s.sourcePath, maxSteps: 1 }); if (last.status === 'filed' || last.status === 'needs_review') break; }
            return { ...s, last };
        };
        it('files a consolidated NTB statement into expenses and income, every row on its own account', async () => {
            const html = ntbDoc({ accounts: [
                { number: '200550088057', opening: 2405889, rows: savingsRows },
                { kind: 'current', number: '300123456789', opening: 250000, rows: [{ date: '2026-01-03', details: 'CEFTS/6719', ref: 'S9', debit: 500 }] },
            ] });
            const s = await drain('NTB', 'Consolidated_eStatement_2026JAN.html', html);
            expect(s.last.status).toBe('filed');
            const user = s.data.get('users/u');
            expect(user.expenses.map(r => [r.date, r.amount, r.card_last4])).toEqual([['2026-01-02', 5599, '8057'], ['2026-01-03', 3000, '8057'], ['2026-01-03', 5, '6789']]);
            expect(user.incomeRecv.map(r => [r.date, r.amount])).toEqual([['2026-01-06', 50000], ['2026-02-01', 6.9]]);
            expect(s.data.get(s.sourcePath)).toMatchObject({ status: 'filed', filed: true, hasReview: false });
        });
        it('keeps what the statement proved about itself beside it, for the audit log', async () => {
            const html = ntbDoc({ accounts: [{ number: '200550088057', opening: 2405889, rows: savingsRows }] });
            const s = await drain('NTB', 'Consolidated_eStatement_2026JAN.html', html);
            const source = s.data.get(s.sourcePath);
            expect(source.status).toBe('filed');
            expect(source.proof).toMatchObject({ math: 'passed', rows: 4, last4: '8057' });
            expect(Object.values(source.proof).includes(undefined)).toBe(false);
            expect(typeof source.proof.opening === 'number' || source.proof.opening === undefined).toBe(true);
        });
        it('files a card statement into the card tabs under the one canonical bank name', async () => {
            const html = amexDoc({ cards: [{ cardNo: '376657*****0276', txs: [
                { post: '13 JUL', description: 'Cash advance from MB', amount: 10000000, dir: 'Dr' }, { post: '16 JUL', description: 'PAYMENT THANK YOU', amount: 30000, dir: 'Cr' }] }], opening: 100000 });
            const s = await drain('AMEX', 'eStatement_0276.html', html);
            expect(s.last.status).toBe('filed');
            const user = s.data.get('users/u');
            expect(user.cconetime.map(r => [r.date, r.amount, r.bank, r.card_last4])).toEqual([['2026-07-13', 100000, 'American Express (AMEX)', '0276']]);
            expect(user.ccPayments.map(r => [r.date, r.amount])).toEqual([['2026-07-16', 300]]);
        });
        it('closes a month whose own balances prove nothing moved, with no phone involved', async () => {
            const s = await drain('AMEX', 'eStatement_0276_2026MAY.html', amexDoc({ cards: [{ cardNo: '376657*****0276', txs: [] }], opening: 470000 }));
            expect(s.last.status).toBe('filed');
            expect(s.data.get(s.sourcePath)).toMatchObject({ status: 'filed', filed: true, emptyStatement: true });
            expect(s.data.get('users/u').cconetime).toEqual([]);
        });
        it('keeps the evidence it closed a month on, and closes it only while the bank\'s own PDF agrees', async () => {
            const clean = textPdf(['Nations Trust Bank American Express', 'Statement Period: 11-Jul-2026 to 10-Aug-2026', 'Opening Balance 4,700.00 Closing Balance 4,700.00']);
            const ok = await drain('AMEX', 'eStatement_0276_2026MAY.html', amexDoc({ cards: [{ cardNo: '376657*****0276', txs: [] }], opening: 470000, pdf: clean }));
            expect(ok.data.get(ok.sourcePath)).toMatchObject({ status: 'filed', emptyStatement: true, emptyEvidence: { balances: 'agree', dataRows: 0, pdf: 'agrees' } });
            // the bank's PDF lists a purchase while its data says nothing moved: the bank contradicts itself, so the owner decides
            const contradicted = textPdf(['Nations Trust Bank American Express', 'Statement Period: 11-Jul-2026 to 10-Aug-2026', '13/07/2026 SHOP ONE 1,000.00 DR']);
            const bad = await drain('AMEX', 'eStatement_0276_2026MAY.html', amexDoc({ cards: [{ cardNo: '376657*****0276', txs: [] }], opening: 470000, pdf: contradicted }));
            expect(bad.data.get(bad.sourcePath).emptyStatement).not.toBe(true);
            expect(bad.data.get(bad.sourcePath).status).not.toBe('filed');
        });
        it('an owner who reopens a month closed as empty gets it in review, and it is never closed automatically again', async () => {
            const s = await drain('AMEX', 'eStatement_0276_2026MAY.html', amexDoc({ cards: [{ cardNo: '376657*****0276', txs: [] }], opening: 470000 }));
            expect(s.data.get(s.sourcePath).emptyStatement).toBe(true);
            const id = s.sourcePath.split('/').at(-1);
            await expect(reopenEmptyStatement({ db: s.db, owner, id })).resolves.toEqual({ ok: true, reopened: true });
            expect(s.data.get(s.sourcePath)).toMatchObject({ status: 'pending', filed: false, emptyStatement: false, emptyOverride: 'owner' });
            const loadAttachment = async () => ({ bytes: Buffer.from(amexDoc({ cards: [{ cardNo: '376657*****0276', txs: [] }], opening: 470000 })), filename: 'eStatement_0276_2026MAY.html', contentSha256: 'x' });
            const last = await runStatementSync({ action: 'drain', db: s.db, owner, env: {}, f: s.f, read: readStatement, open: s.open, settle: settleStatement, board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment, maxSteps: 1, preferredSourcePath: s.sourcePath });
            expect(last.status).toBe('needs_review');
            expect(s.data.get(s.sourcePath).emptyStatement).not.toBe(true);
            // …and only the owner's own statement can be reopened
            await expect(reopenEmptyStatement({ db: s.db, owner: { uid: 'someone-else', email: owner.email }, id })).rejects.toThrow();
            await expect(reopenEmptyStatement({ db: s.db, owner, id: '../x' })).rejects.toThrow();
        });
        it('files nothing from a statement whose own figures disagree — it goes to review instead', async () => {
            const html = ntbDoc({ accounts: [{ number: '200550088057', opening: 2405889, rows: savingsRows }] }).replace('transactionDebit: "5599"', 'transactionDebit: "5599.01"');
            const s = await drain('NTB', 'Consolidated_eStatement_2026JAN.html', html);
            expect(s.data.get('users/u').expenses).toEqual([]);
            expect(s.data.get(s.sourcePath).status).not.toBe('filed');
            // …and the review says WHY, in fixed codes, so a statement that will not file can be explained without seeing a figure.
            const review = [...s.data.entries()].find(([path, doc]) => path.includes('/statementReview/') && doc.sourcePath === s.sourcePath)?.[1];
            expect(review?.embeddedProblems).toEqual(expect.arrayContaining(['balance-chain-broken']));
            expect(JSON.stringify(review?.embeddedProblems)).not.toMatch(/\d{3,}/);
        });
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
