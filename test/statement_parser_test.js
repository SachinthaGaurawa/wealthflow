// =============================================================================
// WealthFlow Shadow Test Harness — statement text-layer parsing
// =============================================================================
// The complaint this file exists to answer was "the OCR system and its automated
// categorization have severe faults and inaccuracies". A probe over nine real
// statement layouts found four concrete faults, two of which were total:
//
//   • credit-card statements (no balance column)      → 0 rows parsed
//   • rows with a leading reference code              → 0 rows parsed
//   • two-column statements with no opening balance   → first row amount 0.00
//   • parenthesised negatives                         → bracket in the narration
//
// Zero rows is the worst outcome, and not because the data is merely missing:
// wealthflow-ai-v4.js reads an empty result as "this PDF has no text layer" and
// falls through to the AI vision cascade. So the statements that failed here are
// exactly the ones that came back inaccurate — a machine-readable PDF handed to
// fuzzy image OCR. Fixing the parser removes the cause, and these tests are what
// stop each layout from silently dropping out again.
//
// A note on what is NOT asserted: nothing here claims a direction the statement
// does not state. Fixture E's first row has one amount column, no previous
// balance and no CR/DR marker — it is genuinely undecidable, and the assertion
// is that the parser says so (direction '', needsReview true) rather than
// guessing "debit" and being right 80% of the time.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';
import { FIXTURES, loadParser } from './statement-fixtures.mjs';

const P = loadParser(fs);

describe('statement parser: the module actually loaded', () => {
    it('exposes its API (guards against a vacuous pass)', () => {
        // Every test below reads P.*. If the IIFE failed to attach, they would all
        // throw rather than silently pass — but an empty FIXTURES list would make
        // the it.each blocks vanish entirely, which is the failure mode this
        // project keeps hitting: green because nothing was examined.
        expect(typeof P.parseStatementText).toBe('function');
        expect(typeof P.parseStatement).toBe('function');
        expect(FIXTURES.length).toBeGreaterThanOrEqual(9);
    });
});

