import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { textPdf } from './helpers/embedded-statements.js';
import { readStatement } from '../statement-reader.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';
import { incomeIn } from '../wealthflow-reactive.js';
import { manualTwin, matchSubscriptionForDebit, subscriptionCountedIn, cardSettlementDebit } from '../statement-links.mjs';
import { readCheque, matchTracked } from '../wealthflow-cheques.js';
// the cheque matcher moved to wealthflow-cheques.js (by number first, then amount and days); this asks it what the old matchChequeForDebit was asked
const matchChequeForDebit = (r, cheques) => { const read = readCheque({ description: r.description, direction: 'debit', amount: r.amount }); const hit = read.isCheque ? matchTracked(read, { date: r.date, amount: r.amount }, cheques) : null; return hit && hit.status === 'matched' && !hit.already ? hit.cheque : null; };

// One payment, one count. A statement row is the money that really moved; the books may already hold it under another name. These tests run
// the real worker over a real statement and read the monthly total back through the dashboard's own getMonthlyData, against ground truth.

describe('the matchers', () => {
    const row = (description, amount, date = '2026-03-09', direction = 'debit') => ({ description, amount, date, direction });
    it('a hand-made entry: same cents, same day or one day either side, same words for a recurring one — and never two rows for one entry', () => {
        const mine = { id: 'M1', desc: 'Keells', amount: 4000, date: '2026-03-08', month: '2026-03' };
        expect(manualTwin([mine], row('POS KEELLS SUPER 1234', 4000)).r.id).toBe('M1');
        expect(manualTwin([mine], row('POS KEELLS SUPER 1234', 4000.01))).toBeNull();
        expect(manualTwin([mine], row('POS KEELLS SUPER 1234', 4000, '2026-03-12'))).toBeNull();
        expect(manualTwin([{ ...mine, statementTwin: { sourcePath: 'x', index: 1 } }], row('POS KEELLS', 4000))).toBeNull();
        expect(manualTwin([{ ...mine, source: 'statement' }], row('POS KEELLS', 4000))).toBeNull();
        expect(manualTwin([mine, { ...mine, id: 'M2' }], row('POS KEELLS', 4000, '2026-03-08'))).toBeNull();           // two fit equally: never guessed
        const rent = { id: 'R1', desc: 'House rent', amount: 50000, recurring: true, month: '2026-01' };
        expect(manualTwin([rent], row('RENT PAYMENT LANDLORD', 50000, '2026-03-03')).recurring).toBe(true);
        expect(manualTwin([{ ...rent, statementTwins: { '2026-03': {} } }], row('RENT PAYMENT LANDLORD', 50000, '2026-03-03'))).toBeNull();
        expect(manualTwin([rent], row('SOMETHING ELSE', 50000, '2026-03-03'))).toBeNull();
    });
    it('a one-time bill that is already paid is finished: a later charge from the same merchant is not that bill', () => {
        const once = { id: 'O1', name: 'Dialog Router', amount: 8000, cycle: 'once', dueDate: '2026-09-20', createdAt: '2026-09-01T00:00:00Z' };
        expect(matchSubscriptionForDebit(row('DIALOG ROUTER', 8000, '2026-10-05'), [once]).id).toBe('O1');                   // still open: it is this bill
        expect(matchSubscriptionForDebit(row('DIALOG ROUTER', 8000, '2026-10-05'), [{ ...once, paid: true }])).toBeNull();
        expect(matchSubscriptionForDebit(row('DIALOG ROUTER', 8000, '2026-10-05'), [{ ...once, completed: true }])).toBeNull();
        expect(matchSubscriptionForDebit(row('DIALOG ROUTER', 8000, '2026-10-05'), [{ ...once, paid: false, completed: false, reopened: true }]).id).toBe('O1');
    });
    it('a subscription: its name in the narration, an amount about right, counted that month — a yearly one only in its own month', () => {
        const netflix = { id: 'S1', name: 'Netflix', amount: 1500, cycle: 'monthly', createdAt: '2026-01-10T00:00:00Z' };
        expect(matchSubscriptionForDebit(row('NETFLIX.COM 866', 1500), [netflix]).id).toBe('S1');
        expect(matchSubscriptionForDebit(row('NETFLIX.COM', 9000), [netflix])).toBeNull();                              // a different charge
        expect(matchSubscriptionForDebit(row('KEELLS', 1500), [netflix])).toBeNull();
        expect(matchSubscriptionForDebit(row('NETFLIX', 1500), [netflix, { ...netflix, id: 'S2' }])).toBeNull();        // two fit
        const yearly = { id: 'Y1', name: 'Amazon Prime', amount: 12000, cycle: 'yearly', createdAt: '2025-06-01T00:00:00Z' };
        expect(subscriptionCountedIn(yearly, '2026-06')).toBe(true); expect(subscriptionCountedIn(yearly, '2026-03')).toBe(false);
        expect(matchSubscriptionForDebit(row('AMAZON PRIME', 12000, '2026-03-09'), [yearly])).toBeNull();               // the totals would not count it in March, so it is not hidden there
        expect(subscriptionCountedIn(netflix, '2025-12')).toBe(false);
    });
    it('a cheque: the number in the narration, or the same amount near its date; never a received one', () => {
        const cheque = { id: 'C1', no: '000123', type: 'issued', amount: 25000, issue: '2026-03-10', release: '2026-03-10', status: 'pending' };
        expect(matchChequeForDebit(row('CHEQUE 000123', 25000, '2026-03-14'), [cheque]).id).toBe('C1');
        expect(matchChequeForDebit(row('CHQ NO 123 PAID', 25000, '2026-03-14'), [cheque]).id).toBe('C1');
        expect(matchChequeForDebit(row('CHEQUE CLEARING', 25000, '2026-03-14'), [cheque]).id).toBe('C1');
        expect(matchChequeForDebit(row('CHEQUE CLEARING', 25000, '2026-04-30'), [cheque])).toBeNull();
        expect(matchChequeForDebit(row('KEELLS', 25000, '2026-03-14'), [cheque])).toBeNull();
        expect(matchChequeForDebit(row('CHEQUE 000123', 25000), [{ ...cheque, type: 'received' }])).toBeNull();
        // a cheque marked bounced that the bank then paid IS paid: matched (the tracker marks it cleared again), not skipped
        expect(matchChequeForDebit(row('CHEQUE 000123', 25000, '2026-03-14'), [{ ...cheque, status: 'bounced' }]).id).toBe('C1');
    });
    it('the bank paying a card: settlement wording AND a card the owner tracks (its last four digits, or its bank\'s name) in the narration', () => {
        const tracked = { cardRegistry: { 4512: { bank: 'HNB', type: 'credit_card' } }, cards: [{ card_last4: '0276', bank: 'American Express (AMEX)' }] };
        for (const text of ['CREDIT CARD PAYMENT HNB 4512', 'CARD PAYMENT 4512', 'AMEX PAYMENT 4455', 'CC PAYMENT AMERICAN EXPRESS', 'CARD SETTLEMENT 3782 8224 6310 0276', 'PAYMENT TO CARD HNB']) expect(cardSettlementDebit(row(text, 50000), tracked), text).toBe(true);
        expect(cardSettlementDebit(row('CREDIT CARD PAYMENT HNB 4512', 50000), {})).toBe(false);                      // no card tracked: this payment is the only record
        expect(cardSettlementDebit(row('CREDIT CARD PAYMENT SEYLAN 9981', 50000), tracked)).toBe(false);              // a card the books know nothing about
        expect(cardSettlementDebit(row('CC PAYMENT', 50000), tracked)).toBe(false);                                   // which card? not guessed
        expect(cardSettlementDebit(row('POS KEELLS CARD', 4000), tracked)).toBe(false);
        expect(cardSettlementDebit(row('VISA POS PURCHASE HNB', 4000), tracked)).toBe(false);
    });
    it('a second charge in a month the subscription already holds a statement payment for is its own payment', () => {
        const netflix = { id: 'S1', name: 'Netflix', amount: 1500, cycle: 'monthly', createdAt: '2026-01-10T00:00:00Z', history: [{ month: '2026-03', amount: 1500, date: '2026-03-02', source: 'statement' }] };
        expect(matchSubscriptionForDebit(row('NETFLIX.COM', 1500, '2026-03-20'), [netflix])).toBeNull();
        expect(matchSubscriptionForDebit(row('NETFLIX.COM', 1500, '2026-04-02'), [netflix]).id).toBe('S1');
    });
});

