// =============================================================================
// WealthFlow Shadow Test Harness — Data Health (issue #53), measurement only
// =============================================================================
// The diagnostics in #46 showed 496 deletion markers against 23 live records,
// and the app's own detector already had an opinion:
//
//     add('info', 'data', 'High number of deletion markers (' + n + ').',
//         'Harmless — they are pruned automatically after 100 days.');
//
// "Harmless" was never measured. It names a mechanism and infers a conclusion,
// which is not the same as knowing what the markers cost or whether the pruning
// runs at all. These tests pin the measurement, and — deliberately — pin that
// there is NO write path: the compaction engine was not built, because building
// it first would mean writing to the storage layer on an unverified premise.
//
// Tombstones are not junk. They are what makes a delete on one device stay
// deleted after another syncs, so dropping one resurrects a deleted record.
// The most important assertion in this file is the one proving nothing is
// removed.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';

function load() {
    const win = {};
    new Function('window', 'console', fs.readFileSync('wealthflow-data-health.js', 'utf8'))(
        win, { log() {}, warn() {}, error() {} },
    );
    return win.WFDataHealth;
}
const H = load();

const DAY = 24 * 3600 * 1000;
const NOW = 1785000000000;

/** A store shaped like the real one: _tomb is {key: {id: deleteTs}}. */
function appData({ fresh = 0, expired = 0, orphaned = 0, records = 0 } = {}) {
    const tomb = { expenses: {}, income: {} };
    for (let i = 0; i < fresh; i++) tomb.expenses['f' + i] = NOW - DAY;
    for (let i = 0; i < expired; i++) tomb.income['e' + i] = NOW - (200 * DAY);
    if (orphaned) {
        tomb.somethingElse = {};
        for (let i = 0; i < orphaned; i++) tomb.somethingElse['o' + i] = NOW - DAY;
    }
    return {
        _tomb: tomb,
        expenses: Array.from({ length: records }, (_, i) => ({ id: i, amount: 100 })),
    };
}

describe('data health: the module loaded (guards against a vacuous pass)', () => {
    it('exposes the API these tests read', () => {
        expect(typeof H.measure).toBe('function');
        expect(typeof H.verdict).toBe('function');
        expect(H.TOMB_TTL_MS).toBe(100 * DAY);
    });
});

