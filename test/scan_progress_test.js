/* =============================================================================
 * test/scan_progress_test.js — the upload overlay's bar is driven by work that was counted (wealthflow-scan-progress.js)
 * -----------------------------------------------------------------------------
 * THE OWNER'S SCREENSHOT: "Reading statement text… Extracting every line directly from the PDF", the bar parked at the 20% somebody typed into the call, while the upload was in fact
 * opening the PDF, reading its pages, naming the bank and asking the registry. These tests hold the replacement to its rules: a position comes from counted units, a stage with no unit
 * HOLDS the bar (and counts seconds instead of inventing a number), the bar never goes backwards, never reaches 100 before the run ends, and one upload can never close or move the
 * overlay of the next. The clock and every timer are injected, so a "three minute" watchdog takes no time to test.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createTracker, readBlob, NOOP, CAP, IDLE_SHOW_S, WATCHDOG_MS, HANDOFF_MS } from '../wealthflow-scan-progress.js';

function harness() {
    let t = 1_000_000, id = 0;
    const timers = new Map();
    const frames = [];
    const env = {
        now: () => t,
        show: (stage, detail, pct, icon) => frames.push({ stage, detail, pct, icon }),
        hide: () => frames.push({ hidden: true }),
        setTimeout: (f, ms) => { const k = ++id; timers.set(k, { f, at: t + ms, every: 0 }); return k; },
        clearTimeout: (k) => { timers.delete(k); },
        setInterval: (f, ms) => { const k = ++id; timers.set(k, { f, at: t + ms, every: ms }); return k; },
        clearInterval: (k) => { timers.delete(k); },
    };
    /** Move the clock forward, firing every timer that falls due on the way, in order. */
    const advance = (ms) => {
        const end = t + ms;
        for (;;) {
            let next = null;
            for (const [k, v] of timers) if (v.at <= end && (!next || v.at < next.v.at)) next = { k, v };
            if (!next) break;
            t = next.v.at;
            if (next.v.every) next.v.at += next.v.every; else timers.delete(next.k);
            next.v.f();
        }
        t = end;
    };
    const tracker = createTracker(env);
    const last = () => frames.filter((f) => !f.hidden).at(-1);
    return { tracker, frames, advance, last, timers, shown: () => frames.filter((f) => !f.hidden), env };
}

const PLAN = [{ id: 'open', weight: 10 }, { id: 'read', weight: 40 }, { id: 'bank', weight: 25 }, { id: 'guard', weight: 25 }];

describe('a stage with units moves the bar by the units that finished', () => {
    it('pages read of N walk the bar through that stage\'s slice, and say which page', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'Opening file…' });
        run.plan(PLAN);
        run.stage('open', 'Opening PDF…', 'Unlocking it if it is protected', 'fileText');
        const atOpen = h.last().pct;
        run.stage('read', 'Reading statement text…', 'Reading page 1 of 4', 'fileText');
        const start = h.last().pct;
        expect(start).toBeCloseTo(CAP * 0.10, 1);                       // the open stage (10 of 100) is behind it
        const seen = [];
        for (let done = 0; done <= 4; done += 1) {
            run.step(done, 4, done >= 4 ? 'All 4 pages read' : `Reading page ${done + 1} of 4`);
            seen.push(h.last().pct);
        }
        expect(seen[0]).toBe(start);                                     // nothing read yet: nothing moved
        expect(seen[2]).toBeCloseTo(CAP * (0.10 + 0.40 * 0.5), 1);       // half the pages: half the slice
        expect(seen[4]).toBeCloseTo(CAP * 0.50, 1);                      // all pages: the end of the slice, not 100
        expect(h.last().detail).toBe('All 4 pages read · 49%');
        expect(atOpen).toBe(0);
    });

    it('shows the percentage only where it was earned', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('read', 'Reading', 'Reading page 1 of 2', 'fileText');
        expect(h.last().detail).toBe('Reading page 1 of 2');             // entered, nothing counted yet: no number
        run.step(1, 2, 'Reading page 2 of 2');
        expect(h.last().detail).toMatch(/^Reading page 2 of 2 · \d+%$/);
    });

    it('a step with no usable total moves nothing and claims no percentage', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('read', 'Reading', 'a', 'fileText');
        const before = h.last().pct;
        for (const bad of [[1, 0], [1, -3], [1, NaN], [NaN, 5], [1, undefined]]) {
            run.step(bad[0], bad[1], 'b');
            expect(h.last().pct).toBe(before);
            expect(h.last().detail).toBe('b');
        }
    });

    it('more units than the total, or a negative count, are clamped to the slice', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('read', 'Reading', 'a', 'fileText');
        run.step(99, 4, 'b');
        expect(h.last().pct).toBeCloseTo(CAP * 0.50, 1);
        run.step(-5, 4, 'c');
        expect(h.last().pct).toBeCloseTo(CAP * 0.50, 1);                 // and never back
    });
});

