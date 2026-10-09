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
import { deriveEvents, nextSendWindow, periodInterest, interestApplies, hasSmsRecords, GRACE_MS, MAX_AGE_MS, REQUEST_WINDOW_MS, REQUESTS_READ, REMINDER_OFFSETS_DAYS, REMINDER_WINDOW_MS, REMINDER_SHELF_MS, FIELDS, LAYER } from '../sms-events.mjs';
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
        expect(mk('+94 77 123 4567').events[0].phone).toBe('+94771234567');
        // the gateway delivers inside Sri Lanka only: a number of any other country is reported and never texted
        const abroad = mk('+1 415 555 2671');
        expect(abroad.events).toEqual([]);
        expect(abroad.issues).toEqual([{ recordKind: 'debtor', recordId: 'd1', reason: 'phone-not-sri-lanka' }]);
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

describe('the balance on request (a part payment was agreed, or the person asked)', () => {
    const lent = { id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') };
    const part = { id: 'e2', kind: 'repayment', amount: 20000, date: '2026-10-06', confirmed: true, at: T('2026-10-06T05:00:00Z') };
    const asked = T('2026-10-06T10:00:00Z');
    const books = (over = {}, events = [lent, part]) => ({ debtors: [debtor({ events, [FIELDS.REQUESTS]: [{ id: 'req-1', at: asked }], ...over })] });
    const bal = (r) => r.events.filter((e) => e.kind === KINDS.B_BALANCE);

    it('names the confirmed balance as it is now, and the day it is as at', () => {
        const r = deriveEvents(books(), asked + 60000);
        expect(bal(r)).toHaveLength(1);
        expect(bal(r)[0]).toMatchObject({ key: 'B:d1:bal:req-1', kind: KINDS.B_BALANCE, layer: LAYER.B, balance: 30000, amount: 30000, occurredAt: asked, dateISO: '2026-10-06', maxAgeMs: REQUEST_WINDOW_MS, scheduled: false });
    });

    it('does not count money nobody has confirmed, however much is waiting', () => {
        const pending = { id: 'e3', kind: 'repayment', amount: 25000, date: '2026-10-06', confirmed: false, at: T('2026-10-06T08:00:00Z') };
        expect(bal(deriveEvents(books({}, [lent, part, pending]), asked + 1000))[0].balance).toBe(30000);
    });

    it('a debtor who owes nothing is told so, with a balance of zero (never a negative one)', () => {
        const over = { id: 'e9', kind: 'repayment', amount: 60000, date: '2026-10-06', confirmed: true, at: T('2026-10-06T06:00:00Z') };
        expect(bal(deriveEvents(books({}, [lent, over]), asked + 1000))[0].balance).toBe(0);
    });

    it('is good for half an hour and no longer: the figure goes into the text when it is queued, so a late one is dropped, not sent stale', () => {
        expect(bal(deriveEvents(books(), asked + REQUEST_WINDOW_MS))).toHaveLength(1);
        expect(bal(deriveEvents(books(), asked + REQUEST_WINDOW_MS + 1))).toHaveLength(0);
        expect(REQUEST_WINDOW_MS).toBe(30 * 60 * 1000);
    });

    it('a request from the future (a device with the wrong clock) is not honoured early or at all', () => {
        expect(bal(deriveEvents(books(), asked - 10 * 60000))).toHaveLength(0);
        expect(bal(deriveEvents(books(), asked - 60000))).toHaveLength(1);            // within the allowed skew
    });

    it('a request pressed before the texts were switched on is not news', () => {
        expect(bal(deriveEvents(books({ [FIELDS.ENABLED_AT]: asked + 3600e3 }), asked + 60000))).toHaveLength(0);
    });

    it('needs the switch on, and a number it can reach (the same issues as every other notice)', () => {
        expect(bal(deriveEvents(books({ [FIELDS.ENABLED]: false }), asked + 1000))).toHaveLength(0);
        const noPhone = deriveEvents(books({ phone: '' }), asked + 1000);
        expect(bal(noPhone)).toHaveLength(0);
        expect(noPhone.issues.some((i) => i.reason === 'no-phone')).toBe(true);
    });

    it('reads only well-formed requests: an id the server accepts and a real time', () => {
        const reqs = [{ id: 'ok-1', at: asked }, { id: '', at: asked }, { id: 'a b', at: asked }, { id: 'x'.repeat(41), at: asked }, { id: 'no-time' }, { id: 'neg', at: -5 }, null, 7, 'x', { id: '<b>', at: asked }];
        const r = deriveEvents(books({ [FIELDS.REQUESTS]: reqs }), asked + 1000);
        expect(bal(r).map((e) => e.key)).toEqual(['B:d1:bal:ok-1']);
    });

    it('reads no more than the newest few, so a stuck loop on a device cannot become a stream of texts', () => {
        const reqs = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}-aaaa`, at: asked + i * 1000 }));
        const keys = bal(deriveEvents(books({ [FIELDS.REQUESTS]: reqs }), asked + 20000)).map((e) => e.key);
        expect(keys).toHaveLength(REQUESTS_READ);
        expect(keys).toContain('B:d1:bal:r11-aaaa');
        expect(keys).not.toContain('B:d1:bal:r0-aaaa');
    });

    it('is not a Layer A thing: an investment never carries one, whatever field a record is given', () => {
        const user = { income: [investment({ [FIELDS.REQUESTS]: [{ id: 'req-1', at: asked }] })] };
        expect(bal(deriveEvents(user, asked + 1000))).toHaveLength(0);
    });

    it('still sends the repayment text with the balance left, which is how a part payment says what remains', () => {
        const r = deriveEvents(books({ [FIELDS.REQUESTS]: [] }), T('2026-10-06T06:00:00Z'));
        expect(r.events.find((e) => e.kind === KINDS.B_REPAYMENT)).toMatchObject({ amount: 20000, balance: 30000, settled: false });
    });

    it('computes no interest: a stray rate on the record changes nothing', () => {
        const r = deriveEvents(books({ rate: 24 }), asked + 1000);
        expect(bal(r)[0].balance).toBe(30000);
        expect(r.events.some((e) => e.layer === LAYER.B && e.kind === KINDS.A_INTEREST)).toBe(false);
    });
});

describe('late-payment reminders (opt-in, a debtor only)', () => {
    const lent = { id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-01', confirmed: true, at: T('2026-10-01T05:00:00Z') };
    const part = { id: 'e2', kind: 'repayment', amount: 20000, date: '2026-10-05', confirmed: true, at: T('2026-10-05T05:00:00Z') };
    const late = (over = {}, events = [lent]) => ({ debtors: [debtor({ dueISO: '2026-10-10', events, [FIELDS.REMIND]: true, [FIELDS.REMIND_AT]: T('2026-10-02T00:00:00Z'), ...over })] });
    const rem = (r) => r.events.filter((e) => e.kind === KINDS.B_LATE);

    it('nothing until the day after the date has begun where the debtor is (Colombo, UTC+05:30), and then a scheduled reminder for 08:00', () => {
        expect(rem(deriveEvents(late(), T('2026-10-10T18:00:00Z')))).toHaveLength(0);               // still the 10th in Colombo
        const r = rem(deriveEvents(late(), T('2026-10-10T19:00:00Z')));                               // 00:30 on the 11th
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ key: 'B:d1:late:2026-10-10:1', kind: KINDS.B_LATE, layer: LAYER.B, balance: 50000, amount: 50000, dateISO: '2026-10-10', scheduled: true, occurredAt: T('2026-10-10T18:30:00Z') });
        expect(r[0].notBefore).toBe(T('2026-10-11T02:30:00Z'));                                       // 08:00 Colombo
        expect(r[0].maxAgeMs).toBe(REMINDER_SHELF_MS + (T('2026-10-11T02:30:00Z') - T('2026-10-10T18:30:00Z')));
    });

    it('the day is Sri Lanka\'s: a reminder is due on the Colombo morning, and a number in another country gets none', () => {
        const r = rem(deriveEvents(late({ phone: '+94771234567' }), T('2026-10-10T21:00:00Z')));     // 02:30 on the 11th in Colombo
        expect(r).toHaveLength(1);
        expect(r[0].tzMin).toBe(330);
        expect(r[0].notBefore).toBe(T('2026-10-11T02:30:00Z'));                                       // 08:00 Colombo
        const dubai = deriveEvents(late({ phone: '+971501234567' }), T('2026-10-10T21:00:00Z'));
        expect(rem(dubai)).toHaveLength(0);
        expect(dubai.issues.map((i) => i.reason)).toContain('phone-not-sri-lanka');
    });

    it('then one a week later each time, at most four, and never more than one a day', () => {
        expect(REMINDER_OFFSETS_DAYS).toEqual([1, 8, 15, 22]);
        const keys = (now) => rem(deriveEvents(late({ [FIELDS.ENABLED_AT]: T('2026-10-01T00:00:00Z') }), now)).map((e) => e.key.split(':').pop());
        expect(keys(T('2026-10-18T05:00:00Z'))).toEqual(['2']);                                       // the first one's week is over: the second is the one in force
        expect(keys(T('2026-10-25T05:00:00Z'))).toEqual(['3']);
        expect(keys(T('2026-11-01T05:00:00Z'))).toEqual(['4']);
        expect(keys(T('2026-11-20T05:00:00Z'))).toEqual([]);                                          // four is the end
    });

    it('a reminder is owed from its day until the next one is due (a week), so one that could not go out on its day (no credit, a sender not yet approved) still goes', () => {
        expect(rem(deriveEvents(late(), T('2026-10-11T05:00:00Z')))).toHaveLength(1);
        expect(rem(deriveEvents(late(), T('2026-10-13T19:00:00Z')))).toHaveLength(1);                 // three and a half days on: still the one in force
        expect(rem(deriveEvents(late(), T('2026-10-17T18:29:00Z')))).toHaveLength(1);                 // a minute before the week is up
        expect(rem(deriveEvents(late(), T('2026-10-17T18:30:00Z'))).map((e) => e.key.split(':').pop())).toEqual(['2']);   // the week is up: the second takes over, never both
        expect(REMINDER_WINDOW_MS).toBe(7 * 86400000);
    });

    it('says the balance that is still owed after a part payment, never the original loan, and no interest', () => {
        const r = rem(deriveEvents(late({ rate: 24 }, [lent, part]), T('2026-10-11T05:00:00Z')));
        expect(r[0]).toMatchObject({ balance: 30000, amount: 30000 });
    });

    it('stops when the money is paid back, and a repayment nobody has confirmed neither counts nor is chased (see the held-back case below)', () => {
        const paid = { id: 'e3', kind: 'repayment', amount: 50000, date: '2026-10-09', confirmed: true, at: T('2026-10-09T05:00:00Z') };
        expect(rem(deriveEvents(late({}, [lent, paid]), T('2026-10-11T05:00:00Z')))).toHaveLength(0);
        const claim = { ...paid, confirmed: false };
        expect(rem(deriveEvents(late({}, [lent, claim]), T('2026-10-11T05:00:00Z')))).toHaveLength(0);
    });

    it('is off unless the owner ticked it, and needs the texts on, a date, and a number', () => {
        const now = T('2026-10-11T05:00:00Z');
        expect(rem(deriveEvents(late({ [FIELDS.REMIND]: false }), now))).toHaveLength(0);
        expect(rem(deriveEvents(late({ [FIELDS.REMIND]: undefined }), now))).toHaveLength(0);
        expect(rem(deriveEvents(late({ [FIELDS.REMIND]: 'true' }), now))).toHaveLength(0);          // only a real boolean
        expect(rem(deriveEvents(late({ [FIELDS.ENABLED]: false }), now))).toHaveLength(0);
        expect(rem(deriveEvents(late({ dueISO: '' }), now))).toHaveLength(0);
        expect(rem(deriveEvents(late({ dueISO: 'soon' }), now))).toHaveLength(0);
        expect(rem(deriveEvents(late({ phone: '' }), now))).toHaveLength(0);
    });

    it('ticking the box on a debtor who is already late sends the reminder in force now, once, not nothing until next week', () => {
        const ticked = late({ [FIELDS.REMIND_AT]: T('2026-10-12T09:00:00Z') });
        expect(rem(deriveEvents(ticked, T('2026-10-13T05:00:00Z'))).map((e) => e.key.split(':').pop())).toEqual(['1']);
    });

    it('ticking it on a debtor who has been late for weeks (all four have gone by) still sends the one reminder asked for, once, under the day it was asked', () => {
        const ticked = late({ [FIELDS.REMIND_AT]: T('2026-12-01T09:00:00Z'), [FIELDS.ENABLED_AT]: T('2026-12-01T09:00:00Z') });
        const r = rem(deriveEvents(ticked, T('2026-12-02T05:00:00Z')));
        expect(r.map((e) => e.key)).toEqual(['B:d1:late:2026-10-10:asked-2026-12-01']);
        expect(rem(deriveEvents(ticked, T('2026-12-02T05:00:00Z')))[0].key).toBe(r[0].key);          // the same key on every sweep: sent once
        expect(rem(deriveEvents(ticked, T('2026-12-12T05:00:00Z')))).toHaveLength(0);                  // and not for ever
    });

    it('a new date is a new set of reminders, under new keys, so the old ones are no longer owed', () => {
        const now = T('2026-10-20T05:00:00Z');
        const a = rem(deriveEvents(late({ dueISO: '2026-10-10' }), now)).map((e) => e.key);
        const b = rem(deriveEvents(late({ dueISO: '2026-10-19' }), now)).map((e) => e.key);
        expect(a).toEqual(['B:d1:late:2026-10-10:2']);
        expect(b).toEqual(['B:d1:late:2026-10-19:1']);
        expect(a.some((k) => b.includes(k))).toBe(false);                                            // changing the date never repeats or collides
    });

    it('is not a Layer A thing', () => {
        const user = { income: [investment({ [FIELDS.REMIND]: true, dueISO: '2026-10-10' })] };
        expect(rem(deriveEvents(user, T('2026-10-11T05:00:00Z')))).toHaveLength(0);
    });

    it('is held back while a repayment is waiting for the owner to confirm it: "you owe" to someone who says they paid is the call the owner does not want', () => {
        const waiting = { id: 'e8', kind: 'repayment', amount: 50000, date: '2026-10-10', confirmed: false, at: T('2026-10-10T09:00:00Z') };
        const now = T('2026-10-11T05:00:00Z');
        expect(rem(deriveEvents(late({}, [lent, waiting]), now))).toHaveLength(0);
        // the owner checks the bank and it is a part payment: the reminder is owed again, for what is really left
        const part = { ...waiting, amount: 20000, confirmed: true, confirmedAt: T('2026-10-10T20:00:00Z') };
        const r = rem(deriveEvents(late({}, [lent, part]), now));
        expect(r).toHaveLength(1);
        expect(r[0].balance).toBe(30000);
        // it was never paid and the owner rejects it (deletes the log): the reminder is owed as before
        expect(rem(deriveEvents(late({}, [lent]), now))).toHaveLength(1);
    });

    it('a balance the owner asked for is still sent while a repayment waits (it states the confirmed figure and nothing else)', () => {
        const waiting = { id: 'e8', kind: 'repayment', amount: 50000, date: '2026-10-10', confirmed: false, at: T('2026-10-10T09:00:00Z') };
        const user = late({ [FIELDS.REQUESTS]: [{ id: 'req-1', at: T('2026-10-11T04:50:00Z') }] }, [lent, waiting]);
        expect(deriveEvents(user, T('2026-10-11T05:00:00Z')).events.filter((e) => e.kind === KINDS.B_BALANCE)).toHaveLength(1);
    });
});

describe('closing: a separate text when a loan is fully settled or an investment is closed', () => {
    const lent = { id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') };
    const part = { id: 'e2', kind: 'repayment', amount: 20000, date: '2026-10-06', confirmed: true, at: T('2026-10-06T09:00:00Z') };
    const last = { id: 'e3', kind: 'repayment', amount: 30000, date: '2026-10-07', confirmed: true, at: T('2026-10-07T09:00:00Z') };
    const now = T('2026-10-07T10:00:00Z');
    const keys = (r) => r.events.map((e) => e.key);

    it('the repayment that brings the balance to nothing is acknowledged AND followed by its own closing text', () => {
        const r = deriveEvents({ debtors: [debtor({ events: [lent, part, last] })] }, now);
        expect(keys(r)).toEqual(['B:d1:e1:out', 'B:d1:e2:in', 'B:d1:e3:in', 'B:d1:e3:closed']);
        const receipt = r.events.find((e) => e.key === 'B:d1:e3:in');
        const closed = r.events.find((e) => e.key === 'B:d1:e3:closed');
        expect(closed).toMatchObject({ kind: KINDS.B_CLOSED, layer: LAYER.B, recordKind: 'debtor', recordId: 'd1', balance: 0, phone: '+94771234567', scheduled: false, dateISO: '2026-10-07', subject: { nic: '198534000937' } });
        expect(closed.occurredAt).toBe(receipt.occurredAt + 1);                  // after the receipt, never before it
    });

    it('a part payment closes nothing', () => {
        expect(keys(deriveEvents({ debtors: [debtor({ events: [lent, part] })] }, now))).toEqual(['B:d1:e1:out', 'B:d1:e2:in']);
    });

    it('a final repayment nobody has confirmed is neither acknowledged nor called a closing: the books do not say so yet', () => {
        const r = deriveEvents({ debtors: [debtor({ events: [lent, part, { ...last, confirmed: false }] })] }, now);
        expect(keys(r)).toEqual(['B:d1:e1:out', 'B:d1:e2:in']);
    });

    it('confirming it later is what makes the closing news, once', () => {
        const confirmedLate = { ...last, confirmedAt: T('2026-10-09T08:00:00Z') };
        const r = deriveEvents({ debtors: [debtor({ events: [lent, part, confirmedLate] })] }, T('2026-10-09T10:00:00Z'));
        expect(r.events.find((e) => e.key === 'B:d1:e3:closed').occurredAt).toBe(T('2026-10-09T08:00:00Z') + 1);
    });

    it('borrowing again and settling again is a second closing, with its own key', () => {
        const again = { id: 'e4', kind: 'lent', amount: 10000, date: '2026-10-08', confirmed: true, at: T('2026-10-08T09:00:00Z') };
        const back = { id: 'e5', kind: 'repayment', amount: 10000, date: '2026-10-09', confirmed: true, at: T('2026-10-09T09:00:00Z') };
        const r = deriveEvents({ debtors: [debtor({ events: [lent, part, last, again, back] })] }, T('2026-10-09T10:00:00Z'));
        expect(keys(r).filter((k) => k.endsWith(':closed'))).toEqual(['B:d1:e3:closed', 'B:d1:e5:closed']);
    });

    it('a loan that was already settled before the texts were switched on is history, not news', () => {
        const d = debtor({ [FIELDS.ENABLED_AT]: T('2026-10-08T00:00:00Z'), events: [lent, part, last] });
        expect(deriveEvents({ debtors: [d] }, T('2026-10-08T10:00:00Z')).events).toEqual([]);
    });

    it('the same books and clock give the same closing, run after run', () => {
        const user = { debtors: [debtor({ events: [lent, part, last] })] };
        expect(JSON.stringify(deriveEvents(user, now))).toBe(JSON.stringify(deriveEvents(user, now)));
    });

    it('the final receipt no longer says "settled": that is the closing text\'s job', async () => {
        const { buildMessage } = await import('../sms-templates.mjs');
        const msg = buildMessage(KINDS.B_REPAYMENT, { amount: 30000, currency: 'LKR', ref: 'DEB-1A2B3C', dateISO: '2026-10-07', balance: 0, settled: true });
        expect(msg).toBe('Repayment LKR 30,000.00 received on 07 Oct 2026, ref DEB-1A2B3C. Balance LKR 0.00.');
        expect(buildMessage(KINDS.B_CLOSED, { currency: 'LKR', ref: 'DEB-1A2B3C', dateISO: '2026-10-07', link: 'https://wealthflow-personal.vercel.app/t/AbCdEfGhIjKlMnOp' }))
            .toBe('Loan ref DEB-1A2B3C is fully settled and closed on 07 Oct 2026. Thank you. Statement: https://wealthflow-personal.vercel.app/t/AbCdEfGhIjKlMnOp');
        expect(buildMessage(KINDS.A_CLOSED, { currency: 'LKR', ref: 'INV-3F9A2B', dateISO: '2026-10-07' }))
            .toBe('Investment ref INV-3F9A2B is fully settled and closed on 07 Oct 2026. Thank you.');
    });

    describe('an investment', () => {
        const closedAt = T('2026-10-10T08:00:00Z');
        const closedOn = (over = {}) => ({ income: [investment({ closedAt, end: '2026-10-10', ...over })] });
        const asOf = T('2026-10-10T10:00:00Z');

        it('closed by the owner: one closing text, keyed by the moment it was closed', () => {
            const r = deriveEvents(closedOn(), asOf);
            const c = r.events.find((e) => e.kind === KINDS.A_CLOSED);
            expect(c).toMatchObject({ key: `A:inv1:closed:${closedAt}`, layer: LAYER.A, recordKind: 'investment', recordId: 'inv1', occurredAt: closedAt, phone: '+94771234567', scheduled: false, dateISO: '2026-10-10', subject: { nic: '198534000937' } });
        });

        it('not closed, no text', () => {
            expect(deriveEvents({ income: [investment()] }, asOf).events.some((e) => e.kind === KINDS.A_CLOSED)).toBe(false);
        });

        it('re-opened (the stamp removed) and closed again later is a second closing', () => {
            const second = T('2026-10-20T08:00:00Z');
            const a = deriveEvents(closedOn(), asOf).events.find((e) => e.kind === KINDS.A_CLOSED).key;
            const b = deriveEvents(closedOn({ closedAt: second }), T('2026-10-20T10:00:00Z')).events.find((e) => e.kind === KINDS.A_CLOSED).key;
            expect(a).not.toBe(b);
        });

        it('an investment that was already closed before the texts were switched on is history', () => {
            const r = deriveEvents(closedOn({ [FIELDS.ENABLED_AT]: T('2026-10-11T00:00:00Z') }), T('2026-10-11T10:00:00Z'));
            expect(r.events.some((e) => e.kind === KINDS.A_CLOSED)).toBe(false);
        });

        it('a closing stamp from the future (a phone with the wrong date) is not honoured', () => {
            const r = deriveEvents(closedOn({ closedAt: asOf + 3 * DAY }), asOf);
            expect(r.events.some((e) => e.kind === KINDS.A_CLOSED)).toBe(false);
        });

        it('no interest is announced for a day after the closing, even when the end date was not moved', () => {
            const late = T('2026-10-20T10:00:00Z');
            const keysOf = (rec) => deriveEvents({ income: [rec] }, late).events.filter((e) => e.kind === KINDS.A_INTEREST).map((e) => e.key);
            expect(keysOf(investment())).toContain('A:inv1:int:2026-10');                                // running: the 15th is owed
            expect(keysOf(investment({ closedAt }))).toEqual([]);                                        // closed on the 10th: it is not
            expect(keysOf(investment({ closedAt: T('2026-10-16T08:00:00Z') }))).toContain('A:inv1:int:2026-10');   // closed after the 15th: that one was owed
        });

        it('a text is never owed for a closure with a garbage stamp', () => {
            for (const bad of ['yesterday', -5, 0, null, {}, NaN]) {
                expect(deriveEvents(closedOn({ closedAt: bad }), asOf).events.some((e) => e.kind === KINDS.A_CLOSED), String(bad)).toBe(false);
            }
        });
    });
});

describe('a second number (optional): every text goes to both', () => {
    const lent = { id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:00:00Z') };
    const now = T('2026-10-05T10:00:00Z');
    const to = (r) => r.events.map((e) => `${e.key}>${e.phone}`);

    it('a debtor with a second number is texted on both, under keys of their own', () => {
        const r = deriveEvents({ debtors: [debtor({ phone2: '+94712345678', events: [lent] })] }, now);
        expect(to(r)).toEqual(['B:d1:e1:out>+94771234567', 'B:d1:e1:out:2>+94712345678']);
        expect(r.events[1]).toMatchObject({ kind: KINDS.B_DISBURSED, amount: 50000, balance: 50000, subject: { nic: '198534000937' }, tzMin: 330 });
        expect(r.issues).toEqual([]);
    });

    it('so is an investor', () => {
        const created = T('2026-10-05T09:58:00Z');
        const r = deriveEvents({ income: [investment({ phone2: '+94712345678', start: '2026-10-05', day: '2026-10-05', createdAt: new Date(created).toISOString(), [FIELDS.ENABLED_AT]: created + 2000 })] }, now);
        expect(to(r)).toEqual(['A:inv1:created>+94771234567', 'A:inv1:created:2>+94712345678']);
    });

    it('a second number outside Sri Lanka is reported and never texted, while the first number still is; a Sri Lankan one waits for the same morning', () => {
        const user = { income: [investment({ phone2: '+14155552671', [FIELDS.ENABLED_AT]: T('2026-10-01T00:00:00Z') })] };
        const r = deriveEvents(user, T('2026-10-16T10:00:00Z'));
        expect(r.events.some((e) => e.key.endsWith(':2'))).toBe(false);
        expect(r.events.some((e) => e.kind === KINDS.A_INTEREST)).toBe(true);
        expect(r.issues.map((i) => i.reason)).toContain('phone2-not-sri-lanka');
        const ok = deriveEvents({ income: [investment({ phone2: '+94712345678', [FIELDS.ENABLED_AT]: T('2026-10-01T00:00:00Z') })] }, T('2026-10-16T10:00:00Z'));
        const a = ok.events.find((e) => e.kind === KINDS.A_INTEREST && e.key.endsWith(':2'));
        const p = ok.events.find((e) => e.kind === KINDS.A_INTEREST && !e.key.endsWith(':2'));
        expect(a.phone).toBe('+94712345678');
        expect(a.tzMin).toBe(330);
        expect(a.notBefore).toBe(nextSendWindow(a.occurredAt, 330));
        expect(a.notBefore).toBe(p.notBefore);
        expect(a.scheduled).toBe(true);
    });

    it('a second number that cannot receive is reported and the first number is still texted', () => {
        const r = deriveEvents({ debtors: [debtor({ phone2: '+94112345678', events: [lent] })] }, now);
        expect(to(r)).toEqual(['B:d1:e1:out>+94771234567']);
        expect(r.issues).toEqual([{ recordKind: 'debtor', recordId: 'd1', reason: 'phone2-not-a-mobile-number' }]);
    });

    it('the same number twice is one text', () => {
        const r = deriveEvents({ debtors: [debtor({ phone2: '+94771234567', events: [lent] })] }, now);
        expect(to(r)).toEqual(['B:d1:e1:out>+94771234567']);
        expect(r.issues).toEqual([]);
    });

    it('no second number: the keys are exactly what they always were', () => {
        expect(deriveEvents({ debtors: [debtor({ events: [lent] })] }, now).events.map((e) => e.key)).toEqual(['B:d1:e1:out']);
        expect(deriveEvents({ debtors: [debtor({ phone2: '', events: [lent] })] }, now).events.map((e) => e.key)).toEqual(['B:d1:e1:out']);
    });

    it('a second number without a usable first sends nothing: the first number is the one the person is known by', () => {
        const r = deriveEvents({ debtors: [debtor({ phone: '', phone2: '+94712345678', events: [lent] })] }, now);
        expect(r.events).toEqual([]);
        expect(r.issues).toEqual([{ recordKind: 'debtor', recordId: 'd1', reason: 'no-phone' }]);
    });

    it('the closing text and a balance on request go to both as well', () => {
        const full = { id: 'e2', kind: 'repayment', amount: 50000, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:30:00Z') };
        const r = deriveEvents({ debtors: [debtor({ phone2: '+94712345678', events: [lent, full] })] }, now);
        expect(to(r).filter((k) => k.includes(':closed'))).toEqual(['B:d1:e2:closed>+94771234567', 'B:d1:e2:closed:2>+94712345678']);
    });

    describe('a number added later is not sent the past', () => {
        const rep1 = { id: 'e2', kind: 'repayment', amount: 10000, date: '2026-10-02', confirmed: true, at: T('2026-10-02T09:00:00Z') };
        const rep2 = { id: 'e3', kind: 'repayment', amount: 10000, date: '2026-10-05', confirmed: true, at: T('2026-10-05T09:30:00Z') };
        const base = (over = {}) => ({ debtors: [debtor({ events: [lent, rep1, rep2], ...over })] });

        it('only what happened since it was added goes to it; the first number is unaffected', () => {
            const r = deriveEvents(base({ phone2: '+94712345678', [FIELDS.PHONE2_AT]: T('2026-10-05T09:15:00Z') }), now);
            expect(to(r).filter((k) => k.includes('+94771234567')).length).toBe(3);
            expect(to(r).filter((k) => k.includes('+94712345678'))).toEqual(['B:d1:e3:in:2>+94712345678']);
        });

        it('added in the same save as the switch, it is treated exactly as the first number is (no stamp: from when the texts went on)', () => {
            const r = deriveEvents(base({ phone2: '+94712345678' }), now);
            expect(to(r).filter((k) => k.endsWith('>+94712345678'))).toEqual(to(r).filter((k) => k.endsWith('>+94771234567')).map((k) => k.replace('>+94771234567', ':2>+94712345678')));
        });

        it('a stamp older than the switch does not reach back past the switch', () => {
            const r = deriveEvents(base({ phone2: '+94712345678', [FIELDS.PHONE2_AT]: T('2026-09-01T00:00:00Z'), [FIELDS.ENABLED_AT]: T('2026-10-05T09:15:00Z') }), now);
            expect(to(r).filter((k) => k.endsWith('>+94712345678'))).toEqual(['B:d1:e3:in:2>+94712345678']);
        });

        it('an interest notice is judged by its day: one due on the day the number was added is still owed to it', () => {
            const user = { income: [investment({ phone2: '+94712345678', [FIELDS.ENABLED_AT]: T('2026-10-01T00:00:00Z'), [FIELDS.PHONE2_AT]: T('2026-10-15T16:00:00Z') })] };
            const r = deriveEvents(user, T('2026-10-16T10:00:00Z'));
            expect(r.events.filter((e) => e.kind === KINDS.A_INTEREST && e.key.endsWith(':2')).map((e) => e.key)).toEqual(['A:inv1:int:2026-10:2']);
            const before = deriveEvents({ income: [investment({ phone2: '+94712345678', [FIELDS.ENABLED_AT]: T('2026-10-01T00:00:00Z'), [FIELDS.PHONE2_AT]: T('2026-10-16T01:00:00Z') })] }, T('2026-10-16T10:00:00Z'));
            expect(before.events.filter((e) => e.key.endsWith(':2'))).toEqual([]);                    // added the day after the 15th: that month's interest was already told to the first number alone
        });

        it('a stamp from a phone with the wrong date does not silence the number for ever', () => {
            const r = deriveEvents(base({ phone2: '+94712345678', [FIELDS.PHONE2_AT]: now + 30 * DAY }), now);
            expect(Array.isArray(r.events)).toBe(true);
            expect(to(r).filter((k) => k.endsWith('>+94771234567')).length).toBe(3);
        });
    });

    it('a reminder\'s shelf life follows the second number\'s own window', () => {
        const d = debtor({ phone2: '+94712345678', dueISO: '2026-10-02', [FIELDS.REMIND]: true, [FIELDS.REMIND_AT]: T('2026-10-01T00:00:00Z'), events: [{ ...lent, date: '2026-10-01', at: T('2026-10-01T09:00:00Z') }] });
        const r = deriveEvents({ debtors: [d] }, T('2026-10-03T10:00:00Z'));
        const p = r.events.find((e) => e.kind === KINDS.B_LATE && !e.key.endsWith(':2'));
        const t = r.events.find((e) => e.kind === KINDS.B_LATE && e.key.endsWith(':2'));
        expect(t).toBeTruthy();
        expect(t.maxAgeMs - (t.notBefore - t.occurredAt)).toBe(p.maxAgeMs - (p.notBefore - p.occurredAt));    // the same 24 hours, counted from each one's own window
    });
});
