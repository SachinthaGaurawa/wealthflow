/* =============================================================================
 * sms-engine.mjs — queue, send, retry, account for every text message
 * -----------------------------------------------------------------------------
 * sms-events.mjs says WHICH messages the books owe. This file makes sure each of
 * them is sent exactly once, in the face of everything that goes wrong:
 *
 *   THE LEDGER. wf-sms/{uid}/events/{hash(key)} — one document per notice, created
 *   in a transaction, so a key that is already there is never queued twice (two
 *   sweeps racing, a page opened on two devices, the cron and a click). The body of
 *   the message is rendered ONCE, at queue time, and stored: a retry resends the very
 *   same words, and what the tenant is told cannot drift from one attempt to the next.
 *
 *   THE STATES. queued -> sending -> sent, or back to queued with a later
 *   `nextAttemptAt`. A terminal `failed` is reserved for what no retry can fix (a
 *   number that cannot receive, a message the gateway refuses) and for eight failed
 *   attempts. `cancelled` is a message that stopped being owed before it went (the
 *   owner switched the toggle off, deleted the record, un-confirmed the repayment).
 *   `expired` is a message that was held so long it is no longer news.
 *
 *   HOLDING IS NOT FAILING. Out of credit, a rejected token, an unapproved sender id:
 *   none of these is the message's fault, and all of them are the owner's to fix. The
 *   message waits (re-tried every six hours, not counted against its attempts) until
 *   the fix arrives or it expires. The account this was built for had ten units.
 *
 *   BACKOFF. A rate limit or a network failure is retried at 1 min, 5, 20, 60, 3 h,
 *   6 h, 12 h, 24 h (+/-10% jitter, or the gateway's own Retry-After if longer).
 *
 *   A WORKER THAT DIES. A message is claimed with a 60 s lease. If the worker never
 *   reports back, the lease lapses and the next sweep claims it again — marked
 *   `possiblyDuplicated`, because the gateway may have taken the first attempt. The
 *   gateway offers no idempotency key, so this is the one honest edge: at-least-once,
 *   never at-most-once, and flagged when it applies.
 *
 *   LIMITS. Per user, per recipient and per day, so a bug or a hostile account cannot
 *   turn the owner's balance into a firework.
 *
 *   THE OWNER SEES IT. Every state change is mirrored to users/{uid}/smsLog/{id} — a
 *   path the owner's own app can read live (Firestore's realtime stream is the
 *   serverless equivalent of a websocket) — so "SMS delivered to tenant" is on the
 *   admin dashboard within a second, and "held: out of credit" is too.
 *
 * Everything touching Firestore goes through an injected `db` (Admin SDK shape);
 * the clock, the gateway client and the random source are injected as well.
 * ===========================================================================*/

import crypto from 'node:crypto';
import { KIND, maskPhone, analyzeSms } from './textlk.mjs';
import { buildMessage, KINDS } from './sms-templates.mjs';
import { deriveEvents, nextSendWindow, MAX_AGE_MS, LOCAL_OFFSET_MIN } from './sms-events.mjs';
import { linksEnabled, linkFor, ensureTenantToken, portalSecret } from './tenant-links.mjs';
import { creditReserve, creditPaused, isPausedKind } from './sms-guard.mjs';

export const ROOT = 'wf-sms';
export const MIRROR = 'smsLog';
export const STATUS = Object.freeze({ QUEUED: 'queued', SENDING: 'sending', SENT: 'sent', FAILED: 'failed', CANCELLED: 'cancelled', EXPIRED: 'expired' });

export const LEASE_MS = 60 * 1000;
export const MAX_ATTEMPTS = 8;
export const BACKOFF_MS = [60e3, 5 * 60e3, 20 * 60e3, 60 * 60e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];
export const HOLD_MS = 6 * 3600e3;               // credit / token / sender: wait for the owner
export const CONCURRENCY = 3;
export const ENQUEUE_PER_RUN = 100;               // notices put into the ledger per run
export const SCAN_PER_RUN = 600;                  // notices looked at per run (most are already there)
export const DEFAULT_BUDGET_MS = 40000;
export const LIMITS = Object.freeze({ perUserPerDay: 300, perRecipientPerDay: 12 });
export const LOW_CREDIT_UNITS = 5;

