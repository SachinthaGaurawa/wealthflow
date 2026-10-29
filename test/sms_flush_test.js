/* =============================================================================
 * test/sms_flush_test.js — a text goes even when the app is closed straight after the change
 * -----------------------------------------------------------------------------
 * Reported 2026-10-29: update a debtor or an investment and close the app at once, and the text that change owed never went. The text is
 * derived on the server from the UPLOADED books, and the upload is a Firestore transaction that a closing page abandons. What survives a
 * closing page is one request, so the changed records ride in one (sms-flush.mjs) and the server merges them, as the page would have,
 * and looks. What is pinned here:
 *   - the server's merge is the page's merge (the page's own functions are run against it on the same inputs);
 *   - a flush can only ADD or NEWER-ize: it never removes, never beats a newer record, never revives a deleted one, never creates an account;
 *   - what a request may carry is bounded and cleaned;
 *   - a change that exists only in the request still sends the text, to both numbers, and the same request twice sends it once;
 *   - the page side: what is sent is only what changed, it fits one request that may outlive the page, and `leave` needs nothing asynchronous.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createFirestore } from './helpers/fake-firestore.js';
import { FLUSH, utOf, recSig, recPreferred, mergeRecordArray, cleanFlush, mergeFlush, applyFlush } from '../sms-flush.mjs';
import { handleNotify } from '../sms-notify.js';
import { FIELDS } from '../sms-events.mjs';
import { pendingFlush, tokenExpiry, createNotifier, CLIENT, signatureOf } from '../wealthflow-sms.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const NOW = Date.parse('2026-10-05T05:00:00Z');                    // 10:30 in Colombo: inside the sending window
const OWNER = { uid: 'owner1', email: 'owner@example.com' };

/* ── the page's own merge, taken out of index.html and run ────────────────── */
function pageMerge() {
    const from = HTML.indexOf('function _utOf(r) {');
    const to = HTML.indexOf('// Merge two tombstone maps');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return new Function(`${HTML.slice(from, to)}\nreturn { _utOf, _recSig, _recPreferred, _wfMergeRecordArray };`)();
}

/** A small deterministic generator, so a failure can be replayed. */
function rng(seed) { let x = seed >>> 0; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }

describe('the server merges the way the page does', () => {
    it('picks the same record, the same order and the same survivors on a thousand random pairs of lists', () => {
        const page = pageMerge();
        const rand = rng(20261029);
        const pick = (xs) => xs[Math.floor(rand() * xs.length)];
        for (let round = 0; round < 1000; round += 1) {
            const mk = () => {
                const n = Math.floor(rand() * 6);
                return Array.from({ length: n }, () => {
                    const r = { id: pick(['a', 'b', 'c', 'd', 'e']), v: pick([1, 2, 3]) };
                    const form = rand();
                    if (form < 0.7) r._ut = pick([100, 200, 300]);
                    else if (form < 0.85) r.createdAt = pick(['2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z']);
                    else if (form < 0.9) r.paidAt = pick([150, 250]);
                    if (rand() < 0.1) delete r.id;
                    return r;
                });
            };
            const local = mk(); const cloud = mk();
            const tomb = rand() < 0.5 ? { a: pick([50, 150, 250]), c: pick([100, 300]) } : (rand() < 0.5 ? {} : undefined);
            const a = JSON.stringify(page._wfMergeRecordArray(local, cloud, tomb));
            const b = JSON.stringify(mergeRecordArray(local, cloud, tomb));
            expect(b, 'round ' + round).toBe(a);
        }
        for (const [x, y] of [[{ id: 1, _ut: 5, a: 1 }, { id: 1, _ut: 5, a: 2 }], [{ id: 1, _ut: 6 }, { id: 1, _ut: 5 }], [{ id: 1, createdAt: '2026-01-01' }, { id: 1 }]]) {
            expect(utOf(x)).toBe(page._utOf(x));
            expect(recSig(x)).toBe(page._recSig(x));
            expect(recPreferred(x, y)).toEqual(page._recPreferred(x, y));
        }
    });
});

