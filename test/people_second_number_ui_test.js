/* =============================================================================
 * test/people_second_number_ui_test.js — the optional second number on every contact form
 * -----------------------------------------------------------------------------
 * A person can have two phones. Every text goes to both when the second one is filled in, so the form has
 * to be strict about it (a real mobile number, not the first one again) and quiet when it is empty.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { contactHtml, readContact, collectContact, phone2Note, personFormHtml, personRowHtml } from '../wealthflow-people-ui.js';

const dom = (html) => parseHTML(`<!doctype html><html><body><div id="root">${html}</div></body></html>`).document;

describe('the second number box', () => {
    it('is on the contact fields with its own live line and Contacts button, and is empty for a record without one', () => {
        const d = dom(contactHtml('x', { kind: 'debtor', record: { phone: '+94771234567' }, nameId: 'x_name' }));
        const box = d.getElementById('x_phone2');
        expect(box).toBeTruthy();
        expect(box.getAttribute('value')).toBe('');
        expect(box.getAttribute('data-wfp')).toBe('phone2');
        expect(d.getElementById('x_pv2')).toBeTruthy();
        expect(d.querySelector('[data-wfp="contacts2"]')).toBeTruthy();
        expect(d.querySelector('[data-wfp="contacts2"]').getAttribute('data-name')).toBe('x_name');
    });

    it('shows the number a record holds, and says it will be texted', () => {
        const d = dom(contactHtml('x', { record: { phone: '+94771234567', phone2: '+94712345678' } }));
        expect(d.getElementById('x_phone2').getAttribute('value')).toBe('+94 71 234 5678');
        expect(d.getElementById('x_pv2').textContent).toContain('texts go here as well');
    });

    it('shows the person\'s second number on a record that holds none of its own', () => {
        const people = [{ id: 'p1', name: 'Nimal', phone: '+94771234567', phone2: '+94712345678', country: 'LK', nic: '' }];
        const d = dom(contactHtml('x', { record: { personId: 'p1' }, people }));
        expect(d.getElementById('x_phone2').getAttribute('value')).toBe('+94 71 234 5678');
    });

    it('shows a landline kept on the person as typed, and says no texts go to it', () => {
        const d = dom(contactHtml('x', { record: { phone: '+94771234567', phone2: '011 234 5678' } }));
        expect(d.getElementById('x_phone2').getAttribute('value')).toBe('011 234 5678');
        expect(d.getElementById('x_pv2').textContent).toMatch(/no texts go to it/);
    });

    it('the book\'s own form uses the same box, so a person is edited in one place', () => {
        const person = { id: 'p1', name: 'Nimal', phone: '+94771234567', phone2: '+94712345678', country: 'LK', nic: '', email: '', address: '', note: '' };
        const d = dom(personFormHtml({ person }));
        expect(d.querySelectorAll('#_pp_phone2').length).toBe(1);
        expect(d.getElementById('_pp_phone2').getAttribute('value')).toBe('+94 71 234 5678');
        expect(personRowHtml(person, { loans: 0, investments: 0, smsOn: false })).toContain('+94 71 234 5678');
    });

    it('shows an error under the box the error belongs to', () => {
        const d = dom(contactHtml('x', { record: { phone: '+94771234567', phone2: '12' }, errors: { phone2: 'Second number: too short' } }));
        expect(d.getElementById('x_pv2').textContent).toBe('Second number: too short');
        expect(d.getElementById('x_pv2').className).toContain('bad');
    });
});

describe('the line under the second number', () => {
    it('is quiet while it is being typed, speaks when finished', () => {
        expect(phone2Note('', '0771234567', 'LK')).toEqual({ cls: '', text: '' });
        expect(phone2Note('07', '0771234567', 'LK', false)).toEqual({ cls: '', text: '' });
        expect(phone2Note('07', '0771234567', 'LK', true).cls).toBe('warn');
    });
    it('calls the first number again what it is', () => {
        const n = phone2Note('+94 77 123 4567', '077 123 4567', 'LK');
        expect(n.cls).toBe('warn');
        expect(n.text).toMatch(/same as the first/);
        expect(phone2Note('+94 77 123 4567', '077 123 4567', 'LK', false)).toEqual({ cls: '', text: '' });
    });
    it('warns about a number of another country: the text service reaches Sri Lanka only', () => {
        const n = phone2Note('+44 7911 123456', '077 123 4567', 'LK');
        expect(n.cls).toBe('warn');
        expect(n.text).toMatch(/Sri Lankan mobile numbers/);
    });
});

describe('reading and checking the form', () => {
    const form = (over = {}) => ({ personId: '', country: 'LK', phone: '0771234567', phone2: '', idKind: 'nic', nic: '', remember: true, ...over });

    it('readContact reads the box, and says whether the form has one', () => {
        const d = dom(contactHtml('x', { record: { phone: '+94771234567', phone2: '+94712345678' } }));
        const c = readContact(d, 'x');
        expect(c.phone2).toBe('+94 71 234 5678');
        expect(c.hasPhone2).toBe(true);
        const old = dom('<input id="y_phone" value="0771234567">');
        expect(readContact(old, 'y')).toMatchObject({ phone2: '', hasPhone2: false });
    });

    it('an empty second number is nothing: no error, nothing stored', () => {
        const c = collectContact(form(), { smsOn: true });
        expect(c.ok).toBe(true);
        expect(c.phone2).toBe('');
    });

    it('a real Sri Lankan mobile number is stored in E.164; a number abroad is not stored as one', () => {
        expect(collectContact(form({ phone2: '071 234 5678' }), { smsOn: true }).phone2).toBe('+94712345678');
        expect(collectContact(form({ phone2: 'tel:+94712345678' }), { smsOn: true }).phone2).toBe('+94712345678');
        expect(collectContact(form({ phone2: '+44 7911 123456' }), { smsOn: true })).toMatchObject({ ok: false });
    });

    it('the first number again is refused, with texts on or off', () => {
        for (const smsOn of [true, false]) {
            const c = collectContact(form({ phone2: '+94 77 123 4567' }), { smsOn });
            expect(c.ok).toBe(false);
            expect(c.errors.phone2).toMatch(/same as the first/);
        }
    });

    it('a number that cannot be texted stops a save with texts on and is kept as typed with them off', () => {
        const on = collectContact(form({ phone2: '011 234 5678' }), { smsOn: true });
        expect(on.ok).toBe(false);
        expect(on.errors.phone2).toMatch(/^Second number: /);
        const off = collectContact(form({ phone2: '011 234 5678' }), { smsOn: false });
        expect(off.ok).toBe(true);
        expect(off.phone2).toBe('011 234 5678');
    });

    it('the first number is still required for texts, whatever the second says', () => {
        const c = collectContact(form({ phone: '', phone2: '071 234 5678' }), { smsOn: true });
        expect(c.ok).toBe(false);
        expect(c.errors.phone).toBeTruthy();
    });

    it('a form that never had the box (an older one) is unchanged', () => {
        const c = collectContact({ personId: '', country: 'LK', phone: '0771234567', idKind: 'nic', nic: '', remember: false }, { smsOn: true });
        expect(c.ok).toBe(true);
        expect(c.phone2).toBe('');
    });
});