export const ADMIN_ALERT = 'Admin Alert: SMS Delivered Successfully to Tenant';

/** Failures that wait for a person to fix something, so they neither burn attempts nor give up. */
const HOLD_KINDS = new Set([KIND.CREDIT, KIND.AUTH, KIND.SENDER, KIND.CONFIG]);
/** Failures no retry can fix. */
const TERMINAL_KINDS = new Set([KIND.INVALID_RECIPIENT, KIND.INVALID_MESSAGE, KIND.BLOCKED, KIND.DESTINATION, KIND.REJECTED]);

const s = (v) => String(v == null ? '' : v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const sha = (text, n = 40) => crypto.createHash('sha256').update(text).digest('hex').slice(0, n);

/** The ledger document id for an event key. */
export const docIdFor = (key) => sha(`wf-sms-event|${s(key)}`);
export const toHashOf = (e164) => sha(`wf-sms-to|${s(e164)}`, 24);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextUtcDay = (ms) => Date.parse(dayKey(ms) + 'T00:00:00Z') + 86400000;

/** When to try again. `attempts` is how many have failed so far. Pure. */
export function nextAttemptDelay(kind, attempts, { retryAfterMs = 0, random = Math.random } = {}) {
    if (HOLD_KINDS.has(kind)) return HOLD_MS;
    const base = BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
    const jitter = base * 0.1 * (random() * 2 - 1);
    return Math.max(Math.round(base + jitter), num(retryAfterMs));
}

/* ── the ledger ───────────────────────────────────────────────────────────── */

const eventsCol = (db, uid) => db.collection(ROOT).doc(uid).collection('events');
const mirrorRef = (db, uid, id) => db.collection('users').doc(uid).collection(MIRROR).doc(id);

/** Mirror a change to the owner-readable log. A failure here never fails a delivery. */
async function mirror(db, uid, id, patch, now) {
    try { await mirrorRef(db, uid, id).set({ ...patch, updatedAt: now }, { merge: true }); } catch (e) { console.warn('[WF-SMS] mirror failed:', s(e && e.message).slice(0, 120)); }
}

const mirrorOf = (d, extra = {}) => ({
    key: d.key, kind: d.kind, layer: d.layer, ref: d.ref, recordKind: d.recordKind, recordId: d.recordId,
    status: d.status, to: d.toMasked, body: d.body, segments: d.segments, attempts: d.attempts,
    amount: d.amount, currency: d.currency, occurredAt: d.occurredAt, nextAttemptAt: d.nextAttemptAt || null,
    error: d.lastError ? { kind: d.lastError.kind, message: d.lastError.message } : null,
    sentAt: d.sentAt || null, possiblyDuplicated: !!d.possiblyDuplicated, scheduled: !!d.scheduled, delivery: d.delivery || null,
    ...extra,
});

/**
 * Put every owed notice into the ledger once. Returns what happened to each.
 * @returns {{created:number, existing:number, rephoned:number, reopened:number, linked:number, noLink:number}}
 */
export async function enqueue({ db, uid, events, now, env = process.env, deps = {}, pause = false }) {
    const out = { created: 0, existing: 0, rephoned: 0, reopened: 0, refreshed: 0, linked: 0, noLink: 0 };
    if (pause) out.paused = 0;
    const col = eventsCol(db, uid);
    let secret = null;
    const wantLinks = linksEnabled(env);
    const nicTokens = new Map();                                   // one token lookup per NIC per run
    const linkOf = async (ev) => {
        if (!wantLinks || !ev.subject || !ev.subject.nic) return '';
        if (nicTokens.has(ev.subject.nic)) return nicTokens.get(ev.subject.nic);
        let link = '';
        try {
            secret = secret || portalSecret(env);
            const token = await ensureTenantToken({ db, uid, canonicalNic: ev.subject.nic, secret, randomBytes: deps.randomBytes, now });
            link = linkFor(token, env);
        } catch (e) { console.warn('[WF-SMS] tenant link unavailable:', s(e && e.message).slice(0, 120)); }
        nicTokens.set(ev.subject.nic, link);
        return link;
    };

    // Look at every owed notice, oldest first, but only PUT ENQUEUE_PER_RUN new ones in: the first hundred are already in the ledger on the
    // next run, so counting looks instead of puts would leave notice 101 and everything after it unqueued for ever.
    let looked = 0;
    for (const ev of events) {
        if (out.created + out.reopened >= ENQUEUE_PER_RUN || looked >= SCAN_PER_RUN) break;
        // Under the credit reserve the reminders nobody is waiting for are left owed, not queued (see sms-guard.mjs): they are put in once the balance is back.
        if (pause && isPausedKind(ev.kind)) { out.paused += 1; continue; }
        looked += 1;
        const id = docIdFor(ev.key);
        const ref = col.doc(id);
        const toHash = toHashOf(ev.phone);
        const tzMin = Number.isFinite(ev.tzMin) ? ev.tzMin : LOCAL_OFFSET_MIN;      // where the recipient is, for scheduled texts
        // The link is minted before the transaction: it is the only part that needs a write of its own, and it is idempotent.
        const link = await linkOf(ev);
        const body = buildMessage(ev.kind, { ...ev, link });
        if (!body) continue;
        const a = analyzeSms(body);
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) {
                const doc = {
                    key: ev.key, layer: ev.layer, kind: ev.kind, recordKind: ev.recordKind, recordId: ev.recordId, ref: ev.ref,
                    status: STATUS.QUEUED, attempts: 0, createdAt: now, occurredAt: ev.occurredAt,
                    nextAttemptAt: ev.scheduled ? nextSendWindow(Math.max(now, ev.notBefore || 0), tzMin) : now, leaseUntil: 0,
                    to: ev.phone, toHash, toMasked: maskPhone(ev.phone), tzMin,
                    body, segments: a.segments, encoding: a.encoding, amount: ev.amount, currency: ev.currency,
                    scheduled: !!ev.scheduled, linked: !!link, lastError: null, possiblyDuplicated: false,
                    ...(ev.maxAgeMs > 0 ? { maxAgeMs: ev.maxAgeMs } : {}),
                };
                tx.set(ref, doc);
                return { what: 'created', doc };
            }
            const d = snap.data() || {};
            const phoneChanged = d.toHash !== toHash;
            // A late reminder that has not been tried yet says what is owed NOW (a part payment confirmed while it waited changes the figure) and keeps
            // the shelf life the books give it today. Anything already tried keeps its words: the gateway may have taken the first attempt.
            const reminder = ev.kind === KINDS.B_LATE;
            const untried = d.status === STATUS.QUEUED && num(d.attempts) === 0 && !d.possiblyDuplicated;
            if (reminder && untried && !phoneChanged && (num(d.amount) !== num(ev.amount) || num(d.maxAgeMs) !== num(ev.maxAgeMs)) && s(d.body).includes(link || '')) {
                const doc = { ...d, body, segments: a.segments, encoding: a.encoding, amount: ev.amount, currency: ev.currency, ...(ev.maxAgeMs > 0 ? { maxAgeMs: ev.maxAgeMs } : {}) };
                tx.set(ref, doc);
                return { what: 'refreshed', doc };
            }
            // A reminder that expired under an older, shorter shelf life is owed again while the books still say it is in force.
            if (reminder && d.status === STATUS.EXPIRED && ev.maxAgeMs > 0 && now - ev.occurredAt <= ev.maxAgeMs) {
                const doc = {
                    ...d, status: STATUS.QUEUED, attempts: 0, nextAttemptAt: nextSendWindow(Math.max(now, ev.notBefore || 0), tzMin), leaseUntil: 0, to: ev.phone, toHash, toMasked: maskPhone(ev.phone), tzMin,
                    body, segments: a.segments, encoding: a.encoding, amount: ev.amount, currency: ev.currency, linked: !!link, lastError: null, maxAgeMs: ev.maxAgeMs, revivedAt: now,
                };
                tx.set(ref, doc);
                return { what: 'reopened', doc };
            }
            // The words carry a link to a statement that is keyed by NIC. A held text whose NIC was corrected still holds the OLD person's link,
            // and the corrected number would be sent somebody else's statement: so when the link the books call for is not the one in the
            // words, the words are written again (only a link that can be minted counts: no link now is not a reason to drop the old one).
            const staleLink = !!link && !s(d.body).includes(link);
            if (d.status === STATUS.QUEUED && (phoneChanged || staleLink)) {
                // a new number can be in another time zone: a scheduled text waits for ITS morning
                const doc = {
                    ...d, to: ev.phone, toHash, toMasked: maskPhone(ev.phone), tzMin,
                    body, segments: a.segments, encoding: a.encoding, amount: ev.amount, currency: ev.currency, linked: !!link,
                    ...(phoneChanged && d.scheduled ? { nextAttemptAt: nextSendWindow(Math.max(now, ev.notBefore || 0), tzMin) } : {}),
                };
                tx.set(ref, doc);
                return { what: 'rephoned', doc };
            }
            // a number that could never receive was corrected: the message that was refused is owed again
            if (d.status === STATUS.FAILED && phoneChanged && d.lastError && (d.lastError.kind === KIND.INVALID_RECIPIENT || d.lastError.kind === KIND.BLOCKED || d.lastError.kind === KIND.DESTINATION)) {
                const doc = {
                    ...d, status: STATUS.QUEUED, attempts: 0, nextAttemptAt: now, leaseUntil: 0, to: ev.phone, toHash, toMasked: maskPhone(ev.phone), tzMin, lastError: null,
                    body, segments: a.segments, encoding: a.encoding, amount: ev.amount, currency: ev.currency, linked: !!link,
                };
                tx.set(ref, doc);
                return { what: 'reopened', doc };
            }
            // Owed again after being cancelled (a repayment un-confirmed and confirmed again, a number blanked and corrected): it is a new
            // message, worded from the books as they are now, and the tenant is owed it unless it already went.
            if (d.status === STATUS.CANCELLED) {
                const doc = {
                    key: ev.key, layer: ev.layer, kind: ev.kind, recordKind: ev.recordKind, recordId: ev.recordId, ref: ev.ref,
                    status: STATUS.QUEUED, attempts: 0, createdAt: d.createdAt || now, occurredAt: ev.occurredAt,
                    nextAttemptAt: ev.scheduled ? nextSendWindow(Math.max(now, ev.notBefore || 0), tzMin) : now, leaseUntil: 0,
                    to: ev.phone, toHash, toMasked: maskPhone(ev.phone), tzMin,
                    body, segments: a.segments, encoding: a.encoding, amount: ev.amount, currency: ev.currency,
                    scheduled: !!ev.scheduled, linked: !!link, lastError: null, possiblyDuplicated: false, revivedAt: now,
                    ...(ev.maxAgeMs > 0 ? { maxAgeMs: ev.maxAgeMs } : {}),
                };
                tx.set(ref, doc);
                return { what: 'reopened', doc };
            }
            return { what: 'existing', doc: d };
        });
        out[result.what] += 1;
        if (result.what === 'created') { if (link) out.linked += 1; else if (ev.subject && ev.subject.nic) out.noLink += 1; }
        if (result.what !== 'existing') await mirror(db, uid, id, mirrorOf(result.doc), now);
    }
    return out;
}

