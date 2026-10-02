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
    planMessage, planWrite, planHold, repairManifest, MAX_HELD, isWorthTelling, REJECT_TEXT, worthSighting,
    refusalOf, securityOf, INTAKE_VERSION, REJECT, HOLDABLE,
} from './wealthflow-mail-ingest.mjs';
import { normalizeList, policyFrom, recordSighting, approvedClauses, approvedDomainClauses } from './wealthflow-mail-senders.mjs';
export { approvedDomainClauses as auditClauses };
import { policyWithReach, auditQuery } from './bank-reach.mjs';
import { planWithEvidence, evidenceContext, approvalKey } from './statement-evidence.mjs';
import { DISCOVERY_VERSION, DISCOVERY_EVERY_MS, DISCOVERY_MAX_IDS, discoveryQueries, listDiscovery, discoveryCensus, attachmentKinds, newTally, tally, tallyLine } from './statement-discovery.mjs';
import { sendersOf, SENDERS_FIELD, HELD_FIELD, mergeHeld, REFUSED_FIELD, mergeRefused, refusedOf, SECURITY_FIELD, mergeSecurity } from './gmail-link.mjs';
import { MAIL_STATE, logStates, firstUnsettled, stateForPlan, DISCOVERY_DROP } from './mail-state.mjs';
import { getInboxDb } from './inbox-store.mjs';
import { accessTokenFrom, authed } from './google-oauth.mjs';
import { createHash } from 'node:crypto';

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

/* Gmail leaves the Spam folder out of a listing unless asked, and a bank's
 * statement that Gmail mistook for spam is exactly the message nobody would
 * ever look for. Spam is listed; Trash — mail the owner threw away — is not. */
const NOT_TRASH = ' -in:trash';

/** The fallback when history is too old: the most recent messages, bounded. */
export async function recentMessages(token, f, max = 25, clauses = null) {
    if (Array.isArray(clauses) && !clauses.length) return { ok: true, ids: [] };
    const query = 'has:attachment' + (clauses ? ' {' + clauses.join(' ') + '}' : '') + NOT_TRASH;
    const base = `${GMAIL}/messages?maxResults=${Math.max(1, Math.min(50, max))}&includeSpamTrash=true&q=${encodeURIComponent(query)}`;
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

/**
 * A small rolling reconciliation over the owner's exact approved addresses.
 *
 * Gmail history is an efficient cursor, not an inventory proof: a watch lapse,
 * an earlier buggy cursor advance, or an acknowledged push whose worker died
 * can leave one message behind the bookmark forever. Re-reading a bounded
 * overlap is safe because manifests have stable message+attachment identities.
 */
export const RECONCILE_DAYS = 14;
export const RECONCILE_MAX_PAGES = 4;
export const RECONCILE_MIN_GAP_MS = 6 * 60 * 60 * 1000;
export async function reconcileRecentMessages(token, f, clauses, {
    days = RECONCILE_DAYS, maxPages = RECONCILE_MAX_PAGES,
} = {}) {
    if (!Array.isArray(clauses) || !clauses.length) return { ok: true, ids: [] };
    const safeDays = Math.max(1, Math.min(31, Math.floor(Number(days)) || RECONCILE_DAYS));
    const safePages = Math.max(1, Math.min(RECONCILE_MAX_PAGES, Math.floor(Number(maxPages)) || RECONCILE_MAX_PAGES));
    const query = `newer_than:${safeDays}d has:attachment {${clauses.join(' ')}}${NOT_TRASH}`;
    const base = `${GMAIL}/messages?maxResults=50&includeSpamTrash=true&q=${encodeURIComponent(query)}`;
    const ids = new Set(), seen = new Set();
    let pageToken = '';
    for (let page = 0; page < safePages; page += 1) {
        let out;
        try {
            const r = await f(base + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: authed(token) });
            if (!r.ok) return { ok: false, reason: 'recent-reconciliation-unavailable', status: r.status };
            out = await r.json();
            for (const m of out.messages || []) if (m && m.id) ids.add(m.id);
        } catch (_) { return { ok: false, reason: 'recent-reconciliation-unavailable' }; }
        pageToken = out.nextPageToken;
        if (!pageToken) return { ok: true, ids: [...ids], complete: true };
        if (typeof pageToken !== 'string' || seen.has(pageToken)) break;
        seen.add(pageToken);
    }
    // Do not pretend a capped inventory is complete. The collected ids are
    // still useful and the next minute repeats the overlap idempotently.
    return { ok: true, ids: [...ids], complete: false };
}

