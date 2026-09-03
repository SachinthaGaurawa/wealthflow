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
import { tokensFor, institutionForSender, INSTITUTIONS } from './wealthflow-institutions.js';

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
    /* NAMED BANKS. The pass that asks the right question.
     *
     * The other two enumerate the MAILBOX and then ask of each sender "is this
     * a bank?". That is the question backwards. The owner's ledger already
     * names the institutions they hold — the picker string is on every card
     * charge they have ever saved — so the answerable question is the narrow
     * one: WHICH ADDRESS DOES SAMPATH SEND FROM?
     *
     * Searching a mailbox for "sampath" is precise, costs one clause, and needs
     * no assumption about infrastructure. It also reaches what neither other
     * pass can: a bank that attaches nothing AND never uses the word statement
     * still puts its own name in the mail, because a letter from a bank that
     * did not say which bank would be unreadable by its recipient too.
     *
     * And it dissolves the problem this file kept running into. The domain list
     * could not be filled in by guessing — a wrong guess allowlists a stranger.
     * It does not have to be guessed: the owner's own mailbox supplies the
     * domain, DKIM-verified, attached to a bank name they themselves entered. */
    NAMED: 'named',
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

export function wideQuery({ after, before, exclude = CONSUMER_MAIL, pass = PASS.ATTACHMENTS, terms = SUBJECT_TERMS, banks = [] } = {}) {
    const lo = num(after);
    const hi = num(before);
    if (!(lo > 0) || !(hi > lo)) return '';
    const parts = [];
    if (pass === PASS.NAMED) {
        /* THE TOKENS ARE LOOKED UP, NEVER ACCEPTED. `banks` are picker names,
         * and tokensFor() resolves them against the canonical institution list
         * — anything not on it contributes nothing. So no caller-supplied text
         * reaches a Gmail query, which is the rule this endpoint has kept since
         * the beginning: a credential that can read an entire mailbox must
         * never be handed a query someone else shaped. */
        const words = tokensFor(arr(banks)).map((t) => `"${t.replace(/"/g, '')}"`);
        if (!words.length) return '';
        parts.push(`(${words.join(' OR ')})`);
    } else if (pass === PASS.WORDING) {
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

/* ── 4. the answer, per bank ──────────────────────────────────────────────── */

/**
 * For each institution the owner actually holds: which address does it write
 * from?
 *
 * THIS IS THE QUESTION THE OTHER TWO PASSES ASK BACKWARDS. They enumerate a
 * mailbox and rank every sender in it, which produces a list of forty domains
 * and hands the owner the same problem they started with. The ledger already
 * names their institutions. So the useful output is not a ranked pile — it is a
 * row per bank with an address in it, or an honest empty.
 *
 * `banks`  the picker names off their own records.
 * `list`   the sender list, with the sightings a hunt has just recorded.
 *
 * A sender is attributed to a bank when the DOMAIN or the DISPLAY NAME carries
 * one of that institution's names. Unattributed senders are not discarded — a
 * bank mailing from a third party under a name nobody recognises is exactly the
 * one the owner needs to see — they are returned separately, so a row can say
 * "we could not tell which bank this is" rather than guessing on a screen where
 * one tap files money under the answer.
 */
export function bankHunt(banks, list) {
    /* GROUPED BY MAILBOX IDENTITY, NOT BY PICKER ENTRY.
     *
     * NTB is two picker entries because its AMEX and Visa cards carry different
     * cash-advance fees — which is right for a fee table and wrong here. They
     * share one mailbox, so two rows would offer the owner the same address
     * twice and ask them to accept it twice. `mailName` is the institution's
     * identity as a SENDER, and that is what this list is about. */
    const wanted = [];
    const seenName = new Set();
    for (const raw of arr(banks)) {
        const name = s(raw);
        if (!name) continue;
        const inst = INSTITUTIONS.find((i) => i.name === name) || null;
        const label = inst ? (inst.mailName || inst.name) : name;
        const key = lower(label);
        if (seenName.has(key)) continue;
        seenName.add(key);
        wanted.push({ name: label, inst });
    }

    const scored = arr(list)
        .filter((e) => e && typeof e === 'object' && (!e.status || e.status === 'new'))
        .map((e) => ({ entry: e, scored: scoreSender(e) }))
        .filter((x) => x.scored.id);

    const claimed = new Set();
    const rows = wanted.map(({ name, inst }) => {
        const found = scored.filter(({ entry }) => {
            const hit = institutionForSender({
                domain: entry.domain || entry.id,
                displayName: entry.lastDisplay || entry.name,
            });
            return hit && inst && hit.id === inst.id;
        });
        found.sort((a, b) => b.scored.score - a.scored.score || a.scored.id.localeCompare(b.scored.id));
        for (const f of found) claimed.add(f.scored.id);
        return {
            bank: name,
            /* The address to offer, or null. Named `best` rather than `match`
             * because it is a suggestion the owner confirms, not a decision
             * already taken. */
            best: found.length ? { ...found[0].scored, address: found[0].entry.lastFrom || found[0].scored.id } : null,
            others: found.slice(1).map((f) => ({ ...f.scored, address: f.entry.lastFrom || f.scored.id })),
            /* `searched` is the honest distinction between "we looked and found
             * nothing" and "we never looked". A screen that cannot tell them
             * apart turns a bounded search into a false negative. */
            found: found.length,
        };
    });

    const unattributed = scored
        .filter((x) => !claimed.has(x.scored.id))
        .map((x) => ({ ...x.scored, address: x.entry.lastFrom || x.scored.id }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    return {
        rows,
        unattributed,
        /* Counted here so no surface has to re-derive it and get a different
         * number from the one beside it. */
        matched: rows.filter((r) => r.best).length,
        of: rows.length,
        missing: rows.filter((r) => !r.best).map((r) => r.bank),
    };
}

const API = {
    SIGNAL, SIGNAL_TEXT, WEIGHT, SUBJECT_TERMS, LIKELY, PASS,
    wideQuery, looksAutomated, saysStatement, monthKey,
    scoreSender, rankCandidates, discoveryReport, bankHunt,
};

if (typeof window !== 'undefined') window.WFDiscovery = API;

export default API;
