/* =============================================================================
 * wealthflow-vendor-osint.js — Agent 2: what is this vendor, actually?
 * -----------------------------------------------------------------------------
 * A statement row that reads `POS 412345XXXXXX7788 SPAR SUPERMARKET COL 03` is
 * unambiguous to a person and opaque to a keyword table. The router grades it
 * low-confidence, the cross-check sends it to the Quarantine Zone, and the
 * owner ends up tapping through fifty rows that a two-second web lookup could
 * have named.
 *
 * That lookup already exists: /api/merchant-search does a real search across
 * Tavily, Brave, Serper or Gemini and comes back with a category. What did not
 * exist was any way for a bank statement to reach it — the endpoint has exactly
 * one caller, wealthflow-queue.js, on the SMS path. This module is the second
 * caller, and it is not a copy of the first, because a statement row carries
 * something an SMS does not: a direction the bank itself proved by arithmetic.
 *
 * ── THE ONE RULE THIS MODULE EXISTS TO ENFORCE ───────────────────────────────
 *
 * A web search can name a merchant. It can NEVER decide whether money came in
 * or went out.
 *
 * That sounds obvious and it is the exact mistake waiting to be made, because
 * the shape of the answer invites it. Ask the web about a restaurant and it
 * says "Dining", which means an expense — and the row in front of you is a
 * REFUND from that restaurant, a credit, money returning to the account. Apply
 * the category and its implied direction together and a refund is filed as a
 * spend: income and expense mixed, from a source that never saw the money move.
 *
 * So direction comes only from the bank's own figures, and a finding whose
 * implied direction disagrees with them is not averaged, not weighted, not
 * used as a tiebreak. It is rejected, and the row stays in the Quarantine Zone
 * where a person decides. applyFinding() copies no direction field, ever;
 * there is a test that reads the returned object and fails if it differs from
 * the input by one.
 *
 * ── WHAT LEAVES THE DEVICE ───────────────────────────────────────────────────
 *
 * A vendor name and a country. That is the whole payload, it is built by one
 * exported function so that it can be asserted on, and SAFE_KEYS names the only
 * two keys allowed in it. No amount, no balance, no date, no account number, no
 * last four digits, no bank name, no reference.
 *
 * The descriptor itself is scrubbed before it goes anywhere, because the raw
 * string frequently contains the masked card number and a reference number.
 * vendorKey() drops any token carrying four or more digits, and any token that
 * mixes digits with masking characters. `7 ELEVEN` and `CAFE 24` survive
 * intact; `412345XXXXXX7788` and `20260115` and `REF 887302911` do not. If what
 * is left is not recognisably a name, the answer is null and no request is
 * made — sending a bare reference number would leak an identifier and could not
 * return an answer anyway.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 *
 * It does not retry, and it does not queue for later. Every failure — no
 * provider key configured, network down, malformed answer, a category this
 * module has never heard of — returns null and leaves the row exactly as the
 * cross-check left it. The fallback for "the web could not tell us" is the
 * Quarantine Zone, which is a working feature, not an error state. A lookup
 * layer that retries in the background is a lookup layer that fails silently.
 * ===========================================================================*/

import { QUARANTINE, MODULE_DIRECTION, PROVEN_SOURCES } from './wealthflow-mail-intake.js';

const s = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── 1. outcomes ──────────────────────────────────────────────────────────── */

export const OSINT = {
    APPLIED: 'applied',
    NO_VENDOR: 'no-vendor-name',
    NOT_ELIGIBLE: 'not-eligible',
    CONTRADICTS_BANK: 'contradicts-the-bank',
    UNKNOWN_CATEGORY: 'category-not-recognised',
    NO_ANSWER: 'no-answer',
    UNAVAILABLE: 'lookup-unavailable',
};

/** Said in the owner's language, for the review card. */
export const OSINT_TEXT = {
    [OSINT.NO_VENDOR]: 'there is no merchant name in this row to look up',
    [OSINT.NOT_ELIGIBLE]: 'this row is not held up by its category',
    [OSINT.CONTRADICTS_BANK]: 'the web says this is a purchase, the bank says the money came in',
    [OSINT.UNKNOWN_CATEGORY]: 'the answer was not a category this app files things under',
    [OSINT.NO_ANSWER]: 'the search could not identify this merchant',
    [OSINT.UNAVAILABLE]: 'the lookup was not reachable',
};

/* ── 2. cleaning the descriptor ───────────────────────────────────────────── */

/* Tokens that appear on statements as machinery, not as part of any name. Kept
 * deliberately short: every entry here is a word that can never be the whole
 * identity of a business, and a longer list starts eating real names. */
const NOISE = new Set([
    'POS', 'ATM', 'TXN', 'TRN', 'REF', 'NO', 'VISA', 'MASTERCARD', 'MASTER',
    'AMEX', 'CARD', 'DEBIT', 'CREDIT', 'PURCHASE', 'PMT', 'TRANSACTION',
    'LKR', 'USD', 'EUR', 'GBP', 'PAYMENT',
]);

