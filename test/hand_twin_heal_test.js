import { describe, expect, it } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { healHandMadeTwins } from '../statement-sync.js';

// A payment the owner typed AFTER the statement filed it (catching up on the month), a card statement's purchase beside the same purchase typed as an ordinary expense, and a recurring entry beside
// the statement's row for it were counted twice. The owner's entry stays (their category, their notes); the system's copy goes — and nothing the owner typed is ever deleted.

const filed = (id, desc, amount, date, extra = {}) => ({ id, desc, amount, date, month: date.slice(0, 7), cat: 'Other', source: 'statement', statementKey: 'wf-mail/x/items/a', statementRow: 3, direction: 'debit', autoDecided: 'x', ...extra });
const typed = (id, desc, amount, date, extra = {}) => ({ id, desc, amount, date, month: date.slice(0, 7), cat: 'Groceries', notes: 'my own note', ...extra });
const world = (user) => createFirestore({ 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ...user },
    'users/u/statementLedger/s1': { status: 'filed', module: 'expenses', id: 's1', sourcePath: 'wf-mail/x/items/a' } });
const run = (w, extra = {}) => { const lines = []; return healHandMadeTwins({ db: w.db, uid: 'u', log: l => lines.push(l), ...extra }).then(out => ({ ...out, lines })); };
const ids = (w, key) => w.data.get('users/u')[key].map(r => r.id);

describe('the system\'s copy of a payment the owner typed is taken out; the owner\'s entry stays', () => {
    it('typed after the statement filed it: the same amount, the same day or a shared word within three days', async () => {
        const w = world({ expenses: [filed('s1', 'KEELLS SUPER COLOMBO', 4200, '2026-03-05'), typed('m1', 'Keells', 4200, '2026-03-04')] });
        const out = await run(w);
        expect(out).toMatchObject({ merged: 1, more: false });
        expect(ids(w, 'expenses')).toEqual(['m1']);
        expect(w.data.get('users/u').expenses[0]).toMatchObject({ cat: 'Groceries', notes: 'my own note', statementTwin: { sourcePath: 'wf-mail/x/items/a', date: '2026-03-05', cents: 420000, direction: 'debit' } });
        expect(w.data.get('users/u')._tomb.expenses.s1).toEqual(expect.any(Number));
        expect(w.data.get('users/u/statementLedger/s1')).toMatchObject({ status: 'duplicate', matchedId: 'm1', reason: 'entered-by-hand' });
        expect(JSON.parse(out.lines[0])).toMatchObject({ evt: 'hand-twin-heal', merged: 1 });
        expect(out.lines[0]).not.toMatch(/KEELLS|4200/i);
    });
    it('a card statement\'s purchase beside the same purchase typed as an ordinary expense', async () => {
        const w = world({ cconetime: [filed('c1', 'KEELLS SUPER COLOMBO', 3000, '2026-03-04', { card_last4: '0276' })], expenses: [typed('m1', 'Keells', 3000, '2026-03-03')] });
        expect(await run(w)).toMatchObject({ merged: 1 });
        expect(ids(w, 'cconetime')).toEqual([]);
        expect(ids(w, 'expenses')).toEqual(['m1']);
    });
    it('salary typed and then credited', async () => {
        const w = world({ incomeRecv: [{ id: 'r1', name: 'SALARY CREDIT ACME', amount: 250000, date: '2026-03-25', month: '2026-03', received: true, type: 'Other', source: 'statement', statementKey: 'wf-mail/x/items/a', direction: 'credit' }, { id: 'm1', name: 'Salary', amount: 250000, date: '2026-03-23', month: '2026-03', received: true, type: 'Salary' }] });
        expect(await run(w)).toMatchObject({ merged: 1 });
        expect(ids(w, 'incomeRecv')).toEqual(['m1']);
    });
    it('a recurring entry stands for its month: the statement\'s rent row for a month it covers is taken out, once per month', async () => {
        const rent = typed('rent', 'House rent', 50000, '2026-01-03', { recurring: true });
        const w = world({ expenses: [rent, filed('s1', 'RENT PAYMENT LANDLORD', 50000, '2026-03-03'), filed('s2', 'RENT PAYMENT LANDLORD', 50000, '2026-04-03')] });
        expect(await run(w)).toMatchObject({ merged: 2 });
        expect(ids(w, 'expenses')).toEqual(['rent']);
        expect(Object.keys(w.data.get('users/u').expenses[0].statementTwins).sort()).toEqual(['2026-03', '2026-04']);
    });
});

