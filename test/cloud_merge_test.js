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
function loadMerge({ decoy = false } = {}) {
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
    const appData = { _wipedAck: 0 };
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
        blockAt('function _wfStampAndTomb(key, newArr)'),
        blockAt('function _wfMergeRecordArray(localArr, cloudArr, tombMap)'),
        blockAt('function _wfMergeTombMaps(a, b)'),
        blockAt('function _persistLocal(key, value, raw)'),
        blockAt('function _persistRaw(key, str)'),
        blockAt('function _wfStampKey(k)'),
        blockAt('function _wfMergeKeyed(localVal, cloudVal, lts, cts)'),
        blockAt('function _wfApplyCloudData(cloudData)'),
    ].join('\n');
    const api = new Function('localStorage', 'appData', 'notify', 'console', 'window',
        src + '; let _wfLocalWriteBlocked = false;'
        + ' return { uid, _wfDedupRecordIds, _wfExpectBulkRemoval, _wfStampAndTomb,'
        + ' _wfMergeRecordArray, _wfMergeTombMaps, _wfStampKey, _wfMergeKeyed, _wfApplyCloudData };'
    )(localStorage, appData, (m, t) => notes.push([t, m]), { log() {}, warn() {}, error() {} }, { _isDecoyMode: decoy });
    return { api, appData, store, notes, setFull: (v) => { failWrites = v; } };
}

/**
 * The id generator's source, from `let _uidSeq` to the end of the `const uid`
 * statement. Anchored on both ends by text the generator must keep, so a change
 * that removes the tail FAILS THE EXTRACTION instead of silently slicing
 * garbage — the first version of this hunted for '.toString(36).slice(1)' and,
 * when a mutation removed it, indexOf returned -1 and the whole harness broke.
 * That looked like the mutation being caught. It was not.
 */
