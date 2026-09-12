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
        expect(res.code).toBe(422);
        expect(res.body.mode).toBe('needs_review');
        expect(res.body.reason).toBe('insufficient_or_invalid_roster');
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
    it('requires ten members for explicit financial intent regardless of prose wording', async () => {
        vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => url.includes('googleapis')
            ? { candidates: [{ content: { parts: [{ text: '{"approved":true}' }] } }] }
            : { choices: [{ message: { content: '{"approved":true}' } }] } })));
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'Decide the destination', financialDecision: true, mode: 'fastest' } }, res);
        expect(res.code).toBe(422); expect(res.body.reply).toBeNull(); expect(res.body.minimumProviders).toBe(10);
    });
    it('accepts only the entire ten-provider board and recognizes return JSON wording', async () => {
        for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'SAMBANOVA_API_KEY']) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => url.includes('googleapis')
            ? { candidates: [{ content: { parts: [{ text: '{"approved":true}' }] } }] }
            : { choices: [{ message: { content: '{"approved":true}' } }] } })));
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'Return JSON with a decision', mode: 'fastest' } }, res);
        expect(res.code).toBe(200); expect(res.body.expected).toHaveLength(10);
        expect(res.body.unanimous).toBe(true); expect(res.body.financialDecision).toBe(true);
        expect(fetch).toHaveBeenCalledTimes(10);
    });
    it('does not call failing prose engines a second time after quorum exhaustion', async () => {
        vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const res = response(); await handler({ method: 'POST', body: { prompt: 'Hello' } }, res);
        expect(res.code).toBe(503); expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('keeps a failed tenth configured member in the required board', async () => {
        for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'SAMBANOVA_API_KEY']) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', vi.fn(async url => {
            if (url.includes('sambanova')) throw new Error('offline');
            return { ok: true, json: async () => url.includes('googleapis')
                ? { candidates: [{ content: { parts: [{ text: '{"approved":true}' }] } }] }
                : { choices: [{ message: { content: '{"approved":true}' } }] } };
        }));
        const res = response(); await handler(request, res);
        expect(res.code).toBe(422); expect(res.body.expected).toHaveLength(10);
        expect(res.body.failed).toEqual(['SambaNova']); expect(res.body.reason).toBe('provider_unavailable');
        expect(res.body.reply).toBeNull(); expect(res.body.trustworthy).toBe(false);
    });
});
