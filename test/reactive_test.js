/* =============================================================================
 * test/reactive_test.js — one write, every screen
 * -----------------------------------------------------------------------------
 * The owner: money marked received on its own tab still showed as entirely
 * unreceived on the dashboard. "Link them properly with strict reactive data
 * binding."
 *
 * Two faults, one symptom, and both are pinned here.
 *
 *   1. THE REPAINT WAS PER-CALLER. deleteIncomeRecv() called renderDash();
 *      markIncRecvReceived(), three lines above it, did not. So deleting income
 *      updated the dashboard and receiving it did not. The repaint now belongs
 *      to the write — DB.set() and DB.delKey() — so a handler cannot forget it.
 *
 *   2. `received` WAS A LABEL NOTHING ADDED UP. getMonthlyData() summed every
 *      row in the month without ever reading the field, and the statement
 *      importer writes `received: past` — so a credit dated next week was
 *      counted in Year Income, Net Savings and the Savings Rate.
 *
 * The scheduler is tested by driving it, not by reading it: a fake `schedule`
 * that the test drains by hand, so coalescing and the re-entrancy bound are
 * observed rather than asserted about. The wiring assertions read index.html,
 * because a scheduler nothing touches is this repository's favourite defect.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRepaintScheduler, incomeIn, NO_REPAINT } from '../wealthflow-reactive.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** A frame that only advances when the test says so. */
