// =============================================================================
// WealthFlow Shadow Test Harness — Vitest configuration
// =============================================================================
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    exclude: ['node_modules/**'],
    reporters: ['default'],
    testTimeout: 30000,        // property tests can take a few seconds each
    hookTimeout: 10000,
    environment: 'node',       // pure-logic tests; no DOM needed
    coverage: {
      provider: 'v8',
      include: ['wealthflow-statement-router.js'],
      reporter: ['text', 'json-summary'],
    },
  },
});
