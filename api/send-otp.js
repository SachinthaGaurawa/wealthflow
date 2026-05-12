// ==================== WealthFlow OTP Email Sender ====================
// Uses fetch-based email via Resend or SMTP relay (Vercel-compatible).
// Falls back to a simple in-memory OTP for development/testing.
//
// REQUIRED ENV VARS (set in Vercel dashboard):
//   OTP_SECRET          — HMAC secret for stateless OTP verification
//   SMTP_HOST           — SMTP relay host (e.g., smtp.gmail.com)
//   SMTP_PORT           — SMTP port (typically 465 or 587)
//   SMTP_USER           — SMTP username/email
//   SMTP_PASS           — SMTP password or app password
//   RESEND_API_KEY      — (Alternative) Resend.com API key
// =====================================================================

import crypto from 'crypto';

export const config = {
    maxDuration: 15
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

    const { email } = req.body;
    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    try {
        // Generate a 6-digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Create a secure hash of the OTP + email to return to the client
        // This allows stateless verification on the frontend without a DB
        const secret = process.env.OTP_SECRET;
        if (!secret) {
            console.error('[OTP] OTP_SECRET environment variable is not set');
            return res.status(503).json({
                error: 'OTP service not configured. Set OTP_SECRET in Vercel environment variables.',
                configured: false
            });
        }

        const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry
        const dataToHash = `${email}:${otp}:${expiresAt}:${secret}`;
        const hash = crypto.createHash('sha256').update(dataToHash).digest('hex');

        // Build the email HTML
        const emailHTML = `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px; background-color: #f9f9f9;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h2 style="color: #1a73e8; margin: 0;">WealthFlow</h2>
                </div>
                <div style="background-color: #ffffff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05);">
                    <p style="font-size: 16px; color: #333;">Hello,</p>
                    <p style="font-size: 16px; color: #333;">You requested to reset your WealthFlow passcode. Here is your 6-digit verification code:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <span style="display: inline-block; font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #1a73e8; background-color: #f0f4f8; padding: 15px 30px; border-radius: 8px;">${otp}</span>
                    </div>
                    <p style="font-size: 14px; color: #666; text-align: center;">This code will expire in 10 minutes.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 12px; color: #999; text-align: center;">If you did not request this, please ignore this email or secure your account.</p>
                </div>
            </div>
        `;

        let emailSent = false;

        // Strategy 1: Resend.com API (recommended for Vercel — no SMTP needed)
        if (process.env.RESEND_API_KEY) {
            try {
                const resendResp = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`
                    },
                    body: JSON.stringify({
                        from: process.env.RESEND_FROM || 'WealthFlow <noreply@wealthflow.com>',
                        to: [email],
                        subject: 'WealthFlow - Your 6-Digit Verification Code',
                        html: emailHTML
                    })
                });
                if (resendResp.ok) {
                    emailSent = true;
                    console.log('[OTP] ✅ Email sent via Resend');
                } else {
                    const errData = await resendResp.json().catch(() => ({}));
                    console.warn('[OTP] Resend failed:', resendResp.status, errData);
                }
            } catch (e) {
                console.warn('[OTP] Resend error:', e.message);
            }
        }

        // Strategy 2: SMTP via nodemailer (if available in the deployment)
        if (!emailSent && process.env.SMTP_USER && process.env.SMTP_PASS) {
            try {
                // Dynamic import — only loads if nodemailer is installed
                const nodemailer = await import('nodemailer').then(m => m.default || m);
                const transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST || 'smtp.gmail.com',
                    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 465,
                    secure: true,
                    auth: {
                        user: process.env.SMTP_USER,
                        pass: process.env.SMTP_PASS
                    }
                });
                await transporter.sendMail({
                    from: `"WealthFlow Security" <${process.env.SMTP_USER}>`,
                    to: email,
                    subject: 'WealthFlow - Your 6-Digit Verification Code',
                    html: emailHTML
                });
                emailSent = true;
                console.log('[OTP] ✅ Email sent via SMTP');
            } catch (e) {
                console.warn('[OTP] SMTP failed:', e.message);
            }
        }

        if (!emailSent) {
            console.warn('[OTP] No email provider available — returning hash for client-side validation');
            // Still return the hash so the OTP flow works (user must know the OTP from logs/testing)
        }

        return res.status(200).json({
            success: true,
            message: emailSent ? 'OTP sent successfully' : 'OTP generated (email delivery requires RESEND_API_KEY or SMTP credentials)',
            hash: hash,
            expiresAt: expiresAt,
            emailSent: emailSent
        });

    } catch (error) {
        console.error('[OTP Error]:', error);
        return res.status(500).json({
            error: 'Failed to process OTP request',
            details: error.message
        });
    }
}
