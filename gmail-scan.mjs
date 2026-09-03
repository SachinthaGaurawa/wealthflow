/* =============================================================================
 * gmail-scan.mjs — the decisions behind reaching into the PAST
 * -----------------------------------------------------------------------------
 * WHAT THE PUSH PIPELINE CANNOT DO
 *
 * A Pub/Sub watch is a subscription to the future. Gmail notifies on what
 * arrives AFTER the watch is registered, and /api/gmail-hook then asks
 * history.list what changed since a bookmark. Neither of those can see a
 * statement that was already sitting in the mailbox.
 *
 * That leaves the more valuable half unreachable. A ledger that begins the day
 * the pipeline was switched on cannot say what anyone actually spends, and the
 * owner cannot even TEST the parser until a bank happens to send something.
 *
 * ── A CORRECTION, BECAUSE IT WAS WRITTEN TWICE ──────────────────────────────
 *
 * gmail-link.mjs says, of leaving historyId unset, that "the first push starts
 * from the beginning", and gmail-watch.mjs repeats the reasoning. That is
 * WRONG, and the code says so plainly:
 *
 *     messagesSince(token, state.historyId || note.historyId)
 *       → GET /history?startHistoryId=<id>&historyTypes=messageAdded
 *
 * With no stored bookmark it uses the PUSH's own historyId — the mailbox's
 * current point — and history.list returns changes AFTER that. So the first
 * push reads from now, not from the beginning, and no arrangement of that
 * bookmark could ever have produced a backfill. Reaching into the past needs a
 * SEARCH, which is what this file plans. Those two comments are corrected in
 * the same change that makes the claim true by other means.
 *
 * ── WHY THE SERVER DECIDES THE WINDOW ───────────────────────────────────────
 *
 * The client could send a Gmail query string. It must not. This endpoint holds
 * a credential that can read an entire mailbox, so a free-text query parameter
 * would make it a general-purpose mail search proxy — a far larger thing than
 * "find my bank statements", and one whose blast radius grows with every future
 * caller. The client sends WHICH WINDOW it wants by index; the server builds
 * the query from the same planWindows() the client planned with, over the same
 * sender allowlist the live path uses. There is one planner and no free text.
 * ===========================================================================*/

import { planWindows } from './wealthflow-backfill.js';
import { BANKS } from './wealthflow-mail-ingest.mjs';

/** Where a statement waits for a device — the same place the push writes. */
export const MAIL_ROOT = 'wf-mail';

export const SCAN = {
    /** Gmail pages at 500; this is about how much one invocation can fetch and
     *  store inside the function's deadline, not about what Gmail will give. */
    MAX_MESSAGES_PER_CALL: 25,
    /** How far back the UI may ask to go. Ten years is planWindows' own ceiling. */
    MAX_MONTHS: 120,
};

/** The domains a statement may come from — the live path's allowlist, not a copy. */
export function scanSenders() {
    return BANKS.map((b) => b && b.domain).filter(Boolean);
}

/**
 * The window this request is asking for, or null.
 *
 * `now` comes from the caller's cursor rather than the clock. planWindows() is
 * a pure function of (months, now), so client and server agree on what window
 * number 7 is only if they agree on `now` — and a scan that straddles midnight
 * on the first of a month would otherwise silently shift every window by one,
 * re-reading one month and skipping another.
 */
