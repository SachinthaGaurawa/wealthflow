/* =============================================================================
 * test/whatif_test.js — the What-If engine
 * -----------------------------------------------------------------------------
 * Two things have to hold, and the second is the one that is easy to lose.
 *
 *   1. A scenario changes what it says it changes.
 *   2. A scenario changes NOTHING ELSE. An empty scenario must reproduce the
 *      baseline exactly, and the baseline must be projected with the same
 *      options as the scenario. Every number this module reports is a
 *      difference between two projections, so a baseline that drifted makes
 *      every one of them a fiction — and a plausible-looking one.
 *
 * The ledger below is the same shape as test/cashflow_engine_test.js, which was
 * taken from the code that writes it. `asOf` is passed everywhere; nothing here
 * depends on the day the suite runs.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { project, applyOverrides, parseDay, isoDay } from '../wealthflow-cashflow-engine.js';
import {
    CHANGE, compile, compare, verdictOf, runScenario, rank,
} from '../wealthflow-whatif.js';

const AS_OF = '2026-08-26';
const OPTS = { asOf: AS_OF, horizon: 120, floor: 0 };

const LEDGER = () => ({
    balance: { total: 250000, flows: [] },
    loans: [{ id: 'L1', name: 'BOC Home', amount: 2000000, rate: 12,
        duration: 60, monthly: 45000, start: '2026-03-05', paymentMethod: 'emi', skipped: [] }],
    subscriptions: [{ id: 'S1', name: 'Netflix', amount: 1990, dueDay: 12, cycle: 'monthly', createdAt: '2026-01-12T00:00:00Z' }],
    cheques: [{ id: 'Q1', no: '4471', party: 'Perera Hardware', type: 'issued', amount: 180000,
        issue: '2026-08-15', release: '2026-09-15', status: 'pending' }],
    incomeRecv: [{ id: 'R1', name: 'Consulting', type: 'Other', amount: 85000, month: '2026-09', date: '2026-09-20', received: false }],
    income: [{ id: 'I1', name: 'FD interest', company: 'BOC', monthly: 22000, day: 1, start: '2025-01-01', freq: 'monthly' }],
    expenses: [
        { id: 'E1', desc: 'Rent', cat: 'Housing', amount: 55000, month: '2026-08', recurring: true, completed: false },
        { id: 'E2', desc: 'Groceries', cat: 'Food', amount: 18000, month: '2026-07', recurring: false },
        { id: 'E3', desc: 'Fuel', cat: 'Transport', amount: 12000, month: '2026-07', recurring: false },
    ],
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BASELINE MUST NOT MOVE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('an absent scenario changes nothing', () => {
    it('the new engine options are no-ops when not passed', () => {
        const a = project(LEDGER(), OPTS);
        const b = project(LEDGER(), { ...OPTS, overrides: undefined, variableFactor: undefined });
        expect(b.closing).toBe(a.closing);
        expect(b.commitments.length).toBe(a.commitments.length);
        expect(b.tightest.balance).toBe(a.tightest.balance);
    });

    it('an empty overrides list is a no-op, not a wipe', () => {
        const a = project(LEDGER(), OPTS);
        const b = project(LEDGER(), { ...OPTS, overrides: [] });
        expect(b.commitments.length).toBe(a.commitments.length);
        expect(b.closing).toBe(a.closing);
    });

    it('variableFactor of 1 reproduces the default exactly', () => {
        const a = project(LEDGER(), OPTS);
        const b = project(LEDGER(), { ...OPTS, variableFactor: 1 });
        expect(b.closing).toBe(a.closing);
    });

    it('an empty scenario reproduces the baseline, number for number', () => {
        const r = runScenario(LEDGER(), { changes: [] }, OPTS);
        expect(r.after.closing).toBe(r.baseline.closing);
        expect(r.delta.closing.change).toBe(0);
        expect(r.delta.tightest.change).toBe(0);
        expect(r.safety).toBe('neutral');
    });

    it('does not mutate appData', () => {
        const data = LEDGER();
        const before = JSON.stringify(data);
        runScenario(data, { changes: [
            { type: CHANGE.CANCEL, match: { source: 'loans' } },
            { type: CHANGE.ONE_OFF, kind: 'out', amount: 50000, date: '2026-09-10' },
        ] }, OPTS);
        expect(JSON.stringify(data)).toBe(before);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * applyOverrides — THE ONE THAT MUST NOT BE GENEROUS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('applyOverrides: an empty match matches nothing', () => {
    const items = [
        { date: '2026-09-05', kind: 'out', amount: 45000, label: 'BOC Home — instalment 7/60', source: 'loans', certainty: 'committed', id: 'L1' },
        { date: '2026-09-20', kind: 'in', amount: 85000, label: 'Consulting', source: 'incomeRecv', certainty: 'committed', id: 'R1' },
    ];
    const asOf = parseDay('2026-08-26');
    const to = parseDay('2026-12-24');

    it('a drop with no match leaves every obligation standing', () => {
        // The failure this guards against: `{ drop: true }` deleting the whole
        // ledger and reporting a gloriously healthy projection.
        const r = applyOverrides(items, [{ drop: true }], asOf, to);
        expect(r.items).toHaveLength(2);
        expect(r.dropped).toHaveLength(0);
    });

    it('a match with only empty strings matches nothing either', () => {
        const r = applyOverrides(items, [{ match: { id: '', source: '' }, drop: true }], asOf, to);
        expect(r.items).toHaveLength(2);
    });

    it('every field named in a match must match', () => {
        const wrong = applyOverrides(items, [{ match: { source: 'loans', kind: 'in' }, drop: true }], asOf, to);
        expect(wrong.items).toHaveLength(2);
        const right = applyOverrides(items, [{ match: { source: 'loans', kind: 'out' }, drop: true }], asOf, to);
        expect(right.items).toHaveLength(1);
    });

    it('matches on a label substring, case-insensitively', () => {
        const r = applyOverrides(items, [{ match: { labelIncludes: 'boc home' }, drop: true }], asOf, to);
        expect(r.items).toHaveLength(1);
        expect(r.items[0].id).toBe('R1');
    });

    it('the first matching override wins', () => {
        const r = applyOverrides(items, [
            { match: { source: 'loans' }, factor: 0.5 },
            { match: { source: 'loans' }, drop: true },
        ], asOf, to);
        expect(r.items.find((i) => i.id === 'L1').amount).toBe(22500);
    });

    it('reports what it dropped, rather than vanishing it', () => {
        const r = applyOverrides(items, [{ match: { id: 'L1' }, drop: true, label: 'settled early' }], asOf, to);
        expect(r.dropped).toHaveLength(1);
        expect(r.dropped[0].id).toBe('L1');
        expect(r.dropped[0].why).toContain('settled early');
    });

    it('a shift out of the window drops loudly, not silently', () => {
        const r = applyOverrides(items, [{ match: { id: 'R1' }, shiftDays: 400 }], asOf, to);
        expect(r.items).toHaveLength(1);
        expect(r.dropped[0].why).toContain('outside the projection window');
    });

    it('a shift into the past drops too — that money has already gone', () => {
        const r = applyOverrides(items, [{ match: { id: 'L1' }, shiftDays: -60 }], asOf, to);
        expect(r.items).toHaveLength(1);
        expect(r.dropped[0].why).toContain('outside the projection window');
    });

    it('scaling to zero removes rather than posting a zero-value event', () => {
        const r = applyOverrides(items, [{ match: { id: 'L1' }, factor: 0 }], asOf, to);
        expect(r.items).toHaveLength(1);
        expect(r.dropped[0].why).toContain('scaled to zero');
    });

    it('a shift inside the window moves the date and keeps the amount', () => {
        const r = applyOverrides(items, [{ match: { id: 'R1' }, shiftDays: 14 }], asOf, to);
        const moved = r.items.find((i) => i.id === 'R1');
        expect(moved.date).toBe('2026-10-04');
        expect(moved.amount).toBe(85000);
        expect(moved.certainty).toBe('proposed');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * compile
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('compile: a change it cannot honour is reported, never dropped', () => {
    const ctx = { asOf: AS_OF, horizon: 120 };

    it('rejects an unknown change type by name', () => {
        const c = compile({ changes: [{ type: 'teleport', amount: 5 }] }, ctx);
        expect(c.rejected).toHaveLength(1);
        expect(c.rejected[0].why).toContain('unknown');
    });

    it('rejects a one-off outside the window rather than clamping it', () => {
        // Clamping would place a payment on a day the user never chose, and the
        // projection would look right while describing something else.
        const c = compile({ changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 1000, date: '2027-06-01' }] }, ctx);
        expect(c.extraCommitments).toHaveLength(0);
        expect(c.rejected[0].why).toContain('outside the projection window');
    });

    it('rejects a negative amount instead of flipping its direction', () => {
        const c = compile({ changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: -1000, date: '2026-09-01' }] }, ctx);
        expect(c.rejected[0].why).toContain('positive');
    });

    it('expands a recurring change across the horizon', () => {
        const c = compile({ changes: [{ type: CHANGE.RECURRING, kind: 'out', amount: 15000, day: 10, label: 'Car lease' }] }, ctx);
        // 2026-09-10, 10-10, 11-10, 12-10 — four inside a 120-day window.
        expect(c.extraCommitments).toHaveLength(4);
        expect(c.extraCommitments[0].date).toBe('2026-09-10');
        expect(c.extraCommitments.every((e) => e.amount === 15000)).toBe(true);
        expect(c.extraCommitments[0].label).toContain('Car lease');
    });

    it('honours a months cap', () => {
        const c = compile({ changes: [{ type: CHANGE.RECURRING, kind: 'out', amount: 15000, day: 10, months: 2 }] }, ctx);
        expect(c.extraCommitments).toHaveLength(2);
    });

    it('clamps a day-of-month to the length of each month', () => {
        const c = compile({ changes: [{ type: CHANGE.RECURRING, kind: 'out', amount: 100, day: 31, from: '2026-09-01' }] }, ctx);
        const months = c.extraCommitments.map((e) => e.date.slice(0, 7));
        expect(new Set(months).size).toBe(months.length);   // never two in one month
        expect(c.extraCommitments.map((e) => e.date)).toContain('2026-11-30');
    });

    it('rejects a ledger-rewriting change that names nothing', () => {
        const c = compile({ changes: [{ type: CHANGE.CANCEL }] }, ctx);
        expect(c.overrides).toHaveLength(0);
        expect(c.rejected[0].why).toContain('match');
    });

    it('a second spending change replaces the first rather than compounding', () => {
        const c = compile({ changes: [
            { type: CHANGE.SPENDING, factor: 0.5 },
            { type: CHANGE.SPENDING, factor: 0.8 },
        ] }, ctx);
        expect(c.variableFactor).toBe(0.8);
    });

    it('refuses to read the clock', () => {
        expect(() => compile({ changes: [] }, {})).toThrow(/asOf/);
        expect(() => runScenario(LEDGER(), { changes: [] }, {})).toThrow(/asOf/);
    });

    it('accepts a bare array as well as a named scenario', () => {
        const a = compile([{ type: CHANGE.ONE_OFF, kind: 'out', amount: 1, date: '2026-09-01' }], ctx);
        const b = compile({ name: 'x', changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 1, date: '2026-09-01' }] }, ctx);
        expect(a.extraCommitments).toEqual(b.extraCommitments);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE QUESTIONS A PERSON ACTUALLY ASKS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the questions this exists to answer', () => {
    it('"what if I buy this" moves the trough down by exactly the amount', () => {
        const r = runScenario(LEDGER(), { changes: [
            { type: CHANGE.ONE_OFF, kind: 'out', amount: 40000, date: '2026-09-01', label: 'Laptop' },
        ] }, OPTS);
        // toBeCloseTo, not toBe: both projections subtract a fractional daily
        // variable spend, so the difference carries the float error of ~120
        // additions. The engine is not wrong; an exact assertion here would be.
        expect(r.delta.closing.change).toBeCloseTo(-40000, 6);
        expect(r.delta.totals.out).toBeCloseTo(40000, 6);
        expect(r.safety).toBe('riskier');
    });

    it('"what if this client pays two weeks late" delays the inflow, not the amount', () => {
        const r = runScenario(LEDGER(), { changes: [
            { type: CHANGE.DELAY, match: { id: 'R1' }, days: 14, label: 'client pays late' },
        ] }, OPTS);
        // The money still arrives inside the horizon, so the closing balance is
        // unchanged — and the trough, which is what actually matters, is not.
        expect(r.delta.closing.change).toBe(0);
        expect(r.delta.tightest.change).toBeLessThanOrEqual(0);
        const moved = r.after.commitments.find((c) => c.id === 'R1');
        expect(moved.date).toBe('2026-10-04');
    });

    it('"what if I clear this loan" removes every remaining instalment', () => {
        const base = project(LEDGER(), OPTS);
        const r = runScenario(LEDGER(), { changes: [
            { type: CHANGE.CANCEL, match: { source: 'loans' }, label: 'settled in full' },
        ] }, OPTS);
        const baseLoans = base.commitments.filter((c) => c.source === 'loans');
        expect(baseLoans.length).toBeGreaterThan(0);
        expect(r.after.commitments.filter((c) => c.source === 'loans')).toHaveLength(0);
        expect(r.delta.closing.change).toBeCloseTo(baseLoans.reduce((s, c) => s + c.amount, 0), 6);
        expect(r.removed.length).toBe(baseLoans.length);
        expect(r.safety).toBe('safer');
    });

    it('"what if the rent goes up a tenth" scales only that obligation', () => {
        const base = project(LEDGER(), OPTS);
        const r = runScenario(LEDGER(), { changes: [
            { type: CHANGE.RESIZE, match: { labelIncludes: 'Rent' }, factor: 1.1 },
        ] }, OPTS);
        const b = base.commitments.filter((c) => c.label.includes('Rent'));
        const a = r.after.commitments.filter((c) => c.label.includes('Rent'));
        expect(a).toHaveLength(b.length);
        expect(a[0].amount).toBeCloseTo(b[0].amount * 1.1, 6);
        // Nothing else moved.
        const others = (p) => p.commitments.filter((c) => !c.label.includes('Rent')).reduce((s, c) => s + c.amount, 0);
        expect(others(r.after)).toBeCloseTo(others(base), 6);
    });

    it('"what if I spend a fifth less" scales the discretionary slice only', () => {
        const base = project(LEDGER(), OPTS);
        const r = runScenario(LEDGER(), { changes: [{ type: CHANGE.SPENDING, factor: 0.8 }] }, OPTS);
        const baseVar = base.days.reduce((s, d) => s + d.variable, 0);
        const afterVar = r.after.days.reduce((s, d) => s + d.variable, 0);
        expect(baseVar).toBeGreaterThan(0);
        expect(afterVar).toBeCloseTo(baseVar * 0.8, 6);
        expect(r.after.commitments.length).toBe(base.commitments.length);
    });

    it('"what if I stopped spending entirely" is allowed and is not a no-op', () => {
        const r = runScenario(LEDGER(), { changes: [{ type: CHANGE.SPENDING, factor: 0 }] }, OPTS);
        expect(r.after.days.reduce((s, d) => s + d.variable, 0)).toBe(0);
        expect(r.delta.closing.change).toBeGreaterThan(0);
    });

    it('"what if I take this loan" places real dated instalments, not a monthly average', () => {
        const r = runScenario(LEDGER(), { changes: [
            { type: CHANGE.RECURRING, kind: 'out', amount: 30000, day: 5, label: 'New lease' },
        ] }, OPTS);
        const added = r.after.commitments.filter((c) => c.source === 'scenario');
        expect(added.length).toBeGreaterThan(1);
        expect(new Set(added.map((c) => c.date)).size).toBe(added.length);
        for (const c of added) expect(c.date.endsWith('-05')).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RANKING RULE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the trough decides, not the closing balance', () => {
    /* A ledger with a large late inflow: a scenario can finish the horizon far
     * richer while going under in week two. Ranking on the closing balance
     * recommends exactly that scenario. This is the case that rule exists for. */
    const THIN = () => ({
        // Enough to survive the rent until the settlement lands — the whole
        // point of the case below is a baseline that does NOT go under.
        balance: { total: 120000, flows: [] },
        incomeRecv: [{ id: 'BIG', name: 'Late settlement', type: 'Other', amount: 900000, month: '2026-11', date: '2026-11-20', received: false }],
        expenses: [{ id: 'E1', desc: 'Rent', cat: 'Housing', amount: 30000, month: '2026-08', recurring: true, completed: false }],
    });
    const THIN_OPTS = { asOf: AS_OF, horizon: 120, floor: 0, includeVariable: false };

    it('a scenario that ends richer but goes under first is called riskier', () => {
        // Spend 55,000 now, receive 200,000 in three months: the horizon closes
        // 145,000 up, and the balance goes under long before that.
        const r = runScenario(THIN(), { changes: [
            { type: CHANGE.ONE_OFF, kind: 'out', amount: 55000, date: '2026-08-27' },
            { type: CHANGE.ONE_OFF, kind: 'in', amount: 200000, date: '2026-11-25' },
        ] }, THIN_OPTS);

        expect(r.delta.closing.change).toBeGreaterThan(0);      // ends richer
        expect(r.baseline.runway).toBeNull();                   // baseline survives
        expect(r.after.runway).not.toBeNull();                  // scenario does not
        expect(r.delta.verdict).toBe('creates-shortfall');
        expect(r.safety).toBe('riskier');                       // and is called riskier
    });

    it('ranks a survivor above a richer scenario that goes under', () => {
        const survives = { name: 'Wait', changes: [] };
        const richerButBroke = {
            name: 'Spend now, collect later',
            changes: [
                { type: CHANGE.ONE_OFF, kind: 'out', amount: 55000, date: '2026-08-27' },
                { type: CHANGE.ONE_OFF, kind: 'in', amount: 200000, date: '2026-11-25' },
            ],
        };
        const { ranked } = rank(THIN(), [richerButBroke, survives], THIN_OPTS);
        expect(ranked[0].name).toBe('Wait');
        expect(ranked[1].result.after.closing).toBeGreaterThan(ranked[0].result.after.closing);
    });

    it('between two survivors, the higher trough wins', () => {
        const small = { name: 'Small', changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 5000, date: '2026-09-02' }] };
        const large = { name: 'Large', changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 20000, date: '2026-09-02' }] };
        const { ranked } = rank(THIN(), [large, small], THIN_OPTS);
        expect(ranked[0].name).toBe('Small');
    });

    it('between two that both go under, the later shortfall wins', () => {
        const soon = { name: 'Soon', changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 70000, date: '2026-08-27' }] };
        const later = { name: 'Later', changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 70000, date: '2026-10-20' }] };
        const { ranked } = rank(THIN(), [soon, later], THIN_OPTS);
        expect(ranked[0].name).toBe('Later');
        expect(ranked[0].result.after.runway.daysAway)
            .toBeGreaterThan(ranked[1].result.after.runway.daysAway);
    });

    it('every ranked scenario is measured against ONE baseline', () => {
        const { baseline, ranked } = rank(THIN(), [
            { name: 'a', changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 1000, date: '2026-09-02' }] },
            { name: 'b', changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 2000, date: '2026-09-02' }] },
        ], THIN_OPTS);
        for (const s of ranked) {
            expect(s.result.baseline.closing).toBe(baseline.closing);
            expect(s.result.baseline.horizon).toBe(baseline.horizon);
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * compare / verdictOf
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('compare names what happened to the shortfall date', () => {
    const p = (runwayDays, tight, closing) => ({
        runway: runwayDays == null ? null : { date: isoDay(new Date(Date.UTC(2026, 7, 26 + runwayDays))), daysAway: runwayDays },
        tightest: { date: '2026-09-01', balance: tight },
        opening: 0, closing, totals: { in: 0, out: 0 },
    });

    it('says so when neither goes under', () => {
        expect(compare(p(null, 10, 10), p(null, 20, 20)).verdict).toBe('no-shortfall');
    });
    it('names a shortfall the scenario creates', () => {
        expect(compare(p(null, 10, 10), p(30, -5, 5)).verdict).toBe('creates-shortfall');
    });
    it('names a shortfall the scenario removes', () => {
        expect(compare(p(30, -5, 5), p(null, 10, 10)).verdict).toBe('removes-shortfall');
    });
    it('measures how far a shortfall moved, in days', () => {
        const d = compare(p(30, -5, 5), p(45, -2, 6));
        expect(d.verdict).toBe('postpones');
        expect(d.runway.daysMoved).toBe(15);
        expect(verdictOf(d)).toBe('safer');
    });
    it('a shortfall brought forward is riskier even if the horizon closes higher', () => {
        const d = compare(p(45, -2, 6), p(30, -5, 900));
        expect(d.verdict).toBe('brings-forward');
        expect(d.closing.change).toBeGreaterThan(0);
        expect(verdictOf(d)).toBe('riskier');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MONTE CARLO VIEW
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the risk view is optional, seeded, and comparable', () => {
    it('is absent unless asked for', () => {
        expect(runScenario(LEDGER(), { changes: [] }, OPTS).risk).toBeUndefined();
    });

    it('reports the change in the probability of going under', () => {
        const r = runScenario(LEDGER(), { changes: [
            { type: CHANGE.ONE_OFF, kind: 'out', amount: 200000, date: '2026-09-01' },
        ] }, { ...OPTS, runs: 120 });
        expect(r.risk.runs).toBe(120);
        expect(r.risk.shortfallAfter).toBeGreaterThanOrEqual(r.risk.shortfallBefore);
        expect(r.risk.change).toBeCloseTo(r.risk.shortfallAfter - r.risk.shortfallBefore, 10);
    });

    it('is reproducible — the same question twice gives the same answer', () => {
        const q = { changes: [{ type: CHANGE.ONE_OFF, kind: 'out', amount: 120000, date: '2026-09-05' }] };
        const a = runScenario(LEDGER(), q, { ...OPTS, runs: 100 });
        const b = runScenario(LEDGER(), q, { ...OPTS, runs: 100 });
        expect(a.risk.shortfallAfter).toBe(b.risk.shortfallAfter);
        expect(a.risk.medianRunwayAfter).toBe(b.risk.medianRunwayAfter);
    });
});
