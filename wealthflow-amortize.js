/* =============================================================================
 * wealthflow-amortize.js — what a loan actually costs after a real payment
 * -----------------------------------------------------------------------------
 * A loan schedule assumes every instalment arrives exactly on time and exactly
 * on amount. Nobody's does. A bonus month clears an extra 50,000; a bad month
 * pays 50,000 short. Both change the loan — not just the balance, but how many
 * payments are left, when it ends, and how much interest is still owed.
 *
 * ── WHAT THE APP ALREADY GETS RIGHT ─────────────────────────────────────────
 *
 * The balance. `_loanBalanceAfter()` in index.html already reads the ACTUAL
 * amount off each recorded payment (`pay.amount || l.monthly`) and compounds
 * the next month's interest on what is really left. Overpay and the balance
 * genuinely drops further; underpay and it genuinely does not. That is the hard
 * half and it works, so none of it is reimplemented here.
 *
 * ── WHAT IT DOES NOT ────────────────────────────────────────────────────────
 *
 * The term. Every projection is built from `l.duration`, a fixed number typed
 * in when the loan was created:
 *
 *     _loanInstallmentMonths(l)  builds exactly l.duration rows
 *     loanEndDate(l)             = start + l.duration months
 *     loanProgress(l)            = paid / l.duration
 *
 * So a loan the owner has been overpaying for a year still claims the original
 * payoff date, still lists the original number of instalments, and still shows
 * progress against a denominator that stopped being true with the first
 * overpayment. The money is right and the story about it is wrong — and the
 * story is what someone reads when deciding whether they can afford anything
 * else this year.
 *
 * This module answers the questions the fixed schedule cannot: how many
 * payments are actually left, when the loan actually ends, what the final one
 * is, and how much interest the overpayment actually saved.
 *
 * ── THE CASE THAT MUST NOT HANG THE PHONE ───────────────────────────────────
 *
 * "Project forward until the balance reaches zero" is the obvious shape, and it
 * is an infinite loop waiting to happen. If a payment is smaller than the
 * month's interest, the balance GROWS every month and the loan never amortises
 * — that is not a hypothetical, it is what a 50,000 payment does to a 5,000,000
 * balance at 18%. A `while (balance > 0)` over that runs until the tab dies.
 *
 * So the projection is bounded twice: it refuses outright when the payment
 * cannot cover the interest, naming both figures, and it caps the horizon
 * regardless. Neither is a fallback for the other — the first explains, the
 * second contains. There is a test for each, and one of them is the reason this
 * file exists in the shape it does.
 * ===========================================================================*/

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const s = (v) => (v == null ? '' : String(v)).trim();
const arr = (v) => (Array.isArray(v) ? v : []);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/* ── 1. the loan's own terms ──────────────────────────────────────────────── */

export const METHOD = { EMI: 'emi', REDUCING: 'reducing' };

/** Mirrors index.html's `_loanMethod` exactly — anything not 'reducing' is EMI. */
export function methodOf(loan) {
    return (loan && loan.paymentMethod) === 'reducing' ? METHOD.REDUCING : METHOD.EMI;
}

/** The monthly rate. A rate of 0 is legitimate (an interest-free settlement). */
export function monthlyRate(loan) {
    return num(loan && loan.rate) / 100 / 12;
}

/**
 * What is due in a month, given the balance at the START of it.
 *
 * Mirrors `_scheduledPaymentFor`: a reducing-balance loan pays a constant slice
 * of principal plus that month's interest, so the instalment falls over time;
 * an EMI loan pays the same figure throughout.
 */
export function scheduledPayment(loan, balanceAtStartOfMonth) {
    const l = loan || {};
    if (methodOf(l) === METHOD.REDUCING) {
        const duration = Math.max(1, Math.floor(num(l.duration)) || 1);
        return num(l.amount) / duration + num(balanceAtStartOfMonth) * monthlyRate(l);
    }
    return num(l.monthly);
}

