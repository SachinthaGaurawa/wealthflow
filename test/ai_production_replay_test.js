import { afterEach, describe, it, expect, vi } from 'vitest';
import handler, { modelBook, resetProviderCooldowns } from '../api/ai.js';
import { resetReasoningLearning } from '../ai-chat.mjs';
import { resetGeminiLearning } from '../gemini-client.mjs';

/* =============================================================================
 * THE PRODUCTION LOG OF 2026-10-01, REPLAYED.
 *
 * 10:11–10:17 UTC: 79 of 101 AI calls refused (HTTP 422). The financial board needs five independent providers to answer, and the
 * log shows what each of the sixteen did: some answered; Groq, Ollama, Fireworks and OpenRouter returned EMPTY (reasoning models that
 * spent the budget thinking); GitHubModels answered 200 "OK"; NVIDIA and Cerebras named retired models; Mistral, Cohere and HF were out
 * of quota; one provider never answered at all. This file stands up that exact roster — each provider failing the way the log says it
 * failed — and asks the board the way the statement reader asks it. Before the fix it was a 422; the board now reaches five.
 * ===========================================================================*/

const ANSWER = '{"decisions":[{"index":0,"module":"expenses","category":"Groceries","allocationId":""}]}';
const KEYS = ['WealthFlow_API_Key', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'OLLAMA_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'NVIDIA_API_KEY', 'GITHUB_MODELS_TOKEN', 'COHERE_API_KEY', 'HF_API_KEY'];

afterEach(() => { modelBook.reset(); resetProviderCooldowns(); resetReasoningLearning(); resetGeminiLearning(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const failure = (status, text) => ({ ok: false, status, json: async () => ({}), text: async () => text });
const chat = (content, finish = 'stop', extra = {}) => json({ choices: [{ message: { content, ...extra }, finish_reason: finish }] });
const THOUGHT = (finish = 'length') => chat('', finish, { reasoning: 'let me think about this '.repeat(100) });

function world() {
    const log = [];
    const fetch = vi.fn(async (url, init) => {
        const u = String(url);
        const body = init && init.body ? JSON.parse(init.body) : {};
        const model = body.model || (/models\/([^:]+):generate/.exec(u) || [])[1] || '';
        log.push({ u, model, body });
        // ---- model lists
        if (/api\.groq\.com.*\/models$/.test(u)) return json({ data: [{ id: 'openai/gpt-oss-120b' }] });
        if (/fireworks.*\/models$/.test(u)) return json({ data: [{ id: 'accounts/fireworks/models/qwen3-235b-a22b-thinking-2507' }, { id: 'accounts/fireworks/models/llama4-maverick-instruct-basic' }, { id: 'accounts/fireworks/models/qwen3-235b-a22b-instruct-2507' }] });
        if (/openrouter\.ai.*\/models$/.test(u)) return json({ data: [{ id: 'inclusionai/ling-3.0-flash-fin', pricing: { prompt: '0', completion: '0' } }, { id: 'google/gemma-4-27b-it:free', pricing: { prompt: '0', completion: '0' } }] });
        if (/cerebras.*\/models$/.test(u)) return json({ data: [{ id: 'gpt-oss-120b' }, { id: 'llama3.1-8b' }] });
        if (/nvidia.*\/models$/.test(u)) return json({ data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'meta/llama-4-maverick-17b-128e-instruct' }, { id: 'nvidia/nv-embedqa-e5-v5' }] });
        if (/models\?/.test(u)) return json({ models: [] });
        // ---- the providers, each failing the way the log says it did
        if (/googleapis/.test(u)) return json({ candidates: [{ content: { parts: [{ text: ANSWER }] }, finishReason: 'STOP' }] });
        if (/deepseek/.test(u)) return chat(ANSWER);
        if (/api\.groq\.com/.test(u)) return body.max_tokens === 3500 ? THOUGHT('length') : chat(ANSWER);        // thought all of its budget; given room, it answers
        if (/ollama\.com/.test(u)) return json({ message: { content: ANSWER }, done_reason: 'stop' });
        if (/together/.test(u)) return chat(ANSWER);
        if (/fireworks/.test(u)) return model === 'accounts/fireworks/models/llama-v3p3-70b-instruct' ? failure(404, '{"error":{"message":"Model not found, inaccessible, and/or not deployed","code":"NOT_FOUND"}}') : /thinking|llama4-maverick/.test(model) ? THOUGHT('length') : chat(ANSWER);   // the default is gone; the model the list offers first thinks its budget away
        if (/openrouter\.ai/.test(u)) {
            if (/ling-3\.0-flash-fin:free/.test(model)) return failure(404, '{"error":{"message":"This model is unavailable for free. The paid version is available now","code":404}}');
            if (/qwen/.test(model)) return failure(429, '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"qwen/qwen3.8-27b:free is temporarily rate-limited upstream."}}}');
            if (/nemotron/.test(model)) return new Promise(() => {});                                                // never answers
            return chat(ANSWER);
        }
        if (/cerebras/.test(u)) return model === 'llama3.1-8b' ? failure(404, '{"message":"Model does not exist or you do not have access to it.","code":"model_not_found"}') : chat(ANSWER);
        if (/nvidia/.test(u)) return /llama-3\.1-8b|llama-3\.3-70b/.test(model) ? failure(410, '{"title":"Gone","status":410,"detail":"The model has reached its end of life"}') : chat(ANSWER);
        if (/models\.github\.ai/.test(u)) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token \'O\', "OK\r\n" is not valid JSON'); }, text: async () => 'OK\r\n' };
        if (/mistral/.test(u)) return failure(429, '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","code":"1300"}');
        if (/cohere/.test(u)) return failure(429, '');
        if (/huggingface/.test(u)) return failure(402, '{"error":"You have depleted your monthly included credits."}');
        throw new Error('unexpected url ' + u);
    });
    return { fetch, log };
}
const boardRequest = () => ({ method: 'POST', body: { prompt: 'Return only JSON. Output {"decisions":[{"index":0,"module":"expenses","category":"Groceries","allocationId":""}]}', financialDecision: true, mode: 'unanimous', temperature: 0, maxTokens: 3500, deadlineMs: 2000 } });

