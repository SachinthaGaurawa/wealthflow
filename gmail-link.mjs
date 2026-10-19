/* =============================================================================
 * gmail-link.mjs — connecting a mailbox, and the decisions that involves
 * -----------------------------------------------------------------------------
 * gmail-hook.js can fetch statements from Gmail the moment it has a refresh
 * token, and it reads that token from Firestore at
 *
 *     wf-mail/{userKey}.refresh_token          (gmail-hook.js:212)
 *
 * Nothing in this repository has ever written that field. Every environment
 * variable a person could set — GMAIL_REFRESH_TOKEN included — is read by
 * nobody: gmail-hook.js reads exactly four, and the token is not one of them.
 * So the pipeline could not run no matter how carefully it was configured, and
 * the Statement Sync card was correct to say "not connected".
 *
 * ── WHY THE CLIENT CANNOT JUST WRITE IT ─────────────────────────────────────
 *
 * firestore.rules ends with `match /{document=**} { allow read, write: if false }`
 * and has no entry for wf-mail, so that branch is sealed to every client, signed
 * in or not. That is the correct posture and this file does not change it: the
 * branch holds a credential that can read a person's entire mailbox.
 *
 * It also means a client cannot READ it either — which is a defect this file
 * fixes as well. The connected-check shipped in the Statement Sync card queried
 * wf-mail directly from the page, so it was always denied, always caught, and
 * always reported "not connected". It would have said that even with a mailbox
 * fully connected, because it could never see the answer.
 *
 * So both directions go through the server, which reaches Firestore with the
 * Admin SDK and bypasses rules — the same mechanism inbox-store.mjs uses for
 * wf-inbox, and for the same reason.
 *
 * ── WHAT IS PURE HERE, AND WHY ──────────────────────────────────────────────
 *
 * Everything that decides something: who the caller is, which document their
 * identity maps to, whether a token is plausible, and what may be told back.
 * None of it needs Firestore or a network, and all of it is worth testing —
 * particularly the part that decides a caller may only ever touch their OWN
 * mailbox, which is the whole boundary once rules stop having a vote.
 * ===========================================================================*/

import { publicAuth } from './gmail-auth-state.mjs';

/** The state document root. Must match gmail-hook.js exactly. */
export const MAIL_ROOT = 'wf-mail';

export const LINK = {
    OK: 'ok',
    NO_TOKEN: 'no-bearer-token',
    BAD_IDENTITY: 'identity-unverified',
    NO_EMAIL: 'no-verified-email',
    BAD_REFRESH: 'refresh-token-implausible',
    NOT_CONFIGURED: 'oauth-not-configured',
};

/**
 * The Firestore document key for an email address.
 *
 * COPIED CHARACTER FOR CHARACTER from gmail-hook.js:202, including the fact
 * that it does NOT lower-case first — so `A` becomes `_` rather than `a`. That
 * is arguably wrong, and it is not this file's to change: the two sides must
 * agree, the other one is the writer of everything else in the document, and a
 * "fix" here would silently point at a different document than the hook uses.
 * A test asserts both spellings stay identical.
 */
export function userKeyFor(email) {
    return String(email || '').replace(/[^a-z0-9]/g, '_');
}

/** The bearer credential, or ''. */
export function bearerOf(req) {
    try {
        const h = (req && req.headers) || {};
        const raw = h.authorization || h.Authorization || '';
        const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
        return m ? m[1].trim() : '';
    } catch (_) { return ''; }
}

/**
 * Who is calling, established from a Firebase ID token and nothing else.
 *
 * `verifyIdToken` is injected, exactly as release-brain.js does it, so the
 * decision can be tested without the Admin SDK or a network.
 *
 * THE EMAIL MUST BE VERIFIED. An unverified address on a token is a string the
 * account holder typed, and this function converts an address directly into the
 * document key whose credential is being read or replaced. Accepting an
 * unverified one would let anybody who can sign up claim any mailbox by naming
 * it — the entire boundary, defeated at the first step.
 */
