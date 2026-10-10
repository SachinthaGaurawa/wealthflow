/* =============================================================================
 * test/people_test.js — the saved-people book
 * -----------------------------------------------------------------------------
 * What the owner asked for: add a person once with every detail, pick them from the list on the
 * next loan, edit and delete them there, take a number from the phone's contacts, and send texts
 * to anybody in any country. The rules that make that safe are pinned here:
 *   - a number saved in the book is a number that can be texted (E.164, valid for its country);
 *   - the same person is recognised (same NIC / ID, or the same number under the same name) and a
 *     second spelling does not rename them;
 *   - name, phone and NIC stay in step across every loan and investment linked to the person,
 *     because a text sent to a stale copy of a number goes to somebody else;
 *   - deleting a person never touches a ledger;
 *   - contacts files (vCard) from any phone are read, including quoted-printable and folded lines.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import P, {
    PEOPLE_KEY, LINK_FIELD, LIMITS, SHARED, resolvePhone, isoOfPhone, storedId, idKindOf, cleanPerson, newPerson, listPeople, findDuplicate, searchPeople,
    readShared, writeShared, usageOf, propagate, linkRecord, updatePerson, previewUpdate, addPerson, removePerson, personById,
    contactPickerSupported, pickContacts, parseVCards, draftFromContact, phoneProblem, idProblem, sharedDiff, unfiledRecords, harvestPeople, booksOf,
    parseContactsCsv, parseContactsText, parseContacts, platformOf,
} from '../wealthflow-people.js';

const NOW = Date.parse('2026-10-05T08:00:00Z');
const store = (init = {}) => {
    const data = { ...init };
    return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; }, writes: [] };
};
const counter = () => { let n = 0; return () => 'p' + (++n); };

describe('a phone number as the form shows it', () => {
    it('reads a local number in the chosen country and says where it is', () => {
        const r = resolvePhone('077 123 4567', 'LK');
        expect(r).toMatchObject({ ok: true, e164: '+94771234567', pretty: '+94 77 123 4567', iso: 'LK' });
        expect(r.text).toContain('Sri Lanka');
    });
    it('refuses a number of another country, whatever the box was set to, and says the gateway reaches Sri Lanka only', () => {
        for (const raw of ['+44 7911 123456', '0044 7911 123456', '+1 (415) 555-2671', '+971 50 123 4567']) {
            const r = resolvePhone(raw, 'LK');
            expect(r, raw).toMatchObject({ ok: false, reason: 'not-sri-lanka' });
            expect(r.text).toMatch(/Sri Lankan mobile numbers/);
        }
    });
    it('reads a bare number as a Sri Lankan one, and ignores any other country it is told', () => {
        expect(resolvePhone('0771234567', 'AE')).toMatchObject({ ok: true, e164: '+94771234567', iso: 'LK' });
        expect(resolvePhone('0501234567', 'AE')).toMatchObject({ ok: false, reason: 'not-a-mobile-number' });
    });
    it('says nothing for an empty box, and a sentence for a wrong one', () => {
        expect(resolvePhone('', 'LK')).toMatchObject({ ok: false, empty: true, text: '' });
        const bad = resolvePhone('12', 'LK');
        expect(bad.ok).toBe(false);
        expect(bad.text.length).toBeGreaterThan(10);
        expect(resolvePhone('call me', 'LK').reason).toBe('not-a-number');
    });
    it('every reason the normaliser can give has words', () => {
        for (const reason of ['empty', 'not-a-number', 'misplaced-plus', 'not-sri-lanka', 'bad-length', 'not-a-mobile-number']) {
            expect(phoneProblem(reason), reason).not.toBe('That does not look like a phone number.');
        }
        expect(phoneProblem('something-new')).toBe('That does not look like a phone number.');
    });
    it('finds the region of a stored number: Sri Lanka, for every number there is', () => {
        expect(isoOfPhone('+447911123456')).toBe('LK');                    // an old foreign number is not a region the system serves
        expect(isoOfPhone('+94771234567')).toBe('LK');
        expect(isoOfPhone('077 123 4567')).toBe('LK');
    });
});

describe('an identity as a record stores it', () => {
    it('keeps an NIC as typed, cleaned and upper-cased', () => {
        expect(storedId(' 853400937v ', 'nic')).toMatchObject({ ok: true, stored: '853400937V', kind: 'nic' });
        expect(storedId('1985-3400-0937', 'nic')).toMatchObject({ ok: true, stored: '198534000937' });
    });
    it('stores a passport or ID with a prefix so it can never be read as an NIC', () => {
        expect(storedId('ab 123-456', 'other')).toMatchObject({ ok: true, stored: 'ID:AB123456', kind: 'other' });
        expect(idKindOf('ID:AB123456')).toBe('other');
        expect(idKindOf('id:ab123456')).toBe('other');
        expect(idKindOf('853400937V')).toBe('nic');
        expect(idKindOf('')).toBe('nic');
    });
    it('an empty box is fine (the NIC is optional) and a wrong one has words', () => {
        expect(storedId('', 'nic')).toMatchObject({ ok: true, empty: true, stored: '' });
        const bad = storedId('12345', 'nic');
        expect(bad).toMatchObject({ ok: false });
        expect(bad.text).toMatch(/NIC/);
        expect(storedId('a', 'other').text).toMatch(/passport/i);
        expect(idProblem('bad-format')).toBe(idProblem('bad-shape'));       // the old client used one key, the validator the other
    });
});

describe('cleanPerson', () => {
    it('keeps everything a person has and tidies it', () => {
        const r = cleanPerson({ name: '  Nimal   Perera ', fullName: '  Nimal   Kumara  Perera ', phone: '077 123 4567', phone2: '011 234 5678', country: 'lk', nic: '853400937v', email: 'nimal@example.com', address: ' 12 Temple Rd ', note: 'brother of Kamal' });
        expect(r.ok).toBe(true);
        expect(r.fields).toEqual({
            name: 'Nimal Perera', fullName: 'Nimal Kumara Perera', phone: '+94771234567', phone2: '011 234 5678', country: 'LK', nic: '853400937V',
            email: 'nimal@example.com', address: '12 Temple Rd', note: 'brother of Kamal',
        });
    });
    it('needs a name, and a mobile number that can be texted when one is given', () => {
        expect(cleanPerson({ name: '' }).errors.name).toBeTruthy();
        const r = cleanPerson({ name: 'A', phone: '12345' });
        expect(r.ok).toBe(false);
        expect(r.errors.phone).toBeTruthy();
        expect(cleanPerson({ name: 'A' }).ok).toBe(true);                    // a number is optional
    });
    it('accepts a foreign national with a Sri Lankan mobile and their own passport, and refuses a number abroad', () => {
        const r = cleanPerson({ name: 'Ahmed', phone: '077 123 4567', country: 'AE', nic: 'x1234567', idKind: 'other' });
        expect(r.ok).toBe(true);
        expect(r.fields).toMatchObject({ phone: '+94771234567', country: 'LK', nic: 'ID:X1234567' });
        const abroad = cleanPerson({ name: 'Ahmed', phone: '+971 50 123 4567', nic: 'x1234567', idKind: 'other' });
        expect(abroad.ok).toBe(false);
        expect(abroad.errors.phone).toMatch(/Sri Lankan mobile numbers/);
    });
    it('a second number only has to look like a number', () => {
        expect(cleanPerson({ name: 'A', phone2: 'abc' }).errors.phone2).toBeTruthy();
        expect(cleanPerson({ name: 'A', phone2: '+94 11 234 5678' }).fields.phone2).toBe('+94 11 234 5678');
    });
    it('rejects a bad email and clips what is too long', () => {
        expect(cleanPerson({ name: 'A', email: 'nope' }).errors.email).toBeTruthy();
        const long = cleanPerson({ name: 'x'.repeat(500), address: 'y'.repeat(500), note: 'z'.repeat(500) });
        expect(long.fields.name).toHaveLength(LIMITS.name);
        expect(long.fields.address).toHaveLength(LIMITS.address);
        expect(long.fields.note).toHaveLength(LIMITS.note);
    });
    it('does not trust a name pasted from a chat: control characters become spaces', () => {
        expect(cleanPerson({ name: 'Nimal\u0000\n\tPerera' }).fields.name).toBe('Nimal Perera');
    });
    it('an unknown country falls back to Sri Lanka', () => {
        expect(cleanPerson({ name: 'A', country: 'ZZ' }).fields.country).toBe('LK');
        expect(cleanPerson({ name: 'A' }).fields.country).toBe('LK');
    });
});

describe('finding the same person again', () => {
    const people = [
        { id: 'a', name: 'Nimal Perera', phone: '+94771234567', country: 'LK', nic: '853400937V' },
        { id: 'b', name: 'Kamal Silva', phone: '+94711111111', country: 'LK', nic: '' },
        { id: 'c', name: 'Ahmed Khan', phone: '+971501234567', country: 'AE', nic: 'ID:X1234567' },
    ];
    it('the same NIC is the same person, whichever shape it is written in', () => {
        expect(findDuplicate(people, { name: 'N. Perera', nic: '853400937v' }).id).toBe('a');
        expect(findDuplicate(people, { name: 'Somebody', nic: '198534000937' }).id).toBe('a');    // the old and the new shape of one NIC
        expect(findDuplicate(people, { name: 'Somebody', nic: '853400938V' })).toBe(null);          // a different serial is a different person
    });
    it('the same passport is the same person', () => {
        expect(findDuplicate(people, { name: 'Ahmed', nic: 'ID:x-1234567' }).id).toBe('c');
    });
    it('the same number under the same name is the same person; a number alone is not (a family shares one phone)', () => {
        expect(findDuplicate(people, { name: 'kamal  silva', phone: '071 111 1111', country: 'LK' }).id).toBe('b');
        expect(findDuplicate(people, { name: 'Sunil Silva', phone: '071 111 1111', country: 'LK' })).toBe(null);
    });
    it('nothing to go on means nobody', () => {
        expect(findDuplicate(people, { name: 'Zed' })).toBe(null);
        expect(findDuplicate([], { name: 'Nimal', nic: '853400937V' })).toBe(null);
    });
});

describe('searching the book', () => {
    const people = [
        { id: '1', name: 'Nimal Perera', phone: '+94771234567', nic: '853400937V', email: 'n@x.com', note: 'shop' },
        { id: '2', name: 'Kamal Nimalasiri', phone: '+94711111111', nic: '', note: '' },
        { id: '3', name: 'Ahmed Khan', phone: '+971501234567', phone2: '0112345678', nic: 'ID:X1234567', note: '' },
    ];
    it('everybody A to Z when nothing was typed', () => {
        expect(searchPeople(people, '').map((p) => p.id)).toEqual(['3', '2', '1']);
    });
    it('a name that starts with it first, then a word that does, then a name that contains it', () => {
        expect(searchPeople(people, 'nim').map((p) => p.id)).toEqual(['1', '2']);
        expect(searchPeople(people, 'sir').map((p) => p.id)).toEqual(['2']);
    });
    it('finds by any digits of any number, the NIC, or the email', () => {
        expect(searchPeople(people, '771234').map((p) => p.id)).toEqual(['1']);
        expect(searchPeople(people, '0112345').map((p) => p.id)).toEqual(['3']);
        expect(searchPeople(people, '8534').map((p) => p.id)).toEqual(['1']);
        expect(searchPeople(people, 'n@x.com').map((p) => p.id)).toEqual(['1']);
        expect(searchPeople(people, 'zzz')).toEqual([]);
    });
});

describe('how a loan and an investment keep the person', () => {
    it('a loan keeps the name in `name`, an investment in `company`', () => {
        expect(readShared('debtor', { name: ' Nimal ', phone: ' +94771234567', nic: '853400937V' })).toEqual({ name: 'Nimal', fullName: '', phone: '+94771234567', phone2: '', nic: '853400937V' });
        expect(readShared('investment', { company: 'Nimal', name: 'Fixed deposit' }).name).toBe('Nimal');
        const loan = { name: 'a', phone: 'x' };
        expect(writeShared('debtor', loan, { name: 'b', phone: 'x' })).toBe(true);
        expect(loan).toEqual({ name: 'b', phone: 'x' });
        const inv = { name: 'FD', company: 'a' };
        expect(writeShared('investment', inv, { name: 'b', phone: '+94771234567', nic: '' })).toBe(true);
        expect(inv).toEqual({ name: 'FD', company: 'b', phone: '+94771234567' });                  // a blank NIC on a record that has none adds no field
        expect(writeShared('investment', inv, { name: 'b' })).toBe(false);
    });
    it('the full name is a field of its own: the nickname in `name` / `company` is never overwritten by it, and a blank one removes it', () => {
        expect(readShared('investment', { company: 'Nimal', fullName: ' Nimal  Kumara Perera ' })).toMatchObject({ name: 'Nimal', fullName: 'Nimal Kumara Perera' });
        const loan = { name: 'Nimal' };
        expect(writeShared('debtor', loan, { name: 'Nimal', fullName: 'Nimal Kumara Perera' })).toBe(true);
        expect(loan).toEqual({ name: 'Nimal', fullName: 'Nimal Kumara Perera' });
        expect(writeShared('debtor', loan, { fullName: '' })).toBe(true);
        expect(loan).toEqual({ name: 'Nimal' });
        expect(writeShared('debtor', loan, { fullName: '' })).toBe(false);
    });
    it('a blank name never blanks a record', () => {
        const loan = { name: 'Nimal' };
        writeShared('debtor', loan, { name: '' });
        expect(loan.name).toBe('Nimal');
    });
    it('counts what points at a person', () => {
        const u = usageOf({ id: 'p1' }, {
            debtors: [{ id: 'd1', personId: 'p1', sms_notifications_enabled: true }, { id: 'd2', personId: 'p1' }, { id: 'd3', personId: 'zz' }],
            income: [{ id: 'i1', personId: 'p1', sms_notifications_enabled: true }],
        });
        expect(u).toEqual({ loans: 2, investments: 1, smsOn: 2 });
        expect(usageOf(null, {})).toEqual({ loans: 0, investments: 0, smsOn: 0 });
    });
});

describe('linking a record to a person', () => {
    const nid = () => counter();
    it('remember: a new person is filed and the record points at them', () => {
        const s = store({ people: [], debtors: [], income: [] });
        const rec = { id: 'd1', name: 'Nimal Perera', phone: '+94771234567', nic: '853400937V' };
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: true, country: 'LK', now: NOW, newId: nid() });
        expect(r.created).toBe(true);
        expect(rec[LINK_FIELD]).toBe('p1');
        expect(s.data.people).toHaveLength(1);
        expect(s.data.people[0]).toMatchObject({ id: 'p1', name: 'Nimal Perera', phone: '+94771234567', nic: '853400937V', country: 'LK', phone2: '', email: '' });
    });
    it('without remember nothing is filed and nothing is written', () => {
        const s = store({ people: [] });
        const rec = { id: 'd1', name: 'Nimal', personId: 'gone' };
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: false });
        expect(r.person).toBe(null);
        expect(rec.personId).toBeUndefined();                                  // a pointer to nobody is dropped
        expect(s.data.people).toEqual([]);
    });
    it('an unnamed record is never filed', () => {
        const s = store({ people: [] });
        const rec = { id: 'd1', name: '', phone: '+94771234567' };
        expect(linkRecord({ store: s, kind: 'debtor', rec, remember: true }).person).toBe(null);
        expect(s.data.people).toEqual([]);
    });
    it('the same NIC on a new loan finds the person and keeps their saved name', () => {
        const s = store({ people: [{ id: 'p9', name: 'Nimal Perera', phone: '+94771234567', country: 'LK', nic: '853400937V' }], debtors: [], income: [] });
        const rec = { id: 'd2', name: 'N Perera', phone: '', nic: '853400937V' };
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: true, country: 'LK', now: NOW, newId: nid() });
        expect(r.matched).toBe(true);
        expect(r.created).toBe(false);
        expect(rec.personId).toBe('p9');
        expect(rec.name).toBe('Nimal Perera');                                // the second spelling does not rename anyone
        expect(s.data.people).toHaveLength(1);
    });
    it('a number typed on the new form replaces the saved one and the person\'s other records follow', () => {
        const s = store({
            people: [{ id: 'p9', name: 'Nimal', phone: '+94771234567', country: 'LK', nic: '853400937V' }],
            debtors: [{ id: 'd1', name: 'Nimal', phone: '+94771234567', nic: '853400937V', personId: 'p9', sms_notifications_enabled: true }],
            income: [],
        });
        const rec = { id: 'd2', name: 'Nimal', phone: '+94779999999', nic: '853400937V' };
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: true, country: 'LK', now: NOW, newId: nid() });
        expect(r.updated).toBe(true);
        expect(r.siblings).toEqual({ loans: 1, investments: 0, smsOn: 1 });
        expect(s.data.people[0].phone).toBe('+94779999999');
        expect(s.data.debtors[0].phone).toBe('+94779999999');
        expect(rec.phone).toBe('+94779999999');
    });
    it('what the new form left blank is filled in from the person', () => {
        const s = store({ people: [{ id: 'p9', name: 'Nimal', phone: '+94771234567', country: 'LK', nic: '853400937V' }], debtors: [], income: [] });
        const rec = { id: 'd2', name: 'Nimal', phone: '+94771234567', nic: '' };
        // the same number under the same name is the same person even with no NIC on the form
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: true, country: 'LK', now: NOW, newId: nid() });
        expect(r.matched).toBe(true);
        expect(rec.nic).toBe('853400937V');
    });
    it('an already-linked record: the form is the latest word and everybody linked follows', () => {
        const s = store({
            people: [{ id: 'p9', name: 'Nimal', phone: '+94771234567', country: 'LK', nic: '' }],
            debtors: [
                { id: 'd1', name: 'Nimal', phone: '+94771234567', nic: '', personId: 'p9' },
                { id: 'd2', name: 'Nimal', phone: '+94771234567', nic: '', personId: 'p9', sms_notifications_enabled: true },
            ],
            income: [{ id: 'i1', company: 'Nimal', name: 'Loan from Nimal', phone: '+94771234567', nic: '', personId: 'p9' }],
        });
        const rec = { id: 'd1', name: 'Nimal Perera', phone: '+94770000000', nic: '853400937V', personId: 'p9' };
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: false, country: 'LK', now: NOW, newId: nid() });
        expect(r.updated).toBe(true);
        expect(r.siblings).toEqual({ loans: 1, investments: 1, smsOn: 1 });
        expect(s.data.people[0]).toMatchObject({ name: 'Nimal Perera', phone: '+94770000000', nic: '853400937V' });
        expect(s.data.debtors.find((d) => d.id === 'd2')).toMatchObject({ name: 'Nimal Perera', phone: '+94770000000', nic: '853400937V' });
        expect(s.data.income[0]).toMatchObject({ company: 'Nimal Perera', phone: '+94770000000', name: 'Loan from Nimal' });   // the investment's own name is its own
        expect(s.data.debtors.find((d) => d.id === 'd1').phone).toBe('+94771234567');                                          // the record being saved is its caller's to write
    });
    it('an already-linked record that changed nothing writes nothing', () => {
        const s = store({ people: [{ id: 'p9', name: 'Nimal', phone: '+94771234567', country: 'LK', nic: '' }], debtors: [], income: [] });
        const before = s.data.people;
        const rec = { id: 'd1', name: 'Nimal', phone: '+94771234567', nic: '', personId: 'p9' };
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: true, country: 'LK' });
        expect(r.updated).toBe(false);
        expect(s.data.people).toBe(before);
    });
    it('the book has a limit and a full book files nobody rather than throwing', () => {
        const people = Array.from({ length: LIMITS.people }, (_, i) => ({ id: 'x' + i, name: 'P' + i, phone: '', nic: '' }));
        const s = store({ people, debtors: [] });
        const rec = { id: 'd1', name: 'Brand New', phone: '', nic: '' };
        expect(linkRecord({ store: s, kind: 'debtor', rec, remember: true }).person).toBe(null);
        expect(s.data.people).toHaveLength(LIMITS.people);
    });
    it('no store, no record: nothing happens', () => {
        expect(linkRecord({ store: null, kind: 'debtor', rec: {} }).person).toBe(null);
        expect(linkRecord({ store: store(), kind: 'debtor', rec: null }).person).toBe(null);
    });
});

describe('propagate', () => {
    it('writes a ledger only when something in it changed', () => {
        const debtors = [{ id: 'd1', name: 'A', phone: '1', nic: '', personId: 'p' }, { id: 'd2', name: 'B', phone: '1', nic: '', personId: 'other' }];
        const s = store({ debtors, income: [] });
        const out = propagate(s, 'p', { name: 'A', phone: '1', nic: '' }, { name: 'A', phone: '1', nic: '' });
        expect(out).toEqual({ loans: 0, investments: 0, smsOn: 0 });
        expect(s.data.debtors).toBe(debtors);
        const out2 = propagate(s, 'p', { name: 'A', phone: '1', nic: '' }, { name: 'A', phone: '2', nic: '' });
        expect(out2.loans).toBe(1);
        expect(s.data.debtors[0].phone).toBe('2');
        expect(s.data.debtors[1]).toBe(debtors[1]);                            // an untouched record is the same object
        expect(s.data.income).toEqual([]);
    });
});

describe('editing, adding and deleting in the book', () => {
    const base = () => store({
        people: [{ id: 'p1', name: 'Nimal', phone: '+94771234567', phone2: '', country: 'LK', nic: '', email: '', address: '', note: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
        debtors: [{ id: 'd1', name: 'Nimal', phone: '+94771234567', nic: '', personId: 'p1', sms_notifications_enabled: true }],
        income: [],
    });
    it('an edit validates, saves, stamps and brings the linked records along', () => {
        const s = base();
        const r = updatePerson(s, 'p1', { name: 'Nimal Perera', phone: '077 000 1111', country: 'LK', nic: '853400937V' }, { now: NOW });
        expect(r.ok).toBe(true);
        expect(r.siblings).toEqual({ loans: 1, investments: 0, smsOn: 1 });
        expect(s.data.people[0]).toMatchObject({ id: 'p1', name: 'Nimal Perera', phone: '+94770001111', nic: '853400937V', createdAt: '2026-01-01T00:00:00.000Z' });
        expect(s.data.people[0].updatedAt).toBe(new Date(NOW).toISOString());
        expect(s.data.debtors[0]).toMatchObject({ name: 'Nimal Perera', phone: '+94770001111', nic: '853400937V' });
    });
    it('a refused edit changes nothing', () => {
        const s = base();
        const before = JSON.stringify(s.data);
        const r = updatePerson(s, 'p1', { name: 'Nimal', phone: '12' });
        expect(r.ok).toBe(false);
        expect(r.errors.phone).toBeTruthy();
        expect(JSON.stringify(s.data)).toBe(before);
        expect(updatePerson(s, 'nobody', { name: 'x' }).ok).toBe(false);
    });
    it('the confirmation knows what an edit would touch, and nothing when only a note changes', () => {
        const s = base();
        expect(previewUpdate(s, 'p1', { name: 'Nimal', phone: '077 000 1111' })).toEqual({ loans: 1, investments: 0, smsOn: 1 });
        expect(previewUpdate(s, 'p1', { name: 'Nimal', phone: '077 123 4567', note: 'hello' })).toEqual({ loans: 0, investments: 0, smsOn: 0 });
        expect(previewUpdate(s, 'p1', { name: '' })).toEqual({ loans: 0, investments: 0, smsOn: 0 });
    });
    it('adding refuses a duplicate and says who it already is', () => {
        const s = base();
        const r = addPerson(s, { name: 'nimal', phone: '077 123 4567' });
        expect(r.ok).toBe(false);
        expect(r.duplicate.id).toBe('p1');
        expect(r.errors.name).toMatch(/already/);
        const ok = addPerson(s, { name: 'Kamal', phone: '071 111 1111' }, { now: NOW, newId: () => 'p2' });
        expect(ok.ok).toBe(true);
        expect(s.data.people.map((p) => p.id)).toEqual(['p1', 'p2']);
    });
    it('deleting removes the person and touches no loan', () => {
        const s = base();
        const loans = s.data.debtors;
        expect(removePerson(s, 'p1')).toBe(true);
        expect(s.data.people).toEqual([]);
        expect(s.data.debtors).toBe(loans);
        expect(s.data.debtors[0].personId).toBe('p1');                        // the loan keeps its copy and its (now dangling) pointer
        expect(removePerson(s, 'p1')).toBe(false);
    });
    it('a damaged entry in the book is skipped, never thrown on', () => {
        const s = store({ people: [null, 5, { id: 'x' }, { name: 'no id' }, { id: 'ok', name: 'Fine' }] });
        expect(listPeople(s).map((p) => p.id)).toEqual(['ok']);
        expect(listPeople(null)).toEqual([]);
        expect(listPeople(store({ people: 'nope' }))).toEqual([]);
    });
    it('newPerson stamps both times and never repeats an id', () => {
        const a = newPerson({ name: 'A' }, { now: NOW });
        const b = newPerson({ name: 'B' }, { now: NOW });
        expect(a.id).not.toBe(b.id);
        expect(a.createdAt).toBe(new Date(NOW).toISOString());
        expect(personById([a, b], b.id)).toBe(b);
        expect(personById([a], '')).toBe(null);
    });
});

describe('contacts from the phone', () => {
    const win = (select) => ({ navigator: { contacts: { select } }, ContactsManager: function ContactsManager() {} });
    it('knows whether the browser can open contacts', () => {
        expect(contactPickerSupported(win(async () => []))).toBe(true);
        expect(contactPickerSupported({ navigator: {} })).toBe(false);
        expect(contactPickerSupported(null)).toBe(false);
        expect(contactPickerSupported({ navigator: { contacts: { select() {} } } })).toBe(false);   // no ContactsManager: not Chrome's picker
    });
    it('returns names and numbers, dropping the empty and the repeated', async () => {
        const w = win(async () => [{ name: ['Nimal Perera'], tel: ['077 123 4567', '077 123 4567', ' '] }, { name: [], tel: [] }, { name: [], tel: ['+44 7911 123456'] }]);
        const got = await pickContacts(w, { multiple: true });
        expect(got).toEqual([{ name: 'Nimal Perera', tels: ['077 123 4567'] }, { name: '', tels: ['+44 7911 123456'] }]);
    });
    it('closing the chooser is not an error', async () => {
        const w = win(async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; });
        expect(await pickContacts(w)).toEqual([]);
    });
    it('anything else says something a person can act on', async () => {
        const denied = win(async () => { const e = new Error('x'); e.name = 'SecurityError'; throw e; });
        await expect(pickContacts(denied)).rejects.toMatchObject({ userMessage: expect.stringMatching(/tap/i) });
        await expect(pickContacts({ navigator: {} })).rejects.toMatchObject({ userMessage: expect.stringMatching(/contacts file|import/i) });
    });
    it('turns a contact into a name and numbers a form can use, keeping what it cannot', () => {
        const d = draftFromContact({ name: 'Nimal Perera', tels: ['077 123 4567', '+44 7911 123456', '0112345678', '077 123 4567'] }, 'LK');
        expect(d.name).toBe('Nimal Perera');
        expect(d.numbers.map((n) => n.e164)).toEqual(['+94771234567']);
        expect(d.others).toEqual([{ raw: '+44 7911 123456', reason: 'not-sri-lanka' }, { raw: '0112345678', reason: 'not-a-mobile-number' }]);
        expect(draftFromContact(null)).toEqual({ name: '', numbers: [], others: [] });
    });
});

describe('a vCard file from any phone', () => {
    it('reads the plain shape', () => {
        const v = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Nimal Perera\r\nN:Perera;Nimal;;;\r\nTEL;TYPE=CELL:+94 77 123 4567\r\nTEL;TYPE=HOME:011 234 5678\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Kamal\r\nTEL:0711111111\r\nEND:VCARD\r\n';
        expect(parseVCards(v)).toEqual([
            { name: 'Nimal Perera', tels: ['+94 77 123 4567', '011 234 5678'] },
            { name: 'Kamal', tels: ['0711111111'] },
        ]);
    });
    it('builds a name from N when there is no FN', () => {
        expect(parseVCards('BEGIN:VCARD\nN:Perera;Nimal;K.;Mr.;\nTEL:0771234567\nEND:VCARD')[0].name).toBe('Mr. Nimal K. Perera');
    });
    it('unfolds long lines and reads item-grouped properties', () => {
        const v = 'BEGIN:VCARD\nFN:Very Long\n  Name Here\nitem1.TEL;type=pref:+1 415 555 2671\nitem1.X-ABLabel:mobile\nEND:VCARD';
        const [c] = parseVCards(v);
        expect(c.name).toBe('Very Long Name Here');
        expect(c.tels).toEqual(['+1 415 555 2671']);
    });
    it('decodes quoted-printable names (Android writes Sinhala and Tamil this way), including soft line breaks', () => {
        // "නිමල්" in UTF-8, quoted-printable, split over two lines with a soft break
        const bytes = Array.from(new TextEncoder().encode('නිමල්'));
        const qp = bytes.map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
        const first = qp.slice(0, 12);
        const rest = qp.slice(12);
        const v = 'BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:' + first + '=\n' + rest + '\nTEL;CELL:0771234567\nEND:VCARD';
        expect(parseVCards(v)[0]).toEqual({ name: 'නිමල්', tels: ['0771234567'] });
    });
    it('skips a card with neither a name nor a number, and ignores text outside cards', () => {
        const v = 'garbage\nBEGIN:VCARD\nORG:Nobody\nEND:VCARD\nTEL:0771234567\nBEGIN:VCARD\nFN:Real\nEND:VCARD';
        expect(parseVCards(v)).toEqual([{ name: 'Real', tels: [] }]);
    });
    it('strips a tel: prefix and a byte-order mark, and de-duplicates numbers', () => {
        const v = '﻿BEGIN:VCARD\nFN:A\nTEL:tel:+94771234567\nTEL:+94771234567\nEND:VCARD';
        expect(parseVCards(v)).toEqual([{ name: 'A', tels: ['+94771234567'] }]);
    });
    it('is bounded: an enormous file does not become an enormous list', () => {
        const one = 'BEGIN:VCARD\nFN:X\nTEL:0771234567\nEND:VCARD\n';
        expect(parseVCards(one.repeat(LIMITS.vcfCards + 50))).toHaveLength(LIMITS.vcfCards);
        expect(parseVCards('')).toEqual([]);
        expect(parseVCards(null)).toEqual([]);
    });
});

describe('the default export carries the same names', () => {
    it('is the module', () => {
        expect(P.PEOPLE_KEY).toBe(PEOPLE_KEY);
        expect(P.SHARED).toEqual(SHARED);
        expect(SHARED).toEqual(['name', 'fullName', 'phone', 'phone2', 'nic']);
        expect(typeof P.linkRecord).toBe('function');
    });
});

describe('what a form changed about its person', () => {
    const person = { id: 'p1', name: 'Nimal Perera', phone: '+94771234567', nic: '853400937V' };
    it('lists the shared fields the form disagrees about, and never a blank name', () => {
        expect(sharedDiff('debtor', { name: 'Nimal Perera', phone: '+94771234567', nic: '853400937V' }, person)).toEqual([]);
        expect(sharedDiff('debtor', { name: 'Nimal P', phone: '+94771234567', nic: '853400937V' }, person)).toEqual(['name']);
        expect(sharedDiff('debtor', { name: '', phone: '+94770000000', nic: '' }, person)).toEqual(['phone', 'nic']);
        expect(sharedDiff('investment', { company: 'Nimal Perera', phone: '+94771234567', nic: '853400937V', name: 'Loan from Nimal' }, person)).toEqual([]);
    });
    it('"and N others" leaves out the record being saved', () => {
        const books = { debtors: [{ id: 'd1', personId: 'p1' }, { id: 'd2', personId: 'p1', sms_notifications_enabled: true }], income: [{ id: 'i1', personId: 'p1' }] };
        expect(usageOf(person, books)).toEqual({ loans: 2, investments: 1, smsOn: 1 });
        expect(usageOf(person, books, 'd1')).toEqual({ loans: 1, investments: 1, smsOn: 1 });
        expect(usageOf(person, books, 'd2')).toEqual({ loans: 1, investments: 1, smsOn: 0 });
    });
    it('booksOf reads both ledgers and survives a store with nothing in it', () => {
        expect(booksOf(store({ debtors: [1], income: [2] }))).toEqual({ debtors: [1], income: [2] });
        expect(booksOf(store())).toEqual({ debtors: [], income: [] });
        expect(booksOf(null)).toEqual({ debtors: [], income: [] });
    });
});

describe('filing the people the ledgers already name', () => {
    const books = () => store({
        people: [{ id: 'p0', name: 'Kamal Silva', phone: '+94711111111', country: 'LK', nic: '' }],
        debtors: [
            { id: 'd1', name: 'Nimal Perera', phone: '077 123 4567', nic: '853400937V' },
            { id: 'd2', name: 'nimal  perera', phone: '', nic: '198534000937' },          // the same NIC in its other shape
            { id: 'd3', name: 'Kamal Silva', phone: '071 111 1111', nic: '' },            // already in the book by number + name
            { id: 'd4', name: 'Sunil', phone: '', nic: '' },
            { id: 'd5', name: 'Sunil', phone: '', nic: '' },                              // two loans, one nameless-detail person
            { id: 'd6', name: '', phone: '0770000000' },                                  // no name: nothing to file
            { id: 'd7', name: 'Linked', personId: 'p0' },                                 // already linked to a person that exists
        ],
        income: [
            { id: 'i1', name: 'Fixed deposit', company: 'Commercial Bank' },              // named, nothing else: still somebody the owner may want to pick again
            { id: 'i2', name: 'Loan from Ahmed', company: 'Ahmed Khan', phone: '+971501234567', nic: 'ID:X1234567' },
            { id: 'i3', name: 'Loan from Dilan', company: 'Dilan', sms_notifications_enabled: true },
        ],
    });
    it('finds who is not filed: anybody named on a loan or on an investment, whether or not they have a number, an ID or texts on', () => {
        const un = unfiledRecords(books());
        expect(un.map((u) => u.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'i1', 'i2', 'i3']);
        expect(un.find((u) => u.id === 'i2')).toMatchObject({ kind: 'investment', name: 'Ahmed Khan', key: 'income' });
    });
    it('files them once each, links the records, and touches nothing else on a ledger', () => {
        const s = books();
        const out = harvestPeople(s, { now: NOW, newId: counter() });
        expect(out).toEqual({ added: 5, linked: 8 });                                     // Nimal, Sunil, Commercial Bank, Ahmed, Dilan; Kamal was already there
        expect(s.data.people.map((p) => p.name)).toEqual(['Kamal Silva', 'Nimal Perera', 'Sunil', 'Commercial Bank', 'Ahmed Khan', 'Dilan']);
        const ids = Object.fromEntries(s.data.people.map((p) => [p.name, p.id]));
        expect(s.data.debtors.find((d) => d.id === 'd1').personId).toBe(ids['Nimal Perera']);
        expect(s.data.debtors.find((d) => d.id === 'd2').personId).toBe(ids['Nimal Perera']);
        expect(s.data.debtors.find((d) => d.id === 'd3').personId).toBe('p0');
        expect(s.data.debtors.find((d) => d.id === 'd4').personId).toBe(ids.Sunil);
        expect(s.data.debtors.find((d) => d.id === 'd5').personId).toBe(ids.Sunil);
        expect(s.data.debtors.find((d) => d.id === 'd6').personId).toBeUndefined();
        expect(s.data.income.find((i) => i.id === 'i1').personId).toBe(ids['Commercial Bank']);
        expect(s.data.income.find((i) => i.id === 'i2').personId).toBe(ids['Ahmed Khan']);
        // a record keeps every other field exactly
        expect(s.data.debtors.find((d) => d.id === 'd1')).toMatchObject({ name: 'Nimal Perera', phone: '077 123 4567', nic: '853400937V' });
        // the person is made from the first record that names them, with a country read from the number
        expect(s.data.people.find((p) => p.name === 'Ahmed Khan')).toMatchObject({ country: 'LK', nic: 'ID:X1234567', phone: '+971501234567' });          // an old number abroad is kept as it was, not rewritten
    });
    it('a second run finds nobody and writes nothing', () => {
        const s = books();
        harvestPeople(s, { now: NOW, newId: counter() });
        const snapshot = JSON.stringify(s.data);
        expect(harvestPeople(s, { now: NOW, newId: counter() })).toEqual({ added: 0, linked: 0 });
        expect(JSON.stringify(s.data)).toBe(snapshot);
    });
    it('stops filing new people at the limit', () => {
        const people = Array.from({ length: LIMITS.people }, (_, i) => ({ id: 'x' + i, name: 'P' + i, phone: '', nic: '' }));
        const s = store({ people, debtors: [{ id: 'd1', name: 'Brand New' }], income: [] });
        expect(harvestPeople(s, { now: NOW, newId: counter() })).toEqual({ added: 0, linked: 0 });
        expect(s.data.people).toHaveLength(LIMITS.people);
    });
});


describe('investors are people too: filed on their own, and found again', () => {
    const nid = () => counter();
    it('a new investment that names somebody (and nothing else) files them and links the record', () => {
        const s = store({ people: [], debtors: [], income: [] });
        const rec = { id: 'i1', name: 'Fixed deposit', company: 'Harsha Aiya', phone: '', nic: '' };
        const r = linkRecord({ store: s, kind: 'investment', rec, remember: true, country: 'LK', now: NOW, newId: nid() });
        expect(r.created).toBe(true);
        expect(rec[LINK_FIELD]).toBe('p1');
        expect(s.data.people[0]).toMatchObject({ name: 'Harsha Aiya', phone: '', nic: '' });
    });

    it('somebody typed by name only is the person already saved under that name, not a second one', () => {
        const s = store({
            people: [{ id: 'p9', name: 'Harsha Aiya', phone: '+94771234567', country: 'LK', nic: '853400937V' }],
            debtors: [{ id: 'd1', name: 'Harsha Aiya', phone: '+94771234567', nic: '853400937V', personId: 'p9' }], income: [],
        });
        const rec = { id: 'i1', name: 'Fixed deposit', company: 'harsha  aiya', phone: '', nic: '' };
        const r = linkRecord({ store: s, kind: 'investment', rec, remember: true, country: 'LK', now: NOW, newId: nid() });
        expect(r.matched).toBe(true);
        expect(s.data.people).toHaveLength(1);
        expect(rec[LINK_FIELD]).toBe('p9');
        // what the form left blank comes from the person, so a text can reach them and the record is in step
        expect(rec).toMatchObject({ company: 'Harsha Aiya', phone: '+94771234567', nic: '853400937V' });
    });

    it('two saved people with the same name are not guessed between: a new one is filed instead', () => {
        const s = store({
            people: [{ id: 'a', name: 'Nimal', phone: '+94771111111', country: 'LK', nic: '' }, { id: 'b', name: 'Nimal', phone: '+94772222222', country: 'LK', nic: '' }],
            debtors: [], income: [],
        });
        const rec = { id: 'i1', company: 'Nimal', name: 'FD', phone: '', nic: '' };
        const r = linkRecord({ store: s, kind: 'investment', rec, remember: true, country: 'LK', now: NOW, newId: nid() });
        expect(r.created).toBe(true);
        expect(s.data.people).toHaveLength(3);
    });

    it('a name typed WITH a different number is a different person, even when the name is the same', () => {
        const s = store({ people: [{ id: 'a', name: 'Nimal', phone: '+94771111111', country: 'LK', nic: '' }], debtors: [], income: [] });
        const rec = { id: 'i1', company: 'Nimal', name: 'FD', phone: '+94779999999', nic: '' };
        const r = linkRecord({ store: s, kind: 'investment', rec, remember: true, country: 'LK', now: NOW, newId: nid() });
        expect(r.created).toBe(true);
        expect(rec[LINK_FIELD]).not.toBe('a');
    });

    it('filing the existing ledgers links a name-only record to the one person who has that name, and fills what the record lacked', () => {
        const s = store({
            people: [{ id: 'p9', name: 'Harsha Aiya', phone: '+94771234567', country: 'LK', nic: '853400937V' }],
            debtors: [{ id: 'd1', name: 'Harsha Aiya', phone: '+94771234567', nic: '853400937V', personId: 'p9' }],
            income: [{ id: 'i1', name: 'FD', company: 'Harsha Aiya', phone: '', nic: '' }],
        });
        expect(harvestPeople(s, { now: NOW, newId: counter() })).toEqual({ added: 0, linked: 1 });
        expect(s.data.income[0]).toMatchObject({ personId: 'p9', company: 'Harsha Aiya', phone: '+94771234567', nic: '853400937V', name: 'FD' });
        expect(s.data.people).toHaveLength(1);
    });

    it('filing never overwrites a number the record already has', () => {
        const s = store({
            people: [{ id: 'p9', name: 'Harsha Aiya', phone: '+94771234567', country: 'LK', nic: '' }], debtors: [],
            income: [{ id: 'i1', name: 'FD', company: 'Harsha Aiya', phone: '+94779999999', nic: '' }],
        });
        harvestPeople(s, { now: NOW, newId: counter() });
        expect(s.data.income[0].phone).toBe('+94779999999');
        expect(s.data.income[0].personId).not.toBe('p9');          // a different number under the same name: somebody else
        expect(s.data.people).toHaveLength(2);
    });

    it('two devices that each file the same ledger arrive at the same people, so the cloud merge does not double them', () => {
        const ledgers = () => ({
            debtors: [{ id: 'd1', name: 'Nimal Perera', phone: '077 123 4567', nic: '853400937V' }, { id: 'd2', name: 'Sunil', phone: '', nic: '' }],
            income: [{ id: 'i1', name: 'FD', company: 'Harsha Aiya', phone: '', nic: '' }, { id: 'i2', name: 'FD 2', company: 'harsha aiya', phone: '', nic: '' }],
        });
        const a = store({ people: [], ...ledgers() });
        const b = store({ people: [], ...ledgers() });
        harvestPeople(a, { now: NOW });                    // default ids: derived from who the person is, not from a counter or the clock
        harvestPeople(b, { now: NOW + 5000 });
        expect(a.data.people.map((p) => p.id).sort()).toEqual(b.data.people.map((p) => p.id).sort());
        expect(new Set(a.data.people.map((p) => p.id)).size).toBe(3);
    });
});

describe('editing a person reaches every record that carries them', () => {
    const books = () => store({
        people: [{ id: 'p1', name: 'Harsha Aiya', phone: '+94771234567', phone2: '', country: 'LK', nic: '853400937V', email: '', address: '', note: '' }],
        debtors: [{ id: 'd1', name: 'Harsha Aiya', phone: '+94771234567', nic: '853400937V', personId: 'p1', sms_notifications_enabled: true }],
        income: [
            { id: 'i1', name: 'FD 1', company: 'Harsha Aiya', phone: '+94771234567', nic: '853400937V', personId: 'p1' },
            { id: 'i2', name: 'FD 2', company: 'Harsha Aiya', phone: '', nic: '', personId: 'p1' },                  // linked, but carries nothing of its own: stale
        ],
    });
    it('a new number, a new name and a corrected ID land on the loan and on every investment', () => {
        const s = books();
        const r = updatePerson(s, 'p1', { name: 'Harsha Aiya Perera', phone: '071 555 6666', country: 'LK', nic: '198534000937' }, { now: NOW });
        expect(r.ok).toBe(true);
        expect(s.data.debtors[0]).toMatchObject({ name: 'Harsha Aiya Perera', phone: '+94715556666', nic: '198534000937' });
        for (const i of s.data.income) expect(i).toMatchObject({ company: 'Harsha Aiya Perera', phone: '+94715556666', nic: '198534000937' });
        expect(s.data.income.map((i) => i.name)).toEqual(['FD 1', 'FD 2']);          // an investment's own name is its own
        expect(r.siblings).toEqual({ loans: 1, investments: 2, smsOn: 1 });
    });
    it('saving the person for another reason (a note) also repairs a linked record that had fallen out of step', () => {
        const s = books();
        const r = updatePerson(s, 'p1', { name: 'Harsha Aiya', phone: '+94771234567', country: 'LK', nic: '853400937V', note: 'family' }, { now: NOW });
        expect(r.ok).toBe(true);
        expect(s.data.income[1]).toMatchObject({ phone: '+94771234567', nic: '853400937V' });
        expect(r.siblings.investments).toBe(1);
    });
    it('a record that is already in step is the same object afterwards, and its ledger is not written', () => {
        const s = store({
            people: [{ id: 'p1', name: 'A', phone: '+94771234567', phone2: '', country: 'LK', nic: '', email: '', address: '', note: '' }],
            debtors: [{ id: 'd1', name: 'A', phone: '+94771234567', nic: '', personId: 'p1' }], income: [],
        });
        const before = s.data.debtors;
        updatePerson(s, 'p1', { name: 'A', phone: '+94771234567', country: 'LK', note: 'x' }, { now: NOW });
        expect(s.data.debtors).toBe(before);
    });
    it('a form saved for a linked record that was never given a number does not erase the person\'s number everywhere', () => {
        const s = books();
        // the form opens on the record's own (empty) number: the person's number is shown instead, so saving it back changes nothing
        const rec = { id: 'i2', name: 'FD 2', company: 'Harsha Aiya', phone: '+94771234567', nic: '853400937V', personId: 'p1' };
        const r = linkRecord({ store: s, kind: 'investment', rec, remember: true, country: 'LK', now: NOW });
        expect(r.updated).toBe(false);
        expect(s.data.people[0].phone).toBe('+94771234567');
        expect(s.data.debtors[0].phone).toBe('+94771234567');
    });
});


describe('bringing a contact in from anywhere: a file, a spreadsheet export, or text copied from a contacts app', () => {
    const numbers = (cards) => cards.map((c) => [c.name, ...c.tels]);

    describe('a Google Contacts export (CSV)', () => {
        const csv = [
            'First Name,Middle Name,Last Name,Phonetic First Name,Notes,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value',
            'Nimal,,Perera,,,Mobile,+94 77 123 4567,Home,0112 345 678',
            'Kamal,,Silva,,,Mobile,071 111 1111 ::: +44 7911 123456,,',
            ',,,,,Mobile,0779998888,,',
            '"Silva, Dr.",,,,"likes, commas",Mobile,"+971 50 123 4567",,',
        ].join('\n');
        it('reads names and every number, however the export separates several in one cell', () => {
            expect(numbers(parseContactsCsv(csv))).toEqual([
                ['Nimal Perera', '+94 77 123 4567', '0112 345 678'],
                ['Kamal Silva', '071 111 1111', '+44 7911 123456'],
                ['', '0779998888'],
                ['Silva, Dr.', '+971 50 123 4567'],
            ]);
        });
        it('is recognised without being told', () => {
            expect(parseContacts(csv, 'contacts.csv').kind).toBe('csv');
            expect(parseContacts(csv, '').kind).toBe('csv');
        });
    });

    describe('an Outlook export (CSV)', () => {
        const csv = 'First Name,Last Name,Home Phone,Mobile Phone,Business Fax,Business Phone\r\nAhmed,Khan,,+971501234567,+97144444444,\r\n';
        it('reads the phone columns and not the fax', () => {
            expect(numbers(parseContactsCsv(csv))).toEqual([['Ahmed Khan', '+971501234567']].map((r) => r));
        });
    });

    describe('other spreadsheets', () => {
        it('semicolons (a Sri Lankan Excel writes them) and tabs separate columns the same way', () => {
            expect(numbers(parseContactsCsv('Name;Mobile\nNimal;0771234567\nKamal;0711111111'))).toEqual([['Nimal', '0771234567'], ['Kamal', '0711111111']]);
            expect(numbers(parseContactsCsv('Name\tPhone\nNimal\t0771234567'))).toEqual([['Nimal', '0771234567']]);
        });
        it('a byte-order mark, a quoted newline and doubled quotes do not break a row', () => {
            const csv = '﻿Name,Phone\n"Nimal ""Nim"" Perera",0771234567\n"A\nB",0711111111\n';
            expect(numbers(parseContactsCsv(csv))).toEqual([['Nimal "Nim" Perera', '0771234567'], ['A B', '0711111111']]);
        });
        it('a row with no number is skipped, and a file that is not a contacts sheet gives nothing', () => {
            expect(parseContactsCsv('Name,Phone\nNimal,\nKamal,0711111111')).toHaveLength(1);
            expect(parseContactsCsv('Date,Amount\n2026-10-05,1500')).toEqual([]);
            expect(parseContactsCsv('')).toEqual([]);
        });
    });

    describe('text copied out of a contacts app, a chat, or a page', () => {
        it('a bare number', () => {
            expect(numbers(parseContactsText('+94 77 123 4567'))).toEqual([['', '+94 77 123 4567']]);
            expect(numbers(parseContactsText('  0771234567\n'))).toEqual([['', '0771234567']]);
            expect(numbers(parseContactsText('tel:+94771234567'))).toEqual([['', '+94771234567']]);
        });
        it('a name beside the number, either way round', () => {
            expect(numbers(parseContactsText('Nimal Perera: 077 123 4567'))).toEqual([['Nimal Perera', '077 123 4567']]);
            expect(numbers(parseContactsText('Nimal Perera - +94771234567'))).toEqual([['Nimal Perera', '+94771234567']]);
            expect(numbers(parseContactsText('0771234567 Nimal Perera'))).toEqual([['Nimal Perera', '0771234567']]);
        });
        it('a contact card laid out on separate lines, with the label lines a phone adds', () => {
            const card = 'Nimal Perera\nmobile\n+94 77 123 4567\nhome\n+94 11 234 5678\nnimal@example.com';
            expect(numbers(parseContactsText(card))).toEqual([['Nimal Perera', '+94 77 123 4567', '+94 11 234 5678']]);
        });
        it('several people, one per line, and the same name twice is one person with two numbers', () => {
            const text = 'Nimal 0771234567\nKamal 0711111111\nNimal 0779999999';
            expect(numbers(parseContactsText(text))).toEqual([['Nimal', '0771234567', '0779999999'], ['Kamal', '0711111111']]);
        });
        it('a date or an amount is not a phone number', () => {
            expect(parseContactsText('Paid 2026-10-05 an amount of 1,500.00')).toEqual([]);
            expect(parseContactsText('Meet on 05/10/2026')).toEqual([]);
        });
        it('digits in another script are still digits', () => {
            expect(numbers(parseContactsText('නිමල් ٠٧٧١٢٣٤٥٦٧'))).toEqual([['නිමල්', '٠٧٧١٢٣٤٥٦٧']]);
        });
        it('is bounded: a huge paste is read as far as the limit and no further', () => {
            const text = Array.from({ length: LIMITS.vcfCards + 50 }, (_, i) => `Person ${i} 07712345${String(i % 100).padStart(2, '0')}`).join('\n');
            expect(parseContactsText(text).length).toBeLessThanOrEqual(LIMITS.vcfCards);
        });
    });

    describe('parseContacts decides what it was given', () => {
        it('a vCard, by its content and not only by the file name', () => {
            const vcf = 'BEGIN:VCARD\nVERSION:3.0\nFN:Nimal Perera\nTEL;TYPE=CELL:+94 77 123 4567\nEND:VCARD';
            const r = parseContacts(vcf, 'whatever.txt');
            expect(r.kind).toBe('vcard');
            expect(numbers(r.cards)).toEqual([['Nimal Perera', '+94 77 123 4567']]);
        });
        it('plain text otherwise, and nothing for an empty or binary-looking paste', () => {
            expect(parseContacts('Nimal 0771234567', 'note.txt').kind).toBe('text');
            expect(parseContacts('', '')).toEqual({ kind: 'empty', cards: [] });
            expect(parseContacts('\u0000\u0001\u0002\u0003'.repeat(50), 'x.bin').cards).toEqual([]);
        });
    });

    describe('the device', () => {
        const nav = (userAgent, platform = '', maxTouchPoints = 0) => ({ navigator: { userAgent, platform, maxTouchPoints } });
        it('is recognised from what the browser says about itself', () => {
            expect(platformOf(nav('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36'))).toBe('android');
            expect(platformOf(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605 Safari/604', 'iPhone', 5))).toBe('ios');
            expect(platformOf(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Safari/605', 'MacIntel', 5))).toBe('ios');     // an iPad asking for the desktop site
            expect(platformOf(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126 Safari/537', 'MacIntel', 0))).toBe('mac');
            expect(platformOf(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126', 'Win32'))).toBe('windows');
            expect(platformOf(nav('Mozilla/5.0 (X11; Linux x86_64) Firefox/127', 'Linux x86_64'))).toBe('linux');
            expect(platformOf(nav('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/126', 'Linux x86_64'))).toBe('linux');
            expect(platformOf(null)).toBe('other');
            expect(platformOf({})).toBe('other');
        });
    });
});

describe('a person the owner deleted is not filed again behind their back', () => {
    const books = () => store({
        people: [],
        debtors: [{ id: 'd1', name: 'Nimal Perera', phone: '+94771234567', personId: 'gone' }, { id: 'd2', name: 'Kamal', phone: '' }],
        income: [{ id: 'i1', company: 'Commercial Bank', personId: 'also-gone' }],
    });

    it('the automatic pass leaves out records that point at nobody in the book, and still files the ones never filed', () => {
        const s = books();
        expect(unfiledRecords(s, { orphans: false }).map((u) => u.id)).toEqual(['d2']);
        const r = harvestPeople(s, { now: NOW, orphans: false });
        expect(r).toEqual({ added: 1, linked: 1 });
        expect(s.data.people.map((p) => p.name)).toEqual(['Kamal']);
        expect(s.data.debtors[0].personId).toBe('gone');                           // untouched: still an orphan
        expect(s.data.income[0].personId).toBe('also-gone');
    });

    it('the owner\'s own "file everybody" still takes them, because it was asked for', () => {
        const s = books();
        expect(unfiledRecords(s).map((u) => u.id).sort()).toEqual(['d1', 'd2', 'i1']);
        expect(harvestPeople(s, { now: NOW })).toEqual({ added: 3, linked: 3 });
        expect(s.data.people.map((p) => p.name).sort()).toEqual(['Commercial Bank', 'Kamal', 'Nimal Perera']);
    });

    it('a record that arrived before its person did is not given a second person by this device', () => {
        // two devices: the record syncs first, the people list a moment later
        const s = store({ people: [], debtors: [{ id: 'd1', name: 'Nimal Perera', phone: '+94771234567', personId: 'p-from-device-a' }], income: [] });
        expect(harvestPeople(s, { now: NOW, orphans: false })).toEqual({ added: 0, linked: 0 });
        expect(s.data.people).toEqual([]);
    });
});

describe('a second number for one person (optional, texted as well as the first)', () => {
    const LOAN = (over = {}) => ({ id: 'd1', name: 'Nimal Perera', phone: '+94771234567', nic: '', ...over });
    const person = (over = {}) => ({ id: 'p1', name: 'Nimal Perera', phone: '+94771234567', phone2: '', country: 'LK', nic: '', email: '', address: '', note: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over });

    it('is read the way the first one is: a Sri Lankan mobile number, saved in E.164', () => {
        expect(P.secondNumberOf('0712345678', 'LK')).toBe('+94712345678');
        expect(P.secondNumberOf('tel:+94 71 234 5678', 'LK')).toBe('+94712345678');
        expect(P.secondNumberOf('+44 7911 123456', 'LK')).toBe('');            // no text can reach another country
        expect(P.secondNumberOf('tel:+971 50 123 4567', 'LK')).toBe('');
        expect(P.secondNumberOf('', 'LK')).toBe('');
        expect(P.secondNumberOf(undefined, 'LK')).toBe('');
        expect(P.secondNumberOf('011 234 5678', 'LK')).toBe('');            // a landline cannot be texted
        expect(P.secondNumberOf('call me', 'LK')).toBe('');
    });

    it('the book saves a texted second number as E.164, keeps a landline as typed, and refuses the first number twice', () => {
        expect(cleanPerson({ name: 'A', phone: '0771234567', phone2: '071 234 5678', country: 'LK' }).fields.phone2).toBe('+94712345678');
        expect(cleanPerson({ name: 'A', phone: '0771234567', phone2: '‎+94 71 234 5678‎', country: 'LK' }).fields.phone2).toBe('+94712345678');
        const same = cleanPerson({ name: 'A', phone: '0771234567', phone2: '+94 77 123 4567', country: 'LK' });
        expect(same.ok).toBe(false);
        expect(same.errors.phone2).toMatch(/same as the first/);
        expect(same.fields.phone2).toBe('');
        expect(cleanPerson({ name: 'A', phone: '0771234567', phone2: '011 234 5678', country: 'LK' }).fields.phone2).toBe('011 234 5678');
        expect(cleanPerson({ name: 'A', phone2: 'abc' }).errors.phone2).toBeTruthy();
    });

    it('is one of the shared fields, so records keep it as they keep the number', () => {
        expect(SHARED).toContain('phone2');
        expect(readShared('debtor', LOAN({ phone2: ' +94712345678 ' })).phone2).toBe('+94712345678');
        expect(readShared('investment', { company: 'Nimal', phone2: '+94712345678' }).phone2).toBe('+94712345678');
        const rec = LOAN();
        expect(writeShared('debtor', rec, { phone2: '+94712345678' })).toBe(true);
        expect(rec.phone2).toBe('+94712345678');
        expect(writeShared('debtor', rec, { phone2: '+94712345678' })).toBe(false);
        expect(writeShared('debtor', LOAN(), { phone2: '' })).toBe(false);          // nothing there, nothing written
    });

    it('a second number typed on a new loan is saved with the person it files', () => {
        const s = store({ debtors: [], income: [], people: [] });
        const rec = LOAN({ phone2: '+94712345678' });
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: true, country: 'LK', now: NOW, newId: counter() });
        expect(r.created).toBe(true);
        expect(r.person.phone2).toBe('+94712345678');
    });

    it('a second number added on one loan reaches the person and their other loan and investment', () => {
        const s = store({
            people: [person()],
            debtors: [LOAN({ personId: 'p1' }), LOAN({ id: 'd2', personId: 'p1' })],
            income: [{ id: 'i1', company: 'Nimal Perera', phone: '+94771234567', personId: 'p1' }],
        });
        const rec = LOAN({ personId: 'p1', phone2: '+94712345678' });
        const r = linkRecord({ store: s, kind: 'debtor', rec, remember: true, country: 'LK', now: NOW });
        expect(r.updated).toBe(true);
        expect(s.data.people[0].phone2).toBe('+94712345678');
        expect(s.data.debtors[1].phone2).toBe('+94712345678');
        expect(s.data.income[0].phone2).toBe('+94712345678');
        expect(r.siblings.loans + r.siblings.investments).toBe(2);                  // the other loan and the investment: the saved record's own copy is its caller's to write
    });

    it('removing it on one record removes it everywhere', () => {
        const s = store({
            people: [person({ phone2: '+94712345678' })],
            debtors: [LOAN({ personId: 'p1', phone2: '+94712345678' }), LOAN({ id: 'd2', personId: 'p1', phone2: '+94712345678' })],
            income: [],
        });
        const rec = LOAN({ personId: 'p1', phone2: '' });
        linkRecord({ store: s, kind: 'debtor', rec, remember: true, country: 'LK', now: NOW });
        expect(s.data.people[0].phone2).toBe('');
        expect(s.data.debtors[1].phone2).toBe('');
    });

    it('a landline kept on the person is not copied onto records and is not lost when a record says nothing about a second number', () => {
        const s = store({ people: [person({ phone2: '011 234 5678' })], debtors: [LOAN({ personId: 'p1' }), LOAN({ id: 'd2', personId: 'p1' })], income: [] });
        const r = linkRecord({ store: s, kind: 'debtor', rec: LOAN({ personId: 'p1' }), remember: true, country: 'LK', now: NOW });
        expect(r.updated).toBe(false);
        expect(s.data.people[0].phone2).toBe('011 234 5678');
        expect(s.data.debtors[1].phone2).toBeUndefined();
    });

    it('editing the second number in the book reaches the records, and the confirmation counts them', () => {
        const s = store({ people: [person()], debtors: [LOAN({ personId: 'p1', sms_notifications_enabled: true })], income: [{ id: 'i1', company: 'Nimal Perera', phone: '+94771234567', personId: 'p1' }] });
        const input = { name: 'Nimal Perera', phone: '0771234567', phone2: '0712345678', country: 'LK', nic: '' };
        expect(previewUpdate(s, 'p1', input)).toEqual({ loans: 1, investments: 1, smsOn: 1 });
        const r = updatePerson(s, 'p1', input, { now: NOW });
        expect(r.ok).toBe(true);
        expect(s.data.debtors[0].phone2).toBe('+94712345678');
        expect(s.data.income[0].phone2).toBe('+94712345678');
        expect(previewUpdate(s, 'p1', input)).toEqual({ loans: 0, investments: 0, smsOn: 0 });   // nothing left to change
    });

    it('a record that has no second number is given the person\'s, but never the one it already has as its first', () => {
        const s = store({ people: [person({ phone2: '+94712345678' })], debtors: [LOAN({ personId: 'p1' }), LOAN({ id: 'd2', personId: 'p1', phone: '+94712345678' })], income: [] });
        propagate(s, 'p1', s.data.people[0], s.data.people[0]);
        expect(s.data.debtors[0].phone2).toBe('+94712345678');
        expect(s.data.debtors[1].phone2).toBeUndefined();
    });

    it('a second number written onto a record is stamped as new to it, and the stamp goes when the number does', () => {
        const rec = LOAN();
        expect(writeShared('debtor', rec, { phone2: '+94712345678' }, NOW)).toBe(true);
        expect(rec.phone2_at).toBe(NOW);
        expect(writeShared('debtor', rec, { phone2: '+94712345678' }, NOW + 5)).toBe(false);          // the same number again is not new
        expect(rec.phone2_at).toBe(NOW);
        expect(writeShared('debtor', rec, { phone2: '' }, NOW + 9)).toBe(true);
        expect(rec).not.toHaveProperty('phone2_at');
        const s = store({ people: [person()], debtors: [LOAN({ id: 'd2', personId: 'p1' })], income: [] });
        updatePerson(s, 'p1', { name: 'Nimal Perera', phone: '0771234567', phone2: '0712345678', country: 'LK', nic: '' }, { now: NOW });
        expect(s.data.debtors[0]).toMatchObject({ phone2: '+94712345678', phone2_at: NOW });
    });

    it('people filed from the ledgers bring their second number', () => {
        const s = store({ people: [], debtors: [LOAN({ phone2: '+94712345678' })], income: [] });
        harvestPeople(s, { now: NOW });
        expect(s.data.people[0].phone2).toBe('+94712345678');
    });
});

describe('recordMatches (the search box over the investments and the debtors)', () => {
    const loan = { id: 'd1', name: 'Nimal', fullName: 'Nimal Kumara Perera', phone: '+94771234567', phone2: '011 234 5678', nic: '853400937V' };
    const inv = { id: 'i1', name: 'Fixed deposit', company: 'Kamal', fullName: 'Kamal Silva', phone: '0712223344', nic: 'ID:P1234567' };
    it('an empty search matches everything', () => {
        expect(P.recordMatches(loan, '')).toBe(true);
        expect(P.recordMatches(loan, '   ')).toBe(true);
        expect(P.recordMatches(null, '')).toBe(true);
    });
    it('finds by the nickname, the full name, a part of either, in any case', () => {
        for (const q of ['nimal', 'NIM', 'kumara', 'perera nimal', 'Nimal Kumara']) expect(P.recordMatches(loan, q), q).toBe(true);
        expect(P.recordMatches(loan, 'kamal')).toBe(false);
    });
    it('an investment is found by the person (company), its title and the full name', () => {
        for (const q of ['kamal', 'fixed', 'silva', 'kamal silva']) expect(P.recordMatches(inv, q), q).toBe(true);
    });
    it('finds by the NIC, with or without the letter, and by a passport', () => {
        expect(P.recordMatches(loan, '853400937')).toBe(true);
        expect(P.recordMatches(loan, '853400937v')).toBe(true);
        expect(P.recordMatches(inv, 'p1234567')).toBe(true);
        expect(P.recordMatches(loan, '999999')).toBe(false);
    });
    it('finds by either number whichever way it is written, and never by one or two digits alone', () => {
        for (const q of ['0771234567', '+94771234567', '77 123', '771234567', '234 5678', '011234']) expect(P.recordMatches(loan, q), q).toBe(true);
        expect(P.recordMatches(inv, '071 222')).toBe(true);
        expect(P.recordMatches({ ...loan, nic: '' }, '77')).toBe(false);           // two digits are not a number: they match names and NICs only
        expect(P.recordMatches({ ...loan, nic: '' }, '07')).toBe(false);
        expect(P.recordMatches(loan, '5555555')).toBe(false);
    });
    it('a number is found as it is typed from the first digits, "077" and "+9477" included, and through the saved person', () => {
        for (const q of ['077', '0771', '+9477', '94771', '0094771']) expect(P.recordMatches(loan, q), q).toBe(true);
        expect(P.recordMatches(loan, '071')).toBe(false);
        expect(P.recordMatches({ id: 'd2', name: 'Sunil', personId: 'p1' }, '0771234567')).toBe(false);
        const person = { id: 'p1', name: 'Sunil', fullName: 'Sunil Jayasinghe', phone: '0712223344', phone2: '+94 77 765 4321', nic: '199012345678' };
        for (const q of ['0712223344', '071', '765 4321', 'jayasinghe', '199012345678', 'sunil 0771']) expect(P.recordMatches({ id: 'd2', name: 'Sunil', personId: 'p1' }, q, person), q).toBe(q === 'sunil 0771' ? false : true);
    });
    it('every word has to be found, and a note or an amount is not searched', () => {
        expect(P.recordMatches({ ...loan, note: 'secret', amount: 777 }, 'nimal 0771234567')).toBe(true);
        expect(P.recordMatches(loan, 'nimal kamal')).toBe(false);
        expect(P.recordMatches({ ...loan, note: 'secret', amount: 777 }, 'secret')).toBe(false);
        expect(P.recordMatches({ ...loan, note: 'secret', amount: 777 }, '777')).toBe(false);
    });
    it('search also finds a saved person by their full name', () => {
        const people = [{ id: 'p1', name: 'Nimal', fullName: 'Nimal Kumara Perera' }, { id: 'p2', name: 'Kamal' }];
        expect(P.searchPeople(people, 'kumara').map((p) => p.id)).toEqual(['p1']);
    });
});
