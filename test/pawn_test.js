/* =============================================================================
 * test/pawn_test.js — a pawn ticket, the way a pawn ticket actually behaves
 * -----------------------------------------------------------------------------
 * The owner described what really happens at a pawn broker, and the ledger
 * supported none of it: it could redeem a whole ticket or delete it, and that
 * was the entire vocabulary.
 *
 *   part payments   "අතේ තියෙන මුදලක් වගේ. ටිකෙන් ටික ගෙවනවා."
 *   renewals        a 3-month ticket extended to 12 AT THE 12-MONTH RATE,
 *                   which may be higher or lower than the 3-month one
 *   settlement      pay the lot and close it
 *
 * The arithmetic that follows is the part worth testing hard, because it is
 * silently wrong in the obvious implementation. Once part payments exist,
 * `principal × rate × months` overcharges every month after the first payment —
 * and it overcharges in the direction that makes the owner think they owe more
 * than they do, which is the direction that costs them money at the counter.
 *
 * Every figure below is worked out by hand in the comment beside it. A test
 * that only checks the code agrees with itself would have passed on the wrong
 * model just as happily.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    PAY, RATE_FROM, ON_INTEREST, PAWN_STATE,
    addMonths, parseDay, isoOf, termsOf, maturityOf, rateOn,
    schedule, pawnStatus, pawnTotals, effectiveAnnual, clearFirst,
    addPayment, updatePayment, removePayment, confirmPayment, unconfirmPayment,
    extendTerm, undoLastExtension, redeem, unredeem, pendingPawn,
} from '../wealthflow-pawn.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const AT = (iso) => new Date(iso + 'T00:00:00Z');

/** 200,000 at 2% a month, pawned 1 June 2026 for three months. */
const ticket = (over = {}) => ({
    id: 'p1', item: 'Gold chain', ticket: 'A-4471',
    principal: 200000, rate: 2, interestMode: 'simple',
    pawnDate: '2026-06-01', maturity: '2026-09-01', ...over,
});

