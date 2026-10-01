import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';

/* THE SAVE IS ANSWERED FIRST. The production log of 2026-10-01 showed 11 of 22 vault saves cut by the platform at 60 s with a 504:
 * the handler waited for a whole statement drain (budget 45 s, and the statement being read was allowed to finish) before answering,
 * although the vault had been saved at once. With a background window the save now answers immediately and the drain carries on. */

const drain = vi.hoisted(() => ({ release: null, started: 0, finished: 0, args: null, fail: false }));
vi.mock('../statement-sync.js', () => ({
    runStatementSync: async (args) => { drain.started++; drain.args = args; if (drain.fail) throw new Error('boom'); await new Promise((resolve) => { drain.release = resolve; }); drain.finished++; return { ok: true, processed: 0, attempted: 0, morePending: false }; },
}));
const { default: handler } = await import('../statement-vault.js');

const fake = makeFakeAdmin();
const keys = ['WEALTHFLOW_OWNER_UID', 'STATEMENT_VAULT_KEY', 'FIREBASE_SERVICE_ACCOUNT'];
let savedEnv, background;
const CTX = Symbol.for('@vercel/request-context');

async function put() {
    let output;
    const res = { statusCode: 200, setHeader() {}, end(text) { output = { status: this.statusCode, body: JSON.parse(text) }; } };
    await handler({ method: 'PUT', body: { entries: [{ password: 'pin', kind: 'custom' }] }, headers: { authorization: 'Bearer verified-test-token' } }, res);
    return output;
}

beforeEach(() => {
    savedEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.WEALTHFLOW_OWNER_UID = 'sole-owner';
    process.env.STATEMENT_VAULT_KEY = randomBytes(32).toString('hex');
    process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
    fake.reset(); fake.setVerifier(async () => ({ uid: 'sole-owner', email: 'owner@example.org', email_verified: true }));
    const db = fake.admin.firestore();
    fake.admin.firestore = () => db;
    db.runTransaction = async (fn) => {
        const writes = [];
        const result = await fn({ get: (ref) => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)), delete: (ref) => writes.push(() => ref.delete()) });
        for (const write of writes) await write();
        return result;
    };
    _setAdminModule(fake.admin);
    drain.release = null; drain.started = 0; drain.finished = 0; drain.args = null; drain.fail = false; background = [];
});
afterEach(() => {
    delete globalThis[CTX]; _setAdminModule(null);
    for (const key of keys) if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
});

describe('a vault save does not wait for the statement queue', () => {
    it('with a background window: answers at once (the drain has started and is NOT finished), and the platform is told to keep it alive', async () => {
        globalThis[CTX] = { get: () => ({ waitUntil: (p) => background.push(p) }) };
        const result = await put();
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ok: true, saved: true, queued: true });
        expect(drain.started).toBe(1); expect(drain.finished).toBe(0);
        expect(background).toHaveLength(1);
        expect(drain.args.budgetMs).toBeLessThanOrEqual(30000);          // room to finish inside the platform's sixty seconds
        drain.release(); await Promise.all(background);
        expect(drain.finished).toBe(1);
    });
    it('the vault is saved BEFORE the drain begins, so a drain that is killed loses nothing', async () => {
        globalThis[CTX] = { get: () => ({ waitUntil: (p) => background.push(p) }) };
        await put();
        const db = fake.admin.firestore();
        expect((await db.collection('wf-statement-vault').doc('sole-owner').get()).exists).toBe(true);
        drain.release(); await Promise.all(background);
    });
    it('a drain that throws never turns a saved vault into an error — in the background or when waited for', async () => {
        drain.fail = true;
        globalThis[CTX] = { get: () => ({ waitUntil: (p) => background.push(p) }) };
        const a = await put();
        expect(a.status).toBe(200); expect(a.body.saved).toBe(true);
        await Promise.all(background);                                   // the background promise is already handled: it must not reject
        delete globalThis[CTX];
        const b = await put();
        expect(b.status).toBe(200); expect(b.body).toMatchObject({ saved: true, queued: false });
    });
    it('a chain that is already draining the queue is not competed with: the save answers, no second drain starts', async () => {
        globalThis[CTX] = { get: () => ({ waitUntil: (p) => background.push(p) }) };
        const db = fake.admin.firestore();
        await db.collection('wf-mail').doc((await import('../gmail-link.mjs')).userKeyFor('owner@example.org')).set({ chain: { id: 'c1', depth: 3, until: Date.now() + 60000, at: Date.now() } }, { merge: true });
        const result = await put();
        expect(result.body).toMatchObject({ saved: true, queued: true });
        await Promise.all(background);
        expect(drain.started).toBe(0);
    });
    it('with no background window (local, tests) the caller waits for the drain, as before', async () => {
        const promise = put();
        await vi.waitFor(() => expect(drain.started).toBe(1));
        let settled = false; promise.then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);                                     // still waiting for the drain
        drain.release();
        const result = await promise;
        expect(result.body).toMatchObject({ saved: true, queued: true });
    });
});
