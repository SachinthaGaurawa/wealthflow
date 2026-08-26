/* =============================================================================
 * test/sweep_ledger_test.js
 * -----------------------------------------------------------------------------
 * wealthflow-sweep-ledger.js records money the user actually moved out of the
 * current account, feeds the return leg back into the projection, and checks
 * afterwards whether the sweeper's promise held.
 *
 * THE PROPERTY THAT MATTERS MOST IS AN ABSENCE.
 *
 * When 1.03M moves into a fixed deposit, the bank balance drops by 1.03M and
 * `balance.total` already shows it. Subtracting the sweep again bills the user
 * twice for one transfer, and it fails in the direction that quietly makes
 * someone look poorer than they are. Several tests below exist only to prove
 * that the second subtraction does not happen — including one that compares the
 * whole projected curve with and against the sweep, day by day, so a
 * double-count anywhere in the window shows up rather than only on day one.
 *
 * THE SECOND IS THAT THE AUDIT REFUSES TO FLATTER ITSELF.
 *
 * Observations are recorded when the app is opened, so a 180-day window may
 * hold three readings. "The floor held" drawn from three readings is not a
 * verification, and this repository has spent a lot of effort removing features
 * that reported success they had not established. `unverified` must therefore
 * never collapse into `held`, no matter how convenient that would look on a
 * card, and the tests state that as a rule rather than as an example.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    project, openingBalance, parseDay, isoDay, addDays,
} from '../wealthflow-cashflow-engine.js';
import L, {
    normalise, read, legs, allLegs, parked, maturing, audit, observe, MAX_OBSERVATIONS,
} from '../wealthflow-sweep-ledger.js';

const AS_OF = '2026-08-26';
const ON = parseDay(AS_OF);

/** A ledger with a comfortable surplus, so nothing else drives the balance down. */
const LEDGER = () => ({
    balance: { total: 900000, flows: [] },
    loans: [{
        id: 'L1', name: 'BOC Home', amount: 2000000, rate: 12, duration: 60, monthly: 45000,
        start: '2026-03-05', paymentMethod: 'emi', skipped: [],
    }],
    subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1990, dueDay: 12, cycle: 'monthly', createdAt: '2026-01-12T00:00:00Z' }],
    expenses: [{ id: 'E1', desc: 'Rent', cat: 'Housing', amount: 55000, month: '2026-08', recurring: true }],
    income: [{ id: 'I1', name: 'Salary', company: 'X', monthly: 220000, day: 1, start: '2025-01-01', freq: 'monthly' }],
    sweeps: [],
});

const FD = {
    id: 'W1', date: '2026-07-20', amount: 400000, destination: 'fd-6m',
    label: 'BOC 6-month FD', lockDays: 180, rateAnnual: 11,
};

