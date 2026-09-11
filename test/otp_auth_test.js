import { describe, expect, it } from 'vitest';
import { bearerToken, normalizeEmail, otpIdentity, otpProof, otpSecret, verifyOtpProof, OTP_TTL_MS } from '../otp-auth.mjs';

const SECRET = 'a-test-secret-that-is-at-least-32-characters';

describe('OTP recovery authentication', () => {
    it('fails closed without a strong configured secret', () => {
        expect(otpSecret({})).toBe('');
        expect(otpSecret({ OTP_SECRET: 'too-short' })).toBe('');
        expect(otpSecret({ OTP_SECRET: SECRET })).toBe(SECRET);
    });

    it('normalizes the address bound into the proof', () => {
        expect(normalizeEmail(' Owner@Example.COM ')).toBe('owner@example.com');
        expect(normalizeEmail('not-an-email')).toBe('');
    });

    it('accepts only the exact email, code, proof and live bounded expiry', () => {
        const now = 1_800_000_000_000;
        const expiresAt = now + OTP_TTL_MS;
        const hash = otpProof('owner@example.com', '123456', expiresAt, SECRET);
        const proof = { email: 'OWNER@example.com', otp: '123456', hash, expiresAt };
        expect(verifyOtpProof(proof, SECRET, now)).toBe(true);
        expect(verifyOtpProof({ ...proof, otp: '123457' }, SECRET, now)).toBe(false);
        expect(verifyOtpProof({ ...proof, email: 'attacker@example.com' }, SECRET, now)).toBe(false);
        expect(verifyOtpProof(proof, SECRET, expiresAt)).toBe(false);
        expect(verifyOtpProof({ ...proof, expiresAt: now + OTP_TTL_MS + 1 }, SECRET, now)).toBe(false);
    });

    it('rejects malformed inputs without throwing', () => {
        for (const value of [null, {}, { email: 'x' }, { email: 'a@b.co', otp: '123456', hash: 'zz', expiresAt: NaN }]) {
            expect(() => verifyOtpProof(value || {}, SECRET)).not.toThrow();
            expect(verifyOtpProof(value || {}, SECRET)).toBe(false);
        }
    });

    it('requires a strict bearer token and a verified account email', async () => {
        expect(bearerToken({ headers: { authorization: 'Bearer signed-token' } })).toBe('signed-token');
        expect(bearerToken({ headers: { authorization: 'Basic nope' } })).toBe('');
        const adminProvider = async () => ({
            admin: { auth: () => ({ verifyIdToken: async (token) => ({ uid: 'u1', email: token === 'signed-token' ? 'Owner@Example.com' : '' }) }) },
        });
        await expect(otpIdentity({ headers: {} }, adminProvider)).resolves.toEqual({ ok: false, status: 401 });
        await expect(otpIdentity({ headers: { authorization: 'Bearer signed-token' } }, adminProvider))
            .resolves.toEqual({ ok: true, status: 200, email: 'owner@example.com', uid: 'u1' });
    });

    it('fails closed when Firebase Admin is unavailable or rejects the token', async () => {
        const req = { headers: { authorization: 'Bearer bad-token' } };
        await expect(otpIdentity(req, async () => ({ admin: null }))).resolves.toEqual({ ok: false, status: 503 });
        await expect(otpIdentity(req, async () => { throw new Error('admin init failed'); })).resolves.toEqual({ ok: false, status: 503 });
        await expect(otpIdentity(req, async () => ({ admin: { auth: () => ({ verifyIdToken: async () => { throw new Error('bad'); } }) } })))
            .resolves.toEqual({ ok: false, status: 401 });
    });
});
