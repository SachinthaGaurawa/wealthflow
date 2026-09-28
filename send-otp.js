import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { getAdminDb } from './admin-db.mjs';
import { identify } from './gmail-link.mjs';
import {
    OTP_TTL_MS, authenticateAccount, canonicalEmail, calendarDateFor,
    otpSecret, recoveryProof,
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
        if (body.email && canonicalEmail(body.email) !== account.email) {
            return res.status(403).json({ error: 'Recovery email must match the authenticated account' });
        }

        const secret = otpSecret();
        const otp = crypto.randomInt(100000, 1000000).toString();
        const expiresAt = Date.now() + OTP_TTL_MS;
        const issuedOn = calendarDateFor(expiresAt - OTP_TTL_MS);
        const hash = recoveryProof({
            uid: account.uid, email: account.email, otp, expiresAt, issuedOn,
        }, secret);

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 465,
            secure: true,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });

        await transporter.sendMail({
            from: `"WealthFlow Security" <${process.env.SMTP_USER || 'noreply@wealthflow.com'}>`,
            to: account.email,
            subject: 'WealthFlow - Your 6-Digit Verification Code',
            html: `
                <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:20px">
                    <h2 style="color:#1a73e8">WealthFlow</h2>
                    <p>You requested to reset your WealthFlow passcode.</p>
                    <p style="font-size:32px;font-weight:bold;letter-spacing:5px;color:#1a73e8">${otp}</p>
                    <p>This code expires in 10 minutes.</p>
                    <p style="font-size:12px;color:#777">If you did not request this, secure your account.</p>
                </div>`,
        });

        return res.status(200).json({
            success: true,
            message: 'OTP sent successfully',
            hash,
            expiresAt,
        });
    } catch (error) {
        console.error('[OTP Error]:', error && error.message);
        const status = error && error.status === 503 ? 503 : 500;
        return res.status(status).json({ error: status === 503 ? 'OTP recovery is not configured' : 'Failed to send OTP' });
    }
}
