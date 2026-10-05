/* =============================================================================
 * test/tenant_portal_handler_test.js — /api/tenant-portal, end to end through the HTTP skin
 * -----------------------------------------------------------------------------
 * The whole journey a tenant takes (request a code, read it from the text, verify, read the
 * statement, sign out) with the real handler, the real rules and an in-memory database, and the
 * checks a hostile caller would meet at the door: method, content type, origin, size, cache headers,
 * and that nothing sensitive reaches a log.
 * ===========================================================================*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handlePortal, sameSite, readBody } from '../tenant-portal.js';
import { portalSecret } from '../tenant-links.mjs';
import { LIMITS } from '../tenant-portal.mjs';
import { makeDb, seedTenant, gateway, codeIn, codes, SECRET, NIC, T0 } from './helpers/tenant-fixture.js';

const ENV = { TENANT_PORTAL_SECRET: Buffer.from(SECRET).toString('hex').repeat(2) };
const HANDLER_SECRET = portalSecret(ENV);                   // what the handler derives from the environment
const seed = (ctx, over = {}) => seedTenant(ctx.fs, ctx.db, { secret: HANDLER_SECRET, ...over });

function deps(over = {}) {
    const ctx = over.ctx;
    const gw = over.gw || gateway();
    let clock = T0;
    return {
        gw,
        advance: (ms) => { clock += ms; },
        d: {
            client: () => gw,
            getAdminDb: async () => (over.noDb ? { db: null, reason: 'FIREBASE_SERVICE_ACCOUNT is not set' } : { db: ctx.db }),
            env: over.env || ENV,
            now: () => clock,
            randomInt: codes('246810'),
            randomBytes: undefined,
            pad: async () => {},
        },
    };
}

function call(d, { method = 'POST', headers = {}, body, cookie } = {}) {
    const req = {
        method, url: '/api/tenant-portal',
        headers: { 'content-type': 'application/json', host: 'wealthflow-personal.vercel.app', origin: 'https://wealthflow-personal.vercel.app', 'sec-fetch-site': 'same-origin', 'x-real-ip': '1.2.3.4', ...(cookie ? { cookie } : {}), ...headers },
        body,
    };
    const out = { headers: {}, statusCode: 0, text: '' };
    const res = { setHeader: (k, v) => { out.headers[String(k).toLowerCase()] = v; }, end: (t) => { out.text = t; }, set statusCode(v) { out.statusCode = v; }, get statusCode() { return out.statusCode; } };
    return handlePortal(req, res, d).then(() => ({ status: out.statusCode, headers: out.headers, json: out.text ? JSON.parse(out.text) : null, raw: out.text }));
}

afterEach(() => vi.restoreAllMocks());

describe('the whole journey', () => {
    it('request, read the text, verify, read the statement, sign out', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const { d, gw, advance } = deps({ ctx });

        const asked = await call(d, { body: { action: 'request', token, nic: '853400937v' } });
        expect(asked.status).toBe(200);
        expect(asked.json).toMatchObject({ ok: true, resendAfterSec: 60, expiresInSec: 180 });
        expect(gw.sent).toHaveLength(1);
        const code = codeIn(gw.sent[0].message);
        expect(code).toBe('246810');

        advance(20000);
        const wrong = await call(d, { body: { action: 'verify', token, nic: NIC, code: '000000' } });
        expect(wrong.status).toBe(401);
        expect(wrong.headers['set-cookie']).toBeUndefined();

        const verified = await call(d, { body: { action: 'verify', token, nic: NIC, code } });
        expect(verified.status).toBe(200);
        const cookie = String(verified.headers['set-cookie']).split(';')[0];
        expect(String(verified.headers['set-cookie'])).toMatch(/HttpOnly; Secure; SameSite=Strict; Path=\/api\/tenant-portal; Max-Age=1200$/);
        expect(JSON.stringify(verified.json)).not.toContain(cookie.split('=')[1]);          // the session id is only ever in the cookie

        const none = await call(d, { body: { action: 'statement', token } });
        expect(none.status).toBe(401);
        expect(String(none.headers['set-cookie'])).toContain('Max-Age=0');

        const st = await call(d, { body: { action: 'statement', token }, cookie });
        expect(st.status).toBe(200);
        expect(st.json.ok).toBe(true);
        expect(st.json.statement.groups.map((g) => g.kind)).toEqual(['investment', 'loan']);
        expect(st.json.expiresAt).toBeGreaterThan(T0);
        expect(st.raw).not.toMatch(/PRIVATE|853400937|198534000937|771234567/);

        // the session ends by the clock
        advance(21 * 60e3);
        expect((await call(d, { body: { action: 'statement', token }, cookie })).status).toBe(401);
    });

    it('sign-out ends the session at once, on the server', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const { d, gw } = deps({ ctx });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        const v = await call(d, { body: { action: 'verify', token, nic: NIC, code: codeIn(gw.sent[0].message) } });
        const cookie = String(v.headers['set-cookie']).split(';')[0];
        expect((await call(d, { body: { action: 'statement', token }, cookie })).status).toBe(200);
        const out = await call(d, { body: { action: 'logout', token }, cookie });
        expect(out.status).toBe(200);
        expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
        expect((await call(d, { body: { action: 'statement', token }, cookie })).status).toBe(401);
    });

    it('a session belongs to its own link: another link\'s page can neither read it nor end it', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const other = await seed(ctx, { uid: 'ownerB' });
        const { d, gw } = deps({ ctx });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        const v = await call(d, { body: { action: 'verify', token, nic: NIC, code: codeIn(gw.sent[0].message) } });
        const cookie = String(v.headers['set-cookie']).split(';')[0];
        const read = await call(d, { body: { action: 'statement', token: other }, cookie });
        expect(read.status).toBe(401);
        expect(read.headers['set-cookie']).toBeUndefined();                              // and it does not sign the right page out
        const end = await call(d, { body: { action: 'logout', token: other }, cookie });
        expect(end.status).toBe(401);
        expect((await call(d, { body: { action: 'statement', token }, cookie })).status).toBe(200);
        expect((await call(d, { body: { action: 'statement' }, cookie })).status).toBe(401);       // no link named, no statement
    });

    it('the NIC and the code are never logged, on success or on failure', async () => {
        const logs = [];
        for (const k of ['log', 'info', 'warn', 'error']) vi.spyOn(console, k).mockImplementation((...a) => { logs.push(a.join(' ')); });
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const { d, gw } = deps({ ctx, gw: gateway(() => ({ ok: false, kind: 'credit', message: 'insufficient credit', retryable: true })) });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        await call(d, { body: { action: 'verify', token, nic: NIC, code: '246810' } });
        await call(d, { body: { action: 'verify', token, nic: NIC, code: '13' } });
        const bad = deps({ ctx, noDb: true }); await call(bad.d, { body: { action: 'request', token, nic: NIC } });
        const boom = deps({ ctx }); boom.d.getAdminDb = async () => { throw new Error(`explode with ${NIC} and 246810`); };
        const e = await call(boom.d, { body: { action: 'request', token, nic: NIC } });
        expect(e.status).toBe(500);
        expect(e.json).toEqual({ ok: false, error: 'Something went wrong. Please try again.' });        // the error text never reaches the caller
        void gw;
        const text = logs.join('\n');
        expect(text).not.toContain('246810');
        expect(text).not.toContain('853400937');
        expect(text).not.toContain('198534000937');
        expect(text).not.toContain(token);
    });
});

describe('the door', () => {
    const base = async () => { const ctx = {}; Object.assign(ctx, makeDb()); const token = await seed(ctx); return { ctx, token, ...deps({ ctx }) }; };

    it('is POST only', async () => {
        const { d } = await base();
        for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
            const out = await call(d, { method, body: { action: 'statement' } });
            expect(out.status, method).toBe(405);
            expect(out.headers.allow).toBe('POST');
        }
    });

    it('wants JSON, and a small JSON object', async () => {
        const { d, token } = await base();
        expect((await call(d, { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ action: 'request', token, nic: NIC }) })).status).toBe(400);
        expect((await call(d, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: { action: 'request' } })).status).toBe(400);
        expect((await call(d, { headers: { 'content-type': '' }, body: { action: 'request' } })).status).toBe(400);
        for (const body of [undefined, null, 'not json', '[]', [], 5, 'x'.repeat(5000), { action: 'request', pad: 'x'.repeat(5000) }]) expect((await call(d, { body })).status, String(body).slice(0, 20)).toBe(400);
        expect((await call(d, { body: { action: 'nope' } })).status).toBe(400);
        expect((await call(d, { body: {} })).status).toBe(400);
        expect((await call(d, { headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ action: 'statement' }) })).status).toBe(401);   // a string body is parsed
    });

    it('is for this site\'s own pages only', async () => {
        const { d, token } = await base();
        const body = { action: 'request', token, nic: NIC };
        expect((await call(d, { body, headers: { origin: 'https://evil.example' } })).status).toBe(403);
        expect((await call(d, { body, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
        expect((await call(d, { body, headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
        expect((await call(d, { body, headers: { origin: 'null' } })).status).toBe(403);
        expect((await call(d, { body, headers: { origin: 'https://wealthflow-personal.vercel.app.evil.example' } })).status).toBe(403);
        expect((await call(d, { body })).status).toBe(200);
        expect(sameSite({ headers: { host: 'a.test' } })).toBe(true);                       // not a browser: no cookie to protect
        expect(sameSite({ headers: { host: 'a.test', origin: 'https://a.test' } })).toBe(true);
        expect(sameSite({ headers: { host: 'a.test', origin: 'https://b.test' } })).toBe(false);
        expect(readBody({ headers: { 'content-type': 'application/json' }, body: { a: 1 } })).toEqual({ a: 1 });
    });

    it('never answers cross-origin, is never cached, indexed or framed', async () => {
        const { d, token } = await base();
        for (const out of [await call(d, { body: { action: 'request', token, nic: NIC } }), await call(d, { body: { action: 'statement', token } }), await call(d, { method: 'GET' }), await call(d, { body: { action: 'request', nic: NIC, token: 'bad' } })]) {
            expect(out.headers['cache-control']).toBe('no-store, max-age=0');
            expect(out.headers['content-type']).toBe('application/json; charset=utf-8');
            expect(out.headers['x-robots-tag']).toBe('noindex, nofollow');
            expect(out.headers['x-content-type-options']).toBe('nosniff');
            expect(out.headers['referrer-policy']).toBe('no-referrer');
            expect(Object.keys(out.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
        }
    });

    it('says how long to wait when it says no', async () => {
        const { d } = await base();
        let last;
        for (let i = 0; i <= LIMITS.requestsPerIpHour; i += 1) last = await call(d, { body: { action: 'request', token: 'zzzzzzzzzzzzzzzz', nic: NIC } });
        expect(last.status).toBe(429);
        expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('is unavailable, not broken, when the database or the secret is missing', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const noDb = deps({ ctx, noDb: true });
        expect((await call(noDb.d, { body: { action: 'request', token: 'zzzzzzzzzzzzzzzz', nic: NIC } })).status).toBe(503);
        const noSecret = deps({ ctx, env: {} });
        const out = await call(noSecret.d, { body: { action: 'request', token: 'zzzzzzzzzzzzzzzz', nic: NIC } });
        expect(out.status).toBe(503);
        expect(out.json.error).not.toMatch(/secret|OTP|TENANT/i);
    });

    it('limits one address\'s reads of the statement too', async () => {
        const { d, token } = await base();
        let last;
        for (let i = 0; i <= LIMITS.statementsPerIpHour; i += 1) last = await call(d, { body: { action: 'statement', token } });
        expect(last.status).toBe(429);
    });
});
