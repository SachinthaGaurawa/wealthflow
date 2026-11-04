import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { proveDirections, cardCreditWords } from '../statement-direction.mjs';
import { PROVEN_DIRECTION, validateSettlementRow } from '../statement-ledger.mjs';
import { readShape, deterministicDecision } from '../statement-sync.js';

const P = loadParser(fs);

// HNB credit card e-statement (owner's file, production 2026-11-03): the statement opened, 24 rows were read, one was filed and 22 waited as "unproven-direction". A card statement prints a purchase as a
// plain amount, and the closing line of this layout is not one the parser recognises, so the statement's own arithmetic proved nothing. What follows is the same shape with invented names and figures.
const head = ['HNB Credit Card Statement', 'Card No: 4284 17XX XXXX 0048', 'Credit Limit 500,000.00', 'Previous Balance 45,000.00'];
const body = ['12/09/2026 14/09/2026 KEELLS SUPER COLOMBO 4,250.00', '15/09/2026 16/09/2026 UBER RIDE 1,250.00', '20/09/2026 21/09/2026 PAYMENT RECEIVED - THANK YOU 45,000.00 CR', '25/09/2026 26/09/2026 NETFLIX.COM 1,890.00'];
const noClosing = [...head, ...body, 'Total Outstanding 7,390.00'].join('\n');
const withClosing = [...head.slice(0, 3), 'Opening Balance 45,000.00', ...body, 'Closing Balance 7,390.00'].join('\n');
const read = (text, ctx) => { const parsed = P.parseStatement(text); return { parsed, proof: proveDirections(parsed, ctx) }; };

describe('a credit card statement the arithmetic cannot prove', () => {
    it('is read as it was before: every plain amount is an assumed debit and needs review', () => {
        const { parsed } = read(noClosing);
        expect(parsed.reconciliation.ok).toBe(null);
        expect(parsed.rows.map(r => [r.amount, r.direction, r.directionSource, r.needsReview])).toEqual([[4250, 'debit', 'assumed', true], [1250, 'debit', 'assumed', true], [45000, 'credit', 'marker', false], [1890, 'debit', 'assumed', true]]);
    });
    it('proves the purchases by the card layout, once the statement is known to be a card', () => {
        const { proof } = read(noClosing, { card: true });
        expect(proof).toMatchObject({ byLayout: 3, byStatement: 0, byWords: 0 });
        expect(proof.rows.map(r => [r.direction, r.directionSource, r.needsReview])).toEqual([['debit', 'layout', false], ['debit', 'layout', false], ['credit', 'marker', false], ['debit', 'layout', false]]);
    });
    it('and from the reader\'s own "credit-card" header, without being told', () => {
        const parsed = P.parseStatement(noClosing); parsed.layout.statementType = 'credit-card';
        expect(proveDirections(parsed).byLayout).toBe(3);
    });
    it('does nothing for a statement that is not known to be a card', () => {
        expect(read(noClosing).proof.byLayout).toBe(0);
    });
    it('does nothing when the statement\'s own opening and closing do NOT add up: the owner is asked, as before', () => {
        const wrong = withClosing.replace('Closing Balance 7,390.00', 'Closing Balance 9,999.00');
        const { parsed, proof } = read(wrong, { card: true });
        expect(parsed.reconciliation.ok).toBe(false);
        expect(proof.byLayout).toBe(0);
        expect(proof.rows.filter(r => r.needsReview).length).toBe(3);
    });
    it('a statement whose balances add up is still proven by the statement, not by the convention', () => {
        const { proof } = read(withClosing, { card: true });
        expect(proof).toMatchObject({ byStatement: 3, byLayout: 0 });
    });
    it('never takes a line that says money came back for a purchase', () => {
        const text = [...head, '12/09/2026 KEELLS SUPER COLOMBO 4,250.00', '15/09/2026 CASHBACK REWARD 150.00', '16/09/2026 REFUND AMAZON 900.00', '17/09/2026 PAYMENT THANK YOU 5,000.00', '20/09/2026 MERCHANT CREDIT ADJUSTMENT 75.00'].join('\n');
        const { proof } = read(text, { card: true });
        // only the merchant is a purchase by the layout; a refund and a cashback are credits by their words; the two the parser read as credits from a keyword stay with the owner
        expect(proof).toMatchObject({ byLayout: 1, byWords: 2 });
        expect(proof.rows.map(r => [r.direction, r.directionSource])).toEqual([['debit', 'layout'], ['credit', 'words'], ['credit', 'words'], ['credit', 'keyword'], ['credit', 'keyword']]);
        expect(proof.rows.filter(r => r.needsReview).length).toBe(2);
    });
    it('leaves a row the parser read as a credit from its words (keyword) to the owner', () => {
        const parsed = { layout: { statementType: 'credit-card', balanceColumn: false }, reconciliation: { ok: null }, rows: [{ narration: 'SOMETHING INWARD', amount: 10, direction: 'credit', directionSource: 'keyword', needsReview: true, valid: true }] };
        expect(proveDirections(parsed).byLayout).toBe(0);
    });
    it('does not open on a statement that has a running balance', () => {
        const parsed = { layout: { statementType: 'credit-card', balanceColumn: true }, reconciliation: { ok: null }, rows: [{ narration: 'KEELLS', amount: 10, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true }] };
        expect(proveDirections(parsed).byLayout).toBe(0);
    });
    it('"layout" is a proof the ledger accepts, and the filed record says how it was proven', () => {
        expect(PROVEN_DIRECTION).toContain('layout');
        const { proof } = read(noClosing, { card: true });
        const row = { ...proof.rows[0], description: proof.rows[0].narration };
        expect(validateSettlementRow(row, { verified: true, module: 'cconetime', category: 'Groceries' }, { statementType: 'credit_card' })).toBe(null);
        expect(validateSettlementRow({ ...row, directionSource: 'assumed', needsReview: true }, { verified: true, module: 'cconetime', category: 'Groceries' }, { statementType: 'credit_card' })).toBe('unproven-direction');
    });
    it('card credit words are read from the row alone', () => {
        expect(cardCreditWords({ narration: 'PAYMENT RECEIVED' })).toBe(true);
        expect(cardCreditWords({ narration: 'KEELLS SUPER' })).toBe(false);
    });
});

