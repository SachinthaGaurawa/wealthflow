import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import handler, { modelBook, resetProviderCooldowns, coolProvider, resetHealthMemory } from '../api/ai.js';
import { resetReasoningLearning } from '../ai-chat.mjs';
import { resetGeminiLearning } from '../gemini-client.mjs';
import { CANARY_GAP_MS, CANARY_PROMPT, redact, reportOf, verdictOf } from '../ai-health.mjs';
import { KEYS, response, failure, world } from './helpers/ai-world.js';

/* THE AI, ASKED ON DEMAND. Reading production logs after the fact is how 101 log LINES were once taken for 101 calls (they were 19). A canary
 * run asks the real engine code ONE small synthetic question, every configured provider, and answers with what each one did. */

beforeEach(() => { resetHealthMemory(); vi.stubEnv('AI_CANARY_DEADLINE_MS', '2000'); });
afterEach(() => { modelBook.reset(); resetProviderCooldowns(); resetReasoningLearning(); resetGeminiLearning(); resetHealthMemory(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const get = async (url) => { const res = response(); await handler({ method: 'GET', url, headers: {} }, res); return res; };

describe('nothing secret leaves in a provider\'s error', () => {
    it('keys in query strings, bearer tokens and long opaque runs are redacted; the message stays readable', () => {
        const key = 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
        expect(redact(`fetch failed https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${key}&alt=json`)).not.toContain(key);
        expect(redact('Authorization: Bearer sk-live-abcdef0123456789abcdef0123456789')).toContain('Bearer [redacted]');
        expect(redact('Groq status 429: ' + 'x'.repeat(40) + ' rate limited')).toContain('[redacted]');
        expect(redact('Mistral status 429: Rate limit exceeded')).toBe('Mistral status 429: Rate limit exceeded');
        expect(redact(null)).toBe(''); expect(redact('a'.repeat(500)).length).toBeLessThanOrEqual(140);
    });
});

describe('reading a report', () => {
    const probe = [{ name: 'A', ok: true, ms: 900, provider: 'a:m', reply: '{"x":1}' }, { name: 'B', ok: false, ms: 120, error: 'B status 429: slow down' }, { name: 'C', ok: true, ms: 400, provider: 'c', reply: '{"x":1}' }];
    it('lists who works and who fails and why, fastest first', () => {
        const r = reportOf({ decision: { unanimous: true, answered: ['A', 'C'], minimumProviders: 5, invalid: [] }, probe, ms: 1000, at: 5 });
        expect(r.providers.map((p) => p.name)).toEqual(['C', 'A', 'B']);
        expect(r.summary).toEqual({ working: ['C', 'A'], failing: ['B: B status 429: slow down'] });
        expect(r.board).toMatchObject({ asked: 3, answered: 2, floor: 5, unanimous: true });
    });
    it('the verdict is one line a person can act on', () => {
        expect(verdictOf(reportOf({ decision: { unanimous: true, answered: ['A', 'B', 'C', 'D', 'E'], minimumProviders: 5 }, probe: new Array(8).fill(0).map((_, i) => ({ name: 'P' + i, ok: i < 5 })) }))).toMatch(/^GOOD — 5 of 8/);
        expect(verdictOf(reportOf({ decision: { unanimous: false, reason: 'provider_disagreement', answered: ['A', 'B', 'C', 'D', 'E'], minimumProviders: 5 }, probe: [] }))).toMatch(/^PROVIDERS FINE, BUT THEY DISAGREE/);
        expect(verdictOf(reportOf({ decision: { unanimous: false, reason: 'insufficient_or_invalid_roster', answered: ['A'], minimumProviders: 5 }, probe }))).toMatch(/^BELOW THE FLOOR — only 1 of 3/);
        expect(verdictOf(null)).toBe('no report yet');
    });
});

describe('GET /api/ai?canary=1', () => {
    it('asks every configured provider ONE synthetic question and says what each did — the production roster of 2026-10-01', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        const res = await get('/api/ai?canary=1');
        expect(res.code).toBe(200);
        expect(res.body).toMatchObject({ ok: true, cached: false, ageSec: expect.any(Number) });
        expect(res.body.verdict).toMatch(/^GOOD/);
        const names = res.body.report.providers.map((p) => p.name);
        for (const n of ['Gemini', 'DeepSeek', 'Groq', 'Ollama', 'Together', 'Fireworks', 'OpenRouterFinance', 'Cerebras', 'NVIDIA', 'GitHubModels', 'Mistral', 'Cohere', 'HF', 'OpenRouterQwen', 'OpenRouterNemotron']) expect(names, n).toContain(n);
        const by = Object.fromEntries(res.body.report.providers.map((p) => [p.name, p]));
        expect(by.Groq.ok).toBe(true);                                         // healed: reasoning budget
        expect(by.GitHubModels.error).toMatch(/non-JSON/);
        expect(by.Mistral.error).toMatch(/429/);
        expect(by.HF.error).toMatch(/402/);
        expect(by.OpenRouterNemotron.error).toMatch(/deadline/);
        expect(res.body.report.board.floor).toBe(5);
        // what the providers were asked is the fixed synthetic prompt — nothing of the owner's
        const sent = w.fetch.mock.calls.map(([, init]) => (init && init.body) || '').join(' ');
        expect(sent).toContain('SUPERMARKET CITY');
    });

    it('ignores cooldowns: a provider resting after a failure is asked anyway, because the point is what it does NOW', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        coolProvider('Groq', new Error('Groq status 429')); coolProvider('HF', new Error('HF status 402: credits'));
        const res = await get('/api/ai?canary=1');
        const names = res.body.report.providers.map((p) => p.name);
        expect(names).toContain('Groq'); expect(names).toContain('HF');
    });

    it('is rate-limited: a report younger than the gap is served and NO provider is called, so the address cannot burn quota', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        const first = await get('/api/ai?canary=1');
        const calls = w.fetch.mock.calls.length;
        expect(calls).toBeGreaterThan(5);
        for (let i = 0; i < 5; i++) { const again = await get('/api/ai?canary=1'); expect(again.body.cached).toBe(true); expect(again.body.report.at).toBe(first.body.report.at); }
        expect(w.fetch.mock.calls.length).toBe(calls);
        // after the gap it runs again
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + CANARY_GAP_MS + 1000);
        const later = await get('/api/ai?canary=1');
        expect(later.body.cached).toBe(false);
        expect(w.fetch.mock.calls.length).toBeGreaterThan(calls);
    });

    it('?health=1 only reads: it never calls a provider, and says so when there is no report', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        const none = await get('/api/ai?health=1');
        expect(none.body).toMatchObject({ ok: true, report: null, verdict: 'no report yet' });
        expect(w.fetch).not.toHaveBeenCalled();
        await get('/api/ai?canary=1');
        const calls = w.fetch.mock.calls.length;
        const read = await get('/api/ai?health=1');
        expect(read.body.report).toBeTruthy(); expect(read.body.cached).toBe(true);
        expect(w.fetch.mock.calls.length).toBe(calls);
    });

    it('a provider error that carries a key is redacted before it leaves', async () => {
        vi.stubEnv('GROQ_API_KEY', 'test');
        const leak = 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
        vi.stubGlobal('fetch', vi.fn(async (url) => (/\/models$/.test(String(url)) ? { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{}' } : failure(500, `upstream said: https://x.example/v1?key=${leak} and Bearer abcdefghijklmnop0123456789`))));
        const res = await get('/api/ai?canary=1');
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(leak); expect(text).not.toContain('abcdefghijklmnop0123456789');
    });

    it('a plain GET, or a POST that asks for detail, gets nothing it should not', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', world().fetch);
        expect((await get('/api/ai')).code).toBe(405);
        expect((await get('/api/ai?other=1')).code).toBe(405);
        const post = response();
        await handler({ method: 'POST', body: { prompt: CANARY_PROMPT, financialDecision: true, mode: 'unanimous', probe: true, __probe: true, deadlineMs: 2000 } }, post);
        expect(post.body.probe).toBeUndefined();                                   // only the endpoint's own canary can ask for the detail
    });

    it('works through the router\'s query shape too (req.query)', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', world().fetch);
        const res = response();
        await handler({ method: 'GET', url: '/api/router?path=ai&canary=1', query: { path: 'ai', canary: '1' }, headers: {} }, res);
        expect(res.code).toBe(200); expect(res.body.report.providers.length).toBeGreaterThan(5);
    });
});
