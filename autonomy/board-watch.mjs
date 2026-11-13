/* =============================================================================
 * autonomy/board-watch.mjs — the system notices, by itself, that its AI board cannot meet its own floor
 * -----------------------------------------------------------------------------
 * WHY. On 2026-11-11 the production board had four of twelve providers answering and a floor of five: every statement row that needed the
 * board fell back to the rules ("Other"), the "category gap" the owner kept seeing, and nothing said so. The causes were ordinary (two
 * providers out of credit, one rate-limited, three retired free models, one token) and the board's own canary (`GET /api/ai?canary=1`)
 * had been saying it all along. Nobody reads a canary nobody is told to read.
 *
 * WHAT. Once a day this reads the canary, names each failing provider by KIND (credits, rate limit, model gone, bad reply, too slow, key)
 * and files ONE issue when the board is below its floor, closing it again when the board recovers. Kinds that only a person can fix
 * (credits, a key, a provider's own rate limit) are marked owner-only; the others are the fix agent's (a retired model name, a reply that is
 * not JSON, a provider that is too slow). The issue holds provider names and kinds, never an error text or a key (public repository).
 *
 * Pure `assess`, `classify`, `reportBody`; `run` is the only door to the network and takes it injected.
 *   node autonomy/board-watch.mjs --url https://www.wealthflow.lk/api/ai?canary=1 [--dry-run]
 * ===========================================================================*/

import { OWNERS_HEADING } from './reach.mjs';

export const BOARD_LABEL = 'ai-board-health';
const OWNER_ONLY = new Set(['credits', 'rate-limit', 'key', 'service-gone', 'account-has-no-model']);

/* THE VERCEL VARIABLE BEHIND EACH PROVIDER (api/ai.js). The owner is told the exact name, never asked to look for it. A test keeps this
 * list equal to the names api/ai.js reads. */
export const KEY_OF = Object.freeze({
    Gemini: 'GEMINI_API_KEY', DeepSeek: 'DEEPSEEK_API_KEY', Ollama: 'OLLAMA_API_KEY', Groq: 'GROQ_API_KEY', Mistral: 'MISTRAL_API_KEY', Together: 'TOGETHER_API_KEY',
    Fireworks: 'FIREWORKS_API_KEY', NVIDIA: 'NVIDIA_API_KEY', Cohere: 'COHERE_API_KEY',
    OpenRouterFinance: 'OPENROUTER_API_KEY', OpenRouterQwen: 'OPENROUTER_API_KEY', OpenRouterNemotron: 'OPENROUTER_API_KEY',
});
/** What a person does for each owner-only kind, in one clause. */
const OWNER_STEP = Object.freeze({
    'credits': 'the provider account is out of credit: add credit, or replace the key with one from an account that has some',
    'rate-limit': 'the provider\'s own limit for this key: wait, or move the key to a plan with a higher limit',
    'key': 'the provider refused the key: replace it',
    'service-gone': 'the address answers a bare "OK" and no completion: the provider no longer serves this API there (GitHub Models answered exactly this after GitHub ended that service). No key repairs it. Read the provider\'s own page; if the service has ended it is taken off the board in `ai-models.mjs` (RETIRED_SERVICES)',
    'account-has-no-model': 'the provider answered "not found" for its default model and for every replacement from its own list: the account behind the key can call none of them. Check the account, or replace the key',
});

/** The models a provider was asked for in one call, as the endpoint lists them: "a→410, b→404". Model names and status numbers only. */
export function triedChain(error) {
    const m = /\[tried ([^\]]{1,600})\]/.exec(String(error == null ? '' : error));
    if (!m) return [];
    return m[1].split(',').map((part) => {
        const [model, status] = part.trim().split('→');
        return { model: String(model || '').replace(/[^A-Za-z0-9._:/@-]/g, '').slice(0, 80), status: /^\d{3}$/.test(String(status || '').trim()) ? Number(String(status).trim()) : 0 };
    }).filter((t) => t.model).slice(0, 6);
}

