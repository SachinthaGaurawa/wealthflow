/* =============================================================================
 * wealthflow-people.js — the saved-people book: who the owner lends to or invests with, saved ONCE
 * -----------------------------------------------------------------------------
 * The owner's ask: add a person the first time, with every detail, and when they borrow again pick
 * them from the list instead of typing it all again; edit or delete them there; take a number from
 * the phone's own contacts; and let texts go to any Sri Lankan mobile number (the text gateway reaches no other country).
 *
 * THE MODEL IS SMALL ON PURPOSE.
 *   - `people[]`: one record per person (name, mobile, another number, country, NIC or passport/ID,
 *     email, address, a note). A record array like every other ledger here, so it merges per record
 *     across devices and a delete is a tombstone, not a resurrection.
 *   - A loan or an investment keeps its OWN copy of the three things the rest of the app and the
 *     server read (name, phone, NIC) and one pointer, `personId`. Nothing server-side learns the book
 *     exists: texts and the statement portal read the records, exactly as before.
 *   - SHARED FIELDS STAY IN STEP. Name, phone and NIC belong to the person, not to one loan. Change
 *     them on the person, or on any form that is linked to the person, and every linked record is
 *     brought along, because a text sent to the number on a stale copy goes to somebody else.
 *   - DELETING A PERSON TOUCHES NO LOAN. The records keep their copies; the pointer simply stops
 *     finding anybody. A ledger is never changed by tidying an address book.
 *
 * Pure: no DOM, no clock (`now` and `newId` are passed), the stores are injected. ESM.
 * ===========================================================================*/

import { normalizePhone, cleanPhoneInput, formatPhone, countryNameOf, regionByIso, DEFAULT_REGION } from './wealthflow-phone.js';
import { normalizeNic, normalizeOtherId, normalizeIdentity, displayIdentity, OTHER_ID_PREFIX } from './wealthflow-nic.js';

export const PEOPLE_KEY = 'people';
export const LINK_FIELD = 'personId';
export const LIMITS = Object.freeze({ name: 80, fullName: 80, phone2: 24, email: 120, address: 200, note: 300, people: 2000, vcfBytes: 2 * 1024 * 1024, vcfCards: 2000 });
/** What a person shares with every record linked to them: the rest of a loan or an investment is that record's own. */
export const SHARED = Object.freeze(['name', 'fullName', 'phone', 'phone2', 'nic']);

const str = (v) => String(v == null ? '' : v);
/** Collapses runs of whitespace and drops control characters: a name pasted from a chat or a contacts export is not trusted to be tidy. */
const squash = (v) => str(v).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();

/* ── words ────────────────────────────────────────────────────────────────── */

const PHONE_TEXT = {
    'empty': 'Enter the mobile number the texts should go to.',
    'not-a-number': 'A phone number can only contain digits, spaces and a leading +.',
    'misplaced-plus': 'A + can only come first, as in +94 77 123 4567.',
    'not-sri-lanka': 'Texts can only be sent to Sri Lankan mobile numbers (07X XXX XXXX). The text service does not deliver to other countries.',
    'bad-length': 'A Sri Lankan mobile number has 10 digits and starts 07, like 077 123 4567.',
    'not-a-mobile-number': 'Sri Lankan texts go to mobile numbers (07X XXX XXXX).',
};
const ID_TEXT = {
    'empty': 'Enter the NIC number.',
    'bad-shape': 'An NIC is 9 digits and V or X (853400937V), or 12 digits (198534000937).',
    'bad-format': 'An NIC is 9 digits and V or X (853400937V), or 12 digits (198534000937).',
    'bad-day': 'The day of the year inside that NIC is not valid.',
    'bad-year': 'The birth year inside that NIC is not valid.',
};
const OTHER_ID_TEXT = {
    'empty': 'Enter the passport or ID number.',
    'bad-length': 'A passport or ID number has 5 to 20 letters and digits.',
    'bad-shape': 'A passport or ID number can only contain letters and digits.',
};
export const phoneProblem = (reason) => PHONE_TEXT[reason] || 'That does not look like a phone number.';
export const idProblem = (reason, kind = 'nic') => (kind === 'other' ? OTHER_ID_TEXT : ID_TEXT)[reason] || (kind === 'other' ? 'That does not look like a passport or ID number.' : 'That does not look like an NIC number.');

/* ── a phone number as the form shows it ──────────────────────────────────── */

/**
 * What to say about what is in a phone box, and the number it will become.
 * @returns {{ok:boolean, empty:boolean, e164:string, pretty:string, iso:string, reason:string, text:string}}
 */
export function resolvePhone(raw, iso = DEFAULT_REGION) {
    const t = str(raw).trim();
    if (!t) return { ok: false, empty: true, e164: '', pretty: '', iso: '', reason: 'empty', text: '' };
    const p = normalizePhone(t, { defaultCountry: iso });
    if (!p.ok) return { ok: false, empty: false, e164: '', pretty: '', iso: '', reason: p.reason, text: phoneProblem(p.reason) };
    const where = countryNameOf(p.e164);
    return { ok: true, empty: false, e164: p.e164, pretty: formatPhone(p.e164), iso: p.iso, reason: '', text: formatPhone(p.e164) + (where ? ' (' + where + ')' : '') };
}

/** The region a stored phone belongs to ("+447911123456" -> "GB"), or the default when it is not an international number. */
export function isoOfPhone(stored, fallback = DEFAULT_REGION) {
    const t = str(stored).trim();
    if (!t.startsWith('+')) return fallback;
    const p = normalizePhone(t);
    return p.ok ? p.iso : fallback;
}

/**
 * The second number as texts use it: the E.164 form when it is a mobile number that can be texted, '' otherwise. A person's "other number" may be
 * a landline or a family member's line typed as the owner likes; only a number that passes the same check as the first one is shared with the records
 * and texted, so a record never carries a second number the gateway would reject.
 */
export function secondNumberOf(raw, iso = DEFAULT_REGION) {
    const t = str(raw).trim();
    if (!t) return '';
    const p = normalizePhone(t, { defaultCountry: regionByIso(iso) ? str(iso).toUpperCase() : DEFAULT_REGION });
    return p.ok ? p.e164 : '';
}

/** How an identity is stored on a record, from what was typed and which kind it is. */
export function storedId(raw, kind) {
    const t = str(raw).trim();
    if (!t) return { ok: true, empty: true, stored: '', kind };
    if (kind === 'other') {
        const o = normalizeOtherId(t);
        return o.ok ? { ok: true, empty: false, stored: o.canonical, kind } : { ok: false, empty: false, stored: t, kind, reason: o.reason, text: idProblem(o.reason, 'other') };
    }
    const cleaned = t.replace(/[\s.-]+/g, '').toUpperCase();
    const n = normalizeNic(cleaned);
    return n.ok ? { ok: true, empty: false, stored: cleaned, kind: 'nic' } : { ok: false, empty: false, stored: cleaned, kind: 'nic', reason: n.reason, text: idProblem(n.reason, 'nic') };
}

/** "ID:AB123" is a passport/ID, anything else an NIC. */
export const idKindOf = (stored) => (str(stored).trim().toUpperCase().startsWith(OTHER_ID_PREFIX) ? 'other' : 'nic');

