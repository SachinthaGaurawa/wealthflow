/* =============================================================================
 * statement-currency.mjs — which money is this, and how finely is it counted?
 * -----------------------------------------------------------------------------
 * A statement in yen has no cents; one in Kuwaiti dinar has three decimals; one in rupees has two. A reader that counts
 * "cents" everywhere gets a yen balance wrong by a factor of a hundred and a dinar balance wrong by ten, and the books
 * "balance" in the wrong unit. So:
 *
 *   · the currency is DISCOVERED from the document (an ISO 4217 alpha-3 code printed on it, or a symbol that can only
 *     mean one thing), never assumed;
 *   · amounts are held as INTEGERS OF THE CURRENCY'S MINOR UNIT (BigInt): 1,234.50 LKR is 123450n, 1,234 JPY is 1234n,
 *     1,234.567 KWD is 1234567n. Sums and comparisons are exact — no floating point is ever added, subtracted or compared;
 *   · a statement whose currency is not the account's base currency is not filed into it, whatever it adds up to.
 *
 * Pure: no clock, no network, no dependencies. BigInt IS the high-precision decimal arithmetic; a library would add
 * nothing here but a supply-chain risk.
 * ===========================================================================*/

/** ISO 4217 minor-unit exponents that are NOT 2. Everything else in CODES counts in hundredths. */
const ZERO_DECIMAL = ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'];
const THREE_DECIMAL = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'];
const TWO_DECIMAL = ['AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GTQ', 'GYD', 'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IRR', 'JMD', 'KES', 'KGS', 'KHR', 'KPW', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'QAR', 'RON', 'RSD', 'RUB', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD', 'SSP', 'STN', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'USD', 'UYU', 'UZS', 'VES', 'WST', 'XCD', 'YER', 'ZAR', 'ZMW', 'ZWL'];

export const CURRENCIES = Object.freeze(Object.fromEntries([
    ...ZERO_DECIMAL.map((c) => [c, 0]), ...THREE_DECIMAL.map((c) => [c, 3]), ...TWO_DECIMAL.map((c) => [c, 2]),
]));
export const isCurrencyCode = (code) => typeof code === 'string' && Object.prototype.hasOwnProperty.call(CURRENCIES, code);

/** How many decimal places this currency's minor unit has; 2 for anything unknown (the safe, common case). */
export const decimalsOf = (code) => (isCurrencyCode(String(code || '').toUpperCase()) ? CURRENCIES[String(code).toUpperCase()] : 2);

/** Symbols and what they mean. `ambiguous` ones name a family: they only decide when nothing else on the page does. */
const SYMBOLS = [
    { re: /(?:\bRs\.?(?=\s*\d)|₨|රු\.?|\bLKR\b)/g, code: 'LKR', ambiguous: true },   // "Rs" is also INR/PKR/NPR; a Sri Lankan app reads it as LKR unless a code says otherwise
    { re: /₹/g, code: 'INR' }, { re: /€/g, code: 'EUR' }, { re: /£/g, code: 'GBP' }, { re: /₩/g, code: 'KRW' }, { re: /₫/g, code: 'VND' },
    { re: /฿/g, code: 'THB' }, { re: /₪/g, code: 'ILS' }, { re: /₱/g, code: 'PHP' }, { re: /₺/g, code: 'TRY' }, { re: /₴/g, code: 'UAH' },
    { re: /\bUS\$|\bU\$S?(?=\s*\d)/g, code: 'USD' }, { re: /\bA\$/g, code: 'AUD' }, { re: /\bS\$/g, code: 'SGD' }, { re: /\bC\$/g, code: 'CAD' },
    { re: /\bHK\$/g, code: 'HKD' }, { re: /\bNZ\$/g, code: 'NZD' },
    { re: /\$(?=\s*\d)/g, code: 'USD', ambiguous: true },      // a bare dollar sign is USD only when no code says otherwise
    { re: /[¥￥](?=\s*\d)/g, code: 'JPY', ambiguous: true },   // and a bare yen sign could be CNY
];

/**
 * Find the currency a statement is written in.
 *
 * Counts every ISO alpha-3 code printed as a whole word (a code in the heading, or beside an amount, counts for more than
 * one in passing) and every symbol that means one thing. Returns the winner and how sure it is:
 *   high    printed at least twice and at least twice as often as any other, or the only one printed;
 *   medium  the most printed, not clearly;
 *   low     only an ambiguous symbol, or nothing at all (code is '' and decimals is 2).
 * A statement that mentions "USD 5.00" beside a hundred rupee lines is in rupees: the share decides, not the first hit.
 */
export function discoverCurrency(textOrLines) {
    const lines = Array.isArray(textOrLines) ? textOrLines : String(textOrLines == null ? '' : textOrLines).split(/\r?\n/);
    const score = new Map(), mentions = new Map();
    const add = (code, weight) => { score.set(code, (score.get(code) || 0) + weight); mentions.set(code, (mentions.get(code) || 0) + 1); };
    let ambiguousOnly = true;
    lines.slice(0, 4000).forEach((raw, index) => {
        const line = String(raw);
        const heading = index < 15, money = /\d[\d.,\s]*\d/.test(line);
        for (const m of line.matchAll(/(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])/g)) {
            if (!isCurrencyCode(m[1])) continue;
            // a code on a line that carries money, or in the heading, is the currency of the page; a code in a paragraph of prose is not
            add(m[1], (heading ? 3 : 1) * (money ? 2 : 1)); ambiguousOnly = false;
        }
        for (const s of SYMBOLS) {
            if (s.code === 'LKR' && /\bLKR\b/.test(line)) continue;      // already counted as a code
            const found = line.match(s.re);
            if (found) { add(s.code, (s.ambiguous ? 0.5 : 2) * found.length * (heading ? 2 : 1)); if (!s.ambiguous) ambiguousOnly = false; }
        }
    });
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { code: '', decimals: 2, confidence: 'low', counts: {} };
    const [top, topScore] = ranked[0], runner = ranked[1] ? ranked[1][1] : 0;
    const counts = Object.fromEntries(ranked.slice(0, 6).map(([c]) => [c, mentions.get(c)]));
    const confidence = ambiguousOnly ? 'low' : (mentions.get(top) >= 2 || ranked.length === 1) && topScore >= 2 * runner ? 'high' : 'medium';
    return { code: top, decimals: decimalsOf(top), confidence, counts, ...(ranked.length > 1 ? { alternatives: ranked.slice(1, 4).map(([c]) => c) } : {}) };
}

