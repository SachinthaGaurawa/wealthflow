/* =============================================================================
 * test/estatement_parse_shapes_test.js — a decrypted statement must actually
 * yield its transactions
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * #116 made the encrypted NTB / AmEx "Smart Statement" decrypt natively, #119
 * made the file selectable and #120 made the DOB prompt usable. The statement
 * then unlocked correctly and reported:
 *
 *     "Couldn't read transactions from that e-statement."
 *
 * The decryption was fine. htmlToTransactions returned [] and the text fallback
 * in wealthflow-ai-v4.js had nothing to work with either, so the import ended at
 * zero rows with no explanation — the file opened and produced nothing.
 *
 * THE THREE CAUSES, ALL FOUND BY RUNNING THE PARSER RATHER THAN READING IT
 *
 *  1. ROWS RENDERED BY JAVASCRIPT. A Smart Statement is an application: the
 *     transactions sit in a JS array inside <script> and are drawn into the page
 *     on load. DOMParser does NOT execute scripts, so the parser saw an empty
 *     shell and found no <tr> at all. htmlToText strips <script> as well, so the
 *     text fallback was empty too — the two failures together are exactly the
 *     observed symptom.
 *  2. CELLS READ AS 'td' ONLY. A date or amount in a <th> dropped the whole row.
 *  3. ROWS WITH FEWER THAN THREE CELLS were discarded outright, which loses the
 *     layout that merges the date into the description cell.
 *
 * AND ONE THE PARSER GOT WRONG WITHOUT FAILING: the amount was chosen by
 * scanning cells LEFT TO RIGHT for the first number, so "FUEL 20.00 LTR AT
 * LAUGFS" was imported as a 20.00 charge instead of the real 8,430.50. A wrong
 * amount is worse than no amount, because nothing looks broken.
 *
 * WHY FIXTURES AND NOT THE REAL FILE
 *
 * The real statement is the user's own financial data and cannot live in a public
 * repository. Each fixture below is a LAYOUT the parser must survive, and every
 * one of them failed or mis-parsed before this change.
 * ===========================================================================*/

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* A DOMParser shim covering exactly the calls the parser makes. It answers
 * 'td,th' as well as 'td', because reading only 'td' is one of the bugs under
 * test — a shim that could not tell them apart would let that bug pass. */
function makeDom(html) {
    const strip = (s) => s.replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
    return {
        body: { get textContent() { return strip(html.replace(/<script[\s\S]*?<\/script>/gi, '')); } },
        querySelectorAll(sel) {
            if (sel !== 'table') return [];
            return tables.map((t) => ({
                querySelectorAll: (s2) => (s2 !== 'tr' ? [] : [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => ({
                    querySelectorAll: (s3) => {
                        const want = s3.split(',').map((x) => x.trim().toLowerCase());
                        const cells = [];
                        for (const c of r[0].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
                            if (want.includes(c[1].toLowerCase())) cells.push({ textContent: strip(c[2]) });
                        }
                        return cells;
                    },
                }))),
            }));
        },
    };
}

let W;
beforeAll(() => {
    const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-html-statement.js'), 'utf8');
    const DOMParserShim = function () {};
    DOMParserShim.prototype.parseFromString = (h) => makeDom(h);
    const win = {};
    new Function('window', 'document', 'DOMParser', 'console', SRC)(
        win, { createElement: () => ({ style: {} }), head: {}, body: {} }, DOMParserShim, { log() {} });
    W = win.WFHtmlStatement;
});

/** Every layout is the SAME two transactions, so one expectation covers them all. */
const KEELLS = { date: '2026-08-03', narration: 'KEELLS SUPER COLOMBO', amount: 4250, direction: 'debit' };
const PAYMENT = { date: '2026-08-05', narration: 'PAYMENT - THANK YOU', amount: 15000, direction: 'credit' };

