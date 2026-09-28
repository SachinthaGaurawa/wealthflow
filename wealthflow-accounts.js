/* =============================================================================
 * wealthflow-accounts.js — which of your accounts a statement belongs to
 * -----------------------------------------------------------------------------
 * A statement arrives. Is it the HNB credit card or the HNB current account?
 * Answering that decides whether its rows become card charges or bank
 * transactions, and getting it wrong files a year of spending in the wrong
 * place. This module answers it from evidence, and refuses when the evidence is
 * thin.
 *
 * ── THERE WAS NO REGISTRY TO CROSS-REFERENCE ────────────────────────────────
 *
 * The obvious design is "look the account up in settings". There is no such
 * setting. `BANKS` in index.html is a static list of fifteen Sri Lankan bank
 * NAMES for a picker; `card_last4` is stored per TRANSACTION on cconetime,
 * ccinstall and ccPayments rows; and `_ccotPickBankAsync()` is a modal that
 * ASKS which bank before every AI scan — the manual step this is meant to
 * remove. A matcher written against a registry that does not exist would never
 * match anything, silently, which is the shape of feature this codebase has
 * spent a lot of effort deleting.
 *
 * So the registry is DERIVED from the records that already exist. Every card
 * charge the user has ever saved carries a bank and a last-4; that is the
 * account list, already written down, just never collected. derive() collects
 * it. Nothing to configure, and it is right on day one because it is built from
 * what the user already did.
 *
 * ── WHY THE CONFIDENCE CAN HONESTLY REACH 95% HERE ──────────────────────────
 *
 * wealthflow-statement-router.js assigns confidence from hand-set constants
 * that top out at 0.92, so a literal 95% gate would quarantine every row and
 * the automation would not exist. The answer is not to move the number. It is
 * that matching an account supplies EVIDENCE the router never had, and three
 * independent signals agreeing is a genuinely stronger claim than any one of
 * them:
 *
 *   the last 4 digits printed on the statement match a known account
 *   the sending bank matches that account's bank
 *   the statement's own wording says which product it is
 *
 * These are independent: the digits come from the statement body, the bank from
 * a DKIM-verified sender domain, the product from the statement's vocabulary.
 * Agreement between three independent sources is worth more than a single
 * source being emphatic, and score() says so arithmetically rather than by
 * assertion. One signal alone never reaches the bar.
 *
 * ── FOUR DIGITS ARE NOT UNIQUE ──────────────────────────────────────────────
 *
 * Ten thousand values, and a person may hold six accounts — but two of THEIR
 * accounts sharing a last-4 is perfectly possible, and that is the only
 * collision that matters. When it happens the answer is not the first match; it
 * is that there is no answer, and the statement goes to review. matchAccount()
 * returns `ambiguous` rather than picking, and a test covers it.
 *
 * Pure: no DOM, no storage, no network, no clock.
 * ===========================================================================*/

/** What kind of thing an account is. The routing depends entirely on this. */
export const CREDIT_CARD = 'credit-card';
export const BANK_ACCOUNT = 'bank-account';

/* Refusals only. Success is `{ ok: true }` carrying the account, so there is no
 * MATCHED constant — one existed briefly and nothing ever read it, which is the
 * same dead-permission shape as an allowlist entry for a site that is gone. */
export const MATCH = {
    NO_ACCOUNTS: 'no-accounts-known',
    NO_LAST4: 'statement-shows-no-account-number',
    UNKNOWN_LAST4: 'no-account-with-those-digits',
    AMBIGUOUS: 'more-than-one-account-with-those-digits',
    BANK_MISMATCH: 'those-digits-belong-to-a-different-bank',
};

