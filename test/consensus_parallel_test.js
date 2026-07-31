// =============================================================================
// WealthFlow Shadow Test Harness — the review board runs in parallel
// =============================================================================
// The board used to run its three reviewers one at a time. Making them
// concurrent sounds like a one-line change to Promise.all, and that one line
// would have broken the board while making it look faster.
//
// The old loop chose providers with `exclude: used`, appending each reviewer's
// provider as it went — so reviewer 3's choice depended on reviewers 1 and 2.
// Under Promise.all every lane starts with an empty `exclude`, so every lane
// takes the highest-ranked provider and ALL THREE REVIEWERS RUN ON THE SAME
// MODEL. The report still prints three independent green ticks. That is a fake
// consensus, and a fake consensus is more dangerous than an honest sequential
// one, because it is trusted more.
//
// So providers are dealt up front (autonomy/llm-router.mjs::assignProviders,
// covered in autonomy_test.js) and the lanes then fan out. This file covers the
// fan-out itself:
//
//   • the lanes really are concurrent — asserted by observing that all three
//     requests are IN FLIGHT before any of them resolves, not by timing, which
//     is flaky on a shared CI runner;
//   • a reviewer is pinned to its own provider and can only fall back onto
//     providers reserved for it;
//   • every failure mode still becomes a non-vote rather than an objection,
//     because a provider outage must never block a merge.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { runReviewer, tally, REVIEWERS } from '../consensus-review.mjs';

const ROLE = REVIEWERS[0];
const PASS = JSON.stringify({ verdict: 'pass', reason: 'looks fine', evidence: '', concerns: [] });

/**
 * A chat stub that records what it was asked and answers on command.
 *
 * `answer` is a STRING (the reply body) or a function returning a full response.
 * The distinction matters: an earlier version of this helper wrapped anything
 * non-function in `{ text: answer }`, so passing a response-shaped object
 * produced `{ text: { text: … } }`. parseVote then stringified an object to
 * "[object Object]", read it as unclear, and the unclear-retry test passed for
 * entirely the wrong reason.
 */
function stubChat(answer) {
    const calls = [];
    const fn = async (opts) => {
        calls.push({ only: opts.only, prompt: opts.prompt });
        if (typeof answer === 'function') return answer(opts, calls.length);
        if (typeof answer !== 'string') throw new TypeError('stubChat: pass a string reply or a function');
        return { text: answer, provider: opts.only[0] };
    };
    fn.calls = calls;
    return fn;
}

describe('review board: the lanes actually run concurrently', () => {
    it('has all three requests in flight before any of them resolves', () => {
        // The real assertion of this change, and deliberately NOT a timing test:
        // "finished in under Nms" is flaky on a shared runner and would be quietly
        // disabled the first time it flapped. Instead the stub refuses to resolve
        // until it has seen all three calls, so the test can only pass if the lanes
        // overlap. Under the old sequential loop this would deadlock and time out.
        let inFlight = 0;
        let maxInFlight = 0;
        let release;
        const gate = new Promise((r) => { release = r; });

        const chatImpl = async (opts) => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            if (inFlight === 3) release();      // everyone is here — let them go
            await gate;
            inFlight--;
            return { text: PASS, provider: opts.only[0] };
        };

        const lanes = REVIEWERS.map((role, i) => ({ role, primary: `p${i}`, fallbacks: [] }));
        return Promise.all(lanes.map((l) => runReviewer(l, 'diff', false, chatImpl)))
            .then((votes) => {
                expect(maxInFlight).toBe(3);
                expect(votes.map((v) => v.vote)).toEqual(['pass', 'pass', 'pass']);
                expect(tally(votes).merge).toBe(true);
            });
    });
});

