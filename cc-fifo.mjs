/* =============================================================================
 * cc-fifo.mjs — card payments settle card charges oldest first, to the cent
 * -----------------------------------------------------------------------------
 * What a card payment ("CASH PAYMENT-FINACLE", "PAYMENT - THANK YOU", a manual top-up) pays is not decided one charge at a time and not by the date it posts: it clears the card's whole
 * debt in the order the debt was taken on. The rule, per card (a bank and the card's last four digits):
 *
 *   1. every payment ever made to the card goes into ONE pool — the sum of the credits;
 *   2. the charges are walked from the OLDEST date to the newest (the smaller amount first within one day — the order the owner's worked example fixed);
 *   3. a charge is paid when the pool can cover it IN FULL: the pool shrinks by its amount and the charge is Auto-paid;
 *   4. the first charge the pool cannot cover FREEZES the walk: it, and every newer charge, stays unpaid (Pending, or Overdue once its 50 days are up). What is left in the pool is carried
 *      forward — it is not spread over a charge it cannot clear — and it is what the next payment adds to;
 *   5. the walk is recomputed from the whole timeline every time anything changes (a payment added, deleted or edited, a charge added), never patched: the answer cannot depend on the order the
 *      statements arrived in, and running it twice gives the same answer.
 * A charge the owner marked paid by hand (`paidManually`) is outside the pool.
 *
 * ARITHMETIC: every amount is turned into an integer number of cents the moment it is read, from its decimal text — never through a binary float — and only integers are added, subtracted and
 * compared. 0.1 + 0.2 is exactly 0.3 here, a pool never drifts by a fraction of a cent however many rows it passes through, and "covers" is `>=` on integers, not a tolerance. (A JS number holds
 * integers exactly up to 9 × 10^15 cents: ninety trillion rupees.)
 *
 * Pure: no network, no clock, no storage. The page runs the same rule (wealthflow-cc-reconcile.js, kept equal by a test); the worker applies it to the owner's document (healCardSettlement).
 * ===========================================================================*/

import { canonicalBank } from './wealthflow-institutions.js';

/** A decimal amount (number or text, thousands commas allowed) as whole cents, half a cent rounded up, read from the decimal text and never through float arithmetic. */
export function toCents(value) {
    if (value == null || value === '') return 0;
    let text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value);
    if (/e/i.test(text)) text = Number(text).toFixed(6);                       // 1e-7 style: spelled out once, then read as text
    text = text.replace(/,/g, '').trim();
    const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
    if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return 0;
    const whole = m[2] === '' ? '0' : m[2], frac = (m[3] || '').padEnd(3, '0');
    let cents = Number(whole) * 100 + Number(frac.slice(0, 2));
    if (Number(frac[2]) >= 5) cents += 1;                                       // the third decimal rounds the cent, half up
    return m[1] === '-' ? -cents : cents;
}

/** Whole cents as a decimal string with two places ("1234.50"), for logs and screens. */
export function fromCents(cents) {
    const n = Math.round(Number(cents) || 0), sign = n < 0 ? '-' : '', abs = Math.abs(n);
    return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const msOf = value => {
    if (value == null) return 0;
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();
    const text = String(value).trim();
    const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(text);
    if (dmy) return Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1]);
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    const t = Date.parse(text);
    return Number.isFinite(t) ? t : 0;
};

/**
 * One card: the pool, the walk, who is paid and who waits.
 * @param {{id:*, amount:*, date?:*, dateMs?:number, timestamp?:number}[]} charges
 * @param {{amount:*}[]} credits
 * @returns {{
 *   settledIds:*[], unsettledIds:*[], poolCents:number, creditCents:number, carryCents:number,
 *   blocked: null | {id:*, amountCents:number, needsCents:number},
 *   detail: {id:*, amountCents:number, settled:boolean, state:'paid'|'blocked'|'waiting', needsCents:number}[]
 * }}
 */
