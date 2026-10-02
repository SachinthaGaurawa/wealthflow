import { describe, expect, it } from 'vitest';
import { ownMoneyLegs } from '../statement-legs.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { ledgerCensus } from '../statement-sync.js';
import { createFirestore } from './helpers/fake-firestore.js';

// Production, 2026-10-02 (`statement-twins` legs): two pairs of the owner's own money counted on both statements (NTB>DFCC, DFCC>AMEX). Simulated with the real worker: a card that is paid by a transfer whose
// narration does not say so ("CEFT TRANSFER 0741234567") has its purchases counted by the card statement and the payment counted again as an expense — 6,000 for 3,000 of shopping. The other statement is the evidence.

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
    return after;
}

const sys = (id, store, date, amount, desc, extra = {}) => ({ id, source: 'statement', statementKey: `wf-mail/o/items/${extra.k || id}`, statementRow: 1, date, month: date.slice(0, 7), amount, desc, bank: 'DFCC', card_last4: '5187', createdAt: '2026-09-30T10:00:00.000Z', _ut: Date.parse('2026-09-30T10:00:00.000Z'), cat: 'Other', ...extra });
const ids = out => out.remove.map(entry => entry.record.id).sort();

describe('a card paid by a transfer that does not name the card', () => {
    const card = (extra = {}) => sys('cc', 'ccPayments', '2026-03-21', 3000, 'PAYMENT RECEIVED THANK YOU', { bank: 'AMEX', card_last4: '0276', k: 'cardstmt', ...extra });
    const debit = (extra = {}) => sys('d', 'expenses', '2026-03-20', 3000, 'CEFT TRANSFER 0741234567', { k: 'bankstmt', ...extra });
    it('the debit is the card payment: it goes, and the card statement\'s payment stays', () => {
        const out = ownMoneyLegs({ expenses: [debit()], ccPayments: [card()] });
        expect(ids(out)).toEqual(['d']);
        expect(out.remove[0]).toMatchObject({ store: 'expenses', kind: 'card', partner: { id: 'cc' } });
        expect(out).toMatchObject({ pairs: 1, left: 0 });
    });
    it('the card posts it from a day before to four days after the bank debited it, and no other day', () => {
        for (const [posted, found] of [['2026-03-19', true], ['2026-03-18', false], ['2026-03-20', true], ['2026-03-24', true], ['2026-03-25', false]]) {
            expect(ids(ownMoneyLegs({ expenses: [debit()], ccPayments: [card({ date: posted })] })).length === 1, posted).toBe(found);
        }
    });
    it('to the cent: another amount is another payment', () => {
        expect(ids(ownMoneyLegs({ expenses: [debit()], ccPayments: [card({ amount: 3000.01 })] }))).toEqual([]);
    });
    it('a debit that does not say transfer, a refund on the card, and two legs of one statement are not this rule', () => {
        expect(ids(ownMoneyLegs({ expenses: [debit({ desc: 'POS KEELLS COLOMBO' })], ccPayments: [card()] }))).toEqual([]);
        for (const words of ['REFUND KEELLS', 'REVERSAL OF CHARGE', 'CASHBACK CREDIT', 'MERCHANT ADJUSTMENT']) expect(ids(ownMoneyLegs({ expenses: [debit()], ccPayments: [card({ desc: words })] })), words).toEqual([]);
        expect(ids(ownMoneyLegs({ expenses: [debit({ k: 'cardstmt' })], ccPayments: [card()] }))).toEqual([]);
        expect(ids(ownMoneyLegs({ expenses: [debit({ card_last4: '0276' })], ccPayments: [card()] }))).toEqual([]);
    });
    it('two debits for the one payment, or two payments one debit could be, are never guessed between', () => {
        const two = ownMoneyLegs({ expenses: [debit(), debit({ id: 'd2', k: 'other' })], ccPayments: [card()] });
        expect(ids(two)).toEqual([]);
        expect(two.left).toBe(2);
        expect(ids(ownMoneyLegs({ expenses: [debit()], ccPayments: [card(), card({ id: 'cc2', k: 'cardstmt2', date: '2026-03-22' })] }))).toEqual([]);
    });
    it('the owner\'s edit, a loan or subscription tie, and an entry typed by hand are never taken out', () => {
        const edited = { _ut: Date.parse('2026-10-02T10:00:00.000Z') };
        for (const extra of [edited, { loanLink: { loanId: 'L', month: '2026-03' } }, { subscriptionLink: { id: 's' } }, { source: undefined, statementKey: undefined }]) expect(ids(ownMoneyLegs({ expenses: [debit(extra)], ccPayments: [card()] })), JSON.stringify(extra)).toEqual([]);
        expect(ids(ownMoneyLegs({ expenses: [debit()], ccPayments: [card(edited)] }))).toEqual([]);
    });
});

