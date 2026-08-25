/* =============================================================================
 * test/approval_freshness_test.js — an approval that covers code it never saw
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * `human-approved` is a LABEL, and a label belongs to the pull request, not to
 * a commit. The risk gate read it live from the API — correctly, and failing
 * closed, which earlier work in this repo went to some trouble to get right —
 * but it never asked WHEN it was granted. Once the label is on, it stays on
 * through every later push, so one approval silently covers every diff that
 * follows it.
 *
 * This is not a hypothetical. On PR #127 the label was applied at 12:03:29.
 * Two commits after it changed index.html and autonomy/perf-budget.mjs, and
 * the gate's own log on that head reads:
 *
 *     env: HAS_HUMAN_APPROVAL: true
 *     ##[group]Sensitive paths touched
 *     autonomy/perf-budget.mjs
 *     index.html
 *     ##[endgroup]
 *     ✓ Sensitive change is carrying the 'human-approved' label — allowed.
 *
 * Two guardrail files passed the gate on an approval given before either
 * change existed. Same family as the rest of this pipeline's history: a
 * control that is present, reports cleanly, and does not hold.
 *
 * WHAT THE FIX MUST NOT DO
 *
 * The obvious fix is to strip the label on every push. That closes the hole and
 * replaces it with a worse one for the person using it: a fresh approval demanded
 * after every single commit, which makes batching work and taking one decision on
 * it impossible. So the gate asks a narrower question — did any SENSITIVE file
 * change after the label went on? A batch of commits followed by one labelling is
 * approved. A sensitive commit after the labelling is not.
 *
 * Every case below runs the real shell extracted from the YAML, against a fake
 * `gh` on PATH. Reimplementing the logic here would let the model stay green
 * while the workflow drifts.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/wealthflow-ci.yml'), 'utf8');

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

/**
 * Run the freshness step with a fake `gh` first on PATH.
 *
 * `ghCounts` maps a file path to the number of commits the API should report
 * as touching it since the approval. `ghFails` makes the call exit non-zero,
 * which is the case the gate has to treat as "unapproved" rather than "fine".
 */