describe('the log says why a statement waits (counts only)', () => {
    it('counts how the directions were read and whether the statement\'s own balances were found and agreed', () => {
        const shape = readShape(P.parseStatement(noClosing));
        expect(shape).toMatchObject({ sources: { assumed: 3, marker: 1 }, balanceColumn: false, opening: true, closing: false, reconciled: 'unknown', invalid: { noDate: 0, noAmount: 0, noWords: 0 } });
        expect(readShape(P.parseStatement(withClosing))).toMatchObject({ reconciled: 'yes', model: 'card', closing: true });
    });
    it('counts the rows that are not whole transactions', () => {
        expect(readShape({ rows: [{ date: '', amount: 5, narration: 'x' }, { date: '2026-09-01', amount: 0, narration: 'y' }, { date: '2026-09-01', amount: 5, narration: '  ' }] }).invalid).toEqual({ noDate: 1, noAmount: 1, noWords: 1 });
    });
});

describe('a card purchase keeps the category the rules gave it', () => {
    const card = { statementType: 'credit_card', cardRegistry: {}, subscriptions: [], loans: [] };
    const row = (narration) => ({ narration, description: narration, amount: 100, direction: 'debit', date: '2026-09-01', directionSource: 'layout', needsReview: false, valid: true });
    it('Keells is Groceries, Uber is Transport, on a card as on an account', () => {
        expect(deterministicDecision(row('KEELLS SUPER COLOMBO'), card)).toMatchObject({ module: 'cconetime', category: 'Groceries', verified: true });
        expect(deterministicDecision(row('UBER RIDE'), card)).toMatchObject({ module: 'cconetime', category: 'Transport' });
    });
    it('a merchant the rules cannot place is still a Card Purchase, for the merchant review to settle', () => {
        expect(deterministicDecision(row('SOME UNKNOWN SHOP 77'), card)).toMatchObject({ module: 'cconetime', category: 'Card Purchase' });
    });
});

// HNB credit card e-statement, production 2026-11-03: 22 rows of ONE statement already waited in Open reviews, one transaction at a time, when the card layout proof was added. They are put right on the next
// sync, without the owner, and a row the proof cannot cover (money-back words, a statement-level question, a bank account) is left exactly as it was.
import { createFirestore } from './helpers/fake-firestore.js';
import { proveCardReviews } from '../statement-sync.js';
import { sourceOccurrenceId } from '../statement-ledger.mjs';