// ── the worker, end to end ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = n => { const s = html.indexOf(`function ${n}(`); const from = html.slice(s - 6, s) === 'async ' ? s - 6 : s; return html.slice(from, html.indexOf('\n        }', s) + 10); };
function monthly(user, year = 2026, month = 2) {
    const store = { loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [], ...user };
    const ctx = vm.createContext({ DB: { get: k => store[k] || [] }, p2: n => String(n).padStart(2, '0'), window: { WFReactive: { incomeIn } }, Date });
    for (const n of ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', 'loanEndDate', 'getLoanMonthlyForDate', '_wfLinkedLoanMonths', 'getCCIMonthlyForDate', '_wfFindLoanDebit', '_wfMonthIsFuture', 'getMonthlyData']) vm.runInContext(src(n), ctx);
    return ctx.getMonthlyData(year, month);
}
const STATEMENT = rows => `
HATTON NATIONAL BANK PLC
Statement Period: 01/03/2026 - 31/03/2026
Account Number: 074020012388
Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance
01/03/2026 Opening Balance 500,000.00
${rows}
`;
async function file(user, rows) {
    const owner = { uid: 'u', email: 'owner@example.com' }, mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@hnb.lk', kind: 'address', status: 'approved', name: 'HNB', domain: 'hnb.lk' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ccinstall: [], loans: [], subscriptions: [], cheques: [], ...user },
        [sourcePath]: { uid: 'u', bank: 'HNB', filename: 'statement.pdf', from: 'statements@hnb.lk', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-04-02T05:00:00Z') },
    });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        await runStatementSync({ action: 'drain', db, owner, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), read: readStatement, open: async () => [{ password: 'p', bank: 'HNB' }], settle: settleStatement,
            board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment: async () => ({ bytes: textPdf(STATEMENT(rows).trim().split('\n')), filename: 'statement.pdf', contentSha256: 'x' }) });
    } finally { spy.mockRestore(); }
    return { user: data.get('users/u'), item: data.get(sourcePath), data };
}
const row = (day, text, dr, cr, bal) => `${day}/03/2026 ${day}/03/2026 ${text} ${dr || ''} ${cr || ''} ${bal}`.replace(/\s+/g, ' ');

