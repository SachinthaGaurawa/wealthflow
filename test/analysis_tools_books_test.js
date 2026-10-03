import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { incomeIn } from '../wealthflow-reactive.js';
import { openingBalance } from '../wealthflow-cashflow-engine.js';

// THE FIVE ANALYSIS TOOLS READ THE OWNER'S BOOKS. DSCR, the WealthFlow Score, the Debt Demolisher, the Wealth Simulator, the 3D Cash Flow (and the AI advisor's context) took "income" from the Investments list and
// "expenses" from this month's hand-typed entries only: the salary the statements and the Income page hold, every card charge, subscription, cheque and installment never reached them. Run against the real functions with a
// fixed clock (2 Oct 2026): twelve complete months before the current one are the basis.
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
const run = (y1, m1, y2, m2) => { const out = []; let y = y1, m = m1; while (y < y2 || (y === y2 && m <= m2)) { out.push(ym(y, m)); m += 1; if (m > 12) { m = 1; y += 1; } } return out; };

const NAMES = ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', '_loanBalanceAfter', 'loanEndDate', 'getLoanMonthlyForDate', 'getCCIMonthlyForDate', '_wfLinkedLoanMonths', '_wfFindLoanDebit',
    '_wfMonthIsFuture', 'getMonthlyData', '_wfMonthSpent', '_wfMonthStarted', '_wfBooksKey', '_wfBooksProfileCompute', '_wfBooksProfile', '_wfLoanEmiNow', '_wfPositionCompute', '_wfPosition', '_wfFreeCash', '_wfBasisLine', 'loanCurrentBalance', 'cciProgress', 'calculateWFScore', 'get12MonthAverages', '_cf3dPeriodKey',
    '_cf3dGatherFlows', 'calcEMI', '_amortizeStrategy', '_normalRand', '_mcSeeded', '_mcSeedOf', '_mcSimulate', 'buildFinancialContext'];
const SOURCES = NAMES.map(source).join('\n');
const EMPTY = () => ({ loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [], income: [], targets: [], balance: { total: 0, flows: [] } });
const shared = (() => {
    const holder = { store: EMPTY() };
    const context = vm.createContext({
        DB: { get: key => holder.store[key] || [], getObj: (key, fallback) => holder.store[key] || fallback, set: (key, value) => { holder.store[key] = value; } },
        p2, Date: FixedDate, Math, Number, Object, Array, String, JSON, Map, Set, Infinity, NaN, isNaN, parseFloat, parseInt, console,
        MONTHS_S: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        $: () => null, _wfEsc: text => String(text), currentUser: { displayName: 'Owner' },
        window: { WFReactive: { incomeIn }, WFCashflow: { openingBalance } },
    });
    vm.runInContext('var _wfBooksMemo = null;', context);        // the page keeps the profile in a variable beside the functions
    vm.runInContext(SOURCES, context);
    return { holder, context };
})();
function household(data = {}) {
    shared.holder.store = { ...EMPTY(), ...data };
    return shared.context;
}
const salary = (key, amount = 800000, extra = {}) => ({ id: `I${key}${extra.type || ''}`, type: 'Salary', name: 'Salary', amount, month: key, date: `${key}-28`, received: true, ...extra });
const spend = (key, amount, extra = {}) => ({ id: `X${key}${amount}${extra.cat || ''}`, desc: 'Groceries', amount, cat: 'Groceries', month: key, date: `${key}-12`, ...extra });
const loan = (extra = {}) => ({ id: 'L1', name: 'Honda Loan', bank: 'HNB', start: '2025-01-01', duration: 60, monthly: 100000, amount: 5000000, rate: 0, payments: [], ...extra });
const paid = (month, amount = 100000, extra = {}) => ({ month, paid: true, amount, via: 'other', paidAt: 1, ...extra });
const LAST12 = run(2025, 10, 2026, 9);

