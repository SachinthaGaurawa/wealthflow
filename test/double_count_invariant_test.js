import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { incomeIn } from '../wealthflow-reactive.js';
import { settleStatement } from '../statement-ledger.mjs';
import { healLoanLinks } from '../loan-link.mjs';
import { healHandMadeTwins } from '../statement-sync.js';
import { createFirestore } from './helpers/fake-firestore.js';

// THE OWNER'S RULE: no payment and no receipt is ever counted twice, whichever way it reached the books. One real payment can be in the books as a statement row, as an entry the owner typed,
// as a tracked subscription, a loan's schedule, an issued cheque, a card installment plan, the bank paying the card, or as the same statement read twice. This builds households of such
// payments, runs the statement worker and the loan heal on them, adds the month up with the screens' own function (getMonthlyData) and checks that every real payment counted once.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    const from = html.slice(start - 6, start) === 'async ' ? start - 6 : start;
    return html.slice(from, html.indexOf('\n        }', start) + 10);
}
function screens(user) {
    const store = { loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [], ...user };
    const context = vm.createContext({ DB: { get: key => store[key] || [], set: () => {} }, p2: n => String(n).padStart(2, '0'), window: { WFReactive: { incomeIn } }, notify: () => {}, Date });
    for (const name of ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', 'loanEndDate', 'getLoanMonthlyForDate', 'getCCIMonthlyForDate', '_wfLinkedLoanMonths', 'getMonthlyData']) vm.runInContext(source(name), context);
    return context;
}
function fakeDb(initial) {
    const docs = new Map(Object.entries(initial));
    const collection = path => ({ doc: id => ref(path + '/' + id), where: (field, op, value) => ({ query: true, path, field, value }) });
    const ref = path => ({ path, id: path.split('/').at(-1), collection: name => collection(path + '/' + name) });
    return { docs, collection, doc: ref, async runTransaction(fn) {
        const pending = []; let writing = false;
        const result = await fn({
            async get(r) { if (writing) throw new Error('read-after-write'); if (r.query) return { docs: [...docs.entries()].filter(([path, data]) => path.startsWith(r.path + '/') && data[r.field] === r.value).map(([path, data]) => ({ id: path.split('/').at(-1), data: () => structuredClone(data) })) }; return { exists: docs.has(r.path), data: () => structuredClone(docs.get(r.path)) }; },
            set(r, value, opts) { writing = true; pending.push([r.path, structuredClone(value), opts]); },
        });
        for (const [path, value, opts] of pending) docs.set(path, opts?.merge ? { ...docs.get(path), ...value } : value);
        return result;
    } };
}
const row = (description, amount, date, direction = 'debit', extra = {}) => ({ date, amount, description, direction, directionSource: 'balance', needsReview: false, valid: true, ...extra });
const expense = (decision = {}) => ({ module: 'expenses', category: 'Other', verified: true, ...decision });
const income = { module: 'incomeRecv', category: 'Salary', verified: true };
/** One statement of rows through the worker, then the periodic loan heal; returns the user document. */
async function file(user, rows, { bank = 'HNB', last4 = '1111', path = 'sources/s', cardRegistry = {}, statementType = 'bank_account', decision = null } = {}) {
    const db = fakeDb({ 'users/u': structuredClone(user), [path]: { uid: 'u', cursor: 0, leaseToken: 'token', leaseUntil: 9000, encrypted: 'x' } });
    if (rows.length) await settleStatement({ db, uid: 'u', sourceRef: db.collection(path.split('/')[0]).doc(path.split('/')[1]), leaseToken: 'token', now: 1000, rows, decisions: rows.map(r => decision || (r.direction === 'credit' ? income : expense())), cursor: 0, totalRows: rows.length, bank, last4, statementType, cardRegistry });
    const after = db.docs.get('users/u');
    healLoanLinks(after, 2000);
    return after;
}
const march = ctx => ctx.getMonthlyData(2026, 2);
/** The periodic pass that reconciles what the owner typed after the statement filed it. */
async function reconcile(user) {
    const w = createFirestore({ 'users/u': structuredClone(user) });
    await healHandMadeTwins({ db: w.db, uid: 'u', log: () => {} });
    return w.data.get('users/u');
}

describe('the plain cases', () => {
    it('a bank row alone counts once; typed by hand and then on the statement it counts once', async () => {
        const alone = await file({}, [row('KEELLS SUPER COLOMBO', 4200, '2026-03-05')]);
        expect(march(screens(alone)).totalExp).toBe(4200);
        const typed = { expenses: [{ id: 'm1', desc: 'Keells', amount: 4200, date: '2026-03-05', month: '2026-03', cat: 'Food' }] };
        const both = await file(typed, [row('KEELLS SUPER COLOMBO', 4200, '2026-03-05')]);
        expect(march(screens(both)).totalExp).toBe(4200);
    });
});

const loan = (extra = {}) => ({ id: 'L1', name: 'Honda Vezel Loan', bank: 'HNB', start: '2026-01-01', duration: 12, monthly: 45000, amount: 500000, rate: 0, payments: [], payDay: 5, ...extra });
const manual = (id, desc, amount, date, extra = {}) => ({ id, desc, amount, date, month: date.slice(0, 7), cat: 'Other', ...extra });
const totalOf = async (user, rows, options) => { const after = await file(user, rows, options); return { total: march(screens(after)).totalExp, after }; };

describe('one real payment, however it reached the books, counts once', () => {
    const CASES = [
        ['typed on the same day as the bank debit', { expenses: [manual('m', 'Keells', 4200, '2026-03-05')] }, [row('KEELLS SUPER COLOMBO', 4200, '2026-03-05')], 4200],
        ['typed a day apart', { expenses: [manual('m', 'Keells', 4200, '2026-03-04')] }, [row('KEELLS SUPER COLOMBO', 4200, '2026-03-05')], 4200],
        ['typed two days before the bank posted it', { expenses: [manual('m', 'Keells', 4200, '2026-03-03')] }, [row('KEELLS SUPER COLOMBO', 4200, '2026-03-05')], 4200],
        ['typed three days before the bank posted it', { expenses: [manual('m', 'Keells', 4200, '2026-03-02')] }, [row('KEELLS SUPER COLOMBO', 4200, '2026-03-05')], 4200],
        ['a loan debit with the loan\'s wording', { loans: [loan()] }, [row('HNB LOAN INSTALMENT 0740123', 45000, '2026-03-05')], 45000],
        ['a loan debit with only the loan\'s own name', { loans: [loan()] }, [row('HONDA VEZEL 45000', 45000, '2026-03-05')], 45000],
        ['a loan debit with only the lender\'s name', { loans: [loan()] }, [row('HNB PAYMENT', 45000, '2026-03-05')], 45000],
        ['a loan debit with no words at all, on the loan\'s pay day, for exactly the installment', { loans: [loan()] }, [row('CEFT TRANSFER 0741234567', 45000, '2026-03-05')], 45000],
        ['a loan debit with no words, paid from the bank by the owner\'s word', { loans: [loan({ payments: [{ month: '2026-03', paid: true, amount: 45000, via: 'bank' }] })] }, [row('CEFT TRANSFER 0741234567', 45000, '2026-03-05')], 45000],
        ['a loan paid in cash and an unrelated debit', { loans: [loan({ payments: [{ month: '2026-03', paid: true, amount: 45000, via: 'other' }] })] }, [row('KEELLS SUPER COLOMBO', 3000, '2026-03-05')], 48000],
        ['a loan typed by hand as an expense called "loan payment"', { loans: [loan()], expenses: [manual('m', 'HNB loan payment', 45000, '2026-03-05')] }, [], 45000],
    ];
    for (const [name, user, rows, expected] of CASES) it(name, async () => { expect((await totalOf(user, rows)).total).toBe(expected); });
});

const incomeOf = async (user, rows, options) => { const after = await file(user, rows, options); return { income: march(screens(after)).income, after }; };
describe('one real receipt counts once', () => {
    it('salary typed by hand and then on the statement, on the same day and two days apart', async () => {
        for (const typed of ['2026-03-25', '2026-03-24', '2026-03-23']) {
            const user = { incomeRecv: [{ id: 'i1', name: 'Salary', amount: 250000, date: typed, month: '2026-03', received: true, type: 'Salary' }] };
            expect((await incomeOf(user, [row('SALARY CREDIT ACME', 250000, '2026-03-25', 'credit')])).income, typed).toBe(250000);
        }
    });
});

describe('one real payment through another store counts once', () => {
    it('a tracked subscription and the bank debit for it', async () => {
        const subs = [{ id: 's1', name: 'Netflix', amount: 1990, cycle: 'monthly', createdAt: '2026-01-05T00:00:00Z', history: [] }];
        expect((await totalOf({ subscriptions: subs }, [row('NETFLIX.COM 1990', 1990, '2026-03-07')])).total).toBe(1990);
    });
    it('an issued cheque and the bank debit that clears it', async () => {
        const cheques = [{ id: 'q1', party: 'Landlord', no: '000123', amount: 80000, issue: '2026-03-01', release: '2026-03-02', status: 'pending', type: 'issued' }];
        expect((await totalOf({ cheques }, [row('CHQ 000123 CLEARED', 80000, '2026-03-06')])).total).toBe(80000);
    });
    it('a card installment plan and the card charge for it', async () => {
        const ccinstall = [{ id: 'p1', product: 'Singer Fridge', bank: 'NTB', date: '2026-01-01', duration: 12, monthly: 5000, total: 60000, completed: false, payments: [] }];
        const out = await totalOf({ ccinstall }, [row('SINGER FRIDGE INSTALMENT', 5000, '2026-03-12')], { bank: 'NTB', last4: '0276', statementType: 'credit_card', decision: { module: 'cconetime', category: 'Shopping', verified: true } });
        expect(out.total).toBe(5000);
    });
    it('card purchases and the bank paying the card', async () => {
        const cconetime = [{ id: 'c1', desc: 'Keells', amount: 3000, date: '2026-03-04', card_last4: '0276', bank: 'AMEX', source: 'statement', statementKey: 'wf-mail/x/items/a' }];
        const out = await totalOf({ cconetime }, [row('CREDIT CARD PAYMENT AMEX 0276', 3000, '2026-03-20')], { cardRegistry: { '0276': { bank: 'AMEX' } } });
        expect(out.total).toBe(3000);
    });
    it('a purchase typed by hand as an expense and then on the card statement', async () => {
        for (const typed of ['2026-03-04', '2026-03-02']) {
            const out = await totalOf({ expenses: [manual('m', 'Keells', 3000, typed)] }, [row('KEELLS SUPER COLOMBO', 3000, '2026-03-04')], { bank: 'AMEX', last4: '0276', statementType: 'credit_card', decision: { module: 'cconetime', category: 'Food', verified: true } });
            expect(out.total, typed).toBe(3000);
        }
    });
    it('the same statement read a second time', async () => {
        const rows = [row('KEELLS SUPER COLOMBO', 4200, '2026-03-05'), row('FUEL IOC', 9000, '2026-03-06')];
        const first = await file({}, rows);
        const second = await file(first, rows, { path: 'sources/s2' });
        expect(march(screens(second)).totalExp).toBe(13200);
    });
});

describe('what is NOT the same payment is never merged — real money is never lost to the rule', () => {
    it('two different things of the same amount a few days apart, with nothing in common, both count', async () => {
        const typed = { expenses: [manual('m', 'Lunch', 1000, '2026-03-03')] };
        expect((await totalOf(typed, [row('ATM WITHDRAWAL COLOMBO', 1000, '2026-03-05')])).total).toBe(2000);
    });
    it('the same name and amount a week apart are two purchases', async () => {
        const typed = { expenses: [manual('m', 'Keells', 4200, '2026-03-01')] };
        expect((await totalOf(typed, [row('KEELLS SUPER COLOMBO', 4200, '2026-03-08')])).total).toBe(8400);
    });
    it('one typed entry stands for one row: two identical purchases on the statement are two', async () => {
        const typed = { expenses: [manual('m', 'Keells', 4200, '2026-03-05')] };
        expect((await totalOf(typed, [row('KEELLS SUPER COLOMBO', 4200, '2026-03-05'), row('KEELLS SUPER COLOMBO', 4200, '2026-03-05')])).total).toBe(8400);
    });
    it('the rent of the installment\'s amount on the loan\'s pay day is the rent: the loan keeps its one month, the rent counts too', async () => {
        const out = await totalOf({ loans: [loan()] }, [row('HNB LOAN INSTALMENT 0740123', 45000, '2026-03-05'), row('RENT MARCH', 45000, '2026-03-05')]);
        expect(out.total).toBe(90000);
        expect(out.after.expenses.filter(e => e.loanLink)).toHaveLength(1);
    });
    it('a card payment of the installment\'s amount is not a loan installment', async () => {
        const out = await totalOf({ loans: [loan()] }, [row('HNB CREDIT CARD PAYMENT 5555', 45000, '2026-03-05')]);
        expect(out.after.expenses.filter(e => e.loanLink)).toHaveLength(0);
    });
    it('a loan the owner says was paid in cash is not tied to any bank debit, even one for the same amount on the pay day', async () => {
        const out = await totalOf({ loans: [loan({ payments: [{ month: '2026-03', paid: true, amount: 45000, via: 'other' }] })] }, [row('CEFT TRANSFER 0741234567', 45000, '2026-03-05')]);
        expect(out.after.expenses.filter(e => e.loanLink)).toHaveLength(0);
    });
    it('the same words every month tie the installment even when the amount changes (a reducing-balance loan)', async () => {
        const tied = [{ id: 'e0', desc: 'CEFT TRANSFER TO LOLC 77', amount: 50000, date: '2026-02-05', month: '2026-02', loanLink: { loanId: 'L1', month: '2026-02' }, source: 'statement', statementKey: 'k' }];
        const out = await totalOf({ loans: [loan({ monthly: 48000, name: 'Business' , bank: 'LOLC' })], expenses: tied }, [row('CEFT TRANSFER TO LOLC 77', 49000, '2026-03-05')]);
        expect(out.after.expenses.filter(e => e.loanLink && e.date === '2026-03-05')).toHaveLength(1);
    });
});

/* ── random households: every real payment represented in one or more of the ways above ─────────────────────────────────────────────────────── */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
describe('a thousand random households: every real payment counts once', () => {
    it.each(Array.from({ length: Number(process.env.WF_FUZZ_SEEDS) || 300 }, (_, i) => i + 1))('household %i', async (seed) => {
        const r = rng(seed * 7919), pick = list => list[Math.floor(r() * list.length)];
        const used = new Set(), amountOf = () => { let a; do { a = 1000 + Math.floor(r() * 90000) + Math.floor(r() * 100) / 100; a = Math.round(a * 100) / 100; } while (used.has(a)); used.add(a); return a; };
        const day = n => `2026-03-${String(Math.min(28, Math.max(1, n))).padStart(2, '0')}`;
        const user = { expenses: [], incomeRecv: [], subscriptions: [], cheques: [], loans: [], cconetime: [] }, rows = [], notes = [], late = [];
        let expense = 0, receipts = 0;
        const withLoan = process.env.WF_KINDS ? process.env.WF_KINDS.includes('loan') : r() < 0.5;
        if (withLoan) {
            const amount = amountOf(), d = 3 + Math.floor(r() * 20), narration = pick(['HNB LOAN INSTALMENT 0740123', 'HONDA VEZEL 0740123', 'HNB PAYMENT 0740', 'CEFT TRANSFER 0741234567', 'LOAN EMI PAYMENT']);
            const via = narration === 'CEFT TRANSFER 0741234567' && r() < 0.5 ? [{ month: '2026-03', paid: true, amount, via: 'bank' }] : [];
            user.loans.push(loan({ monthly: amount, payDay: d, payments: via }));
            const bareNeedsPayDay = narration === 'CEFT TRANSFER 0741234567';
            rows.push(row(narration, amount, day(bareNeedsPayDay && !via.length ? d + Math.floor(r() * 3) : d + Math.floor(r() * 3))));
            expense += amount; notes.push(`loan:${narration}`);
        }
        const count = 2 + Math.floor(r() * 6);
        for (let i = 0; i < count; i++) {
            const kind = pick((process.env.WF_KINDS || 'plain,typed,typed-near,typed-late,sub,cheque,income,income-typed,settled').split(',')), a = amountOf(), d = 2 + Math.floor(r() * 24), name = pick(['KEELLS', 'ARPICO', 'CARGILLS', 'LAUGFS', 'DIALOG', 'ODEL']) + i;
            notes.push(kind);
            if (kind === 'plain') { rows.push(row(`${name} COLOMBO`, a, day(d))); expense += a; }
            else if (kind === 'typed') { user.expenses.push(manual(`m${i}`, name, a, day(d - Math.floor(r() * 4)))); rows.push(row(`${name} COLOMBO`, a, day(d))); expense += a; }
            else if (kind === 'typed-near') { user.expenses.push(manual(`m${i}`, 'Misc', a, day(d - Math.floor(r() * 2)))); rows.push(row(`POS ${name}`, a, day(d))); expense += a; }
            else if (kind === 'typed-late') { late.push(manual(`l${i}`, name, a, day(d - Math.floor(r() * 4)))); rows.push(row(`${name} COLOMBO`, a, day(d))); expense += a; }
            else if (kind === 'sub') { user.subscriptions.push({ id: `s${i}`, name, amount: a, cycle: 'monthly', createdAt: '2026-01-05T00:00:00Z', history: [] }); rows.push(row(`${name}.COM ${a}`, a, day(d))); expense += a; }
            else if (kind === 'cheque') { user.cheques.push({ id: `q${i}`, party: name, no: String(100 + i).padStart(6, '0'), amount: a, issue: day(d - 1), release: day(d - 1), status: 'pending', type: 'issued' }); rows.push(row(`CHQ ${String(100 + i).padStart(6, '0')} CLEARED`, a, day(d))); expense += a; }
            else if (kind === 'income') { rows.push(row(`SALARY CREDIT ${name}`, a, day(d), 'credit')); receipts += a; }
            else if (kind === 'income-typed') { user.incomeRecv.push({ id: `i${i}`, name: 'Salary', amount: a, date: day(d - Math.floor(r() * 4)), month: '2026-03', received: true, type: 'Salary' }); rows.push(row(`SALARY CREDIT ${name}`, a, day(d), 'credit')); receipts += a; }
            else if (kind === 'settled') { user.cconetime.push({ id: `c${i}`, desc: name, amount: a, date: day(d - 1), card_last4: '0276', bank: 'AMEX', source: 'statement', statementKey: 'wf-mail/x/items/a' }); rows.push(row('CREDIT CARD PAYMENT AMEX 0276', a, day(d + 1))); expense += a; }
        }
        let after = await file(user, rows, { cardRegistry: { '0276': { bank: 'AMEX' } } });
        if (r() < 0.3) { after = await file(after, rows, { path: 'sources/s2', cardRegistry: { '0276': { bank: 'AMEX' } } }); notes.push('read-twice'); }
        // entries typed AFTER the statement filed their payments, and the periodic reconcile that follows
        if (late.length) { after = await reconcile({ ...after, expenses: [...(after.expenses || []), ...late] }); }
        const month = march(screens(after));
        expect({ total: Math.round(month.totalExp * 100) / 100, income: Math.round(month.income * 100) / 100, notes: notes.join(',') }).toEqual({ total: Math.round(expense * 100) / 100, income: Math.round(receipts * 100) / 100, notes: notes.join(',') });
    });
});
