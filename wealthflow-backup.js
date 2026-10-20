/* =============================================================================
 * wealthflow-backup.js — a backup that exists, and a status that says so
 * -----------------------------------------------------------------------------
 * ONE MODULE FOR THE PAGE, THE SCHEDULED SERVER RUN AND THE TESTS. It is an ES
 * module like wealthflow-own-money.js: the page loads it with
 * <script type="module"> and reads window.WFBackup, backup-sweep.js imports it,
 * and test/backup_restore_points_test.js runs the real code against a fake
 * Firestore and a fake Drive. Nothing here touches the DOM.
 *
 * WHAT WAS WRONG (found by reading the schedule end to end, and by listing the
 * owner's Drive folder: the newest backup file there was five weeks old while
 * the schedule had been reporting "Auto-Backup Complete" every night)
 *
 *  1. THE "CLOUD BACKUP" WAS NOT A BACKUP. backupNow() pushed the live data into
 *     the very document it was supposed to protect and called that a backup. It
 *     is a sync: a bulk delete or a bad import reaches it a second later, so it
 *     can never be the copy you restore from. And "nothing to push" counted as
 *     success too. Every night's run was therefore "successful" with no
 *     recoverable copy anywhere unless Drive happened to work.
 *  2. DRIVE ALMOST NEVER WORKED AT 23:55. An access token lives an hour. The page
 *     kept the stale string in memory, uploaded with it, got a 401, threw the
 *     token away and returned false — and the cloud "success" above hid it. The
 *     durable refresh path existed but was only reached when no token was held
 *     at all, which is never the case in a session that signed in this morning.
 *  3. THE BACKUPS WENT INTO A FOLDER ANYONE CAN READ AND WRITE. Every user's
 *     file landed in one folder owned by the developer, shared "anyone with the
 *     link: editor", whose id sits in the public page source. Drive backups now
 *     go to a private folder in the user's OWN Drive, which is also what the
 *     privacy policy has always said.
 *  4. A FAILURE WAS NEVER SHOWN, RETRIED SANELY OR REPORTED. After the first
 *     success the card hid every later failure; a failed run was retried every
 *     30 seconds, forever, because "last backup is older than the trigger"
 *     stayed true; and nothing was said to the user at all.
 *  5. NOTHING RAN WHILE THE APP WAS CLOSED. The service worker "fallback" posted
 *     to Firestore with no credential, to a URL that only accepts PATCH, so it
 *     could never succeed. The schedule is now also run by a Vercel cron
 *     (backup-sweep.js) through this same module.
 *  6. A RESTORE DESTROYED THE CURRENT DATA WITHOUT KEEPING IT, and the "restore
 *     from file" path never restored anything (it rebound a variable and left
 *     disk and cloud untouched). Both now go through one function that saves the
 *     current data as a restore point first and refuses to continue without it.
 *
 * WHAT A BACKUP IS NOW
 *   A restore point: a full copy of the user's data, stored beside — not inside —
 *   the live document (users/{uid}/backups meta + users/{uid}/backupData), with a
 *   SHA-256 so a restore can prove it read what was written. Plus, when Google
 *   Drive is connected, the same bytes as a file in the user's own Drive,
 *   verified by size. A run counts as a backup only if at least one of those two
 *   exists afterwards; everything else is reported as what it is.
 *   The copy is canonical JSON (keys sorted, the backups' own bookkeeping left out), so the same data gives the same SHA-256 whether the
 *   page, a second device or the server run wrote it, and "identical to the newest copy" really is detected: pressing "Backup Now" ten
 *   times, or a quiet week of nightly runs, confirms one copy instead of rotating real history out.
 *
 * RETENTION never throws away the only good copy: the newest few, the newest of
 * each of the last 14 days, the fullest recent copy (so a wipe cannot rotate the
 * good ones out), and every "before restore" or "before wipe" copy for 30 days. Old copies beyond
 * that are deleted — it is rotation of our own copies, and the privacy policy
 * says so.
 * ===========================================================================*/

export const SNAP_COL = 'backups';       // users/{uid}/backups/{id}      metadata only: cheap to list
export const DATA_COL = 'backupData';    // users/{uid}/backupData/{id}   { data: '<json>' }
export const STATUS_COL = 'backupStatus'; // users/{uid}/backupStatus/last  what the last run (page or server) did, for the card and for retry back-off
export const MAX_SNAPSHOT_BYTES = 1000000;  // a Firestore document is capped at 1,048,576 bytes; the wrapper fields take well under 1 KB
export const KEEP_NEWEST = 5;
export const KEEP_DAYS = 14;
export const PEAK_WINDOW_MS = 60 * 86400000;
export const PRE_RESTORE_KEEP_MS = 30 * 86400000;
export const LIST_LIMIT = 120;
export const WRITE_TIMEOUT_MS = 25000;
export const DRIVE_FOLDER_NAME = 'WealthFlow Backups';
export const DRIVE_KEEP = 6;
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** The wall-clock the schedule is written in ("23:55"). The page uses the device's own clock; the server has none, so it uses Colombo. */
export const SERVER_TZ_OFFSET_MIN = 330;
export const RETRY_STEPS_MIN = [5, 15, 60, 180, 360];

