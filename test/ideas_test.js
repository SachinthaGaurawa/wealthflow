// =============================================================================
// The system thinks of its own improvements (owner, 2026-11-07): grounded, reasoned, safe by rule, agreed by independent AIs.
// These tests walk every branch of the decision, because the owner is NOT in the loop any more: the rules below are the only thing between
// a fluent idea and a pull request, so each refusal has to be proven, and so does the one path that says yes.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as I from '../autonomy/ideas.mjs';
import { parseProposal, renderProposal, buildPrompt, proposeOnce, PROPOSAL_LABEL, APPROVED_LABEL } from '../autonomy/propose.mjs';
import { isWorkable, roleFor } from '../autonomy/work-queue.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const research = I.readResearch(ROOT);
const signals = I.signalList({
    roadmap: research.roadmap, gaps: research.gaps, feedback: [{ number: 9, state: 'open', title: 'bills are hard to find' }],
    outcomes: [{ number: 40, title: 'Show a running balance column in the expenses table', state: 'declined' }], shipped: ['Devices follow each other\'s update'],
    app: { sections: ['dashboard', 'expenses'], modules: ['notifications'] },
});
const ids = signals.map((s) => s.id);

const idea = (over = {}) => ({
    title: 'Offer a one-tap undo after marking a bill paid',
    problem: 'A mis-tap on Mark paid changes the books and the person double-checks everything.',
    prompt: 'roadmap rank 1',
    proposal: 'After a bill is marked paid, show a bar for 8 seconds with an Undo button that restores the previous state of that one bill.',
    scope: 'wealthflow-expenses.js, index.html',
    whyNow: 'It removes the fear that slows every tap.', risks: 'The bar could cover the tab bar on a small phone.',
    evidence: ['R1'], ifThen: ['If a mis-tap changes the books, then people double-check every tap', 'If undo is one tap for 8 seconds, then they stop double-checking'],
    scores: { ease: 5, value: 4, small: 4, risk: 1 },
    ...over,
});
const board = (verdicts) => ({ voters: verdicts.length, verdict: 'BUILD', votes: verdicts.map((v, i) => ({ provider: 'p' + i, verdict: v })), easy: [], risks: [], first: '' });

describe('what the system studies', () => {
    it('reads the ranked roadmap in the research document, and skips what is built or the owner\'s call', () => {
        const rows = research.roadmap;
        expect(rows.length).toBeGreaterThanOrEqual(8);
        expect(rows[0].rank).toBe(1);
        expect(rows.find((r) => /Per-device facts/.test(r.idea)).done).toBe(true);
        expect(rows.find((r) => /Sinhala/.test(r.idea)).ownerOnly).toBe(true);
        expect(signals.some((s) => s.id.startsWith('R') && /Sinhala/.test(s.text))).toBe(false);
        expect(signals.some((s) => s.id.startsWith('R') && /Per-device facts/.test(s.text))).toBe(false);
    });
    it('reads the measured gaps the document lists as still failing or not yet measured', () => {
        expect(research.gaps.map((g) => g.kind).sort()).toEqual(['measured failure', 'not yet measured']);
    });
    it('numbers every signal with a stable id the model must quote', () => {
        expect(ids).toContain('R1'); expect(ids).toContain('G1'); expect(ids).toContain('F1'); expect(ids).toContain('H1'); expect(ids).toContain('P1'); expect(ids).toContain('A1');
        expect(new Set(ids).size).toBe(ids.length);
    });
    it('puts the numbered evidence in the prompt', () => {
        expect(buildPrompt({ modules: [], sections: [], feedback: [], signals })).toMatch(/EVIDENCE[\s\S]*R1 \[roadmap\]/);
    });
    it('learns what became of earlier ideas', () => {
        const mk = (n, state, labels, reason) => ({ number: n, title: '[PROPOSAL] x' + n, state, state_reason: reason, labels: labels.map((name) => ({ name })) });
        const o = I.outcomesOf([mk(1, 'closed', [PROPOSAL_LABEL], 'completed'), mk(2, 'closed', [PROPOSAL_LABEL], 'not_planned'), mk(3, 'open', [PROPOSAL_LABEL, APPROVED_LABEL]), mk(4, 'open', [PROPOSAL_LABEL]), mk(5, 'open', ['bug']), { ...mk(6, 'open', [PROPOSAL_LABEL]), pull_request: {} }]);
        expect(o.map((x) => x.state)).toEqual(['built', 'declined', 'building', 'waiting']);
        expect(I.inFlight(o)).toBe(2);
        expect(o[0].title).toBe('x1');
    });
});

