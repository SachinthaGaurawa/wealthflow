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
 *
 * Pure: no clock (`now` is passed), no network. The NIC and phone are matched through
 * their HMACs, so this module never needs either in the clear.
 * ===========================================================================*/

import { normalizeNic } from './wealthflow-nic.js';
import { normalizePhone } from './wealthflow-phone.js';
import { debtorSummary, EVENT } from './wealthflow-liquidity.js';
import { FIELDS, periodInterest } from './sms-events.mjs';
import { refCode, currencyOf } from './sms-templates.mjs';
import { nicHashOf, phoneHashOf } from './tenant-links.mjs';

export const MAX_RECORDS = 200;

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => String(v == null ? '' : v).trim();
const money = (v) => Math.round(num(v) * 100) / 100;
const day = (v) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(str(v)); return m ? m[1] : ''; };

const isOn = (rec) => !!rec && rec[FIELDS.ENABLED] === true;
const nicMatches = (rec, nicHash, secret) => { const n = normalizeNic(rec && rec[FIELDS.NIC]); return n.ok && nicHashOf(n.canonical, secret) === nicHash; };
const phoneMatches = (rec, phoneHash, secret) => { const p = normalizePhone(rec && rec[FIELDS.PHONE]); return p.ok && !!phoneHash && phoneHashOf(p.e164, secret) === phoneHash; };

/** The records of one lender's document this tenant may see. */
export function recordsFor(user, { nicHash, phoneHash, secret, own }) {
    const u = user && typeof user === 'object' ? user : {};
    const keep = (rec) => isOn(rec) && rec.id && nicMatches(rec, nicHash, secret) && (own || phoneMatches(rec, phoneHash, secret));
    return { investments: arr(u.income).filter(keep), debtors: arr(u.debtors).filter(keep) };
}

function investmentRow(inv, user) {
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
        payments,
        totalReceived: money(payments.reduce((a, p) => a + p.amount, 0)),
    };
}

function loanRow(d, now) {
    const su = debtorSummary(d, new Date(now));
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
        events,
    };
}

/**
 * @param {{ledgers:{uid:string,user:object,own:boolean,currency?:string}[], nicHash:string, phoneHash:string, secret:Buffer|string, now:number}} p
 * @returns {{asOf:string, groups:object[], totals:object[], truncated:boolean}}
 */
export function buildStatement({ ledgers, nicHash, phoneHash, secret, now }) {
    const groups = [];
    let truncated = false;
    for (const ledger of arr(ledgers)) {
        const user = ledger && ledger.user && typeof ledger.user === 'object' ? ledger.user : {};
        const currency = currencyOf(user.settings && user.settings.currency);
        const { investments, debtors } = recordsFor(user, { nicHash, phoneHash, secret, own: !!ledger.own });
        for (const inv of investments) groups.push({ ...investmentRow(inv, user), currency });
        for (const d of debtors) groups.push({ ...loanRow(d, now), currency });
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
    return { asOf: new Date(now).toISOString(), groups, totals, truncated };
}

export default { MAX_RECORDS, recordsFor, buildStatement };