describe('the rows that waited before the card layout proof existed', () => {
    const sourcePath = 'wf-mail/owner/items/card1.pdf';
    const waiting = (index, narration, extra = {}) => {
        const id = sourceOccurrenceId(sourcePath, index);
        return [[`users/u/statementReview/${id}`, { uid: 'u', sourcePath, index, status: 'pending', reason: 'unproven-direction', bank: 'HNB Credit Card',
            row: { date: '2026-09-1' + index, narration, description: narration, amount: 100 + index, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true }, ...extra }],
        [`users/u/statementLedger/${id}`, { uid: 'u', sourcePath, index, status: 'review' }]];
    };
    const world = (rows, source = {}, settings = { cardRegistry: { '0048': { type: 'credit_card', bank: 'HNB' } } }, more = []) => { const fs = createFirestore(Object.fromEntries([
        ['users/u', { settings }],
        [sourcePath, { uid: 'u', bank: 'HNB Credit Card', last4: '0048', statementType: 'credit-card', cursor: 3, totalRows: 3, status: 'needs_review', ...source }],
        ...rows.flatMap((narration, index) => waiting(index, narration)), ...more])); return { db: fs.db, data: fs.data }; };
    const reviews = ({ data }) => ['0', '1', '2'].map(i => data.get(`users/u/statementReview/${sourceOccurrenceId(sourcePath, Number(i))}`)).filter(Boolean);
    const run = (w) => proveCardReviews({ db: w.db, uid: 'u', limit: 10 });
    const store = (w) => w.data.get('users/u');

    it('files the purchases of a card statement with the category the rules give, and says the layout proved them', async () => {
        const db = world(['KEELLS SUPER COLOMBO', 'UBER RIDE', 'SOME UNKNOWN SHOP']);
        expect(await run(db)).toMatchObject({ proved: 3, left: 0 });
        expect(reviews(db).map(r => r.status)).toEqual(['resolved', 'resolved', 'resolved']);
        expect(store(db).cconetime.map(r => [r.category, r.directionProof]).sort()).toEqual([['Card Purchase', 'layout'], ['Groceries', 'layout'], ['Transport', 'layout']]);
    });
    it('leaves a line that says money came back, and a statement that has a question of its own open', async () => {
        const db = world(['KEELLS SUPER COLOMBO', 'REFUND AMAZON', 'UBER RIDE'], {}, undefined, [[`users/u/statementReview/${sourceOccurrenceId(sourcePath, -1)}`, { uid: 'u', sourcePath, index: -1, status: 'pending', reason: 'layout' }]]);
        expect(await run(db)).toMatchObject({ proved: 0 });
        expect(reviews(db).every(r => r.status === 'pending')).toBe(true);
    });
    it('leaves only the money-back line when the statement has no question of its own', async () => {
        const db = world(['KEELLS SUPER COLOMBO', 'PAYMENT THANK YOU', 'UBER RIDE']);
        expect(await run(db)).toMatchObject({ proved: 2, left: 1 });
        expect(reviews(db).map(r => r.status)).toEqual(['resolved', 'pending', 'resolved']);
    });
    it('says WHY a money-back line stays in names from a fixed list, never in the line\'s own words or amounts', async () => {
        const db = world(['KEELLS SUPER COLOMBO', 'PAYMENT THANK YOU', 'ONLINE PAYMENT DIALOG'], { proof: { opening: 1000, closing: 900, credits: 203, debits: 50 } });
        const out = await run(db);
        expect(out).toMatchObject({ proved: 1, left: 2, more: false });
        expect(out.why).toMatchObject({ moneyBack: 2, moneyWords: { payment: 2 }, totals: { tried: 1, none: 1, noneBy: { sign: 1 }, filed: 0 } });
        expect(JSON.stringify(out.why)).not.toMatch(/THANK|DIALOG|KEELLS|101|102/i);
    });
    it('names the other words the same way, and says when the printed totals are missing', async () => {
        const out = await run(world(['REFUND AMAZON', 'CASHBACK REWARD', 'SALARY FROM EMPLOYER'], { proof: { credits: 5 } }));
        expect(out.why).toMatchObject({ moneyBack: 3, moneyWords: { refund: 1, cashback: 1, 'inbound-words': 1 }, totals: { tried: 1, unusable: 1 } });
        const none = await run(world(['REFUND AMAZON']));
        expect(none.why.totals).toMatchObject({ tried: 1, unusable: 1, filed: 0 });
    });
    it('does nothing for a bank account\'s statement', async () => {
        const db = world(['KEELLS SUPER COLOMBO', 'UBER RIDE', 'POS PURCHASE'], { statementType: 'bank_account', last4: '1234', bank: 'DFCC' }, { cardRegistry: {} });
        const out = await run(db);
        expect(out).toMatchObject({ proved: 0, left: 3, more: false });
        expect(out.why).toMatchObject({ notCard: 3, notCardView: { 't1l1r0b-': 3 } });      // what the statement knew of itself, as letters: type given, digits given, not registered
        expect(store(db).cconetime).toBeUndefined();
    });
    it('keeps a decision the rules made that is not a card line: an outward transfer is never turned into a Card Purchase', async () => {
        const db = world(['OUTWARD CEFT TRANSFER 123456', 'KEELLS SUPER COLOMBO', 'UBER RIDE']);
        const out = await run(db);
        expect(out.proved).toBe(2);
        expect(reviews(db).map(r => r.status)).toEqual(['pending', 'resolved', 'resolved']);
        expect(store(db).cconetime.map(r => r.desc)).not.toContain('OUTWARD CEFT TRANSFER 123456');
    });
    it('is bounded: past its deadline it reads nothing more and files nothing, and it looks at no more statements a run than it is allowed', async () => {
        const late = world(['KEELLS SUPER COLOMBO', 'UBER RIDE', 'POS PURCHASE']);
        expect(await proveCardReviews({ db: late.db, uid: 'u', limit: 10, until: Date.now() - 1 })).toMatchObject({ proved: 0, left: 3 });
        expect(reviews(late).every(r => r.status === 'pending')).toBe(true);
        // two statements waiting, one allowed: the second is not even asked about
        const other = 'wf-mail/owner/items/card2.pdf', otherId = sourceOccurrenceId(other, 0);
        const two = world(['KEELLS SUPER COLOMBO'], {}, undefined, [[`users/u/statementReview/${otherId}`, { uid: 'u', sourcePath: other, index: 0, status: 'pending', reason: 'unproven-direction', bank: 'HNB Credit Card',
            row: { date: '2026-09-15', narration: 'UBER RIDE', description: 'UBER RIDE', amount: 50, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true } }], [other, { uid: 'u', bank: 'HNB Credit Card', last4: '0048', statementType: 'credit-card', status: 'needs_review' }]]);
        expect(await proveCardReviews({ db: two.db, uid: 'u', limit: 10, maxSources: 1 })).toMatchObject({ proved: 1, left: 1 });
        expect(Object.values(two.data.get('users/u').cconetime || []).length).toBe(1);
    });
    it('a question of the statement\'s own keeps its rows even when it is not on the first page of pending reviews', async () => {
        const db = world(['KEELLS SUPER COLOMBO', 'UBER RIDE', 'POS PURCHASE'], {}, undefined, [[`users/u/statementReview/${sourceOccurrenceId(sourcePath, -1)}`, { uid: 'u', sourcePath, index: -1, status: 'pending', reason: 'layout' }]]);
        // the page the sweep reads holds only the row reviews (as it would past 500 of them): the question is found by asking for the statement's own reviews
        const real = db.db.collection.bind(db.db);
        db.db.collection = (path) => { const c = real(path); if (!/statementReview$/.test(path)) return c; return { ...c, where: (f, op, v) => { const q = c.where(f, op, v); return f === 'status' ? { ...q, get: async () => { const r = await q.get(); return { ...r, docs: r.docs.filter(d => d.data().index >= 0) }; } } : q; } }; };
        expect(await run(db)).toMatchObject({ proved: 0 });
        expect(reviews(db).every(r => r.status === 'pending')).toBe(true);
    });
});

