/* =============================================================================
 * test/sweep_nudge_test.js
 * -----------------------------------------------------------------------------
 * shouldNudge() is almost entirely a function for NOT sending notifications, so
 * that is what most of this file tests.
 *
 * The failure mode it exists to prevent is not "the nudge never fires". It is
 * "the nudge fires every day". Idle cash persists — it is idle today, idle
 * tomorrow, idle next week — so a rule that says "tell them when there is
 * something to sweep" is a rule that says "tell them daily, forever". The owner
 * then switches notifications off, and the loan and income reminders go off with
 * them. Those are time-critical and cannot be recovered once missed, so a
 * badly-tuned nudge does not merely annoy; it costs the owner the reminders that
 * actually matter.
 *
 * That is why the tests below spend far more effort on the silences than on the
 * one case that speaks, and why several of them assert a specific REASON rather
 * than just `raise === false`. A refusal that fires for the wrong reason is a
 * bug that passes a boolean assertion — and would leave "no notification
 * appeared" indistinguishable from a crash.
 *
 * WHAT IS NOT TESTED HERE
 *
 * Whether the plan itself is right. ladder(), maxSweep() and reserveFloor() have
 * their own tests and are given to this function already computed; these fixtures
 * are plan-SHAPED objects, not derived from a ledger, so a change in how a plan
 * is built cannot make this file pass for the wrong reason.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { shouldNudge, nudgeShown, NUDGE, NUDGE_RULES } from '../wealthflow-wealth-sweeper.js';

/* A plan holding `placed` against a reserve of 200,000. The materiality bar is
 * half the reserve, so 100,000 — fixtures sit either side of it deliberately. */
const plan = (placed, over = {}) => ({
    placed,
    reserve: { amount: 200000 },
    tranches: [
        { destination: 'fd-12m', label: '12-month fixed deposit', amount: placed * 0.6, bindingDate: '2026-11-20' },
        { destination: 'savings', label: 'Withdrawable savings', amount: placed * 0.4, bindingDate: '2026-09-14' },
    ],
    projectedAnnualGain: null,
    ...over,
});

const TODAY = '2026-09-01';

