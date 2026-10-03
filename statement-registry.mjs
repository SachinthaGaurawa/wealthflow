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
 * "ALREADY ADDED" MUST BE TRUE. A hold is taken BEFORE a statement's rows are filed, so it can outlive what it held: the statement failed
 * and waits for a retry, went to review, was filed and then deleted by the owner, or was reviewed on the phone with nothing ticked. A
 * hold nobody can show anything behind turned the owner's own statement away ("Already Added via Email Sync" for a statement the email
 * system never put in the books). So a hold is only believed while the statement is really in the books (a record carries the holder's
 * key) or is being added right now; otherwise it is given back on the spot (holderProof / lookup). Two statements that merely share a
 * bank, account and calendar month — the next billing cycle, a statement of several months — are told apart by their dates and size.
 *
 * The account is the LAST FOUR DIGITS of whatever the statement prints. Banks print the number masked ("XXXX1234", "****-1234",
 * "1234"), and the masks differ between a bank's PDF and its HTML e-statement, so digits-only-last-4 is the one form every copy of
 * the same statement agrees on. The full number is not on the page to be had.
 *
 * Pure except for the two functions that take `db`.
 * ===========================================================================*/

import { createHash } from 'node:crypto';
import { bankKeyOf, bankIdentity } from './statement-coverage.mjs';

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
/** {year, month, day} of one date written 2026-03-14, 14/03/2026 or 14 Mar 2026; null for anything else. */
function parseDate(value) {
    const text = String(value == null ? '' : value).trim();
    let m = ISO.exec(text), year, month, day;
    if (m) { year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); }
    else if ((m = DMY.exec(text))) { year = Number(m[3]); month = Number(m[2]); day = Number(m[1]); }
    else if ((m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(text)) && MONTH_NUMBER[m[2].toLowerCase()]) { year = Number(m[3]); month = MONTH_NUMBER[m[2].toLowerCase()]; day = Number(m[1]); }
    else return null;
    return year >= 1990 && year <= 2100 && month >= 1 && month <= 12 ? { year, month, day } : null;
}
/** {year, month} of one date; null for anything unreadable. */
export function monthOfDate(value) { const date = parseDate(value); return date ? { year: date.year, month: date.month } : null; }
/** The sorted, distinct days (YYYY-MM-DD) of a list of dates: what a statement covers, however its dates were written. At most DAYS_CAP. */
export const DAYS_CAP = 400;
export function daysOf(dates) {
    const days = new Set();
    for (const value of Array.isArray(dates) ? dates : []) {
        const date = parseDate(value);
        if (date && date.day >= 1 && date.day <= 31) days.add(`${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`);
        if (days.size >= DAYS_CAP) break;
    }
    return [...days].sort();
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
 * `days` are the distinct days its transactions fall on: they do not make the id (the id is the key), they tell two statements that share
 * one id apart (see sameStatement).
 * @returns {{ok:boolean, reason?:string, bank:string, account:string, year:number, month:number, id:string, days:string[]}}
 */
export function identityOf({ bank = '', account = '', periodText = '', dates = [] } = {}) {
    const bankKey = bankKeyOf(bank), acct = accountOf(account), period = statementMonthOf({ periodText, dates });
    const missing = !bankKey ? 'bank' : !acct ? 'account' : !period ? 'period' : '';
    if (missing) return { ok: false, reason: `no-${missing}`, bank: bankKey, account: acct, year: period ? period.year : 0, month: period ? period.month : 0, id: '', days: [] };
    return { ok: true, bank: bankKey, account: acct, year: period.year, month: period.month, days: daysOf(dates), id: sha256(['wf-stmt-id-v1', bankKey, acct, period.year, String(period.month).padStart(2, '0')].join('|')) };
}

export const fileIdOf = sha => (HASH.test(String(sha || '')) ? `h-${sha}` : '');
const registryOf = (db, uid) => db.collection('users').doc(uid).collection(REGISTRY);

/** What a duplicate says about the one already there. Never the owner's data: bank, month, door and when. */
const describe = (data = {}) => ({ ref: String(data.ref || ''), via: data.via || '', door: data.door || '', bank: data.bank || '', account: data.account || '', year: data.year || 0, month: data.month || 0, rows: Number(data.rows) || 0, filename: String(data.filename || '').slice(0, 120), at: data.createdAt || 0 });

/* TWO STATEMENTS THAT SHARE A BANK, AN ACCOUNT AND A CALENDAR MONTH ARE NOT NECESSARILY ONE. The month is the key, but the next billing cycle
 * can close in the same calendar month as the last (a card that closes on the 3rd), and a statement of several months, or of several accounts,
 * closes in the same month as the one it contains. Copies of one statement — a re-download, a photo, the bank's second send, however the two
 * readers split a row — cover the same days and are about the same size, so a statement is told apart from the holder's only when its days
 * mostly fall elsewhere, or it is clearly bigger (it has rows the holder cannot have). What cannot be compared (a hold from before these were
 * kept) is judged as it always was: the same. */
export const SAME_DAYS = 0.5, GROWTH = 1.35, GROWTH_SLACK = 3;
export function sameStatement(existing, { identity = null, rows = 0 } = {}) {
    const theirs = Array.isArray(existing?.days) ? existing.days : [], mine = Array.isArray(identity?.days) ? identity.days : [];
    if (theirs.length && mine.length) {
        const known = new Set(theirs);
        if (mine.filter(day => known.has(day)).length / mine.length < SAME_DAYS) return false;
    }
    const was = Number(existing?.rows) || 0, now = Number(rows) || 0;
    return !(was > 0 && now > 0 && now > was * GROWTH + GROWTH_SLACK);
}

/** Is there already a different holder of this identity or this file? Read-only: used before anything is read or downloaded. */
export async function peekStatement({ db, uid, identity = null, sha = '', ref = '', rows = 0 }) {
    const reg = registryOf(db, uid), ids = [identity && identity.ok ? { kind: 'period', id: identity.id } : null, fileIdOf(sha) ? { kind: 'file', id: fileIdOf(sha) } : null].filter(Boolean);
    for (const { kind, id } of ids) {
        const snap = await reg.doc(id).get();
        if (!snap.exists || snap.data().ref === ref) continue;
        if (kind === 'period' && !sameStatement(snap.data(), { identity, rows })) continue;       // another statement of that month, not this one
        return { duplicate: true, kind, existing: describe(snap.data()) };
    }
    return { duplicate: false };
}

/**
 * Take the statement, or learn who has it. ATOMIC: both keys are read and written in one transaction, so two doors racing for the
 * same statement cannot both win. Taking it again with the same `ref` (a retry of the same email item, the same upload) is a no-op
 * that succeeds. The file key is taken as well as the period key, so the exact file is recognised even when its period cannot be read.
 * A month already held by a DIFFERENT statement (sameStatement) is left with its holder: this one then holds its file only.
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
        for (const entry of snaps) {
            const { kind, snap } = entry;
            if (!snap.exists || snap.data().ref === ref) continue;
            if (kind === 'period' && !sameStatement(snap.data(), { identity, rows: meta.rows })) { entry.other = true; continue; }
            return { ok: false, duplicate: true, kind, existing: describe(snap.data()) };
        }
        const record = { via, door: String(meta.door || '').slice(0, 12), ref: String(ref).slice(0, 400), bank: identity?.bank || '', account: identity?.account || '', year: identity?.year || 0, month: identity?.month || 0,
            days: Array.isArray(identity?.days) ? identity.days.slice(0, DAYS_CAP) : [],
            sha: HASH.test(String(sha || '')) ? sha : '', filename: String(meta.filename || '').slice(0, 200), size: Number(meta.size) || 0, rows: Number(meta.rows) || 0, createdAt: now };
        const taken = snaps.filter(entry => !entry.other);
        for (const { id, snap } of taken) tx.set(reg.doc(id), snap.exists ? { ...snap.data(), updatedAt: now } : record);
        return { ok: true, claimed: taken.map(key => key.id) };
    });
}

/** The records of a hand upload carry its claim token (`uploadClaim`); a mailbox statement's carry its item (`statementKey`: the item's path from the sync worker, its id from the phone). */
export const BOOKS = ['expenses', 'incomeRecv', 'cconetime', 'ccPayments', 'ccinstall', 'loans', 'cheques', 'subscriptions'];
/** How long a hold is believed with nothing behind it when its records are written by a phone that may not have synced yet. */
export const HOLD_GRACE_MS = 10 * 60 * 1000;
export const STALE_UPLOAD_MS = HOLD_GRACE_MS;
const ITEM_PATH = /^wf-mail\/([^/]+)\/items\/([^/]+)$/;
const UPLOAD_REF = /^upload:([A-Za-z0-9_-]{8,64})$/;
const mentions = (node, test, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 3) return false;
    if (Array.isArray(node)) return node.some(entry => mentions(entry, test, depth + 1));
    return test(node) || Object.values(node).some(value => value && typeof value === 'object' && mentions(value, test, depth + 1));
};
const carried = (user, test) => BOOKS.reduce((count, key) => count + (Array.isArray(user[key]) ? user[key] : []).filter(record => mentions(record, test)).length, 0);

