/* =============================================================================
 * wealthflow-sweep-ledger.js — what the sweeper proposed, what you actually
 * did, and whether its promise held
 * -----------------------------------------------------------------------------
 * wealthflow-wealth-sweeper.js PROPOSES: "LKR 1.03M of your balance is idle for
 * at least 180 days; a 6-month deposit would not touch your runway." That is a
 * claim about the future, and it is falsifiable. This module is what makes it
 * answerable afterwards.
 *
 * It holds three things:
 *
 *   1. A RECORD of money the user actually moved out of the current account —
 *      principal, destination, when it comes back.
 *   2. The MATURITY LEG, so the projection knows the money returns instead of
 *      treating it as gone forever.
 *   3. The AUDIT: the sweeper said the balance would not fall below `floor`;
 *      here is what the balance actually did.
 *
 * ── THE MISTAKE THIS FILE IS BUILT TO AVOID ─────────────────────────────────
 *
 * The intuitive integration is "subtract each recorded sweep from the balance".
 * It is wrong, and wrong in the direction that quietly understates how much
 * money someone has.
 *
 * When 1.03M actually moves from the current account into a fixed deposit, the
 * bank balance drops by 1.03M. The user's `balance.total` — typed in, or
 * imported from a statement — ALREADY reflects that. openingBalance() reads it.
 * Subtracting the sweep again bills them twice for one transfer.
 *
 * So a sweep that has already happened contributes exactly ONE thing to the
 * projection: the inflow when it matures. Nothing today. A sweep dated in the
 * FUTURE has not left the account yet, so that one contributes both legs.
 *
 * `legs()` is the whole of that rule, and it is the reason this module exists
 * as its own file rather than as three lines inside the engine.
 *
 * ── WHAT DOES *NOT* COME BACK ───────────────────────────────────────────────
 *
 * A sweep into withdrawable savings has lockDays 0 and no maturity date. The
 * money is still the user's and still reachable, but it does not return to the
 * current account on its own, so it produces NO inflow. Recording one therefore
 * makes the projected runway shorter, and that is the honest answer: the runway
 * is measured on the account the bills are paid from. `parked()` exists so the
 * UI can show the money is banked, not burned.
 *
 * ── SIMPLE INTEREST, SAID OUT LOUD ──────────────────────────────────────────
 *
 * If the bank quoted a maturity value, that value is used and the inflow is
 * `committed`. Otherwise a rate is turned into SIMPLE interest over the lock
 * period and the inflow is `expected`, because the number is ours and not the
 * bank's. Nothing here compounds silently: a compounding assumption applied to
 * someone else's deposit is an invented figure standing next to real ones.
 *
 * With neither a maturity value nor a rate, the principal returns and no gain
 * is claimed at all — `gain` is null, never 0, for the same reason
 * sweepPlan().projectedAnnualGain is.
 *
 * Pure: no DOM, no storage, no network, and no clock. `asOf` is always passed.
 * ===========================================================================*/

import { isoDay, parseDay, addDays } from './wealthflow-cashflow-engine.js';

const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
};
const arr = (v) => (Array.isArray(v) ? v : []);

/** Sweeps that are still live. Withdrawn and cancelled ones project nothing. */
export const ACTIVE = 'active';

const STATUSES = ['active', 'matured', 'withdrawn', 'cancelled'];

/* ── the record ───────────────────────────────────────────────────────────── */

/**
 * Put one stored sweep into canonical shape, or explain why it is unusable.
 *
 * Follows the engine's `ignored` convention rather than the app's usual
 * "coerce and carry on": a sweep with no amount or no date cannot be projected,
 * and guessing one would put an invented number into a money projection.
 *
 * @returns {{ok: true, sweep: object} | {ok: false, why: string}}
 */
