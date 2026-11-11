// The rules for when an update is offered and what the person may do about it (wealthflow-update-policy.js).
// Modelled on Android in-app update priority, Play staged rollout and Apple phased release; docs/update-model-research.md has the sources.
import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';
const P = loadBrowserModule('wealthflow-update-policy.js').window.WF_UPDATE_POLICY;
const DAY = P.DAY;

describe('priority and stance', () => {
    it('an explicit priority wins, otherwise it follows what the release is', () => {
        expect(P.priorityOf('7.70.0', { priority: { '7.70.0': 4 } }, 'minor')).toBe(4);
        expect(P.priorityOf('7.70.0', { mandatory: ['7.70.0'] }, 'minor')).toBe(5);
        expect(P.priorityOf('7.70.0', {}, 'security')).toBe(4);
        expect(P.priorityOf('7.70.0', {}, 'full')).toBe(3);
        expect(P.priorityOf('7.70.0', {}, 'minor')).toBe(2);
        expect(P.priorityOf('7.70.0', { priority: { '7.70.0': 99 } }, 'minor')).toBe(5);
        expect(P.priorityOf('7.70.0', { priority: { '7.70.0': 'x' } }, 'minor')).toBe(2);
    });
    it('only the top priority stops "skip", and even then "later" is allowed for a day', () => {
        expect([0, 1, 2, 3, 4, 5].map(P.stanceOf)).toEqual(['quiet', 'quiet', 'offer', 'offer', 'urge', 'required']);
        expect(P.canSkip(4)).toBe(true);
        expect(P.canSkip(5)).toBe(false);
        expect(P.maxSnoozeDays(5)).toBe(1);
        expect(P.maxSnoozeDays(4)).toBe(3);
        expect(P.maxSnoozeDays(2)).toBe(7);
    });
});

describe('the person\'s choice', () => {
    const now = 1_000_000_000_000;
    it('later is capped by priority and expires', () => {
        const c = P.later('7.70.0', 7, 5, now);
        expect(c.days).toBe(1);
        expect(P.activeChoice(c, '7.70.0', 5, now + DAY - 1)).toBeTruthy();
        expect(P.activeChoice(c, '7.70.0', 5, now + DAY + 1)).toBe(null);
    });
    it('skip is refused for a required update and ignored if it somehow exists', () => {
        expect(P.skip('7.70.0', 5, now)).toBe(null);
        expect(P.activeChoice({ version: '7.70.0', action: 'skip' }, '7.70.0', 5, now)).toBe(null);
        expect(P.skip('7.70.0', 3, now)).toMatchObject({ action: 'skip' });
    });
    it('a choice never carries over to a newer version', () => {
        const c = P.skip('7.70.0', 3, now);
        expect(P.activeChoice(c, '7.70.1', 3, now)).toBe(null);
    });
});

describe('staged rollout', () => {
    const m = { rollout: { '7.70.0': 20 }, halted: ['7.69.99'] };
    it('a device is in when its bucket is under the share; early access devices are always first', () => {
        expect(P.inRollout('7.70.0', m, 19, false)).toBe(true);
        expect(P.inRollout('7.70.0', m, 20, false)).toBe(false);
        expect(P.inRollout('7.70.0', m, 99, true)).toBe(true);
        expect(P.inRollout('7.70.1', m, 99, false)).toBe(true);          // no entry means everyone
        expect(P.inRollout('7.70.0', { rollout: { '7.70.0': 0 } }, 0, true)).toBe(false);
    });
    it('a halted version reaches nobody, early access included', () => {
        expect(P.inRollout('7.69.99', m, 0, true)).toBe(false);
    });
    it('the bucket is random once and then stable', () => {
        expect(P.bucketOf(null, 57.9)).toBe(57);
        expect(P.bucketOf('12', 57)).toBe(12);
        expect(P.bucketOf('150', 7)).toBe(7);
        expect(P.bucketOf('abc', 400)).toBe(99);
    });
});

