import { describe, it, expect, vi } from 'vitest';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { runStatementSync } from '../statement-sync.js';
import { planMessage } from '../wealthflow-mail-ingest.mjs';
import { policyFrom } from '../wealthflow-mail-senders.mjs';

// Synthetic credentials and statement only. No real financial attachment or
// provider/service credentials are part of this cold-server simulation.
const password = '01021990';
const plain = '<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 16/09/2026 Payment Due Date: 10/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>14/09/2026</td><td>KEELLS STORE</td><td>123.45 DR</td></tr><tr><td>15/09/2026</td><td>PAYMENT THANK YOU</td><td>50.00 CR</td></tr></table><script>throw Error("never execute attachment")</script></body></html>';
function encryptedHtml() {
    const salt = '0123456789abcdef0123456789abcdef', iv = 'fedcba9876543210fedcba9876543210';
    const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(password, Buffer.from(salt, 'hex'), 15000, 16, 'sha1'), Buffer.from(iv, 'hex'));
    const embedded = Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
    return Buffer.from(`<html><script>var embedded="${embedded}";var salt="${salt}";var iv="${iv}";function decrypt(){CryptoJS.AES.decrypt()}var options={iterations:15000,keySize:4};</script></html>`);
}
function database(initial) {
    const docs = new Map(Object.entries(initial));
    const snap = path => ({ id: path.split('/').at(-1), ref: ref(path), exists: docs.has(path), data: () => structuredClone(docs.get(path)) });
    const query = (path, filters = [], count = Infinity, after = '') => ({ query: true, path, filters, count, after,
        where(field, _, value) { return query(path, [...filters, [field, value]], count, after); },
        orderBy() { return this; }, limit(value) { return query(path, filters, value, after); }, startAfter(value) { return query(path, filters, count, value); },
        doc(id) { return ref(path + '/' + id); }, async get() { return { docs: [...docs.keys()].filter(key => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1 && key.split('/').at(-1) > after && filters.every(([field, value]) => docs.get(key)[field] === value)).sort().slice(0, count).map(snap) }; }
    });
    const ref = path => ({ path, id: path.split('/').at(-1), collection: name => query(path + '/' + name), get: async () => snap(path), set: async (value, opts) => docs.set(path, opts?.merge ? { ...docs.get(path), ...structuredClone(value) } : structuredClone(value)) });
    return { docs, doc: ref, collection: path => query(path), async runTransaction(fn) {
        const writes = []; let writing = false;
        const result = await fn({ async get(r) { if (writing) throw Error('read-after-write'); return r.query ? r.get() : snap(r.path); }, set(r, value, opts) { writing = true; writes.push([r.path, structuredClone(value), opts]); } });
        for (const [path, value, opts] of writes) docs.set(path, opts?.merge ? { ...docs.get(path), ...value } : value);
        return result;
    } };
}
function simulation({ disagree = false, unavailable = false } = {}) {
    const owner = { uid: 'u', email: 'owner@example.com' }, sender = 'statements@nationstrust.com';
    const senders = [{ id: sender, kind: 'address', status: 'approved' }];
    const message = { id: 'm1', internalDate: '1789000000000', snippet: 'Your monthly card statement', payload: {
        headers: [{ name: 'From', value: sender }, { name: 'Subject', value: 'AMEX Monthly Smart Statement' }, { name: 'Authentication-Results', value: 'dkim=pass header.i=@nationstrust.com' }],
        parts: [{ filename: 'AMEX_Statement_2026Sep.html', mimeType: 'text/html', body: { attachmentId: 'a1', size: 5000 } }]
    } };
    const plan = planMessage(message, policyFrom(senders));
    if (!plan.ok) throw Error('synthetic sender policy failed: ' + plan.reason);
    const sourcePath = 'wf-mail/owner_example_com/items/' + plan.items[0].key;
    const db = database({
        'users/u': { expenses: [], cconetime: [], ccPayments: [], incomeRecv: [], subscriptions: [] },
        'wf-mail/owner_example_com': { uid: 'u', email: owner.email, refresh_token: 'synthetic-refresh', autonomous: true, senders },
        'wf-statement-vault/u': { uid: 'u', savedAt: 100 },
        [sourcePath]: { uid: 'u', bank: 'NTB', filename: 'AMEX_Statement_2026Sep.html', messageId: 'm1', status: 'pending', cursor: 0, filed: false }
    });
    const ciphertext = encryptedHtml();
    const f = vi.fn(async url => {
        if (url === 'https://oauth2.googleapis.com/token') return { ok: true, json: async () => ({ access_token: 'synthetic-access' }) };
        if (url.includes('/attachments/')) return unavailable ? { ok: false, status: 503 } : { ok: true, json: async () => ({ data: ciphertext.toString('base64url') }) };
        if (url.includes('/messages/')) return { ok: true, json: async () => message };
        throw Error('unexpected external request');
    });
    let round = 0;
    const roster = Array.from({ length: 10 }, (_, i) => 'synthetic-engine-' + i);
    const board = vi.fn(async () => {
        round++;
        if (disagree) throw Error('synthetic engine disagreement');
        return { unanimous: true, trustworthy: true, expected: roster, fields: round % 2 ? { decisions: [
            { index: 0, module: 'cconetime', category: 'Groceries', allocationId: '' },
            { index: 1, module: 'ccPayments', category: 'Card Payment', allocationId: '' }
        ] } : { approved: true } };
    });
    const enqueue = vi.fn(async () => ({ queued: true }));
    const open = vi.fn(async () => [{ bank: 'NTB', password: '01/02/1990', kind: 'birthday', format: 'DDMMYYYY' }]);
    return { sourcePath, db, board, enqueue, args: { db, owner, action: 'drain', f, open, board, enqueue, env: { CRON_SECRET: 's'.repeat(24), STATEMENT_TASK_QUEUE: 'projects/p/locations/l/queues/q', STATEMENT_SYNC_ORIGIN: 'https://example.com' } } };
}

