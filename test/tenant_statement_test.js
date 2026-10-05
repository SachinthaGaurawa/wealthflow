/* =============================================================================
 * test/tenant_statement_test.js — what a tenant is shown, and what they are never shown
 * -----------------------------------------------------------------------------
 * The owner's document holds every private opinion of every person. The statement is built
 * by picking named figures, so the assertions are WHITELISTS: a field that is not on the
 * list below fails the test, whoever adds it and however innocently.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { buildStatement, recordsFor, MAX_RECORDS } from '../tenant-statement.mjs';
import { nicHashOf, phoneHashOf } from '../tenant-links.mjs';
import { normalizeNic } from '../wealthflow-nic.js';
import { SECRET, NIC, CANON, PHONE, T0, lenderDoc } from './helpers/tenant-fixture.js';

const nicHash = nicHashOf(CANON, SECRET);
const phoneHash = phoneHashOf('+94771234567', SECRET);
const build = (user, over = {}) => buildStatement({ ledgers: [{ uid: 'u', user, own: true }], nicHash, phoneHash, secret: SECRET, now: T0, ...over });

const INVESTMENT_KEYS = ['kind', 'ref', 'title', 'capital', 'ratePct', 'frequency', 'interestPerPeriod', 'start', 'end', 'payments', 'totalReceived', 'currency'];
const LOAN_KEYS = ['kind', 'ref', 'title', 'lent', 'repaid', 'outstanding', 'status', 'events', 'currency'];

describe('what is on it', () => {
    it('shows an investment and a loan, by whitelist, under generic titles and a reference code', () => {
        const st = build(lenderDoc());
        const [inv, loan] = st.groups;
        expect(Object.keys(inv).sort()).toEqual([...INVESTMENT_KEYS].sort());
        expect(Object.keys(loan).sort()).toEqual([...LOAN_KEYS].sort());
        expect(inv).toMatchObject({ kind: 'investment', title: 'Investment', capital: 500000, ratePct: 24, frequency: 'monthly', interestPerPeriod: 10000, currency: 'LKR' });
        expect(inv.ref).toMatch(/^INV-[0-9A-F]{6}$/);
        expect(loan).toMatchObject({ kind: 'loan', title: 'Loan', lent: 50000, repaid: 20000, outstanding: 30000, status: 'open' });
        expect(loan.ref).toMatch(/^DEB-[0-9A-F]{6}$/);
        expect(Object.keys(st).sort()).toEqual(['asOf', 'groups', 'totals', 'truncated']);
        expect(st.totals).toEqual([{ currency: 'LKR', invested: 500000, interestReceived: 10000, loanOutstanding: 30000 }]);
    });

    it('a loan has no interest on it: not zero, not hidden, not a field at all', () => {
        const user = lenderDoc();
        user.debtors[0].rate = 36; user.debtors[0].interest = 99; user.debtors[0].monthly = 5;
        const loan = build(user).groups.find((g) => g.kind === 'loan');
        expect(JSON.stringify(loan)).not.toMatch(/interest|rate|monthly|accru/i);
        expect(loan.events.every((e) => Object.keys(e).sort().join() === 'amount,balance,date,kind')).toBe(true);
    });

    it('carries no name, note, phone, NIC, company or record id from either kind of record', () => {
        const text = JSON.stringify(build(lenderDoc()));
        for (const leak of ['PRIVATE', 'Fixed deposit', NIC, CANON, '0771234567', '077 123 4567', '94771234567', 'inv1', 'deb1', 'e1', 'e2']) expect(text, leak).not.toContain(leak);
    });

    it('shows only what the owner confirmed: a repayment nobody verified is not on the statement, nor in the balance', () => {
        const loan = build(lenderDoc()).groups.find((g) => g.kind === 'loan');
        expect(loan.events.map((e) => [e.kind, e.amount, e.balance])).toEqual([['lent', 50000, 50000], ['repayment', 20000, 30000]]);
        expect(JSON.stringify(loan)).not.toContain('777');
    });

    it('lists payments the owner confirmed, not the bookkeeping marks for months before the tenant joined', () => {
        const user = lenderDoc({
            incomeReceived: {
                'inv1_2026-08': { amount: 10000, confirmedAt: T0 - 40 * 86400e3 },
                'inv1_2026-07': { amount: 10000, confirmedAt: T0 - 70 * 86400e3, auto: true },
                'inv1_2026-06': { amount: 10000, confirmedAt: T0 - 90 * 86400e3, historical: true },
                'inv1_2026-09': { amount: 10000 },                                           // never confirmed
                'inv1_2026-10': { confirmedAt: T0 - 1000 },                                  // amount defaults to the period's interest
                'inv2_2026-08': { amount: 99, confirmedAt: T0 },                              // someone else's record
                'inv1_notamonth': { amount: 5, confirmedAt: T0 },
            },
        });
        const inv = build(user).groups[0];
        expect(inv.payments.map((p) => [p.month, p.amount])).toEqual([['2026-08', 10000], ['2026-10', 10000]]);
        expect(inv.totalReceived).toBe(20000);
        expect(inv.payments[0].date).toBe('2026-08-26');
    });

    it('is the same arithmetic the text messages use for a closed or settled loan', () => {
        const user = lenderDoc();
        user.debtors[0].events.push({ id: 'e4', kind: 'repayment', amount: 30000, date: '2026-09-25', confirmed: true });
        expect(build(user).groups.find((g) => g.kind === 'loan')).toMatchObject({ outstanding: 0, status: 'settled' });
        const closed = lenderDoc(); closed.debtors[0].closedAt = 5;
        expect(build(closed).groups.find((g) => g.kind === 'loan')).toMatchObject({ outstanding: 30000, status: 'closed' });
    });

    it('keeps currencies apart and totals each of them', () => {
        const usd = lenderDoc(); usd.settings.currency = 'usd';
        const st = buildStatement({ ledgers: [{ uid: 'a', user: lenderDoc(), own: true }, { uid: 'b', user: usd, own: true }], nicHash, phoneHash, secret: SECRET, now: T0 });
        expect(st.totals.map((t) => t.currency).sort()).toEqual(['LKR', 'USD']);
        expect(st.totals.every((t) => t.loanOutstanding === 30000 && t.invested === 500000)).toBe(true);
    });
});

describe('which records', () => {
    const rec = (over) => ({ id: 'r', nic: NIC, phone: PHONE, sms_notifications_enabled: true, ...over });

    it('only those switched on, and only those under this NIC, in either shape', () => {
        const user = { income: [rec({ id: 'on' }), rec({ id: 'off', sms_notifications_enabled: false }), rec({ id: 'str', sms_notifications_enabled: 'true' }), rec({ id: 'other', nic: '198534000999' }), rec({ id: 'none', nic: '' }), rec({ id: 'new', nic: '198534000937' }), { ...rec({}), id: '' }], debtors: [] };
        expect(recordsFor(user, { nicHash, phoneHash, secret: SECRET, own: true }).investments.map((r) => r.id)).toEqual(['on', 'new']);
    });

    it('for another lender, also the phone the code went to', () => {
        const user = { income: [], debtors: [rec({ id: 'same' }), rec({ id: 'diff', phone: '0719999999' }), rec({ id: 'nophone', phone: '' })] };
        expect(recordsFor(user, { nicHash, phoneHash, secret: SECRET, own: false }).debtors.map((r) => r.id)).toEqual(['same']);
        expect(recordsFor(user, { nicHash, phoneHash: '', secret: SECRET, own: false }).debtors).toEqual([]);          // no verified phone, nothing from anyone else
        expect(recordsFor(user, { nicHash, phoneHash, secret: SECRET, own: true }).debtors).toHaveLength(3);
    });

    it('survives a document that is not what it should be', () => {
        for (const user of [null, undefined, {}, { income: 'x', debtors: 5 }, { income: [null, 1, 'a', {}], debtors: [null, {}], incomeReceived: 7, settings: null }]) {
            expect(() => build(user)).not.toThrow();
            expect(build(user).groups).toEqual([]);
        }
        const odd = lenderDoc({ incomeReceived: null });
        odd.income[0].amount = 'lots'; odd.income[0].rate = NaN; odd.income[0].freq = '<img onerror=x>';
        const inv = build(odd).groups[0];
        expect(inv.capital).toBe(0);
        expect(inv.frequency).toBe('monthly');
    });

    it('is cut at a sane size and says so', () => {
        const income = Array.from({ length: MAX_RECORDS + 50 }, (_, i) => ({ id: `i${i}`, nic: NIC, phone: PHONE, amount: 1, rate: 1, start: '2026-01-01', sms_notifications_enabled: true }));
        const st = build({ income, debtors: [] });
        expect(st.groups).toHaveLength(MAX_RECORDS);
        expect(st.truncated).toBe(true);
    });

    it('lists the same records in the same order every time', () => {
        const a = build(lenderDoc());
        const b = build(lenderDoc());
        expect(a).toEqual(b);
        expect(a.groups.map((g) => g.kind)).toEqual(['investment', 'loan']);
        void normalizeNic;
    });
});
