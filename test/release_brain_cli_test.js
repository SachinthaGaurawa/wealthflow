/* =============================================================================
 * test/release_brain_cli_test.js — the brain step must RUN, and must be able
 * to fail
 * -----------------------------------------------------------------------------
 * WHAT HAPPENED
 *
 * `.github/workflows/auto-release.yml` armed the release brain like this:
 *
 *     - name: Arm the release brain (optional)
 *       continue-on-error: true
 *       run: |
 *         npm i firebase-admin@12 --no-save >/dev/null 2>&1 || {
 *           echo "firebase-admin install failed — skipping the brain"; exit 0; }
 *         node release-brain.js || echo "brain step non-fatal"
 *
 * Four independent layers of error suppression around one command — and the
 * command itself did nothing at all.
 *
 * package.json declares `"type": "module"`, and release-brain.js's only export
 * is `export default async function handler(req, res)`. So `node
 * release-brain.js` parsed the module, bound the function, ran off the end of
 * the module body and exited 0 in milliseconds. It never called the handler,
 * never opened a Firestore connection, and never wrote `system/pendingRelease`.
 *
 * Every release therefore showed a green 3-second "Arm the release brain", and
 * autonomy/proposal-intake.mjs — reading the document that step was supposed to
 * write — reported, accurately, `system/pendingRelease does not exist.` Three
 * workflows agreeing, all green, describing a chain that had never once run.
 *
 * Same defect family as the discover.mjs masking bug and the gitignored
 * lockfile: AN INFRASTRUCTURE FAILURE WEARING THE COSTUME OF A RESULT. Here it
 * was worse than a mask — there was no result underneath to hide.
 *
 * The tests below are in two halves:
 *   1. the CLI exists, runs the handler, and reports an honest exit code
 *   2. the workflow actually invokes it, with nothing left that can eat the
 *      failure
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isEntryPoint, brainExitCode, runBrainCli } from '../release-brain.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* The workflow, with comment lines removed. This file's own explanations quote
 * the very strings being asserted against — matching them would make every
 * assertion below pass for the wrong reason. The same trap caught the
 * lockfile guard and, before it, the alt-text regex that matched its own
 * regex literal. */
const WF_RAW = read('.github/workflows/auto-release.yml');
const WF = WF_RAW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

// ── 1. the CLI ───────────────────────────────────────────────────────────────

describe('running the file runs the brain', () => {
    it('actually calls the handler instead of just defining it', async () => {
        // The whole bug in one assertion.
        let called = 0;
        await runBrainCli({
            log: () => {}, logErr: () => {},
            invoke: async (req, res) => { called++; res.status(200).json({ ok: true, wrote: ['pendingRelease'] }); },
        });
        expect(called, 'the CLI defined the handler without calling it — this is the original defect').toBe(1);
    });

    it('exits 0 only when pendingRelease was actually written', async () => {
        const run = (body) => runBrainCli({
            log: () => {}, logErr: () => {},
            invoke: async (req, res) => res.status(200).json(body),
        });
        await expect(run({ ok: true, wrote: ['feedbackPriority', 'pendingRelease'], note: '' })).resolves.toBe(0);
        await expect(run({ ok: true, wrote: ['feedbackPriority'], note: '' })).resolves.toBe(1);
    });

    it('exits 1 when the handler throws', async () => {
        const code = await runBrainCli({
            log: () => {}, logErr: () => {},
            invoke: async () => { throw new Error('boom'); },
        });
        expect(code).toBe(1);
    });

    it('exits 1 when the handler answers nothing at all', async () => {
        const code = await runBrainCli({ log: () => {}, logErr: () => {}, invoke: async () => {} });
        expect(code).toBe(1);
    });

    it('annotates the failure so it is visible in the Actions UI', async () => {
        const errs = [];
        await runBrainCli({
            log: () => {}, logErr: (m) => errs.push(String(m)),
            invoke: async (req, res) => res.status(200).json({ ok: true, wrote: [], note: ' priority write failed;' }),
        });
        expect(errs.join('\n')).toMatch(/^::error::/m);
        expect(errs.join('\n')).toMatch(/priority write failed/);
    });
});

