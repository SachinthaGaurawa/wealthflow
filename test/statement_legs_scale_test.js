import { describe, expect, it } from 'vitest';
import { ownMoneyLegs, looseLegsWhy, ownTransferHash, OWN_TRANSFER_LABEL, CARD_BEFORE_DAYS, CARD_AFTER_DAYS, BANK_DAYS } from '../statement-legs.mjs';
import { transferEvidence } from '../statement-ledger.mjs';
import { bankKeyOf } from '../statement-coverage.mjs';

// WHY THIS FILE EXISTS (production, 2026-10-11 and 2026-10-12): the daily /api/statement-sync run was answered `[WF-SLOW]` at 50 s and on 2026-10-11 died at the platform's sixty seconds. The
// slow part was the books' own arithmetic: pairing every debit with every credit of the same amount (`ownMoneyLegs`, and `looseLegsWhy`, which runs it again and then walks debits x credits a
// second time) is quadratic, and it is synchronous, so while it runs no timer, deadline or watchdog in the process can fire. Measured on one machine: 6,000 filed records = 8 s, 15,000 = 52 s.
// The rule only ever pairs two lines whose amounts are EQUAL TO THE CENT, so each debit is compared with the credits of its own amount and no others.
//
// The oracle below is the quadratic code exactly as it was before the change. The new code must give the same answer, in the same order, on any books.

const cents = value => Math.round(Math.abs(Number(value)) * 100);
const textOf = record => String((record && (record.desc || record.name)) || '');
const dayOf = date => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
const GIVEN_BACK = /\b(?:refund(?:ed)?|revers(?:al|ed)|return(?:ed)?|cash\s*back|rebate|waiver|adjust(?:ment)?|reward|charge\s*back)\b/i;
const ownerWrote = record => { const note = String((record && record.notes) || '').trim(); return !!note && !/^Filed automatically\b/i.test(note) && !/^Card installment charge of\b/i.test(note); };
const system = record => !!record && record.source === 'statement' && !!record.statementKey && Number(record.amount) > 0 && !record.loanLink && !record.subscriptionLink && !ownerWrote(record);
const asTransfer = record => transferEvidence({ description: textOf(record) });
const PURCHASE_LIKE = /\b(?:pos|purchase|atm|cash\s*(?:withdrawal|advance)|withdrawal|bill\s*pay(?:ment)?|utility|merchant|e-?commerce|salary|payroll|interest|fee|charge)\b/i;

function legacyOwnMoneyLegs(user) {
    const list = key => (Array.isArray(user && user[key]) ? user[key] : []);
    const debits = list('expenses').filter(record => system(record) && record.direction !== 'credit');
    const cardCredits = list('ccPayments').filter(record => system(record) && !GIVEN_BACK.test(textOf(record)));
    const bankCredits = list('incomeRecv').filter(system);
    const fits = []; let unworded = 0;
    for (const debit of debits) {
        const at = dayOf(debit.date);
        if (!Number.isFinite(at)) continue;
        if (asTransfer(debit)) for (const credit of cardCredits) {
            const gap = dayOf(credit.date) - at;
            if (credit.statementKey === debit.statementKey || cents(credit.amount) !== cents(debit.amount) || !(gap >= -CARD_BEFORE_DAYS && gap <= CARD_AFTER_DAYS)) continue;
            if (debit.card_last4 && credit.card_last4 && String(debit.card_last4) === String(credit.card_last4)) continue;
            fits.push({ debit, credit, kind: 'card', store: 'ccPayments' });
        }
        for (const credit of bankCredits) {
            const gap = Math.abs(dayOf(credit.date) - at);
            if (credit.statementKey === debit.statementKey || cents(credit.amount) !== cents(debit.amount) || !(gap <= BANK_DAYS)) continue;
            if (!bankKeyOf(debit.bank) || !bankKeyOf(credit.bank) || bankKeyOf(debit.bank) === bankKeyOf(credit.bank)) continue;
            const saidOut = asTransfer(debit), saidIn = asTransfer(credit);
            if (!saidOut && !saidIn) { unworded += 1; continue; }
            if ((!saidOut && PURCHASE_LIKE.test(textOf(debit))) || (!saidIn && PURCHASE_LIKE.test(textOf(credit)))) continue;
            fits.push({ debit, credit, kind: 'bank', store: 'incomeRecv' });
        }
    }
    const byDebit = new Map(), byCredit = new Map();
    for (const fit of fits) {
        byDebit.set(fit.debit, [...(byDebit.get(fit.debit) || []), fit]);
        byCredit.set(fit.credit, [...(byCredit.get(fit.credit) || []), fit]);
    }
    const remove = []; let pairs = 0, left = 0;
    for (const [debit, mine] of byDebit) {
        if (mine.length !== 1 || byCredit.get(mine[0].credit).length !== 1) { left += 1; continue; }
        const { credit, kind, store } = mine[0], hash = ownTransferHash(kind, debit, credit);
        pairs += 1;
        remove.push({ store: 'expenses', record: debit, partner: credit, kind, hash, label: OWN_TRANSFER_LABEL });
        if (kind === 'bank') remove.push({ store, record: credit, partner: debit, kind, hash, label: OWN_TRANSFER_LABEL });
    }
    return { remove, pairs, left, unworded };
}

