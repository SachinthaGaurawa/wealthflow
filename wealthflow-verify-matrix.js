/* =============================================================================
 * wealthflow-verify-matrix.js — what is due, what is confirmed, what is late
 * -----------------------------------------------------------------------------
 * THE RULE THE OWNER STATED, AND IT IS THE WHOLE DESIGN:
 *
 *   "The system must NEVER automatically post or mark income as Received based
 *    on a static calendar. If a transaction fails to arrive in the bank, blind
 *    automation will corrupt the balance sheet."
 *
 * So a date arriving is not evidence of money arriving. What a date produces is
 * a QUESTION — one row, in a queue, waiting for a person to answer it — and
 * nothing about the ledger moves until they do.
 *
 * WHAT WAS ALREADY THERE, AND WHAT WAS NOT
 *
 * The app already asked the question: checkActionableReminders() raised a
 * banner on the pay day, and confirming wrote `incomeReceived[id_YYYY-MM]`.
 * But the banner is a moment. Close the app that day — or be asleep, or be
 * anywhere else — and the question is gone, while the money is still
 * unconfirmed and nothing on any screen says so. There was no queue, no state
 * to be in, and no way to say "this one is late" without either lying that it
 * arrived or being asked again tomorrow as though nothing had happened.
 *
 * This module is the decision half of that queue: which payouts are due, which
 * have been answered, which are late, and which the owner has flagged as
 * delayed. It touches no DOM, no storage and no clock — `asOf` is always passed
 * in — so the same inputs give the same answer in a test and in a browser.
 *
 * ── THE CADENCE BUG IT ALSO CLOSES ──────────────────────────────────────────
 *
 * `income` records carry `freq` — monthly, quarterly or annual — and saveIncome
 * computes the PER-PAYOUT amount from it:
 *
 *     monthly:   amount * rate / 100 / 12
 *     quarterly: amount * rate / 100 / 4
 *     annual:    amount * rate / 100
 *
 * and stores all three in a field called `monthly`. Nothing that reads it looks
 * at `freq`. So an annual payout is treated as arriving every month — the
 * reminder asks twelve times a year for money that comes once, and the cashflow
 * projection counts the full annual figure in every one of the twelve months.
 * The field name is the trap. This module reads `freq` and the queue only
 * raises a question in a month the source actually pays in.
 * ===========================================================================*/

/** The three states a due item can be in. VERIFIED items leave the queue. */
export const VERIFY = { PENDING: 'PENDING', VERIFIED: 'VERIFIED', DELAYED: 'DELAYED' };

/* How far back an unanswered payout keeps being offered.
 *
 * Not forever: a queue that accumulates every month since the account was
 * opened is a queue nobody reads, and the past-month confirmation screen
 * already exists for older history. Not one month either — the case this was
 * built for is an owner who did not open the app for a while. */
export const LOOKBACK_MONTHS = 6;

/* Days after the due date before an unanswered item reads as late. A payout
 * can land a day either side of its nominal day; calling that late on the
 * evening of the due date is how a queue teaches someone to ignore it. */
export const LATE_AFTER_DAYS = 2;

const DAY_MS = 86400000;
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const s = (v) => String(v == null ? '' : v).trim();