describe('review board: a lane stays inside its own provider allocation', () => {
    it('asks its assigned primary, and nobody else, on success', async () => {
        const chatImpl = stubChat(PASS);
        const vote = await runReviewer({ role: ROLE, primary: 'deepseek', fallbacks: ['groq'] }, 'diff', false, chatImpl);
        expect(chatImpl.calls).toHaveLength(1);
        expect(chatImpl.calls[0].only).toEqual(['deepseek']);
        expect(vote.provider).toBe('deepseek');
        expect(vote.vote).toBe('pass');
    });

    it('falls back only onto the providers reserved for it', async () => {
        // A retry must never land on a provider another reviewer is mid-request on —
        // that would recreate the shared-model problem at exactly the moment nobody
        // is watching.
        const chatImpl = stubChat((opts) => {
            if (opts.only[0] === 'deepseek') throw new Error('503 upstream');
            return { text: PASS, provider: opts.only[0] };
        });
        const vote = await runReviewer({ role: ROLE, primary: 'deepseek', fallbacks: ['mistral'] }, 'diff', false, chatImpl);
        expect(chatImpl.calls.map((c) => c.only[0])).toEqual(['deepseek', 'mistral']);
        expect(vote.provider).toBe('mistral');
        expect(vote.vote).toBe('pass');
    });

    it('records a non-vote — never an objection — when every reserved provider is down', async () => {
        // Load-bearing. An earlier version of this file counted a provider error as a
        // non-pass vote, so one DeepSeek hiccup blocked every pull request in the repo.
        const chatImpl = stubChat(() => { throw new Error('everything is on fire'); });
        const vote = await runReviewer({ role: ROLE, primary: 'deepseek', fallbacks: ['groq'] }, 'diff', false, chatImpl);
        expect(vote.vote).toBe('unavailable');
        expect(chatImpl.calls).toHaveLength(2);
        // An outage alongside a real pass must not block.
        expect(tally([vote, { name: 'security', vote: 'pass' }]).merge).toBe(true);
    });

    it('does not call a model at all when no provider was assigned', async () => {
        // The honest degradation path: fewer providers than reviewers. Running anyway
        // would mean sharing another reviewer's model.
        const chatImpl = stubChat(PASS);
        const vote = await runReviewer({ role: ROLE, primary: null, fallbacks: [] }, 'diff', false, chatImpl);
        expect(chatImpl.calls).toHaveLength(0);
        expect(vote.vote).toBe('unavailable');
        expect(vote.provider).toBe('none');
    });
});

describe('review board: verdict handling is unchanged by the parallel rewrite', () => {
    it('re-asks an unclear reply on the SAME provider, then accepts the verdict', async () => {
        // A garbled reply is a parse failure, not an objection. Retrying must not
        // wander onto another lane's provider.
        const chatImpl = stubChat((opts, n) => ({
            text: n === 1 ? 'I am not sure what to say here' : PASS,
            provider: opts.only[0],
        }));
        const vote = await runReviewer({ role: ROLE, primary: 'deepseek', fallbacks: ['groq'] }, 'diff', false, chatImpl);
        expect(chatImpl.calls.map((c) => c.only[0])).toEqual(['deepseek', 'deepseek']);
        expect(vote.vote).toBe('pass');
    });

    it('treats a reply that is still unclear after three attempts as a non-vote', async () => {
        const chatImpl = stubChat('mumble');
        const vote = await runReviewer({ role: ROLE, primary: 'deepseek', fallbacks: [] }, 'diff', false, chatImpl);
        expect(chatImpl.calls).toHaveLength(3);
        expect(vote.vote).toBe('unavailable');
        expect(vote.reason).toMatch(/no parseable verdict/);
    });

    it('a real FAIL blocks, and carries its reason and evidence through', async () => {
        const chatImpl = stubChat(JSON.stringify({ verdict: 'fail', reason: 'removes a null check', evidence: 'line 42', concerns: ['npe'] }));
        const vote = await runReviewer({ role: ROLE, primary: 'deepseek', fallbacks: [] }, 'diff', false, chatImpl);
        expect(vote.vote).toBe('fail');
        expect(vote.reason).toBe('removes a null check');
        expect(vote.evidence).toBe('line 42');
        expect(tally([vote]).merge).toBe(false);
    });

    it('never throws, whatever a provider returns', async () => {
        for (const answer of [null, undefined, {}, { text: null }, { text: '' }, { text: '{'.repeat(50) }]) {
            const chatImpl = stubChat(() => answer);
            // A crash here would take down the whole board, so a malformed reply must
            // be absorbed into a vote object rather than propagated.
            const vote = await runReviewer({ role: ROLE, primary: 'p', fallbacks: [] }, 'diff', false, chatImpl)
                .catch((e) => ({ vote: 'THREW: ' + e.message }));
            expect(['pass', 'fail', 'unavailable']).toContain(vote.vote);
        }
    });
});

// =============================================================================
// PER-SHA DEDUPE — stop the board re-reviewing a diff it already passed
// =============================================================================
// Measured on PR #32: five board runs fired on the IDENTICAL head SHA inside
// three and a half minutes, every one triggered by a `pull_request` event, every
// one reaching the same verdict. At ~2 billable Actions minutes and three provider
// calls per run that is ~10 minutes and ~15 calls spent to learn nothing — and it
// is very likely what exhausted sambanova, making the 429s that cost us the
// architecture reviewer partly self-inflicted.
//
// The head SHA alone is NOT sufficient identity. The board reviews
// `merge-base(base, HEAD)..HEAD`, so the effective diff also changes when the base
// branch moves — and merchant-sync pushes to main on a schedule. A verdict keyed
// on the head alone could skip reviewing a diff that genuinely changed underneath
// it, which would turn an optimisation into a hole. The stamp carries both ends.
// =============================================================================
import { stampFor, alreadyPassed, BOARD_STAMP } from '../consensus-review.mjs';

const ENV = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '1' };
const reply = (comments) => async () => ({ ok: true, json: async () => comments });

