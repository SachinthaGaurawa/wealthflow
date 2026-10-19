/* =============================================================================
 * test/settings_behaviour_test.js — a switch must change what the app does
 * -----------------------------------------------------------------------------
 * The browser proof for every control is test/e2e/settings-effects.mjs. These
 * are the fast, always-on halves of the rules that audit fixed, run against the
 * SHIPPED source (functions are cut out of index.html and the notifications
 * module is loaded as the page loads it), so a refactor that drops one fails
 * here in milliseconds rather than in a browser job.
 *
 *   1. "Week Starts On" was dead. It now decides the day the weekly backup runs.
 *   2. "Hide Sensitive Numbers" has two names in stored data (privacyMode and an
 *      older hideSensitive). Switching it off cleared only the one that was
 *      clicked, so on an account carrying the other name it went on hiding.
 *   3. The bell answered only to its own nine switches; "All Notifications",
 *      "Loan Payment Reminders", "CC One-Time Deadline Alerts" and "Cheque
 *      Release Reminders" turned off the toasts and left the bell counting.
 *   4. Tapping one of the bell's nine switches wrote all nine (the defaults
 *      filled in for the eight not touched), so per-switch sync could no longer
 *      tell which one the person chose, and a device that never opened the card
 *      overruled the other device on the other eight.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const NOTIF_SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-notifications.js'), 'utf8');

function blockAt(marker) {
    const start = HTML.indexOf(marker);
    expect(start, `"${marker}" is gone from index.html — retarget this test`).toBeGreaterThan(-1);
    let j = HTML.indexOf('{', start), depth = 0, q = null;
    for (; j < HTML.length; j++) {
        const c = HTML[j];
        if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && HTML[j + 1] === '/') { j = HTML.indexOf('\n', j); continue; }
        if (c === '/' && HTML[j + 1] === '*') { j = HTML.indexOf('*/', j) + 1; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return HTML.slice(start, j + 1); }
    }
    throw new Error('unbalanced block at ' + marker);
}

/** A settings store that behaves like DB: getObj returns the stored object, set replaces it. */
function makeDB(initial = {}) {
    const store = { settings: JSON.parse(JSON.stringify(initial)) };
    const writes = [];
    return {
        store, writes,
        getObj: (k, d) => (store[k] !== undefined ? store[k] : d),
        set: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); writes.push([k, JSON.parse(JSON.stringify(v))]); },
    };
}

describe('Week Starts On decides the weekly backup day', () => {
    function loadSchedule(weekStart) {
        const DB = makeDB(weekStart ? { weekStart } : {});
        const src = blockAt('function _weekStartDay()') + '\n' + blockAt('function _nextScheduledBackupTime(freq, fromDate)') + '\nreturn _nextScheduledBackupTime;';
        return new Function('DB', 'window', src)(DB, {});
    }
    // Wednesday 7 Oct 2026, 10:00
    const wed = new Date(2026, 9, 7, 10, 0, 0);

    it('a Monday-start week ends on Sunday (as the backup always ran)', () => {
        const next = loadSchedule('monday')('weekly', wed);
        expect(next.getDay()).toBe(0);
        expect([next.getHours(), next.getMinutes()]).toEqual([23, 55]);
    });

    it('a Sunday-start week ends on Saturday', () => {
        expect(loadSchedule('sunday')('weekly', wed).getDay()).toBe(6);
    });

    it('with nothing chosen it keeps the Monday-start behaviour', () => {
        expect(loadSchedule(undefined)('weekly', wed).getDay()).toBe(0);
    });

    it('the day of the week never lands in the past, including on the last day itself after 23:55', () => {
        const sunLate = new Date(2026, 9, 11, 23, 56, 0);   // Sunday, after the slot
        const next = loadSchedule('monday')('weekly', sunLate);
        expect(next.getTime()).toBeGreaterThan(sunLate.getTime());
        expect(next.getDay()).toBe(0);
        expect(Math.round((next - sunLate) / 86400000)).toBe(7);
    });

    it('daily and monthly are untouched by the week setting', () => {
        const a = loadSchedule('sunday'); const b = loadSchedule('monday');
        expect(a('daily', wed).getTime()).toBe(b('daily', wed).getTime());
        expect(a('monthly', wed).getTime()).toBe(b('monthly', wed).getTime());
        expect(a('off', wed)).toBeNull();
    });
});

