import { describe, expect, it } from 'vitest';
import { readRenderedHtml } from '../statement-reader.mjs';

// The shape of a real emailed American Express (Nations Trust Bank) Smart
// Statement once its own script has drawn it, with invented figures:
//   * dates are printed WITHOUT a year ("13 JUL"); the year lives only in the
//     "Statement Period" line
//   * a "Post Date | Transaction Date" pair
//   * "Transaction Amount" is the foreign-currency figure, "Amount" the LKR one
//   * the Dr/Cr column has no header at all
//   * the summary prints each label and its figure as two separate blocks
//   * a marketing paragraph after the table contains "carried forward"
const smart = ({ rows, opening = '1,000.00', closing = '4,700.00', period = '11-Jul-2026 to 10-Aug-2026' }) => `<html><body>
<div>Nations Trust Bank American Express Magnet Card</div><div>Card No: 376657*****0276</div>
<div>Statement Period:</div><div>${period}</div>
<div>Credit Limit</div><div>350,000</div><div>Minimum Payment Due</div><div>8,433.98</div>
<div>Opening Balance</div><div>${opening}</div><div>Closing Balance</div><div>${closing}</div>
<table><tr><th>Post Date</th><th>Transaction Date</th><th>Description</th><th>Transaction Currency</th><th class="r">Transaction Amount</th><th class="r">Amount</th><th class="r"> </th></tr>
${rows.map(([post, txn, desc, ccy, foreign, local, dir]) => `<tr><td>${post}</td><td>${txn}</td><td>${desc}</td><td>${ccy}</td><td class="r">${foreign}</td><td class="r">${local}</td><td>${dir}</td></tr>`).join('')}
</table>
<p>Please note the interest rate applicable on all transactions including carried forward outstanding balance is revised to 2.33% p.a.</p>
</body></html>`;

const rows = [
    ['13 JUL', '13 JUL', 'Cash advance', 'LKR', '1,000.00', '1,000.00', 'Dr'],
    ['16 JUL', '16 JUL', 'PAYMENT THANK YOU', 'LKR', '300.00', '300.00', 'Cr'],
    ['21 JUL', '19 JUL', 'FOREIGN MERCHANT', 'USD', '5.00', '1,500.00', 'Dr'],
    ['21 JUL', '19 JUL', 'FOREIGN MERCHANT', 'USD', '5.00', '1,500.00', 'Dr'],
];
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
