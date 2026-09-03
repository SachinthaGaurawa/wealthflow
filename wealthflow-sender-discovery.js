/* =============================================================================
 * wealthflow-sender-discovery.js — finding the banks, instead of asking for them
 * -----------------------------------------------------------------------------
 * THE REQUEST
 *
 *   "I cannot find the statement emails for all my banks. Make WealthFlow able
 *    to add those emails itself."
 *
 * Fair. Hunting through years of mail for the exact address each bank sends
 * from is work no one should have to do, and getting one character wrong means
 * a bank that silently never syncs.
 *
 * ── WHY THE OLD DISCOVERY COULD NOT DO IT ───────────────────────────────────
 *
 * It asked Gmail this:
 *
 *   has:attachment filename:pdf after:… before:… ("statement" OR "e-statement"
 *     OR "estatement" OR "account advice" OR "credit advice" OR "debit advice")
 *
 * Two gates, both fatal, and both invisible when they fire:
 *
 *   filename:pdf   A bank that sends the statement as a password-protected ZIP,
 *                  as an .htm attachment, or as an attachment whose filename
 *                  carries no extension, is not in the answer. Not ranked low —
 *                  ABSENT, with nothing to say it was ever excluded.
 *
 *   six English    A subject reading "Monthly Account Summary", "Your card bill
 *   phrases        is ready", "Transaction Advice", or anything in Sinhala, does
 *                  not match. Neither does a bank that puts nothing but a
 *                  reference number in the subject.
 *
 * So the honest description of the old behaviour is not "discovery sometimes
 * misses a bank". It is that discovery asked a question a large share of banks
 * cannot answer, and reported the silence as "nothing found".
 *
 * ── THE QUESTION THIS ASKS INSTEAD ──────────────────────────────────────────
 *
 *   has:attachment after:… before:… -from:gmail.com -from:yahoo.com …
 *
 * Every message with an attachment in the window, minus the personal mailboxes.
 * No vocabulary, no file-type gate. The exclusion list is CONSUMER_MAIL, which
 * already exists and is already the rule for "this is a person, not an
 * institution" — so nothing new is being asserted, it is being asked earlier.
 * Most people's remaining attachment mail in a month is small, and every bank's
 * statement is in it whatever the bank calls it.
 *
 * The narrowing then happens HERE, on evidence, where it can be explained.
 *
 * ── WHAT IT COSTS, SAID PLAINLY ─────────────────────────────────────────────
 *
 * A wider question returns more messages. Discovery therefore reads HEADERS
 * ONLY — from, subject, date — and never downloads an attachment. That is not
 * merely cheaper: it means a discovery run over an entire mailbox cannot copy a
 * single document out of it. The existing rule was that mail from an unapproved
 * sender is refused before an attachment is fetched; this keeps it and makes it
 * structural rather than conditional.
 *
 * ── WHAT IT STILL CANNOT FIND, BECAUSE PRETENDING OTHERWISE IS WORSE ────────
 *
 * A bank that emails "your statement is ready, log in to view it" with NO
 * attachment is not in `has:attachment`, and no amount of scoring will invent
 * it. That is a real gap and it is named on the screen rather than papered
 * over: the owner can still add such a sender by hand, and the report says why
 * they have to.
 *
 * Pure: no network, no clock, no DOM, no storage.
 * ===========================================================================*/

import { CONSUMER_MAIL, addressOf, domainOf } from './wealthflow-mail-ingest.mjs';

const s = (v) => String(v == null ? '' : v).trim();
const lower = (v) => s(v).toLowerCase();
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ── 1. the question ──────────────────────────────────────────────────────── */

/** Gmail's date form. */
const ymd = (ms) => {
    const d = new Date(num(ms));
    return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
};

/**
 * The wide query for one window.
 *
 * `exclude` defaults to CONSUMER_MAIL — the same set that already decides a
 * sender is a person rather than an institution. Passing it in keeps this
 * function pure and lets a test prove the exclusion is applied rather than
 * assumed.
 */
export const PASS = {
    /* Everything with an attachment. Catches a bank whatever it CALLS its
     * mail — the pass that fixes "my bank never says the word statement". */
    ATTACHMENTS: 'attachments',
    /* Everything that SAYS statement, attachment or not. Catches the bank that
     * emails "your statement is ready, log in to view it" and attaches
     * nothing — the case the attachment pass cannot reach by construction.
     *
     * A mail with no attachment has to say what it is about, or the person
     * receiving it would not know either. So the vocabulary, which is a weak
     * signal when an attachment is present, is the only signal available when
     * one is not — and here it is a filter rather than a ranking input. */
    WORDING: 'wording',
};

