import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { incomeIn } from '../../wealthflow-reactive.js';
import * as cashflow from '../../wealthflow-cashflow-engine.js';
import advisor, { build } from '../../wealthflow-advisor-facts.js';
import scenarios from '../../wealthflow-advisor-scenarios.js';

// THE REAL PAGE FUNCTIONS OVER A STORE THE TEST CONTROLS, for the Advisor's tests (advisor_facts_test.js, advisor_scenarios_test.js).
// The functions are cut out of index.html by name and run in a vm with a fixed clock, so what is tested is the code the page runs and not a copy of it.

export const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
export function source(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    const from = html.slice(start - 6, start) === 'async ' ? start - 6 : start;
    return html.slice(from, html.indexOf('\n        }', start) + 10);
}
export const TODAY = Date.UTC(2026, 9, 3, 12);          // Saturday 3 October 2026
export class FixedDate extends Date {
    constructor(...a) { if (a.length === 0) super(TODAY); else super(...a); }
    static now() { return TODAY; }
}
export const p2 = (n) => String(n).padStart(2, '0');
export const ym = (y, m) => `${y}-${p2(m)}`;
export const run = (y1, m1, y2, m2) => { const out = []; let y = y1, m = m1; while (y < y2 || (y === y2 && m <= m2)) { out.push(ym(y, m)); m += 1; if (m > 12) { m = 1; y += 1; } } return out; };

const NAMES = ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', '_loanBalanceAfter', 'loanEndDate', 'getLoanMonthlyForDate', 'getCCIMonthlyForDate', '_wfLinkedLoanMonths', '_wfFindLoanDebit',
    '_wfMonthIsFuture', 'getMonthlyData', '_wfMonthSpent', '_wfMonthStarted', '_wfBooksKey', '_wfBooksProfileCompute', '_wfBooksProfile', '_wfLoanEmiNow', '_wfPositionCompute', '_wfPosition', '_wfFreeCash', 'loanCurrentBalance', 'cciProgress', 'buildFinancialContext'];
const SOURCES = NAMES.map(source).join('\n');
export const EMPTY = () => ({ loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [], income: [], targets: [], balance: { total: 0, flows: [] } });

/** The real page functions over a store the test controls. `withModule: false` is a page where wealthflow-advisor-facts.js did not load. */
export function page(data = {}, { withModule = true } = {}) {
    const store = { ...EMPTY(), ...data };
    const ctx = {
        DB: { get: (k) => store[k] || [], getObj: (k, d) => store[k] || d },
        p2, Date: FixedDate, Math, Number, Object, Array, String, JSON, Map, Set, Infinity, NaN, isNaN, parseFloat, parseInt, console,
        MONTHS_S: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        $: () => null, _wfEsc: (t) => String(t), currentUser: { displayName: 'Owner' }, appData: store,
    };
    ctx.window = ctx; ctx.WFReactive = { incomeIn }; ctx.WFCashflow = cashflow; ctx.WFInsights = null;
    if (withModule) { ctx.WFAdvisorFacts = advisor; ctx.WFAdvisorScenarios = scenarios; }
    vm.createContext(ctx);
    vm.runInContext('var _wfBooksMemo = null;', ctx);
    vm.runInContext(SOURCES, ctx);
    return { ctx, store };
}

/** The owner from the bug report: LKR 285,000 salary from March, five spending lines, rent, a car loan paid since June, Netflix, one goal. */
export function household() {
    const d = EMPTY();
    d.income = [{ id: 'i1', name: 'FD interest', monthly: 18000, start: '2025-01-01' }];
    for (const k of run(2026, 3, 2026, 10)) d.incomeRecv.push({ id: `sal${k}`, name: 'Salary', type: 'Salary', amount: 285000, month: k, date: `${k}-28`, received: true, source: 'statement' });
    const cats = [['Food & Groceries', 62000], ['Transport', 24000], ['Utilities', 18000], ['Dining', 21000], ['Shopping', 33000]];
    for (let m = 3; m <= 10; m++) cats.forEach(([c, a], i) => d.expenses.push({ id: `e${m}${i}`, desc: `${c} spend`, cat: c, amount: a + (m % 3) * 2500, month: ym(2026, m), date: `${ym(2026, m)}-12`, source: 'statement' }));
    d.expenses.push({ id: 'rent', desc: 'Rent', cat: 'Housing', amount: 75000, month: '2026-03', recurring: true, source: 'manual' });
    d.loans.push({ id: 'L1', name: 'Honda Vezel Loan', bank: 'HNB', start: '2025-06-01', duration: 60, monthly: 62000, amount: 2800000, rate: 11, payDay: 5, payments: run(2026, 6, 2026, 9).map((k) => ({ month: k, paid: true, amount: 62000, via: 'other', paidAt: 1 })) });
    d.subscriptions.push({ id: 's1', name: 'Netflix', amount: 3200, cycle: 'monthly', createdAt: '2025-01-01' });
    d.targets.push({ id: 't1', name: 'Emergency fund', amount: 900000, start: '2026-01-01', end: '2027-01-01', savings: [{ amount: 250000, date: '2026-06-01' }] });
    d.balance = { total: 640000, flows: [] };
    return d;
}
/** The fact sheet exactly as the page builds it. */
export function factsOf(ctx) { return build(advisor.pageDeps(ctx)); }

/** The real page functions AND the real prompt builder (wealthflow-ai-v6.js) in one context, as in the browser. `history` is what getAIHistory() returns. */
export function advisorPage(history = [], data = household()) {
    const { ctx, store } = page(data);
    Object.assign(ctx, {
        console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval() {}, clearTimeout() {},
        localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null, querySelector: () => null }, navigator: { language: 'en' },
        getAIHistory: () => history,
    });
    vm.runInContext(readFileSync(new URL('../../wealthflow-ai-v6.js', import.meta.url), 'utf8'), ctx);
    ctx.__store = store;
    return ctx;
}
