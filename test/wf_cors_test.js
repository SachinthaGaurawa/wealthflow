/* =============================================================================
 * test/wf_cors_test.js — only WealthFlow's own pages may read the API from a browser
 * -----------------------------------------------------------------------------
 * The live API answered `Access-Control-Allow-Origin: *` on every route, and three handlers reflected any Origin.
 * wf-cors.mjs is the allow-list; api/router.js applies it once and locks the response so a handler that still tries to
 * set `*` cannot. See the header of wf-cors.mjs.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { allowedOrigins, corsHeaders, corsOrigin, applyCors, lockCors } from '../wf-cors.mjs';
import router from '../api/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function fakeRes() {
    const headers = {};
    const res = {
        statusCode: 200, body: undefined, ended: false, headersSent: false, writableEnded: false,
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return res; },
        getHeader(k) { return headers[String(k).toLowerCase()]; },
        status(c) { res.statusCode = c; return res; },
        json(b) { res.body = b; res.ended = true; res.writableEnded = true; res.headersSent = true; return res; },
        end(b) { res.body = b; res.ended = true; res.writableEnded = true; res.headersSent = true; return res; },
        writeHead(c, h) { res.statusCode = c; if (h) for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]; return res; },
        headers,
    };
    return res;
}
const req = (url, { method = 'GET', origin, body } = {}) => ({
    method, url, headers: { host: 'www.wealthflow.lk', ...(origin ? { origin } : {}) }, query: {}, body,
});

describe('the allow-list', () => {
    it('is the two production origins and nothing else by default', () => {
        expect([...allowedOrigins({})].sort()).toEqual(['https://wealthflow.lk', 'https://www.wealthflow.lk']);
    });

    it('adds this deployment\'s own URLs and nothing broader', () => {
        const set = allowedOrigins({ VERCEL_URL: 'wealthflow-abc123-team.vercel.app', VERCEL_BRANCH_URL: 'wealthflow-git-x-team.vercel.app' });
        expect(set.has('https://wealthflow-abc123-team.vercel.app')).toBe(true);
        expect(set.has('https://wealthflow-git-x-team.vercel.app')).toBe(true);
        expect(set.has('https://wealthflow-evil.vercel.app')).toBe(false);
    });

    it('takes extra origins only as bare https origins', () => {
        const set = allowedOrigins({ WF_CORS_ORIGINS: 'https://staging.example.com, http://insecure.example.com, https://*.example.com, https://ok.example.com/path, *' });
        expect(set.has('https://staging.example.com')).toBe(true);
        for (const bad of ['http://insecure.example.com', 'https://*.example.com', 'https://ok.example.com/path', '*']) expect(set.has(bad)).toBe(false);
    });
});

describe('corsHeaders', () => {
    it('echoes one allow-listed origin, with Vary', () => {
        const h = corsHeaders(req('/api/x', { origin: 'https://www.wealthflow.lk' }), { env: {} });
        expect(h['Access-Control-Allow-Origin']).toBe('https://www.wealthflow.lk');
        expect(h.Vary).toBe('Origin');
    });

    it('gives another website nothing, never `*` and never a reflection', () => {
        for (const origin of ['https://evil.example', 'http://www.wealthflow.lk', 'https://www.wealthflow.lk.evil.example', 'https://evilwealthflow.lk', 'null', 'https://WWW.WEALTHFLOW.LK.evil.example']) {
            const h = corsHeaders(req('/api/x', { origin }), { env: {} });
            expect(h['Access-Control-Allow-Origin'], origin).toBeUndefined();
            expect(h.Vary).toBe('Origin');
        }
    });

    it('treats a request with no Origin as not a cross-site browser call: no CORS headers, no change in behaviour', () => {
        expect(corsOrigin(req('/api/x'), {})).toBe('');
    });

    it('reads Origin from a Web Request too', () => {
        const r = new Request('https://www.wealthflow.lk/api/x', { headers: { Origin: 'https://wealthflow.lk' } });
        expect(corsOrigin(r, {})).toBe('https://wealthflow.lk');
    });

    it('does not duplicate Vary when a handler already set it', () => {
        const res = fakeRes();
        res.setHeader('Vary', 'Origin');
        applyCors(req('/api/x', { origin: 'https://evil.example' }), res);
        expect(res.headers.vary).toBe('Origin');
    });
});

describe('lockCors', () => {
    it('ignores a handler\'s own Access-Control-* headers, in setHeader and in writeHead', () => {
        const res = lockCors(fakeRes());
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('access-control-allow-credentials', 'true');
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'X-Other': '1' });
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        expect(res.headers['content-type']).toBe('application/json');
        expect(res.headers['x-other']).toBe('1');
    });
});

describe('api/router.js', () => {
    it('answers a pre-flight from WealthFlow with its own origin, and from anyone else with nothing', async () => {
        const ok = fakeRes();
        await router(req('/api/router?path=version', { method: 'OPTIONS', origin: 'https://www.wealthflow.lk' }), ok);
        expect(ok.statusCode).toBe(204);
        expect(ok.headers['access-control-allow-origin']).toBe('https://www.wealthflow.lk');

        const evil = fakeRes();
        await router(req('/api/router?path=version', { method: 'OPTIONS', origin: 'https://evil.example' }), evil);
        expect(evil.statusCode).toBe(204);
        expect(evil.headers['access-control-allow-origin']).toBeUndefined();
        expect(evil.headers['access-control-allow-methods']).toBeUndefined();
    });

    it('never lets a Node handler or a Web handler put `*` on the answer', async () => {
        // version.js is a Node handler; ios-shortcut.js is a Web handler that used to send `*` itself.
        for (const route of ['version', 'ios-shortcut']) {
            for (const origin of ['https://evil.example', 'https://www.wealthflow.lk', undefined]) {
                const res = fakeRes();
                const r = req('/api/router?path=' + route, { origin });
                r.query = { path: route };
                await router(r, res);
                expect(res.statusCode, route).toBe(200);
                const acao = res.headers['access-control-allow-origin'];
                expect(acao === undefined || acao === 'https://www.wealthflow.lk', route + ' / ' + origin + ' got ' + acao).toBe(true);
                if (origin === 'https://evil.example' || origin === undefined) expect(acao, route).toBeUndefined();
            }
        }
    });
});

describe('source', () => {
    it('no handler writes `Access-Control-Allow-Origin: *` or reflects the Origin header', () => {
        const files = [...fs.readdirSync(ROOT).filter((f) => /\.(js|mjs)$/.test(f)), ...fs.readdirSync(path.join(ROOT, 'api')).map((f) => 'api/' + f)];
        for (const f of files) {
            if (f === 'wf-cors.mjs') continue;
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            expect(src, f).not.toMatch(/Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]/);
            expect(src, f).not.toMatch(/Access-Control-Allow-Origin['"]?\s*[,:]\s*origin\b/i);
        }
    });

    it('the handlers Vercel serves straight from api/ apply the allow-list themselves (the router never sees them)', () => {
        for (const f of ['api/ai.js', 'api/verify.js', 'api/vision.js', 'api/vision-scan.js']) {
            expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/applyCors\(req, res/);
        }
    });
});
