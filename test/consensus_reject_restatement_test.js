/* =============================================================================
 * test/consensus_reject_restatement_test.js — a reviewer that reads the diff's
 * comments back to us has not found anything
 * -----------------------------------------------------------------------------
 * WHAT HAPPENED
 *
 * On PR #98 the security lane (mistral) returned, on two separate runs:
 *
 *     reason:   "The release-brain.js file could never succeed, and said so in
 *                the wrong words."
 *     evidence: "+    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;"
 *
 * That sentence is the FIRST LINE OF THE COMMENT the PR added, describing the
 * bug it was fixing. The reviewer summarised the diff's prose and returned it
 * as a finding — blocking the change that removed the defect it was quoting.
 *
 * consensus-review.mjs's prompt already contains a long "JUDGE THE CODE, NOT
 * THE COMMENTS" block, added the FIRST time this happened. The model ignored it
 * twice more. An instruction a reviewer can decline to follow is not a control,
 * so the rule moved out of the prompt and into code.
 *
 * WHY THE THRESHOLDS MATTER MORE THAN USUAL
 *
 * This is the one place in the repository that DISCARDS a security objection.
 * Everywhere else the rule is fail closed. So the bar is deliberately high: a
 * long verbatim run (>= REJECT_MIN_RUN consecutive words) that is also most of
 * the reason (>= REJECT_MIN_SHARE). A reviewer describing a real defect in its
 * own words is untouched even when it is discussing the same subject the
 * comments discuss — and the block below proves that with a real finding taken
 * from the same pull request.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    commentWordsOf, longestSharedRun, restatesComment,
    REJECT_MIN_RUN, REJECT_MIN_SHARE,
} from '../consensus-review.mjs';

/* The actual diff hunk from PR #98 that produced the false finding. */
const REAL_DIFF = `diff --git a/release-brain.js b/release-brain.js
--- a/release-brain.js
+++ b/release-brain.js
+/* THIS FUNCTION COULD NEVER SUCCEED, AND SAID SO IN THE WRONG WORDS.
+ *
+ * It was \`const admin = require('firebase-admin')\` inside a module that is ESM
+ * — package.json declares "type": "module" and this file's only export is
+ * \`export default\`. \`require\` is simply not defined in ESM scope, so the very
+ * first statement threw \`ReferenceError: require is not defined\`, the blanket
+ * \`catch (e) { return null; }\` ate it, and \`handler\` announced:
+ *
+ *     "FIREBASE_SERVICE_ACCOUNT not configured — brain idle."
+ *
+ * That message is FALSE. The credential was configured.
+ */
 let _admin = null;
-function getAdmin() {
+async function getAdmin() {
+    if (!admin.apps.length) {
+        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
+        if (!raw) return { admin: null, reason: 'not set' };
+    }
 }`;

/* Both verbatim, from the two board runs on PR #98. */
const FALSE_FINDINGS = [
    'The release-brain.js file could never succeed, and said so in the wrong words.',
    'The file could never succeed, and said so in the wrong words.',
];

describe('commentWordsOf extracts only comment prose', () => {
    const words = commentWordsOf(REAL_DIFF);

    it('captures the comment text', () => {
        expect(words.join(' ')).toContain('could never succeed and said so in the wrong words');
    });

    it('does not capture executable lines', () => {
        // If code leaked in here, a reviewer quoting CODE would be excused too —
        // which would be a hole rather than a fix.
        expect(words).not.toContain('async');
        expect(words.join(' ')).not.toContain('let admin null');
    });

    it('handles YAML and shell comments as well as JS', () => {
        const w = commentWordsOf('+  # the brain must fail loudly here\n+  run: node release-brain.js');
        expect(w.join(' ')).toBe('the brain must fail loudly here');
    });

    it('never throws on junk', () => {
        expect(() => commentWordsOf(null)).not.toThrow();
        expect(commentWordsOf('')).toEqual([]);
    });
});

