import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { validScheduleSecret, invokeBoard, classifySlice, claimSource, attachmentBytes, inspectReviewSource, mapReviewLayout, recoverPasswordFailures } from '../statement-sync.js';
import { planMessage } from '../wealthflow-mail-ingest.mjs';
import { policyFrom } from '../wealthflow-mail-senders.mjs';

const roster = Array.from({ length: 10 }, (_, index) => 'engine' + index);
const row = { date: '2026-09-10', narration: 'Merchant', amount: 42, direction: 'debit', directionSource: 'column', needsReview: false };
const decision = { index: 0, module: 'expenses', category: 'Food', allocationId: '' };
const good = fields => ({ unanimous: true, trustworthy: true, expected: roster, fields });

describe('statement worker authorization and board', () => {
    it('requires a long exact constant-time schedule credential', () => {
        const env = { CRON_SECRET: 'a'.repeat(24) };
        expect(validScheduleSecret({ headers: { authorization: 'Bearer ' + env.CRON_SECRET } }, env)).toBe(true);
        expect(validScheduleSecret({ headers: { authorization: 'Bearer ' + 'b'.repeat(24) } }, env)).toBe(false);
        expect(validScheduleSecret({ headers: { authorization: 'Bearer short' } }, { CRON_SECRET: 'short' })).toBe(false);
    });
    it('requires every configured engine and at least ten experts', async () => {
        const invoke = value => invokeBoard('Return only JSON.', async (_, res) => res.status(200).json(value));
        await expect(invoke(good({ decisions: [decision] }))).resolves.toMatchObject({ unanimous: true });
        await expect(invoke({ ...good({}), expected: roster.slice(0, 9) })).rejects.toThrow('ai-consensus-unavailable');
        await expect(invoke({ ...good({}), unanimous: false })).rejects.toThrow('ai-consensus-unavailable');
    });
    it('runs independent classification then independent unanimous peer approval without editing amounts', async () => {
        const board = vi.fn().mockResolvedValueOnce(good({ decisions: [decision] })).mockResolvedValueOnce(good({ approved: true }));
        expect(await classifySlice([row], {}, { board })).toEqual([{ module: 'expenses', category: 'Food', allocationId: '', verified: true }]);
        expect(board).toHaveBeenCalledTimes(2);
        expect(row.amount).toBe(42);
    });
    it('quarantines veto, roster changes and malformed index mappings', async () => {
        for (const peer of [good({ approved: false }), { ...good({ approved: true }), expected: [...roster, 'new-engine'] }]) {
            const board = vi.fn().mockResolvedValueOnce(good({ decisions: [decision] })).mockResolvedValueOnce(peer);
            expect((await classifySlice([row], {}, { board }))[0].verified).toBe(false);
        }
        expect((await classifySlice([row], {}, { board: async () => good({ decisions: [{ ...decision, index: 1 }] }) }))[0].verified).toBe(false);
    });
    it('never claims an active lease or another owner source', async () => {
        let data = { status: 'pending', uid: 'u', leaseUntil: 1001 };
        const set = vi.fn();
        const db = { runTransaction: fn => fn({ get: async () => ({ exists: true, data: () => data }), set }) };
        expect(await claimSource(db, {}, 'u', 1000)).toBe(null);
        data = { status: 'pending', uid: 'other' };
        expect(await claimSource(db, {}, 'u', 1000)).toBe(null);
        data = { status: 'pending', uid: 'u' };
        expect(await claimSource(db, {}, 'u', 1000)).toMatchObject({ uid: 'u', status: 'pending' });
        expect(set).toHaveBeenCalledTimes(1);
    });
});

