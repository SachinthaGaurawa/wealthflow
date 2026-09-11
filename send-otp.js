import nodemailer from 'nodemailer';
import { randomInt } from 'node:crypto';
import { normalizeEmail, otpIdentity, otpProof, otpSecret, OTP_TTL_MS } from './otp-auth.mjs';

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

    const email = normalizeEmail(req && req.body && req.body.email);
    if (!email) {
        return res.status(400).json({ error: 'A valid email is required' });
    }

    const who = await otpIdentity(req);
    if (!who.ok) return res.status(who.status).json({ error: 'Authenticated account required' });
    if (who.email !== email) return res.status(403).json({ error: 'Recovery email does not match the authenticated account' });

    const secret = otpSecret();
    if (!secret) return res.status(503).json({ error: 'OTP recovery is not configured' });

    try {
        // Generate a 6-digit OTP
        const otp = randomInt(100000, 1000000).toString();

        // Create a secure hash of the OTP + email to return to the client
        // This allows stateless verification on the frontend without a DB
        const expiresAt = Date.now() + OTP_TTL_MS;
        const hash = otpProof(email, otp, expiresAt, secret);

        // Setup Nodemailer transport
        // Expects environment variables in Vercel: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 465,
            secure: true,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        const mailOptions = {
            from: `"WealthFlow Security" <${process.env.SMTP_USER || 'noreply@wealthflow.com'}>`,
            to: email,
            subject: 'WealthFlow - Your 6-Digit Verification Code',
            html: `
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
            `
        };

        // Send the email
        await transporter.sendMail(mailOptions);

        return res.status(200).json({ 
            success: true, 
            message: 'OTP sent successfully',
            hash: hash,
            expiresAt: expiresAt
        });

    } catch (error) {
        console.error('[OTP Error]: email delivery failed');
        return res.status(500).json({ error: 'Failed to send OTP. Ensure SMTP credentials are set in Vercel.' });
    }
}
