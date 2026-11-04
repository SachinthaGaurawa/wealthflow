// =============================================================================
// /api/autonomy-status tells the truth about the update system, from GitHub.
// Found 2026-11-04 (issue #514): the endpoint imported a CI tool that reads a git
// checkout, Vercel did not bundle it, and every call answered HTTP 500, so every
// report said "agent: unknown". Now it reads only GitHub and never answers 500.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import handler, { judge, collect, lastRealChange } from '../autonomy-status.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const run = (conclusion, at = '2026-11-04T10:00:00Z') => ({ conclusion, created_at: at, html_url: 'https://github.com/o/r/actions/runs/1' });
const commit = (msg, date) => ({ commit: { message: msg, author: { date } } });

function fakeRes() {
    const r = { code: 0, body: null, headers: {} };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
}

describe('autonomy-status: the file imports nothing the host would not bundle', () => {
    it('only imports the two helpers that are on the includeFiles list', () => {
        const src = fs.readFileSync('autonomy-status.js', 'utf8');
        const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
        expect(imports.sort()).toEqual(['./fetch-timeout.mjs', './github-repo.js']);
        // feedback-status.js is live and answers 200 with exactly these two imports, so they are known to be bundled.
        const sibling = fs.readFileSync('feedback-status.js', 'utf8');
        for (const f of ['./github-repo.js', './fetch-timeout.mjs']) expect(sibling, f + ' is used by a working endpoint').toContain(f);
    });
});

describe('autonomy-status: lastRealChange', () => {
    it('skips version stamps and merchant refreshes', () => {
        const c = lastRealChange([
            commit('release: v7.69.45', '2026-11-04T11:00:00Z'),
            commit('chore(merchants): refresh', '2026-11-04T10:00:00Z'),
            commit('fix: overlap', '2026-11-02T10:00:00Z'),
        ], NOW);
        expect(c.summary).toBe('fix: overlap');
        expect(c.daysAgo).toBe(2);
    });
    it('is null when there is nothing real', () => {
        expect(lastRealChange([commit('release: v1', '2026-11-04T11:00:00Z')], NOW)).toBeNull();
        expect(lastRealChange(undefined, NOW)).toBeNull();
    });
});

describe('autonomy-status: judge', () => {
    const fresh = [commit('fix: x', '2026-11-03T10:00:00Z')];
    it('healthy when the last runs succeeded, and it does NOT claim the models can write fixes', () => {
        const v = judge({ agentRuns: [run('success')], releaseRuns: [run('success')], commits: fresh, stuck: 0 }, NOW);
        expect(v.overall).toBe('healthy');
        expect(v.canActuallyFixBugs).toBeNull();
        expect(v.headline).toMatch(/shown on that report/);
    });
    it('a single red agent run is noise; three in a row is broken', () => {
        const one = judge({ agentRuns: [run('failure'), run('success'), run('success')], releaseRuns: [run('success')], commits: fresh, stuck: 0 }, NOW);
        expect(one.overall).toBe('healthy');
        const three = judge({ agentRuns: [run('failure'), run('timed_out'), run('failure')], releaseRuns: [run('success')], commits: fresh, stuck: 0 }, NOW);
        expect(three.overall).toBe('broken');
        expect(three.canActuallyFixBugs).toBe(false);
    });
    it('cancelled and skipped runs say nothing', () => {
        const v = judge({ agentRuns: [run('cancelled'), run('skipped'), run('success')], releaseRuns: [run('success')], commits: fresh, stuck: 0 }, NOW);
        expect(v.overall).toBe('healthy');
    });
    it('a failed release, stuck reports or a stale tree degrade it', () => {
        expect(judge({ agentRuns: [run('success')], releaseRuns: [run('failure')], commits: fresh, stuck: 0 }, NOW).overall).toBe('degraded');
        const stuck = judge({ agentRuns: [run('success')], releaseRuns: [run('success')], commits: fresh, stuck: 2 }, NOW);
        expect(stuck.overall).toBe('degraded');
        expect(stuck.failing.map((f) => f.id)).toContain('stuck');
        const stale = judge({ agentRuns: [run('success')], releaseRuns: [run('success')], commits: [commit('fix: old', '2026-09-01T00:00:00Z')], stuck: 0 }, NOW);
        expect(stale.overall).toBe('degraded');
    });
    it('is unknown, not healthy, when nothing could be read', () => {
        const v = judge({ unread: ['agent runs: GitHub 401'] }, NOW);
        expect(v.overall).toBe('unknown');
        expect(v.canActuallyFixBugs).toBeNull();
    });
    it('never throws on empty or hostile evidence', () => {
        expect(() => judge()).not.toThrow();
        expect(() => judge({ agentRuns: [null, {}, 3], commits: [null, {}], stuck: 'x' }, NOW)).not.toThrow();
    });
});

describe('autonomy-status: collect and the handler', () => {
    const env = { GITHUB_REPOSITORY: 'o/r', GH_PAT: 'token' };
    const gh = (map) => async (url) => {
        const key = Object.keys(map).find((k) => url.includes(k));
        if (!key) return { ok: false, status: 404, json: async () => ({}) };
        const v = map[key];
        return v instanceof Error ? (() => { throw v; })() : { ok: true, status: 200, json: async () => v };
    };

    it('reads the four pieces of evidence', async () => {
        const ev = await collect(env, gh({
            'autonomous-fix.yml': { workflow_runs: [run('success')] },
            'auto-release.yml': { workflow_runs: [run('success')] },
            '/commits': [commit('fix: x', '2026-11-03T10:00:00Z')],
            'ai-stuck': [{ number: 1 }, { number: 2, pull_request: {} }],
        }));
        expect(ev.unread).toEqual([]);
        expect(ev.stuck).toBe(1);
        expect(ev.agentRuns).toHaveLength(1);
    });
    it('lists a read that failed instead of throwing', async () => {
        const ev = await collect(env, gh({ 'autonomous-fix.yml': new Error('network down'), 'auto-release.yml': { workflow_runs: [] }, '/commits': [], 'ai-stuck': [] }));
        expect(ev.unread.join()).toMatch(/agent runs: network down/);
    });
    it('says so when no token is configured', async () => {
        const ev = await collect({}, async () => { throw new Error('must not be called'); });
        expect(ev.unread[0]).toMatch(/no GitHub repository or token/);
    });
    it('the handler answers 200 with a verdict even when GitHub cannot be read', async () => {
        const saved = { ...process.env };
        delete process.env.GH_PAT; delete process.env.GITHUB_TOKEN; delete process.env.GITHUB_MODELS_TOKEN;
        try {
            const res = fakeRes();
            await handler({ url: '/api/autonomy-status?full=1' }, res);
            expect(res.code).toBe(200);
            expect(res.body.overall).toBe('unknown');
            expect(res.body.source).toBe('github');
            expect(Array.isArray(res.body.checks)).toBe(true);
            expect(res.headers['Cache-Control']).toMatch(/no-store/);
        } finally { process.env = saved; }
    });
});
