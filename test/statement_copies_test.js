import { describe, expect, it } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { statementCopies, touched } from '../statement-copies.mjs';
import { healStatementCopies } from '../statement-sync.js';
import { crossSourceMatches } from '../statement-ledger.mjs';

// Production, 2026-10-02: 61 NTB transactions filed from two statements. A statement labelled March 2026 carried rows of December, January and February (17, 9, 12) and 23 rows another March statement holds.
// The books keep each transaction once, from the statement of its own month.

const PATH = id => `wf-mail/owner_example_com/items/${id}`;
const rec = (id, source, date, amount, desc, extra = {}) => { const made = { id, source: 'statement', statementKey: PATH(source), statementRow: 1, date, month: date.slice(0, 7), amount, desc, bank: 'NTB', card_last4: '8057', direction: 'debit', cat: 'Other', createdAt: '2026-10-01T10:00:00.000Z', ...extra }; return { ...made, _ut: 'ut' in extra ? extra.ut : Number(extra._ut) || Date.parse(made.createdAt) }; };
const labels = { quarter: '2026-03', dec: '2025-12', mar: '2026-03' };
const labelOf = key => labels[key.split('/').pop()] || '';

describe('which records are copies', () => {
    it('rows of another month inside a statement labelled March go; the statement of their own month keeps them', () => {
        const user = { expenses: [
            rec('d1', 'dec', '2025-12-04', 1500, 'KEELLS'), rec('d2', 'quarter', '2025-12-04', 1500, 'KEELLS', { createdAt: '2026-09-30T10:00:00.000Z' }),
            rec('m1', 'mar', '2026-03-05', 800, 'FUEL'), rec('m2', 'quarter', '2026-03-05', 800, 'FUEL', { createdAt: '2026-10-02T10:00:00.000Z' }),
            rec('o', 'quarter', '2026-02-02', 999, 'ONLY HERE'),
        ] };
        const out = statementCopies(user, { labelOf });
        expect(out.remove.map(entry => entry.record.id).sort()).toEqual(['d2', 'm2'].sort());
        expect(out.remove.find(entry => entry.record.id === 'd2').keep.id).toBe('d1');           // the December statement keeps December
        expect(out.remove.find(entry => entry.record.id === 'm2').keep.id).toBe('m1');           // March, held twice: the one with the March label, then the one filed first
        expect(out.groups).toBe(2);
    });
    it('the books keep as many as the most any one statement shows: two identical fares are two', () => {
        const user = { expenses: [rec('a1', 'dec', '2025-12-04', 150, 'BUS'), rec('a2', 'dec', '2025-12-04', 150, 'BUS'), rec('b1', 'quarter', '2025-12-04', 150, 'BUS'), rec('b2', 'quarter', '2025-12-04', 150, 'BUS')] };
        expect(statementCopies(user, { labelOf }).remove.map(entry => entry.record.id).sort()).toEqual(['b1', 'b2']);
        const more = { expenses: [rec('a1', 'dec', '2025-12-04', 150, 'BUS'), rec('b1', 'quarter', '2025-12-04', 150, 'BUS'), rec('b2', 'quarter', '2025-12-04', 150, 'BUS')] };
        expect(statementCopies(more, { labelOf }).remove).toHaveLength(1);       // three would be wrong: the quarter shows two
    });
    it('the same words under two bank labels are the same bank; another account, direction, amount, store or words are not the same transaction', () => {
        const base = [rec('x1', 'dec', '2025-12-04', 150, 'BUS', { bank: 'Hnb' })];
        expect(statementCopies({ expenses: [...base, rec('x2', 'quarter', '2025-12-04', 150, 'BUS', { bank: 'HNB' })] }, { labelOf }).remove).toHaveLength(1);
        for (const other of [{ card_last4: '1111' }, { direction: 'credit' }, { amount: 151 }, { desc: 'TAXI' }, { date: '2025-12-05' }]) {
            const { amount = 150, desc = 'BUS', date = '2025-12-04', ...rest } = other;
            expect(statementCopies({ expenses: [...base, rec('x2', 'quarter', date, amount, desc, { bank: 'HNB', ...rest })] }, { labelOf }).remove).toHaveLength(0);
        }
        expect(statementCopies({ expenses: base, incomeRecv: [rec('x2', 'quarter', '2025-12-04', 150, 'BUS', { bank: 'HNB' })] }, { labelOf }).remove).toHaveLength(0);
    });
    it('one statement alone, a record tied to a loan or a subscription, and a record not from a statement are never copies', () => {
        expect(statementCopies({ expenses: [rec('a', 'dec', '2025-12-04', 150, 'BUS'), rec('b', 'dec', '2025-12-04', 150, 'BUS')] }, { labelOf }).remove).toHaveLength(0);
        expect(statementCopies({ expenses: [rec('a', 'dec', '2025-12-04', 150, 'BUS'), rec('b', 'quarter', '2025-12-04', 150, 'BUS', { loanLink: { loanId: 'L', month: '2025-12' } })] }, { labelOf }).remove).toHaveLength(0);
        expect(statementCopies({ expenses: [rec('a', 'dec', '2025-12-04', 150, 'BUS'), { id: 't', desc: 'BUS', amount: 150, date: '2025-12-04' }] }, { labelOf }).remove).toHaveLength(0);
    });
    it('a record the owner has touched is never taken out — it is kept, and a group that would take it out is left to them', () => {
        const edited = { createdAt: '2026-09-30T10:00:00.000Z', _ut: Date.parse('2026-10-02T10:00:00.000Z'), cat: 'Groceries' };
        expect(touched(rec('e', 'quarter', '2025-12-04', 1500, 'KEELLS', edited))).toBe(true);
        const user = { expenses: [rec('d1', 'dec', '2025-12-04', 1500, 'KEELLS'), rec('e', 'quarter', '2025-12-04', 1500, 'KEELLS', edited)] };
        const out = statementCopies(user, { labelOf });
        expect(out.remove.map(entry => entry.record.id)).toEqual(['d1']);        // their edited copy is the one kept: the system's own is the copy
        const both = { expenses: [rec('d1', 'dec', '2025-12-04', 1500, 'KEELLS', edited), rec('e', 'quarter', '2025-12-04', 1500, 'KEELLS', edited)] };
        expect(statementCopies(both, { labelOf })).toMatchObject({ remove: [], left: 1 });
    });
});