describe('the cap does not hold for ever on ideas nobody picked up (found on the first real run)', () => {
    const day = 86400000, now = Date.parse('2026-11-11T05:00:00Z');
    const at = (days) => new Date(now - days * day).toISOString();
    const mk = (n, labels, days) => ({ number: n, title: '[PROPOSAL] y' + n, state: 'open', created_at: at(days), labels: labels.map((name) => ({ name })) });
    it('a waiting idea counts for 3 days, an approved one for 14', () => {
        const o = I.outcomesOf([mk(1, [PROPOSAL_LABEL], 2), mk(2, [PROPOSAL_LABEL], 4), mk(3, [PROPOSAL_LABEL, APPROVED_LABEL], 13), mk(4, [PROPOSAL_LABEL, APPROVED_LABEL], 15)]);
        expect(I.inFlight(o, now)).toBe(2);
        expect(o.map((x) => x.state)).toEqual(['waiting', 'waiting', 'building', 'building']);   // all four still count as earlier ideas (no repeats)
    });
    it('two old waiting ideas no longer stop the engine, and are still remembered as earlier ideas', async () => {
        const issues = [mk(443, [PROPOSAL_LABEL], 23), mk(430, [PROPOSAL_LABEL], 30)];
        expect(I.inFlight(I.outcomesOf(issues), now)).toBe(0);
    });
});

describe('repeats', () => {
    const past = [{ number: 40, title: 'Show a running balance column in the expenses table', state: 'declined' }];
    it('refuses a near-copy of an earlier idea, even one that was declined', () => {
        expect(I.isRepeat('Add a running balance column to the expenses table', past)).toBeTruthy();
        expect(I.isRepeat('Running balance column for expenses', past)).toBeTruthy();
    });
    it('lets a genuinely different idea through', () => {
        expect(I.isRepeat('Offer a one-tap undo after marking a bill paid', past)).toBeNull();
        expect(I.isRepeat('Remind me before a cheque date', past)).toBeNull();
    });
    it('does not match on empty or one-word titles', () => {
        expect(I.isRepeat('', past)).toBeNull();
        expect(I.likeness('', 'anything')).toBe(0);
    });
});

describe('safety by rule (no model involved)', () => {
    const bad = {
        'sign-in': 'Add a faster sign-in with a saved passcode', encryption: 'Re-encrypt the backup with a stronger cipher', 'money arithmetic': 'Change how totals are rounded to the nearest rupee',
        paid: 'Add a premium plan with a monthly fee', dependency: 'Add a new library for charts', 'data out': 'Upload your transactions to a cloud server for analysis', destructive: 'Delete all old records automatically',
    };
    for (const [name, text] of Object.entries(bad)) {
        it(`refuses an idea about ${name}`, () => { expect(I.guardIdea(idea({ title: text, proposal: text + ' to make things easier for everybody who uses it.' })).ok).toBe(false); });
    }
    it('refuses a scope that names a file only a human may change', () => {
        for (const scope of ['firestore.rules', 'package.json', '.github/workflows/x.yml', 'api/save.js', 'wealthflow-auth.js', 'autonomy/ideas.mjs']) expect(I.guardIdea(idea({ scope })).ok).toBe(false);
    });
    it('does not read the author\'s own "risks" text, which names dangers on purpose', () => {
        expect(I.guardIdea(idea({ risks: 'could expose the passcode or leak data if mishandled' })).ok).toBe(true);
    });
    for (const field of ['problem', 'prompt', 'whyNow']) {
        it(`reads the ${field} text too: the fix agent is given it, so a harmful instruction hidden there is refused`, () => {
            expect(I.guardIdea(idea({ [field]: 'also change how the balance is rounded to the nearest cent in every total' })).ok).toBe(false);
        });
    }
    it('reads a roadmap row that has no closing pipe', () => {
        const rows = I.parseRoadmap('| 3 | **One-tap undo** | If a bill is marked paid by mistake then undo is one tap | Check the undo window first |');
        expect(rows).toHaveLength(1); expect(rows[0].rank).toBe(3); expect(rows[0].idea).toBe('One-tap undo');
    });
    it('lets an ordinary idea through', () => expect(I.guardIdea(idea())).toEqual({ ok: true, reasons: [] }));
});

