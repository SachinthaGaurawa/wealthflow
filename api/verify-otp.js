// ==================== WealthFlow OTP Verification ====================
// Stateless OTP verification using HMAC hash comparison.
// REQUIRED ENV VAR: OTP_SECRET
// =====================================================================

import crypto from 'crypto';

export const config = {
    maxDuration: 10
};

export default async function handler(req, res) {
    // CORS configuration
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { email, otp, hash, expiresAt } = req.body;

    if (!email || !otp || !hash || !expiresAt) {
        return res.status(400).json({ error: 'Missing required fields (email, otp, hash, expiresAt)' });
    }

    // Check expiration
    if (Date.now() > parseInt(expiresAt)) {
        return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    try {
        const secret = process.env.OTP_SECRET;
        if (!secret) {
            return res.status(503).json({
                error: 'OTP service not configured. Set OTP_SECRET in Vercel environment variables.',
                configured: false
            });
        }

        const dataToHash = `${email}:${otp}:${expiresAt}:${secret}`;
        const calculatedHash = crypto.createHash('sha256').update(dataToHash).digest('hex');

        // Constant-time comparison to prevent timing attacks
        const hashBuffer = Buffer.from(calculatedHash, 'hex');
        const providedBuffer = Buffer.from(hash, 'hex');

        if (hashBuffer.length === providedBuffer.length && crypto.timingSafeEqual(hashBuffer, providedBuffer)) {
            return res.status(200).json({ success: true, message: 'OTP verified successfully' });
        } else {
            return res.status(400).json({ error: 'Invalid OTP code' });
        }
    } catch (error) {
        console.error('[Verify OTP Error]:', error);
        return res.status(500).json({ error: 'Internal server error during verification' });
    }
}
