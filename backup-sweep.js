/* =============================================================================
 * backup-sweep.js  ->  /api/backup-sweep   (Vercel cron, twice a day; also callable with the cron secret)
 * -----------------------------------------------------------------------------
 * The Auto-Backup Schedule for the nights the app is closed.
 *
 * WHY THIS EXISTS. The schedule ("Daily 23:55 · Weekly · Monthly") only ever ran inside an open page, and the Settings text said so in a
 * parenthesis. A browser cannot run a page that is not open, and the fallback that was meant to cover it (the service worker POSTing a staged
 * copy to Firestore) sent no sign-in, which the rules refuse, and staged the live data rather than a copy. So an owner who closes the app at
 * 21:00 had no backup that night, and the card — fed by a stamp from the last time a page ran — could still read "backed up".
 *
 * WHAT IT DOES. For every account whose schedule is on, it asks the SAME question the page asks (wealthflow-backup.js backupDue: "is the newest
 * real copy older than the last trigger, and is a failed run out of its back-off?") and, when the answer is yes, takes the same two copies the
 * page takes:
 *   1. a restore point in the account (users/{uid}/backups + backupData): the live document as canonical JSON (sorted keys, minus the backups' own stamps), SHA-256 on it, written in one commit with
 *      its metadata, and rotated so a wipe that is backed up every night cannot rotate the good copies out;
 *   2. when Google Drive is connected (a refresh token in the user's document) and GOOGLE_OAUTH_CLIENT_SECRET is set, the same copy in the
 *      user's own "WealthFlow Backups" folder, proven by its exact size.
 * The result is written to users/{uid}/backupStatus/last, which is what the Settings card reads — so a night the server covered is shown as
 * covered, and a night it could not is shown as a failure with the reason.
 *
 * WHEN IT RUNS. 18:30 UTC (00:00 in Colombo, just after the 23:55 trigger) and 06:30 UTC (12:00 in Colombo: the retry for anything that failed
 * overnight, and the catch-up for a schedule switched on during the day). A run with nothing due reads three small documents per account and
 * writes nothing.
 *
 * WHAT IT NEVER DOES. It never writes the user's own document (the page owns it; a server write there would race the sync). It never deletes
 * a restore point except by the rotation rule, and never hard-deletes a Drive file (older ones are moved to the Drive trash). It never backs up
 * an account whose sign-in is disabled or gone. It never logs a token or a record.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>, constant-time, refusing everything when unset (cron-auth.mjs).
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { cronAuthorized } from './cron-auth.mjs';
import { fetchWithBodyDeadline } from './fetch-timeout.mjs';
import { DEFAULT_CLIENT_ID } from './drive-auth.js';
import B from './wealthflow-backup.js';

/** Accounts backed up per run; the rest wait for the next one (the due check is what orders them: whoever is still due goes first next time). */
export const MAX_BACKUPS = 20;
export const TOTAL_BUDGET_MS = 45000;
/** The function is killed at 60 s (vercel.json maxDuration). No account may be given more than what is left of this, so the run still answers. */
export const RUN_CEILING_MS = 55000;
export const SCAN_PAGE = 400;
export const SCAN_MAX = 2000;
export const FREQS = ['daily', 'weekly', 'monthly'];
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Ask Google for a fresh access token from the user's refresh token (the same call /api/drive-auth makes for the page). Never throws, never logs the token. */
export async function mintDriveToken({ fetch: f, env, refreshToken }) {
    const secret = String((env && env.GOOGLE_OAUTH_CLIENT_SECRET) || '').trim();
    if (!secret) return { ok: false, reason: 'not_configured' };
    if (!refreshToken) return { ok: false, reason: 'not-connected' };
    try {
        const r = await f(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: String((env && env.GOOGLE_OAUTH_CLIENT_ID) || DEFAULT_CLIENT_ID).trim(),
                client_secret: secret, refresh_token: String(refreshToken), grant_type: 'refresh_token',
            }).toString(),
        });
        let j = {}; try { j = await r.json(); } catch (_) { /* an empty body */ }
        if (r.ok && j && j.access_token) return { ok: true, token: j.access_token };
        return { ok: false, reason: String((j && j.error) || ('http-' + r.status)) };
    } catch (e) {
        return { ok: false, reason: 'network' };
    }
}

/**
 * May this sign-in still be backed up? A disabled or deleted account is skipped (its data may be waiting on a deletion request, and a fresh
 * restore point would put a copy back that the owner asked to be gone). An Auth outage is "could not tell": skip this run, change nothing.
 */
export async function accountState({ admin, uid }) {
    if (!admin || typeof admin.auth !== 'function') return { ok: false, transient: true, reason: 'sign-in service unavailable' };
    try {
        const u = await withDeadline(admin.auth().getUser(uid), 5000, 'auth');
        if (!u) return { ok: false, transient: true, reason: 'sign-in service gave no account' };
        if (u.disabled === true) return { ok: false, reason: 'the sign-in account is disabled' };
        return { ok: true, email: u.email || '' };
    } catch (e) {
        const code = e && e.code;
        if (code === 'auth/user-not-found' || code === 'auth/invalid-uid') return { ok: false, reason: 'the sign-in account no longer exists' };
        return { ok: false, transient: true, reason: 'sign-in service did not answer' };
    }
}

