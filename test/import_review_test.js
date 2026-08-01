// =============================================================================
// WealthFlow Shadow Test Harness — Import Review Queue (issue #48)
// =============================================================================
// The parser has always decided how far each row should be trusted, and said so:
// `valid`, `balanceVerified`, `directionSource`, `needsReview`. The router adds
// `confidence` and propagates upstream doubt rather than letting a confident
// CATEGORY paper over an unverified AMOUNT.
//
// None of it ever reached a screen. Every imported row looked equally certain —
// a row whose direction was openly ASSUMED presented exactly like one the bank's
// arithmetic confirmed to the cent. Machinery present, signal absent, for the
// fifth time in this repository.
//
// These tests are driven by the REAL fixtures in test/statement-fixtures.mjs,
// parsed by the REAL parser, rather than by rows invented to suit the queue.
// That matters: a hand-written row can be given whatever `directionSource` makes
// the assertion pass, which would test the test. Fixture D is a credit-card
// statement with no balance column, so every row's direction genuinely IS
// assumed; fixture A reconciles to the cent. The queue has to sort those apart
// using only what the parser actually emits for them.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';
import { FIXTURES, loadParser } from './statement-fixtures.mjs';

const P = loadParser(fs);

function load({ withMerchants = false } = {}) {
    // A REAL store. The learned registry round-trips through localStorage on
    // every read (_loadLearned re-parses it each call), so a stub whose getItem
    // always returns null makes teaching impossible and would have made the
    // "reports false when it could not teach" test pass for the wrong reason.
    const mem = new Map();
    const win = {
        localStorage: {
            getItem: (k) => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: (k) => mem.delete(k),
        },
    };
    const quiet = { log() {}, warn() {}, error() {} };
    if (withMerchants) {
        new Function('window', 'console', fs.readFileSync('wealthflow-merchants.js', 'utf8'))(win, quiet);
    }
    new Function('window', 'console', fs.readFileSync('wealthflow-import-review.js', 'utf8'))(win, quiet);
    return { R: win.WFImportReview, W: win };
}

const { R } = load();
const byName = (n) => FIXTURES.find((f) => f.name.startsWith(n));

describe('import review: the module loaded (guards against a vacuous pass)', () => {
    it('exposes the API these tests read', () => {
        expect(typeof R.triage).toBe('function');
        expect(typeof R.doubtOf).toBe('function');
        expect(typeof R.reconciliationNote).toBe('function');
        expect(FIXTURES.length).toBeGreaterThanOrEqual(9);
    });

    it('uses the router\'s existing threshold, not a new invention', () => {
        // 0.75 is what wealthflow-statement-router.js already applies and the
        // fixtures already exercise, so the queue starts out agreeing with the
        // routing it inherits instead of relitigating it.
        expect(R.THRESHOLD).toBe(0.75);
    });
});

describe('import review: rows the bank\'s own arithmetic confirms go straight through', () => {
    it('accepts every row of a reconciling statement', () => {
        // Fixture A: single amount column + running balance, reconciles to the
        // cent. Nothing here needs a human.
        const rows = P.parseStatement(byName('A:').text).rows;
        const t = R.triage(rows);
        expect(t.summary.total).toBe(3);
        expect(t.summary.needsReview).toBe(0);
        expect(t.summary.verified).toBeGreaterThan(0);
    });

    it('says WHY a row was trusted, not just that it was', () => {
        const rows = P.parseStatement(byName('A:').text).rows;
        for (const e of R.triage(rows).accept) {
            expect(e.evidence).toBeTruthy();
            expect(String(e.evidence).length).toBeGreaterThan(10);
        }
    });

    it('accepts a two-column statement where the column decides direction', () => {
        // Fixture B: the unused column prints 0.00, so WHICH column held the
        // amount is real evidence, not a guess.
        const rows = P.parseStatement(byName('B:').text).rows;
        expect(R.triage(rows).summary.needsReview).toBe(0);
    });
});

