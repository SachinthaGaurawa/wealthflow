// =============================================================================
// WealthFlow — Smart Wealth Sweeper
// -----------------------------------------------------------------------------
// WHAT THIS ANSWERS
//
//   "How much of the money sitting in my current account is genuinely idle —
//    not needed for anything I have already committed to — and for how long?"
//
// Idle cash in a current account earns nothing. Moving it is only safe if you
// know what is coming, and the app already does: every loan EMI, card
// instalment, subscription renewal and post-dated cheque is a dated obligation
// in the ledger. wealthflow-cashflow-engine.js walks them; this module asks the
// one further question — what can leave, and until when.
//
// -----------------------------------------------------------------------------
// THE PROPERTY THAT MAKES THIS EXACT RATHER THAN A SEARCH
//
// A lump sum removed TODAY shifts the projected balance down by exactly that
// constant on every subsequent day. Nothing about the timing of future
// commitments changes; the whole curve just drops. So the largest safe sweep is
// closed-form:
//
//     maxSweep(H) = min over days in [0..H] of balance(day) − floor
//
// No binary search, no iteration, no tolerance. Contrast sustainableMonthly()
// in the cash flow engine, which DOES need a search: a recurring payment lands
// on many days and does not shift the curve uniformly, so the constraint is not
// a simple minimum. Two similar-sounding questions, two different shapes, and
// using the search here would be slower and no more correct.
//
// -----------------------------------------------------------------------------
// THE LADDER FALLS OUT OF THE SAME FUNCTION
//
// maxSweep(H) is NON-INCREASING in H: a longer horizon can only add
// constraints, never remove them. So
//
//     maxSweep(365) ≤ maxSweep(180) ≤ maxSweep(90)
//
// and the nesting IS a maturity ladder. Money safe for a year can be locked for
// a year; money safe only for three months belongs somewhere it can come back
// from. Each tranche is the difference between two horizons, which is precisely
// "needed after H1 but not before H2".
//
// -----------------------------------------------------------------------------
// THREE HONESTIES BUILT IN, NOT BOLTED ON
//
// 1. CONFIDENCE DEGRADES WITH HORIZON, AND IT SAYS SO. At 90 days most of what
//    constrains a sweep is `committed` — real dated obligations. At 365 days
//    most of it is `expected` (a salary on a nominal pay day) or estimated
//    variable spend. Every tranche reports the committed share of the outflow
//    in its window, so a long tranche cannot present itself with the same
//    authority as a short one.
//
// 2. THE FLOOR IS DERIVED, NOT ZERO. A sweeper that empties you to the last
//    rupee is not a wealth tool. The default reserve is one month of committed
//    outflows — a number taken from the user's own ledger rather than a round
//    figure somebody liked.
//
// 3. IT PROPOSES. IT NEVER MOVES MONEY. There is no execution path, no broker,
//    no account integration, and deliberately no `apply()`. Rates for fixed
//    deposits are supplied by the caller — this module will not invent a market
//    rate and present it as fact.
//
// -----------------------------------------------------------------------------
// PURE BY CONSTRUCTION, like the engine it builds on: no DOM, no storage, no
// network, and no clock. `asOf` is required.
// =============================================================================

import { project, parseDay, isoDay, commitments, addDays } from './wealthflow-cashflow-engine.js';

const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return isFinite(n) ? n : 0;
};
const arr = (v) => (Array.isArray(v) ? v : []);

/** The horizons the ladder is built from, longest first. Days. */
export const HORIZONS = [365, 180, 90];

/* ── the reserve ──────────────────────────────────────────────────────────── */

/**
 * How much cash to keep back before anything is swept.
 *
 * One month of COMMITTED outflows, measured from the user's own ledger over the
 * next 90 days. Not a round number, not a percentage of income — the actual
 * amount of dated obligation this person carries in a typical month.
 *
 * Committed only, deliberately: padding the reserve with estimated discretionary
 * spending would make it drift with a noisy average, and the reserve exists to
 * cover the things that WILL arrive.
 */
export function reserveFloor(appData, opts = {}) {
    const asOf = parseDay(opts.asOf);
    if (!asOf) throw new TypeError('reserveFloor(): asOf must be a date');
    if (opts.floor != null) return { amount: num(opts.floor), basis: 'set by the caller' };

    const { items } = commitments(appData, asOf, addDays(asOf, 90));
    const out = items
        .filter((i) => i.kind === 'out' && i.certainty === 'committed')
        .reduce((t, i) => t + i.amount, 0);
    const perMonth = out / (90 / 30.44);
    return {
        amount: Math.round(perMonth),
        basis: 'one month of committed outflows, measured over the next 90 days',
    };
}

/* ── the closed form ──────────────────────────────────────────────────────── */

/**
 * The largest single amount that can leave the account TODAY without the
 * projection dropping below `floor` at any point in the next `horizon` days.
 *
 * Also names the day that binds it — the lowest point of the curve. A limit
 * without a reason is a number to be argued with; a limit with a date is a fact
 * to plan around.
 */
