/* What the production canary showed on 2026-11-12 (4 of 12 answered, floor 5), replayed. Each case is a fault that was seen, with the
 * model names of that day:
 *   · OpenRouterFinance: the ling slug was withdrawn and the replacement "for finance" was thinkingmachines/inkling-2-small, because the
 *     role's first rule was /ling|fin/ and "ling" is inside "inkling". It answered 403 and nothing else was tried.
 *   · OpenRouterNemotron: its 550b default missed the board's deadline on every call while the same list held quicker models.
 *   · three OpenRouter roles choose from ONE account's list: nothing stopped two of them settling on the same model. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import handler, { modelBook, resetProviderCooldowns } from '../api/ai.js';
import { createModelBook, choose } from '../ai-models.mjs';
import { askChat, setAsideSlowModel, SLOW_STRIKES, SLOW_BAD_MS } from '../ai-chat.mjs';

// OpenRouter's free models on 2026-11-12, as its own list named them
const FREE = ['baidu/ernie-5.5-flash-preview:free', 'thinkingmachines/inkling-2-small:free', 'liquid/lfm-3-1.7b:free', 'recursive/flint-v1.0:free',
    'nvidia/nemotron-3.5-super-vl:free', 'dots-studio/dots-3-note-preview:free', 'liquid/lfm-2.5-2.6b:free', 'nvidia/nemotron-3.5-lightning:free',
    'cohere/north-mini-code:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free'].map((id) => ({ id, free: true }));
const LIST = 'https://openrouter.ai/api/v1/models';
const ok = (text) => ({ ok: true, data: { choices: [{ message: { content: text }, finish_reason: 'stop' }] } });
const fail = (status, text = '') => ({ ok: false, status, text });

describe('the finance role is matched as a name, not as letters inside another name', () => {
    it('"inkling" is not "ling": with the ling slug gone the finance role takes a model its rules do name', () => {
        const picked = choose({ provider: 'OpenRouterFinance', models: FREE, exclude: ['inclusionai/ling-3.0-flash-fin:free'] });
        expect(picked).not.toBe('thinkingmachines/inkling-2-small:free');
        expect(picked).toBe('google/gemma-4-26b-a4b-it:free');
    });
    it('a real ling or finance model is still the first choice', () => {
        const models = [...FREE, { id: 'inclusionai/ling-4-flash:free', free: true }];
        expect(choose({ provider: 'OpenRouterFinance', models })).toBe('inclusionai/ling-4-flash:free');
        expect(choose({ provider: 'OpenRouterFinance', models: [...FREE, { id: 'acme/atlas-fin:free', free: true }] })).toBe('acme/atlas-fin:free');
        expect(choose({ provider: 'OpenRouterFinance', models: [...FREE, { id: 'acme/finance-7:free', free: true }] })).toBe('acme/finance-7:free');
    });
    it('a name that only contains the letters is not a finance model', () => {
        for (const id of ['thinkingmachines/inkling-2-small:free', 'nvidia/nemotron-3.5-lightning:free', 'acme/darling-2:free', 'acme/finch-9:free', 'acme/infinity-3:free']) {
            // offered alone with a gemma: the gemma (a rule names it) wins over a name the finance rule must not match
            expect(choose({ provider: 'OpenRouterFinance', models: [{ id, free: true }, { id: 'google/gemma-4-31b-it:free', free: true }] }), id).toBe('google/gemma-4-31b-it:free');
        }
    });
});

describe('a replacement that is refused is followed by the next one', () => {
    const run = (send, book = createModelBook()) => askChat({ name: 'OpenRouterFinance', slot: 'OpenRouterFinance:text', book, defaultModel: 'inclusionai/ling-3.0-flash-fin:free', tokens: 600, send, listKey: LIST, load: async () => [{ id: 'a/first:free', free: true }, { id: 'google/gemma-4-31b-it:free', free: true }, { id: 'meta/llama-3.3-x:free', free: true }] });

    it('replay: the default is withdrawn (404), the first replacement answers 403, the second answers', async () => {
        const asked = [];
        const out = await run(async (model) => { asked.push(model); if (model === 'inclusionai/ling-3.0-flash-fin:free') return fail(404, 'This model is unavailable for free'); if (model === 'meta/llama-3.3-x:free') return fail(403, 'not allowed for this account'); return ok('answer'); });
        expect(asked).toEqual(['inclusionai/ling-3.0-flash-fin:free', 'meta/llama-3.3-x:free', 'google/gemma-4-31b-it:free']);
        expect(out.model).toBe('google/gemma-4-31b-it:free');
    });
    it('a 403 on the model asked FIRST is still the key: nothing else is asked', async () => {
        const asked = [];
        await expect(run(async (model) => { asked.push(model); return fail(403, 'forbidden'); })).rejects.toBeTruthy();
        expect(asked).toEqual(['inclusionai/ling-3.0-flash-fin:free']);
    });
    it('a rate limit or a payment answer on a replacement is not chased', async () => {
        for (const status of [429, 402, 401, 500]) {
            const asked = [];
            await expect(run(async (model) => { asked.push(model); return asked.length === 1 ? fail(404, 'model not found') : fail(status, 'no'); })).rejects.toBeTruthy();
            expect(asked.length, `status ${status}`).toBe(2);
        }
    });
    it('the bound of three replacements holds when every one is refused', async () => {
        const asked = [];
        const many = Array.from({ length: 9 }, (_, i) => ({ id: `x/m${i}:free`, free: true }));
        await expect(askChat({ name: 'OpenRouterFinance', slot: 'OpenRouterFinance:text', book: createModelBook(), defaultModel: 'gone:free', tokens: 600, listKey: LIST, load: async () => many,
            send: async (model) => { asked.push(model); return asked.length === 1 ? fail(404, 'model not found') : fail(403, 'no'); } })).rejects.toBeTruthy();
        expect(asked.length).toBe(4);                                    // the default and three replacements, never more
    });
});

describe('a model that keeps missing the deadline is set aside, and the list is asked for another', () => {
    const SLOT = 'OpenRouterNemotron:text', SLOW = 'nvidia/nemotron-3-ultra-550b-a55b:free';
    it('one miss changes nothing: any model is slow once', () => {
        const book = createModelBook();
        expect(setAsideSlowModel({ book, slot: SLOT, defaultModel: SLOW, strikes: 1, hasList: true })).toBe('');
        expect(book.isBad(SLOT, SLOW)).toBe(false);
    });
    it('the second miss in a row sets the model aside for half an hour, not for good', () => {
        let t = 1_000_000;
        const book = createModelBook({ now: () => t });
        expect(SLOW_STRIKES).toBe(2);
        expect(setAsideSlowModel({ book, slot: SLOT, defaultModel: SLOW, strikes: 2, hasList: true })).toBe(SLOW);
        expect(book.isBad(SLOT, SLOW)).toBe(true);
        expect(setAsideSlowModel({ book, slot: SLOT, defaultModel: SLOW, strikes: 3, hasList: true })).toBe('');   // already aside: not counted twice
        t += SLOW_BAD_MS + 1;
        expect(book.isBad(SLOT, SLOW)).toBe(false);
    });
    it('a provider with no list to choose from keeps its only model', () => {
        const book = createModelBook();
        expect(setAsideSlowModel({ book, slot: 'Cohere:text', defaultModel: 'only-model', strikes: 5, hasList: false })).toBe('');
        expect(book.isBad('Cohere:text', 'only-model')).toBe(false);
    });
    it('the model set aside is the one in use, which may be a remembered replacement', () => {
        const book = createModelBook();
        book.remember(SLOT, 'nvidia/nemotron-3.5-super-vl:free', LIST);
        expect(setAsideSlowModel({ book, slot: SLOT, defaultModel: SLOW, strikes: 2, hasList: true })).toBe('nvidia/nemotron-3.5-super-vl:free');
        expect(book.isBad(SLOT, SLOW)).toBe(false);
    });
    it('replay: after the 550b model is set aside the next call asks the list and takes the quicker Nemotron', async () => {
        const book = createModelBook();
        setAsideSlowModel({ book, slot: SLOT, defaultModel: SLOW, strikes: 2, hasList: true });
        const asked = [];
        const out = await askChat({ name: 'OpenRouterNemotron', slot: SLOT, book, defaultModel: SLOW, tokens: 600, listKey: LIST, load: async () => FREE, send: async (model) => { asked.push(model); return ok('quick'); } });
        expect(asked).toEqual(['nvidia/nemotron-3.5-lightning:free']);   // the slow default is never asked
        expect(out.model).toBe('nvidia/nemotron-3.5-lightning:free');
        expect(book.current(SLOT)).toBe('nvidia/nemotron-3.5-lightning:free');
    });
});

describe('two voters on one model are one voter: roles that share a list never share a model', () => {
    const load = async () => FREE;
    it('a model another role of the same account is using is not offered to this one', async () => {
        const book = createModelBook();
        book.remember('OpenRouterQwen:text', 'baidu/ernie-5.5-flash-preview:free', LIST);
        book.remember('OpenRouterFinance:text', 'google/gemma-4-26b-a4b-it:free', LIST);
        // Qwen's rules name none of the free models, so on its own it would take the newest: the ernie model Qwen already holds
        expect(choose({ provider: 'OpenRouterQwen', models: FREE })).toBe('baidu/ernie-5.5-flash-preview:free');
        const third = await book.replacement({ slot: 'OpenRouterNemotron:text', provider: 'OpenRouterQwen', listKey: LIST, failed: 'x', load });
        expect(third).not.toBe('baidu/ernie-5.5-flash-preview:free');
        expect(third).not.toBe('google/gemma-4-26b-a4b-it:free');
    });
    it('a model just handed to one role is not handed to the next before either has answered', async () => {
        const book = createModelBook();
        const a = await book.replacement({ slot: 'OpenRouterQwen:text', provider: 'OpenRouterQwen', listKey: LIST, failed: 'x', load });
        const b = await book.replacement({ slot: 'OpenRouterFinance:text', provider: 'OpenRouterQwen', listKey: LIST, failed: 'x', load });
        const c = await book.replacement({ slot: 'OpenRouterNemotron:text', provider: 'OpenRouterQwen', listKey: LIST, failed: 'x', load });
        expect(new Set([a, b, c]).size).toBe(3);
    });
    it('a model that failed is free for another role again', async () => {
        const book = createModelBook();
        const a = await book.replacement({ slot: 'OpenRouterQwen:text', provider: 'OpenRouterQwen', listKey: LIST, failed: 'x', load });
        book.markBad('OpenRouterQwen:text', a);
        expect(await book.replacement({ slot: 'OpenRouterFinance:text', provider: 'OpenRouterQwen', listKey: LIST, failed: 'x', load })).toBe(a);
    });
    it('a provider\'s own text and image slots may hold the same model, and so may two different accounts', async () => {
        const book = createModelBook();
        const one = async () => [{ id: 'only/model-vision', free: true }];
        book.remember('Groq:vision', 'only/model-vision', 'Groq');
        expect(await book.replacement({ slot: 'Groq:text', provider: 'OpenRouterQwen', listKey: 'Groq', failed: 'x', load: one })).toBe('only/model-vision');
        book.remember('A:text', 'only/model-vision', 'list-a');
        expect(await book.replacement({ slot: 'B:text', provider: 'OpenRouterQwen', listKey: 'list-b', failed: 'x', load: one })).toBe('only/model-vision');
    });
    it('a role left with nothing stays out instead of doubling a voter', async () => {
        const book = createModelBook();
        const one = async () => [{ id: 'only/one:free', free: true }];
        book.remember('OpenRouterQwen:text', 'only/one:free', LIST);
        expect(await book.replacement({ slot: 'OpenRouterFinance:text', provider: 'OpenRouterFinance', listKey: LIST, failed: 'x', load: one })).toBe('');
    });
    it('the day replayed: the three roles end on three different models that the list names', async () => {
        const book = createModelBook();
        book.remember('OpenRouterQwen:text', 'baidu/ernie-5.5-flash-preview:free', LIST);
        const finance = await book.replacement({ slot: 'OpenRouterFinance:text', provider: 'OpenRouterFinance', listKey: LIST, failed: 'inclusionai/ling-3.0-flash-fin:free', load });
        book.remember('OpenRouterFinance:text', finance, LIST);
        const nemotron = await book.replacement({ slot: 'OpenRouterNemotron:text', provider: 'OpenRouterNemotron', listKey: LIST, failed: 'nvidia/nemotron-3-ultra-550b-a55b:free', load });
        expect([finance, nemotron]).toEqual(['google/gemma-4-26b-a4b-it:free', 'nvidia/nemotron-3.5-lightning:free']);
    });
});

/* ── through the endpoint ─────────────────────────────────────────────────────────────────────────────────────────── */
describe('through the endpoint: a slot whose model keeps missing the deadline moves to a quicker one', () => {
    afterEach(() => { vi.useRealTimers(); modelBook.reset(); resetProviderCooldowns(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
    const request = () => ({ method: 'POST', body: { prompt: 'read this statement', task: 'advice', engines: ['OpenRouterNemotron'], deadlineMs: 2000 } });
    const SLOW = 'nvidia/nemotron-3-ultra-550b-a55b:free';

    it('replay: the 550b model stalls twice, is set aside, and the third call is answered by the quicker Nemotron from the same list', async () => {
        vi.useFakeTimers();
        vi.stubEnv('OPENROUTER_API_KEY', 'test');
        const asked = [];
        let lists = 0;
        vi.stubGlobal('fetch', vi.fn((url, init) => {
            if (String(url).endsWith('/models')) { lists++; return Promise.resolve({ ok: true, json: async () => ({ data: FREE.map((m) => ({ id: m.id, pricing: { prompt: '0', completion: '0' } })) }) }); }
            const model = JSON.parse(init.body).model;
            asked.push(model);
            if (model === SLOW) return new Promise((_, reject) => { if (init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted'))); });   // never answers
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'a quick answer' } }] }), text: async () => '' });
        }));
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        for (let miss = 1; miss <= 2; miss++) {
            const res = response();
            const pending = handler(request(), res);
            await vi.advanceTimersByTimeAsync(2600);
            await pending;
            expect(res.body && res.body.reply, `miss ${miss}`).toBeFalsy();
            expect(modelBook.isBad('OpenRouterNemotron:text', SLOW), `after miss ${miss}`).toBe(miss === 2);
            await vi.advanceTimersByTimeAsync(miss === 1 ? 61_000 : 181_000);   // past the rest a miss earns (one minute, then three): still inside the fifteen minutes that make misses "in a row"
        }
        expect(asked).toEqual([SLOW, SLOW]);
        expect(lists).toBe(0);                                           // a slow model is not a reason to ask the list until it is set aside
        expect(info.mock.calls.some((c) => /"evt":"ai-slow-model"/.test(String(c[0])) && String(c[0]).includes(SLOW))).toBe(true);

        const res = response();
        const pending = handler(request(), res);
        await vi.advanceTimersByTimeAsync(200);
        await pending;
        expect(res.code).toBe(200);
        expect(res.body.reply).toBe('a quick answer');
        expect(asked[2]).toBe('nvidia/nemotron-3.5-lightning:free');
        expect(lists).toBe(1);
    });
});
