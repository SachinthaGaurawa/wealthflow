/* =============================================================================
 * autonomy/propose.mjs — the system's own feature IDEAS: studied, reasoned, checked, and (since 2026-11-07) approved by the system itself
 * ---------------------------------------------------------------------------
 * CHANGE (owner, 2026-11-07): "The system must think for itself ... introduce new ideas ... nothing may need my hand."
 *   The text below this block was written when a human had to add `approved-feature`. That gate is now replaced by the four machine-checkable
 *   gates in autonomy/ideas.mjs (grounding in cited evidence, scored if/then reasoning, safety rules, a cross-provider board where ONE objection
 *   stops it). The containment that remains: at most 2 ideas in flight, never auth/encryption/money arithmetic/paid services/new dependencies,
 *   every idea ships as a normal pull request through the same gates, and closing an idea's issue stops it. The original reasoning follows.
 *
 * WHY THIS ONE IS DIFFERENT FROM EVERY OTHER PART OF THE PIPELINE
 *   Every detector in discover.mjs answers a question that HAS a right answer:
 *   is this CVE real, does this button call a function that exists, is this id
 *   duplicated in the live DOM. Each ships evidence, and a machine can check it.
 *
 *   "Should WealthFlow have feature X?" has no such answer. A model asked for
 *   feature ideas will always produce fluent, plausible ones — that is what it
 *   is for — and they will pass CI, because tests prove a thing WORKS, never
 *   that it was WANTED. Wire that to auto-merge and the app drifts, one
 *   reasonable-sounding addition at a time, away from the one you built for
 *   yourself.
 *
 *   So this module has exactly one power: it opens an issue. It cannot write
 *   code, cannot open a pull request, and cannot merge. A proposal only becomes
 *   work when a human adds the `approved-feature` label, at which point the
 *   ordinary fix pipeline picks it up like any other queue item. The taste stays
 *   with the owner; the labour moves to the machine.
 *
 * GROUNDED IN THE APP, NOT IN THE ABSTRACT
 *   The model is not asked "what would be cool". It is given the modules that
 *   actually exist, the sections the UI actually renders, and — most usefully —
 *   the user feedback already sitting in the queue. A proposal that cites a real
 *   feedback issue is worth reading; one invented from nothing usually is not,
 *   which is why every proposal must state what prompted it.
 *
 * RATE-LIMITED ON PURPOSE
 *   At most 2 open proposals at a time. An idea generator with no cap produces
 *   an inbox, and an inbox you stop reading is indistinguishable from a system
 *   that proposes nothing.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import * as Q from './work-queue.mjs';
import { chat, extractJson, describeAvailability, orderFor } from './llm-router.mjs';
import { withCharter } from '../wf-charter.mjs';
import * as Budget from './provider-budget.mjs';
import * as Ideas from './ideas.mjs';
import { runConceptBoard, renderComment as boardComment, synthesize } from './concept-board.mjs';
import { chatMany } from './llm-router.mjs';

/** Label marking an issue as a machine-authored idea awaiting judgement. */
export const PROPOSAL_LABEL = 'feature-proposal';

/** Label a HUMAN adds to turn a proposal into work the agent may build. */
export const APPROVED_LABEL = 'approved-feature';

/** Marker so proposals are recognisable and countable forever. */
export const PROPOSAL_TAG = 'wf-proposal';

/** Never hold more than this many ideas in the pipeline (waiting or being built) at once. */
export const MAX_OPEN_PROPOSALS = Ideas.MAX_IN_FLIGHT;