/** Does this token look like a card fragment, a reference, or a date? */
function isIdentifier(token) {
    const digits = (token.match(/\d/g) || []).length;
    if (digits >= 4) return true;                       // refs, dates, card tails
    if (digits >= 1 && /[X*#]/i.test(token)) return true; // 4123XXXX7788, 45**12
    return false;
}

/**
 * The searchable name inside a statement descriptor, or null if there isn't one.
 *
 * Returning null is a real answer and the common one for cash withdrawals and
 * inter-account transfers. It means "do not make a request", which is both the
 * private choice and the correct one.
 */
export function vendorKey(text) {
    const raw = s(text).toUpperCase();
    if (!raw) return null;

    const kept = raw
        .replace(/[^A-Z0-9X*#\s.&'-]+/gi, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((t) => !isIdentifier(t))
        .filter((t) => !NOISE.has(t.replace(/[.'-]+$/g, '')));

    const name = kept.join(' ').replace(/\s+/g, ' ').trim();
    // Two letters is an initialism at best and noise at worst; below that there
    // is nothing a search engine could match.
    if ((name.match(/[A-Z]/g) || []).length < 3) return null;
    return name.slice(0, 64);
}

/* ── 3. the request ───────────────────────────────────────────────────────── */

export const ENDPOINT = '/api/merchant-search';

/* The complete set of keys permitted to leave the device. This is a list, not a
 * comment, so that a test can assert the payload against it and fail when a
 * future edit adds a "helpful" field like the amount or the account. */
export const SAFE_KEYS = ['merchant', 'country'];

/** Exactly what goes on the wire. Nothing reads the row to build this. */
export function payloadFor(key, country) {
    return { merchant: s(key), country: s(country) || 'Sri Lanka' };
}

/* Every category /api/merchant-search declares it can return, and where each
 * one files. A category outside this map is NOT mapped to a default — an answer
 * this app does not recognise is not evidence, and quietly treating it as an
 * expense is how a new upstream category becomes a misfiled transaction. */
export const CATEGORY_MODULE = {
    'Food & Groceries': 'expenses', Dining: 'expenses', Transport: 'expenses',
    Fuel: 'expenses', Utilities: 'expenses', Telecom: 'expenses',
    Healthcare: 'expenses', Education: 'expenses', Entertainment: 'expenses',
    Subscriptions: 'subscriptions', Shopping: 'expenses',
    'Shopping (Fashion)': 'expenses', 'Electronics & Tech': 'expenses',
    'Shopping (Home)': 'expenses', Insurance: 'expenses', Rent: 'expenses',
    'Personal Care': 'expenses', 'Kids & Family': 'expenses', Pets: 'expenses',
    Travel: 'expenses', Charity: 'expenses', Government: 'expenses',
    Banking: 'expenses',
    // 'Other' is absent on purpose: it is the endpoint saying it does not know,
    // and it must not read as a successful identification.
};

/** Where a returned category files, or null if the answer carries no filing. */
export function moduleForCategory(category) {
    const c = s(category);
    return Object.prototype.hasOwnProperty.call(CATEGORY_MODULE, c) ? CATEGORY_MODULE[c] : null;
}

/* ── 4. eligibility ───────────────────────────────────────────────────────── */

/**
 * Should this quarantined row be looked up at all?
 *
 * Three conditions, and the second is the one that matters:
 *
 *  1. It is held up by its CATEGORY. A row quarantined because the bank's
 *     figures and its description disagree is not a naming problem, and a
 *     merchant name cannot resolve it.
 *
 *  2. Its direction was proven by the bank's own arithmetic. A row whose
 *     direction is unresolved cannot be filed no matter what comes back, so the
 *     request would spend a vendor name for nothing — and, worse, an answer
 *     sitting next to an unresolved direction is an invitation to use it as one.
 *     Refusing here means that temptation never has a row to act on.
 *
 *  3. There is a name in the descriptor worth sending.
 */
export function eligible(quarantined) {
    const q = quarantined || {};
    if (q.reason !== QUARANTINE.LOW_CONFIDENCE) {
        return { ok: false, reason: OSINT.NOT_ELIGIBLE, detail: { was: q.reason || 'none' } };
    }
    const row = q.row || {};
    if (!PROVEN_SOURCES.has(s(row.directionSource)) || !s(row.direction)) {
        return {
            ok: false,
            reason: OSINT.NOT_ELIGIBLE,
            detail: { why: 'the direction was not proven by the bank’s own figures' },
        };
    }
    const key = vendorKey(row.desc || row.narration);
    if (!key) return { ok: false, reason: OSINT.NO_VENDOR, detail: {} };
    return { ok: true, key };
}

/* ── 5. asking ────────────────────────────────────────────────────────────── */

/* A finding never lifts a row to certainty. It is one search engine's reading
 * of a shop name; it is enough to file a row that was only ever held up for
 * lacking a category, and it is not enough to claim the row is settled. */
export const MAX_LIFT = 0.9;

/**
 * Ask the endpoint about one vendor. Returns a finding or null.
 *
 * `fetchImpl` is injected so tests can read what went on the wire rather than
 * trusting a comment about it.
 */
export async function ask(key, deps = {}, ctx = {}) {
    const fetchImpl = deps.fetch;
    if (typeof fetchImpl !== 'function' || !s(key)) return null;
    try {
        const res = await fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloadFor(key, ctx.country)),
        });
        if (!res || !res.ok) return null;
        const d = await res.json();
        if (!d || d.ok !== true) return null;
        const category = s(d.category);
        if (!category) return null;
        return {
            category,
            module: moduleForCategory(category),
            description: s(d.description) || null,
            provider: s(d.provider) || 'unknown',
            confidence: Math.min(MAX_LIFT, num(d.confidence) || 0.82),
        };
    } catch (_) {
        /* Unreachable, refused, timed out, or answered with something that is
         * not JSON. All of them mean the same thing to the caller, and none of
         * them are worth a retry when the fallback is a working review card. */
        return null;
    }
}

/* ── 6. the firewall ──────────────────────────────────────────────────────── */

/**
 * Turn a finding into an upgraded routing — or refuse.
 *
 * The returned object is built from `routed`, never from `row`, and it carries
 * no direction field of its own. The row's direction and directionSource are
 * left untouched by construction, not by care.
 */
export function applyFinding(routed, finding, row) {
    const r = routed || {};
    const f = finding || {};
    const dir = s(row && row.direction);

    if (!f.category) return { ok: false, reason: OSINT.NO_ANSWER, detail: {} };
    if (!f.module) {
        return { ok: false, reason: OSINT.UNKNOWN_CATEGORY, detail: { category: f.category } };
    }

    const implied = MODULE_DIRECTION[f.module];
    if (implied && dir && implied !== dir) {
        /* THE REFUND CASE, AND EVERY CASE SHAPED LIKE IT.
         *
         * The web named the shop correctly and the row is still not a purchase.
         * There is no arithmetic here that can tell which reading is right, and
         * the bank's is the only one backed by a balance that moved, so the
         * finding is dropped whole — its category too, not just its direction.
         * A category that only makes sense in the other direction is not a
         * partial win. */
        return {
            ok: false,
            reason: OSINT.CONTRADICTS_BANK,
            detail: { bankSays: dir, webSays: implied, category: f.category },
        };
    }

    return {
        ok: true,
        routed: {
            ...r,
            module: f.module,
            category: f.category,
            confidence: Math.min(MAX_LIFT, Math.max(num(r.confidence), num(f.confidence))),
            needsReview: false,
            vendorSource: 'web:' + f.provider,
            vendorDescription: f.description || undefined,
        },
    };
}

/* ── 7. the batch ─────────────────────────────────────────────────────────── */

/**
 * Look up every quarantined row that a lookup could rescue.
 *
 * Rows are grouped by vendor key first, so forty rows from one supermarket cost
 * one request rather than forty. The cache is per call and holds only what came
 * back from the endpoint — it never persists, because a category the owner has
 * since corrected must not be re-applied from a stale copy of a web search.
 *
 * Returns the same two lists intakeStatement returns, so the caller can splice
 * the result straight back in.
 */
export async function enrich(quarantined, deps = {}, ctx = {}) {
    const items = arr(quarantined);
    const upgraded = [];
    const remaining = [];
    const cache = new Map();
    let lookups = 0;

    if (typeof deps.fetch !== 'function') {
        // No way to ask. Every row stays exactly as it arrived — not marked as
        // failed enrichment, because nothing was attempted.
        return { upgraded, remaining: items.slice(), lookups: 0, reason: OSINT.UNAVAILABLE };
    }

    for (const q of items) {
        const check = eligible(q);
        if (!check.ok) { remaining.push(q); continue; }

        if (!cache.has(check.key)) {
            lookups += 1;
            cache.set(check.key, await ask(check.key, deps, ctx));
        }
        const finding = cache.get(check.key);
        if (!finding) {
            remaining.push({ ...q, osint: { reason: OSINT.NO_ANSWER, vendor: check.key } });
            continue;
        }

        const applied = applyFinding(q.routed, finding, q.row);
        if (!applied.ok) {
            remaining.push({ ...q, osint: { reason: applied.reason, vendor: check.key, detail: applied.detail } });
            continue;
        }
        upgraded.push({ ...q, routed: applied.routed, osint: { reason: OSINT.APPLIED, vendor: check.key } });
    }

    return { upgraded, remaining, lookups };
}

const API = {
    OSINT, OSINT_TEXT, ENDPOINT, SAFE_KEYS, CATEGORY_MODULE, MAX_LIFT,
    vendorKey, payloadFor, moduleForCategory, eligible, ask, applyFinding, enrich,
};

/* The page reaches this through window, the same way every other wired
 * module here does; the ESM export is what the tests and other modules
 * import. Both spellings, one object. */
if (typeof window !== 'undefined') window.WFVendorOsint = API;

export default API;
