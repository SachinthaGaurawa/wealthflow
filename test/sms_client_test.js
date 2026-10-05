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
    SMS_FIELDS, CLIENT, BALANCE, balanceWaitMs, requestBalance, applyToggle, carry, blockHtml, readBlock, signatureOf, countOn, createNotifier, toastFor, announce, watchSmsLog, rowsOf, panelHtml, describeIssue, ALERT_TITLE, boot,
} from '../wealthflow-sms.js';
import { FIELDS } from '../sms-events.mjs';

const T0 = Date.parse('2026-10-05T05:00:00Z');

describe('the fields are the server\'s fields', () => {
    it('the page and the server read and write the same five names', () => {
        expect(SMS_FIELDS).toEqual({ ENABLED: FIELDS.ENABLED, ENABLED_AT: FIELDS.ENABLED_AT, PHONE: FIELDS.PHONE, NIC: FIELDS.NIC, REQUESTS: FIELDS.REQUESTS });
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

    it('works for a person in any country: an international number, or a local one in the chosen country', () => {
        expect(applyToggle({}, { enabled: true, phone: '+44 7911 123456' }, T0).fields.phone).toBe('+447911123456');
        expect(applyToggle({}, { enabled: true, phone: '050 123 4567', country: 'AE' }, T0).fields.phone).toBe('+971501234567');
        expect(applyToggle({}, { enabled: true, phone: '07911 123456', country: 'GB' }, T0).fields.phone).toBe('+447911123456');
        expect(applyToggle({}, { enabled: true, phone: '(415) 555-2671', country: 'US' }, T0).fields.phone).toBe('+14155552671');
    });

    it('a number with no country to read it in is refused with the sentence that tells the owner to add one', () => {
        const r = applyToggle({}, { enabled: true, phone: '4155552671' }, T0);
        expect(r.ok).toBe(false);
        expect(r.errors.phone).toMatch(/country/i);
    });

    it('a passport or national ID stands in for an NIC, stored with a prefix so the two can never be confused', () => {
        const r = applyToggle({}, { enabled: true, phone: '+971501234567', nic: ' x-1234 567 ', idKind: 'other' }, T0);
        expect(r).toMatchObject({ ok: true, fields: { nic: 'ID:X1234567' } });
        expect(applyToggle({}, { enabled: true, phone: '+971501234567', nic: 'ID:X1234567' }, T0).fields.nic).toBe('ID:X1234567');   // already in its stored form
        const bad = applyToggle({}, { enabled: true, phone: '+971501234567', nic: 'a', idKind: 'other' }, T0);
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
    it('has no emoji, and tells the owner it works in any country and about the statement link', () => {
        for (const layer of ['A', 'B']) {
            const html = blockHtml('x', { layer });
            expect(/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(html)).toBe(false);
            expect(html).toMatch(/private link to a statement page/);
            expect(html).toMatch(/one-time code/);
            expect(html).toMatch(/any country/);
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
        expect(html.indexOf('not connected')).toBeLessThan(html.indexOf('Delivered'));
        expect(panelHtml({ rows: [] })).toMatch(/No text messages yet/);
        expect(panelHtml({ disabled: true })).toMatch(/not enabled for this account/);
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
});
