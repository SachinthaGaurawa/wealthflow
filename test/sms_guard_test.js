/* =============================================================================
 * test/sms_guard_test.js — the credit reserve, the sign-in breaker and the alert
 * -----------------------------------------------------------------------------
 * What is pinned: under the reserve ONLY the late-payment reminder waits (nothing else, nothing is dropped, nothing is rewritten) and it goes
 * on the first sweep that sees the balance back; an unreadable balance never stops a text; a sign-in service that does not answer never
 * switches an account off and never lets one through on a remembered answer, and stops costing a run its whole budget after three failures;
 * the alert goes to an https endpoint only, once a day, and carries no secret.
 * Nothing here touches a network: the gateway, Auth, the webhook and Firestore are stubs.
 * ===========================================================================*/

import { describe, it, expect, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { sweepUser, STATUS } from '../sms-engine.mjs';
import { FIELDS } from '../sms-events.mjs';
import { handleSweep, accountStillAllowed, AUTH_DEADLINE_MS } from '../sms-sweep.js';
import {
    creditReserve, creditPaused, isPausedKind, SignInBreaker, alertWebhookUrl, postAlert, decideAlerts, markAlerted, normalizeState,
    CREDIT_RESERVE_DEFAULT, ALERT_GAP_MS, AUTH_TRIP_AFTER, PAUSED_WHEN_LOW,
} from '../sms-guard.mjs';

const T = (iso) => Date.parse(iso);
const UID = 'owner1';
const NOW = T('2026-10-05T05:00:00Z');                          // 10:30 in Colombo: inside the sending window

describe('the reserve and what it pauses', () => {
    it('is 20 units unless set, 0 switches it off, and nonsense falls back to the default', () => {
        expect(CREDIT_RESERVE_DEFAULT).toBe(20);
        expect(creditReserve({})).toBe(20);
        expect(creditReserve({ SMS_CREDIT_RESERVE: '' })).toBe(20);
        expect(creditReserve({ SMS_CREDIT_RESERVE: '  ' })).toBe(20);
        expect(creditReserve({ SMS_CREDIT_RESERVE: '35' })).toBe(35);
        expect(creditReserve({ SMS_CREDIT_RESERVE: '0' })).toBe(0);
        expect(creditReserve({ SMS_CREDIT_RESERVE: '12.9' })).toBe(12);
        expect(creditReserve({ SMS_CREDIT_RESERVE: '-4' })).toBe(20);
        expect(creditReserve({ SMS_CREDIT_RESERVE: 'lots' })).toBe(20);
        expect(creditReserve({ SMS_CREDIT_RESERVE: '1e99' })).toBe(100000);
        expect(creditReserve(undefined)).toBe(20);
    });

    it('is under the reserve only for a known balance strictly below it', () => {
        expect(creditPaused(19, 20)).toBe(true);
        expect(creditPaused(20, 20)).toBe(false);
        expect(creditPaused(0, 20)).toBe(true);
        expect(creditPaused(5, 0)).toBe(false);                          // the rule is switched off
        expect(creditPaused(null, 20)).toBe(false);                      // not knowing never stops a text
        expect(creditPaused(undefined, 20)).toBe(false);
        expect(creditPaused('', 20)).toBe(false);
        expect(creditPaused(NaN, 20)).toBe(false);
    });

    it('pauses the late-payment reminder and nothing else', () => {
        expect(PAUSED_WHEN_LOW).toEqual(['B.late']);
        expect(isPausedKind('B.late')).toBe(true);
        for (const k of ['B.repayment', 'B.disbursed', 'B.closed', 'B.balance', 'A.closed', 'A.interest', '', undefined]) expect(isPausedKind(k)).toBe(false);
    });
});

function makeDb() {
    const fs = createFirestore();
    const db = fs.db;
    const orig = db.runTransaction.bind(db);
    let chain = Promise.resolve();
    db.runTransaction = (fn) => { const p = chain.then(() => orig(fn)); chain = p.catch(() => {}); return p; };
    return { fs, db };
}
const ledger = (fs) => [...fs.data.entries()].filter(([p]) => p.startsWith(`wf-sms/${UID}/events/`)).map(([p, v]) => ({ path: p, ...v }));
const status = (fs) => fs.data.get(`users/${UID}/smsLog/_status`) || {};
const env = { TENANT_PORTAL_LINKS: 'on', WEALTHFLOW_PUBLIC_ORIGIN: 'https://wealthflow-personal.vercel.app', FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ private_key: 'k'.repeat(64) }) };