describe('a stage with no unit holds the bar and counts seconds instead', () => {
    it('stays where the finished work left it, and shows no percentage', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('read', 'Reading', 'p', 'fileText').step(4, 4, 'done');
        const held = h.last().pct;
        run.stage('bank', 'Identifying the bank…', '12 transactions found', 'bank');
        expect(h.last().pct).toBeCloseTo(CAP * 0.50, 1);
        expect(h.last().pct).toBeGreaterThanOrEqual(held);
        expect(h.last().detail).toBe('12 transactions found');
        h.advance(1000 * (IDLE_SHOW_S - 1));
        expect(h.last().detail).toBe('12 transactions found');           // a quick call shows no clock
        h.advance(1000 * 2);
        expect(h.last().detail).toBe(`12 transactions found · ${IDLE_SHOW_S + 1} s`);
        const pctDuringWait = h.last().pct;
        h.advance(12_000);
        expect(h.last().detail).toBe(`12 transactions found · ${IDLE_SHOW_S + 13} s`);
        expect(h.last().pct).toBe(pctDuringWait);                         // seconds pass, the bar does not
    });

    it('the clock restarts whenever something finishes', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('read', 'Reading', 'p', 'fileText');
        h.advance(8000);
        expect(h.last().detail).toMatch(/ · 8 s$/);
        run.step(1, 4, 'Reading page 2 of 4');
        expect(h.last().detail).toMatch(/^Reading page 2 of 4 · \d+%$/);
        h.advance(1000);
        expect(h.last().detail).not.toMatch(/ s$/);
    });

    it('a retry changes the words and not the bar, and drops the percentage it can no longer vouch for', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('read', 'Reading', 'p', 'fileText').step(2, 4, 'Reading page 3 of 4');
        const pct = h.last().pct;
        run.say('Simplified prompt retry…', 'Page 3 of 4: smaller payload', 'refresh');
        expect(h.last()).toMatchObject({ stage: 'Simplified prompt retry…', detail: 'Page 3 of 4: smaller payload', icon: 'refresh', pct });
    });
});

describe('the bar only ever goes forward, and never reaches 100 before the run ends', () => {
    it('skipping a stage passes over its slice; a smaller step later cannot pull the bar back', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('guard', 'Checking your books…', 'g', 'shield');
        const jumped = h.last().pct;
        expect(jumped).toBeCloseTo(CAP * 0.75, 1);
        run.stage('read', 'Reading', 'late', 'fileText').step(1, 4);
        expect(h.last().pct).toBe(jumped);
    });

    it('the whole plan ends at the cap: 99, never 100, until end() closes the overlay', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        for (const s of PLAN) run.stage(s.id, s.id, 'd', 'fileText').step(5, 5);
        expect(h.last().pct).toBe(CAP);
        expect(Math.max(...h.shown().map((f) => f.pct))).toBeLessThan(100);
        run.end();
        expect(h.frames.at(-1)).toEqual({ hidden: true });
    });

    it('a redrawn plan (a fallback began) shares what is left, from where the bar stands', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('read', 'Reading', 'p', 'fileText').step(4, 4);
        const floor = h.last().pct;
        run.plan([{ id: 'render', weight: 1 }, { id: 'ai', weight: 3 }]);
        run.stage('render', 'Reading PDF…', 'r', 'fileText');
        expect(h.last().pct).toBe(floor);
        run.step(1, 1);
        expect(h.last().pct).toBeCloseTo(floor + (CAP - floor) / 4, 1);
        run.stage('ai', 'AI', 'a', 'bot').step(1, 1);
        expect(h.last().pct).toBe(CAP);
    });

    it('PROPERTY: any sequence of calls keeps every frame at or below 99 and never lowers it', () => {
        const stageId = fc.constantFrom('open', 'read', 'bank', 'guard', 'ghost');
        const op = fc.oneof(
            fc.record({ k: fc.constant('stage'), id: stageId }),
            fc.record({ k: fc.constant('step'), done: fc.oneof(fc.integer({ min: -3, max: 12 }), fc.constant(NaN)), total: fc.oneof(fc.integer({ min: -2, max: 10 }), fc.constant(NaN), fc.constant(undefined)) }),
            fc.record({ k: fc.constant('say') }),
            fc.record({ k: fc.constant('plan'), weights: fc.array(fc.integer({ min: -2, max: 9 }), { minLength: 0, maxLength: 6 }) }),
            fc.record({ k: fc.constant('wait'), ms: fc.integer({ min: 0, max: 20000 }) }),
        );
        fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 60 }), (ops) => {
            const h = harness();
            const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
            for (const o of ops) {
                if (o.k === 'stage') run.stage(o.id, 'L', 'D', 'fileText');
                else if (o.k === 'step') run.step(o.done, o.total, 'd');
                else if (o.k === 'say') run.say('S', 'd', 'bot');
                else if (o.k === 'plan') run.plan(o.weights.map((w, i) => ({ id: ['open', 'read', 'bank', 'guard', 'ghost', 'x'][i], weight: w })));
                else h.advance(o.ms);
            }
            const pcts = h.shown().map((f) => f.pct);
            for (let i = 0; i < pcts.length; i += 1) {
                if (!(pcts[i] >= 0 && pcts[i] <= CAP)) return false;
                if (i && pcts[i] < pcts[i - 1]) return false;
            }
            return true;
        }), { numRuns: 300 });
    });
});

