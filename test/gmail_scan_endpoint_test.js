/* =============================================================================
 * test/gmail_scan_endpoint_test.js — /api/gmail-scan, executed
 * -----------------------------------------------------------------------------
 * The scan writes into wf-mail/{userKey}/items — the SAME collection the Pub/Sub
 * push writes into, with the same item key and the same parts-then-manifest
 * order. That is the whole design: the device pipeline is reused rather than
 * duplicated, so a backfilled statement and a pushed one are indistinguishable
 * by the time anything reads them.
 *
 * These run the handler against the in-memory Admin SDK and a stubbed Gmail,
 * with the real network hard-blocked.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com';
const KEY = 'owner_example_com';
const TOKEN = '1//0g' + 'A'.repeat(40);
const NOW = Date.parse('2026-08-28T10:00:00Z');

const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' };

let calls;

/** A bank message the ingest module will accept: allowlisted sender, DKIM held. */
function bankMessage(id, { attachmentId = `att-${id}`, filename = 'statement.pdf', size = 2048 } = {}) {
    return {
        id,
        internalDate: String(NOW - 86400000),
        payload: {
            headers: [
                { name: 'From', value: 'HNB Statements <no-reply@hnb.lk>' },
                { name: 'Subject', value: 'Your monthly statement' },
                { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@hnb.lk' },
            ],
            parts: [{ filename, mimeType: 'application/pdf', body: { attachmentId, size } }],
        },
    };
}

/** Not a bank — the allowlist must refuse it. */
function junkMessage(id) {
    return {
        id,
        internalDate: String(NOW),
        payload: {
            headers: [
                { name: 'From', value: 'Deals <offers@shopping.example>' },
                { name: 'Subject', value: 'SALE' },
                { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@shopping.example' },
            ],
            parts: [{ filename: 'flyer.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a9', size: 100 } }],
        },
    };
}

function stubGmail({ messages = [], byId = {}, nextPageToken, tokenFails, listStatus, big = false } = {}) {
    return async (url, init) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('oauth2.googleapis.com/token')) {
            if (tokenFails) return { ok: false, status: 400, async json() { return {}; }, async text() { return 'invalid_grant'; } };
            return { ok: true, status: 200, async json() { return { access_token: 'ya29.access' }; } };
        }
        if (u.includes('/messages?')) {
            if (listStatus) return { ok: false, status: listStatus, async json() { return {}; }, async text() { return 'nope'; } };
            return { ok: true, status: 200, async json() { return { messages: messages.map((id) => ({ id })), nextPageToken }; } };
        }
        const att = /\/messages\/([^/?]+)\/attachments\/([^/?]+)/.exec(u);
        if (att) {
            const data = big ? 'JVBERi0xLjQK' + 'QQ'.repeat(600000) : 'JVBERi0xLjQK' + 'QQ'.repeat(40);
            return { ok: true, status: 200, async json() { return { data }; } };
        }
        const one = /\/messages\/([^/?]+)\?/.exec(u);
        if (one) {
            const m = byId[decodeURIComponent(one[1])];
            if (!m) return { ok: false, status: 404, async json() { return {}; } };
            return { ok: true, status: 200, async json() { return m; } };
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
        return { email: OWNER, email_verified: true, uid: 'u1' };
    });
    globalThis.fetch = async (i) => { throw new Error(`network blocked in tests: ${String(i)}`); };
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
        end(o) { seen.status = res.statusCode; try { seen.body = JSON.parse(o); } catch (_) { seen.body = o; } seen.ended = true; return res; },
    };
    return { res, seen };
}

async function call({ method = 'POST', token = 'good-token', body = {}, gmail = {} } = {}) {
    const { default: handler } = await import('../gmail-scan.js');
    const { res, seen } = mkRes();
    await handler(
        { method, url: '/api/gmail-scan', headers: token ? { authorization: `Bearer ${token}` } : {}, body },
        res,
        { env: ENV, fetchImpl: stubGmail(gmail) },
    );
    return seen;
}

function connect(extra = {}) {
    fake.docs.set(`wf-mail/${KEY}`, { refresh_token: TOKEN, email: OWNER, ...extra });
}

const WINDOW = { months: 6, index: 0, now: NOW };