describe('end to end, against ground truth: each payment is counted once', () => {
    it('a subscription debit: the subscription counts it (with the real amount), no second expense', async () => {
        const { user, item } = await file({ subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1400, cycle: 'monthly', category: 'Entertainment', createdAt: '2026-01-01T00:00:00Z' }] }, row('07', 'NETFLIX.COM', '1,500.00', '', '498,500.00'));
        expect(item.status).toBe('filed');
        expect(user.expenses).toHaveLength(0);
        expect(user.subscriptions[0].monthOverrides['2026-03']).toBe(1500);
        expect(monthly(user).totalExp).toBe(1500);                     // before: 3,000
    });
    it('a cheque the owner issued: the debit clears it, no second expense', async () => {
        const { user } = await file({ cheques: [{ id: 'C1', no: '000123', party: 'Landlord', type: 'issued', amount: 25000, issue: '2026-03-10', release: '2026-03-10', status: 'pending' }] }, row('12', 'CHEQUE 000123', '25,000.00', '', '475,000.00'));
        expect(user.expenses).toHaveLength(0);
        expect(user.cheques[0]).toMatchObject({ status: 'cleared', clearedDate: '2026-03-12' });
        expect(monthly(user).totalExp).toBe(25000);                    // before: 50,000
    });
    it('an expense the owner typed in: the statement row is its twin, filed once', async () => {
        const { user, data } = await file({ expenses: [{ id: 'M1', desc: 'Groceries Keells', amount: 4000, date: '2026-03-09', month: '2026-03', cat: 'Groceries' }] }, row('09', 'POS Transaction KEELLS SUPER 1234567890', '4,000.00', '', '496,000.00'));
        expect(user.expenses).toHaveLength(1);
        expect(user.expenses[0]).toMatchObject({ id: 'M1', cat: 'Groceries', statementTwin: expect.objectContaining({ index: 0 }) });
        expect(monthly(user).totalExp).toBe(4000);                     // before: 8,000
        const entries = [...data.keys()].filter(k => k.startsWith('users/u/statementLedger/')).map(k => data.get(k));
        expect(entries).toEqual([expect.objectContaining({ status: 'duplicate', reason: 'entered-by-hand', matchedId: 'M1' })]);
    });
    it('income the owner typed in: the bank credit is its twin, counted once', async () => {
        const { user } = await file({ incomeRecv: [{ id: 'I1', name: 'Salary March', amount: 150000, date: '2026-03-25', month: '2026-03', received: true, type: 'Salary' }] }, row('25', 'SALARY CREDIT 7654321098', '', '150,000.00', '650,000.00'));
        expect(user.incomeRecv).toHaveLength(1);
        expect(monthly(user).income).toBe(150000);                     // before: 300,000
    });
    it('two same-day, same-amount purchases and one hand-made entry: the entry stands for ONE row, the other is filed', async () => {
        const { user } = await file({ expenses: [{ id: 'M1', desc: 'Coffee', amount: 450, date: '2026-03-09', month: '2026-03', cat: 'Dining' }] },
            `${row('09', 'POS CAFE ONE', '450.00', '', '499,550.00')}\n${row('09', 'POS CAFE TWO', '450.00', '', '499,100.00')}`);
        expect(user.expenses).toHaveLength(2);
        expect(monthly(user).totalExp).toBe(900);                      // two coffees, both real
    });
    it('the bank settling a card the owner tracks is not spending; with no card tracked it is, as before', async () => {
        const tracked = await file({ cconetime: [{ id: 'K1', desc: 'KEELLS', amount: 4000, date: '2026-03-05', card_last4: '4512', bank: 'HNB', paid: false }] }, row('08', 'CREDIT CARD PAYMENT HNB 4512', '50,000.00', '', '450,000.00'));
        expect(tracked.user.expenses).toHaveLength(0);
        const none = await file({}, row('08', 'CREDIT CARD PAYMENT HNB 4512', '50,000.00', '', '450,000.00'));
        expect(none.user.expenses.length + none.user.cconetime.length).toBe(1);
    });
    it('nothing in the books matches: filed exactly as before', async () => {
        const { user } = await file({ subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1400, cycle: 'monthly', createdAt: '2026-01-01T00:00:00Z' }], cheques: [{ id: 'C1', no: '777', type: 'issued', amount: 999, issue: '2026-03-01', status: 'pending' }] },
            row('07', 'KEELLS SUPER', '4,000.00', '', '496,000.00'));
        expect(user.expenses).toHaveLength(1);
        expect(user.cheques[0].status).toBe('pending');
    });
});
