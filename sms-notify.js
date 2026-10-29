/* =============================================================================
 * sms-notify.js  ->  /api/sms-notify
 * -----------------------------------------------------------------------------
 * The owner's own app calls this when something that might owe a text message has
 * changed (a record saved with the toggle on, a repayment confirmed), and once when
 * it opens to drain anything that was held. The cron (sms-sweep.js) is the net under
 * it: whatever this misses, the next sweep derives again. See sms-events.mjs.
 *
 *   POST /api/sms-notify   Authorization: Bearer <Firebase ID token>
 *        -> { ok, summary:{ derived, enqueued, sent, held, retry, failed, cancelled, remaining, issues, configured } }
 *        body { action:'flush', records:{ debtors, income }, incomeReceived, kuf }   the page is closing: the changed records ride in this ONE request (fetch keepalive),
 *                         are merged into the caller's own document the way the page's upload would have, and the sweep runs at once (sms-flush.mjs)
 *        body { action:'owner-otp-send', phone }          -> text a verification code to the number being added to "Alerts to my own number"
 *        body { action:'owner-otp-verify', phone, code }  -> check it; the number becomes the account's verified number (sms-owner-otp.mjs)
 *   GET  /api/sms-notify   (same auth)       -> { ok, allowed, configured }
 *   GET  /api/sms-notify?check=1  (no auth)  -> { ok, configured, tokenAccepted }   two booleans: is a token set, does the gateway accept it
 *   GET  /api/sms-notify?check=1  (allowed account) -> the same plus { reachable, lowCredit, senderId, balanceReadable, balanceFields, failure }
 *                         neither sends anything, and neither shows a balance (balanceFields are the NAMES of the figures the gateway sent, for diagnosis). The gateway's answer is kept for 30 s, so
 *                         an unauthenticated caller cannot use this to hammer the gateway or to watch the credit run down.
 *
 * WHAT THE CALLER CANNOT CHOOSE: the recipient, the amount, the wording and the kind.
 * Every one of them is read from the caller's OWN document on the server. A request
 * body is a nudge ("look again") or, for `flush`, the caller's own changed records
 * to be merged into the caller's own document first, never an instruction ("send this
 * to that number"): a flush can write nothing the caller could not already write to
 * their own document through Firestore, so a stolen or malicious client cannot use
 * this endpoint to send anything the books do not already say.
 *
 * WHO MAY: sms-access.mjs. Everyone else gets a 403 that names nothing about the
 * gateway.
 *
 * ENV: TEXTLK_API_TOKEN, TEXTLK_SENDER_ID (optional), SMS_ALLOWED_EMAILS,
 *      FIREBASE_SERVICE_ACCOUNT, WEALTHFLOW_PUBLIC_ORIGIN (optional).
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { identify } from './gmail-link.mjs';
import { TextLkClient, KIND } from './textlk.mjs';
import { smsAllowed } from './sms-access.mjs';
import { sweepUser, ROOT } from './sms-engine.mjs';
import { hasSmsRecords } from './sms-events.mjs';
import { sendOwnerCode, verifyOwnerCode } from './sms-owner-otp.mjs';
import { cleanFlush, applyFlush } from './sms-flush.mjs';

/** Two kicks closer together than this are one kick: the page may call twice on a save. */
export const MIN_KICK_GAP_MS = 6000;

function j(res, code, body) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

function queryOf(req) {
    try { return new URL(String(req.url || ''), 'https://local.invalid').searchParams; } catch (_) { return new URLSearchParams(); }
}

/** A booleans-only health answer. Never sends; asks the gateway for the balance, which is free. */
export async function gatewayHealth(client) {
    if (!client.configured) return { configured: false, tokenAccepted: false, lowCredit: false, senderId: client.senderId };
    const b = await client.balance();
    if (b.ok) return { configured: true, reachable: true, tokenAccepted: true, lowCredit: b.units !== null && b.units <= 5, senderId: client.senderId, balanceReadable: b.units !== null, balanceFields: Object.keys(b.fields || {}), ...(b.shape ? { balanceShape: b.shape } : {}) };
    return { configured: true, reachable: ![KIND.NETWORK, KIND.TIMEOUT, KIND.SERVER].includes(b.kind), tokenAccepted: b.kind !== KIND.AUTH, lowCredit: b.kind === KIND.CREDIT, failure: b.kind, senderId: client.senderId };
}

