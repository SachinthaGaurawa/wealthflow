// Probe: what does the parser actually do on realistic statement shapes?
// Evidence before and after the change. Loaded hermetically, never touching globalThis.
import fs from 'node:fs';

const win = {};
new Function('window', 'console', fs.readFileSync('wealthflow-statement-parser.js', 'utf8'))(win, { log() {} });
const P = win.WFStatementParser;

const FIXTURES = {
    // (A) single amount column + running balance — the format the parser was built for
    'A: single-amount + balance': `
01/07/2026 OPENING BALANCE 100,000.00
02/07/2026 KEELLS SUPER COLOMBO 4,250.00 95,750.00
03/07/2026 SALARY JULY 250,000.00 345,750.00
05/07/2026 CEB ELECTRICITY 8,430.50 337,319.50
`,
    // (B) two-column Debit | Credit | Balance, debit filled first
    'B: two-column debit-first': `
01/07/2026 BALANCE B/F 50,000.00
02/07/2026 FUEL LAUGFS 3,000.00 0.00 47,000.00
03/07/2026 TRANSFER IN 0.00 20,000.00 67,000.00
`,
    // (C) NO opening-balance row (very common) — two-column, debit first
    'C: no opening balance': `
02/07/2026 PIZZA HUT DEHIWALA 2,500.00 0.00 97,500.00
03/07/2026 ATM CASH 10,000.00 0.00 87,500.00
`,
    // (D) credit-card statement: NO balance column at all, one amount per row
    'D: credit card, no balance col': `
02/07/2026 UBER RIDE COLOMBO 1,250.00
03/07/2026 NETFLIX SUBSCRIPTION 1,890.00
05/07/2026 DIALOG RELOAD 1,000.00
`,
    // (E) date NOT at line start (leading transaction code)
    'E: leading txn code': `
TXN001 02/07/2026 CARGILLS FOOD CITY 3,120.00 96,880.00
TXN002 03/07/2026 SALARY 200,000.00 296,880.00
`,
    // (F) amounts in parentheses for negatives
    'F: paren negatives': `
01/07/2026 OPENING BALANCE 10,000.00
02/07/2026 REFUND ADJUSTMENT (1,500.00) 11,500.00
`,
    // (G) DD-MMM-YYYY dates + a zero-delta reversal pair
    'G: reversal pair': `
01-Jul-2026 OPENING BALANCE 5,000.00
02-Jul-2026 DUPLICATE CHARGE 800.00 4,200.00
02-Jul-2026 REVERSAL OF CHARGE 800.00 5,000.00
`,
    // (H) narration containing its own decimal number + CR/DR markers, and
    //     header noise that must NOT become a transaction
    'H: noisy narration + CR/DR': `
Statement Period: 01/07/2026 - 31/07/2026
As at 30/06/2026 Credit Limit 500,000.00
02/07/2026 FUEL 20.00 LTR AT LAUGFS 3,000.00 DR
03/07/2026 PAYMENT THANK YOU 15,000.00 CR
`,
};

const EXPECTED = {
    'A: single-amount + balance': 3,
    'B: two-column debit-first': 2,
    'C: no opening balance': 2,
    'D: credit card, no balance col': 3,
    'E: leading txn code': 2,
    'F: paren negatives': 1,
    'G: reversal pair': 2,
    'H: noisy narration + CR/DR': 2,
};

let fails = 0;
for (const [name, text] of Object.entries(FIXTURES)) {
    const res = P.parseStatement(text);
    const rows = res.rows;
    const want = EXPECTED[name];
    const ok = rows.length === want;
    if (!ok) fails++;
    const L = res.layout;
    console.log(`\n${ok ? 'OK  ' : 'FAIL'} ${name}  → parsed ${rows.length}/${want} rows   `
        + `[layout: ${L.balanceColumn ? 'balance column' : 'no balance column'}, agree ${L.agree}/${L.testable}]`);
    for (const r of rows) {
        console.log(`       ${r.date}  ${String(r.amount).padStart(12)}  ${(r.direction || '(none)').padEnd(7)}`
            + ` via ${String(r.directionSource || '-').padEnd(8)} bal=${r.balanceVerified ? 'Y' : 'n'}`
            + ` review=${r.needsReview ? 'Y' : 'n'}  "${r.narration}"`);
    }
    if (!rows.length) console.log('       (nothing parsed — every row dropped)');
    const rc = res.reconciliation;
    if (rc.ok !== null) {
        console.log(`       reconcile: open ${rc.opening} + cr ${rc.credits} - dr ${rc.debits}`
            + ` = ${rc.expected} vs closing ${rc.closing} → ${rc.ok ? 'BALANCES' : 'OFF BY ' + rc.difference}`);
    }
}
console.log(`\n${fails} fixture(s) parsed the wrong number of rows.`);