describe('brainExitCode treats a swallowed note as the failure it is', () => {
    /* `handler` folds every Firestore error into `out.note` and still answers
     * `ok: true`. Correct for an HTTP caller who reads the note; fatal for a
     * scheduled job where the note scrolls past and the tick stays green. */
    it('fails on a note even when ok is true and the write is listed', () => {
        expect(brainExitCode({ ok: true, wrote: ['pendingRelease'], note: ' archive pass failed;' })).toBe(1);
    });

    it('fails when the brain reports itself idle for want of credentials', () => {
        expect(brainExitCode({
            ok: false, wrote: [], note: 'FIREBASE_SERVICE_ACCOUNT not configured — brain idle.',
        })).toBe(1);
    });

    it('accepts the rerank path, which writes pendingRelease only conditionally', () => {
        expect(brainExitCode({ ok: true, mode: 'rerank', wrote: ['feedbackPriority(rerank)'], note: '' })).toBe(0);
    });

    it('accepts the rerank proposal write too', () => {
        expect(brainExitCode({
            ok: true, mode: 'rerank', wrote: ['feedbackPriority(rerank)', 'pendingRelease(rerank)'], note: '',
        })).toBe(0);
    });

    it('rejects a malformed result rather than reading it as success', () => {
        for (const bad of [null, undefined, 'ok', 7, []]) expect(brainExitCode(bad)).toBe(1);
    });
});

describe('entry-point detection', () => {
    const SELF = 'file:///home/runner/work/wealthflow/wealthflow/release-brain.js';

    it('is true when node was pointed at this file', () => {
        expect(isEntryPoint('/home/runner/work/wealthflow/wealthflow/release-brain.js', SELF)).toBe(true);
    });

    it('tolerates a symlinked checkout spelling the same file two ways', () => {
        // argv[1] is resolved but not realpath'd.
        expect(isEntryPoint('/checkout/release-brain.js', SELF)).toBe(true);
    });

    it('is false when something else is the entry point', () => {
        // This is the case that matters: api/router.js imports this module on
        // Vercel, and vitest imports it here. Neither may execute the CLI.
        expect(isEntryPoint('/var/task/___vc/__launcher.js', SELF)).toBe(false);
        expect(isEntryPoint('/usr/lib/node_modules/vitest/vitest.mjs', SELF)).toBe(false);
        expect(isEntryPoint(undefined, SELF)).toBe(false);
        expect(isEntryPoint('', SELF)).toBe(false);
    });

    it('never throws on junk', () => {
        expect(isEntryPoint('x', 'not-a-url')).toBe(false);
        expect(isEntryPoint(null, null)).toBe(false);
    });
});

