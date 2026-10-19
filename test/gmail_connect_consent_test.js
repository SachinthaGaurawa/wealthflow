/* =============================================================================
 * test/gmail_connect_consent_test.js — the "Connect Gmail" button, end to end
 * -----------------------------------------------------------------------------
 * WHAT THIS PINS
 *
 * Gmail used to be connected only by pasting a refresh token made by hand in the OAuth Playground. The Mailbox card now also has a "Connect Gmail with Google" button: the browser goes to Google's consent
 * screen, comes back with a one-time code, and /api/gmail-link exchanges it on the server (the client secret never leaves it) and stores the refresh token exactly as a pasted one is stored.
 *
 * Three things are checked: the pure decisions (gmail-link.mjs `redeemConsent`), the exchange itself against a fake Google (google-oauth.mjs `exchangeCode`), the handler run end to end against the in-memory
 * Admin SDK with the network hard-blocked, and the page wiring (the scope, the state prefix, the callback).
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { redeemConsent, looksLikeAuthCode, looksLikeCodeVerifier, GMAIL_SCOPE, CONSENT_REDIRECTS } from '../gmail-link.mjs';
import { exchangeCode, TOKEN_URL } from '../google-oauth.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const ID = '1020193373377-i2p46jo266q77mtmqd9uekrhdsa94oqa.apps.googleusercontent.com';
const SECRET = 'GOCSPX-server-secret-value-123456';
const ENV = { GOOGLE_OAUTH_CLIENT_ID: ID, GOOGLE_OAUTH_CLIENT_SECRET: SECRET };
const CODE = '4/0AVMBsJh' + 'x'.repeat(50);
const VERIFIER = 'V'.repeat(43) + '-_.~';
const REFRESH = '1//0gRefreshTokenFromConsent' + 'A'.repeat(30);
const REDIRECT = 'https://www.wealthflow.lk/';
const GRANTED = `openid ${GMAIL_SCOPE}`;
const body = (over = {}) => ({ code: CODE, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...over });

describe('redeemConsent decides before it spends the code', () => {
    const ok = () => vi.fn(async () => ({ refreshToken: REFRESH, scope: GRANTED }));

    it('a good sign-in returns the refresh token, and Google is asked with exactly what the page sent', async () => {
        const exchange = ok();
        const out = await redeemConsent({ body: body(), env: ENV, exchange });
        expect(out).toEqual({ ok: true, token: REFRESH });
        expect(exchange).toHaveBeenCalledTimes(1);
        expect(exchange).toHaveBeenCalledWith({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, env: ENV });
    });

    it('the apex address is accepted too, and nothing else is', async () => {
        expect(CONSENT_REDIRECTS).toEqual(['https://www.wealthflow.lk/', 'https://wealthflow.lk/']);
        expect((await redeemConsent({ body: body({ redirect_uri: 'https://wealthflow.lk/' }), env: ENV, exchange: ok() })).ok).toBe(true);
        for (const bad of ['http://www.wealthflow.lk/', 'https://www.wealthflow.lk', 'https://www.wealthflow.lk/app', 'https://www.wealthflow.lk.evil.example/', 'https://evil.example/', 'https://wealthflow-personal.vercel.app/', '', undefined, 42]) {
            const exchange = ok();
            const out = await redeemConsent({ body: body({ redirect_uri: bad }), env: ENV, exchange });
            expect(out, String(bad)).toMatchObject({ ok: false, status: 400, kind: 'bad-redirect' });
            expect(exchange, `a code was spent for ${String(bad)}`).not.toHaveBeenCalled();
        }
    });

    it('a code that is not shaped like one never reaches Google', async () => {
        for (const bad of [undefined, '', 'short', 'has space ' + 'x'.repeat(20), 'x'.repeat(3000), {}, 12345678901234, '<script>alert(1)</script>']) {
            const exchange = ok();
            const out = await redeemConsent({ body: body({ code: bad }), env: ENV, exchange });
            expect(out, String(bad)).toMatchObject({ ok: false, status: 400, kind: 'bad-code' });
            expect(exchange).not.toHaveBeenCalled();
        }
        expect(looksLikeAuthCode(CODE)).toBe(true);
    });

    it('a malformed sign-in check value is refused, and an absent one is allowed', async () => {
        expect(looksLikeCodeVerifier(VERIFIER)).toBe(true);
        for (const bad of ['short', 'a b'.repeat(20), 'V'.repeat(200), 5]) {
            const exchange = ok();
            expect(await redeemConsent({ body: body({ code_verifier: bad }), env: ENV, exchange })).toMatchObject({ ok: false, status: 400, kind: 'bad-verifier' });
            expect(exchange).not.toHaveBeenCalled();
        }
        const exchange = ok();
        const { code_verifier: _drop, ...noVerifier } = body();
        expect((await redeemConsent({ body: noVerifier, env: ENV, exchange })).ok).toBe(true);
        expect(exchange.mock.calls[0][0].codeVerifier).toBeUndefined();
    });

    it('a server without the OAuth client says so and does not try', async () => {
        for (const env of [{}, { GOOGLE_OAUTH_CLIENT_ID: ID }, { GOOGLE_OAUTH_CLIENT_SECRET: SECRET }]) {
            const exchange = ok();
            const out = await redeemConsent({ body: body(), env, exchange });
            expect(out).toMatchObject({ ok: false, status: 503, kind: 'not-configured' });
            expect(exchange).not.toHaveBeenCalled();
        }
    });

    it('Google\'s refusals become the one thing to do, and none of them repeats a secret', async () => {
        const failWith = (props) => vi.fn(async () => { throw Object.assign(new Error('code exchange rejected'), props); });
        const cases = [
            [{ transient: true }, 503, 'transient'],
            [{ code: 'invalid_grant', status: 400 }, 422, 'code-used'],
            [{ code: 'redirect_uri_mismatch', status: 400 }, 422, 'redirect-mismatch'],
            [{ code: 'invalid_client', status: 401 }, 422, 'client'],
            [{ code: 'unauthorized_client', status: 400 }, 422, 'client'],
            [{ status: 400 }, 422, 'rejected'],
        ];
        for (const [props, status, kind] of cases) {
            const out = await redeemConsent({ body: body(), env: ENV, exchange: failWith(props) });
            expect(out, kind).toMatchObject({ ok: false, status, kind });
            for (const secret of [CODE, VERIFIER, SECRET, REFRESH]) expect(out.error).not.toContain(secret);
        }
        const mismatch = await redeemConsent({ body: body(), env: ENV, exchange: failWith({ code: 'redirect_uri_mismatch' }) });
        expect(mismatch.error, 'the owner must be told WHICH address to register').toContain(REDIRECT);
    });

    it('unticking the Gmail permission on Google\'s screen is not a connection', async () => {
        const exchange = vi.fn(async () => ({ refreshToken: REFRESH, scope: 'openid email' }));
        const out = await redeemConsent({ body: body(), env: ENV, exchange });
        expect(out).toMatchObject({ ok: false, status: 422, kind: 'scope-missing' });
        expect(out.error).toContain('View your email messages and settings');
    });

    it('a sign-in with no refresh token (Google only sends one on a fresh consent) says how to get one', async () => {
        for (const refreshToken of ['', undefined, 'ya29.an-access-token-is-not-it-' + 'x'.repeat(20), 'short']) {
            const exchange = vi.fn(async () => ({ refreshToken, scope: GRANTED }));
            const out = await redeemConsent({ body: body(), env: ENV, exchange });
            expect(out, String(refreshToken)).toMatchObject({ ok: false, status: 422, kind: 'no-refresh' });
            expect(out.error).toContain('myaccount.google.com/permissions');
        }
    });
});

describe('exchangeCode talks to Google and keeps only the refresh token', () => {
    const google = (status, payload, spy) => async (url, init) => { spy.push({ url: String(url), method: init && init.method, form: new URLSearchParams(String(init && init.body)) }); return { ok: status >= 200 && status < 300, status, json: async () => payload }; };

    it('posts the authorization_code grant with the client, the redirect and the verifier', async () => {
        const seen = [];
        const out = await exchangeCode({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, env: ENV, fetchImpl: google(200, { access_token: 'ya29.drop-me', refresh_token: REFRESH, scope: GRANTED, expires_in: 3599 }, seen) });
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe(TOKEN_URL);
        expect(seen[0].method).toBe('POST');
        expect(Object.fromEntries(seen[0].form)).toEqual({ code: CODE, client_id: ID, client_secret: SECRET, redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: VERIFIER });
        expect(out).toEqual({ refreshToken: REFRESH, scope: GRANTED });
        expect(JSON.stringify(out), 'the short-lived access token must not leave this function').not.toContain('ya29.');
    });

    it('sends no code_verifier when the page had none', async () => {
        const seen = [];
        await exchangeCode({ code: CODE, redirectUri: REDIRECT, env: ENV, fetchImpl: google(200, { refresh_token: REFRESH, scope: GRANTED }, seen) });
        expect(seen[0].form.has('code_verifier')).toBe(false);
    });

    it('a refusal names Google\'s error word and the status, never the code', async () => {
        const seen = [];
        const err = await exchangeCode({ code: CODE, redirectUri: REDIRECT, codeVerifier: VERIFIER, env: ENV, fetchImpl: google(400, { error: 'invalid_grant', error_description: 'Bad Request ' + CODE }, seen) }).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err).toMatchObject({ code: 'invalid_grant', status: 400, transient: false });
        expect(JSON.stringify({ m: err.message, ...err })).not.toContain(CODE);
        const mismatch = await exchangeCode({ code: CODE, redirectUri: REDIRECT, env: ENV, fetchImpl: google(400, { error: 'redirect_uri_mismatch' }, []) }).catch((e) => e);
        expect(mismatch.code).toBe('redirect_uri_mismatch');
        const unknown = await exchangeCode({ code: CODE, redirectUri: REDIRECT, env: ENV, fetchImpl: google(400, { error: 'something_new_and_unlisted' }, []) }).catch((e) => e);
        expect(unknown.code, 'only the known words are carried').toBeUndefined();
    });

    it('a 5xx, a 429 and a dead network are transient; a 400 is not', async () => {
        for (const status of [429, 500, 503]) {
            const err = await exchangeCode({ code: CODE, redirectUri: REDIRECT, env: ENV, fetchImpl: google(status, {}, []) }).catch((e) => e);
            expect(err.transient, String(status)).toBe(true);
        }
        const dead = await exchangeCode({ code: CODE, redirectUri: REDIRECT, env: ENV, fetchImpl: async () => { throw new Error('ECONNRESET ' + CODE); } }).catch((e) => e);
        expect(dead.transient).toBe(true);
        expect(dead.message).not.toContain(CODE);
    });
});

describe('/api/gmail-link accepts the code and stores the token like a pasted one', () => {
    const realFetch = globalThis.fetch;
    const fake = makeFakeAdmin();
    const OWNER = 'owner@example.com';
    const OWNER_KEY = 'owner_example_com';
    let saved;
    let googleCalls;

    beforeEach(async () => {
        fake.reset();
        const { _setAdminModule } = await import('../admin-db.mjs');
        _setAdminModule(fake.admin);
        fake.setVerifier(async (t) => {
            if (t !== 'good-token') throw new Error('invalid token');
            return { email: OWNER, email_verified: true, uid: 'uid-1' };
        });
        saved = { id: process.env.GOOGLE_OAUTH_CLIENT_ID, secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET };
        process.env.GOOGLE_OAUTH_CLIENT_ID = ID;
        process.env.GOOGLE_OAUTH_CLIENT_SECRET = SECRET;
        googleCalls = [];
        globalThis.fetch = async (input, init) => { throw new Error(`network blocked in tests: ${String((init && init.method) || 'GET')} ${String(input)}`); };
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(async () => {
        globalThis.fetch = realFetch;
        for (const [k, v] of [['GOOGLE_OAUTH_CLIENT_ID', saved.id], ['GOOGLE_OAUTH_CLIENT_SECRET', saved.secret]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        const { _setAdminModule } = await import('../admin-db.mjs');
        _setAdminModule(null);
        vi.restoreAllMocks();
    });

    /** A fake Google token endpoint. */
    const google = (status, payload) => { globalThis.fetch = async (url, init) => { googleCalls.push({ url: String(url), form: new URLSearchParams(String((init && init.body) || '')) }); return { ok: status === 200, status, json: async () => payload }; }; };
    const mkRes = () => {
        const seen = { status: null, body: undefined, ended: false, raw: '' };
        const res = { statusCode: 200, setHeader() { return res; }, end(o) { seen.status = res.statusCode; seen.raw = String(o || ''); try { seen.body = JSON.parse(o); } catch (_) { seen.body = o; } seen.ended = true; return res; } };
        return { res, seen };
    };
    async function call({ method = 'POST', token = 'good-token', payload } = {}) {
        const { default: handler } = await import('../gmail-link.js');
        const { res, seen } = mkRes();
        await handler({ method, url: '/api/gmail-link', headers: token ? { authorization: `Bearer ${token}` } : {}, body: payload }, res);
        return seen;
    }

    it('exchanges the code once, stores the refresh token under the verified email, and answers like a pasted save', async () => {
        google(200, { access_token: 'ya29.drop-me', refresh_token: REFRESH, scope: GRANTED, expires_in: 3599 });
        const seen = await call({ payload: body() });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, connected: true, email: OWNER });
        expect(googleCalls).toHaveLength(1);
        expect(googleCalls[0].form.get('grant_type')).toBe('authorization_code');
        const doc = fake.docs.get(`wf-mail/${OWNER_KEY}`);
        expect(doc).toMatchObject({ refresh_token: REFRESH, email: OWNER });
        expect(typeof doc.linkedAt).toBe('number');
        expect(doc.gmailAuth).toBeNull();
        expect(seen.raw, 'the token or the code came back in a response').not.toContain(REFRESH);
        expect(seen.raw).not.toContain(CODE);
        expect(seen.raw).not.toContain('ya29.');
    });

    it('the document is the caller\'s own, whatever else the body says', async () => {
        google(200, { refresh_token: REFRESH, scope: GRANTED });
        await call({ payload: body({ email: 'attacker@example.com', userKey: 'someone_else' }) });
        expect([...fake.docs.keys()]).toEqual([`wf-mail/${OWNER_KEY}`]);
    });

    it('a later connect clears the "Google turned the old sign-in down" mark and keeps the hook\'s bookmark', async () => {
        fake.docs.set(`wf-mail/${OWNER_KEY}`, { refresh_token: 'old', email: OWNER, historyId: '99887', gmailAuth: { kind: 'expired' }, renewError: 'old failure' });
        google(200, { refresh_token: REFRESH, scope: GRANTED });
        await call({ payload: body() });
        const doc = fake.docs.get(`wf-mail/${OWNER_KEY}`);
        expect(doc).toMatchObject({ refresh_token: REFRESH, historyId: '99887', gmailAuth: null, renewError: '' });
    });

    it('nobody signed in spends no code and writes nothing', async () => {
        google(200, { refresh_token: REFRESH, scope: GRANTED });
        for (const token of [null, 'bad-token']) {
            const seen = await call({ token, payload: body() });
            expect(seen.status).toBeGreaterThanOrEqual(401);
        }
        expect(googleCalls).toHaveLength(0);
        expect(fake.docs.size).toBe(0);
    });

    it('a wrong return address, a missing Gmail tick and a refused code store nothing', async () => {
        google(200, { refresh_token: REFRESH, scope: GRANTED });
        expect((await call({ payload: body({ redirect_uri: 'https://evil.example/' }) })).status).toBe(400);
        expect(googleCalls, 'the code was spent for a stranger\'s address').toHaveLength(0);

        google(200, { refresh_token: REFRESH, scope: 'openid email' });
        const unticked = await call({ payload: body() });
        expect(unticked.status).toBe(422);
        expect(unticked.body.refused).toBe('scope-missing');

        google(400, { error: 'invalid_grant' });
        const used = await call({ payload: body() });
        expect(used.status).toBe(422);
        expect(used.body.refused).toBe('code-used');
        expect(fake.docs.size, 'a failed connect still wrote a document').toBe(0);
    });

    it('a pasted refresh token still works exactly as before', async () => {
        google(200, { access_token: 'ya29.fine' });
        const seen = await call({ payload: { refresh_token: REFRESH } });
        expect(seen.status).toBe(200);
        expect(fake.docs.get(`wf-mail/${OWNER_KEY}`).refresh_token).toBe(REFRESH);
        expect(googleCalls[0].form.get('grant_type')).toBe('refresh_token');
    });

    it('GET tells the page which OAuth client to ask Google for, and still never the secret or a token', async () => {
        const seen = await call({ method: 'GET' });
        expect(seen.body.clientId).toBe(ID);
        expect(seen.raw).not.toContain(SECRET);
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        const none = await call({ method: 'GET' });
        expect(none.body.clientId).toBeUndefined();
    });
});

