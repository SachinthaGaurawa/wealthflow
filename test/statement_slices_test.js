import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync, classifySlice, sliceRows, resumePartialStatements, resumeReview, closeSettledReviews, statementCensus, checkpointRows } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

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
        const board = vi.fn().mockResolvedValueOnce(answer(2, 'expenses', 'Shopping')).mockResolvedValueOnce({ ...answer(0), fields: { approved: true } });
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
        const board = vi.fn().mockResolvedValueOnce(answer(1, 'cconetime', 'Card Purchase')).mockResolvedValueOnce({ ...answer(0), fields: { approved: true } });
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
        w.board.mockImplementation(async prompt => (prompt.startsWith('Return only JSON. Independently') ? { ...ok(0), fields: { approved: true } }
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
        // the layout route refuses, as it must: a new layout could file the same rows twice
        const { submitRenderedStatement } = await import('../statement-sync.js');
        const html = (await import('node:zlib')).gzipSync(Buffer.from(statementHtml(70))).toString('base64');
        await expect(submitRenderedStatement({ db: w.db, owner, id: reviewId, htmlGz: html, readRendered: async () => ({ text: 'x', parsed: { rows: [{ date: '2026-09-01', amount: 1 }], verdict: 'parsed', understood: true } }) }))
            .rejects.toMatchObject({ message: 'layout-replay-would-overlap-settled-data', why: 'ledger-filed:30' });
    });

    it('the automatic pass puts it back; the replay checks the filed rows by fingerprint and files only the rest — once each', async () => {
        const w = await stopped();
        expect(await resumePartialStatements({ db: w.db, uid: 'u' })).toEqual({ resumed: 1, more: false });
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'pending', cursor: 0, totalRows: null, retryCount: 0, resumeVersion: 2 });
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
        owners.data.set('users/u/statementReview/' + reviewId, { ...owners.data.get('users/u/statementReview/' + reviewId), reason: 'statement-currency-differs' });
        owners.data.set(sourcePath, { ...owners.data.get(sourcePath), reviewReason: 'statement-currency-differs' });
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
        w.data.set(sourcePath, { ...w.data.get(sourcePath), resumeVersion: 2 });                // already tried with this version of the replay
        const enqueue = vi.fn(async () => ({ status: 'needs_review', review: 1, filed: 0, reason: 'statement-cursor-or-content-changed' }));
        expect(await resumeReview({ db: w.db, owner, id: reviewId, auto: true, enqueue })).toMatchObject({ ok: true, resumed: false, state: 'skipped' });
        expect(enqueue).not.toHaveBeenCalled();
        expect(await resumeReview({ db: w.db, owner, id: reviewId, enqueue })).toMatchObject({ resumed: true, replayStatus: 'needs_review', replayReason: 'statement-cursor-or-content-changed' });
    });
    it('an earlier version\'s attempt does not use up this one', async () => {
        const w = world({ rows: 70 });
        let calls = 0;
        await runStatementSync({ ...w.base, settle: async args => { calls += 1; if (calls === 2) throw new Error('statement-cursor-or-content-changed'); return settleStatement(args); }, maxSteps: 1, budgetMs: 40000 });
        w.data.set(sourcePath, { ...w.data.get(sourcePath), resumeVersion: 1 });
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
