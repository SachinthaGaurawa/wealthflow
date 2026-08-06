/* =============================================================================
 * test/feedback_intake_limits_test.js
 * -----------------------------------------------------------------------------
 * WHAT THE OWNER SAW
 *
 *     Saved, but it could not be filed as a work item yet:
 *     GitHub refused to create the issue (HTTP 422): Validation Failed
 *
 * His feedback was stored and then never became a work item. The autonomous
 * pipeline's only sensory input was severed, silently, for any report longer
 * than a short sentence.
 *
 * ROOT CAUSE — measured against the live GitHub API, not assumed
 *     50-character label -> HTTP 201
 *     51-character label -> HTTP 422
 *        {"resource":"Label","field":"name",
 *         "message":"name is too long (maximum is 50 characters)"}
 *
 * fingerprint() built the label as `'fb-' + words.join('-').slice(0, 60)`. The
 * cap was applied to the joined words and the prefix added AFTERWARDS, so the
 * label could reach 63 characters — and 60 was the wrong ceiling anyway.
 * GitHub rejects an over-long label by refusing the ENTIRE issue.
 *
 * Two earlier reports survived only by being short:
 *     fb-notifications-bug-critical-critical   38 chars  (#71, filed)
 *     fb-xj915t0yp                             12 chars  (#74, filed)
 * A realistic sentence produces 63 and is refused.
 *
 * SECOND DEFECT, FOUND IN THE SAME PLACE
 * The handler recorded only `created.message`, which for a 422 is the useless
 * phrase "Validation Failed". GitHub had already sent the actual reason in
 * `errors[]` and the code discarded it — so neither the owner nor I could see
 * why. The diagnosis was available, transmitted, and thrown away.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { fingerprint, githubDetail, clampTitle, LABEL_MAX, TITLE_MAX } from '../feedback-triage.js';

/** The exact text of the owner's reports that DID file. */
const FILED_71 = 'Notifications have a bug. This is a critical issue. Very critical';
/** Realistic prose that did NOT file. */
const LONG = 'The dashboard summary calculation appears incorrect whenever multiple installments overlap';
const LONGER = 'transactions reconciliation discrepancy investigation dashboard calculations installments subscriptions notifications';

