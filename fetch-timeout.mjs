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

/* =============================================================================
 * A DEADLINE THAT OUTLIVES THE HEADERS
 * -----------------------------------------------------------------------------
 * `fetchWithTimeout` above clears its timer the moment the response HEADERS
 * arrive. That is right for a caller that only looks at `r.status`, and wrong for
 * one that goes on to `await r.json()`: a provider that sends headers (and maybe
 * the first bytes) and then goes quiet leaves that read with no deadline at all.
 * Reproduced with a local server that writes `200` and half a JSON body and
 * stops: the old helper's promise is still pending minutes later, which inside a
 * `maxDuration: 60` function is FUNCTION_INVOCATION_TIMEOUT. It was the one
 * remaining `/api/router` timeout in the 24 h to 2026-10-05 (`[WF-SLOW]
 * /api/classify-charge`, one request): a vote over ~18 providers is held up by
 * its slowest member, so one stalled body held the whole request.
 *
 * Three tools, from the narrowest to the widest:
 *   readBody()            bound one `.json()` / `.text()` that is already in hand
 *   fetchWithBodyDeadline one call, deadline covers connect + headers + body
 *   createDeadline()      ONE deadline for a group of calls that run together
 *                         (a vote): every fetch AND body read shares it, and the
 *                         group can be awaited with `Promise.race([..., whenExpired])`
 *                         so a member that ignores the abort is still left behind
 *
 * `fetchWithTimeout` itself is unchanged on purpose: its callers are many and its
 * test pins "clears its timer". These are for the paths that read a body.
 * ===========================================================================*/

function timeoutError(what, budget) {
    const err = new Error(`${what} timed out after ${budget}ms`);
    err.name = 'TimeoutError';
    err.timedOut = true;
    err.timeoutMs = budget;
    return err;
}

/**
 * Read a response body (`'json'` or `'text'`) for at most `ms`. A real response is read through a reader of our own, because
 * `response.json()` locks the stream and a locked stream cannot be cancelled: on a stall the reader IS cancelled, which tears the
 * connection down instead of leaving the half-read body, its socket and its buffers alive in a warm process. Anything that is not a
 * readable `Response` (a test double, a body already taken) is read by calling `response[kind]()` under the same race. Rejects
 * with a TimeoutError (`timedOut: true`); a body that is not valid JSON rejects with the SyntaxError `.json()` would have thrown.
 *
 * @param {Response} response
 * @param {'json'|'text'} kind
 * @param {number} [ms]
 */
export async function readBody(response, kind, ms = DEFAULT_TIMEOUT_MS) {
    const budget = Number(ms) > 0 ? Number(ms) : DEFAULT_TIMEOUT_MS;
    const stream = response && response.body;
    const reader = stream && typeof stream.getReader === 'function' && !stream.locked && !response.bodyUsed ? stream.getReader() : null;
    let timer;
    const stalled = new Promise((_, reject) => {
        timer = setTimeout(() => {
            if (reader) reader.cancel().catch(() => {});
            reject(timeoutError('response body read', budget));
        }, budget);
    });
    const read = reader ? drain(reader).then((text) => (kind === 'json' ? JSON.parse(text) : text)) : response[kind]();
    try { return await Promise.race([read, stalled]); }
    finally { clearTimeout(timer); }
}

/** The whole body as text (UTF-8, a leading BOM dropped, as `Response.text()` does). */
async function drain(reader) {
    const decoder = new TextDecoder('utf-8');
    let text = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
}

/** fetch with `signal` = the budget, plus any signals the caller or a group brings. The budget is `AbortSignal.timeout`,
 *  which is not cleared on headers, so aborting it also aborts a body that is still being read. Inside a group with no
 *  budget of its own (`ms` 0) the group's deadline is the only clock. */
async function boundedFetch(url, init, ms, group) {
    const budget = Number(ms) > 0 ? Number(ms) : (group ? 0 : DEFAULT_TIMEOUT_MS);
    // a group that has already expired starts nothing: no socket is opened for an answer nobody is waiting for
    if (group && group.expired()) throw timeoutError(`shared deadline (${group.totalMs}ms) already passed: ${describe(url)}`, group.totalMs);
    const own = budget > 0 ? AbortSignal.timeout(budget) : null;
    const others = [init && init.signal, group && group.signal].filter(Boolean);
    const all = own ? [own, ...others] : others;
    const signal = all.length > 1 ? AbortSignal.any(all) : all[0];
    try {
        return await fetch(url, { ...(init || {}), ...(signal ? { signal } : {}) });
    } catch (e) {
        if (group && group.expired()) throw timeoutError(`shared deadline (${group.totalMs}ms): ${describe(url)}`, group.totalMs);
        if (own && own.aborted && !others.some((s) => s.aborted)) throw timeoutError(`fetch: ${describe(url)}`, budget);
        throw e;
    }
}

/**
 * `fetchWithTimeout`, except the deadline keeps running while the caller reads
 * the body: `await r.json()` after this rejects at the deadline instead of
 * hanging. Same arguments and return value; same non-throwing 4xx/5xx.
 *
 * @param {string|URL|Request} url
 * @param {object} [init]
 * @param {number} [ms]
 * @returns {Promise<Response>}
 */
export function fetchWithBodyDeadline(url, init, ms = DEFAULT_TIMEOUT_MS) {
    return boundedFetch(url, init, ms, null);
}

/**
 * One deadline for a group of calls that run together.
 *
 *   const vote = createDeadline(18_000);
 *   try {
 *     await Promise.race([Promise.allSettled(voters.map((v) => v(vote))), vote.whenExpired]);
 *   } finally { vote.done(); }
 *
 * At `ms` the group's signal aborts: every `vote.fetch` still connecting, waiting
 * for headers or reading a body rejects at once, and `whenExpired` resolves so
 * the caller stops waiting even for a member that never looks at a signal. Calls
 * made after expiry reject immediately. `vote.fetch(url, init, perCallMs?)` has
 * `fetchWithTimeout`'s signature; `perCallMs` can only shorten the budget.
 *
 * @param {number} ms
 * @param {() => void} [onExpire]  called once, synchronously, just before the abort
 */
export function createDeadline(ms, onExpire) {
    const totalMs = Number(ms) > 0 ? Number(ms) : DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const ctl = new AbortController();
    let expired = false;
    let wake;
    const whenExpired = new Promise((resolve) => { wake = resolve; });
    // `onExpire` runs BEFORE the abort, in the same tick: the abort makes every member reject on later microtasks, so this is the one
    // moment at which "who was still waiting" can be read without racing their own cleanup.
    const timer = setTimeout(() => { expired = true; try { if (typeof onExpire === 'function') onExpire(); } catch (_) { /* advice only */ } ctl.abort(); wake(); }, totalMs);
    const remaining = () => Math.max(0, totalMs - (Date.now() - startedAt));
    const group = {
        totalMs,
        signal: ctl.signal,
        whenExpired,
        expired: () => expired,
        remaining,
        /** Stop the timer. Call in a `finally`: a vote that finished early must not leave it armed. */
        done() { clearTimeout(timer); },
        fetch(url, init, perCallMs) {
            // a per-call budget that is shorter than what is left is its own clock; otherwise the group's deadline is the only one,
            // so "who was still waiting when it passed" is decided by one timer and not by two that fire in the same millisecond
            const per = Number(perCallMs) > 0 && Number(perCallMs) < remaining() ? Number(perCallMs) : 0;
            return boundedFetch(url, init, per, group);
        },
    };
    return group;
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
