/* =============================================================================
 * test/cloud_merge_test.js — the half of the sync that had no clock
 * -----------------------------------------------------------------------------
 * v7.52.0 gave every RECORD an update time and made the record arrays converge
 * across devices: newest wins, deletions leave a tombstone, the merge is
 * commutative and idempotent. That work was real and it holds — the first four
 * tests below re-prove it.
 *
 * It stopped at the record arrays. Everything ELSE in the document —
 * incomeReceived, balance, cribAnalyses, settings, and any key the cloud
 * carries that this build has never heard of — stayed on the rule v7.52.0 was
 * written to abolish: whatever the snapshot says, copy it over local. No
 * recency check, no union, no flag raised.
 *
 * That is not a narrow race. Driven against the shipped merge code:
 *
 *     phone offline, user marks 2026-03, -04 and -05 received
 *       appData.incomeReceived = {01,02,03,04,05}
 *     phone reconnects; the first snapshot in is the laptop's, which has {01,02}
 *       appData.incomeReceived = {01,02}
 *       written straight to localStorage over the good copy
 *       needPush = false, so nothing would ever push the survivors back
 *
 * Three months of the user's marks destroyed by one incoming snapshot, and the
 * pending local sync then uploads the truncated map. Same shape for balance and
 * for every map key the app has.
 *
 * The fix is the clock the records already had, applied one level up: _kut[key]
 * is stamped on every local DB.set, rides in appData next to _tomb, and the
 * merge takes the side whose stamp is newer. Plain objects UNION instead of
 * replacing, so a key on only one side is never lost — removing a map key has
 * its own path (DB.delKey → a real server field-delete), because a merge-write
 * cannot express a deletion at all.
 *
 * Two more things this file pins:
 *
 *   - settings converged locally but never pushed. Local always won and
 *     needPush was never set, so the CLOUD kept a stale settings blob forever
 *     and a third device hydrating from it got the wrong answer.
 *
 *   - a delete that could not be written to disk was swallowed by a bare
 *     catch. On a full device the tombstone never landed, the app forgot the
 *     deletion on the next reload, and the record walked back in from the
 *     cloud. It now goes through _persistLocal: free the re-fetchable caches,
 *     retry, and if it still cannot be saved, TELL THE USER.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Source of a top-level block, by brace matching from a literal start marker. */
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

/**
 * The real merge, in one scope, over a localStorage that can be made full.
 * Nothing is stubbed except the browser: _persistLocal, _wfStampAndTomb,
 * _wfMergeKeyed and _wfApplyCloudData are the shipped source.
 */
function loadMerge() {
    const store = new Map();
    const notes = [];
    let failWrites = false;
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => {
            if (failWrites) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; }
            store.set(k, String(v));
        },
        removeItem: (k) => store.delete(k),
    };
    const appData = {};
    const src = [
        constAt(/const _WF_RECORD_KEYS = \[[^\]]*\];/, '_WF_RECORD_KEYS'),
        constAt(/const _WF_TOMB_TTL = [^;]*;/, '_WF_TOMB_TTL'),
        constAt(/const _WF_SYNC_META_KEYS = \{[^}]*\};/, '_WF_SYNC_META_KEYS'),
        constAt(/const _WF_KUT_EXEMPT = \{[^}]*\};/, '_WF_KUT_EXEMPT'),
        blockAt('function _utOf(r)'),
        blockAt('function _recSig(r)'),
        blockAt('function _recPreferred(a, b)'),
        blockAt('function _wfStampAndTomb(key, newArr)'),
        blockAt('function _wfMergeRecordArray(localArr, cloudArr, tombMap)'),
        blockAt('function _wfMergeTombMaps(a, b)'),
        blockAt('function _persistLocal(key, value, raw)'),
        blockAt('function _persistRaw(key, str)'),
        blockAt('function _wfStampKey(k)'),
        blockAt('function _wfMergeKeyed(localVal, cloudVal, lts, cts)'),
        blockAt('function _wfApplyCloudData(cloudData)'),
    ].join('\n');
    const api = new Function('localStorage', 'appData', 'notify', 'console',
        src + '; let _wfLocalWriteBlocked = false;'
        + ' return { _wfStampAndTomb, _wfMergeRecordArray, _wfMergeTombMaps,'
        + ' _wfStampKey, _wfMergeKeyed, _wfApplyCloudData };'
    )(localStorage, appData, (m, t) => notes.push([t, m]), { log() {}, warn() {}, error() {} });
    return { api, appData, store, notes, setFull: (v) => { failWrites = v; } };
}

