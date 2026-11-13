/* =============================================================================
 * autonomy/gather-wait.mjs — the release wait that ends GREEN when a newer merge takes it over
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (measured, 2026-11-13, owner's screenshots of the commit list)
 *   Five commits on main in a row showed a red cross ("6 of 9", "5 of 8") although every check that tests anything had
 *   passed. The cross was one run: `Auto Release (WealthFlow)`, cancelled. The `gather` job (several changes ride in one
 *   update) was cancelled by the NEXT merge through a concurrency group, by design, and GitHub draws a cancelled run as a
 *   failure. The same lesson is already written down for `Pipeline liveness` (test/push_runs_not_cancelled_test.js):
 *   a merge to main is not cut short by the next merge, so it must not wear a red mark for it.
 *
 * THE RULE, UNCHANGED: the newest merge holds the timer, an older waiting run releases nothing.
 * HOW IT ENDS NOW: the waiting run asks GitHub once a minute whether a NEWER run of this workflow exists. When one does,
 * it says so and finishes with success, and `release` (which needs `superseded != 'true'`) does not run. Nothing is
 * cancelled, so nothing is red.
 *
 * A newer run counts only if it is still going or finished well (a newer run that failed or was cancelled did not
 * release anything, so the older one must keep waiting and release). Any doubt (no token, an API error) keeps waiting:
 * the worst case is two runs that both release, and `release` takes the shared push lock and finds nothing waiting
 * the second time.
 * ===========================================================================*/

import fs from 'node:fs';

export const POLL_MS = 60_000;

/**
 * Is there a newer run of the workflow that took over the timer?
 * @param {{id:number, run_number:number, status:string, conclusion:string|null}[]} runs  runs of this workflow
 * @param {number} selfNumber  this run's run_number
 * @returns {{ superseded:boolean, by:number|null }}
 */
export function supersededBy(runs, selfNumber) {
    if (!Array.isArray(runs) || !Number.isFinite(Number(selfNumber))) return { superseded: false, by: null };
    const newer = runs
        .filter((r) => r && Number(r.run_number) > Number(selfNumber))
        .filter((r) => r.status !== 'completed' || r.conclusion === 'success')
        .sort((a, b) => Number(b.run_number) - Number(a.run_number));
    return newer.length ? { superseded: true, by: Number(newer[0].run_number) } : { superseded: false, by: null };
}

/**
 * Sleep up to `seconds`, looking for a newer run every `pollMs`.
 * @param {object} o
 * @param {number} o.seconds        the wait the rule asked for
 * @param {number} o.selfNumber
 * @param {()=>Promise<object[]>} o.listRuns   runs of this workflow (queued, in progress, recent completed)
 * @param {(ms:number)=>Promise<void>} o.sleep
 * @param {()=>number} [o.now]
 * @param {number} [o.pollMs]
 * @returns {Promise<{ superseded:boolean, by:number|null, waitedSeconds:number, checks:number, errors:number }>}
 */
export async function waitOrYield({ seconds, selfNumber, listRuns, sleep, now = Date.now, pollMs = POLL_MS }) {
    const start = now();
    const total = Math.max(0, Number(seconds) || 0) * 1000;
    let checks = 0, errors = 0;
    const waited = () => Math.round((now() - start) / 1000);
    if (total <= 0) return { superseded: false, by: null, waitedSeconds: 0, checks: 0, errors: 0 };   // nothing to wait for: the run releases at once
    // a look first (a run that starts after a newer one is already waiting for nothing), then one every pollMs
    for (;;) {
        checks += 1;
        try {
            const s = supersededBy(await listRuns(), selfNumber);
            if (s.superseded) return { ...s, waitedSeconds: waited(), checks, errors };
        } catch (_) { errors += 1; }      // doubt keeps waiting
        const left = total - (now() - start);
        if (left <= 0) return { superseded: false, by: null, waitedSeconds: waited(), checks, errors };
        await sleep(Math.min(pollMs, left));
    }
}

/** The GitHub API call: the newest runs of this workflow, any state. */
export function githubListRuns({ repo, workflow, token, fetchImpl = fetch }) {
    return async () => {
        const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=30`;
        const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
        if (!res.ok) throw new Error(`runs list HTTP ${res.status}`);
        const body = await res.json();
        return Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    };
}

// CLI: node autonomy/gather-wait.mjs <seconds>   (env: GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_RUN_NUMBER, GITHUB_OUTPUT)
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
    const seconds = Number(process.argv[2] || 0);
    const { GITHUB_REPOSITORY: repo, GITHUB_TOKEN: token, GITHUB_RUN_NUMBER: num, GITHUB_OUTPUT: out } = process.env;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const listRuns = repo && token ? githubListRuns({ repo, workflow: 'auto-release.yml', token }) : async () => { throw new Error('no token'); };
    const r = await waitOrYield({ seconds, selfNumber: Number(num), listRuns, sleep });
    if (r.superseded) console.log(`superseded: run ${r.by} of this workflow took over the timer after ${r.waitedSeconds}s; this run releases nothing`);
    else console.log(`waited ${r.waitedSeconds}s (${r.checks} look(s) for a newer run, ${r.errors} could not be read)`);
    if (out) fs.appendFileSync(out, `superseded=${r.superseded ? 'true' : 'false'}\n`);
}
