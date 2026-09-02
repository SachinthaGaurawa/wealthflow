// =============================================================================
// WealthFlow — Committed Cash Flow Engine
// -----------------------------------------------------------------------------
// WHAT THIS ANSWERS
//
//   "On which day do I run out of money, and which specific commitment does it?"
//
// The app already knows every loan EMI, card instalment, subscription renewal
// and post-dated cheque the user has agreed to. Those are not forecasts — they
// are dated obligations sitting in the ledger. Until now nothing walked them
// forward day by day, so the one question that actually changes behaviour went
// unanswered while a Monte Carlo page projected six months of aggregate wealth.
//
// -----------------------------------------------------------------------------
// THE DESIGN DECISION THAT MATTERS: COMMITTED IS NOT SIMULATED
//
// A loan EMI of 45,000 on the 5th is not a random variable. Neither is a
// post-dated cheque, which clears on the date written on it. Randomising them
// would widen the confidence band with noise that does not exist and bury the
// real signal — that the 5th is the day the account goes under.
//
// So the projection is split, and the split is visible in the output:
//
//   certainty: 'committed'  a dated obligation already in the ledger. Walked
//                           forward exactly. Never randomised.
//   certainty: 'expected'   a recurring pattern with a known amount but a
//                           softer date (a monthly expense that carries only
//                           YYYY-MM, salary on a nominal pay day).
//   certainty: 'variable'   discretionary spending, estimated from history.
//                           This is the ONLY part `simulate()` randomises.
//
// A band drawn around committed outflows is a lie about precision. A band drawn
// around the variable slice is the actual uncertainty.
//
// -----------------------------------------------------------------------------
// EVERY FIELD READ HERE WAS TAKEN FROM THE CODE THAT WRITES IT
//
//   loans        { amount, rate, duration, monthly, start, paymentMethod,
//                  skipped[] }                                    saveLoan()
//   ccinstall    { total, duration, monthly, date, completed, skipped[] }
//   subscriptions{ name, amount, dueDay, cycle }                  save path
//   cheques      { type:'issued'|'received', amount, release, status }
//   expenses     { desc, cat, amount, month:'YYYY-MM', recurring, completed }
//   income       { monthly, day, start, end, freq }               saveIncome()
//   incomeRecv   { amount, date, received }                       saveIncomeRecv()
//   balance      { total, flows:[{ type:'in'|'out', amount }] }   renderBalance()
//
// Nothing here invents a field. A record missing what it needs is skipped and
// counted in `ignored`, never guessed at — a projection built on invented data
// is worse than no projection, because it is believed.
//
// -----------------------------------------------------------------------------
// PURE BY CONSTRUCTION
//
// No DOM, no storage, no network, no `new Date()` without an argument. `asOf` is
// always passed in, so the same inputs give the same output on every run and in
// every test. That is what makes this module testable at all, and it is why it
// can live outside index.html.
// =============================================================================

/* The cadence rule, shared with the verification queue. One answer to "does
 * this source pay in this month", used by the projection and by the screen that
 * asks the owner to confirm the payout — they must not be able to disagree. */
import { paysInMonth } from './wealthflow-verify-matrix.js';

/* ── date helpers, all UTC-normalised to a day boundary ───────────────────── */

const DAY_MS = 86400000;

/** 'YYYY-MM-DD' for a Date, in UTC. */
export function isoDay(d) {
    const t = new Date(d);
    if (!isFinite(t.getTime())) return null;
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()))
        .toISOString().slice(0, 10);
}

/** Parse a 'YYYY-MM-DD' or ISO timestamp to a UTC day Date. Null if unusable. */
export function parseDay(v) {
    if (!v) return null;
    const s = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const d = new Date(s);
    return isFinite(d.getTime())
        ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
        : null;
}

export function addDays(d, n) { return new Date(d.getTime() + n * DAY_MS); }

/**
 * The nth day of a month, clamped to the month's length.
 *
 * A subscription with dueDay 31 must not silently land on 3 March. Clamping to
 * the 28th/29th/30th is what a bank does with a standing order, and it is the
 * only choice that keeps twelve monthly charges in twelve distinct months.
 */
