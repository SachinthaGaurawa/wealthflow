/* =============================================================================
 * autonomy/slot-guard.mjs — a late scheduled run that finds its slot already served stops at once
 * ---------------------------------------------------------------------------
 * WHY (measured on this repository, 2026-11-12): GitHub delivers a `schedule:` run hours late, and the pacemaker (autonomy/pacemaker.mjs) had
 * already started the same workflow for that slot. Three jobs then ran twice on one day, each on free-tier model quota:
 *   autonomous-discover  08:08Z (pacemaker) and 12:22Z (schedule)    security-updates  08:08Z and 13:54Z    feature-proposals  08:08Z and 09:58Z
 * The pacemaker never starts a slot twice, but it cannot hold back a run GitHub itself delivers late.
 *
 * WHAT: a `schedule` run asks GitHub whether another run of its own workflow did (or is doing) the work of the latest slot, and if one did,
 * cancels itself. Only `schedule` runs are guarded: a dispatch, a push or a manual run always runs.
 *
 * RULES (each one is a case in test/slot_guard_test.js)
 *   · "Served" means a run of the same workflow that started at or after the slot (less the pacemaker's 5-minute tolerance), is not this run,
 *     started BEFORE this run, and is in progress or ended in success. A failed run does not serve the slot: the late run is then its retry.
 *     A skipped or cancelled run did nothing (the pacemaker counts them the same way).
 *   · "Started before this run" is what stops two late runs delivered together from cancelling each other: the earliest one always goes on.
 *   · Any doubt runs the job: a missing token, an API error, an unreadable cron. The guard never blocks work it is not sure about.
 * ===========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cronsIn, dueOf, SLOT_TOLERANCE_MIN } from './pacemaker.mjs';

const startOf = (run) => Date.parse(run && (run.run_started_at || run.created_at));

/**
 * @param {object} o
 * @param {string[]} o.crons  the workflow's own cron lines
 * @param {number} o.now      ms
 * @param {object[]} o.runs   GitHub run objects of this workflow (id, run_started_at|created_at, status, conclusion)
 * @param {number|string} o.selfId  this run's id
 * @param {number} o.selfStart      ms this run started
 * @returns {{ served: boolean, due: number|null, by: object|null, why: string }}
 */
export function slotServed({ crons, now = Date.now(), runs = [], selfId, selfStart, tolMin = SLOT_TOLERANCE_MIN }) {
    const due = dueOf({ crons: crons || [] }, now);
    if (due === null) return { served: false, due: null, by: null, why: 'no readable schedule: the job runs' };
    const mine = Number.isFinite(selfStart) ? selfStart : now;
    const earlier = (runs || []).filter((r) => r && String(r.id) !== String(selfId) && Number.isFinite(startOf(r)) && startOf(r) >= due - tolMin * 60000 && startOf(r) < mine);
    const by = earlier.filter((r) => r.conclusion === 'success' || (r.conclusion == null && r.status !== 'completed'))
        .sort((a, b) => startOf(a) - startOf(b))[0] || null;
    return by
        ? { served: true, due, by, why: `run ${by.id} (${by.event}) started ${new Date(startOf(by)).toISOString().slice(11, 16)}Z and ${by.conclusion || 'is still running'}: it did the slot due ${new Date(due).toISOString().slice(11, 16)}Z` }
        : { served: false, due, by: null, why: 'nobody did this slot yet: the job runs' };
}

async function gh(pathname, { method = 'GET', env = process.env } = {}) {
    const token = env.GITHUB_TOKEN || env.GH_TOKEN, repo = env.GITHUB_REPOSITORY;
    if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are needed');
    const r = await fetch(`https://api.github.com/repos/${repo}${pathname}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'wealthflow-slot-guard' } });
    const raw = await r.text();
    if (!r.ok) throw new Error(`GitHub ${method} ${pathname} -> ${r.status}: ${raw.slice(0, 160)}`);
    return raw ? JSON.parse(raw) : null;
}

/** The CLI's whole decision, with the network injected for the tests. Returns { guarded, served, text }. */
export async function guard({ file, env = process.env, now = Date.now(), read = (f) => fs.readFileSync(path.join('.github/workflows', f), 'utf8'), api = gh, cancel = true } = {}) {
    if (env.GITHUB_EVENT_NAME !== 'schedule') return { guarded: false, served: false, text: `slot guard: a ${env.GITHUB_EVENT_NAME || 'manual'} run is never held back` };
    try {
        const crons = cronsIn(read(file));
        const due = dueOf({ crons }, now);
        if (due === null) return { guarded: true, served: false, text: 'slot guard: no readable schedule, the job runs' };
        const since = new Date(due - SLOT_TOLERANCE_MIN * 60000).toISOString().slice(0, 19) + 'Z';
        const list = await api(`/actions/workflows/${file}/runs?per_page=50&created=${encodeURIComponent('>=' + since)}`, { env });
        const self = await api(`/actions/runs/${env.GITHUB_RUN_ID}`, { env });
        const out = slotServed({ crons, now, runs: (list && list.workflow_runs) || [], selfId: env.GITHUB_RUN_ID, selfStart: startOf(self) });
        if (!out.served) return { guarded: true, served: false, text: `slot guard: ${out.why}` };
        if (cancel) await api(`/actions/runs/${env.GITHUB_RUN_ID}/cancel`, { method: 'POST', env });
        return { guarded: true, served: true, text: `slot guard: STOP, ${out.why}` };
    } catch (e) {
        return { guarded: true, served: false, text: `slot guard: could not tell (${String(e.message).slice(0, 140)}), the job runs` };
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const file = process.argv[2];
    guard({ file }).then(async (out) => {
        console.log(out.text);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.text + '\n');
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `served=${out.served}\n`);
        // a cancel is a request: GitHub stops the job at its next step. Wait here so no later step starts the work meanwhile.
        if (out.served) await new Promise((resolve) => setTimeout(resolve, 90000));
    }).catch((e) => { console.log(`slot guard: ${e.message}, the job runs`); });
}
