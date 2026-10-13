import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { incomeIn } from '../wealthflow-reactive.js';
import { linkedLoanMonths, loanMonths } from '../loan-link.mjs';

// The screens' half of "one loan installment, one count": Monthly Overview, Year Expenses, the AI context and the score must not add an
// installment that a bank debit already counts, the Paid-from choice must tie and free debits, and the inline slice must agree with
// loan-link.mjs (the rule the statement worker uses).
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    const from = html.slice(start - 6, start) === 'async ' ? start - 6 : start;
    return html.slice(from, html.indexOf('\n        }', start) + 10);
}
function page(data = {}) {
    const store = { loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [], ...data };
    const context = vm.createContext({
        DB: { get: key => store[key] || [], set: vi.fn((key, value) => { store[key] = value; }) }, p2: n => String(n).padStart(2, '0'),
        window: { WFReactive: { incomeIn } }, notify: vi.fn(), renderLoans: vi.fn(), renderDash: vi.fn(), fmt: n => String(n), parseMoney: v => Number(String(v).replace(/,/g, '')),
        promptPaymentAmount: vi.fn(), Date,
    });
    for (const name of ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', 'loanEndDate', 'getLoanMonthlyForDate', '_wfLinkedLoanMonths', '_wfLoanDueNow',
        '_wfFindLoanDebit', '_wfSetLoanVia', '_wfMonthIsFuture', 'getMonthlyData', 'toggleLoanInstallment']) vm.runInContext(source(name), context);
    return { context, store };
}
const loan = (extra = {}) => ({ id: 'L1', name: 'Honda Vezel Loan', bank: 'HNB', start: '2026-01-01', duration: 12, monthly: 45000, amount: 500000, rate: 0, payments: [], ...extra });
const debit = (extra = {}) => ({ id: 'E1', desc: 'LOAN INSTALMENT', amount: 45000, date: '2026-03-05', month: '2026-03', cat: 'Other', ...extra });
const yearTotal = ctx => Array.from({ length: 12 }, (_, m) => ctx.getMonthlyData(2026, m).totalExp).reduce((a, b) => a + b, 0);

const paid = (month, extra = {}) => ({ month, paid: true, amount: 45000, via: 'other', paidAt: 1, ...extra });
const yearTotalOf = (ctx, year) => Array.from({ length: 12 }, (_, m) => ctx.getMonthlyData(year, m).totalExp).reduce((a, b) => a + b, 0);

