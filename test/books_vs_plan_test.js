import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { incomeIn } from '../wealthflow-reactive.js';
import { linkedLoanMonths } from '../loan-link.mjs';

// THE BOOKS: what HAPPENED. The dashboard chart, Year Expenses, Net Savings, the Expense Breakdown, the Monthly Plan page, the reports and the averages. The owner had paid his loans only up to a month
// (and 10 lakh of a 13.6 lakh installment in another) and saw every month carrying its full scheduled installment as if paid; the same went for future card instalments, subscriptions, recurring
// bills, planned expenses, future card charges and pending cheques. What is scheduled is shown as scheduled (the "Due" lists), never as paid. Run against the real getMonthlyData / _wfYearBooks
// with a fixed clock (2 Oct 2026).
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    return html.slice(start, html.indexOf('\n        }', start) + 10);
}
const TODAY = Date.UTC(2026, 9, 2, 12);
class FixedDate extends Date {
    constructor(...a) { if (a.length === 0) super(TODAY); else super(...a); }
    static now() { return TODAY; }
}
const p2 = n => String(n).padStart(2, '0');
const ym = (y, m) => `${y}-${p2(m)}`;
const monthsBetween = (y1, m1, y2, m2) => { const out = []; let y = y1, m = m1; while (y < y2 || (y === y2 && m <= m2)) { out.push(ym(y, m)); m += 1; if (m > 12) { m = 1; y += 1; } } return out; };

const SOURCES = ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', 'loanEndDate', 'getLoanMonthlyForDate', 'getCCIMonthlyForDate', '_wfLinkedLoanMonths',
    '_wfFindLoanDebit', '_wfMonthIsFuture', 'getMonthlyData', '_wfYearBooks'].map(source).join('\n');
const EMPTY = () => ({ loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [] });
/** One compiled page; each call swaps the household in the store it reads. */
const shared = (() => {
    const holder = { store: EMPTY() };
    const context = vm.createContext({ DB: { get: key => holder.store[key] || [], set: (key, value) => { holder.store[key] = value; } }, p2, Date: FixedDate, Math, Number, Object, Array, String, window: { WFReactive: { incomeIn } } });
    vm.runInContext(SOURCES, context);
    return { holder, context };
})();
function books(data = {}) {
    shared.holder.store = { ...EMPTY(), ...data };
    return { context: shared.context, store: shared.holder.store };
}
const loan = (extra = {}) => ({ id: 'L1', name: 'Honda Vezel Loan', bank: 'HNB', start: '2026-01-01', duration: 24, monthly: 45000, amount: 900000, rate: 0, payments: [], ...extra });
const paid = (month, extra = {}) => ({ month, paid: true, amount: 45000, via: 'other', paidAt: 1, ...extra });
const month = (b, m, basis) => b.context.getMonthlyData(2026, m - 1, basis);

