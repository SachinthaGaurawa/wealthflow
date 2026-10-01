import { afterEach, describe, it, expect, vi } from 'vitest';
import handler, { modelBook, resetProviderCooldowns } from '../api/ai.js';
import { createModelBook, choose, isModelGone, modelsOf, loadModels, TTL_MS } from '../ai-models.mjs';

/* =============================================================================
 * A PROVIDER THAT RETIRES A MODEL IS NOT A PROVIDER THAT IS DOWN.
 *
 * The keys for Gemini, DeepSeek, OpenRouter, Ollama, NVIDIA and Mistral work. What failed in the logs was a model NAME the provider
 * had retired (NVIDIA: "reached its end of life"; OpenRouter: "unavailable for free") or a per-model quota (Gemini). The router now
 * asks the provider what it serves today, chooses by rule, retries once, and remembers.
 * ===========================================================================*/

afterEach(() => { modelBook.reset(); resetProviderCooldowns(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const slot of ['Gemini:any', 'DeepSeek:text', 'Ollama:text', 'Ollama:vision', 'NVIDIA:text', 'NVIDIA:vision', 'Mistral:text', 'Mistral:vision', 'OpenRouterQwen:text', 'OpenRouterFinance:text', 'OpenRouterNemotron:text']) { modelBook.forget(slot); } });

describe('isModelGone', () => {
    it.each([[410, ''], [404, ''], [404, '{"error":{"message":"Model not found, inaccessible, and/or not deployed"}}'], [410, '{"detail":"The model has reached its end of life"}'],
        [400, 'The model `x` has been decommissioned'], [403, 'model does not exist or you do not have access to it'], [400, 'unknown model: foo'], [404, 'This model is unavailable for free']])('%s %j: the model is gone', (status, text) => expect(isModelGone(status, text)).toBe(true));
    it.each([[401, 'invalid api key'], [429, 'rate limit'], [429, 'You exceeded your current quota'], [500, 'internal error'], [503, 'overloaded'], [402, 'payment required'], [400, 'invalid request: temperature out of range'], [403, 'forbidden'], [200, '']])('%s %j: it is not', (status, text) => expect(isModelGone(status, text)).toBe(false));
});

describe('modelsOf', () => {
    it('reads each provider\'s list shape, and nonsense as nothing', () => {
        expect(modelsOf('openai', { data: [{ id: 'a' }, { id: 'b', pricing: { prompt: '0', completion: '0' } }, { id: 'c', pricing: { prompt: '0.1', completion: '0.2' } }, {}, null] })).toEqual([{ id: 'a' }, { id: 'b', free: true }, { id: 'c', free: false }]);
        expect(modelsOf('openai', [{ id: 'together/x' }])).toEqual([{ id: 'together/x' }]);
        expect(modelsOf('gemini', { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] })).toEqual([{ id: 'gemini-3.8-flash', methods: ['generateContent'] }]);
        expect(modelsOf('ollama', { models: [{ name: 'gpt-oss:120b' }, { model: 'llama3.3:70b' }] })).toEqual([{ id: 'gpt-oss:120b' }, { id: 'llama3.3:70b' }]);
        for (const junk of [null, undefined, 5, 'x', [], {}, { data: 'x' }, { models: 7 }]) for (const kind of ['openai', 'gemini', 'ollama']) expect(modelsOf(kind, junk)).toEqual([]);
    });
});

