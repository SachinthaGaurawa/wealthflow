#!/usr/bin/env node
/* =============================================================================
 * autonomous-fix-agent.js — the autonomous maintenance engineer
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG BEFORE (verified, not guessed)
 *   Actions run 30200095048, step "Run the fix agent":
 *       started 11:25:45  ·  completed 11:25:45  ·  job conclusion: success
 *       agent error: Unexpected end of JSON input
 *   The first thing the old agent did was
 *       JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
 *   on an unset variable. It threw, exited 78 ("nothing to do"), and because the
 *   workflow step carried `continue-on-error: true` the run was reported green.
 *   That has happened every two hours for months. The autonomous update system
 *   has never, not once, produced a real change.
 *
 *   Three further faults sat behind it, each independently fatal:
 *     • its only work queue was Firestore, which nothing populated;
 *     • it asked for GEMINI_API_KEY, while the configured key is WealthFlow_API_Key;
 *     • it never wrote tests, so policy/wealthflow.rego RULE 3 would have blocked
 *       100% of its PRs even if it had produced one.
 *
 * WHAT THIS VERSION DOES DIFFERENTLY
 *   1. NO REQUIRED SERVICES. Firebase is optional enrichment. The queue is
 *      GitHub Issues (free, always present in Actions). Any ONE of ~15 LLM keys
 *      is enough, with automatic failover between providers.
 *   2. FAILS LOUDLY. A misconfiguration exits non-zero with a precise reason and
 *      writes it to the job summary. "Success" now means work happened, or that
 *      the queue was genuinely empty — never that the agent crashed on startup.
 *   3. SHIPS A TEST WITH EVERY FIX, so the policy gate is satisfiable honestly.
 *   4. LEAVES AN AUDIT TRAIL on the issue: which model authored it, which model
 *      reviewed it, what the verdict was, and how many attempts have been made.
 *   5. GIVES UP HONESTLY. After MAX_ATTEMPTS, or on repeated identical output,
 *      it labels the issue `ai-stuck` and asks for a human instead of churning.
 *
 * EXIT CODES
 *   0  a fix was written (the workflow will validate and open a PR)
 *   3  nothing to do — queue empty, or no issue could be safely addressed
 *   1  MISCONFIGURED or a hard failure — the pipeline is broken, tell someone
 *
 * ENV
 *   required: GITHUB_TOKEN (auto in Actions) + GITHUB_REPOSITORY (auto)
 *             + at least one LLM key (see autonomy/llm-router.mjs)
 *   optional: FIREBASE_SERVICE_ACCOUNT, AGENT_MAX_ATTEMPTS, AGENT_ISSUE,
 *             AGENT_DRY_RUN
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { describeAvailability } from './autonomy/llm-router.mjs';
import { runSwarm } from './autonomy/agent-swarm.mjs';
import { layoutLaneFor, runLayoutLane } from './autonomy/css-lane.mjs';
import { buildLaneFor, runBuildLane, wireModule } from './autonomy/build-lane.mjs';
import { conceptBoardFor, runConceptBoard, renderComment as boardComment, briefFor, parseStoredBoard, BOARD_MARKER } from './autonomy/concept-board.mjs';
import { screenshotContext } from './autonomy/screenshot-reader.mjs';
import { withTranslation } from './autonomy/feedback-language.mjs';
import { recoveryBrief } from './autonomy/pr-recovery.mjs';
import { lessonsBrief, lessonsFor } from './autonomy/lessons.mjs';
import { evidenceLedger } from './autonomy/evidence-ledger.mjs';
import { taskCard, cardMarkdown } from './autonomy/task-card.mjs';
import { runAnalysis, analysisMarkdown } from './autonomy/analysis-pass.mjs';
import * as Q from './autonomy/work-queue.mjs';
import { attemptTrail, attemptBrief, laneRuledOut, nothingToMeasure } from './autonomy/route.mjs';
import { siblingsOf, groupTitle } from './autonomy/feedback-group.mjs';

const MAX_ATTEMPTS = Number(process.env.AGENT_MAX_ATTEMPTS || 3);
const ATTEMPT_COOLDOWN_MS = Number(process.env.AGENT_ATTEMPT_COOLDOWN_MS || 15 * 60_000);
const DRY = /^(1|true|yes)$/i.test(process.env.AGENT_DRY_RUN || '');
const REPO_DIR = process.env.REPO_DIR || process.cwd();
const STATE_DIR = path.join(REPO_DIR, 'autonomy', 'state');
const OUTPUT = path.join(REPO_DIR, 'ai-fix-pr.json');
// Feedback filed on the same day rides in ONE update (owner, 2026-11-07); a lone report is its own update. See autonomy/feedback-group.mjs.
// Off for AUTONOMY_LEVEL=direct, whose ship step commits one fix at a time, and for a dry run.
const GROUP = process.env.AGENT_GROUP !== '0';
const GROUP_BUDGET_MS = Number(process.env.AGENT_GROUP_BUDGET_MS || 20 * 60_000);
const STARTED = Date.now();

function log(...m) { console.log('[agent]', ...m); }
function fail(msg) {
    console.error('[agent] [INFO] MISCONFIGURED: ' + msg);
    summary(`### [ERROR] Autonomous agent could not run\n\n${msg}\n`);
    process.exit(1);
}
function summary(md) {
    try {
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    } catch { /* never fatal */ }
}
function output(kv) {
    try {
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT,
                Object.entries(kv).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`).join('\n') + '\n');
        }
    } catch { /* never fatal */ }
}

/** Stable signature of a produced patch — used to detect "no progress" loops. */
export function signature(code) {
    return createHash('sha256').update(String(code || '')).digest('hex').slice(0, 16);
}

/**
 * Has this agent stopped making progress on an issue?
 * Two identical outputs in a row means more attempts will not help.
 */
export function isStuck({ attempts = 0, signatures = [] } = {}) {
    if (attempts >= MAX_ATTEMPTS) return { stuck: true, reason: `reached ${attempts}/${MAX_ATTEMPTS} attempts` };
    if (signatures.length >= 2 && signatures[signatures.length - 1] === signatures[signatures.length - 2]) {
        return { stuck: true, reason: 'no progress — two identical patches in a row' };
    }
    return { stuck: false };
}

/**
 * Reconcile the on-disk attempt count against the agent's own comment trail.
 *
 * THE BUG THIS FIXES
 * `autonomy/state/issue-N.json` only ever reaches the repository on the paths
 * that OPEN A PR — .github/workflows/autonomous-fix.yml runs
 * `git add -- autonomy/state` inside the success branches only. When an attempt
 * FAILS, the file is written to the runner's disk and the runner is destroyed.
 * So readState() returned {attempts: 0} on every single run.
 *
 * Issue #71 is the receipt: fifteen attempts between 2 and 5 August, every one
 * of them announcing "attempt 1/3". isStuck() never fired, the `ai-stuck` label
 * was never applied, and the owner's highest-severity bug was retried forever
 * instead of being handed to him — while the file it needed was too large for
 * the agent to rewrite at all.
 *
 * THE SIGNAL WAS ALREADY THERE
 * Every attempt posts a comment carrying `<!-- wf-agent-attempt -->`, and
 * work-queue.mjs has exported attemptsFrom() to count exactly those since the
 * beginning — tested in test/autonomy_test.js and called by nothing. The
 * durable record existed, was correct, and had no consumer, while the code
 * depended on the one copy that could not survive. Reading it needs no new
 * storage and no workflow permission, and it makes #71's fifteen existing
 * comments count immediately.
 *
 * The file is still consulted and the higher of the two wins, so the count
 * cannot go backwards if a comment is ever deleted.
 */
async function reconcileAttempts(number, state) {
    try {
        const trail = await Q.issueComments(number);
        const fromComments = Q.attemptsFrom(trail);
        // A maintainer reset (work-queue.mjs) is the one case where the count may go DOWN.
        if (Q.hasReset(trail) && fromComments !== (state.attempts || 0)) {
            log(`#${number} attempts: a maintainer reset the budget — using ${fromComments} (disk said ${state.attempts || 0})`);
            return { ...state, attempts: fromComments, signatures: [] };
        }
        if (fromComments > (state.attempts || 0)) {
            log(`#${number} attempts: ${state.attempts || 0} on disk, ${fromComments} in the comment trail — using ${fromComments}`);
            return { ...state, attempts: fromComments };
        }
    } catch (e) {
        // Never fatal: a comment-API hiccup must not stop a fix from happening.
        log(`#${number} could not read the comment trail (${e.message}) — using the on-disk count`);
    }
    return state;
}

