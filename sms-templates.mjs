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
 *   - LAID OUT AS LINES (owner, 2026-10-29: "make the reminders easy on the eye; bold or whatever suits"). A text message has no bold, so the layout does
 *     what bold would: a headline in capitals, one fact per line, a label before each figure, and "** ... **" around the one thing that is due TODAY. A line
 *     break costs one character, the same as the space it replaces, so the layout is free. Plain GSM-7 still: a line of the layout is dropped, never
 *     translated, if it would need a character outside it.
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
import { OFFICIAL_ORIGIN } from './wealthflow-public-identity.mjs';

const s = (v) => String(v == null ? '' : v);
/** The host the portal is served from, as the origin-bound line of a code text names it. */
const OFFICIAL_HOST = new URL(OFFICIAL_ORIGIN).host;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The kinds of notice, by layer. A = the Investments tab. B = money lent to people (Liquidity & Credit Hub). */
export const KINDS = Object.freeze({
    A_CAPITAL: 'A.capital',          // new capital investment recorded
    A_INTEREST: 'A.interest',        // monthly interest applied
    A_RECEIPT: 'A.receipt',          // a payment received (principal or interest)
    B_DISBURSED: 'B.disbursed',      // loan capital paid out (the first advance, or a further one)
    B_REPAYMENT: 'B.repayment',      // a repayment acknowledged
    B_LATE: 'B.late',                // a payment is late: the date the debtor was expected to pay by has passed and money is still owing (opt-in)
    B_BALANCE: 'B.balance',          // the owner asked for the current balance to be sent (a part payment was agreed, or they asked)
    B_CLOSED: 'B.closed',            // the loan is fully settled: a text of its own, after the receipt for the payment that settled it
    A_CLOSED: 'A.closed',            // the owner closed the investment as fully settled
    O_DUE: 'O.due',                  // the owner's own due-date alert: a loan instalment, a card payment or a cheque coming up (opt-in, to the owner's number)
    OTP: 'otp',                    // the portal's one-time code
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

const pct = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    return (Math.round(n * 100) / 100).toString();
};

/** Anything that is not printable ASCII is dropped; newlines become spaces. A last line of defence for the one-part promise. */
export function asciiOnly(text) {
    return s(text).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E]/g, '').replace(/ {2,}/g, ' ').trim();
}

/** Several lines of text, each held to printable ASCII, empty ones dropped: the layout of a notice. */
export function asciiLines(...lines) {
    return lines.flat().map((l) => asciiOnly(l)).filter(Boolean).join('\n');
}

/**
 * The text for one notice.
 * ctx: { amount, currency, ref, dateISO, month, ratePct, balance, link, further }
 */
