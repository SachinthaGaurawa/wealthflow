import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { billRefOf, evidenceOf, identityOf, subscriptionToCreate } from '../statement-subscriptions.mjs';
import { matchSubscriptionForDebit } from '../statement-links.mjs';
import { loadParser } from './statement-fixtures.mjs';

// What a statement payment is FOR (a number, a bill reference, a company) and what a month holds when it was paid more than once.
// The page's engine (wealthflow-subscriptions.js) and the email worker read the same identity rule. Every number, reference and amount here is invented.

const ROOT = process.cwd();
const ENGINE = fs.readFileSync(path.join(ROOT, 'wealthflow-subscriptions.js'), 'utf8');
const BATCHES = fs.readFileSync(path.join(ROOT, 'wealthflow-batches.js'), 'utf8');

let S;
beforeAll(async () => {
    const window = { console: { log() {} } };
    globalThis.window = window;
    vi.resetModules();
    await import('../wealthflow-sub-identity.js');          // a page has a window: the module sets window.WFSubIdentity, as the page's module script does
    expect(window.WFSubIdentity).toBeTruthy();
    expect(window.WFSubIdentity.evidenceOf({ description: 'IB BILL PAYMENT 0771110001' }).phones).toEqual(['771110001']);
    new Function('window', ENGINE)(window);
    S = window.WFSubs;
});

const pay = (description, amount, date) => ({ description, amount, date, direction: 'debit' });
/** Feed rows through the page's engine one after another, the way one upload does. */
function upload(rows, seed = { subs: [], map: {} }, route = {}) {
    let subs = seed.subs, map = seed.map; const results = [];
    for (const row of rows) {
        const r = S.applyToArrays(row, { subName: 'Ib Bill Payment', category: 'Telecom', ...route }, subs, map);
        subs = r.subscriptions; map = r.map; results.push(r);
    }
    return { subs, map, results };
}

describe('a bill reference is read from an internet-banking bill payment', () => {
    it('reads one reference, never a phone number, a card number or a bare number elsewhere', () => {
        expect(billRefOf('Ib Bill Payment Abc123456')).toBe('ABC123456');
        expect(billRefOf('IB BILL PAYMENT 5550123')).toBe('5550123');
        expect(billRefOf('Ib Bill Payment 0771110001')).toBe('');              // that is a phone number
        expect(billRefOf('Pos Transaction Keells 1234567')).toBe('');          // not a bill payment
        expect(billRefOf('Ib Bill Payment 4111111111111111')).toBe('');        // a card number is too long to be a bill reference
        expect(billRefOf('Ib Bill Payment Abc123456 Xyz654321')).toBe('');     // two references are not guessed between
    });
    it('the entry made for a reference is named after it and carries it', () => {
        const spec = subscriptionToCreate(pay('Ib Bill Payment Abc123456', 1500, '2026-06-07'));
        expect(spec).toMatchObject({ name: 'Bill payment ABC123456', merchantKeys: ['ref:abc123456'] });
        expect(identityOf({ name: spec.name, merchantKeys: spec.merchantKeys }).refs).toEqual(['ABC123456']);
        expect(subscriptionToCreate(pay('Ib Bill Payment Loan Abc123456', 1500, '2026-06-07'))).toBeNull();   // a loan is not a subscription
    });
});

describe('one number or one reference is one entry — never "the entry with the same name"', () => {
    const rows = [
        pay('Ib Bill Payment 0771110001', 198, '2026-07-07'),
        pay('Ib Bill Payment 0721110002', 100, '2026-07-16'),
        pay('Ib Bill Payment 0771110001', 50, '2026-07-22'),
        pay('Ib Bill Payment Abc123456', 12640, '2026-07-15'),
        pay('Ib Bill Payment Xyz654321', 8500, '2026-07-22'),
    ];
    it('five payments to four different bills make four entries', () => {
        const { subs } = upload(rows);
        expect(subs).toHaveLength(4);
        const byName = Object.fromEntries(subs.map((s) => [s.name, s]));
        expect(Object.keys(byName).sort()).toEqual(['Bill payment ABC123456', 'Bill payment XYZ654321', 'Mobile 072 111 0002', 'Mobile 077 111 0001']);
        expect(byName['Mobile 077 111 0001'].history.map((h) => h.amount)).toEqual([198, 50]);
        expect(byName['Mobile 072 111 0002'].history.map((h) => h.amount)).toEqual([100]);
    });
    it('the next month goes to the same four entries, and reading the same statement again changes nothing', () => {
        const first = upload(rows);
        const next = upload([pay('Ib Bill Payment 0771110001', 200, '2026-08-07'), pay('Ib Bill Payment Xyz654321', 8500, '2026-08-22')], first);
        expect(next.subs).toHaveLength(4);
        const again = upload(rows, next);
        expect(again.subs).toHaveLength(4);
        expect(JSON.stringify(again.subs.map((s) => s.history))).toBe(JSON.stringify(next.subs.map((s) => s.history)));
        expect(again.results.every((r) => r.paymentAdded === false)).toBe(true);
    });
    it('an entry with another number is never matched by its name', () => {
        const mine = { id: 'm', name: 'Mobile 077 111 0001', category: 'Telecom', amount: 100, history: [], monthOverrides: {}, merchantKeys: ['mobile:0771110001'] };
        const found = S.findExisting(pay('Ib Bill Payment 0721110002', 100, '2026-07-16'), { subName: 'Mobile 077 111 0001' }, [mine], {});
        expect(found.sub).toBeNull();
    });
});