/** Messages no longer owed (toggle off, record gone, repayment un-confirmed) are cancelled before they go. Only `queued` ones: a message in flight is left alone. */
export async function cancelUnowed({ db, uid, ownedKeys, now }) {
    const snap = await eventsCol(db, uid).where('status', '==', STATUS.QUEUED).limit(300).get();
    let cancelled = 0;
    for (const doc of snap.docs) {
        const d = doc.data() || {};
        if (ownedKeys.has(d.key)) continue;
        const next = { ...d, status: STATUS.CANCELLED, cancelledAt: now, lastError: { kind: 'no-longer-owed', message: 'the record, the toggle or the confirmation changed before this was sent', at: now } };
        await db.runTransaction(async (tx) => {
            const cur = await tx.get(doc.ref);
            if (cur.exists && (cur.data() || {}).status === STATUS.QUEUED) tx.set(doc.ref, next);
        });
        await mirror(db, uid, doc.id, mirrorOf(next), now);
        cancelled += 1;
    }
    return cancelled;
}

/** Take a message for sending: due, not already sent, and not held by a live lease. Returns the document, or null. */
export async function claim({ db, uid, id, now }) {
    const ref = eventsCol(db, uid).doc(id);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const d = snap.data() || {};
        const crashed = d.status === STATUS.SENDING && num(d.leaseUntil) <= now;
        if (d.status !== STATUS.QUEUED && !crashed) return null;
        if (d.status === STATUS.QUEUED && num(d.nextAttemptAt) > now) return null;
        // a notice that carries its own shelf life (the balance the owner asked for) expires on that, not on the month every other one gets
        if (now - num(d.occurredAt) > (num(d.maxAgeMs) > 0 ? num(d.maxAgeMs) : MAX_AGE_MS)) {
            const doc = { ...d, status: STATUS.EXPIRED, expiredAt: now, lastError: { kind: 'expired', message: 'held too long to still be news', at: now } };
            tx.set(ref, doc);
            return { expired: true, doc };
        }
        // A scheduled text is one that is not news the moment it happens (a reminder, a monthly interest notice), so it only ever goes out in the
        // recipient's 08:00-20:00. "Due" is not enough: the daily sweep and a page nudge run at any hour, and a text that was queued for the
        // morning must not go at 03:00 just because that is when a sweep got to it. Outside the window it waits for the next one.
        if (d.status === STATUS.QUEUED && d.scheduled === true) {
            const tz = Number.isFinite(d.tzMin) ? d.tzMin : LOCAL_OFFSET_MIN;
            const open = nextSendWindow(now, tz);
            if (open > now) { tx.set(ref, { ...d, nextAttemptAt: open, ...(d.lastError && d.lastError.kind === 'reserve' ? { lastError: null } : {}) }); return null; }
        }
        const doc = { ...d, status: STATUS.SENDING, leaseUntil: now + LEASE_MS, attempts: num(d.attempts) + 1, possiblyDuplicated: !!d.possiblyDuplicated || crashed };
        tx.set(ref, doc);
        return { doc };
    });
}

