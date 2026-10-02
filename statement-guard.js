/* =============================================================================
 * statement-guard.js — POST /api/statement-guard : the upload door and the mailbox-review door of the statement registry
 * -----------------------------------------------------------------------------
 * The manual upload screen runs in the browser; the registry (statement-registry.mjs) is written by the server only, so that a
 * statement the email crawler filed and one the owner uploaded are held to ONE rule by ONE writer. Identity is the verified Firebase
 * ID token and nothing else: the caller can only ever ask about, and take, statements in their OWN books.
 *
 *   check    { sha256?, bank?, last4?, periodText?, dates? }  -> { duplicate, via, notice }    read-only, runs before anything is parsed
 *   claim    { ...check fields, token, filename?, size?, rows? } -> { duplicate:false } or { duplicate:true, via, notice }   atomic, at save
 *   release  { id }                                            -> { released }                 give a statement back so it can be added again
 *
 * The device's own review of a MAILBOX statement (the legacy path: the phone opens the attachment, the owner ticks the rows) is a third
 * door into the same books, and takes the same lock through the same two actions with `itemId` — the mailbox item the statement came from.
 * It then holds the statement as the email door does (same holder, so the sync worker taking the same item later is no duplicate), and a
 * statement turned away is closed as the worker closes one: finished, pointing at who holds it, nothing filed (the attachment itself is kept).
 *
 * The statement's own state also counts: a statement the email sync filed BEFORE the registry existed is found by the SHA-256 of its
 * bytes on the mailbox item, so history is covered for the exact-file case without a backfill.
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { identify, userKeyFor } from './gmail-link.mjs';
import { findFiledTwin, duplicatePatch } from './statement-index.mjs';
import { VIA, identityOf, claimStatement, peekStatement, releaseStatement, uploadHoldIsStale, registryDuplicatePatch, noticeFor } from './statement-registry.mjs';

const json = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
const HASH = /^[a-f\d]{64}$/;
const ITEM = /^[A-Za-z0-9._-]{1,200}$/;
const text = (value, max) => String(value == null ? '' : value).slice(0, max);

/** A mailbox statement the lock turned away is finished: closed in a transaction, unless it is already filed or the sync worker holds its lease right now (it finds the same holder itself).
 *  Only the flag is written. The stored attachment stays: if the match was wrong, the statement can still be opened again, and nothing the owner could not get back is deleted. */
async function closeMailItem({ db, itemRef, patch, now = Date.now() }) {
    return db.runTransaction(async tx => {
        const snap = await tx.get(itemRef), data = snap.data() || {};
        if (!snap.exists || data.filed === true || Number(data.leaseUntil) > now) return false;
        tx.set(itemRef, patch, { merge: true });
        return true;
    });
}