export function dayInMonth(year, monthIdx, day) {
    const last = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, monthIdx, Math.min(Math.max(1, day | 0) || 1, last)));
}

/** Whole months from `a` to `b`, by calendar, not by 30-day arithmetic. */
export function monthsBetween(a, b) {
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
};
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── the opening balance ──────────────────────────────────────────────────── */

/**
 * Net cash on hand, computed the same way renderBalance() shows it:
 * total − outflows + inflows. Any other formula here would put the projection
 * and the Balance page on different numbers, which is worse than being wrong,
 * because the user would have to work out which one to believe.
 */
export function openingBalance(appData) {
    const b = (appData && appData.balance) || {};
    const flows = arr(b.flows);
    let out = 0, inn = 0;
    for (const f of flows) {
        if (!f) continue;
        if (f.type === 'out') out += num(f.amount);
        else if (f.type === 'in') inn += num(f.amount);
    }
    return num(b.total) - out + inn;
}

/* ── commitments ──────────────────────────────────────────────────────────── */

/**
 * Every dated money movement between `from` and `to`, inclusive.
 *
 * Returns a flat list rather than a total, because "you are short on the 5th" is
 * only actionable alongside "because of the BOC loan and the Nespresso renewal".
 * The whole point is to name the cause.
 */
export function commitments(appData, from, to) {
    const A = appData || {};
    const out = [];
    const ignored = [];
    const push = (date, kind, amount, label, source, certainty, id) => {
        if (!date || date < from || date > to) return;
        const a = num(amount);
        if (!(a > 0)) return;
        out.push({ date: isoDay(date), kind, amount: a, label, source, certainty, id: id || null });
    };
    const skip = (source, id, why) => ignored.push({ source, id: id || null, why });

    // ── loans: a fixed monthly payment from `start`, for `duration` months ──
    for (const l of arr(A.loans)) {
        if (!l) continue;
        const start = parseDay(l.start);
        const dur = num(l.duration);
        const monthly = num(l.monthly);
        if (!start || !(dur > 0) || !(monthly > 0)) { skip('loans', l.id, 'no start, duration or monthly amount'); continue; }
        const skipped = new Set(arr(l.skipped).map(String));
        /* INSTALMENT 1 IS IN THE START MONTH, NOT THE MONTH AFTER.
         *
         * The app's own schedule builder is the authority:
         *     _loanInstallmentMonths(l)   index.html
         *     for (let i = 0; i < l.duration; i++)
         *         new Date(start.getFullYear(), start.getMonth() + i, 1)
         * i = 0 is the start month. A 60-month loan starting 2026-03 runs
         * 2026-03 .. 2031-02, and the loan page numbers 2026-09 as instalment 7.
         *
         * This loop originally ran `start.getMonth() + n` for n = 1..duration,
         * which was wrong twice over: every instalment carried a number one
         * lower than the loan page showed for the same date, and the series ran
         * one month PAST the end of the term — projecting a payment that is not
         * owed. The dates in the middle happened to agree, which is why it
         * looked right. Two screens disagreeing about the same loan is exactly
         * what openingBalance() was written to prevent, one function above.
         *
         * The day-of-month is this module's own refinement — the loan page works
         * in whole months, and a day-by-day projection needs the day. It matches
         * getNextOccurenceDate(), which the dashboard already uses to place the
         * next payment on the start date's day-of-month. */
        for (let n = 1; n <= dur; n++) {
            const d = dayInMonth(start.getUTCFullYear(), start.getUTCMonth() + n - 1, start.getUTCDate());
            if (d > to) break;
            if (d < from) continue;
            const key = d.toISOString().slice(0, 7);
            // `skipped` is written by the app as either a month key or an index;
            // both are honoured because both appear in stored records.
            if (skipped.has(key) || skipped.has(String(n))) continue;
            push(d, 'out', monthly, (l.name || 'Loan') + ' — instalment ' + n + '/' + dur,
                'loans', 'committed', l.id);
        }
    }

    // ── card instalment plans: same shape, `date` instead of `start` ────────
    for (const c of arr(A.ccinstall)) {
        if (!c || c.completed) continue;
        const start = parseDay(c.date);
        const dur = num(c.duration);
        const monthly = num(c.monthly);
        if (!start || !(dur > 0) || !(monthly > 0)) { skip('ccinstall', c.id, 'no date, duration or monthly amount'); continue; }
        const skipped = new Set(arr(c.skipped).map(String));
        // Same convention as loans, and for the same reason: the dashboard's
        // upcoming-payments list bounds a card plan with
        //     endD = new Date(c.date); endD.setMonth(endD.getMonth() + c.duration)
        // as an EXCLUSIVE end, so the instalments occupy start + 0 .. duration-1.
        for (let n = 1; n <= dur; n++) {
            const d = dayInMonth(start.getUTCFullYear(), start.getUTCMonth() + n - 1, start.getUTCDate());
            if (d > to) break;
            if (d < from) continue;
            if (skipped.has(d.toISOString().slice(0, 7)) || skipped.has(String(n))) continue;
            push(d, 'out', monthly, (c.product || 'Card instalment') + ' — ' + n + '/' + dur,
                'ccinstall', 'committed', c.id);
        }
    }

    // ── subscriptions: dueDay each cycle ───────────────────────────────────
    const CYCLE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
    for (const s of arr(A.subscriptions)) {
        if (!s) continue;
        const amount = num(s.amount);
        const step = CYCLE_MONTHS[String(s.cycle || 'monthly')] || 1;
        const dueDay = num(s.dueDay) || 1;
        if (!(amount > 0)) { skip('subscriptions', s.id, 'no amount'); continue; }
        // Anchor the cycle on the record's own creation month so a quarterly
        // renewal lands on ITS quarter, not on whichever month the window opens.
        const anchor = parseDay(s.createdAt) || from;
        let m = monthsBetween(anchor, from);
        m -= ((m % step) + step) % step;           // step back to the cycle boundary
        for (let k = m; ; k += step) {
            const d = dayInMonth(anchor.getUTCFullYear(), anchor.getUTCMonth() + k, dueDay);
            if (d > to) break;
            if (d < from) continue;
            push(d, 'out', amount, (s.name || 'Subscription') + ' renewal',
                'subscriptions', 'committed', s.id);
        }
    }

    // ── cheques: the one genuinely certain date in the whole ledger ─────────
    // A post-dated cheque clears on the day written on it. `status` is 'pending'
    // until it does; anything already cleared or cancelled must not project.
    for (const c of arr(A.cheques)) {
        if (!c) continue;
        if (String(c.status || 'pending') !== 'pending') continue;
        const d = parseDay(c.release) || parseDay(c.issue);
        if (!d) { skip('cheques', c.id, 'no release or issue date'); continue; }
        const issued = String(c.type) === 'issued';
        push(d, issued ? 'out' : 'in', c.amount,
            'Cheque ' + (c.no || '') + ' — ' + (c.party || (issued ? 'payee' : 'payer')),
            'cheques', 'committed', c.id);
    }

    // ── receivables with an actual date ────────────────────────────────────
    for (const r of arr(A.incomeRecv)) {
        if (!r || r.received) continue;
        const d = parseDay(r.date);
        if (!d) { skip('incomeRecv', r.id, 'no date'); continue; }
        push(d, 'in', r.amount, (r.name || 'Receivable'), 'incomeRecv', 'committed', r.id);
    }

    // ── investment income on its nominal pay day ───────────────────────────
    // 'expected', not 'committed': `day` is a nominal pay day, and a payout can
    // land a day or two either side. The amount is known; the date is soft.
    //
    // AND THE CADENCE IS READ, WHICH IT WAS NOT. `income` records carry `freq`
    // — monthly, quarterly or annual — and saveIncome puts the PER-PAYOUT
    // figure in a field called `monthly` for all three:
    //
    //     monthly:   amount * rate / 100 / 12
    //     quarterly: amount * rate / 100 / 4
    //     annual:    amount * rate / 100
    //
    // This loop read that field and pushed it in EVERY month, so an annual
    // payout was projected twelve times — the whole year's interest counted
    // once a month, every month. On a projection whose entire purpose is
    // "which day do I run out of money", that overstates income by 12x on any
    // annual holding and 4x on a quarterly one.
    //
    // paysInMonth is imported rather than reimplemented: the verification queue
    // asks the same question about the same records, and two answers to "does
    // this pay in September" is how a screen and a projection disagree.
    for (const i of arr(A.income)) {
        if (!i) continue;
        const monthly = num(i.monthly);
        if (!(monthly > 0)) { skip('income', i.id, 'no monthly amount'); continue; }
        const begins = parseDay(i.start);
        const ends = parseDay(i.end);
        const payDay = num(i.day) || 1;
        for (let k = 0; ; k++) {
            const d = dayInMonth(from.getUTCFullYear(), from.getUTCMonth() + k, payDay);
            if (d > to) break;
            if (d < from) continue;
            if (begins && d < begins) continue;
            if (ends && d > ends) continue;
            if (!paysInMonth(i, from.getUTCFullYear(), from.getUTCMonth() + k)) continue;
            push(d, 'in', monthly, (i.name || 'Investment income'), 'income', 'expected', i.id);
        }
    }

    // ── recurring expenses: month known, day not ───────────────────────────
    // These carry `month: 'YYYY-MM'` and no day at all, so they are placed on
    // the 1st and marked 'expected'. Placing them on a made-up day and calling
    // them committed would be the invention this module refuses to make.
    const seenRecurring = new Set();
    for (const e of arr(A.expenses)) {
        if (!e || !e.recurring || e.completed) continue;
        const amount = num(e.amount);
        if (!(amount > 0)) { skip('expenses', e.id, 'no amount'); continue; }
        const key = String(e.desc || '') + '|' + amount;
        if (seenRecurring.has(key)) continue;       // one series, not one per month
        seenRecurring.add(key);
        for (let k = 0; ; k++) {
            const d = dayInMonth(from.getUTCFullYear(), from.getUTCMonth() + k, 1);
            if (d > to) break;
            if (d < from) continue;
            push(d, 'out', amount, (e.desc || 'Recurring expense'), 'expenses', 'expected', e.id);
        }
    }

    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
    return { items: out, ignored };
}

