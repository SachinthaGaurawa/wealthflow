/* =============================================================================
 * test/cashflow_engine_test.js
 * -----------------------------------------------------------------------------
 * The engine answers "on which day do I run out, and what causes it". Both
 * halves have to be right: a runway date nobody can act on is a number, and a
 * cause attached to the wrong date is worse than silence.
 *
 * Every field the engine reads was taken from the code that writes it
 * (saveLoan, saveCheque, saveIncomeRecv, renderBalance, …), so the fixtures
 * below use those exact shapes. A fixture that invented a field would prove the
 * engine works on data that does not exist.
 *
 * `asOf` is passed everywhere. Nothing here depends on the day the suite runs.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    isoDay, parseDay, addDays, dayInMonth, monthsBetween,
    openingBalance, commitments, variableDailySpend,
    project, safeToSpend, simulate, summarise,
} from '../wealthflow-cashflow-engine.js';

const AS_OF = '2026-08-26';
const D = (s) => parseDay(s);

/** A realistic ledger, in the shapes the app actually stores. */
const LEDGER = () => ({
    balance: { total: 250000, flows: [{ type: 'out', amount: 50000, date: '2026-08-01' }] },
    loans: [{ id: 'L1', name: 'BOC Home', bank: 'BOC', amount: 2000000, rate: 12,
        duration: 60, monthly: 45000, start: '2026-03-05', paymentMethod: 'emi', skipped: [] }],
    ccinstall: [{ id: 'C1', product: 'Laptop', bank: 'HNB', total: 144000,
        duration: 12, monthly: 12000, date: '2026-06-20', completed: false, skipped: [] }],
    subscriptions: [
        { id: 'S1', name: 'Netflix', amount: 1990, dueDay: 12, cycle: 'monthly', createdAt: '2026-01-12T00:00:00Z' },
        { id: 'S2', name: 'Domain', amount: 9000, dueDay: 3, cycle: 'yearly', createdAt: '2026-09-03T00:00:00Z' },
    ],
    cheques: [
        { id: 'Q1', no: '4471', party: 'Perera Hardware', type: 'issued', amount: 180000, issue: '2026-08-15', release: '2026-09-15', status: 'pending' },
        { id: 'Q2', no: '9001', party: 'Client', type: 'received', amount: 60000, issue: '2026-09-02', release: '2026-10-02', status: 'pending' },
        { id: 'Q3', no: '0001', party: 'Settled', type: 'issued', amount: 999999, release: '2026-09-08', status: 'cleared' },
    ],
    incomeRecv: [
        { id: 'R1', name: 'Consulting', type: 'Other', amount: 85000, month: '2026-09', date: '2026-09-20', received: false },
        { id: 'R2', name: 'Already in', type: 'Other', amount: 500000, month: '2026-09', date: '2026-09-04', received: true },
    ],
    income: [{ id: 'I1', name: 'FD interest', company: 'BOC', monthly: 22000, day: 1, start: '2025-01-01', freq: 'monthly' }],
    expenses: [
        { id: 'E1', desc: 'Rent', cat: 'Housing', amount: 55000, month: '2026-08', recurring: true, completed: false },
        { id: 'E2', desc: 'Groceries', cat: 'Food', amount: 18000, month: '2026-07', recurring: false },
        { id: 'E3', desc: 'Fuel', cat: 'Transport', amount: 12000, month: '2026-07', recurring: false },
        { id: 'E4', desc: 'Groceries', cat: 'Food', amount: 21000, month: '2026-06', recurring: false },
    ],
});

const of = (res, source) => res.items.filter((i) => i.source === source);

