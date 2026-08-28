/* =============================================================================
 * gmail-watch.js  →  /api/gmail-watch
 * -----------------------------------------------------------------------------
 * Asks Gmail to notify us. Without this call Google never publishes to the
 * Pub/Sub topic, /api/gmail-hook is never invoked, and a mailbox reported as
 * "connected" delivers nothing, forever.
 *
 * GET  /api/gmail-watch → { ok, watching, expiresAt, daysLeft, needsRenewal, missing[] }
 * POST /api/gmail-watch → registers or renews, then reports the same shape
 *
 * ── WHY IT IS A USER-AUTHENTICATED ENDPOINT AND NOT A CRON ──────────────────
 *
 * A watch is registered with an access token minted from ONE mailbox's refresh
 * token, so it is inherently per-account work. Renewal is driven by the page
 * on a six-day margin against a seven-day lifetime: no new secret, no scheduled
 * runner, nothing added to the Actions budget. The trade is that it renews when
 * the owner opens the app — which is why the expiry is reported to the card
 * rather than kept here. A pipeline that stops must say so on screen; the
 * failure this whole change exists to fix was silence.
 *
 * ── THE BOUNDARY IS identify(), AS IT IS NEXT DOOR ──────────────────────────
 *
 * The Admin SDK bypasses firestore.rules, so the document this file addresses
 * is the document it gets. The key comes from a VERIFIED email on a Firebase ID
 * token and from nothing the caller sends — the same decision as gmail-link.js,
 * imported from the same module rather than reimplemented.
 *
 * ENV: FIREBASE_SERVICE_ACCOUNT, GOOGLE_OAUTH_CLIENT_ID,
 *      GOOGLE_OAUTH_CLIENT_SECRET, PUB_SUB_TOPIC, GCP_PROJECT_ID.
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { identify } from './gmail-link.mjs';
import { accessTokenFrom, authed } from './google-oauth.mjs';
import {
    MAIL_ROOT, topicNameFrom, missingWatchConfig, watchBody, watchRecord,
    needsRenewal, watchStatusOf,
} from './gmail-watch.mjs';

const WATCH_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/watch';

function j(res, code, body) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

/** The Admin SDK's token verifier, or null — built from the one bootstrap. */
function verifierFrom(admin) {
    if (!admin || typeof admin.auth !== 'function') return null;
    return (t) => admin.auth().verifyIdToken(t);
}

function report(res, code, record, env, extra) {
    return j(res, code, {
        ok: code < 400,
        ...watchStatusOf(record),
        needsRenewal: needsRenewal(record),
        connected: !!(record && record.refresh_token),
        missing: missingWatchConfig(env),
        ...(extra || {}),
    });
}

export default async function handler(req, res, deps) {
    const env = (deps && deps.env) || process.env;
    const f = (deps && deps.fetchImpl) || fetch;

    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) {
        return j(res, 405, { ok: false, error: 'method not allowed' });
    }

    const { db, reason, admin } = await getAdminDb();

    const who = await identify(req, { verifyIdToken: verifierFrom(admin) });
    if (!who.ok) return j(res, who.status || 401, { ok: false, error: who.reason });

    if (!db) return j(res, 503, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });

    const ref = db.collection(MAIL_ROOT).doc(who.userKey);

    let record = null;
    try {
        const snap = await withDeadline(ref.get(), 8000, 'wf-mail');
        record = snap && snap.exists ? snap.data() : null;
    } catch (_) {
        return j(res, 503, { ok: false, error: 'state unreadable' });
    }

    if (method === 'GET') return report(res, 200, record, env);

    /* ── POST: register or renew ─────────────────────────────────────────── */

    if (!record || !record.refresh_token) {
        /* Nothing to watch WITH. Said as its own sentence rather than as a
         * generic failure, because the fix is a different screen. */
        return j(res, 409, {
            ok: false,
            error: 'no mailbox is connected yet — save a refresh token first',
            connected: false,
        });
    }

    const topic = topicNameFrom(env);
    if (!topic) {
        /* Names the variables instead of failing as "could not watch". A
         * misconfiguration that reports itself as a generic error is
         * indistinguishable from a broken pipeline, and this one is the
         * difference between statements arriving and never arriving. */
        return j(res, 503, {
            ok: false,
            error: 'the Pub/Sub topic is not configured',
            missing: missingWatchConfig(env),
        });
    }

    let token;
    try {
        token = await accessTokenFrom(record.refresh_token, env, f);
    } catch (_) {
        /* The stored refresh token no longer works — revoked, or the OAuth
         * client changed. Reported as a reconnect, because that is the action,
         * and WITHOUT the token appearing anywhere in the message. */
        return j(res, 502, {
            ok: false,
            error: 'Gmail refused the saved token. Disconnect and connect the mailbox again.',
            connected: true,
        });
    }

    let watch;
    try {
        const r = await withDeadline(f(WATCH_URL, {
            method: 'POST',
            headers: { ...authed(token), 'Content-Type': 'application/json' },
            body: JSON.stringify(watchBody(topic)),
        }), 8000, 'users.watch');
        if (!r.ok) {
            /* Google's own reason, capped and passed through. The common one is
             * that the topic exists but gmail-api-push@system.gserviceaccount.com
             * has no Publish role on it — a sentence nobody guesses, and one
             * that would otherwise surface as statements silently not arriving. */
            let detail = '';
            try { detail = String((await r.text()) || '').slice(0, 300); } catch (_) { /* status is enough */ }
            return j(res, 502, {
                ok: false,
                error: `Gmail refused the watch (HTTP ${r.status})`,
                detail: detail || null,
            });
        }
        watch = await r.json();
    } catch (_) {
        return j(res, 504, { ok: false, error: 'Gmail did not answer in time' });
    }

    const rec = watchRecord(watch, topic, { hadHistoryId: !!(record && record.historyId) });
    try {
        await withDeadline(ref.set(rec, { merge: true }), 8000, 'wf-mail');
    } catch (_) {
        /* The watch IS registered — Gmail accepted it — but we failed to record
         * when it expires. Saying "ok" would leave a watch nothing will renew,
         * so this reports the failure and the next POST simply re-registers. */
        return j(res, 503, { ok: false, error: 'the watch was registered but could not be recorded' });
    }

    return report(res, 200, { ...record, ...rec }, env, { registered: true });
}