describe('import review: rows the statement never actually stated', () => {
    it('sends a whole no-balance credit-card statement to review', () => {
        // Fixture D parsed ZERO rows before the parser rewrite. Now it parses,
        // but every direction is assumed — one money token per row, no balance,
        // no marker. Committing those unseen is exactly the silent inaccuracy
        // the OCR complaint was about.
        const rows = P.parseStatement(byName('D:').text).rows;
        const t = R.triage(rows);
        expect(t.summary.total).toBe(3);
        expect(t.summary.needsReview).toBe(3);
        expect(t.summary.accepted).toBe(0);
    });

    it('states the doubt in words a person can act on', () => {
        const rows = P.parseStatement(byName('D:').text).rows;
        const [first] = R.triage(rows).review;
        expect(first.doubt).toMatch(/no running balance and no CR\/DR marker/);
        expect(first.reason).toBe(R.DOUBT.assumed);
    });

    it('groups identical doubts so forty rows are one decision, not forty', () => {
        // Without this the queue replaces "check everything" with "check
        // everything, one modal at a time", which is not an improvement.
        const rows = P.parseStatement(byName('D:').text).rows;
        const g = R.triage(rows).summary.byReason;
        expect(Object.keys(g)).toEqual([R.DOUBT.assumed]);
        expect(g[R.DOUBT.assumed].n).toBe(3);
        expect(g[R.DOUBT.assumed].text).toBeTruthy();
    });

    it('flags the genuinely undecidable row without guessing', () => {
        // Fixture E row 0: one amount column, no previous balance, no marker.
        // The parser reports direction '' rather than guessing; the queue must
        // carry that through as a question, not resolve it.
        const rows = P.parseStatement(byName('E:').text).rows;
        const t = R.triage(rows);
        const undecided = t.review.find((e) => e.reason === R.DOUBT.no_direction);
        expect(undecided, 'the undecidable row was not queued').toBeTruthy();
        expect(undecided.doubt).toMatch(/does not say whether this was money in or out/);
    });

    it('keeps the CR/DR-marked statement out of review', () => {
        // Fixture H has no balance column either, but it PRINTS markers — that
        // is stated evidence, not an assumption, and must not be confused with
        // fixture D or the queue becomes noise.
        const rows = P.parseStatement(byName('H:').text).rows;
        expect(R.triage(rows).summary.needsReview).toBe(0);
    });
});

describe('import review: the category is a separate question from the amount', () => {
    it('queues a row whose routing confidence is below the threshold', () => {
        const t = R.triage([{ valid: true, amount: 1000, direction: 'debit', directionSource: 'balance', confidence: 0.4 }]);
        expect(t.summary.needsReview).toBe(1);
        expect(t.review[0].reason).toBe(R.DOUBT.low_category);
        expect(t.review[0].doubt).toMatch(/40% confident/);
    });

    it('reports the worse fault first', () => {
        // An unreadable amount and a shaky category on the same row: saying "the
        // category is a guess" would bury the real problem.
        const t = R.triage([{ valid: true, amount: 0, direction: '', confidence: 0.1 }]);
        expect(t.review[0].reason).toBe(R.DOUBT.no_amount);
    });

    it('honours a caller-supplied threshold', () => {
        const row = [{ valid: true, amount: 1000, direction: 'debit', directionSource: 'balance', confidence: 0.8 }];
        expect(R.triage(row).summary.needsReview).toBe(0);
        expect(R.triage(row, { threshold: 0.9 }).summary.needsReview).toBe(1);
    });
});