describe('a row already filed is recognised in another statement even when a bank writes it a little differently', () => {
    const filed = { id: 'f1', desc: 'POS KEELLS COLOMBO', amount: 1500, date: '2026-03-05', bank: 'Hnb', card_last4: '8057', ref: '', direction: 'debit', statementKey: 'k', source: 'statement' };
    const row = (extra = {}) => ({ description: 'POS KEELLS COLOMBO', amount: 1500, date: '2026-03-05', direction: 'debit', card_last4: '8057', ref: '', ...extra });
    it('another bank spelling, and a reference only one of them prints', () => {
        expect(crossSourceMatches([filed], row(), { bank: 'HNB', last4: '8057' })).toHaveLength(1);
        expect(crossSourceMatches([filed], row({ ref: 'FT26064ABC' }), { bank: 'HNB', last4: '8057' })).toHaveLength(1);
        expect(crossSourceMatches([{ ...filed, ref: 'FT26064ABC' }], row(), { bank: 'HNB', last4: '8057' })).toHaveLength(1);
    });
    it('two different references, another account, another bank, another amount: not the same', () => {
        expect(crossSourceMatches([{ ...filed, ref: 'AAA111' }], row({ ref: 'BBB222' }), { bank: 'HNB', last4: '8057' })).toHaveLength(0);
        expect(crossSourceMatches([filed], row({ card_last4: '1111' }), { bank: 'HNB', last4: '1111' })).toHaveLength(0);
        expect(crossSourceMatches([filed], row(), { bank: 'NTB', last4: '8057' })).toHaveLength(0);
        expect(crossSourceMatches([filed], row({ amount: 1500.5 }), { bank: 'HNB', last4: '8057' })).toHaveLength(0);
    });
});