describe.each(FIXTURES)('layout $name', (fx) => {
    const result = () => P.parseStatement(fx.text);

    it('parses exactly the expected number of transactions', () => {
        const rows = result().rows;
        const got = rows.map((r) => `${r.date} ${r.amount} ${r.direction || '?'} "${r.narration}"`).join('\n');
        expect(rows, `parsed:\n${got}`).toHaveLength(fx.rows.length);
    });

    it('detects the layout from the statement\'s own arithmetic', () => {
        expect(result().layout.balanceColumn).toBe(fx.balanceColumn);
    });

    it('reads every field of every row correctly', () => {
        const rows = result().rows;
        fx.rows.forEach((want, i) => {
            const got = rows[i];
            expect(got, `row ${i} missing`).toBeTruthy();
            expect(got.date, `row ${i} date`).toBe(want.date);
            expect(got.amount, `row ${i} amount`).toBeCloseTo(want.amount, 2);
            expect(got.direction, `row ${i} direction`).toBe(want.direction);
            expect(got.narration, `row ${i} narration`).toBe(want.narration);
            if (want.directionSource) expect(got.directionSource, `row ${i} directionSource`).toBe(want.directionSource);
            if (want.needsReview !== undefined) expect(got.needsReview, `row ${i} needsReview`).toBe(want.needsReview);
        });
    });

    it('never reports a zero amount as a usable transaction', () => {
        // This is the two-column no-opening-balance bug stated as an invariant:
        // a row saved with amount 0.00 is silent data loss, not a parse failure
        // the user can see.
        for (const r of result().rows) {
            if (r.amount === 0) expect(r.needsReview).toBe(true);
            else expect(r.amount).toBeGreaterThan(0);
        }
    });

    it('leaves no bracket, currency code or separator in a narration', () => {
        for (const r of result().rows) {
            expect(r.narration).not.toMatch(/[(]\s*$/);
            expect(r.narration).not.toMatch(/^\s|\s$/);
            expect(r.narration).not.toMatch(/\b(?:LKR|USD|Rs\.?)\s*$/i);
        }
    });

    if (fx.dateOrder) {
        it('works out which way round the numeric dates are written', () => {
            expect(result().dateOrder).toBe(fx.dateOrder);
        });
    }

    if (fx.reconciles) {
        it('reconciles: opening + credits − debits = closing', () => {
            const rc = result().reconciliation;
            expect(rc.ok, `off by ${rc.difference} (expected ${rc.expected}, closing ${rc.closing})`).toBe(true);
        });
    }
});

describe('statement parser: cross-validation catches what a regex cannot', () => {
    // A per-row check compares a row against its own neighbours, so it cannot
    // notice a row that was never parsed at all. The whole-statement identity
    // can: if a transaction is missing, the totals stop adding up.
    const withMissingRow = `
01/07/2026 OPENING BALANCE 100,000.00
02/07/2026 KEELLS SUPER 4,250.00 95,750.00
05/07/2026 CLOSING BALANCE 90,000.00
`;

    it('reports a mismatch when the rows do not explain the closing balance', () => {
        const rc = P.parseStatement(withMissingRow).reconciliation;
        expect(rc.ok).toBe(false);
        expect(rc.difference).toBeCloseTo(-5750, 2);
    });

    it('reports ok:null rather than a false pass when there is nothing to check', () => {
        // No opening line means the identity is unavailable. Saying "unknown" is
        // the honest answer; `ok: true` here would be a check that always passes.
        const rc = P.parseStatement('02/07/2026 PIZZA HUT 2,500.00 0.00 97,500.00\n').reconciliation;
        expect(rc.ok).toBeNull();
    });
});

describe('statement parser: undated opening/closing balance lines', () => {
    // Real statements often print "Opening Balance 10,000.00" with no date at
    // all. The parser's date gate used to drop those lines before OPENING_RE ever
    // saw them, leaving reconciliation.opening permanently null — so the
    // whole-statement cross-check could never run. They must be captured anyway.
    const bank = [
        'Opening Balance 10,000.00',
        '01/07/2026 SALARY 50,000.00 60,000.00 CR',
        '02/07/2026 GROCERY 5,000.00 55,000.00',
        'Closing Balance 55,000.00',
    ].join('\n');

    it('captures an undated opening balance and reconciles the statement', () => {
        const rc = P.parseStatement(bank).reconciliation;
        expect(rc.opening).toBe(10000);
        expect(rc.closing).toBe(55000);
        expect(rc.ok).toBe(true);
    });

    it('seeds the running total so the first row is verified, not guessed', () => {
        const rows = P.parseStatement(bank).rows;
        expect(rows[0].narration).toContain('SALARY');
        expect(rows[0].directionSource).toBe('balance');
        expect(rows[0].balanceVerified).toBe(true);
    });
});


describe('statement parser: header and summary lines are not transactions', () => {
    // The row filter is deliberately looser than it was — a single money token is
    // now enough, which is what makes credit-card statements parse. That shifts
    // the burden onto this filter, so it is tested directly.
    const noise = [
        'As at 30/06/2026 Credit Limit 500,000.00',
        'Statement Date: 25/07/2026 Total Amount Due 45,200.00',
        '25/07/2026 Minimum Payment Due 2,260.00',
        '01/07/2026 Total Debits 12,680.50',
        '01/07/2026 Transaction Summary 99,999.00',
        '30/06/2026 Available Credit 454,800.00',
        '25/07/2026 Reward Points Balance 1,250.00',
    ];

    it.each(noise)('ignores %s', (line) => {
        expect(P.parseStatement(line + '\n').rows).toHaveLength(0);
    });

    it('still imports a real transaction that sits between header lines', () => {
        const rows = P.parseStatement(
            'Statement Date: 25/07/2026 Total Amount Due 45,200.00\n'
            + '02/07/2026 UBER RIDE COLOMBO 1,250.00\n'
            + 'Available Credit 454,800.00\n'
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0].narration).toBe('UBER RIDE COLOMBO');
    });
});

