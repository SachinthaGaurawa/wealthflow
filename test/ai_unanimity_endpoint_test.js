import { afterEach, describe, it, expect, vi } from 'vitest';
import handler, { coolProvider, providerAvailable, resetProviderCooldowns } from '../api/ai.js';

afterEach(() => { resetProviderCooldowns(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const request = { method: 'POST', body: { prompt: 'Return only JSON for this financial transaction', mode: 'fastest' } };

describe('parallel unanimous endpoint', () => {
    it('temporarily removes credit-less and timed-out providers without retaining financial data', () => {
        coolProvider('Anthropic', new Error('credit balance is too low'), 1000);
        coolProvider('Cohere', new Error('Provider response deadline exceeded'), 1000);
        expect(providerAvailable('Anthropic', 1000 + 60 * 60 * 1000)).toBe(false);
        expect(providerAvailable('Cohere', 1000 + 59 * 1000)).toBe(false);
        expect(providerAvailable('Cohere', 1000 + 61 * 1000)).toBe(true);
        expect(providerAvailable('Gemini', 1000)).toBe(true);
        expect(providerAvailable('DeepSeek', 1000)).toBe(true);
    });
    it('waits for late prose dissent instead of returning the first or third arrival', async () => {
        vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
        const releases = [];
        vi.stubGlobal('fetch', vi.fn(url => new Promise(resolve => releases.push(() => resolve({ ok: true, json: async () => url.includes('googleapis')
            ? { candidates: [{ content: { parts: [{ text: 'Use the verified collective answer.' }] } }] }
            : { choices: [{ message: { content: 'Use the verified collective answer.' } }] } })))));
        const res = response();
        const pending = handler({ method: 'POST', body: { prompt: 'Give advisory guidance', mode: 'fastest' } }, res);
        await vi.waitFor(() => expect(releases.length).toBe(2));
        releases[0](); await Promise.resolve();
        expect(res.body).toBeUndefined();
        releases[1](); await pending;
        expect(res.code).toBe(200);
        expect(res.body.mode).toBe('collective');
        expect(res.body.answered).toEqual(['Gemini', 'Groq']);
        expect(res.body.requestedMode).toBe('fastest');
    });

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
    it('requires five members for explicit financial intent regardless of prose wording', async () => {
        vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => url.includes('googleapis')
            ? { candidates: [{ content: { parts: [{ text: '{"approved":true}' }] } }] }
            : { choices: [{ message: { content: '{"approved":true}' } }] } })));
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'Decide the destination', financialDecision: true, mode: 'fastest' } }, res);
        expect(res.code).toBe(422); expect(res.body.reply).toBeNull(); expect(res.body.minimumProviders).toBe(5);
    });
    it('fans one OpenRouter key out to three fixed free model families while preserving the five-answer floor', async () => {
        for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY']) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => url.includes('googleapis')
            ? { candidates: [{ content: { parts: [{ text: '{"approved":true}' }] } }] }
            : { choices: [{ message: { content: '{"approved":true}' } }] } })));
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'Return JSON with a decision', mode: 'fastest' } }, res);
        expect(res.code).toBe(200); expect(res.body.expected).toHaveLength(10);
        expect(res.body.unanimous).toBe(true); expect(res.body.financialDecision).toBe(true);
        expect(res.body.expected).toEqual(expect.arrayContaining(['Gemini', 'DeepSeek', 'OpenRouterFinance', 'OpenRouterQwen', 'OpenRouterNemotron']));
        expect(fetch).toHaveBeenCalledTimes(10);
    });
    it('uses the configured OpenRouter multimodal model on vision requests without the removed legacy function', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"approved":true}' } }] }) })));
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'Extract this statement as JSON', image: 'aW1hZ2U=', financialDecision: true } }, res);
        expect(res.code).toBe(422);
        expect(res.body.answered).toEqual(['OpenRouterQwen']);
        expect(res.body.failed).toEqual([]);
        expect(fetch).toHaveBeenCalledTimes(1);
    });
    it('adds Cloudflare Workers AI as a text and vision-capable independent provider when both credentials exist', async () => {
        vi.stubEnv('CLOUDFLARE_AI_API_TOKEN', 'test');
        vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'account');
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"approved":true}' } }] }) })));
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'Extract this statement as JSON', image: 'aW1hZ2U=', financialDecision: true } }, res);
        expect(res.code).toBe(422);
        expect(res.body.answered).toEqual(['CloudflareAI']);
        expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/accounts/account/ai/v1/chat/completions'), expect.any(Object));
    });
    it('does not call failing prose engines a second time after quorum exhaustion', async () => {
        vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const res = response(); await handler({ method: 'POST', body: { prompt: 'Hello' } }, res);
        expect(res.code).toBe(503); expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('lets the free OpenRouter reserve models replace a failed configured member', async () => {
        for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY']) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', vi.fn(async url => {
            if (url.includes('nvidia')) throw new Error('offline');
            return { ok: true, json: async () => url.includes('googleapis')
                ? { candidates: [{ content: { parts: [{ text: '{"approved":true}' }] } }] }
                : { choices: [{ message: { content: '{"approved":true}' } }] } };
        }));
        const res = response(); await handler(request, res);
        expect(res.code).toBe(200); expect(res.body.expected).toHaveLength(10);
        expect(res.body.failed).toEqual(['NVIDIA']); expect(res.body.unanimous).toBe(true);
        expect(res.body.answered).toHaveLength(9); expect(res.body.trustworthy).toBe(true);
    });
    it('replaces one unavailable engine with an agreeing spare instead of failing the financial decision', async () => {
        for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'GITHUB_MODELS_TOKEN']) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', vi.fn(async url => {
            if (url.includes('nvidia')) throw new Error('offline');
            return { ok: true, json: async () => url.includes('googleapis')
                ? { candidates: [{ content: { parts: [{ text: '{"approved":true}' }] } }] }
                : { choices: [{ message: { content: '{"approved":true}' } }] } };
        }));
        const res = response(); await handler(request, res);
        expect(res.code).toBe(200); expect(res.body.unanimous).toBe(true);
        expect(res.body.failed).toEqual(['NVIDIA']);
        expect(res.body.answered).toHaveLength(10);
        expect(res.body.corroboration).toMatchObject({ agreed: 10, of: 11 });
    });

    describe('advice is not a financial decision', () => {
        // The chat engine's system prompt describes a chart format "with JSON" and names categories.
        const chatPrompt = 'You are WealthFlow AI. Charts: fenced ```chart blocks with JSON {"type":"bar"}. Spending category totals follow.\n\n--- CONVERSATION ---\nUser: how is my month?\n\n[REPLY NOW — in English only, as their warm caring best friend.]\nAI:';
        const twoEngines = () => {
            vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
            vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => url.includes('googleapis')
                ? { candidates: [{ content: { parts: [{ text: 'You kept 40% of your income. Keep it up!' }] } }] }
                : { choices: [{ message: { content: 'Your savings rate is healthy this month.' } }] } })));
        };
        it('answers an insight request that declares itself advice, although its wording mentions JSON and categories', async () => {
            twoEngines();
            const res = response();
            await handler({ method: 'POST', body: { prompt: chatPrompt, task: 'advice' } }, res);
            expect(res.code).toBe(200);
            expect(res.body.financialDecision).toBe(false); expect(res.body.advisoryOnly).toBe(true);
            expect(typeof res.body.reply).toBe('string'); expect(res.body.reply.length).toBeGreaterThan(10);
            expect(res.body.answered).toEqual(['Gemini', 'Groq']);
        });
        it('does the same for a client that predates the flag, by recognising the chat engine\'s own envelope', async () => {
            twoEngines();
            const res = response();
            await handler({ method: 'POST', body: { prompt: chatPrompt } }, res);
            expect(res.code).toBe(200); expect(res.body.financialDecision).toBe(false);
        });
        it('still holds a financial decision to the board, whatever else the request says', async () => {
            twoEngines();
            for (const body of [
                { prompt: chatPrompt, task: 'advice', financialDecision: true },
                { prompt: 'Return JSON for this transaction: category?' },
                { prompt: 'Categorize this merchant', task: 'categorization' },
                { prompt: 'Extract this statement as JSON', image: 'aW1hZ2U=' },
            ]) {
                const res = response();
                await handler({ method: 'POST', body }, res);
                expect(res.code, JSON.stringify(body).slice(0, 60)).toBe(422);
                expect(res.body.reply).toBeNull();
            }
        });
        it('an image attached to a chat prompt is never mistaken for the chat envelope', async () => {
            twoEngines();
            const res = response();
            await handler({ method: 'POST', body: { prompt: chatPrompt, image: 'aW1hZ2U=' } }, res);
            expect(res.code).toBe(422);
        });
        it('the chat engine declares advice itself, and only when no financial document is attached', async () => {
            const html = (await import('node:fs')).readFileSync(new URL('../index.html', import.meta.url), 'utf8');
            const call = html.slice(html.indexOf('async function callAI('), html.indexOf('function _wfSelectedLangName'));
            expect(call).toContain("body.task = 'advice'");
            expect(call).toContain("!image || window._wfLastIntent === 'image_analyze'");
        });
    });
});
