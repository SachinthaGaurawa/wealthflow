/* =============================================================================
 * statement-index.mjs — what has already been processed, known before anything is downloaded or read
 * -----------------------------------------------------------------------------
 * The mailbox is read-only (no labels can be written), so "processed" is not a flag in Gmail: it is a record in WealthFlow's own
 * database, and it is consulted BEFORE any byte is fetched.
 *
 *   MESSAGE      wf-mail/{box}/emails/{messageId} — the state table (mail-state.mjs): every message ever found, and where it is
 *                (PENDING … INGESTED / REFUSED / HELD / FAILED_VERIFICATION). A message with a settled record under the current
 *                rules is not fetched again; the audit asks only about the ones that have none.
 *   ATTACHMENT   wf-mail/{box}/items/{messageId}.{filename}.{size} — one record per attachment, whose id IS its fingerprint
 *                (message, name, size): found before the attachment is downloaded, so a known one is skipped at once.
 *   CONTENT      the SHA-256 of the file's bytes, kept on the item the moment it is known. The same document arriving again — from
 *                the bank's other address, in a second message, re-sent — has the same hash: it is recognised the moment its bytes
 *                are in hand, recorded as a duplicate of the statement already filed, and never read, classified or filed twice.
 *
 * Pure helpers; the one query is on a single field (no composite index to deploy).
 * ===========================================================================*/

import { createHash } from 'node:crypto';

/** A fingerprint known before any download: the same message, attachment name and size always give the same value. */
export const fingerprintOf = ({ messageId = '', filename = '', size = 0 } = {}) =>
    createHash('sha256').update(['wf-fp-v1', String(messageId), String(filename).toLowerCase(), String(Number(size) || 0)].join('|')).digest('hex');

const HASH = /^[a-f\d]{64}$/;

/**
 * The statement ALREADY FILED whose bytes are exactly these, if any: { id, data } — never the item asking, never one that is
 * itself only a duplicate (a duplicate of a duplicate points at the original), never one that is not filed.
 */
export async function findFiledTwin({ mailRef, sha, selfId }) {
    if (!HASH.test(String(sha || ''))) return null;
    let page;
    try { page = await mailRef.collection('items').where('contentSha256', '==', sha).limit(8).get(); }
    catch (_) { return null; }                                                    // advice: a failed lookup only means the statement is read as before
    for (const doc of page.docs) {
        const data = doc.data() || {};
        if (doc.id !== selfId && data.filed === true && !data.duplicateOf && data.emptyStatement !== true) return { id: doc.id, data };
    }
    return null;
}

/** What is written on a statement that is a copy of one already filed: it is finished, it points at its original, nothing is filed twice. */
export function duplicatePatch({ twin, now = Date.now() }) {
    const total = Number(twin.data.totalRows);
    return { status: 'filed', filed: true, hasReview: false, duplicateOf: twin.id, ...(twin.data.statementKey ? { statementKey: twin.data.statementKey } : {}),
        ...(Number.isSafeInteger(total) && total >= 0 ? { totalRows: total, cursor: total } : {}),
        proof: { math: 'duplicate-of', of: String(twin.id).slice(0, 200), rows: Number.isSafeInteger(total) ? total : 0 }, leaseToken: '', leaseUntil: 0, retryAt: 0, updatedAt: now };
}
