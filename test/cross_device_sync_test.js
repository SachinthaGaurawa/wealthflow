/* =============================================================================
 * test/cross_device_sync_test.js — two devices, one cloud document, run against the shipped sync code
 * -----------------------------------------------------------------------------
 * The owner's laptop and phone showed different data. The cause that can be reproduced is a push that replaced the
 * cloud's ARRAYS with this device's copy (`set(appData, {merge:true})`): a device that had not yet seen a record — one
 * the statement worker had just filed, or one the other device had just added — pushed its shorter list over it and the
 * record was gone for everyone. The fix is a read-merge-write in one transaction, a clock that never goes backwards
 * past anything a device has seen, a dirty counter so an edit made while a push is in flight is not marked "saved", and
 * a loop that re-reads the server instead of trusting the live stream to arrive.
 *
 * Here the REAL functions from index.html (syncToCloud, _wfApplyCloudData, _wfStampAndTomb, _wfReconcileWithCloud,
 * setDirty, _wfPaintCloudChange …) run inside N "devices", each with its own localStorage and clock, against a fake
 * Firestore document that behaves like the real one where it matters: a merge-set replaces arrays and merges maps,
 * `undefined` is refused, and a transaction is retried when the document changed between its read and its commit.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function blockAt(marker) {
    const start = HTML.indexOf(marker);
    expect(start, `"${marker}" is gone from index.html — retarget this test`).toBeGreaterThan(-1);
    let i = HTML.indexOf('{', start), depth = 0, q = null, j = i;
    for (; j < HTML.length; j++) {
        const c = HTML[j];
        if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && HTML[j + 1] === '/') { j = HTML.indexOf('\n', j); continue; }
        if (c === '/' && HTML[j + 1] === '*') { j = HTML.indexOf('*/', j) + 1; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    expect(depth, `could not brace-match "${marker}"`).toBe(0);
    return HTML.slice(start, j + 1);
}
function constAt(re, what) {
    const m = HTML.match(re);
    expect(m, `${what} is gone from index.html — retarget this test`).toBeTruthy();
    return m[0];
}
function uidSource() {
    const start = HTML.indexOf('let _uidSeq = 0;');
    const declStart = HTML.indexOf('const uid = () =>', start);
    const end = HTML.indexOf(';', HTML.indexOf('_uidSeq', declStart));
    return HTML.slice(start, end + 1);
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const J = JSON.stringify;
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/* ── the cloud: one document, Firestore's merge semantics, optimistic transactions ─────────────────────────────────── */
class ServerTs { }
function makeCloud(initial = {}) {
    const cloud = { data: clone(initial), version: 1, offline: false, beforeCommit: null, commits: 0, transactionRuns: 0 };
    const assertNoUndefined = (v) => {
        if (v === undefined) throw new Error('Unsupported field value: undefined');
        if (Array.isArray(v)) v.forEach(assertNoUndefined);
        else if (isPlain(v)) Object.values(v).forEach(assertNoUndefined);
    };
    const mergeInto = (dst, src) => {
        for (const [k, v] of Object.entries(src)) {
            if (v instanceof ServerTs) dst[k] = Date.now();
            else if (isPlain(v) && isPlain(dst[k])) mergeInto(dst[k], v);
            else dst[k] = isPlain(v) || Array.isArray(v) ? clone(v) : v;   // arrays and scalars are REPLACED
        }
    };
    const snapshot = () => ({ exists: true, data: () => clone(cloud.data) });
    const offlineError = () => Object.assign(new Error('client is offline'), { code: 'unavailable' });
    const ref = {
        get: async () => { if (cloud.offline) throw offlineError(); return snapshot(); },
        set: async (data, opts) => {
            if (cloud.offline) throw offlineError();
            assertNoUndefined(data);
            if (opts && opts.merge) mergeInto(cloud.data, data); else { cloud.data = {}; mergeInto(cloud.data, data); }
            cloud.version++; cloud.commits++;
        },
    };
    ref.firestore = {
        runTransaction: async (fn) => {
            for (let attempt = 0; attempt < 6; attempt++) {
                if (cloud.offline) throw offlineError();
                cloud.transactionRuns++;
                let readVersion = null; const writes = [];
                await fn({
                    get: async () => { if (cloud.offline) throw offlineError(); readVersion = cloud.version; return snapshot(); },
                    set: (r, data, opts) => { assertNoUndefined(data); writes.push([data, opts]); },
                });
                if (cloud.beforeCommit) await cloud.beforeCommit(attempt);   // somebody else writes between this read and this commit
                if (readVersion !== null && readVersion !== cloud.version) continue;   // the document moved: Firestore re-runs the function
                writes.forEach(([data, opts]) => { if (opts && opts.merge) mergeInto(cloud.data, data); else { cloud.data = {}; mergeInto(cloud.data, data); } });
                cloud.version++; cloud.commits++;
                return;
            }
            throw Object.assign(new Error('too much contention'), { code: 'aborted' });
        },
    };
    cloud.ref = ref;
    // a write by the server-side statement worker: stamped the way the worker stamps it
    cloud.serverWrite = (mutate) => { const d = clone(cloud.data); mutate(d); d._writeDeviceId = 'statement-worker'; d._writeTs = Date.now(); cloud.data = d; cloud.version++; };
    return cloud;
}

/* ── a device: the shipped sync code, its own storage, its own clock ──────────────────────────────────────────────── */
function makeDevice(name, cloud, { skewMs = 0 } = {}) {
    const store = new Map();
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => store.delete(k),
    };
    const realDate = Date;
    const clock = { skew: skewMs };
    class SkewDate extends realDate {
        constructor(...a) { if (a.length) super(...a); else super(realDate.now() + clock.skew); }
        static now() { return realDate.now() + clock.skew; }
    }
    const appData = { _wipedAck: 0 };
    const notes = [], renders = [], syncStatus = [], pending = { debounced: 0 };
    const win = { _isDecoyMode: false };
    const nav = { onLine: true };
    const src = [
        constAt(/const _WF_RECORD_KEYS = \[[^\]]*\];/, '_WF_RECORD_KEYS'),
        constAt(/const _WF_TOMB_TTL = [^;]*;/, '_WF_TOMB_TTL'),
        constAt(/const _WF_SYNC_META_KEYS = \{[^}]*\};/, '_WF_SYNC_META_KEYS'),
        constAt(/const _WF_KUT_EXEMPT = \{[^}]*\};/, '_WF_KUT_EXEMPT'),
        blockAt('function _utOf(r)'),
        blockAt('function _recSig(r)'),
        blockAt('function _recPreferred(a, b)'),
        uidSource(),
        blockAt('function _wfDedupRecordIds(arr)'),
        constAt(/const _WF_BULK_MIN = \d+;/, '_WF_BULK_MIN'),
        constAt(/const _WF_BULK_FRACTION = [\d.]+;/, '_WF_BULK_FRACTION'),
        'let _wfBulkIntent = null;',
        blockAt('function _wfExpectBulkRemoval(keys, ms)'),
        blockAt('function _wfBulkAnnounced(key)'),
        'let _wfHlc = 0;',
        blockAt('function _wfStampNow()'),
        blockAt('function _wfObserveStamps(cloud)'),
        blockAt('function _wfStampAndTomb(key, newArr)'),
        blockAt('function _wfMergeRecordArray(localArr, cloudArr, tombMap)'),
        blockAt('function _wfMergeTombMaps(a, b)'),
        blockAt('function _persistLocal(key, value, raw)'),
        blockAt('function _persistRaw(key, str)'),
        blockAt('function _wfStampKey(k)'),
        blockAt('function _wfMergeKeyed(localVal, cloudVal, lts, cts, lFields, cFields)'),
        blockAt('function _wfApplyCloudData(cloudData)'),
        blockAt('function _wfCloudSafe(v, d = 0)'),
        'let isDirty = false, _dirtyGen = 0, isSyncingFromCloud = false, lastSyncTime = 0, _lastLocalWriteTs = 0, _lastCloudPushError = "", isInitialised = true, _wfLocalWriteBlocked = false, syncDebounceTimer = 0;',
        blockAt('function setDirty(state)'),
        blockAt('function _wfPaintCloudChange(applied)'),
        blockAt('function syncToCloud()'),
        constAt(/let _wfReconciling = false, _wfReconcileStarted = false, _wfLastReconcile = null;/, 'reconcile state'),
        blockAt('async function _wfReconcileWithCloud(why)'),
    ].join('\n');
    const factory = new Function('localStorage', 'appData', 'notify', 'console', 'window', 'navigator', 'Date', 'userDocRef', 'firebase', 'currentUser',
        '_getDeviceId', 'setSyncStatus', '_flushCloudDeletes', '_wfApplyPendingDeletesLocally', 'debouncedSync', '$', 'document', '_wfAfterScrollIdle', 'renderPage', 'updateCCOTBadge', 'updateChequeBadge', '_renderSessionsDebounced',
        src + '\nreturn {'
        + ' edit: (key, fn) => { const next = fn(JSON.parse(JSON.stringify(appData[key] || []))); appData[key] = _wfStampAndTomb(key, next); _persistLocal("wf2_" + key, appData[key]); setDirty(true); },'
        + ' setDirty, syncToCloud, reconcile: _wfReconcileWithCloud, applyCloud: _wfApplyCloudData, stampNow: _wfStampNow,'
        + ' get isDirty() { return isDirty; }, get dirtyGen() { return _dirtyGen; }, get lastReconcile() { return _wfLastReconcile; }, get lastError() { return _lastCloudPushError; },'
        + ' adoptInitialised: (v) => { isInitialised = v; } };');
    const api = factory(localStorage, appData, (m, t) => notes.push([t, m]), { log() {}, warn() {}, error() {} }, win, nav, SkewDate, cloud.ref,
        { firestore: { FieldValue: { serverTimestamp: () => new ServerTs() } } }, { uid: 'u1' },
        () => name, (s) => syncStatus.push(s), () => {}, () => {}, () => { pending.debounced++; },
        (id) => (id === 'app' ? { classList: { contains: (c) => c === 'show' } } : null),
        { querySelector: () => ({ id: 'page-expenses' }), getElementById: () => null },
        (_why, fn) => fn(), (p) => renders.push(p), () => {}, () => {}, () => {});
    return Object.assign(api, {
        name, appData, store, notes, renders, syncStatus, pending, win, nav, clock,
        ids: (key) => (appData[key] || []).map(r => r.id).sort(),
        rec: (key, id) => (appData[key] || []).find(r => r.id === id),
        // what the live listener does with a snapshot
        deliver: () => api.applyCloud(clone(cloud.data)),
    });
}
const add = (dev, key, rec) => dev.edit(key, (arr) => { arr.push(rec); return arr; });
const edit = (dev, key, id, patch) => dev.edit(key, (arr) => arr.map(r => (r.id === id ? { ...r, ...patch } : r)));
const del = (dev, key, id) => dev.edit(key, (arr) => arr.filter(r => r.id !== id));
const cloudIds = (cloud, key) => (cloud.data[key] || []).map(r => r.id).sort();
const settle = async (devs, cloud, rounds = 3) => {
    for (let i = 0; i < rounds; i++) for (const d of devs) { await d.reconcile('test'); if (d.isDirty) await d.syncToCloud(); }
};

