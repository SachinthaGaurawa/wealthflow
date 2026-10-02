import { describe, expect, it } from 'vitest';
import { ownMoneyLegs, looseLegsWhy, ownTransferHash, OWN_TRANSFER_LABEL } from '../statement-legs.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { ledgerCensus, healOwnTransfers } from '../statement-sync.js';
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
    it('a note the owner wrote, a loan or subscription tie, and an entry typed by hand are never taken out', () => {
        const wrote = { notes: 'paid for mum\'s card' };
        for (const extra of [wrote, { loanLink: { loanId: 'L', month: '2026-03' } }, { subscriptionLink: { id: 's' } }, { source: undefined, statementKey: undefined }]) expect(ids(ownMoneyLegs({ expenses: [debit(extra)], ccPayments: [card()] })), JSON.stringify(extra)).toEqual([]);
        expect(ids(ownMoneyLegs({ expenses: [debit()], ccPayments: [card(wrote)] }))).toEqual([]);
    });
    it('a later _ut is not the owner\'s hand: the page stamps it on any change (a bank-name migration is one), and the worker\'s own notes are not the owner\'s', () => {
        const stamped = { _ut: Date.parse('2026-10-02T10:00:00.000Z') };
        expect(ids(ownMoneyLegs({ expenses: [debit(stamped)], ccPayments: [card(stamped)] }))).toEqual(['d']);
        for (const notes of ['Filed automatically; the AI could not pick a more specific category. Change it if it is wrong.', 'Filed automatically with the category you have used for this merchant before. Change it if it is wrong.', '']) expect(ids(ownMoneyLegs({ expenses: [debit({ notes })], ccPayments: [card()] })), notes).toEqual(['d']);
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
    it('at least one leg says transfer (as for two legs of one consolidated statement), and they must be two banks', () => {
        expect(ids(ownMoneyLegs({ expenses: [out()], incomeRecv: [into({ desc: 'REFUND FROM SHOP' })] }))).toEqual(['i', 'o']);                     // the debit says transfer, the credit just says it came
        expect(ids(ownMoneyLegs({ expenses: [out({ desc: 'FUND TRF TO 0771234567' })], incomeRecv: [into()] }))).toEqual(['i', 'o']);              // the credit says transfer
        expect(ids(ownMoneyLegs({ expenses: [out()], incomeRecv: [into({ bank: 'NTB', card_last4: '5187' })] }))).toEqual([]);                      // one bank
        expect(ids(ownMoneyLegs({ expenses: [out({ k: 'same' })], incomeRecv: [into({ k: 'same' })] }))).toEqual([]);                               // one statement
    });
    it('a line that does not say transfer and reads as a purchase, a withdrawal or a bill is not a leg on the other side\'s word', () => {
        for (const desc of ['POS KEELLS COLOMBO', 'ATM WITHDRAWAL', 'SLT BILL PAYMENT', 'MERCHANT PAYMENT', 'SALARY MARCH']) {
            expect(ids(ownMoneyLegs({ expenses: [out({ desc })], incomeRecv: [into()] })), desc).toEqual([]);
            expect(ids(ownMoneyLegs({ expenses: [out()], incomeRecv: [into({ desc })] })), desc).toEqual([]);
        }
    });
    it('two lines of the right amount and days that NEITHER says transfer are counted and left for the owner', () => {
        const plan = ownMoneyLegs({ expenses: [out({ desc: 'RENT' })], incomeRecv: [into({ desc: 'GIFT' })] });
        expect(ids(plan)).toEqual([]);
        expect(plan).toMatchObject({ pairs: 0, left: 0, unworded: 1 });
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
        expect(line).toEqual({ evt: 'statement-legs-plan', pairs: 2, records: 3, left: 0, unworded: 0, looser: 2, kinds: { card: 1, bank: 2 }, banks: { DFCC: 1, NTB: 1, Dfccbank: 1 }, why: { 'card:would-take-out': 1, 'bank:would-take-out': 1 } });
        expect(lines.join('\n')).not.toMatch(/CEFT|TRANSFER|PAYMENT|3000|50000|0741|0771/i);
        expect(w.data.get('users/u')).toEqual(before);
    });
    it('a household with nothing to take out says so in zeros', async () => {
        const { lines } = await run({ expenses: [sys('a', 'expenses', '2026-03-05', 800, 'KEELLS')] });
        expect(lines.map(text => JSON.parse(text)).find(entry => entry.evt === 'statement-legs-plan')).toEqual({ evt: 'statement-legs-plan', pairs: 0, records: 0, left: 0, unworded: 0, looser: 0, kinds: {}, banks: {}, why: {} });
    });
});

