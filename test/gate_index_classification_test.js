/* =============================================================================
 * test/gate_index_classification_test.js
 * -----------------------------------------------------------------------------
 * WHAT THIS PINS
 *
 * Three independent gates decide whether a change to index.html may merge
 * without a human:
 *
 *   .github/workflows/wealthflow-ci.yml   the Risk gate (required status check)
 *   .github/workflows/auto-merge.yml      decides whether to merge unattended
 *   policy/wealthflow.rego                the OPA firewall, RULE 2
 *
 * Each now consults autonomy/classify-index-diff.mjs, and each may remove
 * index.html from its sensitive set on one specific answer. That is a
 * deliberate weakening of RULE 2 — "the pipeline may not weaken its own
 * guardrails" — so the properties that make it safe have to be checked, not
 * assumed:
 *
 *   1. All three actually consult the classifier. A gate that silently does not
 *      is the drift this repository has produced twice already (the risk gate
 *      blind to .github/, the rego blind to index.html).
 *   2. All three DEFAULT to sensitive. `safe` must be the only string that
 *      moves the verdict — not "not sensitive", not truthiness, not an empty
 *      value from a crashed step.
 *   3. The subtraction is exact-line. `grep -v index.html` would also drop
 *      `docs/index.html` and `api/index.html` from the sensitive list, which is
 *      how one exemption becomes three.
 *   4. The kill switch exists in all three.
 *
 * WHERE A TEXT ASSERTION IS UNAVOIDABLE, IT IS PAIRED WITH A BEHAVIOURAL ONE.
 * Workflow YAML cannot be executed here, so property 3 is checked twice: the
 * literal command is pinned in the file, AND that literal is run through the
 * real `grep` to show it has the property claimed for it. A text assertion on
 * its own is the weak form that has already let a dead guard pass in this repo.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const CI = '.github/workflows/wealthflow-ci.yml';
const AM = '.github/workflows/auto-merge.yml';
const PG = '.github/workflows/policy-gate.yml';
const REGO = 'policy/wealthflow.rego';
const CLASSIFIER = 'autonomy/classify-index-diff.mjs';

/* The three files that can drop index.html from their sensitive set. */
const GATES = [
    ['the Risk gate', CI],
    ['the auto-merge classifier', AM],
    ['the policy-gate input builder', PG],
];

