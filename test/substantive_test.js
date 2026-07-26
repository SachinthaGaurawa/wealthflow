// =============================================================================
// WealthFlow Shadow Test Harness — the fake-release gate
// =============================================================================
// This is the regression suite for the #1 reported bug: "the version number goes
// up but nothing in the app actually changes."
//
// The assertions below encode the real, verified history. Running
//   node autonomy/substantive.cjs <v7.69.11-commit> <v7.69.12-commit>
// against this repository reports "NOT substantive", because everything that
// changed between those two releases was merchant data plus version strings.
// These tests make sure that verdict can never silently regress.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    isMetaFile, normaliseLine, isVersionOnlyChange, parseUnifiedDiff, classifyDiff,
} from '../autonomy/substantive.cjs';

// The exact shape of the fake releases found in the git log.
const FAKE_RELEASE_DIFF = `diff --git a/merchants.json b/merchants.json
--- a/merchants.json
+++ b/merchants.json
@@ -1 +1 @@
-{"merchants":[{"n":"KEELLS"}]}
+{"merchants":[{"n":"KEELLS"},{"n":"CARGILLS"}]}
diff --git a/version.json b/version.json
--- a/version.json
+++ b/version.json
@@ -2 +2 @@
-  "latest": "7.69.11",
+  "latest": "7.69.12",
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -3 +3 @@
-  "version": "7.69.11",
+  "version": "7.69.12",
diff --git a/sw.js b/sw.js
--- a/sw.js
+++ b/sw.js
@@ -9 +9 @@
-const CACHE_NAME = 'wealthflow-v7.69.11';
+const CACHE_NAME = 'wealthflow-v7.69.12';
diff --git a/wealthflow-update-system.js b/wealthflow-update-system.js
--- a/wealthflow-update-system.js
+++ b/wealthflow-update-system.js
@@ -12 +12 @@
-    const CURRENT_VERSION = '7.69.11';
+    const CURRENT_VERSION = '7.69.12';
diff --git a/index.html b/index.html
--- a/index.html
+++ b/index.html
@@ -100 +100 @@
-        const WF_APP_VERSION = '7.69.11';
+        const WF_APP_VERSION = '7.69.12';
diff --git a/CHANGELOG.md b/CHANGELOG.md
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -2 +2,3 @@
+## v7.69.12 — 2026-07-26
+Improvements and fixes in this release.
`;

const REAL_FIX_DIFF = `diff --git a/wealthflow-insights.js b/wealthflow-insights.js
--- a/wealthflow-insights.js
+++ b/wealthflow-insights.js
@@ -42 +42,3 @@
-  return transactions.reduce((s, t) => s + t.amount, 0);
+  if (!Array.isArray(transactions)) return 0;
+  return transactions.reduce((s, t) => s + (Number(t && t.amount) || 0), 0);
`;

describe('the fake-release gate (autonomy/substantive.cjs)', () => {
    it('classifies the real v7.69.11 → v7.69.12 release as NOT substantive', () => {
        const r = classifyDiff(FAKE_RELEASE_DIFF);
        expect(r.substantive).toBe(false);
        expect(r.substantiveFiles).toEqual([]);
        expect(r.reason).toMatch(/FAKE update/);
    });

    it('recognises merchant data and the version manifest as non-behavioural', () => {
        const r = classifyDiff(FAKE_RELEASE_DIFF);
        expect(r.ignored).toContain('merchants.json');
        expect(r.ignored).toContain('version.json');
        expect(r.ignored).toContain('CHANGELOG.md');
    });

    it('recognises the version-carrier files as version-string-only churn', () => {
        const r = classifyDiff(FAKE_RELEASE_DIFF);
        expect(r.versionOnly).toContain('sw.js');
        expect(r.versionOnly).toContain('index.html');
        expect(r.versionOnly).toContain('wealthflow-update-system.js');
    });

    it('classifies a genuine one-line defensive fix as SUBSTANTIVE', () => {
        const r = classifyDiff(REAL_FIX_DIFF);
        expect(r.substantive).toBe(true);
        expect(r.substantiveFiles).toEqual(['wealthflow-insights.js']);
    });

    it('still ships when a real fix rides along with merchant churn', () => {
        const r = classifyDiff(FAKE_RELEASE_DIFF + REAL_FIX_DIFF);
        expect(r.substantive).toBe(true);
        expect(r.substantiveFiles).toEqual(['wealthflow-insights.js']);
    });

    it('treats an empty diff as nothing to ship', () => {
        expect(classifyDiff('').substantive).toBe(false);
        expect(classifyDiff(null).substantive).toBe(false);
    });
});

describe('normaliseLine', () => {
    it('collapses any semver to a single placeholder', () => {
        expect(normaliseLine("v = '1.2.3'")).toBe(normaliseLine("v = '9.99.100'"));
    });

    it('ignores pure re-indentation', () => {
        expect(normaliseLine('    return x;')).toBe(normaliseLine('\t\treturn x;'));
    });

    it('does NOT equate genuinely different code', () => {
        expect(normaliseLine('return a + b;')).not.toBe(normaliseLine('return a - b;'));
    });

    it('never throws on any input', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(typeof normaliseLine(x)).toBe('string');
        }), { numRuns: 500 });
    });
});

describe('isVersionOnlyChange', () => {
    it('is true when added lines are a permutation of removed ones post-normalise', () => {
        expect(isVersionOnlyChange(["a='2.0.0'"], ["a='1.0.0'"])).toBe(true);
    });

    it('is false when a line is genuinely added', () => {
        expect(isVersionOnlyChange(["a='2.0.0'", 'newLine();'], ["a='1.0.0'"])).toBe(false);
    });

    it('is false for an empty change (nothing to ship is not "version-only")', () => {
        expect(isVersionOnlyChange([], [])).toBe(false);
    });
});

describe('isMetaFile', () => {
    it('flags the data and manifest files that must never trigger a release', () => {
        for (const f of ['merchants.json', 'version.json', 'package.json', 'package-lock.json',
            'CHANGELOG.md', 'README.md', 'autonomy/state/issue-1.json', 'ai-fix-pr.json']) {
            expect(isMetaFile(f), f).toBe(true);
        }
    });

    it('does not flag real source modules', () => {
        for (const f of ['wealthflow-insights.js', 'sw.js', 'index.html', 'api/ai.js']) {
            expect(isMetaFile(f), f).toBe(false);
        }
    });

    it('treats an unknown/empty path as meta (fail safe — never auto-release on it)', () => {
        expect(isMetaFile('')).toBe(true);
        expect(isMetaFile(null)).toBe(true);
    });
});

describe('parseUnifiedDiff', () => {
    it('attributes hunks to the right file', () => {
        const p = parseUnifiedDiff(REAL_FIX_DIFF);
        expect(Object.keys(p)).toEqual(['wealthflow-insights.js']);
        expect(p['wealthflow-insights.js'].added).toHaveLength(2);
        expect(p['wealthflow-insights.js'].removed).toHaveLength(1);
    });

    it('does not mistake +++/--- headers for content', () => {
        const p = parseUnifiedDiff(REAL_FIX_DIFF);
        const all = p['wealthflow-insights.js'];
        expect(all.added.some((l) => l.startsWith('+'))).toBe(false);
        expect(all.removed.some((l) => l.startsWith('-'))).toBe(false);
    });

    it('never throws on arbitrary text', () => {
        fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => {
            expect(() => parseUnifiedDiff(s)).not.toThrow();
        }), { numRuns: 300 });
    });
});
