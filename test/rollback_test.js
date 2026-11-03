/* Instant Rollback that really rolls back (autonomy/rollback.mjs).
 *
 * The old workflow lines ran `vercel rollback --yes` with no deployment; in the Vercel CLI that is the `status` sub-command and it
 * exits 0, so a run could say "production was rolled back" with nothing moved (Codex review, PR #506). These tests pin the three
 * things that were missing: a target is chosen, the request really goes to Vercel for THAT target, and success is only claimed
 * after the live site changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { normalise, pickTarget, rollback, API } from '../autonomy/rollback.mjs';

// Shaped like the real production list for this project on 2026-11-03 (newest first): a merge after the release, the release
// commit itself, a merge before it. Only the two newest are rollback candidates on the Hobby plan.
const REAL = [
    { id: 'dpl_NEWEST', url: 'a.vercel.app', created: 1793748170327, state: 'READY', target: 'production', meta: { githubCommitSha: 'aaaa1111aaaa1111' }, isRollbackCandidate: true },
    { id: 'dpl_RELEASE', url: 'b.vercel.app', created: 1793746827251, state: 'READY', target: 'production', meta: { githubCommitSha: 'b4910f4e43a4bec999088ccf3345acf25f6c072c' }, isRollbackCandidate: true },
    { id: 'dpl_BEFORE', url: 'c.vercel.app', created: 1793746673036, state: 'READY', target: 'production', meta: { githubCommitSha: '4f9d7c739b4d0a7953c5801818d662359fffbbe3' }, isRollbackCandidate: false },
];

const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A fake Vercel + live site. `live` is what /api/version answers over time (one entry per read; the last repeats). */
function fakeWorld({ deployments = REAL, listStatus = 200, postStatus = 200, live = ['7.69.40'], health = 200 } = {}) {
    const calls = [];
    let reads = 0;
    const fetchImpl = async (url, init = {}) => {
        const method = init.method || 'GET';
        calls.push({ url: String(url), method, headers: init.headers || {}, body: init.body });
        if (String(url).startsWith(API) && method === 'GET') return json({ deployments }, listStatus);
        if (String(url).startsWith(API) && method === 'POST') return json({}, postStatus);
        if (String(url).includes('/api/version')) { const v = live[Math.min(reads++, live.length - 1)]; return json({ version: v }); }
        return { ok: health === 200, status: health, json: async () => ({}) };
    };
    return { fetchImpl, calls };
}
const run = (extra, world) => rollback({ token: 'tok_SECRET_123', projectId: 'prj_1', teamId: 'team_1', sleepImpl: async () => {}, attempts: 3, intervalMs: 0, fetchImpl: world.fetchImpl, ...extra });

describe('normalise reads both the REST and the dashboard-tool shapes', () => {
    it('uid or id, created or createdAt, state or readyState', () => {
        expect(normalise({ uid: 'u1', createdAt: 5, readyState: 'ready' })).toMatchObject({ id: 'u1', created: 5, state: 'READY' });
        expect(normalise({ id: 'i1', created: 7, state: 'READY', meta: { githubCommitSha: 'abc' }, isRollbackCandidate: false })).toMatchObject({ id: 'i1', sha: 'abc', candidate: false });
        expect(normalise(null)).toMatchObject({ id: '', sha: '', candidate: null });
    });
});

