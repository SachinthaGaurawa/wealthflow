import { describe, it, expect, vi } from 'vitest';
import {
    OTP_TTL_MS, authenticateAccount, calendarDateFor, isStrictCalendarDate,
    recoveryProof, strictTimestamp, verifyRecoveryProof,
} from '../otp-recovery.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const issuedAt = Date.UTC(2026, 8, 11, 12, 0, 0);
const fields = {
    uid: 'uid-owner',
    email: 'owner@example.com',
    otp: '123456',
    expiresAt: issuedAt + OTP_TTL_MS,
    issuedOn: '2026-09-11',
};

describe('OTP recovery proof', () => {
    it('uses an account-bound HMAC proof', () => {
        const proof = recoveryProof(fields, SECRET);
        expect(verifyRecoveryProof(proof, fields, SECRET)).toBe(true);
        expect(verifyRecoveryProof(proof, { ...fields, uid: 'uid-attacker' }, SECRET)).toBe(false);
        expect(verifyRecoveryProof(proof, { ...fields, email: 'attacker@example.com' }, SECRET)).toBe(false);
        expect(verifyRecoveryProof(proof, { ...fields, otp: '654321' }, SECRET)).toBe(false);
    });

    it('rejects a modified or non-HMAC proof', () => {
        const proof = recoveryProof(fields, SECRET);
        expect(verifyRecoveryProof(proof.slice(0, -1) + '0', fields, SECRET)).toBe(false);
        expect(verifyRecoveryProof('2026-09-11.' + '0'.repeat(64), fields, SECRET)).toBe(false);
    });
});

describe('strict calendar and timestamp validation', () => {
    it('accepts real leap dates and rejects impossible calendar dates', () => {
        expect(isStrictCalendarDate('2024-02-29')).toBe(true);
        for (const bad of ['2023-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-9-11', '2026-09-11x']) {
            expect(isStrictCalendarDate(bad), bad).toBe(false);
        }
    });

    it('binds the proof date to its exact issue day', () => {
        const proof = recoveryProof(fields, SECRET);
        expect(calendarDateFor(issuedAt)).toBe('2026-09-11');
        expect(verifyRecoveryProof('2026-09-10.' + proof.split('.')[1], fields, SECRET)).toBe(false);
    });

    it('does not parse timestamp prefixes or unsafe values', () => {
        expect(strictTimestamp(String(fields.expiresAt))).toBe(fields.expiresAt);
        expect(strictTimestamp(String(fields.expiresAt) + 'junk')).toBe(null);
        expect(strictTimestamp('123')).toBe(null);
        expect(strictTimestamp(Number.MAX_SAFE_INTEGER + 1)).toBe(null);
    });
});

describe('authenticated account binding', () => {
    it('verifies the Firebase ID token and returns its identity', async () => {
        const verifyIdToken = vi.fn(async token => ({ uid: 'u1', email: 'owner@example.com', email_verified: true, token }));
        const identify = vi.fn(async (req, deps) => {
            const decoded = await deps.verifyIdToken('firebase-token');
            return { ok: true, uid: decoded.uid, email: decoded.email };
        });
        const result = await authenticateAccount({ headers: { authorization: 'Bearer firebase-token' } }, {
            getAdminDb: async () => ({ db: {}, reason: null, admin: { auth: () => ({ verifyIdToken }) } }),
            identify,
        });
        expect(result).toMatchObject({ ok: true, uid: 'u1', email: 'owner@example.com' });
        expect(verifyIdToken).toHaveBeenCalledWith('firebase-token');
    });

    it('fails closed when Firebase Admin is unavailable', async () => {
        const result = await authenticateAccount({}, {
            getAdminDb: async () => ({ admin: null, reason: 'not configured' }),
            identify: vi.fn(),
        });
        expect(result).toMatchObject({ ok: false, status: 503 });
    });
});

describe('the live handlers retain the security boundary', () => {
    it('has no default secret and uses cryptographic OTP generation', async () => {
        const fs = await import('node:fs');
        const send = fs.readFileSync(new URL('../send-otp.js', import.meta.url), 'utf8');
        const verify = fs.readFileSync(new URL('../verify-otp.js', import.meta.url), 'utf8');
        expect(send).toContain('crypto.randomInt(100000, 1000000)');
        expect(send).toContain('authenticateAccount(req');
        expect(verify).toContain('authenticateAccount(req');
        expect(send + verify).not.toContain('wealthflow_default_secret');
        expect(send + verify).toContain('Content-Type, Authorization');
    });
});