describe('the scan finds and stores what is already in the mailbox', () => {
    it('stores a bank statement under the push pipeline’s own item key', async () => {
        connect();
        const seen = await call({ body: WINDOW, gmail: { messages: ['m1'], byId: { m1: bankMessage('m1') } } });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, statements: 1 });

        const { itemKey } = await import('../wealthflow-mail-ingest.mjs');
        const key = itemKey('m1', 'att-m1');
        expect(fake.docs.has(`wf-mail/${KEY}/items/${key}`), 'the manifest is not where the device looks').toBe(true);
    });

    it('a small statement is stored inline, with no parts', async () => {
        /* planWrite keeps anything under SINGLE_MAX in the manifest itself.
         * Asserting parts unconditionally would be asserting the wrong shape —
         * and passing only because the fixture happened to be big. */
        connect();
        await call({ body: WINDOW, gmail: { messages: ['m1'], byId: { m1: bankMessage('m1') } } });
        const manifest = [...fake.docs.entries()].find(([k]) => /\/items\/[^/]+$/.test(k))[1];
        expect(manifest.parts).toBe(0);
        expect(typeof manifest.d).toBe('string');
        expect(manifest.d.length).toBeGreaterThan(0);
    });

    it('a CHUNKED statement writes every part BEFORE the manifest', async () => {
        /* The manifest's presence is what tells the device every part landed.
         * Written first, a half-finished upload reads as a whole statement
         * with pages missing. */
        connect();
        await call({ body: WINDOW, gmail: { messages: ['m1'], byId: { m1: bankMessage('m1') }, big: true } });

        const manifestAt = fake.order.findIndex((p) => /\/items\/[^/]+$/.test(p));
        const partAts = fake.order.map((p, i) => (p.includes('/parts/') ? i : -1)).filter((i) => i >= 0);
        expect(partAts.length, 'nothing was chunked — the fixture is not large enough').toBeGreaterThan(1);
        expect(manifestAt).toBeGreaterThan(Math.max(...partAts));

        const manifest = fake.docs.get(fake.order[manifestAt]);
        expect(manifest.parts).toBe(partAts.length);
        expect(manifest.d, 'a chunked manifest must not also carry the data').toBeUndefined();
    });

    it('marks what it stored as backfilled', async () => {
        /* So a statement that arrived by deep scan can be told from one the
         * push delivered, without changing how either is processed. */
        connect();
        await call({ body: WINDOW, gmail: { messages: ['m1'], byId: { m1: bankMessage('m1') } } });
        const manifest = [...fake.docs.entries()].find(([k]) => /\/items\/[^/]+$/.test(k))[1];
        expect(manifest.backfilled).toBe(true);
    });

    it('refuses a sender that is not on the allowlist', async () => {
        connect();
        const seen = await call({ body: WINDOW, gmail: { messages: ['j1'], byId: { j1: junkMessage('j1') } } });
        expect(seen.body.statements).toBe(0);
        expect([...fake.docs.keys()].some((k) => k.includes('/items/'))).toBe(false);
    });

    it('counts messages seen separately from statements stored', async () => {
        connect();
        const seen = await call({
            body: WINDOW,
            gmail: { messages: ['m1', 'j1'], byId: { m1: bankMessage('m1'), j1: junkMessage('j1') } },
        });
        expect(seen.body.ids.length).toBe(2);
        expect(seen.body.statements).toBe(1);
    });

    it('a rescan stores nothing twice', async () => {
        /* The item key is (messageId, attachmentId), so a second pass addresses
         * the same document. That is what makes "run it again" a safe answer to
         * any interruption. */
        connect();
        const g = { messages: ['m1'], byId: { m1: bankMessage('m1') } };
        await call({ body: WINDOW, gmail: g });
        const after = fake.docs.size;
        const second = await call({ body: WINDOW, gmail: g });
        expect(second.body.statements).toBe(0);
        expect(fake.docs.size).toBe(after);
    });

    it('does not re-download an attachment it already has', async () => {
        connect();
        const g = { messages: ['m1'], byId: { m1: bankMessage('m1') } };
        await call({ body: WINDOW, gmail: g });
        calls = [];
        await call({ body: WINDOW, gmail: g });
        expect(calls.some((c) => c.url.includes('/attachments/'))).toBe(false);
    });

    it('hands back the page token so the cursor can advance', async () => {
        connect();
        const seen = await call({ body: WINDOW, gmail: { messages: ['m1'], byId: { m1: bankMessage('m1') }, nextPageToken: 'p2' } });
        expect(seen.body.pageToken).toBe('p2');
    });

    it('searches the window it was asked for, and says which', async () => {
        connect();
        const seen = await call({ body: { months: 12, index: 3, now: NOW }, gmail: { messages: [] } });
        expect(seen.body.window.label).toBe('2026-05');
        const list = calls.find((c) => c.url.includes('/messages?'));
        expect(decodeURIComponent(list.url)).toContain('after:2026/05/01');
        expect(decodeURIComponent(list.url)).toContain('from:hnb.lk');
    });
});

