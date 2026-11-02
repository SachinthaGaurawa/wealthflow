/* =============================================================================
 * test/cloud_rest_test.js — the account over plain HTTPS (wealthflow-sync-health.js, "THE ACCOUNT, OVER PLAIN HTTPS")
 * -----------------------------------------------------------------------------
 * Reported 2026-11-02 (Mac, Safari 17.6, build 7.69.35): "Reading your account" and "Saving to your account" both ended at 12 seconds with deadline-exceeded, in
 * the fast mode and the steady mode, with the offline cache already off, while a save sent straight to the account with the sign-in token took 1.2 seconds.
 * What is PROVEN about the library path (read in firebase 10.8.0's source and matched to the "INTERNAL ASSERTION FAILED: Unexpected state" stacks in that
 * device's own diagnostics): its transaction runner hangs for ever on an error code it does not know, and every save moved the WHOLE document. So saves,
 * reads and the "has anything changed?" check are now ordinary requests with their own deadlines, and a save sends only what differs.
 *
 * Here: the codec against an independently written one (and fast-check), the deadlines, the error mapping, the engine against a stand-in for Firestore's REST
 * endpoint (test/helpers/fake-firestore-rest.js, itself checked against Google's emulator), and the page's own syncToCloud / reconcile / forced pull over it.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import * as H from '../wealthflow-sync-health.js';
import { makeRestFetch, encodeValue, decodeValue, stamp } from './helpers/fake-firestore-rest.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const clone = (v) => JSON.parse(JSON.stringify(v));

function fnSource(name) {
    const start = HTML.search(new RegExp('(async )?function ' + name + '\\('));
    expect(start, `function ${name} is gone from index.html — retarget this test`).toBeGreaterThan(-1);
    let i = HTML.indexOf('{', HTML.indexOf(')', start)), depth = 0, q = null, j = i;
    for (; j < HTML.length; j++) {
        const c = HTML[j];
        if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && HTML[j + 1] === '/') { j = HTML.indexOf('\n', j); continue; }
        if (c === '/' && HTML[j + 1] === '*') { j = HTML.indexOf('*/', j) + 1; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    return HTML.slice(start, j + 1);
}

const newCloud = (data = {}) => ({ data: clone(data), version: 1, exists: true, offline: false });
const clientFor = (cloud, extra = {}) => H.createRestClient({ projectId: 'wf-test', getToken: async () => 'token', fetchImpl: makeRestFetch(cloud), ...extra });
const engineFor = (cloud) => H.createCloudSync({ client: clientFor(cloud), path: 'users/u1' });
const apply = (into) => (data) => { Object.keys(into).forEach((k) => delete into[k]); Object.assign(into, clone(data)); };
const metaNow = () => ({ _lastModifiedBy: 'u1', _writeDeviceId: 'dev', _writeTs: 123 });

