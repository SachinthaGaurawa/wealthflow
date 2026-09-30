/* =============================================================================
 * wealthflow-quarantine.js — statement rows into the Quarantine Zone
 * -----------------------------------------------------------------------------
 * The review queue already exists, and it is good. wfReview.openModal() draws a
 * card per held row with a "File into" dropdown, a category dropdown, and a
 * green button — and both dropdowns open on the app's own best guess, so a row
 * the guess got right is one tap and nothing else. That is exactly the
 * one-click review this pipeline was asked for.
 *
 * It has one caller. wfReview.add() takes a `brain` — the object the SMS
 * classifier produces — and reads brain.parsed, brain.routed.suggested_fields
 * and brain.resolved_merchant out of it. A statement row is none of those
 * shapes, so every row this pipeline holds back had nowhere to go: correctly
 * quarantined, and invisible.
 *
 * That is the fourth time in this pipeline that a working facility turned out
 * to serve exactly one path — the label read, the merchant lookup, the escaping
 * helper, and now the review queue. This module is the adapter, and it is
 * deliberately an adapter: nothing here re-implements a queue, a card, or a
 * filing rule.
 *
 * ── THE PRE-SELECTION IS THE WHOLE SAFETY PROPERTY ───────────────────────────
 *
 * A card whose dropdown is already correct is a card the owner confirms without
 * reading. That is the point of pre-selecting, and it is also the risk: a
 * pre-selection that contradicts the bank gets confirmed just as fast as one
 * that agrees.
 *
 * So preselect() will not offer a module whose direction disagrees with the
 * direction the bank proved. If the router's answer contradicts it — which is
 * one of the reasons a row is held in the first place — the pre-selection falls
 * back to the plain module for the direction that actually happened: money in
 * is income, money out is an expense. The owner can still choose anything they
 * like from the dropdown; what they cannot do is confirm a contradiction
 * without ever having been shown one.
 *
 * ── WHY EVERY ROW CARRIES A HASH ─────────────────────────────────────────────
 *
 * Pub/Sub delivers at least once. A statement that arrives twice is normal
 * operation, not an error, and the same is true of a mailbox re-scan after the
 * history id ages out. wfReview.add() already refuses to queue a brain whose
 * hash it has seen, so the only thing needed here is a hash that is stable
 * across deliveries — derived from what the bank printed, never from the moment
 * of processing. rowHash() is that, and there is a test that runs the same row
 * through twice and asserts the queue is asked once.
 * ===========================================================================*/

import {
    QUARANTINE, QUARANTINE_TEXT, MODULE_DIRECTION, PROVEN_SOURCES,
} from './wealthflow-mail-intake.js';

const s = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── 1. identity ──────────────────────────────────────────────────────────── */

/* Whitespace and case vary between a statement and its redelivery often enough
 * to matter; the figures do not. */
const flatten = (t) => s(t).toUpperCase().replace(/\s+/g, ' ');

/**
 * A stable identity for one printed row.
 *
 * Built only from what the bank printed — bank, date, amount, direction and
 * descriptor. Nothing here may come from the moment of processing: a hash with
 * a timestamp or a message id in it is a different hash every delivery, which
 * is the same as having no hash at all.
 */
export function rowHash(record) {
    const q = record || {};
    const row = q.row || {};
    return [
        'wfmail',
        flatten(q.bank),
        s(row.date),
        num(row.amount).toFixed(2),
        s(row.direction),
        flatten(row.desc).slice(0, 80),
    ].join('|');
}

/* ── 2. the pre-selection ─────────────────────────────────────────────────── */

/** The plainest module for a direction, used when the router's answer cannot be. */
const SAFE_MODULE = { credit: 'income', debit: 'expenses' };

/**
 * What the two dropdowns should open on.
 *
 * Returns { module, cat, safe } where `safe` says whether the router's own
 * module survived the direction check. A false there is not a failure — it is
 * the case this function exists for, and the card shows the fallback.
 */
export function preselect(record) {
    const q = record || {};
    const routed = q.routed || {};
    const row = q.row || {};
    const dir = s(row.direction);
    const proposed = s(routed.module);
    const implied = MODULE_DIRECTION[proposed];

    // A module the cross-check has no direction for — loans, goal allocations —
    // is legitimately either way, so it stands.
    if (proposed && (!implied || !dir || implied === dir)) {
        return { module: proposed, cat: s(routed.category) || null, safe: true };
    }

    return {
        module: SAFE_MODULE[dir] || 'expenses',
        // The router's category came with a module that contradicts the bank.
        // Carrying the category across while dropping the module would keep the
        // half of the answer that has no evidence behind it.
        cat: null,
        safe: false,
    };
}

/* ── 3. what the card says ────────────────────────────────────────────────── */

/**
 * The line under the merchant name. wfReview generates one when the caller
 * passes none, from fields a statement row does not have — so one is always
 * passed, and it says the thing that is actually true about this row.
 */
