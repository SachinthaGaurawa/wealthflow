/* =============================================================================
 * wealthflow-phone.js — a phone number, the way a person types it, into E.164
 * -----------------------------------------------------------------------------
 * One rule for the page (which validates a number before it lets the owner switch
 * text messages on) and the server (which validates it again before sending): the
 * same function, so they can never disagree about what a number is. No imports, no
 * DOM, no clock. window.WFPhone.
 *
 * SRI LANKA ONLY. The SMS gateway (Text.lk) delivers inside Sri Lanka and nowhere else, so this is the one
 * place that says so: a number is a Sri Lankan MOBILE number, +94 then 7 and eight more digits, and
 * anything else is refused on the page, before it is saved, with a sentence that says why. (An earlier
 * version accepted any country's number; every one of those texts was one the gateway could not deliver.)
 * A Sri Lankan number may be typed any way people write it: 077 123 4567, 77 123 4567, 94771234567,
 * +94 77 123 4567, 0094 77 123 4567, with brackets, dashes, dots or spaces, in Sinhala or Tamil digits.
 * ===========================================================================*/

/** Sri Lanka's calling code. A bare local number ("077 123 4567") is read as this country's unless the caller says otherwise. */
export const DEFAULT_COUNTRY = '94';
export const DEFAULT_REGION = 'LK';

const s = (v) => (v === null || v === undefined ? '' : String(v));

/** The only country: Sri Lanka. Kept as a one-row list so a caller that asks "which countries?" gets an honest answer. */
const LK = Object.freeze({ iso: 'LK', name: 'Sri Lanka', dial: '94', utcOffsetMin: 330, trunk: '0', lengths: Object.freeze([9]) });
export const COUNTRIES = Object.freeze([LK]);

export const regionByIso = (iso) => (s(iso).trim().toUpperCase() === 'LK' ? LK : null);
export const regionOfDial = (dial) => (s(dial).replace(/\D/g, '') === '94' ? LK : null);
export const isDialCode = (dial) => s(dial).replace(/\D/g, '') === '94';

/** "94", "+94" or "LK" -> "94"; '' for anything else (no other country is served). */
export function dialOf(country) {
    const t = s(country).trim();
    return /^(?:lk|\+?94)$/i.test(t) ? '94' : '';
}

/** The first code point (the digit zero) of every script whose digits people type, so a number written in them reads as the same number. */
const DIGIT_ZEROS = [0x0660, 0x06F0, 0x07C0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0DE6, 0x0E50, 0x0ED0, 0x0F20, 0x1040, 0x17E0, 0x1810, 0xFF10];

/**
 * What a number looks like once the noise that comes with copying it is gone: a "tel:" / "callto:" link (a contacts file writes them that way),
 * the invisible direction marks a chat or an address book adds around a number, a non-breaking space, and digits written in another script
 * (Arabic-Indic, Sinhala, Tamil, Devanagari, full-width ...). Nothing that carries meaning is dropped: letters, an extension or a second number
 * are still refused by the rules below, because guessing which digits they are would text somebody else.
 */
export function cleanPhoneInput(input) {
    let t = s(input).normalize('NFKC');
    t = t.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u00AD]/g, '').replace(/[\u00A0\u2007\u202F\u3000]/g, ' ');
    t = t.replace(/^\s*(?:tel|callto|sms|whatsapp):\/{0,2}/i, '');
    t = t.replace(/\p{Nd}/gu, (ch) => {
        const cp = ch.codePointAt(0);
        for (const z of DIGIT_ZEROS) if (cp >= z && cp <= z + 9) return String(cp - z);
        return ch;
    });
    return t.trim();
}

