/* =============================================================================
 * sms-sweep.js  ->  /api/sms-sweep   (Vercel cron, once a day; also callable with the cron secret)
 * -----------------------------------------------------------------------------
 * The net under the realtime path. For every account that has ever used SMS
 * notifications it re-derives what the books owe (sms-events.mjs), queues anything
 * the ledger does not yet hold, and retries whatever is due — so a message that was
 * missed because a page closed, a function was cold or the gateway was down is sent
 * on the next run without anybody being asked.
 *
 * It is also the day's SCHEDULED worker: the monthly interest notices and the late-payment
 * reminders are derived here, then held to 08:00-20:00 where the RECIPIENT is (the engine
 * enforces that when it claims a text, not only when it queues one). One daily run cannot be
 * inside that window for every country, so it runs three times a day: 04:00 UTC (09:30 in
 * Colombo; Asia and the Pacific), 12:00 UTC (the Gulf, Europe, Africa, the eastern Americas)
 * and 18:00 UTC (the Americas). A run with nothing owed sends nothing and costs nothing.
 *
 * One call to the gateway's balance endpoint per run (free) records whether credit
 * is running low, which the owner's dashboard shows before a message is held for it.
 *
 * WHO IS SWEPT. Registering (sms-notify) is not a licence for ever: before an account's texts are sent the sweep asks Firebase Auth again
 * whether that sign-in may still use SMS (sms-access.mjs: not disabled, verified email, on SMS_ALLOWED_EMAILS or an admin claim). An account
 * that may not is switched off (`active: false`, with the reason; the owner's next visit registers it again once it is allowed), so removing
 * somebody from the allow-list stops their texts, their retries and the one-time codes their tenants can ask for. An Auth outage is not a
 * verdict: the account is skipped this run and left as it is. A registration whose user document is gone is switched off too, so it cannot
 * hold one of the MAX_USERS places run after run.
 *
 * Auth: Authorization: Bearer <CRON_SECRET>, constant-time, refusing everything when
 * unset (cron-auth.mjs).
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { cronAuthorized } from './cron-auth.mjs';
import { TextLkClient } from './textlk.mjs';
import { smsAllowed } from './sms-access.mjs';
import { sweepUser, ROOT, LOW_CREDIT_UNITS } from './sms-engine.mjs';

/** Accounts handled per run. The oldest-swept go first, so a long list is covered across runs. */
export const MAX_USERS = 40;
export const TOTAL_BUDGET_MS = 50000;
/**
 * The registered accounts are read in pages and ordered here, by when each was last swept. A query limited BEFORE that sort would only ever see the
 * same first documents, and an account outside them would never be swept again. (An orderBy on `lastSweepAt` is not the answer: it needs a composite
 * index and silently leaves out an account that has never been swept, which has no such field.)
 */
export const ACTIVE_PAGE = 500;
export const ACTIVE_SCAN_MAX = 2000;
const AUTH_DEADLINE_MS = 6000;

async function readActive(db, admin) {
    const docs = [];
    let after = null;
    // The cursor only means something under a fixed order. With one equality filter that order is the document id, which Firestore applies by
    // default; it is named here anyway so the paging does not rest on a default (and needs no index: an equality filter plus the id order is built in).
    const byId = admin && admin.firestore && admin.firestore.FieldPath && typeof admin.firestore.FieldPath.documentId === 'function' ? admin.firestore.FieldPath.documentId() : null;
    while (docs.length < ACTIVE_SCAN_MAX) {
        let q = db.collection(ROOT).where('active', '==', true);
        if (byId) q = q.orderBy(byId);
        q = q.limit(ACTIVE_PAGE);
        if (after) q = q.startAfter(after);
        const snap = await withDeadline(q.get(), 10000, 'wf-sms');
        docs.push(...snap.docs);
        if (snap.docs.length < ACTIVE_PAGE) break;
        after = snap.docs[snap.docs.length - 1];
    }
    return docs;
}

/**
 * May this sign-in still use SMS? Asked of Firebase Auth, not of what was true when the account registered.
 * @returns {Promise<{ok:true}|{ok:false, transient?:true, reason:string}>} `transient` means "could not tell", never "no".
 */
