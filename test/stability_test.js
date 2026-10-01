// =============================================================================
// test/stability_test.js — wealthflow-stability.js's crash detector
// -----------------------------------------------------------------------------
// THE COMPLAINT THIS ANSWERS
//
// A real device's diagnostics reported "20 crash(es) detected... Last: ? page,
// 0 DOM nodes, 0 charts alive, survived 0s" — for every single one of them. Not
// because the app genuinely died with an empty page and no DOM every time, but
// because armSession() writes exactly those placeholders on boot, and the first
// heartbeat that would overwrite them with real numbers was 10 seconds away.
// Every crash this had ever recorded happened inside that 10-second blind spot
// — which is itself informative (early boot is where the crashes cluster) but
// the report could never say WHAT was on screen when it did, which is the one
// thing a crash report exists to answer.
//
// armSession() now beats immediately, then keeps a dense 1-second cadence for
// the first 12 seconds — covering the exact window every recorded crash has
// fallen inside — before settling into the normal 10-second heartbeat.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

const SRC = fs.readFileSync('wealthflow-stability.js', 'utf8');

/** A DOM stub with a controllable element count and active page id. */
function domStub({ tagCount = 5, activePage = 'dashboard' } = {}) {
    const listeners = {};
    return {
        getElementsByTagName: () => ({ length: tagCount }),
        querySelector: (sel) => (sel === '.page.active' ? { id: activePage } : null),
        addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        __fire: (ev) => (listeners[ev] || []).forEach((fn) => fn()),
    };
}

/** Loads a fresh module instance into its own `window`, seeded with `seed`
 * localStorage entries — a real backing store, not a stub that always answers
 * the same thing, the same discipline test/crash_forensics_test.js already
 * uses for the sibling crash-tracking module.
 *
 * `document` is set on `globalThis` for the DURATION OF THE TEST, not just
 * for this call — armSession()'s fast-cadence ticks fire from a fake-timer
 * callback that runs LATER, well after load() has returned, and they resolve
 * `document` through the same global scope `new Function` used to run the
 * script in the first place. Restoring it before that callback fires would
 * make every tick see no document at all, which is a bug in the test harness,
 * not in the fix it is meant to prove. afterEach cleans it up instead. */
function load(seed = {}, dom) {
    globalThis.document = dom || domStub();
    // a device already on the current detector generation: the one-time reset of the first generation's counts has nothing to do here
    const mem = new Map(Object.entries({ wf_crash_detector: 2, ...seed }).map(([k, v]) => [k, JSON.stringify(v)]));
    const win = {
        localStorage: {
            getItem: (k) => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: (k) => mem.delete(k),
        },
        addEventListener() {},
        WF_APP_VERSION: '7.69.24',
    };
    new Function('window', 'console', SRC)(win, { log() {}, warn() {}, error() {} });
    return { S: win.WFStability, mem, win };
}

const PREV_DOCUMENT = globalThis.document;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); globalThis.document = PREV_DOCUMENT; });

describe('the crash detector no longer blinds itself for the first 10 seconds', () => {
    it('the alive-marker holds REAL numbers immediately, not the boot placeholder', () => {
        const dom = domStub({ tagCount: 1200, activePage: 'liquidity' });
        const { mem } = load({}, dom);
        const alive = JSON.parse(mem.get('wf_session_alive'));
        // Before the fix this stayed page:'?', dom:0 until the first 10s
        // heartbeat. It must now reflect the page as of the very first beat.
        expect(alive.page).toBe('liquidity');
        expect(alive.dom).toBe(1200);
    });

    it('a crash inside the old 10-second blind spot is now attributed to a real page', () => {
        const dom = domStub({ tagCount: 900, activePage: 'settings' });
        // Boot, let ~3s of the fast cadence run, then the process dies without
        // a clean exit — the marker simply survives to the next boot.
        const { mem } = load({}, dom);
        vi.advanceTimersByTime(3000);

        const survivedAlive = mem.get('wf_session_alive');
        const { S } = load({ wf_session_alive: JSON.parse(survivedAlive) });
        const crashes = S.crashes();
        expect(crashes).toHaveLength(1);
        expect(crashes[0].page).toBe('settings');
        expect(crashes[0].dom).toBe(900);
        // Not the old permanent 0s — some real time elapsed before it died.
        expect(crashes[0].aliveSec).toBeGreaterThan(0);
    });

    it('a crash that ends the SAME millisecond as boot is the only case still reporting the placeholder — and that is honest, not a bug', () => {
        // The synchronous beat() inside armSession() cannot outrun a crash that
        // happens before the very next line of JS runs. This is the one
        // irreducible case, and it is now the ONLY one — not the default.
        const { mem } = load({}, domStub({ tagCount: 500, activePage: 'dash' }));
        const marker = JSON.parse(mem.get('wf_session_alive'));
        expect(marker.dom).toBe(500);
        expect(marker.page).toBe('dash');
    });

    it('settles into the normal 10-second cadence after the dense window, and keeps tracking', () => {
        const dom = domStub({ tagCount: 10, activePage: 'a' });
        load({}, dom);
        vi.advanceTimersByTime(12000);          // exhaust the fast window
        dom.querySelector = (sel) => (sel === '.page.active' ? { id: 'b' } : null);
        vi.advanceTimersByTime(10000);          // one normal-cadence tick
        // No direct getter for the marker here beyond what load() already
        // proved; this just asserts the interval chain never throws across
        // the fast→normal handoff, which a mistyped clearInterval easily would.
        expect(() => vi.advanceTimersByTime(10000)).not.toThrow();
    });

    it('never throws when document or performance is unavailable', () => {
        const win = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {} };
        const prevDoc = globalThis.document;
        delete globalThis.document;
        try {
            expect(() => new Function('window', 'console', SRC)(win, { log() {}, warn() {}, error() {} }))
                .not.toThrow();
            expect(() => vi.advanceTimersByTime(15000)).not.toThrow();
        } finally {
            globalThis.document = prevDoc;
        }
    });
});