/**
 * Take one place in today's quota, atomically. RESERVE BEFORE SENDING: read-then-send-then-count lets every message in flight
 * (and a cron sweep racing a kick) read the same "not yet at the limit" and all go, so the cap is overshot by exactly the
 * concurrency it was meant to contain. The reservation is one transaction, so two senders can never both take the last place.
 * A crash between reserving and sending leaves the counter one too high — the safe side for a cost limit.
 */
async function reserve({ db, uid, doc, now, limits }) {
    const ref = db.collection(ROOT).doc(uid).collection('quota').doc(dayKey(now));
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const q = (snap.exists && snap.data()) || {};
        const perTo = { ...(q.perTo || {}) };
        if (num(q.sent) >= limits.perUserPerDay) return { ok: false, reason: 'daily limit for this account reached' };
        if (num(perTo[doc.toHash]) >= limits.perRecipientPerDay) return { ok: false, reason: 'daily limit for this number reached' };
        perTo[doc.toHash] = num(perTo[doc.toHash]) + 1;
        tx.set(ref, { sent: num(q.sent) + 1, perTo, date: dayKey(now) });
        return { ok: true };
    });
}

/** Give the place back when the gateway certainly did not send. Never below zero; a failure here only costs a place. */
async function release({ db, uid, doc, now }) {
    const ref = db.collection(ROOT).doc(uid).collection('quota').doc(dayKey(now));
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const q = (snap.exists && snap.data()) || {};
            const perTo = { ...(q.perTo || {}) };
            perTo[doc.toHash] = Math.max(0, num(perTo[doc.toHash]) - 1);
            tx.set(ref, { sent: Math.max(0, num(q.sent) - 1), perTo, date: dayKey(now) });
        });
    } catch (_) { /* the counter is a brake, not a ledger */ }
}