describe('statement parser: the balance is ground truth over the printed amount', () => {
    it('corrects a misread amount from the running balance', () => {
        // A digit misread by OCR ("4,Z50.00" → 450.00) is invisible to any regex:
        // the token is well formed, just wrong. The bank's own running total is
        // the only thing that can catch it, and it wins.
        const rows = P.parseStatement(
            '01/07/2026 OPENING BALANCE 100,000.00\n'
            + '02/07/2026 KEELLS SUPER 450.00 95,750.00\n'
        ).rows;
        expect(rows[0].amount).toBeCloseTo(4250, 2);
        expect(rows[0].balanceVerified).toBe(true);
    });

    it('does not mark a row balance-verified when there is no balance to verify against', () => {
        const rows = P.parseStatement('02/07/2026 UBER RIDE 1,250.00\n').rows;
        expect(rows[0].balanceVerified).toBe(false);
    });

    it('a misread amount does not flip the layout decision', () => {
        // The reason layout detection cannot rest on the arithmetic alone. If the
        // only signal were "does the amount equal the balance delta", a misread
        // digit would fail the test, the parser would decide there is no balance
        // column, and the BALANCE would be imported as the amount — 95,750.00
        // instead of 4,250.00. Worse than the bug it replaced, and silent.
        const res = P.parseStatement(
            '01/07/2026 OPENING BALANCE 100,000.00\n'
            + '02/07/2026 KEELLS SUPER 450.00 95,750.00\n'
        );
        expect(res.layout.balanceColumn).toBe(true);
        expect(res.layout.evidence.balanceLine).toBe(true);
        expect(res.rows[0].amount).not.toBeCloseTo(95750, 2);
    });
});

describe('statement parser: layout evidence is weighed, not taken on one signal', () => {
    it('a credit-card "Previous Balance" line does not invent a balance column', () => {
        // Credit-card statements print a previous balance too, but their rows carry
        // no running total. Taking the line as proof would make every row's amount
        // be derived from a delta against a number it has nothing to do with.
        const res = P.parseStatement(
            'Previous Balance 12,500.00\n'
            + '02/07/2026 UBER RIDE COLOMBO 1,250.00\n'
            + '03/07/2026 NETFLIX 1,890.00\n'
        );
        expect(res.layout.balanceColumn).toBe(false);
        expect(res.rows.map((r) => r.amount)).toEqual([1250, 1890]);
    });

    it('sustained disagreement vetoes a balance column the header claims', () => {
        // Foreign-currency rows: "USD 25.00 @ 305.50 7,637.50". Three money columns
        // and a header naming Balance, but the last column is the local amount, and
        // the arithmetic says so row after row.
        const res = P.parseStatement(
            'Date Description Amount Balance\n'
            + '02/07/2026 AWS USD 25.00 305.50 7,637.50\n'
            + '03/07/2026 GITHUB USD 10.00 305.50 3,055.00\n'
            + '04/07/2026 OPENAI USD 20.00 305.50 6,110.00\n'
            + '05/07/2026 FIGMA USD 12.00 305.50 3,666.00\n'
        );
        expect(res.layout.evidence.veto).toBe(true);
        expect(res.layout.balanceColumn).toBe(false);
    });
});

describe('statement parser: safety', () => {
    it('never throws, on any input at all', () => {
        fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => {
            expect(() => P.parseStatement(s)).not.toThrow();
        }), { numRuns: runs(500) });
    });

    it('never throws on plausible statement-shaped noise', () => {
        const line = fc.tuple(
            fc.integer({ min: 1, max: 31 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 2020, max: 2030 }),
            fc.string({ maxLength: 30 }), fc.float({ min: 0, max: 1e6, noNaN: true }),
        ).map(([d, m, y, desc, amt]) => `${d}/${m}/${y} ${desc} ${amt.toFixed(2)}`);
        fc.assert(fc.property(fc.array(line, { maxLength: 20 }), (lines) => {
            const res = P.parseStatement(lines.join('\n'));
            expect(Array.isArray(res.rows)).toBe(true);
            for (const r of res.rows) {
                expect(Number.isFinite(r.amount)).toBe(true);
                expect(r.amount).toBeGreaterThanOrEqual(0);
                expect(['credit', 'debit', '']).toContain(r.direction);
            }
        }), { numRuns: runs(300) });
    });

    it('returns an empty result for empty and non-string input rather than throwing', () => {
        for (const x of ['', null, undefined, 0, {}, []]) {
            expect(P.parseStatement(x).rows).toEqual([]);
        }
    });

    it('keeps the original array-returning contract for existing callers', () => {
        // wealthflow-ai-v4.js calls parseStatementText() and maps over the result.
        const rows = P.parseStatementText(FIXTURES[0].text);
        expect(Array.isArray(rows)).toBe(true);
        expect(rows[0]).toHaveProperty('narration');
        expect(rows[0]).toHaveProperty('amount');
        expect(rows[0]).toHaveProperty('direction');
        expect(rows[0]).toHaveProperty('valid');
    });
});