const J = (x) => JSON.stringify(x);
/** key-order-insensitive compare — {a,b} and {b,a} are the same document */
const S = (v) => {
    if (Array.isArray(v)) return '[' + v.map(S).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => J(k) + ':' + S(v[k])).join(',') + '}';
    return J(v);
};

/* ── 1. the record CRDT, still intact ─────────────────────────────────────── */

describe('records converge across devices', () => {
    const seed = [{ id: 'e1', amount: 100, _ut: 1000 }, { id: 'e2', amount: 200, _ut: 1000 }];

    it('two devices editing different records end up identical', () => {
        const A = loadMerge(), B = loadMerge();
        A.appData.expenses = JSON.parse(J(seed)); B.appData.expenses = JSON.parse(J(seed));
        A.appData.expenses[0].amount = 111; A.appData.expenses[0]._ut = 2000;
        B.appData.expenses[1].amount = 222; B.appData.expenses[1]._ut = 2001;
        A.api._wfApplyCloudData({ expenses: JSON.parse(J(B.appData.expenses)) });
        B.api._wfApplyCloudData({ expenses: JSON.parse(J(A.appData.expenses)) });
        expect(S(A.appData.expenses), 'the two devices disagree about the expense list')
            .toBe(S(B.appData.expenses));
        expect(A.appData.expenses).toHaveLength(2);
    });

    it('a delete on one device removes the record on the other', () => {
        const A = loadMerge(), B = loadMerge();
        A.appData.expenses = JSON.parse(J(seed)); A.store.set('wf2_expenses', J(seed));
        B.appData.expenses = JSON.parse(J(seed));
        A.appData.expenses = A.api._wfStampAndTomb('expenses', A.appData.expenses.filter(r => r.id !== 'e1'));
        B.api._wfApplyCloudData({ expenses: JSON.parse(J(A.appData.expenses)), _tomb: JSON.parse(J(A.appData._tomb)) });
        expect(B.appData.expenses.map(r => r.id), 'the deleted row came back on the other device')
            .toEqual(['e2']);
    });

    it('an edit made AFTER a delete beats the delete', () => {
        const A = loadMerge(), B = loadMerge();
        A.appData.expenses = JSON.parse(J(seed)); A.store.set('wf2_expenses', J(seed));
        B.appData.expenses = JSON.parse(J(seed));
        A.api._wfStampAndTomb('expenses', []);
        const delTs = A.appData._tomb.expenses.e1;
        B.appData.expenses[0].amount = 999; B.appData.expenses[0]._ut = delTs + 5000;
        B.api._wfApplyCloudData({ expenses: [], _tomb: JSON.parse(J(A.appData._tomb)) });
        expect(B.appData.expenses.map(r => r.id), 'a row edited after it was deleted elsewhere was still dropped')
            .toContain('e1');
    });

    it('applying the same snapshot twice changes nothing the second time', () => {
        const A = loadMerge();
        A.appData.expenses = [{ id: 'e1', _ut: 1000 }];
        const cloud = { expenses: [{ id: 'e2', _ut: 2000 }] };
        A.api._wfApplyCloudData(JSON.parse(J(cloud)));
        const second = A.api._wfApplyCloudData(JSON.parse(J(cloud)));
        expect(second.nonSessionChanged, 'the merge is not idempotent — every snapshot re-renders the app')
            .toBe(false);
    });
});

/* ── 2. the keys that had no clock ────────────────────────────────────────── */