describe('data health: it measures, and it never writes', () => {
    it('has no write path at all', () => {
        // The assertion that matters most. A compaction engine that removes a
        // live tombstone resurrects a record the user deleted, and no test can
        // recover data that is already gone. #53 was approved as MEASUREMENT
        // ONLY, and this is what holds that line.
        // Comments are STRIPPED before scanning. The first version matched
        // `\bdelete\s+\w` against the raw file and tripped on the prose "a
        // delete on your phone" — a test that fails on its own documentation
        // teaches you to loosen it, and the next loosening is the one that
        // misses a real write.
        const code = fs.readFileSync('wealthflow-data-health.js', 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(code).not.toMatch(/\bdelete\s+[A-Za-z_$]/);
        expect(code).not.toMatch(/setItem|removeItem|\.splice\(|_tomb\s*=[^=]/);
        expect(Object.keys(H)).not.toContain('prune');
        expect(Object.keys(H)).not.toContain('compact');
    });

    it('leaves the data it was given byte-identical', () => {
        const data = appData({ fresh: 5, expired: 3, records: 4 });
        const before = JSON.stringify(data);
        H.measure(data, { now: NOW });
        expect(JSON.stringify(data)).toBe(before);
    });

    it('counts markers across every key', () => {
        const m = H.measure(appData({ fresh: 4, expired: 2, records: 3 }), { now: NOW });
        expect(m.tombstones.count).toBe(6);
        expect(m.records.count).toBe(3);
        expect(m.ratio).toBe(2);
    });

    it('reports the bytes, which is the number the "harmless" claim never had', () => {
        const m = H.measure(appData({ fresh: 10, records: 2 }), { now: NOW });
        expect(m.tombstones.bytes).toBeGreaterThan(0);
        expect(m.totalBytes).toBeGreaterThanOrEqual(m.tombstones.bytes);
        expect(m.sharePct).toBeGreaterThan(0);
    });
});

describe('data health: the cases the assertion could never have caught', () => {
    it('finds markers past the 100-day expiry that are still present', () => {
        // The prune runs ON READ, so a key nothing reads is never pruned. That
        // is the difference between "heavy delete churn" and "the pruner is not
        // running", and the old message could not tell them apart.
        const m = H.measure(appData({ fresh: 2, expired: 7, records: 1 }), { now: NOW });
        expect(m.tombstones.expired).toBe(7);
    });

    it('finds markers filed under a key that holds no records', () => {
        const m = H.measure(appData({ fresh: 1, orphaned: 3, records: 1 }), { now: NOW });
        expect(m.tombstones.orphaned).toBe(3);
    });
});

describe('data health: the verdict quotes its own arithmetic', () => {
    it('says "negligible" only when it has measured that', () => {
        const v = H.verdict(H.measure(appData({ fresh: 3, records: 20 }), { now: NOW }));
        expect(v.level).toBe('ok');
        expect(v.measured).toBe(true);
        expect(v.text).toMatch(/negligible/);
        expect(v.text).toMatch(/3 deletion markers/);
        expect(v.text).toMatch(/KB/);
    });

    it('warns — not "harmless" — when the pruner is demonstrably not reaching them', () => {
        const v = H.verdict(H.measure(appData({ fresh: 1, expired: 40, records: 5 }), { now: NOW }));
        expect(v.level).toBe('warn');
        expect(v.text).toMatch(/40 of them are past the 100-day expiry/);
        expect(v.text).toMatch(/prune only runs when a key is read/);
    });

    it('never uses the word it replaced', () => {
        // "Harmless" was the unverified claim. No branch may reintroduce it.
        for (const c of [{ fresh: 3, records: 20 }, { expired: 9, records: 2 }, { orphaned: 4, records: 2 }, { fresh: 900, records: 3 }]) {
            const v = H.verdict(H.measure(appData({ ...c, records: c.records }), { now: NOW }));
            expect(v.text, JSON.stringify(c)).not.toMatch(/harmless/i);
        }
    });

    it('says what the percentage is a percentage OF', () => {
        // THE REGRESSION, from real production output. This read "70.4% of your
        // stored data" while the markers were 15.2 KB against 2,574 KB actually
        // stored — 0.6%. Overstated ~100x, on a diagnostic whose whole purpose
        // is replacing an unverified claim with a measured one. A number that
        // sounds authoritative and measures something other than what it says is
        // "Harmless" wearing a percentage.
        const m = H.measure(appData({ fresh: 400, records: 3 }), { now: NOW });
        expect(H.verdict(m).text).not.toMatch(/of your stored data/);
        expect(H.verdict(m).text).toMatch(/of your records and their markers/);
    });

    it('reports the share of ACTUAL storage when the caller knows it', () => {
        const m = H.measure(appData({ fresh: 400, records: 3 }), { now: NOW, totalStorageBytes: 2574 * 1024 });
        expect(m.sharePctOfStorage).toBeGreaterThan(0);
        expect(m.sharePctOfStorage).toBeLessThan(m.sharePct);   // the honest, smaller number
        expect(H.verdict(m).text).toMatch(/of everything this device stores/);
    });

    it('reports null rather than guessing when the total is unknown', () => {
        expect(H.measure(appData({ fresh: 5, records: 2 }), { now: NOW }).sharePctOfStorage).toBeNull();
    });

    it('says nothing alarming when there is nothing to say', () => {
        expect(H.verdict(H.measure({ _tomb: {}, expenses: [] }, { now: NOW })).level).toBe('ok');
    });

    it('reports "unknown" rather than inventing a verdict', () => {
        expect(H.verdict(null).level).toBe('unknown');
    });
});

describe('data health: it is actually wired into the detector', () => {
    it('index.html asks WFDataHealth instead of asserting', () => {
        // The standing review question: who reads this output, and is there a
        // test proving they do? This is that test.
        const html = fs.readFileSync('index.html', 'utf8');
        // Anchored on the CALLS, not on their exact formatting — the first
        // version pinned a one-liner and broke the moment the call was split
        // across lines to pass the storage total, failing for a reason with
        // nothing to do with what it tests.
        expect(html).toMatch(/window\.WFDataHealth\.verdict\(/);
        expect(html).toMatch(/window\.WFDataHealth\.measure\(/);
        expect(html).toMatch(/<script src="wealthflow-data-health\.js" defer><\/script>/);
    });

    it('the old unverified claim is gone from the app', () => {
        const html = fs.readFileSync('index.html', 'utf8');
        expect(html).not.toMatch(/Harmless — they are pruned automatically/);
    });
});

describe('data health: safety', () => {
    it('never throws, on any store shape at all', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => H.measure(x, { now: NOW })).not.toThrow();
            const m = H.measure(x, { now: NOW });
            expect(m.tombstones.count).toBeGreaterThanOrEqual(0);
            expect(() => H.verdict(m)).not.toThrow();
            expect(typeof H.verdict(m).text).toBe('string');
        }), { numRuns: runs(400) });
    });

    it('survives a _tomb full of junk without miscounting', () => {
        const m = H.measure({ _tomb: { expenses: null, income: 'nope', targets: { a: 'x', b: NOW } } }, { now: NOW });
        expect(m.tombstones.count).toBe(2);
        expect(m.tombstones.expired).toBe(0);   // 'x' is not a timestamp
    });
});
