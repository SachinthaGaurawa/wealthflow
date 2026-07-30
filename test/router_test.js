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

import { runs } from './fuzz-config.js';
import fsMod from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
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
    }), { numRuns: runs(5000) });
  });

  it('always returns a valid module name', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const r = routeRow(row, ctx);
      expect(VALID_MODULES.has(r.module)).toBe(true);
    }), { numRuns: runs(5000) });
  });

  it('confidence is always a real number in [0, 1]', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const r = routeRow(row, ctx);
      expect(typeof r.confidence).toBe('number');
      expect(Number.isFinite(r.confidence)).toBe(true);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }), { numRuns: runs(5000) });
  });

  it('amount in result is always finite and non-negative (money never goes "negative" in a bucket)', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const r = routeRow(row, ctx);
      expect(Number.isFinite(r.fields.amount)).toBe(true);
      expect(r.fields.amount).toBeGreaterThanOrEqual(0);
    }), { numRuns: runs(5000) });
  });

  it('needsReview flag is consistent with confidence vs threshold', () => {
    fc.assert(fc.property(arbRow, arbCtx, (row, ctx) => {
      const r = routeRow(row, ctx);
      const threshold = typeof ctx.reviewThreshold === 'number' ? ctx.reviewThreshold : 0.75;
      expect(r.needsReview).toBe(r.confidence < threshold);
    }), { numRuns: runs(5000) });
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
    }), { numRuns: runs(3000) });
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
    ), { numRuns: runs(3000) });
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
    }), { numRuns: runs(1000) });
  });
});

// ============================================================================
// 4. THE PARSER → ROUTER CONTRACT
// ============================================================================
// This module reads `row.description` and `row.type`. The parser that produces
// its input emits `narration` and `direction`. Nothing was broken in production,
// because nothing loads this file — index.html loads plain scripts and this is an
// ES module — but that is a latent trap, not a safe state. Wired in as it was,
// every parsed row would have arrived with `description === undefined`, and:
//
//   • desc would be '', tripping the "unreadable vendor" clamp to confidence 0.4
//     — under the 0.75 threshold, so EVERY row flagged needsReview;
//   • `row.type` is not a field the parser emits, so `direction()` fell through
//     to its last line and returned 'debit' for everything. A salary credit would
//     have been filed as an expense;
//   • bestNameMatch() got undefined, so loan and savings-target allocation could
//     never fire at all.
//
// These tests wire the two modules together for real, so the contract is checked
// rather than assumed. Testing each module alone is exactly how a field-name
// mismatch survives a green suite.
// ============================================================================
describe('parser → router: the field-name contract', () => {
  const P = loadParser(fsMod);
  const parse = (text) => P.parseStatementText(text);

  it('routes a salary credit as income from the parser\'s own field names', () => {
    // Straight parser output. No renaming, no adapter — if the router cannot read
    // it, this fails.
    const rows = parse(
      '01/07/2026 OPENING BALANCE 100,000.00\n'
      + '03/07/2026 SALARY JULY 250,000.00 350,000.00\n'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('credit');   // the parser resolved it from the balance
    const r = routeRow(rows[0], { statementType: 'bank_account' });
    expect(r.fields.dir).toBe('credit');        // ...and the router must not lose it
    expect(r.module).toBe('income');
  });

  it('reads the narration, so merchant patterns still match', () => {
    const rows = parse(
      '01/07/2026 OPENING BALANCE 100,000.00\n'
      + '02/07/2026 NETFLIX MONTHLY 1,490.00 98,510.00\n'
    );
    const r = routeRow(rows[0], { statementType: 'bank_account' });
    expect(r.module).toBe('subscriptions');
    expect(r.fields.desc).toBe('NETFLIX MONTHLY');
  });

  it('does not clamp a parsed row to the unreadable-vendor confidence', () => {
    // The symptom that would have made the whole import unusable: an empty
    // description trips the `desc.length < 3` guard and clamps confidence to 0.4.
    const rows = parse(
      '01/07/2026 OPENING BALANCE 100,000.00\n'
      + '02/07/2026 CARGILLS FOOD CITY 3,120.00 96,880.00\n'
    );
    const r = routeRow(rows[0], { statementType: 'bank_account' });
    expect(r.confidence).toBeGreaterThan(0.4);
    expect(r.confidence).toBe(0.7);              // the generic-expense score

    // NOTE, and deliberately asserted rather than glossed over: 0.7 is below the
    // DEFAULT 0.75 threshold, so an ordinary bank expense is flagged needsReview
    // no matter how cleanly it parsed. That is pre-existing router behaviour and
    // is NOT what this change is about — but a review flag that fires on the most
    // common case carries no information, and I have reported it separately
    // rather than altering routing behaviour inside a field-name fix.
    expect(r.needsReview).toBe(true);
    expect(routeRow(rows[0], { statementType: 'bank_account', reviewThreshold: 0.7 }).needsReview).toBe(false);
  });

  it('still allocates a loan repayment matched by name', () => {
    const rows = parse(
      '01/07/2026 OPENING BALANCE 100,000.00\n'
      + '02/07/2026 TOYOTA LEASE INSTALMENT 45,000.00 55,000.00\n'
    );
    const r = routeRow(rows[0], { loans: [{ id: 'l1', name: 'Toyota Lease' }] });
    expect(r.module).toBe('loans');
    expect(r.allocation.id).toBe('l1');
  });

  it('carries the parser\'s uncertainty into needsReview', () => {
    // A statement with no running balance: the parser had to assume the direction
    // and says so. The router's confidence is about the CATEGORY and knows nothing
    // of that, so without propagation an unverified row could route at 0.9.
    const rows = parse('02/07/2026 NETFLIX MONTHLY 1,490.00\n');
    expect(rows[0].directionSource).toBe('assumed');
    expect(rows[0].needsReview).toBe(true);
    const r = routeRow(rows[0], { statementType: 'credit_card' });
    expect(r.needsReview).toBe(true);
  });

  it('gives two different transactions two different dedup hashes', async () => {
    // hashRow() also read `description`, so every parsed row hashed with an empty
    // narration slot. Two unrelated charges on the same date for the same amount
    // would collide, and the second would be silently dropped as a duplicate.
    const [a, b] = parse(
      '02/07/2026 UBER RIDE COLOMBO 1,250.00\n'
      + '02/07/2026 KEELLS SUPER 1,250.00\n'
    );
    expect(await hashRow(a)).not.toBe(await hashRow(b));
  });

  it('an explicit description still wins over narration', () => {
    // Rows from the email/manual paths carry `description`. They must be unaffected.
    const r = routeRow({ description: 'SALARY CREDIT', narration: 'IGNORE ME', amount: 1000, drcr: 'CR' }, {});
    expect(r.fields.desc).toBe('SALARY CREDIT');
    expect(r.module).toBe('income');
  });
});