describe('pickTarget: which deployment production goes back to', () => {
    it('the newest is bad: go back to the one just before it', () => {
        const p = pickTarget(REAL, { badSha: 'current' });
        expect(p.ok).toBe(true);
        expect(p.bad.id).toBe('dpl_NEWEST');
        expect(p.target.id).toBe('dpl_RELEASE');
        expect(p.droppedNewer).toBe(0);
    });
    it('no bad commit given means the newest is bad', () => {
        expect(pickTarget(REAL, {}).target.id).toBe('dpl_RELEASE');
    });
    it('REFUSES (with the reason) when Vercel does not offer the older deployment: the real case of a merge landing after the release', () => {
        const p = pickTarget(REAL, { badSha: 'b4910f4e43a4bec999088ccf3345acf25f6c072c' });
        expect(p.ok).toBe(false);
        expect(p.why).toMatch(/dpl_BEFORE/);
        expect(p.why).toMatch(/Hobby plan only the previous production deployment/);
        expect(p.why).toMatch(/1 newer deployment/);
    });
    it('a bad commit that has no deployment is refused, never guessed', () => {
        const p = pickTarget(REAL, { badSha: 'deadbeefdeadbeef' });
        expect(p.ok).toBe(false);
        expect(p.why).toMatch(/no READY production deployment was built from commit deadbeef/);
    });
    it('nothing older than the bad one is refused', () => {
        const p = pickTarget([REAL[0]], { badSha: 'current' });
        expect(p.ok).toBe(false);
        expect(p.why).toMatch(/older/);
    });
    it('an empty or non-array list is refused', () => {
        expect(pickTarget([], {}).ok).toBe(false);
        expect(pickTarget(undefined, {}).ok).toBe(false);
    });
    it('previews and unfinished builds are never a rollback target', () => {
        const mixed = [
            REAL[0],
            { id: 'dpl_PREVIEW', created: 1793748000000, state: 'READY', target: 'preview', meta: {} },
            { id: 'dpl_BUILDING', created: 1793747900000, state: 'BUILDING', target: 'production', meta: {} },
            REAL[1],
        ];
        expect(pickTarget(mixed, { badSha: 'current' }).target.id).toBe('dpl_RELEASE');
    });
    it('an unknown candidate flag (older API) is still tried rather than refused', () => {
        const p = pickTarget([{ ...REAL[0], isRollbackCandidate: undefined }, { ...REAL[1], isRollbackCandidate: undefined }], { badSha: 'current' });
        expect(p.ok).toBe(true);
    });
});

describe('rollback(): the request really goes to Vercel for the chosen target, and success needs proof', () => {
    it('asks Vercel to point production at the target, then reports VERIFIED only once the live version changed', async () => {
        const w = fakeWorld({ live: ['7.69.41', '7.69.41', '7.69.40'] });
        const r = await run({ badSha: 'current', base: 'https://www.wealthflow.lk', badVersion: '7.69.41' }, w);
        const post = w.calls.find((c) => c.method === 'POST');
        expect(post.url).toBe(`${API}/v1/projects/prj_1/rollback/dpl_RELEASE?teamId=team_1`);
        expect(r).toMatchObject({ result: 'verified', target: 'dpl_RELEASE', from: 'dpl_NEWEST', seen: '7.69.40' });
        expect(w.calls.filter((c) => c.url.includes('/api/version')).length).toBe(3);
    });
    it('Vercel accepted it but the live site still serves the bad version: "requested", never "verified"', async () => {
        const w = fakeWorld({ live: ['7.69.41'] });
        const r = await run({ badSha: 'current', base: 'https://www.wealthflow.lk', badVersion: '7.69.41' }, w);
        expect(r.result).toBe('requested');
        expect(r.why).toMatch(/still looked like the bad release \(it served 7\.69\.41\)/);
    });
    it('with a verify URL (the watchdog) it needs that URL to answer 200', async () => {
        expect((await run({ badSha: 'current', verifyUrl: 'https://www.wealthflow.lk/api/health' }, fakeWorld({ health: 200 }))).result).toBe('verified');
        expect((await run({ badSha: 'current', verifyUrl: 'https://www.wealthflow.lk/api/health' }, fakeWorld({ health: 503 }))).result).toBe('requested');
    });
    it('nothing to check the result against is said plainly, not called verified', async () => {
        const r = await run({ badSha: 'current' }, fakeWorld());
        expect(r.result).toBe('requested');
        expect(r.why).toMatch(/nothing to check it against/);
    });
    it('a refused pick sends NO rollback request', async () => {
        const w = fakeWorld();
        const r = await run({ badSha: 'b4910f4e43a4bec999088ccf3345acf25f6c072c', base: 'https://www.wealthflow.lk', badVersion: '7.69.41' }, w);
        expect(r.result).toBe('refused');
        expect(w.calls.some((c) => c.method === 'POST')).toBe(false);
    });
    it('Vercel refusing the request is "failed" and says nothing was rolled back', async () => {
        const r = await run({ badSha: 'current', base: 'https://www.wealthflow.lk', badVersion: '7.69.41' }, fakeWorld({ postStatus: 403 }));
        expect(r).toMatchObject({ result: 'failed', target: 'dpl_RELEASE' });
        expect(r.why).toMatch(/HTTP 403/);
    });
    it('a failed listing is "failed" and sends no rollback request', async () => {
        const w = fakeWorld({ listStatus: 401 });
        const r = await run({ badSha: 'current' }, w);
        expect(r.result).toBe('failed');
        expect(w.calls.some((c) => c.method === 'POST')).toBe(false);
    });
    it('a network error never throws out of the function', async () => {
        const r = await rollback({ token: 't', projectId: 'p', fetchImpl: async () => { throw new Error('socket hang up'); }, sleepImpl: async () => {} });
        expect(r).toMatchObject({ result: 'failed' });
        expect(r.why).toMatch(/socket hang up/);
    });
    it('no token or no project id is refused before any request', async () => {
        const w = fakeWorld();
        expect((await rollback({ projectId: 'p', fetchImpl: w.fetchImpl })).result).toBe('refused');
        expect((await rollback({ token: 't', fetchImpl: w.fetchImpl })).why).toMatch(/VERCEL_PROJECT_ID/);
        expect(w.calls.length).toBe(0);
    });
    it('the token travels only in the Authorization header: never in a URL and never in the result', async () => {
        const w = fakeWorld({ live: ['7.69.40'] });
        const r = await run({ badSha: 'current', base: 'https://www.wealthflow.lk', badVersion: '7.69.41' }, w);
        expect(w.calls.filter((c) => String(c.url).startsWith(API)).every((c) => c.headers.Authorization === 'Bearer tok_SECRET_123')).toBe(true);
        expect(w.calls.some((c) => c.url.includes('tok_SECRET_123'))).toBe(false);
        expect(JSON.stringify(r)).not.toContain('tok_SECRET_123');
    });
    it('works for a personal project with no team id', async () => {
        const w = fakeWorld({ live: ['7.69.40'] });
        await rollback({ token: 't', projectId: 'prj_1', badSha: 'current', base: 'https://x.test', badVersion: '7.69.41', fetchImpl: w.fetchImpl, sleepImpl: async () => {}, attempts: 1 });
        expect(w.calls.find((c) => c.method === 'POST').url).toBe(`${API}/v1/projects/prj_1/rollback/dpl_RELEASE`);
    });
});

