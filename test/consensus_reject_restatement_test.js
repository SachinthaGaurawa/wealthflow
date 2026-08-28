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
    addedCodeLines, citesNonExecutableEvidence, nonExecutableEvidenceReason, NON_EXECUTABLE_WHY,
    REJECT_MIN_RUN, REJECT_MIN_SHARE,
    runReviewer, REVIEWERS,
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

/* =============================================================================
 * THE SECOND SIGNAL — added after the first proved too narrow
 * -----------------------------------------------------------------------------
 * PR #106 got the SAME treatment from the SAME lane, and sailed past the guard
 * written two hours earlier:
 *
 *     reason:   "The PR introduces an open write endpoint that could be used to
 *                delete feedback documents up to 5,000 documents per call."
 *     evidence: "+        · DELETE feedback older than 14 days, via the archival pass"
 *
 * The reason PARAPHRASED rather than quoted — measured at a 6-word shared run
 * against a threshold of 8, so `restatesComment` was right to say no. I had
 * built the guard for the shape of the one failure I had seen.
 *
 * The stronger signal was in the payload the whole time: the cited evidence is
 * a bullet inside the block comment that PR added to DESCRIBE THE VULNERABILITY
 * IT WAS FIXING. The prompt already demands "the exact ADDED (+) executable
 * line that causes it" — a FAIL citing a comment has, by its own answer, failed
 * to find executable code.
 * ===========================================================================*/

/* The real hunk from PR #106, and the real evidence string it returned. */
const PR106_DIFF = [
    'diff --git a/release-brain.js b/release-brain.js',
    '--- a/release-brain.js',
    '+++ b/release-brain.js',
    '+/* =============================================================================',
    '+   AUTHENTICATION  —  this endpoint was completely open',
    '+   ---------------------------------------------------------------------------',
    '+   Any unauthenticated caller on the internet could make it:',
    '+',
    '+     · read every document in the `feedback` collection',
    '+     · DELETE feedback older than 14 days, via the archival pass',
    '+   ========================================================================== */',
    '+export async function authorize(req, { env = process.env, verifyIdToken = null } = {}) {',
    '+    const cronSecret = String(env.CRON_SECRET || \'\').trim();',
    '+    if (!cronSecret && !adminUid) {',
    '+        return { ok: false, status: 503 };',
    '+    }',
    '+}',
].join('\n');

const PR106_EVIDENCE = '+        · DELETE feedback older than 14 days, via the archival pass';
const PR106_REASON = 'The PR introduces an open write endpoint that could be used to '
    + 'delete feedback documents up to 5,000 documents per call.';

describe('addedCodeLines separates code from prose', () => {
    const lines = addedCodeLines(PR106_DIFF);

    it('keeps the executable additions', () => {
        expect(lines.join('\n')).toMatch(/export async function authorize/);
        expect(lines.join('\n')).toMatch(/const cronSecret/);
    });

    it('drops the comment block', () => {
        expect(lines.join('\n')).not.toMatch(/AUTHENTICATION/);
        expect(lines.join('\n')).not.toMatch(/completely open/);
    });

    it('ignores the +++ file header', () => {
        expect(lines.join('\n')).not.toMatch(/release-brain\.js/);
    });
});

describe('THE REAL PR #106 FINDING is rejected', () => {
    it('is NOT caught by the first signal — which is why the second exists', () => {
        // Documenting the gap rather than pretending the first guard covered it.
        expect(restatesComment(PR106_REASON, commentWordsOf(PR106_DIFF))).toBe(false);
    });

    it('IS caught by the evidence check', () => {
        expect(citesNonExecutableEvidence(PR106_EVIDENCE, PR106_DIFF),
            'this exact evidence string blocked PR #106').toBe(true);
    });
});

describe('a genuine finding still cites real code and survives', () => {
    it('accepts an added executable line', () => {
        for (const ev of [
            '+    const cronSecret = String(env.CRON_SECRET || \'\').trim();',
            '+    if (!cronSecret && !adminUid) {',
            'const cronSecret = String(env.CRON_SECRET || \'\').trim();',
        ]) {
            expect(citesNonExecutableEvidence(ev, PR106_DIFF), `wrongly rejected: ${ev}`).toBe(false);
        }
    });

    it('rejects a line that is not in the diff at all', () => {
        expect(citesNonExecutableEvidence('const x = somethingDangerous();', PR106_DIFF)).toBe(true);
    });

    it('rejects a DELETED line — removing a defect is a fix, not a defect', () => {
        // Assembled rather than written literally: test/esm_require_test.js
        // correctly forbids a bare `require(` in any ESM file, and it does not
        // and should not know that this occurrence is sample data. That scanner
        // stays strict; this string bends around it.
        const deleted = '-    const admin = ' + 'require' + "('firebase-admin');";
        expect(citesNonExecutableEvidence(deleted, PR106_DIFF + '\n' + deleted)).toBe(true);
    });

    it('leaves EMPTY evidence alone — that path already fails closed on purpose', () => {
        // Citing nothing may mean the reviewer saw something it could not quote.
        // Citing a comment is positive proof it was reading prose. Only the
        // second is rejected here.
        expect(citesNonExecutableEvidence('', PR106_DIFF)).toBe(false);
        expect(citesNonExecutableEvidence(null, PR106_DIFF)).toBe(false);
        expect(citesNonExecutableEvidence('   ', PR106_DIFF)).toBe(false);
    });

    it('does not reject when there is no added code to compare against', () => {
        expect(citesNonExecutableEvidence('anything at all here', 'diff --git a/x b/x')).toBe(false);
    });

    it('is not fooled into matching a trivial one-character line', () => {
        // Without a length floor, the added `}` would "match" every evidence
        // string and excuse every bad citation.
        expect(citesNonExecutableEvidence('some totally unrelated claim }', PR106_DIFF)).toBe(true);
    });
});


