import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

/* THE ENDPOINTS THAT SPEND THE MAILBOX'S TOKEN, RUN: a sign-in Google has turned down is marked once, shown on the card, not asked about again for hours, and mended by connecting again.
 * (The decisions are in gmail_auth_state_test.js; this is the glue — the handlers against the in-memory Admin SDK, the real network blocked.) */

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com', KEY = 'owner_example_com', PATH = `wf-mail/${KEY}`;
const TOKEN = '1//0g' + 'A'.repeat(40), NEW_TOKEN = '1//0g' + 'B'.repeat(40);
const DAY = 86400000, HOUR = 3600e3;
const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'client-id', GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret', GCP_PROJECT_ID: 'wf-proj', PUB_SUB_TOPIC: 'statements', CRON_SECRET: 'cron-secret-value' };

let calls;
const stubFetch = (error = 'invalid_grant') => async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('oauth2.googleapis.com/token')) return { ok: false, status: 400, async json() { return error ? { error } : {}; } };
    throw new Error(`unexpected call: ${u}`);
};
const tokenCalls = () => calls.filter(u => u.includes('oauth2.googleapis.com/token')).length;

beforeEach(async () => {
    fake.reset(); calls = [];
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    fake.setVerifier(async t => { if (t !== 'good-token') throw new Error('invalid token'); return { email: OWNER, email_verified: true, uid: 'uid-1' }; });
    globalThis.fetch = async input => { throw new Error(`network blocked in tests: ${String(input)}`); };
});
afterEach(async () => {
    globalThis.fetch = realFetch;
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(null);
});

function mkRes() {
    const seen = { status: null, body: undefined };
    const res = { statusCode: 200, setHeader() { return res; }, end(o) { seen.status = res.statusCode; try { seen.body = o === undefined ? undefined : JSON.parse(o); } catch (_) { seen.body = o; } return res; } };
    return { res, seen };
}
async function link({ method = 'GET', body } = {}) {
    const { default: handler } = await import('../gmail-link.js');
    const { res, seen } = mkRes();
    await handler({ method, url: '/api/gmail-link', headers: { authorization: 'Bearer good-token' }, body }, res);
    return seen;
}
async function watch({ method = 'POST', error } = {}) {
    const { default: handler } = await import('../gmail-watch.js');
    const { res, seen } = mkRes();
    await handler({ method, url: '/api/gmail-watch', headers: { authorization: 'Bearer good-token' } }, res, { env: ENV, fetchImpl: stubFetch(error) });
    return seen;
}
async function renew({ error } = {}) {
    const { default: handler } = await import('../gmail-renew.js');
    const { res, seen } = mkRes();
    await handler({ method: 'GET', url: '/api/gmail-renew', headers: { authorization: 'Bearer cron-secret-value' } }, res, { env: ENV, fetchImpl: stubFetch(error) });
    return seen;
}
const connect = extra => fake.docs.set(PATH, { refresh_token: TOKEN, email: OWNER, linkedAt: Date.now(), watchExpiry: Date.now() + 0.5 * DAY, ...extra });

describe('the card is told', () => {
    it('a refused sign-in shows as needsReconnect — kind and time only, never the token or Google\'s words', async () => {
        connect({ gmailAuth: { kind: 'revoked', since: 1_800_000_000_000, lastAt: 1_800_000_000_000, attempts: 2, alertedAt: 5, code: 'invalid_grant', status: 400 } });
        const seen = await link();
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, connected: true, needsReconnect: true, authProblem: 'revoked', authProblemSince: 1_800_000_000_000 });
        expect(JSON.stringify(seen.body)).not.toMatch(new RegExp(`${TOKEN}|invalid_grant|attempts|alertedAt`));
    });
    it('a mailbox nobody has turned down says nothing of the kind', async () => {
        connect();
        expect((await link()).body).toMatchObject({ connected: true, needsReconnect: false });
    });
    it('connecting again clears the mark and the old watch failure, and the new token is the one kept', async () => {
        connect({ gmailAuth: { kind: 'revoked', since: 1, lastAt: 1, attempts: 3 }, renewError: 'Gmail refused the saved token. Disconnect and connect the mailbox again.', renewErrorAt: 5, historyId: '77' });
        const seen = await link({ method: 'POST', body: { refresh_token: NEW_TOKEN } });
        expect(seen.status).toBe(200);
        const doc = fake.docs.get(PATH);
        expect(doc).toMatchObject({ refresh_token: NEW_TOKEN, gmailAuth: null, renewError: '', historyId: '77' });   // the bookmark stays: nothing is imported twice
        expect((await link()).body).toMatchObject({ connected: true, needsReconnect: false });
    });
});

describe('the scheduled renewal', () => {
    it('marks a refused mailbox, and asks Google about it once however many days it runs on', async () => {
        connect();
        const first = await renew();
        expect(first.status).toBe(502);                                    // nothing was renewed: the run says so, as it always did
        expect(first.body.failures).toEqual({ 'token-refused': 1 });
        expect(fake.docs.get(PATH)).toMatchObject({ refresh_token: TOKEN, gmailAuth: { kind: 'revoked', attempts: 1 } });
        await renew(); await renew();
        expect(tokenCalls()).toBe(1);
    });
    it('after the back-off it asks again, and a token that works clears the mark', async () => {
        connect({ gmailAuth: { kind: 'revoked', since: Date.now() - 8 * HOUR, lastAt: Date.now() - 7 * HOUR, attempts: 1, alertedAt: 0 } });
        const { default: handler } = await import('../gmail-renew.js');
        const { res, seen } = mkRes();
        const f = async (url) => {
            const u = String(url); calls.push(u);
            if (u.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, async json() { return { access_token: 'ya29.access' }; } };
            return { ok: true, status: 200, async json() { return { historyId: '99', expiration: String(Date.now() + 7 * DAY) }; } };
        };
        await handler({ method: 'GET', url: '/api/gmail-renew', headers: { authorization: 'Bearer cron-secret-value' } }, res, { env: ENV, fetchImpl: f });
        expect(seen.status).toBe(200);
        expect(fake.docs.get(PATH).gmailAuth).toBe(null);
    });
});

describe('the watch, asked from the app', () => {
    it('a refused sign-in is answered as before (reconnect), and while it is marked Google is not asked again', async () => {
        connect();
        const first = await watch();
        expect(first.status).toBe(502);
        expect(first.body.error).toMatch(/Disconnect and connect the mailbox again/);
        const second = await watch();
        expect(second.body.error).toMatch(/Disconnect and connect the mailbox again/);
        expect(tokenCalls()).toBe(1);
    });
    it('a refused OAuth client is said to be the server\'s settings, not the owner\'s mailbox', async () => {
        connect();
        const seen = await watch({ error: 'invalid_client' });
        expect(seen.body.error).toMatch(/OAuth settings/);
        expect(seen.body.error).not.toMatch(/Disconnect and connect/);
    });
    it('Google not answering is not "reconnect": it says it will try again, and marks nothing', async () => {
        connect();
        const { default: handler } = await import('../gmail-watch.js');
        const { res, seen } = mkRes();
        await handler({ method: 'POST', url: '/api/gmail-watch', headers: { authorization: 'Bearer good-token' } }, res, { env: ENV, fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } }) });
        expect(seen.body).toMatchObject({ ok: false, retryable: true });
        expect(seen.body.error).toMatch(/did not answer/);
        expect(fake.docs.get(PATH).gmailAuth).toBeUndefined();
    });
});
