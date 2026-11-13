// Several changes ride in one update (autonomy/release-gather.mjs). The times are the real merges of 2026-11-11.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { decideHold, num, URGENT, NOT_A_CHANGE, QUIET_MIN, MAX_HOLD_MIN } from '../autonomy/release-gather.mjs';

const T = (hhmm) => Date.parse(`2026-11-11T${hhmm}:00Z`);
const c = (hhmm, subject = 'Debtors: any debtor can be deleted (#597)') => ({ time: T(hhmm), subject });

describe('the wait', () => {
    it('a merge that just landed waits for the line to go quiet', () => {
        const d = decideHold({ event: 'push', commits: [c('10:06')], now: T('10:07') });
        expect(d.holdMin).toBe(QUIET_MIN - 1);
        expect(d.why).toMatch(/1 change\(s\) waiting/);
    });
    it('a second merge joins the same update and restarts the wait', () => {
        const d = decideHold({ event: 'push', commits: [c('10:06'), c('10:24'), c('10:25')], now: T('10:25') });
        expect(d.holdMin).toBe(QUIET_MIN);
        expect(d.waiting).toBe(3);
    });
    it('once the line has been quiet long enough, it releases', () => {
        expect(decideHold({ event: 'schedule', commits: [c('10:06'), c('10:25')], now: T('11:10') }).holdMin).toBe(0);
    });
    it('never holds longer than the cap after the OLDEST waiting change', () => {
        // merges every 30 minutes would otherwise postpone the update for ever
        const commits = [c('15:07'), c('15:34'), c('16:05'), c('16:35'), c('17:00')];
        expect(decideHold({ event: 'push', commits, now: T('17:00') }).holdMin).toBe(7);          // 15:07 + 120 min = 17:07
        const late = decideHold({ event: 'push', commits: [...commits, c('17:08')], now: T('17:08') });
        expect(late.holdMin).toBe(0);
        expect(late.why).toMatch(/longest a change is ever held/);
        expect(MAX_HOLD_MIN).toBeLessThanOrEqual(180);                                             // a fix reaches the owner the same day
    });
    it('the scheduled run and the pacemaker follow the same rule, so they cannot cut the wait short', () => {
        expect(decideHold({ event: 'schedule', commits: [c('12:00')], now: T('12:01') }).holdMin).toBe(QUIET_MIN - 1);
        expect(decideHold({ event: 'workflow_dispatch', manual: false, commits: [c('12:00')], now: T('12:01') }).holdMin).toBe(QUIET_MIN - 1);
    });
});

describe('what is never held', () => {
    it('an urgent change: a hotfix, a security fix, a crash fix, a rollback', () => {
        for (const s of ['Hotfix: publish-layout finds the app\'s firebaseConfig (#586)', 'Security updates: bump firebase-admin', 'fix: the dashboard crashes on an empty month', 'Revert "CSP phase 2"', 'Rollback to v7.69.80', 'Patch CVE-2026-1234 in the parser']) {
            const d = decideHold({ event: 'push', commits: [c('10:00'), { time: T('10:05'), subject: s }], now: T('10:05') });
            expect(d.holdMin, s).toBe(0);
            expect(d.why).toMatch(/urgent/);
        }
    });
    it('words that only look urgent do not count', () => {
        for (const s of ['Statement reader: secure the row order', 'Cards: the reverted balance column is shown', 'Scrambled text is read']) expect(URGENT.test(s), s).toBe(false);
        expect(URGENT.test('CSP phase 2, step 4: script-src no longer allows unsafe-inline')).toBe(false);
    });
    it('a release a person starts by hand', () => {
        expect(decideHold({ event: 'workflow_dispatch', manual: true, commits: [c('10:00')], now: T('10:01') })).toMatchObject({ holdMin: 0, why: 'started by hand, so it releases now' });
    });
    it('nothing waiting, or only the release stamp and the merchant refresh', () => {
        expect(decideHold({ event: 'push', commits: [], now: T('10:00') }).holdMin).toBe(0);
        const d = decideHold({ event: 'push', commits: [c('10:00', 'release: v7.69.88 — automatic release'), c('10:01', 'chore(merchants): auto-expand + verify merchant list [skip ci]')], now: T('10:01') });
        expect(d).toMatchObject({ holdMin: 0, waiting: 0 });
        expect(NOT_A_CHANGE.test('release: v1')).toBe(true);
    });
    it('gathering can be switched off with a quiet time of 0', () => {
        expect(decideHold({ event: 'push', commits: [c('10:00')], now: T('10:00'), quietMin: 0 }).holdMin).toBe(0);
    });
    it('an unset setting is the default, not zero (an empty variable must not switch gathering off)', () => {
        expect(num('', 45)).toBe(45);
        expect(num(undefined, 45)).toBe(45);
        expect(num('30', 45)).toBe(30);
        expect(num('0', 45)).toBe(0);
        expect(num('abc', 45)).toBe(45);
        expect(num('-5', 45)).toBe(45);
    });
    it('a commit with no readable time is ignored, not waited for', () => {
        expect(decideHold({ event: 'push', commits: [{ subject: 'x', time: NaN }], now: T('10:00') }).waiting).toBe(0);
    });
});

