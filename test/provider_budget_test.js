// =============================================================================
// WealthFlow Shadow Test Harness — the provider budget ledger
// =============================================================================
// Fanning work out across every model is only powerful if a model is still
// available when it matters. Every provider here is on a free tier, and the quota
// is shared between a security review on a pull request and an idle background
// sweep. Without a reservation, background work exhausts the generous providers
// first and the next pull request finds nothing left — the board then reports
// "no reviewer could be reached" and fails closed, which is correct behaviour
// triggered by an entirely avoidable cause.
//
// The design decision these tests pin: the ledger does NOT hardcode per-provider
// quotas. Authoritative free-tier limits for fifteen providers are not something
// I have, they change without notice, and a table of confident invented numbers
// would be worse than no table — every downstream decision would inherit the
// fabrication while looking precise. So it observes what was spent, believes a
// provider when it says 429, and reserves the top-ranked providers positionally.
// That is correct without needing any quota number to be right.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    LANES, RESERVE_FOR_CRITICAL, DEFAULT_COOLDOWN_MS, KEEP_DAYS,
    emptyLedger, record, cooldownUntil, spentToday, availableFor, prune, describeBudget,
    loadLedger,
} from '../autonomy/provider-budget.mjs';

const T0 = Date.UTC(2026, 6, 30, 12, 0, 0);
const RANKED = ['cerebras', 'groq', 'gemini', 'deepseek', 'mistral'];

describe('recording what was actually spent', () => {
    it('counts calls per provider per day, split by lane', () => {
        let l = emptyLedger();
        l = record(l, { provider: 'groq', lane: LANES.CRITICAL, at: T0 });
        l = record(l, { provider: 'groq', lane: LANES.BACKGROUND, at: T0 });
        l = record(l, { provider: 'groq', lane: LANES.BACKGROUND, at: T0 });
        const day = l.days['2026-07-30'].groq;
        expect(day.ok).toBe(3);
        expect(day.critical).toBe(1);
        expect(day.background).toBe(2);
        expect(spentToday(l, T0)).toEqual({ groq: 3 });
    });

    it('does not mutate the ledger it was given', () => {
        // The ledger is passed around and persisted; in-place mutation would make a
        // failed save leave a half-updated object behind.
        const before = emptyLedger();
        const after = record(before, { provider: 'groq', at: T0 });
        expect(before.days).toEqual({});
        expect(after.days['2026-07-30'].groq.ok).toBe(1);
    });

    it('ignores a call with no provider rather than inventing a key', () => {
        expect(record(emptyLedger(), { at: T0 }).days).toEqual({});
    });
});

describe('cooldowns come from the provider, not from a guess', () => {
    it('honours a Retry-After the provider sent', () => {
        // The provider knows its own quota window. We do not, which is the entire
        // reason this module refuses to hardcode limits.
        const l = record(emptyLedger(), { provider: 'groq', outcome: 'rate_limited', at: T0, retryAfterSec: 120 });
        expect(cooldownUntil(l, 'groq', T0)).toBe(T0 + 120_000);
        expect(cooldownUntil(l, 'groq', T0 + 119_000)).toBeGreaterThan(0);
        expect(cooldownUntil(l, 'groq', T0 + 121_000)).toBe(0);
    });

    it('falls back to a conservative window when it sent none', () => {
        const l = record(emptyLedger(), { provider: 'groq', outcome: 'rate_limited', at: T0 });
        expect(cooldownUntil(l, 'groq', T0)).toBe(T0 + DEFAULT_COOLDOWN_MS);
    });

    it('never SHORTENS an existing cooldown', () => {
        // A second 429 inside an open window means the situation got worse. Taking
        // the shorter of the two would walk straight back into the limit.
        let l = record(emptyLedger(), { provider: 'groq', outcome: 'rate_limited', at: T0, retryAfterSec: 3600 });
        l = record(l, { provider: 'groq', outcome: 'rate_limited', at: T0 + 1000, retryAfterSec: 5 });
        expect(cooldownUntil(l, 'groq', T0 + 2000)).toBe(T0 + 3_600_000);
    });

    it('reports no cooldown for a provider that never rate-limited', () => {
        const l = record(emptyLedger(), { provider: 'groq', outcome: 'ok', at: T0 });
        expect(cooldownUntil(l, 'groq', T0)).toBe(0);
    });
});

