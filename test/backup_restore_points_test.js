/* =============================================================================
 * test/backup_restore_points_test.js — the Auto-Backup Schedule, run for real
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-19: "check that the Auto-Backup Schedule works properly; fix it if anything is wrong."
 *
 * It did not. The schedule fired every night and reported "Auto-Backup Complete", but the "cloud backup" was the live
 * document written onto itself, Drive uploads used an hour-old token and were swallowed, the files went to a folder
 * anyone could edit, a failed run retried every 30 seconds, and a restore threw the current data away without keeping it.
 * Details are in the header of wealthflow-backup.js.
 *
 * This file runs the REAL wealthflow-backup.js against an in-memory Firestore and an in-memory Drive. Neither fake is
 * lenient: a Drive request with a stale token gets a 401, a Firestore batch that fails writes nothing, and a Drive that
 * stores a truncated file reports the truncated size. Whatever the module says afterwards is what is asserted.
 * ===========================================================================*/
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Backup, {
    nextTrigger, lastTrigger, retryDelayMs, backupDue, staleAfterMs,
    buildPayload, validateRestore, emptyCollections, selectToKeep, saveSnapshot, loadSnapshot, listSnapshots, annotateSnapshot, writeStatus, readStatus, sha256Hex,
    driveBackup, ensureDriveFolder, listDriveBackups, pruneDriveBackups, driveReasonText, restorePointReasonText, driveNameParts, downloadDriveBackup, describeBackup, deleteAllSnapshots, BACKUP_STAMP_KEYS, EXCLUDE_KEYS,
    KEEP_NEWEST, KEEP_DAYS, MAX_SNAPSHOT_BYTES, FOLDER_MIME, DRIVE_FOLDER_NAME, RECORD_KEYS, SNAP_COL, DATA_COL, STATUS_COL,
} from '../wealthflow-backup.js';
import { makeDb, makeDrive } from './helpers/backup-fakes.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const DAY = 86400000;
const COLOMBO = 330;

afterEach(() => { vi.useRealTimers(); });

/* ------------------------------------------------------------------ fakes (test/helpers/backup-fakes.js) */

const data = (n = 3, extra = {}) => ({ expenses: Array.from({ length: n }, (_, i) => ({ id: 'e' + i, amount: 100 + i })), income: [{ id: 'i0', amount: 5000 }], settings: { currency: 'LKR' }, ...extra });
const payloadOf = (d) => buildPayload(d);
const tokens = (...list) => { let i = 0; const calls = []; const fn = async (force) => { calls.push(force); return list[Math.min(i++, list.length - 1)]; }; fn.calls = calls; return fn; };

/* ------------------------------------------------------------------ the schedule */

describe('the schedule: when it fires', () => {
    const at = (iso) => Date.parse(iso);
    it('daily fires at 23:55 Colombo time (18:25 UTC)', () => {
        const now = at('2026-10-19T12:00:00Z');
        expect(new Date(nextTrigger('daily', now, { tzOffsetMin: COLOMBO })).toISOString()).toBe('2026-10-19T18:25:00.000Z');
        expect(new Date(lastTrigger('daily', now, { tzOffsetMin: COLOMBO })).toISOString()).toBe('2026-10-18T18:25:00.000Z');
        const after = at('2026-10-19T18:30:00Z');
        expect(new Date(nextTrigger('daily', after, { tzOffsetMin: COLOMBO })).toISOString()).toBe('2026-10-20T18:25:00.000Z');
    });
    it('weekly fires on the last day of the week, for either week start', () => {
        const now = at('2026-10-19T12:00:00Z'); // Monday
        const sundayEnd = '2026-10-25T18:25:00.000Z';
        expect(new Date(nextTrigger('weekly', now, { weekStart: 1, tzOffsetMin: COLOMBO })).toISOString()).toBe(sundayEnd);
        const saturdayEnd = '2026-10-24T18:25:00.000Z';
        expect(new Date(nextTrigger('weekly', now, { weekStart: 0, tzOffsetMin: COLOMBO })).toISOString()).toBe(saturdayEnd);
    });
    it('monthly fires on the LAST day of the month, including 28/29/30/31-day months', () => {
        const next = (iso) => new Date(nextTrigger('monthly', at(iso), { tzOffsetMin: COLOMBO })).toISOString();
        expect(next('2026-03-15T00:00:00Z')).toBe('2026-03-31T18:25:00.000Z');
        expect(next('2026-04-01T00:00:00Z')).toBe('2026-04-30T18:25:00.000Z');
        expect(next('2026-02-10T00:00:00Z')).toBe('2026-02-28T18:25:00.000Z');
        expect(next('2028-02-10T00:00:00Z')).toBe('2028-02-29T18:25:00.000Z');
        expect(next('2026-12-31T19:00:00Z')).toBe('2027-01-31T18:25:00.000Z');
    });
    it('the month AFTER a 31-day month does not get an extra run (the setMonth(-1) overflow the old code had)', () => {
        // The old _lastScheduledBackupTime did new Date(y, m-1, 31): on May 10 that is "Apr 31" = May 1, so May looked "overdue" at once.
        const last = (iso) => new Date(lastTrigger('monthly', at(iso), { tzOffsetMin: COLOMBO })).toISOString();
        expect(last('2026-05-10T00:00:00Z')).toBe('2026-04-30T18:25:00.000Z');
        expect(last('2026-04-10T00:00:00Z')).toBe('2026-03-31T18:25:00.000Z');
        expect(last('2026-03-10T00:00:00Z')).toBe('2026-02-28T18:25:00.000Z');
    });
    it('off and unknown values never fire', () => {
        expect(nextTrigger('off', Date.now())).toBeNull();
        expect(lastTrigger('hourly', Date.now())).toBeNull();
        expect(backupDue({ freq: 'off', lastGoodMs: 0, now: Date.now() })).toEqual({ due: false, why: 'off' });
    });
    it.each([['daily', 1], ['weekly', 1], ['weekly', 0], ['weekly', 6], ['monthly', 1]])('%s (week starts %i): last <= now < next, and no trigger falls between them, on every day of three years', (freq, weekStart) => {
        for (let t = at('2026-01-01T00:00:00Z'); t < at('2029-01-01T00:00:00Z'); t += 7 * 3600 * 1000 + 1234567) {
            for (const tz of [COLOMBO, undefined]) {
                const o = { weekStart, tzOffsetMin: tz };
                const l = lastTrigger(freq, t, o), n = nextTrigger(freq, t, o);
                expect(l <= t && t < n, `${freq} @ ${new Date(t).toISOString()}`).toBe(true);
                expect(nextTrigger(freq, l, o)).toBe(n);
            }
        }
    });
    it('every monthly trigger is the last day of a month and every weekly one is on the right weekday', () => {
        let t = at('2026-01-01T00:00:00Z');
        for (let i = 0; i < 40; i++) {
            t = nextTrigger('monthly', t, { tzOffsetMin: COLOMBO });
            const local = new Date(t + COLOMBO * 60000);
            const tomorrow = new Date(local.getTime() + DAY);
            expect(tomorrow.getUTCDate()).toBe(1);
            expect([local.getUTCHours(), local.getUTCMinutes()]).toEqual([23, 55]);
        }
        t = at('2026-01-01T00:00:00Z');
        for (let i = 0; i < 60; i++) {
            t = nextTrigger('weekly', t, { weekStart: 1, tzOffsetMin: COLOMBO });
            expect(new Date(t + COLOMBO * 60000).getUTCDay()).toBe(0); // Sunday
        }
    });
});

