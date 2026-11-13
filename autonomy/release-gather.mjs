/* =============================================================================
 * autonomy/release-gather.mjs — several changes ride in ONE update
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (measured, 2026-11-11)
 *   Every merge cut its own release within minutes, so one day produced v7.69.78 to v7.69.88: eleven updates.
 *   Each one is a new "update available" on the owner's phone. The owner (2026-11-12): updates must not go out one
 *   by one; several are collected and sent as one, the way Android and iOS do it. His earlier rulings still hold:
 *   nothing is held for days, and a fix reaches him the same day.
 *
 * THE RULE
 *   After a merge the release waits for the line to go QUIET: no further merge for QUIET_MIN minutes. Every merge
 *   that lands in the meantime joins the same update and restarts the wait. It never waits longer than
 *   MAX_HOLD_MIN since the OLDEST change that is waiting, and it does not wait at all when any waiting change is
 *   urgent (a hotfix, a security fix, a crash fix, a rollback) or when a person starts the release by hand.
 *
 *   The wait itself is a job that sleeps (auto-release.yml, job `gather`). A newer merge starts a newer run; the sleeping
 *   run sees it within a minute (autonomy/gather-wait.mjs) and ends GREEN, releasing nothing, so the timer is always held by
 *   the newest merge. (It used to be cancelled through a concurrency group, which GitHub draws as a red cross.)
 *
 * Yesterday's ten merges under this rule: four updates instead of nine.
 * Pure decision + a small CLI that prints the number of seconds to wait. It fails OPEN: anything it cannot read
 * means "do not wait", because a release that is late for a broken timer is worse than one that is not gathered.
 * ===========================================================================*/

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUIET_MIN = 45;
export const MAX_HOLD_MIN = 120;

/** A waiting change with one of these words in its title goes out at once. */
export const URGENT = /\b(hotfix|urgent|security|vulnerab\w*|cve-\d+|crash(es|ed|ing)?|rollback)\b|^revert\b/i;

/** Commits that are not a change to the app: the release stamp and the hourly merchant list refresh. */
export const NOT_A_CHANGE = /^(release: |chore\(merchants\))/i;

/** A setting from the environment; an unset or empty one is the default (Number('') is 0, which would switch gathering off). */
export const num = (v, d) => { if (v == null || String(v).trim() === '') return d; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

/**
 * How long to wait before releasing.
 * @param {{ event:string, manual?:boolean, commits:{subject:string,time:number}[], now?:number, quietMin?:number, maxHoldMin?:number }} o
 *   event   the trigger: push, schedule or workflow_dispatch
 *   manual  a person started it by hand (a workflow_dispatch that is not the pacemaker's)
 *   commits the changes waiting since the last release tag, each with its commit time in ms
 * @returns {{ holdMin:number, why:string, waiting:number }}
 */
export function decideHold({ event, manual = false, commits, now = Date.now(), quietMin = QUIET_MIN, maxHoldMin = MAX_HOLD_MIN }) {
    const real = (commits || []).filter((c) => c && !NOT_A_CHANGE.test(String(c.subject || '')) && Number.isFinite(c.time));
    const out = (holdMin, why) => ({ holdMin: Math.max(0, Math.ceil(holdMin)), why, waiting: real.length });
    if (manual) return out(0, 'started by hand, so it releases now');
    if (!(quietMin > 0)) return out(0, 'gathering is switched off (quiet time 0)');
    if (!real.length) return out(0, 'nothing is waiting');
    const urgent = real.find((c) => URGENT.test(c.subject));
    if (urgent) return out(0, `an urgent change is waiting ("${String(urgent.subject).slice(0, 70)}")`);
    const newest = Math.max(...real.map((c) => c.time));
    const oldest = Math.min(...real.map((c) => c.time));
    const sinceNewest = (now - newest) / 60000;
    const sinceOldest = (now - oldest) / 60000;
    if (sinceOldest >= maxHoldMin) return out(0, `the oldest waiting change has waited ${Math.round(sinceOldest)} min, which is the longest a change is ever held (${maxHoldMin} min)`);
    if (sinceNewest >= quietMin) return out(0, `no new change for ${Math.round(sinceNewest)} min, so the line is quiet`);
    const hold = Math.min(quietMin - sinceNewest, maxHoldMin - sinceOldest);
    return out(hold, `${real.length} change(s) waiting; the newest landed ${Math.round(sinceNewest)} min ago, so the update waits for ${quietMin} quiet minutes (never more than ${maxHoldMin} min after the oldest change)`);
}

/** The commits since the last release tag: [{subject, time}]. Throws if git cannot answer (the CLI turns that into "do not wait"). */
export function waitingCommits({ cwd = process.cwd() } = {}) {
    const last = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd, encoding: 'utf8' }).trim();
    const log = execFileSync('git', ['log', `${last}..HEAD`, '--format=%ct%x09%s'], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return log.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { time: Number(l.slice(0, i)) * 1000, subject: l.slice(i + 1) }; });
}

// ── CLI: prints `hold_seconds=<n>` and the reason ──────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    let d;
    try {
        d = decideHold({
            event: process.env.EVENT || '',
            manual: process.env.EVENT === 'workflow_dispatch' && !/^(1|true|yes)$/i.test(process.env.AUTO || ''),
            commits: waitingCommits(),
            quietMin: num(process.env.QUIET_MIN, QUIET_MIN),
            maxHoldMin: num(process.env.MAX_HOLD_MIN, MAX_HOLD_MIN),
        });
    } catch (e) {
        d = { holdMin: 0, why: `the waiting changes could not be read (${String(e.message).split('\n')[0].slice(0, 120)}), so nothing is held`, waiting: 0 };
    }
    console.log(`hold_seconds=${d.holdMin * 60}`);
    console.log(`reason=${d.why}`);
}