export function maxSweep(appData, opts = {}) {
    const floor = num(opts.floor);
    const p = project(appData, { ...opts, floor });
    let low = Infinity;
    let lowDay = null;
    for (const d of p.days) {
        if (d.balance < low) { low = d.balance; lowDay = d; }
    }
    if (low === Infinity) low = p.opening;

    const amount = Math.max(0, low - floor);
    // What kind of obligation is doing the constraining, over this window.
    let committedOut = 0;
    let otherOut = 0;
    for (const c of p.commitments) {
        if (c.kind !== 'out') continue;
        if (c.certainty === 'committed') committedOut += c.amount;
        else otherOut += c.amount;
    }
    const variableOut = p.days.reduce((t, d) => t + d.variable, 0);
    const totalOut = committedOut + otherOut + variableOut;

    return {
        amount,
        horizon: p.horizon,
        floor,
        // The day the curve bottoms out. Sweeping a rupee more breaks it here.
        bindingDate: lowDay ? lowDay.date : p.asOf,
        bindingBalance: low,
        // 1 = every constraining rupee is a dated obligation already in the
        // ledger. Lower means more of it is estimate.
        committedShare: totalOut > 0 ? committedOut / totalOut : 1,
        opening: p.opening,
    };
}

/* ── destinations ─────────────────────────────────────────────────────────────
 *
 * TWO DIFFERENT QUANTITIES, WHICH THE FIRST VERSION OF THIS FILE CONFLATED.
 *
 *   needHorizon  how long the money must be provably idle before this
 *                destination is justified at all.
 *   lockDays     how long the destination TIES IT UP once it is there.
 *
 * They are not the same and they do not even point the same way. Withdrawable
 * savings locks nothing (lockDays 0) yet still wants 90 days of provable idleness
 * before it is worth moving. A 12-month deposit needs a year of idleness AND
 * takes a year to come back.
 *
 * The first version used the horizon for both, so a savings goal due in 50 days
 * could be funded from no tranche at all — the shortest horizon was 90, and
 * `90 <= 50` is false. Every goal came back unfunded beside 1.28M of idle cash.
 * The rule that matters for a goal is whether the money can be BACK in time,
 * which is lockDays, not needHorizon.
 */
export const DESTINATIONS = [
    { key: 'fd-12m', label: '12-month fixed deposit', needHorizon: 365, lockDays: 365,
      why: 'not needed for at least a year on your current commitments' },
    { key: 'fd-6m',  label: '6-month fixed deposit',  needHorizon: 180, lockDays: 180,
      why: 'not needed for six months, but wanted before a year is out' },
    { key: 'liquid', label: 'High-yield savings (withdrawable)', needHorizon: 90, lockDays: 0,
      why: 'spare for three months, and reachable at any time' },
];

/* ── the ladder ───────────────────────────────────────────────────────────── */

/**
 * Build the whole proposal: reserve, goal funding, and the remainder laddered.
 *
 * ORDER MATTERS AND IT IS DELIBERATE.
 *
 * 1. Hold back the reserve.
 * 2. Fund the user's OWN goals first, soonest deadline first, each from the
 *    longest-locking destination that still returns the money in time. Goals are
 *    things this person has already decided they want; a generic yield ladder
 *    has no business outranking them.
 * 3. Ladder whatever is left, longest lock first, each destination capped by the
 *    amount provably idle over ITS horizon.
 *
 * CONFIDENCE BOUNDS THE LOCK. The projection at 365 days rests mostly on
 * estimates — a salary on a nominal pay day, discretionary spending averaged
 * from history — while at 90 days it is mostly dated obligation. Locking money
 * for a year on the strength of the weaker of those is exactly the
 * over-confidence the engine's `certainty` labels exist to prevent. So any
 * destination whose needHorizon has less than moderate confidence is excluded,
 * and the exclusion is reported rather than silently applied.
 */