/**
 * The accounts whose schedule is on: { uid, freq, weekStart }. One plain equality query per frequency, paged by document id (the order an
 * equality query already has, so the automatic single-field index answers it: no composite index to create and no deploy step to forget),
 * projected to the two fields the question needs.
 */
async function readScheduled(db) {
    const out = [];
    for (const freq of FREQS) {
        let after = null;
        while (out.length < SCAN_MAX) {
            let q = db.collection('users').where('settings.autoBackupFreq', '==', freq);
            if (typeof q.select === 'function') q = q.select('settings.autoBackupFreq', 'settings.weekStart');
            q = q.limit(SCAN_PAGE);
            if (after) q = q.startAfter(after);
            const snap = await withDeadline(q.get(), 10000, 'users');
            for (const d of snap.docs) {
                const s = (d.data() || {}).settings || {};
                out.push({ uid: d.id, freq, weekStart: s.weekStart === 'sunday' ? 0 : 1 });
            }
            if (snap.docs.length < SCAN_PAGE) break;
            after = snap.docs[snap.docs.length - 1];
        }
    }
    return out;
}

/** One account: decide, then copy. Returns a summary line (no data, no tokens). */
export async function backupAccount({ db, admin, acct, deps, now }) {
    const { uid } = acct;
    const [rps, status] = await Promise.all([
        B.listSnapshots({ db, uid, limit: 1 }).catch(() => null),
        B.readStatus({ db, uid }),
    ]);
    if (rps === null) return { uid, outcome: 'skipped', why: 'could not list restore points' };    // not knowing what exists is not a reason to write
    const rp0 = rps[0] || null;
    let lastGoodMs = rp0 ? Math.max(Number(rp0.confirmedAtMs) || 0, Number(rp0.atMs) || 0) : 0;
    if (status && status.drive && status.drive.ok && Number(status.drive.atMs) > lastGoodMs) lastGoodMs = Number(status.drive.atMs);
    const failed = status && status.success === false;
    const verdict = B.backupDue({
        freq: acct.freq, lastGoodMs, failedAtMs: failed ? Number(status.atMs) || 0 : 0, failCount: failed ? Number(status.failCount) || 1 : 0,
        now, weekStart: acct.weekStart, tzOffsetMin: B.SERVER_TZ_OFFSET_MIN,
    });
    if (!verdict.due) return { uid, outcome: 'fresh', why: verdict.why };

    const who = await deps.accountState({ admin, uid });
    if (!who.ok) return { uid, outcome: 'skipped', why: who.reason };

    const snap = await withDeadline(db.collection('users').doc(uid).get(), 8000, 'users');
    if (!snap.exists) return { uid, outcome: 'skipped', why: 'the account has no data document' };
    const data = snap.data() || {};
    const payload = B.buildPayload(data);

    const rp = await B.saveSnapshot({ db, uid, payload, trigger: 'server', now });
    let drive = null;
    const refresh = data.driveRefresh && data.driveRefresh.token;
    if (payload.ok && payload.records && refresh && String((deps.env && deps.env.GOOGLE_OAUTH_CLIENT_SECRET) || '').trim()) {
        let minted = null, mintReason = '';
        const getToken = async (force) => {
            if (minted && !force) return minted;
            const m = await mintDriveToken({ fetch: deps.fetch, env: deps.env, refreshToken: refresh });
            minted = m.ok ? m.token : null; mintReason = m.ok ? '' : m.reason;
            return minted;
        };
        const hint = (data.settings && data.settings.lastDriveBackup && data.settings.lastDriveBackup.v === 2 && data.settings.lastDriveBackup.folderId) || '';
        const r = await B.driveBackup({ fetch: deps.fetch, getToken, text: payload.text, uid, email: who.email, now, folderHint: hint, label: 'server' });
        drive = { ok: !!(r.ok && r.verified), reason: r.ok ? '' : (mintReason || r.reason || 'failed'), atMs: now, size: r.size || 0, fileName: r.fileName || '', folderId: r.folderId || '' };
    }

    const haveRp = !!(rp && rp.ok && !rp.skipped), haveDrive = !!(drive && drive.ok);
    const ok = haveRp || haveDrive;
    const empty = !!(rp && rp.ok && rp.skipped === 'empty') && !ok;
    let reason = '';
    if (!ok && !empty) reason = (rp && !rp.ok && B.restorePointReasonText(rp.reason)) || (drive && !drive.ok && B.driveReasonText(drive.reason)) || 'nothing was written';
    const failCount = ok || empty ? 0 : (failed ? (Number(status.failCount) || 0) : 0) + 1;
    await B.writeStatus({
        db, uid, status: {
            atMs: now, success: ok || empty, reason: ok ? '' : (empty ? 'nothing to back up yet' : reason), failCount, trigger: 'server', by: 'server',
            rpId: haveRp ? rp.id : '', records: payload.ok ? payload.records : 0, bytes: payload.ok ? payload.bytes : 0,
            rp: rp ? { ok: !!rp.ok && !rp.skipped, reason: rp.ok ? '' : rp.reason } : null, drive,
        },
    });
    if (haveRp && drive) await B.annotateSnapshot({ db, uid, id: rp.id, patch: { drive: { ok: drive.ok, reason: drive.reason, atMs: drive.atMs, size: drive.size } } });
    return { uid, outcome: ok ? 'backed-up' : (empty ? 'empty' : 'failed'), why: verdict.why, restorePoint: haveRp ? (rp.reused ? 'confirmed' : 'saved') : 'no', drive: drive ? (drive.ok ? 'verified' : drive.reason) : 'not-connected', reason };
}

