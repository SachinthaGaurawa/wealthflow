// =============================================================================
// Statement layouts the parser must handle — the single source of truth.
// =============================================================================
// Imported by BOTH test/statement_parser_test.js (the CI gate) and
// test/e2e/_ocr_probe.mjs (a human-readable dump). One copy, so the thing CI
// enforces and the thing a person reads can never drift apart.
//
// Each fixture is a layout that a real statement uses, with the rows a human
// reading it would write down. Four of these produced wrong output before the
// parser was rewritten, two of them by producing NOTHING AT ALL — which the
// caller in wealthflow-ai-v4.js interprets as "no text layer" and answers by
// sending a perfectly machine-readable PDF to AI image OCR instead.
// =============================================================================

export const FIXTURES = [
    {
        name: 'A: single amount column + running balance',
        note: 'the one shape the previous parser handled',
        text: `
01/07/2026 OPENING BALANCE 100,000.00
02/07/2026 KEELLS SUPER COLOMBO 4,250.00 95,750.00
03/07/2026 SALARY JULY 250,000.00 345,750.00
05/07/2026 CEB ELECTRICITY 8,430.50 337,319.50
`,
        balanceColumn: true,
        rows: [
            { date: '2026-07-02', amount: 4250, direction: 'debit', narration: 'KEELLS SUPER COLOMBO', directionSource: 'balance' },
            { date: '2026-07-03', amount: 250000, direction: 'credit', narration: 'SALARY JULY', directionSource: 'balance' },
            { date: '2026-07-05', amount: 8430.5, direction: 'debit', narration: 'CEB ELECTRICITY', directionSource: 'balance' },
        ],
        reconciles: true,
    },
    {
        name: 'B: two-column Debit | Credit | Balance',
        note: 'the unused column prints as 0.00',
        text: `
01/07/2026 BALANCE B/F 50,000.00
02/07/2026 FUEL LAUGFS 3,000.00 0.00 47,000.00
03/07/2026 TRANSFER IN 0.00 20,000.00 67,000.00
`,
        balanceColumn: true,
        rows: [
            { date: '2026-07-02', amount: 3000, direction: 'debit', narration: 'FUEL LAUGFS' },
            { date: '2026-07-03', amount: 20000, direction: 'credit', narration: 'TRANSFER IN' },
        ],
        reconciles: true,
    },
    {
        name: 'C: two-column with NO opening-balance row',
        note: 'REGRESSION: the first row used to be saved with amount 0.00, because '
            + 'the second-to-last money token is the empty column and the balance-delta '
            + 'repair cannot run on the first row — there is no previous balance yet.',
        text: `
02/07/2026 PIZZA HUT DEHIWALA 2,500.00 0.00 97,500.00
03/07/2026 ATM CASH 10,000.00 0.00 87,500.00
`,
        balanceColumn: true,
        rows: [
            // Direction comes from WHICH column held the amount, so a first row
            // with no previous balance still resolves.
            { date: '2026-07-02', amount: 2500, direction: 'debit', narration: 'PIZZA HUT DEHIWALA', directionSource: 'column' },
            { date: '2026-07-03', amount: 10000, direction: 'debit', narration: 'ATM CASH', directionSource: 'balance' },
        ],
    },
    {
        name: 'D: credit card — no balance column at all',
        note: 'REGRESSION: parsed ZERO rows. One money token per row failed the '
            + '`monies.length < 2` test, so the entire statement was discarded and the '
            + 'caller fell through to AI vision OCR.',
        text: `
02/07/2026 UBER RIDE COLOMBO 1,250.00
03/07/2026 NETFLIX SUBSCRIPTION 1,890.00
05/07/2026 DIALOG RELOAD 1,000.00
`,
        balanceColumn: false,
        rows: [
            // Direction is assumed here, and says so: no balance, no marker, no sign.
            { date: '2026-07-02', amount: 1250, direction: 'debit', narration: 'UBER RIDE COLOMBO', directionSource: 'assumed', needsReview: true },
            { date: '2026-07-03', amount: 1890, direction: 'debit', narration: 'NETFLIX SUBSCRIPTION', directionSource: 'assumed' },
            { date: '2026-07-05', amount: 1000, direction: 'debit', narration: 'DIALOG RELOAD', directionSource: 'assumed' },
        ],
    },
    {
        name: 'E: leading transaction/reference code before the date',
        note: 'REGRESSION: parsed ZERO rows — the date regex was anchored with ^.',
        text: `
TXN001 02/07/2026 CARGILLS FOOD CITY 3,120.00 96,880.00
TXN002 03/07/2026 SALARY 200,000.00 296,880.00
`,
        balanceColumn: true,
        rows: [
            // Genuinely undecidable: one amount column, no previous balance, no
            // marker. Left empty and flagged rather than guessed at.
            { date: '2026-07-02', amount: 3120, direction: '', narration: 'CARGILLS FOOD CITY', needsReview: true },
            { date: '2026-07-03', amount: 200000, direction: 'credit', narration: 'SALARY', directionSource: 'balance' },
        ],
    },
    {
        name: 'F: parenthesised negative',
        note: 'REGRESSION: the bracket leaked into the narration ("REFUND ADJUSTMENT (") '
            + 'and the sign it carried was ignored.',
        text: `
01/07/2026 OPENING BALANCE 10,000.00
02/07/2026 REFUND ADJUSTMENT (1,500.00) 11,500.00
`,
        balanceColumn: true,
        rows: [
            { date: '2026-07-02', amount: 1500, direction: 'credit', narration: 'REFUND ADJUSTMENT' },
        ],
        reconciles: true,
    },
    {
        name: 'G: DD-MMM-YYYY dates and a zero-delta reversal pair',
        note: 'a charge and its reversal must not both read as credits',
        text: `
01-Jul-2026 OPENING BALANCE 5,000.00
02-Jul-2026 DUPLICATE CHARGE 800.00 4,200.00
02-Jul-2026 REVERSAL OF CHARGE 800.00 5,000.00
`,
        balanceColumn: true,
        rows: [
            { date: '2026-07-02', amount: 800, direction: 'debit', narration: 'DUPLICATE CHARGE' },
            { date: '2026-07-02', amount: 800, direction: 'credit', narration: 'REVERSAL OF CHARGE' },
        ],
        reconciles: true,
    },
    {
        name: 'H: narration containing a decimal, CR/DR markers, header noise',
        note: 'REGRESSION: the narration was cut at the FIRST money token, so this row '
            + 'became "FUEL" — throwing away the merchant name the categoriser needs. '
            + 'The two header lines must not become transactions.',
        text: `
Statement Period: 01/07/2026 - 31/07/2026
As at 30/06/2026 Credit Limit 500,000.00
02/07/2026 FUEL 20.00 LTR AT LAUGFS 3,000.00 DR
03/07/2026 PAYMENT THANK YOU 15,000.00 CR
`,
        balanceColumn: false,
        rows: [
            { date: '2026-07-02', amount: 3000, direction: 'debit', narration: 'FUEL 20.00 LTR AT LAUGFS', directionSource: 'marker' },
            { date: '2026-07-03', amount: 15000, direction: 'credit', narration: 'PAYMENT THANK YOU', directionSource: 'marker' },
        ],
    },
    {
        name: 'I: MM/DD/YYYY statement, settled by a day > 12',
        note: 'the month must not be transposed just because the file uses US order',
        text: `
07/01/2026 OPENING BALANCE 20,000.00
07/25/2026 ODEL COLOMBO 5,000.00 15,000.00
`,
        balanceColumn: true,
        dateOrder: 'mdy',
        rows: [
            { date: '2026-07-25', amount: 5000, direction: 'debit', narration: 'ODEL COLOMBO' },
        ],
    },
];

/** Load the browser IIFE parser without touching globalThis. */
export function loadParser(fs) {
    const win = {};
    new Function('window', 'console', fs.readFileSync('wealthflow-statement-parser.js', 'utf8'))(win, { log() {} });
    return win.WFStatementParser;
}