describe('private source inspection and durable layout replay', () => {
    const text = 'HATTON NATIONAL BANK PLC\nSTATEMENT OF ACCOUNT\nAccount No: 004010123456 Statement Period 01/07/2026 to 31/07/2026\n01/07/2026 OPENING BALANCE 100000.00\n02/07/2026 KEELLS STORE 4250.00 95750.00\n03/07/2026 SALARY 250000.00 345750.00\n05/07/2026 CEB ELECTRICITY 8430.50 337319.50\n31/07/2026 CLOSING BALANCE 337319.50';
    function setup() {
        const id = 'a'.repeat(64), sourcePath = 'wf-mail/owner_example_com/items/item';
        const data = new Map([
            ['wf-mail/owner_example_com', { uid: 'u', email: 'owner@example.com', refresh_token: 'refresh', senders: [] }],
            [sourcePath, { uid: 'u', bank: 'HNB', filename: 'statement.pdf', messageId: 'm1', status: 'needs_review', cursor: 0 }],
            ['users/u/statementReview/' + id, { uid: 'u', sourcePath, index: -1, status: 'pending' }],
            ['wf-statement-vault/u', { uid: 'u' }]
        ]);
        const collection = path => ({ doc: value => ref(path + '/' + value), where: (field, _, value) => ({ query: true, path, field, value, orderBy() { return this; }, limit() { return this; }, startAfter() { return this; }, async get() { return { docs: [...data.entries()].filter(([key, entry]) => key.startsWith(path + '/') && entry[field] === value).map(([key]) => ({ id: key.split('/').at(-1), ref: ref(key), data: () => structuredClone(data.get(key)) })) }; } }) });
        const ref = path => ({ path, id: path.split('/').at(-1), collection: name => collection(path + '/' + name), get: async () => ({ exists: data.has(path), data: () => structuredClone(data.get(path)) }), set: async (value, opts) => data.set(path, opts?.merge ? { ...data.get(path), ...value } : value) });
        const db = { doc: ref, collection, async runTransaction(fn) {
            const writes = []; let writing = false;
            const result = await fn({ async get(r) { if (writing) throw new Error('read-after-write'); if (r.query) return { docs: [...data.entries()].filter(([path, value]) => path.startsWith(r.path + '/') && value[r.field] === r.value).map(([path, value]) => ({ id: path.split('/').at(-1), data: () => structuredClone(value) })) }; return r.get(); }, set(r, value, options) { writing = true; writes.push([r.path, value, options]); } });
            writes.forEach(([path, value, options]) => data.set(path, options?.merge ? { ...data.get(path), ...value } : value)); return result;
        } };
        const owner = { uid: 'u', email: 'owner@example.com' };
        const env = { CRON_SECRET: 'a'.repeat(24), STATEMENT_TASK_QUEUE: 'projects/p/locations/l/queues/q', STATEMENT_SYNC_ORIGIN: 'https://example.com' };
        const f = vi.fn(async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }));
        const open = vi.fn(async () => [{ password: '01021990', bank: 'HNB' }]);
        const read = vi.fn(async () => ({ text, parsed: { layout: { accountLast4: '3456' } } }));
        const attachment = vi.fn(async () => ({ bytes: Buffer.from('%PDF-test'), filename: 'statement.pdf' }));
        return { id, sourcePath, db, data, owner, env, f, open, read, attachment };
    }
    it('decrypts persisted owner source with exact vault candidates and returns no passwords', async () => {
        const args = setup(); const result = await inspectReviewSource(args);
        expect(result).toMatchObject({ ok: true, text, bank: 'HNB', last4: '3456' });
        expect(JSON.stringify(result)).not.toContain('01021990');
        expect(args.read.mock.calls[0][0].layouts).toEqual([]);
        expect(args.read.mock.calls[0][0].passwords).toEqual(['']); // scrubbed after read
        await expect(inspectReviewSource({ ...args, owner: { uid: 'other', email: args.owner.email } })).rejects.toThrow('whole-statement-review-required');
    });
    it('atomically saves only validated learned template and resumes unfiled source', async () => {
        const args = setup(); const enqueue = vi.fn(async () => ({ queued: true }));
        const inspect = value => inspectReviewSource({ ...value, f: args.f, open: args.open, read: args.read, attachment: args.attachment });
        const learn = vi.fn(async () => ({ ok: true, template: { id: 't1', bank: 'HNB', v: 1 }, rows: [row] }));
        expect(await mapReviewLayout({ ...args, rows: [row], inspect, learn, enqueue })).toMatchObject({ mapped: true, queued: true });
        expect(args.data.get(args.sourcePath)).toMatchObject({ status: 'pending', totalRows: 1, cursor: 0, filed: false });
        expect(args.data.get('users/u/statementReview/' + args.id).status).toBe('mapped');
        expect([...args.data.keys()].some(path => path.startsWith('users/u/statementLayouts/'))).toBe(true);
        expect(enqueue).toHaveBeenCalledTimes(1);
    });
    it('refuses replay overlapping settled rows and rejects invalid layout before mutation', async () => {
        const args = setup(); args.data.set('users/u/statementLedger/existing', { sourcePath: args.sourcePath, status: 'filed' });
        const inspect = async () => ({ text, bank: 'HNB', sourcePath: args.sourcePath });
        const enqueue = vi.fn();
        await expect(mapReviewLayout({ ...args, rows: [row], inspect, learn: async () => ({ ok: true, template: { id: 't1' }, rows: [row] }), enqueue })).rejects.toThrow('layout-replay-would-overlap-settled-data');
        expect(args.data.get(args.sourcePath).status).toBe('needs_review');
        await expect(mapReviewLayout({ ...args, rows: [], inspect, learn: async () => ({ ok: false }), enqueue })).rejects.toThrow('layout-confirmation-does-not-reproduce-statement');
        expect(enqueue).not.toHaveBeenCalled();
    });
    it('learns an actual full layout from decrypted evidence and refuses incomplete confirmation', async () => {
        const confirmed = [{ date: '2026-07-02', amount: 4250, direction: 'debit' }, { date: '2026-07-03', amount: 250000, direction: 'credit' }, { date: '2026-07-05', amount: 8430.50, direction: 'debit' }];
        const args = setup();
        const inspect = value => inspectReviewSource({ ...value, f: args.f, open: args.open, read: args.read, attachment: args.attachment });
        await expect(mapReviewLayout({ ...args, rows: confirmed.slice(0, 1), inspect, enqueue: vi.fn() })).rejects.toThrow('layout-confirmation-does-not-reproduce-statement');
        expect(await mapReviewLayout({ ...args, rows: confirmed, inspect, enqueue: async () => ({ queued: true }) })).toMatchObject({ mapped: true });
        expect(args.data.get(args.sourcePath).totalRows).toBe(3);
    });
    it('retries password failures only for a newer vault and never overlaps settled data', async () => {
        const args = setup(), reviewId = createHash('sha256').update(args.sourcePath).digest('hex');
        args.data.set('users/u/statementReview/' + reviewId, { uid: 'u', sourcePath: args.sourcePath, index: -1, status: 'pending' });
        args.data.set(args.sourcePath, { ...args.data.get(args.sourcePath), reviewReason: 'PASSWORD_FAILED', vaultSavedAt: 100 });
        const request = { db: args.db, mailRef: args.db.doc('wf-mail/owner_example_com'), uid: 'u', vaultSavedAt: 100 };
        expect(await recoverPasswordFailures(request)).toBe(0);
        args.data.set('users/u/statementLedger/settled', { sourcePath: args.sourcePath, status: 'filed' });
        expect(await recoverPasswordFailures({ ...request, vaultSavedAt: 200 })).toBe(0);
        args.data.delete('users/u/statementLedger/settled');
        expect(await recoverPasswordFailures({ ...request, vaultSavedAt: 200 })).toBe(1);
        expect(args.data.get(args.sourcePath)).toMatchObject({ status: 'pending', cursor: 0, vaultSavedAt: 100 });
        expect(args.data.get('users/u/statementReview/' + reviewId).status).toBe('retried');
        expect(await recoverPasswordFailures({ ...request, vaultSavedAt: 200 })).toBe(0);
    });
    it('reports durable mapping success if queue delivery fails afterwards', async () => {
        const args = setup();
        const result = await mapReviewLayout({ ...args, rows: [row], inspect: async () => ({ text, bank: 'HNB', sourcePath: args.sourcePath }), learn: async () => ({ ok: true, template: { id: 't1' }, rows: [row] }), enqueue: async () => { throw new Error('queue-down'); } });
        expect(result).toEqual({ ok: true, mapped: true, queued: false });
        expect(args.data.get(args.sourcePath).status).toBe('pending');
    });
});

