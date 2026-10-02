import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { toCents, fromCents, allocateTopUps, applyCardSettlement, settleCards } from '../cc-fifo.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { healCardSettlement } from '../statement-sync.js';
import { createFirestore } from './helpers/fake-firestore.js';

// CARD PAYMENTS SETTLE CARD CHARGES OLDEST FIRST, TO THE CENT. One pool of every payment ever made to the card; the charges walked from the oldest; each paid when the pool covers it in full; the first one it
// cannot cover freezes the rest and what is left is carried; recomputed from the whole timeline every time. The page's engine (wealthflow-cc-reconcile.js) and the worker's (cc-fifo.mjs) are the same rule.

const day = (n) => `2026-04-${String(n).padStart(2, '0')}`;
const charge = (id, amount, date, extra = {}) => ({ id, amount, date, ...extra });
const idsOf = (res) => ({ paid: res.settledIds, waiting: res.unsettledIds });

describe('exact cents', () => {
    it('amounts are read from their decimal text, never through a float', () => {
        expect(toCents(0.1 + 0.2)).toBe(30);                       // 0.30000000000000004
        expect(toCents('1,234.50')).toBe(123450);
        expect(toCents(1234.565)).toBe(123457);                    // the third decimal rounds the cent, half up
        expect(toCents(1.005)).toBe(101);                          // a binary float would say 100
        expect(toCents('0.004')).toBe(0);
        expect(toCents(1e-7)).toBe(0);
        expect(toCents('')).toBe(0); expect(toCents(null)).toBe(0); expect(toCents('abc')).toBe(0); expect(toCents(NaN)).toBe(0);
        expect(toCents(-5.25)).toBe(-525); expect(toCents('99999999.99')).toBe(9999999999);
        expect(fromCents(123450)).toBe('1234.50'); expect(fromCents(5)).toBe('0.05'); expect(fromCents(-525)).toBe('-5.25'); expect(fromCents(0)).toBe('0.00');
    });
    it('ten 0.10 payments are exactly 1.00, and a charge of 1.00 is covered by them — no tolerance, no drift', () => {
        const pays = Array.from({ length: 10 }, () => ({ amount: 0.1 }));
        const res = allocateTopUps([charge('a', 1, day(1))], pays);
        expect(res.creditCents).toBe(100); expect(res.settledIds).toEqual(['a']); expect(res.carryCents).toBe(0);
        // one cent short is not covered
        expect(allocateTopUps([charge('a', 1.01, day(1))], pays).settledIds).toEqual([]);
    });
    it('a pool that passes through ten thousand rows ends exactly where integer arithmetic says', () => {
        let seed = 5; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
        const rows = Array.from({ length: 10000 }, (_, i) => charge(i, (Math.floor(rnd() * 9000000) / 100).toFixed(2), `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`));
        const total = rows.reduce((s, r) => s + toCents(r.amount), 0);
        const res = allocateTopUps(rows, [{ amount: fromCents(total) }]);
        expect(res.settledIds.length).toBe(10000); expect(res.carryCents).toBe(0); expect(res.creditCents).toBe(total);
        const short = allocateTopUps(rows, [{ amount: fromCents(total - 1) }]);
        expect(short.unsettledIds.length).toBe(1); expect(short.blocked.needsCents).toBe(1);   // exactly one cent short: only the newest is left, needing exactly one cent
    });
});

