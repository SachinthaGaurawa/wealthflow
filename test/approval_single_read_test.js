/* =============================================================================
 * test/approval_single_read_test.js — one question, asked once
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * The approval step published two things about the same pull request:
 *
 *     has_human_approval   does `human-approved` gate this merge?
 *     labels_json          the whole label list, for `full-gate` and friends
 *
 * and it got them from TWO separate calls to repos/:repo/issues/:pr/labels.
 * Two requests are two moments, and two moments can disagree.
 *
 * On #134 they did, 1.4 seconds apart, in the gate's own log:
 *
 *     08:42:53  labels currently on the PR: <none>      -> has_human_approval=false
 *     08:42:55  LABELS: ["human-approved"]
 *
 * The owner had removed and re-applied the label — the documented way to
 * re-approve a head that has moved — and the two reads landed either side of
 * the re-apply. The gate refused a correctly-labelled PR and asked again.
 *
 * WHY IT STILL MATTERS EVEN THOUGH IT FAILS CLOSED
 *
 * Nothing unsafe shipped: the missing label blocks, it never admits. The cost
 * lands on the person instead. This gate exists so that approval is asked for
 * ONCE and a batch of work is approved in one decision; a race that spuriously
 * re-asks is the same defect as a gate that nags, which is the complaint the
 * batching design was built to answer.
 *
 * HOW THIS IS TESTED
 *
 * Not by grepping for one `gh api` line — a second read could be added in a
 * shape the regex does not match, and the test would stay green through
 * exactly the regression it names. Instead the real shell is lifted out of the
 * YAML and RUN, against a fake `gh` whose answer CHANGES between calls. Code
 * that reads once cannot disagree with itself no matter what the second answer
 * would have been; code that reads twice reports one thing and publishes the
 * other. The old implementation fails the first test in this file.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/wealthflow-ci.yml'), 'utf8');

const STEP = 'Check for human approval (live, not from the event payload)';

/* Deliberately a local copy rather than an import from another test file:
 * each of these workflow tests stands alone, so deleting one cannot quietly
 * disarm another. Same extraction as test/approval_freshness_test.js. */
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
 * Run the approval step with a fake `gh` first on PATH.
 *
 * `answers` is the sequence of label lists the /labels endpoint returns, one
 * per call. Passing more than one is the whole point: it simulates the list
 * changing underneath a step that asks twice.
 *
 * `pr` of null is workflow_dispatch — no pull request to query at all.
 */
