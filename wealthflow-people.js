/* =============================================================================
 * wealthflow-people.js — the saved-people book: who the owner lends to or invests with, saved ONCE
 * -----------------------------------------------------------------------------
 * The owner's ask: add a person the first time, with every detail, and when they borrow again pick
 * them from the list instead of typing it all again; edit or delete them there; take a number from
 * the phone's own contacts; and let texts go to anyone in any country.
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

import { normalizePhone, formatPhone, countryNameOf, regionByIso, DEFAULT_REGION } from './wealthflow-phone.js';
import { normalizeNic, normalizeOtherId, normalizeIdentity, displayIdentity, OTHER_ID_PREFIX } from './wealthflow-nic.js';

export const PEOPLE_KEY = 'people';
export const LINK_FIELD = 'personId';
export const LIMITS = Object.freeze({ name: 80, phone2: 24, email: 120, address: 200, note: 300, people: 2000, vcfBytes: 2 * 1024 * 1024, vcfCards: 2000 });
/** What a person shares with every record linked to them: the rest of a loan or an investment is that record's own. */
export const SHARED = Object.freeze(['name', 'phone', 'nic']);

const str = (v) => String(v == null ? '' : v);
/** Collapses runs of whitespace and drops control characters: a name pasted from a chat or a contacts export is not trusted to be tidy. */
const squash = (v) => str(v).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();

/* ── words ────────────────────────────────────────────────────────────────── */