describe('announce: should the pill and badge show', () => {
    const base = { available: true, version: '7.70.0', manifest: {}, priority: 2, inRollout: true, choice: null, now: 5 };
    it('shows for an offered update and hides in every case the person or the release decided against', () => {
        expect(P.announce(base)).toEqual({ show: true, why: 'offer' });
        expect(P.announce({ ...base, available: false }).show).toBe(false);
        expect(P.announce({ ...base, priority: 1 })).toEqual({ show: false, why: 'quiet' });
        expect(P.announce({ ...base, inRollout: false })).toEqual({ show: false, why: 'rolling-out' });
        expect(P.announce({ ...base, manifest: { halted: ['7.70.0'] } })).toEqual({ show: false, why: 'halted' });
        expect(P.announce({ ...base, choice: P.skip('7.70.0', 2, 1) })).toEqual({ show: false, why: 'skipped' });
        expect(P.announce({ ...base, choice: P.later('7.70.0', 1, 2, 1) })).toEqual({ show: false, why: 'later' });
        expect(P.announce({ ...base, choice: P.later('7.70.0', 1, 2, 1), now: 1 + 2 * DAY })).toEqual({ show: true, why: 'offer' });
    });
    it('a required update comes back after one day even if the person postponed it for longer', () => {
        const c = P.later('7.70.0', 30, 5, 0);
        expect(P.announce({ ...base, priority: 5, choice: c, now: 2 * DAY }).show).toBe(true);
    });
});

describe('catch-up notes across skipped releases', () => {
    const notes = (items) => ({ sections: [{ title: 'What changed for you', items }, { title: 'Under the hood', items: ['internal ' + items[0]] }] });
    const all = { '7.69.1': notes(['a']), '7.69.2': notes(['b']), '7.69.3': notes(['b', 'c']), '7.70.0': notes(['d']) };
    it('lists only versions after the installed one up to the target, newest first', () => {
        expect(P.versionsBetween(all, '7.69.1', '7.69.3')).toEqual(['7.69.3', '7.69.2']);
        expect(P.versionsBetween(all, '7.69.3', '7.69.3')).toEqual([]);
    });
    it('joins sections by title, drops repeats and puts the internal section last', () => {
        const list = P.versionsBetween(all, '7.69.1', '7.70.0').map((v) => ({ version: v, notes: all[v] }));
        const m = P.mergeNotes(list);
        expect(m.count).toBe(3);
        expect(m.oldest).toBe('7.69.2');
        expect(m.newest).toBe('7.70.0');
        expect(m.sections[0].title).toBe('What changed for you');
        expect(m.sections[0].items).toEqual(['d', 'b', 'c']);
        expect(m.sections[m.sections.length - 1].title).toBe('Under the hood');
        expect(P.mergeNotes([])).toBe(null);
    });
});

describe('connection', () => {
    it('only holds back an automatic install when Wi-Fi only is on and the browser says metered', () => {
        expect(P.metered({ type: 'cellular' })).toBe(true);
        expect(P.metered({ saveData: true })).toBe(true);
        expect(P.metered({ type: 'wifi' })).toBe(false);
        expect(P.metered({})).toBe(null);
        expect(P.metered(null)).toBe(null);
        expect(P.mayInstallAutomatically(true, { type: 'cellular' })).toBe(false);
        expect(P.mayInstallAutomatically(true, null)).toBe(true);        // Safari: nothing is held back
        expect(P.mayInstallAutomatically(false, { type: 'cellular' })).toBe(true);
    });
});

describe('features that differ per device', () => {
    const prefs = (o = {}) => ({ overrides: {}, early: false, bucket: 0, ...o });
    it('the person\'s own switch beats everything', () => {
        expect(P.featureState('x', { channel: 'early', default: false }, prefs({ overrides: { x: true } }), '7.70.0')).toEqual({ on: true, why: 'your choice' });
        expect(P.featureState('x', {}, prefs({ overrides: { x: false } }), '7.70.0').on).toBe(false);
    });
    it('needs the version, the channel and a place in the staged share, in that order', () => {
        expect(P.featureState('x', { since: '7.71.0' }, prefs(), '7.70.0').on).toBe(false);
        expect(P.featureState('x', { channel: 'early' }, prefs(), '7.70.0').why).toBe('early access only');
        expect(P.featureState('x', { channel: 'early' }, prefs({ early: true }), '7.70.0').on).toBe(true);
        expect(P.featureState('x', { rollout: 0 }, prefs(), '7.70.0').on).toBe(false);
        expect(P.featureState('x', { rollout: 0 }, prefs({ early: true }), '7.70.0').on).toBe(true);
        expect(P.featureState('x', { default: false }, prefs(), '7.70.0')).toEqual({ on: false, why: 'off by default' });
        expect(P.featureState('x', undefined, prefs(), '7.70.0').on).toBe(true);
    });
    it('different features land on different devices at the same share, so one device is not always the guinea pig', () => {
        const ids = Array.from({ length: 40 }, (_, i) => 'f' + i);
        const on = ids.filter((id) => P.featureState(id, { rollout: 50 }, prefs({ bucket: 10 }), '7.70.0').on);
        expect(on.length).toBeGreaterThan(5);
        expect(on.length).toBeLessThan(35);
    });
});