describe('choose', () => {
    const ids = (...list) => list.map((id) => ({ id }));
    it('NVIDIA: the newest live instruct family first, the generation a provider has retired LAST (it is still listed after its end of life), never an embedding or a guard model', () => {
        const models = ids('meta/llama-3.1-8b-instruct', 'nvidia/nv-embedqa-e5-v5', 'meta/llama-guard-4-12b', 'nvidia/llama-3.1-nemotron-70b-instruct', 'meta/llama-3.3-70b-instruct', 'meta/llama-3.2-90b-vision-instruct', 'meta/llama-4-maverick-17b-128e-instruct');
        expect(choose({ provider: 'NVIDIA', models, exclude: ['meta/llama-3.1-8b-instruct'] })).toBe('meta/llama-4-maverick-17b-128e-instruct');
        expect(choose({ provider: 'NVIDIA', models, exclude: ['meta/llama-3.1-8b-instruct', 'meta/llama-4-maverick-17b-128e-instruct'] })).toBe('nvidia/llama-3.1-nemotron-70b-instruct');
        expect(choose({ provider: 'NVIDIA', models, exclude: ['meta/llama-4-maverick-17b-128e-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'] })).toBe('meta/llama-3.3-70b-instruct');
        expect(choose({ provider: 'NVIDIA', models, vision: true })).toBe('meta/llama-3.2-90b-vision-instruct');
    });
    it('a thinking-only model is the last of its provider\'s models for a text role', () => {
        const models = ids('accounts/fireworks/models/deepseek-r1', 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507', 'accounts/fireworks/models/llama-v3p3-70b-instruct');
        expect(choose({ provider: 'Fireworks', models })).toBe('accounts/fireworks/models/llama-v3p3-70b-instruct');
        expect(choose({ provider: 'Fireworks', models, exclude: ['accounts/fireworks/models/llama-v3p3-70b-instruct'] })).toMatch(/deepseek-r1|thinking/);
    });
    it('Mistral: small, then medium; vision picks pixtral', () => {
        const models = ids('mistral-large-latest', 'mistral-small-latest', 'mistral-embed', 'mistral-moderation-latest', 'pixtral-large-latest', 'open-mistral-nemo');
        expect(choose({ provider: 'Mistral', models })).toBe('mistral-small-latest');
        expect(choose({ provider: 'Mistral', models, exclude: ['mistral-small-latest'] })).toBe('open-mistral-nemo');
        expect(choose({ provider: 'Mistral', models, vision: true })).toBe('pixtral-large-latest');
    });
    it('OpenRouter: only FREE models, and each role picks a different family so the voters stay independent', () => {
        const models = [{ id: 'qwen/qwen3.9-32b:free', free: true }, { id: 'nvidia/nemotron-4-ultra:free', free: true }, { id: 'inclusionai/ling-4-flash:free', free: true }, { id: 'qwen/qwen3.9-72b', free: false }, { id: 'openai/gpt-5', free: false }, { id: 'meta-llama/llama-3.3-70b-instruct:free', free: true }];
        expect(choose({ provider: 'OpenRouterQwen', models })).toBe('qwen/qwen3.9-32b:free');
        expect(choose({ provider: 'OpenRouterNemotron', models })).toBe('nvidia/nemotron-4-ultra:free');
        expect(choose({ provider: 'OpenRouterFinance', models })).toBe('inclusionai/ling-4-flash:free');
        expect(choose({ provider: 'OpenRouterQwen', models: [{ id: 'openai/gpt-5', free: false }] })).toBe('');
    });
    it('Gemini: the newest stable flash that can generate content, then flash-lite; previews last; quota is per model so the next one is another model', () => {
        const models = [{ id: 'gemini-3.8-flash', methods: ['generateContent'] }, { id: 'gemini-3.8-flash-lite', methods: ['generateContent'] }, { id: 'gemini-4.0-flash-preview', methods: ['generateContent'] }, { id: 'gemini-3.8-pro', methods: ['generateContent'] }, { id: 'gemini-embedding-001', methods: ['embedContent'] }, { id: 'imagen-5', methods: ['predict'] }, { id: 'gemini-3.7-flash', methods: ['generateContent'] }];
        expect(choose({ provider: 'Gemini', models })).toBe('gemini-3.8-flash');
        expect(choose({ provider: 'Gemini', models, exclude: ['gemini-3.8-flash'] })).toBe('gemini-3.7-flash');
        expect(choose({ provider: 'Gemini', models, exclude: ['gemini-3.8-flash', 'gemini-3.7-flash'] })).toBe('gemini-4.0-flash-preview'.length ? 'gemini-3.8-flash-lite' : '');
        expect(choose({ provider: 'Gemini', models: [{ id: 'gemini-embedding-001', methods: ['embedContent'] }] })).toBe('');
    });
    it('DeepSeek: chat; Ollama: gpt-oss, then the next family', () => {
        expect(choose({ provider: 'DeepSeek', models: ids('deepseek-reasoner', 'deepseek-chat') })).toBe('deepseek-chat');
        expect(choose({ provider: 'DeepSeek', models: ids('deepseek-v4', 'deepseek-reasoner'), exclude: [] })).toBe('deepseek-v4');
        expect(choose({ provider: 'Ollama', models: ids('qwen3:235b', 'gpt-oss:120b', 'llama3.3:70b') })).toBe('gpt-oss:120b');
        expect(choose({ provider: 'Ollama', models: ids('qwen3:235b', 'gpt-oss:120b', 'llama3.3:70b'), exclude: ['gpt-oss:120b'] })).toBe('llama3.3:70b');
        expect(choose({ provider: 'Ollama', models: ids('llama3.2-vision:11b', 'gpt-oss:120b'), vision: true })).toBe('llama3.2-vision:11b');
    });
    it('nothing to choose from is "", and junk is ignored', () => {
        for (const models of [[], null, undefined, [null, {}, { id: '' }], 'x']) expect(choose({ provider: 'NVIDIA', models })).toBe('');
    });
});

describe('the book', () => {
    it('remembers a choice for hours, forgets it after, and never offers a model it knows is bad', async () => {
        let t = 1000;
        const book = createModelBook({ now: () => t });
        book.remember('NVIDIA:text', 'm1');
        expect(book.current('NVIDIA:text')).toBe('m1');
        t += TTL_MS - 1; expect(book.current('NVIDIA:text')).toBe('m1');
        t += 2; expect(book.current('NVIDIA:text')).toBe('');
        book.markBad('NVIDIA:text', 'm2'); expect(book.isBad('NVIDIA:text', 'm2')).toBe(true);
        t += TTL_MS + 1; expect(book.isBad('NVIDIA:text', 'm2')).toBe(false);
    });
    it('marking the remembered model bad forgets it', () => { const book = createModelBook(); book.remember('s', 'm'); book.markBad('s', 'm'); expect(book.current('s')).toBe(''); });
    it('asks a provider for its list ONCE for any number of concurrent callers, and a failed list is asked again soon, not in hours', async () => {
        let t = 0, calls = 0;
        const book = createModelBook({ now: () => t });
        const load = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return [{ id: 'good-instruct' }]; };
        const out = await Promise.all([1, 2, 3, 4].map(() => book.replacement({ slot: 'X:text', provider: 'NVIDIA', failed: 'old', load })));
        expect(out).toEqual(['good-instruct', 'good-instruct', 'good-instruct', 'good-instruct']); expect(calls).toBe(1);
        const failing = createModelBook({ now: () => t });
        let n = 0;
        const bad = async () => { n++; throw new Error('list down'); };
        expect(await failing.replacement({ slot: 'X:text', provider: 'NVIDIA', failed: 'old', load: bad })).toBe('');
        t += 30 * 1000; await failing.replacement({ slot: 'X:text', provider: 'NVIDIA', failed: 'old', load: bad }); expect(n).toBe(1);
        t += 61 * 1000; await failing.replacement({ slot: 'X:text', provider: 'NVIDIA', failed: 'old', load: bad }); expect(n).toBe(2);
    });
    it('a list that does not load is "no replacement", never an exception', async () => {
        expect(await loadModels({ kind: 'openai', url: 'https://x/v1/models', key: 'k', fetcher: async () => { throw new Error('offline'); } })).toEqual([]);
        expect(await loadModels({ kind: 'openai', url: 'https://x/v1/models', key: 'k', fetcher: async () => ({ ok: false }) })).toEqual([]);
        expect(await loadModels({ kind: 'gemini', url: 'https://x/models?pageSize=2', key: 'a b', fetcher: async (u) => { expect(u).toBe('https://x/models?pageSize=2&key=a%20b'); return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-1-flash', supportedGenerationMethods: ['generateContent'] }] }) }; } })).toEqual([{ id: 'gemini-1-flash', methods: ['generateContent'] }]);
    });
});

/* ── through the endpoint, with the providers' real failure messages ─────────────────────────────────────────────────── */
const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const adviceReq = (extra = {}) => ({ method: 'POST', body: { prompt: 'read this statement', task: 'advice', ...extra } });
const okChat = (text = 'answer') => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }), text: async () => '' });
const fail = (status, text) => ({ ok: false, status, text: async () => text, json: async () => ({}) });