describe('a loan installment counts when it is paid, and only then', () => {
    it('paid up to August, nothing after: September to December carry no loan at all', () => {
        const b = books({ loans: [loan({ payments: monthsBetween(2026, 1, 2026, 8).map(k => paid(k)) })] });
        for (let m = 1; m <= 8; m += 1) expect(month(b, m).loanTotal).toBe(45000);
        for (let m = 9; m <= 12; m += 1) { expect(month(b, m).loanTotal).toBe(0); expect(month(b, m).totalExp).toBe(0); }
    });
    it('a loan nobody has marked paid counts nothing, in any month — but is named as due, up to this month', () => {
        const b = books({ loans: [loan()] });
        for (let m = 1; m <= 12; m += 1) expect(month(b, m).loanTotal).toBe(0);
        expect(month(b, 3).loanUnpaid).toBe(45000);
        expect(month(b, 10).loanUnpaid).toBe(45000);          // this month: due, not marked paid
        expect(month(b, 11).loanUnpaid).toBe(0);              // a month that has not come is not "due"
        expect(b.context._wfYearBooks(2026).yrLoanUnpaid).toBe(10 * 45000);
        expect(b.context._wfYearBooks(2026).yrExp).toBe(0);
    });
    it('the amount PAID is what counts, not the schedule; a payment recorded for a month before the loan\'s own schedule still counts', () => {
        const b = books({ loans: [loan({ payments: [paid('2026-03', { amount: 61000 })] })] });
        expect(month(b, 3).loanTotal).toBe(61000);
    });
    it('paid from the bank: counted once through the debit it is tied to — never twice, and not at all through the loan', () => {
        const debit = { id: 'E1', desc: 'LOAN INSTALMENT', amount: 45000, cat: 'Loan Repayment', month: '2026-03', date: '2026-03-05', loanLink: { loanId: 'L1', month: '2026-03' } };
        const b = books({ loans: [loan({ payments: [paid('2026-03', { via: 'bank', expenseId: 'E1' })] })], expenses: [debit] });
        expect(month(b, 3).loanTotal).toBe(0);
        expect(month(b, 3).expTotal).toBe(45000);
        expect(month(b, 3).totalExp).toBe(45000);
        expect(month(b, 3).loanUnpaid).toBe(0);
    });
    it('an unlinked bank debit with the loan not marked paid is the money that left, once — the unpaid loan adds nothing', () => {
        const debit = { id: 'E1', desc: 'CEFTS TRANSFER', amount: 45000, month: '2026-03', date: '2026-03-05' };
        const b = books({ loans: [loan()], expenses: [debit] });
        expect(month(b, 3).totalExp).toBe(45000);
    });
    it('a prepaid installment of a later month is counted in its own month (it is paid)', () => {
        const b = books({ loans: [loan({ payments: [paid('2026-12')] })] });
        expect(month(b, 12).loanTotal).toBe(45000);
    });
});

