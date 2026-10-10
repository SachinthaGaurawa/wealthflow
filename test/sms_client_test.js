/* =============================================================================
 * test/sms_client_test.js — the page's side of the text messages
 * -----------------------------------------------------------------------------
 * The page holds no authority: it flips a switch on a record, nudges the server, and
 * shows what the server mirrored back. What is pinned here is that the switch is
 * validated and stamped correctly, that the nudge goes out when (and only when)
 * something the server cares about changed, that it survives a bad network and a
 * refused account without hammering anyone, and that a delivery is announced once.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    SMS_FIELDS, CLIENT, BALANCE, CLOSED_END_WAS, balanceWaitMs, requestBalance, applyToggle, closeInvestment, reopenInvestment, carry, blockHtml, readBlock, signatureOf, countOn, createNotifier, toastFor, announce, heldAlerts, HELD_NOTICE, watchSmsLog, rowsOf, panelHtml, describeIssue, ALERT_TITLE, boot,
} from '../wealthflow-sms.js';
import { FIELDS } from '../sms-events.mjs';

const T0 = Date.parse('2026-10-05T05:00:00Z');

describe('the fields are the server\'s fields', () => {
    it('the page and the server read and write the same ten names', () => {
        expect(SMS_FIELDS).toEqual({ ENABLED: FIELDS.ENABLED, ENABLED_AT: FIELDS.ENABLED_AT, PHONE: FIELDS.PHONE, PHONE2: FIELDS.PHONE2, PHONE2_AT: FIELDS.PHONE2_AT, CLOSED_AT: FIELDS.CLOSED_AT, NIC: FIELDS.NIC, REQUESTS: FIELDS.REQUESTS, REMIND: FIELDS.REMIND, REMIND_AT: FIELDS.REMIND_AT });
    });
});

describe('the switch', () => {
    it('off is just the boolean: nothing else is touched', () => {
        expect(applyToggle({}, { enabled: false, phone: 'garbage' })).toEqual({ ok: true, fields: { sms_notifications_enabled: false }, errors: {} });
        expect(applyToggle({}, null).fields).toEqual({ sms_notifications_enabled: false });
    });

    it('on needs a real mobile number and stamps the moment; the number is stored the way the server and every device read it (E.164)', () => {
        const r = applyToggle({}, { enabled: true, phone: ' 077 123 4567 ', nic: '' }, T0);
        expect(r).toMatchObject({ ok: true, fields: { sms_notifications_enabled: true, sms_enabled_at: T0, phone: '+94771234567', nic: '' } });
    });

    it('works for Sri Lankan mobile numbers only, in whatever way they are typed; a country, if a caller still sends one, is ignored', () => {
        expect(applyToggle({}, { enabled: true, phone: '+94 77 123 4567' }, T0).fields.phone).toBe('+94771234567');
        expect(applyToggle({}, { enabled: true, phone: '0771234567', country: 'AE' }, T0).fields.phone).toBe('+94771234567');
        expect(applyToggle({}, { enabled: true, phone: '(077) 123-4567' }, T0).fields.phone).toBe('+94771234567');
    });

    it('a number of another country is refused with the sentence that says the text service reaches Sri Lanka only', () => {
        for (const [phone, country] of [['+44 7911 123456'], ['050 123 4567', 'AE'], ['07911 123456', 'GB'], ['(415) 555-2671', 'US'], ['+1 415 555 2671']]) {
            const r = applyToggle({}, { enabled: true, phone, country }, T0);
            expect(r.ok, phone).toBe(false);
            expect(r.errors.phone, phone).toMatch(/Sri Lankan mobile|10 digits|07X/);
        }
        expect(applyToggle({}, { enabled: true, phone: '+44 7911 123456' }, T0).errors.phone).toMatch(/does not deliver to other countries/);
    });

    it('a passport or national ID stands in for an NIC, stored with a prefix so the two can never be confused', () => {
        const r = applyToggle({}, { enabled: true, phone: '0771234567', nic: ' x-1234 567 ', idKind: 'other' }, T0);
        expect(r).toMatchObject({ ok: true, fields: { nic: 'ID:X1234567' } });
        expect(applyToggle({}, { enabled: true, phone: '0771234567', nic: 'ID:X1234567' }, T0).fields.nic).toBe('ID:X1234567');   // already in its stored form
        const bad = applyToggle({}, { enabled: true, phone: '0771234567', nic: 'a', idKind: 'other' }, T0);
        expect(bad.ok).toBe(false);
        expect(bad.errors.nic).toMatch(/passport/i);
    });

    it('refuses a number that is not a number the gateway can reach, with a sentence the owner can act on', () => {
        for (const phone of ['', '12345', '0112345678', 'call me', '++94771234567']) {
            const r = applyToggle({}, { enabled: true, phone }, T0);
            expect(r.ok, phone).toBe(false);
            expect(r.errors.phone.length).toBeGreaterThan(10);
            expect(r.fields).toEqual({});
        }
    });

    it('takes an NIC in either spelling, cleaned, and refuses one that is not an NIC', () => {
        expect(applyToggle({}, { enabled: true, phone: '0771234567', nic: ' 85.3400937-v ' }, T0).fields.nic).toBe('853400937V');
        expect(applyToggle({}, { enabled: true, phone: '0771234567', nic: '1985-3400-0937' }, T0).fields.nic).toBe('198534000937');
        const bad = applyToggle({}, { enabled: true, phone: '0771234567', nic: '12345' }, T0);
        expect(bad.ok).toBe(false);
        expect(bad.errors.nic).toBeTruthy();
        expect(bad.errors.phone).toBeUndefined();
    });

    it('editing a record that is already on keeps its stamp, so its history is never re-announced', () => {
        const prev = { sms_notifications_enabled: true, sms_enabled_at: T0 - 5 * 86400000, phone: '0771234567' };
        expect(applyToggle(prev, { enabled: true, phone: '0771234567' }, T0).fields.sms_enabled_at).toBe(T0 - 5 * 86400000);
    });

    it('off and on again is a new stamp: what happened while it was off is not news', () => {
        const prev = { sms_notifications_enabled: false, sms_enabled_at: T0 - 5 * 86400000 };
        expect(applyToggle(prev, { enabled: true, phone: '0771234567' }, T0).fields.sms_enabled_at).toBe(T0);
    });

    it('carry() hands a form that rebuilds its record the four fields it would otherwise drop', () => {
        const prev = { id: 'x', amount: 5, sms_notifications_enabled: true, sms_enabled_at: 7, phone: '077', nic: '853400937V', other: 1 };
        expect(carry(prev)).toEqual({ sms_notifications_enabled: true, sms_enabled_at: 7, phone: '077', nic: '853400937V' });
        expect(carry(null)).toEqual({});
        expect(carry({ amount: 1 })).toEqual({});
    });
});

describe('the markup', () => {
    it('is only the switch: the number and the NIC / passport belong to the person and live in the contact fields', () => {
        const html = blockHtml('i_sms', { record: { phone: '"><script>alert(1)</script>', nic: '\'x', sms_notifications_enabled: true } });
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('i_sms_phone');
        expect(html).not.toContain('i_sms_nic');
        expect(html).not.toContain('alert(1)');
        expect(html).toContain(' checked');
        expect(blockHtml('i_sms', { record: { sms_notifications_enabled: false } })).not.toContain(' checked');
    });
    it('every id starts with the prefix, which is escaped', () => {
        const html = blockHtml('a"b', { layer: 'A' });
        expect(html).not.toContain('a"b');
        expect(html).toContain('a&quot;b_on');
        expect(html).toContain('a&quot;b_err');
    });
    it('shows the right promise for each layer, and no interest on loans', () => {
        expect(blockHtml('a', { layer: 'A' })).toContain('interest is applied');
        const b = blockHtml('b', { layer: 'B' });
        expect(b).toContain('never carry interest');
        expect(b).not.toContain('b_phone');
    });
    it('has no emoji, and tells the owner it works for Sri Lankan mobile numbers and about the statement link', () => {
        for (const layer of ['A', 'B']) {
            const html = blockHtml('x', { layer });
            expect(/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html)).toBe(false);
            expect(html).toMatch(/private link to a statement page/);
            expect(html).toMatch(/one-time code/);
            expect(html).toMatch(/Sri Lankan mobile number/);
            expect(html).toMatch(/passport/);
        }
    });
    it('reads a block back, and says null when it is not on the page', () => {
        const els = { '#x_on': { checked: true }, '#x_phone': { value: '077 1' }, '#x_nic': { value: '8534' } };
        const root = { querySelector: (sel) => els[sel] || null };
        expect(readBlock(root, 'x')).toEqual({ enabled: true, phone: '077 1', nic: '8534', hasPhone: true });
        expect(readBlock({ querySelector: () => null }, 'x')).toBeNull();
        expect(readBlock(null, 'x')).toBeNull();
    });
});

describe('what the server cares about: signatureOf', () => {
    const inv = (over = {}) => ({ id: 'i1', name: 'FD', amount: 500000, rate: 24, sms_notifications_enabled: true, sms_enabled_at: 1, phone: '0771234567', ...over });
    const deb = (over = {}) => ({ id: 'd1', name: 'Nimal', sms_notifications_enabled: true, sms_enabled_at: 1, phone: '0771234567', events: [{ id: 'e1', kind: 'lent', amount: 100, confirmed: true }], ...over });

    it('is empty until a record has ever carried the switch', () => {
        expect(signatureOf(null)).toBe('');
        expect(signatureOf({})).toBe('');
        expect(signatureOf({ income: [{ id: 'x', amount: 1 }], debtors: [{ id: 'y' }] })).toBe('');
    });
    it('is stable: the same books give the same string, whatever order the keys come in', () => {
        const a = signatureOf({ income: [inv()], debtors: [deb()] });
        expect(a).toMatch(/^[0-9a-f]{16}-[0-9a-z]+$/);
        expect(signatureOf({ debtors: [deb()], income: [{ ...inv() }] })).toBe(a);
        expect(signatureOf({ income: [Object.fromEntries(Object.entries(inv()).reverse())], debtors: [deb()] })).toBe(a);
    });
    it('changes when anything the notices are made from changes', () => {
        const base = signatureOf({ income: [inv()], debtors: [deb()] });
        const changed = [
            { income: [inv({ amount: 600000 })], debtors: [deb()] },
            { income: [inv({ phone: '0779999999' })], debtors: [deb()] },
            { income: [inv()], debtors: [deb({ events: [{ id: 'e1', kind: 'lent', amount: 100, confirmed: true }, { id: 'e2', kind: 'repayment', amount: 10, confirmed: false }] })] },
            { income: [inv()], debtors: [deb({ events: [{ id: 'e1', kind: 'lent', amount: 100, confirmed: false }] })] },
            { income: [inv({ sms_notifications_enabled: false })], debtors: [deb()] },
            { income: [inv()], debtors: [deb()], incomeReceived: { 'i1_2026-10': { amount: 1, at: 5 } } },
            { income: [inv()], debtors: [deb()], settings: { currency: 'USD' } },
        ];
        for (const u of changed) expect(signatureOf(u)).not.toBe(base);
    });
    it('does not change for what the notices are not made from', () => {
        const base = signatureOf({ income: [inv()], debtors: [deb()], incomeReceived: { 'other_2026-10': { amount: 1 } } });
        expect(signatureOf({ income: [inv({ _ut: 99 })], debtors: [deb({ _ut: 5 })], incomeReceived: { 'other_2026-10': { amount: 2 } }, expenses: [{ id: 'z', amount: 1 }] })).toBe(base);
        expect(signatureOf({ income: [inv({ notes: 'x'.repeat(5000) })], debtors: [deb()] })).toBe(signatureOf({ income: [inv({ notes: 'y'.repeat(5000) })], debtors: [deb()] }));
    });
    it('countOn counts the records that are switched on', () => {
        expect(countOn({ income: [inv(), inv({ sms_notifications_enabled: false })], debtors: [deb()] })).toBe(2);
        expect(countOn(null)).toBe(0);
    });
});

/* ── the notifier, with a hand-cranked clock and a scripted server ─────────── */

