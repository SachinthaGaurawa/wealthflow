/* =============================================================================
 * test/card_tabs_test.js — one tab per credit card on CC One-Time and CC Instalments (wealthflow-card-tabs.js)
 * -----------------------------------------------------------------------------
 * Owner, 2026-11-02: with more than one credit card, show the cards as tabs with their bank, on CC One-Time and on CC Instalments, in a clearer design than the row of coloured bank chips.
 * The tabs are only worth having if they agree with the card walk that settles the charges (index.html `_ccKey`: canonical bank + last four), so two cards of one bank are two tabs, a row with
 * no card number never lands on a card by guesswork, and the same key names a card for a charge, a payment and the walk's own "carried forward" line.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
/* the module is a classic script: loaded the way the page loads it, into a window of its own */
const sandbox = {};
new Function('window', 'globalThis', read('wealthflow-card-tabs.js'))(sandbox, sandbox);
const Tabs = sandbox.WFCardTabs;

const canonBank = (b) => (/amex|american express/i.test(b || '') ? 'American Express (AMEX)' : String(b || '').trim());
const shown = (b) => String(b || '');
const charge = (id, bank, last4, amount, extra = {}) => ({ id, bank, card_last4: last4, amount, paid: false, ...extra });
const ctx = (extra = {}) => ({ canonBank, shown, open: (r) => !r.paid, value: (r) => r.amount, late: (r) => !!r.late, ...extra });

describe('which tabs there are', () => {
    it('one per card: the bank (folded to its one name) and the last four digits; two cards of one bank are two tabs', () => {
        const model = Tabs.build([charge('a', 'AMEX', '0276', 100), charge('b', 'American Express', '0276', 50), charge('c', 'AMEX', '1111', 70), charge('d', 'Sampath Bank', '2020', 30)], ctx());
        expect(model.tabs.map((t) => [t.key, t.count])).toEqual([['american express (amex)|0276', 2], ['american express (amex)|1111', 1], ['sampath bank|2020', 1]]);
        expect(model.tabs[0]).toMatchObject({ bank: 'American Express (AMEX)', last4: '0276', label: 'American Express (AMEX)', open: 2, due: 150 });
    });
    it('the card that owes most comes first, then the one with most rows, then by name; what is paid is not due', () => {
        const model = Tabs.build([charge('a', 'HNB', '1', 10), charge('b', 'Sampath Bank', '2', 500), charge('c', 'NTB', '3', 500, { paid: true }), charge('d', 'NTB', '3', 5, { paid: true })], ctx());
        expect(model.tabs.map((t) => t.bank)).toEqual(['Sampath Bank', 'HNB', 'NTB']);
        expect(model.tabs[2]).toMatchObject({ count: 2, open: 0, due: 0 });
    });
    it('counts what is overdue and adds money in whole cents, never as floats', () => {
        const model = Tabs.build([charge('a', 'HNB', '1', 0.1, { late: true }), charge('b', 'HNB', '1', 0.2, { late: true }), charge('c', 'HNB', '1', 0.3)], ctx());
        expect(model.tabs[0]).toMatchObject({ due: 0.6, late: 2, open: 3 });
    });
    it('a row with no card number joins the bank\'s only numbered card (on the rows, or a credit card in Cards and accounts) and is never put on one of several', () => {
        const rows = [charge('a', 'AMEX', '0276', 100), charge('n', 'AMEX', '', 40)];
        expect(Tabs.build(rows, ctx()).tabs.map((t) => [t.key, t.count])).toEqual([['american express (amex)|0276', 2]]);
        const two = Tabs.build([...rows, charge('c', 'AMEX', '1111', 5)], ctx());
        expect(two.tabs.map((t) => [t.key, t.count]).sort()).toEqual([['american express (amex)|', 1], ['american express (amex)|0276', 1], ['american express (amex)|1111', 1]]);
        const reg = { '5555': { type: 'credit_card', bank: 'Sampath Bank', last4: '5555' }, '0018': { type: 'bank_account', bank: 'DFCC Bank', last4: '0018' } };
        const viaRegistry = Tabs.build([charge('s', 'Sampath Bank', '', 10), charge('d', 'DFCC Bank', '', 10)], ctx({ registry: reg }));
        expect(viaRegistry.keyOf({ bank: 'Sampath Bank' })).toBe('sampath bank|5555');
        expect(viaRegistry.keyOf({ bank: 'DFCC Bank' })).toBe('dfcc bank|');              // an entry that says bank account is not a card
    });
    it('the same key names a card for a charge, a payment and the walk\'s own line, whatever the spelling of the bank', () => {
        const model = Tabs.build([charge('a', 'AMEX', '0276', 100), charge('b', 'Sampath Bank', '2020', 5)], ctx());
        const key = model.tabs.find((t) => t.last4 === '0276').key;
        for (const record of [{ bank: 'American Express', card_last4: '0276' }, { bank: 'Amex', last4: '0276' }, { bank: 'AMEX', card_last4: '0276' }]) expect(model.keyOf(record)).toBe(key);
        expect(model.keyOf({})).toBe('');
    });
    it('copes with nothing, and with rows that are not rows', () => {
        expect(Tabs.build(undefined, ctx()).tabs).toEqual([]);
        expect(Tabs.build([null, 7, 'x', charge('a', 'HNB', '1', 5)], ctx()).tabs).toHaveLength(1);
        expect(Tabs.build([charge('a', 'HNB', '1', 'abc')], ctx()).tabs[0].due).toBe(0);
    });
});