describe('one upload at a time', () => {
    it('a second upload takes the overlay, and the first one\'s late calls do nothing', () => {
        const h = harness();
        const first = h.tracker.begin({ label: 'first' }).plan(PLAN);
        first.stage('read', 'Reading', 'p', 'fileText').step(2, 4);
        const second = h.tracker.begin({ label: 'second' });
        expect(second.pct).toBe(0);                                      // a reset, not a continuation
        expect(h.last()).toMatchObject({ stage: 'second', pct: 0 });
        const n = h.frames.length;
        first.stage('guard', 'late', 'x', 'shield'); first.step(1, 1); first.say('late', 'x'); first.end();
        expect(h.frames.length).toBe(n);                                 // not shown, not hidden
        expect(second.active).toBe(true);
        expect(first.active).toBe(false);
    });

    it('end() closes only the run that still owns the overlay, and is safe twice', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' });
        run.end(); run.end();
        expect(h.frames.filter((f) => f.hidden)).toHaveLength(1);
        expect(run.active).toBe(false);
        run.stage('open', 'after end', 'x', 'fileText');                 // a straggler after the end shows nothing
        expect(h.frames.at(-1)).toEqual({ hidden: true });
    });

    it('end() stops the clock: no repaint ticks after the overlay closed', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('bank', 'b', 'd', 'bank');
        run.end();
        const n = h.frames.length;
        h.advance(60_000);
        expect(h.frames.length).toBe(n);
        expect(h.timers.size).toBe(0);
    });

    it('a run that goes silent for three minutes hides the overlay; if work resumes, it comes back', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('bank', 'Identifying the bank…', 'd', 'bank');
        h.advance(WATCHDOG_MS + 1000);
        expect(h.frames.at(-1)).toEqual({ hidden: true });
        const n = h.frames.length;
        h.advance(30_000);
        expect(h.frames.length).toBe(n);                                 // hidden means hidden: the clock stopped too
        run.stage('guard', 'Checking your books…', 'd', 'shield');
        expect(h.last()).toMatchObject({ stage: 'Checking your books…' });
        expect(h.frames.at(-1).hidden).toBeUndefined();
    });

    it('a waiting-for-the-owner stage is the same kind of stage: it holds the bar and counts seconds', () => {
        const h = harness();
        const run = h.tracker.begin({ label: 'x' }).plan(PLAN);
        run.stage('open', 'Opening PDF…', 'Unlocking it if it is protected', 'fileText');
        run.say('Waiting for the PDF password…', 'Type it in the box to continue', 'lock');
        h.advance(7000);
        expect(h.last()).toMatchObject({ stage: 'Waiting for the PDF password…', detail: 'Type it in the box to continue · 7 s', icon: 'lock' });
    });
});