describe('why a loose pair is not taken out', () => {
    const debit = (extra = {}) => sys('d', 'expenses', '2026-03-20', 3000, 'CEFT TRANSFER 0741234567', { k: 'bankstmt', ...extra });
    const card = (extra = {}) => sys('cc', 'ccPayments', '2026-03-21', 3000, 'PAYMENT RECEIVED', { bank: 'AMEX', card_last4: '0276', k: 'cardstmt', ...extra });
    const into = (extra = {}) => sys('i', 'incomeRecv', '2026-03-20', 3000, 'Inward Ceft Transfer', { bank: 'NTB', card_last4: '8057', k: 'ntb', ...extra });
    const why = user => looseLegsWhy(user).reasons;
    const edited = { notes: 'my own note' };
    it('names the first thing the strict rule needs that the pair lacks', () => {
        expect(why({ expenses: [debit()], ccPayments: [card()] })).toEqual({ 'card:would-take-out': 1 });
        expect(why({ expenses: [debit()], ccPayments: [card({ date: '2026-03-18' })] })).toEqual({ 'card:day-gap--2': 1 });
        expect(why({ expenses: [debit()], ccPayments: [card({ desc: 'REFUND TRANSFER' })] })).toEqual({ 'card:card-credit-is-a-refund': 1 });
        expect(why({ expenses: [debit({ desc: 'POS KEELLS' })], ccPayments: [card({ desc: 'TRANSFER CREDIT' })] })).toEqual({ 'card:debit-not-worded-as-transfer': 1 });
        expect(why({ expenses: [debit(edited)], ccPayments: [card()] })).toEqual({ 'card:edited-by-the-owner': 1 });
        expect(why({ expenses: [debit({ loanLink: { loanId: 'L', month: '2026-03' } })], ccPayments: [card()] })).toEqual({ 'card:tied-to-a-loan-or-subscription': 1 });
        expect(why({ cconetime: [debit()], ccPayments: [card()] })).toEqual({ 'card:debit-in-cconetime': 1 });
        expect(why({ expenses: [debit()], incomeRecv: [into({ bank: 'DFCC', card_last4: '9999' })] })).toEqual({ 'bank:same-bank-or-unknown': 1 });
        expect(why({ expenses: [debit({ bank: 'HNB' })], incomeRecv: [into({ desc: 'Salary Bonus' })] })).toEqual({ 'bank:unworded-leg-looks-like-a-purchase': 1 });
        expect(why({ expenses: [debit({ bank: 'HNB' })], incomeRecv: [into({ date: '2026-03-23' })] })).toEqual({ 'bank:day-gap-+3': 1 });
    });
    it('two records that could be the one leg are "ambiguous"; no loose pair says nothing', () => {
        expect(why({ expenses: [debit(), debit({ id: 'd2', k: 'other' })], ccPayments: [card()] })).toEqual({ 'card:ambiguous': 2 });
        expect(why({ expenses: [debit()], ccPayments: [card({ amount: 3001 })] })).toEqual({});
        expect(looseLegsWhy({})).toEqual({ pairs: 0, reasons: {} });
    });
    it('keys are words and signed days only: no amount, no description, no account', () => {
        const keys = Object.keys(why({ expenses: [debit()], ccPayments: [card({ date: '2026-03-18' })], incomeRecv: [into({ bank: 'HNB' })] })).join(' ');
        expect(keys).not.toMatch(/\d{3,}|CEFT|PAYMENT/i);
    });
});

