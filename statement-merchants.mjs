/* =============================================================================
 * statement-merchants.mjs — the merchant list the email pipeline was never given
 * -----------------------------------------------------------------------------
 * Two classifiers read the same bank narrations. The app (wealthflow-merchants.js) knows ~950 Sri Lankan merchants from merchants.json; the server path that files
 * emailed statements (wealthflow-statement-router.js) knew about 130 brand words in sixteen regular expressions. Of the 950 merchants the app knows, the server
 * called 584 "Other" — and "Other" is where a row waits for an AI board that must agree unanimously (and in the production log of 2026-10-02 had no quota to try).
 *
 * This module gives the server the same list, with the care a server needs:
 *   · text is CLEANED first: card numbers, terminal ids, references, cities, countries and payment-gateway wrappers ("PAYME-VISA*", "PAYPAL *", "SQ *", "IPG*")
 *     are removed, so the category cannot depend on what the terminal wrapped around the merchant;
 *   · a key matches only as whole WORDS (no substring, no glue, no truncation): a server files money, it does not search;
 *   · the MOST SPECIFIC key wins ("amazon prime" over "amazon"); two different kinds of business that fit equally well are an AMBIGUITY, never a pick;
 *   · a line that names only a gateway and a city identifies nothing and is reported as such;
 *   · nothing here ever names a category it is not sure of: the caller keeps its own "Other", and the owner is given the question (inquiryFor) with the candidates.
 *
 * Pure: no network, no clock, no storage. merchants.json is read at import time.
 * ===========================================================================*/

import { readFileSync } from 'node:fs';
import { setMerchantClassifier } from './wealthflow-statement-router.js';

/* merchants.json is read where it lives next to this file. This module is SERVER-ONLY: the page never imports it (the router takes it by injection, below), so the
 * 950-merchant list costs the page nothing — the app carries its own copy of the list and its own engine. If the server cannot read the file, that is said once in
 * the log and the router keeps the rules it always had; it never classifies from a half-loaded list. */
function loadRegistry() {
    try {
        const parsed = JSON.parse(readFileSync(new URL('./merchants.json', import.meta.url), 'utf8'));
        return parsed && Array.isArray(parsed.merchants) ? parsed : { merchants: [] };
    } catch (error) {
        try { console.warn(JSON.stringify({ evt: 'merchant-list-unavailable', reason: String(error && error.message || error).slice(0, 120) })); } catch (_) { /* a log line never stops a sync */ }
        return { merchants: [] };
    }
}
const registry = loadRegistry();

/* The registry's names → the names the server files under. Streaming/Software are what the app's registry calls Entertainment/Subscriptions; Internet is a telecom bill.
 * null = deliberately not mapped: Leasing is a finance company (a loan repayment, not a purchase), Bank Charges/Other are not merchants, Gym/Fitness has no server name. */
export const SERVER_CATEGORY = Object.freeze({
    Telecom: 'Telecom', Internet: 'Telecom', Insurance: 'Insurance', Streaming: 'Entertainment', Software: 'Subscriptions', Utilities: 'Utilities',
    Groceries: 'Groceries', Dining: 'Dining', Health: 'Health', Transport: 'Transport', Fuel: 'Fuel', Education: 'Education', Government: 'Government',
    Shopping: 'Shopping', Gold: 'Gold', 'Gym/Fitness': 'Personal Care', Leasing: null, 'Cash Advance': null, 'Cash Withdrawal': 'Cash Withdrawal', 'Bank Charges': null, Other: null,
});
/* The categories this module can add to what the router already knew. The router appends them to the vocabulary the AI board is allowed to answer in. */
export const REGISTRY_CATEGORIES = Object.freeze([...new Set(Object.values(SERVER_CATEGORY).filter(Boolean))]);

/* Short single-word keys are the ones that are also ordinary words or somebody else's initials ("box", "bus", "gold", "plc", "sap", "avg", "tex"). Only these well-known
 * names are trusted at four letters or fewer; the rest are left to the router's own rules, to the owner's history and to the owner. */