function legacyLooseLegsWhy(user) {
    const list = key => (Array.isArray(user && user[key]) ? user[key] : []).filter(record => record && record.statementKey && Number(record.amount) > 0);
    const debits = [...list('expenses').map(record => ({ record, store: 'expenses' })), ...list('cconetime').map(record => ({ record, store: 'cconetime' }))].filter(({ record }) => record.direction !== 'credit');
    const credits = [...list('incomeRecv').map(record => ({ record, store: 'incomeRecv' })), ...list('ccPayments').map(record => ({ record, store: 'ccPayments' }))];
    const strict = legacyOwnMoneyLegs(user), planned = new Set(strict.remove.map(entry => entry.record));
    const reasons = {}; let pairs = 0;
    for (const out of debits) {
        for (const into of credits) {
            const gap = dayOf(into.record.date) - dayOf(out.record.date);
            if (into.record.statementKey === out.record.statementKey || cents(into.record.amount) !== cents(out.record.amount) || !(Math.abs(gap) <= 3)) continue;
            if (!asTransfer(out.record) && !asTransfer(into.record)) continue;
            pairs += 1;
            const card = into.store === 'ccPayments', limit = card ? [-CARD_BEFORE_DAYS, CARD_AFTER_DAYS] : [-BANK_DAYS, BANK_DAYS];
            let why = 'would-take-out';
            if (out.store !== 'expenses') why = `debit-in-${out.store}`;
            else if (card && !asTransfer(out.record)) why = 'debit-not-worded-as-transfer';
            else if (!card && ((!asTransfer(out.record) && PURCHASE_LIKE.test(textOf(out.record))) || (!asTransfer(into.record) && PURCHASE_LIKE.test(textOf(into.record))))) why = 'unworded-leg-looks-like-a-purchase';
            else if (card && GIVEN_BACK.test(textOf(into.record))) why = 'card-credit-is-a-refund';
            else if (!card && (!bankKeyOf(out.record.bank) || bankKeyOf(out.record.bank) === bankKeyOf(into.record.bank))) why = 'same-bank-or-unknown';
            else if (out.record.card_last4 && into.record.card_last4 && String(out.record.card_last4) === String(into.record.card_last4)) why = 'same-account';
            else if (out.record.source !== 'statement' || into.record.source !== 'statement') why = 'not-from-a-statement';
            else if (ownerWrote(out.record) || ownerWrote(into.record)) why = 'edited-by-the-owner';
            else if (out.record.loanLink || out.record.subscriptionLink || into.record.loanLink || into.record.subscriptionLink) why = 'tied-to-a-loan-or-subscription';
            else if (!(gap >= limit[0] && gap <= limit[1])) why = `day-gap-${gap > 0 ? '+' : ''}${gap}`;
            else if (!planned.has(out.record)) why = 'ambiguous';
            const key = `${card ? 'card' : 'bank'}:${why}`;
            reasons[key] = (reasons[key] || 0) + 1;
        }
    }
    return { pairs, reasons };
}