describe('the production roster of 2026-10-01', () => {
    it('reaches the five-provider floor and a unanimous decision — it was a 422 in production', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        const res = response(); await handler(boardRequest(), res);
        expect(res.code).toBe(200);
        expect(res.body.unanimous).toBe(true);
        expect(res.body.answered.length).toBeGreaterThanOrEqual(5);
        for (const name of ['Gemini', 'DeepSeek', 'Groq', 'Ollama', 'Together', 'Fireworks', 'OpenRouterFinance', 'Cerebras', 'NVIDIA']) expect(res.body.answered, name).toContain(name);
        for (const name of ['GitHubModels', 'Mistral', 'Cohere', 'HF', 'OpenRouterQwen']) expect(res.body.answered, name).not.toContain(name);   // quota / not JSON: honestly unavailable
    });

    it('every healed provider did it the documented way', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        await handler(boardRequest(), response());
        const to = (re) => w.log.filter((l) => re.test(l.u) && l.model);
        // Groq: gpt-oss was asked for LITTLE reasoning, then given room when the budget was the problem
        const groq = to(/api\.groq\.com.*chat/);
        expect(groq[0].body).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', max_tokens: 3500 });
        expect(groq[1].body.max_tokens).toBe(4096);
        // Ollama: gpt-oss asked to think "low"
        expect(to(/ollama\.com/)[0].body).toMatchObject({ model: 'gpt-oss:120b', think: 'low' });
        // OpenRouter: the unified reasoning object
        expect(to(/openrouter\.ai.*chat/).every((l) => l.body.reasoning && l.body.reasoning.effort === 'low')).toBe(true);
        // Fireworks: the default is gone, the model the list offered first answered NOTHING (thinking) and is set aside, the next one answers
        expect(modelBook.current('Fireworks:text')).toBe('accounts/fireworks/models/qwen3-235b-a22b-instruct-2507');
        expect(modelBook.isBad('Fireworks:text', 'accounts/fireworks/models/llama4-maverick-instruct-basic')).toBe(true);
        expect(modelBook.isBad('Fireworks:text', 'accounts/fireworks/models/llama-v3p3-70b-instruct')).toBe(true);
        // NVIDIA: the retired generation was tried and set aside; the newest family answered
        expect(modelBook.current('NVIDIA:text')).toBe('meta/llama-4-maverick-17b-128e-instruct');
        // Cerebras: the model it has no access to is gone; the list's own model answered
        expect(modelBook.current('Cerebras:text')).toBe('gpt-oss-120b');
        // GitHub Models: the documented headers
        const gh = w.log.find((l) => /models\.github\.ai/.test(l.u));
        expect(gh).toBeTruthy();
    });

    it('the next board call asks no retired model and no thinking-only model again, and loses no provider', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        await handler(boardRequest(), response());
        resetProviderCooldowns();                                    // a new request on the same instance, a minute later
        w.log.length = 0;
        const res = response(); await handler(boardRequest(), res);
        expect(res.code).toBe(200);
        const asked = w.log.filter((l) => l.model).map((l) => l.model);
        for (const dead of ['llama3.1-8b', 'meta/llama-3.1-8b-instruct', 'meta/llama-3.3-70b-instruct', 'inclusionai/ling-3.0-flash-fin:free', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/llama4-maverick-instruct-basic']) expect(asked, dead).not.toContain(dead);
        expect(w.log.filter((l) => /\/models$/.test(l.u))).toHaveLength(0);       // no list asked again either
    });
});