/** Read the app's real shape so ideas are about THIS app. */
export function appContext(repoDir = process.cwd()) {
    let modules = [];
    try {
        modules = execFileSync('git', ['ls-files'], { cwd: repoDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
            .split('\n')
            .filter((f) => /^wealthflow-[a-z0-9-]+\.js$/.test(f))
            .map((f) => f.replace(/^wealthflow-|\.js$/g, ''));
    } catch { /* not a git checkout */ }

    // Page containers, not sidebar links. The sidebar is BUILT AT RUNTIME — there
    // is no `sb-item` anywhere in index.html, so the obvious selector matched
    // nothing and quietly handed the model an empty section list. `id="page-*"`
    // is in the markup and is therefore checkable without a browser.
    let sections = [];
    try {
        const html = fs.readFileSync(path.join(repoDir, 'index.html'), 'utf8');
        sections = [...html.matchAll(/id="page-([A-Za-z0-9_-]+)"/g)]
            .map((m) => m[1])
            .filter((s, i, a) => a.indexOf(s) === i)
            .slice(0, 30);
    } catch { /* no shell to read */ }

    return { modules, sections };
}

/** Every tracked file of the checkout: what an idea's "scope" is checked against (Ideas.groundScope). Empty outside git. */
export function repoFiles(repoDir = process.cwd()) {
    try {
        return execFileSync('git', ['ls-files'], { cwd: repoDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
    } catch { return []; }
}

/** Open issues that came from the in-app feedback form. */
export async function recentFeedback({ env = process.env, limit = 8, queue = Q } = {}) {
    try {
        const all = await queue.allIssues({ env });
        return all
            .filter((i) => !i.pull_request)
            .filter((i) => (i.labels || []).some((l) => String(l?.name || l).toLowerCase() === Q.LABELS.feedback))
            .slice(0, limit)
            .map((i) => ({ number: i.number, title: i.title, state: i.state }));
    } catch { return []; }
}

/** How many undecided proposals are already waiting on the owner. */
export function openProposalCount(issues) {
    return (issues || []).filter((i) =>
        i.state === 'open'
        && (i.labels || []).some((l) => String(l?.name || l).toLowerCase() === PROPOSAL_LABEL)).length;
}

const SYSTEM = [
    'You are the idea engine of WealthFlow, a personal finance PWA built by and for a single user, used on a phone in Sri Lanka (LKR).',
    'Nobody asked you for an idea: you study the evidence below and decide, yourself, the ONE improvement most worth building next, or decline.',
    '',
    'HARD RULES:',
    '  • USER-FRIENDLINESS COMES FIRST. A person who is not technical, on a small screen, must find it and use it in a few taps. If it needs explaining, it is not ready.',
    '  • GROUND IT. Every idea must cite the evidence it came from by id (R1, G2, F1 ...), exactly as numbered below. An idea that cites nothing is dropped.',
    '    Prefer a measured gap or real feedback over a feeling. Never repeat anything marked "earlier idea" or "already shipped"; improve on what the evidence shows instead.',
    '  • REASON IT. Give an "if X, then Y" chain of two to four steps from the evidence to the benefit. Then score yourself honestly 1-5:',
    '    ease (5 = obvious to anyone), value (5 = used every week), small (5 = one focused change), risk (5 = could harm money, data or trust). Inflated scores are checked by other AIs.',
    '  • Fit the app that EXISTS. Use only the modules and screens listed. A new option shows a NEW tag (data-wf-new="YYYY-MM-DD" on the element) and can be undone.',
    '  • NO new paid services, third-party dependencies or hosting. NOTHING touching sign-in, encryption, money arithmetic, or sending the owner\'s data anywhere new. No destructive actions.',
    '  • Small enough that one focused change delivers it. "Rebuild the dashboard" is a project, not an idea.',
    '  • If nothing is genuinely worth building, say so: {"worthProposing": false} is a correct answer. Filler is worse than silence.',
    '',
    'Reply with ONE JSON object and nothing else:',
    '{"worthProposing": true|false,',
    ' "title": "short imperative title",',
    ' "problem": "the concrete user problem, in the owner\'s terms",',
    ' "evidence": ["ids from the numbered list, e.g. R2, G1"],',
    ' "ifThen": ["If ..., then ...", "If ..., then ..."],',
    ' "scores": {"ease": 1-5, "value": 1-5, "small": 1-5, "risk": 1-5},',
    ' "prompt": "what led you here, in words",',
    ' "proposal": "what to build, specifically, in the fewest taps",',
    ' "scope": "the files that would change, by their REAL names: a module \\"x\\" in the evidence is the file wealthflow-x.js, the screens are in index.html, and there is no src/ folder. A program checks every name against the repository",',
    ' "whyNow": "why this beats other work",',
    ' "risks": "what could go wrong or annoy the user"}',
].join('\n');

export function buildPrompt({ modules, sections, feedback, signals = null }) {
    if (signals && signals.length) {
        return [
            'EVIDENCE (cite ids):',
            Ideas.renderSignals(signals),
            '',
            'Propose one improvement, citing evidence ids, or decline.',
        ].join('\n');
    }
    return [
        `Modules that exist: ${modules.join(', ') || '(none discovered)'}`,
        `Navigation sections: ${sections.join(', ') || '(none discovered)'}`,
        feedback.length
            ? `Real user feedback currently in the queue:\n${feedback.map((f) => `  #${f.number} [${f.state}] ${f.title}`).join('\n')}`
            : 'No user feedback is currently queued. Ground the idea in the modules and sections above, and say so.',
        '',
        'Propose one improvement, or decline.',
    ].join('\n');
}

/** Turn a model reply into a proposal object, or null if it declined/garbled. */
export function parseProposal(raw) {
    const j = extractJson(String(raw || ''));
    if (!j || typeof j !== 'object') return null;
    if (j.worthProposing === false) return null;
    const title = String(j.title || '').trim();
    const proposal = String(j.proposal || '').trim();
    // A proposal with no title or no substance is a non-answer, not an idea.
    if (title.length < 6 || proposal.length < 30) return null;
    return {
        title: title.slice(0, 110),
        problem: String(j.problem || '').trim().slice(0, 900),
        prompt: String(j.prompt || '').trim().slice(0, 400),
        proposal: proposal.slice(0, 1600),
        scope: String(j.scope || '').trim().slice(0, 400),
        whyNow: String(j.whyNow || '').trim().slice(0, 500),
        risks: String(j.risks || '').trim().slice(0, 600),
        evidence: Ideas.readEvidence(j),
        ifThen: Ideas.readIfThen(j),
        scores: Ideas.readScores(j),
    };
}

/**
 * The issue for an idea. `outcome` is how the system decided: omitted = the original "waiting for a human" text;
 * {approved, why, priority} = approved by the system; {declined, why} = refused, filed closed so it is remembered.
 */
export function renderProposal(p, outcome = null) {
    const approved = !!(outcome && outcome.approved);
    const declined = !!(outcome && outcome.declined);
    const labels = [PROPOSAL_LABEL, 'autonomous'];
    if (approved) labels.push(APPROVED_LABEL, Ideas.IDEA_LABELS.auto);
    if (declined) labels.push(Ideas.IDEA_LABELS.declined);
    const sc = p.scores || {};
    const lines = [
        '## Proposed improvement\n',
        approved
            ? '> **Thought of by WealthFlow\'s own AI system and approved by it.** It was grounded in the evidence below, passed the safety rules, and no AI on the board objected.\n> To stop it: close this issue before its pull request merges. It will be built as a normal pull request through the usual tests and reviews, with a NEW tag.\n'
            : declined
                ? `> **Thought of by the system and declined by it:** ${outcome.why}. Kept closed so it is not proposed again.\n`
                : '> **This is an idea, not a decision.** Nothing will be built from it unless you add\n'
                  + `> the \`${APPROVED_LABEL}\` label. Close it and the agent will not raise it again.\n`,
        `### The problem\n${p.problem || '_not stated_'}\n`,
        `### What prompted this\n${p.prompt || '_not stated_'}\n`,
        p.evidence && p.evidence.length ? `### Evidence it cites\n${p.evidence.join(', ')}\n` : '',
        p.ifThen && p.ifThen.length ? `### If / then\n${p.ifThen.map((x) => `- ${x}`).join('\n')}\n` : '',
        `### The proposal\n${p.proposal}\n`,
        p.scope ? `### Likely scope\n${p.scope}\n` : '',
        p.whyNow ? `### Why now\n${p.whyNow}\n` : '',
        p.risks ? `### Risks and annoyances\n${p.risks}\n` : '',
        sc.ease ? `### Its own scores (1-5)\nease ${sc.ease}, value ${sc.value}, smallness ${sc.small}, risk ${sc.risk}${outcome && outcome.priority ? `, priority ${outcome.priority}` : ''}\n` : '',
        '---\n',
    ];
    if (!approved && !declined) {
        lines.push(
            `**To build it:** add \`${APPROVED_LABEL}\`. The fix agent picks it up on its next`,
            'run and takes it through the same gates as every other change — tests, cross-provider',
            'review, consensus board, policy gate.\n',
            '**To decline:** close the issue. That is a normal outcome, and the proposer is',
            'graded on how often its ideas are accepted.\n',
            '---\n');
    } else if (approved) {
        lines.push(`**Why it was approved:** ${outcome.why}.\n`, '**Delivery rules:** a normal pull request; a new option or screen shows the NEW tag; no new dependency; easy to undo; the usual tests, review and policy gate decide whether it merges.\n', '---\n');
    }
    lines.push('_Generated by [Claude Code](https://claude.ai/code)_\n', `\n<!-- ${PROPOSAL_TAG} -->\n`);
    return { title: `[PROPOSAL] ${p.title}`, labels, body: lines.filter(Boolean).join('\n') };
}

/** The titles of recently merged pull requests, so the engine knows what already exists. Never throws. */
export async function recentlyShipped({ env = process.env, limit = 12, queue = Q } = {}) {
    try { return await queue.mergedPrTitles({ env, limit }); } catch { return []; }
}

/**
 * Think of at most one idea, decide on it, and (if the system approves) hand it to the fix pipeline.
 * Returns { filed, reason, approved? }. Never throws: the idea engine must not be what turns the Actions tab red.
 *
 * The decision itself is Ideas.decide() (pure, tested); this function only gathers evidence, asks the models and files issues.
 */
export async function proposeOnce({
    env = process.env, repoDir = process.cwd(), dryRun = false,
    // Injected so the background-lane decision can be tested. Without this the
    // queue read happens first and fails in any sandbox, so a test would never
    // reach the reservation guard below and would pass for the wrong reason —
    // the same trap as a wiring test whose regex also matched the function
    // definition it was meant to prove was called.
    queue = Q, chatImpl = chat, budget = Budget, boardImpl = null,
    proposeImpl = null,        // async (question) => [{ text, provider }]: stands in for "ask every AI" in a test
    now = Date.now(),
    autoApprove = String(env.WF_IDEAS_AUTO ?? '1') !== '0',
} = {}) {
    const avail = describeAvailability(env);
    if (!avail.healthy) return { filed: null, reason: 'no LLM provider configured' };

    let issues = [];
    try { issues = await queue.allIssues({ env }); } catch { return { filed: null, reason: 'could not read the queue' }; }

    const outcomes = Ideas.outcomesOf(issues);
    const waiting = Ideas.inFlight(outcomes, now);
    if (waiting >= MAX_OPEN_PROPOSALS) {
        return { filed: null, reason: `${waiting} idea(s) already in the pipeline (waiting or being built)` };
    }
    // One idea a day. The pacemaker may start this job for a slot GitHub skipped, and GitHub may run the late slot too.
    const recent = dryRun ? null : Ideas.thoughtRecently(outcomes, now);
    if (recent) return { filed: null, reason: `already thought of an idea in the last ${Ideas.THINK_AGAIN_HOURS} hours (#${recent.number}: ${recent.title})` };

    // ── STUDY THE APP: the measured roadmap, the measured gaps, real feedback, what became of earlier ideas, what already shipped ──
    const { modules, sections } = appContext(repoDir);
    const files = repoFiles(repoDir);
    const feedback = await recentFeedback({ env, queue });
    const research = Ideas.readResearch(repoDir);
    const shipped = await recentlyShipped({ env, queue });
    const signals = Ideas.signalList({ roadmap: research.roadmap, gaps: research.gaps, feedback, outcomes, shipped, app: { modules, sections } });

    // ── BACKGROUND LANE ─────────────────────────────────────────────────────
    // Drafting a feature idea is the least important thing this pipeline does, and
    // it shares a free-tier quota with the consensus board on your pull requests.
    // So it runs on the providers left AFTER the critical reservation, and if that
    // set is empty it declines rather than borrowing one. A weekly idea that waits
    // a week costs nothing; a security review with no provider left blocks a merge
    // or silently does not happen.
    let ledger = budget.loadLedger();
    const ranked = orderFor({ env });
    const allowed = budget.availableFor({
        lane: budget.LANES.BACKGROUND, ranked, ledger, now: Date.now(),
    });
    if (!allowed.length) {
        return {
            filed: null,
            reason: `no background provider available — ${budget.RESERVE_FOR_CRITICAL} reserved for pull-request review`
                + `${Object.keys(ledger.cooldowns || {}).length ? ' and some are rate-limited' : ''}`,
        };
    }
    const onAttempt = (info) => { ledger = budget.record(ledger, { ...info, lane: budget.LANES.BACKGROUND }); };

    // ── EVERY AI PROPOSES, INDEPENDENTLY (autonomy/ideas.mjs "every AI proposes; a program chooses") ──
    // Each available background provider is asked the same question and none sees another's answer. With a chat
    // function injected (tests) there is one proposer, which is the old behaviour.
    const question = {
        system: withCharter(SYSTEM, 'board'),
        prompt: buildPrompt({ modules, sections, feedback, signals }),
        env,
        only: allowed,          // never a provider the critical path is holding
        maxTokens: 1100,
        temperature: 0.4,   // ideas need a little room; verdicts do not
        onAttempt,
    };
    const askAll = proposeImpl || (chatImpl !== chat ? async (o) => [await chatImpl(o)] : (o) => chatMany(o, Math.min(Ideas.MAX_PROPOSERS, allowed.length)));
    const candidatesFrom = (replies) => (replies || []).map((r) => ({ idea: parseProposal(r?.text ?? r), by: String(r?.provider || 'an AI') })).filter((c) => c.idea);

    let replies;
    try { replies = await askAll(question); }
    catch (e) {
        // Spend is recorded even on failure: a rate limit is exactly the thing the
        // ledger needs to remember, and it is only learned by being refused.
        budget.saveLedger(ledger);
        return { filed: null, reason: `model unavailable: ${e.message}` };
    }
    if (!replies || !replies.length) { budget.saveLedger(ledger); return { filed: null, reason: 'model unavailable: no AI answered' }; }

    let candidates = candidatesFrom(replies);
    if (!candidates.length) { budget.saveLedger(ledger); return { filed: null, reason: 'the model declined to propose anything, or returned nothing usable' }; }

    // ── A PROGRAM CHOOSES: rules first (free). If every idea broke a rule, the AIs are told why and asked once more. ──
    let weighed = Ideas.rankCandidates(candidates, { signals, outcomes });
    let rounds = 1;
    if (!weighed.passed.length && weighed.refused.some((r) => r.act === 'decline')) {
        rounds = 2;
        try {
            const again = candidatesFrom(await askAll({ ...question, prompt: question.prompt + Ideas.refusalBrief(weighed.refused), temperature: 0.6 }));
            if (again.length) {
                candidates = [...candidates, ...again];
                weighed = Ideas.rankCandidates(candidates, { signals, outcomes });
            }
        } catch { /* the first round's answer stands */ }
    }
    const thinking = {
        proposers: [...new Set(candidates.map((c) => c.by))], rounds,
        proposed: candidates.length, passed: weighed.passed.length,
        refused: weighed.refused.map((r) => ({ by: r.by, title: r.idea.title, why: r.why })),
    };

    // ── THE BOARD: only for an idea that passed the rules, best first, at most MAX_BOARDS of them ──
    let p = null, verdict = null, board = null, by = '';
    if (!weighed.passed.length) {
        // Nothing survived. A near-copy of an earlier idea is skipped; otherwise the best-scored refused idea is kept (closed) so it is remembered.
        const declined = weighed.refused.filter((r) => r.act === 'decline');
        const pick = declined[0] || weighed.refused[0];
        p = pick.idea; by = pick.by; verdict = { act: pick.act, why: pick.why };
        if (verdict.act === 'skip') { budget.saveLedger(ledger); return { filed: null, reason: verdict.why, proposal: p, thinking }; }
    } else if (!autoApprove) {
        ({ idea: p, by } = weighed.passed[0]);
        verdict = { act: 'wait', why: 'automatic approval is switched off' };   // WF_IDEAS_AUTO=0: the old human gate
    } else {
        const ask = (o, n) => chatMany({ ...o, only: allowed, onAttempt }, n);
        for (const cand of weighed.passed.slice(0, Ideas.MAX_BOARDS)) {
            // The board must never take the run down: a throw is "no AI could be reached", which `decide` turns into retry, never into approval.
            let b;
            try { b = await (boardImpl || runConceptBoard)({ issueText: Ideas.boardTextFor(cand.idea), env, ask }); }
            catch { b = { voters: 0, votes: [] }; }
            const v = Ideas.decide({ idea: cand.idea, signals, outcomes, board: b });
            // The first idea the board was asked about is the one reported, unless a later one is approved.
            if (!p || v.act === 'approve') { p = cand.idea; by = cand.by; verdict = v; board = b; }
            if (v.act === 'approve' || v.act === 'retry') break;
        }
        if (verdict.act === 'approve') {
            const agree = (weighed.passed.find((c) => c.idea === p) || {}).agree || [];
            verdict = { ...verdict, why: `${verdict.why}; proposed by ${by}${agree.length ? `, and ${agree.join(' and ')} proposed the same thing independently` : ''}; ${thinking.proposed} idea(s) from ${thinking.proposers.length} AI(s) were weighed` };
        }
    }
    budget.saveLedger(ledger);
    if (verdict.act === 'retry') return { filed: null, reason: `not decided: ${verdict.why}; tried again next run`, proposal: p, thinking };
    if (dryRun) return { filed: null, reason: `dry run (${verdict.act}: ${verdict.why || 'ok'})`, proposal: p, verdict, thinking };

    const outcome = verdict.act === 'approve' ? { approved: true, why: verdict.why, priority: verdict.priority }
        : verdict.act === 'decline' ? { declined: true, why: verdict.why } : null;
    // The scope is checked against the files that exist (the first approved idea named two that do not: Ideas.groundScope).
    // After the safety rules, which read the scope as the model wrote it.
    const grounded = Ideas.groundScope(p.scope, files);
    if (grounded.changed) p = { ...p, scope: grounded.text };
    const { title, body, labels } = renderProposal(p, outcome);
    for (const l of labels) await queue.ensureLabel(l, l === Ideas.IDEA_LABELS.declined ? 'CCCCCC' : 'C2E0C6', 'Machine-authored idea', { env }).catch(() => {});
    await queue.ensureLabel(APPROVED_LABEL, '0E8A16', 'The idea may be built by the agent', { env }).catch(() => {});

    let issue;
    try { issue = await queue.createIssue({ title, body, labels, env }); }
    catch (e) { return { filed: null, reason: `could not file the idea: ${e.message}; tried again next run`, proposal: p }; }
    if (issue?.number && board && board.voters && !dryRun) await queue.comment(issue.number, boardComment(board), { env }).catch(() => {});
    if (outcome && outcome.declined && issue?.number) await queue.closeIssue(issue.number, { env, reason: 'not_planned' }).catch(() => {});
    return {
        thinking,
        filed: { number: issue?.number, title },
        approved: !!(outcome && outcome.approved),
        reason: outcome ? (outcome.approved ? `approved by the system: ${outcome.why}` : `declined by the system: ${outcome.why}`) : 'proposed',
    };
}
