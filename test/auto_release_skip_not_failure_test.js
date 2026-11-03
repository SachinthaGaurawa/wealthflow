/* =============================================================================
 * UPDATE 2026-11-03 — THIS FILE ONCE ENSHRINED THE STALL.
 *   It asserted that "awaiting approval" (exit 2) is a clean green no-op. That
 *   made sense for ONE red X on a screenshot, but combined with a human tap that
 *   nobody gave it hid a release chain that shipped nothing for weeks: 86 real
 *   commits sat un-announced behind a green tick. The workflow now earns approval
 *   from gates (tests on the exact commit + production health + a substantive
 *   change) and passes --auto-approve, so exit 2 can only mean "the gates passed
 *   and release.cjs still refused": that is an anomaly and must turn the run red
 *   (through the later "Fail loudly" step), never read as "not a failure".
 *
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
function runReleaseStep({ fakeExitCode = 0, tested = '', head = '' } = {}) {
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
        // `git rev-parse [--short] HEAD` answers with `head` (when given); everything else is a no-op.
        fs.writeFileSync(path.join(dir, 'git'),
            '#!/usr/bin/env bash\n'
            + `if [ "$1" = "rev-parse" ]; then echo "${head}"; fi\n`
            + 'exit 0\n',
            { mode: 0o755 });
        const summaryFile = path.join(dir, 'summary.md');
        fs.writeFileSync(summaryFile, '');
        const outFile = path.join(dir, 'output.txt');
        fs.writeFileSync(outFile, '');
        const script = path.join(dir, 'step.sh');
        fs.writeFileSync(script, stepScript('Release'));
        const stdout = execFileSync('bash', [script], {
            encoding: 'utf8',
            env: {
                PATH: `${dir}:${process.env.PATH}`,
                EVENT: 'schedule',
                GITHUB_REF_NAME: 'main',
                GITHUB_STEP_SUMMARY: summaryFile,
                GITHUB_OUTPUT: outFile,
                IN_VERSION: '', IN_BUMP: '', IN_URGENT: '', IN_NOTE: '',
                TESTED: tested,
            },
        });
        return { code: 0, stdout, summary: fs.readFileSync(summaryFile, 'utf8'), output: fs.readFileSync(outFile, 'utf8') };
    } catch (e) {
        let summary = '', output = '';
        try { summary = fs.readFileSync(summaryFile, 'utf8'); } catch (_) { /* never written */ }
        try { output = fs.readFileSync(outFile, 'utf8'); } catch (_) { /* never written */ }
        return { code: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}`, summary, output };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('release.cjs exit 2 after the gates passed is an ANOMALY, not a green no-op', () => {
    it('the step itself still exits 0 (so its outputs are written) but flags declined=yes and warns', () => {
        const r = runReleaseStep({ fakeExitCode: 2 });
        expect(r.code).toBe(0);
        expect(r.output).toMatch(/declined=yes/);
        expect(r.stdout).toMatch(/::warning::release\.cjs declined to ship/);
    });

    it('records the decline in the job summary as something that needs a look, never "not a failure"', () => {
        const r = runReleaseStep({ fakeExitCode: 2 });
        expect(r.summary).toMatch(/Release DECLINED/);
        expect(r.summary).not.toMatch(/not a failure/i);
    });

    it('a LATER step turns the run red when the release declined', () => {
        const at = WF.indexOf('- name: Fail loudly if the gates approved but the release declined');
        expect(at).toBeGreaterThan(-1);
        const block = WF.slice(at, at + 600);
        expect(block).toMatch(/steps\.release\.outputs\.declined == 'yes'/);
        expect(block).toMatch(/exit 1/);
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
        expect(r.summary).not.toMatch(/Release DECLINED/);
        expect(r.output).not.toMatch(/declined=yes/);
    });
});

describe('release.cjs\'s own documented contract is what this relies on', () => {
    const RELEASE = fs.readFileSync(path.join(ROOT, 'release.cjs'), 'utf8');

    it('exit 2 is documented as "nothing-to-do (skipped)", not an error', () => {
        expect(RELEASE).toMatch(/EXIT:\s*0 ok\s*·\s*2 nothing-to-do \(skipped\)\s*·\s*1 hard error/);
    });

    it('the awaiting-approval path really does exit 2 (now decided by autonomy/release-approval.cjs)', () => {
        const APPROVAL = fs.readFileSync(path.join(ROOT, 'autonomy/release-approval.cjs'), 'utf8');
        expect(APPROVAL).toMatch(/awaits approval[\s\S]{0,80}exit: 2|exit: 2[\s\S]{0,200}awaits approval/);
        expect(RELEASE).toMatch(/process\.exit\(d\.exit \|\| 2\)/);
    });
});


describe('the approval belongs to the commit the tests ran on (Codex review on #493)', () => {
    it('if main moved after the tests, the Release step stands down and runs nothing', () => {
        const r = runReleaseStep({ fakeExitCode: 0, tested: 'aaaaaaaa1111', head: 'bbbbbbbb2222' });
        expect(r.code).toBe(0);                                   // a deliberate no-op, not a failure
        expect(r.output).toMatch(/moved=yes/);
        expect(r.stdout).toMatch(/not releasing code the gates have not seen/);
        expect(r.stdout).not.toMatch(/fake release\.cjs invoked/);   // release.cjs was never run
        expect(r.summary).toMatch(/Release deferred/);
    });

    it('if main did not move, the release goes ahead as before', () => {
        const r = runReleaseStep({ fakeExitCode: 0, tested: 'aaaaaaaa1111', head: 'aaaaaaaa1111' });
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/fake release\.cjs invoked/);
        expect(r.output).not.toMatch(/moved=yes/);
    });

    it('the tag and live-confirmation steps are skipped when the release stood down', () => {
        const tag = WF.slice(WF.indexOf('- name: Tag the release'), WF.indexOf('- name: Confirm the new version is LIVE'));
        const confirm = WF.slice(WF.indexOf('- name: Confirm the new version is LIVE'), WF.indexOf('- name: Fail loudly if the gates approved'));
        expect(tag).toMatch(/steps\.release\.outputs\.moved != 'yes'/);
        expect(confirm).toMatch(/steps\.release\.outputs\.moved != 'yes'/);
    });
});

describe('a blocked gate is a red run with its own issue label', () => {
    it('a final step fails the run when the gates blocked the release', () => {
        const at = WF.indexOf('- name: Fail loudly if a gate blocked the release');
        expect(at).toBeGreaterThan(-1);
        const block = WF.slice(at);
        expect(block).toMatch(/if: steps\.gates\.outputs\.ok == 'no'/);
        expect(block).toMatch(/exit 1/);
    });

    it('release-blocker issues use release-blocked + ai-stuck, never the shared pipeline-health label', () => {
        const code = WF.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
        expect(code).not.toMatch(/--label pipeline-health/);
        expect(code).toMatch(/--label release-blocked --label ai-stuck/);
    });
});

describe('the live-confirmation loop fits inside the job timeout', () => {
    it('is bounded by the clock, and install + suite + release + that window + one slow lap fit in timeout-minutes', () => {
        const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(WF)[1]);
        const window = Number(/DEADLINE=\$\(\(SECONDS \+ (\d+)\)\)/.exec(WF)[1]) / 60;
        expect(WF).toMatch(/while \[ "\$SECONDS" -lt "\$DEADLINE" \]/);
        expect(WF).not.toMatch(/seq 1 \d+/);                          // no iteration count to multiply by a slow network
        const slowLap = (20 + 15 + 15 + 20) / 60;                      // sleep + the three curl --max-time ceilings
        expect(timeout).toBeGreaterThan(10 + window + slowLap);        // 10 min for install, tests and the release itself
    });
});
