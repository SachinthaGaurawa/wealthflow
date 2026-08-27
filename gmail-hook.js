/* =============================================================================
 * gmail-hook.js — the Pub/Sub push endpoint for bank statement mail
 * -----------------------------------------------------------------------------
 * Gmail publishes a notification when the watched mailbox changes. This receives
 * that push, asks Gmail what changed, and stores any bank statement PDF —
 * STILL ENCRYPTED — where the user's own device will find it.
 *
 * It never decrypts. It has no vault key and no way to obtain one; the passwords
 * live only on the device, which is the trade this whole design is built around
 * (see wealthflow-mail-intake.js).
 *
 * ── THE DECISIONS ARE NOT IN THIS FILE ──────────────────────────────────────
 *
 * Which sender counts as a bank, whether the signature holds, which attachment
 * to take, how to split it — all of that is wealthflow-mail-ingest.mjs, which is
 * pure and has 55 tests. This file is the glue: verify the caller, fetch the
 * bytes, apply the plan, record where we got to. That split is deliberate. An
 * endpoint cannot be unit-tested without a mailbox and a Google Cloud project;
 * the logic worth testing therefore does not live in one.
 *
 * ── WHY THE OIDC CHECK IS THE WHOLE SECURITY BOUNDARY ───────────────────────
 *
 * This URL is public. Without verification, anyone who learns it can POST a
 * crafted envelope and make this endpoint read a mailbox and write to the
 * database, as often as they like. Pub/Sub signs each push with an OIDC token
 * naming the service account and the audience configured on the subscription;
 * that token is the only thing distinguishing Google from anyone else.
 *
 * It is verified against Google's tokeninfo endpoint rather than by decoding the
 * JWT here. That costs a round trip per push, and buys not having to implement
 * signature verification, key rotation and clock skew in this file — three
 * things that are easy to write and hard to write correctly, and where a subtle
 * error fails OPEN. The audience and the issuer are then checked against
 * configured values; a token that is genuine but was minted for somebody else's
 * service is not a token for us.
 *
 * ── AT-LEAST-ONCE IS THE NORMAL CASE, NOT AN ERROR ──────────────────────────
 *
 * Pub/Sub redelivers on timeout, on a non-2xx, and after a restart. Every write
 * is keyed on (messageId, attachmentId), so a redelivery rewrites the same
 * document and changes nothing. The endpoint therefore answers 204 even for a
 * message it decided to ignore: a 500 would have Pub/Sub retry a decision that
 * will not change, backing off to hours and eventually dropping it.
 *
 * A genuine, retryable failure — Gmail unreachable, Firestore down — DOES return
 * 500, because that one is worth retrying.
 *
 * Env: GMAIL_PUBSUB_AUDIENCE, GMAIL_PUBSUB_SA, GOOGLE_OAUTH_CLIENT_ID,
 *      GOOGLE_OAUTH_CLIENT_SECRET, FIREBASE_SERVICE_ACCOUNT
 * ===========================================================================*/

import { planMessage, planWrite, isWorthTelling, REJECT_TEXT } from './wealthflow-mail-ingest.mjs';
import { getInboxDb } from './inbox-store.mjs';

const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Where a statement waits for a device. User-scoped: any device may claim it. */
export const MAIL_ROOT = 'wf-mail';

const j = (res, code, body) => res.status(code).json(body);

/* ── 1. is this really Google? ────────────────────────────────────────────── */

/**
 * Verify the Pub/Sub OIDC token.
 *
 * Fails closed on every path: a missing header, a token tokeninfo rejects, a
 * wrong audience, a wrong issuer, an unexpected service account, or a network
 * error all return false. There is deliberately no "could not check, carry on"
 * branch — that branch is how a boundary becomes decorative.
 */
