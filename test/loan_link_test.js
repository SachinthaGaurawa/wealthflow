import { describe, expect, it } from 'vitest';
import { VIA, loanMonths, matchLoanForDebit, linkedLoanMonths, linkExpenseToLoan, healLoanLinks, LOAN_CATEGORY } from '../loan-link.mjs';

// One loan installment, one count. A bank debit that IS the installment is linked to it and the loan's scheduled amount is not added
// again; paid any other way, the loan counts it. These tests pin the matching (evidence only) and the arithmetic (never twice, never
// dropped), including a randomised check against a ground truth.

const loan = (extra = {}) => ({ id: 'L1', name: 'Honda Vezel Loan', bank: 'HNB', start: '2026-01-05', duration: 12, monthly: 45230.5, rate: 12, payments: [], ...extra });
const debit = (description, amount = 45230.5, date = '2026-03-05') => ({ description, amount, date });

describe('the schedule', () => {
    it('is one key per instalment from the start month', () => {
        expect(loanMonths(loan({ start: '2026-11-20', duration: 4 }))).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
        expect(loanMonths({ start: '', duration: 3 })).toEqual([]);
        expect(loanMonths({ start: '2026-01-01', duration: 0 })).toEqual([]);
    });
});

describe('which loan a bank debit is the installment of', () => {
    it('the loan\'s account number in the narration is decisive, even with no loan wording', () => {
        const l = loan({ accountNo: '0741234567' });
        expect(matchLoanForDebit(debit('CEFTS 0741234567 SETTLEMENT'), [l])).toMatchObject({ month: '2026-03', why: 'account-number' });
    });
    it('the loan\'s name in the narration', () => {
        expect(matchLoanForDebit(debit('HONDA VEZEL LOAN INST 03'), [loan()])).toMatchObject({ loan: { id: 'L1' }, why: 'loan-name' });
    });
    it('loan wording with one open loan is enough', () => {
        expect(matchLoanForDebit(debit('LOAN INSTALMENT'), [loan({ name: 'Car', bank: 'Seylan' })])).toMatchObject({ month: '2026-03', why: 'loan-wording' });
    });
    it('loan wording with two loans that fit equally is never guessed', () => {
        const a = loan({ id: 'A', name: 'Car', bank: 'X' }), b = loan({ id: 'B', name: 'House', bank: 'Y' });
        expect(matchLoanForDebit(debit('LOAN INSTALMENT'), [a, b])).toBeNull();
    });
    it('a name that is not the lender\'s, or the lender\'s name with an amount that is not the installment, is a coincidence: not linked', () => {
        expect(matchLoanForDebit(debit('HNB CEFTS TRANSFER 4455', 30000), [loan({ name: 'Car' })])).toBeNull();      // the lender, but not the installment
        expect(matchLoanForDebit(debit('KEELLS SUPER', 45230.5), [loan()])).toBeNull();                          // the installment, but nothing says the lender, the loan or the pay day
        expect(matchLoanForDebit(debit('HNB ATM WITHDRAWAL COLOMBO', 45230.5), [loan()])).toBeNull();            // a round installment is the amount of a round withdrawal too
    });
    it('the lender\'s name with the installment to the cent IS the installment — the bank rarely says "loan" on a transfer', () => {
        expect(matchLoanForDebit(debit('HNB CEFTS TRANSFER 4455', 45230.5), [loan({ name: 'Car' })])).toMatchObject({ why: 'lender-and-amount' });
    });
    it('the installment to the cent within three days of the loan\'s pay day is the installment, however bare the narration', () => {
        expect(matchLoanForDebit(debit('CEFT TRANSFER 0741234567', 45230.5), [loan({ payDay: 5 })])).toMatchObject({ why: 'pay-day-and-amount' });
        expect(matchLoanForDebit(debit('CEFT TRANSFER 0741234567', 45230.5), [loan({ payDay: 20 })])).toBeNull();
        expect(matchLoanForDebit(debit('CEFT TRANSFER 0741234567', 45000), [loan({ payDay: 5 })])).toBeNull();
    });
    it('the same words as a debit already tied to this loan in another month tie the installment, whatever its amount', () => {
        const earlier = [{ id: 'E0', desc: 'CEFT TRANSFER TO ACME FINANCE 77', amount: 47000, loanLink: { loanId: 'L1', month: '2026-02' } }];
        expect(matchLoanForDebit(debit('CEFT TRANSFER TO ACME FINANCE 88', 46500), [loan()], { expenses: earlier })).toMatchObject({ why: 'seen-before' });
        expect(matchLoanForDebit(debit('CEFT TRANSFER TO SOMEONE ELSE 88', 46500), [loan()], { expenses: earlier })).toBeNull();
    });
    it('a fee, a premium, a penalty or a reversal around the loan is never the installment', () => {
        for (const text of ['LOAN PROCESSING FEE', 'HONDA VEZEL LOAN INSURANCE PREMIUM', 'LOAN PENALTY INTEREST', 'LOAN INSTALMENT REVERSAL', 'STAMP DUTY LOAN']) expect(matchLoanForDebit(debit(text), [loan()])).toBeNull();
    });
    it('a fraction of an installment is not the installment; a larger one (an extra payment) still is', () => {
        expect(matchLoanForDebit(debit('LOAN INSTALMENT', 2500), [loan()])).toBeNull();
        expect(matchLoanForDebit(debit('LOAN INSTALMENT', 150000), [loan()])).toMatchObject({ month: '2026-03' });
    });
    it('only a month inside the loan\'s schedule: before the start or after the end is not an installment of it', () => {
        expect(matchLoanForDebit(debit('LOAN INSTALMENT', 45230.5, '2025-12-05'), [loan()])).toBeNull();
        expect(matchLoanForDebit(debit('LOAN INSTALMENT', 45230.5, '2027-01-05'), [loan()])).toBeNull();
    });
    it('the owner\'s "cash / elsewhere" keeps every bank debit away from that installment — unless the loan\'s own number is on it', () => {
        const other = loan({ payments: [{ month: '2026-03', paid: true, amount: 45230.5, via: VIA.OTHER }], accountNo: '0741234567' });
        expect(matchLoanForDebit(debit('LOAN INSTALMENT'), [other])).toBeNull();
        expect(matchLoanForDebit(debit('LOAN 0741234567'), [other])).toMatchObject({ why: 'account-number' });
    });
    it('the owner\'s "paid from my bank account" finds its debit by what they said, whatever the narration — if the amount agrees', () => {
        const said = loan({ payments: [{ month: '2026-03', paid: true, amount: 45230.5, via: VIA.BANK }] });
        expect(matchLoanForDebit(debit('CEFTS/7712/SOMEONE'), [said])).toMatchObject({ why: 'owner-said-bank' });
        expect(matchLoanForDebit(debit('CEFTS/7712/SOMEONE', 9000), [said])).toBeNull();
    });
});

