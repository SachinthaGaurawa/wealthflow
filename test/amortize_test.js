/* =============================================================================
 * test/amortize_test.js
 * -----------------------------------------------------------------------------
 * Two things in this file carry real weight, and they are not the arithmetic.
 *
 * ONE: THE LOOP THAT DOES NOT TERMINATE.
 *
 * "Project forward until the balance reaches zero" is the natural way to write
 * this, and against a payment smaller than the month's interest it never ends —
 * the balance grows every month, forever. That is not a contrived input: it is
 * what a 50,000 instalment does to a 5,000,000 balance at 18%, which is an
 * ordinary Sri Lankan mortgage and an ordinary bad month. Written the obvious
 * way, opening the loans page on that data freezes the phone.
 *
 * So there are two tests for it and they check different things. One asserts
 * the refusal, by name, with both figures in it. The other runs a projection
 * that would be unbounded and asserts it RETURNS — under a timeout, so a
 * regression fails the suite instead of hanging it. A test that would itself
 * hang is not a test of hanging.
 *
 * TWO: A RECORDED UNDERPAYMENT IS A FACT, NOT AN ASSUMPTION.
 *
 * The refusal above applies only to PROJECTED months. If the owner actually
 * paid 50,000 last March, that happened, the balance carries it, and refusing
 * to draw the loan because of it would hide the very month they need to see.
 * What cannot be done is assume every future month repeats it. The distinction
 * is one line in the module and a test here, because getting it backwards
 * produces either a frozen page or a loan that silently disappears.
 *
 * WHAT THESE TESTS DO NOT COVER
 *
 * Agreement with the bank. Sri Lankan lenders round, charge fees, and apply
 * value dates in ways no formula here models, so the figures are internally
 * consistent rather than authoritative — the same standing as the app's
 * existing projections, which this deliberately mirrors rather than replaces.
 * A test asserts that mirroring for the on-schedule case, because the moment
 * this module and index.html disagree about an untouched loan, one of them is
 * lying to the owner.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import A, {
    METHOD, MAX_MONTHS, AMORTIZE,
    methodOf, monthlyRate, scheduledPayment, monthKeyAt, paymentFor,
    project, baseline, drift, progress, arrears,
} from '../wealthflow-amortize.js';

/** A 5,000,000 loan at 18% over 60 months — an ordinary local mortgage. */
const LOAN = (over = {}) => ({
    id: 'loan-1',
    amount: 5_000_000,
    rate: 18,
    duration: 60,
    start: '2025-01-01',
    monthly: 127_000,
    payments: [],
    ...over,
});

