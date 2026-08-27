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

/* ── whether to raise it unprompted ───────────────────────────────────────────
 *
 * Everything above answers "what should move". This answers a different and
 * narrower question: should the app INTERRUPT someone to say so.
 *
 * WHY THIS IS NOT THE SAME QUESTION
 *
 * The sweeper has been complete and correct for several releases and has still
 * never moved a rupee, because the only way to see a plan is to open the panel
 * and look. Idle cash is precisely the thing nobody remembers to go and check —
 * it makes no noise, nothing is overdue, and the cost of ignoring it is a number
 * that never appears. A plan that has to be sought out is not automation.
 *
 * THE RISK RUNS THE OTHER WAY TOO, AND IT IS THE BIGGER ONE
 *
 * Idle cash PERSISTS. It is idle today, idle tomorrow, and idle next week, so
 * the naive rule — "tell them whenever there is something to sweep" — fires
 * every single day forever. The predictable result is that notifications get
 * switched off, and the loan and income reminders, which are time-critical and
 * cannot be recovered once missed, go off with them. A nudge that costs the
 * owner their payment reminders is a net loss no matter how good the advice is.
 *
 * So the rules below are mostly rules about staying quiet, and the thresholds
 * are chosen to make silence the default:
 *
 *   - Materiality is measured against the owner's OWN reserve, never a fixed
 *     number of rupees. Half a month of committed outflows sitting idle is worth
 *     a sentence; a fixed 100,000 would be trivial to one person and most of the
 *     year's savings to another.
 *   - A fortnight of cooldown, which is roughly twice a month — the rhythm money
 *     actually arrives on — rather than a daily reading of the same fact.
 *   - The cooldown is overridden only by genuinely NEW information: half again
 *     as much idle cash as last time, which is what a salary landing looks like.
 *     Even then a hard three-day floor applies, because the projection moves on
 *     its own and a jumpy curve must not be able to produce a daily alert.
 *   - Silence for a week after any sweep. Someone who has just acted does not
 *     need to be told again; they need to be left alone.
 *
 * NO CONFIDENCE RULE HERE, DELIBERATELY
 *
 * It would be the obvious fifth rule and it would be a duplicate: ladder() has
 * already dropped every destination below moderate confidence before allocating,
 * so `placed > 0` cannot be reached on a projection that is mostly estimate.
 * Restating it here would be a second copy of a threshold — the exact shape of
 * defect this repository has been bitten by more than once. It is written down
 * instead, so the absence reads as a decision rather than an oversight.
 *
 * WHAT THIS RETURNS, AND WHAT IT REFUSES TO
 *
 * Facts and a verdict. No message, no currency rendering, no action ids. The
 * surface that shows this renders the figures with the app's own formatter, the
 * same way every other number on screen is rendered.
 *
 * And nothing here is an instruction to record anything. A swept rupee moves at
 * a BANK, by a person; the app can only ever be told about it afterwards. That
 * is why this returns a verdict to show a proposal and never an amount to write
 * — a lock-screen button that booked a transfer nobody made would be the same
 * defect wealthflow-confirm.js exists to remove, rebuilt somewhere new.
 */

export const NUDGE = {
    READY: 'ready',
    NOTHING_IDLE: 'nothing-idle',
    NO_BASELINE: 'no-baseline',
    NOT_MATERIAL: 'not-material',
    RECENT_SWEEP: 'recent-sweep',
    COOLING_DOWN: 'cooling-down',
    TOO_SOON: 'too-soon',
    NO_DATE: 'no-date',
};

/** Every threshold in one object, so a surface can show them and a test can read them. */
export const NUDGE_RULES = {
    // Idle cash worth at least half a month of committed outflows.
    MIN_RESERVE_MULTIPLE: 0.5,
    // Roughly twice a month, matching the rhythm money arrives on.
    COOLDOWN_DAYS: 14,
    // The floor that survives the growth override, so a moving projection
    // cannot produce a daily alert.
    MIN_GAP_DAYS: 3,
    // Half again as much idle cash as last time is new information.
    GROWTH_MULTIPLE: 1.5,
    // Someone who just swept has acted. Leave them alone.
    RECENT_SWEEP_DAYS: 7,
};

const DAY = 86400000;

/** Whole days from `a` to `b`. Both are UTC midnights, so this is exact. */
function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / DAY);
}

/** The most recent date any sweep was recorded on, or null. */
function latestSweepDay(sweeps) {
    let latest = null;
    for (const s of arr(sweeps)) {
        const d = parseDay(s && s.date);
        if (d && (!latest || d > latest)) latest = d;
    }
    return latest;
}

/**
 * The nearest day that binds the plan, across the tranches actually holding
 * money. The earliest one is the real constraint; a later tranche's binding day
 * is not reached first and quoting it would overstate the room available.
 */