function rig(over = {}) {
    const timers = []; let id = 0; const calls = []; const store = new Map();
    const user = over.user || { income: [{ id: 'i1', amount: 1, sms_notifications_enabled: true, sms_enabled_at: 1, phone: '0771234567' }] };
    const script = over.script || [];
    let uid = over.uid === undefined ? 'u1' : over.uid;
    const tokens = [];
    const n = createNotifier({
        getUser: () => user, getUid: () => uid,
        getIdToken: async (force) => { tokens.push(!!force); return over.noToken ? null : (force ? 'fresh-token' : 'token'); },
        fetchImpl: async (url, init) => {
            calls.push({ url, init, body: JSON.parse(init.body) });
            const r = script.length ? script.shift() : { status: 200, body: { ok: true, summary: { sent: 1 } } };
            if (r.throw) throw new Error('offline');
            return { status: r.status, json: async () => r.body };
        },
        now: () => T0,
        storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
        setTimer: (fn, ms) => { id += 1; timers.push({ id, fn, ms }); return id; },
        clearTimer: (t) => { const i = timers.findIndex((x) => x.id === t); if (i > -1) timers.splice(i, 1); },
    });
    const fire = async () => { const t = timers.shift(); if (!t) return null; await t.fn(); await new Promise((r) => setTimeout(r, 0)); return t.ms; };
    return { n, calls, timers, store, tokens, fire, user, setUid: (v) => { uid = v; } };
}