describe('longestSharedRun measures contiguous overlap', () => {
    it('finds the run', () => {
        expect(longestSharedRun(['a', 'b', 'c', 'd'], ['x', 'a', 'b', 'c', 'y'])).toBe(3);
    });

    it('is contiguous, not a bag of words', () => {
        // The distinction that keeps this from firing on shared vocabulary.
        expect(longestSharedRun(['a', 'x', 'b', 'y', 'c'], ['a', 'b', 'c'])).toBe(1);
    });

    it('is zero when nothing is shared, and safe when empty', () => {
        expect(longestSharedRun(['a'], ['b'])).toBe(0);
        expect(longestSharedRun([], ['a'])).toBe(0);
        expect(longestSharedRun(['a'], [])).toBe(0);
    });
});

describe('THE REAL FALSE FINDINGS are rejected', () => {
    const comments = commentWordsOf(REAL_DIFF);

    for (const reason of FALSE_FINDINGS) {
        it(`rejects: "${reason.slice(0, 45)}…"`, () => {
            expect(restatesComment(reason, comments),
                'this exact string blocked PR #98 twice').toBe(true);
        });
    }
});

describe('a genuine finding survives, even about the same code', () => {
    const comments = commentWordsOf(REAL_DIFF);

    it('keeps the REAL defect that was found in this very diff', () => {
        // This one was true, and I fixed it: the JSON.parse message embeds the
        // first bytes of the credential and reached an unauthenticated HTTP body.
        // If the guard swallowed this, the guard would be worse than the bug.
        const real = 'The JSON.parse error message is returned to unauthenticated callers and '
            + 'embeds the first bytes of the service-account credential.';
        expect(restatesComment(real, comments)).toBe(false);
    });

    it('keeps findings that reuse the diff\'s vocabulary without quoting it', () => {
        for (const reason of [
            'getAdmin now returns null when FIREBASE_SERVICE_ACCOUNT is set but the module fails to load.',
            'The new async getAdmin is awaited in one call site but not the other, so admin is a Promise.',
            'ReferenceError is caught and reported as a missing credential, which misleads the operator.',
        ]) {
            expect(restatesComment(reason, comments), `wrongly rejected: ${reason}`).toBe(false);
        }
    });

    it('never rejects a short reason — too little signal to judge', () => {
        expect(restatesComment('Could never succeed.', comments)).toBe(false);
        expect(restatesComment('', comments)).toBe(false);
        expect(restatesComment(null, comments)).toBe(false);
    });

    it('never rejects when the diff has no comments at all', () => {
        for (const reason of FALSE_FINDINGS) {
            expect(restatesComment(reason, commentWordsOf('+const x = 1;'))).toBe(false);
        }
    });
});

describe('the thresholds are what they claim to be', () => {
    it('needs a long run AND most of the reason', () => {
        const comments = 'one two three four five six seven eight nine ten'.split(' ');
        // Exactly at the run threshold and 100% of the reason → rejected.
        expect(restatesComment('one two three four five six seven eight', comments)).toBe(true);
        // Same run, but buried in a much longer original statement → kept.
        const padded = 'one two three four five six seven eight '
            + 'and separately the allocator double counts every reconciled cent on rollover which loses money';
        expect(restatesComment(padded, comments), 'a real finding was discarded for an incidental quote').toBe(false);
    });

    it('one word short of the run threshold is not enough', () => {
        const comments = 'alpha beta gamma delta epsilon zeta eta theta'.split(' ');
        const short = comments.slice(0, REJECT_MIN_RUN - 1).join(' ');
        expect(restatesComment(short, comments)).toBe(false);
    });

    it('exposes its thresholds rather than hiding them in a literal', () => {
        expect(REJECT_MIN_RUN).toBeGreaterThanOrEqual(6);
        expect(REJECT_MIN_SHARE).toBeGreaterThan(0.3);
        expect(REJECT_MIN_SHARE).toBeLessThanOrEqual(1);
    });
});