describe('how the tabs read', () => {
    const model = Tabs.build([charge('a', 'AMEX', '0276', 155229.92, { late: true }), charge('b', 'Sampath Bank', '2020', 10000)], ctx());
    const fmt = (n) => 'LKR ' + n.toLocaleString('en-US', { minimumFractionDigits: 2 });
    it('"All cards" first, then a tab per card with the bank, the last four, the rows and what is due; the chosen one is selected', () => {
        const html = Tabs.render(model, 'all', { fmt, noun: 'charge', dueLabel: 'Due' });
        expect(html).toMatch(/role="tablist"/);
        expect(html.match(/role="tab"/g)).toHaveLength(3);
        expect(html).toMatch(/data-card-tab="all"[^>]*aria-selected="true"/);
        expect(html).toMatch(/American Express \(AMEX\)/); expect(html).toMatch(/••0276 · 1 charge</);
        expect(html).toMatch(/LKR 155,229\.92/); expect(html).toMatch(/1 overdue/);
        expect(html).toMatch(/2 cards · 2 charges/); expect(html).toMatch(/LKR 165,229\.92/);
        const chosen = Tabs.render(model, model.tabs[1].key, { fmt, noun: 'charge' });
        expect(chosen).toMatch(new RegExp('data-card-tab="' + model.tabs[1].key.replace('|', '\\|') + '"[^>]*aria-selected="true"'));
        expect(chosen).toMatch(/data-card-tab="all"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    });
    it('an unknown chosen key selects "All cards", a card with nothing owed says so, and plans say Monthly', () => {
        expect(Tabs.render(model, 'gone|0000', { fmt })).toMatch(/data-card-tab="all"[^>]*aria-selected="true"/);
        const none = Tabs.build([charge('a', 'HNB', '1', 5, { paid: true }), charge('b', 'NTB', '2', 5)], ctx());
        expect(Tabs.render(none, 'all', { fmt })).toMatch(/Nothing due/);
        expect(Tabs.render(none, 'all', { fmt, noun: 'plan', dueLabel: 'Monthly' })).toMatch(/Monthly/);
        expect(Tabs.render(none, 'all', { fmt, noun: 'plan' })).toMatch(/1 plan</);
    });
    it('every printed word is escaped, and the monogram is two letters of the bank\'s name', () => {
        const evil = Tabs.build([charge('a', '<img src=x onerror=alert(1)> Bank', '"><b>', 5), charge('b', 'HNB', '1', 5)], ctx());
        const html = Tabs.render(evil, 'all', { fmt });
        expect(html).not.toMatch(/<img|<b>/);
        expect(Tabs.initials('American Express (AMEX)')).toBe('AE');
        expect(Tabs.initials('Sampath Bank')).toBe('SA');           // "Bank" is not a name: one word gives its first two letters
        expect(Tabs.initials('HNB')).toBe('HN');
        expect(Tabs.initials('')).toBe('?');
    });
});

describe('the screens use it', () => {
    const html = read('index.html');
    it('the tab module is loaded, and the two screens have a place for the tabs', () => {
        expect(html).toMatch(/<script src="wealthflow-card-tabs\.js" defer><\/script>/);
        expect(html).toMatch(/id="ccotFilterBar"/); expect(html).toMatch(/id="cciFilterBar"/);
    });
    it('both screens build the tabs from the page\'s canonical bank name and printed bank name, and filter their rows by the one card key', () => {
        expect(html).toMatch(/Object\.assign\(\{ canonBank: _canonBank, shown: _bankShown, registry \}/);
        expect(html).toMatch(/if \(_ccotBankFilter !== 'all'\) arr = arr\.filter\(x => model\.keyOf\(x\) === _ccotBankFilter\)/);
        expect(html).toMatch(/if \(_cciCardFilter !== 'all'\) arr = arr\.filter\(x => model\.keyOf\(x\) === _cciCardFilter\)/);
        expect(html).toMatch(/window\.WFCardTabs\.wire\(fbar, setCCOTBankFilter\)/);
        expect(html).toMatch(/window\.WFCardTabs\.wire\(fbar, setCCICardFilter\)/);
    });
    it('the Card payments panel and its "carried forward" lines are scoped by the same key; a payment recorded under a tab is filed on that card', () => {
        expect(html).toMatch(/const inTab = \(r\) => _ccotBankFilter === 'all' \|\| \(model \? model\.keyOf\(r\) === _ccotBankFilter/);
        expect(html).toMatch(/inTab\(\{ bank: x\.w\.bank, card_last4: String\(x\.k\)\.split\('\|'\)\[1\] \|\| '' \}\)/);
        expect(html).toMatch(/addCCPayment\(\{ bank, card_last4: _tabNow \? _tabNow\.last4 : '', amount, date, desc, source: 'manual' \}\)/);
    });
    it('the instalments screen sorts by its own state (it read the One-Time screen\'s)', () => {
        const fn = html.slice(html.indexOf('function renderCCI()'), html.indexOf('function renderCCI()') + 3500);
        expect(fn).toMatch(/const s = sortState\['cci'\]/);
        expect(fn).not.toMatch(/sortState\['ccot'\]/);
    });
    it('the tab row is styled in wf-ui.css with the app\'s tokens and honours reduced motion and forced colours', () => {
        const css = read('wf-ui.css');
        expect(css).toMatch(/\.wf-ctab\.is-on \{/); expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.wf-ctab \{ transition: none; \}/); expect(css).toMatch(/forced-colors: active[\s\S]*\.wf-ctab\.is-on/);
        expect(css).toMatch(/\.wf-ctab \{[^}]*min-height: 44px/);
    });
});