// Production, 2026-11-03 19:00 UTC: 8 lines of one HNB card statement stayed in Open reviews because their only word was "payment" (the log said moneyWords {payment: 8}), which is on a payment to the card AND on a purchase at a
// bill-pay merchant. The statement printed its opening and closing balance; the reader's credits and debits are the sums of its rows with every unmarked line a debit, so the balances miss by exactly twice the lines that are
// really credits, and one choice of the waiting lines that makes the sums add up proves them all.
import { proveByTotals } from '../statement-direction.mjs';

describe('proveByTotals: the statement\'s own balances name the lines that are credits', () => {
    const ids = (list) => list.map(([id, amount]) => ({ id, amount }));
    // a card that owed 1000.00, whose reader saw 425.75 of lines as debits (all of them), and that closed at 924.75 once the 250.50 line was really a payment
    const card = { opening: 1000, credits: 0, debits: 425.75, models: ['card'], candidates: ids([['a', 100], ['b', 250.5], ['c', 75.25]]) };
    it('finds the one choice of lines that adds up, in cents', () => {
        expect(proveByTotals({ ...card, closing: 924.75 })).toEqual({ fit: 'unique', model: 'card', credit: ['b'], debit: ['a', 'c'] });
    });
    it('proves every line a debit when the balances already add up', () => {
        expect(proveByTotals({ ...card, closing: 1425.75 })).toEqual({ fit: 'unique', model: 'card', credit: [], debit: ['a', 'b', 'c'] });
    });
    it('proves every line a credit when they all are', () => {
        expect(proveByTotals({ ...card, closing: 1000 - 425.75 })).toEqual({ fit: 'unique', model: 'card', credit: ['a', 'b', 'c'], debit: [] });
    });
    it('proves nothing when no choice of the lines makes the balances add up, and says why in a word', () => {
        expect(proveByTotals({ ...card, closing: 1234.56 })).toEqual({ fit: 'none', reason: 'odd' });         // an odd cent is not twice anything
        expect(proveByTotals({ ...card, closing: 1425.75 + 10 })).toEqual({ fit: 'none', reason: 'sign' });      // the balances miss the other way
        expect(proveByTotals({ ...card, closing: 1000 - 425.75 - 500 })).toEqual({ fit: 'none', reason: 'range' });      // more than all of the lines together
        expect(proveByTotals({ ...card, closing: 1425.75 - 2 * 50 })).toEqual({ fit: 'none', reason: 'subset' });        // 50.00 is no sum of these lines
    });
    it('proves nothing when two different choices both add up: the owner is asked', () => {
        const same = { opening: 1000, credits: 0, debits: 250, models: ['card'], candidates: ids([['x', 100], ['y', 100], ['z', 50]]) };
        expect(proveByTotals({ ...same, closing: 1050 })).toEqual({ fit: 'ambiguous' });
        expect(proveByTotals({ ...same, closing: 1150 })).toEqual({ fit: 'unique', model: 'card', credit: ['z'], debit: ['x', 'y'] });      // the 50.00 line alone: 1000 - 50 + 200
    });
    it('uses only the layout it is told: an account\'s formula never proves a card', () => {
        // owed 924.75: the CARD formula says 250.50 is a payment; the BANK formula would say 175.25 (100.00 + 75.25) are credits
        expect(proveByTotals({ ...card, closing: 924.75, models: ['bank'] })).toEqual({ fit: 'unique', model: 'bank', credit: ['a', 'c'], debit: ['b'] });
        expect(proveByTotals({ ...card, closing: 924.75, models: ['bank', 'card'] })).toEqual({ fit: 'ambiguous' });
    });
    it('does not guess from missing or malformed figures, or from too many lines', () => {
        expect(proveByTotals({ ...card, closing: undefined })).toEqual({ fit: 'unusable' });
        expect(proveByTotals({ ...card, opening: null, closing: 924.75 })).toEqual({ fit: 'unusable' });
        expect(proveByTotals({ ...card, closing: 924.75, candidates: [] })).toEqual({ fit: 'unusable' });
        expect(proveByTotals({ ...card, closing: 924.75, candidates: ids([['a', 0]]) })).toEqual({ fit: 'unusable' });
        expect(proveByTotals({ ...card, closing: 924.75, candidates: ids(Array.from({ length: 17 }, (_, i) => ['r' + i, 10 + i])) })).toEqual({ fit: 'unusable' });
    });
    it('counts in cents, so a long run of small amounts adds up exactly', () => {
        const tenths = Array.from({ length: 10 }, (_, i) => ['t' + i, 0.1 * (i + 1)]);       // 0.1 ... 1.0, which add up to 5.5 in floating point only by luck
        const total = tenths.reduce((n, [, amount]) => n + amount, 0);
        // every line but the first is a credit: the balances miss by 2 x 5.4
        const out = proveByTotals({ opening: 500, credits: 0, debits: total, closing: Math.round((500 + total - 10.8) * 100) / 100, models: ['card'], candidates: ids(tenths) });
        expect(out).toMatchObject({ fit: 'unique', debit: ['t0'] });
        expect(out.credit).toHaveLength(9);
    });
});