/** What kind of failure is this provider's error text? Only the kind is ever kept. */
export function classify(error) {
    const text = String(error == null ? '' : error);
    if (/status 402|credits|prepayment|billing|subscribe/i.test(text)) return 'credits';
    if (/status 429|rate.?limit|too many requests|quota/i.test(text)) return 'rate-limit';
    /* HTTP 200 with the bare word OK as plain text is not an answer a parser can repair, and it is not a key either. GitHub Models gave it
     * to every request, with a token or without, from the day GitHub ended the service (2026-07-30, docs.github.com/en/github-models); this
     * watch called it "the token" on 2026-11-12, which was a guess and was wrong. It is a person's to read the provider's own page. */
    if (/non-JSON \(HTTP 200\): "OK"/i.test(text)) return 'service-gone';
    if (/non-JSON/i.test(text)) return 'bad-reply';
    /* The default model AND every replacement from the provider's own list answered "gone" (three or more of them). One retired name is
     * the code's to heal, and it did try: when nothing the list names can be called, it is the account (NVIDIA, 2026-11-12: eight models
     * from four publishers, in the app and in the pipeline, every one "not found"). */
    const tried = triedChain(text);
    if (tried.length >= 4 && tried.every((t) => t.status === 404 || t.status === 410)) return 'account-has-no-model';
    if (/deadline|timed? ?out|timeout|abort/i.test(text)) return 'too-slow';
    if (/status 40[134]|status 410|status 404|end of life|no longer available|unavailable for free|not found/i.test(text) && !/status 401|status 403/i.test(text)) return 'model-gone';
    if (/status 40[13]|key not configured|unauthori[sz]ed|forbidden|invalid.*key|token/i.test(text)) return 'key';
    return 'other';
}

