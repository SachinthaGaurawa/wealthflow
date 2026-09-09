/* =============================================================================
 * wealthflow-liquidity.js — pawned collateral, and money lent to people
 * -----------------------------------------------------------------------------
 * Two ledgers the app had nowhere to put, and both are the same shape of
 * problem: an amount that changes with TIME or with EVENTS, where getting the
 * arithmetic silently wrong costs real money.
 *
 *   PAWNED ASSETS. Gold at a pawn broker. THE ARITHMETIC FOR THIS MOVED OUT to
 *   wealthflow-pawn.js and this file re-exports it, because a pawn ticket
 *   turned out to be far more than a principal and a rate: part payments that
 *   change what later months accrue on, renewals that change the rate and the
 *   term, and interest that is sometimes paid at the counter and sometimes
 *   rolled into the advance. That is a ledger of its own. Everything here that
 *   named a pawn function still works and means the same thing — one
 *   implementation, one home, no second copy to drift.
 *
 *   MONEY LENT TO PEOPLE. Not a bank loan with a schedule — a debtor who repays
 *   what they can when they can, and who sometimes borrows more. The ledger has
 *   to survive partial repayments, a lump-sum settlement, and a top-up that
 *   raises the principal without erasing the history of what came before.
 *
 *   AND IT HAS TO SURVIVE BEING WRONG. The owner reported this and they were
 *   right: there was no way to edit a debtor and no way to undo anything. A
 *   name typed wrong, a repayment logged twice, a confirmation pressed by
 *   accident — the only recovery was deleting the person and their whole
 *   history. Every write below now has an edit and a reverse, because a ledger
 *   people are afraid to touch is a ledger that stops being true.
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

import PAWN, {
    PAWN_STATE, MATURITY_WARN_DAYS, parseDay, daysBetween, addMonths, isoOf,
    monthsElapsed, pawnStatus, pawnTotals, clearFirst, pendingPawn,
} from './wealthflow-pawn.js';

const DAY_MS = 86400000;
/* The average calendar month. Used only where a fraction of a month is being
 * measured; whole-month counting below is done on the calendar, not on this. */
const DAYS_PER_MONTH = 30.4375;

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const s = (v) => String(v == null ? '' : v).trim();

export const DEBT_STATE = { OPEN: 'OPEN', CLOSED: 'CLOSED' };
export const EVENT = { LENT: 'lent', REPAYMENT: 'repayment', TOPUP: 'topup' };

/* How late a repayment has to be before the queue says so. Money lent to a
 * person has no contractual due date unless the owner recorded one — so this
 * counts from the date THEY expected it, and stays silent when they did not
 * give one rather than inventing a deadline. */
export const LATE_AFTER_DAYS = 3;

/* ── pawned assets: re-exported, not re-implemented ───────────────────────
 *
 * Named here so every existing caller, test and screen keeps working, while
 * exactly one file decides what a pawn ticket costs. A second implementation
 * of "how many months has this run" is the defect this repository keeps
 * producing; there is not going to be one. */
export {
    PAWN_STATE, MATURITY_WARN_DAYS, parseDay, daysBetween, monthsElapsed,
    pawnStatus, pawnTotals, clearFirst,
};
/** Kept because callers import it from here; the rule lives in the pawn engine. */
export function interestOn(principal, ratePctPerMonth, months, mode = 'simple') {
    const p = num(principal);
    const r = num(ratePctPerMonth) / 100;
    const m = num(months);
    if (!(p > 0) || !(r > 0) || !(m > 0)) return 0;
    if (s(mode).toLowerCase() === 'compound') return p * (Math.pow(1 + r, m) - 1);
    return p * r * m;
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
        /* ── AND THE REPAYMENT THAT WAS PROMISED AND HAS NOT COME ──────────
         *
         * This queue used to hold only events somebody had already logged, so
         * a debtor who said "next Friday" and then went quiet produced NOTHING
         * on any screen — the one case where a person actually needs reminding
         * is the one case with no row in it. A debtor with an expected-by date
         * that has passed and money still outstanding is now a row of its own.
         *
         * It is NOT a payment: confirming it would invent a repayment nobody
         * received. It is a prompt to go and ask, and the button on it says
         * so. Silent when no date was given, because a deadline the owner
         * never set is not one they can be late on. */
        const dueISO = s(d.dueISO);
        if (dueISO && su.outstanding > 0 && su.state === DEBT_STATE.OPEN) {
            const due = parseDay(dueISO);
            const today = asOf instanceof Date ? parseDay(asOf.toISOString()) : parseDay(asOf);
            const late = (due && today) ? daysBetween(due, today) : 0;
            if (due && today && today >= due) {
                rows.push({
                    key: `debtor-due:${d.id}`,
                    kind: 'inflow',
                    source: 'debtor-due',
                    sourceId: d.id,
                    eventId: '',
                    name: s(d.name) || 'Debtor',
                    company: 'Repayment expected',
                    amount: su.outstanding,
                    monthKey: dueISO.slice(0, 7),
                    dueISO,
                    state: late > LATE_AFTER_DAYS ? 'DELAYED' : 'PENDING',
                    daysLate: late,
                    late: late > LATE_AFTER_DAYS,
                });
            }
        }
    }
    /* The pawn ledger's unconfirmed payments belong in the same queue: money
     * handed over at a counter and not yet verified is the same kind of claim
     * as a repayment logged for a debtor. One card, both ledgers. */
    for (const row of pendingPawn(arr(A.pawns), asOf)) rows.push(row);
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

