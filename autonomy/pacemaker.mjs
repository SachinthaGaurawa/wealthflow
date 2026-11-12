/* =============================================================================
 * autonomy/pacemaker.mjs — wakes a scheduled job that GitHub delayed or dropped
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (measured on this repository, 2026-11-11 09:52Z to 2026-11-12 04:30Z)
 *   Every "autonomous" job here starts from a GitHub `schedule:` line, and GitHub does not promise to run those.
 *   Its own documentation: "The schedule event can be delayed during periods of high loads of GitHub Actions
 *   workflow runs ... If the load is sufficiently high enough, some queued jobs may be dropped."
 *   What that meant here, in one 19-hour window:
 *     - the daily scan due 04:00 ran 11:44 (7 h 44 min late); security updates due 05:30 ran 12:51; liveness due 07:17 ran 15:16
 *     - the fix agent (every 6 h) ran ONCE instead of three times; the release loop missed its 18:00 slot
 *     - the idea engine due 02:30 had not run at all two hours later
 *   A dropped run does not fail. Nothing goes red. The system just does less than it says, which is exactly what the
 *   owner sees ("it does not really work").
 *
 * WHAT IT DOES
 *   It reads every workflow's own `cron:` lines (so there is no second table to forget to update), works out the
 *   most recent time each one was due, asks GitHub when the workflow last actually ran, and, if a slot is more than
 *   GRACE_MIN late with no run, starts that workflow itself with `workflow_dispatch`. A run started with the
 *   repository's own token IS allowed to start a workflow this way (GitHub: "with the exception of
 *   workflow_dispatch and repository_dispatch").
 *
 *   The pacemaker's own triggers do not depend on one clock: a `schedule` every 20 minutes (72 chances a day instead
 *   of one), AND the completion of the workflows that run on real events (a deploy, a merge). Any one of them is enough.
 *
 * WHAT IT NEVER DOES
 *   It never starts a job that already ran in its slot (a late run still counts), never starts more than
 *   MAX_WAKES jobs in one beat, and never starts a workflow that has no `workflow_dispatch` trigger.
 *
 * Pure functions first (tested in test/pacemaker_test.js); the network is only in `beat`.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRACE_MIN = 25;        // GitHub's ordinary lateness is 5 to 20 minutes; past this a slot is treated as skipped
export const SLOT_TOLERANCE_MIN = 5; // a run that started this close BEFORE the slot counts as that slot's run
export const MAX_WAKES = 4;         // per beat, so a long outage is caught up over a few beats and not in one burst
export const SELF = 'pacemaker.yml';

/**
 * Inputs a workflow needs when the pacemaker starts it. `auto-release.yml` treats a plain manual start as "release now,
 * whatever is waiting"; `auto: true` makes it behave like its own schedule (release only if something real is waiting).
 */
export const WAKE_INPUTS = { 'auto-release.yml': { auto: 'true' } };

// ── cron (the five-field form GitHub accepts, UTC) ─────────────────────────────────────────────────────────────

/** One field as the set of values it allows, or null for "any". Supports a star, a star with a step, a number, a range, a range with a step, and lists. */
export function parseField(field, min, max) {
    const f = String(field).trim();
    if (f === '*') return null;
    const out = new Set();
    for (const part of f.split(',')) {
        const m = part.match(/^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/);
        if (!m) throw new Error(`pacemaker: cannot read the cron field "${field}"`);
        const step = m[3] ? Number(m[3]) : 1;
        if (!(step >= 1)) throw new Error(`pacemaker: a cron step must be 1 or more ("${field}")`);
        let from, to;
        if (m[1] === '*') { from = min; to = max; }
        else { from = Number(m[1]); to = m[2] != null ? Number(m[2]) : (m[3] ? max : from); }
        if (from < min || to > max || from > to) throw new Error(`pacemaker: the cron field "${field}" is out of range ${min}-${max}`);
        for (let v = from; v <= to; v += step) out.add(v);
    }
    return out;
}

export function parseCron(expr) {
    const p = String(expr).trim().split(/\s+/);
    if (p.length !== 5) throw new Error(`pacemaker: a cron line needs five fields ("${expr}")`);
    const dow = parseField(p[4], 0, 7);
    if (dow && dow.has(7)) { dow.delete(7); dow.add(0); }      // 7 is Sunday too
    return { minute: parseField(p[0], 0, 59), hour: parseField(p[1], 0, 23), dom: parseField(p[2], 1, 31), month: parseField(p[3], 1, 12), dow };
}

const ok = (set, v) => set === null || set.has(v);

/** Does this minute (UTC) match? Day-of-month and day-of-week follow cron's rule: when both are restricted, either one is enough. */
export function cronMatches(cron, date) {
    const c = typeof cron === 'string' ? parseCron(cron) : cron;
    if (!ok(c.minute, date.getUTCMinutes()) || !ok(c.hour, date.getUTCHours()) || !ok(c.month, date.getUTCMonth() + 1)) return false;
    const dom = ok(c.dom, date.getUTCDate()), dow = ok(c.dow, date.getUTCDay());
    return (c.dom !== null && c.dow !== null) ? (dom || dow) : (dom && dow);
}

