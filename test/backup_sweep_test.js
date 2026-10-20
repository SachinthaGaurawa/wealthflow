/* =============================================================================
 * test/backup_sweep_test.js — the Auto-Backup Schedule on the nights the app is closed
 * -----------------------------------------------------------------------------
 * api/backup-sweep.js is the server half of the schedule. Before it, nothing ran with the app closed: the service-worker fallback posted
 * the live data to Firestore with no sign-in (refused by the rules) and the card was fed by a stamp left by the last time a page ran.
 *
 * These tests run the REAL handler against an in-memory Firestore that supports the queries the sweep makes (where/select/orderBy/
 * startAfter), a fake firebase-admin Auth, a Drive that refuses a stale token and a token endpoint that refuses a revoked refresh token.
 * What is asserted is what ended up in the stores, and what was written to the log.
 * ===========================================================================*/
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
    handleSweep, backupAccount, mintDriveToken, accountState, MAX_BACKUPS, SCAN_PAGE,
} from '../backup-sweep.js';
import { DEFAULT_CLIENT_ID } from '../drive-auth.js';
import B, { listSnapshots, loadSnapshot, readStatus, backupDue, describeBackup, SERVER_TZ_OFFSET_MIN, DRIVE_FOLDER_NAME } from '../wealthflow-backup.js';
import { makeDb, makeDrive, makeAdmin } from './helpers/backup-fakes.js';

/* Monday 2026-10-19 18:30 UTC = Tuesday 00:00 in Colombo: five minutes after the daily 23:55 trigger of Monday the 19th. */
const NOW = Date.parse('2026-10-19T18:30:00Z');
const DAILY_TRIGGER = Date.parse('2026-10-19T18:25:00Z');
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

const REFRESH_OK = 'refresh-token-OK-secret-value';
const ACCESS = 'good';

/* ------------------------------------------------------------------ the world */

const records = (n = 3) => ({
    expenses: Array.from({ length: n }, (_, i) => ({ id: 'e' + i, amount: 1000 + i, note: 'private-note-' + i })),
    income: [{ id: 'i0', amount: 50000 }],
});
function userDoc({ freq = 'daily', n = 3, weekStart, refresh, extra = {} } = {}) {
    const settings = { currency: 'LKR' };
    if (freq) settings.autoBackupFreq = freq;
    if (weekStart) settings.weekStart = weekStart;
    const d = { ...records(n), settings, _lastModified: 'ts', ...extra };
    if (refresh) d.driveRefresh = { token: refresh, at: 1 };
    return d;
}

/** A token endpoint + Drive in one `fetch`, as the sweep sees the network. */
function makeNet({ drive = makeDrive({ valid: ACCESS }), refresh = REFRESH_OK, tokenStatus = 200, tokenThrows = false } = {}) {
    const net = { drive, tokenCalls: [], fetch: null };
    net.fetch = async (url, init = {}) => {
        if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
            const body = new URLSearchParams(String(init.body));
            net.tokenCalls.push(Object.fromEntries(body.entries()));
            if (tokenThrows) throw new TypeError('network down');
            if (tokenStatus !== 200) return { ok: false, status: tokenStatus, json: async () => ({ error: 'server_error' }) };
            if (body.get('refresh_token') !== refresh) return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
            return { ok: true, status: 200, json: async () => ({ access_token: ACCESS, expires_in: 3600 }) };
        }
        return drive.fetch(url, init);
    };
    return net;
}

