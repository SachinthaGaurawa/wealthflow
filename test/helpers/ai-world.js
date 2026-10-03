/* The roster of the 2026-10-01 production log, as a scripted network: each provider fails the way the log says it failed. */
import { vi } from 'vitest';

export const ANSWER = '{"decisions":[{"index":0,"module":"expenses","category":"Groceries","allocationId":""}]}';
/* CEREBRAS_API_KEY and HF_API_KEY stay in the list on purpose: the owner removed both providers from the board (2026-10-03) but the variables are still
 * set in Vercel, and the world no longer answers for either, so a board that still asked them would fail on 'unexpected url'. */
export const KEYS = ['WealthFlow_API_Key', 'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'OLLAMA_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY', 'NVIDIA_API_KEY', 'GITHUB_MODELS_TOKEN', 'COHERE_API_KEY', 'HF_API_KEY'];

export const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
export const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
export const failure = (status, text) => ({ ok: false, status, json: async () => ({}), text: async () => text });
export const chat = (content, finish = 'stop', extra = {}) => json({ choices: [{ message: { content, ...extra }, finish_reason: finish }] });
export const THOUGHT = (finish = 'length') => chat('', finish, { reasoning: 'let me think about this '.repeat(100) });

/** `answer` is what every healthy provider says: one row by default, or a whole board (ai_health_test.js passes ten gold rows). */
export function world({ answer = ANSWER } = {}) {
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
        if (/nvidia.*\/models$/.test(u)) return json({ data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'meta/llama-4-maverick-17b-128e-instruct' }, { id: 'nvidia/nv-embedqa-e5-v5' }] });
        if (/models\?/.test(u)) return json({ models: [] });
        // ---- the providers, each failing the way the log says it did
        if (/googleapis/.test(u)) return json({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: 'STOP' }] });
        if (/deepseek/.test(u)) return chat(answer);
        if (/api\.groq\.com/.test(u)) return [3000, 4096].includes(body.max_tokens) ? chat(answer) : THOUGHT('length');        // thought all of its budget; given room, it answers
        if (/ollama\.com/.test(u)) return json({ message: { content: answer }, done_reason: 'stop' });
        if (/together/.test(u)) return chat(answer);
        if (/fireworks/.test(u)) return model === 'accounts/fireworks/models/llama-v3p3-70b-instruct' ? failure(404, '{"error":{"message":"Model not found, inaccessible, and/or not deployed","code":"NOT_FOUND"}}') : /thinking|llama4-maverick/.test(model) ? THOUGHT('length') : chat(answer);   // the default is gone; the model the list offers first thinks its budget away
        if (/openrouter\.ai/.test(u)) {
            if (/ling-3\.0-flash-fin:free/.test(model)) return failure(404, '{"error":{"message":"This model is unavailable for free. The paid version is available now","code":404}}');
            if (/qwen/.test(model)) return failure(429, '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"qwen/qwen3.8-27b:free is temporarily rate-limited upstream."}}}');
            if (/nemotron/.test(model)) return new Promise(() => {});                                                // never answers
            return chat(answer);
        }
        if (/nvidia/.test(u)) return /llama-3\.1-8b|llama-3\.3-70b/.test(model) ? failure(410, '{"title":"Gone","status":410,"detail":"The model has reached its end of life"}') : chat(answer);
        if (/models\.github\.ai/.test(u)) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token \'O\', "OK\r\n" is not valid JSON'); }, text: async () => 'OK\r\n' };
        if (/mistral/.test(u)) return failure(429, '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","code":"1300"}');
        if (/cohere/.test(u)) return failure(429, '');
        throw new Error('unexpected url ' + u);
    });
    return { fetch, log };
}
export const boardRequest = () => ({ method: 'POST', body: { prompt: 'Return only JSON. Output {"decisions":[{"index":0,"module":"expenses","category":"Groceries","allocationId":""}]}', financialDecision: true, mode: 'unanimous', temperature: 0, maxTokens: 3500, deadlineMs: 2000 } });

