import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { readStatement } from '../statement-reader.mjs';
import { namedCardCategory, cardChargeCategory, routeRow } from '../wealthflow-statement-router.js';
import { namedCardCategory as fromSync, deterministicDecision } from '../statement-sync.js';

const P = loadParser(fs);

const html = (title, ...rows) => `<html><body><h1>${title}</h1>${rows.join('')}<table><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr><tr><td>05/08/2026</td><td>SUPERMARKET BAMBALAPITIYA</td><td>8350.50</td><td></td><td>91649.50</td></tr><tr><td>06/08/2026</td><td>PAYMENT RECEIVED THANK YOU</td><td></td><td>15000.00</td><td>106649.50</td></tr></table></body></html>`;

describe('the page reads what a statement is, and which account, the way the e-mail worker does', () => {
    it('a card statement is told by its header, however its rows are mixed', () => {
        const text = ['Nations Trust Bank American Express Credit Card Statement', 'Card Number: 376657XXXXX0276', 'Credit Limit 500000.00', '05/08/2026 SUPERMARKET 8350.50 DR', '06/08/2026 PAYMENT RECEIVED 15000.00 CR'].join('\n');
        expect(P.identityOf(text)).toEqual({ statementType: 'credit-card', accountLast4: '0276' });
    });

    it('a bank statement with "credit card payment" on a transaction line is still a bank statement', () => {
        const text = ['Nations Trust Bank Savings Account Statement', 'Account Number: 100012345678', '05/08/2026 CREDIT CARD PAYMENT AMEX 15000.00 DR'].join('\n');
        expect(P.identityOf(text)).toEqual({ statementType: '', accountLast4: '5678' });
    });

    it('an e-statement that reaches the page as ONE line is cut at its first transaction, so the header is still read', () => {
        const flat = 'Nations Trust Bank American Express Credit Card StatementCard Number: 376657XXXXX0276Statement Date: 03/09/2026 Payment Due Date: 25/09/2026Credit Limit 500000.00DateDescriptionAmount05/08/2026SHOP100.00 DR';
        expect(P.identityOf(flat)).toMatchObject({ statementType: '' });                       // the line rule alone throws the whole line away (it holds dates and amounts)
        expect(P.identityOf(flat, { before: 'SHOP' })).toEqual({ statementType: 'credit-card', accountLast4: '0276' });
        expect(P.identityOf('Savings Account Statement Account No 100012345678 05/08/2026 CREDIT CARD PAYMENT 1.00', { before: 'CREDIT CARD PAYMENT' }).statementType).toBe('');
    });

    it('agrees with the worker reader on the same document', async () => {
        const docs = [
            html('Nations Trust Bank American Express Credit Card Statement', '<p>Card Number: 376657XXXXX0276</p>', '<p>Credit Limit 500000.00</p>'),
            html('Nations Trust Bank Savings Account Statement', '<p>Account Number: 100012345678</p>'),
            html('Commercial Bank Credit Card Statement', '<p>Card No: 4111 11XX XXXX 1234</p>', '<p>Credit Limit 250000.00</p>'),
        ];
        for (const doc of docs) {
            const read = await readStatement({ bytes: Buffer.from(doc), filename: 's.html', passwords: [] });
            const layout = read.parsed.layout || {};
            const mine = P.identityOf(read.text);
            expect(mine.statementType, doc.slice(0, 80)).toBe(layout.statementType || '');
            expect(mine.accountLast4, doc.slice(0, 80)).toBe(layout.accountLast4 || '');
        }
    });
});

describe('a card charge is categorised by one rule for both doors', () => {
    const card = { statementType: 'credit-card', card_last4: '0276', reviewThreshold: 0.7 };
    const rows = ['KEELLS SUPER NAWALA', 'FUEL STATION KOLLUPITIYA', 'ANNUAL FEE', 'CASH ADVANCE ATM COLOMBO', 'NETFLIX.COM', 'ONLINE SHOP COLOMBO', 'UBER TRIP COLOMBO'].map(words => ({ description: words, narration: words, amount: 1000, direction: 'debit' }));

    it('is what the worker files', () => {
        for (const row of rows) {
            const category = cardChargeCategory(row, routeRow(row, card));
            expect(deterministicDecision(row, card).category, row.description).toBe(category);
        }
    });

    it('keeps the named category and falls back to Card Purchase', () => {
        expect(cardChargeCategory(rows[0], routeRow(rows[0], card))).toBe('Groceries');
        expect(cardChargeCategory(rows[2], routeRow(rows[2], card))).toBe('Card Fee');
        expect(cardChargeCategory(rows[5], routeRow(rows[5], card))).toBe('Card Purchase');
        expect(namedCardCategory('Other')).toBe('Card Purchase');
        expect(namedCardCategory('Groceries')).toBe('Groceries');
        expect(fromSync).toBe(namedCardCategory);
    });
});
