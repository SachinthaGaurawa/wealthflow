import { describe, it, expect } from 'vitest';
import { amountCents, sourceOccurrenceId, validateSettlementRow, settleStatement, resolveReview } from '../statement-ledger.mjs';

const row = { date: '2026-09-10', amount: 42.10, description: 'Merchant', direction: 'debit', directionSource: 'column', needsReview: false };
const decision = { module: 'expenses', category: 'Food', verified: true };
function fakeDb(initial = {}) {
    const docs = new Map(Object.entries(initial));
    const collection = path => ({ doc: id => ref(path + '/' + id), where: (field, op, value) => ({ query: true, path, field, value }) });
    const ref = path => ({ path, id: path.split('/').at(-1), collection: name => collection(path + '/' + name) });
    return {
        docs, collection, doc: ref,
        async runTransaction(fn) {
            const pending = []; let writing = false;
            const result = await fn({
                async get(r) { if (writing) throw new Error('read-after-write'); if (r.query) return { docs: [...docs.entries()].filter(([path, data]) => path.startsWith(r.path + '/') && data[r.field] === r.value).map(([path, data]) => ({ id: path.split('/').at(-1), data: () => structuredClone(data) })) }; return { exists: docs.has(r.path), data: () => structuredClone(docs.get(r.path)) }; },
                set(r, value, opts) { writing = true; pending.push([r.path, structuredClone(value), opts]); }
            });
            for (const [path, value, opts] of pending) docs.set(path, opts?.merge ? { ...docs.get(path), ...value } : value);
            return result;
        }
    };
}
function fixture(user = {}) {
    const db = fakeDb({ 'users/u': user, 'sources/s': { uid: 'u', cursor: 0, leaseToken: 'token', leaseUntil: 2000, encrypted: 'preserved' } });
    return { db, uid: 'u', sourceRef: db.collection('sources').doc('s'), leaseToken: 'token', now: 1000, rows: [row], decisions: [decision], cursor: 0, totalRows: 1, bank: 'Bank', last4: '1234' };
}