const SHAPES = {
    'NTB six-column table (Post | Txn | Description | Cur | Amount | LKR Dr/Cr)': `<table>
        <tr><th>Post Date</th><th>Transaction Date</th><th>Description</th><th>Currency</th><th>Amount</th><th>Amount (LKR)</th></tr>
        <tr><td>03-Aug-2026</td><td>02-Aug-2026</td><td>KEELLS SUPER COLOMBO</td><td>LKR</td><td>4,250.00</td><td>4,250.00 Dr</td></tr>
        <tr><td>05-Aug-2026</td><td>04-Aug-2026</td><td>PAYMENT - THANK YOU</td><td>LKR</td><td>15,000.00</td><td>15,000.00 Cr</td></tr>
        </table>`,

    'rows rendered from a JSON array inside <script>': `<div id="t"></div><script>
        var txnData=[{"postDate":"03-Aug-2026","description":"KEELLS SUPER COLOMBO","amount":"4,250.00","drCr":"Dr"},
        {"postDate":"05-Aug-2026","description":"PAYMENT - THANK YOU","amount":"15,000.00","drCr":"Cr"}];
        renderTable(txnData);</script>`,

    'a JS object literal — unquoted keys, single quotes, trailing comma': `<script>
        var rows=[{postDate:'03-Aug-2026',particulars:'KEELLS SUPER COLOMBO',amountLkr:'4,250.00',drCr:'Dr'},
        {postDate:'05-Aug-2026',particulars:'PAYMENT - THANK YOU',amountLkr:'15,000.00',drCr:'Cr'},];
        </script>`,

    'a <div> grid, each field in its own child element': `
        <div class="row"><div>03-Aug-2026</div><div>KEELLS SUPER COLOMBO</div><div>4,250.00 Dr</div></div>
        <div class="row"><div>05-Aug-2026</div><div>PAYMENT - THANK YOU</div><div>15,000.00 Cr</div></div>`,

    'the date merged into the description cell': `<table>
        <tr><td>03-Aug-2026 KEELLS SUPER COLOMBO</td><td>4,250.00 Dr</td></tr>
        <tr><td>05-Aug-2026 PAYMENT - THANK YOU</td><td>15,000.00 Cr</td></tr>
        </table>`,

    'the date in a <th>': `<table>
        <tr><th>03-Aug-2026</th><td>KEELLS SUPER COLOMBO</td><td>4,250.00 Dr</td></tr>
        <tr><th>05-Aug-2026</th><td>PAYMENT - THANK YOU</td><td>15,000.00 Cr</td></tr>
        </table>`,
};

describe('every statement layout yields its transactions', () => {
    it('the module loaded (guards a vacuous pass)', () => {
        expect(W, 'WFHtmlStatement did not initialise').toBeTruthy();
        expect(typeof W.htmlToTransactions).toBe('function');
    });

    for (const [name, html] of Object.entries(SHAPES)) {
        it(name, () => {
            const rows = W.htmlToTransactions(html);
            expect(rows, `${name} produced no transactions — the statement would open and import nothing`)
                .toHaveLength(2);
            expect(rows[0]).toEqual(KEELLS);
            expect(rows[1]).toEqual(PAYMENT);
        });
    }
});

describe('the TABLE layer handles table shapes on its own', () => {
    /* Asserting only through htmlToTransactions cannot tell which layer answered.
     * Breaking the table layer still passed every fixture above, because the
     * looser whole-text scan picked the rows up — the guard passed for a reason it
     * did not name. These pin the table layer directly, so a regression there is
     * caught even while the fallback still rescues the user. */
    it('reads a date out of a <th>, not just a <td>', () => {
        const rows = W._layerTables(
            `<table><tr><th>03-Aug-2026</th><td>KEELLS SUPER COLOMBO</td><td>4,250.00 Dr</td></tr></table>`);
        expect(rows, 'the table layer ignored a <th> cell and dropped the row').toHaveLength(1);
        expect(rows[0]).toEqual(KEELLS);
    });

    it('accepts a two-cell row with the date merged into the description', () => {
        const rows = W._layerTables(
            `<table><tr><td>03-Aug-2026 KEELLS SUPER COLOMBO</td><td>4,250.00 Dr</td></tr></table>`);
        expect(rows, 'the table layer discarded a row for having fewer than three cells').toHaveLength(1);
        expect(rows[0]).toEqual(KEELLS);
    });

    it('the layer really is the table layer (guards the guard)', () => {
        // It must find nothing in a script-only document — otherwise the two
        // assertions above could be passing through some other path.
        expect(W._layerTables(`<script>var r=[{d:"03-Aug-2026",n:"X",a:"1.00"}]</script>`)).toEqual([]);
    });
});