describe('import review: the whole-statement arithmetic', () => {
    it('reports a mismatch, which no per-row check could notice', () => {
        // A row that was never parsed at all cannot be caught by comparing rows
        // to each other. The identity is the only thing that sees it.
        const parsed = P.parseStatement(
            '01/07/2026 OPENING BALANCE 100,000.00\n'
            + '02/07/2026 KEELLS SUPER 4,250.00 95,750.00\n'
            + '05/07/2026 CLOSING BALANCE 90,000.00\n',
        );
        const note = R.reconciliationNote(parsed);
        expect(note.level).toBe('warn');
        expect(note.text).toMatch(/do not explain the closing balance/);
        expect(note.text).toMatch(/5750|5,750/);
    });

    it('confirms a statement that does add up', () => {
        const note = R.reconciliationNote(P.parseStatement(byName('A:').text));
        expect(note.level).toBe('ok');
    });

    it('says "cannot be checked" rather than claiming a pass', () => {
        // ok === null. A check that always passes is worse than no check.
        const note = R.reconciliationNote(P.parseStatement('02/07/2026 PIZZA HUT 2,500.00 0.00 97,500.00\n'));
        expect(note.level).toBe('unknown');
        expect(note.text).toMatch(/cannot be cross-checked/);
    });
});

describe('import review: a correction teaches the classifier', () => {
    it('writes a human confirmation into the learned store', () => {
        // Point 4 of #48, and the reason accuracy compounds instead of staying
        // flat: the same statement layout should be right next month.
        //
        // A merchant the seed registry does NOT already recognise, so a pass
        // proves the LEARNED path fired rather than a built-in keyword. The
        // first version used "KEELLS SUPER COLOMBO" and matched the seed
        // 'keells' — green, and evidence of nothing.
        const { R: R2, W } = load({ withMerchants: true });
        const desc = 'ZZQ CONSULTING PVT LTD';
        expect(R2.teach(desc, 'expenses', 'Groceries')).toBe(true);
        const c = W.WFMerchants.classify(desc, 'debit');
        expect(c.category).toBe('Groceries');
        expect(c.matched).toMatch(/^learned:/);
    });

    it('reports FALSE when it could not teach, rather than claiming success', () => {
        // The classifier absent, or a category outside its taxonomy. Returning
        // true here would be a confirmation for work that did not happen — the
        // exact pattern this project keeps finding in itself.
        const { R: bare } = load({ withMerchants: false });
        expect(bare.teach('X', 'expenses', 'Groceries')).toBe(false);

        const { R: withM } = load({ withMerchants: true });
        expect(withM.teach('X', 'expenses', 'NotARealCategory')).toBe(false);
        expect(withM.teach('', 'expenses', 'Groceries')).toBe(false);
    });
});

describe('import review: safety', () => {
    it('never loses a row', () => {
        // A queue that drops a transaction on the way to being reviewed is worse
        // than no queue. Asserted across every real fixture.
        for (const fx of FIXTURES) {
            const rows = P.parseStatement(fx.text).rows;
            const t = R.triage(rows);
            expect(t.accept.length + t.review.length, fx.name).toBe(rows.length);
            expect(t.summary.accepted + t.summary.needsReview, fx.name).toBe(rows.length);
        }
    });

    it('never throws, on any row shape at all', () => {
        fc.assert(fc.property(fc.array(fc.anything(), { maxLength: 20 }), (rows) => {
            expect(() => R.triage(rows)).not.toThrow();
            const t = R.triage(rows);
            expect(t.accept.length + t.review.length).toBe(rows.length);
        }), { numRuns: runs(300) });
    });

    it('never throws on a malformed parse result', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => R.reconciliationNote(x)).not.toThrow();
        }), { numRuns: runs(200) });
    });

    it('every queued row carries a reason and a stable id', () => {
        fc.assert(fc.property(
            fc.array(fc.record({
                valid: fc.boolean(),
                amount: fc.float({ min: 0, max: 1e6, noNaN: true }),
                direction: fc.constantFrom('debit', 'credit', ''),
                confidence: fc.float({ min: 0, max: 1, noNaN: true }),
            }), { maxLength: 15 }),
            (rows) => {
                for (const e of R.triage(rows).review) {
                    expect(typeof e.doubt).toBe('string');
                    expect(e.doubt.length).toBeGreaterThan(5);
                    expect(Object.values(R.DOUBT)).toContain(e.reason);
                }
            },
        ), { numRuns: runs(300) });
    });
});