/** 'YYYY-MM' for a UTC date. */
export function monthKeyOf(d) {
    const t = new Date(d);
    if (!isFinite(t.getTime())) return '';
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Parse 'YYYY-MM-DD' (or an ISO timestamp) to a UTC day. Null if unusable. */
export function parseDay(v) {
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const d = new Date(v);
    return isFinite(d.getTime())
        ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
        : null;
}

/**
 * The day a payout falls on in a given month, with the day CLAMPED.
 *
 * A source paying on the 31st does not skip February. Date arithmetic that
 * rolls over would put it on 2 or 3 March and the queue would then ask about a
 * month that has no such day.
 */
export function dueDateFor(day, year, monthIdx) {
    const y = year + Math.floor(monthIdx / 12);
    const m = ((monthIdx % 12) + 12) % 12;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const d = Math.min(Math.max(1, Math.floor(num(day)) || 1), last);
    return new Date(Date.UTC(y, m, d));
}

/** How many months between payouts, from a source's `freq`. */
export function periodMonths(freq) {
    const f = s(freq).toLowerCase();
    if (f === 'annual' || f === 'annually' || f === 'yearly') return 12;
    if (f === 'quarterly' || f === 'quarter') return 3;
    return 1;                                    // monthly, and anything unset
}

/**
 * Does this source pay out in this month?
 *
 * Anchored on the START date, and the first payout lands one full PERIOD after
 * it — a monthly source bought on 15 April first pays on 15 May, an annual one
 * first pays the following April. index.html states the monthly half of that
 * rule where it auto-marks pre-join months; this is the same rule, generalised
 * to the cadence the record already carries.
 */
export function paysInMonth(source, year, monthIdx) {
    if (!source) return false;
    const end = parseDay(source.end);
    const due = dueDateFor(source.day, year, monthIdx);
    if (end && due > end) return false;

    const start = parseDay(source.start);
    const p = periodMonths(source.freq);
    if (!start) {
        /* NO START DATE, AND THE ANSWER DEPENDS ON THE CADENCE.
         *
         * A monthly source pays every month whatever its anchor, so an
         * unanchored one keeps behaving exactly as it always has — dropping it
         * would remove real records from a real projection over a missing
         * field. A quarterly or annual one cannot be placed at all without an
         * anchor: there is no way to know WHICH month, and asking in all of
         * them is the bug this function exists to fix. */
        return p === 1;
    }

    if (due < start) return false;
    const months = (due.getUTCFullYear() - start.getUTCFullYear()) * 12
        + (due.getUTCMonth() - start.getUTCMonth());
    return months >= p && months % p === 0;
}

/** The key `incomeReceived` and `incomeDelayed` are stored under. */
export function receivedKey(sourceId, mk) {
    return `${s(sourceId)}_${s(mk)}`;
}

/** The key the bill side uses. Same shape, different map — see pendingOutflows. */
export function billKey(subId, mk) {
    return `${s(subId)}_${s(mk)}`;
}

function stateOf(delayedMap, key, due, asOf) {
    if (delayedMap && delayedMap[key]) return VERIFY.DELAYED;
    return VERIFY.PENDING;
}

function daysLate(due, asOf) {
    return Math.max(0, Math.floor((asOf.getTime() - due.getTime()) / DAY_MS));
}

/**
 * Every payout whose date has arrived and which nobody has answered.
 *
 * `asOf` is a Date. Rows come back oldest first, because the oldest unanswered
 * question is the one most likely to be wrong.
 */
export function pendingInflows(appData, asOf, opts = {}) {
    const A = appData || {};
    const now = asOf instanceof Date ? asOf : new Date(asOf || 0);
    if (!isFinite(now.getTime())) return [];
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    /* `|| LOOKBACK_MONTHS` would eat a legitimate 0 — "just this month" — and
     * silently answer with six months instead. A number that was given is
     * honoured; only an absent or unusable one falls back. */
    const lb = Number(opts.lookbackMonths);
    const lookback = (Number.isFinite(lb) && lb >= 0) ? Math.floor(lb) : LOOKBACK_MONTHS;
    const received = (A.incomeReceived && typeof A.incomeReceived === 'object') ? A.incomeReceived : {};
    const delayed = (A.incomeDelayed && typeof A.incomeDelayed === 'object') ? A.incomeDelayed : {};

    const rows = [];
    for (const src of arr(A.income)) {
        if (!src || !src.id) continue;
        const amount = num(src.monthly);
        /* A source with no payout figure cannot produce a question worth
         * answering — "did you receive 0?" is noise, and guessing an amount is
         * the invention this app refuses to make. */
        if (!(amount > 0)) continue;

        for (let back = lookback; back >= 0; back -= 1) {
            const monthIdx = now.getUTCMonth() - back;
            if (!paysInMonth(src, now.getUTCFullYear(), monthIdx)) continue;
            const due = dueDateFor(src.day, now.getUTCFullYear(), monthIdx);
            /* NOT YET DUE IS NOT PENDING. The queue answers "has this arrived",
             * and a date in the future has no answer yet. */
            if (due > today) continue;
            const mk = monthKeyOf(due);
            const key = receivedKey(src.id, mk);
            if (received[key]) continue;                  // answered already
            rows.push({
                key,
                kind: 'inflow',
                sourceId: src.id,
                name: s(src.name) || 'Income',
                company: s(src.company),
                amount,
                monthKey: mk,
                dueISO: due.toISOString().slice(0, 10),
                state: stateOf(delayed, key, due, today),
                daysLate: daysLate(due, today),
                late: daysLate(due, today) > LATE_AFTER_DAYS,
            });
        }
    }
    rows.sort((a, b) => (a.dueISO < b.dueISO ? -1 : a.dueISO > b.dueISO ? 1 : 0));
    return rows;
}

/**
 * The same question for money going OUT — the insurance premiums and other
 * recurring bills the owner named.
 *
 * CONFIRMING ONE WRITES NOTHING TO THE LEDGER, and that is deliberate. The
 * subscription record IS the commitment; the app already counts it. A
 * confirmation that also created an expense row would double-count every
 * premium the moment somebody used this screen, which is precisely the
 * corruption the human-in-the-loop rule exists to prevent. What is recorded is
 * the answer to the question: this month's debit went through.
 */
export function pendingOutflows(appData, asOf, opts = {}) {
    const A = appData || {};
    const now = asOf instanceof Date ? asOf : new Date(asOf || 0);
    if (!isFinite(now.getTime())) return [];
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    /* `|| LOOKBACK_MONTHS` would eat a legitimate 0 — "just this month" — and
     * silently answer with six months instead. A number that was given is
     * honoured; only an absent or unusable one falls back. */
    const lb = Number(opts.lookbackMonths);
    const lookback = (Number.isFinite(lb) && lb >= 0) ? Math.floor(lb) : LOOKBACK_MONTHS;
    const paid = (A.billPaid && typeof A.billPaid === 'object') ? A.billPaid : {};
    const delayed = (A.billDelayed && typeof A.billDelayed === 'object') ? A.billDelayed : {};

    const rows = [];
    for (const sub of arr(A.subscriptions)) {
        if (!sub || !sub.id) continue;
        const day = Math.floor(num(sub.dueDay));
        if (!(day >= 1)) continue;
        const created = parseDay(sub.createdAt);

        for (let back = lookback; back >= 0; back -= 1) {
            const monthIdx = now.getUTCMonth() - back;
            const due = dueDateFor(day, now.getUTCFullYear(), monthIdx);
            if (due > today) continue;
            /* Never ask about a month before the bill was recorded. The record
             * is not evidence that the bill existed then. */
            if (created && due < created) continue;
            const mk = monthKeyOf(due);
            const key = billKey(sub.id, mk);
            if (paid[key]) continue;
            /* An amount recorded for that month IS the answer. The per-month
             * override editor already writes one, and asking again about a
             * month the owner has typed a figure into would be the app failing
             * to read its own records. */
            const over = sub.monthOverrides && sub.monthOverrides[mk];
            if (typeof over === 'number') continue;
            const amount = num(sub.amount);
            if (!(amount > 0)) continue;
            rows.push({
                key,
                kind: 'outflow',
                sourceId: sub.id,
                name: s(sub.name) || 'Bill',
                company: s(sub.category),
                amount,
                monthKey: mk,
                dueISO: due.toISOString().slice(0, 10),
                state: stateOf(delayed, key, due, today),
                daysLate: daysLate(due, today),
                late: daysLate(due, today) > LATE_AFTER_DAYS,
            });
        }
    }
    rows.sort((a, b) => (a.dueISO < b.dueISO ? -1 : a.dueISO > b.dueISO ? 1 : 0));
    return rows;
}

/**
 * What the card says above the rows.
 *
 * `expected` is NOT added to any balance anywhere — it is the size of the
 * question, and the card labels it as such. A total that reads like money you
 * have is the exact confusion this queue exists to prevent.
 */
export function queueTotals(rows) {
    const list = arr(rows);
    let inflow = 0;
    let outflow = 0;
    let delayed = 0;
    let late = 0;
    for (const r of list) {
        if (!r) continue;
        if (r.kind === 'outflow') outflow += num(r.amount);
        else inflow += num(r.amount);
        if (r.state === VERIFY.DELAYED) delayed += 1;
        else if (r.late) late += 1;
    }
    return { count: list.length, inflow, outflow, delayed, late };
}

const API = {
    VERIFY, LOOKBACK_MONTHS, LATE_AFTER_DAYS,
    monthKeyOf, parseDay, dueDateFor, periodMonths, paysInMonth,
    receivedKey, billKey, pendingInflows, pendingOutflows, queueTotals,
};

/* The page reaches this through window, the way every other wired module here
 * does; the ESM export is what the tests import. Both spellings, one object. */
if (typeof window !== 'undefined') window.WFVerify = API;

export default API;
