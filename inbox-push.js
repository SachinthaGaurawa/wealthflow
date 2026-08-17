// =============================================================================
// WealthFlow Inbox Push (server-side) v4.0
//
// Stores a classified transaction for the device that submitted it, so the app
// can pick it up the next time it opens.
//
//   Path:  wf-inbox/{tokenHash}/items/{msgHash}
//   Doc:   { brain_result, received_at_ms, sms_preview, applied: false }
//   TTL:   none (cleared by the client after apply, via inbox-ack)
//
// Env: FIREBASE_SERVICE_ACCOUNT
// -----------------------------------------------------------------------------
// v4.0 — OFF THE REST API, ONTO THE ADMIN SDK
//
// This endpoint used to PATCH Firestore over REST with only the public Web
// apiKey. Such a request is unauthenticated as far as security rules are
// concerned, so wf-inbox had to be world-writable for it to work at all — see the
// long note in inbox-store.mjs. It now goes through the Admin SDK, which
// authenticates with a service account and bypasses rules, so that branch can be
// closed to the internet without breaking the pipeline.
//
// Two consequences worth stating plainly:
//   · the credential changes from FIREBASE_API_KEY to FIREBASE_SERVICE_ACCOUNT;
//   · the per-device boundary is now enforced HERE and nowhere else, because
//     Firestore no longer gets a vote. The token check is load-bearing.
//
// v3.0 kept: the handler is Node's (req, res) — api/router.js is a Node function
// — and a write that did not land answers 502 with `durable: false` instead of
// reporting a success it never achieved.
// =============================================================================

import {
    getInboxDb, withDeadline, tokenHash, itemKey, deviceTokenFrom, jsonBody,
    INBOX_ROOT, ITEMS,
} from './inbox-store.mjs';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Fallback in-memory store, shared across endpoint modules via globalThis. It
// only ever helps within one warm instance; it is NOT durability, and nothing
// here may report it as such.
const _memStore = globalThis.__wfMemStore || (globalThis.__wfMemStore = new Map());

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'POST required' });
        return;
    }

    let body;
    try { body = jsonBody(req); }
    catch (_) { res.status(400).json({ ok: false, error: 'Invalid JSON' }); return; }

    // The token gate runs before any credential work or database call: an
    // unauthenticated caller must not be able to make the server do anything.
    const tok = deviceTokenFrom(req, body);
    if (!tok) {
        res.status(401).json({ ok: false, error: 'Token required' });
        return;
    }

    const brain = body.brain_result;
    if (!brain || !brain.hash) {
        res.status(400).json({ ok: false, error: 'brain_result with hash required' });
        return;
    }

    const { db, reason } = await getInboxDb();
    if (!db) {
        res.status(503).json({ ok: false, error: 'inbox_not_configured', detail: reason });
        return;
    }

    const tHash = await tokenHash(tok);
    const key = itemKey(tHash, brain.hash);
    const entry = {
        brain_result: brain,
        received_at_ms: body.received_at_ms || Date.now(),
        applied: false,
        sms_preview: String(body.sms || '').slice(0, 140),
    };

    let wrote = { ok: false, detail: null };
    try {
        await withDeadline(
            db.collection(INBOX_ROOT).doc(tHash).collection(ITEMS).doc(String(brain.hash)).set(entry),
            8000, 'Firestore write',
        );
        wrote = { ok: true, detail: null };
    } catch (e) {
        wrote = { ok: false, detail: String((e && e.message) || e).slice(0, 300) };
    }

    // Keep the in-instance copy, carrying whether the durable write behind it
    // landed. Without that flag inbox-pull would serve a memory-only item as
    // though it were stored, moving the dishonesty one hop downstream.
    _memStore.set(key, { v: entry, exp: Date.now() + WEEK_MS, durable: wrote.ok });

    if (!wrote.ok) {
        res.status(502).json({
            ok: false,
            error: 'inbox_not_durable',
            key,
            durable: false,
            detail: `Firestore did not accept the write (${wrote.detail}). The item is held in this `
                + 'instance\'s memory only and will not survive; the classification is in this response.',
        });
        return;
    }

    res.status(200).json({ ok: true, key, durable: true });
}