export function normalise(raw) {
    if (!raw || typeof raw !== 'object') return { ok: false, why: 'not a record' };

    const amount = num(raw.amount);
    if (!(amount > 0)) return { ok: false, why: 'no amount' };

    const date = parseDay(raw.date);
    if (!date) return { ok: false, why: 'no date — cannot tell whether the money has left yet' };

    const status = STATUSES.indexOf(String(raw.status || ACTIVE)) === -1
        ? ACTIVE : String(raw.status || ACTIVE);

    const lockDays = Math.max(0, Math.round(num(raw.lockDays)));

    /* A maturity date may be stored explicitly (the bank's certificate says so)
     * or derived from the lock period. lockDays 0 means there is no maturity at
     * all — withdrawable savings sit there until they are moved by hand. */
    let maturesOn = parseDay(raw.maturesOn);
    if (!maturesOn && lockDays > 0) maturesOn = addDays(date, lockDays);

    /* What comes back, and how much of that is the bank's number vs ours. */
    let value = num(raw.maturityValue);
    let gain = null;
    let valueBasis = 'quoted';
    if (!(value > 0)) {
        const rate = num(raw.rateAnnual);
        if (rate > 0 && lockDays > 0) {
            // SIMPLE interest, deliberately. See the header.
            gain = amount * (rate / 100) * (lockDays / 365);
            value = amount + gain;
            valueBasis = 'simple-interest';
        } else {
            value = amount;
            gain = null;             // not 0 — no claim is being made
            valueBasis = 'principal-only';
        }
    } else {
        gain = value - amount;
    }

    /* Has this money already left the current account?
     *
     * Normally the date answers it: a sweep dated in the past is money that is
     * already gone, so `balance.total` already shows it missing. But somebody
     * recording today's transfer before updating their balance would be
     * modelled wrongly by the date alone, and the error is a silent one — the
     * projection would show money that is not there.
     *
     * So the flag wins when it is set, and the date decides only when it is
     * not. `undefined` means "no opinion", which is different from `false`. */
    const settled = typeof raw.settled === 'boolean' ? raw.settled : null;

    return {
        ok: true,
        sweep: {
            id: raw.id != null ? String(raw.id) : null,
            date: isoDay(date),
            settled,
            amount,
            destination: String(raw.destination || 'other'),
            label: String(raw.label || raw.destination || 'Sweep'),
            lockDays,
            maturesOn: maturesOn ? isoDay(maturesOn) : null,
            maturityValue: value,
            gain,
            valueBasis,
            status,
            claim: raw.claim && typeof raw.claim === 'object' ? { ...raw.claim } : null,
        },
    };
}

/** Every usable sweep, plus the ones that could not be read and why. */
export function read(appData) {
    const usable = [];
    const ignored = [];
    for (const raw of arr((appData || {}).sweeps)) {
        const r = normalise(raw);
        if (r.ok) usable.push(r.sweep);
        else ignored.push({ source: 'sweeps', id: raw && raw.id != null ? String(raw.id) : null, why: r.why });
    }
    return { sweeps: usable, ignored };
}

/* ── what a sweep contributes to the projection ───────────────────────────── */

/**
 * The cash-flow legs of one sweep, relative to `asOf`.
 *
 * THE RULE, which is the point of this module:
 *
 *   date <= asOf   the transfer already happened, so the current balance
 *                  already shows it. ONE leg: the maturity inflow.
 *   date >  asOf   the money is still in the account. TWO legs: the outflow
 *                  on the day it leaves, and the maturity inflow.
 *
 * A sweep that is not `active` projects nothing: withdrawn money has already
 * come back into the balance, and a cancelled one never left.
 *
 * @param {object} sweep  a record from normalise()
 * @param {Date}   asOf
 */
export function legs(sweep, asOf) {
    if (!sweep || sweep.status !== ACTIVE) return [];
    const on = parseDay(asOf);
    if (!on) throw new TypeError('legs(): asOf must be a date — this module never reads the clock');

    const out = [];
    const left = parseDay(sweep.date);
    // The flag is authoritative when the user set it; otherwise the date is.
    const gone = sweep.settled != null ? sweep.settled : left <= on;

    if (!gone) {
        // Still in the account. It is the user's own intention, not a bill that
        // has been issued, so it is `expected`.
        out.push({
            date: sweep.date,
            kind: 'out',
            amount: sweep.amount,
            label: sweep.label + ' — moving out',
            source: 'sweeps',
            certainty: 'expected',
            id: sweep.id,
        });
    }

    if (sweep.maturesOn) {
        out.push({
            date: sweep.maturesOn,
            kind: 'in',
            amount: sweep.maturityValue,
            label: sweep.label + ' — matures',
            source: 'sweeps',
            // The DATE is the bank's either way. The AMOUNT is only the bank's
            // when they quoted it; our own interest arithmetic is an estimate
            // and is labelled as one.
            certainty: sweep.valueBasis === 'simple-interest' ? 'expected' : 'committed',
            id: sweep.id,
        });
    }

    return out;
}