/* ── a person ─────────────────────────────────────────────────────────────── */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Validate what a form says about a person and produce the record's fields.
 *   input: { name, fullName, phone, phone2, country, nic, idKind, email, address, note }
 * `name` is the owner's own name for the person (a nickname is fine: it is what the app shows); `fullName` is the person's real name, the only name the
 * customer's statement page and PDF show.
 * @returns {{ok:boolean, fields:object, errors:object}}
 * The mobile number and the ID, when given, must be valid HERE: this is the book, and a saved number that cannot be texted is the
 * quiet failure it exists to prevent. (A landline or a second number goes in `phone2`, which only has to look like a number.)
 */
export function cleanPerson(input) {
    const i = input && typeof input === 'object' ? input : {};
    const errors = {};
    const name = squash(i.name).slice(0, LIMITS.name);
    if (!name) errors.name = 'Enter a name.';

    const country = regionByIso(i.country) ? str(i.country).toUpperCase() : DEFAULT_REGION;

    let phone = '';
    const phoneRaw = str(i.phone).trim();
    if (phoneRaw) {
        const p = resolvePhone(phoneRaw, country);
        if (p.ok) phone = p.e164; else errors.phone = p.text;
    }

    // The second number: a real mobile number is saved in E.164 (it is texted as well as the first one); anything else that looks like a number
    // (a landline, a family member's line) is kept as typed and is not texted.
    let phone2 = squash(cleanPhoneInput(i.phone2)).slice(0, LIMITS.phone2);
    if (phone2 && /[^\d+\s().-]/.test(phone2)) { errors.phone2 = 'The other number can only contain digits, spaces and a leading +.'; phone2 = ''; }
    else if (phone2) {
        const q = resolvePhone(phone2, country);
        if (q.ok) {
            if (phone && q.e164 === phone) { errors.phone2 = 'The second number is the same as the first. Leave it empty or enter a different number.'; phone2 = ''; }
            else phone2 = q.e164;
        }
    }

    let nic = '';
    const idRaw = str(i.nic).trim();
    if (idRaw) {
        const kind = i.idKind === 'other' || idKindOf(idRaw) === 'other' ? 'other' : 'nic';
        const id = storedId(idRaw, kind);
        if (id.ok) nic = id.stored; else errors.nic = id.text;
    }

    const email = squash(i.email).slice(0, LIMITS.email);
    if (email && !EMAIL_RE.test(email)) errors.email = 'That does not look like an email address.';

    const fields = {
        name, fullName: squash(i.fullName).slice(0, LIMITS.fullName), phone, phone2, country, nic,
        email: errors.email ? '' : email,
        address: squash(i.address).slice(0, LIMITS.address),
        note: squash(i.note).slice(0, LIMITS.note),
    };
    return { ok: Object.keys(errors).length === 0, fields, errors };
}