/* ── 1. the lost update ───────────────────────────────────────────────────────────────────────────────────────────── */
describe('a push cannot overwrite what the cloud got first', () => {
    const seed = () => ({ expenses: [{ id: 'e1', amount: 100, _ut: 1000 }] });

    it('CONTROL: the old push — a merge-set of this device\'s arrays — does lose a record the device has not seen (the bug this fixes)', async () => {
        const cloud = makeCloud(seed());
        const phone = makeDevice('phone', cloud);
        phone.applyCloud(clone(cloud.data));
        // the statement worker files a row the phone has not heard about yet
        cloud.serverWrite(d => { d.expenses.push({ id: 'stmt-1', amount: 55, source: 'statement', _ut: 2000 }); });
        // the phone edits something else and pushes the way the page used to
        edit(phone, 'expenses', 'e1', { amount: 101 });
        await cloud.ref.set({ expenses: phone.appData.expenses }, { merge: true });
        expect(cloudIds(cloud, 'expenses'), 'the harness must be able to see the bug, or the next test proves nothing').toEqual(['e1']);
    });

    it('the new push reads the newest cloud document inside the transaction and keeps the worker\'s row', async () => {
        const cloud = makeCloud(seed());
        const phone = makeDevice('phone', cloud);
        phone.applyCloud(clone(cloud.data));
        cloud.serverWrite(d => { d.expenses.push({ id: 'stmt-1', amount: 55, source: 'statement', _ut: 2000 }); });
        edit(phone, 'expenses', 'e1', { amount: 101 });
        expect(await phone.syncToCloud()).toBe(true);
        expect(cloudIds(cloud, 'expenses'), 'the statement row the phone had not seen was overwritten').toEqual(['e1', 'stmt-1']);
        expect(cloud.data.expenses.find(r => r.id === 'e1').amount).toBe(101);
        expect(phone.ids('expenses'), 'the phone did not end up showing what it pushed').toEqual(['e1', 'stmt-1']);
        expect(phone.isDirty).toBe(false);
    });

    it('a write that lands between the read and the commit makes the transaction run again, and nothing is lost', async () => {
        const cloud = makeCloud(seed());
        const phone = makeDevice('phone', cloud), laptop = makeDevice('laptop', cloud);
        phone.applyCloud(clone(cloud.data)); laptop.applyCloud(clone(cloud.data));
        add(phone, 'expenses', { id: 'p1', amount: 1 });
        add(laptop, 'expenses', { id: 'l1', amount: 2 });
        // the laptop commits exactly while the phone is between its read and its commit
        let fired = false;
        cloud.beforeCommit = async () => { if (!fired) { fired = true; cloud.beforeCommit = null; expect(await laptop.syncToCloud()).toBe(true); } };
        expect(await phone.syncToCloud()).toBe(true);
        expect(cloud.transactionRuns, 'the phone\'s transaction was not re-run after the document moved').toBeGreaterThanOrEqual(3);
        expect(cloudIds(cloud, 'expenses')).toEqual(['e1', 'l1', 'p1']);
        await settle([phone, laptop], cloud);
        expect(phone.ids('expenses')).toEqual(['e1', 'l1', 'p1']);
        expect(laptop.ids('expenses')).toEqual(['e1', 'l1', 'p1']);
    });

    it('a server write between the read and the commit is merged, not overwritten', async () => {
        const cloud = makeCloud(seed());
        const phone = makeDevice('phone', cloud);
        phone.applyCloud(clone(cloud.data));
        add(phone, 'expenses', { id: 'p1', amount: 1 });
        let fired = false;
        cloud.beforeCommit = async () => { if (!fired) { fired = true; cloud.serverWrite(d => { d.expenses.push({ id: 'stmt-9', amount: 9, _ut: 5000 }); }); } };
        expect(await phone.syncToCloud()).toBe(true);
        expect(cloudIds(cloud, 'expenses')).toEqual(['e1', 'p1', 'stmt-9']);
    });
});

