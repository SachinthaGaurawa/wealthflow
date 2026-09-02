/* =============================================================================
 * wealthflow-whatif.js — the What-If engine
 * -----------------------------------------------------------------------------
 * Phase 2 of the predictive work. wealthflow-cashflow-engine.js answers "where
 * does the money go from here". This answers the question the user actually
 * asks out loud:
 *
 *     "What happens if I do this?"
 *
 * WHAT A SCENARIO IS
 *
 * A scenario is a list of CHANGES. Each change is plain data — no functions, no
 * dates resolved from the clock, nothing that cannot be written to Firestore and
 * read back next week. `compile()` turns a scenario into options the projection
 * engine already understands; `runScenario()` projects with and without it and
 * hands back both, plus the difference.
 *
 * THE RULES THIS MODULE COMMITS TO
 *
 *   1. NOTHING IS MUTATED. `appData` is read, never written. A what-if that
 *      leaves a trace in the ledger is not a what-if, it is a transaction.
 *
 *   2. THE BASELINE IS THE SAME QUESTION. Baseline and scenario are projected
 *      with identical options apart from the scenario itself. Comparing a
 *      90-day scenario against a 30-day baseline produces a number that means
 *      nothing, and it is exactly the mistake a caller makes by accident.
 *
 *   3. THE TROUGH DECIDES, NOT THE CLOSING BALANCE. A scenario can end the
 *      horizon richer and still bankrupt you in week three. `verdictOf()` reads
 *      the lowest point and the shortfall date; the closing balance is reported
 *      but never ranked on. There is a test for precisely this case.
 *
 *   4. NOTHING POSTS ITSELF. This module returns numbers. Acting on them is the
 *      user's decision, made in the interface, as with every other engine here.
 *
 *   5. NO CLOCK. `asOf` is required, exactly as in the projection engine. A
 *      forecast that silently depends on when it was run cannot be tested and
 *      cannot be reproduced for the person who is being advised by it.
 * ===========================================================================*/

import {
    isoDay, parseDay, addDays, dayInMonth, project, simulate,
} from './wealthflow-cashflow-engine.js';

const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};

/* ── the vocabulary ───────────────────────────────────────────────────────── */

/**
 * The change kinds a scenario may contain. Deliberately small: every one of
 * these answers a question the user has actually asked in this app, and a
 * vocabulary nobody can enumerate is a vocabulary nobody can render.
 */
export const CHANGE = {
    /** A single payment or receipt on one date. "What if I buy the laptop." */
    ONE_OFF: 'one-off',
    /** A monthly payment or receipt. "What if I take this loan." */
    RECURRING: 'recurring',
    /** Move existing obligations later. "What if this client pays 2 weeks late." */
    DELAY: 'delay',
    /** Remove existing obligations. "What if I clear this loan today." */
    CANCEL: 'cancel',
    /** Scale existing obligations. "What if the rent goes up a tenth." */
    RESIZE: 'resize',
    /** Scale discretionary spending. "What if I spend a fifth less." */
    SPENDING: 'spending',
};

const KNOWN = new Set(Object.values(CHANGE));

/* ── compiling a scenario into engine options ─────────────────────────────── */

/**
 * Turn a scenario into `project()` options.
 *
 * Returns `{ extraCommitments, overrides, variableFactor, rejected }`.
 *
 * `rejected` is not decoration. A change the engine cannot honour — an unknown
 * kind, a missing amount, a date outside the horizon — is REPORTED rather than
 * dropped, because a scenario that quietly loses half its changes still returns
 * a confident-looking projection, and the person reading it has no way to tell.
 */