export const HEALTH_TTL_MS = 30000;

/** One gateway call per 30 s per warm instance, whoever asks. */
async function cachedHealth(client, deps, now) {
    const cache = deps.healthCache || (deps.healthCache = {});
    if (cache.value && now - cache.at < HEALTH_TTL_MS) return cache.value;
    let value;
    try { value = await gatewayHealth(client); } catch (_) { value = { configured: client.configured, reachable: false, tokenAccepted: false, lowCredit: false, senderId: client.senderId }; }
    cache.value = value; cache.at = now;
    return value;
}

/** Everyone gets two booleans; an allowed signed-in account gets the rest. */
async function healthFor(req, client, deps, now) {
    const h = await cachedHealth(client, deps, now);
    const base = { ok: true, configured: h.configured, tokenAccepted: h.tokenAccepted };
    try {
        const { db, admin } = await deps.getAdminDb();
        if (!db) return base;                                       // no database, so no verified identity to be generous to
        const verifier = admin && typeof admin.auth === 'function' ? async (tk) => admin.auth().verifyIdToken(tk) : null;
        let claims = null;
        const who = await identify(req, { verifyIdToken: verifier ? async (tk) => { claims = await verifier(tk); return claims; } : null });
        if (who.ok && smsAllowed({ email: who.email, claims }, deps.env).ok) return { ...base, reachable: h.reachable, lowCredit: h.lowCredit, senderId: h.senderId, ...(h.balanceFields ? { balanceReadable: h.balanceReadable, balanceFields: h.balanceFields, ...(h.balanceShape ? { balanceShape: h.balanceShape } : {}) } : {}), ...(h.failure ? { failure: h.failure } : {}) };
    } catch (_) { /* an unreadable identity is the anonymous answer */ }
    return base;
}

/** The two steps of adding a number to "Alerts to my own number". The caller's identity and allow-list were checked; the number is the only thing taken from the body. */
async function handleOwnerOtp({ res, body, db, uid, client, deps, now }) {
    try {
        const out = body.action === 'owner-otp-send'
            ? await sendOwnerCode({ db, uid, phone: body.phone, client, env: deps.env, now, randomInt: deps.randomInt })
            : await verifyOwnerCode({ db, uid, phone: body.phone, code: body.code, env: deps.env, now });
        if (out.ok) return j(res, 200, out);
        const { status, ...rest } = out;
        return j(res, status || 400, { ...rest, error: out.reason });
    } catch (e) {
        console.error('[WF-SMS] owner code failed:', String((e && e.message) || e).slice(0, 200));
        return j(res, 500, { ok: false, error: 'failed', message: 'The code could not be handled just now. Try again in a moment.' });
    }
}

/**
 * The page is closing (or has just changed something) and cannot wait for its own upload: merge what it sends, then look. What the body may carry is
 * the books a text is derived from and nothing else; who is texted, how much and in what words are still read from the stored document afterwards.
 */