describe('statement ledger', () => {
    it('skips a line that moves no money instead of asking the owner about it', async () => {
        const f = fixture();
        const zero = { ...row, amount: 0, description: 'WTax.Pd' };
        const out = await settleStatement({ ...f, rows: [row, zero], decisions: [decision, decision], totalRows: 2 });
        expect(out).toMatchObject({ filed: 1, skipped: 1, review: 0, status: 'filed' });
        expect(f.db.docs.get('users/u').expenses).toHaveLength(1);
        const skipped = [...f.db.docs.entries()].filter(([path]) => path.includes('/statementLedger/')).map(([, data]) => data).find(data => data.status === 'skipped');
        expect(skipped).toMatchObject({ reason: 'zero-amount', index: 1 });
        expect([...f.db.docs.keys()].some(path => path.includes('/statementReview/'))).toBe(false);
    });
    it('still queries a misread amount — only a clean zero is a line with no money', async () => {
        for (const amount of [NaN, -5, '0.00', undefined, null]) {
            const f = fixture();
            const out = await settleStatement({ ...f, rows: [{ ...row, amount }], decisions: [decision], totalRows: 1 });
            expect(out, String(amount)).toMatchObject({ skipped: 0, review: 1 });
        }
    });
    it('rejects rounded, invalid or unsafe monetary values', () => {
        expect(amountCents(42.10)).toBe(4210);
        for (const amount of [NaN, Infinity, -1, 0, 1.001, '1', Number.MAX_SAFE_INTEGER]) expect(amountCents(amount)).toBe(null);
    });
    it('retains distinct repeated purchase occurrence identities', () => {
        expect(sourceOccurrenceId('s', 1)).not.toBe(sourceOccurrenceId('s', 2));
    });
    it('rejects unverified board, inferred direction and impossible dates', () => {
        expect(validateSettlementRow(row, decision)).toBe(null);
        expect(validateSettlementRow({ ...row, date: '2026-02-30' }, decision)).toBe('invalid-transaction');
        expect(validateSettlementRow({ ...row, directionSource: 'assumed' }, decision)).toBe('unproven-direction');
        expect(validateSettlementRow(row, { ...decision, verified: false })).toBe('unanimous-decision-required');
        expect(validateSettlementRow({ ...row, direction: 'credit' }, decision)).toBe('expense-direction-conflict');
    });
    it('enforces the debit-credit and transfer routing matrix after every AI decision', () => {
        const credit = { ...row, direction: 'credit' };
        expect(validateSettlementRow(credit, { module: 'incomeRecv', category: 'Salary', verified: true })).toBe(null);
        expect(validateSettlementRow(credit, decision)).toBe('expense-direction-conflict');
        expect(validateSettlementRow(row, { module: 'incomeRecv', category: 'Salary', verified: true })).toBe('income-direction-conflict');
        const transfer = { ...credit, description: 'TRANSFER CREDIT-MOBILEBANKING' };
        // money received from someone else is income like any other row; only the owner's own money moving between their own accounts is left out (decided before this, by statement-transfers)
        expect(validateSettlementRow(transfer, { module: 'incomeRecv', category: 'Other', verified: true })).toBe(null);
        expect(validateSettlementRow({ ...transfer, direction: 'debit' }, { module: 'incomeRecv', category: 'Other', verified: true })).toBe('income-direction-conflict');
        expect(validateSettlementRow(transfer, { module: 'skip', category: 'Transfer', verified: true })).toBe(null);
        expect(validateSettlementRow(row, { module: 'skip', category: 'Transfer', verified: true })).toBe('skip-requires-transfer-evidence');
    });
    it('files a card charge the classifier proved via the owner registry even when the parser never read statementType', () => {
        // This is the exact live bug: deterministicDecision()/the AI board already
        // fall back to Settings -> Manage cards & accounts (by last-4 + bank) when
        // the statement's own layout does not declare a type, but this final gate
        // used to re-derive "is this a card?" from statementType alone and silently
        // disagreed, quarantining an already-correctly-classified row to review.
        const cardRow = { ...row, direction: 'debit' };
        const ctx = { statementType: '', card_last4: '9911', bank: 'DFCC', cardRegistry: { '9911': { type: 'credit_card', bank: 'DFCC' } } };
        expect(validateSettlementRow(cardRow, { module: 'cconetime', category: 'Shopping', verified: true }, ctx)).toBe(null);
    });
    it('only allows proven card debits into card tabs, including installments', () => {
        const ctx = { statementType: 'credit_card' };
        expect(validateSettlementRow(row, { module: 'ccinstall', category: 'Installment', verified: true }, ctx)).toBe(null);
        expect(validateSettlementRow(row, { module: 'expenses', category: 'Food', verified: true }, ctx)).toBe('credit-card-route-conflict');
        expect(validateSettlementRow(row, { module: 'subscriptions', category: 'Streaming', verified: true }, ctx)).toBe('credit-card-route-conflict');
    });
    it('still refuses a card charge with no statement or registry proof of a credit-card account', () => {
        const cardRow = { ...row, direction: 'debit' };
        expect(validateSettlementRow(cardRow, { module: 'cconetime', category: 'Shopping', verified: true }, {})).toBe('card-charge-context-required');
        // Registry match exists but says bank account, not credit card.
        const ctx = { card_last4: '9911', bank: 'DFCC', cardRegistry: { '9911': { type: 'bank_account', bank: 'DFCC' } } };
        expect(validateSettlementRow(cardRow, { module: 'cconetime', category: 'Shopping', verified: true }, ctx)).toBe('card-charge-context-required');
        // Registry match exists for the last four digits but at a different bank.
        const collision = { card_last4: '9911', bank: 'Sampath', cardRegistry: { '9911': { type: 'credit_card', bank: 'DFCC' } } };
        expect(validateSettlementRow(cardRow, { module: 'cconetime', category: 'Shopping', verified: true }, collision)).toBe('card-charge-context-required');
    });
    it('recognizes a registry-matched credit-card payment the same way', () => {
        const credit = { ...row, direction: 'credit' };
        const ctx = { card_last4: '9911', bank: 'DFCC', cardRegistry: { '9911': { type: 'credit_card', bank: 'DFCC' } } };
        expect(validateSettlementRow(credit, { module: 'cc_payment', category: 'Card Payment', verified: true }, ctx)).toBe(null);
    });
    it('records a proven transfer as skipped without changing any financial array', async () => {
        const args = fixture();
        args.rows = [{ ...row, description: 'OUTWARD CEFT TRANSFER SISTER' }];
        args.decisions = [{ module: 'skip', category: 'Transfer', verified: true }];
        expect(await settleStatement(args)).toMatchObject({ filed: 0, skipped: 1, review: 0, status: 'filed' });
        expect(args.db.docs.get('users/u')).toEqual({});
        const ledger = [...args.db.docs.entries()].find(([path]) => path.includes('/statementLedger/'))?.[1];
        expect(ledger).toMatchObject({ status: 'skipped', module: 'skip' });
    });
    it('atomically writes user array, identity and final source while preserving encrypted manifest', async () => {
        const args = fixture(); const result = await settleStatement(args);
        expect(result).toMatchObject({ filed: 1, status: 'filed' });
        expect(args.db.docs.get('users/u').expenses).toHaveLength(1);
        expect(args.db.docs.get('users/u')).toMatchObject({
            _lastModifiedBy: 'statement-worker',
            _writeDeviceId: 'statement-worker',
            _writeTs: 1000,
        });
        expect(args.db.docs.get('sources/s')).toMatchObject({ encrypted: 'preserved', filed: true, cursor: 1, leaseToken: '' });
    });
    it('does not erase legitimate repeated purchases within one source', async () => {
        const args = fixture(); args.rows = [row, row]; args.decisions = [decision, decision]; args.totalRows = 2;
        expect((await settleStatement(args)).filed).toBe(2);
        expect(args.db.docs.get('users/u').expenses).toHaveLength(2);
    });
    it('acknowledges an identical occurrence but rejects changed content atomically', async () => {
        const args = fixture();
        await settleStatement(args);
        const renew = () => args.db.docs.set('sources/s', { ...args.db.docs.get('sources/s'), cursor: 0, leaseToken: 'token', leaseUntil: 2000 });
        renew();
        expect(await settleStatement(args)).toMatchObject({ duplicates: 1, filed: 0 });
        renew();
        const before = structuredClone([...args.db.docs]);
        args.rows = [{ ...row, amount: 43.10 }];
        await expect(settleStatement(args)).rejects.toThrow('statement-cursor-or-content-changed');
        expect([...args.db.docs]).toEqual(before);
    });
    it('replaces an occurrence deliberately superseded by a corrected layout', async () => {
        const args = fixture(), id = sourceOccurrenceId(args.sourceRef.path, 0);
        args.db.docs.set('users/u/statementLedger/' + id, { uid: 'u', sourcePath: args.sourceRef.path, index: 0, status: 'superseded_by_layout', fingerprint: 'old' });
        expect(await settleStatement(args)).toMatchObject({ filed: 1, duplicates: 0 });
        expect(args.db.docs.get('users/u/statementLedger/' + id).status).toBe('filed');
    });
    it('quarantines ambiguous prior manual matches without filing the source', async () => {
        const args = fixture({ expenses: [{ ...row, desc: 'Merchant', bank: 'Bank', card_last4: '1234', id: 'manual' }] });
        args.db.docs.set('sources/s', { ...args.db.docs.get('sources/s'), filename: 'HNB-August.pdf', subject: 'Your eStatement', receivedMs: 12345, from: 'statements@bank.example' });
        expect(await settleStatement(args)).toMatchObject({ review: 1, status: 'needs_review' });
        expect(args.db.docs.get('users/u').expenses).toHaveLength(1);
        expect(args.db.docs.get('sources/s').filed).toBe(false);
        const review = [...args.db.docs.entries()].find(([path]) => path.includes('/statementReview/'))?.[1];
        expect(review).toMatchObject({ bank: 'Bank', filename: 'HNB-August.pdf', subject: 'Your eStatement', receivedMs: 12345, from: 'statements@bank.example', last4: '1234' });
    });
    it('quarantines cross-source bank references because references can repeat', async () => {
        const args = fixture({ expenses: [{ ...row, desc: 'Merchant', bank: 'Bank', card_last4: '1234', ref: 'r123', id: 'manual' }] }); args.rows = [{ ...row, ref: 'r123' }];
        expect(await settleStatement(args)).toMatchObject({ duplicates: 0, review: 1 });
        expect(args.db.docs.get('users/u').expenses).toHaveLength(1);
    });
    it('never acknowledges a manual occurrence with opposite or missing direction as a duplicate', async () => {
        for (const direction of ['credit', undefined]) {
            const args = fixture({ expenses: [{ ...row, direction, desc: 'Merchant', bank: 'Bank', card_last4: '1234', id: 'manual', statementKey: 'sources/s', statementRow: 0 }] });
            expect(await settleStatement(args)).toMatchObject({ duplicates: 0, review: 1, filed: 0 });
        }
    });
    it('rejects expired lease and wrong account without writes', async () => {
        const args = fixture(); args.now = 2000;
        await expect(settleStatement(args)).rejects.toThrow('statement-lease-lost');
        expect(args.db.docs.size).toBe(2);
    });
    it('releases partial slice lease and retains prior review state', async () => {
        const args = fixture(); args.totalRows = 2; args.decisions = [{ verified: false, reason: 'provider-down' }];
        expect(await settleStatement(args)).toMatchObject({ status: 'pending', cursor: 1, review: 1 });
        args.db.docs.set('sources/s', { ...args.db.docs.get('sources/s'), leaseToken: 'token', leaseUntil: 2000 });
        args.cursor = 1; args.decisions = [decision];
        expect(await settleStatement(args)).toMatchObject({ status: 'needs_review', filed: 1 });
        expect(args.db.docs.get('sources/s').filed).toBe(false);
    });
    it('updates an explicitly allocated subscription history and quarantines missing allocation', async () => {
        const args = fixture({ subscriptions: [{ id: 'sub', name: 'Plan', history: [], amount: 10 }] });
        args.decisions = [{ module: 'subscriptions', category: 'Streaming', allocationId: 'sub', verified: true }];
        expect((await settleStatement(args)).filed).toBe(1);
        expect(args.db.docs.get('users/u').subscriptions[0].history).toHaveLength(1);
        const missing = fixture(); missing.decisions = args.decisions;
        expect((await settleStatement(missing)).review).toBe(1);
    });
    it('resolves a persisted review once and safely rejects another owner', async () => {
        const args = fixture();
        args.db.docs.delete('sources/s'); args.sourceRef = args.db.doc('wf-mail/owner/items/m1.statement.pdf');
        args.db.docs.set(args.sourceRef.path, { uid: 'u', leaseToken: 'token', leaseUntil: 2000, cursor: 0 });
        args.decisions = [{ verified: false }]; await settleStatement(args);
        const id = sourceOccurrenceId(args.sourceRef.path, 0);
        const request = { db: args.db, uid: 'u', id, row: { ...row, description: 'Corrected Merchant' }, decision, now: 1200 };
        await expect(resolveReview({ ...request, uid: 'other' })).rejects.toThrow('review-not-found');
        expect(await resolveReview(request)).toMatchObject({ ok: true, filed: true });
        expect(await resolveReview(request)).toMatchObject({ alreadyResolved: true });
        expect(args.db.docs.get('users/u').expenses).toHaveLength(1);
        expect(args.db.docs.get('users/u/statementReview/' + id).reason).toBe('');
    });
    it('settles a registry-recognized credit-card charge end to end when the parser could not read statementType', async () => {
        const args = fixture();
        args.bank = 'DFCC'; args.last4 = '9911'; args.statementType = '';
        args.cardRegistry = { '9911': { type: 'credit_card', bank: 'DFCC' } };
        args.decisions = [{ module: 'cconetime', category: 'Shopping', verified: true }];
        expect(await settleStatement(args)).toMatchObject({ filed: 1, status: 'filed' });
        expect(args.db.docs.get('users/u').cconetime).toHaveLength(1);
    });
    it('settles a credit-card installment into the installment tab', async () => {
        const args = fixture();
        args.statementType = 'credit_card';
        args.decisions = [{ module: 'ccinstall', category: 'Installment', verified: true }];
        expect(await settleStatement(args)).toMatchObject({ filed: 1, status: 'filed' });
        expect(args.db.docs.get('users/u').ccinstall).toHaveLength(1);
        expect(args.db.docs.get('users/u').ccinstall[0]).toMatchObject({ total: 42.1, monthly: 42.1, remaining: 1 });
    });
    it('resolves a per-row credit-card review using the owner card registry when the source never read statementType', async () => {
        const args = fixture({ settings: { cardRegistry: { '9911': { type: 'credit_card', bank: 'DFCC' } } } });
        args.db.docs.delete('sources/s'); args.sourceRef = args.db.doc('wf-mail/owner/items/m2.statement.pdf');
        args.db.docs.set(args.sourceRef.path, { uid: 'u', leaseToken: 'token', leaseUntil: 2000, cursor: 0 });
        args.bank = 'DFCC'; args.last4 = '9911'; args.statementType = '';
        args.decisions = [{ verified: false }];
        await settleStatement(args);
        const id = sourceOccurrenceId(args.sourceRef.path, 0);
        const decision = { module: 'cconetime', category: 'Shopping', verified: true };
        const request = { db: args.db, uid: 'u', id, row: {}, decision, now: 1200 };
        expect(await resolveReview(request)).toMatchObject({ ok: true, filed: true });
        expect(args.db.docs.get('users/u').cconetime).toHaveLength(1);
    });
    it('rejects impossible manual review edits without resolving or writing', async () => {
        const args = fixture();
        args.db.docs.delete('sources/s'); args.sourceRef = args.db.doc('wf-mail/owner/items/s');
        args.db.docs.set(args.sourceRef.path, { uid: 'u', leaseToken: 'token', leaseUntil: 2000, cursor: 0 });
        args.decisions = [{ verified: false }]; await settleStatement(args);
        const id = sourceOccurrenceId(args.sourceRef.path, 0);
        await expect(resolveReview({ db: args.db, uid: 'u', id, row: { ...row, date: '2026-02-30' }, decision })).rejects.toThrow('invalid-transaction');
        expect(args.db.docs.get('users/u').expenses).toBeUndefined();
        expect(args.db.docs.get('users/u/statementReview/' + id).status).toBe('pending');
    });
});