export async function identify(req, { verifyIdToken = null } = {}) {
    const token = bearerOf(req);
    if (!token) return { ok: false, reason: LINK.NO_TOKEN, status: 401 };
    if (typeof verifyIdToken !== 'function') {
        return { ok: false, reason: LINK.BAD_IDENTITY, status: 503 };
    }
    let decoded;
    try {
        decoded = await verifyIdToken(token);
    } catch (_) {
        return { ok: false, reason: LINK.BAD_IDENTITY, status: 401 };
    }
    const email = String((decoded && decoded.email) || '').trim().toLowerCase();
    const verified = decoded && (decoded.email_verified === true || decoded.email_verified === 'true');
    if (!email || !verified) return { ok: false, reason: LINK.NO_EMAIL, status: 403 };
    return { ok: true, email, uid: String((decoded && decoded.uid) || ''), userKey: userKeyFor(email) };
}

/**
 * Is this plausibly a Google refresh token?
 *
 * Deliberately a SHAPE check and nothing more. Only Google can say whether a
 * token is valid, and asking it here would mean this endpoint could be used to
 * test tokens. What this rejects is the mistake a person actually makes: pasting
 * an access token, an authorization code, a client secret, or the whole JSON
 * blob from the OAuth playground, and then wondering why nothing syncs.
 */
export function looksLikeRefreshToken(v) {
    const s = String(v == null ? '' : v).trim();
    if (s.length < 20 || s.length > 512) return false;
    if (/\s/.test(s)) return false;                       // a pasted blob
    if (s.startsWith('{') || s.startsWith('[')) return false;
    if (s.startsWith('ya29.')) return false;              // an ACCESS token
    if (s.startsWith('4/')) return false;                 // an authorization CODE
    if (/^GOCSPX-/.test(s)) return false;                 // a client SECRET
    if (s.split('.').length > 3) return false;            // an ID token / JWT
    return /^1\/\/|^[\w-]+$/.test(s);                     // Google's shape, or opaque
}

/**
 * What to store when a mailbox is linked.
 *
 * `historyId` is deliberately absent. gmail-hook.js treats its presence as "I
 * have already seen everything up to here" and asks Gmail only for what came
 * after, so writing one now would skip whatever arrives between connecting and
 * the first push.
 *
 * CORRECTION. This comment used to add "leaving it unset makes the first push
 * start from the beginning". That was wrong. With no bookmark the hook falls
 * back to the PUSH's own historyId — the mailbox's current point — and
 * history.list returns changes after it. Unset means the first push starts from
 * NOW, not from the beginning, and no value of this field could have produced a
 * backfill: reading the past needs a search, not a bookmark. That is
 * /api/gmail-scan, and the claim is corrected here because it was believed
 * twice and shaped a decision in gmail-watch.mjs as well.
 */
export function linkRecord(email, refreshToken, now = Date.now()) {
    return {
        refresh_token: String(refreshToken),
        email: String(email),
        linkedAt: now,
    };
}

/* ── THE "CONNECT GMAIL" BUTTON: GOOGLE'S OWN CONSENT SCREEN, THEN THIS ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Until now the only way in was to make a refresh token by hand in the OAuth Playground and paste it. That works for the owner and cannot be the product: a person who is not a developer is never going to
 * do it, and Google's verification review wants to SEE the consent screen the user goes through, with the scope, the app name and the client id.
 *
 * The page sends the browser to Google (full-page redirect, PKCE, scope gmail.readonly and nothing else, access_type=offline). Google sends it back to the site's own address with a one-time `code`. The page
 * hands that code here and the SERVER exchanges it, because only the server holds the client secret. What is stored is exactly what the paste box stores; the only difference is where the token came from.
 */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
/** The only addresses the code may have been issued for. Google already refuses a redirect_uri that is not registered on the OAuth client; this keeps a stray one (a preview deployment, a typo) from ever reaching the exchange. */
export const CONSENT_REDIRECTS = Object.freeze(['https://www.wealthflow.lk/', 'https://wealthflow.lk/']);