/* ── 1. the value format ──────────────────────────────────────────────────────────────────────────────────────────── */
describe('the document codec', () => {
    const jsonValue = fc.letrec((tie) => ({
        leaf: fc.oneof(
            fc.string({ unit: 'grapheme-ascii' }), fc.string(), fc.constantFrom('ශ්‍රී ලංකා', '₨ 1,200.50', 'a.b', 'weird key`tick', ''),
            fc.integer({ min: -9007199254740991, max: 9007199254740991 }), fc.double({ noNaN: true, noDefaultInfinity: false }),
            fc.boolean(), fc.constant(null)),
        node: fc.oneof({ depthSize: 'small' }, tie('leaf'), fc.array(tie('node'), { maxLength: 5 }), fc.dictionary(fc.string({ maxLength: 8 }), tie('node'), { maxKeys: 5 })),
    })).node;

    it('what the page writes is read back identically by an independent decoder, and what an independent encoder writes is read back identically by the page', () => {
        fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), jsonValue, { maxKeys: 6 }), (doc) => {
            const wire = H.toFields(doc);
            const viaWire = Object.fromEntries(Object.entries(wire).map(([k, v]) => [k, decodeValue(v)]));
            expect(H.canonical(viaWire)).toBe(H.canonical(doc));
            const theirs = Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, encodeValue(v)]));
            expect(H.canonical(H.fromFields(theirs))).toBe(H.canonical(doc));
            // the whole point of the fingerprints: a value that went to the account and came back is the same value
            const hs = H.hashesOf(H.fromFields(wire)), hl = H.hashesOf(doc);
            for (const k of Object.keys(doc)) expect(hs[k]).toBe(hl[k]);
            expect(H.diffKeys(doc, hs)).toEqual([]);
        }), { numRuns: 300 });
    });

    it('writes integers as integerValue strings, other numbers as doubleValue, and keeps NaN and the infinities', () => {
        expect(H.toValue(12)).toEqual({ integerValue: '12' });
        expect(H.toValue(-3)).toEqual({ integerValue: '-3' });
        expect(H.toValue(12.5)).toEqual({ doubleValue: 12.5 });
        expect(H.toValue(2 ** 60)).toEqual({ doubleValue: 2 ** 60 });
        expect(H.toValue(NaN)).toEqual({ doubleValue: 'NaN' });
        expect(H.toValue(-Infinity)).toEqual({ doubleValue: '-Infinity' });
        expect(Number.isNaN(H.fromValue({ doubleValue: 'NaN' }))).toBe(true);
        expect(H.fromValue({ doubleValue: 'Infinity' })).toBe(Infinity);
        expect(H.fromValue({ integerValue: '9007199254740991' })).toBe(9007199254740991);
    });

    it('leaves out undefined and function fields (as the library does) and refuses what a document cannot hold', () => {
        expect(H.toFields({ a: 1, b: undefined, c() { }, d: null })).toEqual({ a: { integerValue: '1' }, d: { nullValue: 'NULL_VALUE' } });
        expect(H.toValue([1, undefined])).toEqual({ arrayValue: { values: [{ integerValue: '1' }, { nullValue: 'NULL_VALUE' }] } });
        expect(() => H.toValue(Symbol('x'))).toThrow();
        expect(() => H.toValue(() => 1)).toThrow();
        expect(() => H.toValue(new Date(NaN))).toThrow(/invalid date/);
        const deep = {}; let cur = deep; for (let i = 0; i < 70; i++) { cur.n = {}; cur = cur.n; }
        expect(() => H.toValue(deep)).toThrow(/too deeply/);
    });

    it('writes an empty list and an empty map the way Firestore reads them', () => {
        expect(H.toValue([])).toEqual({ arrayValue: {} });
        expect(H.toValue({})).toEqual({ mapValue: {} });
        expect(H.fromValue({ arrayValue: {} })).toEqual([]);
        expect(H.fromValue({ mapValue: {} })).toEqual({});
    });

    it('reads a timestamp with more than millisecond precision (Safari is not guaranteed to)', () => {
        const d = H.fromValue({ timestampValue: '2026-11-02T18:25:15.194109Z' });
        expect(d instanceof Date && d.toISOString()).toBe('2026-11-02T18:25:15.194Z');
    });

    it('quotes field paths the way Firestore does', () => {
        expect(H.fieldPath('expenses')).toBe('expenses');
        expect(H.fieldPath(['_writeTs'])).toBe('_writeTs');
        expect(H.fieldPath(['weird key.with`tick'])).toBe('`weird key.with\\`tick`');
        expect(H.fieldPath(['9lives'])).toBe('`9lives`');
        expect(H.fieldPath(['settings', 'a b'])).toBe('settings.`a b`');
    });

    it('is the same content whatever the order of a map\'s keys (Firestore hands maps back sorted)', () => {
        expect(H.hashOf({ b: 1, a: [{ y: 2, x: 1 }] })).toBe(H.hashOf({ a: [{ x: 1, y: 2 }], b: 1 }));
        expect(H.hashOf({ a: 1 })).not.toBe(H.hashOf({ a: 2 }));
        expect(H.hashOf([1, 2])).not.toBe(H.hashOf([2, 1]));
        expect(H.hashOf({ a: undefined, b: 1 })).toBe(H.hashOf({ b: 1 }));
        expect(H.hashOf(0)).toBe(H.hashOf(-0));
    });

    it('lists the fields that differ, never the stamps every save writes, never a field only the account has', () => {
        const local = { expenses: [1, 2], settings: { a: 1 }, _writeTs: 5, _lastModified: 1, gone: undefined };
        const cloud = { expenses: [1, 2], settings: { a: 2 }, driveRefresh: 'x', _writeTs: 4 };
        expect(H.diffKeys(local, H.hashesOf(cloud))).toEqual(['settings']);
        expect(H.diffKeys({ fresh: [] }, {})).toEqual(['fresh']);
    });
});

/* ── 2. errors and the clock ──────────────────────────────────────────────────────────────────────────────────────── */
describe('what the account answers, in the words the page already understands', () => {
    it('maps Firestore\'s own error bodies, including the array batchGet wraps them in', () => {
        const e1 = H.restError(401, [{ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }]);
        expect(e1.code).toBe('unauthenticated');
        expect(H.explainPushError(e1).kind).toBe('signin');
        expect(H.restError(400, { error: { status: 'FAILED_PRECONDITION', message: 'stored version does not match' } }).code).toBe('failed-precondition');
        expect(H.restError(409, { error: { status: 'ALREADY_EXISTS' } }).code).toBe('already-exists');
        expect(H.restError(404, { error: { status: 'NOT_FOUND' } }).code).toBe('not-found');
        expect(H.restError(429, { error: { status: 'RESOURCE_EXHAUSTED' } }).code).toBe('resource-exhausted');
        expect(H.explainPushError(H.restError(429, null)).kind).toBe('quota');
        expect(H.restError(503, null).code).toBe('unavailable');
        expect(H.restError(504, 'not json').code).toBe('deadline-exceeded');
        expect(H.restError(400, { error: { status: 'INVALID_ARGUMENT', message: 'too big' } }).code).toBe('invalid-argument');
        expect(H.explainPushError(H.restError(400, { error: { status: 'INVALID_ARGUMENT' } })).kind).toBe('data');
        expect(H.restError(418, null).code).toBe('unknown');
    });

    it('a conflict is a lost race, not a failure', () => {
        for (const code of ['failed-precondition', 'aborted', 'already-exists', 'not-found']) expect(H.isConflict({ code })).toBe(true);
        for (const code of ['unavailable', 'permission-denied', 'invalid-argument', 'deadline-exceeded', '']) expect(H.isConflict({ code })).toBe(false);
        expect(H.isConflict(null)).toBe(false);
    });

    it('gives a save time in proportion to what it sends, and never less than 20 seconds or more than 2 minutes', () => {
        expect(H.writeTimeoutMs(0)).toBe(20000);
        expect(H.writeTimeoutMs(1024)).toBe(21000);
        expect(H.writeTimeoutMs(50 * 1024)).toBe(70000);
        expect(H.writeTimeoutMs(1024 * 1024)).toBe(120000);          // a megabyte needs only about 9 KB a second to finish inside that
        expect(H.writeTimeoutMs(50 * 1024 * 1024)).toBe(120000);
        expect(H.writeTimeoutMs(undefined)).toBe(20000);
    });

    it('treats two spellings of one moment as the same update time', () => {
        expect(H.sameTime('2026-11-02T10:00:00.000100Z', '2026-11-02T10:00:00.0001Z')).toBe(true);
        expect(H.sameTime('2026-11-02T10:00:00.500000Z', '2026-11-02T10:00:00.5Z')).toBe(true);
        expect(H.sameTime('2026-11-02T10:00:00.000000Z', '2026-11-02T10:00:00Z')).toBe(true);
        expect(H.sameTime('2026-11-02T10:00:00.000101Z', '2026-11-02T10:00:00.000100Z')).toBe(false);
        expect(H.sameTime(null, '2026-11-02T10:00:00Z')).toBe(false);
    });
});