describe('a download hands the overlay to the scan of the same file', () => {
    it('the next run carries on from the bar the download reached, not from zero', () => {
        const h = harness();
        const dl = h.tracker.begin({ label: 'Downloading from Google Drive…' });
        dl.plan([{ id: 'download', weight: 1 }], { to: 12 }).stage('download', 'Downloading…', 'x', 'cloud').step(5, 10);
        expect(h.last().pct).toBe(6);
        dl.step(10, 10);
        expect(h.last().pct).toBe(12);
        dl.handoff();
        expect(h.frames.at(-1).hidden).toBeUndefined();                  // the overlay stays up between the two
        const scan = h.tracker.begin({ resume: true, label: 'Opening file…' });
        expect(scan.pct).toBe(12);
        scan.plan(PLAN).stage('read', 'Reading', 'p', 'fileText');
        expect(h.last().pct).toBeGreaterThan(12);
        expect(dl.active).toBe(false);
        h.advance(HANDOFF_MS * 2);
        expect(scan.active).toBe(true);                                  // the hand-off timer died with the old run
    });

    it('if nothing picks it up the overlay closes by itself', () => {
        const h = harness();
        const dl = h.tracker.begin({ label: 'Downloading…' });
        dl.plan([{ id: 'download', weight: 1 }], { to: 12 }).stage('download', 'd', 'x', 'cloud').step(10, 10);
        dl.handoff();
        h.advance(HANDOFF_MS + 100);
        expect(h.frames.at(-1)).toEqual({ hidden: true });
    });

    it('a stale hand-off is not resumed: a new upload an hour later starts from zero', () => {
        const h = harness();
        const dl = h.tracker.begin({ label: 'd' });
        dl.plan([{ id: 'download', weight: 1 }], { to: 12 }).stage('download', 'd', 'x', 'cloud').step(10, 10);
        dl.handoff();
        h.advance(HANDOFF_MS + 100);
        expect(h.tracker.begin({ resume: true, label: 'again' }).pct).toBe(0);
    });

    it('a plain begin() after a hand-off does not inherit the bar', () => {
        const h = harness();
        const dl = h.tracker.begin({ label: 'd' });
        dl.plan([{ id: 'download', weight: 1 }], { to: 12 }).stage('download', 'd', 'x', 'cloud').step(10, 10);
        dl.handoff();
        expect(h.tracker.begin({ label: 'unrelated' }).pct).toBe(0);
    });
});

describe('the run for an upload that shows no overlay', () => {
    it('answers every call and does nothing', () => {
        for (const call of ['plan', 'stage', 'step', 'say', 'handoff', 'end']) expect(NOOP[call]()).toBe(NOOP);
        expect(NOOP.active).toBe(false);
    });
});

describe('readBlob — the bytes of a download, counted as they arrive', () => {
    const streamOf = (chunks, headers = {}) => {
        let i = 0;
        return {
            headers: { get: (k) => headers[k.toLowerCase()] ?? null },
            body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) },
            blob: async () => { throw new Error('should have streamed'); },
        };
    };

    it('reports bytes so far against Content-Length, and returns every byte in order', async () => {
        const seen = [];
        const blob = await readBlob(streamOf([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])], { 'content-length': '5', 'content-type': 'application/pdf' }), 0, (got, total) => seen.push([got, total]));
        expect(seen).toEqual([[0, 5], [3, 5], [5, 5]]);
        expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
        expect(blob.type).toBe('application/pdf');
    });

    it('uses the size the file picker gave when the server sends no length, and says 0 when nobody knows', async () => {
        const hinted = [], unknown = [];
        await readBlob(streamOf([new Uint8Array(4)]), '4', (g, t) => hinted.push([g, t]));
        await readBlob(streamOf([new Uint8Array(4)]), undefined, (g, t) => unknown.push([g, t]));
        expect(hinted.at(-1)).toEqual([4, 4]);
        expect(unknown.at(-1)).toEqual([4, 0]);
    });

    it('a progress callback that throws never fails the download', async () => {
        const blob = await readBlob(streamOf([new Uint8Array([9])]), 0, () => { throw new Error('ui broke'); });
        expect(blob.size).toBe(1);
    });

    it('a browser without streaming bodies still gets the file, with one report at the end', async () => {
        const seen = [];
        const resp = { headers: { get: () => null }, body: null, blob: async () => new Blob([new Uint8Array(7)]) };
        const blob = await readBlob(resp, 0, (g, t) => seen.push([g, t]));
        expect(blob.size).toBe(7);
        expect(seen).toEqual([[7, 7]]);
    });
});
