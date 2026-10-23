/* =============================================================================
 * sms-owner-otp.mjs — "Alerts to my own number" only go to a number its owner has proved they hold
 * -----------------------------------------------------------------------------
 * WHY. The owner's own-number alerts (sms-owner.mjs) were sent to whatever number was typed into the panel. A typo texted a stranger, and a number that
 * was not the owner's at all (typed on purpose or by mistake) received money amounts and due dates from the WealthFlow sender with no way to refuse them.
 * Owner, 2026-10-23: a number is added only after a one-time code sent to it has been entered.
 *
 * THE RULE. The server texts a 6-digit code to the number that is being added. Only when that code is entered correctly does the server record the number as
 * VERIFIED, on the sealed account document `wf-sms/{uid}` (`ownerVerified: { phone, at }`), which no browser can write. sms-engine.mjs hands that value
 * to sms-owner.mjs, which sends alerts only to a number that equals it. Whatever the page puts in `settings.owner_sms` (the switch and the number, which sync
 * between devices) is a request; the verified record is the permission.
 *
 * THE CODE.
 *   - 6 digits from crypto.randomInt (not Math.random); kept only as HMAC-SHA256(OTP_SECRET, uid \0 number \0 code), so a read of the database does not reveal it
 *     and a code for one account or number is worthless for another. Compared in constant time.
 *   - valid 10 minutes; 5 wrong tries then the code is dead (ask for a new one); one text at least 45 s after the last; at most 5 texts in 24 h per account.
 *     Each text costs SMS credit, so the limits are also the cost cap.
 *   - sending is reserved in a transaction BEFORE the gateway is called, so two taps at once send one text. A refusal from the gateway gives the reservation back
 *     (the owner is not locked out by a failure that was not theirs); a timeout that may have been delivered keeps it.
 *   - already verified: asking again for the same number sends nothing and costs nothing.
 *   - Sri Lankan mobile numbers only (wealthflow-phone.js), the same rule as every other recipient.
 *
 * Needs OTP_SECRET (>= 32 bytes, the same variable the recovery codes use), a configured Text.lk token, and an account allowed to use SMS (sms-access.mjs).
 * Nothing here logs a code or a full number.
 * ===========================================================================*/

import crypto from 'node:crypto';
import { normalizePhone, maskPhone } from './wealthflow-phone.js';
import { otpSecret } from './otp-recovery.mjs';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const RESEND_GAP_MS = 45 * 1000;
export const MAX_TRIES = 5;
export const MAX_SENDS_PER_DAY = 5;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const CODE_LENGTH = 6;

const s = (v) => String(v == null ? '' : v);

/** A fresh code: six digits, uniformly drawn, with leading zeros kept. */
export function newCode(randomInt = crypto.randomInt) {
    return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/** What is stored instead of the code. Bound to the account and the number. */
export function codeHash(secret, uid, e164, code) {
    return crypto.createHmac('sha256', secret).update([s(uid), s(e164), s(code)].join('\0'), 'utf8').digest('hex');
}

/** The wording of the text. Short enough for one part. */
export const otpMessage = (code) => `WealthFlow: your verification code is ${code}. It is valid for 10 minutes. Do not share it with anyone.`;

const sameHash = (a, b) => {
    const x = Buffer.from(s(a), 'hex'); const y = Buffer.from(s(b), 'hex');
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** The number the server has recorded as proved, or ''. */
export const verifiedPhoneOf = (root) => {
    const v = root && root.ownerVerified;
    return v && typeof v === 'object' && /^\+947\d{8}$/.test(s(v.phone)) ? s(v.phone) : '';
};

const rootRefOf = (db, uid) => db.collection('wf-sms').doc(uid);
const statusRefOf = (db, uid) => db.collection('users').doc(uid).collection('smsLog').doc('_status');

const fail = (status, reason, extra = {}) => ({ ok: false, status, reason, ...extra });

/** What the page is told when the gateway refused the code's text. Nothing from the gateway is passed through. */
const SEND_WORDS = {
    config: 'The text service is not set up on this deployment yet.',
    credit: 'The text service has no credit left, so the code could not be sent.',
    auth: 'The text service did not accept its sign-in, so the code could not be sent.',
    destination: 'The text service cannot send to this number.',
    blocked: 'This number cannot receive texts (opted out or blocked).',
    'invalid-recipient': 'This is not a number the text service can reach.',
};

/**
 * Text a code to `phone` (the number being added).
 * @returns {{ok:true, sentTo:string, expiresAt:number, resendAfterMs:number, alreadyVerified?:boolean} | {ok:false, status:number, reason:string}}
 */
export async function sendOwnerCode({ db, uid, phone, client, env = process.env, now = Date.now(), randomInt = crypto.randomInt }) {
    const p = normalizePhone(s(phone));
    if (!p.ok) return fail(400, 'invalid-phone', { message: 'Type a Sri Lankan mobile number, for example 077 123 4567.' });
    let secret;
    try { secret = otpSecret(env); } catch (_) { return fail(503, 'not-configured', { message: 'Verification codes are not set up on this deployment yet.' }); }
    if (!client || !client.configured) return fail(503, 'not-configured', { message: SEND_WORDS.config });

    const ref = rootRefOf(db, uid);
    const code = newCode(randomInt);
    // Reserve first: the check and the new code are one transaction, so a double tap, or two devices, send one text.
    let before = null;
    const reserved = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const root = (snap.exists && snap.data()) || {};
        if (verifiedPhoneOf(root) === p.e164) return { alreadyVerified: true };
        const prev = root.ownerOtp && typeof root.ownerOtp === 'object' ? root.ownerOtp : null;
        if (prev && now - Number(prev.sentAt || 0) < RESEND_GAP_MS) return { wait: RESEND_GAP_MS - (now - Number(prev.sentAt || 0)) };
        const log = (Array.isArray(root.ownerOtpLog) ? root.ownerOtpLog : []).map(Number).filter((t) => Number.isFinite(t) && now - t < DAY_MS);
        if (log.length >= MAX_SENDS_PER_DAY) return { limit: true };
        before = { ownerOtp: prev, ownerOtpLog: log };
        tx.set(ref, {
            ownerOtp: { phone: p.e164, hash: codeHash(secret, uid, p.e164, code), exp: now + OTP_TTL_MS, tries: 0, sentAt: now },
            ownerOtpLog: [...log, now],
        }, { merge: true });
        return { reserved: true };
    });
    if (reserved.alreadyVerified) return { ok: true, alreadyVerified: true, sentTo: maskPhone(p.e164), expiresAt: 0, resendAfterMs: 0 };
    if (reserved.wait) return fail(429, 'wait', { message: 'A code was just sent. Wait a moment before asking for another.', retryAfterMs: reserved.wait });
    if (reserved.limit) return fail(429, 'daily-limit', { message: 'Too many codes were requested today. Try again tomorrow.' });

    const sent = await client.send({ to: p.e164, message: otpMessage(code) });
    if (!sent || !sent.ok) {
        const maybeDelivered = !!(sent && sent.possiblySent);
        if (!maybeDelivered) {
            // The text did not go: give the reservation back, so a failure that was not the owner's does not use up a try or the minute's wait.
            try { await ref.set({ ownerOtp: before.ownerOtp || null, ownerOtpLog: before.ownerOtpLog }, { merge: true }); } catch (_) { /* the next ask is simply rate limited for 45 s */ }
        }
        console.warn(`[WF-SMS] verification code not sent kind=${s(sent && sent.kind).slice(0, 30)} maybeDelivered=${maybeDelivered}`);
        return fail(502, maybeDelivered ? 'not-confirmed' : 'send-failed', {
            message: maybeDelivered ? 'The text service did not confirm the code was sent. If it arrives, enter it; otherwise ask for a new one in a minute.'
                : (SEND_WORDS[sent && sent.kind] || 'The code could not be sent. Try again in a moment.'),
        });
    }
    return { ok: true, sentTo: maskPhone(p.e164), expiresAt: now + OTP_TTL_MS, resendAfterMs: RESEND_GAP_MS };
}