export function windowFor({ months, index, now, senders = null, discover = null } = {}) {
    const m = Math.max(1, Math.min(SCAN.MAX_MONTHS, Math.floor(Number(months)) || 0));
    /* STRICT. `Number(null)` is 0 and `Number('')` is 0, so a lenient parse
     * turns a client that forgot to send an index into a request for window
     * zero — and a scan loop with that bug re-reads the current month forever
     * while reporting progress. An absent index is a caller error, not a
     * request for the first window. */
    const i = (typeof index === 'number' || (typeof index === 'string' && index.trim() !== ''))
        ? Math.floor(Number(index))
        : NaN;
    const at = Number(now);
    if (!Number.isFinite(i) || i < 0) return null;
    if (!Number.isFinite(at) || at <= 0) return null;
    /* THE OWNER'S APPROVED SENDERS, WHEN THEY HAVE ANY.
     *
     * `senders` is the list read from their sealed document by the handler —
     * never anything the caller sent. That distinction is the whole reason this
     * function derives the window instead of accepting one: the credential
     * behind it can read an entire mailbox, and a query a caller could shape
     * would make this a general mail-search proxy.
     *
     * With approved senders present the keyword branch is dropped, so mail from
     * anyone else is not fetched at all. With none, the built-in list plus the
     * statement vocabulary is the only way to discover what to approve.
     *
     * ── AND THAT LAST RULE HAD A TRAP IN IT ─────────────────────────────────
     *
     * Approve one bank and discovery is off FOREVER. An owner with ten banks
     * approves the three they happened to see, and the other seven can never
     * appear on the screen that offers senders to approve — because nothing
     * ever asks Gmail about them again. They reported exactly that: ten
     * accounts, three or four syncing, and no way to tell why.
     *
     * So `discover` can now be turned on deliberately for one scan. It widens
     * the QUESTION, never the answer: mail from an unapproved sender is still
     * refused before a single attachment is fetched, and all a discovery run
     * can do is put that sender's address on the list for the owner to decide
     * about. The default is unchanged for every existing caller. */
    const chosen = Array.isArray(senders) && senders.length ? senders : scanSenders();
    /* ── ONLY AN EXPLICIT REQUEST IS A DISCOVERY RUN ──────────────────────
     *
     * This used to read `discover === null ? !senders.length : discover === true`
     * — so an owner who had approved nothing got the wide branch on every
     * ordinary scan. That was harmless while "wide" only meant "add the
     * vocabulary to the query". It is NOT harmless now: a discovery window
     * reads headers only and stores nothing, so a first-time owner would have
     * scanned their mailbox and imported not one statement, and the screen
     * would have said the scan finished.
     *
     * A discovery run is now exactly what the owner asked for and nothing else.
     * The empty-sender case is handled inside planWindows(), which keeps the
     * statement vocabulary while there is nobody approved to narrow to — the
     * behaviour that was always meant by it. */
    const owns = Array.isArray(senders) && senders.length > 0;
    const windows = planWindows({
        months: m, now: at, senders: chosen,
        discover: discover === true,
        /* Someone who has approved nobody gets the statement vocabulary as well
         * as the built-in domains, so their first scan is not limited to the
         * four banks this pipeline happens to ship with. Someone who HAS
         * curated a list gets exactly that list and no guessing. */
        includeTerms: !owns,
    });
    return windows[i] || null;
}

/** How many messages this call may fetch. */
export function boundedMax(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n <= 0) return SCAN.MAX_MESSAGES_PER_CALL;
    return Math.min(SCAN.MAX_MESSAGES_PER_CALL, n);
}

/** Gmail's list URL for one window. Never built from caller-supplied text. */
export function listUrl(base, window, pageToken, max) {
    const q = new URLSearchParams({ q: String((window && window.query) || ''), maxResults: String(boundedMax(max)) });
    if (pageToken) q.set('pageToken', String(pageToken));
    return `${base}/messages?${q.toString()}`;
}

/**
 * What the page is told about one page of the scan.
 *
 * `statements` counts items STORED, not messages seen. A window with forty
 * newsletters and one statement did not scan one thing; it scanned forty and
 * found one, and a progress display that conflates them looks stuck.
 */
export function pageResult({ ids = [], stored = [], pageToken = null, skipped = [] } = {}) {
    return {
        ids: [...ids],
        statements: stored.length,
        stored: stored.map((x) => ({ key: x.key, bank: x.bank || null, filename: x.filename || null })),
        skipped: skipped.slice(0, 10),
        pageToken: pageToken || null,
    };
}
