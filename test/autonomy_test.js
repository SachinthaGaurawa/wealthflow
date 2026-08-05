// =============================================================================
// WealthFlow Shadow Test Harness — the autonomous pipeline itself
// =============================================================================
// The pipeline used to fail silently: a missing env var crashed the agent in 40ms
// and the run still reported success. These tests pin down the behaviour that
// makes that impossible now — above all, that a misconfiguration is LOUD.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { REVIEWERS } from '../consensus-review.mjs';

import {
    PROVIDERS, keyFor, availableProviders, describeAvailability, orderFor, assignProviders,
    stripFences, extractJson,
} from '../autonomy/llm-router.mjs';
import {
    isSensitive, candidateFiles, resolvePick, parseVerdict, structuralCheck, ROLES, roleFor,
} from '../autonomy/agent-swarm.mjs';
import {
    severityOf, roleFor as queueRoleFor, rankIssues, attemptsFrom,
    claimedIssueOf, isWorkable, LABELS,
} from '../autonomy/work-queue.mjs';
import { signature, isStuck } from '../autonomous-fix-agent.js';

import { runs } from './fuzz-config.js';
// ── the router ───────────────────────────────────────────────────────────────
describe('llm-router: key discovery', () => {
    it('finds the Gemini key under this project\'s actual name, WealthFlow_API_Key', () => {
        // THE ORIGINAL BUG: the agent read GEMINI_API_KEY and threw when the real
        // configured secret was named WealthFlow_API_Key.
        const gemini = PROVIDERS.find((p) => p.id === 'gemini');
        expect(gemini.keys).toContain('WealthFlow_API_Key');
        const found = keyFor(gemini, { WealthFlow_API_Key: 'abc123' });
        expect(found).toEqual({ name: 'WealthFlow_API_Key', value: 'abc123' });
    });

    it('accepts any of the documented aliases for a provider', () => {
        const gemini = PROVIDERS.find((p) => p.id === 'gemini');
        for (const alias of ['WealthFlow_API_Key', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
            expect(keyFor(gemini, { [alias]: 'k' }), alias).toBeTruthy();
        }
    });

    it('ignores an empty or whitespace-only key (the "set but blank secret" trap)', () => {
        const gemini = PROVIDERS.find((p) => p.id === 'gemini');
        expect(keyFor(gemini, { WealthFlow_API_Key: '' })).toBeNull();
        expect(keyFor(gemini, { WealthFlow_API_Key: '   ' })).toBeNull();
    });

    it('reports unhealthy when NOTHING is configured, instead of pretending', () => {
        const d = describeAvailability({});
        expect(d.healthy).toBe(false);
        expect(d.count).toBe(0);
    });

    it('reports healthy with a single key — one provider is enough to run', () => {
        const d = describeAvailability({ GROQ_API_KEY: 'k' });
        expect(d.healthy).toBe(true);
        expect(d.count).toBe(1);
        expect(d.providers[0].id).toBe('groq');
    });

    it('every provider declares at least one key name and a model', () => {
        for (const p of PROVIDERS) {
            expect(p.keys.length, p.id).toBeGreaterThan(0);
            expect(typeof p.model(), p.id).toBe('string');
            expect(p.model().length, p.id).toBeGreaterThan(0);
        }
    });

    it('provider ids are unique', () => {
        const ids = PROVIDERS.map((p) => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('llm-router: ordering and independence', () => {
    const env = { GROQ_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', WealthFlow_API_Key: 'k', CEREBRAS_API_KEY: 'k' };

    it('excludes a provider so a reviewer never runs on the author\'s model', () => {
        const order = orderFor({ exclude: ['groq'], env });
        expect(order.map((p) => p.id)).not.toContain('groq');
    });

    it('floats a preferred strength to the front', () => {
        const order = orderFor({ prefer: ['security'], env });
        expect(order[0].strengths).toContain('security');
    });

    it('returns an empty list when no key is configured (caller must fail loudly)', () => {
        expect(orderFor({ env: {} })).toEqual([]);
    });

    it('restricts to an explicit allow-list', () => {
        expect(orderFor({ only: ['deepseek'], env }).map((p) => p.id)).toEqual(['deepseek']);
    });
});

describe('llm-router: parallel lane assignment (the Promise.all trap)', () => {
    // Four providers configured, three reviewers — the normal case.
    const env = { GROQ_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', WealthFlow_API_Key: 'k', CEREBRAS_API_KEY: 'k' };

    it('uses the REAL board composition (guards against a vacuous pass)', () => {
        // Asserting against invented roles is how a lane bug ships: a made-up
        // `prefer` list can satisfy every test here while the shipped reviewers
        // collide over one specialist model.
        expect(REVIEWERS).toHaveLength(3);
        expect(REVIEWERS.map((r) => r.name)).toEqual(['architecture', 'security', 'user-impact']);
        for (const r of REVIEWERS) expect(Array.isArray(r.prefer) && r.prefer.length).toBeTruthy();
    });

    it('gives every reviewer a DIFFERENT provider', () => {
        // The whole point. Wrapping the old sequential loop in Promise.all would have
        // started every lane with an empty `exclude`, so every reviewer would have
        // taken the top-ranked provider — one model wearing three hats, while the
        // report still showed three independent green ticks.
        const lanes = assignProviders(REVIEWERS, { env });
        const primaries = lanes.map((l) => l.primary);
        expect(primaries.every(Boolean)).toBe(true);
        expect(new Set(primaries).size).toBe(REVIEWERS.length);
    });

    it('returns lanes in declaration order, since callers zip by index', () => {
        const lanes = assignProviders(REVIEWERS, { env });
        expect(lanes.map((l) => l.role.name)).toEqual(REVIEWERS.map((r) => r.name));
    });

    it('lands each reviewer on a model that has one of its preferred strengths', () => {
        const lanes = assignProviders(REVIEWERS, { env });
        for (const l of lanes) {
            const p = PROVIDERS.find((x) => x.id === l.primary);
            const hit = p.strengths.some((s) => l.role.prefer.includes(s));
            expect(hit, `${l.role.name} got ${l.primary} (${p.strengths}) for prefer=${l.role.prefer}`).toBe(true);
        }
    });

    it('gives a scarce specialist to the reviewer that needs it most, not the first in the list', () => {
        // Only two providers, and deepseek is the ONLY one with 'security'. Claiming in
        // declaration order would hand it to `architecture` for a single matching
        // strength ('reasoning') and leave the security reviewer on a model with none
        // of its strengths. Regret-ordered claiming puts it where it counts.
        const lanes = assignProviders(REVIEWERS, { env: { DEEPSEEK_API_KEY: 'k', GROQ_API_KEY: 'k' } });
        const sec = lanes.find((l) => l.role.name === 'security');
        expect(sec.primary).toBe('deepseek');
    });

    it('keeps fallback sets DISJOINT so a retry cannot steal another lane\'s provider', () => {
        // A lane retrying after an outage must not land on the provider another
        // reviewer is mid-request on — that would silently recreate the shared-model
        // problem at exactly the moment nobody is watching.
        const lanes = assignProviders(REVIEWERS, { env });
        const seen = new Set();
        for (const l of lanes) {
            for (const f of l.fallbacks) {
                expect(seen.has(f), `${f} was dealt to two lanes`).toBe(false);
                seen.add(f);
            }
        }
    });

    it('never deals a primary as somebody else\'s fallback', () => {
        const lanes = assignProviders(REVIEWERS, { env });
        const primaries = new Set(lanes.map((l) => l.primary));
        for (const l of lanes) {
            for (const f of l.fallbacks) expect(primaries.has(f)).toBe(false);
        }
    });

    it('degrades honestly when there are fewer providers than reviewers', () => {
        // One key configured. Two reviewers MUST come back with no provider rather
        // than tripling up on the only model available — three votes from one model is
        // worse than one honest vote, because it is trusted three times as much.
        const lanes = assignProviders(REVIEWERS, { env: { GROQ_API_KEY: 'k' } });
        expect(lanes.filter((l) => l.primary)).toHaveLength(1);
        expect(lanes.filter((l) => !l.primary)).toHaveLength(2);
        for (const l of lanes) expect(l.fallbacks).toEqual([]);
    });

    it('returns a lane per role with no keys at all, and claims nothing', () => {
        const lanes = assignProviders(REVIEWERS, { env: {} });
        expect(lanes).toHaveLength(3);
        expect(lanes.every((l) => l.primary === null)).toBe(true);
    });

    it('is deterministic — the same environment deals the same lanes', () => {
        const a = assignProviders(REVIEWERS, { env });
        const b = assignProviders(REVIEWERS, { env });
        expect(a.map((l) => [l.primary, l.fallbacks])).toEqual(b.map((l) => [l.primary, l.fallbacks]));
    });

    it('never throws on an empty or malformed role list', () => {
        expect(assignProviders([], { env })).toEqual([]);
        expect(() => assignProviders(null, { env })).not.toThrow();
        expect(() => assignProviders([{}, null], { env })).not.toThrow();
    });
});

describe('llm-router: response parsing', () => {
    it('strips markdown fences a model wraps code in', () => {
        expect(stripFences('```javascript\nconst a = 1;\n```')).toBe('const a = 1;');
        expect(stripFences('```\nplain\n```')).toBe('plain');
        expect(stripFences('no fence')).toBe('no fence');
    });

    it('extracts a JSON object embedded in prose', () => {
        const j = extractJson('Sure! Here it is: {"verdict":"PASS","severity":"none"} — hope that helps.');
        expect(j).toEqual({ verdict: 'PASS', severity: 'none' });
    });

    it('handles braces inside JSON strings without truncating early', () => {
        const j = extractJson('{"reason":"uses { and } literally","verdict":"FAIL"}');
        expect(j.verdict).toBe('FAIL');
    });

    it('returns null rather than throwing on unparseable output', () => {
        expect(extractJson('no json here')).toBeNull();
        expect(extractJson('{ broken')).toBeNull();
        expect(extractJson('')).toBeNull();
    });

    it('never throws on arbitrary model output', () => {
        fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
            expect(() => extractJson(s)).not.toThrow();
            expect(() => stripFences(s)).not.toThrow();
        }), { numRuns: runs(500) });
    });
});

// ── the sensitive-path gate ──────────────────────────────────────────────────
describe('agent-swarm: sensitive-path gate (anti toxic-proactivity)', () => {
    const MUST_BE_BLOCKED = [
        'index.html', 'sw.js', 'firestore.rules', 'firebase.json', 'vercel.json',
        'package.json', 'package-lock.json',
        'drive-auth.js', 'send-otp.js', 'verify-otp.js', 'wealthflow-crypto.js',
        'fifo-reconcile.js', 'wealthflow-allocator.js', 'predict-wealth.js',
        'market-data.js', 'fx-rate.js', 'approve-release.js', 'release-brain.js',
        'release.cjs', 'CODEOWNERS',
        '.github/workflows/auto-release.yml', 'policy/wealthflow.rego',
        // the pipeline's own brain — the agent must not "fix" its own failures away
        'autonomy/llm-router.mjs', 'autonomous-fix-agent.js', 'autonomous-brain.js',
        'consensus-review.mjs', 'consensus-review.js',
        // …nor the harness that judges it. PRs #79 and #80 both tried to "fix"
        // the agent's non-running tests by flipping vitest.config.js to
        // environment 'jsdom' without the dependency: 904 passing tests -> 0.
        'vitest.config.js', 'vitest.config.mjs', 'vite.config.js',
    ];

    it.each(MUST_BE_BLOCKED)('refuses to edit %s', (f) => {
        expect(isSensitive(f)).toBe(true);
    });

    it('allows ordinary presentation/logic modules', () => {
        for (const f of ['wealthflow-insights.js', 'wealthflow-icons.js', 'wealthflow-format.js',
            'wealthflow-history.js', 'wealthflow-notifications.js']) {
            expect(isSensitive(f), f).toBe(false);
        }
    });

    it('treats empty/garbage paths as sensitive (fail closed)', () => {
        expect(isSensitive('')).toBe(true);
        expect(isSensitive(null)).toBe(true);
        expect(isSensitive(undefined)).toBe(true);
    });

    it('never lets a sensitive file into the candidate set, whatever the listing', () => {
        fc.assert(fc.property(
            fc.array(fc.constantFrom(...MUST_BE_BLOCKED, 'wealthflow-icons.js', 'x.js'), { maxLength: 20 }),
            (files) => {
                for (const f of candidateFiles(files, { repoDir: process.cwd() })) {
                    expect(isSensitive(f)).toBe(false);
                }
            },
        ), { numRuns: runs(200) });
    });

    it('candidateFiles rejects subdirectories, tests and non-JS', () => {
        const picked = candidateFiles(
            ['api/ai.js', 'foo.test.js', 'notes.md', 'wealthflow-icons.js'],
            { repoDir: process.cwd() },
        );
        expect(picked).toEqual(['wealthflow-icons.js']);
    });
});

describe('agent-swarm: model file-pick validation', () => {
    const files = ['wealthflow-icons.js', 'wealthflow-format.js'];

    it('accepts a clean in-list pick', () => {
        expect(resolvePick('wealthflow-icons.js', files)).toBe('wealthflow-icons.js');
    });

    it('tolerates quotes and trailing prose around the filename', () => {
        expect(resolvePick('`wealthflow-icons.js`', files)).toBe('wealthflow-icons.js');
        expect(resolvePick('wealthflow-icons.js\n\nThat is my answer.', files)).toBe('wealthflow-icons.js');
    });

    it('rejects NONE, a hallucinated file, and a sensitive file', () => {
        expect(resolvePick('NONE', files)).toBeNull();
        expect(resolvePick('does-not-exist.js', files)).toBeNull();
        expect(resolvePick('sw.js', [...files, 'sw.js'])).toBeNull();
    });

    it('never throws and never returns an out-of-list value', () => {
        fc.assert(fc.property(fc.string({ maxLength: 120 }), (s) => {
            const r = resolvePick(s, files);
            if (r !== null) expect(files).toContain(r);
        }), { numRuns: runs(500) });
    });
});

describe('agent-swarm: security verdict parsing fails closed', () => {
    it('reads a structured PASS', () => {
        expect(parseVerdict('{"verdict":"PASS","severity":"none","findings":[],"reason":"clean"}').verdict).toBe('PASS');
    });

    it('reads a structured FAIL with findings', () => {
        const v = parseVerdict('{"verdict":"FAIL","severity":"critical","findings":["removed auth check"],"reason":"unsafe"}');
        expect(v.verdict).toBe('FAIL');
        expect(v.findings).toContain('removed auth check');
    });

    it('FAILS when the reviewer returns nothing parseable', () => {
        expect(parseVerdict('').verdict).toBe('FAIL');
        expect(parseVerdict('I am not sure about this one').verdict).toBe('FAIL');
        expect(parseVerdict(null).verdict).toBe('FAIL');
    });

    it('never treats an ambiguous PASS-and-FAIL reply as a pass', () => {
        expect(parseVerdict('PASS ... actually FAIL').verdict).toBe('FAIL');
    });

    it('never throws on arbitrary reviewer output', () => {
        fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
            const v = parseVerdict(s);
            expect(['PASS', 'FAIL']).toContain(v.verdict);
        }), { numRuns: runs(500) });
    });
});

describe('agent-swarm: structural checks catch mangled rewrites', () => {
    const before = 'function a(){\n  return 1;\n}\n'.repeat(40);

    it('rejects a truncated rewrite', () => {
        const r = structuralCheck(before, 'function a(){');
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/truncated|unbalanced/);
    });

    it('rejects hallucinated bulk', () => {
        expect(structuralCheck(before, before.repeat(4)).ok).toBe(false);
    });

    it('rejects a surviving markdown fence', () => {
        expect(structuralCheck(before, '```js\n' + before).ok).toBe(false);
    });

    it('rejects a newly introduced eval()', () => {
        const r = structuralCheck(before, before + 'eval("x");\n');
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/eval/);
    });

    it('flags a newly introduced innerHTML sink', () => {
        const r = structuralCheck(before, before + 'el.innerHTML = userInput;\n');
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/innerHTML/);
    });

    it('rejects a placeholder instead of real code', () => {
        expect(structuralCheck(before, before + '// TODO: implement\n').ok).toBe(false);
    });

    it('accepts a genuine minimal edit', () => {
        const after = before.replace('return 1;', 'return Number(1) || 0;');
        expect(structuralCheck(before, after).ok).toBe(true);
    });

    it('never throws', () => {
        fc.assert(fc.property(fc.string({ maxLength: 200 }), fc.string({ maxLength: 200 }), (a, b) => {
            expect(() => structuralCheck(a, b)).not.toThrow();
        }), { numRuns: runs(300) });
    });
});

