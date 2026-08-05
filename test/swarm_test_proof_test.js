/* =============================================================================
 * test/swarm_test_proof_test.js  —  issue #78
 * -----------------------------------------------------------------------------
 * WHAT HAPPENED
 *
 * Five autonomous PRs (#67, #72, #73, #75, #76) shipped roughly a thousand lines
 * of generated tests. Every one of those test files fails on its own branch:
 *
 *   #72  TypeError: Cannot read properties of undefined (reading 'ensureCryptoJS')
 *   #73  Error: Cannot find module 'jsdom'
 *   #75  Cannot find package 'jsdom'          (no tests even collected)
 *   #76  ReferenceError: document is not defined
 *
 * Not one assertion had ever executed. The gate that accepted them was three
 * regexes in agent-swarm.mjs: does the file mention vitest, does the string
 * `expect(` appear, does it parse. A file that imports a package this repo does
 * not have and throws on line 1 satisfies all three.
 *
 * That is this project's recurring defect in its purest form — something
 * produces an output and nothing consumes it. The check read the SHAPE of the
 * artifact instead of its BEHAVIOUR.
 *
 * AND THEN IT GOT WORSE
 *
 * Told about all of this in issue #78, the swarm opened #79 and then #80 —
 * byte-identical, `index f028564..5da71d5` both times — flipping
 * vitest.config.js from `environment: 'node'` to `'jsdom'` without adding the
 * dependency. Measured: 904 passing tests become 0 tests / 33 errors. Told its
 * tests did not run, it disabled every test in the repository. #80 arrived
 * already carrying `human-approved`, which would have unlocked every gate.
 *
 * WHAT THIS FILE GUARDS
 *   1. verifyTestProves() actually runs the candidate red→green, and rejects
 *      the three ways that can fail — including the vacuous pass.
 *   2. The working tree is handed back untouched no matter how it exits.
 *   3. The agent cannot select vitest.config.* at all.
 *   4. testPrompt() states the real environment instead of the imaginary one.
 *   5. rego RULE 6 has no `human-approved` escape.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    verifyTestProves, runVitestFile, isSensitive, candidateFiles, testPrompt,
} from '../autonomy/agent-swarm.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** A throwaway repo with one module and a test/ directory. */
function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-proof-'));
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'mod.js'), 'ORIGINAL');
    return dir;
}

/** A stub Vitest that returns scripted verdicts, one per call, in order. */
function scriptedRunner(...verdicts) {
    const calls = [];
    const run = (testPath) => {
        calls.push(testPath);
        const passed = verdicts[calls.length - 1];
        return { passed, output: passed ? '' : 'stub failure' };
    };
    run.calls = calls;
    return run;
}

const args = (dir, run) => ({
    repoDir: dir,
    targetFile: 'mod.js',
    before: 'ORIGINAL',
    after: 'FIXED',
    testFile: path.join('test', 'candidate.test.js'),
    testSource: 'import { it, expect } from "vitest"; it("x", () => expect(1).toBe(1));',
    run,
});

describe('a test is only evidence if it moves from red to green', () => {
    it('accepts fail-before, pass-after — the only transition that proves anything', () => {
        const dir = sandbox();
        const run = scriptedRunner(false, true);
        const r = verifyTestProves(args(dir, run));

        expect(r.ok).toBe(true);
        expect(r.beforeFailed).toBe(true);
        expect(r.afterPassed).toBe(true);
        expect(run.calls).toHaveLength(2);
    });

    it('REJECTS a test that already passes against the unfixed file', () => {
        // The vacuous pass: `expect(1+1).toBe(2)` also passes after the fix.
        // Passing afterwards is not evidence; only the transition is.
        const dir = sandbox();
        const run = scriptedRunner(true, true);
        const r = verifyTestProves(args(dir, run));

        expect(r.ok).toBe(false);
        expect(r.beforeFailed).toBe(false);
        expect(r.reason).toMatch(/UNFIXED/);
        // It must not waste a second Vitest run once the first verdict is fatal.
        expect(run.calls).toHaveLength(1);
    });

    it('REJECTS a test that fails both ways — the actual history of five PRs', () => {
        const dir = sandbox();
        const run = scriptedRunner(false, false);
        const r = verifyTestProves(args(dir, run));

        expect(r.ok).toBe(false);
        expect(r.beforeFailed).toBe(true);
        expect(r.afterPassed).toBe(false);
        expect(r.reason).toMatch(/still fails/);
        expect(r.output).toBe('stub failure');
    });

    it('runs the candidate against the ORIGINAL file first, then the fixed one', () => {
        // The ordering is the whole mechanism. Assert the file contents the
        // runner actually saw, not merely that it was called twice.
        const dir = sandbox();
        const seen = [];
        const run = () => {
            seen.push(fs.readFileSync(path.join(dir, 'mod.js'), 'utf8'));
            return { passed: seen.length === 2, output: '' };
        };
        const r = verifyTestProves(args(dir, run));

        expect(r.ok).toBe(true);
        expect(seen).toEqual(['ORIGINAL', 'FIXED']);
    });

    it('writes the candidate where Vitest will actually find it', () => {
        const dir = sandbox();
        let existedDuringRun = false;
        const run = () => {
            existedDuringRun = fs.existsSync(path.join(dir, 'test', 'candidate.test.js'));
            return { passed: false, output: '' };
        };
        verifyTestProves(args(dir, run));
        expect(existedDuringRun).toBe(true);
    });
});

