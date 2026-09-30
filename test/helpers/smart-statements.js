// Invented, structure-faithful stand-ins for the owner's emailed statements once
// their own script has drawn them. Shared by the reader tests and the flow test.
// The shape of a real emailed American Express (Nations Trust Bank) Smart
// Statement once its own script has drawn it, with invented figures:
//   * dates are printed WITHOUT a year ("13 JUL"); the year lives only in the
//     "Statement Period" line
//   * a "Post Date | Transaction Date" pair
//   * "Transaction Amount" is the foreign-currency figure, "Amount" the LKR one
//   * the Dr/Cr column has no header at all
//   * the summary prints each label and its figure as two separate blocks
//   * a marketing paragraph after the table contains "carried forward"
export const smart = ({ rows, opening = '1,000.00', closing = '4,700.00', period = '11-Jul-2026 to 10-Aug-2026' }) => `<html><body>
<div>Nations Trust Bank American Express Magnet Card</div><div>Card No: 376657*****0276</div>
<div>Statement Period:</div><div>${period}</div>
<div>Credit Limit</div><div>350,000</div><div>Minimum Payment Due</div><div>8,433.98</div>
<div>Opening Balance</div><div>${opening}</div><div>Closing Balance</div><div>${closing}</div>
<table><tr><th>Post Date</th><th>Transaction Date</th><th>Description</th><th>Transaction Currency</th><th class="r">Transaction Amount</th><th class="r">Amount</th><th class="r"> </th></tr>
${rows.map(([post, txn, desc, ccy, foreign, local, dir]) => `<tr><td>${post}</td><td>${txn}</td><td>${desc}</td><td>${ccy}</td><td class="r">${foreign}</td><td class="r">${local}</td><td>${dir}</td></tr>`).join('')}
</table>
<p>Please note the interest rate applicable on all transactions including carried forward outstanding balance is revised to 2.33% p.a.</p>
</body></html>`;

export const rows = [
    ['13 JUL', '13 JUL', 'Cash advance', 'LKR', '1,000.00', '1,000.00', 'Dr'],
    ['16 JUL', '16 JUL', 'PAYMENT THANK YOU', 'LKR', '300.00', '300.00', 'Cr'],
    ['21 JUL', '19 JUL', 'FOREIGN MERCHANT', 'USD', '5.00', '1,500.00', 'Dr'],
    ['21 JUL', '19 JUL', 'FOREIGN MERCHANT', 'USD', '5.00', '1,500.00', 'Dr'],
];
// The shape of a Nations Trust "Consolidated eStatement" once rendered, invented
// figures: one ledger per account, "02-Jan" dates with no year (the year is only
// in "Statement Period: 01-01-2026 to 31-01-2026"), a B/F opening row, a
// "Transaction Details" header, separate Debit / Credit / Balance columns, and a
// Total row that states what the rows must add up to.
export const ledger = ({ number, opening, rows, totals }) => `
<div>Savings - MaxBonus</div><div>${number}</div><div>LKR</div>
<table><tr><th>Transaction Date</th><th>Value Date</th><th>Transaction Details</th><th>Reference No</th><th>Debit</th><th>Credit</th><th>Balance</th></tr>
<tr><td></td><td></td><td>B/F</td><td></td><td></td><td></td><td>${opening}</td></tr>
${rows.map(([date, text, ref, debit, credit, balance]) => `<tr><td>${date}</td><td>${date}</td><td>${text}</td><td>${ref}</td><td>${debit}</td><td>${credit}</td><td>${balance}</td></tr>`).join('')}
<tr><td>Total</td><td>${totals[0]}</td><td>${totals[1]}</td><td>${totals[2]}</td></tr></table>`;
export const consolidated = ledgers => `<html><body><div>Nations Trust Bank</div><div>Consolidated Monthly Statement</div>
<div>Statement Period: 01-01-2026 to 31-01-2026</div><div>Overview</div><div>Savings Accounts Total Balance 5,710.00</div>
<p>200550088057:WTax.Pd:01-01-2026to 31-01-2026 S489211 0.69</p>${ledgers.map(ledger).join('')}</body></html>`;
export const savings = { number: '200550088057', opening: '1,000.00', totals: ['300.00', '5,010.00', '5,710.00'], rows: [
    ['02-Jan', 'POS Transaction - SHOP ONE', 'S1', '300.00', '', '700.00'],
    ['06-Jan', 'Cash Deposit - BRANCH', 'S2', '', '5,000.00', '5,700.00'],
    ['01-Feb', '200550088057:Int.Pd:01-01-2026 to 31-01-2026', 'S3', '', '10.00', '5,710.00'],
] };
export const current = { number: '300123456789', opening: '2,000.00', totals: ['500.00', '0.00', '1,500.00'], rows: [
    ['03-Jan', 'CEFTS/6719/FT/NSB/SOME NAME/1001750945', 'S4', '500.00', '', '1,500.00'],
] };