describe('the lines that say money came back are settled by the statement\'s arithmetic', () => {
    const sourcePath = 'wf-mail/owner/items/card1.pdf';
    const reviewDocs = (index, narration, amount) => { const id = sourceOccurrenceId(sourcePath, index); return [[`users/u/statementReview/${id}`, { uid: 'u', sourcePath, index, status: 'pending', reason: 'unproven-direction', bank: 'HNB Credit Card',
        row: { date: '2026-09-' + String(10 + index), narration, description: narration, amount, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true } }], [`users/u/statementLedger/${id}`, { uid: 'u', sourcePath, index, status: 'review' }]]; };
    const world = (lines, proof, extra = [], source = {}) => { const fs = createFirestore(Object.fromEntries([
        ['users/u', { settings: { cardRegistry: { '0048': { type: 'credit_card', bank: 'HNB' } } }, cconetime: [], ccPayments: [] }],
        [sourcePath, { uid: 'u', bank: 'HNB Credit Card', last4: '0048', statementType: 'credit-card', cursor: lines.length, totalRows: lines.length, status: 'needs_review', ...(proof ? { proof } : {}), ...source }],
        ...lines.flatMap(([narration, amount], index) => reviewDocs(index, narration, amount)), ...extra])); return fs; };
    const status = (fs) => lines => lines.map((_, i) => fs.data.get(`users/u/statementReview/${sourceOccurrenceId(sourcePath, i)}`).status);
    // the statement owed 1000.00; the reader added 100.00 + 101.00 + 102.00 + 50.00 = 353.00 as debits (every plain amount); the 101.00 line is the payment: owed = 1000 - 101 + 252 = 1151.00
    const lines = [['KEELLS SUPER COLOMBO', 100], ['PAYMENT THANK YOU', 101], ['ONLINE PAYMENT DIALOG', 102], ['UBER RIDE', 50]];
    const proof = { opening: 1000, closing: 1151, credits: 0, debits: 353 };
    const run = (fs) => proveCardReviews({ db: fs.db, uid: 'u', limit: 10 });

    it('files the payment as a card payment and the other "payment" line as a card purchase, both proven by the statement', async () => {
        const fs = world(lines, proof), out = await run(fs);
        expect(out).toMatchObject({ proved: 4, left: 0, more: false });
        expect(status(fs)(lines)).toEqual(['resolved', 'resolved', 'resolved', 'resolved']);
        const user = fs.data.get('users/u');
        expect(user.ccPayments.map(r => [r.amount, r.directionProof])).toEqual([[101, 'statement']]);
        expect(user.cconetime.map(r => [r.amount, r.directionProof]).sort((a, b) => a[0] - b[0])).toEqual([[50, 'layout'], [100, 'layout'], [102, 'statement']]);
        expect(out.why.totals).toMatchObject({ tried: 1, unique: 1, filed: 2, rules: 0, refused: 0 });
    });
    it('says nothing about the lines themselves in the log: counts and fixed words only', async () => {
        const out = await run(world(lines, proof));
        expect(JSON.stringify(out.why)).not.toMatch(/THANK|DIALOG|KEELLS|UBER|101|102|1151|1000/i);
    });
    it('leaves every line for the owner when the balances do not add up to any choice', async () => {
        const fs = world(lines, { ...proof, closing: 1160 }), out = await run(fs);
        expect(out).toMatchObject({ proved: 2, left: 2 });                                 // the two plain purchases only (by the layout)
        expect(status(fs)(lines)).toEqual(['resolved', 'pending', 'pending', 'resolved']);
        expect(out.why.totals).toMatchObject({ tried: 1, none: 1, filed: 0 });
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
    });
    it('leaves them when two different choices add up (two lines of the same amount)', async () => {
        const same = [['PAYMENT THANK YOU', 100], ['ONLINE PAYMENT DIALOG', 100], ['UBER RIDE', 50]];
        const fs = world(same, { opening: 1000, closing: 1000 - 100 + 100 + 50 /* one of them is a payment */ - 0, credits: 0, debits: 250 }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 1, ambiguous: 1, filed: 0 });
        expect(status(fs)(same)).toEqual(['pending', 'pending', 'resolved']);
    });
    it('does not try a statement with no printed totals, or a bank account\'s', async () => {
        const bare = world(lines), out = await run(bare);
        expect(out.why.totals).toMatchObject({ tried: 1, unusable: 1, filed: 0 });
        expect(status(bare)(lines)).toEqual(['resolved', 'pending', 'pending', 'resolved']);
        const bank = world(lines, proof, [], { statementType: 'bank_account', last4: '1234', bank: 'DFCC' });
        bank.data.get('users/u').settings.cardRegistry = {};
        expect((await run(bank)).why.totals).toBeUndefined();
    });
    it('does not try a statement whose waiting lines were not all looked at', async () => {
        const fs = world(lines, proof), out = await proveCardReviews({ db: fs.db, uid: 'u', limit: 1 });         // one filed, then the limit: some lines are not reached
        expect(out.more).toBe(true);
        expect(out.why.totals?.filed ?? 0).toBe(0);
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
    });
    it('closes a proven line whose entry is already in the books as the copy it is, and files the others', async () => {
        const fs = world(lines, proof);
        fs.data.get('users/u').ccPayments.push({ id: 'old', date: '2026-09-11', amount: 101, desc: 'PAYMENT THANK YOU', category: 'Card Payment', bank: 'HNB Credit Card', direction: 'credit', card_last4: '0048' });
        const out = await run(fs);
        expect(out.why.totals).toMatchObject({ unique: 1, filed: 1, duplicate: 1, refused: 0 });
        expect(status(fs)(lines)).toEqual(['resolved', 'dismissed', 'resolved', 'resolved']);          // the money is counted once, by the entry that was there
        expect(fs.data.get(`users/u/statementReview/${sourceOccurrenceId(sourcePath, 1)}`).dismissedBy).toBe('statement-totals-duplicate');
        expect(fs.data.get('users/u').ccPayments.map(r => r.id)).toEqual(['old']);
        expect(out).toMatchObject({ proved: 4, left: 0 });
    });
    it('writes the one attempt on the statement before it files anything, and never tries the same statement again', async () => {
        const fs = world(lines, proof), out = await run(fs);
        expect(out.why.totals).toMatchObject({ unique: 1, filed: 2 });
        expect(fs.data.get(sourcePath).totalsProof).toMatchObject({ v: 1, lines: 2 });
        const again = world(lines, proof, [], { totalsProof: { v: 1, at: 1, lines: 2 } }), second = await run(again);
        expect(second.why.totals).toMatchObject({ tried: 0, stamped: 1, filed: 0 });
        expect(status(again)(lines)).toEqual(['resolved', 'pending', 'pending', 'resolved']);          // only the plain purchases, by the layout
        expect(again.data.get('users/u').ccPayments).toEqual([]);
    });
    it('refuses the proof when the page of pending reviews did not hold the statement\'s whole list', async () => {
        // 600 other pending reviews come before one more waiting "payment" line of the same statement: the page of 500 never reaches it, so the sums would be added up over a shorter list than the statement has
        const filler = Array.from({ length: 600 }, (_, i) => [`users/u/statementReview/filler-${String(i).padStart(4, '0')}`, { uid: 'u', sourcePath: 'wf-mail/owner/items/other.pdf', index: 0, status: 'pending', reason: 'duplicate-suspect', row: { amount: 1 } }]);
        const fs = world(lines, proof, [...filler, ...reviewDocs(9, 'PAYMENT RECEIVED', 7).slice(0, 1).map(([path, data]) => [path.replace('/statementReview/', '/statementReview/zz-'), data])]);
        const out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 0, partial: 1, filed: 0 });
        expect(fs.data.get(sourcePath).totalsProof).toBeUndefined();
        expect(status(fs)(lines)).toEqual(['resolved', 'pending', 'pending', 'resolved']);
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
    });
});

