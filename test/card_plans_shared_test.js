/* One plan rule for both doors (2026-11-11): the plan table / plan record / plan matching live in wealthflow-card-plans.js, which the page loads and the worker imports. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as shared from '../wealthflow-card-plans.js';
import * as table from '../statement-plan-table.mjs';
import * as links from '../statement-links.mjs';
import { settleStatement } from '../statement-ledger.mjs';

describe('the worker files read the shared plan module', () => {
    it('the plan table functions are the shared ones', () => {
        expect(table.readPlanTable).toBe(shared.readPlanTable);
        expect(table.planFor).toBe(shared.planFor);
        expect(table.planEconomics).toBe(shared.planEconomics);
    });
    it('the plan matching functions are the shared ones', () => {
        expect(links.matchInstallmentPlan).toBe(shared.matchInstallmentPlan);
        expect(links.applyPlanPayment).toBe(shared.applyPlanPayment);
        expect(links.planFromLine).toBe(shared.planFromLine);
        expect(typeof settleStatement).toBe('function');
    });
});

describe('cardPlanRecord', () => {
    const row = { amount: 10000, date: '2026-08-06', description: 'SINGER 12M NATIONS PAY INST 1 - REM BAL - 110000.00 - <1/12>', direction: 'debit' };
    const table1 = shared.readPlanTable('SINGER 12M NATIONS PAY 120,000.00 110,000.00 11/12 10,000.00')[0];
    const make = (r) => shared.cardPlanRecord({ row: r, desc: r.description, decision: { module: 'ccinstall', category: 'Installment' }, context: { bank: 'NTB', sourcePath: 'p', index: 3 }, base: { id: 'x1', amount: r.amount, date: r.date, direction: 'debit', source: 'statement' }, now: 1 });
    it('a line with its plan table row: the plan is named, its real total and what is owed are the bank\'s', () => {
        const rec = make({ ...row, plan: table1 });
        expect(rec).toMatchObject({ id: 'x1', product: 'SINGER', monthly: 10000, duration: 12, total: 120000, totalEstimated: false, outstanding: 110000, installmentNo: 1, installmentOf: 12, completed: false });
        expect(rec.payments).toMatchObject([{ month: '2026-08', paid: true, amount: 10000, source: 'statement', statementKey: 'p', statementRow: 3 }]);
    });
    it('a line with no table: the plan is as long as the line says, and its total is an estimate', () => {
        const rec = make({ amount: 8333.33, date: '2026-08-10', description: 'INSTALLMENT 03/12 ABANS PLC', direction: 'debit' });
        expect(rec).toMatchObject({ product: 'ABANS PLC', duration: 12, totalEstimated: true, installmentNo: 3, installmentOf: 12 });
    });
});

describe('a plan table read from a flat text is not guessed', () => {
    const header = 'Nations Trust Bank American Express Credit Card Statement Card Number: 376657XXXXX0276 Statement Date: 03/09/2026 Payment Due Date: 25/09/2026 Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00 Date Description Amount';
    const row = 'SINGER 12M NATIONS PAY 120,000.00 110,000.00 11/12 10,000.00';
    it('a whole statement flattened to one line has no plan row to read (its first words are not a plan\'s name)', () => {
        expect(shared.readPlanTable(`${header} 05/08/2026 SUPERMARKET 8350.50 DR ${row}`)).toEqual([]);
    });
    it('the same row on its own line is read', () => {
        expect(shared.readPlanTable(`${header}\n${row}`)).toMatchObject([{ name: 'SINGER', months: 12, total: 120000, remainingMonths: 11 }]);
    });
});

describe('the manual upload files an instalment line as a plan (source contract; the browser run is test/e2e/manual-email-parity-plan.mjs)', () => {
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const ai = fs.readFileSync(new URL('../wealthflow-ai-v4.js', import.meta.url), 'utf8');
    it('the page loads the shared plan module after the router', () => {
        expect(html).toMatch(/wealthflow-statement-router\.js"><\/script>\s*<script type="module" src="wealthflow-card-plans\.js"><\/script>/);
    });
    it('a card line that says it is an instalment routes to CC Installments, named by the statement\'s plan table', () => {
        expect(html).toContain("t._dest = 'ccinstall'");
        expect(html).toContain('_P.planFor(parsed.planTable || [], t.amount, _said.of)');
        expect(html).toContain("['ccinstall', 'CC Installments']");
    });
    it('Save continues the plan the owner has or starts the same record the worker files, and Undo knows both', () => {
        expect(html).toContain('_P.matchInstallmentPlan(_row, planArr');
        expect(html).toContain('_P.cardPlanRecord({ row: _row');
        expect(html).toContain('WFBatch.recordPlan(');
        expect(html).toContain("WFBatch.record(_batch, 'ccinstall', _rec.id)");
    });
    it('the readers hand the review the plan table (from the lines of an HTML e-statement, not its flat text)', () => {
        expect(ai).toContain('window.WFCardPlans.readPlanTable(lines || text)');
        expect(ai).toContain('_hres && _hres.rowText');
    });
});
