/* A provider that cannot answer for a permanent reason is not paid for again on every call, and a provider whose own words
 * say one request takes most of its minute gets a smaller charter. Both come from the probe of 2026-11-07, where Gemini
 * answered 402 and OpenRouter "unavailable for free" on every call, and Groq (Limit 8000, Requested about 6700) failed 11 times. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chat, benchedProviders, _resetBench, permanentReason } from '../wf-llm-router.mjs';
import { withCharter, _resetLearnedTiers, isTightFit, learnedTiers } from '../wf-charter.mjs';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ok = (t) => reply(200, { choices: [{ message: { content: t } }] });

describe('permanentReason names only answers that cannot change within minutes', () => {
    it('payment, refused key and no free model are permanent; rate limits, timeouts and server errors are not', () => {
        expect(permanentReason(402, 'x')).toMatch(/payment/);
        expect(permanentReason(401, 'x')).toMatch(/refused the key/);
        expect(permanentReason(403, 'x')).toMatch(/refused the key/);
        expect(permanentReason(404, 'This model is unavailable for free. The paid version is available now')).toMatch(/no free version/);
        expect(permanentReason(404, 'model not found')).toBe(null);
        expect(permanentReason(429, 'rate limit reached')).toBe(null);
        expect(permanentReason(500, 'oops')).toBe(null);
        expect(permanentReason(undefined, 'Gemini deadline exceeded')).toBe(null);
    });
});

describe('chat() sets a permanently failing provider aside', () => {
    let calls;
    beforeEach(() => { _resetBench(); _resetLearnedTiers(); calls = []; vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
    const env = { GROQ_API_KEY: 'k1', MISTRAL_API_KEY: 'k2' };
    const stubBy = (handlers) => vi.stubGlobal('fetch', async (url) => {
        const id = /groq/.test(url) ? 'groq' : /mistral/.test(url) ? 'mistral' : 'other';
        calls.push(id);
        return handlers[id]();
    });

    it('after a 402 the provider is skipped, with its reason in the log, and the next one answers', async () => {
        stubBy({ groq: () => reply(402, 'payment required'), mistral: () => ok('from mistral') });
        const first = await chat({ prompt: 'hi', only: ['groq', 'mistral'], prefer: [], env, maxTokens: 8 });
        expect(first.provider).toBe('mistral');
        expect(benchedProviders().map((b) => b.provider)).toEqual(['groq']);
        calls.length = 0;
        const second = await chat({ prompt: 'hi', only: ['groq', 'mistral'], env, maxTokens: 8 });
        expect(second.provider).toBe('mistral');
        expect(calls).toEqual(['mistral']);                       // groq was not asked again
        expect(second.attempts.some((a) => a.provider === 'groq' && /skipped: it asks for payment/.test(a.error))).toBe(true);
    });

    it('a rate limit never sets a provider aside', async () => {
        stubBy({ groq: () => reply(429, 'rate limit reached'), mistral: () => ok('m') });
        await chat({ prompt: 'hi', only: ['groq', 'mistral'], env, maxTokens: 8 });
        expect(benchedProviders()).toEqual([]);
        calls.length = 0;
        await chat({ prompt: 'hi', only: ['groq', 'mistral'], env, maxTokens: 8 });
        expect(calls).toContain('groq');
    });

    it('it is asked again after ten minutes, so a paid-up account or a new key is used without a deploy', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
        let groqOk = false;
        stubBy({ groq: () => (groqOk ? ok('g') : reply(401, 'bad key')), mistral: () => ok('m') });
        await chat({ prompt: 'hi', only: ['groq', 'mistral'], env, maxTokens: 8 });
        expect(benchedProviders().length).toBe(1);
        groqOk = true;
        vi.setSystemTime(new Date('2026-11-07T10:05:00Z'));
        expect((await chat({ prompt: 'hi', only: ['groq', 'mistral'], env, maxTokens: 8 })).provider).toBe('mistral');
        vi.setSystemTime(new Date('2026-11-07T10:11:00Z'));
        expect((await chat({ prompt: 'hi', only: ['groq', 'mistral'], env, maxTokens: 8 })).provider).toBe('groq');
        expect(benchedProviders()).toEqual([]);
    });

    it('when every provider is set aside the error still says why', async () => {
        stubBy({ groq: () => reply(402, 'pay'), mistral: () => reply(403, 'no') });
        await expect(chat({ prompt: 'hi', only: ['groq', 'mistral'], env, maxTokens: 8 })).rejects.toThrow(/ALL 2 LLM provider/);
        const err = await chat({ prompt: 'hi', only: ['groq', 'mistral'], env, maxTokens: 8 }).catch((e) => e);
        expect(err.message).toMatch(/skipped: it asks for payment/);
        expect(err.message).toMatch(/skipped: it refused the key/);
    });
});

describe('a request that takes most of a provider\'s minute gets a smaller charter', () => {
    it('isTightFit reads the provider\'s own numbers: more than half the limit, but inside it', () => {
        const m = (l, r) => new Error(`groq: HTTP 429 Rate limit reached on tokens per minute (TPM): Limit ${l}, Used 4000, Requested ${r}.`);
        expect(isTightFit(m(8000, 6723))).toBe(true);
        expect(isTightFit(m(8000, 4001))).toBe(true);
        expect(isTightFit(m(8000, 4000))).toBe(false);           // half exactly leaves room for a second call
        expect(isTightFit(m(8000, 9000))).toBe(false);           // too large: that is isSizeError's case
        expect(isTightFit(m(30000, 3000))).toBe(false);
        expect(isTightFit(new Error('groq: HTTP 429 rate limit reached'))).toBe(false);
        expect(isTightFit(null)).toBe(false);
    });

    it('chat() walks down one size and remembers it, as for a request that is too large', async () => {
        _resetBench(); _resetLearnedTiers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bodies = [];
        let n = 0;
        vi.stubGlobal('fetch', async (url, init) => {
            bodies.push(JSON.parse(init.body));
            return ++n === 1 ? reply(429, '{"error":{"message":"Rate limit reached for model x on tokens per minute (TPM): Limit 8000, Used 5310, Requested 6723."}}') : ok('fits');
        });
        const r = await chat({ system: withCharter('You are Agent 3.', 'author'), prompt: 'hi', only: ['groq'], env: { GROQ_API_KEY: 'k' }, maxTokens: 8 });
        expect(r.text).toBe('fits');
        expect(r.charterTier).toBe('standard');
        expect(learnedTiers()).toEqual({ groq: 'standard' });
        expect(bodies[1].messages[0].content.length).toBeLessThan(bodies[0].messages[0].content.length);
        vi.unstubAllGlobals(); vi.restoreAllMocks();
    });
});

describe('a body that is not JSON rejects with a message that says so (#374)', () => {
    it('readBody keeps rejecting, as Response.json() does, but names the problem and keeps the parser error as cause', async () => {
        const { readBody } = await import('../fetch-timeout.mjs');
        const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('<html>not json')); c.close(); } });
        const response = { body: stream, bodyUsed: false };
        const err = await readBody(response, 'json', 2000).catch((e) => e);
        expect(err).toBeInstanceOf(SyntaxError);
        expect(err.message).toMatch(/not valid JSON \(14 characters\)/);
        expect(err.cause).toBeInstanceOf(SyntaxError);
        const good = { body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":1}')); c.close(); } }), bodyUsed: false };
        expect(await readBody(good, 'json', 2000)).toEqual({ a: 1 });
    });
});
