// =============================================================================
// WealthFlow Inbox Ack v4.0 — delete the items the app successfully applied.
// -----------------------------------------------------------------------------
// v4.0 — OFF THE REST API, ONTO THE ADMIN SDK. See inbox-store.mjs. Over REST this
// endpoint was unauthenticated as far as security rules go, so wf-inbox had to
// allow unauthenticated DELETE — meaning anyone who learned a device hash could
// erase that user's pending transactions. Through the Admin SDK it bypasses rules,
// so the branch can be sealed.
//
// THE BOUNDARY MOVED. Firestore no longer gets a vote on which bucket is touched:
// whatever path this file addresses is the path that gets deleted. The prefix
// check is therefore the entire capability boundary, and it now lives in
// inbox-store.mjs's itemIdFrom() — one audited implementation that refuses a key
// naming another device, a traversal, or an extra path segment, before any
// database call is made.
//
// v3.0 kept: `deleted` COUNTS DELETIONS, NOT ATTEMPTS. The old loop ran
// `await fsDelete(k); deleted++;` and threw the result away, so a rejection
// produced `{ ok: true, deleted: 5 }` with all five documents still present — to
// be pulled and applied a second time, with only the client-side duplicate check
// standing between that and five double-logged transactions.
// =============================================================================

import {
    getInboxDb, withDeadline, tokenHash, itemIdFrom, deviceTokenFrom, jsonBody,
    INBOX_ROOT, ITEMS,
} from './inbox-store.mjs';

const _memStore = globalThis.__wfMemStore || (globalThis.__wfMemStore = new Map());

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'POST required' });
        return;
    }

    let body;
    try { body = jsonBody(req); }
    catch (_) { res.status(400).json({ ok: false, error: 'Invalid JSON' }); return; }

    const tok = deviceTokenFrom(req, body);
    if (!tok) {
        res.status(401).json({ ok: false, error: 'Token required' });
        return;
    }

    const keys = Array.isArray(body.keys) ? body.keys : [];
    const tHash = await tokenHash(tok);

    // Classify every key BEFORE touching the database, so a refused key can never
    // reach Firestore even in a partially-failing batch.
    const accepted = [];
    const rejected = [];
    for (const k of keys) {
        const id = itemIdFrom(k, tHash);
        if (id) accepted.push({ key: String(k), id });
        else rejected.push(String(k == null ? '' : k).slice(0, 80));
    }

    if (!accepted.length) {
        // Nothing legitimate to do. Still a 200: the caller asked for deletions
        // that are not its own, which is refused, not an error condition here.
        res.status(200).json({
            ok: rejected.length === 0,
            deleted: 0,
            requested: keys.length,
            ...(rejected.length ? { rejected } : {}),
        });
        return;
    }

    const { db, reason } = await getInboxDb();
    if (!db) {
        res.status(503).json({ ok: false, error: 'inbox_not_configured', detail: reason });
        return;
    }

    const col = db.collection(INBOX_ROOT).doc(tHash).collection(ITEMS);
    let deleted = 0;
    const failed = [];
    for (const { key, id } of accepted) {
        _memStore.delete(key);
        try {
            await withDeadline(col.doc(id).delete(), 8000, 'Firestore delete');
            deleted++;
        } catch (e) {
            failed.push({ key: key.slice(0, 80), detail: String((e && e.message) || e).slice(0, 200) });
        }
    }

    // A key the caller asked us to delete that is still there will be pulled and
    // applied again, so a partial failure is a real one and gets a real status.
    const out = { ok: failed.length === 0, deleted, requested: keys.length };
    if (rejected.length) out.rejected = rejected;
    if (failed.length) {
        out.error = 'ack_incomplete';
        out.failed = failed;
        out.detail = `${failed.length} of ${accepted.length} item(s) could not be deleted and will be pulled again.`;
    }
    res.status(failed.length ? 502 : 200).json(out);
}