describe('statement worker attachment policy', () => {
    const senders = [{ id: 'statements@hnb.lk', kind: 'address', status: 'approved' }];
    const message = {
        id: 'm1', internalDate: '1789000000000', snippet: 'Your monthly bank statement',
        payload: { headers: [{ name: 'From', value: 'statements@hnb.lk' }, { name: 'Subject', value: 'Monthly account statement' }, { name: 'Authentication-Results', value: 'dkim=pass header.i=@hnb.lk' }], parts: [{ filename: 'statement.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 100 } }] }
    };
    it('rechecks exact whitelist and DKIM before downloading ciphertext', async () => {
        const plan = planMessage(message, policyFrom(senders));
        expect(plan.ok).toBe(true);
        const f = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => message }).mockResolvedValueOnce({ ok: true, json: async () => ({ data: Buffer.from('%PDF-test').toString('base64url') }) });
        const result = await attachmentBytes({ messageId: 'm1' }, { id: plan.items[0].key }, 'token', senders, f);
        expect(result.bytes.toString()).toBe('%PDF-test');
        const blocked = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => message });
        await expect(attachmentBytes({ messageId: 'm1' }, { id: plan.items[0].key }, 'token', [], blocked)).rejects.toThrow('statement-sender-no-longer-approved');
        expect(blocked).toHaveBeenCalledTimes(1);
    });
});
