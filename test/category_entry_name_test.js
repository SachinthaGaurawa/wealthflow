/* =============================================================================
 * test/category_entry_name_test.js — a category is stored under the name the Category dropdown has
 * -----------------------------------------------------------------------------
 * The classifiers (the rules, the AI board, the merchant list) say "Groceries", "Health", "Bank Charges"; the owner's own expenses are filed under the dropdown's names ("Food & Groceries",
 * "Healthcare", "Banking"). A statement row filed under the classifier's word was a separate slice on the dashboard, missed the owner's "Food" budget and, because the editor set the
 * dropdown to the stored word, left the Category blank when the row was edited and saved.
 *
 * This file holds three things still:
 *   1. the table that bridges the two vocabularies is pinned against the dropdown's own list (index.html), so it cannot drift;
 *   2. EVERY name the classification can produce for an expense is either a dropdown name after the bridge or a named exception — a new category added to the classifier without a
 *      home in the dropdown fails here;
 *   3. the three places the bridge is used (the ledger's record, the owner's history, the page's editor and manual upload) do what they say.
 * ===========================================================================*/

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { CLASSIFY_CATEGORIES, EXPENSE_ENTRY_NAME, CLASSIFIER_NAME, expenseEntryName, classifierName } from '../wealthflow-statement-router.js';
import '../statement-merchants.mjs';                                 // the merchant list adds its categories to the vocabulary
import { settleStatement } from '../statement-ledger.mjs';
import { buildHistory } from '../statement-history.mjs';
import { classifySlice, merchantNameFor } from '../statement-sync.js';
import { INCOME_NAMES, CARD_ONLY } from '../statement-board.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const DROPDOWN = (() => {
    const m = HTML.match(/const EXPENSE_CATEGORIES = \[([\s\S]*?)\];/);
    expect(m, 'index.html no longer defines EXPENSE_CATEGORIES').toBeTruthy();
    return m[1].split(',').map(x => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
})();
/** Classifier names for which the dropdown has no counterpart, deliberately: cash drawn from an ATM is not a category the owner types. */
const NO_COUNTERPART = ['Cash Withdrawal'];

describe('the bridge between the two vocabularies', () => {
    it('every name it files under is one the dropdown has, and no name it replaces is', () => {
        expect(DROPDOWN.length).toBeGreaterThan(20);
        for (const [from, to] of Object.entries(EXPENSE_ENTRY_NAME)) {
            expect(DROPDOWN, `${from} → ${to}`).toContain(to);
            expect(DROPDOWN, `${from} is itself a dropdown name, so it needs no bridge`).not.toContain(from);
        }
    });
    it('the way back exists only for names that mean exactly the same, and is the inverse of the way there', () => {
        expect(CLASSIFIER_NAME).toEqual({ 'Food & Groceries': 'Groceries', Healthcare: 'Health' });
        for (const [app, server] of Object.entries(CLASSIFIER_NAME)) { expect(expenseEntryName(server)).toBe(app); expect(DROPDOWN).toContain(app); }
        expect(classifierName('Banking')).toBe('Banking');                  // wider than "Bank Charges": it is not turned back into it
    });
    it('a name it does not know, and a value that is not a name, pass through untouched', () => {
        for (const value of ['Dining', 'Other', 'Cash Withdrawal', 'Pets', '', undefined, null, 5, {}, ['Groceries'], '__proto__', 'constructor', 'toString']) expect(expenseEntryName(value)).toBe(value);
        for (const value of ['Groceries', '__proto__', 'constructor', undefined]) expect(classifierName(value)).toBe(value);
    });
    it('every name the classification can give an expense lands on the dropdown (or is a named exception)', () => {
        const notExpenses = new Set([...INCOME_NAMES.filter(name => name !== 'Rent' && name !== 'Gift'), ...CARD_ONLY, 'Needs Review', 'Income']);
        const expenseNames = CLASSIFY_CATEGORIES.filter(name => !notExpenses.has(name));
        expect(expenseNames).toEqual(expect.arrayContaining(['Groceries', 'Health', 'Bank Charges', 'Cash Withdrawal', 'Dining', 'Personal Care', 'Gold', 'Other']));
        const stranded = expenseNames.filter(name => !DROPDOWN.includes(expenseEntryName(name)) && !NO_COUNTERPART.includes(name));
        expect(stranded, 'a classifier category the expense dropdown cannot show — add it to EXPENSE_ENTRY_NAME').toEqual([]);
    });
    it('the merchant list\'s own words (what the page\'s classifier says) land on the dropdown too', () => {
        const registry = ['Telecom', 'Internet', 'Insurance', 'Streaming', 'Software', 'Utilities', 'Groceries', 'Dining', 'Health', 'Transport', 'Fuel', 'Education', 'Government', 'Shopping', 'Gold', 'Gym/Fitness', 'Bank Charges', 'Other'];
        for (const name of registry) expect(DROPDOWN, name).toContain(expenseEntryName(name));
        // Leasing and Cash Advance are not expenses the dropdown names: they keep their word, as before
        for (const name of ['Leasing', 'Cash Advance']) expect(expenseEntryName(name)).toBe(name);
    });
});