// a small deterministic generator, so a failure can be replayed
const seeded = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const BANKS = ['Sampath Bank', 'HNB', 'NTB', 'DFCC', 'Commercial Bank', 'BOC', 'AMEX', ''];
const WORDS = ['CEFT TRANSFER 0741234567', 'INWARD TRANSFER', 'OUTWARD TRANSFER 99', 'POS PURCHASE KEELLS', 'SALARY JULY', 'ATM WITHDRAWAL', 'BILL PAYMENT DIALOG', 'PAYMENT RECEIVED THANK YOU', 'REFUND KEELLS', 'ANNUAL FEE', 'CEFT TRANSFER CREDIT', 'Transfer to savings'];
const NOTES = [undefined, undefined, undefined, '', 'Filed automatically; checked', 'paid mum back', 'Card installment charge of 1,000'];

/** Books with plenty of look-alike amounts (a few dozen distinct sums), a short run of days and several statements, so collisions, ambiguity and every refusal reason occur. */
function books(n, seed) {
    const rnd = seeded(seed), pick = list => list[Math.floor(rnd() * list.length)];
    let id = 1;
    const amounts = Array.from({ length: Math.max(8, Math.floor(n / 25)) }, (_, i) => (i % 5 === 0 ? 1000 + i : (i + 1) * 250 + (i % 3 === 0 ? 0.5 : 0)));
    const record = (store) => {
        const day = 1 + Math.floor(rnd() * 28), date = rnd() < 0.02 ? 'not a date' : `2026-0${1 + Math.floor(rnd() * 3)}-${String(day).padStart(2, '0')}`;
        const out = { id: id++, amount: rnd() < 0.01 ? 0 : pick(amounts), date, desc: pick(WORDS), bank: pick(BANKS), statementKey: rnd() < 0.03 ? '' : `wf-mail/o/items/s${Math.floor(rnd() * 12)}`, source: rnd() < 0.05 ? 'manual' : 'statement', statementRow: id };
        if (store === 'expenses' && rnd() < 0.1) out.direction = 'credit';
        if (rnd() < 0.15) out.card_last4 = pick(['1111', '2222']);
        if (rnd() < 0.04) out.loanLink = 'L1';
        if (rnd() < 0.04) out.subscriptionLink = 'S1';
        const note = pick(NOTES); if (note !== undefined) out.notes = note;
        if (rnd() < 0.02) out.name = out.desc, delete out.desc;
        return out;
    };
    const make = (store, count) => Array.from({ length: count }, () => record(store));
    return { expenses: make('expenses', n), incomeRecv: make('incomeRecv', Math.floor(n / 3)), ccPayments: make('ccPayments', Math.floor(n / 6)), cconetime: make('cconetime', Math.floor(n / 8)) };
}