// Production, 2026-11-03 18:00 UTC: an interactive run spent its twelve front seconds on the mailbox (`frontIncomplete`), so the sweep, which stood in the front pass, was never reached and the 22 rows stayed in Open reviews for hours after the
// fix was deployed. It is a step of the run's tail now, which a run that is out of front time still reaches.
import { runStatementSync } from '../statement-sync.js';

describe('the sweep runs even when the front of the run had no time left', () => {
    afterEach(() => vi.restoreAllMocks());
    const mailPath = 'wf-mail/owner_example_com', card = `${mailPath}/items/card1.pdf`, owner = { uid: 'u', email: 'owner@example.com' };
    const world = (count = 3) => {
        const now = 1_900_000_000_000;
        const reviewDoc = (index, narration) => { const id = sourceOccurrenceId(card, index); return [[`users/u/statementReview/${id}`, { uid: 'u', sourcePath: card, index, status: 'pending', reason: 'unproven-direction', bank: 'HNB Credit Card',
            row: { date: '2026-09-' + String(1 + (index % 28)).padStart(2, '0'), narration, description: narration, amount: 100 + index, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true } }], [`users/u/statementLedger/${id}`, { uid: 'u', sourcePath: card, index, status: 'review' }]]; };
        const fs = createFirestore(Object.fromEntries([
            [mailPath, { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, lastCensusMs: now, lastLoanHealMs: now, lastRecoveryMs: now, senders: [{ id: 'statements@bank.example', kind: 'address', status: 'approved' }] }],
            ['wf-statement-vault/u', { uid: 'u' }],
            ['users/u', { settings: { cardRegistry: { '0048': { type: 'credit_card', bank: 'HNB' } } }, expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] }],
            [card, { uid: 'u', bank: 'HNB Credit Card', last4: '0048', statementType: 'credit-card', cursor: 3, totalRows: 3, status: 'needs_review', hasReview: true }],
            ...(count === 3 ? [reviewDoc(0, 'KEELLS SUPER COLOMBO'), reviewDoc(1, 'UBER RIDE'), reviewDoc(2, 'SOME UNKNOWN SHOP')] : Array.from({ length: count }, (_, i) => reviewDoc(i, 'SHOP NUMBER ' + i))).flat()]));
        const f = async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });
        let clock = now; vi.spyOn(Date, 'now').mockImplementation(() => clock);
        const intake = async () => { clock += 20000; return { body: { ok: true, collectionPending: false } }; };
        return { fs, f, intake };
    };
    it('files the waiting card rows from the tail of an interactive run whose front was skipped, and says so in one counts-only line', async () => {
        const { fs, f, intake } = world(), lines = [];
        const info = vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
        let result;
        try { result = await runStatementSync({ action: 'collect', interactive: true, budgetMs: 45000, db: fs.db, owner, env: {}, f, intake, board: async () => { throw new Error('off'); }, extract: async () => { throw new Error('off'); } }); } finally { info.mockRestore(); }
        const events = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        expect(events.find(e => e.evt === 'statement-sync-run')).toMatchObject({ front: true, frontIncomplete: true });
        expect(result.cardRowsProved).toBe(3);
        expect(events.find(e => e.evt === 'statement-card-proof')).toMatchObject({ proved: 3, left: 0, more: false });
        expect(JSON.stringify(events.find(e => e.evt === 'statement-card-proof'))).not.toMatch(/KEELLS|UBER/);      // counts only
        expect(fs.data.get('users/u').cconetime).toHaveLength(3);
        expect(fs.data.get(mailPath).lastCardProofMs).toBeGreaterThan(0);           // a pass that had nothing left is not repeated for a minute
    });
    it('a pass that did not get through brings the chain straight back, is not held back by the minute, and the next one finishes it', async () => {
        const { fs, f, intake } = world(30);
        const go = async () => { const info = vi.spyOn(console, 'info').mockImplementation(() => {}); try { return await runStatementSync({ action: 'collect', interactive: true, budgetMs: 45000, db: fs.db, owner, env: {}, f, intake, board: async () => { throw new Error('off'); }, extract: async () => { throw new Error('off'); } }); } finally { info.mockRestore(); } };
        const first = await go();
        expect(first.cardRowsProved).toBe(25);                                      // 25 a run on an interactive call
        expect(first.morePending).toBe(true); expect(first.retryAfterMs).toBe(750);   // the app asks again at once
        expect(fs.data.get(mailPath).lastCardProofMs).toBeUndefined();              // the minute does not hold the second pass back
        const second = await go();
        expect(second.cardRowsProved).toBe(5);
        expect(fs.data.get('users/u').cconetime).toHaveLength(30);
    });
});