export async function verifyPush(authHeader, env, fetchImpl) {
    const f = fetchImpl || fetch;
    const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || '').trim());
    if (!m) return { ok: false, reason: 'no-bearer-token' };

    const audience = env.GMAIL_PUBSUB_AUDIENCE;
    if (!audience) return { ok: false, reason: 'audience-not-configured' };

    let info;
    try {
        const r = await f(TOKENINFO + encodeURIComponent(m[1]));
        if (!r.ok) return { ok: false, reason: 'token-rejected' };
        info = await r.json();
    } catch (_) {
        return { ok: false, reason: 'tokeninfo-unreachable' };
    }

    if (info.aud !== audience) return { ok: false, reason: 'wrong-audience' };
    if (info.iss !== 'https://accounts.google.com' && info.iss !== 'accounts.google.com') {
        return { ok: false, reason: 'wrong-issuer' };
    }
    if (info.email_verified !== true && info.email_verified !== 'true') {
        return { ok: false, reason: 'unverified-identity' };
    }
    // Pin the service account when one is configured: a valid Google token
    // minted for a different project is still not ours.
    const sa = env.GMAIL_PUBSUB_SA;
    if (sa && info.email !== sa) return { ok: false, reason: 'wrong-service-account' };

    const exp = Number(info.exp) * 1000;
    if (Number.isFinite(exp) && exp < Date.now()) return { ok: false, reason: 'expired' };

    return { ok: true, email: info.email };
}

/* ── 2. what did Pub/Sub say? ─────────────────────────────────────────────── */

/** `{ message: { data: base64(JSON) } }` → the decoded notification, or null. */
export function decodeEnvelope(body) {
    const data = body && body.message && body.message.data;
    if (typeof data !== 'string' || !data) return null;
    try {
        const json = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
        if (!json || typeof json !== 'object') return null;
        const historyId = String(json.historyId || '');
        const emailAddress = String(json.emailAddress || '').toLowerCase();
        if (!historyId || !emailAddress) return null;
        return { historyId, emailAddress, messageId: (body.message.messageId || null) };
    } catch (_) {
        return null;
    }
}

/* ── 3. talking to Gmail ──────────────────────────────────────────────────── */