describe('Hide Sensitive Numbers: one switch, two stored names', () => {
    function toggle(initial, key, val) {
        const DB = makeDB(initial);
        const notes = [];
        const body = blockAt('function toggleSetting(key, val, sourceEl)');
        const fn = new Function('DB', 'document', 'window', 'triggerHaptic', 'notify', '_applyDisplaySettings', '_weekStartDay', 'scheduleAutoBackup', 'renderPage', body + '\nreturn toggleSetting;')(
            DB,
            { querySelectorAll: () => [], querySelector: () => null, body: { classList: { toggle() {} } } },
            { event: null },
            () => {}, (m) => notes.push(m), () => {}, () => 1, () => {}, () => {},
        );
        fn(key, val, null);
        return DB.store.settings;
    }

    it('switching it OFF clears both names, even when the stored data carries the older one only', () => {
        const s = toggle({ hideSensitive: true }, 'privacyMode', false);
        expect(s.privacyMode).toBe(false);
        expect(s.hideSensitive).toBe(false);
    });

    it('switching it ON sets both names and turns Round Display Amounts off', () => {
        const s = toggle({ roundAmounts: true }, 'privacyMode', true);
        expect(s.privacyMode).toBe(true);
        expect(s.hideSensitive).toBe(true);
        expect(s.roundAmounts).toBe(false);
    });

    it('turning Round Display Amounts on turns both hide names off', () => {
        const s = toggle({ privacyMode: true, hideSensitive: true }, 'roundAmounts', true);
        expect(s.roundAmounts).toBe(true);
        expect(s.privacyMode).toBe(false);
        expect(s.hideSensitive).toBe(false);
    });

    it('the display code hides amounts on EITHER name, and the switch draws from either', () => {
        const render = blockAt('function renderSettings()');
        expect(render).toMatch(/settingSwitch\('privacyMode',\s*!!\(s\.privacyMode \|\| s\.hideSensitive\)/);
    });
});

describe('the bell answers to both sets of switches', () => {
    const iso = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.toISOString().slice(0, 10); };

    function load(settings = {}, { cheques = [], cconetime = [], loans = [] } = {}) {
        const DB = makeDB(settings);
        const arr = { cheques, cconetime, loans };
        DB.get = (k) => arr[k] || [];
        const attrs = () => {
            const a = {};
            return {
                style: {}, dataset: {}, innerHTML: '', textContent: '', className: '', value: '',
                classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
                getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, removeAttribute() {}, hasAttribute: (k) => k in a,
                appendChild: (c) => c, insertBefore: (c) => c, removeChild: (c) => c, remove() {}, addEventListener() {}, removeEventListener() {},
                querySelector: () => null, querySelectorAll: () => [], matches: () => false, closest: () => null, contains: () => false, focus() {}, blur() {}, click() {},
            };
        };
        const nodes = new Map();
        const byId = (id) => { if (!nodes.has(id)) nodes.set(id, attrs()); return nodes.get(id); };
        const store = new Map();
        const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
        const document = { readyState: 'complete', body: attrs(), head: attrs(), documentElement: attrs(), getElementById: byId, querySelector: () => null, querySelectorAll: () => [], createElement: () => attrs(), addEventListener() {}, removeEventListener() {} };
        function Notification() {}
        Notification.permission = 'default';
        const win = {
            localStorage, document, DB, Notification, notify() {}, console,
            addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
            setTimeout, clearTimeout, setInterval: () => 0, clearInterval, requestAnimationFrame: (f) => f(), location: { origin: 'https://wf.app' },
            navigator: { userAgent: 'test' }, showPage() {},
        };
        win.window = win;
        // the two page functions the loan section asks for: a loan that is still running and is due in this calendar month
        const ym = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); })();
        win.loanEndDate = () => new Date(Date.now() + 365 * 86400000);
        win._loanInstallmentMonths = () => [{ key: ym }];
        new Function('window', 'document', 'localStorage', 'Notification', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'navigator', 'location', NOTIF_SRC)(
            win, document, localStorage, Notification, setTimeout, clearTimeout, () => 0, clearInterval, console, win.navigator, win.location,
        );
        return { api: win.WFNotif, DB };
    }

    const data = () => ({
        cheques: [{ id: 'c1', status: 'pending', release: iso(1), party: 'Probe', amount: 1000, number: '1' }],
        cconetime: [{ id: 'o1', desc: 'Probe charge', amount: 500, deadline: iso(1), paid: false }],
        loans: [{ id: 'l1', name: 'Probe loan', amount: 120000, rate: 10, duration: 12, monthly: 10500, start: iso(-27), payDay: new Date(Date.now() + 86400000).getDate() }],
    });
    const cats = (api) => [...new Set(api.compute().map((n) => n.cat))].sort();

    it('with every switch on it lists all three kinds (so the cases below prove something)', () => {
        const kinds = cats(load({}, data()).api).join(',');
        expect(kinds).toMatch(/Cheque/);
        expect(kinds).toMatch(/Card payment/);
        expect(kinds).toMatch(/Loan/);
    });

    it('All Notifications off empties the bell', () => {
        expect(load({ notifications: false }, data()).api.compute()).toEqual([]);
    });

    it('Cheque Release Reminders off removes cheques and nothing else', () => {
        const kinds = cats(load({ notifCheque: false }, data()).api).join(',');
        expect(kinds).not.toMatch(/Cheque/);
        expect(kinds).toMatch(/Card payment/);
    });

    it('CC One-Time Deadline Alerts off removes card charges and nothing else', () => {
        const kinds = cats(load({ notifCCOT: false }, data()).api).join(',');
        expect(kinds).not.toMatch(/Card payment/);
        expect(kinds).toMatch(/Cheque/);
    });

    it('Loan Payment Reminders off removes loan instalments', () => {
        const on = load({}, data()).api.compute().filter((n) => /Loan/.test(n.cat)).length;
        const off = load({ notifLoan: false }, data()).api.compute().filter((n) => /Loan/.test(n.cat)).length;
        expect(on).toBeGreaterThan(0);
        expect(off).toBe(0);
    });

    it('the newer per-kind switch still works, and both must be on', () => {
        expect(cats(load({ notif: { cheques: false } }, data()).api).join(',')).not.toMatch(/Cheque/);
        expect(load({ notif: { enabled: false } }, data()).api.compute()).toEqual([]);
        expect(cats(load({ notifCheque: false, notif: { cheques: true } }, data()).api).join(',')).not.toMatch(/Cheque/);
    });

    it('tapping one of the nine switches stores that one switch only', () => {
        const { api, DB } = load({}, data());
        api.toggleSetting('cheques');
        const written = DB.writes.filter(([k]) => k === 'settings');
        expect(written).toHaveLength(1);
        expect(written[0][1].notif).toEqual({ cheques: false });
    });

    it('a second tap adds its own switch and keeps the first, still without the defaults', () => {
        const { api, DB } = load({}, data());
        api.toggleSetting('cheques');
        api.toggleSetting('urgent');
        expect(DB.store.settings.notif).toEqual({ cheques: false, urgent: false });
    });

    it('a switch set back to its default is still stored (a choice that must beat an older opposite choice)', () => {
        const { api, DB } = load({ notif: { cheques: false } }, data());
        api.toggleSetting('cheques');
        expect(DB.store.settings.notif).toEqual({ cheques: true });
    });
});

