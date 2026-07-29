// =============================================================================
// WealthFlow Shadow Test Harness — feature proposals
// =============================================================================
// This is the one module in the pipeline whose output CANNOT be verified by a
// machine. Every detector answers a question with a right answer — is this CVE
// real, does this button call a function that exists. "Should WealthFlow have
// feature X?" does not, and a model asked for ideas will always produce fluent
// plausible ones, which then pass CI because tests prove a thing WORKS, never
// that it was WANTED.
//
// So the tests below are mostly about CONTAINMENT, not quality. The property
// that matters more than any other is the last describe block: an unapproved
// proposal must never become work.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    parseProposal, renderProposal, buildPrompt, appContext, openProposalCount,
    PROPOSAL_LABEL, APPROVED_LABEL, MAX_OPEN_PROPOSALS,
} from '../autonomy/propose.mjs';
import { isWorkable } from '../autonomy/work-queue.mjs';

const good = JSON.stringify({
    worthProposing: true,
    title: 'Show a running balance column in the expenses table',
    problem: 'You cannot see what is left after each expense without adding them up by hand.',
    prompt: 'feedback #42 asks how much is left mid-month',
    proposal: 'Add a running-balance column to the expenses table, computed client side from the existing rows, toggled from the table header.',
    scope: 'wealthflow-expenses.js, index.html',
    whyNow: 'It reuses data already loaded, so it is cheap.',
    risks: 'The column could confuse if the table is sorted by anything but date.',
});

describe('propose: reading the model', () => {
    it('accepts a well-formed proposal', () => {
        const p = parseProposal(good);
        expect(p).toBeTruthy();
        expect(p.title).toMatch(/running balance/i);
        expect(p.prompt).toMatch(/#42/);
    });

    it('honours an explicit decline', () => {
        // A generator that can never say "nothing worth your attention" is just
        // noise with a schema, so declining has to be a first-class outcome.
        expect(parseProposal('{"worthProposing": false}')).toBeNull();
    });

    it('rejects a proposal with no substance', () => {
        expect(parseProposal(JSON.stringify({ worthProposing: true, title: 'Improve app', proposal: 'make it better' }))).toBeNull();
        expect(parseProposal(JSON.stringify({ worthProposing: true, title: 'x', proposal: 'y'.repeat(50) }))).toBeNull();
    });

    it('returns null rather than throwing on anything unparseable', () => {
        expect(parseProposal('not json')).toBeNull();
        expect(parseProposal('')).toBeNull();
        expect(parseProposal(null)).toBeNull();
        fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
            expect(() => parseProposal(s)).not.toThrow();
        }), { numRuns: runs(300) });
    });

    it('truncates every field, so a runaway reply cannot produce a wall of text', () => {
        const huge = JSON.stringify({
            worthProposing: true, title: 'T'.repeat(500), problem: 'P'.repeat(5000),
            proposal: 'X'.repeat(9000), scope: 'S'.repeat(2000),
        });
        const p = parseProposal(huge);
        expect(p.title.length).toBeLessThanOrEqual(110);
        expect(p.problem.length).toBeLessThanOrEqual(900);
        expect(p.proposal.length).toBeLessThanOrEqual(1600);
    });
});

describe('propose: the issue it files', () => {
    const issue = renderProposal(parseProposal(good));

    it('is labelled as a proposal, never as work', () => {
        expect(issue.labels).toContain(PROPOSAL_LABEL);
        expect(issue.labels).not.toContain(APPROVED_LABEL);
        expect(issue.title.startsWith('[PROPOSAL]')).toBe(true);
    });

    it('states plainly that nothing happens without approval', () => {
        expect(issue.body).toMatch(/this is an idea, not a decision/i);
        expect(issue.body).toContain(APPROVED_LABEL);
    });

    it('says how to decline, not only how to accept', () => {
        // An approval flow that only documents "yes" quietly pressures a "yes".
        expect(issue.body).toMatch(/to decline/i);
        expect(issue.body).toMatch(/close the issue/i);
    });

    it('carries what prompted it, so an ungrounded idea is visible as such', () => {
        expect(issue.body).toMatch(/What prompted this/);
        expect(issue.body).toMatch(/#42/);
    });
});

describe('propose: grounded in the app that exists', () => {
    it('discovers real modules and pages from the repository', () => {
        const c = appContext(process.cwd());
        expect(c.modules.length).toBeGreaterThan(10);
        expect(c.sections).toContain('dashboard');       // id="page-dashboard"
        expect(c.sections).toContain('expenses');
    });

    it('tells the model when there is no feedback rather than inventing some', () => {
        const p = buildPrompt({ modules: ['a'], sections: ['dashboard'], feedback: [] });
        expect(p).toMatch(/No user feedback is currently queued/);
    });

    it('passes real feedback through when it exists', () => {
        const p = buildPrompt({ modules: [], sections: [], feedback: [{ number: 7, title: 'export is slow', state: 'open' }] });
        expect(p).toMatch(/#7/);
        expect(p).toMatch(/export is slow/);
    });
});

describe('propose: rate limiting', () => {
    const proposal = (state) => ({ state, labels: [{ name: PROPOSAL_LABEL }] });

    it('counts only OPEN proposals against the cap', () => {
        expect(openProposalCount([proposal('open'), proposal('closed'), proposal('open')])).toBe(2);
    });

    it('ignores ordinary issues', () => {
        expect(openProposalCount([{ state: 'open', labels: [{ name: 'bug' }] }])).toBe(0);
    });

    it('keeps the cap small enough to stay readable', () => {
        expect(MAX_OPEN_PROPOSALS).toBeLessThanOrEqual(3);
    });
});

// ── the property that matters most ───────────────────────────────────────────
describe('propose: an unapproved proposal is NEVER built', () => {
    const withLabels = (...names) => ({ number: 1, labels: names.map((name) => ({ name })) });

    it('is not workable while it only carries the proposal label', () => {
        // Without this, propose-then-approve silently becomes propose-then-build,
        // which defeats the entire design: the owner keeps strategic control
        // precisely because the machine cannot act on its own ideas.
        expect(isWorkable(withLabels(PROPOSAL_LABEL))).toBe(false);
    });

    it('becomes workable only once a human adds the approval label', () => {
        expect(isWorkable(withLabels(PROPOSAL_LABEL, APPROVED_LABEL))).toBe(true);
    });

    it('is still blocked if approval is absent, whatever else is attached', () => {
        expect(isWorkable(withLabels(PROPOSAL_LABEL, 'bug'))).toBe(false);
        expect(isWorkable(withLabels(PROPOSAL_LABEL, 'security'))).toBe(false);
        expect(isWorkable(withLabels(PROPOSAL_LABEL, 'autonomous', 'enhancement'))).toBe(false);
    });

    it('does not accidentally block ordinary issues', () => {
        expect(isWorkable(withLabels('bug'))).toBe(true);
        expect(isWorkable(withLabels('user-feedback'))).toBe(true);
    });
});
