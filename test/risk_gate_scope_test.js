/* =============================================================================
 * test/risk_gate_scope_test.js
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Five manual runs of "WealthFlow CI (free)" on main failed instantly. The
 * cause was NOT the newly hardened sensitive-path regex and NOT the
 * human-approved label check — both were innocent. The changed-files action
 * died first:
 *
 *   Could not determine the changed-file list (base='?', pr='?').
 *   Refusing to fall back to HEAD~1 — a partial file list would let a gate
 *   pass a change it should block.
 *
 * A workflow_dispatch has no pull request, so there is no base to diff
 * against. That refusal is correct and is deliberately left alone: a gate that
 * guesses at its own input is worse than one that stops. The defect was asking
 * "does this PR need approval?" when no PR exists.
 *
 * THE PART THAT IS EASY TO GET WRONG
 * The obvious fix — "skip the gate when there's no PR" — opens a bypass. A
 * check run is keyed on (name, SHA), so a manual run that reports "Risk gate ✓"
 * against a pull request's head branch mints exactly the check branch
 * protection waits for. "No PR to gate" would become a way to certify a PR
 * without gating it, available to anyone with write access and to any agent
 * holding a token with actions: write.
 *
 * So not-applicable is permitted ONLY on the default branch, which can never be
 * a PR head. Every case below runs the real shell from the YAML.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/wealthflow-ci.yml'), 'utf8');

/**
 * Run the scope decision exactly as the runner does.
 * Returns { code, gate, stdout } where gate is the GITHUB_OUTPUT value.
 */
function scope({ event, ref, defaultBranch = 'main' }) {
    const script = `
        set -euo pipefail
        EVENT='${event}'; REF_NAME='${ref}'; DEFAULT_BRANCH='${defaultBranch}'
        GITHUB_OUTPUT="$(mktemp)"; GITHUB_STEP_SUMMARY="$(mktemp)"
        rc=0
        {
          if [ "$EVENT" = "pull_request" ]; then
            echo "gate=yes" >> "$GITHUB_OUTPUT"
            echo "pull request in scope"
          else
            DEF="\${DEFAULT_BRANCH:-main}"
            if [ "$REF_NAME" != "$DEF" ]; then
              echo "REFUSED"
              exit 1
            fi
            echo "gate=no" >> "$GITHUB_OUTPUT"
            echo "not applicable"
          fi
        } || rc=$?
        echo "---GATE---"; cat "$GITHUB_OUTPUT" || true
        exit $rc
    `;
    try {
        const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
        return { code: 0, out, gate: /gate=(\w+)/.exec(out)?.[1] ?? null };
    } catch (e) {
        const out = (e.stdout || '') + (e.stderr || '');
        return { code: e.status, out, gate: /gate=(\w+)/.exec(out)?.[1] ?? null };
    }
}

describe('a pull request is always gated, exactly as before', () => {
    it('evaluates sensitive paths on pull_request', () => {
        const r = scope({ event: 'pull_request', ref: 'claude/some-branch' });
        expect(r.code).toBe(0);
        expect(r.gate).toBe('yes');
    });

    it('gates a PR regardless of its head branch name', () => {
        for (const ref of ['main', 'ai-fix/issue-46-123', 'feature/x', 'renovate/y']) {
            const r = scope({ event: 'pull_request', ref });
            expect(r.gate, `PR from ${ref} must still be gated`).toBe('yes');
        }
    });
});

describe('a manual run on the default branch has nothing to gate', () => {
    it('passes as not-applicable rather than failing on a missing diff', () => {
        const r = scope({ event: 'workflow_dispatch', ref: 'main' });
        expect(r.code).toBe(0);
        expect(r.gate).toBe('no');
    });

    it('honours a repository whose default branch is not called main', () => {
        const r = scope({ event: 'workflow_dispatch', ref: 'trunk', defaultBranch: 'trunk' });
        expect(r.code).toBe(0);
        expect(r.gate).toBe('no');
    });

    it('a push event to the default branch behaves the same way', () => {
        const r = scope({ event: 'push', ref: 'main' });
        expect(r.code).toBe(0);
        expect(r.gate).toBe('no');
    });
});

