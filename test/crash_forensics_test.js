// =============================================================================
// WealthFlow Shadow Test Harness — Crash Forensics (issue #54)
// =============================================================================
// Two things sat in the diagnostics attached to #46, on a real device: 19
// crashes, and "Script https://…/sw.js load failed". Neither was reported by the
// user — they reported a button. Both were in the app's own logs, and the only
// reason anyone saw them is that a checkbox happened to be ticked while filing
// something unrelated.
//
// The service-worker failure was CAUGHT and thrown away:
//
//     catch (err) {
//         console.warn('[SW] Registration failed:', err.message);
//         return null;
//     }
//
// Detected, written to a console nobody has open on a phone, discarded — and
// `null` was returned where no caller told it apart from success. Offline
// access, install-to-home-screen, push notifications and the skipWaiting update
// path all stop working, silently.
//
// The two crash stores are the same failure one layer up. `wf_error_log` holds
// JS errors with stacks; `wf_crash_log` holds sessions killed without a clean
// exit — and an iOS renderer kill runs NO JS handler, so it can only ever appear
// in the second. Reading either one alone and calling the number "crashes" was
// wrong in both directions.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';

/** Load with a REAL backing store — a stub that always returns null would make
 *  every "nothing recorded" assertion pass for the wrong reason. */
function load(seed = {}) {
    const mem = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    const win = {
        localStorage: {
            getItem: (k) => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: (k) => mem.delete(k),
        },
    };
    new Function('window', 'console', fs.readFileSync('wealthflow-crash-forensics.js', 'utf8'))(
        win, { log() {}, warn() {}, error() {} },
    );
    return { F: win.WFCrashForensics, mem };
}

const T = 1785000000000;

describe('crash forensics: the module loaded (guards against a vacuous pass)', () => {
    it('exposes the API these tests read', () => {
        const { F } = load();
        expect(typeof F.history).toBe('function');
        expect(typeof F.summary).toBe('function');
        expect(typeof F.noteServiceWorker).toBe('function');
    });
});

describe('crash forensics: the service-worker result is a state, not a log line', () => {
    it('records a failure with its reason', () => {
        const { F } = load();
        expect(F.noteServiceWorker(false, 'Script load failed')).toBe(true);
        const s = F.serviceWorkerStatus();
        expect(s.ok).toBe(false);
        expect(s.known).toBe(true);
        expect(s.reason).toMatch(/Script load failed/);
    });

    it('names what actually stopped working', () => {
        // "Registration failed" means nothing to a user. What they lost does.
        const { F } = load();
        F.noteServiceWorker(false, 'boom');
        expect(F.serviceWorkerStatus().lost).toContain('offline access');
        expect(F.serviceWorkerStatus().lost).toContain('push notifications');
    });

    it('clears the flag when a later launch succeeds', () => {
        // A device that recovers must stop claiming it is degraded, or the
        // warning becomes furniture and nobody reads it.
        const { F } = load();
        F.noteServiceWorker(false, 'boom');
        F.noteServiceWorker(true);
        const s = F.serviceWorkerStatus();
        expect(s.ok).toBe(true);
        expect(s.lost).toEqual([]);
    });

    it('distinguishes "never recorded" from "working"', () => {
        // ok: null. Reporting an unmeasured state as healthy is the exact class
        // of false confirmation this repo keeps finding.
        const s = load().F.serviceWorkerStatus();
        expect(s.ok).toBeNull();
        expect(s.known).toBe(false);
    });

    it('reports the degraded state in words the user can act on', () => {
        const { F } = load();
        F.noteServiceWorker(false, 'Script load failed');
        const card = F.report().find((r) => r.kind === 'sw_failed');
        expect(card).toBeTruthy();
        expect(card.title).toMatch(/without offline support/);
        expect(card.body).toMatch(/Script load failed/);
    });

    it('says nothing when the worker is fine', () => {
        // Silence is the correct output for a healthy device.
        const { F } = load();
        F.noteServiceWorker(true);
        expect(F.report().find((r) => r.kind === 'sw_failed')).toBeFalsy();
    });
});

