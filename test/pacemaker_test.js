// The pacemaker: a scheduled job GitHub delayed or dropped is started (autonomy/pacemaker.mjs).
// The times in "what really happened" are this repository's own run history of 2026-11-11/12.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseField, parseCron, cronMatches, lastDue, cronsIn, hasDispatch, nameOf, readWorkflows, dueOf, cronProblems, countsAsRun, plan, report, beat, GRACE_MIN, MAX_WAKES, SELF, WAKE_INPUTS } from '../autonomy/pacemaker.mjs';
import { cronsIn as budgetCrons } from '../autonomy/actions-budget.mjs';

const T = (iso) => Date.parse(iso);
const wf = (file, crons, dispatch = true) => ({ file, name: file, crons, dispatch });

describe('reading a cron line', () => {
    it('reads a star, a step, a number, a range, a list and a stepped range', () => {
        expect(parseField('*', 0, 59)).toBe(null);
        expect([...parseField('*/15', 0, 59)]).toEqual([0, 15, 30, 45]);
        expect([...parseField('7,27,47', 0, 59)]).toEqual([7, 27, 47]);
        expect([...parseField('1-3', 0, 6)]).toEqual([1, 2, 3]);
        expect([...parseField('10-20/5', 0, 59)]).toEqual([10, 15, 20]);
        expect([...parseField('5/20', 0, 59)]).toEqual([5, 25, 45]);
    });
    it('refuses a line it cannot read instead of guessing', () => {
        expect(() => parseField('MON', 0, 6)).toThrow();
        expect(() => parseField('70', 0, 59)).toThrow();
        expect(() => parseCron('0 4 * *')).toThrow(/five fields/);
    });
    it('matches in UTC, and Sunday may be written 0 or 7', () => {
        expect(cronMatches('30 2 * * *', new Date('2026-11-12T02:30:00Z'))).toBe(true);
        expect(cronMatches('30 2 * * *', new Date('2026-11-12T02:31:00Z'))).toBe(false);
        expect(cronMatches('17 4 * * 1', new Date('2026-11-09T04:17:00Z'))).toBe(true);    // a Monday
        expect(cronMatches('17 4 * * 1', new Date('2026-11-10T04:17:00Z'))).toBe(false);
        expect(cronMatches('0 0 * * 7', new Date('2026-11-08T00:00:00Z'))).toBe(true);     // a Sunday
        expect(cronMatches('30 6 1 * *', new Date('2026-11-01T06:30:00Z'))).toBe(true);
    });
    it('finds the most recent slot', () => {
        const now = T('2026-11-12T04:41:00Z');
        expect(lastDue('30 2 * * *', now)).toBe(T('2026-11-12T02:30:00Z'));
        expect(lastDue('25 */6 * * *', now)).toBe(T('2026-11-12T00:25:00Z'));
        expect(lastDue('41 */3 * * *', now)).toBe(T('2026-11-12T03:41:00Z'));
        expect(lastDue('47 4 * * 1', now)).toBe(T('2026-11-09T04:47:00Z'));
        expect(lastDue('30 6 1 * *', now)).toBe(T('2026-11-01T06:30:00Z'));
        expect(lastDue('0 0 30 2 *', now)).toBe(null);                                     // 30 February never comes
    });
});

describe('what really happened on 2026-11-12 04:41Z', () => {
    const now = T('2026-11-12T04:41:00Z');
    const workflows = [
        wf('auto-release.yml', ['0 */6 * * *']), wf('autonomous-fix.yml', ['25 */6 * * *']), wf('feature-proposals.yml', ['30 2 * * *']),
        wf('security-updates.yml', ['30 5 * * *', '30 6 1 * *']), wf('autonomous-discover.yml', ['0 4 * * *']),
    ];
    const runs = {
        'auto-release.yml': ['2026-11-12T00:02:38Z'],
        'autonomous-fix.yml': [],                               // due 00:25, never ran
        'feature-proposals.yml': [],                            // due 02:30, never ran
        'security-updates.yml': ['2026-11-11T12:51:54Z'],       // due 05:30 the day before, ran 7 h 21 min late
        'autonomous-discover.yml': [],                          // due 04:00, 41 minutes ago
    };
    const rows = plan({ workflows, runs, now });
    const by = Object.fromEntries(rows.map((r) => [r.file, r]));
    it('a job that ran in its slot is left alone, and its lateness is measured', () => {
        expect(by['auto-release.yml']).toMatchObject({ state: 'ran', lateMin: 3, wake: false });
        expect(by['security-updates.yml']).toMatchObject({ state: 'ran', lateMin: 442, wake: false });
    });
    it('a job whose slot passed with no run is started', () => {
        expect(by['autonomous-fix.yml']).toMatchObject({ state: 'skipped', lateMin: 256, wake: true });
        expect(by['feature-proposals.yml']).toMatchObject({ state: 'skipped', lateMin: 131, wake: true });
        expect(by['autonomous-discover.yml']).toMatchObject({ state: 'skipped', wake: true });
    });
    it('the report says it in words', () => {
        const text = report(rows, { dry: true });
        expect(text).toMatch(/`feature-proposals.yml` \| 11-12 02:30Z \| — \| SKIPPED by GitHub \(131 min\) — would be started/);
        expect(text).toMatch(/`security-updates.yml`.*ran 442 min late/);
        expect(text).toMatch(/`auto-release.yml`.*ran on time/);
    });
});

