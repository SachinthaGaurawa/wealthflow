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
    const r = await f(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });
    if (!r.ok) throw new Error('token refresh rejected');  // never includes the token
    const out = await r.json();
    if (!out.access_token) throw new Error('token refresh returned no access token');
    return out.access_token;
}

/** `Authorization: Bearer …`, the one place that header is spelled. */
export const authed = (token) => ({ Authorization: `Bearer ${token}` });