function render(kind, ctx) {
    const cur = currencyOf(ctx.currency);
    const amt = fmtMoney(ctx.amount, cur);
    const ref = s(ctx.ref);
    const link = s(ctx.link);
    let text;
    const stmt = link ? `Statement: ${link}` : '';
    const on = ctx.dateISO ? ` on ${fmtDay(ctx.dateISO)}` : '';
    switch (kind) {
    case KINDS.A_CAPITAL: {
        const r = pct(ctx.ratePct);
        text = asciiLines('CAPITAL RECORDED', `${amt}${r ? ` at ${r}% p.a.` : ''}`, `Ref: ${ref}`, stmt);
        break;
    }
    case KINDS.A_INTEREST:
        text = asciiLines('INTEREST APPLIED', `${amt}${ctx.month ? ` for ${fmtMonth(ctx.month)}` : ''}`, `Ref: ${ref}`, stmt);
        break;
    case KINDS.A_RECEIPT:
        text = asciiLines('PAYMENT RECEIVED', `${amt}${on}`, `Ref: ${ref}`, stmt);
        break;
    case KINDS.B_DISBURSED:
        text = asciiLines(ctx.further ? 'FURTHER LOAN PAID OUT' : 'LOAN PAID OUT', `${amt}${on}`, `Balance: ${fmtMoney(ctx.balance, cur)}`, `Ref: ${ref}`, stmt);
        break;
    case KINDS.B_REPAYMENT:
        // The payment that settles a loan is acknowledged like any other (the balance is simply nothing); that the loan is closed is the
        // next text's news (B_CLOSED), so the person is not told the same thing twice.
        text = asciiLines('REPAYMENT RECEIVED', `${amt}${on}`, `Balance: ${fmtMoney(ctx.balance, cur)}`, `Ref: ${ref}`, stmt);
        break;
    case KINDS.B_CLOSED:
        text = asciiLines('LOAN FULLY SETTLED', `Closed${on}. Thank you.`, `Ref: ${ref}`, stmt);
        break;
    case KINDS.A_CLOSED:
        text = asciiLines('INVESTMENT CLOSED', `Fully settled${on}. Thank you.`, `Ref: ${ref}`, stmt);
        break;
    case KINDS.B_LATE:
        text = asciiLines('PAYMENT REMINDER', `Outstanding: ${fmtMoney(ctx.balance, cur)}`, ctx.dateISO ? `Due: ${fmtDay(ctx.dateISO)}` : 'Past its due date.', `Ref: ${ref}`, stmt);
        break;
    case KINDS.B_BALANCE: {
        const asAt = ctx.dateISO ? ` as at ${fmtDay(ctx.dateISO)}` : '';
        text = Number(ctx.balance) > 0
            ? asciiLines('YOUR BALANCE', `${fmtMoney(ctx.balance, cur)}${asAt}`, `Ref: ${ref}`, stmt)
            : asciiLines('NOTHING OUTSTANDING', `No balance due${asAt}. Thank you.`, `Ref: ${ref}`, stmt);
        break;
    }
    case KINDS.O_DUE: {
        // To the owner's own phone: no link, no names of other people, so there is room for the whole layout.
        const days = Number(ctx.days);
        const name = s(ctx.label);
        const what = ctx.what === 'once' ? 'ONE-TIME PAYMENT' : ctx.what === 'bill' ? 'BILL' : ctx.what === 'cheque' ? 'CHEQUE' : ctx.what === 'card' ? 'CARD PAYMENT' : 'LOAN INSTALMENT';
        const verb = ctx.what === 'cheque' ? 'CLEARS' : 'DUE';
        const when = days <= 0 ? 'TODAY' : days === 1 ? 'TOMORROW' : `IN ${days} DAYS`;
        const head = `${what} ${verb} ${when}`;
        text = asciiLines(days <= 0 ? `** ${head} **` : head, name,
            `Amount: ${amt}`, ctx.dateISO ? `${ctx.what === 'cheque' ? 'Clears' : 'Due'}: ${fmtDay(ctx.dateISO)}` : '',
            ctx.what === 'cheque' ? 'Keep funds ready.' : days <= 0 ? 'Please pay today.' : '');
        break;
    }
    default:
        return '';
    }
    return text;
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

/**
 * The portal's one-time code. Says what it is for, how long it lives and never to share it.
 *
 * The last line is the web's origin-bound format, "@host #code" (the host only: no scheme, port or path; one space; nothing after it), set
 * off from the sentence by a blank line exactly as the format's own examples are (https://github.com/WICG/sms-one-time-codes). A phone that
 * sees it offers the code on the keyboard of the page that really is that host, and only there, so a look-alike site cannot collect it;
 * Chrome on Android can fill it in with one tap. The blank line and the last line are 29 characters, so the text stays one part.
 */
export function otpMessage(code, minutes = 3, host = OFFICIAL_HOST) {
    const c = s(code).replace(/\D/g, '');
    const text = asciiOnly(`${c} is your WealthFlow verification code. It expires in ${minutes} minutes. Do not share it with anyone.`);
    const h = s(host).trim().toLowerCase();
    return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) && c ? `${text}\n\n@${h} #${c}` : text;
}

export default { KINDS, currencyOf, fmtMoney, fmtDay, fmtMonth, refCode, buildMessage, otpMessage, asciiOnly, asciiLines };
