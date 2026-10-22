/* =============================================================================
 * test/tenant_portal_handler_test.js — /api/tenant-portal, end to end through the HTTP skin
 * -----------------------------------------------------------------------------
 * The whole journey a tenant takes (request a code, read it from the text, verify, read the
 * statement, sign out) with the real handler, the real rules and an in-memory database, and the
 * checks a hostile caller would meet at the door: method, content type, origin, size, cache headers,
 * and that nothing sensitive reaches a log.
 * ===========================================================================*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { handlePortal, sameSite, readBody, guardNote } from '../tenant-portal.js';
import { portalSecret } from '../tenant-links.mjs';
import { LIMITS } from '../tenant-portal.mjs';
import zlib from 'node:zlib';
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

function call(d, { method = 'POST', headers = {}, body, cookie, pre = {} } = {}) {
    const req = {
        method, url: '/api/tenant-portal',
        headers: { 'content-type': 'application/json', host: 'wealthflow-personal.vercel.app', origin: 'https://wealthflow-personal.vercel.app', 'sec-fetch-site': 'same-origin', 'x-real-ip': '1.2.3.4', ...(cookie ? { cookie } : {}), ...headers },
        body,
    };
    const out = { headers: {}, statusCode: 0, text: '' };
    for (const [k, v] of Object.entries(pre)) out.headers[k.toLowerCase()] = v;                // what an earlier layer (the API router) had already put on the response
    const res = { setHeader: (k, v) => { out.headers[String(k).toLowerCase()] = v; }, removeHeader: (k) => { delete out.headers[String(k).toLowerCase()]; }, end: (t) => { out.text = t; }, set statusCode(v) { out.statusCode = v; }, get statusCode() { return out.statusCode; } };
    // a PDF comes back as a Buffer, everything else as JSON text
    return handlePortal(req, res, d).then(() => ({ status: out.statusCode, headers: out.headers, json: out.text && !Buffer.isBuffer(out.text) ? JSON.parse(out.text) : null, file: Buffer.isBuffer(out.text) ? out.text : null, raw: out.text }));
}

afterEach(() => vi.restoreAllMocks());

describe('the text names the site it came from', () => {
    it('binds the code to the configured public host, and to nothing else', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const { d, gw } = deps({ ctx, env: { ...ENV, WEALTHFLOW_PUBLIC_ORIGIN: 'https://portal.example.lk' } });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        expect(gw.sent).toHaveLength(1);
        expect(gw.sent[0].message.split('\n').at(-1)).toBe('@portal.example.lk #246810');
        expect(gw.sent[0].message).not.toMatch(/https?:/);
    });
});

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
        expect(gw.sent[0].message.split('\n').at(-1)).toBe('@www.wealthflow.lk #246810');          // the line a phone reads to offer the code only to the real site

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
        expect(st.json.statement.holder).toEqual({ name: '', nic: '853400937V' });          // the person's own NIC, and only there
        expect(JSON.stringify({ ...st.json.statement, holder: null })).not.toMatch(/PRIVATE|853400937|198534000937|771234567/);

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
        expect(e.json).toEqual({ ok: false, error: 'Something went wrong. Please try again in a moment.' });        // the error text never reaches the caller
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

describe('the PDF', () => {
    async function signedIn(over = {}) {
        const ctx = {}; Object.assign(ctx, makeDb());
        const user = over.user;
        const token = await seed(ctx, user ? { user } : {});
        const { d, gw, advance } = deps({ ctx });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        const v = await call(d, { body: { action: 'verify', token, nic: NIC, code: codeIn(gw.sent[0].message) } });
        return { ctx, d, token, advance, cookie: String(v.headers['set-cookie']).split(';')[0] };
    }
    /** The text of every page of the file, read by the PDF engine's own decompressor. */
    const pageTexts = (file) => {
        const src = file.toString('latin1');
        const out = [];
        for (const m of src.matchAll(/stream\n([\s\S]*?)\nendstream/g)) out.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'));
        return out;
    };

    it('downloads the same statement as a file, to the person whose session it is', async () => {
        const { d, token, cookie } = await signedIn();
        const out = await call(d, { body: { action: 'pdf', token }, cookie });
        expect(out.status).toBe(200);
        expect(out.headers['content-type']).toBe('application/pdf');
        expect(out.headers['content-disposition']).toBe('attachment; filename="WealthFlow-statement-2026-10-05.pdf"');
        expect(out.headers['content-length']).toBe(String(out.file.length));
        expect(out.headers['cache-control']).toBe('no-store, max-age=0');
        expect(out.headers['x-content-type-options']).toBe('nosniff');
        expect(out.headers['x-robots-tag']).toMatch(/noindex/);
        expect(out.file.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
        expect(out.file.subarray(-6).toString('latin1')).toBe('%%EOF\n');
        const text = pageTexts(out.file).join('\n');
        expect(text).toContain('INV-');
        expect(text).toContain('DEB-');
        expect(text).toContain('500,000.00');
    });

    it('passes the language the page is read in to the PDF, and treats anything but "si" as English', async () => {
        const { d, token, cookie } = await signedIn();
        const seen = [];
        d.renderPdf = async (statement, opts) => { seen.push(opts.lang); return Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'); };
        for (const lang of ['si', 'en', 'ta', 'SI', '', undefined, null, 1, ['si'], { lang: 'si' }]) {
            const out = await call(d, { body: { action: 'pdf', token, lang }, cookie });
            expect(out.status).toBe(200);
        }
        expect(seen).toEqual(['si', 'en', 'en', 'en', 'en', 'en', 'en', 'en', 'en', 'en']);
    });

    it('is a file with no nickname, note, phone or record id in it, and their own NIC only in the holder block, whatever way the bytes are read', async () => {
        const { d, token, cookie } = await signedIn();
        const out = await call(d, { body: { action: 'pdf', token }, cookie });
        const everything = out.file.toString('latin1') + pageTexts(out.file).join('\n');
        expect(pageTexts(out.file).join('\n')).toContain('853400937V');                                // the holder block: their own NIC, shown back to them
        for (const leak of ['PRIVATE', 'Fixed deposit', '198534000937', '0771234567', '771234567', 'inv1', 'deb1']) expect(everything, leak).not.toContain(leak);
    });

    it('is refused without a live session, for another link\'s session, and after sign-out', async () => {
        const { d, token, cookie, ctx } = await signedIn();
        const none = await call(d, { body: { action: 'pdf', token } });
        expect(none.status).toBe(401);
        expect(none.file).toBeNull();
        expect(String(none.headers['set-cookie'])).toContain('Max-Age=0');
        const other = await seed(ctx, { uid: 'ownerB' });
        expect((await call(d, { body: { action: 'pdf', token: other }, cookie })).status).toBe(401);
        expect((await call(d, { body: { action: 'pdf' }, cookie })).status).toBe(401);
        await call(d, { body: { action: 'logout', token }, cookie });
        expect((await call(d, { body: { action: 'pdf', token }, cookie })).status).toBe(401);
    });

    it('is POST-only, same-site-only and JSON-only like every other door', async () => {
        const { d, token, cookie } = await signedIn();
        expect((await call(d, { method: 'GET', body: { action: 'pdf', token }, cookie })).status).toBe(405);
        expect((await call(d, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }, body: { action: 'pdf', token }, cookie })).status).toBe(403);
        expect((await call(d, { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ action: 'pdf', token }), cookie })).status).toBe(400);
    });

    it('has a bucket of its own: downloading cannot use up the page\'s statement reads, nor the other way round', async () => {
        const { d, token, cookie } = await signedIn();
        let last;
        for (let i = 0; i <= LIMITS.pdfsPerIpHour; i += 1) last = await call(d, { body: { action: 'pdf', token }, cookie });
        expect(last.status).toBe(429);
        expect(last.headers['retry-after']).toBeDefined();
        expect((await call(d, { body: { action: 'statement', token }, cookie })).status).toBe(200);
    });

    it('carries the lender\'s bank account to the person, and never to a session that has ended', async () => {
        const { lenderDoc } = await import('./helpers/tenant-fixture.js');
        const user = lenderDoc({ payAccounts: [{ id: 'a1', bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', showTo: 'both', active: true, createdAt: '2026-01-01' }] });
        const { d, token, cookie, advance } = await signedIn({ user });
        const out = await call(d, { body: { action: 'pdf', token }, cookie });
        const text = pageTexts(out.file).join('\n');
        expect(text).toContain('(8001234567)');
        expect(text).toContain('(Commercial Bank)');
        advance(21 * 60e3);
        const late = await call(d, { body: { action: 'pdf', token }, cookie });
        expect(late.status).toBe(401);
        expect(late.file).toBeNull();
    });
});

describe('speed: nobody waits for what does not change the answer', () => {
    it('a good code comes back with the statement in the same answer, and it is the statement the next request would have got', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const { d, gw, advance } = deps({ ctx });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        advance(20000);
        const v = await call(d, { body: { action: 'verify', token, nic: NIC, code: codeIn(gw.sent[0].message) } });
        expect(v.status).toBe(200);
        expect(v.json.statement.groups.map((g) => g.kind)).toEqual(['investment', 'loan']);
        const cookie = String(v.headers['set-cookie']).split(';')[0];
        const again = await call(d, { body: { action: 'statement', token }, cookie });
        expect(v.json.statement).toEqual(again.json.statement);
        // the server-only context never reaches the caller
        expect(Object.keys(v.json).sort()).toEqual(['expiresAt', 'expiresInSec', 'ok', 'statement']);
        expect(v.raw).not.toContain('nicHash');
    });

    it('a wrong code carries no statement', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const { d } = deps({ ctx });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        const bad = await call(d, { body: { action: 'verify', token, nic: NIC, code: '000000' } });
        expect(bad.status).toBe(401);
        expect(bad.raw).not.toContain('statement');
    });

    it('where the platform can finish work after the answer, the text is sent after it, not before', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const later = [];
        const gw = gateway();
        const { d } = deps({ ctx, gw });
        d.waitUntil = () => (work) => { later.push(work); };
        const asked = await call(d, { body: { action: 'request', token, nic: NIC } });
        expect(asked.status).toBe(200);
        expect(asked.json.ok).toBe(true);
        expect(later).toHaveLength(1);
        await Promise.all(later);
        expect(gw.sent).toHaveLength(1);                         // and it did go out
    });

    it('a gateway that fails after the answer still leaves the same answer and a failed record for the owner', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const later = [];
        const { d } = deps({ ctx, gw: gateway(() => ({ ok: false, kind: 'credit', message: 'no units', retryable: true })) });
        d.waitUntil = () => (work) => { later.push(work); };
        const asked = await call(d, { body: { action: 'request', token, nic: NIC } });
        expect(asked.status).toBe(200);
        await Promise.all(later);                                // must not throw
        const mirrored = [...ctx.fs.data.entries()].filter(([k]) => k.includes('/smsLog/otp-')).map(([, v]) => v);
        expect(mirrored.map((m) => m.status)).toEqual(['failed']);
    });
});