describe('what it never does', () => {
    const now = T('2026-11-12T02:50:00Z');
    it('gives GitHub its grace: a slot 20 minutes old is still waiting', () => {
        const [r] = plan({ workflows: [wf('feature-proposals.yml', ['30 2 * * *'])], runs: {}, now });
        expect(r).toMatchObject({ state: 'waiting', wake: false });
        expect(GRACE_MIN).toBeGreaterThanOrEqual(20);
    });
    it('never starts a job twice for one slot: the run it started counts', () => {
        const later = T('2026-11-12T03:30:00Z');
        const [r] = plan({ workflows: [wf('feature-proposals.yml', ['30 2 * * *'])], runs: { 'feature-proposals.yml': ['2026-11-12T03:07:10Z'] }, now: later });
        expect(r).toMatchObject({ state: 'ran', wake: false, lateMin: 37 });
    });
    it('a run that started a few minutes before the slot counts for it (a merge did the work)', () => {
        const [r] = plan({ workflows: [wf('auto-release.yml', ['0 */6 * * *'])], runs: { 'auto-release.yml': ['2026-11-11T23:57:00Z'] }, now: T('2026-11-12T01:00:00Z') });
        expect(r.state).toBe('ran');
    });
    it('never starts a workflow that cannot be started by hand, and says why', () => {
        const [r] = plan({ workflows: [wf('x.yml', ['30 2 * * *'], false)], runs: {}, now: T('2026-11-12T04:00:00Z') });
        expect(r).toMatchObject({ state: 'skipped', wake: false });
        expect(r.why).toMatch(/workflow_dispatch/);
    });
    it('never starts itself, and never more than the cap in one beat (the longest wait goes first)', () => {
        const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((n, i) => wf(`${n}.yml`, [`${i * 5} 1 * * *`]));
        const rows = plan({ workflows: [wf(SELF, ['7,27,47 * * * *']), ...many], runs: {}, now: T('2026-11-12T04:00:00Z') });
        expect(rows.some((r) => r.file === SELF)).toBe(false);
        expect(rows.filter((r) => r.wake).map((r) => r.file)).toEqual(['a.yml', 'b.yml', 'c.yml', 'd.yml']);
        expect(rows.filter((r) => r.wake).length).toBe(MAX_WAKES);
        expect(rows.find((r) => r.file === 'f.yml').why).toMatch(/next beat/);
    });
    it('a run whose jobs were all skipped, or that was cancelled, did not do the work; one in progress did', () => {
        expect(countsAsRun({ conclusion: 'skipped' })).toBe(false);
        expect(countsAsRun({ conclusion: 'cancelled' })).toBe(false);
        expect(countsAsRun({ conclusion: 'success' })).toBe(true);
        expect(countsAsRun({ conclusion: 'failure' })).toBe(true);
        expect(countsAsRun({ conclusion: null, status: 'in_progress' })).toBe(true);
    });
});

describe('one beat', () => {
    const now = T('2026-11-12T04:41:00Z');
    it('starts what was skipped, with the inputs that workflow needs, and reports it', async () => {
        const started = [];
        const out = await beat({
            now, log: () => {},
            fetchRuns: async (file) => (file === 'feature-proposals.yml' || file === 'auto-release.yml' ? [] : [new Date(now - 60000).toISOString()]),
            dispatch: async (file, inputs) => { started.push([file, inputs]); },
        });
        expect(started.map((s) => s[0]).sort()).toEqual(['auto-release.yml', 'feature-proposals.yml']);
        expect(started.find((s) => s[0] === 'auto-release.yml')[1]).toEqual(WAKE_INPUTS['auto-release.yml']);
        expect(started.find((s) => s[0] === 'feature-proposals.yml')[1]).toBeUndefined();
        expect(out.woke.length).toBe(2);
        expect(out.failed).toEqual([]);
        expect(out.summary).toMatch(/started by the pacemaker/);
    });
    it('a dry beat starts nothing', async () => {
        let n = 0;
        const out = await beat({ now, dry: true, log: () => {}, fetchRuns: async () => [], dispatch: async () => { n++; } });
        expect(n).toBe(0);
        expect(out.woke).toEqual([]);
        expect(out.summary).toMatch(/would be started/);
    });
    it('a workflow whose runs cannot be read is left alone (unknown is not skipped)', async () => {
        const started = [];
        const out = await beat({
            now, log: () => {},
            fetchRuns: async (file) => { if (file === 'autonomous-fix.yml') throw new Error('502'); return [new Date(now - 60000).toISOString()]; },
            dispatch: async (file) => { started.push(file); },
        });
        expect(started).toEqual([]);
        expect(out.unknown).toEqual(['autonomous-fix.yml']);
        expect(out.rows.some((r) => r.file === 'autonomous-fix.yml')).toBe(false);
    });
    it('a refused start is reported as a failure, not hidden', async () => {
        const out = await beat({ now, log: () => {}, fetchRuns: async (file) => (file === 'merchant-sync.yml' ? [] : [new Date(now - 60000).toISOString()]), dispatch: async () => { throw new Error('GitHub POST -> 403: Resource not accessible'); } });
        expect(out.failed).toEqual(['merchant-sync.yml']);
        expect(out.summary).toMatch(/could NOT be started/);
    });
});

