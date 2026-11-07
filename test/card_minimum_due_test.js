import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { textPdf } from './helpers/embedded-statements.js';
import { readStatement } from '../statement-reader.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync, unfileStatement } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';
import { cardDueRecord, withCardDue } from '../statement-due.mjs';
import { proveDirections } from '../statement-direction.mjs';
import '../statement-merchants.mjs';
import cardTabs from '../wealthflow-card-tabs.js';

const P = loadParser(fs);

/* A card statement shaped like the one the owner sent from a Sri Lankan bank (invented names and figures): one column of amounts ("CR" before a payment), an "Opening Balance" line, three printed totals, and at the
 * foot, under the titles "Payment Due Date | Min Amt. Due | Closing Balance", ONE line with a date and two figures. That line was read as a transaction with a running balance, which turned every amount into the
 * difference between two figures (a 3,250.50 purchase became 11,749.50, "Interest" 2,400.00 became 4,350.00) and put a "payment" of the minimum on the books. */
const head = ['Statement of Account', 'Card Number 4111 2222 3333 4444', 'Credit Limit 400,000.00', 'Statement Period 30 Sep 2026 / 31 Oct 2026', 'Page 1 of 2', 'Posting Date Transaction Date Transaction Details Foreign Currency Amount Amount', 'Opening Balance 120,000.00', 'MR A B PERERA'];
const body = [
    '12/10/2026 12/10/2026 Payment 004 CR 15,000.00',
    '14/10/2026 13/10/2026 SUPERMARKET KANDY, KANDY 3,250.50',
    '15/10/2026 14/10/2026 ONLINE SHOP, Colombo 7,100.00',
    '15/10/2026 16/10/2026 Instalment Principle - 3/12 9,000.00',
    '20/10/2026 18/10/2026 Payment 004 CR 5,000.00',
    '31/10/2026 31/10/2026 Interest 2,400.00',
    'Total Payment: 20,000.00CR', 'Total Transactions: 10,350.50', 'Others: 11,400.00',
];
const foot = ['Payment Due Date Min Amt. Due Closing Balance', '24 Nov 2026 4,200.00 121,750.50'];
const STATEMENT = [...head, ...body, ...foot].join('\n');
const AMOUNTS = [15000, 3250.5, 7100, 9000, 5000, 2400];

describe('the foot of a card statement is not a transaction', () => {
    const parsed = P.parseStatement(STATEMENT);
    it('every amount is the figure the statement prints, not the change between two figures', () => {
        expect(parsed.layout.balanceColumn).toBe(false);
        expect(parsed.rows.map(r => r.amount)).toEqual(AMOUNTS);
    });
    it('the due line is not a row, so nothing is dated the due date and no row has no words', () => {
        expect(parsed.rows.some(r => r.date === '2026-11-24' || !r.narration)).toBe(false);
        expect(parsed.rows).toHaveLength(6);
    });
    it('the statement adds up to the cent as a card (opening - paid in + charged = closing), so it is "parsed"', () => {
        expect(parsed.reconciliation).toMatchObject({ opening: 120000, closing: 121750.5, ok: true, model: 'card' });
        expect(parsed.verdict).toBe('parsed');
    });
    it('payments are credits (the CR printed beside them), the rest are charges the statement\'s own arithmetic proves', () => {
        const proof = proveDirections(parsed, { card: true });
        expect(proof.rows.map(r => r.direction)).toEqual(['credit', 'debit', 'debit', 'debit', 'credit', 'debit']);
        expect(proof.rows.every(r => !r.needsReview)).toBe(true);
    });
    it('the minimum payment, its date, the closing balance and the last day of the statement are kept as facts', () => {
        expect(parsed.due).toEqual({ date: '2026-11-24', minimum: 4200, closing: 121750.5, periodEnd: '2026-10-31' });
    });
    it('the titles may stand on separate lines, and the figures may be written beside their titles', () => {
        const apart = P.parseStatement([...head, ...body, 'Payment Due Date', 'Min Amt. Due', 'Closing Balance', '24 Nov 2026 4,200.00 121,750.50'].join('\n'));
        expect(apart.rows.map(r => r.amount)).toEqual(AMOUNTS);
        expect(apart.due).toMatchObject({ date: '2026-11-24', minimum: 4200, closing: 121750.5 });
        const beside = P.parseStatement([...head, ...body, 'Minimum Payment Due 4,200.00 Payment Due Date 24/11/2026', 'Closing Balance 121,750.50'].join('\n'));
        expect(beside.rows.map(r => r.amount)).toEqual(AMOUNTS);
        expect(beside.reconciliation.ok).toBe(true);
        expect(beside.due).toMatchObject({ date: '2026-11-24', minimum: 4200 });
    });
    it('one stray line with two figures does not make a balance column out of a page of single amounts', () => {
        const stray = P.parseStatement([...head, ...body, 'Reference 4 Reward 120.00 480.00'].join('\n'));
        expect(stray.layout.balanceColumn).toBe(false);
        expect(stray.rows.slice(0, 6).map(r => r.amount)).toEqual(AMOUNTS);
    });
    it('a statement that really has a running balance is still read by it', () => {
        const bank = P.parseStatement(['Account Statement', 'Date Narration Debit Credit Balance', 'Opening Balance 10,000.00', '01/03/2026 SHOP 500.00 9,500.00', '02/03/2026 SALARY 2,000.00 11,500.00', '03/03/2026 FUEL 1,500.00 10,000.00', 'Closing Balance 10,000.00'].join('\n'));
        expect(bank.layout.balanceColumn).toBe(true);
        expect(bank.reconciliation.ok).toBe(true);
    });
    it('a statement with no minimum payment has no due', () => {
        const none = P.parseStatement([...head, ...body, 'Closing Balance 121,750.50'].join('\n'));
        expect(none.due.minimum).toBe(null);
        expect(none.due.date).toBe('');
    });
});