describe('what a flush may carry', () => {
    const rec = (over = {}) => ({ id: 'd1', name: 'Nimal', _ut: NOW - 1000, [FIELDS.ENABLED]: true, ...over });

    it('keeps well-formed records and receipts, and counts what it dropped', () => {
        const out = cleanFlush({
            records: { debtors: [rec(), { id: 'noclock' }, { _ut: NOW }, rec({ id: 'future', _ut: NOW + 3 * 864e5 }), rec({ id: '' }), 'text', null], income: [rec({ id: 'i1' })], people: [rec({ id: 'p1' })] },
            incomeReceived: { 'i1_2026-10': { at: NOW }, 'i1_2026-09': false, 'i1_2026-08': null, 'bad/key': true, '__x__': true },
            kuf: { 'i1_2026-10': NOW - 5, 'i1_2026-09': NOW },
        }, NOW);
        expect(out.ok).toBe(true);
        expect(out.records.debtors.map((r) => r.id)).toEqual(['d1']);
        expect(out.records.income.map((r) => r.id)).toEqual(['i1']);
        expect(Object.keys(out.records)).toEqual(['debtors', 'income']);                  // the people book is not a flush's business
        expect(Object.keys(out.received)).toEqual(['i1_2026-10']);                         // a flush adds a mark; it never takes one away
        expect(out.kuf).toEqual({ 'i1_2026-10': NOW - 5 });
        expect(out.dropped).toBeGreaterThanOrEqual(7);
    });

    it('strips field names Firestore refuses and anything that is not plain data', () => {
        const out = cleanFlush({ records: { debtors: [rec({ __bad__: 1, 'a/b': 2, note: 'ok', nested: { __x__: 1, keep: [1, undefined, () => 1] }, fn: () => 1, nan: NaN })] } }, NOW);
        const r = out.records.debtors[0];
        expect(r.__bad__).toBeUndefined();
        expect(r['a/b']).toBeUndefined();
        expect(r.fn).toBeUndefined();
        expect(r.nan).toBeUndefined();
        expect(r.nested).toEqual({ keep: [1, null, null] });
        expect(r.note).toBe('ok');
    });

    it('refuses a request that is too large or names too many records, and accepts an empty one (a plain nudge)', () => {
        expect(cleanFlush({ records: { debtors: Array.from({ length: FLUSH.MAX_RECORDS + 1 }, (_, i) => rec({ id: 'x' + i })) } }, NOW)).toMatchObject({ ok: false, reason: 'too-many' });
        expect(cleanFlush({ records: { debtors: [rec({ note: 'x'.repeat(FLUSH.MAX_BYTES) })] } }, NOW)).toMatchObject({ ok: false, reason: 'too-large' });
        const many = {}; for (let i = 0; i <= FLUSH.MAX_MAP_KEYS; i += 1) many['k' + i] = true;
        expect(cleanFlush({ incomeReceived: many }, NOW)).toMatchObject({ ok: false, reason: 'too-many' });
        expect(cleanFlush({}, NOW)).toMatchObject({ ok: true, dropped: 0 });
        expect(cleanFlush(null, NOW)).toMatchObject({ ok: true });
    });
});

