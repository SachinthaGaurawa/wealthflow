/* =============================================================================
 * google-oauth.mjs — one refresh-token exchange, for everything that needs one
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * gmail-hook.js owned the only copy of this. /api/gmail-watch needs the same
 * exchange — the same client id, the same secret, the same refusal to put a
 * token in an error message — and a second copy of a credential-handling policy
 * is one more than can be kept in step. That is the reasoning that extracted
 * fetch-timeout.mjs and then admin-db.mjs; this is the same shape.
 *
 * NOTHING HERE EVER RETURNS OR LOGS A TOKEN. The errors say what failed and
 * name no value: an error that quotes the credential it was given is how a
 * secret reaches a log line, and a log line is forever.
 * ===========================================================================*/

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** The `error` words Google's token endpoint answers with (RFC 6749 §5.2); anything else it says is not carried. */
const GOOGLE_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope', 'access_denied', 'unsupported_grant_type']);

/**
 * Which of Google's two `invalid_grant` sentences it was — the one thing in `error_description` that changes what the owner must do, and never the free text itself (it can echo what was sent).
 *   `expired`: "Token has been expired or revoked" — the grant existed and is gone (a consent screen in Testing expires refresh tokens after 7 days; a password change or "remove access" revokes them).
 *   `mismatch`: "Bad Request" — the token was not issued to the OAuth client the server uses (a token made in the OAuth Playground without "Use your own OAuth credentials" is the usual cause), or it was cut short when pasted.
 * Anything else is '' and the caller says only what it knew before.
 * @returns {'expired'|'mismatch'|''}
 */
export function hintFrom(description) {
    const text = typeof description === 'string' ? description.trim() : '';
    if (/expired or revoked/i.test(text)) return 'expired';
    if (/^bad request\.?$/i.test(text)) return 'mismatch';
    return '';
}

/**
 * Exchange a refresh token for a short-lived access token.
 *
 * `fetchImpl` is injected so a suite can exercise callers without a network —
 * every test in this repository is hard-blocked from one after a probe once
 * created four documents in the live database.
 */
export async function accessTokenFrom(refreshToken, env, fetchImpl) {
    const f = fetchImpl || fetch;
    const body = new URLSearchParams({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    });
    /* `transient` tells a caller the exchange may succeed if repeated (timeout, lost connection, 429/5xx) from a refresh token Google has
     * actually rejected (400/401/403: revoked or expired), which repeating cannot mend. */
    let r;
    try {
        r = await f(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: AbortSignal.timeout(8000),
        });
    } catch (_) { throw Object.assign(new Error('token refresh unreachable'), { transient: true }); }
    if (!r.ok) {
        /* WHICH rejection it was, for the one caller that has to tell a revoked token from a wrong client (gmail-auth-state.mjs). Google's own `error` word
         * ("invalid_grant"…) is kept only when it is one of the known ones — nothing else of the answer, and never the token. */
        let code = '', hint = '';
        try {
            const said = typeof r.json === 'function' ? await r.json() : null;
            code = said && typeof said.error === 'string' && GOOGLE_ERRORS.has(said.error) ? said.error : '';
            hint = hintFrom(said && said.error_description);
        } catch (_) { /* the status is enough */ }
        throw Object.assign(new Error('token refresh rejected'), { transient: r.status === 429 || r.status >= 500, status: Number(r.status) || 0, ...(code ? { code } : {}), ...(hint ? { hint } : {}) });  // never includes the token
    }
    const out = await r.json();
    if (!out.access_token) throw new Error('token refresh returned no access token');
    return out.access_token;
}

/** `Authorization: Bearer …`, the one place that header is spelled. */
export const authed = (token) => ({ Authorization: `Bearer ${token}` });
