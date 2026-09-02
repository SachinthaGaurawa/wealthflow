/* =============================================================================
 * gmail-link.js  →  /api/gmail-link
 * -----------------------------------------------------------------------------
 * The missing half of the mail pipeline: the endpoint that puts a refresh token
 * where gmail-hook.js looks for it, and reports back whether one is there.
 *
 * GET   /api/gmail-link   → { connected, email?, linkedAt?, lastPushMs?, missing[] }
 * POST  /api/gmail-link   { refresh_token }  → { ok, connected }
 * DELETE /api/gmail-link  → { ok, connected: false }
 *
 * ── WHY AN ENDPOINT AND NOT A FIRESTORE WRITE FROM THE PAGE ─────────────────
 *
 * firestore.rules closes with `match /{document=**} { allow read, write: if false }`
 * and has no entry for wf-mail. That branch is sealed to every client, which is
 * right: it holds a credential that can read a person's whole mailbox.
 *
 * It also means the page cannot READ it — and the Statement Sync card shipped
 * doing exactly that. Its connected-check queried wf-mail from the browser, so
 * it was always denied, always caught, and always answered "not connected". It
 * would have said that with a mailbox perfectly connected, because it could
 * never see the answer. Both directions move here.
 *
 * The server reaches Firestore with the Admin SDK, which bypasses rules — the
 * same mechanism inbox-store.mjs uses for wf-inbox, and the reason that branch
 * can stay sealed while the pipeline works.
 *
 * ── WHICH MAKES identify() THE WHOLE BOUNDARY ───────────────────────────────
 *
 * Once rules are bypassed, Firestore no longer gets a vote: whatever document
 * this file addresses is the document that gets read or written. The only thing
 * standing between one account and another's Gmail credential is that the
 * document key is derived from a VERIFIED email on a Firebase ID token, and
 * from nothing the caller sends. That decision, and its refusals, live in
 * gmail-link.mjs and are tested there.
 *
 * ENV: FIREBASE_SERVICE_ACCOUNT (Admin SDK), GOOGLE_OAUTH_CLIENT_ID,
 *      GOOGLE_OAUTH_CLIENT_SECRET, GMAIL_PUBSUB_AUDIENCE.
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import {
    MAIL_ROOT, identify, looksLikeRefreshToken, linkRecord, statusOf, missingConfig,
    SENDERS_FIELD, sendersOf,
} from './gmail-link.mjs';
import { dedupeStored } from './wealthflow-mail-ingest.mjs';
import {
    addSender, setStatus, removeSender, normalizeList, groupForDisplay, REASON_TEXT,
} from './wealthflow-mail-senders.mjs';

/* How many stored documents this endpoint will look at, and how many
 * statements it will return once duplicates are collapsed.
 *
 * The scan ceiling is the higher of the two on purpose: a store carrying
 * several copies of each statement must still be able to yield a full page of
 * DISTINCT ones. Both are bounded because this runs inside a function with a
 * deadline, and an unbounded read of someone's whole mail history is how that
 * deadline gets hit. */
export const ITEMS_SCAN_MAX = 400;
export const ITEMS_RETURN_MAX = 200;

/* How many statements one delete request may name. Bounded because each one is
 * a document read plus several deletes inside a function with a deadline, and
 * because an unbounded delete list is the shape of request that empties a
 * store by accident. It is comfortably above ITEMS_RETURN_MAX so "remove
 * everything I can see" is always one call. */
export const ITEMS_DELETE_MAX = 250;

function j(res, code, body) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
}

/**
 * The Admin SDK's token verifier, or null when it is not configured.
 *
 * Built from the module admin-db.mjs already initialised, NOT from a second
 * `import('firebase-admin')` of its own. Two reasons, and both had teeth here:
 * a separate import is a second bootstrap around the one module that exists to
 * be the only one, and — because it cannot be redirected by _setAdminModule —
 * it made this handler impossible to execute in a test without reaching the
 * live project. So it was never executed, and a crash on the line after
 * identity shipped.
 */
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