function world({ users = {}, authUsers, env, net, dbOpts, adminOpts, now = NOW } = {}) {
    const db = makeDb(dbOpts);
    Object.entries(users).forEach(([uid, d]) => db.store.set('users/' + uid, structuredClone(d)));
    const admin = makeAdmin({ users: authUsers || Object.fromEntries(Object.keys(users).map((u) => [u, { email: u + '@example.lk' }])), ...(adminOpts || {}) });
    const network = net || makeNet();
    const deps = {
        getAdminDb: async () => ({ db, admin }),
        accountState,
        env: { CRON_SECRET: 'cron-secret', GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret-value', ...(env || {}) },
        fetch: network.fetch,
        now: () => now,
        clock: () => 0,
    };
    return { db, admin, net: network, deps };
}

function call(deps, { method = 'GET', auth = 'Bearer cron-secret' } = {}) {
    const req = { method, headers: auth ? { authorization: auth } : {} };
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    return handleSweep(req, res, deps).then(() => ({ status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, headers: res.headers }));
}

const userWrites = (db) => db.state.writes.filter((p) => /^users\/[^/]+$/.test(p));
const rpCount = (db, uid) => [...db.store.keys()].filter((k) => k.startsWith(`users/${uid}/backups/`)).length;
const statusOf = (db, uid) => db.store.get(`users/${uid}/backupStatus/last`);

let logs;
beforeEach(() => {
    logs = [];
    const keep = (level) => (...a) => { logs.push(level + ' ' + a.map(String).join(' ')); };
    vi.spyOn(console, 'info').mockImplementation(keep('info'));
    vi.spyOn(console, 'log').mockImplementation(keep('log'));
    vi.spyOn(console, 'warn').mockImplementation(keep('warn'));
    vi.spyOn(console, 'error').mockImplementation(keep('error'));
});
afterEach(() => { vi.restoreAllMocks(); });

/* ------------------------------------------------------------------ who may run it */

describe('the endpoint is for the scheduler only', () => {
    it('refuses everything while CRON_SECRET is not configured, and says why in the log', async () => {
        const w = world({ users: { u1: userDoc() }, env: { CRON_SECRET: '' } });
        const r = await call(w.deps);
        expect(r.status).toBe(503);
        expect(w.db.state.reads).toEqual([]);
        expect(logs.join('\n')).toMatch(/\[WF-CRON\] backup-sweep refused \(503\)/);
    });
    it('refuses a request with no credential or a wrong one, without reading anything', async () => {
        const w = world({ users: { u1: userDoc() } });
        expect((await call(w.deps, { auth: '' })).status).toBe(401);
        expect((await call(w.deps, { auth: 'Bearer nope' })).status).toBe(401);
        expect(w.db.state.reads).toEqual([]);
        expect(w.db.state.writes).toEqual([]);
    });
    it('accepts GET (Vercel cron) and POST, refuses other methods', async () => {
        const w = world({ users: {} });
        expect((await call(w.deps, { method: 'GET' })).status).toBe(200);
        expect((await call(w.deps, { method: 'POST' })).status).toBe(200);
        expect((await call(w.deps, { method: 'DELETE' })).status).toBe(405);
    });
    it('answers 503 with the reason when the database cannot be reached, and 500 when the schedules cannot be read', async () => {
        const w = world({ users: { u1: userDoc() } });
        w.deps.getAdminDb = async () => ({ db: null, reason: 'FIREBASE_SERVICE_ACCOUNT is not set' });
        const r1 = await call(w.deps);
        expect(r1.status).toBe(503);
        expect(r1.json.error).toMatch(/FIREBASE_SERVICE_ACCOUNT/);
        const w2 = world({ users: { u1: userDoc() }, dbOpts: { failGet: true } });
        const r2 = await call(w2.deps);
        expect(r2.status).toBe(500);
        expect(logs.join('\n')).toMatch(/could not read the schedules/);
    });
});

/* ------------------------------------------------------------------ the night the app was closed */

describe('a night the app was closed still gets a restore point', () => {
    it('makes one for an account that is due, and records that the SERVER made it', async () => {
        const w = world({ users: { u1: userDoc({ n: 4 }) } });
        const r = await call(w.deps);
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ ok: true, accounts: 1, backedUp: 1, failed: 0 });
        const rps = await listSnapshots({ db: w.db, uid: 'u1' });
        expect(rps).toHaveLength(1);
        expect(rps[0]).toMatchObject({ trigger: 'server', records: 5, atMs: NOW });
        const st = statusOf(w.db, 'u1');
        expect(st).toMatchObject({ success: true, by: 'server', trigger: 'server', failCount: 0, rpId: rps[0].id, records: 5 });
        // and the copy restores to what the account held, byte for byte
        const back = await loadSnapshot({ db: w.db, uid: 'u1', id: rps[0].id });
        expect(back.ok).toBe(true);
        expect(back.data.expenses).toHaveLength(4);
    });

    it('never writes the user\'s own document: the page owns it, and a server write would race the sync', async () => {
        const w = world({ users: { u1: userDoc(), u2: userDoc({ freq: 'weekly' }) } });
        await call(w.deps);
        expect(userWrites(w.db)).toEqual([]);
        expect(w.db.store.get('users/u1')._lastModified).toBe('ts');
    });

    it('does not put the Drive credential or sync bookkeeping into the copy', async () => {
        const w = world({ users: { u1: userDoc({ refresh: REFRESH_OK, extra: { _writeDeviceId: 'dev', _wipedAt: 5 } }) } });
        await call(w.deps);
        const rp = (await listSnapshots({ db: w.db, uid: 'u1' }))[0];
        const text = w.db.store.get('users/u1/backupData/' + rp.id).data;
        expect(text).not.toContain(REFRESH_OK);
        expect(text).not.toMatch(/driveRefresh|_writeDeviceId|_wipedAt/);
    });

    it('a night the page already covered is not done twice, and a second run in the same minute writes nothing', async () => {
        const w = world({ users: { u1: userDoc() } });
        await call(w.deps);
        const before = w.db.state.writes.length;
        const again = await call(w.deps);
        expect(again.json).toMatchObject({ backedUp: 0, fresh: 1 });
        expect(w.db.state.writes.length).toBe(before);
        expect(rpCount(w.db, 'u1')).toBe(1);
    });

    it('treats a restore point the PAGE made after the trigger as the night\'s copy', async () => {
        const w = world({ users: { u1: userDoc() } });
        const p = B.buildPayload(w.db.store.get('users/u1'));
        await B.saveSnapshot({ db: w.db, uid: 'u1', payload: p, trigger: 'auto', now: DAILY_TRIGGER + 2 * MIN });
        w.db.state.writes.length = 0;
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ backedUp: 0, fresh: 1 });
        expect(w.db.state.writes).toEqual([]);
    });

    it('catches up an account whose newest copy is older than the last trigger', async () => {
        const w = world({ users: { u1: userDoc() } });
        const p = B.buildPayload(w.db.store.get('users/u1'));
        await B.saveSnapshot({ db: w.db, uid: 'u1', payload: p, trigger: 'auto', now: DAILY_TRIGGER - 3 * HOUR });
        // the data changed since: a different copy is written, the old one is kept
        const d = w.db.store.get('users/u1'); d.expenses.push({ id: 'new', amount: 1 });
        const r = await call(w.deps);
        expect(r.json.backedUp).toBe(1);
        expect(rpCount(w.db, 'u1')).toBe(2);
    });

    it('when the data did not change, confirms the existing copy instead of writing a duplicate', async () => {
        const w = world({ users: { u1: userDoc() } });
        const p = B.buildPayload(w.db.store.get('users/u1'));
        await B.saveSnapshot({ db: w.db, uid: 'u1', payload: p, trigger: 'auto', now: DAILY_TRIGGER - 3 * HOUR });
        await call(w.deps);
        expect(rpCount(w.db, 'u1')).toBe(1);
        const rp = (await listSnapshots({ db: w.db, uid: 'u1' }))[0];
        expect(rp.confirmedAtMs).toBe(NOW);
        expect(statusOf(w.db, 'u1').success).toBe(true);
    });
});

