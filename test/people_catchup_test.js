/* =============================================================================
 * test/people_catchup_test.js — a number added to a saved person reaches the loans that are theirs
 * -----------------------------------------------------------------------------
 * Reported 2026-10-29: a second phone number added to a person's contact did not update the debtors and investments of that person, so
 * the new number never received a text. Two ways a loan could be left behind, both pinned here:
 *   - it was never linked to the person (made before the book existed, saved with "remember" off, or left behind by a person who was
 *     deleted and added again), so nothing the person said was carried to it;
 *   - it was linked, but the person was saved and the loan never received the number (the page closed between the two writes, the loan was
 *     being edited on another phone).
 * A person's new number must never replace a number a loan deliberately keeps, and a family sharing one phone are not one person.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import P from '../wealthflow-people.js';

const NOW = Date.parse('2026-10-29T08:00:00Z');
const mk = (init) => { const data = { ...init }; return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; } }; };
const debtor = (over = {}) => ({ id: 'd1', name: "Kaushi's Mother", phone: '+94715561957', sms_notifications_enabled: true, sms_enabled_at: 1, _ut: Date.parse('2026-09-01T00:00:00Z'), ...over });
const investment = (over = {}) => ({ id: 'i1', company: "Kaushi's Mother", phone: '+94715561957', sms_notifications_enabled: true, amount: 100000, _ut: Date.parse('2026-09-01T00:00:00Z'), ...over });

describe('a person saved after their loans were made', () => {
    it('claims the loans and investments that name them, and the second number reaches all of them', () => {
        const s = mk({ debtors: [debtor()], income: [investment()], people: [] });
        const r = P.addPerson(s, { name: "Kaushi's Mother", phone: '0715561957', phone2: '0777654321' }, { now: NOW });
        expect(r.ok).toBe(true);
        expect(r.adopted).toMatchObject({ loans: 1, investments: 1, smsOn: 2 });
        for (const rec of [s.data.debtors[0], s.data.income[0]]) {
            expect(rec.personId).toBe(r.person.id);
            expect(rec.phone2).toBe('+94777654321');
            expect(rec.phone2_at).toBe(NOW);                                                // a new number: what happened before is history for it
            expect(rec.phone).toBe('+94715561957');                                         // the first number is untouched
        }
    });

    it('a later edit of the person reaches a loan that was never linked, found by the number it was saved with', () => {
        const s = mk({ debtors: [debtor()], income: [], people: [] });
        P.harvestPeople(s, { now: NOW });
        // the loan loses its link (a person deleted and added again leaves it pointing at nobody)
        s.data.debtors = s.data.debtors.map((d) => { const { personId, ...rest } = d; return rest; });
        const id = s.data.people[0].id;
        const out = P.updatePerson(s, id, { name: "Kaushi's Mother", phone: '0715561957', phone2: '0777654321' }, { now: NOW });
        expect(out.ok).toBe(true);
        expect(s.data.debtors[0].personId).toBe(id);
        expect(s.data.debtors[0].phone2).toBe('+94777654321');
        expect(out.siblings.loans).toBe(1);
    });

    it('finds a loan by the OLD number when the same edit changes the first number', () => {
        const s = mk({ debtors: [debtor()], income: [], people: [{ id: 'p1', name: "Kaushi's Mother", phone: '+94715561957', phone2: '', country: 'LK', nic: '', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }] });
        const out = P.updatePerson(s, 'p1', { name: "Kaushi's Mother", phone: '0712223334', phone2: '' }, { now: NOW });
        expect(out.ok).toBe(true);
        expect(s.data.debtors[0].phone).toBe('+94712223334');                               // the text that was going to a stale copy goes to the new one
        expect(s.data.debtors[0].personId).toBe('p1');
    });

    it('does not claim a loan of somebody else who shares the phone, or one linked to another person', () => {
        const s = mk({
            debtors: [debtor({ id: 'dA', name: 'Nimal' }), debtor({ id: 'dB', personId: 'other' })],
            income: [], people: [{ id: 'other', name: 'Somebody', phone: '+94700000000', country: 'LK' }],
        });
        const r = P.addPerson(s, { name: "Kaushi's Mother", phone: '0715561957', phone2: '0777654321' }, { now: NOW });
        expect(r.adopted).toMatchObject({ loans: 0, investments: 0 });
        expect(s.data.debtors[0].personId).toBeUndefined();                                 // same number, different name: a family phone, not one person
        expect(s.data.debtors[1].personId).toBe('other');
        expect(s.data.debtors.every((d) => d.phone2 === undefined)).toBe(true);
    });

    it('the confirmation before an edit counts the loans that will be claimed, so it never says "nothing else changes"', () => {
        const s = mk({ debtors: [debtor()], income: [investment()], people: [{ id: 'p1', name: "Kaushi's Mother", phone: '+94715561957', phone2: '', country: 'LK' }] });
        expect(P.previewUpdate(s, 'p1', { name: "Kaushi's Mother", phone: '0715561957', phone2: '0777654321' })).toEqual({ loans: 1, investments: 1, smsOn: 2 });
        // nothing shared changes, but the loan and the investment would still be claimed by saving: they are counted
        expect(P.previewUpdate(s, 'p1', { name: "Kaushi's Mother", phone: '0715561957', phone2: '' })).toEqual({ loans: 1, investments: 1, smsOn: 2 });
        // nobody left to claim and nothing shared changed: nothing to ask
        const linked = mk({ debtors: [debtor({ personId: 'p1' })], income: [], people: [{ id: 'p1', name: "Kaushi's Mother", phone: '+94715561957', phone2: '', country: 'LK' }] });
        expect(P.previewUpdate(linked, 'p1', { name: "Kaushi's Mother", phone: '0715561957', phone2: '' })).toEqual({ loans: 0, investments: 0, smsOn: 0 });
    });

    it('a loan that names only a name two people share is nobody\'s: it is not claimed by whichever of them is edited, nor given their number', () => {
        const nameOnly = { id: 'dN', name: 'Nimal', sms_notifications_enabled: true, _ut: 1 };
        const s = mk({ debtors: [nameOnly], income: [], people: [
            { id: 'p1', name: 'Nimal', phone: '+94771111111', country: 'LK' },
            { id: 'p2', name: 'Nimal', phone: '+94772222222', country: 'LK' },
        ] });
        expect(P.strayRecords(s, s.data.people[0])).toEqual([]);
        P.updatePerson(s, 'p1', { name: 'Nimal', phone: '0771111111', phone2: '0773333333' }, { now: NOW });
        expect(s.data.debtors[0].personId).toBeUndefined();
        expect(s.data.debtors[0].phone).toBeUndefined();                                    // nobody\'s number was put on a loan that is nobody\'s
        // with only one Nimal in the book the same loan is his
        const one = mk({ debtors: [{ ...nameOnly }], income: [], people: [{ id: 'p1', name: 'Nimal', phone: '+94771111111', country: 'LK' }] });
        expect(P.strayRecords(one, one.data.people[0])).toHaveLength(1);
        // and a name edited in the same save is still found by the name it had
        const renamed = mk({ debtors: [{ ...nameOnly }], income: [], people: [{ id: 'p1', name: 'Nimal', phone: '+94771111111', country: 'LK' }] });
        P.updatePerson(renamed, 'p1', { name: 'Nimal Perera', phone: '0771111111' }, { now: NOW });
        expect(renamed.data.debtors[0].personId).toBe('p1');
    });

    it('an edit that changes no shared field still asks first when it will claim a loan, because claiming gives the loan the person\'s second number', () => {
        const s = mk({ debtors: [debtor()], income: [], people: [{ id: 'p1', name: "Kaushi's Mother", phone: '+94715561957', phone2: '+94777654321', email: '', country: 'LK' }] });
        expect(P.previewUpdate(s, 'p1', { name: "Kaushi's Mother", phone: '0715561957', phone2: '0777654321', email: 'a@b.lk' })).toEqual({ loans: 1, investments: 0, smsOn: 1 });
        P.updatePerson(s, 'p1', { name: "Kaushi's Mother", phone: '0715561957', phone2: '0777654321', email: 'a@b.lk' }, { now: NOW });
        // once claimed, the next email edit has nothing left to ask about
        expect(P.previewUpdate(s, 'p1', { name: "Kaushi's Mother", phone: '0715561957', phone2: '0777654321', email: 'c@d.lk' })).toEqual({ loans: 0, investments: 0, smsOn: 0 });
    });

    it('a person with an NIC claims the loans with the same NIC whatever name they were saved under', () => {
        const s = mk({ debtors: [debtor({ name: 'Kaushi Amma', phone: '', nic: '853400937V' })], income: [], people: [] });
        const r = P.addPerson(s, { name: "Kaushi's Mother", nic: '853400937V', phone: '0715561957' }, { now: NOW });
        expect(r.adopted.loans).toBe(1);
        expect(s.data.debtors[0].phone).toBe('+94715561957');                               // what the loan lacked comes from the person
    });
});

describe('a linked loan that fell behind its person', () => {
    const person = { id: 'p1', name: "Kaushi's Mother", phone: '+94715561957', phone2: '+94777654321', country: 'LK', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' };

    it('is given the second number when the person was saved after the loan was last touched', () => {
        const s = mk({ people: [person], debtors: [debtor({ personId: 'p1' })], income: [investment({ personId: 'p1' })] });
        const r = P.reconcileLinked(s, NOW);
        expect(r).toEqual({ loans: 1, investments: 1, smsOn: 2 });
        expect(s.data.debtors[0].phone2).toBe('+94777654321');
        expect(s.data.income[0].phone2_at).toBe(NOW);
    });

    it('never replaces a number the loan holds, and leaves a loan edited after the person alone', () => {
        const held = debtor({ personId: 'p1', phone2: '+94700000001', phone2_at: 5 });
        const later = debtor({ id: 'd2', personId: 'p1', _ut: Date.parse('2026-10-25T00:00:00Z') });        // the loan was saved after the person: its choice stands
        const s = mk({ people: [person], debtors: [held, later], income: [] });
        expect(P.reconcileLinked(s, NOW)).toEqual({ loans: 0, investments: 0, smsOn: 0 });
        expect(s.data.debtors[0].phone2).toBe('+94700000001');
        expect(s.data.debtors[1].phone2).toBeUndefined();
    });

    it('writes nothing when nothing is behind, so an untouched ledger is never re-stamped', () => {
        let writes = 0;
        const s = mk({ people: [person], debtors: [debtor({ personId: 'p1', phone2: '+94777654321', phone2_at: 1 })], income: [] });
        const set = s.set; s.set = (k, v) => { writes += 1; set(k, v); };
        expect(P.reconcileLinked(s, NOW).loans).toBe(0);
        expect(writes).toBe(0);
        expect(P.reconcileLinked(mk({ debtors: [debtor()], income: [] }), NOW)).toEqual({ loans: 0, investments: 0, smsOn: 0 });   // no book at all
    });

    it('does not give a loan a second number that cannot be texted', () => {
        const s = mk({ people: [{ ...person, phone2: '0112345678' }], debtors: [debtor({ personId: 'p1' })], income: [] });   // a landline
        expect(P.reconcileLinked(s, NOW).loans).toBe(0);
        expect(s.data.debtors[0].phone2).toBeUndefined();
    });
});
