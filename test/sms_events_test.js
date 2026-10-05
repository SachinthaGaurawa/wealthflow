/* =============================================================================
 * test/sms_events_test.js — which messages the books owe
 * -----------------------------------------------------------------------------
 * The derivation is the whole "nothing omitted, nothing repeated" argument, so it is
 * tested as a function of the books and the clock alone: history is not news,
 * unconfirmed money is not news, Layer B never computes interest, cadences are the
 * ones the verification queue uses, and a bad phone is reported rather than skipped
 * in silence.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { deriveEvents, nextSendWindow, periodInterest, interestApplies, hasSmsRecords, GRACE_MS, MAX_AGE_MS, FIELDS, LAYER } from '../sms-events.mjs';
import { KINDS } from '../sms-templates.mjs';

const T = (iso) => Date.parse(iso);
const DAY = 86400000;

function investment(over = {}) {
    return {
        id: 'inv1', name: 'Bond', company: 'Acme', amount: 500000, rate: 24, freq: 'monthly', monthly: 10000,
        start: '2026-04-15', day: '2026-04-15', createdAt: '2026-04-15T04:00:00.000Z',
        phone: '077 123 4567', nic: '853400937V',
        [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: T('2026-10-04T10:00:00Z'),
        ...over,
    };
}
function debtor(over = {}) {
    return {
        id: 'd1', name: 'Nimal', phone: '0771234567', nic: '198534000937',
        [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: T('2026-10-01T00:00:00Z'),
        events: [], ...over,
    };
}
const kinds = (r) => r.events.map((e) => `${e.kind}:${e.key}`);

describe('the switch', () => {
    it('a record with the toggle off owes nothing, however much has happened', () => {
        const user = { income: [investment({ [FIELDS.ENABLED]: false })], debtors: [debtor({ [FIELDS.ENABLED]: false, events: [{ id: 'e1', kind: 'lent', amount: 100, date: '2026-10-01', confirmed: true, at: T('2026-10-01T01:00:00Z') }] })] };
        const r = deriveEvents(user, T('2026-10-15T10:00:00Z'));
        expect(r.events).toEqual([]);
        expect(r.issues).toEqual([]);
        expect(hasSmsRecords(user)).toBe(false);
    });

    it('a record switched on with no timestamp is reported, not guessed at', () => {
        const r = deriveEvents({ income: [investment({ [FIELDS.ENABLED_AT]: undefined })] }, T('2026-10-15T10:00:00Z'));
        expect(r.events).toEqual([]);
        expect(r.issues).toEqual([{ recordKind: 'investment', recordId: 'inv1', reason: 'no-enable-stamp' }]);
    });

    it('a "switched on at" from the future (a phone with the wrong date) is reported, not honoured', () => {
        const now = T('2026-10-15T10:00:00Z');
        const r = deriveEvents({ income: [investment({ [FIELDS.ENABLED_AT]: now + 3 * 86400000 })], debtors: [debtor({ [FIELDS.ENABLED_AT]: now + 3 * 86400000 })] }, now);
        expect(r.events).toEqual([]);
        expect(r.issues.map((i) => i.reason)).toEqual(['future-enable-stamp', 'future-enable-stamp']);
        // a few minutes of drift is ordinary and is let through
        expect(deriveEvents({ income: [investment({ [FIELDS.ENABLED_AT]: now + 2 * 60000 })] }, now).issues).toEqual([]);
    });

    it('hasSmsRecords sees either layer', () => {
        expect(hasSmsRecords({ income: [investment()] })).toBe(true);
        expect(hasSmsRecords({ debtors: [debtor()] })).toBe(true);
        expect(hasSmsRecords({})).toBe(false);
        expect(hasSmsRecords(null)).toBe(false);
    });
});

describe('LAYER A: the Investments tab', () => {
    it('capital recorded: a record created and switched on together is announced', () => {
        const created = T('2026-10-05T09:58:00Z');
        const r = deriveEvents({ income: [investment({ start: '2026-10-05', day: '2026-10-05', createdAt: new Date(created).toISOString(), [FIELDS.ENABLED_AT]: created + 2000 })] }, T('2026-10-05T10:00:00Z'));
        expect(r.events).toHaveLength(1);
        expect(r.events[0]).toMatchObject({ key: 'A:inv1:created', kind: KINDS.A_CAPITAL, layer: LAYER.A, amount: 500000, ratePct: 24, currency: 'LKR', phone: '+94771234567', scheduled: false });
    });

    it('capital recorded: switching the toggle on for an old record does not re-announce its origin', () => {
        const r = deriveEvents({ income: [investment({ createdAt: '2026-04-15T04:00:00.000Z' })] }, T('2026-10-05T10:00:00Z'));
        expect(kinds(r).filter((k) => k.startsWith(KINDS.A_CAPITAL))).toEqual([]);
    });

    it('interest: history before the toggle is the past, not news', () => {
        const r = deriveEvents({ income: [investment()] }, T('2026-10-05T10:00:00Z'));
        expect(r.events.filter((e) => e.kind === KINDS.A_INTEREST)).toEqual([]);   // Jul 15, Aug 15, Sep 15 all pre-date the toggle (Oct 4)
    });

    it('interest: the due day arrives and the notice is derived, scheduled, held to the 08:00-20:00 window', () => {
        const r = deriveEvents({ income: [investment()] }, T('2026-10-15T10:00:00Z'));
        const i = r.events.filter((e) => e.kind === KINDS.A_INTEREST);
        expect(i).toHaveLength(1);
        expect(i[0]).toMatchObject({ key: 'A:inv1:int:2026-10', amount: 10000, month: '2026-10', scheduled: true, dateISO: '2026-10-15' });
        expect(i[0].notBefore).toBe(T('2026-10-15T02:30:00Z'));         // 08:00 in Colombo
    });

    it('interest: not announced before its day', () => {
        const r = deriveEvents({ income: [investment()] }, T('2026-10-14T23:59:00Z'));
        expect(r.events.some((e) => e.kind === KINDS.A_INTEREST)).toBe(false);
    });

    it('interest: switching the toggle on during the due day still tells them', () => {
        const r = deriveEvents({ income: [investment({ [FIELDS.ENABLED_AT]: T('2026-10-15T09:00:00Z') })] }, T('2026-10-15T10:00:00Z'));
        expect(r.events.filter((e) => e.kind === KINDS.A_INTEREST)).toHaveLength(1);
    });

    it('interest: one notice per period, never two for the same month, whatever the lookback', () => {
        const r = deriveEvents({ income: [investment({ [FIELDS.ENABLED_AT]: T('2026-06-01T00:00:00Z') })] }, T('2026-10-20T10:00:00Z'));
        const keys = r.events.filter((e) => e.kind === KINDS.A_INTEREST).map((e) => e.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toEqual(expect.arrayContaining(['A:inv1:int:2026-10']));
    });

    it('interest: a quarterly source pays in its own months only', () => {
        const q = investment({ freq: 'quarterly', monthly: 30000, [FIELDS.ENABLED_AT]: T('2026-03-01T00:00:00Z') });
        const months = [];
        for (let m = 5; m <= 12; m += 1) {
            const r = deriveEvents({ income: [q] }, T(`2026-${String(m).padStart(2, '0')}-20T10:00:00Z`));
            if (r.events.some((e) => e.kind === KINDS.A_INTEREST && e.month === `2026-${String(m).padStart(2, '0')}`)) months.push(m);
        }
        expect(months).toEqual([7, 10]);                                   // April + 3 = July, + 3 = October
    });

    it('interest: a source paying on the 31st is not skipped in a short month', () => {
        const inv = investment({ start: '2026-01-31', day: '2026-01-31', [FIELDS.ENABLED_AT]: T('2026-02-01T00:00:00Z'), createdAt: '2026-01-31T04:00:00Z' });
        const r = deriveEvents({ income: [inv] }, T('2026-02-28T10:00:00Z'));
        expect(r.events.find((e) => e.kind === KINDS.A_INTEREST)).toMatchObject({ month: '2026-02', dateISO: '2026-02-28' });
    });

    it('interest: nothing after the investment has ended', () => {
        const r = deriveEvents({ income: [investment({ end: '2026-09-30' })] }, T('2026-10-15T10:00:00Z'));
        expect(r.events.some((e) => e.kind === KINDS.A_INTEREST)).toBe(false);
    });

    it('interest: the figure is the stored period amount, or computed from capital, rate and cadence when missing', () => {
        expect(periodInterest({ monthly: 10000 })).toBe(10000);
        expect(periodInterest({ amount: 600000, rate: 12, freq: 'monthly' })).toBe(6000);
        expect(periodInterest({ amount: 600000, rate: 12, freq: 'quarterly' })).toBe(18000);
        expect(periodInterest({ amount: 600000, rate: 12, freq: 'annual' })).toBe(72000);
        expect(periodInterest({ amount: 0, rate: 12 })).toBe(0);
    });

    it('receipt: a payment the owner confirmed after the toggle is acknowledged', () => {
        const confirmedAt = T('2026-10-16T05:00:00Z');
        const user = { income: [investment()], incomeReceived: { 'inv1_2026-10': { confirmedAt, month: '2026-10', amount: 9500 } } };
        const r = deriveEvents(user, T('2026-10-16T06:00:00Z'));
        expect(r.events.find((e) => e.kind === KINDS.A_RECEIPT)).toMatchObject({ key: 'A:inv1:rcv:2026-10', amount: 9500, month: '2026-10', occurredAt: confirmedAt, dateISO: '2026-10-16' });
    });

    it('receipt: bookkeeping marks for months before the owner joined are never a payment to acknowledge', () => {
        const user = { income: [investment()], incomeReceived: { 'inv1_2026-10': { auto: true, historical: true, at: T('2026-10-16T05:00:00Z') }, 'inv1_2026-11': { historical: true, confirmedAt: T('2026-10-16T05:00:00Z') } } };
        expect(deriveEvents(user, T('2026-10-16T06:00:00Z')).events.some((e) => e.kind === KINDS.A_RECEIPT)).toBe(false);
    });

    it('receipt: a confirmation from before the toggle is history', () => {
        const user = { income: [investment()], incomeReceived: { 'inv1_2026-09': { confirmedAt: T('2026-09-16T05:00:00Z'), amount: 10000 } } };
        expect(deriveEvents(user, T('2026-10-16T06:00:00Z')).events.some((e) => e.kind === KINDS.A_RECEIPT)).toBe(false);
    });

    it('receipt: without a stated amount it falls back to the period amount', () => {
        const user = { income: [investment()], incomeReceived: { 'inv1_2026-10': { confirmedAt: T('2026-10-16T05:00:00Z') } } };
        expect(deriveEvents(user, T('2026-10-16T06:00:00Z')).events.find((e) => e.kind === KINDS.A_RECEIPT).amount).toBe(10000);
    });

    it('receipt: an id that is a prefix of another does not pick up the other record\'s months', () => {
        const user = { income: [investment({ id: 'a' })], incomeReceived: { 'a_b_2026-10': { confirmedAt: T('2026-10-16T05:00:00Z'), amount: 1 } } };
        expect(deriveEvents(user, T('2026-10-16T06:00:00Z')).events.some((e) => e.kind === KINDS.A_RECEIPT)).toBe(false);
    });
});

describe('LAYER B: money lent to people', () => {
    const lent = { id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') };

    it('a confirmed advance is a disbursement, with the balance after it', () => {
        const r = deriveEvents({ debtors: [debtor({ events: [lent] })] }, T('2026-10-05T10:00:00Z'));
        expect(r.events).toHaveLength(1);
        expect(r.events[0]).toMatchObject({ key: 'B:d1:e1:out', kind: KINDS.B_DISBURSED, layer: LAYER.B, amount: 50000, balance: 50000, further: false, dateISO: '2026-10-05' });
    });

    it('a repayment waits for the owner to confirm it: an unverified claim is not news', () => {
        const rep = { id: 'e2', kind: 'repayment', amount: 20000, date: '2026-10-06', confirmed: false, at: T('2026-10-06T09:00:00Z') };
        const r = deriveEvents({ debtors: [debtor({ events: [lent, rep] })] }, T('2026-10-06T10:00:00Z'));
        expect(r.events.map((e) => e.key)).toEqual(['B:d1:e1:out']);
    });

    it('once confirmed it is acknowledged, with the balance after it; confirming is the moment it becomes news', () => {
        const rep = { id: 'e2', kind: 'repayment', amount: 20000, date: '2026-10-06', confirmed: true, at: T('2026-10-06T09:00:00Z'), confirmedAt: T('2026-10-07T09:00:00Z') };
        const r = deriveEvents({ debtors: [debtor({ events: [lent, rep] })] }, T('2026-10-07T10:00:00Z'));
        const b = r.events.find((e) => e.key === 'B:d1:e2:in');
        expect(b).toMatchObject({ kind: KINDS.B_REPAYMENT, amount: 20000, balance: 30000, settled: false, occurredAt: T('2026-10-07T09:00:00Z') });
    });

    it('the final repayment says the loan is settled', () => {
        const rep = { id: 'e2', kind: 'repayment', amount: 50000, date: '2026-10-06', confirmed: true, at: T('2026-10-06T09:00:00Z') };
        const b = deriveEvents({ debtors: [debtor({ events: [lent, rep] })] }, T('2026-10-06T10:00:00Z')).events.find((e) => e.kind === KINDS.B_REPAYMENT);
        expect(b).toMatchObject({ balance: 0, settled: true });
    });

    it('a further advance is flagged as further, and the balance includes both', () => {
        const top = { id: 'e3', kind: 'topup', amount: 10000, date: '2026-10-08', confirmed: true, at: T('2026-10-08T09:00:00Z') };
        const r = deriveEvents({ debtors: [debtor({ events: [lent, top] })] }, T('2026-10-08T10:00:00Z'));
        expect(r.events.find((e) => e.key === 'B:d1:e3:out')).toMatchObject({ further: true, balance: 60000 });
    });

    it('an event written before this feature carried a confirmed flag counts as confirmed (absent means confirmed)', () => {
        const old = { id: 'e1', kind: 'lent', amount: 5000, date: '2026-10-05', at: T('2026-10-05T09:00:00Z') };
        expect(deriveEvents({ debtors: [debtor({ events: [old] })] }, T('2026-10-05T10:00:00Z')).events).toHaveLength(1);
    });

    it('history before the toggle is not announced', () => {
        const old = { id: 'e0', kind: 'lent', amount: 5000, date: '2026-09-01', confirmed: true, at: T('2026-09-01T09:00:00Z') };
        expect(deriveEvents({ debtors: [debtor({ events: [old] })] }, T('2026-10-05T10:00:00Z')).events).toEqual([]);
    });

    it('an event older than the news window is dropped however it got there', () => {
        const d = debtor({ [FIELDS.ENABLED_AT]: T('2026-01-01T00:00:00Z'), events: [{ id: 'e1', kind: 'lent', amount: 5, date: '2026-08-01', confirmed: true, at: T('2026-08-01T09:00:00Z') }] });
        expect(deriveEvents({ debtors: [d] }, T('2026-10-05T10:00:00Z')).events).toEqual([]);
        expect(MAX_AGE_MS).toBe(30 * DAY);
    });

    it('COMPUTES NO INTEREST: a stray rate or interest field on a debtor never produces an interest notice', () => {
        const d = debtor({ rate: 36, interest: true, monthly: 4000, freq: 'monthly', start: '2026-01-01', day: '2026-01-01', events: [lent] });
        const r = deriveEvents({ debtors: [d] }, T('2026-10-20T10:00:00Z'));
        expect(r.events.some((e) => e.kind === KINDS.A_INTEREST)).toBe(false);
        expect(interestApplies(LAYER.B)).toBe(false);
        expect(interestApplies(LAYER.A)).toBe(true);
    });
});

describe('phones and subjects', () => {
    it('any shape of number is normalised to E.164 on the derived event', () => {
        const mk = (phone) => deriveEvents({ debtors: [debtor({ phone, events: [{ id: 'e1', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') }] })] }, T('2026-10-05T10:00:00Z'));
        expect(mk('077-123 4567').events[0].phone).toBe('+94771234567');
        expect(mk('+1 415 555 2671').events[0].phone).toBe('+14155552671');
    });

    it('a number that cannot receive is reported, not silently skipped', () => {
        const ev = [{ id: 'e1', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') }];
        const none = deriveEvents({ debtors: [debtor({ phone: '', events: ev })] }, T('2026-10-05T10:00:00Z'));
        expect(none.events).toEqual([]);
        expect(none.issues).toEqual([{ recordKind: 'debtor', recordId: 'd1', reason: 'no-phone' }]);
        const landline = deriveEvents({ debtors: [debtor({ phone: '0112345678', events: ev })] }, T('2026-10-05T10:00:00Z'));
        expect(landline.issues[0].reason).toBe('phone-not-a-mobile-number');
    });

    it('the subject carries the CANONICAL NIC, so an old-style and a new-style number are one person', () => {
        const ev = [{ id: 'e1', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') }];
        const a = deriveEvents({ debtors: [debtor({ nic: '853400937V', events: ev })] }, T('2026-10-05T10:00:00Z')).events[0];
        expect(a.subject).toEqual({ nic: '198534000937' });
        const none = deriveEvents({ debtors: [debtor({ nic: '', events: ev })] }, T('2026-10-05T10:00:00Z')).events[0];
        expect(none.subject).toBeNull();
    });

    it('uses the owner\'s currency', () => {
        const ev = [{ id: 'e1', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') }];
        expect(deriveEvents({ settings: { currency: 'USD' }, debtors: [debtor({ events: ev })] }, T('2026-10-05T10:00:00Z')).events[0].currency).toBe('USD');
    });
});

describe('determinism', () => {
    it('the same books and clock give the same keys in the same order, run after run', () => {
        const user = { income: [investment()], incomeReceived: { 'inv1_2026-10': { confirmedAt: T('2026-10-16T05:00:00Z'), amount: 1 } }, debtors: [debtor({ events: [{ id: 'e1', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') }] })] };
        const now = T('2026-10-16T10:00:00Z');
        const a = deriveEvents(user, now); const b = deriveEvents(JSON.parse(JSON.stringify(user)), now);
        expect(a.events.map((e) => e.key)).toEqual(b.events.map((e) => e.key));
        expect(new Set(a.events.map((e) => e.key)).size).toBe(a.events.length);
    });
    it('a missing or garbage document derives nothing and throws nothing', () => {
        for (const u of [null, undefined, {}, { income: 'x', debtors: 7 }, { income: [null, 3, {}], debtors: [null, {}] }]) {
            expect(() => deriveEvents(u, T('2026-10-05T10:00:00Z'))).not.toThrow();
            expect(deriveEvents(u, T('2026-10-05T10:00:00Z')).events).toEqual([]);
        }
        expect(GRACE_MS).toBe(600000);
    });
});

describe('the sending window (Sri Lanka, UTC+05:30)', () => {
    it('inside 08:00-20:00 local, now is fine', () => {
        expect(nextSendWindow(T('2026-10-05T03:30:00Z'))).toBe(T('2026-10-05T03:30:00Z'));     // 09:00
        expect(nextSendWindow(T('2026-10-05T14:29:00Z'))).toBe(T('2026-10-05T14:29:00Z'));     // 19:59
    });
    it('before 08:00 local waits for 08:00 the same day', () => {
        expect(nextSendWindow(T('2026-10-05T00:00:00Z'))).toBe(T('2026-10-05T02:30:00Z'));     // 05:30 -> 08:00
    });
    it('after 20:00 local waits for 08:00 the next day', () => {
        expect(nextSendWindow(T('2026-10-05T14:30:00Z'))).toBe(T('2026-10-06T02:30:00Z'));     // 20:00 -> 08:00 tomorrow
        expect(nextSendWindow(T('2026-10-05T18:00:00Z'))).toBe(T('2026-10-06T02:30:00Z'));     // 23:30
    });
});