describe('a foreign snapshot cannot destroy unpushed local work', () => {
    it('offline edits to incomeReceived survive the reconnect snapshot', () => {
        const P = loadMerge();
        P.appData.incomeReceived = { '2026-01': true, '2026-02': true };
        // three more months marked received while offline, through the real write path
        P.appData.incomeReceived['2026-03'] = true;
        P.appData.incomeReceived['2026-04'] = true;
        P.appData.incomeReceived['2026-05'] = true;
        P.api._wfStampKey('incomeReceived');
        P.store.set('wf2_incomeReceived', J(P.appData.incomeReceived));   // as DB.set would have

        // reconnect: the laptop's snapshot only knows January and February
        const res = P.api._wfApplyCloudData({ incomeReceived: { '2026-01': true, '2026-02': true }, expenses: [] });

        expect(Object.keys(P.appData.incomeReceived).sort(),
            'an incoming snapshot wiped months the user had already marked received')
            .toEqual(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
        expect(P.store.get('wf2_incomeReceived'), 'the truncated map was written over the good one on disk')
            .toContain('2026-05');
        expect(res.needPush, 'the survivors would never be pushed back to the cloud').toBe(true);
    });

    it('a key present only on this device is pushed, not silently kept local', () => {
        const P = loadMerge();
        P.appData.cribAnalyses = { r1: { score: 700 } };
        const res = P.api._wfApplyCloudData({ expenses: [] });
        expect(P.appData.cribAnalyses).toEqual({ r1: { score: 700 } });
        expect(res.needPush, 'the cloud has never seen this key and nothing asks for a push').toBe(true);
    });

    it('the newer write wins for a compound value, and both devices agree', () => {
        const older = { _kut: { balance: 100 }, balance: { total: 5000, flows: [] } };
        const newer = { _kut: { balance: 300 }, balance: { total: 9000, flows: [{ id: 'f1' }] } };
        const A = loadMerge(); Object.assign(A.appData, JSON.parse(J(older)));
        const B = loadMerge(); Object.assign(B.appData, JSON.parse(J(newer)));
        A.api._wfApplyCloudData(JSON.parse(J(newer)));
        B.api._wfApplyCloudData(JSON.parse(J(older)));
        expect(S(A.appData.balance)).toBe(S(B.appData.balance));
        expect(A.appData.balance.total, 'the older balance overwrote the newer one').toBe(9000);
    });

    it('a stamped local map beats a legacy cloud copy that carries no stamps', () => {
        const P = loadMerge();
        P.appData.incomeReceived = { '2026-01': true };
        P.api._wfStampKey('incomeReceived');
        P.api._wfApplyCloudData({ incomeReceived: {} });
        expect(P.appData.incomeReceived, 'an unstamped legacy document erased a stamped local write')
            .toEqual({ '2026-01': true });
    });

    it('merging one key is commutative wherever either side carries a stamp', () => {
        const { api } = loadMerge();
        const vals = [{ a: 1 }, { b: 2 }, { a: 1, b: 2 }, { a: 9 }, [1, 2], [3], 5, 'x', null, true, {}, 0, ''];
        const stamps = [0, 10, 20, 30];
        const bad = [];
        for (const x of vals) for (const y of vals) for (const tx of stamps) for (const ty of stamps) {
            if (tx === 0 && ty === 0) continue;   // documented migration window, local-priority by design
            const ab = api._wfMergeKeyed(JSON.parse(J(x)), JSON.parse(J(y)), tx, ty);
            const ba = api._wfMergeKeyed(JSON.parse(J(y)), JSON.parse(J(x)), ty, tx);
            if (S(ab) !== S(ba)) bad.push(`${J(x)}@${tx} vs ${J(y)}@${ty} → ${J(ab)} / ${J(ba)}`);
        }
        expect(bad, 'the two devices compute different answers for the same pair — they will never converge')
            .toEqual([]);
    });

    it('merging two maps never drops a key from either side', () => {
        const { api } = loadMerge();
        const maps = [{ a: 1 }, { b: 2 }, { a: 1, b: 2 }, { a: 9 }, {}, { c: 3, d: 4 }];
        const lost = [];
        for (const x of maps) for (const y of maps) for (const tx of [0, 10, 20]) for (const ty of [0, 10, 20]) {
            const m = api._wfMergeKeyed(JSON.parse(J(x)), JSON.parse(J(y)), tx, ty);
            for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
                if (!(k in m)) lost.push(`${k} lost merging ${J(x)}@${tx} with ${J(y)}@${ty}`);
            }
        }
        expect(lost, 'the merge dropped a map key — map REMOVAL is DB.delKey\'s job, never the merge\'s')
            .toEqual([]);
    });

    it('legacy documents keep local, so nobody\'s theme flips on upgrade day', () => {
        const A = loadMerge();
        A.appData.settings = { currency: 'LKR', theme: 'dark' };
        A.api._wfApplyCloudData({ settings: { currency: 'LKR', theme: 'light' } });
        expect(A.appData.settings.theme, 'an unstamped cloud copy changed a setting nobody touched')
            .toBe('dark');
    });

    it('settings that differ from the cloud now ask to be pushed', () => {
        const A = loadMerge();
        A.appData.settings = { currency: 'LKR', theme: 'dark' };
        const res = A.api._wfApplyCloudData({ settings: { currency: 'LKR', theme: 'light' } });
        expect(res.needPush, 'local settings win but never upload — the cloud keeps a stale copy '
            + 'forever and the next new device hydrates from it').toBe(true);
    });

    it('credentials stay out of the union', () => {
        const A = loadMerge();
        A.appData.auth = { pin: '1111' };
        A.api._wfStampKey('auth');
        expect(A.appData._kut && A.appData._kut.auth, 'auth was given a key-stamp — it is deliberately '
            + 'exempt, because merging two devices\' credentials into one object is not a safe default')
            .toBeUndefined();
    });

    it('record arrays and sync metadata never get a key-stamp', () => {
        const A = loadMerge();
        ['expenses', 'sessions', '_tomb', '_kut'].forEach(k => A.api._wfStampKey(k));
        expect(A.appData._kut, 'a record array or a metadata key was stamped as if it were plain data — '
            + 'the record clock (_ut) and the key clock (_kut) would then fight over the same field')
            .toBeUndefined();
    });

    it('the key-stamps themselves converge to the newer of the two', () => {
        const A = loadMerge();
        A.appData._kut = { incomeReceived: 100, balance: 400 };
        A.appData.incomeReceived = { a: 1 }; A.appData.balance = { total: 1 };
        A.api._wfApplyCloudData({ _kut: { incomeReceived: 200 }, incomeReceived: { b: 1 }, balance: { total: 1 } });
        expect(A.appData._kut.incomeReceived, 'the merged document kept the older clock, so the next '
            + 'snapshot would re-fight a decision that is already settled').toBe(200);
        expect(A.appData._kut.balance, 'a stamp only this device had was dropped').toBe(400);
    });
});