/** The collections a WealthFlow data set is made of (index.html _WF_RECORD_KEYS; test/backup_restore_points_test.js keeps the two in step). */
export const RECORD_KEYS = ['income', 'incomeRecv', 'loans', 'ccinstall', 'cconetime', 'ccPayments', 'cheques', 'expenses', 'targets', 'subscriptions', 'importBatches', 'cribReports', 'sessions', 'sweeps', 'pawns', 'debtors', 'people', 'payAccounts'];
/** Not data: sync bookkeeping, the factory-reset marker (a restore stamps its own) and the Drive credentials that happen to live on the same document. A backup file must never carry a token. */
const EXCLUDE = new Set(['_lastModified', '_lastModifiedBy', '_writeDeviceId', '_writeTs', '_wipedAt', '_wipedAck', 'driveBridge', 'driveRefresh']);
/** The keys a backup never carries (and a restore never writes back): sync bookkeeping, the reset marker and the Drive credentials. */
export const EXCLUDE_KEYS = Array.from(EXCLUDE);
/** Settings that record the backups themselves. They change on every run, so left inside the copy every copy would differ from the last
 *  and "identical data" could never be seen. A restore keeps this device's own values for them anyway (index.html _wfApplyRestore). */
const BACKUP_STAMPS = new Set(['lastBackup', 'lastAutoBackupAt', 'lastBackupMeta', 'lastBackupAttempt', 'lastDriveBackup']);
export const BACKUP_STAMP_KEYS = Array.from(BACKUP_STAMPS);
/** Counted nowhere: big, transient or not the user's records. */
const NOT_RECORDS = new Set(['settings', 'auth', 'sessions', 'incomeReceived', 'aiHistory', 'aiChats', 'memory']);

/* ------------------------------------------------------------------ small helpers */

const enc = (s) => encodeURIComponent(String(s));
const utf8Bytes = (s) => new TextEncoder().encode(String(s));

/** SHA-256 hex. Falls back to a 64-bit FNV only if WebCrypto is missing, so a missing API can never stop a backup. */
export async function sha256Hex(text) {
    try {
        const c = globalThis.crypto && globalThis.crypto.subtle;
        if (c) {
            const buf = await c.digest('SHA-256', utf8Bytes(text));
            return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
        }
    } catch (_) { /* fall through */ }
    let h1 = 0xcbf29ce4, h2 = 0x84222325;
    const bytes = utf8Bytes(text);
    for (let i = 0; i < bytes.length; i++) {
        h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ bytes[i], 0x01b3) >>> 0;
    }
    return 'fnv-' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

function withTimeout(promise, ms, what) {
    let t;
    return Promise.race([
        promise,
        new Promise((_, rej) => { t = setTimeout(() => { const e = new Error(what + ' did not finish in ' + Math.round(ms / 1000) + 's'); e.code = 'timeout'; rej(e); }, ms); }),
    ]).finally(() => clearTimeout(t));
}

/* ------------------------------------------------------------------ the schedule */

/* "Daily 23:55 · weekly on the last day of the week · monthly on the last day of the month", written once.
 * The page asks it with the device clock (no tzOffsetMin); the cron asks it for Colombo. The month rule asks the
 * calendar for "day 0 of next month" instead of subtracting a month from a date, because setMonth(-1) on Mar 31
 * lands on Mar 3 and the old _lastScheduledBackupTime made every month after a 30-day one run an extra backup. */