/* ── exact decimal arithmetic on minor units ───────────────────────────────────────────────────────────────────── */

/**
 * A decimal written as a number or a string, as an integer count of the minor unit, or null when it is not an exact
 * amount in that many places (more digits than the currency has, an exponent, NaN). Never rounds: 12.345 in a
 * two-decimal currency is not 12.35, it is rejected.
 */
export function decimalToMinor(value, decimals) {
    let s;
    if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : null;
    else if (typeof value === 'string') s = value.trim().replace(/,/g, '');
    else if (typeof value === 'bigint') return value * 10n ** BigInt(decimals);
    else return null;
    if (s === null || !/^-?\d+(?:\.\d+)?$/.test(s)) return null;
    const negative = s.startsWith('-');
    const [whole, frac = ''] = s.replace('-', '').split('.');
    if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return null;
    const digits = whole + frac.slice(0, decimals).padEnd(decimals, '0');
    const out = BigInt(digits);
    return negative ? -out : out;
}

/** An integer count of the minor unit, as the decimal string a person would write: 123450n → "1234.50", 1234n (0 places) → "1234". */
export function minorToString(minor, decimals) {
    const negative = minor < 0n, abs = negative ? -minor : minor;
    const s = abs.toString().padStart(decimals + 1, '0');
    const out = decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s;
    return negative ? `-${out}` : out;
}

/** As a JS number for the rest of the pipeline (which holds amounts in major units): exact for every amount a statement can carry. */
export const minorToNumber = (minor, decimals) => Number(minorToString(minor, decimals));

/** Is this a currency the account is kept in? Case-blind; an unknown statement currency ('') never conflicts. */
export function sameCurrency(statementCode, baseCode) {
    const a = String(statementCode || '').toUpperCase(), b = String(baseCode || 'LKR').toUpperCase();
    return !a || a === b;
}