describe('a typical month comes from the books, not from the Investments list', () => {
    it('income is what was received on the Income page / statements, averaged over the complete months that have income', () => {
        const c = household({ incomeRecv: run(2026, 1, 2026, 8).map(k => salary(k)), income: [{ id: 'inv', name: 'FD', monthly: 5000, start: '2025-01-01' }] });
        const p = c._wfBooksProfile(new Date());
        expect(p.avgIncome).toBe(800000);                                  // not the 5,000 an investment is expected to pay
        expect(p.basis).toMatchObject({ kind: 'average', incomeMonths: 8, from: '2026-01', to: '2026-08' });
    });
    it('the month in progress is not a month: this month\'s rows change nothing', () => {
        const c = household({ incomeRecv: [...run(2026, 1, 2026, 8).map(k => salary(k)), salary('2026-10', 1)], expenses: [spend('2026-10', 999999)] });
        const p = c._wfBooksProfile(new Date());
        expect(p.avgIncome).toBe(800000);
        expect(p.avgOutgo).toBe(0);
        expect(p.thisMonth).toMatchObject({ key: '2026-10', outgo: 999999 });
    });
    it('money that has not arrived is not income', () => {
        const c = household({ incomeRecv: [salary('2026-08'), salary('2026-09', 800000, { received: false })] });
        expect(c._wfBooksProfile(new Date()).avgIncome).toBe(800000);
        expect(c._wfBooksProfile(new Date()).basis.incomeMonths).toBe(1);
    });
    it('a month whose statement has not arrived does not drag the other side down: income and outgoings are averaged over their own months', () => {
        const c = household({ incomeRecv: [salary('2026-06'), salary('2026-07'), salary('2026-08')], expenses: [spend('2026-07', 60000), spend('2026-08', 80000)] });
        const p = c._wfBooksProfile(new Date());
        expect(p.avgIncome).toBe(800000);
        expect(p.avgOutgo).toBe(70000);
        expect(p.basis).toMatchObject({ incomeMonths: 3, outgoMonths: 2 });
    });
    it('with no complete month at all, this month so far is used and says so; with nothing, it says that', () => {
        const c = household({ incomeRecv: [salary('2026-10')], expenses: [spend('2026-10', 5000)] });
        const p = c._wfBooksProfile(new Date());
        expect(p).toMatchObject({ avgIncome: 800000, avgOutgo: 5000, basis: { kind: 'this-month' } });
        expect(c._wfBasisLine(p)).toMatch(/this month so far/i);
        const none = household()._wfBooksProfile(new Date());
        expect(none.basis.kind).toBe('none');
        expect(household()._wfBasisLine(none)).toMatch(/No income or spending is recorded/);
    });
    it('each kind of income that arrived is a stream (Salary, Rental…)', () => {
        const c = household({ incomeRecv: [salary('2026-08'), salary('2026-09'), salary('2026-08', 120000, { type: 'Rental' })] });
        const p = c._wfBooksProfile(new Date());
        expect(Object.keys(p.incomeTypes).sort()).toEqual(['Rental', 'Salary']);
        expect(p.incomeTypes.Salary).toBe(800000);
    });
});

describe('debt service is kept apart from living costs, so nothing is taken off the income twice', () => {
    const month = '2026-08';
    it('loan installments (paid, or paid from the bank and tied to a debit) and card installment plans are debt service; the rest is living', () => {
        const c = household({
            incomeRecv: [salary(month)],
            loans: [loan({ payments: [paid(month)] })],
            expenses: [spend(month, 60000), spend(month, 45000, { cat: 'Loan Repayment', desc: 'LOAN INSTALMENT NTB', loanLink: { loanId: 'L2', month } })],
            ccinstall: [{ id: 'C1', product: 'Laptop', bank: 'Sampath', total: 240000, rate: 0, duration: 12, monthly: 20000, date: '2026-05-05', completed: false }],
            subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1500, cycle: 'monthly', category: 'Entertainment', createdAt: '2026-01-05T00:00:00Z' }],
        });
        const d = c.getMonthlyData(2026, 7);
        expect(d.totalExp).toBe(100000 + 60000 + 45000 + 20000 + 1500);
        expect(d.debtService).toBe(100000 + 45000 + 20000);
        expect(d.living).toBe(60000 + 1500);
        expect(d.debtService + d.living).toBe(d.totalExp);
    });
    it('DSCR\'s starting figures: income, and living costs WITHOUT the installments the form lists below', () => {
        const c = household({ incomeRecv: [salary(month)], loans: [loan({ payments: [paid(month)] })], expenses: [spend(month, 60000)] });
        const a = c.get12MonthAverages();
        expect(a.avgInc).toBe(800000);
        expect(a.avgOpex).toBe(60000);                                     // the 100,000 installment is the debt service, not an operating expense
        expect(a.basis).toMatch(/From your books/);
    });
});