describe('the pairing of the owner\'s own money gives exactly the answer it gave before, on any books', () => {
    it('is identical to the quadratic rule on 40 random sets of books, in the same order', () => {
        for (let seed = 1; seed <= 40; seed++) {
            const user = books(30 + seed * 7, seed);
            expect(ownMoneyLegs(user), `ownMoneyLegs seed ${seed}`).toEqual(legacyOwnMoneyLegs(user));
            expect(looseLegsWhy(user), `looseLegsWhy seed ${seed}`).toEqual(legacyLooseLegsWhy(user));
        }
    });
    it('really finds pairs in that data (the comparison is not between two empty answers)', () => {
        let pairs = 0, loose = 0, unworded = 0, left = 0;
        for (let seed = 1; seed <= 40; seed++) {
            const user = books(30 + seed * 7, seed), strict = ownMoneyLegs(user);
            pairs += strict.pairs; unworded += strict.unworded; left += strict.left; loose += looseLegsWhy(user).pairs;
        }
        expect(pairs).toBeGreaterThan(20);
        expect(loose).toBeGreaterThan(20);
        expect(unworded).toBeGreaterThan(5);
        expect(left).toBeGreaterThan(5);
    });
    it('the odd records are handled the same: no amount, a text amount, a negative amount, an unreadable date, a missing list', () => {
        const odd = {
            expenses: [{ id: 1, source: 'statement', statementKey: 'a', amount: 'abc', date: '2026-03-01', desc: 'CEFT TRANSFER 1', bank: 'HNB' }, { id: 2, source: 'statement', statementKey: 'a', amount: -500, date: '2026-03-01', desc: 'CEFT TRANSFER 2', bank: 'HNB' },
                { id: 3, source: 'statement', statementKey: 'a', amount: 500, date: 'x', desc: 'CEFT TRANSFER 3', bank: 'HNB' }, { id: 4, source: 'statement', statementKey: 'a', amount: '500.004', date: '2026-03-01', desc: 'CEFT TRANSFER 4', bank: 'HNB' }, null, 7],
            incomeRecv: [{ id: 5, source: 'statement', statementKey: 'b', amount: 500, date: '2026-03-02', desc: 'INWARD TRANSFER', bank: 'NTB' }, { id: 6, source: 'statement', statementKey: 'b', amount: Infinity, date: '2026-03-02', desc: 'INWARD TRANSFER', bank: 'NTB' }],
            ccPayments: undefined,
        };
        expect(ownMoneyLegs(odd)).toEqual(legacyOwnMoneyLegs(odd));
        expect(looseLegsWhy(odd)).toEqual(legacyLooseLegsWhy(odd));
        for (const nothing of [undefined, null, {}, { expenses: [] }]) {
            expect(ownMoneyLegs(nothing)).toEqual(legacyOwnMoneyLegs(nothing));
            expect(looseLegsWhy(nothing)).toEqual(legacyLooseLegsWhy(nothing));
        }
    });
    it('amounts that differ by a fraction of a cent are still the same amount to the cent', () => {
        const user = {
            expenses: [{ id: 1, source: 'statement', statementKey: 'a', amount: 1000.004, date: '2026-03-01', desc: 'CEFT TRANSFER 1', bank: 'HNB' }],
            incomeRecv: [{ id: 2, source: 'statement', statementKey: 'b', amount: 999.996, date: '2026-03-02', desc: 'INWARD TRANSFER', bank: 'NTB' }],
        };
        expect(ownMoneyLegs(user)).toEqual(legacyOwnMoneyLegs(user));
        expect(ownMoneyLegs(user).pairs).toBe(1);
    });
});

describe('the pairing no longer grows with the square of the books', () => {
    // 15,000 filed expenses, 5,000 incomes, 2,500 card payments: the quadratic rule took 52 s here on the development machine. Linear work on these books is tens of milliseconds; a
    // whole second is a bound loose enough for a loaded CI runner and tight enough that the quadratic rule cannot meet it.
    const big = books(15000, 99);
    it('ownMoneyLegs on 15,000 records answers in under a second', () => {
        const started = Date.now();
        const out = ownMoneyLegs(big);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(out.pairs + out.left + out.unworded).toBeGreaterThan(0);
    });
    it('looseLegsWhy on 15,000 records answers in under a second', () => {
        const started = Date.now();
        const out = looseLegsWhy(big);
        expect(Date.now() - started).toBeLessThan(1000);
        expect(out.pairs).toBeGreaterThan(0);
    });
});
