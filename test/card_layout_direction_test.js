import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { proveDirections, cardCreditWords, printedPaymentsCheck } from '../statement-direction.mjs';
import { PROVEN_DIRECTION, validateSettlementRow } from '../statement-ledger.mjs';
import { readShape, deterministicDecision, adaptiveWanted, readingIsSuspect, secondOpinionAgrees } from '../statement-sync.js';

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
    it('closes the unreadable line as NOT a transaction when only without it do the balances add up (a printed total the reader added as a debit)', async () => {
        // only the 102.00 line is a credit: closing 1000 + 100 + 101 + 50 - 102 = 1149.00; the reader also added a 78.00 line that is not a transaction: debits 100 + 101 + 102 + 50 + 78 = 431.00 (100 and 50 are filed by the layout)
        const fs = world({ narration: '', amount: 78 }, { opening: 1000, closing: 1149, credits: 0, debits: 431 }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 1, none: 1, rung2: { tried: 1, none: 1 }, rung4: { tried: 1, unique: 1 }, filed: 2, notALine: 1, refused: 0 });
        expect([0, 1, 2, 3].map(i => state(fs, i))).toEqual(['resolved', 'resolved', 'resolved', 'resolved']);
        expect(state(fs, 4)).toBe('dismissed');
        expect(fs.data.get(`users/u/statementReview/${sourceOccurrenceId(sourcePath, 4)}`).dismissedBy).toBe('statement-totals-not-a-line');
        const user = fs.data.get('users/u');
        expect(user.ccPayments.map(r => r.amount)).toEqual([102]);
        expect(user.cconetime.map(r => r.amount).sort((a, b) => a - b)).toEqual([50, 100, 101]);
        expect(fs.data.get(sourcePath).totalsProof).toMatchObject({ v: 1, drop: [sourceOccurrenceId(sourcePath, 4)] });
        expect(JSON.stringify(out.why)).not.toMatch(/KEELLS|THANK|UBER|1149|431|78/);
    });
    it('finishes closing the not-a-transaction line a stopped run had decided on (the stamp keeps it)', async () => {
        const fs = world({ narration: '', amount: 78 }, { opening: 1000, closing: 1149, credits: 0, debits: 431 });
        fs.data.get(sourcePath).totalsProof = { v: 1, at: 1, lines: 2, credit: [sourceOccurrenceId(sourcePath, 1)], debit: [sourceOccurrenceId(sourcePath, 2)], drop: [sourceOccurrenceId(sourcePath, 4)] };
        const out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 0, stamped: 1, resumed: 1, notALine: 1 });
        expect(state(fs, 4)).toBe('dismissed');
    });
    it('leaves the unreadable line alone when without it the balances still do not add up', async () => {
        const fs = world({ narration: '', amount: 78 }, { opening: 1000, closing: 1150, credits: 0, debits: 431 }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ rung4: { tried: 1, none: 1 }, filed: 0 });
        expect(state(fs, 4)).toBe('pending');
        expect(fs.data.get(sourcePath).totalsProof).toBeUndefined();
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
        expect(out.why.totals.diag).toEqual([{ miss: 'even', vsWaiting: 'gt4', vsAll: 'gt4', ways: 0, waysAll: 0, invalid: 1, filed: 2, witnessed: 0 }].map(d => ({ ...d, vsWaiting: expect.any(String), vsAll: expect.any(String) })));
        expect(JSON.stringify(out.why)).not.toMatch(/THANK|DIALOG|KEELLS|UBER|1074|1000|900|77/);
    });
    it('does not try a second rung when no unreadable line is waiting, but still says how far off it is', async () => {
        const fs = world(null, { opening: 1000, closing: 1000 + 353 - 2 * 400, credits: 0, debits: 353 }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ noneBy: { range: 1 }, filed: 0 });
        expect(out.why.totals.rung2).toBeUndefined();
        expect(out.why.totals.diag).toEqual([expect.objectContaining({ miss: 'even', invalid: 0, filed: 2, ways: 0, waysAll: 0 })]);
    });
});

