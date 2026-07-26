// =============================================================================
// WealthFlow Shadow Test Harness — the feedback loop
// =============================================================================
// The user's core request was that feedback must be acted on AND reported back
// as complete. Two things stood in the way, both now fixed and pinned here:
//
//   1. /api/feedback-triage — the only path from feedback to an actionable issue
//      — was never called by any client code.
//   2. The "send system diagnosis" tick attached only the user-agent, screen
//      size and language, while a full crash report sat unused in the app.
//
// These tests cover the pure logic of the return path and the diagnostics
// renderer, so a regression cannot silently reopen the void.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import { parseIssueList, versionFromComments, summarise } from '../feedback-status.js';
import { diagnosticsSection, localClassify, fingerprint, LABELS } from '../feedback-triage.js';

describe('feedback-status: issue list parsing', () => {
    it('parses a normal comma list', () => {
        expect(parseIssueList('12,15,19')).toEqual([12, 15, 19]);
    });

    it('tolerates spaces and stray separators', () => {
        expect(parseIssueList(' 3 , 4 ,, 5 ')).toEqual([3, 4, 5]);
    });

    it('rejects non-numeric, zero, and negative values', () => {
        expect(parseIssueList('abc,0,-4,7')).toEqual([7]);
    });

    it('caps the list so one request cannot fan out unboundedly', () => {
        const many = Array.from({ length: 200 }, (_, i) => i + 1).join(',');
        expect(parseIssueList(many)).toHaveLength(25);
    });

    it('returns an empty list for empty/garbage input rather than throwing', () => {
        expect(parseIssueList('')).toEqual([]);
        expect(parseIssueList(null)).toEqual([]);
        expect(parseIssueList(undefined)).toEqual([]);
    });

    it('never throws and only ever yields positive integers', () => {
        fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => {
            for (const n of parseIssueList(s)) {
                expect(Number.isInteger(n)).toBe(true);
                expect(n).toBeGreaterThan(0);
            }
        }), { numRuns: runs(400) });
    });
});

describe('feedback-status: reporting completion', () => {
    it('marks a closed issue as completed', () => {
        const s = summarise({ number: 7, state: 'closed', title: 'x', closed_at: '2026-07-20T00:00:00Z' }, []);
        expect(s.completed).toBe(true);
        expect(s.wontFix).toBe(false);
    });

    it('does NOT claim completion for an issue closed as not planned', () => {
        const s = summarise({ number: 7, state: 'closed', state_reason: 'not_planned', title: 'x' }, []);
        expect(s.completed).toBe(false);
        expect(s.wontFix).toBe(true);
    });

    it('reports an open issue as not complete', () => {
        expect(summarise({ number: 7, state: 'open', title: 'x' }, []).completed).toBe(false);
    });

    it('surfaces in-progress so the app can say "being worked on"', () => {
        const s = summarise({ number: 7, state: 'open', title: 'x', labels: [{ name: 'ai-working' }] }, []);
        expect(s.inProgress).toBe(true);
    });

    it('surfaces needsHuman when the agent stood down', () => {
        const s = summarise({ number: 7, state: 'open', title: 'x', labels: [{ name: 'ai-stuck' }] }, []);
        expect(s.needsHuman).toBe(true);
    });

    it('extracts the version a fix shipped in', () => {
        expect(versionFromComments([
            { body: 'working on it' },
            { body: '### ✅ Shipped\n\nThis fix is live in v7.70.1.' },
        ])).toBe('7.70.1');
    });

    it('ignores a version mentioned without any shipping language', () => {
        expect(versionFromComments([{ body: 'this reproduces on 7.69.12 too' }])).toBeNull();
    });

    it('returns null when there are no comments at all', () => {
        expect(versionFromComments([])).toBeNull();
        expect(versionFromComments(null)).toBeNull();
    });

    it('never throws on a malformed issue payload', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => summarise(x, [])).not.toThrow();
        }), { numRuns: runs(300) });
    });
});

