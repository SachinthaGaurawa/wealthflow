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

import {
    planMessage, planWrite, planHold, MAX_HELD, isWorthTelling, REJECT_TEXT, worthSighting,
} from './wealthflow-mail-ingest.mjs';
import { normalizeList, policyFrom, recordSighting, approvedClauses } from './wealthflow-mail-senders.mjs';
import { sendersOf, SENDERS_FIELD, HELD_FIELD, mergeHeld } from './gmail-link.mjs';
import { getInboxDb } from './inbox-store.mjs';
import { accessTokenFrom, authed } from './google-oauth.mjs';

const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
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

/* accessTokenFrom and authed now live in google-oauth.mjs — /api/gmail-watch
 * needs the identical exchange, and two copies of a credential policy is one
 * more than can be kept in step. Imported at the top of this file. */

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
    const ids = new Set();
    const pages = new Set();
    let pageToken = '', historyId = startHistoryId;
    for (let page = 0; page < 100; page += 1) {
        let r, out;
        try {
            r = await f(url + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: authed(token) });
            if (r.status === 404) return { ok: false, reason: 'history-too-old' };
            if (!r.ok) return { ok: false, reason: 'history-unavailable', status: r.status };
            out = await r.json();
            if (!out || !Array.isArray(out.history || [])) throw new Error('invalid history');
            for (const h of out.history || []) {
                for (const a of h.messagesAdded || []) if (a.message && a.message.id) ids.add(a.message.id);
            }
        } catch (_) { return { ok: false, reason: 'history-unavailable' }; }
        // A cursor is safe to commit only after every page has been collected.
        historyId = out.historyId || historyId;
        pageToken = out.nextPageToken;
        if (!pageToken) return { ok: true, ids: [...ids], historyId };
        if (typeof pageToken !== 'string' || pages.has(pageToken)) break;
        pages.add(pageToken);
    }
    return { ok: false, reason: 'history-pagination-incomplete' };
}

/** The fallback when history is too old: the most recent messages, bounded. */
export async function recentMessages(token, f, max = 25, clauses = null) {
    if (Array.isArray(clauses) && !clauses.length) return { ok: true, ids: [] };
    const query = 'has:attachment' + (clauses ? ' {' + clauses.join(' ') + '}' : '');
    const base = `${GMAIL}/messages?maxResults=${Math.max(1, Math.min(50, max))}&q=${encodeURIComponent(query)}`;
    const ids = new Set(), seen = new Set();
    let pageToken = '';
    for (let page = 0; page < 100; page += 1) {
        let out;
        try {
            const r = await f(base + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: authed(token) });
            if (!r.ok) return { ok: false, reason: 'list-unavailable', status: r.status };
            out = await r.json();
            for (const m of out.messages || []) if (m.id) ids.add(m.id);
        } catch (_) { return { ok: false, reason: 'list-unavailable' }; }
        pageToken = out.nextPageToken;
        if (!pageToken) return { ok: true, ids: [...ids] };
        if (typeof pageToken !== 'string' || seen.has(pageToken)) break;
        seen.add(pageToken);
    }
    return { ok: false, reason: 'list-pagination-incomplete' };
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

    /* DESTRUCTURED. getInboxDb() re-exports getAdminDb() unchanged, so it
     * returns { db, reason, admin } and not a handle — and `db.error` is a field
     * that has never existed on it, so this guard could not fire whatever went
     * wrong. Every Pub/Sub push would have died one line later on
     * `db.collection is not a function`, exactly as /api/gmail-link did.
     *
     * It was never observed because it could not be: nothing in this repository
     * calls Gmail's users.watch, so Google has never published to the topic and
     * this handler has never run. Two defects, each hiding the other. */
    const { db, reason } = await getInboxDb();
    if (!db) return j(res, 500, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });

    return ingestMailbox(db, note, env, f, res);
}

/** Shared collection path for verified push, authenticated login, and scheduled catch-up. */
export async function syncMailbox(db, note, { env = process.env, f = fetch } = {}) {
    let result;
    const response = { status(code) { this.code = code; return this; }, json(body) { result = { status: this.code, body }; return result; } };
    await ingestMailbox(db, note, env, f, response);
    return result;
}