describe('the schedule: when a run is due, and how failures back off', () => {
    const base = Date.parse('2026-10-19T19:00:00Z'); // 00:30 Colombo on the 20th, just after the daily trigger
    const o = { freq: 'daily', tzOffsetMin: COLOMBO };
    it('is not due when a real copy is newer than the last trigger', () => {
        expect(backupDue({ ...o, lastGoodMs: base - 60000, now: base })).toEqual({ due: false, why: 'fresh' });
    });
    it('is due when the newest real copy predates the last trigger, and on the very first run', () => {
        expect(backupDue({ ...o, lastGoodMs: base - 2 * DAY, now: base })).toEqual({ due: true, why: 'schedule' });
        expect(backupDue({ ...o, lastGoodMs: 0, now: base })).toEqual({ due: true, why: 'first' });
    });
    it('a FAILED run backs off (5 min, 15 min, 1 h, 3 h, then 6 h) instead of retrying every 30 seconds', () => {
        expect([1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(n) / 60000)).toEqual([5, 15, 60, 180, 360, 360]);
        const failedAtMs = base - 60000;
        expect(backupDue({ ...o, lastGoodMs: base - 2 * DAY, failedAtMs, failCount: 1, now: base }).why).toBe('backoff');
        expect(backupDue({ ...o, lastGoodMs: base - 2 * DAY, failedAtMs, failCount: 1, now: failedAtMs + 5 * 60000 + 1 })).toEqual({ due: true, why: 'schedule' });
        expect(backupDue({ ...o, lastGoodMs: base - 2 * DAY, failedAtMs, failCount: 3, now: failedAtMs + 59 * 60000 }).due).toBe(false);
        // simulate the old 30-second timer for six hours: it may run at most a handful of times, not 720
        let runs = 0, fails = 0, lastFail = 0;
        for (let t = base; t < base + 6 * 3600000; t += 30000) {
            if (backupDue({ ...o, lastGoodMs: base - 2 * DAY, failedAtMs: lastFail, failCount: fails, now: t }).due) { runs++; fails++; lastFail = t; }
        }
        expect(runs).toBeLessThanOrEqual(5);
        expect(runs).toBeGreaterThanOrEqual(3);
    });
    it('staleness is two intervals', () => {
        expect(staleAfterMs('daily')).toBe(2 * DAY);
        expect(staleAfterMs('weekly')).toBe(14 * DAY);
        expect(staleAfterMs('monthly')).toBe(62 * DAY);
    });
});

/* ------------------------------------------------------------------ what is written, what may be restored */

describe('the payload', () => {
    it('never carries a Drive credential or sync bookkeeping', () => {
        const p = buildPayload(data(2, { driveRefresh: 'SECRET-REFRESH', driveBridge: { access: 'SECRET' }, _lastModified: 1, _writeTs: 2, _writeDeviceId: 'd', _lastModifiedBy: 'x' }));
        expect(p.ok).toBe(true);
        expect(p.text).not.toMatch(/SECRET|driveRefresh|driveBridge|_lastModified|_writeTs|_writeDeviceId/);
        expect(JSON.parse(p.text).expenses).toHaveLength(2);
    });
    it('leaves the signed-out-devices list out: it is a security decision, and restoring an old copy must not take it back', () => {
        const p = buildPayload(data(2, { revokedSessions: ['lost-phone'], lastRevokeAt: 99 }));
        expect(p.text).not.toMatch(/revokedSessions|lost-phone|lastRevokeAt/);
        expect(EXCLUDE_KEYS).toEqual(expect.arrayContaining(['revokedSessions', 'lastRevokeAt']));
        expect(validateRestore({ expenses: [], revokedSessions: ['x'] }).ok).toBe(true);
    });
    it('leaves the factory-reset marker out: a restore stamps its own, an old one would wipe devices again', () => {
        const p = buildPayload(data(2, { _wipedAt: 123, _wipedAck: 123 }));
        expect(p.text).not.toMatch(/_wipedAt|_wipedAck/);
    });
    it('counts real records, not settings or transient lists', () => {
        const p = buildPayload({ expenses: [{}, {}], income: [{}], settings: { a: 1 }, sessions: [{}, {}, {}], aiHistory: [{}] });
        expect(p.records).toBe(3);
        expect(p.bytes).toBe(new TextEncoder().encode(p.text).length);
    });
    it('counts the Balance page\'s own data (its flows, or a typed-in total): a person who only uses that page still has something to protect', async () => {
        expect(buildPayload({ balance: { total: 0, flows: [{ id: 'f1' }, { id: 'f2' }] }, settings: { a: 1 } }).records).toBe(2);
        expect(buildPayload({ balance: { total: 1500, flows: [] }, settings: { a: 1 } }).records, 'a typed-in balance is data').toBe(1);
        expect(buildPayload({ balance: { total: 0, flows: [] }, settings: { a: 1 } }).records, 'the blank a reset leaves is not').toBe(0);
        expect(buildPayload({ balance: { total: 'oops', flows: 'no' }, expenses: [{}] }).records, 'a damaged balance is not counted, and does not break the count').toBe(1);
        // end to end: it is saved, not skipped as "nothing to back up"
        const db = makeDb();
        const r = await saveSnapshot({ db, uid: 'u1', payload: buildPayload({ balance: { total: 0, flows: [{ id: 'f1' }] }, settings: {} }), trigger: 'auto', now: 1760000000000 });
        expect(r.ok).toBe(true);
        expect(r.skipped, 'a balance-only account got no copy').toBeUndefined();
        expect(r.records).toBe(1);
    });
    it('is canonical: the same data gives the same bytes whatever order it was built in (page vs. Firestore)', () => {
        const a = { expenses: [{ id: 'e1', amount: 1, note: 'x' }], income: [], settings: { b: 1, a: { z: 1, y: 2 } } };
        const b = { settings: { a: { y: 2, z: 1 }, b: 1 }, income: [], expenses: [{ note: 'x', amount: 1, id: 'e1' }] };
        expect(buildPayload(a).text).toBe(buildPayload(b).text);
        // arrays keep their order — that is data
        expect(buildPayload({ expenses: [{ id: 1 }, { id: 2 }] }).text).not.toBe(buildPayload({ expenses: [{ id: 2 }, { id: 1 }] }).text);
        expect(JSON.parse(buildPayload(a).text)).toEqual(a);
    });
    it('leaves the backups\' own stamps out, so a backup does not make every later copy look different', async () => {
        const d = data(3);
        const first = buildPayload({ ...d, settings: { currency: 'LKR' } });
        const stamped = buildPayload({ ...d, settings: { currency: 'LKR', lastBackup: 'x', lastAutoBackupAt: 'y', lastBackupMeta: { v: 2 }, lastBackupAttempt: { success: true }, lastDriveBackup: { v: 2, fileId: 'f' } } });
        expect(stamped.text).toBe(first.text);
        expect(stamped.text).not.toMatch(/lastBackup|lastAutoBackupAt|lastDriveBackup/);
        // and a real setting is still carried
        expect(JSON.parse(buildPayload({ ...d, settings: { currency: 'USD', autoBackupFreq: 'weekly' } }).text).settings).toEqual({ currency: 'USD', autoBackupFreq: 'weekly' });
        // end to end: the second run is confirmed, not duplicated
        const db = makeDb();
        const r1 = await saveSnapshot({ db, uid: 'u', payload: first, trigger: 'manual', now: 1760000000000 });
        const r2 = await saveSnapshot({ db, uid: 'u', payload: stamped, trigger: 'manual', now: 1760000060000 });
        expect(r2).toMatchObject({ ok: true, reused: true, id: r1.id });
    });
    it('refuses nothing, arrays and unserialisable data', () => {
        expect(buildPayload(null).ok).toBe(false);
        expect(buildPayload([]).ok).toBe(false);
        const c = {}; c.self = c;
        expect(buildPayload(c).ok).toBe(false);
    });
});

