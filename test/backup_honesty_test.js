/* =============================================================================
 * test/backup_honesty_test.js — a backup that did not happen must not report
 * that it did
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * "Auto-Backup Schedule and thats auto backup is not working."
 *
 * The schedule was running the whole time. scheduleAutoBackup() is called at
 * launch, the 30-second timer fires, _checkAutoBackupDue() computes the right
 * trigger time and calls backupNow() — and backupNow() reported success no
 * matter what happened, because of this:
 *
 *     try {
 *         setDirty(true);
 *         if (typeof syncToCloud === 'function') {
 *             await Promise.resolve(syncToCloud());
 *         }
 *         cloudOk = true;              // ← unconditional
 *     } catch (ce) { … }
 *
 * syncToCloud() returned undefined in every path. It returns BEFORE the write in
 * three of them — no user document, offline, nothing dirty — and when it does
 * write, it does so fire-and-forget with a .catch() that swallows the failure.
 * So `await Promise.resolve(undefined)` resolved instantly, before Firestore had
 * been asked anything, and `cloudOk = true` was reached whether the user was
 * signed out, offline, or the write had been rejected.
 *
 * Everything downstream then behaved correctly on a false premise: the success
 * timestamp was stamped, "Auto-Backup Complete" was pushed to the phone, and the
 * status card said the data was safe. Nothing looked broken, which is why this
 * survived — the only symptom available to the user was that the backups were
 * not there.
 *
 * This is the same defect as the statement reader reporting on a document it had
 * never rendered: a component answering confidently about work it never did.
 *
 * WHY THE TESTS RUN THE REAL SOURCE
 *
 * These two functions live inline in index.html. Asserting on their text would
 * re-check the spelling of the fix rather than its behaviour, so the source is
 * extracted and EXECUTED against fakes — a Firestore that rejects, a signed-out
 * user, an offline device — and the return value is what is asserted.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

const DEPS = [
    'userDocRef', 'navigator', 'setSyncStatus', 'isDirty', '_flushCloudDeletes', 'appData',
    'firebase', 'currentUser', '_getDeviceId', 'setDirty', 'console', 'notify', 'triggerHaptic',
    'DB', 'gapiToken', 'localStorage', 'tokenClient', 'window', 'executeDriveBackup',
    '_wfTotalRecordCount', '_writePendingBackupSnapshotToSW', '_wfDriveAuthPhase',
    'document', 'renderSettings',
];

/* Both functions in ONE scope, exactly as they are in the page, so they share
 * the real _lastCloudPushError binding rather than a copy the test invented. */
function load(over = {}) {
    const settings = {};
    const store = new Map();
    const env = {
        userDocRef: over.userDocRef !== undefined ? over.userDocRef : { set: () => Promise.resolve() },
        navigator: { onLine: over.onLine !== false },
        setSyncStatus: () => {},
        isDirty: over.isDirty !== undefined ? over.isDirty : true,
        _flushCloudDeletes: () => {},
        appData: { expenses: [] },
        firebase: { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } },
        currentUser: over.signedIn === false ? null : { uid: 'u1', email: 'a@b.c' },
        _getDeviceId: () => 'dev1',
        setDirty: () => {},
        console: { log() {}, warn() {}, error() {} },
        notify: () => {},
        triggerHaptic: () => {},
        DB: {
            getObj: () => settings,
            set: (k, v) => { if (k === 'settings') Object.assign(settings, v); },
        },
        gapiToken: null,
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
        },
        tokenClient: null,
        window: { currentUser: over.signedIn === false ? null : { uid: 'u1', email: 'a@b.c' } },
        executeDriveBackup: over.executeDriveBackup || null,
        _wfTotalRecordCount: () => 3,
        _writePendingBackupSnapshotToSW: () => {},
        _wfDriveAuthPhase: '',
        document: { getElementById: () => null },
        renderSettings: () => {},
    };
    // _persistLocal/_persistRaw come along for the ride rather than being
    // stubbed. backupNow stamps wf_last_auto_backup through the guarded writer,
    // and a stub would let the test keep passing if that write ever went back to
    // a bare setItem — which is the thing the guard exists to prevent. Leaving
    // them out entirely is worse still: the first version of this harness did,
    // and backupNow threw ReferenceError and reported a clean `false`.
    const body = fnSource('_persistLocal') + '\n' + fnSource('_persistRaw') + '\n'
        + fnSource('syncToCloud') + '\n' + fnSource('backupNow')
        + '\nreturn { syncToCloud: syncToCloud, backupNow: backupNow };';
    // `let _lastCloudPushError` sits just above syncToCloud in the page, and
    // `_wfLocalWriteBlocked` just above _persistLocal; both are declared here so
    // the extracted functions share one binding each.
    const api = new Function(...DEPS, 'let _lastCloudPushError = ""; let _wfLocalWriteBlocked = false;\n' + body)(
        ...DEPS.map((d) => env[d]));
    return { ...api, settings, store };
}