describe('what is really left each month', () => {
    it('is the income less living costs less what the debts ask — the larger of what was paid and what is scheduled, never both', () => {
        const c = household({ incomeRecv: [salary('2026-08')], expenses: [spend('2026-08', 100000)], loans: [loan({ payments: [paid('2026-08')] })] });
        const p = c._wfBooksProfile(new Date()), pos = c._wfPosition(new Date());
        expect(pos.minimums).toBe(100000);
        expect(c._wfFreeCash(p, pos)).toBe(800000 - 100000 - 100000);
    });
    it('an installment nobody has paid is still owed: it is not free money', () => {
        const c = household({ incomeRecv: [salary('2026-08')], expenses: [spend('2026-08', 100000)], loans: [loan()] });     // scheduled 100,000, paid nothing
        const p = c._wfBooksProfile(new Date()), pos = c._wfPosition(new Date());
        expect(p.avgDebtService).toBe(0);
        expect(c._wfFreeCash(p, pos)).toBe(800000 - 100000 - 100000);
    });
    it('a reducing-balance loan asks what its schedule works out for this month, not its first payment', () => {
        const reducing = loan({ id: 'R1', amount: 1200000, duration: 12, start: '2026-01-01', rate: 12, monthly: 120000, paymentMethod: 'reducing', payments: [] });
        const c = household({ loans: [reducing] });
        const emi = c._wfLoanEmiNow(reducing, new Date());
        expect(emi).toBeCloseTo(103000, 0);                                // October is the 10th month: 100,000 of principal and 1% on the 300,000 the schedule has left
        expect(c._wfPosition(new Date()).minimums).toBe(emi);
        expect(c._wfLoanEmiNow(loan({ monthly: 55555 }), new Date())).toBe(55555);       // an EMI loan: the monthly figure
    });
    it('what the debts ask is the loans still running and the card plans with months left', () => {
        const done = loan({ id: 'old', start: '2020-01-01', duration: 12, monthly: 77777 });
        const plan = { id: 'C1', product: 'Laptop', bank: 'Sampath', total: 240000, rate: 0, duration: 12, monthly: 20000, date: '2026-05-05', completed: false };
        expect(household({ loans: [loan(), done], ccinstall: [plan] })._wfPosition(new Date()).minimums).toBe(120000);
    });
});

