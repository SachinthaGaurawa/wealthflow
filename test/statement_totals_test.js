import { describe, expect, it } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { printedTotals, totalsAgree } from '../statement-totals.mjs';
import { chainOf, chainLines } from '../statement-coverage.mjs';
import { runStatementSync } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';

// DFCC "Your Combined Banking Statement" prints, under the last row, "Transaction Summary 1,536,807.95 852,027.00": the bank's own addition of every withdrawal and every deposit. The balance chain
// is one proof of a reading; these two figures, reached to the cent, are another that does not depend on a single balance column. (The statement itself is not in the repository: it holds a name and
// account numbers. These are invented figures in the same shape.)

const HEAD = 'Post Date Effective Date Narration Withdrawal (Dr) Deposit (Cr) Balance';
describe('the totals a bank prints', () => {
    it('reads "Transaction Summary <withdrawals> <deposits>" in the order the header gives', () => {
        expect(printedTotals(`${HEAD}\nTransaction Summary 1,536,807.95 852,027.00`)).toEqual({ debits: 153680795, credits: 85202700, how: 'transaction-summary' });
        expect(printedTotals('Date Narration Deposit Withdrawal Balance\nTransaction Summary 852,027.00 1,536,807.95')).toMatchObject({ debits: 153680795, credits: 85202700 });
    });
    it('adds the totals of every account of a combined statement', () => {
        const text = `${HEAD}\nTransaction Summary 1,000.00 200.00\n...\nTransaction Summary 50.50 0.25`;
        expect(printedTotals(text)).toMatchObject({ debits: 105050, credits: 20025 });
    });
    it('reads "Total Debits … / Total Credits …" lines, and only when both are there', () => {
        expect(printedTotals('Total Debits: LKR 12,345.67\nTotal Credits: LKR 89.00')).toEqual({ debits: 1234567, credits: 8900, how: 'total-lines' });
        expect(printedTotals('Total Withdrawals 500.00\nTotal Deposits 40.00')).toMatchObject({ debits: 50000, credits: 4000 });
        expect(printedTotals('Total Debits: 12,345.67')).toBeNull();
    });
    it('does not take a credit limit, a balance summary or an empty text for totals', () => {
        expect(printedTotals('Credit Limit 500,000.00\nTotal Credit Limit 500,000.00\nBalance Summary 1.00 2.00')).toBeNull();
        expect(printedTotals('')).toBeNull();
        expect(printedTotals(null)).toBeNull();
    });
});

describe('do the rows add up to them', () => {
    const row = (amount, direction, extra = {}) => ({ date: '2026-08-04', narration: 'x', amount, direction, directionSource: 'balance', needsReview: false, valid: true, ...extra });
    const text = `${HEAD}\nTransaction Summary 1,500.50 300.00`;
    it('agrees only when BOTH figures are reached to the cent', () => {
        expect(totalsAgree({ rows: [row(1000, 'debit'), row(500.5, 'debit'), row(300, 'credit')] }, text)).toMatchObject({ present: true, ok: true });
        expect(totalsAgree({ rows: [row(1000, 'debit'), row(500.49, 'debit'), row(300, 'credit')] }, text).ok).toBe(false);
        expect(totalsAgree({ rows: [row(1000, 'debit'), row(500.5, 'debit'), row(299.99, 'credit')] }, text).ok).toBe(false);
        expect(totalsAgree({ rows: [row(1500.5, 'debit'), row(300, 'debit')] }, text).ok).toBe(false);          // a credit read as a debit moves both
    });
    it('proves nothing when a row has no direction, when a row is invalid, or when the statement prints no totals', () => {
        expect(totalsAgree({ rows: [row(1500.5, 'debit'), row(300, '')] }, text).ok).toBe(false);
        expect(totalsAgree({ rows: [row(1500.5, 'debit'), row(300, 'credit'), row(9999, 'credit', { valid: false })] }, text).ok).toBe(true);        // an invalid row is not a row
        expect(totalsAgree({ rows: [row(1, 'debit')] }, 'no totals here')).toEqual({ present: false, ok: false });
        expect(totalsAgree({ rows: [] }, text)).toEqual({ present: false, ok: false });
    });
});

