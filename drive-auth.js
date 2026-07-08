/*  drive-auth.js  →  POST /api/drive-auth
 *  ---------------------------------------------------------------------------
 *  Durable, cookie-free Google Drive connection for WealthFlow (v7.55.0).
 *
 *  WHY THIS EXISTS
 *  The client used to rely on Google Identity Services' *implicit* token flow
 *  (initTokenClient → requestAccessToken). That flow issues a ~1-hour access
 *  token and NO refresh token, and its silent re-mint (prompt:'') requires
 *  Google's THIRD-PARTY cookies — which are permanently blocked inside the
 *  installed app / APK / Android-iOS WebView. So the token died every hour and
 *  the user was pushed back through the browser sign-in bridge, over and over.
 *
 *  THE ROOT-CAUSE FIX (this endpoint) is the OAuth 2.0 AUTHORIZATION CODE flow
 *  with access_type=offline. The user authorizes ONCE in a real browser (where
 *  cookies work). We exchange the code HERE — server-side, where the client
 *  secret can live safely — for an access token AND a long-lived REFRESH token.
 *  The client stores the refresh token in the user's own (per-user, rules-
 *  protected) Firestore document, which syncs to every device including the
 *  APK. From then on ANY device mints fresh access tokens by calling this
 *  endpoint's `refresh` action — with ZERO cookies, ZERO consent, forever
 *  (until the user revokes). The scope is limited to drive.file (and optionally
 *  drive.readonly for the clean file browser), so the blast radius is small.
 *
 *  ACTIONS (POST JSON body):
 *    { action:'exchange', code, code_verifier, redirect_uri }
 *        → { ok, access_token, refresh_token, expires_in, scope }
 *    { action:'refresh',  refresh_token }
 *        → { ok, access_token, expires_in, scope }
 *    { action:'revoke',   token }              // refresh OR access token
 *        → { ok }
 *
 *  ENV:
 *    GOOGLE_OAUTH_CLIENT_ID      – optional; defaults to the app's known client
 *    GOOGLE_OAUTH_CLIENT_SECRET  – REQUIRED to enable this feature. If unset,
 *                                  every call returns { ok:false, code:
 *                                  'not_configured' } and the client silently
 *                                  keeps using the legacy bridge — nothing
 *                                  breaks; the durable path is simply dormant.
 *
 *  SECURITY
 *    · The client SECRET never leaves the server. It is applied only here.
 *    · A refresh token IS itself the credential; this endpoint does exactly
 *      what Google's own token endpoint does, so it exposes nothing extra —
 *      to call `refresh` you must already possess a valid refresh token.
 *    · Tokens are NEVER logged. CORS is reflected to the caller's origin.
 *    · This is a stateless proxy: it stores NOTHING. No Admin SDK, no DB.
 * ---------------------------------------------------------------------------
 */

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// The app's OAuth 2.0 "Web application" client. Overridable via env.
const DEFAULT_CLIENT_ID =
    '1020193373377-paqvs1sgqr75l0lbcs9hju02fmouc0da.apps.googleusercontent.com';

function _applyCommonHeaders(req, res) {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        // No cookies are ever involved, so reflecting the origin (or *) is safe.
        const origin = (req && req.headers && req.headers.origin) || '';
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
    } catch (_) {}
}

async function _postForm(url, params) {
    const body = new URLSearchParams(params).toString();
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    let j = {};
    try { j = await r.json(); } catch (_) { j = {}; }
    return { ok: r.ok, status: r.status, json: j };
}

export default async function handler(req, res) {
    _applyCommonHeaders(req, res);

    const method = (req && req.method) || 'GET';
    if (method === 'OPTIONS') { try { return res.status(204).end(); } catch (_) { return; } }
    if (method !== 'POST') {
        try { res.setHeader('Allow', 'POST, OPTIONS'); } catch (_) {}
        return res.status(405).json({ ok: false, error: 'method not allowed' });
    }

    const CLIENT_ID = (process.env.GOOGLE_OAUTH_CLIENT_ID || DEFAULT_CLIENT_ID).trim();
    const CLIENT_SECRET = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();

    // Feature is dormant (and harmless) until the owner adds the secret.
    if (!CLIENT_SECRET) {
        return res.status(200).json({
            ok: false,
            code: 'not_configured',
            error: 'GOOGLE_OAUTH_CLIENT_SECRET is not set on the server'
        });
    }

    // Parse the JSON body defensively (Vercel usually parses it for us).
    let body = req && req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    if (!body || typeof body !== 'object') body = {};
    const action = String(body.action || '');

    try {
        if (action === 'exchange') {
            const code = body.code;
            const redirect_uri = body.redirect_uri;
            const code_verifier = body.code_verifier;
            if (!code || !redirect_uri) {
                return res.status(400).json({ ok: false, error: 'missing code or redirect_uri' });
            }
            const params = {
                code,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri,
                grant_type: 'authorization_code'
            };
            if (code_verifier) params.code_verifier = code_verifier;

            const out = await _postForm(GOOGLE_TOKEN_URL, params);
            if (!out.ok) {
                return res.status(200).json({
                    ok: false,
                    code: out.json.error || 'exchange_failed',
                    error: out.json.error_description || 'authorization code exchange failed'
                });
            }
            return res.status(200).json({
                ok: true,
                access_token: out.json.access_token || '',
                refresh_token: out.json.refresh_token || '',   // present on first consent
                expires_in: Number(out.json.expires_in) || 3600,
                scope: out.json.scope || ''
            });
        }

        if (action === 'refresh') {
            const refresh_token = body.refresh_token;
            if (!refresh_token) {
                return res.status(400).json({ ok: false, error: 'missing refresh_token' });
            }
            const out = await _postForm(GOOGLE_TOKEN_URL, {
                refresh_token,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'refresh_token'
            });
            if (!out.ok) {
                // 'invalid_grant' ⇒ refresh token was revoked/expired; the client
                // uses this to clear its stored token and re-authorize cleanly.
                return res.status(200).json({
                    ok: false,
                    code: out.json.error || 'refresh_failed',
                    error: out.json.error_description || 'token refresh failed'
                });
            }
            return res.status(200).json({
                ok: true,
                access_token: out.json.access_token || '',
                expires_in: Number(out.json.expires_in) || 3600,
                scope: out.json.scope || ''
            });
        }

        if (action === 'revoke') {
            const token = body.token;
            if (!token) return res.status(400).json({ ok: false, error: 'missing token' });
            let ok = false;
            try {
                const r = await fetch(GOOGLE_REVOKE_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ token }).toString()
                });
                ok = r.ok;
            } catch (_) { ok = false; }
            return res.status(200).json({ ok });
        }

        return res.status(400).json({ ok: false, error: 'unknown action' });
    } catch (e) {
        // Never leak internals or tokens.
        return res.status(200).json({ ok: false, code: 'server_error', error: 'internal error' });
    }
}