describe('merging a flush into the account document', () => {
    const clean = (records, extra = {}) => cleanFlush({ records, ...extra }, NOW);

    it('adds a record the document has not seen and keeps every other one', () => {
        const doc = { debtors: [{ id: 'old', _ut: 100 }] };
        const m = mergeFlush(doc, clean({ debtors: [{ id: 'new', _ut: 200 }] }));
        expect(m.changed.debtors).toBe(1);
        expect(m.patch.debtors.map((r) => r.id).sort()).toEqual(['new', 'old']);
        expect(Object.keys(m.patch)).toEqual(['debtors']);                                 // nothing else is written
    });

    it('replaces a record only with a newer one, and a record the document already has changes nothing', () => {
        const doc = { debtors: [{ id: 'a', _ut: 300, phone: 'NEW' }] };
        expect(mergeFlush(doc, clean({ debtors: [{ id: 'a', _ut: 200, phone: 'OLD' }] })).patch).toEqual({});
        expect(mergeFlush(doc, clean({ debtors: [{ id: 'a', _ut: 300, phone: 'NEW' }] })).patch).toEqual({});
        const newer = mergeFlush(doc, clean({ debtors: [{ id: 'a', _ut: 400, phone: 'NEWER' }] }));
        expect(newer.patch.debtors).toEqual([{ id: 'a', _ut: 400, phone: 'NEWER' }]);
    });

    it('never revives a record that was deleted after the edit, and takes a later edit of one that was deleted before it', () => {
        const doc = { debtors: [], _tomb: { debtors: { gone: 500 } } };
        expect(mergeFlush(doc, clean({ debtors: [{ id: 'gone', _ut: 400 }] })).patch).toEqual({});
        expect(mergeFlush(doc, clean({ debtors: [{ id: 'gone', _ut: 600 }] })).patch.debtors).toEqual([{ id: 'gone', _ut: 600 }]);
    });

    it('is idempotent: the merged document merged with the same flush again changes nothing', () => {
        const doc = { income: [{ id: 'i1', _ut: 100 }], incomeReceived: {}, _kuf: { other: { x: 1 } } };
        const c = clean({ income: [{ id: 'i1', _ut: 300, amount: 5 }, { id: 'i2', _ut: 250 }] }, { incomeReceived: { 'i1_2026-10': { at: 1 } }, kuf: { 'i1_2026-10': 900 } });
        const once = mergeFlush(doc, c);
        const twice = mergeFlush(once.user, c);
        expect(twice.patch).toEqual({});
        expect(once.user.incomeReceived).toEqual({ 'i1_2026-10': { at: 1 } });
        expect(once.user._kuf).toEqual({ other: { x: 1 }, incomeReceived: { 'i1_2026-10': 900 } });   // the clocks of other keys are kept
    });

    it('adds a month mark, never removes one, and lets a newer clock replace a changed mark but not an older one', () => {
        const doc = { incomeReceived: { 'i1_2026-09': true, 'i1_2026-10': { at: 1 } }, _kuf: { incomeReceived: { 'i1_2026-10': 500 } } };
        const add = mergeFlush(doc, clean({}, { incomeReceived: { 'i1_2026-11': { at: 2 } }, kuf: { 'i1_2026-11': 600 } }));
        expect(Object.keys(add.patch.incomeReceived).sort()).toEqual(['i1_2026-09', 'i1_2026-10', 'i1_2026-11']);
        const stale = mergeFlush(doc, clean({}, { incomeReceived: { 'i1_2026-10': { at: 9 } }, kuf: { 'i1_2026-10': 400 } }));
        expect(stale.patch).toEqual({});
        const fresh = mergeFlush(doc, clean({}, { incomeReceived: { 'i1_2026-10': { at: 9 } }, kuf: { 'i1_2026-10': 700 } }));
        expect(fresh.patch.incomeReceived['i1_2026-10']).toEqual({ at: 9 });
        expect(fresh.patch._kuf.incomeReceived['i1_2026-10']).toBe(700);
    });

    it('never creates an account: a missing document stays missing', async () => {
        const fs0 = createFirestore();
        const r = await applyFlush({ db: fs0.db, uid: 'nobody', clean: clean({ debtors: [{ id: 'a', _ut: 1 }] }), now: NOW });
        expect(r.exists).toBe(false);
        expect(fs0.data.has('users/nobody')).toBe(false);
    });

    it('writes as somebody else, so every open copy of the app reads it like another device\'s upload', async () => {
        const fs0 = createFirestore({ 'users/u1': { debtors: [], _writeDeviceId: 'phone-1' } });
        await applyFlush({ db: fs0.db, uid: 'u1', clean: clean({ debtors: [{ id: 'a', _ut: NOW - 1 }] }), now: NOW });
        const doc = fs0.data.get('users/u1');
        expect(doc._writeDeviceId).toBe('server-sms-flush');
        expect(doc._writeTs).toBe(NOW);
        expect(doc.debtors.map((r) => r.id)).toEqual(['a']);
    });
});

