/* =============================================================================
 * autonomy/actions-budget.mjs — keep the pipeline inside the free Actions tier
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   GitHub Free gives a PRIVATE repository 2,000 Actions minutes per month. The
 *   schedule this pipeline shipped with projected to 9,814 billable minutes —
 *   4.9x the entire allowance — and `health-watchdog` alone accounted for 8,640
 *   of them. The month would have died around day six, and the failure would have
 *   been silent in the worst way: every scheduled job simply stops, so the
 *   watchdog stops watching, the fix agent stops fixing, and the Actions tab
 *   still looks calm because nothing is red. Nothing failing is not the same as
 *   everything working.
 *
 * THE COST MODEL THAT ACTUALLY MATTERS
 *   Billing is per JOB, rounded UP to the whole minute. A five-second job costs a
 *   full minute, and a workflow with three jobs costs three minutes even if all
 *   three finish in seconds. So the quantity to minimise is JOB-RUNS PER MONTH,
 *   not seconds of compute — which inverts the intuitive optimisation. Splitting
 *   cheap work across separate workflows for tidiness is one of the most
 *   expensive things you can do here; merging cheap steps into one job is free
 *   savings.
 *
 *   Measured job durations in this repo (from the check runs on PR #28): risk
 *   gate 6s, auto-safe classify 5s, auto-merge 6s, fuzz 13s, secret scan 17s,
 *   conftest 18s, tests 29s, consensus board ~35s. Every one of them bills as
 *   one minute. That is why the default cost below is 1 and not an average.
 *
 * WHAT THIS MODULE IS FOR
 *   Retuning the crons once fixes today. This keeps it fixed: it reads the real
 *   workflow files, projects the monthly spend, and a test fails the build if the
 *   projection exceeds the budget. A future every-five-minutes cron — added by
 *   me, by an agent, or by a copy-paste from a tutorial — cannot land quietly.
 *
 * ZERO dependencies. Deliberately a small hand-rolled YAML reader rather than a
 * parser dependency: it only needs `on.schedule[].cron` and the job keys, and
 * adding a package to this repo to count two things is a poor trade.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';

/** GitHub Free, private repository. Public repos are unmetered. */
export const MONTHLY_BUDGET_MINUTES = 2000;

/**
 * Share of the budget reserved for event-driven CI (pull requests, pushes).
 *
 * Scheduled work must NOT be allowed to consume everything. A month where the
 * crons ran fine but no pull request could be tested is a worse outcome than a
 * month with a slower watchdog, because CI is the gate that contains mistakes.
 */
export const CI_RESERVE_MINUTES = 900;

/** Days per month used for projections — deliberately the long month. */
const DAYS_PER_MONTH = 31;

/**
 * Minutes billed per run of one job, by workflow. Default 1 = the billing floor.
 * Only jobs that genuinely exceed a minute are listed, and each is an estimate of
 * a MODEL-CALLING job, which is the only slow kind here.
 */
const JOB_MINUTES = {
    'autonomous-fix.yml': 4,        // agent swarm: several sequential model calls
    'autonomous-discover.yml': 2,   // npm audit + scanners
    'auto-release.yml': 2,          // build + tag + release notes
    'feature-proposals.yml': 2,     // one model call
    'consensus-review.yml': 2,      // three model calls, now in parallel
};

/** Every workflow file, ordered so output is stable. */
export function workflowFiles(dir = '.github/workflows') {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort(); } catch { return []; }
    return names.map((n) => path.join(dir, n));
}

/**
 * The job names declared under `jobs:`.
 *
 * Counts only two-space-indented keys inside the `jobs:` block. An earlier
 * version matched every two-space key in the file, which also caught `schedule:`
 * under `on:` and inflated the count for exactly the scheduled workflows whose
 * cost mattered most.
 */
export function jobsIn(text) {
    const lines = String(text || '').split('\n');
    const jobs = [];
    let inJobs = false;
    for (const line of lines) {
        if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
        if (!inJobs) continue;
        if (/^\S/.test(line)) break;                       // left the jobs block
        const m = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
        if (m) jobs.push(m[1]);
    }
    return jobs;
}

