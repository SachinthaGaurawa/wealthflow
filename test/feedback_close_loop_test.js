/* =============================================================================
 * test/feedback_close_loop_test.js
 * -----------------------------------------------------------------------------
 * THE BLIND SPOT THIS PINS
 *
 * The owner's feedback becomes a GitHub issue automatically, and the app polls
 * /api/feedback-status to show it as Completed. Both halves worked. But nothing
 * ever CLOSED the issue when its fix shipped, and the app decides Completed from
 * issue STATE — so a fix that was live on his phone still showed as pending.
 * Issue #46 sat "open" for nine days after PR #49 fixed it. The poller was
 * reading a signal nobody set.
 *
 * Two distinct failures, both fixed:
 *   · the PR path knew the issue number (it names the branch) and never put it
 *     in the PR body, so merging closed nothing;
 *   · the direct-ship path COMMENTED "Shipped" and left the issue open — which
 *     looks done to a human reading GitHub, but the app reads state, not prose.
 *
 * These tests EXECUTE the guard the runner will execute rather than grepping the
 * YAML for a string. A workflow assertion that only greps proves the file
 * contains some text; it cannot tell you the shell branch actually taken.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/autonomous-fix.yml'), 'utf8');

/**
 * Run the exact guard used in the workflow and report which branch was taken.
 * Mirrors the shell verbatim; if the workflow's guard is edited, the assertion
 * below that the workflow still CONTAINS this guard will fail and point here.
 */
function linkOutcome(issue) {
    const script = `
        ISSUE='${String(issue).replace(/'/g, "'\\''")}'
        : > body.txt
        if printf '%s' "\${ISSUE:-}" | grep -qE '^[0-9]+$'; then
            printf '\\n\\nCloses #%s\\n' "$ISSUE" >> body.txt
            echo "LINKED"
        else
            echo "SKIPPED"
        fi
        cat body.txt
    `;
    return execFileSync('bash', ['-c', script], { cwd: '/tmp', encoding: 'utf8' });
}

describe('a merged fix must close the feedback that asked for it', () => {
    it('writes Closes #N for a real issue number', () => {
        const out = linkOutcome('46');
        expect(out).toMatch(/LINKED/);
        // GitHub only auto-closes on this exact keyword form.
        expect(out).toMatch(/Closes #46/);
    });

    it('refuses anything that is not a bare number', () => {
        // The issue reference originates in the work queue and lands in markdown
        // GitHub then acts on. Non-numeric input must be refused, not pasted.
        for (const bad of ['', 'x', '46x', '4 6', '#46', '46; rm -rf /',
                           'Closes #1 and #2', '../../etc/passwd', '-1']) {
            const out = linkOutcome(bad);
            expect(out, `"${bad}" must not produce a close link`).toMatch(/SKIPPED/);
            expect(out).not.toMatch(/Closes #/);
        }
    });

    it('cannot be tricked into closing an unrelated issue', () => {
        const out = linkOutcome('46 #999');
        expect(out).toMatch(/SKIPPED/);
        expect(out).not.toMatch(/999/);
    });

    it('the workflow still contains the guard these tests model', () => {
        // Without this, the tests above could pass against a guard the workflow
        // no longer uses — a green suite describing code that is not running.
        expect(WF).toMatch(/grep -qE '\^\[0-9\]\+\$'/);
        expect(WF).toMatch(/printf '\\n\\nCloses #%s\\n' "\$ISSUE" >> pr-body\.txt/);
    });
});

describe('the direct-ship path closes rather than only commenting', () => {
    it('calls gh issue close with reason completed', () => {
        expect(WF).toMatch(/gh issue close "\$ISSUE" --reason completed/);
    });

    it('no longer leaves the issue open after shipping', () => {
        // The old line commented "Shipped" and stopped there. Assert the bare
        // comment-only form is gone, so the app's Completed flag actually flips.
        const i = WF.indexOf('Commit and ship directly');
        expect(i, 'direct-ship anchor not found — retarget this test').toBeGreaterThan(-1);
        const block = WF.slice(i);
        const closeAt = block.indexOf('gh issue close');
        expect(closeAt).toBeGreaterThan(-1);
        // A `gh issue comment` with no close beside it is the defect returning.
        const commentOnly = /gh issue comment "\$ISSUE"[^\n]*\n(?![^\n]*close)/.test(block.slice(0, closeAt));
        expect(commentOnly).toBe(false);
    });
});

describe('the app reads issue STATE, which is why closing is the fix', () => {
    it('feedback-status derives completed from state, not comment text', async () => {
        // Asserted against the real function, not the file's text: an earlier
        // draft of this test grepped for the absence of the word "Shipped" and
        // failed, because that word legitimately appears in a DIFFERENT function
        // (versionFromComments). Grepping a file cannot tell those apart.
        const { summarise } = await import('../feedback-status.js');
        expect(summarise({ number: 1, state: 'closed' }, []).completed).toBe(true);
        expect(summarise({ number: 1, state: 'open' }, []).completed).toBe(false);
        // A "Shipped" comment on an OPEN issue must not count as done — that is
        // exactly what the direct-ship path used to leave behind.
        const openWithShippedComment = summarise(
            { number: 1, state: 'open' },
            [{ body: '### ✅ Shipped in v7.70.0' }],
        );
        expect(openWithShippedComment.completed).toBe(false);
        // "not planned" is a close, but not a completion.
        expect(summarise({ number: 1, state: 'closed', state_reason: 'not_planned' }, []).completed).toBe(false);
    });

    it('shippedVersion needs a semver in the comment, which the old text lacked', async () => {
        const { versionFromComments } = await import('../feedback-status.js');
        // The exact old wording — keyword present, version absent.
        expect(versionFromComments([
            { body: 'This fix is live in the release just cut from `wealthflow-insights.js`.' },
        ])).toBe(null);
        // The new wording carries the version, so the field means something.
        expect(versionFromComments([
            { body: '### ✅ Shipped in v7.70.0\n\nThis fix is live in the release just cut from `x.js`.' },
        ])).toBe('7.70.0');
    });

    it('the workflow now puts a real version in that comment', () => {
        expect(WF).toMatch(/SHIPPED_V=\$\(node -p "require\('\.\/version\.json'\)\.latest"/);
        expect(WF).toMatch(/Shipped in v%s/);
    });
});