/**
 * THE WHOLE HISTORY, AS A LIST OF IDS.
 *
 * The cursor (history) and the rolling overlap (reconcile) both look forward from
 * a bookmark; neither can tell that something BEHIND the bookmark was never
 * taken. This asks Gmail for every message with an attachment from the bank
 * DOMAINS the owner approved — the whole domain, so a bank's second address is
 * found and judged rather than never listed — and returns only ids, which are
 * cheap, so the caller can compare them with what is already accounted for and
 * fetch only the difference.
 */
export const AUDIT_EVERY_MS = 3 * 60 * 60 * 1000;
export const AUDIT_RETRY_MS = 5 * 60 * 1000;
export const AUDIT_MAX_IDS = 1500;
export async function listAllMessages(token, f, clauses, { pageSize = 500, maxPages = 40, budgetMs = 20000, startToken = '' } = {}) {
    if (!Array.isArray(clauses) || !clauses.length) return { ok: true, ids: [], complete: true, next: '' };
    const query = `has:attachment {${clauses.join(' ')}}${NOT_TRASH}`;
    const base = `${GMAIL}/messages?maxResults=${pageSize}&includeSpamTrash=true&q=${encodeURIComponent(query)}`;
    const ids = new Set(), seen = new Set(), deadline = Date.now() + budgetMs;
    let pageToken = typeof startToken === 'string' ? startToken : '';
    /* RESUMABLE. `next` is the page token to carry on from when the budget or the page limit ends the run early, so a
     * mailbox of any size is walked in bounded pieces — each run costs at most `maxPages` pages and `budgetMs` — and
     * the walk is never restarted from the newest message, which is what used to starve everything behind page 40. */
    for (let page = 0; page < maxPages; page += 1) {
        // One serverless request has a minute; a slow Gmail must cost the audit its completeness, not the whole sync.
        if (Date.now() > deadline) return { ok: true, ids: [...ids], complete: false, next: pageToken };
        let out;
        try {
            const r = await f(base + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), { headers: authed(token) });
            if (!r.ok) return { ok: false, reason: 'audit-listing-unavailable', status: r.status };
            out = await r.json();
            for (const m of out.messages || []) if (m && m.id) ids.add(String(m.id));
        } catch (_) { return { ok: false, reason: 'audit-listing-unavailable' }; }
        pageToken = out.nextPageToken;
        if (!pageToken) return { ok: true, ids: [...ids], complete: true, next: '' };
        if (typeof pageToken !== 'string' || seen.has(pageToken)) return { ok: true, ids: [...ids], complete: false, next: '' };
        seen.add(pageToken);
    }
    return { ok: true, ids: [...ids], complete: false, next: pageToken };
}

async function storedMessageIds(stateRef) {
    let q = stateRef.collection('items');
    if (typeof q.select === 'function') q = q.select('messageId');
    if (typeof q.limit === 'function') q = q.limit(2000);
    return new Set((await q.get()).docs.map(d => String((d.data() || {}).messageId || '')).filter(Boolean));
}

/** What the filed statements look like — their subjects and file names — so discovery can ask for "the same kind of mail" from any address. */
async function filedSignatures(stateRef) {
    let q = stateRef.collection('items');
    if (typeof q.select === 'function') q = q.select('filename', 'subject', 'filed', 'status', 'bank');
    if (typeof q.limit === 'function') q = q.limit(1000);
    return (await q.get()).docs.map(d => d.data() || {});
}

export const DISCOVERY_RETRY_MS = 5 * 60 * 1000;
/**
 * THE OTHER WAYS OF ASKING (statement-discovery.mjs). Not by sender: by what the mail says — an attachment, a statement word and a bank of the
 * owner's named — and by the wording of the statements already filed. Returns the ids not already judged, to be judged like every other message
 * (planWithEvidence): one that is not a statement of the owner's banks is dropped without a trace, never held and never asked about.
 */
