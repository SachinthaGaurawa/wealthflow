/* =============================================================================
 * test/notifications_bug_test.js  —  issues #70 and #71
 * -----------------------------------------------------------------------------
 * #71 is the owner's highest-severity report: "Notifications have a bug. This
 * is a critical issue. Very critical". #70 says the same thing more quietly.
 * Neither names a symptom and both screenshots live in Firestore, so these
 * tests target the two defects found by reading the module — each of which
 * produces exactly what a user would call "the notifications are broken".
 *
 * 1. SILENT STORAGE FAILURE
 *    saveSeen() and savePushed() swallowed every error with `catch (_) {}`.
 *    The owner's diagnostic shows ~2,580 KB of localStorage and 496 tombstones
 *    on an installed iOS PWA — well inside QuotaExceededError territory. When
 *    savePushed throws, nothing is recorded as pushed, so the SAME overdue
 *    cheque re-fires a device notification on the next refresh(), which runs on
 *    a 250 ms debounce off every data change. That is an alert loop.
 *
 * 2. AN ACCIDENTAL TAP DISMISSED OVERDUE MONEY
 *    openPanel() marked every notification seen the instant the bell was
 *    tapped — before anything was read, whether or not the panel was visible.
 *    An overdue cheque alert was gone forever after one stray tap.
 *
 * These drive the REAL module through window.WFNotif against a fake DOM, rather
 * than asserting on source text: "the source no longer contains X" and "the
 * badge still shows the overdue cheque" are different claims and only the
 * second is what the owner experiences.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-notifications.js'), 'utf8');

const iso = (offsetDays) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
};

/**
 * Load the real IIFE into a fake window.
 *
 * `new Function` rather than `import`: an ESM import is cached, so the module
 * would run once and every later test would inherit the first test's
 * localStorage. Same reasoning as test/update_ui_truth_test.js.
 */
function load({ cheques = [], storageThrows = false, pushGranted = false } = {}) {
    const store = new Map();
    const warnings = [];
    const notifications = [];

    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => {
            if (storageThrows) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
            store.set(k, String(v));
        },
        removeItem: (k) => store.delete(k),
    };

    const el = () => {
        const attrs = {};
        const e = {
            style: {}, dataset: {}, innerHTML: '', textContent: '', className: '',
            value: '', checked: false, children: [], childNodes: [], parentNode: null,
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            getAttribute: (k) => (k in attrs ? attrs[k] : null),
            setAttribute: (k, v) => { attrs[k] = String(v); },
            hasAttribute: (k) => k in attrs,
            removeAttribute: (k) => { delete attrs[k]; },
            appendChild: (c) => c, insertBefore: (c) => c, removeChild: (c) => c, remove() {},
            addEventListener() {}, removeEventListener() {}, insertAdjacentHTML() {},
            querySelector: () => null, querySelectorAll: () => [],
            matches: () => false, closest: () => null, contains: () => false,
            focus() {}, blur() {}, click() {}, scrollIntoView() {},
        };
        return e;
    };
    const nodes = new Map();
    const byId = (id) => { if (!nodes.has(id)) nodes.set(id, el()); return nodes.get(id); };

    const document = {
        readyState: 'complete',
        body: el(), head: el(), documentElement: el(),
        getElementById: byId,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => el(),
        addEventListener() {}, removeEventListener() {},
    };

    function Notification(title, opts) { notifications.push({ title, body: opts && opts.body }); }
    Notification.permission = pushGranted ? 'granted' : 'default';
    Notification.requestPermission = () => Promise.resolve('granted');

    const win = {
        localStorage, document,
        // settings() reads window.DB.getObj('settings'), NOT localStorage. An
        // earlier draft of this harness only stubbed .get, so canPush() was
        // always false and both push tests passed while firing nothing — the
        // exact vacuous pass this suite exists to prevent.
        DB: {
            get: (k) => (k === 'cheques' ? cheques : []),
            getObj: (k, d) => (k === 'settings' ? { notif: { push: pushGranted } } : (d || {})),
        },
        Notification,
        notify: (m, t) => warnings.push({ m, t }),
        console: { ...console, warn: (...a) => warnings.push({ m: a.join(' '), t: 'console' }) },
        addEventListener() {}, removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (f) => f(),
        location: { origin: 'https://wf.app' },
        navigator: { userAgent: 'test', serviceWorker: undefined },
        showPage() {},
    };
    win.window = win;

    new Function('window', 'document', 'localStorage', 'Notification', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'navigator', 'location', SRC)(
        win, document, localStorage, Notification, setTimeout, clearTimeout, setInterval, clearInterval, win.console, win.navigator, win.location,
    );

    return { api: win.WFNotif, win, store, warnings, notifications };
}