/** One attempt on one claimed message. Returns 'sent' | 'held' | 'retry' | 'failed'. */
export async function deliver({ db, uid, id, doc, client, now, limits = LIMITS, deps = {} }) {
    const ref = eventsCol(db, uid).doc(id);
    const save = async (next) => { await db.runTransaction(async (tx) => { tx.set(ref, next); }); await mirror(db, uid, id, mirrorOf(next, next.status === STATUS.SENT ? { alert: ADMIN_ALERT } : {}), now); };

    const room = await reserve({ db, uid, doc, now, limits });
    if (!room.ok) {
        // not the message's fault, and not a failed attempt: wait for the day to turn over
        const next = { ...doc, status: STATUS.QUEUED, leaseUntil: 0, attempts: Math.max(0, num(doc.attempts) - 1), nextAttemptAt: nextUtcDay(now) + 3600e3, lastError: { kind: 'cap', message: room.reason, at: now } };
        await save(next);
        console.warn(`[WF-SMS] held kind=cap ref=${doc.ref} reason="${room.reason}"`);
        return 'held';
    }

    let res;
    try { res = await client.send({ to: doc.to, message: doc.body }); } catch (e) { res = { ok: false, kind: KIND.UNKNOWN, retryable: true, message: s(e && e.message) || 'the gateway call threw', possiblySent: true }; }
    if (res.ok) {
        const next = { ...doc, status: STATUS.SENT, leaseUntil: 0, sentAt: now, gatewayId: res.gatewayId, cost: res.cost, segments: res.segments || doc.segments, nextAttemptAt: 0, lastError: null, ...(res.gatewayId ? { dlrPending: true } : {}) };
        // The text is on its way. Losing the record of that is the one way a message can be sent twice, so the write is tried again before giving up.
        let recorded = false;
        for (let i = 0; i < 3 && !recorded; i += 1) {
            try { await save(next); recorded = true; } catch (e) { if (i < 2) await new Promise((r) => setTimeout(r, deps.retryDelayMs === undefined ? 200 * (i + 1) : deps.retryDelayMs)); }
        }
        if (!recorded) console.error(`[WF-SMS] CRITICAL sent but not recorded ref=${doc.ref}: the lease will lapse and it may be sent again`);
        console.info(`[WF-SMS] sent kind=${doc.kind} ref=${doc.ref} to=${doc.toMasked} segments=${next.segments}`);
        return 'sent';
    }

    // the gateway certainly did not send: give the quota place back (a timeout MIGHT have sent, so that one stays counted)
    if (!res.possiblySent) await release({ db, uid, doc, now });
    const lastError = { kind: res.kind, message: s(res.message).slice(0, 200), at: now, ...(res.httpStatus ? { http: res.httpStatus } : {}) };
    const possiblyDuplicated = !!doc.possiblyDuplicated || !!res.possiblySent;
    const holding = HOLD_KINDS.has(res.kind);
    const terminal = TERMINAL_KINDS.has(res.kind) || (!holding && num(doc.attempts) >= MAX_ATTEMPTS);
    if (terminal) {
        const next = { ...doc, status: STATUS.FAILED, leaseUntil: 0, failedAt: now, lastError, possiblyDuplicated };
        await save(next);
        console.warn(`[WF-SMS] failed kind=${res.kind} ref=${doc.ref} attempts=${doc.attempts}`);
        return 'failed';
    }
    const delay = nextAttemptDelay(res.kind, num(doc.attempts), { retryAfterMs: res.retryAfterMs, random: deps.random });
    const next = {
        ...doc, status: STATUS.QUEUED, leaseUntil: 0, lastError, possiblyDuplicated,
        // a hold does not use up an attempt: the message did nothing wrong
        attempts: holding ? Math.max(0, num(doc.attempts) - 1) : num(doc.attempts),
        nextAttemptAt: doc.scheduled ? nextSendWindow(now + delay, Number.isFinite(doc.tzMin) ? doc.tzMin : LOCAL_OFFSET_MIN) : now + delay,
    };
    await save(next);
    console.warn(`[WF-SMS] ${holding ? 'held' : 'retry'} kind=${res.kind} ref=${doc.ref} next=${new Date(next.nextAttemptAt).toISOString()}`);
    return holding ? 'held' : 'retry';
}

