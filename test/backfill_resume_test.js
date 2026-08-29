/* =============================================================================
 * test/backfill_resume_test.js
 * -----------------------------------------------------------------------------
 * THE BUG THIS FILE IS ABOUT
 *
 * The scan planner was right. planWindows() laid out twenty-four months, newest
 * first; the queries named every bank and every word a statement calls itself;
 * the server rebuilt the same window the client asked for. All of it correct.
 *
 * And statements older than six months never arrived, for anybody, ever.
 *
 * MAX_WINDOWS_PER_RUN bounds one RUN to six windows — deliberately, so a deep
 * scan does not hog a phone or exhaust a free-tier quota. Nothing bounded the
 * SCAN, because nothing carried one run's ending into the next one's start: the
 * caller built a fresh cursor at index 0 every single time it was invoked. So
 * six windows were scanned, the message said "run it again to continue", and
 * running it again scanned the same six windows. The plan reached twenty-four
 * months. The scan reached six, then six, then six.
 *
 * That is a whole class of failure worth naming: a resumable design with no
 * resume. Every part in isolation reviews as correct — the cursor is well made,
 * the pause is well judged, the message is well worded — and the feature does
 * not work.
 *
 * So these tests assert the property the parts could not: that a scan run in
 * bounded pieces eventually covers EVERY window exactly once.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import B, {
    CURSOR_VERSION, MAX_WINDOWS_PER_RUN,
    startCursor, nextStep, advance, shouldPause,
    serializeCursor, resumeCursor, scanProgress,
} from '../wealthflow-backfill.js';

const NOW = Date.UTC(2026, 7, 29, 12, 0, 0);

/** One run: walk windows until the engine says pause, or the plan is done. */
function runOnce(cursor, visited) {
    let c = cursor;
    const startIndex = c.index;
    for (;;) {
        const step = nextStep(c);
        if (!step) break;
        visited.push(step.window.label);
        c = advance(c, { ids: [], statements: 0 });
        if (shouldPause(startIndex, c)) break;
    }
    return c;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a scan run in bounded pieces covers the whole plan', () => {
    it('reaches all 24 months, each exactly once, across repeated runs', () => {
        const visited = [];
        let saved = null;
        for (let run = 0; run < 20; run += 1) {
            const c = runOnce(resumeCursor(saved, { months: 24, now: NOW }), visited);
            saved = serializeCursor(c);
            if (c.done) break;
        }

        const plan = startCursor({ months: 24, now: NOW }).windows.map((w) => w.label);
        expect(visited).toEqual(plan);
        /* Each exactly once — the old behaviour visited the first six over and
         * over, which this catches as duplicates AND as a missing tail. */
        expect(new Set(visited).size).toBe(24);
    });

    it('reproduces the OLD behaviour to show the test can fail', () => {
        /* A guard that only ever passes is not a guard. This is the previous
         * caller, verbatim in shape: a fresh cursor per run. If the assertion
         * below ever stops holding, the test above has stopped meaning
         * anything. */
        const visited = [];
        for (let run = 0; run < 4; run += 1) {
            runOnce(startCursor({ months: 24, now: NOW }), visited);
        }
        expect(visited.length).toBe(24);          // it did plenty of work
        expect(new Set(visited).size).toBe(6);    // over six distinct months
    });

    it('never exceeds MAX_WINDOWS_PER_RUN in a single run', () => {
        /* Resuming must not be bought by removing the bound — the bound is why
         * a ten-year mailbox does not lock up a phone. */
        let saved = null;
        for (let run = 0; run < 20; run += 1) {
            const before = resumeCursor(saved, { months: 24, now: NOW });
            const after = runOnce(before, []);
            expect(after.index - before.index).toBeLessThanOrEqual(MAX_WINDOWS_PER_RUN);
            saved = serializeCursor(after);
            if (after.done) break;
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAY BE RESUMED
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('resumeCursor decides what is still the same scan', () => {
    const at = (index) => serializeCursor({
        ...startCursor({ months: 24, now: NOW }), index,
    });

    it('resumes a half-finished cursor at its own index', () => {
        expect(resumeCursor(at(7), { months: 24, now: Date.now() }).index).toBe(7);
    });

    it('keeps the ORIGINAL clock, not the resuming one', () => {
        /* The server rebuilds the window from (months, now, index). A resumed
         * scan carrying a fresh clock would address a different month than the
         * one it means — re-reading one and skipping another, silently. */
        const later = NOW + 86400000 * 45;
        expect(resumeCursor(at(3), { months: 24, now: later }).now).toBe(NOW);
    });

    it('plans the same windows after a resume as before one', () => {
        const fresh = startCursor({ months: 24, now: NOW });
        const back = resumeCursor(at(9), { months: 24, now: Date.now() });
        expect(back.windows.map((w) => w.label)).toEqual(fresh.windows.map((w) => w.label));
    });

    it('carries the running totals so progress does not reset', () => {
        const rec = serializeCursor({ ...startCursor({ months: 24, now: NOW }), index: 4, scanned: 91, statements: 12 });
        const back = resumeCursor(rec, { months: 24, now: NOW });
        expect(back.scanned).toBe(91);
        expect(back.statements).toBe(12);
    });

    it('carries a page token, so a part-read window is not read from the top', () => {
        const rec = serializeCursor({ ...startCursor({ months: 24, now: NOW }), index: 2, pageToken: 'abc' });
        expect(resumeCursor(rec, { months: 24, now: NOW }).pageToken).toBe('abc');
    });

    it('starts fresh when a different depth is asked for', () => {
        /* 24 months and 6 months are different plans. Index 7 in one is not
         * index 7 in the other, and reusing it would scan the wrong months. */
        const back = resumeCursor(at(7), { months: 6, now: NOW });
        expect(back.index).toBe(0);
        expect(back.windows.length).toBe(6);
    });

    it('starts fresh from a finished cursor', () => {
        const rec = { ...at(23), done: true };
        expect(resumeCursor(rec, { months: 24, now: NOW }).index).toBe(0);
    });

    it('starts fresh when the stored version is not this one', () => {
        expect(resumeCursor({ ...at(7), v: CURSOR_VERSION + 1 }, { months: 24, now: NOW }).index).toBe(0);
    });

    it('starts fresh when the index is past the end of its own plan', () => {
        expect(resumeCursor({ ...at(0), index: 99 }, { months: 24, now: NOW }).index).toBe(0);
    });

    it('starts fresh from junk rather than throwing', () => {
        for (const junk of [null, undefined, 0, '', 'nope', [], { v: 1 }, { v: 1, months: 24, now: 0, index: 3 }]) {
            const back = resumeCursor(junk, { months: 24, now: NOW });
            expect(back.index).toBe(0);
            expect(back.windows.length).toBe(24);
        }
    });

    it('does not resume an age it cannot check — age is not a reason to refuse', () => {
        /* Deliberate: every window in a half-finished plan is in the PAST and
         * cannot have changed, so refusing an old cursor would send the scan
         * back to index 0 — which is the defect this file is about. */
        const year = 365 * 86400000;
        expect(resumeCursor(at(11), { months: 24, now: NOW + year }).index).toBe(11);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS WRITTEN DOWN
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('serializeCursor stores a position and nothing else', () => {
    it('round-trips through JSON, which is how it is actually stored', () => {
        const c = { ...startCursor({ months: 24, now: NOW }), index: 5, scanned: 40 };
        const back = resumeCursor(JSON.parse(JSON.stringify(serializeCursor(c))), { months: 24, now: NOW });
        expect(back.index).toBe(5);
        expect(back.scanned).toBe(40);
    });

    it('holds no message content — no subject, sender, filename or query', () => {
        /* This record goes to localStorage. What was FOUND belongs in wf-mail,
         * which is sealed; a position in a plan of month boundaries is not
         * sensitive and this asserts it stays that way. */
        const rec = serializeCursor(startCursor({ months: 24, now: NOW, senders: ['hnb.lk', 'combank.lk'] }));
        const text = JSON.stringify(rec);
        expect(text).not.toContain('hnb.lk');
        expect(text).not.toContain('combank.lk');
        expect(text).not.toContain('has:attachment');
        expect(text).not.toContain('filename:pdf');
        /* Not a bare 'statement' check: `statements` is the running COUNT and
         * legitimately contains that word. What must not be here is the search
         * TERM, which the planner writes quoted. */
        expect(text).not.toContain('\\"statement\\"');
        expect(text).not.toMatch(/after:|before:|from:/);
        expect(Object.keys(rec).sort()).toEqual(
            ['done', 'index', 'months', 'now', 'pageToken', 'scanned', 'statements', 'total', 'v'],
        );
    });

    it('is small enough to store beside the rest of the app state', () => {
        /* 120 windows is the deepest plan the planner allows. The stored record
         * must not grow with it — that is the difference between a position and
         * a copy of the plan. */
        const deep = JSON.stringify(serializeCursor(startCursor({ months: 120, now: NOW })));
        expect(deep.length).toBeLessThan(200);
    });

    it('refuses to serialize something with no plan in it', () => {
        expect(serializeCursor(null)).toBe(null);
        expect(serializeCursor({})).toBe(null);
    });
});

describe('scanProgress', () => {
    it('reads 0 at the start, 1 when done, and rises in between', () => {
        const c = startCursor({ months: 24, now: NOW });
        expect(scanProgress(c)).toBe(0);
        expect(scanProgress({ ...c, index: 6 })).toBeCloseTo(0.25, 5);
        expect(scanProgress({ ...c, index: 24, done: true })).toBe(1);
    });

    it('answers 0 rather than NaN for an empty or missing cursor', () => {
        expect(scanProgress(null)).toBe(0);
        expect(scanProgress({ windows: [] })).toBe(0);
    });
});

describe('the resume half is reachable the way the page reaches it', () => {
    it('is on the window API object, not only the ESM export', () => {
        /* index.html calls window.WFBackfill.resumeCursor. An export the page
         * cannot see is an export the page does not have — this repository has
         * shipped that exact gap before. */
        for (const fn of ['serializeCursor', 'resumeCursor', 'scanProgress']) {
            expect(typeof B[fn]).toBe('function');
        }
    });
});