/** An overdue cheque — sev 'urgent'. */
const overdue = [{ id: 'C1', status: 'pending', release: iso(-5), party: 'Acme', amount: 50000, type: 'issued' }];
/** A cheque releasing in three days — sev 'warning'. */
const soon = [{ id: 'C2', status: 'pending', release: iso(3), party: 'Beta', amount: 20000, type: 'received' }];

describe('the module loads and actually produces notifications', () => {
    it('computes an urgent item for an overdue cheque (guards a vacuous suite)', () => {
        const { api } = load({ cheques: overdue });
        expect(api, 'WFNotif did not initialise').toBeTruthy();
        const list = api.compute();
        expect(list).toHaveLength(1);
        expect(list[0].sev).toBe('urgent');
        expect(list[0].id).toBe('chq:C1');
    });

    it('computes a warning item for a cheque due soon', () => {
        const { api } = load({ cheques: soon });
        expect(api.compute()[0].sev).toBe('warning');
    });
});

describe('an accidental tap must not dismiss overdue money (#71)', () => {
    it('opening the panel leaves an OVERDUE item on the badge', () => {
        const { api } = load({ cheques: overdue });
        api.refresh();
        expect(api._count(), 'the overdue cheque should be counted before opening').toBe(1);

        api.openPanel();

        // The whole point. Before this fix the count was 0 here, permanently.
        expect(api._count(), 'opening the panel silently dismissed an overdue payment').toBe(1);
    });

    it('opening the panel DOES clear a non-urgent item', () => {
        // Not a blanket "never mark seen" — that would make the badge useless.
        const { api } = load({ cheques: soon });
        api.refresh();
        expect(api._count()).toBe(1);
        api.openPanel();
        expect(api._count()).toBe(0);
    });

    it('tapping the row dismisses the overdue item — the deliberate act', () => {
        const { api } = load({ cheques: overdue });
        api.refresh();
        api.openPanel();
        expect(api._count()).toBe(1);
        api._click(0);
        expect(api._count()).toBe(0);
    });

    it('"Mark all read" dismisses it too', () => {
        const { api } = load({ cheques: overdue });
        api.refresh();
        api.openPanel();
        api.markAllRead();
        expect(api._count()).toBe(0);
    });

    it('the dismissal survives a reload', () => {
        // Guards the other direction: this must not become "urgent can never be
        // cleared", which would be its own bug.
        const { api, store } = load({ cheques: overdue });
        api.refresh();
        api.markAllRead();
        const persisted = JSON.parse(store.get('wf2_notif_seen') || '{}');
        expect(persisted['chq:C1']).toBe(true);
    });
});

describe('a full device storage is reported, not swallowed (#70/#71)', () => {
    it('tells the user when it cannot remember what was read', () => {
        const { api, warnings } = load({ cheques: overdue, storageThrows: true });
        api.refresh();
        api.markAllRead();
        const shown = warnings.filter((w) => /storage is full/i.test(w.m));
        expect(shown.length, 'a failed write said nothing at all').toBeGreaterThan(0);
    });

    it('warns once, not on every single write', () => {
        // A toast per refresh would be its own bug — refresh() runs on a 250 ms
        // debounce off every data change.
        const { api, warnings } = load({ cheques: overdue, storageThrows: true });
        api.refresh(); api.markAllRead(); api.refresh(); api.markAllRead(); api.refresh();
        const toasts = warnings.filter((w) => w.t === 'warn' && /storage is full/i.test(w.m));
        expect(toasts).toHaveLength(1);
    });

    it('does NOT re-fire the same device notification when the dedup record cannot be saved', () => {
        // The alert loop. With savePushed() throwing, pushedMap() comes back
        // empty every time, so without the in-memory guard this overdue cheque
        // would alert on every refresh.
        const { api, notifications } = load({ cheques: overdue, storageThrows: true, pushGranted: true });
        api.refresh();
        api.refresh();
        api.refresh();
        // Exactly one, not "at most one": `toBeLessThanOrEqual` would also pass
        // against a harness that fires nothing at all, which is how the first
        // draft of this test passed while proving nothing.
        expect(notifications.length, `fired ${notifications.length} device notifications for one cheque`).toBe(1);
    });

    it('still pushes once when storage works, so the guard is not just muting everything', () => {
        const { api, notifications } = load({ cheques: overdue, pushGranted: true });
        api.refresh();
        api.refresh();
        expect(notifications).toHaveLength(1);
    });
});