describe('the working tree is handed back exactly as it was found', () => {
    // runSwarm() returns the new code for its CALLER to apply. If the verifier
    // left the fix half-applied on disk, a later failure would ship it silently.
    const restored = (dir) => fs.readFileSync(path.join(dir, 'mod.js'), 'utf8');
    const tempGone = (dir) => !fs.existsSync(path.join(dir, 'test', 'candidate.test.js'));

    it('after a successful verification', () => {
        const dir = sandbox();
        verifyTestProves(args(dir, scriptedRunner(false, true)));
        expect(restored(dir)).toBe('ORIGINAL');
        expect(tempGone(dir)).toBe(true);
    });

    it('after a rejected verification', () => {
        const dir = sandbox();
        verifyTestProves(args(dir, scriptedRunner(false, false)));
        expect(restored(dir)).toBe('ORIGINAL');
        expect(tempGone(dir)).toBe(true);
    });

    it('after the runner throws outright', () => {
        const dir = sandbox();
        const r = verifyTestProves(args(dir, () => { throw new Error('vitest exploded'); }));
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/vitest exploded/);
        expect(restored(dir)).toBe('ORIGINAL');
        expect(tempGone(dir)).toBe(true);
    });
});

describe('it fails closed', () => {
    it.each([
        ['no target file', { targetFile: '', testFile: 't.js', testSource: 'x' }],
        ['no test file', { targetFile: 'mod.js', testFile: '', testSource: 'x' }],
        ['no test source', { targetFile: 'mod.js', testFile: 't.js', testSource: '' }],
        ['nothing at all', {}],
    ])('rejects when there is %s', (_label, partial) => {
        expect(verifyTestProves(partial).ok).toBe(false);
    });

    it('runVitestFile reports a failure rather than throwing', () => {
        // The verifier's control flow depends on this never throwing.
        const r = runVitestFile('test/__does_not_exist__.test.js', { repoDir: ROOT, timeoutMs: 60_000 });
        expect(r.passed).toBe(false);
        expect(typeof r.output).toBe('string');
    });

    it('runVitestFile really does report a PASS for a passing file', () => {
        // Everything above drives the verifier with a stub. Without this, the
        // one component that talks to actual Vitest would only ever have been
        // observed failing — and "always returns false" would pass every other
        // test in this file.
        const name = `__proof_probe_${process.pid}.test.js`;
        const p = path.join(ROOT, 'test', name);
        fs.writeFileSync(p, 'import { it, expect } from "vitest";\nit("passes", () => { expect(2 + 2).toBe(4); });\n');
        try {
            const r = runVitestFile(path.join('test', name), { repoDir: ROOT, timeoutMs: 120_000 });
            expect(r.passed, `real vitest run did not pass:\n${r.output}`).toBe(true);
        } finally {
            try { fs.unlinkSync(p); } catch { /* best effort */ }
        }
    });
});

