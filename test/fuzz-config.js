// =============================================================================
// Shared fuzz-intensity control for the property suites
// -----------------------------------------------------------------------------
// WHY THIS EXISTS
//   .github/workflows/fuzz-gate.yml sets `FUZZ_RUNS: '100000'` and describes
//   itself as "the blueprint's heavy randomized-iteration gate". Nothing read
//   that variable. Every property test ran at its hard-coded numRuns, so the
//   "100,000 iteration fuzz gate" that guards money and auth paths was doing
//   exactly the same work as an ordinary PR check.
//
//   `runs(base)` makes it real: in normal CI a test does its baseline iterations,
//   and when the fuzz gate fires on a sensitive path the same tests scale up.
//
// HOW THE SCALE IS DERIVED
//   FUZZ_RUNS is a total iteration budget, not a per-property count — running
//   100,000 iterations of every property in the suite would take far longer than
//   any CI timeout. It is spread across the suite's baseline, capped so a single
//   property cannot exceed MAX_PER_PROPERTY.
//
//   FUZZ_RUNS unset      → scale 1   (baseline; ordinary PR)
//   FUZZ_RUNS=100000     → scale 10  (the sensitive-path gate)
// =============================================================================

const BASELINE_TOTAL = 10_000;      // rough sum of baseline numRuns across the suite
const MAX_PER_PROPERTY = 50_000;    // keeps any one property inside the test timeout

function scale() {
    const budget = Number(process.env.FUZZ_RUNS || 0);
    if (!Number.isFinite(budget) || budget <= 0) return 1;
    return Math.max(1, Math.min(25, budget / BASELINE_TOTAL));
}

export const FUZZ_SCALE = scale();

/** Iterations for one property: `fc.assert(prop, { numRuns: runs(2000) })`. */
export function runs(base) {
    const n = Math.round(Number(base || 100) * FUZZ_SCALE);
    return Math.max(1, Math.min(MAX_PER_PROPERTY, n));
}

export const IS_HEAVY_FUZZ = FUZZ_SCALE > 1;