function runApproval({ answers = [['human-approved']], pr = '134', payloadHas = 'false', fails = false }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-approval-'));
    try {
        const log = path.join(dir, 'calls.log');
        const seq = path.join(dir, 'seq');
        // The stub answers /labels from `answers`, advancing one step per call
        // and sticking on the last entry, and mirrors gh's own `--jq` output:
        // line 1 the JSON array, line 2 the comma list (absent when empty,
        // because `join(",")` on [] prints a blank line that command
        // substitution then strips).
        const cases = answers.map((names, i) => {
            const json = JSON.stringify(names);
            const csv = names.join(',');
            return `    ${i + 1}) printf '%s\\n' '${json}'; ${csv ? `printf '%s\\n' '${csv}'` : ':'} ;;`;
        }).join('\n');
        const lastJson = JSON.stringify(answers[answers.length - 1] ?? []);
        const lastCsv = (answers[answers.length - 1] ?? []).join(',');
        const gh = '#!/usr/bin/env bash\n'
            + `echo "$*" >> ${JSON.stringify(log)}\n`
            + 'case "$*" in\n'
            + '  *"/labels"*)\n'
            + (fails ? '    exit 1\n' : '')
            + `    N=$(( $(cat ${JSON.stringify(seq)} 2>/dev/null || echo 0) + 1 )); echo "$N" > ${JSON.stringify(seq)}\n`
            + '    case "$N" in\n'
            + cases + '\n'
            + `    *) printf '%s\\n' '${lastJson}'; ${lastCsv ? `printf '%s\\n' '${lastCsv}'` : ':'} ;;\n`
            + '    esac ;;\n'
            + '  *"/timeline"*) printf \'%s\\n\' "2026-08-26T08:42:53Z" ;;\n'
            + 'esac\n';
        fs.writeFileSync(path.join(dir, 'gh'), gh, { mode: 0o755 });

        const script = path.join(dir, 'step.sh');
        fs.writeFileSync(script, stepScript(STEP));
        const outFile = path.join(dir, 'github_output');
        fs.writeFileSync(outFile, '');

        const env = {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            REPO: 'owner/repo',
            GH_TOKEN: 'x',
            PAYLOAD_HAS: payloadHas,
            GITHUB_OUTPUT: outFile,
        };
        // workflow_dispatch: the variable is genuinely absent, not empty-string.
        if (pr === null) delete env.PR; else env.PR = pr;

        let stdout = '';
        try {
            stdout = execFileSync('bash', [script], { encoding: 'utf8', env });
        } catch (e) {
            stdout = `${e.stdout || ''}${e.stderr || ''}`;
        }

        const outputs = {};
        for (const line of fs.readFileSync(outFile, 'utf8').split('\n')) {
            const m = /^([a-z_]+)=(.*)$/.exec(line);
            if (m) outputs[m[1]] = m[2];
        }
        const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
        return {
            stdout,
            outputs,
            labelRequests: calls.filter((c) => c.includes('/labels')).length,
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** Does labels_json, read on its own terms, say this PR is approved? */
const jsonSaysApproved = (o) => JSON.parse(o.labels_json ?? '[]').includes('human-approved');

describe('the two answers come from one question', () => {
    it('cannot disagree with itself when the label changes mid-step', () => {
        /* THE #134 REGRESSION, AS A TEST.
         *
         * First read sees no labels, second read sees the label — the exact
         * remove-then-re-add window. A step that reads once picks one of these
         * and both of its outputs describe it. A step that reads twice reports
         * has_human_approval=false while publishing labels_json=["human-approved"],
         * and the PR is refused for a label that is demonstrably on it. */
        const r = runApproval({ answers: [[], ['human-approved']] });
        expect(r.outputs.has_human_approval, 'has_human_approval was not published').toBeDefined();
        expect(String(r.outputs.has_human_approval) === 'true', 'has_human_approval and labels_json '
            + 'describe the same pull request at different moments — the step read the label list twice')
            .toBe(jsonSaysApproved(r.outputs));
    });

    it('asks the labels endpoint exactly once', () => {
        // The property directly, so a future refactor that happens to keep the
        // two reads consistent by luck still gets caught.
        const r = runApproval({ answers: [['human-approved']] });
        expect(r.labelRequests, 'the labels endpoint is queried more than once, so its answers '
            + 'can drift apart between calls').toBe(1);
    });

    it('holds even when the label goes the other way (added, then removed)', () => {
        const r = runApproval({ answers: [['human-approved'], []] });
        expect(String(r.outputs.has_human_approval) === 'true').toBe(jsonSaysApproved(r.outputs));
    });
});

describe('what each answer says', () => {
    it('approves when the label is on', () => {
        const r = runApproval({ answers: [['human-approved']] });
        expect(r.outputs.has_human_approval).toBe('true');
        expect(r.outputs.labels_json).toBe('["human-approved"]');
        expect(r.outputs.labeled_at, 'the freshness check downstream has no timestamp to work with')
            .toBe('2026-08-26T08:42:53Z');
    });

    it('refuses when it is not', () => {
        const r = runApproval({ answers: [[]] });
        expect(r.outputs.has_human_approval).toBe('false');
        expect(r.outputs.labels_json).toBe('[]');
    });

    it('is not fooled by a different label', () => {
        const r = runApproval({ answers: [['auto-safe', 'human-approved-please']] });
        expect(r.outputs.has_human_approval, 'a label merely CONTAINING the approval name was '
            + 'treated as the approval itself').toBe('false');
    });

    it('carries full-gate through on the same answer', () => {
        // The kill switch reads labels_json. It has to see the label from the
        // very same response that decided approval, or it can fail to engage.
        const r = runApproval({ answers: [['full-gate', 'human-approved']] });
        expect(JSON.parse(r.outputs.labels_json)).toContain('full-gate');
        expect(r.outputs.has_human_approval).toBe('true');
    });
});

describe('it still fails closed', () => {
    it('treats an unreadable label list as NOT approved', () => {
        const r = runApproval({ answers: [['human-approved']], fails: true });
        expect(r.outputs.has_human_approval, 'an API failure left the PR looking approved').toBe('false');
        expect(r.outputs.labels_json, 'an API failure published a non-empty label list').toBe('[]');
    });

    it('does not publish a timestamp it could not read', () => {
        const r = runApproval({ answers: [[]] });
        expect(r.outputs.labeled_at, 'a timestamp was published for an approval that is not there')
            .toBe('');
    });

    it('never queries the PR endpoint on workflow_dispatch', () => {
        // No pull request exists, so there is no label to read; the payload
        // expression is the only signal, and it must not reach the API at all.
        const r = runApproval({ answers: [['human-approved']], pr: null, payloadHas: 'false' });
        expect(r.labelRequests).toBe(0);
        expect(r.outputs.has_human_approval).toBe('false');
        expect(r.outputs.labels_json).toBe('[]');
    });
});
