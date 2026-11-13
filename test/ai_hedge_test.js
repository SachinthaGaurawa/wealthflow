/* Production, 2026-11-13 08:42Z and 08:44Z, after the in-flight rule shipped: OpenRouterFinance and OpenRouterNemotron each ran into the
 * board's 13-second deadline on a cold serverless instance. The model was set aside by name (the log said so) but the next call landed on
 * another instance with an empty memory and stalled the same way, so the board sat at 4 of 11 (floor 5). A request still out after
 * HEDGE_MS is now asked of a second model too, and the first usable answer wins. These cases replay that with the model names of the day. */
import { describe, it, expect } from 'vitest';
import { createModelBook } from '../ai-models.mjs';
import { askChat, setAsideSlowModel, HEDGE_MS, SLOW_BAD_MS } from '../ai-chat.mjs';

const LIST = 'https://openrouter.ai/api/v1/models';
const MODELS = ['nvidia/nemotron-3.5-lightning:free', 'google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free', 'baidu/ernie-5.5-flash-preview:free'].map((id) => ({ id, free: true }));
const ok = (text) => ({ ok: true, data: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const never = () => new Promise(() => {});
const run = (send, extra = {}) => {
    const book = extra.book || createModelBook();
    const logs = [];
    const promise = askChat({ name: 'OpenRouterFinance', slot: 'OpenRouterFinance:text', book, defaultModel: 'nvidia/nemotron-3.5-lightning:free', tokens: 600, listKey: LIST, load: extra.load === undefined ? async () => MODELS : extra.load, send, hedgeMs: extra.hedgeMs === undefined ? 30 : extra.hedgeMs, log: (l) => logs.push(l) });
    return { book, logs, promise };
};

describe('a request that is still out after the hedge time is asked of a second model too', () => {
    it('the default is slow, the second model answers first: its answer is the board\'s, and the slow one is set aside', async () => {
        const asked = [];
        const { book, logs, promise } = run(async (model) => { asked.push(model); return /lightning/.test(model) ? never() : later(10, ok('answer')); });
        const out = await promise;
        expect(asked[0]).toBe('nvidia/nemotron-3.5-lightning:free');
        expect(asked.length).toBe(2);
        expect(out.text).toBe('answer');
        expect(out.model).not.toBe('nvidia/nemotron-3.5-lightning:free');
        expect(book.isBad('OpenRouterFinance:text', 'nvidia/nemotron-3.5-lightning:free')).toBe(true);
        expect(book.current('OpenRouterFinance:text')).toBe(out.model);
        expect(logs.some((l) => /"evt":"ai-hedge"/.test(l) && /lightning/.test(l))).toBe(true);
    });
    it('the default answers a little after the hedge was sent: the default wins and is NOT set aside for having been hedged', async () => {
        const asked = [];
        const { book, promise } = run(async (model) => { asked.push(model); return /lightning/.test(model) ? later(60, ok('slow but right')) : never(); });
        const out = await promise;
        expect(asked.length).toBe(2);
        expect(out.model).toBe('nvidia/nemotron-3.5-lightning:free');
        expect(book.isBad('OpenRouterFinance:text', 'nvidia/nemotron-3.5-lightning:free')).toBe(false);
        expect(book.current('OpenRouterFinance:text')).toBe('nvidia/nemotron-3.5-lightning:free');
    });
    it('an answer inside the hedge time asks nobody else', async () => {
        const asked = [];
        const { promise } = run(async (model) => { asked.push(model); return later(5, ok('fast')); });
        await promise;
        expect(asked).toEqual(['nvidia/nemotron-3.5-lightning:free']);
    });
    it('a provider that cannot list its models is never hedged', async () => {
        const asked = [];
        const { promise } = run(async (model) => { asked.push(model); return later(80, ok('late')); }, { load: null });
        await promise;
        expect(asked.length).toBe(1);
    });
    it('hedgeMs 0 turns it off', async () => {
        const asked = [];
        const { promise } = run(async (model) => { asked.push(model); return later(60, ok('late')); }, { hedgeMs: 0 });
        await promise;
        expect(asked.length).toBe(1);
    });
    it('the second model is never the slow one, nor one another role of the account holds', async () => {
        const book = createModelBook();
        book.remember('OpenRouterQwen:text', 'google/gemma-4-26b-a4b-it:free', LIST);   // another role holds the first gemma
        const asked = [];
        const { promise } = run(async (model) => { asked.push(model); return /lightning/.test(model) ? never() : later(5, ok('answer')); }, { book });
        await promise;
        expect(asked).not.toContain('google/gemma-4-26b-a4b-it:free');
        expect(asked.filter((m) => m === 'nvidia/nemotron-3.5-lightning:free').length).toBe(1);
    });
    it('both stall: the deadline finds both in flight and sets both aside', async () => {
        const book = createModelBook();
        const { promise } = run(async () => never(), { book });
        promise.catch(() => {});
        await later(90, null);
        expect(book.flyingAll('OpenRouterFinance:text').length).toBe(2);
        const aside = setAsideSlowModel({ book, slot: 'OpenRouterFinance:text', defaultModel: 'nvidia/nemotron-3.5-lightning:free', strikes: 1, hasList: true });
        expect(aside.split(', ').length).toBe(2);
        for (const id of book.badList('OpenRouterFinance:text')) expect(id).toBeTruthy();
        expect(book.isBad('OpenRouterFinance:text', 'nvidia/nemotron-3.5-lightning:free')).toBe(true);
    });
    it('a network failure on the first request before the hedge time is passed on as before', async () => {
        const { promise } = run(async () => { throw new Error('network down'); });
        await expect(promise).rejects.toThrow('network down');
    });
    it('the real hedge time is 5 seconds, inside the board\'s 13', () => {
        expect(HEDGE_MS).toBe(5000);
        expect(SLOW_BAD_MS).toBe(30 * 60 * 1000);
    });
});

describe('through the endpoint: the canary of a board whose Nemotron role never answers', () => {
    it('with the board\'s real 13-second deadline the role is hedged at 5 s, answers on another model, and the board gets its fifth voter', async () => {
        const { vi: v, afterEach: after } = await import('vitest');
        const { default: handler, modelBook, resetProviderCooldowns, resetHealthMemory } = await import('../api/ai.js');
        const { KEYS, response, world } = await import('./helpers/ai-world.js');
        const { CANARY_ROWS } = await import('../ai-health.mjs');
        resetHealthMemory();
        v.stubEnv('AI_CANARY_DEADLINE_MS', '13000');
        for (const key of KEYS) v.stubEnv(key, 'test');
        const gold = JSON.stringify({ decisions: CANARY_ROWS.map((row, index) => ({ index, module: row.module, category: row.category, allocationId: '' })) });
        const w = world({ answer: gold });
        const info = v.spyOn(console, 'info').mockImplementation(() => {});
        try {
            v.stubGlobal('fetch', w.fetch);
            const res = response();
            const pending = handler({ method: 'GET', url: '/api/ai?canary=1', headers: {} }, res);
            await pending;
            const nemotron = res.body.report.providers.find((p) => p.name === 'OpenRouterNemotron');
            expect(nemotron.ok, JSON.stringify(nemotron)).toBe(true);
            expect(String(nemotron.model || nemotron.provider)).not.toMatch(/nemotron-3/);
            const asked = w.log.filter((c) => /nemotron/.test(c.model)).length;
            expect(asked).toBe(1);                                         // the stalled one was asked once, not again
            expect(info.mock.calls.some((c) => /"evt":"ai-hedge"/.test(String(c[0])) && /nemotron/.test(String(c[0])))).toBe(true);
        } finally { info.mockRestore(); modelBook.reset(); resetProviderCooldowns(); resetHealthMemory(); v.unstubAllEnvs(); v.unstubAllGlobals(); }
    }, 25000);
});
