/* =============================================================================
 * wealthflow-backfill.js — every statement already sitting in the mailbox
 * -----------------------------------------------------------------------------
 * The Pub/Sub hook catches statements from the moment it is switched on. Years
 * of them are already in the inbox, and they are the more valuable half: a
 * ledger that starts today cannot tell anyone what they actually spend.
 *
 * Two things make a deep scan different from the live path, and both of them
 * are here.
 *
 * ── ONE: THE LEDGER IS ALREADY FULL, AND NOBODY WAS TELLING THE DEDUP ────────
 *
 * hashRow() has existed for a long time. It is SHA-256 over the date, the
 * amount in cents, the card's last four, the reference and the normalised
 * description — exactly the cryptographic identity a backfill needs — and it is
 * tested against two thousand random inputs. classifyStatement() takes an
 * `existingHashes` set and marks anything already in it as a duplicate.
 *
 * NOTHING IN THIS APPLICATION HAS EVER PASSED THAT SET.
 *
 * Not the mail intake, not the upload path, not the UI. Every caller left it
 * empty, which means the engine has only ever de-duplicated a statement against
 * itself. Against the ledger — against the entries the owner typed in by hand —
 * it has been doing nothing at all, silently, while looking exactly like a
 * working dedup engine. That is fine while statements arrive one at a time and
 * mostly contain new rows. Backfill a year and it is the whole problem: months
 * of overlap with hand-entered data, and no check standing between them.
 *
 * ledgerHashes() is the missing half. It walks every stored record and computes
 * the SAME hash over it, so a manual entry and the statement row describing the
 * same purchase land on the same identity and the second one is refused.
 *
 * ── TWO: A DEEP SCAN MUST BE ABLE TO STOP AND START ──────────────────────────
 *
 * A mailbox with ten years in it does not fit in one pass, one function
 * invocation, or one free-tier quota. So the scan is expressed as a plan of
 * bounded windows, newest first, with a cursor that survives being interrupted.
 * Nothing here fetches anything: it decides what to fetch next, and the caller
 * with the Gmail token does the fetching. That is what makes it testable
 * without a mailbox, and what stops a runaway scan from being one bug away.
 *
 * Newest first is deliberate. If a scan is interrupted — a quota, a closed tab,
 * a revoked token — the months that did land are the recent ones, which is what
 * the dashboard is showing.
 *
 * ── THREE: SILENCE ──────────────────────────────────────────────────────────
 *
 * A backfill that notifies per statement notifies fifty times. Old rows that
 * filed correctly are not news; a phone buzzing fifty times about last March is
 * a reason to turn the feature off. notifiable() lets through only what a
 * person actually has to decide, and there is a test that runs a whole year of
 * successful statements through it and asserts total silence.
 * ===========================================================================*/

import { hashRow } from './wealthflow-statement-router.js';

const s = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── 1. what is already in the ledger ─────────────────────────────────────── */

/**
 * Every array in appData that holds something a statement row could duplicate,
 * and how to read the hashable fields out of its records.
 *
 * The field names differ per module because they were written years apart —
 * income calls the description `source`, expenses call it `desc`, card rows call
 * it `merchant`. Reading the wrong one produces a hash that matches nothing,
 * which fails silently as "no duplicates found". Each mapping below is taken
 * from the module's own records rather than assumed, and the test asserts that
 * every source named here actually appears in the app's record keys.
 */
export const LEDGER_SOURCES = {
    expenses: { desc: ['desc', 'merchant', 'name'] },
    income: { desc: ['source', 'desc', 'name'] },
    subscriptions: { desc: ['name', 'desc', 'merchant'] },
    cconetime: { desc: ['desc', 'merchant', 'name'] },
    ccinstall: { desc: ['desc', 'merchant', 'name'] },
    ccPayments: { desc: ['desc', 'note', 'name'] },
    loans: { desc: ['name', 'desc'] },
    incomeRecv: { desc: ['source', 'desc', 'name'] },
    cheques: { desc: ['payee', 'desc', 'name'] },
};

/* On the two above: naming a key that turns out not to hold transaction records
 * costs nothing — arr() returns an empty list and the loop skips it. Omitting
 * one that does hold them costs a silent duplicate on every backfilled row it
 * should have matched, which is the failure mode this whole file exists to
 * close. The asymmetry says to include them. */

/** First non-empty of several candidate fields. */
function pick(record, names) {
    for (const n of names) {
        const v = s(record && record[n]);
        if (v) return v;
    }
    return '';
}

