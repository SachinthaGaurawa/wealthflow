import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import feedbackHandler, { feedbackSender } from '../feedback.js';
import { otpSender } from '../send-otp.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;

afterEach(() => {
    process.env = { ...savedEnv };
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
});

describe('Vercel legacy-host redirects', () => {
    it('permanently redirects both former Vercel hosts straight to the official path', () => {
        const redirects = VERCEL.redirects || [];
        for (const host of ['wealthflow-personal.vercel.app', 'wealthflow-peach.vercel.app']) {
            expect(redirects).toContainEqual({
                source: '/:path*',
                has: [{ type: 'host', value: host }],
                destination: 'https://www.wealthflow.lk/:path*',
                permanent: true,
            });
        }
    });

    it('keeps redirects distinct from the SPA rewrite and does not redirect the official host', () => {
        expect(VERCEL.rewrites).toContainEqual({ source: '/(.*)', destination: '/index.html' });
        expect(VERCEL.redirects || []).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ has: [expect.objectContaining({ value: 'www.wealthflow.lk' })] }),
        ]));
    });
});

describe('the official customer email identity', () => {
    it('does not let obsolete provider or SMTP defaults become the visible sender', () => {
        expect(feedbackSender({})).toBe('WealthFlow <info@wealthflow.lk>');
        expect(feedbackSender({ FEEDBACK_EMAIL_FROM: 'WealthFlow <onboarding@resend.dev>' }))
            .toBe('WealthFlow <info@wealthflow.lk>');
        expect(otpSender({})).toBe('WealthFlow Security <info@wealthflow.lk>');
        expect(otpSender({ SMTP_USER: 'noreply@wealthflow.com' }))
            .toBe('WealthFlow Security <info@wealthflow.lk>');
    });

    it('sends feedback with the official From and Reply-To identities', async () => {
        process.env.RESEND_API_KEY = 'test-key';
        process.env.FEEDBACK_EMAIL_TO = 'private-owner@example.test';
        process.env.FEEDBACK_EMAIL_FROM = 'WealthFlow <onboarding@resend.dev>';
        let sent;
        globalThis.fetch = vi.fn(async (_url, init) => {
            sent = JSON.parse(init.body);
            return new Response('{}', { status: 200 });
        });

        const response = await feedbackHandler(new Request('https://www.wealthflow.lk/api/feedback', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'bug', text: 'Something broke' }),
        }));

        expect(response.status).toBe(200);
        expect(sent.from).toBe('WealthFlow <info@wealthflow.lk>');
        expect(sent.reply_to).toBe('info@wealthflow.lk');
        expect(sent.to).toEqual(['private-owner@example.test']);
    });

    it('removes obsolete customer identities without rewriting bank or user addresses', () => {
        const feedback = fs.readFileSync(path.join(ROOT, 'feedback.js'), 'utf8');
        const otp = fs.readFileSync(path.join(ROOT, 'send-otp.js'), 'utf8');
        expect(feedback).not.toContain('onboarding@resend.dev');
        expect(otp).not.toContain('noreply@wealthflow.com');
        expect(HTML).not.toContain('owner@wealthflow.app');
        expect(HTML).toContain('info@wealthflow.lk');
        expect(HTML).toContain('statements@hnb.lk');
    });
});