describe('only accounts whose schedule is on are touched', () => {
    it('leaves "off" and unscheduled accounts alone and does not count them', async () => {
        const w = world({ users: { u1: userDoc({ freq: 'off' }), u2: userDoc({ freq: null }), u3: userDoc({ freq: 'hourly' }), u4: userDoc() } });
        const r = await call(w.deps);
        expect(r.json.accounts).toBe(1);
        expect(rpCount(w.db, 'u1') + rpCount(w.db, 'u2') + rpCount(w.db, 'u3')).toBe(0);
        expect(w.db.state.reads.filter((p) => /^users\/u[123]/.test(p))).toEqual([]);
        expect(rpCount(w.db, 'u4')).toBe(1);
    });

    it('applies each account\'s own frequency: weekly and monthly are not done every night', async () => {
        const w = world({ users: { d: userDoc({ freq: 'daily' }), w: userDoc({ freq: 'weekly' }), m: userDoc({ freq: 'monthly' }) } });
        // weekly (Mon-first): last trigger Sunday 18 Oct 23:55 Colombo; monthly: 30 Sep 23:55 Colombo
        const seed = async (uid, at) => B.saveSnapshot({ db: w.db, uid, payload: B.buildPayload(w.db.store.get('users/' + uid)), trigger: 'auto', now: at });
        await seed('d', DAILY_TRIGGER - 2 * HOUR);
        await seed('w', Date.parse('2026-10-19T10:00:00Z'));
        await seed('m', Date.parse('2026-10-02T10:00:00Z'));
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ accounts: 3, fresh: 2, backedUp: 1 });
        const by = Object.fromEntries(r.json.results.map((x) => [x.uid, x.outcome]));
        expect(by).toEqual({ d: 'backed-up', w: 'fresh', m: 'fresh' });
    });

    it('catches up a weekly and a monthly account whose copies are older than their last trigger', async () => {
        const w = world({ users: { w: userDoc({ freq: 'weekly' }), m: userDoc({ freq: 'monthly' }) } });
        const seed = async (uid, at) => B.saveSnapshot({ db: w.db, uid, payload: B.buildPayload({ expenses: [{ id: 'old' }] }), trigger: 'auto', now: at });
        await seed('w', Date.parse('2026-10-12T10:00:00Z'));
        await seed('m', Date.parse('2026-09-29T10:00:00Z'));
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ backedUp: 2, fresh: 0 });
    });

    it('reads the week start from the account (a Sunday-first week ends on Saturday)', async () => {
        // Sunday-first: the last trigger is Saturday 17 Oct 23:55 Colombo, so a copy from Sunday 18th 12:00Z is fresh for Monday-first
        // but, for a Sunday-first week, the same copy is also after Saturday's trigger → fresh. A copy from Friday is due for both.
        const w = world({ users: { s: userDoc({ freq: 'weekly', weekStart: 'sunday' }) } });
        await B.saveSnapshot({ db: w.db, uid: 's', payload: B.buildPayload({ expenses: [{ id: 'old' }] }), trigger: 'auto', now: Date.parse('2026-10-16T10:00:00Z') });
        const r = await call(w.deps);
        expect(r.json.backedUp).toBe(1);
    });
});