describe('the record kept for a minimum payment', () => {
    const base = { due: { date: '2026-11-24', minimum: 4200, closing: 121750.5, periodEnd: '2026-10-31' }, sourcePath: 'wf-mail/o/items/a', bank: 'HNB', last4: '4444', statementType: 'credit_card', now: 1000 };
    it('is one per statement, in whole cents, with the card it belongs to', () => {
        const r = cardDueRecord(base);
        expect(r).toMatchObject({ minimum: 4200, dueDate: '2026-11-24', closing: 121750.5, statementEnd: '2026-10-31', card_last4: '4444', statementKey: 'wf-mail/o/items/a', source: 'statement' });
        expect(cardDueRecord(base).id).toBe(r.id);
    });
    it('is only for a card statement that prints a minimum above zero and a real date', () => {
        expect(cardDueRecord({ ...base, statementType: 'bank_account' })).toBe(null);
        expect(cardDueRecord({ ...base, due: { ...base.due, minimum: 0 } })).toBe(null);
        expect(cardDueRecord({ ...base, due: { ...base.due, date: '2026-02-30' } })).toBe(null);
        expect(cardDueRecord({ ...base, due: null })).toBe(null);
    });
    it('a second reading replaces it, never doubles it, and an owner\'s "I have paid this" is never reopened', () => {
        const r = cardDueRecord(base), once = withCardDue([], r);
        expect(once).toHaveLength(1);
        expect(withCardDue(once, r)).toBe(null);
        const better = withCardDue(once, cardDueRecord({ ...base, due: { ...base.due, minimum: 4300 } }));
        expect(better).toHaveLength(1);
        expect(better[0].minimum).toBe(4300);
        expect(withCardDue([{ ...r, paidManually: true }], cardDueRecord({ ...base, due: { ...base.due, minimum: 4300 } }))).toBe(null);
    });
});

