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
import { chat, extractJson, describeAvailability, assignProviders, orderFor } from './autonomy/llm-router.mjs';
import * as Budget from './autonomy/provider-budget.mjs';

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
    // Every reviewer that COULD be reached passed. Whether that is the whole
    // board is a separate question, and conflating the two is what let a
    // two-reviewer result be reported as "unanimous pass".
    //
    // A lane lost to a provider outage is not an objection — failing closed on
    // it would reinstate the old bug where one 503 blocked every pull request.
    // But it is not an approval either, and `merge: true` with an ignored
    // `outages` count is a review gate silently failing open: the architecture
    // reviewer vanished four times to a sambanova 429 and every one of those
    // pull requests reported a clean pass.
    //
    // So a degraded board no longer decides on its own. It reports honestly and
    // defers to the human-approved label — the signature this repository already
    // uses everywhere a machine may not proceed alone.
    const missing = outages.map((o) => o.name);
    const degraded = outages.length > 0;
    const sharedLanes = cast.filter((c) => c.shared).map((c) => c.name);

    return {
        merge: !degraded,
        degraded,
        missing,
        shared: sharedLanes,
        reason: degraded
            ? `${cast.length} of ${cast.length + outages.length} reviewers voted and all passed, but ${missing.join(', ')} could not be reached — not a full board`
            : `unanimous pass from ${cast.map((c) => c.name).join(', ')}`
                + (sharedLanes.length ? ` (${sharedLanes.join(', ')} ran on a shared provider)` : ''),
        cast: cast.length,
        outages: outages.length,
    };
}

