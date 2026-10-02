import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { buildHistory } from '../statement-history.mjs';
import { classifySlice, deterministicDecision, merchantNameFor, recoverConsensusFailures } from '../statement-sync.js';

// "Can the system AI not decide?" — it can, from what the owner has already decided: a merchant the books hold repeatedly under ONE category IS that category, and costs no question and
// no board of models that must all agree. It only ever replaces the rules' "Other".

afterEach(() => vi.restoreAllMocks());
const exp = (desc, cat) => ({ desc, cat, amount: 100, date: '2026-05-01' });
const inc = (name, type) => ({ name, type, amount: 100, date: '2026-05-01' });
const user = (expenses = [], incomeRecv = []) => ({ expenses, incomeRecv });
const row = (narration, extra = {}) => ({ date: '2026-08-04', narration, description: narration, amount: 1500, direction: 'debit', directionSource: 'column', needsReview: false, valid: true, ...extra });
const bank = { statementType: 'bank_account', bank: 'NTB' };
const withHistory = (u, ctx = bank) => { const c = { ...ctx }; Object.defineProperty(c, 'history', { value: buildHistory(u, merchantNameFor), enumerable: false }); return c; };

describe('the memory of what the owner decided', () => {
    it('answers only when sure: two filings or more, one category for four in five of them', () => {
        const h = buildHistory(user([exp('POS Transaction ZORBA TRADERS NUGEGODA', 'Shopping'), exp('ZORBA TRADERS NUGEGODA', 'Shopping'), exp('ZORBA TRADERS NUGEGODA', 'Shopping'), exp('ZORBA TRADERS NUGEGODA', 'Shopping'), exp('ZORBA TRADERS NUGEGODA', 'Dining'),
            exp('LONE MERCHANT', 'Health'), exp('SPLIT SHOP', 'Dining'), exp('SPLIT SHOP', 'Shopping')]), merchantNameFor);
        expect(h.expense({ narration: 'ZORBA TRADERS NUGEGODA' })).toMatchObject({ category: 'Shopping', count: 4, of: 5 });
        expect(h.expense({ narration: 'LONE MERCHANT' })).toBeNull();                 // once is not a habit
        expect(h.expense({ narration: 'SPLIT SHOP' })).toBeNull();                    // two minds
        expect(h.hint({ narration: 'LONE MERCHANT' })).toMatchObject({ category: 'Health' });        // …but it is still evidence for the AI
    });
    it('never learns "Other", "Needs Review", a transfer or a short name; income is kept apart from spending', () => {
        const h = buildHistory(user([exp('MYSTERY SHOP', 'Other'), exp('MYSTERY SHOP', 'Other'), exp('AB', 'Dining'), exp('AB', 'Dining')], [inc('ACME PAYROLL LK', 'Salary'), inc('ACME PAYROLL LK', 'Salary')]), merchantNameFor);
        expect(h.expense({ narration: 'MYSTERY SHOP' })).toBeNull();
        expect(h.expense({ narration: 'AB' })).toBeNull();
        expect(h.income({ narration: 'ACME PAYROLL LK' })).toMatchObject({ category: 'Salary' });
        expect(h.expense({ narration: 'ACME PAYROLL LK' })).toBeNull();
    });
    it('copes with nothing at all', () => {
        expect(buildHistory({}, merchantNameFor).size).toBe(0);
        expect(buildHistory(null, merchantNameFor).expense({ narration: 'X' })).toBeNull();
    });
});

describe('the rules use it, and only to replace "Other"', () => {
    const u = user([exp('ZORBA TRADERS NUGEGODA', 'Shopping'), exp('ZORBA TRADERS NUGEGODA', 'Shopping')]);
    it('an unknown merchant the owner has filed twice goes where the owner put it, marked so it can be found', () => {
        expect(deterministicDecision(row('POS Transaction ZORBA TRADERS NUGEGODA'), withHistory(u))).toMatchObject({ module: 'expenses', category: 'Shopping', verified: true, deterministic: true, autoDecided: 'history' });
        expect(deterministicDecision(row('POS Transaction NEW PLACE KANDY'), withHistory(u))).toMatchObject({ module: 'expenses', category: 'Other' });
    });
    it('a category the rules already named is not overridden', () => {
        const wrong = user([exp('KEELLS SUPER', 'Health'), exp('KEELLS SUPER', 'Health')]);
        expect(deterministicDecision(row('KEELLS SUPER MIRIGAMA'), withHistory(wrong))).toMatchObject({ category: 'Groceries' });
    });
    it('a card row is not placed by it (a card purchase has no merchant category)', () => {
        expect(deterministicDecision(row('POS Transaction ZORBA TRADERS NUGEGODA'), withHistory(u, { statementType: 'credit_card', card_last4: '3766570000000276' }))).toMatchObject({ module: 'cconetime' });
    });
    it('the board is not asked about a row the owner\'s history settles, and is told what the owner used for one it IS asked about', async () => {
        const board = vi.fn().mockRejectedValue(new Error('ai-consensus-unavailable'));
        const ctx = withHistory(user([exp('ZORBA TRADERS NUGEGODA', 'Shopping'), exp('ZORBA TRADERS NUGEGODA', 'Shopping'), exp('QUIET CORNER STORES', 'Health')]));
        const out = await classifySlice([row('POS Transaction ZORBA TRADERS NUGEGODA')], ctx, { board });
        expect(out[0]).toMatchObject({ category: 'Shopping', autoDecided: 'history' });
        expect(board).not.toHaveBeenCalled();
        await classifySlice([row('POS Transaction QUIET CORNER STORES')], ctx, { board });
        expect(board).toHaveBeenCalledTimes(1);
        expect(board.mock.calls[0][0]).toContain('"categoryUsedBefore":"Health"');
    });
    it('what it knows is never serialised into the prompt\'s context', () => {
        expect(JSON.stringify(withHistory(user([exp('ZORBA TRADERS NUGEGODA', 'Shopping'), exp('ZORBA TRADERS NUGEGODA', 'Shopping')])))).not.toContain('ZORBA');
    });
});

describe('the rows already waiting are settled by it too', () => {
    it('a review the AI could not agree on, for a merchant the owner has filed twice, is filed where the owner put it', async () => {
        const sourcePath = 'wf-mail/owner_example_com/items/ntb1', id = createHash('sha256').update(sourcePath + ':3').digest('hex');
        const fs = createFirestore({
            'users/u': { expenses: [exp('ZORBA TRADERS NUGEGODA', 'Shopping'), exp('ZORBA TRADERS NUGEGODA', 'Shopping')], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
            [sourcePath]: { uid: 'u', bank: 'NTB', statementType: 'bank_account', last4: '', status: 'needs_review', hasReview: true, cursor: 289, totalRows: 289 },
            [`users/u/statementReview/${id}`]: { uid: 'u', sourcePath, index: 3, status: 'pending', reason: 'ai-consensus-unavailable', row: row('POS Transaction ZORBA TRADERS NUGEGODA'), bank: 'NTB' },
            [`users/u/statementLedger/${id}`]: { uid: 'u', sourcePath, index: 3, status: 'review' },
        });
        expect((await recoverConsensusFailures({ db: fs.db, uid: 'u' })).recovered).toBe(1);
        expect(fs.data.get('users/u').expenses.find(e => e.amount === 1500)).toMatchObject({ cat: 'Shopping', autoDecided: 'history', notes: expect.stringContaining('used for this merchant before') });
    });
});
