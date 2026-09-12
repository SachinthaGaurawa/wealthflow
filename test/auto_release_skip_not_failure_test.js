/* =============================================================================
 * test/auto_release_skip_not_failure_test.js
 * -----------------------------------------------------------------------------
 * The owner's screenshot: the daily "Auto Release (WealthFlow)" workflow
 * showed a red ✗, a "failed 11 hours ago" badge, and a GitHub failure
 * notification. The actual log line, right above the failure:
 *
 *     [release] brain proposal awaits approval (approval.approved=false) —
 *     skipping. Approve via /api/approve-release or run with --force.
 *     Error: Process completed with exit code 2.
 *
 * release.cjs documents its own exit codes in its header comment: "EXIT: 0 ok
 * · 2 nothing-to-do (skipped) · 1 hard error." Exit 2 is not an error — it is
 * the release engine correctly declining to ship because nobody has approved
 * the pending change yet, exactly the same kind of state the "not due" branch
 * of the SAME workflow already treats as a clean, green no-op two steps
 * earlier. But the "Release" step ran `node release.cjs "${ARGS[@]}"` as the
 * last command of its block with no exit-code handling, so bash's default
 * (GitHub Actions runs `run:` blocks under `set -e`) treated release.cjs's
 * own documented "nothing to do" signal exactly like a crash.
 *
 * A daily cron workflow doing that trains everyone watching it — the owner
 * included, verbatim in this conversation — to read "Auto Release failed" as
 * meaningless noise, which is exactly the state where a REAL failure stops
 * getting anyone's attention.
 *
 * This runs the real shell extracted from the YAML against a fake `node`
 * (standing in for release.cjs, returning a controlled exit code) and a fake
 * `git` (a no-op, so the pre-release `git pull --rebase` never touches a real
 * repo) — not a reimplementation of the logic, the actual bytes the runner
 * executes, the same discipline test/approval_freshness_test.js already
 * applies to a sibling workflow.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/auto-release.yml'), 'utf8');

/** The `run:` body of a named step, dedented, exactly as the runner sees it. */
function stepScript(stepName) {
    const at = WF.indexOf(`- name: ${stepName}`);
    expect(at, `step "${stepName}" is gone from the workflow — retarget this test`).toBeGreaterThan(-1);
    const runAt = WF.indexOf('run: |', at);
    expect(runAt, `step "${stepName}" no longer has a run: block`).toBeGreaterThan(at);
    const lines = WF.slice(WF.indexOf('\n', runAt) + 1).split('\n');
    const indent = lines[0].match(/^\s*/)[0].length;
    const out = [];
    for (const l of lines) {
        if (l.trim() === '') { out.push(''); continue; }
        if (l.match(/^\s*/)[0].length < indent) break;
        out.push(l.slice(indent));
    }
    return out.join('\n');
}

/** Runs the real "Release" step script with fake `node` (=> a controlled
 *  release.cjs exit code) and `git` (=> always a no-op success) on PATH. */
function runReleaseStep({ fakeExitCode = 0 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-release-'));
    try {
        // Stands in for `node release.cjs "${ARGS[@]}"` — the only `node`
        // invocation in this step's script — without needing a real repo,
        // Firestore credentials, or a real version bump.
        fs.writeFileSync(path.join(dir, 'node'),
            '#!/usr/bin/env bash\n'
            + 'echo "[release] fake release.cjs invoked with: $*"\n'
            + `exit ${fakeExitCode}\n`,
            { mode: 0o755 });
        // `git pull --rebase --autostash origin "$GITHUB_REF_NAME"` — a real
        // git call would need a real repo and a real remote; this step's
        // logic under test starts after that line runs, so it only needs to
        // succeed, not do anything.
        fs.writeFileSync(path.join(dir, 'git'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
        const summaryFile = path.join(dir, 'summary.md');
        fs.writeFileSync(summaryFile, '');
        const script = path.join(dir, 'step.sh');
        fs.writeFileSync(script, stepScript('Release'));
        const stdout = execFileSync('bash', [script], {
            encoding: 'utf8',
            env: {
                PATH: `${dir}:${process.env.PATH}`,
                EVENT: 'schedule',
                GITHUB_REF_NAME: 'main',
                GITHUB_STEP_SUMMARY: summaryFile,
                IN_VERSION: '', IN_BUMP: '', IN_URGENT: '', IN_NOTE: '',
            },
        });
        return { code: 0, stdout, summary: fs.readFileSync(summaryFile, 'utf8') };
    } catch (e) {
        let summary = '';
        try { summary = fs.readFileSync(summaryFile, 'utf8'); } catch (_) { /* never written */ }
        return { code: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}`, summary };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('release.cjs exit 2 ("nothing to do") no longer fails the workflow', () => {
    it('THE EXACT CASE FROM THE SCREENSHOT: awaiting-approval (exit 2) is a clean, green no-op', () => {
        const r = runReleaseStep({ fakeExitCode: 2 });
        expect(r.code, 'exit 2 — release.cjs\'s own documented "nothing to do" — still fails the step').toBe(0);
        expect(r.stdout).toMatch(/declined to ship/);
        expect(r.stdout).not.toMatch(/::error::/);
    });

    it('records WHY in the job summary, so a human glancing at the run sees "skipped", not "broken"', () => {
        const r = runReleaseStep({ fakeExitCode: 2 });
        expect(r.summary).toMatch(/Release skipped \(not a failure\)/);
    });

    it('a real hard error (exit 1) still fails the step loudly', () => {
        const r = runReleaseStep({ fakeExitCode: 1 });
        expect(r.code, 'a genuine release.cjs failure must still turn the step red').not.toBe(0);
        expect(r.stdout).toMatch(/::error::release\.cjs failed \(exit 1\)/);
    });

    it('an unexpected exit code is treated as a failure too — only 0 and 2 are known-good', () => {
        const r = runReleaseStep({ fakeExitCode: 17 });
        expect(r.code).not.toBe(0);
        expect(r.stdout).toMatch(/::error::release\.cjs failed \(exit 17\)/);
    });

    it('a real success (exit 0) still succeeds, and is not misreported as a skip', () => {
        const r = runReleaseStep({ fakeExitCode: 0 });
        expect(r.code).toBe(0);
        expect(r.stdout).not.toMatch(/declined to ship/);
        expect(r.summary).not.toMatch(/Release skipped/);
    });
});

describe('release.cjs\'s own documented contract is what this relies on', () => {
    const RELEASE = fs.readFileSync(path.join(ROOT, 'release.cjs'), 'utf8');

    it('exit 2 is documented as "nothing-to-do (skipped)", not an error', () => {
        expect(RELEASE).toMatch(/EXIT:\s*0 ok\s*·\s*2 nothing-to-do \(skipped\)\s*·\s*1 hard error/);
    });

    it('the awaiting-approval path in release.cjs really does exit 2, matching the workflow\'s assumption', () => {
        const i = RELEASE.indexOf('approval.approved');
        expect(i, 'the approval-gate branch moved — retarget this test').toBeGreaterThan(-1);
        expect(RELEASE.slice(i, i + 200)).toMatch(/process\.exit\(2\)/);
    });
});