describe('the reservation that makes fan-out safe', () => {
    it('lets critical work use every live provider', () => {
        expect(availableFor({ lane: LANES.CRITICAL, ranked: RANKED, ledger: emptyLedger(), now: T0 })).toEqual(RANKED);
    });

    it('keeps the top-ranked providers away from background work', () => {
        const bg = availableFor({ lane: LANES.BACKGROUND, ranked: RANKED, ledger: emptyLedger(), now: T0 });
        expect(bg).toEqual(RANKED.slice(RESERVE_FOR_CRITICAL));
        expect(bg).not.toContain('cerebras');
        expect(bg).not.toContain('groq');
    });

    it('reserves TWO, because a board of three reviewers needs distinct models', () => {
        // Reserving one would still let the board collapse onto a single provider,
        // which is exactly the fake-consensus problem assignProviders() prevents.
        expect(RESERVE_FOR_CRITICAL).toBeGreaterThanOrEqual(2);
    });

    it('gives background NOTHING rather than letting it borrow a reserved provider', () => {
        // The load-bearing invariant. A background sweep that quietly takes the
        // security reviewer's last engine causes a failure that only shows up later,
        // on a pull request, looking like an outage.
        const bg = availableFor({ lane: LANES.BACKGROUND, ranked: ['groq', 'gemini'], ledger: emptyLedger(), now: T0 });
        expect(bg).toEqual([]);
    });

    it('excludes a cooling provider from BOTH lanes', () => {
        const l = record(emptyLedger(), { provider: 'cerebras', outcome: 'rate_limited', at: T0, retryAfterSec: 600 });
        const crit = availableFor({ lane: LANES.CRITICAL, ranked: RANKED, ledger: l, now: T0 });
        expect(crit).not.toContain('cerebras');
        expect(availableFor({ lane: LANES.BACKGROUND, ranked: RANKED, ledger: l, now: T0 })).not.toContain('cerebras');
    });

    it('re-protects whatever moved to the top when the leader is cooling', () => {
        // The reservation is positional and must be taken from the LIVE list. If
        // cerebras is cooling, groq and gemini are now what the critical path reaches
        // for first, so THEY are what background must not spend — not the pair that
        // happened to be first yesterday.
        const l = record(emptyLedger(), { provider: 'cerebras', outcome: 'rate_limited', at: T0, retryAfterSec: 600 });
        const bg = availableFor({ lane: LANES.BACKGROUND, ranked: RANKED, ledger: l, now: T0 });
        expect(bg).toEqual(['deepseek', 'mistral']);
        expect(bg).not.toContain('groq');
        expect(bg).not.toContain('gemini');
    });

    it('lets a cooled-off provider back in once the window passes', () => {
        const l = record(emptyLedger(), { provider: 'cerebras', outcome: 'rate_limited', at: T0, retryAfterSec: 60 });
        expect(availableFor({ lane: LANES.CRITICAL, ranked: RANKED, ledger: l, now: T0 + 61_000 })).toContain('cerebras');
    });

    it('accepts provider objects as well as ids', () => {
        const objs = RANKED.map((id) => ({ id, label: id }));
        expect(availableFor({ lane: LANES.CRITICAL, ranked: objs, ledger: emptyLedger(), now: T0 })).toEqual(RANKED);
    });

    it('returns an empty list for an empty input instead of throwing', () => {
        for (const r of [[], null, undefined]) {
            expect(availableFor({ lane: LANES.CRITICAL, ranked: r, ledger: emptyLedger(), now: T0 })).toEqual([]);
        }
    });
});

describe('the ledger cannot grow without bound or block the pipeline', () => {
    it('drops history older than the retention window', () => {
        let l = emptyLedger();
        l = record(l, { provider: 'groq', at: T0 - (KEEP_DAYS + 5) * 86400000 });
        l = record(l, { provider: 'groq', at: T0 });
        const p = prune(l, T0);
        expect(Object.keys(p.days)).toEqual(['2026-07-30']);
    });

    it('drops expired cooldowns', () => {
        const l = record(emptyLedger(), { provider: 'groq', outcome: 'rate_limited', at: T0, retryAfterSec: 60 });
        expect(prune(l, T0 + 120_000).cooldowns).toEqual({});
        expect(prune(l, T0).cooldowns.groq).toBe(T0 + 60_000);
    });

    it('returns an EMPTY ledger for a missing or corrupt file, never throwing', () => {
        // A corrupt JSON file must not be able to block every review in the repo.
        // An empty ledger is the first-run state and is safe.
        expect(loadLedger('/definitely/not/here.json')).toEqual(emptyLedger());
        expect(loadLedger('package.json').days).toEqual({});
    });
});

