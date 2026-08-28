/* =============================================================================
 * test/gmail_watch_endpoint_test.js — /api/gmail-watch, executed
 * -----------------------------------------------------------------------------
 * The lesson from /api/gmail-link, applied on arrival rather than after a
 * production crash: this handler is RUN, against the in-memory Admin SDK and a
 * stubbed Gmail, with the real network hard-blocked. Reading a handler proves
 * what it says; running it proves what it does.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com';
const KEY = 'owner_example_com';
const TOKEN = '1//0g' + 'A'.repeat(40);
const DAY = 86400000;

const ENV = {
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GCP_PROJECT_ID: 'wf-proj',
    PUB_SUB_TOPIC: 'statements',
};

/** Every outbound call the handler made, so a credential can be looked for. */
let calls;

/** A Gmail + OAuth stand-in. `over` reshapes one leg at a time. */
function stubFetch(over = {}) {
    return async (url, init) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('oauth2.googleapis.com/token')) {
            if (over.tokenFails) return { ok: false, status: 400, async json() { return {}; }, async text() { return 'invalid_grant'; } };
            return { ok: true, status: 200, async json() { return { access_token: 'ya29.access' }; } };
        }
        if (u.includes('/users/me/watch')) {
            if (over.watchFails) {
                return {
                    ok: false, status: over.watchStatus || 403,
                    async json() { return {}; },
                    async text() { return over.watchError || 'User not authorized to perform this action.'; },
                };
            }
            if (over.watchHangs) return new Promise(() => {});
            return {
                ok: true, status: 200,
                async json() { return { historyId: '4242', expiration: String(Date.now() + 7 * DAY) }; },
            };
        }
        throw new Error(`unexpected call: ${u}`);
    };
}

beforeEach(async () => {
    fake.reset();
    calls = [];
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    fake.setVerifier(async (t) => {
        if (t !== 'good-token') throw new Error('invalid token');
        return { email: OWNER, email_verified: true, uid: 'uid-1' };
    });
    globalThis.fetch = async (input) => { throw new Error(`network blocked in tests: ${String(input)}`); };
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(null);
});

function mkRes() {
    const seen = { status: null, body: undefined, ended: false };
    const res = {
        statusCode: 200,
        setHeader() { return res; },
        end(o) {
            seen.status = res.statusCode;
            try { seen.body = JSON.parse(o); } catch (_) { seen.body = o; }
            seen.ended = true;
            return res;
        },
    };
    return { res, seen };
}

async function call({ method = 'GET', token = 'good-token', env = ENV, over = {} } = {}) {
    const { default: handler } = await import('../gmail-watch.js');
    const { res, seen } = mkRes();
    await handler(
        { method, url: '/api/gmail-watch', headers: token ? { authorization: `Bearer ${token}` } : {} },
        res,
        { env, fetchImpl: stubFetch(over) },
    );
    return seen;
}

/** A connected mailbox, optionally already watched. */
function connect(extra = {}) {
    fake.docs.set(`wf-mail/${KEY}`, { refresh_token: TOKEN, email: OWNER, linkedAt: Date.now(), ...extra });
}

describe('registering the watch', () => {
    it('calls Gmail and records the expiry', async () => {
        connect();
        const seen = await call({ method: 'POST' });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, watching: true, registered: true });

        const doc = fake.docs.get(`wf-mail/${KEY}`);
        expect(typeof doc.watchExpiry).toBe('number');
        expect(doc.watchTopic).toBe('projects/wf-proj/topics/statements');
        expect(typeof doc.watchedAt).toBe('number');
    });

    it('asks Gmail for the right topic, filtered to the inbox', async () => {
        connect();
        await call({ method: 'POST' });
        const watch = calls.find((c) => c.url.includes('/users/me/watch'));
        expect(watch, 'users.watch was never called').toBeTruthy();
        expect(JSON.parse(watch.init.body)).toEqual({
            topicName: 'projects/wf-proj/topics/statements',
            labelIds: ['INBOX'],
            labelFilterBehavior: 'INCLUDE',
        });
    });

    it('mints the access token from the stored refresh token', async () => {
        connect();
        await call({ method: 'POST' });
        const tok = calls.find((c) => c.url.includes('oauth2.googleapis.com/token'));
        expect(tok).toBeTruthy();
        expect(tok.init.body).toContain('grant_type=refresh_token');
    });

    it('the refresh token never appears in any response', async () => {
        connect();
        for (const over of [{}, { tokenFails: true }, { watchFails: true }]) {
            const seen = await call({ method: 'POST', over });
            expect(JSON.stringify(seen.body)).not.toContain(TOKEN);
            expect(JSON.stringify(seen.body)).not.toContain(TOKEN.slice(0, 12));
        }
    });

    it('does not put the access token in a URL, where it would reach a log', async () => {
        connect();
        await call({ method: 'POST' });
        for (const c of calls) expect(c.url).not.toContain('ya29.access');
    });

    it('leaves historyId alone on a first registration', async () => {
        /* The backfill depends on it: gmail-link.mjs omits historyId so the
         * first push reads the whole mailbox. */
        connect();
        await call({ method: 'POST' });
        expect(fake.docs.get(`wf-mail/${KEY}`).historyId).toBeUndefined();
    });

    it('advances historyId when the pipeline has already been running', async () => {
        connect({ historyId: '11' });
        await call({ method: 'POST' });
        expect(fake.docs.get(`wf-mail/${KEY}`).historyId).toBe('4242');
    });
});

