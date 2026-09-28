import { getAdminDb } from './admin-db.mjs';
import { identify } from './gmail-link.mjs';
import {
    OTP_TTL_MS, authenticateAccount, canonicalEmail, otpSecret,
    strictTimestamp, verifyRecoveryProof,
} from './otp-recovery.mjs';

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const account = await authenticateAccount(req, { getAdminDb, identify });
        if (!account.ok) return res.status(account.status || 401).json({ error: 'Authenticated account required' });

        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const { otp, hash } = body;
        const expiresAt = strictTimestamp(body.expiresAt);
        if (!/^\d{6}$/.test(String(otp || '')) || !hash || expiresAt === null) {
            return res.status(400).json({ error: 'Invalid recovery proof' });
        }
        if (body.email && canonicalEmail(body.email) !== account.email) {
            return res.status(403).json({ error: 'Recovery email must match the authenticated account' });
        }

        const now = Date.now();
        if (expiresAt <= now || expiresAt > now + OTP_TTL_MS) {
            return res.status(400).json({ error: 'OTP has expired or is invalid' });
        }

        const valid = verifyRecoveryProof(hash, {
            uid: account.uid,
            email: account.email,
            otp: String(otp),
            expiresAt,
        }, otpSecret());

        if (!valid) return res.status(400).json({ error: 'Invalid OTP code' });
        return res.status(200).json({ success: true, message: 'OTP verified successfully' });
    } catch (error) {
        console.error('[Verify OTP Error]:', error && error.message);
        const status = error && error.status === 503 ? 503 : 500;
        return res.status(status).json({ error: status === 503 ? 'OTP recovery is not configured' : 'Internal server error during verification' });
    }
}
