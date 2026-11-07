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
