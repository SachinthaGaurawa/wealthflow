import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { figuresIn, repairByArithmetic } from '../statement-repair.mjs';
import { runStatementSync, recoverWholeStatementFailures } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';

// DFCC, "DFCC Bank Statement - Aug 26.pdf", production 2026-10-02: "These rows do not add up to the closing balance on the statement — a difference of -80,735.16. A row may be missing.
// 119 transactions found." 80,735.16 is 50,000.00 + 30,735.16: the row "Outward Ceft Transfer 376657XXXXX0276 50,000.00" was read as 30,735.16 money IN. One row, read the wrong way, moves
// the total by exactly what it should have been minus what it was — and when only ONE correction of ONE row makes the printed balances add up, it is the only reading they allow.

afterEach(() => vi.restoreAllMocks());
const row = (extra = {}) => ({ date: '2026-08-04', narration: 'POS Transaction KEELLS', amount: 4000, direction: 'debit', directionSource: 'balance', needsReview: false, valid: true, balance: null, ...extra });
const broken = (extra = {}) => row({ date: '2026-08-14', narration: 'Outward Ceft Transfer 376657XXXXX0276 50,000.00', amount: 30735.16, direction: 'credit', directionSource: 'keyword', needsReview: true, ...extra });
const statement = (rows, rec = {}, extra = {}) => ({
    rows, verdict: 'unverified', understood: false, reason: 'The rows were read, but the opening and closing balances do not add up.', invalidDates: 0, balanceMismatches: 0, layout: { statementType: 'bank_account' },
    reconciliation: { opening: 200000, closing: 145975, credits: 30735.16, debits: 4025, expected: 226710.16, difference: -80735.16, ok: false, ...rec }, ...extra,
});
const dfcc = () => statement([row(), broken(), row({ date: '2026-08-15', narration: 'Ceft Charges 376657XXXXX0276', amount: 25 })]);

describe('the figures a row carries', () => {
    it('finds money in a description and nothing in an account number', () => {
        expect(figuresIn('Outward Ceft Transfer 376657XXXXX0276 50,000.00').map(f => f.value)).toEqual([50000]);
        expect(figuresIn('POS FUEL 20.00 LTR 4,100.50 REF 12345').map(f => f.value)).toEqual([20, 4100.5]);
        expect(figuresIn('Atm Withdrawal Fee Ac-Lkr1573100010800')).toEqual([]);
    });
});

describe('one row, read the wrong way, is found by the statement\'s own arithmetic', () => {
    it('the DFCC row: a debit of 50,000.00 read as 30,735.16 in — the only correction that reaches the closing balance', () => {
        const { parsed, repaired } = repairByArithmetic(dfcc());
        expect(repaired).toMatchObject({ index: 1, from: { amount: 30735.16, direction: 'credit' }, to: { amount: 50000, direction: 'debit' } });
        expect(parsed.rows[1]).toMatchObject({ amount: 50000, direction: 'debit', directionSource: 'statement', needsReview: false, repaired: 'arithmetic', narration: 'Outward Ceft Transfer 376657XXXXX0276' });
        expect(parsed.reconciliation).toMatchObject({ ok: true, difference: 0, expected: 145975, repairedRow: 1 });
        expect(parsed).toMatchObject({ verdict: 'parsed', understood: true });
    });
    it('the figure can be the change in the running balance instead of one in the description', () => {
        const input = statement([row({ balance: 196000 }), broken({ narration: 'Outward Ceft Transfer', balance: 146000 }), row({ narration: 'Ceft Charges', amount: 25, balance: 145975 })]);
        expect(repairByArithmetic(input).repaired).toMatchObject({ index: 1, to: { amount: 50000, direction: 'debit' }, how: expect.stringContaining('running balance') });
    });
    it('a direction the reader had to assume is corrected when that alone reaches the closing balance (a credit read as a debit)', () => {
        const input = statement([row({ amount: 10 }), row({ narration: 'SALARY JULY', amount: 1000, direction: 'debit', directionSource: 'assumed', needsReview: true })], { opening: 100, closing: 1090, credits: 0, debits: 1010, expected: -910, difference: 2000 });
        expect(repairByArithmetic(input).repaired).toMatchObject({ index: 1, to: { amount: 1000, direction: 'credit' } });
    });
    it('the card formula is used for a card statement (a purchase raises what is owed)', () => {
        const input = statement([row({ amount: 100, direction: 'debit' }), row({ narration: 'PAYMENT THANK YOU 250.00', amount: 999, direction: 'debit', directionSource: 'assumed', needsReview: true })],
            { opening: 1000, closing: 850, credits: 0, debits: 1099, expected: 2099, difference: -1249 }, { layout: { statementType: 'credit-card' } });
        expect(repairByArithmetic(input).repaired).toMatchObject({ index: 1, to: { amount: 250, direction: 'credit' } });
    });
});

