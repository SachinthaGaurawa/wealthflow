/* =============================================================================
 * test/sms_handlers_test.js — the two doors into the SMS engine
 * -----------------------------------------------------------------------------
 * /api/sms-notify  (a signed-in owner's app)  and  /api/sms-sweep  (the cron).
 * What is pinned is WHO may get in and WHAT a caller can and cannot choose: an
 * authenticated stranger must not spend the balance, a request body must not be able
 * to name a recipient, and the cron must refuse everything when its secret is unset.
 * Nothing here touches a network: the gateway is a stub, Firestore is in memory.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { handleNotify, MIN_KICK_GAP_MS, HEALTH_TTL_MS, gatewayHealth } from '../sms-notify.js';
import { handleSweep, MAX_USERS, TOTAL_BUDGET_MS, ACTIVE_PAGE, accountStillAllowed } from '../sms-sweep.js';
import { allowedEmails, smsAllowed } from '../sms-access.mjs';
import { FIELDS } from '../sms-events.mjs';
import { KIND } from '../textlk.mjs';

const NOW = Date.parse('2026-10-05T05:00:00Z');                  // 10:30 in Colombo: inside the sending window
const OWNER = { uid: 'owner1', email: 'owner@example.com' };
const STRANGER = { uid: 'stranger9', email: 'someone@else.org' };

function res() {
    const r = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { r.headers[k] = v; }, end(b) { r.body = b ? JSON.parse(b) : null; } };
    return r;
}
const req = (over = {}) => ({ method: 'POST', url: '/api/sms-notify', headers: { authorization: 'Bearer good-token' }, body: {}, ...over });

function gateway({ units = 50, balanceKind = null, configured = true } = {}) {
    const sent = []; const calls = { balance: 0 };
    return {
        configured, senderId: 'WEALTHFLOW', sent, calls,
        async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; },
        async balance() { calls.balance += 1; return balanceKind ? { ok: false, kind: balanceKind, retryable: false, message: 'x' } : { ok: true, units }; },
    };
}

function books() {
    return {
        settings: { currency: 'LKR' },
        debtors: [{
            id: 'd1', name: 'Nimal', phone: '077 123 4567', nic: '853400937V',
            [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3,
            events: [{ id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: NOW - 1800e3 }],
        }],
    };
}

// `authUsers` is what Firebase Auth says about a uid when the cron asks again: the owner's verified account unless the test says otherwise
// (an object is that account's record, null is "deleted", an Error is an outage).
function world({ tokens, env = {}, client = gateway(), now = NOW, noDb = false, authUsers = {} } = {}) {
    const fs = createFirestore();
    const tokenTable = tokens || { 'good-token': { ...OWNER, email_verified: true } };
    const getUser = async (uid) => {
        const u = authUsers[uid];
        if (u === null) throw Object.assign(new Error('no such user'), { code: 'auth/user-not-found' });
        if (u instanceof Error) throw u;
        return { uid, email: OWNER.email, emailVerified: true, disabled: false, ...(u || {}) };
    };
    const admin = { auth: () => ({ getUser, verifyIdToken: async (t) => { if (!tokenTable[t]) throw new Error('bad token'); return tokenTable[t]; } }) };
    const deps = {
        client: () => client,
        getAdminDb: async () => (noDb ? { db: null, reason: 'no service account' } : { db: fs.db, admin }),
        env: { SMS_ALLOWED_EMAILS: OWNER.email, TENANT_PORTAL_LINKS: 'on', WEALTHFLOW_PUBLIC_ORIGIN: 'https://wealthflow-personal.vercel.app', FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ private_key: 'k'.repeat(64) }), ...env },
        now: () => now,
        clock: () => now,
    };
    return { fs, deps, client };
}
const putUser = (fs, uid, doc) => fs.db.collection('users').doc(uid).set(doc);
const wfDocs = (fs) => [...fs.data.keys()].filter((p) => p.startsWith('wf-sms/'));

describe('who may use /api/sms-notify', () => {
    it('refuses a method it does not serve', async () => {
        const { deps } = world(); const r = res();
        await handleNotify(req({ method: 'DELETE' }), r, deps);
        expect(r.statusCode).toBe(405);
    });

    it('no token, a bad token and an unverified email are all refused, and nothing is sent or written', async () => {
        const w = world({ tokens: { 'good-token': { ...OWNER, email_verified: true }, 'unverified': { ...OWNER, email_verified: false } } });
        await putUser(w.fs, OWNER.uid, books());
        const none = res(); await handleNotify(req({ headers: {} }), none, w.deps);
        const bad = res(); await handleNotify(req({ headers: { authorization: 'Bearer nope' } }), bad, w.deps);
        const unv = res(); await handleNotify(req({ headers: { authorization: 'Bearer unverified' } }), unv, w.deps);
        expect(none.statusCode).toBe(401);
        expect(bad.statusCode).toBe(401);
        expect(unv.statusCode).toBe(403);
        expect(w.client.sent).toHaveLength(0);
        expect(wfDocs(w.fs)).toHaveLength(0);
    });

    it('a token that carries no user id is refused rather than writing to a document called ""', async () => {
        const w = world({ tokens: { 'good-token': { email: OWNER.email, email_verified: true } } });
        const r = res(); await handleNotify(req(), r, w.deps);
        expect(r.statusCode).toBe(401);
        expect(wfDocs(w.fs)).toHaveLength(0);
    });

    it('a signed-in stranger cannot spend the balance: 403, nothing sent, nothing written, nothing said about the gateway', async () => {
        const w = world({ tokens: { 'good-token': { ...STRANGER, email_verified: true } } });
        await putUser(w.fs, STRANGER.uid, books());                         // their own books, switched on, with a phone number of their choosing
        const r = res(); await handleNotify(req(), r, w.deps);
        expect(r.statusCode).toBe(403);
        expect(JSON.stringify(r.body)).not.toMatch(/textlk|token|balance|units|sender/i);
        expect(w.client.sent).toHaveLength(0);
        expect(wfDocs(w.fs)).toHaveLength(0);
    });

    it('with no allow-list configured nobody is let in', async () => {
        const w = world({ env: { SMS_ALLOWED_EMAILS: '' } });
        await putUser(w.fs, OWNER.uid, books());
        const r = res(); await handleNotify(req(), r, w.deps);
        expect(r.statusCode).toBe(403);
        expect(w.client.sent).toHaveLength(0);
    });

    it('an admin claim is enough, and the allow-list ignores case and spacing', async () => {
        const w = world({ tokens: { 'good-token': { ...STRANGER, email_verified: true, admin: true } }, env: { SMS_ALLOWED_EMAILS: '' } });
        await putUser(w.fs, STRANGER.uid, books());
        const r = res(); await handleNotify(req(), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(smsAllowed({ email: ' Owner@Example.COM ' }, { SMS_ALLOWED_EMAILS: 'a@b.c, owner@example.com ;x@y.z' }).ok).toBe(true);
        expect(allowedEmails({ SMS_ALLOWED_EMAILS: ' A@B.C ,, ;' })).toEqual(new Set(['a@b.c']));
        expect(smsAllowed({ email: '' }, { SMS_ALLOWED_EMAILS: ',' }).ok).toBe(false);
        expect(smsAllowed({ email: 'a@b.c', claims: { admin: 'true' } }, {}).ok).toBe(false);          // only a real boolean true is an admin
    });

    it('reports a missing database as 503, after the caller has been identified', async () => {
        const w = world({ noDb: true });
        const r = res(); await handleNotify(req(), r, w.deps);
        expect(r.statusCode).toBe(503);
        const anon = res(); await handleNotify(req({ headers: {} }), anon, w.deps);
        expect(anon.statusCode).toBe(401);
    });
});

describe('what a caller can and cannot choose', () => {
    it('the books decide the recipient, the amount and the words; the request body decides nothing', async () => {
        const w = world();
        await putUser(w.fs, OWNER.uid, books());
        const r = res();
        await handleNotify(req({ body: { to: '+94700000000', message: 'win a prize at evil.example', amount: 1e9, kind: 'otp', uid: 'victim', phone: '0711111111' } }), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(w.client.sent).toHaveLength(1);
        expect(w.client.sent[0].to).toBe('+94771234567');
        expect(w.client.sent[0].message).toMatch(/^Loan LKR 50,000\.00 disbursed on 05 Oct 2026, ref DEB-[0-9A-F]{6}\. Balance LKR 50,000\.00\. Statement: https:\/\/wealthflow-personal\.vercel\.app\/t\/[A-Za-z0-9_-]{16}$/);
        expect(w.client.sent[0].message).not.toContain('evil');
        expect(wfDocs(w.fs).some((p) => p.includes('victim'))).toBe(false);          // the uid is the token's, never the body's
    });

    it('works on the caller\'s own books only: another account\'s records are never read', async () => {
        const w = world();
        await putUser(w.fs, OWNER.uid, { settings: {}, debtors: [] });
        await putUser(w.fs, 'other', books());                                // a different account, fully switched on
        const r = res(); await handleNotify(req(), r, w.deps);
        expect(w.client.sent).toHaveLength(0);
    });

    it('two kicks inside the throttle window are one; force goes through; and it is the ledger, not the throttle, that prevents doubles', async () => {
        let t = NOW;
        const w = world(); w.deps.now = () => t;
        await putUser(w.fs, OWNER.uid, books());
        const a = res(); await handleNotify(req(), a, w.deps);
        expect(a.body.summary.sent).toBe(1);
        t += 1000;
        const b = res(); await handleNotify(req(), b, w.deps);
        expect(b.body).toEqual({ ok: true, throttled: true });
        const c = res(); await handleNotify(req({ body: { force: true } }), c, w.deps);
        expect(c.body.summary.sent).toBe(0);                                    // nothing new is owed: the ledger remembers
        t += MIN_KICK_GAP_MS + 1;
        const d = res(); await handleNotify(req(), d, w.deps);
        expect(d.body.summary).toBeDefined();
        expect(w.client.sent).toHaveLength(1);
    });

    it('registers only accounts that use SMS: an owner with no switched-on records never joins the cron list', async () => {
        const w = world();
        await putUser(w.fs, OWNER.uid, { settings: {}, debtors: [{ id: 'd', name: 'x', events: [] }] });
        const r = res(); await handleNotify(req(), r, w.deps);
        expect(r.body.summary.idle).toBe(true);
        const root = w.fs.data.get(`wf-sms/${OWNER.uid}`);
        expect(root && root.active).not.toBe(true);
        const w2 = world();
        await putUser(w2.fs, OWNER.uid, books());
        const r2 = res(); await handleNotify(req(), r2, w2.deps);
        expect(w2.fs.data.get(`wf-sms/${OWNER.uid}`)).toMatchObject({ active: true, email: OWNER.email, hadRecords: true });
    });

    it('a user document that does not exist is an empty answer, not an error', async () => {
        const w = world();
        const r = res(); await handleNotify(req(), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(r.body.summary.empty).toBe(true);
    });

    it('a failure inside the sweep is a plain 500 that leaks nothing', async () => {
        const w = world();
        await putUser(w.fs, OWNER.uid, books());
        const orig = w.fs.db.runTransaction.bind(w.fs.db);
        w.fs.db.runTransaction = async () => { throw new Error('secret internal detail TEXTLK_API_TOKEN=abc'); };
        const r = res(); await handleNotify(req(), r, w.deps);
        w.fs.db.runTransaction = orig;
        expect(r.statusCode).toBe(500);
        expect(JSON.stringify(r.body)).not.toMatch(/secret|TEXTLK|abc/);
    });

    it('GET (authenticated) says whether this account may use it and whether the gateway is set up, and sends nothing', async () => {
        const w = world();
        const r = res(); await handleNotify(req({ method: 'GET' }), r, w.deps);
        expect(r.body).toEqual({ ok: true, allowed: true, configured: true });
        expect(w.client.sent).toHaveLength(0);
        const denied = world({ tokens: { 'good-token': { ...STRANGER, email_verified: true } } });
        const d = res(); await handleNotify(req({ method: 'GET' }), d, denied.deps);
        expect(d.statusCode).toBe(403);
    });
});

describe('GET ?check=1, the owner\'s "is it wired up" probe', () => {
    const probe = (w, headers = {}) => { const r = res(); return handleNotify(req({ method: 'GET', url: '/api/sms-notify?check=1', headers }), r, w.deps).then(() => r); };

    it('needs no sign-in, sends nothing, and shows two booleans and nothing else: no credit level, no sender, no failure kind', async () => {
        const w = world({ client: gateway({ units: 3 }) });
        const r = await probe(w);
        expect(r.statusCode).toBe(200);
        expect(r.body).toEqual({ ok: true, configured: true, tokenAccepted: true });
        expect(w.client.sent).toHaveLength(0);
    });

    it('an allowed signed-in account also sees whether the gateway is reachable, the credit warning and the sender id, never a balance', async () => {
        const w = world({ client: gateway({ units: 3 }) });
        const r = await probe(w, { authorization: 'Bearer good-token' });
        expect(r.body).toMatchObject({ ok: true, configured: true, tokenAccepted: true, reachable: true, lowCredit: true, senderId: 'WEALTHFLOW' });
        expect(JSON.stringify(r.body)).not.toMatch(/"units"|\b3\b/);
        const stranger = world({ tokens: { 'good-token': { ...STRANGER, email_verified: true } }, client: gateway({ units: 3 }) });
        expect((await probe(stranger, { authorization: 'Bearer good-token' })).body).toEqual({ ok: true, configured: true, tokenAccepted: true });
        const forged = await probe(w, { authorization: 'Bearer forged' });
        expect(forged.body).toEqual({ ok: true, configured: true, tokenAccepted: true });
    });

    it('says so when the token is missing, rejected, or the account is out of credit', async () => {
        expect((await probe(world({ client: gateway({ configured: false }) }))).body).toEqual({ ok: true, configured: false, tokenAccepted: false });
        expect((await probe(world({ client: gateway({ balanceKind: KIND.AUTH }) }))).body).toEqual({ ok: true, configured: true, tokenAccepted: false });
        const credit = await probe(world({ client: gateway({ balanceKind: KIND.CREDIT }) }), { authorization: 'Bearer good-token' });
        expect(credit.body).toMatchObject({ tokenAccepted: true, lowCredit: true, failure: KIND.CREDIT });
    });

    it('asks the gateway at most once every 30 seconds, however often it is called', async () => {
        let t = NOW;
        const w = world({ client: gateway({ units: 50 }) }); w.deps.now = () => t;
        for (let i = 0; i < 20; i += 1) await probe(w);
        expect(w.client.calls.balance).toBe(1);
        t += HEALTH_TTL_MS + 1;
        await probe(w);
        expect(w.client.calls.balance).toBe(2);
    });

    it('a gateway that is down is reported as not accepted, not as a crash', async () => {
        const client = gateway(); client.balance = async () => { throw new Error('boom'); };
        const r = await probe(world({ client }));
        expect(r.statusCode).toBe(200);
        expect(r.body).toEqual({ ok: true, configured: true, tokenAccepted: false });
        expect((await gatewayHealth(gateway({ balanceKind: KIND.NETWORK }))).reachable).toBe(false);
    });
});

describe('/api/sms-sweep, the cron', () => {
    const cron = (over = {}) => req({ method: 'GET', url: '/api/sms-sweep', headers: { authorization: 'Bearer cron-secret' }, ...over });
    const cronWorld = (o = {}) => world({ ...o, env: { CRON_SECRET: 'cron-secret', ...(o.env || {}) } });

    it('refuses everything while its secret is unset, and refuses a wrong or missing credential', async () => {
        const unset = world();
        const a = res(); await handleSweep(cron(), a, unset.deps);
        expect(a.statusCode).toBe(503);
        const w = cronWorld();
        const none = res(); await handleSweep(cron({ headers: {} }), none, w.deps);
        const wrong = res(); await handleSweep(cron({ headers: { authorization: 'Bearer cron-secreT' } }), wrong, w.deps);
        const user = res(); await handleSweep(cron({ headers: { authorization: 'Bearer good-token' } }), user, w.deps);      // a signed-in user's token is not the cron's
        expect(none.statusCode).toBe(401);
        expect([wrong.statusCode, user.statusCode]).toEqual([401, 401]);
        expect(w.client.sent).toHaveLength(0);
        expect(w.client.calls.balance).toBe(0);
        const m = res(); await handleSweep(cron({ method: 'DELETE' }), m, w.deps);
        expect(m.statusCode).toBe(405);
    });

    it('sweeps every registered account, and only those', async () => {
        const w = cronWorld();
        for (const uid of ['u1', 'u2']) { await putUser(w.fs, uid, books()); await w.fs.db.collection('wf-sms').doc(uid).set({ active: true, lastSweepAt: 0 }); }
        await putUser(w.fs, 'u3', books());                                   // never registered
        await w.fs.db.collection('wf-sms').doc('u4').set({ active: false });   // switched off
        await putUser(w.fs, 'u4', books());
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(r.body.accounts).toBe(2);
        expect(w.client.sent).toHaveLength(2);
        expect(w.fs.data.get('wf-sms/u1').lastSweepAt).toBe(NOW);
        expect(w.fs.data.has('wf-sms/u3')).toBe(false);
        expect(r.body.results.every((x) => x.uid.length <= 6)).toBe(true);        // the report never carries a whole user id
    });

    it('the oldest-swept account goes first, so a long list is covered across runs', async () => {
        const w = cronWorld();
        const order = [];
        const orig = w.fs.db.collection.bind(w.fs.db);
        for (const [uid, at] of [['young', 900], ['old', 100], ['mid', 500]]) {
            await putUser(w.fs, uid, { settings: {}, debtors: [] });
            await w.fs.db.collection('wf-sms').doc(uid).set({ active: true, lastSweepAt: at });
        }
        w.fs.db.collection = (name) => { const c = orig(name); if (name !== 'users') return c; return { ...c, doc: (id) => { order.push(id); return c.doc(id); } }; };
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect([...new Set(order)]).toEqual(['old', 'mid', 'young']);        // (the mirror touches users/{uid}/smsLog too, hence the de-duplication)
    });

    it('one account failing does not stop the rest, and says so without leaking the error', async () => {
        const w = cronWorld();
        for (const uid of ['bad', 'good']) { await putUser(w.fs, uid, books()); await w.fs.db.collection('wf-sms').doc(uid).set({ active: true, lastSweepAt: uid === 'bad' ? 0 : 1 }); }
        const orig = w.fs.db.collection.bind(w.fs.db);
        w.fs.db.collection = (name) => { const c = orig(name); if (name !== 'users') return c; return { ...c, doc: (id) => (id === 'bad' ? { get: async () => { throw new Error('disk on fire'); } } : c.doc(id)) }; };
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(r.body.results.find((x) => x.uid === 'bad')).toEqual({ uid: 'bad', error: true });
        expect(w.client.sent).toHaveLength(1);
        expect(JSON.stringify(r.body)).not.toContain('disk on fire');
    });

    it('checks the balance once per run and flags low credit', async () => {
        const w = cronWorld({ client: gateway({ units: 2 }) });
        for (const uid of ['u1', 'u2']) { await putUser(w.fs, uid, { settings: {}, debtors: [] }); await w.fs.db.collection('wf-sms').doc(uid).set({ active: true }); }
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(w.client.calls.balance).toBe(1);
        expect(r.body).toMatchObject({ lowCredit: true, balanceCheck: 'ok' });
        expect(JSON.stringify(r.body)).not.toMatch(/"units"/);
    });

    it('survives a gateway with no token: nothing is sent, everything stays queued, and the run still reports', async () => {
        const w = cronWorld({ client: gateway({ configured: false }) });
        await putUser(w.fs, 'u1', books()); await w.fs.db.collection('wf-sms').doc('u1').set({ active: true });
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(w.client.sent).toHaveLength(0);
        const queued = [...w.fs.data.entries()].filter(([p, v]) => p.startsWith('wf-sms/u1/events/') && v.status === 'queued');
        expect(queued).toHaveLength(1);
        expect(w.client.calls.balance).toBe(0);
    });

    it('stops starting accounts once its total time is spent', async () => {
        const w = cronWorld();
        let t = NOW; w.deps.clock = () => { const v = t; t += TOTAL_BUDGET_MS / 2; return v; };
        for (const uid of ['a', 'b', 'c', 'd']) { await putUser(w.fs, uid, { settings: {}, debtors: [] }); await w.fs.db.collection('wf-sms').doc(uid).set({ active: true }); }
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.body.results.some((x) => x.skipped)).toBe(true);
        expect(r.body.accounts).toBeLessThan(5);
        expect(MAX_USERS).toBeGreaterThan(0);
    });

    it('reports a missing database as 503', async () => {
        const w = cronWorld({ noDb: true });
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.statusCode).toBe(503);
    });
});

describe('/api/sms-sweep: who is still allowed, and who is looked at', () => {
    const cron = (over = {}) => req({ method: 'GET', url: '/api/sms-sweep', headers: { authorization: 'Bearer cron-secret' }, ...over });
    const cronWorld = (o = {}) => world({ ...o, env: { CRON_SECRET: 'cron-secret', ...(o.env || {}) } });
    const register = async (w, uid, extra = {}) => { await putUser(w.fs, uid, books()); await w.fs.db.collection('wf-sms').doc(uid).set({ active: true, lastSweepAt: 0, ...extra }); };
    const root = (w, uid) => w.fs.data.get(`wf-sms/${uid}`);

    it('an account that is no longer on the allow-list is switched off and sends nothing, with the reason kept for the owner', async () => {
        const w = cronWorld({ authUsers: { gone: { email: 'former@example.com' } } });
        await register(w, 'gone'); await register(w, 'kept');
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(w.client.sent).toHaveLength(1);                                    // only the owner's
        expect(root(w, 'gone')).toMatchObject({ active: false, deactivatedAt: NOW });
        expect(root(w, 'gone').deactivatedReason).toMatch(/not enabled for this account/);
        expect(root(w, 'kept').active).toBe(true);
        expect(r.body.results.find((x) => x.uid === 'gone')).toEqual({ uid: 'gone', deactivated: true });
        expect([...w.fs.data.keys()].filter((k) => k.startsWith('wf-sms/gone/events/'))).toHaveLength(0);      // nothing was even queued
        const again = res(); await handleSweep(cron(), again, w.deps);
        expect(again.body.accounts).toBe(1);                                      // and it is not looked at again
    });

    it('is switched back on by the owner\'s next visit once the account is allowed again', async () => {
        const w = cronWorld({ authUsers: { owner1: { email: 'former@example.com' } } });
        await register(w, 'owner1');
        await handleSweep(cron(), res(), w.deps);
        expect(root(w, 'owner1').active).toBe(false);
        const back = world({ env: { CRON_SECRET: 'cron-secret' } });             // the allow-list has the owner again
        for (const [k, v] of w.fs.data) back.fs.data.set(k, v);
        const r = res(); await handleNotify(req({ body: { force: true } }), r, back.deps);
        expect(r.statusCode).toBe(200);
        expect(back.fs.data.get('wf-sms/owner1').active).toBe(true);
    });

    it('keeps an account the admin claim allows even when its email is not on the list', async () => {
        const w = cronWorld({ env: { SMS_ALLOWED_EMAILS: '' }, authUsers: { boss: { email: 'boss@else.org', customClaims: { admin: true } } } });
        await register(w, 'boss');
        await handleSweep(cron(), res(), w.deps);
        expect(root(w, 'boss').active).toBe(true);
        expect(w.client.sent).toHaveLength(1);
    });

    it('switches off an account whose sign-in is disabled, deleted, or has no verified email', async () => {
        const w = cronWorld({ authUsers: { off: { disabled: true }, del: null, unv: { emailVerified: false }, fine: {} } });
        for (const uid of ['off', 'del', 'unv', 'fine']) await register(w, uid);
        await handleSweep(cron(), res(), w.deps);
        expect(['off', 'del', 'unv'].map((u) => root(w, u).active)).toEqual([false, false, false]);
        expect(root(w, 'del').deactivatedReason).toMatch(/no longer exists/);
        expect(root(w, 'fine').active).toBe(true);
        expect(w.client.sent).toHaveLength(1);
    });

    it('an outage of the sign-in service is not a verdict: the account is skipped this run and left exactly as it was', async () => {
        const w = cronWorld({ authUsers: { owner1: new Error('auth backend 503') } });
        await register(w, 'owner1');
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(w.client.sent).toHaveLength(0);                                    // nothing is sent on an identity nobody could confirm
        expect(root(w, 'owner1')).toEqual({ active: true, lastSweepAt: 0 });
        expect(r.body.results[0]).toMatchObject({ skipped: true });
        expect(JSON.stringify(r.body)).not.toContain('503');
    });

    it('without the sign-in service at all nothing is sent and nothing is switched off', async () => {
        const w = cronWorld();
        await register(w, 'owner1');
        w.deps.getAdminDb = async () => ({ db: w.fs.db, admin: {} });
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(w.client.sent).toHaveLength(0);
        expect(root(w, 'owner1').active).toBe(true);
    });

    it('switches off a registration whose data document is gone, so it cannot hold a place for ever', async () => {
        const w = cronWorld();
        await w.fs.db.collection('wf-sms').doc('ghost').set({ active: true, lastSweepAt: 0 });
        await register(w, 'owner1');
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(root(w, 'ghost')).toMatchObject({ active: false });
        expect(root(w, 'ghost').deactivatedReason).toMatch(/no data document/);
        const again = res(); await handleSweep(cron(), again, w.deps);
        expect(again.body.accounts).toBe(1);
    });

    it('reads past the first page of registered accounts, so one that sorts late is still swept', async () => {
        const w = cronWorld();
        // more registered accounts than one page holds, every one already swept recently, plus three that never were and sort last
        for (let i = 0; i < ACTIVE_PAGE * 2 + 5; i += 1) w.fs.data.set(`wf-sms/a${String(i).padStart(5, '0')}`, { active: true, lastSweepAt: NOW - 1000 });
        for (const uid of ['zz1', 'zz2', 'zz3']) { await register(w, uid); }
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.statusCode).toBe(200);
        const swept = (u) => root(w, u).lastSweepAt === NOW;
        expect(['zz1', 'zz2', 'zz3'].every(swept)).toBe(true);
        expect(r.body.accounts).toBeLessThanOrEqual(MAX_USERS);
    });

    it('names the order the pages are read in (the document id) and walks them with a cursor, so the paging does not rest on a default', async () => {
        const w = cronWorld();
        for (let i = 0; i < ACTIVE_PAGE + 3; i += 1) w.fs.data.set(`wf-sms/b${String(i).padStart(5, '0')}`, { active: true, lastSweepAt: NOW - 1000 });
        const seen = { order: [], after: 0, limits: [] };
        const orig = w.fs.db.collection.bind(w.fs.db);
        w.fs.db.collection = (name) => {
            const c = orig(name);
            if (name !== 'wf-sms') return c;
            const wrap = (q) => ({ ...q, orderBy: (f) => { seen.order.push(f); return wrap(q.orderBy(f)); }, startAfter: (d) => { seen.after += 1; return wrap(q.startAfter(d)); }, limit: (n) => { seen.limits.push(n); return wrap(q.limit(n)); }, where: (...a) => wrap(q.where(...a)) });
            return { ...wrap(c), doc: c.doc };
        };
        const base = w.deps.getAdminDb;
        w.deps.getAdminDb = async () => { const r = await base(); return { ...r, admin: { ...r.admin, firestore: { FieldPath: { documentId: () => '__id__' } } } }; };
        await handleSweep(cron(), res(), w.deps);
        expect(seen.order.length).toBeGreaterThanOrEqual(2);
        expect(seen.order.every((f) => f === '__id__')).toBe(true);
        expect(seen.after).toBeGreaterThanOrEqual(1);
        expect(seen.limits.every((n) => n === ACTIVE_PAGE)).toBe(true);
    });

    it('accountStillAllowed answers from Firebase Auth alone, and says "could not tell" for anything but a definite answer', async () => {
        const env = { SMS_ALLOWED_EMAILS: OWNER.email };
        const asks = (user) => accountStillAllowed({ admin: { auth: () => ({ getUser: async () => user }) }, uid: 'x', env });
        expect(await asks({ email: OWNER.email, emailVerified: true })).toEqual({ ok: true });
        expect((await asks({ email: OWNER.email, emailVerified: 'true' })).ok).toBe(false);          // only a real boolean
        expect((await asks({ email: OWNER.email, emailVerified: true, disabled: true })).ok).toBe(false);
        expect((await asks(null)).transient).toBe(true);
        expect((await accountStillAllowed({ admin: null, uid: 'x', env })).transient).toBe(true);
    });
});