/** Run `work` over `items` with at most `n` in flight. */
async function pool(items, n, work) {
    const queue = items.slice();
    const results = [];
    await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) results.push(await work(item));
    }));
    return results;
}

/** Everything in the ledger that is due, oldest first. */
async function dueIds({ db, uid, now }) {
    const out = [];
    for (const status of [STATUS.QUEUED, STATUS.SENDING]) {
        const snap = await eventsCol(db, uid).where('status', '==', status).limit(300).get();
        for (const doc of snap.docs) {
            const d = doc.data() || {};
            const due = status === STATUS.QUEUED ? num(d.nextAttemptAt) <= now : num(d.leaseUntil) <= now;
            if (due) out.push({ id: doc.id, at: num(d.occurredAt), to: s(d.toHash), kind: s(d.kind), held: s(d.lastError && d.lastError.kind), status });
        }
    }
    return out.sort((a, b) => a.at - b.at);
}

/**
 * The due texts, grouped by who they go to, each group oldest first. A person's texts are sent one after the other so they arrive in the order
 * they happened (the repayment receipt before the "loan closed" text that follows it); different people, and a person's second number, are
 * sent side by side.
 */
function dueGroups(due) {
    const groups = new Map();
    for (const x of due) { if (!groups.has(x.to)) groups.set(x.to, []); groups.get(x.to).push(x.id); }
    return [...groups.values()];
}