export function reasonFor(record) {
    const q = record || {};
    const base = QUARANTINE_TEXT[q.reason] || 'this row needs your decision';
    if (q.reason === QUARANTINE.ROUTING_CONFLICT) {
        const d = q.detail || {};
        return `${base} — the bank says ${s(d.bankSays) || '?'}, the description reads like ${s(d.descriptionSays) || '?'}`;
    }
    if (q.reason === QUARANTINE.LOW_CONFIDENCE) {
        const pct = Math.round(num((q.detail || {}).confidence) * 100);
        return `${base} (${pct}% sure)`;
    }
    return base;
}

/* ── 4. the adapter ───────────────────────────────────────────────────────── */

/* Statement rows have no currency column worth trusting; every statement this
 * pipeline accepts is from a Sri Lankan issuer. */
const DEFAULT_CURRENCY = 'LKR';

/** Milliseconds for a statement date, or now if the row carried none. */
function whenOf(row) {
    const t = Date.parse(s(row && row.date));
    return Number.isFinite(t) ? t : Date.now();
}

/**
 * Turn one quarantine record into the object wfReview.add() expects.
 *
 * The amount is a MAGNITUDE, and the module carries the direction. That is the
 * convention every existing brain follows — `suggested_fields.amount` is
 * `parsed.amount` in all of them, and income and expenses are told apart by
 * which module they were routed to, never by a sign. Putting a negative number
 * in here would be filed as a negative expense by a writer that has no reason
 * to expect one.
 */
export function toBrain(record, ctx = {}) {
    const q = record || {};
    const row = q.row || {};
    const pick = preselect(q);
    const when = whenOf(row);
    const amount = Math.abs(num(row.amount));
    const name = s((q.osint && q.osint.vendor)) || s(row.desc) || 'Unknown';

    const fields = {
        amount,
        date: when,
        cat: pick.cat || undefined,
        notes: `From ${s(q.bank) || 'a bank'} statement`,
    };
    // Each module reads its own descriptive field: income calls it a source,
    // expenses call it a desc. Both are set rather than guessed between.
    fields.source = name;
    fields.desc = name;

    return {
        ok: true,
        classified: false,
        hash: rowHash(q),
        parsed: {
            amount,
            currency: s(ctx.currency) || DEFAULT_CURRENCY,
            timestamp: when,
            raw_merchant: s(row.desc),
            direction: s(row.direction),
            directionSource: s(row.directionSource),
            /* The review queue reads this when it has to write its own reason.
             * It is only true when the bank's own arithmetic proved the
             * direction — the same test the cross-check applies, from the same
             * exported set, so the two can never disagree about what "verified"
             * means. */
            balanceVerified: PROVEN_SOURCES.has(s(row.directionSource)),
        },
        resolved_merchant: {
            name,
            category: pick.cat || 'Other',
            confidence: num(q.routed && q.routed.confidence),
        },
        routed: {
            module: pick.module,
            confidence: num(q.routed && q.routed.confidence),
            needsReview: true,
            suggested_fields: fields,
        },
        /* Provenance, for a later reader wondering why a row appeared without an
         * SMS behind it. Nothing reads it today, and it costs one key. */
        statement: { bank: s(q.bank), id: s(q.id), reason: s(q.reason), preselectSafe: pick.safe },
    };
}

/* ── 5. handing them over ─────────────────────────────────────────────────── */

/**
 * Queue every held row for review.
 *
 * `deps.add` is wfReview.add. It is injected rather than reached for through
 * `window` so that this can be tested without a browser, and so that a missing
 * review queue is a return value here instead of a crash halfway through a
 * statement.
 *
 * Rows are queued one at a time and a failure on one does not stop the rest —
 * a single unparseable row must not cost the owner the other forty.
 */
export async function toReview(records, deps = {}) {
    const add = deps.add;
    const items = arr(records);
    const out = { queued: 0, duplicates: 0, failed: 0, ids: [] };

    if (typeof add !== 'function') return { ...out, ok: false, reason: 'no-review-queue' };

    for (const q of items) {
        if (!q || q.scope === 'statement') {
            /* A statement-level failure — a password that did not open it, a
             * PDF with no text layer — is not a row anyone can categorise, and
             * putting it on a card with two dropdowns would ask the owner a
             * question that has no answer. Those surface as a notification. */
            continue;
        }
        try {
            const id = await add(toBrain(q, deps.ctx || {}), reasonFor(q));
            if (id) { out.queued += 1; out.ids.push(id); } else { out.duplicates += 1; }
        } catch (_) {
            out.failed += 1;
        }
    }
    return { ...out, ok: true };
}

const API = { rowHash, preselect, reasonFor, toBrain, toReview };
/* The page reaches this through window, the same way every other wired
 * module here does; the ESM export is what the tests and other modules
 * import. Both spellings, one object. */
if (typeof window !== 'undefined') window.WFQuarantine = API;

export default API;