export default async function handler(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'DELETE'].includes(method)) {
        return j(res, 405, { ok: false, error: 'method not allowed' });
    }

    /* ONE bootstrap, destructured. getAdminDb() returns { db, reason, admin } and
     * NEVER a bare handle — admin-db.mjs says so at the top of the file and
     * statement-store.js has always read it that way. This file did not, and
     * `if (!db)` was therefore never true: the wrapper object is always truthy.
     * Every request reached `db.collection(...)` on the wrapper and died there
     * with `TypeError: db.collection is not a function` — GET as much as POST,
     * so the Statement Sync card's "Not connected" was a 500 wearing a calm
     * face, and the token could never have been saved by anyone. */
    const { db, reason, admin } = await getAdminDb();

    /* Identity first, always. A caller who has not proved who they are learns
     * nothing about this deployment's configuration — including whether it has
     * a credential at all. When there is no verifier, identify() answers 503
     * "identity cannot be established", which is the honest shape: the server
     * cannot check, rather than the caller's token being bad. */
    const who = await identify(req, { verifyIdToken: verifierFrom(admin) });
    if (!who.ok) {
        /* The reason is named but nothing about the stored state is revealed —
         * a 403 that also said "and there is a mailbox linked here" would answer
         * a question the caller has not earned. */
        return j(res, who.status || 401, { ok: false, error: who.reason });
    }

    if (!db) {
        /* The reason, passed through. admin-db.mjs authors these strings to be
         * READ — it strips the credential head out of a JSON.parse failure
         * itself — and "database unavailable" with nothing after it is the
         * sentence that makes somebody go and read the source to find out which
         * variable is unset. Capped, because a reason is not a stack trace. */
        return j(res, 503, { ok: false, error: String(reason || 'database unavailable').slice(0, 300) });
    }

    const ref = db.collection(MAIL_ROOT).doc(who.userKey);

    /* ── THE OWNER'S STATEMENT-SENDER LIST ───────────────────────────────────
     *
     * Read and written here rather than from the page for the reason every
     * other wf-mail field is: firestore.rules seals that branch to clients, and
     * the two things that actually CONSULT this list — the push hook and the
     * scan endpoint — have no browser in front of them at all.
     *
     * Every mutation goes through wealthflow-mail-senders.mjs, which is where
     * normalisation, the ceilings and the refusals live. This handler does not
     * parse an address, decide what is a domain, or trim a list: a second copy
     * of those rules is a second set of answers, and the two would drift. */
    if (/[?&]senders=1/.test(String(req.url || ''))) {
        if (method === 'DELETE') return j(res, 405, { ok: false, error: 'use POST with an action' });

        let snap;
        try {
            snap = await withDeadline(ref.get(), 8000, 'wf-mail senders');
        } catch (_) {
            return j(res, 503, { ok: false, error: 'sender list unreadable' });
        }
        const current = normalizeList(sendersOf(snap && snap.exists ? snap.data() : null));

        if (method === 'GET') {
            return j(res, 200, { ok: true, senders: current, ...groupForDisplay(current) });
        }

        const body = await readBody(req);
        const action = String((body && body.action) || '').toLowerCase();
        const value = (body && body.value) != null ? String(body.value) : '';
        const now = Date.now();
        let result;

        if (action === 'add') {
            result = addSender(current, value, {
                status: body && body.status === 'blocked' ? 'blocked' : 'approved',
                name: (body && body.name) || '',
                now,
            });
            if (!result.ok) {
                /* The refusal is named in a sentence the owner can act on —
                 * "that is a personal mailbox" tells them what to do next,
                 * where "invalid" sends them to look for a bug. */
                return j(res, 400, {
                    ok: false, error: REASON_TEXT[result.reason] || 'that could not be added',
                    reason: result.reason,
                });
            }
        } else if (action === 'status') {
            result = setStatus(current, value, String((body && body.status) || ''), { now });
            if (!result.ok) return j(res, 404, { ok: false, error: 'no such sender' });
        } else if (action === 'remove') {
            result = removeSender(current, value);
            if (!result.ok) return j(res, 404, { ok: false, error: 'no such sender' });
        } else {
            return j(res, 400, { ok: false, error: 'action must be add, status or remove' });
        }

        try {
            await withDeadline(ref.set({ [SENDERS_FIELD]: result.list }, { merge: true }), 8000, 'wf-mail senders');
        } catch (_) {
            return j(res, 503, { ok: false, error: 'could not save the sender list' });
        }
        return j(res, 200, { ok: true, senders: result.list, ...groupForDisplay(result.list) });
    }

    /* ── REMOVING WHAT IS ALREADY STORED ─────────────────────────────────────
     *
     * #167 stopped unapproved senders being FETCHED. It removed none of what
     * was already in the store, so the bills and receipts the owner complained
     * about were still on their screen after a fix that claimed to address
     * them. That is the same shape as #164 and #165 — a change to future
     * writes, presented as a repair of what is on the screen — and it is the
     * third time, so it is being closed rather than noted.
     *
     * DELETION IS THE ONE ACTION HERE THAT CANNOT BE UNDONE. Everything else in
     * this file collapses, hides or refuses; this erases a document. So it is
     * done ONLY against keys the caller names, one explicit list, never by a
     * rule this endpoint evaluates for itself. "Delete everything matching a
     * pattern" is a sentence that, with one bad pattern, ends someone's
     * statement history — and no reading of the owner's request requires it. */
    if (method === 'POST' && /[?&]items=1/.test(String(req.url || ''))) {
        const body = await readBody(req);
        const action = String((body && body.action) || '');
        if (action !== 'delete' && action !== 'filed') {
            return j(res, 400, { ok: false, error: 'action must be delete or filed' });
        }
        const keys = Array.isArray(body.keys) ? body.keys : [];
        const wanted = [...new Set(keys.map((k) => String(k || '').trim()).filter(Boolean))]
            .slice(0, ITEMS_DELETE_MAX);
        if (!wanted.length) return j(res, 400, { ok: false, error: 'name at least one statement' });

        /* ── DONE, NOT DELETED ───────────────────────────────────────────────
         *
         * Nothing marked a statement as dealt with, so every press of Check now
         * re-listed, re-decrypted and re-parsed every statement ever stored.
         * The owner saw the same statements forever and the phone paid for it
         * each time.
         *
         * The obvious fix — delete the item once it is filed — is WRONG, and
         * quietly so. The existence check on this document is the only thing
         * stopping the push hook and the scanner re-fetching the same
         * attachment; delete it and the next scan stores it again, so the
         * statement returns and the duplicate bug it was meant to end comes
         * back worse. So the manifest STAYS as the record that this attachment
         * has been dealt with, and only the parts — the base64 payload, which
         * is essentially all of the bytes — are dropped.
         *
         * ORDER MATTERS AND IS THE OPPOSITE OF THE DELETE BELOW. The flag is
         * written FIRST and the parts dropped after. The other way round, a
         * failure between the two leaves a statement with no parts and no flag:
         * it would be listed forever, fail to assemble every time, and look
         * like a corrupt statement rather than a finished one. */
        if (action === 'filed') {
            let marked = 0;
            const missed = [];
            for (const key of wanted) {
                const itemRef = ref.collection('items').doc(key);
                try {
                    await withDeadline(itemRef.set({ filed: true, filedMs: Date.now() }, { merge: true }), 8000, 'item');
                    marked += 1;
                    try {
                        const ps = await withDeadline(itemRef.collection('parts').get(), 8000, 'parts');
                        for (const part of (ps && ps.docs) || []) await part.ref.delete();
                    } catch (_) {
                        /* The flag landed, so the statement will not be offered
                         * again. Parts left behind cost storage and nothing
                         * else — never correctness. */
                    }
                } catch (_) { missed.push(key); }
            }
            return j(res, 200, { ok: true, marked, missed });
        }

        let deleted = 0;
        const failed = [];
        for (const key of wanted) {
            const itemRef = ref.collection('items').doc(key);
            try {
                /* PARTS FIRST, MANIFEST LAST — the reverse of the write order,
                 * and for the same reason. A reader treats the manifest as the
                 * proof every part landed, so deleting the manifest first would
                 * leave orphaned parts that no longer belong to anything; this
                 * way an interrupted delete leaves a manifest whose parts are
                 * short, which the device already handles as an unreadable
                 * statement rather than as a wrong one. */
                const ps = await withDeadline(itemRef.collection('parts').get(), 8000, 'parts');
                for (const part of (ps && ps.docs) || []) await part.ref.delete();
                await withDeadline(itemRef.delete(), 8000, 'item');
                deleted += 1;
            } catch (_) {
                /* Named rather than swallowed: a delete that silently did
                 * nothing is how the row comes back on the next refresh and the
                 * owner concludes the button is broken. */
                failed.push(key);
            }
        }
        return j(res, 200, { ok: true, deleted, failed });
    }

    if (method === 'GET' && /[?&]items=1/.test(String(req.url || ''))) {
        /* The pending statements, assembled parts and all.
         *
         * These go through the server for the same reason the status does: the
         * items live under wf-mail, which is sealed to clients. What comes back
         * is the CIPHERTEXT exactly as gmail-hook stored it — this endpoint
         * holds no vault key and decrypts nothing. The PDF is opened on the
         * device, with a password that never leaves it. */
        try {
            /* THE CAP USED TO BE 25, AND IT WAS THE WRONG SHAPE OF LIMIT.
             *
             * A deep scan of two years across ten banks stores far more than
             * twenty-five statements, so the owner could run a successful
             * backfill and still be shown a fraction of it with nothing saying
             * why. The ceiling is now high enough to hold a real history, and
             * it is applied AFTER duplicates are collapsed so a store full of
             * repeats cannot crowd out real statements. */
            const snap = await withDeadline(ref.collection('items').limit(ITEMS_SCAN_MAX).get(), 8000, 'wf-mail items');
            const rows = [];
            for (const doc of (snap && snap.docs) || []) {
                rows.push({ id: doc.id, ref: doc.ref, manifest: doc.data() });
            }

            /* Collapsed BEFORE the parts are read. Assembling every copy of a
             * statement only to throw all but one away is the same work done
             * several times over, on a phone, for nothing. */
            const collapsed = dedupeStored(rows);

            /* AND THEN THE FINISHED ONES ARE DROPPED — after the collapse, not
             * before. A statement stored several times may have been marked on
             * any one of those copies; filtering first would let an unmarked
             * copy survive the collapse and be offered again, which is the
             * duplicate the owner reported wearing a different hat. */
            const done = collapsed.filter((r) => r.manifest && r.manifest.filed === true).length;
            const keep = collapsed
                .filter((r) => !(r.manifest && r.manifest.filed === true))
                .slice(0, ITEMS_RETURN_MAX);

            const items = [];
            for (const row of keep) {
                const parts = [];
                try {
                    const ps = await withDeadline(row.ref.collection('parts').get(), 8000, 'parts');
                    for (const p of (ps && ps.docs) || []) parts.push(p.data());
                } catch (_) { /* an unreadable part shows up as a short assembly */ }
                items.push({ id: row.id, manifest: row.manifest, parts });
            }
            /* `duplicates` is reported rather than hidden: the owner asked why
             * the same statements kept appearing, and a number they can watch
             * fall to zero is a better answer than a list that quietly got
             * shorter. */
            return j(res, 200, {
                ok: true, items, scanned: rows.length,
                duplicates: rows.length - collapsed.length,
                /* Reported, not hidden: "12 already filed" is the sentence that
                 * tells the owner an empty list means finished rather than
                 * broken. Computed from the same collapse the list came from,
                 * so the numbers on the card always add up. */
                filed: done,
            });
        } catch (_) {
            return j(res, 503, { ok: false, error: 'items unreadable' });
        }
    }

    if (method === 'GET') {
        let snap;
        try {
            snap = await withDeadline(ref.get(), 8000, 'wf-mail');
        } catch (_) {
            return j(res, 503, { ok: false, error: 'state unreadable' });
        }
        return j(res, 200, {
            ok: true,
            ...statusOf(snap && snap.exists ? snap.data() : null),
            /* Which environment variables are still unset. Reported so the card
             * can name the missing piece instead of saying "not connected",
             * which is the sentence that sent somebody reading the source. */
            missing: missingConfig(process.env),
        });
    }

    if (method === 'DELETE') {
        try {
            /* The token field only. The rest of the document — historyId above
             * all — is the hook's record of what it has already ingested, and
             * deleting that would make the next connection re-import the whole
             * mailbox. Disconnecting is not the same as forgetting. */
            await withDeadline(ref.set({
                refresh_token: admin.firestore.FieldValue.delete(),
                unlinkedAt: Date.now(),
            }, { merge: true }), 8000, 'wf-mail');
        } catch (_) {
            return j(res, 503, { ok: false, error: 'could not disconnect' });
        }
        return j(res, 200, { ok: true, connected: false });
    }

    const body = await readBody(req);
    const token = body && body.refresh_token;
    if (!looksLikeRefreshToken(token)) {
        /* Says WHICH mistake without echoing the value back — an error that
         * quotes the credential it rejected is how secrets reach logs. */
        return j(res, 400, {
            ok: false,
            error: 'that does not look like a refresh token. It should be the '
                 + 'refresh_token value alone — not an access token (ya29.…), not the '
                 + 'authorization code (4/…), not the client secret, and not the whole JSON.',
        });
    }

    try {
        await withDeadline(ref.set(linkRecord(who.email, token), { merge: true }), 8000, 'wf-mail');
    } catch (_) {
        return j(res, 503, { ok: false, error: 'could not save' });
    }
    return j(res, 200, { ok: true, connected: true, email: who.email, missing: missingConfig(process.env) });
}