describe('history', () => {
    it('keeps the newest entries only', () => {
        let h = [];
        for (let i = 0; i < 35; i++) h = P.pushHistory(h, { i }, 30);
        expect(h.length).toBe(30);
        expect(h[0].i).toBe(5);
        expect(P.pushHistory('junk', { i: 1 }).length).toBe(1);
    });
});

describe('one account, several devices', () => {
    const NOW = 1_800_000_000_000;
    const man = (latest, extra = {}) => ({ latest, ...extra });

    it('a device that installs on purpose moves the account up; a lower or equal version does not move it back', () => {
        const a = P.reportDevice({}, 'dev_phone', '7.70.1', 'Safari on iPhone', NOW, true);
        expect(P.parseWanted(a.wanted)).toEqual({ v: '7.70.1', by: 'dev_phone', at: NOW });
        // another device installs an OLDER build (a rollback): the account does not go backwards
        const b = P.reportDevice(a, 'dev_pc', '7.70.0', 'Chrome on Windows', NOW + 5, true);
        expect(P.parseWanted(b.wanted).v).toBe('7.70.1');
        // the same version again changes nothing about who set it
        const c = P.reportDevice(b, 'dev_pc', '7.70.1', 'Chrome on Windows', NOW + 9, true);
        expect(P.parseWanted(c.wanted)).toEqual({ v: '7.70.1', by: 'dev_phone', at: NOW });
    });
    it('a device that only reports what it runs (a reload, an early-access phone) never moves the account', () => {
        const a = P.reportDevice({}, 'dev_x', '7.71.0', 'Chrome on Android', NOW, false);
        expect(a.wanted).toBeUndefined();
        expect(P.parseDevice(a.devices.dev_x).v).toBe('7.71.0');
    });
    it('an unchanged report hands back the same object, so nothing is written; a 12 hour beat refreshes "last seen"', () => {
        const a = P.reportDevice({}, 'dev_a', '7.70.1', 'Chrome on Mac', NOW, true);
        expect(P.reportDevice(a, 'dev_a', '7.70.1', 'Chrome on Mac', NOW + 3600000, false)).toBe(a);
        const b = P.reportDevice(a, 'dev_a', '7.70.1', 'Chrome on Mac', NOW + 13 * 3600000, false);
        expect(b).not.toBe(a);
        expect(P.parseDevice(b.devices.dev_a).at).toBe(NOW + 13 * 3600000);
    });
    it('garbage in is ignored, never thrown on', () => {
        expect(P.reportDevice(null, '', '7.70.1', 'x', NOW, true)).toBe(null);
        expect(P.reportDevice({}, 'd', 'not-a-version', 'x', NOW, true)).toEqual({});
        expect(P.parseDevice(42)).toBe(null);
        expect(P.parseWanted('7.70.1||5')).toBe(null);
        expect(P.followDecision('nonsense', 'd', '7.70.0', man('7.70.1'), { now: NOW }).act).toBe('none');
        expect(P.deviceList(undefined, 'd', NOW)).toEqual([]);
    });
    it('the label comes from what the browser says, with no guess about phone or laptop', () => {
        expect(P.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
        expect(P.deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36')).toBe('Chrome on Android');
        expect(P.deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0')).toBe('Edge on Windows');
        expect(P.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1')).toBe('Chrome on iPhone');
        expect(P.deviceLabel('')).toBe('This device');
    });

    const synced = P.reportDevice({}, 'dev_phone', '7.70.1', 'Safari on iPhone', NOW, true);
    it('if the account has a newer version than this device runs, this device installs what the server offers now', () => {
        const d = P.followDecision(synced, 'dev_pc', '7.70.0', man('7.70.1'), { now: NOW + 1000 });
        expect(d).toMatchObject({ act: 'install', version: '7.70.1', account: '7.70.1', from: { id: 'dev_phone', name: 'Safari on iPhone' } });
        // the server has moved on since: the same-or-newer build is the target
        expect(P.followDecision(synced, 'dev_pc', '7.70.0', man('7.70.3'), { now: NOW + 1000 }).version).toBe('7.70.3');
    });
    it('it does nothing when it is already there, when it set the version itself, when the server no longer offers it, or when it is old news', () => {
        const f = (id, run, m, o) => P.followDecision(synced, id, run, m, { now: NOW + 1000, ...o });
        expect(f('dev_pc', '7.70.1', man('7.70.1')).why).toBe('current');
        expect(f('dev_pc', '7.71.0', man('7.71.0')).why).toBe('current');
        expect(f('dev_phone', '7.70.0', man('7.70.1')).why).toBe('self');
        expect(f('dev_pc', '7.70.0', man('7.69.68')).why).toBe('not-deployed');
        expect(f('dev_pc', '7.70.0', man('7.70.1', { halted: ['7.70.1'] })).why).toBe('halted');
        expect(f('dev_pc', '7.70.0', man('7.70.1'), { now: NOW + 61 * DAY }).why).toBe('stale');
        expect(f('dev_pc', '7.70.0', man('7.70.1'), { on: false }).why).toBe('off');
        expect(P.followDecision({}, 'dev_pc', '7.70.0', man('7.70.1'), { now: NOW }).why).toBe('no-target');
    });
    it('the person\'s own skip or postponement of that version on THIS device is respected, a required update cannot be skipped', () => {
        const skip = { version: '7.70.1', action: 'skip', at: NOW };
        const later = { version: '7.70.1', action: 'later', until: NOW + DAY, at: NOW };
        const idle = { version: '7.70.1', action: 'idle', at: NOW };
        expect(P.followDecision(synced, 'dev_pc', '7.70.0', man('7.70.1'), { now: NOW + 1000, choice: skip }).why).toBe('skipped');
        expect(P.followDecision(synced, 'dev_pc', '7.70.0', man('7.70.1'), { now: NOW + 1000, choice: later }).why).toBe('later');
        expect(P.followDecision(synced, 'dev_pc', '7.70.0', man('7.70.1'), { now: NOW + DAY + 1, choice: later }).act).toBe('install');
        expect(P.followDecision(synced, 'dev_pc', '7.70.0', man('7.70.1'), { now: NOW + 1000, choice: idle }).act).toBe('install');
        expect(P.followDecision(synced, 'dev_pc', '7.70.0', man('7.70.1', { mandatory: ['7.70.1'] }), { now: NOW + 1000, choice: skip }).act).toBe('install');
        // a skip made for an older version says nothing about this one
        expect(P.followDecision(synced, 'dev_pc', '7.70.0', man('7.70.1'), { now: NOW + 1000, choice: { ...skip, version: '7.69.99' } }).act).toBe('install');
    });
    it('the rollout share does not hold a device back once the person has taken the version on another one', () => {
        const m = man('7.70.1', { rollout: { '7.70.1': 5 } });
        expect(P.followDecision(synced, 'dev_pc', '7.70.0', m, { now: NOW + 1000 }).act).toBe('install');
    });
    it('the agreement accepted on one device counts on the others, once per minor line', () => {
        const a = P.noteAgreed(synced, '7.70', NOW);
        expect(P.agreedOn(a, '7.70')).toBe(true);
        expect(P.agreedOn(a, '7.71')).toBe(false);
        expect(P.noteAgreed(a, '7.70', NOW + 99)).toBe(a);
        expect(P.noteAgreed(synced, 'garbage', NOW)).toBe(synced);
        expect(P.parseWanted(a.wanted).v).toBe('7.70.1');
    });
    it('the list puts this device first, marks the ones behind, tells twins apart and drops devices unseen for 90 days', () => {
        let s = P.reportDevice({}, 'dev_aaa111', '7.70.1', 'Chrome on Windows', NOW, true);
        s = P.reportDevice(s, 'dev_bbb222', '7.70.0', 'Chrome on Windows', NOW - 1000, false);
        s = P.reportDevice(s, 'dev_old000', '7.60.0', 'Safari on Mac', NOW - 100 * DAY, false);
        const l = P.deviceList(s, 'dev_bbb222', NOW);
        expect(l.map((r) => r.id)).toEqual(['dev_bbb222', 'dev_aaa111']);
        expect(l[0]).toMatchObject({ isThis: true, behind: true });
        expect(l[1].behind).toBe(false);
        expect(l[0].name).not.toBe(l[1].name);
    });
    it('the record stays small: past 16 devices the longest-silent are blanked, never the one reporting', () => {
        let s = {};
        for (let i = 0; i < 20; i++) s = P.reportDevice(s, 'dev_' + String(i).padStart(3, '0'), '7.70.0', 'Chrome on Mac', NOW + i * 1000, false);
        const live = Object.keys(s.devices).filter((k) => s.devices[k] !== '');
        expect(live.length).toBe(16);
        expect(s.devices.dev_019).not.toBe('');
        expect(s.devices.dev_000).toBe('');
    });
});