/** A fresh record from clean fields. */
export function newPerson(fields, { now = Date.now(), newId = defaultId } = {}) {
    return { ...fields, id: newId(), createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
}

let counter = 0;
/** An id that cannot collide with another device's: time, a counter and randomness. */
export function defaultId() {
    counter = (counter + 1) % 1679616;
    let rnd = '';
    try { rnd = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join(''); } catch (_) { rnd = Math.random().toString(16).slice(2, 10).padEnd(8, '0'); }
    return 'pp' + Date.now().toString(36) + counter.toString(36) + rnd;
}

export const personById = (people, id) => (id ? (Array.isArray(people) ? people : []).find((p) => p && p.id === id) || null : null);

/** The people list as an array of well-formed records (a damaged entry is skipped, never thrown on). */
export function listPeople(store) {
    const raw = store && typeof store.get === 'function' ? store.get(PEOPLE_KEY) : [];
    return (Array.isArray(raw) ? raw : []).filter((p) => p && typeof p === 'object' && p.id && str(p.name).trim());
}

const norm = (v) => squash(v).toLowerCase();

/** Letters and digits only, lower case: "Nimal  Perera" and "nimal perera" are the same name. */
const nameKey = (v) => norm(v).replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Is this person already in the book? The NIC or ID decides when both have one; otherwise the same number under the same name does.
 * (A number alone does not: one phone is often shared by a family, and two people are not one.)
 */
export function findDuplicate(people, candidate) {
    const c = candidate || {};
    const cid = str(c.nic).trim() ? normalizeIdentity(c.nic) : null;
    const cphone = str(c.phone).trim() ? normalizePhone(c.phone, { defaultCountry: c.country || DEFAULT_REGION }) : null;
    for (const p of Array.isArray(people) ? people : []) {
        if (!p || !p.id) continue;
        if (cid && cid.ok && str(p.nic).trim()) {
            const pid = normalizeIdentity(p.nic);
            if (pid.ok && pid.canonical === cid.canonical) return p;
        }
    }
    if (cphone && cphone.ok && nameKey(c.name)) {
        for (const p of Array.isArray(people) ? people : []) {
            if (!p || !p.id || !str(p.phone).trim()) continue;
            const pp = normalizePhone(p.phone, { defaultCountry: p.country || DEFAULT_REGION });
            if (pp.ok && pp.e164 === cphone.e164 && nameKey(p.name) === nameKey(c.name)) return p;
        }
    }
    return null;
}

/**
 * The one person a name alone can mean: the only person with that name, or, when several have it, the only one saved with nothing but the name
 * (the "bare" one an earlier name-only record made). More than one candidate means we cannot tell, and the answer is nobody.
 */
export function sameNameOnly(people, name) {
    const key = nameKey(name);
    if (!key) return null;
    const same = (Array.isArray(people) ? people : []).filter((p) => p && p.id && nameKey(p.name) === key);
    if (same.length === 1) return same[0];
    const bare = same.filter((p) => !str(p.phone).trim() && !str(p.nic).trim());
    return bare.length === 1 ? bare[0] : null;
}

/** People matching what was typed (name, any number, NIC, email), best first; everybody, A to Z, when nothing was typed. */
export function searchPeople(people, query) {
    const list = (Array.isArray(people) ? people : []).filter((p) => p && p.id);
    const q = norm(query);
    const digits = str(query).replace(/\D/g, '');
    const byName = (a, b) => str(a.name).localeCompare(str(b.name), undefined, { sensitivity: 'base' });
    if (!q) return list.slice().sort(byName);
    const scored = [];
    for (const p of list) {
        const name = norm(`${p.name} ${p.fullName || ''}`);
        let score = 0;
        if (name.startsWith(q)) score = 3;
        else if (name.split(' ').some((w) => w.startsWith(q))) score = 2;
        else if (name.includes(q)) score = 1;
        if (!score && digits.length >= 3 && (str(p.phone).replace(/\D/g, '').includes(digits) || str(p.phone2).replace(/\D/g, '').includes(digits))) score = 1;
        if (!score && q.length >= 3 && (norm(displayIdentity(p.nic)).includes(q) || norm(p.email).includes(q) || norm(p.note).includes(q))) score = 1;
        if (score) scored.push({ p, score });
    }
    return scored.sort((a, b) => b.score - a.score || byName(a.p, b.p)).map((x) => x.p);
}

/* ── searching the investments and the loans ──────────────────────────────── */

/** A phone number as the digits that identify it, whatever way it was written: +94 77 123 4567, 0771234567 and 771234567 are one. */
const lineKey = (v) => { const d = str(v).replace(/\D/g, ''); return d.replace(/^(?:0094|94|0)/, ''); };

/**
 * Does this loan or investment match what was typed? Every word must be found: in the person's own name (the nickname the owner
 * keeps them under, the full name, and an investment's title), or in the NIC / ID; a number of three digits or more is looked for in
 * both phone numbers. An empty search matches everything.
 */
export function recordMatches(rec, query, person = null) {
    const q = norm(query);
    if (!q) return true;
    const r = rec && typeof rec === 'object' ? rec : {};
    const p = person && typeof person === 'object' ? person : {};
    // The saved person the record points at is searched too: a record opened before the person was filed, or edited on another device, may not carry the number itself.
    const names = norm([r.name, r.company, r.fullName, p.name, p.fullName].map(str).join(' '));
    const nic = [r.nic, p.nic].map((v) => norm(displayIdentity(v)).replace(/\s+/g, '')).filter(Boolean);
    const lines = [r.phone, r.phone2, p.phone, p.phone2].map(lineKey).filter(Boolean);
    // A typed number is looked for as the digits were typed: "077" belongs to 0771234567 even though the line key (771234567) has no leading 0.
    const hasDigits = (typed) => {
        const t = str(typed).replace(/\D/g, '');
        if (t.length < 3) return false;
        const core = lineKey(t);
        return lines.some((l) => [l, `0${l}`, `94${l}`, `0094${l}`].some((f) => f.includes(t)) || (core.length >= 3 && l.includes(core)));
    };
    // a number typed with spaces ("77 123 45") is one thing, not three words
    if (/^[+\d\s()-]+$/.test(q) && hasDigits(q)) return true;
    return q.split(' ').every((w) => {
        if (names.includes(w) || nic.some((n) => n.includes(w.replace(/\s+/g, '')))) return true;
        return /^[+\d()-]+$/.test(w) && hasDigits(w);
    });
}

/* ── how a loan or an investment shows its person ─────────────────────────── */

/** The shared fields as a record keeps them. An investment keeps the person's name in `company` ("Company / Person"), a loan in `name`. */
export function readShared(kind, rec) {
    const r = rec || {};
    return { name: squash(kind === 'debtor' ? r.name : r.company), fullName: squash(r.fullName), phone: str(r.phone).trim(), phone2: str(r.phone2).trim(), nic: str(r.nic).trim() };
}

/** One shared field as a person holds it. The second number counts only when it can be texted (a landline in "other number" is the person's own business). */
const personValue = (person, f) => (f === 'phone2' ? secondNumberOf(person && person.phone2, person && person.country) : str(person && person[f]));

/** Write shared values onto a record. Returns true when anything changed. */
export function writeShared(kind, rec, values, now = Date.now()) {
    let changed = false;
    const set = (field, value) => { if (str(rec[field]) !== str(value)) { rec[field] = value; changed = true; return true; } return false; };
    if (values.name !== undefined && values.name !== '') set(kind === 'debtor' ? 'name' : 'company', values.name);
    if (values.fullName !== undefined) { if (values.fullName === '') { if (rec.fullName !== undefined) { delete rec.fullName; changed = true; } } else set('fullName', values.fullName); }
    if (values.phone !== undefined) set('phone', values.phone);
    // a second number written onto a record is new to that record: what happened before is history for it (see sms-events.mjs PHONE2_AT)
    if (values.phone2 !== undefined && set('phone2', values.phone2)) { if (values.phone2) rec.phone2_at = now; else delete rec.phone2_at; }
    if (values.nic !== undefined) set('nic', values.nic);
    return changed;
}

/** What a record lacks of its person, from the person: only fields the record has nothing in. A number or ID the record already carries is never replaced. */
function fillBlanks(kind, rec, person, now = Date.now()) {
    const have = readShared(kind, rec);
    const gift = {};
    for (const f of ['fullName', 'phone', 'phone2', 'nic']) {
        const v = personValue(person, f).trim();
        if (!have[f] && v) gift[f] = v;
    }
    // a second number that is the record's own first number is no gift
    if (gift.phone2 && gift.phone2 === (gift.phone || have.phone)) delete gift.phone2;
    return Object.keys(gift).length ? writeShared(kind, rec, gift, now) : false;
}

/**
 * How many loans and investments point at this person, and how many of those have texts on.
 * `skipId` leaves out the record being saved right now, for "and N others".
 */
export function usageOf(person, books, skipId = '') {
    const id = person && person.id;
    const b = books || {};
    const mine = (list) => (Array.isArray(list) ? list : []).filter((r) => r && id && r[LINK_FIELD] === id && (!skipId || r.id !== skipId));
    const loans = mine(b.debtors);
    const investments = mine(b.income);
    const on = (r) => r.sms_notifications_enabled === true;
    return { loans: loans.length, investments: investments.length, smsOn: loans.filter(on).length + investments.filter(on).length };
}

export const booksOf = (store) => ({
    debtors: (store && store.get('debtors')) || [],
    income: (store && store.get('income')) || [],
});

/**
 * Which of the shared fields a record's form now disagrees with its person about. A blank name is "not typed", not "renamed", so it
 * never counts.
 */
export function sharedDiff(kind, rec, person) {
    const shared = readShared(kind, rec);
    return SHARED.filter((f) => (f !== 'name' || shared.name) && str(shared[f]) !== personValue(person, f));
}

/**
 * Bring every record linked to `personId` in step with `next`.
 * A field that CHANGED from `prev` goes to every linked record whatever it holds (a deliberately cleared number clears everywhere); a field
 * that did not change goes only where a record has nothing in it, so a record that had fallen out of step (linked by an older version, edited on
 * another device) is put right by the next save of its person, and a number a record holds is never blanked by an unrelated edit.
 * `skipId` is the record being saved right now (its caller saves it). Records are replaced, not edited in place, and a store is only
 * written when something changed, so an untouched ledger is never re-stamped.
 * @returns {{loans:number, investments:number, smsOn:number}} what was changed
 */
export function propagate(store, personId, prev, next, skipId = '', now = Date.now()) {
    const out = { loans: 0, investments: 0, smsOn: 0 };
    const diff = {};
    for (const f of SHARED) if (personValue(prev, f) !== personValue(next, f)) diff[f] = personValue(next, f);
    for (const [key, kind, counter] of [['debtors', 'debtor', 'loans'], ['income', 'investment', 'investments']]) {
        const list = store.get(key) || [];
        let touched = false;
        const updated = list.map((r) => {
            if (!r || r[LINK_FIELD] !== personId || (skipId && r.id === skipId)) return r;
            const copy = { ...r };
            const changed = writeShared(kind, copy, diff, now) | fillBlanks(kind, copy, next, now);
            if (!changed) return r;
            touched = true;
            out[counter] += 1;
            if (r.sms_notifications_enabled === true) out.smsOn += 1;
            return copy;
        });
        if (touched) store.set(key, updated);
    }
    return out;
}

/**
 * Loans and investments that ARE this person but point at nobody in the book: made before the book existed, saved with "remember" off, or left
 * behind by a person who was deleted and added again. Found the way the book finds a duplicate (the same NIC, or the same number under the same
 * name, or the same name alone when there is no number or NIC to go by), never by a number alone: one phone is often shared by a family.
 * Reported 2026-10-29: a second number added to a saved person never reached the loan it was for, because that loan had never been linked, so
 * nothing the person said was carried to it and its texts kept going to the first number only.
 * @returns {{key:'debtors'|'income', kind:'debtor'|'investment', id:string}[]}
 */
export function strayRecords(store, person) {
    const out = [];
    if (!store || !person || !person.id) return out;
    const people = listPeople(store);
    const me = person;                                                              // exactly the identity given: an edit looks for the loans by what they were saved under
    /* A match is judged against EVERYBODY in the book, with this person in the identity given: a name that two people share is nobody's, so a loan that
     * names only that name is not claimed by whichever of them happens to be edited (it would be given that person's number, and texted there). */
    const roster = people.some((p) => p.id === me.id) ? people.map((p) => (p.id === me.id ? me : p)) : [...people, me];
    for (const [key, kind] of [['debtors', 'debtor'], ['income', 'investment']]) {
        for (const r of (store.get(key)) || []) {
            if (!r || typeof r !== 'object' || !r.id) continue;
            if (personById(people, r[LINK_FIELD])) continue;                       // already somebody's
            const shared = readShared(kind, r);
            if (!shared.name) continue;
            const hit = findDuplicate(roster, { name: shared.name, phone: shared.phone, nic: shared.nic, country: isoOfPhone(shared.phone) })
                || (!shared.phone && !shared.nic ? sameNameOnly(roster, shared.name) : null);
            if (hit && hit.id === me.id) out.push({ key, kind, id: r.id });
        }
    }
    return out;
}

/** Link those records to the person. Only `personId` is written here; what they lack of the person, and what the person changed, comes from `propagate`. */
export function adoptStrays(store, person) {
    const out = { loans: 0, investments: 0, smsOn: 0 };
    const strays = strayRecords(store, person);
    if (!strays.length) return out;
    for (const [key, counter] of [['debtors', 'loans'], ['income', 'investments']]) {
        const ids = new Set(strays.filter((x) => x.key === key).map((x) => x.id));
        if (!ids.size) continue;
        store.set(key, (store.get(key) || []).map((r) => {
            if (!r || !ids.has(r.id)) return r;
            out[counter] += 1;
            if (r.sms_notifications_enabled === true) out.smsOn += 1;
            return { ...r, [LINK_FIELD]: person.id };
        }));
    }
    return out;
}

/**
 * Put right a linked record that fell out of step with its person AFTER the person was last saved: a number the person has and the record lacks
 * (the second number, usually) is filled in. Only blanks, and only when the person is the newer of the two, so a number the owner deliberately
 * kept on one loan, or typed on the loan after the person was saved, is never replaced. Runs when the app opens or comes back to the front, so an
 * edit that reached the person but not the loan (the page closed between the two writes, the loan was edited on another phone at the time) is
 * healed before the next text is owed rather than at the next save of the person.
 * @returns {{loans:number, investments:number, smsOn:number}}
 */
export function reconcileLinked(store, now = Date.now()) {
    const out = { loans: 0, investments: 0, smsOn: 0 };
    const people = listPeople(store);
    if (!people.length) return out;
    const byId = new Map(people.map((p) => [p.id, p]));
    for (const [key, kind, counter] of [['debtors', 'debtor', 'loans'], ['income', 'investment', 'investments']]) {
        const list = store.get(key) || [];
        let touched = false;
        const updated = list.map((r) => {
            const person = r && byId.get(r[LINK_FIELD]);
            if (!person) return r;
            const stamp = Date.parse(person.updatedAt || person.createdAt || '');
            const own = Number(r._ut) > 0 ? Number(r._ut) : (Date.parse(r.createdAt || '') || 0);
            if (!(stamp > own)) return r;
            const copy = { ...r };
            if (!fillBlanks(kind, copy, person, now)) return r;
            touched = true;
            out[counter] += 1;
            if (r.sms_notifications_enabled === true) out.smsOn += 1;
            return copy;
        });
        if (touched) store.set(key, updated);
    }
    return out;
}

/**
 * The form on a loan or an investment has been saved: file the person, link the record, keep everybody in step.
 *
 *   kind: 'debtor' | 'investment'      rec: the record about to be saved (its name / phone / NIC already set from the form)
 *   remember: true  -> add the person to the book if they are not in it
 *   country: the region the phone box was set to (kept with the person so the next form opens on it)
 *
 * Three cases. The record is ALREADY linked: the form is the owner's latest word, so the person and everything linked to them take
 * its name / phone / NIC. It is NOT linked and `remember` is on: the person is looked for (same NIC, or same number and name) and
 * linked, or created. Otherwise nothing is touched. Mutates `rec` (sets `personId`); writes `people` and, for siblings, `debtors`
 * and `income` through the store.
 *
 * @returns {{person:object|null, created:boolean, matched:boolean, updated:boolean, siblings:{loans:number, investments:number, smsOn:number}}}
 */
export function linkRecord({ store, kind, rec, remember = false, country = '', now = Date.now(), newId = defaultId }) {
    const none = { person: null, created: false, matched: false, updated: false, siblings: { loans: 0, investments: 0, smsOn: 0 } };
    if (!store || !rec) return none;
    const people = listPeople(store).slice();
    const shared = readShared(kind, rec);
    const iso = regionByIso(country) ? str(country).toUpperCase() : '';
    const stamp = new Date(now).toISOString();

    const existing = personById(people, rec[LINK_FIELD]);
    if (existing) {
        const next = { ...existing };
        for (const f of SHARED) {
            if (f === 'name' && !shared.name) continue;
            // the person's other number is kept as typed (a landline) unless the form says something different about the TEXTABLE one
            if (f === 'phone2' && shared.phone2 === personValue(existing, 'phone2')) continue;
            next[f] = shared[f];
        }
        if (iso && iso !== existing.country) next.country = iso;
        const changed = SHARED.some((f) => str(next[f]) !== str(existing[f])) || (next.country || '') !== (existing.country || '');
        if (!changed) {
            // nothing to teach the person, but a record of theirs that fell out of step is put right
            const repaired = propagate(store, existing.id, existing, existing, rec.id, now);
            return { ...none, person: existing, siblings: repaired };
        }
        next.updatedAt = stamp;
        store.set(PEOPLE_KEY, people.map((p) => (p.id === existing.id ? next : p)));
        const siblings = propagate(store, existing.id, existing, next, rec.id, now);
        return { ...none, person: next, updated: true, siblings };
    }

    if (!remember || !shared.name) { if (rec[LINK_FIELD]) delete rec[LINK_FIELD]; return none; }
    if (people.length >= LIMITS.people) return none;

    const candidate = { name: shared.name, phone: shared.phone, nic: shared.nic, country: iso || DEFAULT_REGION };
    // Somebody typed by name alone is the person already saved under that name (an investor who is also a borrower), when there is one to mean.
    const dup = findDuplicate(people, candidate) || (!shared.phone && !shared.nic ? sameNameOnly(people, shared.name) : null);
    if (dup) {
        // The same person. They keep the name they are saved under (a second spelling does not rename them, or every loan of theirs);
        // a number or an ID typed on THIS form is the freshest word the owner has, so it replaces the saved one and the person's other
        // records follow; what this form left blank is filled in from the person.
        const next = { ...dup };
        let changed = false;
        for (const f of ['fullName', 'phone', 'phone2', 'nic']) if (shared[f] && personValue(dup, f) !== shared[f]) { next[f] = shared[f]; changed = true; }
        if (iso && !dup.country) { next.country = iso; changed = true; }
        if (changed) {
            next.updatedAt = stamp;
            store.set(PEOPLE_KEY, people.map((p) => (p.id === dup.id ? next : p)));
        }
        const siblings = changed ? propagate(store, dup.id, dup, next, rec.id, now) : none.siblings;
        rec[LINK_FIELD] = dup.id;
        writeShared(kind, rec, { name: next.name });
        fillBlanks(kind, rec, next, now);
        return { person: changed ? next : dup, created: false, matched: true, updated: changed, siblings };
    }

    // a person mirrors the record they were made from (a number that cannot be texted is still worth keeping); the book's own form is the
    // place that insists on a clean one
    const fields = {
        name: shared.name.slice(0, LIMITS.name),
        fullName: shared.fullName.slice(0, LIMITS.fullName),
        phone: shared.phone, phone2: shared.phone2,
        country: iso || isoOfPhone(shared.phone),
        nic: shared.nic,
        email: '', address: '', note: '',
    };
    const person = newPerson(fields, { now, newId });
    store.set(PEOPLE_KEY, [...people, person]);
    rec[LINK_FIELD] = person.id;
    return { ...none, person, created: true };
}

/**
 * Edit a person in the book. Validates, saves, and brings every linked loan and investment along for name / phone / NIC.
 * @returns {{ok:boolean, errors?:object, person?:object, siblings?:object}}
 */
export function updatePerson(store, id, input, { now = Date.now() } = {}) {
    const people = listPeople(store).slice();
    const prev = personById(people, id);
    if (!prev) return { ok: false, errors: { name: 'That person is no longer in the list.' } };
    const clean = cleanPerson(input);
    if (!clean.ok) return { ok: false, errors: clean.errors };
    const next = { ...prev, ...clean.fields, id: prev.id, createdAt: prev.createdAt, updatedAt: new Date(now).toISOString() };
    store.set(PEOPLE_KEY, people.map((p) => (p.id === id ? next : p)));
    // loans of this person that were never linked to them are claimed by their OLD identity (the number they were saved with), then carried along with the rest
    const adopted = adoptStrays(store, prev);
    const siblings = propagate(store, id, prev, next, '', now);
    return { ok: true, person: next, siblings: { loans: siblings.loans, investments: siblings.investments, smsOn: siblings.smsOn }, adopted };
}

/** What editing a person would change elsewhere, for the confirmation that precedes it. */
export function previewUpdate(store, id, input) {
    const prev = personById(listPeople(store), id);
    const clean = cleanPerson(input);
    if (!prev || !clean.ok) return { loans: 0, investments: 0, smsOn: 0 };
    const next = { ...prev, ...clean.fields };
    const diff = SHARED.filter((f) => personValue(prev, f) !== personValue(next, f));
    // A loan that is not linked to this person yet is claimed by saving them, WHATEVER was edited (an email alone still gives it the person's second
    // number), so it is counted even when no shared field changed and the owner is asked first.
    const stray = strayRecords(store, prev);
    if (!diff.length && !stray.length) return { loans: 0, investments: 0, smsOn: 0 };
    const linked = diff.length ? usageOf(prev, booksOf(store)) : { loans: 0, investments: 0, smsOn: 0 };
    const books = booksOf(store);
    const byKey = { debtors: new Map(books.debtors.map((r) => [r && r.id, r])), income: new Map(books.income.map((r) => [r && r.id, r])) };
    return {
        loans: linked.loans + stray.filter((x) => x.key === 'debtors').length,
        investments: linked.investments + stray.filter((x) => x.key === 'income').length,
        smsOn: linked.smsOn + stray.filter((x) => (byKey[x.key].get(x.id) || {}).sms_notifications_enabled === true).length,
    };
}

export function addPerson(store, input, { now = Date.now(), newId = defaultId } = {}) {
    const clean = cleanPerson(input);
    if (!clean.ok) return { ok: false, errors: clean.errors };
    const people = listPeople(store);
    if (people.length >= LIMITS.people) return { ok: false, errors: { name: 'The list is full.' } };
    const dup = findDuplicate(people, clean.fields);
    if (dup) return { ok: false, errors: { name: `${dup.name} is already in the list with the same ${str(dup.nic).trim() && str(clean.fields.nic).trim() ? 'NIC / ID' : 'number'}.` }, duplicate: dup };
    const person = newPerson(clean.fields, { now, newId });
    store.set(PEOPLE_KEY, [...people, person]);
    // a loan or an investment that already names this person is theirs from now on, and gets the second number and anything else it lacked
    const adopted = adoptStrays(store, person);
    const siblings = (adopted.loans + adopted.investments) ? propagate(store, person.id, person, person, '', now) : { loans: 0, investments: 0, smsOn: 0 };
    return { ok: true, person, adopted, siblings };
}

/**
 * Add many people at once (an import). One write, however many; a person who is already in the book, or twice in the list, is counted and
 * skipped rather than doubled.
 * @returns {{added:number, duplicates:number, failed:number}}
 */
export function addPeople(store, inputs, { now = Date.now(), newId = defaultId } = {}) {
    const people = listPeople(store).slice();
    const out = { added: 0, duplicates: 0, failed: 0 };
    for (const input of Array.isArray(inputs) ? inputs : []) {
        const clean = cleanPerson(input);
        if (!clean.ok || people.length >= LIMITS.people) { out.failed += 1; continue; }
        if (findDuplicate(people, clean.fields)) { out.duplicates += 1; continue; }
        people.push(newPerson(clean.fields, { now, newId }));
        out.added += 1;
    }
    if (out.added) store.set(PEOPLE_KEY, people);
    return out;
}

/** Remove a person from the book. No loan or investment is touched. */
export function removePerson(store, id) {
    const people = listPeople(store);
    if (!personById(people, id)) return false;
    store.set(PEOPLE_KEY, people.filter((p) => p.id !== id));
    return true;
}

/* ── people who are already in the ledgers but not in the book ───────────── */

/**
 * Loans and investments that name somebody the book does not know. A loan names a person, and so does an investment ("Company / Person"):
 * every one that has a name counts, whether or not it also has a number, an ID or the text switch.
 * `orphans: false` leaves out records that point at a person who is not in the book (a deleted person stays deleted; see harvestPeople).
 * @returns {{key:'debtors'|'income', kind:'debtor'|'investment', id:string, name:string, phone:string, nic:string}[]}
 */
export function unfiledRecords(store, { orphans = true } = {}) {
    const people = listPeople(store);
    const out = [];
    for (const [key, kind] of [['debtors', 'debtor'], ['income', 'investment']]) {
        for (const r of (store && store.get(key)) || []) {
            if (!r || typeof r !== 'object' || !r.id) continue;
            if (personById(people, r[LINK_FIELD])) continue;
            // a record that still points at somebody who is no longer in the book is an orphan: the owner deleted that person (or their entry has not
            // arrived from another device yet). Filing them again by itself would undo a delete, so only the owner's own "file everybody" does that
            if (!orphans && r[LINK_FIELD]) continue;
            const shared = readShared(kind, r);
            if (!shared.name) continue;
            out.push({ key, kind, id: r.id, ...shared });
        }
    }
    return out;
}

/**
 * File everybody the ledgers already name. The same NIC, or the same number under the same name, is one person (two loans to Nimal are
 * one Nimal); two records with a name and nothing else are one person when the name is the same. Records only gain their `personId`;
 * nothing else on a ledger is touched.
 * @returns {{added:number, linked:number}}
 */
export function harvestPeople(store, { now = Date.now(), newId = null, orphans = true } = {}) {
    const unfiled = unfiledRecords(store, { orphans });
    const people = listPeople(store).slice();
    const point = { debtors: new Map(), income: new Map() };
    let added = 0;
    let linked = 0;
    for (const u of unfiled) {
        const iso = isoOfPhone(u.phone);
        let hit = findDuplicate(people, { name: u.name, phone: u.phone, nic: u.nic, country: iso });
        if (!hit && !u.phone && !u.nic) hit = sameNameOnly(people, u.name);
        if (!hit) {
            if (people.length >= LIMITS.people) continue;
            // a number that is a number is saved the way every device and the server read it (E.164); one that is not is kept as it was written
            const pn = u.phone ? resolvePhone(u.phone, iso) : null;
            hit = newPerson({ name: u.name.slice(0, LIMITS.name), fullName: u.fullName ? u.fullName.slice(0, LIMITS.fullName) : '', phone: pn && pn.ok ? pn.e164 : u.phone, phone2: secondNumberOf(u.phone2, iso), country: pn && pn.ok ? pn.iso : iso, nic: u.nic, email: '', address: '', note: '' }, { now, newId: newId || (() => harvestId(u)) });
            people.push(hit);
            added += 1;
        }
        point[u.key].set(u.id, hit.id);
        linked += 1;
    }
    if (!linked) return { added: 0, linked: 0 };
    if (added) store.set(PEOPLE_KEY, people);
    const byId = new Map(people.map((p) => [p.id, p]));
    for (const key of ['debtors', 'income']) {
        if (!point[key].size) continue;
        const kind = key === 'debtors' ? 'debtor' : 'investment';
        store.set(key, (store.get(key) || []).map((r) => {
            if (!r || !point[key].has(r.id)) return r;
            const copy = { ...r, [LINK_FIELD]: point[key].get(r.id) };
            fillBlanks(kind, copy, byId.get(copy[LINK_FIELD]), now);         // a number or ID the record lacked comes from the person; nothing it holds is replaced
            return copy;
        }));
    }
    return { added, linked };
}

/**
 * An id for a person filed from the ledgers, derived from WHO they are (NIC, else name and number), so two devices that each file the same
 * ledger before they have synced arrive at the same people and the cloud merge, which joins by id, does not double them.
 */
function harvestId(u) {
    const id = u.nic ? normalizeIdentity(u.nic) : null;
    const phone = u.phone ? normalizePhone(u.phone, { defaultCountry: DEFAULT_REGION }) : null;
    const key = id && id.ok ? 'n|' + id.canonical : 'p|' + nameKey(u.name) + '|' + (phone && phone.ok ? phone.e164 : '');
    // cyrb53: a small, well-spread hash that needs no async crypto and is the same in every browser and in node
    let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
    for (let i = 0; i < key.length; i += 1) { const ch = key.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 'ph' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* ── contacts from the phone ──────────────────────────────────────────────── */

/** The browser's Contact Picker (Chrome on Android; not Safari, not desktop). */
function webContactPickerSupported(win) {
    try { return !!(win && win.navigator && 'contacts' in win.navigator && win.navigator.contacts && typeof win.navigator.contacts.select === 'function' && 'ContactsManager' in win); } catch (_) { return false; }
}

/**
 * The WealthFlow app's own contact picker. Inside the app shell (native/, a Capacitor build) the page is told about the plugin `WealthFlowContactPicker`,
 * whose one method `pick()` opens the operating system's contact chooser and answers { cancelled:true } or { cancelled:false, name, number }: the one number
 * the person touched, nothing else from the address book. It asks for no contacts permission (Android's picker intent and iOS's CNContactPickerViewController
 * both hand the app only what was chosen). In a plain browser this is null.
 */
const nativePickers = new WeakMap();
function nativeContactPicker(win) {
    try {
        const cap = win && win.Capacitor;
        if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
        if (nativePickers.has(win)) return nativePickers.get(win);                    // only a found plugin is remembered: the bridge may not have been there on the first look
        let plugin = cap.Plugins && cap.Plugins.WealthFlowContactPicker;
        if (!plugin && typeof cap.isPluginAvailable === 'function' && cap.isPluginAvailable('WealthFlowContactPicker') && typeof cap.registerPlugin === 'function') plugin = cap.registerPlugin('WealthFlowContactPicker');
        if (!plugin || typeof plugin.pick !== 'function') return null;
        nativePickers.set(win, plugin);
        return plugin;
    } catch (_) { return null; }
}

/** Is there anything on this device that opens the contacts from a tap: the app's own picker, or Chrome's on Android. */
export function contactPickerSupported(win) {
    return !!nativeContactPicker(win) || webContactPickerSupported(win);
}

/** Which kind of picker would open: 'native' (the WealthFlow app), 'web' (Chrome on Android), or '' (none: paste, drag or a file). */
export function contactPickerKind(win) {
    return nativeContactPicker(win) ? 'native' : webContactPickerSupported(win) ? 'web' : '';
}

const PICK_WORDS = {
    unsupported: 'This browser cannot open your contacts. Type the number, or paste it.',
    denied: 'WealthFlow was not allowed to open your contacts. Allow contacts for this site in the browser settings, or paste the number instead.',
    security: 'The browser only opens contacts from a tap. Please tap the button again.',
    open: 'Your contacts are already open. Choose a contact there, or close it and try again.',
    failed: 'Could not open your contacts. Paste the number instead.',
};

const pickFailure = (status, userMessage) => ({ status, contacts: [], userMessage });
let pickOpen = false;                                                     // the system picker is on screen: a second tap must not stack another

/** What the app's picker answered, as cards; null when the answer is not in the documented shape. */
function cardsFromNative(res) {
    if (!res || typeof res !== 'object' || Array.isArray(res)) return null;
    if (res.cancelled === true) return [];
    const has = (k) => res[k] !== undefined && res[k] !== null;
    if (!has('name') && !has('number') && !has('numbers') && res.cancelled !== false) return null;
    if (has('name') && typeof res.name !== 'string') return null;
    if (has('number') && typeof res.number !== 'string') return null;
    if (has('numbers') && (!Array.isArray(res.numbers) || res.numbers.some((n) => typeof n !== 'string'))) return null;
    const tels = [...new Set([...(has('number') ? [res.number] : []), ...(has('numbers') ? res.numbers : [])].map((n) => squash(n)).filter(Boolean))];
    const name = has('name') ? squash(res.name) : '';
    return name || tels.length ? [{ name, tels }] : [];
}

/**
 * Open the contact chooser the device has, from a tap. Never opens a file dialog and never touches a form: the caller decides what to do with the answer.
 * @returns {Promise<{status:'selected'|'cancelled'|'unsupported'|'permission-denied'|'no-phone-number'|'busy'|'error', contacts:{name:string,tels:string[]}[], source?:'native'|'web', userMessage?:string}>}
 *   selected          one or more contacts that each carry a number
 *   no-phone-number   the person chose someone with no number (contacts still lists them, so the page can say who)
 *   cancelled         the person closed the chooser, or it gave back nothing
 *   busy              a chooser is already open
 *   unsupported / permission-denied / error carry `userMessage`, fit to show.
 */
export async function pickContactResult(win, { multiple = false } = {}) {
    const native = nativeContactPicker(win);
    const web = !native && webContactPickerSupported(win);
    if (!native && !web) return pickFailure('unsupported', PICK_WORDS.unsupported);
    if (pickOpen) return { status: 'busy', contacts: [] };
    pickOpen = true;
    try {
        let cards;
        if (native) {
            let res;
            try { res = await native.pick(); }
            catch (err) {
                const code = str(err && (err.code || err.errorCode)).toLowerCase();
                const msg = str(err && err.message).toLowerCase();
                if (/cancel/.test(code) || /cancel|dismiss/.test(msg)) return { status: 'cancelled', contacts: [], source: 'native' };
                if (/denied|permission|not.?allowed|restricted/.test(code + ' ' + msg)) return { ...pickFailure('permission-denied', PICK_WORDS.denied), source: 'native' };
                return { ...pickFailure('error', PICK_WORDS.failed), source: 'native' };
            }
            cards = cardsFromNative(res);
            if (cards === null) return { ...pickFailure('error', PICK_WORDS.failed), source: 'native' };
        } else {
            let picked;
            try { picked = await win.navigator.contacts.select(['name', 'tel'], { multiple: !!multiple }); }
            catch (err) {
                if (err && err.name === 'AbortError') return { status: 'cancelled', contacts: [], source: 'web' };
                if (err && err.name === 'NotAllowedError') return { ...pickFailure('permission-denied', PICK_WORDS.denied), source: 'web' };
                return { ...pickFailure('error', err && err.name === 'SecurityError' ? PICK_WORDS.security : err && err.name === 'InvalidStateError' ? PICK_WORDS.open : PICK_WORDS.failed), source: 'web' };
            }
            cards = (Array.isArray(picked) ? picked : []).map((c) => ({
                name: squash(Array.isArray(c && c.name) ? c.name[0] : ''),
                tels: [...new Set((Array.isArray(c && c.tel) ? c.tel : []).map((t) => squash(t)).filter(Boolean))],
            })).filter((c) => c.name || c.tels.length);
        }
        const source = native ? 'native' : 'web';
        if (!cards.length) return { status: 'cancelled', contacts: [], source };
        return { status: cards.some((c) => c.tels.length) ? 'selected' : 'no-phone-number', contacts: cards, source };
    } finally { pickOpen = false; }
}

/**
 * pickContactResult for callers that want the cards: [] when the person closed it, the cards otherwise (a card with no number included, so the page can
 * say so), and an Error carrying `.userMessage` for anything that is not a plain "closed it".
 * @throws {Error} with `.userMessage`
 */
export async function pickContacts(win, opts = {}) {
    const r = await pickContactResult(win, opts);
    if (r.status === 'selected' || r.status === 'no-phone-number') return r.contacts;
    if (r.status === 'cancelled' || r.status === 'busy') return [];
    const e = new Error(r.status); e.userMessage = r.userMessage; e.status = r.status; throw e;
}

/** Decode a quoted-printable value (Android's contacts export writes non-English names this way). */
function decodeQuotedPrintable(v, charset) {
    const bytes = [];
    const t = str(v);
    for (let i = 0; i < t.length; i += 1) {
        if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
        else bytes.push(t.charCodeAt(i) & 0xFF);
    }
    try { return new TextDecoder(/^utf-?8$/i.test(str(charset)) || !charset ? 'utf-8' : str(charset)).decode(Uint8Array.from(bytes)); } catch (_) { return t; }
}

/**
 * The contacts in a vCard (.vcf) file, from any phone's "share contact" or an exported address book.
 * @returns {{name:string, tels:string[]}[]} at most LIMITS.vcfCards, a card with neither a name nor a number is skipped
 */
export function parseVCards(text) {
    const src = str(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    // unfold: a line that starts with a space or a tab continues the one before; a quoted-printable value ending in "=" continues on the next line
    const raw = src.split('\n');
    const lines = [];
    for (const line of raw) {
        if (/^[ \t]/.test(line) && lines.length) { lines[lines.length - 1] += line.slice(1); continue; }
        const prev = lines[lines.length - 1];
        if (prev !== undefined && /ENCODING=QUOTED-PRINTABLE/i.test(prev) && /=$/.test(prev)) { lines[lines.length - 1] = prev.slice(0, -1) + line; continue; }
        lines.push(line);
    }
    const out = [];
    let cur = null;
    for (const line of lines) {
        const up = line.trim().toUpperCase();
        if (up === 'BEGIN:VCARD') { cur = { fn: '', n: '', tels: [] }; continue; }
        if (up === 'END:VCARD') {
            if (cur) {
                const parts = cur.n.split(';').map((x) => squash(x));
                const fromN = squash([parts[3], parts[1], parts[2], parts[0]].filter(Boolean).join(' '));
                const name = cur.fn || fromN;
                const tels = [...new Set(cur.tels)];
                if (name || tels.length) out.push({ name: name.slice(0, LIMITS.name), tels });
            }
            cur = null;
            if (out.length >= LIMITS.vcfCards) break;
            continue;
        }
        if (!cur) continue;
        const colon = line.indexOf(':');
        if (colon < 1) continue;
        const head = line.slice(0, colon);
        let value = line.slice(colon + 1);
        const params = head.split(';');
        const prop = params[0].replace(/^[^.]*\./, '').toUpperCase();          // "item1.TEL" -> "TEL"
        const paramText = params.slice(1).join(';');
        if (/ENCODING=QUOTED-PRINTABLE/i.test(paramText)) value = decodeQuotedPrintable(value, (/CHARSET=([\w-]+)/i.exec(paramText) || [])[1]);
        if (prop === 'FN') cur.fn = squash(value);
        else if (prop === 'N') cur.n = value;
        else if (prop === 'TEL') { const t = squash(value.replace(/^tel:/i, '')); if (t) cur.tels.push(t); }
    }
    return out;
}

/* ── contacts from a spreadsheet export, or copied text ──────────────────── */

/** Rows of a CSV, whatever the delimiter: quoted cells (with the delimiter, a line break or doubled quotes inside), CRLF, a byte-order mark. */
function csvTable(text, delim) {
    const rows = [];
    let row = []; let cell = ''; let quoted = false;
    const src = str(text).replace(/^﻿/, '');
    const endCell = () => { row.push(cell); cell = ''; };
    const endRow = () => { endCell(); if (row.some((c) => str(c).trim())) rows.push(row); row = []; };
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; } else cell += ch;
        } else if (ch === '"' && !cell) quoted = true;
        else if (ch === delim) endCell();
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i += 1; endRow(); }
        else cell += ch;
        if (rows.length > LIMITS.vcfCards + 1) break;
    }
    if (cell || row.length) endRow();
    return rows;
}

