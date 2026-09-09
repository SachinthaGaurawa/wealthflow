/* =============================================================================
 * wealthflow-reactive.js — one write, every screen
 * -----------------------------------------------------------------------------
 * THE COMPLAINT: money marked received on its own tab still showed as entirely
 * unreceived on the dashboard. The owner's words: "Link them properly with
 * strict reactive data binding."
 *
 * TWO SEPARATE FAULTS PRODUCED THAT ONE SYMPTOM, and both are in this file.
 *
 * ── 1. THE REPAINT WAS PER-CALLER ───────────────────────────────────────────
 *
 * Every screen in this app draws from `appData` and redraws when its own
 * handler remembers to ask. deleteIncomeRecv() called renderDash(); the
 * markIncRecvReceived() sitting four lines above it did not. Neither did
 * saveIncomeRecv(). So deleting income updated the dashboard and RECEIVING it
 * did not — the exact report. This is the defect this repository keeps
 * producing: a facility wired to some callers.
 *
 * A dozen more renderDash() calls would have fixed those three handlers and
 * left the next one to be written broken. So the repaint moves to the write
 * itself: DB.set() and DB.delKey() touch this scheduler, and the scheduler
 * repaints once. A handler cannot forget something it no longer does.
 *
 * COALESCED, because an import calls DB.set two hundred times and two hundred
 * repaints is a frozen phone. Every touch inside one frame produces ONE paint.
 *
 * AND IT TERMINATES. A render that writes (a migration, a normaliser — this
 * codebase has several) would schedule the paint that runs it again. Writes
 * during a paint are collected and get exactly one follow-up pass; a third is
 * refused and reported. A repaint loop is a frozen app, which is worse than a
 * stale figure, so the bound is hard rather than hopeful.
 *
 * ── 2. "RECEIVED" WAS A LABEL NOTHING ADDED UP ──────────────────────────────
 *
 * getMonthlyData() summed every incomeRecv row in the month and never looked at
 * `received`. The statement importer writes `received: past` — so a payment
 * dated next week is imported as NOT received and was counted in Year Income,
 * Net Savings and the Savings Rate anyway. That is the owner's own rule broken
 * from the inside: "If a transaction fails to arrive in the bank, blind
 * automation will corrupt the balance sheet."
 *
 * incomeIn() is the single answer, and it returns BOTH figures. A number that
 * quietly got smaller is indistinguishable from a bug, so the screen that shows
 * the received total also shows what is waiting.
 *
 * ONLY AN EXPLICIT `false` IS EXCLUDED. Rows written before the field existed
 * have no opinion, and reading their silence as "not received" would erase real
 * history on the first load after this change.
 *
 * Pure: no DOM, no storage, no clock, no timer of its own — the scheduler is
 * handed the function that defers work. test/reactive_test.js drives it.
 * ===========================================================================*/

/* Keys whose writes change nothing anyone is looking at. Deliberately tiny: a
 * key wrongly listed here is a screen that stops updating, and that is the bug
 * this file exists to remove. Everything not named repaints. */
export const NO_REPAINT = Object.freeze([
    'aiHistory', 'aiChats', 'memory', 'aiMemory',
]);

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * The money that actually arrived in one month, and the money still waiting.
 *
 * `rows` is the incomeRecv store; `ym` is 'YYYY-MM'. A row is placed by its
 * own `month`, falling back to the first seven characters of its date — the
 * same rule getMonthlyData has always used, kept so this change moves no row
 * between months while it changes which ones are counted.
 */
export function incomeIn(rows, ym) {
    const want = String(ym || '');
    let received = 0, pending = 0, pendingCount = 0;
    for (const r of Array.isArray(rows) ? rows : []) {
        if (!r) continue;
        const m = r.month || (r.date ? String(r.date).slice(0, 7) : '');
        if (m !== want) continue;
        /* `=== false` and not `!r.received`: see the header. */
        if (r.received === false) { pending += num(r.amount); pendingCount += 1; }
        else received += num(r.amount);
    }
    return { received, pending, pendingCount };
}

/**
 * A repaint that happens once per frame however many writes there were.
 *
 * `schedule(fn)` is the caller's deferral — requestAnimationFrame in the page,
 * a queue the test drains by hand. `paint(keys)` is what draws; it is given the
 * Set of keys written since the last paint, in case a caller ever wants to
 * narrow the work.
 */
export function createRepaintScheduler({
    schedule, paint, maxChained = 2, ignore = NO_REPAINT, onLoop = null, onError = null,
} = {}) {
    if (typeof schedule !== 'function' || typeof paint !== 'function') {
        throw new TypeError('createRepaintScheduler needs schedule() and paint()');
    }
    const skip = new Set(ignore || []);
    let dirty = new Set();
    let queued = false;
    let painting = false;
    let again = false;
    let chained = 0;
    const stats = { paints: 0, touches: 0, coalesced: 0, dropped: 0, failed: 0 };

    function run() {
        queued = false;
        /* NOTHING TO DRAW. flush() can empty the queue a frame before the frame
         * arrives, and painting again on an empty set is a whole repaint for no
         * reason — on a phone, every time anything is saved. */
        if (!dirty.size && !again) return;
        const keys = dirty;
        dirty = new Set();
        painting = true;
        stats.paints += 1;
        try {
            paint(keys);
        } catch (err) {
            /* SWALLOWED, AND REPORTED. flush() runs synchronously and can be
             * reached from a click handler; a renderer that throws would then
             * take the handler with it, and this codebase has already shipped
             * that bug once — a full localStorage threw out of DB.set and the
             * button appeared to do nothing. A stale screen is recoverable. */
            stats.failed += 1;
            if (typeof onError === 'function') { try { onError(err, [...keys]); } catch (_) {} }
        } finally {
            /* Cleared whatever happened. A renderer that threw once must not
             * leave the scheduler believing a paint is forever in progress,
             * because every later write would then be swallowed. */
            painting = false;
        }
        if (again) {
            again = false;
            if (chained + 1 < maxChained) {
                chained += 1;
                queued = true;
                schedule(run);
                return;
            }
            /* The bound. Something writes on every paint; painting again would
             * not converge. Reported rather than hidden — a screen one write
             * behind is a bug worth seeing, and a spinning phone is worse. */
            stats.dropped += 1;
            if (typeof onLoop === 'function') {
                try { onLoop([...keys]); } catch (_) { /* never break the paint */ }
            }
        }
        chained = 0;
    }

    return {
        /** Something was written. Returns whether it will cause a paint. */
        touch(key) {
            const k = String(key == null ? '' : key);
            if (skip.has(k)) return false;
            stats.touches += 1;
            dirty.add(k);
            if (painting) { again = true; return true; }
            if (queued) { stats.coalesced += 1; return true; }
            queued = true;
            schedule(run);
            return true;
        },
        /** Draw now if anything is waiting — for a path that cannot wait a frame. */
        flush() { if (queued || dirty.size) run(); },
        /** True while paint() is on the stack. */
        get painting() { return painting; },
        pending() { return [...dirty]; },
        stats() { return { ...stats }; },
    };
}

const API = { NO_REPAINT, incomeIn, createRepaintScheduler };
if (typeof window !== 'undefined') window.WFReactive = API;
export default API;