/* ── the variable slice ───────────────────────────────────────────────────── */

/**
 * Average NON-recurring spend per day, from the last `months` complete months.
 *
 * Recurring expenses are excluded because `commitments()` already projects them;
 * counting them twice is the obvious way to make this whole thing pessimistic
 * and useless.
 *
 * Returns 0 rather than a guess when there is no history. A new user gets a
 * projection of their committed obligations only, which is honest — the app has
 * nothing to say about their discretionary spending yet.
 */
export function variableDailySpend(appData, asOf, months = 3) {
    const A = appData || {};
    const end = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
    const keys = [];
    for (let k = 1; k <= months; k++) {
        const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - k, 1));
        keys.push(d.toISOString().slice(0, 7));
    }
    const inWindow = new Set(keys);
    let total = 0;
    const perMonth = {};
    for (const e of arr(A.expenses)) {
        if (!e || e.recurring) continue;
        const m = String(e.month || '').slice(0, 7);
        if (!inWindow.has(m)) continue;
        const a = num(e.amount);
        if (!(a > 0)) continue;
        total += a;
        perMonth[m] = (perMonth[m] || 0) + a;
    }
    const observed = Object.keys(perMonth).length;
    if (!observed) return { perDay: 0, perMonth: 0, monthsObserved: 0, spread: 0 };
    const avgMonth = total / observed;
    // Spread across the observed months, for the simulation band. One month of
    // history has no spread to measure, and pretending otherwise would draw a
    // confidence interval out of a single data point.
    let variance = 0;
    for (const m of Object.keys(perMonth)) variance += Math.pow(perMonth[m] - avgMonth, 2);
    const spread = observed > 1 ? Math.sqrt(variance / (observed - 1)) : 0;
    return {
        perDay: avgMonth / 30.44,
        perMonth: avgMonth,
        monthsObserved: observed,
        spread,
    };
}