/** A text that is waiting because credit is under the reserve says so in the owner's log, instead of just "Waiting to be sent". */
async function noteReserve({ db, uid, ids, units, reserve, now }) {
    for (const id of ids.slice(0, 100)) {
        try {
            const ref = eventsCol(db, uid).doc(id);
            let next = null;
            await db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                const d = snap.exists ? (snap.data() || {}) : null;
                if (!d || d.status !== STATUS.QUEUED) return;
                next = { ...d, lastError: { kind: 'reserve', message: `credit is ${num(units)} units, under the reserve of ${num(reserve)}`, at: now } };
                tx.set(ref, next);
            });
            if (next) await mirror(db, uid, id, mirrorOf(next), now);
        } catch (e) { console.warn('[WF-SMS] reserve note failed:', s(e && e.message).slice(0, 120)); }
    }
}

export const DELIVERY_CHECKS_PER_RUN = 25;
export const DELIVERY_WATCH_MS = 3 * 86400000;
export const DELIVERY_RECHECK_MS = 3 * 3600e3;

/**
 * "Sent" only means the gateway took the text. Ask it, a few at a time, what became of the recent ones, so a text the carrier did not deliver is
 * shown as that and not as "Delivered" for ever. An answer that is neither a clear yes nor a clear no is asked again later; one that cannot be
 * asked (no lookup on the client, the gateway down) changes nothing.
 */
export async function checkDelivery({ db, uid, client, now }) {
    const out = { checked: 0, delivered: 0, undelivered: 0 };
    if (!client || !client.configured || typeof client.lookup !== 'function') return out;
    const snap = await eventsCol(db, uid).where('dlrPending', '==', true).limit(100).get();
    let asked = 0;
    for (const doc of snap.docs) {
        const d = doc.data() || {};
        const age = now - num(d.sentAt);
        const finish = async (patch) => {
            const next = { ...d, ...patch };
            await db.runTransaction(async (tx) => { const cur = await tx.get(doc.ref); if (cur.exists && (cur.data() || {}).status === STATUS.SENT) tx.set(doc.ref, next); });
            await mirror(db, uid, doc.id, mirrorOf(next), now);
        };
        if (d.status !== STATUS.SENT || !d.gatewayId || age > DELIVERY_WATCH_MS) { await finish({ dlrPending: false }); continue; }
        if (d.delivery && now - num(d.delivery.checkedAt) < DELIVERY_RECHECK_MS) continue;
        if (asked >= DELIVERY_CHECKS_PER_RUN) break;
        asked += 1;
        let r;
        try { r = await client.lookup(d.gatewayId); } catch (_) { r = { ok: false }; }
        out.checked += 1;
        if (!r || !r.ok) continue;
        if (r.state === 'delivered') { out.delivered += 1; await finish({ dlrPending: false, delivery: { state: 'delivered', checkedAt: now } }); }
        else if (r.state === 'undelivered') { out.undelivered += 1; await finish({ dlrPending: false, delivery: { state: 'undelivered', checkedAt: now, note: s(r.raw).slice(0, 40) } }); console.warn(`[WF-SMS] gateway reports not delivered ref=${d.ref} status="${s(r.raw).slice(0, 40)}"`); }
        else await finish({ delivery: { state: 'pending', checkedAt: now } });
    }
    return out;
}

