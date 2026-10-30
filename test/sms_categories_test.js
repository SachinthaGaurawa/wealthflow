/* =============================================================================
 * test/sms_categories_test.js — the owner's per-kind text switches (Settings > Text messages)
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-29: choose which kinds of text may be sent (loans, cards, cheques, one-time payments, subscriptions, investments, debtors,
 * late-payment reminders); a kind switched off is never sent. These pin: the default is ON, off means off all the way down to a queued text being
 * cancelled, switching back on is not a backlog of history, and the Settings markup matches the stored shape.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    CATEGORIES, CATEGORY_KEYS, CATS_FIELD, categoryOn, categorySince, withCategory, categoryList, categoryOfEvent, filterEvents,
} from '../wealthflow-sms-categories.js';
import { deriveEvents } from '../sms-events.mjs';
import { sweepUser } from '../sms-engine.mjs';
import { categoriesHtml, signatureOf } from '../wealthflow-sms.js';
import { createFirestore } from './helpers/fake-firestore.js';

const NOW = Date.UTC(2026, 9, 10, 6, 0, 0);                    // 10 Oct 2026, 11:30 in Colombo
const iso = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);
const HOUR = 3600e3;

/** A book with one of everything that can be texted. */
const books = (settings = {}) => ({
    settings: { currency: 'LKR', owner_sms: { enabled: true, phone: '0771234567', at: 1, verifiedPhone: '+94771234567' }, ...settings },
    loans: [{ id: 'l1', name: 'Vehicle', monthly: 50000, start: `2026-01-${iso(3).slice(-2)}`, duration: 36, payments: [] }],
    cconetime: [{ id: 'c1', desc: 'Sofa', amount: 8000, deadline: iso(7) }],
    cheques: [{ id: 'q1', number: '1234', amount: 20000, release: iso(1), status: 'pending' }],
    subscriptions: [
        { id: 'o1', name: 'Licence', amount: 45000, cycle: 'once', dueDate: iso(5), createdAt: iso(-20) },
        { id: 'b1', name: 'Internet', amount: 6000, cycle: 'monthly', dueDay: Number(iso(2).slice(-2)), createdAt: iso(-60) },
    ],
    income: [{ id: 'i1', name: 'FD', amount: 500000, rate: 24, freq: 'monthly', day: 5, start: iso(-60), createdAt: new Date(NOW - HOUR).toISOString(), sms_notifications_enabled: true, sms_enabled_at: NOW - 2 * HOUR, nic: '853400937V', phone: '0771111111' }],
    debtors: [{
        id: 'd1', name: 'D', phone: '0772222222', nic: '853400937V', sms_notifications_enabled: true, sms_enabled_at: NOW - 2 * HOUR,
        sms_remind_late: true, sms_remind_at: NOW - 2 * HOUR, dueISO: iso(-3),
        events: [
            { id: 'e1', kind: 'lent', amount: 50000, date: iso(-1), confirmed: true, at: NOW - HOUR },
            { id: 'r1', kind: 'repayment', amount: 10000, date: iso(0), confirmed: true, at: NOW - 600e3 },
        ],
    }],
});
const kindsOf = (u) => [...new Set(deriveEvents(u, NOW).events.map((e) => categoryOfEvent(e)))].sort();