describe('cold-server composed statement pipeline simulation', () => {
    it('decrypts NTB HTML using vault DOB formatting, cross-checks ten engines, atomically files and ignores redelivery', async () => {
        const setup = simulation();
        expect(await runStatementSync(setup.args)).toMatchObject({ ok: true, processed: 1, status: 'filed', filed: 2 });
        const user = setup.db.docs.get('users/u');
        expect(user.cconetime).toHaveLength(1); expect(user.ccPayments).toHaveLength(1);
        expect(user.cconetime[0]).toMatchObject({ amount: 123.45, card_last4: '0276', paid: false, serviceFee: 0 });
        expect(user.ccPayments[0].amount).toBe(50);
        expect(user.incomeRecv).toEqual([]); expect(setup.board).toHaveBeenCalledTimes(2);
        expect(setup.db.docs.get(setup.sourcePath)).toMatchObject({ filed: true, cursor: 2, vaultSavedAt: 100 });
        expect(await runStatementSync(setup.args)).toMatchObject({ processed: 0, queued: false });
        expect(setup.db.docs.get('users/u').cconetime).toHaveLength(1);
    });
    it('quarantines disagreement without financial writes', async () => {
        const setup = simulation({ disagree: true });
        expect(await runStatementSync(setup.args)).toMatchObject({ status: 'needs_review', review: 2 });
        expect(setup.db.docs.get('users/u').cconetime).toEqual([]);
        expect(setup.db.docs.get('users/u').ccPayments).toEqual([]);
        expect(setup.db.docs.get(setup.sourcePath).filed).toBe(false);
        expect([...setup.db.docs.keys()].filter(path => path.startsWith('users/u/statementReview/'))).toHaveLength(2);
    });
    it('retains a retryable source after transient attachment transport failure', async () => {
        const setup = simulation({ unavailable: true });
        await expect(runStatementSync(setup.args)).rejects.toThrow('statement-worker-retry-required');
        expect(setup.db.docs.get(setup.sourcePath)).toMatchObject({ status: 'pending', leaseToken: '', filed: false });
        expect(setup.db.docs.get('users/u').cconetime).toEqual([]);
        expect(setup.board).not.toHaveBeenCalled();
        expect([...setup.db.docs.keys()].some(path => path.includes('/statementReview/'))).toBe(false);
    });
});