describe('and never otherwise', () => {
    it('a direction the PAGE marked is never turned round', () => {
        const input = statement([row({ amount: 10 }), row({ narration: 'SALARY', amount: 1000, directionSource: 'column' })], { opening: 100, closing: 1090, credits: 0, debits: 1010, expected: -910, difference: 2000 });
        expect(repairByArithmetic(input).repaired).toBeNull();
    });
    it('two corrections that would both close the books are no proof of either', () => {
        const flagged = (n) => row({ narration: `ITEM ${n}`, amount: 1000, direction: 'debit', directionSource: 'assumed', needsReview: true });
        const input = statement([flagged(1), flagged(2)], { opening: 0, closing: 2000, credits: 0, debits: 2000, expected: -2000, difference: 4000 });
        expect(repairByArithmetic(input).repaired).toBeNull();                       // either one flipped would do
    });
    it('a statement that already adds up, or has no printed balances, or whose rows came from embedded data, is left alone', () => {
        expect(repairByArithmetic(statement([row()], { ok: true, difference: 0 })).repaired).toBeNull();
        expect(repairByArithmetic(statement([row()], { opening: null, closing: null })).repaired).toBeNull();
        expect(repairByArithmetic(statement(dfcc().rows, {}, { layout: { embeddedRows: 3 } })).repaired).toBeNull();
        expect(repairByArithmetic({ rows: [] }).repaired).toBeNull();
    });
    it('a gap no single row can explain (a row that is really missing) is not made up', () => {
        const input = statement([row(), row({ narration: 'Ceft Charges', amount: 25 })], { opening: 200000, closing: 100000, credits: 0, debits: 4025, expected: 195975, difference: -95975 });
        expect(repairByArithmetic(input).repaired).toBeNull();
    });
    it('the input is never changed', () => {
        const input = dfcc(), before = JSON.stringify(input);
        repairByArithmetic(input);
        expect(JSON.stringify(input)).toBe(before);
    });
});

