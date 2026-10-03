import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync, classifySlice, sliceRows, resumePartialStatements, resumeReview, closeSettledReviews, statementCensus, statementCoverage, ledgerCensus, checkpointRows, recoverConsensusFailures, healOrphanedStatements } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement, sourceOccurrenceId } from '../statement-ledger.mjs';

/* NTB AND AMEX STATEMENTS TOOK MINUTES TO OPEN.
 * Ten rows per step, two sequential AI-board calls per step, and — for every ten rows — the vault, the mailbox, the attachment and the whole
 * document read again. A card statement is mostly rows the rules settle on strong evidence (the board's answer for those was thrown away
 * anyway), so now: the board is asked only about rows it can change, a slice is as long as one settlement can hold (30 rows), and the
 * statement is read once per invocation and settled slice after slice while there is room.
 * And a statement that stopped part-way (some rows filed) is resumed — not re-mapped — so the owner is not asked to "Map statement layout". */

afterEach(() => vi.restoreAllMocks());

const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
const reviewId = createHash('sha256').update(sourcePath).digest('hex');
const cardRow = (i, name = 'KEELLS STORE') => ({ date: '2026-09-14', narration: `${name} ${i}`, amount: 10 + i, direction: 'debit', directionSource: 'column', needsReview: false });
const creditCard = { statementType: 'credit_card', card_last4: '0276', subscriptions: [] };
const bankAccount = { statementType: 'bank_account', card_last4: '', subscriptions: [] };

describe('what the AI board is asked', () => {
    const answer = (n, module = 'expenses', category = 'Groceries') => ({ unanimous: true, trustworthy: true, expected: Array.from({ length: 10 }, (_, i) => 'e' + i), fields: { decisions: Array.from({ length: n }, (_, index) => ({ index, module, category, allocationId: '' })) } });
    // the peer review: one verdict per row
    const reviewed = (indexes, approved = true) => ({ unanimous: true, trustworthy: true, expected: Array.from({ length: 10 }, (_, i) => 'e' + i), fields: { reviews: indexes.map(index => ({ index, approved })) } });

    it('is not asked about a card statement the rules settle — no board call at all', async () => {
        const board = vi.fn();
        const rows = [...Array.from({ length: 12 }, (_, i) => cardRow(i)), { ...cardRow(99, 'PAYMENT THANK YOU'), direction: 'credit' }];
        const decisions = await classifySlice(rows, creditCard, { board });
        expect(board).not.toHaveBeenCalled();
        expect(decisions).toHaveLength(13);
        expect(decisions.every(d => d.verified === true && d.deterministic === true)).toBe(true);
    });

    it('is asked only about the rows the rules did not settle, indexed from zero, and the answers go back to the right rows', async () => {
        const rows = [cardRow(1, 'POS TRANSACTION KEELLS SUPER'), cardRow(2, 'ZZYX QWERTY HOLDINGS'), cardRow(3, 'CEFT CHARGES TRANSPORT'), cardRow(4, 'QQQ UNKNOWN TRADERS')];
        const board = vi.fn().mockResolvedValueOnce(answer(2, 'expenses', 'Shopping')).mockResolvedValueOnce(reviewed([0, 1]));
        const decisions = await classifySlice(rows, bankAccount, { board });
        expect(board).toHaveBeenCalledTimes(2);
        const sent = board.mock.calls[0][0];
        expect(sent).toContain('ZZYX QWERTY HOLDINGS'); expect(sent).toContain('QQQ UNKNOWN TRADERS');
        expect(sent).not.toContain('KEELLS'); expect(sent).not.toContain('CEFT CHARGES');
        expect(JSON.parse(sent.slice(sent.indexOf('Transactions: ') + 14)).map(e => e.index)).toEqual([0, 1]);
        expect(decisions[0]).toMatchObject({ category: 'Groceries', deterministic: true });
        expect(decisions[2]).toMatchObject({ category: 'Bank Charges', deterministic: true });
        expect(decisions[1]).toMatchObject({ module: 'expenses', category: 'Shopping', verified: true });
        expect(decisions[3]).toMatchObject({ module: 'expenses', category: 'Shopping', verified: true });
    });

    it('still asks about a row that looks like one of the owner\'s subscriptions, even when the rules settled it', async () => {
        const board = vi.fn().mockResolvedValueOnce(answer(1, 'cconetime', 'Card Purchase')).mockResolvedValueOnce(reviewed([0]));
        await classifySlice([cardRow(1, 'NETFLIX.COM 866-579')], { ...creditCard, subscriptions: [{ id: 's1', name: 'Netflix Premium', category: 'Entertainment' }] }, { board });
        expect(board).toHaveBeenCalledTimes(2);
        const quiet = vi.fn();
        await classifySlice([cardRow(1, 'KEELLS STORE')], { ...creditCard, subscriptions: [{ id: 's1', name: 'Netflix Premium', category: 'Entertainment' }] }, { board: quiet });
        expect(quiet).not.toHaveBeenCalled();
    });

    it('never asks about rows the ledger already holds (a statement being resumed)', async () => {
        const board = vi.fn();
        const rows = [cardRow(1, 'ZZYX ONE'), cardRow(2, 'ZZYX TWO')];
        await classifySlice(rows, bankAccount, { board, settled: new Set([0, 1]) });
        expect(board).not.toHaveBeenCalled();
    });

    it('a row the board cannot refine keeps the rules\' own answer, marked — and only a row the rules themselves doubt is still put to the owner', async () => {
        const weak = cardRow(1, 'ZZYX QWERTY HOLDINGS'), doubted = { ...cardRow(2, 'QQQ UNKNOWN TRADERS'), needsReview: true };
        // the peer review says "not every decision is supported": it used to send BOTH rows to the owner ("the AI could not reach agreement")
        const rejected = vi.fn().mockResolvedValueOnce(answer(2, 'expenses', 'Shopping')).mockResolvedValueOnce(reviewed([0, 1], false));
        const decisions = await classifySlice([weak, doubted], bankAccount, { board: rejected });
        expect(decisions[0]).toMatchObject({ module: 'expenses', category: 'Other', verified: true, autoDecided: 'rules' });
        expect(decisions[1]).toMatchObject({ verified: false, reason: 'ai-consensus-unavailable' });
        // and when the board answers "review" (it is not sure) about a row the rules can place
        const unsure = vi.fn().mockResolvedValueOnce(answer(1, 'review', 'Needs Review'));
        expect((await classifySlice([weak], bankAccount, { board: unsure }))[0]).toMatchObject({ module: 'expenses', category: 'Other', verified: true, autoDecided: 'rules' });
    });

    it('a dead board changes nothing for the rows the rules settled, and leaves the rest as the rules would have them', async () => {
        const board = vi.fn(async () => { throw new Error('ai-consensus-unavailable'); });
        const decisions = await classifySlice([cardRow(1, 'POS TRANSACTION KEELLS SUPER'), cardRow(2, 'ZZYX QWERTY HOLDINGS')], bankAccount, { board });
        expect(decisions[0]).toMatchObject({ category: 'Groceries', verified: true });
        expect(decisions[1]).toMatchObject({ module: 'expenses', verified: true });
    });
});