export async function accountStillAllowed({ admin, uid, env }) {
    if (!admin || typeof admin.auth !== 'function') return { ok: false, transient: true, reason: 'sign-in service unavailable' };
    let user;
    try { user = await withDeadline(admin.auth().getUser(uid), AUTH_DEADLINE_MS, 'auth'); }
    catch (e) {
        if (e && e.code === 'auth/user-not-found') return { ok: false, reason: 'the sign-in account no longer exists' };
        return { ok: false, transient: true, reason: 'sign-in service did not answer' };
    }
    if (!user) return { ok: false, transient: true, reason: 'sign-in service gave no account' };
    if (user.disabled === true) return { ok: false, reason: 'the sign-in account is disabled' };
    if (user.emailVerified !== true) return { ok: false, reason: 'the sign-in email is not verified' };
    const access = smsAllowed({ email: user.email, claims: user.customClaims }, env);
    return access.ok ? { ok: true } : { ok: false, reason: access.reason };
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
    if (!auth.ok) return j(res, auth.status, { ok: false, error: auth.reason });

    const { db, reason, admin } = await deps.getAdminDb();
    if (!db) return j(res, 503, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });
    const client = deps.client();
    const startedAt = deps.clock();
    const now = deps.now();

    let units = null; let balanceKind = null;
    if (client.configured) {
        const b = await client.balance();
        if (b.ok) units = b.units; else balanceKind = b.kind;
    }

    const allowed = deps.accountAllowed || ((uid) => accountStillAllowed({ admin, uid, env: deps.env }));
    const switchOff = (uid, why) => db.collection(ROOT).doc(uid).set({ active: false, deactivatedAt: now, deactivatedReason: String(why || '').slice(0, 120) }, { merge: true });

    const active = await readActive(db, admin);
    const accounts = active
        .map((d) => ({ uid: d.id, lastSweepAt: Number((d.data() || {}).lastSweepAt || 0) }))
        .sort((a, b) => a.lastSweepAt - b.lastSweepAt)
        .slice(0, MAX_USERS);

    const results = [];
    for (const a of accounts) {
        const spent = deps.clock() - startedAt;
        if (spent > TOTAL_BUDGET_MS) { results.push({ uid: '(skipped)', skipped: true }); break; }
        try {
            const verdict = await allowed(a.uid);
            if (!verdict.ok) {
                if (verdict.transient) { results.push({ uid: a.uid.slice(0, 6), skipped: true, why: 'sign-in check unavailable' }); continue; }
                await switchOff(a.uid, verdict.reason);
                results.push({ uid: a.uid.slice(0, 6), deactivated: true });
                continue;
            }
            const userSnap = await withDeadline(db.collection('users').doc(a.uid).get(), 8000, 'users');
            if (!userSnap.exists) { await switchOff(a.uid, 'the account has no data document'); results.push({ uid: a.uid.slice(0, 6), empty: true, deactivated: true }); continue; }
            const summary = await sweepUser({
                db, uid: a.uid, user: userSnap.data() || {}, client, now, env: deps.env,
                budgetMs: Math.max(5000, TOTAL_BUDGET_MS - spent - 3000), deps: { ...(deps.engine || {}), units }, clock: deps.clock,
            });
            await db.collection(ROOT).doc(a.uid).set({ lastSweepAt: now }, { merge: true });
            results.push({ uid: a.uid.slice(0, 6), ...summary });
        } catch (e) {
            console.error('[WF-SMS] sweep failed for one account:', String((e && e.message) || e).slice(0, 160));
            results.push({ uid: a.uid.slice(0, 6), error: true });
        }
    }
    if (units !== null && units <= LOW_CREDIT_UNITS) console.warn(`[WF-SMS] gateway balance is low (${units} units)`);
    if (balanceKind) console.warn(`[WF-SMS] gateway balance check failed kind=${balanceKind}`);
    return j(res, 200, { ok: true, accounts: results.length, lowCredit: units !== null && units <= LOW_CREDIT_UNITS, balanceCheck: balanceKind || 'ok', results });
}

export const defaultDeps = () => ({
    client: () => TextLkClient.fromEnv(process.env),
    getAdminDb,
    env: process.env,
    now: () => Date.now(),
    clock: () => Date.now(),
});

export default async function handler(req, res) {
    return handleSweep(req, res, defaultDeps());
}
