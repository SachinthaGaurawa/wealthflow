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
 *   identify { sha256?, tails?, filename? }                    -> { approved, sha, last4, series }  what the mailbox already knows about the BANK of a statement
 *                                                                                                      uploaded by hand (statement-bank-evidence.mjs): bank labels and counts only
 *
 * The device's own review of a MAILBOX statement (the legacy path: the phone opens the attachment, the owner ticks the rows) is a third
 * door into the same books, and takes the same lock through the same two actions with `itemId` — the mailbox item the statement came from.
 * It then holds the statement as the email door does (same holder, so the sync worker taking the same item later is no duplicate), and a
 * statement turned away is closed as the worker closes one: finished, pointing at who holds it, nothing filed (the attachment itself is kept).
 *
 * The statement's own state also counts: a statement the email sync filed BEFORE the registry existed is found by the SHA-256 of its
 * bytes on the mailbox item, so history is covered for the exact-file case without a backfill.
 *
 * "ALREADY ADDED" MUST BE TRUE. Neither a registry hold nor a filed twin is believed on its own: each is checked against the owner's books
 * (statement-registry.mjs holderProof) — a hold with no record behind it and no worker on it (the statement failed, went to review, was
 * deleted by the owner, or was reviewed on the phone with nothing ticked) is given back and the owner's statement goes in. What is turned
 * away says what is in the books (`detail`), so a disagreement can be settled on sight.
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { identify, userKeyFor } from './gmail-link.mjs';
import { findFiledTwin, duplicatePatch } from './statement-index.mjs';
import { bankHistory } from './statement-bank-evidence.mjs';
import { VIA, identityOf, lookup, holderProof, releaseStatement, registryDuplicatePatch, noticeFor, detailOf, ROWS_CAP } from './statement-registry.mjs';

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

/** `amounts` run beside `dates` (the same places): together they say WHICH transactions the statement has, which is what tells two statements of one month apart. */
function inputsOf(body) {
    const sha = HASH.test(String(body.sha256 || '')) ? String(body.sha256) : '';
    const dates = (Array.isArray(body.dates) ? body.dates : []).slice(0, ROWS_CAP).map(d => text(d, 40));
    const amounts = Array.isArray(body.amounts) ? body.amounts.slice(0, ROWS_CAP) : [];
    const rowKeys = amounts.length === dates.length && dates.length ? dates.map((date, at) => ({ date, amount: Number(amounts[at]) })) : null;
    const identity = body.bank || body.last4 || body.periodText || dates.length ? identityOf({ bank: text(body.bank, 80), account: text(body.last4, 40), periodText: text(body.periodText, 80), dates }) : null;
    return { sha, identity, rowKeys, rows: Math.min(100000, Math.max(0, Math.floor(Number(body.rows)) || 0)) };
}

/** One line in the platform log for every statement turned away or let past another holder: WHY, in words and counts (no amount, no account number, no file name), so "it said already added" can be read from the log. */
function note(action, door, identity, answer) {
    try {
        const held = answer.duplicate ? answer : answer.partial ? { existing: {}, proof: { why: 'other-statement' }, coverage: answer.partial } : null;
        if (!held) return;
        const existing = held.existing || {}, cover = held.coverage || null;
        console.info(JSON.stringify({ evt: 'statement-guard', action, door, verdict: answer.duplicate ? 'duplicate' : 'other-statement', kind: answer.kind || '', via: existing.via || '', holderDoor: existing.door || '', why: held.proof?.why || '',
            records: held.proof?.records || 0, matched: cover ? cover.matched : null, of: cover ? cover.of : null, bank: identity?.bank || '', month: identity?.ok ? `${identity.year}-${String(identity.month).padStart(2, '0')}` : '', ageMin: existing.at ? Math.round((Date.now() - existing.at) / 60000) : null }));
    } catch (_) { /* a log line never stops an answer */ }
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
        if (action === 'identify') {
            /* The upload screen no longer asks which bank: it reads the statement, and asks the mailbox's own history only for what the statement does not say. Read-only. */
            const tails = (Array.isArray(body.tails) ? body.tails : []).slice(0, 3).map(t => text(t, 8).replace(/\D+/g, '')).filter(t => /^\d{4}$/.test(t));
            const found = await withDeadline(bankHistory({ mailRef: db.collection('wf-mail').doc(userKeyFor(who.email)), uid: who.uid, sha: HASH.test(String(body.sha256 || '')) ? String(body.sha256) : '', tails, filename: text(body.filename, 200) }), 20000, 'bank history');
            return json(res, 200, { ok: true, ...found });
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
        /* A statement the email sync filed before the registry existed: found by its bytes on the mailbox item — and only if its records are still in the books. */
        if (sha) {
            const proofs = new Map();
            const twin = await withDeadline(findFiledTwin({ mailRef, sha, selfId: itemId, accept: async doc => {
                const data = doc.data() || {};
                const proof = await holderProof({ db, uid: who.uid, existing: { via: VIA.EMAIL, ref: doc.ref.path, door: data.filedMs ? 'phone' : 'worker', at: Number(data.filedMs) || 0 } });
                proofs.set(doc.id, proof); return proof.live;
            } }), 20000, 'mailbox');
            if (twin) return turnedAway({ via: VIA.EMAIL, kind: 'file', notice: noticeFor(VIA.EMAIL), detail: detailOf({ filename: twin.data.filename }, proofs.get(twin.id)) }, itemRef ? duplicatePatch({ twin }) : null);
        }
        /* The registry says who holds it; a holder with nothing behind it (holderProof) has been given back by the time we hear. */
        const found = await withDeadline(lookup({ db, uid: who.uid, claim: action === 'claim', via, ref, identity, sha, rows: inputs.rows, rowKeys: inputs.rowKeys,
            meta: { filename: body.filename, size: body.size, rows: Number(body.rows) || inputs.rows, door: itemId ? 'phone' : 'upload' } }), 20000, 'statement registry');
        note(action, itemId ? 'phone' : 'upload', identity, found);
        if (found.duplicate) return turnedAway({ via: found.existing.via, kind: found.kind, existing: { ...found.existing, ref: undefined }, notice: noticeFor(found.existing.via), detail: detailOf(found.existing, found.proof, found.coverage) }, itemRef ? registryDuplicatePatch({ duplicate: found }) : null);
        return json(res, 200, { ok: true, duplicate: false, ...(ref ? { id: ref } : {}), identified: !!(identity && identity.ok), ...(found.have && found.have.length ? { have: found.have } : {}) });
    } catch (_) { return json(res, 503, { ok: false, reason: 'registry-unavailable' }); }
}
