import { afterEach, describe, it, expect, vi } from 'vitest';
import handler, { resetProviderCooldowns } from '../api/ai.js';
import { tieredAsk, TIERS, TIER_MS } from '../statement-llm-router.mjs';
import { invokeExtractor } from '../statement-sync.js';
import { jsonOf } from '../statement-adaptive.mjs';

/* =============================================================================
 * ONE ANSWER FROM THE STRONGEST PROVIDER THAT IS UP — and the whole roster behind it, and the rules behind that.
 *
 * Provider A throws a 429 or a 500, answers with prose instead of the JSON asked for, hangs, or is cooling down: the router moves
 * to the next tier at once. When every tier has failed it says so with one error and the caller reads the document by rules.
 * ===========================================================================*/

afterEach(() => { resetProviderCooldowns(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const NOW = Date.parse('2026-10-01T06:00:00Z');
const ok = '{"accounts":[]}';

describe('the roster', () => {
    it('names every provider of api/ai.js exactly once, strongest first', () => {
        const all = TIERS.flat();
        expect(new Set(all).size).toBe(all.length);
        expect(all.sort()).toEqual(['Cerebras', 'Cohere', 'CloudflareAI', 'DeepSeek', 'Fireworks', 'Gemini', 'GitHubModels', 'Groq', 'HF', 'Mistral', 'NVIDIA', 'Ollama', 'OpenRouterFinance', 'OpenRouterNemotron', 'OpenRouterQwen', 'Together'].sort());
        expect(TIERS[0]).toContain('Groq');
    });
});

describe('tieredAsk', () => {
    it('asks the first tier only when it answers', async () => {
        const call = vi.fn(async () => ok);
        expect(await tieredAsk({ call, now: () => NOW })('p')).toBe(ok);
        expect(call).toHaveBeenCalledTimes(1);
        expect(call.mock.calls[0][1].engines).toEqual([...TIERS[0]]);
    });
    it.each([
        ['a 429', () => { throw new Error('Gemini status 429: quota'); }],
        ['a 500', () => { throw new Error('Groq status 500'); }],
        ['a timeout', () => { throw new Error('Provider response deadline exceeded'); }],
        ['no provider configured', () => { throw new Error('ai-extractor-unavailable'); }],
        ['an empty reply', () => ''],
        ['prose instead of JSON', () => 'I cannot read this document.'],
    ])('moves to the next tier on %s', async (_, first) => {
        let n = 0;
        const call = vi.fn(async () => { n++; return n === 1 ? first() : ok; });
        const ask = tieredAsk({ call, accept: (r) => Array.isArray(jsonOf(r)?.accounts), now: () => NOW });
        expect(await ask('p')).toBe(ok);
        expect(call).toHaveBeenCalledTimes(2);
        expect(call.mock.calls[1][1].engines).toEqual([...TIERS[1]]);
    });
    it('goes down the whole roster, and fails ONCE, with what was tried, when nobody answers', async () => {
        const call = vi.fn(async () => { throw new Error('status 429'); });
        const trace = [];
        const ask = tieredAsk({ call, now: () => NOW, onTrace: (t) => trace.push(...t) });
        const error = await ask('p').catch((e) => e);
        expect(error.message).toBe('ai-extractor-unavailable');
        expect(error.tried).toHaveLength(TIERS.length);
        expect(call).toHaveBeenCalledTimes(TIERS.length);
        expect(trace.every((t) => t.ok === false)).toBe(true);
    });
    it('never throws anything but that one error, whatever the provider throws', async () => {
        for (const thrown of [new Error('x'), 'a string', null, undefined, 42, { message: 'obj' }, Object.assign(new Error('y'), { code: 'ECONNRESET' })]) {
            const err = await tieredAsk({ call: async () => { throw thrown; }, now: () => NOW })('p').catch((e) => e);
            expect(err).toBeInstanceOf(Error); expect(err.message).toBe('ai-extractor-unavailable');
        }
    });
    it('starts no tier it has no time for, and gives each the time that is left', async () => {
        let t = NOW;
        const seen = [];
        const call = vi.fn(async (_p, o) => { seen.push(o.deadlineMs); t += 6000; throw new Error('slow'); });
        const err = await tieredAsk({ call, now: () => t, deadlineAt: NOW + 17000 })('p').catch((e) => e);
        expect(err.message).toBe('ai-extractor-unavailable');
        expect(seen.length).toBeLessThan(TIERS.length);
        seen.forEach((ms, i) => expect(ms).toBeLessThanOrEqual(TIER_MS[i]));
        expect(seen[0]).toBe(16000);              // the strongest providers get the longest
        expect(err.tried.some((x) => x.skipped === 'no-time')).toBe(true);
    });
    it('many questions at once each find their own way down the tiers', async () => {
        const call = vi.fn(async (p, o) => { if (o.engines[0] === 'Groq' && p.includes('hard')) throw new Error('429'); return `{"accounts":[],"for":"${p}","tier":"${o.engines[0]}"}`; });
        const ask = tieredAsk({ call, accept: (r) => Array.isArray(jsonOf(r)?.accounts), now: () => NOW });
        const out = await Promise.all(['easy1', 'hard1', 'easy2', 'hard2'].map(ask));
        expect(out.map((r) => jsonOf(r).tier)).toEqual(['Groq', 'Mistral', 'Groq', 'Mistral']);
    });
    it('a failing trace callback costs nothing', async () => {
        expect(await tieredAsk({ call: async () => ok, now: () => NOW, onTrace: () => { throw new Error('log down'); } })('p')).toBe(ok);
    });
});

describe('invokeExtractor names the providers to ask', () => {
    it('passes the tier and the deadline to the endpoint, and says nothing when no tier is named', async () => {
        const seen = [];
        const fake = async (req, res) => { seen.push(req.body); res.status(200); res.json({ reply: ok }); };
        await invokeExtractor('p', fake, { engines: ['Groq', 'Gemini'], deadlineMs: 5000 });
        await invokeExtractor('p', fake);
        expect(seen[0]).toMatchObject({ engines: ['Groq', 'Gemini'], deadlineMs: 5000, task: 'advice' });
        expect(seen[1].engines).toBeUndefined(); expect(seen[1].deadlineMs).toBe(12000);
    });
});

describe('api/ai.js asks only the providers named, for advice — never for a financial decision', () => {
    const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
    const asked = [];
    const stub = () => {
        vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test'); vi.stubEnv('DEEPSEEK_API_KEY', 'test'); vi.stubEnv('MISTRAL_API_KEY', 'test');
        asked.length = 0;
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            asked.push(String(url));
            if (String(url).includes('googleapis')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: ok }] } }] }) };
            return { ok: true, json: async () => ({ choices: [{ message: { content: ok } }] }) };
        }));
    };
    it('only Groq is called when only Groq is named', async () => {
        stub();
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'read this statement', task: 'advice', engines: ['Groq'] } }, res);
        expect(res.code).toBe(200);
        expect(asked).toHaveLength(1);
        expect(asked[0]).toContain('groq');
    });
    it('names that match no configured provider leave nothing to ask: a clean 503, not a crash', async () => {
        stub();
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'read this statement', task: 'advice', engines: ['Cohere'] } }, res);
        expect(res.code).toBe(503); expect(asked).toHaveLength(0);
    });
    it('junk in the list is ignored; an empty list means everyone, as before', async () => {
        stub();
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'read this statement', task: 'advice', engines: [42, null, {}, 'Nobody'] } }, res);
        expect(res.code).toBe(503);           // 'Nobody' names no provider
        stub();
        const all = response();
        await handler({ method: 'POST', body: { prompt: 'read this statement', task: 'advice', engines: [] } }, all);
        expect(all.code).toBe(200); expect(asked.length).toBe(4);
    });
    it('a financial decision ignores the list: the board is the whole configured roster', async () => {
        stub();
        const res = response();
        await handler({ method: 'POST', body: { prompt: 'classify', financialDecision: true, engines: ['Groq'] } }, res);
        expect(asked.length).toBe(4);
    });
});
