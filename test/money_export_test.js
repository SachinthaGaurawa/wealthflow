/* =============================================================================
 * test/money_export_test.js — money that LEAVES the app
 * -----------------------------------------------------------------------------
 * Every figure on screen goes through fmtN(), which rounds to two decimals. Two
 * surfaces carry money OUT of the app — the analytics CSV and the printed
 * statement — and neither used it. Measured in a real browser with ordinary
 * data, seeded through the app's own DB.set and read back from the app's own
 * getMonthlyData:
 *
 *     screen              CSV file
 *     0.30                0.30000000000000004
 *     17,705.36           17705.357142857145
 *     18,706.25           18706.247142857148
 *
 * That file is opened in Excel and sent to accountants and banks. It is the one
 * place a number leaves this app as DATA rather than as a picture, and it was
 * the one place with no formatting at all.
 *
 * The printed statement had the opposite fault. fmtPay() was
 * `Math.round(n)` — whole rupees, on the line items AND on the totals — so the
 * document contradicted itself:
 *
 *     forty expense lines of 1,234.57  ->  forty printed 1,235s, summing to 49,400
 *     the total of those same lines    ->  printed 49,383
 *
 * Seventeen rupees apart, growing with every row, on a page headed "Statement".
 * Rounding the total to match the rounded lines would have made the columns foot
 * and the total wrong; printing the cents makes both right, which is the only
 * answer available on a financial document.
 *
 * WHAT WAS CHECKED AND FOUND CLEAN, so the next person does not re-do it:
 * accumulating 1,234.57 a thousand times drifts by 9.3e-9 — a billionth of a
 * cent, invisible in any currency; a reducing-balance lease paid to the cent
 * closes at exactly 0; and a sweep of all seventeen data screens with
 * drift-engineered values found ZERO visible numbers carrying three or more
 * decimals. The display layer was never the problem. The exports were.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');

/** A top-level `function NAME(` from the page, extracted and run as itself. */
function pageFn(name) {
    const at = html.search(new RegExp(`\\n\\s*function ${name}\\s*\\(`));
    expect(at, `index.html no longer defines ${name}`).toBeGreaterThan(-1);
    const i = html.indexOf('{', html.indexOf(')', at));
    let depth = 0;
    let end = i;
    for (let j = i; j < html.length; j += 1) {
        if (html[j] === '{') depth += 1;
        else if (html[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    return new Function(`${html.slice(at, end)}; return ${name};`)();
}

const csvMoney = pageFn('_csvMoney');
const csvCell = pageFn('_csvCell');

describe('_csvMoney: what a money column may contain', () => {
    it('THE REPRODUCTION: the three values the browser actually produced', () => {
        // Each of these was written into the file verbatim, beside a screen that
        // showed the rounded figure.
        expect(csvMoney(0.1 + 0.2)).toBe('0.30');
        expect(csvMoney(4500000 / 7)).toBe('642857.14');
        expect(csvMoney(1234.57 * 40)).toBe('49382.80');
        expect(csvMoney(18706.247142857148)).toBe('18706.25');
    });

    it('is always exactly two decimals, so a column of them lines up', () => {
        for (const v of [0, 1, -1, 1000, 0.005, 12345.6, -98765.4321, 1e6]) {
            expect(csvMoney(v)).toMatch(/^-?\d+\.\d{2}$/);
        }
    });

    it('AGREES WITH THE SCREEN, which is the property that matters', () => {
        /* THIS ASSERTION ALREADY EARNED ITS KEEP. _csvMoney was written with
         * toFixed(2) and a comment claiming it matched the screen's
         * toLocaleString. On 2.675 they differ — "2.67" against "2.68" — because
         * toFixed reads the binary value (2.67499999999999982) and Intl rounds
         * the decimal the number is trying to be. Checking the claim rather than
         * restating it found that in one run. */
        const screen = (n) => Number(n).toLocaleString('en-US',
            { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        for (const v of [0.1 + 0.2, 4500000 / 7, 2.675, 1234.565, 0.005, -0.125, 99.999]) {
            expect(csvMoney(v), `disagrees with the screen on ${v}`)
                .toBe(screen(v).replace(/,/g, ''));
        }
    });

    it('carries no separators and no currency symbol — a spreadsheet parses it', () => {
        expect(csvMoney(1234567.891)).toBe('1234567.89');
        expect(csvMoney(1234567.891)).not.toMatch(/[,A-Za-z ]/);
    });

    it('a rounded-away debit is not printed as negative zero', () => {
        expect(csvMoney(-0.001)).toBe('0.00');
        expect(csvMoney(-0.004)).toBe('0.00');
        expect(csvMoney(-0.006)).toBe('-0.01');   // genuinely a cent out
    });

    it('an unusable value is an empty cell, never the word NaN', () => {
        for (const v of [NaN, null, undefined, '', 'abc', {}, []]) expect(csvMoney(v)).toBe('');
        expect(csvMoney(Infinity)).toBe('');
    });

    it('the output still survives the cell escaper it is handed to', () => {
        // A leading '-' is a formula prefix in Excel; _csvCell exempts numbers,
        // and _csvMoney must keep producing something it recognises as one.
        expect(csvCell(csvMoney(-500))).toBe('-500.00');
        expect(csvCell(csvMoney(1234.5))).toBe('1234.50');
    });
});

describe('the export is actually wired to it', () => {
    const at = html.indexOf('function exportCSVReport()');
    const body = html.slice(at, html.indexOf('const blob = new Blob([csv]', at));

    it('exportCSVReport was found (guards against a vacuous pass)', () => {
        expect(at).toBeGreaterThan(-1);
        expect(body.length).toBeGreaterThan(400);
    });

    it('every amount column goes through _csvMoney', () => {
        for (const raw of ['l.amount', 'c.amount', 'e.amount']) {
            expect(body, `${raw} still written raw`).toContain(`_csvMoney(${raw})`);
            expect(body).not.toMatch(new RegExp(`,\\s*${raw.replace('.', '\\.')}\\s*\\)`));
        }
    });

    it('the SUMMARY lines go through the row builder, not template interpolation', () => {
        /* They used to be one template literal, so they skipped BOTH the money
         * formatting and the cell escaping every other line in the file gets. */
        expect(body).toContain("row('Total Income', '', _csvMoney(md.income))");
        expect(body).toContain("row('Total Expenses', '', _csvMoney(md.totalExp))");
        expect(body).toContain("row('Net Balance', '', _csvMoney(md.balance))");
        expect(body).not.toMatch(/\$\{md\.(income|totalExp|balance)\}/);
    });

    it('NO DISPLAY PREFERENCE reaches the file', () => {
        /* Privacy mode replaces figures with dots and "Round Display Amounts"
         * drops the cents. Both describe how the SCREEN looks. An export that
         * silently wrote "••••••", or dropped the cents because of a toggle,
         * would be a worse bug than the one being fixed. */
        const fn = html.slice(at, html.indexOf('notify(\'Analytics CSV Report', at));
        for (const banned of ['_wfDisplayPrefs', 'fmtN(', 'fmt(', 'fmtS(']) {
            expect(fn, `the export reads ${banned}`).not.toContain(banned);
        }
        const src = pageFn('_csvMoney').toString();
        expect(src).not.toContain('_wfDisplayPrefs');
        /* toLocaleString IS what it must call — the screen's rounding. What
         * it may not read is the display PREFERENCES. */
        expect(src).toContain('useGrouping: false');
    });
});

describe('the printed statement does not contradict itself', () => {
    const defs = html.match(/const fmtPay = \(n\) => [^\n]+/g) || [];

    it('both report builders define fmtPay (guards against a vacuous pass)', () => {
        expect(defs).toHaveLength(2);
    });

    it('neither rounds money to the whole rupee any more', () => {
        for (const d of defs) {
            expect(d, 'fmtPay still rounds to whole rupees').not.toContain('Math.round(n)');
            expect(d).toContain('minimumFractionDigits: 2');
            expect(d).toContain('maximumFractionDigits: 2');
        }
    });

    it('THE FOOTING: printed lines now add up to the printed total', () => {
        // eslint-disable-next-line no-new-func
        const fmtPay = new Function(`${defs[0]}; return fmtPay;`)();
        const num = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));

        for (const rows of [
            Array.from({ length: 40 }, () => 1234.57),
            [17705.357142857145, 0.1 + 0.2, 0.1 + 0.2, 0.1 + 0.2],
            [0.005, 0.005, 0.005, 0.005],
        ]) {
            const printedLines = rows.map((r) => num(fmtPay(r)));
            const linesSum = Math.round(printedLines.reduce((a, b) => a + b, 0) * 100) / 100;
            const printedTotal = num(fmtPay(rows.reduce((a, b) => a + b, 0)));
            // At two decimals the two can still differ by half a cent per row —
            // that is arithmetic, not a defect. Whole rupees made it 17 rupees.
            expect(Math.abs(linesSum - printedTotal))
                .toBeLessThanOrEqual(rows.length * 0.005 + 1e-9);
        }
    });

    it('and the old behaviour really was off by seventeen rupees', () => {
        // The measurement that justified the change, kept so the reason survives.
        const oldPay = (n) => Math.round(n);
        const rows = Array.from({ length: 40 }, () => 1234.57);
        const lines = rows.map(oldPay).reduce((a, b) => a + b, 0);
        const total = oldPay(rows.reduce((a, b) => a + b, 0));
        expect(lines - total).toBe(17);
    });

    it('still prints the currency and thousands separators a statement wants', () => {
        // eslint-disable-next-line no-new-func
        const fmtPay = new Function(`${defs[0]}; return fmtPay;`)();
        expect(fmtPay(1234567.891)).toBe('LKR 1,234,567.89');
        expect(fmtPay(0)).toBe('LKR 0.00');
        expect(fmtPay(null)).toBe('LKR 0.00');
        expect(fmtPay('not a number')).toBe('LKR 0.00');
    });
});