/**
 * IS WHAT THIS HOLD HOLDS REALLY THERE? The books are asked, not the registry: a hold is LIVE when
 *   - a record in the books carries the holder's key (`records`), or
 *   - the holder is working on it right now (its lease) or part-way through it (a cursor past the first row) — `working`, or
 *   - it is younger than HOLD_GRACE_MS and written by a phone/upload whose records may not have synced yet (the email worker writes its
 *     records itself, in the same transaction that settles them: it has no such delay).
 * Otherwise it holds nothing — the statement failed and waits, went to review, was never filed, or the owner deleted what it filed — and is
 * not believed. A hold that cannot be checked (a holder it does not recognise, books it cannot read) is believed: unknown never frees a statement.
 * @returns {{live:boolean, why:string, records:number, working?:boolean}}
 */
export async function holderProof({ db, uid, existing, now = Date.now() }) {
    const ref = String(existing?.ref || ''), via = existing?.via, token = UPLOAD_REF.exec(ref)?.[1] || '', item = ITEM_PATH.exec(ref);
    if (!((via === VIA.UPLOAD && token) || (via === VIA.EMAIL && item))) return { live: true, why: 'unverifiable', records: 0 };
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return { live: true, why: 'books-unreadable', records: 0 };
    const user = userSnap.data() || {};
    const records = carried(user, token ? record => record.uploadClaim === token : record => record.statementKey === ref || record.statementKey === item[2]);
    if (records) return { live: true, why: 'in-books', records };
    let itemExists = false;
    if (item) {
        const snap = await db.collection('wf-mail').doc(item[1]).collection('items').doc(item[2]).get(), data = snap.exists ? (snap.data() || {}) : null;
        itemExists = !!data;
        if (data) {
            const status = String(data.status || '');
            if (Number(data.leaseUntil) > now) return { live: true, why: 'working', records: 0, working: true };
            if ((status === 'pending' || status === 'processing' || status === 'dead_letter') && Number(data.cursor) > 0) return { live: true, why: 'part-way', records: 0, working: true };      // a dead letter is parked with its place kept, and re-driven
        }
    }
    const graced = existing.door !== 'worker' && now - (Number(existing.at) || 0) < HOLD_GRACE_MS;
    if (graced) return { live: true, why: 'recent', records: 0 };
    return { live: false, why: item ? (itemExists ? 'nothing-in-books' : 'item-gone') : 'nothing-in-books', records: 0 };
}

