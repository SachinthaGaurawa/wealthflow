import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import vm from 'node:vm';
import router, { EXPENSE_ENTRY_NAME, relabelApply, relabelUndo } from '../wealthflow-statement-router.js';
import { html, source } from './helpers/advisor-page.js';

// OLDER STATEMENT EXPENSES, RENAMED TO THE DROPDOWN'S CATEGORY NAMES - REVERSIBLY.
//
// Before PR #351 a statement row was filed under the classifier's word ("Groceries"); the owner's own expenses use the dropdown's ("Food & Groceries"), so the old rows were a
// separate slice on the dashboard. relabelApply renames exactly those rows (statement-filed, a category in EXPENSE_ENTRY_NAME, not renamed already), keeps the old word on the
// record as `catWas`, and changes nothing else. The page runs it on launch and on every Expenses draw. These tests hold it to: only those rows, every other field identical, the
// total unchanged, nothing mutated, once only, and a way back.

const OLD = Object.keys(EXPENSE_ENTRY_NAME);
const row = (over = {}) => ({ id: 'e1', desc: 'KEELLS SUPER COLOMBO', cat: 'Groceries', amount: 12345.67, date: '2026-08-14', month: '2026-08', source: 'statement', bank: 'HNB', statementKey: 'k/1', statementRow: 3, _ut: 1700000000000, ...over });
const without = (r, ...keys) => { const c = { ...r }; keys.forEach((k) => delete c[k]); return c; };

