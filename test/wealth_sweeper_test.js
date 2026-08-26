/* =============================================================================
 * test/wealth_sweeper_test.js
 * -----------------------------------------------------------------------------
 * The sweeper proposes moving real money out of somebody's current account. A
 * wrong answer here does not render badly — it tells a person their rent is
 * spare cash. So the tests below are mostly about what it must REFUSE to say.
 *
 * TWO OF THEM PIN FLAWS THE FIRST VERSION ACTUALLY SHIPPED, both found by
 * running it rather than by reading it:
 *
 *   1. Every savings goal came back UNFUNDED beside 1.28M of idle cash. The
 *      match rule was `horizon <= daysAway`, but a horizon is "how long the
 *      money is provably idle", not "how long it is locked up". A goal due in 50
 *      days can be funded from withdrawable savings all day long; the shortest
 *      horizon was 90, `90 <= 50` is false, and every goal fell through.
 *
 *   2. When the balance curve bottoms out early, all three horizons return the
 *      SAME number, the ladder collapses, and the whole amount landed in the
 *      most-locked destination — a 12-month deposit chosen off a projection the
 *      code itself labels `low` confidence.
 *
 * `asOf` is passed everywhere. Nothing here depends on the day the suite runs.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    HORIZONS, DESTINATIONS, reserveFloor, maxSweep, ladder, sweepPlan,
} from '../wealthflow-wealth-sweeper.js';
import { project } from '../wealthflow-cashflow-engine.js';

const AS_OF = '2026-08-26';

/** A solvent ledger with real commitments, in the shapes the app stores. */
const LEDGER = () => ({
    balance: { total: 1400000, flows: [] },
    loans: [{ id: 'L1', name: 'BOC Home', amount: 2000000, rate: 14,
        duration: 60, monthly: 45000, start: '2026-03-05', paymentMethod: 'emi', skipped: [] }],
    ccinstall: [{ id: 'C1', product: 'Laptop', total: 144000, rate: 28,
        duration: 12, monthly: 12000, date: '2026-06-20', completed: false, skipped: [] }],
    subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1990, dueDay: 12,
        cycle: 'monthly', createdAt: '2026-01-12T00:00:00Z' }],
    cheques: [{ id: 'Q1', no: '4471', party: 'Perera Hardware', type: 'issued',
        amount: 180000, issue: '2026-08-15', release: '2026-09-15', status: 'pending' }],
    incomeRecv: [],
    income: [{ id: 'I1', name: 'Salary', monthly: 320000, day: 1, start: '2025-01-01' }],
    expenses: [
        { id: 'E1', desc: 'Rent', cat: 'Housing', amount: 55000, month: '2026-08', recurring: true, completed: false },
        { id: 'E2', desc: 'Groceries', cat: 'Food', amount: 22000, month: '2026-07' },
        { id: 'E3', desc: 'Fuel', cat: 'Transport', amount: 14000, month: '2026-06' },
    ],
    targets: [
        { id: 'T1', name: 'Emergency fund', amount: 500000, end: '2027-06-30', savings: [{ amount: 120000 }] },
        { id: 'T2', name: 'Japan trip', amount: 300000, end: '2026-12-20', savings: [] },
        { id: 'T3', name: 'New laptop', amount: 250000, end: '2026-10-15', savings: [] },
    ],
});