describe('the WealthFlow Score is made of the books', () => {
    const owner = (extra = {}) => household({ incomeRecv: LAST12.map(k => salary(k)), expenses: LAST12.map(k => spend(k, 200000)), balance: { total: 1200000, flows: [] }, ...extra });
    it('a household with a salary and no Investments list is not scored as if it earned nothing', () => {
        const s = owner().calculateWFScore();
        expect(s.dscr.value).toBe(3);                                      // no debt: the best case
        expect(s.dscr.score).toBe(200);
        expect(s.savings.value).toBeCloseTo(0.75, 5);                      // 600,000 of 800,000 is not spent
        expect(s.liquidity.value).toBeCloseTo(6, 5);                       // 1.2M over 200,000 a month
        expect(s.discipline.score).toBe(110);                              // income and spending recorded in each of the last three months
        expect(s.total).toBeGreaterThan(600);
        expect(s.basis).toMatch(/From your books/);
    });
    it('the coverage ratio divides what is left after LIVING by the debt service — the installments are not in the living costs', () => {
        const s = owner({ loans: [loan({ payments: LAST12.map(k => paid(k)) })] }).calculateWFScore();
        expect(s.dscr.value).toBeCloseTo((800000 - 200000) / 100000, 5);
    });
    it('debt-to-income counts what is still owed: loans, what is left of card plans, and card charges not yet paid', () => {
        const c = owner({ loans: [loan({ amount: 1200000, duration: 12, start: '2026-01-01', monthly: 100000, payments: [] })], cconetime: [{ id: 'K', desc: 'KEELLS', amount: 50000, combinedTotal: 50000, date: '2026-09-01', paid: false }] });
        const pos = c._wfPosition(new Date());
        expect(pos.cardOwed).toBe(50000);
        expect(pos.loansLeft).toBeGreaterThan(0);
        expect(c.calculateWFScore().dti.value).toBeCloseTo(pos.debt / (800000 * 12), 5);
    });
    it('tracking discipline is how many of the last three complete months have both income and spending', () => {
        const c = household({ incomeRecv: ['2026-08', '2026-09'].map(k => salary(k)), expenses: ['2026-07', '2026-08', '2026-09'].map(k => spend(k, 1000)) });
        expect(c.calculateWFScore().discipline.value).toBeCloseTo(2 / 3, 5);
    });
    it('diversification counts the kinds of income that arrived', () => {
        const one = household({ incomeRecv: [salary('2026-09')] }).calculateWFScore();
        const two = household({ incomeRecv: [salary('2026-09'), salary('2026-09', 100000, { type: 'Rental' })] }).calculateWFScore();
        expect(one.diversification.value).toBe(1);
        expect(two.diversification.value).toBe(2);
        expect(two.diversification.score).toBeGreaterThan(one.diversification.score);
    });
    it('the Investments list is only the last resort for a household whose only income record is there', () => {
        const s = household({ income: [{ id: 'i1', name: 'Rent', monthly: 100000, start: '2025-01-01' }], expenses: [spend('2026-09', 20000)] }).calculateWFScore();
        expect(s.savings.value).toBeCloseTo(0.8, 5);
        expect(household({ income: [{ id: 'i1', name: 'FD', monthly: 5000 }] }).calculateWFScore().total).toBeGreaterThanOrEqual(0);   // a source with no start date does not break it
    });
    it('an empty household has nothing to score, and scores without a NaN anywhere', () => {
        const s = household().calculateWFScore();
        expect(s.hasData).toBe(false);
        expect(owner().calculateWFScore().hasData).toBe(true);
        for (const f of Object.values(s)) if (f && typeof f === 'object') { expect(Number.isFinite(f.score)).toBe(true); expect(Number.isFinite(f.value)).toBe(true); }
        expect(Number.isFinite(s.total)).toBe(true);
    });
});

describe('the advisor\'s context, which the Debt Demolisher and the Wealth Simulator start from', () => {
    it('income, living costs, free cash and categories are the books\' (the category field is `cat`, which it used to misread as `category`)', () => {
        const c = household({ incomeRecv: ['2026-07', '2026-08', '2026-09'].map(k => salary(k)), expenses: ['2026-07', '2026-08', '2026-09'].map(k => spend(k, 90000)), loans: [loan({ payments: ['2026-07', '2026-08', '2026-09'].map(k => paid(k)) })], balance: { total: 500000, flows: [{ type: 'out', amount: 100000 }, { type: 'in', amount: 40000 }] } });
        const x = c.buildFinancialContext();
        expect(x.totalMonthlyIncome).toBe(800000);
        expect(x.avgMonthlyExpenses).toBe(90000);
        expect(x.avgMonthlyOutgo).toBe(190000);
        expect(x.netMonthlyCashFlow).toBe(800000 - 90000 - 100000);
        expect(x.expenseByCategory).toMatchObject({ Groceries: 90000 });
        expect(x.balanceOnHand).toBe(440000);                              // the total, less what went out, plus what came in — as the Balance page shows it
        expect(x.incomeDetails).toMatch(/Salary: LKR 800,000/);
    });
});