/** Per-issue attempt history, kept in-repo so it survives across runs. */
function statePath(number) { return path.join(STATE_DIR, `issue-${number}.json`); }
function readState(number) {
    try { return JSON.parse(fs.readFileSync(statePath(number), 'utf8')); } catch { return { attempts: 0, signatures: [] }; }
}
function writeState(number, state) {
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(statePath(number), JSON.stringify(state, null, 2) + '\n');
    } catch (e) { log('could not persist state (non-fatal):', e.message); }
}

/**
 * What the proving test did when it was run, for the "no change made" comment.
 *
 * A proof failure used to say only "the test still fails" and the Vitest output that explained why was
 * thrown away, so the same failure could be re-read on every attempt without anyone seeing its cause.
 * Plain text only, trimmed, in a code fence: it is test output (messages and stack frames), never data.
 */
export function proofEvidence(result = {}) {
    const rounds = Array.isArray(result.testRounds) ? result.testRounds : [];
    const out = String(result.testProof?.output || '').trim();
    const change = String(result.change || '').trim();
    const observed = String(result.observation || '').trim();
    if (!rounds.length && !out && !change && !observed) return '';
    const lines = [];
    if (rounds.length) {
        lines.push('', `**Proving test:** ${rounds.length} ${rounds.length === 1 ? 'try' : 'tries'}, none went from failing to passing:`);
        for (const r of rounds) lines.push(`- try ${r.round}: ${String(r.reason).slice(0, 200)}`);
    }
    if (out) {
        const tail = out.split('\n').slice(-12).join('\n').replace(/`{3,}/g, "'''").slice(-900);
        lines.push('', '**Last Vitest output:**', '```', tail, '```');
    }
    // What the model actually changed, and what the module did before and after: the two facts a reader
    // needs to tell "the patch was wrong" from "the test was wrong" without re-running anything.
    const fence = (t, n) => String(t).replace(/`{3,}/g, "'''").slice(0, n);
    if (change) lines.push('', '<details><summary>The change that was drafted</summary>', '', '```diff', fence(change, 3000), '```', '</details>');
    if (observed) lines.push('', '<details><summary>What the module did before and after (measured)</summary>', '', '```', fence(observed, 2500), '```', '</details>');
    return lines.join('\n') + '\n';
}

/**
 * The PR description the agent writes for a drafted fix.
 *
 * Exported and pure so its central claim can be tested rather than eyeballed.
 * That claim is the whole reason this function exists separately: for PRs #67,
 * #72, #73, #75 and #76 the body said "**Proving test:** `file` written by
 * Agent 4 (QA)" — perfectly true, and worthless, because not one of those tests
 * had ever executed. Since #78 the candidate is run red→green before a PR is
 * drafted, so the body must distinguish "a test exists" from "a test proved
 * something". A verification a reviewer cannot see is a verification that
 * changes nobody's decision — the same computed-and-never-consumed defect this
 * pipeline keeps producing, one level up.
 */
export function prBody({ issue = {}, number, result = {}, testWritten = null, ledger = '' } = {}) {
    const provs = result.providers || {};
    return [
        '## Autonomous fix',
        '',
        `Closes #${number}`,
        '',
        `**Authored by:** ${result.role} agent via \`${provs.author}\``,
        `**Independently reviewed by:** Agent 5 (Chaos Security) via \`${provs.security || 'unavailable'}\``,
        `**Security verdict:** ${result.review?.verdict || 'n/a'}${result.review?.reason ? ` — ${result.review.reason}` : ''}`,
        result.lane === 'build'
            ? `**New module:** \`${result.file}\` — ${result.change || ''}. It can read the books and show things; it cannot write them (a machine refuses \`DB.set\`, Firebase calls, eval, script injection and secrets).`
            : result.lane === 'layout'
            ? `**Proof:** measured in real Chromium on invented books at ${(result.layout?.widths || []).join(', ')}px wide, before and after: **${String(result.layout?.verdict || '').toUpperCase()}** (${result.layout?.reason || ''}). This is a measurement, not a person looking at a phone.`
            : testWritten && result.verified
            ? `**Proving test:** \`${testWritten}\` by Agent 4 (QA) via \`${provs.qa}\` — executed and verified: it FAILS against the original file and PASSES against this one.${result.mutation && !result.mutation.skipped ? ` Sabotage check: it caught ${result.mutation.killed} of ${result.mutation.total} deliberately broken versions of the fix${result.mutation.weak ? ' (weak: treat the test as thin evidence)' : ''}.` : ''}`
            : testWritten
                ? `**Proving test:** \`${testWritten}\` by Agent 4 (QA) via \`${provs.qa}\` — [WARNING] NOT verified red→green. Do not treat it as evidence.`
                : '**Proving test:** none — this PR needs human review before merge.',
        '',
        '### Issue',
        '> ' + String(issue.title || '').replace(/\n/g, '\n> '),
        '',
        ...(result.lane === 'layout' ? [
            '### Measured before the change', '```', String(result.layout?.before || '').replace(/`{3,}/g, "'''").slice(0, 1800), '```',
            '### Measured after the change', '```', String(result.layout?.after || '').replace(/`{3,}/g, "'''").slice(0, 1200), '```',
            '',
        ] : []),
        '### Gates already passed before this PR existed',
        '- Structural check (truncation, placeholders, new `eval`/`innerHTML` sinks, brace balance)',
        result.lane === 'layout'
            ? '- The CSS passed a strict reader: every selector names the one screen, layout properties only, no hiding, no url(), size capped'
            : '- `node --check` parse of the rewritten file',
        '- Independent security review on a different model provider than the author',
        result.lane === 'layout'
            ? '- **The screen was measured twice** in a real browser: the overlap was found before, and is gone or reduced after'
            : result.verified
            ? '- **The proving test was executed twice** — red against the original file, green against this one'
            : '- [WARNING] The proving test was NOT executed red→green',
        result.lane === 'build'
            ? '- Guarded paths touched: `index.html` (one added script line) and `autonomy/perf-budget.mjs` (ceilings raised to the measured value), so `human-approved` is required. No auth, crypto, money, rules, service-worker, dependency or CI file.'
            : '- Sensitive-path gate: this change touches no auth, crypto, money, rules, service-worker, dependency, or CI file',
        '',
        '### Still to pass in CI',
        'Full test suite · multi-model consensus review · OPA/Conftest policy gate · fuzz gate if applicable.',
        ...(ledger ? ['', ledger] : []),
        FOOTER,
    ].join('\n');
}

/**
 * The three program-written sections at the end of an agent pull request: the task card (what the work was held to), the
 * independent analysis (a model's opinion, labelled), and the evidence ledger (what a program verified, with the computed
 * confidence and the decision record). Never throws: a failure here must not lose the pull request.
 */
export function ledgerFor({ result = {}, laneName = 'swarm', kind = 'bug', issue = {}, shot = null, translation = null, testWritten = null, rulesShown = [] } = {}) {
    let card = result.card || null;
    try { card = card || taskCard({ issue, role: kind, lane: laneName, file: result.file || '', text: `${issue.title || ''}` }); } catch (_) { card = null; }
    const analysis = result.analysis || null;
    let ledger = '';
    try {
        ledger = evidenceLedger({ result, shot: shot && shot.status === 'none' ? null : shot, translation, testWritten, rules: rulesShown, card, analysis, reportText: `${issue.title || ''}\n${(shot && shot.body) || issue.body || ''}` }).markdown;
    } catch (_) { ledger = '### Evidence ledger\n_The ledger could not be written; read the checks above._'; }
    return [card ? cardMarkdown(card) : '', analysis ? analysisMarkdown(analysis) : '', ledger].filter(Boolean).join('\n\n');
}

async function main() {
    // ── preflight: prove we can actually work, and say so plainly ──────────
    const llm = describeAvailability();
    if (!llm.healthy) {
        fail(
            'No LLM provider is configured, so no fix can be authored.\n\n' +
            'Set ANY ONE of these repository secrets and the system starts working:\n' +
            '`CEREBRAS_API_KEY`, `GROQ_API_KEY`, `WealthFlow_API_Key` (Gemini), `DEEPSEEK_API_KEY`, ' +
            '`MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, ' +
            '`FIREWORKS_API_KEY`, `NVIDIA_API_KEY`, `SAMBANOVA_API_KEY`, `GITHUB_MODELS_TOKEN`, ' +
            '`HUGGINGFACE_API_KEY`, `COHERE_API_KEY`, `ANTHROPIC_API_KEY`.\n\n' +
            'This exact misconfiguration (a key named `WealthFlow_API_Key` while the agent read ' +
            '`GEMINI_API_KEY`) is what silently disabled the autonomous update system.'
        );
    }
    if (!Q.tokenFrom()) fail('No GITHUB_TOKEN / GH_PAT — the agent cannot read its work queue.');
    if (!Q.repoFrom()) fail('No GITHUB_REPOSITORY — cannot tell which repo to work on.');

    log(`${llm.count} LLM provider(s) available: ${llm.providers.map((p) => `${p.id}(${p.via})`).join(', ')}`);

    // ── load the queue ──────────────────────────────────────────────────────
    await Q.ensureCoreLabels().catch((e) => log('label bootstrap skipped:', e.message));

    let queue;
    try {
        queue = await Q.loadQueue({ limit: 30 });
    } catch (e) {
        fail(`Could not read the work queue: ${e.message}`);
    }

    const pinned = process.env.AGENT_ISSUE && Number(process.env.AGENT_ISSUE);
    let candidates = queue.issues;
    if (pinned) {
        candidates = candidates.filter((i) => i.number === pinned);
        if (!candidates.length) {
            // The `issues:` trigger pins this run to the issue that fired it, so
            // an `opened` and a `labeled` event on the SAME issue both land here.
            // If the first already opened a fix PR, this run must NOT open a
            // duplicate — that is exactly how issue #3 got PR #4 AND PR #5. An
            // already-handled issue is a genuine no-op, not a misconfiguration.
            const claimed = await Q.issuesWithOpenFixPr().catch(() => new Set());
            if (claimed.has(pinned)) {
                log(`#${pinned} already has an open fix PR — not opening a duplicate.`);
                summary(
                    `### [OK] Issue #${pinned} is already being handled\n\n` +
                    'An autonomous fix PR for this issue is already open. This run stopped ' +
                    'rather than open a second PR for the same issue (the duplicate that the ' +
                    'first live run produced). This is a no-op, not a failure.\n'
                );
                output({ have: 'no', reason: 'issue already has an open fix PR' });
                process.exit(3);
            }
            fail(`Issue #${pinned} is not in the open, workable queue.`);
        }
    }

    if (!candidates.length) {
        log('queue is empty — nothing to fix right now.');
        summary(
            '### [OK] Autonomous agent ran — queue empty\n\n' +
            `${llm.count} LLM provider(s) ready. No open, workable issues.\n\n` +
            'This is a genuine no-op, not a crash: the agent reached the queue and found it clear. ' +
            'Send feedback in the app, or open an issue, and the next run will pick it up.\n'
        );
        output({ have: 'no', reason: 'queue empty' });
        process.exit(3);
    }

    // FIRESTORE PROPOSALS ARE FETCHED AND NOT WORKED, AND THE LOG NOW SAYS SO.
    // work-queue.mjs connects to Firestore, reads system/pendingRelease, and
    // maps proposedChanges into fully-formed work items. This line was the only
    // place `queue.proposals` was ever referenced: it printed the count and the
    // agent then iterated `queue.issues` alone. The module docstring claims the
    // proposals are "folded in". They are counted.
    //
    // They cannot simply be folded in either — every proposal carries
    // number: null, and the loop below uses that number for the attempt state
    // file, the issue comments, the labels and the `Closes #N` link. Merging
    // them as-is would break all four. Turning a proposal into a real GitHub
    // issue first is the only shape that works, and that is a behaviour change
    // the owner decides, not something to slip in under an audit.
    //
    // So: say plainly that they are being ignored, and why. A count printed
    // beside "workable issue(s)" read as though they were queued.
    if (queue.proposals.length) {
        log(`${candidates.length} workable issue(s). NOTE: ${queue.proposals.length} Firestore proposal(s) were read but NOT worked — `
            + 'a proposal has no issue number, so it cannot carry attempt state, comments or a Closes link. '
            + 'File it as a GitHub issue to have it actioned.');
        summary(`### [WARNING] ${queue.proposals.length} Firestore proposal(s) ignored\n\n`
            + 'They were read from `system/pendingRelease` but the agent only works GitHub Issues. '
            + 'A proposal has no issue number, so it cannot carry attempt state, comments or a `Closes` link.\n');
    } else {
        log(`${candidates.length} workable issue(s); 0 Firestore proposal(s)`);
    }

    // ── work the highest-priority issue we can actually move ────────────────
    const skipped = [];
    const done = [];                 // fixes written this run; more than one only for feedback filed on the same day
    let groupNumbers = null;
    for (let ci = 0; ci < candidates.length; ci++) {
        const issue0 = candidates[ci];
        // after the first fix, only that day's feedback rides along, and only while there is time to do it well
        if (groupNumbers && (!groupNumbers.has(issue0.number) || Date.now() - STARTED > GROUP_BUDGET_MS)) continue;
        let issue = issue0;
        const number = issue.number;
        const state = await reconcileAttempts(number, readState(number));

        const stuck = isStuck(state);
        if (stuck.stuck) {
            log(`#${number} is stuck (${stuck.reason}) — handing to a human`);
            if (!DRY) {
                await Q.addLabels(number, [Q.LABELS.stuck]).catch(() => {});
                await Q.comment(number,
                    `### [ERROR] Autonomous agent is standing down\n\n` +
                    `**Reason:** ${stuck.reason}\n\n` +
                    `I have tried ${state.attempts} time(s) and am not converging on a safe fix. ` +
                    `Rather than keep churning and opening near-identical pull requests, I am labelling this ` +
                    `\`${Q.LABELS.stuck}\` so a human can take a look. Remove that label to let me retry.\n` +
                    FOOTER
                ).catch(() => {});
            }
            skipped.push(`#${number} stuck`);
            continue;
        }

        // A burst of `issues` events (opened + one `labeled` per label) must not spend the attempt budget in
        // seconds on input that cannot have changed. A person dispatching the workflow, or the schedule, is
        // never held back by this.
        if (process.env.GITHUB_EVENT_NAME === 'issues' && !DRY) {
            const age = Q.lastAttemptAgeMs(await Q.issueComments(number).catch(() => []));
            if (age !== null && age < ATTEMPT_COOLDOWN_MS) {
                log(`#${number} was attempted ${Math.round(age / 1000)}s ago and nothing has changed since — not spending another attempt on this event.`);
                skipped.push(`#${number} attempted ${Math.round(age / 1000)}s ago`);
                continue;
            }
        }

        // A report written in another language (Sinhala, Tamil, ...) that was filed without an English reading gets one now, so the
        // English-only routers (role, layout lane, build lane, concept board) read what the owner meant. Never fatal.
        let translation = null;
        try {
            const tr = await withTranslation(issue);
            if (tr.status !== 'none') log(`#${number} language: ${tr.note}`);
            translation = { status: tr.status, note: tr.note };
            issue = tr.issue;
        } catch (e) { log(`#${number} translation step failed (${e.message}) — working from the original words`); }

        const kind = Q.roleFor(issue);
        log(`attempting #${number} [${Q.severityOf(issue)}/${kind}]: ${String(issue.title).slice(0, 80)}`);

        // The report's screenshot, read by a vision model and taken out of the text the
        // other agents see (it is 40,000 characters of base64, and it was never read at all
        // before issue #514). Never fatal: with no vision key the report is worked from text.
        let shot = { body: issue.body, status: 'none', note: '' };
        try {
            shot = await screenshotContext({ issue, repoDir: REPO_DIR, log });
            if (shot.status !== 'none') log(`#${number} screenshot: ${shot.status} — ${shot.note}`);
        } catch (e) { log(`#${number} screenshot step failed (${e.message}) — working from the text`); }

        // If an earlier fix for this report was opened as a PR and failed in CI, the recovery job wrote why on the issue.
        // The author is told, so the retry changes its approach instead of repeating the failure. The routing below keeps
        // reading the report's own words, so a check name in that text cannot send the issue to a different lane.
        let retryBrief = '';
        // What the earlier tries on this report did and where each stopped (autonomy/route.mjs). #559 was tried three times
        // in the same lane with the same result, because the second try was never told what the first had ruled out.
        let trail = [];
        try {
            const comments = await Q.issueComments(number);
            retryBrief = recoveryBrief(comments);
            trail = attemptTrail(comments);
        } catch (_) { /* no trail, no brief */ }
        if (retryBrief) log(`#${number} an earlier fix failed in CI — the author is shown why`);
        const triedBrief = attemptBrief(trail);
        if (triedBrief) log(`#${number} ${trail.length} earlier ${trail.length === 1 ? 'try is' : 'tries are'} shown to the author so this one differs`);

        let result;
        let rulesShown = [];
        let laneName = 'swarm';
        try {
            // A report about how a screen LOOKS (overlap, cut-off, a phone width) has no JavaScript to fix or to
            // test, so it goes to the layout lane: CSS only, measured in a real browser before and after.
            const lane = layoutLaneFor({ title: issue.title, body: shot.body, labels: issue.labels });
            // A measurement that found nothing is evidence. If an earlier try already measured the pages and found no layout
            // problem, the layout lane cannot end differently this time, so the report is worked as code instead
            // (a finding the system measured itself keeps its lane: its marker names the screen).
            if (lane.applies && !lane.marked && laneRuledOut(trail, 'layout')) {
                log(`#${number} an earlier try measured the pages and found nothing to fix in the layout — working it as code this time`);
                lane.applies = false;
            }
            if (lane.applies) { laneName = 'layout'; log(`#${number} goes to the layout lane (${lane.why})`); }
            // A NEW idea is talked through by several AIs first (user-friendliness first); their brief joins the request, and
            // the discussion is posted once on the issue. It never blocks: the owner's request is the decision.
            let laneBody = shot.body;
            if (!lane.applies && conceptBoardFor({ title: issue.title, body: shot.body }, kind)) {
                try {
                    const prior = (await Q.issueComments(number).catch(() => [])).find((c) => String(c.body || '').includes(BOARD_MARKER));
                    let board = prior ? parseStoredBoard(prior.body) : null;
                    if (!board) {
                        board = await runConceptBoard({ issueText: `${issue.title}\n\n${shot.body}`, log });
                        if (board.voters && !DRY) await Q.comment(number, boardComment(board)).catch(() => {});
                    }
                    laneBody = shot.body + briefFor(board);
                } catch (e) { log(`#${number} concept board skipped (${e.message})`); }
            }
            // Something NEW (an integration, a new calculator or page) has no existing module to edit, so it goes to the
            // build lane first; and a feature the one-file swarm could not place falls through to it as well.
            const build = buildLaneFor({ title: issue.title, body: shot.body });
            laneBody += retryBrief;   // why an earlier fix failed in CI, if one did (autonomy/pr-recovery.mjs)
            laneBody += triedBrief;   // what the earlier tries ruled out, so this one does not repeat them
            // Rules this repository already paid for (autonomy/lessons.mjs): shown to the author, never used for routing.
            const standing = lessonsBrief(`${issue.title}\n${String(shot.body).slice(0, 6000)}${retryBrief}`);
            rulesShown = lessonsFor(`${issue.title}\n${String(shot.body).slice(0, 6000)}${retryBrief}`).map((l) => l.id);
            if (standing) log(`#${number} standing rules shown: ${rulesShown.join(', ')}`);
            laneBody += standing;
            const buildIt = () => runBuildLane({ issue: { number, title: issue.title, body: laneBody }, repoDir: REPO_DIR, log });
            const asCode = () => runSwarm({
                issue: { number, title: issue.title, body: laneBody, kind },
                repoDir: REPO_DIR, log,
                // an independent second mind on the cause, the alternatives and the ways it could fail (part 9, 14 of the owner's prompt)
                analyse: (ctx) => runAnalysis({ ...ctx, log }),
            });
            if (lane.applies) {
                result = await runLayoutLane({ issue: { number, title: issue.title, body: shot.body + retryBrief + triedBrief + standing }, repoDir: REPO_DIR, log });
                // The words sounded like a layout complaint, the pages were measured, and nothing is wrong with the layout.
                // If the report reads as a defect or a request ("on my phone the total is wrong"), the layout word was
                // incidental: work it as code in this same try instead of spending the next two on the same measurement.
                if (nothingToMeasure(result) && !lane.marked && kind !== 'ui') {
                    log(`#${number} the pages show no layout problem and the report reads as "${kind}" — working it as code in this same try`);
                    const measured = result.reason;
                    laneName = 'swarm';
                    result = await asCode();
                    if (!result.ok) result = { ...result, reason: `${result.reason} | layout lane first: ${String(measured).slice(0, 160)}` };
                }
            } else if (build.applies) {
                laneName = 'build';
                log(`#${number} goes to the build lane (${build.why})`);
                result = await buildIt();
            } else {
                result = await asCode();
                if (!result.ok && kind === 'feature' && (result.stage === 'select' || result.stage === 'author')) {
                    log(`#${number} no existing module could take it (${result.stage}) — trying the build lane`);
                    const built = await buildIt();
                    if (built.ok) laneName = 'build';
                    result = built.ok ? built : { ...result, reason: `${result.reason} | build lane: ${built.reason}` };
                }
            }
        } catch (e) {
            // A provider outage is not the agent's fault, but it must be visible.
            log(`#${number} swarm error: ${e.message}`);
            skipped.push(`#${number} swarm error: ${e.message.slice(0, 120)}`);
            continue;
        }

        if (!result.ok) {
            log(`#${number} not actionable at stage "${result.stage}": ${result.reason}`);
            state.attempts += 1;
            writeState(number, state);
            if (!DRY) {
                await Q.comment(number,
                    `<!-- wf-agent-attempt -->\n` +
                    `### [AI] Autonomous attempt ${state.attempts}/${MAX_ATTEMPTS} — no change made\n\n` +
                    `**Lane:** \`${laneName}\`\n` +
                    `**Stopped at:** \`${result.stage}\`\n` +
                    `**Why:** ${result.reason}\n` +
                    (result.file ? `**File considered:** \`${result.file}\`\n` : '') +
                    (shot.note ? `**Screenshot:** ${shot.note}\n` : '') +
                    (result.review?.findings?.length ? `\n**Reviewer findings:**\n${result.review.findings.map((f) => `- ${f}`).join('\n')}\n` : '') +
                    proofEvidence(result) +
                    `\nNothing was committed. I will try again on the next scheduled run.\n` +
                    FOOTER
                ).catch(() => {});
            }
            skipped.push(`#${number} ${result.stage}: ${String(result.reason).slice(0, 100)}`);
            continue;
        }

        // ── we have a validated candidate ───────────────────────────────────
        const sig = signature(result.code);
        state.attempts += 1;
        state.signatures = [...(state.signatures || []), sig].slice(-5);
        writeState(number, state);

        if (DRY) {
            log(`[dry-run] would write ${result.file} (+${result.testFile || 'no test'})`);
            output({ have: 'no', reason: 'dry run' });
            process.exit(3);
        }

        fs.writeFileSync(path.join(REPO_DIR, result.file),
            result.code.endsWith('\n') ? result.code : result.code + '\n');
        log(`wrote ${result.file}`);

        // A NEW module is put on the page by a mechanical edit, never a model-written one (see build-lane.mjs).
        let extraFiles = [], wiringNote = '';
        if (result.lane === 'build' && result.wire) {
            const w = wireModule({ repoDir: REPO_DIR, name: result.wire.name, issue: number });
            if (!w.ok) {
                log(`#${number} the new module could not be put on the page: ${w.reason}`);
                try { fs.unlinkSync(path.join(REPO_DIR, result.file)); } catch { /* nothing written */ }
                skipped.push(`#${number} wiring: ${w.reason}`);
                continue;
            }
            extraFiles = w.files;
            wiringNote = `Put on the page by a mechanical edit: ${w.files.join(', ')}${w.raised.length ? ` (payload ceilings raised: ${w.raised.join('; ')})` : ''}.`;
            log(wiringNote);
        }

        let testWritten = null;
        if (result.test && result.testFile) {
            const tp = path.join(REPO_DIR, result.testFile);
            fs.mkdirSync(path.dirname(tp), { recursive: true });
            fs.writeFileSync(tp, result.test.endsWith('\n') ? result.test : result.test + '\n');
            testWritten = result.testFile;
            log(`wrote ${result.testFile}`);
        }

        const provs = result.providers || {};
        const pr = {
            title: `fix: ${String(issue.title).replace(/^\[(critical|high|medium|low)\]\s*/i, '').slice(0, 68)}`,
            file: result.file,
            testFile: testWritten,
            extraFiles,
            issue: number,
            role: result.role,
            providers: provs,
            body: prBody({ issue, number, result, testWritten, ledger: ledgerFor({ result, laneName, kind, issue, shot, translation, testWritten, rulesShown }) }) + (wiringNote ? `\n\n### Wiring\n${wiringNote}\n` : ''),
        };
        fs.writeFileSync(OUTPUT, JSON.stringify(pr, null, 2) + '\n');

        summary(
            `### [AI] Autonomous fix drafted for #${number}\n\n` +
            `| | |\n|---|---|\n` +
            `| Issue | #${number} — ${String(issue.title).slice(0, 70)} |\n` +
            `| Role | ${result.role} |\n` +
            `| File | \`${result.file}\` |\n` +
            `| Test | ${testWritten ? `\`${testWritten}\`` : '_none_'} |\n` +
            `| Test verified red→green | ${result.verified ? 'yes' : '**no**'} |\n` +
            `| Author model | \`${provs.author}\` |\n` +
            `| Reviewer model | \`${provs.security || 'unavailable'}\` |\n` +
            `| Attempt | ${state.attempts}/${MAX_ATTEMPTS} |\n`
        );

        if (!DRY) {
            await Q.addLabels(number, [Q.LABELS.inProgress]).catch(() => {});
            await Q.comment(number,
                `<!-- wf-agent-attempt -->\n` +
                `### [AI] Fix drafted (attempt ${state.attempts}/${MAX_ATTEMPTS})\n\n` +
                `I changed \`${result.file}\`${testWritten ? ` and added \`${testWritten}\`` : ''}.\n\n` +
                `- **Author:** ${result.role} agent via \`${provs.author}\`\n` +
                `- **Security review:** ${result.review?.verdict} via \`${provs.security || 'unavailable'}\`\n` +
                (shot.note ? `- **Screenshot:** ${shot.note}\n` : '') +
                `${result.review?.findings?.length ? `- **Noted:** ${result.review.findings.join('; ')}\n` : ''}` +
                `\nCI will now test it. If everything passes it ships automatically and I will report back here.\n` +
                FOOTER
            ).catch(() => {});
        }

        done.push({ issue, number, pr });
        if (done.length === 1 && GROUP && !DRY) {
            // Who else filed feedback on this report's day? They are worked next, on top of this fix, and ship in the same update.
            const sib = siblingsOf(issue, queue.issues);
            if (sib.length) {
                log(`#${number}: ${sib.length} more report(s) from the same day will ride in this update: ${sib.map((i) => '#' + i.number).join(', ')}`);
                groupNumbers = new Set(sib.map((i) => i.number));
                candidates = sib;
                ci = -1;
            }
        }
    }

    if (done.length) {
        const first = done[0].pr;
        const group = done.map((d) => ({ issue: d.number, title: d.issue.title, file: d.pr.file, testFile: d.pr.testFile, extraFiles: d.pr.extraFiles || [] }));
        const out = done.length === 1 ? { ...first, group } : {
            ...first, group,
            title: groupTitle(done.map((d) => d.issue)),
            issues: done.map((d) => d.number),
            body: `This update fixes ${done.length} reports filed on the same day (#${done.map((d) => d.number).join(', #')}).\n\n` +
                done.map((d) => `## #${d.number}\n\n${d.pr.body}`).join('\n\n---\n\n'),
        };
        fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2) + '\n');
        output({ have: 'yes', file: first.file, test: first.testFile || '', issue: String(first.issue), issues: done.map((d) => d.number).join(','), role: first.role });
        log(`done — ${done.length} fix(es) in one update; exit 0 so the workflow validates and ships this`);
        process.exit(0);
    }

    // ── nothing was actionable ──────────────────────────────────────────────
    log('no issue could be safely progressed this run');
    summary(
        '### [WARNING] Autonomous agent ran but produced no change\n\n' +
        `Examined ${candidates.length} issue(s):\n\n` +
        skipped.map((s) => `- ${s}`).join('\n') +
        '\n\nThis is reported honestly rather than as a success. If the same reason repeats, ' +
        'the liveness watchdog will open an issue about it.\n'
    );
    output({ have: 'no', reason: skipped.slice(0, 3).join(' | ') || 'nothing actionable' });
    process.exit(3);
}

const FOOTER = '\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_';

// Only run when executed directly, so the helpers stay unit-testable.
const invokedDirectly = (() => {
    try {
        return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
    } catch { return false; }
})();

if (invokedDirectly) {
    main().catch((e) => {
        console.error('[agent] [INFO] unhandled failure:', e && e.stack || e);
        summary(`### [ERROR] Autonomous agent crashed\n\n\`\`\`\n${String(e && e.message || e).slice(0, 1500)}\n\`\`\`\n`);
        process.exit(1);        // NOT 78 — a crash must never look like success
    });
}