function uidSource() {
    const start = HTML.indexOf('let _uidSeq = 0;');
    expect(start, 'the id sequence is gone from index.html — retarget this test').toBeGreaterThan(-1);
    const declStart = HTML.indexOf('const uid = () =>', start);
    expect(declStart, 'the id generator is gone from index.html').toBeGreaterThan(-1);
    const end = HTML.indexOf(';', HTML.indexOf('_uidSeq', declStart));
    expect(end, 'could not find the end of the id generator').toBeGreaterThan(declStart);
    const src = HTML.slice(start, end + 1);
    expect(src, 'the generator no longer advances a per-page sequence — same-millisecond '
        + 'uniqueness is back to depending on luck').toMatch(/_uidSeq\s*=\s*\(?\s*_uidSeq\s*\+\s*1/);
    return src;
}

/**
 * The same generator, but the millisecond never moves and Math.random never
 * varies. Everything that could mask a collision is held still, so the only
 * thing left that can make two ids differ is the sequence itself.
 */
function frozenUid() {
    return new Function('Date', 'Math',
        uidSource() + '; return uid;'
    )({ now: () => 1750000000000 }, { random: () => 0.5 });
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

/* ── 4. two records that share an id ──────────────────────────────────────── */

describe('a record id is never minted twice', () => {
    it('a whole statement imported inside one millisecond has no duplicate id', () => {
        // The old generator was Date.now() plus five random base-36 characters. A
        // bulk import mints every row inside the same millisecond, so the id
        // reduced to those five characters — measured at 0.13% of 400-row imports
        // and 1.19% of 1600-row imports carrying a collision.
        //
        // Driving the real generator and counting collisions is NOT a test of
        // this: at 2000 ids the old one only collides ~3% of the time, so the
        // assertion passes by luck more often than not. A mutation that froze the
        // sequence survived exactly that way. So the clock is held still and the
        // randomness is held still, and what is left must still be unique.
        const uid = frozenUid();
        const seen = new Set();
        const dups = [];
        for (let i = 0; i < 20000; i++) {
            const id = uid();
            if (seen.has(id)) dups.push(`row ${i}: ${id}`);
            seen.add(id);
        }
        expect(dups.slice(0, 3), 'two rows of one import were given the same id with nothing but '
            + 'randomness between them — the merge keys by id, so one real transaction '
            + 'disappears at the next sync').toEqual([]);
        expect(seen.size).toBe(20000);
    });

    it('is still unique once the clock does move', () => {
        const { api } = loadMerge();
        const seen = new Set();
        for (let i = 0; i < 20000; i++) seen.add(api.uid());
        expect(seen.size, 'the real generator repeated an id').toBe(20000);
    });

    it('costs a whole transaction when it does happen', () => {
        const { api } = loadMerge();
        const rows = [
            { id: '_dup', desc: 'KEELLS', amount: 4500, _ut: 1000 },
            { id: '_dup', desc: 'FUEL', amount: 9000, _ut: 1000 },
            { id: '_ok', desc: 'RENT', amount: 50000, _ut: 1000 },
        ];
        // Unrepaired, this is what the merge does with them — the reason the
        // generator had to change rather than merely being made rarer.
        const collapsed = api._wfMergeRecordArray(JSON.parse(J(rows)), [], undefined);
        expect(collapsed).toHaveLength(2);
        const lost = rows.reduce((s, r) => s + r.amount, 0) - collapsed.reduce((s, r) => s + r.amount, 0);
        expect(lost, 'this test no longer demonstrates the cost — retarget it').toBe(9000);
    });

    it('repairs a collision already sitting in the data, on write', () => {
        const A = loadMerge();
        const rows = [
            { id: '_dup', desc: 'KEELLS', amount: 4500 },
            { id: '_dup', desc: 'FUEL', amount: 9000 },
            { id: '_ok', desc: 'RENT', amount: 50000 },
        ];
        const out = A.api._wfStampAndTomb('expenses', JSON.parse(J(rows)));
        expect(new Set(out.map(r => r.id)).size, 'a pre-existing duplicate id was persisted as-is, '
            + 'so the next sync still drops the row').toBe(3);
        const merged = A.api._wfMergeRecordArray(out, [], undefined);
        expect(merged.reduce((s, r) => s + r.amount, 0), 'money still goes missing through the merge')
            .toBe(63500);
    });

    it('repairs on the write path only, so two devices cannot double a row', () => {
        // Re-iding on READ would have each device mint a different replacement for
        // the same row, and the record would come back twice after a merge.
        const merge = blockAt('function _wfMergeRecordArray(localArr, cloudArr, tombMap)');
        expect(merge, 'the id repair moved onto the read path — every device would mint a '
            + 'different id for the same row and the merge would double it')
            .not.toMatch(/_wfDedupRecordIds/);
        const applier = blockAt('function _wfApplyCloudData(cloudData)');
        expect(applier).not.toMatch(/_wfDedupRecordIds/);
    });

    it('does not disturb records that have no id at all', () => {
        const A = loadMerge();
        const rows = [{ desc: 'a' }, { desc: 'b' }, { id: '_x', desc: 'c' }];
        const fixed = A.api._wfDedupRecordIds(rows);
        expect(fixed, 'id-less records were treated as collisions').toBe(0);
        expect(rows.filter(r => r.id != null)).toHaveLength(1);
    });
});

/* ── 5. a wipe that nobody asked for ──────────────────────────────────────── */

describe('a mass deletion nobody announced is refused', () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: 'e' + i, amount: 100 + i, _ut: 1000 }));

    it('one ordinary "add an expense" cannot tombstone 500 records', () => {
        // The shape of the accident: appData holding an empty array while disk
        // still holds the real list. _wfStampAndTomb compares the two, calls the
        // difference a deletion, and pushes 500 tombstones — which remove those
        // rows on EVERY device for a hundred days.
        const A = loadMerge();
        A.store.set('wf2_expenses', J(rows(500)));
        A.appData.expenses = [];
        const out = A.api._wfStampAndTomb('expenses', [{ id: 'new1', amount: 9 }]);
        expect(Object.keys((A.appData._tomb || {}).expenses || {}), 'a mass deletion was tombstoned '
            + 'and is now on its way to every other device').toEqual([]);
        expect(out, 'the rows were dropped locally instead of being kept').toHaveLength(501);
        expect(A.notes.length, 'nothing was said to the user').toBeGreaterThan(0);
        expect(A.notes[0][1]).toMatch(/blocked|nothing was deleted/i);
    });

    it('an announced bulk removal — undoing an import — still goes through', () => {
        const A = loadMerge();
        const seed = rows(500);
        A.appData.expenses = JSON.parse(J(seed));
        A.store.set('wf2_expenses', J(seed));
        A.api._wfExpectBulkRemoval(['expenses'], 15000);
        const out = A.api._wfStampAndTomb('expenses', []);
        expect(out, 'the guard blocked a removal the user explicitly asked for').toHaveLength(0);
        expect(Object.keys(A.appData._tomb.expenses), 'the deletion will not reach the other device')
            .toHaveLength(500);
    });

    it('deleting one row is untouched by the guard', () => {
        const A = loadMerge();
        const seed = rows(500);
        A.appData.expenses = JSON.parse(J(seed));
        A.store.set('wf2_expenses', J(seed));
        A.api._wfStampAndTomb('expenses', seed.filter((r) => r.id !== 'e7'));
        expect(Object.keys(A.appData._tomb.expenses), 'an ordinary delete stopped propagating')
            .toEqual(['e7']);
    });

    it('clearing most of a SMALL list is still a real deletion', () => {
        // 22 of 30 is 73% — well short of near-total, and exactly the kind of
        // tidy-up a person does by hand. It must not be mistaken for the accident.
        const A = loadMerge();
        const seed = rows(30);
        A.appData.expenses = JSON.parse(J(seed));
        A.store.set('wf2_expenses', J(seed));
        A.api._wfStampAndTomb('expenses', seed.slice(0, 8));
        expect(Object.keys(A.appData._tomb.expenses)).toHaveLength(22);
    });

    it('the announcement expires, and does not cover other collections', () => {
        const stale = loadMerge();
        stale.appData.expenses = JSON.parse(J(rows(500)));
        stale.store.set('wf2_expenses', J(rows(500)));
        stale.api._wfExpectBulkRemoval(['expenses'], -1);
        stale.api._wfStampAndTomb('expenses', []);
        expect(Object.keys((stale.appData._tomb || {}).expenses || {}),
            'an expired announcement still authorised a mass deletion').toEqual([]);

        const wrong = loadMerge();
        wrong.appData.expenses = JSON.parse(J(rows(500)));
        wrong.store.set('wf2_expenses', J(rows(500)));
        wrong.api._wfExpectBulkRemoval(['loans'], 15000);
        wrong.api._wfStampAndTomb('expenses', []);
        expect(Object.keys((wrong.appData._tomb || {}).expenses || {}),
            'announcing one collection authorised a mass deletion in another').toEqual([]);
    });

    it('undoing an import announces itself before it removes anything', () => {
        const at = HTML.indexOf('function undoBatch(batchId)');
        expect(at, 'undoBatch is gone — retarget this test').toBeGreaterThan(-1);
        const body = HTML.slice(at, at + 2500);
        const announce = body.indexOf('_wfExpectBulkRemoval');
        const undo = body.indexOf('WFBatch.undo(batchId)');
        expect(announce, 'the one legitimate bulk removal no longer announces itself, so the '
            + 'guard will refuse it').toBeGreaterThan(-1);
        expect(announce, 'the announcement comes AFTER the removal, which is too late')
            .toBeLessThan(undo);
        expect(body).toMatch(/'expenses'[\s\S]{0,120}'cheques'/);
    });
});