function wall(ms, off) {
    if (off == null) { const d = new Date(ms); return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), dow: d.getDay() }; }
    const d = new Date(ms + off * 60000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
}
function at2355(y, m, d, off) {
    return off == null ? new Date(y, m, d, 23, 55, 0, 0).getTime() : Date.UTC(y, m, d, 23, 55, 0, 0) - off * 60000;
}
/** The next time the schedule fires, strictly after `now` (ms). null for 'off' or anything unknown. */
export function nextTrigger(freq, now, { weekStart = 1, tzOffsetMin } = {}) {
    const w = wall(now, tzOffsetMin), o = tzOffsetMin;
    if (freq === 'daily') { let t = at2355(w.y, w.m, w.d, o); if (t <= now) t = at2355(w.y, w.m, w.d + 1, o); return t; }
    if (freq === 'weekly') {
        const ahead = (((weekStart + 6) % 7) - w.dow + 7) % 7;
        let t = at2355(w.y, w.m, w.d + ahead, o); if (t <= now) t = at2355(w.y, w.m, w.d + ahead + 7, o); return t;
    }
    if (freq === 'monthly') { let t = at2355(w.y, w.m + 1, 0, o); if (t <= now) t = at2355(w.y, w.m + 2, 0, o); return t; }
    return null;
}
/** The most recent trigger at or before `now` (ms), or null. */
export function lastTrigger(freq, now, { weekStart = 1, tzOffsetMin } = {}) {
    const w = wall(now, tzOffsetMin), o = tzOffsetMin;
    if (freq === 'daily') { const t = at2355(w.y, w.m, w.d, o); return t <= now ? t : at2355(w.y, w.m, w.d - 1, o); }
    if (freq === 'weekly') {
        const ahead = (((weekStart + 6) % 7) - w.dow + 7) % 7;
        const t = at2355(w.y, w.m, w.d + ahead, o); return t <= now ? t : at2355(w.y, w.m, w.d + ahead - 7, o);
    }
    if (freq === 'monthly') { const t = at2355(w.y, w.m + 1, 0, o); return t <= now ? t : at2355(w.y, w.m, 0, o); }
    return null;
}
/** Wait before the next retry after `failCount` failures in a row: 5 min, 15 min, 1 h, 3 h, then every 6 h. */
export function retryDelayMs(failCount) {
    const i = Math.min(Math.max(Math.floor(failCount) || 1, 1), RETRY_STEPS_MIN.length) - 1;
    return RETRY_STEPS_MIN[i] * 60000;
}
/**
 * Is a backup due now? `lastGoodMs` is the newest copy that REALLY exists (0 if none). A failed run does not move it, so
 * "older than the last trigger" stays true until a run succeeds — which is why the old scheduler retried every 30 seconds.
 * Retries back off instead.
 */
export function backupDue({ freq, lastGoodMs, failedAtMs = 0, failCount = 0, now, weekStart = 1, tzOffsetMin }) {
    if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') return { due: false, why: 'off' };
    let why = 'schedule';
    if (!lastGoodMs) why = 'first';
    else {
        const t = lastTrigger(freq, now, { weekStart, tzOffsetMin });
        if (t == null || lastGoodMs >= t) return { due: false, why: 'fresh' };
    }
    if (failedAtMs && failCount && now - failedAtMs < retryDelayMs(failCount)) return { due: false, why: 'backoff' };
    return { due: true, why };
}
/** How old a copy may get before the card calls it stale: two whole intervals. */
export function staleAfterMs(freq) { return freq === 'weekly' ? 14 * 86400000 : freq === 'monthly' ? 62 * 86400000 : 2 * 86400000; }

/* ------------------------------------------------------------------ what gets written */

/** The data as a JSON string, without sync bookkeeping or tokens. `ok:false` when there is nothing sensible to save. */
export function buildPayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'no data to back up' };
    const o = {};
    for (const k of Object.keys(data)) if (!EXCLUDE.has(k)) o[k] = data[k];
    if (o.settings && typeof o.settings === 'object' && !Array.isArray(o.settings)) {
        const st = {};
        for (const k of Object.keys(o.settings)) if (!BACKUP_STAMPS.has(k)) st[k] = o.settings[k];
        o.settings = st;
    }
    let text;
    // Sorted keys: the page holds the data in the order it was built, Firestore hands it back alphabetically, and both must give the same bytes.
    try {
        text = JSON.stringify(o, (k, v) => {
            if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
            const sorted = {};
            for (const key of Object.keys(v).sort()) sorted[key] = v[key];
            return sorted;
        });
    } catch (e) { return { ok: false, reason: 'the data could not be serialised' }; }
    let records = 0;
    for (const k of Object.keys(o)) if (!NOT_RECORDS.has(k) && Array.isArray(o[k])) records += o[k].length;
    return { ok: true, text, bytes: utf8Bytes(text).length, records };
}

/**
 * May this parsed file be restored over a live account? A restore replaces data, so the question is asked before anything is
 * touched. `{}`, an array, a bank-statement JSON or an error page that happened to parse must never get through.
 */
export function validateRestore(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'This is not a WealthFlow backup (it is not a data object).' };
    const keys = Object.keys(obj).filter((k) => !EXCLUDE.has(k));
    const known = RECORD_KEYS.filter((k) => Array.isArray(obj[k]));
    const hasSettings = obj.settings && typeof obj.settings === 'object' && !Array.isArray(obj.settings);
    if (!keys.length || (!known.length && !hasSettings)) return { ok: false, reason: 'This file does not look like a WealthFlow backup (none of its collections are there).' };
    for (const k of RECORD_KEYS) if (obj[k] !== undefined && !Array.isArray(obj[k])) return { ok: false, reason: 'This backup is damaged: "' + k + '" should be a list.' };
    let records = 0;
    for (const k of known) if (!NOT_RECORDS.has(k)) records += obj[k].length;
    return { ok: true, records, collections: known.length };
}

/* ------------------------------------------------------------------ restore points (Firestore) */

/** Copies taken just before something destructive (a restore, a wipe). They are the way back, so they are always written and kept a month. */
const SAFETY_TRIGGERS = new Set(['pre-restore', 'pre-wipe']);
const dayKey = (ms, off) => new Date(ms + (off == null ? SERVER_TZ_OFFSET_MIN : off) * 60000).toISOString().slice(0, 10);