describe('the page wires the button to Google and back', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const start = html.indexOf('async function _wfStartGmailConsent');
    const end = html.indexOf('window._wfCompleteGmailConsent = _wfCompleteGmailConsent;');
    const flow = html.slice(start, end);
    const nocomments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

    it('asks Google for gmail.readonly and nothing else, offline, with consent and PKCE', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        expect(html).toContain("const _WF_GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';");
        expect(flow).toContain('scope: _WF_GMAIL_SCOPE');
        expect(flow).toContain("access_type: 'offline'");
        expect(flow).toContain("prompt: 'consent'");
        expect(flow).toContain("code_challenge_method = 'S256'");
        expect(flow).toContain("redirect_uri: window._wfPublicUrl('/')");
        expect(flow).toContain("accounts.google.com/o/oauth2/v2/auth");
    });

    it('does not carry earlier Drive scopes into the Gmail sign-in', () => {
        expect(nocomments(flow)).not.toMatch(/include_granted_scopes|drive\.(file|readonly)/);
    });

    it('uses its own state prefix and storage key, so it can never be taken for a Drive return', () => {
        expect(flow).toContain("'wfgmail_' + _wfRandId()");
        expect(flow).toContain("localStorage.setItem('wf_gmail_oauth'");
        expect(flow).not.toContain('wf_drive_pkce');
    });

    it('the callback checks the saved state, clears the code from the address bar first, and never logs', () => {
        const cb = html.slice(html.indexOf('async function _wfCompleteGmailConsent'), end);
        expect(cb.indexOf('history.replaceState')).toBeGreaterThan(0);
        expect(cb.indexOf('history.replaceState')).toBeLessThan(cb.indexOf('saved.s !== state'));
        expect(cb).toContain('saved.s !== state');
        expect(cb).toContain("_gmailLink('POST', { code, redirect_uri: window._wfPublicUrl('/'), code_verifier: saved.v || undefined })");
        expect(nocomments(flow)).not.toMatch(/console\.(log|warn|error)/);
    });

    it('the return from Google is routed to it before the Drive branch', () => {
        const router = html.slice(html.indexOf('function _wfMaybeRunDriveAuth()'), html.indexOf('function _wfBeginDriveAuthStart'));
        const gmailAt = router.indexOf("state.indexOf('wfgmail_') === 0");
        const driveAt = router.indexOf("state.indexOf('wfdrive_') === 0");
        expect(gmailAt).toBeGreaterThan(0);
        expect(driveAt).toBeGreaterThan(gmailAt);
        expect(router).toContain("params.get('error')");
        expect(router).toContain('window._wfCompleteGmailConsent(code, state, params.get(\'error\'))');
    });

    it('the Mailbox card offers the button first and keeps the paste box as the advanced route', () => {
        const card = html.slice(html.indexOf('async function openGmailLink()'), html.indexOf('window.openGmailLink = openGmailLink;'));
        expect(card).toContain('id="_gl_google"');
        expect(card).toContain('Connect Gmail with Google');
        expect(card).toContain('_wfStartGmailConsent(st.clientId)');
        expect(card.indexOf('id="_gl_google"')).toBeLessThan(card.indexOf('id="_gl_tok"'));
        expect(card).toContain('<details id="_gl_adv"');
        expect(card).toContain('Advanced: paste a refresh token instead');
        expect(card).toContain('Paste the <b>refresh token</b>');
        expect(card).toContain('href="/privacy"');
    });
});