describe('the cases where it stays quiet', () => {
    it('says nothing when nothing is idle', () => {
        const r = shouldNudge({ plan: plan(0), asOf: TODAY });
        expect(r.raise).toBe(false);
        expect(r.reason).toBe(NUDGE.NOTHING_IDLE);
    });

    it('says nothing when the idle amount is small against this owner reserve', () => {
        /* 80,000 idle against a 200,000 monthly obligation is not worth an
         * interruption. The same 80,000 for someone with a 40,000 reserve is,
         * which is exactly why the bar is a multiple and not a rupee figure. */
        const r = shouldNudge({ plan: plan(80000), asOf: TODAY });
        expect(r.reason).toBe(NUDGE.NOT_MATERIAL);
        expect(r.detail.bar).toBe(100000);
    });

    it('treats exactly the bar as material, and one rupee under it as not', () => {
        /* Added because a mutation survived: with fixtures only at 80,000 and
         * 500,000 against a 100,000 bar, `placed < bar` could be widened to
         * `placed <= bar - 1` and every test still passed. The boundary was
         * named in the rule and reached by nothing.
         *
         * "At least half a month of committed outflows" includes the half. */
        expect(shouldNudge({ plan: plan(100000), asOf: TODAY }).raise).toBe(true);
        expect(shouldNudge({ plan: plan(99999), asOf: TODAY }).reason).toBe(NUDGE.NOT_MATERIAL);
        /* Fractional, because `< bar` and `<= bar - 1` agree on every integer and
         * part company only here. `placed` is a sum of tranche amounts and `bar`
         * is a halved reserve, so both really do carry fractions. */
        expect(shouldNudge({ plan: plan(99999.5), asOf: TODAY }).reason).toBe(NUDGE.NOT_MATERIAL);
    });

    it('says nothing when there is no reserve to judge materiality against', () => {
        /* No measured obligations means no idea what "material" means for this
         * person. Advice would be a guess wearing a number. */
        const r = shouldNudge({ plan: plan(500000, { reserve: { amount: 0 } }), asOf: TODAY });
        expect(r.reason).toBe(NUDGE.NO_BASELINE);
    });

    it('says nothing for a week after a sweep was recorded', () => {
        const r = shouldNudge({
            plan: plan(500000), asOf: TODAY,
            sweeps: [{ date: '2026-08-28' }],
        });
        expect(r.reason).toBe(NUDGE.RECENT_SWEEP);
        expect(r.detail.daysSince).toBe(4);
    });

    it('reads the LATEST sweep, not the first one it happens to see', () => {
        /* Stored order is not chronological order. Taking the first entry would
         * let an old sweep satisfy the recency check and re-open the nudge on
         * someone who acted yesterday. */
        const r = shouldNudge({
            plan: plan(500000), asOf: TODAY,
            sweeps: [{ date: '2025-01-01' }, { date: '2026-08-31' }, { date: '2024-06-06' }],
        });
        expect(r.reason).toBe(NUDGE.RECENT_SWEEP);
        expect(r.detail.daysSince).toBe(1);
    });

    it('THE ONE THAT MATTERS: does not repeat itself the next day', () => {
        /* The whole file exists for this line. Same cash, one day later, and the
         * answer must be silence — otherwise this fires every day until the owner
         * turns notifications off and loses the payment reminders too. */
        const r = shouldNudge({
            plan: plan(500000), asOf: '2026-09-02',
            state: { lastRaisedOn: '2026-09-01', lastPlaced: 500000 },
        });
        expect(r.raise).toBe(false);
        expect(r.reason).toBe(NUDGE.COOLING_DOWN);
    });

    it('stays quiet for the whole cooldown, then speaks on the far side of it', () => {
        const at = (day) => shouldNudge({
            plan: plan(500000), asOf: day,
            state: { lastRaisedOn: '2026-09-01', lastPlaced: 500000 },
        }).raise;
        expect(NUDGE_RULES.COOLDOWN_DAYS).toBe(14);
        expect(at('2026-09-14'), 'spoke one day early').toBe(false);   // 13 days
        expect(at('2026-09-15'), 'never spoke again').toBe(true);      // 14 days
    });

    it('treats a state stamped in the future as raised today', () => {
        /* A clock change or a restored backup can leave lastRaisedOn ahead of
         * today. Signed day arithmetic would make that a large positive gap and
         * clear the cooldown instantly — every restore would fire a nudge. */
        const r = shouldNudge({
            plan: plan(500000), asOf: TODAY,
            state: { lastRaisedOn: '2027-01-01', lastPlaced: 500000 },
        });
        expect(r.reason).toBe(NUDGE.COOLING_DOWN);
        expect(r.detail.daysSince).toBe(0);
    });

    it('refuses rather than throwing when the date is unusable', () => {
        /* This runs on the notification path. A throw here would take the loan
         * and income reminders down with it, which is a far worse outcome than
         * a missed sweep suggestion. */
        for (const bad of [undefined, null, '', 'not-a-date', {}]) {
            const r = shouldNudge({ plan: plan(500000), asOf: bad });
            expect(r.raise, String(bad)).toBe(false);
            expect(r.reason).toBe(NUDGE.NO_DATE);
        }
        expect(() => shouldNudge()).not.toThrow();
        expect(shouldNudge().raise).toBe(false);
    });
});

describe('the override, and the floor under the override', () => {
    it('speaks again inside the cooldown when much more cash has gone idle', () => {
        /* A salary landing is new information, and waiting out a fortnight to
         * mention it would be the passive behaviour this change removes. */
        const r = shouldNudge({
            plan: plan(900000), asOf: '2026-09-06',
            state: { lastRaisedOn: '2026-09-01', lastPlaced: 500000 },
        });
        expect(r.raise).toBe(true);
        expect(r.reason).toBe(NUDGE.READY);
    });

    it('does not treat a small drift as new information', () => {
        const r = shouldNudge({
            plan: plan(600000), asOf: '2026-09-06',
            state: { lastRaisedOn: '2026-09-01', lastPlaced: 500000 },
        });
        expect(r.reason).toBe(NUDGE.COOLING_DOWN);   // 1.2x, under the 1.5x bar
    });

    it('holds a three-day floor even when the amount has doubled', () => {
        /* The projection moves on its own — a single dated commitment shifting
         * can change `placed` sharply. Without this floor a jumpy curve produces
         * a daily alert that each individually passes the growth test. */
        const r = shouldNudge({
            plan: plan(1200000), asOf: '2026-09-02',
            state: { lastRaisedOn: '2026-09-01', lastPlaced: 500000 },
        });
        expect(r.raise).toBe(false);
        expect(r.reason).toBe(NUDGE.TOO_SOON);
    });

    it('cannot establish growth from a missing previous figure, so the cooldown stands', () => {
        /* Corrupt or partial state must fail towards silence, never towards a
         * notification. `lastPlaced` absent would make `x >= 0 * 1.5` true for
         * every amount and turn every broken state into a daily alert. */
        for (const st of [{ lastRaisedOn: '2026-09-01' }, { lastRaisedOn: '2026-09-01', lastPlaced: 0 }]) {
            const r = shouldNudge({ plan: plan(900000), asOf: '2026-09-06', state: st });
            expect(r.reason).toBe(NUDGE.COOLING_DOWN);
        }
    });
});