describe('the arithmetic: linked once, never dropped', () => {
    const expense = (extra = {}) => ({ id: 'E1', desc: 'LOAN INSTALMENT', amount: 45230.5, date: '2026-03-05', month: '2026-03', source: 'statement', ...extra });
    it('linking sets the link, the category and the loan\'s payment (via bank, naming the expense)', () => {
        const l = loan(), e = expense(), user = { loans: [l], expenses: [e] };
        linkExpenseToLoan(user, e, l, '2026-03', 1000);
        expect(e).toMatchObject({ loanLink: { loanId: 'L1', month: '2026-03' }, cat: LOAN_CATEGORY });
        expect(l.payments).toEqual([expect.objectContaining({ month: '2026-03', paid: true, amount: 45230.5, via: 'bank', expenseId: 'E1', source: 'statement' })]);
        expect(linkedLoanMonths(user.expenses, user.loans).has('L1|2026-03')).toBe(true);
    });
    it('two debits for one installment (the installment and an extra) add up in the loan\'s payment and both are linked', () => {
        const l = loan(), a = expense(), b = expense({ id: 'E2', amount: 10000 }), user = { loans: [l], expenses: [a, b] };
        linkExpenseToLoan(user, a, l, '2026-03', 1); linkExpenseToLoan(user, b, l, '2026-03', 2);
        expect(l.payments).toHaveLength(1);
        expect(l.payments[0].amount).toBe(55230.5);
    });
    it('the skip is derived from the expenses that exist: delete the expense and the loan counts that month again', () => {
        const l = loan(), e = expense(), user = { loans: [l], expenses: [e] };
        linkExpenseToLoan(user, e, l, '2026-03', 1);
        expect(linkedLoanMonths([e], [l]).has('L1|2026-03')).toBe(true);
        expect(linkedLoanMonths([], [l]).has('L1|2026-03')).toBe(false);
    });
    it('a link that no longer describes the expense (the expense moved to another month) is ignored, so nothing is dropped', () => {
        const l = loan(), e = expense({ loanLink: { loanId: 'L1', month: '2026-03' }, month: '2026-04', date: '2026-04-05' });
        expect(linkedLoanMonths([e], [l]).size).toBe(0);
    });
    it('a recurring expense linked to a loan stands for every month of that loan from its own month on', () => {
        const l = loan(), e = expense({ recurring: true, loanLink: { loanId: 'L1', month: '2026-03' } });
        const set = linkedLoanMonths([e], [l]);
        expect(set.has('L1|2026-02')).toBe(false); expect(set.has('L1|2026-03')).toBe(true); expect(set.has('L1|2026-12')).toBe(true);
    });
    it('healing links the debits that were imported before the link existed, once, and leaves the others alone', () => {
        const l = loan(), a = expense(), b = expense({ id: 'E2', desc: 'KEELLS SUPER', amount: 4000 }), user = { loans: [l], expenses: [a, b] };
        expect(healLoanLinks(user, 5)).toEqual([expect.objectContaining({ expenseId: 'E1', loanId: 'L1', month: '2026-03' })]);
        expect(b.loanLink).toBeUndefined();
        expect(healLoanLinks(user, 6)).toEqual([]);
    });
});

