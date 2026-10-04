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
 * The month a statement belongs to: the month of its LATEST TRANSACTION. That is what the email worker has always keyed on (it never reads the period
 * text), so it has to be what the upload screen keys on too — the two used to disagree (the upload took the END of the stated period), which put the same
 * statement under two keys (a copy got through) and two different statements under one (a statement was turned away for another's sake). The stated
 * period ("01/03/2026 - 31/03/2026") is used only for a statement with no dated transaction. The key is a bucket; what makes two statements one is their
 * transactions (coverageOf), not the month they share.
 * @returns {{year:number, month:number}|null}
 */
export function statementMonthOf({ periodText = '', dates = [] } = {}) {
    let latest = null;
    for (const date of Array.isArray(dates) ? dates : []) {
        const month = monthOfDate(date);
        if (month && (!latest || month.year * 12 + month.month > latest.year * 12 + latest.month)) latest = month;
    }
    if (latest) return latest;
    const parts = String(periodText || '').split(/\s+(?:-|–|—|to)\s+|\s*-\s*(?=\d{1,2}[/.]\d)/i).map(s => s.trim()).filter(Boolean);
    return parts.length >= 2 ? monthOfDate(parts[parts.length - 1]) : null;
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

/* WHAT MAKES TWO STATEMENTS ONE IS THEIR TRANSACTIONS. The key (bank, account, month) is only a bucket: two statements can share it (a card that closes on the 3rd has
 * 4 Sep – 3 Oct and 4 Oct – 3 Nov, and a reader that calls a statement by its last transaction files both under October). A hold is therefore believed only when the
 * transactions of the statement being added and the transactions the books hold for that holder are really the same ones: most of this statement's are in the books
 * (COVERED), or what the books hold for the holder is (almost) all in this statement (CONTAINED) — the books seldom hold every row of a statement: an own-account transfer
 * is left out, a row that matched an entry the owner made is not filed again, the owner deletes a few. A transaction is compared by its DAY and its AMOUNT IN CENTS and
 * nothing else: the words are left out on purpose, because the email worker and the upload screen read a narration differently. Two statements of different periods
 * share no day, so neither test can make one of them the other's copy. */
export const COVERED = 0.6, CONTAINED = 0.8;
export const ROWS_CAP = 2000;
const pad2 = n => String(n).padStart(2, '0');
/** 'YYYY-MM-DD|cents' of one transaction ({date, amount}); '' for one that cannot be read, so a list keeps its places. */
export function rowKeyOf(row) {
    const date = parseDate(row && row.date), cents = Math.round(Math.abs(Number(row && row.amount)) * 100);
    return date && Number.isSafeInteger(cents) && cents > 0 ? `${date.year}-${pad2(date.month)}-${pad2(date.day)}|${cents}` : '';
}
export const rowKeysOf = rows => (Array.isArray(rows) ? rows : []).slice(0, ROWS_CAP).map(rowKeyOf);
/** How much of `mine` (the keys of the statement being added, in order) is in `held` (the keys of what the books hold), and how much of `held` is in `mine`. A transaction is
 *  used once: two coffees on one day need two records. `have` lists the places in `mine` that are already in the books; `same` is the verdict (COVERED or CONTAINED). */
export function coverageOf(held, mine) {
    const pool = new Map(); let heldOf = 0;
    for (const key of Array.isArray(held) ? held : []) if (key) { pool.set(key, (pool.get(key) || 0) + 1); heldOf += 1; }
    const have = []; let of = 0;
    (Array.isArray(mine) ? mine : []).forEach((key, at) => {
        if (!key) return;
        of += 1;
        const left = pool.get(key) || 0;
        if (left > 0) { pool.set(key, left - 1); have.push(at); }
    });
    const ratio = of ? have.length / of : 0, within = heldOf ? have.length / heldOf : 0;
    return { of, matched: have.length, have, ratio, within, same: have.length > 0 && (ratio >= COVERED || within >= CONTAINED) };
}

/* A month can hold more than one statement. The first statement of a bank, account and month holds the month's id; a different statement that lands on the same key holds the
 * "variant" id, which carries its first day, so that it too is recognised when it comes again (by the other door, or in other bytes). */
export const variantIdOf = identity => (identity && identity.ok && Array.isArray(identity.days) && identity.days.length ? sha256(['wf-stmt-id-v1', 'variant', identity.id, identity.days[0]].join('|')) : '');
const keysOf = (identity, sha) => [
    identity && identity.ok ? { kind: 'period', slot: 'primary', id: identity.id } : null,
    variantIdOf(identity) ? { kind: 'period', slot: 'variant', id: variantIdOf(identity) } : null,
    fileIdOf(sha) ? { kind: 'file', id: fileIdOf(sha) } : null].filter(Boolean);

/** Is there already a different holder of this identity or this file? Read-only: used before anything is read or downloaded. */
export async function peekStatement({ db, uid, identity = null, sha = '', ref = '', rows = 0, skip = null }) {
    const reg = registryOf(db, uid);
    for (const { kind, id } of keysOf(identity, sha)) {
        const snap = await reg.doc(id).get();
        if (!snap.exists || snap.data().ref === ref) continue;
        if (kind === 'period' && (skip?.has(snap.data().ref) || !sameStatement(snap.data(), { identity, rows }))) continue;       // another statement of that month, not this one
        return { duplicate: true, kind, existing: describe(snap.data()) };
    }
    return { duplicate: false };
}

/**
 * Take the statement, or learn who has it. ATOMIC: all keys are read and written in one transaction, so two doors racing for the
 * same statement cannot both win. Taking it again with the same `ref` (a retry of the same email item, the same upload) is a no-op
 * that succeeds. The file key is taken as well as the period key, so the exact file is recognised even when its period cannot be read.
 * A month already held by a DIFFERENT statement (sameStatement, or `skip`: a holder the caller has shown to be another statement) is left with its holder:
 * this one then holds the month's second slot (its first day) and its file.
 * @returns {{ok:true, claimed:string[]} | {ok:false, duplicate:true, kind:'period'|'file', existing:object}}
 */
export async function claimStatement({ db, uid, via, ref, identity = null, sha = '', meta = {}, now = Date.now(), skip = null }) {
    if (!uid || !ref || !Object.values(VIA).includes(via)) throw new Error('invalid-statement-claim');
    const reg = registryOf(db, uid), keys = keysOf(identity, sha);
    if (!keys.length) return { ok: true, claimed: [] };           // nothing to key on: the transaction-level matcher is the only guard left
    return db.runTransaction(async tx => {
        const snaps = [];
        for (const key of keys) snaps.push({ ...key, snap: await tx.get(reg.doc(key.id)) });
        for (const entry of snaps) {
            const { kind, snap } = entry;
            if (!snap.exists || snap.data().ref === ref) continue;
            if (kind === 'period' && (skip?.has(snap.data().ref) || !sameStatement(snap.data(), { identity, rows: meta.rows }))) { entry.other = true; continue; }
            return { ok: false, duplicate: true, kind, existing: describe(snap.data()) };
        }
        const record = { via, door: String(meta.door || '').slice(0, 12), ref: String(ref).slice(0, 400), bank: identity?.bank || '', account: identity?.account || '', year: identity?.year || 0, month: identity?.month || 0,
            days: Array.isArray(identity?.days) ? identity.days.slice(0, DAYS_CAP) : [],
            sha: HASH.test(String(sha || '')) ? sha : '', filename: String(meta.filename || '').slice(0, 200), size: Number(meta.size) || 0, rows: Number(meta.rows) || 0, createdAt: now };
        const monthTaken = snaps.some(entry => entry.slot === 'primary' && entry.other);
        const taken = snaps.filter(entry => !entry.other && (entry.slot !== 'variant' || monthTaken));
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
/* Where a record of each book keeps the day it happened (an instalment plan keeps its first day in `date` and the charge's own in `startDate`; a cheque the statement cleared has `clearedDate`). */
const DAY_OF = { ccinstall: 'startDate', cheques: 'clearedDate' };
/** What the books hold that carries a holder's key: how many records, and the day+amount key of each transaction among them (the entries of a plan's payments or a subscription's history count one by one). */
function heldBy(user, test) {
    let records = 0; const keys = [];
    for (const store of BOOKS) for (const record of Array.isArray(user[store]) ? user[store] : []) {
        if (!mentions(record, test)) continue;
        records += 1;
        if (test(record)) keys.push(rowKeyOf({ date: record[DAY_OF[store]] || record.date, amount: record.amount }));
        for (const value of Object.values(record || {})) if (Array.isArray(value)) for (const entry of value) if (entry && typeof entry === 'object' && test(entry)) keys.push(rowKeyOf(entry));
    }
    return { records, keys: keys.filter(Boolean) };
}
/** A statement the worker has filed part of and is still working through is being added: it made progress within this long ago. Parked longer than this, it is not being added by anyone. */
export const ACTIVE_MS = 15 * 60 * 1000;

/**
 * IS WHAT THIS HOLD HOLDS REALLY THERE? The books are asked, not the registry: a hold is LIVE when
 *   - a record in the books carries the holder's key (`records`; `held` are their day+amount keys, which say WHICH transactions), or
 *   - the holder is working on it right now: its lease, or a statement it is part-way through that made progress in the last ACTIVE_MS — `working`, or
 *   - it is younger than HOLD_GRACE_MS and written by a phone/upload whose records may not have synced yet (the email worker writes its
 *     records itself, in the same transaction that settles them: it has no such delay).
 * Otherwise it holds nothing — the statement failed and waits, went to review, was never filed, was parked, or the owner deleted what it filed — and is
 * not believed. A hold that cannot be checked (a holder it does not recognise, books it cannot read) is believed: unknown never frees a statement.
 * @returns {{live:boolean, why:string, records:number, held?:string[], working?:boolean, emptied?:boolean}}
 */
export async function holderProof({ db, uid, existing, now = Date.now() }) {
    const ref = String(existing?.ref || ''), via = existing?.via, token = UPLOAD_REF.exec(ref)?.[1] || '', item = ITEM_PATH.exec(ref);
    if (!((via === VIA.UPLOAD && token) || (via === VIA.EMAIL && item))) return { live: true, why: 'unverifiable', records: 0 };
    const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return { live: true, why: 'books-unreadable', records: 0 };
    const user = userSnap.data() || {};
    const { records, keys } = heldBy(user, token ? record => record.uploadClaim === token : record => record.statementKey === ref || record.statementKey === item[2]);
    if (records) return { live: true, why: 'in-books', records, held: keys };
    let itemExists = false, itemFiled = false;
    if (item) {
        const snap = await db.collection('wf-mail').doc(item[1]).collection('items').doc(item[2]).get(), data = snap.exists ? (snap.data() || {}) : null;
        itemExists = !!data;
        itemFiled = !!data && data.filed === true && !data.duplicateOf && (Number(data.totalRows) > 0 || Number(data.cursor) > 0);
        if (data) {
            const status = String(data.status || '');
            if (Number(data.leaseUntil) > now) return { live: true, why: 'working', records: 0, working: true };
            if ((status === 'pending' || status === 'processing') && Number(data.cursor) > 0 && now - (Number(data.updatedAt) || 0) < ACTIVE_MS) return { live: true, why: 'part-way', records: 0, working: true };
        }
    }
    const graced = existing.door !== 'worker' && now - (Number(existing.at) || 0) < HOLD_GRACE_MS;
    if (graced) return { live: true, why: 'recent', records: 0 };
    /* `emptied`: the holder did file the statement and its records are gone (the owner deleted them; an upload holds only from Save), or it can no longer say (its item is gone) */
    return { live: false, why: item ? (itemExists ? 'nothing-in-books' : 'item-gone') : 'nothing-in-books', records: 0, emptied: !item || !itemExists || itemFiled };
}

/**
 * THE QUESTION EVERY DOOR ASKS: is this statement already held — by something real that really is this statement? `claim:false` only looks (peekStatement), `claim:true`
 * takes it (claimStatement). Two checks stand between a hold and a turned-away statement:
 *   1. the hold must be real (holderProof): one that holds nothing is given back (releaseStatement) and the question is asked again;
 *   2. a month's hold is believed for THIS statement only when this statement's transactions (`rowKeys`: [{date, amount}]) and the ones the books hold for it are really the
 *      same (coverageOf: COVERED or CONTAINED). A statement whose transactions are elsewhere is another statement that shares the month: the holder is left alone, the statement
 *      is let through, and `have` names the transactions of it that the books already hold.
 * Without `rowKeys` the days the books hold are compared the same way; with no dates at all (a check on the file alone) the hold's own days decide, as before.
 * `keepEmptied`: a holder whose filed records the owner deleted is NOT given back — for a statement the system reads again on its own (reopenRegistryCopies), which must never
 * bring back what the owner removed. The owner's own upload does take such a month back.
 * @returns the peek/claim answer; a duplicate carries `proof` ({live, why, records, held?, working?}) and, when transactions were compared, `coverage`; a statement let through past another holder carries `partial` and `have`
 */
export async function lookup({ db, uid, claim = false, via, ref = '', identity = null, sha = '', rows = 0, rowKeys = null, keepEmptied = false, meta = {}, now = Date.now() }) {
    const mine = Array.isArray(rowKeys) ? rowKeysOf(rowKeys) : [];
    const skip = new Set();
    let partial = null;
    for (let round = 0; ; round += 1) {
        const found = claim ? await claimStatement({ db, uid, via, ref, identity, sha, meta: { ...meta, rows: meta.rows ?? rows }, now, skip }) : await peekStatement({ db, uid, identity, sha, ref, rows, skip });
        if (claim ? found.ok : !found.duplicate) return partial ? { ...found, partial: { of: partial.of, matched: partial.matched, held: partial.held }, have: partial.have } : found;
        const proof = await holderProof({ db, uid, existing: found.existing, now });
        if (round >= 5) return { ...found, proof: { ...proof, live: true, why: proof.live ? proof.why : 'too-many-holders' } };
        if (!proof.live) {
            if (keepEmptied && proof.emptied) return { ...found, proof: { ...proof, live: true, why: 'emptied' } };
            if (!(await releaseStatement({ db, uid, ref: found.existing.ref }))) return { ...found, proof: { ...proof, live: true, why: 'could-not-release' } };
            continue;
        }
        if (found.kind === 'period' && proof.why === 'in-books' && proof.held?.length) {      // records that carry no day or amount cannot be compared: believed
            if (mine.some(Boolean)) {
                const coverage = coverageOf(proof.held, mine);
                if (!coverage.same) { skip.add(found.existing.ref); partial = { ...coverage, held: proof.held.length }; continue; }
                return { ...found, proof, coverage };
            }
            /* No amounts came (a device still on the app of before 2026-10-04): the same tests on the DAYS the books hold for the holder. */
            const days = [...new Set(proof.held.map(key => key.split('|')[0]))], mineDays = Array.isArray(identity?.days) ? identity.days : [];
            const byDay = coverageOf(days, mineDays);
            if (mineDays.length && !byDay.same) { skip.add(found.existing.ref); partial = { of: byDay.of, matched: byDay.matched, have: [], held: proof.held.length }; continue; }
        }
        return { ...found, proof };
    }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A line that says WHAT is in the books, so a duplicate the owner disagrees with can be checked on sight. Their own data only. */
export function detailOf(existing = {}, proof = {}, coverage = null) {
    const what = existing.bank && existing.account && existing.year && existing.month ? `${bankIdentity(existing.bank).name} ••${existing.account}, ${MONTHS[existing.month - 1]} ${existing.year}` : String(existing.filename || '').slice(0, 60);
    const state = proof.working ? 'being added right now' : coverage && coverage.of && coverage.ratio >= COVERED ? `${coverage.matched} of ${coverage.of} transactions are in your books` : proof.records ? `${proof.records} transaction${proof.records === 1 ? '' : 's'} in your books` : '';
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

export default { identityOf, statementMonthOf, accountOf, claimStatement, peekStatement, releaseStatement, registryDuplicatePatch, noticeFor, holderProof, lookup, detailOf, sameStatement, daysOf, rowKeyOf, rowKeysOf, coverageOf, variantIdOf };