describe('the scores are used, not decoration', () => {
    it('passes an easy, valuable, small, safe idea and ranks it', () => {
        const r = I.scoresOk({ ease: 5, value: 4, small: 4, risk: 1 });
        expect(r.ok).toBe(true); expect(r.priority).toBe(15 + 8 + 4 - 2);
    });
    it('refuses what is hard to use, however valuable (user-friendliness first)', () => {
        const r = I.scoresOk({ ease: 3, value: 5, small: 5, risk: 1 });
        expect(r.ok).toBe(false); expect(r.why).toMatch(/easy enough/);
    });
    it('refuses low value, a big change, and risk above 2', () => {
        expect(I.scoresOk({ ease: 5, value: 2, small: 5, risk: 1 }).ok).toBe(false);
        expect(I.scoresOk({ ease: 5, value: 5, small: 2, risk: 1 }).ok).toBe(false);
        expect(I.scoresOk({ ease: 5, value: 5, small: 5, risk: 3 }).ok).toBe(false);
    });
    it('refuses an idea that did not score itself, or scored with nonsense', () => {
        expect(I.scoresOk(I.readScores({})).ok).toBe(false);
        expect(I.scoresOk(I.readScores({ scores: { ease: 'high', value: 4, small: 4, risk: 1 } })).ok).toBe(false);
        expect(I.readScores({ scores: { ease: 99, value: -3, small: 4.4, risk: 1 } })).toEqual({ ease: 5, value: 1, small: 4, risk: 1 });
    });
    it('keeps only well-formed evidence ids and reasoning lines', () => {
        expect(I.readEvidence({ evidence: 'r1, G2; nonsense, F10' })).toEqual(['R1', 'G2', 'F10']);
        expect(I.readIfThen({ ifThen: ['If a, then b is long enough', 'short', 'If c, then d is long enough'] })).toHaveLength(2);
    });
});

describe('the decision, branch by branch', () => {
    const run = (over, b = null, outcomes = []) => I.decide({ idea: idea(over), signals, outcomes, board: b });
    it('skips a repeat before spending anything', () => expect(run({ title: 'Show a running balance column in the expenses table' }, null, [{ number: 40, title: 'Show a running balance column in the expenses table', state: 'declined' }]).act).toBe('skip'));
    it('declines an idea that cites nothing it was given', () => { const r = run({ evidence: ['Z9'] }); expect(r.act).toBe('decline'); expect(r.why).toMatch(/not grounded/); });
    it('declines an idea with no if/then reasoning', () => expect(run({ ifThen: ['If only one line is not enough'] }).act).toBe('decline'));
    it('declines an unsafe idea, naming the reason', () => { const r = run({ title: 'Faster passcode entry', proposal: 'Let the passcode screen remember the last digits so entry is quicker for the person.' }); expect(r.act).toBe('decline'); expect(r.why).toMatch(/sign-in/); });
    it('declines on the scores', () => expect(run({ scores: { ease: 2, value: 5, small: 5, risk: 1 } }).act).toBe('decline'));
    it('asks the board only for an idea that passed every rule', () => expect(run({}).act).toBe('ask-board'));
    it('approves when two or more AIs raise no objection', () => { const r = run({}, board(['BUILD', 'BUILD_SMALLER', 'BUILD'])); expect(r.act).toBe('approve'); expect(r.priority).toBeGreaterThan(0); });
    it('ONE objection stops it, because no owner is there to overrule', () => { const r = run({}, board(['BUILD', 'ASK_OWNER', 'BUILD'])); expect(r.act).toBe('decline'); expect(r.why).toMatch(/1 of 3/); });
    it('fewer than two voters is not a board: try again, never a yes', () => { expect(run({}, board(['BUILD'])).act).toBe('retry'); expect(run({}, board([])).act).toBe('retry'); expect(run({}, null).act).toBe('ask-board'); });
});