describe('the real workflow files', () => {
    const all = readWorkflows();
    it('every scheduled workflow can be started by the pacemaker', () => {
        expect(all.length).toBeGreaterThanOrEqual(10);
        const cannot = all.filter((w) => w.file !== SELF && !w.dispatch).map((w) => w.file);
        expect(cannot).toEqual([]);
    });
    it('every cron line in them can be read, and is read the same way the budget reads it', () => {
        for (const w of all) {
            for (const c of w.crons) expect(() => parseCron(c), `${w.file}: ${c}`).not.toThrow();
            expect(dueOf(w, T('2026-11-12T04:41:00Z')), w.file).not.toBe(null);
            const text = fs.readFileSync(`.github/workflows/${w.file}`, 'utf8');
            expect(cronsIn(text).sort()).toEqual(budgetCrons(text).sort());
        }
    });
    it('the pacemaker listens to workflows that exist under exactly those names', () => {
        const text = fs.readFileSync(`.github/workflows/${SELF}`, 'utf8');
        const listed = [...text.matchAll(/^\s{6}- '([^']+)'\s*$/gm)].map((m) => m[1]);
        expect(listed.length).toBeGreaterThanOrEqual(2);
        const names = fs.readdirSync('.github/workflows').map((f) => nameOf(fs.readFileSync(`.github/workflows/${f}`, 'utf8')));
        for (const n of listed) expect(names, n).toContain(n);
        expect(hasDispatch(text)).toBe(true);
        expect(text).toMatch(/actions: write/);
    });
    it('every workflow that needs inputs when woken really declares them', () => {
        for (const [file, inputs] of Object.entries(WAKE_INPUTS)) {
            const text = fs.readFileSync(`.github/workflows/${file}`, 'utf8');
            for (const key of Object.keys(inputs)) expect(text, `${file} input ${key}`).toMatch(new RegExp(`^\\s{6}${key}:\\s*$`, 'm'));
        }
    });
});

describe('one cron line it cannot read does not stop the beat for the others', () => {
    const now = Date.parse('2026-11-12T05:10:00Z');   // 45 minutes after the 04:25 slot
    const good = { file: 'autonomous-fix.yml', name: 'Fix agent', crons: ['25 */4 * * *'], dispatch: true };
    const bad = { file: 'odd.yml', name: 'Odd', crons: ['@daily'], dispatch: true };
    const half = { file: 'half.yml', name: 'Half', crons: ['99 * * * *', '0 */6 * * *'], dispatch: true };

    it('names the line and the reason, and still reads the other lines of the same file', () => {
        expect(cronProblems(good)).toEqual([]);
        expect(cronProblems(bad)[0]).toMatch(/@daily/);
        expect(cronProblems(half).length).toBe(1);
        expect(dueOf(bad, now)).toBe(null);
        expect(dueOf(half, now)).toBe(Date.parse('2026-11-12T00:00:00Z'));
        expect(cronProblems(null)).toEqual([]);
    });

    it('the plan shows the unreadable schedule and still wakes the job that was skipped', () => {
        const rows = plan({ workflows: [bad, good, half], runs: {}, now });
        expect(rows.find((r) => r.file === 'odd.yml').state).toBe('unreadable');
        expect(rows.find((r) => r.file === 'odd.yml').wake).toBe(false);
        const fix = rows.find((r) => r.file === 'autonomous-fix.yml');
        expect(fix.state).toBe('skipped');
        expect(fix.wake).toBe(true);
        expect(rows.filter((r) => r.file === 'half.yml').map((r) => r.state).sort()).toEqual(['skipped', 'unreadable']);
        const text = report(rows, { dry: true });
        expect(text).toMatch(/odd\.yml.*NOT watched/);
        expect(text).toMatch(/autonomous-fix\.yml.*would be started/);
    });

    it('a whole beat with a bad file in the folder still starts the skipped job', async () => {
        const dir = fs.mkdtempSync('/tmp/pacemaker-bad-');
        fs.writeFileSync(dir + '/odd.yml', "name: Odd\non:\n  schedule:\n    - cron: '61 * * * *'\n  workflow_dispatch:\n");
        fs.writeFileSync(dir + '/fix.yml', "name: Fix\non:\n  schedule:\n    - cron: '25 */4 * * *'\n  workflow_dispatch:\n");
        const started = [];
        const out = await beat({ dir, now, log: () => {}, fetchRuns: async () => [], dispatch: async (f) => { started.push(f); } });
        expect(started).toEqual(['fix.yml']);
        expect(out.failed).toEqual([]);
        expect(out.rows.some((r) => r.file === 'odd.yml' && r.state === 'unreadable')).toBe(true);
    });
});
