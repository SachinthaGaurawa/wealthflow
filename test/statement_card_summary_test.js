import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';

const P = loadParser(fs);
// An invented card statement in the shape a Sri Lankan card issuer prints: a summary strip, then rows with a post date and a transaction date that carry NO year ("12 AUG 12 AUG"), a currency column, and Dr/Cr after the LKR amount.
const STRIP = ['Opening Purchases Cash Interest Charges Payments Other Closing', 'Balance Advances Credits Balance', '20,000.00 6,496.09 0.00 668.30 120.00 5,000.00 100.00 22,184.39'];
const ROWS = [
    '12 AUG 12 AUG SAMPLE PLATE LKR 1,600.00 1,600.00 Dr',
    '17 AUG 14 AUG SAMPLE STREAM.COM USD 9.99 3,496.09 Dr',
    '21 AUG 21 AUG SAMPLE PHARMACY LKR 1,400.00 1,400.00 Dr',
    '31 AUG 31 AUG CASH PAYMENT-SAMPLE LKR 5,000.00 5,000.00 Cr',
    '02 SEP 02 SEP FUEL SURCHARGE LKR 30.00 30.00 Dr',
    '09 SEP 09 SEP CASHBACK ON YOUR AUG STREAM SUBSCRIPTION LKR 100.00 100.00 Cr',
    '10 SEP 10 SEP STAMP DUTY LKR 90.00 90.00 Dr',
    '10 SEP 10 SEP DEBIT INTEREST LKR 668.30 668.30 Dr'];
const HEAD = ['Sample Bank Card', 'Monthly Statement', 'Statement Period: 11-Aug-2026 to 10-Sep-2026', 'Card No: 400000*****0001', 'Credit Limit 350,000', 'Available Credit Limit 231,576.39'];
const read = (strip = STRIP, rows = ROWS) => P.parseStatement([...HEAD, ...strip, 'Post Date Transaction Date Description Transaction Currency Amount Amount (LKR)', ...rows].join('\n'));

describe('a card statement with year-less post and transaction dates and a summary strip', () => {
    it('reads each date as its own day of the period (the second "12" is not the year 2012) and keeps the description clean', () => {
        const out = read();
        expect(out.rows.map(r => [r.date, r.narration, r.amount, r.direction])).toEqual([
            ['2026-08-12', 'SAMPLE PLATE', 1600, 'debit'], ['2026-08-17', 'SAMPLE STREAM.COM', 3496.09, 'debit'], ['2026-08-21', 'SAMPLE PHARMACY', 1400, 'debit'], ['2026-08-31', 'CASH PAYMENT-SAMPLE', 5000, 'credit'],
            ['2026-09-02', 'FUEL SURCHARGE', 30, 'debit'], ['2026-09-09', 'CASHBACK ON YOUR AUG STREAM SUBSCRIPTION', 100, 'credit'], ['2026-09-10', 'STAMP DUTY', 90, 'debit'], ['2026-09-10', 'DEBIT INTEREST', 668.3, 'debit']]);
    });
    it('takes the opening and closing balance from the summary strip and proves the whole statement to the cent', () => {
        const out = read();
        expect(out.printedFigures.summary).toEqual({ opening: 20000, purchases: 6496.09, cash: 0, interest: 668.3, charges: 120, payments: 5000, other: 100, closing: 22184.39 });
        expect(out.reconciliation).toMatchObject({ opening: 20000, closing: 22184.39, ok: true, model: 'card', from: 'printed-summary' });
    });
    it('does not trust a strip that does not add up by itself', () => {
        const out = read(['Opening Purchases Cash Interest Charges Payments Other Closing', 'Balance Advances Credits Balance', '20,000.00 6,496.09 0.00 668.30 120.00 5,000.00 100.00 22,184.38']);
        expect(out.printedFigures.summary).toBe(null);
        expect(out.reconciliation.ok).toBe(null);
    });
    it('a row misread by a cent is caught by the strip', () => {
        const out = read(STRIP, ROWS.map(line => line.replace('668.30 668.30', '668.31 668.31')));
        expect(out.reconciliation.ok).toBe(false);
    });
});