/** A stored record, in the shape hashRow() reads. */
export function rowFromRecord(record, spec) {
    const r = record || {};
    const date = s(r.date) || (r.date_ms ? new Date(num(r.date_ms)).toISOString().slice(0, 10) : '');
    return {
        date,
        description: pick(r, (spec && spec.desc) || ['desc']),
        amount: num(r.amount),
        ref: s(r.ref) || s(r.reference) || '',
        card_last4: s(r.card_last4) || s(r.cardLast4) || '',
    };
}

/**
 * The identity of everything already stored.
 *
 * A record that already carries a `hash` contributes it directly — that is the
 * identity it was filed under. Everything else, which is every row the owner
 * typed in themselves, gets hashed here with the same function the statement
 * rows will be hashed with. Both go into one set.
 *
 * The yield is not decoration: a few thousand records is a few thousand SHA-256
 * digests, and on a phone that is a visible freeze if it is done in one pass on
 * the thread that is also drawing the dashboard.
 */
export const HASH_BATCH = 200;

export async function ledgerHashes(appData, deps = {}) {
    const A = appData || {};
    const yieldToUi = deps.yieldToUi || (() => Promise.resolve());
    const out = new Set();
    let n = 0;

    for (const [key, spec] of Object.entries(LEDGER_SOURCES)) {
        for (const record of arr(A[key])) {
            if (!record) continue;
            if (n > 0 && n % HASH_BATCH === 0) await yieldToUi();
            n += 1;
            const existing = s(record.hash);
            if (existing) { out.add(existing); continue; }
            try {
                out.add(await hashRow(rowFromRecord(record, spec)));
            } catch (_) {
                /* A record too malformed to hash cannot be matched against, and
                 * that is the honest outcome: it means a statement row for it
                 * will be filed rather than skipped. Losing one dedup is a
                 * duplicate the owner can see and delete; throwing here would
                 * lose the whole backfill. */
            }
        }
    }
    return out;
}

/* ── 2. the plan ──────────────────────────────────────────────────────────── */

/* Gmail's search is the cheapest filter available: a query that requires a PDF
 * attachment never fetches the rest of the mailbox.
 *
 * WHY THE SENDER LIST IS NO LONGER THE ONLY WAY IN. This query used to be
 * `has:attachment (from:a OR from:b ...)` over the four domains the ingest
 * allowlist happened to name. The owner banks with more than ten institutions,
 * and index.html's own bank dropdown lists fifteen — so eleven of them were
 * never even ASKED FOR. No parser bug, no rejection to look up: Gmail was
 * simply never told those messages existed.
 *
 * So the sender list stays, as the branch that catches a known bank whatever
 * its subject line says, and a keyword branch is added beside it to catch the
 * rest. The two are OR'd: a message qualifies by WHO sent it or by WHAT it
 * calls itself. `filename:pdf` keeps the volume sane either way, and no
 * category filter is applied because Gmail's search already spans Promotions
 * and Updates, which is where several banks land.
 *
 * Widening what is FETCHED does not widen what is TRUSTED. Every message still
 * has to pass the DKIM check in identifyBank before a single byte of it is
 * filed, and an unknown-but-signed sender is held for review rather than
 * accepted. See wealthflow-mail-ingest.mjs. */

/* What a bank statement calls itself. Kept deliberately short: each term is a
 * word that appears in the SUBJECT or BODY of a real statement mail, and every
 * addition widens the net for the quarantine queue too, so a term that also
 * matches shopping receipts costs the owner a review. */
export const STATEMENT_TERMS = [
    'statement',
    'e-statement',
    'estatement',
    'account advice',
    'credit advice',
    'debit advice',
    'invoice',
    'bill',
];

/** One month, as Gmail's after:/before: want it. */
const ymd = (d) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * The windows to scan, newest first.
 *
 * `months` bounds the depth and `now` is injected so the plan is a pure
 * function of its inputs — a scan planner that reads the clock cannot be
 * tested, and this one decides how much of someone's mailbox gets read.
 */