describe('what is filed', () => {
    const p = parseProposal(JSON.stringify({ worthProposing: true, ...idea() }));
    it('reads the new fields from the model\'s reply', () => { expect(p.evidence).toEqual(['R1']); expect(p.ifThen).toHaveLength(2); expect(p.scores.ease).toBe(5); });
    it('an approved idea carries the approval labels and says who approved it and how to stop it', () => {
        const r = renderProposal(p, { approved: true, why: '3 AIs raised no objection', priority: 24 });
        expect(r.labels).toEqual(expect.arrayContaining([PROPOSAL_LABEL, APPROVED_LABEL, 'auto-approved']));
        expect(r.body).toMatch(/own AI system/); expect(r.body).toMatch(/close this issue/i); expect(r.body).toMatch(/NEW tag/); expect(r.body).toMatch(/If \/ then/);
        expect(isWorkable({ number: 1, labels: r.labels.map((name) => ({ name })) })).toBe(true);
    });
    it('a declined idea is never workable and says why', () => {
        const r = renderProposal(p, { declined: true, why: 'too risky (risk 4/5)' });
        expect(r.labels).toContain('idea-declined'); expect(r.labels).not.toContain(APPROVED_LABEL);
        expect(isWorkable({ number: 1, labels: r.labels.map((name) => ({ name })) })).toBe(true === false);
        expect(r.body).toMatch(/too risky/);
    });
    it('an idea with no decision is exactly the old "waiting for a human" issue', () => {
        const r = renderProposal(p);
        expect(r.labels).not.toContain(APPROVED_LABEL); expect(r.body).toMatch(/this is an idea, not a decision/i);
        expect(isWorkable({ number: 1, labels: r.labels.map((name) => ({ name })) })).toBe(false);
    });
    it('is always routed as a feature, whatever words its text contains', () => {
        expect(roleFor({ labels: [{ name: PROPOSAL_LABEL }], title: 'Fix error toast leak', body: 'an error that could leak' })).toBe('feature');
    });
});