describe('what may be restored', () => {
    it('accepts a real backup', () => {
        const v = validateRestore(JSON.parse(buildPayload(data(4)).text));
        expect(v.ok).toBe(true);
        expect(v.records).toBe(5);
    });
    it('accepts a copy that holds only the Balance page\'s data, and counts it', () => {
        const v = validateRestore({ balance: { total: 0, flows: [{ id: 'f1' }, { id: 'f2' }] } });
        expect(v.ok).toBe(true);
        expect(v.records).toBe(2);
    });
    it.each([
        ['an empty object', {}],
        ['an array', [1, 2]],
        ['null', null],
        ['a string', 'x'],
        ['a bank statement export', { rows: [{ date: '2026-01-01', amount: 5 }], bank: 'HNB' }],
        ['an error page that parsed', { error: 'not found', status: 404 }],
        ['a backup with a damaged collection', { expenses: 'oops', income: [] }],
        ['only credentials', { driveRefresh: 'x' }],
    ])('refuses %s', (_n, obj) => { expect(validateRestore(obj).ok).toBe(false); });
});

/* ------------------------------------------------------------------ retention */

describe('retention: rotation never throws away the only good copy', () => {
    const NOW = Date.parse('2026-10-19T12:00:00Z');
    const mk = (id, daysAgo, records = 100, trigger = 'auto') => ({ id, atMs: NOW - daysAgo * DAY, records, trigger });
    it('keeps the newest few, one per recent day, and drops the rest', () => {
        const metas = [];
        for (let d = 0; d < 40; d++) { metas.push(mk('a' + d, d + 0.1)); metas.push(mk('b' + d, d + 0.2)); }
        const { keep, drop } = selectToKeep(metas, NOW, COLOMBO);
        expect(keep.size + drop.length).toBe(metas.length);
        for (let i = 0; i < KEEP_NEWEST; i++) expect(keep.has(metas.sort((x, y) => y.atMs - x.atMs)[i].id)).toBe(true);
        expect(keep.size).toBeLessThanOrEqual(KEEP_NEWEST + KEEP_DAYS + 2);
        expect(drop.length).toBeGreaterThan(40);
    });
    it('a wipe that is backed up every night cannot rotate the good copies out', () => {
        const metas = [mk('good', 20, 900)];
        for (let d = 0; d < 19; d++) metas.push(mk('wiped' + d, d + 0.1, 3));
        const { keep } = selectToKeep(metas, NOW, COLOMBO);
        expect(keep.has('good')).toBe(true);
    });
    it('a copy taken just before a restore is kept 30 days, then rotates like any other', () => {
        const metas = [mk('pre', 25, 10, 'pre-restore'), mk('preOld', 40, 10, 'pre-restore')];
        for (let d = 0; d < 30; d++) metas.push(mk('n' + d, d + 0.1, 500));
        const { keep } = selectToKeep(metas, NOW, COLOMBO);
        expect(keep.has('pre')).toBe(true);
        expect(keep.has('preOld')).toBe(false);
    });
    it('a copy taken just before a wipe is kept like one taken before a restore', () => {
        const metas = [mk('wipe', 20, 800, 'pre-wipe')];
        for (let d = 0; d < 30; d++) metas.push(mk('n' + d, d + 0.1, 5));
        expect(selectToKeep(metas, NOW, COLOMBO).keep.has('wipe')).toBe(true);
    });
    it('ignores junk and an empty list', () => {
        expect(selectToKeep([], NOW).drop).toEqual([]);
        expect(selectToKeep([null, {}, { id: 'x' }, { atMs: 1 }], NOW).keep.size).toBe(0);
    });
});

/* ------------------------------------------------------------------ restore points */