export function planWindows({ months = 24, now = Date.now(), senders = [], terms = STATEMENT_TERMS } = {}) {
    const depth = Math.max(1, Math.min(120, Math.floor(num(months)) || 1));
    const fromClauses = senders.map((x) => s(x)).filter(Boolean).map((d) => `from:${d}`);
    /* Quoted, because several are two words and an unquoted "account advice"
     * would ask Gmail for two separate terms. */
    const termClauses = (Array.isArray(terms) ? terms : []).map((t) => s(t)).filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '')}"`);
    const any = s([...fromClauses, ...termClauses].join(' OR '));
    const windows = [];
    const end = new Date(now);

    for (let i = 0; i < depth; i++) {
        const hi = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i + 1, 1));
        const lo = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
        const parts = ['has:attachment', 'filename:pdf', `after:${ymd(lo)}`, `before:${ymd(hi)}`];
        if (any) parts.push(`(${any})`);
        windows.push({
            label: `${lo.getUTCFullYear()}-${String(lo.getUTCMonth() + 1).padStart(2, '0')}`,
            query: parts.join(' '),
            after: lo.getTime(),
            before: hi.getTime(),
        });
    }
    return windows;
}

/* ── 3. the cursor ────────────────────────────────────────────────────────── */

/* What a half-finished scan needs to remember. Small enough to store beside the
 * rest of the app's state, and complete enough that resuming does not re-read a
 * window that already finished. */
export function startCursor(opts = {}) {
    const now = num(opts.now) || Date.now();
    const months = Math.max(1, Math.min(120, Math.floor(num(opts.months)) || 1));
    return {
        windows: planWindows(opts),
        index: 0,
        pageToken: null,
        done: false,
        scanned: 0,
        statements: 0,
        started: now,
        /* THE CLOCK AND THE DEPTH TRAVEL WITH THE CURSOR.
         *
         * planWindows() is a pure function of (months, now), and the server
         * rebuilds the very same window from the (months, now, index) it is
         * sent. So the clock a scan STARTED with is part of that scan's
         * identity: resume it against a fresh Date.now() and index 7 addresses
         * a different month on each side. Carrying them here is what lets a
         * cursor be put down and picked up — across a pause, a reload, or a
         * week — and still mean the same thing. */
        months,
        now,
    };
}

/* ── RESUMING ─────────────────────────────────────────────────────────────
 *
 * MAX_WINDOWS_PER_RUN bounds one RUN. Nothing bounded the SCAN, because
 * nothing carried a run's end into the next one: every call to the caller in
 * index.html built a fresh cursor at index 0. Twenty-four planned windows, six
 * done, and the message said "run it again to continue" — so the owner pressed
 * it again and got months one through six a second time. Months seven through
 * twenty-four were not slow to arrive. They were unreachable, by any number of
 * presses, and the same six months were re-fetched every time.
 *
 * That is the whole of "not all my statements sync". The plan was right, the
 * windows were right, the queries were right; the cursor was thrown away
 * between runs.
 *
 * These two functions are the memory. They are pure and they are here rather
 * than in the page for the same reason the planner is: what decides how much
 * of someone's mailbox gets read should be testable without a mailbox. */

/* Bumped when the persisted shape changes meaning. A cursor from an older
 * version is dropped rather than guessed at — resuming half-understood state
 * into a scan of somebody's mail is worse than starting over. */
export const CURSOR_VERSION = 1;

/** The small, storable record of where a scan got to. */
export function serializeCursor(cursor) {
    const c = cursor || {};
    if (!arr(c.windows).length) return null;
    return {
        v: CURSOR_VERSION,
        months: num(c.months),
        now: num(c.now),
        index: num(c.index),
        pageToken: c.pageToken ? String(c.pageToken) : null,
        scanned: num(c.scanned),
        statements: num(c.statements),
        done: !!c.done,
        total: arr(c.windows).length,
    };
}

/**
 * A cursor to scan with: the saved one when it is still the same scan, a fresh
 * one otherwise.
 *
 * A saved cursor is resumable only when it is the current version, not already
 * finished, planned to the same depth, and pointing somewhere inside its own
 * plan. Anything else — a different depth requested, a corrupt record, an index
 * past the end — starts over, which is always correct and merely slower.
 *
 * Note what is NOT a reason to refuse: age. A month-old half-finished scan
 * still describes real months of a real mailbox, and its windows are all in the
 * past, so they cannot have changed. Refusing it on age would restart at index
 * 0 — which is precisely the bug this exists to close.
 */
