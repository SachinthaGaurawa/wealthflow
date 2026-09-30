import { describe, expect, it } from 'vitest';
import { readRenderedHtml } from '../statement-reader.mjs';
import { smart, rows, consolidated, savings, current } from './helpers/smart-statements.js';

const summary = r => r.parsed.rows.map(x => [x.date, x.amount, x.direction, x.directionSource]);

describe('a script-drawn card Smart Statement, read from what the device rendered', () => {
    it('reads every row with the right date, LKR amount and direction, and reconciles a card to the cent', async () => {
        const result = await readRenderedHtml(smart({ rows }));
        expect(summary(result)).toEqual([
            ['2026-07-13', 1000, 'debit', 'marker'],
            ['2026-07-16', 300, 'credit', 'marker'],
            ['2026-07-21', 1500, 'debit', 'marker'],
            ['2026-07-21', 1500, 'debit', 'marker'],
        ]);
        expect(result.parsed.reconciliation).toMatchObject({ opening: 1000, closing: 4700, credits: 300, debits: 4000, ok: true, model: 'card' });
        expect(result.parsed).toMatchObject({ verdict: 'parsed', understood: true });
        expect(result.parsed.htmlIncompleteRows).toBeUndefined();
        expect(result.parsed.layout).toMatchObject({ accountLast4: '0276', statementType: 'credit-card' });
    });
    it('never reads "13 JUL 13 JUL" as the year 2013, and keeps two genuinely identical purchases', async () => {
        const result = await readRenderedHtml(smart({ rows }));
        expect(result.parsed.rows.every(x => x.date.startsWith('2026-'))).toBe(true);
        expect(result.parsed.rows.filter(x => x.narration === 'FOREIGN MERCHANT')).toHaveLength(2);
    });
    it('puts a December row on a December-to-January statement in the earlier year', async () => {
        const result = await readRenderedHtml(smart({ period: '11-Dec-2025 to 10-Jan-2026', opening: '0.00', closing: '300.00',
            rows: [['28 DEC', '28 DEC', 'SHOP', 'LKR', '200.00', '200.00', 'Dr'], ['05 JAN', '05 JAN', 'SHOP TWO', 'LKR', '100.00', '100.00', 'Dr']] }));
        expect(summary(result).map(x => x[0])).toEqual(['2025-12-28', '2026-01-05']);
    });
    it('puts the 1 January posting on a December statement in the NEXT year', async () => {
        const result = await readRenderedHtml(smart({ period: '11-Nov-2026 to 10-Dec-2026', opening: '0.00', closing: '300.00',
            rows: [['28 NOV', '28 NOV', 'SHOP', 'LKR', '200.00', '200.00', 'Dr'], ['09 DEC', '09 DEC', 'SHOP TWO', 'LKR', '100.00', '100.00', 'Dr']] }));
        expect(summary(result).map(x => x[0])).toEqual(['2026-11-28', '2026-12-09']);
        const ntb = await readRenderedHtml(consolidated([{ ...savings, rows: [['02-Dec', 'POS Transaction - SHOP ONE', 'S1', '300.00', '', '700.00'], ['01-Jan', 'Int.Pd', 'S2', '', '10.00', '710.00']], totals: ['300.00', '10.00', '710.00'] }]).replace('01-01-2026 to 31-01-2026', '01-12-2026 to 31-12-2026'));
        expect(summary(ntb).map(x => x[0])).toEqual(['2026-12-02', '2027-01-01']);
    });
    it('does not take a sentence containing "carried forward" for the closing balance', async () => {
        const result = await readRenderedHtml(smart({ rows }));
        expect(result.parsed.reconciliation.closing).toBe(4700);
    });
    it('does not let the card formula rescue a statement whose rows are wrong', async () => {
        const result = await readRenderedHtml(smart({ rows, closing: '4,701.00' }));
        expect(result.parsed.reconciliation.ok).toBe(false);
        expect(result.parsed.verdict).toBe('unverified');
    });
    it('does not apply the card formula to an account statement', async () => {
        const account = `<html><body><h1>Savings Account Statement</h1><p>Account No: 0012345678</p>
<div>Opening Balance</div><div>1,000.00</div><div>Closing Balance</div><div>1,700.00</div>
<table><tr><th>Date</th><th>Description</th><th>Amount</th><th>Type</th></tr>
<tr><td>05/07/2026</td><td>SALARY</td><td>300.00</td><td>Cr</td></tr></table></body></html>`;
        const result = await readRenderedHtml(account);
        expect(result.parsed.reconciliation).toMatchObject({ opening: 1000, closing: 1700, ok: false });
        expect(result.parsed.reconciliation.model).toBeUndefined();
    });
});