describe('two accounts at two banks', () => {
    const out = (extra = {}) => sys('o', 'expenses', '2026-03-10', 50000, 'Outward Ceft Transfer 0771234567', { bank: 'NTB', card_last4: '8057', k: 'ntb', ...extra });
    const into = (extra = {}) => sys('i', 'incomeRecv', '2026-03-10', 50000, 'Inward Ceft Transfer', { bank: 'Dfccbank', card_last4: '5187', k: 'dfcc', ...extra });
    it('a transfer out of one and the same amount in at the other: both legs go', () => {
        const plan = ownMoneyLegs({ expenses: [out()], incomeRecv: [into()] });
        expect(ids(plan)).toEqual(['i', 'o']);
        expect(plan.remove.map(entry => entry.kind)).toEqual(['bank', 'bank']);
        expect(plan.pairs).toBe(1);
    });
    it('within two days; the day after the next is another thing', () => {
        for (const [date, found] of [['2026-03-12', true], ['2026-03-08', true], ['2026-03-13', false]]) expect(ids(ownMoneyLegs({ expenses: [out()], incomeRecv: [into({ date })] })).length === 2, date).toBe(found);
    });
    it('both legs must say transfer, and they must be two banks (a hand-typed or one-bank pair is another rule)', () => {
        expect(ids(ownMoneyLegs({ expenses: [out()], incomeRecv: [into({ desc: 'REFUND FROM SHOP' })] }))).toEqual([]);
        expect(ids(ownMoneyLegs({ expenses: [out({ desc: 'RENT' })], incomeRecv: [into()] }))).toEqual([]);
        expect(ids(ownMoneyLegs({ expenses: [out()], incomeRecv: [into({ bank: 'NTB', card_last4: '5187' })] }))).toEqual([]);
        expect(ids(ownMoneyLegs({ expenses: [out({ k: 'same' })], incomeRecv: [into({ k: 'same' })] }))).toEqual([]);
    });
    it('a leg that could be paired two ways is left, and so is a debit that is both a card payment and a bank leg', () => {
        expect(ids(ownMoneyLegs({ expenses: [out()], incomeRecv: [into(), into({ id: 'i2', k: 'dfcc2' })] }))).toEqual([]);
        const card = sys('cc', 'ccPayments', '2026-03-11', 50000, 'PAYMENT RECEIVED', { bank: 'AMEX', card_last4: '0276', k: 'amex' });
        expect(ids(ownMoneyLegs({ expenses: [out()], incomeRecv: [into()], ccPayments: [card] }))).toEqual([]);
    });
});

describe('through the real worker, in either order the rule finds the transfer and only the transfer', () => {
    const card = { bank: 'AMEX', last4: '0276', path: 'sources/card', statementType: 'credit_card', decision: { module: 'ccPayments', category: 'Card Payment', verified: true }, cardRegistry: { '0276': { bank: 'AMEX' } } };
    const bank = { bank: 'DFCC', last4: '5187', path: 'sources/bank', cardRegistry: { '0276': { bank: 'AMEX' } } };
    const charge = { id: 'c1', desc: 'Keells', amount: 3000, date: '2026-03-04', card_last4: '0276', bank: 'AMEX', source: 'statement', statementKey: 'wf-mail/x/items/a', cat: 'Food' };
    const lines = { bank: [row('CEFT TRANSFER 0741234567', 3000, '2026-03-20'), row('RENT MARCH', 3000, '2026-03-02')], card: [row('PAYMENT RECEIVED THANK YOU', 3000, '2026-03-21', 'credit')] };
    for (const [name, first, second] of [['the bank first', 'bank', 'card'], ['the card first', 'card', 'bank']]) {
        it(name, async () => {
            let user = await file({ cconetime: [charge] }, lines[first], first === 'bank' ? bank : card);
            user = await file(user, lines[second], second === 'bank' ? bank : card);
            expect(user.expenses.map(record => record.desc).sort()).toEqual(['CEFT TRANSFER 0741234567', 'RENT MARCH']);
            const plan = ownMoneyLegs(user);
            expect(plan.remove.map(entry => entry.record.desc)).toEqual(['CEFT TRANSFER 0741234567']);
            expect(plan.remove[0].partner.desc).toBe('PAYMENT RECEIVED THANK YOU');
        });
    }
});

describe('the log says what the rule would take out, and takes nothing out', () => {
    const run = async user => {
        const w = createFirestore({ 'wf-mail/owner_example_com': { uid: 'u', email: 'owner@example.com' }, 'users/u': user });
        const lines = [];
        await ledgerCensus({ db: w.db, mailRef: w.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', log: line => lines.push(line) });
        return { lines, w };
    };
    it('counts only: pairs, records, what is left, the looser count and the banks; the books are untouched', async () => {
        const user = {
            expenses: [sys('d', 'expenses', '2026-03-20', 3000, 'CEFT TRANSFER 0741234567', { k: 'bankstmt' }), sys('o', 'expenses', '2026-03-10', 50000, 'Outward Ceft Transfer 0771234567', { bank: 'NTB', card_last4: '8057', k: 'ntb' })],
            incomeRecv: [sys('i', 'incomeRecv', '2026-03-10', 50000, 'Inward Ceft Transfer', { bank: 'Dfccbank', k: 'dfcc' })],
            ccPayments: [sys('cc', 'ccPayments', '2026-03-21', 3000, 'PAYMENT RECEIVED THANK YOU', { bank: 'AMEX', card_last4: '0276', k: 'cardstmt' })],
        };
        const before = structuredClone(user);
        const { lines, w } = await run(user);
        const line = lines.map(text => JSON.parse(text)).find(entry => entry.evt === 'statement-legs-plan');
        expect(line).toEqual({ evt: 'statement-legs-plan', pairs: 2, records: 3, left: 0, looser: 2, kinds: { card: 1, bank: 2 }, banks: { DFCC: 1, NTB: 1, Dfccbank: 1 } });
        expect(lines.join('\n')).not.toMatch(/CEFT|TRANSFER|PAYMENT|3000|50000|0741|0771/i);
        expect(w.data.get('users/u')).toEqual(before);
    });
    it('a household with nothing to take out says so in zeros', async () => {
        const { lines } = await run({ expenses: [sys('a', 'expenses', '2026-03-05', 800, 'KEELLS')] });
        expect(lines.map(text => JSON.parse(text)).find(entry => entry.evt === 'statement-legs-plan')).toEqual({ evt: 'statement-legs-plan', pairs: 0, records: 0, left: 0, looser: 0, kinds: {}, banks: {} });
    });
});