describe('the stored shape', () => {
    it('lists eight kinds in two groups, and every one has words for the screen', () => {
        expect(CATEGORY_KEYS).toEqual(['loan', 'card', 'cheque', 'once', 'bill', 'investments', 'debtors', 'late']);
        expect(CATEGORIES.filter((c) => c.group === 'own')).toHaveLength(5);
        for (const c of CATEGORIES) { expect(c.label.length).toBeGreaterThan(3); expect(c.hint.length).toBeGreaterThan(10); }
    });
    it('a kind nobody touched is ON; only an explicit off turns it off', () => {
        expect(categoryOn(undefined, 'loan')).toBe(true);
        expect(categoryOn({}, 'loan')).toBe(true);
        expect(categoryOn({ [CATS_FIELD]: 'garbage' }, 'loan')).toBe(true);
        expect(categoryOn({ [CATS_FIELD]: { loan: { on: false, at: 5 } } }, 'loan')).toBe(false);
        expect(categoryOn({ [CATS_FIELD]: { loan: { on: false, at: 5 } } }, 'card')).toBe(true);
    });
    it('withCategory returns a new settings object, keeps the other switches, and ignores a kind it does not know', () => {
        const s0 = { currency: 'LKR', [CATS_FIELD]: { card: { on: false, at: 1 } } };
        const s1 = withCategory(s0, 'loan', false, 100);
        expect(s1[CATS_FIELD]).toEqual({ card: { on: false, at: 1 }, loan: { on: false, at: 100 } });
        expect(s0[CATS_FIELD].loan).toBeUndefined();
        expect(s1.currency).toBe('LKR');
        expect(withCategory(s0, 'nonsense', false, 100)).toBe(s0);
        expect(categorySince(withCategory(s0, 'loan', true, 777), 'loan')).toBe(777);
        expect(categorySince(s1, 'loan')).toBe(0);                         // off: no "since"
        expect(categoryList(s1).find((c) => c.key === 'loan').on).toBe(false);
    });
});

describe('what the server derives', () => {
    it('with nothing switched off, every kind of text is owed (nothing changes the day this ships)', () => {
        expect(kindsOf(books())).toEqual(['bill', 'card', 'cheque', 'debtors', 'investments', 'late', 'loan', 'once']);
    });
    it('each kind switched off removes exactly that kind', () => {
        for (const key of CATEGORY_KEYS) {
            const u = books({ [CATS_FIELD]: { [key]: { on: false, at: NOW - HOUR } } });
            expect(kindsOf(u), key).toEqual(CATEGORY_KEYS.filter((k) => k !== key).sort());
        }
    });
    it('every kind off leaves nothing to send', () => {
        const all = Object.fromEntries(CATEGORY_KEYS.map((k) => [k, { on: false, at: 1 }]));
        expect(deriveEvents(books({ [CATS_FIELD]: all }), NOW).events).toEqual([]);
    });
    it('a switched-off kind does not nag about its own records (no-phone issues are hidden), the others still do', () => {
        const u = books(); u.debtors[0].phone = ''; u.income[0].phone = '';
        const both = deriveEvents(u, NOW).issues.map((i) => i.recordKind).sort();
        expect(both).toEqual(['debtor', 'investment']);
        const offDebtors = deriveEvents({ ...u, settings: { ...u.settings, [CATS_FIELD]: { debtors: { on: false, at: 1 } } } }, NOW).issues.map((i) => i.recordKind);
        expect(offDebtors).toEqual(['investment']);
    });
    it('switched back on, what happened while it was off is history, but what is still ahead or still owing resumes at once', () => {
        const before = deriveEvents(books(), NOW).events;
        const receipt = before.find((e) => e.key === 'B:d1:r1:in');
        expect(receipt).toBeTruthy();                                       // confirmed 10 minutes ago
        const backOn = books({ [CATS_FIELD]: { debtors: { on: true, at: NOW } } });    // switched back on just now: the receipt was before that
        const events = deriveEvents(backOn, NOW).events;
        expect(events.some((e) => e.key === 'B:d1:r1:in')).toBe(true);     // inside the ten-minute grace, as the record's own switch treats it
        const later = deriveEvents(books({ [CATS_FIELD]: { debtors: { on: true, at: NOW + 2 * HOUR } } }), NOW + 2 * HOUR).events;
        expect(later.some((e) => e.key === 'B:d1:r1:in')).toBe(false);     // switched on two hours after: the repayment is old news
        expect(later.some((e) => categoryOfEvent(e) === 'late')).toBe(true);   // a reminder is about what is still owing, so it resumes
        expect(later.some((e) => categoryOfEvent(e) === 'loan')).toBe(true);
    });
    it('filterEvents leaves a notice with no kind (the portal code) alone', () => {
        const ev = [{ kind: 'otp', occurredAt: 1 }];
        expect(filterEvents({ [CATS_FIELD]: { loan: { on: false } } }, ev)).toEqual(ev);
    });
});

