import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';
import handler from '../statement-vault.js';

const fake = makeFakeAdmin();
const makeFirestore = fake.admin.firestore;
const originalFetch = globalThis.fetch;
const keys = ['WEALTHFLOW_OWNER_UID', 'STATEMENT_VAULT_KEY', 'FIREBASE_SERVICE_ACCOUNT'];
let savedEnv;
async function call(method, body, headers = { authorization: 'Bearer verified-test-token' }) {
    let output;
    const res = { statusCode: 200, setHeader() {}, end(text) { output = { status: this.statusCode, body: JSON.parse(text) }; } };
    await handler({ method, body, headers }, res);
    return output;
}
beforeEach(() => {
    savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    process.env.WEALTHFLOW_OWNER_UID = 'sole-owner';
    process.env.STATEMENT_VAULT_KEY = randomBytes(32).toString('hex');
    // Needed by admin-db.mjs's own bootstrap gate, not by the vault's crypto —
    // even the injected fake admin module requires SOME valid JSON credential
    // before it will count itself as initialised.
    process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
    fake.reset(); fake.setVerifier(async () => ({ uid: 'sole-owner', email: 'owner@example.org', email_verified: true }));
    const db = makeFirestore();
    fake.admin.firestore = () => db;
    db.runTransaction = async fn => {
        const writes = [];
        const result = await fn({ get: ref => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)), delete: ref => writes.push(() => ref.delete()) });
        for (const write of writes) await write();
        return result;
    };
    _setAdminModule(fake.admin);
    // The vault no longer talks to any external key service — proving that,
    // rather than mocking a call that should no longer happen, is the point.
    globalThis.fetch = vi.fn(async () => { throw new Error('unexpected-network-call'); });
});
afterEach(() => {
    globalThis.fetch = originalFetch; _setAdminModule(null);
    for (const key of keys) if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
});
describe('owner-only cloud vault HTTP boundary', () => {
    it('rejects missing identity and another verified account before key access', async () => {
        expect((await call('GET', null, {})).status).toBe(401);
        fake.setVerifier(async () => ({ uid: 'other', email: 'other@example.org', email_verified: true }));
        expect((await call('PUT', { entries: [{ password: 'secret' }] })).status).toBe(403);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it('stores ciphertext and returns metadata without returning or general-syncing passwords, and never touches the network', async () => {
        const result = await call('PUT', { entries: [{ password: ' Exact user PIN ', kind: 'custom' }] });
        expect(result.status).toBe(200);
        expect(JSON.stringify(result)).not.toContain('Exact user PIN');
        const db = fake.admin.firestore();
        const sealed = (await db.collection('wf-statement-vault').doc('sole-owner').get()).data();
        expect(sealed.uid).toBe('sole-owner');
        expect(typeof sealed.wrappedKey).toBe('string');
        expect(sealed.wrappedKey.length).toBeGreaterThan(0);
        expect(JSON.stringify(sealed)).not.toContain('Exact user PIN');
        expect((await db.collection('users').doc('sole-owner').get()).exists).toBe(false);
        expect((await call('GET')).body).toMatchObject({ saved: true, count: 1 });
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it('a saved vault opens back to the exact same entries, wrapped by the deployment\'s own key', async () => {
        await call('PUT', { entries: [{ password: 'correct horse battery staple', bank: 'HNB' }] });
        const { openCloud } = await import('../statement-cloud-vault.mjs');
        const db = fake.admin.firestore();
        const sealed = (await db.collection('wf-statement-vault').doc('sole-owner').get()).data();
        const entries = await openCloud('sole-owner', sealed);
        expect(entries).toEqual([{ id: 'entry-0', password: 'correct horse battery staple', bank: 'HNB', label: '', kind: '', format: '' }]);
    });
    it('fails closed — and stores nothing — when STATEMENT_VAULT_KEY is missing or malformed', async () => {
        delete process.env.STATEMENT_VAULT_KEY;
        expect((await call('PUT', { entries: [{ password: 'private' }] })).status).toBe(503);
        process.env.STATEMENT_VAULT_KEY = 'not-64-hex-chars';
        expect((await call('PUT', { entries: [{ password: 'private' }] })).status).toBe(503);
        const db = fake.admin.firestore();
        expect((await db.collection('wf-statement-vault').doc('sole-owner').get()).exists).toBe(false);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it('keeps vault revisions monotonic even when the clock moves backwards', async () => {
        const future = Date.now() + 86400000;
        await fake.admin.firestore().collection('wf-statement-vault').doc('sole-owner').set({ savedAt: future });
        const result = await call('PUT', { entries: [{ password: 'corrected' }] });
        expect(result.body.savedAt).toBe(future + 1);
    });
    it('deletes the ciphertext and disables future background decryption', async () => {
        await call('PUT', { entries: [{ password: 'private' }] });
        expect((await call('DELETE')).body).toMatchObject({ saved: false });
        const db = fake.admin.firestore();
        expect((await db.collection('wf-statement-vault').doc('sole-owner').get()).exists).toBe(false);
        expect((await db.collection('wf-mail').doc('owner_example_org').get()).data().autonomous).toBe(false);
    });
});
