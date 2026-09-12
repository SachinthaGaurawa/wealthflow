import { describe, it, expect } from 'vitest';
import { readStatement } from '../statement-reader.mjs';

const read = body => readStatement({ bytes: Buffer.from(`<html><body><h1>Nations Trust Bank Account Statement</h1>${body}</body></html>`), filename: 'NTB.html' });
const header = '<tr><th>Date</th><th>Description</th><th>Reference No</th><th>Debit</th><th>Credit</th><th>Balance</th></tr>';
describe('inert semantic HTML bank columns', () => {
    it('uses exact debit and credit columns instead of the rightmost running balance', async () => {
        const result = await read(`<p>Opening Balance 1000.00</p><table>${header}<tr><td>01/09/2026</td><td>SHOP</td><td>991122</td><td>100.00</td><td>-</td><td>900.00</td></tr><tr><td>02/09/2026</td><td>SALARY</td><td>441122</td><td>0.00</td><td>500.00</td><td>1400.00</td></tr></table><p>Closing Balance 1400.00</p>`);
        expect(result.parsed.verdict).toBe('parsed');
        expect(result.parsed.rows.map(r => [r.amount, r.direction])).toEqual([[100, 'debit'], [500, 'credit']]);
        expect(result.text).toContain('REF:991122');
        expect(result.parsed.reconciliation.ok).toBe(true);
    });
    it('fails closed when both debit and credit columns are nonzero', async () => {
        const result = await read(`<table>${header}<tr><td>01/09/2026</td><td>SHOP</td><td>991122</td><td>100.00</td><td>200.00</td><td>900.00</td></tr></table>`);
        expect(result.parsed.verdict).toBe('unverified');
        expect(result.parsed.htmlIncompleteRows).toBe(1);
    });
    it('keeps equal genuine rows and detects a contradictory running balance', async () => {
        const row = balance => `<tr><td>01/09/2026</td><td>SHOP</td><td>991122</td><td>100.00</td><td>-</td><td>${balance}</td></tr>`;
        const result = await read(`<table>${header}${row('900.00')}${row('900.00')}</table>`);
        expect(result.parsed.rows).toHaveLength(2);
        expect(result.parsed.verdict).toBe('unverified');
    });
    it('requires an explicit marker for a single unsigned amount column', async () => {
        const result = await read('<table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>01/09/2026</td><td>SHOP</td><td>100.00</td></tr></table>');
        expect(result.parsed.understood).toBe(false);
    });
    it('preserves full direction field evidence without inventing JSON completeness', async () => {
        const rows = [{ date: '01/09/2026', description: 'SALARY', amount: '500.00', direction: 'credit' }, { date: '02/09/2026', description: 'SHOP', amount: '100.00' }];
        const result = await read(`<script type="application/json">${JSON.stringify(rows)}</script>`);
        expect(result.parsed.rows.map(r => r.direction)).toEqual(['credit', 'debit']);
        expect(result.parsed.layout.explicitDirectionRows).toBe(1);
        expect(result.parsed.layout.embeddedCompletenessVerified).toBe(false);
        expect(result.parsed.verdict).toBe('unverified');
    });
});
