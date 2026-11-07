/* The charter starts at FULL for every provider. If a provider answers that the request is too large, the same request goes
 * again, to the same provider, one tier lower, and the tier is remembered. Nothing about a provider's limit is guessed. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chat } from '../autonomy/llm-router.mjs';
import { withCharter, _resetLearnedTiers, learnedTiers } from '../wf-charter.mjs';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ok = (t) => reply(200, { choices: [{ message: { content: t } }] });
const env = { GROQ_API_KEY: 'test-key-not-real' };

describe('chat() sends the charter at the size the provider can take', () => {
    let calls;
    beforeEach(() => { _resetLearnedTiers(); calls = []; vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
    let attempt;
    const stub = (handler) => { attempt = 0; vi.stubGlobal('fetch', async (url, init) => { calls.push(JSON.parse(init.body)); return handler(++attempt); }); };
    const sys = () => calls.map((c) => c.messages[0].content);
    const tierOf = (s) => /\[seat=\w+ tier=(\w+)\]/.exec(s)[1];
    const ask = (system) => chat({ system, prompt: 'hi', only: ['groq'], env, maxTokens: 8 });

    it('goes out at full when the provider takes it', async () => {
        stub(() => ok('fine'));
        const r = await ask(withCharter('You are Agent 3.', 'author'));
        expect(r.text).toBe('fine');
        expect(r.charterTier).toBe('full');
        expect(tierOf(sys()[0])).toBe('full');
        expect(sys()[0].length).toBeGreaterThan(25000);
    });

    it('a "request too large" answer sends the same request one tier lower, to the same provider, and remembers it', async () => {
        stub((n) => (n === 1 ? reply(413, '{"error":{"message":"Request too large for model"}}') : ok('now fine')));
        const r = await ask(withCharter('You are Agent 3.', 'author'));
        expect(r.text).toBe('now fine');
        expect(r.charterTier).toBe('standard');
        expect(calls.length).toBe(2);
        expect(tierOf(sys()[0])).toBe('full');
        expect(tierOf(sys()[1])).toBe('standard');
        expect(sys()[1].endsWith('You are Agent 3.')).toBe(true);
        expect(calls[1].messages[1].content).toBe('hi');
        expect(learnedTiers()).toEqual({ groq: 'standard' });
        // the next call does not pay for the failure again
        calls.length = 0; attempt = 1;
        await ask(withCharter('You are Agent 3.', 'author'));
        expect(calls.length).toBe(1);
        expect(tierOf(sys()[0])).toBe('standard');
    });

    it('a per-minute allowance smaller than the request walks down to core, and stops there', async () => {
        const tpm = 'Rate limit reached for model llama on tokens per minute (TPM): Limit 6000, Used 0, Requested 9000.';
        stub((n) => (n <= 2 ? reply(429, tpm) : ok('core fits')));
        const r = await ask(withCharter('You are Agent 3.', 'author'));
        expect(r.charterTier).toBe('core');
        expect(calls.map((c) => tierOf(c.messages[0].content))).toEqual(['full', 'standard', 'core']);
    });

    it('a size answer at core is a real failure and surfaces; a plain busy answer never shrinks the charter', async () => {
        stub(() => reply(413, 'too big'));
        await expect(ask(withCharter('x', 'author'))).rejects.toThrow(/413/);
        expect(calls.length).toBe(3);

        calls.length = 0; _resetLearnedTiers();
        stub(() => reply(429, 'rate limit reached, try later'));
        await expect(ask(withCharter('x', 'author'))).rejects.toThrow(/429/);
        expect(calls.length).toBe(1);
        expect(learnedTiers()).toEqual({});
    });

    it('a prompt with no charter is sent untouched, and the env cap is honoured', async () => {
        stub(() => ok('plain'));
        await ask('You are a plain system prompt.');
        expect(sys()[0]).toBe('You are a plain system prompt.');
        calls.length = 0;
        await chat({ system: withCharter('You are Agent 3.', 'author'), prompt: 'hi', only: ['groq'], env: { ...env, WF_CHARTER_TIER_GROQ: 'standard' }, maxTokens: 8 });
        expect(tierOf(sys()[0])).toBe('standard');
    });
});
