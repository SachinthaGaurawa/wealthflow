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
    it('says WHY a money-back line stays in names from a fixed list and yes/no flags, never in the line\'s own words or amounts', async () => {
        const db = world(['KEELLS SUPER COLOMBO', 'PAYMENT THANK YOU', 'ONLINE PAYMENT DIALOG'], { proof: { opening: 1000, closing: 900, credits: 203, debits: 50 } });      // 101.00 + 102.00 = the printed credits
        const out = await run(db);
        expect(out).toMatchObject({ proved: 1, left: 2, more: false });
        expect(out.why).toMatchObject({ moneyBack: 2, moneyWords: { payment: 2 }, printed: { opening: true, closing: true, credits: true, debits: true }, creditsFit: true });
        expect(JSON.stringify(out.why)).not.toMatch(/THANK|DIALOG|KEELLS|101|102/i);
    });
    it('names the other words the same way, and says when the printed totals are missing or do not add up', async () => {
        const db = world(['REFUND AMAZON', 'CASHBACK REWARD', 'SALARY FROM EMPLOYER'], { proof: { credits: 5 } });
        const out = await run(db);
        expect(out.why).toMatchObject({ moneyBack: 3, moneyWords: { refund: 1, cashback: 1, 'inbound-words': 1 }, printed: { opening: false, closing: false, credits: true, debits: false }, creditsFit: false });
        const none = await run(world(['REFUND AMAZON']));
        expect(none.why.printed).toEqual({ opening: false, closing: false, credits: false, debits: false });
        expect(none.why.creditsFit).toBeUndefined();
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
