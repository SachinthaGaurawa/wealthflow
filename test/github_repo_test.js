// =============================================================================
// WealthFlow Shadow Test Harness — repo resolution for the feedback endpoints
// =============================================================================
// The router fix (#42) made /api/feedback-triage reachable, and the first health
// check against production returned `configured: { repo: false, token: true }` —
// the token was set, the repo was not. resolveRepo() falls back to the repo
// Vercel already knows the deployment came from, so a report can be filed without
// a hand-set GITHUB_REPO. These tests pin the precedence exactly, because a
// wrong precedence here would file a user's bug report into the wrong repository.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';
import { resolveRepo, isValidRepo, resolveToken } from '../github-repo.js';
import { explain404 } from '../feedback-triage.js';

describe('resolveRepo: explicit configuration always wins', () => {
    it('uses GITHUB_REPO when set', () => {
        expect(resolveRepo({ GITHUB_REPO: 'owner/a' })).toBe('owner/a');
    });

    it('uses GITHUB_REPOSITORY when GITHUB_REPO is absent', () => {
        expect(resolveRepo({ GITHUB_REPOSITORY: 'owner/b' })).toBe('owner/b');
    });

    it('prefers GITHUB_REPO over GITHUB_REPOSITORY', () => {
        expect(resolveRepo({ GITHUB_REPO: 'owner/a', GITHUB_REPOSITORY: 'owner/b' })).toBe('owner/a');
    });

    it('prefers an explicit repo over the Vercel-inferred one', () => {
        // An operator who set GITHUB_REPO on purpose must not be overridden by the
        // deployment's own git metadata.
        expect(resolveRepo({
            GITHUB_REPO: 'owner/chosen',
            VERCEL_GIT_REPO_OWNER: 'someone', VERCEL_GIT_REPO_SLUG: 'else',
        })).toBe('owner/chosen');
    });
});

describe('resolveRepo: the Vercel fallback that closes the config gap', () => {
    it('builds owner/slug from the Vercel system variables', () => {
        expect(resolveRepo({
            VERCEL_GIT_REPO_OWNER: 'SachinthaGaurawa', VERCEL_GIT_REPO_SLUG: 'wealthflow',
        })).toBe('SachinthaGaurawa/wealthflow');
    });

    it('needs BOTH halves — a lone owner or a lone slug is not a repo', () => {
        expect(resolveRepo({ VERCEL_GIT_REPO_OWNER: 'SachinthaGaurawa' })).toBe('');
        expect(resolveRepo({ VERCEL_GIT_REPO_SLUG: 'wealthflow' })).toBe('');
    });

    it('returns "" when nothing identifies a repo — the "not configured" signal', () => {
        // The callers treat '' as not-configured and answer 503 with a reason.
        // With the Vercel vars absent, behaviour must be identical to before.
        expect(resolveRepo({})).toBe('');
    });
});

describe('resolveRepo: normalises what people actually paste', () => {
    // A slightly-off repo string does not fail loudly — it 404s, which looks
    // identical to a permissions problem. These shapes are cleaned up instead.
    const cases = [
        ['https://github.com/owner/repo', 'owner/repo'],
        ['https://github.com/owner/repo.git', 'owner/repo'],
        ['git@github.com:owner/repo.git', 'owner/repo'],
        ['  owner/repo  ', 'owner/repo'],
        ['/owner/repo/', 'owner/repo'],
        ['owner/repo/tree/main', 'owner/repo'],
    ];
    it.each(cases)('%s → %s', (input, want) => {
        expect(resolveRepo({ GITHUB_REPO: input })).toBe(want);
    });
});

describe('isValidRepo: catches a string GitHub could never accept', () => {
    it('accepts a real owner/name', () => {
        expect(isValidRepo('SachinthaGaurawa/wealthflow')).toBe(true);
    });
    it('rejects the shapes that produce a mystery 404', () => {
        for (const bad of ['', 'wealthflow', 'a/b/c', 'owner /repo', null, undefined]) {
            expect(isValidRepo(bad), String(bad)).toBe(false);
        }
    });
});

describe('resolveToken: which variable, never which value', () => {
    it('prefers GH_PAT, then GITHUB_TOKEN, then GITHUB_MODELS_TOKEN', () => {
        expect(resolveToken({ GH_PAT: 'a', GITHUB_TOKEN: 'b', GITHUB_MODELS_TOKEN: 'c' }).source).toBe('GH_PAT');
        expect(resolveToken({ GITHUB_TOKEN: 'b', GITHUB_MODELS_TOKEN: 'c' }).source).toBe('GITHUB_TOKEN');
        expect(resolveToken({ GITHUB_MODELS_TOKEN: 'c' }).source).toBe('GITHUB_MODELS_TOKEN');
    });
    it('reports no source when nothing is set', () => {
        expect(resolveToken({})).toEqual({ token: '', source: null });
    });
});