function j(res, code, body) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

export async function handleSweep(req, res, deps) {
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) return j(res, 405, { ok: false, error: 'method not allowed' });
    const auth = cronAuthorized(req, { env: deps.env });
    if (!auth.ok) {
        // A refused scheduled run leaves no other trace than a status code nobody reads: say it in the log, in words.
        console.error(`[WF-CRON] backup-sweep refused (${auth.status}): ${String(auth.reason).slice(0, 140)}`);
        return j(res, auth.status, { ok: false, error: auth.reason });
    }
    const { db, reason, admin } = await deps.getAdminDb();
    if (!db) {
        console.error('[WF-CRON] backup-sweep cannot reach the database: ' + String(reason || 'unavailable').slice(0, 160));
        return j(res, 503, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });
    }
    const startedAt = deps.clock();
    const now = deps.now();

    let scheduled;
    try { scheduled = await readScheduled(db); }
    catch (e) {
        console.error('[WF-CRON] backup-sweep could not read the schedules: ' + String((e && e.message) || e).slice(0, 160));
        return j(res, 500, { ok: false, error: 'could not read the schedules' });
    }

    const results = [];
    let backups = 0, leftOver = 0;
    for (let i = 0; i < scheduled.length; i += 1) {
        if (deps.clock() - startedAt > TOTAL_BUDGET_MS || backups >= MAX_BACKUPS) { leftOver = scheduled.length - i; break; }
        try {
            // Per-operation waits inside an account add up (reads, a batch, token, Drive upload and verify), and the budget above is only looked
            // at between accounts: one account on a degraded Google or Firestore could otherwise run past the platform's kill and leave the
            // whole run unanswered. It gets what is left; an account that does not finish is retried by the next run.
            const left = Math.max(1000, RUN_CEILING_MS - (deps.clock() - startedAt));
            const r = await withDeadline(backupAccount({ db, admin, acct: scheduled[i], deps, now }), left, 'backup');
            if (['backed-up', 'failed'].includes(r.outcome)) backups += 1;      // an empty account costs one read and one tiny write: it must not use up the cap that real copies are limited by
            results.push({ ...r, uid: r.uid.slice(0, 6) });
            if (r.outcome === 'failed') console.warn(`[WF-BACKUP] account ${r.uid.slice(0, 6)} backup failed: ${String(r.reason).slice(0, 140)}`);
        } catch (e) {
            console.warn(`[WF-BACKUP] account ${scheduled[i].uid.slice(0, 6)} errored: ${String((e && e.message) || e).slice(0, 140)}`);
            results.push({ uid: scheduled[i].uid.slice(0, 6), outcome: 'error' });
        }
    }
    const n = (k) => results.filter((r) => r.outcome === k).length;
    console.info(`[WF-CRON] backup-sweep accounts=${scheduled.length} fresh=${n('fresh')} backedUp=${n('backed-up')} failed=${n('failed') + n('error')} empty=${n('empty')} skipped=${n('skipped')} leftOver=${leftOver}`);
    return j(res, 200, { ok: true, accounts: scheduled.length, backedUp: n('backed-up'), failed: n('failed') + n('error'), fresh: n('fresh'), skipped: n('skipped'), empty: n('empty'), leftOver, results });
}

export const defaultDeps = ({ fetchMs = 20000 } = {}) => ({
    getAdminDb,
    accountState,
    env: process.env,
    // The deadline covers the body as well as the headers: every caller goes on to read `r.json()`, and a response that sends headers and
    // then goes quiet would otherwise have no deadline at all (fetch-timeout.mjs, "A deadline that outlives the headers").
    fetch: (url, init) => fetchWithBodyDeadline(url, init, fetchMs),
    now: () => Date.now(),
    clock: () => Date.now(),
});

export default async function handler(req, res) {
    return handleSweep(req, res, defaultDeps());
}
