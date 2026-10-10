/* =============================================================================
 * tenant-portal.mjs — NIC + one-time code, then the statement
 * -----------------------------------------------------------------------------
 * A tenant (an investor or a debtor) opens the link from their text message,
 * types their NIC, receives a 6-digit code on the mobile number the lender
 * recorded, types it, and sees ONE statement: every investment and loan the lender
 * switched text messages on for under that NIC (tenant-statement.mjs).
 *
 * THE THREE FACTORS. The link (96 random bits, only ever sent to the recorded
 * phone), the NIC (an identifier, NOT a secret: it is on every bank form), and a code
 * that only the holder of the recorded phone can read. Each is checked on the server,
 * and none of them is enough alone.
 *
 * WHAT A STRANGER LEARNS. Nothing. Every request for a code gets the same answer
 * whether the link is real, the NIC matches, a phone exists or the gateway is down,
 * in the same words, with the same "wait 60 seconds", and not faster when it is
 * going to do nothing. A wrong NIC and a wrong code are the same refusal. The only
 * differences a caller can see — "too many tries" and "wait" — depend on how often
 * they asked, never on what they typed.
 *
 * THE CODE.
 *   - crypto.randomInt(0, 1_000_000), left-padded: uniform and unpredictable.
 *   - stored only as an HMAC under the server secret, bound to its link and its
 *     issue time, so a copy of the database holds no code and a code cannot be moved
 *     from one link to another.
 *   - alive for 3 minutes, usable on 5 wrong tries, usable ONCE, replaced (and the
 *     old one dead) when another is issued.
 *   - issued at most once per 60 s, 5 per hour and 10 per day per link, and 300 per day
 *     in total: each is a text message the owner pays for. The slot is reserved in a
 *     transaction BEFORE the gateway is called, so parallel requests send one text.
 *   - checked inside ONE transaction that also spends it and creates the session, so
 *     two parallel correct submissions yield exactly one session.
 *
 * LOCKOUT. Five wrong answers on a link lock it for 15 minutes, then 30, 60... up
 * to a day, and kill the live code. With the cap on codes, a stranger who somehow knew
 * both the link and the NIC gets at most ~50 guesses a day at a 1-in-a-million code.
 * (Someone holding the link can lock out its owner for a quarter of an hour; the link
 * only ever went to the owner's phone, and that is the price of a lock that works.)
 *
 * THE SESSION. A 192-bit random id in an HttpOnly, Secure, SameSite=Strict cookie
 * scoped to the portal's own endpoint; the server keeps only its SHA-256. 20 minutes
 * from the code, no sliding, killed by "Sign out".
 *
 * Everything touching Firestore goes through an injected `db` (Admin SDK shape).
 * ===========================================================================*/

import crypto from 'node:crypto';
import { normalizeIdentity, identityCandidates } from './wealthflow-nic.js';
import { normalizePhone, maskPhone } from './wealthflow-phone.js';
import { otpMessage } from './sms-templates.mjs';
import { KIND } from './textlk.mjs';
import { FIELDS } from './sms-events.mjs';
import { ADMIN_ALERT, ROOT as SMS_ROOT } from './sms-engine.mjs';
import { TENANTS, SUBJECTS, TOKEN_RE, nicHashOf, phoneHashOf } from './tenant-links.mjs';
import { buildStatement } from './tenant-statement.mjs';
import { withDeadline } from './admin-db.mjs';

export const LIMITS_COL = 'wf-tenant-limits';
export const COOKIE = 'wf_tp';
export const SESSION_RE = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{32})$/;

export const OTP_DIGITS = 6;
export const OTP_TTL_MS = 3 * 60 * 1000;
export const OTP_ATTEMPTS = 5;
export const RESEND_GAP_MS = 60 * 1000;
export const SESSION_TTL_MS = 20 * 60 * 1000;
export const MIN_ANSWER_MS = 800;                     // a request that does nothing takes as long as one that sends (the text itself is sent after the answer, so a sending request is no longer slower than this)
export const MAX_OTHER_LENDERS = 10;
const HOUR = 3600e3;
const DAY = 86400e3;

