/* =============================================================================
 * statement-guard.js — POST /api/statement-guard : the manual-upload door of the statement registry
 * -----------------------------------------------------------------------------
 * The manual upload screen runs in the browser; the registry (statement-registry.mjs) is written by the server only, so that a
 * statement the email crawler filed and one the owner uploaded are held to ONE rule by ONE writer. Identity is the verified Firebase
 * ID token and nothing else: the caller can only ever ask about, and take, statements in their OWN books.
 *
 *   check    { sha256?, bank?, last4?, periodText?, dates? }  -> { duplicate, via, notice }    read-only, runs before anything is parsed
 *   claim    { ...check fields, token, filename?, size?, rows? } -> { duplicate:false } or { duplicate:true, via, notice }   atomic, at save
 *   release  { id }                                            -> { released }                 give a statement back so it can be added again
 *
 * The statement's own state also counts: a statement the email sync filed BEFORE the registry existed is found by the SHA-256 of its
 * bytes on the mailbox item, so history is covered for the exact-file case without a backfill.
 * ===========================================================================*/

import { getAdminDb, withDeadline } from './admin-db.mjs';
import { identify, userKeyFor } from './gmail-link.mjs';
import { findFiledTwin } from './statement-index.mjs';
import { VIA, identityOf, claimStatement, peekStatement, releaseStatement, uploadHoldIsStale, noticeFor } from './statement-registry.mjs';

const json = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };
const HASH = /^[a-f\d]{64}$/;
const text = (value, max) => String(value == null ? '' : value).slice(0, max);

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
        const { sha, identity } = inputsOf(body);
        if (!sha && !(identity && identity.ok)) return json(res, 400, { ok: false, reason: 'nothing-to-check' });
        /* A check has no holder of its own, so ANY existing holder is a duplicate — including an earlier upload of this very file. A claim is
         * held by one upload attempt (`token`, made by the page): retrying that attempt after a dropped answer is a no-op, a new attempt is not. */
        const token = /^[A-Za-z0-9_-]{8,64}$/.test(String(body.token || '')) ? String(body.token) : '';
        if (action === 'claim' && !token) return json(res, 400, { ok: false, reason: 'token-required' });
        const ref = action === 'claim' ? `upload:${token}` : '';
        /* A statement the email sync filed before the registry existed: found by its bytes on the mailbox item. */
        if (sha) {
            const twin = await withDeadline(findFiledTwin({ mailRef: db.collection('wf-mail').doc(userKeyFor(who.email)), sha, selfId: '' }));
            if (twin) return json(res, 200, { ok: true, duplicate: true, via: VIA.EMAIL, kind: 'file', notice: noticeFor(VIA.EMAIL) });
        }
        const attempt = () => (action === 'check'
            ? withDeadline(peekStatement({ db, uid: who.uid, identity, sha, ref }))
            : withDeadline(claimStatement({ db, uid: who.uid, via: VIA.UPLOAD, ref, identity, sha, meta: { filename: body.filename, size: body.size, rows: body.rows } })));
        let found = await attempt();
        /* A HAND UPLOAD WHOSE RECORDS THE OWNER HAS SINCE DELETED HOLDS NOTHING: its lock is given back and the statement may be added again. */
        if (found.duplicate && await withDeadline(uploadHoldIsStale({ db, uid: who.uid, existing: found.existing }))) {
            await withDeadline(releaseStatement({ db, uid: who.uid, ref: found.existing.ref }));
            found = await attempt();
        }
        if (found.duplicate) return json(res, 200, { ok: true, duplicate: true, via: found.existing.via, kind: found.kind, existing: { ...found.existing, ref: undefined }, notice: noticeFor(found.existing.via) });
        return json(res, 200, { ok: true, duplicate: false, ...(ref ? { id: ref } : {}), identified: !!(identity && identity.ok) });
    } catch (_) { return json(res, 503, { ok: false, reason: 'registry-unavailable' }); }
}
