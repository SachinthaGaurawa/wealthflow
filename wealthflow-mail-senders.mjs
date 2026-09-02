/* =============================================================================
 * wealthflow-mail-senders.mjs — whose mail counts as a statement
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * The owner reported bills, receipts and invoices arriving in a screen meant
 * for bank statements. Three causes, and all three are mine:
 *
 * ONE. STATEMENT_TERMS carried `invoice` and `bill` — the two words that
 * describe every non-statement financial email ever sent. They were used to
 * BUILD the Gmail query, so those messages were fetched; and again in
 * looksLikeStatement, so they were accepted. A utility bill matched twice.
 *
 * TWO. identifyBank stopped gating on the allowlist in #164 — correctly, since
 * eleven of the owner's banks were being dropped by it — and nothing took over
 * the job it had been doing badly. Any DKIM-signed domain that was not a
 * personal mailbox got in. A streaming service's receipt is signed perfectly
 * well.
 *
 * THREE, and worst: planMessage computed `known: false` for an unrecognised
 * sender, and the comment beside it said the write path holds those for review.
 * It does not. Neither gmail-hook.js nor gmail-scan.js ever read the field —
 * planWrite's manifest has no place for it — so "held for review" existed only
 * in the sentence describing it. Everything that passed went to the same place.
 * I wrote that comment. It was never true.
 *
 * ── WHY A LIST THE OWNER KEEPS, RATHER THAN A CLEVERER FILTER ───────────────
 *
 * The obvious repair is a better guess: more words, negative words, a score.
 * Every version of that is wrong the same way — it decides, on the owner's
 * behalf, which of their own senders are banks, and it gets some of them wrong
 * forever without ever saying which. The owner has fifteen institutions and
 * knows exactly what they are. Nothing here can know that better than they do.
 *
 * So the guess is demoted to a SUGGESTION. What arrives is recorded as a
 * sighting; the owner approves the real senders and blocks the rest; and the
 * approved list becomes the Gmail query, which means an unapproved sender is
 * not filtered out after being fetched — it is never asked for.
 *
 * ── WHAT THIS FILE IS NOT ──────────────────────────────────────────────────
 *
 * It is not a security boundary and must never be read as one. DKIM is the
 * control: a message must carry a passing signature from the domain it claims
 * to be from, and that check lives in wealthflow-mail-ingest.mjs and runs
 * whatever this list says. Approval here means "this is one of mine", not
 * "trust this". A blocked entry, by contrast, IS honoured absolutely — refusing
 * on the owner's instruction can only ever narrow what is accepted, so it is
 * safe in the direction that matters.
 *
 * Pure, and therefore testable without a mailbox: nothing here fetches, stores
 * or reads a clock it was not handed.
 * ===========================================================================*/

import { domainOf, isUnder, nameFromDomain, CONSUMER_MAIL } from './wealthflow-mail-ingest.mjs';

const lower = (s) => String(s == null ? '' : s).toLowerCase().trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const arr = (v) => (Array.isArray(v) ? v : []);

export const STATUS = { APPROVED: 'approved', BLOCKED: 'blocked', NEW: 'new' };

/* Bounded, because this list is written from what arrives in a mailbox and an
 * unbounded one is a way to fill someone's storage with a mail loop. The two
 * ceilings are separate on purpose: a flood of discovered senders must never
 * be able to push out an entry the owner typed in themselves. */
export const MAX_DECIDED = 200;
export const MAX_NEW = 60;

/* A domain label is 63 characters and a whole domain 253; an address adds a
 * local part. Anything longer is not a sender, it is a payload. */
const MAX_ID = 254;

export const REASON = {
    EMPTY: 'nothing-to-add',
    NO_DOMAIN: 'that-does-not-contain-a-domain',
    TOO_LONG: 'that-is-longer-than-an-address-can-be',
    BAD_CHARS: 'a-domain-cannot-contain-that',
    CONSUMER: 'that-is-a-personal-mailbox-not-an-institution',
    PUBLIC_SUFFIX: 'that-is-a-whole-country-or-category-not-a-sender',
};

