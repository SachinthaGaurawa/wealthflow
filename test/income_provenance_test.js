// =============================================================================
// WealthFlow Shadow Test Harness — Income Provenance (issue #47)
// =============================================================================
// The number this module exists to make true: issue #46 showed LKR 0.00 income
// against LKR 3,464,337 of spending. The figure was honest and uninterrogable,
// which from the outside is the same thing as broken.
//
// Two paths disagreed. By hand, `incomeRecv` is a store somebody must remember
// to fill, so it sat empty and income read zero. By import, every credit was
// filed as income (fixed in #49), so the first statement imported would have
// read too HIGH — refunds and transfers between the user's own accounts
// counting as earnings. Zero, then over-counted; never right.
//
// What is asserted here is the POLICY: which kinds count, which can never
// count, what outranks what, and that every figure carries its derivation.
// Detection lives in wealthflow-merchants.js and is tested separately — the
// split is deliberate so there is exactly one place that decides what income
// means.
//
// The hardest thing to get right is precedence, and it is the thing most worth
// pinning: a refund typed in by hand is still a refund, and money not yet
// received is not income however it was entered.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';

/**
 * Load provenance, optionally with the real merchants detector alongside it.
 * `withDetector: false` proves the module degrades honestly when the detector
 * has not loaded — it must resolve `unknown` and refuse to count, never guess
 * in order to produce a bigger number.
 */
function load({ withDetector = true } = {}) {
    const win = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
    const quiet = { log() {}, warn() {}, error() {} };
    if (withDetector) {
        new Function('window', 'console', fs.readFileSync('wealthflow-merchants.js', 'utf8'))(win, quiet);
    }
    new Function('window', 'console', fs.readFileSync('wealthflow-income-provenance.js', 'utf8'))(win, quiet);
    return win.WFIncomeProvenance;
}

const P = load();

describe('income provenance: the module loaded (guards against a vacuous pass)', () => {
    it('exposes the API these tests read', () => {
        expect(typeof P.classifyRow).toBe('function');
        expect(typeof P.derive).toBe('function');
        expect(typeof P.explain).toBe('function');
        expect(Object.keys(P.KINDS).length).toBeGreaterThanOrEqual(7);
    });

    it('has the real detector wired in, not a stub', () => {
        // If merchants.js failed to load, every case below would resolve
        // `unknown` and several would pass for the wrong reason.
        expect(P.classifyRow({ name: 'SALARY JULY 2026', amount: 1 }).kind).toBe('salary');
    });
});

describe('income provenance: what counts as earnings', () => {
    it('counts salary', () => {
        const d = P.classifyRow({ name: 'SALARY JULY 2026', amount: 250000 });
        expect(d.kind).toBe('salary');
        expect(d.counts).toBe(true);
    });

    it('counts an investment return', () => {
        expect(P.classifyRow({ name: 'DIVIDEND PAYOUT JKH', amount: 12000 }).counts).toBe(true);
    });

    it('states a reason for every decision, always', () => {
        // A figure that cannot explain itself is the defect being removed.
        for (const name of ['SALARY JULY', 'REFUND ADJUSTMENT', 'NEFT CR 88371', 'DIVIDEND']) {
            const d = P.classifyRow({ name, amount: 1 });
            expect(d.reason, name).toBeTruthy();
            expect(String(d.reason).length, name).toBeGreaterThan(8);
        }
    });
});

describe('income provenance: what can never be income', () => {
    const never = [
        ['REFUND ADJUSTMENT', 'refund'],
        ['REVERSAL OF CHARGE', 'refund'],
        ['CASHBACK REWARD', 'refund'],
        ['TRANSFER FROM OWN ACCOUNT', 'internal_transfer'],
        ['LOAN DISBURSEMENT BOC', 'loan_drawdown'],
    ];

    it.each(never)('%s → %s, not counted', (name, kind) => {
        const d = P.classifyRow({ name, amount: 5000 });
        expect(d.kind).toBe(kind);
        expect(d.counts).toBe(false);
    });

    it('a refund entered BY HAND is still a refund', () => {
        // The precedence rule most likely to be got wrong. A user typing a
        // refund into the Income page must not thereby make it income — the
        // whole point is that the same money is not counted twice.
        const d = P.classifyRow({ name: 'REFUND from Daraz', amount: 5000, source: 'manual' });
        expect(d.counts).toBe(false);
        expect(d.reason).toMatch(/reduces the expense/i);
    });

    it('a row DECLARED as a transfer is excluded even if the text looks like salary', () => {
        const d = P.classifyRow({ name: 'SALARY ACCOUNT SWEEP', type: 'Transfer', amount: 100, source: 'manual' });
        expect(d.kind).toBe('internal_transfer');
        expect(d.counts).toBe(false);
    });
});