/* ── the door ─────────────────────────────────────────────────────────────── */

function res() {
    const r = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { r.headers[k] = v; }, end(b) { r.body = b ? JSON.parse(b) : null; } };
    return r;
}
function gateway() {
    const sent = [];
    return { configured: true, senderId: 'WealthFlow', sent, async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: 'g' + sent.length, cost: 1, segments: 1 }; }, async balance() { return { ok: true, units: 50 }; } };
}
function world({ user, now = NOW, tokens } = {}) {
    const fs0 = createFirestore();
    const client = gateway();
    const table = tokens || { good: { ...OWNER, email_verified: true }, stranger: { uid: 'stranger9', email: 'someone@else.org', email_verified: true } };
    const admin = { auth: () => ({ getUser: async (uid) => ({ uid, email: OWNER.email, emailVerified: true, disabled: false }), verifyIdToken: async (t) => { if (!table[t]) throw new Error('bad token'); return table[t]; } }) };
    const deps = { client: () => client, getAdminDb: async () => ({ db: fs0.db, admin }), env: { SMS_ALLOWED_EMAILS: OWNER.email, WEALTHFLOW_PUBLIC_ORIGIN: 'https://wealthflow-personal.vercel.app' }, now: () => now, clock: () => now };
    if (user) fs0.data.set('users/' + OWNER.uid, structuredClone(user));
    return { fs: fs0, client, deps };
}
const flushReq = (body, token = 'good') => ({ method: 'POST', url: '/api/sms-notify', headers: { authorization: 'Bearer ' + token }, body: { action: 'flush', ...body } });