describe('the totals count an installment once — when it is paid', () => {
    it('unpaid counts nothing (the bank debit alone is the money that left); linked counts once through the debit; paid by hand counts once through the payment', () => {
        const unpaid = page({ loans: [loan()], expenses: [debit()] }).context.getMonthlyData(2026, 2);
        expect(unpaid.totalExp).toBe(45000); expect(unpaid.loanTotal).toBe(0);
        const linked = page({ loans: [loan({ payments: [paid('2026-03', { via: 'bank', expenseId: 'E1' })] })], expenses: [debit({ loanLink: { loanId: 'L1', month: '2026-03' } })] }).context;
        const march = linked.getMonthlyData(2026, 2);
        expect(march.totalExp).toBe(45000);
        expect(march.loanTotal).toBe(0); expect(march.expTotal).toBe(45000);
        expect(Array.from(march.loanItems)).toHaveLength(0);
        expect(linked.getMonthlyData(2026, 3).loanTotal).toBe(0);              // April: not paid, nothing counted
        const byHand = page({ loans: [loan({ payments: [paid('2026-03')] })] }).context.getMonthlyData(2026, 2);
        expect(byHand.totalExp).toBe(45000); expect(byHand.loanTotal).toBe(45000);
        expect(byHand.loanItems[0]).toMatchObject({ amount: 45000, paid: true, cat: 'Loan Repayment' });
    });
    it('the paid amount is what counts, not the schedule', () => {
        const c = page({ loans: [loan({ payments: [paid('2026-03', { amount: 60000 })] })] }).context;
        expect(c.getMonthlyData(2026, 2).loanTotal).toBe(60000);
    });
    it('Year Expenses: twelve paid installments are twelve installments, paid from the bank, by cash or a mixture', () => {
        const months = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`);
        const l = loan({ start: '2025-01-01', payments: months.map((m, i) => paid(m, i % 3 === 0 ? {} : { via: 'bank', expenseId: `E${i}` })) });   // the first of every three months is paid in cash
        const expenses = months.map((m, i) => i % 3 !== 0 ? debit({ id: `E${i}`, date: `${m}-05`, month: m, loanLink: { loanId: 'L1', month: m } }) : null).filter(Boolean);
        expect(yearTotalOf(page({ loans: [l], expenses }).context, 2025)).toBe(12 * 45000);
    });
    it('delete the debit and the paid installment counts the month again — nothing is ever lost', () => {
        const l = loan({ payments: [paid('2026-03', { via: 'bank', expenseId: 'E1' })] });
        const withDebit = page({ loans: [l], expenses: [debit({ loanLink: { loanId: 'L1', month: '2026-03' } })] }).context;
        const without = page({ loans: [l], expenses: [] }).context;
        expect(withDebit.getMonthlyData(2026, 2).totalExp).toBe(45000);
        expect(without.getMonthlyData(2026, 2).totalExp).toBe(45000);
    });
    it('a link whose expense moved to another month no longer hides the paid installment', () => {
        const c = page({ loans: [loan({ payments: [paid('2026-03', { via: 'bank', expenseId: 'E1' })] })], expenses: [debit({ loanLink: { loanId: 'L1', month: '2026-03' }, month: '2026-04', date: '2026-04-05' })] }).context;
        expect(c.getMonthlyData(2026, 2).totalExp).toBe(45000);                 // March: the paid installment
        expect(c.getMonthlyData(2026, 3).totalExp).toBe(45000);                 // April: the expense that now sits there (April's own installment is not paid)
    });
    it('the AI context and the score leave out an installment already counted this month', () => {
        const c = page({ loans: [loan()], expenses: [debit({ loanLink: { loanId: 'L1', month: '2026-03' } })] }).context;
        expect(c._wfLoanDueNow([loan()], '2026-03')).toBe(0);
        expect(c._wfLoanDueNow([loan()], '2026-04')).toBe(45000);
    });
});

describe('the inline slice agrees with the rule the worker uses', () => {
    it('same answer on 2000 random households (links, stale links, recurring links)', () => {
        let seed = 7;
        const shared = page();
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
        for (let run = 0; run < 2000; run += 1) {
            const loans = [loan({ id: 'A', start: '2026-02-01', duration: 6 }), loan({ id: 'B', start: '2025-11-01', duration: 5 })];
            const expenses = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) => {
                const m = `2026-${String(1 + Math.floor(rnd() * 6)).padStart(2, '0')}`;
                const e = { id: `E${i}`, desc: 'x', amount: 1, date: `${m}-05`, month: rnd() < 0.8 ? m : `2026-${String(1 + Math.floor(rnd() * 6)).padStart(2, '0')}` };
                if (rnd() < 0.7) e.loanLink = { loanId: rnd() < 0.5 ? 'A' : 'B', month: rnd() < 0.8 ? m : `2026-${String(1 + Math.floor(rnd() * 6)).padStart(2, '0')}` };
                if (rnd() < 0.15) e.recurring = true;
                return e;
            });
            shared.store.loans = loans; shared.store.expenses = expenses;
            expect([...shared.context._wfLinkedLoanMonths()].sort()).toEqual([...linkedLoanMonths(expenses, loans)].sort());
        }
        expect(loanMonths(loan()).length).toBe(12);
    });
});

describe('the Paid-from choice', () => {
    it('finds the one bank debit of that month about that amount, never a fee, and never guesses between two', () => {
        const one = page({ loans: [loan()], expenses: [debit({ desc: 'CEFTS/7712/SOMEONE' }), debit({ id: 'E2', desc: 'LOAN PROCESSING FEE', amount: 45000 })] }).context;
        expect(one._wfFindLoanDebit(loan(), '2026-03', 45000).id).toBe('E1');
        const two = page({ loans: [loan()], expenses: [debit({ desc: 'CEFTS/1' }), debit({ id: 'E2', desc: 'CEFTS/2' })] }).context;
        expect(two._wfFindLoanDebit(loan(), '2026-03', 45000)).toBeNull();
        const worded = page({ loans: [loan()], expenses: [debit({ desc: 'CEFTS/1' }), debit({ id: 'E2', desc: 'HNB LOAN INST' })] }).context;
        expect(worded._wfFindLoanDebit(loan(), '2026-03', 45000).id).toBe('E2');
    });
    it('marking an installment paid from the bank ties the debit already there; the month then counts once', async () => {
        const { context, store } = page({ loans: [loan()], expenses: [debit({ desc: 'CEFTS/7712/SOMEONE' })] });
        context.promptPaymentAmount.mockResolvedValue({ amount: 45000, notes: '', via: 'bank' });
        await context.toggleLoanInstallment('L1', '2026-03');
        expect(store.expenses[0]).toMatchObject({ loanLink: { loanId: 'L1', month: '2026-03' }, cat: 'Loan Repayment' });
        expect(store.loans[0].payments[0]).toMatchObject({ month: '2026-03', paid: true, via: 'bank', expenseId: 'E1' });
        expect(store.loans[0].payVia).toBe('bank');
        expect(context.getMonthlyData(2026, 2).totalExp).toBe(45000);
    });
    it('"paid from the bank" before the statement has the debit: remembered, the loan counts meanwhile', async () => {
        const { context, store } = page({ loans: [loan()], expenses: [] });
        context.promptPaymentAmount.mockResolvedValue({ amount: 45000, notes: '', via: 'bank' });
        await context.toggleLoanInstallment('L1', '2026-03');
        expect(store.loans[0].payments[0]).toMatchObject({ via: 'bank' });
        expect(store.loans[0].payments[0].expenseId).toBeUndefined();
        expect(context.getMonthlyData(2026, 2).totalExp).toBe(45000);
    });
    it('"cash / somewhere else" ties no debit, and frees one that was tied', async () => {
        const { context, store } = page({ loans: [loan({ payments: [{ month: '2026-03', paid: false }] })], expenses: [debit({ loanLink: { loanId: 'L1', month: '2026-03' } })] });
        context.promptPaymentAmount.mockResolvedValue({ amount: 45000, notes: '', via: 'other' });
        await context.toggleLoanInstallment('L1', '2026-03');
        expect(store.expenses[0].loanLink).toBeUndefined();
        expect(store.loans[0].payments[0]).toMatchObject({ via: 'other', paid: true });
        expect(context.getMonthlyData(2026, 2).totalExp).toBe(90000);          // two different payments now, each counted
    });
    it('undoing a payment frees the debit that was tied to it', async () => {
        const { context, store } = page({ loans: [loan({ payments: [{ month: '2026-03', paid: true, amount: 45000, via: 'bank', expenseId: 'E1' }] })], expenses: [debit({ loanLink: { loanId: 'L1', month: '2026-03' } })] });
        await context.toggleLoanInstallment('L1', '2026-03');
        expect(store.expenses[0].loanLink).toBeUndefined();
        expect(store.loans[0].payments[0]).toMatchObject({ paid: false });
        expect(store.loans[0].payments[0].expenseId).toBeUndefined();
    });
});

describe('the prompt says what each choice does', () => {
    it('offers the two choices in plain words, with a hint that says how the payment is counted', () => {
        expect(html).toMatch(/<label class="fl">How did you pay this installment\?<\/label>/);
        expect(html).toContain('Choose one so this installment is counted only once.');
        expect(html).toContain('data-via="bank">My bank account</button>');
        expect(html).toContain('data-via="other">Cash / somewhere else</button>');
        expect(html).toContain('Not on your bank statements, so this loan counts it here — once.');
        expect(html).toContain('It shows on your bank statement, so it is counted once from there — not again here.');
        expect(html).toMatch(/close\(\{ amount: amt, notes: overlay\.querySelector\('#_pp_notes'\)\.value\.trim\(\), via \}\)/);
    });
});

describe('a card charge for a tracked subscription is counted by the subscription, once', () => {
    it('Monthly Overview skips the card charge that names its subscription, and counts every other card charge', () => {
        const sub = { id: 'S1', name: 'Netflix', amount: 1500, cycle: 'monthly', category: 'Entertainment', createdAt: '2026-01-01T00:00:00Z', monthOverrides: { '2026-03': 1500 } };
        const netflix = { id: 'K1', desc: 'NETFLIX.COM', amount: 1500, date: '2026-03-07', subscriptionLink: 'S1' }, keells = { id: 'K2', desc: 'KEELLS', amount: 4000, date: '2026-03-09' };
        const linked = page({ subscriptions: [sub], cconetime: [netflix, keells] }).context.getMonthlyData(2026, 2);
        expect(linked.ccotTotal).toBe(4000); expect(linked.subTotal).toBe(1500); expect(linked.totalExp).toBe(5500);
        const unlinked = page({ subscriptions: [sub], cconetime: [{ ...netflix, subscriptionLink: undefined }, keells] }).context.getMonthlyData(2026, 2);
        expect(unlinked.totalExp).toBe(7000);                                   // the old double count
    });
});

describe('no screen adds up raw loan installments any more', () => {
    it('the AI insights context takes its figures from the shared financial context, never its own loan sums', () => {
        // buildFinancialContext (the books profile) keeps living costs apart from debt payments, so an installment a bank debit already
        // counts is not added a second time; the card used to total the Investments list and this month's typed rows itself.
        const start = html.indexOf('async function generateAIInsights()');
        const body = html.slice(start, html.indexOf('\n        }\n', start));
        expect(body).toContain('const ctx = buildFinancialContext();');
        expect(body).toContain('const loanTotal = ctx.monthlyLoanPayments || 0;');
        expect(body).not.toMatch(/loans\.filter\(l => loanEndDate\(l\) > now\)\.reduce/);
        expect(body).not.toContain("DB.get('loans')");
    });
    it('the only place that still sums installments per loan skips the ones a bank debit counts', () => {
        const sums = html.split('\n').filter(line => /loans[^;]*\.reduce\([^;]*\.monthly/.test(line));
        expect(sums).toHaveLength(1);
        expect(sums[0]).toContain('linked.has(');
    });
});