/* ═══════════════════════════════════════════════════════════════════════════
 * PR #162 — TWO CAUSES WERE PRINTING ONE SENTENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The check above fails in two different ways, and they are not the same
 * discovery:
 *
 *   'comment'  the reviewer quoted the diff's own explanation of itself.
 *   'absent'   the reviewer quoted something that is not in the diff at all.
 *
 * Both printed the 'comment' wording. On #162 the user-impact lane cited a real
 * added line — the Debt Demolisher's TARGET badge — but RETYPED, with the
 * concatenation quotes changed from ' to ". It therefore matched nothing, which
 * is 'absent', and the board told the reader it had quoted a comment.
 *
 * The rejection was correct. Its stated reason was false. That matters because
 * the report ends by inviting the reader to overrule a rejection: they would
 * have been deciding on the wrong story about what happened. It is the defect
 * PR #159 fixed in the summary table, surviving one level down in the sentence
 * the table prints.
 * ========================================================================= */
describe('a rejected citation says WHICH way it was wrong', () => {
    /* The real hunk, trimmed. Assembled from parts so no line of this file is
     * itself a template literal containing ${...}. */
    const REAL = "+   ${i === 0 ? '<div class=\"tgt\">' + _ic('target') + ' TARGET</div>' : ''}";
    const DIFF = [
        'diff --git a/index.html b/index.html',
        '@@ -1,3 +1,3 @@',
        "-   ${i === 0 ? '<div class=\"tgt\">\u{1F3AF} TARGET</div>' : ''}",
        REAL,
        '     const totalDebt = debtItems.reduce((s, d) => s + d.amount, 0);',
    ].join('\n');

    /* The same line as the board printed it: single quotes around the
     * concatenation swapped for double. One character in, one character out. */
    const RETYPED = REAL.replace('">\' + _ic(\'target\') + \' TARGET', '">" + _ic(\'target\') + " TARGET');

    it('the retyped citation really is different from the real line', () => {
        /* Guard the fixture itself: if these two ever became equal, every
         * assertion below would be comparing a line with itself. */
        expect(RETYPED).not.toBe(REAL);
        expect(DIFF).toContain(REAL);
        expect(DIFF).not.toContain(RETYPED);
    });

    it('the REAL line is not rejected at all', () => {
        expect(nonExecutableEvidenceReason(REAL, DIFF)).toBeNull();
        expect(citesNonExecutableEvidence(REAL, DIFF)).toBe(false);
    });

    it('the RETYPED line is rejected as absent, not as a comment', () => {
        expect(nonExecutableEvidenceReason(RETYPED, DIFF)).toBe('absent');
        expect(citesNonExecutableEvidence(RETYPED, DIFF)).toBe(true);
    });

    it('a genuine comment citation is still reported as a comment', () => {
        expect(nonExecutableEvidenceReason('+  // this is the explanation', DIFF)).toBe('comment');
        expect(nonExecutableEvidenceReason('+  * and so is this', DIFF)).toBe('comment');
    });

    it('the two sentences are different, and neither tells the other story', () => {
        expect(NON_EXECUTABLE_WHY.comment).not.toBe(NON_EXECUTABLE_WHY.absent);
        expect(NON_EXECUTABLE_WHY.absent.toLowerCase(),
            'the absent case must not claim the reviewer quoted a comment')
            .not.toContain('comment');
        expect(NON_EXECUTABLE_WHY.comment).toContain('comment');
    });

    it('the boolean wrapper still answers what its old callers ask', () => {
        expect(citesNonExecutableEvidence('', DIFF)).toBe(false);
        expect(citesNonExecutableEvidence(null, DIFF)).toBe(false);
        expect(citesNonExecutableEvidence('unrelated claim about nothing', DIFF)).toBe(true);
    });

    it('THE #162 VERDICT, end to end: the board prints the absent sentence', async () => {
        const chat = async (opts) => ({
            text: JSON.stringify({
                verdict: 'fail',
                reason: 'The user will see new icons and labels in the Debt Demolisher screen, which may be confusing if the icons are not intuitive or the labels are unclear.',
                evidence: RETYPED,
                concerns: [],
            }),
            provider: opts.only[0],
        });
        const lane = { role: REVIEWERS.find((r) => r.name === 'user-impact'), primary: 'cohere', fallbacks: [] };
        const r = await runReviewer(lane, DIFF, false, chat);

        expect(r.vote, 'the objection rested on a line that is not in the diff').toBe('pass');
        expect(r.rejectedFinding, 'the objection must be kept on the record').toBeTruthy();
        expect(r.rejectedFinding.why).toBe(NON_EXECUTABLE_WHY.absent);
        expect(r.rejectedFinding.why, 'this is what #162 wrongly printed').not.toContain('comment or prose line');
    });
});