describe('the heal: each pair is one movement of the owner\'s money, locked under one hash', () => {
    const card = (extra = {}) => sys('cc', 'ccPayments', '2026-03-21', 3000, 'PAYMENT RECEIVED THANK YOU', { bank: 'AMEX', card_last4: '0276', k: 'cardstmt', ...extra });
    const debit = (extra = {}) => sys('d', 'expenses', '2026-03-20', 3000, 'CEFT TRANSFER 0741234567', { k: 'bankstmt', ...extra });
    const out = (extra = {}) => sys('o', 'expenses', '2026-03-10', 50000, 'Outward Ceft Transfer 0771234567', { bank: 'NTB', card_last4: '8057', k: 'ntb', ...extra });
    const into = (extra = {}) => sys('i', 'incomeRecv', '2026-03-10', 50000, 'Inward Ceft Transfer', { bank: 'Dfccbank', card_last4: '5187', k: 'dfcc', ...extra });
    const heal = async (user, ledger = {}, options = {}) => {
        const w = createFirestore({ 'users/u': user, ...ledger });
        const lines = [];
        const res = await healOwnTransfers({ db: w.db, uid: 'u', now: 9000, log: line => lines.push(line), ...options });
        return { res, lines, w, after: w.data.get('users/u') };
    };
    const ledgerRow = id => ({ [`users/u/statementLedger/${id}`]: { status: 'filed', module: 'expenses', id } });

    it('a bank pair: both legs leave the books with a tombstone, and both ledger rows carry the one hash and the label', async () => {
        const { res, after, w } = await heal({ expenses: [out()], incomeRecv: [into()] }, { ...ledgerRow('o'), ...ledgerRow('i') });
        const hash = ownTransferHash('bank', out(), into());
        expect(res).toMatchObject({ pairs: 1, removed: 2, kinds: { bank: 2 } });
        expect(after.expenses).toEqual([]); expect(after.incomeRecv).toEqual([]);
        expect(after._tomb).toEqual({ expenses: { o: 9000 }, incomeRecv: { i: 9000 } });
        for (const [id, partner] of [['o', 'i'], ['i', 'o']]) {
            expect(w.data.get(`users/u/statementLedger/${id}`)).toMatchObject({ status: 'skipped', module: 'skip', reason: 'own-account-pair', label: OWN_TRANSFER_LABEL, ownTransfer: hash, pairedWith: partner, removed: { id, amount: 50000, date: '2026-03-10' } });
        }
        expect(hash).toMatch(/^ot_[0-9a-f]{20}$/);
    });
    it('a card pair: the bank debit goes, the card statement\'s payment stays and is stamped with the same hash', async () => {
        const { res, after, w } = await heal({ expenses: [debit()], ccPayments: [card()] }, { ...ledgerRow('d'), ...ledgerRow('cc') });
        const hash = ownTransferHash('card', debit(), card());
        expect(res).toMatchObject({ pairs: 1, removed: 1, kinds: { card: 1 } });
        expect(after.expenses).toEqual([]);
        expect(after.ccPayments).toHaveLength(1);
        expect(after.ccPayments[0]).toMatchObject({ id: 'cc', amount: 3000, ownTransfer: hash, ownTransferLabel: OWN_TRANSFER_LABEL, ownTransferOf: 'd', _ut: 9000 });
        expect(after._tomb).toEqual({ expenses: { d: 9000 } });
        expect(w.data.get('users/u/statementLedger/d')).toMatchObject({ reason: 'own-account-pair', ownTransfer: hash, removed: { store: 'expenses', id: 'd', amount: 3000 } });
        expect(w.data.get('users/u/statementLedger/cc')).toMatchObject({ status: 'filed', ownTransfer: hash, label: OWN_TRANSFER_LABEL, pairedWith: 'd' });
    });
    it('the hash is the same whichever order the statements arrived in, and different for a different movement', () => {
        expect(ownTransferHash('bank', out(), into())).toBe(ownTransferHash('bank', out(), into()));
        expect(ownTransferHash('bank', out(), into())).not.toBe(ownTransferHash('bank', out({ id: 'o2' }), into()));
        expect(ownTransferHash('bank', out(), into())).not.toBe(ownTransferHash('card', out(), into()));
    });
    it('is idempotent: a second pass finds nothing, the stamped payment is not a new pair, and the log says counts only', async () => {
        const first = await heal({ expenses: [debit()], ccPayments: [card()] });
        const again = await healOwnTransfers({ db: first.w.db, uid: 'u', now: 9500, log: () => {} });
        expect(again).toEqual({ pairs: 0, removed: 0, more: false });
        expect(first.w.data.get('users/u')._tomb).toEqual({ expenses: { d: 9000 } });
        expect(JSON.parse(first.lines[0])).toEqual({ evt: 'own-transfer-heal', pairs: 1, removed: 1, kinds: { card: 1 }, left: 0, unworded: 0 });
        expect(first.lines.join('')).not.toMatch(/CEFT|PAYMENT|3000|0741|0276|cardstmt/i);
    });
    it('touches nothing it should not: ambiguous legs, a note the owner wrote, a loan tie, one-bank pairs and unworded pairs all stay (the census log counts them)', async () => {
        const user = {
            expenses: [debit(), debit({ id: 'd2', k: 'other' }), out({ notes: 'lent to Nuwan' }), sys('rent', 'expenses', '2026-03-12', 70000, 'RENT', { bank: 'NTB', k: 'ntb2' }), sys('l', 'expenses', '2026-03-12', 9000, 'CEFT TRANSFER 07', { k: 'ntb3', loanLink: { loanId: 'L', month: '2026-03' } })],
            incomeRecv: [into(), sys('gift', 'incomeRecv', '2026-03-12', 70000, 'GIFT', { bank: 'DFCC', k: 'dfcc3' }), sys('li', 'incomeRecv', '2026-03-12', 9000, 'Inward Ceft Transfer', { bank: 'DFCC', k: 'dfcc4' })],
            ccPayments: [card()],
        };
        const before = structuredClone(user);
        const { res, after, lines } = await heal(user);
        expect(res).toEqual({ pairs: 0, removed: 0, more: false });
        expect(after).toEqual(before);
        expect(lines).toEqual([]);
        const plan = ownMoneyLegs(user);
        expect(plan).toMatchObject({ pairs: 0, left: 2, unworded: 1 });
    });
    it('plans from the document inside the transaction: a leg another device just removed is not paired with a ghost', async () => {
        const w = createFirestore({ 'users/u': { expenses: [out()], incomeRecv: [] } });
        // peek sees both legs only if the document has them; here the credit is already gone
        expect(await healOwnTransfers({ db: w.db, uid: 'u', now: 9000, log: () => {} })).toEqual({ pairs: 0, removed: 0, more: false });
        expect(w.data.get('users/u').expenses).toHaveLength(1);
    });
    it('a pair is taken out whole or not at all, and no more than the limit of pairs in one pass', async () => {
        const pairs = Array.from({ length: 5 }, (_, n) => [out({ id: `o${n}`, k: `ntb${n}`, amount: 1000 + n }), into({ id: `i${n}`, k: `dfcc${n}`, amount: 1000 + n })]).flat();
        const { res, after } = await heal({ expenses: pairs.filter(r => r.id.startsWith('o')), incomeRecv: pairs.filter(r => r.id.startsWith('i')) }, {}, { limit: 2 });
        expect(res).toMatchObject({ pairs: 2, removed: 4, more: true });
        expect(after.expenses.map(r => r.id)).toEqual(['o2', 'o3', 'o4']);
        expect(after.incomeRecv.map(r => r.id)).toEqual(['i2', 'i3', 'i4']);
    });
    it('a document with no records heals to nothing', async () => {
        expect(await healOwnTransfers({ db: createFirestore({ 'users/u': {} }).db, uid: 'u', log: () => {} })).toEqual({ pairs: 0, removed: 0, more: false });
    });
});