// Ground truth: whatever the narrations, a month's total is the other spending plus each installment ONCE; it can read high only where a
// narration gives no evidence (never linked, so never dropped) and never low.
function monthTotal(user, ym) {
    const linked = linkedLoanMonths(user.expenses, user.loans);
    let total = 0;
    for (const l of user.loans) if (loanMonths(l).includes(ym) && !linked.has(`${l.id}|${ym}`)) total += l.monthly;
    for (const e of user.expenses) if (e.month === ym && !e.recurring) total += e.amount;
    return total;
}
describe('randomised: no installment is ever counted twice, none is ever lost', () => {
    let seed = 20261001;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const KNOWN = ['LOAN INSTALMENT', 'HONDA VEZEL LOAN INST', 'EMI DEBIT', 'LN REPAYMENT 0741234567', 'HOUSING LOAN REPAYMENT'];
    const UNKNOWN = ['CEFTS/7712/SOMEONE', 'SLIPS DEBIT 889', 'ONLINE TRANSFER OUT'];
    it('4000 random households', () => {
        let double = 0, low = 0, exact = 0;
        for (let run = 0; run < 4000; run += 1) {
            const loans = [loan({ id: 'A', name: 'Honda Vezel Loan', monthly: 45230.5, accountNo: '0741234567', start: '2026-01-05', duration: 12 }),
                ...(rnd() < 0.5 ? [loan({ id: 'B', name: 'House Loan', bank: 'DFCC', monthly: 61000, start: '2026-02-10', duration: 10 })] : [])];
            const expenses = []; let truth = 0, unknownPaid = 0;
            const month = `2026-${String(3 + Math.floor(rnd() * 6)).padStart(2, '0')}`;
            for (const l of loans) {
                const via = rnd();
                if (via < 0.4) { truth += l.monthly; continue; }                       // paid in cash: only the loan knows
                const known = rnd() < 0.7;
                const text = l.id === 'B' ? (known ? 'DFCC HOUSE LOAN INSTALMENT' : pick(UNKNOWN)) : (known ? pick(KNOWN) : pick(UNKNOWN));
                expenses.push({ id: `E${run}${l.id}`, desc: text, amount: l.monthly, date: `${month}-07`, month, source: 'statement' });
                truth += l.monthly; if (!known) unknownPaid += l.monthly;
            }
            for (let i = 0; i < Math.floor(rnd() * 4); i += 1) { const amount = Math.round(rnd() * 20000) / 100 * 100 + 150; expenses.push({ id: `X${run}${i}`, desc: pick(['KEELLS SUPER', 'CEB BILL', 'DIALOG', 'LOAN PROCESSING FEE']), amount, date: `${month}-12`, month, source: 'statement' }); truth += amount; }
            const user = { loans, expenses };
            healLoanLinks(user, 1);
            const total = monthTotal(user, month);
            if (total < truth - 0.001) low += 1;
            else if (total > truth + 0.001 + unknownPaid) double += 1;
            else if (Math.abs(total - truth) < 0.001) exact += 1;
        }
        expect(low).toBe(0);          // never an installment lost
        expect(double).toBe(0);       // never counted twice where the narration gave evidence
        expect(exact).toBeGreaterThan(2000);
    });
});