function inputsOf(body) {
    const sha = HASH.test(String(body.sha256 || '')) ? String(body.sha256) : '';
    const dates = (Array.isArray(body.dates) ? body.dates : []).slice(0, 2000).map(d => text(d, 40));
    const identity = body.bank || body.last4 || body.periodText || dates.length ? identityOf({ bank: text(body.bank, 80), account: text(body.last4, 40), periodText: text(body.periodText, 80), dates }) : null;
    return { sha, identity };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, reason: 'method-not-allowed' });
    let body;
    try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch (_) { return json(res, 400, { ok: false, reason: 'invalid-body' }); }
    const { db, admin } = await getAdminDb();
    if (!db) return json(res, 503, { ok: false, reason: 'registry-unavailable' });
    const who = await identify(req, { verifyIdToken: admin ? token => admin.auth().verifyIdToken(token, true) : null });
    if (!who.ok || !who.uid) return json(res, who.status || 401, { ok: false, reason: who.reason });
    const action = String(body.action || '');
    try {
        if (action === 'release') {
            const id = text(body.id, 400);
            if (!id) return json(res, 400, { ok: false, reason: 'invalid-body' });
            return json(res, 200, { ok: true, released: await withDeadline(releaseStatement({ db, uid: who.uid, ref: id })) });
        }
        if (action !== 'check' && action !== 'claim') return json(res, 400, { ok: false, reason: 'unknown-action' });
        const inputs = inputsOf(body);
        const itemId = body.itemId == null ? '' : (ITEM.test(String(body.itemId)) ? String(body.itemId) : null);
        if (itemId === null) return json(res, 400, { ok: false, reason: 'invalid-body' });
        const mailRef = db.collection('wf-mail').doc(userKeyFor(who.email));
        /* THE MAILBOX DOOR names the item it came from; the path is built here from the verified sign-in, never taken from the caller. */
        let itemRef = null, item = null;
        if (itemId) {
            itemRef = mailRef.collection('items').doc(itemId);
            const snap = await withDeadline(itemRef.get());
            item = snap.exists ? (snap.data() || {}) : null;
            if (!item || (item.uid && item.uid !== who.uid)) return json(res, 404, { ok: false, reason: 'unknown-statement' });
        }
        const sha = inputs.sha || (item && HASH.test(String(item.contentSha256 || '')) ? String(item.contentSha256) : ''), identity = inputs.identity;
        if (!sha && !(identity && identity.ok)) return json(res, 400, { ok: false, reason: 'nothing-to-check' });
        /* A check has no holder of its own, so ANY existing holder is a duplicate — including an earlier upload of this very file. A claim is
         * held by one upload attempt (`token`, made by the page): retrying that attempt after a dropped answer is a no-op, a new attempt is not.
         * A mailbox statement is held by its item, like the email sync's own: the same item may take it again. */
        const token = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.token || '')) ? String(body.token) : '';
        if (action === 'claim' && !token && !itemId) return json(res, 400, { ok: false, reason: 'token-required' });
        const via = itemId ? VIA.EMAIL : VIA.UPLOAD;
        const ref = itemId ? itemRef.path : (action === 'claim' ? `upload:${token}` : '');
        const turnedAway = async (answer, patch) => {
            const closed = itemRef && patch ? await withDeadline(closeMailItem({ db, itemRef, patch })) : false;
            return json(res, 200, { ok: true, duplicate: true, ...answer, ...(itemRef ? { closed } : {}) });
        };
        /* A statement already filed from this very item (the sync worker got there between the phone listing it and the owner pressing Save). */
        if (item && item.filed === true) return json(res, 200, { ok: true, duplicate: true, via: VIA.EMAIL, kind: 'item', notice: noticeFor(VIA.EMAIL), closed: false });
        /* A statement the email sync filed before the registry existed: found by its bytes on the mailbox item. */
        if (sha) {
            const twin = await withDeadline(findFiledTwin({ mailRef, sha, selfId: itemId }));
            if (twin) return turnedAway({ via: VIA.EMAIL, kind: 'file', notice: noticeFor(VIA.EMAIL) }, itemRef ? duplicatePatch({ twin }) : null);
        }
        const attempt = () => (action === 'check'
            ? withDeadline(peekStatement({ db, uid: who.uid, identity, sha, ref }))
            : withDeadline(claimStatement({ db, uid: who.uid, via, ref, identity, sha, meta: { filename: body.filename, size: body.size, rows: body.rows } })));
        let found = await attempt();
        /* A HAND UPLOAD WHOSE RECORDS THE OWNER HAS SINCE DELETED HOLDS NOTHING: its lock is given back and the statement may be added again. */
        if (found.duplicate && await withDeadline(uploadHoldIsStale({ db, uid: who.uid, existing: found.existing }))) {
            await withDeadline(releaseStatement({ db, uid: who.uid, ref: found.existing.ref }));
            found = await attempt();
        }
        if (found.duplicate) return turnedAway({ via: found.existing.via, kind: found.kind, existing: { ...found.existing, ref: undefined }, notice: noticeFor(found.existing.via) }, itemRef ? registryDuplicatePatch({ duplicate: found }) : null);
        return json(res, 200, { ok: true, duplicate: false, ...(ref ? { id: ref } : {}), identified: !!(identity && identity.ok) });
    } catch (_) { return json(res, 503, { ok: false, reason: 'registry-unavailable' }); }
}