/* Approving `lk` or `com` would approve the internet. These are the suffixes a
 * hurried entry is most likely to reduce to, and they are refused with a
 * sentence rather than silently accepted as a domain that matches everything.
 * Not a complete public-suffix list — a complete one is a megabyte and a
 * dependency, and the failure this guards is a typo, not an attack. */
const PUBLIC_SUFFIXES = new Set([
    'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'io', 'co',
    'lk', 'uk', 'us', 'in', 'au', 'ca', 'nz', 'sg', 'my', 'ae', 'eu',
    'co.uk', 'co.in', 'com.au', 'co.nz', 'com.sg', 'com.my', 'co.za',
    'com.lk', 'net.lk', 'org.lk', 'gov.lk', 'edu.lk',
]);

/* Domain labels, an optional local part in front. Deliberately strict: this
 * value is compared against a From header and rendered in a list, and a lax
 * pattern here is how a display string ends up being treated as a domain. */
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const LOCAL_RE = /^[a-z0-9._%+-]+$/;

/**
 * What the owner typed, as something that can be matched against a From header.
 *
 * Accepts far more shapes than it stores, because the owner is copying out of a
 * mail client: `HNB <statements@hnb.lk>`, `statements@hnb.lk`, `@hnb.lk`,
 * `hnb.lk`, and the same with stray spaces or a trailing comma all arrive here.
 * Exactly two things come out: an ADDRESS or a DOMAIN.
 */
export function normalizeSender(input) {
    let raw = lower(input).replace(/[,;]+$/, '').trim();
    if (!raw) return { ok: false, reason: REASON.EMPTY };
    if (raw.length > MAX_ID + 80) return { ok: false, reason: REASON.TOO_LONG };

    /* `Name <addr>` — take what is inside the angle brackets. */
    const angled = /<([^>]*)>/.exec(raw);
    if (angled) raw = angled[1].trim();
    /* A bare `mailto:` survives a copy out of some clients. */
    raw = raw.replace(/^mailto:/, '').trim();

    let local = '';
    let domain = raw;
    const at = raw.lastIndexOf('@');
    if (at >= 0) {
        local = raw.slice(0, at).trim();
        domain = raw.slice(at + 1).trim();
    }
    domain = domain.replace(/^\.+|\.+$/g, '').trim();

    if (!domain) return { ok: false, reason: REASON.NO_DOMAIN };
    if (domain.length > MAX_ID) return { ok: false, reason: REASON.TOO_LONG };
    /* CHECKED BEFORE THE PATTERN, so the message is the useful one.
     * `lk` has no dot and fails DOMAIN_RE, so the pattern check answered first
     * and told the owner a domain "can only hold letters, digits, dots and
     * hyphens" — about a string containing two letters. A single label is never
     * a sender, and the sentence they need is the one that says use the whole
     * domain. */
    if (PUBLIC_SUFFIXES.has(domain) || !domain.includes('.')) {
        return { ok: false, reason: REASON.PUBLIC_SUFFIX };
    }
    if (!DOMAIN_RE.test(domain)) return { ok: false, reason: REASON.BAD_CHARS };
    if (CONSUMER_MAIL.has(domain)) return { ok: false, reason: REASON.CONSUMER };

    if (local) {
        if (!LOCAL_RE.test(local)) return { ok: false, reason: REASON.BAD_CHARS };
        const id = `${local}@${domain}`;
        if (id.length > MAX_ID) return { ok: false, reason: REASON.TOO_LONG };
        return { ok: true, kind: 'address', id, domain };
    }
    return { ok: true, kind: 'domain', id: domain, domain };
}