const SHORT_KEYS_TRUSTED = new Set(['kfc', 'ioc', 'lioc', 'aia', 'aig', 'axa', 'ebay', 'nike', 'odel', 'oppo', 'temu', 'xbox', 'xero', 'zoho', 'zoom', 'hbo', 'hulu', 'viu', 'dazn', 'uber', 'ceb', 'leco', 'wasa', 'slt', 'rda', 'ctb', 'sltb', 'aws', 'ibm', 'jira', 'nibm', 'nsbm', 'ousl', 'mpcs', 'spar', 'koko', 'yego', 'bata']);
/* Same family = one recurring bill under two names. */
const FAMILY = { Telecom: 'net', Internet: 'net' };
const familyOf = (category) => FAMILY[category] || category;

/* The payment gateways and card-network words a terminal prints where the shop's name should be. */
const GATEWAY_WORDS = new Set(['payme', 'payhere', 'ipg', 'paypal', 'sq', 'square', 'stripe', '2checkout', 'paddle', 'mpgs', 'ecom', 'ecommerce', 'visa', 'master', 'mastercard', 'txn', 'transaction', 'pos', 'online', 'card', 'purchase', 'debit', 'credit', 'ref', 'reference', 'merch', 'merchant', 'payment', 'pay', 'dcc', 'ib', 'atm']);
const COUNTRIES = new Set(['lk', 'lka', 'sg', 'us', 'usa', 'gb', 'uk', 'ae', 'au', 'in', 'my', 'th']);
const CITIES = new Set(['colombo', 'kandy', 'kurunegala', 'kuliyapitiya', 'negombo', 'galle', 'matara', 'jaffna', 'gampaha', 'nugegoda', 'dehiwala', 'moratuwa', 'maharagama', 'kalutara', 'kaluthara', 'panadura', 'ratnapura', 'badulla', 'anuradhapura', 'dambulla', 'homagama', 'mirigama', 'meerigama', 'mattegoda', 'wellampitiya', 'ibbagamuwa', 'kadawatha', 'malabe', 'piliyandala', 'wattala', 'ratmalana', 'jaela', 'singapore', 'london']);
const NOISE_WORDS = new Set(['pvt', 'ltd', 'plc', 'limited', 'private', 'the', 'and', 'of', 'co', 'www', 'com', 'lk']);

/* The town, the country and the company-form words a terminal prints AFTER the name. A registry key that ends in one ("daraz lk", "zoom us", "mac mart kandy") would be a
 * longer, different key from the same merchant without it, so the answer would depend on what the terminal appended — both sides are trimmed the same way. */
const TAIL = (word) => CITIES.has(word) || COUNTRIES.has(word) || NOISE_WORDS.has(word);
const trimTail = (words) => { let end = words.length; while (end > 1 && TAIL(words[end - 1])) end--; return end === words.length ? words : words.slice(0, end); };

/** A narration as the words that could name a business: lower-case, no punctuation, none of the terminal's, the gateway's or the town's words. */
export function merchantWords(narration) {
    const text = String(narration == null ? '' : narration).normalize('NFKC').toLowerCase().slice(0, 400);
    const raw = text.replace(/\d{4,6}[x*\s]{3,}\d{4}(?!\d)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    const out = [];
    for (const word of raw) {
        if (/^\d+$/.test(word)) continue;                                           // terminal, branch, postal, reference numbers
        if (/^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}$/.test(word)) continue; // "2k4ty1qr0", "ab12cd34": a gateway's reference blob
        out.push(word);
    }
    return out;
}
/** The words that remain once the gateway, city, country and company-form words are taken away — what is left to identify the merchant by. */
export function identifyingWords(narration) {
    return merchantWords(narration).filter((word) => !GATEWAY_WORDS.has(word) && !CITIES.has(word) && !COUNTRIES.has(word) && !NOISE_WORDS.has(word));
}
/** True when the line names a gateway and/or a place and nothing else ("PAYME-VISA*COLOMBO", "POS Transaction - MIRIGAMA"): nobody, however clever, can say what it was. */
export function isGatewayOnly(narration) {
    return merchantWords(narration).length > 0 && identifyingWords(narration).length === 0;
}