describe('the extraction found real code (guards a vacuous suite)', () => {
    it('both functions came out of index.html', () => {
        expect(fnSource('syncToCloud').length).toBeGreaterThan(400);
        expect(fnSource('backupNow').length).toBeGreaterThan(1500);
        const { syncToCloud, backupNow } = load();
        expect(typeof syncToCloud).toBe('function');
        expect(typeof backupNow).toBe('function');
    });
});

describe('syncToCloud reports what it actually did', () => {
    it('resolves true only after Firestore acknowledges the write', async () => {
        let called = false;
        const { syncToCloud } = load({
            userDocRef: { set: () => { called = true; return Promise.resolve(); } },
        });
        expect(await syncToCloud()).toBe(true);
        expect(called, 'it reported success without writing anything').toBe(true);
    });

    it('resolves false when Firestore rejects the write', async () => {
        const { syncToCloud } = load({
            userDocRef: { set: () => Promise.reject({ code: 'permission-denied', message: 'nope' }) },
        });
        expect(await syncToCloud(),
            'a rejected write still reported success — this is the reported bug')
            .toBe(false);
    });

    it('resolves false when there is no user document to write to', async () => {
        const { syncToCloud } = load({ userDocRef: null });
        expect(await syncToCloud()).toBe(false);
    });

    it('resolves false when the device is offline', async () => {
        const { syncToCloud } = load({ onLine: false });
        expect(await syncToCloud()).toBe(false);
    });

    it('resolves true when the cloud already holds this data', async () => {
        // setDirty(false) is only reached after an acknowledged write, so
        // "not dirty" genuinely means backed up — it is not a shrug.
        const { syncToCloud } = load({
            isDirty: false,
            userDocRef: { set: () => { throw new Error('must not write'); } },
        });
        expect(await syncToCloud()).toBe(true);
    });

    it('never rejects, so the fire-and-forget callers are unharmed', async () => {
        const { syncToCloud } = load({ userDocRef: { set: () => Promise.reject(new Error('x')) } });
        await expect(syncToCloud()).resolves.toBe(false);
    });
});

describe('backupNow refuses to claim a backup that did not happen', () => {
    it('returns false when the cloud write was rejected and Drive is absent', async () => {
        const { backupNow } = load({
            userDocRef: { set: () => Promise.reject({ code: 'permission-denied', message: 'nope' }) },
        });
        expect(await backupNow(true, 'auto'),
            'the scheduler stamps its success timestamp on this value')
            .toBe(false);
    });

    it('does not stamp a success timestamp on a failed backup', async () => {
        const { backupNow, settings, store } = load({
            userDocRef: { set: () => Promise.reject({ code: 'unavailable', message: 'down' }) },
        });
        await backupNow(true, 'auto');
        expect(settings.lastBackup, 'a failed backup left a "last backup" time behind')
            .toBeUndefined();
        expect(settings.lastAutoBackupAt).toBeUndefined();
        expect(store.get('wf_last_auto_backup')).toBeUndefined();
    });

    it('names the actual cause instead of a generic sentence', async () => {
        const { backupNow, settings } = load({
            userDocRef: { set: () => Promise.reject({ code: 'permission-denied', message: 'nope' }) },
        });
        await backupNow(true, 'auto');
        expect(settings.lastBackupAttempt.success).toBe(false);
        expect(settings.lastBackupAttempt.reason,
            'the user is told it failed but not what to do about it')
            .toMatch(/permission-denied/);
    });

    it('returns false when signed out, rather than backing up nothing', async () => {
        const { backupNow } = load({ signedIn: false, userDocRef: null });
        expect(await backupNow(true, 'auto')).toBe(false);
    });

    it('returns true and stamps the time when the write really lands', async () => {
        const { backupNow, settings, store } = load();
        expect(await backupNow(true, 'auto')).toBe(true);
        expect(settings.lastBackup).toBeTruthy();
        expect(settings.lastBackupMeta.cloud).toBe(true);
        expect(store.get('wf_last_auto_backup')).toBeTruthy();
    });

    it('still succeeds on Drive alone when the cloud is unreachable', async () => {
        const { backupNow, settings } = load({
            userDocRef: null,
            executeDriveBackup: () => Promise.resolve(true),
        });
        // gapiToken is null here, so Drive is not attempted — the point is that
        // a false cloud result no longer forces the whole backup to claim success.
        const ok = await backupNow(true, 'auto');
        expect(ok).toBe(false);
        expect(settings.lastBackupMeta, 'metadata was recorded for a backup that '
            + 'never happened').toBeUndefined();
    });
});