// The owner's statement (2026-11-04 17:24 UTC): 8 "payment" lines + 1 line the reader could not file whole waited, and the arithmetic over the 8 lines alone found no fit (`none`, reason `range`). A line without a real date or
// words is still ADDED UP by the reader as an unmarked line (a debit), so if it is really money coming back it is part of the balances' miss and was not among the candidates. The second rung adds it; the third thing the sweep
// does is say, in fixed words and counts only, how far off the sums are, so the next sync tells why.
import { explainMiss } from '../statement-direction.mjs';

describe('explainMiss: how far off the balances are, in fixed words and counts', () => {
    const ids = (list) => list.map(([id, amount]) => ({ id, amount }));
    const base = { opening: 1000, credits: 0, debits: 425.75, candidates: ids([['a', 100], ['b', 250.5], ['c', 75.25]]) };
    it('says the miss fits inside the waiting lines, in one way', () => {
        expect(explainMiss({ ...base, closing: 924.75 })).toEqual({ miss: 'even', vsWaiting: 'le1', vsAll: 'le1', ways: 1, waysAll: 1 });
    });
    it('names the figures that make it unusable, and the wrong-way and odd-cent misses', () => {
        expect(explainMiss({ ...base, closing: undefined })).toEqual({ miss: 'unread' });
        expect(explainMiss({ ...base, closing: 1500 })).toEqual({ miss: 'negative' });
        expect(explainMiss({ ...base, closing: 1234.56 })).toEqual({ miss: 'odd' });
        expect(explainMiss({ ...base, closing: 1425.75 })).toEqual({ miss: 'zero' });
    });
    it('tells a line outside the waiting ones from a model that cannot hold: 0 ways over every line means the figures are wrong', () => {
        // half the miss is 400.00; the waiting lines add up to 425.75 but make no 400.00; with a 150.00 line already filed and a 250.00 invalid line, 150 + 250 does
        const out = explainMiss({ opening: 2000, credits: 0, debits: 1000, closing: 2000 + 1000 - 800, candidates: ids([['a', 100], ['b', 325.75]]), extras: ids([['x', 250]]), filed: ids([['f', 150]]) });
        expect(out).toMatchObject({ miss: 'even', vsWaiting: 'le1', ways: 0, waysAll: 1 });
        expect(explainMiss({ opening: 2000, credits: 0, debits: 1000, closing: 1000, candidates: ids([['a', 100]]), filed: ids([['f', 90]]) })).toMatchObject({ vsWaiting: 'gt4', vsAll: 'gt4', ways: 0, waysAll: 0 });
    });
    it('never carries an amount or a name', () => {
        expect(JSON.stringify(explainMiss({ ...base, closing: 924.75 }))).not.toMatch(/250|924|425|1000|100/);
    });
});