describe('a consolidated bank statement, read from what the device rendered', () => {
    it('reads the LEDGER — debit and credit as the amount, never the running balance', async () => {
        const result = await readRenderedHtml(consolidated([savings]));
        expect(summary(result)).toEqual([['2026-01-02', 300, 'debit', 'marker'], ['2026-01-06', 5000, 'credit', 'marker'], ['2026-02-01', 10, 'credit', 'marker']]);
        expect(result.parsed.rows.map(r => r.ref)).toEqual(['S1', 'S2', 'S3']);
        expect(result.parsed.rows[0].narration).toBe('POS Transaction - SHOP ONE');
        expect(result.parsed.reconciliation).toMatchObject({ opening: 1000, closing: 5710, credits: 5010, debits: 300, ok: true });
        expect(result.parsed).toMatchObject({ verdict: 'parsed', understood: true });
        expect(result.parsed.layout.accountLast4).toBe('8057');
    });
    it('does not read the Overview\'s interest and tax summary as transactions', async () => {
        const result = await readRenderedHtml(consolidated([savings]));
        expect(result.parsed.rows.some(r => /WTax|to 31-01-2026 *$/i.test(r.narration) && r.amount === 0.69)).toBe(false);
        expect(result.parsed.rows).toHaveLength(3);
    });
    it('reconciles each account against its OWN opening and closing balance', async () => {
        const result = await readRenderedHtml(consolidated([savings, current]));
        expect(result.parsed.rows).toHaveLength(4);
        expect(result.parsed.reconciliation).toMatchObject({ accounts: 2, ok: true, opening: 3000, closing: 7210 });
        expect(result.parsed).toMatchObject({ verdict: 'parsed', understood: true });
        expect(summary(result).at(-1)).toEqual(['2026-01-03', 500, 'debit', 'marker']);
    });
    it('will not call a statement understood when one account does not add up', async () => {
        const broken = { ...current, rows: [['03-Jan', 'CEFTS/6719', 'S4', '500.00', '', '1,499.00']] };
        const result = await readRenderedHtml(consolidated([savings, broken]));
        expect(result.parsed.verdict).not.toBe('parsed');
        expect(result.parsed.understood).toBe(false);
    });
    it('notices a missing row from the ledger\'s own Total line', async () => {
        const missing = { ...savings, rows: savings.rows.slice(0, 2), totals: ['300.00', '5,010.00', '5,710.00'] };
        const result = await readRenderedHtml(consolidated([missing]));
        expect(result.parsed.understood).toBe(false);
    });
    it('derives the opening balance from the first row when no B/F row is printed', async () => {
        const noBf = consolidated([{ ...savings }]).replace(/<tr><td><\/td><td><\/td><td>B\/F<\/td>.*?<\/tr>/, '');
        const result = await readRenderedHtml(noBf);
        expect(result.parsed.reconciliation).toMatchObject({ opening: 1000, closing: 5710, ok: true });
    });
});

describe('memo lines, idle accounts and empty months', () => {
    const withRows = extra => consolidated([{ ...savings, rows: [...savings.rows, ...extra] }]);
    it('leaves out a zero-amount memo line rather than refusing the whole statement', async () => {
        const result = await readRenderedHtml(withRows([['31-Jan', 'WTax.Pd', 'S9', '0.00', '', '5,710.00'], ['31-Jan', 'Int.Pd', 'S10', '', '0.00', '5,710.00'], ['31-Jan', 'Fee', 'S11', '', '', '5,710.00']]));
        expect(result.parsed.rows).toHaveLength(3);
        expect(result.parsed).toMatchObject({ verdict: 'parsed', understood: true });
        expect(result.parsed.htmlIncompleteRows).toBeUndefined();
        expect(result.parsed.htmlReadNotes).toEqual({ zeroAmountSkipped: 3 });
    });
    it('still stops at a zero beside a balance that moved — a figure went missing', async () => {
        const result = await readRenderedHtml(withRows([['31-Jan', 'Mystery', 'S9', '0.00', '', '5,000.00']]));
        expect(result.parsed.verdict).toBe('unverified');
        expect(result.parsed.htmlIncompleteKinds).toMatchObject({ 'zero-amount-balance-moved': 1 });
    });
    it('names what it refused, by kind and count, and nothing else', async () => {
        const result = await readRenderedHtml(withRows([['31-Jan', 'Odd', 'S9', 'abc', '', '5,710.00']]));
        expect(result.parsed.htmlIncompleteKinds).toEqual({ 'amount-unreadable': 1 });
        expect(JSON.stringify(result.parsed.htmlIncompleteKinds)).not.toMatch(/Odd|S9|5,710/);
    });
    it('reads an overdrawn running balance through its own sign', async () => {
        const overdrawn = { number: '300123456789', opening: '-2,000.00', totals: ['500.00', '0.00', '-2,500.00'], rows: [['03-Jan', 'CEFTS/6719', 'S4', '500.00', '', '(2,500.00)']] };
        const result = await readRenderedHtml(consolidated([overdrawn]));
        expect(result.parsed.rows).toHaveLength(1);
        expect(result.parsed.htmlIncompleteRows).toBeUndefined();
    });
    it('proves a month empty only from the statement\'s own agreeing balances', async () => {
        const idle = await readRenderedHtml(smart({ rows: [], opening: '4,700.00', closing: '4,700.00' }));
        expect(idle.zeroActivity).toBe(true);
        expect((await readRenderedHtml(smart({ rows: [], opening: '4,700.00', closing: '5,000.00' }))).zeroActivity).toBe(false);
        expect((await readRenderedHtml('<html><body><div>American Express</div><div>Statement Period: 11-Jul-2026 to 10-Aug-2026</div></body></html>')).zeroActivity).toBe(false);
        expect((await readRenderedHtml(smart({ rows }))).zeroActivity).not.toBe(true);
    });
    it('proves an idle consolidated statement, and not one whose Total line disagrees', async () => {
        const idle = { ...savings, rows: [], totals: ['0.00', '0.00', '1,000.00'] };
        expect((await readRenderedHtml(consolidated([idle]))).zeroActivity).toBe(true);
        expect((await readRenderedHtml(consolidated([{ ...idle, totals: ['0.00', '50.00', '1,000.00'] }]))).zeroActivity).toBe(false);
    });
    it('a statement with unreadable rows is never idle', async () => {
        const result = await readRenderedHtml(withRows([['31-Jan', 'Odd', 'S9', 'abc', '', '5,710.00']]));
        expect(result.zeroActivity).not.toBe(true);
    });
});