/** The delimiter a sheet uses, read from its first line (outside quotes). */
function sniffDelimiter(text) {
    const first = str(text).replace(/^﻿/, '').split(/\r\n|\n|\r/).find((l) => l.trim()) || '';
    const count = (d) => { let n = 0; let q = false; for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch === d) n += 1; } return n; };
    const best = [',', ';', '\t'].map((d) => [d, count(d)]).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : ',';
}

const HEADER = {
    full: /^(name|full name|display name|file as|nickname|contact name)$/,
    first: /^(first name|given name|forename)$/,
    middle: /^(middle name|additional name)$/,
    last: /^(last name|family name|surname)$/,
    org: /^(organi[sz]ation(?: name| 1 - name)?|company)$/,
    phone: /(phone|mobile|\bcell\b|cellular|telephone|\btel\b|\bgsm\b|contact no|contact number|^number$)/,
    notPhone: /(label|type|fax|pager|\bext\b|extension|phonetic|\bcode\b|\bcountry\b)/,
};

/** Cells of a contacts sheet often hold several numbers: Google joins them with " ::: ", others with ";" or a line break. */
const splitNumbers = (cell) => str(cell).split(/\s*(?::::|;|\n)\s*/).map((x) => squash(x)).filter(Boolean);

/**
 * The contacts in a spreadsheet export (CSV) from Google Contacts, Outlook, a phone's export or a hand-made sheet. A sheet is a contacts sheet when
 * it has a phone column; names come from a name column, or first + middle + last, or the company.
 * @returns {{name:string, tels:string[]}[]}
 */