/** Every leg from every sweep, for the engine to fold into its commitments. */
export function allLegs(appData, asOf) {
    const { sweeps, ignored } = read(appData);
    const items = [];
    for (const s of sweeps) items.push(...legs(s, asOf));
    return { items, ignored };
}

/* ── money that is banked rather than spent ───────────────────────────────── */

/**
 * What is currently sitting outside the current account because of a sweep.
 *
 * The projection is deliberately blind to this — a fixed deposit cannot pay
 * next week's bills — so something has to say it out loud, or recording a sweep
 * looks like losing the money.
 */
export function parked(appData, asOf) {
    const on = parseDay(asOf);
    if (!on) throw new TypeError('parked(): asOf must be a date');
    const { sweeps } = read(appData);

    let total = 0;
    let returning = 0;      // will come back on its own
    let liquid = 0;         // reachable, but only by hand
    let pending = 0;        // decided, still sitting in the current account
    const byDestination = {};

    for (const s of sweeps) {
        if (s.status !== ACTIVE) continue;
        const gone = s.settled != null ? s.settled : parseDay(s.date) <= on;
        /* Recorded but not yet transferred. It is NOT parked — the money is
         * still in the account — but reporting it as nothing at all left the
         * card showing "0.00 parked" above a row for a seven-figure deposit.
         * It is its own state and gets its own number. */
        if (!gone) { pending += s.amount; continue; }
        if (s.maturesOn && parseDay(s.maturesOn) <= on) continue;  // already back
        total += s.amount;
        if (s.maturesOn) returning += s.amount; else liquid += s.amount;
        byDestination[s.destination] = (byDestination[s.destination] || 0) + s.amount;
    }

    return { total, returning, liquid, pending, byDestination, count: sweeps.length };
}

/**
 * Deposits coming back within `withinDays`.
 *
 * Money that matures next month is money that should not be swept away again
 * this month, and a maturity nobody notices is a deposit that silently rolls
 * over at whatever rate the bank feels like.
 */
export function maturing(appData, asOf, withinDays = 60) {
    const on = parseDay(asOf);
    if (!on) throw new TypeError('maturing(): asOf must be a date');
    const until = addDays(on, Math.max(0, num(withinDays)));
    const { sweeps } = read(appData);

    const out = [];
    for (const s of sweeps) {
        if (s.status !== ACTIVE) continue;
        /* No maturity date means the money does not come back on its own, so
         * there is nothing to place in the window.
         *
         * The window comparison below would drop it anyway — `null < aDate`
         * coerces to `0 < <epoch ms>` and is true — but that is an accident of
         * coercion, not an intention, and it is the kind of thing that holds
         * until someone makes parseDay return an Invalid Date instead of null
         * and a savings account with no maturity turns up in the list showing
         * NaN days. Stated once, here, on purpose. */
        const matures = s.maturesOn ? parseDay(s.maturesOn) : null;
        if (!matures) continue;
        if (matures < on || matures > until) continue;
        out.push({ ...s, daysAway: Math.round((matures - on) / 86400000) });
    }
    out.sort((a, b) => a.daysAway - b.daysAway);
    return out;
}

/* ── the audit ────────────────────────────────────────────────────────────── */

