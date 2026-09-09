/* =============================================================================
 * test/statement_identity_test.js — invoices are not statements
 * -----------------------------------------------------------------------------
 * THE COMPLAINT, REPEATED FOUR TIMES, AND WHY IT KEPT NOT BEING FIXED
 *
 * The owner's screenshot shows a screen meant for bank statements holding:
 *
 *     Mail            · Invoice-NCQIAKMS-0008.pdf      Needs review
 *     Mail            · Receipt-2402-5154-7274.pdf     Needs review
 *     Dinapalagroup   · invoice-113674.pdf             Needs review
 *     Edl             · 5996631318_455.pdf             2 transactions ready
 *     Dfccbank        · DFCC Bank Statement - Jul 26.pdf
 *
 * Adding sender addresses did nothing, and the reason is one line in
 * planMessage: the only check on WHAT a document is lived inside
 * `if (who.known === false)`. It ran for unrecognised senders and for nobody
 * else — so approving a sender filed every PDF that sender ever mailed.
 *
 * That is not a corner case. approvedClauses widens the FETCH to the whole
 * domain deliberately, so a bank's second address can be discovered; an
 * approved supplier domain that also invoices you then delivers its invoices
 * into the queue. Approving a sender means "this sender may send me
 * statements". The code read it as "everything this sender sends is one".
 *
 * THE FOURTH ROW IS WHY THIS IS NOT A FILENAME RULE
 *
 * `5996631318_455.pdf` is a REAL statement — the same screenshot says it has
 * two transactions ready to check. It says nothing about being a statement. Any
 * rule of the form "the name must say statement" throws it away, and the owner
 * would have lost real money data to a junk filter. So the name layer may only
 * veto on POSITIVE evidence of being something else, and the text layer decides
 * everything else.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    VERDICT, nameVerdict, textVerdict, identify, admits, movementLines,
    STATEMENT_NAMES, NOT_STATEMENT_NAMES,
} from '../wealthflow-statement-identity.js';

/* The five documents from the owner's screenshot, by the names it shows. */
const SCREENSHOT = [
    ['Invoice-NCQIAKMS-0008.pdf', VERDICT.NOT_STATEMENT],
    ['Receipt-2402-5154-7274.pdf', VERDICT.NOT_STATEMENT],
    ['invoice-113674.pdf', VERDICT.NOT_STATEMENT],
    ['5996631318_455.pdf', VERDICT.UNSURE],          // a REAL statement — must survive
    ['DFCC Bank Statement - Jul 26.pdf', VERDICT.STATEMENT],
];

const REAL_STATEMENT = [
    'HATTON NATIONAL BANK PLC',
    'STATEMENT OF ACCOUNT',
    'Account No: 004010123456    Statement Period: 01/07/2026 to 31/07/2026',
    '',
    '01/07/2026 OPENING BALANCE 100,000.00',
    '02/07/2026 KEELLS SUPER COLOMBO 4,250.00 95,750.00',
    '03/07/2026 SALARY JULY 250,000.00 345,750.00',
    '05/07/2026 CEB ELECTRICITY 8,430.50 337,319.50',
    '31/07/2026 CLOSING BALANCE 337,319.50',
].join('\n');

const REAL_CARD_STATEMENT = [
    'AMERICAN EXPRESS',
    'Card Number: XXXX XXXX XXXX 4321',
    'Statement Date: 26/07/2026    Payment Due Date: 15/08/2026',
    'Credit Limit 500,000.00    Available Credit 412,000.00',
    'Minimum Amount Due 8,800.00',
    '02/07/2026 UBER RIDE COLOMBO 1,250.00',
    '03/07/2026 NETFLIX SUBSCRIPTION 1,890.00',
    '05/07/2026 DIALOG RELOAD 1,000.00',
].join('\n');

const AN_INVOICE = [
    'DINAPALA GROUP (PVT) LTD',
    'TAX INVOICE',
    'Invoice No: 113674        Invoice Date: 14/07/2026',
    'Bill To: S. Gaurawa',
    '',
    'Item              Qty    Unit Price    Line Total',
    'Ceiling fan        2      12,500.00     25,000.00',
    'Installation       1       3,500.00      3,500.00',
    'Sub Total 28,500.00',
    'VAT No 1049384-7000  VAT 18% 5,130.00',
    'Total 33,630.00',
].join('\n');