describe('agent-swarm: the five roles exist and are distinct', () => {
    it('defines all five blueprint agents', () => {
        expect(Object.keys(ROLES).sort()).toEqual(['bug', 'feature', 'qa', 'security', 'ui']);
    });

    it('gives every role a system prompt and provider preference', () => {
        for (const [id, r] of Object.entries(ROLES)) {
            expect(r.system.length, id).toBeGreaterThan(100);
            expect(Array.isArray(r.prefer), id).toBe(true);
        }
    });

    it('tells the three authoring roles the hard constraints', () => {
        for (const id of ['ui', 'feature', 'bug']) {
            expect(ROLES[id].system, id).toMatch(/ABSOLUTE CONSTRAINTS/);
            expect(ROLES[id].system, id).toMatch(/CANNOT_FIX_SAFELY/);
        }
    });

    it('falls back to the bug exterminator for an unknown kind', () => {
        expect(roleFor('nonsense').id).toBe('bug');
        expect(roleFor(undefined).id).toBe('bug');
    });
});

// ── the work queue ───────────────────────────────────────────────────────────
describe('work-queue: triage', () => {
    it('reads severity from a [CRITICAL] title prefix', () => {
        expect(severityOf({ title: '[CRITICAL] app will not open' })).toBe('critical');
        expect(severityOf({ title: '[low] tiny nit' })).toBe('low');
    });

    it('falls back to labels, then to low', () => {
        expect(severityOf({ title: 'x', labels: [{ name: 'security' }] })).toBe('critical');
        expect(severityOf({ title: 'x', labels: [{ name: 'bug' }] })).toBe('high');
        expect(severityOf({ title: 'x', labels: [] })).toBe('low');
    });

    it('routes security reports to the security role', () => {
        expect(queueRoleFor({ title: 'possible data leak', body: '' })).toBe('security');
    });

    it('routes look-and-feel reports to the UI role', () => {
        expect(queueRoleFor({ title: 'the font is too small to read', body: '' })).toBe('ui');
    });

    it('routes requests for new capability to the feature role', () => {
        expect(queueRoleFor({ title: 'please add a monthly export option', body: '' })).toBe('feature');
    });

    it('routes crashes to the bug role', () => {
        expect(queueRoleFor({ title: 'white screen when I open reports', body: '' })).toBe('bug');
    });

    it('ranks critical before low, and older before newer at equal severity', () => {
        const ranked = rankIssues([
            { title: '[low] nit', created_at: '2026-01-01' },
            { title: '[critical] broken', created_at: '2026-07-01' },
            { title: '[low] older nit', created_at: '2025-01-01' },
        ]);
        expect(ranked[0].title).toMatch(/critical/);
        expect(ranked[1].title).toMatch(/older/);
    });

    it('counts attempts from the agent\'s own comment marker only', () => {
        expect(attemptsFrom([
            { body: 'a human comment' },
            { body: '<!-- wf-agent-attempt -->\nattempt 1' },
            { body: '<!-- wf-agent-attempt -->\nattempt 2' },
        ])).toBe(2);
        expect(attemptsFrom([])).toBe(0);
    });
});