describe('saveSnapshot: a restore point exists once Firestore has acknowledged it', () => {
    it('writes the data and its metadata together, and reads back identical', async () => {
        const db = makeDb();
        const d = data(5);
        const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf(d), trigger: 'auto', now: 1760000000000 });
        expect(r.ok).toBe(true);
        expect(r.reused).toBeUndefined();
        expect(db.store.has('users/u1/' + SNAP_COL + '/' + r.id)).toBe(true);
        expect(db.store.has('users/u1/' + DATA_COL + '/' + r.id)).toBe(true);
        const back = await loadSnapshot({ db, uid: 'u1', id: r.id });
        expect(back.ok).toBe(true);
        expect(back.data.expenses).toEqual(d.expenses);
        expect(back.meta.trigger).toBe('auto');
    });
    it('never writes into the live document users/{uid}', async () => {
        const db = makeDb();
        await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data()), now: 1760000000000 });
        expect(db.store.has('users/u1')).toBe(false);
    });
    it('the same data again confirms the newest copy instead of writing another', async () => {
        const db = makeDb();
        const p = payloadOf(data());
        const a = await saveSnapshot({ db, uid: 'u1', payload: p, now: 1760000000000 });
        const b = await saveSnapshot({ db, uid: 'u1', payload: p, now: 1760000000000 + 3600000 });
        expect(b.reused).toBe(true);
        expect(b.id).toBe(a.id);
        expect((await listSnapshots({ db, uid: 'u1' }))).toHaveLength(1);
        expect(db.store.get('users/u1/' + SNAP_COL + '/' + a.id).confirmedAtMs).toBe(1760000000000 + 3600000);
    });
    it('ten "Backup Now" presses on unchanged data do not push older copies out', async () => {
        const db = makeDb();
        await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data(1)), now: 1760000000000 });
        await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data(2)), now: 1760000000000 + DAY });
        for (let i = 0; i < 10; i++) await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data(2)), now: 1760000000000 + DAY + i * 1000 });
        expect((await listSnapshots({ db, uid: 'u1' }))).toHaveLength(2);
    });
    it('changed data is a new copy; the old one stays', async () => {
        const db = makeDb();
        await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data(2)), now: 1760000000000 });
        await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data(3)), now: 1760000000000 + 1000 });
        const l = await listSnapshots({ db, uid: 'u1' });
        expect(l.map((x) => x.records)).toEqual([4, 3]);
    });
    it('"before restore" copies are always written, even when identical', async () => {
        const db = makeDb();
        const p = payloadOf(data());
        await saveSnapshot({ db, uid: 'u1', payload: p, now: 1760000000000 });
        const r = await saveSnapshot({ db, uid: 'u1', payload: p, trigger: 'pre-restore', now: 1760000000000 + 1000 });
        expect(r.reused).toBeUndefined();
        expect((await listSnapshots({ db, uid: 'u1' }))).toHaveLength(2);
    });
    it('nothing to protect yet is not a backup and not an error', async () => {
        const db = makeDb();
        const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf({ settings: { a: 1 }, expenses: [] }), now: 1 });
        expect(r).toEqual({ ok: true, skipped: 'empty' });
        expect(db.store.size).toBe(0);
    });
    it('empty data is still saved before a restore or a wipe (the way back must exist)', async () => {
        const db = makeDb();
        for (const trigger of ['pre-restore', 'pre-wipe']) {
            const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf({ settings: { a: 1 }, expenses: [] }), trigger, now: 1 });
            expect(r.ok).toBe(true);
            expect(r.skipped).toBeUndefined();
        }
    });
    it('refuses what a Firestore document cannot hold, and says why', async () => {
        const db = makeDb();
        const big = { expenses: [{ note: 'x'.repeat(MAX_SNAPSHOT_BYTES + 10) }] };
        const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf(big), now: 1 });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/too large/);
        expect(db.store.size).toBe(0);
    });
    it('a rejected write is a failure, not a success, and leaves nothing half-written', async () => {
        const db = makeDb({ failCommit: true });
        const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data()), now: 1 });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('permission-denied');
        expect(db.store.size).toBe(0);
    });
    it('a write that never returns times out as a failure instead of hanging the schedule', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const db = makeDb({ hangCommit: true });
        const p = saveSnapshot({ db, uid: 'u1', payload: payloadOf(data()), now: 1 });
        await db.state.started;                 // the commit is now pending, so its 25 s timer is armed
        await vi.advanceTimersByTimeAsync(26000);
        const r = await p;
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('timeout');
    });
    it('signed out is a failure with a reason', async () => {
        expect((await saveSnapshot({ db: makeDb(), uid: '', payload: payloadOf(data()) })).reason).toBe('not signed in');
        expect((await saveSnapshot({ db: makeDb(), uid: 'u1', payload: { ok: false, reason: 'no data to back up' } })).ok).toBe(false);
    });
    it('a listing failure does not stop the write (listing is only for dedupe and rotation)', async () => {
        const db = makeDb({ failGet: true });
        const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data()), now: 1760000000000 });
        expect(r.ok).toBe(true);
    });
    it('rotates: twenty-five nightly copies leave a bounded set, newest intact', async () => {
        const db = makeDb();
        const t0 = Date.parse('2026-09-01T12:00:00Z');
        let last;
        for (let d = 0; d < 25; d++) last = await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data(3 + d)), trigger: 'auto', now: t0 + d * DAY, tzOffsetMin: COLOMBO });
        const l = await listSnapshots({ db, uid: 'u1' });
        expect(l.length).toBeLessThan(25);
        expect(l.length).toBeGreaterThanOrEqual(KEEP_DAYS);
        expect(l[0].id).toBe(last.id);
        for (const m of l) expect(db.store.has('users/u1/' + DATA_COL + '/' + m.id)).toBe(true);
        expect([...db.store.keys()].filter((k) => k.includes('/' + DATA_COL + '/')).length).toBe(l.length); // no orphaned data docs
    });
    it('annotateSnapshot merges, and never throws', async () => {
        const db = makeDb();
        const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data()), now: 1760000000000 });
        expect(await annotateSnapshot({ db, uid: 'u1', id: r.id, patch: { drive: { ok: true } } })).toBe(true);
        expect(db.store.get('users/u1/' + SNAP_COL + '/' + r.id).drive).toEqual({ ok: true });
        expect(db.store.get('users/u1/' + SNAP_COL + '/' + r.id).sha).toBeTruthy();
        db.state.failGet = false;
        const bad = { collection: () => { throw new Error('boom'); } };
        expect(await annotateSnapshot({ db: bad, uid: 'u1', id: 'x', patch: {} })).toBe(false);
    });
});

describe('the status document: what the last run did, readable from every device', () => {
    it('round-trips under users/{uid}/backupStatus/last, and never throws', async () => {
        const db = makeDb();
        const status = { atMs: 5, success: false, reason: 'timeout', failCount: 2, by: 'client' };
        expect(await writeStatus({ db, uid: 'u1', status })).toBe(true);
        expect(db.store.has('users/u1/' + STATUS_COL + '/last')).toBe(true);
        expect(await readStatus({ db, uid: 'u1' })).toEqual(status);
        expect(await readStatus({ db: makeDb(), uid: 'nobody' })).toBeNull();
        expect(await readStatus({ db: makeDb({ failGet: true }), uid: 'u1' })).toBeNull();
        expect(await writeStatus({ db: { collection: () => { throw new Error('x'); } }, uid: 'u1', status })).toBe(false);
    });
});

