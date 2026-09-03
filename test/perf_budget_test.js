// =============================================================================
// WealthFlow Shadow Test Harness — the payload budget
// =============================================================================
// Measured: index.html is 1,508 KB, the 43 modules add 1,202 KB, and 2.7 MB
// leaves the server before the app is usable. Two script tags block the first
// paint, both first-party and both served from this origin. (It was seven until
// Chart.js was deferred — see the last block in this file — and six until issue
// #65 deleted the unused Firebase Storage SDK and deferred the other three
// gstatic.com tags behind an init gate; see test/firebase_defer_test.js.)
//
// WHY THESE ARE CEILINGS AND NOT TARGETS
// None of that is fixable in one pull request, and there is no build step to
// split or tree-shake any of it. An aspirational budget would mean a permanently
// red check, which gets ignored, then deleted, and then the payload grows
// unobserved — the third variant of the silent-green failure this project keeps
// producing. So the budgets sit AT the measured values: they cannot make the app
// lighter, they make it impossible to add weight without saying so in a diff.
//
// WHAT IS DELIBERATELY ABSENT
// Load timings. The CI sandbox has no egress, so every third-party script fails
// and any timing measured here describes the sandbox, not the app. A number that
// does not mean what its name says is worse than no number.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { measure, check, renderBlocking, BUDGETS } from '../autonomy/perf-budget.mjs';

describe('the payload is measured, not assumed', () => {
    const m = measure();

    it('actually found the app (guards against a vacuous pass)', () => {
        // Every assertion below passes trivially against zeroes, which is exactly
        // how a budget check ends up guarding nothing.
        expect(m.htmlBytes).toBeGreaterThan(100_000);
        expect(m.moduleCount).toBeGreaterThan(30);
        expect(m.totalJsBytes).toBeGreaterThan(500_000);
        expect(m.scriptTags).toBeGreaterThan(20);
    });

    it('holds every ceiling', () => {
        const r = check(m);
        const detail = r.violations.map((v) => `${v.key}: ${v.value} > ${v.limit} (+${v.over})`).join('\n');
        expect(r.ok, `budget exceeded:\n${detail}`).toBe(true);
    });

    it('names the largest module, so growth has an owner', () => {
        expect(m.largestModule.file).toMatch(/^wealthflow-.*\.js$/);
        expect(m.largestModuleBytes).toBe(m.modules[0].bytes);
    });
});

describe('render-blocking detection', () => {
    it('counts a plain script tag as blocking', () => {
        expect(renderBlocking('<script src="a.js"></script>')).toEqual(['a.js']);
    });

    it('does NOT count defer, async, or a module', () => {
        const html = [
            '<script src="a.js" defer></script>',
            '<script async src="b.js"></script>',
            '<script type="module" src="c.js"></script>',
        ].join('\n');
        expect(renderBlocking(html)).toEqual([]);
    });

    it('ignores inline scripts, which have nothing to fetch', () => {
        expect(renderBlocking('<script>var x = 1;</script>')).toEqual([]);
    });

    it('finds the real render-blocking set in index.html', () => {
        // Which ones matters more than how many. Until issue #65 this assertion
        // read the other way round — it required at least four third-party
        // blockers and a Firebase tag among them, because that was the measured
        // truth and a budget test states what is, not what one wishes were so.
        // The fix inverted the fact, so the assertion inverts with it: nothing on
        // the critical path may come from a host this app does not control.
        //
        // It is still not a bare count. A count of two would pass if someone swapped
        // a first-party tag for a CDN one, which is the exact regression #65 fixed.
        const list = measure().renderBlockingList;
        expect(list.length, 'render-blocking set is empty — measure() found no index.html').toBeGreaterThan(0);
        for (const s of list) {
            expect(s, `first paint waits on a third party again: ${s}`).not.toMatch(/^https?:\/\//);
        }
        expect(list.some((s) => /firebase/i.test(s)), 'a Firebase SDK is render-blocking again').toBe(false);
    });

    it('never throws on malformed or empty markup', () => {
        for (const x of ['', null, undefined, '<script', '<script src=>', '<<>>']) {
            expect(() => renderBlocking(x)).not.toThrow();
        }
    });
});

describe('the gate can actually fail', () => {
    // A ceiling that has never rejected anything is indistinguishable from no
    // ceiling. check() takes its measurement as an argument for this reason.
    it('rejects a payload that grew past a ceiling', () => {
        const inflated = { ...measure(), htmlBytes: BUDGETS.htmlBytes + 1 };
        const r = check(inflated);
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.key)).toContain('htmlBytes');
        expect(r.violations[0].over).toBe(1);
    });

    it('rejects an extra render-blocking script', () => {
        // The most likely real regression: someone adds a CDN <script> without
        // defer, and first paint waits on one more third party.
        const r = check({ ...measure(), renderBlockingScripts: BUDGETS.renderBlockingScripts + 1 });
        expect(r.ok).toBe(false);
        expect(r.violations.map((v) => v.key)).toContain('renderBlockingScripts');
    });

    it('rejects a new module pushing the count over', () => {
        const r = check({ ...measure(), moduleCount: BUDGETS.moduleCount + 1 });
        expect(r.ok).toBe(false);
    });

    it('reports EVERY violation, not just the first', () => {
        // Fixing one and rediscovering the next on the following run wastes a cycle
        // per problem.
        const r = check({
            ...measure(),
            htmlBytes: BUDGETS.htmlBytes + 10,
            totalJsBytes: BUDGETS.totalJsBytes + 10,
            scriptTags: BUDGETS.scriptTags + 1,
        });
        expect(r.violations.length).toBe(3);
    });

    it('leaves only a small margin above what is measured today', () => {
        // A ceiling far above the current value is not a ratchet, it is permission
        // to grow. Every budget must sit within 5% of reality.
        const m = measure();
        for (const [key, limit] of Object.entries(BUDGETS)) {
            const value = m[key];
            if (typeof value !== 'number' || value === 0) continue;
            expect(limit / value, `${key}: ceiling ${limit} is too loose for ${value}`).toBeLessThan(1.05);
        }
    });
});