/* ── 6. a factory reset that the other phone honours ──────────────────────── */

describe('a factory reset reaches every device', () => {
    const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: 'e' + i, amount: 100 + i, _ut: 1000 }));

    it('wipes a second device that is holding the old data', () => {
        // A second device does not READ the cloud document, it MERGES it. Against
        // the shipped merge code, a device holding 500 expenses kept all 500 when
        // the wiped document arrived and came back with needPush = true — so it
        // then uploaded them again, seconds after a PIN-gated secure wipe.
        const B = loadMerge();
        const seed = rows(500);
        B.appData.expenses = JSON.parse(J(seed));
        B.store.set('wf2_expenses', J(seed));
        B.appData.incomeReceived = { '2026-01': true };
        B.appData.balance = { total: 250000, flows: [{ id: 'f1' }] };

        const t = Date.now();
        const res = B.api._wfApplyCloudData({ expenses: [], balance: { total: 0, flows: [] }, incomeReceived: {}, _wipedAt: t });

        expect(B.appData.expenses, 'the wipe did not reach the second device').toHaveLength(0);
        expect(B.appData.incomeReceived, 'a map survived the wipe — a merge cannot express the '
            + 'removal of a map key, which is why the reset is announced rather than merged')
            .toEqual({});
        expect(B.appData.balance.total).toBe(0);
        expect(B.store.get('wf2_expenses'), 'memory was cleared but disk was not, so it all '
            + 'comes back on the next reload').toBe('[]');
        expect(res.needPush, 'the wiped device asks to push, which re-uploads what was just '
            + 'destroyed').toBe(false);
    });

    it('honours the same marker once, not every time it arrives', () => {
        const B = loadMerge();
        B.appData.expenses = JSON.parse(J(rows(500)));
        B.store.set('wf2_expenses', J(rows(500)));
        const t = Date.now();
        B.api._wfApplyCloudData({ expenses: [], _wipedAt: t });
        B.appData.expenses = [{ id: 'after-the-reset', amount: 1, _ut: Date.now() }];
        B.api._wfApplyCloudData({ expenses: [], _wipedAt: t });
        expect(B.appData.expenses, 'a re-delivered snapshot wiped work done after the reset')
            .toHaveLength(1);
    });

    it('the reset itself names every key and stamps the marker', () => {
        const at = HTML.indexOf('async function executeFactoryReset()');
        expect(at).toBeGreaterThan(-1);
        const body = HTML.slice(at, at + 6000);
        expect(body, 'the reset no longer announces itself, so a second device merges its own '
            + 'copy straight back').toMatch(/_wipedAt: _wipeStamp/);
        // The old list was missing eight keys, and appData's own keys are what the
        // hydration loops iterate — so dropping them also stopped them being re-read.
        ['incomeRecv', 'subscriptions', 'importBatches', 'cribReports', 'sessions',
            'incomeReceived', 'cribAnalyses', 'subMerchantMap'].forEach((k) => {
                expect(body, `the factory reset does not clear ${k}`).toMatch(new RegExp(k + ':'));
            });
    });
});