export function compile(scenario, ctx = {}) {
    const asOf = parseDay(ctx.asOf);
    if (!asOf) throw new TypeError('compile(): asOf must be a date — this module never reads the clock');
    const horizon = Math.max(1, Math.min(730, ctx.horizon || 90));
    const to = addDays(asOf, horizon);

    const changes = Array.isArray(scenario) ? scenario
        : (scenario && Array.isArray(scenario.changes)) ? scenario.changes : [];

    const extraCommitments = [];
    const overrides = [];
    const rejected = [];
    let variableFactor = null;

    const reject = (change, why) => rejected.push({ change, why });

    for (const c of changes) {
        if (!c || !KNOWN.has(c.type)) { reject(c, 'unknown change type'); continue; }

        if (c.type === CHANGE.ONE_OFF) {
            const d = parseDay(c.date);
            const a = num(c.amount);
            if (!d) { reject(c, 'no usable date'); continue; }
            if (!(a > 0)) { reject(c, 'amount must be positive — use kind to say which way it moves'); continue; }
            if (d < asOf || d > to) { reject(c, 'date is outside the projection window'); continue; }
            extraCommitments.push({
                date: isoDay(d), kind: c.kind === 'in' ? 'in' : 'out', amount: a,
                label: String(c.label || 'One-off'), source: 'scenario', certainty: 'proposed',
                id: c.id != null ? String(c.id) : null,
            });
            continue;
        }

        if (c.type === CHANGE.RECURRING) {
            const a = num(c.amount);
            if (!(a > 0)) { reject(c, 'amount must be positive'); continue; }
            const from = parseDay(c.from) || asOf;
            const day = Math.min(31, Math.max(1, Math.trunc(num(c.day) || from.getUTCDate())));
            // `months` caps the series. Absent means "for as long as the horizon
            // runs" — the honest reading of "I would be paying this from now on".
            const cap = c.months != null ? Math.max(0, Math.trunc(num(c.months))) : Infinity;
            let placed = 0;
            for (let k = 0; placed < cap; k++) {
                const d = dayInMonth(from.getUTCFullYear(), from.getUTCMonth() + k, day);
                if (d > to) break;
                if (d < asOf || d < from) continue;
                extraCommitments.push({
                    date: isoDay(d), kind: c.kind === 'in' ? 'in' : 'out', amount: a,
                    label: String(c.label || 'Recurring') + ' — ' + (placed + 1),
                    source: 'scenario', certainty: 'proposed',
                    id: c.id != null ? String(c.id) : null,
                });
                placed++;
            }
            if (!placed) reject(c, 'no instalment falls inside the projection window');
            continue;
        }

        if (c.type === CHANGE.SPENDING) {
            const f = num(c.factor);
            if (!(f >= 0)) { reject(c, 'factor must be zero or more'); continue; }
            // Last one wins, and that is stated rather than left to discover:
            // two spending changes in one scenario is a contradiction, not a
            // compounding, and multiplying them would silently halve twice.
            variableFactor = f;
            continue;
        }

        // The three that rewrite the existing ledger.
        const match = c.match && typeof c.match === 'object' ? c.match : null;
        if (!match) { reject(c, 'needs a match naming what it applies to'); continue; }

        if (c.type === CHANGE.DELAY) {
            const days = Math.trunc(num(c.days));
            if (!days) { reject(c, 'delay needs a non-zero number of days'); continue; }
            overrides.push({ match, shiftDays: days, label: c.label || 'delayed' });
        } else if (c.type === CHANGE.CANCEL) {
            overrides.push({ match, drop: true, label: c.label || 'cancelled' });
        } else if (c.type === CHANGE.RESIZE) {
            const f = num(c.factor);
            if (!(f >= 0)) { reject(c, 'factor must be zero or more'); continue; }
            overrides.push({ match, factor: f, label: c.label || 'resized' });
        }
    }

    return { extraCommitments, overrides, variableFactor, rejected };
}

/* ── comparing two projections ────────────────────────────────────────────── */

/**
 * The difference between two projections of the same question.
 *
 * `runway` is the headline. Everything else is context for it: a date the
 * balance first goes under is a thing a person can act on, and a closing
 * balance three months out is not.
 */
export function compare(base, after) {
    const bRun = base.runway ? base.runway.date : null;
    const aRun = after.runway ? after.runway.date : null;

    let verdict;
    let daysMoved = null;
    if (!bRun && !aRun) verdict = 'no-shortfall';
    else if (!bRun && aRun) verdict = 'creates-shortfall';
    else if (bRun && !aRun) verdict = 'removes-shortfall';
    else {
        daysMoved = after.runway.daysAway - base.runway.daysAway;
        verdict = daysMoved > 0 ? 'postpones' : daysMoved < 0 ? 'brings-forward' : 'unchanged';
    }

    const bTight = base.tightest ? base.tightest.balance : base.opening;
    const aTight = after.tightest ? after.tightest.balance : after.opening;

    return {
        verdict,
        runway: {
            before: bRun,
            after: aRun,
            daysBefore: base.runway ? base.runway.daysAway : null,
            daysAfter: after.runway ? after.runway.daysAway : null,
            daysMoved,
        },
        tightest: {
            before: bTight,
            after: aTight,
            change: aTight - bTight,
            dateBefore: base.tightest ? base.tightest.date : null,
            dateAfter: after.tightest ? after.tightest.date : null,
        },
        closing: { before: base.closing, after: after.closing, change: after.closing - base.closing },
        totals: {
            in: after.totals.in - base.totals.in,
            out: after.totals.out - base.totals.out,
        },
    };
}

/**
 * Is the scenario safer than the baseline, and by what rule.
 *
 * THE RULE, STATED ONCE SO EVERY SURFACE AGREES:
 *   1. Not going under beats going under, whatever the balances say.
 *   2. Between two that both survive, the higher TROUGH wins — the margin on
 *      the worst day is the margin you actually have.
 *   3. Between two that both go under, the later shortfall date wins; a tie is
 *      broken on the trough.
 *
 * The closing balance is deliberately absent. A scenario can finish the horizon
 * richer and still leave you short in week three, and ranking on the closing
 * balance recommends exactly that. test/whatif_test.js pins that case.
 */
