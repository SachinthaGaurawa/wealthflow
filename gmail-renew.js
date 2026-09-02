/* =============================================================================
 * gmail-renew.js  →  /api/gmail-renew   (scheduled)
 * -----------------------------------------------------------------------------
 * Renews the Gmail watches that are about to lapse, for every connected
 * mailbox, without anybody opening the app.
 *
 * GET|POST /api/gmail-renew  → { ok, scanned, due, renewed, failed, failures }
 *
 * ── WHY THIS EXISTS WHEN THE PAGE ALREADY RENEWS ────────────────────────────
 *
 * A watch lives seven days and the page re-registers it on a six-day margin, so
 * an app opened weekly never lapses. The hole is the week nobody opens it: the
 * watch expires, Gmail publishes nothing, /api/gmail-hook is never invoked, and
 * the card still says "Connected" — because the mailbox is connected. Nothing
 * looks broken. Statements simply stop, and the first sign is noticing a month
 * later that a bank is missing. That silence is the failure this whole pipeline
 * keeps producing, and a schedule is the only thing that closes it.
 *
 * The page keeps renewing exactly as it did. This is a backstop, not a
 * replacement — and it renews the same way, so there is one mechanism with two
 * triggers rather than two mechanisms.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * It reads no mail, downloads no attachment and returns no address. A scheduled
 * response ends up in a deployment log, so the answer is COUNTS: how many were
 * looked at, how many were due, how many were renewed, and what kind of failure
 * stopped the rest. Which mailbox failed is written to that mailbox's own
 * document, where its owner sees it on their own card.
 *
 * ENV: CRON_SECRET (the caller's credential), FIREBASE_SERVICE_ACCOUNT,
 *      GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, PUB_SUB_TOPIC,
 *      GCP_PROJECT_ID.
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { cronAuthorized } from './cron-auth.mjs';
import { accessTokenFrom, authed } from './google-oauth.mjs';
import { MAIL_ROOT, topicNameFrom, missingWatchConfig, watchBody, watchRecord } from './gmail-watch.mjs';
import { RENEW_MAX_PER_RUN, RENEW_SCAN_MAX, RENEW_FAIL, RENEW_FAIL_TEXT, dueFrom, renewReport } from './gmail-renew.mjs';

const WATCH_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/watch';

function j(res, code, body) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

/**
 * Renew one mailbox's watch. Returns a named outcome; never throws.
 *
 * The refresh token is read from the document and handed to Google. It is never
 * returned, logged, or put in an error message — the failure it produces is
 * reported as `token-refused`, which is the same information without the value.
 */
async function renewOne(ref, data, topic, env, f) {
    let token;
    try {
        token = await accessTokenFrom(data.refresh_token, env, f);
    } catch (_) {
        return { ok: false, reason: RENEW_FAIL.TOKEN };
    }

    let watch;
    try {
        const r = await withDeadline(f(WATCH_URL, {
            method: 'POST',
            headers: { ...authed(token), 'Content-Type': 'application/json' },
            body: JSON.stringify(watchBody(topic)),
        }), 8000, 'users.watch');
        if (!r.ok) return { ok: false, reason: RENEW_FAIL.GMAIL };
        watch = await r.json();
    } catch (_) {
        return { ok: false, reason: RENEW_FAIL.GMAIL };
    }

    try {
        await withDeadline(ref.set({
            /* THE BOOKMARK IS NOT MOVED, AND THIS DIFFERS FROM THE PAGE ON
             * PURPOSE.
             *
             * A renewal from the page advances `historyId` to Gmail's current
             * point, which keeps the next push's history query small — sound,
             * because the page renews while the pipeline is running and there
             * is nothing between the last push and now.
             *
             * A SCHEDULED RENEWAL IS THE ONE THAT RUNS AFTER A LAPSE. The gap
             * between the last push and this moment is precisely where mail
             * arrived with nobody notified, and advancing the bookmark past it
             * is the one action that guarantees the hook never sees it. Left
             * alone, a bookmark too old for Gmail's retention answers 404 and
             * the hook falls back to a bounded recent listing — a cost. Moving
             * it is a loss, and a silent one. */
            ...watchRecord(watch, topic, { hadHistoryId: false }),
            renewedBy: 'schedule',
            /* CLEARED ON SUCCESS. A stale failure on the card is worse than no
             * message: it sends the owner to reconnect a mailbox that is
             * working, and the next real failure reads as the same old notice. */
            renewError: '',
        }, { merge: true }), 8000, 'wf-mail');
    } catch (_) {
        return { ok: false, reason: RENEW_FAIL.STORE };
    }
    return { ok: true };
}

/** Record why a mailbox could not be renewed, on that mailbox's own document. */
async function noteFailure(ref, reason) {
    try {
        await withDeadline(ref.set({
            renewError: RENEW_FAIL_TEXT[reason] || RENEW_FAIL_TEXT[RENEW_FAIL.GMAIL],
            renewErrorAt: Date.now(),
        }, { merge: true }), 8000, 'wf-mail');
    } catch (_) {
        /* The run's report already counts this failure. A note that could not
         * be written costs the owner a sentence on their card, never a wrong
         * one. */
    }
}

export default async function handler(req, res, deps) {
    const env = (deps && deps.env) || process.env;
    const f = (deps && deps.fetchImpl) || fetch;

    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) {
        return j(res, 405, { ok: false, error: 'method not allowed' });
    }

    /* THE CREDENTIAL FIRST, BEFORE ANYTHING IS READ. An unauthorised caller
     * learns nothing about this deployment — not how many mailboxes it holds,
     * not whether it is configured at all. */
    const may = cronAuthorized(req, { env });
    if (!may.ok) return j(res, may.status, { ok: false, error: may.reason });

    const topic = topicNameFrom(env);
    if (!topic) {
        /* Named, not swallowed. Without a topic every renewal in this run would
         * fail identically, and a scheduled job reporting "0 renewed" with no
         * reason is how a stopped pipeline stays stopped for a month. */
        return j(res, 503, {
            ok: false,
            error: 'the Pub/Sub topic is not configured',
            missing: missingWatchConfig(env),
        });
    }

    const { db, reason } = await getAdminDb();
    if (!db) return j(res, 503, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });

    let docs = [];
    try {
        const snap = await withDeadline(
            db.collection(MAIL_ROOT).limit(RENEW_SCAN_MAX).get(), 8000, 'wf-mail scan');
        for (const d of (snap && snap.docs) || []) docs.push({ key: d.id, ref: d.ref, data: d.data() });
    } catch (_) {
        return j(res, 503, { ok: false, error: 'the mailbox store could not be read' });
    }

    const due = dueFrom(docs, { now: Date.now(), max: RENEW_MAX_PER_RUN });

    /* ONE AT A TIME, ON PURPOSE. These are calls to Google's token endpoint
     * with several accounts' credentials; firing them together is how a
     * scheduled job earns a rate limit that then fails every mailbox at once. */
    const outcomes = [];
    for (const d of due) {
        const out = await renewOne(d.ref, d.data, topic, env, f);
        outcomes.push(out);
        if (!out.ok) await noteFailure(d.ref, out.reason);
    }

    const report = renewReport({ scanned: docs.length, due: due.length, outcomes });
    /* A run that renewed nothing while something was due is a FAILED run, and
     * answers as one, so the platform's own alerting sees it. Reporting 200 on
     * a pipeline that has stopped is the mistake this file exists to end. */
    return j(res, report.ok ? 200 : 502, report);
}