/** n months of exactly-on-schedule payments. */
const onSchedule = (loan, n, amount) =>
    Array.from({ length: n }, (_, i) => ({
        month: monthKeyAt(loan, i), paid: true,
        amount: amount == null ? loan.monthly : amount, paidAt: 1,
    }));

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MUST NOT HANG
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a payment smaller than the interest', () => {
    it('is refused by name, with both figures', () => {
        /* 5,000,000 at 18% accrues 75,000 in the first month. An instalment of
         * 50,000 never touches the principal — the balance is larger every
         * month, forever. */
        const r = project(LOAN({ monthly: 50_000 }));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(AMORTIZE.BELOW_INTEREST);
        expect(r.detail.interest).toBe(75_000);
        expect(r.detail.payment).toBe(50_000);
        expect(r.detail.shortfall).toBe(25_000);
    });

    it('RETURNS, rather than running until the tab dies', async () => {
        /* The assertion is termination itself. Written as a `while (balance > 0)`
         * this call never comes back, and a test that simply called it would
         * hang the suite instead of failing it — so it races a timer. */
        const ran = await Promise.race([
            Promise.resolve().then(() => { project(LOAN({ monthly: 50_000 })); return 'returned'; }),
            new Promise((res) => setTimeout(() => res('hung'), 2000)),
        ]);
        expect(ran, 'the projection did not terminate').toBe('returned');
    });

    it('still draws a loan where the SHORTFALL ALREADY HAPPENED', () => {
        /* The refusal is about assuming the future, not about recording the
         * past. A month the owner genuinely underpaid must still appear, with
         * the balance carrying it — refusing here would hide the one month they
         * most need to look at. */
        const l = LOAN();
        l.payments = [
            ...onSchedule(l, 3),
            { month: monthKeyAt(l, 3), paid: true, amount: 50_000, paidAt: 1 }, // the bad month
        ];
        const r = project(l);
        expect(r.ok, 'a recorded underpayment made the whole loan undrawable').toBe(true);
        const bad = r.rows[3];
        expect(bad.payment).toBe(50_000);
        expect(bad.closing).toBeGreaterThan(bad.opening);   // it really did grow
        expect(r.rows.some((x) => !x.recorded)).toBe(true); // and it still finishes
    });

    it('caps the horizon even for a shape nobody predicted', () => {
        // A rate low enough to amortise but a payment slow enough to take
        // centuries. The refusal above will not catch it; the cap must.
        const r = project(LOAN({ amount: 50_000_000, rate: 0, monthly: 1, duration: 12 }));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(AMORTIZE.DOES_NOT_AMORTIZE);
        expect(r.detail.months).toBe(MAX_MONTHS);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * AGREEING WITH THE APP THAT ALREADY EXISTS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a loan nobody has touched', () => {
    it('reads the method the same way index.html does', () => {
        expect(methodOf({ paymentMethod: 'reducing' })).toBe(METHOD.REDUCING);
        for (const m of ['emi', '', undefined, null, 'EMI', 'anything']) {
            expect(methodOf({ paymentMethod: m })).toBe(METHOD.EMI);
        }
    });

    it('charges interest on the balance at the start of the month', () => {
        const r = project(LOAN());
        expect(r.rows[0].opening).toBe(5_000_000);
        expect(r.rows[0].interest).toBe(75_000);          // 5,000,000 × 18% ÷ 12
        expect(r.rows[0].principal).toBe(52_000);         // 127,000 − 75,000
        expect(r.rows[0].closing).toBe(4_948_000);
    });

    it('treats a recorded payment with no amount as the scheduled one', () => {
        /* Rows written before amounts were captured. index.html reads them as
         * `pay.amount || l.monthly`; reading them differently here would make
         * the two disagree about a balance the owner is already looking at. */
        const l = LOAN();
        l.payments = [{ month: monthKeyAt(l, 0), paid: true, paidAt: 1 }];
        expect(project(l).rows[0].payment).toBe(l.monthly);
    });

    it('ignores a payment that is recorded but not marked paid', () => {
        const l = LOAN();
        l.payments = [{ month: monthKeyAt(l, 0), paid: false, amount: 999_999 }];
        expect(project(l).rows[0].payment).toBe(l.monthly);
        expect(paymentFor(l, monthKeyAt(l, 0))).toBe(null);
    });

    it('never leaves a negative balance, and ends on a stub not a full instalment', () => {
        const r = project(LOAN());
        expect(r.rows.every((x) => x.closing >= 0)).toBe(true);
        expect(r.finalPayment).toBeLessThanOrEqual(LOAN().monthly);
        expect(r.finalPayment).toBeGreaterThan(0);
        expect(r.rows[r.rows.length - 1].closing).toBe(0);
    });

    it('does not modify the loan it was handed', () => {
        const l = LOAN({ payments: onSchedule(LOAN(), 3) });
        const before = JSON.stringify(l);
        project(l); baseline(l); drift(l); progress(l); arrears(l);
        expect(JSON.stringify(l)).toBe(before);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE POINT OF THE WHOLE MODULE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('overpaying actually shortens the loan', () => {
    it('finishes sooner, and the app’s fixed duration would not have noticed', () => {
        const l = LOAN();
        const plan = baseline(l);
        l.payments = [
            ...onSchedule(l, 5),
            { month: monthKeyAt(l, 5), paid: true, amount: 500_000, paidAt: 1 },  // a bonus
        ];
        const real = project(l);
        expect(real.ok).toBe(true);
        expect(real.monthsTaken, 'the overpayment did not shorten the term').toBeLessThan(plan.monthsTaken);
        expect(real.totalInterest).toBeLessThan(plan.totalInterest);
    });

    it('reports what the overpayment saved, in months and in money', () => {
        const l = LOAN();
        l.payments = [...onSchedule(l, 5), { month: monthKeyAt(l, 5), paid: true, amount: 500_000, paidAt: 1 }];
        const d = drift(l);
        expect(d.ok).toBe(true);
        expect(d.monthsSaved).toBeGreaterThan(0);
        expect(d.interestSaved).toBeGreaterThan(0);
        expect(d.payoffMoved).toBe(true);
    });

    it('reports being behind as a negative saving, not as a separate concept', () => {
        // One number to read beats two to compare.
        const l = LOAN();
        l.payments = [...onSchedule(l, 5), { month: monthKeyAt(l, 5), paid: true, amount: 80_000, paidAt: 1 }];
        const d = drift(l);
        expect(d.ok).toBe(true);
        expect(d.interestSaved).toBeLessThan(0);
    });

    it('is unchanged when every payment landed exactly on schedule', () => {
        const l = LOAN();
        l.payments = onSchedule(l, 12);
        const d = drift(l);
        expect(d.monthsSaved).toBe(0);
        expect(Math.abs(d.interestSaved)).toBeLessThan(1);   // rounding only
        expect(d.payoffMoved).toBe(false);
    });

    it('clearing the balance outright ends the loan there', () => {
        const l = LOAN();
        l.payments = [...onSchedule(l, 2), { month: monthKeyAt(l, 2), paid: true, amount: 6_000_000, paidAt: 1 }];
        const r = project(l);
        expect(r.monthsTaken).toBe(3);
        expect(r.rows[2].closing).toBe(0);
        expect(r.rows[2].payment, 'charged more than was owed').toBeLessThan(6_000_000);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * REDUCING BALANCE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a reducing-balance loan', () => {
    const RED = (over = {}) => LOAN({ paymentMethod: 'reducing', ...over });

    it('pays a constant slice of principal, so the instalment falls', () => {
        const r = project(RED());
        expect(r.ok).toBe(true);
        expect(r.rows[0].payment).toBeGreaterThan(r.rows[10].payment);
        expect(r.rows[0].principal).toBeCloseTo(r.rows[10].principal, 0);
    });

    it('takes its stated duration when nothing is overpaid', () => {
        expect(project(RED()).monthsTaken).toBe(60);
    });

    it('computes the instalment from the balance it is given, not the schedule', () => {
        const l = RED();
        expect(scheduledPayment(l, 5_000_000)).toBeCloseTo(5_000_000 / 60 + 75_000, 2);
        expect(scheduledPayment(l, 0)).toBeCloseTo(5_000_000 / 60, 2);
    });

    it('shortens under an overpayment, like any other loan', () => {
        const l = RED();
        const plan = baseline(l);
        l.payments = [...onSchedule(l, 3, 200_000), { month: monthKeyAt(l, 3), paid: true, amount: 900_000, paidAt: 1 }];
        expect(project(l).monthsTaken).toBeLessThan(plan.monthsTaken);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EDGES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('loans that are not ordinary', () => {
    it('handles a 0% loan without dividing by zero', () => {
        const r = project(LOAN({ rate: 0, amount: 1_200_000, monthly: 100_000, duration: 12 }));
        expect(r.ok).toBe(true);
        expect(r.monthsTaken).toBe(12);
        expect(r.totalInterest).toBe(0);
    });

    it.each([
        ['no amount', { amount: 0 }],
        ['no duration', { duration: 0 }],
        ['a negative amount', { amount: -1 }],
        ['an unreadable start date', { start: 'not-a-date' }],
        ['no start date', { start: '' }],
    ])('refuses a loan with %s rather than guessing', (_why, over) => {
        const r = project(LOAN(over));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(AMORTIZE.NO_TERMS);
    });

    it('never throws, whatever it is handed', () => {
        for (const bad of [null, undefined, {}, { amount: 'x' }, { payments: 'no' }, []]) {
            expect(() => project(bad)).not.toThrow();
            expect(() => progress(bad)).not.toThrow();
            expect(() => arrears(bad)).not.toThrow();
            expect(() => drift(bad)).not.toThrow();
            expect(project(bad).ok).toBe(false);
        }
    });

    it('gives a monthly rate of zero rather than NaN for a missing rate', () => {
        expect(monthlyRate({})).toBe(0);
        expect(monthlyRate({ rate: 'abc' })).toBe(0);
        expect(monthlyRate({ rate: 12 })).toBeCloseTo(0.01, 10);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT A SCREEN ASKS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the answers a page needs', () => {
    it('measures progress by money repaid, not by months elapsed', () => {
        /* The existing loanProgress() is `paid / l.duration` — months. A loan
         * five payments in with one huge overpayment is far further along than
         * 5/60, and the difference is the whole point. */
        const l = LOAN();
        l.payments = [...onSchedule(l, 5), { month: monthKeyAt(l, 5), paid: true, amount: 2_000_000, paidAt: 1 }];
        const p = progress(l);
        expect(p.ok).toBe(true);
        expect(p.pct).toBeGreaterThan(Math.round((6 / 60) * 100));
        expect(p.repaid + p.outstanding).toBeCloseTo(5_000_000, 0);
    });

    it('reports arrears against what should have been paid by now', () => {
        const l = LOAN();
        l.payments = [...onSchedule(l, 4), { month: monthKeyAt(l, 4), paid: true, amount: 27_000, paidAt: 1 }];
        const a = arrears(l);
        expect(a.ok).toBe(true);
        expect(a.behind).toBe(100_000);      // 127,000 due, 27,000 paid
        expect(a.ahead).toBe(0);
    });

    it('reports being ahead, and never both at once', () => {
        const l = LOAN();
        l.payments = [...onSchedule(l, 4), { month: monthKeyAt(l, 4), paid: true, amount: 327_000, paidAt: 1 }];
        const a = arrears(l);
        expect(a.ahead).toBe(200_000);
        expect(a.behind).toBe(0);
    });

    it('counts nothing as owed for months that have not been recorded yet', () => {
        // A loan three months in is not in arrears for the other fifty-seven.
        const l = LOAN({ payments: onSchedule(LOAN(), 3) });
        expect(arrears(l)).toMatchObject({ behind: 0, ahead: 0 });
    });

    it('separates interest already paid from interest still to come', () => {
        const l = LOAN({ payments: onSchedule(LOAN(), 6) });
        const r = project(l);
        expect(r.interestPaid).toBeGreaterThan(0);
        expect(r.interestRemaining).toBeGreaterThan(0);
        expect(r.totalInterest).toBeCloseTo(r.interestPaid + r.interestRemaining, 1);
        expect(r.monthsPaid).toBe(6);
        expect(r.monthsRemaining).toBe(r.monthsTaken - 6);
    });

    it('exports every function a caller needs', () => {
        for (const fn of ['project', 'baseline', 'drift', 'progress', 'arrears', 'scheduledPayment']) {
            expect(typeof A[fn], fn).toBe('function');
        }
    });
});