/**
 * A phone number a person typed, into E.164, if it is a Sri Lankan mobile number; otherwise a refusal that says why.
 *
 *   "077 123 4567"        -> +94771234567     (local, trunk 0)
 *   "771234567"           -> +94771234567     (local, no trunk 0)
 *   "94771234567"         -> +94771234567
 *   "0094 77 123 4567"    -> +94771234567     (00 international prefix)
 *   "+94 (0) 77 123 4567" -> +94771234567     (the bracketed trunk 0 is dropped)
 *   "+44 7911 123456"     -> refused: 'not-sri-lanka'
 *
 * The second argument is accepted and ignored, so a caller written for the many-country version still works.
 *
 * Returns `{ ok, e164, gateway, country, iso, reason }`. `country` is '94', `iso` 'LK', `gateway` the number without the plus (which is how
 * Text.lk wants it). A number that is not unambiguously a Sri Lankan mobile number is REFUSED rather than guessed at: an SMS to the wrong
 * person is worse than an SMS not sent, and the refusal is shown to the owner.
 */
export function normalizePhone(input) {
    const raw = cleanPhoneInput(input);
    if (!raw) return { ok: false, reason: 'empty' };
    if (/[^\d+\s().-]/.test(raw)) return { ok: false, reason: 'not-a-number' };
    if (raw.indexOf('+') > 0 || (raw.match(/\+/g) || []).length > 1) return { ok: false, reason: 'misplaced-plus' };
    let digits = raw.replace(/\D/g, '');
    if (!digits) return { ok: false, reason: 'empty' };

    let national = '';
    const international = raw.startsWith('+') || digits.startsWith('00');
    if (international) {
        if (!raw.startsWith('+')) digits = digits.slice(2);
        if (!digits || digits.startsWith('0')) return { ok: false, reason: 'bad-length' };
        if (!digits.startsWith('94')) return { ok: false, reason: 'not-sri-lanka' };
        national = digits.slice(2);
        // "+94 (0) 77 123 4567": the trunk digit written after the country code is not part of the number
        if (national.length === 10 && national.startsWith('0')) national = national.slice(1);
    } else if (digits.length === 10 && digits.startsWith('0')) national = digits.slice(1);               // 077 123 4567
    else if (digits.length === 9) national = digits;                                                          // 77 123 4567
    else if (digits.startsWith('94') && digits.length === 11) national = digits.slice(2);                    // 94771234567
    else if (digits.startsWith('940') && digits.length === 12) national = digits.slice(3);                   // 940771234567
    else return { ok: false, reason: 'bad-length', country: '94' };

    if (national.length !== 9 || national.startsWith('0')) return { ok: false, reason: 'bad-length', country: '94' };
    // a Sri Lankan SMS goes to a mobile: 9 digits after the code, the first being 7
    if (!/^7\d{8}$/.test(national)) return { ok: false, reason: 'not-a-mobile-number', country: '94' };
    return { ok: true, e164: '+94' + national, gateway: '94' + national, country: '94', iso: 'LK' };
}

/** True for a number this system can text: +94 then 7 and eight more digits. */
export const isSriLankanMobile = (e164) => /^\+947\d{8}$/.test(s(e164).trim());

/** "+94771234567" -> "+94 77 123 4567", for people to read, never for the wire. A number of any other country (an old record) is shown as it was stored. */
export function formatPhone(e164) {
    const d = s(e164).replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('94')) return `+94 ${d.slice(2, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
    return d ? `+${d}` : s(e164);
}

/** "Sri Lanka" for a Sri Lankan number, "" for anything else. */
export const countryNameOf = (e164) => (s(e164).replace(/\D/g, '').startsWith('94') ? 'Sri Lanka' : '');

/** Minutes east of UTC: Sri Lanka's, the only country served (a scheduled text is timed by it). */
export const utcOffsetOf = () => 330;

/** "+94771234567" -> "+94 77 ••• 4567"-style mask for logs and dashboards: enough to recognise, not enough to use. */
export function maskPhone(e164) {
    const d = s(e164).replace(/\D/g, '');
    if (d.length < 7) return '***';
    return '+' + d.slice(0, Math.min(2, d.length - 4)) + '*'.repeat(Math.max(3, d.length - 6)) + d.slice(-4);
}

export default { DEFAULT_COUNTRY, DEFAULT_REGION, COUNTRIES, cleanPhoneInput, normalizePhone, isSriLankanMobile, maskPhone, formatPhone, countryNameOf, utcOffsetOf, dialOf, regionByIso, regionOfDial, isDialCode };