/* ── the edits and the undos, which did not exist ─────────────────────────
 *
 * Reported directly by the owner: "Debtors feature එකේ undo නෑ. Edit නෑ."
 * They were right, and it was not a small gap. A name typed wrong, a repayment
 * entered twice, a confirmation pressed on the wrong row — the only recovery
 * was deleting the person and losing every event they ever had.
 *
 * All of these are pure and return a NEW record, like every other write here,
 * so the caller stores and a test can drive them without a browser. */

/** Fields on the person, not on the money. Anything absent is left alone. */
export function updateDebtor(debtor, fields = {}) {
    const d = debtor || {};
    const next = { ...d };
    if (fields.name !== undefined) next.name = s(fields.name).slice(0, 120);
    if (fields.note !== undefined) next.note = s(fields.note).slice(0, 200);
    if (fields.phone !== undefined) next.phone = s(fields.phone).slice(0, 40);
    /* When they said they would pay. Optional, and the queue stays silent
     * without it rather than inventing a deadline. */
    if (fields.dueISO !== undefined) next.dueISO = s(fields.dueISO).slice(0, 10);
    if (!s(next.name)) return { ok: false, reason: 'no-name', debtor: d };
    return { ok: true, debtor: next };
}

/** Change one event: a wrong amount, a wrong date, a wrong kind, a note. */
export function updateEvent(debtor, eventId, fields = {}) {
    const d = debtor || {};
    const id = s(eventId);
    let hit = false;
    const events = arr(d.events).map((e) => {
        if (!e || s(e.id) !== id) return e;
        const next = { ...e };
        if (fields.amount !== undefined) {
            const amt = num(fields.amount);
            /* A zero-amount event is not an edit, it is a deletion wearing a
             * disguise — and it would sit in the ledger looking like a real
             * row. Refuse it and let removeEvent do the deleting. */
            if (!(amt > 0)) return e;
            next.amount = amt;
        }
        if (fields.date !== undefined) next.date = s(fields.date);
        if (fields.note !== undefined) next.note = s(fields.note).slice(0, 200);
        if (fields.kind !== undefined) {
            const k = s(fields.kind).toLowerCase();
            if ([EVENT.LENT, EVENT.REPAYMENT, EVENT.TOPUP].includes(k)) next.kind = k;
        }
        hit = true;
        return next;
    });
    return { ok: hit, debtor: hit ? { ...d, events } : d };
}

/** Take one event off the ledger. The undo for logging something by mistake. */
export function removeEvent(debtor, eventId) {
    const d = debtor || {};
    const id = s(eventId);
    const events = arr(d.events).filter((e) => e && s(e.id) !== id);
    const hit = events.length !== arr(d.events).length;
    if (!hit) return { ok: false, reason: 'no-such-event', debtor: d };
    const next = { ...d, events };
    /* Removing the final payment re-opens a debtor that settling had closed.
     * Leaving them CLOSED with a balance again is a lie the screen would keep
     * telling until somebody noticed the number. */
    const su = debtorSummary(next, null);
    if (su.outstanding > 0 && next.closedAt) delete next.closedAt;
    if (su.outstanding > 0 && s(next.state).toUpperCase() === DEBT_STATE.CLOSED) next.state = DEBT_STATE.OPEN;
    return { ok: true, debtor: next };
}

/** Undo a confirmation. Pressing confirm on the wrong row was permanent. */
export function unconfirmEvent(debtor, eventId) {
    const d = debtor || {};
    const id = s(eventId);
    let hit = false;
    const events = arr(d.events).map((e) => {
        if (!e || s(e.id) !== id) return e;
        hit = true;
        const next = { ...e, confirmed: false };
        delete next.confirmedAt;
        return next;
    });
    if (!hit) return { ok: false, reason: 'no-such-event', debtor: d };
    const next = { ...d, events };
    /* Un-confirming the settling payment re-opens them, for the same reason. */
    if (debtorSummary(next, null).outstanding > 0) {
        if (next.closedAt) delete next.closedAt;
        if (s(next.state).toUpperCase() === DEBT_STATE.CLOSED) next.state = DEBT_STATE.OPEN;
    }
    return { ok: true, debtor: next };
}

/** Undo a settlement without touching the history that led to it. */
export function reopenDebtor(debtor) {
    const d = debtor || {};
    if (!d.closedAt && s(d.state).toUpperCase() !== DEBT_STATE.CLOSED) {
        return { ok: false, reason: 'already-open', debtor: d };
    }
    const next = { ...d, state: DEBT_STATE.OPEN };
    delete next.closedAt;
    return { ok: true, debtor: next };
}

const API = {
    PAWN_STATE, DEBT_STATE, EVENT, MATURITY_WARN_DAYS, LATE_AFTER_DAYS,
    parseDay, daysBetween, monthsElapsed, interestOn,
    pawnStatus, pawnTotals, clearFirst,
    debtorSummary, debtorTotals, pendingLiquidity,
    addEvent, confirmEvent, settleInFull,
    updateDebtor, updateEvent, removeEvent, unconfirmEvent, reopenDebtor,
    /* The pawn engine, reachable from the one global the page already has. */
    pawn: PAWN,
};

if (typeof window !== 'undefined') window.WFLiquidity = API;

export default API;
