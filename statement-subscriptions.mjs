/* =============================================================================
 * statement-subscriptions.mjs — which subscription (or bill) does a statement payment belong to?
 * -----------------------------------------------------------------------------
 * A payment to "ANTHROPIC SAN FRANCISCO" or to "DIALOG 077 123 4567" is not an ordinary expense: it is one month of a subscription or of a phone
 * bill, and the Subscriptions tab holds a list of months for it. Three kinds of evidence say which entry it is, strongest first:
 *
 *   1. A NUMBER. A Sri Lankan phone number in the narration, written however the bank wrote it (0771234567, 077 123 4567, +94 77-123-4567, 94771234567),
 *      is ONE number. An entry that carries that number (in its name, notes, account reference or merchant keys) is that number's entry, whatever the
 *      amount was this month: a phone bill is not the same every month, and the number is what identifies it.
 *   2. A BRAND. "CLAUDE.AI SUBSCRIPTION", "ANTHROPIC" and "Claude Pro" are one business; "CHATGPT" and "OPENAI" are one. The alias table below names the
 *      businesses people really pay by card, with the words banks print for them.
 *   3. THE NAME the owner gave the entry, found in the narration (statement-links.mjs, as before).
 *
 * When there is no entry for it yet, a payment that is unmistakably recurring (a brand below, or a mobile number being paid) is made one — named after
 * the brand or the number, marked `autoCreated` so it can be found, renamed or removed, and removed again with the statement that made it.
 *
 * Pure: no storage, no clock, no network. No regex lookbehind (the page loads the sibling modules too).
 * ===========================================================================*/

const low = (v) => String(v == null ? '' : v).toLowerCase();
const words = (v) => low(v).replace(/[^a-z0-9]+/g, ' ').trim();
const glue = (v) => low(v).replace(/[^a-z0-9]+/g, '');

/* ── PHONE NUMBERS ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
/* The two digits after the leading 0 that a Sri Lankan number can start with: mobile operators (70 71 72 75 76 77 78) and the landline area codes. A ten-digit account number
 * that merely starts with 0 is not a phone number. */
const MOBILE_PREFIX = new Set(['70', '71', '72', '74', '75', '76', '77', '78']);
const LANDLINE_PREFIX = new Set(['11', '21', '23', '24', '25', '26', '27', '31', '32', '33', '34', '35', '36', '37', '38', '41', '45', '47', '51', '52', '54', '55', '57', '63', '65', '66', '67', '81', '91']);
const PHONE = /(^|[^0-9])((?:\+\s?94|0094|94|0)[ .-]?\(?\d{2}\)?[ .-]?\d{3}[ .-]?\d{4})(?![0-9])/g;

