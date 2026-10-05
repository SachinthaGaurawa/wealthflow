/* =============================================================================
 * wealthflow-phone.js — a phone number, the way a person types it, into E.164
 * -----------------------------------------------------------------------------
 * One rule for the page (which validates a number before it lets the owner switch
 * text messages on) and the server (which validates it again before sending): the
 * same function, so they can never disagree about what a number is. No imports, no
 * DOM, no clock. window.WFPhone.
 * ===========================================================================*/

const s = (v) => String(v == null ? '' : v);

/** Sri Lanka's calling code. A bare local number ("077 123 4567") is read as this country's unless the caller says otherwise. */
export const DEFAULT_COUNTRY = '94';

/**
 * Any phone number a person might type, into E.164.
 *
 *   "077 123 4567"   -> +94771234567     (local, trunk 0)
 *   "771234567"      -> +94771234567     (local, no trunk 0)
 *   "94771234567"    -> +94771234567
 *   "0094 77 123 4567" -> +94771234567   (00 international prefix)
 *   "+1 (415) 555-2671" -> +14155552671
 *
 * Returns `{ ok, e164, gateway, country, reason }`. `gateway` is the same number
 * without the plus, which is how Text.lk wants it. A number that is not
 * unambiguously a number is REFUSED rather than guessed at: an SMS to the wrong
 * person is worse than an SMS not sent, and the refusal is shown to the owner.
 */
export function normalizePhone(input, { defaultCountry = DEFAULT_COUNTRY } = {}) {
    const raw = s(input).trim();
    if (!raw) return { ok: false, reason: 'empty' };
    if (/[^\d+\s().-]/.test(raw)) return { ok: false, reason: 'not-a-number' };
    if (raw.indexOf('+') > 0 || (raw.match(/\+/g) || []).length > 1) return { ok: false, reason: 'misplaced-plus' };
    let digits = raw.replace(/\D/g, '');
    if (!digits) return { ok: false, reason: 'empty' };

    if (raw.startsWith('+')) { /* already international */ }
    else if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) {
        const rest = digits.slice(1);
        if (!defaultCountry || !rest) return { ok: false, reason: 'needs-country-code' };
        digits = defaultCountry + rest;
    } else if (defaultCountry === '94' && /^7\d{8}$/.test(digits)) digits = '94' + digits;
    else if (defaultCountry === '94' && /^94\d{9}$/.test(digits)) { /* 94771234567 */ }
    else return { ok: false, reason: 'needs-country-code' };

    if (!/^[1-9]\d{7,14}$/.test(digits)) return { ok: false, reason: 'bad-length' };

    let country = '';
    if (digits.startsWith('94')) {
        const national = digits.slice(2);
        // a Sri Lankan SMS goes to a mobile: 9 digits after the code, the first being 7
        if (!/^7\d{8}$/.test(national)) return { ok: false, reason: 'not-a-mobile-number', country: '94' };
        country = '94';
    } else if (digits.startsWith('1')) {
        // NANP: +1, then exactly ten digits, area code and exchange never start with 0 or 1
        if (!/^1[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return { ok: false, reason: 'bad-length', country: '1' };
        country = '1';
    }
    return { ok: true, e164: '+' + digits, gateway: digits, country };
}

/** "+94771234567" -> "+94 77 ••• 4567"-style mask for logs and dashboards: enough to recognise, not enough to use. */
export function maskPhone(e164) {
    const d = s(e164).replace(/\D/g, '');
    if (d.length < 7) return '***';
    return '+' + d.slice(0, Math.min(2, d.length - 4)) + '*'.repeat(Math.max(3, d.length - 6)) + d.slice(-4);
}

export default { DEFAULT_COUNTRY, normalizePhone, maskPhone };