/* ── 2. deletes ───────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('deletes and edits across devices', () => {
    const seed = () => ({ expenses: [{ id: 'e1', amount: 100, _ut: 1000 }, { id: 'e2', amount: 200, _ut: 1000 }] });

    it('a stale device pushing afterwards does not bring a deleted record back', async () => {
        const cloud = makeCloud(seed());
        const laptop = makeDevice('laptop', cloud), phone = makeDevice('phone', cloud);
        [laptop, phone].forEach(d => { d.applyCloud(clone(cloud.data)); d.store.set('wf2_expenses', J(d.appData.expenses)); });
        del(laptop, 'expenses', 'e1');
        await laptop.syncToCloud();
        // the phone never got the snapshot; it edits the OTHER record and pushes
        edit(phone, 'expenses', 'e2', { amount: 222 });
        await phone.syncToCloud();
        expect(cloudIds(cloud, 'expenses'), 'the deleted record walked back in from the stale device').toEqual(['e2']);
        expect(phone.ids('expenses'), 'the phone still shows the deleted record').toEqual(['e2']);
        expect(cloud.data.expenses[0].amount).toBe(222);
    });

    it('an edit made after a delete on another device beats the delete', async () => {
        const cloud = makeCloud(seed());
        const laptop = makeDevice('laptop', cloud), phone = makeDevice('phone', cloud);
        [laptop, phone].forEach(d => { d.applyCloud(clone(cloud.data)); d.store.set('wf2_expenses', J(d.appData.expenses)); });
        del(laptop, 'expenses', 'e1');
        await laptop.syncToCloud();
        await new Promise(r => setTimeout(r, 5));
        edit(phone, 'expenses', 'e1', { amount: 999 });   // the phone had not seen the delete; its edit is newer
        await phone.syncToCloud();
        await settle([laptop, phone], cloud);
        expect(laptop.rec('expenses', 'e1')?.amount, 'a newer edit was lost to an older delete').toBe(999);
        expect(phone.rec('expenses', 'e1')?.amount).toBe(999);
    });

    it('an announced factory reset is adopted by a stale device, which does not push its old data back', async () => {
        const cloud = makeCloud({ expenses: [], _tomb: {}, _wipedAt: 9000, _wipedAck: 9000 });
        const stale = makeDevice('phone', cloud);
        stale.appData.expenses = [{ id: 'old1', amount: 1, _ut: 1000 }]; stale.store.set('wf2_expenses', J(stale.appData.expenses));
        stale.setDirty(true);
        await stale.syncToCloud();
        expect(cloudIds(cloud, 'expenses'), 'a device that missed the reset pushed its old records back over it').toEqual([]);
        expect(stale.ids('expenses')).toEqual([]);
    });
});

/* ── 3. the clock ─────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('a slow clock cannot make a device\'s edit lose', () => {
    it('an edit made on a phone 10 minutes behind, after it received the laptop\'s version, still wins everywhere', async () => {
        const cloud = makeCloud({ expenses: [] });
        const laptop = makeDevice('laptop', cloud);
        const phone = makeDevice('phone', cloud, { skewMs: -10 * 60 * 1000 });
        add(laptop, 'expenses', { id: 'r1', amount: 10 });
        await laptop.syncToCloud();
        phone.deliver();
        expect(phone.rec('expenses', 'r1')).toBeTruthy();
        const seen = phone.rec('expenses', 'r1')._ut;
        edit(phone, 'expenses', 'r1', { amount: 77 });
        expect(phone.rec('expenses', 'r1')._ut, 'the phone stamped its edit OLDER than the version it had just read').toBeGreaterThan(seen);
        await phone.syncToCloud();
        laptop.deliver();
        expect(cloud.data.expenses[0].amount).toBe(77);
        expect(laptop.rec('expenses', 'r1').amount, 'the laptop kept the older value').toBe(77);
    });

    it('a clock set absurdly far ahead cannot drag every device\'s stamps with it', () => {
        const cloud = makeCloud({});
        const dev = makeDevice('phone', cloud);
        dev.applyCloud({ expenses: [{ id: 'x', _ut: Date.now() + 40 * 365 * 864e5 }] });
        expect(dev.stampNow(), 'one wrong clock in the cloud pushed this device decades into the future').toBeLessThan(Date.now() + 2 * 864e5);
    });
});

/* ── 4. offline, and a stream that stopped ────────────────────────────────────────────────────────────────────────── */
describe('offline work and a stalled live stream', () => {
    it('edits made offline stay dirty, then go out merged with whatever the other device did meanwhile', async () => {
        const cloud = makeCloud({ expenses: [{ id: 'e1', amount: 1, _ut: 1000 }] });
        const laptop = makeDevice('laptop', cloud), phone = makeDevice('phone', cloud);
        phone.applyCloud(clone(cloud.data));
        cloud.offline = true; phone.nav.onLine = false;
        add(phone, 'expenses', { id: 'p-offline', amount: 5 });
        expect(await phone.syncToCloud(), 'an offline push claimed success').toBe(false);
        expect(phone.isDirty, 'an unsent edit was marked saved').toBe(true);
        // meanwhile the laptop works online
        laptop.applyCloud(clone(cloud.data));
        cloud.offline = false;
        add(laptop, 'expenses', { id: 'l-online', amount: 6 });
        await laptop.syncToCloud();
        // the phone reconnects
        phone.nav.onLine = true;
        await phone.reconcile('online');
        await phone.syncToCloud();
        await laptop.reconcile('interval');
        expect(cloudIds(cloud, 'expenses')).toEqual(['e1', 'l-online', 'p-offline']);
        expect(phone.ids('expenses')).toEqual(['e1', 'l-online', 'p-offline']);
        expect(laptop.ids('expenses')).toEqual(['e1', 'l-online', 'p-offline']);
        expect(phone.isDirty).toBe(false);
    });

    it('a device whose live stream stalled still gets the other device\'s change, and repaints', async () => {
        const cloud = makeCloud({ expenses: [] });
        const laptop = makeDevice('laptop', cloud), phone = makeDevice('phone', cloud);
        add(laptop, 'expenses', { id: 'r1', amount: 1 });
        await laptop.syncToCloud();
        expect(phone.ids('expenses'), 'sanity: the phone has heard nothing').toEqual([]);
        expect(await phone.reconcile('resume')).toBe(true);
        expect(phone.ids('expenses')).toEqual(['r1']);
        expect(phone.renders, 'the phone merged the change but the screen still shows the old list').toEqual(['expenses']);
        expect(phone.lastReconcile).toMatchObject({ why: 'resume', changed: true });
    });

    it('reconcile does nothing on a decoy session, while offline, or before the app has started', async () => {
        const cloud = makeCloud({ expenses: [{ id: 'r1', _ut: 1 }] });
        const a = makeDevice('a', cloud); a.win._isDecoyMode = true;
        expect(await a.reconcile('interval')).toBe(false);
        const b = makeDevice('b', cloud); b.nav.onLine = false;
        expect(await b.reconcile('interval')).toBe(false);
        const c = makeDevice('c', cloud); c.adoptInitialised(false);
        expect(await c.reconcile('interval')).toBe(false);
        [a, b, c].forEach(d => expect(d.ids('expenses')).toEqual([]));
    });

    it('a push on a decoy session is refused, so the real document cannot be overwritten', async () => {
        const cloud = makeCloud({ expenses: [{ id: 'real', _ut: 1 }] });
        const a = makeDevice('a', cloud); a.win._isDecoyMode = true;
        a.appData.expenses = [{ id: 'decoy', _ut: 2 }]; a.setDirty(true);
        expect(await a.syncToCloud()).toBe(false);
        expect(cloudIds(cloud, 'expenses')).toEqual(['real']);
    });
});