// Production, 2026-11-04 18:46 UTC (`why.totals.diag`: miss "even", vsAll le1, ways 0, waysAll 2, invalid 1, filed 15): half the balances' miss is more than ALL the waiting lines and the unreadable line, and fits only with
// lines the layout proof already FILED as purchases. The amounts alone make two choices, so a second, independent witness is asked: the owner's own bank paid exactly that amount just before the card posted it.
import { lineIdsWithBankPayment } from '../statement-credit-evidence.mjs';

describe('lineIdsWithBankPayment: which lines of a card statement have a bank payment behind them', () => {
    const user = { expenses: [
        { id: 'b1', source: 'statement', statementKey: 'wf-mail/owner/items/bank.pdf', amount: 400, date: '2026-09-10' },
        { id: 'b2', source: 'statement', statementKey: 'wf-mail/owner/items/card3.pdf', amount: 77, date: '2026-09-10' },          // this statement's own record is no witness of itself
        { id: 'b3', source: 'manual', amount: 55, date: '2026-09-10' },                                                         // typed by hand: not a bank statement
    ] };
    const at = (id, amount, date) => ({ id, amount, date });
    it('finds a bank payment of the same amount from four days before the card posted it to three days after (a weekend lag)', () => {
        const ids = lineIdsWithBankPayment(user, [at('a', 400, '2026-09-14'), at('b', 400, '2026-09-09'), at('c', 400, '2026-09-15'), at('d', 400, '2026-09-08'), at('f', 400, '2026-09-07'), at('g', 400, '2026-09-06'), at('e', 400.01, '2026-09-12')], { sourcePath: 'wf-mail/owner/items/card3.pdf' });
        expect([...ids].sort()).toEqual(['a', 'b', 'd', 'f']);       // 4 days after the bank (a), 1, 2 and 3 days before it (b, d, f); 5 days after (c), 4 days before (g) and another amount (e) are not
    });
    it('can be asked wider only to count: any day, and a hand-typed entry too', () => {
        expect(lineIdsWithBankPayment(user, [at('h', 400, '2026-12-25'), at('i', 55, '2026-09-10')], { sourcePath: 'wf-mail/owner/items/card3.pdf', before: 4000, after: 4000 }).size).toBe(1);
        expect(lineIdsWithBankPayment(user, [at('h', 400, '2026-12-25'), at('i', 55, '2026-09-10')], { sourcePath: 'wf-mail/owner/items/card3.pdf', before: 4000, after: 4000, anySource: true }).size).toBe(2);
    });
    it('does not count the statement\'s own records or a hand-typed one', () => {
        expect(lineIdsWithBankPayment(user, [at('x', 77, '2026-09-10'), at('y', 55, '2026-09-10')], { sourcePath: 'wf-mail/owner/items/card3.pdf' }).size).toBe(0);
    });
});

