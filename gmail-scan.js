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
import { identify, sendersOf, SENDERS_FIELD, HELD_FIELD, mergeHeld } from './gmail-link.mjs';
import {
    normalizeList, approvedClauses, policyFrom, recordSighting,
} from './wealthflow-mail-senders.mjs';
import { monthKey } from './wealthflow-sender-discovery.js';
import { accessTokenFrom, authed } from './google-oauth.mjs';
import { planMessage, planWrite, planHold, MAX_HELD, isWorthTelling, REJECT_TEXT } from './wealthflow-mail-ingest.mjs';
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

    const ref = db.collection(MAIL_ROOT).doc(who.userKey);

    /* THE STATE IS READ BEFORE THE WINDOW IS BUILT, and that ordering is the
     * point: the window's query is now made of the owner's approved senders,
     * which live in this document. Building it first would ask Gmail the old
     * broad question — every PDF whose subject carries a common word — which is
     * how bills and receipts reached a screen meant for statements. */
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

    /* Read from the sealed document, never from the request. See windowFor. */
    const senderList = normalizeList(sendersOf(state));
    const policy = policyFrom(senderList);
    /* Accumulates this page's sightings; written back once at the end rather
     * than per message, because a document write per mail is how a scan of a
     * busy month becomes a quota bill. */
    let seen = senderList;

    /* The window is DERIVED, never accepted. See gmail-scan.mjs: a free-text
     * query parameter would turn a credential that can read the whole mailbox
     * into a general mail-search proxy. */
    const window = windowFor({
        months: body.months, index: body.index, now: body.now,
        senders: approvedClauses(senderList),
        /* THE ONE THING THE CALLER MAY WIDEN, AND IT WIDENS NOTHING THAT GETS
         * STORED. A discovery run asks Gmail for every message with an
         * attachment in the window, minus the personal mailboxes — no file-type
         * gate and no vocabulary, because both of those made banks with
         * different habits invisible rather than merely lower-ranked.
         *
         * It is also the run that reads LEAST: headers only, no body, no
         * attachment. The old rule was that mail from an unapproved sender is
         * refused before an attachment is fetched. This makes that structural
         * instead of conditional — a discovery run over an entire mailbox
         * cannot copy one document out of it, whatever the policy says.
         *
         * The query is still DERIVED here, never accepted, for the same reason
         * as always: a caller-shaped query against a credential that can read a
         * whole mailbox is a general mail-search proxy. */
        discover: body.discover === true ? true : null,
        /* The institutions the owner holds, off their own records. Names only —
         * see windowFor: they are looked up, never used as text. */
        banks: Array.isArray(body.banks) ? body.banks : [],
    });
    if (!window) {
        return j(res, 400, { ok: false, error: 'that is not a window this scan can ask for' });
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
    /* References to messages refused for a sender reason — see planHold. */
    const held = [];
    const skipped = [];

    /* Headers only on a discovery window. `format=metadata` returns From,
     * Subject and internalDate and NO body — so the loop below physically
     * cannot reach an attachment, rather than choosing not to. */
    const discovering = window.discovery === true;
    const fmt = discovering
        ? 'format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date'
        : 'format=full';

    for (const id of ids.slice(0, boundedMax(body.max, discovering))) {
        let msg;
        try {
            const r = await f(`${GMAIL}/messages/${encodeURIComponent(id)}?${fmt}`, { headers: authed(token) });
            if (!r.ok) continue;                       // one unreadable message is not a failed scan
            msg = await r.json();
        } catch (_) { continue; }

        /* A DISCOVERY RUN ENDS HERE. It has the sender, the subject and the
         * date, which is everything the ranking needs, and it has downloaded
         * nothing. planMessage() below expects a full message and would find no
         * parts in a metadata one — calling it anyway would report every sender
         * as "no attachment" and quietly teach the owner the opposite of the
         * truth. */
        if (discovering) {
            const hdrs = {};
            for (const h of (msg && msg.payload && msg.payload.headers) || []) {
                if (h && h.name) hdrs[String(h.name).toLowerCase()] = h.value;
            }
            seen = recordSighting(seen, {
                from: hdrs.from || '',
                subject: hdrs.subject || '',
                now: Date.now(),
                /* The month the MESSAGE landed in, not the month of the run.
                 * Recurrence is the strongest signal discovery has, and
                 * stamping every sighting with today would make every sender
                 * look like it wrote once. */
                month: monthKey(Number(msg.internalDate) || window.after),
            });
            continue;
        }

        /* The SAME plan the live hook applies: allowlisted sender, DKIM held,
         * an attachment worth taking. A second copy of that judgement is a
         * second place for a statement to be accepted that should not be. */
        const plan = planMessage(msg, policy);

        /* THE GATHERING THE OWNER ASKED FOR.
         *
         * Recorded whether the message was taken or refused, and refused mail
         * matters MORE: a sender nobody has approved yet is exactly the one to
         * put in front of them. Without this the strict rule would be a wall —
         * "not on your list" with no way to get on it. */
        seen = recordSighting(seen, {
            from: plan.from, subject: plan.subject, now: Date.now(),
            month: monthKey(Number(msg.internalDate) || window.after),
        });

        if (!plan.ok) {
            if (isWorthTelling(plan)) {
                skipped.push({ bank: plan.bank || null, reason: plan.reason, text: REJECT_TEXT[plan.reason] });
            }
            /* HELD, NOT DROPPED — the same rule as the push hook, applied here
             * because a rule kept in one of this pair and not the other is this
             * repository's most repeated defect. */
            const hold = planHold(plan, msg);
            if (hold) { held.push(hold); }
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
                    /* FINALLY STORED. planMessage computed `known` from the
                     * first day and no manifest had a place for it, so the
                     * device could not tell a confirmed bank from a merely
                     * verified stranger and drew them identically. */
                    known: item.known !== false,
                    from: item.from || '',
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

    /* One write for the whole page. A failure here loses sightings, never a
     * statement — the statements are already stored — so it is caught and the
     * page still reports success. */
    let discovered = 0;
    try {
        if (seen !== senderList || held.length) {
            discovered = seen.filter((e) => e && e.status === 'new').length;
            await withDeadline(ref.set({
                ...(seen !== senderList ? { [SENDERS_FIELD]: seen } : {}),
                ...(held.length ? { [HELD_FIELD]: mergeHeld(state && state[HELD_FIELD], held) } : {}),
            }, { merge: true }), 8000, 'wf-mail senders');
        }
    } catch (_) { /* the scan succeeded; the suggestions can wait for the next page */ }

    return j(res, 200, {
        ok: true,
        window: { label: window.label },
        /* So the card can say "three senders are waiting for you to decide"
         * rather than leaving the strict rule looking like a silent failure. */
        discovered,
        ...pageResult({ ids, stored, skipped, pageToken: listed && listed.nextPageToken }),
    });
}