/** Shape only, like looksLikeRefreshToken: Google's codes are opaque, URL-safe, a few dozen to a few hundred characters. */
export function looksLikeAuthCode(v) {
    const s = String(v == null ? '' : v).trim();
    return s.length >= 10 && s.length <= 2048 && /^[\w\-./~%]+$/.test(s);
}
/** RFC 7636: 43 to 128 characters from the unreserved set. */
export function looksLikeCodeVerifier(v) {
    return typeof v === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
}

/**
 * Turn a consent-screen result into a refresh token, or into the sentence that says what to do.
 *
 * `exchange` is google-oauth.mjs `exchangeCode`, injected so this stays testable without a network. Nothing returned or thrown here ever contains the code, the verifier or a token.
 * @returns {Promise<{ok:true, token:string} | {ok:false, status:number, error:string, kind:string}>}
 */
export async function redeemConsent({ body, env = {}, exchange }) {
    const fail = (status, kind, error) => ({ ok: false, status, kind, error });
    const code = body && typeof body.code === 'string' ? body.code.trim() : '';
    if (!looksLikeAuthCode(code)) return fail(400, 'bad-code', 'that does not look like a Google authorization code. Press Connect Gmail again.');
    const redirectUri = body && typeof body.redirect_uri === 'string' ? body.redirect_uri.trim() : '';
    if (!CONSENT_REDIRECTS.includes(redirectUri)) return fail(400, 'bad-redirect', 'that return address is not one WealthFlow uses. Open WealthFlow at https://www.wealthflow.lk and try again.');
    const verifier = body && body.code_verifier != null ? body.code_verifier : '';
    if (verifier !== '' && !looksLikeCodeVerifier(verifier)) return fail(400, 'bad-verifier', 'the sign-in check value is malformed. Press Connect Gmail again.');
    if (!oauthConfigured(env)) return fail(503, 'not-configured', 'Google sign-in is not set up on the server yet (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are required).');

    let got;
    try {
        got = await exchange({ code, redirectUri, codeVerifier: verifier || undefined, env });
    } catch (e) {
        if (e && e.transient) return fail(503, 'transient', 'Google did not answer in time. Press Connect Gmail again in a moment.');
        const word = String((e && e.code) || '');
        if (word === 'invalid_grant') return fail(422, 'code-used', 'Google turned that sign-in down: the code was already used or has expired. Press Connect Gmail and approve again.');
        if (word === 'redirect_uri_mismatch') return fail(422, 'redirect-mismatch', 'Google says this return address is not registered on the OAuth client. Add ' + redirectUri + ' under Authorized redirect URIs in Google Cloud, then try again.');
        if (word === 'invalid_client' || word === 'unauthorized_client') return fail(422, 'client', 'Google does not accept the OAuth client the server is using. GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must belong to the same client the sign-in used.');
        return fail(422, 'rejected', 'Google did not accept that sign-in. Press Connect Gmail and try again.');
    }

    const granted = String((got && got.scope) || '').split(/\s+/);
    if (!granted.includes(GMAIL_SCOPE)) return fail(422, 'scope-missing', 'The Gmail permission was not ticked on Google\'s screen, and WealthFlow cannot read statements without it. Press Connect Gmail and leave "View your email messages and settings" ticked.');
    const token = got && typeof got.refreshToken === 'string' ? got.refreshToken.trim() : '';
    if (!looksLikeRefreshToken(token)) return fail(422, 'no-refresh', 'Google did not hand back a long-lived sign-in. Open myaccount.google.com/permissions, remove WealthFlow, then press Connect Gmail again.');
    return { ok: true, token };
}

/**
 * What the client is allowed to learn.
 *
 * NEVER the token, not even a prefix of it. The page needs one bit — is a
 * mailbox connected — plus enough to show when and which address, and a length
 * or a first few characters would turn this endpoint into a way to read back a
 * credential a few bits at a time.
 */
