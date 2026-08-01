/* =============================================================================
 * test/sensitive_paths_test.js
 * -----------------------------------------------------------------------------
 * THE VULNERABILITY THIS PINS
 *
 * Two workflows each carried their own hand-written list of "sensitive paths",
 * and they had drifted apart:
 *
 *   auto-merge.yml     SENSITIVE        covered .github/, policy/, autonomy/,
 *                                       release.cjs, CODEOWNERS, and more
 *   wealthflow-ci.yml  SENSITIVE_REGEX  covered none of them
 *
 * The second one is the job literally named "Risk gate (sensitive paths need
 * human approval)". So a PR touching only .github/workflows/ — the files that
 * define every gate in this repository, including the Risk gate itself — was
 * told "✓ No sensitive paths touched — eligible for auto-merge". PR #61
 * demonstrated it live: Risk gate green, conftest red.
 *
 * Nothing shipped unreviewed, because auto-merge.yml's classifier and the rego
 * both still covered those paths. But a boundary gate that abstains on the
 * highest-privilege file class leaves the rego as the only control that must
 * not fail — and a gate that fails open is a defect this pipeline has already
 * produced once (the consensus board, #57).
 *
 * WHY THIS TEST SHELLS OUT TO grep
 * The regexes are evaluated by `grep -iE` inside a GitHub runner. POSIX ERE and
 * JavaScript RegExp are NOT the same language, so re-implementing the match in
 * JS would test a different engine than the one that guards the repository —
 * a green test describing a match that never happens. Every case below runs the
 * literal string from the YAML through the literal command the workflow uses.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Pull a single-quoted shell assignment out of a workflow file. */
function extractRegex(file, varName) {
    const src = read(file);
    const m = new RegExp(`${varName}='([^']*)'`).exec(src);
    if (!m) throw new Error(`${varName} not found in ${file} — retarget this test`);
    return m[1];
}

/** Exactly what the workflow runs: echo "$CHANGED" | grep -iE "$REGEX". */
function matches(regex, filePath) {
    try {
        const out = execFileSync('grep', ['-iE', regex], {
            input: filePath, encoding: 'utf8',
        });
        return out.trim().length > 0;
    } catch (e) {
        if (e.status === 1) return false;   // grep: no match
        throw e;                            // grep: actual error (bad regex)
    }
}

const RISK_GATE = extractRegex('.github/workflows/wealthflow-ci.yml', 'SENSITIVE_REGEX');
const AUTO_SAFE = extractRegex('.github/workflows/auto-merge.yml', 'SENSITIVE');

/**
 * Paths that must require human approval, with the reason each one is here.
 * This list is the single source of truth; the two workflow regexes are checked
 * against it rather than against each other, so "both are equally wrong" cannot
 * pass.
 */
const MUST_BE_GATED = [
    // The pipeline's own machinery — the gap that prompted this test.
    ['.github/workflows/wealthflow-ci.yml', 'the Risk gate itself'],
    ['.github/workflows/auto-merge.yml',    'the auto-merge classifier'],
    ['.github/actions/changed-files/action.yml', 'the diff every gate reads'],
    ['policy/release.rego',                 'the rego firewall'],
    ['autonomy/substantive.cjs',            'decides when the owner is told an update exists'],
    ['autonomy/perf-budget.mjs',            'the payload ceilings'],
    ['release.cjs',                         'cuts and pushes releases'],
    ['release-brain.js',                    'decides what ships'],
    ['CODEOWNERS',                          'who must review'],
    ['consensus-review.mjs',                'the review board'],
    ['autonomous-fix-agent.js',             'writes code unattended'],
    ['vitest.config.js',                    'can disable the suite wholesale'],
    // Money, auth, data rules, and the code the browser executes.
    ['index.html',                          'the app itself'],
    ['sw.js',                               'decides what code the device runs'],
    ['vercel.json',                         'routing and cache headers'],
    ['firestore.rules',                     'who can read the owner data'],
    ['firebase.json',                       'hosting + rules deployment'],
    ['package.json',                        'dependency surface'],
    ['package-lock.json',                   'the resolved dependency tree'],
    ['send-otp.js',                         'auth'],
    ['verify-otp.js',                       'auth'],
];

describe('the Risk gate covers the files that define the Risk gate', () => {
    for (const [file, why] of MUST_BE_GATED) {
        it(`gates ${file} — ${why}`, () => {
            expect(matches(RISK_GATE, file), `${file} is NOT gated by the Risk gate`).toBe(true);
        });
    }
});

describe('the two gates agree, so they cannot drift apart again', () => {
    for (const [file] of MUST_BE_GATED) {
        it(`auto-safe classifier also covers ${file}`, () => {
            expect(matches(AUTO_SAFE, file), `${file} is NOT covered by auto-merge.yml`).toBe(true);
        });
    }
});

describe('ordinary changes still flow without a human', () => {
    // A gate that stops everything gets switched off. These must NOT be flagged,
    // or the whole autonomous pipeline deadlocks on trivia.
    const ORDINARY = [
        'wealthflow-insights.js',
        'wealthflow-merchants.js',
        'test/feedback_test.js',
        'CHANGELOG.md',
        'merchants.json',
        'README.md',
    ];
    for (const file of ORDINARY) {
        it(`does not gate ${file}`, () => {
            expect(matches(RISK_GATE, file), `${file} should NOT need human approval`).toBe(false);
        });
    }
});

describe('the regexes are valid and were really found', () => {
    it('both were extracted, not silently defaulted', () => {
        expect(RISK_GATE.length).toBeGreaterThan(50);
        expect(AUTO_SAFE.length).toBeGreaterThan(50);
    });

    it('grep accepts both — a malformed regex must fail loudly here, not in CI', () => {
        // grep exits 2 on a bad pattern; matches() rethrows that, so a syntax
        // error in either list surfaces as a red test rather than as a gate that
        // errors at merge time.
        expect(() => matches(RISK_GATE, 'anything.js')).not.toThrow();
        expect(() => matches(AUTO_SAFE, 'anything.js')).not.toThrow();
    });
});