describe('everything else that goes out follows the same rule', () => {
    const household = () => ({
        ccinstall: [{ id: 'C1', product: 'Laptop', buyer: 'Me', bank: 'Sampath', total: 240000, rate: 0, duration: 12, monthly: 20000, date: '2026-05-05', completed: false }],
        subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1500, cycle: 'monthly', category: 'Entertainment', createdAt: '2026-01-05T00:00:00Z' },
            { id: 'S2', name: 'Domain', amount: 12000, cycle: 'yearly', category: 'Software', createdAt: '2026-03-10T00:00:00Z' }],
        expenses: [{ id: 'RENT', desc: 'House rent', amount: 90000, cat: 'Rent', month: '2026-01', date: '2026-01-01', recurring: true },
            { id: 'PLAN', desc: 'Insurance premium (planned)', amount: 45000, cat: 'Insurance', month: '2026-11', date: '2026-11-10' },
            { id: 'X', desc: 'Groceries', amount: 60000, cat: 'Groceries', month: '2026-09', date: '2026-09-12' }],
        cconetime: [{ id: 'K1', desc: 'KEELLS', bank: 'Sampath', type: 'purchase', amount: 15000, date: '2026-08-20' }, { id: 'K2', desc: 'FUTURE BOOKING', bank: 'Sampath', type: 'purchase', amount: 33000, date: '2026-10-25' }],
        cheques: [{ id: 'Q1', party: 'Landlord', no: '001', amount: 70000, issue: '2026-06-01', release: '2026-06-10', status: 'cleared', type: 'issued' },
            { id: 'Q2', party: 'Supplier', no: '002', amount: 55000, issue: '2026-12-01', release: '2026-12-10', status: 'pending', type: 'issued' }],
        incomeRecv: [{ id: 'I1', name: 'Salary', amount: 800000, month: '2026-08', date: '2026-08-28', received: true }, { id: 'I2', name: 'Salary', amount: 800000, month: '2026-11', date: '2026-11-28', received: true },
            { id: 'I3', name: 'Salary', amount: 800000, month: '2026-10', date: '2026-10-28', received: false }],
    });
    it('card instalments, subscriptions and recurring bills stop at this month', () => {
        const b = books(household());
        expect(month(b, 5).ccTotal).toBe(0);                  // the plan starts the month after its date
        expect(month(b, 6).ccTotal).toBe(20000); expect(month(b, 10).ccTotal).toBe(20000); expect(month(b, 11).ccTotal).toBe(0); expect(month(b, 12).ccTotal).toBe(0);
        expect(month(b, 10).subTotal).toBe(1500); expect(month(b, 11).subTotal).toBe(0);
        expect(month(b, 3).subTotal).toBe(1500 + 12000);      // the yearly one in its anniversary month
        expect(month(b, 10).expTotal).toBe(90000); expect(month(b, 11).expTotal).toBe(0);   // rent in October, nothing in November
    });
    it('a planned expense of a later month, a card charge dated after today and a pending cheque are not spent yet', () => {
        const b = books(household());
        expect(month(b, 11).totalExp).toBe(0);
        expect(month(b, 10).ccotTotal).toBe(0);               // dated 25 October, today is 2 October
        expect(month(b, 8).ccotTotal).toBe(15000);
        expect(month(b, 12).cheTotal).toBe(0);                // pending
        expect(month(b, 6).cheTotal).toBe(70000);             // cleared
    });
    it('income dated in a month that has not come is not received, whatever the row says — and is named, not hidden', () => {
        const b = books(household());
        expect(month(b, 8).income).toBe(800000);
        expect(month(b, 11).income).toBe(0); expect(month(b, 11).incomePending).toBe(800000);
        expect(month(b, 10).income).toBe(0); expect(month(b, 10).incomePending).toBe(800000);   // this month, marked not yet received
    });
    it('scheduled-but-unpaid installments are listed as DUE (this month and before) or SCHEDULED (later), never counted', () => {
        const b = books({ loans: [loan({ payments: [paid('2026-08')] })] });
        expect(month(b, 10).loanDueItems).toEqual([{ name: 'Honda Vezel Loan', bank: 'HNB', amount: 45000, future: false }]);
        expect(month(b, 12).loanDueItems[0]).toMatchObject({ future: true });
        expect(month(b, 8).loanDueItems).toEqual([]);
        expect(month(b, 10).totalExp).toBe(0); expect(month(b, 12).totalExp).toBe(0);
    });
});