describe('relabelApply: which rows and what changes', () => {
    it('renames a statement row filed under each classifier word, and keeps the old word on the record', () => {
        for (const from of OLD) {
            const r = row({ cat: from });
            const out = relabelApply([r]);
            expect(out.records[0].cat, from).toBe(EXPENSE_ENTRY_NAME[from]);
            expect(out.records[0].catWas, from).toBe(from);
            expect(out.changes).toEqual([{ id: 'e1', name: 'KEELLS SUPER COLOMBO', amount: 12345.67, from, to: EXPENSE_ENTRY_NAME[from] }]);
        }
    });

    it('changes the category and catWas and nothing else: amount, date, bank, description, provenance are as they were', () => {
        const r = row();
        const out = relabelApply([r]).records[0];
        expect(without(out, 'cat', 'catWas')).toEqual(without(r, 'cat'));
        expect(out.amount).toBe(12345.67);
    });

    it('does not touch the list it was given', () => {
        const list = [row(), row({ id: 'e2', cat: 'Health' })];
        const before = JSON.stringify(list);
        relabelApply(list);
        expect(JSON.stringify(list)).toBe(before);
    });

    it('leaves a row the owner typed (not from a statement) even when it carries a classifier word', () => {
        for (const source of ['manual', undefined, 'sms', '']) {
            const r = row({ source });
            if (source === undefined) delete r.source;
            const out = relabelApply([r]);
            expect(out.changes, String(source)).toEqual([]);
            expect(out.records[0]).toBe(r);
        }
    });

    it('leaves a statement row that is already under a dropdown name, an unmapped one, and the ones that have no counterpart', () => {
        const kept = ['Food & Groceries', 'Healthcare', 'Banking', 'Transport', 'Other', 'Cash Withdrawal', 'Loan Repayment', 'Entertainment', '', 'groceries', 'GROCERIES'].map((cat, i) => row({ id: `k${i}`, cat }));
        const out = relabelApply(kept);
        expect(out.changes).toEqual([]);
        expect(out.records).toEqual(kept);
    });

    it('does it once: a renamed row is skipped, and so is a row that already has a catWas', () => {
        const first = relabelApply([row()]);
        expect(first.changes).toHaveLength(1);
        expect(relabelApply(first.records).changes).toEqual([]);
        expect(relabelApply([row({ catWas: 'Groceries', cat: 'Groceries' })]).changes).toEqual([]);
    });

    it('survives a list with holes and odd entries, and a store that is not a list', () => {
        const odd = [null, undefined, 0, 'x', [], row(), { id: 'n', cat: 5, source: 'statement' }, { id: 'o', source: 'statement' }];
        const out = relabelApply(odd);
        expect(out.changes).toHaveLength(1);
        expect(out.records).toHaveLength(odd.length);
        for (const bad of [undefined, null, 'x', 5, {}]) expect(relabelApply(bad)).toEqual({ records: [], changes: [] });
    });

    it('a list with nothing to rename comes back as the same list', () => {
        const list = [row({ cat: 'Transport' })];
        expect(relabelApply(list).records).toBe(list);
    });

    it('mixed list: only the old statement rows move, order and ids are kept', () => {
        const list = [row({ id: 'a', cat: 'Groceries' }), row({ id: 'b', cat: 'Transport' }), row({ id: 'c', cat: 'Bank Charges' }), row({ id: 'd', cat: 'Groceries', source: 'manual' }), row({ id: 'e', cat: 'Gym/Fitness' })];
        const out = relabelApply(list);
        expect(out.records.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(out.records.map((r) => r.cat)).toEqual(['Food & Groceries', 'Transport', 'Banking', 'Groceries', 'Personal Care']);
        expect(out.changes.map((c) => c.id)).toEqual(['a', 'c', 'e']);
    });

    it('property: whatever the mix, the count, the ids, the amounts and the total are unchanged and only cat / catWas differ', () => {
        const cat = fc.constantFrom(...OLD, 'Food & Groceries', 'Transport', 'Other', 'Cash Withdrawal', 'Healthcare');
        const rec = fc.record({ id: fc.string({ minLength: 1, maxLength: 6 }), cat, amount: fc.integer({ min: 0, max: 5_000_000 }).map((n) => n / 100), source: fc.constantFrom('statement', 'manual', 'statement'), desc: fc.string({ maxLength: 12 }) });
        fc.assert(fc.property(fc.array(rec, { maxLength: 40 }), (list) => {
            const out = relabelApply(list);
            expect(out.records).toHaveLength(list.length);
            const sum = (a) => Math.round(a.reduce((s, r) => s + r.amount * 100, 0));
            expect(sum(out.records)).toBe(sum(list));
            out.records.forEach((r, i) => {
                expect(r.id).toBe(list[i].id);
                expect(r.amount).toBe(list[i].amount);
                expect(without(r, 'cat', 'catWas')).toEqual(without(list[i], 'cat', 'catWas'));
            });
            expect(relabelApply(out.records).changes).toEqual([]);
            expect(relabelUndo(out.records).records.map((r) => without(r, 'catWas'))).toEqual(list.map((r) => without(r, 'catWas')));
        }), { numRuns: 200 });
    });
});

describe('relabelUndo: the way back', () => {
    it('puts every old word back exactly as it was, and removes the note', () => {
        const list = OLD.map((cat, i) => row({ id: `r${i}`, cat }));
        const renamed = relabelApply(list).records;
        const back = relabelUndo(renamed);
        expect(back.records).toEqual(list);
        expect(back.changes).toHaveLength(list.length);
        expect(back.records.every((r) => !('catWas' in r))).toBe(true);
    });

    it('leaves a row the owner has changed since (its category is no longer the one we set)', () => {
        const renamed = relabelApply([row({ id: 'a' }), row({ id: 'b' })]).records;
        const edited = [renamed[0], { ...renamed[1], cat: 'Dining' }];
        const back = relabelUndo(edited);
        expect(back.records[0].cat).toBe('Groceries');
        expect(back.records[1]).toBe(edited[1]);
        expect(back.changes.map((c) => c.id)).toEqual(['a']);
    });

    it('ignores a catWas that is not one of the old words, and rows with none', () => {
        const list = [row({ cat: 'Food & Groceries', catWas: 'Whatever' }), row({ id: 'z' }), null];
        const back = relabelUndo(list);
        expect(back.changes).toEqual([]);
        expect(back.records).toBe(list);
        expect(relabelUndo(undefined)).toEqual({ records: [], changes: [] });
    });
});

describe('the page: _migrateStatementCategoryNames and the undo, as index.html has them', () => {
    function pageWith(expenses, { off = false, decoy = false, routerOn = true, getItemThrows = false } = {}) {
        const store = { expenses };
        const ls = new Map(off ? [['wf2_catrelabel_off', '1']] : []);
        const calls = { notify: [], dirty: 0, sets: [] };
        const ctx = {
            DB: { get: (k) => store[k] || [], set: (k, v) => { calls.sets.push(k); store[k] = v; } },
            localStorage: { getItem: (k) => { if (getItemThrows) throw new Error('blocked'); return ls.has(k) ? ls.get(k) : null; }, setItem: (k, v) => ls.set(k, v) },
            _persistRaw: (k, v) => { ls.set(k, String(v)); return true; },
            setDirty: () => { calls.dirty += 1; },
            notify: (m, t) => calls.notify.push([m, t]),
            JSON, Object, Array, String, Date, console: { log() {}, warn() {}, error() {} },
        };
        ctx.window = ctx;
        if (decoy) ctx._isDecoyMode = true;
        if (routerOn) ctx.WFStatementRouter = router;
        vm.createContext(ctx);
        vm.runInContext(`${source('_migrateStatementCategoryNames')}\n${source('_wfUndoStatementCategoryRelabel')}\nwindow._wfUndoStatementCategoryRelabel = _wfUndoStatementCategoryRelabel;`, ctx);
        return { ctx, store, ls, calls, run: () => vm.runInContext('_migrateStatementCategoryNames()', ctx), undo: () => vm.runInContext('_wfUndoStatementCategoryRelabel()', ctx) };
    }
    const books = () => [row({ id: 'a' }), row({ id: 'b', cat: 'Bank Charges', amount: 250 }), row({ id: 'c', cat: 'Transport' }), row({ id: 'd', source: 'manual' }), row({ id: 'e', cat: 'Health', amount: 4200.5 })];

    it('renames the old statement rows once, says how many and what, and keeps a copy on the device', () => {
        const original = books();
        const p = pageWith(JSON.parse(JSON.stringify(original)));
        expect(p.run()).toBe(3);
        expect(p.store.expenses.map((r) => r.cat)).toEqual(['Food & Groceries', 'Banking', 'Transport', 'Groceries', 'Healthcare']);
        expect(p.calls.sets).toEqual(['expenses']);
        expect(p.calls.dirty).toBe(1);
        expect(p.calls.notify).toHaveLength(1);
        expect(p.calls.notify[0][0]).toMatch(/^Renamed 3 older statement expenses to your category names/);
        expect(p.calls.notify[0][0]).toContain('Groceries -> Food & Groceries');
        expect(p.calls.notify[0][0]).toContain('Amounts are unchanged');
        const backup = JSON.parse(p.ls.get('wf2_catrelabel_backup'));
        expect(backup).toHaveLength(1);
        expect(backup[0].changes.map((c) => [c.id, c.from, c.to, c.amount])).toEqual([['a', 'Groceries', 'Food & Groceries', 12345.67], ['b', 'Bank Charges', 'Banking', 250], ['e', 'Health', 'Healthcare', 4200.5]]);
        const sum = (a) => Math.round(a.reduce((s, r) => s + r.amount * 100, 0));
        expect(sum(p.store.expenses)).toBe(sum(original));
    });

    it('a second run, and a run on every Expenses draw, changes and says nothing', () => {
        const p = pageWith(books());
        p.run();
        const after = JSON.stringify(p.store.expenses);
        p.calls.notify.length = 0; p.calls.sets.length = 0;
        expect(p.run()).toBe(0);
        expect(p.run()).toBe(0);
        expect(JSON.stringify(p.store.expenses)).toBe(after);
        expect(p.calls.notify).toEqual([]);
        expect(p.calls.sets).toEqual([]);
        expect(JSON.parse(p.ls.get('wf2_catrelabel_backup'))).toHaveLength(1);
    });

    it('says "expense" for one row', () => {
        const p = pageWith([row()]);
        p.run();
        expect(p.calls.notify[0][0]).toMatch(/^Renamed 1 older statement expense to your category names/);
    });

    it('does nothing in decoy mode, when switched off, when the rule did not load, or with no expenses', () => {
        for (const opts of [{ decoy: true }, { off: true }, { routerOn: false }]) {
            const p = pageWith(books(), opts);
            expect(p.run(), JSON.stringify(opts)).toBe(0);
            expect(p.calls.sets).toEqual([]);
            expect(p.store.expenses.map((r) => r.cat)).toEqual(books().map((r) => r.cat));
        }
        expect(pageWith([]).run()).toBe(0);
        expect(pageWith(undefined).run()).toBe(0);
    });

    it('never throws, even when storage is blocked', () => {
        const p = pageWith(books(), { getItemThrows: true });
        expect(() => p.run()).not.toThrow();
        expect(p.run()).toBe(0);
    });

    it('the undo puts every row back exactly as it was and switches the rename off for good', () => {
        const original = books();
        const p = pageWith(JSON.parse(JSON.stringify(original)));
        p.run();
        expect(p.undo()).toBe(3);
        expect(p.store.expenses).toEqual(original);
        expect(p.ls.get('wf2_catrelabel_off')).toBe('1');
        expect(p.run()).toBe(0);
        expect(p.store.expenses).toEqual(original);
        expect(typeof p.ctx.window._wfUndoStatementCategoryRelabel).toBe('function');
    });
});

describe('the page is wired to it', () => {
    it('runs on launch beside the bank-name migration, and at the start of every Expenses draw', () => {
        expect(html).toMatch(/try \{ _migrateBankNames\(\); \} catch \(e\) \{[^\n]*\}\n\s+try \{ _migrateStatementCategoryNames\(\); \}/);
        expect(html).toMatch(/function renderExpenses\(\) \{\n\s+try \{ _migrateStatementCategoryNames\(\); \} catch \(_\) \{\}/);
    });
    it('does not rename banks', () => {
        const fn = source('_migrateStatementCategoryNames');
        expect(fn).not.toMatch(/\.bank\b|canonicalBank|_canonBank/);
    });
    it('the router carries the rule and exports it', () => {
        expect(typeof router.relabelApply).toBe('function');
        expect(typeof router.relabelUndo).toBe('function');
        expect(vi.isMockFunction(router.relabelApply)).toBe(false);
    });
});