describe('the endpoint heals itself', () => {
    it('NVIDIA: 410 "end of life" → its own list → a live model → the answer; and the NEXT call goes straight to the new model', async () => {
        vi.stubEnv('NVIDIA_API_KEY', 'test');
        const asked = [];
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            asked.push([String(url), init && init.body ? JSON.parse(init.body).model : null]);
            if (String(url).endsWith('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'meta/llama-3.1-8b-instruct' }, { id: 'nvidia/nv-embedqa-e5-v5' }, { id: 'meta/llama-3.3-70b-instruct' }] }) };
            const model = JSON.parse(init.body).model;
            if (model === 'meta/llama-3.1-8b-instruct') return fail(410, '{"type":"about:blank","title":"Gone","status":410,"detail":"The model \'meta/llama-3.1-8b-instruct\' has reached its end of life on 2026-08-26"}');
            return okChat('from the new model');
        }));
        const first = response(); await handler(adviceReq({ engines: ['NVIDIA'] }), first);
        expect(first.code).toBe(200); expect(first.body.reply).toBe('from the new model');
        expect(first.body.provider || first.body.answered).toBeTruthy();
        expect(asked.map((a) => a[1]).filter(Boolean)).toEqual(['meta/llama-3.1-8b-instruct', 'meta/llama-3.3-70b-instruct']);
        expect(modelBook.current('NVIDIA:text')).toBe('meta/llama-3.3-70b-instruct');
        asked.length = 0;
        const second = response(); await handler(adviceReq({ engines: ['NVIDIA'] }), second);
        expect(second.code).toBe(200);
        expect(asked.map((a) => a[1]).filter(Boolean)).toEqual(['meta/llama-3.3-70b-instruct']);     // no probe, no list: straight there
        expect(asked.some(([u]) => u.endsWith('/v1/models'))).toBe(false);
    });
    it('OpenRouter: the free ling slug is gone → another free model for the role from the live list', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            if (String(url).endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'inclusionai/ling-3.0-flash-fin', pricing: { prompt: '0.1', completion: '0.2' } }, { id: 'inclusionai/ling-4-flash:free', pricing: { prompt: '0', completion: '0' } }, { id: 'qwen/qwen3.9-32b:free', pricing: { prompt: '0', completion: '0' } }] }) };
            const model = JSON.parse(init.body).model;
            if (model === 'inclusionai/ling-3.0-flash-fin:free') return fail(404, '{"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: inclusionai/ling-3.0-flash-fin","code":404}}');
            return okChat('free answer from ' + model);
        }));
        const res = response(); await handler(adviceReq({ engines: ['OpenRouterFinance'] }), res);
        expect(res.code).toBe(200); expect(res.body.reply).toBe('free answer from inclusionai/ling-4-flash:free');
        // it did NOT pay: the paid slug the error message suggested is never used
        expect(JSON.stringify(fetch.mock.calls.map((c) => c[1] && c[1].body))).not.toContain('"model":"inclusionai/ling-3.0-flash-fin"');
    });
    it('Mistral: model not found → live list → small/medium', async () => {
        vi.stubEnv('MISTRAL_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            if (String(url).endsWith('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'mistral-small-2603' }, { id: 'mistral-medium-latest' }, { id: 'mistral-embed' }] }) };
            const model = JSON.parse(init.body).model;
            return model === 'mistral-small-latest' ? fail(404, '{"object":"error","message":"Model not found","type":"invalid_model"}') : okChat('mistral ' + model);
        }));
        const res = response(); await handler(adviceReq({ engines: ['Mistral'] }), res);
        expect(res.code).toBe(200); expect(res.body.reply).toBe('mistral mistral-medium-latest');
    });
    it('Gemini: a 429 on one model moves to another Gemini model (its quota is its own), and a retired model is replaced', async () => {
        vi.stubEnv('GEMINI_API_KEY', 'test');
        const used = [];
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            const u = String(url);
            if (u.includes('/v1beta/models?')) return { ok: true, json: async () => ({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.8-flash-lite', supportedGenerationMethods: ['generateContent'] }] }) };
            const model = /models\/([^:]+):generateContent/.exec(u)[1]; used.push(model);
            if (model === 'gemini-3.8-flash') return fail(429, '{"error":{"code":429,"message":"You exceeded your current quota"}}');
            return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini says ' + model }] } }] }) };
        }));
        const res = response(); await handler(adviceReq({ engines: ['Gemini'] }), res);
        expect(res.code).toBe(200); expect(res.body.reply).toBe('gemini says gemini-3.8-flash-lite');
        expect(used).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash-lite']);
        // the exhausted model is not retried for two minutes; the one that works is remembered
        used.length = 0;
        const again = response(); await handler(adviceReq({ engines: ['Gemini'] }), again);
        expect(used).toEqual(['gemini-3.8-flash-lite']);
    });
    it('DeepSeek and Ollama heal the same way', async () => {
        vi.stubEnv('DEEPSEEK_API_KEY', 'test'); vi.stubEnv('OLLAMA_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            const u = String(url);
            if (u === 'https://api.deepseek.com/models') return { ok: true, json: async () => ({ data: [{ id: 'deepseek-v4' }] }) };
            if (u === 'https://ollama.com/api/tags') return { ok: true, json: async () => ({ models: [{ name: 'llama3.3:70b' }, { name: 'qwen3:235b' }] }) };
            const model = JSON.parse(init.body).model;
            if (model === 'deepseek-chat' || model === 'gpt-oss:120b') return fail(404, 'model not found');
            return u.includes('ollama') ? { ok: true, json: async () => ({ message: { content: 'ollama ' + model } }) } : okChat('deepseek ' + model);
        }));
        const d = response(); await handler(adviceReq({ engines: ['DeepSeek'] }), d); expect(d.body.reply).toBe('deepseek deepseek-v4');
        const o = response(); await handler(adviceReq({ engines: ['Ollama'] }), o); expect(o.body.reply).toBe('ollama llama3.3:70b');
    });
    it('a quota, a bad key or an outage is NOT a retired model: no list is fetched, no model is swapped', async () => {
        vi.stubEnv('NVIDIA_API_KEY', 'test');
        for (const [status, text] of [[429, 'rate limited'], [401, 'bad key'], [500, 'oops'], [503, 'overloaded']]) {
            const calls = [];
            vi.stubGlobal('fetch', vi.fn(async (url) => { calls.push(String(url)); return fail(status, text); }));
            const res = response(); await handler(adviceReq({ engines: ['NVIDIA'] }), res);
            expect(res.code).toBe(503); expect(calls).toHaveLength(1); expect(calls[0]).toMatch(/chat\/completions/);
            resetProviderCooldowns();
        }
    });
    it('a bounded number of replacements per call, never a loop: replacements that are also gone end in the provider\'s own error, with what each said', async () => {
        vi.stubEnv('NVIDIA_API_KEY', 'test');
        const calls = [];
        vi.stubGlobal('fetch', vi.fn(async (url) => { calls.push(String(url)); if (String(url).endsWith('/v1/models')) return { ok: true, json: async () => ({ data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'meta/llama-3.1-70b-instruct' }] }) }; return fail(410, 'end of life'); }));
        const res = response(); await handler(adviceReq({ engines: ['NVIDIA'] }), res);
        expect(res.code).toBe(503);
        const chats = calls.filter((u) => u.includes('chat/completions'));
        expect(chats).toHaveLength(3);                                                   // the original and the TWO the provider lists — then it stops
        expect(res.body.details).toMatch(/NVIDIA status 410: end of life \[tried meta\/llama-3\.1-8b-instruct→410, meta\/llama-3\.3-70b-instruct→410, meta\/llama-3\.1-70b-instruct→410\]/);
        expect(modelBook.current('NVIDIA:text')).toBe('');
        expect(modelBook.isBad('NVIDIA:text', 'meta/llama-3.3-70b-instruct')).toBe(true);
        // and the next call does not ask the dead default again, nor either replacement
        calls.length = 0; resetProviderCooldowns();
        const again = response(); await handler(adviceReq({ engines: ['NVIDIA'] }), again);
        expect(calls.filter((u) => u.includes('chat/completions'))).toHaveLength(0);
    });
    it('a list that cannot be fetched leaves the provider\'s own error, as before', async () => {
        vi.stubEnv('MISTRAL_API_KEY', 'test');
        vi.stubGlobal('fetch', vi.fn(async (url) => { if (String(url).endsWith('/v1/models')) throw new Error('offline'); return fail(404, 'Model not found'); }));
        const res = response(); await handler(adviceReq({ engines: ['Mistral'] }), res);
        expect(res.code).toBe(503);
    });
});
