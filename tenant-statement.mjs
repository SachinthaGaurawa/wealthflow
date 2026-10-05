/* =============================================================================
 * tenant-statement.mjs — what a tenant is shown, and nothing else
 * -----------------------------------------------------------------------------
 * The owner's document holds everything: expenses, salaries, every other person's
 * loan, private notes. The tenant's statement is built from it by a function that
 * can only PICK, never pass through:
 *
 *   WHICH RECORDS. Those the owner switched text messages on for AND whose NIC is the
 *   tenant's. Across ONE lender (the lender whose text carried the link) that is the
 *   whole of "all ledgers under one NIC": the investments and the loans, together. Across
 *   OTHER lenders it is only the records whose phone number is the very number the
 *   one-time code just went to — an NIC is an identifier, not a secret, so it is never
 *   enough on its own to read another lender's books.
 *   WHAT OF EACH. Figures and dates, under a reference code. Never a name, a note, a phone
 *   number, an NIC, a record id, or a payment nobody confirmed. The owner's free text is
 *   the one place a private opinion of a person could be sitting, so none of it is ever
 *   read here. Titles are generic ("Investment", "Loan"); the reference identifies it.
 *   LOANS CARRY NO INTEREST. There is no interest field on a loan row, by construction.
 *   WHERE TO PAY. The lender's bank accounts (wealthflow-payaccounts.js) go out as a WHITELIST of six fields, only
 *   those the lender marked for this kind of record (an investor's account is not shown to a debtor unless it is
 *   marked for both), only for a lender whose records the person is actually shown, and never an id or a setting.
 *   WHEN. A loan carries the date the lender expects it back (while money is outstanding) and an investment its next
 *   interest date, both worked out from the lender's own dates; neither is a promise made by this page.
 *
 * Pure: no clock (`now` is passed), no network. The NIC and phone are matched through
 * their HMACs, so this module never needs either in the clear.
 * ===========================================================================*/

import { normalizeIdentity } from './wealthflow-nic.js';
import { normalizePhone } from './wealthflow-phone.js';
import { debtorSummary, EVENT } from './wealthflow-liquidity.js';
import { FIELDS, periodInterest, LOCAL_OFFSET_MIN } from './sms-events.mjs';
import { refCode, currencyOf } from './sms-templates.mjs';
import { nicHashOf, phoneHashOf } from './tenant-links.mjs';
import { paysInMonth, dueDateFor, dayOfMonth } from './wealthflow-verify-matrix.js';
import { publicAccounts, PAY_KEY } from './wealthflow-payaccounts.js';

export const MAX_RECORDS = 200;

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => String(v == null ? '' : v).trim();
const money = (v) => Math.round(num(v) * 100) / 100;
const day = (v) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v)); return m ? m[1] : ''; };

const isOn = (rec) => !!rec && rec[FIELDS.ENABLED] === true;
const nicMatches = (rec, nicHash, secret) => { const n = normalizeIdentity(rec && rec[FIELDS.NIC]); return n.ok && nicHashOf(n.canonical, secret) === nicHash; };
const phoneMatches = (rec, phoneHash, secret) => { const p = normalizePhone(rec && rec[FIELDS.PHONE]); return p.ok && !!phoneHash && phoneHashOf(p.e164, secret) === phoneHash; };

/** The records of one lender's document this tenant may see. */
export function recordsFor(user, { nicHash, phoneHash, secret, own }) {
    const u = user && typeof user === 'object' ? user : {};
    const keep = (rec) => isOn(rec) && rec.id && nicMatches(rec, nicHash, secret) && (own || phoneMatches(rec, phoneHash, secret));
    return { investments: arr(u.income).filter(keep), debtors: arr(u.debtors).filter(keep) };
}

