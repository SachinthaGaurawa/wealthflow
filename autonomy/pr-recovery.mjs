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
 *   approve  (added 2026-11-20, owner: "the system must do this by itself") GitHub holds every run from the agent's own bot login
 *              as `action_required` until someone with write access approves it, so no check ever ran on a bot PR. A program reads the
 *              PR's file list and approves the runs ONLY when the change is the kind of change the build lane makes (see
 *              `approvalVerdict`: leaf browser modules, their `test/auto-*` proving test, the agent's own state file, one script line
 *              in index.html, numeric perf-budget ceilings). Anything else stays held for a person, because a pull request's own
 *              workflows and scripts run with the repository's secrets. `WF_AUTO_APPROVE=0` turns it off.
 *   layout lane (added 2026-11-21, owner: "do not fix #660/#662 yourself, make the system do it") A layout fix is only ever an APPENDED, headed block of
 *            validated CSS in `wf-agent-fixes.css` (autonomy/css-rules.mjs, the same strict reader the lane used before it opened the PR). Two things kept
 *            such PRs waiting for a person for ever, and neither was a fault in the fix:
 *              1. the approval allowlist above knew only the build lane's files, so the held CI runs were never approved;
 *              2. the agent also committed its bookkeeping file `autonomy/state/issue-N.json`, and `autonomy/.*` is a sensitive path: the Risk gate
 *                 wants `human-approved` for a counter. (The agent no longer stages it; PRs opened before that are repaired here.)
 *            So for a PR whose every change is lane CSS (plus that bookkeeping file) this job (a) approves the held runs, (b) rebuilds the head as a real
 *            merge of the default branch with exactly the PR's appended blocks (two layout PRs append at the same end of the file, so the second
 *            always conflicts once the first merges) and leaves the bookkeeping file out, and (c) merges it itself when GitHub says it is clean and
 *            the required checks (tests + fuzz, risk gate, conftest, the review board, secret scan) all PASSED on that exact commit. It never merges a
 *            PR with any other file, a failing check, or a head that moved. `WF_AUTO_LANE=0` turns (b) and (c) off.
 *   Failures that are not code failures never count: the Risk gate waiting for `human-approved`, cancelled runs
 *   (a newer push superseded them), skipped jobs, and checks that only exist to comment or label.
 *
 * Everything here is pure except `run()`, so the decision is tested without a network.
 * ===========================================================================*/