/* ── 5. changed while the push was in flight ──────────────────────────────────────────────────────────────────────── */
describe('an edit made while a push is in flight is never marked saved', () => {
    it('stays dirty and goes out again', async () => {
        const cloud = makeCloud({ expenses: [] });
        const dev = makeDevice('phone', cloud);
        add(dev, 'expenses', { id: 'first', amount: 1 });
        let edited = false;
        cloud.beforeCommit = async () => { if (!edited) { edited = true; add(dev, 'expenses', { id: 'second', amount: 2 }); } };
        expect(await dev.syncToCloud()).toBe(true);
        expect(dev.isDirty, 'the edit made during the push was marked as saved — it would never have been sent').toBe(true);
        await new Promise(r => setTimeout(r, 120));
        expect(dev.pending.debounced, 'nothing scheduled the follow-up push').toBeGreaterThan(0);
        cloud.beforeCommit = null;
        expect(await dev.syncToCloud()).toBe(true);
        expect(cloudIds(cloud, 'expenses')).toEqual(['first', 'second']);
        expect(dev.isDirty).toBe(false);
    });

    it('a rejected write keeps the device dirty and names the cause', async () => {
        const cloud = makeCloud({ expenses: [] });
        const dev = makeDevice('phone', cloud);
        add(dev, 'expenses', { id: 'a', amount: 1 });
        cloud.offline = true;
        expect(await dev.syncToCloud()).toBe(false);
        expect(dev.isDirty).toBe(true);
        expect(dev.lastError).toBe('unavailable');
    });
});