/**
 * Which restore points stay. `metas` need { id, atMs, records, trigger }. Returns { keep:Set<id>, drop:id[] }.
 * Keeps: the newest KEEP_NEWEST; the newest of each of the KEEP_DAYS most recent days that have one; the fullest copy of the
 * last 60 days (a wipe that is backed up every night must not rotate the good copies out); and every "pre-restore" / "pre-wipe" copy for 30 days.
 */
export function selectToKeep(metas, now = Date.now(), tzOffsetMin) {
    const list = (Array.isArray(metas) ? metas : []).filter((m) => m && m.id && Number.isFinite(m.atMs)).sort((a, b) => b.atMs - a.atMs);
    const keep = new Set();
    list.slice(0, KEEP_NEWEST).forEach((m) => keep.add(m.id));
    const days = new Set();
    for (const m of list) {
        const d = dayKey(m.atMs, tzOffsetMin);
        if (!days.has(d)) { if (days.size >= KEEP_DAYS) continue; days.add(d); keep.add(m.id); }
    }
    let peak = null;
    for (const m of list) if (now - m.atMs <= PEAK_WINDOW_MS && (m.records || 0) > 0 && (!peak || m.records > peak.records)) peak = m;
    if (peak) keep.add(peak.id);
    for (const m of list) if (SAFETY_TRIGGERS.has(m.trigger) && now - m.atMs <= PRE_RESTORE_KEEP_MS) keep.add(m.id);
    return { keep, drop: list.filter((m) => !keep.has(m.id)).map((m) => m.id) };
}

const refs = (db, uid) => {
    const u = db.collection('users').doc(uid);
    return { meta: u.collection(SNAP_COL), data: u.collection(DATA_COL), status: u.collection(STATUS_COL) };
};
const metaOf = (d) => Object.assign({ id: d.id }, d.data());

/** The restore points, newest first. Metadata only. */
export async function listSnapshots({ db, uid, limit = LIST_LIMIT }) {
    const s = await withTimeout(refs(db, uid).meta.orderBy('atMs', 'desc').limit(limit).get(), WRITE_TIMEOUT_MS, 'Listing restore points');
    return s.docs.map(metaOf);
}

/**
 * Save a restore point. Resolves { ok:true, id, atMs, bytes, records, reused?, pruned } once Firestore has acknowledged the write,
 * { ok:true, skipped:'empty' } when there is nothing to protect yet, or { ok:false, reason }. Never throws.
 * Identical to the newest copy (same SHA-256) ⇒ nothing new is written: that copy is confirmed instead, so pressing "Backup Now"
 * ten times cannot push the older copies out. A copy taken before a restore or a wipe is always written, because it is the way back.
 */
export async function saveSnapshot({ db, uid, payload, trigger = 'manual', now = Date.now(), extra = {}, tzOffsetMin }) {
    try {
        if (!db || !uid) return { ok: false, reason: 'not signed in' };
        if (!payload || !payload.ok) return { ok: false, reason: (payload && payload.reason) || 'no data to back up' };
        if (!payload.records && !SAFETY_TRIGGERS.has(trigger)) return { ok: true, skipped: 'empty' };
        if (payload.bytes > MAX_SNAPSHOT_BYTES) return { ok: false, reason: 'the data (' + Math.round(payload.bytes / 1024) + ' KB) is too large for a restore point; the Google Drive copy still works' };
        const sha = await sha256Hex(payload.text);
        const { meta, data } = refs(db, uid);
        let existing = [];
        try { existing = await listSnapshots({ db, uid }); } catch (e) { /* listing is for dedupe and rotation only; the write below is what matters */ }
        const newest = existing[0];
        if (!SAFETY_TRIGGERS.has(trigger) && newest && newest.sha === sha) {
            await withTimeout(meta.doc(newest.id).set({ confirmedAtMs: now }, { merge: true }), WRITE_TIMEOUT_MS, 'Confirming the restore point');
            return { ok: true, id: newest.id, atMs: newest.atMs, bytes: newest.bytes, records: newest.records, reused: true, pruned: 0 };
        }
        const id = String(now).padStart(13, '0') + '-' + trigger + '-' + Math.random().toString(36).slice(2, 6);
        const m = Object.assign({ at: new Date(now).toISOString(), atMs: now, trigger, bytes: payload.bytes, records: payload.records, sha, v: 1 }, extra);
        const b = db.batch();
        b.set(data.doc(id), { data: payload.text, atMs: now });
        b.set(meta.doc(id), m);       // the metadata goes in the SAME commit, so a listed restore point always has its data
        await withTimeout(b.commit(), WRITE_TIMEOUT_MS, 'Saving the restore point');
        let pruned = 0;
        try {
            const { drop } = selectToKeep(existing.concat([Object.assign({ id }, m)]), now, tzOffsetMin);
            for (let i = 0; i < drop.length; i += 200) {
                const d = db.batch();
                drop.slice(i, i + 200).forEach((x) => { d.delete(meta.doc(x)); d.delete(data.doc(x)); });
                await withTimeout(d.commit(), WRITE_TIMEOUT_MS, 'Rotating old restore points');
                pruned += Math.min(200, drop.length - i);
            }
        } catch (e) { /* rotation is housekeeping; the copy that was just saved stands */ }
        return { ok: true, id, atMs: now, bytes: payload.bytes, records: payload.records, pruned };
    } catch (e) {
        return { ok: false, reason: (e && (e.code || e.message)) ? String(e.code || e.message) : 'the write failed' };
    }
}