/* the ledger, the same harness as test/statement_ledger_test.js */
function fakeDb(initial = {}) {
    const docs = new Map(Object.entries(initial));
    const collection = p => ({ doc: id => ref(p + '/' + id), where: (field, op, value) => ({ query: true, path: p, field, value }) });
    const ref = p => ({ path: p, id: p.split('/').at(-1), collection: name => collection(p + '/' + name) });
    return {
        docs, collection, doc: ref,
        async runTransaction(fn) {
            const pending = []; let writing = false;
            const result = await fn({
                async get(r) { if (writing) throw new Error('read-after-write'); if (r.query) return { docs: [...docs.entries()].filter(([p, data]) => p.startsWith(r.path + '/') && data[r.field] === r.value).map(([p, data]) => ({ id: p.split('/').at(-1), ref: ref(p), data: () => data })) }; const data = docs.get(r.path); return { exists: data !== undefined, id: r.id, data: () => data }; },
                set(r, value, opts) { writing = true; pending.push([r.path, structuredClone(value), opts]); },
            });
            for (const [p, value, opts] of pending) docs.set(p, opts?.merge ? { ...docs.get(p), ...value } : value);
            return result;
        },
    };
}
const filedWith = async (decision, extra = {}) => {
    const db = fakeDb({ 'users/u': {}, 'sources/s': { uid: 'u', cursor: 0, leaseToken: 'token', leaseUntil: 2000, encrypted: 'preserved' } });
    const row = { date: '2026-09-10', amount: 42.10, description: 'Merchant', direction: extra.direction || 'debit', directionSource: 'column', needsReview: false };
    await settleStatement({ db, uid: 'u', sourceRef: db.collection('sources').doc('s'), leaseToken: 'token', now: 1000, rows: [row], decisions: [decision], cursor: 0, totalRows: 1, bank: 'Bank', last4: '1234', ...(extra.card ? { statementType: 'credit_card' } : {}) });
    return db.docs.get('users/u');
};

describe('the ledger files an expense under the dropdown\'s name', () => {
    it.each([['Groceries', 'Food & Groceries'], ['Health', 'Healthcare'], ['Bank Charges', 'Banking'], ['Cash Withdrawal', 'Cash Withdrawal'], ['Dining', 'Dining'], ['Other', 'Other'], ['Food & Groceries', 'Food & Groceries'], ['Pets', 'Pets']])('%s is filed as %s', async (category, stored) => {
        const user = await filedWith({ module: 'expenses', category, verified: true });
        expect(user.expenses).toHaveLength(1);
        expect(user.expenses[0].cat).toBe(stored);
        expect(user.expenses[0].amount).toBe(42.10);                       // a label changes; the money does not
    });
    it('income and card rows keep the words their own tabs use', async () => {
        const income = await filedWith({ module: 'incomeRecv', category: 'Salary', verified: true }, { direction: 'credit' });
        expect(income.incomeRecv[0].type).toBe('Salary');
        const card = await filedWith({ module: 'cconetime', category: 'Card Fee', verified: true }, { card: true });
        expect(card.cconetime[0].category).toBe('Card Fee');
    });
    it('a row filed for review as Other carries its question as before', async () => {
        const user = await filedWith({ module: 'expenses', category: 'Other', verified: true });
        expect(user.expenses[0].cat).toBe('Other');
    });
});