/* Where the owner's statement-sender list lives.
 *
 * The SAME sealed document as the refresh token, and for the same reason it
 * cannot live on the device: the two things that consult it are the push hook
 * and the scan endpoint, and neither has a browser in front of it. A webhook
 * fired by Google has no client to ask.
 *
 * It is not a credential and it is not treated as one — but it is not nothing
 * either. It names the institutions somebody banks with, which is why it goes
 * behind the same identity boundary rather than somewhere more convenient, and
 * why gmail-link.js derives the document key from a VERIFIED email and from
 * nothing the caller sends. */
export const SENDERS_FIELD = 'senders';

/* Where refused-but-recoverable messages wait. Beside the sender list on the
 * same document, because the two are read and written together: the list is
 * what refused them and approving on the list is what releases them. */
export const HELD_FIELD = 'held';

/** At most this many. A junk mailbox must not be able to fill a database. */
export const MAX_HELD = 200;

/**
 * Merge newly held references into what is already stored.
 *
 * NEWEST FIRST, DE-DUPLICATED BY MESSAGE ID, BOUNDED. A push and a scan can see
 * the same message — redelivery is normal — and a held list that grew a row per
 * delivery would report one refused statement as fifty.
 *
 * `heldMs` is stamped HERE rather than at the call site so every entry carries
 * one, including those written by a caller that forgot.
 */
export function mergeHeld(existing, incoming, now = Date.now()) {
    const out = [];
    const at = new Map();
    const push = (h) => {
        if (!h || typeof h !== 'object') return;
        const key = String(h.messageId || h.key || '').trim();
        if (!key) return;
        const stamp = Number(h.heldMs) > 0 ? Number(h.heldMs) : now;
        if (at.has(key)) {
            /* SEEN BEFORE. Keep the EARLIEST stamp: what matters about a held
             * message is when it was first refused, not when it was most
             * recently redelivered. Overwriting it made every held statement
             * look like it arrived today, so "held since the 3rd" — the thing
             * that tells the owner how long they have been missing it — could
             * never be shown. */
            const row = out[at.get(key)];
            row.heldMs = Math.min(row.heldMs, stamp);
            return;
        }
        at.set(key, out.length);
        out.push({ ...h, key, messageId: key, heldMs: stamp });
    };
    for (const h of (Array.isArray(incoming) ? incoming : [])) push(h);
    for (const h of (Array.isArray(existing) ? existing : [])) push(h);
    return out.slice(0, MAX_HELD);
}

/** The held list off a stored document, cleaned. */
export function heldOf(state) {
    return mergeHeld(state && state[HELD_FIELD], []);
}

/* Mail from a sender the owner APPROVED that was nevertheless not taken: a
 * signature that did not verify, an attachment the veto read as an invoice, too
 * many or too large. Held mail (above) waits on a decision about the SENDER; this
 * waits on a decision about the MESSAGE, and is kept for the same reason — a
 * statement that is refused and forgotten is a statement that silently never
 * appears. Each entry names the intake rules it was judged under (`v`), so a later
 * improvement to those rules re-examines exactly these messages. */
export const REFUSED_FIELD = 'refused';
export const MAX_REFUSED = 100;

/**
 * Merge newly refused references into what is stored; drop the ones that have
 * since been taken. Newest first, one per message id, bounded, earliest `at` kept.
 */
export function mergeRefused(existing, incoming, cleared = [], now = Date.now()) {
    const gone = new Set((Array.isArray(cleared) ? cleared : []).map(String));
    const out = [], at = new Map();
    const push = (h) => {
        if (!h || typeof h !== 'object') return;
        const key = String(h.messageId || '').trim();
        if (!key || gone.has(key)) return;
        const stamp = Number(h.at) > 0 ? Number(h.at) : now;
        if (at.has(key)) { const row = out[at.get(key)]; row.at = Math.min(row.at, stamp); return; }
        at.set(key, out.length);
        out.push({ ...h, messageId: key, at: stamp });
    };
    for (const h of (Array.isArray(incoming) ? incoming : [])) push(h);
    for (const h of (Array.isArray(existing) ? existing : [])) push(h);
    return out.slice(0, MAX_REFUSED);
}