const MAX_KEY_WORDS = 6;
const index = new Map();      // "key words joined" → { key, category (server), source (registry category) }
(function build() {
    const list = Array.isArray(registry && registry.merchants) ? registry.merchants : [];
    for (const entry of list) {
        if (!entry || typeof entry.key !== 'string') continue;
        const mapped = SERVER_CATEGORY[entry.category];
        if (!mapped) continue;
        const words = trimTail(merchantWords(entry.key));
        if (!words.length || words.length > MAX_KEY_WORDS) continue;
        if (words.length === 1 && words[0].length <= 4 && !SHORT_KEYS_TRUSTED.has(words[0])) continue;
        const joined = words.join(' ');
        const old = index.get(joined);
        if (old && old.category !== mapped) { index.set(joined, { key: joined, category: null, source: entry.category, words: words.length, conflict: true }); continue; }   // the list disagrees with itself: trusted by nobody
        index.set(joined, { key: joined, category: mapped, source: entry.category, words: words.length });
    }
})();
export const REGISTRY_SIZE = index.size;

/**
 * What the registry says about a narration.
 * @returns {null | {category:string, key:string, confidence:number} | {category:null, ambiguous:true, candidates:string[], keys:string[]}}
 *   null = no key matched; a category = the most specific key, no rival; ambiguous = two kinds of business fit equally well.
 */
export function registryLookup(narration) {
    const words = trimTail(merchantWords(narration));
    if (!words.length) return null;
    const hits = [];
    for (let start = 0; start < words.length; start++) {
        let joined = '';
        for (let length = 1; length <= MAX_KEY_WORDS && start + length <= words.length; length++) {
            joined = length === 1 ? words[start] : joined + ' ' + words[start + length - 1];
            const hit = index.get(joined);
            if (hit) hits.push({ ...hit, span: [start, start + length] });
        }
    }
    if (!hits.length) return null;
    let win = hits[0];
    for (const hit of hits) if (hit.words > win.words || (hit.words === win.words && hit.key.length > win.key.length)) win = hit;
    if (win.conflict) return { category: null, ambiguous: true, candidates: [], keys: [win.key] };
    const rivals = new Set();
    for (const hit of hits) {
        if (hit === win || hit.conflict) continue;
        if (familyOf(hit.source) === familyOf(win.source)) continue;
        if (hit.span[0] >= win.span[0] && hit.span[1] <= win.span[1]) continue;     // a part of the winner's own name ("amazon" inside "amazon prime")
        if (hit.category === win.category) continue;
        rivals.add(hit.category);
    }
    if (rivals.size) return { category: null, ambiguous: true, candidates: [win.category, ...rivals], keys: hits.map((hit) => hit.key) };
    return { category: win.category, key: win.key, confidence: 0.9 };
}

/* WHAT A BUSINESS SELLS, NOT WHO IT IS. "<anyone> Pharmacy", "<anyone> Bakers", "<anyone> Filling Station": the registry cannot list every shop, but these words say what the
 * shop does. Words that say only how a firm TRADES ("traders", "enterprises", "stores", "distributors", "technologies") are not here on purpose: a guess with a confident face is
 * how a hardware shop becomes "Shopping". A name with industry words from two different kinds of business is an ambiguity, not a pick. */
