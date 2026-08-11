/* =============================================================================
 * test/lockfile_integrity_test.js — the build must be reproducible, and a
 * broken toolchain must never be reported as a broken codebase
 * -----------------------------------------------------------------------------
 * WHAT HAPPENED
 *
 * `.gitignore` line 2 was `package-lock.json`. One line, three failures, none of
 * which announced itself:
 *
 *   1. `npm ci` REFUSES to run without a lockfile — it exits EUSAGE, "can only
 *      install with an existing package-lock.json". Seven workflows say
 *      `npm ci || npm install`, so every one of them failed the first half and
 *      quietly fell through to the second. `npm ci` had never once succeeded in
 *      this repository.
 *
 *   2. fuzz-gate.yml said `npm ci && npm test` with NO fallback. `&&`
 *      short-circuited on the EUSAGE exit, so the fuzz suite NEVER EXECUTED.
 *      The job then printed "Fuzz FAILED → removing fuzz-passed and blocking"
 *      and failed the check — announcing a test result for tests that had not
 *      run. Since RULE 1 of policy/wealthflow.rego requires the `fuzz-passed`
 *      label before firestore.rules, auth, OAuth, crypto or the money paths may
 *      merge, the most safety-critical files in the repo were gated by a check
 *      whose verdict contained no information about the code whatsoever.
 *
 *   3. Dependencies floated. Every run resolved a fresh tree, so `npm audit`
 *      was not reproducible: the same commit could be clean on one run and
 *      vulnerable on the next. `nanoid` sat at a high-severity advisory
 *      (GHSA-2v37-7h3g-55p8) with the fix already inside postcss's declared
 *      `^3.3.16` range — nothing was pinned, so nothing ever pulled it in.
 *
 * The repo's own security model already assumed the opposite. sensitive_paths
 * lists package-lock.json as a path the Risk gate MUST cover — "the resolved
 * dependency tree" — and substantive/autonomy both treat it as a file that
 * appears in diffs. A guard was written for a file that could never be guarded.
 *
 * This is the same defect family as the discover.mjs masking bug fixed in the
 * same change: an INFRASTRUCTURE FAILURE WEARING THE COSTUME OF A RESULT.
 * "could not look" reported as "found nothing"; "could not install" reported as
 * "the fuzz suite failed".
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('the lockfile is committed, because npm ci cannot work without it', () => {
    it('is tracked by git', () => {
        // The strongest form of the assertion: not "a file exists on this
        // machine" but "a fresh checkout will have one". The `npm install` in
        // this working copy would satisfy the weaker check while CI still got
        // nothing.
        const r = spawnSync('git', ['ls-files', '--error-unmatch', 'package-lock.json'],
            { cwd: ROOT, encoding: 'utf8' });
        expect(r.status, 'package-lock.json is NOT tracked — every `npm ci` in CI will fail EUSAGE').toBe(0);
    });

    it('is not ignored', () => {
        const r = spawnSync('git', ['check-ignore', 'package-lock.json'], { cwd: ROOT, encoding: 'utf8' });
        // check-ignore exits 0 when the path IS ignored.
        expect(r.status, 'package-lock.json is ignored again — see the comment in .gitignore').not.toBe(0);
    });

    it('records a resolved tree npm can actually install from', () => {
        const lock = JSON.parse(read('package-lock.json'));
        expect(lock.lockfileVersion, 'npm ci needs lockfileVersion >= 1').toBeGreaterThanOrEqual(1);
        expect(Object.keys(lock.packages || {}).length).toBeGreaterThan(50);
    });

    it('resolves every package from the public registry', () => {
        // A lockfile generated behind a proxy can carry internal hosts in its
        // `resolved` URLs. Committing one of those would break CI on the first
        // run and be genuinely confusing to diagnose.
        const lock = JSON.parse(read('package-lock.json'));
        const hosts = new Set();
        for (const v of Object.values(lock.packages || {})) {
            if (v.resolved && /^https?:/.test(v.resolved)) hosts.add(new URL(v.resolved).host);
        }
        expect([...hosts], 'a non-public host in the lockfile will 404 in CI').toEqual(['registry.npmjs.org']);
    });
});

describe('the pinned tree carries no known high-severity hole', () => {
    // Pinned by ADVISORY, not by version number, so this keeps meaning
    // something after the next bump. npm audit itself is not run here: it needs
    // the network, and a test that silently passes when offline is worse than
    // no test.
    it('has nanoid at or past the fix for GHSA-2v37-7h3g-55p8', () => {
        const lock = JSON.parse(read('package-lock.json'));
        const n = lock.packages['node_modules/nanoid'];
        if (!n) return;                       // dropped from the tree entirely — fine
        const [maj, min, pat] = n.version.split('.').map(Number);
        const fixed = maj > 3 || (maj === 3 && (min > 3 || (min === 3 && pat >= 17)));
        expect(fixed, `nanoid ${n.version} is vulnerable: custom generators loop forever when size is 0`).toBe(true);
    });
});

describe('the fuzz gate reports on the code, never on its own toolchain', () => {
    const WF = read('.github/workflows/fuzz-gate.yml');
    /** YAML with whole-line comments removed. The first draft of the assertion
     *  below matched the comment that DOCUMENTS the old broken line and failed
     *  on the fix itself — the same shape as the alt-text detector that once
     *  matched a regex literal instead of an <img> tag. A checker must read the
     *  code, not the prose about the code. */
    const CODE = WF.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

    it('does not chain install and test into one verdict', () => {
        // The exact line that produced "Fuzz FAILED" for a suite that never ran.
        expect(CODE, 'npm ci && npm test is back: a failed install will again be reported as a failed fuzz run')
            .not.toMatch(/npm ci\s*&&\s*npm test/);
    });

    it('strips comments without stripping the workflow', () => {
        // Guards the guard: if CODE ever came back empty the assertion above
        // would pass against nothing at all.
        expect(CODE).toMatch(/runs-on: ubuntu-latest/);
        expect(CODE).toMatch(/npm test/);
    });

    it('installs in a step of its own', () => {
        expect(WF).toMatch(/- name: Install dependencies[\s\S]{0,200}?run: npm ci/);
    });

    it('does not let the install step swallow its own failure', () => {
        // continue-on-error on the install is what would re-launder a broken
        // toolchain into a statement about the code.
        const i = WF.indexOf('Install dependencies');
        expect(i, 'install step anchor not found — retarget this test').toBeGreaterThan(-1);
        const step = WF.slice(i, WF.indexOf('- name:', i + 10));
        expect(step, 'the install step must fail the job loudly, as an install failure')
            .not.toMatch(/continue-on-error/);
    });

    it('keeps continue-on-error on the suite itself, so a real failure still labels the PR', () => {
        // Deliberate: the fuzz step must be allowed to fail so the label step
        // runs and REVOKES fuzz-passed. Removing this would skip the revoke.
        const i = WF.indexOf('Run intensive fuzz/property suite');
        const step = WF.slice(i, WF.indexOf('- name:', i + 10));
        expect(step).toMatch(/continue-on-error:\s*true/);
        expect(step).toMatch(/run: npm test/);
    });

    it('still blocks the merge when the suite genuinely fails', () => {
        // The fix must not have weakened the gate — only made its verdict honest.
        expect(WF).toMatch(/--remove-label fuzz-passed/);
        expect(WF).toMatch(/exit 1/);
    });
});

describe('the workflows that fall back to npm install still exist', () => {
    it('names them, so the fallback is a known choice rather than a hidden one', () => {
        // `npm ci || npm install` is deliberate resilience in the non-gate
        // workflows: they should keep running if the lockfile ever desyncs.
        // It is recorded here because that same fallback is what hid the
        // problem for this long — it must never be added to fuzz-gate.yml,
        // where the outcome becomes a merge-blocking label.
        const dir = path.join(ROOT, '.github/workflows');
        const withFallback = fs.readdirSync(dir)
            .filter((f) => /\.ya?ml$/.test(f))
            .filter((f) => /npm ci\s*\|\|\s*npm install/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
        expect(withFallback, 'fuzz-gate must never mask an install failure').not.toContain('fuzz-gate.yml');
        expect(withFallback.length, 'the fallback vanished everywhere — intended?').toBeGreaterThan(0);
    });
});
