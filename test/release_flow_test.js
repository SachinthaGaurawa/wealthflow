/* test/release_flow_test.js — the check that would have caught the weeks-long stall */
import { describe, it, expect } from 'vitest';
import { evaluateReleaseFlow, STALL_HOURS, DEPLOY_GRACE_MIN } from '../autonomy/release-flow.mjs';

const H = 36e5, M = 6e4;
const now = Date.parse('2026-11-03T12:00:00Z');
const base = (over = {}) => ({
    now, lastTag: 'v7.69.35', oldestUnreleased: null, unreleasedCount: 0,
    repoVersion: '7.69.35', repoVersionAt: now - 5 * H,
    deployed: { version: '7.69.35', manifest: '7.69.35', shell: '7.69.35', sw: '7.69.35', sha: 'abc1234def' },
    recentShas: ['abc1234', 'bbb2222'],
    local: { shell: '7.69.35', sw: '7.69.35', update: '7.69.35', pkg: '7.69.35' },
    ...over,
});
const by = (r, id) => r.checks.find((c) => c.id === id);

describe('release stall', () => {
    it('THE REAL CASE: 72 real commits waiting 24 days is BROKEN', () => {
        const r = evaluateReleaseFlow(base({ unreleasedCount: 72, oldestUnreleased: { sha: 'x', at: now - 24 * 24 * H, subject: 'Portal: faster code request' } }));
        expect(by(r, 'release-stall').status).toBe('broken');
        expect(r.overall).toBe('broken');
        expect(by(r, 'release-stall').summary).toMatch(/72 real change/);
    });
    it('a change merged an hour ago is inside the cadence', () => {
        const r = evaluateReleaseFlow(base({ unreleasedCount: 1, oldestUnreleased: { sha: 'x', at: now - 1 * H, subject: 's' } }));
        expect(by(r, 'release-stall').status).toBe('ok');
    });
    it(`the boundary is ${STALL_HOURS}h`, () => {
        const mk = (h) => evaluateReleaseFlow(base({ unreleasedCount: 1, oldestUnreleased: { sha: 'x', at: now - h * H, subject: 's' } }));
        expect(by(mk(STALL_HOURS - 0.1), 'release-stall').status).toBe('ok');
        expect(by(mk(STALL_HOURS + 0.1), 'release-stall').status).toBe('broken');
    });
    it('nothing waiting is healthy; no reachable tag is only a warning', () => {
        expect(evaluateReleaseFlow(base()).overall).toBe('healthy');
        expect(by(evaluateReleaseFlow(base({ lastTag: null })), 'release-stall').status).toBe('warn');
    });
});

describe('is it live, and do all places agree', () => {
    it('repo ahead of production long after the version commit is BROKEN; inside the deploy window it is a warning', () => {
        const dep = { version: '7.69.35', manifest: '7.69.35', shell: '7.69.35', sw: '7.69.35', sha: 'abc1234' };
        const late = evaluateReleaseFlow(base({ repoVersion: '7.69.36', local: { shell: '7.69.36', sw: '7.69.36', update: '7.69.36', pkg: '7.69.36' }, repoVersionAt: now - (DEPLOY_GRACE_MIN + 5) * M, deployed: dep }));
        expect(by(late, 'release-live').status).toBe('broken');
        const early = evaluateReleaseFlow(base({ repoVersion: '7.69.36', local: { shell: '7.69.36', sw: '7.69.36', update: '7.69.36', pkg: '7.69.36' }, repoVersionAt: now - 10 * M, deployed: dep }));
        expect(by(early, 'release-live').status).toBe('warn');
    });
    it('"some places show another version" (issue #110) is BROKEN', () => {
        const r = evaluateReleaseFlow(base({ deployed: { version: '7.69.35', manifest: '7.69.35', shell: '7.69.31', sw: '7.69.35', sha: 'abc1234' } }));
        expect(by(r, 'version-drift').status).toBe('broken');
        expect(by(r, 'version-drift').summary).toMatch(/app shell=7\.69\.31/);
    });
    it('the repo disagreeing with itself is BROKEN', () => {
        const r = evaluateReleaseFlow(base({ local: { shell: '7.69.35', sw: '7.69.34', update: '7.69.35', pkg: '7.69.35' } }));
        expect(by(r, 'local-version-law').status).toBe('broken');
    });
    it('a deployed commit that is not on main is a warning; an unreachable site is a warning, never a pass', () => {
        expect(by(evaluateReleaseFlow(base({ deployed: { version: '7.69.35', manifest: '7.69.35', shell: '7.69.35', sw: '7.69.35', sha: 'ffff999' } })), 'deployed-build').status).toBe('warn');
        const r = evaluateReleaseFlow(base({ deployed: null }));
        expect(by(r, 'release-live').status).toBe('warn');
    });
});