describe('every gate consults the classifier', () => {
    for (const [name, file] of GATES) {
        it(`${name} runs autonomy/classify-index-diff.mjs`, () => {
            expect(read(file)).toContain('autonomy/classify-index-diff.mjs');
        });

        it(`${name} starts from a sensitive verdict`, () => {
            // The variable must be initialised to `sensitive` BEFORE anything can
            // fail, so that a crash, a timeout or an early exit leaves it there.
            const src = read(file);
            expect(/(verdict=sensitive|IDXV=sensitive)/.test(src),
                `${file} does not initialise its verdict to sensitive`).toBe(true);
        });

        it(`${name} moves only on the literal string "safe"`, () => {
            const src = read(file);
            const compares = [...src.matchAll(/(?:IDXV|V|INDEX_VERDICT)[^\n]*?=\s*"safe"|=\s*"safe"|"\$\{INDEX_VERDICT:-sensitive\}"\s*=\s*"safe"|\[\s*"\$V"\s*=\s*"safe"\s*\]|\[\s*"\$IDXV"\s*=\s*"safe"\s*\]/g)];
            expect(compares.length, `${file} never compares a verdict against "safe"`)
                .toBeGreaterThan(0);
            // And never against anything looser.
            expect(/!=\s*['"]sensitive['"]/.test(src),
                `${file} tests for "not sensitive" — that admits every unexpected value`)
                .toBe(false);
        });

        it(`${name} honours the full-gate kill switch`, () => {
            expect(read(file)).toContain('full-gate');
        });
    }
});

describe('the subtraction removes index.html and nothing else', () => {
    /* Property 3, half one: the literal is what we think it is. */
    for (const [name, file] of [['the Risk gate', CI], ['the auto-merge classifier', AM]]) {
        it(`${name} subtracts with an exact-line match`, () => {
            expect(read(file), `${file} must use grep -vx, not a substring match`)
                .toContain("grep -vx 'index\\.html'");
        });
    }

    /* Property 3, half two: that literal, run through the real grep, against
     * paths that a substring match WOULD have swallowed. This is the half that
     * would still fail if `-x` were dropped. */
    const runGrep = (args, input) => {
        try {
            return execFileSync('grep', args, { input, encoding: 'utf8' });
        } catch (e) {
            if (e.status === 1) return '';
            throw e;
        }
    };

    const SENSITIVE_SET = [
        'index.html',
        'docs/index.html',
        'api/index.html',
        'index_html',
        'wealthflow-index.html.bak',
        'sw.js',
        'package.json',
    ].join('\n');

    it('keeps every other path when index.html is cleared', () => {
        const kept = runGrep(['-vx', 'index\\.html'], SENSITIVE_SET).split('\n').filter(Boolean);
        expect(kept).toEqual([
            'docs/index.html', 'api/index.html', 'index_html',
            'wealthflow-index.html.bak', 'sw.js', 'package.json',
        ]);
    });

    it('a substring subtraction would have dropped four of them — which is why -x is there', () => {
        // Not a hypothetical: this is the exact command minus `-x`.
        const kept = runGrep(['-v', 'index\\.html'], SENSITIVE_SET).split('\n').filter(Boolean);
        expect(kept).toEqual(['index_html', 'sw.js', 'package.json']);
    });
});

describe('the rego exemption', () => {
    const src = read(REGO);

    it('exists as one greppable rule rather than a condition inside guardrail()', () => {
        // guardrail(f) must still say index.html is a guardrail path — that is
        // what test/sensitive_paths_test.js's mirror reads, and burying the
        // exemption inside a conjunction would make it invisible there.
        expect(src).toContain('guardrail(f) if f == "index.html"');
        expect(src).toMatch(/unattended_ok\(f\) if \{/);
    });

    it('names index.html and no other file', () => {
        const body = /unattended_ok\(f\) if \{([\s\S]*?)\}/.exec(src);
        expect(body, 'unattended_ok not found').not.toBe(null);
        const files = [...body[1].matchAll(/f == "([^"]+)"/g)].map((m) => m[1]);
        expect(files).toEqual(['index.html']);
    });

    it('requires the literal verdict "safe", so a missing field cannot match', () => {
        const body = /unattended_ok\(f\) if \{([\s\S]*?)\}/.exec(src)[1];
        expect(body).toContain('input.index_html_verdict == "safe"');
        expect(/not\s+input\.index_html_verdict/.test(body),
            'a negated test would match an ABSENT field and exempt every diff').toBe(false);
    });

    it('is wired into RULE 2 rather than sitting unreferenced', () => {
        // A rule nobody calls is the same defect as a label nobody applies —
        // this repo has shipped that exact shape twice.
        expect(src).toContain('not unattended_ok(f)');
    });
});

describe('the classifier cannot be judged by its own pull request', () => {
    it('refuses when its own path is in the changed set', () => {
        expect(read(CLASSIFIER)).toContain('changedFiles.includes(SELF_PATH)');
    });

    it('and its own path is a guardrail path regardless', () => {
        // Belt and braces: even if the refusal above were removed, autonomy/**
        // requires human approval, so a PR editing the classifier still cannot
        // merge unattended.
        expect(read(REGO)).toContain('guardrail(f) if startswith(f, "autonomy/")');
    });
});

describe('the merge base the classifier diffs against', () => {
    const action = read('.github/actions/changed-files/action.yml');

    it('is published by the shared action, not re-derived per gate', () => {
        expect(action).toContain('base_sha:');
        expect(action).toContain('head_sha:');
    });

    it('resolving it never fails the action', () => {
        // A gate that already has its file list must not go red over an extra
        // output. Both assignments are guarded.
        expect(action).toMatch(/BASE_SHA=\$\(git merge-base [^)]*\|\| true\)/);
        expect(action).toMatch(/HEAD_SHA=\$\(git rev-parse HEAD [^)]*\|\| true\)/);
    });

    it('and both consumers treat an empty value as "cannot classify"', () => {
        for (const f of [CI, PG]) {
            expect(read(f), `${f} does not guard against an empty base sha`)
                .toMatch(/if \[ -z "\$\{BASE_SHA:-\}" \] \|\| \[ -z "\$\{HEAD_SHA:-\}" \]; then/);
        }
    });
});