async function accessTokenFrom(refreshToken, env, f) {
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

const authed = (token) => ({ Authorization: `Bearer ${token}` });

/**
 * The message ids added since `startHistoryId`.
 *
 * A history id older than Gmail's retention window returns 404, which is NOT an
 * error — it means "too much has happened, ask again from scratch". Treating it
 * as a failure would retry the same doomed request forever; the caller falls
 * back to a bounded recent listing instead.
 */
export async function messagesSince(token, startHistoryId, f) {
    const url = `${GMAIL}/history?startHistoryId=${encodeURIComponent(startHistoryId)}`
        + '&historyTypes=messageAdded&maxResults=200';
    const r = await f(url, { headers: authed(token) });
    if (r.status === 404) return { ok: false, reason: 'history-too-old' };
    if (!r.ok) return { ok: false, reason: 'history-unavailable', status: r.status };
    const out = await r.json();
    const ids = new Set();
    for (const h of out.history || []) {
        for (const a of h.messagesAdded || []) if (a.message && a.message.id) ids.add(a.message.id);
    }
    return { ok: true, ids: [...ids], historyId: out.historyId || startHistoryId };
}

/** The fallback when history is too old: the most recent messages, bounded. */
export async function recentMessages(token, f, max = 25) {
    const r = await f(`${GMAIL}/messages?maxResults=${max}&q=has:attachment`, { headers: authed(token) });
    if (!r.ok) return { ok: false, reason: 'list-unavailable', status: r.status };
    const out = await r.json();
    return { ok: true, ids: (out.messages || []).map((m) => m.id) };
}

/* ── 4. the handler ───────────────────────────────────────────────────────── */

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return j(res, 405, { ok: false, error: 'POST only' });

    const env = process.env;
    const f = globalThis.fetch;

    const who = await verifyPush(req.headers && req.headers.authorization, env, f);
    if (!who.ok) {
        // 403, not 401: there is no credential the caller could supply to make
        // this work, so inviting a retry would be misleading.
        return j(res, 403, { ok: false, error: 'push not verified', reason: who.reason });
    }

    const note = decodeEnvelope(req.body);
    if (!note) return j(res, 204, { ok: true, skipped: 'unreadable-envelope' });

    const db = await getInboxDb();
    if (!db || db.error) return j(res, 500, { ok: false, error: 'database unavailable' });

    const userKey = note.emailAddress.replace(/[^a-z0-9]/g, '_');
    const stateRef = db.collection(MAIL_ROOT).doc(userKey);

    let state;
    try {
        const snap = await stateRef.get();
        state = snap.exists ? snap.data() : null;
    } catch (_) {
        return j(res, 500, { ok: false, error: 'state unreadable' });
    }
    if (!state || !state.refresh_token) {
        // Nothing this endpoint can do, and retrying will not change it.
        return j(res, 204, { ok: true, skipped: 'mailbox-not-connected' });
    }

    let token;
    try {
        token = await accessTokenFrom(state.refresh_token, env, f);
    } catch (_) {
        return j(res, 500, { ok: false, error: 'could not mint an access token' });
    }

    let listed = await messagesSince(token, state.historyId || note.historyId, f);
    if (!listed.ok && listed.reason === 'history-too-old') listed = await recentMessages(token, f);
    if (!listed.ok) return j(res, 500, { ok: false, error: listed.reason });

    const stored = [];
    const notable = [];
    for (const id of listed.ids) {
        let msg;
        try {
            const r = await f(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { headers: authed(token) });
            if (!r.ok) continue;                       // one unreadable message is not a failed push
            msg = await r.json();
        } catch (_) { continue; }

        const plan = planMessage(msg);
        if (!plan.ok) {
            if (isWorthTelling(plan)) {
                notable.push({ bank: plan.bank || null, reason: plan.reason, text: REJECT_TEXT[plan.reason] });
            }
            continue;
        }

        for (const item of plan.items) {
            const ref = db.collection(MAIL_ROOT).doc(userKey).collection('items').doc(item.key);
            try {
                // Redelivery is normal; a document already here is already done.
                const existing = await ref.get();
                if (existing.exists) { stored.push({ key: item.key, duplicate: true }); continue; }

                const ar = await f(
                    `${GMAIL}/messages/${encodeURIComponent(item.messageId)}`
                    + `/attachments/${encodeURIComponent(item.attachmentId)}`,
                    { headers: authed(token) },
                );
                if (!ar.ok) continue;
                const att = await ar.json();
                // Gmail returns base64url; the store and the device both want base64.
                const b64 = String(att.data || '').replace(/-/g, '+').replace(/_/g, '/');

                const write = planWrite(b64, {
                    bank: item.bank, filename: item.filename, messageId: item.messageId,
                    subject: item.subject, receivedMs: item.receivedMs, storedMs: Date.now(),
                });
                if (!write.ok) {
                    notable.push({ bank: item.bank, reason: write.reason, text: REJECT_TEXT[write.reason] });
                    continue;
                }

                /* PARTS FIRST, MANIFEST LAST — the ordering statement-store.js
                 * established and the device relies on. The manifest's presence
                 * is what tells the reader every part landed, so writing it
                 * first would let a half-finished upload be read as a whole
                 * statement with pages missing. */
                for (const p of write.parts) {
                    await ref.collection('parts').doc(String(p.i)).set({ i: p.i, d: p.d });
                }
                await ref.set(write.manifest);
                stored.push({ key: item.key, bank: item.bank, chunked: write.chunked });
            } catch (_) {
                // A failure on ONE attachment is retryable; the manifest was not
                // written, so the device will never see a partial statement.
                return j(res, 500, { ok: false, error: 'store failed', stored: stored.length });
            }
        }
    }

    try {
        await stateRef.set({
            historyId: listed.historyId || note.historyId,
            lastPushMs: Date.now(),
            ...(notable.length ? { notable: notable.slice(0, 10) } : {}),
        }, { merge: true });
    } catch (_) { /* the statements landed; the bookmark can catch up next push */ }

    return j(res, 200, { ok: true, stored: stored.length, notable: notable.length });
}