const A_RECEIPT = [
    'KEELLS SUPER — DEHIWALA',
    'CASH RECEIPT',
    'Receipt No 2402-5154-7274      Cashier: 07',
    'Qty  Description         Unit Price   Amount',
    '2    Milk 1L                 480.00     960.00',
    '1    Bread                   180.00     180.00',
    'Sub Total 1,140.00',
    'Tendered 2,000.00   Change Due 860.00',
    'Thank you for shopping with us',
].join('\n');

const A_PAYSLIP = [
    'SALARY SLIP — JULY 2026',
    'Basic Salary 180,000.00',
    'Gross Pay 245,000.00',
    'EPF 8% 14,400.00   ETF 3% 5,400.00',
    'Net Pay 219,200.00',
].join('\n');

describe('the module actually loaded', () => {
    it('exposes both layers (guards against a vacuous pass)', () => {
        for (const f of [nameVerdict, textVerdict, identify, admits, movementLines]) {
            expect(typeof f).toBe('function');
        }
        expect(Object.values(VERDICT)).toEqual(['statement', 'not-statement', 'unsure']);
        expect(STATEMENT_NAMES.length).toBeGreaterThan(5);
        expect(NOT_STATEMENT_NAMES.length).toBeGreaterThan(10);
    });
});

describe('LAYER 1 — the name, judged before anything is downloaded', () => {
    it.each(SCREENSHOT)('%s', (filename, want) => {
        expect(nameVerdict({ subject: '', filenames: [filename] }).verdict).toBe(want);
    });

    it('THE ROW THAT MUST SURVIVE: an opaque filename is never a rejection', () => {
        /* `5996631318_455.pdf` is a real statement with two transactions in it.
         * Silence is not evidence of being junk. */
        for (const opaque of ['5996631318_455.pdf', 'doc.pdf', '20260731.pdf', 'A4X99.PDF', '']) {
            expect(nameVerdict({ filenames: [opaque] }).verdict).not.toBe(VERDICT.NOT_STATEMENT);
        }
    });

    it('THE STATEMENT WORD OUTRANKS THE INVOICE WORD', () => {
        // A bank that titles its mail "e-Statement / Tax Invoice" exists.
        expect(nameVerdict({
            subject: 'Your e-Statement and Tax Invoice for July',
            filenames: ['estatement-jul.pdf'],
        }).verdict).toBe(VERDICT.STATEMENT);
    });

    it('THE OLD BUG, NAMED: a bare "bill" must never reject a card statement', () => {
        /* An earlier version of this pipeline searched for the bare words
         * `invoice` and `bill`, and card statements — commonly called bills —
         * were thrown away. `bill` only counts inside a phrase. */
        expect(nameVerdict({ subject: 'Your credit card bill is ready' }).verdict)
            .not.toBe(VERDICT.NOT_STATEMENT);
        expect(nameVerdict({ subject: 'Billing summary' }).verdict).not.toBe(VERDICT.NOT_STATEMENT);
        // but a document that names itself a utility bill is not a statement
        expect(nameVerdict({ subject: 'Your electricity bill for July' }).verdict)
            .toBe(VERDICT.NOT_STATEMENT);
    });

    it('reads the subject and the filenames together', () => {
        expect(nameVerdict({ subject: 'FYI', filenames: ['Statement_Aug2026.pdf'] }).verdict)
            .toBe(VERDICT.STATEMENT);
        expect(nameVerdict({ subject: 'Purchase Order 4471', filenames: ['doc.pdf'] }).verdict)
            .toBe(VERDICT.NOT_STATEMENT);
    });

    it('never throws, whatever it is handed', () => {
        fc.assert(fc.property(fc.string({ maxLength: 120 }), fc.string({ maxLength: 80 }), (a, b) => {
            expect(() => nameVerdict({ subject: a, filenames: [b] })).not.toThrow();
        }), { numRuns: runs(150) });
        for (const bad of [null, undefined, {}, { filenames: null }, { subject: 5 }]) {
            expect(() => nameVerdict(bad)).not.toThrow();
        }
    });
});

