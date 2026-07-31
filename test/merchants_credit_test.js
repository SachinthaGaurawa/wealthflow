// =============================================================================
// WealthFlow Shadow Test Harness — not every credit is income
// =============================================================================
// wealthflow-merchants.js classify(), rule 1, the first thing it does:
//
//     // 1) money IN → income (the tab decides; category left to income logic)
//     if (dir === 'credit') { out.goesTo = 'income'; out.confidence = 0.6; ... return out; }
//
// It returns immediately, before any check for a refund, a reversal, a
// chargeback, cashback, a loan drawdown, or a transfer between the user's own
// accounts. Every one of those is money arriving that is NOT income:
//
//   · a refund gives back money already counted as an expense;
//   · a reversal cancels a charge that is also in the data;
//   · an internal transfer is the same money, twice.
//
// HOW BAD IS IT TODAY — precisely
//   The only import-path consumer is refine() (index.html:26129), and it
//   discards anything under 0.85 confidence:
//
//       if (!c.goesTo || c.confidence < 0.85) return null;   // keep WFRoute/AI
//
//   The credit rule sets 0.6, so it does NOT currently override import routing.
//   This is a LOADED GUN rather than a live corruption, and the distinction is
//   worth stating plainly instead of overselling the bug.
//
//   What it does do today: analyze() reports `routing.goes_to: "Income"` with
//   the justification "credit → income" for a refund — a wrong answer the user
//   can read — and classify() is the module's documented public contract, so
//   anything that starts trusting it inherits the fault. The same shape as the
//   descOf() trap in wealthflow-statement-router.js: harmless only by accident.
//
// The rule these tests enforce: a credit is income when something says it is —
// salary, a dividend — and otherwise the classifier declines rather than
// asserting. Declining is already the module's safe contract (goesTo null →
// refine() defers to WFRoute), so refusing to guess costs nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';

function loadMerchants() {
    const win = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
    new Function('window', 'console', fs.readFileSync('wealthflow-merchants.js', 'utf8'))(
        win, { log() {}, warn() {}, error() {} },
    );
    return win.WFMerchants;
}

const M = loadMerchants();

describe('merchants: the module loaded (guards against a vacuous pass)', () => {
    it('exposes classify and analyze', () => {
        expect(typeof M.classify).toBe('function');
        expect(typeof M.analyze).toBe('function');
    });
});

describe('merchants: real income is still recognised as income', () => {
    // The fix must not swing the other way and refuse everything.
    const earned = [
        'SALARY JULY 2026',
        'PAYROLL CREDIT ACME PVT LTD',
        'MONTHLY WAGES',
        'PENSION PAYMENT',
    ];
    it.each(earned)('%s → income', (desc) => {
        const c = M.classify(desc, 'credit');
        expect(c.goesTo).toBe('income');
    });

    it('is confident enough about salary for refine() to actually use it', () => {
        // refine() ignores anything under 0.85. At the old blanket 0.6, even a
        // correctly-identified salary was thrown away — the rule was both too
        // eager and too weak to be useful.
        expect(M.classify('SALARY JULY 2026', 'credit').confidence).toBeGreaterThanOrEqual(0.85);
    });

    it('treats investment returns as income', () => {
        expect(M.classify('DIVIDEND PAYOUT JKH', 'credit').goesTo).toBe('income');
    });
});

describe('merchants: money coming back is NOT income', () => {
    const notIncome = [
        ['REFUND ADJUSTMENT', 'refund'],
        ['REVERSAL OF CHARGE 4521', 'reversal'],
        ['CHARGEBACK CREDIT', 'chargeback'],
        ['CASHBACK REWARD', 'cashback'],
        ['REIMBURSEMENT TRAVEL', 'reimbursement'],
    ];

    it.each(notIncome)('%s is not filed as income', (desc) => {
        // THE REGRESSION. On main every one of these returns goesTo 'income'.
        expect(M.classify(desc, 'credit').goesTo).not.toBe('income');
    });

    it.each(notIncome)('%s explains itself instead of guessing', (desc) => {
        const c = M.classify(desc, 'credit');
        expect(c.reason).toBeTruthy();
        expect(c.reason).not.toBe('credit → income');
    });

    it('a transfer between your own accounts is not new money', () => {
        for (const d of ['TRANSFER FROM OWN ACCOUNT', 'INTERNAL TRANSFER 001', 'SELF TRANSFER SAVINGS']) {
            expect(M.classify(d, 'credit').goesTo, d).not.toBe('income');
        }
    });

    it('a loan drawdown is borrowed, not earned', () => {
        expect(M.classify('LOAN DISBURSEMENT BOC', 'credit').goesTo).not.toBe('income');
    });
});

describe('merchants: an unidentified credit is not asserted to be income', () => {
    it('declines rather than guessing', () => {
        // Declining is the module's existing safe contract: goesTo null makes
        // refine() defer to WFRoute/AI, which is where an unknown belongs.
        const c = M.classify('NEFT CR 8837162', 'credit');
        expect(c.goesTo).not.toBe('income');
    });

    it('never claims high confidence about a credit it cannot identify', () => {
        const c = M.classify('XYZ9931', 'credit');
        expect(c.confidence).toBeLessThan(0.85);
    });
});

describe('merchants: analyze() reports the truth to the user', () => {
    it('does not tell the user a refund is Income', () => {
        // This is the part that IS user-visible today.
        const a = M.analyze('REFUND ADJUSTMENT', 'credit');
        expect(a.routing.goes_to).not.toBe('Income');
    });

    it('still reports salary as Income', () => {
        expect(M.analyze('SALARY JULY 2026', 'credit').routing.goes_to).toBe('Income');
    });
});

describe('merchants: safety', () => {
    it('debit classification is completely unchanged', () => {
        // The credit path is the only thing being touched. Expenses must not move.
        expect(M.classify('KEELLS SUPER COLOMBO', 'debit').goesTo).toBe('expenses');
        expect(M.classify('NETFLIX.COM', 'debit').goesTo).toBe('subscription');
    });

    it('never throws, on any description or direction', () => {
        fc.assert(fc.property(
            fc.string({ maxLength: 120 }),
            fc.constantFrom('credit', 'debit', '', null, undefined, 'CREDIT'),
            (desc, dir) => {
                expect(() => M.classify(desc, dir)).not.toThrow();
                const c = M.classify(desc, dir);
                expect(c.confidence).toBeGreaterThanOrEqual(0);
                expect(c.confidence).toBeLessThanOrEqual(1);
            },
        ), { numRuns: runs(400) });
    });

    it('only ever returns a routing the rest of the app understands', () => {
        const allowed = [null, 'income', 'expenses', 'subscription', 'cc_payment'];
        fc.assert(fc.property(fc.string({ maxLength: 80 }), (desc) => {
            expect(allowed).toContain(M.classify(desc, 'credit').goesTo);
        }), { numRuns: runs(300) });
    });
});
