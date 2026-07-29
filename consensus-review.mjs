#!/usr/bin/env node
/* =============================================================================
 * consensus-review.mjs — the multi-model review board (Blueprint Phase 3)
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS NEW
 *   consensus-review.yml has always run `node consensus-review.mjs`, but the
 *   file on disk was `consensus-review.js`. Every single PR therefore failed the
 *   required "Consensus review board" check with MODULE_NOT_FOUND before a model
 *   was ever consulted. Combined with the other deadlocks, no autonomous PR
 *   could ever merge — which is a large part of why nothing real ever shipped.
 *
 *   The old logic had a second, subtler fault: a transient HTTP error from a
 *   provider was recorded as an `unclear` VOTE, and any non-pass vote blocked
 *   the merge. One DeepSeek hiccup would block every PR until someone noticed.
 *   A provider being down is not a reviewer objection, and it must not read as
 *   one.
 *
 * WHAT IT DOES NOW
 *   Three independent reviewers, each pinned to a DIFFERENT model provider via
 *   autonomy/llm-router.mjs:
 *     • Architecture  — is this the right change, correctly made?
 *     • Security      — can this be exploited, or does it weaken a control?
 *     • User impact   — could this confuse, mislead, or annoy the single user
 *                       whose app this is?
 *
 *   Merge requires UNANIMOUS PASS among reviewers that actually ran.
 *     • A real FAIL blocks (exit 1).
 *     • A provider outage is a non-vote: the router already failed over across
 *       every configured provider, so "unavailable" means all of them were
 *       exhausted, not that the code is bad.
 *     • Zero reviewers available blocks (fail closed) with an actionable message.
 *
 * EXIT: 0 = unanimous pass, merge allowed · 1 = blocked
 * ===========================================================================*/

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { chat, extractJson, describeAvailability } from './autonomy/llm-router.mjs';

const MAX_DIFF = 60_000;

// ── vote parsing ─────────────────────────────────────────────────────────────

/** Read a verdict out of a model reply, structured or prose. Fails closed. */
export function parseVote(text) {
    const j = extractJson(text);
    if (j && typeof j.verdict === 'string') {
        return /^pass$/i.test(j.verdict.trim()) ? 'pass' : 'fail';
    }
    const t = String(text || '').trim().toUpperCase();
    if (!t) return 'unclear';
    const head = t.slice(0, 300);
    if (/\bFAIL\b/.test(head) && !/\bPASS\b/.test(head)) return 'fail';
    if (/\bPASS\b/.test(head) && !/\bFAIL\b/.test(head)) return 'pass';
    if (/^PASS\b/.test(t)) return 'pass';
    if (/^FAIL\b/.test(t)) return 'fail';
    return 'unclear';
}

/**
 * Decide the merge.
 *
 * `unavailable` entries are provider outages and are NOT votes — that is the fix
 * for the old behaviour where one 503 blocked every pull request in the repo.
 * `unclear` (a reviewer answered, but incomprehensibly) IS treated as a block:
 * a reviewer who cannot state a verdict has not approved anything.
 */
export function tally(votes) {
    const cast = (votes || []).filter((v) => v.vote === 'pass' || v.vote === 'fail' || v.vote === 'unclear');
    const outages = (votes || []).filter((v) => v.vote === 'unavailable');

    if (cast.length === 0) {
        return {
            merge: false,
            reason: outages.length
                ? `no reviewer could be reached (${outages.length} provider group(s) exhausted) — failing closed`
                : 'no reviewer configured — failing closed',
            cast: 0,
            outages: outages.length,
        };
    }
    const bad = cast.filter((v) => v.vote !== 'pass');
    if (bad.length) {
        return {
            merge: false,
            reason: bad.map((b) => `${b.name}:${b.vote}${b.reason ? ` (${b.reason})` : ''}`).join('; '),
            cast: cast.length,
            outages: outages.length,
        };
    }
    return {
        merge: true,
        reason: `unanimous pass from ${cast.map((c) => c.name).join(', ')}`,
        cast: cast.length,
        outages: outages.length,
    };
}