export const LIMITS = Object.freeze({
    codesPerTokenHour: 5,
    codesPerTokenDay: 10,
    codesPerDay: 300,
    // A coarse net only (mobile carriers put many subscribers behind one address); the per-link caps above are what stop guessing.
    requestsPerIpHour: 30,
    verifiesPerIpHour: 100,
    statementsPerIpHour: 300,
    pdfsPerIpHour: 30,                                // a download renders a file, so it has a bucket of its own
});
export const LOCK = Object.freeze({ fails: 5, windowMs: 15 * 60e3, baseMs: 15 * 60e3, maxMs: DAY });

export const MSG = Object.freeze({
    ACCEPTED: 'If those details match our records, a 6-digit code is on its way to the mobile number we hold. It expires in 3 minutes.',
    BAD_LINK: 'This link is not valid. Please use the link in your text message.',
    BAD_NIC: 'Enter your NIC as 9 digits followed by V or X, or as 12 digits. If you have no Sri Lankan NIC, enter your passport or ID number.',
    BAD_CODE: 'Enter the 6-digit code from the text message.',
    DENIED: 'The details or the code are not valid, or the code has expired. Request a new code and try again.',
    SLOW_DOWN: 'Too many attempts. Please wait a while and try again.',
    CODES_CAPPED: 'Too many codes have been requested. Please try again later.',
    UNAVAILABLE: 'Codes are temporarily unavailable. Please try again later.',
    NO_SESSION: 'Your session has ended. Please sign in again.',
    FAILED: 'Something went wrong. Please try again.',
});