/**
 * Check a code. On success the number becomes the account's verified number.
 * @returns {{ok:true, phone:string} | {ok:false, status:number, reason:string}}
 */
export async function verifyOwnerCode({ db, uid, phone, code, env = process.env, now = Date.now() }) {
    const p = normalizePhone(s(phone));
    if (!p.ok) return fail(400, 'invalid-phone', { message: 'Type a Sri Lankan mobile number, for example 077 123 4567.' });
    const entered = s(code).replace(/\s+/g, '');
    if (!/^\d{6}$/.test(entered)) return fail(400, 'bad-format', { message: 'The code is six digits.' });
    let secret;
    try { secret = otpSecret(env); } catch (_) { return fail(503, 'not-configured', { message: 'Verification codes are not set up on this deployment yet.' }); }

    const ref = rootRefOf(db, uid);
    const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const root = (snap.exists && snap.data()) || {};
        const otp = root.ownerOtp && typeof root.ownerOtp === 'object' ? root.ownerOtp : null;
        if (!otp || otp.phone !== p.e164) return fail(400, 'no-code', { message: 'Ask for a code for this number first.' });
        if (now > Number(otp.exp || 0)) { tx.set(ref, { ownerOtp: null }, { merge: true }); return fail(400, 'expired', { message: 'This code has expired. Ask for a new one.' }); }
        if (Number(otp.tries || 0) >= MAX_TRIES) { tx.set(ref, { ownerOtp: null }, { merge: true }); return fail(429, 'too-many-tries', { message: 'Too many wrong codes. Ask for a new one.' }); }
        if (!sameHash(otp.hash, codeHash(secret, uid, p.e164, entered))) {
            const tries = Number(otp.tries || 0) + 1;
            tx.set(ref, { ownerOtp: tries >= MAX_TRIES ? null : { ...otp, tries } }, { merge: true });
            return fail(400, 'wrong-code', { message: tries >= MAX_TRIES ? 'Too many wrong codes. Ask for a new one.' : 'That code is not right.', triesLeft: Math.max(0, MAX_TRIES - tries) });
        }
        tx.set(ref, { ownerVerified: { phone: p.e164, at: now }, ownerOtp: null }, { merge: true });
        return { ok: true, phone: p.e164 };
    });
    if (out.ok) {
        // The owner-readable status card carries the verified number, so every signed-in device shows it (the sealed document is not readable from a browser).
        try { await statusRefOf(db, uid).set({ ownerVerified: out.phone, updatedAt: now }, { merge: true }); } catch (_) { /* the next sweep writes it */ }
    }
    return out;
}

export default { OTP_TTL_MS, RESEND_GAP_MS, MAX_TRIES, MAX_SENDS_PER_DAY, newCode, codeHash, otpMessage, verifiedPhoneOf, sendOwnerCode, verifyOwnerCode };