export async function discoverFresh({ token, f, stateRef, state, senderList, clauses = [], skip = new Set(), now = Date.now(), cap = DISCOVERY_MAX_IDS }) {
    const d = state && state.discovery;
    const wait = d && d.v === DISCOVERY_VERSION && d.more ? DISCOVERY_RETRY_MS : DISCOVERY_EVERY_MS;
    if (d && d.v === DISCOVERY_VERSION && now - (Number(d.at) || 0) < wait) return null;
    let items = [];
    try { items = await filedSignatures(stateRef); } catch (_) { /* the keyword query alone still runs */ }
    const queries = discoveryQueries({ list: senderList, items });
    if (!queries.length) return null;
    const found = await listDiscovery(token, f, queries, { pageSize: 100, maxPages: 2, budgetMs: 6000 });
    const wanted = found.ids.filter(id => !skip.has(id));
    let fresh = wanted;
    try { fresh = await firstUnsettled(stateRef, wanted, cap + 1, { version: INTAKE_VERSION, listKey: approvalKey(senderList) }); } catch (_) { /* judged again, never skipped */ }
    const more = fresh.length > cap;
    const ids = fresh.slice(0, cap);
    let census = {};
    try { census = await discoveryCensus(token, f, { clauses, queries }); } catch (_) { /* advice only */ }
    const methods = Object.fromEntries(Object.entries(found.methods).map(([k, v]) => [k, { listed: v.listed, failed: v.failed, complete: v.complete }]));
    console.info(JSON.stringify({ evt: 'mail-discovery-listing', methods, listed: found.ids.length, fresh: wanted.length, staged: ids.length, more, census }));
    // the record that it ran is written WITH the staging (see the handler), so a run that dies before the ids are staged is asked again, not forgotten for six hours
    return { ids, more, record: { v: DISCOVERY_VERSION, at: now, listed: found.ids.length, staged: ids.length, more, methods, census } };
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

    /* A Pub/Sub delivery is acknowledged only after its staged Gmail id list
     * has been consumed. ingestMailbox deliberately handles ten messages per
     * pass so one serverless request stays bounded; a 2xx here used to tell
     * Pub/Sub the job was finished after only the first pass. No browser exists
     * to follow `collectionPending` on this path, so ask Pub/Sub to redeliver.
     * Stable message/attachment ids and the durable cursor make that retry
     * idempotent. Authenticated browser calls use syncMailbox() below and keep
     * the 200 response so their own continuation timer can advance the batch. */
    const result = await syncMailbox(db, note, { env, f });
    return j(res, pushDeliveryStatus(result), result?.body || { ok: false, error: 'mailbox sync failed' });
}