/* ------------------------------------------------------------------ accounts that must not be backed up */

describe('an account that is gone or switched off is not backed up', () => {
    it('skips a disabled sign-in, a deleted one, and says nothing was written', async () => {
        const w = world({
            users: { dis: userDoc(), gone: userDoc(), ok: userDoc() },
            authUsers: { dis: { email: 'd@x.lk', disabled: true }, ok: { email: 'o@x.lk' } },
        });
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ backedUp: 1, skipped: 2 });
        expect(rpCount(w.db, 'dis') + rpCount(w.db, 'gone')).toBe(0);
        expect(statusOf(w.db, 'dis')).toBeUndefined();
        expect(statusOf(w.db, 'gone')).toBeUndefined();
    });
    it('an Auth outage changes nothing for anyone (could-not-tell is not a reason to write)', async () => {
        const w = world({ users: { u1: userDoc(), u2: userDoc() }, adminOpts: { authDown: true } });
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ backedUp: 0, skipped: 2, failed: 0 });
        expect(w.db.state.writes).toEqual([]);
    });
    it('accountState reports each answer in words', async () => {
        const admin = makeAdmin({ users: { a: { email: 'a@x.lk' }, d: { disabled: true } } });
        expect(await accountState({ admin, uid: 'a' })).toEqual({ ok: true, email: 'a@x.lk' });
        expect(await accountState({ admin, uid: 'd' })).toMatchObject({ ok: false, reason: expect.stringMatching(/disabled/) });
        expect(await accountState({ admin, uid: 'zz' })).toMatchObject({ ok: false, reason: expect.stringMatching(/no longer exists/) });
        expect(await accountState({ admin: makeAdmin({ authDown: true }), uid: 'a' })).toMatchObject({ ok: false, transient: true });
        expect(await accountState({ admin: null, uid: 'a' })).toMatchObject({ ok: false, transient: true });
    });
    it('skips an account with no data document, and one it cannot list restore points for', async () => {
        const w = world({ users: { u1: userDoc() } });
        const ghost = await backupAccount({ db: w.db, admin: w.admin, acct: { uid: 'ghost', freq: 'daily', weekStart: 1 }, deps: w.deps, now: NOW });
        expect(ghost.outcome).toBe('skipped');
        const failing = world({ users: { u1: userDoc() } });
        failing.db.state.failGet = true;
        const r = await backupAccount({ db: failing.db, admin: failing.admin, acct: { uid: 'u1', freq: 'daily', weekStart: 1 }, deps: failing.deps, now: NOW });
        expect(r).toMatchObject({ outcome: 'skipped', why: 'could not list restore points' });
        expect(failing.db.state.writes).toEqual([]);
    });
});

