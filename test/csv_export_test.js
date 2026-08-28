/* =============================================================================
 * test/csv_export_test.js — the analytics export was corrupting its own output
 * -----------------------------------------------------------------------------
 * exportCSVReport() ran every text field through _wfEsc, which is an HTML
 * escaper. That is wrong in both directions at once:
 *
 *   ADDED what a CSV must not have — a bank named "Sampath & Co" was written
 *   as "Sampath &amp; Co", which is exactly what the owner saw in Excel.
 *
 *   OMITTED what a CSV requires — a description containing a comma ("Dinner,
 *   groceries") split into two cells and shifted every column after it on that
 *   row, so the amount was read under the wrong heading. A newline broke the
 *   row outright.
 *
 * The function is EXECUTED here, lifted out of index.html, rather than checked
 * by reading the source. Reading is what let the original ship.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');

/** The page's own _csvCell, run as itself. */
const cell = (() => {
    const at = html.search(/\n\s*function _csvCell\s*\(/);
    expect(at, 'index.html no longer defines _csvCell').toBeGreaterThan(-1);
    let i = html.indexOf('{', html.indexOf(')', at));
    let depth = 0;
    let end = i;
    for (let j = i; j < html.length; j += 1) {
        if (html[j] === '{') depth += 1;
        else if (html[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    return new Function(`${html.slice(at, end)}; return _csvCell;`)();
})();

/** One row, the way the export builds one. */
const row = (...cells) => cells.map(cell).join(',');

describe('values pass through unchanged when nothing needs escaping', () => {
    it.each([
        ['HNB', 'HNB'],
        ['Groceries', 'Groceries'],
        ['12500', '12500'],
        ['-500', '-500'],
        ['0.5', '0.5'],
        ['', ''],
    ])('%s stays %s', (input, want) => {
        expect(cell(input)).toBe(want);
    });

    it('a number keeps its type when it arrives as one', () => {
        expect(cell(12500)).toBe('12500');
        expect(cell(-500)).toBe('-500');
    });

    it('null and undefined become empty, not the word', () => {
        expect(cell(null)).toBe('');
        expect(cell(undefined)).toBe('');
    });
});

describe('THE REGRESSION: an ampersand is not HTML', () => {
    it('"Sampath & Co" is written as itself', () => {
        /* _wfEsc turned this into "Sampath &amp; Co" in the downloaded file. */
        expect(cell('Sampath & Co')).toBe('Sampath & Co');
        expect(cell('Sampath & Co')).not.toContain('&amp;');
    });

    it.each(["O'Brien", 'a < b', 'a > b', 'Tom & Jerry & Co'])('%s is not HTML-escaped', (v) => {
        const out = cell(v);
        expect(out).not.toContain('&amp;');
        expect(out).not.toContain('&#39;');
        expect(out).not.toContain('&lt;');
        expect(out).not.toContain('&gt;');
        expect(out).not.toContain('&quot;');
    });

    it('a quote is doubled, not turned into an entity', () => {
        expect(cell('say "hi"')).toBe('"say ""hi"""');
    });
});

describe('THE REGRESSION: a comma no longer shifts the columns', () => {
    it('quotes a value containing a comma', () => {
        expect(cell('Dinner, groceries')).toBe('"Dinner, groceries"');
    });

    it('a four-cell row stays four cells when a description has commas', () => {
        const line = row('EXPENSE', 'Food', 'Dinner, groceries, drinks', 4200);
        /* Parsed the way a spreadsheet does: quoted sections are one field. */
        const fields = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)
            .map((f) => f.replace(/,$/, ''))
            .filter((f, i, a) => !(f === '' && i === a.length - 1));
        expect(fields.length, `row split into ${fields.length} cells: ${line}`).toBe(4);
        expect(fields[3]).toBe('4200');
    });

    it('a newline in a value does not break the row', () => {
        expect(cell('line one\nline two')).toBe('"line one\nline two"');
        expect(cell('carriage\rreturn')).toBe('"carriage\rreturn"');
    });
});

describe('a statement description cannot become a spreadsheet formula', () => {
    /* Descriptions arrive from the bank, and their text is whatever the other
     * party typed into a transfer memo — third-party input landing in a file
     * that Excel and Sheets evaluate on open. */
    it.each(['=1+1', '=SUM(A1:A9)', '+1', '@SUM(1)', '=cmd|/c calc'])('%s is neutralised', (v) => {
        const out = cell(v);
        expect(out.startsWith("'"), `${v} → ${out}`).toBe(true);
    });

    it('a negative AMOUNT is left alone, so the column still sums', () => {
        /* The guard must not fire on "-500". Prefixing it would write '-500 and
         * turn every refund into text. */
        expect(cell('-500')).toBe('-500');
        expect(cell('-1250.75')).toBe('-1250.75');
        expect(cell(-500)).toBe('-500');
    });

    it('but a description that merely starts with a dash IS guarded', () => {
        expect(cell('-- see note')).toBe("'-- see note");
    });

    it('a guarded value that also needs quoting gets both', () => {
        expect(cell('=A1,B2')).toBe('"\'=A1,B2"');
    });
});

describe('the export actually uses it', () => {
    const code = html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, '');
    const fn = code.slice(code.indexOf('function exportCSVReport'), code.indexOf('function exportCSVReport') + 1800);

    it('builds its rows through _csvCell', () => {
        expect(fn).toContain('_csvCell');
    });

    it('no longer runs CSV fields through the HTML escaper', () => {
        /* Comments stripped first: the comment explaining why _wfEsc is absent
         * would otherwise satisfy this check. */
        expect(fn).not.toContain('_wfEsc');
    });

    it('every data column goes through it, including the category', () => {
        /* e.cat had no escaping at all — a category with a comma in it shifted
         * the row exactly like a description did. */
        expect(fn).toMatch(/cells\.map\(_csvCell\)/);
        expect(fn).toContain("row('EXPENSE', e.cat, e.name, e.amount)");
    });
});

describe('what the previous implementation actually did', () => {
    /* _wfEsc is still in the page — it is the right tool for HTML and the wrong
     * one for this. Running it on the same inputs is the clearest statement of
     * why the export was corrupt, and it fails the moment anyone reaches for it
     * here again. */
    const wfEsc = (() => {
        const at = html.search(/\n\s*function _wfEsc\s*\(/);
        expect(at, 'index.html no longer defines _wfEsc').toBeGreaterThan(-1);
        let i = html.indexOf('{', html.indexOf(')', at));
        let depth = 0;
        let end = i;
        for (let j = i; j < html.length; j += 1) {
            if (html[j] === '{') depth += 1;
            else if (html[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
        }
        // eslint-disable-next-line no-new-func
        return new Function(`${html.slice(at, end)}; return _wfEsc;`)();
    })();

    it('mangled an ampersand — this is the corruption the owner would see', () => {
        expect(wfEsc('Sampath & Co')).toBe('Sampath &amp; Co');
        expect(cell('Sampath & Co')).toBe('Sampath & Co');
    });

    it('mangled an apostrophe in a merchant name', () => {
        expect(wfEsc("O'Brien")).toBe('O&#39;Brien');
        expect(cell("O'Brien")).toBe("O'Brien");
    });

    it('left a comma unquoted, which is what shifted the columns', () => {
        const old = ['EXPENSE', 'Food', wfEsc('Dinner, groceries'), '4200'].join(',');
        expect(old.split(',').length, 'the old row was four cells after all').toBe(5);

        const now = row('EXPENSE', 'Food', 'Dinner, groceries', '4200');
        const fields = now.match(/("([^"]|"")*"|[^,]*)(,|$)/g)
            .map((f) => f.replace(/,$/, ''))
            .filter((f, i, a) => !(f === '' && i === a.length - 1));
        expect(fields.length).toBe(4);
    });

    it('left a formula to be evaluated on open', () => {
        expect(wfEsc('=SUM(A1:A9)')).toBe('=SUM(A1:A9)');
        expect(cell('=SUM(A1:A9)').startsWith("'")).toBe(true);
    });
});