import { forbiddenIn } from './build-lane.mjs';
import { LANE_FILE, validateCss, validateLaneFile } from './css-rules.mjs';

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
// Approving the runs GitHub holds for the agent's bot login
// ----------------------------------------------------------------------------------------------------------------
const MODULE_FILE = /^wealthflow-[a-z0-9]+(?:-[a-z0-9]+){0,4}\.js$/;
const PROVING_TEST = /^test\/auto-wealthflow-[a-z0-9]+(?:-[a-z0-9]+){0,4}-\d+\.test\.js$/;
const STATE_FILE = /^autonomy\/state\/issue-\d+\.json$/;
const SCRIPT_LINE = /^<script src="wealthflow-[a-z0-9]+(?:-[a-z0-9]+){0,4}\.js" defer><\/script>$/;
/** A state file holds counters and signatures: every changed line is a bracket, a key, and a short number or token. Nothing else. */
const STATE_LINE = /^[[\]{},]*(?:"[A-Za-z0-9_-]{1,40}":\s*)?(?:\d{1,6}|"[A-Za-z0-9 _.:-]{0,64}"|true|false|null|\[|\{)?[[\]{},]*$/;
/** What a model-written proving test may never do: it runs in CI, where a pull request's code must have no way out and no way to read the environment. */
const TEST_FORBIDDEN = [
    [/\bprocess\s*\.\s*(?:env|binding|dlopen|kill|exit)\b|\bprocess\s*\[/, 'reads the environment or the process'],
    [/child_process|\bworker_threads\b|\bcluster\b|\bvm\b\s*[.(]|\brequire\s*\(\s*['"](?:node:)?(?:https?|http2|net|dns|tls|dgram|os|vm)['"]|from\s+['"](?:node:)?(?:https?|http2|net|dns|tls|dgram|os|vm)['"]/, 'loads a network, process or system module'],
    [/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|\bEventSource\b/, 'uses the network'],
    [/\beval\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(/, 'runs text as code'],
    [/\bfs\s*\.\s*(?:write|append|unlink|rm|rename|copy|mkdir|chmod|symlink)\w*\s*\(|\bwriteFile\w*\s*\(/, 'writes files'],
];
const addedLines = (patch) => String(patch).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
const changedLines = (patch) => String(patch).split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).map((l) => l.slice(1).trim()).filter(Boolean);
const BUDGET_LINE = /^[A-Za-z0-9_]+:\s*[\d_.]+,\s*(?:\/\/.*)?$/;
const STAMP_COMMENT = /^<!--\s*[^<>]*added by the build lane[^<>]*-->$/;
/** Files whose content is only ever read as data by the board and the policy gate, or runs in the browser tests with no secrets. */
export const AUTO_APPROVE_MAX_FILES = 8;

const LANE_HEAD = /^\/\*\s*lane-block:\s*(\S+)\s+scope=(#[\w-]+)/;
/** A layout fix is one screen: three headed blocks is already more than any lane run has produced. */
export const LANE_MAX_BLOCKS = 3;

/**
 * What a layout-lane pull request does to `wf-agent-fixes.css`: ONLY append headed blocks, and every block passes the lane's own strict reader
 * (selector names the one screen, layout properties only, nothing hidden, no url(), no breaking words into pieces). Pure.
 * @param {string} patch the file's unified-diff patch from the pull request's file list
 */
export function laneCssVerdict(patch) {
    const no = (why) => ({ ok: false, why });
    const text = String(patch || '');
    if (!text) return no('no patch to read');
    if (text.split('\n').some((l) => l.startsWith('-') && !l.startsWith('---'))) return no('it removes or rewrites an existing line; the lane only appends');
    const parts = addedLines(text).join('\n').split(/(?=\/\*\s*lane-block:)/);
    const lead = LANE_HEAD.test(parts[0]) ? '' : parts.shift();
    if (lead && lead.replace(/\/\*[\s\S]*?\*\//g, '').trim()) return no('CSS that is not inside a headed lane block');
    if (!parts.length) return no('no headed lane block was added');
    if (parts.length > LANE_MAX_BLOCKS) return no(`${parts.length} blocks added; a layout fix is at most ${LANE_MAX_BLOCKS}`);
    for (const part of parts) {
        const head = part.match(LANE_HEAD);
        if (!head) return no('a block has no "lane-block: <issue> scope=#id" header');
        const v = validateCss(part.replace(/^\/\*[\s\S]*?\*\//, ''), { scope: head[2] });
        if (!v.ok) return no(`block ${head[1]}: ${v.problems.slice(0, 2).join('; ')}`);
    }
    return { ok: true, why: `${parts.length} appended block(s), all passing the layout lane's own reader` };
}

/**
 * May the held runs of this agent PR be approved without a person? Pure.
 * @param {{ pr:{ user?:{login?:string}, head:{ ref:string, repo?:{ full_name?:string } }, base?:{ repo?:{ full_name?:string } } }, files:{ filename:string, status?:string, patch?:string }[] }} input
 * @returns {{ ok:boolean, why:string }}
 */
export function approvalVerdict({ pr, files } = {}) {
    const no = (why) => ({ ok: false, why });
    if (!pr || issueOfBranch(pr.head && pr.head.ref) === null) return no('not an agent pull request');
    if (String((pr.user && pr.user.login) || '') !== 'github-actions[bot]') return no('not opened by the agent login');
    const headRepo = pr.head && pr.head.repo && pr.head.repo.full_name, baseRepo = pr.base && pr.base.repo && pr.base.repo.full_name;
    if (!headRepo || !baseRepo || headRepo !== baseRepo) return no('the branch is not in this repository');
    if (!Array.isArray(files) || !files.length) return no('no file list to check');
    if (files.length > AUTO_APPROVE_MAX_FILES) return no(`${files.length} files: more than the build lane ever changes`);
    for (const f of files) {
        const name = String((f && f.filename) || '');
        const patch = typeof f.patch === 'string' ? f.patch : '';
        const needPatch = () => (patch ? null : no(`${name}: GitHub gave no patch to read, so its content cannot be checked`));
        if (MODULE_FILE.test(name)) {
            // Content, not just the name: the same machine check the build lane applies to a new module (no DB writes, no Firebase, no eval, no
            // script injection, no secrets, no network together with the books) is applied to every line the PR adds.
            const miss = needPatch(); if (miss) return miss;
            const bad = forbiddenIn(addedLines(patch).join('\n'));
            if (bad.length) return no(`${name}: ${bad[0]}`);
            continue;
        }
        if (PROVING_TEST.test(name)) {
            const miss = needPatch(); if (miss) return miss;
            const code = addedLines(patch).join('\n');
            const bad = TEST_FORBIDDEN.find(([re]) => re.test(code));
            if (bad) return no(`${name}: a proving test ${bad[1]}`);
            continue;
        }
        if (name === LANE_FILE) {
            const miss = needPatch(); if (miss) return miss;
            const lane = laneCssVerdict(patch);
            if (!lane.ok) return no(`${name}: ${lane.why}`);
            continue;
        }
        if (STATE_FILE.test(name)) {
            const miss = needPatch(); if (miss) return miss;
            const bad = changedLines(patch).find((l) => l && !STATE_LINE.test(l));
            if (bad) return no(`${name}: a changed line is not a counter or a signature (${bad.slice(0, 60)})`);
            continue;
        }
        if (name === 'index.html' || name === 'autonomy/perf-budget.mjs') {
            const miss = needPatch(); if (miss) return miss;
            const re = name === 'index.html' ? [SCRIPT_LINE, STAMP_COMMENT] : [BUDGET_LINE];
            const bad = changedLines(patch).find((l) => !re.some((r) => r.test(l)));
            if (bad) return no(`${name}: a changed line is not what the build lane writes (${bad.slice(0, 80)})`);
            if (name === 'index.html') {
                // A script tag may only load a module this same PR adds (and whose content was read above), never one that is already live.
                const added = new Set(files.filter((x) => x && x.status === 'added' && MODULE_FILE.test(String(x.filename))).map((x) => x.filename));
                const loose = addedLines(patch).map((l) => l.trim()).filter((l) => SCRIPT_LINE.test(l)).map((l) => l.match(/src="([^"]+)"/)[1]).find((src) => !added.has(src));
                if (loose) return no(`${name}: loads ${loose}, which this pull request does not add`);
            }
            continue;
        }
        return no(`${name}: not a file the build lane changes`);
    }
    return { ok: true, why: `${files.length} file(s), all of the kind the build lane writes` };
}

/** The runs of a head commit that GitHub is holding for approval. With `sha`, only runs of exactly that commit count. */
export function heldRuns(runs, sha) {
    return (runs || []).filter((r) => r && r.status === 'completed' && r.conclusion === 'action_required' && (!sha || r.head_sha === sha)).map((r) => r.id).filter(Boolean);
}

// ----------------------------------------------------------------------------------------------------------------
// The layout lane: repair a PR whose only real change is appended CSS, and merge it when everything that must pass has passed
// ----------------------------------------------------------------------------------------------------------------
/** Checks that must have PASSED on the exact head before this job merges anything. Names are the jobs' own (see a merged PR's check list). */
export const REQUIRED_CHECKS = [/^Tests \+ fuzz/i, /^Risk gate/i, /^conftest$/i, /^review$/i, /^No committed credentials/i];
const RED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const IGNORED_CHECK = /^(watch|enable auto-merge|point the preview branch|decide whether this change is auto-safe|vercel)/i;

/** Is this PR a layout-lane PR that can be rebuilt, and what must be left out / carried over? Pure. */
export function repairPlan({ pr, files } = {}) {
    const verdict = approvalVerdict({ pr, files });
    if (!verdict.ok) return { ok: false, why: verdict.why };
    const lane = (files || []).find((f) => f.filename === LANE_FILE);
    if (!lane) return { ok: false, why: 'not a layout-lane pull request (it does not change wf-agent-fixes.css)' };
    const others = (files || []).filter((f) => f.filename !== LANE_FILE);
    const odd = others.find((f) => !STATE_FILE.test(f.filename));
    if (odd) return { ok: false, why: `${odd.filename} is more than the layout lane's bookkeeping` };
    return { ok: true, why: verdict.why, strip: others.map((f) => f.filename), addedCss: addedLines(lane.patch).join('\n') };
}

/** The blocks of a lane file, header included, in order. */
function laneBlocks(css) { return String(css || '').split(/(?=\/\*\s*lane-block:)/).filter((b) => LANE_HEAD.test(b)).map((b) => b.replace(/\s+$/, '')); }

/**
 * The default branch's lane file with this PR's appended blocks added at its end (a block that is already there is not added twice).
 * Checked as a whole by the lane's own file validator, so what is committed is what CI's agent_fixes_css test accepts. Pure.
 */
export function mergeLaneCss(mainCss, addedCss) {
    const base = String(mainCss || '').replace(/\s+$/, '');
    const fresh = laneBlocks(addedCss).filter((b) => !base.includes(b.trim()));
    if (!fresh.length) return { ok: false, why: 'the default branch already carries every block of this pull request', css: String(mainCss || ''), added: 0 };
    const css = `${base}\n\n${fresh.join('\n\n')}\n`;
    const v = validateLaneFile(css);
    return v.ok ? { ok: true, why: `${fresh.length} block(s) added`, css, added: fresh.length } : { ok: false, why: `the merged file would not pass: ${v.problems[0]}`, css, added: 0 };
}

/** One result per job (check name + the workflow run it belongs to): a re-run replaces its own earlier attempt, a same-named job of another workflow does not. */
function latestPerJob(checkRuns) {
    const by = new Map();
    for (const c of checkRuns || []) {
        const name = String((c && c.name) || '');
        if (!name) continue;
        const key = `${name}#${runIdOf(c) || c.id}`;
        const t = Date.parse(c.completed_at || c.started_at || '') || 0;
        const prev = by.get(key);
        if (!prev || t >= prev.t) by.set(key, { t, c });
    }
    return [...by.values()].map((v) => v.c);
}

/**
 * May this layout-lane PR be merged by this job? Every condition must hold, on the head commit the checks were read for. Pure.
 * @param {{ pr:object, files:object[], checkRuns:object[], mergeable:boolean|null|undefined }} input
 */
export function mergeVerdict({ pr, files, checkRuns, mergeable } = {}) {
    const no = (why) => ({ ok: false, why });
    const v = approvalVerdict({ pr, files });
    if (!v.ok) return no(v.why);
    if (!Array.isArray(files) || !files.length || files.some((f) => f.filename !== LANE_FILE)) return no('only a pull request that changes nothing but wf-agent-fixes.css merges by itself');
    if (pr.draft) return no('it is still a draft');
    if (mergeable !== true) return no(mergeable === false ? 'it conflicts with the default branch' : 'GitHub has not yet worked out whether it merges cleanly');
    const jobs = latestPerJob(checkRuns);
    if (jobs.some((c) => c.status && c.status !== 'completed')) return no('checks are still running');
    for (const re of REQUIRED_CHECKS) {
        const named = jobs.filter((c) => re.test(c.name));
        if (!named.length) return no(`the check "${re.source.replace(/[\\^$]/g, '')}" has not reported on this commit`);
        const red = named.find((c) => RED.has(c.conclusion));
        if (red) return no(`${red.name} did not pass (${red.conclusion})`);
        if (!named.some((c) => c.conclusion === 'success')) return no(`${named[0].name} has not passed (${named[0].conclusion})`);
    }
    const red = jobs.find((c) => !IGNORED_CHECK.test(c.name) && RED.has(c.conclusion));
    if (red) return no(`${red.name} did not pass (${red.conclusion})`);
    return { ok: true, why: `appended layout CSS only; ${jobs.length} check(s) read, the required ones passed on this commit` };
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

/**
 * Rebuild a layout PR's head as a real merge: parents are the PR's current head and the default branch's tip, the tree is the default
 * branch's tree with `wf-agent-fixes.css` holding exactly this PR's appended blocks. The PR then merges cleanly, and the bookkeeping file
 * (a sensitive path) is no longer in its diff. A fast-forward update of the branch only (never forced), and only if the head is still the one read.
 * @returns the new head sha, or null when nothing was done
 */
async function repairLanePr({ call, pr, plan, issue, env, log }) {
    try {
        const base = env.WF_DEFAULT_BRANCH || 'main';
        const mainSha = ((await call(`/git/ref/heads/${base}`)) || {}).object?.sha;
        const mainTree = mainSha ? ((await call(`/git/commits/${mainSha}`)) || {}).tree?.sha : null;
        const file = mainSha ? await call(`/contents/${LANE_FILE}?ref=${mainSha}`) : null;
        if (!mainSha || !mainTree || !file || typeof file.content !== 'string') { log(`#${pr.number}: could not read ${base}; nothing rebuilt`); return null; }
        const merged = mergeLaneCss(Buffer.from(file.content, 'base64').toString('utf8'), plan.addedCss);
        if (!merged.ok) { log(`#${pr.number}: not rebuilt — ${merged.why}`); return null; }
        if ((((await call(`/pulls/${pr.number}`)) || {}).head || {}).sha !== pr.head.sha) { log(`#${pr.number}: the branch moved; nothing rebuilt, the next pass reads it again`); return null; }
        const blob = await call('/git/blobs', { method: 'POST', body: { content: merged.css, encoding: 'utf-8' } });
        const tree = await call('/git/trees', { method: 'POST', body: { base_tree: mainTree, tree: [{ path: LANE_FILE, mode: '100644', type: 'blob', sha: blob.sha }] } });
        const commit = await call('/git/commits', { method: 'POST', body: {
            message: `Layout fix for #${issue}: ${base} merged in${plan.strip.length ? ', bookkeeping file left out' : ''}\n\nDone by the recovery job (autonomy/pr-recovery.mjs). The diff against ${base} is the appended layout CSS and nothing else.`,
            tree: tree.sha, parents: [pr.head.sha, mainSha],
        } });
        await call(`/git/refs/heads/${pr.head.ref}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        return commit.sha;
    } catch (e) {
        log(`#${pr.number}: could not rebuild the head (${e.message}); it stays as it is for a person`);
        return null;
    }
}

/** One pass over every open agent PR. Returns what it did, for the log and the tests. */
export async function run({ env = process.env, fetchImpl = globalThis.fetch, log = console.log, now = Date.now(), dryRun = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const call = (p, o = {}) => api(p, { env, fetchImpl, ...o });
    const prs = (await call('/pulls?state=open&per_page=100')) || [];
    const done = [];
    for (const pr of prs) {
        const issue = issueOfBranch(pr.head && pr.head.ref);
        if (issue === null) continue;
        let filesMemo = null;
        const listFiles = async () => { const r = await call(`/pulls/${pr.number}/files?per_page=100`).catch(() => null); return Array.isArray(r) ? r : []; };
        const filesOf = async () => (filesMemo ??= await listFiles());
        // The layout lane: rebuild a PR whose only real change is appended CSS (conflict with main, bookkeeping file) so it can go through by itself.
        if (env.WF_AUTO_LANE !== '0') {
            const files = await filesOf();
            if (files.some((f) => f.filename === LANE_FILE)) {
                const plan = repairPlan({ pr, files });
                const full = (await call(`/pulls/${pr.number}`).catch(() => null)) || {};
                if (!plan.ok) log(`#${pr.number}: layout PR left as it is — ${plan.why}`);
                else if (plan.strip.length || full.mergeable === false) {
                    const why = [full.mergeable === false && 'conflicts with main', plan.strip.length && 'carries the bookkeeping file'].filter(Boolean).join(' and ');
                    if (dryRun) log(`#${pr.number}: would rebuild the head (${why})`);
                    else {
                        const sha = await repairLanePr({ call, pr, plan, issue, env, log });
                        if (sha) {
                            log(`#${pr.number}: head rebuilt as a merge of ${env.WF_DEFAULT_BRANCH || 'main'} plus its own CSS (${why}); new head ${sha.slice(0, 7)}`);
                            done.push({ pr: pr.number, issue, action: 'repair', reason: why, failed: [] });
                            pr.head = { ...pr.head, sha };
                            filesMemo = null;
                            await sleep(20000);   // let GitHub create the runs for the new head before the approval step below looks for them
                        }
                    }
                }
            }
        }
        // Runs GitHub holds for the agent's bot login: approve them when (and only when) the diff is what the agent's lanes write.
        if (env.WF_AUTO_APPROVE === '0') {
            // Switched off by the repository variable. Say so: a silent skip left two PRs waiting with no line in the log saying why (2026-11-21).
            const held = heldRuns(((await call(`/actions/runs?head_sha=${pr.head.sha}&per_page=100`).catch(() => null)) || {}).workflow_runs, pr.head.sha);
            if (held.length) {
                log(`#${pr.number}: ${held.length} held run(s) are NOT approved because the repository variable WF_AUTO_APPROVE is 0. Delete it (or set it to 1) under Settings > Secrets and variables > Actions > Variables and the next pass approves them.`);
                done.push({ pr: pr.number, issue, action: 'wait', reason: 'held runs; approving is switched off by WF_AUTO_APPROVE=0', failed: [] });
            }
        } else {
            const held = heldRuns(((await call(`/actions/runs?head_sha=${pr.head.sha}&per_page=100`).catch(() => null)) || {}).workflow_runs, pr.head.sha);
            if (held.length) {
                const files = await filesOf();
                const v = approvalVerdict({ pr, files });
                if (!v.ok) log(`#${pr.number}: ${held.length} run(s) wait for a person — ${v.why}`);
                else if (dryRun) log(`#${pr.number}: would approve ${held.length} held run(s) — ${v.why}`);
                else if (((await call(`/pulls/${pr.number}`).catch(() => null)) || {}).head?.sha !== pr.head.sha) {
                    // The branch moved between reading the file list and approving: what was read is no longer what would run.
                    log(`#${pr.number}: the branch moved while it was being checked; nothing approved, the next pass reads it again`);
                } else {
                    let ok = 0;
                    for (const id of held) {
                        try { await call(`/actions/runs/${id}/approve`, { method: 'POST' }); ok++; }
                        catch (e) { log(`#${pr.number}: GitHub refused to approve run ${id} (${e.message}). It keeps these for a person: Settings > Actions > General > Fork pull request workflows.`); }
                    }
                    log(`#${pr.number}: approved ${ok}/${held.length} held run(s) — ${v.why}`);
                    done.push({ pr: pr.number, issue, action: 'approve', reason: `${ok}/${held.length} runs approved`, failed: [] });
                }
            }
        }
        const cr = await call(`/commits/${pr.head.sha}/check-runs?per_page=100`).catch((e) => { log(`#${pr.number}: could not read checks (${e.message})`); return null; });
        if (!cr) continue;
        const checkRuns = cr.check_runs || [];
        // The layout lane merges itself once the required checks have passed on this exact commit (the merge call carries the commit it read).
        if (env.WF_AUTO_LANE !== '0') {
            const files = await filesOf();
            if (files.length && files.every((f) => f.filename === LANE_FILE)) {
                const full = (await call(`/pulls/${pr.number}`).catch(() => null)) || {};
                const mv = full.head && full.head.sha === pr.head.sha ? mergeVerdict({ pr: { ...pr, draft: full.draft }, files, checkRuns, mergeable: full.mergeable }) : { ok: false, why: 'the branch moved while it was being checked' };
                if (!mv.ok) log(`#${pr.number}: layout PR not merged yet — ${mv.why}`);
                else if (dryRun) log(`#${pr.number}: would merge — ${mv.why}`);
                else {
                    try {
                        await call(`/pulls/${pr.number}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha: pr.head.sha, commit_title: `${String(pr.title || `layout fix for #${issue}`).slice(0, 200)} (#${pr.number})`, commit_message: `Merged by the recovery job: appended layout CSS only, required checks passed on ${pr.head.sha.slice(0, 7)}.` } });
                        log(`#${pr.number}: merged — ${mv.why}`);
                        done.push({ pr: pr.number, issue, action: 'merge', reason: mv.why, failed: [] });
                        continue;
                    } catch (e) { log(`#${pr.number}: GitHub refused the merge (${e.message}); it stays open and the next pass tries again`); }
                }
            }
        }
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

/**
 * Keep looking while checks this job just released are still running (2026-11-21).
 * The agent's PRs are opened with the workflow token, so GitHub does not wake `workflow_run` when their CI ends: only the hourly timer
 * would have found the green checks, and a green layout PR sat up to an hour before it was merged. One pass approves the held runs; this
 * waits for those checks (about three minutes) and looks again, so the same job run that approved a PR also merges it.
 * Stops when nothing is waiting on running checks, or when the time budget is spent (the hourly timer picks up the rest).
 */
export async function runUntilSettled({ runOnce = run, budgetMs = 10 * 60 * 1000, pollMs = 45 * 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = Date.now, log = console.log, ...opts } = {}) {
    const started = clock();
    const all = [];
    for (let pass = 1; ; pass++) {
        const done = await runOnce({ ...opts, sleep, log });
        all.push(...done);
        const waiting = done.some((d) => d.action === 'wait' && /still running/.test(String(d.reason)));
        if (!waiting || opts.dryRun) return all;
        if (clock() - started + pollMs > budgetMs) { log(`checks are still running after ${pass} pass(es); the next scheduled run looks again`); return all; }
        log(`checks are still running; looking again in ${Math.round(pollMs / 1000)} s (pass ${pass})`);
        await sleep(pollMs);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runUntilSettled({ dryRun: process.env.RECOVERY_DRY_RUN === 'true' }).then((d) => { console.log(JSON.stringify(d)); }).catch((e) => { console.error(e.message); process.exit(1); });
}
