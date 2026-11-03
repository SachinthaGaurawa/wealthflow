/* A provider whose model name has been retired is not lost for the whole run: its own list gives a replacement.
 *
 * WHAT HAPPENED (run 41698322633, 2026-11-03): of thirteen configured providers nine answered "this model is gone"
 * (cerebras "archived", groq "does not exist", fireworks "not deployed", nvidia "end of life", openrouter "unavailable
 * for free", huggingface "not supported"…). Every run paid for nine failures and then worked with two providers, so the
 * "independent" security reviewer and the test author had nobody to be independent of. The error texts below are the
 * real ones from that log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chat, isRetiredModelError, pickReplacement, healedModels, _resetHealedModels, describeAvailability } from '../autonomy/llm-router.mjs';

describe('isRetiredModelError — only "this model is gone" counts', () => {
    const gone = [
        [404, 'cerebras: HTTP 404 {"message":"Model qwen-3-coder-480b is archived and unavailable for the organization.","type":"model_archived_error","param":"model","code":"model_archived"}'],
        [404, 'groq: HTTP 404 {"error":{"message":"The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}'],
        [404, 'fireworks: HTTP 404 {"error":{"message":"Model not found, inaccessible, and/or not deployed","param":"model","code":"NOT_FOUND"}}'],
        [410, 'nvidia: HTTP 410 {"title":"Gone","status":410,"detail":"The model \'qwen/qwen2.5-coder-32b-instruct\' has reached its end of life on 2026-05-12T00:00:00Z and is no longer available."}'],
        [404, 'openrouter: HTTP 404 {"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: deepseek/deepseek-chat-v3.1","code":404}}'],
        [400, 'huggingface: HTTP 400 {"error":{"message":"The requested model \'Qwen/Qwen2.5-Coder-32B-Instruct\' is not supported by any provider you have enabled.","type":"invalid_request_error","param":"model","code":"model_not_supported"}}'],
    ];
    for (const [status, text] of gone) it(`yes: ${text.slice(0, 40)}…`, () => expect(isRetiredModelError(status, text)).toBe(true));

    const notGone = [
        [400, 'anthropic: HTTP 400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'],
        [403, 'xai: HTTP 403 {"code":"permission-denied","error":"Your newly created team doesn\'t have any credits or licenses yet."}'],
        [401, 'sambanova: HTTP 401 {"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}'],
        [429, 'groq: HTTP 429 rate limit reached for model llama'],
        [500, 'x: HTTP 500 model server error'],
        [402, 'gemini: HTTP 402 prepayment depleted'],
        [404, 'x: HTTP 404 page not found'],           // a wrong URL is not a retired model
    ];
    for (const [status, text] of notGone) it(`no: ${text.slice(0, 40)}…`, () => expect(isRetiredModelError(status, text)).toBe(false));
});

describe('pickReplacement', () => {
    it('prefers a large coding model, and never an embedding, speech or tiny one', () => {
        const ids = ['whisper-large-v3', 'text-embedding-3', 'llama-3.2-1b-instruct', 'qwen3-coder-480b-a35b-instruct', 'llama-3.3-70b-versatile', 'orpheus-tts'];
        expect(pickReplacement(ids, { providerId: 'groq' })).toBe('qwen3-coder-480b-a35b-instruct');
    });
    it('does not return the model that just failed', () => {
        expect(pickReplacement(['qwen3-coder-480b', 'llama-3.3-70b-versatile'], { current: 'qwen3-coder-480b' })).toBe('llama-3.3-70b-versatile');
    });
    it('OpenRouter: only ids ending ":free" are eligible, so the free tier is the only thing ever used', () => {
        expect(pickReplacement(['deepseek/deepseek-chat-v3.1', 'openai/gpt-5'], { providerId: 'openrouter' })).toBe(null);
        expect(pickReplacement(['deepseek/deepseek-chat-v3.1', 'openai/gpt-oss-120b:free'], { providerId: 'openrouter' })).toBe('openai/gpt-oss-120b:free');
    });
    it('returns nothing rather than guessing when no name is one we know to be good', () => {
        expect(pickReplacement(['zorblax-1', 'frobnicate-xl'], {})).toBe(null);
        expect(pickReplacement([], {})).toBe(null);
        expect(pickReplacement(null, {})).toBe(null);
    });
});

describe('chat() replaces a retired model once, from the provider\'s own list', () => {
    let calls;
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    const ok = (t) => reply(200, { choices: [{ message: { content: t } }] });
    const GONE = reply(404, { error: { message: 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.', code: 'model_not_found' } });
    const env = { GROQ_API_KEY: 'test-key-not-real' };
    const ask = () => chat({ prompt: 'hi', only: ['groq'], env, maxTokens: 8 });

    beforeEach(() => { _resetHealedModels(); calls = []; vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    const stub = (handler) => vi.stubGlobal('fetch', async (url, init) => { calls.push({ url: String(url), method: (init && init.method) || 'GET', init }); return handler(String(url), init); });
    const postBody = (c) => JSON.parse(c.init.body);

    it('404 "model gone" → lists the provider\'s models → retries with the best one → answers', async () => {
        let posts = 0;
        stub((url, init) => {
            if (init && init.method === 'POST') return ++posts === 1 ? GONE : ok('hello');
            return reply(200, { data: [{ id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-120b' }, { id: 'llama-3.1-8b-instant' }] });
        });
        const r = await ask();
        expect(r.text).toBe('hello');
        expect(r.model).toBe('openai/gpt-oss-120b');
        expect(healedModels()).toEqual([{ provider: 'groq', from: 'llama-3.3-70b-versatile', to: 'openai/gpt-oss-120b' }]);
        const get = calls.find((c) => c.method === 'GET');
        expect(get.url).toBe('https://api.groq.com/openai/v1/models');
        expect(get.init.headers.Authorization).toBe('Bearer test-key-not-real');
        expect(postBody(calls[calls.length - 1]).model).toBe('openai/gpt-oss-120b');
    });

    it('later calls go straight to the healed model: no second list, no second failure', async () => {
        stub((url, init) => (init && init.method === 'POST' ? (postBody({ init }).model === 'llama-3.3-70b-versatile' ? GONE : ok('again')) : reply(200, { data: [{ id: 'openai/gpt-oss-120b' }] })));
        await ask();
        calls.length = 0;
        const r = await ask();
        expect(r.text).toBe('again');
        expect(calls.filter((c) => c.method === 'GET').length).toBe(0);
        expect(calls.length).toBe(1);
    });

    it('a credit or auth answer is NOT a retired model: no list is fetched, the original error stands', async () => {
        stub(() => reply(400, { error: { message: 'Your credit balance is too low to access the API.' } }));
        await expect(ask()).rejects.toThrow(/credit balance/);
        expect(calls.filter((c) => c.method === 'GET').length).toBe(0);
    });

    it('the replacement is given ONE chance: if it is gone too, the run does not chase models', async () => {
        stub((url, init) => (init && init.method === 'POST' ? GONE : reply(200, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'qwen3-coder-480b' }] })));
        await expect(ask()).rejects.toThrow(/does not exist/);
        expect(calls.filter((c) => c.method === 'GET').length).toBe(1);
        expect(calls.filter((c) => c.method === 'POST').length).toBe(2);
    });

    it('an unreachable or useless list leaves the original failure intact', async () => {
        stub((url, init) => (init && init.method === 'POST' ? GONE : reply(500, 'nope')));
        await expect(ask()).rejects.toThrow(/does not exist/);
        expect(healedModels()).toEqual([]);
    });

    it('a configured model from the environment is healed too, and named in the status report', async () => {
        // a model name is read from process.env by every provider (GROQ_MODEL…), so that is where it is set
        const before = process.env.GROQ_MODEL;
        process.env.GROQ_MODEL = 'old-model';
        try {
            stub((url, init) => (init && init.method === 'POST' ? (postBody({ init }).model === 'old-model' ? GONE : ok('fine')) : reply(200, { data: [{ id: 'llama-3.3-70b-versatile' }] })));
            const r = await chat({ prompt: 'hi', only: ['groq'], env, maxTokens: 8 });
            expect(r.model).toBe('llama-3.3-70b-versatile');
            expect(describeAvailability(env).healed).toEqual([{ provider: 'groq', from: 'old-model', to: 'llama-3.3-70b-versatile' }]);
        } finally {
            if (before === undefined) delete process.env.GROQ_MODEL; else process.env.GROQ_MODEL = before;
        }
    });
});
