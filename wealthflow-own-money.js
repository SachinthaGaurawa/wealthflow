/* =============================================================================
 * wealthflow-own-money.js — whose money is this row?   (window.WFOwnMoney)
 * -----------------------------------------------------------------------------
 * A bank statement row that names one of the owner's OWN credit cards is the owner's own money moving, not income and not spending:
 *
 *   "Cash advance cr 376657******0276"      money drawn on the owner's AMEX arriving in the bank account. It was filed as +LKR 100,000 Income, "Other": borrowed money
 *                                           counted as earnings, and the AMEX statement counts the same advance again as a card charge.
 *   "Inward Ceft Transfer 376657Xxxxx0276"  the owner's own card paying into the account.
 *   "Outward Ceft Transfer 376657Xxxxx0276" the owner paying their own card.
 *   "CEFTS/6454/KULASOORIYAGE S/Transfer"   a transfer that names the owner (their surname, or a house name made from it): their own money from another account of theirs.
 *
 * A payment to the owner's own card is left out of the books on the bank side too, by BOTH doors: the card's own statement says "payment received" and that line is the one that settles the card's
 * charges. Filing the bank's line as well counts the same payment twice (the manual upload used to, as a Card Payment). Where only the bank's statement is uploaded, the owner can still choose
 * Card Payment for the row in the review list; it is then filed against the right card.
 *
 * Two doors read bank statements — the email worker (statement-sync.js, through the router) and the owner's manual upload (index.html, through wealthflow-route.js) — and each
 * had its own idea of this: the worker's own-account rule fired only on rows worded as transfers, the page's only on the OUTWARD card payment, and neither looked at the Cards &
 * Accounts registry for a credit. The page also guessed a bank from a number's shape instead of asking whether the owner holds that card. This file is the ONE answer; both doors
 * call it, so a row cannot be one thing on the page and another by email (test/own_money_test.js reads both with the same rows).
 *
 * What it knows, in order of strength:
 *   registered-card   the masked number's last four are in the owner's Cards & Accounts registry as a CREDIT CARD (a registry entry that says bank account is never a card)
 *   known-tail        the last four are on one of the owner's own statements or cards, and the number is shaped like a card (a six-digit BIN, then the mask)
 *   card-number       a cash advance names a card-shaped number the owner has not registered: only the account holder can draw cash into their own account, so the card is theirs
 *   words             "cash advance" and nothing else
 * and never a bank statement of a card (the card's own statement is the other half of the same money), never a refund or a reversal (those reduce an expense that is already
 * in the books), and never a fee ("Ceft Charges 376657Xxxxx0276" is a bank charge, filed as one).
 *
 * Pure: no network, no clock, no storage. ESM for the server; the page loads it as a module and reads window.WFOwnMoney.
 * ===========================================================================*/