describe('what the owner actually paid is what shows', () => {
    it('10 lakh paid of a 13.6 lakh installment: the books say 10 lakh, and say it was short by the rest', () => {
        const b = books({ loans: [loan({ id: 'M', name: 'Mirigama Land', bank: 'Other', monthly: 1363636, amount: 50000000, payments: [paid('2026-08', { amount: 1000000 })] })] });
        const aug = month(b, 8);
        expect(aug.loanTotal).toBe(1000000);
        expect(aug.loanItems[0]).toMatchObject({ amount: 1000000, scheduled: 1363636, short: 363636, paid: true });
        const oct = month(b, 10);
        expect(oct.loanTotal).toBe(0); expect(oct.totalExp).toBe(0);                       // not paid this month: nothing
        expect(oct.loanDueItems[0]).toMatchObject({ name: 'Mirigama Land', amount: 1363636 });
    });
    it('a payment filed from a review or detected from a statement carries only its date: it counts in that month, and several in one month add up', () => {
        const b = books({ loans: [loan({ payments: [{ id: 'auto_1', amount: 30000, date: '2026-05-04', paid: true, auto: true }, { id: 'auto_2', amount: 15000, date: '2026-05-20', paid: true, auto: true }] })] });
        expect(month(b, 5).loanTotal).toBe(45000);
        expect(month(b, 5).loanDueItems).toEqual([]);
        expect(month(b, 6).loanTotal).toBe(0);
    });
    it('paid "from the bank" with the debit already in the expenses but not yet tied: the debit counts it once, the payment adds nothing', () => {
        const debit = { id: 'E1', desc: 'CEFTS/7712/SOMEONE', amount: 1000000, month: '2026-08', date: '2026-08-12' };
        const l = loan({ monthly: 1363636, amount: 50000000, payments: [paid('2026-08', { amount: 1000000, via: 'bank' })] });
        const b = books({ loans: [l], expenses: [debit] });
        expect(month(b, 8).loanTotal).toBe(0); expect(month(b, 8).totalExp).toBe(1000000);
        // "cash / elsewhere" is the owner's word that the bank was not used: both count
        const c = books({ loans: [{ ...l, payments: [paid('2026-08', { amount: 1000000, via: 'other' })] }], expenses: [debit] });
        expect(month(c, 8).totalExp).toBe(2000000);
    });
    it('the Monthly Plan page reads the books, lists what is due apart from what is paid, and its parts add up to its total', () => {
        const fn = html.slice(html.indexOf('function showMonthDetail('), html.indexOf('// ==================== DASHBOARD AUTOMATION'));
        expect(fn).toContain('getMonthlyData(year, month);');
        expect(fn).not.toContain("'plan'");
        expect(fn).toContain('Loans paid');
        expect(fn).toMatch(/Due.*not paid yet/);
        expect(fn).toContain('Cards, subs &amp; cheques');
        expect(fn).toContain('Mark it paid on Bank Loans');
    });
    it('Upcoming Payments leaves out an installment that is already paid', () => {
        const up = html.slice(html.indexOf('function renderUpcoming()'), html.indexOf('function renderRecentActivity()'));
        expect(up).toContain("_wfLinkedLoanMonths()");
        expect(up).toMatch(/p\.month === key && p\.paid/);
    });
});

