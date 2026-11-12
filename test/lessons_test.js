import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { LESSONS, lessonsFor, lessonsBrief, classifyFailure } from '../autonomy/lessons.mjs';

describe('standing rules from earlier failures', () => {
    it('every rule has an id, a rule sentence and the evidence it was learned from', () => {
        const ids = new Set();
        for (const l of LESSONS) {
            expect(l.id).toMatch(/^[a-z0-9-]+$/);
            expect(ids.has(l.id)).toBe(false);
            ids.add(l.id);
            expect(l.rule.length).toBeGreaterThan(40);
            expect(l.evidence.length).toBeGreaterThan(10);
            expect(l.when).toBeInstanceOf(RegExp);
        }
    });

    it('a phone layout report gets the hidden-column rule, and it comes before the catch-all', () => {
        const got = lessonsFor('Dashboard legend is cut off on my phone at 320px');
        const ids = got.map((l) => l.id);
        expect(ids).toContain('layout-no-hidden-columns');
        expect(ids.indexOf('layout-no-hidden-columns')).toBeLessThan(ids.indexOf('tests-assert-values'));
    });

    it('a report about a serverless endpoint gets the autonomy-import rule, a layout one does not', () => {
        expect(lessonsFor('the triage api endpoint on vercel is slow').map((l) => l.id)).toContain('no-autonomy-in-functions');
        expect(lessonsFor('overlap on phone').map((l) => l.id)).not.toContain('no-autonomy-in-functions');
    });

    it('a CI failure digest steers the rules on a retry', () => {
        const got = lessonsFor('Add a button. Why the last attempt failed: perf budget ceiling exceeded by 3 KB');
        expect(got.map((l) => l.id)).toContain('size-ceilings');
    });

    it('is capped, and empty text gives nothing', () => {
        expect(lessonsFor('')).toEqual([]);
        expect(lessonsFor('   ')).toEqual([]);
        const everything = LESSONS.map((l) => l.id).join(' overlap phone api delete error fails perf budget index.html ');
        expect(lessonsFor(everything, { max: 3 }).length).toBeLessThanOrEqual(3);
        expect(lessonsFor(everything).length).toBeLessThanOrEqual(5);
    });

    it('the brief is a section of bullet rules, empty when nothing matches', () => {
        const b = lessonsBrief('Dashboard legend cut off on phone');
        expect(b).toMatch(/Standing rules from earlier failures/);
        expect(b).toMatch(/\n- Never fix a squeezed row/);
        expect(lessonsBrief('', {})).toBe('');
        expect(lessonsBrief('anything', { lessons: [] })).toBe('');
    });

    it('classifies failed checks coarsely', () => {
        expect(classifyFailure('Tests + fuzz (shadow harness)')).toBe('tests');
        expect(classifyFailure('Shell check index.html')).toBe('shell');
        expect(classifyFailure('Perf budget')).toBe('size');
        expect(classifyFailure('No committed credentials')).toBe('secrets');
        expect(classifyFailure('something odd')).toBe('other');
    });

    it('the fix agent shows the rules to the author and never uses them for routing', () => {
        const src = fs.readFileSync(new URL('../autonomous-fix-agent.js', import.meta.url), 'utf8');
        expect(src).toMatch(/import \{ lessonsBrief, lessonsFor \} from '\.\/autonomy\/lessons\.mjs'/);
        expect(src).toMatch(/laneBody \+= standing/);
        expect(src).toMatch(/body: shot\.body \+ retryBrief \+ triedBrief \+ standing/);
        // routing reads the report's own words (and its labels, since 2026-11-12: a program-filed report is routed by label), never the briefs
        expect(src).toMatch(/layoutLaneFor\(\{ title: issue\.title, body: shot\.body, labels: issue\.labels \}\)/);
        expect(src).toMatch(/buildLaneFor\(\{ title: issue\.title, body: shot\.body \}\)/);
    });
});