describe('what is not the same payment is left alone', () => {
    it('no word in common and not the same day: two different payments of one amount both stay', async () => {
        const w = world({ expenses: [filed('s1', 'ATM WITHDRAWAL COLOMBO', 1000, '2026-03-05'), typed('m1', 'Lunch', 1000, '2026-03-04')] });
        expect(await run(w)).toMatchObject({ merged: 0 });
        expect(ids(w, 'expenses')).toEqual(['s1', 'm1']);
    });
    it('with no word in common but the same day, the heal needs the day to agree — and it does', async () => {
        const w = world({ expenses: [filed('s1', 'ATM WITHDRAWAL COLOMBO', 1000, '2026-03-05'), typed('m1', 'Lunch', 1000, '2026-03-05')] });
        expect(await run(w)).toMatchObject({ merged: 1 });
    });
    it('a week apart, or another amount, or another direction: never', async () => {
        for (const other of [typed('m1', 'Keells', 4200, '2026-03-12'), typed('m1', 'Keells', 4200.5, '2026-03-05')]) {
            const w = world({ expenses: [filed('s1', 'KEELLS SUPER', 4200, '2026-03-05'), other] });
            expect((await run(w)).merged).toBe(0);
        }
        const w = world({ expenses: [filed('s1', 'KEELLS SUPER', 4200, '2026-03-05')], incomeRecv: [{ id: 'm1', name: 'Keells', amount: 4200, date: '2026-03-05', month: '2026-03', received: true }] });
        expect((await run(w)).merged).toBe(0);
    });
    it('two statement records for one typed entry, or two typed entries for one record, are never guessed between', async () => {
        const two = world({ expenses: [filed('s1', 'KEELLS SUPER', 4200, '2026-03-05'), filed('s2', 'KEELLS SUPER', 4200, '2026-03-05'), typed('m1', 'Keells', 4200, '2026-03-05')] });
        expect((await run(two)).merged).toBe(0);
        const both = world({ expenses: [filed('s1', 'KEELLS SUPER', 4200, '2026-03-05'), typed('m1', 'Keells', 4200, '2026-03-05'), typed('m2', 'Keells', 4200, '2026-03-05')] });
        expect((await run(both)).merged).toBe(0);
        expect(ids(both, 'expenses')).toEqual(['s1', 'm1', 'm2']);
    });
    it('a record tied to a loan or a subscription, and a typed entry already tied to a row, are never touched', async () => {
        const w = world({ expenses: [filed('s1', 'HNB LOAN INSTALMENT', 45000, '2026-03-05', { loanLink: { loanId: 'L1', month: '2026-03' } }), typed('m1', 'HNB loan', 45000, '2026-03-05'),
            filed('s2', 'KEELLS SUPER', 4200, '2026-03-05'), typed('m2', 'Keells', 4200, '2026-03-05', { statementTwin: { sourcePath: 'wf-mail/x/items/z', index: 1 } })] });
        expect((await run(w)).merged).toBe(0);
    });
    it('nothing the owner typed is ever deleted, and a second pass finds nothing to do', async () => {
        const w = world({ expenses: [filed('s1', 'KEELLS SUPER COLOMBO', 4200, '2026-03-05'), typed('m1', 'Keells', 4200, '2026-03-05'), typed('m2', 'Petrol', 9000, '2026-03-06')] });
        await run(w);
        expect(ids(w, 'expenses')).toEqual(['m1', 'm2']);
        const before = structuredClone(w.data.get('users/u'));
        expect(await run(w)).toMatchObject({ merged: 0 });
        expect(w.data.get('users/u')).toEqual(before);
    });
    it('nothing to reconcile without both kinds of record: no write at all', async () => {
        const w = world({ expenses: [typed('m1', 'Keells', 4200, '2026-03-05')] });
        expect(await run(w)).toEqual({ merged: 0, more: false, lines: [] });
    });
});