// ── dedup: one issue never gets two PRs ───────────────────────────────────────
// The first live run produced issue #3 → PR #4 AND PR #5, seconds apart. These
// tests pin the guard that stops the second run from opening a duplicate.
describe('work-queue: an issue with an open fix PR is not re-worked', () => {
    it('recovers the issue number from the agent\'s branch name', () => {
        expect(claimedIssueOf({ head: { ref: 'ai-fix/issue-3-1785302490' } })).toBe(3);
        expect(claimedIssueOf({ head: { ref: 'ai-fix/issue-42-1699999999' } })).toBe(42);
        expect(claimedIssueOf({ headRefName: 'ai-fix/issue-7-1' })).toBe(7);   // GraphQL shape
    });

    it('falls back to a closing keyword in the PR body', () => {
        expect(claimedIssueOf({ head: { ref: 'feature/manual' }, body: 'Closes #12' })).toBe(12);
        expect(claimedIssueOf({ head: { ref: 'x' }, body: 'this fixes #8 finally' })).toBe(8);
        expect(claimedIssueOf({ head: { ref: 'x' }, body: 'resolved #99.' })).toBe(99);
    });

    it('returns null when a PR references no issue — and never throws', () => {
        expect(claimedIssueOf({ head: { ref: 'chore/deps' }, body: 'bump' })).toBeNull();
        expect(claimedIssueOf({})).toBeNull();
        expect(claimedIssueOf(null)).toBeNull();
        expect(claimedIssueOf(undefined)).toBeNull();
    });

    it('never throws on adversarial PR shapes', () => {
        fc.assert(fc.property(fc.anything(), (pr) => {
            expect(() => claimedIssueOf(pr)).not.toThrow();
        }), { numRuns: runs(300) });
    });

    it('excludes an issue that already has an open fix PR', () => {
        const claimed = new Set([3]);
        expect(isWorkable({ number: 3 }, claimed)).toBe(false);   // PR #4/#5 duplicate, blocked
        expect(isWorkable({ number: 4 }, claimed)).toBe(true);    // an unclaimed issue is fine
    });

    it('still filters the labels it always did', () => {
        expect(isWorkable({ number: 1, pull_request: {} })).toBe(false);           // a PR, not an issue
        expect(isWorkable({ number: 2, labels: [{ name: LABELS.stuck }] })).toBe(false);
        expect(isWorkable({ number: 5, labels: [{ name: 'auto-rollback' }] })).toBe(false);
        expect(isWorkable({ number: 6, labels: [{ name: 'wontfix' }] })).toBe(false);
        expect(isWorkable({ number: 7, labels: [{ name: 'bug' }] })).toBe(true);
    });
});

