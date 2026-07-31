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
import { resolveRepo } from '../github-repo.js';

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