describe('the SCRIPT layer handles script-rendered rows on its own', () => {
    it('parses a JSON array with no table present at all', () => {
        const rows = W._layerScripts(
            `<script>var t=[{"postDate":"03-Aug-2026","description":"KEELLS SUPER COLOMBO","amount":"4,250.00","drCr":"Dr"}];</script>`);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(KEELLS);
    });

    it('finds nothing when there is no script (guards the guard)', () => {
        expect(W._layerScripts(`<table><tr><td>03-Aug-2026</td><td>X</td><td>1.00</td></tr></table>`)).toEqual([]);
    });
});

describe('the amount is the amount, not the first number on the row', () => {
    it('a decimal inside the description is not imported as the charge', () => {
        // Left-to-right scanning made this a 20.00 charge. Wrong amounts are worse
        // than none: the import succeeds and the total is quietly false.
        const rows = W.htmlToTransactions(
            `<table><tr><td>02-Aug-2026</td><td>FUEL 20.00 LTR AT LAUGFS</td><td>8,430.50</td></tr></table>`);
        expect(rows).toHaveLength(1);
        expect(rows[0].amount, 'the description decimal was taken as the amount').toBe(8430.5);
        expect(rows[0].narration).toBe('FUEL 20.00 LTR AT LAUGFS');
    });

    it('skips the currency column rather than reading it as money', () => {
        const rows = W.htmlToTransactions(
            `<table><tr><td>02-Aug-2026</td><td>ODEL COLOMBO</td><td>LKR</td><td>5,000.00 Dr</td></tr></table>`);
        expect(rows[0].amount).toBe(5000);
        expect(rows[0].narration).toBe('ODEL COLOMBO');
    });
});

describe('a merchant name is not mistaken for a currency code', () => {
    // Stripping a trailing [A-Z]{3} turned "PAYMENT - THANK YOU" into
    // "PAYMENT - THANK", and would equally truncate LTD, PLC, KFC.
    for (const tail of ['THANK YOU', 'SINGER SRI LANKA LTD', 'JOHN KEELLS PLC', 'KFC']) {
        it(`keeps "${tail}" intact`, () => {
            const rows = W.htmlToTransactions(
                `<table><tr><td>02-Aug-2026</td><td>${tail}</td><td>1,000.00 Dr</td></tr></table>`);
            expect(rows).toHaveLength(1);
            expect(rows[0].narration).toBe(tail);
        });
    }

    it('still drops a real trailing currency code', () => {
        const rows = W.htmlToTransactions(
            `<table><tr><td>02-Aug-2026</td><td>AMAZON PURCHASE USD</td><td>1,000.00 Dr</td></tr></table>`);
        expect(rows[0].narration).toBe('AMAZON PURCHASE');
    });
});

describe('direction is read from what the statement actually marks', () => {
    const cases = [
        ['1,000.00 Dr', 'debit'],
        ['1,000.00 Cr', 'credit'],
        ['(1,000.00)', 'credit'],
        ['-1,000.00', 'credit'],
        ['1,000.00', 'debit'],      // unmarked defaults to a charge
    ];
    for (const [cell, want] of cases) {
        it(`"${cell}" is a ${want}`, () => {
            const rows = W.htmlToTransactions(
                `<table><tr><td>02-Aug-2026</td><td>SOME MERCHANT</td><td>${cell}</td></tr></table>`);
            expect(rows).toHaveLength(1);
            expect(rows[0].direction).toBe(want);
            expect(rows[0].amount).toBe(1000);
        });
    }
});

