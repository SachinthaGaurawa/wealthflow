import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { makeFakeAdmin } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';
import handler from '../statement-vault.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const fake = makeFakeAdmin();
const makeFirestore = fake.admin.firestore;
const originalFetch = globalThis.fetch;
const keys = ['WEALTHFLOW_OWNER_UID', 'STATEMENT_VAULT_KMS_KEY', 'FIREBASE_SERVICE_ACCOUNT'];
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
    process.env.STATEMENT_VAULT_KMS_KEY = 'projects/test/locations/global/keyRings/test/cryptoKeys/vault';
    process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'test@example.org', private_key: privateKey });
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
    globalThis.fetch = vi.fn(async url => {
        if (String(url).includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'test-cloud-token', expires_in: 3600 }) };
        if (String(url).endsWith(':encrypt')) return { ok: true, json: async () => ({ ciphertext: 'wrapped-test-key' }) };
        throw new Error('unexpected-network-call');
    });
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
    it('stores ciphertext and returns metadata without returning or general-syncing passwords', async () => {
        const result = await call('PUT', { entries: [{ password: ' Exact user PIN ', kind: 'custom' }] });
        expect(result.status).toBe(200);
        expect(JSON.stringify(result)).not.toContain('Exact user PIN');
        const db = fake.admin.firestore();
        const sealed = (await db.collection('wf-statement-vault').doc('sole-owner').get()).data();
        expect(sealed.uid).toBe('sole-owner'); expect(sealed.wrappedKey).toBe('wrapped-test-key');
        expect(JSON.stringify(sealed)).not.toContain('Exact user PIN');
        expect((await db.collection('users').doc('sole-owner').get()).exists).toBe(false);
        expect((await call('GET')).body).toMatchObject({ saved: true, count: 1 });
    });
    it('does not enable autonomous processing after KMS denial', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403 }));
        expect((await call('PUT', { entries: [{ password: 'private' }] })).status).toBe(503);
        expect((await fake.admin.firestore().collection('wf-statement-vault').doc('sole-owner').get()).exists).toBe(false);
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
