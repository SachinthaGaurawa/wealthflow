import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { semanticDirection, genericBankLine, proveDirections } from '../statement-direction.mjs';
import { deterministicDecision, fallbackDecision, recoverConsensusFailures, runStatementSync } from '../statement-sync.js';
import { validateSettlementRow, settleStatement, PROVEN_DIRECTION } from '../statement-ledger.mjs';

// The owner, with a screenshot of "CEFT Charges Mirigama, 25.00, money out — the independent AI review could not reach agreement": "can the system AI not decide which tab and which
// category this goes to?" A bank charge shared one word with a loan called "Mirigama …", was routed to it, nothing verifiable followed, six AI models could not all agree on a batch of ten,
// and the owner was asked. Now the rules know a charge is spending, and the page's own arithmetic or the row's words prove the direction a parser could only assume.

afterEach(() => vi.restoreAllMocks());
const row = (extra = {}) => ({ date: '2026-05-26', narration: 'CEFT Charges Mirigama', description: 'CEFT Charges Mirigama', amount: 25, direction: 'debit', directionSource: 'column', needsReview: false, valid: true, ...extra });
const assumed = (extra = {}) => row({ directionSource: 'assumed', needsReview: true, ...extra });

describe('what a row\'s words say about its direction', () => {
    it.each([
        ['CEFT Charges Mirigama', 'debit'], ['POS Transaction - MIRIGAMA', 'debit'], ['ATM WITHDRAWAL 0001', 'debit'], ['Stamp Duty', 'debit'], ['SMS ALERT CHARGES', 'debit'],
        ['SALARY JULY', 'credit'], ['Interest Credited', 'credit'], ['FEE REVERSAL', 'credit'], ['POS REFUND KEELLS', 'credit'], ['CEFT CHARGEBACK', 'credit'],
        ['John Silva', ''], ['SALARY CHARGES', ''],
    ])('%s is %s', (narration, expected) => expect(semanticDirection({ narration })).toBe(expected));
    it('a bank\'s own line type is never an instalment or a deposit to a goal, whatever place it names', () => {
        expect(genericBankLine({ narration: 'CEFT Charges Mirigama' })).toBe(true);
        expect(genericBankLine({ narration: 'POS Transaction - MIRIGAMA' })).toBe(true);
        expect(genericBankLine({ narration: 'LOAN INSTALMENT MIRIGAMA LAND LOAN fee' })).toBe(false);
        expect(genericBankLine({ narration: 'POS REFUND' })).toBe(false);
        expect(genericBankLine({ narration: 'Mirigama Plot' })).toBe(false);
    });
});

describe('the rules decide a charge, a POS purchase or an ATM withdrawal without asking anyone', () => {
    const ctx = { statementType: 'bank_account', bank: 'NTB', targets: [{ id: 't', name: 'Mirigama Plot' }], loans: [{ id: 'l', name: 'Mirigama Land Loan' }] };
    it('"CEFT Charges Mirigama" beside a goal and a loan called Mirigama is a Bank Charges expense, decided by the rules (it used to be unverified, and went to the AI board)', () => {
        expect(deterministicDecision(row(), ctx)).toMatchObject({ module: 'expenses', category: 'Bank Charges', verified: true, deterministic: true });
        expect(deterministicDecision(row({ narration: 'POS Transaction - MIRIGAMA', description: 'POS Transaction - MIRIGAMA' }), ctx)).toMatchObject({ module: 'expenses', verified: true });
    });
    it('a real instalment to that loan is still not decided by words alone', () => {
        expect(deterministicDecision(row({ narration: 'LOAN INSTALMENT MIRIGAMA LAND LOAN', description: 'LOAN INSTALMENT MIRIGAMA LAND LOAN' }), ctx).verified).toBe(false);
    });
});