describe('the walk', () => {
    const debits = [charge('apr20a', 100000, day(20)), charge('apr20b', 15000, day(20)), charge('apr25', 20000, day(25)), charge('may10', 50000, '2026-05-10')];
    it('the owner\'s worked example: +50k clears only the 15k and carries 35k; +100k more clears the 100k and the 20k', () => {
        const a = allocateTopUps(debits, [{ amount: 50000 }]);
        expect(idsOf(a)).toEqual({ paid: ['apr20b'], waiting: ['apr20a', 'apr25', 'may10'] });
        expect(a.carryCents).toBe(3500000);
        expect(a.blocked).toEqual({ id: 'apr20a', amountCents: 10000000, needsCents: 6500000 });
        expect(a.detail.map(d => d.state)).toEqual(['paid', 'blocked', 'waiting', 'waiting']);
        const b = allocateTopUps(debits, [{ amount: 50000 }, { amount: 100000 }]);
        expect(idsOf(b)).toEqual({ paid: ['apr20b', 'apr20a', 'apr25'], waiting: ['may10'] });
        expect(b.carryCents).toBe(1500000); expect(b.blocked.needsCents).toBe(3500000);
    });
    it('an older charge the pool cannot cover blocks every newer one, however small', () => {
        const res = allocateTopUps([charge('big', 100000, day(1)), charge('tiny', 10, day(2))], [{ amount: 5000 }]);
        expect(res.settledIds).toEqual([]); expect(res.carryCents).toBe(500000);
    });
    it('the same day: the smaller amount first; the same day and amount: the order given', () => {
        const res = allocateTopUps([charge('b', 500, day(3)), charge('a', 200, day(3)), charge('c', 200, day(3))], [{ amount: 400 }]);
        expect(res.settledIds).toEqual(['a', 'c']);
    });
    it('the answer does not depend on the order things arrived in, and running it again changes nothing', () => {
        let seed = 9; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
        for (let run = 0; run < 400; run += 1) {
            const rows = Array.from({ length: 1 + Math.floor(rnd() * 12) }, (_, i) => charge(`c${i}`, (50 + Math.floor(rnd() * 90000)) / 100, `2026-0${1 + Math.floor(rnd() * 6)}-${String(1 + Math.floor(rnd() * 27)).padStart(2, '0')}`));
            const pays = Array.from({ length: Math.floor(rnd() * 5) }, () => ({ amount: Math.floor(rnd() * 120000) / 100 }));
            const a = allocateTopUps(rows, pays), b = allocateTopUps([...rows].reverse().sort(() => rnd() - 0.5), [...pays].reverse());
            expect([...a.settledIds].sort()).toEqual([...b.settledIds].sort());
            expect(a.carryCents).toBe(b.carryCents);
            expect(allocateTopUps(rows, pays)).toEqual(a);
            // the paid charges are always a PREFIX of the walk: nothing newer is paid while an older one waits
            expect(a.detail.map(d => d.state).join(',')).toMatch(/^(paid,?)*(blocked(,waiting)*)?$/);
        }
    });
    it('a new payment un-freezes the charges in order, and the carried money joins it', () => {
        const before = allocateTopUps(debits, [{ amount: 50000 }]);
        expect(before.carryCents).toBe(3500000);                                           // 35k carried; the frozen 100k needs 65k more
        const after = allocateTopUps(debits, [{ amount: 50000 }, { amount: 65000 }]);      // exactly what it needed: 115k pays the 15k and the 100k
        expect(after.settledIds).toEqual(['apr20b', 'apr20a']);
        expect(after.carryCents).toBe(0);
        expect(after.blocked).toEqual({ id: 'apr25', amountCents: 2000000, needsCents: 2000000 });
    });
    it('a deleted payment re-opens what it had cleared', () => {
        const two = allocateTopUps(debits, [{ amount: 50000 }, { amount: 100000 }]);
        const one = allocateTopUps(debits, [{ amount: 50000 }]);
        expect(two.settledIds.length).toBe(3); expect(one.settledIds.length).toBe(1);
    });
});

describe('a card\'s document', () => {
    const doc = () => ({
        cconetime: [
            { id: 'a', desc: 'Keells', amount: 3000, date: day(2), bank: 'AMEX', card_last4: '0276' },
            { id: 'b', desc: 'Cash advance', amount: 10000, serviceFee: 250.1, date: day(5), bank: 'American Express (AMEX)', card_last4: '0276', combinedTotal: 10250.1 },
            { id: 'c', desc: 'Fuel', amount: 7000, date: day(9), bank: 'AMEX', card_last4: '0276' },
            { id: 'o', desc: 'Other card', amount: 900, date: day(3), bank: 'HNB', card_last4: '1111' },
            { id: 'm', desc: 'Paid by hand', amount: 400, date: day(1), bank: 'AMEX', card_last4: '0276', paid: true, paidManually: true },
        ],
        ccPayments: [{ id: 'p1', amount: 13250.1, date: day(10), bank: 'AMEX', card_last4: '0276' }],
    });
    it('two spellings of one bank are one card; each card has its own pool; a hand-paid charge is outside it; a fee is added in cents', () => {
        const user = doc(), out = applyCardSettlement(user, 1234);
        const by = Object.fromEntries(user.cconetime.map(r => [r.id, r]));
        expect([by.a.paid, by.b.paid, by.c.paid, by.o.paid, by.m.paid].map(Boolean)).toEqual([true, true, false, false, true]);
        expect(by.a.autoPaid && by.b.autoPaid).toBe(true); expect(by.a.paidAt).toBe(1234); expect(by.m.autoPaid).toBeUndefined();
        expect(out).toMatchObject({ changed: 2, settled: 2, pending: 2 });
        const card = out.cards.find(c => c.key.endsWith('|0276'));
        expect(card.carryCents).toBe(0); expect(card.blocked.needsCents).toBe(700000);
        expect(applyCardSettlement(user, 99).changed).toBe(0);                                  // idempotent
    });
    it('a payment removed reopens its charges; paidAt goes with the payment', () => {
        const user = doc(); applyCardSettlement(user, 1);
        user.ccPayments = [];
        applyCardSettlement(user, 2);
        expect(user.cconetime.filter(r => r.autoPaid)).toEqual([]);
        expect(user.cconetime.find(r => r.id === 'a')).not.toHaveProperty('paidAt');
        expect(user.cconetime.find(r => r.id === 'm').paid).toBe(true);
    });
});