describe('a month holds what was paid in it, in total', () => {
    it('three reloads of 100 in one month are 300 for the month, and each stays in the list', () => {
        const { subs, results } = upload([
            pay('Ib Bill Payment 0771110001', 100, '2026-07-01'),
            pay('Ib Bill Payment 0771110001', 100, '2026-07-10'),
            pay('Ib Bill Payment 0771110001', 100, '2026-07-25'),
        ]);
        expect(subs).toHaveLength(1);
        expect(subs[0].monthOverrides['2026-07']).toBe(300);
        expect(subs[0].amount).toBe(300);
        expect(subs[0].history).toHaveLength(3);
        expect(results.filter((r) => r.paymentAdded)).toHaveLength(3);
    });
    it('adds in whole cents, so the total is exact', () => {
        const { subs } = upload([pay('Ib Bill Payment 0771110001', 0.1, '2026-07-01'), pay('Ib Bill Payment 0771110001', 0.2, '2026-07-02'), pay('Ib Bill Payment 0771110001', 1658.18, '2026-07-03')]);
        expect(subs[0].monthOverrides['2026-07']).toBe(1658.48);
    });
    it('another month is its own total, and an older statement does not replace the headline of a newer month', () => {
        const { subs } = upload([pay('Ib Bill Payment 0771110001', 200, '2026-08-07'), pay('Ib Bill Payment 0771110001', 150, '2026-07-07'), pay('Ib Bill Payment 0771110001', 50, '2026-07-20')]);
        expect(subs[0].monthOverrides).toEqual({ '2026-08': 200, '2026-07': 200 });
        expect(subs[0].amount).toBe(200);                      // August is the latest month
    });
    it('a phone company paid with no number on the line (a card reload) keeps its own entry, summed by month, apart from the numbers', () => {
        const rows = [pay('Pos Transaction Dialog Axiata Plc Colombo 02', 385, '2026-07-06'), pay('Pos Transaction Dialog Axiata Plc Colombo 02', 198, '2026-07-06'), pay('Ib Bill Payment 0771110001', 198, '2026-07-07'), pay('Pos Transaction Dialog Axiata Plc Colombo 02', 100, '2026-07-07')];
        const { subs } = upload(rows, undefined, { subName: 'Dialog' });
        expect(subs).toHaveLength(2);
        const dialog = subs.find((s) => s.name === 'Dialog'), number = subs.find((s) => /077 111 0001/.test(s.name));
        expect(dialog.monthOverrides['2026-07']).toBe(683);
        expect(number.monthOverrides['2026-07']).toBe(198);
    });
});

describe('a month an earlier version added up wrongly is corrected, a figure the owner typed is not', () => {
    const mk = (override) => ({ id: 'c', name: 'CEB', amount: 1753, history: [{ month: '2026-07', amount: 2900, date: '2026-07-07', source: 'statement' }, { month: '2026-07', amount: 1753, date: '2026-07-31', source: 'statement' }], monthOverrides: { '2026-07': override } });
    it('a month that shows only the last payment is corrected to the total', () => {
        const sub = mk(1753);
        expect(S.healMonths(sub)).toEqual(['2026-07']);
        expect(sub.monthOverrides['2026-07']).toBe(4653);
        expect(sub.amount).toBe(4653);
        expect(S.healMonths(sub)).toEqual([]);                  // once
    });
    it('a figure that is not one of the payments was typed by the owner and stays', () => {
        const sub = mk(4000);
        expect(S.healMonths(sub)).toEqual([]);
        expect(sub.monthOverrides['2026-07']).toBe(4000);
    });
});

