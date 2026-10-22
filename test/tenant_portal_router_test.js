/* =============================================================================
 * test/tenant_portal_router_test.js — the portal's door, reached the way the internet reaches it
 * -----------------------------------------------------------------------------
 * tenant-portal.js promised "no CORS headers are ever sent", and its own tests proved it by calling the handler
 * directly. But the handler is never the first thing a request meets: api/router.js is, and it put
 * `Access-Control-Allow-Origin: *` on every route and answered every pre-flight with 204. The promise was true of the half
 * that was tested and false of the whole. These tests go through the router, which is the only way in.
 *
 * Nothing here reaches a database or the network: every request is refused before the handler needs either (wrong method,
 * wrong content type, another site), and the one that fails to load is made to fail on purpose.
 * ===========================================================================*/

import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => { vi.doUnmock('../tenant-portal.js'); vi.doUnmock('../version.js'); vi.resetModules(); vi.restoreAllMocks(); });

async function through(name, { method = 'POST', headers = {} } = {}) {
    const router = (await import('../api/router.js')).default;
    const out = { status: 0, headers: {}, body: null, text: '' };
    const res = {
        headersSent: false, writableEnded: false,
        setHeader(k, v) { out.headers[String(k).toLowerCase()] = v; },
        removeHeader(k) { delete out.headers[String(k).toLowerCase()]; },
        getHeader(k) { return out.headers[String(k).toLowerCase()]; },
        set statusCode(v) { out.status = v; }, get statusCode() { return out.status; },
        status(c) { out.status = c; return this; },
        json(o) { out.body = o; this.headersSent = true; this.writableEnded = true; return this; },
        end(t) { out.text = t === undefined ? '' : String(t); this.headersSent = true; this.writableEnded = true; return this; },
    };
    const req = { method, url: `/api/router?path=${name}`, query: { path: name }, headers: { host: 'wealthflow.test', ...headers }, body: undefined };
    await router(req, res);
    const json = out.body || (out.text && out.text.startsWith('{') ? JSON.parse(out.text) : null);
    return { ...out, json, cors: Object.keys(out.headers).filter((h) => h.startsWith('access-control-')) };
}

describe('the tenant portal through the API router', () => {
    it('does not answer a pre-flight, so another site\'s page cannot even send it a request', async () => {
        const r = await through('tenant-portal', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
        expect(r.status).toBe(405);
        expect(r.headers.allow).toBe('POST');
        expect(r.cors).toEqual([]);
    });

    it('sends no CORS header on any answer it gives, whoever asks', async () => {
        const wrongMethod = await through('tenant-portal', { method: 'GET' });
        expect(wrongMethod.status).toBe(405);
        expect(wrongMethod.cors).toEqual([]);
        const wrongType = await through('tenant-portal', { headers: { 'content-type': 'text/plain', origin: 'https://wealthflow.test', 'sec-fetch-site': 'same-origin' } });
        expect(wrongType.status).toBe(400);
        expect(wrongType.cors).toEqual([]);
        const otherSite = await through('tenant-portal', { headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
        expect(otherSite.status).toBe(403);
        expect(otherSite.cors).toEqual([]);
        for (const r of [wrongMethod, wrongType, otherSite]) {
            expect(r.headers['x-frame-options']).toBe('DENY');
            expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
            expect(r.headers['cache-control']).toBe('no-store, max-age=0');
        }
    });

    it('is the only route that does this: the others still answer a pre-flight and send CORS, as the app relies on', async () => {
        const pre = await through('version', { method: 'OPTIONS' });
        expect(pre.status).toBe(204);
        expect(pre.headers['access-control-allow-origin']).toBe('*');
        const get = await through('version', { method: 'GET' });
        expect(get.status).toBe(200);
        expect(get.headers['access-control-allow-origin']).toBe('*');
    });

    it('never tells a caller why it failed to load: the error text stays in the log', async () => {
        vi.resetModules();
        vi.doMock('../tenant-portal.js', () => { throw new Error('Cannot find module /var/task/secret-internal-path.mjs'); });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const r = await through('tenant-portal');
        expect(r.status).toBe(500);
        expect(JSON.stringify(r.json)).not.toMatch(/secret-internal-path|var\/task|Cannot find/);
        expect(r.json.detail).toBeUndefined();
        expect(r.cors).toEqual([]);
    });

    it('(and the check can fail) any other route still says why, which is what the app\'s error line shows', async () => {
        vi.resetModules();
        vi.doMock('../version.js', () => { throw new Error('Cannot find module /var/task/version-internal.mjs'); });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const r = await through('version', { method: 'GET' });
        expect(r.status).toBe(500);
        expect(typeof r.json.detail).toBe('string');                                        // vitest words the error itself; what matters is that a reason is given
        expect(r.json.detail.length).toBeGreaterThan(10);
    });
});