/* ── the projection ───────────────────────────────────────────────────────── */

/**
 * Walk `horizon` days forward from `asOf`, applying every commitment on its day.
 *
 * @param opts.asOf        Date — required in tests, defaults to today in the app.
 * @param opts.horizon     days to project (default 90).
 * @param opts.floor       the balance the user considers "in trouble" (default 0).
 * @param opts.includeVariable  fold the estimated discretionary spend in (default true).
 * @param opts.extraCommitments dated events the caller derived elsewhere —
 *                              sweep maturities, in practice. Filtered to the
 *                              window; never trusted to widen it.
 * @param opts.extraMonthly     an additional recurring outflow to test against —
 *                              a proposed extra debt payment, a new standing
 *                              order. Applied on `extraDay` of each month.
 * @param opts.extraDay         day-of-month for that outflow (default: asOf's).
 */
export function project(appData, opts = {}) {
    // asOf is REQUIRED, with no fallback to the clock.
    //
    // The header of this file claims the module never reads the clock, and the
    // first version of this line quietly did — `opts.asOf ? … : parseDay(new
    // Date())`. That default is the whole difference between a module whose
    // output is a function of its inputs and one that is only usually
    // reproducible. It would also have hidden a caller that forgot to pass the
    // date: everything would look right until a test ran across midnight.
    //
    // Reading the clock is the caller's job, and the caller is a UI that already
    // knows what day it is showing.
    const asOf = parseDay(opts.asOf);
    if (!asOf) throw new TypeError('project(): asOf must be a date — this module never reads the clock');
    const horizon = Math.max(1, Math.min(730, opts.horizon || 90));
    const floor = num(opts.floor);
    const includeVariable = opts.includeVariable !== false;
    const to = addDays(asOf, horizon);

    const { items, ignored } = commitments(appData, asOf, to);
    const variable = variableDailySpend(appData, asOf, opts.lookbackMonths || 3);
    const perDayVariable = includeVariable ? variable.perDay : 0;

    const byDate = new Map();
    for (const it of items) {
        if (!byDate.has(it.date)) byDate.set(it.date, []);
        byDate.get(it.date).push(it);
    }

    /* ── commitments the caller derived elsewhere ───────────────────────────
     *
     * Events this module cannot produce from `appData` alone, because the rule
     * that produces them does not live here.
     *
     * Recorded sweeps are why this exists. Whether a sweep contributes one leg
     * or two depends on whether the transfer has already left the account —
     * money already moved is ALREADY missing from `balance.total`, so counting
     * it again bills the user twice for one transfer. That rule, and the record
     * parsing it needs, live in wealthflow-sweep-ledger.js, which imports this
     * file for its date helpers. Importing it back would make the pair
     * circular, so the legs are handed in instead.
     *
     * The caller does not get to widen the projection: anything outside the
     * window, without a positive amount, or without a real direction is
     * dropped rather than coerced.
     *
     * Into BOTH lists, for the same reason extraMonthly is below — a day row
     * carrying an event the commitment list does not is the two-views-one-truth
     * problem this module keeps closing.
     */
    let addedExtra = false;
    for (const raw of (Array.isArray(opts.extraCommitments) ? opts.extraCommitments : [])) {
        if (!raw) continue;
        if (raw.kind !== 'in' && raw.kind !== 'out') continue;
        const d = parseDay(raw.date);
        const a = num(raw.amount);
        if (!d || d < asOf || d > to || !(a > 0)) continue;
        const key = isoDay(d);
        const ev = {
            date: key, kind: raw.kind, amount: a,
            label: String(raw.label || 'Caller-supplied'),
            source: String(raw.source || 'external'),
            certainty: String(raw.certainty || 'expected'),
            id: raw.id != null ? String(raw.id) : null,
        };
        items.push(ev);
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(ev);
        addedExtra = true;
    }
    if (addedExtra) items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));

    // A proposed recurring outflow, tested against the same dated obligations.
    // It is a real event on a real day, not a monthly average subtracted at the
    // end — the whole reason this module exists is that WHEN money leaves
    // decides whether you survive the month.
    const extraMonthly = Math.max(0, num(opts.extraMonthly));
    if (extraMonthly > 0) {
        const day = num(opts.extraDay) || asOf.getUTCDate();
        for (let k = 0; ; k++) {
            const d = dayInMonth(asOf.getUTCFullYear(), asOf.getUTCMonth() + k, day);
            if (d > to) break;
            if (d < asOf) continue;          // this month's has already gone out
            const key = isoDay(d);
            const ev = {
                date: key, kind: 'out', amount: extraMonthly,
                label: 'Proposed extra payment', source: 'proposed',
                certainty: 'proposed', id: null,
            };
            // Into BOTH lists. `items` is what callers read as `commitments`, and
            // a day row carrying an event that the commitment list does not is
            // the same two-views-one-truth problem this module keeps closing.
            items.push(ev);
            if (!byDate.has(key)) byDate.set(key, []);
            byDate.get(key).push(ev);
        }
        items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
    }

    let balance = openingBalance(appData);
    const days = [];
    let runway = null;              // first day the balance is below the floor
    let tightest = null;            // the lowest point reached, floor or not

    for (let k = 0; k <= horizon; k++) {
        const d = addDays(asOf, k);
        const date = isoDay(d);
        const events = byDate.get(date) || [];
        let inn = 0, out = 0;
        for (const e of events) { if (e.kind === 'in') inn += e.amount; else out += e.amount; }
        // Day 0 is today's closing position: today's commitments have either
        // happened or are about to, and the variable spend for a day already
        // under way would be double-counted against money already gone.
        const varOut = k === 0 ? 0 : perDayVariable;
        balance = balance + inn - out - varOut;
        const row = {
            date, in: inn, out: out + varOut, balance,
            variable: varOut, events,
        };
        days.push(row);
        if (runway === null && balance < floor) {
            runway = { date, balance, daysAway: k, causes: events.filter((e) => e.kind === 'out') };
        }
        if (!tightest || balance < tightest.balance) {
            tightest = { date, balance, daysAway: k, causes: events.filter((e) => e.kind === 'out') };
        }
    }

    const totals = days.reduce((acc, r) => {
        acc.in += r.in; acc.out += r.out; return acc;
    }, { in: 0, out: 0 });

    return {
        asOf: isoDay(asOf),
        horizon,
        floor,
        opening: openingBalance(appData),
        closing: balance,
        days,
        commitments: items,
        ignored,
        variable,
        totals,
        runway,          // null means the balance never drops below the floor
        tightest,
    };
}