describe('end to end: two statements through the real worker, then the heal, in either order', () => {
    const card = { bank: 'AMEX', last4: '0276', path: 'sources/card', statementType: 'credit_card', decision: { module: 'ccPayments', category: 'Card Payment', verified: true }, cardRegistry: { '0276': { bank: 'AMEX' } } };
    const bank = { bank: 'DFCC', last4: '5187', path: 'sources/bank', cardRegistry: { '0276': { bank: 'AMEX' } } };
    const charge = { id: 'c1', desc: 'Keells', amount: 3000, date: '2026-03-04', card_last4: '0276', bank: 'AMEX', source: 'statement', statementKey: 'wf-mail/x/items/a', cat: 'Food', combinedTotal: 3000, paid: false };
    const lines = { bank: [row('CEFT TRANSFER 0741234567', 3000, '2026-03-20'), row('RENT MARCH', 3000, '2026-03-02')], card: [row('PAYMENT RECEIVED THANK YOU', 3000, '2026-03-21', 'credit')] };
    for (const [name, first, second] of [['the bank first', 'bank', 'card'], ['the card first', 'card', 'bank']]) {
        it(`${name}: the payment is counted once (in the card), the rent stays, the card charge is paid, and a second heal changes nothing`, async () => {
            let user = await file({ cconetime: [charge] }, lines[first], first === 'bank' ? bank : card);
            user = await file(user, lines[second], second === 'bank' ? bank : card);
            const w = createFirestore({ 'users/u': user });
            const out = await healOwnTransfers({ db: w.db, uid: 'u', now: 9000, log: () => {} });
            expect(out).toMatchObject({ pairs: 1, removed: 1 });
            const after = w.data.get('users/u');
            expect(after.expenses.map(record => record.desc)).toEqual(['RENT MARCH']);
            expect(after.ccPayments).toHaveLength(1);
            expect(after.ccPayments[0]).toMatchObject({ amount: 3000, ownTransferLabel: 'Own Transfer' });
            expect(after.cconetime[0]).toMatchObject({ paid: true, autoPaid: true });         // the card's own pool paid it
            const books = structuredClone(after);
            expect(await healOwnTransfers({ db: w.db, uid: 'u', now: 9500, log: () => {} })).toEqual({ pairs: 0, removed: 0, more: false });
            expect(w.data.get('users/u')).toEqual(books);
        });
    }
});