/* ── 3. nothing can hang ──────────────────────────────────────────────────────────────────────────────────────────── */
describe('every request has its own deadline', () => {
    function manualTimers() {
        let id = 0; const timers = new Map();
        return { setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimer: (i) => { timers.delete(i); }, timers, fireAll: () => { for (const [i, t] of [...timers]) { timers.delete(i); t.fn(); } } };
    }
    const never = new Promise(() => { });

    it('a request that never answers ends as deadline-exceeded (a network failure, retryable), and the connection is aborted', async () => {
        const t = manualTimers(); let signal = null;
        const client = H.createRestClient({ projectId: 'p', getToken: async () => 'tok', fetchImpl: (u, o) => { signal = o.signal; return never; }, setTimer: t.setTimer, clearTimer: t.clearTimer });
        const p = client.readDoc('users/u1');
        await new Promise((r) => setTimeout(r, 0));
        expect([...t.timers.values()].map((x) => x.ms)).toEqual([H.REST.READ_TIMEOUT_MS]);
        t.fireAll();
        const err = await p.then(() => null, (e) => e);
        expect(err.code).toBe('deadline-exceeded');
        expect(err.network).toBe(true);
        expect(err.message).toMatch(/read did not finish in 45 seconds/);
        expect(signal && signal.aborted).toBe(true);
        expect(H.explainPushError(err).kind).toBe('network');
        expect(t.timers.size).toBe(0);
    });

    it('a body that stops half-way ends the same way, not never', async () => {
        const t = manualTimers();
        const client = H.createRestClient({ projectId: 'p', getToken: async () => 'tok', fetchImpl: async () => ({ ok: true, status: 200, text: () => never }), setTimer: t.setTimer, clearTimer: t.clearTimer });
        const p = client.readDoc('users/u1', { maskPaths: ['_writeTs'] });
        await new Promise((r) => setTimeout(r, 0));
        expect([...t.timers.values()].map((x) => x.ms)).toEqual([H.REST.PROBE_TIMEOUT_MS]);
        t.fireAll();
        expect((await p.then(() => null, (e) => e)).code).toBe('deadline-exceeded');
    });

    it('a save is given 20 seconds plus a second per KB it sends', async () => {
        const t = manualTimers();
        const client = H.createRestClient({ projectId: 'p', getToken: async () => 'tok', fetchImpl: () => never, setTimer: t.setTimer, clearTimer: t.clearTimer });
        const body = 'x'.repeat(40000);
        const p = client.commit('users/u1', { fields: { big: body }, precondition: { exists: true } });
        await new Promise((r) => setTimeout(r, 0));
        const ms = [...t.timers.values()][0].ms;
        expect(ms).toBeGreaterThan(20000 + 39 * 1000);
        expect(ms).toBeLessThan(20000 + 42 * 1000);
        t.fireAll(); await p.catch(() => { });
    });

    it('a sign-in token that never arrives is a network failure too (it is a request of its own)', async () => {
        const t = manualTimers();
        const client = H.createRestClient({ projectId: 'p', getToken: () => never, fetchImpl: async () => { throw new Error('must not be reached'); }, setTimer: t.setTimer, clearTimer: t.clearTimer });
        const p = client.readDoc('users/u1');
        await new Promise((r) => setTimeout(r, 0));
        t.fireAll();
        const err = await p.then(() => null, (e) => e);
        expect(err.code).toBe('deadline-exceeded');
        expect(err.message).toMatch(/sign-in did not finish/);
    });

    it('a dead network reported by the sign-in library is the network, not a refused sign-in', async () => {
        const client = H.createRestClient({ projectId: 'p', getToken: async () => { throw Object.assign(new Error('A network error has occurred'), { code: 'auth/network-request-failed' }); }, fetchImpl: async () => ({}) });
        const err = await client.readDoc('users/u1').then(() => null, (e) => e);
        expect(err.network).toBe(true);
        expect(H.explainPushError(err).kind).toBe('network');
        const refused = H.createRestClient({ projectId: 'p', getToken: async () => { throw Object.assign(new Error('The user token has expired'), { code: 'auth/user-token-expired' }); }, fetchImpl: async () => ({}) });
        const e2 = await refused.readDoc('users/u1').then(() => null, (e) => e);
        expect(H.explainPushError(e2).kind).toBe('signin');
    });

    it('an answer of 401 renews the token once and asks again; a second 401 is a refused sign-in', async () => {
        const forced = []; let n = 0;
        const fetchImpl = async () => { n++; return n === 1 ? { ok: false, status: 401, text: async () => JSON.stringify([{ error: { status: 'UNAUTHENTICATED' } }]) } : { ok: true, status: 200, text: async () => JSON.stringify([{ missing: 'x' }]) }; };
        const client = H.createRestClient({ projectId: 'p', getToken: async (force) => { forced.push(!!force); return 'tok'; }, fetchImpl });
        expect((await client.readDoc('users/u1')).exists).toBe(false);
        expect(forced).toEqual([false, true]);
        const always = H.createRestClient({ projectId: 'p', getToken: async () => 'tok', fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{}' }) });
        expect((await always.readDoc('users/u1').then(() => null, (e) => e)).code).toBe('unauthenticated');
    });

    it('sends the sign-in token as a header, the body as text/plain (no extra permission round trip), prettyPrint off, and never keeps a copy of the response', async () => {
        const seen = [];
        const client = H.createRestClient({ projectId: 'wf-test', getToken: async () => 'SECRET', fetchImpl: async (u, o) => { seen.push([u, o]); return { ok: true, status: 200, text: async () => JSON.stringify({ writeResults: [{ updateTime: stamp(2) }] }) }; } });
        await client.commit('users/u1', { fields: { a: 1 }, meta: { _writeTs: 9 }, serverTime: ['_lastModified'], precondition: { updateTime: stamp(1) } });
        const [url, init] = seen[0];
        expect(url).toBe('https://firestore.googleapis.com/v1/projects/wf-test/databases/(default)/documents:commit?prettyPrint=false');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({ Authorization: 'Bearer SECRET', 'Content-Type': 'text/plain' });
        expect(init.cache).toBe('no-store');
        const w = JSON.parse(init.body).writes[0];
        expect(w.update.name).toBe('projects/wf-test/databases/(default)/documents/users/u1');
        expect(w.updateMask.fieldPaths.sort()).toEqual(['_writeTs', 'a']);
        expect(w.updateTransforms).toEqual([{ fieldPath: '_lastModified', setToServerValue: 'REQUEST_TIME' }]);
        expect(w.currentDocument).toEqual({ updateTime: stamp(1) });
    });
});

/* ── 4. the engine ────────────────────────────────────────────────────────────────────────────────────────────────── */
describe('a save sends only what differs, and is accepted only if nobody wrote in between', () => {
    const books = () => ({ expenses: Array.from({ length: 40 }, (_, i) => ({ id: 'e' + i, amount: i, note: 'x'.repeat(200), _ut: 1000 + i })), settings: { theme: 'dark', sms: { on: true } }, debtors: [{ id: 'd1', name: 'A', _ut: 5 }], incomeReceived: { a: 1, b: 2 } });

    it('reads once when it does not know the account yet, then sends only the field that changed', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        const getLocal = () => clone(local);
        let r = await eng.push({ apply: apply(local), getLocal, meta: metaNow });
        expect(r.upToDate).toBe(true);                       // this device holds exactly what the account holds: nothing is sent
        expect(cloud.commitAttempts || 0).toBe(0);
        expect(cloud.reads).toBe(1);
        local.settings.theme = 'light';
        r = await eng.push({ apply: apply(local), getLocal, meta: metaNow });
        expect(r.keys).toEqual(['settings']);
        expect(cloud.reads, 'a save with a known baseline must not read the account again').toBe(1);
        expect(cloud.data.settings.theme).toBe('light');
        expect(cloud.data.expenses.length, 'a field that was not sent was disturbed').toBe(40);
        expect(cloud.data._writeDeviceId).toBe('dev');
        expect(typeof cloud.data._lastModified).toBe('number');         // stamped by the server's clock
        expect(cloud.lastCommitBytes, 'one small field must not carry the whole document').toBeLessThan(2000);
        const once = cloud.lastCommitBytes;
        local.expenses.push({ id: 'new', amount: 1, _ut: 9 });
        r = await eng.push({ apply: apply(local), getLocal, meta: metaNow });
        expect(r.keys).toEqual(['expenses']);
        expect(cloud.lastCommitBytes).toBeGreaterThan(once);
        expect(cloud.data.expenses.length).toBe(41);
        r = await eng.push({ apply: apply(local), getLocal, meta: metaNow });
        expect(r.upToDate).toBe(true);
        expect(cloud.version).toBe(3);                         // two writes, and no third for nothing
    });

    it('another device writing in between is not overwritten: the save is refused, the newer copy merged, the save redone', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        await eng.pull({ apply: apply(local), force: true });
        local.settings.theme = 'light';
        let fired = false;
        cloud.beforeCommit = async () => { if (!fired) { fired = true; cloud.data = { ...cloud.data, debtors: [...cloud.data.debtors, { id: 'from-laptop', _ut: 9 }] }; cloud.version++; } };
        // the merge the page does: keep what this device has and add what the account has that it lacks
        const merge = (data) => { const mine = clone(local); Object.keys(local).forEach((k) => delete local[k]); Object.assign(local, clone(data), { settings: mine.settings }); };
        const r = await eng.push({ apply: merge, getLocal: () => clone(local), meta: metaNow });
        expect(r.attempts).toBe(2);
        expect(cloud.data.debtors.map((d) => d.id)).toEqual(['d1', 'from-laptop']);
        expect(cloud.data.settings.theme).toBe('light');
    });

    it('a save that keeps losing the race gives up with a "busy" error, not a hang', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        await eng.pull({ apply: apply(local), force: true });
        local.settings.theme = 'light';
        cloud.beforeCommit = async () => { cloud.version++; };
        const keepMine = (data) => { const mine = clone(local); Object.keys(local).forEach((k) => delete local[k]); Object.assign(local, clone(data), { settings: mine.settings }); };
        const err = await eng.push({ apply: keepMine, getLocal: () => clone(local), meta: metaNow }).then(() => null, (e) => e);
        expect(err.code).toBe('aborted');
        expect(H.explainPushError(err).kind).toBe('busy');
        expect(cloud.commitAttempts).toBe(H.REST.MAX_ATTEMPTS);
    });

    it('creates the document when the account has none yet, and refuses to overwrite one that appeared meanwhile', async () => {
        const cloud = newCloud({}); cloud.exists = false; const eng = engineFor(cloud); const local = { expenses: [{ id: 'a' }] };
        let r = await eng.push({ apply: apply(local), getLocal: () => clone(local), meta: metaNow });
        expect(r.keys).toEqual(['expenses']);
        expect(cloud.exists).toBe(true);
        expect(cloud.data.expenses).toEqual([{ id: 'a' }]);
        // a second device that also found no document: its create is refused (the document now exists), it reads, merges and saves again
        const cloud2 = newCloud({}); cloud2.exists = false; const eng2 = engineFor(cloud2); const local2 = { expenses: [{ id: 'mine' }] };
        let first = true;
        cloud2.beforeCommit = async () => { if (first) { first = false; cloud2.exists = true; cloud2.data = { expenses: [{ id: 'theirs' }] }; cloud2.version++; } };
        const merge = (data) => { local2.expenses = [...data.expenses, ...local2.expenses.filter((x) => !data.expenses.some((y) => y.id === x.id))]; };
        r = await eng2.push({ apply: merge, getLocal: () => clone(local2), meta: metaNow });
        expect(r.attempts).toBe(2);
        expect(cloud2.data.expenses.map((x) => x.id)).toEqual(['theirs', 'mine']);
    });

    it('a key deleted from a map really leaves the account, and no other field is touched', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        await eng.pull({ apply: apply(local), force: true });
        delete local.incomeReceived.a;
        const r = await eng.push({ apply: apply(local), getLocal: () => clone(local), meta: metaNow });
        expect(r.keys).toEqual(['incomeReceived']);
        expect(cloud.data.incomeReceived).toEqual({ b: 2 });
        expect(cloud.data.debtors.length).toBe(1);
    });

    it('a big save first asks whether the account is still the copy it merged, so a megabyte is not sent to be refused', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        await eng.pull({ apply: apply(local), force: true });
        local.expenses = Array.from({ length: 400 }, (_, i) => ({ id: 'n' + i, amount: i, note: 'y'.repeat(200) }));   // far above the pre-check size
        cloud.data = { ...cloud.data, debtors: [{ id: 'd1' }, { id: 'later' }] }; cloud.version++;                    // somebody else wrote since this device read
        const merge = (data) => { const mine = clone(local); Object.keys(local).forEach((k) => delete local[k]); Object.assign(local, clone(data), { expenses: mine.expenses }); };
        const r = await eng.push({ apply: merge, getLocal: () => clone(local), meta: metaNow });
        expect(r.attempts).toBe(2);
        expect(cloud.commitAttempts, 'the big save was sent although the account had already moved').toBe(1);
        expect(cloud.probes).toBeGreaterThanOrEqual(2);
        expect(cloud.data.debtors.map((d) => d.id)).toEqual(['d1', 'later']);
        expect(cloud.data.expenses.length).toBe(400);
    });

    it('a failed save keeps what it knew: the next try needs no read, and nothing is claimed saved', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        await eng.pull({ apply: apply(local), force: true });
        local.settings.theme = 'light';
        cloud.offline = true;
        const err = await eng.push({ apply: apply(local), getLocal: () => clone(local), meta: metaNow }).then(() => null, (e) => e);
        expect(err.code).toBe('unavailable');
        expect(err.network).toBe(true);
        expect(cloud.data.settings.theme).toBe('dark');
        cloud.offline = false;
        const reads = cloud.reads;
        const r = await eng.push({ apply: apply(local), getLocal: () => clone(local), meta: metaNow });
        expect(r.keys).toEqual(['settings']);
        expect(cloud.reads).toBe(reads);
        expect(cloud.data.settings.theme).toBe('light');
    });

    it('a refused sign-in or an invalid document is raised as it is, not retried as a race', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        await eng.pull({ apply: apply(local), force: true });
        local.settings.theme = 'light';
        cloud.failCommit = { status: 403, code: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' };
        const err = await eng.push({ apply: apply(local), getLocal: () => clone(local), meta: metaNow }).then(() => null, (e) => e);
        expect(err.code).toBe('permission-denied');
        expect(cloud.commitAttempts).toBe(1);
    });

    it('saves and reads started together run one after the other, never interleaved, and a second save finds the first already covered it', async () => {
        const cloud = newCloud(books()); const local = {};
        let inFlight = 0, peak = 0; const f = makeRestFetch(cloud);
        const eng = H.createCloudSync({ client: H.createRestClient({ projectId: 'p', getToken: async () => 't', fetchImpl: async (u, o) => { inFlight++; peak = Math.max(peak, inFlight); try { await new Promise((r) => setTimeout(r, 2)); return await f(u, o); } finally { inFlight--; } } }), path: 'users/u1' });
        await eng.pull({ apply: apply(local), force: true });
        local.settings.theme = 'light';
        const a = eng.push({ apply: apply(local), getLocal: () => clone(local), meta: metaNow });
        local.debtors.push({ id: 'd2' });
        const b = eng.push({ apply: apply(local), getLocal: () => clone(local), meta: metaNow });
        const c = eng.pull({ apply: apply(local) });
        const [ra, rb, rc] = await Promise.all([a, b, c]);
        expect(ra.keys.sort()).toEqual(['debtors', 'settings']);     // taken when it ran, so it carried both edits
        expect(rb.upToDate).toBe(true);
        expect(rc.changed).toBe(false);
        expect(peak, 'two requests were in flight at once').toBe(1);
        expect(cloud.commitAttempts).toBe(1);
        expect(cloud.data.debtors.length).toBe(2);
    });

    it('asks "has anything changed?" with a few hundred bytes, and reads the whole document only when it has', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        let r = await eng.pull({ apply: apply(local) });
        expect(r).toMatchObject({ changed: true, exists: true });
        expect(cloud.reads).toBe(1);
        let applied = 0;
        r = await eng.pull({ apply: () => { applied++; } });
        expect(r.changed).toBe(false);
        expect(applied).toBe(0);
        expect(eng.state.last.probe.bytes, 'the check must be a few hundred bytes').toBeLessThan(600);
        cloud.data = { ...cloud.data, settings: { theme: 'blue' } }; cloud.version++;
        r = await eng.pull({ apply: apply(local) });
        expect(r.changed).toBe(true);
        expect(local.settings.theme).toBe('blue');
        // our own save moves the version too: the next check must not take it for somebody else's change
        local.settings.theme = 'red';
        await eng.push({ apply: apply(local), getLocal: () => clone(local), meta: metaNow });
        r = await eng.pull({ apply: () => { throw new Error('read again for nothing'); } });
        expect(r.changed).toBe(false);
    });

    it('reads the document without merging it (the first read at sign-in), and remembers what the page then merged', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud);
        const got = await eng.read();
        expect(got.exists).toBe(true);
        expect(got.data.settings.theme).toBe('dark');
        expect(got.updateTime).toBe(stamp(1));
        expect(Object.keys(got.hashes)).toContain('expenses');
        expect(eng.state.ver, 'a read that was not merged must not count as merged').toBe(null);
        eng.adopt({ hashes: got.hashes, updateTime: got.updateTime });
        const local = clone(got.data); local.settings.theme = 'light';
        const r = await eng.push({ apply: () => { throw new Error('read again for nothing'); }, getLocal: () => clone(local), meta: metaNow });
        expect(r.keys).toEqual(['settings']);
    });

    it('says what a save would send now, for the connection report', async () => {
        const cloud = newCloud(books()); const eng = engineFor(cloud); const local = {};
        expect(eng.plan(local).known).toBe(false);
        await eng.pull({ apply: apply(local), force: true });
        expect(eng.plan(local)).toMatchObject({ known: true, keys: [], bytes: 0 });
        local.settings.theme = 'light';
        const p = eng.plan(local);
        expect(p.keys).toEqual(['settings']);
        expect(p.bytes).toBeGreaterThan(10);
        eng.forget();
        expect(eng.plan(local).known).toBe(false);
    });
});

