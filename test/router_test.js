// =============================================================================
// WealthFlow Shadow Test Harness — Statement Router
// =============================================================================
// PROPERTY-BASED FUZZ TESTING using fast-check.
// Each test generates THOUSANDS of random inputs and asserts INVARIANTS that
// must hold for every one. This catches the kind of edge-case bugs that
// example-based tests miss — and it's what real fintechs use, not 100k mock VMs.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { routeRow, hashRow, classifyStatement } from '../wealthflow-statement-router.js';

// --- shape generators (model REAL statement rows) ---------------------------
const arbDescription = fc.oneof(
  fc.string({ minLength: 0, maxLength: 200 }),
  fc.constantFrom(
    'NETFLIX MONTHLY SUB', 'SPOTIFY PREMIUM', 'CEYPETCO FUEL',
    'CARGILLS FOOD CITY', 'ATM CASH WITHDRAWAL', 'EMI 3/12 LAPTOP',
    'PAYMENT - THANK YOU', 'SALARY CREDIT', 'ANNUAL FEE',
    'CASH ADVANCE FEE', 'REFUND PROCESSED', 'LATE PAYMENT FEE',
    'EZ PAYMENT INSTALLMENT 4/24', '', '   ', 'unreadable vendor'
  )
);
const arbAmount = fc.oneof(
  fc.float({ min: -1e8, max: 1e8, noNaN: true }),
  fc.integer({ min: -1000000, max: 1000000 }),
  fc.string({ maxLength: 30 }),
  fc.constant(null), fc.constant(undefined), fc.constant('NaN'), fc.constant(0)
);
const arbDrcr = fc.option(fc.constantFrom('CR', 'DR', 'cr', 'dr', 'credit', 'debit', 'CREDIT', 'unknown', ''));
const arbRow = fc.record({
  date:        fc.option(fc.constantFrom('2024-01-15', '2025-06-30', 'bad-date', '', '2024-12-31T08:00:00Z')),
  description: arbDescription,
  amount:      arbAmount,
  drcr:        arbDrcr,
  ref:         fc.option(fc.string({ maxLength: 40 })),
  type:        fc.option(fc.constantFrom('credit', 'debit', 'transfer')),
  card_last4:  fc.option(fc.string({ minLength: 0, maxLength: 6 })),
});
const arbCtx = fc.record({
  statementType: fc.option(fc.constantFrom('credit_card', 'bank_account', 'savings', 'unknown')),
  card_last4: fc.option(fc.string({ maxLength: 6 })),
  reviewThreshold: fc.option(fc.float({ min: 0, max: 1, noNaN: true })),
  targets: fc.option(fc.array(fc.record({ id: fc.string(), name: fc.string({ minLength: 1, maxLength: 30 }) }), { maxLength: 5 })),
  loans:   fc.option(fc.array(fc.record({ id: fc.string(), name: fc.string({ minLength: 1, maxLength: 30 }) }), { maxLength: 5 })),
});

const VALID_MODULES = new Set([
  'income','expenses','subscriptions','cconetime','ccinstall','loans','cc_payment','goal_alloc'
]);

// ============================================================================
// 1. SAFETY: routeRow() never throws, ever — on any input the world can send.
// ============================================================================
describe('routeRow: safety invariants (5,000 random inputs)', () => {
  it('never throws on adversarial input', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      expect(() => routeRow(row, ctx)).not.toThrow();
    }), { numRuns: 5000 });
  });

  it('always returns a valid module name', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const r = routeRow(row, ctx);
      expect(VALID_MODULES.has(r.module)).toBe(true);
    }), { numRuns: 5000 });
  });

  it('confidence is always a real number in [0, 1]', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const r = routeRow(row, ctx);
      expect(typeof r.confidence).toBe('number');
      expect(Number.isFinite(r.confidence)).toBe(true);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }), { numRuns: 5000 });
  });

  it('amount in result is always finite and non-negative (money never goes "negative" in a bucket)', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const r = routeRow(row, ctx);
      expect(Number.isFinite(r.fields.amount)).toBe(true);
      expect(r.fields.amount).toBeGreaterThanOrEqual(0);
    }), { numRuns: 5000 });
  });

  it('needsReview flag is consistent with confidence vs threshold', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const r = routeRow(row, ctx);
      const threshold = typeof ctx.reviewThreshold === 'number' ? ctx.reviewThreshold : 0.75;
      expect(r.needsReview).toBe(r.confidence < threshold);
    }), { numRuns: 5000 });
  });
});