describe('the workflows use it, and the no-target command is gone', () => {
    const read = (f) => fs.readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', f), 'utf8');
    for (const f of ['auto-release.yml', 'health-watchdog.yml']) {
        it(`${f} no longer runs "vercel rollback" (which defaults to the status sub-command) and does not fetch vercel@latest with the token`, () => {
            const yml = read(f);
            expect(yml).not.toMatch(/^[^#\n]*vercel@latest\s+rollback/m);
            expect(yml).not.toMatch(/^[^#\n]*npx[^\n]*vercel@latest[^\n]*--token/m);
            expect(yml).toMatch(/node autonomy\/rollback\.mjs/);
        });
    }
    it('the canary passes the release commit and the bad version, and only acts when both opt-ins are set', () => {
        const yml = read('auto-release.yml');
        const step = yml.slice(yml.indexOf('- name: Canary - open the live release in a real browser'), yml.indexOf('- name: Fail loudly if the gates approved'));
        expect(step).toMatch(/node autonomy\/rollback\.mjs[^\n]*--bad-sha "\$\(git rev-parse HEAD\)"[^\n]*--bad-version "\$V"/);
        expect(step).toMatch(/\[ "\$CANARY_ROLLBACK" = "true" \] && \[ -n "\$VERCEL_TOKEN" \]/);
        expect(step).toMatch(/VERCEL_PROJECT_ID: \$\{\{ vars\.VERCEL_PROJECT_ID \}\}/);
    });
    it('the issue text follows the real outcome (verified, requested, or nothing rolled back)', () => {
        const yml = read('auto-release.yml');
        expect(yml).toMatch(/rolled back and verified/);
        expect(yml).toMatch(/NOT verified/);
        expect(yml).toMatch(/nothing was rolled back/);
    });
    it('the watchdog verifies against the health URL', () => {
        expect(read('health-watchdog.yml')).toMatch(/node autonomy\/rollback\.mjs[^\n]*--bad-sha current[^\n]*--verify-url "\$HEALTH_URL"/);
    });
});