describe('what it hands the surface when it does speak', () => {
    it('raises on a first look with material idle cash', () => {
        const r = shouldNudge({ plan: plan(500000), asOf: TODAY });
        expect(r).toMatchObject({ raise: true, reason: NUDGE.READY });
        expect(r.detail.placed).toBe(500000);
        expect(r.detail.destinations).toBe(2);
    });

    it('names the NEAREST binding day, not the furthest', () => {
        /* The earliest constraint is the one actually reached. Quoting the later
         * one would tell the owner they have room they do not have — a day-aware
         * limit whose date is wrong is worse than no date at all. */
        const r = shouldNudge({ plan: plan(500000), asOf: TODAY });
        expect(r.detail.bindingDate).toBe('2026-09-14');
    });

    it('names the largest tranche as the headline destination', () => {
        const r = shouldNudge({ plan: plan(500000), asOf: TODAY });
        expect(r.detail.top.destination).toBe('fd-12m');
    });

    it('ignores tranches holding nothing when picking the binding day', () => {
        /* An empty tranche still carries a bindingDate. Letting it win would
         * quote a constraint on money the plan is not moving. */
        const p = plan(500000);
        p.tranches = [
            { destination: 'fd-12m', amount: 500000, bindingDate: '2026-11-20' },
            { destination: 'savings', amount: 0, bindingDate: '2026-09-02' },
        ];
        const r = shouldNudge({ plan: p, asOf: TODAY });
        expect(r.detail.bindingDate).toBe('2026-11-20');
        expect(r.detail.destinations).toBe(1);
    });

    it('passes a gain through as null rather than zero when no rates were given', () => {
        // Zero is a claim that this earns nothing; null is the absence of a claim.
        expect(shouldNudge({ plan: plan(500000), asOf: TODAY }).detail.projectedAnnualGain).toBe(null);
        expect(shouldNudge({ plan: plan(500000, { projectedAnnualGain: 41000 }), asOf: TODAY })
            .detail.projectedAnnualGain).toBe(41000);
    });

    it('NEVER returns an amount to record', () => {
        /* THE SAFETY PROPERTY. A swept rupee moves at a bank, by a person. If
         * this ever returned something a caller could book, a tapped button
         * could file a transfer nobody made — the exact defect
         * wealthflow-confirm.js exists to remove, rebuilt somewhere new.
         *
         * `placed` is a proposal and is named as one; there is no `amount`, no
         * action id and no intent anywhere in the result. */
        const r = shouldNudge({ plan: plan(500000), asOf: TODAY });
        const keys = Object.keys(r).concat(Object.keys(r.detail));
        expect(keys).not.toContain('amount');
        expect(keys).not.toContain('intent');
        expect(keys).not.toContain('action');
        expect(JSON.stringify(r)).not.toMatch(/yes_|not_yet/);
    });
});

describe('recording that it was shown', () => {
    it('stamps the day and the figure it was shown for', () => {
        const s = nudgeShown(null, plan(500000), TODAY);
        expect(s).toMatchObject({ lastRaisedOn: '2026-09-01', lastPlaced: 500000, raises: 1 });
    });

    it('counts up rather than overwriting, and keeps unrelated fields', () => {
        const s = nudgeShown({ raises: 4, note: 'kept' }, plan(900000), TODAY);
        expect(s.raises).toBe(5);
        expect(s.note).toBe('kept');
    });

    it('does not mutate the state it was handed', () => {
        // A decision path that mutated shared state could not be run twice.
        const before = { lastRaisedOn: '2026-01-01', lastPlaced: 1, raises: 1 };
        nudgeShown(before, plan(500000), TODAY);
        expect(before).toEqual({ lastRaisedOn: '2026-01-01', lastPlaced: 1, raises: 1 });
    });

    it('round-trips into shouldNudge as a cooldown', () => {
        /* The two halves have to agree about the shape of the state, and the
         * only honest way to check that is to feed one into the other. */
        const s = nudgeShown(null, plan(500000), TODAY);
        expect(shouldNudge({ plan: plan(500000), asOf: '2026-09-03', state: s }).reason)
            .toBe(NUDGE.COOLING_DOWN);
    });

    it('survives an unusable date without inventing one', () => {
        expect(nudgeShown(null, plan(500000), 'rubbish').lastRaisedOn).toBe(null);
    });
});
