/* =============================================================================
 * statement-chain.mjs — a statement queue that keeps draining after the request that started it has answered
 * -----------------------------------------------------------------------------
 * One serverless invocation has sixty seconds. A backlog of statements is hours of work. So the work is cut into LINKS, each far
 * inside the limit, and each link starts the next one itself:
 *
 *   · a link works the queue for its time budget, writes everything it did to the database (the queue IS the database: every
 *     statement has a cursor, a lease, an attempt count and a place — nothing lives in memory between links), and returns;
 *   · if it made progress and there is more, it calls the next link — the same endpoint, authenticated with the same secret the
 *     schedule uses — and that link answers 202 at once and does its work in the platform's background window (waitUntil);
 *   · one link at a time: the chain holds a lease on the mailbox document, so a second trigger (the schedule, an open app) does not
 *     start a second chain beside it;
 *   · it stops when there is nothing left to do, when a link made no progress (everything waiting on a back-off), or after MAX_LINKS
 *     — the schedule, the app opening, or the next mail arriving starts it again. A runaway is not possible: every guard is in the
 *     database, not in memory.
 *
 * The caller that started a link gets its answer in time or a 202: nothing here waits for a whole backlog, and nothing answers
 * later than HARD_MS, so the platform never has to kill a request that is still working.
 * ===========================================================================*/

export const MAX_LINKS = 20;
/** One link's lease: longer than an invocation, so a link that dies cannot leave the chain stuck for long. */
export const LEASE_MS = 75 * 1000;
/** No caller waits longer than this for an answer; it gets a 202 and the work carries on in the background. */
export const HARD_MS = 52 * 1000;
/** The chain goes on only if the queue is ready for more work now (not asleep in a back-off). */
export const READY_WITHIN_MS = 2000;
export const HEADER = 'x-wf-chain';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The platform's way to keep an invocation alive for work that continues after the response; null where there is none (local, tests). */
export function platformWaitUntil() {
    try {
        const context = globalThis[Symbol.for('@vercel/request-context')];
        const get = context && typeof context.get === 'function' ? context.get() : null;
        return get && typeof get.waitUntil === 'function' ? get.waitUntil.bind(get) : null;
    } catch (_) { return null; }
}

/** `id:depth` → { id, depth }, or null when it is not a chain header. */
export function parseHeader(value) {
    const m = /^([A-Za-z0-9-]{8,64}):(\d{1,3})$/.exec(String(value == null ? '' : value));
    return m ? { id: m[1], depth: Number(m[2]) } : null;
}

/** Where the next link is called: the production domain of this deployment, never a preview (those are behind protection). */
export function selfUrl(env = process.env) {
    if (typeof env.WF_CHAIN_URL === 'string' && /^https:\/\/[\w.-]+(?::\d+)?\/api\/statement-sync$/.test(env.WF_CHAIN_URL)) return env.WF_CHAIN_URL;
    if (env.VERCEL_ENV !== 'production') return '';
    const host = env.VERCEL_PROJECT_PRODUCTION_URL || '';
    return /^[\w.-]+$/.test(host) ? `https://${host}/api/statement-sync` : '';
}

/** Answer in time: the work's own answer if it comes within `ms`, else `{ late: true }` (the work itself carries on). */
export async function withHardDeadline(work, ms = HARD_MS, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer;
    const late = new Promise((resolve) => { timer = setTimer(() => resolve({ late: true }), ms); });
    try { return await Promise.race([work.then((value) => ({ value })), late]); }
    finally { clearTimer(timer); }
}

/**
 * Take (or keep) the chain's lease, in one transaction. A new chain starts only when no live lease exists; a link extends the lease
 * it holds. Returns { ok, depth } — ok is false when another chain is alive.
 */
export async function takeLease({ db, mailRef, id, depth, now = Date.now(), leaseMs = LEASE_MS }) {
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(mailRef), chain = (snap.data() || {}).chain || {};
        const alive = num(chain.until) > now;
        if (alive && chain.id !== id) return { ok: false, depth: num(chain.depth) };
        tx.set(mailRef, { chain: { id, depth, until: now + leaseMs, at: now } }, { merge: true });
        return { ok: true, depth };
    });
}

export async function releaseLease({ db, mailRef, id }) {
    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(mailRef), chain = (snap.data() || {}).chain || {};
            if (chain.id === id) tx.set(mailRef, { chain: { id, depth: num(chain.depth), until: 0, at: Date.now() } }, { merge: true });
        });
    } catch (_) { /* the lease simply runs out */ }
}

/**
 * After a link has run: should another follow, and if so start it. Returns what it decided (for the log): { next, reason }.
 *
 * @param {object} o
 * @param {object} o.result      what runStatementSync returned
 * @param {{id:string,depth:number}|null} o.link   the header this request arrived with, if it was itself a link
 */
export async function continueChain({ db, mailRef, result, link = null, env = process.env, f = fetch, waitUntil = platformWaitUntil(), now = Date.now(), newId = () => `c${now.toString(36)}${Math.random().toString(36).slice(2, 10)}` }) {
    const secret = env.CRON_SECRET;
    // a link that stops hands its lease back at once, so the next trigger (the schedule, the app opening) can start a chain
    const stop = async (reason) => { if (link) await releaseLease({ db, mailRef, id: link.id }); return { next: false, reason }; };
    if (env.WF_CHAIN === 'off') return stop('disabled');
    if (typeof secret !== 'string' || secret.length < 24) return stop('no-secret');
    const url = selfUrl(env);
    if (!url) return stop('no-url');
    if (!result || result.ok !== true || result.morePending !== true) return stop('queue-empty');
    // progress: something was worked on, or the mailbox still has collecting / migrating to do
    const progress = num(result.attempted) > 0 || result.collectionMore === true || result.migrationMore === true || num(result.redriven) > 0;
    if (!progress) return stop('no-progress');
    if (num(result.retryAfterMs) > READY_WITHIN_MS) return stop('asleep');
    const id = link ? link.id : newId();
    const depth = link ? link.depth + 1 : 1;
    if (depth > MAX_LINKS) return stop('max-links');
    const lease = await takeLease({ db, mailRef, id, depth, now });
    if (!lease.ok) return { next: false, reason: 'another-chain' };
    const call = f(url, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', [HEADER]: `${id}:${depth}` }, body: JSON.stringify({ action: 'drain' }), signal: AbortSignal.timeout(8000) })
        .then((response) => ({ status: response && response.status })).catch(() => ({ status: 0 }));
    // the call is made before this invocation can end: the platform keeps it alive until it has been sent and answered
    if (waitUntil) waitUntil(call); else await call;
    return { next: true, reason: 'more-to-do', depth, id };
}
