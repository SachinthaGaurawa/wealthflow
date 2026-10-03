/* =============================================================================
 * wealthflow-institutions.js — one list of the banks, at last
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * There were two lists of Sri Lankan banks in this repository, written by
 * different hands for different jobs, and nothing compared them:
 *
 *   index.html                    the picker every card charge is filed under.
 *                                 Fourteen institutions.
 *   wealthflow-mail-ingest.mjs    the domains a statement may arrive from. Four.
 *
 * A cross-check test was added for that gap and it pins the size of it. Pinning
 * a gap is not closing it. This closes it: ONE list, with the picker name, the
 * words the institution is known by, and the domains it is known to send from.
 * Every other list in the app is now derived from this one, so they cannot
 * drift apart again — the same move policy/critical-paths.regex made for the
 * policy gate, whose header says two copies of a classifier is one more than
 * can be kept in step.
 *
 * ── THE THREE FIELDS, AND WHAT EACH IS ALLOWED TO CONTAIN ───────────────────
 *
 * `name`    The EXACT string the picker offers and every stored record carries.
 *           CC_CASH_ADVANCE_FEES is keyed on these, so a character changed here
 *           silently changes a fee. There is a test that the picker still
 *           offers precisely the strings it did before this file existed.
 *
 * `tokens`  What the institution is CALLED. These are searched for in the
 *           owner's own mailbox, and that is all they do: a wrong token costs a
 *           candidate the owner declines, never a sender that gets trusted.
 *           They are facts about naming, not guesses about infrastructure.
 *
 * `domains` VERIFIED sending domains, and empty where none is verified. This
 *           list is a trust allowlist for financial documents — a domain here
 *           is a domain whose DKIM-signed mail is filed as the owner's bank
 *           statement. Nine plausible guesses would be nine entries nobody
 *           checked, and one wrong guess allowlists a stranger. So the empty
 *           ones stay empty, and the mailbox fills them in: searching for a
 *           bank BY NAME lets the owner's own mail supply the domain, which is
 *           evidence rather than assumption, and is the whole reason the
 *           name-directed hunt in wealthflow-sender-discovery.js exists.
 *
 * Pure: no network, no clock, no DOM, no storage.
 * ===========================================================================*/