describe('dates, across every separator and order a statement uses', () => {
    /* '.' was missing entirely, so 02.08.2026 dropped every row. Worse, a 4-digit
     * first group fell through to the day-first branch and turned 2026/08/02 into
     * 2002-08-26 — a WRONG date imported silently, which is worse than none. */
    const DATES = [
        ['02-Aug-2026', '2026-08-02'], ['02 Aug 2026', '2026-08-02'],
        ['02/08/2026', '2026-08-02'], ['02-08-2026', '2026-08-02'],
        ['02.08.2026', '2026-08-02'], ['2026-08-02', '2026-08-02'],
        ['2026/08/02', '2026-08-02'], ['2026.08.02', '2026-08-02'],
        ['Aug 02, 2026', '2026-08-02'], ['Aug 2 2026', '2026-08-02'],
        ['02.Aug.2026', '2026-08-02'], ['2 August 2026', '2026-08-02'],
        ['02/Aug/2026', '2026-08-02'], ['02082026', '2026-08-02'],
    ];
    for (const [raw, want] of DATES) {
        it(`"${raw}" → ${want}`, () => {
            const rows = W.htmlToTransactions(
                `<table><tr><td>${raw}</td><td>ODEL COLOMBO</td><td>5,000.00 Dr</td></tr></table>`);
            expect(rows, `"${raw}" was dropped — every row on such a statement is lost`).toHaveLength(1);
            expect(rows[0].date, `"${raw}" parsed to the wrong date`).toBe(want);
        });
    }

    it('a day past 12 settles a US-order statement', () => {
        const rows = W.htmlToTransactions(
            `<table><tr><td>07/25/2026</td><td>ODEL COLOMBO</td><td>5,000.00 Dr</td></tr></table>`);
        expect(rows[0].date).toBe('2026-07-25');
    });

    it('refuses an impossible date rather than inventing one', () => {
        expect(W.htmlToTransactions(
            `<table><tr><td>45/45/2026</td><td>ODEL COLOMBO</td><td>5,000.00 Dr</td></tr></table>`)).toEqual([]);
    });
});

describe('amounts, across every grouping convention', () => {
    /* "1.234,56" was dropped: the old reader stripped commas then matched the first
     * \d+(\.\d{1,2})?, which on "5.000,00" is "5.000" — five, not five thousand. */
    const AMOUNTS = [
        ['5,000.00 Dr', 5000, 'debit'], ['5000.00', 5000, 'debit'],
        ['LKR 5,000.00', 5000, 'debit'], ['Rs. 5,000.00', 5000, 'debit'],
        ['5.000,00', 5000, 'debit'], ['5 000,00', 5000, 'debit'],
        ['1.234,56', 1234.56, 'debit'], ['1,234.56', 1234.56, 'debit'],
        ['(5,000.00)', 5000, 'credit'], ['-5,000.00', 5000, 'credit'],
        ['5,000.00-', 5000, 'credit'], ['5,000.00 CR', 5000, 'credit'],
    ];
    for (const [raw, amount, dir] of AMOUNTS) {
        it(`"${raw}" → ${amount} ${dir}`, () => {
            const rows = W.htmlToTransactions(
                `<table><tr><td>02-Aug-2026</td><td>ODEL COLOMBO</td><td>${raw}</td></tr></table>`);
            expect(rows, `"${raw}" was dropped`).toHaveLength(1);
            expect(rows[0].amount, `"${raw}" parsed to the wrong amount`).toBe(amount);
            expect(rows[0].direction).toBe(dir);
        });
    }
});

describe('the diagnostic reports the shape without leaking the contents', () => {
    /* "Couldn't read transactions" named no cause, so the only way forward was to
     * guess at layouts and ship another build. This reports what was actually
     * seen — and must never carry an amount, a card number or a merchant. */
    const SAMPLE = `<table>
        <tr><td>03-Aug-2026</td><td>KEELLS SUPER COLOMBO</td><td>4,250.00 Dr</td></tr>
        </table><script>var x=[1,2,3];</script>`;

    it('counts what the parser saw', () => {
        const d = W.diagnose(SAMPLE);
        expect(d.tables).toBe(1);
        expect(d.rows).toBe(1);
        expect(d.cells).toBe(3);
        expect(d.dateCells).toBe(1);
        expect(d.moneyCells).toBe(1);
        expect(d.scripts).toBe(1);
        expect(d.chars).toBeGreaterThan(50);
    });

    it('masks every digit in the sample lines', () => {
        const d = W.diagnose(SAMPLE);
        for (const line of d.samples) {
            expect(line, `a digit survived into "${line}"`).not.toMatch(/\d/);
        }
    });

    it('never contains an amount or a date verbatim', () => {
        const d = W.diagnose(SAMPLE);
        const blob = JSON.stringify(d);
        expect(blob).not.toContain('4,250.00');
        expect(blob).not.toContain('03-Aug-2026');
    });

    it('summarises to one screenshot-able line', () => {
        expect(W.diagLine(W.diagnose(SAMPLE))).toMatch(/tables 1 .* rows 1 .* scripts 1/);
    });

    it('does not throw on junk', () => {
        for (const junk of ['', null, undefined, '<<<']) {
            expect(() => W.diagnose(junk)).not.toThrow();
        }
    });
});