describe('feedback-triage: the diagnostics the tick actually sends', () => {
    const rich = {
        ua: 'Mozilla/5.0 (iPhone)', screen: '390x844', viewport: '390x700',
        lang: 'en-GB', online: true, standalone: true, activePage: 'reports', domNodes: 4211,
        errorSummary: { total: 3, fromThisBuild: 2, uniqueMessages: ["Cannot read properties of null (reading 'map')"] },
        errors: [{ msg: "Cannot read properties of null", stack: 'at renderReports (index.html:123)', page: 'reports', ver: '7.69.12' }],
        detectedIssues: [{ severity: 'error', message: '2 error(s) recorded on the current build.' }],
        health: { storage: { approxKB: 2100 } },
    };

    it('renders the error messages and stack traces the agent needs', () => {
        const md = diagnosticsSection(rich);
        expect(md).toMatch(/System diagnosis/);
        expect(md).toMatch(/Cannot read properties of null/);
        expect(md).toMatch(/renderReports/);
    });

    it('renders the app\'s own self-detected problems', () => {
        expect(diagnosticsSection(rich)).toMatch(/2 error\(s\) recorded on the current build/);
    });

    it('includes the device facts the old version sent, so nothing regressed', () => {
        const md = diagnosticsSection(rich);
        expect(md).toMatch(/iPhone/);
        expect(md).toMatch(/390x844/);
    });

    it('returns empty string when the user did NOT tick the box', () => {
        expect(diagnosticsSection(null)).toBe('');
        expect(diagnosticsSection(undefined)).toBe('');
    });

    it('stays well inside GitHub\'s 65,536-character issue-body limit', () => {
        const huge = {
            ua: 'x'.repeat(5000),
            errors: Array.from({ length: 50 }, () => ({ msg: 'm'.repeat(2000), stack: 's'.repeat(5000), page: 'p', ver: 'v' })),
            errorSummary: { total: 999, fromThisBuild: 999, uniqueMessages: Array.from({ length: 50 }, () => 'u'.repeat(1000)) },
            detectedIssues: Array.from({ length: 50 }, () => ({ severity: 'error', message: 'd'.repeat(1000) })),
            health: { blob: 'h'.repeat(100000) },
        };
        expect(diagnosticsSection(huge).length).toBeLessThan(60000);
    });

    it('never throws on arbitrary diagnostics shapes', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => diagnosticsSection(x)).not.toThrow();
            expect(typeof diagnosticsSection(x)).toBe('string');
        }), { numRuns: runs(400) });
    });
});

describe('feedback-triage: classification', () => {
    it('treats a possible data leak as critical security', () => {
        expect(localClassify('I can see another user\'s balance')).toEqual({ type: 'security', severity: 'critical' });
    });

    it('treats a white screen as a critical crash', () => {
        expect(localClassify('white screen when I open reports').type).toBe('crash');
    });

    it('treats readability complaints as UI', () => {
        expect(localClassify('the font is too hard to read').type).toBe('ui');
    });

    it('maps every classification to a real label', () => {
        for (const t of ['bug', 'crash', 'ui', 'feature', 'security', 'other']) {
            expect(LABELS[t], t).toBeTruthy();
        }
    });

    it('produces a stable fingerprint for de-duplication', () => {
        expect(fingerprint('the reports page is blank')).toBe(fingerprint('The Reports page is blank!'));
    });

    it('distinguishes genuinely different reports', () => {
        expect(fingerprint('reports page blank')).not.toBe(fingerprint('budget total wrong'));
    });

    it('never throws on arbitrary feedback text', () => {
        fc.assert(fc.property(fc.string({ maxLength: 500 }), (s) => {
            expect(() => localClassify(s)).not.toThrow();
            expect(() => fingerprint(s)).not.toThrow();
        }), { numRuns: runs(400) });
    });
});
