// =============================================================================
// WealthFlow Inbox Pull (server-side) v4.0
// Returns the transactions waiting for the calling device.
// -----------------------------------------------------------------------------
// v4.0 — OFF THE REST API, ONTO THE ADMIN SDK. See inbox-store.mjs for why: over
// REST this endpoint was unauthenticated as far as security rules go, so wf-inbox
// had to be world-readable for it to work. Through the Admin SDK it bypasses
// rules, so that branch can be sealed.
//
// v3.0 kept, and it is the important part: A FAILED READ IS NOT AN EMPTY INBOX.
// The old fsList() returned `[]` from its catch AND on !r.ok, so "I could not
// look" and "there is nothing waiting" were the same answer. The app's poller then
// reported `drained: 0` — accurate, and completely misleading. This is the most
// dangerous shape a bug can take here: it suppresses rather than over-reports, and
// nobody files a report for a transaction they were never shown.
// =============================================================================

import {
    getInboxDb, withDeadline, tokenHash, itemKey, deviceTokenFrom,
    INBOX_ROOT, ITEMS,
} from './inbox-store.mjs';

const _memStore = globalThis.__wfMemStore || (globalThis.__wfMemStore = new Map());
const PAGE = 50;

export default async function handler(req, res) {
    // The header is what the app sends (wealthflow-autonomous.js). ?token= is
    // retained for the manual-debug path it was added for; it is a weaker channel
    // because query strings land in access logs, and it is filed as an open
    // finding rather than changed here without the owner's say-so.
    const tok = deviceTokenFrom(req, null);
    if (!tok) {
        res.status(401).json({ ok: false, error: 'Token required' });
        return;
    }

    const { db, reason } = await getInboxDb();
    if (!db) {
        res.status(503).json({ ok: false, error: 'inbox_not_configured', detail: reason });
        return;
    }

    const tHash = await tokenHash(tok);

    let listed = { ok: false, items: [], detail: null };
    try {
        const snap = await withDeadline(
            db.collection(INBOX_ROOT).doc(tHash).collection(ITEMS).limit(PAGE).get(),
            8000, 'Firestore read',
        );
        // The key format is unchanged from the REST era, so an ack the client
        // queued before this migration still resolves after it.
        listed = {
            ok: true,
            items: snap.docs.map((d) => ({ key: itemKey(tHash, d.id), ...d.data(), durable: true })),
            detail: null,
        };
    } catch (e) {
        listed = { ok: false, items: [], detail: String((e && e.message) || e).slice(0, 300) };
    }

    const memPrefix = `${INBOX_ROOT}/${tHash}/${ITEMS}/`;
    const memItems = [];
    const now = Date.now();
    for (const [k, v] of _memStore.entries()) {
        if (!k.startsWith(memPrefix) || (v.exp && v.exp <= now)) continue;
        // inbox-push records whether the durable write behind a memory copy
        // landed. An item it could not store is still worth delivering — it is
        // real, and this may be the only instance holding it — but it must not be
        // presented as though it were safely in the database.
        memItems.push({ key: k, ...v.v, durable: v.durable !== false });
    }

    // Deduplicate by key. Firestore wins: an item read back from the database is
    // durable by definition.
    const map = new Map();
    for (const i of memItems) map.set(i.key, i);
    for (const i of listed.items) map.set(i.key, i);
    const items = Array.from(map.values());
    const nonDurable = items.filter((i) => i.durable === false).length;

    if (!listed.ok) {
        // 502 even when the memory fallback produced items: this instance cannot
        // see the durable inbox, so `count` is a floor and not a total. Answering
        // 200 here is what let a broken read read as an empty inbox.
        res.status(502).json({
            ok: false,
            error: 'inbox_read_failed',
            detail: `Firestore did not answer the read (${listed.detail}). `
                + 'Any items below come from this instance\'s memory only and may be incomplete.',
            count: items.length,
            nonDurable,
            items,
        });
        return;
    }

    // `nonDurable` is surfaced on the happy path too: it is 0 in normal operation,
    // and any other value says a push could not reach the database — worth knowing
    // before the number of affected items grows.
    res.status(200).json({ ok: true, count: items.length, nonDurable, items });
}