describe('the Settings page rebuilds without moving', () => {
    const render = blockAt('function renderSettings()');

    it('keeps the page height and scroll position across the rebuild and gives the height back afterwards', () => {
        expect(render).toMatch(/_stHost\.style\.minHeight = _stH \+ 'px'/);
        expect(render).toMatch(/window\.scrollTo\(0, _stY\)/);
        expect(render).toMatch(/_stHost\.style\.minHeight = ''/);
    });

    it('fills the cards other modules own in the same task, not on a later timer', () => {
        expect(render).toMatch(/WFNotif\.mountSettings\(\)/);
        expect(render).toMatch(/wfIntelPanel\.inject\(\)/);
        expect(render).toMatch(/wfReleaseApprove\._inject\(\)/);
        expect(NOTIF_SRC).toMatch(/wrap\('renderSettings', function \(\) \{ buildSettingsCard\(\); \}\)/);
        expect(NOTIF_SRC).not.toMatch(/setTimeout\(buildSettingsCard/);
    });

    it('the cloud status pill is one box in all three states and never loses its colour', () => {
        const status = blockAt('function setSyncStatus(state)');
        const classes = [...status.matchAll(/setBadge\.className = '([^']+)'/g)].map((m) => m[1]);
        expect(classes).toHaveLength(3);
        for (const c of classes) expect(c).toMatch(/^badge bg-[a-z]+ wf-sync-badge$/);
        expect(status).not.toMatch(/'badge syncing'/);
        expect(render).toMatch(/id="settingsCloudStatus" class="badge wf-sync-badge /);
        const css = fs.readFileSync(path.join(ROOT, 'wf-ui.css'), 'utf8');
        expect(css).toMatch(/\.wf-sync-badge\s*\{[^}]*min-width:\s*\d+px/);
    });

    it('a theme swap pauses animations instead of removing them (removing them replays every entrance animation)', () => {
        const rule = HTML.match(/html\.wf-theme-switching \*,[\s\S]*?\{([^}]*)\}/);
        expect(rule).not.toBeNull();
        expect(rule[1]).toMatch(/transition:\s*none\s*!important/);
        expect(rule[1]).toMatch(/animation-play-state:\s*paused\s*!important/);
        expect(rule[1]).not.toMatch(/animation:\s*none/);
    });
});
