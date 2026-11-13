/* A scheduled run that GitHub delivers late stops when its slot was already served. The cases are the ones measured on 2026-11-12:
 * autonomous-discover ran 08:08Z (the pacemaker) and again 12:22Z (schedule); security-updates 08:08Z and 13:54Z; feature-proposals 08:08Z and 09:58Z. */
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { slotServed, guard } from '../autonomy/slot-guard.mjs';
import { cronsIn } from '../autonomy/pacemaker.mjs';

const T = (hhmm, day = '2026-11-12') => Date.parse(`${day}T${hhmm}:00Z`);
const run = (id, start, o = {}) => ({ id, run_started_at: new Date(T(start)).toISOString(), event: 'workflow_dispatch', status: 'completed', conclusion: 'success', ...o });
const DAILY_04 = ['0 4 * * *'];

describe('slotServed', () => {
    it('replay 2026-11-12: the pacemaker served the 04:00 slot at 08:08Z, so the schedule run delivered at 12:22Z stops', () => {
        const out = slotServed({ crons: DAILY_04, now: T('12:22'), selfId: 2, selfStart: T('12:22'), runs: [run(1, '08:08'), run(2, '12:22', { event: 'schedule', status: 'in_progress', conclusion: null })] });
        expect(out.served).toBe(true);
        expect(out.by.id).toBe(1);
        expect(out.why).toMatch(/did the slot due 04:00Z/);
    });
    it('a punctual run, with nobody before it, goes on', () => {
        expect(slotServed({ crons: DAILY_04, now: T('04:01'), selfId: 9, selfStart: T('04:01'), runs: [run(9, '04:01', { event: 'schedule', status: 'in_progress', conclusion: null })] }).served).toBe(false);
    });
    it('a run in progress serves the slot too (the pacemaker started it and it is not finished)', () => {
        expect(slotServed({ crons: DAILY_04, now: T('10:00'), selfId: 2, selfStart: T('10:00'), runs: [run(1, '09:50', { status: 'in_progress', conclusion: null })] }).served).toBe(true);
    });
    it('a FAILED run does not serve the slot: the late run is its retry', () => {
        expect(slotServed({ crons: DAILY_04, now: T('12:00'), selfId: 2, selfStart: T('12:00'), runs: [run(1, '08:08', { conclusion: 'failure' })] }).served).toBe(false);
    });
    it('a skipped or cancelled run did nothing', () => {
        for (const conclusion of ['skipped', 'cancelled']) expect(slotServed({ crons: DAILY_04, now: T('12:00'), selfId: 2, selfStart: T('12:00'), runs: [run(1, '08:08', { conclusion })] }).served, conclusion).toBe(false);
    });
    it('yesterday\'s run is not today\'s slot', () => {
        expect(slotServed({ crons: DAILY_04, now: T('12:00'), selfId: 2, selfStart: T('12:00'), runs: [{ ...run(1, '04:00'), run_started_at: '2026-11-11T04:00:30Z' }] }).served).toBe(false);
    });
    it('a run a few minutes before the slot counts as the slot\'s run (the pacemaker\'s own tolerance)', () => {
        expect(slotServed({ crons: DAILY_04, now: T('12:00'), selfId: 2, selfStart: T('12:00'), runs: [run(1, '03:57')] }).served).toBe(true);
    });
    it('two late runs delivered together do not cancel each other: only the later one stops', () => {
        const a = run(1, '12:22', { event: 'schedule', status: 'in_progress', conclusion: null });
        const b = { ...run(2, '12:22', { event: 'schedule', status: 'in_progress', conclusion: null }), run_started_at: new Date(T('12:22') + 5000).toISOString() };
        expect(slotServed({ crons: DAILY_04, now: T('12:23'), selfId: 1, selfStart: Date.parse(a.run_started_at), runs: [a, b] }).served).toBe(false);
        expect(slotServed({ crons: DAILY_04, now: T('12:23'), selfId: 2, selfStart: Date.parse(b.run_started_at), runs: [a, b] }).served).toBe(true);
    });
    it('no readable schedule runs the job', () => {
        expect(slotServed({ crons: [], now: T('12:00'), selfId: 2, runs: [run(1, '08:08')] }).served).toBe(false);
    });
    it('security-updates has a daily and a monthly line: the latest of the two is the slot', () => {
        const crons = ['30 5 * * *', '30 6 1 * *'];
        expect(slotServed({ crons, now: T('13:54'), selfId: 2, selfStart: T('13:54'), runs: [run(1, '08:08')] }).served).toBe(true);
    });
});

describe('guard (the CLI\'s decision, with GitHub injected)', () => {
    const env = { GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ID: '2', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' };
    const read = () => "on:\n  schedule:\n    - cron: '0 4 * * *'\n";
    const apiOf = (calls, runs, self) => async (p, o = {}) => { calls.push(`${o.method || 'GET'} ${p.split('?')[0]}`); if (/\/runs\/2$/.test(p)) return self; if (/workflows\//.test(p)) return { workflow_runs: runs }; return null; };

    it('a late schedule run whose slot was served cancels itself', async () => {
        const calls = [];
        const out = await guard({ file: 'x.yml', env, now: T('12:22'), read, api: apiOf(calls, [run(1, '08:08')], { run_started_at: new Date(T('12:22')).toISOString() }) });
        expect(out).toMatchObject({ guarded: true, served: true });
        expect(calls).toContain('POST /actions/runs/2/cancel');
    });
    it('a dispatch, a push or a manual run is never held back, and GitHub is not asked', async () => {
        const calls = [];
        for (const GITHUB_EVENT_NAME of ['workflow_dispatch', 'push', undefined]) {
            const out = await guard({ file: 'x.yml', env: { ...env, GITHUB_EVENT_NAME }, now: T('12:22'), read, api: apiOf(calls, [run(1, '08:08')], {}) });
            expect(out).toMatchObject({ guarded: false, served: false });
        }
        expect(calls).toEqual([]);
    });
    it('any doubt runs the job: GitHub failing, or a cancel that is refused', async () => {
        const broken = await guard({ file: 'x.yml', env, now: T('12:22'), read, api: async () => { throw new Error('502 bad gateway'); } });
        expect(broken).toMatchObject({ served: false });
        expect(broken.text).toMatch(/could not tell/);
        const refused = await guard({ file: 'x.yml', env, now: T('12:22'), read, api: async (p, o = {}) => { if (o.method === 'POST') throw new Error('403 Resource not accessible'); return /\/runs\/2$/.test(p) ? { run_started_at: new Date(T('12:22')).toISOString() } : { workflow_runs: [run(1, '08:08')] }; } });
        expect(refused.served).toBe(false);
    });
});

describe('the three daily workflows carry the guard, right after checkout, only for schedule runs', () => {
    for (const f of ['autonomous-discover', 'security-updates', 'feature-proposals']) {
        it(f, () => {
            const text = fs.readFileSync(`.github/workflows/${f}.yml`, 'utf8');
            expect(cronsIn(text).length).toBeGreaterThan(0);
            expect(text).toMatch(new RegExp(`- uses: actions/checkout@v7\\n(?:        with:\\n(?:          .*\\n)+)?\\n(?:      #.*\\n)+      - name: Slot guard[^\\n]*\\n        if: github.event_name == 'schedule'\\n        env:\\n          GITHUB_TOKEN: \\$\\{\\{ secrets.GITHUB_TOKEN \\}\\}\\n        run: node autonomy/slot-guard.mjs ${f}.yml\\n`));
            expect(text).toMatch(/\n  actions: write/);       // the cancel needs it
        });
    }
});