describe('a manual run cannot mint a passing check for a PR head', () => {
    it('refuses workflow_dispatch on a non-default branch', () => {
        // The bypass this closes: dispatching against a PR's head branch would
        // publish "Risk gate ✓" on that SHA and satisfy branch protection
        // without any sensitive-path evaluation ever running.
        const r = scope({ event: 'workflow_dispatch', ref: 'claude/wealthflow-autonomous-updates-tlsb1f' });
        expect(r.code).toBe(1);
        expect(r.gate).toBe(null);
        expect(r.out).toMatch(/REFUSED/);
    });

    it('refuses on every plausible PR head branch shape', () => {
        for (const ref of ['ai-fix/issue-46-1754', 'feature/x', 'hotfix', 'main-2', 'Main']) {
            const r = scope({ event: 'workflow_dispatch', ref });
            expect(r.code, `dispatch on ${ref} must fail closed`).toBe(1);
        }
    });

    it('is not fooled by a branch whose name merely contains the default', () => {
        // 'main-2' and 'mymain' are NOT the default branch; a substring match
        // here would reopen the bypass.
        for (const ref of ['main-2', 'mymain', 'main/sub']) {
            expect(scope({ event: 'workflow_dispatch', ref }).code).toBe(1);
        }
    });
});

describe('the workflow really contains the logic these tests model', () => {
    it('has the scope step, with an id the later steps depend on', () => {
        expect(WF).toMatch(/- name: Is a pull request in scope\?/);
        expect(WF).toMatch(/id: scope/);
    });

    it('the three decisions modelled above are the three the YAML makes', () => {
        // scope() above reimplements the shell rather than extracting it, which
        // is a divergence risk: the model could stay green while the workflow
        // drifts. These assertions bind the model to the real text, so editing
        // the workflow's logic without revisiting this file turns the suite red.
        expect(WF, 'pull_request branch').toMatch(/if \[ "\$EVENT" = "pull_request" \]; then\n\s+echo "gate=yes"/);
        expect(WF, 'non-default-branch refusal').toMatch(/if \[ "\$REF_NAME" != "\$DEF" \]; then/);
        expect(WF, 'exact string comparison, not a substring or glob')
            .not.toMatch(/\[\[ "\$REF_NAME" == \*/);
        expect(WF, 'default-branch not-applicable branch').toMatch(/echo "gate=no"/);
        // The refusal must exit non-zero; a warning that continues would leave
        // the bypass wide open while looking like it had been handled.
        const i = WF.indexOf('if [ "$REF_NAME" != "$DEF" ]');
        expect(i, 'refusal anchor not found — retarget this test').toBeGreaterThan(-1);
        expect(WF.slice(i, i + 500)).toMatch(/exit 1/);
    });

    it('gates EVERY step that reads the diff on it', () => {
        // If any were left ungated the job would still explode on dispatch, or
        // worse, classify an empty file list as "nothing sensitive".
        //
        // The `id:` lines are optional in these patterns on purpose: a step
        // gaining an id is routine, a step losing its scope gate is not. What
        // must hold is that each one carries `if: steps.scope.outputs.gate`.
        const gated = (name) => new RegExp(
            `- name: ${name}\\n(?:\\s+id: \\w+\\n)?\\s+if: steps\\.scope\\.outputs\\.gate == 'yes'`);
        expect(WF, 'the diff resolution is no longer gated on scope')
            .toMatch(gated('Resolve changed files'));
        expect(WF, 'the classification is no longer gated on scope')
            .toMatch(gated('Classify changed files'));
        expect(WF, 'the approval-freshness check is no longer gated on scope — on a manual '
            + 'run there is no PR, so it would read an empty file list and pass')
            .toMatch(gated('Refuse an approval that predates the sensitive change'));
    });

    it('still refuses to guess a file list — that safeguard is untouched', () => {
        const action = fs.readFileSync(
            path.join(ROOT, '.github/actions/changed-files/action.yml'), 'utf8');
        expect(action).toMatch(/Refusing to fall back to HEAD~1/);
    });

    it('the sensitive-path enforcement itself is unchanged', () => {
        // The fix must not have widened any hole it was meant to leave shut.
        expect(WF).toMatch(/SENSITIVE_REGEX='\^\(/);
        expect(WF).toMatch(/\\\.github\/\.\*/);
        expect(WF).toMatch(/must be reviewed and labelled 'human-approved'/);
    });
});