export function wideQuery({ after, before, exclude = CONSUMER_MAIL, pass = PASS.ATTACHMENTS, terms = SUBJECT_TERMS } = {}) {
    const lo = num(after);
    const hi = num(before);
    if (!(lo > 0) || !(hi > lo)) return '';
    const parts = [];
    if (pass === PASS.WORDING) {
        const words = arr(terms).map(s).filter(Boolean).map((t) => `"${t.replace(/"/g, '')}"`);
        if (!words.length) return '';
        parts.push(`(${words.join(' OR ')})`);
    } else {
        parts.push('has:attachment');
    }
    parts.push(`after:${ymd(lo)}`, `before:${ymd(hi)}`);
    /* Sorted so the query is deterministic: an undecided ordering makes two
     * runs of the same scan produce two different strings, and a cursor that
     * carries a query cannot then be compared with the one it resumes. */
    for (const d of [...(exclude || [])].map(lower).filter(Boolean).sort()) {
        parts.push(`-from:${d}`);
    }
    return parts.join(' ');
}

/* ── 2. the evidence ──────────────────────────────────────────────────────── */

/** Each signal is independently checkable, and each is named on the screen. */
export const SIGNAL = {
    /** Seen in two or more DIFFERENT months. A statement is periodic. */
    RECURRING: 'recurring',
    /** Not a personal mailbox. Guaranteed by the query, re-checked here. */
    INSTITUTION: 'institution',
    /** noreply@, no-reply@, estatement@, statements@ … a machine sends these. */
    AUTOMATED: 'automated',
    /** The subject says statement, advice, e-statement and so on. */
    VOCABULARY: 'vocabulary',
    /** Seen more than a couple of times at all. */
    REPEATED: 'repeated',
};

export const SIGNAL_TEXT = {
    [SIGNAL.RECURRING]: 'arrives about once a month',
    [SIGNAL.INSTITUTION]: 'not a personal mailbox',
    [SIGNAL.AUTOMATED]: 'sent from an automated address',
    [SIGNAL.VOCABULARY]: 'the subject reads like a statement',
    [SIGNAL.REPEATED]: 'has written more than once',
};

/* Weighted, and the weights say what this believes. RECURRING is worth the most
 * because a monthly rhythm is the one thing a bank statement does that almost
 * nothing else with an attachment does. VOCABULARY is worth the LEAST because
 * it is the signal the old discovery relied on entirely, and relying on it is
 * what made banks with different wording invisible. */
export const WEIGHT = {
    [SIGNAL.RECURRING]: 0.42,
    [SIGNAL.AUTOMATED]: 0.20,
    [SIGNAL.REPEATED]: 0.16,
    [SIGNAL.INSTITUTION]: 0.14,
    [SIGNAL.VOCABULARY]: 0.08,
};

/** Local parts that mean "a machine sent this", which institutions use and people do not. */
const AUTOMATED_LOCAL = [
    'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply', 'do_not_reply',
    'estatement', 'e-statement', 'estatements', 'statement', 'statements',
    'ealerts', 'alerts', 'notification', 'notifications', 'auto', 'automail', 'mailer',
];

/**
 * Subject vocabulary. DELIBERATELY WIDER THAN THE OLD SEARCH TERMS, because
 * here it is one weak signal among five rather than a gate that decides whether
 * a bank is visible at all. `bill` and `invoice` are still absent: they describe
 * every non-statement financial mail ever sent, and letting them back in is how
 * a screen for bank statements filled up with shop receipts.
 */
export const SUBJECT_TERMS = [
    'statement', 'e-statement', 'estatement', 'account advice', 'credit advice',
    'debit advice', 'account summary', 'monthly summary', 'transaction advice',
    'card statement', 'account statement', 'summary of account',
];

export function looksAutomated(from) {
    const addr = addressOf(from);
    const local = addr.includes('@') ? addr.slice(0, addr.indexOf('@')) : '';
    if (!local) return false;
    return AUTOMATED_LOCAL.some((w) => local === w || local.startsWith(w) || local.endsWith(w));
}