/* ── 6. any order, any number of devices, the same answer ─────────────────────────────────────────────────────────── */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

describe('random interleavings of three devices and the statement worker always converge, and never lose a record', () => {
    it.each(Array.from({ length: 60 }, (_, i) => i + 1))('seed %i', async (seed) => {
        const r = rng(seed * 7919);
        const cloud = makeCloud({ expenses: [], incomeRecv: [] });
        const devs = [makeDevice('laptop', cloud), makeDevice('phone', cloud, { skewMs: -4 * 60000 }), makeDevice('tablet', cloud, { skewMs: 3 * 60000 })];
        const everAdded = new Set(), deleted = new Set();
        let n = 0;
        for (let step = 0; step < 50; step++) {
            const d = devs[Math.floor(r() * devs.length)];
            const op = r();
            const key = r() < 0.7 ? 'expenses' : 'incomeRecv';
            if (op < 0.30) { const id = `${key[0]}${++n}`; add(d, key, { id, amount: Math.floor(r() * 1000) }); everAdded.add(`${key}:${id}`); }
            else if (op < 0.45 && (d.appData[key] || []).length) { const t = d.appData[key][Math.floor(r() * d.appData[key].length)]; edit(d, key, t.id, { amount: Math.floor(r() * 1000) }); }
            else if (op < 0.55 && (d.appData[key] || []).length) { const t = d.appData[key][Math.floor(r() * d.appData[key].length)]; del(d, key, t.id); deleted.add(`${key}:${t.id}`); }
            else if (op < 0.70) { await d.syncToCloud(); }
            else if (op < 0.80) { d.deliver(); }
            else if (op < 0.88) { await d.reconcile('interval'); }
            else if (op < 0.94) { const id = `w${++n}`; cloud.serverWrite(doc => { (doc.expenses = doc.expenses || []).push({ id, amount: 1, source: 'statement', _ut: Date.now() }); }); everAdded.add(`expenses:${id}`); }
            else { cloud.offline = !cloud.offline; }
        }
        cloud.offline = false; devs.forEach(d => { d.nav.onLine = true; });
        await settle(devs, cloud, 4);
        for (const key of ['expenses', 'incomeRecv']) {
            const want = cloudIds(cloud, key);
            for (const d of devs) expect(d.ids(key), `${d.name} disagrees with the cloud about ${key} (seed ${seed})`).toEqual(want);
        }
        // nothing that was never deleted is missing; a deleted record that is still there was edited after its deletion
        for (const id of everAdded) {
            const [key, rid] = id.split(':');
            if (deleted.has(id)) continue;
            expect(cloudIds(cloud, key), `record ${id} was lost (seed ${seed})`).toContain(rid);
        }
        for (const d of devs) expect(d.isDirty, `${d.name} still has unsent changes (seed ${seed})`).toBe(false);
    });
});