describe('the section on the CC One-Time page', () => {
    const rec = { id: 'd1', bank: 'HNB', card_last4: '4444', minimum: 4200, dueDate: '2026-11-24', closing: 121750.5, statementEnd: '2026-10-31' };
    const at = (today, payments = [], records = [rec]) => cardTabs.dues(records, payments, { today });
    it('counts the days, and is "open" with time, "soon" in the last five days, "late" once the date has passed', () => {
        expect(at('2026-11-06')[0]).toMatchObject({ state: 'open', daysLeft: 18, minimum: 4200 });
        expect(at('2026-11-20')[0]).toMatchObject({ state: 'soon', daysLeft: 4 });
        expect(at('2026-11-24')[0]).toMatchObject({ state: 'soon', daysLeft: 0 });
        expect(at('2026-11-27')[0]).toMatchObject({ state: 'late', daysLeft: -3 });
    });
    it('payments to that card after the statement\'s last day cover it; one dated before it, or on another card, does not', () => {
        const pay = (date, amount, last4 = '4444') => ({ date, amount, card_last4: last4 });
        expect(at('2026-11-10', [pay('2026-11-05', 4200)])[0]).toMatchObject({ state: 'covered', paid: 4200, short: 0 });
        expect(at('2026-11-10', [pay('2026-11-02', 3000), pay('2026-11-08', 1200)])[0]).toMatchObject({ state: 'covered', paid: 4200 });
        expect(at('2026-11-10', [pay('2026-11-05', 1000)])[0]).toMatchObject({ state: 'open', paid: 1000, short: 3200 });
        expect(at('2026-11-10', [pay('2026-10-31', 9000)])[0]).toMatchObject({ state: 'open', paid: 0 });
        expect(at('2026-11-10', [pay('2026-11-05', 9000, '9999')])[0]).toMatchObject({ state: 'open', paid: 0 });
    });
    it('shows only the latest ask of each card, and drops an old one that was met', () => {
        const older = { ...rec, id: 'd0', minimum: 3900, dueDate: '2026-10-24' };
        expect(at('2026-11-06', [], [older, rec]).map(d => d.id)).toEqual(['d1']);
        expect(at('2026-12-20', [{ date: '2026-11-05', amount: 5000, card_last4: '4444' }])).toEqual([]);
        expect(at('2027-03-01')).toEqual([]);
    });
    it('the owner can say it is paid; the card that needs the owner comes first', () => {
        expect(at('2026-11-06', [], [{ ...rec, paidManually: true }])[0].state).toBe('paid');
        const other = { ...rec, id: 'd2', bank: 'NTB', card_last4: '1111', dueDate: '2026-11-08' };
        expect(at('2026-11-06', [], [rec, other]).map(d => d.id)).toEqual(['d2', 'd1']);
    });
    it('draws the amount, the date and the days; the balance is named as not the minimum; nothing is drawn for no card', () => {
        const html = cardTabs.renderDues(at('2026-11-06'), { fmt: n => 'LKR ' + n.toFixed(2) });
        expect(html).toContain('Minimum payment due');
        expect(html).toContain('Pay at least');
        expect(html).toContain('LKR 4200.00');
        expect(html).toContain('24 Nov 2026');
        expect(html).toContain('in 18 days');
        expect(html).toContain('LKR 121750.50');
        expect(html).toContain('data-due-paid="d1"');
        expect(cardTabs.renderDues([], {})).toBe('');
    });
});

async function file(text) {
    const owner = { uid: 'u', email: 'owner@example.com' }, mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'cards@hnb.lk', kind: 'address', status: 'approved', name: 'HNB', domain: 'hnb.lk' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ccinstall: [], loans: [], subscriptions: [], cheques: [], settings: { cardRegistry: { 4444: { type: 'credit_card', bank: 'HNB', name: 'Platinum' } } } },
        [sourcePath]: { uid: 'u', bank: 'HNB', filename: 'card.pdf', from: 'cards@hnb.lk', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-11-02T05:00:00Z') },
    });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        await runStatementSync({ action: 'drain', db, owner, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), read: readStatement, open: async () => [{ password: 'p', bank: 'HNB' }], settle: settleStatement,
            board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment: async () => ({ bytes: textPdf(text.split('\n')), filename: 'card.pdf', contentSha256: 'x' }) });
    } finally { spy.mockRestore(); }
    return { user: data.get('users/u'), item: data.get(sourcePath), data, db, sourcePath };
}

describe('end to end through the statement worker', () => {
    it('files every row at its printed amount, keeps the minimum payment as its own record, and puts nothing on the books for it', async () => {
        const { user, item } = await file(STATEMENT);
        const filed = [...user.cconetime, ...user.ccPayments, ...user.ccinstall, ...user.expenses];
        expect(filed.map(r => r.amount).sort((a, b) => a - b)).toEqual([...AMOUNTS].sort((a, b) => a - b));
        expect(filed.some(r => r.amount === 4200 || r.date === '2026-11-24')).toBe(false);
        expect(user.ccPayments.map(r => r.amount).sort()).toEqual([15000, 5000]);
        expect(user.cardDues).toHaveLength(1);
        expect(user.cardDues[0]).toMatchObject({ minimum: 4200, dueDate: '2026-11-24', closing: 121750.5, card_last4: '4444', source: 'statement' });
        expect(item.status).toBe('filed');
    });
    it('removing the statement removes its minimum payment with it (tombstoned)', async () => {
        const { sourcePath, db, data } = await file(STATEMENT);
        await unfileStatement({ db, uid: 'u', itemRef: db.doc(sourcePath) });
        const back = data.get('users/u');
        expect(back.cardDues || []).toHaveLength(0);
        expect(Object.keys((back._tomb || {}).cardDues || {})).toHaveLength(1);
    });
});
