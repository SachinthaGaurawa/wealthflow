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
 * Auth: Authorization: Bearer <CRON_SECRET>, constant-time, refusing everything when
 * unset (cron-auth.mjs).
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { cronAuthorized } from './cron-auth.mjs';
import { TextLkClient } from './textlk.mjs';
import { sweepUser, ROOT, LOW_CREDIT_UNITS } from './sms-engine.mjs';

/** Accounts handled per run. The oldest-swept go first, so a long list is covered across runs. */
export const MAX_USERS = 40;
export const TOTAL_BUDGET_MS = 50000;

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

    const { db, reason } = await deps.getAdminDb();
    if (!db) return j(res, 503, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });
    const client = deps.client();
    const startedAt = deps.clock();
    const now = deps.now();

    let units = null; let balanceKind = null;
    if (client.configured) {
        const b = await client.balance();
        if (b.ok) units = b.units; else balanceKind = b.kind;
    }

    const snap = await withDeadline(db.collection(ROOT).where('active', '==', true).limit(200).get(), 10000, 'wf-sms');
    const accounts = snap.docs
        .map((d) => ({ uid: d.id, lastSweepAt: Number((d.data() || {}).lastSweepAt || 0) }))
        .sort((a, b) => a.lastSweepAt - b.lastSweepAt)
        .slice(0, MAX_USERS);

    const results = [];
    for (const a of accounts) {
        const spent = deps.clock() - startedAt;
        if (spent > TOTAL_BUDGET_MS) { results.push({ uid: '(skipped)', skipped: true }); break; }
        try {
            const userSnap = await withDeadline(db.collection('users').doc(a.uid).get(), 8000, 'users');
            if (!userSnap.exists) { results.push({ uid: a.uid.slice(0, 6), empty: true }); continue; }
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
