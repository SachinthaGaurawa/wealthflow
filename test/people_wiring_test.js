/* =============================================================================
 * test/people_wiring_test.js — the saved-people book is connected, and connected safely
 * -----------------------------------------------------------------------------
 * The same three ways a feature ships without working as the text messages had: a module nothing loads, a key that is never
 * hydrated or merged, and a form that writes the ledger before the new step has run. Each is a string in a file.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const HTML = read('index.html');

describe('the two new ledgers behave like every other ledger here', () => {
    it('merge per record across devices (record keys), so a second device cannot overwrite the whole list and a delete is a tombstone', () => {
        const keys = /const _WF_RECORD_KEYS = \[([^\]]*)\]/.exec(HTML)[1];
        expect(keys).toContain("'people'");
        expect(keys).toContain("'payAccounts'");
    });
    it('are declared on appData, so they are hydrated at all', () => {
        const defaults = HTML.slice(HTML.indexOf('let appData = {'), HTML.indexOf('let isInitialised'));
        expect(defaults).toContain('people: []');
        expect(defaults).toContain('payAccounts: []');
    });
    it('are emptied by a factory reset, like the rest', () => {
        const reset = HTML.slice(HTML.indexOf('const _wipeStamp = Date.now();'), HTML.indexOf('const _wipeStamp = Date.now();') + 1200);
        expect(reset).toContain('people: []');
        expect(reset).toContain('payAccounts: []');
    });
    it('use the names the module and the server agree on', async () => {
        const { PEOPLE_KEY } = await import('../wealthflow-people.js');
        const { PAY_KEY } = await import('../wealthflow-payaccounts.js');
        expect(PEOPLE_KEY).toBe('people');
        expect(PAY_KEY).toBe('payAccounts');
    });
});

describe('the page', () => {
    it('loads the screens as a deferred ES module, after the text-message module they sit beside', () => {
        const sms = HTML.indexOf('<script type="module" src="wealthflow-sms.js"></script>');
        const ui = HTML.indexOf('<script type="module" src="wealthflow-people-ui.js"></script>');
        expect(sms).toBeGreaterThan(0);
        expect(ui).toBeGreaterThan(sms);
    });

    it('has the buttons that open the book: on the investments page and on the debtors card', () => {
        expect(HTML).toContain("onclick=\"if (window.WFPeople) WFPeople.openHub('people')\">Saved people</button>");
        expect(HTML).toContain('id="_liq_people"');
        expect(HTML).toContain("if (peopleBtn) peopleBtn.onclick = () => { if (window.WFPeople) WFPeople.openHub('people'); };");
    });

    it('both forms do the people step BEFORE the ledger is read for the write (a changed number is carried to the person\'s other records there)', () => {
        const inv = HTML.slice(HTML.indexOf('function saveIncome()'), HTML.indexOf('function clearIncomeForm()'));
        expect(inv).toContain('const commit = () => {');
        expect(inv.indexOf('const arr = DB.get(\'income\')')).toBeGreaterThan(inv.indexOf('const commit = () => {'));
        expect(inv).toContain("WP.saveLink({ kind: 'investment', rec,");
        expect(inv.indexOf('WP.saveLink(')).toBeGreaterThan(inv.indexOf("DB.set('income', arr)"));       // it is called after the closure that holds the write is defined

        const deb = HTML.slice(HTML.indexOf('function openDebtorModal(existing)'), HTML.indexOf('window.openDebtorModal = openDebtorModal'));
        expect(deb).toContain('const commit = () => {');
        expect(deb.indexOf("const list = (DB.get('debtors') || []).slice();")).toBeGreaterThan(deb.indexOf('const commit = () => {'));
        expect(deb.split("(DB.get('debtors') || []).slice()").length - 1).toBe(1);                       // and the ledger is read once, there
        expect(deb).toContain("WP.saveLink({ kind: 'debtor', rec,");
    });

    it('the picker sits at the top of both forms, where the person is named, and fills the form\'s own name box', () => {
        expect(HTML).toContain('<div id="i_pick_host"></div>');
        expect(HTML).toContain("WP.pickerHtml('i', { record: rec, nameId: 'i_company' })");
        expect(HTML).toContain("WP.pickerHtml('_db', { record: d, nameId: '_db_name' })");
    });

    it('the investment form folds the contact fields away (most investments are a bank\'s) and opens them for a person', () => {
        expect(HTML).toContain('<summary>Investor contact &amp; text messages <span>(optional)</span></summary>');
        expect(HTML).toContain("rec.phone || rec.nic || rec.personId || rec.sms_notifications_enabled === true");
    });

    it('a form that cannot reach the screens still saves: every use is guarded', () => {
        const forms = HTML.slice(HTML.indexOf('function openDebtorModal(existing)'), HTML.indexOf('window.openDebtorModal = openDebtorModal'))
            + HTML.slice(HTML.indexOf('function saveIncome()'), HTML.indexOf('function clearIncomeForm()'));
        expect(forms).toMatch(/const WP = window\.WFPeople;/);
        expect(forms).toContain('else commit();');
        expect(forms).not.toMatch(/\bWFPeople\./);                                                      // always through the guarded const
    });

    it('shows a stored number as a number (and still dials it)', () => {
        expect(HTML).toContain('WFPeople.showPhone(d.phone)');
        expect(HTML).toContain('href="tel:');
    });
});

describe('the module', () => {
    it('is not named in a way the build would skip, and imports only what ships beside it', () => {
        const ui = read('wealthflow-people-ui.js');
        const imports = [...ui.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
        expect(imports.sort()).toEqual(['./wealthflow-nic.js', './wealthflow-payaccounts.js', './wealthflow-people.js', './wealthflow-phone.js'].sort());
        for (const f of imports) expect(() => read(f.slice(2)), f).not.toThrow();
    });
    it('the pure rules import only the phone and NIC rules, which the server shares', () => {
        const people = read('wealthflow-people.js');
        const imports = [...people.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
        expect(imports.sort()).toEqual(['./wealthflow-nic.js', './wealthflow-phone.js']);
        const pay = read('wealthflow-payaccounts.js');
        expect([...pay.matchAll(/^import .* from '([^']+)'/gm)]).toEqual([]);
    });
});