describe('a real statement is recognised, and a correct DOB is not called wrong', () => {
    /* looksLikeStatement needed THREE keyword hits. A sparse but perfectly real
     * statement — a heading, a table, nothing else — scores one. That matters
     * twice, because the same function decides whether a DECRYPTION succeeded: a
     * correct Date of Birth on such a file was reported as incorrect, three times,
     * and then gave up. */
    const SPARSE = `<html><body><h1>Card Statement</h1><table>
        <tr><td>02-Aug-2026</td><td>ODEL COLOMBO</td><td>5,000.00</td></tr>
        </table></body></html>`;

    it('accepts a sparse statement that scores only one keyword', () => {
        expect(W.looksLikeStatement(SPARSE),
            'a real statement is rejected as "not a bank statement"').toBe(true);
    });

    it('accepts on TWO keywords alone, with no date/amount anywhere', () => {
        // Isolates the keyword threshold: the structural signal cannot rescue this
        // one, so raising the bar back to three fails here and nowhere else.
        const words = '<html><body><h2>Account Summary</h2><p>Cardholder copy</p></body></html>';
        expect(/\d[.,]\d{2}/.test(words), 'fixture leaked an amount — it would pass structurally').toBe(false);
        expect(W.looksLikeStatement(words),
            'a statement scoring two keywords is rejected as "not a bank statement"').toBe(true);
    });

    it('accepts one on the structural signal alone — a date beside an amount', () => {
        expect(W.looksLikeStatement('<div>14/07/2026 SOME MERCHANT 1,250.00</div>')).toBe(true);
    });

    it('still rejects a page that is neither', () => {
        expect(W.looksLikeStatement('<html><body><p>Hello world</p></body></html>')).toBe(false);
        expect(W.looksLikeStatement('')).toBe(false);
    });

    it('detects an encrypted file however the payload variable is spelled', () => {
        for (const decl of ['var embedded', 'let embedded', 'const payload', 'var cipherText', 'const encrypted']) {
            const file = `<script>${decl} = "AAAA"; CryptoJS.PBKDF2(p, s, {keySize:4});</script>`;
            expect(W.isEncryptedHtmlStatement(file), `${decl} was not recognised as encrypted`).toBe(true);
        }
    });

    it('does not call an ordinary page encrypted', () => {
        expect(W.isEncryptedHtmlStatement('<html><body>hi</body></html>')).toBe(false);
    });
});

describe('it does not invent transactions', () => {
    it('returns nothing for a page with no rows at all', () => {
        expect(W.htmlToTransactions('<html><body><h1>Statement</h1><p>No activity.</p></body></html>')).toEqual([]);
    });

    it('ignores header and total rows that carry no date', () => {
        const rows = W.htmlToTransactions(`<table>
            <tr><th>Date</th><th>Description</th><th>Amount</th></tr>
            <tr><td>02-Aug-2026</td><td>ODEL COLOMBO</td><td>5,000.00 Dr</td></tr>
            <tr><td></td><td>TOTAL</td><td>5,000.00</td></tr>
            </table>`);
        expect(rows).toHaveLength(1);
        expect(rows[0].narration).toBe('ODEL COLOMBO');
    });

    it('is empty, not throwing, on junk input', () => {
        for (const junk of ['', null, undefined, '<<<', '{]', '<table><tr><td>x']) {
            expect(() => W.htmlToTransactions(junk)).not.toThrow();
            expect(W.htmlToTransactions(junk)).toEqual([]);
        }
    });

    it('de-dupes a row that appears in both a summary and a detail table', () => {
        const one = `<tr><td>02-Aug-2026</td><td>ODEL COLOMBO</td><td>5,000.00 Dr</td></tr>`;
        const rows = W.htmlToTransactions(`<table>${one}</table><table>${one}</table>`);
        expect(rows).toHaveLength(1);
    });
});