describe('the money paid to the card is found among the lines already filed as purchases', () => {
    const sourcePath = 'wf-mail/owner/items/card3.pdf', bankPath = 'wf-mail/owner/items/bank.pdf';
    const id = (index) => sourceOccurrenceId(sourcePath, index);
    const waiting = (index, narration, amount) => [[`users/u/statementReview/${id(index)}`, { uid: 'u', sourcePath, index, status: 'pending', reason: 'unproven-direction', bank: 'HNB Credit Card',
        row: { date: '2026-09-1' + index, narration, description: narration, amount, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true } }], [`users/u/statementLedger/${id(index)}`, { uid: 'u', sourcePath, index, status: 'review' }]];
    const filed = (index, desc, amount, date, proof = 'layout') => ({ id: id(index), statementKey: sourcePath, statementRow: index, bank: 'HNB Credit Card', card_last4: '0048', direction: 'debit', amount, date, source: 'statement', desc, cat: 'Card Purchase', directionProof: proof });
    const world = ({ cconetime, expenses = [], proof, totalsProof }) => createFirestore(Object.fromEntries([
        ['users/u', { settings: { cardRegistry: { '0048': { type: 'credit_card', bank: 'HNB' } } }, cconetime, ccPayments: [], expenses }],
        [sourcePath, { uid: 'u', bank: 'HNB Credit Card', last4: '0048', statementType: 'credit-card', cursor: 4, totalRows: 4, status: 'needs_review', proof, ...(totalsProof ? { totalsProof } : {}) }],
        ...waiting(0, 'PAYMENT THANK YOU', 101), ...waiting(1, 'ONLINE PAYMENT DIALOG', 102),
        ...cconetime.map(record => [`users/u/statementLedger/${record.id}`, { uid: 'u', sourcePath, index: record.statementRow, status: 'filed' }])]));
    const run = (fs) => proveCardReviews({ db: fs.db, uid: 'u', limit: 10 });
    const bank = { id: 'bk1', source: 'statement', statementKey: bankPath, amount: 400, date: '2026-09-10', desc: 'CEFT TRANSFER' };
    // owed 1000.00; the reader added 101 + 102 + 50 + 400 = 653.00 as debits; the 101.00 line and the 400.00 line are the payments: 1000 + 653 - 2 x 501 = 651.00
    const proof = { opening: 1000, closing: 651, credits: 0, debits: 653 };
    const purchases = () => [filed(2, 'UBER RIDE', 50, '2026-09-12'), filed(3, 'CEFT TRANSFER 123', 400, '2026-09-13')];

    it('moves the witnessed purchase to Card payments, proves the waiting lines, and keeps the purchase whole in the trash', async () => {
        const fs = world({ cconetime: purchases(), expenses: [bank], proof }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 1, none: 1, noneBy: { range: 1 }, rung3: { tried: 1, unique: 1, witnessed: 1, probe: { lines: 2, near: 1, wide: 1, anyDay: 1, anySource: 1 } }, filed: 2, moved: 1, refused: 0 });
        const user = fs.data.get('users/u');
        expect(user.ccPayments.map(r => [r.amount, r.directionProof]).sort((a, b) => a[0] - b[0])).toEqual([[101, 'statement'], [400, 'statement']]);
        expect(user.cconetime.map(r => r.amount).sort((a, b) => a - b)).toEqual([50, 102]);
        const moved = user.ccPayments.find(r => r.amount === 400);
        expect(moved).toMatchObject({ id: id(3), direction: 'credit', autoDecided: 'statement-totals', desc: 'CEFT TRANSFER 123', statementKey: sourcePath });
        const trash = fs.data.get(`users/u/statementTrash/cconetime_${id(3)}`);
        expect(trash).toMatchObject({ reason: 'statement-totals-payment', store: 'cconetime' });
        expect(trash.record).toMatchObject({ amount: 400, direction: 'debit', desc: 'CEFT TRANSFER 123' });
        expect(user._tomb.cconetime[id(3)]).toBeGreaterThan(0);
        expect(fs.data.get(`users/u/statementLedger/${id(3)}`)).toMatchObject({ status: 'filed', module: 'ccPayments', reclassified: 'statement-totals' });
        expect(fs.data.get(sourcePath).totalsProof).toMatchObject({ v: 1, lines: 3 });
        expect(JSON.stringify(out.why)).not.toMatch(/CEFT|THANK|DIALOG|UBER|651|1000|653|400/);
    });
    it('stamps the statement INSIDE the move, with the decision, so a half-run can be finished', async () => {
        const fs = world({ cconetime: purchases(), expenses: [bank], proof }); await run(fs);
        expect(fs.data.get(sourcePath).totalsProof).toMatchObject({ v: 1, lines: 3, credit: [id(0), id(3)].sort(), debit: [id(1)] });
    });
    it('files nothing and stamps nothing when the books changed under the move (the purchase was edited by the owner meanwhile)', async () => {
        const fs = world({ cconetime: purchases(), expenses: [bank], proof }), real = fs.db.runTransaction.bind(fs.db);
        fs.db.runTransaction = async (fn, ...rest) => { fs.data.get('users/u').cconetime[1].directionProof = 'owner'; return real(fn, ...rest); };
        const out = await run(fs);
        expect(out.why.totals).toMatchObject({ rung3: { tried: 1, unique: 1 }, filed: 0, refused: 1 });
        expect(out.why.totals.moved).toBeUndefined();
        expect(fs.data.get(sourcePath).totalsProof).toBeUndefined();
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
        expect(fs.data.get('users/u').cconetime).toHaveLength(2);
        expect([0, 1].map(i => fs.data.get(`users/u/statementReview/${id(i)}`).status)).toEqual(['pending', 'pending']);
    });
    it('finishes what a stopped run decided: the stamp keeps the choice, and the lines still waiting are filed exactly so, with no new arithmetic', async () => {
        const stamp = { v: 1, at: 1, lines: 3, credit: [id(0), id(3)], debit: [id(1)] };
        const fs = world({ cconetime: [purchases()[0]], expenses: [bank], proof, totalsProof: stamp }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 0, stamped: 1, resumed: 1, filed: 2, refused: 0 });
        const user = fs.data.get('users/u');
        expect(user.ccPayments.map(r => r.amount)).toEqual([101]);
        expect(user.cconetime.map(r => r.amount).sort((a, b) => a - b)).toEqual([50, 102]);
    });
    it('a stamp from before the decision was kept (no lists) still only blocks', async () => {
        const fs = world({ cconetime: purchases(), expenses: [bank], proof, totalsProof: { v: 1, at: 1, lines: 3 } }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ tried: 0, stamped: 1, filed: 0 });
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
    });
    it('touches nothing when no bank payment stands behind any filed purchase, and says how many were looked at', async () => {
        const fs = world({ cconetime: purchases(), expenses: [], proof }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ rung3: { tried: 0, witnessed: 0, probe: { lines: 2, near: 0, wide: 0, anyDay: 0, anySource: 0 } }, filed: 0 });
        expect(out.why.totals.moved).toBeUndefined();
        expect(out.why.totals.diag).toEqual([expect.objectContaining({ miss: 'even', filed: 2, witnessed: 0 })]);
        expect(fs.data.get('users/u').cconetime).toHaveLength(2);
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
        expect(fs.data.get(sourcePath).totalsProof).toBeUndefined();
    });
    it('never moves a purchase the layout did not prove (one a marker, a balance or the owner decided)', async () => {
        const fs = world({ cconetime: [filed(2, 'UBER RIDE', 50, '2026-09-12'), filed(3, 'CEFT TRANSFER 123', 400, '2026-09-13', 'marker')], expenses: [bank], proof }), out = await run(fs);
        expect(out.why.totals.rung3).toMatchObject({ witnessed: 0 });
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
    });
    it('does not guess when two witnessed purchases both make the sum', async () => {
        const two = [filed(2, 'TRANSFER A', 400, '2026-09-12'), filed(3, 'TRANSFER B', 400, '2026-09-13')];
        const fs = world({ cconetime: two, expenses: [bank], proof: { opening: 1000, closing: 1000 + 903 - 2 * 501, credits: 0, debits: 903 } }), out = await run(fs);
        expect(out.why.totals).toMatchObject({ rung3: { tried: 1, ambiguous: 1, witnessed: 2 }, filed: 0 });
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
        expect(fs.data.get('users/u').cconetime).toHaveLength(2);
    });
});