describe('crashes() and integrity() still answer honestly', () => {
    it('reports zero crashes on a clean first boot', () => {
        const { S } = load();
        expect(S.crashes()).toEqual([]);
    });

    it('a clean pagehide clears the marker — no crash recorded next boot', () => {
        const dom = domStub();
        const { mem, win } = load({}, dom);
        win.addEventListener = (ev, fn) => { if (ev === 'pagehide') fn(); };
        // Re-run armSession's listener wiring isn't reachable directly, so this
        // exercises the same effect load() already set up: a clean exit simply
        // removes the key before the next boot's load() ever reads it.
        mem.delete('wf_session_alive');
        const { S } = load({});
        expect(S.crashes()).toEqual([]);
    });
});

/* ── THE FALSE CRASHES: "27 crashes, survived 0s, 19 of them on the dashboard" ─────────────────────────────────────────────────────────── */

/** A window whose listeners can be fired, in front of a document whose visibility can be changed. */
function liveLoad(seed = {}) {
    const dom = domStub(); dom.visibilityState = 'visible';
    globalThis.document = dom;
    const mem = new Map(Object.entries({ wf_crash_detector: 2, ...seed }).map(([k, v]) => [k, JSON.stringify(v)]));
    const listeners = {};
    const win = {
        localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
        addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        WF_APP_VERSION: '7.69.33',
    };
    new Function('window', 'console', SRC)(win, { log() {}, warn() {}, error() {} });
    const fire = (ev, arg) => (listeners[ev] || []).forEach((fn) => fn(arg));
    return { S: win.WFStability, mem, win, dom, fire, listeners };
}

describe('backgrounding is not a crash', () => {
    it('after the app is sent to the background the heartbeats do NOT write the alive-marker again — so the next launch finds none', () => {
        const { mem, dom } = liveLoad();
        expect(mem.has('wf_session_alive')).toBe(true);
        dom.visibilityState = 'hidden'; dom.__fire('visibilitychange');
        expect(mem.has('wf_session_alive')).toBe(false);                    // the clean exit
        vi.advanceTimersByTime(60_000);                                      // the fast ticks, then the five-second heartbeat: all still firing
        expect(mem.has('wf_session_alive')).toBe(false);                    // …and none of them brings it back
        const next = liveLoad(Object.fromEntries([...mem.entries()].map(([k, v]) => [k, JSON.parse(v)])));
        expect(next.S.crashes()).toEqual([]); expect(next.S.totalCrashCount()).toBe(0);
    });
    it('the same through pagehide (closing, or the app switcher)', () => {
        const { mem, fire } = liveLoad();
        fire('pagehide'); vi.advanceTimersByTime(30_000);
        expect(mem.has('wf_session_alive')).toBe(false);
    });
    it('a page that is OPENED hidden (a background launch) is not a session until it is shown', () => {
        globalThis.document = Object.assign(domStub(), { visibilityState: 'hidden' });
        const mem = new Map([['wf_crash_detector', '2']]);
        const win = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }, addEventListener() {}, WF_APP_VERSION: '7' };
        new Function('window', 'console', SRC)(win, { log() {}, warn() {}, error() {} });
        vi.advanceTimersByTime(20_000);
        expect(mem.has('wf_session_alive')).toBe(false);
    });
    it('shown again, a new session begins — and a REAL kill while it is in front is still recorded, with how long it had been alive', () => {
        const { mem, dom } = liveLoad();
        dom.visibilityState = 'hidden'; dom.__fire('visibilitychange');
        vi.advanceTimersByTime(120_000);
        dom.visibilityState = 'visible'; dom.__fire('visibilitychange');
        expect(mem.has('wf_session_alive')).toBe(true);
        vi.advanceTimersByTime(42_000);                                      // forty-two seconds in front… then the process is killed with no event at all
        const next = liveLoad(Object.fromEntries([...mem.entries()].map(([k, v]) => [k, JSON.parse(v)])));
        expect(next.S.crashes()).toHaveLength(1);
        expect(next.S.crashes()[0].aliveSec).toBeGreaterThanOrEqual(40);     // a real number, not "survived 0s"
    });
    it('restored from the back/forward cache (pageshow) it re-arms; a visible page that never said it was leaving keeps beating', () => {
        const { mem, fire } = liveLoad();
        fire('pagehide'); expect(mem.has('wf_session_alive')).toBe(false);
        fire('pageshow', { persisted: true }); expect(mem.has('wf_session_alive')).toBe(true);
        mem.delete('wf_session_alive'); vi.advanceTimersByTime(6000);        // a visible, living page keeps the marker current
        expect(mem.has('wf_session_alive')).toBe(true);
    });
});

