/* =============================================================================
 * statement-registry.mjs — one statement, filed once, whichever way it arrives (email sync or manual upload)
 * -----------------------------------------------------------------------------
 * THE DEFECT. The email crawler and the manual upload screen are two doors into the same books and neither knew what the other
 * had let in. A statement the crawler filed could be uploaded by hand again (every row twice), and a statement uploaded first was
 * filed again when its email was swept. The transaction-level matcher (statement-copies.mjs) cleans up after the fact; this stops
 * the second copy at the door, before a single row is read into the books.
 *
 * WHERE THE LOCK LIVES. WealthFlow's storage is Firestore, which has no SQL UNIQUE constraint and no secondary-index DDL. Its
 * equivalent is the document id: ids are unique within a collection, and a transaction that reads the id and writes it is atomic
 * against a second writer. So the registry is  users/{uid}/statementRegistry/{id}  with DETERMINISTIC ids:
 *
 *   period  id = sha256(bank | account | year | month)   the compound unique key  (bank_id + account_no + statement_year + statement_month)
 *   file    id = "h-" + sha256(file bytes)                 the exact file, whatever it says about itself
 *
 * A lookup is a primary-key `get` — milliseconds, no scan, no composite index to deploy (the id IS the index). No Redis: the app
 * has none and a cache in front of a primary-key read would only add a second place for the answer to be wrong.
 *
 * Both doors write through claimStatement(); the first one in wins, the second is told who got there first (`via`), which is what
 * the "Already Added via Email Sync" / "Already Added via Manual Upload" notice says. Written by the server only (firestore.rules).
 *
 * The account is the LAST FOUR DIGITS of whatever the statement prints. Banks print the number masked ("XXXX1234", "****-1234",
 * "1234"), and the masks differ between a bank's PDF and its HTML e-statement, so digits-only-last-4 is the one form every copy of
 * the same statement agrees on. The full number is not on the page to be had.
 *
 * Pure except for the two functions that take `db`.
 * ===========================================================================*/

import { createHash } from 'node:crypto';
import { bankKeyOf } from './statement-coverage.mjs';

export const REGISTRY = 'statementRegistry';
export const VIA = { EMAIL: 'email', UPLOAD: 'upload' };
const HASH = /^[a-f\d]{64}$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** What the owner is told, by who got there first. */
export const NOTICE = {
    [VIA.EMAIL]: 'Already Added via Email Sync',
    [VIA.UPLOAD]: 'Already Added via Manual Upload',
};
export const noticeFor = via => NOTICE[via] || 'Already Added';

/** Digits only, last four: every mask of one account gives the same value. '' when the statement gave no digits. */
export const accountOf = raw => { const digits = String(raw == null ? '' : raw).replace(/\D+/g, ''); return digits.length >= 4 ? digits.slice(-4) : digits; };

const ISO = /^(\d{4})-(\d{2})-(\d{2})/;
const DMY = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/;
const MONTH_NUMBER = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** {year, month, key} of one date written 2026-03-14, 14/03/2026 or 14 Mar 2026; null for anything else. */
export function monthOfDate(value) {
    const text = String(value == null ? '' : value).trim();
    let m = ISO.exec(text), year, month;
    if (m) { year = Number(m[1]); month = Number(m[2]); }
    else if ((m = DMY.exec(text))) { year = Number(m[3]); month = Number(m[2]); }
    else if ((m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(text)) && MONTH_NUMBER[m[2].toLowerCase()]) { year = Number(m[3]); month = MONTH_NUMBER[m[2].toLowerCase()]; }
    else return null;
    return year >= 1990 && year <= 2100 && month >= 1 && month <= 12 ? { year, month } : null;
}

/**
 * The month a statement belongs to, calculated from its closing date: the end of the stated period when it prints one
 * ("01/03/2026 - 31/03/2026"), else the latest transaction date. A statement running 15 Feb – 14 Mar is March's, in both doors.
 * @returns {{year:number, month:number}|null}
 */
export function statementMonthOf({ periodText = '', dates = [] } = {}) {
    const parts = String(periodText || '').split(/\s+(?:-|–|—|to)\s+|\s*-\s*(?=\d{1,2}[/.]\d)/i).map(s => s.trim()).filter(Boolean);
    const end = parts.length >= 2 ? monthOfDate(parts[parts.length - 1]) : null;
    if (end) return end;
    let latest = null;
    for (const date of Array.isArray(dates) ? dates : []) {
        const month = monthOfDate(date);
        if (month && (!latest || month.year * 12 + month.month > latest.year * 12 + latest.month)) latest = month;
    }
    return latest;
}

/**
 * The composite identity of a statement.
 * @returns {{ok:boolean, reason?:string, bank:string, account:string, year:number, month:number, id:string}}
 */