describe('the 3D Cash Flow holds every rupee the books hold', () => {
    it('card charges, subscriptions, cleared cheques and loan installments paid from the bank are in the outflow, each in its group', () => {
        const k = '2026-08';
        const c = household({
            incomeRecv: [salary(k)],
            loans: [loan({ payments: [paid(k)] })],
            expenses: [spend(k, 60000), spend(k, 45000, { cat: 'Loan Repayment', desc: 'LOAN INSTALMENT', loanLink: { loanId: 'L2', month: k } })],
            ccinstall: [{ id: 'C1', product: 'Laptop', bank: 'Sampath', total: 240000, rate: 0, duration: 12, monthly: 20000, date: '2026-05-05', completed: false }],
            cconetime: [{ id: 'K1', desc: 'KEELLS', bank: 'Sampath', type: 'purchase', amount: 15000, category: 'Groceries', date: '2026-08-20', paid: false }],
            subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1500, cycle: 'monthly', category: 'Entertainment', createdAt: '2026-01-05T00:00:00Z' }],
            cheques: [{ id: 'Q1', party: 'Landlord', no: '001', amount: 70000, issue: '2026-08-01', release: '2026-08-10', status: 'cleared', type: 'issued' }],
        });
        // the "last three months" window of the fixed clock is August, September and October: the salary, the cheque and the bank-paid installment are August's; the subscription and the card plan run in all three
        c.$ = id => (id === 'cf3dPeriod' ? { value: 'last3' } : null);
        const flows = c._cf3dGatherFlows();
        expect(flows.groups).toMatchObject({ Income: 800000, Loans: 145000, CC: 3 * 20000 + 15000, Expenses: 60000, Bills: 3 * 1500, Cheques: 70000, Targets: 0 });
        const total = flows.groups.Loans + flows.groups.CC + flows.groups.Expenses + flows.groups.Bills + flows.groups.Cheques;
        const books = [7, 8, 9].reduce((a, m) => a + c.getMonthlyData(2026, m).totalExp, 0);
        expect(total).toBe(books);                                         // the picture and the Monthly Plan agree to the rupee
        expect(flows.expByCat['Loan Repayment']).toBeUndefined();          // repaying debt is not "where the spending went"
        expect(Object.values(flows.expByCat).reduce((a, v) => a + v, 0)).toBe(60000 + 15000 + 3 * 1500 + 70000);
    });
    it('income by kind counts only what has arrived', () => {
        const c = household({ incomeRecv: [salary('2026-09'), salary('2026-09', 50000, { type: 'Rental', received: false })] });
        c.$ = id => (id === 'cf3dPeriod' ? { value: 'last3' } : null);
        expect(c._cf3dGatherFlows().incomeSources).toEqual([{ name: 'Salary', amount: 800000 }]);
    });
});

describe('installments and the payoff plan', () => {
    it('an empty form has no installment: 0 over 0 months is 0, not NaN (every ratio built on it was NaN)', () => {
        const c = household();
        expect(c.calcEMI(0, 0, 0)).toBe(0);
        expect(c.calcEMI(100000, 0, 0)).toBe(0);
        expect(c.calcEMI(120000, 0, 12)).toBe(10000);
        expect(c.calcEMI(100000, 12, 12)).toBeCloseTo(8884.88, 1);
    });
    it('"minimums only" means each debt runs its own schedule: a freed-up minimum is not rolled onto another debt in the baseline', () => {
        const c = household();
        const debts = [{ id: 'a', name: 'A', rate: 0, amount: 12000, monthly: 1000 }, { id: 'b', name: 'B', rate: 0, amount: 60000, monthly: 1000 }];
        const alone = c._amortizeStrategy(debts, 0, 'avalanche', false);
        const rolled = c._amortizeStrategy(debts, 0, 'avalanche');
        expect(alone.months).toBe(60);                                     // B takes its own 60 months
        expect(rolled.months).toBeLessThan(alone.months);                  // A's freed 1,000 goes to B
        expect(alone.perLoan.find(l => l.id === 'a').months).toBe(12);
    });
});