/**
 * Delete every restore point of an account — the person's own "delete my backups" — and the status document that describes them. Pages through
 * the list so an account with many safety copies is cleared in one go; a copy's metadata and its data go in the SAME batch, so a failure never
 * leaves a listed point without data or data nobody can see. { ok, deleted } or { ok:false, reason, deleted }. Never throws.
 */
export async function deleteAllSnapshots({ db, uid }) {
    let deleted = 0;
    try {
        const { meta, data, status } = refs(db, uid);
        for (let round = 0; round < 25; round++) {
            const list = await listSnapshots({ db, uid, limit: 200 });
            if (!list.length) {
                try { await withTimeout(status.doc('last').delete(), WRITE_TIMEOUT_MS, 'Clearing the backup status'); } catch (e) { /* the status holds no records */ }
                return { ok: true, deleted };
            }
            const b = db.batch();
            list.forEach((x) => { b.delete(meta.doc(x.id)); b.delete(data.doc(x.id)); });
            await withTimeout(b.commit(), WRITE_TIMEOUT_MS, 'Deleting restore points');
            deleted += list.length;
        }
        return { ok: false, reason: 'there are more restore points than one run removes; run it again', deleted };
    } catch (e) {
        return { ok: false, reason: (e && (e.code || e.message)) ? String(e.code || e.message) : 'the delete failed', deleted };
    }
}

/** Attach information learned after the copy was saved (the server records what Drive said). Never throws. */
export async function annotateSnapshot({ db, uid, id, patch }) {
    try { await withTimeout(refs(db, uid).meta.doc(id).set(patch, { merge: true }), WRITE_TIMEOUT_MS, 'Annotating the restore point'); return true; } catch (e) { return false; }
}

/**
 * What the last backup run did, in one small document every device and the server read: { atMs, success, reason, failCount, trigger,
 * by, rpId, records, drive:{ ok, reason, at, size, fileName, folderId } }. The page keeps its own copy of the failure streak for
 * back-off; this is the copy that survives the tab and tells the card (and the server run) what happened elsewhere. Never throws.
 */
export async function writeStatus({ db, uid, status }) {
    try { await withTimeout(refs(db, uid).status.doc('last').set(status), WRITE_TIMEOUT_MS, 'Writing the backup status'); return true; } catch (e) { return false; }
}
export async function readStatus({ db, uid }) {
    try { const d = await withTimeout(refs(db, uid).status.doc('last').get(), WRITE_TIMEOUT_MS, 'Reading the backup status'); return d.exists ? d.data() : null; } catch (e) { return null; }
}

/** Read one restore point back and prove it is what was written. { ok, data, meta } or { ok:false, reason }. */
export async function loadSnapshot({ db, uid, id }) {
    try {
        const { meta, data } = refs(db, uid);
        const [m, d] = await Promise.all([meta.doc(id).get(), data.doc(id).get()]);
        if (!m.exists || !d.exists) return { ok: false, reason: 'That restore point no longer exists.' };
        const text = (d.data() || {}).data;
        if (typeof text !== 'string' || !text) return { ok: false, reason: 'That restore point is empty.' };
        const mm = m.data() || {};
        if (mm.sha && (await sha256Hex(text)) !== mm.sha) return { ok: false, reason: 'That restore point failed its integrity check and was not used.' };
        let obj; try { obj = JSON.parse(text); } catch (e) { return { ok: false, reason: 'That restore point could not be read.' }; }
        return { ok: true, data: obj, meta: Object.assign({ id }, mm) };
    } catch (e) { return { ok: false, reason: (e && (e.code || e.message)) || 'could not read the restore point' }; }
}

/* ------------------------------------------------------------------ Google Drive */

const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