/** A debtor whose repayment was just confirmed: the one change the cloud copy does not hold yet. */
const debtor = (over = {}) => ({
    id: 'd1', name: 'Nimal', phone: '077 123 4567', nic: '853400937V',
    [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3, _ut: NOW - 1000,
    events: [
        { id: 'e0', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: NOW - 7200e3 },
        { id: 'e1', kind: 'repayment', amount: 10000, date: '2026-10-05', confirmed: true, at: NOW - 1000 },
    ],
    ...over,
});

describe('/api/sms-notify, action flush', () => {
    it('sends the text for a change that exists only in the request (the page closed before its upload)', async () => {
        const w = world({ user: { settings: { currency: 'LKR' }, debtors: [] } });
        const r = res();
        await handleNotify(flushReq({ records: { debtors: [debtor()] } }), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.flushed.debtors).toBe(1);
        expect(w.fs.data.get('users/' + OWNER.uid).debtors.map((d) => d.id)).toEqual(['d1']);     // the account now holds what the page had
        expect(w.client.sent.length).toBeGreaterThan(0);
        expect(w.client.sent.every((m) => m.to === '+94771234567')).toBe(true);
        expect(w.client.sent.some((m) => /10,000/.test(m.message))).toBe(true);                   // the repayment that was only in the request
    });

    it('texts the second number too, and sends nothing twice when the same request comes again', async () => {
        const w = world({ user: { settings: { currency: 'LKR' }, debtors: [] } });
        const body = { records: { debtors: [debtor({ phone2: '+94715561957', phone2_at: NOW - 7200e3 })] } };
        const a = res(); await handleNotify(flushReq(body), a, w.deps);
        const first = w.client.sent.length;
        expect(new Set(w.client.sent.map((m) => m.to))).toEqual(new Set(['+94771234567', '+94715561957']));
        const b = res(); await handleNotify(flushReq(body), b, w.deps);
        expect(b.statusCode).toBe(200);
        expect(b.body.flushed).toEqual({ debtors: 0, income: 0, incomeReceived: 0 });
        expect(w.client.sent.length).toBe(first);
    });

    it('is not throttled like a nudge: two flushes a second apart are both merged', async () => {
        const w = world({ user: { settings: { currency: 'LKR' }, debtors: [] } });
        const one = res(); await handleNotify(flushReq({ records: { debtors: [debtor({ id: 'd1' })] } }), one, w.deps);
        const two = res(); await handleNotify(flushReq({ records: { debtors: [debtor({ id: 'd2', phone: '0712223334', nic: '' })] } }), two, w.deps);
        expect(two.body.throttled).toBeUndefined();
        expect(w.fs.data.get('users/' + OWNER.uid).debtors.map((d) => d.id).sort()).toEqual(['d1', 'd2']);
    });

    it('writes only the caller\'s own document, whatever the body says', async () => {
        const w = world({ user: { debtors: [] } });
        w.fs.data.set('users/other', { debtors: [] });
        const r = res();
        await handleNotify(flushReq({ uid: 'other', records: { debtors: [debtor()] } }), r, w.deps);
        expect(w.fs.data.get('users/other').debtors).toEqual([]);
        expect(w.fs.data.get('users/' + OWNER.uid).debtors).toHaveLength(1);
    });

    it('refuses a caller who may not use texts, an oversized body and a missing account, and writes nothing', async () => {
        const w = world({ user: { debtors: [] } });
        const bad = res(); await handleNotify(flushReq({ records: { debtors: [debtor()] } }, 'stranger'), bad, w.deps);
        expect(bad.statusCode).toBe(403);
        const none = res(); await handleNotify({ ...flushReq({}), headers: {} }, none, w.deps);
        expect(none.statusCode).toBe(401);
        const big = res(); await handleNotify(flushReq({ records: { debtors: [debtor({ note: 'x'.repeat(FLUSH.MAX_BYTES) })] } }), big, w.deps);
        expect(big.statusCode).toBe(413);
        expect(w.fs.data.get('users/' + OWNER.uid).debtors).toEqual([]);
        expect(w.client.sent).toHaveLength(0);
        const w2 = world({});
        const ghost = res(); await handleNotify(flushReq({ records: { debtors: [debtor()] } }), ghost, w2.deps);
        expect(ghost.statusCode).toBe(200);
        expect(w2.fs.data.has('users/' + OWNER.uid)).toBe(false);
    });

    it('an investment month marked received, sent only in the request, is texted', async () => {
        const inv = { id: 'i1', company: 'Nimal', name: 'Nimal', amount: 100000, rate: 12, start: '2026-01-05', day: '2026-01-05', freq: 'monthly', monthly: 1000, phone: '0771234567', nic: '853400937V', createdAt: '2026-01-05T00:00:00Z', [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 400 * 86400e3, _ut: NOW - 5000 };
        const w = world({ user: { settings: { currency: 'LKR' }, income: [inv], incomeReceived: {} } });
        const r = res();
        await handleNotify(flushReq({ incomeReceived: { 'i1_2026-10': { at: NOW - 100 } }, kuf: { 'i1_2026-10': NOW - 100 } }), r, w.deps);
        expect(r.body.flushed.incomeReceived).toBe(1);
        expect(w.fs.data.get('users/' + OWNER.uid).incomeReceived['i1_2026-10']).toEqual({ at: NOW - 100 });
        expect(w.client.sent.length).toBeGreaterThan(0);                                          // the receipt for the month that was only in the request
        expect(w.client.sent.every((m) => m.to === '+94771234567')).toBe(true);
    });
});

/* ── the page ─────────────────────────────────────────────────────────────── */

describe('what the page sends', () => {
    const on = (id, ut, extra = {}) => ({ id, _ut: ut, [FIELDS.ENABLED]: true, name: id, ...extra });

    it('sends only the records stamped after the last acknowledged upload, and only ones the switch ever touched', () => {
        const user = { debtors: [on('old', 100), on('fresh', 300), { id: 'plain', _ut: 900 }], income: [on('inv', 400, { company: 'x' })] };
        const out = pendingFlush(user, 200);
        expect(out.records.debtors.map((r) => r.id)).toEqual(['fresh']);                   // 'old' is already in the account; 'plain' never owed a text
        expect(out.records.income.map((r) => r.id)).toEqual(['inv']);
        expect(pendingFlush(user, 0).records.debtors.map((r) => r.id)).toEqual(['fresh', 'old']);   // newest first
        expect(pendingFlush(user, 900).records).toEqual({ debtors: [], income: [] });
    });

    it('sends months marked received for an investment that texts, with the clock of each, and not the rest', () => {
        const user = {
            income: [on('i1', 10), { id: 'i2', _ut: 10, [FIELDS.ENABLED]: false }],
            incomeReceived: { 'i1_2026-10': { at: 1 }, 'i1_2026-09': true, 'i2_2026-10': true, 'zz_2026-10': true },
            _kuf: { incomeReceived: { 'i1_2026-10': 500, 'i1_2026-10~at': 650, 'i1_2026-09': 100, 'i2_2026-10': 700, 'zz_2026-10': 700 } },
        };
        const out = pendingFlush(user, 200);
        expect(out.incomeReceived).toEqual({ 'i1_2026-10': { at: 1 } });                   // i1 texts; September is old news; i2 has texts off; zz is not an investment
        expect(out.kuf).toEqual({ 'i1_2026-10': 650 });                                    // the newest clock under the key, nested fields included
    });

    it('fits one request that may outlive the page, newest first, and says how much it left for the upload', () => {
        const user = { debtors: Array.from({ length: 300 }, (_, i) => on('d' + i, 1000 + i, { note: 'n'.repeat(400) })) };
        const out = pendingFlush(user, 0, 20000);
        expect(JSON.stringify(out).length).toBeLessThanOrEqual(20000);
        expect(out.records.debtors[0].id).toBe('d299');
        expect(out.trimmed).toBeGreaterThan(0);
        expect(out.records.debtors.length + out.trimmed).toBe(300);
        expect(CLIENT.FLUSH_MAX_BYTES).toBeLessThan(64 * 1024);                             // the browser's limit for a request that outlives the page
    });

    it('counts bytes, not letters: a Sinhala name takes three bytes a letter and the request must still fit', () => {
        const user = { debtors: Array.from({ length: 40 }, (_, i) => on('d' + i, 1000 + i, { name: 'කෞෂිගේ අම්මා'.repeat(30) })) };
        const out = pendingFlush(user, 0, 20000);
        expect(new TextEncoder().encode(JSON.stringify(out)).length).toBeLessThanOrEqual(20000);
        expect(out.trimmed).toBeGreaterThan(0);
    });

    it('reads when a token stops being good, and says 0 for one it cannot read', () => {
        const jwt = (payload) => 'h.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.s';
        expect(tokenExpiry(jwt({ exp: 1800000000 }))).toBe(1800000000 * 1000);
        for (const bad of ['', 'abc', 'a.b.c', null, undefined, jwt({ exp: 'soon' })]) expect(tokenExpiry(bad)).toBe(0);
    });
});

describe('the notifier hands the server the change', () => {
    const T0 = Date.parse('2026-10-05T05:00:00Z');
    function rig({ token = 'tok', since = 0 } = {}) {
        const timers = []; let id = 0; const calls = []; const store = new Map();
        const user = { income: [], debtors: [on('d1', 500, { events: [{ id: 'e', kind: 'repayment', amount: 10 }] })] };
        const n = createNotifier({
            getUser: () => user, getUid: () => 'u1',
            getIdToken: async () => 'async-token', peekIdToken: () => token, sinceUt: () => since,
            fetchImpl: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ ok: true, summary: { sent: 1 } }) }; },
            now: () => T0,
            storage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
            setTimer: (fn, ms) => { id += 1; timers.push({ id, fn, ms }); return id; },
            clearTimer: (t) => { const i = timers.findIndex((x) => x.id === t); if (i > -1) timers.splice(i, 1); },
        });
        const fire = async () => { const t = timers.shift(); if (!t) return null; await t.fn(); await new Promise((r) => setTimeout(r, 0)); return t.ms; };
        return { n, calls, timers, store, fire, user };
    }
    const on = (id, ut, extra = {}) => ({ id, _ut: ut, [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: 1, phone: '0771234567', ...extra });

    it('a change is sent after a moment, with the changed records and keepalive, not after the upload and the wait that follows it', async () => {
        const r = rig();
        expect(r.n.onLocalChange()).toBe(true);
        expect(r.timers[0].ms).toBe(CLIENT.FLUSH_DELAY_MS);
        expect(CLIENT.FLUSH_DELAY_MS).toBeLessThan(CLIENT.DEBOUNCE_MS);
        await r.fire();
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0].init.keepalive).toBe(true);
        expect(r.calls[0].body).toMatchObject({ action: 'flush', force: true, reason: 'change' });
        expect(r.calls[0].body.records.debtors.map((x) => x.id)).toEqual(['d1']);
        expect(r.n.afterPush()).toBe(false);                                                // the server has looked at this state: the upload need not nudge it again
    });

    it('once the server has looked at a state, the nudge that was waiting for the upload to finish is dropped', async () => {
        const r = rig();
        r.n.afterPush();                                                                     // the upload finished: a nudge is queued behind the usual wait
        r.n.onLocalChange();
        expect(r.timers.map((t) => t.ms).sort((a, b) => a - b)).toEqual([CLIENT.FLUSH_DELAY_MS, CLIENT.DEBOUNCE_MS]);
        const flush = r.timers.find((t) => t.ms === CLIENT.FLUSH_DELAY_MS);
        r.timers.splice(r.timers.indexOf(flush), 1);
        await flush.fn();
        await new Promise((res2) => setTimeout(res2, 0));
        expect(r.calls).toHaveLength(1);
        expect(r.timers.filter((t) => t.ms === CLIENT.DEBOUNCE_MS)).toHaveLength(0);          // nothing left to nudge
    });

    it('changes made in quick succession are one request', async () => {
        const r = rig();
        r.n.onLocalChange(); r.n.onLocalChange(); r.n.onLocalChange();
        expect(r.timers).toHaveLength(1);
    });

    it('keeps waiting for a quiet moment, but never longer than the cap, however steadily something else keeps writing', () => {
        let clock = T0;
        const timers = []; let id = 0;
        const user = { debtors: [on('d1', 500)] };
        const n = createNotifier({
            getUser: () => user, getUid: () => 'u1', getIdToken: async () => 't', peekIdToken: () => 't', sinceUt: () => 0,
            fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true }) }), now: () => clock,
            storage: { getItem: () => null, setItem: () => {} },
            setTimer: (fn, ms) => { id += 1; timers.push({ id, fn, ms }); return id; },
            clearTimer: (t) => { const i = timers.findIndex((x) => x.id === t); if (i > -1) timers.splice(i, 1); },
        });
        n.onLocalChange();
        expect(timers.map((t) => t.ms)).toEqual([CLIENT.FLUSH_DELAY_MS]);
        clock += 1000; n.onLocalChange();                                                    // a second write, one second later: the wait starts over
        expect(timers.map((t) => t.ms)).toEqual([CLIENT.FLUSH_DELAY_MS]);
        clock += 2800; n.onLocalChange();                                                    // 3.8 s after the first: only 200 ms left of the cap
        expect(timers.map((t) => t.ms)).toEqual([CLIENT.FLUSH_MAX_WAIT_MS - 3800]);
        clock += 500; n.onLocalChange();                                                     // past the cap: now
        expect(timers.map((t) => t.ms)).toEqual([0]);
    });

    it('does nothing for an account that never used texts, or when the server has already seen this state', async () => {
        const plain = rig(); plain.user.debtors = [{ id: 'x', _ut: 1 }];
        expect(plain.n.onLocalChange()).toBe(false);
        expect(plain.n.leave()).toBe(false);
        const seen = rig();
        seen.store.set('wf_sms_sig_u1', signatureOf(seen.user));
        expect(seen.n.onLocalChange()).toBe(false);
        expect(seen.n.leave()).toBe(false);
        expect(seen.calls).toHaveLength(0);
    });

    it('leave sends at once, without awaiting anything, with the token it already holds and keepalive', () => {
        const r = rig();
        expect(r.n.leave('hidden')).toBe(true);                                            // synchronous: no promise to settle before the page is frozen
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0].url).toBe(CLIENT.ENDPOINT);
        expect(r.calls[0].init.keepalive).toBe(true);
        expect(r.calls[0].init.headers.Authorization).toBe('Bearer tok');
        expect(r.calls[0].body.reason).toBe('hidden');
        expect(r.calls[0].body.records.debtors.map((x) => x.id)).toEqual(['d1']);
    });

    it('leave cancels the pending timer, and remembers the server has looked once it answers', async () => {
        const r = rig();
        r.n.onLocalChange();
        expect(r.timers).toHaveLength(1);
        r.n.leave();
        expect(r.timers).toHaveLength(0);
        await new Promise((res2) => setTimeout(res2, 0));
        await new Promise((res2) => setTimeout(res2, 0));
        expect(r.n.leave()).toBe(false);                                                    // the same state is not sent twice
    });

    it('leave without a good token sends nothing (a stale token would only be refused) and never throws', () => {
        const r = rig({ token: '' });
        expect(r.n.leave()).toBe(false);
        expect(r.calls).toHaveLength(0);
    });

    it('leave does not resend what the account acknowledged', () => {
        const r = rig({ since: 500 });
        expect(r.n.leave()).toBe(true);
        expect(r.calls[0].body.records).toEqual({ debtors: [], income: [] });               // still a nudge: the server looks, and nothing is sent twice
    });
});