describe('LAYER 2 — the document, judged by what it contains', () => {
    it('a real bank statement is proven', () => {
        const v = textVerdict(REAL_STATEMENT);
        expect(v.verdict).toBe(VERDICT.STATEMENT);
        expect(v.evidence.map((e) => e.what).sort())
            .toEqual(['account', 'balance', 'movements', 'period']);
    });

    it('a real credit-card statement is proven, though it has no running balance', () => {
        const v = textVerdict(REAL_CARD_STATEMENT);
        expect(v.verdict).toBe(VERDICT.STATEMENT);
        expect(v.evidence.map((e) => e.what)).toContain('card-statement');
    });

    it.each([
        ['an invoice', AN_INVOICE],
        ['a till receipt', A_RECEIPT],
        ['a payslip', A_PAYSLIP],
    ])('%s is refused, and says why', (_name, text) => {
        const v = textVerdict(text);
        expect(v.verdict).toBe(VERDICT.NOT_STATEMENT);
        expect(v.reason.length).toBeGreaterThan(10);
        expect(v.against.length).toBeGreaterThan(0);
    });

    it('THE ASYMMETRY: what it cannot prove, it lets through', () => {
        /* Losing a real statement is far worse than showing one invoice, and the
         * owner's own standing rule is that nothing unreadable is dropped in
         * silence. */
        for (const vague of [
            'Dear customer, please find attached the document you requested. Regards, the team.',
            'Reference 4471 dated 02/07/2026 for 12,500.00 — kindly acknowledge receipt of this.',
        ]) {
            expect(textVerdict(vague).verdict).toBe(VERDICT.UNSURE);
            expect(admits(textVerdict(vague))).toBe(true);
        }
    });

    it('an image-only PDF is UNSURE, not a rejection — that is OCR’s problem', () => {
        const v = textVerdict('   \n \n');
        expect(v.verdict).toBe(VERDICT.UNSURE);
        expect(v.reason).toMatch(/scan|no text/i);
        expect(admits(v)).toBe(true);
    });

    it('ONE KEYWORD IS NOT ENOUGH — "available balance" sits on receipts too', () => {
        expect(textVerdict('Thank you. Available balance 1,240.00. Have a nice day. '
            + 'Reference number 88213 issued at the counter today.').verdict)
            .not.toBe(VERDICT.STATEMENT);
    });

    it('counts dated money rows, which is what a table of movements looks like', () => {
        expect(movementLines(REAL_STATEMENT)).toBeGreaterThanOrEqual(3);
        expect(movementLines(A_RECEIPT)).toBe(0);
        expect(movementLines('')).toBe(0);
        // a wall of text is not a table
        expect(movementLines('02/07/2026 ' + 'x'.repeat(500) + ' 1,000.00')).toBe(0);
    });

    it('never throws, whatever the text', () => {
        fc.assert(fc.property(fc.string({ maxLength: 600 }), (s) => {
            expect(() => textVerdict(s)).not.toThrow();
            expect(Object.values(VERDICT)).toContain(textVerdict(s).verdict);
        }), { numRuns: runs(120) });
        for (const bad of [null, undefined, 0, {}, []]) expect(() => textVerdict(bad)).not.toThrow();
    });
});

describe('the two layers together', () => {
    it('THE TEXT OUTRANKS THE NAME once the document is open', () => {
        // A bank that titles its mail "Invoice" and attaches a genuine statement.
        const v = identify({ subject: 'Invoice for July', filenames: ['invoice.pdf'], text: REAL_STATEMENT });
        expect(v.verdict).toBe(VERDICT.STATEMENT);
        expect(v.layer).toBe('text');
    });

    it('and an invoice named "statement" is still an invoice', () => {
        const v = identify({ subject: 'Your statement', filenames: ['statement.pdf'], text: AN_INVOICE });
        expect(v.verdict).toBe(VERDICT.NOT_STATEMENT);
    });

    it('with no text yet, the name is all there is', () => {
        expect(identify({ filenames: ['Invoice-0008.pdf'] }).layer).toBe('name');
        expect(identify({ filenames: ['Invoice-0008.pdf'] }).verdict).toBe(VERDICT.NOT_STATEMENT);
    });

    it('a name veto survives text that proves nothing', () => {
        const v = identify({ filenames: ['Invoice-0008.pdf'], text: 'Dear sir, please find attached.' });
        expect(v.verdict).toBe(VERDICT.NOT_STATEMENT);
    });
});