describe('the nudge', () => {
    it('asks the server once, after a short wait, with the caller\'s token and no instructions', async () => {
        const r = rig();
        expect(r.n.afterPush()).toBe(true);
        expect(r.calls).toHaveLength(0);
        expect(await r.fire()).toBe(CLIENT.DEBOUNCE_MS);
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0].url).toBe('/api/sms-notify');
        expect(r.calls[0].init.headers.Authorization).toBe('Bearer token');
        expect(Object.keys(r.calls[0].body).sort()).toEqual(['force', 'reason']);           // nothing to send, nobody to send it to
        expect(r.calls[0].init.body).not.toMatch(/phone|amount|0771234567|message|to"/);
    });

    it('a burst of saves is one request, and an unchanged book is none', async () => {
        const r = rig();
        r.n.afterPush(); r.n.afterPush(); r.n.afterPush();
        expect(r.timers).toHaveLength(1);
        await r.fire();
        expect(r.calls).toHaveLength(1);
        expect(r.n.afterPush()).toBe(false);                                    // the answer was written down: nothing has changed since
        r.user.income[0].amount = 2;
        expect(r.n.afterPush()).toBe(true);
    });

    it('an account that has never used SMS makes no request at all, on a save or on opening the page', () => {
        const r = rig({ user: { income: [{ id: 'x', amount: 1 }] } });
        expect(r.n.afterPush()).toBe(false);
        expect(r.n.onOpen('open')).toBe(false);
        expect(r.timers).toHaveLength(0);
    });

    it('opening the page asks once, after the cloud copy has landed, to drain what was held', async () => {
        const r = rig();
        expect(r.n.onOpen('open')).toBe(true);
        expect(await r.fire()).toBe(CLIENT.OPEN_DELAY_MS);
        expect(r.calls[0].body.reason).toBe('open');
    });

    it('switching the last record off still tells the server, so what is queued is cancelled', async () => {
        const r = rig();
        r.n.afterPush(); await r.fire();
        r.user.income = [];                                                      // everything removed
        r.store.set('wf_sms_sig_u1', r.store.get('wf_sms_sig_u1'));
        expect(r.n.afterPush()).toBe(true);
    });

    it('a refused account (403) is told once and never asked again this session', async () => {
        const r = rig({ script: [{ status: 403, body: { ok: false } }] });
        r.n.afterPush(); await r.fire();
        expect(r.n.state.disabled).toBe(true);
        expect(r.n.afterPush()).toBe(false);
        expect(r.n.onOpen('open')).toBe(false);
        expect(r.calls).toHaveLength(1);
    });

    it('a rejected token gets one forced refresh, then the request succeeds', async () => {
        const r = rig({ script: [{ status: 401, body: {} }, { status: 200, body: { ok: true, summary: {} } }] });
        r.n.afterPush(); await r.fire();
        expect(r.tokens).toEqual([false, true]);
        expect(r.calls.map((c) => c.init.headers.Authorization)).toEqual(['Bearer token', 'Bearer fresh-token']);
        expect(r.n.state.lastError).toBeNull();
    });

    it('a server that says "too soon" is asked again shortly, twice at most', async () => {
        const r = rig({ script: Array.from({ length: 5 }, () => ({ status: 200, body: { ok: true, throttled: true } })) });
        r.n.afterPush(); await r.fire();
        expect(await r.fire()).toBe(CLIENT.THROTTLE_RETRY_MS);
        expect(await r.fire()).toBe(CLIENT.THROTTLE_RETRY_MS);
        expect(await r.fire()).toBeNull();
        expect(r.calls).toHaveLength(3);
    });

    it('a bad network backs off 8 s, 40 s, 3 min and then leaves it to the daily sweep', async () => {
        const r = rig({ script: Array.from({ length: 6 }, () => ({ throw: true })) });
        r.n.afterPush();
        const waits = [await r.fire(), await r.fire(), await r.fire(), await r.fire()];
        expect(waits).toEqual([CLIENT.DEBOUNCE_MS, ...CLIENT.RETRY_MS]);
        expect(await r.fire()).toBeNull();
        expect(r.calls).toHaveLength(4);
        expect(r.n.state.lastError).toMatch(/reach/i);
        expect(r.store.has('wf_sms_sig_u1')).toBe(false);                     // not written down: the next save or visit tries again
    });

    it('a 5xx is retried the same way, and recovers', async () => {
        const r = rig({ script: [{ status: 503, body: {} }, { status: 200, body: { ok: true, summary: {} } }] });
        r.n.afterPush(); await r.fire(); await r.fire();
        expect(r.calls).toHaveLength(2);
        expect(r.n.state.retries).toBe(0);
        expect(r.store.has('wf_sms_sig_u1')).toBe(true);
    });

    it('while messages are waiting it looks again every ten minutes, but not forever', async () => {
        const r = rig({ script: Array.from({ length: 40 }, () => ({ status: 200, body: { ok: true, summary: { held: 1 } } })) });
        r.n.afterPush(); await r.fire();
        let drains = 0;
        for (let i = 0; i < 40; i += 1) { const ms = await r.fire(); if (ms === null) break; if (ms === CLIENT.DRAIN_MS) drains += 1; }
        expect(drains).toBe(CLIENT.MAX_DRAINS);
    });

    it('nothing is sent when nobody is signed in, or the token cannot be had', async () => {
        const a = rig({ uid: '' });
        expect(a.n.afterPush()).toBe(false);
        expect(await a.n.run()).toEqual({ skipped: 'no-user' });
        const b = rig({ noToken: true });
        b.n.afterPush(); await b.fire();
        expect(b.calls).toHaveLength(0);
    });

    it('two runs at once do not overlap', async () => {
        const r = rig();
        const [x, y] = await Promise.all([r.n.run({ sig: 'a' }), r.n.run({ sig: 'a' })]);
        expect([x, y].some((v) => v && v.skipped === 'busy')).toBe(true);
        expect(r.calls).toHaveLength(1);
    });
});

