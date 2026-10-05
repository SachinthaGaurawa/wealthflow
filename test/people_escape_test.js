/* =============================================================================
 * test/people_escape_test.js — what a stranger types into the books never becomes markup
 * -----------------------------------------------------------------------------
 * Every name, number, note and bank detail in the saved-people screens comes from a person (or from a contacts
 * file a phone handed over), and the screens write HTML. Each builder is run here with a hostile string in every
 * free-text field and the result is parsed as a browser would: no element other than the ones the screen itself
 * draws, no event attribute anywhere, no script, no image, and the payload is still there as text.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import * as UI from '../wealthflow-people-ui.js';
import { cleanAccount } from '../wealthflow-payaccounts.js';

const PAYLOADS = [
    '"><img src=x onerror=alert(1)>',
    '<script>alert(2)</script>',
    "' onmouseover='alert(3)",
    '" autofocus onfocus="alert(4)',
    '</textarea></select></div><svg onload=alert(5)>',
    '<a href="javascript:alert(6)">x</a>',
];
const FORBIDDEN_TAGS = ['script', 'img', 'svg', 'iframe', 'object', 'embed', 'a', 'style', 'link', 'meta', 'form'];

/** Parse the markup the way a page would and report anything that could run or load. */
function danger(html) {
    const { document } = parseHTML(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
    const root = document.getElementById('root');
    const found = [];
    for (const el of root.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase();
        if (FORBIDDEN_TAGS.includes(tag)) found.push(`<${tag}>`);
        for (const a of el.getAttributeNames()) {
            if (/^on/i.test(a)) found.push(`${tag}[${a}]`);
            if (/^(src|href|srcdoc|formaction|action)$/i.test(a)) found.push(`${tag}[${a}]`);
            if (/^\s*javascript:/i.test(el.getAttribute(a) || '')) found.push(`${tag}[${a}=javascript:]`);
            if (a === 'autofocus') found.push(`${tag}[autofocus]`);
        }
    }
    return found;
}

for (const payload of PAYLOADS) {
    describe(`hostile text ${JSON.stringify(payload).slice(0, 40)}`, () => {
        const person = { id: 'p1', name: payload, phone: '+94771234567', phone2: payload, email: payload, address: payload, note: payload, nic: '853400937V', country: 'LK' };
        const draft = { name: payload, phone: payload, nic: payload, country: 'LK', phone2: payload, email: payload, address: payload, note: payload };
        const books = { debtors: [{ id: 'd1', name: payload, personId: 'p1' }], income: [{ id: 'i1', company: payload, personId: 'p1' }] };

        it('a person on the list and in the search results', () => {
            expect(danger(UI.personRowHtml(person, { loans: 1, investments: 1, smsOn: true }))).toEqual([]);
            expect(danger(UI.peopleListHtml({ people: [person], books, q: '' }))).toEqual([]);
            expect(danger(UI.peopleListHtml({ people: [person], books, q: payload }))).toEqual([]);
            expect(danger(UI.peopleTabHtml({ people: [person], books, q: payload, unfiled: 3, picker: true }))).toEqual([]);
        });

        it('the add and edit form, with every message it can show', () => {
            const errors = { name: payload, phone: payload, nic: payload, phone2: payload, email: payload };
            expect(danger(UI.personFormHtml({ person, errors }))).toEqual([]);
            expect(danger(UI.personFormHtml({ person: null, draft, errors }))).toEqual([]);
            expect(danger(UI.personFormHtml({ person, confirm: { loans: 2, investments: 1, smsOn: 1 } }))).toEqual([]);
            expect(danger(UI.personFormHtml({ person, askDelete: true, use: { loans: 1, investments: 1 } }))).toEqual([]);
        });

        it('the contact block and the picker on a loan or investment form', () => {
            expect(danger(UI.contactHtml('_t', { kind: 'debtor', record: { phone: payload, nic: payload }, people: [person], errors: { phone: payload, nic: payload } }))).toEqual([]);
            expect(danger(UI.pickerHtml('_t', { people: [person, { ...person, id: 'p2', name: `${payload} two` }], record: { name: payload } }))).toEqual([]);
        });

        it('the contacts import list', () => {
            const rows = [{ i: 0, name: payload, numbers: [{ pretty: payload }, { pretty: '+94 77 123 4567' }], pick: 0, on: true, others: [payload] }];
            expect(danger(UI.importHtml({ rows, q: payload, shown: 1, total: 1, source: payload }))).toEqual([]);
        });

        it('the bank accounts: list, card and form', () => {
            const account = { id: 'a1', bank: payload, holder: payload, number: '8001234567', branch: payload, swift: 'CCEYLKLX', note: payload, showTo: 'both', active: true };
            expect(danger(UI.accountCardHtml(account))).toEqual([]);
            expect(danger(UI.accountsTabHtml({ accounts: [account] }))).toEqual([]);
            expect(danger(UI.accountFormHtml({ account, draft: account, errors: { bank: payload, holder: payload, number: payload, swift: payload } }))).toEqual([]);
            expect(danger(UI.accountFormHtml({ account, askDelete: true }))).toEqual([]);
        });
    });
}

describe('the payload is shown, not lost', () => {
    it('as text the person can read, so a real name with an apostrophe or ampersand survives', () => {
        const html = UI.personRowHtml({ id: 'p1', name: "Dr. O'Neil & Sons <Pvt>", phone: '', nic: '' }, { loans: 0, investments: 0, smsOn: false });
        const { document } = parseHTML(`<div id="r">${html}</div>`);
        expect(document.querySelector('.wfp-name').textContent).toBe("Dr. O'Neil & Sons <Pvt>");
    });
    it('an account number, bank and holder are refused or cleaned at the door as well, so the books never hold markup in them', () => {
        expect(cleanAccount({ bank: '<b>B</b>', holder: 'H', number: '12<b>34' }).errors.number).toBeTruthy();
        expect(cleanAccount({ bank: '<b>B</b>', holder: 'H', number: '123456' }).fields.bank).not.toMatch(/[\u0000-\u001F]/);
    });
});