describe('the real process behaves the way the unit tests claim', () => {
    /* The unit tests above inject `invoke`. This one spawns node for real, so
     * a regression in the module-level entry-point guard cannot hide behind
     * them — the original bug was precisely that the module level did nothing. */
    it('runs, reports, and exits non-zero with no credentials', () => {
        const r = spawnSync(process.execPath, ['release-brain.js'], {
            cwd: ROOT, encoding: 'utf8', timeout: 60_000,
            env: { ...process.env, FIREBASE_SERVICE_ACCOUNT: '', RELEASE_BRAIN_ENABLED: '1' },
        });
        expect(r.status, 'node release-brain.js exited 0 without doing anything — the original bug is back').toBe(1);
        expect(r.stdout + r.stderr).toMatch(/brain idle|::error::/);
    });

    it('importing it stays completely inert', () => {
        const r = spawnSync(process.execPath,
            ['-e', "import('./release-brain.js').then(m=>console.log('EXPORTS:'+Object.keys(m).sort().join(',')))"],
            { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
        expect(r.status, 'importing the module ran the CLI — api/router.js would break').toBe(0);
        // Assert the surface the CLI and api/router.js depend on, NOT a frozen
        // list: pinning every export made this fail the moment the version
        // helpers were added, which is noise rather than a finding.
        const exports = (r.stdout.match(/EXPORTS:(.*)/) || [, ''])[1].split(',');
        for (const name of ['default', 'isEntryPoint', 'brainExitCode', 'runBrainCli']) {
            expect(exports, `release-brain no longer exports ${name}`).toContain(name);
        }
        expect(r.stdout, 'importing the module produced CLI output').not.toMatch(/::error::|release-brain wrote/);
    });
});

// ── 2. the workflow ──────────────────────────────────────────────────────────

describe('auto-release arms the brain for real', () => {
    it('installs dependencies from the lockfile', () => {
        // The job had NO install step at all. Three separate steps each ran
        // `npm i firebase-admin@12 --no-save`, floating the version and hiding
        // the outcome.
        expect(WF, 'auto-release still has no npm ci').toMatch(/run:\s*npm ci\b/);
        expect(WF, 'a fallback would let a broken install read as a finished release')
            .not.toMatch(/npm ci\s*\|\|\s*npm install/);
        expect(WF, 'an ad-hoc floating firebase-admin install is back').not.toMatch(/npm i firebase-admin/);
    });

    it('invokes release-brain.js with nothing appended that can eat the failure', () => {
        const line = WF.split('\n').find((l) => /node release-brain\.js/.test(l));
        expect(line, 'the brain is no longer invoked at all').toBeTruthy();
        expect(line.trim(), 'the failure is being swallowed again').toBe('run: node release-brain.js');
    });

    it('has no continue-on-error anywhere in the job', () => {
        expect(WF).not.toMatch(/continue-on-error/);
    });

    it('has no blanket `|| true` left', () => {
        // Every one of these turned a real failure into a clean-looking run:
        // a failed bootstrap tag push (permanent deadlock), a failed rev-list
        // ("no new commits"), a failed pre-release rebase.
        expect(WF).not.toMatch(/\|\|\s*true\s*$/m);
    });

    it('never redirects a command it depends on into /dev/null', () => {
        // Two survivors are legitimate: `git describe` and `git rev-parse
        // --verify` use the exit status as an ANSWER, not as an error.
        const bad = WF.split('\n')
            .filter((l) => />\s*\/dev\/null/.test(l))
            .filter((l) => !/git describe|git rev-parse/.test(l));
        expect(bad, 'a command whose failure matters is being silenced').toEqual([]);
    });

    it('does not report the tag step as done when the tag was not made', () => {
        expect(WF).not.toMatch(/tag push failed \(non-fatal\)/);
        expect(WF).toMatch(/UNTAGGED/);
    });

    it('keeps the not-configured case as a skip rather than a fake success', () => {
        // `if: env.HAS_FIREBASE == 'true'` is a configuration gate, not error
        // suppression: an absent secret renders as a SKIPPED step in the UI,
        // which is visibly different from green.
        expect(WF).toMatch(/if:\s*env\.HAS_FIREBASE == 'true'/);
        expect(WF).toMatch(/HAS_FIREBASE:\s*\$\{\{\s*secrets\.FIREBASE_SERVICE_ACCOUNT != ''\s*\}\}/);
    });
});

describe('the guard cannot pass vacuously', () => {
    it('is reading a workflow that exists and is not empty after comment-stripping', () => {
        expect(WF_RAW.length).toBeGreaterThan(1000);
        expect(WF).toMatch(/name: Auto Release \(WealthFlow\)/);
        expect(WF).toMatch(/steps:/);
    });

    it('would still see the suppression it is asserting against', () => {
        // Guard the guard: prove the comment-stripping did not delete the code
        // lines, and that the patterns match when they are genuinely present.
        const withBug = WF + '\n        continue-on-error: true\n        run: node release-brain.js || echo x\n';
        expect(withBug).toMatch(/continue-on-error/);
        expect(withBug.split('\n').find((l) => /node release-brain\.js \|\| echo/.test(l))).toBeTruthy();
    });
});