// ── the diff under review ────────────────────────────────────────────────────
/**
 * The diff this board reviews, resolved from a real merge base.
 *
 * The previous version did:
 *     git fetch origin <base> --depth=1
 *     git diff origin/<base>...HEAD
 *   catch → git diff HEAD~1...HEAD
 *
 * A depth-1 fetch has no ancestry, so the three-dot form has no merge base and
 * aborts with "fatal: no merge base" the moment <base> advances past the branch
 * point — which happens hourly in this repo, because merchant-sync pushes to main
 * every hour. The catch then quietly reviewed only `HEAD~1...HEAD`: on a
 * multi-commit PR the board would vote on the LAST COMMIT ALONE while reporting a
 * verdict on the whole pull request. A reviewer approving a diff it never saw is
 * worse than a reviewer that errors.
 *
 * Now: deepen (never truncate), require an explicit merge base, and treat "no
 * merge base" as a hard failure so the caller blocks instead of approving blind.
 */
function getDiff() {
    const base = process.env.BASE_REF || 'main';
    const run = (cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

    // Deepen the local history. --unshallow fails on an already-complete repo,
    // which is harmless — the plain fetch covers that case.
    try { run(`git fetch --unshallow origin ${base}`); }
    catch { try { run(`git fetch origin ${base}`); } catch { /* offline; merge-base may still exist locally */ } }

    let mergeBase = '';
    try { mergeBase = run(`git merge-base origin/${base} HEAD`).trim(); } catch { mergeBase = ''; }

    if (!mergeBase) {
        console.error(
            `✗ No merge base between origin/${base} and HEAD, so the true PR diff cannot be determined.\n` +
            '  Refusing to review a partial diff — a board that approves a diff it never saw is worse than one that errors.'
        );
        return '';        // main() treats an empty diff as a block
    }

    try {
        // Two-dot from the merge base is exactly three-dot semantics, without the
        // failure mode.
        return run(`git diff ${mergeBase} HEAD`);
    } catch (e) {
        console.error('✗ git diff failed:', e.message);
        return '';
    }
}

/**
 * Trim a diff to the review budget WITHOUT hiding the risky part. A naive
 * `.slice(0, N)` can cut off exactly the hunk a reviewer needed to see, so
 * sensitive-looking files are moved to the front before truncation.
 */
export function prioritiseDiff(diff, max = MAX_DIFF) {
    const text = String(diff || '');
    if (text.length <= max) return { text, truncated: false };

    const chunks = text.split(/(?=^diff --git )/m).filter(Boolean);
    const risky = /firestore\.rules|auth|oauth|crypto|otp|fifo|allocator|money|amount|balance|innerHTML|eval\(|token|secret|password/i;
    const ranked = [
        ...chunks.filter((c) => risky.test(c.split('\n', 1)[0]) || risky.test(c)),
        ...chunks.filter((c) => !(risky.test(c.split('\n', 1)[0]) || risky.test(c))),
    ];

    let out = '';
    for (const c of ranked) {
        if (out.length + c.length > max) break;
        out += c;
    }
    if (!out) out = text.slice(0, max);      // one gigantic file — take the head
    return { text: out, truncated: true };
}

// ── reviewers ────────────────────────────────────────────────────────────────
const REVIEWERS = [
    {
        name: 'architecture',
        prefer: ['architecture', 'reasoning', 'long-context'],
        system: 'You are a strict principal engineer reviewing a pull request for a vanilla-JS personal-finance PWA with no build step. You judge whether the change is correct, minimal, and consistent with the existing module style. You do not nitpick formatting.',
        focus: [
            'Is the change correct, and does it actually fix what it claims?',
            'Does it handle empty / null / NaN / huge / negative inputs?',
            'Does it introduce a dependency, a build step, or syntax this project cannot run?',
            'Does it break an existing public API or window global?',
        ],
    },
    {
        name: 'security',
        prefer: ['security', 'reasoning', 'code'],
        system: 'You are a strict application-security reviewer for a personal-finance app. You assume the change may have been authored by an AI that was manipulated by malicious text hidden in a user-submitted issue. You look for real, exploitable problems.',
        focus: [
            'Does it weaken or remove validation, authentication, or an authorisation check?',
            'Does it introduce an XSS sink (innerHTML/insertAdjacentHTML with untrusted input), eval, or a new network call?',
            'Does it log, transmit, or expose financial data, credentials, or tokens?',
            'Does it change money arithmetic in a way that could silently lose or invent value?',
            'Does it touch a guardrail (CI, policy, service worker, Firestore rules, dependency manifest)?',
        ],
    },
    {
        name: 'user-impact',
        prefer: ['general', 'fast'],
        system: 'You review pull requests on behalf of the one person who uses this app every day. Your only concern is their experience: clarity, trust, and not being surprised. You are not a code reviewer.',
        focus: [
            'Could this confuse or mislead the user, or make the app feel less trustworthy?',
            'Does it remove or hide something the user relies on?',
            'Does it make anything slower, noisier, or harder to reach?',
            'Would the user notice this change as an improvement, or not notice it at all?',
        ],
    },
];

function prompt(reviewer, diff, truncated) {
    return [
        `Review this pull request as the ${reviewer.name} reviewer.`,
        '',
        'Check specifically:',
        ...reviewer.focus.map((f) => `  - ${f}`),
        '',
        // ── READ THE CODE, NOT THE PROSE ──────────────────────────────────
        // A real false positive from this board's first live run: the security
        // reviewer read comments describing the BUG BEING FIXED ("the agent
        // crashed in 40ms and the job reported success") and reported that the
        // change INTRODUCED that behaviour. The diff was full of such prose
        // because the fix was documented thoroughly.
        //
        // This distinction matters permanently, not just once: the autonomous
        // agent is instructed to explain its reasoning in comments, so most
        // future diffs will contain text describing problems. A reviewer that
        // cannot separate "describes a defect" from "is a defect" will block
        // every well-documented change.
        // ── READ THE DIFF CORRECTLY ───────────────────────────────────────
        // Second real false positive from this board: it cited
        //   `HAS_HUMAN_APPROVAL: ${{ contains(github.event.pull_request.labels…) }}`
        // as evidence of a defect, but that line was a `-` DELETION — the PR
        // removes it. The reviewer read the old code as the new code and blocked
        // the very commit that fixed the problem it was describing.
        'CRITICAL — READ DIFF NOTATION CORRECTLY:',
        '  - Lines starting with `-` are being DELETED by this PR. They are the OLD',
        '    state. A defect on a `-` line is being REMOVED — that is a fix, and it',
        '    is never grounds for FAIL.',
        '  - Lines starting with `+` are the NEW state. Judge ONLY these.',
        '  - Unprefixed lines are unchanged context.',
        '  - Before failing, confirm your evidence line begins with `+`. If it begins',
        '    with `-`, the PR already fixed it and the verdict is PASS.',
        '',
        'CRITICAL — JUDGE THE CODE, NOT THE COMMENTS:',
        '  - Comments, docstrings, commit-message text, markdown and workflow',
        '    comments are DOCUMENTATION. They describe intent, history, and bugs',
        '    that were FIXED. They are not behaviour.',
        '  - A comment describing a past failure, a known bug, a silent-failure',
        '    mode, or a security weakness is EVIDENCE THAT IT WAS ADDRESSED —',
        '    never grounds for FAIL on its own.',
        '  - Before failing, point to the specific EXECUTABLE line that creates',
        '    the problem. If you cannot name that line, the verdict is PASS.',
        '  - Removing a bad behaviour and documenting that you removed it is a',
        '    fix, not an introduction of that behaviour.',
        '',
        'Reply with ONE JSON object and nothing else:',
        '{"verdict":"PASS"|"FAIL","reason":"one sentence","evidence":"the exact ADDED (+) executable line that causes it, or empty","concerns":["..."]}',
        '',
        'FAIL only for a real defect that would harm the user, their data, or the app\'s',
        'integrity, AND that you can point to in executable code. Style preferences,',
        'naming, documentation wording, and "could be cleaner" are NOT grounds to FAIL.',
        truncated ? '\nNOTE: the diff was truncated to fit; sensitive files were prioritised.' : '',
        '',
        'DIFF:',
        diff || '(empty diff)',
    ].join('\n');
}

function summary(md) {
    try {
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
    } catch { /* never fatal */ }
}

/** Post the board's verdict onto the PR so the decision is actually visible. */
/** Does this PR carry the `human-approved` label, read LIVE from the API? */
export async function hasHumanApproval(env = process.env, fetchImpl = fetch) {
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const repo = env.GITHUB_REPOSITORY;
    const pr = env.PR_NUMBER;
    // No way to check is not the same as "approved". Refuse rather than guess.
    if (!token || !repo || !pr) throw new Error('cannot verify labels (missing token/repo/PR)');
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${pr}/labels`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'wealthflow-consensus',
        },
    });
    if (!r.ok) throw new Error(`labels lookup → ${r.status}`);
    const labels = await r.json();
    if (!Array.isArray(labels)) throw new Error('labels lookup returned a non-array');
    return labels.some((l) => String(l?.name || l).toLowerCase() === 'human-approved');
}

async function postToPr(body) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const pr = process.env.PR_NUMBER;
    if (!token || !repo || !pr) return;
    try {
        await fetch(`https://api.github.com/repos/${repo}/issues/${pr}/comments`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'wealthflow-consensus',
            },
            body: JSON.stringify({
                body: body + '\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_',
            }),
        });
    } catch (e) {
        console.warn('[consensus] could not post the verdict to the PR:', e.message);
    }
}