describe('loadSnapshot: a restore proves it read what was written', () => {
    it('refuses a copy whose bytes no longer match the SHA-256', async () => {
        const db = makeDb();
        const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data()), now: 1760000000000 });
        const k = 'users/u1/' + DATA_COL + '/' + r.id;
        db.store.set(k, { ...db.store.get(k), data: db.store.get(k).data.replace('LKR', 'USD') });
        const back = await loadSnapshot({ db, uid: 'u1', id: r.id });
        expect(back.ok).toBe(false);
        expect(back.reason).toMatch(/integrity/);
    });
    it('reports a missing or empty copy plainly', async () => {
        const db = makeDb();
        expect((await loadSnapshot({ db, uid: 'u1', id: 'nope' })).reason).toMatch(/no longer exists/);
        const r = await saveSnapshot({ db, uid: 'u1', payload: payloadOf(data()), now: 1760000000000 });
        db.store.delete('users/u1/' + DATA_COL + '/' + r.id);
        expect((await loadSnapshot({ db, uid: 'u1', id: r.id })).ok).toBe(false);
    });
    it('sha256Hex is real SHA-256', async () => {
        expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
});

/* ------------------------------------------------------------------ Google Drive */

describe('driveBackup: the copy in the user\'s own Drive', () => {
    const text = buildPayload(data(4)).text;
    const run = (drive, over = {}) => driveBackup({ fetch: drive.fetch, getToken: tokens('good'), text, uid: 'abcdef123', email: 'owner@example.com', now: Date.parse('2026-10-19T18:25:00Z'), ...over });

    it('creates a private folder at the top of the user\'s Drive, uploads, and verifies the exact size', async () => {
        const d = makeDrive();
        const r = await run(d);
        expect(r).toMatchObject({ ok: true, verified: true, size: Buffer.byteLength(text) });
        const folder = [...d.files.values()].find((f) => f.mimeType === FOLDER_MIME);
        expect(folder.name).toBe('WealthFlow Backups');
        expect(folder.parents).toEqual(['root']);
        const file = d.files.get(r.fileId);
        expect(file.parents).toEqual([folder.id]);
        expect(file.name).toBe('WealthFlow_owner@example.com_abcdef_2026-10-19_' + Date.parse('2026-10-19T18:25:00Z') + '.json');
        expect(file.text).toBe(text);
    });
    it('never shares anything: no permissions call is ever made', async () => {
        const d = makeDrive();
        await run(d);
        expect(d.calls.filter((c) => /permissions/.test(c.url))).toEqual([]);
    });
    it('the same data again is confirmed, not uploaded a second time', async () => {
        const d = makeDrive();
        await run(d);
        const r = await run(d, { now: Date.parse('2026-10-20T18:25:00Z') });
        expect(r.reused).toBe(true);
        expect([...d.files.values()].filter((f) => f.mimeType === 'application/json')).toHaveLength(1);
    });
    it('a file whose contents were changed after the upload is not confirmed as the copy, even at the same size', async () => {
        const d = makeDrive();
        const first = await run(d);
        const damaged = d.files.get(first.fileId);
        damaged.text = damaged.text.replace(/./, (c) => (c === 'x' ? 'y' : 'x')); // same byte count, same appProperties.sha
        expect(Buffer.byteLength(damaged.text)).toBe(Buffer.byteLength(text));
        const r = await run(d, { now: Date.parse('2026-10-20T18:25:00Z') });
        expect(r).toMatchObject({ ok: true, verified: true });
        expect(r.reused).toBeUndefined();
        expect(r.fileId).not.toBe(first.fileId);
        expect(d.files.get(r.fileId).text).toBe(text);
        const again = await run(d, { now: Date.parse('2026-10-21T18:25:00Z') });
        expect(again).toMatchObject({ ok: true, reused: true, fileId: r.fileId });
    });
    it('a copy that cannot be read back is not confirmed either; a new one is written', async () => {
        const d = makeDrive();
        const first = await run(d);
        const realFetch = d.fetch;
        d.fetch = async (url, init) => (/alt=media/.test(url) && url.includes('/files/' + first.fileId + '?') ?{ ok: false, status: 500, json: async () => ({}), text: async () => '' } : realFetch(url, init));
        const r = await run(d, { now: Date.parse('2026-10-20T18:25:00Z') });
        expect(r).toMatchObject({ ok: true, verified: true });
        expect(r.reused).toBeUndefined();
        expect(r.fileId).not.toBe(first.fileId);
    });
    it('an unchanged copy is confirmed AND the leftovers a failed earlier trim left behind are still trimmed', async () => {
        const d = makeDrive();
        let text6;
        for (let i = 0; i < 4; i++) { // earlier runs whose trim never happened (keep is huge here)
            text6 = buildPayload(data(3 + i)).text;
            await driveBackup({ fetch: d.fetch, getToken: tokens('good'), text: text6, uid: 'abcdef123', email: 'o@x.com', now: Date.parse('2026-10-1' + i + 'T18:25:00Z'), keep: 99 });
        }
        const live = () => [...d.files.values()].filter((f) => f.mimeType === 'application/json' && !f.trashed);
        expect(live()).toHaveLength(4);
        const r = await driveBackup({ fetch: d.fetch, getToken: tokens('good'), text: text6, uid: 'abcdef123', email: 'o@x.com', now: Date.parse('2026-10-20T18:25:00Z'), keep: 2 });
        expect(r).toMatchObject({ ok: true, verified: true, reused: true, trashed: 2 });
        expect(live()).toHaveLength(2);
        expect(live().some((f) => f.id === r.fileId)).toBe(true);
    });
    it('keeps the newest N, trashes the rest (never hard-deletes) and never trashes the file it just wrote', async () => {
        const d = makeDrive();
        let last;
        for (let i = 0; i < 5; i++) last = await driveBackup({ fetch: d.fetch, getToken: tokens('good'), text: buildPayload(data(3 + i)).text, uid: 'abcdef123', email: 'o@x.com', now: Date.parse('2026-10-1' + i + 'T18:25:00Z'), keep: 2 });
        const live = [...d.files.values()].filter((f) => f.mimeType === 'application/json' && !f.trashed);
        expect(live).toHaveLength(2);
        expect(live.map((f) => f.id)).toContain(last.fileId);
        expect([...d.files.values()].filter((f) => f.trashed).length).toBe(3);
        expect(d.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
        expect(last.ok).toBe(true);
        expect(last.trashed).toBe(1);
    });
    it('a stale token (401) is replaced once with a freshly minted one, then the upload succeeds', async () => {
        const d = makeDrive({ valid: 'fresh' });
        const getToken = tokens('stale', 'fresh');
        const r = await driveBackup({ fetch: d.fetch, getToken, text, uid: 'abcdef123', email: 'o@x.com' });
        expect(r.ok).toBe(true);
        expect(getToken.calls).toEqual([false, true]);
    });
    it('a token that is refused twice is reported as expired and does not loop', async () => {
        const d = makeDrive({ valid: 'something-else' });
        const getToken = tokens('stale', 'also-stale');
        const r = await driveBackup({ fetch: d.fetch, getToken, text, uid: 'abcdef123', email: 'o@x.com' });
        expect(r).toMatchObject({ ok: false, verified: false, reason: 'token-expired' });
        expect(getToken.calls).toEqual([false, true]);
        expect([...d.files.values()]).toHaveLength(0);
    });
    it('no token at all is "not connected" and touches nothing', async () => {
        const d = makeDrive();
        const r = await driveBackup({ fetch: d.fetch, getToken: async () => null, text, uid: 'u', email: 'e' });
        expect(r).toMatchObject({ ok: false, reason: 'not-connected' });
        expect(d.calls).toEqual([]);
    });
    it('a full Drive is reported as such', async () => {
        const d = makeDrive({ quota: true });
        const r = await run(d);
        expect(r).toMatchObject({ ok: false, verified: false, reason: 'storageQuotaExceeded' });
        expect(driveReasonText(r.reason)).toMatch(/full/i);
    });
    it('a truncated upload is NOT called verified (exists-and-non-zero used to pass this)', async () => {
        const d = makeDrive({ truncate: true });
        const r = await run(d);
        expect(r).toMatchObject({ ok: false, verified: false, reason: 'size-mismatch' });
    });
    it('a network failure is a result, not an exception', async () => {
        const d = makeDrive({ down: true });
        const r = await run(d);
        expect(r).toMatchObject({ ok: false, verified: false, reason: 'network' });
    });
    it('reuses an existing folder by name, ignores a trashed one, and prefers a valid remembered id', async () => {
        const d = makeDrive();
        const t = 'good';
        d.files.set('old', { id: 'old', name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'], trashed: true, createdTime: '2020-01-01T00:00:00Z', appProperties: {} });
        d.files.set('live', { id: 'live', name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'], trashed: false, createdTime: '2021-01-01T00:00:00Z', appProperties: {} });
        d.files.set('other', { id: 'other', name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME, parents: ['root'], trashed: false, createdTime: '2022-01-01T00:00:00Z', appProperties: {} });
        expect(await ensureDriveFolder({ fetch: d.fetch, token: t })).toEqual({ ok: true, id: 'live' });
        expect(await ensureDriveFolder({ fetch: d.fetch, token: t, hint: 'other' })).toEqual({ ok: true, id: 'other' });
        expect(await ensureDriveFolder({ fetch: d.fetch, token: t, hint: 'old' })).toEqual({ ok: true, id: 'live' });
        expect(await ensureDriveFolder({ fetch: d.fetch, token: t, hint: 'missing' })).toEqual({ ok: true, id: 'live' });
        expect([...d.files.values()].filter((f) => f.mimeType === FOLDER_MIME && !f.trashed)).toHaveLength(2); // nothing new was created
    });
    it('lists only this person\'s files (another account\'s backups in the same Drive are not theirs)', async () => {
        const d = makeDrive();
        await driveBackup({ fetch: d.fetch, getToken: tokens('good'), text, uid: 'abcdef123', email: 'a@x.com' });
        await driveBackup({ fetch: d.fetch, getToken: tokens('good'), text: text + ' ', uid: 'zzzzzz999', email: 'b@x.com' });
        const l = await listDriveBackups({ fetch: d.fetch, token: 'good', safeEmail: 'a@x.com', uid6: 'abcdef' });
        expect(l.ok).toBe(true);
        expect(l.files).toHaveLength(1);
        expect(l.files[0].name).toMatch(/^WealthFlow_a@x\.com_abcdef_/);
    });
    it('the restore list can also see the older "WealthFlow_Backup…" names, but rotation never does', async () => {
        const d = makeDrive();
        d.files.set('legacy', { id: 'legacy', name: 'WealthFlow_Backup_2026-01-01.json', mimeType: 'application/json', parents: ['x'], trashed: false, createdTime: '2026-01-01T00:00:00Z', size: 10, appProperties: {} });
        d.files.set('mine', { id: 'mine', name: 'WealthFlow_a@x.com_abcdef_2026-09-01_1.json', mimeType: 'application/json', parents: ['x'], trashed: false, createdTime: '2026-09-01T00:00:00Z', size: 10, appProperties: {} });
        const plain = await listDriveBackups({ fetch: d.fetch, token: 'good', safeEmail: 'a@x.com', uid6: 'abcdef' });
        const withLegacy = await listDriveBackups({ fetch: d.fetch, token: 'good', safeEmail: 'a@x.com', uid6: 'abcdef', includeLegacy: true });
        expect(plain.files.map((f) => f.id)).toEqual(['mine']);
        expect(withLegacy.files.map((f) => f.id).sort()).toEqual(['legacy', 'mine']);
        // a run with keep=1 trashes only files the module names itself
        await driveBackup({ fetch: d.fetch, getToken: tokens('good'), text: buildPayload(data(2)).text, uid: 'abcdef123', email: 'a@x.com', keep: 1 });
        expect(d.files.get('legacy').trashed).toBe(false);
    });
    it('one failed trash does not stop the others', async () => {
        const calls = [];
        const f = async (url, init) => { calls.push(url); if (/f2$/.test(url)) throw new Error('x'); return { ok: true, status: 200, json: async () => ({}) }; };
        const n = await pruneDriveBackups({ fetch: f, token: 't', keep: 1, protect: '', files: ['f1', 'f2', 'f3'].map((id, i) => ({ id, createdTime: '2026-01-0' + (3 - i) + 'T00:00:00Z' })) });
        expect(calls).toHaveLength(2);
        expect(n).toBe(1);
    });
    it('every refusal has words a person can act on', () => {
        for (const c of ['not-connected', 'token-expired', 'http-401', 'storageQuotaExceeded', 'insufficientPermissions', 'http-403', 'rateLimitExceeded', 'size-mismatch', 'folder-failed', 'http-503', 'network', 'invalid_grant']) {
            expect(driveReasonText(c).length).toBeGreaterThan(15);
        }
        expect(driveReasonText('weird')).toMatch(/weird/);
    });
});

/* ------------------------------------------------------------------ what the card says */

describe('describeBackup: the status line says what is true now', () => {
    const now = Date.parse('2026-10-19T12:00:00Z');
    it('says plainly when no backup exists', () => {
        const s = describeBackup({ freq: 'daily', lastGoodMs: 0, now });
        expect(s.level).toBe('bad');
        expect(s.lines[0].text).toMatch(/No backup exists/);
    });
    it('is quiet when a fresh copy exists and Drive agrees', () => {
        const s = describeBackup({ freq: 'daily', lastGoodMs: now - 3600000, rp: { atMs: now - 3600000 }, drive: { ok: true }, attempt: { success: true, atMs: now - 3600000 }, now });
        expect(s.level).toBe('ok');
        expect(s.lines).toEqual([]);
    });
    it('a stale copy is bad even though one exists', () => {
        const s = describeBackup({ freq: 'daily', lastGoodMs: now - 5 * DAY, drive: { ok: true }, now });
        expect(s.level).toBe('bad');
    });
    it('a failure AFTER the last good copy is shown, not hidden behind the earlier success', () => {
        const s = describeBackup({ freq: 'daily', lastGoodMs: now - 3600000, drive: { ok: true }, attempt: { success: false, atMs: now - 60000, reason: 'timeout' }, now });
        expect(s.level).toBe('warn');
        expect(s.lines.map((l) => l.text).join(' ')).toMatch(/last attempt failed: timeout/);
    });
    it('a failure BEFORE a later good copy is history, not a warning', () => {
        const s = describeBackup({ freq: 'daily', lastGoodMs: now - 60000, drive: { ok: true }, attempt: { success: false, atMs: now - 3600000, reason: 'x' }, now });
        expect(s.level).toBe('ok');
    });
    it('a Drive failure is a warning in plain words, while the restore point still counts', () => {
        const s = describeBackup({ freq: 'daily', lastGoodMs: now - 60000, drive: { ok: false, reason: 'token-expired' }, now });
        expect(s.level).toBe('warn');
        expect(s.lines[0].text).toMatch(/Reconnect Google Drive/);
    });
});

describe('deleteAllSnapshots: the person\'s own "delete my backups"', () => {
    const seed = async (db, n) => {
        for (let i = 0; i < n; i++) await saveSnapshot({ db, uid: 'u', payload: payloadOf(data(2 + i)), trigger: i % 2 ? 'manual' : 'pre-wipe', now: 1760000000000 + i * 60000 });
        await writeStatus({ db, uid: 'u', status: { atMs: 1, success: true } });
    };
    it('removes every restore point, its data and the status, and nothing else', async () => {
        const db = makeDb();
        await seed(db, 7);
        db.store.set('users/u', { expenses: [{ id: 'live' }] });
        db.store.set('users/other/backups/x', { atMs: 1 });
        const held = [...db.store.keys()].filter((k) => k.startsWith('users/u/backups/')).length;
        expect(held).toBeGreaterThan(3);                        // rotation may already have dropped one of the seven
        const r = await deleteAllSnapshots({ db, uid: 'u' });
        expect(r).toEqual({ ok: true, deleted: held });
        expect([...db.store.keys()].filter((k) => k.startsWith('users/u/'))).toEqual([]);
        expect(db.store.get('users/u')).toEqual({ expenses: [{ id: 'live' }] });
        expect(db.store.has('users/other/backups/x')).toBe(true);
    });
    it('pages through more than one batch', async () => {
        const db = makeDb();
        for (let i = 0; i < 230; i++) {
            db.store.set('users/u/backups/p' + i, { atMs: i, trigger: 'manual' });
            db.store.set('users/u/backupData/p' + i, { data: '{}' });
        }
        expect(await deleteAllSnapshots({ db, uid: 'u' })).toEqual({ ok: true, deleted: 230 });
        expect(db.store.size).toBe(0);
    });
    it('an empty account is a clean no-op', async () => {
        expect(await deleteAllSnapshots({ db: makeDb(), uid: 'u' })).toEqual({ ok: true, deleted: 0 });
    });
    it('a failed delete reports the reason and deletes nothing (metadata and data go in one batch)', async () => {
        const db = makeDb();
        await seed(db, 3);
        db.state.failCommit = true;
        const r = await deleteAllSnapshots({ db, uid: 'u' });
        expect(r).toMatchObject({ ok: false, deleted: 0, reason: 'permission-denied' });
        expect([...db.store.keys()].filter((k) => k.includes('/backups/')).length).toBe(3);
        expect([...db.store.keys()].filter((k) => k.includes('/backupData/')).length).toBe(3);
    });
    it('BACKUP_STAMP_KEYS is the list the page keeps through a restore', () => {
        expect(BACKUP_STAMP_KEYS.sort()).toEqual(['lastAutoBackupAt', 'lastBackup', 'lastBackupAttempt', 'lastBackupMeta', 'lastDriveBackup']);
        expect(Backup.BACKUP_STAMP_KEYS).toEqual(BACKUP_STAMP_KEYS);
    });
});

/* ------------------------------------------------------------------ names, reasons and reading a Drive copy back */

describe('driveNameParts: the list and the upload agree on whose file it is', () => {
    it('keeps an ordinary address and shortens the uid to six characters', () => {
        expect(driveNameParts('abcdefghij', 'me@example.com')).toEqual({ safeEmail: 'me@example.com', uid6: 'abcdef' });
    });
    it('replaces anything that is not safe in a file name', () => {
        expect(driveNameParts('u1', 'a b/c\\d?e@x.lk').safeEmail).toBe('a_b_c_d_e@x.lk');
    });
    it('has a fallback for a missing address and uid, so a name is never "undefined"', () => {
        expect(driveNameParts('', '')).toEqual({ safeEmail: 'user', uid6: 'anon' });
        expect(driveNameParts(undefined, null)).toEqual({ safeEmail: 'user', uid6: 'anon' });
    });
    it('a file uploaded by driveBackup is found by the very same parts', async () => {
        const drive = makeDrive();
        const r = await driveBackup({ fetch: drive.fetch, getToken: tokens('good'), text: payloadOf(data()).text, uid: 'zyxwvu123', email: 'o w n@x.lk' });
        expect(r.ok && r.verified).toBe(true);
        const np = driveNameParts('zyxwvu123', 'o w n@x.lk');
        const l = await listDriveBackups({ fetch: drive.fetch, token: 'good', safeEmail: np.safeEmail, uid6: np.uid6 });
        expect(l.files.map((x) => x.id)).toEqual([r.fileId]);
        const other = driveNameParts('qqqqqq999', 'o w n@x.lk');
        const none = await listDriveBackups({ fetch: drive.fetch, token: 'good', safeEmail: other.safeEmail, uid6: other.uid6 });
        expect(none.files, 'another account\'s files were listed as this one\'s').toEqual([]);
    });
});

describe('restorePointReasonText: what the person is told when the account would not take a copy', () => {
    it('translates the codes Firestore gives', () => {
        expect(restorePointReasonText('permission-denied')).toMatch(/refused the write/);
        expect(restorePointReasonText('unavailable')).toMatch(/could not be reached/);
        expect(restorePointReasonText('timeout')).toMatch(/connection/);
        expect(restorePointReasonText('not signed in')).toBe('you are not signed in');
    });
    it('passes an unknown message through rather than hiding it, and never returns an empty string', () => {
        expect(restorePointReasonText('deadline-exceeded')).toBe('deadline-exceeded');
        expect(restorePointReasonText('')).toBe('the write failed');
        expect(restorePointReasonText(undefined)).toBe('the write failed');
    });
});

describe('downloadDriveBackup: a restore reads a Drive copy back and proves it first', () => {
    async function uploaded(over = {}) {
        const drive = makeDrive(over);
        const text = payloadOf(data(4)).text;
        const r = await driveBackup({ fetch: drive.fetch, getToken: tokens('good'), text, uid: 'user01', email: 'a@b.lk' });
        const np = driveNameParts('user01', 'a@b.lk');
        const l = await listDriveBackups({ fetch: drive.fetch, token: 'good', safeEmail: np.safeEmail, uid6: np.uid6 });
        return { drive, text, file: l.files.find((x) => x.id === r.fileId) };
    }
    it('returns the data of a file that matches its size and its SHA-256', async () => {
        const { drive, text, file } = await uploaded();
        const d = await downloadDriveBackup({ fetch: drive.fetch, token: 'good', file });
        expect(d.ok).toBe(true);
        expect(d.verifiedSha).toBe(true);
        expect(d.text).toBe(text);
        expect(d.data.expenses).toHaveLength(4);
    });
    it('refuses a file whose content changed after it was uploaded (SHA-256 mismatch)', async () => {
        const { drive, file } = await uploaded();
        const f = drive.files.get(file.id);
        f.text = f.text.replace('"amount":100', '"amount":999');        // same length, different content
        const d = await downloadDriveBackup({ fetch: drive.fetch, token: 'good', file });
        expect(d.ok).toBe(false);
        expect(d.reason).toBe('integrity');
    });
    it('refuses a file shorter than the size Drive lists (a truncated copy)', async () => {
        const { drive, file } = await uploaded();
        drive.files.get(file.id).text = drive.files.get(file.id).text.slice(0, -10);
        const d = await downloadDriveBackup({ fetch: drive.fetch, token: 'good', file });
        expect(d).toMatchObject({ ok: false, reason: 'size-mismatch' });
    });
    it('reads an older file that has no stored SHA, on the size check alone, and says so', async () => {
        const drive = makeDrive();
        const text = JSON.stringify(data(2));
        drive.files.set('old1', { id: 'old1', name: 'WealthFlow_Backup_2026-09-13.json', mimeType: 'application/json', parents: ['x'], appProperties: {}, text, size: Buffer.byteLength(text), trashed: false, createdTime: '2026-09-13T00:00:00.000Z' });
        const d = await downloadDriveBackup({ fetch: drive.fetch, token: 'good', file: { id: 'old1', size: String(Buffer.byteLength(text)), appProperties: {} } });
        expect(d.ok).toBe(true);
        expect(d.verifiedSha).toBe(false);
    });
    it('reports an expired token as token-expired, so the page can mint a new one and retry', async () => {
        const { drive, file } = await uploaded();
        const d = await downloadDriveBackup({ fetch: drive.fetch, token: 'stale', file });
        expect(d).toMatchObject({ ok: false, reason: 'token-expired' });
    });
    it('reports a file that is gone, a body that is not JSON, and a network failure by name', async () => {
        const { drive, file } = await uploaded();
        expect((await downloadDriveBackup({ fetch: drive.fetch, token: 'good', file: { id: 'nope' } })).reason).toBe('notFound');
        const f = drive.files.get(file.id);
        const junk = 'not json at all';
        f.text = junk; f.size = Buffer.byteLength(junk);
        const noSha = { id: file.id, size: String(Buffer.byteLength(junk)), appProperties: {} };
        expect((await downloadDriveBackup({ fetch: drive.fetch, token: 'good', file: noSha })).reason).toBe('unreadable');
        drive.down = true;
        expect((await downloadDriveBackup({ fetch: drive.fetch, token: 'good', file })).reason).toBe('network');
        expect((await downloadDriveBackup({ fetch: drive.fetch, token: 'good', file: null })).reason).toBe('no-file');
    });
});

/* ------------------------------------------------------------------ the page and the module agree */

describe('the module and index.html agree', () => {
    it('RECORD_KEYS is the same list as _WF_RECORD_KEYS', () => {
        const m = HTML.match(/const _WF_RECORD_KEYS = \[([^\]]+)\]/);
        expect(m, '_WF_RECORD_KEYS moved in index.html — retarget this test').toBeTruthy();
        const page = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
        expect(RECORD_KEYS).toEqual(page);
    });
    it('emptyCollections() is the set of empty collections the factory reset names (a restore fills in what a copy lacks with the same blanks)', () => {
        const at = HTML.indexOf('async function executeFactoryReset');
        const lit = HTML.slice(HTML.indexOf('appData = {', at), HTML.indexOf('settings: currentSettings', at));
        expect(lit, 'the factory reset literal moved in index.html — retarget this test').toContain('auth: currentAuth');
        const lists = [...lit.matchAll(/(\w+): \[\]/g)].map((m) => m[1]).filter((k) => k !== 'flows');      // flows lives inside balance
        const maps = [...lit.matchAll(/(\w+): \{\}/g)].map((m) => m[1]).filter((k) => k !== '_tomb' && k !== '_kut');
        const blank = emptyCollections();
        expect(Object.keys(blank).filter((k) => Array.isArray(blank[k])).sort()).toEqual(lists.slice().sort());
        expect(Object.keys(blank).filter((k) => blank[k] && !Array.isArray(blank[k]) && Object.keys(blank[k]).length === 0).sort()).toEqual(maps.sort());
        expect(blank.balance).toEqual({ total: 0, flows: [] });
        expect(emptyCollections(), 'a fresh object every time: a restore must not share one list between two keys or two restores').not.toBe(emptyCollections());
        expect(blank.cheques).not.toBe(blank.people);
    });
    it('the default export and the named exports are the same functions', () => {
        expect(Backup.backupDue).toBe(backupDue);
        expect(Backup.saveSnapshot).toBe(saveSnapshot);
        expect(Backup.driveBackup).toBe(driveBackup);
    });
});