describe('income provenance: money that has not arrived is not income', () => {
    it('excludes a row explicitly marked not received', () => {
        // `incomeRecv` carries a `received` flag that nothing ever read, while
        // the figure it feeds claims to be money ACTUALLY received.
        const d = P.classifyRow({ name: 'SALARY AUGUST', amount: 250000, received: false });
        expect(d.counts).toBe(false);
        expect(d.reason).toMatch(/not marked received/i);
    });

    it('counts a row explicitly marked received', () => {
        expect(P.classifyRow({ name: 'SALARY AUGUST', amount: 250000, received: true }).counts).toBe(true);
    });

    it('leaves legacy rows alone when the flag is absent', () => {
        // Rows saved before the flag existed have it undefined. Treating that as
        // "not received" would silently drop real income from the total.
        const d = P.classifyRow({ name: 'SALARY JULY', amount: 250000 });
        expect(d.counts).toBe(true);
    });
});

describe('income provenance: a hand-entered row the detector cannot read', () => {
    it('trusts the user over the detector', () => {
        // Someone typing "Consulting — Jan" on the Income page has asserted it is
        // income. Refusing it because a regex did not recognise the wording would
        // reproduce the empty-store problem this feature exists to end.
        const d = P.classifyRow({ name: 'Consulting — Jan', amount: 80000, source: 'manual' });
        expect(d.counts).toBe(true);
        expect(d.reason).toMatch(/Income page/i);
    });

    it('does NOT extend that trust to an imported row', () => {
        const d = P.classifyRow({ name: 'NEFT CR 8837162', amount: 80000, source: 'import' });
        expect(d.counts).toBe(false);
        expect(d.kind).toBe('unknown');
    });
});

describe('income provenance: the derivation is the deliverable', () => {
    const rows = [
        { name: 'SALARY JULY', amount: 250000, date: '2026-07-01' },
        { name: 'SALARY AUGUST', amount: 250000, date: '2026-08-01' },
        { name: 'REFUND ADJUSTMENT', amount: 4000, date: '2026-07-15' },
        { name: 'TRANSFER FROM OWN ACCOUNT', amount: 100000, date: '2026-07-20' },
        { name: 'NEFT CR 8837162', amount: 9000, date: '2026-07-22' },
        { name: 'SALARY DECEMBER', amount: 250000, date: '2025-12-01' },
    ];

    it('totals only what counts', () => {
        const d = P.derive(rows, { year: 2026 });
        expect(d.total).toBe(500000);
    });

    it('excludes the rest and says how much', () => {
        const d = P.derive(rows, { year: 2026 });
        expect(d.excludedTotal).toBe(113000);        // 4,000 + 100,000 + 9,000
        expect(d.excluded).toHaveLength(3);
    });

    it('counts the unidentified separately so they can be reviewed', () => {
        expect(P.derive(rows, { year: 2026 }).needsReview).toBe(1);
    });

    it('respects the year filter', () => {
        expect(P.derive(rows, { year: 2025 }).total).toBe(250000);
        expect(P.derive(rows).total).toBe(750000);   // no filter → every year
    });

    it('breaks the total down by kind', () => {
        const d = P.derive(rows, { year: 2026 });
        expect(d.byKind.salary).toEqual({ n: 2, total: 500000, counts: true });
        expect(d.byKind.refund.counts).toBe(false);
    });

    it('every counted row carries its own reason', () => {
        for (const e of P.derive(rows, { year: 2026 }).counted) {
            expect(e.reason, JSON.stringify(e.row)).toBeTruthy();
        }
    });

    it('explains itself in words', () => {
        const lines = P.explain(P.derive(rows, { year: 2026 }));
        expect(lines.join('\n')).toMatch(/Counted 2 credits as income/);
        expect(lines.join('\n')).toMatch(/Transfer between your own accounts/);
        expect(lines.join('\n')).toMatch(/could not be identified/);
    });

    it('the arithmetic actually adds up', () => {
        // counted + excluded must equal everything examined — a derivation that
        // loses rows is exactly the silent data loss this repo keeps finding.
        const d = P.derive(rows);
        const seen = d.counted.length + d.excluded.length;
        expect(seen).toBe(rows.length);
        const sum = [...d.counted, ...d.excluded].reduce((t, e) => t + e.amount, 0);
        expect(sum).toBeCloseTo(d.total + d.excludedTotal, 2);
    });
});

describe('income provenance: degrades honestly without the detector', () => {
    const bare = load({ withDetector: false });

    it('resolves unknown rather than guessing', () => {
        expect(bare.classifyRow({ name: 'SALARY JULY 2026', amount: 1 }).kind).toBe('unknown');
    });

    it('refuses to count what it cannot identify', () => {
        // The failure mode to avoid is a module that, deprived of its detector,
        // falls back to "credit → income" and quietly reports a bigger number.
        expect(bare.classifyRow({ name: 'SALARY JULY 2026', amount: 1 }).counts).toBe(false);
    });

    it('still honours what the user declared', () => {
        expect(bare.classifyRow({ name: 'x', type: 'Salary', amount: 5 }).counts).toBe(true);
    });

    it('still honours a hand-entered row', () => {
        expect(bare.classifyRow({ name: 'x', amount: 5, source: 'manual' }).counts).toBe(true);
    });
});