const PHONE_TEXT = {
    'empty': 'Enter the mobile number the texts should go to.',
    'not-a-number': 'A phone number can only contain digits, spaces and a leading +.',
    'misplaced-plus': 'A + can only come first, as in +94 77 123 4567.',
    'needs-country-code': 'Add the country code, for example +94 77 123 4567, or choose the country.',
    'unknown-country-code': 'That country code is not one I know. Check the digits after the +.',
    'bad-length': 'That number has the wrong number of digits for the country.',
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
 *   input: { name, phone, phone2, country, nic, idKind, email, address, note }
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

    let phone2 = squash(i.phone2).slice(0, LIMITS.phone2);
    if (phone2 && /[^\d+\s().-]/.test(phone2)) { errors.phone2 = 'The other number can only contain digits, spaces and a leading +.'; phone2 = ''; }

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
        name, phone, phone2, country, nic,
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
        const name = norm(p.name);
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

/* ── how a loan or an investment shows its person ─────────────────────────── */

/** The shared fields as a record keeps them. An investment keeps the person's name in `company` ("Company / Person"), a loan in `name`. */
export function readShared(kind, rec) {
    const r = rec || {};
    return { name: squash(kind === 'debtor' ? r.name : r.company), phone: str(r.phone).trim(), nic: str(r.nic).trim() };
}

/** Write shared values onto a record. Returns true when anything changed. */
export function writeShared(kind, rec, values) {
    let changed = false;
    const set = (field, value) => { if (str(rec[field]) !== str(value)) { rec[field] = value; changed = true; } };
    if (values.name !== undefined && values.name !== '') set(kind === 'debtor' ? 'name' : 'company', values.name);
    if (values.phone !== undefined) set('phone', values.phone);
    if (values.nic !== undefined) set('nic', values.nic);
    return changed;
}

/** What a record lacks of its person, from the person: only fields the record has nothing in. A number or ID the record already carries is never replaced. */
function fillBlanks(kind, rec, person) {
    const have = readShared(kind, rec);
    const gift = {};
    for (const f of ['phone', 'nic']) if (!have[f] && str(person && person[f]).trim()) gift[f] = str(person[f]).trim();
    return Object.keys(gift).length ? writeShared(kind, rec, gift) : false;
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
    return SHARED.filter((f) => (f !== 'name' || shared.name) && str(shared[f]) !== str(person && person[f]));
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
export function propagate(store, personId, prev, next, skipId = '') {
    const out = { loans: 0, investments: 0, smsOn: 0 };
    const diff = {};
    for (const f of SHARED) if (str(prev && prev[f]) !== str(next && next[f])) diff[f] = str(next[f]);
    for (const [key, kind, counter] of [['debtors', 'debtor', 'loans'], ['income', 'investment', 'investments']]) {
        const list = store.get(key) || [];
        let touched = false;
        const updated = list.map((r) => {
            if (!r || r[LINK_FIELD] !== personId || (skipId && r.id === skipId)) return r;
            const copy = { ...r };
            const changed = writeShared(kind, copy, diff) | fillBlanks(kind, copy, next);
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
        for (const f of SHARED) if (f !== 'name' || shared.name) next[f] = shared[f];
        if (iso && iso !== existing.country) next.country = iso;
        const changed = SHARED.some((f) => str(next[f]) !== str(existing[f])) || (next.country || '') !== (existing.country || '');
        if (!changed) {
            // nothing to teach the person, but a record of theirs that fell out of step is put right
            const repaired = propagate(store, existing.id, existing, existing, rec.id);
            return { ...none, person: existing, siblings: repaired };
        }
        next.updatedAt = stamp;
        store.set(PEOPLE_KEY, people.map((p) => (p.id === existing.id ? next : p)));
        const siblings = propagate(store, existing.id, existing, next, rec.id);
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
        for (const f of ['phone', 'nic']) if (shared[f] && str(dup[f]) !== shared[f]) { next[f] = shared[f]; changed = true; }
        if (iso && !dup.country) { next.country = iso; changed = true; }
        if (changed) {
            next.updatedAt = stamp;
            store.set(PEOPLE_KEY, people.map((p) => (p.id === dup.id ? next : p)));
        }
        const siblings = changed ? propagate(store, dup.id, dup, next, rec.id) : none.siblings;
        rec[LINK_FIELD] = dup.id;
        writeShared(kind, rec, { name: next.name });
        fillBlanks(kind, rec, next);
        return { person: changed ? next : dup, created: false, matched: true, updated: changed, siblings };
    }

    // a person mirrors the record they were made from (a number that cannot be texted is still worth keeping); the book's own form is the
    // place that insists on a clean one
    const fields = {
        name: shared.name.slice(0, LIMITS.name),
        phone: shared.phone, phone2: '',
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
    return { ok: true, person: next, siblings: propagate(store, id, prev, next) };
}

/** What editing a person would change elsewhere, for the confirmation that precedes it. */
export function previewUpdate(store, id, input) {
    const prev = personById(listPeople(store), id);
    const clean = cleanPerson(input);
    if (!prev || !clean.ok) return { loans: 0, investments: 0, smsOn: 0 };
    const next = { ...prev, ...clean.fields };
    const diff = SHARED.filter((f) => str(prev[f]) !== str(next[f]));
    if (!diff.length) return { loans: 0, investments: 0, smsOn: 0 };
    return usageOf(prev, booksOf(store));
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
    return { ok: true, person };
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
            hit = newPerson({ name: u.name.slice(0, LIMITS.name), phone: pn && pn.ok ? pn.e164 : u.phone, phone2: '', country: pn && pn.ok ? pn.iso : iso, nic: u.nic, email: '', address: '', note: '' }, { now, newId: newId || (() => harvestId(u)) });
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
            fillBlanks(kind, copy, byId.get(copy[LINK_FIELD]));         // a number or ID the record lacked comes from the person; nothing it holds is replaced
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
export function contactPickerSupported(win) {
    try { return !!(win && win.navigator && 'contacts' in win.navigator && win.navigator.contacts && typeof win.navigator.contacts.select === 'function' && 'ContactsManager' in win); } catch (_) { return false; }
}

/**
 * Open the phone's contact chooser. Must be called from a tap. Resolves to [{name, tels}]; an empty list when the person closed it.
 * @throws an Error whose `.userMessage` is fit to show, for anything that is not a plain "closed it".
 */
export async function pickContacts(win, { multiple = false } = {}) {
    if (!contactPickerSupported(win)) { const e = new Error('unsupported'); e.userMessage = 'This browser cannot open your contacts. Type the number, or import a contacts file.'; throw e; }
    let picked;
    try { picked = await win.navigator.contacts.select(['name', 'tel'], { multiple: !!multiple }); }
    catch (err) {
        if (err && err.name === 'AbortError') return [];
        const e = new Error(str(err && err.message) || 'contacts failed');
        e.userMessage = err && err.name === 'SecurityError' ? 'The browser only opens contacts from a tap. Please tap the button again.' : 'Could not open your contacts.';
        throw e;
    }
    return (Array.isArray(picked) ? picked : []).map((c) => ({
        name: squash(Array.isArray(c && c.name) ? c.name[0] : ''),
        tels: [...new Set((Array.isArray(c && c.tel) ? c.tel : []).map((t) => squash(t)).filter(Boolean))],
    })).filter((c) => c.name || c.tels.length);
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
    PEOPLE_KEY, LINK_FIELD, LIMITS, SHARED, phoneProblem, idProblem, resolvePhone, isoOfPhone, storedId, idKindOf, cleanPerson, newPerson, defaultId,
    personById, listPeople, findDuplicate, sameNameOnly, searchPeople, readShared, writeShared, usageOf, booksOf, sharedDiff, propagate, linkRecord, updatePerson, previewUpdate, addPerson, addPeople, removePerson,
    unfiledRecords, harvestPeople, contactPickerSupported, pickContacts, parseVCards, parseContactsCsv, parseContactsText, parseContacts, platformOf, draftFromContact,
};