describe('the agent cannot touch the instrument that judges it', () => {
    it.each([
        'vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts',
        'vite.config.js', 'vite.config.mjs',
    ])('refuses to edit %s', (f) => {
        expect(isSensitive(f)).toBe(true);
    });

    it('excludes vitest.config.js from the files it may pick', () => {
        // The real hole behind #79/#80: vitest.config.js is a root-level .js
        // file, so it sailed through candidateFiles() as an ordinary module.
        const picked = candidateFiles(
            ['vitest.config.js', 'wealthflow-icons.js', 'vite.config.js'],
            { repoDir: ROOT },
        );
        expect(picked).not.toContain('vitest.config.js');
        expect(picked).not.toContain('vite.config.js');
        // Not vacuous: an ordinary module still gets through.
        expect(picked).toContain('wealthflow-icons.js');
    });

    it('the hard rules given to every author name it too', async () => {
        const src = fs.readFileSync(path.join(ROOT, 'autonomy', 'agent-swarm.mjs'), 'utf8');
        const rules = src.slice(src.indexOf('ABSOLUTE CONSTRAINTS'), src.indexOf('ABSOLUTE CONSTRAINTS') + 900);
        expect(rules).toMatch(/vitest\.config/);
    });
});

describe('the QA prompt describes the real environment, not an imaginary one', () => {
    const p = testPrompt('some issue', 'wealthflow-icons.js', 'before', 'after');

    it("says the environment is 'node'", () => {
        expect(p).toMatch(/environment: 'node'/);
        expect(p).toMatch(/NO `document`/);
    });

    it('says jsdom is unavailable — the cause of three of the five failures', () => {
        expect(p).toMatch(/`jsdom` is NOT installed/);
    });

    it('names `new Function` as the way to load the module, not `import`', () => {
        // The old prompt correctly said "browser IIFE attached to window" and
        // then, one line later, suggested `await import(...)`. These modules
        // have no exports at all, so the model reached for `module.default.x`
        // and got a TypeError — #67 and #72 verbatim.
        expect(p).toMatch(/new Function/);
        expect(p).toMatch(/update_ui_truth_test\.js/);
    });

    it('mentions `await import` ONLY to say it does not work here', () => {
        // The mention is deliberate and worth keeping — naming the wrong turn is
        // what stops the model taking it. But it must appear as a warning, never
        // as an instruction, so assert the warning travels with it.
        const idx = p.indexOf('await import');
        expect(idx, 'the warning has been dropped entirely').toBeGreaterThan(-1);
        expect(p.slice(idx, idx + 200)).toMatch(/no `default`/);
        // And it must not be phrased as a step to follow.
        expect(p).not.toMatch(/load the module with[\s\S]{0,40}await import/);
    });

    it('states the red→green contract the test will be held to', () => {
        expect(p).toMatch(/MUST FAIL/);
        expect(p).toMatch(/MUST PASS/);
    });
});

describe('rego RULE 6 — the one denial with no master key', () => {
    // STRUCTURAL, and deliberately labelled as such: conftest is not installed
    // in this job (only the policy-gate workflow installs it), so this asserts
    // the shape of the rule rather than evaluating it. The executable half of
    // this prohibition is the isSensitive() block above, which runs for real.
    const rego = fs.readFileSync(path.join(ROOT, 'policy', 'wealthflow.rego'), 'utf8');
    const rule6 = rego.slice(rego.indexOf('RULE 6'));

    it('exists', () => {
        expect(rego).toMatch(/RULE 6/);
        expect(rule6).toMatch(/test_harness_config/);
        expect(rule6).toMatch(/autonomous if "ai-fix" in input\.labels/);
    });

    it('fires on an autonomous PR touching the config', () => {
        expect(rule6).toMatch(/deny contains msg if \{[\s\S]*?autonomous[\s\S]*?test_harness_config\(f\)/);
    });

    it('has NO human-approved escape — the property the whole rule exists for', () => {
        // Every other deny in this file carries `not human_approved`. This one
        // must not: #80 arrived already labelled, and the label would have
        // unlocked it. If someone adds the escape back, this test is the alarm.
        const denyBlock = rule6.slice(rule6.indexOf('deny contains msg if'));
        expect(denyBlock).not.toMatch(/human_approved/);
    });

    it('and the other rules still DO carry it, so the contrast is real', () => {
        // Guards against a future edit that removes `human_approved` everywhere
        // and leaves this suite green for the wrong reason.
        const beforeRule6 = rego.slice(0, rego.indexOf('RULE 6'));
        expect((beforeRule6.match(/not human_approved/g) || []).length).toBeGreaterThanOrEqual(4);
    });
});