export function ladder(appData, opts = {}) {
    const asOf = parseDay(opts.asOf);
    if (!asOf) throw new TypeError('ladder(): asOf must be a date');
    const reserve = reserveFloor(appData, opts);
    const floor = reserve.amount;

    const byHorizon = {};
    for (const h of HORIZONS) byHorizon[h] = maxSweep(appData, { ...opts, floor, horizon: h });

    const MIN_SHARE = 0.5;                    // below this, confidence is 'low'
    const excluded = [];
    const usable = DESTINATIONS.filter((d) => {
        const m = byHorizon[d.needHorizon];
        if (m.committedShare >= MIN_SHARE) return true;
        excluded.push({
            destination: d.key, label: d.label,
            reason: 'only ' + Math.round(m.committedShare * 100) + '% of what constrains the '
                + d.needHorizon + '-day projection is a dated obligation — too much of it is '
                + 'estimate to justify locking money away for ' + d.lockDays + ' days',
        });
        return false;
    });

    /* Nested capacity. Money safe for 365 days is also part of what is safe for
     * 180 and 90, so placing it consumes capacity at every shorter horizon too. */
    const remainingAt = {};
    for (const h of HORIZONS) remainingAt[h] = byHorizon[h].amount;
    const capacity = (needHorizon) => Math.max(0, Math.min(
        ...HORIZONS.filter((g) => g <= needHorizon).map((g) => remainingAt[g])));
    const place = (amount, needHorizon) => {
        for (const g of HORIZONS) if (g <= needHorizon) remainingAt[g] -= amount;
    };

    const allocations = {};
    for (const d of DESTINATIONS) allocations[d.key] = { amount: 0, forGoals: 0, spare: 0 };

    // ── 2. goals first ───────────────────────────────────────────────────────
    const goals = arr(appData && appData.targets)
        .filter((t) => t && num(t.amount) > 0)
        .map((t) => {
            const saved = arr(t.savings).reduce((s, x) => s + num(x && x.amount), 0);
            const end = parseDay(t.end);
            const daysAway = end ? Math.round((end - asOf) / 86400000) : Infinity;
            return { t, saved, shortfall: Math.max(0, num(t.amount) - saved), daysAway };
        })
        .filter((g) => g.shortfall > 0)
        .sort((a, b) => a.daysAway - b.daysAway);

    const goalPlan = [];
    for (const g of goals) {
        let funded = 0;
        const from = [];
        // Longest lock that still returns the money before the deadline earns the
        // most while still being there when it is wanted.
        for (const d of usable) {
            if (funded >= g.shortfall - 0.5) break;
            if (d.lockDays > g.daysAway) continue;
            const take = Math.min(capacity(d.needHorizon), g.shortfall - funded);
            if (take <= 0) continue;
            place(take, d.needHorizon);
            allocations[d.key].amount += take;
            allocations[d.key].forGoals += take;
            funded += take;
            from.push({ destination: d.key, label: d.label, amount: take });
        }
        goalPlan.push({
            id: g.t.id, name: g.t.name, target: num(g.t.amount), saved: g.saved,
            shortfall: g.shortfall,
            dueIn: g.daysAway === Infinity ? null : g.daysAway,
            funded, from,
            // Reported, never hidden: silence here would read as "covered".
            unfunded: Math.max(0, g.shortfall - funded),
        });
    }

    // ── 3. ladder the remainder, longest lock first ─────────────────────────
    for (const d of usable) {
        const take = capacity(d.needHorizon);
        if (take <= 0) continue;
        place(take, d.needHorizon);
        allocations[d.key].amount += take;
        allocations[d.key].spare += take;
    }

    const tranches = DESTINATIONS.map((d) => {
        const m = byHorizon[d.needHorizon];
        return {
            destination: d.key, label: d.label, why: d.why,
            horizon: d.needHorizon, lockDays: d.lockDays,
            amount: allocations[d.key].amount,
            forGoals: allocations[d.key].forGoals,
            spare: allocations[d.key].spare,
            bindingDate: m.bindingDate,
            committedShare: m.committedShare,
            confidence: m.committedShare >= 0.8 ? 'high'
                : m.committedShare >= MIN_SHARE ? 'moderate' : 'low',
            available: !!usable.find((u) => u.key === d.key),
        };
    });

    const shortest = HORIZONS[HORIZONS.length - 1];
    const sweepable = byHorizon[shortest].amount;
    const opening = byHorizon[HORIZONS[0]].opening;
    const placed = tranches.reduce((t, x) => t + x.amount, 0);

    return {
        asOf: isoDay(asOf),
        opening,
        reserve,
        sweepable,
        placed,
        // Everything not placed stays put — named so the numbers on screen add
        // up to the balance visibly rather than leaving a gap to wonder about.
        keep: Math.max(0, opening - placed),
        tranches,
        excluded,
        goals: goalPlan,
        byHorizon,
    };
}

/* ── the whole proposal ───────────────────────────────────────────────────── */

/**
 * One object an interface can render. The judgement lives here so every surface
 * showing these numbers shows the same ones.
 *
 * `annualYield` maps destination key -> annual rate percent and is supplied by
 * the CALLER. This module does not know what any bank is paying today and will
 * not pretend to: a fabricated rate sitting beside real ledger figures would
 * borrow their credibility.
 */
export function sweepPlan(appData, opts = {}) {
    const plan = ladder(appData, opts);
    const rates = (opts.annualYield && typeof opts.annualYield === 'object') ? opts.annualYield : null;

    let projectedAnnualGain = null;
    if (rates) {
        projectedAnnualGain = 0;
        for (const t of plan.tranches) {
            const r = num(rates[t.destination]);
            if (r > 0 && t.amount > 0) projectedAnnualGain += t.amount * (r / 100);
        }
    }

    const anything = plan.placed > 0;
    return {
        ...plan,
        // null, not 0, when no rates were given. Zero is a claim that this earns
        // nothing; null is the absence of a claim.
        projectedAnnualGain,
        status: !anything ? 'nothing-idle'
            : plan.placed < plan.reserve.amount * 0.25 ? 'thin' : 'ready',
        headline: anything
            ? 'LKR ' + Math.round(plan.placed).toLocaleString() + ' is idle and can be put to work'
            : 'Nothing is idle right now — everything on hand is committed or reserved',
    };
}

const API = {
    HORIZONS, DESTINATIONS, reserveFloor, maxSweep, ladder, sweepPlan,
};

if (typeof window !== 'undefined') window.WFSweeper = API;

export default API;