export const refusedOf = (state) => mergeRefused(state && state[REFUSED_FIELD], []);

/* Mail that CLAIMED to be from a bank the owner approved (or from a listed bank) and failed the sender checks — SPF,
 * DKIM, DMARC, a second From line, a lookalike domain. A separate list from `refused` on purpose: that one offers
 * "take it", this one never does. Bounded, newest first, one entry per message id. */
export const SECURITY_FIELD = 'security';
export const MAX_SECURITY = 100;
export function mergeSecurity(existing, incoming, now = Date.now()) {
    const out = [], at = new Map();
    const push = (h) => {
        if (!h || typeof h !== 'object') return;
        const key = String(h.messageId || '').trim();
        if (!key) return;
        const stamp = Number(h.at) > 0 ? Number(h.at) : now;
        if (at.has(key)) { const row = out[at.get(key)]; row.at = Math.min(row.at, stamp); return; }
        at.set(key, out.length);
        out.push({ ...h, messageId: key, at: stamp });
    };
    for (const h of (Array.isArray(incoming) ? incoming : [])) push(h);
    for (const h of (Array.isArray(existing) ? existing : [])) push(h);
    return out.slice(0, MAX_SECURITY);
}
export const securityOfState = (state) => mergeSecurity(state && state[SECURITY_FIELD], []);

/** The stored sender list, defaulted so a document written before it existed
 *  reads as "nothing decided yet" rather than as an error. */
export function sendersOf(doc) {
    const v = doc && doc[SENDERS_FIELD];
    return Array.isArray(v) ? v : [];
}

export function statusOf(doc) {
    const d = doc || null;
    if (!d || !d.refresh_token) return { connected: false };
    return {
        connected: true,
        email: String(d.email || ''),
        linkedAt: Number(d.linkedAt) || null,
        // Present only once the hook has actually run, so the page can tell
        // "linked" from "linked and working".
        lastPushMs: Number(d.lastPushMs) || null,
        historyId: d.historyId ? String(d.historyId) : null,
        /* Reported so the card can say "no senders approved yet" — the state
         * where the scanner is still guessing and the owner has a decision to
         * make — instead of looking identical to a curated one. */
        senderCount: sendersOf(d).filter((e) => e && e.status === 'approved').length,
        /* Whether Google has turned the saved sign-in down (gmail-auth-state.mjs): the card says so, in red, instead of "Connected". Never more than a kind and a time. */
        ...publicAuth(d),
    };
}

/** Is the OAuth client configured at all? Without it the token cannot be spent. */
export function oauthConfigured(env = {}) {
    return !!(String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim()
           && String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim());
}

/**
 * Everything the owner still has to set for a push to arrive and verify.
 *
 * Reported so the Statement Sync card can say WHICH piece is missing instead of
 * "not connected", which is the sentence that sent somebody reading the source
 * to find out why.
 */
export function missingConfig(env = {}) {
    const missing = [];
    if (!String(env.GOOGLE_OAUTH_CLIENT_ID || '').trim()) missing.push('GOOGLE_OAUTH_CLIENT_ID');
    if (!String(env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim()) missing.push('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!String(env.GMAIL_PUBSUB_AUDIENCE || '').trim()) missing.push('GMAIL_PUBSUB_AUDIENCE');
    return missing;
}

const API = {
    MAIL_ROOT, LINK,
    userKeyFor, bearerOf, identify, looksLikeRefreshToken,
    linkRecord, statusOf, oauthConfigured, missingConfig,
    GMAIL_SCOPE, CONSENT_REDIRECTS, looksLikeAuthCode, looksLikeCodeVerifier, redeemConsent,
};

export default API;
