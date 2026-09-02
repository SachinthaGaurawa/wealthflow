/* =============================================================================
 * test/consensus_redaction_test.js — the review board must not republish the
 * credential it is approving the removal of
 * -----------------------------------------------------------------------------
 * WHAT HAPPENED
 *
 * PR #178 removed a provider key that had been hardcoded in two files of this
 * PUBLIC repository. The consensus review board reviewed it, and its security
 * lane objected. The board correctly rejected the objection — the cited line was
 * a REMOVED line, not something the diff added — and then printed the rejection
 * onto the pull request, quoting the line it had rejected:
 *
 *     cited: `-const OLLAMA_FALLBACK_KEY = '<the actual key>';`
 *
 * In a world-readable comment. On the pull request whose entire purpose was to
 * stop publishing that key.
 *
 * THE SHAPE OF THE MISTAKE
 *
 * Nothing malfunctioned. The board quotes the diff so a human can check its
 * reasoning, which is right. A diff that deletes a credential contains that
 * credential. The two correct behaviours compose into a leak, and no single
 * component was wrong — which is exactly why no reviewer, human or model, was
 * ever going to catch it by reading one file.
 *
 * So the fix is at the boundary: EVERY reviewer-supplied string is redacted on
 * its way out of runReviewer, before it can reach a comment or a public Actions
 * log. The raw text is still used for the internal diff comparisons, because
 * redacting before those would make a legitimate finding look "absent" whenever
 * the line it cites happens to contain a credential-shaped run.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { redact, scanText } from '../autonomy/secret-scan.mjs';
import { runReviewer, REVIEWERS } from '../consensus-review.mjs';

// Assembled at runtime, like every sample in test/secret_scan_test.js, so this
// file does not trip the scanner. 32 hex, a dot, an opaque tail.
const SHAPE = '0123456789abcdef'.repeat(2) + '.' + 'A1b2C3d4E5f6G7h8'.repeat(2);

const DIFF = `diff --git a/api/ai.js b/api/ai.js
--- a/api/ai.js
+++ b/api/ai.js
-const FALLBACK_KEY = '${SHAPE}';
+const FALLBACK_KEY = process.env.OLLAMA_API_KEY || '';
`;

describe('redact(): credential-shaped runs never survive into published text', () => {
    it('masks a credential embedded in a sentence', () => {
        const out = redact(`the key ${SHAPE} was removed`);
        expect(out).not.toContain(SHAPE);
        expect(out).toContain('redacted');
        expect(out, 'the surrounding sentence must survive').toContain('was removed');
    });

    it('masks every pattern the scanner knows, not just the one that leaked', () => {
        const groq = 'gsk_' + 'A1b2C3d4E5f6G7h8'.repeat(3);
        const google = 'AIzaSy' + 'A1b2C3d4E5f6G7h8'.repeat(3);
        const out = redact(`${groq} and ${google}`);
        expect(out).not.toContain(groq);
        expect(out).not.toContain(google);
        expect(scanText('x.js', out), 'redacted output is itself clean').toHaveLength(0);
    });

    it('leaves ordinary review prose untouched', () => {
        const prose = 'The PR removes a hardcoded key, which is correct. See api/ai.js line 42.';
        expect(redact(prose)).toBe(prose);
    });

    it('never throws, whatever it is handed', () => {
        expect(redact(null)).toBe('');
        expect(redact(undefined)).toBe('');
        expect(() => redact({ toString: {} })).not.toThrow();
        expect(redact(12345)).toBe('12345');
    });

    it('is repeatable — the shared /g patterns do not carry lastIndex between calls', () => {
        // A module-level regex with /g is stateful. If redact() leaked lastIndex,
        // the SECOND call on the same input would miss the match.
        const first = redact(SHAPE);
        const second = redact(SHAPE);
        expect(second).toBe(first);
        expect(second).not.toContain(SHAPE);
    });
});

describe('THE #178 LEAK, end to end: nothing a reviewer says reaches the report unredacted', () => {
    const laneFor = (name) => ({ role: REVIEWERS.find((r) => r.name === name), primary: 'mistral', fallbacks: [] });

    const chatSaying = (body) => async (opts) => ({
        text: JSON.stringify(body),
        provider: opts.only[0],
    });

    it('redacts a credential a REJECTED objection cited — the exact #178 case', async () => {
        // A fail whose evidence is a removed line: rejected as "absent", then
        // printed on the pull request. That printing is what leaked.
        const chat = chatSaying({
            verdict: 'fail',
            reason: 'The PR removes a hardcoded key which was exposed publicly.',
            evidence: `-const FALLBACK_KEY = '${SHAPE}';`,
            concerns: [],
        });
        const r = await runReviewer(laneFor('security'), DIFF, false, chat);

        expect(r.rejectedFinding, 'the objection is still kept on the record').toBeTruthy();
        expect(JSON.stringify(r), 'no field of the vote may carry the credential').not.toContain(SHAPE);
        expect(r.rejectedFinding.evidence).toContain('redacted');
    });

    it('redacts a credential quoted in a FAIL that stands', async () => {
        const chat = chatSaying({
            verdict: 'fail',
            reason: `This line hardcodes ${SHAPE}, which must come from the environment.`,
            evidence: `+const FALLBACK_KEY = process.env.OLLAMA_API_KEY || '';`,
            concerns: [`Rotate ${SHAPE} at the provider.`],
        });
        const r = await runReviewer(laneFor('security'), DIFF, false, chat);

        expect(r.vote, 'a real finding on an added line still blocks').toBe('fail');
        expect(JSON.stringify(r)).not.toContain(SHAPE);
        expect(r.reason, 'the finding must still be readable').toContain('must come from the environment');
        expect(r.concerns[0]).toContain('at the provider');
    });

    it('redacts a credential in a PASS vote\'s concerns', async () => {
        const chat = chatSaying({
            verdict: 'pass',
            reason: 'Correctly moves the key to the environment.',
            evidence: '',
            concerns: [`The old value ${SHAPE} still needs revoking.`],
        });
        const r = await runReviewer(laneFor('architecture'), DIFF, false, chat);

        expect(r.vote).toBe('pass');
        expect(JSON.stringify(r)).not.toContain(SHAPE);
    });

    it('the whole vote object passes the repository\'s own scanner', async () => {
        const chat = chatSaying({
            verdict: 'fail',
            reason: `Key ${SHAPE} is hardcoded.`,
            evidence: `-const FALLBACK_KEY = '${SHAPE}';`,
            concerns: [`Also ${'gsk_' + 'A1b2C3d4E5f6G7h8'.repeat(3)} appears nearby.`],
        });
        const r = await runReviewer(laneFor('security'), DIFF, false, chat);

        // The strongest form of the assertion: run the board's own output back
        // through the scanner that is supposed to keep credentials out of this
        // repository. If the report would fail that scan, it must not be posted.
        expect(scanText('board-report.md', JSON.stringify(r))).toHaveLength(0);
    });
});