/** One stored entry, with every field defaulted so a partial record is safe. */
function entryOf(e) {
    /* The object test is not decoration. `e && e.id` on the number 0 yields 0,
     * and lower(0) is the string "0" — so a stored array holding a stray zero
     * became an entry with the id "0". A document read back from Firestore is
     * not something to trust the shape of. */
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const id = lower(e.id);
    if (!id) return null;
    const kind = id.includes('@') ? 'address' : 'domain';
    const status = [STATUS.APPROVED, STATUS.BLOCKED, STATUS.NEW].includes(e.status)
        ? e.status : STATUS.NEW;
    return {
        id,
        kind,
        domain: kind === 'address' ? id.slice(id.lastIndexOf('@') + 1) : id,
        name: String(e.name || '').slice(0, 60),
        status,
        source: e.source === 'manual' ? 'manual' : 'discovered',
        addedMs: num(e.addedMs),
        lastSeenMs: num(e.lastSeenMs),
        seenCount: num(e.seenCount),
        /* Kept only for a sender the owner has not decided on yet: it is the
         * thing that lets them recognise what a domain actually is. Capped hard
         * because it is mail content being carried into a settings screen. */
        lastSubject: String(e.lastSubject || '').slice(0, 120),
    };
}

/** The stored list, cleaned: no junk, no duplicates, bounded, ordered. */
export function normalizeList(list) {
    const seen = new Map();
    for (const raw of arr(list)) {
        const e = entryOf(raw);
        if (!e) continue;
        const prior = seen.get(e.id);
        /* A decided entry always beats an undecided one for the same id, so a
         * later sighting can never quietly un-approve something. */
        if (prior && prior.status !== STATUS.NEW && e.status === STATUS.NEW) continue;
        seen.set(e.id, prior ? { ...prior, ...e, seenCount: Math.max(prior.seenCount, e.seenCount) } : e);
    }
    const all = [...seen.values()];
    const decided = all.filter((e) => e.status !== STATUS.NEW);
    const fresh = all.filter((e) => e.status === STATUS.NEW);

    /* Manual entries are never evicted; among discovered ones the least
     * recently seen goes first. */
    decided.sort((a, b) => (a.source === 'manual' ? -1 : 0) - (b.source === 'manual' ? -1 : 0)
        || num(b.lastSeenMs) - num(a.lastSeenMs)
        || a.id.localeCompare(b.id));
    fresh.sort((a, b) => num(b.lastSeenMs) - num(a.lastSeenMs) || a.id.localeCompare(b.id));

    return [...decided.slice(0, MAX_DECIDED), ...fresh.slice(0, MAX_NEW)];
}

/**
 * What the owner's list says about a From header.
 *
 * MOST SPECIFIC WINS. An entry for `promo@hnb.lk` beats one for `hnb.lk`, and a
 * longer domain beats a shorter one, so a bank's marketing address can be
 * blocked without losing its statements. Among entries of EQUAL specificity a
 * block beats an approval — the only tie-break that can be wrong in the safe
 * direction.
 */
export function matchSender(list, from) {
    const entries = normalizeList(list);
    const raw = lower(from);
    const angled = /<([^>]*)>/.exec(raw);
    const address = (angled ? angled[1] : raw).replace(/^mailto:/, '').trim();
    const domain = domainOf(from);
    if (!domain) return { verdict: STATUS.NEW, entry: null, address: '', domain: '' };

    let best = null;
    let bestScore = -1;
    for (const e of entries) {
        if (e.status === STATUS.NEW) continue;
        let score = -1;
        if (e.kind === 'address') {
            if (e.id === address) score = 1000 + e.id.length;
        } else if (isUnder(domain, e.id)) {
            score = e.id.length;
        }
        if (score < 0) continue;
        if (score > bestScore
            || (score === bestScore && e.status === STATUS.BLOCKED && best && best.status !== STATUS.BLOCKED)) {
            best = e; bestScore = score;
        }
    }
    if (!best) return { verdict: STATUS.NEW, entry: null, address, domain };
    return { verdict: best.status, entry: best, address, domain };
}