/* ── safe to spend ────────────────────────────────────────────────────────── */

/**
 * What can be spent today without breaking anything already committed, up to
 * the next inflow.
 *
 * This is deliberately the most conservative reading available: the lowest
 * point the balance reaches before the next money arrives, minus the floor. It
 * is not "balance minus this month's bills" — an average is no use on the day
 * before a cheque clears.
 */
export function safeToSpend(appData, opts = {}) {
    const p = project(appData, opts);
    const nextIn = p.days.find((d, i) => i > 0 && d.in > 0);
    const until = nextIn ? nextIn.date : p.days[p.days.length - 1].date;
    let low = Infinity;
    let lowDate = null;
    for (const d of p.days) {
        if (d.date > until) break;
        if (d.balance < low) { low = d.balance; lowDate = d.date; }
    }
    const amount = Math.max(0, low - p.floor);
    return {
        amount,
        until,
        lowestDate: lowDate,
        lowestBalance: low === Infinity ? p.opening : low,
        reason: nextIn
            ? 'the lowest point before the next money arrives on ' + until
            : 'no inflow is expected in the next ' + p.horizon + ' days',
    };
}

/* ── what you can actually commit to, every month ─────────────────────────── */

/**
 * The largest RECURRING monthly payment that never drives the projection below
 * the floor — an extra debt payment, a new standing order, a savings transfer.
 *
 * WHY THIS IS NOT AN AVERAGE
 *
 * The Debt Demolisher has been suggesting `netMonthlyCashFlow * 0.5`: a
 * monthly-average surplus, halved because half of an average is a safer number
 * than all of it. That is a reasonable guess in the absence of dates, and it is
 * wrong in both directions. It offers too much to somebody whose 180,000 cheque
 * clears on the 15th, and too little to somebody whose commitments are already
 * spread evenly — the 50% haircut is a stand-in for the timing information the
 * app already has.
 *
 * This searches for the real number instead. Each candidate is a genuine dated
 * outflow on a chosen day of every month, projected against every loan EMI,
 * card instalment, subscription renewal and post-dated cheque on ITS date. The
 * answer is the largest candidate whose worst day still clears the floor.
 *
 * Binary search, because the property is monotone: if paying X every month
 * never breaks the floor, paying anything less than X cannot break it either.
 * 40 iterations resolve LKR 1 out of 10 million.
 */
