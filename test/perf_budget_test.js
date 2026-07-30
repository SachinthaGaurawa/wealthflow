// =============================================================================
// WealthFlow Shadow Test Harness — the payload budget
// =============================================================================
// Measured: index.html is 1,508 KB, the 43 modules add 1,202 KB, and 2.7 MB
// leaves the server before the app is usable. Seven script tags block the first
// paint, five of them third-party — so first paint waits on someone else's CDN.
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
        // Documented rather than merely counted, because which ones matters: the
        // four Firebase SDKs and Chart.js are third-party, so the first paint waits
        // on a CDN this app does not control.
        const list = measure().renderBlockingList;
        expect(list.filter((s) => /^https?:/.test(s)).length).toBeGreaterThanOrEqual(4);
        expect(list.some((s) => /firebase/.test(s))).toBe(true);
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