describe('crash forensics: one history from two stores', () => {
    const seeded = {
        wf_error_log: [
            { msg: "Cannot read properties of null", stack: 'at renderReports', page: 'reports', ver: '7.69.16', t: T },
            { msg: 'Another error', page: 'dash', ver: '7.69.16', t: T + 1000 },
        ],
        wf_crash_log: [
            { reason: 'unclean exit', start: T + 2000, ver: '7.69.16' },
        ],
    };

    it('reads BOTH stores, which nothing previously did', () => {
        // An iOS renderer kill can only appear in wf_crash_log; a caught
        // exception can only appear in wf_error_log. Either alone is half.
        const { F } = load(seeded);
        expect(F.history()).toHaveLength(3);
    });

    it('keeps the two sources distinguishable', () => {
        const s = load(seeded).F.summary();
        expect(s.errors).toBe(2);
        expect(s.sessions).toBe(1);
        expect(s.total).toBe(3);
    });

    it('orders newest first', () => {
        const h = load(seeded).F.history();
        expect(h[0].at).toBeGreaterThanOrEqual(h[h.length - 1].at);
    });

    it('does not double-count one event landing in both stores', () => {
        const { F } = load({
            wf_error_log: [{ msg: 'same thing', t: T }],
            wf_crash_log: [{ reason: 'same thing', start: T }],
        });
        expect(F.history()).toHaveLength(1);
    });

    it('keeps the stack traces the fix agent needs', () => {
        expect(load(seeded).F.history().find((e) => e.stack)).toBeTruthy();
    });

    it('surfaces the most common failure', () => {
        const { F } = load({ wf_error_log: [{ msg: 'X', t: 1 }, { msg: 'X', t: 2 }, { msg: 'Y', t: 3 }] });
        expect(F.summary().worst).toEqual({ message: 'X', n: 2 });
    });

    it('reports an empty device as empty, not as broken', () => {
        const { F } = load();
        expect(F.summary().total).toBe(0);
        expect(F.report()).toEqual([]);
    });
});

describe('crash forensics: it files nothing', () => {
    it('has no network path', () => {
        // Point 3 of #48/#54 — offering to report crashes — was scoped opt-in
        // and NOT authorised. An app that files issues about itself unprompted
        // is a different product from the one that was approved.
        const src = fs.readFileSync('wealthflow-crash-forensics.js', 'utf8');
        expect(src).not.toMatch(/fetch\(|XMLHttpRequest|navigator\.sendBeacon/);
    });
});

describe('crash forensics: it is actually wired in', () => {
    const html = fs.readFileSync('index.html', 'utf8');

    it('the registration path records BOTH outcomes', () => {
        expect(html).toMatch(/WFCrashForensics\.noteServiceWorker\(true\)/);
        expect(html).toMatch(/WFCrashForensics\.noteServiceWorker\(false, err2\.message\)/);
    });

    it('retries once before declaring failure', () => {
        // A transient network failure at boot otherwise costs the whole PWA
        // layer until the next launch.
        expect(html).toMatch(/Service Worker registered on retry/);
    });

    it('no longer discards the failure with only a console warning', () => {
        const fn = html.slice(html.indexOf('async function registerServiceWorker'), html.indexOf('async function requestNotificationPermission'));
        expect(fn.length).toBeGreaterThan(100);
        expect(fn).toMatch(/noteServiceWorker/);
    });

    it('the module is loaded by the app', () => {
        expect(html).toMatch(/<script src="wealthflow-crash-forensics\.js" defer><\/script>/);
    });
});

describe('crash forensics: safety', () => {
    it('never throws on corrupt stores', () => {
        const win = {
            localStorage: {
                getItem: () => '{not json',
                setItem() {}, removeItem() {},
            },
        };
        new Function('window', 'console', fs.readFileSync('wealthflow-crash-forensics.js', 'utf8'))(
            win, { log() {}, warn() {}, error() {} },
        );
        expect(() => win.WFCrashForensics.history()).not.toThrow();
        expect(win.WFCrashForensics.history()).toEqual([]);
    });

    it('never throws on arbitrary log contents', () => {
        fc.assert(fc.property(fc.array(fc.anything(), { maxLength: 15 }), (rows) => {
            const { F } = load({ wf_error_log: rows });
            expect(() => F.summary()).not.toThrow();
            expect(() => F.report()).not.toThrow();
        }), { numRuns: runs(300) });
    });

    it('works with no localStorage at all', () => {
        const win = {};
        new Function('window', 'console', fs.readFileSync('wealthflow-crash-forensics.js', 'utf8'))(
            win, { log() {}, warn() {}, error() {} },
        );
        expect(() => win.WFCrashForensics.summary()).not.toThrow();
        expect(win.WFCrashForensics.noteServiceWorker(false, 'x')).toBe(false);
    });
});