/* ── 5. the page, saving over it ──────────────────────────────────────────────────────────────────────────────────── */
describe('the page\'s syncToCloud over plain requests keeps its contract', () => {
    const DEPS = ['userDocRef', 'navigator', 'setSyncStatus', 'isDirty', '_flushCloudDeletes', 'appData', 'firebase', 'currentUser', '_getDeviceId', 'setDirty', 'console', 'notify', 'DB', 'localStorage', 'window',
        '_wfCloudSafe', '_wfApplyCloudData', 'debouncedSync', '_wfPaintCloudChange', '_wfCloudSync', '_wfApplyPendingDeletesLocally'];
    function load(over = {}) {
        const cloud = over.cloud || newCloud({ expenses: [{ id: 'a', amount: 1 }], settings: { theme: 'dark' }, incomeReceived: { k1: 1, k2: 2 } });
        const eng = engineFor(cloud);
        const win = { currentUser: { uid: 'u1' } };
        const calls = [];
        const st = { pending: over.pending || [] };
        const env = {
            userDocRef: over.userDocRef !== undefined ? over.userDocRef : { firestore: { runTransaction: () => { throw new Error('the library transaction must not be used'); } }, set: () => { throw new Error('the library set must not be used'); } },
            navigator: { onLine: over.onLine !== false }, setSyncStatus: (x) => calls.push('status:' + x), isDirty: over.isDirty !== undefined ? over.isDirty : true,
            _flushCloudDeletes: () => calls.push('flush'),
            appData: over.appData || { expenses: [{ id: 'a', amount: 1 }, { id: 'b', amount: 2 }], settings: { theme: 'dark' }, incomeReceived: { k2: 2 } },
            firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } }, currentUser: { uid: 'u1' }, _getDeviceId: () => 'dev1',
            setDirty: (v) => calls.push('dirty:' + v), console: { log() { }, warn() { }, error() { } }, notify: () => { }, DB: {}, localStorage: { getItem: () => null, setItem() { }, removeItem() { } }, window: win,
            _wfCloudSafe: new Function(fnSource('_wfCloudSafe') + '\nreturn _wfCloudSafe;')(),
            _wfApplyCloudData: (data) => { calls.push('merge'); return { nonSessionChanged: false, sessionsChanged: false, needPush: false }; },
            debouncedSync: () => calls.push('debounced'), _wfPaintCloudChange: () => { }, _wfCloudSync: over.noModule ? () => null : () => eng, _wfApplyPendingDeletesLocally: () => { calls.push('strip'); },
        };
        const body = fnSource('_persistRaw') + '\n' + fnSource('_persistLocal') + '\n' + fnSource('_wfMergeSeen') + '\n' + fnSource('syncToCloud')
            + '\nreturn { syncToCloud, getRun: () => window._wfSyncRun, pending: () => _pendingCloudDeletes };';
        const api = new Function(...DEPS, 'let _lastCloudPushError = ""; let _wfLocalWriteBlocked = false; let _dirtyGen = 0; let isSyncingFromCloud = false; let _pendingCloudDeletes = ' + JSON.stringify(st.pending) + '; function _persistPendingDeletes() { }\n' + body)(...DEPS.map((d) => env[d]));
        return { ...api, cloud, eng, calls, win, env };
    }

    it('resolves true only after the account accepted the save, and never touches the library\'s transaction', async () => {
        const t = load();
        expect(await t.syncToCloud()).toBe(true);
        expect(t.cloud.data.expenses.map((x) => x.id)).toEqual(['a', 'b']);
        expect(t.cloud.commitAttempts).toBe(1);
        expect(t.calls).not.toContain('flush');
        expect(t.calls).toContain('dirty:false');
        expect(t.win._wfLastPush).toMatchObject({ via: 'https', upToDate: false });
        expect(t.win._wfLastPush.keys).toBe(2);                        // expenses (a record was added) and incomeReceived (a key was deleted); settings are the same on both sides, so not sent
        expect(t.cloud.data.settings).toEqual({ theme: 'dark' });
    });

    it('resolves false when the account refuses, keeps the device dirty, and reports the cause', async () => {
        const t = load();
        t.cloud.failCommit = { status: 403, code: 'PERMISSION_DENIED', message: 'Missing or insufficient permissions.' };
        expect(await t.syncToCloud()).toBe(false);
        expect(t.calls).not.toContain('dirty:false');
    });

    it('resolves false (not a hang, not a rejection) when the network is down, and the local copy of the books is not touched', async () => {
        const t = load();
        t.cloud.offline = true;
        await expect(t.syncToCloud()).resolves.toBe(false);
        expect(t.env.appData.expenses.length).toBe(2);
        expect(t.calls).not.toContain('dirty:false');
    });

    it('resolves true without any request when nothing is waiting', async () => {
        const t = load({ isDirty: false });
        expect(await t.syncToCloud()).toBe(true);
        expect(t.cloud.requests || 0).toBe(0);
    });

    it('keeps the push in flight where a restore can wait for it, and lets go once it has finished', async () => {
        const t = load();
        const run = t.syncToCloud();
        expect(t.getRun()).toBe(run);
        expect(await run).toBe(true);
        await Promise.resolve();
        expect(t.getRun()).toBe(null);
    });

    it('queued map-key deletions leave with the save: the key is gone from the account, and the queue is cleared once it is saved', async () => {
        const t = load({ pending: [['incomeReceived', 'k1']], appData: { expenses: [{ id: 'a', amount: 1 }], settings: { theme: 'dark' }, incomeReceived: { k2: 2 } } });
        expect(await t.syncToCloud()).toBe(true);
        expect(t.cloud.data.incomeReceived).toEqual({ k2: 2 });
        expect(t.pending(), 'a delivered delete stayed in the queue').toEqual([]);
        expect(t.calls).toContain('strip');
    });

    it('a delete that did not get through stays queued for the next try', async () => {
        const t = load({ pending: [['incomeReceived', 'k1']], appData: { expenses: [{ id: 'a', amount: 1 }], settings: { theme: 'dark' }, incomeReceived: { k2: 2 } } });
        t.cloud.offline = true;
        expect(await t.syncToCloud()).toBe(false);
        expect(t.pending()).toEqual([['incomeReceived', 'k1']]);
        expect(t.cloud.data.incomeReceived).toEqual({ k1: 1, k2: 2 });
    });

    it('falls back to the library\'s transaction only when the connection module is not there', async () => {
        const writes = [];
        const ref = { firestore: { runTransaction: async (fn) => { await fn({ get: async () => ({ exists: false }), set: (r, d) => writes.push(d) }); } } };
        const t = load({ noModule: true, userDocRef: ref });
        expect(await t.syncToCloud()).toBe(true);
        expect(writes.length).toBe(1);
        expect(t.calls).toContain('flush');
        expect(t.cloud.requests || 0).toBe(0);
    });
});