async function dj(fetchFn, url, init) {
    const r = await fetchFn(url, init);
    let json = null;
    try { json = await r.json(); } catch (_) { /* an empty or non-JSON body */ }
    return { ok: !!r.ok, status: r.status, json };
}
/** Drive's own words for why it refused, reduced to a code the UI can translate. */
export function driveFailure(status, json) {
    const e = (json && json.error) || {};
    const reason = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
    return { status, code: String(reason || ('http-' + status)), message: String(e.message || '') };
}
/** What to tell a person. Short, and ends in something they can do. */
export function driveReasonText(code) {
    const c = String(code || '');
    if (c === 'not-connected') return 'Google Drive is not connected on this device. Connect it to also keep an off-site copy.';
    if (c === 'token-expired' || c === 'http-401' || c === 'authError') return 'Google Drive sign-in expired. Reconnect Google Drive.';
    if (c === 'storageQuotaExceeded' || c === 'quotaExceeded') return 'Your Google Drive is full. Free some space.';
    if (c === 'insufficientPermissions' || c === 'forbidden' || c === 'http-403') return 'Google Drive refused the upload. Reconnect Google Drive and approve access.';
    if (c === 'rateLimitExceeded' || c === 'userRateLimitExceeded' || c === 'http-429') return 'Google Drive is busy right now; it will try again.';
    if (c === 'size-mismatch') return 'Google Drive stored a different size than was sent, so the copy was not trusted.';
    if (c === 'folder-failed') return 'Could not open the WealthFlow Backups folder in your Google Drive.';
    if (c === 'nothing-to-back-up') return 'There is nothing to back up yet.';
    if (c === 'integrity' || c === 'unreadable') return 'That Google Drive file is damaged (it does not match what was uploaded), so it was not used.';
    if (c === 'notFound' || c === 'http-404') return 'That file is no longer in your Google Drive.';
    if (/^http-5/.test(c)) return 'Google Drive is temporarily unavailable; it will try again.';
    if (c === 'network') return 'Google Drive could not be reached.';
    if (c === 'invalid_grant') return 'Google Drive access was revoked. Reconnect Google Drive.';
    return c ? 'Google Drive upload failed (' + c + ').' : 'Google Drive upload failed.';
}

/** Why a restore point could not be written, in words a person can act on. `saveSnapshot` reports Firestore's own code or message. */
export function restorePointReasonText(code) {
    const c = String(code || '');
    if (c === 'not signed in') return 'you are not signed in';
    if (c === 'timeout') return 'the write did not finish in time; check your connection';
    if (c === 'permission-denied') return 'your account refused the write (permission-denied)';
    if (c === 'unavailable') return 'the cloud could not be reached';
    return c || 'the write failed';
}

/** The user's own backup folder: found by name (drive.file only shows folders this app made), or created at the top of their My Drive. */
export async function ensureDriveFolder({ fetch: f, token, hint = '' }) {
    const H = { Authorization: 'Bearer ' + token };
    if (hint) {
        const r = await dj(f, DRIVE + '/files/' + enc(hint) + '?fields=id,trashed,mimeType', { headers: H });
        if (r.status === 401) return { ok: false, status: 401, code: 'token-expired' };
        if (r.ok && r.json && r.json.id === hint && !r.json.trashed && r.json.mimeType === FOLDER_MIME) return { ok: true, id: hint };
    }
    const q = "name = '" + DRIVE_FOLDER_NAME + "' and mimeType = '" + FOLDER_MIME + "' and trashed = false and 'root' in parents";
    const l = await dj(f, DRIVE + '/files?q=' + enc(q) + '&orderBy=createdTime&pageSize=10&fields=files(id,name)', { headers: H });
    if (l.status === 401) return { ok: false, status: 401, code: 'token-expired' };
    if (l.ok && l.json && Array.isArray(l.json.files) && l.json.files[0] && l.json.files[0].id) return { ok: true, id: l.json.files[0].id };
    if (!l.ok) return Object.assign({ ok: false }, driveFailure(l.status, l.json));
    const c = await dj(f, DRIVE + '/files?fields=id', {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H),
        body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME, description: 'Backups made by WealthFlow. Safe to keep; delete a file here only if you no longer want that copy.' }),
    });
    if (c.status === 401) return { ok: false, status: 401, code: 'token-expired' };
    if (c.ok && c.json && c.json.id) return { ok: true, id: c.json.id };
    return Object.assign({ ok: false }, driveFailure(c.status, c.json), { code: 'folder-failed' });
}

/**
 * This user's backup files, newest first. Filtered by name prefix here, not in the query: Drive's `contains` is a prefix-of-word match
 * and has surprised this code before. `includeLegacy` (the restore list only) also returns the older "WealthFlow_Backup…" names an
 * earlier version wrote; rotation never passes it, so it can only ever trash files this module made.
 */
