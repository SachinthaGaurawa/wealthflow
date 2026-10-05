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
    it('reads a number with its own country code whatever the box is set to', () => {
        expect(resolvePhone('+44 7911 123456', 'LK')).toMatchObject({ ok: true, e164: '+447911123456', iso: 'GB' });
        expect(resolvePhone('0044 7911 123456', 'LK').e164).toBe('+447911123456');
        expect(resolvePhone('+1 (415) 555-2671', 'LK')).toMatchObject({ ok: true, e164: '+14155552671' });
    });
    it('reads a bare number in the country the owner chose', () => {
        expect(resolvePhone('0501234567', 'AE')).toMatchObject({ ok: true, e164: '+971501234567', iso: 'AE' });
        expect(resolvePhone('07911 123456', 'GB')).toMatchObject({ ok: true, e164: '+447911123456' });
    });
    it('says nothing for an empty box, and a sentence for a wrong one', () => {
        expect(resolvePhone('', 'LK')).toMatchObject({ ok: false, empty: true, text: '' });
        const bad = resolvePhone('12', 'LK');
        expect(bad.ok).toBe(false);
        expect(bad.text.length).toBeGreaterThan(10);
        expect(resolvePhone('call me', 'LK').reason).toBe('not-a-number');
    });
    it('every reason the normaliser can give has words', () => {
        for (const reason of ['empty', 'not-a-number', 'misplaced-plus', 'needs-country-code', 'unknown-country-code', 'bad-length', 'not-a-mobile-number']) {
            expect(phoneProblem(reason), reason).not.toBe('That does not look like a phone number.');
        }
        expect(phoneProblem('something-new')).toBe('That does not look like a phone number.');
    });
    it('finds the region of a stored international number', () => {
        expect(isoOfPhone('+447911123456')).toBe('GB');
        expect(isoOfPhone('+94771234567')).toBe('LK');
        expect(isoOfPhone('077 123 4567')).toBe('LK');
        expect(isoOfPhone('0501234567', 'AE')).toBe('AE');
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
        const r = cleanPerson({ name: '  Nimal   Perera ', phone: '077 123 4567', phone2: '011 234 5678', country: 'lk', nic: '853400937v', email: 'nimal@example.com', address: ' 12 Temple Rd ', note: 'brother of Kamal' });
        expect(r.ok).toBe(true);
        expect(r.fields).toEqual({
            name: 'Nimal Perera', phone: '+94771234567', phone2: '011 234 5678', country: 'LK', nic: '853400937V',
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
    it('accepts a person from another country with their own passport', () => {
        const r = cleanPerson({ name: 'Ahmed', phone: '050 123 4567', country: 'AE', nic: 'x1234567', idKind: 'other' });
        expect(r.ok).toBe(true);
        expect(r.fields).toMatchObject({ phone: '+971501234567', country: 'AE', nic: 'ID:X1234567' });
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
        expect(readShared('debtor', { name: ' Nimal ', phone: ' +94771234567', nic: '853400937V' })).toEqual({ name: 'Nimal', phone: '+94771234567', nic: '853400937V' });
        expect(readShared('investment', { company: 'Nimal', name: 'Fixed deposit' }).name).toBe('Nimal');
        const loan = { name: 'a', phone: 'x' };
        expect(writeShared('debtor', loan, { name: 'b', phone: 'x' })).toBe(true);
        expect(loan).toEqual({ name: 'b', phone: 'x' });
        const inv = { name: 'FD', company: 'a' };
        expect(writeShared('investment', inv, { name: 'b', phone: '+94771234567', nic: '' })).toBe(true);
        expect(inv).toEqual({ name: 'FD', company: 'b', phone: '+94771234567' });                  // a blank NIC on a record that has none adds no field
        expect(writeShared('investment', inv, { name: 'b' })).toBe(false);
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
        expect(d.numbers.map((n) => n.e164)).toEqual(['+94771234567', '+447911123456']);
        expect(d.others).toEqual([{ raw: '0112345678', reason: 'not-a-mobile-number' }]);
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
        expect(SHARED).toEqual(['name', 'phone', 'nic']);
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
            { id: 'i1', name: 'Fixed deposit', company: 'Commercial Bank' },              // a bank: no number, no ID, no texts
            { id: 'i2', name: 'Loan from Ahmed', company: 'Ahmed Khan', phone: '+971501234567', nic: 'ID:X1234567' },
            { id: 'i3', name: 'Loan from Dilan', company: 'Dilan', sms_notifications_enabled: true },
        ],
    });
    it('finds who is not filed: a person is anybody named on a loan, or on an investment that carries a number, an ID or the texts', () => {
        const un = unfiledRecords(books());
        expect(un.map((u) => u.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'i2', 'i3']);
        expect(un.find((u) => u.id === 'i2')).toMatchObject({ kind: 'investment', name: 'Ahmed Khan', key: 'income' });
    });
    it('files them once each, links the records, and touches nothing else on a ledger', () => {
        const s = books();
        const out = harvestPeople(s, { now: NOW, newId: counter() });
        expect(out).toEqual({ added: 4, linked: 7 });                                     // Nimal, Sunil, Ahmed, Dilan; Kamal was already there
        expect(s.data.people.map((p) => p.name)).toEqual(['Kamal Silva', 'Nimal Perera', 'Sunil', 'Ahmed Khan', 'Dilan']);
        const ids = Object.fromEntries(s.data.people.map((p) => [p.name, p.id]));
        expect(s.data.debtors.find((d) => d.id === 'd1').personId).toBe(ids['Nimal Perera']);
        expect(s.data.debtors.find((d) => d.id === 'd2').personId).toBe(ids['Nimal Perera']);
        expect(s.data.debtors.find((d) => d.id === 'd3').personId).toBe('p0');
        expect(s.data.debtors.find((d) => d.id === 'd4').personId).toBe(ids.Sunil);
        expect(s.data.debtors.find((d) => d.id === 'd5').personId).toBe(ids.Sunil);
        expect(s.data.debtors.find((d) => d.id === 'd6').personId).toBeUndefined();
        expect(s.data.income.find((i) => i.id === 'i1').personId).toBeUndefined();
        expect(s.data.income.find((i) => i.id === 'i2').personId).toBe(ids['Ahmed Khan']);
        // a record keeps every other field exactly
        expect(s.data.debtors.find((d) => d.id === 'd1')).toMatchObject({ name: 'Nimal Perera', phone: '077 123 4567', nic: '853400937V' });
        // the person is made from the first record that names them, with a country read from the number
        expect(s.data.people.find((p) => p.name === 'Ahmed Khan')).toMatchObject({ country: 'AE', nic: 'ID:X1234567', phone: '+971501234567' });
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