// ── stuck detection ──────────────────────────────────────────────────────────
describe('agent: stuck detection stops the churn', () => {
    it('is not stuck on a first attempt', () => {
        expect(isStuck({ attempts: 0, signatures: [] }).stuck).toBe(false);
    });

    it('gives up after the attempt budget', () => {
        const s = isStuck({ attempts: 3, signatures: ['a'] });
        expect(s.stuck).toBe(true);
        expect(s.reason).toMatch(/attempts/);
    });

    it('gives up when it produces the same patch twice — no progress', () => {
        const s = isStuck({ attempts: 1, signatures: ['deadbeef', 'deadbeef'] });
        expect(s.stuck).toBe(true);
        expect(s.reason).toMatch(/no progress/);
    });

    it('keeps going while the patches genuinely differ', () => {
        expect(isStuck({ attempts: 1, signatures: ['aaa', 'bbb'] }).stuck).toBe(false);
    });

    it('signature is stable and content-sensitive', () => {
        expect(signature('abc')).toBe(signature('abc'));
        expect(signature('abc')).not.toBe(signature('abd'));
        expect(signature('')).toHaveLength(16);
    });

    it('tolerates a missing/garbage state object', () => {
        expect(() => isStuck(undefined)).not.toThrow();
        expect(isStuck({}).stuck).toBe(false);
    });
});

