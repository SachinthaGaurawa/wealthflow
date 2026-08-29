// =============================================================================
// test/predict_wealth_anomaly_test.js — first direct coverage of the anomaly
// detector that powers the AI advisor's "spike/drop" insights.
//
// detectAnomalies() was an unexported inner function of the /api/predict-wealth
// edge handler, so it had zero direct test coverage and could only be reached
// by exercising the whole HTTP path. It also had a latent month-label bug: the
// value was read from the last NON-ZERO month (zero-spend months were filtered
// out first) while the label was always the CURRENT month, so the month named
// by a report was not necessarily the month that produced its amount.
//
// The fix keeps the month attached to its value (see predict-wealth.js) and
// makes the 6-month window deterministic by accepting an injectable `now` —
// previously it read `new Date()` directly, which made the window impossible
// to pin in a test.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { detectAnomalies, monthKey, lastNMonths } from '../predict-wealth.js';

// A fixed "today" so the 6-month window is stable across runs.
const NOW = new Date('2026-08-15T00:00:00Z');

// One expense row in a fixed month (MM) of 2026.
function expense(month, amount, cat = 'Travel') {
  return { date_ms: Date.parse(`2026-${month}-10T00:00:00Z`), amount, cat };
}

describe('predict-wealth: monthKey / lastNMonths', () => {
  it('keys a timestamp to YYYY-MM', () => {
    expect(monthKey(Date.parse('2026-08-15T00:00:00Z'))).toBe('2026-08');
  });

  it('lists the last N months ending on the current month', () => {
    expect(lastNMonths(6, NOW)).toEqual([
      '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
    ]);
  });
});

describe('predict-wealth: detectAnomalies', () => {
  it('flags a spike in the latest month against a stable baseline', () => {
    const ex = ['03', '04', '05', '06', '07'].map((m) => expense(m, 100))
      .concat([expense('08', 600)]);
    const anomalies = detectAnomalies(ex, NOW);
    expect(anomalies).toHaveLength(1);
    const a = anomalies[0];
    expect(a.category).toBe('Travel');
    expect(a.month).toBe('2026-08');
    expect(a.amount).toBe(600);
    expect(a.direction).toBe('spike');
    expect(a.z_score).toBeGreaterThan(2);
  });

  it('flags a drop in the latest month', () => {
    const ex = ['03', '04', '05', '06', '07'].map((m) => expense(m, 600))
      .concat([expense('08', 100)]);
    const anomalies = detectAnomalies(ex, NOW);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].month).toBe('2026-08');
    expect(anomalies[0].direction).toBe('drop');
    expect(anomalies[0].z_score).toBeLessThan(-2);
  });

  it('does not raise a false positive when spending is steady', () => {
    const ex = ['03', '04', '05', '06', '07', '08'].map((m) => expense(m, 100));
    expect(detectAnomalies(ex, NOW)).toEqual([]);
  });

  it('keeps each report month consistent with the amount it reports', () => {
    // Two categories, one of which spikes in August. For every anomaly the
    // detector emits, the named month must actually carry spend for that
    // category in the input — the amount must never come from an empty month.
    const ex = [
      expense('03', 100, 'Travel'), expense('04', 100, 'Travel'),
      expense('05', 100, 'Travel'), expense('06', 100, 'Travel'),
      expense('07', 100, 'Travel'), expense('08', 600, 'Travel'),
      expense('03', 50, 'Food'), expense('04', 50, 'Food'),
      expense('05', 50, 'Food'), expense('06', 50, 'Food'),
      expense('07', 50, 'Food'), expense('08', 50, 'Food'),
    ];
    const anomalies = detectAnomalies(ex, NOW);
    expect(anomalies.length).toBeGreaterThan(0);
    for (const a of anomalies) {
      const spentThatMonth = ex
        .filter((e) => e.cat === a.category && monthKey(e.date_ms) === a.month)
        .reduce((s, e) => s + e.amount, 0);
      expect(spentThatMonth, `${a.category} @ ${a.month}`).toBeGreaterThan(0);
    }
  });
});
