/* =============================================================================
 * test/liquidity_test.js — pawned collateral, and money lent to people
 * -----------------------------------------------------------------------------
 * Two ledgers with the same shape of risk: an amount that changes with TIME or
 * with EVENTS, where getting the arithmetic quietly wrong costs real money.
 *
 *   A pawn ticket accrues interest per month and has a maturity date after
 *   which the broker can SELL the item. Under-reporting the interest tells the
 *   owner they owe less than the counter will ask for; missing the maturity
 *   warning loses the gold.
 *
 *   A debtor repays what they can when they can, and sometimes borrows more. A
 *   ledger that cannot survive a partial repayment, a top-up and a settlement
 *   is a ledger that will be wrong within a month of real use.
 *
 * And the rule that shapes both, in the owner's words: no balance moves without
 * a person confirming it. So OUTSTANDING is computed from confirmed events
 * only, and what it WOULD be is computed separately — the screen shows the
 * difference rather than hiding a logged repayment or acting on an unverified
 * one.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import L, {
    PAWN_STATE, DEBT_STATE, EVENT, MATURITY_WARN_DAYS,
    monthsElapsed, interestOn, pawnStatus, pawnTotals,
    debtorSummary, debtorTotals, pendingLiquidity, addEvent, confirmEvent, settleInFull,
} from '../wealthflow-liquidity.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const AT = (iso) => new Date(iso + 'T00:00:00Z');

const ticket = (over = {}) => ({
    id: 'p1', item: 'Gold chain', ticket: 'A-4471',
    principal: 250000, rate: 2.2, interestMode: 'simple',
    pawnDate: '2026-06-20', maturity: '2026-12-20', ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PAWNED ASSETS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('what a pawn ticket costs to redeem', () => {
    it('A PART MONTH IS A WHOLE MONTH, because that is how it is billed', () => {
        /* A calculator that reported 1.26 months would tell the owner they owe
         * less than the counter will ask for — which is the one direction a
         * money figure must never be wrong in. */
        expect(monthsElapsed('2026-06-20', AT('2026-06-20'))).toBe(0);
        expect(monthsElapsed('2026-06-20', AT('2026-06-21'))).toBe(1);
        expect(monthsElapsed('2026-06-20', AT('2026-07-20'))).toBe(1);
        expect(monthsElapsed('2026-06-20', AT('2026-07-28'))).toBe(2);
    });

    it('the exact fraction is available for anything that truly accrues daily', () => {
        const exact = monthsElapsed('2026-06-20', AT('2026-07-20'), { roundUp: false });
        expect(exact).toBeGreaterThan(0.9);
        expect(exact).toBeLessThan(1.1);
    });

    it('simple interest is on the amount advanced, not on the running total', () => {
        expect(interestOn(100000, 2, 3, 'simple')).toBeCloseTo(6000, 6);
    });

    it('compound interest is monthly, and is more', () => {
        const simple = interestOn(100000, 2, 12, 'simple');
        const comp = interestOn(100000, 2, 12, 'compound');
        expect(comp).toBeGreaterThan(simple);
        expect(comp).toBeCloseTo(100000 * (Math.pow(1.02, 12) - 1), 6);
    });

    it('nonsense inputs are zero, never NaN on a money line', () => {
        expect(interestOn(0, 2, 3)).toBe(0);
        expect(interestOn(100, 0, 3)).toBe(0);
        expect(interestOn(100, 2, 0)).toBe(0);
        expect(interestOn('x', 'y', 'z')).toBe(0);
    });

    it('an active ticket reports principal, interest and what is payable now', () => {
        const st = pawnStatus(ticket(), AT('2026-09-02'));
        expect(st.state).toBe(PAWN_STATE.ACTIVE);
        expect(st.months).toBe(3);
        expect(st.interest).toBeCloseTo(250000 * 0.022 * 3, 6);
        expect(st.payable).toBeCloseTo(250000 + st.interest, 6);
        expect(st.daysToMaturity).toBe(109);
    });

    it('IT WARNS BEFORE THE BROKER CAN SELL, not after', () => {
        /* The one date in this app where being late cannot be undone by paying
         * afterwards. */
        const soon = pawnStatus(ticket({ maturity: '2026-09-10' }), AT('2026-09-02'));
        expect(soon.warn).toBe(true);
        expect(soon.daysToMaturity).toBe(8);
        expect(MATURITY_WARN_DAYS).toBeGreaterThanOrEqual(7);

        const far = pawnStatus(ticket(), AT('2026-09-02'));
        expect(far.warn).toBe(false);
    });

    it('past its maturity it is OVERDUE', () => {
        const st = pawnStatus(ticket({ maturity: '2026-08-20' }), AT('2026-09-02'));
        expect(st.state).toBe(PAWN_STATE.OVERDUE);
    });

    it('A REDEEMED TICKET STOPS ACCRUING, and is never called overdue', () => {
        /* Interest stops on the day it was redeemed, not on the day somebody
         * got round to recording it — and reporting a finished ticket as
         * overdue is how a ledger loses trust in one glance. */
        const p = ticket({ maturity: '2026-07-20', redeemedAt: '2026-07-19' });
        const st = pawnStatus(p, AT('2026-12-31'));
        expect(st.state).toBe(PAWN_STATE.REDEEMED);
        expect(st.months).toBe(1);
        expect(st.warn).toBe(false);
        expect(st.interest).toBeCloseTo(250000 * 0.022 * 1, 6);
    });

    it('a ticket with no maturity date is active, not overdue', () => {
        const st = pawnStatus(ticket({ maturity: '' }), AT('2026-09-02'));
        expect(st.state).toBe(PAWN_STATE.ACTIVE);
        expect(st.daysToMaturity).toBe(null);
        expect(st.warn).toBe(false);
    });

    it('totals count only what is still pawned', () => {
        const t = pawnTotals([
            ticket(),
            ticket({ id: 'p2', principal: 100000, redeemedAt: '2026-07-01' }),
            ticket({ id: 'p3', principal: 50000, maturity: '2026-08-01' }),
        ], AT('2026-09-02'));
        expect(t.active).toBe(2);
        expect(t.principal).toBe(300000);
        expect(t.overdue).toBe(1);
        expect(t.payable).toBeGreaterThan(t.principal);
    });

    it('junk cannot throw on a page the owner opens', () => {
        expect(() => pawnStatus(null, AT('2026-09-02'))).not.toThrow();
        expect(() => pawnTotals(null, AT('2026-09-02'))).not.toThrow();
        expect(pawnStatus({}, AT('2026-09-02')).payable).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MONEY LENT TO PEOPLE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a debtor’s ledger', () => {
    const debtor = (events) => ({ id: 'd1', name: 'Nimal', events });

    const lent = { id: 'e1', kind: 'lent', amount: 200000, date: '2026-05-01', confirmed: true };
    const paid = { id: 'e2', kind: 'repayment', amount: 50000, date: '2026-06-05', confirmed: true };
    const top = { id: 'e3', kind: 'topup', amount: 75000, date: '2026-07-10', confirmed: true };

    it('a partial repayment reduces the outstanding principal', () => {
        const su = debtorSummary(debtor([lent, paid]), AT('2026-09-02'));
        expect(su.lent).toBe(200000);
        expect(su.repaid).toBe(50000);
        expect(su.outstanding).toBe(150000);
        expect(su.state).toBe(DEBT_STATE.OPEN);
    });

    it('a top-up raises it without erasing the history', () => {
        const su = debtorSummary(debtor([lent, paid, top]), AT('2026-09-02'));
        expect(su.outstanding).toBe(225000);
        expect(su.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    });

    it('AN UNCONFIRMED REPAYMENT CHANGES NOTHING — and says what it would', () => {
        /* The rule, on this screen. A repayment logged is a claim that money
         * reached the bank; until somebody says they saw it, the outstanding
         * balance must not move. Hiding it would be as wrong as acting on it. */
        const su = debtorSummary(debtor([lent, { id: 'e9', kind: 'repayment', amount: 60000, date: '2026-08-30', confirmed: false }]), AT('2026-09-02'));
        expect(su.outstanding).toBe(200000);
        expect(su.outstandingIfConfirmed).toBe(140000);
        expect(su.pending).toBe(1);
        expect(su.pendingRepaid).toBe(60000);
    });

    it('AN EVENT WITH NO FLAG COUNTS AS CONFIRMED', () => {
        /* Every event written before the field existed describes something
         * that already happened. Reading a missing flag as "unconfirmed" would
         * drop a person's whole lending history into a queue on upgrade. */
        const su = debtorSummary(debtor([{ id: 'e1', kind: 'lent', amount: 100, date: '2026-01-01' }]), AT('2026-09-02'));
        expect(su.lent).toBe(100);
        expect(su.pending).toBe(0);
    });

    it('repaid in full is CLOSED by arithmetic, not by a flag', () => {
        const su = debtorSummary(debtor([lent, { id: 'e2', kind: 'repayment', amount: 200000, date: '2026-06-05', confirmed: true }]), AT('2026-09-02'));
        expect(su.outstanding).toBe(0);
        expect(su.state).toBe(DEBT_STATE.CLOSED);
    });

    it('over-repayment does not produce a negative debt', () => {
        const su = debtorSummary(debtor([lent, { id: 'e2', kind: 'repayment', amount: 250000, date: '2026-06-05', confirmed: true }]), AT('2026-09-02'));
        expect(su.outstanding).toBe(0);
    });

    it('events sort by date, and an unknown kind is dropped rather than counted', () => {
        const su = debtorSummary(debtor([
            top, lent, { id: 'x', kind: 'nonsense', amount: 999999, date: '2026-01-01' }, { id: 'y', kind: 'lent', amount: 0, date: '2026-01-01' },
        ]), AT('2026-09-02'));
        expect(su.events.map((e) => e.id)).toEqual(['e1', 'e3']);
        expect(su.lent).toBe(275000);
    });

    it('a debtor with nothing recorded is OPEN, not settled', () => {
        /* A brand-new debtor has an outstanding of zero, and calling that
         * CLOSED would file them away before the first advance is entered. */
        expect(debtorSummary(debtor([]), AT('2026-09-02')).state).toBe(DEBT_STATE.OPEN);
    });

    it('totals count only what is still open', () => {
        const t = debtorTotals([
            debtor([lent, paid]),
            { id: 'd2', name: 'Settled', events: [{ id: 'a', kind: 'lent', amount: 100, date: '2026-01-01', confirmed: true }, { id: 'b', kind: 'repayment', amount: 100, date: '2026-02-01', confirmed: true }] },
        ], AT('2026-09-02'));
        expect(t.open).toBe(1);
        expect(t.outstanding).toBe(150000);
        expect(t.lent).toBe(200100);
    });
});

describe('writing to a debtor’s ledger', () => {
    const base = { id: 'd1', name: 'Nimal', events: [{ id: 'e1', kind: 'lent', amount: 100000, date: '2026-05-01', confirmed: true }] };

    it('adding an event returns a NEW record and leaves the old one alone', () => {
        const r = addEvent(base, { kind: 'repayment', amount: 25000, date: '2026-08-01', id: 'e2', now: 5 });
        expect(r.ok).toBe(true);
        expect(base.events.length).toBe(1);
        expect(r.debtor.events.length).toBe(2);
        expect(r.debtor.events[1].confirmed).toBe(false);
    });

    it('refuses what it cannot record, rather than writing a broken row', () => {
        expect(addEvent(base, { kind: 'gift', amount: 1, id: 'x' }).ok).toBe(false);
        expect(addEvent(base, { kind: 'repayment', amount: 0, id: 'x' }).ok).toBe(false);
        expect(addEvent(base, { kind: 'repayment', amount: 5 }).ok).toBe(false);
    });

    it('lending again to a settled debtor RE-OPENS them', () => {
        /* Borrowing again after paying off is the ordinary case here, and
         * leaving the record CLOSED would hide the new balance completely. */
        const closed = { ...base, closedAt: 123, state: 'CLOSED' };
        const r = addEvent(closed, { kind: 'topup', amount: 50000, date: '2026-09-01', id: 'e3', confirmed: true });
        expect(r.debtor.closedAt).toBeUndefined();
        expect(debtorSummary(r.debtor, AT('2026-09-02')).state).toBe(DEBT_STATE.OPEN);
    });

    it('confirming an event flips exactly one, and an unknown id changes nothing', () => {
        const withPending = addEvent(base, { kind: 'repayment', amount: 25000, date: '2026-08-01', id: 'e2' }).debtor;
        const ok = confirmEvent(withPending, 'e2', { now: 9 });
        expect(ok.ok).toBe(true);
        expect(ok.debtor.events[1].confirmed).toBe(true);
        expect(ok.debtor.events[0].confirmed).toBe(true);
        const miss = confirmEvent(withPending, 'nope');
        expect(miss.ok).toBe(false);
        expect(miss.debtor).toBe(withPending);
    });

    it('SETTLING WRITES THE FINAL PAYMENT, it does not just set a flag', () => {
        /* The timeline is the record. A debtor closed with no final payment in
         * their history is a debtor whose ledger does not add up. */
        const r = settleInFull(base, { date: '2026-09-02', id: 'e9', now: 1, confirmed: true });
        expect(r.ok).toBe(true);
        const last = r.debtor.events[r.debtor.events.length - 1];
        expect(last.amount).toBe(100000);
        expect(last.kind).toBe(EVENT.REPAYMENT);
        expect(debtorSummary(r.debtor, AT('2026-09-02')).outstanding).toBe(0);
    });

    it('settling when nothing is owed refuses instead of writing a zero row', () => {
        const paidOff = settleInFull(base, { date: '2026-09-02', id: 'e9', confirmed: true }).debtor;
        expect(settleInFull(paidOff, { date: '2026-09-03', id: 'e10' }).ok).toBe(false);
    });

    it('an unconfirmed settlement does not close the debtor', () => {
        const r = settleInFull(base, { date: '2026-09-02', id: 'e9', now: 1 });
        expect(r.debtor.closedAt).toBeUndefined();
        expect(debtorSummary(r.debtor, AT('2026-09-02')).outstanding).toBe(100000);
    });
});

describe('what reaches the confirmation queue', () => {
    it('every unconfirmed event, with the direction the money moves', () => {
        const A = { debtors: [{
            id: 'd1', name: 'Nimal', events: [
                { id: 'e1', kind: 'lent', amount: 100000, date: '2026-05-01', confirmed: true },
                { id: 'e2', kind: 'repayment', amount: 25000, date: '2026-08-01', confirmed: false },
                { id: 'e3', kind: 'topup', amount: 40000, date: '2026-08-20', confirmed: false },
            ],
        }] };
        const rows = pendingLiquidity(A, AT('2026-09-02'));
        expect(rows.map((r) => r.eventId)).toEqual(['e2', 'e3']);
        expect(rows[0].kind).toBe('inflow');
        expect(rows[1].kind).toBe('outflow');
        expect(rows[0].key).toBe('debtor:d1:e2');
        expect(rows.every((r) => r.source === 'debtor')).toBe(true);
    });

    it('nothing unconfirmed means nothing in the queue', () => {
        expect(pendingLiquidity({ debtors: [{ id: 'd', name: 'x', events: [{ id: 'e', kind: 'lent', amount: 5, date: '2026-01-01' }] }] }, AT('2026-09-02'))).toEqual([]);
        expect(pendingLiquidity(null, AT('2026-09-02'))).toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IT IS REACHABLE, AND IT IS WIRED
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the owner can actually get to it', () => {
    function fn(name) {
        const decl = new RegExp(`^[ \\t]*(?:async )?function ${name}\\s*\\(`, 'm');
        const m = decl.exec(HTML);
        if (!m) return '';
        const after = HTML.slice(m.index + m[0].length);
        const next = after.search(/^ {8}(?:async )?function \w+\s*\(/m);
        return next < 0 ? HTML.slice(m.index) : HTML.slice(m.index, m.index + m[0].length + next);
    }

    it('the module is loaded as a module', () => {
        expect(HTML).toContain('<script type="module" src="wealthflow-liquidity.js"></script>');
    });

    it('there is a page, a nav item, a title and a render binding', () => {
        /* Four separate places, and missing any ONE of them is a screen that
         * cannot be opened, cannot be found, has no heading, or never draws. */
        expect(HTML).toContain('id="page-liquidity"');
        expect(HTML).toContain("showPage('liquidity',this)");
        expect(HTML).toMatch(/liquidity: '<i data-wfi="gem"><\/i>/);
        expect(HTML).toContain('liquidity: renderLiquidity');
    });

    it('both ledgers are drawn, and the tabs switch between them', () => {
        const body = fn('renderLiquidity');
        expect(body).toContain('WFLiquidity');
        expect(body).toContain('pawnTotals');
        expect(body).toContain('debtorTotals');
        expect(fn('setLiquidityTab')).toContain('renderLiquidity()');
    });

    it('every action button is wired to something that exists', () => {
        const body = fn('renderLiquidity');
        for (const [attr, handler] of [
            ['data-liq-redeem', '_redeemPawn'],
            ['data-liq-pedit', 'openPawnModal'],
            ['data-liq-pdel', '_deletePawn'],
            ['data-liq-pay', 'openDebtorEvent'],
            ['data-liq-top', 'openDebtorEvent'],
            ['data-liq-settle', '_settleDebtor'],
            ['data-liq-ddel', '_deleteDebtor'],
        ]) {
            expect(body, `${attr} is drawn but nothing handles it`).toContain(attr);
            expect(body).toContain(handler + '(');
        }
    });

    it('A LOGGED REPAYMENT ARRIVES UNCONFIRMED, and money handed over does not', () => {
        /* The rule, at the two places that write. A repayment is a claim about
         * the bank; a further advance is something the owner just did, and
         * asking them to verify their own action is the ceremony this app
         * exists to remove. */
        const body = fn('openDebtorEvent');
        expect(body).toContain('confirmed: !isPay');
        expect(fn('openDebtorModal')).toContain('confirmed: true');
    });

    it('the queue confirms a debtor event through the module, not by hand', () => {
        const body = fn('_verifyConfirm');
        expect(body).toContain("row.source === 'debtor'");
        expect(body).toContain('window.WFLiquidity.confirmEvent(');
        /* And it is handled BEFORE the month-keyed maps, so a debtor event can
         * never fall through into incomeReceived. */
        expect(body.indexOf("row.source === 'debtor'")).toBeLessThan(body.indexOf("DB.set('incomeReceived'"));
    });

    it('a mistyped entry can be taken back', () => {
        /* Otherwise an unconfirmed repayment with a typo sits in the queue for
         * good: there is nothing else on any screen that can remove it. */
        expect(fn('_verifyFlagLate')).toContain('Remove this entry?');
    });

    it('the new ledgers merge per record across devices', () => {
        /* Arrays of records with ids belong in _WF_RECORD_KEYS, or a second
         * device overwrites the whole list instead of merging it. */
        const keys = /const _WF_RECORD_KEYS = \[([^\]]*)\]/.exec(HTML)[1];
        expect(keys).toContain("'pawns'");
        expect(keys).toContain("'debtors'");
    });

    it('and they are declared on appData, so they are hydrated at all', () => {
        const defaults = HTML.slice(HTML.indexOf('let appData = {'), HTML.indexOf('let isInitialised'));
        expect(defaults).toContain('pawns: []');
        expect(defaults).toContain('debtors: []');
    });

    it('nothing here writes to the balance', () => {
        /* The hub records what is owed and what is owing. Moving a balance
         * from a screen like this is exactly the blind automation the owner
         * ruled out. */
        for (const name of ['renderLiquidity', '_redeemPawn', '_settleDebtor', 'openDebtorEvent']) {
            expect(fn(name), `${name} writes to balance`).not.toMatch(/DB\.set\('balance'/);
        }
    });
});