export function identityOf({ bank = '', account = '', periodText = '', dates = [] } = {}) {
    const bankKey = bankKeyOf(bank), acct = accountOf(account), period = statementMonthOf({ periodText, dates });
    const missing = !bankKey ? 'bank' : !acct ? 'account' : !period ? 'period' : '';
    if (missing) return { ok: false, reason: `no-${missing}`, bank: bankKey, account: acct, year: period ? period.year : 0, month: period ? period.month : 0, id: '' };
    return { ok: true, bank: bankKey, account: acct, year: period.year, month: period.month, id: sha256(['wf-stmt-id-v1', bankKey, acct, period.year, String(period.month).padStart(2, '0')].join('|')) };
}

export const fileIdOf = sha => (HASH.test(String(sha || '')) ? `h-${sha}` : '');
const registryOf = (db, uid) => db.collection('users').doc(uid).collection(REGISTRY);

/** What a duplicate says about the one already there. Never the owner's data: bank, month, door and when. */
const describe = (data = {}) => ({ via: data.via || '', bank: data.bank || '', account: data.account || '', year: data.year || 0, month: data.month || 0, filename: String(data.filename || '').slice(0, 120), at: data.createdAt || 0 });

/** Is there already a different holder of this identity or this file? Read-only: used before anything is read or downloaded. */
export async function peekStatement({ db, uid, identity = null, sha = '', ref = '' }) {
    const reg = registryOf(db, uid), ids = [identity && identity.ok ? { kind: 'period', id: identity.id } : null, fileIdOf(sha) ? { kind: 'file', id: fileIdOf(sha) } : null].filter(Boolean);
    for (const { kind, id } of ids) {
        const snap = await reg.doc(id).get();
        if (snap.exists && snap.data().ref !== ref) return { duplicate: true, kind, existing: describe(snap.data()) };
    }
    return { duplicate: false };
}

/**
 * Take the statement, or learn who has it. ATOMIC: both keys are read and written in one transaction, so two doors racing for the
 * same statement cannot both win. Taking it again with the same `ref` (a retry of the same email item, the same upload) is a no-op
 * that succeeds. The file key is taken as well as the period key, so the exact file is recognised even when its period cannot be read.
 * @returns {{ok:true, claimed:string[]} | {ok:false, duplicate:true, kind:'period'|'file', existing:object}}
 */
export async function claimStatement({ db, uid, via, ref, identity = null, sha = '', meta = {}, now = Date.now() }) {
    if (!uid || !ref || !Object.values(VIA).includes(via)) throw new Error('invalid-statement-claim');
    const reg = registryOf(db, uid);
    const keys = [identity && identity.ok ? { kind: 'period', id: identity.id } : null, fileIdOf(sha) ? { kind: 'file', id: fileIdOf(sha) } : null].filter(Boolean);
    if (!keys.length) return { ok: true, claimed: [] };           // nothing to key on: the transaction-level matcher is the only guard left
    return db.runTransaction(async tx => {
        const snaps = [];
        for (const key of keys) snaps.push({ ...key, snap: await tx.get(reg.doc(key.id)) });
        for (const { kind, snap } of snaps) if (snap.exists && snap.data().ref !== ref) return { ok: false, duplicate: true, kind, existing: describe(snap.data()) };
        const record = { via, ref: String(ref).slice(0, 400), bank: identity?.bank || '', account: identity?.account || '', year: identity?.year || 0, month: identity?.month || 0,
            sha: HASH.test(String(sha || '')) ? sha : '', filename: String(meta.filename || '').slice(0, 200), size: Number(meta.size) || 0, rows: Number(meta.rows) || 0, createdAt: now };
        for (const { id, snap } of snaps) tx.set(reg.doc(id), snap.exists ? { ...snap.data(), updatedAt: now } : record);
        return { ok: true, claimed: keys.map(key => key.id) };
    });
}

/** Give the statement back (the record was deleted, the sender retired): the same file or month may be filed again. Only the holder's own keys go. */
export async function releaseStatement({ db, uid, ref }) {
    if (!uid || !ref) return 0;
    const reg = registryOf(db, uid), held = await reg.where('ref', '==', String(ref).slice(0, 400)).limit(10).get();
    for (const doc of held.docs) await doc.ref.delete();
    return held.docs.length;
}

/** What is written on an email statement the registry turned away: finished, pointing at who holds it, and nothing filed. */
export function registryDuplicatePatch({ duplicate, now = Date.now() }) {
    const via = duplicate?.existing?.via || '';
    return { status: 'filed', filed: true, hasReview: false, duplicateOf: `registry:${via || 'unknown'}`, blockedBy: duplicate?.kind || 'period', blockedVia: via,
        proof: { math: 'duplicate-of', of: `registry:${via}`, rows: 0 }, leaseToken: '', leaseUntil: 0, retryAt: 0, updatedAt: now };
}

export default { identityOf, statementMonthOf, accountOf, claimStatement, peekStatement, releaseStatement, registryDuplicatePatch, noticeFor };