describe('the owner\'s history counts both names as one category', () => {
    const exp = (desc, cat) => ({ desc, cat, amount: 100, date: '2026-05-01' });
    it('a merchant filed once as "Groceries" (a statement) and twice as "Food & Groceries" (typed) is one verdict, not a split', () => {
        const history = buildHistory({ expenses: [exp('GREEN LEAF MART NUGEGODA', 'Groceries'), exp('GREEN LEAF MART NUGEGODA', 'Food & Groceries'), exp('GREEN LEAF MART NUGEGODA', 'Food & Groceries')] }, merchantNameFor);
        expect(history.expense({ narration: 'POS Transaction GREEN LEAF MART NUGEGODA' })).toMatchObject({ category: 'Groceries', count: 3, of: 3 });
    });
    it('the board is told the owner\'s habit in a word it may answer with, and only then', async () => {
        const board = vi.fn().mockRejectedValue(new Error('ai-consensus-unavailable'));
        const row = narration => ({ date: '2026-08-04', narration, description: narration, amount: 1500, direction: 'debit', directionSource: 'column', needsReview: false, valid: true });
        const ctx = (expenses) => { const c = { statementType: 'bank_account', bank: 'NTB' }; Object.defineProperty(c, 'history', { value: buildHistory({ expenses }, merchantNameFor), enumerable: false }); return c; };
        await classifySlice([row('POS Transaction QUIET CORNER STORES')], ctx([exp('QUIET CORNER STORES', 'Food & Groceries')]), { board });
        expect(board.mock.calls[0][0]).toContain('"categoryUsedBefore":"Groceries"');
        board.mockClear();
        await classifySlice([row('POS Transaction QUIET CORNER STORES')], ctx([exp('QUIET CORNER STORES', 'Pets')]), { board });
        expect(board.mock.calls[0][0]).not.toContain('categoryUsedBefore');   // a name the board is not allowed to answer with is not put in front of it
    });
});

/* the page: the editor and the manual upload */
describe('the page\'s expense editor keeps the category of a row it did not file', () => {
    const source = (name) => { const at = HTML.indexOf(`function ${name}(`); expect(at, `${name} is gone from index.html`).toBeGreaterThan(-1); let depth = 0, i = HTML.indexOf('{', at); const start = at; for (; i < HTML.length; i++) { if (HTML[i] === '{') depth++; else if (HTML[i] === '}' && --depth === 0) break; } return HTML.slice(start, i + 1); };
    const select = (names) => {
        const options = names.map(name => ({ value: name, textContent: name, attrs: {}, getAttribute(k) { return this.attrs[k] || null; }, setAttribute(k, v) { this.attrs[k] = v; } }));
        return { options, value: '', removeChild(o) { this.options.splice(this.options.indexOf(o), 1); }, appendChild(o) { this.options.push(o); } };
    };
    const harness = (names = DROPDOWN) => {
        const sel = select(names);
        const sandbox = { $: id => (id === 'e_cat' ? sel : null), document: { createElement: () => ({ attrs: {}, getAttribute(k) { return this.attrs[k] || null; }, setAttribute(k, v) { this.attrs[k] = v; } }) }, window: { WFStatementRouter: { expenseEntryName } }, Array, String };
        vm.createContext(sandbox);
        vm.runInContext(source('setExpenseCategoryChoice'), sandbox);
        return { sel, set: (name) => vm.runInContext(`setExpenseCategoryChoice(${JSON.stringify(name)})`, sandbox) };
    };
    it('an older statement row ("Groceries") opens on its dropdown equivalent', () => {
        const { sel, set } = harness();
        set('Groceries'); expect(sel.value).toBe('Food & Groceries');
        set('Health'); expect(sel.value).toBe('Healthcare');
        expect(sel.options.length).toBe(DROPDOWN.length);
    });
    it('a name the dropdown has no word for is offered while the editor is open, instead of blanking the Category', () => {
        const { sel, set } = harness();
        set('Cash Withdrawal');
        expect(sel.value).toBe('Cash Withdrawal');
        expect(sel.options.filter(o => o.getAttribute('data-stray'))).toHaveLength(1);
        set('Cash Withdrawal');                                              // opened twice: still one
        expect(sel.options.filter(o => o.getAttribute('data-stray'))).toHaveLength(1);
        set('Dining'); expect(sel.value).toBe('Dining');
        expect(sel.options.some(o => o.getAttribute('data-stray'))).toBe(false);   // the next row's editor does not inherit it
    });
    it('a normal category selects itself and adds nothing; an empty one adds nothing', () => {
        const { sel, set } = harness();
        for (const name of DROPDOWN) { set(name); expect(sel.value).toBe(name); }
        set(''); expect(sel.options.length).toBe(DROPDOWN.length);
        set(undefined); expect(sel.options.length).toBe(DROPDOWN.length);
    });
    it('the editor and the form reset use it, closing the expense modal drops the one-off option, and manual upload files under the dropdown\'s name', () => {
        expect(source('editExpense')).toContain('setExpenseCategoryChoice(x.cat)');
        expect(source('clearExpenseForm')).toContain("setExpenseCategoryChoice('Food & Groceries')");
        const close = source('closeModal');
        expect(close).toContain("id === 'mdExpense'");
        expect(close).toContain('data-stray');
        expect(HTML).toMatch(/cat = window\.WFStatementRouter\.expenseEntryName\(cat\)/);
    });
});