describe('the worker reads a number, a reference and a phone company by the same rule', () => {
    const entry = (over) => ({ id: 'e', cycle: 'monthly', amount: 100, createdAt: '2026-01-01T00:00:00.000Z', history: [], monthOverrides: {}, ...over });
    it('a reference finds its own entry for any amount, and the month\'s second payment is added to it', () => {
        const mine = entry({ id: 'r1', name: 'Bill payment ABC123456', merchantKeys: ['ref:abc123456'], history: [{ month: '2026-07', amount: 1500, date: '2026-07-02', source: 'statement' }] });
        const other = entry({ id: 'r2', name: 'Bill payment XYZ654321', merchantKeys: ['ref:xyz654321'] });
        expect(matchSubscriptionForDebit(pay('IB BILL PAYMENT ABC123456', 9999, '2026-07-20'), [other, mine])).toBe(mine);
        expect(matchSubscriptionForDebit(pay('IB BILL PAYMENT QRS777777', 1500, '2026-07-20'), [other, mine])).toBeNull();
    });
    it('every card reload of the month goes to the phone company\'s own entry; a number goes to its number', () => {
        const dialog = entry({ id: 'd', name: 'Dialog', merchantKeys: ['brand:dialog'], history: [{ month: '2026-07', amount: 385, date: '2026-07-06', source: 'statement' }] });
        const number = entry({ id: 'n', name: 'Mobile 077 111 0001', merchantKeys: ['mobile:0771110001'] });
        expect(matchSubscriptionForDebit(pay('POS TRANSACTION DIALOG AXIATA PLC COLOMBO 02', 3250.72, '2026-07-09'), [dialog, number])).toBe(dialog);
        expect(matchSubscriptionForDebit(pay('IB BILL PAYMENT 0771110001', 198, '2026-07-07'), [dialog, number])).toBe(number);
        expect(matchSubscriptionForDebit(pay('IB BILL PAYMENT 0721110002', 198, '2026-07-07'), [dialog, number])).toBeNull();   // another number is never put on the company's entry
    });
    it('the page and the worker name the same entry for the same row', () => {
        const row = pay('Ib Bill Payment 0771110001', 198, '2026-07-07');
        const spec = subscriptionToCreate(row);
        const { subs } = upload([row]);
        expect(subs[0].name).toBe(spec.name);
        expect(subs[0].merchantKeys).toEqual(spec.merchantKeys);
        expect(evidenceOf(row).phones).toEqual(['771110001']);
    });
});

