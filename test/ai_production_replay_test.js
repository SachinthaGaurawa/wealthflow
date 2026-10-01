import { afterEach, describe, it, expect, vi } from 'vitest';
import handler, { modelBook, resetProviderCooldowns, coolProvider, boardRoster, providerAvailable, providerIsDead } from '../api/ai.js';
import { resetReasoningLearning } from '../ai-chat.mjs';
import { resetGeminiLearning } from '../gemini-client.mjs';
import { ANSWER, KEYS, response, json, failure, chat, THOUGHT, world, boardRequest } from './helpers/ai-world.js';

/* =============================================================================
 * THE PRODUCTION LOG OF 2026-10-01, REPLAYED.
 *
 * 10:11–10:17 UTC: 79 of 101 AI calls refused (HTTP 422). The financial board needs five independent providers to answer, and the
 * log shows what each of the sixteen did: some answered; Groq, Ollama, Fireworks and OpenRouter returned EMPTY (reasoning models that
 * spent the budget thinking); GitHubModels answered 200 "OK"; NVIDIA and Cerebras named retired models; Mistral, Cohere and HF were out
 * of quota; one provider never answered at all. This file stands up that exact roster — each provider failing the way the log says it
 * failed — and asks the board the way the statement reader asks it. Before the fix it was a 422; the board now reaches five.
 * ===========================================================================*/

