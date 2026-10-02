import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readStatement } from '../statement-reader.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync, repairCardInstallments } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';
import { incomeIn } from '../wealthflow-reactive.js';
import { matchInstallmentPlan, planCountedIn, repairInstallmentRecords } from '../statement-links.mjs';

// A card installment charge is a real charge. In the worker's own shape (description, startDate, months) it was invisible to the monthly totals and to the
// Installments tab; given the plan shape it counts in its month — and when the owner already has the plan, the plan's month counts it and the statement
// row is not a second record.

const plan = (extra = {}) => ({ id: 'P1', product: 'Abans TV', bank: 'American Express (AMEX)', monthly: 5000, total: 60000, rate: 0, duration: 12, date: '2026-01-10', completed: false, skipped: [], ...extra });
const row = (description, amount, date = '2026-09-14') => ({ description, amount, date });

describe('which plan a card charge is the installment of', () => {
    it('its product in the narration, its monthly amount to 2%, counted that month; never two, never a second charge in the month', () => {
        expect(matchInstallmentPlan(row('ABANS TV INSTALMENT 03/12', 5000), [plan()]).id).toBe('P1');
        expect(matchInstallmentPlan(row('ABANS TV INSTALMENT', 5090), [plan()]).id).toBe('P1');
        expect(matchInstallmentPlan(row('ABANS TV INSTALMENT', 5200), [plan()])).toBeNull();
        expect(matchInstallmentPlan(row('KEELLS STORE', 5000), [plan()])).toBeNull();
        expect(matchInstallmentPlan(row('ABANS TV INSTALMENT', 5000), [plan(), plan({ id: 'P2' })])).toBeNull();
        expect(matchInstallmentPlan(row('ABANS TV INSTALMENT', 5000), [plan({ payments: [{ month: '2026-09', paid: true, source: 'statement' }] })])).toBeNull();
    });
    it('the plan must be one the totals count that month (started by the month\'s first day, not ended, not completed)', () => {
        expect(planCountedIn(plan(), '2026-09')).toBe(true);
        expect(planCountedIn(plan(), '2026-01')).toBe(false);          // started on the 10th: January is not counted
        expect(planCountedIn(plan(), '2027-01')).toBe(true);           // the totals' own rule: it ends on 2027-01-10, after January's first day
        expect(planCountedIn(plan(), '2027-02')).toBe(false);
        expect(planCountedIn(plan({ completed: true }), '2026-09')).toBe(false);
        expect(matchInstallmentPlan(row('ABANS TV INSTALMENT', 5000, '2027-03-14'), [plan()])).toBeNull();
    });
});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = n => { const s = html.indexOf(`function ${n}(`); const from = html.slice(s - 6, s) === 'async ' ? s - 6 : s; return html.slice(from, html.indexOf('\n        }', s) + 10); };
function monthly(user, year = 2026, month = 8) {
    const store = { loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [], ...user };
    const ctx = vm.createContext({ DB: { get: k => store[k] || [] }, p2: n => String(n).padStart(2, '0'), window: { WFReactive: { incomeIn } }, Date });
    for (const n of ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', 'loanEndDate', 'getLoanMonthlyForDate', '_wfLinkedLoanMonths', 'getCCIMonthlyForDate', 'getMonthlyData']) vm.runInContext(src(n), ctx);
    return ctx.getMonthlyData(year, month);
}
const CARD = `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 16/09/2026 Payment Due Date: 10/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>12/09/2026</td><td>ABANS TV INSTALMENT 08/12</td><td>5000.00 DR</td></tr><tr><td>14/09/2026</td><td>KEELLS STORE</td><td>2000.00 DR</td></tr></table></body></html>`;
async function file(user) {
    const owner = { uid: 'u', email: 'owner@example.com' }, mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'nationstrust@estmt.nationstrust.com', kind: 'address', status: 'approved', name: 'American Express (AMEX)', domain: 'estmt.nationstrust.com' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ccinstall: [], loans: [], subscriptions: [], cheques: [], ...user },
        [sourcePath]: { uid: 'u', bank: 'American Express (AMEX)', filename: 'AMEX_Statement_202609.html', from: 'nationstrust@estmt.nationstrust.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-09-17T05:00:00Z') },
    });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        await runStatementSync({ action: 'drain', db, owner, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), read: readStatement, open: async () => [], settle: settleStatement,
            board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment: async () => ({ bytes: Buffer.from(CARD), filename: 'AMEX_Statement_202609.html', contentSha256: 'x' }) });
    } finally { spy.mockRestore(); }
    return { user: data.get('users/u'), item: data.get(sourcePath), data, db };
}

