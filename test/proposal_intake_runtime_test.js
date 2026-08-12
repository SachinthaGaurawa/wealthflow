/* =============================================================================
 * test/proposal_intake_runtime_test.js — the EXECUTOR, not the planner
 * -----------------------------------------------------------------------------
 * test/proposal_intake_test.js asserts the decisions. This asserts that the
 * decisions are the only thing that ever reaches GitHub:
 *
 *   · a dry run writes NOTHING — the whole point of shipping behind --plan
 *   · a failed dedup lookup writes NOTHING (fail closed), because the
 *     alternative is re-filing every cluster on every run until the queue is
 *     unusable
 *   · enrich comments once per (issue, cluster), never once per run forever
 *
 * work-queue is mocked so no network is involved and the calls can be counted.
 * A test that "passes" because nothing ran is the failure mode this repository
 * keeps producing, so the call counts are asserted in both directions.
 * ===========================================================================*/

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = { createIssue: [], comment: [], ensureLabel: [], issueComments: [] };
const state = { proposals: [], issues: [], issuesThrow: null, comments: [] };

vi.mock('../autonomy/work-queue.mjs', () => ({
    firestoreProposals: async () => state.proposals,
    allIssues: async () => { if (state.issuesThrow) throw new Error(state.issuesThrow); return state.issues; },
    createIssue: async (a) => { calls.createIssue.push(a); return { number: 900 + calls.createIssue.length }; },
    comment: async (n, b) => { calls.comment.push({ n, b }); return {}; },
    ensureLabel: async (n) => { calls.ensureLabel.push(n); return true; },
    issueComments: async (n) => { calls.issueComments.push(n); return state.comments; },
}));

const { runIntake, renderEnrich, proposalFingerprint, MINT_LABELS } = await import('../autonomy/proposal-intake.mjs');
const { fingerprint: triageFingerprint } = await import('../feedback-triage.js');

const proposal = (sample, over = {}) => ({
    sample, title: `Fix: ${sample}`, priority: 'critical', category: 'bug', reports: 5,
    generatedAt: '2026-08-11T10:00:00.000Z', number: null, ...over,
});
const issue = (n, labels = [], over = {}) => ({
    number: n, state: 'open', body: '', labels: labels.map((name) => ({ name })), ...over,
});

beforeEach(() => {
    for (const k of Object.keys(calls)) calls[k] = [];
    state.proposals = []; state.issues = []; state.issuesThrow = null; state.comments = [];
});

describe('a dry run writes nothing at all', () => {
    it('decides but does not file', async () => {
        state.proposals = [proposal('exports freeze the dashboard completely')];
        const r = await runIntake({ apply: false });

        expect(r.applied).toBe(false);
        expect(r.decisions.map((d) => d.action)).toEqual(['mint']);   // it DID decide
        expect(calls.createIssue, 'a dry run created an issue').toEqual([]);
        expect(calls.comment).toEqual([]);
        expect(calls.ensureLabel, 'a dry run mutated the label set').toEqual([]);
    });
});

describe('fail closed', () => {
    it('writes nothing when the dedup lookup fails', async () => {
        // Without this the intake cannot see what already exists, so every
        // cluster looks new and gets filed again — on every run.
        state.proposals = [proposal('exports freeze the dashboard completely')];
        state.issuesThrow = 'API rate limit exceeded';

        const r = await runIntake({ apply: true });
        expect(r.error).toMatch(/dedup lookup failed: API rate limit exceeded/);
        expect(r.applied).toBe(false);
        expect(r.decisions).toEqual([]);
        expect(calls.createIssue).toEqual([]);
        expect(calls.comment).toEqual([]);
    });

    it('does nothing quietly when Firestore has no proposals', async () => {
        state.proposals = [];
        const r = await runIntake({ apply: true });
        expect(r.proposals).toBe(0);
        expect(calls.createIssue).toEqual([]);
    });
});

describe('apply actually writes — and only what was planned', () => {
    it('mints an uncovered cluster with the non-autonomous labels', async () => {
        state.proposals = [proposal('exports freeze the dashboard completely')];
        const r = await runIntake({ apply: true });

        expect(r.applied).toBe(true);
        expect(calls.createIssue).toHaveLength(1);
        expect(calls.createIssue[0].labels).toEqual(MINT_LABELS);
        expect(calls.createIssue[0].labels).not.toContain('ai-fix');
        expect(calls.ensureLabel).toEqual(MINT_LABELS);       // labels created first — GitHub 422s otherwise
        expect(r.decisions[0].result).toEqual({ number: 901 });
        expect(calls.comment).toEqual([]);
    });

    it('enriches instead of minting when an issue already covers it', async () => {
        const text = 'exports freeze the dashboard completely';
        state.proposals = [proposal(text)];
        state.issues = [issue(41, ['user-feedback', triageFingerprint(text)])];

        const r = await runIntake({ apply: true });
        expect(calls.createIssue, 'it filed a duplicate of #41').toEqual([]);
        expect(calls.comment).toHaveLength(1);
        expect(calls.comment[0].n).toBe(41);
        expect(calls.comment[0].b).toMatch(/Reports in this cluster:\*\* 5/);
        expect(r.decisions[0].result).toEqual({ commented: 41 });
    });

    it('does not comment twice across runs', async () => {
        const text = 'exports freeze the dashboard completely';
        const p = proposal(text);
        state.proposals = [p];
        state.issues = [issue(41, [triageFingerprint(text)])];
        state.comments = [{ body: renderEnrich(p, proposalFingerprint(p)) }];

        const r = await runIntake({ apply: true });
        expect(calls.issueComments).toEqual([41]);            // it looked
        expect(calls.comment, 'it repeated an enrich comment').toEqual([]);
        expect(r.decisions[0].result).toEqual({ skipped: 'already commented' });
    });

    it('records a per-item failure without abandoning the rest', async () => {
        state.proposals = [
            proposal('first distinct ledger problem appears'),
            proposal('second distinct ledger problem appears'),
        ];
        let n = 0;
        const wq = await import('../autonomy/work-queue.mjs');
        vi.spyOn(wq, 'createIssue').mockImplementation(async (a) => {
            if (++n === 1) throw new Error('secondary rate limit');
            calls.createIssue.push(a);
            return { number: 950 };
        });

        const r = await runIntake({ apply: true });
        expect(r.decisions[0].result).toEqual({ error: 'secondary rate limit' });
        expect(r.decisions[1].result, 'one failure stopped the whole run').toEqual({ number: 950 });
        vi.restoreAllMocks();
    });
});

describe('the mock is real enough to be worth trusting', () => {
    it('the intake genuinely calls work-queue rather than something inert', async () => {
        // Guards a vacuous suite: if runIntake stopped calling these, every
        // "wrote nothing" assertion above would pass for the wrong reason.
        state.proposals = [proposal('exports freeze the dashboard completely')];
        await runIntake({ apply: true });
        expect(calls.createIssue.length + calls.comment.length).toBeGreaterThan(0);
    });
});
