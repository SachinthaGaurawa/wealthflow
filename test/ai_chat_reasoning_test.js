import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import handler, { modelBook, resetProviderCooldowns, providerAvailable } from '../api/ai.js';
import { createModelBook } from '../ai-models.mjs';
import { askChat, chatError, readChat, reasoningFor, resetReasoningLearning, REASONING_ID } from '../ai-chat.mjs';

/* =============================================================================
 * THE AI ROSTER THAT "RETURNED EMPTY".
 *
 * Production log, 2026-10-01 10:11–10:17 UTC: 79 of 101 AI calls were refused (422) because the financial board needs FIVE providers
 * to answer and two or three did. Groq, Ollama, Fireworks and three OpenRouter engines all logged "returned empty": they serve
 * reasoning models, whose thinking shares the completion budget with the answer. GitHubModels logged `Unexpected token 'O', "OK"`;
 * NVIDIA and Cerebras logged the same retired-model error on every call.
 * These tests pin the behaviour that gets those providers answering, against the reply shapes the providers really send.
 * ===========================================================================*/

let book;
beforeEach(() => { book = createModelBook(); resetReasoningLearning(); });

const ok = (data) => ({ ok: true, data });
const answer = (text) => ok({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const thought = (finish = 'length', n = 1800) => ok({ choices: [{ message: { content: '', reasoning: 'x'.repeat(n) }, finish_reason: finish }] });
const LIST = [{ id: 'm-new-instruct' }, { id: 'm-newer-instruct' }, { id: 'm-third-instruct' }];

describe('reading a reply', () => {
    it('any shape: a string, parts, null, Ollama\'s message, nothing', () => {
        expect(readChat({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] })).toEqual({ text: 'hi', finish: 'stop', reasoningChars: 0 });
        expect(readChat({ choices: [{ message: { content: [{ text: 'a' }, { content: 'b' }, null] } }] }).text).toBe('ab');
        expect(readChat({ choices: [{ message: { content: null, reasoning_content: 'thinking...' }, finish_reason: 'length' }] })).toEqual({ text: '', finish: 'length', reasoningChars: 11 });
        expect(readChat({ message: { content: '', thinking: 'abc' }, done_reason: 'length' })).toEqual({ text: '', finish: 'length', reasoningChars: 3 });
        for (const junk of [null, undefined, 5, 'x', [], {}, { choices: [] }, { choices: [null] }]) expect(() => readChat(junk)).not.toThrow();
        expect(readChat(null).text).toBe('');
    });
});

describe('asking for little reasoning — only where the provider takes it, in the form it takes', () => {
    it('Groq / Cerebras / Together: gpt-oss only', () => {
        for (const p of ['Groq', 'Cerebras', 'Together']) { expect(reasoningFor(p, 'openai/gpt-oss-120b')).toEqual({ reasoning_effort: 'low' }); expect(reasoningFor(p, 'llama-3.3-70b')).toBeNull(); }
    });
    it('OpenRouter: the unified reasoning object, for every role', () => {
        for (const p of ['OpenRouterFinance', 'OpenRouterQwen', 'OpenRouterNemotron']) expect(reasoningFor(p, 'qwen/qwen3.8-27b:free')).toEqual({ reasoning: { effort: 'low' } });
    });
    it('Fireworks: reasoning families only; Ollama: gpt-oss, as a level (it takes no boolean)', () => {
        expect(reasoningFor('Fireworks', 'accounts/fireworks/models/gpt-oss-120b')).toEqual({ reasoning_effort: 'low' });
        expect(reasoningFor('Fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct')).toBeNull();
        expect(reasoningFor('Ollama', 'gpt-oss:120b', 'ollama')).toEqual({ think: 'low' });
        expect(reasoningFor('Ollama', 'llama3.3:70b', 'ollama')).toBeNull();
    });
    it('nothing for providers that have no such setting', () => {
        for (const p of ['NVIDIA', 'Mistral', 'GitHubModels', 'CloudflareAI', 'DeepSeek']) expect(reasoningFor(p, 'anything')).toBeNull();
    });
    it('the thinking-model pattern names the families that need it', () => {
        for (const id of ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b:free', 'nvidia/nemotron-3-ultra', 'deepseek-r1', 'qwq-32b', 'kimi-k2-thinking']) expect(REASONING_ID.test(id), id).toBe(true);
        for (const id of ['llama-3.3-70b-instruct', 'mistral-small-latest', 'gpt-4o-mini']) expect(REASONING_ID.test(id), id).toBe(false);
    });
});

function provider(script, { name = 'Groq', slot = 'Groq:text', defaultModel = 'dflt', load, kind = 'openai', tokens = 3500, cap = 4096 } = {}) {
    const calls = [];
    const send = async (model, extra, maxTokens) => { calls.push({ model, extra, maxTokens }); const next = typeof script === 'function' ? script(model, extra, maxTokens, calls.length) : script.shift(); return next; };
    return { calls, run: () => askChat({ name, slot, book, defaultModel, tokens, cap, send, load, kind, listKey: name }) };
}

describe('a model that spent its budget thinking', () => {
    it('is asked for little reasoning FIRST, and when the budget was still the problem it is given room — once', async () => {
        const p = provider([thought('length'), answer('{"ok":true}')]);
        const r = await p.run();
        expect(r.text).toBe('{"ok":true}'); expect(r.model).toBe('dflt');
        expect(p.calls[0].extra).toEqual({ reasoning_effort: 'low' }.constructor === Object ? p.calls[0].extra : {});   // provider-shaped, asserted in reasoningFor
        expect(p.calls[0].maxTokens).toBe(3500);
        expect(p.calls[1].maxTokens).toBe(4096);                      // more room, never beyond what the provider takes
        expect(book.current('Groq:text')).toBe('dflt');
    });
    it('the setting travels in the request (gpt-oss on Groq)', async () => {
        const p = provider([answer('x')], { defaultModel: 'openai/gpt-oss-120b' });
        await p.run();
        expect(p.calls[0].extra).toEqual({ reasoning_effort: 'low' });
    });
    it('still empty with room: that model is set aside for half an hour and the provider\'s next model answers — and is remembered', async () => {
        const p = provider((model) => (model === 'dflt' ? thought('length') : answer('from ' + model)), { load: async () => LIST });
        const r = await p.run();
        expect(r.text).toBe('from m-new-instruct');
        expect(book.isBad('Groq:text', 'dflt')).toBe(true);
        expect(book.current('Groq:text')).toBe('m-new-instruct');
        // the next call goes straight to it
        p.calls.length = 0;
        await p.run();
        expect(p.calls.map((c) => c.model)).toEqual(['m-new-instruct']);
    });
    it('an empty reply that is NOT about the budget (it simply said nothing) is not asked again with more room', async () => {
        const p = provider((model) => (model === 'dflt' ? ok({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) : answer('other')), { load: async () => LIST });
        const r = await p.run();
        expect(p.calls.filter((c) => c.model === 'dflt')).toHaveLength(1);
        expect(r.text).toBe('other');
    });
    it('a provider that cannot be healed says plainly what it got, with what it thought', async () => {
        const p = provider([thought('length', 900), thought('length', 1500)]);
        const error = await p.run().catch((e) => chatError('Groq', e));
        expect(error.message).toMatch(/^Groq returned empty \(finish length, it thought \d+ chars\)/);
        expect(p.calls).toHaveLength(2);                             // the reasoning-light try and the one with room — no loop
    });
    it('no model, ever, is asked more than four requests in one call', async () => {
        const p = provider(() => thought('length'), { load: async () => LIST });
        await p.run().catch(() => {});
        expect(p.calls.length).toBeLessThanOrEqual(8);               // 4 models × (try + room)
    });
});

describe('a setting the provider refuses', () => {
    it('a 400 that names reasoning is sent again without it, once, and not sent again after', async () => {
        const p = provider((model, extra, mt, n) => (Object.keys(extra).length ? { ok: false, status: 400, text: '{"error":"reasoning_effort is not supported with this model"}' } : answer('fine')), { defaultModel: 'openai/gpt-oss-120b' });
        expect((await p.run()).text).toBe('fine');
        expect(p.calls.map((c) => Object.keys(c.extra).length)).toEqual([1, 0]);
        p.calls.length = 0;
        await p.run();
        expect(p.calls.map((c) => Object.keys(c.extra).length)).toEqual([0]);
    });
    it('a 400 about anything else is not retried', async () => {
        const p = provider([{ ok: false, status: 400, text: 'temperature out of range' }], { defaultModel: 'openai/gpt-oss-120b', load: async () => LIST });
        await expect(p.run()).rejects.toBeTruthy();
        expect(p.calls).toHaveLength(1);
    });
});

describe('a retired model', () => {
    it('a dead default is never asked again; up to THREE replacements are tried in one call; what each said is in the error', async () => {
        const p = provider(() => ({ ok: false, status: 410, text: 'end of life' }), { name: 'NVIDIA', slot: 'NVIDIA:text', defaultModel: 'old', load: async () => [{ id: 'a-instruct' }, { id: 'b-instruct' }, { id: 'c-instruct' }, { id: 'd-instruct' }] });
        const error = await p.run().catch((e) => chatError('NVIDIA', e));
        expect(p.calls).toHaveLength(4);                              // the default and three replacements, then it stops
        expect(error.message).toMatch(/^NVIDIA status 410: end of life \[tried old→410, [a-d]-instruct→410, [a-d]-instruct→410, [a-d]-instruct→410\]$/);
        p.calls.length = 0;
        await p.run().catch(() => {});
        expect(p.calls.map((c) => c.model)).toEqual(['d-instruct']);   // only the one never tried; none of the dead
        expect(p.calls.some((c) => c.model === 'old')).toBe(false);
    });
    it('a single plain failure keeps the message every caller already reads', async () => {
        const p = provider([{ ok: false, status: 429, text: 'rate limited' }], { load: async () => LIST });
        const error = await p.run().catch((e) => chatError('Groq', e));
        expect(error.message).toBe('Groq status 429: rate limited');
        expect(p.calls).toHaveLength(1);                              // a quota is not a retired model: no list, no swap
    });
    it('with no list the provider has one model and is asked it, whatever the book thinks', async () => {
        book.markBad('Groq:text', 'dflt');
        const p = provider([answer('x')]);
        expect((await p.run()).text).toBe('x');
    });
});

describe('every model set aside', () => {
    it('says so plainly instead of "status undefined", and asks nothing', async () => {
        for (const m of ['dflt', 'm-new-instruct', 'm-newer-instruct', 'm-third-instruct']) book.markBad('Groq:text', m, 30 * 60 * 1000);
        const p = provider([answer('never')], { load: async () => LIST });
        const error = await p.run().catch((e) => chatError('Groq', e));
        expect(error.message).toBe('Groq has no usable model right now (every model it lists is set aside)');
        expect(p.calls).toHaveLength(0);
    });
    it('the endpoint leaves such a provider alone for ten minutes', async () => {
        const { coolProvider } = await import('../api/ai.js');
        coolProvider('Groq', new Error('Groq has no usable model right now (every model it lists is set aside)'), 1000);
        expect(providerAvailable('Groq', 1000 + 9 * 60 * 1000)).toBe(false);
        expect(providerAvailable('Groq', 1000 + 11 * 60 * 1000)).toBe(true);
        resetProviderCooldowns();
    });
});

describe('a failure that is not the provider\'s answer', () => {
    it('the network, an abort or a deadline is passed on with its own message (the cooldown reads it)', async () => {
        const p = provider(() => { throw new Error('This operation was aborted'); }, { load: async () => LIST });
        const error = await p.run().catch((e) => chatError('Groq', e));
        expect(error.message).toBe('This operation was aborted');
        expect(p.calls).toHaveLength(1);
        expect(chatError('X', 'plain string').message).toBe('plain string');
        expect(chatError('X', undefined)).toBeInstanceOf(Error);
    });
});

describe('a 200 that is not JSON', () => {
    it('is said plainly, with its first words, and is not mistaken for a retired model', async () => {
        const p = provider([{ ok: true, nonJson: 'OK\r\n' }], { name: 'GitHubModels', slot: 'GitHubModels:text', load: async () => LIST });
        const error = await p.run().catch((e) => chatError('GitHubModels', e));
        expect(error.message).toBe('GitHubModels returned non-JSON (HTTP 200): "OK"');
        expect(p.calls).toHaveLength(1);
    });
    it('says what the 200 was besides its words — content type, who answered, where it was sent — so the next log names the cause', async () => {
        const p = provider([{ ok: true, nonJson: 'OK', meta: 'text/plain; GitHub.com; models.github.ai' }], { name: 'GitHubModels', slot: 'GitHubModels:text', load: async () => LIST });
        const error = await p.run().catch((e) => chatError('GitHubModels', e));
        expect(error.message).toBe('GitHubModels returned non-JSON (HTTP 200): "OK" {text/plain; GitHub.com; models.github.ai}');
        expect(error.message).toMatch(/returned non-JSON/);         // the cooldown still reads it
    });
});

/* ── through the endpoint ─────────────────────────────────────────────────────────────────────────────────────────── */
const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const adviceReq = (extra = {}) => ({ method: 'POST', body: { prompt: 'read this statement', task: 'advice', maxTokens: 3500, ...extra } });
const resp = (data) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const fail = (status, text) => ({ ok: false, status, text: async () => text, json: async () => ({}) });

describe('through the endpoint', () => {
    afterEach(() => { modelBook.reset(); resetProviderCooldowns(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

    it('Groq (gpt-oss): asks for low reasoning, and when the answer was cut to nothing asks again with room', async () => {
        vi.stubEnv('GROQ_API_KEY', 'test');
        const bodies = [];
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            if (String(url).endsWith('/v1/models')) return resp({ data: [{ id: 'openai/gpt-oss-120b' }] });
            const body = JSON.parse(init.body); bodies.push(body);
            return bodies.length === 1 ? resp({ choices: [{ message: { content: '', reasoning: 'thinking '.repeat(300) }, finish_reason: 'length' }] }) : resp({ choices: [{ message: { content: 'the answer' }, finish_reason: 'stop' }] });
        }));
        const res = response(); await handler(adviceReq({ engines: ['Groq'] }), res);
        expect(res.code).toBe(200); expect(res.body.reply).toBe('the answer');
        expect(bodies[0]).toMatchObject({ model: 'openai/gpt-oss-120b', reasoning_effort: 'low', max_tokens: 3500 });
        expect(bodies[1].max_tokens).toBe(4096);
    });

    it('OpenRouter (Qwen): the unified reasoning object is sent; Ollama (gpt-oss): think "low" and the same budget logic', async () => {
        vi.stubEnv('OPENROUTER_API_KEY', 'test'); vi.stubEnv('OLLAMA_API_KEY', 'test');
        const seen = {};
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            const u = String(url);
            if (u.endsWith('/models') || u.endsWith('/tags')) return resp({ data: [], models: [] });
            const body = JSON.parse(init.body);
            if (u.includes('openrouter')) { seen.or = body; return resp({ choices: [{ message: { content: 'or answer' }, finish_reason: 'stop' }] }); }
            seen.ollama = body;
            return resp({ message: { content: 'ollama answer' }, done_reason: 'stop' });
        }));
        const a = response(); await handler(adviceReq({ engines: ['OpenRouterQwen'] }), a);
        expect(a.code).toBe(200); expect(seen.or.reasoning).toEqual({ effort: 'low' });
        const b = response(); await handler(adviceReq({ engines: ['Ollama'] }), b);
        expect(b.code).toBe(200); expect(seen.ollama).toMatchObject({ model: 'gpt-oss:120b', think: 'low' });
        expect(seen.ollama.options.num_predict).toBe(3500);
    });

    it('GitHubModels: sends the headers GitHub documents; a 200 that is not JSON is named, and the provider is left alone for half an hour', async () => {
        vi.stubEnv('GITHUB_MODELS_TOKEN', 'test');
        let headers;
        vi.stubGlobal('fetch', vi.fn(async (url, init) => { headers = init.headers; return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token \'O\', "OK\r\n" is not valid JSON'); }, text: async () => 'OK\r\n' }; }));
        const res = response(); await handler(adviceReq({ engines: ['GitHubModels'] }), res);
        expect(res.code).toBe(503);
        expect(res.body.details).toContain('GitHubModels returned non-JSON (HTTP 200): "OK"');
        expect(headers.Accept).toBe('application/vnd.github+json'); expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
        expect(providerAvailable('GitHubModels', Date.now() + 29 * 60 * 1000)).toBe(false);
        expect(providerAvailable('GitHubModels', Date.now() + 31 * 60 * 1000)).toBe(true);
    });

    it('GitHubModels: a failure names which variable the token came from and what kind it is, and never a character of it', async () => {
        const secret = 'github_pat_11ABCDEFG0123456789_secretsecretsecret';
        const bare = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('not json'); }, text: async () => 'OK' }));
        vi.stubEnv('GH_PAT', secret); vi.stubEnv('GITHUB_MODELS_TOKEN', 'ghs_old'); vi.stubGlobal('fetch', bare());
        const a = response(); await handler(adviceReq({ engines: ['GitHubModels'] }), a);
        expect(a.body.details).toContain('returned non-JSON (HTTP 200): "OK"'); expect(a.body.details).toContain('[token GH_PAT, fine-grained]');
        expect(JSON.stringify(a.body)).not.toContain(secret);
        resetProviderCooldowns(); vi.unstubAllEnvs(); vi.stubEnv('GITHUB_MODELS_TOKEN', 'ghp_classic'); vi.stubGlobal('fetch', bare());
        const b = response(); await handler(adviceReq({ engines: ['GitHubModels'] }), b);
        expect(b.body.details).toContain('[token GITHUB_MODELS_TOKEN, classic]'); expect(JSON.stringify(b.body)).not.toContain('ghp_classic');
    });

    it('a real Response whose body is not JSON is read without losing the body (clone)', async () => {
        vi.stubEnv('GITHUB_MODELS_TOKEN', 'test');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('OK\r\n', { status: 200 })));
        const res = response(); await handler(adviceReq({ engines: ['GitHubModels'] }), res);
        expect(res.body.details).toContain('returned non-JSON (HTTP 200): "OK"');
    });

    it('NVIDIA: every call used to ask the dead default first; now the default is asked once and three replacements are tried at most', async () => {
        vi.stubEnv('NVIDIA_API_KEY', 'test');
        const asked = [];
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            if (String(url).endsWith('/v1/models')) return resp({ data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'meta/llama-3.1-70b-instruct' }, { id: 'nvidia/nemotron-3-super-instruct' }, { id: 'meta/llama-4-maverick-instruct' }] });
            asked.push(JSON.parse(init.body).model);
            return fail(410, 'end of life');
        }));
        for (let i = 0; i < 3; i++) { const res = response(); await handler(adviceReq({ engines: ['NVIDIA'] }), res); resetProviderCooldowns(); }
        expect(asked.filter((m) => m === 'meta/llama-3.1-8b-instruct')).toHaveLength(1);
        expect(new Set(asked).size).toBe(asked.length);              // no model is asked twice, ever, while it is remembered as bad
    });
});