describe('the alert', () => {
    const sent = (id, sentAt, extra = {}) => ({ id, status: 'sent', sentAt, to: '+94*****4567', ref: 'DEB-1', alert: ALERT_TITLE, updatedAt: sentAt, ...extra });

    it('says the words the owner asked for, with the masked number and the reference', () => {
        expect(toastFor(sent('a', 1))).toEqual({ tone: 'success', text: 'Admin Alert: SMS Delivered Successfully to Tenant', detail: 'to +94*****4567, DEB-1' });
        expect(toastFor({ id: 'q', status: 'queued' })).toBeNull();
        expect(toastFor(null)).toBeNull();
        expect(toastFor({ id: 'f', status: 'failed', to: '+94*****4567', ref: 'INV-1', error: { message: 'blocked' } })).toMatchObject({ tone: 'error', text: 'SMS could not be delivered' });
    });

    it('announces a delivery once, however many snapshots mention it', () => {
        let mem = { seenSentAt: 0, boundaryIds: new Set(), knownFailed: new Set(), first: true };
        const rows = [sent('a', 1000)];
        let out = announce(rows, mem);
        expect(out.toasts).toHaveLength(1);
        mem = { ...out, first: false };
        out = announce(rows, mem);
        expect(out.toasts).toHaveLength(0);
    });

    it('announces EVERY message of a sweep, though they all carry the same sentAt and arrive one write at a time', () => {
        let mem = { seenSentAt: 0, boundaryIds: new Set(), knownFailed: new Set(), first: true };
        const shown = [];
        const feed = (rows) => { const out = announce(rows, mem); mem = { ...out, first: false }; shown.push(...out.toasts); };
        feed([]);                                                              // the listener attaches to an empty log
        feed([sent('a', 5000)]);
        feed([sent('a', 5000), sent('b', 5000)]);
        feed([sent('a', 5000), sent('b', 5000), sent('c', 5000)]);
        feed([sent('a', 5000), sent('b', 5000), sent('c', 5000)]);             // a later, unrelated update of the same docs
        expect(shown).toHaveLength(3);
        feed([sent('d', 6000), sent('a', 5000), sent('b', 5000), sent('c', 5000)]);
        expect(shown).toHaveLength(4);
    });

    it('after time away, one summary instead of a pile; with one or two, they are shown as they are', () => {
        const first = { seenSentAt: 100, boundaryIds: new Set(), knownFailed: new Set(), first: true };
        const many = announce([sent('a', 200), sent('b', 201), sent('c', 202), sent('d', 203), sent('old', 50)], first);
        expect(many.toasts).toHaveLength(1);
        expect(many.toasts[0].detail).toBe('4 messages were delivered since you were last here');
        expect(many.seenSentAt).toBe(203);
        const two = announce([sent('a', 200), sent('b', 201)], first);
        expect(two.toasts).toHaveLength(2);
    });

    it('a failure is announced when it happens while the page is open, not for every old one on every load', () => {
        const failed = { id: 'f', status: 'failed', to: '+94*****1', ref: 'X', updatedAt: 10, error: { message: 'no' } };
        let out = announce([failed], { seenSentAt: 0, boundaryIds: new Set(), knownFailed: new Set(), first: true });
        expect(out.toasts).toHaveLength(0);
        out = announce([failed, { ...failed, id: 'g', updatedAt: 20 }], { ...out, first: false });
        expect(out.toasts).toHaveLength(1);
        out = announce([failed, { ...failed, id: 'g', updatedAt: 20 }], { ...out, first: false });
        expect(out.toasts).toHaveLength(0);
    });

    it('the status document is never announced as a message', () => {
        expect(announce([{ id: '_status', status: 'sent', sentAt: 99 }], { seenSentAt: 0, first: false }).toasts).toEqual([]);
    });

    it('the listener remembers what it announced across page loads', () => {
        const store = new Map();
        const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
        let handler; let unsubbed = false;
        const firestore = { collection: () => ({ doc: () => ({ collection: () => ({ orderBy: () => ({ limit: () => ({ onSnapshot: (ok) => { handler = ok; return () => { unsubbed = true; }; } }) }) }) }) }) };
        const toasts = []; const rowsSeen = [];
        const snap = (rows) => ({ docs: rows.map(({ id, ...rest }) => ({ id, data: () => rest })) });
        const unsub = watchSmsLog({ firestore, uid: 'u1', storage, onToast: (t) => toasts.push(t), onRows: (rows, status) => rowsSeen.push([rows.length, !!status]) });
        handler(snap([sent('a', 1000), { id: '_status', configured: true, issues: [] }]));
        expect(toasts).toHaveLength(1);
        expect(rowsSeen).toEqual([[1, true]]);
        expect(store.get('wf_sms_seen_u1')).toBe('1000');
        unsub(); expect(unsubbed).toBe(true);
        // a reload: same log, nothing new to say
        const toasts2 = [];
        watchSmsLog({ firestore, uid: 'u1', storage, onToast: (t) => toasts2.push(t) });
        handler(snap([sent('a', 1000)]));
        expect(toasts2).toHaveLength(0);
        handler(snap([sent('a', 1000), sent('b', 2000)]));
        expect(toasts2).toHaveLength(1);
    });

    it('a listener that cannot start, or a broken storage, costs the toast and nothing else', () => {
        const bad = { collection: () => { throw new Error('no firestore'); } };
        const errs = [];
        const unsub = watchSmsLog({ firestore: bad, uid: 'u', storage: null, onError: (e) => errs.push(e.message) });
        expect(typeof unsub).toBe('function');
        expect(errs).toEqual(['no firestore']);
        const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
        let handler;
        const fs = { collection: () => ({ doc: () => ({ collection: () => ({ orderBy: () => ({ limit: () => ({ onSnapshot: (ok) => { handler = ok; return () => {}; } }) }) }) }) }) };
        const toasts = [];
        watchSmsLog({ firestore: fs, uid: 'u', storage: throwing, onToast: (t) => toasts.push(t) });
        handler({ docs: [{ id: 'a', data: () => ({ status: 'sent', sentAt: 5, to: '+94*****1', ref: 'R' }) }] });
        expect(toasts).toHaveLength(1);
    });
});

describe('the log panel', () => {
    it('says why each waiting message is waiting', () => {
        const rows = rowsOf([
            { id: '1', status: 'queued', occurredAt: 3, error: { kind: 'credit' }, body: 'x' },
            { id: '2', status: 'queued', occurredAt: 2, error: { kind: 'cap' }, body: 'y' },
            { id: '3', status: 'failed', occurredAt: 1, error: { message: 'number is blocked' }, body: 'z' },
            { id: '4', status: 'sent', occurredAt: 4, sentAt: 9, possiblyDuplicated: true, body: 'w' },
            { id: '_status', status: 'x' },
        ], T0);
        expect(rows.map((r) => r.id)).toEqual(['4', '1', '2', '3']);
        expect(rows[1].note).toMatch(/credit/i);
        expect(rows[2].note).toMatch(/tomorrow/i);
        expect(rows[3].note).toBe('number is blocked');
        expect(rows[0].note).toMatch(/twice/);
        expect(rows[0].at).toBe(9);
    });

    it('describes what is switched on but cannot work, by name when it can', () => {
        const nameOf = (kind, id) => (id === 'd1' ? 'Nimal' : '');
        expect(describeIssue({ recordKind: 'debtor', recordId: 'd1', reason: 'no-phone' }, nameOf)).toBe('Nimal has no phone number, so nothing is sent');
        expect(describeIssue({ recordKind: 'investment', recordId: 'zz', reason: 'phone-not-a-mobile-number' }, nameOf)).toBe('An investment has a phone number that is not a mobile number');
        expect(describeIssue({ recordKind: 'debtor', reason: 'something-new' })).toBe('A debtor cannot send texts yet');
        expect(describeIssue(null, () => { throw new Error('x'); })).toMatch(/cannot send/);
    });

    it('draws it, escaped, with the gateway and credit warnings first', () => {
        const html = panelHtml({
            rows: rowsOf([{ id: 'a', status: 'sent', sentAt: 5, to: '+94*****4567', ref: 'DEB-1', body: '<img src=x onerror=alert(1)>' }], T0),
            status: { configured: false, lowCredit: true, units: 3, issues: [{ recordKind: 'debtor', recordId: 'd', reason: 'no-phone' }] },
            fmtWhen: () => 'today',
        });
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
        expect(html).toMatch(/TEXTLK_API_TOKEN/);
        expect(html).toMatch(/3 units left/);
        expect(html.indexOf('not connected')).toBeLessThan(html.indexOf('Sent'));
        expect(panelHtml({ rows: [] })).toMatch(/No text messages yet/);
        expect(panelHtml({ disabled: true })).toMatch(/not enabled for this account/);
    });

    it('warns when the scheduled sweep has not run lately, and says nothing while it has', () => {
        const day = 24 * 3600e3;
        const AT = Date.UTC(2026, 9, 20, 12);
        const fmt = () => 'then';
        // ran an hour ago: silent
        expect(panelHtml({ rows: [], status: { configured: true, autoRunAt: AT - 3600e3 }, now: AT, fmtWhen: fmt })).not.toMatch(/automatic daily check/);
        // last ran two days ago: warns, and names the setting
        const stale = panelHtml({ rows: [], status: { configured: true, autoRunAt: AT - 2 * day }, now: AT, fmtWhen: fmt });
        expect(stale).toMatch(/has not run since then/);
        expect(stale).toMatch(/CRON_SECRET/);
        // never stamped, long after the stamp existed: warns that it has not run yet; before the stamp existed, says nothing
        expect(panelHtml({ rows: [], status: { configured: true }, now: AT, fmtWhen: fmt })).toMatch(/has not run yet/);
        expect(panelHtml({ rows: [], status: { configured: true }, now: Date.UTC(2026, 9, 10), fmtWhen: fmt })).not.toMatch(/automatic daily check/);
        // no status at all: nothing to judge
        expect(panelHtml({ rows: [], now: AT })).not.toMatch(/automatic daily check/);
    });

    it('says plainly that late-payment reminders are paused under the credit reserve, and only then', () => {
        const paused = panelHtml({ rows: [], status: { configured: true, units: 12, reserve: 20, creditPaused: true } });
        expect(paused).toMatch(/Late-payment reminders are paused: 12 units are left, under the reserve of 20/);
        expect(paused).toMatch(/Receipts and closing notices still go out/);
        expect(panelHtml({ rows: [], status: { configured: true, units: 90, reserve: 20, creditPaused: false } })).not.toMatch(/paused/);
        expect(panelHtml({ rows: [], status: { configured: true, units: 12 } })).not.toMatch(/paused/);
    });

    it('never claims a pause the reading does not show: no reserve, a figure over the reserve, or no figure at all', () => {
        const say = (status) => panelHtml({ rows: [], status: { configured: true, ...status } });
        expect(say({ units: 8, reserve: 0, creditPaused: true })).not.toMatch(/paused/);          // a stale flag from the time the reserve was on
        expect(say({ units: 50, reserve: 20, creditPaused: true })).not.toMatch(/paused/);
        expect(say({ units: null, lowCredit: true, creditPaused: true, reserve: 20 })).not.toMatch(/running low|paused/);
    });

    it('says the figure when the credit really is zero, and when it was read', () => {
        const html = panelHtml({ rows: [], fmtWhen: () => '09 Oct, 12:00', status: { configured: true, units: 0, lowCredit: true, unitsAt: 1 } });
        expect(html).toMatch(/SMS credit is running low: 0 units left \(read 09 Oct, 12:00\)/);
    });
});