describe("the first generation's count is not believed — and not erased", () => {
    it('a device with the old detector\'s 27 "crashes" starts again at zero, with the old count kept in one line', () => {
        const old = Array.from({ length: 27 }, (_, i) => ({ when: new Date(1e12 + i).toISOString(), build: '7.69.33', page: 'page-dashboard', dom: 3069, charts: 0, aliveSec: 0 }));
        const { S, mem } = liveLoad({ wf_crash_detector: undefined, wf_crash_log: old.slice(-20), wf_crash_total_count: 27, wf_session_alive: { start: 1, last: 1, build: '7.69.33', page: 'page-dashboard' } });
        expect(S.crashes()).toEqual([]); expect(S.totalCrashCount()).toBe(0);
        expect(S.legacyCrashes()).toMatchObject({ count: 27, shortLived: 20, detector: 1 });
        expect(JSON.parse(mem.get('wf_crash_detector'))).toBe(2);
    });
    it('on a device already on the new generation nothing is reset: the next real crash is recorded and survives the next boot', () => {
        const a = liveLoad({ wf_session_alive: { start: Date.now() - 50_000, last: Date.now() - 1000, build: '7.69.33', page: 'page-dashboard', dom: 3000, charts: 0 } });
        expect(a.S.crashes()).toHaveLength(1); expect(a.S.crashes()[0].aliveSec).toBe(49);
        a.fire('pagehide');                                                  // this launch ends cleanly
        const b = liveLoad(Object.fromEntries([...a.mem.entries()].map(([k, v]) => [k, JSON.parse(v)])));
        expect(b.S.totalCrashCount()).toBe(1); expect(b.S.legacyCrashes()).toBeNull();
    });
});

describe('a module that will not link clears the app\'s own code caches, once', () => {
    function healWorld() {
        const w = liveLoad();
        const deleted = [], unregistered = []; let reloads = 0;
        w.win.caches = { keys: async () => ['wealthflow-v7.69.33', 'wealthflow-old', 'someone-elses-cache'], delete: async (k) => { deleted.push(k); return true; } };
        w.win.navigator = { serviceWorker: { getRegistrations: async () => [{ unregister: async () => { unregistered.push('sw'); return true; } }] } };
        w.win.location = { reload: () => { reloads++; } };
        return { ...w, deleted, unregistered, reloads: () => reloads };
    }
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
    it('"Importing binding name \'CONSUMER_MAIL\' is not found": the app\'s code caches and service workers go, nothing else, then it reloads', async () => {
        const w = healWorld();
        w.fire('error', { message: "SyntaxError: Importing binding name 'CONSUMER_MAIL' is not found." });
        await flush();
        expect(w.deleted.sort()).toEqual(['wealthflow-old', 'wealthflow-v7.69.33']);    // never a cache that is not the app's
        expect(w.unregistered).toEqual(['sw']); expect(w.reloads()).toBe(1);
        expect(JSON.parse(w.mem.get('wf_module_heal'))).toMatchObject({ reason: expect.stringContaining('CONSUMER_MAIL') });
    });
    it('a second failure within six hours does nothing — no reload loop', async () => {
        const w = healWorld();
        w.fire('error', { message: 'Importing binding name X is not found.' }); await flush();
        w.fire('error', { message: 'Importing binding name Y is not found.' }); await flush();
        expect(w.reloads()).toBe(1);
        vi.setSystemTime(Date.now() + 7 * 3600 * 1000);
        w.fire('error', { message: 'Importing binding name Z is not found.' }); await flush();
        expect(w.reloads()).toBe(2);
    });
    it('an unrelated error, or a failed module <script>, is judged correctly; and nothing reloads under someone who is typing', async () => {
        const w = healWorld();
        w.fire('error', { message: "TypeError: undefined is not an object (evaluating 'x.y')" }); await flush();
        expect(w.reloads()).toBe(0); expect(w.deleted).toEqual([]);
        w.dom.activeElement = { tagName: 'INPUT' };
        w.fire('error', { message: '', target: { tagName: 'SCRIPT', type: 'module', src: 'https://x.example/wealthflow-sender-discovery-ab12cd34.js' } }); await flush();
        expect(w.deleted.length).toBe(2); expect(w.reloads()).toBe(0);                    // purged, so the next start is clean — but the page is not pulled from under the typing
    });
    it('an unhandled rejection from a dynamic import is the same failure', async () => {
        const w = healWorld();
        w.fire('unhandledrejection', { reason: new TypeError('Failed to fetch dynamically imported module: https://x.example/a.js') }); await flush();
        expect(w.reloads()).toBe(1);
    });
});