export async function listDriveBackups({ fetch: f, token, safeEmail, uid6, includeLegacy = false }) {
    const q = "name contains 'WealthFlow_' and mimeType = 'application/json' and trashed = false";
    const r = await dj(f, DRIVE + '/files?q=' + enc(q) + '&orderBy=createdTime%20desc&pageSize=100&fields=files(id,name,createdTime,size,appProperties)', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return Object.assign({ ok: false }, driveFailure(r.status, r.json));
    const prefix = 'WealthFlow_' + safeEmail + '_' + uid6 + '_';
    return { ok: true, files: ((r.json && r.json.files) || []).filter((x) => x && x.name && (x.name.indexOf(prefix) === 0 || (includeLegacy && x.name.indexOf('WealthFlow_Backup') === 0))) };
}

/** The two parts of a backup file's name that say whose it is (the list and the upload must agree on them). */
export function driveNameParts(uid, email) {
    return { safeEmail: String(email || 'user').replace(/[^a-zA-Z0-9._@-]/g, '_'), uid6: String(uid || 'anon').slice(0, 6) };
}

/**
 * Read one backup file back and prove it is what was uploaded: the size Drive lists, and the SHA-256 this module stored beside the
 * file, must both match. Older files (no stored SHA) are still readable; they get the size check only. `file` is a row from
 * listDriveBackups. { ok, data, text, verifiedSha } or { ok:false, reason, status? }. Never throws.
 */
export async function downloadDriveBackup({ fetch: f, token, file }) {
    try {
        if (!file || !file.id) return { ok: false, reason: 'no-file' };
        const r = await f(DRIVE + '/files/' + enc(file.id) + '?alt=media', { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) { let j = null; try { j = await r.json(); } catch (_) { /* no body */ } return Object.assign({ ok: false }, driveFailure(r.status, j), { reason: r.status === 401 ? 'token-expired' : driveFailure(r.status, j).code }); }
        const text = await r.text();
        if (file.size != null && file.size !== '' && String(utf8Bytes(text).length) !== String(file.size)) return { ok: false, reason: 'size-mismatch' };
        const sha = file.appProperties && file.appProperties.sha;
        if (sha && (await sha256Hex(text)) !== sha) return { ok: false, reason: 'integrity' };
        let data; try { data = JSON.parse(text); } catch (_) { return { ok: false, reason: 'unreadable' }; }
        return { ok: true, data, text, verifiedSha: !!sha };
    } catch (e) {
        return { ok: false, reason: 'network', message: (e && e.message) || '' };
    }
}

/** Trash (never hard-delete: Drive keeps it 30 days) everything beyond the newest `keep`. `protect` is never touched. */
export async function pruneDriveBackups({ fetch: f, token, files, keep = DRIVE_KEEP, protect = '' }) {
    const sorted = files.slice().sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
    const keepIds = new Set(sorted.slice(0, keep).map((x) => x.id));
    if (protect) keepIds.add(protect);
    let trashed = 0;
    for (const x of sorted) {
        if (keepIds.has(x.id)) continue;
        try {
            const r = await f(DRIVE + '/files/' + enc(x.id), { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
            if (r && r.ok) trashed++;
        } catch (_) { /* one failure must not stop the rest */ }
    }
    return trashed;
}

/**
 * Put the data in the user's own Google Drive and prove it landed.
 *
 * `getToken(force)` supplies the access token: false = whatever is valid, true = a freshly minted one (called once, after a 401).
 * Success means Drive reported the file back, not trashed, at EXACTLY the number of bytes sent — "exists and non-zero", which is
 * what this used to check, would have called a truncated upload verified. Identical to the newest Drive copy (same SHA-256, kept
 * in the file's appProperties) ⇒ nothing is uploaded and that file is confirmed, so repeated runs do not rotate real history out.
 * Returns { ok, verified, fileId, fileName, size, folderId, reused?, trashed, reason?, status? }. Never throws.
 */
export async function driveBackup({ fetch: f, getToken, text, uid, email, now = Date.now(), folderHint = '', keep = DRIVE_KEEP, label = '' }) {
    try {
        const { safeEmail, uid6 } = driveNameParts(uid, email);
        const bytes = utf8Bytes(text).length;
        const sha = await sha256Hex(text);
        let token = await getToken(false);
        if (!token) return { ok: false, verified: false, reason: 'not-connected' };
        for (let attempt = 0; attempt < 2; attempt++) {
            const folder = await ensureDriveFolder({ fetch: f, token, hint: attempt === 0 ? folderHint : '' });
            let res;
            if (!folder.ok) res = { ok: false, verified: false, status: folder.status, reason: folder.code };
            else res = await uploadOnce({ f, token, folderId: folder.id, text, bytes, sha, safeEmail, uid6, now, keep, label });
            if (!res.ok && res.status === 401 && attempt === 0) {
                token = await getToken(true);
                if (!token) return { ok: false, verified: false, reason: 'token-expired', status: 401 };
                continue;
            }
            return res;
        }
        return { ok: false, verified: false, reason: 'token-expired', status: 401 };
    } catch (e) {
        return { ok: false, verified: false, reason: 'network', message: (e && e.message) || '' };
    }
}

async function uploadOnce({ f, token, folderId, text, bytes, sha, safeEmail, uid6, now, keep, label }) {
    const H = { Authorization: 'Bearer ' + token };
    const listed = await listDriveBackups({ fetch: f, token, safeEmail, uid6 });
    if (!listed.ok && listed.status === 401) return { ok: false, verified: false, status: 401, reason: 'token-expired' };
    const files = listed.ok ? listed.files : [];
    const newest = files[0];
    if (newest && newest.appProperties && newest.appProperties.sha === sha && String(newest.size || '') === String(bytes)) {
        return { ok: true, verified: true, reused: true, fileId: newest.id, fileName: newest.name, size: bytes, folderId, trashed: 0 };
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const name = 'WealthFlow_' + safeEmail + '_' + uid6 + '_' + day + '_' + now + '.json';
    const metadata = { name, mimeType: 'application/json', parents: [folderId], appProperties: { sha, app: 'wealthflow' }, description: 'WealthFlow backup' + (label ? ' · ' + label : '') + ' · created ' + new Date(now).toISOString() };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([text], { type: 'application/json' }));
    const up = await dj(f, UPLOAD + '?uploadType=multipart&fields=id,name,size,parents,createdTime', { method: 'POST', headers: H, body: form });
    if (!up.ok) { const e = driveFailure(up.status, up.json); return { ok: false, verified: false, status: e.status, reason: e.status === 401 ? 'token-expired' : e.code, message: e.message }; }
    if (!up.json || !up.json.id) return { ok: false, verified: false, reason: 'no-file-id' };
    const v = await dj(f, DRIVE + '/files/' + enc(up.json.id) + '?fields=id,size,trashed', { headers: H });
    const verified = !!(v.ok && v.json && v.json.id === up.json.id && !v.json.trashed && String(v.json.size) === String(bytes));
    if (!verified) return { ok: false, verified: false, fileId: up.json.id, fileName: name, size: Number(v.json && v.json.size) || 0, folderId, reason: v.ok ? 'size-mismatch' : (driveFailure(v.status, v.json).code) };
    const all = files.concat([{ id: up.json.id, name, createdTime: up.json.createdTime || new Date(now).toISOString() }]);
    const trashed = await pruneDriveBackups({ fetch: f, token, files: all, keep, protect: up.json.id });
    return { ok: true, verified: true, fileId: up.json.id, fileName: name, size: bytes, folderId, trashed, createdTime: up.json.createdTime };
}

/* ------------------------------------------------------------------ what the card says */

/**
 * The honest summary of the backup state, as data the page renders. Every line says what is true NOW:
 *   rp   the newest restore point { atMs, trigger, bytes } or null
 *   drive the last Drive outcome { ok, at, reason, size } or null
 *   attempt the last run { success, at, reason } or null
 *   lastGoodMs the newest real copy (restore point or verified Drive file)
 * `level` is the worst of the lines: 'bad' = no usable copy or it is stale, 'warn' = a copy exists but something needs doing.
 */
export function describeBackup({ freq, lastGoodMs, rp, drive, attempt, now = Date.now() }) {
    const lines = [];
    let level = 'ok';
    const worse = (l) => { if (l === 'bad' || (l === 'warn' && level === 'ok')) level = l; };
    const scheduled = freq === 'daily' || freq === 'weekly' || freq === 'monthly';
    if (!lastGoodMs) {
        worse('bad');
        lines.push({ level: 'bad', text: 'No backup exists yet. Tap Backup Now to make the first one.' });
    } else if (scheduled && now - lastGoodMs > staleAfterMs(freq)) {
        worse('bad');
        lines.push({ level: 'bad', text: 'The newest backup is older than the ' + freq + ' schedule allows. It will be retried; if this stays, see the line below.' });
    }
    if (attempt && attempt.success === false && (!lastGoodMs || (attempt.atMs || 0) >= lastGoodMs)) {
        worse(lastGoodMs ? 'warn' : 'bad');
        lines.push({ level: lastGoodMs ? 'warn' : 'bad', text: 'The last attempt failed: ' + (attempt.reason || 'unknown reason') + '. It will retry automatically.' });
    }
    if (drive && drive.ok === false) {
        worse('warn');
        lines.push({ level: 'warn', text: driveReasonText(drive.reason) });
    } else if (!drive && lastGoodMs) {
        lines.push({ level: 'info', text: 'Google Drive has not been used for a backup yet. Connect it to also keep an off-site copy.' });
    }
    return { level, lines, rp: rp || null, drive: drive || null };
}

const API = {
    SNAP_COL, DATA_COL, STATUS_COL, MAX_SNAPSHOT_BYTES, KEEP_NEWEST, KEEP_DAYS, DRIVE_FOLDER_NAME, DRIVE_KEEP, SERVER_TZ_OFFSET_MIN, RECORD_KEYS, EXCLUDE_KEYS, BACKUP_STAMP_KEYS,
    sha256Hex, nextTrigger, lastTrigger, retryDelayMs, backupDue, staleAfterMs, buildPayload, validateRestore, selectToKeep,
    listSnapshots, saveSnapshot, annotateSnapshot, writeStatus, readStatus, loadSnapshot, driveFailure, driveReasonText, restorePointReasonText, ensureDriveFolder, listDriveBackups,
    pruneDriveBackups, driveBackup, driveNameParts, downloadDriveBackup, describeBackup, deleteAllSnapshots,
};

if (typeof window !== 'undefined') window.WFBackup = API;

export default API;