function nearestBindingDate(plan) {
    let soonest = null;
    for (const t of arr(plan && plan.tranches)) {
        if (num(t.amount) <= 0) continue;
        const d = parseDay(t.bindingDate);
        if (d && (!soonest || d < soonest)) soonest = d;
    }
    return soonest ? isoDay(soonest) : null;
}

/**
 * Should the app raise this plan on its own?
 *
 * `state` is what the last raise recorded — `{ lastRaisedOn, lastPlaced }` — and
 * `sweeps` is the recorded sweep history. Both are supplied by the caller; this
 * module has no storage and no clock, so `asOf` is required.
 *
 * Returns `{ raise, reason, detail }`. A refusal always names which rule held,
 * because "no notification appeared" is otherwise indistinguishable from a bug.
 */
export function shouldNudge({ plan, state, sweeps, asOf } = {}) {
    const on = parseDay(asOf);
    // A refusal, not a throw: this runs on the notification path, and a thrown
    // error there would take the loan and income reminders down with it.
    if (!on) return { raise: false, reason: NUDGE.NO_DATE, detail: {} };

    const p = plan || {};
    const placed = num(p.placed);
    if (placed <= 0) return { raise: false, reason: NUDGE.NOTHING_IDLE, detail: { placed } };

    const reserve = num(p.reserve && p.reserve.amount);
    // No reserve means no measured obligations to compare against, which means
    // no idea what "material" is for this person. Advice would be a guess.
    if (reserve <= 0) return { raise: false, reason: NUDGE.NO_BASELINE, detail: { placed, reserve } };

    const bar = reserve * NUDGE_RULES.MIN_RESERVE_MULTIPLE;
    if (placed < bar) {
        return { raise: false, reason: NUDGE.NOT_MATERIAL, detail: { placed, bar, reserve } };
    }

    const swept = latestSweepDay(sweeps);
    if (swept) {
        const since = daysBetween(swept, on);
        if (since >= 0 && since < NUDGE_RULES.RECENT_SWEEP_DAYS) {
            return {
                raise: false,
                reason: NUDGE.RECENT_SWEEP,
                detail: { sweptOn: isoDay(swept), daysSince: since },
            };
        }
    }

    const st = state || {};
    const raisedOn = parseDay(st.lastRaisedOn);
    if (raisedOn) {
        const gap = daysBetween(raisedOn, on);
        // A state stamped in the future — a clock change, or a restored backup —
        // is read as "raised today". The conservative reading is silence.
        const days = gap < 0 ? 0 : gap;
        if (days < NUDGE_RULES.COOLDOWN_DAYS) {
            const before = num(st.lastPlaced);
            // With no previous figure there is nothing to have grown FROM, so the
            // override cannot be established and the cooldown simply stands.
            const grown = before > 0 && placed >= before * NUDGE_RULES.GROWTH_MULTIPLE;
            if (!grown) {
                return {
                    raise: false,
                    reason: NUDGE.COOLING_DOWN,
                    detail: { daysSince: days, placed, lastPlaced: before },
                };
            }
            if (days < NUDGE_RULES.MIN_GAP_DAYS) {
                return {
                    raise: false,
                    reason: NUDGE.TOO_SOON,
                    detail: { daysSince: days, placed, lastPlaced: before },
                };
            }
        }
    }

    const holding = arr(p.tranches).filter((t) => num(t.amount) > 0);
    return {
        raise: true,
        reason: NUDGE.READY,
        detail: {
            placed,
            reserve,
            // The day the runway bottoms out — the whole point of a day-aware
            // limit is that it comes with the date that makes it true.
            bindingDate: nearestBindingDate(p),
            destinations: holding.length,
            // Named so the surface can say where, without re-deriving it.
            top: holding.slice().sort((a, b) => num(b.amount) - num(a.amount))[0] || null,
            projectedAnnualGain: p.projectedAnnualGain == null ? null : num(p.projectedAnnualGain),
        },
    };
}

/**
 * The state to store once a nudge has actually been shown.
 *
 * Separate from shouldNudge() on purpose: deciding and recording are different
 * acts, and a decision function that quietly wrote state could not be called
 * twice — which a render path does routinely.
 */
export function nudgeShown(state, plan, asOf) {
    const on = parseDay(asOf);
    return {
        ...(state && typeof state === 'object' ? state : {}),
        lastRaisedOn: on ? isoDay(on) : null,
        lastPlaced: num(plan && plan.placed),
        raises: num((state || {}).raises) + 1,
    };
}

const API = {
    HORIZONS, DESTINATIONS, NUDGE, NUDGE_RULES,
    reserveFloor, maxSweep, ladder, sweepPlan, shouldNudge, nudgeShown,
};

if (typeof window !== 'undefined') window.WFSweeper = API;

export default API;