/* ── the places that used to bypass all of this ───────────────────────────────────────────────────────────────────── */

describe('nothing else overwrites the cloud\'s lists, and two reports can be compared', () => {
    it('no session write replaces the cloud\'s session list with this device\'s copy', () => {
        expect(HTML).not.toMatch(/userDocRef\.set\(\{ sessions \}, \{ merge: true \}\)/);
        expect(blockAt('async function _pulseSessionHeartbeat()')).toMatch(/_wfLastHeartbeatWrite < 300000|300000/);
        expect(blockAt('async function registerCurrentSession()')).toMatch(/await syncToCloud\(\)/);
    });
    it('the diagnostics name the device (it asked for a function that does not exist) and carry a parity checksum per collection', () => {
        expect(HTML).not.toContain("typeof getDeviceId === 'function'");
        const health = blockAt('function _wfCollectHealth()');
        expect(health).toContain('_getDeviceId');
        expect(health).toContain('parity');
        expect(health).toContain('reconcileLoop');
    });
    it('the reconcile loop is started once the app is running, and watches resume, reconnect and the clock', () => {
        expect(HTML).toMatch(/finishBoot\(\);\s*try \{ _wfStartReconcileLoop\(\); \} catch/);
        const loop = blockAt('function _wfStartReconcileLoop()');
        for (const hook of ['visibilitychange', "'online'", 'pageshow', 'setInterval']) expect(loop).toContain(hook);
    });
});

describe('a cross-origin "Script error." is counted, not logged', () => {
    it('is filtered at the listener, before it can take one of the twenty slots of the error log', () => {
        const at = HTML.indexOf('function _wfInstallErrorBreadcrumb()');
        const body = HTML.slice(at, at + 2200);
        expect(body).toContain("e.message === 'Script error.'");
        expect(body).toContain('wf_masked_script_errors');
        expect(body.indexOf('wf_masked_script_errors')).toBeLessThan(body.indexOf("_wfLogClientError('window.onerror'"));
    });
});