/** Every phone number in the text, each as its nine national digits ("771234567"), in order, without repeats. */
export function phoneKeys(text) {
    const out = [], raw = String(text == null ? '' : text);
    PHONE.lastIndex = 0;
    let m;
    while ((m = PHONE.exec(raw))) {
        let digits = m[2].replace(/\D/g, '');
        if (digits.startsWith('0094')) digits = digits.slice(4);
        else if (digits.startsWith('94') && digits.length === 11) digits = digits.slice(2);
        else if (digits.startsWith('0') && digits.length === 10) digits = digits.slice(1);
        if (digits.length !== 9) continue;
        const head = digits.slice(0, 2);
        if (!MOBILE_PREFIX.has(head) && !LANDLINE_PREFIX.has(head)) continue;
        if (!out.includes(digits)) out.push(digits);
    }
    return out;
}
export const isMobileKey = (key) => MOBILE_PREFIX.has(String(key).slice(0, 2));
/** "771234567" → "077 123 4567" (what the owner reads and types). */
export const prettyPhone = (key) => { const d = '0' + String(key); return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`; };
/** The key the manual upload (wealthflow-subscriptions.js) stores on an entry it makes: "mobile:0771234567". */
export const manualPhoneKey = (key) => `mobile:0${key}`;

/* ── BRANDS ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
/** key · the name the entry is given · the subscription category the Subscriptions tab offers · the words a bank prints for it. `telecom` brands are paid by number. */
const BRANDS = [
    { key: 'anthropic', name: 'Anthropic (Claude)', category: 'Software', aliases: ['anthropic', 'claude ai', 'claudeai', 'claude pro', 'claude max', 'claude team', 'claude subscription'] },
    { key: 'openai', name: 'OpenAI (ChatGPT)', category: 'Software', aliases: ['openai', 'open ai', 'chatgpt', 'chat gpt'] },
    { key: 'apple', name: 'Apple (iCloud / App Store)', category: 'Software', aliases: ['apple com bill', 'itunes', 'icloud', 'apple music', 'apple tv', 'apple one'], weak: ['apple com bill', 'itunes'] },
    { key: 'google', name: 'Google (One / YouTube Premium)', category: 'Software', aliases: ['google one', 'google storage', 'google workspace', 'youtube premium', 'youtubepremium', 'youtube music'] },
    { key: 'microsoft', name: 'Microsoft 365', category: 'Software', aliases: ['microsoft 365', 'microsoft365', 'office 365', 'office365', 'xbox game pass', 'onedrive'] },
    { key: 'adobe', name: 'Adobe', category: 'Software', aliases: ['adobe'] },
    { key: 'github', name: 'GitHub', category: 'Software', aliases: ['github'] },
    { key: 'canva', name: 'Canva', category: 'Software', aliases: ['canva'] },
    { key: 'notion', name: 'Notion', category: 'Software', aliases: ['notion labs', 'notion so', 'notion'] },
    { key: 'zoom', name: 'Zoom', category: 'Software', aliases: ['zoom us', 'zoom video'] },
    { key: 'dropbox', name: 'Dropbox', category: 'Software', aliases: ['dropbox'] },
    { key: 'vercel', name: 'Vercel', category: 'Software', aliases: ['vercel'] },
    { key: 'cloudflare', name: 'Cloudflare', category: 'Software', aliases: ['cloudflare'] },
    { key: 'figma', name: 'Figma', category: 'Software', aliases: ['figma'] },
    { key: 'midjourney', name: 'Midjourney', category: 'Software', aliases: ['midjourney'] },
    { key: 'grammarly', name: 'Grammarly', category: 'Software', aliases: ['grammarly'] },
    { key: 'onepassword', name: '1Password', category: 'Software', aliases: ['1password'] },
    { key: 'netflix', name: 'Netflix', category: 'Streaming', aliases: ['netflix'] },
    { key: 'spotify', name: 'Spotify', category: 'Streaming', aliases: ['spotify'] },
    { key: 'disney', name: 'Disney+', category: 'Streaming', aliases: ['disney plus', 'disneyplus', 'hotstar'] },
    { key: 'primevideo', name: 'Amazon Prime', category: 'Streaming', aliases: ['amazon prime', 'prime video', 'primevideo'] },
    { key: 'hbo', name: 'HBO Max', category: 'Streaming', aliases: ['hbo max', 'hbomax'] },
    { key: 'peotv', name: 'PEO TV', category: 'Streaming', aliases: ['peo tv', 'peotv'] },
    { key: 'dialog', name: 'Dialog', category: 'Telecom', telecom: true, aliases: ['dialog axiata', 'dialog'] },
    { key: 'mobitel', name: 'Mobitel', category: 'Telecom', telecom: true, aliases: ['mobitel'] },
    { key: 'slt', name: 'SLT', category: 'Telecom', telecom: true, aliases: ['slt mobitel', 'sri lanka telecom', 'slt'] },
    { key: 'hutch', name: 'Hutch', category: 'Telecom', telecom: true, aliases: ['hutch'] },
    { key: 'airtel', name: 'Airtel', category: 'Telecom', telecom: true, aliases: ['airtel'] },
    { key: 'lankabell', name: 'Lanka Bell', category: 'Telecom', telecom: true, aliases: ['lanka bell', 'lankabell'] },
];
/* `weak` aliases find an entry the owner already tracks, but never start one: "APPLE.COM/BILL" is as often an app bought once as a subscription. */
const ALIAS = BRANDS.flatMap((brand) => brand.aliases.map((phrase) => ({ brand, phrase, weak: (brand.weak || []).includes(phrase), spaced: ` ${phrase} `, fused: glue(phrase) }))).sort((a, b) => b.fused.length - a.fused.length);
export const BRAND_KEYS = BRANDS.map((brand) => brand.key);

/** The brands a text names (the bank's words, a subscription's own name, a stored merchant key), each once. A long one-word alias also matches when the bank ran the words together. */
export function brandsOf(text, { strongOnly = false } = {}) {
    const spaced = ` ${words(text)} `, fused = glue(text), found = [];
    for (const a of ALIAS) {
        if (found.includes(a.brand) || (strongOnly && a.weak)) continue;
        if (spaced.includes(a.spaced) || (a.phrase.indexOf(' ') < 0 && a.fused.length >= 7 && fused.includes(a.fused))) found.push(a.brand);
    }
    return found;
}

/** What an entry stands for: its brands, and its phone numbers (in its name, notes, account reference, number, or the keys the manual upload stored). */
export function identityOf(sub) {
    const s = sub || {};
    const text = [s.name, s.notes, s.accountRef, s.phone, ...(Array.isArray(s.merchantKeys) ? s.merchantKeys : [])].filter((x) => x != null).join(' ');
    return { phones: phoneKeys(text), brands: brandsOf(text).map((b) => b.key) };
}

/** What a statement row says it is paying. */
export function evidenceOf(row) {
    const text = String((row && (row.description || row.narration)) || '');
    return { phones: phoneKeys(text), brands: brandsOf(text), text };
}

/* ── A PAYMENT THAT IS UNMISTAKABLY A SUBSCRIPTION OR A PHONE BILL, WITH NO ENTRY YET ────────────────────────────────────────────────── */
const NOT_A_PHONE_BILL = /\b(?:loan|lease|leasing|instal+ments?|policy|insur\w*|premium|chq|cheque|emi|mortgage|rent)\b/i;
const BILL_WORDS = /\b(?:bill|reload|recharge|top\s*up|topup|airtime|data|package|postpaid|prepaid|fibre|fiber|broadband|lte|adsl)\b/i;

/**
 * The entry a payment should start when the owner tracks nothing for it: { name, category, merchantKeys, phone } or null. Only for money going out, only when the evidence is plain:
 *   · a brand from the table above that is bought by subscription (never a phone company without a number: "DIALOG" alone could be anything), or
 *   · a phone number being paid, with a phone company's name or a bill / reload / top-up word beside it (and nothing that says loan, lease, policy or cheque).
 * A number alone is not enough - account numbers look like phone numbers: "CEFT TRANSFER J SMITH 0771234567" and "LOAN INSTALMENT 0741234567" are filed as the expenses they are until the owner tracks the number.
 */
export function subscriptionToCreate(row) {
    if (!row || row.direction !== 'debit') return null;
    const { phones, text } = evidenceOf(row), brands = brandsOf(text, { strongOnly: true });
    const operator = brands.find((b) => b.telecom), recurring = brands.filter((b) => !b.telecom);
    if (phones.length > 1) return null;                            // two numbers on one line: not guessed between
    if (phones.length === 1) {
        const key = phones[0];
        if (NOT_A_PHONE_BILL.test(text)) return null;              // a loan, lease, policy or cheque whose account number happens to look like a phone number
        if (!operator && !BILL_WORDS.test(text)) return null;      // a number alone is not enough: a phone company's name, or a word that says bill / reload / top-up, must sit beside it
        if (!operator && !isMobileKey(key)) return null;           // a landline is a bill only when its company is named
        if (recurring.length) return null;                         // a number AND a software brand: not guessed
        return { name: `${operator ? operator.name : 'Mobile'} ${prettyPhone(key)}`, category: 'Telecom', merchantKeys: [manualPhoneKey(key)], phone: key };
    }
    if (!operator && recurring.length === 1) return { name: recurring[0].name, category: recurring[0].category, merchantKeys: [`brand:${recurring[0].key}`], phone: '' };
    return null;
}

export default { phoneKeys, isMobileKey, prettyPhone, manualPhoneKey, brandsOf, identityOf, evidenceOf, subscriptionToCreate, BRAND_KEYS };