describe('end to end: a card statement with an installment line', () => {
    it('no plan on the books: the charge is a one-month plan in the plan shape, and September counts it', async () => {
        const { user, item } = await file({});
        expect(item.status).toBe('filed');
        expect(user.ccinstall).toHaveLength(1);
        expect(user.ccinstall[0]).toMatchObject({ product: expect.stringMatching(/ABANS TV/), duration: 1, date: '2026-09-01', startDate: '2026-09-12', monthly: 5000, completed: false });
        const september = monthly(user);
        expect(september.ccTotal).toBe(5000);                                // before: the record had no date and was never counted
        expect(september.ccotTotal).toBe(2000);                              // the grocery charge, as always
    });
    it('the owner already has the plan: the plan counts the month once, the statement row is not a second record', async () => {
        const { user, data } = await file({ ccinstall: [plan()] });
        expect(user.ccinstall).toHaveLength(1);
        expect(user.ccinstall[0].payments).toEqual([expect.objectContaining({ month: '2026-09', paid: true, amount: 5000, source: 'statement' })]);
        expect(monthly(user).ccTotal).toBe(5000);                            // before: 10,000 would have been the worst case once the record became visible
        const entries = [...data.keys()].filter(k => k.startsWith('users/u/statementLedger/')).map(k => data.get(k));
        expect(entries.find(e => e.reason === 'counted-by-installment-plan')).toMatchObject({ status: 'duplicate', matchedId: 'P1' });
    });
});

describe('records filed in the old shape are repaired once', () => {
    const old = (extra = {}) => ({ id: 'R1', desc: 'ABANS TV INSTALMENT 08/12', total: 5000, monthly: 5000, months: 1, remaining: 1, paid: 0, startDate: '2026-09-12', amount: 5000, source: 'statement', statementKey: 'wf-mail/x/items/i0', statementRow: 0, ...extra });
    it('with no plan to match it gets the plan shape and counts', () => {
        const user = { ccinstall: [old()] };
        expect(repairInstallmentRecords(user, 1)).toEqual([{ id: 'R1', kind: 'shape' }]);
        expect(user.ccinstall[0]).toMatchObject({ date: '2026-09-01', duration: 1, product: expect.any(String), completed: false });
        expect(monthly(user).ccTotal).toBe(5000);
        expect(repairInstallmentRecords(user, 2)).toEqual([]);
    });
    it('a plan the owner has is that very charge: the plan\'s month says paid and the old record stays out of the totals', () => {
        const user = { ccinstall: [plan(), old()] };
        expect(repairInstallmentRecords(user, 1)).toEqual([{ id: 'R1', kind: 'plan-link' }]);
        expect(user.ccinstall[1]).toMatchObject({ planLink: 'P1', completed: true });
        expect(user.ccinstall[0].payments[0]).toMatchObject({ month: '2026-09', paid: true });
        expect(monthly(user).ccTotal).toBe(5000);
    });
    it('the idle pass does it on the owner\'s data and says so in one log line', async () => {
        const owner = { uid: 'u' };
        const { db, data } = createFirestore({ 'users/u': { ccinstall: [old()] } });
        const lines = [];
        expect((await repairCardInstallments({ db, uid: owner.uid, log: l => lines.push(l) })).repaired).toBe(1);
        expect(JSON.parse(lines[0])).toMatchObject({ evt: 'card-installment-repair', repaired: 1, kinds: { shape: 1 } });
        expect(data.get('users/u').ccinstall[0].date).toBe('2026-09-01');
        expect((await repairCardInstallments({ db, uid: owner.uid, log: () => {} })).repaired).toBe(0);
    });
});
