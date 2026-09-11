import { normalizeEmail, otpIdentity, otpSecret, verifyOtpProof } from './otp-auth.mjs';

export default async function handler(req, res) {
    // CORS configuration
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { email, otp, hash, expiresAt } = (req && req.body && typeof req.body === 'object') ? req.body : {};
    
    if (!email || !otp || !hash || !expiresAt) {
        return res.status(400).json({ error: 'Missing required fields (email, otp, hash, expiresAt)' });
    }

    try {
        const who = await otpIdentity(req);
        if (!who.ok) return res.status(who.status).json({ error: 'Authenticated account required' });
        if (who.email !== normalizeEmail(email)) return res.status(403).json({ error: 'Recovery email does not match the authenticated account' });
        const secret = otpSecret();
        if (!secret) return res.status(503).json({ error: 'OTP recovery is not configured' });
        if (verifyOtpProof({ email, otp, hash, expiresAt }, secret)) {
            return res.status(200).json({ success: true, message: 'OTP verified successfully' });
        } else {
            return res.status(400).json({ error: 'Invalid or expired OTP code' });
        }
    } catch (_) {
        console.error('[Verify OTP Error]: verification failed');
        return res.status(500).json({ error: 'Internal server error during verification' });
    }
}