/* Position assertions must be made against CODE, not prose. The first draft of
 * this block matched `if (who.known === false)` inside the comment that explains
 * the bug, decided the veto sat below it, and failed a fix that was correct.
 * A comment describing a branch is not the branch. */
function codeOnly(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments, including the doc headers
        .replace(/^\s*\/\/.*$/gm, ' ');       // whole-line // comments
}

describe('THE FIX IS WIRED — the veto is universal, not only for unknown senders', () => {
    const ingest = codeOnly(fs.readFileSync('wealthflow-mail-ingest.mjs', 'utf8'));
    const intake = codeOnly(fs.readFileSync('wealthflow-mail-intake.js', 'utf8'));

    it('planMessage vetoes by name for EVERY sender, not only unrecognised ones', () => {
        const at = ingest.indexOf('const byName = nameVerdict(');
        expect(at, 'the universal veto is gone').toBeGreaterThan(-1);
        /* Above the `who.known === false` branch that used to own the only
         * check on what a document is — that narrowing IS the bug. */
        const narrow = ingest.indexOf('if (who.known === false)');
        expect(narrow).toBeGreaterThan(-1);
        expect(at).toBeLessThan(narrow);
        /* And BELOW the curated sender rule, deliberately. Both refusals are
         * true of a bill from a stranger and the sender one is the actionable
         * one — "you have not decided about this sender" offers a tap that
         * fixes it. What survives to the veto is every sender the owner has
         * already accepted, which is exactly the population the old code never
         * checked. */
        const curated = ingest.indexOf('if (policy.curated && !ownerApproved)');
        expect(curated).toBeGreaterThan(-1);
        expect(at).toBeGreaterThan(curated);
    });

    it('and it refuses with a reason of its own, not the sender one', () => {
        /* NOT_A_STATEMENT already means "nobody vouches for this sender AND
         * nothing says statement". Reusing it would tell an owner who approved
         * DFCC by name that DFCC is unrecognised. */
        expect(ingest).toContain('reason: REJECT.NOT_A_STATEMENT_DOC,');
        expect(ingest).toMatch(/NOT_A_STATEMENT_DOC: '[a-z-]{10,}'/);
        /* And it is COUNTED. An invoice correctly refused and a statement
         * wrongly refused have to be tellable apart by looking at the report. */
        const worth = ingest.indexOf('export function isWorthTelling');
        expect(ingest.slice(worth, worth + 900)).toContain('REJECT.NOT_A_STATEMENT_DOC');
    });

    it('the intake runs the text layer on every statement it opens', () => {
        expect(intake).toContain("from './wealthflow-statement-identity.js'");
        expect(intake).toContain('const identity = textVerdict(text);');
        expect(intake).toContain('QUARANTINE.NOT_A_STATEMENT');
        // and it runs AFTER the text is extracted, or there would be nothing to read
        expect(intake.indexOf('const identity = textVerdict(text);'))
            .toBeGreaterThan(intake.indexOf('await extractText('));
    });

    it('every refusal has a sentence the owner can act on', () => {
        expect(intake).toMatch(/\[QUARANTINE\.NOT_A_STATEMENT\]: '[^']{20,}'/);
    });

    it('the module is a .js, so Vercel serves it as JavaScript to the browser', () => {
        /* vercel.json sets Content-Type for /(wealthflow-[a-zA-Z0-9-]+\.js) only.
         * wealthflow-mail-intake.js is a browser module and imports this one, so
         * a .mjs here would be fetched with the wrong type and the import would
         * fail in production while every test on this machine passed. */
        expect(fs.existsSync('wealthflow-statement-identity.js')).toBe(true);
        expect(fs.existsSync('wealthflow-statement-identity.mjs')).toBe(false);
        const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
        const rule = vercel.headers.find((h) => /wealthflow-\[a-zA-Z0-9-\]\+\\\.js/.test(h.source));
        expect(rule, 'the Content-Type rule that makes this safe has moved').toBeTruthy();
    });
});