describe('the page and the worker run the same rule', () => {
    const script = readFileSync(new URL('../wealthflow-cc-reconcile.js', import.meta.url), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox); vm.runInContext(script, sandbox);
    const page = sandbox.window.WFReconcile;
    it('same settled charges, same carry, same frozen charge on 3000 random cards', () => {
        let seed = 21; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
        for (let run = 0; run < 3000; run += 1) {
            const rows = Array.from({ length: Math.floor(rnd() * 14) }, (_, i) => charge(`c${i}`, (Math.floor(rnd() * 5000000) / 100).toFixed(2), `2026-0${1 + Math.floor(rnd() * 9)}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`));
            const pays = Array.from({ length: Math.floor(rnd() * 6) }, () => ({ amount: rnd() < 0.2 ? '1,000.10' : (Math.floor(rnd() * 8000000) / 100).toFixed(2), date: '2026-09-01' }));
            const server = allocateTopUps(rows, pays), client = page.reconcileCard(rows, pays);
            expect(client.settledIds).toEqual(server.settledIds); expect(client.unsettledIds).toEqual(server.unsettledIds);
            expect(Math.round(client.carry * 100)).toBe(server.carryCents);
            expect(client.blocked ? { id: client.blocked.id, needs: Math.round(client.blocked.needs * 100) } : null).toEqual(server.blocked ? { id: server.blocked.id, needs: server.blocked.needsCents } : null);
        }
    });
    it('the page reads the same exact cents', () => {
        for (const v of [0.1 + 0.2, '1,234.50', 1234.565, 1.005, '0.004', 1e-7, '', null, -5.25]) expect(page.toCents(v), String(v)).toBe(toCents(v));
    });
});

describe('through the real worker: the moment a card payment is filed the charges are walked', () => {
    const fakeDb = createFirestore;
    const rows = [{ date: '2026-04-12', amount: 4000, description: 'CASH PAYMENT-FINACLE', direction: 'credit', directionSource: 'balance', needsReview: false, valid: true }];
    it('a payment that covers only the older charge pays it, carries nothing, and leaves the newer one waiting', async () => {
        const user = { cconetime: [
            { id: 'old', desc: 'Keells', amount: 3000, combinedTotal: 3000, date: '2026-04-02', bank: 'AMEX', card_last4: '0276', paid: false },
            { id: 'new', desc: 'Fuel', amount: 7000, combinedTotal: 7000, date: '2026-04-09', bank: 'AMEX', card_last4: '0276', paid: false }] };
        const w = fakeDb({ 'users/u': user, 'sources/card': { uid: 'u', cursor: 0, leaseToken: 'token', leaseUntil: 9000, encrypted: 'x' } });
        const src = w.db.collection('sources').doc('card');
        await settleStatement({ db: w.db, uid: 'u', sourceRef: src, leaseToken: 'token', now: 1000, rows, decisions: [{ module: 'ccPayments', category: 'Card Payment', verified: true }], cursor: 0, totalRows: 1, bank: 'AMEX', last4: '0276', statementType: 'credit_card', cardRegistry: { '0276': { bank: 'AMEX' } } });
        const after = w.data.get('users/u');
        expect(after.ccPayments).toHaveLength(1);
        expect(Object.fromEntries(after.cconetime.map(r => [r.id, [!!r.paid, !!r.autoPaid]]))).toEqual({ old: [true, true], new: [false, false] });
    });
    it('the periodic heal catches what no filing walked (a payment deleted, a charge typed late) and logs counts only', async () => {
        const user = { cconetime: [{ id: 'a', desc: 'Keells', amount: 3000, combinedTotal: 3000, date: '2026-04-02', bank: 'AMEX', card_last4: '0276', paid: true, autoPaid: true, paidAt: 5 }], ccPayments: [] };
        const w = fakeDb({ 'users/u': user });
        const lines = [];
        const out = await healCardSettlement({ db: w.db, uid: 'u', now: 7, log: l => lines.push(l) });
        expect(out.changed).toBe(1);
        expect(w.data.get('users/u').cconetime[0]).toMatchObject({ paid: false, autoPaid: false });
        expect(w.data.get('users/u').cconetime[0]).not.toHaveProperty('paidAt');
        expect(JSON.parse(lines[0])).toEqual({ evt: 'card-settlement-heal', changed: 1, settled: 0, pending: 1, cards: 1, carried: 0 });
        expect(lines.join('')).not.toMatch(/Keells|3000|0276/);
        expect((await healCardSettlement({ db: w.db, uid: 'u', now: 8, log: () => {} })).changed).toBe(0);
    });
});
