// =============================================================================
// WealthFlow Shadow Test Harness — Deduplication
// =============================================================================
// Tests hashRow() and classifyStatement() — the "Quantum Deduplication" of the
// blueprint. We assert the only properties that actually matter for money:
//   1. Deterministic   — same row → same hash, always
//   2. Distinct        — meaningfully different rows → different hashes
//   3. Safe            — never throws, even on garbage
//   4. Dedup correctness — duplicates are flagged, originals aren't
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hashRow, classifyStatement } from '../wealthflow-statement-router.js';

const arbRow = fc.record({
  date:        fc.option(fc.constantFrom('2024-01-15', '2025-06-30', '', '2024-12-31T08:00:00Z')),
  description: fc.string({ maxLength: 100 }),
  amount:      fc.oneof(
                 fc.float({ min: -1e8, max: 1e8, noNaN: true }),
                 fc.integer({ min: -1000000, max: 1000000 }),
                 fc.string({ maxLength: 30 }),
                 fc.constant(null), fc.constant(undefined)
               ),
  ref:         fc.option(fc.string({ maxLength: 40 })),
  card_last4:  fc.option(fc.string({ maxLength: 6 })),
});

describe('hashRow: safety + determinism (2,000 random inputs)', () => {
  it('never throws on adversarial input', async () => {
    await fc.assert(fc.asyncProperty(arbRow, async (row) => {
      await expect(hashRow(row)).resolves.toBeDefined();
    }), { numRuns: 2000 });
  });

  it('returns a 64-char lowercase hex SHA-256 hash, always', async () => {
    await fc.assert(fc.asyncProperty(arbRow, async (row) => {
      const h = await hashRow(row);
      expect(typeof h).toBe('string');
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    }), { numRuns: 2000 });
  });

  it('is deterministic — same row hashes the same every time', async () => {
    await fc.assert(fc.asyncProperty(arbRow, async (row) => {
      const a = await hashRow(row);
      const b = await hashRow(row);
      const c = await hashRow(row);
      expect(a).toBe(b);
      expect(b).toBe(c);
    }), { numRuns: 1000 });
  });
});

describe('hashRow: distinguishes meaningfully different rows', () => {
  it('different amounts → different hashes', async () => {
    const base = { date: '2024-06-01', description: 'KEELLS SUPER', amount: 5000, ref: 'TX1' };
    const a = await hashRow(base);
    const b = await hashRow({ ...base, amount: 5000.01 });
    expect(a).not.toBe(b);
  });

  it('different dates → different hashes', async () => {
    const base = { date: '2024-06-01', description: 'KEELLS SUPER', amount: 5000, ref: 'TX1' };
    const a = await hashRow(base);
    const b = await hashRow({ ...base, date: '2024-06-02' });
    expect(a).not.toBe(b);
  });

  it('different card_last4 → different hashes (same purchase, different card)', async () => {
    const base = { date: '2024-06-01', description: 'KEELLS SUPER', amount: 5000, ref: 'TX1', card_last4: '1234' };
    const a = await hashRow(base);
    const b = await hashRow({ ...base, card_last4: '5678' });
    expect(a).not.toBe(b);
  });

  it('different ref → different hashes', async () => {
    const base = { date: '2024-06-01', description: 'KEELLS SUPER', amount: 5000, ref: 'TX1' };
    const a = await hashRow(base);
    const b = await hashRow({ ...base, ref: 'TX2' });
    expect(a).not.toBe(b);
  });
});

describe('hashRow: ignores noise that should NOT change identity', () => {
  it('amount sign flip (CR vs DR with same absolute value) → SAME hash', async () => {
    // hashRow uses Math.abs(amount) so a CR/DR pair for the SAME transaction
    // (some statements show payment from one side as negative) hashes the same.
    const a = await hashRow({ date: '2024-06-01', description: 'TX', amount: 500, ref: 'X' });
    const b = await hashRow({ date: '2024-06-01', description: 'TX', amount: -500, ref: 'X' });
    expect(a).toBe(b);
  });

  it('case-different ref → SAME hash (refs are normalised to uppercase)', async () => {
    const a = await hashRow({ date: '2024-06-01', description: 'TX', amount: 500, ref: 'abc123' });
    const b = await hashRow({ date: '2024-06-01', description: 'TX', amount: 500, ref: 'ABC123' });
    expect(a).toBe(b);
  });

  it('fractional cents below 0.01 → SAME hash (amount rounded to 2dp before hashing)', async () => {
    const a = await hashRow({ date: '2024-06-01', description: 'TX', amount: 500.001, ref: 'X' });
    const b = await hashRow({ date: '2024-06-01', description: 'TX', amount: 500.004, ref: 'X' });
    expect(a).toBe(b);
  });
});

describe('classifyStatement: dedup + routing pipeline', () => {
  it('the same row appearing twice → one classified, one marked duplicate', async () => {
    const row = { date: '2024-06-01', description: 'KEELLS SUPER', amount: 4250, drcr: 'DR', ref: 'TX-1' };
    const result = await classifyStatement({ rows: [row, row], statementType: 'bank_account' });
    expect(result).toHaveLength(2);
    expect(result[0].duplicate).toBe(false);
    expect(result[0].module).toBeDefined();
    expect(result[1].duplicate).toBe(true);
  });

  it('a row already in existingHashes is flagged duplicate (cross-source dedup)', async () => {
    const row = { date: '2024-06-01', description: 'PIZZA HUT', amount: 2500, drcr: 'DR', ref: 'TX-2' };
    const knownHash = await hashRow(row);
    const result = await classifyStatement({
      rows: [row],
      existingHashes: new Set([knownHash]),
      statementType: 'bank_account',
    });
    expect(result).toHaveLength(1);
    expect(result[0].duplicate).toBe(true);
  });

  it('processes large batches without crashing (500 random rows)', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(arbRow, { minLength: 50, maxLength: 500 }),
      async (rows) => {
        const result = await classifyStatement({ rows, statementType: 'bank_account' });
        expect(result.length).toBe(rows.length);
      }
    ), { numRuns: 5 });  // 5 batches × up to 500 rows each = up to 2500 routings
  });
});