describe('the heal takes the copies out of the books', () => {
    const mailPath = 'wf-mail/owner_example_com';
    const world = (user) => createFirestore({
        [mailPath]: { uid: 'u', email: 'owner@example.com' },
        [`${mailPath}/items/dec`]: { uid: 'u', bank: 'NTB', status: 'filed', filename: 'Consolidated_eStatement_2025DEC_458290.html', receivedMs: Date.parse('2026-01-02T00:00:00Z') },
        [`${mailPath}/items/quarter`]: { uid: 'u', bank: 'NTB', status: 'filed', filename: 'Consolidated_eStatement_2026MAR_458290.html', receivedMs: Date.parse('2026-04-02T00:00:00Z') },
        'users/u': user,
        'users/u/statementLedger/d2': { sourcePath: PATH('quarter'), status: 'filed', module: 'expenses', id: 'd2' },
    });
    const run = (w, extra = {}) => { const lines = []; return healStatementCopies({ db: w.db, mailRef: w.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', log: l => lines.push(l), ...extra }).then(out => ({ ...out, lines })); };
    it('removes the copy with a tombstone and a ledger note, keeps the statement of the record\'s own month, logs counts only', async () => {
        const w = world({ expenses: [rec('d1', 'dec', '2025-12-04', 1500, 'KEELLS'), rec('d2', 'quarter', '2025-12-04', 1500, 'KEELLS'), rec('t', 'quarter', '2026-03-09', 40, 'TYPED BY HAND', { source: undefined, statementKey: undefined })], _tomb: {} });
        const out = await run(w);
        expect(out).toMatchObject({ removed: 1, more: false });
        expect(w.data.get('users/u').expenses.map(r => r.id)).toEqual(['d1', 't']);
        expect(w.data.get('users/u')._tomb.expenses.d2).toEqual(expect.any(Number));
        expect(w.data.get('users/u/statementLedger/d2')).toMatchObject({ status: 'duplicate', matchedId: 'd1', reason: 'copy-of-another-statement' });
        expect(JSON.parse(out.lines[0])).toMatchObject({ evt: 'statement-copies-removed', removed: 1, groups: 1, banks: { NTB: 1 } });
        expect(out.lines[0]).not.toMatch(/KEELLS|1500/i);
    });
    it('a second pass finds nothing; one statement alone writes nothing', async () => {
        const w = world({ expenses: [rec('d1', 'dec', '2025-12-04', 1500, 'KEELLS'), rec('d2', 'quarter', '2025-12-04', 1500, 'KEELLS')] });
        await run(w);
        const before = structuredClone(w.data.get('users/u'));
        expect(await run(w)).toMatchObject({ removed: 0, more: false });
        expect(w.data.get('users/u')).toEqual(before);
        const alone = world({ expenses: [rec('d1', 'dec', '2025-12-04', 1500, 'KEELLS')] });
        expect(await run(alone)).toEqual({ removed: 0, more: false, lines: [] });
    });
    it('at most `limit` a pass, and says there is more', async () => {
        const expenses = Array.from({ length: 5 }, (_, i) => [rec(`a${i}`, 'dec', '2025-12-04', 1000 + i, 'KEELLS'), rec(`b${i}`, 'quarter', '2025-12-04', 1000 + i, 'KEELLS')]).flat();
        const w = world({ expenses });
        expect(await run(w, { limit: 2 })).toMatchObject({ removed: 2, more: true });
        expect(await run(w, { limit: 10 })).toMatchObject({ removed: 3, more: false });
        expect(w.data.get('users/u').expenses).toHaveLength(5);
    });
});