describe('a statement stopped at "rows could not be proven to add up" is read again, proven by its one row, and filed whole', () => {
    const owner = { uid: 'u', email: 'owner@example.com' }, mail = 'wf-mail/owner_example_com', itemPath = `${mail}/items/item0`;
    const world = () => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, lastSettleMs: Date.now(), senders: [{ id: 'statements@dfccbank.com', kind: 'address', status: 'approved', name: 'DFCC', domain: 'dfccbank.com' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
        [itemPath]: { uid: 'u', bank: 'DFCC', filename: 'DFCC Bank Statement - Aug 26.pdf', from: 'statements@dfccbank.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
    });
    const text = 'DFCC BANK PLC\nStatement\nStatement Period: 01/08/2026 - 31/08/2026\nOpening Balance 200,000.00\nClosing Balance 145,975.00\n04/08/2026 POS Transaction KEELLS 4,000.00\n14/08/2026 Outward Ceft Transfer 376657XXXXX0276 50,000.00\n15/08/2026 Ceft Charges 376657XXXXX0276 25.00';
    const run = (w, parsed) => runStatementSync({ action: 'drain', db: w.db, owner, env: {}, intake: async () => ({ body: { ok: true } }), open: async () => [], maxSteps: 1, budgetMs: 40000, settle: settleStatement,
        f: async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) }),
        board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); },
        loadAttachment: async () => ({ bytes: Buffer.from('%PDF-1.4 statement'), filename: 'DFCC Bank Statement - Aug 26.pdf', contentSha256: 'x' }),
        read: async () => ({ text, parsed }) });
    it('all three rows are settled, the 50,000.00 as money out, and nothing is put to the owner', async () => {
        const w = world();
        const out = await run(w, dfcc());
        expect(out.status).toBe('filed');
        expect(w.data.get(itemPath)).toMatchObject({ status: 'filed', filed: true });
        // the 50,000.00 is a transfer to the owner's own card: counted as the transfer it is (the books' rule for CEFT to an own account), not as spending — and above all not as 30,735.16 of income
        expect(w.data.get('users/u').expenses.map(e => e.amount).sort((a, b) => a - b)).toEqual([25, 4000]);
        expect(w.data.get('users/u').incomeRecv).toEqual([]);
        const ledger = [...w.data.entries()].filter(([key]) => key.includes('/statementLedger/')).map(([, value]) => value);
        expect(ledger.map(entry => entry.status).sort()).toEqual(['filed', 'filed', 'skipped']);
        expect([...w.data.keys()].filter(key => key.includes('/statementReview/'))).toEqual([]);
    });
    it('a reading that no single row explains still stops, as before — and the log says why in counts and shapes (no figure, no name)', async () => {
        const w = world();
        const lines = [];
        vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
        const input = dfcc(); input.reconciliation.closing = 100000; input.reconciliation.difference = -126710.16;
        await run(w, input);
        expect(w.data.get(itemPath).status).toBe('needs_review');
        const item = lines.map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).find(entry => entry && entry.evt === 'statement-sync-item' && entry.status === 'needs_review');
        expect(item.diag.recon).toMatchObject({ rows: 3, flagged: 1, mismatched: 0, balanceColumn: false });
        expect(item.diag.recon.shapes).toHaveLength(1);
        expect(JSON.stringify(item.diag.recon)).not.toMatch(/30,?735|376657|Ceft|50,?000/i);
        expect(item.diag.recon.shapes[0]).toMatch(/9{2},9{3}\.9{2}|9+\.9{2}/);
    });
});

describe('why a waiting statement was not put back is said, by guard', () => {
    const world = (source, reason = 'statement-layout-or-reconciliation-needs-review') => createFirestore({
        'users/u': {},
        'wf-mail/m/items/a': { uid: 'u', status: 'needs_review', reviewReason: reason, cursor: 0, ...source },
        'users/u/statementReview/r1': { uid: 'u', sourcePath: 'wf-mail/m/items/a', index: -1, status: 'pending', reason },
    });
    it('names the condition that held it, and puts it back when none does', async () => {
        expect((await recoverWholeStatementFailures({ db: world({ wholeReplayVersion: 99 }).db, uid: 'u' })).why).toEqual({ 'already-read-this-version': 1 });
        expect((await recoverWholeStatementFailures({ db: world({ cursor: 5 }).db, uid: 'u' })).why).toEqual({ 'part-filed': 1 });
        expect((await recoverWholeStatementFailures({ db: world({ status: 'dead_letter' }).db, uid: 'u' })).why).toEqual({ 'status:dead_letter': 1 });
        expect((await recoverWholeStatementFailures({ db: world({}, 'something-else').db, uid: 'u' })).why).toEqual({ 'reason:something-else': 1 });
        const free = await recoverWholeStatementFailures({ db: world({}).db, uid: 'u' });
        expect(free).toMatchObject({ recovered: 1 });
        expect(free.why).toBeUndefined();
    });
});