function frames() {
    const q = [];
    return {
        schedule: (fn) => q.push(fn),
        tick() { const run = q.splice(0, q.length); run.forEach((f) => f()); return run.length; },
        get depth() { return q.length; },
    };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MONEY RULE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('what actually arrived in a month', () => {
    const rows = [
        { id: 'a', month: '2026-09', amount: 100000, received: true },
        { id: 'b', month: '2026-09', amount: 50000, received: false },
        { id: 'c', month: '2026-08', amount: 999, received: true },
        { id: 'd', date: '2026-09-14', amount: 2500, received: true },   // placed by date
    ];

    it('THE BUG: money marked not-received is not income', () => {
        const out = incomeIn(rows, '2026-09');
        expect(out.received).toBe(102500);
        expect(out.pending).toBe(50000);
        expect(out.pendingCount).toBe(1);
    });

    it('a row with no opinion still counts — silence is not a refusal', () => {
        /* Rows written before `received` existed have no field. Reading that
         * as "not received" would erase real history on the first load after
         * this change, which is a worse bug than the one being fixed. */
        const out = incomeIn([{ month: '2026-09', amount: 7000 }], '2026-09');
        expect(out.received).toBe(7000);
        expect(out.pending).toBe(0);
    });

    it('a row is placed by its own month, falling back to its date', () => {
        expect(incomeIn(rows, '2026-08').received).toBe(999);
        expect(incomeIn(rows, '2026-07').received).toBe(0);
    });

    it('never throws on the shapes a half-written store actually contains', () => {
        for (const bad of [null, undefined, 'nope', 42, [null], [{ amount: 'x', month: '2026-09' }]]) {
            expect(() => incomeIn(bad, '2026-09')).not.toThrow();
        }
        expect(incomeIn([{ month: '2026-09', amount: 'x' }], '2026-09').received).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SCHEDULER
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the repaint that happens once however many writes there were', () => {
    it('two hundred writes in one frame are one paint', () => {
        const f = frames();
        let paints = 0;
        const s = createRepaintScheduler({ schedule: f.schedule, paint: () => { paints += 1; } });
        for (let i = 0; i < 200; i += 1) s.touch('expenses');
        expect(paints, 'it painted before the frame ran').toBe(0);
        f.tick();
        expect(paints).toBe(1);
        expect(s.stats().coalesced).toBe(199);
    });

    it('the paint is told every key written since the last one', () => {
        const f = frames();
        let seen = null;
        const s = createRepaintScheduler({ schedule: f.schedule, paint: (keys) => { seen = [...keys].sort(); } });
        s.touch('incomeRecv'); s.touch('expenses'); s.touch('incomeRecv');
        f.tick();
        expect(seen).toEqual(['expenses', 'incomeRecv']);
    });

    it('a write after the paint schedules the next one', () => {
        const f = frames();
        let paints = 0;
        const s = createRepaintScheduler({ schedule: f.schedule, paint: () => { paints += 1; } });
        s.touch('loans'); f.tick();
        s.touch('loans'); f.tick();
        expect(paints).toBe(2);
    });

    it('the ignore list is honoured, and it is tiny on purpose', () => {
        const f = frames();
        let paints = 0;
        const s = createRepaintScheduler({ schedule: f.schedule, paint: () => { paints += 1; } });
        expect(s.touch('aiChats')).toBe(false);
        f.tick();
        expect(paints).toBe(0);
        /* A key wrongly listed here is a screen that stops updating. Every
         * money-bearing store must be absent from it. */
        for (const k of ['income', 'incomeRecv', 'incomeReceived', 'expenses', 'loans',
            'subscriptions', 'cheques', 'targets', 'balance', 'debtors', 'ccinstall']) {
            expect(NO_REPAINT, k + ' would never repaint').not.toContain(k);
        }
    });
});

describe('a renderer that writes cannot spin the phone', () => {
    it('a write DURING the paint gets one more pass, and only one', () => {
        const f = frames();
        let paints = 0;
        let loops = null;
        const s = createRepaintScheduler({
            schedule: f.schedule,
            paint: () => { paints += 1; s.touch('expenses'); },   // a migration inside a render
            onLoop: (keys) => { loops = keys; },
        });
        s.touch('expenses');
        /* Drain to exhaustion. If the bound did not hold, this never returns —
         * so the loop itself is the assertion. */
        let guard = 0;
        while (f.depth && guard < 50) { f.tick(); guard += 1; }
        expect(guard).toBeLessThan(50);
        expect(paints).toBe(2);
        expect(loops, 'the refusal must be reported, not silent').toEqual(['expenses']);
        expect(s.stats().dropped).toBe(1);
    });

    it('a paint that throws is reported, not propagated into the write', () => {
        /* flush() is synchronous and reachable from a click handler. A renderer
         * that throws must not take the handler with it — this app has already
         * shipped that once, when a full localStorage threw out of DB.set and
         * the button appeared to do nothing while the data was fine. */
        const f = frames();
        let paints = 0;
        const errs = [];
        const s = createRepaintScheduler({
            schedule: f.schedule,
            paint: () => { paints += 1; throw new Error('a renderer blew up'); },
            onError: (e, keys) => errs.push([e.message, keys]),
        });
        s.touch('expenses');
        expect(() => f.tick()).not.toThrow();
        expect(errs).toEqual([['a renderer blew up', ['expenses']]]);
        expect(s.painting, 'still believes a paint is in progress; every later write is swallowed').toBe(false);
        s.touch('expenses'); f.tick();
        expect(paints).toBe(2);
        expect(s.stats().failed).toBe(2);
    });

    it('flush() draws now, for a path that cannot wait a frame', () => {
        const f = frames();
        let paints = 0;
        const s = createRepaintScheduler({ schedule: f.schedule, paint: () => { paints += 1; } });
        s.touch('expenses');
        s.flush();
        expect(paints).toBe(1);
        f.tick();                       // the queued frame finds nothing left to do
        expect(paints).toBe(1);
    });

    it('refuses to exist without the two functions it cannot work without', () => {
        expect(() => createRepaintScheduler()).toThrow(TypeError);
        expect(() => createRepaintScheduler({ schedule: () => {} })).toThrow(TypeError);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WIRING — a scheduler nothing touches is the defect, not the fix
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the page is actually bound to it', () => {
    it('the module is loaded, as a module, before the dashboard needs it', () => {
        expect(HTML).toContain('<script type="module" src="wealthflow-reactive.js"></script>');
        /* getMonthlyData() calls incomeIn() unguarded, so it must load with the
         * other boot-critical modules rather than at the end of <body>. */
        expect(HTML.indexOf('wealthflow-reactive.js'))
            .toBeLessThan(HTML.indexOf('<script type="module" src="wealthflow-verify-matrix.js">'));
    });

    it('BOTH writes touch it — set and delKey', () => {
        /* delKey is how a confirmed month is undone. Leaving it out would fix
         * confirming and leave un-confirming exactly as stale as before. */
        expect(HTML).toContain("try { if (window._wfTouch) window._wfTouch(k); } catch (_) {}");
        expect(HTML).toContain("try { if (window._wfTouch) window._wfTouch(field); } catch (_) {}");
    });

    it('the touch repaints every surface, not just the one in front', () => {
        const at = HTML.indexOf('function _wfTouch(');
        expect(at).toBeGreaterThan(-1);
        const body = HTML.slice(at, at + 1200);
        expect(body).toContain('_wfRepaintScheduler()');
        expect(HTML).toMatch(/paint: \(\) => refreshAllSurfaces\(\)/);
    });

    it('the scheduler is built lazily, because the module has not run at that line', () => {
        /* Inline classic script executes during parse; type="module" is
         * deferred. Building the scheduler eagerly would find no WFReactive and
         * silently bind nothing at all — every screen exactly as stale as
         * before, with no error to notice. */
        expect(HTML).toContain('function _wfRepaintScheduler()');
        expect(HTML).toMatch(/if \(_wfRepainter\) return _wfRepainter;/);
    });

    it('getMonthlyData asks the module what arrived instead of counting rows itself', () => {
        expect(HTML).toContain("window.WFReactive.incomeIn(DB.get('incomeRecv') || [], _incYM)");
        /* And the old loop is gone — two copies of one rule is how they drift. */
        expect(HTML).not.toContain("if (rm === _incYM) income += (+r.amount || 0);");
    });

    it('the advisor is told the same figure the dashboard shows', () => {
        expect(HTML).not.toContain("incRecv.filter(x => x.month === curMonthStr && x.received)");
        expect(HTML).toContain("window.WFReactive.incomeIn(DB.get('incomeRecv') || [], curMonthStr).received");
    });

    it('what is NOT counted is named on the card rather than quietly dropped', () => {
        expect(HTML).toContain('yrPending += (md.incomePending || 0)');
        expect(HTML).toContain('not yet confirmed received');
    });
});