/* ═══════════════════════════════════════════════════════════════════════════
 * DATES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('date handling', () => {
    it('clamps a day-of-month to the length of the month', () => {
        // A standing order set for the 31st must not skip February entirely, and
        // must not roll forward into March — which is what a naive
        // Date(y, m, 31) does.
        expect(isoDay(dayInMonth(2026, 1, 31))).toBe('2026-02-28');
        expect(isoDay(dayInMonth(2028, 1, 31))).toBe('2028-02-29');
        expect(isoDay(dayInMonth(2026, 3, 31))).toBe('2026-04-30');
        expect(isoDay(dayInMonth(2026, 0, 31))).toBe('2026-01-31');
    });

    it('a dueDay of 31 produces one charge per month, never two in one', () => {
        const months = [0, 1, 2, 3].map((k) => isoDay(dayInMonth(2026, k, 31)).slice(0, 7));
        expect(new Set(months).size).toBe(4);
    });

    it('counts months by calendar, not by 30-day arithmetic', () => {
        expect(monthsBetween(D('2026-01-31'), D('2026-03-01'))).toBe(2);
        expect(monthsBetween(D('2026-12-01'), D('2027-01-01'))).toBe(1);
        expect(monthsBetween(D('2026-03-01'), D('2026-01-01'))).toBe(-2);
    });

    it('rejects unusable dates instead of inventing one', () => {
        expect(parseDay(null)).toBe(null);
        expect(parseDay('')).toBe(null);
        expect(parseDay('not a date')).toBe(null);
        expect(isoDay(parseDay('2026-09-15'))).toBe('2026-09-15');
        expect(isoDay(parseDay('2026-09-15T22:30:00Z'))).toBe('2026-09-15');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * OPENING BALANCE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('openingBalance', () => {
    it('is total minus outflows plus inflows, the same as the Balance page', () => {
        // If this drifts from renderBalance(), two screens show two numbers and
        // the user has to guess which to trust.
        expect(openingBalance({ balance: { total: 250000, flows: [{ type: 'out', amount: 50000 }] } }))
            .toBe(200000);
        expect(openingBalance({ balance: { total: 100, flows: [
            { type: 'in', amount: 30 }, { type: 'out', amount: 10 }, { type: 'in', amount: 5 }] } }))
            .toBe(125);
    });

    it('is 0, not NaN, when there is no balance record at all', () => {
        expect(openingBalance({})).toBe(0);
        expect(openingBalance(null)).toBe(0);
        expect(openingBalance({ balance: { total: '1,500', flows: null } })).toBe(1500);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * COMMITMENTS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('commitments', () => {
    const res = () => commitments(LEDGER(), D(AS_OF), addDays(D(AS_OF), 90));

    it('walks loan instalments onto the start date day-of-month', () => {
        const loans = of(res(), 'loans');
        expect(loans.map((l) => l.date)).toEqual(['2026-09-05', '2026-10-05', '2026-11-05']);
        expect(loans.every((l) => l.amount === 45000)).toBe(true);
        expect(loans[0].certainty).toBe('committed');
        // instalment 1 is in the START month (March), so September is the 7th.
        // This assertion originally said 7, the engine said 6, and I changed the
        // TEST to match the engine without checking which was right. It was the
        // engine that was wrong: _loanInstallmentMonths() in index.html numbers
        // from i = 0 at the start month, so the loan page calls this payment 7.
        // Adjusting an assertion to whatever the code already does is how a
        // suite stops being evidence of anything.
        expect(loans[0].label).toContain('7/60');
    });

    it('honours a skipped month, by month key or by instalment index', () => {
        // Sep is instalment 7, Oct 8, Nov 9 — so '2026-10' and '8' name the
        // same payment, and both spellings appear in stored records.
        for (const skipped of [['2026-10'], ['8']]) {
            const A = LEDGER(); A.loans[0].skipped = skipped;
            const dates = of(commitments(A, D(AS_OF), addDays(D(AS_OF), 90)), 'loans').map((l) => l.date);
            expect(dates, `skipped=${JSON.stringify(skipped)}`).toEqual(['2026-09-05', '2026-11-05']);
        }
    });

    it('stops at the end of the loan term rather than projecting forever', () => {
        // duration 7 from 2026-03 covers Mar..Sep inclusive, so the last payment
        // is 2026-09-05 and October is NOT owed. The engine used to emit it,
        // because the series ran one month past the term.
        const A = LEDGER();
        A.loans[0].duration = 7;
        const dates = of(commitments(A, D(AS_OF), addDays(D(AS_OF), 90)), 'loans').map((l) => l.date);
        expect(dates).toEqual(['2026-09-05']);
    });

    it('numbers instalment 1 into the START month, matching the loan page', () => {
        /* THE AUTHORITY IS index.html's _loanInstallmentMonths():
         *     for (let i = 0; i < l.duration; i++)
         *         new Date(start.getFullYear(), start.getMonth() + i, 1)
         * i = 0 is the start month. Mirrored here rather than imported, because
         * that function lives inside a 27,000-line HTML file — so this test also
         * fails if the two ever diverge in either direction. */
        const appMonths = (startISO, duration) => {
            const [y, m] = startISO.split('-').map(Number);
            return Array.from({ length: duration },
                (_, i) => new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 7));
        };
        const A = LEDGER();
        A.loans[0].start = '2026-03-05';
        A.loans[0].duration = 12;
        // A window wide enough to contain the whole term.
        const got = of(commitments(A, D('2026-01-01'), D('2027-12-31')), 'loans');
        expect(got.map((g) => g.date.slice(0, 7))).toEqual(appMonths('2026-03-05', 12));
        expect(got[0].label).toContain('1/12');
        expect(got[0].date).toBe('2026-03-05');
        expect(got[got.length - 1].date).toBe('2027-02-05');
    });

    it('numbers a card plan from its start month too, and stops at the term', () => {
        /* Card instalments follow the same convention as loans, and the app
         * bounds them the same way — the dashboard's upcoming list uses
         *     endD = new Date(c.date); endD.setMonth(endD.getMonth() + c.duration)
         * as an EXCLUSIVE end, so a 12-month plan from 2026-06 runs to 2027-05.
         *
         * Without this the ccinstall loop had no test that distinguished the two
         * conventions: the ledger's plan starts 2026-06-20, and inside a 90-day
         * window opening 2026-08-26 both the right answer and the off-by-one
         * produce Sep/Oct/Nov. Reverting the fix left the suite green. */
        const A = LEDGER();
        A.ccinstall[0].date = '2026-06-20';
        A.ccinstall[0].duration = 12;
        const got = of(commitments(A, D('2026-01-01'), D('2027-12-31')), 'ccinstall');
        expect(got[0].date).toBe('2026-06-20');
        expect(got[0].label).toContain('1/12');
        expect(got[got.length - 1].date).toBe('2027-05-20');
        expect(got.length).toBe(12);
    });

    it('drops a card plan once it is completed', () => {
        expect(of(res(), 'ccinstall').length).toBeGreaterThan(0);
        const A = LEDGER(); A.ccinstall[0].completed = true;
        expect(of(commitments(A, D(AS_OF), addDays(D(AS_OF), 90)), 'ccinstall')).toEqual([]);
    });

    it('renews a monthly subscription every month and a yearly one once', () => {
        const subs = of(res(), 'subscriptions');
        const monthly = subs.filter((s) => s.label.startsWith('Netflix'));
        const yearly = subs.filter((s) => s.label.startsWith('Domain'));
        expect(monthly.map((s) => s.date)).toEqual(['2026-09-12', '2026-10-12', '2026-11-12']);
        expect(yearly.map((s) => s.date)).toEqual(['2026-09-03']);
    });

    it('anchors a quarterly cycle on the record, not on the window', () => {
        // A quarterly renewal created in January is due in Jan/Apr/Jul/Oct. A
        // window opened in August must not restart the cycle in August.
        const A = LEDGER();
        A.subscriptions = [{ id: 'S9', name: 'Hosting', amount: 7500, dueDay: 9,
            cycle: 'quarterly', createdAt: '2026-01-09T00:00:00Z' }];
        const dates = of(commitments(A, D(AS_OF), addDays(D(AS_OF), 120)), 'subscriptions')
            .map((s) => s.date);
        expect(dates).toEqual(['2026-10-09']);
    });

    it('projects a pending issued cheque out and a pending received cheque in', () => {
        const cq = of(res(), 'cheques');
        const issued = cq.find((c) => c.id === 'Q1');
        const received = cq.find((c) => c.id === 'Q2');
        expect(issued.kind).toBe('out');
        expect(issued.date).toBe('2026-09-15');
        expect(received.kind).toBe('in');
        expect(received.date).toBe('2026-10-02');
    });

    it('never projects a cheque that has already cleared', () => {
        // Q3 is 999,999 and cleared. Projecting it would invent a catastrophe.
        expect(of(res(), 'cheques').some((c) => c.id === 'Q3')).toBe(false);
    });

    it('skips a receivable that has already been received', () => {
        const rec = of(res(), 'incomeRecv');
        expect(rec.map((r) => r.id)).toEqual(['R1']);
    });

    it('marks investment income and undated recurring expenses as expected, not committed', () => {
        // The amounts are known; the DAYS are not. Calling them committed would
        // put a precision on them that the stored record does not carry —
        // `expenses` holds only 'YYYY-MM'.
        const r = res();
        expect(of(r, 'income').every((i) => i.certainty === 'expected')).toBe(true);
        expect(of(r, 'expenses').every((e) => e.certainty === 'expected')).toBe(true);
        expect(of(r, 'loans').every((l) => l.certainty === 'committed')).toBe(true);
        expect(of(r, 'cheques').every((c) => c.certainty === 'committed')).toBe(true);
    });

    it('projects one series per recurring expense, not one row per stored month', () => {
        const A = LEDGER();
        A.expenses.push({ id: 'E1b', desc: 'Rent', cat: 'Housing', amount: 55000, month: '2026-07', recurring: true, completed: false });
        const rent = of(commitments(A, D(AS_OF), addDays(D(AS_OF), 90)), 'expenses')
            .filter((e) => e.label === 'Rent');
        expect(rent.map((e) => e.date)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    });

    it('stays strictly inside the window on both edges', () => {
        const r = commitments(LEDGER(), D('2026-09-05'), D('2026-09-15'));
        expect(r.items.every((i) => i.date >= '2026-09-05' && i.date <= '2026-09-15')).toBe(true);
        expect(r.items.some((i) => i.date === '2026-09-05')).toBe(true);
        expect(r.items.some((i) => i.date === '2026-09-15')).toBe(true);
    });

    it('records what it could not use instead of guessing at it', () => {
        // A projection built on invented data is worse than no projection,
        // because it gets believed.
        const A = LEDGER();
        A.loans.push({ id: 'L2', name: 'No start date', monthly: 30000, duration: 12 });
        A.cheques.push({ id: 'Q4', no: '5', party: 'X', type: 'issued', amount: 1000, status: 'pending' });
        const r = commitments(A, D(AS_OF), addDays(D(AS_OF), 90));
        expect(r.ignored).toEqual([
            { source: 'loans', id: 'L2', why: 'no start, duration or monthly amount' },
            { source: 'cheques', id: 'Q4', why: 'no release or issue date' },
        ]);
        expect(r.items.some((i) => i.id === 'L2' || i.id === 'Q4')).toBe(false);
    });

    it('survives a ledger of nulls and junk without throwing', () => {
        const junk = {
            loans: [null, {}, { monthly: 'abc', duration: 'x', start: 'nope' }],
            cheques: [null, { type: 'issued' }],
            subscriptions: [undefined, { amount: 0 }],
            expenses: 'not an array', income: null, incomeRecv: 7, ccinstall: {},
        };
        const r = commitments(junk, D(AS_OF), addDays(D(AS_OF), 90));
        expect(r.items).toEqual([]);
    });

    it('returns items sorted by date', () => {
        const dates = res().items.map((i) => i.date);
        expect(dates).toEqual([...dates].sort());
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE VARIABLE SLICE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('variableDailySpend', () => {
    it('excludes recurring expenses, which commitments() already projects', () => {
        // Counting rent twice is the obvious way to make the whole projection
        // pessimistic and useless.
        //
        // The recurring expense HAS TO BE INSIDE THE LOOKBACK WINDOW for this to
        // test anything. The ledger's own Rent row sits in 2026-08, which the
        // three-month window (Jul/Jun/May) never looks at — so the first version
        // of this test passed with the `recurring` filter deleted entirely.
        const A = LEDGER();
        A.expenses.push({ id: 'E7', desc: 'Rent', cat: 'Housing', amount: 55000,
            month: '2026-07', recurring: true, completed: false });
        const v = variableDailySpend(A, D(AS_OF), 3);
        // Jul: 18000 + 12000 (the 55000 rent is recurring). Jun: 21000.
        expect(v.perMonth).toBeCloseTo((30000 + 21000) / 2, 6);
        expect(v.monthsObserved).toBe(2);
    });

    it('looks only at complete months before asOf', () => {
        const A = LEDGER();
        A.expenses.push({ id: 'E9', desc: 'This month', amount: 999999, month: '2026-08', recurring: false });
        expect(variableDailySpend(A, D(AS_OF), 3).perMonth)
            .toBeCloseTo((30000 + 21000) / 2, 6);
    });

    it('returns zero rather than a guess when there is no history', () => {
        const v = variableDailySpend({ expenses: [] }, D(AS_OF), 3);
        expect(v).toEqual({ perDay: 0, perMonth: 0, monthsObserved: 0, spread: 0 });
    });

    it('reports no spread from a single month, because one point has none', () => {
        const A = { expenses: [{ id: 'x', desc: 'a', amount: 40000, month: '2026-07' }] };
        const v = variableDailySpend(A, D(AS_OF), 3);
        expect(v.monthsObserved).toBe(1);
        expect(v.spread).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PROJECTION
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('project', () => {
    const p = () => project(LEDGER(), { asOf: AS_OF, horizon: 90 });

    it('starts at the opening balance and covers horizon + today', () => {
        const r = p();
        expect(r.opening).toBe(200000);
        expect(r.days.length).toBe(91);
        expect(r.days[0].date).toBe(AS_OF);
        expect(r.days[90].date).toBe('2026-11-24');
    });

    it('does not charge variable spend against the day already under way', () => {
        // Day 0 is today's closing position; money spent earlier today is
        // already out of the balance the user is looking at.
        const r = p();
        expect(r.days[0].variable).toBe(0);
        expect(r.days[1].variable).toBeGreaterThan(0);
    });

    it('applies each commitment on its own day', () => {
        const r = p();
        const d = r.days.find((x) => x.date === '2026-09-15');
        expect(d.out).toBeGreaterThanOrEqual(180000);
        expect(d.events.some((e) => e.id === 'Q1')).toBe(true);
    });

    it('names the runway date and the commitments that caused it', () => {
        const r = p();
        expect(r.runway.date).toBe('2026-09-15');
        expect(r.runway.daysAway).toBe(20);
        expect(r.runway.causes.map((c) => c.id)).toContain('Q1');
    });

    it('reports no runway at all when the balance never goes under', () => {
        const A = LEDGER();
        A.balance.total = 5000000;
        const r = project(A, { asOf: AS_OF, horizon: 90 });
        expect(r.runway).toBe(null);
        expect(r.tightest).not.toBe(null);        // there is still a lowest point
    });

    it('respects a floor above zero', () => {
        // Someone who must keep 100,000 in the account is in trouble earlier
        // than someone who can run it to nothing.
        const zero = project(LEDGER(), { asOf: AS_OF, horizon: 90, floor: 0 });
        const cushion = project(LEDGER(), { asOf: AS_OF, horizon: 90, floor: 100000 });
        expect(cushion.runway.daysAway).toBeLessThan(zero.runway.daysAway);
    });

    it('can be asked for committed movements only', () => {
        const withVar = project(LEDGER(), { asOf: AS_OF, horizon: 90 });
        const without = project(LEDGER(), { asOf: AS_OF, horizon: 90, includeVariable: false });
        expect(without.days.every((d) => d.variable === 0)).toBe(true);
        expect(without.closing).toBeGreaterThan(withVar.closing);
    });

    it('is deterministic — the same ledger and asOf give the same answer', () => {
        expect(JSON.stringify(p())).toBe(JSON.stringify(p()));
    });

    it('never runs unbounded, however large a horizon is asked for', () => {
        expect(project(LEDGER(), { asOf: AS_OF, horizon: 100000 }).horizon).toBe(730);
        expect(project(LEDGER(), { asOf: AS_OF, horizon: -5 }).horizon).toBe(1);
    });

    it('refuses an asOf it cannot parse rather than silently using today', () => {
        // Falling back to `new Date()` would make every downstream number depend
        // on the clock, and the failure would be invisible.
        expect(() => project(LEDGER(), { asOf: 'whenever' })).toThrow(TypeError);
    });

    it('projects an empty ledger to a flat line at zero', () => {
        const r = project({}, { asOf: AS_OF, horizon: 30 });
        expect(r.opening).toBe(0);
        expect(r.closing).toBe(0);
        expect(r.commitments).toEqual([]);
        expect(r.runway).toBe(null);          // 0 is not below a floor of 0
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SAFE TO SPEND
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('safeToSpend', () => {
    it('is the lowest point before the next inflow, not an average', () => {
        // An average is no use on the day before a 180,000 cheque clears.
        const s = safeToSpend(LEDGER(), { asOf: AS_OF, horizon: 90 });
        const p = project(LEDGER(), { asOf: AS_OF, horizon: 90 });
        const low = Math.min(...p.days.filter((d) => d.date <= s.until).map((d) => d.balance));
        expect(s.amount).toBeCloseTo(Math.max(0, low), 6);
        expect(s.until).toBe('2026-09-01');       // FD interest is the next money in
    });

    it('never goes negative — you cannot safely spend a debt', () => {
        const A = LEDGER();
        A.balance.total = 0; A.balance.flows = [];
        expect(safeToSpend(A, { asOf: AS_OF, horizon: 90 }).amount).toBe(0);
    });

    it('falls back to the end of the horizon when no money is expected', () => {
        const A = LEDGER();
        A.income = []; A.incomeRecv = []; A.cheques = A.cheques.filter((c) => c.type === 'issued');
        const s = safeToSpend(A, { asOf: AS_OF, horizon: 30 });
        expect(s.until).toBe('2026-09-25');
        expect(s.reason).toContain('no inflow');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BAND
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('simulate', () => {
    it('is reproducible for a given seed', () => {
        // An advice screen that shows a different runway date each time it is
        // opened is noise, not advice — and it cannot be tested.
        const a = simulate(LEDGER(), { asOf: AS_OF, horizon: 60, runs: 120, seed: 7 });
        const b = simulate(LEDGER(), { asOf: AS_OF, horizon: 60, runs: 120, seed: 7 });
        expect(a.bands).toEqual(b.bands);
        expect(a.shortfallProbability).toBe(b.shortfallProbability);
    });

    it('gives a different answer for a different seed, so it is really sampling', () => {
        const a = simulate(LEDGER(), { asOf: AS_OF, horizon: 60, runs: 120, seed: 7 });
        const b = simulate(LEDGER(), { asOf: AS_OF, horizon: 60, runs: 120, seed: 999 });
        expect(JSON.stringify(a.bands)).not.toBe(JSON.stringify(b.bands));
    });

    it('holds committed outflows FIXED across every path', () => {
        /* This is the central design claim of the module: a loan EMI is not a
         * random variable, and randomising it would widen the band with noise
         * that does not exist.
         *
         * IT HAS TO BE TESTED THROUGH THE PATHS, NOT THROUGH `committed`.
         * The first version compared `a.committed` against `b.committed` — the
         * deterministic projection that `simulate` computes once up front. That
         * object is identical no matter what the sampling loop does to it
         * afterwards, so a mutation multiplying every outflow by a random factor
         * inside the loop left the assertion perfectly green.
         *
         * The property that actually distinguishes the two: with NO spending
         * history the variable slice is exactly zero, so if committed flows are
         * applied unrandomised, every path must collapse onto the deterministic
         * projection and the p10/p50/p90 band must have zero width. Randomise
         * anything committed and the band opens up. */
        const A = LEDGER();
        A.expenses = A.expenses.filter((e) => e.recurring);      // no variable history
        const base = project(A, { asOf: AS_OF, horizon: 60, includeVariable: false });
        expect(variableDailySpend(A, D(AS_OF), 3).perDay, 'fixture still has variable spend').toBe(0);

        const s = simulate(A, { asOf: AS_OF, horizon: 60, runs: 40, seed: 1 });
        for (let k = 0; k < s.bands.length; k++) {
            const b = s.bands[k];
            expect(b.p90 - b.p10, `band has width on ${b.date}`).toBeCloseTo(0, 6);
            expect(b.p50, `path diverged from the committed projection on ${b.date}`)
                .toBeCloseTo(base.days[k].balance, 6);
        }
    });

    it('orders its percentile bands p10 <= p50 <= p90 on every day', () => {
        const s = simulate(LEDGER(), { asOf: AS_OF, horizon: 60, runs: 200, seed: 3 });
        for (const b of s.bands) {
            expect(b.p10, b.date).toBeLessThanOrEqual(b.p50);
            expect(b.p50, b.date).toBeLessThanOrEqual(b.p90);
        }
    });

    it('never draws negative spending, however wide the spread', () => {
        // A Gaussian draw goes below zero; spending that adds money back would
        // quietly turn a bad month into a good one.
        const A = LEDGER();
        A.expenses = [
            { id: 'a', desc: 'x', amount: 5000, month: '2026-07' },
            { id: 'b', desc: 'y', amount: 400000, month: '2026-06' },
            { id: 'c', desc: 'z', amount: 2000, month: '2026-05' },
        ];
        A.balance.total = 50000000; A.balance.flows = [];
        A.loans = []; A.ccinstall = []; A.cheques = []; A.income = []; A.incomeRecv = [];
        A.subscriptions = [];
        const s = simulate(A, { asOf: AS_OF, horizon: 90, runs: 300, seed: 11 });
        // With no inflows and no commitments, the balance can only fall.
        for (let i = 1; i < s.bands.length; i++) {
            expect(s.bands[i].p90).toBeLessThanOrEqual(s.bands[i - 1].p90 + 1e-9);
        }
    });

    it('reports a shortfall probability inside [0,1]', () => {
        const s = simulate(LEDGER(), { asOf: AS_OF, horizon: 90, runs: 200, seed: 5 });
        expect(s.shortfallProbability).toBeGreaterThanOrEqual(0);
        expect(s.shortfallProbability).toBeLessThanOrEqual(1);
    });

    it('reports no runway when no path ever goes under', () => {
        const A = LEDGER();
        A.balance.total = 50000000;
        const s = simulate(A, { asOf: AS_OF, horizon: 90, runs: 100, seed: 5 });
        expect(s.shortfallProbability).toBe(0);
        expect(s.medianRunwayDays).toBe(null);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HEADLINE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('summarise', () => {
    it('escalates to critical only inside two weeks', () => {
        const soon = summarise(LEDGER(), { asOf: '2026-09-05', horizon: 90 });
        const later = summarise(LEDGER(), { asOf: AS_OF, horizon: 90 });
        expect(soon.runwayDays).toBeLessThanOrEqual(14);
        expect(soon.status).toBe('critical');
        expect(later.runwayDays).toBeGreaterThan(14);
        expect(later.status).toBe('at-risk');
    });

    it('says clear when nothing is at risk', () => {
        const A = LEDGER(); A.balance.total = 5000000;
        expect(summarise(A, { asOf: AS_OF, horizon: 90 }).status).toBe('clear');
    });

    it('carries the cause forward, because a warning without one is not advice', () => {
        const s = summarise(LEDGER(), { asOf: AS_OF, horizon: 90 });
        expect(s.runwayCauses.length).toBeGreaterThan(0);
        expect(s.runwayCauses[0].label).toContain('4471');
    });

    it('counts only committed money in committedOut', () => {
        const s = summarise(LEDGER(), { asOf: AS_OF, horizon: 90 });
        const r = commitments(LEDGER(), D(AS_OF), addDays(D(AS_OF), 90));
        const expected = r.items
            .filter((i) => i.kind === 'out' && i.certainty === 'committed')
            .reduce((t, i) => t + i.amount, 0);
        expect(s.committedOut).toBe(expected);
        expect(r.items.some((i) => i.certainty === 'expected')).toBe(true);   // and some was excluded
    });

    it('passes the unusable records through so they can be surfaced', () => {
        const A = LEDGER();
        A.loans.push({ id: 'L2', name: 'Broken', monthly: 1000 });
        expect(summarise(A, { asOf: AS_OF, horizon: 90 }).ignored.map((i) => i.id)).toContain('L2');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PURITY
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the engine is pure', () => {
    it('does not mutate the ledger it is given', () => {
        const A = LEDGER();
        const before = JSON.stringify(A);
        project(A, { asOf: AS_OF, horizon: 90 });
        simulate(A, { asOf: AS_OF, horizon: 30, runs: 20, seed: 1 });
        summarise(A, { asOf: AS_OF, horizon: 90 });
        expect(JSON.stringify(A)).toBe(before);
    });

    it('reaches no browser or platform surface', async () => {
        // The module has to run in Node with no globals for the suite to exist
        // at all, and it must stay that way: a storage or network call in here
        // would also make it a sensitive file rather than an ordinary module.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(
            path.resolve(import.meta.dirname, '../wealthflow-cashflow-engine.js'), 'utf8');
        const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const bad of [
            /\blocalStorage\b/, /\bsessionStorage\b/, /\bfetch\s*\(/, /XMLHttpRequest/,
            /\bdocument\b/, /\binnerHTML\b/, /\bfirebase\b/, /\beval\s*\(/,
        ]) {
            expect(bad.test(body), `${bad} appears in the engine`).toBe(false);
        }
        // `new Date()` with no argument would make every result clock-dependent.
        expect(/new Date\(\s*\)/.test(body), 'the engine reads the clock directly').toBe(false);
    });
});
