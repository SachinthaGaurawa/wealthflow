/* =============================================================================
 * wealthflow-nic.js — Sri Lankan National Identity Card numbers
 * -----------------------------------------------------------------------------
 * Two shapes are in circulation and both belong to the same person for life:
 *
 *   old  (until 2016)   9 digits + V or X       853400937V      YY DDD SSS C  V
 *   new  (since 2016)   12 digits               198534000937    YYYY DDD SSSS C
 *
 *   YY / YYYY   year of birth
 *   DDD         day of the year of birth; 500 is ADDED for women (so 001-366 men, 501-866 women)
 *   S...        serial, C check digit
 *
 * The old number becomes the new one by writing "19" in front and a "0" after the
 * fifth digit: 853400937V -> 19 85340 0 0937 -> 198534000937. So ONE canonical form
 * (the 12 digits) is what everything compares and groups on, and "the same individual
 * with an old-style NIC on one loan and a new-style NIC on another" is one person,
 * which is what the tenant portal's single balance sheet depends on.
 *
 * WHAT THIS DOES NOT DO: prove the number belongs to the person typing it. An NIC
 * is an identifier, not a secret — it is printed on documents, copied for banks
 * and shops, and guessable from a birthday. The portal therefore never treats it as
 * a password: it is ONE factor, beside an unguessable link and a one-time code
 * sent to the phone the lender recorded.
 *
 * Pure: no clock, no network.
 * ===========================================================================*/

const s = (v) => String(v == null ? '' : v);

const validDay = (d) => (d >= 1 && d <= 366) || (d >= 501 && d <= 866);

/**
 * @returns {{ok:true, canonical:string, format:'old'|'new', birthYear:number, dayOfYear:number, female:boolean} | {ok:false, reason:string}}
 */
export function normalizeNic(input) {
    const raw = s(input).replace(/[\s.-]+/g, '').toUpperCase();
    if (!raw) return { ok: false, reason: 'empty' };

    let year; let day; let canonical; let format;
    if (/^\d{9}[VX]$/.test(raw)) {
        format = 'old';
        year = 1900 + Number(raw.slice(0, 2));
        day = Number(raw.slice(2, 5));
        canonical = `19${raw.slice(0, 5)}0${raw.slice(5, 9)}`;
    } else if (/^\d{12}$/.test(raw)) {
        format = 'new';
        year = Number(raw.slice(0, 4));
        day = Number(raw.slice(4, 7));
        canonical = raw;
    } else {
        return { ok: false, reason: 'bad-shape' };
    }
    if (year < 1900 || year > 2100) return { ok: false, reason: 'bad-year' };
    if (!validDay(day)) return { ok: false, reason: 'bad-day' };
    const female = day > 500;
    return { ok: true, canonical, format, birthYear: year, dayOfYear: female ? day - 500 : day, female };
}

/** "198534000937" -> "*********937" — enough for the person to recognise their own number, not enough to use it. */
export function maskNic(input) {
    const n = normalizeNic(input);
    const raw = n.ok ? n.canonical : s(input).replace(/\s+/g, '');
    if (raw.length < 4) return '***';
    return '*'.repeat(Math.max(0, raw.length - 3)) + raw.slice(-3);
}

export default { normalizeNic, maskNic };
