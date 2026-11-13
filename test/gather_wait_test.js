/* The release wait ends GREEN when a newer merge takes over (autonomy/gather-wait.mjs).
 *
 * WHAT WAS MEASURED (2026-11-13, the owner's commit list): five commits on main in a row showed a red cross ("6 of 9", "5 of 8")
 * with every test green. The cross was `Auto Release (WealthFlow)`: its `gather` job was cancelled by the next merge through a
 * concurrency group (by design), and GitHub draws a cancelled run as a failure. Now the older run notices the newer one, says so,
 * and finishes with success; `release` does not run for it.
 */
import { describe, it, expect } from 'vitest';
import { supersededBy, waitOrYield, githubListRuns, POLL_MS } from '../autonomy/gather-wait.mjs';

const run = (n, status = 'in_progress', conclusion = null) => ({ id: 1000 + n, run_number: n, status, conclusion });

describe('supersededBy', () => {
    it('a newer run that is still going takes the timer', () => {
        expect(supersededBy([run(10), run(11, 'queued')], 10)).toEqual({ superseded: true, by: 11 });
    });
    it('a newer run that finished well took everything with it', () => {
        expect(supersededBy([run(10), run(11, 'completed', 'success')], 10)).toEqual({ superseded: true, by: 11 });
    });
    it('a newer run that failed or was cancelled released nothing, so the older one keeps waiting', () => {
        expect(supersededBy([run(10), run(11, 'completed', 'failure'), run(12, 'completed', 'cancelled')], 10).superseded).toBe(false);
        expect(supersededBy([run(10), run(11, 'completed', 'skipped')], 10).superseded).toBe(false);
    });
    it('an older run never takes the timer, and the newest wins when several are newer', () => {
        expect(supersededBy([run(9), run(10)], 10).superseded).toBe(false);
        expect(supersededBy([run(11), run(13), run(12)], 10).by).toBe(13);
    });
    it('anything unreadable means: keep waiting', () => {
        expect(supersededBy(null, 10).superseded).toBe(false);
        expect(supersededBy([run(11)], NaN).superseded).toBe(false);
        expect(supersededBy([null, undefined, {}], 10).superseded).toBe(false);
    });
});

describe('waitOrYield', () => {
    const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

    it('waits the whole time when nobody takes over, looking once a minute', async () => {
        const c = clock();
        let calls = 0;
        const r = await waitOrYield({ seconds: 300, selfNumber: 10, listRuns: async () => { calls++; return [run(10)]; }, ...c });
        expect(r).toMatchObject({ superseded: false, waitedSeconds: 300, errors: 0 });
        expect(calls).toBe(6);                      // 0, 60, 120, 180, 240, 300
        expect(POLL_MS).toBe(60_000);
    });

    it('ends at once, superseded, when a newer run appears; it does not sleep out the rest of the wait', async () => {
        const c = clock();
        const r = await waitOrYield({ seconds: 2700, selfNumber: 10, listRuns: async () => (c.now() >= 120_000 ? [run(10), run(11)] : [run(10)]), ...c });
        expect(r).toMatchObject({ superseded: true, by: 11 });
        expect(r.waitedSeconds).toBe(120);
    });

    it('a wait of nothing releases at once and asks GitHub nothing', async () => {
        let calls = 0;
        const r = await waitOrYield({ seconds: 0, selfNumber: 10, listRuns: async () => { calls++; return []; }, ...clock() });
        expect(r).toMatchObject({ superseded: false, waitedSeconds: 0, checks: 0 });
        expect(calls).toBe(0);
    });

    it('an unreadable list keeps waiting and is counted, never read as a takeover', async () => {
        const r = await waitOrYield({ seconds: 180, selfNumber: 10, listRuns: async () => { throw new Error('HTTP 403'); }, ...clock() });
        expect(r).toMatchObject({ superseded: false, waitedSeconds: 180 });
        expect(r.errors).toBe(4);
    });

    it('the last sleep is cut to what is left, not a whole minute', async () => {
        const slept = [];
        const t = { now: () => slept.reduce((a, b) => a + b, 0), sleep: async (ms) => { slept.push(ms); } };
        await waitOrYield({ seconds: 90, selfNumber: 1, listRuns: async () => [], ...t });
        expect(slept).toEqual([60_000, 30_000]);
    });
});

describe('githubListRuns', () => {
    it('reads this workflow\'s runs with the run token and survives a refusal as an error', async () => {
        let seen;
        const ok = githubListRuns({ repo: 'o/r', workflow: 'auto-release.yml', token: 't', fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ workflow_runs: [run(1)] }) }; } });
        expect(await ok()).toHaveLength(1);
        expect(seen.url).toContain('/repos/o/r/actions/workflows/auto-release.yml/runs');
        expect(seen.init.headers.Authorization).toBe('Bearer t');
        const refused = githubListRuns({ repo: 'o/r', workflow: 'w', token: 't', fetchImpl: async () => ({ ok: false, status: 403 }) });
        await expect(refused()).rejects.toThrow(/HTTP 403/);
    });
});
