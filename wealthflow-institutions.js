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
    { id: 'ntb-amex', name: 'Nations Trust Bank (NTB) — AMEX', mailName: 'Nations Trust Bank (NTB)', tokens: ['nations trust', 'ntb'], domains: ['nationstrust.com'] },
    { id: 'ntb-visa', name: 'Nations Trust Bank (NTB) — Visa/Mastercard', mailName: 'Nations Trust Bank (NTB)', tokens: ['nations trust', 'ntb'], domains: ['nationstrust.com'] },
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

const API = { INSTITUTIONS, PICKER, BANK_DOMAINS, institutionFor, tokensFor, domainsFor, institutionForSender };

if (typeof window !== 'undefined') window.WFInstitutions = API;

export default API;