/**
 * Did the sweeper's promise hold?
 *
 * When a sweep is recorded, the plan that justified it is stored alongside:
 *
 *     claim: { floor, horizonDays, projectedMin, bindingDate }
 *
 * "Take this much out and, over the next `horizonDays`, your balance still
 * never goes below `floor` — the lowest it gets is `projectedMin`, on
 * `bindingDate`." `observations` is what the balance actually did:
 * `[{ day: 'YYYY-MM-DD', balance: n }, …]`.
 *
 * ── WHY THE COVERAGE NUMBER IS NOT DECORATION ───────────────────────────────
 *
 * Observations are recorded when the app is opened, so they are sparse and they
 * are per-device. A verdict of "held" drawn from three observations across a
 * 180-day window is not a verification, and reporting it as one would make this
 * audit exactly the kind of reassuring-but-empty feature the rest of this app
 * has been busy removing.
 *
 * So: no observations in the window is `unverified`, never `held`. The verdict
 * always travels with `checkedDays` and `windowDays`, and the UI shows both.
 * This audit can prove a breach outright; it can only ever offer evidence for
 * the absence of one.
 */
export function audit(appData, observations, asOf) {
    const on = parseDay(asOf);
    if (!on) throw new TypeError('audit(): asOf must be a date');

    const obs = arr(observations)
        .map((o) => ({ day: o && o.day ? isoDay(parseDay(o.day) || 0) : null, balance: num(o && o.balance) }))
        .filter((o) => o.day);

    const { sweeps, ignored } = read(appData);
    const results = [];

    for (const s of sweeps) {
        const from = parseDay(s.date);
        if (!s.claim) {
            /* SAME SHAPE AS EVERY OTHER RESULT.
             *
             * The first version of this branch returned a short object with no
             * `breaches`, so a caller looping over results and reading
             * `r.breaches.length` — which is the obvious way to render this —
             * threw on the one sweep that had nothing to say. A heterogeneous
             * results array makes the consumer responsible for remembering
             * which verdicts carry which fields, and it will forget. */
            results.push({
                id: s.id,
                label: s.label,
                amount: s.amount,
                verdict: 'no-claim',
                why: 'recorded without the projection that justified it, so there is nothing to check it against',
                floor: null,
                claimedMin: null,
                lowestObserved: null,
                optimisticBy: null,
                breaches: [],
                checkedDays: 0,
                windowDays: 0,
                coverage: 0,
                complete: false,
            });
            continue;
        }

        const floor = num(s.claim.floor);
        const horizonDays = Math.max(0, Math.round(num(s.claim.horizonDays)));
        const windowEnd = addDays(from, horizonDays);
        // Only the elapsed part of the window can be judged at all.
        const judgeUntil = on < windowEnd ? on : windowEnd;
        /* Day zero counts. `elapsed` is the number of day BOUNDARIES crossed,
         * so a sweep recorded today gives 0 and the card read "checked on 1 of
         * 0 days". The window covers today as well, so the honest denominator
         * is one more than the gap. */
        const elapsed = Math.max(0, Math.round((judgeUntil - from) / 86400000));
        const daysSoFar = elapsed + 1;

        const inWindow = obs.filter((o) => {
            const d = parseDay(o.day);
            return d >= from && d <= judgeUntil;
        });
        // One reading per day; a day observed twice is still one day of evidence.
        const byDay = new Map();
        for (const o of inWindow) {
            const prev = byDay.get(o.day);
            if (prev == null || o.balance < prev) byDay.set(o.day, o.balance);
        }

        const checkedDays = byDay.size;
        const balances = [...byDay.values()];
        const lowestObserved = balances.length ? Math.min(...balances) : null;
        const breaches = [...byDay.entries()]
            .filter(([, b]) => b < floor)
            .map(([day, balance]) => ({ day, balance, shortBy: floor - balance }))
            .sort((a, b) => (a.day < b.day ? -1 : 1));

        /* FOUR VERDICTS, NOT THREE.
         *
         * The first version had `held` the moment a single reading came in
         * above the floor — and because the UI records an observation as it
         * renders, that reading always exists. So every sweep read "held", in
         * green, from the second it was created. Technically defensible (a
         * reading was taken and it was fine) and exactly the flattery the
         * coverage number was added to prevent.
         *
         * `held` now means the window is OVER and nothing broke it. While it is
         * still running the honest word is `holding`: true so far, not finished.
         * A breach is conclusive whenever it happens, so it outranks both. */
        let verdict;
        if (breaches.length) verdict = 'breached';
        else if (!checkedDays) verdict = 'unverified';
        else if (on >= windowEnd) verdict = 'held';
        else verdict = 'holding';

        results.push({
            id: s.id,
            label: s.label,
            amount: s.amount,
            verdict,
            floor,
            claimedMin: s.claim.projectedMin != null ? num(s.claim.projectedMin) : null,
            lowestObserved,
            /* The forecast can be beaten and still have been optimistic: the
             * floor holding says the sweep was safe, this says whether the
             * number the user was shown was any good. Positive = reality came
             * in below the projection. */
            optimisticBy: (lowestObserved != null && s.claim.projectedMin != null)
                ? num(s.claim.projectedMin) - lowestObserved : null,
            breaches,
            why: verdict === 'unverified'
                ? 'no balance readings inside this sweep\u2019s window yet — this device has not seen one'
                : verdict === 'breached'
                    ? 'the balance was observed below the floor this sweep promised to hold'
                    : verdict === 'holding'
                        ? 'every reading so far is at or above the floor, and the window is still open'
                        : 'the window closed with every reading at or above the floor',
            checkedDays,
            windowDays: daysSoFar,
            coverage: checkedDays / daysSoFar,
            complete: on >= windowEnd,
        });
    }

    const breached = results.filter((r) => r.verdict === 'breached');
    const holding = results.filter((r) => r.verdict === 'holding');
    const held = results.filter((r) => r.verdict === 'held');
    return {
        results,
        ignored,
        breached: breached.length,
        held: held.length,
        holding: holding.length,
        unverified: results.filter((r) => r.verdict === 'unverified').length,
        /* A single sentence for the card, and it does not round a lack of
         * evidence up into a pass. */
        headline: breached.length
            ? breached.length + ' sweep' + (breached.length === 1 ? '' : 's')
                + ' left the balance under the floor it promised to hold'
            : held.length
                ? held.length + ' sweep' + (held.length === 1 ? '' : 's')
                    + ' ran their full window without breaking the floor'
                : holding.length
                    ? 'Nothing has broken a floor yet — ' + holding.length + ' sweep'
                        + (holding.length === 1 ? ' is' : 's are') + ' still inside its window'
                    : 'No sweep has enough balance history yet to check',
    };
}

