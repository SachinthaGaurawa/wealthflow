/* =============================================================================
 * autonomy/pr-recovery.mjs — what happens when the agent's own pull request goes red
 * -----------------------------------------------------------------------------
 * THE GAP THIS CLOSES (owner, 2026-11-07: "on ANY failure the AI must step in and recover by itself")
 *   The work queue treats an issue with an open `ai-fix/issue-<n>-*` PR as CLAIMED (autonomy/work-queue.mjs
 *   issuesWithOpenFixPr), so the agent never touches it again. If that PR's CI went red, nothing re-engaged
 *   anything: the PR sat red, the issue stayed claimed forever, and the owner saw a fix that never arrived.
 *
 * WHAT IT DOES (run by .github/workflows/autonomous-pr-recovery.yml; it never executes PR code, only reads the API)
 *   For every open agent PR it reads the LATEST result of each check on the head commit and decides:
 *     wait     checks still running, the PR is young, a human gate is open (run approval, the `human-approved`
 *              label), or nothing real failed. Nothing to do.
 *     rerun    a check failed on its first attempt: re-run the failed jobs once. Runners die before a test runs
 *              (conftest has done this); a second failure is real, a first one might not be.
 *     handback a check failed twice. The PR is closed (it is the agent's own, nothing is lost: the diff stays in the
 *              closed PR), a `<!-- wf-pr-recovery -->` comment is written on the ISSUE with what failed and the
 *              evidence, and the fix agent is started again. The agent reads that comment (recoveryBrief) as part of
 *              the problem, so the next try is told why the last one failed. The attempt that opened the PR already
 *              counted against the issue's 3, so this can never loop: after 3 the issue is `ai-stuck`.
 *   Failures that are not code failures never count: the Risk gate waiting for `human-approved`, cancelled runs
 *   (a newer push superseded them), skipped jobs, and checks that only exist to comment or label.
 *
 * Everything here is pure except `run()`, so the decision is tested without a network.
 * ===========================================================================*/

export const RECOVERY_MARKER = '<!-- wf-pr-recovery -->';

/** Checks whose "failure" means a person must act, not that the code is wrong. */
const HUMAN_GATE = /^(risk gate|claude approvals|vercel)/i;
/** Checks that report or label; they never prove the code wrong. */
const NOT_A_TEST = /^(watch|enable auto-merge|point the preview branch|decide whether this change is auto-safe|vercel preview comments)/i;
/** A PR younger than this is still being measured by its first CI pass. */
export const MIN_AGE_MS = 10 * 60 * 1000;

/** The agent's PR branches are `ai-fix/issue-<n>-<timestamp>`; anything else is not ours to close. */
export function issueOfBranch(ref) {
    const m = String(ref || '').match(/^ai-fix\/issue-(\d+)-\d+$/);
    return m ? Number(m[1]) : null;
}

/** Keep only the newest result of each check name: an older red run that a newer green one replaced is history. */
export function latestPerCheck(checkRuns) {
    const by = new Map();
    for (const c of checkRuns || []) {
        const name = String((c && c.name) || '');
        if (!name) continue;
        const t = Date.parse((c.completed_at || c.started_at || '')) || 0;
        const prev = by.get(name);
        if (!prev || t >= prev.t) by.set(name, { t, c });
    }
    return [...by.values()].map((v) => v.c);
}

/** The run id inside a check run's details_url (`.../actions/runs/<id>/job/<id>`), or null. */
export function runIdOf(check) {
    const m = String((check && check.details_url) || '').match(/\/actions\/runs\/(\d+)/);
    return m ? Number(m[1]) : null;
}

/**
 * Decide what to do about one agent PR.
 * @param {{ pr:{ number:number, created_at:string, labels?:any[], head:{ ref:string } },
 *           checkRuns:any[], runAttempts?:Record<string,number>, now?:number }} input
 *   runAttempts maps a workflow run id to its run_attempt (1 = first try), for the checks that failed.
 * @returns {{ action:'wait'|'rerun'|'handback', reason:string, failed:{name:string,runId:number|null}[] }}
 */