describe('through the real sweep', () => {
    const gw = () => { const sent = []; return { sent, configured: true, senderId: 'WealthFlow', async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: `g${sent.length}`, cost: 1, segments: 1 }; } }; };
    const run = (db, user, client, now = NOW) => sweepUser({ db, uid: 'u1', user, client, now, env: {}, deps: { random: () => 0.5 } });

    it('a text of a switched-off kind is never sent, the others are', async () => {
        const { db } = createFirestore({ 'wf-sms/u1': { ownerVerified: { phone: '+94771234567', at: 1 } } });
        const client = gw();
        await run(db, books({ [CATS_FIELD]: { loan: { on: false, at: 1 }, debtors: { on: false, at: 1 } } }), client, NOW + 4 * HOUR);
        const bodies = client.sent.map((m) => m.message);
        expect(bodies.some((b) => /LOAN INSTALMENT/.test(b))).toBe(false);
        expect(bodies.some((b) => /REPAYMENT RECEIVED|LOAN PAID OUT/.test(b))).toBe(false);
        expect(bodies.some((b) => /CHEQUE CLEARS/.test(b))).toBe(true);
    });

    it('a text already waiting for a kind that is then switched off is cancelled before it goes', async () => {
        const { db } = createFirestore({ 'wf-sms/u1': { ownerVerified: { phone: '+94771234567', at: 1 } } });
        const down = { configured: false, senderId: 'WealthFlow', async send() { return { ok: false }; } };
        const first = await run(db, books(), down);                          // everything owed is queued; the gateway is not set up
        expect(first.derived).toBeGreaterThan(5);
        const second = await run(db, books({ [CATS_FIELD]: { cheque: { on: false, at: NOW + 1 } } }), down);
        expect(second.cancelled).toBe(1);
        const client = gw();
        await run(db, books({ [CATS_FIELD]: { cheque: { on: false, at: NOW + 1 } } }), client, NOW + 4 * HOUR);
        expect(client.sent.some((m) => /CHEQUE/.test(m.message))).toBe(false);
        expect(client.sent.length).toBeGreaterThan(3);
    });
});

describe('the Settings section', () => {
    it('draws one switch per kind, reflects what is stored, and says plainly when the owner\'s own number is not set up', () => {
        const html = categoriesHtml({ [CATS_FIELD]: { cheque: { on: false, at: 1 } } }, { enabled: false, verified: '' });
        for (const c of CATEGORIES) expect(html).toContain(`data-sms-cat="${c.key}"`);
        expect(html.match(/class="toggle on"/g)).toHaveLength(7);
        expect(html).toMatch(/data-sms-cat="cheque"[^>]*aria-checked="false"/);
        expect(html).toContain('Alerts to my own number');
        expect(html).toContain('WFSms.flipCategory');
    });
    it('shows the verified number when the own-number alerts are on', () => {
        const html = categoriesHtml({}, { enabled: true, verified: '+94771234567' });
        expect(html).toContain('Alerts to your own number are on');
        expect(html).not.toContain('only when "Alerts to my own number" is on');
    });
    it('a change to a switch changes the signature that tells the page the server must look again', () => {
        const u = books();
        const a = signatureOf(u);
        const b = signatureOf({ ...u, settings: { ...u.settings, [CATS_FIELD]: { loan: { on: false, at: 5 } } } });
        expect(a).not.toBe('');
        expect(b).not.toBe(a);
    });
});