// HNB credit card e-statement, owner's file (two months), read from a screenshot with names and numbers replaced: the bank prints "CR" BEFORE the amount ("Payment 004   CR   150,000.00"), and "Conv_Trxn_To_Inst   USD 527.55   CR   175,674.15" puts it
// between the foreign amount and the amount. The reader looked for CR only AFTER a number, so every payment was an assumed debit and both conversions were filed as purchases. Merchant names and the card number are invented; the figures are the statement's own.
describe('the CR the bank prints BEFORE the amount is the amount\'s own marker', () => {
    const real = ['Statement of Account', 'Card Number 4000 0000 0000 0001', 'Credit Limit 350,000.00',
        '11/08/2026 11/08/2026 Annual Fee 4,000.00', '19/08/2026 19/08/2026 Payment 004 CR 150,000.00', '20/08/2026 19/08/2026 ELECTRONICS SHOP, COLOMBO 3 413,000.00',
        '24/08/2026 19/08/2026 DUTY FREE SHOP, COLOMBO 1 USD 527.55 175,674.15', '24/08/2026 24/08/2026 Conv_Trxn_To_Inst USD 527.55 CR 175,674.15', '24/08/2026 24/08/2026 Instalment Principle - 1/12 14,639.51',
        '17/09/2026 16/09/2026 Payment 074 CR 100.00', '17/09/2026 16/09/2026 PIZZA PLACE, COLOMBO, LKA 6,075.00'].join('\n');
    it('reads the payments and the instalment conversion as credits by the statement\'s own marker, and every other line as before', () => {
        const rows = P.parseStatement(real).rows;
        expect(rows.map(r => [r.amount, r.direction, r.directionSource])).toEqual([[4000, 'debit', 'assumed'], [150000, 'credit', 'marker'], [413000, 'debit', 'assumed'], [175674.15, 'debit', 'assumed'], [175674.15, 'credit', 'marker'], [14639.51, 'debit', 'assumed'], [100, 'credit', 'marker'], [6075, 'debit', 'assumed']]);
        expect(rows.filter(r => r.direction === 'credit').every(r => r.needsReview === false)).toBe(true);
    });
    it('does not take the trailing CR of one amount for the leading marker of the next ("1,000.00 CR 5,000.00")', () => {
        const rows = P.parseStatement(['Opening Balance 10,000.00', '01/09/2026 SALARY 1,000.00 CR 11,000.00', '02/09/2026 SHOP 500.00 10,500.00', 'Closing Balance 10,500.00'].join('\n')).rows;
        expect(rows.map(r => [r.amount, r.direction, r.directionSource])).toEqual([[1000, 'credit', 'balance'], [500, 'debit', 'balance']]);
    });
    it('knows an instalment conversion as money that came back, so the layout never files it as a purchase', () => {
        expect(cardCreditWords({ narration: 'Conv_Trxn_To_Inst' })).toBe(true);
        expect(proveDirections(P.parseStatement(real), { card: true }).rows.filter(r => /Conv/.test(r.narration)).map(r => r.directionSource)).toEqual(['marker']);
    });
});