/* ── 2. what has actually been paid ───────────────────────────────────────── */

/** `YYYY-MM` for the nth month after the loan started. */
export function monthKeyAt(loan, index) {
    const start = new Date(s(loan && loan.start) + 'T00:00:00');
    if (!Number.isFinite(start.getTime())) return null;
    const d = new Date(start.getFullYear(), start.getMonth() + index, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** The payment recorded for a month, or null. Only `paid` entries count. */
export function paymentFor(loan, monthKey) {
    const p = arr(loan && loan.payments).find((x) => x && x.month === monthKey && x.paid);
    return p || null;
}

/* ── 3. the projection ────────────────────────────────────────────────────── */

/* A hundred years. Not a plausible loan — a containment boundary, so that a
 * shape nobody anticipated ends as a returned reason rather than a frozen tab. */
export const MAX_MONTHS = 1200;

export const AMORTIZE = {
    BELOW_INTEREST: 'payment-below-interest',
    DOES_NOT_AMORTIZE: 'does-not-amortize',
    NO_TERMS: 'loan-terms-incomplete',
};

export const AMORTIZE_TEXT = {
    [AMORTIZE.BELOW_INTEREST]: 'the instalment is smaller than the interest, so the balance grows every month',
    [AMORTIZE.DOES_NOT_AMORTIZE]: 'at this rate the loan does not finish within a lifetime',
    [AMORTIZE.NO_TERMS]: 'this loan is missing the figures needed to project it',
};

/**
 * Walk the loan month by month: recorded payments as they really happened, then
 * projected instalments until the balance clears.
 *
 * Returns `{ ok: true, rows, ... }` or `{ ok: false, reason, detail }`. It never
 * throws and never loops without a bound.
 */
export function project(loan, opts = {}) {
    const l = loan || {};
    const principal = num(l.amount);
    const duration = Math.floor(num(l.duration));
    if (principal <= 0 || duration <= 0 || !monthKeyAt(l, 0)) {
        return { ok: false, reason: AMORTIZE.NO_TERMS, detail: { amount: principal, duration } };
    }

    const rate = monthlyRate(l);
    const cap = Math.max(1, Math.min(MAX_MONTHS, Math.floor(num(opts.maxMonths)) || MAX_MONTHS));
    const rows = [];
    let balance = principal;
    let interestPaid = 0;
    let interestRemaining = 0;
    let i = 0;

    while (balance > 0.005 && i < cap) {
        const monthKey = monthKeyAt(l, i);
        const opening = balance;
        const interest = opening * rate;
        const due = scheduledPayment(l, opening);

        const recorded = paymentFor(l, monthKey);
        /* A recorded payment with no amount is an older row from before amounts
         * were captured. index.html reads those as the scheduled figure, and
         * reading them any other way here would make this module disagree with
         * the balance the owner is already looking at. */
        const actual = recorded ? (recorded.amount != null ? num(recorded.amount) : due) : null;
        const payment = actual != null ? actual : due;

        /* THE INFINITE LOOP, REFUSED BY NAME.
         *
         * Only for PROJECTED months. A recorded underpayment is a fact that
         * already happened and the balance must carry it; it is the assumption
         * that every future month repeats it that never terminates. */
        if (actual == null && payment <= interest + 0.005) {
            return {
                ok: false,
                reason: AMORTIZE.BELOW_INTEREST,
                detail: {
                    month: monthKey,
                    payment: round2(payment),
                    interest: round2(interest),
                    shortfall: round2(interest - payment),
                    balance: round2(opening),
                },
            };
        }

        const closing = Math.max(0, opening + interest - payment);
        const applied = round2(Math.min(payment, opening + interest));

        rows.push({
            month: monthKey,
            opening: round2(opening),
            interest: round2(interest),
            payment: applied,
            principal: round2(applied - interest),
            closing: round2(closing),
            recorded: actual != null,
        });

        if (actual != null) interestPaid += interest; else interestRemaining += interest;
        balance = closing;
        i += 1;
    }

    if (balance > 0.005) {
        return { ok: false, reason: AMORTIZE.DOES_NOT_AMORTIZE, detail: { months: i, balance: round2(balance) } };
    }

    const paidRows = rows.filter((r) => r.recorded);
    const last = rows[rows.length - 1] || null;

    return {
        ok: true,
        rows,
        method: methodOf(l),
        monthsTaken: rows.length,
        monthsPaid: paidRows.length,
        monthsRemaining: rows.length - paidRows.length,
        payoffMonth: last ? last.month : null,
        finalPayment: last ? last.payment : 0,
        interestPaid: round2(interestPaid),
        interestRemaining: round2(interestRemaining),
        totalInterest: round2(interestPaid + interestRemaining),
        balance: paidRows.length ? round2(rows[paidRows.length - 1].closing) : round2(principal),
    };
}

/* ── 4. what changed, against the loan as originally written ──────────────── */

/**
 * The same loan with every payment exactly on schedule — the story the app
 * tells today. Used as the baseline to say what the real payments changed.
 */
export function baseline(loan) {
    return project({ ...(loan || {}), payments: [] });
}

/**
 * How the real payments moved the loan.
 *
 * `monthsSaved` and `interestSaved` are positive when the owner is ahead and
 * negative when behind. Reporting an underpayment as a negative saving rather
 * than as a separate "loss" keeps one number to read instead of two to compare.
 */
export function drift(loan) {
    const real = project(loan);
    const plan = baseline(loan);
    if (!real.ok || !plan.ok) return { ok: false, real, plan };
    return {
        ok: true,
        monthsSaved: plan.monthsTaken - real.monthsTaken,
        interestSaved: round2(plan.totalInterest - real.totalInterest),
        payoffMoved: plan.payoffMonth !== real.payoffMonth,
        from: plan.payoffMonth,
        to: real.payoffMonth,
    };
}

/* ── 5. the answers a screen asks for ─────────────────────────────────────── */

/** Progress by money repaid, not by months elapsed. */
export function progress(loan) {
    const r = project(loan);
    const principal = num(loan && loan.amount);
    if (!r.ok || principal <= 0) return { ok: false, pct: 0 };
    const repaid = principal - r.balance;
    return {
        ok: true,
        pct: Math.max(0, Math.min(100, Math.round((repaid / principal) * 100))),
        repaid: round2(repaid),
        outstanding: round2(r.balance),
        monthsPaid: r.monthsPaid,
        monthsRemaining: r.monthsRemaining,
    };
}

/**
 * How far behind the schedule the owner is, in money.
 *
 * Measured against what the ORIGINAL plan said should have been paid by now,
 * not against what is left — a loan can be behind on instalments while its
 * balance still looks healthy, and that is exactly the state worth naming.
 */
export function arrears(loan) {
    const l = loan || {};
    const plan = baseline(l);
    if (!plan.ok) return { ok: false, reason: plan.reason };

    let due = 0;
    let paid = 0;
    for (let i = 0; i < plan.rows.length; i++) {
        const monthKey = plan.rows[i].month;
        const rec = paymentFor(l, monthKey);
        if (!rec) continue;                       // not yet due, or not yet recorded
        due += plan.rows[i].payment;
        paid += rec.amount != null ? num(rec.amount) : plan.rows[i].payment;
    }
    const behind = round2(due - paid);
    return { ok: true, behind: behind > 0 ? behind : 0, ahead: behind < 0 ? round2(-behind) : 0 };
}

const API = {
    METHOD, MAX_MONTHS, AMORTIZE, AMORTIZE_TEXT,
    methodOf, monthlyRate, scheduledPayment, monthKeyAt, paymentFor,
    project, baseline, drift, progress, arrears,
};

export default API;