describe('an account with nothing in it', () => {
    it('writes no restore point, and says so instead of reporting a backup', async () => {
        const w = world({ users: { u1: { settings: { autoBackupFreq: 'daily' } } } });
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ backedUp: 0, empty: 1, failed: 0 });
        expect(rpCount(w.db, 'u1')).toBe(0);
        expect(statusOf(w.db, 'u1')).toMatchObject({ success: true, reason: 'nothing to back up yet', failCount: 0, rpId: '' });
    });
});

/* ------------------------------------------------------------------ failures */

describe('a failed run says so, backs off, and tries again', () => {
    const acct = { uid: 'u1', freq: 'daily', weekStart: 1 };
    it('records the failure and the reason, and does not count it as a copy', async () => {
        const w = world({ users: { u1: userDoc() }, dbOpts: { failCommit: true } });
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ backedUp: 0, failed: 1 });
        expect(rpCount(w.db, 'u1')).toBe(0);
        expect(statusOf(w.db, 'u1')).toMatchObject({ success: false, failCount: 1, by: 'server' });
        expect(statusOf(w.db, 'u1').reason).toMatch(/refused the write/);
        expect(logs.join('\n')).toMatch(/\[WF-BACKUP\] account u1 backup failed: your account refused the write/);
    });
    it('waits out the back-off (5 min, then 15 min, then 1 h), and counts the streak', async () => {
        const w = world({ users: { u1: userDoc() }, dbOpts: { failCommit: true } });
        const run = (now) => backupAccount({ db: w.db, admin: w.admin, acct, deps: w.deps, now });
        expect((await run(NOW)).outcome).toBe('failed');
        expect((await run(NOW + 4 * MIN))).toMatchObject({ outcome: 'fresh', why: 'backoff' });
        expect((await run(NOW + 6 * MIN)).outcome).toBe('failed');
        expect(statusOf(w.db, 'u1').failCount).toBe(2);
        expect((await run(NOW + 6 * MIN + 14 * MIN))).toMatchObject({ outcome: 'fresh', why: 'backoff' });
        expect((await run(NOW + 6 * MIN + 16 * MIN)).outcome).toBe('failed');
        expect(statusOf(w.db, 'u1').failCount).toBe(3);
    });
    it('the retry that works clears the streak', async () => {
        const w = world({ users: { u1: userDoc() }, dbOpts: { failCommit: true } });
        await backupAccount({ db: w.db, admin: w.admin, acct, deps: w.deps, now: NOW });
        w.db.state.failCommit = false;
        const r = await backupAccount({ db: w.db, admin: w.admin, acct, deps: w.deps, now: NOW + 10 * MIN });
        expect(r.outcome).toBe('backed-up');
        expect(statusOf(w.db, 'u1')).toMatchObject({ success: true, failCount: 0 });
    });
    it('an account that throws does not stop the others', async () => {
        const w = world({ users: { a: userDoc(), b: userDoc() } });
        const real = w.deps.accountState;
        w.deps.accountState = async (x) => { if (x.uid === 'a') throw new Error('boom'); return real(x); };
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ failed: 1, backedUp: 1 });
        expect(rpCount(w.db, 'b')).toBe(1);
        expect(logs.join('\n')).toMatch(/account a errored: boom/);
    });
});

