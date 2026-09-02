/* =============================================================================
 * wealthflow-liquidity.js — pawned collateral, and money lent to people
 * -----------------------------------------------------------------------------
 * Two ledgers the app had nowhere to put, and both are the same shape of
 * problem: an amount that changes with TIME or with EVENTS, where getting the
 * arithmetic silently wrong costs real money.
 *
 *   PAWNED ASSETS. Gold at a pawn broker: a principal advanced, a monthly
 *   interest rate, and a maturity date after which the item can be sold. What
 *   matters is what it costs to redeem TODAY, and how long is left.
 *
 *   MONEY LENT TO PEOPLE. Not a bank loan with a schedule — a debtor who repays
 *   what they can when they can, and who sometimes borrows more. The ledger has
 *   to survive partial repayments, a lump-sum settlement, and a top-up that
 *   raises the principal without erasing the history of what came before.
 *
 * ── THE RULE THAT SHAPES BOTH ───────────────────────────────────────────────
 *
 * The owner's constraint applies here exactly as it does to income: no balance
 * moves without a person confirming it. So every event carries `confirmed`, and
 * an unconfirmed one is visible, counted separately, and moves nothing. What is
 * OUTSTANDING is computed from confirmed events only; what it WOULD be is
 * computed too, so the screen can show the difference rather than hiding it.
 *
 * ── PURE BY CONSTRUCTION ────────────────────────────────────────────────────
 *
 * No DOM, no storage, no network, and no `new Date()` without an argument.
 * `asOf` is always passed in.
 * ===========================================================================*/

const DAY_MS = 86400000;
/* The average calendar month. Used only where a fraction of a month is being
 * measured; whole-month counting below is done on the calendar, not on this. */
const DAYS_PER_MONTH = 30.4375;

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const s = (v) => String(v == null ? '' : v).trim();

export const PAWN_STATE = { ACTIVE: 'ACTIVE', REDEEMED: 'REDEEMED', OVERDUE: 'OVERDUE' };
export const DEBT_STATE = { OPEN: 'OPEN', CLOSED: 'CLOSED' };
export const EVENT = { LENT: 'lent', REPAYMENT: 'repayment', TOPUP: 'topup' };

/* How close to maturity is close enough to warn. A pawn broker can sell the
 * item after maturity, so this is the one date in the app where being late has
 * a consequence that cannot be undone by paying afterwards. */
export const MATURITY_WARN_DAYS = 14;

/** Parse 'YYYY-MM-DD' or an ISO timestamp to a UTC day. Null if unusable. */
export function parseDay(v) {
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const d = new Date(v);
    return isFinite(d.getTime())
        ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
        : null;
}

/** Whole days between two days, never negative. */
export function daysBetween(from, to) {
    if (!from || !to) return 0;
    return Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));
}

/**
 * How many months of interest a pawn has run.
 *
 * `roundUp` is the DEFAULT and it is not a rounding preference — it is how a
 * pawn broker bills. A ticket eight days into its second month is charged for
 * two months, and a calculator that reported 1.26 would tell the owner they owe
 * less than the counter will ask for. The exact-fraction mode exists for
 * anything that genuinely accrues daily.
 */
export function monthsElapsed(fromISO, asOf, { roundUp = true } = {}) {
    const from = parseDay(fromISO);
    const to = asOf instanceof Date ? parseDay(asOf.toISOString()) : parseDay(asOf);
    if (!from || !to) return 0;
    const days = daysBetween(from, to);
    if (days <= 0) return roundUp ? 0 : 0;
    const exact = days / DAYS_PER_MONTH;
    return roundUp ? Math.ceil(exact) : exact;
}

/**
 * Interest on a principal at a rate PER MONTH.
 *
 * Both modes are offered because both are used: most Sri Lankan pawn brokers
 * charge simple monthly interest, some compound it monthly, and the difference
 * over a year on a large ticket is not small. The record says which; nothing
 * here guesses.
 */
export function interestOn(principal, ratePctPerMonth, months, mode = 'simple') {
    const p = num(principal);
    const r = num(ratePctPerMonth) / 100;
    const m = num(months);
    if (!(p > 0) || !(r > 0) || !(m > 0)) return 0;
    if (s(mode).toLowerCase() === 'compound') return p * (Math.pow(1 + r, m) - 1);
    return p * r * m;
}

/**
 * Everything the screen says about one pawned item.
 *
 * A redeemed ticket is finished: no further interest accrues and no warning is
 * raised, whatever the maturity date says. Reporting a redeemed item as overdue
 * is how a ledger loses the owner's trust in one glance.
 */
