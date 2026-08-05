// =============================================================================
// WealthFlow Shadow Test Harness — Vitest configuration
// =============================================================================
// THIS FILE REPLACES `vitest_config.js`, WHICH VITEST NEVER LOADED.
//
// The old file was named `vitest_config.js` (underscore). Vitest only auto-loads
// `vitest.config.*` / `vite.config.*`, so that file was inert — and its
// `include: ['tests/**/*.test.js']` pointed at a `tests/` directory that does
// not exist (the real one is `test/`). On top of that, the two real test files
// are named `dedup_test.js` and `router_test.js`, which do not match Vitest's
// default `*.{test,spec}.js` glob either.
//
// Net effect, verified by running it: `npm test` printed
//     "No test files found, exiting with code 0"
// because `--passWithNoTests` converted "I ran nothing" into a green check.
//
// So the CI job described as "the SAFETY HARNESS ... the gate that contains AI
// mistakes" had never executed a single assertion, and the fuzz gate's
// FUZZ_RUNS=100000 fuzzed nothing. Every AI change would have sailed through.
//
// The include list below deliberately covers BOTH naming conventions: the
// existing `*_test.js` files and the `*.test.js` files that Agent 4 (QA) writes
// alongside each autonomous fix.
// =============================================================================
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: [
            'test/**/*.test.js',      // Agent 4's generated proving tests
            'test/**/*_test.js',      // the original hand-written harness
            'autonomy/**/*.test.js',  // pipeline self-tests
        ],
        exclude: ['node_modules/**', 'test/merchant-expand.cjs'],
        reporters: ['default'],
        testTimeout: 30000,           // property/fuzz tests take a few seconds each
        hookTimeout: 10000,
        environment: 'jsdom',          // DOM environment for tests that require it
        coverage: {
            provider: 'v8',
            include: ['wealthflow-statement-router.js', 'autonomy/**'],
            reporter: ['text', 'json-summary'],
        },
    },
});