describe('the label can never exceed what GitHub accepts', () => {
    it('knows the real ceiling', () => {
        expect(LABEL_MAX).toBe(50);
    });

    it.each([
        ['a short report', 'Notifications broken badly'],
        ['the report that filed as #71', FILED_71],
        ['a realistic sentence', LONG],
        ['eight long words', LONGER],
        ['absurd input', 'x'.repeat(400) + ' ' + 'yy'.repeat(200)],
        ['unicode and punctuation', 'Ledger — reconciliation ✱ mismatch, investigation required urgently please'],
    ])('stays within 50 characters for %s', (_label, text) => {
        const fp = fingerprint(text);
        expect(fp.length, `"${fp}" is ${fp.length} chars`).toBeLessThanOrEqual(LABEL_MAX);
    });

    it('would have FAILED before the fix — the old shape produced 63', () => {
        // Reproduces the exact previous implementation, so this file records the
        // defect rather than merely asserting today's behaviour.
        const STOP = new Set(['the', 'and', 'that', 'this', 'you', 'your', 'for', 'with', 'not', 'but', 'are', 'was',
            'can', 'has', 'have', 'its', 'from', 'they', 'them', 'please', 'fix', 'issue', 'now', 'when', 'what',
            'why', 'how', 'all', 'any', 'app', 'very', 'really', 'just', 'need', 'want', 'should', 'would', 'could']);
        const old = (text) => {
            const w = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
                .filter((x) => x.length > 2 && !STOP.has(x)).slice(0, 8);
            return 'fb-' + w.join('-').slice(0, 60);
        };
        expect(old(LONG).length).toBe(63);
        expect(old(LONG).length).toBeGreaterThan(LABEL_MAX);
        expect(fingerprint(LONG).length).toBeLessThanOrEqual(LABEL_MAX);
    });

    it('is stable — the same report always dedupes to the same label', () => {
        expect(fingerprint(LONG)).toBe(fingerprint(LONG));
        expect(fingerprint(FILED_71)).toBe(fingerprint(FILED_71));
    });

    it('keeps two DIFFERENT long reports apart after truncation', () => {
        // Truncating alone would be its own bug: two unrelated long reports
        // would share a prefix, collide on the dedupe label, and the second
        // would be silently discarded as a duplicate. Losing a distinct report
        // is exactly what this pipeline must never do.
        const a = 'The dashboard summary calculation appears incorrect whenever installments overlap alpha';
        const b = 'The dashboard summary calculation appears incorrect whenever installments overlap bravo';
        expect(fingerprint(a)).not.toBe(fingerprint(b));
        expect(fingerprint(a).length).toBeLessThanOrEqual(LABEL_MAX);
        expect(fingerprint(b).length).toBeLessThanOrEqual(LABEL_MAX);
    });

    it('still produces a usable label name (no trailing dash, no empties)', () => {
        for (const t of [LONG, LONGER, FILED_71]) {
            const fp = fingerprint(t);
            expect(fp).toMatch(/^fb-/);
            expect(fp).not.toMatch(/-$/);
            expect(fp).not.toMatch(/\s/);
        }
    });

    it('leaves an unidentifiable report deliberately unique', () => {
        // Two generic words must never dedupe together.
        expect(fingerprint('it broke')).not.toBe(fingerprint('it broke'));
        expect(fingerprint('it broke').length).toBeLessThanOrEqual(LABEL_MAX);
    });

    it('survives junk without throwing', () => {
        for (const t of [null, undefined, '', '   ', 123, {}]) {
            expect(() => fingerprint(t)).not.toThrow();
            expect(fingerprint(t).length).toBeLessThanOrEqual(LABEL_MAX);
        }
    });
});

describe('a rejection now says what GitHub objected to', () => {
    it('surfaces the errors[] reason, not just "Validation Failed"', () => {
        // The verbatim body GitHub returned during the live probe.
        const body = {
            message: 'Validation Failed',
            errors: [{ resource: 'Label', code: 'custom', field: 'name', message: 'name is too long (maximum is 50 characters)' }],
        };
        const d = githubDetail(body);
        expect(d).toMatch(/Validation Failed/);
        expect(d).toMatch(/name is too long \(maximum is 50 characters\)/);
        expect(d).toMatch(/Label\.name/);
    });

    it('still works when GitHub sends no errors array', () => {
        expect(githubDetail({ message: 'Not Found' })).toBe('Not Found');
        expect(githubDetail({})).toBe('');
    });

    it('does not throw on a malformed or absent body', () => {
        for (const b of [null, undefined, 'nope', { errors: 'not-an-array' }, { errors: [null, 7] }]) {
            expect(() => githubDetail(b)).not.toThrow();
        }
    });

    it('stays short enough to survive the 160-char slice at the call site', () => {
        const many = { message: 'Validation Failed', errors: Array.from({ length: 20 }, (_, i) => ({ field: 'f' + i, message: 'reason ' + i })) };
        expect(githubDetail(many).length).toBeLessThan(300);
    });
});

describe('the title cannot refuse the issue either', () => {
    it('knows GitHub\'s ceiling', () => {
        expect(TITLE_MAX).toBe(256);
    });

    it('clamps an over-long classifier summary', () => {
        const t = clampTitle('[HIGH] ' + 'word '.repeat(200));
        expect(t.length).toBeLessThanOrEqual(TITLE_MAX);
    });

    it('leaves a normal title untouched', () => {
        expect(clampTitle('[LOW] 3702 DOM elements on the dashboard')).toBe('[LOW] 3702 DOM elements on the dashboard');
    });

    it('collapses whitespace and never throws', () => {
        expect(clampTitle('  [LOW]   spaced   out  ')).toBe('[LOW] spaced out');
        for (const x of [null, undefined, 42, {}]) expect(() => clampTitle(x)).not.toThrow();
    });
});