const INDUSTRY = Object.freeze({
    Health: ['pharmacy', 'pharmacies', 'medstore', 'hospital', 'nursing home', 'clinic', 'dental', 'laborator*', 'diagnostic*', 'channell*', 'osusala', 'ayurved*', 'optic*', 'surgical'],
    Dining: ['restaurant', 'restaurent', 'cafe', 'caffe', 'coffee', 'bakery', 'bakers', 'pizza', 'burger', 'kottu', 'food court', 'foodcourt', 'fast food', 'ice cream', 'creamery', 'crepe', 'liquor', 'bistro', 'buffet', 'cafeteria', 'barbeque', 'bbq'],
    Groceries: ['supermarket', 'super market', 'grocer*', 'mini mart', 'minimart', 'supercent*', 'super cent*', 'mpcs', 'sathosa', 'provision*', 'general store', 'daily needs'],
    Transport: ['interchange', 'expressway', 'rent a car', 'car rent', 'bus depot', 'railway', 'parking', 'cab service', 'taxi'],
    Fuel: ['filling station', 'fuel station', 'petrol shed', 'petroleum', 'service station'],
    Gold: ['jewellers', 'jewellery', 'jewelers', 'goldsmith', 'gold shop'],
    Shopping: ['apparel', 'garment*', 'textile*', 'dress point', 'dress shop', 'fashion', 'boutique', 'footwear', 'furniture', 'hardware', 'electronic*', 'computer*', 'mobile shop', 'phone shop', 'bookshop', 'book shop', 'stationery'],
    Education: ['institute', 'campus', 'college', 'academy', 'university', 'tuition'],
    Utilities: ['water board', 'electricity'],
    'Personal Care': ['gym', 'fitness', 'health club', 'yoga'],
});
const industryRules = Object.entries(INDUSTRY).flatMap(([category, words]) => words.map((word) => {
    const stem = word.endsWith('*'), parts = word.replace(/\*$/, '').split(' ');
    return { category, word: word.replace(/\*$/, ''), stem, parts };
}));
function industryHits(words) {
    const hits = new Set(), seen = [];
    for (const rule of industryRules) {
        for (let start = 0; start + rule.parts.length <= words.length; start++) {
            let ok = true;
            for (let k = 0; k < rule.parts.length && ok; k++) {
                const have = words[start + k], want = rule.parts[k];
                ok = k === rule.parts.length - 1 && rule.stem ? have.startsWith(want) : have === want;
            }
            if (ok) { hits.add(rule.category); seen.push(rule.word); break; }
        }
    }
    return { categories: [...hits], words: seen };
}

/**
 * The server's whole answer about a merchant: the registry's most specific name first, then what the business sells.
 * @returns {null | {category:string, basis:'registry'|'industry', key:string, words:number} | {category:null, ambiguous:true, candidates:string[]}}
 */
export function classifyMerchant(narration) {
    const listed = registryLookup(narration);
    if (listed && listed.category) return { category: listed.category, basis: 'registry', key: listed.key, words: listed.key.split(' ').length };
    if (listed && listed.ambiguous) return listed;
    const sells = industryHits(merchantWords(narration));
    if (sells.categories.length === 1) return { category: sells.categories[0], basis: 'industry', key: sells.words[0], words: 1 };
    if (sells.categories.length > 1) return { category: null, ambiguous: true, candidates: sells.categories.slice(0, 4), keys: sells.words };
    return null;
}

/**
 * The question to put to the owner about a merchant the rules could not place — filed WITH the record, never instead of it (the money is counted; only the label waits).
 * @returns {null | {state:'open', reason:'no-merchant-name'|'ambiguous'|'unknown', key:string, candidates:string[]}}
 */
export function inquiryFor(narration) {
    const found = classifyMerchant(narration);
    if (found && found.category) return null;                                      // identifiable: nothing to ask
    const words = identifyingWords(narration);
    const key = (words.length ? words : merchantWords(narration)).slice(0, 4).join(' ').slice(0, 60);
    if (!key) return null;
    if (isGatewayOnly(narration)) return { state: 'open', reason: 'no-merchant-name', key, candidates: [] };
    if (found && found.ambiguous) return { state: 'open', reason: 'ambiguous', key, candidates: found.candidates.slice(0, 4) };
    return { state: 'open', reason: 'unknown', key, candidates: [] };
}

/* Hand the router what this module knows. The router (which the page also loads) stays free of the list; whichever server module imports THIS file gets the full answer. */
setMerchantClassifier(classifyMerchant, REGISTRY_CATEGORIES);