export function sustainableMonthly(appData, opts = {}) {
    const floor = num(opts.floor);
    const probe = (extraMonthly) => project(appData, { ...opts, extraMonthly }).runway === null;

    // If the plan is already under water, no extra payment is affordable and
    // the honest answer is zero — not "half of a negative number".
    if (!probe(0)) {
        const base = project(appData, opts);
        return {
            amount: 0, day: num(opts.extraDay) || parseDay(opts.asOf).getUTCDate(),
            horizon: base.horizon,
            reason: 'the plan already goes below the floor on ' + base.runway.date
                + ' without any extra payment',
            limitedBy: base.runway,
        };
    }

    // An upper bound nothing could exceed: everything on hand plus everything
    // expected in, spread over the months in the horizon.
    const base = project(appData, opts);
    const months = Math.max(1, base.horizon / 30.44);
    let lo = 0;
    let hi = Math.max(1, (base.opening + base.totals.in) / months);
    if (probe(hi)) {
        // Nothing in the horizon constrains it. Report the bound rather than
        // searching upwards forever, and say so.
        return {
            amount: hi, day: num(opts.extraDay) || parseDay(opts.asOf).getUTCDate(),
            horizon: base.horizon,
            reason: 'no commitment in the next ' + base.horizon + ' days constrains this',
            limitedBy: null,
        };
    }
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (probe(mid)) lo = mid; else hi = mid;
    }

    // What the answer is bounded BY — the day that would break first if you
    // paid a rupee more. Naming it is the difference between a limit and a
    // reason.
    const atLimit = project(appData, { ...opts, extraMonthly: hi });
    return {
        amount: Math.floor(lo),
        day: num(opts.extraDay) || parseDay(opts.asOf).getUTCDate(),
        horizon: base.horizon,
        // Names the binding date without claiming "any more breaks it". Callers
        // round this figure to something a person would actually pay — a slider
        // stepping in thousands, say — and at the rounded value a little more IS
        // still affordable. The date is the true statement either way.
        reason: atLimit.runway
            ? 'limited by ' + atLimit.runway.date + ', the first day the balance would go under'
            : 'bounded by the projection floor',
        limitedBy: atLimit.runway,
    };
}

