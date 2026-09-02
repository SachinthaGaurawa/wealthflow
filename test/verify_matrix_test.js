/* =============================================================================
 * test/verify_matrix_test.js — a due date is a question, not an answer
 * -----------------------------------------------------------------------------
 * THE OWNER'S RULE, IN THEIR WORDS:
 *
 *   "The system must NEVER automatically post or mark income as Received based
 *    on a static calendar. If a transaction fails to arrive in the bank, blind
 *    automation will corrupt the balance sheet."
 *
 * The app already asked the question — a banner on the pay day — and a banner
 * is a MOMENT. Close the app that day and the question is gone while the money
 * is still unconfirmed, with nothing on any screen saying so. There was no
 * queue, no state to be in, and no way to say "this one is late" without either
 * lying that it arrived or being asked again tomorrow as though nothing had
 * happened.
 *
 * Two things are pinned hardest below, because both can only be wrong in a
 * direction that costs money:
 *
 *   - a payout that is NOT YET DUE never appears (a question with no answer),
 *     and one that has been answered never comes back;
 *   - CADENCE. `income.freq` is monthly, quarterly or annual, and saveIncome
 *     puts the per-payout figure in a field called `monthly`. Everything that
 *     read it ignored `freq`, so an annual payout was treated as arriving every
 *     month — twelve questions a year for one payment.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import M, {
    VERIFY, LOOKBACK_MONTHS, LATE_AFTER_DAYS,
    monthKeyOf, dueDateFor, periodMonths, paysInMonth,
    receivedKey, billKey, pendingInflows, pendingOutflows, queueTotals,
} from '../wealthflow-verify-matrix.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const AT = (iso) => new Date(iso + 'T09:00:00Z');

const monthly = (over = {}) => ({
    id: 'm1', name: 'Business profit', company: 'Acme',
    monthly: 300000, day: '5', start: '2025-01-05', freq: 'monthly', ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DATES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the day a payout falls on', () => {
    it('clamps to the last day of a short month instead of rolling over', () => {
        /* A source paying on the 31st does not skip February, and it must not
         * land on 2 March either — the queue would then ask about a month that
         * has no such day. */
        expect(dueDateFor(31, 2026, 1).toISOString().slice(0, 10)).toBe('2026-02-28');
        expect(dueDateFor(31, 2024, 1).toISOString().slice(0, 10)).toBe('2024-02-29');
        expect(dueDateFor(31, 2026, 0).toISOString().slice(0, 10)).toBe('2026-01-31');
    });

    it('handles a month index that runs off either end of the year', () => {
        expect(dueDateFor(5, 2026, -1).toISOString().slice(0, 10)).toBe('2025-12-05');
        expect(dueDateFor(5, 2026, 12).toISOString().slice(0, 10)).toBe('2027-01-05');
    });

    it('a missing or nonsense day is the 1st, never a crash', () => {
        expect(dueDateFor(undefined, 2026, 5).toISOString().slice(0, 10)).toBe('2026-06-01');
        expect(dueDateFor('abc', 2026, 5).toISOString().slice(0, 10)).toBe('2026-06-01');
        expect(dueDateFor(0, 2026, 5).toISOString().slice(0, 10)).toBe('2026-06-01');
    });

    it('monthKeyOf matches the key the app already stores confirmations under', () => {
        expect(monthKeyOf(new Date(Date.UTC(2026, 8, 5)))).toBe('2026-09');
        expect(receivedKey('abc', '2026-09')).toBe('abc_2026-09');
        expect(billKey('abc', '2026-09')).toBe('abc_2026-09');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CADENCE — the bug nothing else reads
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('how often a source actually pays', () => {
    it('reads the record’s own freq', () => {
        expect(periodMonths('monthly')).toBe(1);
        expect(periodMonths('quarterly')).toBe(3);
        expect(periodMonths('annual')).toBe(12);
    });

    it('anything unset is monthly — the shape most records have', () => {
        expect(periodMonths(undefined)).toBe(1);
        expect(periodMonths('')).toBe(1);
        expect(periodMonths('weird')).toBe(1);
    });

    it('AN ANNUAL PAYOUT IS NOT A MONTHLY ONE', () => {
        /* The defect this closes. `monthly` holds the per-payout figure for
         * every cadence, so reading it without freq asks twelve times a year
         * for money that comes once — and, in the projection, counts the whole
         * annual figure in every month. */
        const a = { id: 'a1', monthly: 120000, day: 20, start: '2025-04-20', freq: 'annual' };
        expect(paysInMonth(a, 2026, 3)).toBe(true);      // April 2026
        for (const m of [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11]) {
            expect(paysInMonth(a, 2026, m), `month ${m} must not pay`).toBe(false);
        }
    });

    it('quarterly pays every third month from the start', () => {
        const q = { id: 'q1', monthly: 45000, day: 10, start: '2026-01-10', freq: 'quarterly' };
        expect([3, 6, 9].every((m) => paysInMonth(q, 2026, m))).toBe(true);
        expect([0, 1, 2, 4, 5, 7, 8].some((m) => paysInMonth(q, 2026, m))).toBe(false);
    });

    it('the first payout is one full period AFTER the start, never on it', () => {
        /* index.html states the monthly half of this rule where it auto-marks
         * pre-join months: an investment placed on 15 April first pays on
         * 15 May. This is the same rule at every cadence. */
        const m = monthly({ start: '2026-04-05' });
        expect(paysInMonth(m, 2026, 3)).toBe(false);     // the month it started
        expect(paysInMonth(m, 2026, 4)).toBe(true);      // one month later
    });

    it('a source that has ended stops paying', () => {
        const m = monthly({ end: '2026-06-30' });
        expect(paysInMonth(m, 2026, 5)).toBe(true);
        expect(paysInMonth(m, 2026, 6)).toBe(false);
    });

    it('with no start date, the cadence decides — and only the honest half', () => {
        /* A monthly source pays every month whatever its anchor, so an
         * unanchored one keeps behaving as it always has; dropping it would
         * remove real records from a real projection over a missing field.
         * A quarterly or annual one cannot be placed at all without an anchor —
         * there is no way to know WHICH month — and asking in all of them is
         * exactly the bug this function exists to fix. */
        expect(paysInMonth({ id: 'x', monthly: 1, day: 1 }, 2026, 5)).toBe(true);
        expect(paysInMonth({ id: 'x', monthly: 1, day: 1, freq: 'monthly' }, 2026, 5)).toBe(true);
        expect(paysInMonth({ id: 'x', monthly: 1, day: 1, freq: 'annual' }, 2026, 5)).toBe(false);
        expect(paysInMonth({ id: 'x', monthly: 1, day: 1, freq: 'quarterly' }, 2026, 5)).toBe(false);
        expect(paysInMonth(null, 2026, 5)).toBe(false);
    });

    it('an end date still stops an unanchored source', () => {
        expect(paysInMonth({ id: 'x', monthly: 1, day: 1, end: '2026-05-31' }, 2026, 5)).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE QUEUE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('what is waiting to be answered', () => {
    const base = () => ({ income: [monthly()], incomeReceived: {}, incomeDelayed: {} });

    it('a payout whose date has passed and nobody answered is PENDING', () => {
        const rows = pendingInflows(base(), AT('2026-09-10'), { lookbackMonths: 1 });
        const sep = rows.find((r) => r.monthKey === '2026-09');
        expect(sep).toBeTruthy();
        expect(sep.state).toBe(VERIFY.PENDING);
        expect(sep.amount).toBe(300000);
        expect(sep.dueISO).toBe('2026-09-05');
    });

    it('A DATE THAT HAS NOT ARRIVED IS NOT A QUESTION', () => {
        /* The queue asks "did this arrive". Tomorrow has no answer, and a row
         * that appears before its date teaches the owner to confirm money they
         * have not received — which is the corruption this whole design exists
         * to prevent. */
        const rows = pendingInflows(base(), AT('2026-09-04'), { lookbackMonths: 1 });
        expect(rows.some((r) => r.monthKey === '2026-09')).toBe(false);
    });

    it('the due day itself counts as arrived', () => {
        const rows = pendingInflows(base(), AT('2026-09-05'), { lookbackMonths: 1 });
        expect(rows.some((r) => r.monthKey === '2026-09')).toBe(true);
    });

    it('AN ANSWERED PAYOUT NEVER COMES BACK', () => {
        const A = base();
        A.incomeReceived['m1_2026-09'] = { confirmedAt: 1 };
        const rows = pendingInflows(A, AT('2026-09-10'), { lookbackMonths: 1 });
        expect(rows.some((r) => r.monthKey === '2026-09')).toBe(false);
    });

    it('a pre-join auto-marked month is answered too', () => {
        /* saveIncome writes `{auto:true, historical:true}` for months before
         * the owner joined. Truthy is the answer; the queue must not re-ask
         * because the shape is different. */
        const A = base();
        A.incomeReceived['m1_2026-08'] = { auto: true, historical: true };
        const rows = pendingInflows(A, AT('2026-09-10'), { lookbackMonths: 2 });
        expect(rows.some((r) => r.monthKey === '2026-08')).toBe(false);
    });

    it('months the owner never opened the app for are all still there', () => {
        /* The case the queue was built for. A banner is a moment; this is not. */
        const rows = pendingInflows(base(), AT('2026-09-10'), { lookbackMonths: 4 });
        expect(rows.map((r) => r.monthKey)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    });

    it('oldest first — the oldest unanswered question is the one most likely wrong', () => {
        const rows = pendingInflows(base(), AT('2026-09-10'), { lookbackMonths: 3 });
        const dates = rows.map((r) => r.dueISO);
        expect([...dates].sort()).toEqual(dates);
    });

    it('lateness is counted in days, with a grace period', () => {
        const rows = pendingInflows(base(), AT('2026-09-06'), { lookbackMonths: 0 });
        expect(rows[0].daysLate).toBe(1);
        expect(rows[0].late).toBe(false);                          // inside the grace
        const later = pendingInflows(base(), AT('2026-09-05'), { lookbackMonths: 0 });
        expect(later[0].daysLate).toBe(0);
        const past = pendingInflows(base(), AT('2026-09-20'), { lookbackMonths: 0 });
        expect(past[0].daysLate).toBe(15);
        expect(past[0].late).toBe(true);
        expect(LATE_AFTER_DAYS).toBeGreaterThan(0);
    });

    it('a flagged payout reads DELAYED and STAYS IN THE QUEUE', () => {
        /* A delayed payout is not a dismissed one. The flag changes what the
         * row says, not whether it is asked. */
        const A = base();
        A.incomeDelayed['m1_2026-09'] = { at: 1 };
        const rows = pendingInflows(A, AT('2026-09-10'), { lookbackMonths: 1 });
        const sep = rows.find((r) => r.monthKey === '2026-09');
        expect(sep).toBeTruthy();
        expect(sep.state).toBe(VERIFY.DELAYED);
    });

    it('a source with no payout figure asks nothing', () => {
        const A = { income: [monthly({ monthly: 0 })] };
        expect(pendingInflows(A, AT('2026-09-10'))).toEqual([]);
    });

    it('junk data cannot throw', () => {
        expect(pendingInflows(null, AT('2026-09-10'))).toEqual([]);
        /* No id, no amount, not an object — none of these can produce a
         * question worth answering, and none of them may throw on the page the
         * app opens on. */
        expect(pendingInflows({ income: [null, {}, { id: 'x' }] }, AT('2026-09-10'))).toEqual([]);
        expect(pendingInflows({ income: [monthly()] }, new Date('nope'))).toEqual([]);
        expect(pendingOutflows(null, AT('2026-09-10'))).toEqual([]);
    });

    it('the default lookback is a real window, not one month', () => {
        expect(LOOKBACK_MONTHS).toBeGreaterThanOrEqual(3);
    });
});

describe('the bills side — insurance premiums and the rest', () => {
    const sub = (over = {}) => ({
        id: 's1', name: 'Softlogic Life', category: 'Insurance',
        amount: 18500, dueDay: 1, createdAt: '2026-01-01T00:00:00Z', ...over,
    });

    it('a bill past its due day with no record is pending', () => {
        const rows = pendingOutflows({ subscriptions: [sub()] }, AT('2026-09-10'), { lookbackMonths: 0 });
        expect(rows.length).toBe(1);
        expect(rows[0].kind).toBe('outflow');
        expect(rows[0].amount).toBe(18500);
    });

    it('A MONTH THE OWNER ALREADY TYPED A FIGURE INTO IS ANSWERED', () => {
        /* The per-month override editor writes that figure. Asking again would
         * be the app failing to read its own records. */
        const rows = pendingOutflows(
            { subscriptions: [sub({ monthOverrides: { '2026-09': 19000 } })] },
            AT('2026-09-10'), { lookbackMonths: 0 },
        );
        expect(rows.length).toBe(0);
    });

    it('confirming through the queue answers it too', () => {
        const rows = pendingOutflows(
            { subscriptions: [sub()], billPaid: { 's1_2026-09': { confirmedAt: 1 } } },
            AT('2026-09-10'), { lookbackMonths: 0 },
        );
        expect(rows.length).toBe(0);
    });

    it('never asks about a month before the bill was recorded', () => {
        /* The record is not evidence that the bill existed then. */
        const rows = pendingOutflows(
            { subscriptions: [sub({ createdAt: '2026-08-15T00:00:00Z' })] },
            AT('2026-09-10'), { lookbackMonths: 6 },
        );
        expect(rows.map((r) => r.monthKey)).toEqual(['2026-09']);
    });
});

describe('the total the card shows', () => {
    it('separates money in from money out, and counts what is late', () => {
        const t = queueTotals([
            { kind: 'inflow', amount: 100, state: VERIFY.PENDING, late: true },
            { kind: 'inflow', amount: 200, state: VERIFY.DELAYED, late: true },
            { kind: 'outflow', amount: 50, state: VERIFY.PENDING, late: false },
        ]);
        expect(t).toEqual({ count: 3, inflow: 300, outflow: 50, delayed: 1, late: 1 });
    });

    it('an empty queue totals to zero rather than NaN', () => {
        expect(queueTotals(null)).toEqual({ count: 0, inflow: 0, outflow: 0, delayed: 0, late: 0 });
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IT IS WIRED, AND IT WRITES NOTHING IT SHOULD NOT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the page actually draws it', () => {
    function fn(name) {
        const decl = new RegExp(`^[ \\t]*(?:async )?function ${name}\\s*\\(`, 'm');
        const m = decl.exec(HTML);
        if (!m) return '';
        const after = HTML.slice(m.index + m[0].length);
        const next = after.search(/^ {8}(?:async )?function \w+\s*\(/m);
        return next < 0 ? HTML.slice(m.index) : HTML.slice(m.index, m.index + m[0].length + next);
    }

    it('the module is loaded, as a module', () => {
        /* It is ESM. A plain <script> tag would fail on the export statement
         * and window.WFVerify would never exist — the card would then be
         * permanently hidden, silently. */
        expect(HTML).toContain('<script type="module" src="wealthflow-verify-matrix.js"></script>');
    });

    it('there is a host element for it on the dashboard', () => {
        expect(HTML).toContain('id="wfVerifyQueue"');
    });

    it('AND renderDash CALLS IT', () => {
        /* The defect this repository repeats: a facility built and wired to
         * nobody. The Statement Sync card was once wired inside wfSweepRecord()
         * and never appeared on boot. */
        expect(fn('renderDash')).toContain('renderVerifyQueue()');
    });

    it('the buttons are wired to the two answers', () => {
        const body = fn('renderVerifyQueue');
        expect(body).toMatch(/data-vq-ok[\s\S]{0,600}_verifyConfirm\(/);
        expect(body).toMatch(/data-vq-late[\s\S]{0,600}_verifyFlagLate\(/);
    });

    it('CONFIRMING A BILL WRITES NO EXPENSE ROW', () => {
        /* The subscription record IS the commitment and is already counted.
         * An expense row here would double every premium the moment this
         * screen was used — the exact corruption the human-in-the-loop rule
         * exists to prevent. */
        const body = fn('_verifyConfirm');
        expect(body).toContain("DB.set('billPaid'");
        expect(body).toContain("DB.set('incomeReceived'");
        expect(body).not.toMatch(/DB\.set\('expenses'/);
        expect(body).not.toMatch(/DB\.set\('incomeRecv'/);
    });

    it('confirming clears any late flag on the same item', () => {
        const body = fn('_verifyConfirm');
        expect(body).toContain("DB.set('incomeDelayed'");
        expect(body).toContain("DB.set('billDelayed'");
    });

    it('THE NEW KEYS ARE DECLARED ON appData', () => {
        /* The hydration loops iterate appData's OWN keys, so a key missing
         * from the default object is never read back from disk or the cloud.
         * That defect once dropped incomeRecv and subscriptions. */
        const defaults = HTML.slice(HTML.indexOf('let appData = {'), HTML.indexOf('let isInitialised'));
        for (const k of ['incomeDelayed', 'billPaid', 'billDelayed']) {
            expect(defaults, `${k} is missing from appData's defaults`).toContain(`${k}:`);
        }
    });

    it('and they survive a factory reset the same way the others do', () => {
        const reset = HTML.slice(HTML.indexOf('const _wipeStamp = Date.now();'));
        const shape = reset.slice(0, reset.indexOf('};'));
        for (const k of ['incomeDelayed', 'billPaid', 'billDelayed']) {
            expect(shape, `${k} is missing from the reset shape`).toContain(`${k}:`);
        }
    });

    it('THE PAY-DAY REMINDER READS THE CADENCE TOO', () => {
        /* One rule, both places. The banner asked on the pay day of every
         * month regardless of freq, so an annual payout was asked about twelve
         * times a year — and a reminder that is wrong eleven times out of
         * twelve is a reminder nobody reads. */
        const body = fn('checkActionableReminders');
        expect(body).toContain('window.WFVerify.paysInMonth(src,');
    });

    it('and the projection reads it, from the same function', () => {
        /* Two answers to "does this pay in September" is how a screen and a
         * projection end up disagreeing about the same record. */
        const engine = fs.readFileSync(path.join(ROOT, 'wealthflow-cashflow-engine.js'), 'utf8');
        expect(engine).toContain("import { paysInMonth } from './wealthflow-verify-matrix.js';");
        expect(engine).toContain('if (!paysInMonth(i, from.getUTCFullYear(), from.getUTCMonth() + k)) continue;');
    });

    it('the card says the money has not been counted', () => {
        /* A total that reads like money you have is the exact confusion this
         * queue exists to prevent. */
        expect(fn('renderVerifyQueue')).toContain('Nothing here has been added to your balance');
    });

    it('it hides itself when there is nothing to answer', () => {
        const body = fn('renderVerifyQueue');
        expect(body).toMatch(/if \(!rows\.length\)[\s\S]{0,400}display = 'none'/);
    });

    it('the API surface the page uses is the one the module exports', () => {
        for (const k of ['pendingInflows', 'pendingOutflows', 'queueTotals', 'VERIFY']) {
            expect(M[k], `${k} missing from the default export`).toBeTruthy();
        }
        const body = fn('renderVerifyQueue');
        expect(body).toContain('window.WFVerify.pendingInflows(');
        expect(body).toContain('window.WFVerify.pendingOutflows(');
        expect(body).toContain('window.WFVerify.queueTotals(');
    });
});