async function ingestMailbox(db, note, env, f, res) {
    const transport = f;
    f = (url, options = {}) => transport(url, { ...options, signal: options.signal || AbortSignal.timeout(8000) });

    const userKey = note.emailAddress.replace(/[^a-z0-9]/g, '_');
    const stateRef = db.collection(MAIL_ROOT).doc(userKey);

    let state;
    try {
        const snap = await stateRef.get();
        state = snap.exists ? snap.data() : null;
    } catch (_) {
        return j(res, 500, { ok: false, error: 'state unreadable' });
    }
    if (!state || !state.refresh_token || (state.email && state.email !== note.emailAddress)) {
        // Nothing this endpoint can do, and retrying will not change it.
        return j(res, 204, { ok: true, skipped: 'mailbox-not-connected' });
    }

    /* The owner's statement-sender list, from the sealed document — the same
     * source and the same shape gmail-scan.js reads. A push has no client to
     * ask, which is the reason this list lives on the server at all. */
    const senderList = normalizeList(sendersOf(state));
    /* References to messages refused for a sender reason. Written once, after
     * the loop, for the same reason the sender list is: one write, not one per
     * message. */
    const held = [];
    const policy = policyFrom(senderList);
    let seen = senderList;
    const sightings = [];

    let token;
    try {
        token = await accessTokenFrom(state.refresh_token, env, f);
    } catch (_) {
        return j(res, 500, { ok: false, error: 'could not mint an access token' });
    }

    let pending = state.pendingCollection;
    if (!pending || !Array.isArray(pending.ids) || !Number.isSafeInteger(pending.cursor)) {
        const senderClauses = approvedClauses(senderList).sort();
        // History only contains newly arriving messages. An address approved
        // today may already have years of statements in this mailbox.
        const senderCatchup = JSON.stringify(state.collectedSenderClauses || null) !== JSON.stringify(senderClauses);
        let listed = state.historyId && !senderCatchup
            ? await messagesSince(token, state.historyId, f)
            : await recentMessages(token, f, 50, senderClauses);
        if (!listed.ok && listed.reason === 'history-too-old') listed = await recentMessages(token, f, 50, approvedClauses(senderList));
        if (!listed.ok) return j(res, 500, { ok: false, error: listed.reason });
        // Stage the complete collection before downloading. A slow historical
        // mailbox resumes in bounded batches without prematurely moving history.
        const candidate = { id: globalThis.crypto.randomUUID(), ids: listed.ids,
            cursor: 0, senderClauses, target: String(listed.historyId || note.historyId || '') };
        try {
            pending = await db.runTransaction(async tx => {
                const current = await tx.get(stateRef);
                const existing = current.data()?.pendingCollection;
                if (existing && Array.isArray(existing.ids)) return existing;
                tx.set(stateRef, { pendingCollection: candidate }, { merge: true });
                return candidate;
            });
        } catch (_) { return j(res, 503, { ok: false, error: 'collection staging failed' }); }
    }
    const batchEnd = Math.min(pending.ids.length, pending.cursor + 10);

    const stored = [];
    const notable = [];
    for (const id of pending.ids.slice(pending.cursor, batchEnd)) {
        let msg;
        try {
            const r = await f(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { headers: authed(token) });
            if (r.status === 404) continue; // Deleted mail no longer exists.
            if (!r.ok) return j(res, 503, { ok: false, error: 'message fetch failed' });
            msg = await r.json();
        } catch (_) { return j(res, 503, { ok: false, error: 'message fetch failed' }); }

        const plan = planMessage(msg, policy);

        /* Recorded only when this message could ever become a statement —
         * see worthSighting() in wealthflow-mail-ingest.mjs for why: the
         * Pub/Sub history this loop walks has no query, so before this gate
         * every message the mailbox ever received, statement-shaped or not,
         * added a row to the owner's senders list. gmail-scan.js's routine
         * path applies the identical gate for the identical reason. */
        if (worthSighting(plan)) {
            const sighting = { from: plan.from, subject: plan.subject, now: Date.now() };
            sightings.push(sighting);
            seen = recordSighting(seen, sighting);
        }

        if (!plan.ok) {
            if (isWorthTelling(plan)) {
                notable.push({ bank: plan.bank || null, reason: plan.reason, text: REJECT_TEXT[plan.reason] });
            }
            /* HELD, NOT DROPPED. A refusal about WHO SENT IT is one tap from
             * being wrong, and this used to `continue` — the sighting was
             * recorded so the sender appeared in the pending list, but the
             * statement itself was gone, and approving the sender afterwards
             * brought back nothing. A reference only: no attachment is fetched
             * on the strength of a refusal. */
            const hold = planHold(plan, msg);
            if (hold) { held.push(hold); }
            continue;
        }

        for (const item of plan.items) {
            const ref = db.collection(MAIL_ROOT).doc(userKey).collection('items').doc(item.key);
            try {
                /* Redelivery is normal; a document already here is already
                 * done. BOTH names are checked: item.key is the stable one and
                 * item.legacyKey is what the same attachment was filed under
                 * before the key stopped depending on Gmail's attachmentId.
                 * Without the second lookup, the first run after that change
                 * would re-store every statement already held — one last round
                 * of exactly the duplication it fixes. */
                const existing = await ref.get();
                if (existing.exists) { stored.push({ key: item.key, duplicate: true }); continue; }
                if (item.legacyKey && item.legacyKey !== item.key) {
                    const old = await db.collection(MAIL_ROOT).doc(userKey)
                        .collection('items').doc(item.legacyKey).get();
                    if (old.exists) { stored.push({ key: item.legacyKey, duplicate: true }); continue; }
                }

                const ar = await f(
                    `${GMAIL}/messages/${encodeURIComponent(item.messageId)}`
                    + `/attachments/${encodeURIComponent(item.attachmentId)}`,
                    { headers: authed(token) },
                );
                if (!ar.ok) return j(res, 503, { ok: false, error: 'attachment fetch failed' });
                const att = await ar.json();
                // Gmail returns base64url; the store and the device both want base64.
                const b64 = String(att.data || '').replace(/-/g, '+').replace(/_/g, '/');

                const write = planWrite(b64, {
                    bank: item.bank, filename: item.filename, messageId: item.messageId,
                    subject: item.subject, receivedMs: item.receivedMs, storedMs: Date.now(),
                    /* See gmail-scan.js: computed since the beginning, stored
                     * by nothing until now. */
                    known: item.known !== false,
                    from: item.from || '',
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
                const created = await db.runTransaction(async tx => {
                    const existing = await tx.get(ref);
                    const currentState = await tx.get(stateRef);
                    if (existing.exists) return false;
                    // Settings revocation during a download must not publish a
                    // new manifest. A later approval triggers historical replay.
                    if (!planMessage(msg, policyFrom(normalizeList(sendersOf(currentState.data() || {})))).ok) return false;
                    tx.set(ref, { ...write.manifest, status: 'pending', filed: false,
                        ...(currentState.data()?.uid ? { uid: currentState.data().uid } : {}) });
                    return true;
                });
                stored.push({ key: item.key, bank: item.bank, chunked: write.chunked, duplicate: !created });
            } catch (_) {
                // A failure on ONE attachment is retryable; the manifest was not
                // written, so the device will never see a partial statement.
                return j(res, 500, { ok: false, error: 'store failed', stored: stored.length });
            }
        }
    }

    try {
        const updates = {
            lastPushMs: Date.now(),
            ...(notable.length ? { notable: notable.slice(0, 10) } : {}),
            /* Folded into the write that was already happening rather than
             * costing a second one. Only when something actually changed, so a
             * quiet push does not rewrite the list for nothing. */
            ...(seen !== senderList ? { [SENDERS_FIELD]: seen } : {}),
            /* Merged with what is already held, newest first, bounded. Folded
             * into the write that was already happening rather than costing a
             * second one. */
            ...(held.length ? { [HELD_FIELD]: mergeHeld(state && state[HELD_FIELD], held) } : {}),
        };
        await db.runTransaction(async tx => {
            const current = await tx.get(stateRef);
            const previous = current.exists && current.data().historyId;
            const active = current.data()?.pendingCollection;
            if (active?.id !== pending.id) return;
            // A concurrent Settings approval/revocation must survive collection.
            if (sightings.length) {
                let latest = normalizeList(sendersOf(current.data() || {}));
                for (const sighting of sightings) latest = recordSighting(latest, sighting);
                updates[SENDERS_FIELD] = latest;
            }
            if (held.length) updates[HELD_FIELD] = mergeHeld(current.data()?.[HELD_FIELD], held);
            const complete = batchEnd === pending.ids.length;
            const next = complete ? pending.target : '';
            updates.pendingCollection = complete ? null : { ...pending, cursor: Math.max(active.cursor || 0, batchEnd) };
            if (complete && Array.isArray(pending.senderClauses)) updates.collectedSenderClauses = pending.senderClauses;
            // Concurrent redeliveries cannot move a durable cursor backwards.
            if (/^\d+$/.test(next) && (!/^\d+$/.test(String(previous || '')) || BigInt(next) > BigInt(previous))) updates.historyId = next;
            tx.set(stateRef, updates, { merge: true });
        });
    } catch (_) { return j(res, 503, { ok: false, error: 'cursor persistence failed' }); }

    let queued = false;
    if (state.autonomous && state.uid === env.WEALTHFLOW_OWNER_UID && stored.some(item => !item.duplicate)) {
        try {
            const { enqueueStatementSync } = await import('./statement-cloud-queue.mjs');
            await enqueueStatementSync({ env, f });
            queued = true;
        } catch (_) { /* Durable manifests remain pending; scheduled catch-up retries them. */ }
    }
    return j(res, 200, { ok: true, stored: stored.length, notable: notable.length, held: held.length, queued,
        collectionPending: batchEnd < pending.ids.length });
}