/* ── the band ─────────────────────────────────────────────────────────────── */

/**
 * Monte Carlo over the VARIABLE slice only.
 *
 * Committed outflows are held fixed on their dates in every path, because they
 * are fixed. What varies between paths is discretionary spending, drawn from
 * the mean and spread actually observed in the user's own history.
 *
 * `seed` makes it reproducible: an advice screen that shows a different runway
 * date each time it is opened is not advice, it is noise, and it is also
 * untestable.
 */
export function simulate(appData, opts = {}) {
    const runs = Math.max(1, Math.min(2000, opts.runs || 400));
    const base = project(appData, { ...opts, includeVariable: false });
    const v = base.variable;
    // Daily spread implied by the month-to-month spread, assuming days within a
    // month vary independently. sqrt(30.44) is the scaling that gets back to a
    // monthly spread of `v.spread` when the days are summed.
    const dailyMean = v.perDay;
    const dailySd = v.monthsObserved > 1 ? (v.spread / 30.44) * Math.sqrt(30.44) : dailyMean * 0.35;

    let state = (opts.seed || 20260826) >>> 0;
    const rnd = () => {                       // mulberry32 — small, fast, seeded
        state = (state + 0x6D2B79F5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () => {                    // Box–Muller
        let u = 0, w = 0;
        while (u === 0) u = rnd();
        while (w === 0) w = rnd();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
    };

    const n = base.days.length;
    const paths = [];
    const runwayDays = [];
    for (let r = 0; r < runs; r++) {
        let bal = base.opening;
        const path = new Array(n);
        let hit = null;
        for (let k = 0; k < n; k++) {
            const d = base.days[k];
            // Spending cannot be negative, however the draw comes out.
            const spend = k === 0 ? 0 : Math.max(0, dailyMean + normal() * dailySd);
            bal = bal + d.in - d.out - spend;
            path[k] = bal;
            if (hit === null && bal < base.floor) hit = k;
        }
        paths.push(path);
        runwayDays.push(hit === null ? Infinity : hit);
    }

    const pct = (sorted, q) => sorted[Math.min(sorted.length - 1,
        Math.max(0, Math.round(q * (sorted.length - 1))))];

    const bands = [];
    for (let k = 0; k < n; k++) {
        const col = paths.map((p) => p[k]).sort((a, b) => a - b);
        bands.push({ date: base.days[k].date, p10: pct(col, 0.10), p50: pct(col, 0.50), p90: pct(col, 0.90) });
    }

    const finite = runwayDays.filter((x) => x !== Infinity).sort((a, b) => a - b);
    return {
        runs,
        bands,
        // How often the user goes under at all, and how soon in the median case.
        shortfallProbability: finite.length / runs,
        medianRunwayDays: finite.length ? pct(finite, 0.5) : null,
        earliestRunwayDays: finite.length ? finite[0] : null,
        committed: base,
    };
}

/* ── the headline ─────────────────────────────────────────────────────────── */

/**
 * One object an interface can render without doing arithmetic of its own.
 * Keeping the judgement here rather than in a template means the same numbers
 * appear on every surface that asks.
 */
export function summarise(appData, opts = {}) {
    const p = project(appData, opts);
    const sts = safeToSpend(appData, opts);
    const committedOut = p.commitments
        .filter((c) => c.kind === 'out' && c.certainty === 'committed')
        .reduce((s, c) => s + c.amount, 0);

    let status = 'clear';
    if (p.runway) status = p.runway.daysAway <= 14 ? 'critical' : 'at-risk';
    else if (p.tightest && p.tightest.balance < p.floor + committedOut * 0.1) status = 'tight';

    return {
        status,
        asOf: p.asOf,
        horizon: p.horizon,
        opening: p.opening,
        closing: p.closing,
        committedOut,
        runwayDate: p.runway ? p.runway.date : null,
        runwayDays: p.runway ? p.runway.daysAway : null,
        // Naming the cause is the difference between a warning and advice.
        runwayCauses: p.runway ? p.runway.causes.slice(0, 4) : [],
        tightestDate: p.tightest ? p.tightest.date : null,
        tightestBalance: p.tightest ? p.tightest.balance : p.opening,
        safeToSpend: sts.amount,
        safeUntil: sts.until,
        ignored: p.ignored,
    };
}

const API = {
    isoDay, parseDay, addDays, dayInMonth, monthsBetween,
    openingBalance, commitments, variableDailySpend,
    project, safeToSpend, sustainableMonthly, simulate, summarise,
};

// Browser global, matching the other WealthFlow modules. Guarded so importing
// this file in Node (the test suite, any tooling) touches nothing.
if (typeof window !== 'undefined') window.WFCashflow = API;

export default API;