afterEach(() => { modelBook.reset(); resetProviderCooldowns(); resetReasoningLearning(); resetGeminiLearning(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

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

    it('says in ONE log line why the board did or did not reach five: who answered, who failed and how, who was resting', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        const lines = [];
        const info = vi.spyOn(console, 'info').mockImplementation((line) => { lines.push(String(line)); });
        try {
            await handler(boardRequest(), response());
        } finally { info.mockRestore(); }
        const board = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((l) => l && l.evt === 'ai-board');
        expect(board).toHaveLength(1);
        expect(board[0].ok).toBe(true);
        expect(board[0].answered.length).toBeGreaterThanOrEqual(5);
        expect(board[0].failed.join(' ')).toMatch(/GitHubModels:GitHubModels returned non-JSON/);
        expect(board[0].failed.join(' ')).toMatch(/Mistral:Mistral status 429/);
        expect(typeof board[0].ms).toBe('number');
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

describe('a cooldown is an optimisation, never a reason to refuse', () => {
    const NOW = 1_800_000_000_000;
    const names = ['Gemini', 'DeepSeek', 'Groq', 'Ollama', 'Together', 'Fireworks', 'OpenRouterFinance', 'Cerebras', 'NVIDIA', 'Mistral', 'Cohere', 'HF'];
    afterEach(() => resetProviderCooldowns());

    it('with spare voters, resting providers are left alone — busy ones and dead ones alike', () => {
        coolProvider('Mistral', new Error('Mistral status 429'), NOW); coolProvider('HF', new Error('HF status 402: credits depleted'), NOW);
        const r = boardRoster(names, { needed: 7, now: NOW + 1000 });
        expect(r.asked).toHaveLength(10); expect(r.probation).toEqual([]); expect(r.resting.sort()).toEqual(['HF', 'Mistral']);
    });
    it('under the target, EVERY provider that was only BUSY is asked anyway — quick failers first — and the DEAD never are', () => {
        for (const n of ['Gemini', 'DeepSeek', 'Groq', 'Ollama', 'Together']) coolProvider(n, new Error('Provider response deadline exceeded'), NOW);   // slow: asked last
        coolProvider('Fireworks', new Error('Fireworks status 429: rate limited'), NOW);                                                                // quick: asked first
        coolProvider('OpenRouterFinance', new Error('OpenRouterFinance returned empty'), NOW);
        for (const n of ['Cerebras', 'NVIDIA', 'HF']) coolProvider(n, new Error(n + ' status 410: end of life'), NOW);                                // dead
        const r = boardRoster(names, { needed: 8, now: NOW + 1000 });     // available: Mistral, Cohere = 2
        expect(r.asked).toHaveLength(8);                                    // 2 available + the 2 quick failers + only as many slow ones as the target still needs; the 3 dead stay out
        expect(r.probation[0]).toBe('Fireworks');                           // a rate limit answers at once
        expect(r.probation[1]).toBe('OpenRouterFinance');
        expect(r.probation.slice(2)).toHaveLength(4);
        expect(r.probation.slice(2).every((n) => ['Gemini', 'DeepSeek', 'Groq', 'Ollama', 'Together'].includes(n))).toBe(true);
        for (const dead of ['Cerebras', 'NVIDIA', 'HF']) { expect(r.asked, dead).not.toContain(dead); expect(providerIsDead(dead, NOW + 1000)).toBe(true); }
        expect(r.resting).toEqual(expect.arrayContaining(['Cerebras', 'NVIDIA', 'HF']));
    });
    it('providers that keep the board waiting are not asked once the quick ones already reach the target (the 13-second board of 2026-10-01)', () => {
        for (const n of ['NVIDIA', 'Together']) coolProvider(n, new Error('Provider response deadline exceeded'), NOW);          // slow
        for (const n of ['Mistral', 'Cohere', 'Fireworks']) coolProvider(n, new Error(n + ' status 429: rate limited'), NOW);    // quick
        const r = boardRoster(names, { needed: 8, now: NOW + 1000 });     // available: Gemini, DeepSeek, Groq, Ollama, OpenRouterFinance, Cerebras, HF = 7
        expect(r.asked).toEqual(expect.arrayContaining(['Mistral', 'Cohere', 'Fireworks']));   // quick failers: free to wait for
        expect(r.asked).not.toContain('NVIDIA'); expect(r.asked).not.toContain('Together');      // slow ones: the target is met without them
        expect(r.resting).toEqual(expect.arrayContaining(['NVIDIA', 'Together']));
        // short of the target even with the quick ones, a slow one is asked rather than none (the 422 burst of that day must not return)
        const short = boardRoster(['Gemini', 'NVIDIA', 'Together', 'Mistral'], { needed: 4, now: NOW + 1000 });
        expect(short.asked).toHaveLength(4);
    });
    it('only the dead are resting: nobody is invented, the roster is what is left', () => {
        for (const n of names) coolProvider(n, new Error(n + ' status 402: credits'), NOW);
        const r = boardRoster(names, { needed: 7, now: NOW + 1000 });
        expect(r.asked).toEqual([]); expect(r.probation).toEqual([]);
    });
    it('a cooldown that has run out is no cooldown', () => {
        coolProvider('Groq', new Error('Groq status 429'), NOW);
        expect(providerAvailable('Groq', NOW + 60 * 1000)).toBe(false);
        expect(providerAvailable('Groq', NOW + 3 * 60 * 1000)).toBe(true);
        expect(boardRoster(['Groq'], { needed: 1, now: NOW + 3 * 60 * 1000 }).probation).toEqual([]);
    });
    it('advisory work (needed 1) is never left with nobody to ask while a busy provider exists', () => {
        coolProvider('Gemini', new Error('Gemini status 429'), NOW); coolProvider('Groq', new Error('Groq status 429'), NOW);
        const r = boardRoster(['Gemini', 'Groq'], { needed: 1, now: NOW + 1000 });
        expect(r.asked).toHaveLength(2);                                    // nobody available: every busy provider is asked rather than none
    });

    it('a provider that keeps missing the deadline is left alone longer each time — a minute, three, five — and never as long as a dead one', () => {
        const slow = new Error('Provider response deadline exceeded');
        coolProvider('Slow', slow, NOW);
        expect(providerAvailable('Slow', NOW + 59_000)).toBe(false); expect(providerAvailable('Slow', NOW + 61_000)).toBe(true);
        coolProvider('Slow', slow, NOW + 61_000);                                          // second miss within fifteen minutes
        expect(providerAvailable('Slow', NOW + 61_000 + 179_000)).toBe(false); expect(providerAvailable('Slow', NOW + 61_000 + 181_000)).toBe(true);
        coolProvider('Slow', slow, NOW + 250_000); coolProvider('Slow', slow, NOW + 560_000);   // third and fourth: five minutes, no more
        expect(providerAvailable('Slow', NOW + 560_000 + 299_000)).toBe(false); expect(providerAvailable('Slow', NOW + 560_000 + 301_000)).toBe(true);
        expect(providerIsDead('Slow', NOW + 561_000)).toBe(false);                         // still asked when the board is short of voters
        coolProvider('Slow', slow, NOW + 3_000_000);                                       // an hour-long gap forgives: back to one minute
        expect(providerAvailable('Slow', NOW + 3_000_000 + 61_000)).toBe(true);
    });
    it('through the endpoint: a burst of ordinary failures has cooled most of the roster, and the board STILL reaches five (it was refused in 3 s)', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        for (const n of ['Gemini', 'DeepSeek', 'Groq', 'Ollama', 'Together', 'Fireworks', 'OpenRouterFinance', 'Cerebras', 'NVIDIA', 'OpenRouterNemotron']) coolProvider(n, new Error(n + ' status 429: rate limited'));
        const lines = [];
        const info = vi.spyOn(console, 'info').mockImplementation((line) => { lines.push(String(line)); });
        let res;
        try { res = response(); await handler(boardRequest(), res); } finally { info.mockRestore(); }
        expect(res.code).toBe(200); expect(res.body.unanimous).toBe(true);
        expect(res.body.answered.length).toBeGreaterThanOrEqual(5);
        const board = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((l) => l && l.evt === 'ai-board');
        expect(board.probation.length).toBeGreaterThan(0);                // and the log says who was asked on probation
    });
});