export function parseContactsCsv(text) {
    const src = str(text);
    if (!src.trim()) return [];
    const rows = csvTable(src.length > LIMITS.vcfBytes ? src.slice(0, LIMITS.vcfBytes) : src, sniffDelimiter(src));
    if (rows.length < 2) return [];
    const head = rows[0].map((h) => squash(h).toLowerCase());
    const phones = head.map((h, i) => (HEADER.phone.test(h) && !HEADER.notPhone.test(h) ? i : -1)).filter((i) => i >= 0);
    if (!phones.length) return [];
    const at = (re) => head.findIndex((h) => re.test(h));
    const full = at(HEADER.full); const first = at(HEADER.first); const middle = at(HEADER.middle); const last = at(HEADER.last); const org = at(HEADER.org);
    const out = [];
    for (const row of rows.slice(1)) {
        const cell = (i) => (i >= 0 ? squash(row[i]) : '');
        let name = cell(full) || squash([cell(first), cell(middle), cell(last)].filter(Boolean).join(' ')) || cell(org);
        name = name.slice(0, LIMITS.name);
        const tels = [...new Set(phones.flatMap((i) => splitNumbers(row[i])))];
        if (tels.length) out.push({ name, tels });
        if (out.length >= LIMITS.vcfCards) break;
    }
    return out;
}