const paid = (over = {}) => ({
    id: 'x1', kind: PAY.PART, amount: 50000, date: '2026-07-15', confirmed: true, ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CALENDAR
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the calendar a broker bills on', () => {
    it('a month later is CLAMPED to the end of the month', () => {
        /* Date.UTC(y, m + 1, 31) for the 31st of January is the 3rd of March.
         * A cycle built on that drifts and eventually skips a month. */
        expect(isoOf(addMonths(parseDay('2026-01-31'), 1))).toBe('2026-02-28');
        expect(isoOf(addMonths(parseDay('2028-01-31'), 1))).toBe('2028-02-29');
        expect(isoOf(addMonths(parseDay('2026-01-31'), 3))).toBe('2026-04-30');
        expect(isoOf(addMonths(parseDay('2026-06-01'), 12))).toBe('2027-06-01');
    });

    it('a ticket that has never been renewed keeps the maturity date it was given', () => {
        /* 20 June to 10 September is 2.69 months, which rounds to 3, which
         * would move the maturity to the 20th — ten days of "you still have
         * time" on the one date where being late loses the item. */
        expect(isoOf(maturityOf(ticket({ pawnDate: '2026-06-20', maturity: '2026-09-10' }))))
            .toBe('2026-09-10');
    });

    it('a ticket with no maturity date is open-ended, not overdue', () => {
        const open = ticket({ maturity: '' });
        expect(maturityOf(open)).toBe(null);
        expect(pawnStatus(open, AT('2030-01-01')).state).toBe(PAWN_STATE.ACTIVE);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PART PAYMENTS — the thing that was missing entirely
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('paying a bit at a time', () => {
    it('THE POINT OF ALL OF THIS: later months accrue on what is left, not on the advance', () => {
        /* By hand, 200,000 at 2%, pawned 01 June, looked at on 09 September.
         * 100 days is 3.28 months, billed as 4.
         *
         *   month 1 (01 Jun)  200,000 x 2%  =  4,000     due  4,000
         *   month 2 (01 Jul)  200,000 x 2%  =  4,000     due  8,000
         *   month 3 (01 Aug)  the 15 July payment lands first: 50,000 clears
         *                     the 8,000 interest, 42,000 comes off the advance
         *                     -> balance 158,000
         *                     158,000 x 2% =  3,160     due  3,160
         *   month 4 (01 Sep)  158,000 x 2% =  3,160     due  6,320
         *
         * payable = 158,000 + 6,320 = 164,320. The old model would have said
         * 200,000 x 2% x 4 = 16,000 of interest on an untouched 200,000. */
        const st = pawnStatus(ticket({ payments: [paid()] }), AT('2026-09-09'));
        expect(st.balance).toBe(158000);
        expect(st.interestDue).toBeCloseTo(6320, 6);
        expect(st.interestSettled).toBeCloseTo(8000, 6);
        expect(st.principalPaid).toBe(42000);
        expect(st.payable).toBeCloseTo(164320, 6);
        expect(st.cashPaid).toBe(50000);
    });

    it('INTEREST IS CLEARED BEFORE THE ADVANCE, which is how the counter applies it', () => {
        const st = pawnStatus(ticket({ payments: [paid({ amount: 5000 })] }), AT('2026-09-09'));
        /* 5,000 against 8,000 of interest: nothing reaches the advance. */
        expect(st.principalPaid).toBe(0);
        expect(st.balance).toBe(200000);
        expect(st.interestSettled).toBe(5000);
    });

    it('a payment marked "principal" goes straight off the advance', () => {
        const st = pawnStatus(ticket({ payments: [paid({ kind: PAY.PRINCIPAL, amount: 50000 })] }), AT('2026-09-09'));
        expect(st.balance).toBe(150000);
        expect(st.interestSettled).toBe(0);
    });

    it('an unconfirmed payment moves nothing, and says what it would', () => {
        /* The owner's standing rule, applied here as everywhere: no balance
         * moves until a person says it happened. */
        const t = ticket({ payments: [paid({ confirmed: false })] });
        const st = pawnStatus(t, AT('2026-09-09'));
        expect(st.balance).toBe(200000);
        expect(st.payable).toBeCloseTo(216000, 6);
        expect(st.pending).toBe(1);
        expect(st.payableIfConfirmed).toBeCloseTo(164320, 6);
    });

    it('a payment with no flag at all counts as confirmed', () => {
        /* Every payment written before the flag existed describes money that
         * already changed hands. */
        const t = ticket({ payments: [{ id: 'x', kind: PAY.PART, amount: 50000, date: '2026-07-15' }] });
        expect(pawnStatus(t, AT('2026-09-09')).balance).toBe(158000);
    });

    it('paying more than is owed is recorded as credit, not as a negative debt', () => {
        const st = pawnStatus(ticket({ payments: [paid({ amount: 500000 })] }), AT('2026-09-09'));
        expect(st.balance).toBe(0);
        expect(st.payable).toBe(0);
        expect(st.credit).toBeGreaterThan(0);
    });

    it('compound interest compounds on the interest that has not been paid', () => {
        const simple = pawnStatus(ticket(), AT('2026-09-09')).payable;
        const comp = pawnStatus(ticket({ interestMode: 'compound' }), AT('2026-09-09')).payable;
        expect(comp).toBeGreaterThan(simple);
        /* 200,000 x 1.02^4 = 216,486.43 */
        expect(comp).toBeCloseTo(200000 * Math.pow(1.02, 4), 2);
    });

    it('a payment dated in the future is held, not applied', () => {
        const st = pawnStatus(ticket({ payments: [paid({ date: '2027-01-01' })] }), AT('2026-09-09'));
        expect(st.balance).toBe(200000);
        expect(st.payments.length).toBe(1);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RENEWAL — three months to twelve, at the twelve-month rate
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('extending a ticket past its maturity', () => {
    const base = ticket({ payments: [paid()] });

    it('THE OWNER’S CASE: extended to 12 months at the 12-month rate, from the start', () => {
        const r = extendTerm(base, {
            toMonths: 12, rate: 1.5, rateFrom: RATE_FROM.START,
            onInterest: ON_INTEREST.CARRY, date: '2026-09-01', id: 'e1',
        });
        expect(r.ok).toBe(true);
        expect(r.totalMonths).toBe(12);
        expect(r.pawn.maturity).toBe('2027-06-01');

        /* Re-priced from the pawn date, so every month runs at 1.5%:
         *   m1 200,000 x 1.5% = 3,000            due 3,000
         *   m2 200,000 x 1.5% = 3,000            due 6,000
         *   m3 payment clears 6,000, 44,000 off  balance 156,000
         *      156,000 x 1.5% = 2,340            due 2,340
         *   m4 156,000 x 1.5% = 2,340            due 4,680
         * payable 160,680 — and it is ACTIVE again, not overdue. */
        const st = pawnStatus(r.pawn, AT('2026-09-09'));
        expect(st.rate).toBe(1.5);
        expect(st.balance).toBe(156000);
        expect(st.payable).toBeCloseTo(160680, 6);
        expect(st.state).toBe(PAWN_STATE.ACTIVE);
        expect(st.daysToMaturity).toBe(265);
    });

    it('THE OTHER READING: the months already run keep the rate they were agreed at', () => {
        /* Brokers do both, so the app asks rather than guessing. Here the first
         * three months stay at 2% and only the extension runs at 1.5%, which
         * costs MORE than re-pricing the whole ticket downward. */
        const r = extendTerm(base, {
            toMonths: 12, rate: 1.5, rateFrom: RATE_FROM.RENEWAL,
            onInterest: ON_INTEREST.CARRY, date: '2026-09-01', id: 'e2',
        });
        expect(r.pawn.terms.length).toBe(2);
        const st = pawnStatus(r.pawn, AT('2026-09-09'));
        expect(st.payable).toBeGreaterThan(160680);
        /* Month 4 begins on the renewal date, so it is the first at the new rate. */
        expect(st.rate).toBe(1.5);
        expect(rateOn(termsOf(r.pawn), '2026-07-01')).toBe(2);
        expect(r.pawn.maturity).toBe('2027-06-01');
    });

    it('the interest standing at the renewal can be PAID, and waits for confirmation like any cash', () => {
        const r = extendTerm(base, {
            toMonths: 12, rate: 1.5, rateFrom: RATE_FROM.START,
            onInterest: ON_INTEREST.PAID, date: '2026-09-01', id: 'e3',
        });
        expect(r.payment).toBeTruthy();
        expect(r.payment.kind).toBe(PAY.INTEREST);
        expect(r.payment.confirmed).toBe(false);
        const st = pawnStatus(r.pawn, AT('2026-09-09'));
        expect(st.pending).toBe(1);
        expect(st.payableIfConfirmed).toBeLessThan(st.payable);
    });

    it('or ROLLED INTO THE ADVANCE, where it starts earning interest itself', () => {
        const r = extendTerm(base, {
            toMonths: 12, rate: 1.5, rateFrom: RATE_FROM.START,
            onInterest: ON_INTEREST.CAPITALISE, date: '2026-09-01', id: 'e4',
        });
        /* At the renewal 2,340 of interest is standing; it moves onto the
         * advance, so the balance becomes 156,000 + 2,340 = 158,340 and month
         * four accrues on THAT. Capitalising is a term of the renewal, not a
         * payment somebody has to confirm having made. */
        const st = pawnStatus(r.pawn, AT('2026-09-09'));
        expect(st.balance).toBeCloseTo(158340, 6);
        expect(st.capitalised).toBeCloseTo(2340, 6);
        /* No cash changed hands at the renewal — the only money on this ticket
         * is still the 50,000 part payment from July. */
        expect(st.cashPaid).toBe(50000);
        expect(st.pending).toBe(0);
    });

    it('THE PRINCIPAL FIELD IS NEVER EDITED, because that would re-price the past', () => {
        const r = extendTerm(base, {
            toMonths: 12, rate: 1.5, onInterest: ON_INTEREST.CAPITALISE, date: '2026-09-01', id: 'e5',
        });
        expect(r.pawn.principal).toBe(200000);
        /* The months already billed are unchanged by the capitalisation. */
        const before = schedule(base, AT('2026-08-01'));
        const after = schedule(r.pawn, AT('2026-08-01'));
        expect(after.months.length).toBe(before.months.length);
    });

    it('refuses an extension that is not actually longer', () => {
        expect(extendTerm(base, { toMonths: 3, rate: 1.5, id: 'e6' }).ok).toBe(false);
        expect(extendTerm(base, { toMonths: 12, rate: 1.5 }).ok).toBe(false);          // no id
        expect(extendTerm({ ...base, redeemedAt: '2026-08-01' }, { toMonths: 12, rate: 1, id: 'e7' }).ok).toBe(false);
    });

    it('"add nine months" and "make it twelve" are the same instruction', () => {
        const a = extendTerm(base, { toMonths: 12, rate: 1.5, date: '2026-09-01', id: 'a' });
        const b = extendTerm(base, { addMonths: 9, rate: 1.5, date: '2026-09-01', id: 'b' });
        expect(b.totalMonths).toBe(a.totalMonths);
        expect(b.pawn.maturity).toBe(a.pawn.maturity);
    });

    it('AND IT CAN BE UNDONE, including whatever it wrote', () => {
        const r = extendTerm(base, {
            toMonths: 12, rate: 1.5, rateFrom: RATE_FROM.RENEWAL,
            onInterest: ON_INTEREST.PAID, date: '2026-09-01', id: 'e8',
        });
        expect(r.pawn.payments.length).toBe(2);
        const u = undoLastExtension(r.pawn);
        expect(u.ok).toBe(true);
        expect(u.pawn.terms.length).toBe(1);
        expect(u.pawn.payments.length).toBe(1);          // the renewal's interest row is gone
        expect(u.pawn.rate).toBe(2);
        expect(undoLastExtension(base).ok).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CLOSING IT, AND CHANGING YOUR MIND
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('redeeming, and every undo that did not exist', () => {
    it('redeeming writes the closing payment, it does not only set a flag', () => {
        const r = redeem(ticket({ payments: [paid()] }), { date: '2026-09-09', id: 'r1' });
        expect(r.ok).toBe(true);
        expect(r.paid).toBeCloseTo(164320, 6);
        expect(r.pawn.redeemedAt).toBe('2026-09-09');
        expect(r.pawn.payments.some((p) => p.kind === PAY.REDEEM)).toBe(true);
    });

    it('a redeemed ticket stops accruing and is never called overdue', () => {
        const r = redeem(ticket(), { date: '2026-08-01', id: 'r2' });
        const st = pawnStatus(r.pawn, AT('2030-01-01'));
        expect(st.state).toBe(PAWN_STATE.REDEEMED);
        expect(st.months).toBe(2);
        expect(st.perMonth).toBe(0);
    });

    it('UNDO A REDEMPTION — pressing the wrong button was permanent', () => {
        const r = redeem(ticket(), { date: '2026-08-01', id: 'r3' });
        const u = unredeem(r.pawn);
        expect(u.ok).toBe(true);
        expect(u.pawn.redeemedAt).toBeUndefined();
        expect(u.pawn.payments.length).toBe(0);
        expect(pawnStatus(u.pawn, AT('2026-09-09')).state).toBe(PAWN_STATE.OVERDUE);
        expect(unredeem(ticket()).ok).toBe(false);
    });

    it('UNDO A PAYMENT, and edit one', () => {
        const a = addPayment(ticket(), { kind: PAY.PART, amount: 50000, date: '2026-07-15', id: 'q1', confirmed: true });
        expect(a.ok).toBe(true);
        expect(pawnStatus(a.pawn, AT('2026-09-09')).balance).toBe(158000);

        const e = updatePayment(a.pawn, 'q1', { amount: 20000 });
        expect(e.ok).toBe(true);
        expect(pawnStatus(e.pawn, AT('2026-09-09')).principalPaid).toBe(12000);

        const d = removePayment(e.pawn, 'q1');
        expect(d.ok).toBe(true);
        expect(pawnStatus(d.pawn, AT('2026-09-09')).balance).toBe(200000);
        expect(removePayment(d.pawn, 'nope').ok).toBe(false);
    });

    it('UNDO A CONFIRMATION', () => {
        const a = addPayment(ticket(), { kind: PAY.PART, amount: 50000, date: '2026-07-15', id: 'q2' });
        expect(pawnStatus(a.pawn, AT('2026-09-09')).pending).toBe(1);
        const c = confirmPayment(a.pawn, 'q2', { now: 1 });
        expect(pawnStatus(c.pawn, AT('2026-09-09')).pending).toBe(0);
        const u = unconfirmPayment(c.pawn, 'q2');
        expect(u.ok).toBe(true);
        expect(pawnStatus(u.pawn, AT('2026-09-09')).pending).toBe(1);
        expect(u.pawn.payments[0].confirmedAt).toBeUndefined();
    });

    it('every write returns a NEW record and leaves the old one alone', () => {
        const t = ticket();
        const frozen = JSON.stringify(t);
        addPayment(t, { kind: PAY.PART, amount: 1, date: '2026-07-01', id: 'z' });
        extendTerm(t, { toMonths: 12, rate: 1, id: 'z2' });
        redeem(t, { date: '2026-08-01', id: 'z3' });
        expect(JSON.stringify(t)).toBe(frozen);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT COSTS TO HOLD, AND WHICH ONE TO CLEAR
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the numbers that decide something', () => {
    it('what it costs per month and per day, on what is actually owed', () => {
        const st = pawnStatus(ticket({ payments: [paid()] }), AT('2026-09-09'));
        expect(st.perMonth).toBeCloseTo(158000 * 0.02, 6);
        expect(st.perDay).toBeCloseTo(st.perMonth / 30.4375, 6);
    });

    it('the rate stated the way a rate can be compared: per year', () => {
        expect(effectiveAnnual(2)).toBe(24);
        expect(effectiveAnnual(2, 'compound')).toBeCloseTo((Math.pow(1.02, 12) - 1) * 100, 6);
        expect(effectiveAnnual(0)).toBe(0);
    });

    it('WHETHER THE GOLD IS STILL WORTH GETTING BACK', () => {
        /* The moment worth knowing about and the one nobody asks for: when
         * redeeming costs more than the item is worth, the arithmetic says let
         * it go, and until then it does not. */
        const under = pawnStatus(ticket({ value: 150000 }), AT('2026-09-09'));
        expect(under.underwater).toBe(true);
        expect(under.ltv).toBeGreaterThan(1);
        const fine = pawnStatus(ticket({ value: 400000 }), AT('2026-09-09'));
        expect(fine.underwater).toBe(false);
        expect(fine.headroom).toBeCloseTo(400000 - fine.payable, 6);
        /* No valuation, no opinion. A guessed one is worse than none. */
        expect(pawnStatus(ticket(), AT('2026-09-09')).ltv).toBe(null);
    });

    it('WHICH TICKET TO CLEAR WITH THE CASH IN HAND', () => {
        const chain = ticket();                                     // 2%, overdue
        const bangle = ticket({ id: 'p2', item: 'Bangle', principal: 50000, rate: 3, maturity: '2027-01-01' });
        const out = clearFirst([chain, bangle], 100000, AT('2026-09-09'));
        /* The overdue one first: past maturity the broker may sell it, and that
         * is the only loss here money cannot reverse afterwards. */
        expect(out.rows[0].item).toBe('Gold chain');
        expect(out.rows[0].reason).toContain('past maturity');
        expect(out.rows[0].affordable).toBe(false);                 // 216,000 > 100,000
        expect(out.rows[1].affordable).toBe(true);
    });

    it('and with nothing overdue it ranks by what each rupee stops costing', () => {
        const cheap = ticket({ id: 'a', item: 'Cheap', rate: 1, maturity: '2027-06-01' });
        const dear = ticket({ id: 'b', item: 'Dear', rate: 3, maturity: '2027-06-01' });
        const out = clearFirst([cheap, dear], 0, AT('2026-09-09'));
        expect(out.rows[0].item).toBe('Dear');
    });

    it('totals count what is still pawned, and what is at risk', () => {
        const t = pawnTotals([ticket(), redeem(ticket({ id: 'p9' }), { date: '2026-08-01', id: 'r' }).pawn], AT('2026-09-09'));
        expect(t.active).toBe(1);
        expect(t.overdue).toBe(1);
        expect(t.payable).toBeCloseTo(216000, 6);
        expect(t.perMonth).toBeCloseTo(4000, 6);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IT CANNOT THROW ON A PAGE THE OWNER OPENS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('junk in, no crash out', () => {
    it('every entry point survives nonsense', () => {
        for (const bad of [null, undefined, {}, { principal: 'x' }, { payments: 'no' }, { terms: 7 }]) {
            expect(() => pawnStatus(bad, AT('2026-09-09'))).not.toThrow();
            expect(() => schedule(bad, AT('2026-09-09'))).not.toThrow();
            expect(() => termsOf(bad)).not.toThrow();
            expect(() => clearFirst([bad], 1, AT('2026-09-09'))).not.toThrow();
            expect(() => pendingPawn([bad], AT('2026-09-09'))).not.toThrow();
        }
        expect(() => pawnTotals(null, null)).not.toThrow();
    });

    it('no money line is ever NaN, whatever is in the record', () => {
        fc.assert(fc.property(
            fc.record({
                principal: fc.oneof(fc.integer({ min: -1e6, max: 1e7 }), fc.constant('x'), fc.constant(null)),
                rate: fc.oneof(fc.float({ min: -5, max: 20, noNaN: true }), fc.constant('')),
                pawnDate: fc.constantFrom('2026-06-01', '', 'nonsense', '2026-13-45'),
                maturity: fc.constantFrom('2026-09-01', '', '2020-01-01'),
                interestMode: fc.constantFrom('simple', 'compound', ''),
            }),
            (p) => {
                const st = pawnStatus(p, AT('2026-09-09'));
                for (const k of ['principal', 'interest', 'payable', 'balance', 'perMonth', 'perDay']) {
                    expect(Number.isFinite(st[k]), k + ' was ' + st[k]).toBe(true);
                }
                expect(st.payable).toBeGreaterThanOrEqual(0);
            },
        ), { numRuns: runs(300) });
    });

    it('a ticket cannot be walked forever by a far-future date', () => {
        /* Fifty years of monthly billing is a corrupt date, not a ticket. The
         * walk stops rather than freezing the page the owner opened. */
        const st = pawnStatus(ticket({ maturity: '' }), AT('2400-01-01'));
        expect(st.months).toBe(600);
        expect(Number.isFinite(st.payable)).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE OWNER CAN REACH IT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('wired to the page', () => {
    it('the engine is loaded as a module, before the ledger that re-exports it', () => {
        expect(HTML).toContain('<script type="module" src="wealthflow-pawn.js"></script>');
        expect(HTML.indexOf('<script type="module" src="wealthflow-pawn.js">'))
            .toBeLessThan(HTML.indexOf('<script type="module" src="wealthflow-liquidity.js">'));
    });

    it('every new action has a handler that exists', () => {
        for (const fn of ['_pawnPay', '_pawnExtend', '_pawnUndo', '_pawnHistory']) {
            expect(HTML, fn + ' is called but never defined').toContain('function ' + fn);
        }
    });

    it('unconfirmed pawn payments reach the same queue as everything else', () => {
        const t = ticket({ payments: [paid({ confirmed: false })] });
        const rows = pendingPawn([t], AT('2026-09-09'));
        expect(rows.length).toBe(1);
        expect(rows[0].source).toBe('pawn');
        expect(rows[0].kind).toBe('outflow');
        expect(rows[0].amount).toBe(50000);
    });
});