/* ── 6. the rest of the page ──────────────────────────────────────────────────────────────────────────────────────── */
describe('every way the page reads or writes the account goes through the same engine', () => {
    it('the reconcile loop asks for the version only, and merges only when the account changed', async () => {
        const body = fnSource('_wfReconcileWithCloud');
        expect(body).toMatch(/cs\.pull\(\{ apply:/);
        expect(body).toMatch(/if \(!r\.changed\)/);
        expect(body).toMatch(/userDocRef\.get\(\{ source: 'server' \}\)/);          // the fallback
        expect(HTML).toMatch(/setInterval\(\(\) => \{ if \(document\.visibilityState !== 'hidden'\) _wfReconcileWithCloud\('interval'\); \}, 20000\)/);
    });

    it('the first read at sign-in is one plain request, merged by the same function, then remembered', () => {
        const at = HTML.indexOf('const rr = await _withTimeout(_cs.read(), 12000);');
        expect(at, 'the sign-in read is no longer over the engine').toBeGreaterThan(0);
        const around = HTML.slice(at - 700, at + 2000);
        expect(around).toMatch(/_wfCloudSync\(\)/);
        expect(HTML).toMatch(/doc\._cs\.adopt\(\{ hashes: doc\._rest\.hashes, updateTime: doc\._rest\.updateTime \}\)/);
        expect(HTML.indexOf('doc._cs.adopt(')).toBeGreaterThan(HTML.indexOf('const _initApplied = _wfApplyCloudData(cloudData);'));
    });

    it('the restore and wipe flows read the account over the engine as well, with the library as the fallback', () => {
        const body = fnSource('_wfServerGet');
        expect(body).toMatch(/cs\.read\(\)/);
        expect(body).toMatch(/userDocRef\.get\(\{ source: 'server' \}\)/);
    });

    it('the heartbeat, a field edit and a settings toggle all end in the one save (none writes the whole document itself)', () => {
        const save = fnSource('syncToCloud');
        expect(save).toMatch(/cs\.push\(\{/);
        expect(save.match(/userDocRef\.set\(/g) || []).toEqual([]);
        expect(fnSource('_flushCloudDeletes')).toMatch(/if \(_wfCloudSync\(\)\) \{ if \(!isDirty\) setDirty\(true\); if \(!window\._wfSyncRun\) debouncedSync\(\); return; \}/);
    });

    it('Check Connection times the real read and the real save, names what a save sends, and does not fail because a live stream is down', () => {
        const checks = fnSource('_wfSyncChecks');
        for (const id of ['read', 'write', 'size', 'live', 'data']) expect(checks).toContain(`id: '${id}'`);
        expect(checks).toMatch(/id: 'read'[^\n]*via: 'https'/);
        expect(checks).toMatch(/id: 'write'[^\n]*via: 'https'/);
        expect(checks).not.toMatch(/id: '(direct|storage|queue)'/);
        expect(checks).toMatch(/id: 'live'[\s\S]{0,400}ok: true/);
        expect(checks).toContain("'/syncProbe/ping'");
    });

    it('the banner no longer offers Repair connection or steady mode for a save that does not go through the library', () => {
        const banner = fnSource('_wfRenderSyncBanner');
        expect(banner).toMatch(/!_wfCloudSync\(\) && v\.repairable/);
        expect(banner).toMatch(/!_wfCloudSync\(\) && v\.kind === 'network'/);
        expect(HTML.slice(HTML.indexOf('window._wfSyncFailed = function'), HTML.indexOf('window._wfSyncOk = function'))).toMatch(/!_wfCloudSync\(\) && H\.shouldAutoRepair/);
    });

    it('the connection module is loaded by the page and exposes the engine', () => {
        expect(HTML).toContain('<script type="module" src="wealthflow-sync-health.js"></script>');
        for (const n of ['createRestClient', 'createCloudSync', 'writeTimeoutMs', 'REST', 'restError', 'sameTime', 'savesText']) expect(H.default[n], n).toBeTruthy();
    });
});

describe('the connection report and the verdict, for reads and saves over plain requests', () => {
    const ok = (id) => ({ id, label: id, ok: true, ms: 5, detail: 'fine' });
    const bad = (id, detail, via = 'https') => ({ id, label: id, ok: false, ms: 12000, detail, via });
    const front = [ok('server'), ok('google'), ok('signin')];

    it('a read that does not finish points at the way in, offers no repair (there is no library queue to repair), and never mentions the library', () => {
        const v = H.verdict([...front, bad('read', 'deadline-exceeded: The read did not finish in 45 seconds.')]);
        expect(v.ok).toBe(false);
        expect(v.repair).toBeFalsy();
        expect(v.text).toMatch(/reading your account did not finish/);
        expect(v.text).not.toMatch(/queue|steady|offline cache/i);
    });
    it('a save that does not finish is not called a refusal, and offers no repair', () => {
        const v = H.verdict([...front, ok('read'), bad('write', 'deadline-exceeded: The save did not finish in 21 seconds.')]);
        expect(v.text).toMatch(/saving to it did not finish/);
        expect(v.text).not.toMatch(/sign out and sign in|not allowed/i);
        expect(v.repair).toBeFalsy();
    });
    it('a save the account refuses still says to sign in again', () => {
        const v = H.verdict([...front, ok('read'), bad('write', 'permission-denied: Missing or insufficient permissions.')]);
        expect(v.text).toMatch(/refused the save/);
        expect(v.repair).toBeFalsy();
        expect(H.verdict([...front, bad('read', 'unauthenticated: the token was refused')]).text).toMatch(/sign-in could not be renewed/);
    });
    it('the verdict keeps its words for the library rows too (a report from an older build is read the same way)', () => {
        const v = H.verdict([...front, ok('read'), { id: 'write', label: 'w', ok: false, ms: 1, detail: 'x' }, { id: 'direct', label: 'd', ok: true, ms: 1, detail: 'x' }]);
        expect(v.text).toMatch(/saving queue inside this browser/);
        expect(v.repair).toBe(true);
    });
    it('a check step may set its own deadline and says how it was sent', async () => {
        let clockNow = 0;
        const rows = await H.runChecks([{ id: 'read', label: 'Reading', via: 'https', timeoutMs: 50, run: () => new Promise((r) => setTimeout(() => r('late'), 120)) }, { id: 'x', label: 'X', run: async () => 'fine' }], { timeoutMs: 5, clock: () => clockNow++ });
        expect(rows[0]).toMatchObject({ id: 'read', via: 'https', ok: false });
        expect(rows[0].detail).toMatch(/did not answer in 0 seconds|did not answer/);
        expect(rows[1]).toMatchObject({ id: 'x', ok: true });
        expect(rows[1].via).toBeUndefined();
    });
    it('prints what the last save, read and check took, without any account id, token or data', () => {
        const text = H.reportText([ok('server')], { when: new Date('2026-11-02T10:00:00Z'), saves: { write: { bytes: 20480, ms: 640 }, read: { bytes: 786432, ms: 2100 }, probe: { bytes: 329, ms: 180 } } });
        expect(text).toMatch(/Saves: plain secure requests; last save 20 KB in 640 ms; last read 768 KB in 2100 ms; last check 0 KB in 180 ms/);
        expect(H.savesText({})).toMatch(/last save none yet; last read none yet; last check none yet/);
        expect(text).not.toMatch(/Bearer|token|users\//i);
    });
});