function runFreshness({ labeledAt = '2026-08-25T12:03:29Z', files = [], ghCounts = {}, ghFails = false, ghGarbage = false }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-fresh-'));
    try {
        const gh = ghFails
            ? '#!/usr/bin/env bash\nexit 1\n'
            : ghGarbage
                ? '#!/usr/bin/env bash\necho "not-a-number"\n'
                : '#!/usr/bin/env bash\n'
                + 'p=""; for a in "$@"; do case "$a" in path=*) p="${a#path=}";; esac; done\n'
                + 'case "$p" in\n'
                + Object.entries(ghCounts).map(([f, n]) => `  ${f}) echo ${n} ;;`).join('\n')
                + (Object.keys(ghCounts).length ? '\n' : '')
                + '  *) echo 0 ;;\nesac\n';
        fs.writeFileSync(path.join(dir, 'gh'), gh, { mode: 0o755 });
        const script = path.join(dir, 'step.sh');
        fs.writeFileSync(script, stepScript('Refuse an approval that predates the sensitive change'));
        const stdout = execFileSync('bash', [script], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${dir}:${process.env.PATH}`,
                REPO: 'owner/repo',
                HEAD_SHA: 'deadbeef',
                LABELED_AT: labeledAt,
                SENSITIVE_FILES: files.join('\n'),
                GH_TOKEN: 'x',
            },
        });
        return { code: 0, stdout };
    } catch (e) {
        return { code: e.status ?? 1, stdout: `${e.stdout || ''}${e.stderr || ''}` };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('a label cannot approve a commit that came after it', () => {
    it('blocks the exact case that got through on PR #127', () => {
        // index.html and autonomy/perf-budget.mjs both moved after the label.
        const r = runFreshness({
            files: ['autonomy/perf-budget.mjs', 'index.html'],
            ghCounts: { 'autonomy/perf-budget.mjs': 1, 'index.html': 2 },
        });
        expect(r.code, 'a sensitive file changed after the approval and the gate still passed')
            .not.toBe(0);
        expect(r.stdout).toMatch(/index\.html/);
        expect(r.stdout).toMatch(/changed after 'human-approved' was applied/);
    });

    it('names every stale file, not just the first one it finds', () => {
        const r = runFreshness({
            files: ['index.html', 'sw.js', 'policy/wealthflow.rego'],
            ghCounts: { 'index.html': 1, 'policy/wealthflow.rego': 1 },
        });
        expect(r.stdout).toMatch(/index\.html/);
        expect(r.stdout, 'the reviewer is told about one stale file and left to discover the rest')
            .toMatch(/policy\/wealthflow\.rego/);
    });

    it('passes a batch of commits followed by ONE labelling', () => {
        // The whole point: work is batched and approved once. Nothing moved
        // after the label, so the label covers the head.
        const r = runFreshness({
            files: ['index.html', 'autonomy/perf-budget.mjs'],
            ghCounts: {},
        });
        expect(r.code, 'an approval that genuinely covers the head was rejected — this would '
            + 'force a re-approval after every single commit').toBe(0);
        expect(r.stdout).toMatch(/predates the approval|covers this head/);
    });

    it('blocks when one file of several is stale', () => {
        const r = runFreshness({
            files: ['index.html', 'package.json'],
            ghCounts: { 'package.json': 1 },
        });
        expect(r.code).not.toBe(0);
        expect(r.stdout).toMatch(/package\.json/);
    });
});

describe('it fails closed, like the label read it sits next to', () => {
    it('refuses when the approval has no timestamp', () => {
        const r = runFreshness({ labeledAt: '', files: ['index.html'] });
        expect(r.code, 'with no timestamp there is no way to tell whether the label predates '
            + 'the change, and the gate let it through').not.toBe(0);
        expect(r.stdout).toMatch(/timestamp could not be read/);
    });

    it('refuses when the commit lookup errors', () => {
        const r = runFreshness({ files: ['index.html'], ghFails: true });
        expect(r.code, 'an API failure was read as "nothing changed after the approval"')
            .not.toBe(0);
        expect(r.stdout).toMatch(/Could not check whether/);
    });

    it('refuses when the commit count is not a number', () => {
        // `[ "$N" -gt 0 ]` on a non-numeric N is a bash error, and under
        // `set -uo pipefail` without -e that does NOT stop the script — the loop
        // carries on and the file is treated as clean.
        const r = runFreshness({ files: ['index.html'], ghGarbage: true });
        expect(r.code, 'a garbage response was treated as "no commits since the approval"')
            .not.toBe(0);
        expect(r.stdout).toMatch(/Unreadable commit count/);
    });

    it('does not trip over a blank line in the file list', () => {
        const r = runFreshness({ files: ['index.html', '', 'sw.js'], ghCounts: {} });
        expect(r.code).toBe(0);
    });
});

describe('the workflow is wired the way these tests assume', () => {
    it('records when the label went on, from the timeline', () => {
        expect(WF, 'the approval step no longer publishes a timestamp, so the freshness step '
            + 'has nothing to compare against and fails closed on every run')
            .toMatch(/labeled_at=\$LAT/);
        expect(WF, 'the timestamp is read from somewhere other than the timeline — the label '
            + 'list itself carries no time').toMatch(/issues\/\$PR\/timeline/);
        expect(WF, 'it must take the LAST labelling, not the first: removing and re-applying '
            + 'the label is how a reviewer approves a new head').toMatch(/\|\s*last\s*\/\//);
    });

    it('runs only when the change is sensitive AND carries the label', () => {
        const at = WF.indexOf('- name: Refuse an approval that predates the sensitive change');
        expect(at).toBeGreaterThan(-1);
        const head = WF.slice(at, at + 400);
        expect(head).toMatch(/steps\.classify\.outputs\.sensitive == 'yes'/);
        expect(head).toMatch(/steps\.approval\.outputs\.has_human_approval == 'true'/);
    });

    it('the classify step publishes what the freshness step consumes', () => {
        expect(WF).toMatch(/- name: Classify changed files\n\s+id: classify/);
        expect(WF).toMatch(/echo "sensitive=yes"/);
        expect(WF).toMatch(/sensitive_files<<WF_EOF/);
        expect(WF, 'the no-hits branch must publish sensitive=no, or the freshness step\'s '
            + 'condition reads an empty string and the step is skipped by accident rather '
            + 'than by decision').toMatch(/echo "sensitive=no"/);
    });

    it('the original enforcement is still there underneath it', () => {
        expect(WF).toMatch(/SENSITIVE_REGEX='\^\(/);
        expect(WF).toMatch(/must be reviewed and labelled 'human-approved'/);
    });
});
