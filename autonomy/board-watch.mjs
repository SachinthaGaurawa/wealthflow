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

export const BOARD_LABEL = 'ai-board-health';
const OWNER_ONLY = new Set(['credits', 'rate-limit', 'key']);

/** What kind of failure is this provider's error text? Only the kind is ever kept. */
export function classify(error) {
    const text = String(error == null ? '' : error);
    if (/status 402|credits|prepayment|billing|subscribe/i.test(text)) return 'credits';
    if (/status 429|rate.?limit|too many requests|quota/i.test(text)) return 'rate-limit';
    if (/non-JSON/i.test(text)) return 'bad-reply';
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
        failing: providers.filter(p => p && !p.ok).map(p => ({ name: name(p), kind: classify(p.error) })),
    };
}

export function reportBody(a) {
    const owner = a.failing.filter(f => OWNER_ONLY.has(f.kind)), agent = a.failing.filter(f => !OWNER_ONLY.has(f.kind));
    const line = f => '- ' + f.name + ': ' + f.kind;
    return [
        '## AI board health: below its floor',
        '',
        '**Answering:** ' + a.answered + ' of ' + a.asked + '  ·  **Floor:** ' + a.floor + '  ·  **Working:** ' + (a.working.join(', ') || 'none'),
        '',
        'While the board is below its floor, every statement row that needs it keeps the rules\' answer (often "Other"), so categories stay generic. Found by the daily board watch, with nobody asking.',
        '',
        '### Only a person can fix (provider credits, a key, a provider\'s own rate limit)',
        owner.length ? owner.map(line).join('\n') : '- none',
        '',
        '### The fix agent can fix (a retired model name, a reply that is not JSON, a provider that is too slow)',
        agent.length ? agent.map(line).join('\n') : '- none',
        '',
        '### What to do',
        'Fix agent: for each provider in the second list, find why it fails (read `ai-models.mjs`, `ai-chat.mjs`, `api/ai.js`) and change the code; never lower the floor of five and never add a majority path (two working providers run the same model, so fewer voters are weaker than they look). Owner: credits or keys for the first list (Vercel variable names are in `api/ai.js`).',
        '',
        '_Filed automatically; provider names and kinds only, no error text. It closes itself when the board is back above its floor._',
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
            if (Array.isArray(open) && open.length) return { action: 'already-open', assessment: a, issue: open[0].number };
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
