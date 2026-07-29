/* =============================================================================
 * autonomy/propose.mjs — feature IDEAS, filed for a human to accept or reject
 * ---------------------------------------------------------------------------
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
import { chat, extractJson, describeAvailability } from './llm-router.mjs';

/** Label marking an issue as a machine-authored idea awaiting judgement. */
export const PROPOSAL_LABEL = 'feature-proposal';

/** Label a HUMAN adds to turn a proposal into work the agent may build. */
export const APPROVED_LABEL = 'approved-feature';

/** Marker so proposals are recognisable and countable forever. */
export const PROPOSAL_TAG = 'wf-proposal';

/** Never hold more than this many undecided proposals. */
export const MAX_OPEN_PROPOSALS = 2;

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

/** Open issues that came from the in-app feedback form. */
export async function recentFeedback({ env = process.env, limit = 8 } = {}) {
    try {
        const all = await Q.allIssues({ env });
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
    'You propose ONE improvement to WealthFlow, a personal finance PWA built by and for a single user.',
    '',
    'HARD RULES:',
    '  • Propose something that fits the app that EXISTS. You are given its real modules and',
    '    navigation sections; do not invent a subsystem it does not have.',
    '  • Prefer an idea grounded in real user feedback if any is supplied. Say what prompted it.',
    '  • NO new paid services, NO new third-party dependencies, NO new hosting. The owner runs',
    '    this on free tiers, and a proposal with a monthly bill is not usable however good it is.',
    '  • Nothing touching authentication, encryption, or money arithmetic. Those paths change',
    '    only with a human driving.',
    '  • Small enough that one focused change delivers it. "Rebuild the dashboard" is not a',
    '    proposal, it is a project.',
    '  • If you have nothing genuinely worth the owner\'s attention, say so. Returning',
    '    {"worthProposing": false} is a correct and useful answer — an idea generator that can',
    '    never decline is just noise with a schema.',
    '',
    'Reply with ONE JSON object and nothing else:',
    '{"worthProposing": true|false,',
    ' "title": "short imperative title",',
    ' "problem": "the concrete user problem, in the owner\'s terms",',
    ' "prompt": "what led you here — a feedback issue number, a module, or a gap you observed",',
    ' "proposal": "what to build, specifically",',
    ' "scope": "which files would likely change",',
    ' "whyNow": "why this is worth doing before other things",',
    ' "risks": "what could go wrong or annoy the user"}',
].join('\n');

export function buildPrompt({ modules, sections, feedback }) {
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
    };
}

export function renderProposal(p) {
    return {
        title: `[PROPOSAL] ${p.title}`,
        labels: [PROPOSAL_LABEL, 'autonomous'],
        body: [
            '## Proposed improvement\n',
            '> **This is an idea, not a decision.** Nothing will be built from it unless you add',
            `> the \`${APPROVED_LABEL}\` label. Close it and the agent will not raise it again.\n`,
            `### The problem\n${p.problem || '_not stated_'}\n`,
            `### What prompted this\n${p.prompt || '_not stated_'}\n`,
            `### The proposal\n${p.proposal}\n`,
            p.scope ? `### Likely scope\n${p.scope}\n` : '',
            p.whyNow ? `### Why now\n${p.whyNow}\n` : '',
            p.risks ? `### Risks and annoyances\n${p.risks}\n` : '',
            '---\n',
            `**To build it:** add \`${APPROVED_LABEL}\`. The fix agent picks it up on its next`,
            'run and takes it through the same gates as every other change — tests, cross-provider',
            'review, consensus board, policy gate.\n',
            '**To decline:** close the issue. That is a normal outcome, and the proposer is',
            'graded on how often its ideas are accepted.\n',
            '---\n_Generated by [Claude Code](https://claude.ai/code)_\n',
            `\n<!-- ${PROPOSAL_TAG} -->\n`,
        ].filter(Boolean).join('\n'),
    };
}

/**
 * Generate at most one proposal. Returns { filed, reason }.
 * Never throws: a proposer that breaks the scheduled run would cost more than
 * it is worth, and it is the least important job on the schedule.
 */
export async function proposeOnce({ env = process.env, repoDir = process.cwd(), dryRun = false } = {}) {
    const avail = describeAvailability(env);
    if (!avail.healthy) return { filed: null, reason: 'no LLM provider configured' };

    let issues = [];
    try { issues = await Q.allIssues({ env }); } catch { return { filed: null, reason: 'could not read the queue' }; }

    const waiting = openProposalCount(issues);
    if (waiting >= MAX_OPEN_PROPOSALS) {
        return { filed: null, reason: `${waiting} proposal(s) already awaiting your decision` };
    }

    const { modules, sections } = appContext(repoDir);
    const feedback = await recentFeedback({ env });

    let reply;
    try {
        reply = await chat({
            system: SYSTEM,
            prompt: buildPrompt({ modules, sections, feedback }),
            env,
            maxTokens: 900,
            temperature: 0.4,   // ideas need a little room; verdicts do not
        });
    } catch (e) {
        return { filed: null, reason: `model unavailable: ${e.message}` };
    }

    const p = parseProposal(reply?.text ?? reply);
    if (!p) return { filed: null, reason: 'the model declined to propose anything, or returned nothing usable' };
    if (dryRun) return { filed: null, reason: 'dry run', proposal: p };

    const { title, body, labels } = renderProposal(p);
    for (const l of labels) await Q.ensureLabel(l, 'C2E0C6', 'Machine-authored idea awaiting a human decision', { env }).catch(() => {});
    await Q.ensureLabel(APPROVED_LABEL, '0E8A16', 'Owner approved this proposal — the agent may build it', { env }).catch(() => {});

    const issue = await Q.createIssue({ title, body, labels, env });
    return { filed: { number: issue?.number, title }, reason: 'proposed' };
}