const opts = { asOf: AS_OF };
const dest = (plan, key) => plan.tranches.find((t) => t.destination === key);
const goal = (plan, name) => plan.goals.find((g) => g.name === name);

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CLOSED FORM — the mathematical claim the whole module rests on
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('maxSweep is exact, not approximate', () => {
    it('removing exactly that amount keeps the projection above the floor', () => {
        // The claim: a lump sum taken today shifts the whole curve down by that
        // constant, so the largest safe sweep is min(balance) - floor. If the
        // claim holds, the answer is TIGHT — safe at the amount, unsafe above it.
        const m = maxSweep(LEDGER(), { ...opts, horizon: 90, floor: 0 });
        const A = LEDGER();
        A.balance.total -= Math.floor(m.amount);
        expect(project(A, { ...opts, horizon: 90, floor: 0 }).runway,
            'sweeping the reported amount broke the floor').toBe(null);
    });

    it('and one more rupee of headroom does not', () => {
        const m = maxSweep(LEDGER(), { ...opts, horizon: 90, floor: 0 });
        const A = LEDGER();
        A.balance.total -= Math.ceil(m.amount) + 100;
        expect(project(A, { ...opts, horizon: 90, floor: 0 }).runway,
            'more than the reported amount was still safe — the answer is not tight').not.toBe(null);
    });

    it('is non-increasing as the horizon lengthens', () => {
        // The ladder is built from the DIFFERENCES between these, so a violation
        // here would produce a negative tranche.
        const A = LEDGER();
        let previous = Infinity;
        for (const h of [90, 180, 365]) {
            const m = maxSweep(A, { ...opts, horizon: h, floor: 0 });
            expect(m.amount, `horizon ${h} allowed more than a shorter one`)
                .toBeLessThanOrEqual(previous + 1e-6);
            previous = m.amount;
        }
    });

    it('names the day that binds it', () => {
        const m = maxSweep(LEDGER(), { ...opts, horizon: 90, floor: 0 });
        expect(m.bindingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const p = project(LEDGER(), { ...opts, horizon: 90, floor: 0 });
        const low = Math.min(...p.days.map((d) => d.balance));
        expect(p.days.find((d) => d.date === m.bindingDate).balance).toBeCloseTo(low, 6);
    });

    it('answers zero rather than negative when the floor is already breached', () => {
        const A = LEDGER();
        A.balance.total = 10000;
        expect(maxSweep(A, { ...opts, horizon: 90, floor: 500000 }).amount).toBe(0);
    });

    it('reports how much of the constraint is real obligation', () => {
        const near = maxSweep(LEDGER(), { ...opts, horizon: 90, floor: 0 });
        const far = maxSweep(LEDGER(), { ...opts, horizon: 365, floor: 0 });
        expect(near.committedShare).toBeGreaterThanOrEqual(0);
        expect(near.committedShare).toBeLessThanOrEqual(1);
        // Further out, more of what constrains it is estimate rather than a
        // dated obligation. That is the whole basis of the confidence guard.
        expect(far.committedShare).toBeLessThan(near.committedShare);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RESERVE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('reserveFloor', () => {
    it('is one month of the user’s own committed outflows', () => {
        const r = reserveFloor(LEDGER(), opts);
        const p = project(LEDGER(), { ...opts, horizon: 90 });
        const committed = p.commitments
            .filter((c) => c.kind === 'out' && c.certainty === 'committed')
            .reduce((t, c) => t + c.amount, 0);
        expect(r.amount).toBe(Math.round(committed / (90 / 30.44)));
        expect(r.amount).toBeGreaterThan(0);
    });

    it('counts only committed money, not estimated spending', () => {
        // Padding the reserve with a noisy average would make it drift.
        const A = LEDGER();
        const before = reserveFloor(A, opts).amount;
        A.expenses.push({ id: 'X', desc: 'One-off', amount: 400000, month: '2026-07' });
        expect(reserveFloor(A, opts).amount).toBe(before);
    });

    it('yields to an explicit floor from the caller', () => {
        const r = reserveFloor(LEDGER(), { ...opts, floor: 250000 });
        expect(r.amount).toBe(250000);
        expect(r.basis).toMatch(/caller/);
    });

    it('is zero for a ledger with nothing committed', () => {
        expect(reserveFloor({ balance: { total: 5000 } }, opts).amount).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * FLAW 1 — the goal matching that funded nothing
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('goals are funded from money that comes back in time', () => {
    it('funds a goal due sooner than every horizon — the bug that shipped', () => {
        /* "New laptop" is due in 50 days. Every horizon (90/180/365) is LONGER
         * than that, and the first version required `horizon <= daysAway`, so no
         * tranche qualified and the goal reported UNFUNDED beside 1.28M idle.
         * What matters is whether the money returns in time, which is lockDays. */
        const p = sweepPlan(LEDGER(), opts);
        const g = goal(p, 'New laptop');
        expect(g.dueIn).toBeLessThan(Math.min(...HORIZONS));
        expect(g.funded, 'a goal due inside every horizon was left unfunded').toBe(g.shortfall);
        expect(g.unfunded).toBe(0);
    });

    it('never funds a goal from a destination that locks past its deadline', () => {
        const p = sweepPlan(LEDGER(), opts);
        for (const g of p.goals) {
            for (const f of g.from) {
                const d = DESTINATIONS.find((x) => x.key === f.destination);
                expect(d.lockDays, `${g.name} (due ${g.dueIn}d) funded from ${d.key} `
                    + `which locks for ${d.lockDays}d`).toBeLessThanOrEqual(g.dueIn);
            }
        }
    });

    it('prefers the longest lock that still returns in time', () => {
        // Longest lock among the safe ones is the best yield. The emergency fund
        // is 308 days out, so the 180-day deposit qualifies and liquid would be
        // leaving money on the table.
        const p = sweepPlan(LEDGER(), opts);
        const g = goal(p, 'Emergency fund');
        expect(g.from.map((f) => f.destination)).toContain('fd-6m');
    });

    it('serves the soonest deadline first', () => {
        // A goal with a year of slack must not take money the 50-day goal needs.
        const A = LEDGER();
        A.balance.total = 700000;             // only enough for some of them
        const p = sweepPlan(A, opts);
        expect(goal(p, 'New laptop').funded).toBeGreaterThan(0);
        const order = p.goals.map((g) => g.dueIn);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('reports a goal it cannot reach instead of hiding it', () => {
        const A = LEDGER();
        A.balance.total = 300000;
        const p = sweepPlan(A, opts);
        const short = p.goals.filter((g) => g.unfunded > 0);
        expect(short.length, 'a thin ledger funded every goal').toBeGreaterThan(0);
        for (const g of short) expect(g.funded + g.unfunded).toBeCloseTo(g.shortfall, 6);
    });

    it('subtracts what is already saved', () => {
        const p = sweepPlan(LEDGER(), opts);
        const g = goal(p, 'Emergency fund');
        expect(g.saved).toBe(120000);
        expect(g.shortfall).toBe(380000);
    });

    it('ignores a goal that is already met', () => {
        const A = LEDGER();
        A.targets.push({ id: 'T9', name: 'Done', amount: 100000, end: '2027-01-01', savings: [{ amount: 100000 }] });
        expect(goal(sweepPlan(A, opts), 'Done')).toBeUndefined();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * FLAW 2 — locking a year of money on a low-confidence projection
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('confidence bounds how long money may be locked away', () => {
    it('excludes a destination whose horizon is mostly estimate, and says why', () => {
        const p = sweepPlan(LEDGER(), opts);
        const twelve = dest(p, 'fd-12m');
        expect(twelve.confidence).toBe('low');
        expect(twelve.available, 'a 12-month lock was offered on a low-confidence projection')
            .toBe(false);
        expect(twelve.amount).toBe(0);
        const said = p.excluded.find((e) => e.destination === 'fd-12m');
        expect(said, 'the exclusion happened silently').toBeTruthy();
        expect(said.reason).toMatch(/estimate/);
    });

    it('still uses destinations whose horizon is well evidenced', () => {
        const p = sweepPlan(LEDGER(), opts);
        expect(dest(p, 'liquid').available).toBe(true);
        expect(dest(p, 'liquid').amount + dest(p, 'fd-6m').amount).toBeGreaterThan(0);
    });

    it('an excluded destination is reported for every one it excludes', () => {
        const p = sweepPlan(LEDGER(), opts);
        const unavailable = p.tranches.filter((t) => !t.available).map((t) => t.destination).sort();
        expect(p.excluded.map((e) => e.destination).sort()).toEqual(unavailable);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ARITHMETIC MUST CLOSE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the numbers on screen add up to the balance', () => {
    it('keep + placed equals the opening balance', () => {
        // A gap here is money the user cannot account for, which is worse than a
        // wrong recommendation because it looks like a rounding error.
        const p = sweepPlan(LEDGER(), opts);
        expect(p.keep + p.placed).toBeCloseTo(p.opening, 6);
    });

    it('the tranches sum to what was placed', () => {
        const p = sweepPlan(LEDGER(), opts);
        expect(p.tranches.reduce((t, x) => t + x.amount, 0)).toBeCloseTo(p.placed, 6);
    });

    it('nothing is placed beyond what is sweepable at the shortest horizon', () => {
        const p = sweepPlan(LEDGER(), opts);
        expect(p.placed).toBeLessThanOrEqual(p.sweepable + 1e-6);
    });

    it('every tranche splits cleanly into goal money and spare', () => {
        for (const t of sweepPlan(LEDGER(), opts).tranches) {
            expect(t.forGoals + t.spare).toBeCloseTo(t.amount, 6);
        }
    });

    it('no tranche is ever negative', () => {
        for (const t of sweepPlan(LEDGER(), opts).tranches) {
            expect(t.amount).toBeGreaterThanOrEqual(0);
        }
    });

    it('the reserve is never swept', () => {
        const p = sweepPlan(LEDGER(), opts);
        const A = LEDGER();
        A.balance.total -= Math.floor(p.placed);
        const after = project(A, { ...opts, horizon: 90 });
        const low = Math.min(...after.days.map((d) => d.balance));
        expect(low, 'sweeping the plan took the balance below the reserve')
            .toBeGreaterThanOrEqual(p.reserve.amount - 1);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT REFUSES TO SAY
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the sweeper refuses', () => {
    it('proposes nothing when everything on hand is committed', () => {
        // The precondition is asserted rather than assumed. At 150,000 there is
        // genuinely a little idle and the honest answer is `thin`, not
        // `nothing-idle` — the first version of this test hand-picked that
        // number, got `thin`, and would have been "fixed" by loosening the
        // assertion instead of by making the fixture mean what it claims.
        const A = LEDGER();
        A.balance.total = 100000;
        const r = reserveFloor(A, opts);
        const low = Math.min(...project(A, { ...opts, horizon: 90 }).days.map((d) => d.balance));
        expect(low, 'fixture does not actually leave the balance under the reserve')
            .toBeLessThanOrEqual(r.amount);

        const p = sweepPlan(A, opts);
        expect(p.status).toBe('nothing-idle');
        expect(p.placed).toBe(0);
        expect(p.headline).toMatch(/Nothing is idle/);
    });

    it('reports no yield at all rather than zero when given no rates', () => {
        // Zero is a claim that this earns nothing. null is the absence of one.
        expect(sweepPlan(LEDGER(), opts).projectedAnnualGain).toBe(null);
        expect(sweepPlan(LEDGER(), { ...opts, annualYield: { liquid: 7.5 } })
            .projectedAnnualGain).toBeGreaterThan(0);
    });

    it('has no way to move money', () => {
        // Deliberately no apply/execute path. This module proposes.
        const api = sweepPlan(LEDGER(), opts);
        for (const k of Object.keys(api)) {
            expect(k).not.toMatch(/^(apply|execute|transfer|commit)/i);
        }
    });

    it('demands a date rather than reading the clock', () => {
        expect(() => ladder(LEDGER(), {})).toThrow(TypeError);
        expect(() => reserveFloor(LEDGER(), {})).toThrow(TypeError);
    });

    it('survives a ledger of nulls and junk', () => {
        const p = sweepPlan({ balance: null, loans: 'x', targets: [null, {}], expenses: 7 }, opts);
        expect(p.placed).toBe(0);
        expect(p.goals).toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PURITY
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the sweeper is pure', () => {
    it('does not mutate the ledger', () => {
        const A = LEDGER();
        const before = JSON.stringify(A);
        sweepPlan(A, { ...opts, annualYield: { 'fd-6m': 10 } });
        expect(JSON.stringify(A)).toBe(before);
    });

    it('is deterministic', () => {
        expect(JSON.stringify(sweepPlan(LEDGER(), opts)))
            .toBe(JSON.stringify(sweepPlan(LEDGER(), opts)));
    });

    it('reaches no browser or platform surface', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(
            path.resolve(import.meta.dirname, '../wealthflow-wealth-sweeper.js'), 'utf8');
        const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        for (const bad of [/\blocalStorage\b/, /\bfetch\s*\(/, /\bdocument\b/,
            /\binnerHTML\b/, /\bfirebase\b/, /\beval\s*\(/, /new Date\(\s*\)/]) {
            expect(bad.test(body), `${bad} appears in the sweeper`).toBe(false);
        }
    });
});