describe('the Wealth Simulator is reproducible and keeps the savings\' buying power', () => {
    const args = { years: 10, savings: 50000, expectedReturn: 0.12, inflation: 0.07, runs: 300, startBal: 1000000 };
    it('the same inputs give the same answer, every time', () => {
        const c = household();
        const seed = c._mcSeedOf([10, 50000, 0.12, 0.07, 300, 1000000]);
        const a = c._mcSimulate(args, c._mcSeeded(seed)), b = c._mcSimulate(args, c._mcSeeded(seed));
        expect(a.medianCase).toBe(b.medianCase);
        expect(a.pct.p50).toEqual(b.pct.p50);
        expect(c._mcSeedOf([1, 2])).toBe(c._mcSeedOf([1, 2]));
        expect(c._mcSeedOf([1, 2])).not.toBe(c._mcSeedOf([1, 3]));
    });
    it('what is put in rises with prices (it used to fall), and the figure in today\'s money is the nominal one deflated', () => {
        const c = household();
        const sim = c._mcSimulate({ ...args, startBal: 0, expectedReturn: 0, runs: 100 }, c._mcSeeded(7));
        let expected = 0, step = 50000; for (let m = 0; m < 120; m++) { expected += step; step *= 1 + 0.07 / 12; }
        expect(sim.putIn).toBeCloseTo(expected, 2);
        expect(sim.putIn).toBeGreaterThan(50000 * 120);                    // more than flat savings
        expect(sim.deflator).toBeCloseTo(Math.pow(1.07, 10), 10);
    });
    it('with no savings and no growth the wealth stays where it started (a path never invents money)', () => {
        const c = household();
        const sim = c._mcSimulate({ ...args, savings: 0, expectedReturn: 0, runs: 200 }, c._mcSeeded(3));
        expect(sim.pct.p50[0]).toBe(1000000);
        expect(sim.finalVals.every(v => v >= 0)).toBe(true);
        expect(Number(sim.probLoss)).toBeGreaterThan(30);                  // ending below what was put in is about as likely as not with zero drift
    });
});


describe('a month counts only when something real happened in it', () => {
    const sub = { id: 'S1', name: 'Netflix', amount: 1500, cycle: 'monthly', category: 'Entertainment', createdAt: '2025-01-05T00:00:00Z' };
    const plan = { id: 'C1', product: 'Laptop', bank: 'Sampath', total: 240000, rate: 0, duration: 36, monthly: 20000, date: '2025-01-05', completed: false };
    it('what is merely scheduled (a subscription, a card plan, a recurring bill) does not start a month', () => {
        const c = household({ subscriptions: [sub], ccinstall: [plan], expenses: [spend('2026-07', 5000, { recurring: true })] });
        expect(c._wfMonthStarted(c.getMonthlyData(2026, 7))).toBe(false);
    });
    it('income received, a dated entry, a card charge, a paid installment or a cleared cheque does', () => {
        const day = (data) => { const c = household(data); return c._wfMonthStarted(c.getMonthlyData(2026, 7)); };
        expect(day({ incomeRecv: [salary('2026-08')] })).toBe(true);
        expect(day({ expenses: [spend('2026-08', 800)] })).toBe(true);
        expect(day({ cconetime: [{ id: 'K', desc: 'KEELLS', amount: 900, combinedTotal: 900, date: '2026-08-04', paid: false }] })).toBe(true);
        expect(day({ loans: [loan({ payments: [paid('2026-08')] })] })).toBe(true);
        expect(day({ cheques: [{ id: 'Q', party: 'P', no: '1', amount: 5000, issue: '2026-08-01', release: '2026-08-02', status: 'cleared', type: 'issued' }] })).toBe(true);
    });
    it('months before the first record are not averaged in as months of spending, however old the subscription or plan', () => {
        const c = household({ subscriptions: [sub], ccinstall: [plan], incomeRecv: [salary('2026-08'), salary('2026-09')], expenses: [spend('2026-08', 100000), spend('2026-09', 100000)] });
        const p = c._wfBooksProfile(new Date());
        expect(p.basis.outgoMonths).toBe(2);                               // August and September, not the nineteen months of schedule before them
        expect(p.avgOutgo).toBe(100000 + 1500 + 20000);
    });
});