/** Add or update an entry from something the owner typed. */
export function addSender(list, input, { status = STATUS.APPROVED, name = '', now = 0 } = {}) {
    const parsed = normalizeSender(input);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, list: normalizeList(list) };

    const want = [STATUS.APPROVED, STATUS.BLOCKED].includes(status) ? status : STATUS.APPROVED;
    const existing = normalizeList(list);
    const idx = existing.findIndex((e) => e.id === parsed.id);
    const label = String(name || '').trim().slice(0, 60)
        || (idx >= 0 ? existing[idx].name : '')
        || nameFromDomain(parsed.domain);

    const next = {
        ...(idx >= 0 ? existing[idx] : {}),
        id: parsed.id,
        kind: parsed.kind,
        domain: parsed.domain,
        name: label,
        status: want,
        /* Typed in by hand outranks discovered, and never the other way: an
         * entry the owner created should not become evictable because a message
         * later arrived from it. */
        source: 'manual',
        addedMs: (idx >= 0 && existing[idx].addedMs) || num(now),
    };
    const out = idx >= 0 ? existing.map((e, i) => (i === idx ? next : e)) : [next, ...existing];
    return { ok: true, list: normalizeList(out), entry: entryOf(next) };
}

/** Change an entry's decision. Used by approve and block on a discovered row. */
export function setStatus(list, id, status, { now = 0 } = {}) {
    const want = [STATUS.APPROVED, STATUS.BLOCKED, STATUS.NEW].includes(status) ? status : STATUS.NEW;
    const key = lower(id);
    let found = false;
    const out = normalizeList(list).map((e) => {
        if (e.id !== key) return e;
        found = true;
        return { ...e, status: want, addedMs: e.addedMs || num(now) };
    });
    return { ok: found, list: normalizeList(out) };
}

/** Forget an entry entirely. A removed sender becomes discoverable again. */
export function removeSender(list, id) {
    const key = lower(id);
    const before = normalizeList(list);
    const out = before.filter((e) => e.id !== key);
    return { ok: out.length !== before.length, list: out };
}

/**
 * Note that a message arrived from this sender.
 *
 * This is the gathering the owner asked for: rather than being told to go and
 * find their banks' addresses, the addresses come to them. A sighting NEVER
 * changes a decision — an approved sender stays approved and a blocked one
 * stays blocked, and only the counters move.
 */
export function recordSighting(list, { from = '', subject = '', now = 0 } = {}) {
    const domain = domainOf(from);
    if (!domain) return normalizeList(list);
    /* Recorded at domain level. An address-level sighting would fill the screen
     * with one row per no-reply variant of the same bank. */
    if (CONSUMER_MAIL.has(domain)) return normalizeList(list);

    const entries = normalizeList(list);
    const hit = matchSender(entries, from);
    const id = hit.entry ? hit.entry.id : domain;
    const idx = entries.findIndex((e) => e.id === id);

    if (idx >= 0) {
        const e = entries[idx];
        const next = {
            ...e,
            lastSeenMs: Math.max(num(e.lastSeenMs), num(now)),
            seenCount: num(e.seenCount) + 1,
            lastSubject: e.status === STATUS.NEW ? String(subject || '').slice(0, 120) : e.lastSubject,
        };
        return normalizeList(entries.map((x, i) => (i === idx ? next : x)));
    }
    return normalizeList([{
        id: domain,
        kind: 'domain',
        domain,
        name: nameFromDomain(domain),
        status: STATUS.NEW,
        source: 'discovered',
        addedMs: num(now),
        lastSeenMs: num(now),
        seenCount: 1,
        lastSubject: String(subject || '').slice(0, 120),
    }, ...entries]);
}

/* ── what the scanner asks Gmail for ──────────────────────────────────────── */

/**
 * The approved senders, as Gmail `from:` clauses.
 *
 * This is where the list stops being a filter and becomes the question. An
 * unapproved sender is not fetched and then discarded — it is never asked for,
 * which costs no quota, no attachment download and no row on a screen.
 */