describe('what it reports without changing anything', () => {
    it('GET says there is no watch on a freshly connected mailbox', async () => {
        connect();
        const seen = await call({ method: 'GET' });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, watching: false, connected: true, needsRenewal: true });
        expect(calls.length, 'GET must not call Gmail').toBe(0);
    });

    it('GET reports a live watch without renewing it', async () => {
        connect({ watchExpiry: Date.now() + 7 * DAY });
        const seen = await call({ method: 'GET' });
        expect(seen.body).toMatchObject({ watching: true, needsRenewal: false });
        expect(calls.length).toBe(0);
    });

    it('GET on an unconnected mailbox is honest rather than an error', async () => {
        const seen = await call({ method: 'GET' });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, connected: false, watching: false });
    });
});

describe('the failures that would otherwise be silence', () => {
    it('POST without a connected mailbox says exactly that', async () => {
        const seen = await call({ method: 'POST' });
        expect(seen.status).toBe(409);
        expect(seen.body.error).toContain('no mailbox is connected');
        expect(calls.length).toBe(0);
    });

    it('an unconfigured topic names the variables instead of failing vaguely', async () => {
        connect();
        const seen = await call({ method: 'POST', env: { ...ENV, PUB_SUB_TOPIC: '' } });
        expect(seen.status).toBe(503);
        expect(seen.body.missing).toContain('PUB_SUB_TOPIC');
        expect(calls.length, 'nothing should be called with no topic to watch').toBe(0);
    });

    it('a revoked refresh token is reported as a reconnect, not a crash', async () => {
        connect();
        const seen = await call({ method: 'POST', over: { tokenFails: true } });
        expect(seen.status).toBe(502);
        expect(seen.body.error).toContain('connect the mailbox again');
    });

    it("Gmail's own refusal is passed through, because nobody guesses it", async () => {
        /* The common one is that the topic exists but
         * gmail-api-push@system.gserviceaccount.com has no Publish role on it. */
        connect();
        const seen = await call({
            method: 'POST',
            over: { watchFails: true, watchStatus: 403, watchError: 'Error sending test message to Cloud PubSub projects/wf-proj/topics/statements' },
        });
        expect(seen.status).toBe(502);
        expect(seen.body.error).toContain('403');
        expect(seen.body.detail).toContain('Cloud PubSub');
    });

    it('a failed watch is NOT recorded as a watch', async () => {
        connect();
        await call({ method: 'POST', over: { watchFails: true } });
        expect(fake.docs.get(`wf-mail/${KEY}`).watchExpiry).toBeUndefined();
    });

    it('a write failure after a successful watch is reported, not swallowed', async () => {
        /* Otherwise there is a live watch that nothing knows to renew, and the
         * pipeline stops in seven days with no record of why. */
        connect();
        fake.setFailOn((p, op) => (op === 'set' ? new Error('firestore unavailable') : null));
        const seen = await call({ method: 'POST' });
        expect(seen.status).toBe(503);
        expect(seen.body.ok).toBe(false);
    });
});

describe('who may register a watch', () => {
    it('no credential is 401 and calls nothing', async () => {
        connect();
        const seen = await call({ method: 'POST', token: '' });
        expect(seen.status).toBe(401);
        expect(calls.length).toBe(0);
    });

    it('a forged token is 401 and calls nothing', async () => {
        connect();
        const seen = await call({ method: 'POST', token: 'forged' });
        expect(seen.status).toBe(401);
        expect(calls.length).toBe(0);
    });

    it('an unverified address is refused', async () => {
        connect();
        fake.setVerifier(async () => ({ email: OWNER, email_verified: false }));
        const seen = await call({ method: 'POST' });
        expect(seen.status).toBe(403);
        expect(calls.length).toBe(0);
    });

    it('the watch is registered on the caller’s own document and no other', async () => {
        connect();
        fake.docs.set('wf-mail/someone_else_com', { refresh_token: 'z'.repeat(40) });
        await call({ method: 'POST' });
        expect(fake.docs.get('wf-mail/someone_else_com').watchExpiry).toBeUndefined();
        expect(fake.docs.get(`wf-mail/${KEY}`).watchExpiry).toBeTruthy();
    });

    it('an unsupported method is refused before anything is read', async () => {
        const seen = await call({ method: 'DELETE' });
        expect(seen.status).toBe(405);
        expect(fake.ops.length).toBe(0);
    });
});

describe('every path ends the response', () => {
    it('never leaves a request hanging', async () => {
        connect();
        for (const method of ['GET', 'POST', 'PUT']) {
            const seen = await call({ method });
            expect(seen.ended, `${method} never ended the response`).toBe(true);
        }
    });
});

describe('the router will still treat this as a Node handler', () => {
    it('takes at least two parameters', async () => {
        /* api/router.js routes by ARITY: `isWebHandler(fn) { return fn.length < 2 }`.
         * The third parameter here is a test seam — it lets the suite inject env
         * and fetch without touching process.env or the network. Dropping req or
         * res to "simplify" the signature would silently reclassify the endpoint
         * as a Web handler and hand it a Request object it cannot read. */
        const { default: handler } = await import('../gmail-watch.js');
        expect(handler.length).toBeGreaterThanOrEqual(2);
    });

    it('is registered in the router', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve(import.meta.dirname, '../api/router.js'), 'utf8');
        /* An endpoint that exists and is not routed is the defect family this
         * repository keeps hitting: built, tested, reachable from nothing. */
        expect(src).toContain("'gmail-watch': () => import('../gmail-watch.js')");
    });

    it('falls back to process.env and the real fetch when the router calls it with two arguments', async () => {
        /* The production call is fn(req, res) — no third argument. If the
         * defaults were missing, every real request would throw on `deps.env`. */
        const { default: handler } = await import('../gmail-watch.js');
        const { res, seen } = mkRes();
        await handler({ method: 'GET', headers: {} }, res);
        expect(seen.ended).toBe(true);
        expect(seen.status).toBe(401);   // no bearer token; it got that far without throwing
    });
});