describe('starting up in a page', () => {
    function fakeWindow(over = {}) {
        const timers = []; const listeners = {}; const store = new Map(); const fetches = []; let snapshotHandler = null; const toasts = [];
        const win = {
            _isDecoyMode: false,
            appData: { income: [{ id: 'i1', amount: 1, sms_notifications_enabled: true, sms_enabled_at: 1, phone: '0771234567' }], debtors: [] },
            currentUser: null,
            notify: (m, t) => toasts.push([m, t]),
            localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
            document: { visibilityState: 'visible', addEventListener: (e, f) => { listeners[e] = f; } },
            addEventListener: (e, f) => { listeners[e] = f; },
            fetch: async (url, init) => { fetches.push({ url, init }); return { status: 200, json: async () => ({ ok: true, summary: {} }) }; },
            firebase: { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ orderBy: () => ({ limit: () => ({ onSnapshot: (ok) => { snapshotHandler = ok; return () => {}; } }) }) }) }) }) }) },
            setInterval: (fn) => { timers.push(fn); return timers.length; },
            clearInterval: (i) => { timers[i - 1] = null; },
            setTimeout: (fn) => { fn(); return 0; },
            requestAnimationFrame: (fn) => fn(),
            ...over,
        };
        return { win, timers, listeners, fetches, toasts, snapshot: (rows) => snapshotHandler({ docs: rows.map(({ id, ...rest }) => ({ id, data: () => rest })) }) };
    }
    const user = (uid = 'u1') => ({ uid, getIdToken: async () => 'tok' });

    it('waits quietly for a sign-in, then starts once and stops looking', () => {
        const f = fakeWindow();
        const api = boot(f.win);
        expect(f.timers).toHaveLength(1);
        f.timers[0]();                                                          // nobody signed in yet
        expect(f.timers[0]).not.toBeNull();
        f.win.currentUser = user();
        f.timers[0]();
        expect(f.timers[0]).toBeNull();                                         // started: stopped looking
        expect(typeof api.afterPush).toBe('function');
    });

    it('hands the page everything its forms call, closing an investment included', () => {
        const api = boot(fakeWindow().win);
        for (const name of ['applyToggle', 'closeInvestment', 'reopenInvestment', 'carry', 'blockHtml', 'readBlock', 'showBlockErrors']) expect(typeof api[name], name).toBe('function');
    });

    it('never starts under the duress PIN: the decoy books are not the owner\'s', () => {
        const f = fakeWindow({ _isDecoyMode: true, currentUser: user() });
        const api = boot(f.win);
        f.timers[0]();
        expect(f.timers[0]).not.toBeNull();
        expect(api.afterPush()).toBeUndefined();
        expect(f.fetches).toHaveLength(0);
    });

    it('announces a delivery with the app\'s own toast', () => {
        const f = fakeWindow({ currentUser: user() });
        boot(f.win); f.timers[0]();
        f.snapshot([{ id: 'a', status: 'sent', sentAt: 5, to: '+94*****4567', ref: 'DEB-1', alert: ALERT_TITLE }]);
        expect(f.toasts).toEqual([['Admin Alert: SMS Delivered Successfully to Tenant (to +94*****4567, DEB-1)', 'success']]);
    });

    it('starting never throws into the app, whatever the page looks like', () => {
        expect(() => boot({ ...fakeWindow().win, firebase: undefined, localStorage: undefined, currentUser: user() }).afterPush()).not.toThrow();
    });
});