describe('the 3D picture shows the latest month that has anything, and says so', () => {
    const view = (data, period) => { const c = household(data); c.$ = id => (id === 'cf3dPeriod' ? { value: period } : null); return c._cf3dGatherFlows(); };
    it('"This Month" on the 2nd, before any statement of the month: the latest month with data is shown, named, with its income', () => {
        const f = view({ incomeRecv: [salary('2026-09')], expenses: [spend('2026-09', 60000)] }, 'thisMonth');
        expect(f.windowLabel).toBe('Sep 2026');
        expect(f.note).toMatch(/Oct has nothing recorded yet — showing Sep 2026/);
        expect(f.groups).toMatchObject({ Income: 800000, Expenses: 60000 });
        expect(f.incomeSources).toEqual([{ name: 'Salary', amount: 800000 }]);
    });
    it('a month holding only a subscription and a card plan is still "nothing yet"', () => {
        const f = view({ incomeRecv: [salary('2026-09')], subscriptions: [{ id: 'S', name: 'Netflix', amount: 1500, cycle: 'monthly', createdAt: '2026-01-05T00:00:00Z' }] }, 'thisMonth');
        expect(f.windowLabel).toBe('Sep 2026');
        expect(f.groups.Income).toBe(800000);
    });
    it('a month with real data is shown as it is, with no note', () => {
        const f = view({ incomeRecv: [salary('2026-10')], expenses: [spend('2026-10', 1000)] }, 'thisMonth');
        expect(f).toMatchObject({ windowLabel: 'Oct 2026', note: '' });
    });
    it('"Last Month", "Last 3 Months" and a household with nothing at all', () => {
        const books = { incomeRecv: [salary('2026-09')], expenses: [spend('2026-09', 5000)] };
        expect(view(books, 'lastMonth')).toMatchObject({ windowLabel: 'Sep 2026', note: '', groups: { Income: 800000 } });
        expect(view(books, 'last3')).toMatchObject({ windowLabel: 'Aug 2026 – Oct 2026', months: 3 });
        const none = view({}, 'thisMonth');
        expect(none.note).toMatch(/Nothing is recorded yet/);
        expect(Object.values(none.groups).every(v => v === 0)).toBe(true);
    });
});


describe('the profile is remembered until the books change', () => {
    it('the same books give the same object without recomputing; an edit, a new record or a paid installment gives a new one', () => {
        const c = household({ incomeRecv: [salary('2026-09')], expenses: [spend('2026-09', 1000)] });
        const a = c._wfBooksProfile(new Date());
        expect(c._wfBooksProfile(new Date())).toBe(a);
        c.DB.set('expenses', [spend('2026-09', 1000), spend('2026-09', 2000)]);
        const b = c._wfBooksProfile(new Date());
        expect(b).not.toBe(a);
        expect(b.avgOutgo).toBe(3000);
        c.DB.set('loans', [loan({ payments: [paid('2026-09')] })]);
        expect(c._wfBooksProfile(new Date()).avgOutgo).toBe(103000);
        c.DB.set('loans', [loan({ payments: [paid('2026-09', 250000)] })]);
        expect(c._wfBooksProfile(new Date()).avgOutgo).toBe(253000);
    });
    it('the position follows the same rule (a balance typed, a card charge paid)', () => {
        const c = household({ balance: { total: 100, flows: [] }, cconetime: [{ id: 'K', desc: 'KEELLS', amount: 900, combinedTotal: 900, date: '2026-09-04', paid: false }] });
        expect(c._wfPosition(new Date())).toMatchObject({ cash: 100, cardOwed: 900 });
        c.DB.set('balance', { total: 500, flows: [] });
        c.DB.set('cconetime', [{ id: 'K', desc: 'KEELLS', amount: 900, combinedTotal: 900, date: '2026-09-04', paid: true }]);
        expect(c._wfPosition(new Date())).toMatchObject({ cash: 500, cardOwed: 0 });
    });
});
