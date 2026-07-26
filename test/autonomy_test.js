// =============================================================================
// WealthFlow Shadow Test Harness — the autonomous pipeline itself
// =============================================================================
// The pipeline used to fail silently: a missing env var crashed the agent in 40ms
// and the run still reported success. These tests pin down the behaviour that
// makes that impossible now — above all, that a misconfiguration is LOUD.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
    PROVIDERS, keyFor, availableProviders, describeAvailability, orderFor,
    stripFences, extractJson,
} from '../autonomy/llm-router.mjs';
import {
    isSensitive, candidateFiles, resolvePick, parseVerdict, structuralCheck, ROLES, roleFor,
} from '../autonomy/agent-swarm.mjs';
import { severityOf, roleFor as queueRoleFor, rankIssues, attemptsFrom } from '../autonomy/work-queue.mjs';
import { signature, isStuck } from '../autonomous-fix-agent.js';

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
        }), { numRuns: 500 });
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
        ), { numRuns: 200 });
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
        }), { numRuns: 500 });
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
        }), { numRuns: 500 });
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
        }), { numRuns: 300 });
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