function gateway({ units = 50, balanceKind = null, hasBalance = true } = {}) {
    const sent = []; const calls = { balance: 0 };
    const gw = {
        configured: true, senderId: 'WealthFlow', sent, calls, units,
        async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; },
        async balance() { calls.balance += 1; return balanceKind ? { ok: false, kind: balanceKind, retryable: false, message: 'x' } : { ok: true, units: gw.units }; },
    };
    if (!hasBalance) delete gw.balance;
    return gw;
}

/** One debtor who is late (a reminder is owed) and one fresh repayment (a receipt is owed). */
function books() {
    return {
        settings: { currency: 'LKR' },
        debtors: [{
            id: 'd1', name: 'Nimal', phone: '077 123 4567', nic: '853400937V', dueISO: '2026-10-04',
            [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3 * 86400e3, [FIELDS.REMIND]: true, [FIELDS.REMIND_AT]: NOW - 3 * 86400e3,
            events: [
                { id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-01', confirmed: true, at: NOW - 3 * 86400e3 },
                { id: 'e2', kind: 'repayment', amount: 10000, date: '2026-10-05', confirmed: true, at: NOW - 600e3 },
            ],
        }],
    };
}
const run = (db, client, over = {}) => sweepUser({ db, uid: UID, user: books(), client, now: NOW, env, deps: { random: () => 0.5, ...(over.deps || {}) }, ...over, ...(over.deps ? { deps: { random: () => 0.5, ...over.deps } } : {}) });
const reminders = (fs) => ledger(fs).filter((d) => d.kind === 'B.late');
const sentReminders = (gw) => gw.sent.filter((m) => m.message.startsWith('Reminder'));
const sentReceipts = (gw) => gw.sent.filter((m) => m.message.startsWith('Repayment'));

describe('under the reserve, through the engine', () => {
    it('the reminder is not queued or sent, the receipt is, and the books still owe the reminder', async () => {
        const { fs, db } = makeDb(); const gw = gateway({ units: 12 });
        const r = await run(db, gw, { deps: { units: 12 } });
        expect(sentReceipts(gw)).toHaveLength(1);
        expect(sentReminders(gw)).toHaveLength(0);
        expect(reminders(fs)).toHaveLength(0);                           // not queued: nothing to cancel, nothing to go stale
        expect(r.enqueued.paused).toBeGreaterThanOrEqual(1);
        expect(status(fs)).toMatchObject({ units: 12, reserve: 20, creditPaused: true });
    });

    it('goes out on the first sweep that sees the balance back, once', async () => {
        const { fs, db } = makeDb(); const gw = gateway({ units: 12 });
        await run(db, gw, { deps: { units: 12 } });
        const back = await run(db, gw, { now: NOW + 3600e3, deps: { units: 60 } });
        expect(sentReminders(gw)).toHaveLength(1);
        expect(status(fs)).toMatchObject({ units: 60, creditPaused: false });
        await run(db, gw, { now: NOW + 7200e3, deps: { units: 60 } });
        expect(sentReminders(gw)).toHaveLength(1);                       // never twice
        expect(back.sent).toBeGreaterThanOrEqual(1);
    });

    it('a reminder already queued stays queued (neither sent nor cancelled) while the balance is under the reserve, and goes when it is back', async () => {
        const { fs, db } = makeDb(); const gw = gateway({ units: 60 });
        // queue it by running with the reminder window not yet open for sending: the night before the morning
        await run(db, gw, { now: T('2026-10-04T20:00:00Z'), deps: { units: 60 } });
        expect(reminders(fs)[0]).toMatchObject({ status: STATUS.QUEUED });
        const low = await run(db, gw, { now: T('2026-10-05T03:00:00Z'), deps: { units: 4 } });
        expect(low.paused).toBe(1);
        expect(reminders(fs)[0]).toMatchObject({ status: STATUS.QUEUED });
        expect(sentReminders(gw)).toHaveLength(0);
        await run(db, gw, { now: T('2026-10-05T04:00:00Z'), deps: { units: 80 } });
        expect(reminders(fs)[0]).toMatchObject({ status: STATUS.SENT });
        expect(sentReminders(gw)).toHaveLength(1);
    });

    it('SMS_CREDIT_RESERVE=0 switches the rule off, and a custom reserve is honoured', async () => {
        const off = makeDb(); const gwOff = gateway({ units: 1 });
        await run(off.db, gwOff, { env: { ...env, SMS_CREDIT_RESERVE: '0' }, deps: { units: 1 } });
        expect(sentReminders(gwOff)).toHaveLength(1);
        const mid = makeDb(); const gwMid = gateway({ units: 30 });
        await run(mid.db, gwMid, { env: { ...env, SMS_CREDIT_RESERVE: '40' }, deps: { units: 30 } });
        expect(sentReminders(gwMid)).toHaveLength(0);
        const atReserve = makeDb(); const gwAt = gateway({ units: 20 });
        await run(atReserve.db, gwAt, { deps: { units: 20 } });
        expect(sentReminders(gwAt)).toHaveLength(1);                     // exactly at the reserve is not under it
    });

    it('an unreadable balance never stops a text', async () => {
        const { db } = makeDb(); const gw = gateway({ balanceKind: 'auth' });
        await run(db, gw);                                               // the run asks for the balance itself (a nudge) and cannot read it
        expect(sentReminders(gw)).toHaveLength(1);
        const noBalance = makeDb(); const gw2 = gateway({ hasBalance: false });
        await run(noBalance.db, gw2);
        expect(sentReminders(gw2)).toHaveLength(1);
    });

    it('a run that did not read the balance asks for it once, and only because a reminder is in play', async () => {
        const { db } = makeDb(); const gw = gateway({ units: 3 });
        await run(db, gw);                                               // no deps.units: the page's nudge
        expect(gw.calls.balance).toBe(1);
        expect(sentReminders(gw)).toHaveLength(0);
        expect(sentReceipts(gw)).toHaveLength(1);

        const plain = makeDb(); const gw2 = gateway({ units: 3 });
        const u = books(); u.debtors[0][FIELDS.REMIND] = false;           // nothing the reserve could hold back
        await sweepUser({ db: plain.db, uid: UID, user: u, client: gw2, now: NOW, env, deps: { random: () => 0.5 } });
        expect(gw2.calls.balance).toBe(0);
    });

    it('a balance the sweep already read is not read again', async () => {
        const { db } = makeDb(); const gw = gateway({ units: 3 });
        await run(db, gw, { deps: { units: 3 } });
        expect(gw.calls.balance).toBe(0);
    });
});

describe('the breaker', () => {
    const transient = { ok: false, transient: true, reason: 'x' };
    it('opens after three "could not tell" in a row, and a definite answer in between starts the count again', () => {
        expect(AUTH_TRIP_AFTER).toBe(3);
        const b = new SignInBreaker();
        b.record(transient); b.record(transient);
        expect(b.open).toBe(false);
        b.record({ ok: true });
        b.record(transient); b.record(transient);
        expect(b.open).toBe(false);
        b.record(transient);
        expect(b.open).toBe(true);
        b.record({ ok: true });
        expect(b.open).toBe(true);                                       // once open it stays open for the run
        expect(b.failed).toBe(5);
        expect(b.answered).toBe(2);
    });

    it('a definite "no" is an answer, not a failure', () => {
        const b = new SignInBreaker();
        for (let i = 0; i < 6; i += 1) b.record({ ok: false, reason: 'disabled' });
        expect(b.open).toBe(false);
        expect(b.answered).toBe(6);
    });
});

describe('accountStillAllowed under an outage', () => {
    const envOk = { SMS_ALLOWED_EMAILS: 'owner@example.com' };
    const user = { email: 'owner@example.com', emailVerified: true };
    const noSleep = async () => {};

    it('a quick failure is tried once more and the second answer is used', async () => {
        let n = 0;
        const admin = { auth: () => ({ getUser: async () => { n += 1; if (n === 1) throw Object.assign(new Error('reset'), { code: 'auth/internal-error' }); return user; } }) };
        expect(await accountStillAllowed({ admin, uid: 'x', env: envOk, sleep: noSleep })).toEqual({ ok: true });
        expect(n).toBe(2);
    });

    it('two quick failures are "could not tell", never "no"', async () => {
        let n = 0;
        const admin = { auth: () => ({ getUser: async () => { n += 1; throw Object.assign(new Error('503'), { code: 'auth/internal-error' }); } }) };
        const v = await accountStillAllowed({ admin, uid: 'x', env: envOk, sleep: noSleep });
        expect(v).toMatchObject({ ok: false, transient: true });
        expect(n).toBe(2);
    });

    it('a failure that ran out of time is not tried again (a second wait only doubles the cost of finding out)', async () => {
        vi.useFakeTimers();
        try {
            let n = 0;
            const admin = { auth: () => ({ getUser: () => { n += 1; return new Promise(() => {}); } }) };
            const p = accountStillAllowed({ admin, uid: 'x', env: envOk, sleep: noSleep });
            await vi.advanceTimersByTimeAsync(AUTH_DEADLINE_MS + 10);
            expect(await p).toMatchObject({ ok: false, transient: true });
            expect(n).toBe(1);
        } finally { vi.useRealTimers(); }
    });

    it('an account that does not exist, or an id that cannot exist, is a definite "no" without a retry', async () => {
        let n = 0;
        const gone = { auth: () => ({ getUser: async () => { n += 1; throw Object.assign(new Error('x'), { code: 'auth/user-not-found' }); } }) };
        expect(await accountStillAllowed({ admin: gone, uid: 'x', env: envOk, sleep: noSleep })).toMatchObject({ ok: false });
        expect(n).toBe(1);
        const bad = { auth: () => ({ getUser: async () => { throw Object.assign(new Error('x'), { code: 'auth/invalid-uid' }); } }) };
        const v = await accountStillAllowed({ admin: bad, uid: 'x', env: envOk, sleep: noSleep });
        expect(v.ok).toBe(false);
        expect(v.transient).toBeUndefined();
    });
});

/* ── the sweep handler ───────────────────────────────────────────────────── */

function res() {
    const r = { statusCode: 0, headers: {}, body: null, setHeader(k, v) { r.headers[k] = v; }, end(b) { r.body = b ? JSON.parse(b) : null; } };
    return r;
}
const cron = () => ({ method: 'GET', url: '/api/sms-sweep', headers: { authorization: 'Bearer cron-secret' }, body: {} });

function sweepWorld({ client = gateway(), authBehaviour = () => ({}), uids = ['u1', 'u2', 'u3', 'u4', 'u5'], webhook = null, envExtra = {}, now = NOW, hook } = {}) {
    const fs = createFirestore();
    const asked = [];
    const admin = { auth: () => ({ getUser: async (uid) => {
        asked.push(uid);
        const b = authBehaviour(uid);
        if (b instanceof Error) throw b;
        return { uid, email: 'owner@example.com', emailVerified: true, disabled: false, ...b };
    } }) };
    const posts = [];
    const fetchStub = hook || (async (url, init) => { posts.push({ url, init, body: JSON.parse(init.body) }); return { status: webhook || 200 }; });
    const deps = {
        client: () => client,
        getAdminDb: async () => ({ db: fs.db, admin }),
        env: { CRON_SECRET: 'cron-secret', SMS_ALLOWED_EMAILS: 'owner@example.com', ...env, ...envExtra },
        fetch: fetchStub, sleep: async () => {},
        now: () => now, clock: () => now,
    };
    return { fs, deps, client, asked, posts, uids };
}
async function register(w) {
    for (const uid of w.uids) {
        w.fs.data.set(`users/${uid}`, { settings: { currency: 'LKR' }, debtors: [] });
        w.fs.data.set(`wf-sms/${uid}`, { active: true, lastSweepAt: 0 });
    }
}
const down = (code = 'auth/internal-error') => Object.assign(new Error('auth is down'), { code });

describe('/api/sms-sweep while sign-in does not answer', () => {
    it('opens the breaker after three failures, leaves the rest for the next run, switches nobody off, and sends nothing on a remembered answer', async () => {
        const w = sweepWorld({ authBehaviour: () => down(), envExtra: {} });
        await register(w);
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(r.body).toMatchObject({ authDegraded: true, authSkipped: 2 });
        expect(r.body.results.filter((x) => x.skipped)).toHaveLength(3);
        expect(w.asked.length).toBe(6);                                   // three accounts, each tried twice: the other two were never asked
        for (const uid of w.uids) expect(w.fs.data.get(`wf-sms/${uid}`).active).toBe(true);
        expect(w.client.sent).toHaveLength(0);
    });

    it('one account that could not be checked among answered ones does not open it', async () => {
        const w = sweepWorld({ authBehaviour: (uid) => (uid === 'u2' ? down() : {}) });
        await register(w);
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.body.authDegraded).toBe(false);
        expect(r.body.authSkipped).toBe(0);
        expect(r.body.results.filter((x) => x.skipped)).toHaveLength(1);
        expect(r.body.results.filter((x) => x.derived !== undefined)).toHaveLength(4);
    });

    it('a run in which every check failed is degraded even with fewer than three accounts', async () => {
        const w = sweepWorld({ authBehaviour: () => down(), uids: ['solo'] });
        await register(w);
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.body).toMatchObject({ authDegraded: true, authSkipped: 0 });
    });

    it('a definite "no" still switches the account off, and a later answered run is not degraded', async () => {
        const w = sweepWorld({ authBehaviour: (uid) => (uid === 'u1' ? { disabled: true } : {}) });
        await register(w);
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(w.fs.data.get('wf-sms/u1').active).toBe(false);
        expect(r.body.authDegraded).toBe(false);
    });

    it('the next run starts with the breaker closed and picks the accounts up', async () => {
        let outage = true;
        const w = sweepWorld({ authBehaviour: () => (outage ? down() : {}) });
        await register(w);
        const first = res(); await handleSweep(cron(), first, w.deps);
        expect(first.body.authDegraded).toBe(true);
        outage = false;
        const second = res(); await handleSweep(cron(), second, w.deps);
        expect(second.body.authDegraded).toBe(false);
        expect(second.body.results.filter((x) => x.derived !== undefined)).toHaveLength(5);
    });
});