describe('a direction the parser only assumed', () => {
    it('is proven by the row\'s words when they agree with it, never turned round by them, and left alone when the words say nothing', () => {
        expect(fallbackDecision(assumed(), { statementType: 'bank_account' })).toMatchObject({ module: 'expenses', category: 'Bank Charges', verified: true, autoDecided: 'rules-words' });
        expect(fallbackDecision(assumed({ direction: 'credit' }), { statementType: 'bank_account' })).toBeNull();                       // a charge read as a credit: the words disagree
        expect(fallbackDecision(assumed({ narration: 'John Silva', description: 'John Silva' }), { statementType: 'bank_account' })).toBeNull();
        expect(fallbackDecision(assumed({ narration: 'SALARY JULY', description: 'SALARY JULY', direction: 'credit' }), { statementType: 'bank_account' })).toMatchObject({ module: 'incomeRecv', category: 'Salary' });
        expect(fallbackDecision(assumed({ valid: false }), {})).toBeNull();
    });
    it('a card statement\'s fee is a Card Fee and its purchase a Card Purchase', () => {
        const card = { statementType: 'credit_card', card_last4: '3766570000000276' };
        expect(fallbackDecision(assumed({ narration: 'ANNUAL FEE', description: 'ANNUAL FEE' }), card)).toMatchObject({ module: 'cconetime', category: 'Card Fee' });
        expect(fallbackDecision(assumed({ narration: 'POS Transaction - KEELLS', description: 'POS Transaction - KEELLS' }), card)).toMatchObject({ module: 'cconetime', category: 'Card Purchase' });
    });
    it('the ledger accepts the two new proofs', () => {
        expect(PROVEN_DIRECTION).toEqual(expect.arrayContaining(['statement', 'words']));
        const decision = { module: 'expenses', category: 'Bank Charges', verified: true };
        expect(validateSettlementRow(row({ directionSource: 'words' }), decision, { statementType: 'bank_account' })).toBeNull();
        expect(validateSettlementRow(row({ directionSource: 'statement' }), decision, { statementType: 'bank_account' })).toBeNull();
        expect(validateSettlementRow(assumed(), decision, { statementType: 'bank_account' })).toBe('unproven-direction');
    });
});

describe('proveDirections: the statement as a whole, then the words', () => {
    const rec = (extra = {}) => ({ ok: true, opening: 1000, closing: 700, ...extra });
    it('when the printed balances are reached to the cent, every unmarked row is proven by the statement', () => {
        const out = proveDirections({ rows: [assumed({ narration: 'John Silva', amount: 90 }), assumed({ narration: 'Shop', amount: 10 })], reconciliation: rec() });
        expect(out).toMatchObject({ byStatement: 2, byWords: 0 });
        expect(out.rows.every(r => r.directionSource === 'statement' && r.needsReview === false)).toBe(true);
    });
    it('without that proof only the rows whose words agree are proven; the original rows are not touched', () => {
        const input = { rows: [assumed(), assumed({ narration: 'John Silva' })], reconciliation: rec({ ok: null, opening: null, closing: null }) };
        const out = proveDirections(input);
        expect(out).toMatchObject({ byStatement: 0, byWords: 1 });
        expect(out.rows.map(r => r.directionSource)).toEqual(['words', 'assumed']);
        expect(input.rows[0].directionSource).toBe('assumed');
    });
    it('a flagged debit and a flagged credit of the same amount could cancel each other, so the statement does not vouch for them (their words may)', () => {
        const out = proveDirections({ rows: [assumed({ narration: 'John Silva', amount: 40 }), assumed({ narration: 'Mary', amount: 40, direction: 'credit', directionSource: 'keyword' }), assumed({ narration: 'Shop', amount: 5 })], reconciliation: rec() });
        expect(out.rows.map(r => r.directionSource)).toEqual(['assumed', 'keyword', 'statement']);
    });
    it('a balance that does not add up, a row the page marked, or a parser that doubts the row\'s amount are never rescued', () => {
        expect(proveDirections({ rows: [assumed({ narration: 'Shop' })], reconciliation: rec({ ok: false }) }).byStatement).toBe(0);
        expect(proveDirections({ rows: [row()], reconciliation: rec() }).rows[0].directionSource).toBe('column');
        expect(proveDirections({ rows: [assumed({ narration: 'Shop', valid: false })], reconciliation: rec() }).byStatement).toBe(0);
        expect(proveDirections({ rows: [assumed({ narration: 'Shop', directionSource: 'balance-mismatch' })], reconciliation: rec() }).byStatement).toBe(0);
    });
});