describe('the statement above, already read and filed the old way, is settled by its own arithmetic', () => {
    const sourcePath = 'wf-mail/owner/items/card-two-months.pdf';
    const id = (index) => sourceOccurrenceId(sourcePath, index);
    const pays = [150000, 50000, 50000, 25000, 1000, 100, 100, 5000];
    const waiting = (index, amount) => [[`users/u/statementReview/${id(index)}`, { uid: 'u', sourcePath, index, status: 'pending', reason: 'unproven-direction', bank: 'HNB Credit Card',
        row: { date: '2026-08-19', narration: 'Payment 004 CR', description: 'Payment 004 CR', amount, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true } }], [`users/u/statementLedger/${id(index)}`, { uid: 'u', sourcePath, index, status: 'review' }]];
    const invalid = [[`users/u/statementReview/${id(8)}`, { uid: 'u', sourcePath, index: 8, status: 'pending', reason: 'invalid-transaction', bank: 'HNB Credit Card',
        row: { date: '', narration: '', description: '', amount: 281200, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: false } }], [`users/u/statementLedger/${id(8)}`, { uid: 'u', sourcePath, index: 8, status: 'review' }]];
    const purchases = [['Annual Fee', 4000], ['ELECTRONICS SHOP, COLOMBO 3', 413000], ['HIGHWAY INTERCHANGE FEE', 300], ['FUEL STATION (PVT) LTD, TOWN', 3078], ['HARDWARE & SONS PVT, COLOMBO', 3335.02], ['DUTY FREE SHOP, COLOMBO 1', 8658],
        ['DUTY FREE SHOP, COLOMBO 1', 175674.15], ['DUTY FREE SHOP, COLOMBO 1', 13320], ['Conv_Trxn_To_Inst', 175674.15], ['Conv_Trxn_To_Inst', 13320], ['Instalment Principle - 1/12', 14639.51], ['Instalment Principle - 1/12', 1110], ['PIZZA PLACE, COLOMBO, LKA', 6075],
        ['Instalment Principle - 2/12', 14639.51], ['Instalment Principle - 2/12', 1110]];
    const filed = purchases.map(([desc, amount], at) => ({ id: id(9 + at), statementKey: sourcePath, statementRow: 9 + at, bank: 'HNB Credit Card', card_last4: '0001', direction: 'debit', amount, date: '2026-08-20', source: 'statement', desc, cat: 'Card Purchase', directionProof: 'layout' }));
    // previous balance 50,000.00; the bank's closing is 50,000 + 623,440.17 purchases + 31,499.02 instalments + 4,000 fee - 281,200 payments - 188,994.15 conversions = 238,745.04; the reader added every line as a debit, the printed total of payments (281,200.00) too
    const proof = { opening: 50000, closing: 238745.04, credits: 0, debits: 1410333.34 };
    const world = (cconetime = filed) => createFirestore(Object.fromEntries([
        ['users/u', { settings: { cardRegistry: { '0001': { type: 'credit_card', bank: 'HNB' } } }, cconetime, ccPayments: [], expenses: [] }],
        [sourcePath, { uid: 'u', bank: 'HNB Credit Card', last4: '0001', statementType: 'credit-card', cursor: 24, totalRows: 24, status: 'needs_review', proof }],
        ...pays.flatMap((amount, index) => waiting(index, amount)), ...invalid, ...cconetime.map(record => [`users/u/statementLedger/${record.id}`, { uid: 'u', sourcePath, index: record.statementRow, status: 'filed' }])]));
    it('files the 8 payments as payments, moves the 2 conversions out of the purchases (reversibly), and closes the printed total as not a transaction', async () => {
        const fs = world(), out = await proveCardReviews({ db: fs.db, uid: 'u', limit: 10 });
        expect(out.why.totals).toMatchObject({ tried: 1, rung3: { witnessed: 2, probe: { words: 2, near: 0 } }, rung4: { tried: 1, unique: 1 }, filed: 8, moved: 2, notALine: 1, refused: 0 });
        const user = fs.data.get('users/u');
        expect(user.ccPayments.map(r => r.amount).sort((a, b) => a - b)).toEqual([100, 100, 1000, 5000, 13320, 25000, 50000, 50000, 150000, 175674.15]);
        expect(user.cconetime).toHaveLength(13);
        expect(user.cconetime.some(r => r.desc === 'Conv_Trxn_To_Inst')).toBe(false);
        expect(fs.data.get(`users/u/statementTrash/cconetime_${id(17)}`)).toMatchObject({ reason: 'statement-totals-payment' });
        expect(fs.data.get(`users/u/statementReview/${id(8)}`).dismissedBy).toBe('statement-totals-not-a-line');
        expect(JSON.stringify(out.why)).not.toMatch(/Conv_Trxn|Payment 004|175674|281200/);
    });
    it('changes nothing when the printed figures do not add up to the cent', async () => {
        const fs = world(); fs.data.get(sourcePath).proof = { ...proof, closing: 238745.05 };
        const out = await proveCardReviews({ db: fs.db, uid: 'u', limit: 10 });
        expect(out.why.totals).toMatchObject({ filed: 0 }); expect(out.why.totals.moved).toBeUndefined();
        expect(fs.data.get('users/u').ccPayments).toEqual([]);
        expect(fs.data.get('users/u').cconetime).toHaveLength(15);
    });
});