describe('how long a slice is', () => {
    it('is as long as one settlement can hold when the rules settle every row', () => {
        const all = Array.from({ length: 70 }, (_, i) => cardRow(i));
        expect(sliceRows(all, 0, creditCard).rows).toHaveLength(30);
        expect(sliceRows(all, 60, creditCard).rows).toHaveLength(10);
        expect(sliceRows(all, 0, creditCard).asked).toBe(0);
    });
    it('never holds more than ten rows that need the board', () => {
        const all = Array.from({ length: 40 }, (_, i) => cardRow(i, 'ZZYX TRADERS'));
        const slice = sliceRows(all, 0, bankAccount);
        expect(slice.rows).toHaveLength(10); expect(slice.asked).toBe(10);
    });
    it('rows the ledger already holds do not count against the ten', () => {
        const all = Array.from({ length: 40 }, (_, i) => cardRow(i, 'ZZYX TRADERS'));
        expect(sliceRows(all, 0, bankAccount, new Set(Array.from({ length: 25 }, (_, i) => i))).rows.length).toBeGreaterThan(10);
    });
});

/* ── the whole flow, on a real HTML card statement ─────────────────────────────────────────────────────────────── */
const statementHtml = (n, name = 'KEELLS STORE') => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 30/09/2026 Payment Due Date: 20/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${Array.from({ length: n }, (_, i) => `<tr><td>${String(1 + (i % 28)).padStart(2, '0')}/09/2026</td><td>${name} ${i}</td><td>${(100 + i).toFixed(2)} DR</td></tr>`).join('')}</table></body></html>`;

function world({ rows = 70, name, subscriptions = [] } = {}) {
    const html = statementHtml(rows, name);
    const fs = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@bank.example', kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions },
        [sourcePath]: { uid: 'u', bank: 'AMEX', filename: 'statement.html', from: 'statements@bank.example', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
    });
    const f = async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = vi.fn(async () => ({ bytes: Buffer.from(html), filename: 'statement.html', contentSha256: 'x' }));
    const read = vi.fn(readStatement);
    const board = vi.fn(async () => { throw new Error('ai-consensus-unavailable'); });
    const base = { action: 'drain', db: fs.db, owner, env: {}, f, intake: async () => ({ body: { ok: true } }), read, open: async () => [{ password: 'x', bank: 'AMEX' }], board, extract: async () => { throw new Error('ai-extractor-unavailable'); }, loadAttachment };
    return { ...fs, base, loadAttachment, read, board };
}
const logs = () => { const lines = []; vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); }); return () => lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); };

describe('reviews the owner already has, "the AI could not agree", are settled by the rules and flagged', () => {
    const row = { date: '2026-03-04', narration: 'CEFTS/6056/MR SOMEONE', amount: 500000, direction: 'credit', directionSource: 'balance', needsReview: false, valid: true };
    const setup = reason => {
        const id = sourceOccurrenceId(sourcePath, 3);
        return createFirestore({
            [sourcePath]: { uid: 'u', bank: 'NTB', statementType: 'bank_account', last4: '' },
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
            ['users/u/statementReview/' + id]: { uid: 'u', sourcePath, index: 3, status: 'pending', reason, row },
            ['users/u/statementLedger/' + id]: { uid: 'u', sourcePath, index: 3, status: 'review', fingerprint: 'x' },
        });
    };
    it.each(['ai-consensus-unavailable', 'unanimous-decision-required'])('%s: filed with the rules\' answer and says so', async reason => {
        const fs = setup(reason);
        expect((await recoverConsensusFailures({ db: fs.db, uid: 'u' })).recovered).toBe(1);
        const records = fs.data.get('users/u').incomeRecv;
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ amount: 500000, direction: 'credit', autoDecided: 'rules' });
        expect(records[0].notes).toMatch(/Filed automatically/);
        expect(fs.data.get('users/u/statementReview/' + sourceOccurrenceId(sourcePath, 3)).status).not.toBe('pending');
    });
    it('a row the parser itself doubts (a direction it had to assume) is still the owner\'s to decide', async () => {
        const fs = setup('unanimous-decision-required');
        const id = sourceOccurrenceId(sourcePath, 3);
        fs.data.set('users/u/statementReview/' + id, { ...fs.data.get('users/u/statementReview/' + id), row: { ...row, needsReview: true } });
        expect((await recoverConsensusFailures({ db: fs.db, uid: 'u' })).recovered).toBe(0);
        expect(fs.data.get('users/u').incomeRecv).toHaveLength(0);
    });
});

describe('the recovery steps run on an idle invocation too (the front pass is skipped whenever the mailbox scan is slow)', () => {
    it('an old "AI could not agree" row review and an old "please confirm this month" review are put right by a run that had nothing to process', async () => {
        const w = world({ rows: 12 });
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });          // the statement is filed: the queue is empty
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed' });
        const row = { date: '2026-03-04', narration: 'CEFTS/6056/MR SOMEONE', amount: 500000, direction: 'credit', directionSource: 'balance', needsReview: false, valid: true };
        const rowId = sourceOccurrenceId(sourcePath, 40);
        const other = `${mailPath}/items/item1`, otherId = createHash('sha256').update(other).digest('hex');
        w.data.set(sourcePath, { ...w.data.get(sourcePath), statementType: 'bank_account', last4: '' });
        w.data.set('users/u/statementReview/' + rowId, { uid: 'u', sourcePath, index: 40, status: 'pending', reason: 'unanimous-decision-required', row });
        w.data.set('users/u/statementLedger/' + rowId, { uid: 'u', sourcePath, index: 40, status: 'review', fingerprint: 'x' });
        w.data.set(other, { uid: 'u', bank: 'HNB', status: 'needs_review', reviewReason: 'statement-empty-needs-confirmation', cursor: 0, filed: false, hasReview: true });
        w.data.set('users/u/statementReview/' + otherId, { uid: 'u', sourcePath: other, index: -1, status: 'pending', reason: 'statement-empty-needs-confirmation' });
        const idle = await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(idle.attempted).toBe(0);
        expect(w.data.get('users/u').incomeRecv.find(record => record.amount === 500000)).toMatchObject({ direction: 'credit', autoDecided: 'rules' });
        expect(w.data.get('users/u/statementReview/' + rowId).status).not.toBe('pending');
        expect(w.data.get(other)).toMatchObject({ status: 'pending', wholeReplayVersion: 13 });             // read again, now witnessed by the board instead of asked
        expect(w.data.get('users/u/statementReview/' + otherId).status).toBe('retried');
    });
});

describe('the census says what the owner is asked, not only which statements are open', () => {
    it('counts the pending reviews per bank and reason, whole-statement and row-level apart (codes and counts only)', async () => {
        const fs = createFirestore({
            'users/u/statementReview/a': { uid: 'u', index: 3, status: 'pending', bank: 'NTB', reason: 'ai-consensus-unavailable', row: { amount: 1234.5, description: 'SOMEONE' } },
            'users/u/statementReview/b': { uid: 'u', index: 9, status: 'pending', bank: 'NTB', reason: 'ai-consensus-unavailable' },
            'users/u/statementReview/c': { uid: 'u', index: -1, status: 'pending', bank: 'DFCC', reason: 'statement-layout-or-reconciliation-needs-review' },
            'users/u/statementReview/d': { uid: 'u', index: 1, status: 'resolved', bank: 'NTB', reason: 'invalid-transaction' },
        });
        const lines = [];
        const docs = [{ id: 'i0', data: () => ({ bank: 'NTB', status: 'needs_review', hasReview: true, cursor: 66, totalRows: 66, reviewReason: 'statement-cursor-or-content-changed' }) }];
        const mailRef = { collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs }) }) }) }) };
        await statementCensus({ db: fs.db, mailRef, uid: 'u', log: line => lines.push(line) });
        const out = JSON.parse(lines[0]);
        expect(out.reviews).toEqual({ pending: 3, more: false, rows: { 'NTB:ai-consensus-unavailable': 2 }, whole: { 'DFCC:statement-layout-or-reconciliation-needs-review': 1 } });
        expect(lines[0]).not.toMatch(/1234|SOMEONE/);                                       // no amount, no merchant
        expect(out.reasons).toEqual({ 'NTB:needs_review:all-rows-settled-row-reviews-open': 1 });     // cursor 66 of 66 with a review open: settled, not stuck
    });
});

describe('a long card statement in one invocation', () => {
    it('is read ONCE and filed slice after slice in a single step — no AI board, no second reading of the document', async () => {
        const w = world({ rows: 70 });
        const events = logs();
        const result = await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(result.attempted).toBe(1);
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, cursor: 70, totalRows: 70 });
        expect(w.data.get('users/u').cconetime).toHaveLength(70);
        expect(w.loadAttachment).toHaveBeenCalledTimes(1);
        expect(w.read).toHaveBeenCalledTimes(1);
        expect(w.board).not.toHaveBeenCalled();
        expect(events().find(e => e.evt === 'statement-sync-item')).toMatchObject({ bank: 'AMEX', status: 'filed', rows: 70, slices: 3 });
    });

    it('a slice that needs the board is not started without room for its two calls — the statement waits for the next invocation, with its place kept', async () => {
        const w = world({ rows: 14, name: 'NETFLIX.COM', subscriptions: [{ id: 's1', name: 'Netflix', category: 'Entertainment' }] });
        const ok = n => ({ unanimous: true, trustworthy: true, expected: Array.from({ length: 10 }, (_, i) => 'e' + i), fields: { decisions: Array.from({ length: n }, (_, index) => ({ index, module: 'cconetime', category: 'Card Purchase', allocationId: '' })) } });
        w.board.mockReset();
        // answers exactly the rows it is sent
        w.board.mockImplementation(async prompt => (prompt.startsWith('Return only JSON. Independently') ? { ...ok(0), fields: { reviews: JSON.parse(prompt.slice(prompt.indexOf('Evidence: ') + 10)).decisions.map(d => ({ index: d.index, approved: true })) } }
            : ok(JSON.parse(prompt.slice(prompt.indexOf('Transactions: ') + 14)).length)));
        const result = await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000, startedAt: Date.now() - 20000 });
        expect(result.attempted).toBe(1);
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'pending', cursor: 10, filed: false });     // ten rows settled; the next ten need the board and there was no room for it
        expect(w.board).toHaveBeenCalledTimes(2);
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, cursor: 14 });
    });

    it('a settled slice is progress: failures are counted IN A ROW, not over the statement\'s whole life', async () => {
        const w = world({ rows: 70 });
        w.data.set(sourcePath, { ...w.data.get(sourcePath), retryCount: 4, retryAt: 1, lastRetryReason: 'provider hiccup' });
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', retryCount: 0, retryAt: 0 });
    });
});

describe('a statement that stopped part-way is resumed, not re-mapped', () => {
    async function stopped(reason = 'statement-cursor-or-content-changed') {
        const w = world({ rows: 70 });
        let calls = 0;
        const settle = async args => { calls += 1; if (calls === 2) throw new Error(reason); return settleStatement(args); };
        await runStatementSync({ ...w.base, settle, maxSteps: 1, budgetMs: 40000 });
        return w;
    }

    it('the failure leaves rows filed and a whole-statement review (the dead end the owner met)', async () => {
        const w = await stopped();
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'needs_review', reviewReason: 'statement-cursor-or-content-changed', cursor: 30 });
        expect(w.data.get('users/u/statementReview/' + reviewId)).toMatchObject({ status: 'pending', index: -1 });
        expect(w.data.get('users/u').cconetime).toHaveLength(30);
        // a layout the owner TAUGHT is refused over filed rows, as it must be: a new layout could file the same rows twice (mapReviewLayout keeps that rule)
        const { submitRenderedStatement } = await import('../statement-sync.js');
        const html = (await import('node:zlib')).gzipSync(Buffer.from(statementHtml(70))).toString('base64');
        // …but the device's rendering of the SAME document is replayed over them (idempotent: each filed row is checked, never filed twice), not refused
        const enqueue = vi.fn(async () => { await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000, preferredSourcePath: sourcePath }); return { status: 'filed', filed: 40, review: 0 }; });
        const result = await submitRenderedStatement({ db: w.db, owner, id: reviewId, htmlGz: html, enqueue,
            readRendered: async page => readStatement({ bytes: Buffer.from(page), filename: 'statement.html', passwords: [], bank: 'AMEX', layouts: [] }) });
        expect(result).toMatchObject({ ok: true, mapped: true, replayStatus: 'filed' });
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, cursor: 70 });
        const records = w.data.get('users/u').cconetime;
        expect(records).toHaveLength(70);
        expect(new Set(records.map(r => r.statementRow)).size).toBe(70);
    });

    it('a statement that is already filed, or being worked on, still refuses the device\'s rendering', async () => {
        const w = await stopped();
        const { submitRenderedStatement } = await import('../statement-sync.js');
        const html = (await import('node:zlib')).gzipSync(Buffer.from(statementHtml(70))).toString('base64');
        w.data.set(sourcePath, { ...w.data.get(sourcePath), leaseUntil: Date.now() + 60000 });
        await expect(submitRenderedStatement({ db: w.db, owner, id: reviewId, htmlGz: html, enqueue: vi.fn(), readRendered: async () => ({ text: 'x', parsed: { rows: [{ date: '2026-09-01', amount: 1 }], verdict: 'parsed', understood: true } }) }))
            .rejects.toMatchObject({ message: 'layout-replay-would-overlap-settled-data', why: expect.stringContaining('source-leased') });
    });

    it('the automatic pass puts it back; the replay checks the filed rows by fingerprint and files only the rest — once each', async () => {
        const w = await stopped();
        expect(await resumePartialStatements({ db: w.db, uid: 'u' })).toEqual({ resumed: 1, more: false });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'pending', cursor: 0, totalRows: null, retryCount: 0, resumeVersion: 3 });
        expect(w.data.get('users/u/statementReview/' + reviewId).status).toBe('retried');
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, cursor: 70 });
        const records = w.data.get('users/u').cconetime;
        expect(records).toHaveLength(70);
        expect(new Set(records.map(r => r.statementRow)).size).toBe(70);          // no row twice
        expect(w.board).not.toHaveBeenCalled();                                    // the 30 already filed were not asked about again
        // once per version: a statement that stops again is not looped
        expect(await resumePartialStatements({ db: w.db, uid: 'u' })).toEqual({ resumed: 0, more: false });
    });

    it('retries-exhausted statements are resumed too', async () => {
        const w = await stopped('statement-retries-exhausted');
        // 'statement-retries-exhausted' is thrown as an ordinary (retryable) failure here, so make the review say what quarantine writes
        w.data.set(sourcePath, { ...w.data.get(sourcePath), status: 'needs_review', reviewReason: 'statement-retries-exhausted', cursor: 30, hasReview: true, leaseUntil: 0 });
        w.data.set('users/u/statementReview/' + reviewId, { ...(w.data.get('users/u/statementReview/' + reviewId) || { uid: 'u', sourcePath, index: -1 }), status: 'pending', reason: 'statement-retries-exhausted' });
        expect((await resumePartialStatements({ db: w.db, uid: 'u' })).resumed).toBe(1);
    });

    it('does not touch a statement another worker holds, a filed one, or a reason only the owner can answer', async () => {
        const leased = await stopped();
        leased.data.set(sourcePath, { ...leased.data.get(sourcePath), leaseUntil: Date.now() + 60000 });
        expect((await resumePartialStatements({ db: leased.db, uid: 'u' })).resumed).toBe(0);
        const owners = await stopped();
        owners.data.set('users/u/statementReview/' + reviewId, { ...owners.data.get('users/u/statementReview/' + reviewId), reason: 'statement-sender-no-longer-approved' });
        owners.data.set(sourcePath, { ...owners.data.get(sourcePath), reviewReason: 'statement-sender-no-longer-approved' });
        expect((await resumePartialStatements({ db: owners.db, uid: 'u' })).resumed).toBe(0);
    });

    it('keeps a row-level review of the same statement alive (hasReview stays true)', async () => {
        const w = await stopped();
        w.data.set('users/u/statementReview/row5', { uid: 'u', sourcePath, index: 5, status: 'pending', reason: 'invalid-transaction' });
        await resumePartialStatements({ db: w.db, uid: 'u' });
        expect(w.data.get(sourcePath).hasReview).toBe(true);
    });
});

describe('a replay does not stop on rows the ledger holds worded differently (the AMEX/NTB statements that never finished)', () => {
    async function partFiled() {
        const w = world({ rows: 70 });
        let calls = 0;
        await runStatementSync({ ...w.base, settle: async args => { calls += 1; if (calls === 2) throw new Error('statement-cursor-or-content-changed'); return settleStatement(args); }, maxSteps: 1, budgetMs: 40000 });
        return w;
    }
    const ledgerKeys = w => [...w.data.keys()].filter(key => key.startsWith('users/u/statementLedger/'));

    it('the same dates, amounts and directions are the same transactions: the filed rows are counted as duplicates and the rest is filed — once each', async () => {
        const w = await partFiled();
        expect(ledgerKeys(w)).toHaveLength(30);
        for (const key of ledgerKeys(w)) w.data.set(key, { ...w.data.get(key), fingerprint: 'worded-by-an-earlier-reader' });     // an earlier reading worded every filed row differently
        expect((await resumePartialStatements({ db: w.db, uid: 'u' })).resumed).toBe(1);
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, cursor: 70 });
        const records = w.data.get('users/u').cconetime;
        expect(records).toHaveLength(70);
        expect(new Set(records.map(r => r.statementRow)).size).toBe(70);
    });

    it('different money at the same place is a statement that really changed: still refused, and the log says where and what differed', async () => {
        const w = await partFiled();
        for (const key of ledgerKeys(w)) w.data.set(key, { ...w.data.get(key), fingerprint: 'worded-by-an-earlier-reader' });
        const user = structuredClone(w.data.get('users/u'));
        user.cconetime.find(record => record.statementRow === 4).amount += 1;
        w.data.set('users/u', user);
        await resumePartialStatements({ db: w.db, uid: 'u' });
        const events = logs();
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'needs_review', reviewReason: 'statement-cursor-or-content-changed' });
        expect(w.data.get('users/u').cconetime).toHaveLength(30);                  // nothing was filed on top of a statement that moved
        expect(events().find(e => e.evt === 'statement-sync-item' && e.status === 'needs_review')).toMatchObject({ reason: 'statement-cursor-or-content-changed', detail: { index: 4, ledger: 'filed', differs: 'amount' } });
    });

    it('AMEX: a row the ledger calls filed that the books no longer hold is filed again by the replay — the whole statement is no longer refused over it', async () => {
        const w = await partFiled();
        const lostIds = new Set(w.data.get('users/u').cconetime.filter(record => record.statementRow < 20).map(record => record.id));
        const user = structuredClone(w.data.get('users/u'));
        user.cconetime = user.cconetime.filter(record => !lostIds.has(record.id));                      // a device pushed its own copy of the list over them
        w.data.set('users/u', user);
        const some = ledgerKeys(w).find(key => w.data.get(key).index === 12);
        w.data.set(some, { ...w.data.get(some), fingerprint: 'worded-by-an-earlier-reader' });          // and one of them was worded differently too
        expect(w.data.get('users/u').cconetime).toHaveLength(10);
        await resumePartialStatements({ db: w.db, uid: 'u' });
        const events = logs();
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, cursor: 70 });
        const records = w.data.get('users/u').cconetime;
        expect(records).toHaveLength(70);
        expect(new Set(records.map(r => r.statementRow)).size).toBe(70);                                // every row once, the lost ones included
        expect(events().find(e => e.evt === 'statement-sync-item' && e.status === 'filed')).toMatchObject({ rows: 70, healed: 20 });
    });

    it('a row the owner DELETED (a tombstone) is never brought back, and does not stop the statement either', async () => {
        const w = await partFiled();
        const doomed = w.data.get('users/u').cconetime.find(record => record.statementRow === 12);
        const user = structuredClone(w.data.get('users/u'));
        user.cconetime = user.cconetime.filter(record => record.id !== doomed.id);
        user._tomb = { cconetime: { [doomed.id]: Date.now() } };
        w.data.set('users/u', user);
        const key = ledgerKeys(w).find(entry => w.data.get(entry).index === 12);
        w.data.set(key, { ...w.data.get(key), fingerprint: 'worded-by-an-earlier-reader' });
        await resumePartialStatements({ db: w.db, uid: 'u' });
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, cursor: 70 });
        const records = w.data.get('users/u').cconetime;
        expect(records).toHaveLength(69);
        expect(records.some(record => record.statementRow === 12)).toBe(false);
    });

    it('NTB: the same amount and direction at the same place on another date is the same row — not a changed statement, and the owner\'s record is not rewritten', async () => {
        const w = await partFiled();
        const record = w.data.get('users/u').cconetime.find(r => r.statementRow === 7);
        const user = structuredClone(w.data.get('users/u'));
        const kept = user.cconetime.find(r => r.id === record.id);
        kept.date = '2026-09-02'; kept.month = '2026-09';
        w.data.set('users/u', user);
        const key = ledgerKeys(w).find(entry => w.data.get(entry).index === 7);
        w.data.set(key, { ...w.data.get(key), fingerprint: 'an-earlier-date' });
        await resumePartialStatements({ db: w.db, uid: 'u' });
        const events = logs();
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, cursor: 70 });
        expect(w.data.get('users/u').cconetime).toHaveLength(70);
        expect(w.data.get('users/u').cconetime.find(r => r.id === record.id).date).toBe('2026-09-02');
        expect(events().find(e => e.evt === 'statement-sync-item' && e.status === 'filed')).toMatchObject({ dateShifted: 1 });
    });

    it('a ledger row that was skipped, or sent to review, is compared by what it held', async () => {
        const w = await partFiled();
        const [key] = ledgerKeys(w);
        // the row at that place was once a line that moves no money; the new reading finds a real transaction there
        w.data.set(key, { ...w.data.get(key), status: 'skipped', reason: 'zero-amount', fingerprint: 'old' });
        await resumePartialStatements({ db: w.db, uid: 'u' });
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'needs_review', reviewReason: 'statement-cursor-or-content-changed' });
    });

    it('a statement checkpointed by a reading that only worded rows differently continues; one whose money moved does not', async () => {
        const rows = [{ date: '2026-09-01', amount: 100, direction: 'debit', narration: 'KEELLS 1' }, { date: '2026-09-02', amount: 200, direction: 'debit', narration: 'KEELLS 2' }];
        const moneyHash = createHash('sha256').update(JSON.stringify(rows.map(row => [row.date, row.amount, row.direction]))).digest('hex');
        const fs = createFirestore({ [sourcePath]: { uid: 'u', leaseToken: 't', rowSetHash: 'an-older-wording', moneyHash, totalRows: 2, cursor: 1 } });
        await expect(checkpointRows(fs.db, fs.db.doc(sourcePath), 'u', 't', rows)).resolves.toMatch(/^[a-f0-9]{64}$/);
        expect(fs.data.get(sourcePath).rowSetHash).not.toBe('an-older-wording');
        const moved = createFirestore({ [sourcePath]: { uid: 'u', leaseToken: 't', rowSetHash: 'an-older-wording', moneyHash, totalRows: 2, cursor: 1 } });
        await expect(checkpointRows(moved.db, moved.db.doc(sourcePath), 'u', 't', [rows[0], { ...rows[1], amount: 201 }])).rejects.toMatchObject({ message: 'statement-cursor-or-content-changed', detail: { rows: 2, saved: 2, cursor: 1, money: false } });
        // a statement checkpointed before the money hash existed is held to the strict rule it always had
        const old = createFirestore({ [sourcePath]: { uid: 'u', leaseToken: 't', rowSetHash: 'an-older-wording', totalRows: 2, cursor: 1 } });
        await expect(checkpointRows(old.db, old.db.doc(sourcePath), 'u', 't', rows)).rejects.toThrow('statement-cursor-or-content-changed');
    });
});

describe('the app\'s silent resume goes once per version; the owner\'s own tap always works', () => {
    it('refuses a second automatic attempt, never the owner\'s', async () => {
        const w = world({ rows: 70 });
        let calls = 0;
        await runStatementSync({ ...w.base, settle: async args => { calls += 1; if (calls === 2) throw new Error('statement-cursor-or-content-changed'); return settleStatement(args); }, maxSteps: 1, budgetMs: 40000 });
        w.data.set(sourcePath, { ...w.data.get(sourcePath), resumeVersion: 3 });                // already tried with this version of the replay
        const enqueue = vi.fn(async () => ({ status: 'needs_review', review: 1, filed: 0, reason: 'statement-cursor-or-content-changed' }));
        expect(await resumeReview({ db: w.db, owner, id: reviewId, auto: true, enqueue })).toMatchObject({ ok: true, resumed: false, state: 'skipped' });
        expect(enqueue).not.toHaveBeenCalled();
        expect(await resumeReview({ db: w.db, owner, id: reviewId, enqueue })).toMatchObject({ resumed: true, replayStatus: 'needs_review', replayReason: 'statement-cursor-or-content-changed' });
    });
    it('an earlier version\'s attempt does not use up this one', async () => {
        const w = world({ rows: 70 });
        let calls = 0;
        await runStatementSync({ ...w.base, settle: async args => { calls += 1; if (calls === 2) throw new Error('statement-cursor-or-content-changed'); return settleStatement(args); }, maxSteps: 1, budgetMs: 40000 });
        w.data.set(sourcePath, { ...w.data.get(sourcePath), resumeVersion: 2 });
        expect(await resumeReview({ db: w.db, owner, id: reviewId, auto: true, enqueue: vi.fn(async () => ({ status: 'pending' })) })).toMatchObject({ resumed: true });
    });
});

describe('the owner\'s "Map statement layout" on such a statement', () => {
    it('resumes it and works it at once, instead of answering "this may already be read"', async () => {
        const w = world({ rows: 70 });
        let calls = 0;
        await runStatementSync({ ...w.base, settle: async args => { calls += 1; if (calls === 2) throw new Error('statement-cursor-or-content-changed'); return settleStatement(args); }, maxSteps: 1, budgetMs: 40000 });
        const enqueue = vi.fn(async () => { await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000, preferredSourcePath: sourcePath }); return { status: 'filed', filed: 40, review: 0 }; });
        const result = await resumeReview({ db: w.db, owner, id: reviewId, enqueue });
        expect(result).toMatchObject({ ok: true, resumed: true, state: 'resumed', settled: 30, filed: 40, replayStatus: 'filed' });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', cursor: 70 });
        expect(w.data.get('users/u').cconetime).toHaveLength(70);
    });

    it('says so when the review was already handled, and closes it when the statement is already filed', async () => {
        const w = world({ rows: 3 });
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        const enqueue = vi.fn();
        w.data.set('users/u/statementReview/' + reviewId, { uid: 'u', sourcePath, index: -1, status: 'retried', reason: 'x' });
        expect(await resumeReview({ db: w.db, owner, id: reviewId, enqueue })).toMatchObject({ ok: true, resumed: false, state: 'handled', status: 'retried' });
        w.data.set('users/u/statementReview/' + reviewId, { uid: 'u', sourcePath, index: -1, status: 'pending', reason: 'statement-cursor-or-content-changed' });
        expect(await resumeReview({ db: w.db, owner, id: reviewId, enqueue })).toMatchObject({ ok: true, resumed: false, state: 'filed' });
        expect(w.data.get('users/u/statementReview/' + reviewId)).toMatchObject({ status: 'resolved', replayStatus: 'filed' });
        expect(enqueue).not.toHaveBeenCalled();
    });

    it('is busy while another worker holds the statement, and refuses a review that is not the owner\'s', async () => {
        const w = world({ rows: 3 });
        w.data.set(sourcePath, { ...w.data.get(sourcePath), status: 'needs_review', leaseUntil: Date.now() + 60000 });
        w.data.set('users/u/statementReview/' + reviewId, { uid: 'u', sourcePath, index: -1, status: 'pending', reason: 'x' });
        expect(await resumeReview({ db: w.db, owner, id: reviewId, enqueue: vi.fn() })).toMatchObject({ resumed: false, state: 'busy' });
        w.data.set('users/u/statementReview/' + reviewId, { uid: 'u', sourcePath: 'wf-mail/someone_else/items/item0', index: -1, status: 'pending', reason: 'x' });
        await expect(resumeReview({ db: w.db, owner, id: reviewId, enqueue: vi.fn() })).rejects.toThrow('review-source-owner-mismatch');
        await expect(resumeReview({ db: w.db, owner, id: 'nope', enqueue: vi.fn() })).rejects.toThrow('invalid-review-request');
    });
});

describe('stale reviews and the census', () => {
    it('a review whose statement has since been filed is closed, not left as a question', async () => {
        const w = world({ rows: 3 });
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        w.data.set('users/u/statementReview/' + reviewId, { uid: 'u', sourcePath, index: -1, status: 'pending', reason: 'statement-cursor-or-content-changed' });
        expect(await closeSettledReviews({ db: w.db, uid: 'u' })).toEqual({ closed: 1 });
        expect(w.data.get('users/u/statementReview/' + reviewId)).toMatchObject({ status: 'resolved', closedBy: 'settled-source' });
    });

    it('the census names banks, statuses and reason codes — and nothing about the owner', async () => {
        const lines = [];
        const docs = [
            { bank: 'NTB', status: 'needs_review', reviewReason: 'statement-cursor-or-content-changed', cursor: 30, totalRows: 70, filename: 'secret-name.pdf', subject: 'private subject' },
            { bank: 'AMEX', status: 'pending', retryCount: 2, lastRetryReason: 'statement-worker-retry-required', from: 'a@b.c' },
            { bank: 'HNB', status: 'dead_letter', deadLetter: { reason: 'provider 12345678 failed' }, cursor: 0 },
        ].map((data, i) => ({ id: 'i' + i, data: () => data }));
        const mailRef = { collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs }) }) }) }) };
        await statementCensus({ db: {}, mailRef, log: line => lines.push(line) });
        const out = JSON.parse(lines[0]);
        expect(out).toMatchObject({ evt: 'statement-census', items: 3, byBank: { NTB: { needs_review: 1 }, AMEX: { pending: 1 }, HNB: { dead_letter: 1 } } });
        expect(out.reasons['NTB:needs_review:statement-cursor-or-content-changed']).toBe(1);
        expect(out.reasons['HNB:dead_letter:provider #  failed'.replace('#  ', '# ')] ?? out.reasons['HNB:dead_letter:provider # failed']).toBe(1);
        expect(out.partial).toEqual([{ bank: 'NTB', status: 'needs_review', cursor: 30, rows: 70, why: 'statement-cursor-or-content-changed', retry: 0, resumed: 0 }]);
        expect(lines[0]).not.toMatch(/secret-name|private subject|a@b\.c/);
    });
});

describe('the coverage line says what the app really holds per bank', () => {
    const at = iso => Date.parse(iso + 'T10:00:00Z');
    const mailOf = rows => ({ collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: rows.map((data, i) => ({ id: 'f' + i, data: () => data })) }) }) }) }) });
    it('per bank: filed, empty, rows, oldest and newest month, the count per year — and nothing about the owner', async () => {
        const lines = [];
        await statementCoverage({ mailRef: mailOf([
            { status: 'filed', bank: 'HNB', receivedMs: at('2023-04-09'), totalRows: 31, filename: 'secret-name.pdf', subject: 'private subject' },
            { status: 'filed', bank: 'HNB', receivedMs: at('2026-09-02'), totalRows: 0, emptyStatement: true },
            { status: 'filed', bank: 'HNB', receivedMs: at('2026-08-02'), totalRows: 12 },
            { status: 'filed', bank: 'NTB', totalRows: 5 },
            { status: 'needs_review', bank: 'NTB', receivedMs: at('2020-01-01'), totalRows: 9 },
        ]), log: line => lines.push(line) });
        const out = JSON.parse(lines[0]);
        expect(out).toMatchObject({ evt: 'statement-coverage', filed: 4, more: false });
        expect(out.banks.HNB).toEqual({ filed: 3, empty: 1, rows: 43, undated: 0, years: { 2023: 1, 2026: 2 }, months: { '2023-04': 1, '2026-08': 1, '2026-09': 1 }, oldest: '2023-04', newest: '2026-09' });
        expect(out.banks.NTB).toEqual({ filed: 1, empty: 0, rows: 5, undated: 1, years: {}, months: {} });
        expect(lines[0]).not.toMatch(/secret-name|private subject/);
    });
    it('the census writes it right after its own line, and a failing coverage read never breaks the census', async () => {
        const lines = [];
        const docs = [{ id: 'i0', data: () => ({ bank: 'DFCC', status: 'filed', receivedMs: at('2025-03-03'), totalRows: 4 }) }];
        await statementCensus({ db: {}, mailRef: { collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs }) }) }) }) }, log: line => lines.push(line) });
        expect(lines.map(line => JSON.parse(line).evt)).toEqual(['statement-census', 'statement-coverage']);
        let calls = 0;
        const broken = { collection: () => ({ where: () => ({ limit: () => ({ get: async () => { if (++calls > 1) throw new Error('boom'); return { docs: [] }; } }) }) }) };
        const quiet = [];
        await expect(statementCensus({ db: {}, mailRef: broken, log: line => quiet.push(line) })).resolves.toBeUndefined();
        expect(quiet.map(line => JSON.parse(line).evt)).toEqual(['statement-census']);
    });
});

describe('the ledger census says where every statement row went', () => {
    it('per bank: filed, skipped (and why), already there, waiting — with no amount, merchant or account anywhere', async () => {
        const fs = createFirestore({
            [`${mailPath}/items/a`]: { uid: 'u', bank: 'HNB', status: 'filed' },
            [`${mailPath}/items/b`]: { uid: 'u', bank: 'NTB', status: 'filed' },
            'users/u/statementLedger/r1': { uid: 'u', sourcePath: `${mailPath}/items/a`, index: 0, status: 'filed', module: 'expenses', fingerprint: 'SECRET-FP', amount: 1234.5 },
            'users/u/statementLedger/r2': { uid: 'u', sourcePath: `${mailPath}/items/a`, index: 1, status: 'skipped', reason: 'zero-amount' },
            'users/u/statementLedger/r3': { uid: 'u', sourcePath: `${mailPath}/items/b`, index: 0, status: 'duplicate', matchedId: 'x' },
            'users/u/statementLedger/r4': { uid: 'u', sourcePath: `${mailPath}/items/b`, index: 1, status: 'review', reason: 'ai-consensus-unavailable' },
            'users/u/statementLedger/r5': { uid: 'u', sourcePath: `${mailPath}/items/b`, index: 2, status: 'skipped', module: 'skip' },
            'users/u/statementLedger/r6': { uid: 'u', sourcePath: `${mailPath}/items/gone`, index: 0, status: 'filed', module: 'cconetime' },
        });
        const lines = [];
        await ledgerCensus({ db: fs.db, mailRef: fs.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', log: line => lines.push(line) });
        const out = JSON.parse(lines[0]);
        expect(out).toMatchObject({ evt: 'statement-ledger-census', rows: 6, more: false });
        expect(out.banks).toEqual({ HNB: { filed: 1, skipped: 1 }, NTB: { duplicate: 1, review: 1, skipped: 1 }, '?': { filed: 1 } });
        expect(out.skipped).toEqual({ 'HNB:zero-amount': 1, 'NTB:decided-skip': 1 });
        expect(out.byModule).toEqual({ expenses: 1, cconetime: 1 });
        expect(lines[0]).not.toMatch(/SECRET-FP|1234/);
    });
});

describe('a statement stopped for a question nobody is asking', () => {
    // production 2026-10-01: NTB 45/45 and 151/151 rows settled, DFCC read once — all `needs_review`, no review pending at all
    const put = (w, id, data) => w.data.set(`${mailPath}/items/${id}`, { uid: 'u', bank: 'NTB', status: 'needs_review', filed: false, hasReview: true, ...data });
    const mailRef = w => w.db.collection('wf-mail').doc('owner_example_com');
    it('every row settled and nothing pending: the statement IS filed; rows left and nothing pending: it goes back in the queue (three times at most)', async () => {
        const w = world({ rows: 3 });
        put(w, 'a45', { cursor: 45, totalRows: 45 });
        put(w, 'a151', { cursor: 151, totalRows: 151 });
        put(w, 'dfcc', { bank: 'Dfccbank', cursor: 0, totalRows: null, reviewReason: 'statement-layout-or-reconciliation-needs-review' });
        const lines = [];
        const out = await healOrphanedStatements({ db: w.db, mailRef: mailRef(w), uid: 'u', log: line => lines.push(line) });
        expect(out).toMatchObject({ filed: 2, requeued: 1 });
        for (const id of ['a45', 'a151']) expect(w.data.get(`${mailPath}/items/${id}`)).toMatchObject({ status: 'filed', filed: true, hasReview: false });
        expect(w.data.get(`${mailPath}/items/dfcc`)).toMatchObject({ status: 'pending', hasReview: false, orphanHeals: 1, retryCount: 0 });
        expect(JSON.parse(lines[0])).toMatchObject({ evt: 'statement-heal', filed: 2, requeued: 1, banks: { NTB: { filed: 2 }, Dfccbank: { requeued: 1 } } });
        expect(lines[0]).not.toMatch(/\d{4,}/);                                    // counts and bank names only
        // stopped again, three times: left alone (the worker raises a proper review when it is truly unreadable)
        w.data.set(`${mailPath}/items/dfcc`, { ...w.data.get(`${mailPath}/items/dfcc`), status: 'needs_review', hasReview: true, orphanHeals: 3 });
        expect(await healOrphanedStatements({ db: w.db, mailRef: mailRef(w), uid: 'u', log: () => {} })).toMatchObject({ filed: 0, requeued: 0 });
    });
    it('a statement with a question open, one being worked on, and another owner\'s are never touched', async () => {
        const w = world({ rows: 3 });
        put(w, 'asked', { cursor: 45, totalRows: 45 });
        w.data.set('users/u/statementReview/' + createHash('sha256').update(`${mailPath}/items/asked`).digest('hex'), { uid: 'u', sourcePath: `${mailPath}/items/asked`, index: 3, status: 'pending', reason: 'invalid-transaction' });
        put(w, 'busy', { cursor: 45, totalRows: 45, leaseUntil: Date.now() + 60000 });
        put(w, 'theirs', { uid: 'someone-else', cursor: 45, totalRows: 45 });
        expect(await healOrphanedStatements({ db: w.db, mailRef: mailRef(w), uid: 'u', log: () => {} })).toMatchObject({ filed: 0, requeued: 0 });
        for (const id of ['asked', 'busy', 'theirs']) expect(w.data.get(`${mailPath}/items/${id}`).status).toBe('needs_review');
    });
    it('an idle invocation puts them right with no tap, and the run says how many', async () => {
        const w = world({ rows: 3 });
        await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        put(w, 'a45', { cursor: 45, totalRows: 45 });
        const idle = await runStatementSync({ ...w.base, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(idle.attempted).toBe(0);
        expect(idle.orphansHealed).toBeGreaterThanOrEqual(1);
        expect(w.data.get(`${mailPath}/items/a45`)).toMatchObject({ status: 'filed', filed: true });
    });
});
