import { describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { createHash } from 'node:crypto';
import { fallbackDecision, classifySlice, recoverConsensusFailures, deterministicDecision, runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { validateSettlementRow } from '../statement-ledger.mjs';

// (the narration here is a place name that shares a word with a savings target and says nothing about its type: a POS purchase or a charge is decided by the rules outright — statement_direction_test.js)
// The owner, with a screenshot of a 289-row NTB statement held at "POS Transaction - MIRIGAMA ... the independent AI review could not reach agreement — confirm it yourself",
// three times over: "I want bank statements, not transactions one by one". A savings target or loan named like the merchant made the rules doubt the row, the AI board was down, and
// the row was put to the owner. What the page prints — amount, date, whether it left the account — is not in doubt, and files the row by direction.

const row = (extra = {}) => ({ date: '2026-01-12', narration: 'MIRIGAMA STORES', description: 'MIRIGAMA STORES', amount: 1234.5, direction: 'debit', directionSource: 'column', needsReview: false, valid: true, ...extra });
const bank = { statementType: 'bank_account', card_last4: '', bank: 'NTB', targets: [{ id: 't1', name: 'Mirigama Plot' }] };
const card = { statementType: 'credit_card', card_last4: '3766570000000276', bank: 'NTB', targets: [{ id: 't1', name: 'Mirigama Plot' }] };
const down = async () => { throw new Error('ai-consensus-unavailable'); };

describe('a row whose direction the statement itself proves is placed by it', () => {
    it('debit: an expense on an account, a card purchase on a card; credit: income on an account, a card payment on a card — marked, so it can be found and changed', () => {
        expect(fallbackDecision(row(), bank)).toMatchObject({ module: 'expenses', category: 'Other', verified: true, autoDecided: 'rules-fallback' });
        expect(fallbackDecision(row(), card)).toMatchObject({ module: 'cconetime', category: 'Card Purchase', verified: true, autoDecided: 'rules-fallback' });
        expect(fallbackDecision(row({ direction: 'credit', narration: 'CEFT FROM SOMEONE' }), bank)).toMatchObject({ module: 'incomeRecv', verified: true, autoDecided: 'rules-fallback' });
        expect(fallbackDecision(row({ direction: 'credit' }), card)).toMatchObject({ module: 'ccPayments', category: 'Card Payment' });
    });
    it('every direction proof the ledger accepts counts; a direction that was ASSUMED, or a row the parser doubts, is still not placed', () => {
        for (const directionSource of ['balance', 'marker', 'column', 'sign']) expect(fallbackDecision(row({ directionSource }), bank)).not.toBeNull();
        expect(fallbackDecision(row({ directionSource: 'assumed' }), bank)).toBeNull();
        expect(fallbackDecision(row({ needsReview: true }), bank)).toBeNull();
        expect(fallbackDecision(row({ valid: false }), bank)).toBeNull();
        expect(fallbackDecision(row({ direction: '' }), bank)).toBeNull();
        expect(fallbackDecision(null, bank)).toBeNull();
    });
    it('what it decides is what the ledger accepts: a settlement of the row passes the same validation every other decision does', () => {
        for (const [ctx, r] of [[bank, row()], [card, row()], [bank, row({ direction: 'credit', narration: 'CEFT FROM SOMEONE' })], [card, row({ direction: 'credit' })]]) {
            expect(validateSettlementRow(r, fallbackDecision(r, ctx), { ...ctx, bank: 'NTB' }), JSON.stringify([ctx.statementType, r.direction])).toBeNull();
        }
    });
});

describe('the board is down and the rules doubt the row: it is filed, not asked about', () => {
    it('before: the rules alone leave it unverified (this is what put three rows in front of the owner); the slice now places it', async () => {
        expect(deterministicDecision(row(), bank)).toMatchObject({ verified: false, reason: 'ai-consensus-unavailable' });
        const out = await classifySlice([row(), row({ direction: 'credit', narration: 'CEFT FROM SOMEONE' })], bank, { board: down });
        expect(out[0]).toMatchObject({ module: 'expenses', category: 'Other', verified: true, autoDecided: 'rules-fallback' });
        expect(out[1]).toMatchObject({ verified: true });
    });
    it('the same when the board answers and cannot agree with itself (a review verdict, a rejected proposal)', async () => {
        const unsure = vi.fn().mockResolvedValueOnce({ unanimous: true, trustworthy: true, expected: ['a', 'b', 'c', 'd', 'e'], fields: { decisions: [{ index: 0, module: 'review', category: 'Needs Review', allocationId: '' }] } }).mockResolvedValueOnce({ unanimous: true, trustworthy: true, expected: ['a', 'b', 'c', 'd', 'e'], fields: { approved: true } });
        const out = await classifySlice([row()], bank, { board: unsure });
        expect(out[0]).toMatchObject({ module: 'expenses', verified: true, autoDecided: 'rules-fallback' });
    });
    it('a row whose direction was assumed is the one thing still put to the owner', async () => {
        const out = await classifySlice([row({ needsReview: true })], bank, { board: down });
        expect(out[0]).toMatchObject({ verified: false, reason: 'ai-consensus-unavailable' });
    });
    it('the AI still REFINES: when the board agrees on a category, that is what is filed, not the fallback', async () => {
        const good = vi.fn().mockResolvedValueOnce({ unanimous: true, trustworthy: true, expected: ['a', 'b', 'c', 'd', 'e'], fields: { decisions: [{ index: 0, module: 'expenses', category: 'Shopping', allocationId: '' }] } }).mockResolvedValueOnce({ unanimous: true, trustworthy: true, expected: ['a', 'b', 'c', 'd', 'e'], fields: { approved: true } });
        const out = await classifySlice([row()], bank, { board: good });
        expect(out[0]).toMatchObject({ module: 'expenses', category: 'Shopping', verified: true });
        expect(out[0].autoDecided).toBeUndefined();
    });
});

describe('the three rows already waiting for the owner are settled the same way', () => {
    const sourcePath = 'wf-mail/owner_example_com/items/ntb1';
    const world = (reviewRow) => {
        const id = createHash('sha256').update(sourcePath + ':3').digest('hex');
        const fs = createFirestore({
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {}, targets: [], loans: [] },
            [sourcePath]: { uid: 'u', bank: 'NTB', statementType: 'bank_account', last4: '', status: 'needs_review', hasReview: true, cursor: 289, totalRows: 289 },
            [`users/u/statementReview/${id}`]: { uid: 'u', sourcePath, index: 3, status: 'pending', reason: 'ai-consensus-unavailable', row: reviewRow, bank: 'NTB' },
            [`users/u/statementLedger/${id}`]: { uid: 'u', sourcePath, index: 3, status: 'review' },
        });
        return { ...fs, id };
    };
    it('recoverConsensusFailures files a "POS Transaction" row by its direction and closes the review', async () => {
        const w = world(row());
        const out = await recoverConsensusFailures({ db: w.db, uid: 'u' });
        expect(out.recovered).toBe(1);
        expect(w.data.get('users/u').expenses).toHaveLength(1);
        expect(w.data.get('users/u').expenses[0]).toMatchObject({ amount: 1234.5, autoDecided: 'rules' });     // the review's own context names no savings target, so the rules settle it
        expect(w.data.get(`users/u/statementReview/${w.id}`).status).not.toBe('pending');
    });
    it('a row whose direction was assumed stays for the owner', async () => {
        const w = world(row({ directionSource: 'assumed', needsReview: true }));
        expect((await recoverConsensusFailures({ db: w.db, uid: 'u' })).recovered).toBe(0);
        expect(w.data.get(`users/u/statementReview/${w.id}`).status).toBe('pending');
    });
});

describe('and they are settled while a long statement is still being worked', () => {
    it('a run that processed a slice also settles the rows waiting for the owner (it used to wait for a run with nothing to do — which a long statement never leaves)', async () => {
        const owner = { uid: 'u', email: 'owner@example.com' }, mail = 'wf-mail/owner_example_com', other = `${mail}/items/ntb1`, work = `${mail}/items/item0`;
        const id = createHash('sha256').update(other + ':3').digest('hex');
        const html = '<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 30/09/2026 Payment Due Date: 20/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>01/09/2026</td><td>KEELLS STORE 1</td><td>100.00 DR</td></tr></table></body></html>';
        const fs = createFirestore({
            [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@bank.example', kind: 'address', status: 'approved' }] },
            'wf-statement-vault/u': { uid: 'u' },
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
            [work]: { uid: 'u', bank: 'AMEX', filename: 'statement.html', from: 'statements@bank.example', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
            [other]: { uid: 'u', bank: 'NTB', statementType: 'bank_account', status: 'needs_review', hasReview: true, cursor: 289, totalRows: 289 },
            [`users/u/statementReview/${id}`]: { uid: 'u', sourcePath: other, index: 3, status: 'pending', reason: 'ai-consensus-unavailable', row: row(), bank: 'NTB' },
            [`users/u/statementLedger/${id}`]: { uid: 'u', sourcePath: other, index: 3, status: 'review' },
        });
        const f = async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });
        const loadAttachment = vi.fn(async () => ({ bytes: Buffer.from(html), filename: 'statement.html', contentSha256: 'x' }));
        const out = await runStatementSync({ action: 'drain', db: fs.db, owner, env: {}, f, intake: async () => ({ body: { ok: true } }), read: readStatement, open: async () => [{ password: 'x', bank: 'AMEX' }], board: down, extract: async () => { throw new Error('ai-extractor-unavailable'); }, loadAttachment, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(out.attempted).toBe(1);
        expect(fs.data.get(`users/u/statementReview/${id}`).status).not.toBe('pending');
        expect(fs.data.get('users/u').expenses.some(e => e.amount === 1234.5)).toBe(true);
    });
});

describe('a second copy of a statement does not put its rows to the owner one by one', () => {
    const mail = 'wf-mail/owner_example_com', copy = `${mail}/items/copy`, first = `${mail}/items/first`;
    const idOf = (n) => createHash('sha256').update(`${copy}:review:${n}`).digest('hex');
    const record = (extra) => ({ id: 'r' + Math.random(), date: '2026-01-12', amount: 1234.5, desc: 'MIRIGAMA STORES', bank: 'NTB', direction: 'debit', statementKey: first, statementRow: 1, source: 'statement', ...extra });
    const review = (n, extra = {}) => [`users/u/statementReview/${idOf(n)}`, { uid: 'u', sourcePath: copy, index: n, status: 'pending', reason: 'ambiguous-cross-source-match', bank: 'NTB', last4: '', row: row({ index: n, ...extra }) }];
    const world = (reviews, records) => createFirestore({
        'users/u': { expenses: records, incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
        [copy]: { uid: 'u', bank: 'NTB', status: 'needs_review', hasReview: true, cursor: 5, totalRows: 5 },
        ...Object.fromEntries(reviews),
        ...Object.fromEntries(reviews.map(([path]) => [path.replace('statementReview', 'statementLedger'), { uid: 'u', sourcePath: copy, status: 'review' }])),
    });
    it('each row the books already hold from another statement is closed as a duplicate; a row they do not account for, or an identical row beyond the entries that explain it, stays', async () => {
        const w = world([review(0), review(1), review(2, { amount: 99.5 }), review(3, { narration: 'SOMETHING ELSE', description: 'SOMETHING ELSE' })], [record(), record({ amount: 99.5 })]);
        const lines = [];
        const { recoverDuplicateRows } = await import('../statement-sync.js');
        const out = await recoverDuplicateRows({ db: w.db, uid: 'u', log: l => lines.push(l) });
        const status = n => w.data.get(`users/u/statementReview/${idOf(n)}`).status;
        expect([status(0), status(1)].sort()).toEqual(['dismissed', 'pending']);      // two identical rows, one entry: only one is explained
        expect([status(2), status(3)]).toEqual(['dismissed', 'pending']);
        expect(out.closed).toBe(2);
        expect(w.data.get('users/u').expenses).toHaveLength(2);                 // nothing was filed, nothing removed
        expect(JSON.parse(lines[0])).toMatchObject({ evt: 'statement-duplicates-closed', closed: 2, kept: 2, waiting: 4 });
    });
    it('a row whose only match is in its OWN statement is not a duplicate of another copy', async () => {
        const w = world([review(0)], [record({ statementKey: copy, statementRow: 0 })]);
        const { recoverDuplicateRows } = await import('../statement-sync.js');
        expect((await recoverDuplicateRows({ db: w.db, uid: 'u' })).closed).toBe(0);
    });
    it('nothing waiting, nothing said', async () => {
        const w = world([], []);
        const lines = [];
        const { recoverDuplicateRows } = await import('../statement-sync.js');
        expect(await recoverDuplicateRows({ db: w.db, uid: 'u', log: l => lines.push(l) })).toEqual({ closed: 0, more: false });
        expect(lines).toEqual([]);
    });
});