/* ── observations ─────────────────────────────────────────────────────────── */

/** Cap on the stored balance history. Roughly a year of daily opens. */
export const MAX_OBSERVATIONS = 400;

/**
 * Fold today's balance into the observation log.
 *
 * One entry per day, keeping the LOWEST balance seen on that day — the audit
 * asks whether the floor was ever broken, and the lowest reading is the one
 * that can answer it. Taking the latest instead would let a dip at noon vanish
 * behind a payment at six.
 *
 * Returns a new array; the caller stores it. Pure, so it is testable and so the
 * storage decision stays at the edge.
 */
export function observe(observations, day, balance) {
    const d = parseDay(day);
    if (!d) return arr(observations).slice();
    const key = isoDay(d);
    const b = num(balance);

    const out = arr(observations)
        .map((o) => ({ day: o && o.day ? String(o.day) : null, balance: num(o && o.balance) }))
        .filter((o) => o.day && o.day !== key);
    const existing = arr(observations).filter((o) => o && String(o.day) === key).map((o) => num(o.balance));
    out.push({ day: key, balance: existing.length ? Math.min(b, ...existing) : b });

    out.sort((a, b2) => (a.day < b2.day ? -1 : a.day > b2.day ? 1 : 0));
    return out.length > MAX_OBSERVATIONS ? out.slice(out.length - MAX_OBSERVATIONS) : out;
}

/* ── the whole picture ────────────────────────────────────────────────────── */

export function summarise(appData, observations, asOf) {
    const p = parked(appData, asOf);
    const a = audit(appData, observations, asOf);
    const next = maturing(appData, asOf, 60);
    return {
        parked: p,
        audit: a,
        maturingSoon: next,
        nextMaturity: next.length ? next[0] : null,
    };
}

const API = {
    ACTIVE, MAX_OBSERVATIONS,
    normalise, read, legs, allLegs, parked, maturing, audit, observe, summarise,
};

if (typeof window !== 'undefined') window.WFSweepLedger = API;

export default API;
