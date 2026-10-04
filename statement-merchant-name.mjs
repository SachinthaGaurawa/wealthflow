/* =============================================================================
 * statement-merchant-name.mjs — the merchant in a bank narration
 * -----------------------------------------------------------------------------
 * A statement line is a merchant wrapped in terminal noise: "POPEYES-3921-COLOMBO", "POS 4412 ARPICO SUPERCENTRE COLOMBO 03 LK", "PAYME-VISA*KEELLS", "AMZN MKTP US*2K4TY1QR0". What the owner
 * decides about a merchant ("Popeyes is Dining") has to be found again at the next outlet, in the next city, behind the next gateway, or the owner corrects the same merchant twice.
 *
 * The manual upload has isolated the merchant this way for a long time (WFMerchants.isolate in wealthflow-merchants.js). The email worker's key (merchantNameFor) removed the digits and kept
 * the rest: "POPEYES- -COLOMBO" and "POPEYES- -KANDY" were two merchants, so a correction made on one never reached the other, and the owner's history (statement-history.mjs) could not recognise a
 * merchant it had seen. This is the same isolation, as a pure module the worker imports (wealthflow-merchants.js is a classic script and cannot import); test/merchant_name_test.js reads both with
 * hundreds of generated lines and they must agree.
 *
 * Pure: no network, no clock, no storage. Server only (the page keeps its own copy, pinned to this one by the test).
 * ===========================================================================*/

const norm = (value) => String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// bank-narration prefixes to strip so the real merchant is what is left
const PREFIXES = [
    /^ib\s+bill\s+payment\s+/i, /^bill\s+payment\s+/i, /^pos\s+transaction\s+/i, /^pos\s+/i,
    /^inward\s+ceft\s+transfer\s+/i, /^outward\s+ceft\s+transfer\s+/i, /^ceft\s+(charges?|transfer)\s+/i,
    /^transfer\s+(debit|credit)[- ]*(mobilebanking)?\s*/i, /^atm\s+withdrawal\s+(fee\s+)?/i,
    /^crm\s+cash\s+deposit\s+/i, /^lanka\s+qr[\s-]+payment\s+(debit|credit)\s*/i, /^charge\s*-\s*(capitalise\s+)?/i,
    /^standing\s+order\s+/i, /^direct\s+debit\s+/i, /^online\s+(purchase|payment)\s+/i,
];
// a payment gateway is not a merchant: "PAYME-VISA*KEELLS", "IPG*ARPICO", "PAYPAL *UBER", "SQ *BLUE BOTTLE"
const GATEWAY = /^(?:(?:payme|payhere|ipg|paypal|sq|square|stripe|2checkout|paddle|mpgs|ecom|ecommerce|visa|master|mastercard|txn|online)[\s*_/.-]+)+/i;
const stripPrefix = (text) => { let out = String(text || '').trim(); for (const re of PREFIXES) out = out.replace(re, ''); return out.replace(GATEWAY, '').trim(); };

/** The towns a terminal prints after a merchant's name. */
export const CITIES = ['colombo', 'kandy', 'kurunegala', 'kuliyapitiya', 'kuliyapit', 'negombo', 'galle', 'matara', 'jaffna', 'gampaha', 'nugegoda', 'dehiwala', 'moratuwa', 'maharagama', 'kalutara', 'kaluthara', 'panadura',
    'ratnapura', 'badulla', 'anuradhapura', 'dambulla', 'homagama', 'meerigama', 'mirigama', 'wattala', 'ratmalana', 'jaela', 'mattegoda', 'wellampitiya', 'ibbagamuwa', 'kadawatha', 'malabe', 'piliyandala', 'singapore', 'london'];
const CITY = new RegExp(`\\b(${CITIES.join('|')})\\b`, 'g');

/**
 * The merchant a narration names, lower case, with the noise taken off: the bank's own verbs and prefixes, the payment gateway, terminal and reference numbers, the town and the country.
 * '' when nothing is left (a line that names only a gateway, a town and a country: nobody can say what was bought).
 */
export function isolateMerchant(raw) {
    let text = stripPrefix(norm(raw));
    text = text.replace(/\b(pos|ib|ceft|slips|crm|atm|dcc)\b/g, ' ');
    text = text.replace(/\b(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{8,}\b/g, ' ');       // gateway reference blobs ("2k4ty1qr0", "ab12cd34")
    text = text.replace(/\b\d{4,}\b/g, ' ');                                               // terminal, customer and reference numbers
    text = text.replace(/\b\d{1,2}\b/g, ' ');                                              // "colombo 03"
    text = text.replace(CITY, ' ');
    text = text.replace(/\b(pvt|pv|ltd|lt|plc|limited|private|company|co)\b/g, ' ');
    text = text.replace(/\b(charges?|payment|payments|transfer|bill|withdrawal|deposit|debit|credit|outward|inward|transaction|purchase|fee|fees)\b/g, ' ');
    text = text.replace(/\b(lk|lka|sg|us|usa|gb|uk|ae|au)\s*$/, ' ');                     // the country the terminal printed
    return text.replace(/\s+/g, ' ').trim();
}

export default { isolateMerchant, CITIES };
