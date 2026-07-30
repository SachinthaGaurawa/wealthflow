// =============================================================================
// WealthFlow Shadow Test Harness — the Actions-minutes budget
// =============================================================================
// GitHub Free gives a PRIVATE repository 2,000 Actions minutes a month. The
// schedule this pipeline shipped with projected to over 12,000 — six times the
// allowance, with `health-watchdog` alone accounting for 8,928 of them by probing
// every five minutes.
//
// The failure mode is what makes this worth a gate rather than a one-off fix.
// When the allowance runs out, scheduled jobs do not fail — they simply never
// start. The watchdog stops watching, the fix agent stops fixing, releases stop
// releasing, and the Actions tab stays calm because nothing is red. That is the
// same silent-green shape as a test job that ran no tests and exited 0, and this
// project has now hit that shape three separate ways.
//
// Retuning the crons fixed today. These tests are what stop it coming back: an
// every-five-minutes cron pasted in by a future me, an agent, or a tutorial has
// to get past an assertion that reads the real workflow files.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';
import {
    runsPerMonth, jobsIn, cronsIn, projectSchedule,
    MONTHLY_BUDGET_MINUTES, CI_RESERVE_MINUTES,
} from '../autonomy/actions-budget.mjs';

describe('cron arithmetic', () => {
    it('counts a step-minute schedule', () => {
        expect(runsPerMonth('*/5 * * * *')).toBe(12 * 24 * 31);
    });

    it('counts a step-hour schedule', () => {
        expect(runsPerMonth('0 */6 * * *')).toBe(4 * 31);
        expect(runsPerMonth('25 */6 * * *')).toBe(4 * 31);   // the offset must not change the count
    });

    it('counts hourly and daily', () => {
        expect(runsPerMonth('0 * * * *')).toBe(24 * 31);
        expect(runsPerMonth('0 6 * * *')).toBe(31);
        expect(runsPerMonth('17 7 * * *')).toBe(31);
    });

    it('counts a weekly schedule', () => {
        expect(runsPerMonth('0 9 * * 1')).toBeCloseTo(31 / 7, 1);
    });

    it('counts comma lists', () => {
        expect(runsPerMonth('0 0,12 * * *')).toBe(2 * 31);
        expect(runsPerMonth('0,30 * * * *')).toBe(2 * 24 * 31);
    });

    it('THROWS on a form it cannot read, rather than scoring it zero', () => {
        // The most dangerous possible bug in a budget model is treating an
        // unrecognised schedule as free. A range or a step-with-range would then
        // sail past the gate it exists to enforce.
        expect(() => runsPerMonth('0 9-17 * * *')).toThrow();
        expect(() => runsPerMonth('*/0 * * * *')).toThrow();
        expect(() => runsPerMonth('0 6 * *')).toThrow();
        expect(() => runsPerMonth('')).toThrow();
        expect(() => runsPerMonth(null)).toThrow();
    });

    it('never returns a negative or non-finite count for anything it accepts', () => {
        fc.assert(fc.property(fc.string({ maxLength: 24 }), (s) => {
            let n;
            try { n = runsPerMonth(s); } catch { return; }   // rejecting is fine
            expect(Number.isFinite(n)).toBe(true);
            expect(n).toBeGreaterThan(0);
        }), { numRuns: runs(400) });
    });
});

describe('workflow parsing', () => {
    const yml = [
        'name: x',
        'on:',
        '  schedule:',
        "    - cron: '0 */6 * * *'",
        '  workflow_dispatch: {}',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  first:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo hi',
        '  second:',
        '    runs-on: ubuntu-latest',
    ].join('\n');

    it('counts only real jobs, not other two-space keys', () => {
        // The first version of this parser matched every two-space-indented key,
        // so it also counted `schedule:` under `on:` — inflating the job count for
        // precisely the scheduled workflows whose cost mattered most.
        expect(jobsIn(yml)).toEqual(['first', 'second']);
    });

    it('reads the cron expressions', () => {
        expect(cronsIn(yml)).toEqual(['0 */6 * * *']);
    });

    it('returns nothing for a workflow with no schedule', () => {
        expect(cronsIn('on:\n  pull_request:\njobs:\n  a:\n')).toEqual([]);
    });
});