describe('what it refuses', () => {
    it('a window outside the plan is 400, and Gmail is never called', async () => {
        connect();
        const seen = await call({ body: { months: 3, index: 99, now: NOW } });
        expect(seen.status).toBe(400);
        expect(calls.length).toBe(0);
    });

    it('a free-text query is not a thing this endpoint accepts', async () => {
        /* This holds a credential that can read an entire mailbox. A query
         * parameter would make it a general mail-search proxy. */
        connect();
        const seen = await call({ body: { ...WINDOW, query: 'has:attachment', q: 'from:anyone' }, gmail: { messages: [] } });
        expect(seen.status).toBe(200);
        const list = calls.find((c) => c.url.includes('/messages?'));
        expect(decodeURIComponent(list.url)).not.toContain('from:anyone');
        expect(decodeURIComponent(list.url)).toContain('from:hnb.lk');
    });

    it('no connected mailbox is 409, not a crash', async () => {
        const seen = await call({ body: WINDOW });
        expect(seen.status).toBe(409);
        expect(calls.length).toBe(0);
    });

    it('GET is refused — this one only ever writes', async () => {
        const seen = await call({ method: 'GET', body: WINDOW });
        expect(seen.status).toBe(405);
        expect(fake.ops.length).toBe(0);
    });

    it('no credential is 401 and reads nothing', async () => {
        connect();
        const seen = await call({ token: '', body: WINDOW });
        expect(seen.status).toBe(401);
        expect(calls.length).toBe(0);
    });

    it('an unverified address is refused', async () => {
        connect();
        fake.setVerifier(async () => ({ email: OWNER, email_verified: false }));
        const seen = await call({ body: WINDOW });
        expect(seen.status).toBe(403);
        expect(calls.length).toBe(0);
    });

    it('scans the caller’s own mailbox and no other', async () => {
        connect();
        fake.docs.set('wf-mail/someone_else_com', { refresh_token: 'z'.repeat(40) });
        await call({ body: WINDOW, gmail: { messages: ['m1'], byId: { m1: bankMessage('m1') } } });
        expect([...fake.docs.keys()].filter((k) => k.startsWith('wf-mail/someone_else_com/'))).toEqual([]);
    });

    it('a revoked token is reported as a reconnect, without echoing it', async () => {
        connect();
        const seen = await call({ body: WINDOW, gmail: { tokenFails: true } });
        expect(seen.status).toBe(502);
        expect(JSON.stringify(seen.body)).not.toContain(TOKEN);
    });

    it('a failed Gmail search is 502 rather than a silent empty page', async () => {
        /* An empty page would advance the cursor past a month that was never
         * read, and the statements in it would never be found again. */
        connect();
        const seen = await call({ body: WINDOW, gmail: { listStatus: 403 } });
        expect(seen.status).toBe(502);
        expect(seen.body.ok).toBe(false);
    });

    it('the refresh token never appears in any response', async () => {
        connect();
        for (const gmail of [{ messages: ['m1'], byId: { m1: bankMessage('m1') } }, { tokenFails: true }, { listStatus: 500 }]) {
            const seen = await call({ body: WINDOW, gmail });
            expect(JSON.stringify(seen.body)).not.toContain(TOKEN.slice(0, 12));
        }
    });

    it('no access token reaches a URL, where it would land in a log', async () => {
        connect();
        await call({ body: WINDOW, gmail: { messages: ['m1'], byId: { m1: bankMessage('m1') } } });
        for (const c of calls) expect(c.url).not.toContain('ya29.access');
    });
});

describe('the router will still treat this as a Node handler', () => {
    it('takes at least two parameters', async () => {
        /* api/router.js routes by arity: isWebHandler(fn) { return fn.length < 2 }. */
        const { default: handler } = await import('../gmail-scan.js');
        expect(handler.length).toBeGreaterThanOrEqual(2);
    });

    it('is registered in the router', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve(import.meta.dirname, '../api/router.js'), 'utf8');
        expect(src).toContain("'gmail-scan': () => import('../gmail-scan.js')");
    });

    it('every path ends the response', async () => {
        connect();
        for (const body of [WINDOW, { months: 3, index: 99, now: NOW }, {}]) {
            const seen = await call({ body, gmail: { messages: [] } });
            expect(seen.ended, JSON.stringify(body)).toBe(true);
        }
    });
});
