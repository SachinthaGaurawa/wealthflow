/* =============================================================================
 * statement-credit-evidence.mjs — which lines of a CARD statement have a bank payment of the same amount behind them
 * -----------------------------------------------------------------------------
 * Production, 2026-11-04 (`statement-card-proof` `why.totals.diag`): the balances of an HNB card statement miss by more than ALL its waiting lines together, and by an amount that the waiting lines plus the
 * ones already filed can make in more than one way. So money that came back to the card is among the lines the layout proof filed as purchases (a payment whose words say nothing). The statement's amounts alone
 * cannot say which: it takes a second, independent witness.
 *
 * The witness is the owner's own bank: the money that paid the card LEFT a bank account, and that bank's statement is in the books as spending of exactly the same amount, to the cent, on a day from four days
 * before the card posted it to one day after (the window statement-legs.mjs uses for the same pair, the other way round). A line of the card statement with such a bank payment behind it is a candidate for "money
 * came back"; a line without one is not a candidate at all. Two independent sources must then agree again, to the cent, on ONE choice of lines (statement-direction.mjs proveByTotals), or nothing is touched.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

const cents = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Math.round(Number(v) * 100));
const dayOf = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };

/** The bank gave the money up this many days before the card posted it, or this many after. The bank's date can lag the card's: production 2026-11-06, the owner's own books hold a card payment posted TWO days before its bank debit
 *  (`statement-legs-plan` card:day-gap--2, a weekend), so the lag allowed is the three days `statement-twins` already counts a pair within. The arithmetic of the whole statement still has to agree to the cent: the window only picks candidates. */
export const BANK_BEFORE_DAYS = 4, BANK_AFTER_DAYS = 3;

/**
 * @param {object} user the owner's document
 * @param {{id:string, amount:number, date:string}[]} lines lines of ONE card statement
 * @param {{sourcePath:string, before?:number, after?:number, anySource?:boolean}} ctx the statement they are on (its own records are never evidence of themselves); `before`/`after`/`anySource` widen the window only to COUNT (diagnostics), never to prove
 * @returns {Set<string>} the ids of the lines that have at least one bank payment of the same amount behind them
 */
export function lineIdsWithBankPayment(user, lines, { sourcePath = '', before = BANK_BEFORE_DAYS, after = BANK_AFTER_DAYS, anySource = false } = {}) {
    const bank = (Array.isArray(user && user.expenses) ? user.expenses : []).filter((record) => record && (anySource || record.source === 'statement') && record.statementKey !== sourcePath && Number.isFinite(cents(record.amount)) && Number.isFinite(dayOf(record.date)));
    const byAmount = new Map();
    for (const record of bank) { const key = cents(record.amount); if (!byAmount.has(key)) byAmount.set(key, []); byAmount.get(key).push(dayOf(record.date)); }
    const out = new Set();
    for (const line of Array.isArray(lines) ? lines : []) {
        const day = dayOf(line && line.date), days = byAmount.get(cents(line && line.amount));
        if (!days || !Number.isFinite(day)) continue;
        if (days.some((paid) => day - paid >= -after && day - paid <= before)) out.add(String(line.id));
    }
    return out;
}

export default { lineIdsWithBankPayment, BANK_BEFORE_DAYS, BANK_AFTER_DAYS };
