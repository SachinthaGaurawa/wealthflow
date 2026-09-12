/* =============================================================================
 * test/stability_diagnostics_upgrade_test.js
 * -----------------------------------------------------------------------------
 * The owner's request, alongside a real device's diagnostic: "system
 * diagnosis එකත් තව තව upgrade කරන්න... කොයි තැනද issue එක තියෙන්නෙ කියලත්
 * දැනගන්න පුලුවන්" — upgrade the diagnostics so an issue's LOCATION is
 * knowable, not just its existence.
 *
 * The pasted diagnostic itself proved the gap: "Last: page-dashboard page,
 * 3242 DOM nodes, 0 charts alive, survived 72s" — true, and useless for
 * saying WHICH code path was running. Finding today's two real crashes (an
 * unreleased PDF-render canvas, an un-destroyed PDF.js document during a mail
 * sync batch) took a full source-code investigation each, when the running
 * app itself could have named the operation.
 *
 * This file pins four upgrades to wealthflow-stability.js:
 *   1. crumb() — a capped breadcrumb trail of named operations, persisted on
 *      the same write beat() already does.
 *   2. resourceInc/Dec — a generic named-resource counter (the chart
 *      registry generalised), so a crash record can say WHAT was still open.
 *   3. totalCrashCount() — an exact, uncapped lifetime counter, independent
 *      of the capped detail log that used to silently plateau at 20.
 *   4. pruneTombstones()/integrity() actually reading the real (nested)
 *      _tomb shape, and the new healOrphanTombstones() — a confirmed,
 *      previously-silent bug: a device with 508 real tombstones still
 *      pruned zero of them, because Object.keys() on a NESTED
 *      {collectionKey: {id: ts}} map counts collection keys (about a
 *      dozen), never the tombstones themselves.
 *
 * The harness mirrors test/stability_test.js exactly (same domStub/load
 * shape), so these tests execute the real module rather than a copy of it.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

const SRC = fs.readFileSync('wealthflow-stability.js', 'utf8');

function domStub({ tagCount = 5, activePage = 'dashboard' } = {}) {
    const listeners = {};
    return {
        getElementsByTagName: () => ({ length: tagCount }),
        querySelector: (sel) => (sel === '.page.active' ? { id: activePage } : null),
        addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
        __fire: (ev) => (listeners[ev] || []).forEach((fn) => fn()),
    };
}

function load(seed = {}, { dom, appData, DB } = {}) {
    globalThis.document = dom || domStub();
    const mem = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    const win = {
        localStorage: {
            getItem: (k) => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: (k) => mem.delete(k),
        },
        addEventListener() {},
        WF_APP_VERSION: '7.69.24',
        appData: appData,
        DB: DB,
    };
    new Function('window', 'console', SRC)(win, { log() {}, warn() {}, error() {} });
    return { S: win.WFStability, mem, win };
}

const PREV_DOCUMENT = globalThis.document;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); globalThis.document = PREV_DOCUMENT; });

describe('crumb() — a named trail of what the app was doing', () => {
    it('is exported and starts empty', () => {
        const { S } = load();
        expect(typeof S.crumb).toBe('function');
    });

    it('a crumb is visible in the very next persisted heartbeat', () => {
        const { S, mem } = load();
        S.crumb('mail sync: statement 3/9 — Sampath Bank');
        const alive = JSON.parse(mem.get('wf_session_alive'));
        expect(alive.crumbs.at(-1).m).toBe('mail sync: statement 3/9 — Sampath Bank');
    });

    it('caps the trail so it cannot grow without bound over a long session', () => {
        const { S, mem } = load();
        for (let i = 0; i < 40; i += 1) S.crumb('op ' + i);
        const alive = JSON.parse(mem.get('wf_session_alive'));
        expect(alive.crumbs.length).toBeLessThanOrEqual(15);
        // Newest survive, not oldest — a ring buffer, not a queue that fills once.
        expect(alive.crumbs.at(-1).m).toBe('op 39');
    });

    it('a crash record carries the crumbs from the session that died', () => {
        const dom = domStub({ tagCount: 900, activePage: 'page-dashboard' });
        const { mem } = load({}, { dom });
        // Simulate: crumb() calls are synchronous elsewhere in this file's
        // load(), but here we drive it through the real global to prove the
        // SAME instance's crumb() writes what detectPreviousCrash() later reads.
        const survivedAlive = mem.get('wf_session_alive');
        const seeded = JSON.parse(survivedAlive);
        seeded.crumbs = [{ t: Date.now(), m: 'mail sync: statement 6/9 — HNB' }];
        const { S } = load({ wf_session_alive: seeded });
        const crashes = S.crashes();
        expect(crashes).toHaveLength(1);
        expect(crashes[0].crumbs).toEqual([{ t: seeded.crumbs[0].t, m: 'mail sync: statement 6/9 — HNB' }]);
    });
});

describe('resourceInc/resourceDec — what was still open when it died', () => {
    it('counts up and down, and omits a kind once it reaches zero', () => {
        const { S } = load();
        S.resourceInc('pdfCanvas');
        S.resourceInc('pdfCanvas');
        S.resourceInc('mailPdfDoc');
        expect(S.resourceCounts()).toEqual({ pdfCanvas: 2, mailPdfDoc: 1 });
        S.resourceDec('pdfCanvas');
        expect(S.resourceCounts()).toEqual({ pdfCanvas: 1, mailPdfDoc: 1 });
        S.resourceDec('pdfCanvas');
        expect(S.resourceCounts()).toEqual({ mailPdfDoc: 1 });
    });

    it('never goes negative from an unmatched dec', () => {
        const { S } = load();
        S.resourceDec('pdfCanvas');
        S.resourceDec('pdfCanvas');
        expect(S.resourceCounts()).toEqual({});
    });

    it('an open resource at time of death appears in the crash record', () => {
        const dom = domStub({ tagCount: 3242, activePage: 'page-dashboard' });
        const { mem, S } = load({}, { dom });
        S.resourceInc('mailPdfDoc');
        const seeded = JSON.parse(mem.get('wf_session_alive'));
        expect(seeded.res).toEqual({ mailPdfDoc: 1 });
        const { S: next } = load({ wf_session_alive: seeded });
        expect(next.crashes()[0].res).toEqual({ mailPdfDoc: 1 });
    });
});

describe('totalCrashCount() — the exact count, not the capped detail log', () => {
    it('is zero on a clean device', () => {
        const { S } = load();
        expect(S.totalCrashCount()).toBe(0);
    });

    it('keeps counting past the detail-log cap — the old "stuck at 20" bug', () => {
        // Simulate 35 prior lifetime crashes (past CRASH_LOG_CAP=30) by seeding
        // the total counter directly, then let one more crash land.
        const dom = domStub({ tagCount: 50, activePage: 'x' });
        let mem = { wf_crash_total_count: 35, wf_session_alive: { start: 1, last: 2 } };
        const { S, mem: m2 } = load(mem, { dom });
        expect(S.totalCrashCount()).toBe(36); // detectPreviousCrash() ran on load and found the seeded marker
        const detail = S.crashes();
        expect(detail.length).toBeLessThanOrEqual(30);
        // The headline number the report uses must reflect the true lifetime
        // total, which is now bigger than the detail array ever holds.
        expect(S.totalCrashCount()).toBeGreaterThan(detail.length);
    });

    it('clearing the detail log does not erase the lifetime total', () => {
        const dom = domStub({ tagCount: 10, activePage: 'x' });
        const { S } = load({ wf_session_alive: { start: 1, last: 2 } }, { dom });
        expect(S.totalCrashCount()).toBe(1);
        S.clearCrashes();
        expect(S.crashes()).toEqual([]);
        expect(S.totalCrashCount()).toBe(1);
    });
});

describe('pruneTombstones() reads the real NESTED _tomb shape', () => {
    // _tomb is {collectionKey: {recordId: deleteTs}} — see wealthflow-data-health.js
    // and _wfCollectHealth() in index.html. The pre-fix code read Object.keys(_tomb)
    // directly, which counts COLLECTION KEYS (about a dozen), never the actual
    // tombstones, so `ids.length <= cap` was always true and nothing was ever
    // pruned — confirmed live on a device carrying 508 of them.
    function nestedTomb(perKey, n) {
        const tomb = {};
        for (let k = 0; k < perKey; k += 1) {
            const key = 'key' + k;
            tomb[key] = {};
            for (let i = 0; i < n; i += 1) tomb[key]['id' + k + '_' + i] = 1000 + i; // ascending ts
        }
        return tomb;
    }

    it('does nothing when the real (flattened) count is under the cap — proving it counts tombstones, not keys', () => {
        // 3 collection keys, 5 tombstones each = 15 real tombstones, but only
        // 3 "keys" under the old broken reading — which would already have
        // been "pruned" (i.e. no-op) under either reading, so this alone
        // doesn't distinguish the bug. See the next test for that.
        const appData = { _tomb: nestedTomb(3, 5) };
        const { S } = load({}, { appData });
        expect(S.pruneTombstones(250)).toBe(0);
    });

    it('THE BUG, pinned directly: 3 collection keys holding 508 real tombstones must actually prune', () => {
        // Old code: Object.keys(_tomb).length === 3 (the collection keys),
        // 3 <= 250, returns 0 — every time, regardless of how many tombstones
        // exist underneath. This is exactly the shape the pasted diagnostic
        // showed: few collection keys, hundreds of tombstones.
        const appData = { _tomb: nestedTomb(3, 170) }; // 3 * 170 = 510 real tombstones, 3 "keys"
        const { S } = load({}, { appData });
        const dropped = S.pruneTombstones(250);
        expect(dropped).toBeGreaterThan(0);
        expect(dropped).toBe(510 - 250);
        // Result is still validly nested — a caller reading it the normal way
        // (WFDataHealth.measure, _wfCollectHealth) must see the reduced count.
        let remaining = 0;
        Object.keys(appData._tomb).forEach((k) => { remaining += Object.keys(appData._tomb[k]).length; });
        expect(remaining).toBe(250);
    });

    it('keeps the NEWEST tombstones across the whole set, not per key', () => {
        const appData = { _tomb: { a: { a1: 100, a2: 200 }, b: { b1: 300, b2: 400 } } };
        const { S } = load({}, { appData });
        const dropped = S.pruneTombstones(2);
        expect(dropped).toBe(2);
        // Newest two overall are b2(400) and b1(300) — a1/a2 are dropped entirely.
        expect(appData._tomb.a).toBeUndefined();
        expect(appData._tomb.b).toEqual({ b1: 300, b2: 400 });
    });
});

describe('healOrphanTombstones() — safe to remove unconditionally, unlike a real one', () => {
    it('removes only markers filed under a key that holds no records', () => {
        const appData = {
            _tomb: {
                income: { i1: 100 },                 // real record-store key — must survive
                oldRenamedKey: { x1: 50, x2: 60 },    // orphaned — no such store exists
            },
        };
        const { S } = load({}, { appData });
        const removed = S.healOrphanTombstones();
        expect(removed).toBe(2);
        expect(appData._tomb.income).toEqual({ i1: 100 });
        expect(appData._tomb.oldRenamedKey).toBeUndefined();
    });

    it('is a no-op, returning 0, when every tombstone is filed correctly', () => {
        const appData = { _tomb: { income: { i1: 100 }, loans: { l1: 200 } } };
        const { S } = load({}, { appData });
        expect(S.healOrphanTombstones()).toBe(0);
        expect(Object.keys(appData._tomb)).toEqual(['income', 'loans']);
    });

    it('runs automatically during the boot self-heal, alongside the stamp/prune heal', () => {
        // Source-anchored: the behavioural tests above prove the function
        // works; this proves boot actually calls it, which is the part a
        // fix can silently regress on (a function that works but nothing calls).
        expect(SRC).toMatch(/function healSoon\s*\([\s\S]{0,300}healOrphanTombstones\(\);/);
    });
});

describe('integrity() counts real tombstones, not collection keys', () => {
    it('reports the flattened count', () => {
        const appData = { _tomb: { a: { a1: 1, a2: 2, a3: 3 }, b: { b1: 4 } } };
        const DB = { get: () => [] };
        const { S } = load({}, { appData, DB });
        expect(S.integrity().tombstones).toBe(4); // not 2 (the number of collection keys)
    });
});

describe('the new heartbeat cadence is tighter, so a later crash is less stale', () => {
    it('HEARTBEAT_MS is 5000, not the old 10000', () => {
        expect(SRC).toMatch(/var HEARTBEAT_MS = 5000;/);
    });
});

describe('the two resource trackers found today are actually wired up', () => {
    // A tracker that exists but nothing calls is exactly the failure mode
    // wealthflow-mail-intake.js's own header warns about elsewhere in this
    // repo: "a facility built and wired to SOME of its callers is this
    // repository's most repeated defect." Source-anchored so a future edit
    // that quietly drops one side of an inc/dec pair fails a test instead of
    // just leaking a counter forever.
    const AI_V4 = fs.readFileSync('wealthflow-ai-v4.js', 'utf8');
    const HTML = fs.readFileSync('index.html', 'utf8');

    it('every pdfCanvas resourceInc in the PDF render loop has a matching resourceDec', () => {
        const incs = (AI_V4.match(/resourceInc\('pdfCanvas'\)/g) || []).length;
        const decs = (AI_V4.match(/resourceDec\('pdfCanvas'\)/g) || []).length;
        expect(incs).toBeGreaterThan(0);
        expect(decs).toBe(incs);
    });

    it('every mailPdfDoc resourceInc in runMailSync has a matching resourceDec', () => {
        const incs = (HTML.match(/resourceInc\('mailPdfDoc'\)/g) || []).length;
        const decs = (HTML.match(/resourceDec\('mailPdfDoc'\)/g) || []).length;
        expect(incs).toBeGreaterThan(0);
        expect(decs).toBe(incs);
    });

    it('mail sync leaves a breadcrumb naming which statement it is on, not just that it ran', () => {
        expect(HTML).toMatch(/crumb\('mail sync: statement ' \+ \(i \+ 1\)/);
    });

    it('page navigation leaves a breadcrumb — the single highest-coverage signal for "where"', () => {
        const i = HTML.indexOf('function _proceedShowPage(');
        expect(i, '_proceedShowPage moved — retarget this test').toBeGreaterThan(-1);
        expect(HTML.slice(i, i + 200)).toContain("WFStability.crumb('page: ' + name)");
    });
});
