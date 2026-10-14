/* =============================================================================
 * gmail-auth-state.mjs — a Gmail sign-in that Google has turned down is seen, shown to the owner, and not hammered
 * -----------------------------------------------------------------------------
 * Production, 2026-10-13 04:23 UTC: the automatic statement sync asked Google for an access token with the saved refresh token and was refused (`statement-sync-failed { reason: 'token refresh
 * rejected' }`, once). Nothing else happened: the owner's Gmail card still said "Connected", the next push from Google would have been answered 500 (so Pub/Sub retries it for days), and nobody
 * could tell a token Google had revoked from one it had briefly failed to check.
 *
 * Every place that spends the refresh token now goes through `mintAccessToken`:
 *   · A DEFINITE REFUSAL (Google's 400/401/403 — the token was revoked, expired or never valid, or the app's own OAuth client was turned down) is written on the mailbox document (`gmailAuth`) with its
 *     kind and the time, the owner is told once a day through the alert webhook when one is set, and the app's Gmail card says so (gmail-link.mjs `statusOf`).
 *   · A TIMEOUT, A 429 OR A GOOGLE 5xx IS NOT A REFUSAL. It marks nothing and is thrown as it always was: it mends itself.
 *   · WHILE MARKED, GOOGLE IS NOT ASKED AGAIN FOR A WHILE (6 h, then 12 h, then once a day): a push, the schedule and an open app all stop spending a request on a token that cannot work. The
 *     occasional probe is also what un-marks the mailbox if the refusal was a one-off (the observed one was): the first token that is minted clears the mark.
 *   · NOTHING IS DELETED. The refresh token stays where it is, so disconnecting (which removes it) and connecting again (which writes a new one and clears this mark) remain the owner's decision.
 *   · NO TOKEN, NO ADDRESS, NO GOOGLE TEXT is logged, stored or sent: the record carries a kind, a Google error word from a fixed list, a status number and times.
 * ===========================================================================*/

import { accessTokenFrom } from './google-oauth.mjs';
import { postAlert } from './sms-guard.mjs';

/** What every caller throws (and the app is told) while the mailbox needs the owner. */
export const RECONNECT_REASON = 'gmail-reconnect-required';
export const AUTH_FIELD = 'gmailAuth';
export const PROBE_FIRST_MS = 6 * 3600e3, PROBE_MAX_MS = 24 * 3600e3, ALERT_EVERY_MS = 24 * 3600e3;

const num = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

/**
 * What a failed exchange was.
 * @returns {'transient'|'revoked'|'client'|'rejected'|'other'} `revoked`: Google says the grant is gone (reconnecting mends it); `client`: Google turned down the app's own OAuth client id/secret (reconnecting does NOT mend it — the server's settings do);
 *   `rejected`: a 400/401/403 that says nothing more; `other`: no verdict (nothing is marked)
 */
export function classify(error) {
    if (!error) return 'other';
    if (error.transient === true) return 'transient';
    const code = String(error.code || ''), status = num(error.status);
    if (code === 'invalid_grant') return 'revoked';
    if (code === 'invalid_client' || code === 'unauthorized_client') return 'client';
    if (status === 400 || status === 401 || status === 403) return 'rejected';
    return 'other';
}

/** The stored mark, with every field present and numeric — or null when the mailbox is not marked. */
export function authOf(doc) {
    const raw = doc && doc[AUTH_FIELD];
    if (!raw || typeof raw !== 'object' || !raw.kind) return null;
    return { kind: String(raw.kind), since: num(raw.since), lastAt: num(raw.lastAt), attempts: Math.max(1, num(raw.attempts)), alertedAt: num(raw.alertedAt), code: String(raw.code || ''), status: num(raw.status) };
}

/** How long Google is left alone after the n-th refusal in a row. */
export const probeGapMs = attempts => Math.min(PROBE_MAX_MS, PROBE_FIRST_MS * 2 ** Math.max(0, num(attempts) - 1));

/** May Google be asked again now? Always when the mailbox is not marked; otherwise once the back-off has passed. */
export const mayAsk = (auth, now = Date.now()) => !auth || now - auth.lastAt >= probeGapMs(auth.attempts);