/* ------------------------------------------------------------------ Google Drive */

describe('Google Drive, from the server', () => {
    it('mintDriveToken uses the same client the page uses, and never returns the refresh token', async () => {
        const net = makeNet();
        const m = await mintDriveToken({ fetch: net.fetch, env: { GOOGLE_OAUTH_CLIENT_SECRET: 's' }, refreshToken: REFRESH_OK });
        expect(m).toEqual({ ok: true, token: ACCESS });
        expect(net.tokenCalls[0]).toMatchObject({ client_id: DEFAULT_CLIENT_ID, grant_type: 'refresh_token', refresh_token: REFRESH_OK });
        expect(DEFAULT_CLIENT_ID).toMatch(/i2p46jo/);
    });
    it('mintDriveToken: an env override of the client id wins; every refusal has a name and nothing throws', async () => {
        const net = makeNet();
        await mintDriveToken({ fetch: net.fetch, env: { GOOGLE_OAUTH_CLIENT_SECRET: 's', GOOGLE_OAUTH_CLIENT_ID: 'custom-id' }, refreshToken: REFRESH_OK });
        expect(net.tokenCalls[0].client_id).toBe('custom-id');
        expect(await mintDriveToken({ fetch: net.fetch, env: {}, refreshToken: REFRESH_OK })).toEqual({ ok: false, reason: 'not_configured' });
        expect(await mintDriveToken({ fetch: net.fetch, env: { GOOGLE_OAUTH_CLIENT_SECRET: 's' }, refreshToken: '' })).toEqual({ ok: false, reason: 'not-connected' });
        expect(await mintDriveToken({ fetch: net.fetch, env: { GOOGLE_OAUTH_CLIENT_SECRET: 's' }, refreshToken: 'revoked' })).toEqual({ ok: false, reason: 'invalid_grant' });
        expect(await mintDriveToken({ fetch: makeNet({ tokenStatus: 503 }).fetch, env: { GOOGLE_OAUTH_CLIENT_SECRET: 's' }, refreshToken: REFRESH_OK })).toEqual({ ok: false, reason: 'server_error' });
        expect(await mintDriveToken({ fetch: makeNet({ tokenThrows: true }).fetch, env: { GOOGLE_OAUTH_CLIENT_SECRET: 's' }, refreshToken: REFRESH_OK })).toEqual({ ok: false, reason: 'network' });
    });

    it('a connected account gets a VERIFIED file in its own "WealthFlow Backups" folder, and the restore point is annotated', async () => {
        const net = makeNet();
        const w = world({ users: { u1: userDoc({ refresh: REFRESH_OK }) }, net });
        const r = await call(w.deps);
        expect(r.json.results[0]).toMatchObject({ outcome: 'backed-up', restorePoint: 'saved', drive: 'verified' });
        const files = [...net.drive.files.values()];
        const folder = files.find((f) => f.mimeType === 'application/vnd.google-apps.folder');
        const file = files.find((f) => f.name.startsWith('WealthFlow_'));
        expect(folder.name).toBe(DRIVE_FOLDER_NAME);
        expect(folder.parents).toEqual(['root']);
        expect(file.parents).toEqual([folder.id]);
        expect(file.name).toMatch(/^WealthFlow_u1@example\.lk_u1_/);
        expect(file.appProperties.sha).toMatch(/^[0-9a-f]{64}$/);
        const st = statusOf(w.db, 'u1');
        expect(st.drive).toMatchObject({ ok: true, size: file.size, folderId: folder.id });
        const rp = (await listSnapshots({ db: w.db, uid: 'u1' }))[0];
        expect(rp.drive).toMatchObject({ ok: true, size: file.size });
        // the file is the same bytes as the restore point, and carries no credential
        expect(file.text).toBe(w.db.store.get('users/u1/backupData/' + rp.id).data);
        expect(file.text).not.toContain(REFRESH_OK);
    });

    it('never writes a token, a refresh token or a record into the log or the response', async () => {
        const net = makeNet();
        const w = world({ users: { u1: userDoc({ refresh: REFRESH_OK }), u2: userDoc({ refresh: 'revoked-refresh-xyz' }) }, net });
        const r = await call(w.deps);
        const everything = logs.join('\n') + '\n' + JSON.stringify(r.json) + '\n' + JSON.stringify(statusOf(w.db, 'u1')) + JSON.stringify(statusOf(w.db, 'u2'));
        [REFRESH_OK, 'revoked-refresh-xyz', ACCESS + '"', 'client-secret-value', 'private-note-', 'cron-secret'].forEach((secret) => {
            expect(everything, `"${secret}" leaked`).not.toContain(secret);
        });
    });

    it('a revoked refresh token fails the Drive half only: the restore point stands, and the card says "reconnect"', async () => {
        const w = world({ users: { u1: userDoc({ refresh: 'revoked' }) }, net: makeNet() });
        const r = await call(w.deps);
        expect(r.json.results[0]).toMatchObject({ outcome: 'backed-up', restorePoint: 'saved', drive: 'invalid_grant' });
        const st = statusOf(w.db, 'u1');
        expect(st).toMatchObject({ success: true });
        expect(st.drive).toMatchObject({ ok: false, reason: 'invalid_grant' });
        const rp = (await listSnapshots({ db: w.db, uid: 'u1' }))[0];
        const card = describeBackup({ freq: 'daily', lastGoodMs: rp.atMs, rp, drive: { ok: false, reason: st.drive.reason }, attempt: { success: true, atMs: st.atMs }, now: NOW + HOUR });
        expect(card.level).toBe('warn');
        expect(card.lines.map((l) => l.text).join(' ')).toMatch(/Reconnect Google Drive/);
    });

    it('a full Drive is reported as such while the restore point stands', async () => {
        const net = makeNet({ drive: makeDrive({ valid: ACCESS, quota: true }) });
        const w = world({ users: { u1: userDoc({ refresh: REFRESH_OK }) }, net });
        const r = await call(w.deps);
        expect(r.json.results[0]).toMatchObject({ outcome: 'backed-up', drive: 'storageQuotaExceeded' });
        expect(statusOf(w.db, 'u1').drive.reason).toBe('storageQuotaExceeded');
    });

    it('without GOOGLE_OAUTH_CLIENT_SECRET the Drive half is not attempted (and nothing is called)', async () => {
        const net = makeNet();
        const w = world({ users: { u1: userDoc({ refresh: REFRESH_OK }) }, net, env: { GOOGLE_OAUTH_CLIENT_SECRET: '' } });
        const r = await call(w.deps);
        expect(r.json.results[0]).toMatchObject({ outcome: 'backed-up', drive: 'not-connected' });
        expect(net.tokenCalls).toEqual([]);
        expect(net.drive.calls).toEqual([]);
    });

    it('an account that never connected Drive is never sent to Google', async () => {
        const net = makeNet();
        const w = world({ users: { u1: userDoc() }, net });
        await call(w.deps);
        expect(net.tokenCalls).toEqual([]);
        expect(net.drive.calls).toEqual([]);
    });

    it('unchanged data is confirmed on the next night, not uploaded to Drive and the account again', async () => {
        const net = makeNet();
        const w = world({ users: { u1: userDoc({ refresh: REFRESH_OK }) }, net });
        await call(w.deps);
        // next night, nothing changed: the restore point is confirmed, the Drive file is confirmed, nothing new is uploaded
        const deps2 = { ...w.deps, now: () => NOW + DAY };
        const r = await call(deps2);
        expect(r.json.results[0].outcome).toBe('backed-up');
        const uploaded = [...net.drive.files.values()].filter((f) => f.name.startsWith('WealthFlow_'));
        expect(uploaded).toHaveLength(1);
        expect(rpCount(w.db, 'u1')).toBe(1);
    });
});

