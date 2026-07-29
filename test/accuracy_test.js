// =============================================================================
// WealthFlow Shadow Test Harness — detector accuracy ledger
// =============================================================================
// The ledger decides when a detector stops being trusted, so its failure modes
// are asymmetric and both directions are dangerous:
//
//   • too eager  -> it silences a detector that was right, and real defects go
//                   unreported while the pipeline looks healthy
//   • too timid  -> a detector keeps crying wolf, and the queue quietly becomes
//                   something you stop reading
//
// The tests below pin the guards against BOTH, plus the one rule that is not a
// heuristic at all: a security scanner is never switched off automatically.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    judge, tally, detectorOf, stampDetector, quarantinedKinds,
    MIN_SAMPLE, QUARANTINE_AT, NEVER_QUARANTINE, formatLedger,
} from '../autonomy/accuracy.mjs';

const issue = (kind, state, state_reason, labels = []) => ({
    state, state_reason, labels: labels.map((name) => ({ name })),
    body: stampDetector('finding body', kind),
});

describe('accuracy: judging a single filed finding', () => {
    it('counts a completed close as the finding having been real', () => {
        expect(judge(issue('k', 'closed', 'completed'))).toBe('fixed');
    });

    it('counts not-planned as a human rejecting the finding', () => {
        expect(judge(issue('k', 'closed', 'not_planned'))).toBe('rejected');
    });

    it('treats wontfix / invalid labels as rejection too', () => {
        expect(judge(issue('k', 'closed', 'completed', ['wontfix']))).toBe('rejected');
        expect(judge(issue('k', 'closed', 'completed', ['invalid']))).toBe('rejected');
    });

    it('does NOT guess when an issue was closed with no stated reason', () => {
        // Treating every close as agreement would flatter the detectors, which
        // is the one direction this must not err in.
        expect(judge(issue('k', 'closed', null))).toBe('open');
        expect(judge(issue('k', 'closed', ''))).toBe('open');
    });

    it('an open issue is not yet evidence of anything', () => {
        expect(judge(issue('k', 'open', null))).toBe('open');
    });

    it('never throws on a malformed issue', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => judge(x)).not.toThrow();
            expect(() => detectorOf(x)).not.toThrow();
        }), { numRuns: runs(300) });
    });
});

describe('accuracy: the ledger', () => {
    it('attributes each issue to the detector that filed it', () => {
        const l = tally([issue('broken-handler', 'closed', 'completed'), issue('large-dom', 'open')]);
        expect(l.map((r) => r.kind).sort()).toEqual(['broken-handler', 'large-dom']);
    });

    it('ignores issues a human filed by hand', () => {
        expect(tally([{ state: 'open', body: 'I found a bug' }])).toEqual([]);
    });

    it('quarantines a detector that is mostly rejected', () => {
        const rows = [
            ...Array(4).fill(0).map(() => issue('noisy', 'closed', 'not_planned')),
            issue('noisy', 'closed', 'completed'),
        ];
        const l = tally(rows);
        expect(l[0].rejectionRate).toBeGreaterThan(QUARANTINE_AT);
        expect(l[0].quarantined).toBe(true);
        expect(quarantinedKinds(l).has('noisy')).toBe(true);
    });

    it('does NOT quarantine on a small sample, however bad it looks', () => {
        // Two rejections is an anecdote. Silencing a detector on an anecdote is
        // how real defects stop being reported.
        const l = tally(Array(MIN_SAMPLE - 1).fill(0).map(() => issue('unlucky', 'closed', 'not_planned')));
        expect(l[0].rejectionRate).toBe(1);
        expect(l[0].quarantined).toBe(false);
        expect(l[0].judged).toBeLessThan(MIN_SAMPLE);
    });

    it('does NOT quarantine a detector that is mostly right', () => {
        const rows = [
            ...Array(5).fill(0).map(() => issue('good', 'closed', 'completed')),
            issue('good', 'closed', 'not_planned'),
        ];
        const l = tally(rows);
        expect(l[0].quarantined).toBe(false);
    });

    it('open issues never drag a detector toward quarantine', () => {
        const rows = [
            ...Array(20).fill(0).map(() => issue('slow', 'open')),
            ...Array(4).fill(0).map(() => issue('slow', 'closed', 'completed')),
        ];
        const l = tally(rows);
        expect(l[0].open).toBe(20);
        expect(l[0].rejectionRate).toBe(0);
        expect(l[0].quarantined).toBe(false);
    });

    it('NEVER quarantines the security scanner, however it is judged', () => {
        // npm audit is authoritative. "I am not fixing this CVE today" is not
        // the same statement as "this CVE is not real", and a heuristic must not
        // be able to switch off a security check.
        for (const kind of NEVER_QUARANTINE) {
            const l = tally(Array(10).fill(0).map(() => issue(kind, 'closed', 'not_planned')));
            expect(l[0].rejectionRate).toBe(1);
            expect(l[0].quarantined, `${kind} must never be quarantined`).toBe(false);
        }
    });
});

describe('accuracy: reporting', () => {
    it('says plainly when there is not enough evidence yet', () => {
        expect(formatLedger([])).toMatch(/No graded findings yet/);
    });

    it('shows the sample size when a detector has too little to judge', () => {
        expect(formatLedger(tally([issue('x', 'closed', 'not_planned')]))).toMatch(/only 1 judged/);
    });

    it('marks a quarantined detector unmistakably', () => {
        const l = tally(Array(5).fill(0).map(() => issue('noisy', 'closed', 'not_planned')));
        expect(formatLedger(l)).toMatch(/QUARANTINED/);
    });
});
