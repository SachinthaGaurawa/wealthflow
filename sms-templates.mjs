/* =============================================================================
 * sms-templates.mjs — the words of every text message WealthFlow sends
 * -----------------------------------------------------------------------------
 * ONE PLACE FOR THE WORDS, so the tenant reads the same wording whichever path
 * produced the message, and so a test can pin every one of them.
 *
 * DESIGN CONSTRAINTS (each one is a cost or a risk, not a style choice):
 *
 *   - PLAIN GSM-7 ONLY. One Sinhala letter, one curly quote or one emoji flips the
 *     whole message to UCS-2: 70 characters a part instead of 160, three or four
 *     times the units on an account that has very few. So there is no name in the
 *     text (names are often Sinhala or Tamil), no currency symbol, nothing but
 *     ASCII. A reference code identifies the ledger instead.
 *   - ONE PART WHEN IT CAN BE. The statement link is the longest piece, so the
 *     words around it are as short as they can be and still be unambiguous.
 *   - THE FIGURES COME FROM THE LEDGER, rendered ONCE, when the message is queued.
 *     A retry resends the same text; a balance can never differ between attempts.
 *   - NOTHING SECRET. An SMS is plaintext on a phone and in a carrier's log: amount,
 *     date, reference and a link — never an NIC, a password, or a full account.
 *
 * Pure: no clock, no network.
 * ===========================================================================*/

import { createHash } from 'node:crypto';
import { analyzeSms } from './textlk.mjs';

const s = (v) => String(v == null ? '' : v);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The kinds of notice, by layer. A = the Investments tab. B = money lent to people (Liquidity & Credit Hub). */
export const KINDS = Object.freeze({
    A_CAPITAL: 'A.capital',          // new capital investment recorded
    A_INTEREST: 'A.interest',        // monthly interest applied
    A_RECEIPT: 'A.receipt',          // a payment received (principal or interest)
    B_DISBURSED: 'B.disbursed',      // loan capital paid out (the first advance, or a further one)
    B_REPAYMENT: 'B.repayment',      // a repayment acknowledged
    OTP: 'otp',                      // the portal's one-time code
});

/** 3-letter currency code, upper case; anything else becomes LKR rather than letting free text into a message. */
export function currencyOf(v) {
    const c = s(v).trim().toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : 'LKR';
}

/** "LKR 12,500.00" — written out by hand so it is the same on every Node build and ICU table. */
export function fmtMoney(amount, currency = 'LKR') {
    const n = Number(amount);
    if (!Number.isFinite(n)) return `${currencyOf(currency)} 0.00`;
    const cents = Math.round(Math.abs(n) * 100);
    const whole = Math.floor(cents / 100);
    const frac = String(cents % 100).padStart(2, '0');
    const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${n < 0 ? '-' : ''}${currencyOf(currency)} ${grouped}.${frac}`;
}

/** "05 Oct 2026" from "2026-10-05" (or an ISO timestamp, read as written — no timezone shifting). */
export function fmtDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s(iso));
    if (!m) return '';
    const mi = Number(m[2]) - 1;
    return mi >= 0 && mi < 12 ? `${m[3]} ${MONTHS[mi]} ${m[1]}` : '';
}

/** "Oct 2026" from "2026-10". */
export function fmtMonth(ym) {
    const m = /^(\d{4})-(\d{2})/.exec(s(ym));
    if (!m) return '';
    const mi = Number(m[2]) - 1;
    return mi >= 0 && mi < 12 ? `${MONTHS[mi]} ${m[1]}` : '';
}

/**
 * A short, stable reference the tenant can quote: "INV-3F9A2B", "DEB-1A2B3C". Derived from the record id by hashing so that
 * it neither exposes the id nor changes when the record is edited. The same function is used by the portal, so the SMS and the
 * statement carry the same code.
 */
export function refCode(kind, recordId) {
    const prefix = kind === 'debtor' ? 'DEB' : 'INV';
    const h = createHash('sha256').update(`wf-ref|${kind}|${s(recordId)}`).digest('hex').slice(0, 6).toUpperCase();
    return `${prefix}-${h}`;
}

const tail = (link) => (link ? ` Statement: ${link}` : '');
const pct = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return (Math.round(n * 100) / 100).toString();
};

/** Anything that is not printable ASCII is dropped; newlines become spaces. A last line of defence for the one-part promise. */
export function asciiOnly(text) {
    return s(text).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E]/g, '').replace(/ {2,}/g, ' ').trim();
}

/**
 * The text for one notice.
 * ctx: { amount, currency, ref, dateISO, month, ratePct, balance, link, settled, further }
 */
function render(kind, ctx) {
    const cur = currencyOf(ctx.currency);
    const amt = fmtMoney(ctx.amount, cur);
    const ref = s(ctx.ref);
    const link = s(ctx.link);
    let text;
    switch (kind) {
    case KINDS.A_CAPITAL: {
        const r = pct(ctx.ratePct);
        text = `Capital ${amt} recorded, ref ${ref}${r ? ` (${r}% p.a.)` : ''}.${tail(link)}`;
        break;
    }
    case KINDS.A_INTEREST:
        text = `Interest ${amt} applied to ref ${ref}${ctx.month ? ` for ${fmtMonth(ctx.month)}` : ''}.${tail(link)}`;
        break;
    case KINDS.A_RECEIPT:
        text = `Receipt: ${amt} received${ctx.dateISO ? ` on ${fmtDay(ctx.dateISO)}` : ''}, ref ${ref}.${tail(link)}`;
        break;
    case KINDS.B_DISBURSED:
        text = `${ctx.further ? 'Further loan' : 'Loan'} ${amt} disbursed${ctx.dateISO ? ` on ${fmtDay(ctx.dateISO)}` : ''}, ref ${ref}. Balance ${fmtMoney(ctx.balance, cur)}.${tail(link)}`;
        break;
    case KINDS.B_REPAYMENT:
        text = ctx.settled
            ? `Repayment ${amt} received${ctx.dateISO ? ` on ${fmtDay(ctx.dateISO)}` : ''}, ref ${ref}. Loan fully settled, thank you.${tail(link)}`
            : `Repayment ${amt} received${ctx.dateISO ? ` on ${fmtDay(ctx.dateISO)}` : ''}, ref ${ref}. Balance ${fmtMoney(ctx.balance, cur)}.${tail(link)}`;
        break;
    default:
        return '';
    }
    return asciiOnly(text);
}

/**
 * The text for one notice. With the statement link a long amount can push a loan notice into a second part, which costs a second
 * unit; the date is the one piece the statement repeats, so it is the one dropped, and only when that saves a part.
 */
export function buildMessage(kind, ctx = {}) {
    const full = render(kind, ctx);
    if (!full || !s(ctx.link) || analyzeSms(full).segments <= 1) return full;
    const compact = render(kind, { ...ctx, dateISO: '' });
    return compact && analyzeSms(compact).segments < analyzeSms(full).segments ? compact : full;
}

/** The portal's one-time code. Says what it is for, how long it lives and never to share it. */
export function otpMessage(code, minutes = 3) {
    const c = s(code).replace(/\D/g, '');
    return asciiOnly(`${c} is your WealthFlow verification code. It expires in ${minutes} minutes. Do not share it with anyone.`);
}

export default { KINDS, currencyOf, fmtMoney, fmtDay, fmtMonth, refCode, buildMessage, otpMessage, asciiOnly };