export function pawnStatus(pawn, asOf) {
    const p = pawn || {};
    const today = asOf instanceof Date ? parseDay(asOf.toISOString()) : parseDay(asOf);
    const principal = num(p.principal);
    const redeemed = !!p.redeemedAt || s(p.state).toUpperCase() === PAWN_STATE.REDEEMED;
    const maturity = parseDay(p.maturity);
    const until = redeemed ? (parseDay(p.redeemedAt) || today) : today;

    const months = monthsElapsed(p.pawnDate, until, { roundUp: p.accrual !== 'daily' });
    const interest = interestOn(principal, p.rate, months, p.interestMode);
    const daysToMaturity = (maturity && today) ? Math.round((maturity.getTime() - today.getTime()) / DAY_MS) : null;

    let state = PAWN_STATE.ACTIVE;
    if (redeemed) state = PAWN_STATE.REDEEMED;
    else if (daysToMaturity !== null && daysToMaturity < 0) state = PAWN_STATE.OVERDUE;

    return {
        state,
        months,
        principal,
        interest,
        payable: principal + interest,
        daysToMaturity,
        /* Warned about only while something can still be done about it. */
        warn: state === PAWN_STATE.ACTIVE && daysToMaturity !== null && daysToMaturity <= MATURITY_WARN_DAYS,
    };
}

/** Totals across a set of pawned items, for the header of the ledger. */
export function pawnTotals(pawns, asOf) {
    let principal = 0;
    let interest = 0;
    let active = 0;
    let overdue = 0;
    let warn = 0;
    for (const p of arr(pawns)) {
        const st = pawnStatus(p, asOf);
        if (st.state === PAWN_STATE.REDEEMED) continue;
        principal += st.principal;
        interest += st.interest;
        active += 1;
        if (st.state === PAWN_STATE.OVERDUE) overdue += 1;
        if (st.warn) warn += 1;
    }
    return { principal, interest, payable: principal + interest, active, overdue, warn };
}

/* ── money lent to people ─────────────────────────────────────────────────── */

/** One event on a debtor's ledger, normalised. Unknown kinds are dropped. */
function normEvent(e) {
    if (!e || !e.id) return null;
    const kind = s(e.kind).toLowerCase();
    if (![EVENT.LENT, EVENT.REPAYMENT, EVENT.TOPUP].includes(kind)) return null;
    const amount = num(e.amount);
    if (!(amount > 0)) return null;
    return {
        id: s(e.id),
        kind,
        amount,
        date: s(e.date) || '',
        note: s(e.note).slice(0, 200),
        /* ABSENT MEANS CONFIRMED, and that is deliberate. Every event written
         * before this field existed describes something that already happened;
         * treating a missing flag as "unconfirmed" would put a person's whole
         * lending history into a confirmation queue on upgrade. */
        confirmed: e.confirmed !== false,
    };
}

/**
 * What a debtor owes, and how they got there.
 *
 * OUTSTANDING IS COMPUTED FROM CONFIRMED EVENTS ONLY. `outstandingIfConfirmed`
 * is the same sum including what is still waiting, so the screen can show the
 * difference rather than either hiding a logged repayment or acting on one
 * nobody has verified.
 */
export function debtorSummary(debtor, asOf) {
    const d = debtor || {};
    const events = arr(d.events).map(normEvent).filter(Boolean)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1)));

    let lent = 0;
    let repaid = 0;
    let pendingLent = 0;
    let pendingRepaid = 0;
    for (const e of events) {
        const out = (e.kind === EVENT.LENT || e.kind === EVENT.TOPUP);
        if (e.confirmed) { if (out) lent += e.amount; else repaid += e.amount; }
        else if (out) pendingLent += e.amount;
        else pendingRepaid += e.amount;
    }

    const outstanding = Math.max(0, lent - repaid);
    const outstandingIfConfirmed = Math.max(0, (lent + pendingLent) - (repaid + pendingRepaid));
    const closed = !!d.closedAt || s(d.state).toUpperCase() === DEBT_STATE.CLOSED;

    return {
        events,
        lent,
        repaid,
        outstanding,
        pending: events.filter((e) => !e.confirmed).length,
        pendingLent,
        pendingRepaid,
        outstandingIfConfirmed,
        /* Settled is a fact about the arithmetic OR a decision the owner
         * recorded. Both close it; neither invents the other. */
        state: (closed || (events.length && outstanding <= 0)) ? DEBT_STATE.CLOSED : DEBT_STATE.OPEN,
        lastEvent: events.length ? events[events.length - 1] : null,
    };
}

/** Totals across every debtor, for the header of the directory. */
export function debtorTotals(debtors, asOf) {
    let outstanding = 0;
    let lent = 0;
    let repaid = 0;
    let open = 0;
    let pending = 0;
    for (const d of arr(debtors)) {
        const su = debtorSummary(d, asOf);
        lent += su.lent;
        repaid += su.repaid;
        pending += su.pending;
        if (su.state === DEBT_STATE.OPEN) { open += 1; outstanding += su.outstanding; }
    }
    return { outstanding, lent, repaid, open, pending };
}

