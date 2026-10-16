/* test/auth_health_test.js — GET /api/auth-health
 *
 * Sign-in with Google failed with a blank popup and no message (2026-10-16): every
 * cause looks identical from the browser, so the server asks Firebase and Google
 * directly. These tests pin the parts that must not drift: the host rule Firebase
 * uses, the reading of Google's error blob, the problem list, the constants that
 * must equal what the page ships, and that the endpoint answers without a secret.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
    FIREBASE, APP_HOSTS, isAuthorizedDomain, hostsToCheck, apiKeyFromPage, decodeAuthError,
    classifyOAuthResponse, clientIdFromAuthUri, toolkitErrorCode, buildProblems
} from '../auth-health.js';
import { DEFAULT_CLIENT_ID } from '../drive-auth.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Real answers Google gave on 2026-10-16 for a deleted and for a non-existent client.
const DELETED = 'https://accounts.google.com/signin/oauth/error?authError=Cg5kZWxldGVkX2NsaWVudBIdVGhlIE9BdXRoIGNsaWVudCB3YXMgZGVsZXRlZC4gkQM&flowName=GeneralOAuthFlow&client_id=x';
const NOT_FOUND = 'https://accounts.google.com/signin/oauth/error?authError=Cg5pbnZhbGlkX2NsaWVudBIfVGhlIE9BdXRoIGNsaWVudCB3YXMgbm90IGZvdW5kLiCRAw&flowName=GeneralOAuthFlow';

describe('constants match what the page ships', () => {
    it('the Firebase web config equals the firebaseConfig literal in index.html', () => {
        const m = INDEX.match(/const firebaseConfig = \{([\s\S]*?)\};/);
        expect(m).toBeTruthy();
        const get = (k) => (m[1].match(new RegExp(`${k}:\\s*"([^"]+)"`)) || [])[1];
        expect(FIREBASE.authDomain).toBe(get('authDomain'));
        expect(FIREBASE.projectId).toBe(get('projectId'));
    });

    it('the apiKey is read from the page, never written in the server file (the CI secret scan allows it in index.html only)', () => {
        const key = apiKeyFromPage(INDEX);
        expect(key).toMatch(/^AIza[0-9A-Za-z_-]{35}$/);
        const src = fs.readFileSync(path.join(ROOT, 'auth-health.js'), 'utf8');
        expect(src).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
        expect(src).not.toContain(key);
    });

    it('apiKeyFromPage finds the key in the firebaseConfig literal and nowhere else', () => {
        expect(apiKeyFromPage('const firebaseConfig = { apiKey: "k-1", authDomain: "a" };')).toBe('k-1');
        expect(apiKeyFromPage('const other = { apiKey: "nope" };')).toBe('');
        expect(apiKeyFromPage('')).toBe('');
    });

    it('the Drive client the server defaults to is the one the page hard-codes', () => {
        const ids = [...INDEX.matchAll(/client_id:\s*'([0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com)'/g)].map((x) => x[1]);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(id).toBe(DEFAULT_CLIENT_ID);
    });
});

describe('isAuthorizedDomain follows Firebase\'s own rule', () => {
    const list = ['localhost', 'wealthflow-6dffb.firebaseapp.com', 'wealthflow.lk'];
    it('an exact entry and a subdomain of an entry are authorized', () => {
        expect(isAuthorizedDomain('wealthflow.lk', list)).toBe(true);
        expect(isAuthorizedDomain('www.wealthflow.lk', list)).toBe(true);
        expect(isAuthorizedDomain('WWW.WealthFlow.LK', list)).toBe(true);
    });
    it('a look-alike that merely ends with the same letters is not', () => {
        expect(isAuthorizedDomain('evilwealthflow.lk', list)).toBe(false);
        expect(isAuthorizedDomain('wealthflow.lk.evil.com', list)).toBe(false);
    });
    it('an empty host or list never authorizes', () => {
        expect(isAuthorizedDomain('', list)).toBe(false);
        expect(isAuthorizedDomain('wealthflow.lk', [])).toBe(false);
        expect(isAuthorizedDomain('wealthflow.lk', null)).toBe(false);
    });
});

describe('hostsToCheck', () => {
    it('always includes the production hosts and adds the caller\'s host once', () => {
        const h = hostsToCheck({ headers: { host: 'wealthflow-abc.vercel.app', 'x-forwarded-host': 'www.wealthflow.lk' } });
        for (const a of APP_HOSTS) expect(h).toContain(a);
        expect(h).toContain('wealthflow-abc.vercel.app');
        expect(new Set(h).size).toBe(h.length);
    });
    it('drops a header that is not a hostname, and strips a port', () => {
        expect(hostsToCheck({ headers: { host: 'a b<script>' } })).toEqual([...APP_HOSTS]);
        expect(hostsToCheck({ headers: { host: 'localhost:3000' } })).toContain('localhost');
    });
});

describe('decodeAuthError / classifyOAuthResponse', () => {
    it('reads the code and sentence out of Google\'s error address', () => {
        expect(decodeAuthError(DELETED)).toEqual({ code: 'deleted_client', description: 'The OAuth client was deleted.' });
        expect(decodeAuthError(NOT_FOUND).code).toBe('invalid_client');
    });
    it('returns null for an address without one, or with a broken one', () => {
        expect(decodeAuthError('https://accounts.google.com/v3/signin/identifier')).toBeNull();
        expect(decodeAuthError('https://accounts.google.com/x?authError=!!!')).toBeNull();
        expect(decodeAuthError('')).toBeNull();
    });
    it('names the state: deleted, invalid, redirect mismatch, ok, unknown', () => {
        expect(classifyOAuthResponse(302, DELETED).state).toBe('deleted');
        expect(classifyOAuthResponse(302, NOT_FOUND).state).toBe('invalid');
        const mismatch = 'https://accounts.google.com/signin/oauth/error?authError=' +
            Buffer.from([0x0a, 21, ...Buffer.from('redirect_uri_mismatch'), 0x12, 1, 0x2e]).toString('base64url');
        expect(classifyOAuthResponse(302, mismatch).state).toBe('redirect-mismatch');
        expect(classifyOAuthResponse(302, 'https://accounts.google.com/v3/signin/identifier?x=1').state).toBe('ok');
        expect(classifyOAuthResponse(200, '').state).toBe('ok');
        expect(classifyOAuthResponse(500, '').state).toBe('unknown');
    });
});

describe('small readers', () => {
    it('clientIdFromAuthUri / toolkitErrorCode', () => {
        expect(clientIdFromAuthUri('https://accounts.google.com/o/oauth2/auth?client_id=abc.apps.googleusercontent.com&x=1')).toBe('abc.apps.googleusercontent.com');
        expect(clientIdFromAuthUri('not a url')).toBe('');
        expect(toolkitErrorCode('OPERATION_NOT_ALLOWED : Sign-in provider is disabled.')).toBe('OPERATION_NOT_ALLOWED');
        expect(toolkitErrorCode('status 403')).toBe('');
    });
});

describe('buildProblems', () => {
    const healthy = () => ({
        hosts: ['www.wealthflow.lk'],
        firebase: {
            apiKeyFound: true,
            domains: { list: ['wealthflow.lk'], hosts: [{ host: 'www.wealthflow.lk', authorized: true }] },
            handler: { status: 200 }, iframe: { status: 200 },
            googleProvider: { ok: true, clientId: 'c.apps.googleusercontent.com' }
        },
        oauth: { provider: { clientId: 'c.apps.googleusercontent.com', state: 'ok' }, serverClients: [{ clientId: 'd', uses: ['Gmail'], state: 'ok' }] }
    });
    const codes = (r) => buildProblems(r).map((p) => p.code);

    it('a healthy project has no problems', () => {
        expect(buildProblems(healthy())).toEqual([]);
    });
    it('an unauthorized host is critical and names the host and where to add it', () => {
        const r = healthy();
        r.firebase.domains.hosts = [{ host: 'www.wealthflow.lk', authorized: false }];
        const [p] = buildProblems(r);
        expect(p.code).toBe('domain-not-authorized');
        expect(p.severity).toBe('critical');
        expect(p.fix).toContain('www.wealthflow.lk');
    });
    it('the hosting handler being gone is critical', () => {
        const r = healthy();
        r.firebase.handler = { status: 404 };
        expect(codes(r)).toEqual(['auth-handler-down']);
    });
    it('the Google provider switched off, or missing, is told apart from a generic error', () => {
        const r = healthy();
        r.firebase.googleProvider = { ok: false, error: 'OPERATION_NOT_ALLOWED : x', errorCode: 'OPERATION_NOT_ALLOWED' };
        expect(codes(r)).toEqual(['provider-disabled']);
        r.firebase.googleProvider = { ok: false, error: 'CONFIGURATION_NOT_FOUND', errorCode: 'CONFIGURATION_NOT_FOUND' };
        expect(codes(r)).toEqual(['provider-not-configured']);
        r.firebase.googleProvider = { ok: false, error: 'Firebase App Check token is invalid.', errorCode: '' };
        expect(codes(r)).toEqual(['app-check-enforced']);
        r.firebase.googleProvider = { ok: false, error: 'API key not valid', errorCode: 'API' };
        expect(codes(r)).toEqual(['api-key-refused']);
        r.firebase.googleProvider = { ok: false, error: 'something else', errorCode: '' };
        expect(codes(r)).toEqual(['provider-error']);
    });
    it('App Check enforcement (the 2026-10-16 outage) is named, with the console path to lift it', () => {
        const r = healthy();
        r.firebase.googleProvider = { ok: false, error: 'Firebase App Check token is invalid.', errorCode: '' };
        const [p] = buildProblems(r);
        expect(p.code).toBe('app-check-enforced');
        expect(p.severity).toBe('critical');
        expect(p.scope).toBe('signin');
        expect(p.fix).toMatch(/App Check → APIs.*Authentication.*Unenforce/);
    });
    it('a deleted provider client is critical and the fix says how to restore or recreate it', () => {
        const r = healthy();
        r.oauth.provider = { clientId: 'c.apps.googleusercontent.com', state: 'deleted', code: 'deleted_client' };
        const [p] = buildProblems(r);
        expect(p.code).toBe('provider-client-deleted');
        expect(p.severity).toBe('critical');
        expect(p.fix).toMatch(/Restore deleted credentials/);
        expect(p.fix).toMatch(/turn it off.*turn it on again/);
    });
    it('a redirect mismatch on the provider client names the exact address to add', () => {
        const r = healthy();
        r.oauth.provider = { clientId: 'c', state: 'redirect-mismatch' };
        const [p] = buildProblems(r);
        expect(p.code).toBe('provider-redirect-mismatch');
        expect(p.fix).toContain(`https://${FIREBASE.authDomain}/__/auth/handler`);
    });
    it('a deleted Drive/Gmail client is critical and says what it breaks', () => {
        const r = healthy();
        r.oauth.serverClients = [{ clientId: 'gone', uses: ['Google Drive (page)', 'Gmail / Drive server'], state: 'deleted' }];
        const [p] = buildProblems(r);
        expect(p.code).toBe('server-client-deleted');
        expect(p.title).toContain('Google Drive (page)');
        expect(p.fix).toContain('GOOGLE_OAUTH_CLIENT_ID');
        expect(p.scope).toBe('drive');
    });
    it('without an apiKey it says so once, as a warning, instead of three confusing errors', () => {
        const r = healthy();
        r.firebase.apiKeyFound = false;
        r.firebase.domains = { error: 'no key', hosts: [] };
        r.firebase.googleProvider = { ok: false, error: 'no key', errorCode: 'NO_API_KEY' };
        const p = buildProblems(r);
        expect(p.map((x) => x.code)).toEqual(['api-key-unknown']);
        expect(p[0].severity).toBe('warning');
    });
    it('an unreadable domain list is a warning, not a verdict', () => {
        const r = healthy();
        r.firebase.domains = { error: 'status 500', hosts: [] };
        const [p] = buildProblems(r);
        expect(p.code).toBe('domains-unreadable');
        expect(p.severity).toBe('warning');
    });
});

describe('GET /api/auth-health', () => {
    const SECRET = 's3cret-value-never-in-the-answer';
    let handler;
    let calls;

    const res = () => {
        const o = { status: 0, body: null, headers: {} };
        return Object.assign(o, {
            setHeader(k, v) { o.headers[k] = v; },
            status(c) { o.status = c; return o; },
            json(b) { o.body = b; return o; }
        });
    };
    const reply = (status, body, headers = {}, text = '') => ({
        status, headers: { get: (k) => headers[String(k).toLowerCase()] ?? null }, json: async () => body, text: async () => text
    });
    const FAKE_KEY = 'test-key-not-a-real-credential';

    beforeEach(async () => {
        vi.resetModules();
        calls = [];
        process.env.GOOGLE_OAUTH_CLIENT_SECRET = SECRET;
        process.env.FIREBASE_API_KEY = FAKE_KEY;
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
            const u = String(url);
            calls.push({ url: u, method: init.method || 'GET' });
            if (u.includes('identitytoolkit.googleapis.com/v1/projects')) return reply(200, { authorizedDomains: ['localhost', 'wealthflow-6dffb.firebaseapp.com', 'wealthflow.lk'] });
            if (u.includes('accounts:createAuthUri')) return reply(200, { authUri: 'https://accounts.google.com/o/oauth2/auth?client_id=prov.apps.googleusercontent.com&redirect_uri=x' });
            if (u.includes('accounts.google.com/o/oauth2/v2/auth')) {
                return u.includes('client_id=prov.') ? reply(302, null, { location: 'https://accounts.google.com/v3/signin/identifier' })
                    : reply(302, null, { location: DELETED });
            }
            if (u.includes('/__/auth/')) return reply(200, null);
            return reply(404, null);
        }));
        ({ default: handler } = await import('../auth-health.js'));
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); delete process.env.GOOGLE_OAUTH_CLIENT_SECRET; delete process.env.FIREBASE_API_KEY; });

    it('names the deleted Drive client as the one problem, and a working provider as fine', async () => {
        const r = res();
        await handler({ method: 'GET', headers: { host: 'www.wealthflow.lk' } }, r);
        expect(r.status).toBe(200);
        expect(r.body.firebase.googleProvider).toEqual({ ok: true, clientId: 'prov.apps.googleusercontent.com' });
        expect(r.body.oauth.provider.state).toBe('ok');
        expect(r.body.problems.map((p) => p.code)).toEqual(['server-client-deleted']);
        expect(r.body.ok).toBe(false);
        // …but people can still sign in, so the sign-in screen must not cry wolf.
        expect(r.body.signInOk).toBe(true);
        expect(r.headers['Cache-Control']).toMatch(/no-store/);
    });

    it('never puts a secret in the answer, and reports the secret only as set', async () => {
        const r = res();
        await handler({ method: 'GET', headers: {} }, r);
        const text = JSON.stringify(r.body);
        expect(text).not.toContain(SECRET);
        expect(r.body.oauth.serverClientSecretSet).toBe(true);
    });

    it('uses FIREBASE_API_KEY for Firebase, and the page\'s own key when the variable is unset', async () => {
        await handler({ method: 'GET', headers: {} }, res());
        expect(calls.filter((c) => c.url.includes('identitytoolkit')).every((c) => c.url.includes('key=' + FAKE_KEY))).toBe(true);

        vi.resetModules();
        delete process.env.FIREBASE_API_KEY;
        calls.length = 0;
        const base = fetch.getMockImplementation();
        fetch.mockImplementation(async (url, init = {}) => {
            if (String(url) === 'https://www.wealthflow.lk/') {
                calls.push({ url: String(url), method: 'GET' });
                return reply(200, null, {}, 'const firebaseConfig = { apiKey: "page-key-1", authDomain: "x" };');
            }
            return base(url, init);
        });
        const { default: h2 } = await import('../auth-health.js');
        const r = res();
        await h2({ method: 'GET', headers: {} }, r);
        expect(r.body.firebase.apiKeyFound).toBe(true);
        expect(calls.some((c) => c.url.includes('identitytoolkit') && c.url.includes('key=page-key-1'))).toBe(true);
    });

    it('is read-only: a POST is refused and nothing is fetched', async () => {
        const r = res();
        await handler({ method: 'POST', headers: {} }, r);
        expect(r.status).toBe(405);
        expect(calls.length).toBe(0);
    });

    it('answers a second request inside 30 s from its cache without asking Google again', async () => {
        await handler({ method: 'GET', headers: {} }, res());
        const n = calls.length;
        const r = res();
        await handler({ method: 'GET', headers: {} }, r);
        expect(calls.length).toBe(n);
        expect(r.body.cached).toBe(true);
    });

    it('every outbound call is a GET, except the one createAuthUri POST', async () => {
        await handler({ method: 'GET', headers: {} }, res());
        const posts = calls.filter((c) => c.method !== 'GET');
        expect(posts.map((c) => c.url)).toEqual([expect.stringContaining('accounts:createAuthUri')]);
    });

    it('a provider that Firebase refuses is reported with Firebase\'s own words', async () => {
        fetch.mockImplementation(async (url, init = {}) => {
            const u = String(url);
            if (u.includes('accounts:createAuthUri')) return reply(400, { error: { message: 'OPERATION_NOT_ALLOWED : Google sign-in is disabled.' } });
            if (u.includes('identitytoolkit.googleapis.com/v1/projects')) return reply(200, { authorizedDomains: ['wealthflow.lk'] });
            if (u.includes('accounts.google.com')) return reply(302, null, { location: 'https://accounts.google.com/v3/signin/identifier' });
            return reply(200, null);
        });
        const r = res();
        await handler({ method: 'GET', headers: {} }, r);
        expect(r.body.problems.map((p) => p.code)).toEqual(['provider-disabled']);
        expect(r.body.ok).toBe(false);
        expect(r.body.signInOk).toBe(false);
    });

    it('an upstream that throws never makes the endpoint throw', async () => {
        fetch.mockImplementation(async () => { throw new Error('socket hang up'); });
        const r = res();
        await expect(handler({ method: 'GET', headers: {} }, r)).resolves.not.toThrow();
        expect(r.status).toBe(200);
        expect(r.body.problems.length).toBeGreaterThan(0);
    });
});
