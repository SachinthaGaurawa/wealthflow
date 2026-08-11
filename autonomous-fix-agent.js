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
import * as Q from './autonomy/work-queue.mjs';

const MAX_ATTEMPTS = Number(process.env.AGENT_MAX_ATTEMPTS || 3);
const DRY = /^(1|true|yes)$/i.test(process.env.AGENT_DRY_RUN || '');
const REPO_DIR = process.env.REPO_DIR || process.cwd();
const STATE_DIR = path.join(REPO_DIR, 'autonomy', 'state');
const OUTPUT = path.join(REPO_DIR, 'ai-fix-pr.json');

function log(...m) { console.log('[agent]', ...m); }
function fail(msg) {
    console.error('[agent] ✗ MISCONFIGURED: ' + msg);
    summary(`### ❌ Autonomous agent could not run\n\n${msg}\n`);
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
        const fromComments = Q.attemptsFrom(await Q.issueComments(number));
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
export function prBody({ issue = {}, number, result = {}, testWritten = null } = {}) {
    const provs = result.providers || {};
    return [
        '## Autonomous fix',
        '',
        `Closes #${number}`,
        '',
        `**Authored by:** ${result.role} agent via \`${provs.author}\``,
        `**Independently reviewed by:** Agent 5 (Chaos Security) via \`${provs.security || 'unavailable'}\``,
        `**Security verdict:** ${result.review?.verdict || 'n/a'}${result.review?.reason ? ` — ${result.review.reason}` : ''}`,
        testWritten && result.verified
            ? `**Proving test:** \`${testWritten}\` by Agent 4 (QA) via \`${provs.qa}\` — executed and verified: it FAILS against the original file and PASSES against this one.`
            : testWritten
                ? `**Proving test:** \`${testWritten}\` by Agent 4 (QA) via \`${provs.qa}\` — ⚠️ NOT verified red→green. Do not treat it as evidence.`
                : '**Proving test:** none — this PR needs human review before merge.',
        '',
        '### Issue',
        '> ' + String(issue.title || '').replace(/\n/g, '\n> '),
        '',
        '### Gates already passed before this PR existed',
        '- Structural check (truncation, placeholders, new `eval`/`innerHTML` sinks, brace balance)',
        '- `node --check` parse of the rewritten file',
        '- Independent security review on a different model provider than the author',
        result.verified
            ? '- **The proving test was executed twice** — red against the original file, green against this one'
            : '- ⚠️ The proving test was NOT executed red→green',
        '- Sensitive-path gate: this change touches no auth, crypto, money, rules, service-worker, dependency, or CI file',
        '',
        '### Still to pass in CI',
        'Full test suite · multi-model consensus review · OPA/Conftest policy gate · fuzz gate if applicable.',
        FOOTER,
    ].join('\n');
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
                    `### ✅ Issue #${pinned} is already being handled\n\n` +
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
            '### ✅ Autonomous agent ran — queue empty\n\n' +
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
        summary(`### ⚠️ ${queue.proposals.length} Firestore proposal(s) ignored\n\n`
            + 'They were read from `system/pendingRelease` but the agent only works GitHub Issues. '
            + 'A proposal has no issue number, so it cannot carry attempt state, comments or a `Closes` link.\n');
    } else {
        log(`${candidates.length} workable issue(s); 0 Firestore proposal(s)`);
    }

    // ── work the highest-priority issue we can actually move ────────────────
    const skipped = [];
    for (const issue of candidates) {
        const number = issue.number;
        const state = await reconcileAttempts(number, readState(number));

        const stuck = isStuck(state);
        if (stuck.stuck) {
            log(`#${number} is stuck (${stuck.reason}) — handing to a human`);
            if (!DRY) {
                await Q.addLabels(number, [Q.LABELS.stuck]).catch(() => {});
                await Q.comment(number,
                    `### 🛑 Autonomous agent is standing down\n\n` +
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

        const kind = Q.roleFor(issue);
        log(`attempting #${number} [${Q.severityOf(issue)}/${kind}]: ${String(issue.title).slice(0, 80)}`);

        let result;
        try {
            result = await runSwarm({
                issue: { number, title: issue.title, body: issue.body, kind },
                repoDir: REPO_DIR, log,
            });
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
                    `### 🤖 Autonomous attempt ${state.attempts}/${MAX_ATTEMPTS} — no change made\n\n` +
                    `**Stopped at:** \`${result.stage}\`\n` +
                    `**Why:** ${result.reason}\n` +
                    (result.file ? `**File considered:** \`${result.file}\`\n` : '') +
                    (result.review?.findings?.length ? `\n**Reviewer findings:**\n${result.review.findings.map((f) => `- ${f}`).join('\n')}\n` : '') +
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
            issue: number,
            role: result.role,
            providers: provs,
            body: prBody({ issue, number, result, testWritten }),
        };
        fs.writeFileSync(OUTPUT, JSON.stringify(pr, null, 2) + '\n');

        summary(
            `### 🤖 Autonomous fix drafted for #${number}\n\n` +
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
                `### 🤖 Fix drafted (attempt ${state.attempts}/${MAX_ATTEMPTS})\n\n` +
                `I changed \`${result.file}\`${testWritten ? ` and added \`${testWritten}\`` : ''}.\n\n` +
                `- **Author:** ${result.role} agent via \`${provs.author}\`\n` +
                `- **Security review:** ${result.review?.verdict} via \`${provs.security || 'unavailable'}\`\n` +
                `${result.review?.findings?.length ? `- **Noted:** ${result.review.findings.join('; ')}\n` : ''}` +
                `\nCI will now test it. If everything passes it ships automatically and I will report back here.\n` +
                FOOTER
            ).catch(() => {});
        }

        output({ have: 'yes', file: result.file, test: testWritten || '', issue: String(number), role: result.role });
        log('done — exit 0 so the workflow validates and ships this');
        process.exit(0);
    }

    // ── nothing was actionable ──────────────────────────────────────────────
    log('no issue could be safely progressed this run');
    summary(
        '### ⚠️ Autonomous agent ran but produced no change\n\n' +
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
        console.error('[agent] ✗ unhandled failure:', e && e.stack || e);
        summary(`### ❌ Autonomous agent crashed\n\n\`\`\`\n${String(e && e.message || e).slice(0, 1500)}\n\`\`\`\n`);
        process.exit(1);        // NOT 78 — a crash must never look like success
    });
}