/** The cron expressions a workflow is scheduled on. */
export function cronsIn(text) {
    return [...String(text || '').matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

/**
 * How many times a 5-field cron fires in a month.
 *
 * Supports the forms this repo uses and the ones most likely to be added:
 * a wildcard, a fixed value, a comma list, and a step. A form it cannot read
 * THROWS rather than returning a guess — a budget model that silently scores an
 * unrecognised schedule as zero is how the thing it guards gets exceeded.
 */
export function runsPerMonth(cron) {
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length !== 5) throw new Error(`not a 5-field cron: "${cron}"`);
    const [min, hr, dom, , dow] = parts;

    const count = (field, range) => {
        if (field === '*') return range;
        if (/^\*\/(\d+)$/.test(field)) {
            const step = Number(/^\*\/(\d+)$/.exec(field)[1]);
            if (!step) throw new Error(`zero step in cron field "${field}"`);
            return Math.ceil(range / step);
        }
        if (/^[\d,]+$/.test(field)) return field.split(',').filter(Boolean).length;
        throw new Error(`unsupported cron field "${field}" in "${cron}"`);
    };

    const perHour = count(min, 60);
    const hours = count(hr, 24);

    // Day-of-week and day-of-month are OR'd by cron when both are restricted.
    // Only the shapes in use are modelled; anything else throws above.
    let days;
    if (dow !== '*' && dom === '*') days = (DAYS_PER_MONTH / 7) * count(dow, 7);
    else if (dom !== '*') days = count(dom, DAYS_PER_MONTH);
    else days = DAYS_PER_MONTH;

    return perHour * hours * days;
}

/** Project the monthly scheduled spend from the workflow files on disk. */
export function projectSchedule(dir = '.github/workflows') {
    const rows = [];
    for (const file of workflowFiles(dir)) {
        const text = fs.readFileSync(file, 'utf8');
        const crons = cronsIn(text);
        if (!crons.length) continue;
        const name = path.basename(file);
        const jobs = jobsIn(text).length || 1;
        const perJob = JOB_MINUTES[name] || 1;
        const runs = crons.reduce((s, c) => s + runsPerMonth(c), 0);
        rows.push({ file: name, crons, jobs, minutesPerJob: perJob, runs, minutes: Math.round(runs * jobs * perJob) });
    }
    rows.sort((a, b) => b.minutes - a.minutes);
    const scheduled = rows.reduce((s, r) => s + r.minutes, 0);
    return {
        rows,
        scheduledMinutes: scheduled,
        ciReserve: CI_RESERVE_MINUTES,
        totalMinutes: scheduled + CI_RESERVE_MINUTES,
        budget: MONTHLY_BUDGET_MINUTES,
        withinBudget: scheduled + CI_RESERVE_MINUTES <= MONTHLY_BUDGET_MINUTES,
        headroom: MONTHLY_BUDGET_MINUTES - (scheduled + CI_RESERVE_MINUTES),
    };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if ((process.argv[1] || '').endsWith('actions-budget.mjs')) {
    const p = projectSchedule();
    console.log(`\n⏱  GitHub Actions monthly projection (private-repo free tier)\n`);
    console.log(`${'workflow'.padEnd(28)}${'cron'.padEnd(16)}${'runs'.padStart(7)}${'jobs'.padStart(6)}${'min/job'.padStart(9)}${'minutes'.padStart(9)}`);
    for (const r of p.rows) {
        console.log(r.file.padEnd(28) + r.crons.join(',').padEnd(16)
            + String(Math.round(r.runs)).padStart(7) + String(r.jobs).padStart(6)
            + String(r.minutesPerJob).padStart(9) + String(r.minutes).padStart(9));
    }
    console.log(`\n  scheduled          ${String(p.scheduledMinutes).padStart(6)} min`);
    console.log(`  reserved for CI    ${String(p.ciReserve).padStart(6)} min`);
    console.log(`  ─────────────────────────────`);
    console.log(`  total              ${String(p.totalMinutes).padStart(6)} min  of ${p.budget}`);
    console.log(`\n${p.withinBudget ? '✅' : '❌'} ${p.withinBudget
        ? `within budget — ${p.headroom} min headroom`
        : `OVER BUDGET by ${-p.headroom} min (${(p.totalMinutes / p.budget).toFixed(1)}x)`}\n`);
    process.exit(p.withinBudget ? 0 : 1);
}