describe('the alert', () => {
    const HOOK = 'https://hooks.example.com/services/T000/B000/secretsecret';

    it('only an https endpoint that is not inside a network is used', () => {
        expect(alertWebhookUrl({ SMS_ALERT_WEBHOOK_URL: HOOK })).toBe(HOOK);
        for (const bad of ['', 'http://hooks.example.com/x', 'ftp://hooks.example.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://intranet/x', 'https://svc.internal/x', 'https://printer.local/x', 'https://user:pw@hooks.example.com/x', 'https://hooks.example.com:8443/x', 'not a url', 'https://']) {
            expect(alertWebhookUrl({ SMS_ALERT_WEBHOOK_URL: bad })).toBe('');
        }
        expect(alertWebhookUrl({})).toBe('');
    });

    it('posts JSON that works for Slack and Discord, does not follow redirects, never throws, and never logs the address', async () => {
        const calls = [];
        const ok = await postAlert({ env: { SMS_ALERT_WEBHOOK_URL: HOOK }, text: 'hello', extra: { units: 3 }, fetchImpl: async (u, i) => { calls.push({ u, i }); return { status: 204 }; } });
        expect(ok.sent).toBe(true);
        expect(calls[0].u).toBe(HOOK);
        expect(calls[0].i).toMatchObject({ method: 'POST', redirect: 'manual' });
        expect(JSON.parse(calls[0].i.body)).toEqual({ text: 'hello', content: 'hello', units: 3 });

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const bad = await postAlert({ env: { SMS_ALERT_WEBHOOK_URL: HOOK }, text: 't', fetchImpl: async () => ({ status: 302 }) });
            const boom = await postAlert({ env: { SMS_ALERT_WEBHOOK_URL: HOOK }, text: 't', fetchImpl: async () => { throw new Error(`cannot reach ${HOOK}`); } });
            const none = await postAlert({ env: {}, text: 't', fetchImpl: async () => { throw new Error('must not be called'); } });
            expect(bad.sent).toBe(false);
            expect(boom.sent).toBe(false);
            expect(none).toEqual({ sent: false, why: 'no webhook' });
            expect(JSON.stringify(warn.mock.calls)).not.toContain('secretsecret');
        } finally { warn.mockRestore(); }
    });

    it('gives up on an endpoint that never answers instead of holding the run', async () => {
        vi.useFakeTimers();
        try {
            const p = postAlert({ env: { SMS_ALERT_WEBHOOK_URL: HOOK }, text: 't', timeoutMs: 100, fetchImpl: (u, i) => new Promise((_, rej) => { i.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) });
            await vi.advanceTimersByTimeAsync(150);
            expect((await p).sent).toBe(false);
        } finally { vi.useRealTimers(); }
    });

    it('credit: told once when it falls under the reserve, not again within a day, again after a day, and at once if it recovers and falls again', () => {
        const low = { now: NOW, units: 7, reserve: 20, authDegraded: false, authAnswered: true };
        const a = decideAlerts({}, low);
        expect(a.alerts.map((x) => x.key)).toEqual(['credit']);
        expect(a.alerts[0].text).toMatch(/7 units, under the reserve of 20/);
        expect(a.alerts[0].text).not.toMatch(/token|secret/i);
        markAlerted(a.next, 'credit', NOW);
        expect(decideAlerts(a.next, { ...low, now: NOW + 8 * 3600e3 }).alerts).toHaveLength(0);
        expect(decideAlerts(a.next, { ...low, now: NOW + ALERT_GAP_MS }).alerts).toHaveLength(1);
        const recovered = decideAlerts(a.next, { ...low, now: NOW + 3600e3, units: 90 });
        expect(recovered.alerts).toHaveLength(0);
        expect(recovered.next.credit.alertedAt).toBe(0);
        expect(decideAlerts(recovered.next, { ...low, now: NOW + 2 * 3600e3 }).alerts).toHaveLength(1);
    });

    it('credit: an unknown balance neither alerts nor clears the record', () => {
        const prior = { credit: { alertedAt: NOW - 1000 } };
        const r = decideAlerts(prior, { now: NOW, units: null, reserve: 20, authDegraded: false, authAnswered: false });
        expect(r.alerts).toHaveLength(0);
        expect(r.next.credit.alertedAt).toBe(NOW - 1000);
    });

    it('sign-in: told only on the second degraded run in a row, then once a day; an answered run resets it', () => {
        const base = { units: 50, reserve: 20, authAnswered: false };
        const r1 = decideAlerts({}, { ...base, now: NOW, authDegraded: true });
        expect(r1.alerts).toHaveLength(0);
        expect(r1.next.auth.runs).toBe(1);
        const r2 = decideAlerts(r1.next, { ...base, now: NOW + 8 * 3600e3, authDegraded: true });
        expect(r2.alerts.map((x) => x.key)).toEqual(['auth']);
        markAlerted(r2.next, 'auth', NOW + 8 * 3600e3);
        const r3 = decideAlerts(r2.next, { ...base, now: NOW + 14 * 3600e3, authDegraded: true });
        expect(r3.alerts).toHaveLength(0);
        const ok = decideAlerts(r3.next, { ...base, now: NOW + 24 * 3600e3, authDegraded: false, authAnswered: true });
        expect(ok.next.auth).toMatchObject({ runs: 0, alertedAt: 0 });
        const quiet = decideAlerts(r3.next, { ...base, now: NOW + 24 * 3600e3, authDegraded: false, authAnswered: false });
        expect(quiet.next.auth.runs).toBe(r3.next.auth.runs);          // a run that asked nobody says nothing about Auth
    });

    it('normalizeState survives a damaged record', () => {
        expect(normalizeState(null)).toEqual({ credit: { alertedAt: 0 }, auth: { runs: 0, alertedAt: 0, lastAt: 0 } });
        expect(normalizeState({ credit: { alertedAt: 'x' }, auth: 'broken' })).toEqual({ credit: { alertedAt: 0 }, auth: { runs: 0, alertedAt: 0, lastAt: 0 } });
    });

    it('through the handler: one alert for a low balance, none the same day, the mark kept, and the response says so without the address', async () => {
        const w = sweepWorld({ client: gateway({ units: 6 }), envExtra: { SMS_ALERT_WEBHOOK_URL: HOOK } });
        await register(w);
        const r = res(); await handleSweep(cron(), r, w.deps);
        expect(r.body).toMatchObject({ creditPaused: true, alerts: ['credit'] });
        expect(w.posts).toHaveLength(1);
        expect(w.posts[0].url).toBe(HOOK);
        expect(w.posts[0].body).toMatchObject({ units: 6, reserve: 20 });
        expect(JSON.stringify(r.body)).not.toContain('secretsecret');
        const again = res(); await handleSweep(cron(), again, w.deps);
        expect(again.body.alerts).toEqual([]);
        expect(w.posts).toHaveLength(1);
        expect(w.fs.data.get('wf-sms/_system').credit.alertedAt).toBe(NOW);
    });

    it('an endpoint that is down does not lose the alert: the mark is not set and the next run tries again', async () => {
        let up = false;
        const w = sweepWorld({ client: gateway({ units: 6 }), envExtra: { SMS_ALERT_WEBHOOK_URL: HOOK }, hook: async () => ({ status: up ? 200 : 500 }) });
        await register(w);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const r1 = res(); await handleSweep(cron(), r1, w.deps);
            expect(r1.body.alerts).toEqual([]);
            expect((w.fs.data.get('wf-sms/_system') || {}).credit?.alertedAt || 0).toBe(0);
            up = true;
            const r2 = res(); await handleSweep(cron(), r2, w.deps);
            expect(r2.body.alerts).toEqual(['credit']);
        } finally { warn.mockRestore(); }
    });

    it('no webhook configured: still paused and logged, nothing posted, and the sweep still succeeds', async () => {
        const w = sweepWorld({ client: gateway({ units: 6 }) });
        await register(w);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const r = res(); await handleSweep(cron(), r, w.deps);
            expect(r.statusCode).toBe(200);
            expect(r.body).toMatchObject({ creditPaused: true, alerts: [] });
            expect(w.posts).toHaveLength(0);
            expect(warn.mock.calls.some((c) => /under the reserve/.test(String(c[0])))).toBe(true);
        } finally { warn.mockRestore(); }
    });

    it('a record store that fails does not fail the sweep', async () => {
        const w = sweepWorld({ client: gateway({ units: 6 }), envExtra: { SMS_ALERT_WEBHOOK_URL: HOOK } });
        await register(w);
        const orig = w.fs.db.collection.bind(w.fs.db);
        w.fs.db.collection = (name) => {
            const c = orig(name);
            if (name !== 'wf-sms') return c;
            return { ...c, doc: (id) => (id === '_system' ? { get: async () => { throw new Error('store down'); }, set: async () => { throw new Error('store down'); } } : c.doc(id)) };
        };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const r = res(); await handleSweep(cron(), r, w.deps);
            expect(r.statusCode).toBe(200);
        } finally { warn.mockRestore(); }
    });

    it('two degraded runs in a row through the handler produce one sign-in alert', async () => {
        const w = sweepWorld({ authBehaviour: () => down(), envExtra: { SMS_ALERT_WEBHOOK_URL: HOOK } });
        await register(w);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const r1 = res(); await handleSweep(cron(), r1, w.deps);
            expect(r1.body.alerts).toEqual([]);
            const r2 = res(); await handleSweep(cron(), r2, w.deps);
            expect(r2.body.alerts).toEqual(['auth']);
            expect(w.posts).toHaveLength(1);
            expect(w.posts[0].body.text).toMatch(/sign-in has not answered on 2 sweeps/);
        } finally { warn.mockRestore(); }
    });
});