describe('a payment the old version put on one mixed entry is taken off it, and Undo puts it back', () => {
    // the old engine: one entry called "Ib Bill Payment" held the payments of every number, and listed each row's own key
    const lumped = () => ({ id: 'L', name: 'Ib Bill Payment', category: 'Telecom', amount: 50, autoCreated: true, cycle: 'monthly', createdAt: '2026-06-01T00:00:00.000Z',
        merchantKeys: ['desc:bill-payment-0771110001', 'desc:bill-payment-0721110002'],
        history: [{ month: '2026-07', amount: 198, date: '2026-07-07', source: 'statement' }, { month: '2026-07', amount: 100, date: '2026-07-16', source: 'statement' }],
        monthOverrides: { '2026-07': 100 } });
    it('reading the statement again files the payment on its number and the mixed entry loses exactly that payment', () => {
        const seed = { subs: [lumped()], map: {} };
        const first = upload([pay('Ib Bill Payment 0771110001', 198, '2026-07-07')], seed);
        const L = first.subs.find((s) => s.id === 'L'), mine = first.subs.find((s) => /077 111 0001/.test(s.name));
        expect(mine.history.map((h) => h.amount)).toEqual([198]);
        expect(L.history.map((h) => h.amount)).toEqual([100]);
        expect(L.monthOverrides['2026-07']).toBe(100);
        expect(first.results[0].moved).toHaveLength(1);
        const second = upload([pay('Ib Bill Payment 0721110002', 100, '2026-07-16')], { subs: first.subs, map: first.map });
        expect(second.subs.find((s) => s.id === 'L')).toBeUndefined();         // nothing left on it: it was made by an upload and goes
        expect(second.subs).toHaveLength(2);
    });
    it('an entry that never listed the row\'s key is never touched', () => {
        const other = { ...lumped(), id: 'K', merchantKeys: ['brand:dialog'] };
        const out = upload([pay('Ib Bill Payment 0771110001', 198, '2026-07-07')], { subs: [other], map: {} });
        expect(out.subs.find((s) => s.id === 'K').history).toHaveLength(2);
    });
    it('Undo of that upload restores the mixed entry exactly', () => {
        const start = { subs: [lumped()], map: {} };
        const state = { subscriptions: JSON.parse(JSON.stringify(start.subs)), subMerchantMap: {}, importBatches: [] };
        const DB = { get: (k) => state[k], set: (k, v) => { state[k] = JSON.parse(JSON.stringify(v)); } };
        const window = { DB, console: { log() {} } };
        new Function('window', BATCHES)(window);
        const batch = { id: 'b1', counts: { subscription: 0 }, ids: {}, loans: [], subs: [] };
        let subs = state.subscriptions, map = {};
        for (const row of [pay('Ib Bill Payment 0771110001', 198, '2026-07-07'), pay('Ib Bill Payment 0721110002', 100, '2026-07-16')]) {
            const r = S.applyToArrays(row, { subName: 'Ib Bill Payment', category: 'Telecom' }, subs, map);
            subs = r.subscriptions; map = r.map;
            window.WFBatch.recordSub(batch, { subId: r.subId, paymentDate: row.date, amount: row.amount, prevAmount: r.prevAmount, createdSub: r.created, moved: r.moved.length ? r.moved : undefined });
        }
        expect(subs).toHaveLength(2);                          // L went; two numbers came
        state.subscriptions = JSON.parse(JSON.stringify(subs)); state.subMerchantMap = map; state.importBatches = [batch];
        window.WFBatch.undo('b1');
        const back = state.subscriptions;
        expect(back).toHaveLength(1);
        expect(back[0].id).toBe('L');
        expect(back[0].history.map((h) => h.amount).sort()).toEqual([100, 198]);
        expect(back[0].monthOverrides['2026-07']).toBe(298);
    });
    it('Undo of one reload of three leaves the month at the other two', () => {
        const state = { subscriptions: [], subMerchantMap: {}, importBatches: [] };
        const DB = { get: (k) => state[k], set: (k, v) => { state[k] = JSON.parse(JSON.stringify(v)); } };
        const window = { DB, console: { log() {} } };
        new Function('window', BATCHES)(window);
        const first = upload([pay('Ib Bill Payment 0771110001', 100, '2026-07-01'), pay('Ib Bill Payment 0771110001', 100, '2026-07-10')]);
        const second = upload([pay('Ib Bill Payment 0771110001', 100, '2026-07-25')], { subs: first.subs, map: first.map });
        const r = second.results[0];
        state.subscriptions = JSON.parse(JSON.stringify(second.subs)); state.subMerchantMap = second.map;
        state.importBatches = [{ id: 'b2', counts: { subscription: 1 }, ids: {}, loans: [], subs: [{ subId: r.subId, paymentDate: '2026-07-25', amount: 100, prevAmount: r.prevAmount, createdSub: false }] }];
        window.WFBatch.undo('b2');
        expect(state.subscriptions[0].monthOverrides['2026-07']).toBe(200);
        expect(state.subscriptions[0].history).toHaveLength(2);
    });
});

describe('the statement reader keeps WHICH BILL a bill payment pays', () => {
    const parser = loadParser(fs);
    const text = `
01/07/2026 OPENING BALANCE 100,000.00
02/07/2026 Ib Bill Payment Abc123456 1,500.00 98,500.00
03/07/2026 Ib Bill Payment 0771110001 198.00 98,302.00
04/07/2026 Ib Bill Payment Xyz654321 8,500.00 89,802.00
05/07/2026 POS KEELLS COLOMBO TXN8830211 2,000.00 87,802.00
`;
    it('the reference stays in the narration after "Bill Payment" and is still taken out of other rows', () => {
        const rows = parser.parseStatement(text).rows;
        expect(rows.map((r) => r.amount)).toEqual([1500, 198, 8500, 2000]);
        expect(rows[0].narration).toMatch(/Ib Bill Payment Abc123456$/);
        expect(rows[1].narration).toMatch(/Ib Bill Payment 0771110001$/);
        expect(rows[2].narration).toMatch(/Ib Bill Payment Xyz654321$/);
        expect(rows[3].narration).not.toMatch(/TXN8830211/);
    });
    it('so three payments are three different bills', () => {
        const rows = parser.parseStatement(text).rows.slice(0, 3);
        const names = rows.map((r) => subscriptionToCreate({ description: r.narration, direction: r.direction }).name);
        expect(new Set(names).size).toBe(3);
        expect(names).toEqual(['Bill payment ABC123456', 'Mobile 077 111 0001', 'Bill payment XYZ654321']);
    });
});