/** Project with the sweep legs folded in, exactly as the app does. */
const proj = (data, opts = {}) => project(data, {
    asOf: AS_OF, horizon: 260, extraCommitments: allLegs(data, ON).items, ...opts,
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE TRANSFER, ONE SUBTRACTION
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('money that has already left is not taken out twice', () => {
    it('a past sweep contributes the maturity and nothing else', () => {
        const s = normalise(FD).sweep;
        const l = legs(s, ON);
        expect(l).toHaveLength(1);
        expect(l[0].kind).toBe('in');
        expect(l[0].date).toBe('2027-01-16');   // 2026-07-20 + 180 days
    });

    it('leaves the opening balance exactly as the user reported it', () => {
        const d = LEDGER();
        d.balance.total = 500000;               // the transfer already happened
        d.sweeps = [FD];
        expect(proj(d).opening).toBe(openingBalance(d));
        expect(proj(d).opening).toBe(500000);
    });

    it('changes the curve on the maturity day and on NO day before it', () => {
        /* The strong form. A double-count on day one would be caught by the
         * test above, but one buried mid-window would not. So the whole curve
         * is compared against the same ledger with the sweep removed: every day
         * before maturity must be identical, and every day after must differ by
         * exactly the maturity value. */
        const withSweep = LEDGER();
        withSweep.balance.total = 500000;
        withSweep.sweeps = [FD];

        const without = LEDGER();
        without.balance.total = 500000;         // same account, no record kept

        const a = proj(withSweep).days;
        const b = proj(without).days;
        expect(a).toHaveLength(b.length);

        const maturity = '2027-01-16';
        const value = normalise(FD).sweep.maturityValue;
        for (let i = 0; i < a.length; i++) {
            expect(a[i].date).toBe(b[i].date);
            const delta = a[i].balance - b[i].balance;
            if (a[i].date < maturity) {
                expect(delta, `the balance moved on ${a[i].date}, before the deposit matures — `
                    + 'the sweep is being subtracted a second time').toBe(0);
            } else {
                expect(delta, `the maturity is not fully credited on ${a[i].date}`)
                    .toBeCloseTo(value, 6);
            }
        }
    });

    it('a FUTURE sweep does take the money out, because it has not gone yet', () => {
        const s = normalise({ ...FD, date: '2026-09-10' }).sweep;
        const l = legs(s, ON);
        expect(l.map((x) => x.kind)).toEqual(['out', 'in']);
        expect(l[0].date).toBe('2026-09-10');
        expect(l[0].amount).toBe(400000);
    });

    it('and the projection drops by the principal on the day it leaves', () => {
        const d = LEDGER();
        d.sweeps = [{ ...FD, date: '2026-09-10' }];
        const withS = proj(d).days;
        const withoutS = proj(LEDGER()).days;
        const i = withS.findIndex((x) => x.date === '2026-09-10');
        expect(i).toBeGreaterThan(-1);
        expect(withoutS[i].balance - withS[i].balance).toBeCloseTo(400000, 6);
    });
});

describe('the settled flag beats the date when the user sets it', () => {
    // Recording today's transfer before updating the balance would otherwise be
    // modelled as money that is already gone, and the error is silent.
    const kinds = (raw) => legs(normalise(raw).sweep, ON).map((l) => l.kind);

    it('past + settled:false still takes the money out', () => {
        expect(kinds({ ...FD, date: '2026-07-01', settled: false })).toEqual(['out', 'in']);
    });

    it('future + settled:true does not take it out again', () => {
        expect(kinds({ ...FD, date: '2026-09-30', settled: true })).toEqual(['in']);
    });

    it('with no flag, the date decides', () => {
        expect(kinds({ ...FD, date: '2026-07-01' })).toEqual(['in']);
        expect(kinds({ ...FD, date: '2026-09-30' })).toEqual(['out', 'in']);
    });

    it('parked() reads the flag the same way legs() does', () => {
        // Two views of one sweep that disagree about whether the money has gone
        // is the defect this codebase keeps producing.
        const d = LEDGER();
        d.sweeps = [{ ...FD, date: '2026-09-30', settled: true }];
        expect(parked(d, ON).total, 'legs() says the money is gone but parked() does not')
            .toBe(400000);
        d.sweeps = [{ ...FD, date: '2026-07-01', settled: false }];
        expect(parked(d, ON).total).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT COMES BACK, AND WHOSE NUMBER IT IS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the maturity value', () => {
    it('uses the bank’s quote when there is one, and calls the inflow committed', () => {
        const s = normalise({ ...FD, maturityValue: 430000 }).sweep;
        expect(s.maturityValue).toBe(430000);
        expect(s.gain).toBe(30000);
        expect(s.valueBasis).toBe('quoted');
        expect(legs(s, ON)[0].certainty).toBe('committed');
    });

    it('computes SIMPLE interest from a rate, and marks that inflow expected', () => {
        const s = normalise(FD).sweep;
        // 400,000 x 11% x 180/365 — stated as arithmetic, not as a magic number.
        expect(s.gain).toBeCloseTo(400000 * 0.11 * (180 / 365), 6);
        expect(s.valueBasis).toBe('simple-interest');
        expect(legs(s, ON)[0].certainty, 'our own interest estimate is being presented '
            + 'with the same confidence as a dated bill').toBe('expected');
    });

    it('does not compound', () => {
        // The compounded figure for the same inputs is strictly larger; if this
        // ever starts matching, someone has swapped the formula.
        const s = normalise({ ...FD, lockDays: 365, rateAnnual: 11 }).sweep;
        const simple = 400000 * 0.11;
        const compoundedMonthly = 400000 * ((1 + 0.11 / 12) ** 12 - 1);
        expect(s.gain).toBeCloseTo(simple, 6);
        expect(s.gain).toBeLessThan(compoundedMonthly);
    });

    it('claims no gain at all when it knows neither a value nor a rate', () => {
        const s = normalise({ ...FD, rateAnnual: 0 }).sweep;
        expect(s.maturityValue).toBe(400000);
        expect(s.gain, 'zero is a claim that this earns nothing; null is the absence of one')
            .toBe(null);
        expect(s.valueBasis).toBe('principal-only');
    });
});

describe('money that does not come back on its own', () => {
    it('withdrawable savings produce no inflow', () => {
        const s = normalise({ id: 'W3', date: '2026-08-01', amount: 250000, lockDays: 0, destination: 'liquid' }).sweep;
        expect(s.maturesOn).toBe(null);
        expect(legs(s, ON)).toHaveLength(0);
    });

    it('separates money that is recorded but has not moved from money that has', () => {
        // "0.00 parked" above a row for a seven-figure deposit is what the
        // first version showed, because an unmoved sweep counted as nothing.
        const d = LEDGER();
        d.sweeps = [{ ...FD, date: '2026-09-30' }];      // future: not gone yet
        const p = parked(d, ON);
        expect(p.total).toBe(0);
        expect(p.pending).toBe(400000);
    });

    it('but parked() still says the money is there', () => {
        const d = LEDGER();
        d.sweeps = [{ id: 'W3', date: '2026-08-01', amount: 250000, lockDays: 0, destination: 'liquid' }];
        const p = parked(d, ON);
        expect(p.total).toBe(250000);
        expect(p.liquid).toBe(250000);
        expect(p.returning, 'savings with no maturity were counted as money that returns by itself')
            .toBe(0);
    });
});

describe('sweeps that are over project nothing', () => {
    for (const status of ['withdrawn', 'cancelled', 'matured']) {
        it(`a ${status} sweep contributes no legs`, () => {
            expect(legs(normalise({ ...FD, status }).sweep, ON)).toHaveLength(0);
        });
    }

    it('and a deposit already past its maturity is no longer parked', () => {
        const d = LEDGER();
        d.sweeps = [{ ...FD, date: '2025-01-01', lockDays: 30 }];  // matured long ago
        expect(parked(d, ON).total).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RECORDS THAT CANNOT BE USED SAY SO
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('unusable records are reported, never guessed at', () => {
    it.each([
        ['no amount', { id: 'x', date: '2026-07-01' }],
        ['zero amount', { id: 'x', date: '2026-07-01', amount: 0 }],
        ['no date', { id: 'x', amount: 100000 }],
        ['not an object', 'nonsense'],
    ])('rejects %s', (_why, raw) => {
        expect(normalise(raw).ok).toBe(false);
    });

    it('surfaces them through read().ignored rather than dropping them silently', () => {
        const d = { sweeps: [FD, { id: 'bad', date: '2026-07-01' }] };
        const r = read(d);
        expect(r.sweeps).toHaveLength(1);
        expect(r.ignored).toHaveLength(1);
        expect(r.ignored[0].id).toBe('bad');
        expect(r.ignored[0].why).toMatch(/amount/);
    });

    it('an unreadable record cannot move the projection', () => {
        const d = LEDGER();
        d.sweeps = [{ id: 'bad', date: '2026-07-01' }];
        expect(proj(d).days.map((x) => x.balance))
            .toEqual(proj(LEDGER()).days.map((x) => x.balance));
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE AUDIT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the audit does not report a pass it has not established', () => {
    const claim = { floor: 120000, horizonDays: 180, projectedMin: 310000, bindingDate: '2026-11-02' };
    const withClaim = () => ({ sweeps: [{ ...FD, date: '2026-06-01', claim }] });

    it('says unverified — not held — when there are no observations', () => {
        const a = audit(withClaim(), [], ON);
        expect(a.results[0].verdict).toBe('unverified');
        expect(a.held).toBe(0);
        expect(a.headline).not.toMatch(/held/);
    });

    it('says holding — not held — while the window is still open', () => {
        /* `held` used to arrive with the first reading above the floor, and
         * because the interface records one as it renders, that reading always
         * existed. Every sweep therefore read "held", in green, from the moment
         * it was created. A promise about the next 180 days is not kept on day
         * one; `holding` says what is actually known. */
        const a = audit(withClaim(), [{ day: '2026-07-15', balance: 355000 }], ON);
        expect(a.results[0].verdict).toBe('holding');
        expect(a.results[0].checkedDays).toBe(1);
        expect(a.held).toBe(0);
    });

    it('says held once the window has actually closed', () => {
        // 2026-06-01 + 180 days = 2026-11-28.
        const after = parseDay('2026-12-01');
        const a = audit(withClaim(), [{ day: '2026-07-15', balance: 355000 }], after);
        expect(a.results[0].verdict).toBe('held');
        expect(a.results[0].complete).toBe(true);
        expect(a.held).toBe(1);
    });

    it('reports coverage honestly instead of burying it', () => {
        const a = audit(withClaim(), [
            { day: '2026-06-15', balance: 480000 },
            { day: '2026-07-15', balance: 355000 },
            { day: '2026-08-20', balance: 302000 },
        ], ON);
        const r = a.results[0];
        expect(r.checkedDays).toBe(3);
        // 2026-06-01 .. 2026-08-26 is 86 boundaries and 87 days, because the
        // first day counts. The earlier denominator made a same-day sweep read
        // "checked on 1 of 0 days".
        expect(r.windowDays).toBe(87);
        expect(r.coverage).toBeCloseTo(3 / 87, 10);
        expect(r.complete, 'a 180-day window cannot be complete 86 days in').toBe(false);
    });

    it('catches a breach on a single reading', () => {
        const a = audit(withClaim(), [
            { day: '2026-06-15', balance: 480000 },
            { day: '2026-07-19', balance: 98000 },
            { day: '2026-08-20', balance: 302000 },
        ], ON);
        expect(a.results[0].verdict).toBe('breached');
        expect(a.breached).toBe(1);
        expect(a.results[0].breaches).toEqual([
            { day: '2026-07-19', balance: 98000, shortBy: 22000 },
        ]);
    });

    it('a breach outranks the readings that were fine', () => {
        // Two good readings and one bad one is still a broken promise.
        const a = audit(withClaim(), [
            { day: '2026-06-15', balance: 480000 },
            { day: '2026-07-19', balance: 98000 },
        ], ON);
        expect(a.results[0].verdict).toBe('breached');
    });

    it('ignores readings from outside the sweep’s own window', () => {
        const a = audit(withClaim(), [
            { day: '2026-01-01', balance: 5 },      // long before the sweep
            { day: '2026-07-15', balance: 355000 },
        ], ON);
        expect(a.results[0].checkedDays).toBe(1);
        expect(a.results[0].verdict).toBe('holding');
    });

    it('never judges a window further ahead than today', () => {
        const a = audit(withClaim(), [{ day: '2026-07-15', balance: 355000 }], ON);
        // The claim runs 180 days from 2026-06-01, ending 2026-11-28, but only
        // 87 days of it have happened. Claiming 180 would flatter the coverage.
        expect(a.results[0].windowDays).toBe(87);
    });

    it('separates “the floor held” from “the forecast was good”', () => {
        const a = audit(withClaim(), [{ day: '2026-08-20', balance: 302000 }], ON);
        const r = a.results[0];
        expect(r.verdict).toBe('holding');
        expect(r.optimisticBy, 'the projection said 310,000 and reality came in at 302,000')
            .toBeCloseTo(8000, 6);
    });

    it('takes the LOWEST reading when a day was observed more than once', () => {
        const a = audit(withClaim(), [
            { day: '2026-07-19', balance: 400000 },
            { day: '2026-07-19', balance: 98000 },   // the dip must not be hidden
        ], ON);
        expect(a.results[0].verdict).toBe('breached');
    });

    it('reports a sweep with no stored claim as no-claim, not as a pass', () => {
        const a = audit({ sweeps: [{ ...FD, date: '2026-06-01' }] }, [], ON);
        expect(a.results[0].verdict).toBe('no-claim');
        expect(a.held).toBe(0);
        expect(a.breached).toBe(0);
    });

    it('gives every result the same field set', () => {
        /* THE DEFECT THIS CAUGHT.
         *
         * The no-claim branch used to return a shorter object with no
         * `breaches`, so the obvious rendering — loop the results, read
         * `r.breaches.length` — threw on the one sweep that had nothing to
         * report. A heterogeneous results array makes the caller responsible
         * for remembering which verdict carries which fields, and it will
         * forget. */
        const a = audit({
            sweeps: [
                { ...FD, id: 'A', date: '2026-06-01', claim },
                { ...FD, id: 'B', date: '2026-06-01' },        // no claim
            ],
        }, [{ day: '2026-07-15', balance: 355000 }], ON);
        expect(a.results).toHaveLength(2);
        const keys = a.results.map((r) => Object.keys(r).sort().join(','));
        expect(keys[0], 'audit results do not all carry the same fields').toBe(keys[1]);
        for (const r of a.results) expect(Array.isArray(r.breaches)).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * OBSERVATIONS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the observation log', () => {
    it('keeps one row per day', () => {
        let o = [];
        o = observe(o, '2026-08-20', 300000);
        o = observe(o, '2026-08-20', 250000);
        expect(o).toHaveLength(1);
    });

    it('keeps the LOWEST balance seen that day, not the latest', () => {
        // The audit asks whether the floor was ever broken. A dip at noon must
        // not disappear behind a salary credit at six.
        let o = observe([], '2026-08-20', 300000);
        o = observe(o, '2026-08-20', 250000);
        o = observe(o, '2026-08-20', 400000);
        expect(o[0].balance).toBe(250000);
    });

    it('stays sorted however the days arrive', () => {
        let o = observe([], '2026-08-20', 300000);
        o = observe(o, '2026-08-19', 310000);
        o = observe(o, '2026-08-21', 290000);
        expect(o.map((x) => x.day)).toEqual(['2026-08-19', '2026-08-20', '2026-08-21']);
    });

    it('is bounded, and drops the OLDEST when it overflows', () => {
        let o = [];
        const start = parseDay('2025-01-01');
        for (let i = 0; i < MAX_OBSERVATIONS + 25; i++) o = observe(o, addDays(start, i), 1000 + i);
        expect(o).toHaveLength(MAX_OBSERVATIONS);
        expect(o[0].day).toBe(isoDay(addDays(start, 25)));
    });

    it('ignores a reading with no usable day', () => {
        expect(observe([], 'not-a-date', 5)).toHaveLength(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MATURITIES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('what is coming back, and when', () => {
    const d = () => ({
        sweeps: [
            { id: 'A', date: '2026-07-20', amount: 400000, lockDays: 180, label: 'Six month' },
            { id: 'B', date: '2026-08-01', amount: 100000, lockDays: 30, label: 'One month' },
            { id: 'C', date: '2026-08-01', amount: 250000, lockDays: 0, label: 'Savings' },
        ],
    });

    it('lists them soonest first', () => {
        expect(maturing(d(), ON, 400).map((m) => m.id)).toEqual(['B', 'A']);
    });

    it('excludes anything with no maturity date at all', () => {
        expect(maturing(d(), ON, 400).map((m) => m.id)).not.toContain('C');
    });

    it('respects the window it was asked about', () => {
        expect(maturing(d(), ON, 30).map((m) => m.id)).toEqual(['B']);
    });

    it('counts the days to each one', () => {
        const b = maturing(d(), ON, 400).find((m) => m.id === 'B');
        expect(b.daysAway).toBe(Math.round((parseDay('2026-08-31') - ON) / 86400000));
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ENGINE'S SIDE OF THE CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('project() does not let a caller widen the projection', () => {
    const base = () => LEDGER();
    const run = (extra) => project(base(), { asOf: AS_OF, horizon: 90, extraCommitments: extra });

    it.each([
        ['a date past the horizon', { date: '2030-01-01', kind: 'in', amount: 999999 }],
        ['a date before today', { date: '2020-01-01', kind: 'in', amount: 999999 }],
        ['a zero amount', { date: '2026-09-01', kind: 'in', amount: 0 }],
        ['a negative amount', { date: '2026-09-01', kind: 'in', amount: -5000 }],
        ['no direction', { date: '2026-09-01', kind: 'sideways', amount: 5000 }],
        ['a null entry', null],
    ])('drops %s', (_why, item) => {
        /* CHECKS THE COMMITMENT LIST, NOT JUST THE CURVE.
         *
         * The first version of this compared day balances only, and a mutation
         * that accepted out-of-window dates survived it: an event dated 2030
         * cannot move a 90-day balance, so the curve was identical and the test
         * passed while the item sat in `commitments` regardless.
         *
         * That list is not decoration. wealthflow-wealth-sweeper.js reads
         * project().commitments to work out committedShare — the ratio that
         * decides whether a 12-month deposit is offered at all — so a stray
         * item there changes what the user is advised to do with their money
         * while every balance on screen stays the same. */
        const withIt = run([item]);
        const without = run([]);
        expect(withIt.days.map((x) => x.balance)).toEqual(without.days.map((x) => x.balance));
        expect(withIt.commitments.length, 'the item was rejected from the projection but still '
            + 'landed in the commitment list, where committedShare reads it')
            .toBe(without.commitments.length);
    });

    it('puts an accepted event into BOTH the commitment list and the day row', () => {
        // A day row carrying an event the commitment list does not is the
        // two-views-one-truth problem the engine exists to close.
        const r = run([{ date: '2026-09-01', kind: 'in', amount: 12345, label: 'Maturity', source: 'sweeps', id: 'W1' }]);
        expect(r.commitments.some((c) => c.id === 'W1' && c.amount === 12345)).toBe(true);
        const day = r.days.find((x) => x.date === '2026-09-01');
        expect(day.events.some((e) => e.id === 'W1' && e.amount === 12345)).toBe(true);
    });

    it('keeps the commitment list in date order after inserting one', () => {
        const r = run([{ date: '2026-09-01', kind: 'in', amount: 12345, source: 'sweeps' }]);
        const dates = r.commitments.map((c) => c.date);
        expect([...dates].sort()).toEqual(dates);
    });

    it('ignores the option entirely when it is not an array', () => {
        /* The last entry is the one that matters: a single VALID event passed
         * bare rather than wrapped. Every other value here is rejected further
         * down the function anyway, so a mutant that quietly wrapped a non-array
         * in `[value]` survived a list of only-invalid inputs. The contract is
         * an array; a caller who passes one object should find out from a
         * missing event, not from a projection that happens to work. */
        const bare = { date: '2026-09-01', kind: 'in', amount: 50000, source: 'sweeps' };
        for (const bad of [null, undefined, 'x', 42, {}, bare]) {
            const r = project(base(), { asOf: AS_OF, horizon: 90, extraCommitments: bad });
            expect(r.days.map((x) => x.balance)).toEqual(run([]).days.map((x) => x.balance));
            expect(r.commitments.length).toBe(run([]).commitments.length);
        }
    });
});

describe('the module surface', () => {
    it('proposes and records — it never moves money', () => {
        // Same rule the sweeper is held to. Nothing here may look like a
        // transfer instruction.
        for (const k of Object.keys(L)) {
            expect(k, `${k} reads like an execution path`).not.toMatch(/^(apply|execute|transfer|send|pay)/);
        }
    });

    it('never reads the clock', () => {
        expect(() => legs(normalise(FD).sweep, undefined)).toThrow(/asOf/);
        expect(() => parked({ sweeps: [] }, undefined)).toThrow(/asOf/);
        expect(() => audit({ sweeps: [] }, [], undefined)).toThrow(/asOf/);
        expect(() => maturing({ sweeps: [] }, undefined)).toThrow(/asOf/);
    });
});
