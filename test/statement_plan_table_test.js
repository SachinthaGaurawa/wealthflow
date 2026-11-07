import { describe, it, expect } from 'vitest';
import { readPlanTable, planFor } from '../statement-plan-table.mjs';
import { healCardFeeType, healFeePlans } from '../statement-sync.js';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';

const P = loadParser(fs);

// Invented shops and money; the shape is what a card statement's "Your Instalment Purchases" table prints.
const TABLE = ['Your Instalment Purchases', 'Total Months Total Amount Remaining Months Remaining Amount',
    '1111111/SAMPLE STORE ONE (LAN 12 60,001.20 9 45,000.90', '2222222/SAMPLE STORE TWO (LAN 12 10,800.00 9 8,100.00', '3333333/SAMPLE STORE THREE 6 6,000.00 2 2,000.00'].join('\n');

describe('the plan table a card statement prints', () => {
    it('reads every consistent row, with the cut-off "(LAN" taken off the name', () => {
        expect(readPlanTable(TABLE)).toEqual([
            { ref: '1111111', name: 'SAMPLE STORE ONE', months: 12, total: 60001.2, remainingMonths: 9, remainingAmount: 45000.9 },
            { ref: '2222222', name: 'SAMPLE STORE TWO', months: 12, total: 10800, remainingMonths: 9, remainingAmount: 8100 },
            { ref: '3333333', name: 'SAMPLE STORE THREE', months: 6, total: 6000, remainingMonths: 2, remainingAmount: 2000 }]);
    });
    it('leaves out a row whose months and money disagree, and text that is not a table', () => {
        expect(readPlanTable('4444444/SAMPLE STORE FOUR 12 12,000.00 9 1,000.00')).toEqual([]);
        expect(readPlanTable('23/10/2026 24/10/2026 Instalment Principle - 3/12 5,000.10')).toEqual([]);
        expect(readPlanTable('')).toEqual([]);
    });
    it('attaches a charge to the one row whose monthly money it is, and never guesses between two', () => {
        const table = readPlanTable(TABLE);
        expect(planFor(table, 5000.1, 12).name).toBe('SAMPLE STORE ONE');
        expect(planFor(table, 900, 12).name).toBe('SAMPLE STORE TWO');
        expect(planFor(table, 1000, 6).name).toBe('SAMPLE STORE THREE');
        expect(planFor(table, 777, 12)).toBeNull();
        expect(planFor(table, 5000.1, 6)).toBeNull();                       // the line says six months; that row is twelve
        const twins = readPlanTable('1/A 12 1,200.00 9 900.00\n'.replace('1/A', '5555555/ALPHA') + '6666666/BETA 12 1,200.00 9 900.00');
        expect(twins).toHaveLength(2); expect(planFor(twins, 100, 12)).toBeNull();
    });
});

describe('the "CR" printed before an amount is the flag, not the description', () => {
    it('a credit marked CR keeps a clean description and its direction', () => {
        const text = ['Credit Card Statement', 'Card Number 4000 0000 0000 5678', 'Statement Period 30 Sep 2026 / 31 Oct 2026', 'Opening Balance 100,000.00',
            '16/10/2026 16/10/2026 Payment 004 CR 20,000.00', '22/10/2026 21/10/2026 SAMPLE PIZZA-TOWN, TOWN 1,500.25'].join('\n');
        const rows = P.parseStatement(text).rows;
        expect(rows[0]).toMatchObject({ narration: 'Payment 004', direction: 'credit', directionSource: 'marker' });
        expect(rows[1].narration).toBe('SAMPLE PIZZA-TOWN, TOWN');
    });
});

describe('card fees filed before the type followed the category', () => {
    function db(cconetime) {
        const doc = { cconetime };
        const ref = { get: async () => ({ data: () => doc }) };
        return { doc, collection: () => ({ doc: () => ref }), runTransaction: async fn => fn({ get: async () => ({ data: () => doc }), set: (_ref, value) => Object.assign(doc, value) }) };
    }
    it('retypes only the statement\'s own Card Fee rows that say Purchase', async () => {
        const store = db([
            { id: 'a', source: 'statement', category: 'Card Fee', type: 'purchase', desc: 'Interest', amount: 10 },
            { id: 'b', source: 'statement', category: 'Dining', type: 'purchase', desc: 'Cafe', amount: 20 },
            { id: 'c', source: 'manual', category: 'Card Fee', type: 'purchase', desc: 'typed by hand', amount: 30 },
            { id: 'd', source: 'statement', category: 'Card Fee', type: 'cash_advance', desc: 'chosen', amount: 40 }]);
        expect(await healCardFeeType({ db: store, uid: 'u', log: () => {} })).toEqual({ healed: 1 });
        expect(store.doc.cconetime.map(record => record.type)).toEqual(['service_fee', 'purchase', 'purchase', 'cash_advance']);
        expect(await healCardFeeType({ db: store, uid: 'u', log: () => {} })).toEqual({ healed: 0 });
    });
});

describe('an interest line that was filed as an instalment plan', () => {
    function db(doc) {
        const ref = { get: async () => ({ data: () => doc }) };
        return { doc, collection: () => ({ doc: () => ref }), runTransaction: async fn => fn({ get: async () => ({ data: () => doc }), set: (_ref, value) => Object.assign(doc, value) }) };
    }
    const paid = (month, amount, row) => ({ month, paid: true, amount, paidAt: Date.parse(`${month}-28T00:00:00Z`), source: 'statement', statementKey: `k/${month}`, statementRow: row });
    const plan = (id, desc, extra = {}) => ({ id, desc, product: desc, source: 'statement', statementKey: 'k/2026-08', bank: 'HNB', monthly: 800, total: 9600, payments: [paid('2026-08', 800, 3), paid('2026-09', 760.5, 4), paid('2026-10', 712.25, 2)], ...extra });
    it('becomes one Service Fee per month at that month\'s printed amount; real plans and hand-made plans stay', async () => {
        const store = db({ cconetime: [], ccinstall: [plan('p1', 'Instalment Interest - 3/12'), plan('p2', 'Instalment Principle - 3/12'), plan('p3', 'Interest', { source: 'manual', statementKey: '' }), plan('p4', '0% Interest Free Instalment 3/12 SAMPLE SHOP')] });
        expect(await healFeePlans({ db: store, uid: 'u', log: () => {} })).toEqual({ moved: 3, plans: 1 });
        expect(store.doc.cconetime.map(f => [f.date, f.amount, f.type, f.category])).toEqual([['2026-08-28', 800, 'service_fee', 'Card Fee'], ['2026-09-28', 760.5, 'service_fee', 'Card Fee'], ['2026-10-28', 712.25, 'service_fee', 'Card Fee']]);
        expect(store.doc.ccinstall.filter(p => p.mergedInto).map(p => p.id)).toEqual(['p1']);
        expect(store.doc.ccinstall.find(p => p.id === 'p1').payments).toHaveLength(3);      // nothing is deleted
        expect(await healFeePlans({ db: store, uid: 'u', log: () => {} })).toEqual({ moved: 0 });
        expect(store.doc.cconetime).toHaveLength(3);
    });
});