export function approvedClauses(list) {
    /* FETCH BY DOMAIN, DECIDE BY ADDRESS.
     *
     * This used to emit `from:statements@hnb.lk` for an address entry — an
     * EXACT-address query. The owner adds the address printed on the statement
     * they are looking at; the bank then sends the next one from
     * `estatement@hnb.lk`, or `no-reply@`, or `alerts@`, and it is never
     * fetched. Not filtered out, not held for review: never asked for. The
     * owner had done everything right and the statement was invisible, which is
     * exactly what they reported.
     *
     * So the QUERY widens to the domain while the POLICY stays where they put
     * it. matchSender is untouched, so only the address they approved is filed
     * automatically; another address at the same domain arrives as a sender
     * waiting for a decision, with one tap to accept it. Widening what is
     * FETCHED cannot file anything — that is what makes this safe — and it is
     * the only way a bank's second address can ever become visible.
     *
     * De-duplicated: two approved addresses at one domain are one clause, not
     * two identical ones. */
    const seen = new Set();
    const out = [];
    for (const e of normalizeList(list)) {
        if (e.status !== STATUS.APPROVED) continue;
        const clause = `from:${e.domain}`;
        if (seen.has(clause)) continue;
        seen.add(clause);
        out.push(clause);
    }
    return out;
}

/** Has the owner curated this list at all? */
export function hasApproved(list) {
    return normalizeList(list).some((e) => e.status === STATUS.APPROVED);
}

/** The three buckets, ready to render. */
export function groupForDisplay(list) {
    const all = normalizeList(list);
    return {
        approved: all.filter((e) => e.status === STATUS.APPROVED),
        blocked: all.filter((e) => e.status === STATUS.BLOCKED),
        pending: all.filter((e) => e.status === STATUS.NEW),
    };
}

/**
 * The list, in the shape identifyBank and planMessage consume.
 *
 * Built here rather than at each call site so the two server entry points — the
 * push hook and the scan endpoint — cannot end up applying different rules to
 * the same mailbox. That divergence is not hypothetical: a hardening applied to
 * one of a pair and not the other is this repository's most repeated defect,
 * and these two files have already drifted once.
 *
 * `curated` is the switch that turns the guess off. It is true the moment the
 * owner approves one sender, and while it is false the keyword vocabulary still
 * decides, because someone who has approved nothing needs a way to find out
 * what to approve.
 */
export function policyFrom(list) {
    const entries = normalizeList(list);
    return {
        decide: (from) => matchSender(entries, from),
        /* Approved domains only. A blocked domain is not something to protect
         * from impersonation — it is already refused whatever it looks like. */
        domains: entries.filter((e) => e.status === STATUS.APPROVED).map((e) => e.domain),
        curated: entries.some((e) => e.status === STATUS.APPROVED),
    };
}

export const REASON_TEXT = {
    [REASON.EMPTY]: 'Type an address or a domain first.',
    [REASON.NO_DOMAIN]: 'That has no domain in it. Try statements@yourbank.lk, or just yourbank.lk.',
    [REASON.TOO_LONG]: 'That is longer than an email address can be.',
    [REASON.BAD_CHARS]: 'A domain can only hold letters, digits, dots and hyphens.',
    [REASON.CONSUMER]: 'That is a personal mailbox, not an institution. Approving it would let anyone with an account there send you statements.',
    [REASON.PUBLIC_SUFFIX]: 'That is not one sender — it is a whole category of the internet, or a name with no domain on it. Use the full domain, like hnb.lk.',
};

const API = {
    STATUS, REASON, REASON_TEXT, MAX_DECIDED, MAX_NEW,
    normalizeSender, normalizeList, matchSender, addSender, setStatus, removeSender,
    recordSighting, approvedClauses, hasApproved, groupForDisplay, policyFrom,
};

/* The page reaches this through window, the same way every other wired module
 * here does; the ESM export is what the tests and the server import. */
if (typeof window !== 'undefined') window.WFMailSenders = API;

export default API;