// ── the human override on the consensus board ────────────────────────────────
// The board's report tells the reader to apply `human-approved` when a FAIL
// cites no executable line. That advice was UNREACHABLE: nothing read the label
// and the workflow did not re-run on `labeled`, so one flaky model's
// evidence-free FAIL blocked a pull request forever — including the nodemailer
// security patch. These tests pin the escape hatch, and pin that it fails CLOSED.
describe('consensus: the human-approved override', () => {
    const OK = (labels) => async () => ({ ok: true, json: async () => labels });
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '10' };

    it('detects the label when present', async () => {
        const { hasHumanApproval } = await import('../consensus-review.mjs');
        expect(await hasHumanApproval(env, OK([{ name: 'human-approved' }]))).toBe(true);
        expect(await hasHumanApproval(env, OK([{ name: 'ai-fix' }, { name: 'human-approved' }]))).toBe(true);
    });

    it('is case-insensitive but not substring-loose', async () => {
        const { hasHumanApproval } = await import('../consensus-review.mjs');
        expect(await hasHumanApproval(env, OK([{ name: 'HUMAN-APPROVED' }]))).toBe(true);
        expect(await hasHumanApproval(env, OK([{ name: 'not-human-approved-yet' }]))).toBe(false);
    });

    it('returns false when the label is absent', async () => {
        const { hasHumanApproval } = await import('../consensus-review.mjs');
        expect(await hasHumanApproval(env, OK([{ name: 'ai-fix' }]))).toBe(false);
        expect(await hasHumanApproval(env, OK([]))).toBe(false);
    });

    it('FAILS CLOSED when the label cannot be verified', async () => {
        const { hasHumanApproval } = await import('../consensus-review.mjs');
        // An override we cannot verify is not an override. Each of these must
        // THROW so the caller blocks, rather than returning a soft `false` that
        // could later be mistaken for a successful "no label" answer.
        await expect(hasHumanApproval({}, OK([{ name: 'human-approved' }]))).rejects.toThrow();
        await expect(hasHumanApproval({ GITHUB_TOKEN: 't' }, OK([]))).rejects.toThrow();
        await expect(hasHumanApproval(env, async () => ({ ok: false, status: 403 }))).rejects.toThrow(/403/);
        await expect(hasHumanApproval(env, async () => ({ ok: true, json: async () => ({}) }))).rejects.toThrow(/non-array/);
        await expect(hasHumanApproval(env, async () => { throw new Error('network down'); })).rejects.toThrow(/network down/);
    });

    it('does not treat the payload as authoritative (the label race)', async () => {
        // A payload captured when the run was queued cannot contain a label added
        // a second later — the exact race that produced stale failures on PR #10.
        // The lookup must hit the API, so a stale env must not fabricate a pass.
        const { hasHumanApproval } = await import('../consensus-review.mjs');
        let called = false;
        await hasHumanApproval(env, async () => { called = true; return { ok: true, json: async () => [] }; });
        expect(called).toBe(true);
    });
});
