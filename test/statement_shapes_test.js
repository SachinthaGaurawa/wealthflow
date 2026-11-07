import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';

const P = loadParser(fs);
// Invented statements. Each shape is one a Sri Lankan bank or card statement can print; the reading must be exactly right or say it is not.
const BANK = ['ACCOUNT STATEMENT', 'Account No 0012345678'];
const CARD = ['CREDIT CARD STATEMENT', 'Card Number 4000 00XX XXXX 5678', 'Credit Limit 500,000.00', 'Statement Period 30 Sep 2026 / 31 Oct 2026'];
const read = lines => P.parseStatement(lines.join('\n'));
const flat = rows => rows.map(r => [r.date, r.narration, r.amount, r.direction]);

describe('statement shapes: every amount, date and direction exactly as printed', () => {
    it.each(['Rs. ', 'Rs ', 'LKR '])('a currency word "%s" before every amount does not turn the balance into the amount', cur => {
        const out = read([...BANK, `OPENING BALANCE ${cur}100,000.00`, `02/10/2026 SAMPLE SUPERMARKET ${cur}4,250.00 ${cur}95,750.00`, `05/10/2026 SAMPLE SALARY OCT ${cur}250,000.00 ${cur}345,750.00`, `CLOSING BALANCE ${cur}345,750.00`]);
        expect(flat(out.rows)).toEqual([['2026-10-02', 'SAMPLE SUPERMARKET', 4250, 'debit'], ['2026-10-05', 'SAMPLE SALARY OCT', 250000, 'credit']]);
        expect(out.reconciliation.ok).toBe(true);
    });
    it('a row dated without a year takes the year of the statement period, and a December row on a January statement is last year', () => {
        const a = read([...CARD, '02 Oct SAMPLE SUPERMARKET COLOMBO 4,250.00', '03 Oct PAYMENT RECEIVED THANK YOU 20,000.00 CR', '30 Sep SAMPLE FUEL 1,000.00']);
        expect(flat(a.rows)).toEqual([['2026-10-02', 'SAMPLE SUPERMARKET COLOMBO', 4250, 'debit'], ['2026-10-03', 'PAYMENT RECEIVED THANK YOU', 20000, 'credit'], ['2026-09-30', 'SAMPLE FUEL', 1000, 'debit']]);
        const b = read(['CREDIT CARD STATEMENT', 'Statement Period 28 Dec 2026 / 27 Jan 2027', '29 Dec SAMPLE A 1,000.00', '05 Jan SAMPLE B 2,000.00']);
        expect(b.rows.map(r => r.date)).toEqual(['2026-12-29', '2027-01-05']);
    });
    it('a year-less date with no period to read the year from is not guessed', () => {
        expect(read(['CREDIT CARD STATEMENT', '02 Oct SAMPLE SUPERMARKET COLOMBO 4,250.00']).rows).toEqual([]);
    });
    it('a description that wraps onto a second line is one row, not a lost one', () => {
        const out = read([...BANK, 'OPENING BALANCE 100,000.00', '02/10/2026 SAMPLE SUPERMARKET', 'COLOMBO BRANCH 4,250.00 95,750.00', '05/10/2026 SAMPLE SALARY OCT 250,000.00 345,750.00', 'CLOSING BALANCE 345,750.00']);
        expect(flat(out.rows)).toEqual([['2026-10-02', 'SAMPLE SUPERMARKET COLOMBO BRANCH', 4250, 'debit'], ['2026-10-05', 'SAMPLE SALARY OCT', 250000, 'credit']]);
        expect(out.reconciliation.ok).toBe(true);
    });
    it('a statement printed newest first is read oldest first, and its directions are proven by its balances', () => {
        const out = read([...BANK, 'Date Description Debit Credit Balance', '07/10/2026 SAMPLE TELECOM BILL 1,500.00 344,250.00', '05/10/2026 SAMPLE SALARY OCT 250,000.00 345,750.00', '02/10/2026 SAMPLE SUPERMARKET 4,250.00 95,750.00', 'OPENING BALANCE 100,000.00', 'CLOSING BALANCE 344,250.00']);
        expect(flat(out.rows)).toEqual([['2026-10-02', 'SAMPLE SUPERMARKET', 4250, 'debit'], ['2026-10-05', 'SAMPLE SALARY OCT', 250000, 'credit'], ['2026-10-07', 'SAMPLE TELECOM BILL', 1500, 'debit']]);
        expect(out.reconciliation.ok).toBe(true);
        expect(out.rows.every(r => r.directionSource === 'balance')).toBe(true);
    });
    it('an oldest-first statement is never reversed', () => {
        const out = read([...BANK, 'OPENING BALANCE 100,000.00', '02/10/2026 SAMPLE SUPERMARKET 4,250.00 95,750.00', '05/10/2026 SAMPLE SALARY OCT 250,000.00 345,750.00', '07/10/2026 SAMPLE TELECOM BILL 1,500.00 344,250.00', 'CLOSING BALANCE 344,250.00']);
        expect(out.rows.map(r => r.date)).toEqual(['2026-10-02', '2026-10-05', '2026-10-07']);
    });
    it('a bank balance printed with DR is overdrawn: the purchase deepens it, the salary lifts it', () => {
        const out = read([...BANK, 'OPENING BALANCE 5,000.00 DR', '02/10/2026 SAMPLE SUPERMARKET 4,250.00 9,250.00 DR', '05/10/2026 SAMPLE SALARY OCT 250,000.00 240,750.00 CR', 'CLOSING BALANCE 240,750.00 CR']);
        expect(flat(out.rows)).toEqual([['2026-10-02', 'SAMPLE SUPERMARKET', 4250, 'debit'], ['2026-10-05', 'SAMPLE SALARY OCT', 250000, 'credit']]);
        expect(out.reconciliation.ok).toBe(true);
    });
    it('on a CARD statement a balance printed with DR is what is owed, not an overdraft', () => {
        const out = read([...CARD, 'Opening Balance 50,000.00 DR', '02/10/2026 SAMPLE SUPERMARKET COLOMBO 4,250.00', '03/10/2026 PAYMENT RECEIVED THANK YOU 20,000.00 CR', 'Closing Balance 34,250.00 DR']);
        expect(out.reconciliation.opening).toBe(50000);
        expect(flat(out.rows)).toEqual([['2026-10-02', 'SAMPLE SUPERMARKET COLOMBO', 4250, 'debit'], ['2026-10-03', 'PAYMENT RECEIVED THANK YOU', 20000, 'credit']]);
    });
    it('a foreign-currency amount is not a money column: the rupee amount that follows it is the amount', () => {
        const out = read([...CARD, 'Opening Balance 100,000.00', '20/10/2026 SAMPLE ONLINE STORE, SINGAPORE USD 12.50 3,750.00', '22/10/2026 SAMPLE PIZZA-TOWN, TOWN 1,500.25', 'Closing Balance 105,250.25']);
        expect(out.rows.map(r => [r.amount, r.direction])).toEqual([[3750, 'debit'], [1500.25, 'debit']]);
        expect(out.reconciliation.ok).toBe(true);
    });
});
