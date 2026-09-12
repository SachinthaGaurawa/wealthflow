import { afterEach, describe, it, expect, vi } from 'vitest';
import handler from '../api/ai.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const request = { method: 'POST', body: { prompt: 'Return only JSON for this financial transaction', mode: 'fastest' } };

describe('parallel unanimous endpoint', () => {
    it('starts both configured engines before either completes and cannot use fastest override', async () => {
        vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
        const releases = [];
        vi.stubGlobal('fetch', vi.fn(url => new Promise(resolve => releases.push(() => resolve({ ok: true, json: async () => url.includes('googleapis')
            ? { candidates: [{ content: { parts: [{ text: '{"category":"expenses"}' }] } }] }
            : { choices: [{ message: { content: '{"category":"expenses"}' } }] } })))));
        const res = response();
        const pending = handler(request, res);
        await vi.waitFor(() => expect(releases.length).toBe(2));
        releases[0]();
        await Promise.resolve();
        expect(res.body).toBeUndefined();
        releases[1](); await pending;
        expect(res.code).toBe(200);
        expect(res.body.mode).toBe('unanimous');
        expect(res.body.engines).toEqual(['Gemini', 'Groq']);
    });
    it('returns review without a financial reply when a configured engine fails', async () => {
        vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async url => {
            if (!url.includes('googleapis')) throw new Error('offline');
            return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"category":"expenses"}' }] } }] }) };
        }));
        const res = response(); await handler(request, res);
        expect(res.code).toBe(422); expect(res.body.reply).toBeNull();
        expect(res.body.failed).toContain('Groq'); expect(res.body.needsReview).toBe(true);
    });
});
