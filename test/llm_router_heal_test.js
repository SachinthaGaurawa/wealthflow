/* A provider whose model name has been retired is not lost for the whole run: its own list gives a replacement.
 *
 * WHAT HAPPENED (run 41698322633, 2026-11-03): of thirteen configured providers nine answered "this model is gone"
 * (cerebras "archived", groq "does not exist", fireworks "not deployed", nvidia "end of life", openrouter "unavailable
 * for free", huggingface "not supported"…). Every run paid for nine failures and then worked with two providers, so the
 * "independent" security reviewer and the test author had nobody to be independent of. The error texts below are the
 * real ones from that log.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chat, isRetiredModelError, pickReplacement, healedModels, _resetHealedModels, describeAvailability, replacementUnusable, statedSize, MAX_HEALS } from '../autonomy/llm-router.mjs';

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

    it('a replacement that is gone too is followed by the next one, and the chase ends when the list is used up', async () => {
        stub((url, init) => (init && init.method === 'POST' ? GONE : reply(200, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'qwen3-coder-480b' }] })));
        await expect(ask()).rejects.toThrow(/does not exist/);
        expect(calls.filter((c) => c.method === 'GET').length).toBe(1);                 // the list is asked for once
        const asked = calls.filter((c) => c.method === 'POST').map(postBody).map((b) => b.model);
        expect(asked).toEqual(['llama-3.3-70b-versatile', 'qwen3-coder-480b', 'openai/gpt-oss-120b']);   // each model once, none twice
    });

    it(`never more than ${MAX_HEALS} replacements in one process, however long the list is`, async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ id: `qwen3-coder-${100 + i}b-instruct` }));
        stub((url, init) => (init && init.method === 'POST' ? GONE : reply(200, { data: many })));
        await expect(ask()).rejects.toThrow(/does not exist/);
        expect(calls.filter((c) => c.method === 'POST').length).toBe(1 + MAX_HEALS);
        calls.length = 0;
        await expect(ask()).rejects.toThrow();                                          // and a later call does not start the chase again
        expect(calls.filter((c) => c.method === 'GET').length).toBe(0);
        expect(calls.filter((c) => c.method === 'POST').length).toBe(1);
    });

    it('a replacement that answers with a rate limit or a key error is NOT chased: only "this model cannot be called" is', async () => {
        let posts = 0;
        stub((url, init) => {
            if (init && init.method === 'POST') return ++posts === 1 ? GONE : reply(429, { error: { message: 'rate limit reached' } });
            return reply(200, { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'qwen3-coder-480b' }] });
        });
        await expect(ask()).rejects.toThrow(/rate limit/);
        expect(posts).toBe(2);
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

// Run 43180498898 (2026-11-12, the idea engine). Two providers sat out the whole run, and neither for a reason on their side:
//   nvidia      "model qwen/qwen2.5-coder-32b-instruct is gone → using deepseek-ai/deepseek-coder-6.7b-instruct", then three times
//               HTTP 404 "Function '…': Not found for account '…'": the one replacement could not be called and no other was tried
//   openrouter  "model deepseek/deepseek-chat-v3.1:free is gone and its own list offered no usable replacement", with 13 free
//               models in that list, none with a name the chooser knew
// The board worked with 4 of 12 providers that day (#609; its floor is 5).
describe('a replacement that cannot be called is followed by the next (NVIDIA, 2026-11-12)', () => {
    let calls;
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body });
    const ok = (t) => reply(200, { choices: [{ message: { content: t } }] });
    const env = { NVIDIA_API_KEY: 'test-key-not-real' };
    const EOL = reply(410, { title: 'Gone', status: 410, detail: "The model 'qwen/qwen2.5-coder-32b-instruct' has reached its end of life and is no longer available." });
    const NO_FUNCTION = reply(404, { status: 404, title: 'Not Found', detail: "Function 'invented-function-id': Not found for account 'invented-account'" });
    const LIST = { data: [{ id: 'deepseek-ai/deepseek-coder-6.7b-instruct' }, { id: 'nvidia/nv-embed-v1' }, { id: 'qwen/qwen3-coder-480b-a35b-instruct' }, { id: 'meta/llama-3.3-70b-instruct' }] };
    beforeEach(() => { _resetHealedModels(); calls = []; vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
    const stub = (handler) => vi.stubGlobal('fetch', async (url, init) => { calls.push({ url: String(url), method: (init && init.method) || 'GET', init }); return handler(String(url), init); });
    const model = (init) => JSON.parse(init.body).model;

    it('the words NVIDIA uses carry no "model", so only a replacement is judged by them, never a configured model', () => {
        expect(isRetiredModelError(404, "nvidia: HTTP 404 {\"status\":404,\"title\":\"Not Found\",\"detail\":\"Function 'x': Not found for account 'y'\"}")).toBe(false);
        expect(replacementUnusable(404)).toBe(true);
        expect(replacementUnusable(410)).toBe(true);
        for (const s of [400, 401, 402, 403, 429, 500, 503, undefined]) expect(replacementUnusable(s), String(s)).toBe(false);
    });

    it('configured model gone → first replacement cannot be called → the next one answers, and is the one remembered', async () => {
        stub((url, init) => {
            if (!(init && init.method === 'POST')) return reply(200, LIST);
            const m = model(init);
            if (m === 'qwen/qwen2.5-coder-32b-instruct') return EOL;
            if (m === 'qwen/qwen3-coder-480b-a35b-instruct') return NO_FUNCTION;         // listed, but not for this account
            return ok('answer');
        });
        const r = await chat({ prompt: 'hi', only: ['nvidia'], env, maxTokens: 8 });
        expect(r.text).toBe('answer');
        expect(r.model).toBe('meta/llama-3.3-70b-instruct');
        expect(healedModels()).toEqual([{ provider: 'nvidia', from: 'qwen/qwen3-coder-480b-a35b-instruct', to: 'meta/llama-3.3-70b-instruct' }]);
        expect(calls.filter((c) => c.method === 'GET').length).toBe(1);
        calls.length = 0;
        await chat({ prompt: 'again', only: ['nvidia'], env, maxTokens: 8 });           // the next call goes straight to the one that answered
        expect(calls.length).toBe(1);
        expect(model(calls[0].init)).toBe('meta/llama-3.3-70b-instruct');
    });

    it('a 6.7b model is not chosen ahead of a large one because its name says "coder"', () => {
        expect(statedSize('deepseek-ai/deepseek-coder-6.7b-instruct')).toBe(6.7);
        expect(statedSize('nvidia/nemotron-3-ultra-550b-a55b:free')).toBe(550);
        expect(statedSize('openai/gpt-oss')).toBe(0);
        expect(pickReplacement(LIST.data.map((x) => x.id), { providerId: 'nvidia' })).toBe('qwen/qwen3-coder-480b-a35b-instruct');
        expect(pickReplacement(['deepseek-ai/deepseek-coder-6.7b-instruct', 'meta/llama-3.3-70b-instruct'], { providerId: 'nvidia' })).toBe('meta/llama-3.3-70b-instruct');
        expect(pickReplacement(['deepseek-ai/deepseek-coder-6.7b-instruct'], { providerId: 'nvidia' })).toBe('deepseek-ai/deepseek-coder-6.7b-instruct');   // alone, it is still better than nothing
        expect(pickReplacement(['deepseek-ai/deepseek-coder-6.7b-instruct', 'qwen/qwen3-coder-32b-instruct'], { providerId: 'nvidia' })).toBe('qwen/qwen3-coder-32b-instruct');
    });

    it('a configured model that answers a plain 404 (a wrong address) is still not healed', async () => {
        stub((url, init) => (init && init.method === 'POST' ? reply(404, 'page not found') : reply(200, LIST)));
        await expect(chat({ prompt: 'hi', only: ['nvidia'], env, maxTokens: 8 })).rejects.toThrow(/404/);
        expect(calls.filter((c) => c.method === 'GET').length).toBe(0);
    });
});

describe('OpenRouter with a free list of names nobody knew (2026-11-12)', () => {
    // The thirteen ids OpenRouter listed as free that day, and two paid ones.
    const FREE = ['baidu/ernie-5.5-flash-preview:free', 'thinkingmachines/inkling-2-small:free', 'liquid/lfm-3-1.7b:free', 'recursive/flint-v1.0:free', 'nvidia/nemotron-3.5-super-vl:free',
        'dots-studio/dots-3-note-preview:free', 'liquid/lfm-2.5-2.6b:free', 'nvidia/nemotron-3.5-lightning:free', 'cohere/north-mini-code:free', 'nvidia/nemotron-3-ultra-550b-a55b:free',
        'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free'];
    const PAID = ['deepseek/deepseek-chat-v3.1', 'openai/gpt-oss-120b'];
    const pick = (exclude = []) => pickReplacement([...PAID, ...FREE], { providerId: 'openrouter', current: 'deepseek/deepseek-chat-v3.1:free', exclude });

    it('takes the largest free chat model instead of "no usable replacement"', () => {
        expect(pick()).toBe('nvidia/nemotron-3-ultra-550b-a55b:free');
    });
    it('each one that fails is followed by the next largest, and never by a paid, small, preview-first or image-only model', () => {
        const order = []; for (let i = 0; i < 20; i++) { const p = pick(order); if (!p) break; order.push(p); }
        expect(order.slice(0, 3)).toEqual(['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free']);
        for (const id of order) {
            expect(id).toMatch(/:free$/);
            expect(id).not.toMatch(/small|mini|nano|1\.7b|2\.6b|-vl|omni/);
        }
        const firstPreview = order.findIndex((id) => /preview/.test(id));                       // a preview only after every stable name
        expect(firstPreview).toBeGreaterThan(2);
        expect(order.slice(firstPreview).every((id) => /preview/.test(id))).toBe(true);
    });
    it('a name the chooser knows still wins when one is listed', () => {
        expect(pickReplacement([...FREE, 'openai/gpt-oss-120b:free'], { providerId: 'openrouter' })).toBe('openai/gpt-oss-120b:free');
    });
    it('every other provider keeps the old rule: an unknown name is left unused, because there a guess could cost money', () => {
        expect(pickReplacement(FREE.map((id) => id.replace(/:free$/, '')), { providerId: 'together' })).toBe(null);
        expect(pickReplacement(['zorblax-1', 'frobnicate-xl'], { providerId: 'groq' })).toBe(null);
    });
    it('a free list with only small or image models is still "nothing usable"', () => {
        expect(pickReplacement(['liquid/lfm-3-1.7b:free', 'cohere/north-mini-code:free', 'nvidia/nemotron-3.5-super-vl:free'], { providerId: 'openrouter' })).toBe(null);
    });
});