/** @returns {{ ok:boolean, below:boolean, answered:number, asked:number, floor:number, working:string[], failing:{name:string,kind:string}[] }} */
export function assess(canary) {
    const board = (canary && canary.report && canary.report.board) || {};
    const providers = Array.isArray(canary && canary.report && canary.report.providers) ? canary.report.providers : [];
    const answered = Number.isFinite(board.answered) ? board.answered : providers.filter(p => p && p.ok).length;
    const floor = Number.isFinite(board.floor) ? board.floor : 5;
    const asked = Number.isFinite(board.asked) ? board.asked : providers.length;
    const name = (p) => String((p && p.name) || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
    return {
        ok: !!(canary && canary.ok !== false && providers.length),
        below: answered < floor, answered, asked, floor,
        working: providers.filter(p => p && p.ok).map(name),
        failing: providers.filter(p => p && !p.ok).map(p => ({ name: name(p), kind: classify(p.error), tried: triedChain(p.error) })),
    };
}

export function reportBody(a) {
    const owner = a.failing.filter(f => OWNER_ONLY.has(f.kind)), agent = a.failing.filter(f => !OWNER_ONLY.has(f.kind));
    const chain = f => (f.tried && f.tried.length ? ' (asked for ' + f.tried.map(t => '`' + t.model + '` → ' + (t.status || '?')).join(', ') + ')' : '');
    const line = f => '- ' + f.name + ': ' + f.kind + chain(f);
    const ownerLine = f => '- ' + f.name + ': ' + f.kind + (KEY_OF[f.name] ? ' · Vercel variable `' + KEY_OF[f.name] + '`' : '') + (OWNER_STEP[f.kind] ? ' · ' + OWNER_STEP[f.kind] : '');
    return [
        '## AI board health: below its floor',
        '',
        '**Answering:** ' + a.answered + ' of ' + a.asked + '  ·  **Floor:** ' + a.floor + '  ·  **Working:** ' + (a.working.join(', ') || 'none'),
        '',
        'While the board is below its floor, every statement row that needs it keeps the rules\' answer (often "Other"), so categories stay generic. Found by the daily board watch, with nobody asking.',
        '',
        '### Only a person can fix (provider credits, a key or token, an account, a provider\'s own rate limit)',
        owner.length ? owner.map(ownerLine).join('\n') : '- none',
        '',
        '### The fix agent can fix (a retired model name, a reply that is not JSON, a provider that is too slow)',
        agent.length ? agent.map(line).join('\n') : '- none',
        '',
        '### What to do',
        'Fix agent: for each provider in the second list, find why it fails and change the code. The models each one was asked for are listed beside it: a name that was chosen wrongly points at the rules that choose (`choose` and its preference lists), a model that is too slow at the default it starts from. Never lower the floor of five and never add a majority path (two working providers that run the same model are one voter, so fewer voters are weaker than they look). Owner: the first list, by the Vercel variable named beside each.',
        '',
        '### ' + OWNERS_HEADING + '',
        '- `ai-models.mjs`: which model each provider is asked for, and how a replacement is chosen from the provider\'s own list',
        '- `ai-chat.mjs`: how one provider is asked, and asked again when a model is gone, empty or refused',
        '',
        'The endpoint itself (the provider keys and the deadline) is outside the agent\'s reach and is not listed.',
        '',
        '_Filed automatically; provider names, kinds, model names and status numbers only, never an error text or a key. It closes itself when the board is back above its floor._',
    ].join('\n');
}

/**
 * @param {{ url:string, token?:string, repo?:string, dryRun?:boolean, fetchImpl:Function }} o
 * @returns {Promise<{ action:string, assessment?:object, issue?:number }>} never throws
 */
export async function run({ url, token = '', repo = '', dryRun = false, fetchImpl } = {}) {
    try {
        const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'wealthflow-board-watch' } });
        if (!response || !response.ok) return { action: 'canary-unreachable' };
        const a = assess(await response.json());
        if (!a.ok) return { action: 'canary-unreadable', assessment: a };
        if (dryRun || !token || !repo) return { action: a.below ? 'would-file' : 'healthy', assessment: a };
        const api = 'https://api.github.com/repos/' + repo;
        const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'wealthflow-board-watch' };
        const found = await fetchImpl(api + '/issues?state=open&per_page=5&labels=' + encodeURIComponent(BOARD_LABEL), { headers });
        if (!found || !found.ok) return { action: 'lookup-failed', assessment: a };
        const open = await found.json();
        if (a.below) {
            if (Array.isArray(open) && open.length) {
                // the open report says what is true NOW: when the board's state has changed since it was filed, its text is replaced
                const body = reportBody(a), title = 'AI board health: only ' + a.answered + ' of ' + a.asked + ' providers answer (floor ' + a.floor + ')';
                if (String(open[0].body || '') === body) return { action: 'already-open', assessment: a, issue: open[0].number };
                const patched = await fetchImpl(api + '/issues/' + open[0].number, { method: 'PATCH', headers, body: JSON.stringify({ title, body }) });
                return { action: patched && patched.ok ? 'updated' : 'already-open', assessment: a, issue: open[0].number };
            }
            const created = await fetchImpl(api + '/issues', { method: 'POST', headers, body: JSON.stringify({ title: 'AI board health: only ' + a.answered + ' of ' + a.asked + ' providers answer (floor ' + a.floor + ')', body: reportBody(a), labels: ['bug', 'autonomous', BOARD_LABEL] }) });
            if (!created || !created.ok) return { action: 'create-failed', assessment: a };
            const issue = await created.json();
            return { action: 'filed', assessment: a, issue: issue && issue.number };
        }
        if (Array.isArray(open) && open.length) {
            const n = open[0].number;
            await fetchImpl(api + '/issues/' + n + '/comments', { method: 'POST', headers, body: JSON.stringify({ body: 'The board is back above its floor (' + a.answered + ' of ' + a.asked + ' answering, floor ' + a.floor + '). Closing.' }) });
            await fetchImpl(api + '/issues/' + n, { method: 'PATCH', headers, body: JSON.stringify({ state: 'closed', state_reason: 'completed' }) });
            return { action: 'closed', assessment: a, issue: n };
        }
        return { action: 'healthy', assessment: a };
    } catch (_) { return { action: 'error' }; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const arg = (flag, fallback = '') => { const i = process.argv.indexOf(flag); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
    const result = await run({ url: arg('--url', 'https://www.wealthflow.lk/api/ai?canary=1'), token: process.env.GITHUB_TOKEN || '', repo: process.env.GITHUB_REPOSITORY || '', dryRun: process.argv.includes('--dry-run'), fetchImpl: (u, i) => fetch(u, i) });
    console.log(JSON.stringify(result));
    // for the workflow: what was done, and whether the fix agent has anything of its own to fix (the owner-only kinds are not its to fix)
    if (process.env.GITHUB_OUTPUT) {
        const agent = !!(result.assessment && result.assessment.failing.some(f => !OWNER_ONLY.has(f.kind)));
        (await import('node:fs')).appendFileSync(process.env.GITHUB_OUTPUT, 'action=' + result.action + '\nagent=' + agent + '\n');
    }
}

export default { assess, classify, reportBody, run, BOARD_LABEL };