/* ── 3. a delete that cannot reach the disk ───────────────────────────────── */

describe('a deletion is never lost in silence', () => {
    it('tells the user when the tombstone cannot be saved', () => {
        const A = loadMerge();
        const seed = [{ id: 'e1', _ut: 1000 }, { id: 'e2', _ut: 1000 }];
        A.appData.expenses = JSON.parse(J(seed));
        A.store.set('wf2_expenses', J(seed));
        A.setFull(true);
        A.api._wfStampAndTomb('expenses', A.appData.expenses.filter(r => r.id !== 'e1'));
        A.setFull(false);
        expect(A.notes.length, 'the tombstone write failed and nothing was said — the app forgets the '
            + 'delete on the next reload and the row walks back in from the cloud').toBeGreaterThan(0);
        expect(A.notes[0][1]).toMatch(/storage/i);
    });

    it('the write path actually stamps the key it just wrote', () => {
        // The merge only has a clock because DB.set sets one. Extracting
        // _wfMergeKeyed and driving it directly proves the merge; it does not
        // prove anything is calling _wfStampKey in the real app.
        const set = blockAt('            set(k, v, silent = false) {');
        expect(set, 'DB.set no longer stamps the key — every non-record field silently '
            + 'loses its clock and the merge falls back to whatever the cloud says')
            .toMatch(/_wfStampKey\(k\)/);
        expect(set, 'the stamp is applied while a cloud snapshot is being written back, '
            + 'so a merge would mark the incoming data as a fresh local edit')
            .toMatch(/!isSyncingFromCloud\s*\)\s*\{\s*try\s*\{\s*_wfStampKey\(k\)/);
        const del = blockAt('            delKey(field, key, silent = false) {');
        expect(del, 'removing a map key is an update to that key, but DB.delKey does not '
            + 'stamp it — a stale cloud copy can then re-add what the user just removed')
            .toMatch(/_wfStampKey\(field\)/);
    });

    it('no write in the merge path is left on a bare catch', () => {
        // Everything from the merge constants down to DB, EXCEPT the guarded
        // writer itself — _persistLocal is where the one legitimate try/catch
        // around localStorage.setItem lives.
        let scope = HTML.slice(HTML.indexOf('const _WF_RECORD_KEYS = ['), HTML.indexOf('const DB = {'));
        const guarded = blockAt('function _persistLocal(key, value, raw)');
        expect(scope.indexOf(guarded), 'the guarded writer moved out of the merge scope — retarget this test')
            .toBeGreaterThan(-1);
        scope = scope.replace(guarded, '');
        const bare = scope.match(/try\s*\{\s*localStorage\.setItem\([^)]*\)[^}]*\}\s*catch/g) || [];
        expect(bare, 'a merge-path write is back on a bare try/catch: it can fail on a full device '
            + 'and take a deletion or a merged array with it, silently').toEqual([]);
    });
});