const s = (v) => String(v == null ? '' : v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arr = (v) => (Array.isArray(v) ? v : []);
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextUtcDay = (ms) => Date.parse(`${utcDay(ms)}T00:00:00Z`) + DAY;
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const digest = (v) => crypto.createHash('sha256').update(s(v)).digest();
const secs = (ms) => Math.max(1, Math.ceil(ms / 1000));
const DUMMY = sha('wealthflow-tenant-portal-dummy');

/** Constant-time equality for strings of any length. */
export const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

/** A uniform, unpredictable 6-digit code. */
export function newCode(randomInt = crypto.randomInt) {
    return String(randomInt(0, 10 ** OTP_DIGITS)).padStart(OTP_DIGITS, '0');
}

/** What is stored in place of a code: bound to the link and to the moment it was issued. */
export const codeProof = (secret, token, issuedAt, code) => crypto.createHmac('sha256', secret).update(`otp|${s(token)}|${num(issuedAt)}|${s(code)}`).digest('hex');

export const sessionHash = (sid) => sha(`wf-tenant-session|${s(sid)}`);

export function clientIp(req) {
    const h = (req && req.headers) || {};
    const first = (v) => s(Array.isArray(v) ? v[0] : v).split(',')[0].trim();
    return [h['x-vercel-forwarded-for'], h['x-real-ip'], h['x-forwarded-for']].map(first).find(Boolean) || 'unknown';
}
/** The caller's address as an HMAC, so the limiter's documents hold no address. */
export const ipKey = (req, secret) => crypto.createHmac('sha256', secret).update(`ip|${clientIp(req)}`).digest('hex').slice(0, 24);

export function parseCookies(header) {
    const out = {};
    for (const part of s(header).split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
}

export const sessionCookie = (token, sid, maxAgeSec = SESSION_TTL_MS / 1000) =>
    `${COOKIE}=${token}.${sid}; HttpOnly; Secure; SameSite=Strict; Path=/api/tenant-portal; Max-Age=${maxAgeSec}`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api/tenant-portal; Max-Age=0`;

const result = (status, body, extra = {}) => ({ status, body, ...extra });
const accepted = () => result(200, { ok: true, message: MSG.ACCEPTED, resendAfterSec: RESEND_GAP_MS / 1000, expiresInSec: OTP_TTL_MS / 1000 });
const tooMany = (retryAfterMs, error = MSG.SLOW_DOWN) => result(429, { ok: false, error, retryAfterSec: secs(retryAfterMs) });
const denied = () => result(401, { ok: false, error: MSG.DENIED });

/* ── limits ───────────────────────────────────────────────────────────────── */

/** One counted hit against a fixed window, in a transaction. */
export async function hit(db, id, limit, windowMs, now) {
    const ref = db.collection(LIMITS_COL).doc(id);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const d = snap.exists ? snap.data() : {};
        const live = num(d.start) > 0 && now - num(d.start) < windowMs;
        const start = live ? num(d.start) : now;
        const count = live ? num(d.count) : 0;
        if (count >= limit) return { ok: false, retryAfterMs: start + windowMs - now };
        tx.set(ref, { start, count: count + 1, expiresAt: start + windowMs });
        return { ok: true };
    });
}

/** The lockout counters after one more wrong answer. Pure. */
export function failState(t, now) {
    const within = num(t.failStart) > 0 && now - num(t.failStart) < LOCK.windowMs;
    const fails = (within ? num(t.fails) : 0) + 1;
    if (fails >= LOCK.fails) {
        const lockCount = num(t.lockCount) + 1;
        return { fails: 0, failStart: 0, lockCount, lockedUntil: now + Math.min(LOCK.baseMs * 2 ** (lockCount - 1), LOCK.maxMs) };
    }
    return { fails, failStart: within ? num(t.failStart) : now, lockCount: num(t.lockCount), lockedUntil: num(t.lockedUntil) };
}

async function noteFailure(db, tenantRef, now) {
    await db.runTransaction(async (tx) => {
        const t = await tx.get(tenantRef);
        if (!t.exists) return;
        tx.set(tenantRef, failState(t.data() || {}, now), { merge: true });
    });
}

/**
 * Which reading of what was typed is the one the link was made for, or ''. EVERY candidate is compared (no early exit), so the time
 * taken depends on how the input is shaped, never on whether it matched.
 */
export function matchIdentity(candidates, storedHash, secret) {
    let found = '';
    for (const c of candidates) {
        const same = safeEqual(nicHashOf(c, secret), storedHash);
        if (same && !found) found = c;
    }
    return found;
}

/* ── who the code goes to ─────────────────────────────────────────────────── */

/** The number on the record the lender most recently switched on for this NIC. Server-side only: the caller never names it. */
export function pickRecipient(user, canonicalNic, secret) {
    const u = user && typeof user === 'object' ? user : {};
    let best = null;
    for (const rec of [...arr(u.income), ...arr(u.debtors)]) {
        if (!rec || rec[FIELDS.ENABLED] !== true) continue;
        const n = normalizeIdentity(rec[FIELDS.NIC]);
        if (!n.ok || n.canonical !== canonicalNic) continue;
        const p = normalizePhone(rec[FIELDS.PHONE]);
        if (!p.ok) continue;
        const at = num(rec[FIELDS.ENABLED_AT]);
        if (!best || at > best.at) best = { e164: p.e164, at };
    }
    return best ? { e164: best.e164, masked: maskPhone(best.e164), phoneHash: phoneHashOf(best.e164, secret) } : null;
}

/** The owner's log shows the portal's texts too, without the code: a code that is never stored cannot be read from a log. */
async function mirrorOtp(db, uid, { ok, masked, kind, message, at }) {
    try {
        const doc = {
            key: `otp:${at}`, kind: 'otp', layer: 'portal', ref: 'PORTAL', recordKind: 'portal', recordId: '',
            status: ok ? 'sent' : 'failed', to: masked, segments: 1, attempts: 1, nextAttemptAt: null, possiblyDuplicated: false,
            body: ok ? 'Statement portal: a verification code was sent (the code itself is never kept).' : 'Statement portal: a verification code could not be sent.',
            error: ok ? null : { kind: s(kind), message: s(message).slice(0, 160) },
            sentAt: ok ? at : null, occurredAt: at, updatedAt: at,
            ...(ok ? { alert: ADMIN_ALERT } : {}),
        };
        await db.collection('users').doc(uid).collection('smsLog').doc(`otp-${at}`).set(doc, { merge: true });
    } catch (e) { console.warn('[WF-PORTAL] mirror failed:', s(e && e.message).slice(0, 120)); }
}

/* ── asking for a code ────────────────────────────────────────────────────── */

/**
 * @param {{db:object, client:{send:Function}, token:string, nic:string, ip:string, secret:Buffer, now:number,
 *          random?:Function, pad?:(ms:number)=>Promise<void>, defer?:(work:Promise<unknown>)=>void}} p
 * @returns {Promise<{status:number, body:object}>}
 */
export async function requestCode({ db, client, token, nic, ip, secret, now, random = crypto.randomInt, pad = async () => {}, defer = null }) {
    if (!TOKEN_RE.test(s(token))) return result(400, { ok: false, error: MSG.BAD_LINK });
    // what was typed can be a Sri Lankan NIC, a passport / ID number, or (a 12-digit string) either: each reading is compared with the link's
    const candidates = identityCandidates(nic);
    if (!candidates.length) return result(400, { ok: false, error: MSG.BAD_NIC });

    // the limiter and the link's own document do not depend on each other, so they are asked together (one round trip less)
    const tenantRef = db.collection(TENANTS).doc(token);
    const [gate, snap] = await Promise.all([hit(db, `rq-${ip}`, LIMITS.requestsPerIpHour, HOUR, now), withDeadline(tenantRef.get(), 8000, 'tenant')]);
    if (!gate.ok) return tooMany(gate.retryAfterMs);
    const tenant = snap.exists ? (snap.data() || {}) : null;
    const matched = matchIdentity(candidates, tenant && typeof tenant.nicHash === 'string' ? tenant.nicHash : DUMMY, secret);
    if (!tenant || tenant.active === false || !tenant.uid) { await pad(MIN_ANSWER_MS); return accepted(); }
    if (num(tenant.lockedUntil) > now) return tooMany(num(tenant.lockedUntil) - now);
    if (!matched) { await noteFailure(db, tenantRef, now); await pad(MIN_ANSWER_MS); return accepted(); }

    // A lender the owner has since stopped (access removed, sign-in disabled or deleted: the daily sweep records that as `active: false`) must not
    // go on spending the owner's units through this door either. Only an explicit false stops it; no registration document is just "not registered yet".
    const [lenderRoot, userSnap] = await Promise.all([
        withDeadline(db.collection(SMS_ROOT).doc(s(tenant.uid)).get(), 8000, 'wf-sms'),
        withDeadline(db.collection('users').doc(s(tenant.uid)).get(), 8000, 'users'),
    ]);
    if (lenderRoot.exists && (lenderRoot.data() || {}).active === false) { await pad(MIN_ANSWER_MS); return accepted(); }

    const to = pickRecipient(userSnap.exists ? userSnap.data() : {}, matched, secret);
    if (!to) { console.warn('[WF-PORTAL] no recipient for a valid link'); await pad(MIN_ANSWER_MS); return accepted(); }

    // The slot is taken BEFORE the gateway is called: two requests in parallel get one text, and a gateway that is slow cannot be used to get more.
    const otpRef = tenantRef.collection('otp').doc('current');
    const dayRef = db.collection(LIMITS_COL).doc(`otp-day-${utcDay(now)}`);
    const slot = await db.runTransaction(async (tx) => {
        const o = await tx.get(otpRef);
        const g = await tx.get(dayRef);
        const cur = o.exists ? (o.data() || {}) : {};
        const since = now - num(cur.lastSentAt);
        if (num(cur.lastSentAt) > 0 && since < RESEND_GAP_MS) return { gate: 'cooldown' };
        const sameHour = num(cur.hourStart) > 0 && now - num(cur.hourStart) < HOUR;
        const hourStart = sameHour ? num(cur.hourStart) : now;
        const hourCount = sameHour ? num(cur.hourCount) : 0;
        const dayCount = cur.dayKey === utcDay(now) ? num(cur.dayCount) : 0;
        if (hourCount >= LIMITS.codesPerTokenHour) return { gate: 'cap', retryAfterMs: hourStart + HOUR - now };
        if (dayCount >= LIMITS.codesPerTokenDay) return { gate: 'cap', retryAfterMs: nextUtcDay(now) - now };
        const total = g.exists ? num((g.data() || {}).count) : 0;
        if (total >= LIMITS.codesPerDay) return { gate: 'global' };
        const code = newCode(random);
        tx.set(otpRef, {
            status: 'active', hash: codeProof(secret, token, now, code), issuedAt: now, expiresAt: now + OTP_TTL_MS, attemptsLeft: OTP_ATTEMPTS,
            lastSentAt: now, hourStart, hourCount: hourCount + 1, dayKey: utcDay(now), dayCount: dayCount + 1, phoneHash: to.phoneHash, toMasked: to.masked,
        });
        tx.set(dayRef, { count: total + 1, day: utcDay(now), expiresAt: nextUtcDay(now) });
        return { gate: 'ok', code };
    });
    if (slot.gate === 'cooldown') { await pad(MIN_ANSWER_MS); return accepted(); }
    if (slot.gate === 'cap') return tooMany(slot.retryAfterMs, MSG.CODES_CAPPED);
    if (slot.gate === 'global') { console.warn('[WF-PORTAL] daily code cap reached'); return result(503, { ok: false, error: MSG.UNAVAILABLE }); }

    // The answer is the same whether or not a text goes out, so it does not have to wait for the gateway: where the platform can keep the
    // invocation alive after the response (`defer`) the text is sent then, and the person is not held for the gateway's own round trip.
    const deliver = async () => {
        let sent;
        try { sent = await client.send({ to: to.e164, message: otpMessage(slot.code, OTP_TTL_MS / 60000) }); }
        catch (_) { sent = { ok: false, kind: KIND.UNKNOWN, possiblySent: true, message: 'the gateway call threw' }; }

        if (sent && sent.ok) {
            await mirrorOtp(db, s(tenant.uid), { ok: true, masked: to.masked, at: now });
        } else {
            // A code that certainly never left is dead, so it cannot be guessed at; one that may have left stays valid, because it may be in the tenant's hand.
            if (!(sent && sent.possiblySent)) {
                try {
                    await db.runTransaction(async (tx) => {
                        const o = await tx.get(otpRef);
                        if (o.exists && num((o.data() || {}).issuedAt) === now) tx.set(otpRef, { status: 'failed', hash: '', attemptsLeft: 0 }, { merge: true });
                    });
                } catch (_) { /* the code dies by itself in 3 minutes */ }
            }
            console.warn('[WF-PORTAL] code not sent:', s(sent && sent.kind));
            await mirrorOtp(db, s(tenant.uid), { ok: false, masked: to.masked, kind: sent && sent.kind, message: sent && sent.message, at: now });
        }
    };
    if (defer) defer(deliver().catch((e) => console.warn('[WF-PORTAL] delivery failed:', s(e && e.message).slice(0, 120))));
    else await deliver();
    await pad(MIN_ANSWER_MS);
    return accepted();
}

/* ── checking the code ────────────────────────────────────────────────────── */

/**
 * @returns {Promise<{status:number, body:object, cookie?:string}>}
 */
export async function verifyCode({ db, token, nic, code, ip, secret, now, randomBytes = crypto.randomBytes, defer = null }) {
    if (!TOKEN_RE.test(s(token))) return result(400, { ok: false, error: MSG.BAD_LINK });
    const candidates = identityCandidates(nic);
    if (!candidates.length) return result(400, { ok: false, error: MSG.BAD_NIC });
    if (!/^\d{6}$/.test(s(code))) return result(400, { ok: false, error: MSG.BAD_CODE });

    const gate = await hit(db, `vf-${ip}`, LIMITS.verifiesPerIpHour, HOUR, now);
    if (!gate.ok) return tooMany(gate.retryAfterMs);

    const tenantRef = db.collection(TENANTS).doc(token);
    const otpRef = tenantRef.collection('otp').doc('current');

    const out = await db.runTransaction(async (tx) => {
        const t = await tx.get(tenantRef);
        const o = await tx.get(otpRef);
        const tenant = t.exists ? (t.data() || {}) : null;
        if (!tenant || tenant.active === false) return { kind: 'denied' };
        if (num(tenant.lockedUntil) > now) return { kind: 'locked', retryAfterMs: num(tenant.lockedUntil) - now };

        const otp = o.exists ? (o.data() || {}) : {};
        const live = otp.status === 'active' && s(otp.hash).length > 0 && now < num(otp.expiresAt) && num(otp.attemptsLeft) > 0;
        // both are always computed: a wrong NIC and a wrong code cost the same, and say the same
        const nicOk = matchIdentity(candidates, s(tenant.nicHash), secret) !== '';
        const codeOk = safeEqual(codeProof(secret, token, num(otp.issuedAt), s(code)), live ? s(otp.hash) : DUMMY);

        if (nicOk && codeOk && live) {
            const sid = randomBytes(24).toString('base64url');
            const expiresAt = now + SESSION_TTL_MS;
            tx.set(otpRef, { status: 'used', hash: '', usedAt: now }, { merge: true });
            tx.set(tenantRef.collection('sessions').doc(sessionHash(sid)), { createdAt: now, expiresAt, phoneHash: s(otp.phoneHash) });
            tx.set(tenantRef, { fails: 0, failStart: 0, lockCount: 0, lockedUntil: 0, lastLoginAt: now }, { merge: true });
            return { kind: 'ok', sid, expiresAt, tenant, phoneHash: s(otp.phoneHash) };
        }

        const f = failState(tenant, now);
        tx.set(tenantRef, f, { merge: true });
        if (live) {
            const left = num(otp.attemptsLeft) - 1;
            tx.set(otpRef, left <= 0 || f.lockedUntil > now ? { status: 'spent', hash: '', attemptsLeft: 0 } : { attemptsLeft: left }, { merge: true });
        }
        return f.lockedUntil > now ? { kind: 'locked', retryAfterMs: f.lockedUntil - now } : { kind: 'denied' };
    });

    if (out.kind === 'locked') return tooMany(out.retryAfterMs);
    if (out.kind !== 'ok') return denied();

    // housekeeping: expired sessions of this link. A failure here is no reason to refuse a tenant who has just proved who they are,
    // and nobody waits for it: it runs after the answer where the platform allows that.
    const sweep = (async () => {
        try {
            const old = await tenantRef.collection('sessions').where('expiresAt', '<', now).limit(10).get();
            await Promise.all(old.docs.map((d) => d.ref.delete()));
        } catch (_) { /* swept next time */ }
    })();
    if (defer) defer(sweep); else await sweep;

    // `ctx` is for the server only (the endpoint reads the statement with it so the page needs no second trip); it is never part of the body
    return { ...result(200, { ok: true, expiresAt: out.expiresAt, expiresInSec: SESSION_TTL_MS / 1000 }, { cookie: sessionCookie(token, out.sid) }), ctx: { token, sid: out.sid, tenant: out.tenant, session: { phoneHash: out.phoneHash, expiresAt: out.expiresAt } } };
}

/* ── the session, and what it may read ────────────────────────────────────── */

/** The live session a cookie names, or null. Everything that is not a live session is the same null. */
export async function readSession({ db, cookieHeader, now }) {
    const m = SESSION_RE.exec(s(parseCookies(cookieHeader)[COOKIE]));
    if (!m) return null;
    const [, token, sid] = m;
    const tenantRef = db.collection(TENANTS).doc(token);
    const [t, sess] = await Promise.all([
        withDeadline(tenantRef.get(), 8000, 'tenant'),
        withDeadline(tenantRef.collection('sessions').doc(sessionHash(sid)).get(), 8000, 'session'),
    ]);
    if (!t.exists || !sess.exists) return null;
    const tenant = t.data() || {};
    const session = sess.data() || {};
    if (tenant.active === false || !tenant.uid || !(num(session.expiresAt) > now)) return null;
    return { token, sid, tenant, session };
}

/** The lender's own document, and the other lenders' that hold records for this NIC. */
export async function loadStatement({ db, live, secret, now }) {
    const { tenant, session } = live;
    const read = async (uid) => {
        const snap = await withDeadline(db.collection('users').doc(s(uid)).get(), 8000, 'users');
        return snap.exists ? (snap.data() || {}) : {};
    };
    // the lender's own document and the list of other lenders for this NIC are independent reads: asked together
    // Other lenders who texted this NIC. Their records are only shown for the phone this session's code went to.
    const lookOthers = async () => {
        if (!session.phoneHash) return [];
        try {
            const subs = await withDeadline(db.collection(SUBJECTS).where('nicHash', '==', s(tenant.nicHash)).limit(MAX_OTHER_LENDERS + 1).get(), 8000, 'subjects');
            const others = subs.docs.map((d) => d.data() || {}).filter((d) => d.uid && d.uid !== tenant.uid && d.nicHash === tenant.nicHash).slice(0, MAX_OTHER_LENDERS);
            const users = await Promise.all(others.map((d) => read(d.uid).catch(() => null)));
            return others.map((d, i) => (users[i] ? { uid: s(d.uid), user: users[i], own: false } : null)).filter(Boolean);
        } catch (e) { console.warn('[WF-PORTAL] other lenders unreadable:', s(e && e.message).slice(0, 120)); return []; }
    };
    const [own, others] = await Promise.all([read(tenant.uid), lookOthers()]);
    const ledgers = [{ uid: s(tenant.uid), user: own, own: true }, ...others];
    return buildStatement({ ledgers, nicHash: s(tenant.nicHash), phoneHash: s(session.phoneHash), secret, now });
}

export async function endSession({ db, live }) {
    try { await db.collection(TENANTS).doc(live.token).collection('sessions').doc(sessionHash(live.sid)).delete(); } catch (_) { /* it expires by itself */ }
}

export default { requestCode, verifyCode, readSession, loadStatement, endSession, newCode, codeProof, safeEqual, pickRecipient, failState, hit, LIMITS, LOCK, MSG };