describe('yesterday, replayed', () => {
    // The merges of 2026-11-11 that each cut their own release.
    const merges = ['10:06', '10:24', '10:25', '11:36', '15:07', '15:34', '16:21', '16:39', '17:14'];
    it('nine releases become four', () => {
        let releases = 0, waiting = [];
        const fire = () => { releases++; waiting = []; };
        for (let m = T('10:00'); m <= T('20:00'); m += 60000) {
            const landed = merges.filter((x) => T(x) === m);
            for (const x of landed) waiting.push(c(x));
            if (!waiting.length) continue;
            if (decideHold({ event: 'push', commits: waiting, now: m }).holdMin === 0) fire();
        }
        expect(releases).toBe(4);
    });
});

describe('the workflow uses it the way the rule says', () => {
    const wf = fs.readFileSync('.github/workflows/auto-release.yml', 'utf8');
    it('has a gather job whose older waiting run ends green when a newer run takes over (never cancelled: a cancelled run is a red cross in the commit list)', () => {
        expect(wf).toMatch(/^  gather:\s*$/m);
        const gather = wf.slice(wf.indexOf('\n  gather:'), wf.indexOf('\n  release:'));
        expect(gather).not.toMatch(/concurrency:/);
        expect(gather).not.toMatch(/cancel-in-progress: true/);
        expect(gather).toMatch(/node autonomy\/release-gather\.mjs/);
        expect(gather).toMatch(/node autonomy\/gather-wait\.mjs "\$SECS"/);
        expect(gather).toMatch(/superseded: \$\{\{ steps\.wait\.outputs\.superseded \}\}/);
        expect(wf).toMatch(/^  actions: read\s/m);                                  // to see the newer run
    });
    it('the release job waits for it, still runs if the timer itself broke, and never runs when a newer run took over', () => {
        const release = wf.slice(wf.indexOf('\n  release:'));
        expect(release).toMatch(/needs: gather/);
        expect(release).toMatch(/needs\.gather\.result == 'success' \|\| needs\.gather\.result == 'failure'/);
        expect(release).toMatch(/needs\.gather\.outputs\.superseded != 'true'/);
        expect(release).toMatch(/group: wealthflow-main-push/);                // the push lock is on the job that pushes, not on the wait
        expect(release).toMatch(/cancel-in-progress: false/);
    });
    it('the wait is not inside the lock that every workflow pushing to main shares', () => {
        const head = wf.slice(0, wf.indexOf('\njobs:'));
        expect(head).not.toMatch(/^concurrency:/m);
    });
    it('the pacemaker can start it without forcing a release', () => {
        expect(wf).toMatch(/^      auto:\s*$/m);
        expect(wf).toMatch(/inputs\.auto/);
    });
});