/** The most recent minute at or before `now` on which the cron was due, as a ms timestamp; null if none in the last `backDays`. */
export function lastDue(expr, now = Date.now(), backDays = 40) {
    const c = parseCron(expr);
    let t = Math.floor(now / 60000) * 60000;
    const stop = t - backDays * 24 * 60 * 60000;
    for (; t >= stop; t -= 60000) if (cronMatches(c, new Date(t))) return t;
    return null;
}

// ── the workflow files ─────────────────────────────────────────────────────────────────────────────────────────

/** Every `cron:` expression in a workflow file (comments after it are ignored). */
export function cronsIn(text) {
    return [...String(text).matchAll(/^\s*-\s*cron:\s*(['"])([^'"]+)\1/gm)].map((m) => m[2].trim());
}

/** The workflow can be started by hand (and so by the pacemaker). Commented-out lines do not count. */
export function hasDispatch(text) {
    return /^\s*workflow_dispatch\s*:/m.test(String(text));
}

export function nameOf(text) {
    const m = String(text).match(/^name:\s*(.+?)\s*$/m);
    return m ? m[1].replace(/^['"]|['"]$/g, '') : '';
}

/** Every scheduled workflow in the checkout: { file, name, crons, dispatch }. */
export function readWorkflows(dir = '.github/workflows') {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort(); } catch { return []; }
    return files.map((file) => {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        return { file, name: nameOf(text), crons: cronsIn(text), dispatch: hasDispatch(text) };
    }).filter((w) => w.crons.length);
}

/** The latest slot of a workflow: the most recent time any of its cron lines was due. null when it has none. */
export function dueOf(w, now = Date.now()) {
    // One cron line this parser cannot read must not stop the beat for every other job: that line is set aside
    // (cronProblems names it in the table) and the workflow's other lines still count.
    const dues = (w.crons || []).map((c) => { try { return lastDue(c, now); } catch { return null; } }).filter((t) => t !== null);
    return dues.length ? Math.max(...dues) : null;
}

/** The cron lines of a workflow that could not be read, each with the reason. Empty when all are fine. */
export function cronProblems(w) {
    const bad = [];
    for (const c of (w && w.crons) || []) { try { parseCron(c); } catch (e) { bad.push(`"${c}": ${String(e.message).replace(/^pacemaker:\s*/, '')}`); } }
    return bad;
}

/**
 * Did this run do the slot's work? A run whose every job was skipped (the watchdog on a preview deploy) or that was
 * cancelled (a release run replaced by a newer merge) did nothing, so it does not count. A run still in progress does.
 */
export function countsAsRun(run) {
    const c = run && run.conclusion;
    return c !== 'skipped' && c !== 'cancelled';
}

// ── the decision ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * For each scheduled workflow, what happened to its latest slot.
 *   state: 'ran'      a run started in (or just before) the slot; `lateMin` says how late it was
 *          'waiting'  the slot is younger than the grace, so GitHub may still run it
 *          'skipped'  past the grace with no run: `wake` is true when the pacemaker may start it
 * `runs` maps a file name to the start times (ISO or ms) of its recent runs, of ANY trigger: a run a merge started
 * a minute after the slot has done the slot's work.
 */
export function plan({ workflows, runs, now = Date.now(), graceMin = GRACE_MIN, tolMin = SLOT_TOLERANCE_MIN, maxWakes = MAX_WAKES }) {
    const rows = [];
    for (const w of workflows || []) {
        if (w.file === SELF) continue;
        const due = dueOf(w, now);
        const bad = cronProblems(w);
        // A schedule that cannot be read is shown, never silently dropped: nobody is watching that job's clock.
        if (bad.length) rows.push({ file: w.file, name: w.name, due: null, ranAt: null, lateMin: null, state: 'unreadable', wake: false, why: bad.join('; ') });
        if (due === null) continue;
        const starts = (runs?.[w.file] || []).map((t) => (typeof t === 'number' ? t : Date.parse(t))).filter(Number.isFinite);
        const inSlot = starts.filter((t) => t >= due - tolMin * 60000).sort((a, b) => a - b);
        const row = { file: w.file, name: w.name, due, ranAt: inSlot.length ? inSlot[0] : null, lateMin: null, state: '', wake: false, why: '' };
        if (inSlot.length) {
            row.state = 'ran';
            row.lateMin = Math.max(0, Math.round((inSlot[0] - due) / 60000));
        } else if (now - due < graceMin * 60000) {
            row.state = 'waiting';
        } else {
            row.state = 'skipped';
            row.lateMin = Math.round((now - due) / 60000);
            row.wake = !!w.dispatch;
            row.why = w.dispatch ? '' : 'it has no workflow_dispatch trigger, so it cannot be started from here';
        }
        rows.push(row);
    }
    // The slot that has waited longest is woken first; the rest wait for the next beat.
    const woken = rows.filter((r) => r.wake).sort((a, b) => a.due - b.due);
    woken.slice(maxWakes).forEach((r) => { r.wake = false; r.why = `more than ${maxWakes} jobs were skipped; this one is started on the next beat`; });
    return rows;
}

const hhmm = (ms) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ') + 'Z';

/** The table for the run summary. */
export function report(rows, { dry = false, results = {} } = {}) {
    const line = (r) => {
        if (r.state === 'unreadable') return `| \`${r.file}\` | — | — | its schedule could not be read, so this line is NOT watched: ${r.why} |`;
        const what = r.state === 'ran' ? (r.lateMin > GRACE_MIN ? `ran ${r.lateMin} min late` : 'ran on time')
            : r.state === 'waiting' ? 'due just now, GitHub may still run it'
                : r.wake ? (dry ? `SKIPPED by GitHub (${r.lateMin} min) — would be started` : `SKIPPED by GitHub (${r.lateMin} min) — ${results[r.file] || 'started by the pacemaker'}`)
                    : `SKIPPED by GitHub (${r.lateMin} min) — not started: ${r.why}`;
        return `| \`${r.file}\` | ${hhmm(r.due)} | ${r.ranAt ? hhmm(r.ranAt) : '—'} | ${what} |`;
    };
    return ['### Pacemaker: did each scheduled job run in its latest slot?', '', '| Job | Was due | Ran | Result |', '|---|---|---|---|', ...rows.map(line), ''].join('\n');
}

// ── the network ────────────────────────────────────────────────────────────────────────────────────────────────

async function gh(pathname, { method = 'GET', body, env = process.env } = {}) {
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const repo = env.GITHUB_REPOSITORY;
    if (!token || !repo) throw new Error('pacemaker: GITHUB_TOKEN and GITHUB_REPOSITORY are needed');
    const r = await fetch(`https://api.github.com/repos/${repo}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'wealthflow-pacemaker', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await r.text();
    if (!r.ok) { const e = new Error(`GitHub ${method} ${pathname} -> ${r.status}: ${raw.slice(0, 200)}`); e.status = r.status; throw e; }
    return raw ? JSON.parse(raw) : null;
}

/**
 * One beat. Returns { rows, woke, failed }. `fetchRuns` and `dispatch` are injected in tests.
 * A workflow whose run list cannot be read is left alone this beat (unknown is not "skipped").
 */
export async function beat({
    env = process.env, dir = '.github/workflows', now = Date.now(), dry = false, ref = env.PACEMAKER_REF || 'main', log = console.log,
    // Only runs since the slot (less the tolerance) are asked for, and only those that did work are counted.
    fetchRuns = async (file, sinceMs) => ((await gh(`/actions/workflows/${file}/runs?per_page=50&created=${encodeURIComponent('>=' + new Date(sinceMs).toISOString().slice(0, 19) + 'Z')}`, { env }))?.workflow_runs || [])
        .filter(countsAsRun).map((r) => r.run_started_at || r.created_at),
    dispatch = async (file, inputs) => gh(`/actions/workflows/${file}/dispatches`, { method: 'POST', body: { ref, ...(inputs ? { inputs } : {}) }, env }),
} = {}) {
    const workflows = readWorkflows(dir).filter((w) => w.file !== SELF);
    const runs = {};
    const unknown = [];
    for (const w of workflows) {
        const due = dueOf(w, now);
        if (due === null) continue;
        try { runs[w.file] = await fetchRuns(w.file, due - SLOT_TOLERANCE_MIN * 60000); }
        catch (e) { unknown.push(w.file); log(`[pacemaker] could not read the runs of ${w.file} (${e.message}) — left alone this beat`); }
    }
    const rows = plan({ workflows: workflows.filter((w) => !unknown.includes(w.file)), runs, now });
    const woke = [], failed = [], results = {};
    for (const r of rows.filter((x) => x.wake)) {
        if (dry) { log(`[pacemaker] ${r.file} was skipped (${r.lateMin} min) — dry run, not started`); continue; }
        try {
            await dispatch(r.file, WAKE_INPUTS[r.file]);
            woke.push(r.file);
            results[r.file] = 'started by the pacemaker';
            log(`[pacemaker] started ${r.file}: its ${hhmm(r.due)} slot was skipped (${r.lateMin} min ago, no run)`);
        } catch (e) {
            failed.push(r.file);
            results[r.file] = `could NOT be started (${String(e.message).slice(0, 120)})`;
            log(`[pacemaker] could not start ${r.file}: ${e.message}`);
        }
    }
    return { rows, woke, failed, unknown, summary: report(rows, { dry, results }) };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const dry = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
    beat({ dry }).then((out) => {
        console.log(out.summary);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.summary + '\n');
        const late = out.rows.filter((r) => r.state === 'ran' && r.lateMin > GRACE_MIN).length;
        console.log(`[pacemaker] ${out.rows.length} scheduled job(s): ${out.woke.length} started here, ${late} ran late on their own, ${out.failed.length} could not be started`);
        // A job that should have run and could not be started is the one thing that must be red.
        if (out.failed.length) process.exit(1);
    }).catch((e) => { console.error(`[pacemaker] ${e.message}`); process.exit(1); });
}