/* ── 7. the duress PIN ────────────────────────────────────────────────────── */

describe('panic mode is read-only in both directions', () => {
    it('an incoming snapshot cannot merge the real ledger into the decoy view', () => {
        const A = loadMerge({ decoy: true });
        A.appData.expenses = [{ id: 'decoy-row', amount: 15000 }];
        const res = A.api._wfApplyCloudData({
            expenses: Array.from({ length: 500 }, (_, i) => ({ id: 'real' + i, amount: 900 + i })),
            incomeReceived: { '2026-01': true },
        });
        expect(A.appData.expenses, 'the real ledger was merged into the decoy view — under a PIN '
            + 'whose entire purpose is that it should not be').toHaveLength(1);
        expect(A.appData.incomeReceived, 'a real map arrived through the merge').toBeUndefined();
        expect([...A.store.keys()], 'the decoy wrote to disk').toEqual([]);
        expect(res.needPush).toBe(false);
    });

    it('nothing is pushed to the cloud under the duress PIN', () => {
        const at = HTML.indexOf('function syncToCloud()');
        expect(at).toBeGreaterThan(-1);
        const head = HTML.slice(at, at + 900);
        expect(head, 'syncToCloud builds its payload from appData — under the duress PIN that '
            + 'is the decoy data, and it would overwrite the real cloud document')
            .toMatch(/_isDecoyMode === true/);
        expect(head.indexOf('_isDecoyMode'), 'the guard sits after the payload is built')
            .toBeLessThan(head.indexOf('syncPayload') === -1 ? head.length : head.indexOf('syncPayload'));
    });

    it('the decoy blanks every record collection, not five of them', () => {
        const at = HTML.indexOf("if (authData.decoyPin && hash === authData.decoyPin)");
        expect(at, 'the decoy branch is gone — retarget this test').toBeGreaterThan(-1);
        const body = HTML.slice(at, at + 3000);
        expect(body, 'the decoy no longer clears every record collection — credit-card '
            + 'instalments, cheques, subscriptions and imported statements stay on screen, '
            + 'real, under a PIN whose whole purpose is that they should not be')
            .toMatch(/_WF_RECORD_KEYS\.forEach\(k => \{ appData\[k\] = \[\]; \}\)/);
        expect(body, 'the maps are left real').toMatch(/incomeReceived[\s\S]{0,80}\{\}/);
        expect(body, 'a full copy of the real data is stashed on appData again — nothing reads '
            + 'it back, and syncToCloud would have uploaded it')
            .not.toMatch(/appData\._realData\s*=/);
    });

    it('leaving the decoy re-reads the real data from disk', () => {
        // The first version of this asserted that the two lines were PRESENT. A
        // mutation changing `if (_leavingDecoy)` to `if (false)` left both lines
        // exactly where they were and survived. What has to be pinned is the
        // CONDITION, not the text near it.
        const at = HTML.indexOf('const _leavingDecoy = window._isDecoyMode === true;');
        expect(at, 'returning to the real PIN no longer discards the decoy — launchApp() never '
            + 're-reads localStorage, so the decoy rows stay in memory and the first ordinary '
            + 'save writes them into the real data').toBeGreaterThan(-1);
        expect(HTML.slice(at, at + 600), 'the re-hydration is no longer gated on actually having '
            + 'been in the decoy — it either never runs, or runs on every single unlock')
            .toMatch(/if \(_leavingDecoy\)\s*\{\s*try\s*\{\s*_wfRehydrateFromDisk\(\)/);
    });

    it('the re-hydrator restores an empty key to the right SHAPE', () => {
        // Reachable: a record array with nothing on disk yet. Handing back the
        // decoy's value, or a bare {} where an array belongs, moves the crash one
        // caller downstream instead of fixing it.
        const src = blockAt('function _wfRehydrateFromDisk()');
        expect(src, 'a key with no stored value keeps whatever the decoy left in it')
            .toMatch(/_WF_RECORD_KEYS\.indexOf\(k\) !== -1\) appData\[k\] = \[\]/);
        expect(src, 'a map with no stored value is not restored as a map').toMatch(/appData\[k\] = \{\}/);
        expect(src, 'a corrupt stored value throws out of the unlock path instead of being logged')
            .toMatch(/catch \(e\)/);
    });

    it('the v5 restore loop stops rebuilding the real list under duress', () => {
        const V5 = fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v4.js'), 'utf8');
        const at = V5.indexOf('window._wfV5GuardLoop = setInterval');
        expect(at, 'the guard loop is gone — retarget this test').toBeGreaterThan(-1);
        const body = V5.slice(at, at + 1800);
        expect(body, 'the loop compares appData against the last real array it saw and restores '
            + 'the difference — under the duress PIN that is the entire real ledger, put back '
            + 'into memory, onto the screen and onto disk')
            .toMatch(/_isDecoyMode === true.*return/);
        expect(body, 'coming back out of the decoy, the cached arrays still describe it — '
            + 'restoring from them stitches decoy rows into the real data')
            .toMatch(/recentArrayHashes\.clear\(\)/);
    });
});

/* ── 8. a restore is a reset with content in it ───────────────────────────── */

describe('an announced document is adopted whole, content and all', () => {
    const rows = (n, p = 'e') => Array.from({ length: n }, (_, i) => ({ id: p + i, amount: 100 + i, _ut: 1000 }));

    it('a Drive restore reaches a second device in ONE snapshot', () => {
        // The wipe tests above only ever sent an EMPTY announced document, so
        // they could not tell "adopt what was announced" from "clear and stop".
        // The first version cleared and returned, and a restore's content — in
        // the same document as the marker — was thrown away: the device went to
        // zero and only picked the restore up if a second snapshot arrived.
        const B = loadMerge();
        const old = rows(500);
        B.appData.expenses = JSON.parse(J(old));
        B.store.set('wf2_expenses', J(old));
        B.appData.balance = { total: 250000, flows: [] };
        B.appData.incomeReceived = { '2026-07': true };   // the stale copy, must not survive

        const res = B.api._wfApplyCloudData({
            expenses: rows(3, 'r'),
            balance: { total: 4200, flows: [] },
            incomeReceived: { '2025-11': true, '2025-12': true },
            _wipedAt: Date.now(),
        });

        expect(B.appData.expenses.map((r) => r.id), 'the restored rows were discarded, or the '
            + 'old ones survived alongside them').toEqual(['r0', 'r1', 'r2']);
        expect(B.appData.balance.total, 'the announced balance was dropped — with no _kut on '
            + 'either side the legacy branch keeps local, which after a clear is the empty value')
            .toBe(4200);
        expect(Object.keys(B.appData.incomeReceived).sort(), 'the announced MAPS were emptied '
            + 'rather than adopted, so a restore silently loses every month the backup had '
            + 'marked received').toEqual(['2025-11', '2025-12']);
        expect(B.store.get('wf2_expenses'), 'memory took the restore but disk did not')
            .toContain('r0');
        expect(res.needPush, 'the device asks to push after adopting, which re-uploads what it '
            + 'was just told to replace').toBe(false);
    });

    it('and stays there when the same document is redelivered', () => {
        const B = loadMerge();
        B.appData.expenses = JSON.parse(J(rows(500)));
        B.store.set('wf2_expenses', J(rows(500)));
        const t = Date.now();
        B.api._wfApplyCloudData({ expenses: rows(3, 'r'), _wipedAt: t });
        B.api._wfApplyCloudData({ expenses: rows(3, 'r'), _wipedAt: t });
        expect(B.appData.expenses).toHaveLength(3);
    });

    it('an empty announced document still empties the device', () => {
        // The factory-reset case, re-proved against the new adopt-in-full shape.
        const B = loadMerge();
        B.appData.expenses = JSON.parse(J(rows(500)));
        B.store.set('wf2_expenses', J(rows(500)));
        B.appData.incomeReceived = { '2026-01': true };
        B.api._wfApplyCloudData({ _wipedAt: Date.now() });
        expect(B.appData.expenses, 'a reset with nothing in it stopped emptying the device')
            .toHaveLength(0);
        expect(B.appData.incomeReceived).toEqual({});
        expect(B.appData.balance).toEqual({ total: 0, flows: [] });
    });

    it('a restore that does NOT announce itself is the bug this replaces', () => {
        // Kept as the counter-example: without the marker the merge unions, the
        // old rows survive, and the device re-uploads them.
        const B = loadMerge();
        B.appData.expenses = JSON.parse(J(rows(500)));
        B.store.set('wf2_expenses', J(rows(500)));
        const res = B.api._wfApplyCloudData({ expenses: rows(3, 'r') });
        expect(B.appData.expenses.length, 'this test no longer demonstrates why the marker is '
            + 'needed — retarget it').toBe(503);
        expect(res.needPush).toBe(true);
    });

    it('the Drive restore stamps the marker before it pushes', () => {
        const at = HTML.indexOf('const restoredData = await res.json();');
        expect(at, 'the Drive restore is gone — retarget this test').toBeGreaterThan(-1);
        const body = HTML.slice(at, at + 2600);
        const stamp = body.indexOf('appData._wipedAt = _restoreStamp');
        const push = body.indexOf('userDocRef.set(');
        expect(stamp, 'the restore no longer announces itself, so a second device merges its own '
            + 'copy straight back and re-uploads it').toBeGreaterThan(-1);
        expect(stamp, 'the marker is stamped after the push, which is too late')
            .toBeLessThan(push);
        expect(body, 'the restoring device does not ack its own marker, so it would adopt its '
            + 'own announcement on the next snapshot').toMatch(/_wipedAck = _restoreStamp/);
    });
});