export function decideRecovery({ pr, checkRuns, runAttempts = {}, now = Date.now() } = {}) {
    const wait = (reason, failed = []) => ({ action: 'wait', reason, failed });
    if (!pr || issueOfBranch(pr.head && pr.head.ref) === null) return wait('not an agent pull request');
    const age = now - (Date.parse(pr.created_at) || now);
    if (age < MIN_AGE_MS) return wait('too young: its first CI pass is still being read');

    const latest = latestPerCheck(checkRuns);
    if (!latest.length) return wait('no checks have reported yet (runs from a bot wait for approval)');
    if (latest.some((c) => c.status && c.status !== 'completed')) return wait('checks are still running');

    const failed = latest
        .filter((c) => (c.conclusion === 'failure' || c.conclusion === 'timed_out') && !HUMAN_GATE.test(c.name) && !NOT_A_TEST.test(c.name))
        .map((c) => ({ name: c.name, runId: runIdOf(c) }));
    if (!failed.length) return wait('nothing that tests the code has failed');

    // A check that died on its first attempt may be the runner, not the code: run it once more before judging it.
    const firstTry = failed.filter((f) => f.runId !== null && (runAttempts[f.runId] || 1) < 2);
    if (firstTry.length) return { action: 'rerun', reason: `failed on its first attempt: ${firstTry.map((f) => f.name).join(', ')}`, failed: firstTry };
    return { action: 'handback', reason: `still failing after a re-run: ${failed.map((f) => f.name).join(', ')}`, failed };
}