describe('the file itself', () => {
    const src = readFileSync(new URL('../wealthflow-sms.js', import.meta.url), 'utf8');
    it('is a browser module: no Node imports, and never the gateway token', () => {
        expect(src).not.toMatch(/from\s+['"]node:/);
        expect(src).not.toMatch(/process\.env|require\(/);
        expect(src).not.toMatch(/Bearer [A-Za-z0-9]{20,}/);
        for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) expect(m[1]).toMatch(/^\.\/wealthflow-[a-z-]+\.js$/);
    });
});

describe('"Send balance": the owner asks for the balance to be texted', () => {
    const debtor = (over = {}) => ({ id: 'd1', name: 'Nimal', phone: '+94771234567', [SMS_FIELDS.ENABLED]: true, [SMS_FIELDS.ENABLED_AT]: T0 - 1e6, ...over });

    it('adds one request row, keeps the rest of the record exactly as it was, and never names an amount or a recipient', () => {
        const rec = debtor({ events: [{ id: 'e1' }], note: 'x' });
        const out = requestBalance(rec, { now: T0, newId: () => 'req-abc1' });
        expect(out).toEqual({ ok: true, record: { ...rec, [SMS_FIELDS.REQUESTS]: [{ id: 'req-abc1', at: T0 }] } });
        expect(JSON.stringify(out.record[SMS_FIELDS.REQUESTS])).not.toMatch(/amount|balance|phone|077|94/);
        expect(rec[SMS_FIELDS.REQUESTS]).toBeUndefined();                                    // the record it was given is not changed
    });

    it('makes ids the server accepts, different every time, even when random numbers are not available', () => {
        const ids = new Set();
        for (let i = 0; i < 50; i += 1) {
            const out = requestBalance(debtor(), { now: T0 + i * BALANCE.COOLDOWN_MS * 2 });
            const id = out.record[SMS_FIELDS.REQUESTS][0].id;
            expect(id).toMatch(/^[A-Za-z0-9_-]{4,40}$/);
            ids.add(id);
        }
        expect(ids.size).toBe(50);
    });

    it('refuses when the texts are off for this debtor, and says what to do', () => {
        for (const rec of [debtor({ [SMS_FIELDS.ENABLED]: false }), debtor({ [SMS_FIELDS.ENABLED]: undefined }), {}, null, undefined, 5]) {
            const out = requestBalance(rec, { now: T0 });
            expect(out.ok).toBe(false);
            expect(out.reason).toBe('off');
            expect(out.text).toMatch(/Send SMS notifications/);
        }
    });

    it('refuses when there is no number the text could reach', () => {
        for (const phone of ['', undefined, '12', 'abc', '+']) {
            const out = requestBalance(debtor({ phone }), { now: T0 });
            expect(out, String(phone)).toMatchObject({ ok: false, reason: 'phone' });
        }
    });

    it('waits ten minutes between two requests for the same debtor: a double tap spends one unit, not two', () => {
        const first = requestBalance(debtor(), { now: T0, newId: () => 'req-0001' });
        const again = requestBalance(first.record, { now: T0 + 60000 });
        expect(again).toMatchObject({ ok: false, reason: 'wait', waitMs: BALANCE.COOLDOWN_MS - 60000 });
        expect(again.text).toMatch(/9 min/);
        expect(balanceWaitMs(first.record, T0 + BALANCE.COOLDOWN_MS)).toBe(0);
        expect(requestBalance(first.record, { now: T0 + BALANCE.COOLDOWN_MS, newId: () => 'req-0002' }).ok).toBe(true);
        expect(BALANCE.COOLDOWN_MS).toBe(10 * 60000);
    });

    it('keeps only the last few requests on the record, newest last', () => {
        let rec = debtor();
        for (let i = 0; i < 9; i += 1) rec = requestBalance(rec, { now: T0 + i * BALANCE.COOLDOWN_MS, newId: () => `req-${String(i).padStart(4, '0')}` }).record;
        const ids = rec[SMS_FIELDS.REQUESTS].map((r) => r.id);
        expect(ids).toHaveLength(BALANCE.KEEP);
        expect(ids[ids.length - 1]).toBe('req-0008');
        expect(ids).not.toContain('req-0000');
    });

    it('a request stamped in the future (a wrong clock) does not lock the button for hours', () => {
        const rec = debtor({ [SMS_FIELDS.REQUESTS]: [{ id: 'req-0001', at: T0 + 5 * 3600e3 }] });
        expect(balanceWaitMs(rec, T0)).toBe(0);
        expect(requestBalance(rec, { now: T0 }).ok).toBe(true);
    });

    it('garbage in the request list changes nothing and throws nothing', () => {
        for (const bad of ['x', 5, {}, [null, 3, 'a', {}, { at: 'no' }]]) {
            const rec = debtor({ [SMS_FIELDS.REQUESTS]: bad });
            expect(() => balanceWaitMs(rec, T0)).not.toThrow();
            expect(balanceWaitMs(rec, T0)).toBe(0);
            expect(requestBalance(rec, { now: T0 }).ok).toBe(true);
        }
    });

    it('an edit of the record carries the requests on with the other switches', () => {
        const rec = debtor({ [SMS_FIELDS.REQUESTS]: [{ id: 'req-0001', at: T0 }] });
        expect(carry(rec)[SMS_FIELDS.REQUESTS]).toEqual([{ id: 'req-0001', at: T0 }]);
    });

    it('is a change the nudge notices, so the server is asked to look', () => {
        const before = { debtors: [debtor()] };
        const after = { debtors: [requestBalance(debtor(), { now: T0, newId: () => 'req-0001' }).record] };
        expect(signatureOf(before)).not.toBe(signatureOf(after));
    });

    it('the message log explains a balance that could not go out in time, in words an owner can act on', () => {
        const rows = rowsOf([
            { id: 'a', status: 'expired', kind: 'B.balance', occurredAt: T0, to: '+94*****4567', ref: 'DEB-1', body: 'Balance' },
            { id: 'b', status: 'cancelled', kind: 'B.balance', occurredAt: T0 + 1, to: '+94*****4567', ref: 'DEB-1', body: 'Balance' },
            { id: 'c', status: 'cancelled', kind: 'B.repayment', occurredAt: T0 + 2, to: '+94*****4567', ref: 'DEB-1', body: 'Repayment' },
        ], T0 + 3);
        expect(rows.find((r) => r.id === 'a').note).toMatch(/Press Send balance again/);
        expect(rows.find((r) => r.id === 'b').note).toMatch(/Press Send balance again/);
        expect(rows.find((r) => r.id === 'c').note).toMatch(/Switched off or changed/);
    });

    it('a reminder that is waiting or was dropped says why, not "held too long"', () => {
        const rows = rowsOf([
            { id: 'w', status: 'queued', kind: 'B.late', scheduled: true, nextAttemptAt: T0 + 3600e3, occurredAt: T0, to: '+94*****4567', ref: 'DEB-1', body: 'Reminder' },
            { id: 'x', status: 'expired', kind: 'B.late', scheduled: true, occurredAt: T0 - 86400e3, to: '+94*****4567', ref: 'DEB-1', body: 'Reminder' },
            { id: 'y', status: 'expired', kind: 'A.interest', occurredAt: T0 - 86400e3, to: '+94*****4567', ref: 'INV-1', body: 'Interest' },
            { id: 'z', status: 'queued', kind: 'A.capital', nextAttemptAt: T0 + 3600e3, occurredAt: T0, to: '+94*****4567', ref: 'INV-1', body: 'Capital' },
        ], T0);
        expect(rows.find((r) => r.id === 'w').note).toMatch(/morning where the recipient is/);
        expect(rows.find((r) => r.id === 'x').note).toMatch(/dropped and the next one takes over/);
        expect(rows.find((r) => r.id === 'y').note).toMatch(/Held too long/);
        expect(rows.find((r) => r.id === 'z').note).toBe('Scheduled for a later time.');
    });
});

describe('texts that are waiting for the owner are announced, once, instead of sitting in a quiet log', () => {
    const q = (id, kind) => ({ id, status: 'queued', error: kind ? { kind, message: 'x' } : null });

    it('out of credit, a rejected token, an unapproved sender and a missing token each say what to do, with how many are waiting', () => {
        for (const [kind, words] of [['credit', /SMS credit/], ['auth', /rejected the API token/], ['sender', /sender ID/], ['config', /not connected/]]) {
            const out = heldAlerts([q('a', kind), q('b', kind)], { configured: true }, new Set());
            expect(out.toasts, kind).toHaveLength(1);
            expect(out.toasts[0].text).toMatch(words);
            expect(out.toasts[0].tone).toBe('error');
            expect(out.toasts[0].detail).toMatch(/^2 texts are waiting\./);
            expect([...out.told]).toEqual([kind]);
        }
        expect(heldAlerts([q('a', 'credit')], null, new Set()).toasts[0].detail).toMatch(/^1 text is waiting\./);
    });

    it('a gateway that was never connected queues without trying: that is announced too, and names the variable to add', () => {
        const out = heldAlerts([q('a', null)], { configured: false }, new Set());
        expect(out.toasts).toHaveLength(1);
        expect(out.toasts[0].detail).toMatch(/TEXTLK_API_TOKEN/);
        expect(heldAlerts([q('a', null)], { configured: true }, new Set()).toasts).toEqual([]);           // queued for a moment: nothing to say
    });

    it('says nothing for a retry in the ordinary course, a delivered or a cancelled text, or the status card itself', () => {
        const rows = [q('a', 'rate-limit'), q('b', 'network'), q('c', 'cap'), { id: 'd', status: 'sent' }, { id: 'e', status: 'cancelled', error: { kind: 'credit' } }, { id: 'f', status: 'failed', error: { kind: 'credit' } }, { id: '_status', status: 'queued', error: { kind: 'credit' } }];
        expect(heldAlerts(rows, { configured: true }, new Set()).toasts).toEqual([]);
    });

    it('announces a problem once while it lasts, and again if it clears and comes back', () => {
        const first = heldAlerts([q('a', 'credit')], { configured: true }, new Set());
        expect(first.toasts).toHaveLength(1);
        const again = heldAlerts([q('a', 'credit'), q('b', 'credit')], { configured: true }, first.told);
        expect(again.toasts).toEqual([]);
        const cleared = heldAlerts([], { configured: true }, again.told);
        expect(cleared.toasts).toEqual([]);
        expect(cleared.told.size).toBe(0);
        expect(heldAlerts([q('c', 'credit')], { configured: true }, cleared.told).toasts).toHaveLength(1);
    });

    it('a low balance is a heads-up (not an error), with the units that are left', () => {
        const out = heldAlerts([], { configured: true, lowCredit: true, units: 3 }, new Set());
        expect(out.toasts).toHaveLength(1);
        expect(out.toasts[0].tone).toBe('info');
        expect(out.toasts[0].detail).toMatch(/\(3 units left\)/);
        expect(heldAlerts([], { configured: true, lowCredit: false, units: 90 }, new Set()).toasts).toEqual([]);
    });

    it('survives rows and status that are not what they should be', () => {
        for (const bad of [null, undefined, 'x', 5, [null, 7, 'a', {}, { id: 'x' }]]) {
            expect(() => heldAlerts(bad, 'nope', 'nope')).not.toThrow();
            expect(heldAlerts(bad, null, undefined).toasts).toEqual([]);
        }
    });

    it('every wording is plain text, never markup', () => {
        for (const [a, b] of Object.values(HELD_NOTICE)) { expect(a).not.toMatch(/[<>]/); expect(b).not.toMatch(/[<>]/); }
    });

    it('the live listener passes them to the page\'s toast once, as the snapshots arrive', () => {
        const toasts = []; let push = null;
        const q2 = { orderBy() { return this; }, limit() { return this; }, onSnapshot(cb) { push = cb; return () => {}; } };
        const fsx = { collection: () => ({ doc: () => ({ collection: () => q2 }) }) };
        watchSmsLog({ firestore: fsx, uid: 'u1', storage: null, onToast: (x) => toasts.push(x) });
        const snap = (docs) => ({ docs: docs.map((d) => ({ id: d.id, data: () => { const { id, ...rest } = d; return rest; } })) });
        push(snap([{ id: 'a', status: 'queued', error: { kind: 'credit' }, updatedAt: 1 }, { id: '_status', configured: true, updatedAt: 2 }]));
        push(snap([{ id: 'a', status: 'queued', error: { kind: 'credit' }, updatedAt: 3 }, { id: '_status', configured: true, updatedAt: 4 }]));
        expect(toasts.filter((x) => /SMS credit/.test(x.text))).toHaveLength(1);
    });
});

describe('the late-payment reminder box (a debtor only)', () => {
    const on = { enabled: true, phone: '0771234567', nic: '' };

    it('is a debtor\'s box: the investor\'s block does not show it, the debtor\'s does, and it reads back as the owner left it', () => {
        expect(blockHtml('i_sms', { layer: 'A' })).not.toMatch(/_late/);
        const b = blockHtml('_db_sms', { layer: 'B', record: {} });
        expect(b).toMatch(/id="_db_sms_late"/);
        expect(b).not.toMatch(/_late"[^>]*checked/);                                                      // off unless the owner ticks it
        expect(blockHtml('_db_sms', { layer: 'B', record: { [SMS_FIELDS.REMIND]: true } })).toMatch(/id="_db_sms_late" checked/);
        expect(b).toMatch(/Needs that date/);
        const root = { querySelector: (sel) => ({ '#_db_sms_on': { checked: true }, '#_db_sms_late': { checked: true } }[sel] || null) };
        expect(readBlock(root, '_db_sms')).toMatchObject({ enabled: true, remindLate: true });
        const noBox = { querySelector: (sel) => ({ '#i_sms_on': { checked: true } }[sel] || null) };
        expect(readBlock(noBox, 'i_sms').remindLate).toBeUndefined();
    });

    it('stamps the moment it was ticked, and keeps that stamp while it stays ticked, so an edit never revives a day that was over', () => {
        const first = applyToggle({}, { ...on, remindLate: true }, T0);
        expect(first.fields).toMatchObject({ [SMS_FIELDS.REMIND]: true, [SMS_FIELDS.REMIND_AT]: T0, [SMS_FIELDS.ENABLED_AT]: T0 });
        const edit = applyToggle({ ...first.fields }, { ...on, remindLate: true }, T0 + 5 * 86400000);
        expect(edit.fields[SMS_FIELDS.REMIND_AT]).toBe(T0);
        const unticked = applyToggle({ ...first.fields }, { ...on, remindLate: false }, T0 + 1000);
        expect(unticked.fields[SMS_FIELDS.REMIND]).toBe(false);
        expect(unticked.fields[SMS_FIELDS.REMIND_AT]).toBeUndefined();
        const again = applyToggle({ ...first.fields, ...unticked.fields }, { ...on, remindLate: true }, T0 + 9 * 86400000);
        expect(again.fields[SMS_FIELDS.REMIND_AT]).toBe(T0 + 9 * 86400000);                            // ticked again: a new moment
    });

    it('a form that does not carry the box (an investment) adds nothing, and switching the texts off touches nothing else', () => {
        expect(applyToggle({}, on, T0).fields).not.toHaveProperty(SMS_FIELDS.REMIND);
        expect(applyToggle({ [SMS_FIELDS.REMIND]: true }, { enabled: false }, T0).fields).toEqual({ [SMS_FIELDS.ENABLED]: false });
    });

    it('an edit of the record carries both fields on', () => {
        expect(carry({ [SMS_FIELDS.REMIND]: true, [SMS_FIELDS.REMIND_AT]: T0 })).toMatchObject({ [SMS_FIELDS.REMIND]: true, [SMS_FIELDS.REMIND_AT]: T0 });
    });

    it('ticking it is a change the nudge notices', () => {
        const a = { debtors: [{ id: 'd', [SMS_FIELDS.ENABLED]: true }] };
        const b = { debtors: [{ id: 'd', [SMS_FIELDS.ENABLED]: true, [SMS_FIELDS.REMIND]: true, [SMS_FIELDS.REMIND_AT]: T0 }] };
        expect(signatureOf(a)).not.toBe(signatureOf(b));
    });
});


describe('the second number', () => {
    const on = (extra) => applyToggle({}, { enabled: true, phone: '077 123 4567', ...extra }, T0);

    it('is optional: left out it changes nothing, blank it is removed', () => {
        expect(on({}).fields).not.toHaveProperty('phone2');
        expect(applyToggle({ phone2: '+94712345678' }, { enabled: true, phone: '077 123 4567' }, T0).fields).not.toHaveProperty('phone2');   // not mentioned: kept by the record
        expect(on({ phone2: '' }).fields.phone2).toBe('');
        expect(on({ phone2: '   ' }).fields.phone2).toBe('');
    });

    it('is stored the way the first one is, as a Sri Lankan mobile number in E.164, and a number abroad is refused', () => {
        expect(on({ phone2: '071 234 5678' }).fields).toMatchObject({ phone: '+94771234567', phone2: '+94712345678' });
        expect(on({ phone2: '+94 71 234 5678' }).fields.phone2).toBe('+94712345678');
        expect(on({ phone2: '+44 7911 123456' }).ok).toBe(false);
        expect(on({ phone2: '050 123 4567', country2: 'AE' }).ok).toBe(false);
    });

    it('must be a real mobile number, and not the first number again', () => {
        const bad = on({ phone2: '011 234 5678' });
        expect(bad.ok).toBe(false);
        expect(bad.errors.phone2).toMatch(/^Second number: /);
        const same = on({ phone2: '+94 77 123 4567' });
        expect(same.ok).toBe(false);
        expect(same.errors.phone2).toMatch(/same as the first/);
        expect(on({ phone2: '0771234567' }).ok).toBe(false);                          // the same number written the local way
    });

    it('stamps when the number was added: kept while it stays, restamped when it changes, zero when removed', () => {
        const first = on({ phone2: '071 234 5678' });
        expect(first.fields.phone2_at).toBe(T0);
        const later = applyToggle({ ...first.fields }, { enabled: true, phone: '077 123 4567', phone2: '071 234 5678' }, T0 + 5e6);
        expect(later.fields.phone2_at).toBe(T0);                                                    // an edit that leaves it alone does not make it new
        const changed = applyToggle({ ...first.fields }, { enabled: true, phone: '077 123 4567', phone2: '+94 71 999 8888' }, T0 + 5e6);
        expect(changed.fields.phone2_at).toBe(T0 + 5e6);
        expect(applyToggle({ ...first.fields }, { enabled: true, phone: '077 123 4567', phone2: '' }, T0 + 5e6).fields).toMatchObject({ phone2: '', phone2_at: 0 });
        expect(on({}).fields).not.toHaveProperty('phone2_at');                                      // not mentioned: not touched
    });

    it('with the switch off nothing about the second number is read or changed', () => {
        expect(applyToggle({}, { enabled: false, phone2: 'garbage' }).fields).toEqual({ sms_notifications_enabled: false });
    });

    it('is carried along with the rest when a record is rebuilt', () => {
        expect(carry({ phone2: '+94712345678', closedAt: 5, name: 'x' })).toEqual({ phone2: '+94712345678', closedAt: 5 });
    });
});

describe('closing an investment as fully settled', () => {
    const inv = (over = {}) => ({ id: 'i1', name: 'FD', company: 'Nimal', amount: 100000, rate: 12, start: '2025-01-01', end: '', ...over });

    it('stamps the moment and moves the end date to today when it was empty or still ahead', () => {
        const r = closeInvestment(inv(), { now: T0, todayISO: '2026-10-05' });
        expect(r.ok).toBe(true);
        expect(r.record).toMatchObject({ closedAt: T0, end: '2026-10-05', closedEndWas: '' });
        const ahead = closeInvestment(inv({ end: '2027-03-01' }), { now: T0, todayISO: '2026-10-05' });
        expect(ahead.record).toMatchObject({ closedAt: T0, end: '2026-10-05', closedEndWas: '2027-03-01' });
    });

    it('leaves an end date that has already passed alone', () => {
        const r = closeInvestment(inv({ end: '2026-06-30' }), { now: T0, todayISO: '2026-10-05' });
        expect(r.record).toMatchObject({ closedAt: T0, end: '2026-06-30' });
        expect(r.record).not.toHaveProperty('closedEndWas');
    });

    it('never changes the record it was given, and never closes twice', () => {
        const rec = inv();
        const r = closeInvestment(rec, { now: T0, todayISO: '2026-10-05' });
        expect(rec).toEqual(inv());
        expect(closeInvestment(r.record, { now: T0 + 1, todayISO: '2026-10-05' })).toEqual({ ok: false, reason: 'already-closed' });
        expect(closeInvestment(null, { now: T0, todayISO: '2026-10-05' }).ok).toBe(false);
        expect(closeInvestment(rec, { now: T0, todayISO: 'today' })).toEqual({ ok: false, reason: 'no-date' });
    });

    it('re-opening puts the end date back, and a later close is news again', () => {
        const closed = closeInvestment(inv({ end: '2027-03-01' }), { now: T0, todayISO: '2026-10-05' }).record;
        const again = reopenInvestment(closed);
        expect(again.ok).toBe(true);
        expect(again.record).toEqual(inv({ end: '2027-03-01' }));
        const second = closeInvestment(again.record, { now: T0 + 86400e3, todayISO: '2026-10-06' });
        expect(second.record.closedAt).toBe(T0 + 86400e3);                            // a new stamp: the server's key for the text is new too
        expect(reopenInvestment(inv())).toEqual({ ok: false, reason: 'not-closed' });
    });

    it('an investment that was closed after its own end date comes back with that date', () => {
        const closed = closeInvestment(inv({ end: '2026-06-30' }), { now: T0, todayISO: '2026-10-05' }).record;
        expect(reopenInvestment(closed).record.end).toBe('2026-06-30');
    });

    it('CLOSED_END_WAS is the only extra field, and the server does not read it', () => {
        expect(CLOSED_END_WAS).toBe('closedEndWas');
        expect(Object.values(FIELDS)).not.toContain(CLOSED_END_WAS);
    });
});

describe('"Sent" is not "Delivered" until the gateway says so', () => {
    const row = (extra) => rowsOf([{ id: 'a', status: 'sent', sentAt: 5, to: '+94*****4567', ref: 'DEB-1', body: 'x', ...extra }], 10)[0];
    it('says Sent for a text only the gateway has taken, Delivered once it confirms, and Not delivered (as a failure) when it reports that', () => {
        expect(row({}).label).toBe('Sent');
        expect(row({ delivery: { state: 'pending' } }).label).toBe('Sent');
        expect(row({ delivery: { state: 'delivered' } }).label).toBe('Delivered');
        const bad = row({ delivery: { state: 'undelivered' } });
        expect(bad).toMatchObject({ label: 'Not delivered', status: 'failed' });
        expect(bad.note).toMatch(/not delivered/);
    });
    it('a waiting text paused by the reserve says so', () => {
        expect(rowsOf([{ id: 'w', status: 'queued', kind: 'B.late', error: { kind: 'reserve' }, nextAttemptAt: 1, occurredAt: 1, body: 'r' }], 10)[0].note).toMatch(/under the reserve you set/);
    });
});