export function verdictOf(delta) {
    if (delta.verdict === 'removes-shortfall') return 'safer';
    if (delta.verdict === 'creates-shortfall') return 'riskier';
    if (delta.runway.daysMoved != null && delta.runway.daysMoved !== 0) {
        return delta.runway.daysMoved > 0 ? 'safer' : 'riskier';
    }
    if (delta.tightest.change > 0) return 'safer';
    if (delta.tightest.change < 0) return 'riskier';
    return 'neutral';
}

/* ── running one ──────────────────────────────────────────────────────────── */

/**
 * Project with and without the scenario and return both, plus the difference.
 *
 * The baseline uses the caller's options UNCHANGED and the scenario's options
 * on top — same horizon, same floor, same lookback, same asOf. Two projections
 * that answer different questions cannot be subtracted, and that is the easiest
 * mistake to make here by accident.
 *
 * Pass `runs` to add the Monte Carlo view: the probability of going under at
 * all, before and after. Committed movements are fixed in every path; what
 * varies is discretionary spending, drawn from the user's own history.
 */
export function runScenario(appData, scenario, opts = {}) {
    const asOf = parseDay(opts.asOf);
    if (!asOf) throw new TypeError('runScenario(): asOf must be a date — this module never reads the clock');

    const compiled = compile(scenario, opts);

    // The caller's own extras survive: a sweep leg the UI derived elsewhere is
    // part of the baseline reality, not part of the question being asked.
    const callerExtras = Array.isArray(opts.extraCommitments) ? opts.extraCommitments : [];
    const baseOpts = { ...opts };
    delete baseOpts.overrides;
    delete baseOpts.variableFactor;

    const afterOpts = {
        ...baseOpts,
        extraCommitments: callerExtras.concat(compiled.extraCommitments),
        overrides: compiled.overrides,
    };
    if (compiled.variableFactor != null) afterOpts.variableFactor = compiled.variableFactor;

    const base = project(appData, baseOpts);
    const after = project(appData, afterOpts);
    const delta = compare(base, after);

    const out = {
        asOf: isoDay(asOf),
        baseline: base,
        after,
        delta,
        safety: verdictOf(delta),
        rejected: compiled.rejected,
        // Obligations the scenario removed or pushed out of the window, so a
        // surprisingly healthy result can always be traced to what paid for it.
        removed: after.ignored.filter((i) => String(i.why || '').startsWith('removed by scenario')
            || String(i.why || '').includes('by scenario')),
    };

    const runs = Math.trunc(num(opts.runs));
    if (runs > 0) {
        const bs = simulate(appData, { ...baseOpts, runs });
        const as = simulate(appData, { ...afterOpts, runs });
        out.risk = {
            runs,
            shortfallBefore: bs.shortfallProbability,
            shortfallAfter: as.shortfallProbability,
            change: as.shortfallProbability - bs.shortfallProbability,
            medianRunwayBefore: bs.medianRunwayDays,
            medianRunwayAfter: as.medianRunwayDays,
            bandsAfter: as.bands,
        };
    }

    return out;
}

/* ── choosing between several ─────────────────────────────────────────────── */

/**
 * Run several scenarios against one baseline and order them best-first, by the
 * rule in verdictOf(): survival, then the trough, then the shortfall date.
 *
 * The baseline is projected ONCE and shared. Beyond being faster, it removes
 * the possibility of ranking scenarios against slightly different baselines,
 * which is how a comparison table ends up internally inconsistent.
 */
export function rank(appData, scenarios, opts = {}) {
    const list = Array.isArray(scenarios) ? scenarios : [];
    const baseOpts = { ...opts };
    delete baseOpts.overrides;
    delete baseOpts.variableFactor;
    const base = project(appData, baseOpts);

    const scored = list.map((s, i) => {
        const run = runScenario(appData, s, opts);
        return {
            index: i,
            name: (s && s.name) || ('Scenario ' + (i + 1)),
            result: run,
            delta: run.delta,
            safety: run.safety,
        };
    });

    scored.sort((a, b) => {
        const av = a.result.after, bv = b.result.after;
        const aUnder = av.runway ? 1 : 0, bUnder = bv.runway ? 1 : 0;
        if (aUnder !== bUnder) return aUnder - bUnder;            // survivors first
        if (aUnder) {                                             // both go under
            const d = bv.runway.daysAway - av.runway.daysAway;    // later is better
            if (d) return d;
        }
        const at = av.tightest ? av.tightest.balance : av.opening;
        const bt = bv.tightest ? bv.tightest.balance : bv.opening;
        return bt - at;                                           // higher trough first
    });

    return { baseline: base, ranked: scored };
}

const API = { CHANGE, compile, compare, verdictOf, runScenario, rank };

// Browser global, matching the other WealthFlow modules. Guarded so importing
// this file in Node (the test suite, any tooling) touches nothing.
if (typeof window !== 'undefined') window.WFWhatIf = API;

export default API;
