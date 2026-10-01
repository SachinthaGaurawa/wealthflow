import { describe, expect, it } from 'vitest';
import { textPdf } from './helpers/embedded-statements.js';
import { readStatement } from '../statement-reader.mjs';
import { headerText } from '../statement-reader.mjs';

// A bank account's statement that happens to say "credit card" or "AMEX" in a transaction line is still a bank account's statement. Reading the
// whole page called it a card statement: every debit then became a card charge and every credit a card payment — income, gone.
const BANK = (extra = '') => `
HATTON NATIONAL BANK PLC
Statement Period: 01/03/2026 - 31/03/2026
Account Number: 074020012388
Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance
01/03/2026 Opening Balance 500,000.00
08/03/2026 08/03/2026 CREDIT CARD PAYMENT HNB 4512 50,000.00 450,000.00
12/03/2026 12/03/2026 PAYMENT TO AMEX 4455 1,000.00 449,000.00
25/03/2026 25/03/2026 SALARY CREDIT 150,000.00 599,000.00
${extra}`;
const CARD = `
AMERICAN EXPRESS
Cardholder: A PERSON
Credit Limit: LKR 500,000.00
Statement Period: 01/03/2026 - 31/03/2026
Card Number: 3782 8224 6310 0276
Date Description Amount
05/03/2026 KEELLS SUPER 4,000.00
10/03/2026 PAYMENT RECEIVED - THANK YOU 4,000.00 CR
Closing Balance 0.00
`;

describe('what kind of statement it is comes from its header', () => {
    it('headerText drops every line that carries a date and an amount, and keeps the rest', () => {
        const header = headerText(BANK());
        expect(header).toContain('HATTON NATIONAL BANK PLC');
        expect(header).not.toMatch(/CREDIT CARD PAYMENT|AMEX/);
        expect(headerText(CARD)).toMatch(/AMERICAN EXPRESS[\s\S]*Credit Limit: LKR 500,000.00/);
    });
    it('a bank statement with "credit card" and "AMEX" in its narrations stays a bank statement', async () => {
        const { parsed } = await readStatement({ bytes: textPdf(BANK().trim().split('\n')), filename: 'statement.pdf', bank: 'HNB' });
        expect(parsed.layout.statementType).not.toBe('credit-card');
        expect(parsed.rows.map(r => r.direction)).toEqual(['debit', 'debit', 'credit']);
    });
    it('a card statement is still recognised from its header', async () => {
        const { parsed } = await readStatement({ bytes: textPdf(CARD.trim().split('\n')), filename: 'amex.pdf', bank: 'American Express' });
        expect(parsed.layout.statementType).toBe('credit-card');
    });
});