describe('board dedupe: identity of what was reviewed', () => {
    it('stamps BOTH ends of the diff, not just the head', () => {
        const s = stampFor('a'.repeat(40), 'b'.repeat(40));
        expect(s).toContain(BOARD_STAMP);
        expect(s).toContain('head=' + 'a'.repeat(40));
        expect(s).toContain('base=' + 'b'.repeat(40));
    });

    it('is stable, so the same diff produces the same stamp', () => {
        expect(stampFor('abc', 'def')).toBe(stampFor('abc', 'def'));
    });

    it('never throws on missing pieces', () => {
        for (const [h, b] of [[null, null], [undefined, 'x'], ['', '']]) {
            expect(() => stampFor(h, b)).not.toThrow();
        }
    });
});

describe('board dedupe: reusing a verdict', () => {
    const PASSED = { body: '### ✅ Consensus review board — PASS\n\n' + stampFor('head1', 'base1') };

    it('reuses a PASS recorded for this exact diff', async () => {
        const got = await alreadyPassed({ headSha: 'head1', mergeBase: 'base1', env: ENV, fetchImpl: reply([PASSED]) });
        expect(got).toBe(true);
    });

    it('does NOT reuse when the base moved under an unchanged head', async () => {
        // The case that makes head-only keying unsafe: same commit, different diff.
        const got = await alreadyPassed({ headSha: 'head1', mergeBase: 'base2', env: ENV, fetchImpl: reply([PASSED]) });
        expect(got).toBe(false);
    });

    it('does NOT reuse a BLOCKED verdict', async () => {
        // Load-bearing. Treating a stored block as a reason to exit 0 would convert
        // a cost optimisation into a way to merge a change the board objected to.
        const blocked = { body: '### ⛔ Consensus review board — BLOCKED\n\n' + stampFor('head1', 'base1') };
        expect(await alreadyPassed({ headSha: 'head1', mergeBase: 'base1', env: ENV, fetchImpl: reply([blocked]) })).toBe(false);
    });

    it('does NOT reuse an unstamped historical comment', async () => {
        const old = { body: '### ✅ Consensus review board — PASS\n\n(no stamp: posted before dedupe existed)' };
        expect(await alreadyPassed({ headSha: 'head1', mergeBase: 'base1', env: ENV, fetchImpl: reply([old]) })).toBe(false);
    });

    it('runs the board rather than skipping it when the lookup fails', async () => {
        // Failing to dedupe wastes two minutes. Wrongly skipping a review does not
        // cost two minutes, so every error path here must answer "no".
        const cases = [
            async () => ({ ok: false, json: async () => [] }),
            async () => ({ ok: true, json: async () => ({ message: 'not an array' }) }),
            async () => { throw new Error('network'); },
        ];
        for (const fetchImpl of cases) {
            expect(await alreadyPassed({ headSha: 'head1', mergeBase: 'base1', env: ENV, fetchImpl })).toBe(false);
        }
    });

    it('answers no when the environment lacks a token, repo or PR', async () => {
        for (const env of [{}, { GITHUB_TOKEN: 't' }, { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }]) {
            expect(await alreadyPassed({ headSha: 'head1', mergeBase: 'base1', env, fetchImpl: reply([PASSED]) })).toBe(false);
        }
    });
});

describe('board: a rate-limited provider is not handed to a reviewer', () => {
    const env = { GROQ_API_KEY: 'k', DEEPSEEK_API_KEY: 'k', WealthFlow_API_Key: 'k', CEREBRAS_API_KEY: 'k' };

    it('skips providers the caller reports as unavailable', async () => {
        // Three separate runs lost the architecture reviewer to a sambanova 429:
        // a wasted call, then an "unavailable" non-vote that silently reduced a
        // three-reviewer board to two.
        const { assignProviders } = await import('../autonomy/llm-router.mjs');
        const lanes = assignProviders(REVIEWERS, { env, unavailable: ['deepseek'] });
        for (const l of lanes) {
            expect(l.primary).not.toBe('deepseek');
            expect(l.fallbacks).not.toContain('deepseek');
        }
    });

    it('still gives every reviewer a distinct provider after a skip', async () => {
        const { assignProviders } = await import('../autonomy/llm-router.mjs');
        const lanes = assignProviders(REVIEWERS, { env, unavailable: ['cerebras'] });
        const primaries = lanes.map((l) => l.primary).filter(Boolean);
        expect(new Set(primaries).size).toBe(primaries.length);
    });

    it('degrades honestly when skipping leaves too few', async () => {
        const { assignProviders } = await import('../autonomy/llm-router.mjs');
        const lanes = assignProviders(REVIEWERS, { env, unavailable: ['cerebras', 'groq', 'gemini'] });
        expect(lanes.filter((l) => l.primary).length).toBe(1);
    });
});