/** Plain-text evidence for a failed check: its title/summary and the first annotations, trimmed. Never code, only words. */
export function failureDigest(failedChecks, annotations = {}) {
    const lines = [];
    for (const c of failedChecks || []) {
        const out = (c && c.output) || {};
        const head = String(out.title || out.summary || '').replace(/\s+/g, ' ').trim().slice(0, 240);
        lines.push(`- **${c.name}**${head ? `: ${head}` : ''}`);
        for (const a of (annotations[c.name] || []).slice(0, 4)) {
            const msg = String(a.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
            if (msg && !/ubuntu-latest label will migrate/i.test(msg)) lines.push(`  - ${a.path || ''}${a.start_line ? `:${a.start_line}` : ''} ${msg}`.trimEnd());
        }
    }
    return lines.join('\n').slice(0, 3000);
}

/** The issue comment that hands a red PR back to the agent. It counts as one attempt and carries the evidence. */
export function handbackComment({ prNumber, reason, digest }) {
    // No attempt marker here: the "Fix drafted" comment that opened the PR already spent the attempt.
    return `${RECOVERY_MARKER}\n### [AI] Attempt failed in CI: handed back to the agent\n\n` +
        `Pull request #${prNumber} was closed because its checks failed twice (${reason}). The diff stays in the closed PR.\n\n` +
        `**What failed**\n${digest || '- (no detail was reported by the check)'}\n\n` +
        `The fix agent is started again and is shown this comment as part of the problem. The attempt that opened the PR already counted; ` +
        `after the third attempt the issue is marked \`ai-stuck\` for a person.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`;
}

/**
 * What the agent should read first on a retry: the newest recovery comment, as a section appended to the problem.
 * Empty when the issue has no failed-in-CI history.
 */
export function recoveryBrief(comments) {
    const mine = (comments || []).filter((c) => String((c && c.body) || '').includes(RECOVERY_MARKER));
    if (!mine.length) return '';
    const last = String(mine[mine.length - 1].body || '');
    const what = (last.match(/\*\*What failed\*\*\n([\s\S]*?)\n\nThe fix agent/) || [])[1] || '';
    return '\n\n### Why the last attempt failed in CI (read this before writing anything)\n' +
        `_An earlier fix for this report was opened as a pull request and its checks failed twice (${mine.length} time${mine.length === 1 ? '' : 's'} so far). ` +
        'Do not repeat it: change the approach, or narrow it so the failing check passes._\n\n' + what.trim().slice(0, 2400) + '\n';
}

// ----------------------------------------------------------------------------------------------------------------
// The runner (network). Reads the API as data; never checks out or runs a pull request's code.
// ----------------------------------------------------------------------------------------------------------------
async function api(path, { method = 'GET', body, env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const repo = env.GITHUB_REPOSITORY;
    if (!token || !repo) throw new Error('pr-recovery: GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    const r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 204) return null;
    const text = await r.text();
    if (!r.ok) { const e = new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 160)}`); e.status = r.status; throw e; }
    try { return JSON.parse(text); } catch { return null; }
}

/** One pass over every open agent PR. Returns what it did, for the log and the tests. */
export async function run({ env = process.env, fetchImpl = globalThis.fetch, log = console.log, now = Date.now(), dryRun = false } = {}) {
    const call = (p, o = {}) => api(p, { env, fetchImpl, ...o });
    const prs = (await call('/pulls?state=open&per_page=100')) || [];
    const done = [];
    for (const pr of prs) {
        const issue = issueOfBranch(pr.head && pr.head.ref);
        if (issue === null) continue;
        const cr = await call(`/commits/${pr.head.sha}/check-runs?per_page=100`).catch((e) => { log(`#${pr.number}: could not read checks (${e.message})`); return null; });
        if (!cr) continue;
        const checkRuns = cr.check_runs || [];
        const runAttempts = {};
        for (const id of new Set(latestPerCheck(checkRuns).filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out').map(runIdOf).filter(Boolean))) {
            const run = await call(`/actions/runs/${id}`).catch(() => null);
            if (run) runAttempts[id] = run.run_attempt || 1;
        }
        const d = decideRecovery({ pr, checkRuns, runAttempts, now });
        log(`#${pr.number} (issue #${issue}): ${d.action} — ${d.reason}`);
        if (d.action === 'wait' || dryRun) { done.push({ pr: pr.number, issue, ...d }); continue; }
        if (d.action === 'rerun') {
            for (const id of new Set(d.failed.map((f) => f.runId))) await call(`/actions/runs/${id}/rerun-failed-jobs`, { method: 'POST' }).catch((e) => log(`#${pr.number}: re-run of run ${id} refused (${e.message})`));
            done.push({ pr: pr.number, issue, ...d });
            continue;
        }
        // handback
        const failedNames = new Set(d.failed.map((f) => f.name));
        const failedChecks = latestPerCheck(checkRuns).filter((c) => failedNames.has(c.name));
        const annotations = {};
        for (const c of failedChecks) annotations[c.name] = (await call(`/check-runs/${c.id}/annotations?per_page=10`).catch(() => [])) || [];
        const comment = handbackComment({ prNumber: pr.number, reason: d.reason, digest: failureDigest(failedChecks, annotations) });
        await call(`/issues/${issue}/comments`, { method: 'POST', body: { body: comment } });
        await call(`/pulls/${pr.number}`, { method: 'PATCH', body: { state: 'closed' } });
        await call(`/git/refs/heads/${pr.head.ref}`, { method: 'DELETE' }).catch(() => {});
        await call('/actions/workflows/autonomous-fix.yml/dispatches', { method: 'POST', body: { ref: env.WF_DEFAULT_BRANCH || 'main', inputs: { issue: String(issue) } } })
            .catch((e) => log(`#${pr.number}: could not start the agent again (${e.message}); the next scheduled run will pick issue #${issue} up`));
        done.push({ pr: pr.number, issue, ...d });
    }
    return done;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run({ dryRun: process.env.RECOVERY_DRY_RUN === 'true' }).then((d) => { console.log(JSON.stringify(d)); }).catch((e) => { console.error(e.message); process.exit(1); });
}