export function pushDeliveryStatus(result) {
    const status = Number(result?.status) || 500;
    return status >= 200 && status < 300 && result?.body?.collectionPending === true ? 503 : status;
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
    const policy = policyWithReach(senderList);
    // What the mail says and what the document proves can take a statement from an address nobody listed (statement-evidence.mjs).
    const evidence = evidenceContext(senderList, state.email);
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
        // Cursor collection and rolling inventory are independent evidence.
        // Union them before staging so a statement missed behind a valid-looking
        // history bookmark is recovered without weakening the sender allowlist.
        const shouldReconcile = state.historyId && !senderCatchup
            && Date.now() - (Number(state.lastReconcileMs) || 0) >= RECONCILE_MIN_GAP_MS;
        if (shouldReconcile) {
            const overlap = await reconcileRecentMessages(token, f, senderClauses);
            if (!overlap.ok) return j(res, 503, { ok: false, error: overlap.reason });
            listed.ids = [...new Set([...(listed.ids || []), ...(overlap.ids || [])])];
        }
        /* WHAT THE STATE TABLE SAYS WAS LEFT UNFINISHED: a message that was found and logged but whose attempt died (a
         * timeout, a lock, a crashed worker) comes back here, as ordinary mail — the same rules, nothing forced. */
        if (Array.isArray(state.requeue) && state.requeue.length) listed.ids = [...new Set([...(listed.ids || []), ...state.requeue.map(String).filter(Boolean)])];
        /* THE WHOLE-HISTORY AUDIT. Every few hours, and once after every change to the
         * intake rules, the mailbox's entire history from the approved banks is
         * listed and compared with what is already accounted for — stored, or
         * refused under THESE rules. Whatever is left over is fetched and judged.
         * It is added to the collection rather than replacing it, and a listing
         * that fails only postpones the audit: it never stops the mail from
         * arriving. */
        /* RESUMABLE: `auditCursor` is where the last run stopped walking the listing. While it exists the audit is due
         * at once, so a mailbox too large for one run is finished over several — each bounded — instead of restarting
         * from the newest message every time and never reaching the rest. */
        // `token` may be empty: that is "still walking, and the next window is the first one again" (a window with more new mail than one collection stages).
        const cursor = state.auditCursor && state.auditCursor.v === INTAKE_VERSION && typeof state.auditCursor.token === 'string' ? state.auditCursor : null;
        // the other ways of asking (statement-discovery.mjs) have never run on this mailbox: the next audit is due as soon as the retry gap allows, not in three hours
        const discoveryNever = !state.discovery || state.discovery.v !== DISCOVERY_VERSION;
        const auditDue = senderClauses.length > 0
            && (senderCatchup || !!cursor || Date.now() - (Number(state.lastAuditMs) || 0) >= (state.auditVersion === INTAKE_VERSION && state.historyAudit?.complete !== false && !discoveryNever ? AUDIT_EVERY_MS : AUDIT_RETRY_MS));
        let audit = null, viaFrom = 0, discoveryFrom = -1, discoveryTo = -1, discoveryRecord = null;
        if (auditDue) {
            const everything = await listAllMessages(token, f, auditQuery(senderList), { startToken: cursor ? cursor.token || '' : '', pageSize: Math.max(1, Number(env.WF_AUDIT_PAGE_SIZE) || 500), maxPages: Math.max(1, Number(env.WF_AUDIT_MAX_PAGES) || 40) });
            // A page token Gmail no longer honours: the walk starts again from the top (everything already settled is skipped cheaply).
            if (!everything.ok && cursor && cursor.token && everything.status === 400) { try { await stateRef.set({ auditCursor: null }, { merge: true }); } catch (_) { /* tried again next run */ } }
            if (everything.ok) {
                let known = new Set();
                try { known = await storedMessageIds(stateRef); } catch (_) { known = null; }
                if (known) {
                    for (const r of refusedOf(state)) if (r.v === INTAKE_VERSION) known.add(String(r.messageId));
                    // Judged under these rules and not a statement: never fetched again, so a mailbox with a
                    // great deal of bank mail cannot keep the audit on the same newest messages for ever.
                    if (state.auditSeen && state.auditSeen.v === INTAKE_VERSION && Array.isArray(state.auditSeen.ids)) for (const id of state.auditSeen.ids) known.add(String(id));
                    const have = new Set(listed.ids || []);
                    let fresh = everything.ids.filter(id => !known.has(id) && !have.has(id));
                    const cap = Math.max(1, Number(env.WF_AUDIT_MAX_IDS) || AUDIT_MAX_IDS);
                    /* THE STATE TABLE IS THE MEMORY. A message with a settled record under these rules has been judged, however
                     * many there are and however old — no cap on a list inside one document stands between the audit and
                     * the oldest mail. Only as many are looked up as it takes to fill one collection (plus one, to know
                     * whether more remain), so the cost of a run does not grow with the size of the mailbox. A lookup that
                     * fails only means the message is judged again. */
                    const beforeTable = fresh.length;
                    let settledSeen = 0;
                    try { fresh = await firstUnsettled(stateRef, fresh, cap + 1, { version: INTAKE_VERSION }); settledSeen = fresh.settledSeen || 0; } catch (_) { /* judged again, never skipped */ }
                    const take = fresh.slice(0, cap);
                    viaFrom = (listed.ids || []).length;
                    listed.ids = [...(listed.ids || []), ...take];
                    /* THE OTHER WAYS OF ASKING, appended after the audit's own messages and marked, so that what they find is judged the same way
                     * but never offered back to the owner as a question (see `discoveryOnly` below). */
                    try {
                        // what the sender-keyed audit lists is the audit's to judge (all of it, this window or a later one); a message already HELD stays held
                        const heldAlready = (Array.isArray(state[HELD_FIELD]) ? state[HELD_FIELD] : []).map(h => String(h && h.messageId)).filter(Boolean);
                        const have2 = new Set(listed.ids);
                        const extra = await discoverFresh({ token, f, stateRef, state, senderList, clauses: auditQuery(senderList), skip: new Set([...known, ...have2, ...heldAlready, ...everything.ids]) });
                        if (extra) discoveryRecord = extra.record;
                        if (extra && extra.ids.length) { discoveryFrom = listed.ids.length; listed.ids = [...listed.ids, ...extra.ids]; discoveryTo = listed.ids.length; }
                    } catch (_) { /* discovery is advice on top of the audit: it never stops the mail from arriving */ }
                    const windowDone = fresh.length <= cap;
                    audit = { v: INTAKE_VERSION, listed: (cursor ? Number(cursor.listed) || 0 : 0) + everything.ids.length, accounted: (everything.ids.length - beforeTable) + settledSeen, staged: take.length, taken: 0,
                        // where the NEXT run carries on: after this window once every fresh id in it is staged, else in this window again
                        next: windowDone ? String(everything.next || '') : (cursor ? cursor.token || '' : ''),
                        // another run is needed: there are more pages, or this window still has fresh mail left to stage
                        again: !windowDone || (!everything.complete && !!everything.next),
                        complete: everything.complete && windowDone };
                }
            }
        }
        // Stage the complete collection before downloading. A slow historical
        // mailbox resumes in bounded batches without prematurely moving history.
        const candidate = { id: globalThis.crypto.randomUUID(), ids: listed.ids,
            cursor: 0, senderClauses, reconciled: Boolean(shouldReconcile),
            target: String(listed.historyId || note.historyId || ''),
            ...(audit ? { audit, via: 'audit', viaFrom } : {}),
            ...(discoveryFrom >= 0 ? { discoveryFrom, discoveryTo } : {}) };
        try {
            pending = await db.runTransaction(async tx => {
                const current = await tx.get(stateRef);
                const existing = current.data()?.pendingCollection;
                if (existing && Array.isArray(existing.ids)) return existing;
                /* The owner's taps on refused messages ("that one is mine") join the
                 * next collection, read here so a tap that lands mid-staging is not lost. */
                const asked = (Array.isArray(current.data()?.takeQueue) ? current.data().takeQueue : []).map(String).filter(Boolean);
                const next = asked.length
                    ? { ...candidate, ids: [...new Set([...candidate.ids, ...asked])], forced: asked }
                    : candidate;
                tx.set(stateRef, { pendingCollection: next, ...(discoveryRecord ? { discovery: discoveryRecord } : {}), ...(asked.length ? { takeQueue: [] } : {}), ...(Array.isArray(current.data()?.requeue) && current.data().requeue.length ? { requeue: [] } : {}) }, { merge: true });
                return next;
            });
        } catch (_) { return j(res, 503, { ok: false, error: 'collection staging failed' }); }
    }
    const batchEnd = Math.min(pending.ids.length, pending.cursor + 10);

    const stored = [];
    const notable = [];
    const refusedNow = [], takenIds = [], seenNow = [], securityNow = [], outcomesNow = [], unheldNow = [];
    const discovered = newTally(), refusedKinds = {};
    /* LOGGED BEFORE ANYTHING IS FETCHED OR READ. From here a crash, a timeout or a database lock cannot lose these
     * messages: each has a record, and whatever never reaches PROCESSED is queued again from it (see mail-state.mjs). */
    const logged = await logStates(db, stateRef, pending.ids.slice(pending.cursor, batchEnd).map(id => ({ messageId: String(id), state: MAIL_STATE.PENDING, v: INTAKE_VERSION })));
    // Nothing is fetched or read that is not on record first. The cursor has not moved, so the same batch comes round again.
    if (logged.ok === false) return j(res, 503, { ok: false, error: 'state log unavailable', collectionPending: true });
    const forcedIds = new Set(Array.isArray(pending.forced) ? pending.forced.map(String) : []);
    const freshIds = new Set(Array.isArray(logged.fresh) ? logged.fresh : []);
    for (const [offset, id] of pending.ids.slice(pending.cursor, batchEnd).entries()) {
        const via = forcedIds.has(String(id)) ? 'owner' : ((pending.cursor + offset) >= (Number(pending.viaFrom) || 0) ? String(pending.via || '') : '');
        const rules = { ...policy, forced: forcedIds.has(String(id)) };
        let msg;
        try {
            const r = await f(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { headers: authed(token) });
            // Deleted mail no longer exists, so nothing about it is outstanding any more.
            if (r.status === 404) { takenIds.push(String(id)); outcomesNow.push({ messageId: String(id), state: MAIL_STATE.REFUSED, reason: 'message-deleted', v: INTAKE_VERSION }); continue; }
            if (!r.ok) return j(res, 503, { ok: false, error: 'message fetch failed' });
            msg = await r.json();
        } catch (_) { return j(res, 503, { ok: false, error: 'message fetch failed' }); }

        /* FOUND BY WHAT IT SAYS, NOT BY WHO SENT IT: a message the other ways of asking brought in. Judged like all mail, but never offered back
         * as a question and never added to the owner's sender list — what is not a statement of one of their banks is dropped and counted. */
        const at = pending.cursor + offset;
        const discoveryOnly = !forcedIds.has(String(id)) && Number.isInteger(pending.discoveryFrom) && at >= pending.discoveryFrom && at < pending.discoveryTo
            && !(Array.isArray(state[HELD_FIELD]) && state[HELD_FIELD].some(h => String(h && h.messageId) === String(id)));
        let plan = forcedIds.has(String(id)) ? planMessage(msg, rules) : planWithEvidence(msg, policy, evidence);
        /* Recorded only when this message could ever become a statement —
         * see worthSighting() in wealthflow-mail-ingest.mjs for why: the
         * Pub/Sub history this loop walks has no query, so before this gate
         * every message the mailbox ever received, statement-shaped or not,
         * added a row to the owner's senders list. gmail-scan.js's routine
         * path applies the identical gate for the identical reason. */
        if (discoveryOnly) tally(discovered, { plan, message: msg });
        if (worthSighting(plan) && !(discoveryOnly && !plan.ok)) {
            /* A sender's count is of MESSAGES. Every scan walks the recent mail again, and counting each walk made a bank that
             * writes once a month "seen 555 times"; only a message the state table has never held adds to it. (If the table
             * could not say — an older store without `fresh` — the old behaviour stands: better a high count than none.) */
            const sighting = { from: plan.from, subject: plan.subject, now: Date.now(), count: !Array.isArray(logged.fresh) || freshIds.has(String(id)) };
            sightings.push(sighting);
            seen = recordSighting(seen, sighting);
        }

        const fromAudit = pending.via === 'audit' && (pending.cursor + offset) >= (Number(pending.viaFrom) || 0);
        if (!plan.ok && discoveryOnly && plan.security !== true) {
            // not added to `auditSeen`: that memory is for good (until the rules change); this one is judged against the banks approved NOW (`listKey`) and comes back when they change
            takenIds.push(String(id));
            outcomesNow.push({ messageId: String(id), state: MAIL_STATE.REFUSED, reason: (DISCOVERY_DROP + ':' + String((plan.evidence && plan.evidence.why) || plan.reason || '')).slice(0, 80), listKey: approvalKey(senderList), from: plan.from, subject: plan.subject, receivedMs: Number(msg.internalDate) || null, v: INTAKE_VERSION });
            continue;
        }
        // mail a bank sent that carries no PDF or HTML: which kinds of file it did carry (csv, xlsx, zip …), so a bank that mails its statements in one is seen
        if (!plan.ok && plan.reason === REJECT.NO_ATTACHMENT) for (const [ext, n] of Object.entries(attachmentKinds(msg))) refusedKinds[ext] = (refusedKinds[ext] || 0) + n;
        if (!plan.ok) {
            const refusal = refusalOf(plan, msg, policy);
            if (refusal) refusedNow.push(refusal);
            /* FORGERY IS LOGGED, NOT OFFERED BACK: what claimed to be the owner's bank and failed SPF / DKIM / DMARC. */
            const breach = securityOf(plan, msg);
            if (breach) securityNow.push(breach);
            /* MAIL FROM AN UNLISTED SENDER THAT DOES NOT EVEN SAY IT IS A STATEMENT IS NOT HELD FOR A TAP. Whether to trust an address is a question only when something it sent could be a statement; an accounting
             * newsletter or a course notice ("3 waiting on a sender decision") is not, and nothing is lost by saying so: it is judged again when the owner's banks change (it is not marked as seen for good). */
            const notStatement = (plan.reason === REJECT.NOT_ON_YOUR_LIST || plan.reason === REJECT.SENDER_SIBLING) && !!plan.evidence && plan.evidence.ok === false && plan.evidence.why === 'the-subject-and-file-names-do-not-say-statement';
            const verdictState = notStatement ? { state: MAIL_STATE.REFUSED, reason: 'not-a-statement-of-your-banks:the-subject-and-file-names-do-not-say-statement' } : stateForPlan(plan);
            if (verdictState) outcomesNow.push({ messageId: String(id), ...verdictState, from: plan.from, subject: plan.subject, receivedMs: Number(msg.internalDate) || null, v: INTAKE_VERSION });
            if (fromAudit && !HOLDABLE.has(plan.reason)) seenNow.push(String(id));
            if (isWorthTelling(plan)) {
                notable.push({ bank: plan.bank || null, reason: plan.reason, text: REJECT_TEXT[plan.reason] });
            }
            /* HELD, NOT DROPPED. A refusal about WHO SENT IT is one tap from
             * being wrong, and this used to `continue` — the sighting was
             * recorded so the sender appeared in the pending list, but the
             * statement itself was gone, and approving the sender afterwards
             * brought back nothing. A reference only: no attachment is fetched
             * on the strength of a refusal. */
            const hold = notStatement ? null : planHold(plan, msg);
            // judged again and no longer a question about who sent it (a promotion, a forgery, a non-statement): it leaves the held list
            if (hold) { held.push(hold); } else unheldNow.push(String(id));
            continue;
        }

        takenIds.push(String(id));
        const keptKeys = [], keptSha = [];
        let refusedWrite = '';
        for (const item of plan.items) {
            const ref = db.collection(MAIL_ROOT).doc(userKey).collection('items').doc(item.key);
            try {
                // Repair current or legacy duplicates without downloading again.
                const existing = await ref.get();
                if (existing.exists) {
                    const patch = repairManifest(existing.data(), item, { uid: state.uid || '' });
                    if (Object.keys(patch).length) await ref.set(patch, { merge: true });
                    stored.push({ key: item.key, duplicate: true });
                    keptKeys.push(item.key);
                    continue;
                }
                if (item.legacyKey && item.legacyKey !== item.key) {
                    const oldRef = db.collection(MAIL_ROOT).doc(userKey).collection('items').doc(item.legacyKey);
                    const old = await oldRef.get();
                    if (old.exists) {
                        const patch = repairManifest(old.data(), item, { uid: state.uid || '' });
                        if (Object.keys(patch).length) await oldRef.set(patch, { merge: true });
                        stored.push({ key: item.legacyKey, duplicate: true });
                        keptKeys.push(item.legacyKey);
                        continue;
                    }
                }

                let att;
                if (item.inlineData) {
                    att = { data: item.inlineData };
                } else {
                    const ar = await f(
                        `${GMAIL}/messages/${encodeURIComponent(item.messageId)}`
                        + `/attachments/${encodeURIComponent(item.attachmentId)}`,
                        { headers: authed(token) },
                    );
                    if (!ar.ok) return j(res, 503, { ok: false, error: 'attachment fetch failed' });
                    att = await ar.json();
                }
                // Gmail returns base64url; the store and the device both want base64.
                const b64 = String(att.data || '').replace(/-/g, '+').replace(/_/g, '/');

                const write = planWrite(b64, {
                    bank: item.bank, filename: item.filename, messageId: item.messageId,
                    attachmentId: item.attachmentId || '', size: item.size,
                    subject: item.subject, receivedMs: item.receivedMs, storedMs: Date.now(),
                    contentSha256: createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex'),
                    /* See gmail-scan.js: computed since the beginning, stored
                     * by nothing until now. */
                    known: item.known !== false,
                    /* stated | unproven | suspect — what the mail said the attachment was; the worker holds the DOCUMENT to it. */
                    intent: item.intent || 'stated',
                    from: item.from || '',
                });
                if (!write.ok) {
                    notable.push({ bank: item.bank, reason: write.reason, text: REJECT_TEXT[write.reason] });
                    const refusal = refusalOf({ ok: false, reason: write.reason, from: item.from, subject: item.subject, bank: item.bank }, msg, policy);
                    if (refusal) { refusedNow.push(refusal); takenIds.pop(); }
                    refusedWrite = String(write.reason || 'refused');
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
                    const latest = normalizeList(sendersOf(currentState.data() || {}));
                    const replan = { ...policyWithReach(latest), ...(forcedIds.has(String(id)) ? { forced: true } : {}) };
                    if (!planMessage(msg, replan).ok) return false;
                    tx.set(ref, { ...write.manifest, status: 'pending', filed: false,
                        ...((item.via || via) ? { via: item.via || via } : {}),
                        ...(currentState.data()?.uid ? { uid: currentState.data().uid } : {}) });
                    return true;
                });
                stored.push({ key: item.key, bank: item.bank, chunked: write.chunked, duplicate: !created });
                keptKeys.push(item.key);
                if (write.manifest && write.manifest.contentSha256) keptSha.push(write.manifest.contentSha256);
            } catch (_) {
                // A failure on ONE attachment is retryable; the manifest was not
                // written, so the device will never see a partial statement.
                return j(res, 500, { ok: false, error: 'store failed', stored: stored.length });
            }
        }
        outcomesNow.push(refusedWrite && !keptKeys.length
            ? { messageId: String(id), state: MAIL_STATE.REFUSED, reason: refusedWrite, from: plan.from, subject: plan.subject, receivedMs: Number(msg.internalDate) || null, v: INTAKE_VERSION }
            : { messageId: String(id), state: MAIL_STATE.PROCESSED, items: keptKeys, sha: keptSha, from: plan.from, subject: plan.subject, receivedMs: Number(msg.internalDate) || null, via, v: INTAKE_VERSION });
    }
    await logStates(db, stateRef, outcomesNow);
    if (discovered.judged) console.info(JSON.stringify(tallyLine(discovered, { cursor: pending.cursor, of: pending.ids.length })));
    // platform log only, never shown to the owner: bank mail refused for carrying no PDF/HTML file, counted by the file extension it did carry (e.g. csv, xlsx, zip)
    if (Object.keys(refusedKinds).length) console.info(JSON.stringify({ evt: 'mail-refused-no-pdf-or-html', meaning: 'file extensions carried by bank mail that was refused for having no PDF or HTML attachment', extensions: refusedKinds }));

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
            // A held message that has now been taken (a sibling released by its series) is no longer held.
            const heldBefore = Array.isArray(current.data()?.[HELD_FIELD]) ? current.data()[HELD_FIELD] : [];
            const leaving = new Set([...takenIds, ...unheldNow]);
            const heldBase = leaving.size ? heldBefore.filter(h => !leaving.has(String(h && h.messageId))) : heldBefore;
            if (held.length || heldBase.length !== heldBefore.length) updates[HELD_FIELD] = mergeHeld(heldBase, held);
            // What was refused stays on record until it is taken; what was taken leaves it.
            if (refusedNow.length || takenIds.length) {
                const before = current.data()?.[REFUSED_FIELD];
                const after = mergeRefused(before, refusedNow, takenIds);
                if (JSON.stringify(after) !== JSON.stringify(Array.isArray(before) ? before : [])) updates[REFUSED_FIELD] = after;
            }
            if (securityNow.length) updates[SECURITY_FIELD] = mergeSecurity(current.data()?.[SECURITY_FIELD], securityNow);
            if (seenNow.length) {
                const prior = current.data()?.auditSeen;
                const base = prior && prior.v === INTAKE_VERSION && Array.isArray(prior.ids) ? prior.ids : [];
                updates.auditSeen = { v: INTAKE_VERSION, ids: [...new Set([...base, ...seenNow])].slice(-2500) };
            }
            const complete = batchEnd === pending.ids.length;
            const next = complete ? pending.target : '';
            const newlyStored = stored.filter(item => !item.duplicate).length;
            const audit = pending.audit ? { ...pending.audit, taken: (Number(pending.audit.taken) || 0) + newlyStored } : null;
            updates.pendingCollection = complete ? null : { ...pending, cursor: Math.max(active.cursor || 0, batchEnd), ...(audit ? { audit } : {}) };
            if (complete && audit) {
                const finalRefused = updates[REFUSED_FIELD] || current.data()?.[REFUSED_FIELD] || [];
                const finalHeld = updates[HELD_FIELD] || current.data()?.[HELD_FIELD] || [];
                updates.historyAudit = { at: Date.now(), version: audit.v, listed: audit.listed, accounted: audit.accounted, examined: audit.staged, taken: audit.taken,
                    refused: Array.isArray(finalRefused) ? finalRefused.length : 0, held: Array.isArray(finalHeld) ? finalHeld.length : 0, complete: audit.complete === true };
                /* WHAT "N waiting on a sender decision" IS MADE OF, in the platform log: reason codes and sender domains with counts (no address, subject or file name). */
                const heldBy = {}, heldAt = {};
                for (const h of Array.isArray(finalHeld) ? finalHeld : []) {
                    const why = String((h && h.reason) || '?').slice(0, 40), at = String((h && h.from) || '').split('@').pop().replace(/[^a-z0-9.-]/gi, '').slice(0, 40) || '?';
                    heldBy[why] = (heldBy[why] || 0) + 1; heldAt[at] = (heldAt[at] || 0) + 1;
                }
                console.info(JSON.stringify({ evt: 'mail-audit', listed: audit.listed, accounted: audit.accounted, examined: audit.staged, taken: audit.taken, refused: updates.historyAudit.refused, held: updates.historyAudit.held, heldBy, heldAt, complete: audit.complete === true }));
                // An audit that could not finish is tried again soon, not daily, and is never recorded as done.
                updates.lastAuditMs = Date.now();
                // Carry on from the next page while there is one; done means the whole history was walked.
                updates.auditCursor = audit.again ? { v: audit.v, token: audit.next || '', listed: audit.listed, at: Date.now() } : null;
                if (audit.complete) updates.auditVersion = audit.v;
            }
            if (complete && Array.isArray(pending.senderClauses)) updates.collectedSenderClauses = pending.senderClauses;
            if (complete && pending.reconciled === true) updates.lastReconcileMs = Date.now();
            // Concurrent redeliveries cannot move a durable cursor backwards.
            if (/^\d+$/.test(next) && (!/^\d+$/.test(String(previous || '')) || BigInt(next) > BigInt(previous))) updates.historyId = next;
            tx.set(stateRef, updates, { merge: true });
        });
    } catch (_) { return j(res, 503, { ok: false, error: 'cursor persistence failed' }); }

    let queued = false;
    if (state.autonomous && state.uid === env.WEALTHFLOW_OWNER_UID && stored.some(item => !item.duplicate)) {
        try {
            const { runStatementSync } = await import('./statement-sync.js');
            const result = await runStatementSync({ db, owner: { uid: state.uid, email: state.email }, action: 'drain', env, f, budgetMs: 20000 });
            queued = true;
            /* A push is a trigger like any other: if the backlog is bigger than these twenty seconds, it starts the self-resuming
             * chain (statement-chain.mjs) instead of waiting for the app to be opened or the once-a-day schedule. */
            try {
                const { continueChain } = await import('./statement-chain.mjs');
                await continueChain({ db, mailRef: stateRef, result, link: null, env, f });
            } catch (_) { /* the schedule or the app starts it again */ }
        } catch (_) { /* Durable manifests remain pending; scheduled catch-up retries them. */ }
    }
    return j(res, 200, { ok: true, stored: stored.length, notable: notable.length, held: held.length, queued,
        collectionPending: batchEnd < pending.ids.length });
}