describe('a line the reader could not file whole is part of the statement\'s proof', () => {
    const sourcePath = 'wf-mail/owner/items/card2.pdf';
    const line = (index, narration, amount, extra = {}, reason = 'unproven-direction') => { const id = sourceOccurrenceId(sourcePath, index); return [[`users/u/statementReview/${id}`, { uid: 'u', sourcePath, index, status: 'pending', reason, bank: 'HNB Credit Card',
        row: { date: '2026-09-' + String(10 + index), narration, description: narration, amount, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: reason === 'unproven-direction', ...extra } }], [`users/u/statementLedger/${id}`, { uid: 'u', sourcePath, index, status: 'review' }]]; };
    const lines = [['KEELLS SUPER COLOMBO', 100], ['PAYMENT THANK YOU', 101], ['ONLINE PAYMENT DIALOG', 102], ['UBER RIDE', 50]];
    const world = (invalid, proof) => createFirestore(Object.fromEntries([
        ['users/u', { settings: { cardRegistry: { '0048': { type: 'credit_card', bank: 'HNB' } } }, cconetime: [], ccPayments: [] }],
        [sourcePath, { uid: 'u', bank: 'HNB Credit Card', last4: '0048', statementType: 'credit-card', cursor: 5, totalRows: 5, status: 'needs_review', proof }],
        ...lines.flatMap(([narration, amount], index) => line(index, narration, amount)), ...(invalid ? line(4, invalid.narration, invalid.amount, invalid.row || {}, 'invalid-transaction') : [])]));
    const run = (fs) => proveCardReviews({ db: fs.db, uid: 'u', limit: 10 });
    const state = (fs, index) => fs.data.get(`users/u/statementReview/${sourceOccurrenceId(sourcePath, index)}`).status;
    // owed 1000.00; read as debits: 100 + 101 + 102 + 50 + 77 = 430.00; the 101.00 payment and the 77.00 line are really credits, so it closed at 1000 + 430 - 2 x 178 = 1074.00
    const proof = { opening: 1000, closing: 1074, credits: 0, debits: 430 };

    it('proves the waiting lines AND the unreadable one when only together do the balances add up, and files all three', async () => {
        const fs = world({ narration: '', amount: 77 }, proof), out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 1, none: 1, noneBy: { subset: 1 }, rung2: { tried: 1, unique: 1 }, filed: 3, refused: 0 });
        expect([0, 1, 2, 3, 4].map(i => state(fs, i))).toEqual(['resolved', 'resolved', 'resolved', 'resolved', 'resolved']);
        const user = fs.data.get('users/u');
        expect(user.ccPayments.map(r => [r.amount, r.directionProof, r.desc]).sort((a, b) => a[0] - b[0])).toEqual([[77, 'statement', 'Statement line (no description printed)'], [101, 'statement', 'PAYMENT THANK YOU']]);
        expect(user.cconetime.map(r => r.amount).sort((a, b) => a - b)).toEqual([50, 100, 102]);
        expect(out).toMatchObject({ left: 0 });
        expect(fs.data.get(sourcePath).totalsProof).toMatchObject({ v: 1, lines: 3 });
    });
    it('files the unreadable line as a purchase when the waiting lines alone already add up (it is then a debit like every other line the reader added up)', async () => {
        // only the 102.00 line is a credit: 1000 + 430 - 2 x 102 = 1226.00; the 77.00 line is a plain debit
        const fs = world({ narration: '', amount: 77 }, { ...proof, closing: 1226 }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 1, unique: 1, filed: 3 });
        expect(out.why.totals.rung2).toBeUndefined();
        expect(fs.data.get('users/u').ccPayments.map(r => r.amount)).toEqual([102]);
        expect(fs.data.get('users/u').cconetime.map(r => r.amount).sort((a, b) => a - b)).toEqual([50, 77, 100, 101]);
        expect(state(fs, 4)).toBe('resolved');
    });
    it('leaves the line pending, and the rest of the proof filed, when its date is not a real one', async () => {
        const fs = world({ narration: '', amount: 77, row: { date: '2026-13-45' } }, proof), out = await run(fs);
        expect(out.why.totals).toMatchObject({ rung2: { unique: 1 }, filed: 2, refused: 1 });
        expect([1, 2, 4].map(i => state(fs, i))).toEqual(['resolved', 'resolved', 'pending']);
        expect(fs.data.get('users/u').ccPayments.map(r => r.amount)).toEqual([101]);
    });
    it('says how far off the sums are, with no amount and no name in the log, when even the second rung finds no fit', async () => {
        const fs = world({ narration: '', amount: 77 }, { ...proof, closing: 1000 + 430 - 2 * 900 }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 1, none: 1, noneBy: { range: 1 }, rung2: { tried: 1, none: 1 }, filed: 0 });
        expect(out.why.totals.diag).toEqual([{ miss: 'even', vsWaiting: 'gt4', vsAll: 'gt4', ways: 0, waysAll: 0, invalid: 1, filed: 2 }].map(d => ({ ...d, vsWaiting: expect.any(String), vsAll: expect.any(String) })));
        expect(JSON.stringify(out.why)).not.toMatch(/THANK|DIALOG|KEELLS|UBER|1074|1000|900|77/);
    });
    it('does not try a second rung when no unreadable line is waiting, but still says how far off it is', async () => {
        const fs = world(null, { opening: 1000, closing: 1000 + 353 - 2 * 400, credits: 0, debits: 353 }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ noneBy: { range: 1 }, filed: 0 });
        expect(out.why.totals.rung2).toBeUndefined();
        expect(out.why.totals.diag).toEqual([expect.objectContaining({ miss: 'even', invalid: 0, filed: 2, ways: 0, waysAll: 0 })]);
    });
});