async function handleFlush({ res, body, db, who, client, deps, now }) {
    const clean = cleanFlush(body, now);
    if (!clean.ok) return j(res, 413, { ok: false, error: clean.reason });
    const rootRef = db.collection(ROOT).doc(who.uid);
    try {
        const applied = await withDeadline(applyFlush({ db, uid: who.uid, clean, now }), 12000, 'wf-flush');
        // no account document yet (a flush that raced the first upload): nothing was merged and nothing looked at, so the page must not count this as handled
        if (!applied.exists) return j(res, 200, { ok: true, deferred: true, flushed: applied.changed, summary: { derived: 0, configured: client.configured, empty: true } });
        const root = await withDeadline(rootRef.get(), 8000, 'wf-sms');
        const state = (root.exists && root.data()) || {};
        const has = hasSmsRecords(applied.user);
        await rootRef.set({ lastKickAt: now }, { merge: true });
        if (!has && !state.hadRecords) return j(res, 200, { ok: true, flushed: applied.changed, summary: { derived: 0, configured: client.configured, idle: true } });
        await rootRef.set({ active: true, email: who.email, registeredAt: state.registeredAt || now, hadRecords: has }, { merge: true });
        const summary = await sweepUser({ db, uid: who.uid, user: applied.user, client, now, env: deps.env, deps: deps.engine || {} });
        return j(res, 200, { ok: true, flushed: applied.changed, summary });
    } catch (e) {
        console.error('[WF-SMS] flush failed:', String((e && e.message) || e).slice(0, 200));
        return j(res, 500, { ok: false, error: 'sms flush failed' });
    }
}

export async function handleNotify(req, res, deps) {
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) return j(res, 405, { ok: false, error: 'method not allowed' });
    const client = deps.client();

    if (method === 'GET' && queryOf(req).get('check') === '1') return j(res, 200, await healthFor(req, client, deps, deps.now()));

    const { db, reason, admin } = await deps.getAdminDb();
    let claims = null;
    const verifier = admin && typeof admin.auth === 'function' ? async (t) => { claims = await admin.auth().verifyIdToken(t); return claims; } : null;
    const who = await identify(req, { verifyIdToken: verifier });
    if (!who.ok) return j(res, who.status || 401, { ok: false, error: who.reason });
    if (!who.uid) return j(res, 401, { ok: false, error: 'the token carries no user id' });
    if (!db) return j(res, 503, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });

    const access = smsAllowed({ email: who.email, claims }, deps.env);
    if (!access.ok) return j(res, 403, { ok: false, error: access.reason });
    if (method === 'GET') return j(res, 200, { ok: true, allowed: true, configured: client.configured });

    const now = deps.now();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (body.action === 'owner-otp-send' || body.action === 'owner-otp-verify') return handleOwnerOtp({ res, body, db, uid: who.uid, client, deps, now });
    if (body.action === 'flush') return handleFlush({ res, body, db, who, client, deps, now });
    const rootRef = db.collection(ROOT).doc(who.uid);
    try {
        const root = await withDeadline(rootRef.get(), 8000, 'wf-sms');
        const state = (root.exists && root.data()) || {};
        if (!body.force && now - Number(state.lastKickAt || 0) < MIN_KICK_GAP_MS) return j(res, 200, { ok: true, throttled: true });
        await rootRef.set({ lastKickAt: now }, { merge: true });                 // the throttle first: a slow sweep must not be started twice

        const snap = await withDeadline(db.collection('users').doc(who.uid).get(), 8000, 'users');
        if (!snap.exists) return j(res, 200, { ok: true, summary: { derived: 0, configured: client.configured, empty: true } });
        const user = snap.data() || {};
        const has = hasSmsRecords(user);
        if (!has && !state.hadRecords) return j(res, 200, { ok: true, summary: { derived: 0, configured: client.configured, idle: true } });
        // registering is what puts this account on the cron's list; an account whose records have all been switched off stays on it,
        // so what is still queued is cancelled or delivered. An account that never used SMS never gets on it.
        await rootRef.set({ active: true, email: who.email, registeredAt: state.registeredAt || now, hadRecords: has }, { merge: true });
        const summary = await sweepUser({ db, uid: who.uid, user, client, now, env: deps.env, deps: deps.engine || {} });
        return j(res, 200, { ok: true, summary });
    } catch (e) {
        console.error('[WF-SMS] notify failed:', String((e && e.message) || e).slice(0, 200));
        return j(res, 500, { ok: false, error: 'sms sweep failed' });
    }
}

export const defaultDeps = () => ({
    client: () => TextLkClient.fromEnv(process.env),
    getAdminDb,
    env: process.env,
    now: () => Date.now(),
    healthCache: {},
});

export default async function handler(req, res) {
    return handleNotify(req, res, defaultDeps());
}