describe('the statement\'s own printed "Total Payment" guards the layout convention', () => {
    const base = ['Statement of Account', 'Credit Limit 350,000.00', '11/08/2026 11/08/2026 Annual Fee 4,000.00', '19/08/2026 19/08/2026 Payment 004 CR 150,000.00', '20/08/2026 19/08/2026 ELECTRONICS SHOP, COLOMBO 3 413,000.00'];
    const withTotals = (total) => [...base, `Total Payment: ${total}CR`, 'Total Transactions: 413,000.00'].join('\n');
    it('reads the two printed figures', () => {
        expect(P.parseStatement(withTotals('150,000.00')).printedFigures).toEqual({ payments: 150000, purchases: 413000 });
        expect(P.parseStatement(base.join('\n')).printedFigures).toEqual({ payments: null, purchases: null });
    });
    it('agrees when the payment lines read as credits add up to it, and then the purchases are filed by the layout as before', () => {
        const parsed = P.parseStatement(withTotals('150,000.00'));
        expect(printedPaymentsCheck(parsed)).toBe('agree');
        expect(proveDirections(parsed, { card: true }).byLayout).toBe(1);   // the fee is proven by its words
    });
    it('differs, and nothing is filed by the layout, when the payments read do not reach the printed figure (a marker the reader did not understand)', () => {
        const unreadable = withTotals('150,000.00').replace('Payment 004 CR 150,000.00', 'Payment 004 150,000.00');
        const parsed = P.parseStatement(unreadable);
        expect(printedPaymentsCheck(parsed)).toBe('differs');
        expect(proveDirections(parsed, { card: true }).byLayout).toBe(0);
        expect(readShape(parsed).printed).toBe('differs');
    });
    it('says nothing when the statement prints no such figure', () => {
        expect(printedPaymentsCheck(P.parseStatement(base.join('\n')))).toBe('none');
    });
});