/** Today's date in the lender's own calendar (Sri Lanka), as a UTC-midnight instant: the books keep their dates in that calendar. */
const localToday = (now) => { const d = new Date(now + LOCAL_OFFSET_MIN * 60000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

/**
 * The next day this investment pays interest on or after today, with the amount, or null (it has ended, or the books do not say when).
 * Looked for up to two years ahead, which covers a yearly payer.
 */
export function nextInterest(inv, now) {
    const today = localToday(now);
    const amount = money(periodInterest(inv));
    if (!(amount > 0)) return null;
    const base = new Date(today);
    for (let i = 0; i <= 25; i += 1) {
        const idx = base.getUTCMonth() + i;
        const y = base.getUTCFullYear();
        if (!paysInMonth(inv, y, idx)) continue;
        const due = dueDateFor(dayOfMonth(inv.day), y, idx);
        if (due.getTime() < today) continue;
        return { date: due.toISOString().slice(0, 10), amount };
    }
    return null;
}

function investmentRow(inv, user, now) {
    const received = (user.incomeReceived && typeof user.incomeReceived === 'object') ? user.incomeReceived : {};
    const prefix = `${inv.id}_`;
    const payments = [];
    for (const k of Object.keys(received).sort()) {
        if (!k.startsWith(prefix)) continue;
        const month = k.slice(prefix.length);
        const e = received[k];
        // a payment is a payment once the owner confirmed it; the bookkeeping marks for months before they joined are not payments
        if (!/^\d{4}-\d{2}$/.test(month) || !e || typeof e !== 'object' || e.auto || e.historical) continue;
        const at = num(e.confirmedAt) || num(e.at);
        if (!(at > 0)) continue;
        const amount = num(e.amount) > 0 ? num(e.amount) : periodInterest(inv);
        if (!(amount > 0)) continue;
        payments.push({ month, amount: money(amount), date: new Date(at + 330 * 60000).toISOString().slice(0, 10) });
    }
    return {
        kind: 'investment',
        ref: refCode('investment', inv.id),
        title: 'Investment',
        capital: money(inv.amount),
        ratePct: Math.round(num(inv.rate) * 100) / 100,
        frequency: ['monthly', 'quarterly', 'annual'].includes(str(inv.freq)) ? str(inv.freq) : 'monthly',
        interestPerPeriod: money(periodInterest(inv)),
        start: day(inv.start),
        end: day(inv.end),
        nextInterest: nextInterest(inv, now),
        payments,
        totalReceived: money(payments.reduce((a, p) => a + p.amount, 0)),
    };
}

function loanRow(d, now) {
    const su = debtorSummary(d, new Date(now));
    // a date only means something while money is still owed; once it is paid there is nothing to be late on
    const due = su.outstanding > 0 ? day(d.dueISO) : '';
    const late = due ? Math.floor((localToday(now) - Date.parse(`${due}T00:00:00Z`)) / 86400000) : 0;
    let balance = 0;
    const events = [];
    for (const e of su.events) {
        if (!e.confirmed) continue;                                      // a claim nobody has verified is not on the statement
        const out = e.kind === EVENT.LENT || e.kind === EVENT.TOPUP;
        balance = Math.max(0, balance + (out ? e.amount : -e.amount));
        events.push({ date: day(e.date), kind: e.kind === EVENT.TOPUP ? 'further' : (out ? 'lent' : 'repayment'), amount: money(e.amount), balance: money(balance) });
    }
    return {
        kind: 'loan',
        ref: refCode('debtor', d.id),
        title: 'Loan',
        lent: money(su.lent),
        repaid: money(su.repaid),
        outstanding: money(su.outstanding),
        // what the arithmetic says, plus the lender's own decision: a loan closed with a balance is "closed", not "settled"
        status: su.outstanding <= 0 ? 'settled' : (su.state === 'CLOSED' ? 'closed' : 'open'),
        due,
        overdueDays: late > 0 ? late : 0,
        events,
    };
}

/**
 * @param {{ledgers:{uid:string,user:object,own:boolean,currency?:string}[], nicHash:string, phoneHash:string, secret:Buffer|string, now:number}} p
 * @returns {{asOf:string, groups:object[], totals:object[], lenders:{n:number, accounts:object[]}[], lenderCount:number, truncated:boolean}}
 */
export function buildStatement({ ledgers, nicHash, phoneHash, secret, now }) {
    const groups = [];
    const lenders = [];
    let truncated = false;
    let n = 0;
    for (const ledger of arr(ledgers)) {
        const user = ledger && ledger.user && typeof ledger.user === 'object' ? ledger.user : {};
        const currency = currencyOf(user.settings && user.settings.currency);
        const { investments, debtors } = recordsFor(user, { nicHash, phoneHash, secret, own: !!ledger.own });
        if (!investments.length && !debtors.length) continue;
        n += 1;
        for (const inv of investments) groups.push({ ...investmentRow(inv, user, now), currency, lender: n });
        for (const d of debtors) groups.push({ ...loanRow(d, now), currency, lender: n });
        // where this lender wants to be paid: only the accounts meant for the kinds of record this person has with them
        const layers = [investments.length ? 'A' : '', debtors.length ? 'B' : ''].filter(Boolean);
        const accounts = publicAccounts(user[PAY_KEY], layers);
        if (accounts.length) lenders.push({ n, accounts });
    }
    if (groups.length > MAX_RECORDS) { groups.length = MAX_RECORDS; truncated = true; }
    // oldest first inside each kind, so a statement reads in the order things happened
    groups.sort((a, b) => (a.kind === b.kind ? (a.start || a.events?.[0]?.date || '').localeCompare(b.start || b.events?.[0]?.date || '') || a.ref.localeCompare(b.ref) : (a.kind === 'investment' ? -1 : 1)));

    const byCurrency = new Map();
    const t = (c) => { if (!byCurrency.has(c)) byCurrency.set(c, { currency: c, invested: 0, interestReceived: 0, loanOutstanding: 0 }); return byCurrency.get(c); };
    for (const g of groups) {
        if (g.kind === 'investment') { t(g.currency).invested += g.capital; t(g.currency).interestReceived += g.totalReceived; }
        else t(g.currency).loanOutstanding += g.outstanding;
    }
    const totals = [...byCurrency.values()].map((x) => ({ currency: x.currency, invested: money(x.invested), interestReceived: money(x.interestReceived), loanOutstanding: money(x.loanOutstanding) }));
    return { asOf: new Date(now).toISOString(), groups, totals, lenders, lenderCount: n, truncated };
}

export default { MAX_RECORDS, recordsFor, buildStatement, nextInterest };