/* ------------------------------------------------------------------ limits */

describe('one run stays inside its budget', () => {
    it('backs up at most MAX_BACKUPS accounts and reports how many were left for the next run', async () => {
        const users = {};
        for (let i = 0; i < MAX_BACKUPS + 5; i++) users['u' + String(i).padStart(3, '0')] = userDoc();
        const w = world({ users });
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ accounts: MAX_BACKUPS + 5, backedUp: MAX_BACKUPS, leftOver: 5 });
        expect(logs.join('\n')).toMatch(/leftOver=5/);
        // the next run picks up exactly those, and nobody is backed up twice
        const again = await call(w.deps);
        expect(again.json).toMatchObject({ backedUp: 5, fresh: MAX_BACKUPS, leftOver: 0 });
    });
    it('accounts with nothing in them do not use up the cap that real copies are limited by', async () => {
        const users = {};
        for (let i = 0; i < MAX_BACKUPS + 10; i++) users['a' + String(i).padStart(3, '0')] = { settings: { autoBackupFreq: 'daily' } };   // sorts first
        users.z1 = userDoc(); users.z2 = userDoc(); users.z3 = userDoc();
        const w = world({ users });
        const r = await call(w.deps);
        expect(r.json).toMatchObject({ backedUp: 3, empty: MAX_BACKUPS + 10, leftOver: 0 });
        expect(rpCount(w.db, 'z1') + rpCount(w.db, 'z2') + rpCount(w.db, 'z3')).toBe(3);
    });
    it('stops when the time budget is spent', async () => {
        const w = world({ users: { a: userDoc(), b: userDoc() } });
        let t = 0;
        w.deps.clock = () => { t += 30000; return t; };
        const r = await call(w.deps);
        expect(r.json.leftOver).toBeGreaterThan(0);
    });
    it('pages through more accounts than one query returns, and across all three frequencies', async () => {
        const users = {};
        for (let i = 0; i < SCAN_PAGE + 50; i++) users['d' + String(i).padStart(4, '0')] = { settings: { autoBackupFreq: 'daily' } };   // no data: scanned, cheap
        users.w1 = userDoc({ freq: 'weekly' });
        users.m1 = userDoc({ freq: 'monthly' });
        users.off = { settings: { autoBackupFreq: 'off' } };
        const w = world({ users });
        const r = await call(w.deps);
        expect(r.json.accounts, 'the second page of daily accounts, the weekly and the monthly one were not all read').toBe(SCAN_PAGE + 50 + 2);
        expect(r.json.accounts).toBeGreaterThan(SCAN_PAGE);
    });
    it('writes one summary line a run (counts only)', async () => {
        const w = world({ users: { a: userDoc(), b: userDoc({ freq: 'monthly' }) } });
        await call(w.deps);
        const line = logs.find((l) => l.includes('[WF-CRON] backup-sweep accounts='));
        expect(line).toMatch(/accounts=2 fresh=0 backedUp=2 failed=0 empty=0 skipped=0 leftOver=0/);
    });
});

/* ------------------------------------------------------------------ the page and the server agree */

describe('the page and the server run share one rule', () => {
    it('a copy the server made is the newest real copy for the page, so the page does not repeat the night', async () => {
        const w = world({ users: { u1: userDoc() } });
        await call(w.deps);
        const rp = (await listSnapshots({ db: w.db, uid: 'u1', limit: 1 }))[0];
        const status = await readStatus({ db: w.db, uid: 'u1' });
        const lastGoodMs = Math.max(rp.confirmedAtMs || 0, rp.atMs || 0);
        const verdict = backupDue({ freq: 'daily', lastGoodMs, failedAtMs: status.success === false ? status.atMs : 0, failCount: status.failCount || 0, now: NOW + 10 * MIN, tzOffsetMin: SERVER_TZ_OFFSET_MIN });
        expect(verdict).toEqual({ due: false, why: 'fresh' });
    });
    it('is due again after the NEXT 23:55 trigger', async () => {
        const w = world({ users: { u1: userDoc() } });
        await call(w.deps);
        const next = await call({ ...w.deps, now: () => NOW + DAY });
        expect(next.json).toMatchObject({ backedUp: 1 });
    });
});