// ============================================================================
// 2. BUSINESS RULE: the bug that started this whole session must STAY fixed.
// A bank-account statement must NEVER route purchases into the cconetime tab.
// ============================================================================
describe('routeRow: business rules (the original misrouting bug)', () => {
  it('a bank-account debit NEVER lands in cconetime/ccinstall (the original bug)', () => {
    fc.assert(fc.property(arbRow, (row) => {
      const r = routeRow({ ...row, drcr: 'DR' }, { statementType: 'bank_account' });
      // Bank-account debits must go to expenses/loans/goal_alloc/subscriptions — never CC buckets.
      expect(['cconetime','ccinstall']).not.toContain(r.module);
    }), { numRuns: 3000 });
  });

  it('a credit-card statement debit lands in a CC bucket (not in plain expenses)', () => {
    fc.assert(fc.property(
      arbRow.filter(r => {
        // skip rows that match a loan/target/subscription regex — those route by semantics
        const d = String(r.description || '').toLowerCase();
        return !/netflix|spotify|youtube|prime|disney|hbo|dialog|mobitel|adobe|payment.*thank|refund|reversal|reimburs|cashback|salary|payroll|wages|pension|dividend/.test(d);
      }),
      (row) => {
        const r = routeRow({ ...row, drcr: 'DR' }, { statementType: 'credit_card' });
        // Either CC bucket OR a goal_alloc/loans match — but never plain "expenses"
        expect(r.module).not.toBe('expenses');
      }
    ), { numRuns: 3000 });
  });

  it('a salary credit is recognised as income', () => {
    const r = routeRow({ description: 'SALARY CREDIT JUNE', amount: 250000, drcr: 'CR' }, {});
    expect(r.module).toBe('income');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('"PAYMENT - THANK YOU" on a credit card triggers cc_payment (FIFO reconcile)', () => {
    const r = routeRow({ description: 'PAYMENT - THANK YOU', amount: 50000, drcr: 'CR' }, { statementType: 'credit_card' });
    expect(r.module).toBe('cc_payment');
  });

  it('a subscription debit (Netflix) routes to subscriptions, not cconetime', () => {
    const r = routeRow({ description: 'NETFLIX.COM MONTHLY', amount: 1490, drcr: 'DR' }, { statementType: 'bank_account' });
    expect(r.module).toBe('subscriptions');
  });

  it('a fuel charge on a credit card is tagged as fuel subtype', () => {
    const r = routeRow({ description: 'CEYPETCO FUEL STATION', amount: 8000, drcr: 'DR' }, { statementType: 'credit_card' });
    expect(r.module).toBe('cconetime');
    expect(r.subtype).toBe('fuel');
  });

  it('an installment row is detected (the EMI / "3/12" pattern)', () => {
    const r = routeRow({ description: 'EZ PAYMENT INSTALLMENT 4/24', amount: 12500, drcr: 'DR' }, { statementType: 'credit_card' });
    expect(r.module).toBe('ccinstall');
  });

  it('empty/unreadable descriptions are correctly flagged needsReview', () => {
    const r = routeRow({ description: '', amount: 1000, drcr: 'DR' }, { statementType: 'bank_account' });
    expect(r.needsReview).toBe(true);
    expect(r.confidence).toBeLessThanOrEqual(0.4);
  });

  it('matches a savings target by name (case-insensitive, partial)', () => {
    const r = routeRow(
      { description: 'TRANSFER TO TOYOTA SAVINGS', amount: 30000, drcr: 'DR' },
      { targets: [{ id: 't1', name: 'Toyota' }] }
    );
    expect(r.module).toBe('goal_alloc');
    expect(r.allocation.id).toBe('t1');
  });
});

// ============================================================================
// 3. DETERMINISM: same input → same output. No hidden state, no Date.now() leak.
// ============================================================================
describe('routeRow: determinism', () => {
  it('produces identical output for identical input (1,000 trials)', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const a = routeRow(row, ctx);
      const b = routeRow(row, ctx);
      expect(a).toEqual(b);
    }), { numRuns: 1000 });
  });
});