describe('the page is wired to it', () => {
    it('hands every change to a record a text is derived from to the notifier, after the ordinary save', () => {
        const set = HTML.slice(HTML.indexOf('set(k, v, silent = false) {'), HTML.indexOf('delKey(field, key, silent = false) {'));
        expect(set).toMatch(/debouncedSync\(\);[\s\S]*k === 'debtors' \|\| k === 'income' \|\| k === 'incomeReceived'[\s\S]*WFSms\.onLocalChange\(\)/);
        expect(set).toMatch(/try \{ if \(window\.WFSms\) window\.WFSms\.onLocalChange\(\); \} catch/);   // never into the save path
    });

    it('remembers, per account, the newest text-bearing stamp an acknowledged upload carried', () => {
        const sync = HTML.slice(HTML.indexOf('function syncToCloud() {'), HTML.indexOf('THE UPLOAD, WATCHED'));
        expect(sync).toContain('_wfAckMark()');
        expect(sync).toContain('_wfSetAcked(ackMark)');
        expect(HTML).toContain("'wf_acked_ut_' + currentUser.uid");
        const wiring = fs.readFileSync(path.join(ROOT, 'wealthflow-sms.js'), 'utf8');
        expect(wiring).toContain("'wf_acked_ut_' + uid");                                   // the notifier reads what the page wrote
    });

    it('sends on the page going to the background and on it closing', () => {
        const wiring = fs.readFileSync(path.join(ROOT, 'wealthflow-sms.js'), 'utf8');
        expect(wiring).toMatch(/visibilityState === 'hidden'\) away\(\)/);
        expect(wiring).toMatch(/addEventListener\('pagehide', away\)/);
    });
});