export function allocateTopUps(charges, credits) {
    const list = Array.isArray(charges) ? charges : [], pays = Array.isArray(credits) ? credits : [];
    const creditCents = pays.reduce((sum, c) => sum + Math.max(0, toCents(c && c.amount)), 0);
    const walk = list
        .map((c, order) => ({ c, order, at: msOf(c && (c.dateMs != null ? c.dateMs : c.timestamp != null ? c.timestamp : c.date)), cents: toCents(c && c.amount) }))
        .filter(x => x.c && x.cents > 0)
        .sort((a, b) => a.at - b.at || a.cents - b.cents || a.order - b.order);        // oldest first; the smaller amount first within a day; then the order given
    let pool = creditCents, blocked = null;
    const detail = [], settledIds = [], unsettledIds = [];
    for (const x of walk) {
        if (!blocked && pool >= x.cents) {
            pool -= x.cents;
            settledIds.push(x.c.id);
            detail.push({ id: x.c.id, amountCents: x.cents, settled: true, state: 'paid', needsCents: 0 });
        } else {
            if (!blocked) blocked = { id: x.c.id, amountCents: x.cents, needsCents: x.cents - pool };
            unsettledIds.push(x.c.id);
            detail.push({ id: x.c.id, amountCents: x.cents, settled: false, state: x.c.id === blocked.id ? 'blocked' : 'waiting', needsCents: x.c.id === blocked.id ? blocked.needsCents : 0 });
        }
    }
    return { settledIds, unsettledIds, poolCents: pool, creditCents, carryCents: pool, blocked, detail };
}

/** The card a record belongs to: its bank (as the books name it) and the last four digits of the card. */
export const cardKey = (record, canon = canonicalBank) => `${String(canon(String((record && record.bank) || '')) || '').toLowerCase().trim()}|${String((record && (record.card_last4 || record.last4)) || '').trim()}`;
/** What a charge asks of the card: the purchase and any fee, each in cents. */
export const chargeCents = record => (record && record.combinedTotal != null ? toCents(record.combinedTotal) : toCents(record && record.amount) + toCents(record && record.serviceFee));

/**
 * The paid / auto-paid state of every card charge in the owner's document, from the whole timeline. Nothing is changed.
 * @param {object} user the owner's document (`cconetime` charges, `ccPayments` credits)
 * @returns {{cards: {key:string, charges:number, credits:number, settled:number, pending:number, carryCents:number, blocked:null|object}[], want: Map<object, boolean>}}
 */
export function settleCards(user, { canon = canonicalBank } = {}) {
    const list = key => (Array.isArray(user && user[key]) ? user[key] : []).filter(Boolean);
    const groups = new Map();
    const group = key => { if (!groups.has(key)) groups.set(key, { charges: [], credits: [] }); return groups.get(key); };
    for (const record of list('cconetime')) group(cardKey(record, canon)).charges.push(record);
    for (const record of list('ccPayments')) group(cardKey(record, canon)).credits.push(record);
    const want = new Map(), cards = [];
    for (const [key, g] of groups) {
        const inPool = g.charges.filter(record => !record.paidManually);                          // a charge the owner settled by hand is outside the pool
        const res = allocateTopUps(inPool.map(record => ({ id: record, amount: fromCents(chargeCents(record)), date: record.date })), g.credits);
        const settled = new Set(res.settledIds);
        for (const record of inPool) want.set(record, settled.has(record));
        cards.push({ key, charges: g.charges.length, credits: g.credits.length, settled: res.settledIds.length, pending: res.unsettledIds.length, carryCents: res.carryCents, blocked: res.blocked && { ...res.blocked, id: res.blocked.id && res.blocked.id.id } });
    }
    return { cards, want };
}

/**
 * Write that state onto the charges: `paid` and `autoPaid` follow the walk, `paidAt` is set when a charge becomes paid and removed when it stops being. Mutates `user.cconetime`.
 * @returns {{changed:number, settled:number, pending:number, cards:object[]}}
 */
export function applyCardSettlement(user, now = Date.now(), options) {
    const { cards, want } = settleCards(user, options);
    let changed = 0, settled = 0, pending = 0;
    for (const [record, paid] of want) {
        if (paid) settled += 1; else pending += 1;
        if (!!record.paid !== paid || !!record.autoPaid !== paid) {
            record.paid = paid; record.autoPaid = paid;
            if (paid) { if (!record.paidAt) record.paidAt = now; } else delete record.paidAt;
            changed += 1;
        }
    }
    return { changed, settled, pending, cards };
}

export default { toCents, fromCents, allocateTopUps, cardKey, chargeCents, settleCards, applyCardSettlement };