/**
 * THE QUESTION EVERY DOOR ASKS: is this statement already held — by something real? `claim:false` only looks (peekStatement), `claim:true`
 * takes it (claimStatement). A holder that proves nothing (holderProof) is given back (releaseStatement) and the question is asked again, so
 * a statement is turned away only for a holder that is really there. At most three holders are cleared per question (the month's and the
 * file's can differ); a hold that cannot be cleared stays a duplicate.
 * @returns the peek/claim answer, with `proof` on a duplicate: {live, why, records, working?}
 */
export async function lookup({ db, uid, claim = false, via, ref = '', identity = null, sha = '', rows = 0, meta = {}, now = Date.now() }) {
    for (let round = 0; ; round += 1) {
        const found = claim ? await claimStatement({ db, uid, via, ref, identity, sha, meta: { ...meta, rows: meta.rows ?? rows }, now }) : await peekStatement({ db, uid, identity, sha, ref, rows });
        if (claim ? found.ok : !found.duplicate) return found;
        const proof = await holderProof({ db, uid, existing: found.existing, now });
        if (proof.live || round >= 2) return { ...found, proof };
        if (!(await releaseStatement({ db, uid, ref: found.existing.ref }))) return { ...found, proof: { ...proof, live: true, why: 'could-not-release' } };
    }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A line that says WHAT is in the books, so a duplicate the owner disagrees with can be checked on sight. Their own data only. */
export function detailOf(existing = {}, proof = {}) {
    const what = existing.bank && existing.account && existing.year && existing.month ? `${bankIdentity(existing.bank).name} ••${existing.account}, ${MONTHS[existing.month - 1]} ${existing.year}` : String(existing.filename || '').slice(0, 60);
    const state = proof.working ? 'being added right now' : proof.records ? `${proof.records} transaction${proof.records === 1 ? '' : 's'} in your books` : '';
    return [what, state].filter(Boolean).join(' · ');
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

export default { identityOf, statementMonthOf, accountOf, claimStatement, peekStatement, releaseStatement, registryDuplicatePatch, noticeFor, holderProof, lookup, detailOf, sameStatement, daysOf };