const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => s(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Every institution the app offers, in the order the picker shows them.
 *
 * `domains: []` does not mean "cannot receive statements from them". It means
 * no domain has been VERIFIED yet, and until one is, that bank arrives through
 * a sender the owner approved — which the hunt now finds for them.
 */
export const INSTITUTIONS = [
    { id: 'amex', name: 'American Express (AMEX)', tokens: ['american express', 'amex'], domains: ['americanexpress.com', 'amex.com'] },
    { id: 'boc', name: 'Bank of Ceylon (BOC)', tokens: ['bank of ceylon', 'boc'], domains: [] },
    { id: 'combank', name: 'Commercial Bank', tokens: ['commercial bank', 'combank'], domains: [] },
    { id: 'dfcc', name: 'DFCC Bank', tokens: ['dfcc'], domains: ['dfcc.lk'] },
    { id: 'hnb', name: 'Hatton National Bank (HNB)', tokens: ['hatton national', 'hnb'], domains: ['hnb.lk'] },
    { id: 'ndb', name: 'National Development Bank (NDB)', tokens: ['national development bank', 'ndb'], domains: [] },
    /* NTB issues both AMEX and Visa/Mastercard with DIFFERENT cash-advance
     * fees, so the picker lists them separately and every stored record carries
     * one of the two. They share one mailbox. `mailName` is what the statement
     * pipeline labels that mail with, because "Nations Trust Bank (NTB) — AMEX"
     * would be a claim about the card the domain cannot support. */
    /* `lockId` is the id the statement registry (statement-registry.mjs) builds a statement's lock from: sha256(bank | last 4 | year | month).
     * The card PRODUCT is not part of a statement's identity — one card is one product — so the two NTB entries share one lock id, and it is
     * 'ntb-amex' because that is the id every NTB statement the email sync ever filed already carries ("Nations Trust Bank (NTB)" resolves to
     * it). Without it a Visa/Mastercard statement uploaded by hand locked as 'ntb-visa' while the same statement by email locked as 'ntb-amex',
     * and the two doors could never see each other. Never change this value: every existing registry document is keyed on it. */
    { id: 'ntb-amex', name: 'Nations Trust Bank (NTB) — AMEX', mailName: 'Nations Trust Bank (NTB)', tokens: ['nations trust', 'ntb'], domains: ['nationstrust.com'] },
    { id: 'ntb-visa', lockId: 'ntb-amex', name: 'Nations Trust Bank (NTB) — Visa/Mastercard', mailName: 'Nations Trust Bank (NTB)', tokens: ['nations trust', 'ntb'], domains: ['nationstrust.com'] },
    { id: 'panasia', name: 'Pan Asia Bank', tokens: ['pan asia'], domains: [] },
    { id: 'peoples', name: 'Peoples Bank', tokens: ['peoples bank', "people's bank"], domains: [] },
    { id: 'sampath', name: 'Sampath Bank', tokens: ['sampath'], domains: [] },
    { id: 'seylan', name: 'Seylan Bank', tokens: ['seylan'], domains: [] },
    { id: 'standard-chartered', name: 'Standard Chartered', tokens: ['standard chartered'], domains: [] },
    { id: 'union', name: 'Union Bank', tokens: ['union bank'], domains: [] },
];

/**
 * The picker, exactly as index.html offered it before this file existed.
 *
 * "Other" is last and is not an institution: it has no name to search for and
 * no domain to trust, and giving it either would make every unmatched thing
 * look like a bank.
 */
export const PICKER = [...INSTITUTIONS.map((i) => i.name), 'Other'];

/**
 * The mail pipeline's allowlist, derived — never a second list.
 *
 * ONE ENTRY PER DOMAIN. Two institutions can share a mailbox (NTB issues both
 * AMEX and Visa/Mastercard from one), and a domain listed twice would be an
 * allowlist that disagrees with itself about who a sender is.
 */
export const BANK_DOMAINS = (() => {
    const out = [];
    const seen = new Set();
    for (const i of INSTITUTIONS) {
        for (const d of i.domains) {
            const key = String(d).toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push({ domain: key, name: i.mailName || i.name, id: i.id });
        }
    }
    return out;
})();

/** Look one up by the name a stored record carries. */
export function institutionFor(name) {
    const n = norm(name);
    if (!n) return null;
    return INSTITUTIONS.find((i) => norm(i.name) === n)
        || INSTITUTIONS.find((i) => i.tokens.some((t) => norm(t) === n))
        /* Containment last, and only both-ways, so "Sampath Bank" finds
         * "Sampath" without "Bank" finding all of them. */
        || INSTITUTIONS.find((i) => n.includes(norm(i.name)) || norm(i.name).includes(n))
        || null;
}

/**
 * The words to look for in a mailbox when hunting for this institution.
 *
 * Longest first: a query that offers "hnb" before "hatton national" is no
 * worse, but a UI that shows the reason reads better naming the fuller one.
 * De-duplicated because two institutions can share a name — NTB issues both
 * AMEX and Visa cards and the app lists them separately, which is right for
 * fees and wrong for searching a mailbox twice.
 */
export function tokensFor(names) {
    const wanted = Array.isArray(names) ? names : [names];
    const out = [];
    const seen = new Set();
    for (const n of wanted) {
        const inst = institutionFor(n);
        if (!inst) continue;
        for (const t of inst.tokens) {
            const k = norm(t);
            if (!k || seen.has(k)) continue;
            seen.add(k);
            out.push(t);
        }
    }
    return out.sort((a, b) => b.length - a.length);
}

/** Verified sending domains for these institutions, if any are known. */
export function domainsFor(names) {
    const wanted = Array.isArray(names) ? names : [names];
    const out = new Set();
    for (const n of wanted) {
        const inst = institutionFor(n);
        if (inst) for (const d of inst.domains) out.add(d);
    }
    return [...out];
}

/**
 * Which institution does this sender belong to?
 *
 * Checked against the DOMAIN and the display name, because a bank's own name is
 * almost always in one or the other — `estatement@sampath.lk`, or
 * `"Seylan Bank" <noreply@…>`. Returns null rather than a guess when neither
 * carries a token: an unattributed sender is still offered to the owner, and
 * saying "I do not know which bank this is" is a better answer than naming the
 * wrong one on a screen where one tap files their money under it.
 */
export function institutionForSender({ domain = '', displayName = '' } = {}) {
    const hay = `${norm(displayName)} ${norm(domain)}`.trim();
    if (!hay) return null;
    let best = null;
    for (const inst of INSTITUTIONS) {
        for (const t of inst.tokens) {
            const k = norm(t);
            if (!k || !hay.includes(k)) continue;
            if (!best || k.length > best.len) best = { inst, len: k.length };
        }
    }
    return best ? best.inst : null;
}

/**
 * ONE NAME PER BANK.
 *
 * American Express is spelled two ways — the long name and the short one
 * ("AMEX") — and the app met both: the statement pipeline wrote one, an SMS
 * the other, a hand-typed card the third. Every place that groups by bank
 * (card filter chips, what a payment settles, the due total, the card registry
 * check) then saw two banks, so one card showed as two, with the payments on
 * one and the charges on the other never meeting.
 *
 * Only a name that is about American Express and nothing else is folded: the
 * words may be just "american", "express", "amex" and "card". "Nations Trust
 * Bank (NTB) — AMEX" is a different institution's product with its own fees
 * and is left exactly as it is, as is any name this function does not
 * recognise — an unknown bank comes back untouched, never guessed at.
 */
const AMEX_WORDS = new Set(['american', 'express', 'amex', 'card']);
export function canonicalBank(name) {
    const raw = s(name);
    const words = norm(raw).replace(/\bamericanexpress\b/g, 'american express').split(' ').filter(Boolean);
    if (!words.length || !words.every((w) => AMEX_WORDS.has(w))) return raw;
    const text = words.join(' ');
    return /\bamex\b|\bamerican express\b/.test(text) ? INSTITUTIONS.find((i) => i.id === 'amex').name : raw;
}

/**
 * HOW A BANK IS WRITTEN ON A SCREEN — and nothing else.
 *
 * A statement the email sync filed carries the label it made from the sender's mail domain (wealthflow-mail-ingest.mjs nameFromDomain): `dfccbank.com`
 * gives "Dfccbank", `hnb.lk` gives "Hnb", `nationstrust.com` gives "Nationstrust". That label is a KEY — the books, the card walk and the registry group
 * by it, and it is written by a server — so it is never rewritten. But a person reading "AI extracted 21 transactions — Dfccbank" is reading a name,
 * and the name is "DFCC Bank".
 *
 * So this turns a stored label into the institution's own name, for display. It is deliberately stricter than institutionFor(): only an exact picker
 * name, or the same letters once spaces and a trailing "bank" are taken out (the rule the registry lock applies, statement-coverage.mjs bankIdentity),
 * and never a substring — "Pan" is not Pan Asia Bank, and showing a wrong bank's name on a screen is worse than showing the label as it was.
 *
 *   "Dfccbank" / "DFCC" / "dfcc bank"      -> "DFCC Bank"
 *   "Hnb" / "HNB Bank" / "Hatton National" -> "Hatton National Bank (HNB)"
 *   "Nationstrust" / "NTB"                 -> "Nations Trust Bank (NTB)"   (the issuer; a label that names the product keeps it: "… — AMEX")
 *   a bank the app does not list           -> exactly as it was written
 */
const squashed = (v) => norm(v).replace(/ /g, '');
const stemOf = (v) => squashed(v).replace(/bank$/, '');
export function displayBank(label) {
    const raw = s(label);
    if (!raw) return raw;
    const n = norm(raw);
    const named = INSTITUTIONS.find((i) => norm(i.name) === n);
    if (named) return named.name;
    const folded = canonicalBank(raw);
    if (folded !== raw) return folded;
    const issuer = INSTITUTIONS.find((i) => i.mailName && norm(i.mailName) === n);
    if (issuer) return issuer.mailName;
    const run = stemOf(raw);
    if (run.length < 3) return raw;
    const hit = INSTITUTIONS.find((i) => [i.name, i.mailName, ...i.tokens].some((t) => t && stemOf(t) === run));
    return hit ? (hit.mailName || hit.name) : raw;
}

/** Do these two names mean the same bank? Empty never equals anything. */
export function sameBank(a, b) {
    const x = norm(canonicalBank(a)), y = norm(canonicalBank(b));
    return !!x && x === y;
}

const API = { INSTITUTIONS, PICKER, BANK_DOMAINS, institutionFor, tokensFor, domainsFor, institutionForSender, canonicalBank, displayBank, sameBank };

if (typeof window !== 'undefined') window.WFInstitutions = API;

export default API;