/** The record after another refusal: `since` stays at the first one, the count grows, the alert mark is kept. */
export function afterRefusal(auth, error, now = Date.now()) {
    const kind = classify(error);
    return { kind, since: auth ? auth.since : now, lastAt: now, attempts: (auth ? auth.attempts : 0) + 1, alertedAt: auth ? auth.alertedAt : 0, code: String(error && error.code || ''), status: num(error && error.status) };
}

/** What the app may be told: whether the owner must reconnect, why, and since when. Nothing of the token or of Google's answer. */
export function publicAuth(doc) {
    const auth = authOf(doc);
    if (!auth) return { needsReconnect: false };
    return { needsReconnect: auth.kind !== 'client', authProblem: auth.kind, authProblemSince: auth.since || null };
}

const ALERT_TEXT = {
    client: 'WealthFlow Gmail: Google turned down the app\'s OAuth client (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET on the server). Statements from the mailbox will not arrive until it is fixed there; reconnecting Gmail will not help.',
    other: 'WealthFlow Gmail: Google rejected the saved Gmail sign-in. Statements from the mailbox will not arrive until Gmail is reconnected: open WealthFlow, Statement Sync, disconnect the mailbox and connect it again.',
};

/** The error every caller sees while the mailbox needs the owner: the same words whether Google was just asked or left alone. */
export function reconnectError(auth, { backedOff = false } = {}) {
    return Object.assign(new Error(RECONNECT_REASON), { reconnect: true, transient: false, backedOff, kind: auth ? auth.kind : 'rejected' });
}

/** The one sentence the app shows for a refused sign-in: reconnecting mends a revoked token, not an OAuth client the server's settings got wrong. */
export const refusalText = error => (error && error.kind === 'client'
    ? 'Google turned down the app\'s OAuth settings (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET on the server). Reconnecting will not help; the server\'s settings need to be checked.'
    : 'Gmail refused the saved token. Disconnect and connect the mailbox again.');

/**
 * An access token for the mailbox, or an error: the exchange's own (a timeout, a 5xx — unchanged), or `gmail-reconnect-required` when Google has refused the saved sign-in.
 * Writes only the `gmailAuth` field of the mailbox document (a refusal sets it, the first token that works clears it). Never throws for a failed write or a failed alert.
 * @param {object} o
 * @param {object} o.ref the mailbox document reference (where the mark is written)
 * @param {object} o.mail what that document held when the caller read it (`refresh_token`, and `gmailAuth` if marked)
 */
export async function mintAccessToken({ ref, mail, env = process.env, f = fetch, now = Date.now(), mint = accessTokenFrom, alert = postAlert, log = console.warn }) {
    const auth = authOf(mail);
    if (!mayAsk(auth, now)) throw reconnectError(auth, { backedOff: true });
    let token;
    try {
        token = await mint(mail.refresh_token, env, f);
    } catch (error) {
        const kind = classify(error);
        if (kind === 'transient' || kind === 'other') throw error;                       // not a verdict: nothing is marked, the caller handles it as before
        const next = afterRefusal(auth, error, now);
        // told once a day; marked as told only when the post reached the endpoint, so a webhook that was down is tried again at the next refusal
        if (now - next.alertedAt >= ALERT_EVERY_MS) {
            try { const sent = await alert({ env, text: kind === 'client' ? ALERT_TEXT.client : ALERT_TEXT.other, extra: { kind } }); if (sent && sent.sent) next.alertedAt = now; } catch (_) { /* an alert never stops the caller */ }
        }
        try { if (ref && typeof ref.set === 'function') await ref.set({ [AUTH_FIELD]: next }, { merge: true }); } catch (_) { /* the refusal is still thrown */ }
        try { log(JSON.stringify({ evt: 'gmail-auth-refused', kind, code: next.code, status: next.status, attempts: next.attempts, firstAt: next.since })); } catch (_) { /* a log line never stops a sync */ }
        throw reconnectError(next);
    }
    if (auth) { try { if (ref && typeof ref.set === 'function') await ref.set({ [AUTH_FIELD]: null }, { merge: true }); } catch (_) { /* the next token clears it */ } }
    return token;
}

export default { RECONNECT_REASON, AUTH_FIELD, classify, authOf, probeGapMs, mayAsk, afterRefusal, publicAuth, reconnectError, refusalText, mintAccessToken };