const arr = (v) => (Array.isArray(v) ? v : []);
const s = (v) => String(v == null ? '' : v).trim();
const norm = (v) => s(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Do two bank names refer to the same institution?
 *
 * "HNB" and "Hatton National Bank (HNB)" are the same bank written by two
 * different parts of this app: the picker in index.html stores the long form on
 * every card charge, while a DKIM-verified sender or an approved mail entry
 * carries whatever short name it was given. Containment either way, on the
 * normalised strings, is what connects them.
 *
 * EXPORTED BECAUSE THERE MUST BE ONE COPY. This rule was written inline inside
 * matchAccount(), and the moment a second caller needed it — the mail sender
 * coverage report, which answers "which of my banks can actually deliver a
 * statement" — the choice was to copy four lines or to share them. Two copies
 * of a matching rule is how the picker and the mail pipeline came to disagree
 * about which banks exist in the first place.
 */
export function bankNamesMatch(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    return x.includes(y) || y.includes(x);
}

/** The last four digits of anything, or '' — never a partial or padded guess. */
export function last4Of(v) {
    const digits = s(v).replace(/\D/g, '');
    return digits.length >= 4 ? digits.slice(-4) : '';
}

/* ── 1. the registry, learned rather than configured ──────────────────────── */

/* Which record arrays imply which kind of account. A last-4 on a card charge is
 * a credit card by definition of where it was stored; there is no inference and
 * nothing to get wrong. */
const CARD_SOURCES = ['cconetime', 'ccinstall', 'ccPayments'];

/**
 * Every account the user's own history implies, most-used first.
 *
 * `seen` is how many records name it, and it is not decoration: an account seen
 * once might be a typo in a single row, and an account seen ninety times is a
 * fact. Callers can require a floor; the default keeps everything and lets the
 * confidence score reflect the thinness instead of hiding it.
 */
export function derive(appData) {
    const A = appData || {};
    const found = new Map();

    const add = (bank, last4, kind, source) => {
        const l4 = last4Of(last4);
        const b = s(bank);
        if (!l4 || !b) return;                     // half an identity is not one
        const key = `${norm(b)}|${l4}|${kind}`;
        const prev = found.get(key);
        if (prev) { prev.seen += 1; prev.sources.add(source); return; }
        found.set(key, { bank: b, last4: l4, kind, seen: 1, sources: new Set([source]) });
    };

    for (const src of CARD_SOURCES) {
        for (const r of arr(A[src])) {
            if (!r) continue;
            add(r.bank, r.card_last4, CREDIT_CARD, src);
        }
    }

    /* Bank accounts are not recorded with a last-4 anywhere today, so the only
     * honest source is an explicit one the user supplied. This reads it if it is
     * there and invents nothing if it is not — an empty bank-account list is the
     * correct answer to "which current accounts do you have", not a reason to
     * guess from loan or income rows that carry a bank name and no number. */
    for (const r of arr(A.accounts)) {
        if (!r) continue;
        const kind = s(r.kind) === CREDIT_CARD ? CREDIT_CARD : BANK_ACCOUNT;
        add(r.bank, r.last4 || r.accountNo, kind, 'accounts');
    }

    return [...found.values()]
        .map((x) => ({ ...x, sources: [...x.sources].sort() }))
        .sort((a, b) => b.seen - a.seen || a.bank.localeCompare(b.bank));
}

/* ── 2. what the statement says about itself ──────────────────────────────── */

/* Vocabulary that only appears on one kind of statement. These are the phrases
 * Sri Lankan issuers actually print; a card statement talks about a limit and a
 * minimum due, a bank statement about opening and closing balances. */
const CARD_WORDS = /\b(credit limit|minimum (amount )?due|available credit|statement balance|payment due date|card number|cash advance limit)\b/i;
const BANK_WORDS = /\b(opening balance|closing balance|withdrawals?|deposits?|account number|available balance|value date)\b/i;

/**
 * Which product the statement's own wording implies, if it is unambiguous.
 *
 * Both vocabularies present is NOT a tie to be broken — a combined statement, or
 * a card statement quoting an account, is exactly when guessing is worst. It
 * returns null and lets the other two signals carry the decision.
 */
export function kindFromText(text) {
    const t = s(text);
    if (!t) return null;
    const card = CARD_WORDS.test(t);
    const bank = BANK_WORDS.test(t);
    if (card && !bank) return CREDIT_CARD;
    if (bank && !card) return BANK_ACCOUNT;
    return null;
}

/** Account numbers a statement prints, reduced to their last four digits. */
export function last4InText(text, limit = 8) {
    const t = s(text);
    if (!t) return [];
    const out = new Set();
    /* Masked forms first — `**** **** **** 1234`, `XXXX-1234`, `••1234` — then
     * plain runs of 8+ digits, which is what an account number looks like. A
     * bare 4-digit number is deliberately NOT matched: statements are full of
     * years, amounts and reference numbers, and treating any of them as an
     * account number is how a statement gets filed against the wrong card. */
    for (const m of t.matchAll(/(?:[*xX•·#]\s*){2,}[-\s]*(\d{4})\b/g)) out.add(m[1]);
    for (const m of t.matchAll(/\b\d{8,19}\b/g)) out.add(m[0].slice(-4));
    return [...out].slice(0, limit);
}

/* ── 3. the match ─────────────────────────────────────────────────────────── */

/**
 * Which account this statement belongs to.
 *
 * @param statement { text, bank }  bank is the DKIM-verified sender, or null
 * @param accounts  from derive()
 * @returns {{ok:true, account, evidence} | {ok:false, reason, detail}}
 */
export function matchAccount(statement, accounts) {
    const list = arr(accounts);
    if (!list.length) return { ok: false, reason: MATCH.NO_ACCOUNTS, detail: {} };

    const text = s(statement && statement.text);
    const bank = s(statement && statement.bank);
    const digits = last4InText(text);
    if (!digits.length) return { ok: false, reason: MATCH.NO_LAST4, detail: { bank } };

    const hits = list.filter((a) => digits.includes(a.last4));
    if (!hits.length) {
        return { ok: false, reason: MATCH.UNKNOWN_LAST4, detail: { digits: digits.slice(0, 4), bank } };
    }

    /* The bank narrows it, when we have one. A DKIM-verified sender is strong
     * evidence, so an account whose bank contradicts it is not a candidate. */
    const bankMatches = (a) => !bank || bankNamesMatch(a.bank, bank);
    const narrowed = hits.filter(bankMatches);
    if (bank && !narrowed.length) {
        return {
            ok: false, reason: MATCH.BANK_MISMATCH,
            detail: { bank, digits: hits.map((h) => h.last4), belongsTo: hits.map((h) => h.bank) },
        };
    }

    const finalists = narrowed.length ? narrowed : hits;
    if (finalists.length > 1) {
        /* FOUR DIGITS ARE NOT UNIQUE. Two of the user's own accounts can share
         * them, and the right answer then is that there is no answer. */
        return {
            ok: false, reason: MATCH.AMBIGUOUS,
            detail: { candidates: finalists.map((a) => ({ bank: a.bank, last4: a.last4, kind: a.kind })) },
        };
    }

    const account = finalists[0];
    const textKind = kindFromText(text);
    return {
        ok: true,
        account,
        evidence: {
            last4: true,
            bank: Boolean(bank) && bankMatches(account),
            textKind,
            textAgrees: textKind === null ? null : textKind === account.kind,
            seen: account.seen,
        },
    };
}

/* ── 4. how sure is that ──────────────────────────────────────────────────── */

/**
 * A score built from independent agreement, not asserted.
 *
 * Each signal contributes only what it is worth on its own, and the total is
 * capped below certainty because nothing here is certain. The point of the
 * arithmetic is that 0.95 is REACHABLE only when several independent things
 * agree — which is the difference between a threshold that means something and
 * one that quarantines everything.
 *
 * A signal that actively DISAGREES does not merely fail to add: it subtracts
 * past the bar. A statement whose wording says "credit card" matched to an
 * account recorded as a current account is a contradiction, and a contradiction
 * must not be rounded up by the two signals that happened to agree.
 */
export function score(evidence) {
    if (!evidence) return 0;
    let c = 0.50;                                    // a matched last-4 alone
    if (evidence.last4) c += 0.20;                   // exact, and from the statement body
    if (evidence.bank) c += 0.18;                    // a DKIM-verified sender agrees
    if (evidence.textAgrees === true) c += 0.14;     // the statement's own wording agrees
    if (evidence.textAgrees === false) c -= 0.45;    // ...or contradicts it outright
    if (Number(evidence.seen) >= 3) c += 0.04;       // not a one-off typo in a single row
    return Math.max(0, Math.min(0.99, Math.round(c * 100) / 100));
}

/** The bar: below this, a human decides. */
export const CONFIDENT = 0.95;

/**
 * The whole question, answered or refused.
 *
 * Returns the routing decision AND the numbers behind it, so the review card can
 * show why rather than asking the user to trust a verdict.
 */
export function resolve(statement, accounts, opts = {}) {
    const bar = typeof opts.confident === 'number' ? opts.confident : CONFIDENT;
    const m = matchAccount(statement, accounts);
    if (!m.ok) return { ok: false, reason: m.reason, detail: m.detail, confidence: 0 };

    const confidence = score(m.evidence);
    if (confidence < bar) {
        return {
            ok: false, reason: 'below-the-confidence-bar', confidence, bar,
            detail: { account: m.account, evidence: m.evidence },
            /* The best available answer travels with the refusal so the review
             * card can pre-select it and the user need only confirm. */
            suggestion: { bank: m.account.bank, last4: m.account.last4, kind: m.account.kind },
        };
    }
    return { ok: true, account: m.account, evidence: m.evidence, confidence };
}

export const MATCH_TEXT = {
    [MATCH.NO_ACCOUNTS]: 'no accounts have been learned from your records yet',
    [MATCH.NO_LAST4]: 'the statement does not print an account number',
    [MATCH.UNKNOWN_LAST4]: 'those last four digits do not belong to any account on file',
    [MATCH.AMBIGUOUS]: 'more than one of your accounts ends in those digits',
    [MATCH.BANK_MISMATCH]: 'those digits belong to an account at a different bank',
    'below-the-confidence-bar': 'the evidence points one way but not firmly enough',
};

const API = {
    CREDIT_CARD, BANK_ACCOUNT, MATCH, MATCH_TEXT, CONFIDENT,
    last4Of, derive, kindFromText, last4InText, matchAccount, score, resolve, bankNamesMatch,
};

if (typeof window !== 'undefined') window.WFAccounts = API;

export default API;