// =============================================================================
// Chart.js: off the critical path, and survivable when it never arrives
// =============================================================================
// Chart.js was render-blocking (199 KB on the critical path) AND every use of it
// but one was unguarded. The two facts compounded: when the CDN is blocked or
// slow, `new Chart` throws, and because the throw is uncaught it ABORTS
// renderDash — so every stat, table and total BELOW the chart silently never
// renders. The user sees a half-built dashboard and no error.
//
// That was not hypothetical. The runtime sweep reported it on every run
// (`renderPage error: ReferenceError: Chart is not defined`) and the sandbox's
// lack of egress is an exact simulation of a blocked CDN. After the guards:
// application console errors 1 -> 0, and the DOM grew 3,687 -> 3,698 elements,
// because the rest of the dashboard now renders.
//
// A guard is worth more than the chart it skips: skipping costs a chart, throwing
// costs the page.
// =============================================================================
describe('Chart.js loading and resilience', () => {
    const html = () => fs.readFileSync('index.html', 'utf8');

    /* THESE TWO ASSERTIONS USED TO SAY "deferred, and above the app modules".
     *
     * Both were protecting the same thing — that Chart.js is present by the time
     * something draws — through the mechanism of the day, a `defer` tag ordered
     * before the modules. That mechanism is gone: the library is fetched on
     * demand, because it was ~70 KB gzipped and a whole CDN connection spent on
     * every startup for a screen the owner may never open. See
     * test/startup_payload_test.js for the measurement.
     *
     * What replaces them is not weaker, it is the same guarantee stated at the
     * level that now carries it: there is no tag at all, and every site that
     * draws says what to redraw once the library lands. The guard assertion
     * below is untouched and matters MORE than it did, because "Chart is
     * missing" is now the normal first state rather than a CDN accident. */
    it('is not fetched at startup at all any more', () => {
        expect(html()).not.toMatch(/<script\b[^>]*chart\.umd\.min\.js/i);
    });

    it('is fetched on demand instead, once, and remembered', () => {
        const t = html();
        expect(t).toContain('window.ensureChart = function');
        expect(t).toContain("_wfLazyScript('chartjs'");
        // _wfLazyScript caches the promise per key, so N screens cost one fetch.
        expect(t).toMatch(/function _wfLazyScript\(key, src\)[\s\S]{0,160}window\._wfLoadedLibs\[key\]/);
    });

    it('and every screen that skipped its chart now asks to be redrawn', () => {
        /* Without this the change is a REGRESSION that looks like a success: each
         * site guards on `typeof Chart` and draws nothing, so the charts would
         * simply vanish while the page rendered perfectly. */
        const t = html();
        expect(t).toContain('window._wfChartThen(renderDebtDemolisher)');
        expect(t).toContain('window._wfChartThen(renderMonteCarlo)');
        expect(t).toMatch(/_wfWarmCharts[\s\S]{0,900}'renderDash'/);
    });

    it('guards EVERY construction site against Chart being absent', () => {
        // Structural, not a count: for each `new Chart(`, look back for a
        // `typeof Chart` guard. A bare count would pass if someone added a new
        // unguarded site next to a guarded one.
        //
        // The 40-line window is a heuristic — two of the real guards sit 26 and 28
        // lines above their construction site, and a window tight enough to be
        // exact would need to understand JS scope. It is only worth trusting
        // because it was verified to FAIL when a guard is actually removed; a
        // proximity check nobody has tried to defeat is not a check.
        const lines = html().split('\n');
        const unguarded = [];
        lines.forEach((line, i) => {
            if (!/new Chart\s*\(/.test(line)) return;
            const window = lines.slice(Math.max(0, i - 40), i + 1).join('\n');
            if (!/typeof Chart\s*[!=]==?\s*['"]undefined['"]/.test(window)) unguarded.push(i + 1);
        });
        expect(unguarded, `unguarded new Chart() at line(s): ${unguarded.join(', ')}`).toEqual([]);
    });

    it('has more than one construction site, so the check is not vacuous', () => {
        expect((html().match(/new Chart\s*\(/g) || []).length).toBeGreaterThanOrEqual(4);
    });
});
