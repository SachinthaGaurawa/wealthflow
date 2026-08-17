/* =============================================================================
 * fetch-timeout.mjs — no outbound call from a serverless function may be
 * allowed to hang
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `fetch` has no default timeout. A request to a third-party API that accepts the
 * connection and then goes quiet does not fail — it waits, forever as far as the
 * calling code is concerned. Inside a Vercel function with `maxDuration: 60` that
 * has one outcome: the whole invocation is killed at the ceiling and the caller
 * receives FUNCTION_INVOCATION_TIMEOUT, with nothing anywhere recording WHICH
 * upstream stopped answering.
 *
 * Eighteen call sites across eight endpoints had no deadline: ai-vision (2),
 * approve-release (1), drive-auth (2), feedback-status (1), feedback (1),
 * fx-rate (1), merchant-search (4) and feedback-triage (6). feedback-triage was
 * the one that hid best — a census counting the string "signal" per file scored
 * it as partly protected, because the word appears three times in its prose
 * comments and not once as an AbortSignal. Counting the wrong thing and believing
 * the number is the same defect family as everything else fixed in this pass.
 *
 * A HANG IS WORSE THAN AN ERROR, which is the whole argument for this file. An
 * error is a fact: it has a name, it reaches a catch block, it gets logged, and
 * the endpoint can answer with a degraded but honest result. A hang is the
 * absence of a fact — it consumes the entire time budget, takes down work that
 * had already succeeded alongside it, and produces a platform-level 504 that
 * points at this application rather than at the upstream that caused it.
 *
 * WHY A SHARED MODULE, AGAINST THIS REPO'S USUAL SELF-CONTAINED STYLE
 *
 * The endpoint files here deliberately duplicate small helpers so that each is
 * independently deployable. A timeout is different in kind: it is a policy, not a
 * utility. Eight private copies drift, and the copy that drifts is invisible
 * precisely because a missing timeout has no symptom until an upstream stalls.
 * One implementation, one test, and one census guard
 * (test/fetch_timeout_test.js) that fails when a new unbounded fetch appears.
 *
 * This file exports no handler, so api/router.js does not route it and
 * test/api_contract_test.js does not count it as a stranded endpoint.
 * ===========================================================================*/

/** Chosen to sit well under Vercel's maxDuration: 60, so a stalled upstream
 *  leaves the endpoint enough time to answer honestly about it rather than
 *  being killed mid-sentence. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `fetch`, with a deadline. A drop-in replacement: same arguments, same return
 * value, same non-throwing behaviour on 4xx/5xx — so `r.ok` still has to be
 * checked by the caller, exactly as before.
 *
 * On expiry it THROWS rather than resolving. Every call site this replaced was
 * already inside a try/catch written to tolerate a network error, so a timeout
 * now lands in the same place a DNS failure always did — and says which URL and
 * which budget, which a hang never could.
 *
 * @param {string|URL|Request} url
 * @param {object} [init]  standard fetch init; a caller's own `signal` is honoured
 *                         alongside the deadline, whichever fires first
 * @param {number} [ms]    milliseconds before abort
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init, ms = DEFAULT_TIMEOUT_MS) {
    const budget = Number(ms) > 0 ? Number(ms) : DEFAULT_TIMEOUT_MS;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), budget);

    // A caller that passed its own signal must not lose it. Without this, adding a
    // deadline would quietly disable an existing cancellation path — trading one
    // silent failure for another.
    const caller = init && init.signal;
    const onCallerAbort = () => ctl.abort();
    if (caller) {
        if (caller.aborted) ctl.abort();
        else caller.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
        return await fetch(url, { ...(init || {}), signal: ctl.signal });
    } catch (e) {
        // Distinguish "we gave up" from "the network refused", because the two
        // call for different action: raise the budget, or fix connectivity.
        if (ctl.signal.aborted && !(caller && caller.aborted)) {
            const err = new Error(`fetch timed out after ${budget}ms: ${describe(url)}`);
            err.name = 'TimeoutError';
            err.timedOut = true;
            err.timeoutMs = budget;
            throw err;
        }
        throw e;
    } finally {
        clearTimeout(timer);
        if (caller) caller.removeEventListener('abort', onCallerAbort);
    }
}

/** The URL, with any query string dropped. Several of these endpoints put an API
 *  key in the query (`?key=`, `?apikey=`, `?token=`), and this string reaches
 *  logs and, in a few handlers, response bodies. */
function describe(url) {
    try {
        const u = new URL(String(url && url.url ? url.url : url));
        return u.origin + u.pathname;
    } catch (_) {
        return String(url && url.url ? url.url : url).split('?')[0].slice(0, 200);
    }
}

/**
 * Run `fn(signal)` under a deadline. The shape statement-store.js already uses,
 * exported here so the two idioms in this repo are one implementation rather
 * than two that can disagree.
 *
 * @param {(signal: AbortSignal) => Promise<any>} fn
 * @param {number} [ms]
 */
export async function withTimeout(fn, ms = DEFAULT_TIMEOUT_MS) {
    const budget = Number(ms) > 0 ? Number(ms) : DEFAULT_TIMEOUT_MS;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), budget);
    try {
        return await fn(ctl.signal);
    } finally {
        clearTimeout(timer);
    }
}