/** Write the owner's status card: what is switched on but cannot work, whether the gateway is configured, whether credit is low. */
export async function writeStatus({ db, uid, issues, configured, units = null, now, reserve = 0 }) {
    // A sweep that did not ask the gateway for the balance (the page's nudge after a save) knows nothing about it, and must not erase what the
    // last one that did (the daily sweep) found: writing `units: null` here made the low-credit warning vanish at the owner's next save.
    const credit = units === null || units === undefined ? {} : { units, lowCredit: units <= LOW_CREDIT_UNITS, unitsAt: now, reserve, creditPaused: creditPaused(units, reserve) };
    await mirror(db, uid, '_status', { kind: 'status', configured: !!configured, issues: issues.slice(0, 50), ...credit }, now);
}

/**
 * The whole job for one user: derive what is owed, queue it, cancel what is no longer owed, send what is due.
 * `user` is the user's document, already read and trusted by the caller.
 */
export async function sweepUser({ db, uid, user, client, now = Date.now(), env = process.env, budgetMs = DEFAULT_BUDGET_MS, limits = LIMITS, deps = {}, clock = Date.now }) {
    const startedAt = clock();
    const { events, issues } = deriveEvents(user, now);
    const owned = new Set(events.map((e) => e.key));
    const summary = { derived: events.length, issues: issues.length, configured: client.configured, enqueued: {}, cancelled: 0, sent: 0, held: 0, retry: 0, failed: 0, remaining: 0 };

    // THE CREDIT RESERVE (sms-guard.mjs). The sweep reads the balance once for every account; a run that did not (the page's nudge after a save) reads it
    // here, and only if there is a reminder it would otherwise queue or send, so most nudges cost no call. The call is free; an unreadable balance
    // is "unknown", and unknown never stops anything.
    const reserve = creditReserve(env);
    let units = deps.units === undefined ? null : deps.units;
    let creditAsked = units !== null;
    const paused = async (needed) => {
        if (!reserve || !needed) return false;
        if (!creditAsked) {
            creditAsked = true;
            if (client.configured && typeof client.balance === 'function') {
                try { const b = await client.balance(); if (b && b.ok && Number.isFinite(Number(b.units))) units = Number(b.units); } catch (_) { /* unknown */ }
            }
        }
        return creditPaused(units, reserve);
    };

    summary.cancelled = await cancelUnowed({ db, uid, ownedKeys: owned, now });
    const hold = await paused(events.some((e) => isPausedKind(e.kind)));
    summary.enqueued = await enqueue({ db, uid, events, now, env, deps, pause: hold });

    if (client.configured) {
        let due = await dueIds({ db, uid, now });
        const holdDue = hold || await paused(due.some((x) => isPausedKind(x.kind)));
        if (holdDue) {
            const stopped = due.filter((x) => isPausedKind(x.kind));
            summary.paused = stopped.length;
            due = due.filter((x) => !isPausedKind(x.kind));
            await noteReserve({ db, uid, ids: stopped.filter((x) => x.status === STATUS.QUEUED && x.held !== 'reserve').map((x) => x.id), units, reserve, now });
        }
        const groups = dueGroups(due);
        await pool(groups, CONCURRENCY, async (ids) => {
            for (const id of ids) {
                if (clock() - startedAt > budgetMs) { summary.remaining += 1; continue; }
                const claimed = await claim({ db, uid, id, now });
                if (!claimed) continue;
                if (claimed.expired) { await mirror(db, uid, id, mirrorOf(claimed.doc), now); continue; }
                const outcome = await deliver({ db, uid, id, doc: claimed.doc, client, now, limits, deps });
                summary[outcome] += 1;
            }
        });
    }
    try { summary.delivery = await checkDelivery({ db, uid, client, now }); } catch (e) { console.warn('[WF-SMS] delivery check failed:', s(e && e.message).slice(0, 120)); }
    await writeStatus({ db, uid, issues, configured: client.configured, units, now, reserve });
    return summary;
}

export default { ROOT, MIRROR, STATUS, LIMITS, ADMIN_ALERT, checkDelivery, docIdFor, toHashOf, nextAttemptDelay, enqueue, cancelUnowed, claim, deliver, sweepUser, writeStatus };