describe('proposeOnce, end to end with the models and GitHub faked', () => {
    const env = { GROQ_API_KEY: 'x', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
    const budget = { LANES: { BACKGROUND: 'b' }, RESERVE_FOR_CRITICAL: 2, loadLedger: () => ({}), availableFor: () => ['groq', 'mistral', 'deepseek'], record: (l) => l, saveLedger: () => {} };
    const rig = (issues = [], reply = JSON.stringify({ worthProposing: true, ...idea() })) => {
        const filed = [], comments = [], closed = [];
        const queue = {
            allIssues: async () => issues, createIssue: async (x) => { filed.push(x); return { number: 100 + filed.length }; }, ensureLabel: async () => true,
            comment: async (n, b) => { comments.push([n, b]); }, closeIssue: async (n, o) => { closed.push([n, o.reason]); }, mergedPrTitles: async () => ['Devices follow each other\'s update'],
        };
        return { filed, comments, closed, run: (o = {}) => proposeOnce({ env, repoDir: ROOT, queue, budget, chatImpl: async () => ({ text: reply }), boardImpl: async () => board(['BUILD', 'BUILD', 'BUILD_SMALLER']), ...o }) };
    };
    it('approves a good idea, files it workable, and posts the board discussion', async () => {
        const r = rig(); const out = await r.run();
        expect(out.approved).toBe(true); expect(out.filed.number).toBe(101);
        expect(r.filed[0].labels).toContain(APPROVED_LABEL); expect(r.comments).toHaveLength(1); expect(r.comments[0][1]).toMatch(/Board discussion/); expect(r.closed).toEqual([]);
    });
    it('files a refused idea closed and labelled declined, so it is remembered', async () => {
        const r = rig(); const out = await r.run({ boardImpl: async () => board(['BUILD', 'ASK_OWNER', 'BUILD']) });
        expect(out.approved).toBe(false); expect(r.filed[0].labels).toContain('idea-declined'); expect(r.filed[0].labels).not.toContain(APPROVED_LABEL); expect(r.closed).toEqual([[101, 'not_planned']]);
    });
    it('does not file anything when the board could not be reached (tries again next run)', async () => {
        const r = rig(); const out = await r.run({ boardImpl: async () => board(['BUILD']) });
        expect(out.filed).toBeNull(); expect(out.reason).toMatch(/not decided/); expect(r.filed).toEqual([]);
    });
    it('does not spend the board on an idea the rules already refuse', async () => {
        let asked = 0; const r = rig([], JSON.stringify({ worthProposing: true, ...idea({ scores: { ease: 2, value: 5, small: 5, risk: 1 } }) }));
        const out = await r.run({ boardImpl: async () => { asked++; return board(['BUILD', 'BUILD']); } });
        expect(asked).toBe(0); expect(out.approved).toBe(false); expect(r.filed[0].labels).toContain('idea-declined');
    });
    it('a board that throws is "no AI reached": nothing is filed, nothing is approved, the run does not fail', async () => {
        const r = rig(); const out = await r.run({ boardImpl: async () => { throw new Error('provider exploded'); } });
        expect(out.filed).toBeNull(); expect(out.reason).toMatch(/not decided/); expect(r.filed).toEqual([]);
    });
    it('GitHub refusing to open the issue ends the run quietly, with nothing approved', async () => {
        const out = await proposeOnce({ env, repoDir: ROOT, budget, chatImpl: async () => ({ text: JSON.stringify({ worthProposing: true, ...idea() }) }), boardImpl: async () => board(['BUILD', 'BUILD']),
            queue: { allIssues: async () => [], createIssue: async () => { throw new Error('403'); }, ensureLabel: async () => true, comment: async () => {}, closeIssue: async () => {}, mergedPrTitles: async () => [] } });
        expect(out.filed).toBeNull(); expect(out.reason).toMatch(/could not file/);
    });
    it('files nothing for a near-copy of an earlier idea', async () => {
        const past = [{ number: 7, title: '[PROPOSAL] Offer a one-tap undo after marking a bill paid', state: 'closed', state_reason: 'not_planned', labels: [{ name: PROPOSAL_LABEL }] }];
        const r = rig(past); const out = await r.run();
        expect(out.filed).toBeNull(); expect(out.reason).toMatch(/near-copy of #7/); expect(r.filed).toEqual([]);
    });
    it('holds at two ideas in the pipeline', async () => {
        const open = (n) => ({ number: n, title: '[PROPOSAL] y' + n, state: 'open', labels: [{ name: PROPOSAL_LABEL }, { name: APPROVED_LABEL }] });
        const r = rig([open(1), open(2)]); const out = await r.run();
        expect(out.filed).toBeNull(); expect(out.reason).toMatch(/already in the pipeline/);
    });
    it('with automatic approval switched off it files the old waiting-for-a-human issue', async () => {
        const r = rig(); const out = await r.run({ autoApprove: false });
        expect(out.reason).toBe('proposed'); expect(r.filed[0].labels).not.toContain(APPROVED_LABEL);
    });
    it('a dry run files nothing and reports what it would do', async () => {
        const r = rig(); const out = await r.run({ dryRun: true });
        expect(out.filed).toBeNull(); expect(out.verdict.act).toBe('approve'); expect(r.filed).toEqual([]);
    });
    it('declines quietly when no model is configured', async () => {
        const out = await proposeOnce({ env: {}, repoDir: ROOT });
        expect(out.filed).toBeNull();
    });
});

describe('the schedule', () => {
    it('runs every day, not once a week (owner: no batching), and wakes the fix agent when something was approved', () => {
        const y = read('.github/workflows/feature-proposals.yml');
        expect(y).toMatch(/cron: '\d+ \d+ \* \* \*'/);
        expect(y).toContain('autonomous-fix.yml');
        expect(y).toMatch(/actions: write/);
    });
});

describe('the words are not the only guard', () => {
    it('every file the idea rules call human-only is also refused by the fix agent, whatever the issue says', async () => {
        const { isSensitive } = await import('../autonomy/agent-swarm.mjs');
        const named = ['wealthflow-auth.js', 'wealthflow-crypto.js', 'wealthflow-vault.js',
            'firestore.rules', 'vercel.json', 'package.json', 'package-lock.json', '.github/workflows/x.yml', 'autonomy/ideas.mjs'];
        for (const f of named) {
            expect(I.guardIdea({ title: 'ok', proposal: 'ok', scope: f }).ok, f + ' named in scope').toBe(false);
            expect(isSensitive(f), f + ' edited by the agent').toBe(true);
        }
        // and the ones whose NAMES the words can miss are still refused as files
        for (const f of ['index.html', 'sw.js', 'fifo-reconcile.js', 'wealthflow-migrations.js', 'send-otp.js', 'wealthflow-vault.js', 'statement-cloud-vault.mjs']) expect(isSensitive(f), f).toBe(true);
    });
});