describe('a reading that contradicts the printed Total Payment gets a second opinion, believed only if it agrees', () => {
    const text = ['HNB Credit Card Statement', 'Credit Limit 350,000.00', 'Statement Period 11 Aug 2026 / 30 Sep 2026', '11/08/2026 11/08/2026 Annual Fee 4,000.00', '19/08/2026 19/08/2026 Payment 004 150,000.00', '20/08/2026 19/08/2026 ELECTRONICS SHOP, COLOMBO 3 413,000.00', 'Total Payment: 150,000.00CR', 'Total Transactions: 413,000.00'].join('\n');
    const wanted = (parsed) => adaptiveWanted({ parsed, result: {}, claimed: {}, text, now: 1e12 });
    it('a reading that agrees with the printed figure is left alone', () => {
        const parsed = P.parseStatement(text.replace('Payment 004 150,000.00', 'Payment 004 CR 150,000.00'));
        expect(readingIsSuspect(parsed)).toBe(false);
        expect(wanted({ ...parsed, verdict: 'parsed', understood: true })).toBe(false);
    });
    it('a reading that contradicts it is suspect and is read again, even though the rules thought they understood it', () => {
        const parsed = { ...P.parseStatement(text), verdict: 'parsed', understood: true };
        expect(readingIsSuspect(parsed)).toBe(true);
        expect(wanted(parsed)).toBe(true);
    });
    it('the second opinion is accepted only when its own rows reach the printed Total Payment', () => {
        const first = P.parseStatement(text), good = { rows: [{ valid: true, direction: 'credit', amount: 150000, narration: 'Payment 004' }] }, bad = { rows: [{ valid: true, direction: 'debit', amount: 150000, narration: 'Payment 004' }] };
        expect(secondOpinionAgrees(first, good)).toBe(true);
        expect(secondOpinionAgrees(first, bad)).toBe(false);
        expect(secondOpinionAgrees(P.parseStatement(text.replace('Payment 004 150,000.00', 'Payment 004 CR 150,000.00')), bad)).toBe(true);   // the first reading was fine: nothing to compare
    });
});
