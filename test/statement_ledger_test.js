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
    it('atomically writes user array, identity and final source while preserving encrypted manifest', async () => {
        const args = fixture(); const result = await settleStatement(args);
        expect(result).toMatchObject({ filed: 1, status: 'filed' });
        expect(args.db.docs.get('users/u').expenses).toHaveLength(1);
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
    it('quarantines ambiguous prior manual matches without filing the source', async () => {
        const args = fixture({ expenses: [{ ...row, desc: 'Merchant', bank: 'Bank', card_last4: '1234', id: 'manual' }] });
        expect(await settleStatement(args)).toMatchObject({ review: 1, status: 'needs_review' });
        expect(args.db.docs.get('users/u').expenses).toHaveLength(1);
        expect(args.db.docs.get('sources/s').filed).toBe(false);
        expect([...args.db.docs.keys()].some(path => path.includes('/statementReview/'))).toBe(true);
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
        args.db.docs.delete('sources/s'); args.sourceRef = args.db.doc('wf-mail/owner/items/s');
        args.db.docs.set(args.sourceRef.path, { uid: 'u', leaseToken: 'token', leaseUntil: 2000, cursor: 0 });
        args.decisions = [{ verified: false }]; await settleStatement(args);
        const id = sourceOccurrenceId(args.sourceRef.path, 0);
        const request = { db: args.db, uid: 'u', id, row: { ...row, description: 'Corrected Merchant' }, decision, now: 1200 };
        await expect(resolveReview({ ...request, uid: 'other' })).rejects.toThrow('review-not-found');
        expect(await resolveReview(request)).toMatchObject({ ok: true, filed: true });
        expect(await resolveReview(request)).toMatchObject({ alreadyResolved: true });
        expect(args.db.docs.get('users/u').expenses).toHaveLength(1);
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
