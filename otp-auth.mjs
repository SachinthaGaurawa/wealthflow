import { createHmac, timingSafeEqual } from 'node:crypto';
import { getAdminDb } from './admin-db.mjs';

export const OTP_TTL_MS = 10 * 60 * 1000;

export function normalizeEmail(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function otpSecret(env = process.env) {
    const secret = typeof env.OTP_SECRET === 'string' ? env.OTP_SECRET.trim() : '';
    return secret.length >= 32 ? secret : '';
}

export function otpProof(email, otp, expiresAt, secret) {
    return createHmac('sha256', secret)
        .update(`${normalizeEmail(email)}\n${otp}\n${expiresAt}`)
        .digest('hex');
}

export function verifyOtpProof({ email, otp, hash, expiresAt }, secret, now = Date.now()) {
    const normalized = normalizeEmail(email);
    const expiry = Number(expiresAt);
    if (!normalized || !/^\d{6}$/.test(String(otp || '')) || !/^[a-f\d]{64}$/i.test(String(hash || ''))) return false;
    if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + OTP_TTL_MS) return false;
    const expected = Buffer.from(otpProof(normalized, String(otp), expiry, secret), 'hex');
    const supplied = Buffer.from(String(hash), 'hex');
    return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function bearerToken(req) {
    const value = req && req.headers && (req.headers.authorization || req.headers.Authorization);
    const match = /^Bearer\s+([^\s]+)$/i.exec(typeof value === 'string' ? value.trim() : '');
    return match ? match[1] : '';
}

export async function otpIdentity(req, adminProvider = getAdminDb) {
    const token = bearerToken(req);
    if (!token) return { ok: false, status: 401 };
    let state;
    try { state = await adminProvider(); } catch (_) { return { ok: false, status: 503 }; }
    if (!state || !state.admin || typeof state.admin.auth !== 'function') return { ok: false, status: 503 };
    try {
        const decoded = await state.admin.auth().verifyIdToken(token);
        const email = normalizeEmail(decoded && decoded.email);
        return email ? { ok: true, status: 200, email, uid: decoded.uid || '' } : { ok: false, status: 403 };
    } catch (_) {
        return { ok: false, status: 401 };
    }
}
