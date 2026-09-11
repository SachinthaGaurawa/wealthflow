import crypto from 'node:crypto';

export const OTP_TTL_MS = 10 * 60 * 1000;

export function canonicalEmail(value) {
    return String(value || '').trim().toLowerCase();
}

export function strictTimestamp(value) {
    const raw = typeof value === 'number' ? String(value) : String(value || '');
    if (!/^\d{13}$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
}

export function calendarDateFor(timestamp) {
    const n = strictTimestamp(timestamp);
    return n === null ? null : new Date(n).toISOString().slice(0, 10);
}

export function isStrictCalendarDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!m) return false;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    if (year < 1970 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

export function otpSecret(env = process.env) {
    const secret = String((env && env.OTP_SECRET) || '');
    if (Buffer.byteLength(secret, 'utf8') < 32) {
        const error = new Error('OTP_SECRET must contain at least 32 bytes');
        error.status = 503;
        throw error;
    }
    return secret;
}

export function recoveryPayload({ uid, email, otp, expiresAt, issuedOn }) {
    return [String(uid || ''), canonicalEmail(email), String(otp || ''), String(expiresAt), String(issuedOn || '')].join('\0');
}

export function signRecovery(fields, secret) {
    return crypto.createHmac('sha256', secret)
        .update(recoveryPayload(fields), 'utf8')
        .digest('hex');
}

export function recoveryProof(fields, secret) {
    if (!isStrictCalendarDate(fields.issuedOn)) throw new Error('invalid recovery issue date');
    return fields.issuedOn + '.' + signRecovery(fields, secret);
}

export function verifyRecoveryProof(proof, fields, secret) {
    const m = /^(\d{4}-\d{2}-\d{2})\.([a-f0-9]{64})$/.exec(String(proof || ''));
    if (!m || !isStrictCalendarDate(m[1])) return false;
    const expectedDate = calendarDateFor(Number(fields.expiresAt) - OTP_TTL_MS);
    if (!expectedDate || m[1] !== expectedDate) return false;
    const expected = Buffer.from(signRecovery({ ...fields, issuedOn: m[1] }, secret), 'hex');
    const supplied = Buffer.from(m[2], 'hex');
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export async function authenticateAccount(req, { getAdminDb, identify }) {
    const { db, reason, admin } = await getAdminDb();
    if (!db || !admin) return { ok: false, status: 503, reason: reason || 'authentication unavailable' };
    return identify(req, { verifyIdToken: (token) => admin.auth().verifyIdToken(token) });
}
