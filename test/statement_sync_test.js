import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { validScheduleSecret, invokeBoard, classifySlice, deterministicDecision, claimSource, attachmentBytes, inspectReviewSource, mapReviewLayout, recoverPasswordFailures, recoverWholeStatementFailures, repairReviewMetadata, repairCategoriesInUser, publicReviewSourceReason } from '../statement-sync.js';
import { planMessage } from '../wealthflow-mail-ingest.mjs';
import { policyFrom } from '../wealthflow-mail-senders.mjs';
import { textVerdict, VERDICT } from '../wealthflow-statement-identity.js';
import fs from 'node:fs';
import path from 'node:path';

const roster = Array.from({ length: 10 }, (_, index) => 'engine' + index);
const row = { date: '2026-09-10', narration: 'Merchant', amount: 42, direction: 'debit', directionSource: 'column', needsReview: false };
const decision = { index: 0, module: 'expenses', category: 'Groceries', allocationId: '' };
const good = fields => ({ unanimous: true, trustworthy: true, expected: roster, fields });

describe('statement worker authorization and board', () => {
    it('has an independent daily catch-up schedule routed to the worker', () => {
        const root = path.resolve(import.meta.dirname, '..');
        const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
        const cron = vercel.crons.find(entry => entry.path === '/api/statement-sync');
        expect(cron).toEqual({ path: '/api/statement-sync', schedule: '30 3 * * *' });
        expect(fs.readFileSync(path.join(root, 'api/router.js'), 'utf8'))
            .toContain("'statement-sync': () => import('../statement-sync.js')");
    });
    it('requires a long exact constant-time schedule credential', () => {
        const env = { CRON_SECRET: 'a'.repeat(24) };
        expect(validScheduleSecret({ headers: { authorization: 'Bearer ' + env.CRON_SECRET } }, env)).toBe(true);
        expect(validScheduleSecret({ headers: { authorization: 'Bearer ' + 'b'.repeat(24) } }, env)).toBe(false);
        expect(validScheduleSecret({ headers: { authorization: 'Bearer short' } }, { CRON_SECRET: 'short' })).toBe(false);
    });
    it('requires every configured engine and at least five experts', async () => {
        const invoke = value => invokeBoard('Return only JSON.', async (_, res) => res.status(200).json(value));
        await expect(invoke(good({ decisions: [decision] }))).resolves.toMatchObject({ unanimous: true });
        await expect(invoke({ ...good({}), expected: roster.slice(0, 4) })).rejects.toThrow('ai-consensus-unavailable');
        await expect(invoke({ ...good({}), unanimous: false })).rejects.toThrow('ai-consensus-unavailable');
    });
    it('runs independent classification then independent unanimous peer approval without editing amounts', async () => {
        const board = vi.fn().mockResolvedValueOnce(good({ decisions: [decision] })).mockResolvedValueOnce(good({ approved: true }));
        expect(await classifySlice([row], {}, { board })).toEqual([{ module: 'expenses', category: 'Groceries', allocationId: '', verified: true }]);
        expect(board).toHaveBeenCalledTimes(2);
        expect(row.amount).toBe(42);
        expect(JSON.stringify(board.mock.calls[0][0])).toContain('MERCHANT');
    });
    it('quarantines veto, roster changes and malformed index mappings', async () => {
        for (const peer of [good({ approved: false }), { ...good({ approved: true }), expected: [...roster, 'new-engine'] }]) {
            const board = vi.fn().mockResolvedValueOnce(good({ decisions: [decision] })).mockResolvedValueOnce(peer);
            expect((await classifySlice([row], {}, { board }))[0].verified).toBe(false);
        }
        expect((await classifySlice([row], {}, { board: async () => good({ decisions: [{ ...decision, index: 1 }] }) }))[0].verified).toBe(false);
    });
    it('falls back only to deterministic generic routes when the board is unavailable', async () => {
        const unavailable = async () => { throw new Error('provider deadline'); };
        expect(await classifySlice([row], { statementType: 'bank_account' }, { board: unavailable })).toEqual([
            { module: 'expenses', category: 'Other', allocationId: '', verified: true, deterministic: true }
        ]);
        expect(deterministicDecision({ ...row, needsReview: true }, { statementType: 'bank_account' })).toEqual({ verified: false, reason: 'ai-consensus-unavailable' });
        expect(deterministicDecision({ ...row, narration: 'EASY PAYMENT 4/24' }, { statementType: 'credit_card' })).toEqual({ verified: false, reason: 'ai-consensus-unavailable' });
        expect(deterministicDecision({ ...row, direction: 'credit', narration: 'PAYMENT THANK YOU' }, { statementType: 'credit_card' })).toMatchObject({ module: 'ccPayments', verified: true });
        expect(deterministicDecision({ ...row, narration: 'POS TRANSACTION DIALOG AXIATA PLC' }, { statementType: 'bank_account' })).toMatchObject({ module: 'expenses', verified: true });
        expect(deterministicDecision({ ...row, narration: 'POS TRANSACTION DIALOG AXIATA PLC' }, { statementType: 'credit_card' })).toMatchObject({ module: 'cconetime', verified: true });
        expect(deterministicDecision({ ...row, narration: 'OUTWARD CEFT TRANSFER SISTER' }, { statementType: 'bank_account' })).toMatchObject({ module: 'skip', category: 'Transfer', verified: true });
        expect(deterministicDecision({ ...row, direction: 'credit', narration: 'TRANSFER CREDIT-MOBILEBANKING' }, { statementType: 'bank_account' })).toMatchObject({ module: 'skip', verified: true });
        // processOneStatement wires the owner's Settings -> Manage cards & accounts
        // registry into allocations precisely so this same 'credit_card' verdict is
        // reachable when the parser itself could not read a statementType from the
        // document — not only when it could, as every case above assumes.
        expect(deterministicDecision({ ...row, narration: 'POS TRANSACTION DIALOG AXIATA PLC' }, { card_last4: '4471', cardRegistry: { 4471: { type: 'credit_card' } } })).toMatchObject({ module: 'cconetime', verified: true });
        expect(deterministicDecision({ ...row, narration: 'POS TRANSACTION DIALOG AXIATA PLC' }, { card_last4: '4471', cardRegistry: { 4471: { type: 'bank_account' } } })).toMatchObject({ module: 'expenses', verified: true });
    });
    it('uses deterministic financial evidence instead of flattening known rows to Other', async () => {
        const unavailable = async () => { throw new Error('offline'); };
        const samples = [
            ['POS TRANSACTION KEELLS SUPER KURUNEGALA', 'Groceries'],
            ['CEFT CHARGES TRANSPORT', 'Bank Charges'],
            ['POS TRANSACTION DIALOG AXIATA PLC', 'Telecom'],
            ['ATM WITHDRAWAL KURUNEGALA CRM', 'Cash Withdrawal'],
            ['POS TRANSACTION OISHII BURGER', 'Dining'],
        ];
        for (const [narration, category] of samples) {
            expect((await classifySlice([{ ...row, narration }], { statementType: 'bank_account' }, { board: unavailable }))[0])
                .toMatchObject({ module: 'expenses', category, verified: true, deterministic: true });
        }
        expect(deterministicDecision({ ...row, direction: 'credit', narration: 'MONTHLY SALARY CREDIT' }, { statementType: 'bank_account' }))
            .toMatchObject({ module: 'incomeRecv', category: 'Salary', verified: true });
    });
    it('overrules a unanimous but direction-conflicting or generic AI classification', async () => {
        const bad = { index: 0, module: 'incomeRecv', category: 'Other', allocationId: '' };
        const board = vi.fn().mockResolvedValueOnce(good({ decisions: [bad] })).mockResolvedValueOnce(good({ approved: true }));
        expect(await classifySlice([{ ...row, narration: 'POS TRANSACTION KEELLS SUPER' }], { statementType: 'bank_account' }, { board }))
            .toEqual([{ module: 'expenses', category: 'Groceries', allocationId: '', verified: true, deterministic: true }]);
    });
    it('never lets a unanimous board turn a transfer into income or spending', async () => {
        for (const [direction, module] of [['credit', 'incomeRecv'], ['debit', 'expenses']]) {
            const wrong = { index: 0, module, category: direction === 'credit' ? 'Income' : 'Other', allocationId: '' };
            const board = vi.fn().mockResolvedValueOnce(good({ decisions: [wrong] })).mockResolvedValueOnce(good({ approved: true }));
            expect(await classifySlice([{ ...row, direction, narration: direction === 'credit' ? 'TRANSFER CREDIT-MOBILEBANKING' : 'OUTWARD CEFT TRANSFER SISTER' }], { statementType: 'bank_account' }, { board }))
                .toEqual([{ module: 'skip', category: 'Transfer', allocationId: '', verified: true, deterministic: true }]);
        }
    });
    it('self-heals only generic statement categories with strong evidence', () => {
        const original = { expenses: [
            { id: 'a', source: 'statement', desc: 'POS TRANSACTION KEELLS SUPER', cat: 'Other' },
            { id: 'legacy', statementKey: 'wf-mail/owner_example_com/items/statement.pdf', statementRow: 4, desc: 'CEFT CHARGES TRANSPORT', cat: 'Other' },
            { id: 'b', source: 'statement', desc: 'UNKNOWN MERCHANT', cat: 'Other' },
            { id: 'c', source: 'manual', desc: 'KEELLS', cat: 'Other' },
            { id: 'forged', statementKey: 'manual/import', statementRow: 4, desc: 'KEELLS', cat: 'Other' },
        ], incomeRecv: [{ id: 'd', source: 'statement', name: 'MONTHLY SALARY', type: 'Income' }] };
        const result = repairCategoriesInUser(original);
        expect(result).toMatchObject({ expenses: 2, income: 1, total: 3 });
        expect(result.user.expenses.map(x => x.cat)).toEqual(['Groceries', 'Bank Charges', 'Other', 'Other', 'Other']);
        expect(result.user.incomeRecv[0].type).toBe('Salary');
        expect(original.expenses[0].cat).toBe('Other');
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
    it('exposes only fixed actionable source failures and masks arbitrary errors', () => {
        expect(publicReviewSourceReason(new Error('statement-sender-no-longer-approved'))).toBe('statement-sender-no-longer-approved');
        expect(publicReviewSourceReason(new Error('gmail-fetch-unavailable'))).toBe('gmail-fetch-unavailable');
        expect(publicReviewSourceReason(new Error('secret customer data'))).toBe('statement-layout-review-rejected');
    });
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
            const result = await fn({ async get(r) { if (writing) throw new Error('read-after-write'); if (r.query) return { docs: [...data.entries()].filter(([path, value]) => path.startsWith(r.path + '/') && value[r.field] === r.value).map(([path, value]) => ({ id: path.split('/').at(-1), ref: ref(path), data: () => structuredClone(value) })) }; return r.get(); }, set(r, value, options) { writing = true; writes.push([r.path, value, options]); } });
            writes.forEach(([path, value, options]) => data.set(path, options?.merge ? { ...data.get(path), ...value } : value)); return result;
        } };
        const owner = { uid: 'u', email: 'owner@example.com' };
        const env = { CRON_SECRET: 'a'.repeat(24) };
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
    it('reopens and safely maps a legacy pending review even when its source status is stale', async () => {
        const args = setup();
        args.data.set(args.sourcePath, { ...args.data.get(args.sourcePath), status: 'complete', filed: false });
        const evidence = await inspectReviewSource(args);
        expect(evidence).toMatchObject({ ok: true, bank: 'HNB', sourcePath: args.sourcePath });
        const inspect = value => inspectReviewSource({ ...value, f: args.f, open: args.open, read: args.read, attachment: args.attachment });
        const result = await mapReviewLayout({ ...args, rows: [row], inspect, learn: async () => ({ ok: true, template: { id: 'legacy', bank: 'HNB' }, rows: [row] }), enqueue: async () => ({ queued: true }) });
        expect(result).toMatchObject({ mapped: true, queued: true });
        expect(args.data.get(args.sourcePath)).toMatchObject({ status: 'pending', filed: false, cursor: 0 });
    });
    it('lets an explicitly pending layout review reach the reconciled manual mapper even when identity is inconclusive', async () => {
        const args = setup(), reviewPath = 'users/u/statementReview/' + args.id;
        const ambiguous = 'HNB ACCOUNT ACTIVITY\n02/07/2026 POS TRANSACTION PIZZA HUT 4250.00\n03/07/2026 CREDIT 250000.00';
        expect(textVerdict(ambiguous).verdict).not.toBe(VERDICT.STATEMENT);
        args.data.set(reviewPath, { ...args.data.get(reviewPath), reason: 'statement-layout-identity-needs-review', statementText: ambiguous });
        await expect(inspectReviewSource(args)).resolves.toMatchObject({ ok: true, text: ambiguous, sourcePath: args.sourcePath });

        args.data.set(reviewPath, { ...args.data.get(reviewPath), reason: 'statement-layout-identity-needs-review', statementText: '' });
        args.read.mockResolvedValueOnce({ text: ambiguous, parsed: { layout: { accountLast4: '3456' } } });
        await expect(inspectReviewSource(args)).resolves.toMatchObject({ ok: true, text: ambiguous, sourcePath: args.sourcePath });
    });
    it('maps a malformed row review and atomically supersedes its old review ledger', async () => {
        const args = setup(), reviewPath = 'users/u/statementReview/' + args.id;
        args.data.set(reviewPath, { ...args.data.get(reviewPath), index: 4, reason: 'invalid-transaction', row: { amount: 25 } });
        args.data.set(args.sourcePath, { ...args.data.get(args.sourcePath), cursor: 10, totalRows: 10, hasReview: true });
        args.data.set('users/u/statementLedger/' + args.id, { uid: 'u', sourcePath: args.sourcePath, index: 4, status: 'review', fingerprint: 'old' });
        const inspect = value => inspectReviewSource({ ...value, f: args.f, open: args.open, read: args.read, attachment: args.attachment });
        expect(await mapReviewLayout({ ...args, rows: [row], inspect, learn: async () => ({ ok: true, template: { id: 'fixed', bank: 'HNB' }, rows: [row] }), enqueue: async () => ({ queued: true }) })).toMatchObject({ mapped: true });
        expect(args.data.get(reviewPath).status).toBe('mapped');
        expect(args.data.get('users/u/statementLedger/' + args.id).status).toBe('superseded_by_layout');
        expect(args.data.get(args.sourcePath)).toMatchObject({ status: 'pending', cursor: 0, hasReview: false, totalRows: 1 });
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
    it('also recovers a legacy no-vault quarantine after the owner saves a vault', async () => {
        const args = setup(), reviewId = createHash('sha256').update(args.sourcePath).digest('hex');
        args.data.set('users/u/statementReview/' + reviewId, { uid: 'u', sourcePath: args.sourcePath, index: -1, status: 'pending' });
        args.data.set(args.sourcePath, { ...args.data.get(args.sourcePath), reviewReason: 'NO_VAULT_KEYS', vaultSavedAt: 0 });
        expect(await recoverPasswordFailures({ db: args.db, mailRef: args.db.doc('wf-mail/owner_example_com'), uid: 'u', vaultSavedAt: 200 })).toBe(1);
        expect(args.data.get(args.sourcePath)).toMatchObject({ status: 'pending', hasReview: false });
        expect(args.data.get('users/u/statementReview/' + reviewId).status).toBe('retried');
    });
    it('backfills bank, filename and received date on every legacy pending row review', async () => {
        const args = setup();
        args.data.set(args.sourcePath, { ...args.data.get(args.sourcePath), receivedMs: 123456, subject: 'Monthly statement', from: 'statements@hnb.lk' });
        args.data.set('users/u/statementReview/' + args.id, { uid: 'u', sourcePath: args.sourcePath, index: 4, status: 'pending', reason: 'invalid-transaction', row });
        expect(await repairReviewMetadata({ db: args.db, uid: 'u' })).toBe(1);
        expect(args.data.get('users/u/statementReview/' + args.id)).toMatchObject({ bank: 'HNB', filename: 'statement.pdf', receivedMs: 123456, subject: 'Monthly statement', from: 'statements@hnb.lk' });
        expect(await repairReviewMetadata({ db: args.db, uid: 'u' })).toBe(0);
    });
    it('replays every safe whole-statement failure, not only the first item', async () => {
        const args = setup(); args.data.delete('users/u/statementReview/' + args.id); args.data.delete(args.sourcePath);
        const reasons = ['statement-layout-or-reconciliation-needs-review', 'statement-layout-identity-needs-review', 'statement-attachment-identity-mismatch'];
        reasons.forEach((reason, i) => {
            const sourcePath = `wf-mail/owner_example_com/items/item${i}`, id = createHash('sha256').update(sourcePath).digest('hex');
            args.data.set(sourcePath, { uid: 'u', status: 'needs_review', reviewReason: reason, cursor: 0, filed: false });
            args.data.set('users/u/statementReview/' + id, { uid: 'u', sourcePath, index: -1, status: 'pending', reason });
        });
        const result = await recoverWholeStatementFailures({ db: args.db, uid: 'u', limit: 10 });
        expect(result).toEqual({ recovered: 3, more: false });
        reasons.forEach((_, i) => expect(args.data.get(`wf-mail/owner_example_com/items/item${i}`)).toMatchObject({ status: 'pending', wholeReplayVersion: 2 }));
        expect((await recoverWholeStatementFailures({ db: args.db, uid: 'u', limit: 10 })).recovered).toBe(0);
    });
    it('bounds whole replay and keeps content mismatches or settled data fail-closed', async () => {
        const args = setup(); args.data.delete('users/u/statementReview/' + args.id); args.data.delete(args.sourcePath);
        for (const [i, reason] of ['statement-layout-identity-needs-review', 'statement-layout-or-reconciliation-needs-review', 'statement-attachment-content-mismatch'].entries()) {
            const sourcePath = `wf-mail/owner_example_com/items/review${i}`, id = createHash('sha256').update(sourcePath).digest('hex');
            args.data.set(sourcePath, { uid: 'u', status: 'needs_review', reviewReason: reason, cursor: 0 });
            args.data.set('users/u/statementReview/' + id, { uid: 'u', sourcePath, index: -1, status: 'pending', reason });
            if (i === 1) args.data.set('users/u/statementLedger/settled', { sourcePath, status: 'filed' });
        }
        expect(await recoverWholeStatementFailures({ db: args.db, uid: 'u', limit: 1 })).toEqual({ recovered: 1, more: true });
        expect(args.data.get('wf-mail/owner_example_com/items/review1').status).toBe('needs_review');
        expect(args.data.get('wf-mail/owner_example_com/items/review2').status).toBe('needs_review');
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
    it('reads Gmail inline attachment data without calling the attachments endpoint', async () => {
        const inline = structuredClone(message);
        inline.payload.parts[0].body = { data: Buffer.from('%PDF-inline').toString('base64url'), size: 11 };
        const plan = planMessage(inline, policyFrom(senders));
        const f = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => inline });
        const result = await attachmentBytes({ messageId: 'm1' }, { id: plan.items[0].key }, 'token', senders, f);
        expect(result.bytes.toString()).toBe('%PDF-inline');
        expect(f).toHaveBeenCalledTimes(1);
    });
    it('recovers a legacy source by one exact attachment manifest match', async () => {
        const data = Buffer.from('%PDF-legacy').toString('base64url');
        const f = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => message })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ data }) });
        const result = await attachmentBytes({ messageId: 'm1', filename: 'statement.pdf', size: 100 }, { id: 'obsolete-key' }, 'token', senders, f);
        expect(result.bytes.toString()).toBe('%PDF-legacy');
    });
    it('keeps an ambiguous legacy attachment match in review', async () => {
        const duplicate = structuredClone(message);
        duplicate.payload.parts.push({ filename: 'statement.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a2', size: 100 } });
        const f = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => duplicate });
        await expect(attachmentBytes({ messageId: 'm1', filename: 'statement.pdf', size: 100 }, { id: 'obsolete-key' }, 'token', senders, f))
            .rejects.toThrow('statement-attachment-identity-mismatch');
        expect(f).toHaveBeenCalledTimes(1);
    });
    it('pins every attachment to SHA-256 and rejects changed ciphertext', async () => {
        const plan = planMessage(message, policyFrom(senders));
        const data = Buffer.from('%PDF-test').toString('base64url');
        const f = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => message }).mockResolvedValueOnce({ ok: true, json: async () => ({ data }) });
        const set = vi.fn();
        const first = await attachmentBytes({ messageId: 'm1' }, { id: plan.items[0].key, set }, 'token', senders, f);
        const digest = createHash('sha256').update(Buffer.from('%PDF-test')).digest('hex');
        expect(first.contentSha256).toBe(digest);
        expect(set).toHaveBeenCalledWith({ contentSha256: digest }, { merge: true });

        const changed = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => message }).mockResolvedValueOnce({ ok: true, json: async () => ({ data }) });
        await expect(attachmentBytes({ messageId: 'm1', contentSha256: '0'.repeat(64) }, { id: plan.items[0].key }, 'token', senders, changed))
            .rejects.toThrow('statement-attachment-content-mismatch');
    });
});