/**
 * The events waiting for someone to say they really happened.
 *
 * The same shape the income queue produces, so one card on the dashboard can
 * show all of it: a repayment logged but not seen in the bank is exactly the
 * same kind of claim as a salary that was due yesterday.
 */
export function pendingLiquidity(appData, asOf) {
    const A = appData || {};
    const rows = [];
    for (const d of arr(A.debtors)) {
        if (!d || !d.id) continue;
        const su = debtorSummary(d, asOf);
        for (const e of su.events) {
            if (e.confirmed) continue;
            const isIn = e.kind === EVENT.REPAYMENT;
            rows.push({
                key: `debtor:${d.id}:${e.id}`,
                kind: isIn ? 'inflow' : 'outflow',
                source: 'debtor',
                sourceId: d.id,
                eventId: e.id,
                name: s(d.name) || 'Debtor',
                company: isIn ? 'Repayment' : (e.kind === EVENT.TOPUP ? 'Further capital' : 'Money lent'),
                amount: e.amount,
                monthKey: s(e.date).slice(0, 7),
                dueISO: s(e.date),
                state: 'PENDING',
                daysLate: 0,
                late: false,
            });
        }
    }
    rows.sort((a, b) => (a.dueISO < b.dueISO ? -1 : a.dueISO > b.dueISO ? 1 : 0));
    return rows;
}

/* ── the writes, as pure transformations ──────────────────────────────────── */

/**
 * Add an event to a debtor and hand back a NEW record.
 *
 * Pure on purpose: the caller does the storing, and a test can drive every
 * shape of repayment without a browser. `id` and `now` are injected for the
 * same reason.
 */
export function addEvent(debtor, { kind, amount, date, note = '', id, now = 0, confirmed = false } = {}) {
    const d = debtor || {};
    const k = s(kind).toLowerCase();
    if (![EVENT.LENT, EVENT.REPAYMENT, EVENT.TOPUP].includes(k)) {
        return { ok: false, reason: 'unknown-kind', debtor: d };
    }
    const amt = num(amount);
    if (!(amt > 0)) return { ok: false, reason: 'no-amount', debtor: d };
    if (!s(id)) return { ok: false, reason: 'no-id', debtor: d };

    const ev = { id: s(id), kind: k, amount: amt, date: s(date), note: s(note).slice(0, 200), confirmed: !!confirmed, at: num(now) };
    const next = { ...d, events: [...arr(d.events), ev] };
    /* A new event on a settled debtor re-opens them. Borrowing again after
     * paying off is the ordinary case here, and leaving the record CLOSED
     * would hide the new balance completely. */
    if (next.closedAt) delete next.closedAt;
    if (s(next.state).toUpperCase() === DEBT_STATE.CLOSED) next.state = DEBT_STATE.OPEN;
    return { ok: true, debtor: next, event: ev };
}

/** Mark one event confirmed. Returns a new record; unknown ids change nothing. */
export function confirmEvent(debtor, eventId, { now = 0 } = {}) {
    const d = debtor || {};
    const id = s(eventId);
    let hit = false;
    const events = arr(d.events).map((e) => {
        if (!e || s(e.id) !== id) return e;
        hit = true;
        return { ...e, confirmed: true, confirmedAt: num(now) };
    });
    return { ok: hit, debtor: hit ? { ...d, events } : d };
}

/**
 * Settle the whole outstanding balance in one action.
 *
 * It writes a repayment for exactly what is owed rather than setting a flag,
 * because the timeline is the record: a debtor who is closed with no final
 * payment in their history is a debtor whose ledger does not add up.
 */
export function settleInFull(debtor, { date, id, now = 0, confirmed = false } = {}) {
    const su = debtorSummary(debtor, parseDay(date) || new Date(num(now)));
    if (!(su.outstanding > 0)) return { ok: false, reason: 'nothing-outstanding', debtor: debtor || {} };
    const r = addEvent(debtor, {
        kind: EVENT.REPAYMENT, amount: su.outstanding, date, note: 'Settled in full', id, now, confirmed,
    });
    if (!r.ok) return r;
    return { ok: true, debtor: { ...r.debtor, ...(confirmed ? { closedAt: num(now) } : {}) }, event: r.event };
}

const API = {
    PAWN_STATE, DEBT_STATE, EVENT, MATURITY_WARN_DAYS,
    parseDay, daysBetween, monthsElapsed, interestOn,
    pawnStatus, pawnTotals,
    debtorSummary, debtorTotals, pendingLiquidity,
    addEvent, confirmEvent, settleInFull,
};

if (typeof window !== 'undefined') window.WFLiquidity = API;

export default API;
