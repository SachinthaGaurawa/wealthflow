/* =============================================================================
 * test/sms_owner_test.js — the owner's own due-date alerts, sent by the server
 * -----------------------------------------------------------------------------
 * The app's reminders used to be browser timers, so nothing reached the owner while the app was closed. These run the pure
 * derivation (sms-owner.mjs, merged into the books' notices by sms-events.mjs) for loans, cards, cheques, bills and
 * one-time payments: off unless switched on, one text per band, nothing after the due day, nothing once paid.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { bandFor, loanDues, subDues, ownerEvents, ownerAlertsOn, ONCE_BANDS, BILL_BANDS } from '../sms-owner.mjs';
import { deriveEvents, hasSmsRecords } from '../sms-events.mjs';
import { buildMessage, KINDS } from '../sms-templates.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { sweepUser } from '../sms-engine.mjs';

const NOW = Date.UTC(2026, 9, 10, 6, 0, 0);                    // 10 Oct 2026, 11:30 in Colombo
const iso = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);
const day = (iso0) => Date.parse(`${iso0}T00:00:00Z`) / 86400000;
const TODAY = day(iso(0));
const on = (extra = {}) => ({ settings: { owner_sms: { enabled: true, phone: '0771234567', at: 1 } }, ...extra });
const events = (u) => deriveEvents(u, NOW).events.filter((e) => e.layer === 'O');
const keys = (u) => events(u).map((e) => e.key);

describe('the switch', () => {
    it('is off unless the owner turned it on, and a number is needed', () => {
        expect(ownerAlertsOn({})).toBe(false);
        expect(ownerAlertsOn({ settings: { owner_sms: { enabled: false, phone: '0771234567' } } })).toBe(false);
        expect(hasSmsRecords(on())).toBe(true);
        expect(events({ subscriptions: [{ id: 's1', name: 'X', amount: 100, cycle: 'once', dueDate: iso(1) }] })).toEqual([]);
        const bad = deriveEvents({ settings: { owner_sms: { enabled: true, phone: 'abc' } }, subscriptions: [{ id: 's1', amount: 1, cycle: 'once', dueDate: iso(1) }] }, NOW);
        expect(bad.events.filter((e) => e.layer === 'O')).toEqual([]);
        expect(bad.issues.some((i) => i.recordKind === 'owner')).toBe(true);
    });
});

describe('bands', () => {
    it('an item is in the smallest band that still holds it, and in none once it is past', () => {
        expect(bandFor(10, ONCE_BANDS)).toBe(14);
        expect(bandFor(7, ONCE_BANDS)).toBe(7);
        expect(bandFor(2, ONCE_BANDS)).toBe(3);
        expect(bandFor(0, ONCE_BANDS)).toBe(0);
        expect(bandFor(-1, ONCE_BANDS)).toBe(-1);
        expect(bandFor(4, BILL_BANDS)).toBe(-1);
    });
});

describe('one-time payments', () => {
    const once = (extra = {}) => ({ id: 'o1', name: 'Lifetime licence', amount: 45000, cycle: 'once', dueDate: iso(5), createdAt: iso(-20), ...extra });
    it('a fortnight of notice, one text in the band it is in, and a repeat sweep adds nothing new', () => {
        const u = on({ subscriptions: [once()] });
        expect(keys(u)).toEqual([`O:once:o1:${iso(5)}:d7`]);
        expect(keys(on({ subscriptions: [once({ dueDate: iso(13) })] }))).toEqual([`O:once:o1:${iso(13)}:d14`]);
        expect(keys(on({ subscriptions: [once({ dueDate: iso(15) })] }))).toEqual([]);
        expect(keys(u)).toEqual(keys(u));
    });
    it('is worded as a one-time payment and goes out inside the sending hours, never after the due day', () => {
        const e = events(on({ subscriptions: [once({ dueDate: iso(1) })] }))[0];
        expect(buildMessage(e.kind, e)).toBe('One-time payment Lifetime licence LKR 45,000.00 is due tomorrow.');
        expect(e.kind).toBe(KINDS.O_DUE);
        expect(e.scheduled).toBe(true);
        expect(Number.isFinite(e.notBefore)).toBe(true);
        expect(e.occurredAt + e.maxAgeMs).toBeGreaterThan(NOW);
    });
    it('once it is paid, or the due day has gone, no text', () => {
        expect(keys(on({ subscriptions: [once({ paid: true })] }))).toEqual([]);
        expect(keys(on({ subscriptions: [once({ completed: true })] }))).toEqual([]);
        expect(keys(on({ subscriptions: [once({ dueDate: iso(-1) })] }))).toEqual([]);
        expect(keys(on({ subscriptions: [once({ paid: true, reopened: true })] }))).toHaveLength(1);   // reopened by the owner: it is owed again
    });
    it('a record with no exact date uses the day of the month it was made in', () => {
        const d = subDues({ cycle: 'once', createdAt: `${iso(-3).slice(0, 7)}-01`, dueDay: 25 }, TODAY);
        expect(d.length === 0 || d[0].dueISO.endsWith('-25')).toBe(true);
        expect(subDues({ cycle: 'once', dueDate: iso(2) }, TODAY)).toEqual([{ mk: iso(2), dueISO: iso(2), oneTime: true }]);
    });
});

describe('recurring bills', () => {
    const bill = (extra = {}) => ({ id: 'b1', name: 'Internet', amount: 6000, cycle: 'monthly', dueDay: Number(iso(2).slice(-2)), createdAt: iso(-200), ...extra });
    it('a monthly bill is texted in the last three days, for the month it falls in', () => {
        expect(keys(on({ subscriptions: [bill()] }))).toEqual([`O:bill:b1:${iso(2).slice(0, 7)}:d3`]);
        expect(keys(on({ subscriptions: [bill({ dueDay: Number(iso(5).slice(-2)) })] }))).toEqual([]);
    });
    it('is quiet once that month is paid or has its real figure (the app treats both as paid), and says what is owed otherwise', () => {
        const mk = iso(2).slice(0, 7);
        expect(keys(on({ subscriptions: [bill({ history: [{ month: mk, amount: 6000, date: iso(1) }] })] }))).toEqual([]);
        expect(keys(on({ subscriptions: [bill({ monthOverrides: { [mk]: 6400 } })] }))).toEqual([]);
        const e = events(on({ subscriptions: [bill()] }))[0];
        expect(buildMessage(e.kind, e)).toMatch(/^Bill Internet LKR 6,000\.00 is due in 2 days \(\d\d \w{3} 2026\)\.$/);
    });
    it('a quarterly bill is texted only in its own months, a day past the end of a short month is clamped, an old record with no start month is monthly only', () => {
        const anchor = `${iso(2).slice(0, 7)}-01`;
        expect(subDues({ cycle: 'quarterly', dueDay: Number(iso(2).slice(-2)), createdAt: anchor }, TODAY)).toHaveLength(1);
        expect(subDues({ cycle: 'quarterly', dueDay: Number(iso(2).slice(-2)), createdAt: `${iso(-31).slice(0, 7)}-01` }, TODAY)).toEqual([]);
        expect(subDues({ cycle: 'quarterly', dueDay: 15 }, TODAY)).toEqual([]);
        expect(subDues({ cycle: 'weekly', dueDay: 15, createdAt: iso(-90) }, TODAY)).toEqual([]);
        const feb = day('2027-02-26');
        expect(subDues({ cycle: 'monthly', dueDay: 31, createdAt: '2026-01-05' }, feb)).toEqual([{ mk: '2027-02', dueISO: '2027-02-28', oneTime: false }]);
    });
});

describe('loans, cards and cheques', () => {
    it('a loan instalment, a card payment and a cheque each get their band', () => {
        const startDay = Number(iso(3).slice(-2));
        const u = on({
            loans: [{ id: 'l1', name: 'Vehicle', monthly: 50000, start: `2026-01-${String(startDay).padStart(2, '0')}`, duration: 36, payments: [] }],
            cconetime: [{ id: 'c1', desc: 'Dinner', amount: 8000, deadline: iso(7) }, { id: 'c2', desc: 'Paid', amount: 1, deadline: iso(1), paid: true }],
            cheques: [{ id: 'q1', number: '1234', amount: 20000, release: iso(1), status: 'pending' }, { id: 'q2', number: '9', amount: 5, release: iso(1), status: 'cleared' }],
        });
        const k = keys(u);
        expect(k.some((x) => x.startsWith('O:loan:l1:'))).toBe(true);
        expect(k).toContain(`O:card:c1:${iso(7)}:d7`);
        expect(k).toContain(`O:cheque:q1:${iso(1)}:d1`);
        expect(k.some((x) => x.includes(':c2:') || x.includes(':q2:'))).toBe(false);
        expect(loanDues({ start: '2026-01-31', duration: 12 }, day('2026-02-25'))).toEqual([{ mk: '2026-02', dueISO: '2026-02-28' }]);
    });
});

describe('through the real sweep, with nobody signed in', () => {
    const sent = [];
    const client = { configured: true, senderId: 'WealthFlow', async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: 'g' + sent.length, cost: 1, segments: 1 }; } };
    const user = on({ settings: { currency: 'LKR', owner_sms: { enabled: true, phone: '0771234567', at: 1 } }, subscriptions: [{ id: 'o1', name: 'Lifetime licence', amount: 45000, cycle: 'once', dueDate: iso(1), createdAt: iso(-9) }] });
    it('texts the owner\'s own number once, and a second sweep (or a second cron) sends nothing more', async () => {
        sent.length = 0;
        const { db } = createFirestore();
        const run = (u, now = NOW) => sweepUser({ db, uid: 'u1', user: u, client, now, env: {}, deps: { random: () => 0.5 } });
        await run(user);
        expect(sent).toHaveLength(1);
        expect(sent[0].to).toMatch(/94771234567$/);
        expect(sent[0].message).toBe('One-time payment Lifetime licence LKR 45,000.00 is due tomorrow.');
        await run(user);
        await run(user, NOW + 3600e3);
        expect(sent).toHaveLength(1);
    });
    it('a payment that is marked paid before the sweep gets to it is not texted', async () => {
        sent.length = 0;
        const { db } = createFirestore();
        await sweepUser({ db, uid: 'u2', user: { ...user, subscriptions: [{ ...user.subscriptions[0], paid: true }] }, client, now: NOW, env: {}, deps: { random: () => 0.5 } });
        expect(sent).toHaveLength(0);
    });
});