describe('the real schedule fits in the free tier', () => {
    const p = projectSchedule();

    it('found the workflows at all (guards against a vacuous pass)', () => {
        // Every assertion below is trivially true against an empty projection,
        // which is the exact failure this file exists to prevent.
        expect(p.rows.length).toBeGreaterThanOrEqual(6);
        expect(p.scheduledMinutes).toBeGreaterThan(0);
    });

    it('projects within the monthly budget, CI reserve included', () => {
        const detail = p.rows.map((r) => `${r.file} ${r.crons.join(',')} = ${r.minutes} min`).join('\n');
        expect(p.withinBudget, `projected ${p.totalMinutes} of ${p.budget} min:\n${detail}`).toBe(true);
    });

    it('leaves a real reserve for pull-request CI', () => {
        // Scheduled work must never be allowed to eat the whole allowance. A month
        // where the crons ran but no PR could be tested is worse than a month with
        // a slower watchdog: CI is the gate that contains mistakes.
        expect(p.ciReserve).toBeGreaterThanOrEqual(600);
        expect(p.scheduledMinutes).toBeLessThan(MONTHLY_BUDGET_MINUTES - CI_RESERVE_MINUTES);
    });

    it('has no single workflow consuming more than half the allowance', () => {
        // health-watchdog was 8,928 of 2,000 on its own. Any workflow over half the
        // budget is a design error regardless of what the total says today.
        const hogs = p.rows.filter((r) => r.minutes > MONTHLY_BUDGET_MINUTES / 2);
        expect(hogs.map((h) => `${h.file}=${h.minutes}`)).toEqual([]);
    });

    it('keeps the sub-hourly crons out entirely', () => {
        // A minute-stepped cron cannot be affordable here: 1-minute billing floor
        // times 8,928 runs exceeds the allowance before the job does any work.
        const subHourly = p.rows.filter((r) => r.crons.some((c) => /^\*\/\d+ /.test(c) || /^\*/.test(c.split(' ')[0])));
        expect(subHourly.map((r) => `${r.file} ${r.crons}`)).toEqual([]);
    });
});

describe('the gate can actually fail', () => {
    // A budget check that has never been shown to reject anything is indistinguishable
    // from one that always passes.
    it('rejects a five-minute cron on a modelled workflow', () => {
        const watchdogRuns = runsPerMonth('*/5 * * * *');
        expect(watchdogRuns).toBeGreaterThan(MONTHLY_BUDGET_MINUTES);
    });

    it('flags the exact schedule this repo used to ship', () => {
        const before =
            runsPerMonth('*/5 * * * *') * 1          // health-watchdog
            + runsPerMonth('0 */2 * * *') * 4        // autonomous-fix
            + runsPerMonth('0 * * * *') * 1;         // merchant-sync
        expect(before).toBeGreaterThan(MONTHLY_BUDGET_MINUTES * 5);

        const after = projectSchedule().scheduledMinutes;
        expect(after).toBeLessThan(before / 8);
    });
});

describe('health-watchdog is deploy-triggered, and guarded against preview deploys', () => {
    const yml = () => fs.readFileSync('.github/workflows/health-watchdog.yml', 'utf8');

    it('probes on a deployment, not only on a timer', () => {
        // A bad deployment is the failure this workflow exists to undo, and a deploy
        // is an event the repo already receives. Polling for it was both more
        // expensive and slower to react.
        expect(yml()).toMatch(/^\s*deployment_status:\s*$/m);
    });

    it('skips preview deployments, so PR pushes cost nothing', () => {
        // Without this the new trigger would be WORSE than the cron it replaced:
        // Vercel builds a preview on every push, so production would be probed
        // several times per pull request. A job skipped by `if` never starts a
        // runner and bills nothing.
        const t = yml();
        expect(t).toMatch(/deployment_status\.state == 'success'/);
        expect(t).toMatch(/deployment_status\.environment == 'Production'/);
        // …and a scheduled run, which carries no deployment payload, must still run.
        expect(t).toMatch(/github\.event_name != 'deployment_status'/);
    });

    it('still keeps a timer for failures no deploy caused', () => {
        // An expired certificate or a provider outage is not preceded by a deploy.
        expect(cronsIn(yml())).toHaveLength(1);
        expect(runsPerMonth(cronsIn(yml())[0])).toBeLessThanOrEqual(4 * 31);
    });
});
