import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { printedSummaryCheck } from '../statement-direction.mjs';
import { readingIsSuspect, secondOpinionAgrees } from '../statement-sync.js';

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

describe('the summary strip against the rows read', () => {
    const rowsOf = (out) => out.rows.map((r) => ({ ...r, valid: true }));
    it('agrees when credits, debits and interest all add up to the strip', () => {
        const out = read();
        expect(printedSummaryCheck({ ...out, rows: rowsOf(out) })).toEqual({ status: 'agree', differs: [] });
        expect(readingIsSuspect({ ...out, rows: rowsOf(out) })).toBe(false);
    });
    it('catches a charge and a credit of one amount that were read twice, which the opening/closing sum cannot see (both move it by nothing)', () => {
        const out = read();
        const doubled = [...rowsOf(out), { ...rowsOf(out).find((r) => r.narration === 'STAMP DUTY') }, { ...rowsOf(out).find((r) => r.narration === 'STAMP DUTY'), direction: 'credit' }];
        const check = printedSummaryCheck({ ...out, rows: doubled });
        expect(check.status).toBe('differs');
        expect(check.differs).toEqual(expect.arrayContaining(['credits', 'debits']));
        expect(readingIsSuspect({ ...out, rows: doubled })).toBe(true);
    });
    it('catches an interest line whose amount is not the interest the bank printed', () => {
        const out = read();
        const wrong = rowsOf(out).map((r) => (r.narration === 'DEBIT INTEREST' ? { ...r, amount: 668.03 } : r));
        const check = printedSummaryCheck({ ...out, rows: wrong });
        expect(check.status).toBe('differs');
        expect(check.differs).toContain('interest');
    });
    it('says nothing when the statement prints no strip', () => {
        const out = P.parseStatement(['Sample Bank Card', '12/08/2026 SAMPLE PLATE 1,600.00'].join('\n'));
        expect(printedSummaryCheck(out)).toEqual({ status: 'none', differs: [] });
    });
    it('believes a second opinion only when it agrees with the strip the first reading contradicted', () => {
        const out = read();
        const good = { ...out, rows: rowsOf(out) };
        const bad = { ...out, rows: rowsOf(out).map((r) => (r.narration === 'DEBIT INTEREST' ? { ...r, amount: 668.03 } : r)) };
        expect(secondOpinionAgrees(bad, good)).toBe(true);
        expect(secondOpinionAgrees(bad, bad)).toBe(false);
        expect(secondOpinionAgrees(bad, { rows: [] })).toBe(false);
    });
});

describe('a PDF whose text layer is scrambled', () => {
    // An invented page: every letter and digit swapped for another character, as a font without a text map does. Dates and money are gone, so it is read like a scan, with a reason that says so.
    const swap = (t) => t.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(33 + ((c.charCodeAt(0) * 7) % 14)));
    const page = Array.from({ length: 40 }, (_, i) => `12 AUG 12 AUG SAMPLE SHOP NUMBER ${i} LKR ${1000 + i}.00 Dr`).join('\n');
    it('is not an unseen layout to confirm; it goes to the image scanner', () => {
        const out = P.parseStatement(swap(page));
        expect(out.verdict).toBe('no-text');
        expect(out.garbled).toBe(true);
        expect(out.understood).toBe(false);
        expect(out.reason).toMatch(/scrambled/);
    });
    it('does not catch a statement that is readable', () => {
        const out = read();
        expect(out.garbled).toBe(false);
        expect(out.verdict).toBe('parsed');
    });
});