export function resumeCursor(saved, opts = {}) {
    const want = Math.max(1, Math.min(120, Math.floor(num(opts.months)) || 1));
    const fresh = () => startCursor({ ...opts, months: want });
    const sv = saved && typeof saved === 'object' ? saved : null;
    if (!sv) return fresh();
    if (num(sv.v) !== CURSOR_VERSION) return fresh();
    if (sv.done) return fresh();
    if (num(sv.months) !== want) return fresh();
    if (!num(sv.now)) return fresh();

    const c = startCursor({ ...opts, months: want, now: num(sv.now) });
    const index = num(sv.index);
    if (!(index >= 0) || index >= c.windows.length) return fresh();

    c.index = index;
    c.pageToken = sv.pageToken ? String(sv.pageToken) : null;
    c.scanned = num(sv.scanned);
    c.statements = num(sv.statements);
    c.done = false;
    return c;
}

/** How far along a scan is, as a fraction, for something to draw. */
export function scanProgress(cursor) {
    const c = cursor || {};
    const total = arr(c.windows).length;
    if (!total) return 0;
    if (c.done) return 1;
    return Math.max(0, Math.min(1, num(c.index) / total));
}

/**
 * Where to look next, or null when the scan is finished.
 *
 * MAX_WINDOWS_PER_RUN is what stops a deep scan from being one runaway loop.
 * A mailbox with ten years in it is 120 windows; doing them all in one
 * invocation is how a free-tier quota is spent in a minute and how a phone
 * locks up. The cursor makes stopping cheap, so stopping often is correct.
 */
export const MAX_WINDOWS_PER_RUN = 6;

export function nextStep(cursor) {
    const c = cursor || {};
    const windows = arr(c.windows);
    if (c.done || c.index >= windows.length) return null;
    return { window: windows[c.index], pageToken: c.pageToken || null, remaining: windows.length - c.index };
}

/**
 * Fold one page of results back into the cursor.
 *
 * A window is finished when Gmail stops handing back a page token — not when a
 * page comes back empty. An empty page in the middle of a window is normal
 * (every message in it was filtered out), and treating it as the end silently
 * truncates the scan at the first quiet month.
 */
export function advance(cursor, page = {}) {
    const c = { ...(cursor || {}) };
    const windows = arr(c.windows);
    c.scanned = num(c.scanned) + arr(page.ids).length;
    c.statements = num(c.statements) + num(page.statements);

    if (page.pageToken) { c.pageToken = String(page.pageToken); return c; }

    c.pageToken = null;
    c.index = num(c.index) + 1;
    c.done = c.index >= windows.length;
    return c;
}

/** Has this run done enough for now? */
export function shouldPause(startIndex, cursor, max = MAX_WINDOWS_PER_RUN) {
    const done = num((cursor || {}).index) - num(startIndex);
    return done >= Math.max(1, num(max) || 1);
}

/* ── 4. silence ───────────────────────────────────────────────────────────── */

/* The reasons a historical row is worth interrupting someone for. Everything
 * else — filed correctly, recognised as a duplicate, skipped as already known —
 * is the feature working, and the feature working is not a notification.
 *
 * Note what is NOT here: a statement that failed to open, or one with no text
 * layer. Those matter for a statement that arrived thirty seconds ago; for one
 * from March 2023 they are a line in a summary, not a buzz. */
export const NOTIFY_REASONS = new Set(['routing-conflict', 'direction-unresolved']);

export function notifiable(quarantined) {
    return arr(quarantined).filter((q) => q && q.scope === 'row' && NOTIFY_REASONS.has(s(q.reason)));
}

/**
 * What the owner is told when a backfill run finishes: one line, or nothing.
 *
 * Returning null is the common case and the correct one. A run that filed
 * ninety rows from last spring and held none back has nothing to say that could
 * not wait for the dashboard the owner is already looking at.
 */
export function runSummary(result) {
    const r = result || {};
    const applied = num(r.applied);
    const dupes = num(r.duplicates);
    const needs = arr(r.notify).length;
    if (!needs) return null;
    const bits = [`${needs} transaction${needs === 1 ? '' : 's'} from your old statements need${needs === 1 ? 's' : ''} a look`];
    if (applied) bits.push(`${applied} filed automatically`);
    if (dupes) bits.push(`${dupes} already in your records`);
    return bits.join(' · ');
}

const API = {
    LEDGER_SOURCES, HASH_BATCH, MAX_WINDOWS_PER_RUN, NOTIFY_REASONS, CURSOR_VERSION,
    rowFromRecord, ledgerHashes, planWindows, startCursor, nextStep, advance,
    shouldPause, notifiable, runSummary, serializeCursor, resumeCursor, scanProgress,
};

/* The page reaches this through window, the same way every other wired
 * module here does; the ESM export is what the tests and other modules
 * import. Both spellings, one object. */
if (typeof window !== 'undefined') window.WFBackfill = API;

export default API;