export function saysStatement(subject) {
    const t = lower(subject);
    if (!t) return false;
    return SUBJECT_TERMS.some((w) => t.includes(w));
}

/** The YYYY-MM a timestamp falls in, for counting distinct months. */
export function monthKey(ms) {
    const t = num(ms);
    if (!(t > 0)) return '';
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ── 3. the verdict ───────────────────────────────────────────────────────── */

/** At or above this, the screen says "this looks like one of your banks". */
export const LIKELY = 0.5;

/**
 * Score one candidate sender.
 *
 * `candidate` is a sender-list entry as recordSighting() stores it, plus the
 * `months` set that entry now carries. Nothing is fetched and nothing is
 * assumed: a field that is absent contributes nothing rather than a default.
 *
 * Returns the score, the signals that fired, and — the part that matters — the
 * SENTENCES behind it. A ranked list with no reasons asks the owner to trust an
 * ordering they cannot check, which is exactly the posture this codebase keeps
 * removing from its AI paths.
 */
export function scoreSender(candidate) {
    const c = candidate && typeof candidate === 'object' ? candidate : {};
    const domain = lower(c.domain || domainOf(c.id) || c.id);
    const months = [...new Set(arr(c.months).map(s).filter(Boolean))];
    const seen = num(c.seenCount);

    const signals = [];
    if (months.length >= 2) signals.push(SIGNAL.RECURRING);
    if (domain && !CONSUMER_MAIL.has(domain)) signals.push(SIGNAL.INSTITUTION);
    if (looksAutomated(c.lastFrom || c.id)) signals.push(SIGNAL.AUTOMATED);
    if (saysStatement(c.lastSubject)) signals.push(SIGNAL.VOCABULARY);
    if (seen >= 2) signals.push(SIGNAL.REPEATED);

    let score = 0;
    for (const sig of signals) score += WEIGHT[sig] || 0;
    score = Math.round(Math.min(1, score) * 1000) / 1000;

    return {
        id: lower(c.id),
        domain,
        name: s(c.name),
        score,
        likely: score >= LIKELY,
        signals,
        why: signals.map((sig) => SIGNAL_TEXT[sig]).filter(Boolean),
        months: months.length,
        seenCount: seen,
    };
}

/**
 * Rank the undecided senders, best first.
 *
 * ONLY THE UNDECIDED. An approved sender is already working and a blocked one
 * was refused on purpose; putting either back in a list of suggestions asks the
 * owner to make the same decision twice, and re-offering something they blocked
 * is how a "helpful" screen becomes one people stop reading.
 */
export function rankCandidates(list) {
    const out = [];
    for (const e of arr(list)) {
        if (!e || typeof e !== 'object') continue;
        if (e.status && e.status !== 'new') continue;
        const scored = scoreSender(e);
        if (!scored.id) continue;
        out.push(scored);
    }
    out.sort((a, b) => b.score - a.score
        || b.months - a.months
        || b.seenCount - a.seenCount
        || a.id.localeCompare(b.id));
    return out;
}

/**
 * The summary a screen renders.
 *
 * `likely` and `rest` are separated rather than one list with a threshold the
 * caller re-applies: two surfaces applying the same cut-off differently is how
 * this repository's lists came to disagree in the first place.
 */
export function discoveryReport(list) {
    const ranked = rankCandidates(list);
    const likely = ranked.filter((r) => r.likely);
    return {
        ranked,
        likely,
        rest: ranked.filter((r) => !r.likely),
        found: ranked.length,
        /* WHAT IS LEFT, AFTER BOTH PASSES.
         *
         * The attachment pass finds a bank whatever it calls its mail. The
         * wording pass finds a bank that attaches nothing but says what the
         * mail is. What neither reaches is a bank that attaches nothing AND
         * never uses any of the words — which would be a mail whose own
         * recipient could not tell what it was either.
         *
         * Naming the residue is the difference between a limit and a bug. */
        cannotFind: 'a bank that attaches nothing and never uses the word statement, or anything like it',
    };
}

const API = {
    SIGNAL, SIGNAL_TEXT, WEIGHT, SUBJECT_TERMS, LIKELY, PASS,
    wideQuery, looksAutomated, saysStatement, monthKey,
    scoreSender, rankCandidates, discoveryReport,
};

if (typeof window !== 'undefined') window.WFDiscovery = API;

export default API;
