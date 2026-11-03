/* =============================================================================
 * test/cloud_rest_emulator_test.js — the account engine against Google's own Firestore emulator
 * -----------------------------------------------------------------------------
 * test/cloud_rest_test.js runs the engine against a stand-in for Firestore's REST endpoint. This runs the SAME engine against the real server code (the emulator
 * in firebase-tools), which is how the stand-in was checked: create with exists:false, a write that replaces exactly the listed fields, preconditions on the
 * update time, update times that compare equal between a write and a read, field names that need quoting, NaN, a document close to the size limit.
 *
 * Skipped unless FIRESTORE_EMULATOR_HOST is set (it needs Java and the emulator download, which CI does not have). To run it:
 *     npx firebase-tools emulators:exec --only firestore --project demo-wf "npx vitest run test/cloud_rest_emulator_test.js"
 * ===========================================================================*/

import { describe, it, expect, beforeEach } from 'vitest';
import * as H from '../wealthflow-sync-health.js';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const clone = (v) => JSON.parse(JSON.stringify(v));
const metaNow = () => ({ _lastModifiedBy: 'u1', _writeDeviceId: 'dev', _writeTs: 123 });

describe.skipIf(!HOST)('against the Firestore emulator', () => {
    const project = 'demo-wf';
    const fetchImpl = (u, o) => fetch(u.replace('https://firestore.googleapis.com', 'http://' + HOST), o);
    const client = () => H.createRestClient({ projectId: project, getToken: async () => 'owner', fetchImpl });
    let uid = 0, path;
    beforeEach(() => { path = 'users/emu' + (++uid) + '_' + Date.now(); });

    it('creates a document that does not exist, reads it back identically, and gives the same update time for the write and the read', async () => {
        const c = client();
        expect((await c.readDoc(path)).exists).toBe(false);
        const data = { expenses: [{ id: 'a1', amount: 12.5, cat: 'Food & Groceries', n: 3, neg: -4, big: 9007199254740991, t: true, z: null, e: [], m: {} }], settings: { theme: 'dark', 'weird key.with`tick': 1 }, 'සිංහල': 'ශ්‍රී ලංකා', nan: NaN, inf: Infinity };
        const w = await c.commit(path, { fields: data, meta: metaNow(), serverTime: ['_lastModified'], precondition: { exists: false } });
        const r = await c.readDoc(path);
        expect(H.sameTime(w.updateTime, r.updateTime)).toBe(true);
        for (const k of Object.keys(data)) expect(H.hashOf(r.data[k]), k).toBe(H.hashOf(data[k]));
        expect(H.diffKeys(data, H.hashesOf(r.data))).toEqual([]);
        expect(r.data._lastModified instanceof Date).toBe(true);
    });

    it('refuses a stale save and a create over an existing document, and calls both a lost race', async () => {
        const c = client();
        await c.commit(path, { fields: { a: 1 }, precondition: { exists: false } });
        const first = await c.readDoc(path);
        await c.commit(path, { fields: { a: 2 }, precondition: { updateTime: first.updateTime } });
        const stale = await c.commit(path, { fields: { a: 3 }, precondition: { updateTime: first.updateTime } }).then(() => null, (e) => e);
        expect(H.isConflict(stale), String(stale && stale.code)).toBe(true);
        const again = await c.commit(path, { fields: { a: 4 }, precondition: { exists: false } }).then(() => null, (e) => e);
        expect(H.isConflict(again), String(again && again.code)).toBe(true);
        const missing = await c.commit(path + 'x', { fields: { a: 1 }, precondition: { updateTime: first.updateTime } }).then(() => null, (e) => e);
        expect(H.isConflict(missing), String(missing && missing.code)).toBe(true);
        expect((await c.readDoc(path)).data.a).toBe(2);
    });

    it('replaces exactly the fields that are listed: a map loses a deleted key, every other field stays', async () => {
        const c = client();
        await c.commit(path, { fields: { settings: { a: 1, b: 2 }, expenses: [1, 2, 3], keep: 'me' } });
        const r0 = await c.readDoc(path);
        await c.commit(path, { fields: { settings: { b: 2 } }, precondition: { updateTime: r0.updateTime } });
        const r = (await c.readDoc(path)).data;
        expect(r.settings).toEqual({ b: 2 });
        expect(r.expenses).toEqual([1, 2, 3]);
        expect(r.keep).toBe('me');
    });

    it('a version-only read returns the update time and just the field asked for', async () => {
        const c = client();
        await c.commit(path, { fields: { big: 'x'.repeat(50000), _writeTs: 7 } });
        const p = await c.readDoc(path, { maskPaths: ['_writeTs'] });
        expect(p.data).toEqual({ _writeTs: 7 });
        expect(p.updateTime).toBeTruthy();
        expect(p.bytes).toBeLessThan(600);
    });

    it('two devices saving over each other lose nothing: the second is refused, merges, and saves again', async () => {
        const mk = () => H.createCloudSync({ client: client(), path });
        const A = mk(), B = mk(); const a = {}, b = {};
        const take = (into) => (data) => { for (const k of Object.keys(into)) delete into[k]; Object.assign(into, clone(data)); };
        await A.push({ apply: take(a), getLocal: () => ({ debtors: [], expenses: [{ id: 'e0' }] }), meta: metaNow });
        await A.pull({ apply: take(a), force: true }); await B.pull({ apply: take(b), force: true });
        a.debtors = [{ id: 'from-A' }];
        b.expenses = [{ id: 'e0' }, { id: 'from-B' }];
        await A.push({ apply: take(a), getLocal: () => clone(a), meta: metaNow });
        // B's save is based on the version before A's: refused by the account, merged here, sent again
        const merge = (data) => { const mine = clone(b); for (const k of Object.keys(b)) delete b[k]; Object.assign(b, clone(data), { expenses: mine.expenses }); };
        const r = await B.push({ apply: merge, getLocal: () => clone(b), meta: metaNow });
        expect(r.attempts).toBe(2);
        const final = (await client().readDoc(path)).data;
        expect(final.debtors).toEqual([{ id: 'from-A' }]);
        expect(final.expenses.map((x) => x.id)).toEqual(['e0', 'from-B']);
    });

    it('takes a document of about 800 KB in one save, and the check that follows is a few hundred bytes', async () => {
        const rows = Array.from({ length: 3200 }, (_, i) => ({ id: 'id' + i, amount: i * 1.25, cat: 'Food', note: 'x'.repeat(100) }));
        const eng = H.createCloudSync({ client: client(), path });
        const local = { expenses: rows, settings: { theme: 'dark' } };
        await eng.push({ apply: () => { }, getLocal: () => clone(local), meta: metaNow });
        expect(eng.state.last.write.bytes).toBeGreaterThan(700000);
        const r = await eng.pull({ apply: () => { throw new Error('read again for nothing'); } });
        expect(r.changed).toBe(false);
        expect(eng.state.last.probe.bytes).toBeLessThan(600);
    });
});
