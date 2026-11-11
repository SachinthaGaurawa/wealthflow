import { describe, it, expect } from 'vitest';
import { assess, classify, reportBody, run, BOARD_LABEL } from '../autonomy/board-watch.mjs';

// the shape the live canary answered on 2026-11-11 (provider names are the roster's; the error texts are shortened)
const live = () => ({ ok: true, report: { board: { asked: 12, answered: 4, floor: 5 }, providers: [
    { name: 'Groq', ok: true }, { name: 'DeepSeek', ok: true }, { name: 'Fireworks', ok: true }, { name: 'Cohere', ok: true },
    { name: 'GitHubModels', ok: false, error: 'GitHubModels returned non-JSON (HTTP 200): "OK" {text/plain; models.github.ai} [token GH_PAT, fine-grained]' },
    { name: 'Ollama', ok: false, error: 'Ollama status 402: {"error":"Add usage credits or subscribe"}' },
    { name: 'NVIDIA', ok: false, error: 'NVIDIA status 410: Gone [tried a→410, b→404]' },
    { name: 'Mistral', ok: false, error: 'Mistral status 429: {"message":"Rate limit exceeded"}' },
    { name: 'OpenRouterFinance', ok: false, error: 'OpenRouterFinance status 404: no longer available' },
    { name: 'Gemini', ok: false, error: 'Gemini status 402: Your prepayment credits are depleted' },
    { name: 'OpenRouterNemotron', ok: false, error: 'Provider response deadline exceeded' },
    { name: 'Odd', ok: false, error: 'Something else entirely' },
] } });

describe('the board watch', () => {
    it('names each failure by kind and nothing else', () => {
        expect(classify('Ollama status 402: Add usage credits')).toBe('credits');
        expect(classify('Gemini status 402: prepayment credits are depleted')).toBe('credits');
        expect(classify('Mistral status 429: Rate limit exceeded')).toBe('rate-limit');
        expect(classify('NVIDIA status 410: end of life')).toBe('model-gone');
        expect(classify('X status 404: not found')).toBe('model-gone');
        expect(classify('GitHubModels returned non-JSON (HTTP 200): "OK"')).toBe('bad-reply');
        expect(classify('Provider response deadline exceeded')).toBe('too-slow');
        expect(classify('Groq status 401: invalid api key')).toBe('key');
        expect(classify('Groq key not configured')).toBe('key');
        expect(classify('???')).toBe('other');
    });
    it('four of twelve with a floor of five is below the floor', () => {
        const a = assess(live());
        expect(a).toMatchObject({ ok: true, below: true, answered: 4, asked: 12, floor: 5 });
        expect(a.working).toEqual(['Groq', 'DeepSeek', 'Fireworks', 'Cohere']);
        expect(a.failing.find(f => f.name === 'Ollama')).toEqual({ name: 'Ollama', kind: 'credits' });
        const healthy = live(); healthy.report.board.answered = 6;
        expect(assess(healthy).below).toBe(false);
    });
    it('an unreadable canary is not a verdict', () => {
        expect(assess({}).ok).toBe(false);
        expect(assess(null).ok).toBe(false);
    });
    it('the issue splits what only a person can fix from what the fix agent can, and holds no error text or long number', () => {
        const body = reportBody(assess(live()));
        expect(body).toMatch(/Only a person can fix[\s\S]*- Ollama: credits[\s\S]*- Mistral: rate-limit[\s\S]*- Gemini: credits/);
        expect(body).toMatch(/The fix agent can fix[\s\S]*- GitHubModels: bad-reply[\s\S]*- NVIDIA: model-gone[\s\S]*- OpenRouterNemotron: too-slow/);
        expect(body).not.toMatch(/\d{4,}/);
        expect(body).not.toMatch(/GH_PAT|prepayment|Add usage/i);
        expect(body).toContain('never lower the floor of five');
    });
});

const calls = [];
const fetchWith = (canary, open = []) => async (url, init = {}) => {
    calls.push([init.method || 'GET', String(url).replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '')]);
    const reply = (body, ok = true) => ({ ok, json: async () => body });
    if (String(url).includes('canary=1')) return reply(canary);
    if (String(url).includes('/issues?state=open')) return reply(open);
    if (init.method === 'POST' && /\/issues$/.test(String(url))) return reply({ number: 77 });
    return reply({});
};

describe('what the watch does about it', () => {
    it('files one issue when the board is below its floor', async () => {
        calls.length = 0;
        const out = await run({ url: 'https://x/api/ai?canary=1', token: 't', repo: 'o/r', fetchImpl: fetchWith(live()) });
        expect(out).toMatchObject({ action: 'filed', issue: 77 });
        expect(calls.some(([m, p]) => m === 'POST' && p === '/issues')).toBe(true);
    });
    it('does not file a second one while one is open', async () => {
        calls.length = 0;
        const out = await run({ url: 'https://x/api/ai?canary=1', token: 't', repo: 'o/r', fetchImpl: fetchWith(live(), [{ number: 5 }]) });
        expect(out).toMatchObject({ action: 'already-open', issue: 5 });
        expect(calls.some(([m]) => m === 'POST')).toBe(false);
    });
    it('closes the issue when the board is back above its floor', async () => {
        calls.length = 0;
        const good = live(); good.report.board.answered = 7;
        const out = await run({ url: 'https://x/api/ai?canary=1', token: 't', repo: 'o/r', fetchImpl: fetchWith(good, [{ number: 5 }]) });
        expect(out).toMatchObject({ action: 'closed', issue: 5 });
        expect(calls).toContainEqual(['PATCH', '/issues/5']);
    });
    it('a dry run, or no token, files nothing and says what it would do', async () => {
        calls.length = 0;
        expect((await run({ url: 'https://x/api/ai?canary=1', dryRun: true, fetchImpl: fetchWith(live()) })).action).toBe('would-file');
        expect((await run({ url: 'https://x/api/ai?canary=1', fetchImpl: fetchWith(live()) })).action).toBe('would-file');
        expect(calls.every(([m]) => m === 'GET')).toBe(true);
    });
    it('never throws: an unreachable canary or a failing network is a plain answer', async () => {
        expect((await run({ url: 'https://x', fetchImpl: async () => ({ ok: false }) })).action).toBe('canary-unreachable');
        expect((await run({ url: 'https://x', fetchImpl: async () => { throw new Error('down'); } })).action).toBe('error');
        expect(BOARD_LABEL).toBe('ai-board-health');
    });
});