// ── the wiring, not just the engine ──────────────────────────────────────────
// A module that computes the right answer and is never called is this repo's
// signature failure — imageSection(), the triage endpoint, the parser's
// confidence fields. Asserting the engine alone would repeat it.
describe('income provenance: the insights card actually uses it', () => {
    function loadInsightsStack(db) {
        const win = {
            DB: { get: (k) => (Object.prototype.hasOwnProperty.call(db, k) ? db[k] : []) },
            wfCardRegistry: { get: () => ({}) },
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            notify() {},
        };
        const quiet = { log() {}, warn() {}, error() {} };
        const node = () => ({ id: '', textContent: '', style: {}, appendChild() {}, setAttribute() {} });
        const doc = { getElementById: () => null, createElement: node, head: { appendChild() {} }, body: { appendChild() {} } };
        for (const f of ['wealthflow-merchants.js', 'wealthflow-income-provenance.js']) {
            new Function('window', 'console', fs.readFileSync(f, 'utf8'))(win, quiet);
        }
        new Function('window', 'document', 'console', fs.readFileSync('wealthflow-insights.js', 'utf8'))(win, doc, quiet);
        return win.WFInsights;
    }

    const year = new Date().getFullYear();
    const mixed = {
        incomeRecv: [
            { name: 'SALARY JULY', amount: 250000, date: year + '-07-01' },
            { name: 'REFUND ADJUSTMENT', amount: 4000, date: year + '-07-15' },
            { name: 'TRANSFER FROM OWN ACCOUNT', amount: 100000, date: year + '-07-20' },
            { name: 'NEFT CR 8837162', amount: 9000, date: year + '-07-22' },
        ],
        expenses: [{ date: year + '-03-01', amount: 500000 }],
    };

    it('does not report zero income when a real salary is present', () => {
        // The old sum would also have found 363,000 here — including the refund
        // and the transfer. The point is which number, not merely non-zero.
        const items = loadInsightsStack(mixed).income();
        expect(items.some((i) => i.kind === 'income_zero')).toBe(false);
    });

    it('tells the user what arrived and was deliberately not counted', () => {
        const card = loadInsightsStack(mixed).income().find((i) => i.kind === 'income_excluded');
        expect(card, 'no exclusion card produced').toBeTruthy();
        expect(card.title).toMatch(/113,000/);              // 4,000 + 100,000 + 9,000
        expect(card.body).toMatch(/refund/i);
        expect(card.body).toMatch(/own accounts/i);
        expect(card.go).toBe('incRecv');                     // and it is a live button
    });

    it('surfaces credits it could not identify instead of guessing', () => {
        const card = loadInsightsStack(mixed).income().find((i) => i.kind === 'income_review');
        expect(card).toBeTruthy();
        expect(card.title).toMatch(/1 credit could not be identified/);
        expect(card.go).toBe('incRecv');
    });

    it('says nothing extra when every credit is clean', () => {
        const items = loadInsightsStack({
            incomeRecv: [{ name: 'SALARY JULY', amount: 250000, date: year + '-07-01' }],
            expenses: [{ date: year + '-03-01', amount: 500000 }],
        }).income();
        expect(items.filter((i) => i.kind === 'income_excluded' || i.kind === 'income_review')).toHaveLength(0);
    });

    it('still shows the #46 card when there is genuinely no income', () => {
        // The original insight must survive the rewrite.
        const items = loadInsightsStack({ incomeRecv: [], expenses: [{ date: year + '-03-01', amount: 500000 }] }).income();
        const zero = items.find((i) => i.kind === 'income_zero');
        expect(zero).toBeTruthy();
        expect(zero.go).toBe('incRecv');
    });

    it('every new card is a real button, per the #49 invariant', () => {
        for (const it of loadInsightsStack(mixed).income()) {
            if (it.action) expect(it.go || it.fix, it.action).toBeTruthy();
        }
    });
});

describe('income provenance: safety', () => {
    it('never throws, on any row shape at all', () => {
        fc.assert(fc.property(fc.anything(), (row) => {
            expect(() => P.classifyRow(row)).not.toThrow();
            const d = P.classifyRow(row);
            expect(typeof d.counts).toBe('boolean');
            expect(Number.isFinite(d.amount)).toBe(true);
            expect(d.amount).toBeGreaterThanOrEqual(0);
        }), { numRuns: runs(400) });
    });

    it('never throws on arbitrary row collections, and never loses money', () => {
        fc.assert(fc.property(
            fc.array(fc.record({
                name: fc.string({ maxLength: 40 }),
                amount: fc.float({ min: 0, max: 1e7, noNaN: true }),
                date: fc.constantFrom('2026-01-01', '2025-06-01', ''),
            }), { maxLength: 25 }),
            (rows) => {
                const d = P.derive(rows);
                expect(d.counted.length + d.excluded.length).toBe(rows.length);
                expect(d.total).toBeGreaterThanOrEqual(0);
            },
        ), { numRuns: runs(300) });
    });

    it('a negative or string amount never produces a negative total', () => {
        const d = P.derive([
            { name: 'SALARY', amount: -250000, source: 'manual' },
            { name: 'SALARY', amount: '150,000', source: 'manual' },
        ]);
        expect(d.total).toBeGreaterThanOrEqual(0);
    });
});
