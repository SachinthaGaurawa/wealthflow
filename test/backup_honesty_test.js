/* =============================================================================
 * test/backup_honesty_test.js — a backup that did not happen must not report that it did, and a restore or a wipe must not destroy
 * data without a way back
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG (owner, 2026-10-19: "check that the Auto-Backup Schedule works properly; fix it if anything is wrong")
 *
 * The schedule ran every night. scheduleAutoBackup() fired, _checkAutoBackupDue() computed the right trigger and called backupNow() — and
 * backupNow() reported success whatever happened, because the "cloud backup" was
 *
 *     setDirty(true); await Promise.resolve(syncToCloud()); cloudOk = true;
 *
 * syncToCloud() pushes the LIVE data onto itself: it is a sync, not a backup, and it returned undefined on every path — before the write
 * when signed out, offline or nothing was dirty. So success was stamped, "Auto-Backup Complete" was pushed to the phone, and the card said
 * the data was safe, whether or not anything had been copied anywhere. The Drive half used an hour-old token at 23:55, got a 401 and
 * swallowed it; its files went to a folder anyone could edit; a failed run retried every 30 seconds for ever without telling anyone; and a
 * restore threw the current data away without keeping it.
 *
 * WHY THESE TESTS RUN THE REAL SOURCE
 *
 * The page's half of the backup lives inline in index.html. Asserting on its text would re-check the spelling of the fix, not its
 * behaviour, so the source is extracted and EXECUTED — against the real wealthflow-backup.js, an in-memory Firestore that rejects when told
 * to, and a Drive that refuses a stale token — and what is asserted is what ended up in those stores and what the person was told.
 * ===========================================================================*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import B, { listSnapshots, loadSnapshot, readStatus } from '../wealthflow-backup.js';
import { makeDb, makeDrive } from './helpers/backup-fakes.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

afterEach(() => { vi.useRealTimers(); });

/** The source of a named function declaration, by brace matching. */
function fnSource(name) {
    const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const m = HTML.match(re);
    expect(m, `${name}() is gone from index.html — retarget this test`).toBeTruthy();
    const start = m.index;
    let i = HTML.indexOf('{', start), depth = 0, inStr = null, j = i;
    for (; j < HTML.length; j++) {
        const ch = HTML[j];
        if (inStr) {
            if (ch === '\\') { j++; continue; }
            if (ch === inStr) inStr = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '/' && HTML[j + 1] === '/') { j = HTML.indexOf('\n', j); continue; }
        if (ch === '/' && HTML[j + 1] === '*') { j = HTML.indexOf('*/', j) + 1; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    expect(depth, `could not brace-match ${name}()`).toBe(0);
    return HTML.slice(start, j + 1);
}

/** The text of index.html from one marker comment to the end of the line containing another. */
function between(from, to) {
    const a = HTML.indexOf(from);
    expect(a, `"${from}" is gone from index.html — retarget this test`).toBeGreaterThan(-1);
    const b = HTML.indexOf(to, a);
    expect(b, `"${to}" is gone from index.html — retarget this test`).toBeGreaterThan(a);
    const e = HTML.indexOf('\n', b);
    return HTML.slice(a, e < 0 ? HTML.length : e);
}

/* ============================================================================================================================
 * PART 1 — syncToCloud keeps reporting what it did. It is still the sync (not the backup), and the "Sync now" button, the reconnect
 * path and the unload flush read its result.
 * ==========================================================================================================================*/

const SYNC_DEPS = [
    'userDocRef', 'navigator', 'setSyncStatus', 'isDirty', '_flushCloudDeletes', 'appData',
    'firebase', 'currentUser', '_getDeviceId', 'setDirty', 'console', 'notify', 'triggerHaptic',
    'DB', 'localStorage', 'window', '_wfCloudSafe', '_wfApplyCloudData', 'debouncedSync', '_wfPaintCloudChange',
];

/* The page pushes through a Firestore transaction (read the newest cloud document, merge it, write), so the fake document reference
 * offers one. `set` is what the test wants the WRITE to do; a rejection fails the transaction, as it does in Firestore. */
const docWith = (set) => {
    const ref = { set };
    ref.firestore = {
        runTransaction: async (fn) => {
            const writes = [];
            await fn({ get: async () => ({ exists: false }), set: (r, data, opts) => { writes.push(r.set(data, opts)); } });
            await Promise.all(writes);
        },
    };
    return ref;
};

function loadSync(over = {}) {
    const settings = {};
    const store = new Map();
    const env = {
        userDocRef: over.userDocRef !== undefined ? over.userDocRef : docWith(() => Promise.resolve()),
        navigator: { onLine: over.onLine !== false },
        setSyncStatus: () => {},
        isDirty: over.isDirty !== undefined ? over.isDirty : true,
        _flushCloudDeletes: () => {},
        _wfCloudSafe: new Function(fnSource('_wfCloudSafe') + '\nreturn _wfCloudSafe;')(),
        appData: { expenses: [] },
        firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
        currentUser: over.signedIn === false ? null : { uid: 'u1', email: 'a@b.c' },
        _getDeviceId: () => 'dev1',
        setDirty: () => {},
        console: { log() {}, warn() {}, error() {} },
        notify: () => {},
        triggerHaptic: () => {},
        DB: { getObj: () => settings, set: (k, v) => { if (k === 'settings') Object.assign(settings, v); } },
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
        window: { currentUser: over.signedIn === false ? null : { uid: 'u1', email: 'a@b.c' } },
        _wfApplyCloudData: () => ({ nonSessionChanged: false, sessionsChanged: false, needPush: false }),
        debouncedSync: () => {},
        _wfPaintCloudChange: () => {},
    };
    const body = fnSource('_persistLocal') + '\n' + fnSource('_persistRaw') + '\n' + fnSource('syncToCloud') + '\nreturn { syncToCloud: syncToCloud };';
    return new Function(...SYNC_DEPS, 'let _lastCloudPushError = ""; let _wfLocalWriteBlocked = false; let _dirtyGen = 0; let isSyncingFromCloud = false;\n' + body)(...SYNC_DEPS.map((d) => env[d]));
}

describe('syncToCloud reports what it actually did', () => {
    it('resolves true only after Firestore acknowledges the write', async () => {
        let called = false;
        const { syncToCloud } = loadSync({ userDocRef: docWith(() => { called = true; return Promise.resolve(); }) });
        expect(await syncToCloud()).toBe(true);
        expect(called, 'it reported success without writing anything').toBe(true);
    });
    it('resolves false when Firestore rejects the write', async () => {
        const { syncToCloud } = loadSync({ userDocRef: docWith(() => Promise.reject({ code: 'permission-denied', message: 'nope' })) });
        expect(await syncToCloud(), 'a rejected write still reported success').toBe(false);
    });
    it('resolves false when there is no user document, or the device is offline', async () => {
        expect(await loadSync({ userDocRef: null }).syncToCloud()).toBe(false);
        expect(await loadSync({ onLine: false }).syncToCloud()).toBe(false);
    });
    it('resolves true when the cloud already holds this data, without writing', async () => {
        const { syncToCloud } = loadSync({ isDirty: false, userDocRef: docWith(() => { throw new Error('must not write'); }) });
        expect(await syncToCloud()).toBe(true);
    });
    it('never rejects, so the fire-and-forget callers are unharmed', async () => {
        await expect(loadSync({ userDocRef: docWith(() => Promise.reject(new Error('x'))) }).syncToCloud()).resolves.toBe(false);
    });
});

/* ============================================================================================================================
 * PART 2 — the backup, the restore, the wipe and the scheduler: the page's half of the Auto-Backup Schedule
 * ==========================================================================================================================*/

const REGION_BACKUP = between('// ═══ THE BACKUP, END TO END (v7.70)', 'function _wfKickBackupRefresh()');
const REGION_RESTORE = (() => {
    const a = HTML.indexOf('// ═══ RESTORE (v7.70)');
    expect(a, 'the RESTORE section is gone from index.html — retarget this test').toBeGreaterThan(-1);
    const fn = fnSource('_wfApplyRestore');
    return HTML.slice(a, HTML.indexOf(fn, a) + fn.length);
})();
const REGION_SCHEDULER = between('// ==================== AUTO-BACKUP SCHEDULER (v7.70)', "caches.delete('wf-backup-cache')");
const SRC_FACTORY_RESET = fnSource('executeFactoryReset');
const SRC_WEEKSTART = fnSource('_weekStartDay');
const SRC_NEXT_TIME = fnSource('getNextBackupTime');

const ENV_NAMES = ['window', 'navigator', 'localStorage', 'document', 'notify', 'triggerHaptic', 'console', 'firebase', 'userDocRef', 'user', 'showConfirm',
    'closeModal', 'openModal', '$', 'setTimeout', 'setInterval', 'clearInterval', 'setDirty', 'sendSmartNotification', 'renderSettings', 'sha256', 'env'];

const BODY = `
let appData = env.appData;
let gapiToken = env.gapiToken || null;
let _wfLocalWriteBlocked = false;
let isSyncingFromCloud = false;
const currentUser = user;
const DB = {
    get(k, d = []) { return appData[k] !== undefined ? appData[k] : d; },
    getObj(k, d = {}) { return appData[k] !== undefined ? appData[k] : d; },
    set(k, v) { appData[k] = v; },
    delKey(field, key) { const o = appData[field]; if (o && typeof o === 'object') delete o[key]; env.cloudDeletes.push(field + '.' + key); },
};
const _ic = (n) => '[' + n + ']';
const _wfEsc = (s) => String(s);
const _wfGetDriveRefreshToken = () => env.refresh || '';
const _wfEnsureDriveTokenDurable = async () => { env.mintCalls++; if (env.mint) { gapiToken = env.mint; return true; } return false; };
const _ensureDriveTokenSilent = async () => false;
const _wfReconcileWithCloud = async () => { env.reconciles++; };
const _unregisterAutoBackupSync = () => {};
const _registerAutoBackupSync = () => {};
const _registerPeriodicAutoBackupSync = () => {};
${fnSource('_persistLocal')}
${fnSource('_persistRaw')}
${REGION_BACKUP}
${REGION_RESTORE}
${SRC_WEEKSTART}
${REGION_SCHEDULER}
${SRC_NEXT_TIME}
${SRC_FACTORY_RESET}
return {
    backupNow, executeDriveBackup, _getLastBackupMs, _wfSaveSafetyCopy, _wfApplyRestore, executeRestoreSelected, fetchRestoreList, executeFactoryReset, deleteAllRestorePoints, _wfDeleteRestorePoints,
    _checkAutoBackupDue, _wfBackupFailState, _wfRefreshBackupState, _wfDriveTokenFor, _wfBackupInfoHtml, _wfDriveBackupWithToasts, _wfPaintBackupCard,
    getAppData: () => appData, setRestoreItems: (x) => { _wfRestoreItems = x; }, getGapiToken: () => gapiToken, setGapiToken: (t) => { gapiToken = t; },
};`;

/** A DOM element as far as the restore list and the factory-reset form use one. */
function makeEl() {
    const el = { children: [], value: '', style: {}, disabled: false, _text: '', classList: { contains: () => false } };
    Object.defineProperty(el, 'textContent', { get() { return el._text; }, set(v) { el._text = String(v); if (v === '') el.children = []; } });
    el.appendChild = (c) => { el.children.push(c); return c; };
    return el;
}

const baseData = () => ({
    expenses: [{ id: 'e1', amount: 100 }, { id: 'e2', amount: 200 }, { id: 'e3', amount: 300 }],
    income: [{ id: 'i1', amount: 5000 }],
    settings: { currency: 'LKR', autoBackupFreq: 'daily' },
    auth: { pin: 'PIN-HASH-A' },
});

function loadPage(over = {}) {
    const db = over.db || makeDb(over.dbOpts);
    const drive = over.drive || makeDrive({ valid: 'good' });
    const user = over.signedIn === false ? null : { uid: 'u1', email: 'owner@example.lk' };
    const calls = [];
    const timers = [];
    const notes = [];
    const confirms = [];
    const store = new Map(Object.entries(over.local || {}));
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => { calls.push('localStorage.clear'); store.clear(); },
    };
    const origBatch = db.batch.bind(db);
    db.batch = () => { const b = origBatch(); const c = b.commit; b.commit = async () => { calls.push('batch.commit'); return c(); }; return b; };
    const appData = over.appData || baseData();
    const snapshotsAtSet = [];
    if (over.cloudDoc) db.store.set('users/u1', structuredClone(over.cloudDoc));
    const userDocRef = user ? {
        firestore: db,
        async get() {
            calls.push('users.get');
            if (over.userGetFails) throw Object.assign(new Error('offline'), { code: 'unavailable' });
            const d = db.store.get('users/u1');
            return { exists: d !== undefined, data: () => (d === undefined ? undefined : structuredClone(d)) };
        },
        async set(d) {
            calls.push('users.set');
            snapshotsAtSet.push([...db.store.entries()].filter(([k]) => /^users\/u1\/backups\//.test(k)).map(([, v]) => v.trigger));
            if (over.userSetFails) throw Object.assign(new Error('offline'), { code: 'unavailable' });
            db.store.set('users/u1', structuredClone(d));
        },
    } : null;
    const win = { WFBackup: over.noModule ? null : B, currentUser: user, _isDecoyMode: !!over.decoy, fetch: drive.fetch };
    const env = { appData, gapiToken: over.gapiToken || null, mint: over.mint === undefined ? 'good' : over.mint, mintCalls: 0, reconciles: 0, cloudDeletes: [], refresh: over.refresh || '' };
    const elements = new Proxy({}, { get: (t, id) => t[id] || (t[id] = makeEl()) });
    const smart = [];
    const fake = {
        window: win,
        navigator: { onLine: over.onLine !== false, serviceWorker: { ready: Promise.resolve({ sync: { register: async () => { calls.push('sync.register'); } } }) } },
        localStorage,
        document: over.settingsDom ? over.settingsDom.document : { getElementById: () => null, createElement: () => makeEl() },
        notify: (m, kind) => { notes.push({ m: String(m), kind }); },
        triggerHaptic: () => {},
        console: { log() {}, warn() {}, error() {}, info() {} },
        firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
        userDocRef,
        user,
        showConfirm: (...a) => { confirms.push(a); },
        closeModal: () => {}, openModal: () => {},
        $: (id) => elements[id],
        setTimeout: over.realTimers ? (fn, ms) => globalThis.setTimeout(fn, ms) : (fn) => { timers.push(fn); return timers.length; },
        setInterval: () => 1, clearInterval: () => {},
        setDirty: (s) => { calls.push('setDirty:' + s); },
        sendSmartNotification: (...a) => { smart.push(a); },
        renderSettings: () => { calls.push('renderSettings'); },
        sha256: async (s) => 'HASH(' + s + ')',
        env,
    };
    const api = new Function(...ENV_NAMES, BODY)(...ENV_NAMES.map((n) => fake[n]));
    return { ...api, db, drive, calls, notes, confirms, store, win, appData, env, elements, timers, smart, snapshotsAtSet, user };
}

const rps = (db) => [...db.store.entries()].filter(([k]) => /^users\/u1\/backups\//.test(k)).map(([k, v]) => ({ id: k.split('/').pop(), ...v })).sort((a, b) => a.atMs - b.atMs);
const status = (db) => db.store.get('users/u1/backupStatus/last');

describe('the extraction found real code (guards a vacuous suite)', () => {
    it('the page\'s backup, restore, wipe and scheduler came out of index.html', () => {
        expect(REGION_BACKUP.length).toBeGreaterThan(5000);
        expect(REGION_RESTORE.length).toBeGreaterThan(4000);
        expect(REGION_SCHEDULER.length).toBeGreaterThan(2500);
        expect(SRC_FACTORY_RESET.length).toBeGreaterThan(1500);
        const p = loadPage();
        for (const f of ['backupNow', 'executeDriveBackup', '_wfApplyRestore', 'executeRestoreSelected', 'executeFactoryReset', '_checkAutoBackupDue']) expect(typeof p[f]).toBe('function');
    });
});

/* ------------------------------------------------------------------ backupNow */

describe('backupNow succeeds when a copy EXISTS afterwards, and only then', () => {
    it('writes a restore point, records it, and clears any failure streak', async () => {
        const p = loadPage({ local: { wf_backup_fail: JSON.stringify({ n: 3, at: 1 }) } });
        expect(await p.backupNow(true, 'auto')).toBe(true);
        const list = rps(p.db);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ trigger: 'auto', records: 4 });
        const s = p.appData.settings;
        expect(s.lastBackupMeta).toMatchObject({ v: 2, cloud: true, drive: false, trigger: 'auto', records: 4, id: list[0].id });
        expect(s.lastBackupAttempt).toMatchObject({ success: true, cloud: true, drive: false });
        expect(p._wfBackupFailState()).toEqual({ n: 0, at: 0 });
        expect(status(p.db)).toMatchObject({ success: true, by: 'client', trigger: 'auto', rpId: list[0].id, failCount: 0 });
        expect(p.store.get('wf_last_auto_backup')).toBeTruthy();
    });

    it('the copy is the live data — and it restores to exactly that', async () => {
        const p = loadPage();
        await p.backupNow(true, 'auto');
        const back = await loadSnapshot({ db: p.db, uid: 'u1', id: rps(p.db)[0].id });
        expect(back.ok).toBe(true);
        expect(back.data.expenses.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    });

    it('makes the device current with the account first, so the copy is the newest the account has', async () => {
        const p = loadPage();
        await p.backupNow(true, 'auto');
        expect(p.env.reconciles).toBe(1);
    });

    it('a rejected write returns false and stamps NO success, naming the cause', async () => {
        const p = loadPage({ dbOpts: { failCommit: true } });
        expect(await p.backupNow(true, 'auto'), 'the scheduler stamps its success on this value').toBe(false);
        expect(rps(p.db)).toHaveLength(0);
        const s = p.appData.settings;
        expect(s.lastBackup, 'a failed backup left a "last backup" time behind').toBeUndefined();
        expect(s.lastAutoBackupAt).toBeUndefined();
        expect(s.lastBackupMeta).toBeUndefined();
        expect(p.store.get('wf_last_auto_backup')).toBeUndefined();
        expect(s.lastBackupAttempt.success).toBe(false);
        expect(s.lastBackupAttempt.reason).toMatch(/refused the write/);
        expect(p._getLastBackupMs()).toBe(0);
    });

    it('the failure reaches the account too, so another device and the server see it', async () => {
        const p = loadPage({ dbOpts: { failCommit: true } });
        await p.backupNow(true, 'auto');
        expect(status(p.db)).toMatchObject({ success: false, failCount: 1, by: 'client' });
        expect(status(p.db).reason).toMatch(/refused the write/);
    });

    it('counts a streak of failures (the schedule backs off by it)', async () => {
        const p = loadPage({ dbOpts: { failCommit: true } });
        await p.backupNow(true, 'auto');
        await p.backupNow(true, 'auto');
        await p.backupNow(true, 'auto');
        expect(p._wfBackupFailState().n).toBe(3);
        expect(status(p.db).failCount).toBe(3);
    });

    it('returns false when signed out, writes nothing, and says why', async () => {
        const p = loadPage({ signedIn: false });
        expect(await p.backupNow(true, 'auto')).toBe(false);
        expect(p.db.state.writes).toEqual([]);
        expect(p.appData.settings.lastBackupAttempt).toMatchObject({ success: false, reason: 'not signed in' });
    });

    it('is paused in decoy mode: nothing reaches the account, the device stamps or Drive — not even a "paused" status', async () => {
        const p = loadPage({ decoy: true, refresh: 'rt' });
        const before = structuredClone(p.appData);
        expect(await p.backupNow(true, 'auto')).toBe(false);
        expect(p.db.state.writes, 'the decoy vault wrote to the real account').toEqual([]);
        expect(p.appData).toEqual(before);
        expect(p.store.size).toBe(0);
        expect(p.drive.calls).toEqual([]);
        const manual = loadPage({ decoy: true });
        await manual.backupNow(false, 'manual');
        expect(manual.notes.map((n) => n.m).join(' ')).toMatch(/paused while the decoy vault is open/);
        expect(manual.db.state.writes).toEqual([]);
    });

    it('when the backup module did not load, it fails loudly instead of claiming success', async () => {
        const p = loadPage({ noModule: true });
        expect(await p.backupNow(true, 'auto')).toBe(false);
        expect(p.appData.settings.lastBackupAttempt).toMatchObject({ success: false, reason: 'the backup module did not load' });
    });

    it('an account with nothing in it is not a failure, and is not stamped as a backup either', async () => {
        const p = loadPage({ appData: { settings: { autoBackupFreq: 'daily' } } });
        expect(await p.backupNow(true, 'auto')).toBe(false);
        expect(rps(p.db)).toHaveLength(0);
        expect(p.appData.settings.lastBackupAttempt).toMatchObject({ success: true, skipped: true });
        expect(p.appData.settings.lastBackup).toBeUndefined();
        expect(p._getLastBackupMs()).toBe(0);
        expect(p._wfBackupFailState().n).toBe(5);       // look again in hours, not every half minute
        expect(status(p.db)).toMatchObject({ success: true, reason: 'nothing to back up yet' });
        const manual = loadPage({ appData: { settings: {} } });
        await manual.backupNow(false, 'manual');
        expect(manual.notes.map((n) => n.m)).toContain('There is nothing to back up yet.');
    });

    it('is single-flight: the 30-second timer and a tap on the button share one run', async () => {
        const p = loadPage();
        const a = p.backupNow(true, 'auto'), b = p.backupNow(false, 'manual');
        expect(a).toBe(b);
        await Promise.all([a, b]);
        expect(rps(p.db)).toHaveLength(1);
        expect(await p.backupNow(true, 'auto')).toBe(true);     // and the next run is a new one
    });

    it('pressing "Backup Now" ten times does not push the older copies out (identical data is confirmed, not duplicated)', async () => {
        const p = loadPage();
        for (let i = 0; i < 10; i++) await p.backupNow(true, 'manual');
        expect(rps(p.db)).toHaveLength(1);
    });

    it('tells a person who tapped "Backup Now" what happened, in words', async () => {
        const ok = loadPage();
        await ok.backupNow(false, 'manual');
        const done = ok.notes.find((n) => /Backup complete/.test(n.m));
        expect(done.m).toMatch(/Restore point saved/);
        expect(done.kind).toBe('success');
        const bad = loadPage({ dbOpts: { failCommit: true } });
        await bad.backupNow(false, 'manual');
        expect(bad.notes.find((n) => /Backup failed/.test(n.m))).toMatchObject({ kind: 'error' });
    });
});

describe('the old stamps no longer count as a backup', () => {
    it('lastBackup, lastAutoBackupAt and wf_last_auto_backup were written by runs that wrote nothing, so they are ignored', () => {
        const now = Date.now();
        const p = loadPage({ appData: { ...baseData(), settings: { autoBackupFreq: 'daily', lastBackup: new Date(now).toISOString(), lastAutoBackupAt: new Date(now).toISOString() } }, local: { wf_last_auto_backup: String(now) } });
        expect(p._getLastBackupMs(), 'a stamp from the old runs made the account look backed up').toBe(0);
    });
    it('a restore point the SERVER made counts, once the account has been asked', async () => {
        const p = loadPage();
        const payload = B.buildPayload(p.appData);
        const saved = await B.saveSnapshot({ db: p.db, uid: 'u1', payload, trigger: 'server', now: 1760000000000 });
        expect(p._getLastBackupMs()).toBe(0);                // not asked yet
        await p._wfRefreshBackupState(true);
        expect(p._getLastBackupMs()).toBe(saved.atMs);
    });
    it('a verified Drive copy counts; an unverified one does not', () => {
        const at = new Date(1760000000000).toISOString();
        const a = loadPage({ appData: { ...baseData(), settings: { lastDriveBackup: { v: 2, verified: true, at } } } });
        expect(a._getLastBackupMs()).toBe(1760000000000);
        const b = loadPage({ appData: { ...baseData(), settings: { lastDriveBackup: { v: 2, verified: false, at } } } });
        expect(b._getLastBackupMs()).toBe(0);
    });
});

describe('Google Drive, from the page', () => {
    it('a person who never connected Drive is never sent to Google', async () => {
        const p = loadPage();
        await p.backupNow(true, 'auto');
        expect(p.drive.calls).toEqual([]);
        expect(p.env.mintCalls).toBe(0);
    });

    it('a connected account gets a VERIFIED file in its own folder, remembered as v2', async () => {
        const p = loadPage({ refresh: 'refresh-token' });
        expect(await p.backupNow(true, 'auto')).toBe(true);
        const files = [...p.drive.files.values()];
        const folder = files.find((f) => f.mimeType === 'application/vnd.google-apps.folder');
        const file = files.find((f) => f.name.startsWith('WealthFlow_'));
        expect(folder.parents).toEqual(['root']);
        expect(file.parents).toEqual([folder.id]);
        expect(file.name).toMatch(/^WealthFlow_owner@example\.lk_u1_/);
        const ld = p.appData.settings.lastDriveBackup;
        expect(ld).toMatchObject({ v: 2, verified: true, fileId: file.id, folderId: folder.id });
        expect(p.appData.settings.lastBackupMeta).toMatchObject({ cloud: true, drive: true });
        expect(status(p.db).drive).toMatchObject({ ok: true, folderId: folder.id });
        expect(rps(p.db)[0].drive).toMatchObject({ ok: true });
    });

    it('an hour-old token in memory is replaced after the 401 instead of the night\'s copy being lost', async () => {
        const p = loadPage({ refresh: 'rt', gapiToken: 'stale', local: { wf_drive_token: JSON.stringify({ expiry: Date.now() + 3600000 }) }, mint: 'good' });
        expect(await p.backupNow(true, 'auto')).toBe(true);
        const uploads = p.drive.calls.filter((c) => c.method === 'POST' && /upload/.test(c.url));
        expect(uploads.length).toBeGreaterThanOrEqual(1);
        expect(p.appData.settings.lastDriveBackup.verified, 'the 401 was swallowed, as before').toBe(true);
        expect(p.env.mintCalls).toBeGreaterThanOrEqual(1);
        expect(p.getGapiToken()).toBe('good');
    });

    it('when Drive cannot be reached the restore point still counts, and the card and the toast say what to do', async () => {
        const p = loadPage({ refresh: 'revoked', mint: null });
        expect(await p.backupNow(false, 'manual')).toBe(true);
        expect(p.appData.settings.lastBackupMeta).toMatchObject({ cloud: true, drive: false });
        expect(status(p.db).drive).toMatchObject({ ok: false, reason: 'token-expired' });
        const t = p.notes.find((n) => /Backup complete/.test(n.m));
        expect(t.kind).toBe('warn');
        expect(t.m).toMatch(/Reconnect Google Drive/);
        expect(p.drive.files.size).toBe(0);
    });

    it('Drive alone is a backup when the account cannot take a restore point', async () => {
        const p = loadPage({ refresh: 'rt', dbOpts: { failCommit: true } });
        expect(await p.backupNow(true, 'auto')).toBe(true);
        expect(p.appData.settings.lastBackupMeta).toMatchObject({ cloud: false, drive: true });
        expect(p.appData.settings.lastBackupAttempt).toMatchObject({ success: true, cloud: false, drive: true });
    });

    it('with neither a restore point nor a Drive file it is a failure, with the Drive reason too', async () => {
        const p = loadPage({ refresh: 'rt', mint: null, dbOpts: { failCommit: true } });
        expect(await p.backupNow(true, 'auto')).toBe(false);
        expect(p.appData.settings.lastBackupAttempt.success).toBe(false);
    });

    it('a Drive file never carries the Drive credential that lives on the same document', async () => {
        const p = loadPage({ refresh: 'rt', appData: { ...baseData(), driveRefresh: { token: 'SECRET-REFRESH' }, driveBridge: { token: 'SECRET-BRIDGE' } } });
        await p.backupNow(true, 'auto');
        const file = [...p.drive.files.values()].find((f) => f.name.startsWith('WealthFlow_'));
        expect(file.text).not.toMatch(/SECRET-/);
        expect(p.db.store.get('users/u1/backupData/' + rps(p.db)[0].id).data).not.toMatch(/SECRET-/);
    });

    it('executeDriveBackup ("Backup to Drive") is true only for a verified file', async () => {
        const ok = loadPage({ refresh: 'rt' });
        expect(await ok.executeDriveBackup()).toBe(true);
        expect(ok.appData.settings.lastBackupMeta).toMatchObject({ drive: true, cloud: false, trigger: 'drive' });
        const quota = loadPage({ refresh: 'rt', drive: makeDrive({ valid: 'good', quota: true }) });
        expect(await quota.executeDriveBackup()).toBe(false);
        expect(quota.appData.settings.lastBackupMeta).toBeUndefined();
        const truncating = loadPage({ refresh: 'rt', drive: makeDrive({ valid: 'good', truncate: true }) });
        expect(await truncating.executeDriveBackup(), 'a truncated upload was called verified').toBe(false);
        const empty = loadPage({ refresh: 'rt', appData: { settings: {} } });
        expect(await empty.executeDriveBackup()).toBe(false);
        expect(empty.drive.calls).toEqual([]);
        expect(await loadPage({ refresh: 'rt', decoy: true }).executeDriveBackup()).toBe(false);
    });
});

describe('the Settings card says what is true now', () => {
    it('before any backup it says so, and after a good one it names the restore point and who made it', async () => {
        const p = loadPage();
        expect(p._wfBackupInfoHtml(p.appData.settings)).toMatch(/No backup yet/);
        await p.backupNow(true, 'auto');
        await p._wfRefreshBackupState(true);
        const html = p._wfBackupInfoHtml(p.appData.settings);
        expect(html).toMatch(/Restore point/);
        expect(html).toMatch(/Auto/);
        expect(html).not.toMatch(/No backup yet/);
    });
    it('a failure is shown in plain words with its reason, not hidden behind an older success', async () => {
        const p = loadPage();
        await p.backupNow(true, 'auto');
        p.db.state.failCommit = true;
        const d = p.appData.expenses; d.push({ id: 'new', amount: 1 });
        await p.backupNow(true, 'auto');
        await p._wfRefreshBackupState(true);
        expect(p._wfBackupInfoHtml(p.appData.settings)).toMatch(/last attempt failed/);
    });
    it('a copy the server made while the page was closed is shown, with no stamp on this device', async () => {
        const p = loadPage();
        await B.saveSnapshot({ db: p.db, uid: 'u1', payload: B.buildPayload(p.appData), trigger: 'server', now: Date.now() - 3600000 });
        await B.writeStatus({ db: p.db, uid: 'u1', status: { atMs: Date.now() - 3600000, success: true, by: 'server', trigger: 'server', failCount: 0 } });
        await p._wfRefreshBackupState(true);
        const html = p._wfBackupInfoHtml(p.appData.settings);
        expect(html).toMatch(/Restore point/);
        expect(html).toMatch(/hour ago/);
        expect(html).toMatch(/Auto/);
    });
});

/* ------------------------------------------------------------------ the restore list */

describe('the restore list shows every copy there is', () => {
    it('lists restore points without any Google sign-in, newest first, and says Drive is not connected', async () => {
        const p = loadPage();
        const payload = B.buildPayload(p.appData);
        await B.saveSnapshot({ db: p.db, uid: 'u1', payload, trigger: 'auto', now: 1760000000000 });
        await B.saveSnapshot({ db: p.db, uid: 'u1', payload: B.buildPayload({ ...p.appData, income: [] }), trigger: 'server', now: 1760086400000 });
        await p.fetchRestoreList();
        const sel = p.elements.restoreSelect;
        const opts = sel.children.flatMap((g) => g.children);
        expect(opts).toHaveLength(2);
        expect(p.elements.restoreBtn.disabled).toBe(false);
        expect(p.elements.restoreHint.textContent).toMatch(/Google Drive is not connected/);
        expect(p.elements.restoreConnectBtn.style.display).toBe('');
        expect(p.drive.calls).toEqual([]);
        expect(opts[0].textContent).toMatch(/automatic/);
    });
    it('adds the files from the person\'s own Drive when it is connected, and hides the connect button', async () => {
        const p = loadPage({ refresh: 'rt' });
        await p.backupNow(true, 'auto');
        await p.fetchRestoreList();
        const groups = p.elements.restoreSelect.children;
        expect(groups.map((g) => g.label)).toEqual(['Restore points in your account', 'Google Drive']);
        expect(p.elements.restoreConnectBtn.style.display).toBe('none');
    });
    it('says "No copies found" and keeps Restore disabled when there are none', async () => {
        const p = loadPage();
        await p.fetchRestoreList();
        expect(p.elements.restoreBtn.disabled).toBe(true);
        expect(p.elements.restoreSelect.children[0].textContent).toBe('No copies found');
    });
    it('reports a restore-point read failure instead of showing an empty list as if nothing existed', async () => {
        const p = loadPage();
        await p.backupNow(true, 'auto');
        p.db.state.failGet = true;
        await p.fetchRestoreList();
        expect(p.elements.restoreHint.textContent).toMatch(/Restore points could not be read/);
    });
});

/* ------------------------------------------------------------------ restore */

const restoredFile = () => ({
    expenses: [{ id: 'old1', amount: 1 }],
    income: [],
    settings: { currency: 'USD', autoBackupFreq: 'weekly', lastBackupMeta: { v: 2, at: 'THEIRS' } },
    auth: { pin: 'PIN-HASH-OLD' },
    driveRefresh: { token: 'FILE-REFRESH' },
    driveBridge: { token: 'FILE-BRIDGE' },
    _wipedAt: 1,
});

describe('restore: a copy of what is here comes first, and nothing is replaced if that cannot be saved', () => {
    it('saves a "pre-restore" safety copy BEFORE it replaces anything, and the way back loads', async () => {
        const p = loadPage();
        const before = structuredClone(p.appData);
        await p._wfApplyRestore(restoredFile(), 'the copy from today');
        expect(p.snapshotsAtSet[0], 'the account document was replaced before the safety copy existed').toEqual(['pre-restore']);
        expect(p.calls.indexOf('batch.commit')).toBeLessThan(p.calls.indexOf('users.set'));
        const safety = rps(p.db).find((r) => r.trigger === 'pre-restore');
        const back = await loadSnapshot({ db: p.db, uid: 'u1', id: safety.id });
        expect(back.ok).toBe(true);
        expect(back.data.expenses).toEqual(before.expenses);
        expect(p.getAppData().expenses).toEqual([{ id: 'old1', amount: 1 }]);
    });

    it('keeps this account\'s PIN, Drive link and backup settings; never writes the file\'s credentials in', async () => {
        const p = loadPage({ appData: { ...baseData(), driveRefresh: { token: 'MINE' }, settings: { currency: 'LKR', autoBackupFreq: 'daily', lastBackupMeta: { v: 2, at: 'MINE' }, lastDriveBackup: { v: 2, verified: true } } } });
        await p._wfApplyRestore(restoredFile(), 'x');
        const a = p.getAppData();
        expect(a.auth.pin, 'the PIN of the copy replaced the one in use').toBe('PIN-HASH-A');
        expect(a.driveRefresh).toEqual({ token: 'MINE' });
        expect(a.driveBridge).toBeUndefined();
        expect(a.settings.currency).toBe('USD');                         // data restored
        expect(a.settings.autoBackupFreq).toBe('daily');                  // schedule kept
        expect(a.settings.lastBackupMeta).toEqual({ v: 2, at: 'MINE' });
        expect(a.settings.lastDriveBackup).toEqual({ v: 2, verified: true });
    });

    it('announces itself like a factory reset (_wipedAt/_wipedAck), so a second device adopts it once instead of merging it away', async () => {
        const p = loadPage();
        await p._wfApplyRestore(restoredFile(), 'x');
        const a = p.getAppData();
        expect(a._wipedAt).toBeGreaterThan(1);
        expect(a._wipedAck).toBe(a._wipedAt);
        expect(p.store.get('wf2__wipedAck')).toBe(String(a._wipedAt));
        expect(p.db.store.get('users/u1')._wipedAt).toBe(a._wipedAt);
        expect(p.calls).toContain('setDirty:false');
        expect(p.timers.length).toBe(1);                                 // the reload
    });

    it('refuses without changing anything when the safety copy cannot be saved', async () => {
        const p = loadPage({ dbOpts: { failCommit: true } });
        const before = structuredClone(p.appData);
        await p._wfApplyRestore(restoredFile(), 'x');
        expect(p.getAppData()).toEqual(before);
        expect(p.calls).not.toContain('users.set');
        const n = p.notes.find((x) => x.kind === 'error');
        expect(n.m).toMatch(/safety copy of your current data could not be saved/);
        expect(n.m).toMatch(/Nothing was changed/);
        expect(p.timers).toHaveLength(0);
    });

    it('falls back to a verified Drive copy as the safety copy when the account cannot take one', async () => {
        const p = loadPage({ refresh: 'rt', dbOpts: { failCommit: true } });
        await p._wfApplyRestore(restoredFile(), 'x');
        expect(p.getAppData().expenses).toEqual([{ id: 'old1', amount: 1 }]);
        const f = [...p.drive.files.values()].find((x) => x.name.startsWith('WealthFlow_'));
        expect(JSON.parse(f.text).expenses).toHaveLength(3);
    });

    it('refuses something that is not a WealthFlow backup before touching anything, not even writing a safety copy', async () => {
        for (const bad of [{}, [], { hello: 'world' }, { expenses: 'nope' }, null, 'text']) {
            const p = loadPage();
            const before = structuredClone(p.appData);
            await p._wfApplyRestore(bad, 'x');
            expect(p.getAppData()).toEqual(before);
            expect(p.db.state.writes).toEqual([]);
            expect(p.notes.find((n) => n.kind === 'error').m).toMatch(/Nothing was changed/);
        }
    });

    it('is not available in decoy mode or when signed out', async () => {
        for (const o of [{ decoy: true }, { signedIn: false }]) {
            const p = loadPage(o);
            const before = structuredClone(p.appData);
            await p._wfApplyRestore(restoredFile(), 'x');
            expect(p.getAppData()).toEqual(before);
            expect(p.db.state.writes).toEqual([]);
        }
    });

    it('the account keeps what is not data: the Drive link the server copies with, and the list of devices the owner signed out', async () => {
        const cloudDoc = { driveRefresh: { token: 'MINE' }, driveBridge: { token: 'BR', expiry: 9 }, revokedSessions: ['A', 'B'], lastRevokeAt: 77, expenses: [] };
        const p = loadPage({ cloudDoc, appData: { ...baseData(), revokedSessions: ['A'] } });
        await p._wfApplyRestore({ ...restoredFile(), revokedSessions: ['A'], lastRevokeAt: 1 }, 'x');
        const doc = p.db.store.get('users/u1');
        expect(doc.driveRefresh, 'a restore deleted the Drive link, so the nightly server copy to Drive stops without a word').toEqual({ token: 'MINE' });
        expect(doc.driveBridge).toEqual({ token: 'BR', expiry: 9 });
        expect(doc.revokedSessions, 'a restore put a device the owner had signed out back on the list of allowed ones').toEqual(['A', 'B']);
        expect(doc.lastRevokeAt).toBe(77);
        expect(doc.expenses).toEqual([{ id: 'old1', amount: 1 }]);
    });

    it('changes nothing when the account document cannot be read first', async () => {
        const p = loadPage({ userGetFails: true });
        const before = structuredClone(p.appData);
        await p._wfApplyRestore(restoredFile(), 'x');
        expect(p.getAppData()).toEqual(before);
        expect(p.calls).not.toContain('users.set');
        expect(p.notes.find((n) => n.kind === 'error').m).toMatch(/account could not be read[\s\S]*Nothing was changed/);
        expect(p.timers).toHaveLength(0);
    });

    it('when saving the restored data to the account fails, nothing is restored: not here, not half-way, and the retry cannot merge it back', async () => {
        const p = loadPage({ userSetFails: true });
        const before = structuredClone(p.appData);
        await p._wfApplyRestore(restoredFile(), 'x');
        expect(p.getAppData(), 'the data was replaced here although the account never took it; the sync would then merge the two into 500 + 3 records').toEqual(before);
        expect(p.calls).not.toContain('setDirty:true');
        expect(p.store.get('wf2_expenses')).toBeUndefined();
        expect(p.store.get('wf2__wipedAck')).toBeUndefined();
        expect(p.timers, 'it reloaded the page').toHaveLength(0);
        const n = p.notes.find((x) => x.kind === 'error');
        expect(n.m).toMatch(/Nothing was changed/);
        expect(n.m).toMatch(/restore point/);
        const safety = rps(p.db).find((r) => r.trigger === 'pre-restore');
        expect((await loadSnapshot({ db: p.db, uid: 'u1', id: safety.id })).data.expenses).toEqual(before.expenses);
    });
});

describe('executeRestoreSelected: the copy is read and proven before anything is offered', () => {
    async function withPoint(p, over) {
        const saved = await B.saveSnapshot({ db: p.db, uid: 'u1', payload: B.buildPayload({ expenses: [{ id: 'x', amount: 7 }], income: [], settings: {} }), trigger: 'auto', now: 1760000000000 });
        p.setRestoreItems([{ key: 'rp:' + saved.id, kind: 'rp', atMs: saved.atMs, records: 1, trigger: 'auto', ...(over || {}) }]);
        p.elements.restoreSelect.value = 'rp:' + saved.id;
        return saved;
    }
    it('asks for confirmation and replaces NOTHING until it is given', async () => {
        const p = loadPage();
        await withPoint(p);
        const before = structuredClone(p.appData);
        await p.executeRestoreSelected();
        expect(p.confirms).toHaveLength(1);
        expect(p.confirms[0][1]).toMatch(/Replace your data with/);
        expect(p.confirms[0][2]).toMatch(/saved as a restore point first/);
        expect(p.getAppData()).toEqual(before);
        expect(p.calls).not.toContain('users.set');
        p.confirms[0][5]();                             // the person presses "Restore"
        await vi.waitFor(() => expect(p.getAppData().expenses).toEqual([{ id: 'x', amount: 7 }]));
        expect(rps(p.db).some((r) => r.trigger === 'pre-restore')).toBe(true);
    });
    it('refuses a restore point whose data was damaged (SHA-256 mismatch) and changes nothing', async () => {
        const p = loadPage();
        const saved = await withPoint(p);
        const row = p.db.store.get('users/u1/backupData/' + saved.id);
        row.data = row.data.replace('"amount":7', '"amount":9');
        const before = structuredClone(p.appData);
        await p.executeRestoreSelected();
        expect(p.confirms).toHaveLength(0);
        expect(p.getAppData()).toEqual(before);
        expect(p.notes.find((n) => n.kind === 'error').m).toMatch(/Restore failed.*Nothing was changed/);
    });
    it('reads a Google Drive copy, mints a new token when the one in hand expired, and proves the file before offering it', async () => {
        const p = loadPage({ refresh: 'rt', gapiToken: 'stale', local: { wf_drive_token: JSON.stringify({ expiry: Date.now() + 3600000 }) } });
        await p.backupNow(true, 'auto');                  // creates a Drive file
        const file = [...p.drive.files.values()].find((f) => f.name.startsWith('WealthFlow_'));
        p.setGapiToken('stale');
        p.setRestoreItems([{ key: 'drive:' + file.id, kind: 'drive', atMs: 1760000000000, size: file.size, file: { id: file.id, size: String(file.size), appProperties: file.appProperties } }]);
        p.elements.restoreSelect.value = 'drive:' + file.id;
        await p.executeRestoreSelected();
        expect(p.confirms).toHaveLength(1);
    });
    it('refuses a truncated Drive file', async () => {
        const p = loadPage({ refresh: 'rt' });
        await p.backupNow(true, 'auto');
        const file = [...p.drive.files.values()].find((f) => f.name.startsWith('WealthFlow_'));
        file.text = file.text.slice(0, -20);
        p.setRestoreItems([{ key: 'drive:' + file.id, kind: 'drive', atMs: 1, file: { id: file.id, size: String(file.size), appProperties: file.appProperties } }]);
        p.elements.restoreSelect.value = 'drive:' + file.id;
        await p.executeRestoreSelected();
        expect(p.confirms).toHaveLength(0);
        expect(p.notes.find((n) => n.kind === 'error').m).toMatch(/different size|damaged/);
    });
    it('does nothing for an empty selection, and runs once if tapped twice', async () => {
        const p = loadPage();
        await p.executeRestoreSelected();
        expect(p.notes).toHaveLength(0);
        await withPoint(p);
        await Promise.all([p.executeRestoreSelected(), p.executeRestoreSelected()]);
        expect(p.confirms).toHaveLength(1);
    });
});

describe('"Delete all restore points" is the person\'s own, and says what it did', () => {
    it('asks first, deletes only the restore points, clears the stamps that claimed a backup, and keeps the Drive file and the live data', async () => {
        const p = loadPage({ refresh: 'rt' });
        await p.backupNow(true, 'auto');
        await p._wfRefreshBackupState(true);
        expect(p._wfBackupInfoHtml(p.appData.settings)).not.toMatch(/No backup yet/);
        const live = structuredClone(p.appData.expenses);
        p.deleteAllRestorePoints();
        expect(p.confirms).toHaveLength(1);
        expect(p.confirms[0][1]).toMatch(/Delete all restore points/);
        expect(rps(p.db)).toHaveLength(1);                         // nothing deleted until the person confirms
        p.confirms[0][5]();
        await vi.waitFor(() => expect(rps(p.db)).toHaveLength(0));
        expect(p.notes.map((n) => n.m).join(' ')).toMatch(/Deleted 1 restore point\./);
        const s = p.appData.settings;
        expect([s.lastBackup, s.lastAutoBackupAt, s.lastBackupMeta, s.lastBackupAttempt]).toEqual([undefined, undefined, undefined, undefined]);
        expect(s.lastDriveBackup.verified).toBe(true);              // that file still exists in their Drive
        expect([...p.drive.files.values()].some((f) => f.name.startsWith('WealthFlow_'))).toBe(true);
        expect(p.appData.expenses).toEqual(live);
        expect(status(p.db)).toBeUndefined();
        expect(p._wfBackupInfoHtml(s)).not.toMatch(/Restore point/);
    });
    it('removes the stamps from the ACCOUNT too: the settings merge can add a key but never take one away, so a local delete alone comes straight back', async () => {
        const p = loadPage();
        await p.backupNow(true, 'auto');
        expect(await p._wfDeleteRestorePoints()).toBe(true);
        expect(p.env.cloudDeletes.sort()).toEqual(['settings.lastAutoBackupAt', 'settings.lastBackup', 'settings.lastBackupAttempt', 'settings.lastBackupMeta']);
    });
    it('with no Drive file either, the card goes back to "No backup yet" instead of claiming one', async () => {
        const p = loadPage();
        await p.backupNow(true, 'auto');
        await p._wfRefreshBackupState(true);
        expect(await p._wfDeleteRestorePoints()).toBe(true);
        expect(p._wfBackupInfoHtml(p.appData.settings)).toMatch(/No backup yet/);
        expect(p._getLastBackupMs()).toBe(0);
    });
    it('reports a failure in words and leaves the stamps alone when nothing was deleted', async () => {
        const p = loadPage();
        await p.backupNow(true, 'auto');
        p.db.state.failCommit = true;
        expect(await p._wfDeleteRestorePoints()).toBe(false);
        expect(rps(p.db)).toHaveLength(1);
        expect(p.appData.settings.lastBackupMeta).toBeTruthy();
        expect(p.notes.find((n) => n.kind === 'error').m).toMatch(/Could not delete every restore point \(permission-denied\); 0 deleted/);
    });
    it('is refused in decoy mode and when signed out', async () => {
        for (const o of [{ decoy: true }, { signedIn: false }]) {
            const p = loadPage(o);
            expect(await p._wfDeleteRestorePoints()).toBe(false);
            expect(p.db.state.writes).toEqual([]);
        }
    });
});

/* ------------------------------------------------------------------ the wipe */

describe('factory reset keeps a way back', () => {
    const pinAndGo = (p) => { p.elements.fr_pin.value = '123456'; p.appData.auth = { pin: 'HASH(123456wf_salt_sg2026)' }; return p.executeFactoryReset(); };
    it('refuses in decoy mode and on a wrong PIN, touching nothing', async () => {
        const d = loadPage({ decoy: true });
        await pinAndGo(d);
        expect(d.db.state.writes).toEqual([]);
        const w = loadPage();
        w.elements.fr_pin.value = '000000';
        await w.executeFactoryReset();
        expect(w.db.state.writes).toEqual([]);
        expect(w.elements.fr_err.textContent).toMatch(/Incorrect PIN/);
    });
    it('does NOT erase anything when the safety copy cannot be saved', async () => {
        const p = loadPage({ dbOpts: { failCommit: true } });
        const before = structuredClone(p.appData);
        await pinAndGo(p);
        expect(p.elements.fr_err.textContent).toMatch(/Nothing was erased/);
        expect(p.getAppData().expenses, 'the data was wiped with no copy anywhere').toEqual(before.expenses);
        expect(p.calls).not.toContain('users.set');
        expect(p.calls).not.toContain('localStorage.clear');
        expect(p.elements.fr_success.style.display).not.toBe('block');
    });
    it('keeps the Drive link and the signed-out devices list on the account, as a restore does', async () => {
        const cloudDoc = { driveRefresh: { token: 'MINE' }, driveBridge: { token: 'BR' }, revokedSessions: ['A', 'B'], lastRevokeAt: 77, expenses: [{ id: 'x' }] };
        const p = loadPage({ cloudDoc });
        await pinAndGo(p);
        const doc = p.db.store.get('users/u1');
        expect(doc.expenses).toEqual([]);
        expect(doc.driveRefresh).toEqual({ token: 'MINE' });
        expect(doc.driveBridge).toEqual({ token: 'BR' });
        expect(doc.revokedSessions, 'a reset let a device the owner had signed out back in').toEqual(['A', 'B']);
        expect(doc.lastRevokeAt).toBe(77);
    });
    it('does NOT erase anything when the account document cannot be read first', async () => {
        const p = loadPage({ userGetFails: true });
        const before = structuredClone(p.appData);
        await pinAndGo(p);
        expect(p.elements.fr_err.textContent).toMatch(/Nothing was erased/);
        expect(p.getAppData().expenses).toEqual(before.expenses);
        expect(p.calls).not.toContain('users.set');
        expect(p.calls).not.toContain('localStorage.clear');
    });
    it('saves a "pre-wipe" copy first; after the wipe that copy still loads with everything in it', async () => {
        const p = loadPage();
        const before = structuredClone(p.appData);
        await pinAndGo(p);
        expect(p.snapshotsAtSet[0], 'the wipe reached the account before the safety copy existed').toEqual(['pre-wipe']);
        expect(p.getAppData().expenses).toEqual([]);
        expect(p.calls).toContain('localStorage.clear');
        const safety = rps(p.db).find((r) => r.trigger === 'pre-wipe');
        const back = await loadSnapshot({ db: p.db, uid: 'u1', id: safety.id });
        expect(back.ok).toBe(true);
        expect(back.data.expenses).toEqual(before.expenses);
        expect(back.data.income).toEqual(before.income);
    });
});

/* ------------------------------------------------------------------ the scheduler */

/** Local time, because the page's schedule is "23:55 on this device". */
const local = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

/** The three nodes the card and the schedule line paint into, and a section that can hold the line. */
function makeSettingsDom() {
    const section = { line: null, querySelector: (sel) => (sel === '.backup-schedule' ? section.line : null), appendChild: (el) => { section.line = el; return el; } };
    const info = { innerHTML: '', closest: (sel) => (sel === '.settings-section' ? section : null) };
    const icon = { innerHTML: '' };
    const document = {
        getElementById: (id) => (id === 'wfBackupInfo' ? info : id === 'wfBackupIcon' ? icon : null),
        createElement: () => ({ className: '', innerHTML: '', remove() { section.line = null; } }),
    };
    return { document, section, info, icon };
}

describe('the scheduler runs the rule, not a stamp', () => {
    const pin = (ms) => vi.useFakeTimers({ toFake: ['Date'], now: ms });
    const justAfter = local(2026, 10, 19, 23, 56);

    it('does nothing while the schedule is off, in decoy mode, or without the module', async () => {
        pin(justAfter);
        for (const o of [{ appData: { ...baseData(), settings: { autoBackupFreq: 'off' } } }, { decoy: true }, { noModule: true }]) {
            const p = loadPage(o);
            await p._checkAutoBackupDue();
            expect(p.db.state.writes).toEqual([]);
        }
    });

    it('a due run repaints the card and the "Next auto-backup" line in place, and never rebuilds the Settings panel', async () => {
        pin(justAfter);
        const dom = makeSettingsDom();
        const p = loadPage({ settingsDom: dom });
        await p._checkAutoBackupDue();
        expect(rps(p.db)).toHaveLength(1);
        expect(p.calls, 'renderSettings() rebuilds the whole panel under whoever is using it; the card repaints itself').not.toContain('renderSettings');
        expect(dom.info.innerHTML).toMatch(/Last Backup/);
        expect(dom.section.line.className).toBe('backup-schedule');
        expect(dom.section.line.innerHTML).toMatch(/Next auto-backup: /);
    });

    it('changing the schedule paints the "Next auto-backup" line in place: shown when on, gone when off, nothing rebuilt', () => {
        pin(justAfter);
        const dom = makeSettingsDom();
        const p = loadPage({ settingsDom: dom, appData: { ...baseData(), settings: { autoBackupFreq: 'off' } } });
        p._wfPaintBackupCard();
        expect(dom.section.line).toBe(null);
        p.getAppData().settings.autoBackupFreq = 'weekly';
        p._wfPaintBackupCard();
        expect(dom.section.line.innerHTML).toMatch(/Next auto-backup: /);
        p.getAppData().settings.autoBackupFreq = 'off';
        p._wfPaintBackupCard();
        expect(dom.section.line).toBe(null);
        expect(p.calls).not.toContain('renderSettings');
    });

    it('makes the night\'s restore point when none exists, and tells the person once', async () => {
        pin(justAfter);
        const p = loadPage();
        await p._checkAutoBackupDue();
        expect(rps(p.db)).toHaveLength(1);
        expect(rps(p.db)[0].trigger).toBe('auto');
        expect(p.smart.map((a) => a[0]).join(' ')).toMatch(/Auto-Backup Complete/);
    });

    it('does not repeat a night that another device or the server already covered, whatever this device remembers', async () => {
        pin(justAfter);
        const p = loadPage();
        await B.saveSnapshot({ db: p.db, uid: 'u1', payload: B.buildPayload(p.appData), trigger: 'server', now: local(2026, 10, 19, 23, 56, 0) - 30000 });
        p.db.state.writes.length = 0;
        await p._checkAutoBackupDue();
        expect(p.db.state.writes, 'the page made a second copy of a night the server had done').toEqual([]);
        expect(p.smart).toHaveLength(0);
    });

    it('catches up on reopening when the 23:55 trigger was missed', async () => {
        pin(local(2026, 10, 20, 9, 0));
        const p = loadPage();
        await B.saveSnapshot({ db: p.db, uid: 'u1', payload: B.buildPayload({ expenses: [{ id: 'older' }] }), trigger: 'auto', now: local(2026, 10, 18, 23, 57) });
        await p._checkAutoBackupDue();
        expect(rps(p.db)).toHaveLength(2);
    });

    it('a failed run is not retried for five minutes, then again, and the person is told once per streak', async () => {
        pin(justAfter);
        const p = loadPage({ dbOpts: { failCommit: true } });
        await p._checkAutoBackupDue();
        expect(p._wfBackupFailState().n).toBe(1);
        expect(p.notes.filter((n) => n.kind === 'warn' && /could not save a copy/.test(n.m))).toHaveLength(1);
        p.calls.length = 0;
        pin(justAfter + 60 * 1000);                          // the 30-second timer fires again: too soon
        await p._checkAutoBackupDue();
        expect(p.calls).not.toContain('batch.commit');
        pin(justAfter + 6 * 60 * 1000);
        await p._checkAutoBackupDue();
        expect(p.calls).toContain('batch.commit');
        expect(p._wfBackupFailState().n).toBe(2);
        expect(p.notes.filter((n) => /could not save a copy/.test(n.m)), 'told again on every retry').toHaveLength(1);
    });

    it('offline: no run, and the service worker is asked to wake the page when the network returns', async () => {
        pin(justAfter);
        const p = loadPage({ onLine: false });
        await p._checkAutoBackupDue();
        expect(p.db.state.writes).toEqual([]);
        expect(p.calls).toContain('sync.register');
    });

    it('a cold start that has not signed in yet waits for it instead of giving up, then runs', async () => {
        vi.useFakeTimers({ now: justAfter });
        const p = loadPage({ realTimers: true });
        const user = p.win.currentUser;
        p.win.currentUser = null;
        const run = p._checkAutoBackupDue();
        await vi.advanceTimersByTimeAsync(2000);
        expect(rps(p.db)).toHaveLength(0);                      // still waiting, not given up and not writing
        p.win.currentUser = user;                               // sign-in lands
        await vi.advanceTimersByTimeAsync(1000);
        await run;
        await vi.waitFor(() => expect(rps(p.db)).toHaveLength(1));
    });

    it('gives up after a few seconds if sign-in never lands, writes nothing, and can wait again on the next tick', async () => {
        vi.useFakeTimers({ now: justAfter });
        const p = loadPage({ realTimers: true });
        const user = p.win.currentUser;
        p.win.currentUser = null;
        const first = p._checkAutoBackupDue();
        await vi.advanceTimersByTimeAsync(9000);
        await first;
        expect(p.db.state.writes).toEqual([]);
        p.win.currentUser = user;
        await p._checkAutoBackupDue();
        await vi.waitFor(() => expect(rps(p.db)).toHaveLength(1));
    });
});

/* ------------------------------------------------------------------ the retired paths stay retired */

describe('the retired paths stay retired', () => {
    it('the service worker no longer posts a staged copy of the live data to Firestore, and no longer holds one in Cache Storage', () => {
        const fn = SW.slice(SW.indexOf('_runAutoBackupFromSW'));
        expect(SW).not.toMatch(/firestore\.googleapis\.com/);
        expect(fn).not.toMatch(/\bfetch\s*\(/);
        expect(HTML).not.toMatch(/_writePendingBackupSnapshotToSW/);
        expect(HTML).toMatch(/caches\.delete\('wf-backup-cache'\)/);
    });
    it('no backup is addressed to the shared developer folder that anyone could edit', () => {
        expect(HTML).not.toMatch(/12_UYwPaxvjNf5oqtW02QAlYAuJJTNO52/);
        expect(SW).not.toMatch(/12_UYwPaxvjNf5oqtW02QAlYAuJJTNO52/);
        expect(fs.readFileSync(path.join(ROOT, 'wealthflow-backup.js'), 'utf8')).not.toMatch(/12_UYwPaxvjNf5oqtW02QAlYAuJJTNO52/);
    });
    it('the backup module is loaded by the page, and the cron that covers closed-app nights is registered', () => {
        expect(HTML).toMatch(/<script[^>]+src="wealthflow-backup\.js"/);
        const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
        const paths = (vercel.crons || []).map((c) => c.path);
        expect(paths.filter((x) => x === '/api/backup-sweep')).toHaveLength(2);
        const router = fs.readFileSync(path.join(ROOT, 'api/router.js'), 'utf8');
        expect(router).toMatch(/'backup-sweep':\s*\(\)\s*=>\s*import\('\.\.\/backup-sweep\.js'\)/);
    });
});