describe('hardening: what a hostile caller can and cannot get from the door', () => {
    const base = async () => { const ctx = {}; Object.assign(ctx, makeDb()); const token = await seed(ctx); return { ctx, token, ...deps({ ctx }) }; };

    it('sends no CORS header whatever an earlier layer put on the response, and takes the router\'s own off', async () => {
        const { d, token } = await base();
        const pre = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
        for (const out of [await call(d, { pre, body: { action: 'request', token, nic: NIC } }), await call(d, { pre, method: 'GET' }), await call(d, { pre, body: 'nope' }), await call(d, { pre, headers: { origin: 'https://evil.example' }, body: { action: 'statement', token } })]) {
            expect(Object.keys(out.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
        }
    });

    it('says on every answer that it cannot be framed, read by another site, kept, or run as a page', async () => {
        const { d, token } = await base();
        for (const out of [await call(d, { body: { action: 'request', token, nic: NIC } }), await call(d, { method: 'GET' }), await call(d, { body: { action: 'statement', token } }), await call(d, { headers: { 'sec-fetch-site': 'cross-site' }, body: {} })]) {
            expect(out.headers['x-frame-options']).toBe('DENY');
            expect(out.headers['cross-origin-resource-policy']).toBe('same-origin');
            expect(out.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; sandbox");
            expect(out.headers['cache-control']).toBe('no-store, max-age=0');
        }
    });

    it('puts the same on the PDF, which is a download and never a page', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const { d, gw } = deps({ ctx });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        const v = await call(d, { body: { action: 'verify', token, nic: NIC, code: codeIn(gw.sent[0].message) } });
        const cookie = String(v.headers['set-cookie']).split(';')[0];
        const pdf = await call({ ...d, renderPdf: async () => Buffer.from('%PDF-1.4 test') }, { body: { action: 'pdf', token }, cookie });
        expect(pdf.status).toBe(200);
        expect(pdf.headers['content-type']).toBe('application/pdf');
        expect(pdf.headers['content-disposition']).toMatch(/^attachment;/);
        expect(pdf.headers['x-frame-options']).toBe('DENY');
        expect(pdf.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(pdf.headers['content-security-policy']).toContain('sandbox');
    });

    it('a flood of refusals leaves one line a minute, a count, and nothing about the caller', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const t = Date.parse('2030-01-01T00:00:00Z');
        for (let i = 0; i < 500; i += 1) guardNote('test flood', t + i * 10);               // 500 refusals inside 5 s
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toBe('[WF-PORTAL-GUARD] refused: test flood (1 since the last note)');
        guardNote('test flood', t + 61e3);                                                  // a minute on: one more line, saying how many were held back
        expect(warn).toHaveBeenCalledTimes(2);
        expect(warn.mock.calls[1][0]).toBe('[WF-PORTAL-GUARD] refused: test flood (500 since the last note)');
        guardNote('another kind', t + 61e3);                                                // each kind has its own minute
        expect(warn).toHaveBeenCalledTimes(3);
    });

    it('survives garbage: 700 random requests, never a crash, never a stack, never a pollution, always the safe headers', async () => {
        let seedN = 20261022;                                                               // fixed, so a failure is the same failure next time
        const rnd = () => { seedN = (seedN + 0x6D2B79F5) | 0; let t = Math.imul(seedN ^ (seedN >>> 15), 1 | seedN); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        const pick = (list) => list[Math.floor(rnd() * list.length)];
        const text = () => pick(['', ' ', 'a', '0', '000000', '123456', NIC, NIC.toLowerCase(), '198534000937', 'N1234567', '<script>alert(1)</script>', '\u0000', '\u202e', '\u{1F600}', 'ᱚ'.repeat(40), "' OR 1=1 --", '../../etc/passwd', '${7*7}', '{{7*7}}', 'x'.repeat(2500), '__proto__', 'constructor', 'null', 'undefined', 'NaN', '-1', '1e309', '9'.repeat(400)]);
        const value = (depth = 0) => {
            const k = Math.floor(rnd() * (depth > 2 ? 6 : 9));
            if (k === 0) return text();
            if (k === 1) return Math.floor((rnd() - 0.5) * 1e12);
            if (k === 2) return rnd() < 0.5;
            if (k === 3) return null;
            if (k === 4) return pick([1e308, -1e308, 0, -0, 0.1]);
            if (k === 5) return text();
            if (k === 6) return Array.from({ length: Math.floor(rnd() * 5) }, () => value(depth + 1));
            const o = {};
            for (let i = 0, n = Math.floor(rnd() * 6); i < n; i += 1) o[pick(['action', 'token', 'nic', 'code', 'lang', 'x', '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty'])] = value(depth + 1);
            return o;
        };
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        const { d } = deps({ ctx });
        const before = Object.getOwnPropertyNames(Object.prototype).sort().join();
        const seen = new Set();
        for (let i = 0; i < 700; i += 1) {
            const body = rnd() < 0.55
                ? { action: pick(['request', 'verify', 'statement', 'pdf', 'logout', 'REQUEST', '', 'x', 7, null]), token: rnd() < 0.5 ? token : text(), nic: rnd() < 0.5 ? NIC : value(), code: pick(['246810', '000000', text(), value()]), lang: pick(['si', 'en', value()]) }
                : value();
            const out = await call(d, {
                method: pick(['POST', 'POST', 'POST', 'POST', 'POST', 'GET', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE', 'post', '', undefined]),
                headers: {
                    'x-real-ip': `10.${i % 250}.${Math.floor(i / 250)}.9`,                    // a fresh address each time, so the per-address limits do not hide the code behind them
                    'content-type': pick(['application/json', 'application/json', 'application/json; charset=utf-8', 'APPLICATION/JSON', 'text/plain', '', 'application/json;;;', 'multipart/form-data']),
                    origin: pick(['https://wealthflow-personal.vercel.app', 'https://wealthflow-personal.vercel.app', 'https://evil.example', 'null', '', 'https://wealthflow-personal.vercel.app:443']),
                    'sec-fetch-site': pick(['same-origin', 'same-origin', 'cross-site', 'same-site', 'none', '']),
                },
                cookie: pick([undefined, undefined, '', 'wf_tp=', 'wf_tp=' + 'a'.repeat(5000), 'wf_tp=x.y', `wf_tp=${token}.${'b'.repeat(32)}`, 'a=b; wf_tp=;;;', '\u0000']),
                body: rnd() < 0.8 ? body : JSON.stringify(body),
            });
            seen.add(out.status);
            expect(out.status, `request ${i}`).not.toBe(500);
            expect([200, 400, 401, 403, 405, 429, 503], `request ${i}`).toContain(out.status);
            const wire = String(out.raw && !out.file ? out.raw : '');
            expect(wire, `request ${i}`).not.toMatch(/node_modules|\bat [\w.<>]+ \(|\.m?js:\d+|Error:|firebase|firestore|TENANT_PORTAL|TEXTLK|stack/i);
            if (out.json) expect(typeof out.json.ok, `request ${i}`).toBe('boolean');
            expect(out.headers['x-frame-options'], `request ${i}`).toBe('DENY');
            expect(out.headers['cache-control'], `request ${i}`).toBe('no-store, max-age=0');
            expect(Object.keys(out.headers).filter((h) => h.startsWith('access-control-')), `request ${i}`).toEqual([]);
        }
        expect(Object.getOwnPropertyNames(Object.prototype).sort().join()).toBe(before);   // nothing the bodies carried reached the prototype
        expect({}.polluted).toBeUndefined();
        expect([...seen].length, 'the run reached several kinds of answer, not one').toBeGreaterThanOrEqual(4);
    }, 60000);

    it('forty guesses fired at one link at the same moment: no more than five are weighed, the rest meet the lock', async () => {
        const ctx = {}; Object.assign(ctx, makeDb());
        const token = await seed(ctx);
        // Firestore runs transactions that touch the same document one after the other; this fake does not, so it is made to
        const real = ctx.db.runTransaction.bind(ctx.db);
        let queue = Promise.resolve();
        ctx.db.runTransaction = (work) => { const run = queue.then(() => real(work)); queue = run.catch(() => {}); return run; };
        const { d, gw } = deps({ ctx });
        await call(d, { body: { action: 'request', token, nic: NIC } });
        const right = codeIn(gw.sent[0].message);
        const guesses = await Promise.all(Array.from({ length: 40 }, (_, i) => call(d, { headers: { 'x-real-ip': `172.16.0.${i + 1}` }, body: { action: 'verify', token, nic: NIC, code: String(100000 + i) } })));
        const weighed = guesses.filter((g) => g.status === 401).length;
        expect(weighed).toBeLessThanOrEqual(5);
        expect(guesses.filter((g) => g.status === 429).length).toBe(40 - weighed);
        expect(guesses.every((g) => !g.headers['set-cookie'])).toBe(true);
        const late = await call(d, { headers: { 'x-real-ip': '172.16.1.1' }, body: { action: 'verify', token, nic: NIC, code: right } });
        expect(late.status).toBe(429);                                                      // even the right code is no use once the link is locked
        expect(late.headers['set-cookie']).toBeUndefined();
    });
});