describe('a statement whose balance chain does not close but whose printed totals agree is filed, and says why', () => {
    const owner = { uid: 'u', email: 'owner@example.com' }, mail = 'wf-mail/owner_example_com', itemPath = `${mail}/items/item0`;
    const rows = [
        { date: '2026-08-04', narration: 'POS Transaction KEELLS', amount: 1000, direction: 'debit', directionSource: 'balance', needsReview: false, valid: true, balance: 9000 },
        { date: '2026-08-05', narration: 'POS Transaction FUEL', amount: 500.5, direction: 'debit', directionSource: 'balance', needsReview: false, valid: true, balance: 8499.5 },
        { date: '2026-08-06', narration: 'Salary August', amount: 300, direction: 'credit', directionSource: 'balance', needsReview: false, valid: true, balance: 8799.5 },
    ];
    const statement = (rec = {}) => ({ rows, verdict: 'unverified', understood: false, reason: 'The rows were read, but the opening and closing balances do not add up.', invalidDates: 0, balanceMismatches: 0, layout: { statementType: 'bank_account', accountLast4: '5187' },
        reconciliation: { opening: 10000, closing: 7000, credits: 300, debits: 1500.5, expected: 8799.5, difference: 1799.5, ok: false, ...rec } });
    const world = () => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, lastSettleMs: Date.now(), senders: [{ id: 'statements@dfccbank.com', kind: 'address', status: 'approved', name: 'DFCC', domain: 'dfccbank.com' }] },
        'wf-statement-vault/u': { uid: 'u' }, 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
        [itemPath]: { uid: 'u', bank: 'DFCC', filename: 'DFCC_Statement_202608.html', from: 'statements@dfccbank.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
    });
    const run = (w, text, parsed) => runStatementSync({ action: 'drain', db: w.db, owner, env: {}, intake: async () => ({ body: { ok: true } }), open: async () => [], maxSteps: 1, budgetMs: 40000, settle: settleStatement,
        f: async url => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) }),
        board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); },
        loadAttachment: async () => ({ bytes: Buffer.from('%PDF-1.4 statement'), filename: 'DFCC_Statement_202608.html', contentSha256: 'x' }), read: async () => ({ text, parsed }) });
    const printed = 'DFCC BANK PLC\nStatement Period: 01/08/2026 - 31/08/2026\n' + HEAD + '\nTransaction Summary 1,500.50 300.00';

    it('filed whole, with the proof named, and nothing put to the owner', async () => {
        const w = world();
        const out = await run(w, printed, statement());
        expect(out.status).toBe('filed');
        expect(w.data.get(itemPath).proof).toMatchObject({ math: 'passed', by: 'printed-totals', totals: 'agree', rows: 3 });
        expect(w.data.get('users/u').expenses.map(e => e.amount).sort((a, b) => a - b)).toEqual([500.5, 1000]);
        expect([...w.data.keys()].filter(key => key.includes('/statementReview/'))).toEqual([]);
    });
    it('is still stopped when the totals do not agree, or none are printed, exactly as before', async () => {
        const wrong = world();
        await run(wrong, printed.replace('1,500.50', '1,500.51'), statement());
        expect(wrong.data.get(itemPath).status).toBe('needs_review');
        const none = world();
        await run(none, 'DFCC BANK PLC\nStatement Period: 01/08/2026 - 31/08/2026', statement());
        expect(none.data.get(itemPath).status).toBe('needs_review');
    });
    it('does not override a row whose own running balance disagrees', async () => {
        const w = world();
        const mismatched = statement(); mismatched.balanceMismatches = 1;
        await run(w, printed, mismatched);
        expect(w.data.get(itemPath).status).toBe('needs_review');
    });
});

describe('does each statement open where the one before it closed', () => {
    const at = iso => Date.parse(iso + 'T12:00:00Z');
    const stmt = (bank, file, received, opening, closing, last4 = '5187', extra = {}) => ({ bank, filename: file, receivedMs: at(received), status: 'filed', filed: true, proof: { math: 'passed', rows: 40, last4, opening, closing }, ...extra });
    it('joins April to August under one bank however its mail was labelled, and says where it does not', () => {
        const chains = chainOf([
            stmt('Dfccbank', 'DFCC_Statement_202604.html', '2026-05-04', 100000.5, 200000.25), stmt('Dfccbank', 'DFCC_Statement_202605.html', '2026-06-04', 200000.25, 300000),
            stmt('DFCC Bank', 'DFCC_Statement_202606.html', '2026-07-04', 300000, 310000), stmt('Dfccbank', 'DFCC_Statement_202608.html', '2026-09-04', 744413.37, 59632.42),
        ]);
        expect(chains).toHaveLength(1);
        expect(chains[0]).toMatchObject({ bank: 'DFCC Bank', account: '5187' });
        expect(chains[0].links.map(l => [l.from, l.to, l.apart === 0, l.months])).toEqual([['2026-04', '2026-05', true, 1], ['2026-05', '2026-06', true, 1], ['2026-06', '2026-08', false, 2]]);
        expect(chainLines(chains)).toEqual(['DFCC Bank …5187, each statement opens where the one before closed: 2026-04 to 2026-05 yes · 2026-05 to 2026-06 yes · 2026-06 to 2026-08 434,413.37 apart over 1 missing month']);
    });
    it('keeps accounts apart, leaves out a single statement, a copy of one, one with no balances or no account, and what is not filed', () => {
        const chains = chainOf([
            stmt('NTB', 'a_2026JAN.html', '2026-02-02', 1000.1, 2000.2, '1111'), stmt('NTB', 'a_2026FEB.html', '2026-03-02', 2000.2, 3000, '1111'),
            stmt('NTB', 'b_2026JAN.html', '2026-02-02', 5, 6, '2222'),
            stmt('NTB', 'a_2026FEB.html', '2026-03-03', 2000, 3000, '1111', { duplicateOf: 'x' }),
            stmt('HNB', 'h_2026JAN.pdf', '2026-02-02', null, null, '3333'), stmt('HNB', 'h_2026FEB.pdf', '2026-03-02', 1, 2, ''),
            stmt('AMEX', 'c_2026JAN.html', '2026-02-02', 1, 2, '4444', { status: 'needs_review', filed: false }), stmt('AMEX', 'c_2026FEB.html', '2026-03-02', 2, 3, '4444'),
        ]);
        expect(chains.map(c => `${c.account}:${c.links.length}`)).toEqual(['1111:1']);
        expect(chainOf(null)).toEqual([]);
        expect(chainLines(null)).toEqual([]);
    });
    it('a quiet stretch with no money moving still joins, and says how many months it spans', () => {
        const chains = chainOf([stmt('DFCC Bank', 'x_202601.pdf', '2026-02-02', 100, 200), stmt('DFCC Bank', 'x_202604.pdf', '2026-05-02', 200, 300)]);
        expect(chainLines(chains)[0]).toContain('2026-01 to 2026-04 yes (2 months between, no money moved)');
    });
});
