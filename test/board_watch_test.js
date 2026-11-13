import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { assess, classify, reportBody, run, triedChain, KEY_OF, BOARD_LABEL } from '../autonomy/board-watch.mjs';
import { OWNERS_HEADING, ownerFiles } from '../autonomy/reach.mjs';

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
        expect(classify('Acme returned non-JSON (HTTP 200): "<html>busy</html>"')).toBe('bad-reply');
        expect(classify('Provider response deadline exceeded')).toBe('too-slow');
        expect(classify('Groq status 401: invalid api key')).toBe('key');
        expect(classify('Groq key not configured')).toBe('key');
        expect(classify('???')).toBe('other');
    });
    it('four of twelve with a floor of five is below the floor', () => {
        const a = assess(live());
        expect(a).toMatchObject({ ok: true, below: true, answered: 4, asked: 12, floor: 5 });
        expect(a.working).toEqual(['Groq', 'DeepSeek', 'Fireworks', 'Cohere']);
        expect(a.failing.find(f => f.name === 'Ollama')).toEqual({ name: 'Ollama', kind: 'credits', tried: [] });
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
        expect(body).toMatch(/The fix agent can fix[\s\S]*- NVIDIA: model-gone[\s\S]*- OpenRouterNemotron: too-slow/);
        expect(body.replace(/`[^`]*`/g, '')).not.toMatch(/\d{4,}/);            // outside the quoted names of models and variables, no long number
        expect(body).not.toMatch(/prepayment|Add usage|fine-grained|text\/plain/i);
        expect(body).toContain('Never lower the floor of five');
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
        const out = await run({ url: 'https://x/api/ai?canary=1', token: 't', repo: 'o/r', fetchImpl: fetchWith(live(), [{ number: 5, body: reportBody(assess(live())) }]) });
        expect(out).toMatchObject({ action: 'already-open', issue: 5 });
        expect(calls.some(([m]) => m === 'POST' || m === 'PATCH')).toBe(false);
    });
    it('an open report whose text is no longer true is replaced, not left and not filed twice', async () => {
        calls.length = 0;
        const out = await run({ url: 'https://x/api/ai?canary=1', token: 't', repo: 'o/r', fetchImpl: fetchWith(live(), [{ number: 5, body: 'what was true yesterday' }]) });
        expect(out).toMatchObject({ action: 'updated', issue: 5 });
        expect(calls).toContainEqual(['PATCH', '/issues/5']);
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

/* ── 2026-11-12, 18:46Z: what the production canary really said, and what each line means ───────────────────────────── */
const day = () => ({ ok: true, report: { board: { asked: 12, answered: 4, floor: 5 }, providers: [
    { name: 'DeepSeek', ok: true }, { name: 'Groq', ok: true }, { name: 'Fireworks', ok: true }, { name: 'OpenRouterQwen', ok: true },
    { name: 'GitHubModels', ok: false, error: 'GitHubModels returned non-JSON (HTTP 200): "OK" {text/plain; models.github.ai} [token GH_PAT, fine-grained]' },
    { name: 'Cohere', ok: false, error: 'Cohere status 429' },
    { name: 'Ollama', ok: false, error: 'Ollama status 402: {"error":"Add usage credits or subscribe"}' },
    { name: 'Mistral', ok: false, error: 'Mistral status 429: {"message":"Rate limit exceeded"}' },
    { name: 'NVIDIA', ok: false, error: 'NVIDIA status 410: {"title":"Gone","detail":"The model has reached its end of life"} [tried meta/llama-3.1-8b-instruct→410, nvidia/llama-3.1-nemotron-70b-instruct→404, nvidia/llama-3.1-nemotron-ultra-253b-v1→404, nvidia/nemotron-3-super-120b-a12b→404]' },
    { name: 'OpenRouterFinance', ok: false, error: 'OpenRouterFinance status 404: {"error":{"message":"This model is unavailable for free."}}, [tried inclusionai/ling-3.0-flash-fin:free→404, thinkingmachines/inkling-2-small:free→403]' },
    { name: 'Gemini', ok: false, error: 'Gemini status 402: Your prepayment credits are depleted' },
    { name: 'OpenRouterNemotron', ok: false, error: 'Provider response deadline exceeded' },
] } });

describe('the report says whose each failure is, and gives the fix agent what it needs to act', () => {
    it('a bare OK in place of a completion is a service that is no longer there: not a key, and not a reply the code can repair', () => {
        // 2026-11-12 this was called "the token". GitHub ended GitHub Models on 2026-07-30 (docs.github.com/en/github-models): no token could help.
        expect(classify('GitHubModels returned non-JSON (HTTP 200): "OK" {text/plain; models.github.ai} [token GH_PAT, fine-grained]')).toBe('service-gone');
        expect(classify('Together returned non-JSON (HTTP 200): "<html>busy</html>"')).toBe('bad-reply');      // any other non-JSON is still the code's to look at
        expect(KEY_OF.GitHubModels).toBeUndefined();                                                            // nobody is sent to a variable that cannot help
    });
    it('a default and three replacements all "not found" is the account; one retired name is still the code\'s', () => {
        const nvidia = day().report.providers.find(p => p.name === 'NVIDIA').error;
        expect(classify(nvidia)).toBe('account-has-no-model');
        expect(classify('NVIDIA status 410: Gone [tried a→410, b→404]')).toBe('model-gone');
        expect(classify('X status 404: gone [tried a→404, b→404, c→404, d→429]')).toBe('model-gone');   // the last one was busy, not gone
    });
    it('reads the models asked for: names and status numbers, nothing else', () => {
        expect(triedChain('x [tried inclusionai/ling-3.0-flash-fin:free→404, thinkingmachines/inkling-2-small:free→403]')).toEqual([
            { model: 'inclusionai/ling-3.0-flash-fin:free', status: 404 }, { model: 'thinkingmachines/inkling-2-small:free', status: 403 }]);
        expect(triedChain('no chain here')).toEqual([]);
        expect(triedChain('[tried a b"<script>→404]')[0].model).toBe('abscript');
    });
    it('the day replayed: six for a person (each with its Vercel variable), two for the fix agent (each with the models it was asked for)', () => {
        const body = reportBody(assess(day()));
        const [, person, agent] = /Only a person can fix[^\n]*\n([\s\S]*?)\n\n### The fix agent can fix[^\n]*\n([\s\S]*?)\n\n###/.exec(body);
        expect(person.split('\n').map(l => l.split(':')[0])).toEqual(['- GitHubModels', '- Cohere', '- Ollama', '- Mistral', '- NVIDIA', '- Gemini']);
        expect(person).toMatch(/GitHubModels: service-gone/); expect(person).not.toContain('GH_PAT'); expect(person).toContain('RETIRED_SERVICES');
        expect(person).toContain('`NVIDIA_API_KEY`'); expect(person).toContain('`GEMINI_API_KEY`'); expect(person).toContain('`COHERE_API_KEY`');
        expect(person).toMatch(/NVIDIA: account-has-no-model/);
        expect(agent.split('\n').map(l => l.split(':')[0])).toEqual(['- OpenRouterFinance', '- OpenRouterNemotron']);
        expect(agent).toContain('`thinkingmachines/inkling-2-small:free` → 403');
        expect(body).not.toMatch(/prepayment|Add usage|fine-grained|end of life|unavailable for free/i);   // never the provider's own words
    });
    it('the report says where the code is, under the heading the fix agent reads, and names only files that exist', () => {
        const body = reportBody(assess(day()));
        expect(body).toContain('### ' + OWNERS_HEADING);
        expect(ownerFiles(body, { exists: (f) => fs.existsSync(f) })).toEqual(['ai-models.mjs', 'ai-chat.mjs']);
    });
    it('every provider the endpoint reads a key for has its variable named here, spelled as the endpoint spells it', () => {
        const endpoint = fs.readFileSync('api/ai.js', 'utf8');
        for (const [provider, variable] of Object.entries(KEY_OF)) expect(endpoint, provider).toContain('process.env.' + variable);
    });
});