describe('the Expense Breakdown is Year Expenses, split by what it was spent on', () => {
    it('one household, by hand', () => {
        const b = books({ ...{ loans: [loan({ payments: monthsBetween(2026, 1, 2026, 3).map(k => paid(k)) })], expenses: [{ id: 'X', desc: 'Food', amount: 1000, cat: 'Groceries', month: '2026-02', date: '2026-02-03' }], subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1500, cycle: 'monthly', category: 'Entertainment', createdAt: '2026-01-05T00:00:00Z' }] } });
        const y = b.context._wfYearBooks(2026);
        expect(y.catMap['Loan Repayment']).toBe(135000);
        expect(y.catMap.Groceries).toBe(1000);
        expect(y.catMap.Entertainment).toBe(1500 * 10);
        expect(Object.values(y.catMap).reduce((a, c) => a + c, 0)).toBe(y.yrExp);
        expect(y.yrExp).toBe(135000 + 1000 + 15000);
    });
    it('on 120 random households: the breakdown always adds up to Year Expenses; no month after this one carries anything; each loan installment is counted at most once', () => {
        let seed = 11;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
        const pick = (n) => Math.floor(rnd() * n);
        for (let run = 0; run < 120; run += 1) {
            const loans = Array.from({ length: 1 + pick(3) }, (_, i) => loan({ id: `L${i}`, start: `2025-${p2(1 + pick(12))}-01`, duration: 6 + pick(30), monthly: 10000 * (1 + pick(9)) }));
            const keys = monthsBetween(2025, 1, 2027, 6);
            const expenses = [];
            loans.forEach((l) => {
                l.payments = [];
                keys.forEach((k) => {
                    const r = rnd();
                    if (r < 0.4) l.payments.push(paid(k, { amount: l.monthly + (rnd() < 0.2 ? 5000 : 0), via: rnd() < 0.5 ? 'bank' : 'other' }));
                    if (r < 0.25) expenses.push({ id: `D${l.id}${k}`, desc: 'LOAN', amount: l.monthly, cat: 'Loan Repayment', month: k, date: `${k}-05`, loanLink: { loanId: l.id, month: k }, ...(rnd() < 0.1 ? { recurring: true } : {}) });
                });
            });
            for (let i = 0; i < pick(8); i += 1) { const k = keys[pick(keys.length)]; expenses.push({ id: `X${i}`, desc: 'x', amount: 1000 * (1 + pick(9)), cat: ['Food', 'Fuel', undefined][pick(3)], month: k, date: `${k}-10`, ...(rnd() < 0.15 ? { recurring: true } : {}) }); }
            const b = books({ loans, expenses,
                ccinstall: rnd() < 0.5 ? [{ id: 'C1', product: 'TV', bank: 'B', total: 1, rate: 0, duration: 3 + pick(12), monthly: 5000, date: `2026-${p2(1 + pick(12))}-05`, completed: rnd() < 0.2 }] : [],
                subscriptions: rnd() < 0.5 ? [{ id: 'S', name: 'N', amount: 700, cycle: ['monthly', 'yearly', 'weekly'][pick(3)], category: rnd() < 0.5 ? 'Fun' : undefined, createdAt: `2026-${p2(1 + pick(12))}-09T00:00:00Z` }] : [],
                cconetime: rnd() < 0.5 ? [{ id: 'K', desc: 'K', bank: 'B', amount: 900, date: `2026-${p2(1 + pick(12))}-${p2(1 + pick(28))}`, category: rnd() < 0.5 ? 'Dining' : undefined }] : [],
                cheques: rnd() < 0.5 ? [{ id: 'Q', party: 'P', no: '1', amount: 3000, issue: '2026-02-01', release: `2026-${p2(1 + pick(12))}-10`, status: ['cleared', 'pending', 'bounced'][pick(3)], type: 'issued' }] : [],
                incomeRecv: [{ id: 'I', name: 'S', amount: 5000, month: `2026-${p2(1 + pick(12))}`, date: '2026-01-01', received: rnd() < 0.7 }] });
            const y = b.context._wfYearBooks(2026);
            const sum = Object.values(y.catMap).reduce((a, c) => a + c, 0);
            expect(Math.abs(sum - y.yrExp)).toBeLessThan(0.001);
            // nothing is spent or received in a month that has not come: no card instalment, subscription, expense, card charge or income (a loan only if someone marked it paid, a cheque only if cleared)
            for (let m = 11; m <= 12; m += 1) { const md = month(b, m); expect([md.ccTotal, md.subTotal, md.expTotal, md.ccotTotal, md.income]).toEqual([0, 0, 0, 0, 0]); }
            // each (loan, month) installment is counted at most once: through its debit, or through its payment, never both
            const linked = linkedLoanMonths(expenses, loans);
            let wantLoanTotal = 0;
            loans.forEach((l) => keys.filter(k => k.startsWith('2026-')).forEach((k) => { const p = l.payments.find(x => x.month === k && x.paid); if (p && !linked.has(`${l.id}|${k}`)) wantLoanTotal += p.amount; }));
            const gotLoanTotal = Array.from({ length: 12 }, (_, m) => month(b, m + 1).loanTotal).reduce((a, c) => a + c, 0);
            expect(gotLoanTotal).toBe(wantLoanTotal);
        }
    });
});

describe('the dashboard reads the books from one place', () => {
    it('renderDash takes its months, totals, unpaid note and breakdown from _wfYearBooks, and names the unpaid installments under Year Expenses', () => {
        const dashFn = html.slice(html.indexOf('function renderDash()'), html.indexOf('function renderUpcoming()'));
        expect(dashFn).toContain('_wfYearBooks(year)');
        expect(dashFn).toMatch(/yrLoanUnpaid > 0[\s\S]{0,160}of loan installments due, not marked paid/);
        expect(dashFn).not.toContain('_allExp.filter(e => (e.month || (e.date');   // the breakdown no longer reads the expenses list alone
    });
});