const LABEL_LINE = /^(?:mobile|cell|cellphone|home|work|office|business|main|other|phone|tel|telephone|iphone|fax|whatsapp|primary|mobile \d|home \d|work \d)\s*:?$/i;
const PHONE_LIKE = /(?:\+|00)?\p{Nd}[\p{Nd}\s().\-–]{5,}\p{Nd}/gu;
const DATE_LIKE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;

/**
 * Contacts from text a person copied: a bare number, "Name: number", a contact card laid out on lines (with the label lines a phone adds), or
 * a list of those. A date or an amount is not a number; a name is only what sits beside or just above a number, never a sentence.
 * @returns {{name:string, tels:string[]}[]}
 */
export function parseContactsText(text) {
    const src = str(text);
    const out = [];
    const byName = new Map();
    let pending = '';
    const push = (name, tel) => {
        const key = nameKey(name);
        const hit = key ? byName.get(key) : null;
        if (hit) { if (!hit.tels.includes(tel)) hit.tels.push(tel); return; }
        const card = { name: name.slice(0, LIMITS.name), tels: [tel] };
        out.push(card);
        if (key) byName.set(key, card);
    };
    for (const line of (src.length > LIMITS.vcfBytes ? src.slice(0, LIMITS.vcfBytes) : src).split(/\r\n|\n|\r/)) {
        const t = squash(line);
        if (!t) { pending = ''; continue; }
        const found = [...t.matchAll(PHONE_LIKE)].map((m) => ({ raw: m[0].trim().replace(/[\s.\-–(]+$/, ''), at: m.index, len: m[0].length })).filter((m) => !DATE_LIKE.test(m.raw) && m.raw.replace(/\P{Nd}/gu, '').length >= 7 && m.raw.replace(/\P{Nd}/gu, '').length <= 15);
        if (!found.length) {
            if (!LABEL_LINE.test(t) && !/@/.test(t) && t.length <= 60 && !/\p{Nd}/u.test(t)) pending = t;
            continue;
        }
        // what is left of the line once the numbers are taken out is the name, if it is short enough to be one
        let rest = t;
        for (const m of [...found].sort((a, b) => b.at - a.at)) rest = rest.slice(0, m.at) + ' ' + rest.slice(m.at + m.len);
        rest = squash(rest.replace(/^[\s:,;|\-–—()[\]]+|[\s:,;|\-–—()[\]]+$/g, ''));
        const label = LABEL_LINE.test(rest) || /^(?:tel|phone|mobile|call|contact|number|no)\b[.:]?$/i.test(rest);
        const lineName = !label && rest && rest.length <= 60 && rest.split(' ').length <= 6 && !/@/.test(rest) ? rest : '';
        const name = lineName || pending;
        for (const m of found) { push(name, m.raw); if (out.length >= LIMITS.vcfCards) return out; }
        if (lineName) pending = lineName;
    }
    return out;
}

/**
 * Whatever a person brought: the text of a vCard, a CSV export or plain copied text. The content decides, not the file name.
 * @returns {{kind:'vcard'|'csv'|'text'|'empty', cards:{name:string, tels:string[]}[]}}
 */
export function parseContacts(text, fileName = '') {
    const src = str(text);
    if (!src.trim()) return { kind: 'empty', cards: [] };
    const control = (src.slice(0, 2000).match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length;
    if (control > 8) return { kind: 'empty', cards: [] };                         // a photo or a zip chosen by mistake is not a contact
    if (/BEGIN:VCARD/i.test(src)) { const cards = parseVCards(src); return { kind: cards.length ? 'vcard' : 'empty', cards }; }
    const firstLine = src.replace(/^﻿/, '').split(/\r\n|\n|\r/).find((l) => l.trim()) || '';
    if (/[,;\t]/.test(firstLine) && (/\.csv$/i.test(str(fileName)) || HEADER.phone.test(firstLine.toLowerCase()) || /\bname\b/i.test(firstLine))) {
        const cards = parseContactsCsv(src);
        if (cards.length) return { kind: 'csv', cards };
    }
    const cards = parseContactsText(src);
    return { kind: cards.length ? 'text' : 'empty', cards };
}

/** The kind of device a page is on, for the instructions that differ between them. */
export function platformOf(win) {
    const n = win && win.navigator;
    if (!n) return 'other';
    const ua = str(n.userAgent); const pf = str(n.platform); const touch = Number(n.maxTouchPoints) || 0;
    if (/android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(pf) && touch > 1)) return 'ios';       // an iPad asking for the desktop site says "Mac" and has a touch screen
    if (/CrOS/i.test(ua)) return 'linux';
    if (/Win/i.test(pf) || /Windows/i.test(ua)) return 'windows';
    if (/Mac/i.test(pf) || /Macintosh/i.test(ua)) return 'mac';
    if (/Linux|X11/i.test(pf + ' ' + ua)) return 'linux';
    return 'other';
}

/**
 * A contact (from the picker or a file) as something a form can use: its name and the numbers that can be texted, in E.164, with the
 * country a bare local number is read in. Numbers that are not valid are kept (`others`) so nothing a person sees is silently dropped.
 */
export function draftFromContact(contact, iso = DEFAULT_REGION) {
    const c = contact || {};
    const valid = []; const others = [];
    for (const t of Array.isArray(c.tels) ? c.tels : []) {
        const p = normalizePhone(t, { defaultCountry: iso });
        if (p.ok) { if (!valid.some((v) => v.e164 === p.e164)) valid.push({ raw: t, e164: p.e164, pretty: formatPhone(p.e164), iso: p.iso }); }
        else others.push({ raw: t, reason: p.reason });
    }
    return { name: squash(c.name).slice(0, LIMITS.name), numbers: valid, others };
}

export default {
    PEOPLE_KEY, LINK_FIELD, LIMITS, SHARED, phoneProblem, idProblem, resolvePhone, isoOfPhone, secondNumberOf, storedId, idKindOf, cleanPerson, newPerson, defaultId,
    personById, listPeople, findDuplicate, sameNameOnly, searchPeople, recordMatches, readShared, writeShared, usageOf, booksOf, sharedDiff, propagate, strayRecords, adoptStrays, reconcileLinked, linkRecord, updatePerson, previewUpdate, addPerson, addPeople, removePerson,
    unfiledRecords, harvestPeople, contactPickerSupported, contactPickerKind, pickContactResult, pickContacts, parseVCards, parseContactsCsv, parseContactsText, parseContacts, platformOf, draftFromContact,
};