/* a masked number: "376657******0276", "376657Xxxxx0276", "XXXX0276", "****0276". A bare four digits is an amount or a reference and never counts. */
const MASKED = /(?:(\d{4,6})[x*•#]{2,}|[x*•#]{2,})[\s-]?(\d{4})(?!\d)/gi;
const CASH_ADVANCE = /\b(?:cash\s*adv(?:ance)?|advance\s+from\s+(?:mb|cc|card))\b/i;
const REVERSAL = /\b(?:refund(?:ed|s)?|revers(?:al|ed)|charge\s*back|cash\s*back|rebate|reimburs\w*)\b/i;
const FEE = /\b(?:fees?|charges?|levy|duty|vat|tax(?:es)?|interest|commission|surcharge)\b/i;

const NETWORK_OF_BIN = [[/^3[47]/, 'amex'], [/^4/, 'visa'], [/^(?:5[1-5]|2[2-7])/, 'mastercard']];
const brandOf = (bin) => { const hit = NETWORK_OF_BIN.find(([re]) => re.test(bin || '')); return hit ? hit[1] : ''; };
const networkOf = (value) => { const text = String(value || '').toLowerCase(); return /amex|american/.test(text) ? 'amex' : /visa/.test(text) ? 'visa' : /master/.test(text) ? 'mastercard' : ''; };
/* shaped like a card, not like a bank account: a full six-digit BIN of a network that issues cards, then the mask */
const cardShaped = (bin) => String(bin || '').length >= 6 && /^[3-6]/.test(bin);

/** The masked numbers a narration carries, with what their digits say: [{ last4, bin, brand, cardShaped }]. */
export function numbersIn(text) {
    const out = [];
    for (const match of String(text || '').matchAll(MASKED)) {
        const bin = match[1] || '';
        out.push({ last4: match[2], bin, brand: brandOf(bin), cardShaped: cardShaped(bin) });
    }
    return out;
}

const tailSet = (tails) => (tails instanceof Set ? tails : new Set(Array.isArray(tails) ? tails.map((tail) => String(tail).slice(-4)) : []));

/* is this masked number one of the OWNER'S cards? 'registered-card' | 'known-tail' | '' — and '' for a number the registry calls a bank account */
function ownCardOf(number, registry, tails) {
    const entry = registry && typeof registry === 'object' ? registry[number.last4] : null;
    if (entry && entry.type === 'bank_account') return '';
    const network = entry ? networkOf(entry.network) : '';
    // the digits and the registry must not contradict each other: an AMEX registered at 0276 is not a Visa 4xxxxx…0276
    if (network && number.brand && network !== number.brand) return '';
    if (entry && entry.type === 'credit_card') return 'registered-card';
    if (number.cardShaped && tailSet(tails).has(number.last4)) return 'known-tail';
    return '';
}

/**
 * What a BANK-account row says about the owner's own cards, or null when it says nothing about them.
 * @param {{description?:string, direction?:string, isCard?:boolean, registry?:object, tails?:Set<string>|string[], names?:Set<string>|string[], local?:string, initials?:Set<string>|string[]}} input
 *   isCard: the statement is a credit card's own (then the card's number in a row is not a second account); registry: settings.cardRegistry; tails: every tail the owner is known to hold;
 *   names / local / initials: the owner's own name words, the mailbox's local part and the initials of their name (statement-transfers.mjs `ownerWords` on the server, the saved payment accounts and the sign-in on the page) — only a row worded as a transfer can name the owner
 * @returns {null|{kind:'card-cash-advance-in'|'card-money-in'|'card-payment-out'|'own-name-transfer', last4:string, brand:string, evidence:string, reason:string}}
 */
export function ownMoney({ description = '', direction = '', isCard = false, registry = {}, tails = [], names = null, local = '', initials = null } = {}) {
    if (isCard) return null;
    const dir = /^cr/i.test(String(direction)) ? 'credit' : /^d/i.test(String(direction)) ? 'debit' : '';
    if (!dir) return null;
    const text = String(description || '');
    const numbers = numbersIn(text);
    const owned = numbers.map((number) => ({ number, evidence: ownCardOf(number, registry, tails) })).find((item) => item.evidence);
    const advance = CASH_ADVANCE.test(text);
    const last4 = (hit) => (hit ? hit.last4 : ''), brand = (hit) => (hit ? hit.brand : '');
    if (dir === 'credit') {
        if (REVERSAL.test(text)) return null;
        if (advance) {
            const named = owned ? owned.number : numbers.find((number) => number.cardShaped);
            const evidence = owned ? owned.evidence : named ? 'card-number' : 'words';
            return { kind: 'card-cash-advance-in', last4: last4(named), brand: brand(named), evidence,
                reason: 'cash drawn on a credit card' + (named ? ' ••' + named.last4 : '') + ' — borrowed money moving into this account, not income (the card statement carries the advance)' };
        }
        if (owned) return { kind: 'card-money-in', last4: owned.number.last4, brand: owned.number.brand, evidence: owned.evidence,
            reason: 'money from your own card ••' + owned.number.last4 + ' — your own money moving between your accounts, not income' };
        return byName(text, dir, names, local, initials);
    }
    if (owned && !advance && !FEE.test(text)) return { kind: 'card-payment-out', last4: owned.number.last4, brand: owned.number.brand, evidence: owned.evidence,
        reason: 'payment to your own card ••' + owned.number.last4 + ' — the card\'s own statement carries it (choose Card Payment for this row if you do not file that statement)' };
    return owned ? null : byName(text, dir, names, local, initials);
}

/* A transfer that names the owner is the owner's own money moving between their own accounts (the bar statement-transfers.mjs has always had). Not a fee, not a refund. */
function byName(text, dir, names, local, initials) {
    if (!/\btransfer\b/i.test(text) || FEE.test(text) || (dir === 'credit' && REVERSAL.test(text))) return null;
    const word = nameOfOwnerIn(text, { names, local, initials });
    if (!word) return null;
    return { kind: 'own-name-transfer', last4: '', brand: '', evidence: 'own-name',
        reason: (dir === 'credit' ? 'transfer from' : 'transfer to') + ' an account in your own name — your own money moving between your accounts, not ' + (dir === 'credit' ? 'income' : 'spending') };
}

/** True when the bank-side row is left out of the books: the other side of the money (the card's statement, the owner's other account) carries it. Every kind this file knows. */
export const leavesTheBooks = (own) => !!own && typeof own.kind === 'string';

/**
 * The first word of a narration that is the owner's own name, or ''. Whole words of five letters or more only (an initial is not a name), the way the server has always read the owner's name. Plus the Sri Lankan
 * house name: a family's "-ge" form ("Kulasooriyage" is the family Kulasooriya) is the family's word too — but a family has more than one member, so the narration must also carry a lone initial that is one of
 * the owner's own ("KULASOORIYAGE S" for a Sachintha; "KULASOORIYAGE P" is someone else of the house). No initials known, no house-name reading.
 * @param {string} text
 * @param {{names?:Set<string>|string[], local?:string, initials?:Set<string>|string[]}} own the owner's name words (lower case), the mailbox's local part and the initials of their name
 */
export function nameOfOwnerIn(text, { names = null, local = '', initials = null } = {}) {
    const set = names instanceof Set ? names : new Set(Array.isArray(names) ? names : []);
    const mine = initials instanceof Set ? initials : new Set(Array.isArray(initials) ? initials : []);
    const mailbox = String(local || '');
    if (!set.size && !mailbox) return '';
    const lower = String(text || '').toLowerCase();
    const words = lower.match(/[a-z]{5,}/g) || [];
    const lone = () => lower.split(/[^a-z]+/).some((token) => token.length === 1 && mine.has(token));
    return words.find((word) => set.has(word) || (mailbox && word.length >= 6 && mailbox.includes(word)) || (word.length >= 8 && word.endsWith('ge') && set.has(word.slice(0, -2)) && mine.size > 0 && lone())) || '';
}

/* words that name a kind of account or a kind of company, not a person: never taken as the owner's name */
const TITLE = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'rev', 'prof', 'sir']);
const NOT_A_NAME = new Set(['limited', 'private', 'holdings', 'company', 'enterprises', 'enterprise', 'trading', 'traders', 'associates', 'group', 'savings', 'current', 'account', 'accounts', 'business', 'services']);
/**
 * The owner's name from the account holders on the payment accounts they saved — their own accounts, shown to the people who pay them: the words (lower case, five letters or more, no titles or company words)
 * and the initials (the first letter of every part of the name: "K S G Kulasooriya" gives k, s, g).
 * @param {Array<string>} holders e.g. ['K S G Kulasooriya']
 * @returns {{words:string[], initials:string[]}}
 */
export function holderName(holders) {
    const words = [], initials = [];
    for (const holder of Array.isArray(holders) ? holders : []) {
        for (const token of String(holder || '').toLowerCase().match(/[a-z]+/g) || []) {
            if (NOT_A_NAME.has(token) || TITLE.has(token)) continue;
            if (token.length >= 5 && !words.includes(token)) words.push(token);
            if (!initials.includes(token[0])) initials.push(token[0]);
        }
    }
    return { words, initials };
}

const API = { ownMoney, numbersIn, leavesTheBooks, nameOfOwnerIn, holderName };

if (typeof window !== 'undefined') window.WFOwnMoney = API;

export default API;
