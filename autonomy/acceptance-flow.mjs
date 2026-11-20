/* =============================================================================
 * autonomy/acceptance-flow.mjs — what happens AFTER a feature shipped   (owner, 2026-11-20)
 * -----------------------------------------------------------------------------
 * A feature that merged is not finished until it has been used the way the owner would use it. This file is the pure part of that loop (the part that can be
 * tested without GitHub or a browser); autonomy/acceptance-cli.mjs does the network and the browser.
 *
 *   closed issue  →  run the shipped module on a phone, judge it against the report (autonomy/acceptance.mjs)
 *     passed        →  a short comment with what was checked; nothing else happens
 *     problems      →  a comment that quotes the screen, the issue is REOPENED, the fix agent is started with the problems (build lane, revision mode)
 *     second round with problems left → one more round; after the second the issue is labelled ai-stuck and the owner is asked
 *
 * Markers (written by the agent's own login, read back here):
 *   <!-- wf-acceptance round=N file=NAME status=STATUS -->   every check leaves one
 *   <!-- wf-revise file=NAME -->                             the check asks for a revision; the text after the marker is what the author is shown
 *   <!-- wf-acceptance-reset -->                             starts the attempt budget again (autonomy/route.mjs::isReset honours it from the agent's login only)
 * ===========================================================================*/

const AGENT_LOGIN = 'github-actions[bot]';
export const MAX_ROUNDS = 2;
const ROUND_RE = /<!--\s*wf-acceptance\s+round=(\d+)\s+file=([A-Za-z0-9._-]+)\s+status=(\w+)\s*-->/;
const REVISE_RE = /<!--\s*wf-revise\s+file=([A-Za-z0-9._-]+)\s*-->/;
const MODULE_RE = /^wealthflow-[a-z0-9]+(?:-[a-z0-9]+){0,4}\.js$/;
const isAgent = (c) => String((c && c.user && c.user.login) || '') === AGENT_LOGIN;

/** The module file the fix agent shipped for this issue, from its own "Fix drafted" comments (the newest wins). null when it shipped none. */
export function shippedModuleFrom(comments) {
    let file = null;
    for (const c of comments || []) {
        if (!isAgent(c)) continue;
        const body = String(c.body || '');
        if (!/Fix drafted/.test(body)) continue;
        const m = /I changed `([^`]+)`/.exec(body);
        if (m && MODULE_RE.test(m[1])) file = m[1];
    }
    return file;
}

/** How many acceptance checks that FOUND PROBLEMS this issue has already had. Comments from anyone but the agent do not count. */
export function roundsWithProblems(comments) {
    let n = 0;
    for (const c of comments || []) {
        if (!isAgent(c)) continue;
        const m = ROUND_RE.exec(String(c.body || ''));
        if (m && m[3] === 'problems') n = Math.max(n, Number(m[1]));
    }
    return n;
}

/**
 * The revision the author still owes: the newest `wf-revise` comment of the agent that no later "Fix drafted" comment has answered.
 * @returns {{ file:string, findings:string, round:number }|null}
 */
export function pendingRevision(comments) {
    let pending = null;
    for (const c of comments || []) {
        if (!isAgent(c)) continue;
        const body = String(c.body || '');
        const r = REVISE_RE.exec(body);
        if (r) {
            const round = ROUND_RE.exec(body);
            const f = /\*\*What I will change\*\*[^\n]*\n+([\s\S]*?)\n+I reopened this report/.exec(body);
            pending = { file: r[1], round: round ? Number(round[1]) : 1, findings: f ? f[1].trim().slice(0, 3000) : '' };
            continue;
        }
        if (pending && /<!--\s*wf-agent-attempt\s*-->/.test(body) && /Fix drafted/.test(body)) pending = null;
    }
    return pending && MODULE_RE.test(pending.file) && pending.findings ? pending : null;
}

/** What the check decides to do with a result. Pure. */
export function decide({ result, round }) {
    if (!result || result.status === 'skipped') return { action: 'none', why: result && result.reason ? result.reason : 'the run could not start' };
    if (result.status === 'passed') return { action: 'pass' };
    if (result.status === 'inconclusive') return { action: 'inconclusive', why: result.reason || 'the script could not reach what it was meant to tap' };
    if (!(result.blocking && result.blocking.length)) return { action: 'pass' };
    return round >= MAX_ROUNDS ? { action: 'give_up' } : { action: 'revise' };
}

/** The comment the check leaves. `brief` is findingsBrief(...) for a revision. */
export function checkComment({ round, file, status, summary = '', brief = '', action }) {
    const lines = [`<!-- wf-acceptance round=${round} file=${file} status=${status} -->`];
    if (action === 'revise') lines.push(`<!-- wf-revise file=${file} -->`, '<!-- wf-acceptance-reset -->');
    lines.push(
        `### [AI] Checked on a phone after it shipped (round ${round}/${MAX_ROUNDS})`, '',
        summary,
        ...(action === 'revise' ? ['', '**What I will change** (the author is shown exactly this):', '', brief, '', `I reopened this report and started a fix that revises \`${file}\`.`] : []),
        ...(action === 'give_up' ? ['', `Two rounds of fixes did not clear everything, so I am labelling this \`ai-stuck\` for you instead of trying a third time. The remaining problems are listed above.`] : []),
        '', '---', '_Generated by [Claude Code](https://claude.ai/code)_',
    );
    return lines.join('\n');
}