// NOTE: hasHumanApproval() already exists further down this file and is used by
// main()'s override path. A degraded board reuses it rather than adding a second
// reader — one definition of "a human signed this off", not two that can drift.

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
    let headSha = '';
    try { headSha = run('git rev-parse HEAD').trim(); } catch { headSha = ''; }

    if (!mergeBase) {
        console.error(
            `✗ No merge base between origin/${base} and HEAD, so the true PR diff cannot be determined.\n` +
            '  Refusing to review a partial diff — a board that approves a diff it never saw is worse than one that errors.'
        );
        return { text: '', mergeBase: '', headSha };   // main() treats an empty diff as a block
    }

    try {
        // Two-dot from the merge base is exactly three-dot semantics, without the
        // failure mode.
        return { text: run(`git diff ${mergeBase} HEAD`), mergeBase, headSha };
    } catch (e) {
        console.error('✗ git diff failed:', e.message);
        return { text: '', mergeBase, headSha };
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
// Exported so the lane-assignment tests can assert against the REAL board
// composition rather than invented roles — an artificial role list can pass while
// the shipped one silently downgrades the security reviewer.
export const REVIEWERS = [
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
            'What will the user SEE or FEEL differently after this change? Name it.',
            'Could this confuse or mislead them, or make the app feel less trustworthy?',
            'Does it remove or hide something they rely on?',
            'Does it make anything slower, noisier, or harder to reach?',
        ],
        /* Extra instructions for this lane only.
         *
         * WHY THIS LANE NEEDED THEM. Five consecutive pull requests that changed
         * what appears on screen were passed with a variant of "no user-facing
         * changes": a lock-screen button rewritten to state the amount it
         * writes, a new idle-cash notification, a whole settings screen plus a
         * dashboard card, and a change that replaced every visible glyph on
         * three screens with icons.
         *
         * The verdicts were right — none of those harmed anybody. The REASONS
         * were false, and a false reason is worse than no reason: it reads on
         * the pull request as a considered finding that the change is invisible,
         * which is precisely the claim that let a pipeline with no interface at
         * all be described as live.
         *
         * The cause is visible in the old focus list above: every question asked
         * about HARM, so "no harm" came back phrased as "no change". Describing
         * what the user will see is now the FIRST question, and the denial is
         * forbidden outright. */
        rules: [
            'Your REASON must first name what the user will actually see or feel — a button, a screen, a message, a vibration, a colour, a delay.',
            'Never report that the change is invisible when the diff adds or alters markup, a notification, a setting, a label, a toast, an icon or a screen. Whether it HARMS anyone and whether it CHANGES anything visible are separate questions; answer both.',
            /* Phrased as a constraint on the ANSWER, not as a model answer.
             * The first wording — "New UI that harms nobody is a PASS whose
             * reason describes the new UI" — was returned almost verbatim as a
             * review: "This change adds new UI that harms nobody, and the reason
             * describes the new UI." That is circular; it says the reason
             * describes the UI instead of describing it. A rule that reads like
             * a finished sentence will be copied as one. */
            'A pure addition is still a change: judge it, do not wave it through.',
            /* Naming something is a constraint on the WORDING of the reason. It
             * is emphatically not an instruction to find something to object to,
             * and the first version of it read that way: asked for a concrete
             * noun, the lane produced "The user will see a new button labelled
             * '_bv_save' and feel a vibration" — as a FAIL, citing a line that
             * exists only inside a TEST FIXTURE in that diff. It had gone
             * looking for a noun, found one in test data, and blocked on it.
             * Passing with a vague reason was noise; blocking on a fabricated
             * one is worse, so the boundary is now stated with the rule. */
            'Your reason should name the control, screen, message or setting you are talking about, so it reads as a review of THIS change rather than one that would fit any. This is about how you word a reason — it is never a reason to FAIL, and never an instruction to go looking for something to object to.',
            'Test files, fixtures and mock data are not the product. A button that exists only inside a test string is not something the user will ever see, and must not be described as if it were.',
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
        ...(reviewer.rules && reviewer.rules.length
            ? ['RULES FOR THIS REVIEWER:', ...reviewer.rules.map((r) => `  - ${r}`), '']
            : []),
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

/**
 * Run ONE reviewer in its own lane, on the provider(s) reserved for it.
 *
 * Never throws: every failure mode becomes an `unavailable` vote. That
 * distinction is load-bearing — a provider being down is not a reviewer
 * objection, and recording it as one would block every pull request on someone
 * else's outage. (An earlier version of this file did exactly that: one DeepSeek
 * hiccup read as a non-pass vote and blocked the merge.)
 *
 * Providers are tried in the order the lane was dealt — its primary first, then
 * only its OWN reserved fallbacks — so a retry here can never take a provider
 * another reviewer is running on.
 */
/* =============================================================================
   REJECTING FINDINGS THAT ARE JUST THE DIFF'S OWN COMMENTS READ BACK
   ---------------------------------------------------------------------------
   On PR #98 the security lane (mistral) returned, twice:

       reason:   "The release-brain.js file could never succeed, and said so in
                  the wrong words."
       evidence: "+    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;"

   That sentence is the FIRST LINE OF THE COMMENT the PR added, describing the
   bug it was fixing. The reviewer summarised the diff's prose and returned it
   as a finding, blocking the change that removed the defect it was quoting.

   The prompt already tells reviewers, at length, to judge code and not comments
   (see the CRITICAL blocks in prompt()). Those instructions were added after
   this exact failure happened the first time. The model ignored them twice more.
   So the rule moves out of the prompt and into code, where it is enforced
   rather than requested.

   WHY THIS IS NARROW ON PURPOSE. Discarding a security objection is dangerous,
   and this repository fails closed on security everywhere else. A finding is
   only rejected when the reason is a LONG VERBATIM RUN of the diff's own
   comment text — at least MIN_RUN consecutive words, AND at least MIN_SHARE of
   the whole reason. A reviewer that describes a defect in its own words is
   untouched even if it discusses the same subject the comments do.

   The objection is never erased. It is printed to the log and rendered in the
   board table as a rejected finding, so a human can disagree with the machine
   that disagreed with the machine.
   ========================================================================== */
export const REJECT_MIN_RUN = 8;      // consecutive words shared with a comment
export const REJECT_MIN_SHARE = 0.5;  // …and that much of the reason itself

const normWords = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

/**
 * Every word of every COMMENT line in the diff, in order. Added, removed and
 * context lines all count: the reviewer saw all of them, so it could be quoting
 * any of them.
 */
/**
 * Walk the diff once and label every line `comment` or `code`.
 *
 * STATEFUL ON PURPOSE. The first version tested each line against
 * /^\s*(\/\/|\/\*|\*|#)/ in isolation, which works for `*`-prefixed JSDoc but
 * NOT for this repository's dominant style:
 *
 *     /* ====================================================
 *        AUTHENTICATION  —  this endpoint was completely open
 *        ---------------------------------------------------
 *
 * Those continuation lines carry no marker at all, so a line-at-a-time filter
 * classified them as executable code — meaning a reviewer citing one as its
 * evidence would have sailed through both guards. Found by this file's own
 * test, which is the only reason it is not still there.
 */
export function classifyDiffLines(diff) {
    const comments = [];
    const code = [];
    let inBlock = false;
    for (const raw of String(diff || '').split('\n')) {
        if (/^(\+\+\+|---|diff --git|@@|index )/.test(raw)) continue;   // diff furniture
        const marker = /^[+\- ]/.test(raw) ? raw[0] : ' ';
        const line = raw.replace(/^[+\- ]/, '');

        if (inBlock) {
            comments.push({ marker, line });
            if (line.includes('*/')) inBlock = false;
            continue;
        }
        if (/^\s*(\/\/|#)/.test(line)) { comments.push({ marker, line }); continue; }
        if (/^\s*\/\*/.test(line)) {
            comments.push({ marker, line });
            if (!line.includes('*/')) inBlock = true;
            continue;
        }
        if (/^\s*\*/.test(line)) { comments.push({ marker, line }); continue; }
        if (line.trim()) code.push({ marker, line });
    }
    return { comments, code };
}

/** Every word of every COMMENT line in the diff, in order. */
export function commentWordsOf(diff) {
    const out = [];
    for (const { line } of classifyDiffLines(diff).comments) {
        out.push(...normWords(line.replace(/^\s*(\/\/+|\/\*+|\*+|#+)/, '')));
    }
    return out;
}

/** Longest run of `a` that appears contiguously inside `b`. */
export function longestSharedRun(a, b) {
    if (!a.length || !b.length) return 0;
    let best = 0;
    let prev = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
        const cur = new Uint32Array(b.length + 1);
        for (let j = 1; j <= b.length; j++) {
            if (a[i - 1] === b[j - 1]) {
                cur[j] = prev[j - 1] + 1;
                if (cur[j] > best) best = cur[j];
            }
        }
        prev = cur;
    }
    return best;
}

/**
 * Is this stated reason a regurgitation of the diff's comments rather than a
 * finding about its code? Pure, so the threshold can be argued with in a test
 * rather than in production.
 */
export function restatesComment(reason, commentWords, opts = {}) {
    const minRun = opts.minRun ?? REJECT_MIN_RUN;
    const minShare = opts.minShare ?? REJECT_MIN_SHARE;
    const words = normWords(reason);
    if (words.length < minRun) return false;         // too short to judge either way
    const run = longestSharedRun(words, commentWords || []);
    return run >= minRun && (run / words.length) >= minShare;
}

/* ── THE SECOND SIGNAL, added after the first one proved too narrow ──────────
 *
 * `restatesComment` catches a reviewer QUOTING the diff's comments. On PR #106
 * the same lane did the same thing while PARAPHRASING, and slipped straight
 * through:
 *
 *     reason:   "The PR introduces an open write endpoint that could be used to
 *                delete feedback documents up to 5,000 documents per call."
 *     evidence: "+        · DELETE feedback older than 14 days, via the archival pass"
 *
 * The reason shares only a 6-word run with the comment it came from — under the
 * 8-word threshold, correctly. But look at the EVIDENCE: it is a bullet inside
 * the block comment that PR added to describe the vulnerability it was fixing.
 *
 * That is the far stronger and far more mechanical signal, and it was sitting
 * in the payload the whole time. The prompt already demands "the exact ADDED
 * (+) executable line that causes it". A FAIL that cites a comment has, by its
 * own answer, failed to find executable code — no prose similarity heuristic
 * needed.
 *
 * Deliberately NOT applied when `evidence` is empty. That case already blocks,
 * loudly, and changing it would weaken a fail-closed path this file chose on
 * purpose. Citing nothing may mean the reviewer saw something it could not
 * quote; citing a comment is positive proof it was reading prose.
 * ─────────────────────────────────────────────────────────────────────────── */

const normLine = (s) => String(s || '').replace(/^[+\-]\s?/, '').replace(/\s+/g, ' ').trim();

/** Every ADDED line of the diff that is actually code, normalised. */
export function addedCodeLines(diff) {
    return classifyDiffLines(diff).code
        .filter((e) => e.marker === '+')
        .map((e) => normLine(e.line))
        .filter(Boolean);
}

/**
 * Did this FAIL cite something that is not an added executable line?
 * Returns false for empty evidence — see the note above.
 */
export function citesNonExecutableEvidence(evidence, diff) {
    const ev = normLine(evidence);
    if (!ev) return false;
    // A comment marker or a prose bullet can never be the executable line that
    // causes a defect.
    if (/^(\/\/|\/\*|\*|#|·|•|–|—)/.test(ev)) return true;
    const added = addedCodeLines(diff);
    if (!added.length) return false;          // nothing to compare against; do not reject
    return !added.some((l) => (
        l === ev
        || (ev.length >= 12 && l.includes(ev))
        // Guard the reverse direction against trivia: without a length floor,
        // a one-character added line like `}` would "match" any evidence.
        || (l.length >= 12 && ev.includes(l))
    ));
}

/* ── A FOURTH REJECTION: "NEW" SAID OF SOMETHING THAT WAS ALREADY THERE ──────
 *
 * On PR #155 — a refactor replacing emoji with icons — the user-impact lane
 * failed the board with:
 *
 *   "The user will see a NEW icon in the AI Scanner Settings title, which may
 *    be confusing as it is not explained in the text."
 *   evidence: +  <div class="md-title">${WFIcon('scan')} AI Scanner Settings</div>
 *
 * The evidence was a real added executable line, so citesNonExecutableEvidence
 * had nothing to say. But the hunk was:
 *
 *   -  <div class="md-title">📸 AI Scanner Settings</div>
 *   +  <div class="md-title">${WFIcon('scan')} AI Scanner Settings</div>
 *
 * Nothing new appears. A camera EMOJI stood in that exact position and a
 * scanner icon replaced it. The reviewer read the `+` in isolation and
 * described a substitution as an addition — the same shape as reading a `-`
 * line as evidence, one step along.
 *
 * The re-run reshaped it into "will see a new icon, but the icon is not
 * visible in the diff" with no evidence at all, which is incoherent and which
 * the empty-evidence path already flags. Two runs, two versions of one wrong
 * idea, so the prompt is not the place — the same argument this file has now
 * made three times.
 *
 * WHY THIS IS NARROW, AND MUST BE. A replacement CAN introduce something:
 *
 *   -  <div>Total</div>
 *   +  <div>Total <button onclick="deleteAll()">X</button></div>
 *
 * is a replaced line that genuinely adds a control, and a novelty objection to
 * it is correct. So this rejects only when the VISIBLE TEXT either side of the
 * swap is the same — markup, expressions and glyphs stripped. When the words a
 * person reads do not change, "the user will see a new X" is false whatever X
 * is, and a FAIL resting on it is resting on nothing.
 * ===========================================================================*/

/** Does this reason assert that something is NEW? */
const NOVELTY = /\b(new|newly|introduc\w*|adds?\b|adding|added)\b/i;

export function claimsNovelty(reason) {
    return NOVELTY.test(String(reason || ''));
}

/**
 * The words a person actually reads on a line: tags, template expressions,
 * attribute values, emoji and punctuation removed.
 */
export function visibleTextOf(line) {
    return String(line || '')
        .replace(/\$\{[^}]*\}/g, ' ')                       // ${...} template expressions
        .replace(/<[^>]*>/g, ' ')                            // markup
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')                    // punctuation and symbols
        .trim()
        .toLowerCase();
}

/**
 * Is the cited evidence a line that REPLACED one saying the same thing?
 *
 * Pairs each added code line with the removed code lines around it and asks
 * whether any of them reads identically once markup and glyphs are gone. Empty
 * visible text on both sides is NOT a match — two lines of pure markup say
 * nothing, and calling that "the same words" would reject findings about
 * structural changes.
 */
export function evidenceIsGlyphSwap(evidence, diff) {
    const ev = normLine(evidence);
    if (!ev) return false;
    const evText = visibleTextOf(ev);
    if (!evText) return false;

    const { code } = classifyDiffLines(diff);
    const added = code.filter((e) => e.marker === '+').map((e) => normLine(e.line));
    const removed = code.filter((e) => e.marker === '-').map((e) => normLine(e.line));
    if (!removed.length) return false;

    // The evidence must actually be one of the added lines, on the same terms
    // citesNonExecutableEvidence uses, or this says nothing about this diff.
    const cited = added.some((l) => l === ev || (ev.length >= 12 && l.includes(ev)) || (l.length >= 12 && ev.includes(l)));
    if (!cited) return false;

    return removed.some((r) => visibleTextOf(r) === evText);
}

/* ── THE THIRD SIGNAL: A DENIAL THAT THE DIFF CONTRADICTS ────────────────────
 *
 * The two functions above catch a reviewer reading the diff's PROSE as its
 * code. This one catches the opposite failure, in the user-impact lane: a
 * reviewer that did not really look at the diff at all and reached for the
 * safest sentence available — "no user-facing changes".
 *
 * It was returned on five consecutive pull requests that changed what appears
 * on screen, including one whose entire content was replacing every visible
 * glyph on three screens, and one that added a settings screen and a dashboard
 * card to an app that had neither.
 *
 * WHY THIS IS IN CODE AND NOT ONLY IN THE PROMPT. The same argument this file
 * already makes twice, above: instructions were added to the prompt after the
 * first occurrence and the model ignored them repeatedly. A rule that the model
 * can decline to follow is a request. This is the check.
 *
 * WHY IT DOES NOT CHANGE THE VERDICT. The verdict is usually right — new UI
 * that harms nobody IS a pass. It is the stated reason that is false. Turning a
 * correct PASS into a FAIL over a badly worded justification would block good
 * changes and teach the board to say less, not more. So the vote stands and the
 * reason is replaced with what can actually be established: that the diff
 * touches the interface, and that the reviewer did not say how.
 *
 * DELIBERATELY NARROW. Only fires when the reason DENIES a visible change AND
 * the diff demonstrably adds one. A reviewer that says "the new banner is
 * clear and the wording is fine" is untouched, whatever else it says.
 * ───────────────────────────────────────────────────────────────────────────*/

/** Phrasings that assert the change cannot be seen. */
const DENIAL = /\bno\s+(?:\w+\s+){0,2}user[- ]facing\s+(?:changes?|impact|modifications?|differences?)\b|\bnothing\s+(?:that\s+)?the\s+user\s+(?:will\s+)?(?:see|notice)\b|\bnot\s+visible\s+to\s+the\s+user\b|\bno\s+(?:visible|noticeable|perceptible)\s+changes?\b/i;

/** Added lines that put something in front of a person. */
const UI_MARKERS = [
    /\binnerHTML\b/, /\btextContent\b/, /\bshowNotification\b/, /\bnotify\(/,
    /\bshowActionableBanner\b/, /\bshowConfirm\(/, /\bsetting-(?:row|label|desc)\b/,
    /<(?:button|div|span|select|option|input|label|dialog)\b/i,
    /\bclass="[^"]*\b(?:btn|card|md-title|setting|toast|banner)\b/i,
    /\bplaceholder\s*[:=]/, /\btitle\s*:\s*['"`]/, /\bWFIcon\(/,
    /\bvibrate\b/, /\btriggerHaptic\b/,
];

/** Does this diff add something a person can see or feel? */
export function addsUserVisibleSurface(diff) {
    for (const line of addedCodeLines(diff)) {
        for (const re of UI_MARKERS) if (re.test(line)) return true;
    }
    return false;
}

/**
 * Is this reason a denial the diff contradicts? Pure, so the judgement can be
 * argued with in a test rather than in production.
 */
export function deniesVisibleChange(reason, diff) {
    if (!DENIAL.test(String(reason || ''))) return false;
    return addsUserVisibleSurface(diff);
}

/** What to say instead. Never invents a finding — states only what is known. */
export const DENIAL_REPLACEMENT =
    'Reviewer reported no user-facing change, but the diff adds or alters interface code; '
    + 'the vote stands and the stated reason does not.';

/* ── THE FOURTH SIGNAL: A REASON THAT NAMES NOTHING ──────────────────────────
 *
 * On one pull request the user-impact lane produced three different reviews,
 * and every one of them was a sentence lifted from the diff or the prompt:
 *
 *   1. a paraphrase of two TEST FIXTURES the change had just added
 *   2. its own RULE read back — "adds new UI that harms nobody, and the reason
 *      describes the new UI", which announces that the reason describes the UI
 *      instead of describing it
 *   3. "This causes no HARM" — a phrase quoted INSIDE that rule as an example
 *
 * Each fix removed one source of quotable text and the model found the next.
 * That is not a prompting problem any further wording will solve; the lane is
 * retrieving the nearest plausible sentence rather than reading the diff.
 *
 * What can be established mechanically is whether the reason mentions ANYTHING
 * that appears in this particular diff. A review of a change to the haptics
 * screen will contain a word like "haptic", "vibration", "intensity" or
 * "settings"; a sentence that would fit any pull request contains none of them.
 *
 * SCOPED TO THIS ONE LANE ON PURPOSE. Architecture and security legitimately
 * return short general statements — "no vulnerabilities introduced" is a
 * complete and useful answer. Only the user-impact lane's whole job is to say
 * what the person will see, which cannot be done without naming it.
 *
 * AND IT NEVER CHANGES THE VOTE, for the same reason as the check above.
 * ───────────────────────────────────────────────────────────────────────────*/

/* Words that appear in reviews of anything. Matching only these is what
 * "generic" means here. */
const REVIEW_VOCAB = new Set([
    'change', 'changes', 'changed', 'user', 'users', 'this', 'that', 'with', 'from', 'they',
    'pull', 'request', 'diff', 'code', 'pass', 'fail', 'harm', 'harms', 'harmful', 'impact',
    'nobody', 'anyone', 'reason', 'review', 'reviewer', 'adds', 'added', 'introduces',
    '新', 'does', 'would', 'could', 'should', 'there', 'their', 'about', 'which', 'where',
    'facing', 'visible', 'noticeable', 'improvement', 'feature', 'features', 'behaviour',
    'behavior', 'confusion', 'performance', 'degradation', 'removal', 'cause', 'causes',
    'clear', 'plain', 'wording', 'nothing', 'anything', 'something', 'these', 'those',
]);

const WORDS = /[a-z][a-z0-9_]{3,}/g;

/**
 * Does this reason mention anything that is actually in this diff?
 *
 * Compared against the diff's ADDED lines only, and ignoring the vocabulary
 * every review shares, so the question asked is narrow: did it name one thing
 * this change touches?
 */
export function reasonNamesSomething(reason, diff) {
    const added = new Set(String(addedCodeLines(diff).join(' ')).toLowerCase().match(WORDS) || []);
    const words = String(reason || '').toLowerCase().match(WORDS) || [];
    return words.some((w) => !REVIEW_VOCAB.has(w) && added.has(w));
}

/** A non-empty reason that names nothing in the diff it is reviewing. */
export function reasonIsGeneric(reason, diff) {
    const r = String(reason || '').trim();
    if (!r) return false;                      // empty is handled elsewhere
    return !reasonNamesSomething(r, diff);
}

export const GENERIC_REPLACEMENT =
    'Reviewer gave a reason that names nothing in this diff; the vote stands and the stated reason does not.';

export async function runReviewer(lane, diff, truncated, chatImpl = chat, onAttempt = null) {
    const r = lane.role;
    // Own providers first, then — only once those are exhausted — providers
    // reserved by other lanes. A verdict reached on a shared provider is marked
    // as such, because a board that quietly stops being independent is the same
    // silent degradation as a board that quietly loses a reviewer.
    const ownProviders = [lane.primary, ...(lane.fallbacks || [])].filter(Boolean);
    const sharedProviders = (lane.shared || []).filter(Boolean);
    const candidates = [...ownProviders, ...sharedProviders];
    if (!candidates.length) {
        console.warn(`  ${r.name} → UNAVAILABLE (no provider left to assign)`);
        return { name: r.name, vote: 'unavailable', provider: 'none', reason: 'no provider available for this reviewer', concerns: [] };
    }

    let lastErr = null;
    for (const pid of candidates) {
        try {
            // Retry on `unclear`. A reviewer that returns an unparseable answer has
            // NOT objected — it produced a parse failure, which is transient.
            // Blocking a merge on one model's garbled reply while the others pass is
            // a false block; this exact thing blocked the first real autonomous PR
            // when Gemini returned an unclear verdict. Only a clear PASS/FAIL ends it.
            let res, vote = 'unclear', parsed = {};
            for (let attempt = 0; attempt < 3; attempt++) {
                res = await chatImpl({
                    system: r.system,
                    prompt: prompt(r, diff, truncated) + (attempt ? '\n\nReturn STRICTLY the one JSON object described above and nothing else.' : ''),
                    only: [pid],          // pinned to this lane — never another reviewer's model
                    maxTokens: 1200,
                    temperature: 0,
                    onAttempt,            // feeds the budget ledger; never fails the call
                });
                vote = parseVote(res.text);
                parsed = extractJson(res.text) || {};
                if (vote === 'pass' || vote === 'fail') break;
                console.log(`  ${r.name} (${res.provider}) → unclear (attempt ${attempt + 1}/3), retrying…`);
            }

            const evidence = String(parsed.evidence || '').slice(0, 300);
            // Still `unclear` after the retries is a parse failure, not an objection:
            // count it as a non-vote so it neither blocks nor silently approves.
            let finalVote = vote === 'unclear' ? 'unavailable' : vote;
            console.log(`  ${r.name} (${res.provider}) → ${finalVote.toUpperCase()}${parsed.reason ? `: ${parsed.reason}` : ''}`);

            // The reviewer answered, so it is NOT `unavailable` — that state means
            // nobody looked, and would make the board report itself degraded and
            // defer to human-approved. It looked; its stated objection just was not
            // a finding. So the vote becomes a pass carrying a rejected objection,
            // which is preserved in the log and in the board table.
            let rejectedFinding = null;
            if (finalVote === 'fail') {
                // Two independent signals. The first catches a reviewer quoting
                // the diff's comments; the second catches it paraphrasing them
                // while citing one as the offending line. PR #98 tripped the
                // first, PR #106 tripped only the second.
                const why = restatesComment(parsed.reason, commentWordsOf(diff))
                    ? "the reason is a verbatim run of the diff's own comment text"
                    : citesNonExecutableEvidence(evidence, diff)
                        ? 'the cited evidence is a comment or prose line, not an added executable line'
                        : (claimsNovelty(parsed.reason) && evidenceIsGlyphSwap(evidence, diff))
                            ? 'the reason calls something new, but the cited line REPLACED one reading the same words'
                            : null;
                if (why) {
                    rejectedFinding = { reason: String(parsed.reason || '').slice(0, 300), evidence, why };
                    finalVote = 'pass';
                    console.log(`      ⚠ FINDING REJECTED — ${why}.`);
                    console.log('        See the rejection block above runReviewer for why this is');
                    console.log('        enforced here rather than asked for in the prompt.');
                }
            }

            if (finalVote === 'fail') {
                // An unsubstantiated FAIL still blocks — we fail closed on security.
                // But it is flagged loudly: "FAIL with no citable line" is the signature
                // of a reviewer reacting to prose rather than behaviour, and the human
                // needs to see that instantly to decide on an override.
                console.log(evidence
                    ? `      evidence: ${evidence}`
                    : '      ⚠ NO EXECUTABLE EVIDENCE CITED — likely a reaction to comments/prose, not behaviour.');
            }

            /* A PASS whose reason denies the change is visible, on a diff that
             * demonstrably adds interface code. The VOTE is kept — new UI that
             * harms nobody really is a pass — and only the false sentence is
             * replaced. See the block above runReviewer for the five pull
             * requests that made this a code check rather than a prompt line. */
            let correctedReason = null;
            let correctionWhy = '';
            if (finalVote === 'pass' && deniesVisibleChange(parsed.reason, diff)) {
                correctedReason = String(parsed.reason || '').slice(0, 300);
                correctionWhy = DENIAL_REPLACEMENT;
                console.log('      ⚠ REASON CORRECTED — reviewer denied a user-facing change that the diff makes.');
            } else if (finalVote === 'pass' && r.name === 'user-impact'
                       /* Only when there IS something to name. A backend-only
                        * change genuinely has no user-facing part, and "no
                        * user-facing changes" is then the correct review — the
                        * check must not punish a reviewer for being right. */
                       && addsUserVisibleSurface(diff)
                       && reasonIsGeneric(parsed.reason, diff)) {
                correctedReason = String(parsed.reason || '').slice(0, 300);
                correctionWhy = GENERIC_REPLACEMENT;
                console.log('      ⚠ REASON CORRECTED — reviewer named nothing in this diff.');
            }
            return {
                name: r.name,
                vote: finalVote,
                provider: res.provider,
                // True when this lane had to borrow a provider another lane also
                // used. The verdict still counts — a shared reviewer beats no
                // reviewer — but it is no longer fully independent, and the board
                // says so rather than presenting it as three separate opinions.
                shared: sharedProviders.includes(pid),
                // A rejected objection must not be presented as this reviewer's
                // reason for passing — it is carried separately and rendered as
                // what it is.
                rejectedFinding,
                // The reviewer's own words when they were checkable, kept so the
                // board table can show what was said before it was corrected.
                correctedReason,
                /* NAMES THE KIND THAT ACTUALLY FIRED. This was a fixed string
                 * saying "it restated the diff's own comments", which is only
                 * ONE of the three rejection kinds — so when the glyph-swap
                 * rejection was added the table started reporting the wrong
                 * reason for it. `why` is already the accurate sentence; it was
                 * being computed and then discarded here. */
                reason: rejectedFinding
                    ? `objection rejected — ${rejectedFinding.why || 'it restated the diff'}`.slice(0, 300)
                    : correctedReason
                        ? correctionWhy
                        : String(parsed.reason || (finalVote === 'unavailable' ? 'no parseable verdict after 3 attempts' : '')).slice(0, 300),
                evidence: rejectedFinding ? '' : evidence,
                concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String).slice(0, 6) : [],
            };
        } catch (e) {
            // This provider is down. Move to the next one reserved for THIS lane.
            lastErr = e;
            console.warn(`  ${r.name} (${pid}) unreachable — ${String(e.message).slice(0, 100)}`);
        }
    }

    return {
        name: r.name,
        vote: 'unavailable',
        provider: 'none',
        reason: String(lastErr ? lastErr.message : 'every reserved provider failed').slice(0, 200),
        concerns: [],
    };
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

// ── per-SHA dedupe ───────────────────────────────────────────────────────────
/**
 * Stamp identifying EXACTLY what was reviewed.
 *
 * Measured on PR #32: five board runs fired on the identical head SHA inside
 * three and a half minutes, all triggered by `pull_request` events, all reaching
 * the same verdict. Each run costs ~2 billable Actions minutes and three provider
 * calls, so that was ~10 minutes and ~15 calls for zero new information — and it
 * is very likely why sambanova began returning 429 to the architecture reviewer,
 * making the rate limiting partly self-inflicted.
 *
 * The head SHA alone is NOT sufficient identity. This board reviews
 * `merge-base(base, HEAD)..HEAD`, so the effective diff also changes when the base
 * branch moves — and merchant-sync pushes to main on a schedule. Reusing a verdict
 * keyed only on the head SHA could therefore skip reviewing a diff that genuinely
 * changed underneath it. The stamp carries BOTH ends.
 */
export const BOARD_STAMP = 'wf-board';

export function stampFor(headSha, mergeBase) {
    return `<!-- ${BOARD_STAMP} head=${String(headSha || '').slice(0, 40)} base=${String(mergeBase || '').slice(0, 40)} -->`;
}

/**
 * Has this exact diff already been PASSED by the board?
 *
 * Only a pass is reusable. A previous block must be re-run rather than reused: if
 * the reviewers objected, the correct behaviour is to object again, and treating a
 * stored FAIL as a reason to exit 0 would turn a dedupe optimisation into a way to
 * merge a blocked change.
 *
 * Any error reading the comments returns false, so the board simply runs. Failing
 * to dedupe wastes two minutes; wrongly skipping a review does not.
 */
export async function alreadyPassed({ headSha, mergeBase, env = process.env, fetchImpl = fetch } = {}) {
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const repo = env.GITHUB_REPOSITORY;
    const pr = env.PR_NUMBER;
    if (!token || !repo || !pr || !headSha) return false;
    const stamp = stampFor(headSha, mergeBase);
    try {
        const r = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${pr}/comments?per_page=100`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'wealthflow-consensus' },
        });
        if (!r.ok) return false;
        const comments = await r.json();
        if (!Array.isArray(comments)) return false;
        return comments.some((c) => {
            const body = String((c && c.body) || '');
            // Both conditions required: the same diff AND a pass.
            return body.includes(stamp) && /Consensus review board — PASS/.test(body);
        });
    } catch { return false; }
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

    const { text: raw, mergeBase, headSha } = getDiff();

    // Reuse a PASS already recorded for this exact diff. Five runs fired on one
    // unchanged SHA on PR #32 within three and a half minutes; re-asking three
    // models a question they have already answered spends quota and Actions
    // minutes to learn nothing, and is very likely what exhausted sambanova.
    if (await alreadyPassed({ headSha, mergeBase })) {
        const msg = `Already reviewed and passed for head ${String(headSha).slice(0, 7)} `
            + `on base ${String(mergeBase).slice(0, 7)} — reusing that verdict instead of re-asking.`;
        console.log(msg);
        summary(`### ✅ Consensus review board — PASS (reused)\n\n${msg}\n`);
        process.exit(0);
    }
    if (!raw.trim()) {
        console.log('Empty diff — nothing to review. Blocking by default.');
        summary('### ⛔ Consensus review: empty diff\n\nNothing to review, so nothing is approved.\n');
        process.exit(1);
    }
    const { text: diff, truncated } = prioritiseDiff(raw);
    console.log(`Reviewing ${raw.length} bytes of diff${truncated ? ` (truncated to ${diff.length}, sensitive files first)` : ''}`);
    console.log(`${llm.count} provider(s) available: ${llm.providers.map((p) => p.id).join(', ')}`);

    // Providers are dealt to the reviewers BEFORE any of them runs, so the board
    // can run concurrently and still be genuinely independent. See
    // assignProviders() for why wrapping the old sequential loop in Promise.all
    // would have collapsed all three reviewers onto one model while still
    // printing three green ticks.
    // Skip providers that told us to go away. Three separate runs lost the
    // architecture reviewer to a sambanova 429 — a wasted call followed by an
    // "unavailable" non-vote, which quietly reduces a three-reviewer board to two.
    let ledger = Budget.loadLedger();
    const cooling = orderFor({ env: process.env })
        .map((p) => p.id)
        .filter((id) => Budget.cooldownUntil(ledger, id, Date.now()));
    if (cooling.length) console.log(`  skipping rate-limited provider(s): ${cooling.join(', ')}`);
    const lanes = assignProviders(REVIEWERS, { unavailable: cooling });
    for (const lane of lanes) {
        console.log(`  ${lane.role.name} → ${lane.primary || 'NO PROVIDER'}${lane.fallbacks.length ? ` (fallbacks: ${lane.fallbacks.join(', ')})` : ''}`);
    }

    // allSettled, not all: one lane throwing must not cancel the others' verdicts.
    const started = Date.now();
    const recordAttempt = (info) => {
        ledger = Budget.record(ledger, { ...info, lane: Budget.LANES.CRITICAL });
    };
    const settled = await Promise.allSettled(lanes.map((lane) => runReviewer(lane, diff, truncated, chat, recordAttempt)));
    // Persist even when the board blocks: a 429 is precisely what the next run
    // needs to remember, and it is only ever learned by being refused.
    Budget.saveLedger(ledger);
    const votes = settled.map((s, i) => s.status === 'fulfilled'
        ? s.value
        // runReviewer already converts an outage into an `unavailable` vote, so
        // reaching here means it threw for some other reason. Still a non-vote:
        // a bug in this file is not a reviewer objection.
        : { name: lanes[i].role.name, vote: 'unavailable', provider: 'none', reason: `reviewer crashed: ${String(s.reason && s.reason.message).slice(0, 160)}`, concerns: [] });
    console.log(`Board finished in ${((Date.now() - started) / 1000).toFixed(1)}s (${lanes.length} reviewers in parallel)`);

    const result = tally(votes);
    const rows = votes.map((v) => {
        const icon = v.rejectedFinding ? '🚫' : v.vote === 'pass' ? '✅' : v.vote === 'unavailable' ? '⚪' : '❌';
        const ev = v.vote === 'fail' ? (v.evidence || '_no executable line cited_') : '';
        return `| ${icon} ${v.name} | \`${v.provider}\` | ${v.vote} | ${v.reason || '—'} | ${ev} |`;
    }).join('\n');

    const unsubstantiated = votes.filter((v) => v.vote === 'fail' && !v.evidence);
    const rejected = votes.filter((v) => v.rejectedFinding);

    // A board missing a reviewer is not the same as a board that objected, and
    // labelling both "BLOCKED" would train the reader to treat a real FAIL as
    // routine provider flakiness.
    const headline = result.merge ? '✅ Consensus review board — PASS'
        : result.degraded ? '⚠️ Consensus review board — INCOMPLETE'
            : '⛔ Consensus review board — BLOCKED';

    const report =
        `### ${headline}\n\n` +
        '| Reviewer | Model | Vote | Reason | Evidence |\n|---|---|---|---|---|\n' + rows + '\n\n' +
        `**Decision:** ${result.reason}\n\n` +
        (rejected.length
            /* THE PROSE HERE USED TO DESCRIBE ONE KIND OF REJECTION AND BE
             * PRINTED AFTER ALL OF THEM. The per-objection line below has
             * always been right — it uses the rejection's own `why` — but the
             * heading and the closing paragraph both asserted "a verbatim run
             * of this diff's own comment text", which is true of the FIRST
             * rejection kind only.
             *
             * So on the pull request that migrated the share dialog, the board
             * said, three lines apart: "rejected because the reason calls
             * something new, but the cited line REPLACED one reading the same
             * words" and then "that reason is a long verbatim run of this
             * diff's own comment text". Two different explanations of one
             * event, one of them wrong — and the paragraph closes by inviting
             * the reader to overrule, which is a judgement they would then be
             * making on the wrong account of what happened.
             *
             * The heading and closing are kind-neutral now. What differed
             * between rejections was always in `why`, and that is where it
             * stays. */
            ? '\n> 🚫 **Objection(s) rejected — not a finding about this diff.**\n'
              + rejected.map((v) =>
                  `> \`${v.name}\` objected: _"${String(v.rejectedFinding.reason).replace(/\n/g, ' ')}"_\n`
                  + `> rejected because ${v.rejectedFinding.why || 'it restated the diff'}.\n`
                  + (v.rejectedFinding.evidence ? `> cited: \`${String(v.rejectedFinding.evidence).replace(/\n/g, ' ')}\`\n` : '')
              ).join('> \n')
              + '> \n'
              + '> Each rejection above names its own reason. These checks are enforced in\n'
              + '> code rather than asked for in the prompt, because the same lane produced\n'
              + '> the same class of mistake across five reviews and four prompt rewrites.\n'
              + '> The objection is kept here rather than deleted, so you can overrule the\n'
              + '> rejection if you think the reviewer was onto something.\n'
            : '') +
        (result.outages
            ? `\n> ⚠️ **${result.outages} reviewer(s) unreachable — this board is INCOMPLETE.**\n`
              + `> A provider outage is not an objection, so nothing here disagreed with the change.\n`
              + '> But nothing reviewed it from that angle either, and a gate that did not run must not\n'
              + '> report a pass. Re-run once the provider recovers, or apply `human-approved` to accept\n'
              + `> the change on a ${result.cast}-reviewer board.\n`
            : '') +
        (result.shared && result.shared.length
            ? `\n> ℹ️ ${result.shared.join(', ')} ran on a provider another reviewer also used — its verdict\n`
              + '> counts, but it is not fully independent of the others.\n'
            : '') +
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

    const finalReport = !overridden ? report
        : report + (result.degraded
            // No objection was raised here — the board simply was not whole. Calling
            // that "overriding an objection" would misdescribe what the human signed.
            ? '\n> ✅ **Accepted by `human-approved`.** A human accepted the change on an incomplete\n'
              + `> board. ${result.missing.join(', ')} never voted; that is recorded here rather than\n`
              + '> smoothed over, so the gap is visible if this change is ever questioned.\n'
            : '\n> ✅ **Overridden by `human-approved`.** A human reviewed the objection above and accepted the\n'
              + '> change. The board\'s verdict is preserved on the record rather than erased — an override is a\n'
              + '> documented decision, not a deleted one.\n');

    summary(finalReport);
    // Put the verdict where a human will actually see it. Until now the only
    // record was buried in the job log behind ~80 lines of runner output, which
    // makes a blocking decision effectively invisible.
    await postToPr(finalReport + '\n' + stampFor(headSha, mergeBase));

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