describe('safety', () => {
    it('never throws on arbitrary ledger shapes', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => availableFor({ ranked: RANKED, ledger: x, now: T0 })).not.toThrow();
            expect(() => spentToday(x, T0)).not.toThrow();
            expect(() => prune(x, T0)).not.toThrow();
            expect(() => describeBudget(x, RANKED, T0)).not.toThrow();
        }), { numRuns: runs(300) });
    });

    it('never lets background see more providers than critical', () => {
        // The invariant stated as a property: whatever the history, background can
        // never have access the critical path lacks.
        const arbLedger = fc.array(fc.record({
            provider: fc.constantFrom(...RANKED),
            outcome: fc.constantFrom('ok', 'rate_limited', 'error'),
            retryAfterSec: fc.integer({ min: 0, max: 7200 }),
        }), { maxLength: 20 });
        fc.assert(fc.property(arbLedger, (events) => {
            let l = emptyLedger();
            for (const e of events) l = record(l, { ...e, at: T0 });
            const crit = availableFor({ lane: LANES.CRITICAL, ranked: RANKED, ledger: l, now: T0 });
            const bg = availableFor({ lane: LANES.BACKGROUND, ranked: RANKED, ledger: l, now: T0 });
            expect(bg.length).toBeLessThanOrEqual(crit.length);
            for (const p of bg) expect(crit).toContain(p);
        }), { numRuns: runs(300) });
    });
});

// =============================================================================
// THE WIRING — because an unwired module is the failure this project already had
// =============================================================================
// Earlier in this project, /api/feedback-triage existed, worked, and was called by
// nothing: every user screenshot was transmitted and silently dropped for months.
// A budget ledger that no caller consults would be the same defect with better
// documentation. These tests exercise the real proposeOnce() code path.
//
// proposeOnce() reads the work queue before it reaches the reservation guard, and
// that read fails in any sandbox — so without injection a test here would return
// "could not read the queue" and pass without ever evaluating the thing it claims
// to prove. The queue, chat and budget are injected for exactly that reason.
// =============================================================================
import { proposeOnce } from '../autonomy/propose.mjs';

describe('propose.mjs actually consults the ledger (background lane)', () => {
    const queue = { allIssues: async () => [] };
    const twoProviders = { GROQ_API_KEY: 'k', DEEPSEEK_API_KEY: 'k' };
    const manyProviders = { GROQ_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', MISTRAL_API_KEY: 'k', TOGETHER_API_KEY: 'k' };
    const noopBudget = (over = {}) => ({
        ...{ loadLedger: () => emptyLedger(), saveLedger: () => true, record, availableFor, LANES, RESERVE_FOR_CRITICAL },
        ...over,
    });

    it('DECLINES when the reservation leaves it nothing, without calling a model', async () => {
        // Two providers configured, two reserved for the critical path — so a weekly
        // idea must wait rather than spend the capacity a pull request will need.
        let called = 0;
        const r = await proposeOnce({
            env: twoProviders, queue, budget: noopBudget(),
            chatImpl: async () => { called++; return { text: '{}', provider: 'groq' }; },
        });
        expect(called).toBe(0);
        expect(r.filed).toBeNull();
        expect(r.reason).toMatch(/no background provider available/);
    });

    it('proceeds on the UNRESERVED providers when there are enough', async () => {
        let seenOnly = null;
        await proposeOnce({
            env: manyProviders, queue, budget: noopBudget(),
            chatImpl: async (o) => { seenOnly = o.only; return { text: '{"worthProposing": false}', provider: o.only[0] }; },
        });
        expect(Array.isArray(seenOnly)).toBe(true);
        expect(seenOnly.length).toBeGreaterThan(0);
        // The reserved leaders must not appear in what a background call may use.
        expect(seenOnly).not.toContain('groq');
        expect(seenOnly).not.toContain('deepseek');
    });

    it('records a rate limit so the next run knows to stay away', async () => {
        // The observation half. A 429 is the only authoritative signal that a free
        // tier is spent, and it is learned only by being refused.
        const saved = [];
        const budget = noopBudget({ saveLedger: (l) => { saved.push(l); return true; } });
        await proposeOnce({
            env: manyProviders, queue, budget,
            chatImpl: async (o) => {
                o.onAttempt({ provider: o.only[0], outcome: 'rate_limited', retryAfterSec: 300 });
                throw new Error('429 too many requests');
            },
        });
        expect(saved.length).toBeGreaterThan(0);
        const last = saved[saved.length - 1];
        expect(cooldownUntil(last, 'mistral', Date.now())).toBeGreaterThan(0);
    });

    it('attributes its spend to the background lane, never to critical', async () => {
        const saved = [];
        const budget = noopBudget({ saveLedger: (l) => { saved.push(l); return true; } });
        await proposeOnce({
            env: manyProviders, queue, budget,
            chatImpl: async (o) => { o.onAttempt({ provider: o.only[0], outcome: 'ok' }); return { text: '{"worthProposing": false}', provider: o.only[0] }; },
        });
        const day = Object.values(saved[saved.length - 1].days)[0];
        const entry = Object.values(day)[0];
        expect(entry.background).toBe(1);
        expect(entry.critical).toBe(0);
    });
});