describe('the rows already waiting are settled the same way', () => {
    const sourcePath = 'wf-mail/owner_example_com/items/ntb1';
    const world = (reviewRow, reason) => {
        const id = createHash('sha256').update(sourcePath + ':3').digest('hex');
        const fs = createFirestore({
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {}, targets: [], loans: [] },
            [sourcePath]: { uid: 'u', bank: 'NTB', statementType: 'bank_account', last4: '', status: 'needs_review', hasReview: true, cursor: 289, totalRows: 289 },
            [`users/u/statementReview/${id}`]: { uid: 'u', sourcePath, index: 3, status: 'pending', reason, row: reviewRow, bank: 'NTB' },
            [`users/u/statementLedger/${id}`]: { uid: 'u', sourcePath, index: 3, status: 'review' },
        });
        return { ...fs, id };
    };
    it('a review "check it, whether it was money in or out" is settled by the words of its row; one whose words say nothing stays for the owner', async () => {
        const w = world(assumed(), 'unproven-direction');
        expect((await recoverConsensusFailures({ db: w.db, uid: 'u' })).recovered).toBe(1);
        expect(w.data.get('users/u').expenses).toHaveLength(1);
        expect(w.data.get('users/u').expenses[0]).toMatchObject({ amount: 25, cat: 'Bank Charges' });
        expect(w.data.get(`users/u/statementReview/${w.id}`).status).not.toBe('pending');
        const quiet = world(assumed({ narration: 'John Silva', description: 'John Silva' }), 'unproven-direction');
        expect((await recoverConsensusFailures({ db: quiet.db, uid: 'u' })).recovered).toBe(0);
        expect(quiet.data.get(`users/u/statementReview/${quiet.id}`).status).toBe('pending');
    });
});

describe('a statement whose rows the page left unmarked is filed whole, without one question', () => {
    const owner = { uid: 'u', email: 'owner@example.com' }, mail = 'wf-mail/owner_example_com', itemPath = `${mail}/items/item0`;
    const rows = [
        assumed({ date: '2026-05-26', narration: 'CEFT Charges Mirigama', amount: 25 }),
        assumed({ date: '2026-05-27', narration: 'POS Transaction - MIRIGAMA', amount: 1234.5 }),
        assumed({ date: '2026-05-28', narration: 'KEELLS SUPER MIRIGAMA', amount: 410.25 }),
    ];
    const world = (reconciliation) => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'estatement@info.nationstrust.com', kind: 'address', status: 'approved', name: 'NTB', domain: 'info.nationstrust.com' }], lastSettleMs: Date.now() },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {}, loans: [{ id: 'l1', name: 'Mirigama Land Loan' }] },
        [itemPath]: { uid: 'u', bank: 'NTB', filename: 'e-statementPDF.pdf', from: 'estatement@info.nationstrust.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
    });
    const run = (w, reconciliation) => runStatementSync({ action: 'drain', db: w.db, owner, env: {}, intake: async () => ({ body: { ok: true } }), open: async () => [], maxSteps: 1, budgetMs: 40000, settle: settleStatement,
        f: async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) }),
        board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); },
        loadAttachment: async () => ({ bytes: Buffer.from('%PDF-1.4 statement'), filename: 'e-statementPDF.pdf', contentSha256: 'x' }),
        read: async () => ({ text: 'NATIONS TRUST BANK\nAccount Statement\nOpening Balance 10,000.00\nClosing Balance 8,330.25\n26/05/2026 CEFT Charges Mirigama 25.00\n27/05/2026 POS Transaction - MIRIGAMA 1,234.50\n28/05/2026 KEELLS SUPER MIRIGAMA 410.25',
            parsed: { verdict: 'parsed', understood: true, rows, reconciliation, layout: { statementType: 'bank_account', accountLast4: '' } } }) });
    it('opening and closing balances that add up prove all three rows: all are filed (the charge as Bank Charges), nothing is put to the owner', async () => {
        const w = world();
        const out = await run(w, { ok: true, opening: 10000, closing: 8330.25, credits: 0, debits: 1669.75 });
        expect(out.status).toBe('filed');
        expect(w.data.get(itemPath)).toMatchObject({ status: 'filed', filed: true });
        expect(w.data.get('users/u').expenses).toHaveLength(3);
        expect(w.data.get('users/u').expenses.find(e => e.amount === 25)).toMatchObject({ cat: 'Bank Charges', directionProof: 'statement' });
        expect([...w.data.keys()].filter(key => key.includes('/statementReview/'))).toEqual([]);
    });
    it('with no balances to prove it, the charge and the POS purchase are proven by their words and filed; the row that says nothing is the one that waits', async () => {
        const w = world();
        await run(w, { ok: null, opening: null, closing: null });
        expect(w.data.get('users/u').expenses.map(e => e.amount).sort((a, b) => a - b)).toEqual([25, 1234.5]);
        const reviews = [...w.data.entries()].filter(([key]) => key.includes('/statementReview/')).map(([, value]) => value);
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toMatchObject({ reason: 'unproven-direction', index: 2 });
    });
});