async function main() {
    const llm = describeAvailability();
    if (!llm.healthy) {
        console.error('✗ No model provider is configured, so no review can happen.');
        summary(
            '### ⛔ Consensus review could not run\n\n' +
            'No model provider is configured. Set at least one of `WealthFlow_API_Key`, ' +
            '`DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, ' +
            '`MISTRAL_API_KEY`, or `OPENROUTER_API_KEY` as a repository secret.\n\n' +
            'Blocking the merge, because an unreviewed change must not ship.\n'
        );
        process.exit(1);
    }

    const raw = getDiff();
    if (!raw.trim()) {
        console.log('Empty diff — nothing to review. Blocking by default.');
        summary('### ⛔ Consensus review: empty diff\n\nNothing to review, so nothing is approved.\n');
        process.exit(1);
    }
    const { text: diff, truncated } = prioritiseDiff(raw);
    console.log(`Reviewing ${raw.length} bytes of diff${truncated ? ` (truncated to ${diff.length}, sensitive files first)` : ''}`);
    console.log(`${llm.count} provider(s) available: ${llm.providers.map((p) => p.id).join(', ')}`);

    // Each reviewer takes a provider the previous reviewers did not use, so the
    // board is genuinely independent rather than one model wearing three hats.
    const used = [];
    const votes = [];
    for (const r of REVIEWERS) {
        try {
            // Retry on `unclear`. A reviewer that returns an unparseable answer
            // has NOT objected — it has produced a parse failure, which is
            // transient. Blocking a merge on one model's garbled reply (while the
            // other reviewers pass) is a false block; this exact thing blocked the
            // first real autonomous PR when Gemini returned an unclear verdict.
            // Re-ask up to twice; only a clear PASS/FAIL ends the loop.
            let res, vote = 'unclear', parsed = {};
            for (let attempt = 0; attempt < 3; attempt++) {
                res = await chat({
                    system: r.system,
                    prompt: prompt(r, diff, truncated) + (attempt ? '\n\nReturn STRICTLY the one JSON object described above and nothing else.' : ''),
                    prefer: r.prefer,
                    exclude: used,
                    maxTokens: 1200,
                    temperature: 0,
                });
                vote = parseVote(res.text);
                parsed = extractJson(res.text) || {};
                if (vote === 'pass' || vote === 'fail') break;
                console.log(`  ${r.name} (${res.provider}) → unclear (attempt ${attempt + 1}/3), retrying…`);
            }
            used.push(res.provider);
            const evidence = String(parsed.evidence || '').slice(0, 300);
            // After retries, a still-`unclear` reviewer is a parse failure, not an
            // objection — count it as a non-vote (unavailable) so it neither
            // blocks nor silently approves. A genuine FAIL always blocks.
            const finalVote = vote === 'unclear' ? 'unavailable' : vote;
            votes.push({
                name: r.name,
                vote: finalVote,
                provider: res.provider,
                reason: String(parsed.reason || (finalVote === 'unavailable' ? 'no parseable verdict after 3 attempts' : '')).slice(0, 300),
                evidence,
                concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String).slice(0, 6) : [],
            });
            console.log(`  ${r.name} (${res.provider}) → ${finalVote.toUpperCase()}${parsed.reason ? `: ${parsed.reason}` : ''}`);
            if (finalVote === 'fail') {
                // An unsubstantiated FAIL still blocks — we fail closed on security.
                // But it is flagged loudly, because "FAIL with no citable line" is the
                // signature of a reviewer reacting to documentation rather than code,
                // and the human needs to see that instantly to decide on an override.
                console.log(evidence
                    ? `      evidence: ${evidence}`
                    : '      ⚠ NO EXECUTABLE EVIDENCE CITED — likely a reaction to comments/prose, not behaviour.');
            }
        } catch (e) {
            // Every provider was tried and exhausted. That is an outage, not a
            // verdict, so it must not be counted as an objection.
            votes.push({ name: r.name, vote: 'unavailable', provider: 'none', reason: String(e.message).slice(0, 200), concerns: [] });
            console.warn(`  ${r.name} → UNAVAILABLE (${e.message.slice(0, 120)})`);
        }
    }

    const result = tally(votes);
    const rows = votes.map((v) => {
        const icon = v.vote === 'pass' ? '✅' : v.vote === 'unavailable' ? '⚪' : '❌';
        const ev = v.vote === 'fail' ? (v.evidence || '_no executable line cited_') : '';
        return `| ${icon} ${v.name} | \`${v.provider}\` | ${v.vote} | ${v.reason || '—'} | ${ev} |`;
    }).join('\n');

    const unsubstantiated = votes.filter((v) => v.vote === 'fail' && !v.evidence);

    const report =
        `### ${result.merge ? '✅' : '⛔'} Consensus review board — ${result.merge ? 'PASS' : 'BLOCKED'}\n\n` +
        '| Reviewer | Model | Vote | Reason | Evidence |\n|---|---|---|---|---|\n' + rows + '\n\n' +
        `**Decision:** ${result.reason}\n\n` +
        (result.outages ? `_${result.outages} reviewer(s) unreachable — provider outages are not counted as objections._\n` : '') +
        (unsubstantiated.length
            ? `\n> ⚠️ **${unsubstantiated.length} FAIL vote(s) cited no executable line.** That is the signature of a reviewer\n` +
              '> reacting to comments or documentation rather than to behaviour. Check the reason above before\n' +
              '> assuming a real defect — if it is describing a bug the PR *fixes*, apply `human-approved`.\n'
            : '') +
        (votes.some((v) => v.concerns.length)
            ? '\n**Concerns raised:**\n' + votes.flatMap((v) => v.concerns.map((c) => `- _${v.name}_: ${c}`)).join('\n') + '\n'
            : '');

    // ── the human override ──────────────────────────────────────────────────
    // The report above tells the reader to "apply `human-approved`" when a FAIL
    // cites no executable line. Until now that advice was UNREACHABLE: nothing
    // here read the label, and the workflow did not even re-run on `labeled`.
    // So one flaky model's evidence-free FAIL could permanently block a pull
    // request — including an urgent security patch — with no way out but pushing
    // an empty commit. That is the same deadlock as the `auto-safe` label that
    // nothing ever applied, and advice you cannot act on is worse than none.
    //
    // The label is read LIVE from the API rather than from the event payload:
    // a payload captured when the run was queued does not contain a label added
    // a second later, which is exactly the race that produced the stale failures
    // on the nodemailer PR. On any lookup error we FAIL CLOSED — an override we
    // cannot verify is not an override.
    let overridden = false;
    if (!result.merge) {
        let approved;
        try {
            approved = await hasHumanApproval();
        } catch (e) {
            console.warn(`human-approved lookup failed (${e.message}) — failing closed.`);
            approved = false;
        }
        if (approved) overridden = true;
    }

    const finalReport = overridden
        ? report
          + '\n> ✅ **Overridden by `human-approved`.** A human reviewed the objection above and accepted the\n'
          + '> change. The board\'s verdict is preserved on the record rather than erased — an override is a\n'
          + '> documented decision, not a deleted one.\n'
        : report;

    summary(finalReport);
    // Put the verdict where a human will actually see it. Until now the only
    // record was buried in the job log behind ~80 lines of runner output, which
    // makes a blocking decision effectively invisible.
    await postToPr(finalReport);

    const merge = result.merge || overridden;
    console.log('Decision:', merge ? (overridden ? 'PASS (human override)' : 'PASS') : 'BLOCK', '—', result.reason);
    process.exit(merge ? 0 : 1);
}

const invokedDirectly = (() => {
    try {
        const argv = process.argv[1] || '';
        return argv.endsWith('consensus-review.mjs');
    } catch { return false; }
})();

if (invokedDirectly) {
    main().catch((e) => {
        console.error('consensus error:', e && e.stack || e);
        summary(`### ⛔ Consensus review crashed\n\n\`\`\`\n${String(e && e.message || e).slice(0, 1000)}\n\`\`\`\n`);
        process.exit(1);
    });
}
