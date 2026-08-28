/* =============================================================================
 * gmail-scan.js  →  /api/gmail-scan
 * -----------------------------------------------------------------------------
 * The deep scan: the statements ALREADY in the mailbox.
 *
 * POST /api/gmail-scan  { months, index, now, pageToken? }
 *   → { ok, window, ids, statements, stored[], pageToken, done }
 *
 * ── IT WRITES WHERE THE PUSH WRITES, AND THAT IS THE WHOLE DESIGN ───────────
 *
 * Every statement this finds is stored at wf-mail/{userKey}/items/{key}, parts
 * first and manifest last, with the same planMessage()/planWrite() the live
 * hook uses and the same item key. So the device side needs NO new code: the
 * existing sync drains that collection, assembles the parts, unlocks with the
 * device vault, parses, routes and files. Backfilled statements and pushed ones
 * are indistinguishable by the time anything reads them, which is the point —
 * a second ingestion path would be a second set of bugs.
 *
 * A rescan is free. The item key is (messageId, filename, size) — properties
 * of the MIME part, not a token minted per request — so a message seen twice
 * addresses the same document and is skipped when it is already there. That
 * makes "run it again" a safe answer to any interruption.
 *
 * It used to key on Gmail's attachmentId, which carries no such promise. When
 * that token was reminted the key moved, the skip found nothing, and the same
 * statement was stored again under a new name. The legacy name is still
 * checked here so the first run after the change recognises what is already
 * held rather than duplicating all of it once more on the way to fixing it.
 *
 * ── BOUNDED, BECAUSE A MAILBOX IS NOT ─────────────────────────────────────
 *
 * One call = one page of one month. The cursor lives on the client
 * (wealthflow-backfill.js planned it), so an interrupted scan resumes instead
 * of restarting, and no single invocation can run away with a free-tier quota.
 *
 * ENV: FIREBASE_SERVICE_ACCOUNT, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET.
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { identify } from './gmail-link.mjs';
import { accessTokenFrom, authed } from './google-oauth.mjs';
import { planMessage, planWrite, isWorthTelling, REJECT_TEXT } from './wealthflow-mail-ingest.mjs';
import { MAIL_ROOT, windowFor, listUrl, boundedMax, pageResult } from './gmail-scan.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function j(res, code, body) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

function verifierFrom(admin) {
    if (!admin || typeof admin.auth !== 'function') return null;
    return (t) => admin.auth().verifyIdToken(t);
}

async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
}

export default async function handler(req, res, deps) {
    const env = (deps && deps.env) || process.env;
    const f = (deps && deps.fetchImpl) || fetch;

    if (String(req.method || '').toUpperCase() !== 'POST') {
        return j(res, 405, { ok: false, error: 'POST only' });
    }

    const { db, reason, admin } = await getAdminDb();

    const who = await identify(req, { verifyIdToken: verifierFrom(admin) });
    if (!who.ok) return j(res, who.status || 401, { ok: false, error: who.reason });

    if (!db) return j(res, 503, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });

    const body = await readBody(req);

    /* The window is DERIVED, never accepted. See gmail-scan.mjs: a free-text
     * query parameter would turn a credential that can read the whole mailbox
     * into a general mail-search proxy. */
    const window = windowFor({ months: body.months, index: body.index, now: body.now });
    if (!window) {
        return j(res, 400, { ok: false, error: 'that is not a window this scan can ask for' });
    }

    const ref = db.collection(MAIL_ROOT).doc(who.userKey);

    let state;
    try {
        const snap = await withDeadline(ref.get(), 8000, 'wf-mail');
        state = snap && snap.exists ? snap.data() : null;
    } catch (_) {
        return j(res, 503, { ok: false, error: 'state unreadable' });
    }
    if (!state || !state.refresh_token) {
        return j(res, 409, { ok: false, error: 'no mailbox is connected yet', connected: false });
    }

    let token;
    try {
        token = await accessTokenFrom(state.refresh_token, env, f);
    } catch (_) {
        return j(res, 502, {
            ok: false,
            error: 'Gmail refused the saved token. Disconnect and connect the mailbox again.',
        });
    }

    /* ── list one page of this month ─────────────────────────────────────── */
    let listed;
    try {
        const r = await withDeadline(
            f(listUrl(GMAIL, window, body.pageToken, body.max), { headers: authed(token) }),
            10000, 'Gmail search',
        );
        if (!r.ok) return j(res, 502, { ok: false, error: `Gmail search failed (HTTP ${r.status})` });
        listed = await r.json();
    } catch (_) {
        return j(res, 504, { ok: false, error: 'Gmail did not answer in time' });
    }

    const ids = ((listed && listed.messages) || []).map((m) => m && m.id).filter(Boolean);
    const stored = [];
    const skipped = [];

    for (const id of ids.slice(0, boundedMax(body.max))) {
        let msg;
        try {
            const r = await f(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { headers: authed(token) });
            if (!r.ok) continue;                       // one unreadable message is not a failed scan
            msg = await r.json();
        } catch (_) { continue; }

        /* The SAME plan the live hook applies: allowlisted sender, DKIM held,
         * an attachment worth taking. A second copy of that judgement is a
         * second place for a statement to be accepted that should not be. */
        const plan = planMessage(msg);
        if (!plan.ok) {
            if (isWorthTelling(plan)) {
                skipped.push({ bank: plan.bank || null, reason: plan.reason, text: REJECT_TEXT[plan.reason] });
            }
            continue;
        }

        for (const item of plan.items) {
            const itemRef = ref.collection('items').doc(item.key);
            try {
                /* Already here: a rescan, or a message the push already took.
                 * The key is (messageId, attachmentId), so this is the same
                 * document either way and there is nothing to do. */
                const existing = await itemRef.get();
                if (existing.exists) continue;
                /* The name this attachment was filed under before the key
                 * stopped depending on Gmail's attachmentId. Checked so the
                 * first scan after that change recognises what is already
                 * stored rather than writing a second copy of all of it. */
                if (item.legacyKey && item.legacyKey !== item.key) {
                    const prior = await ref.collection('items').doc(item.legacyKey).get();
                    if (prior && prior.exists) continue;
                }

                const ar = await f(
                    `${GMAIL}/messages/${encodeURIComponent(item.messageId)}`
                    + `/attachments/${encodeURIComponent(item.attachmentId)}`,
                    { headers: authed(token) },
                );
                if (!ar.ok) continue;
                const att = await ar.json();
                const b64 = String(att.data || '').replace(/-/g, '+').replace(/_/g, '/');

                const write = planWrite(b64, {
                    bank: item.bank, filename: item.filename, messageId: item.messageId,
                    subject: item.subject, receivedMs: item.receivedMs, storedMs: Date.now(),
                    backfilled: true,
                });
                if (!write.ok) {
                    skipped.push({ bank: item.bank, reason: write.reason, text: REJECT_TEXT[write.reason] });
                    continue;
                }

                /* PARTS FIRST, MANIFEST LAST — the ordering statement-store.js
                 * established and the device relies on. A reader that finds the
                 * manifest is guaranteed every part landed. */
                for (const p of write.parts) {
                    await itemRef.collection('parts').doc(String(p.i)).set({ i: p.i, d: p.d });
                }
                await itemRef.set(write.manifest);
                stored.push({ key: item.key, bank: item.bank, filename: item.filename });
            } catch (_) {
                /* This attachment did not land. The manifest was not written, so
                 * the device will never see a partial statement, and the next
                 * scan of this window picks it up. Not a failed page. */
            }
        }
    }

    return j(res, 200, {
        ok: true,
        window: { label: window.label },
        ...pageResult({ ids, stored, skipped, pageToken: listed && listed.nextPageToken }),
    });
}