describe('explain404: GitHub\'s most ambiguous status, made actionable', () => {
    // GitHub answers 404 — never 403 — for an unauthorised repository, so that
    // private repo names cannot be probed. One status, four causes. Each must
    // produce a different instruction, or the user is left guessing again.
    const withProbe = (impl) => {
        const real = globalThis.fetch;
        globalThis.fetch = impl;
        return () => { globalThis.fetch = real; };
    };

    it('a malformed repo is named before any request is made', async () => {
        let called = false;
        const restore = withProbe(async () => { called = true; return { ok: true, json: async () => ({}) }; });
        const msg = await explain404('not-a-repo', 't', 'GH_PAT', {});
        restore();
        expect(msg).toMatch(/not a valid owner\/name pair/);
        expect(called, 'should not call GitHub for a string that cannot be a repo').toBe(false);
    });

    it('a token that cannot SEE the repo says so, and names the variable', async () => {
        const restore = withProbe(async () => ({ ok: false, status: 404 }));
        const out = {};
        const msg = await explain404('o/r', 't', 'GH_PAT', out);
        restore();
        expect(out.diagnosis).toBe('token_cannot_see_repo');
        expect(msg).toMatch(/cannot see o\/r/);
        expect(msg).toMatch(/GH_PAT/);
        expect(msg).toMatch(/Issues: Read and write/);
    });

    it('calls out GITHUB_MODELS_TOKEN specifically — it can never work', async () => {
        // The likeliest cause of a 404 with `token: true`: a Models inference
        // token has no repository permission at all, so no scope change fixes it.
        const restore = withProbe(async () => ({ ok: false, status: 404 }));
        const msg = await explain404('o/r', 't', 'GITHUB_MODELS_TOKEN', {});
        restore();
        expect(msg).toMatch(/GitHub Models inference token/);
        expect(msg).toMatch(/set GH_PAT instead/);
    });

    it('distinguishes "Issues are turned off" from a permissions problem', async () => {
        const restore = withProbe(async () => ({ ok: true, status: 200, json: async () => ({ has_issues: false }) }));
        const out = {};
        const msg = await explain404('o/r', 't', 'GH_PAT', out);
        restore();
        expect(out.diagnosis).toBe('issues_disabled');
        expect(msg).toMatch(/Issues are turned off/);
        expect(msg).not.toMatch(/cannot see/);
    });

    it('readable repo + failed create means the Issues permission is missing', async () => {
        const restore = withProbe(async () => ({ ok: true, status: 200, json: async () => ({ has_issues: true }) }));
        const out = {};
        const msg = await explain404('o/r', 't', 'GH_PAT', out);
        restore();
        expect(out.diagnosis).toBe('token_cannot_write_issues');
        expect(msg).toMatch(/can read o\/r but may not create issues/);
    });

    it('never throws, and never returns an empty explanation', async () => {
        const restore = withProbe(async () => { throw new Error('network down'); });
        const msg = await explain404('o/r', 't', null, {});
        restore();
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(20);
    });

    it('never leaks the token into the explanation', async () => {
        const restore = withProbe(async () => ({ ok: false, status: 404 }));
        const msg = await explain404('o/r', 'ghp_supersecretvalue', 'GH_PAT', {});
        restore();
        expect(msg).not.toContain('ghp_supersecretvalue');
        expect(msg).not.toContain('supersecret');
    });
});

describe('resolveRepo: safety', () => {
    it('never throws on arbitrary env shapes and never returns a non-string', () => {
        fc.assert(fc.property(fc.dictionary(fc.string(), fc.string()), (env) => {
            expect(() => resolveRepo(env)).not.toThrow();
            expect(typeof resolveRepo(env)).toBe('string');
        }), { numRuns: runs(300) });
    });

    it('both endpoints resolve the repo through this one helper', () => {
        // The bug being prevented is drift: two endpoints that each decide the
        // repo their own way will eventually disagree. Assert they share the path.
        for (const f of ['feedback-triage.js', 'feedback-status.js']) {
            const src = fs.readFileSync(f, 'utf8');
            expect(src, f).toMatch(/from '\.\/github-repo\.js'/);
            expect(src, f).toMatch(/resolveRepo\(/);
        }
    });
});
