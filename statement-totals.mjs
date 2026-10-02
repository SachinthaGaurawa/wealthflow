/* =============================================================================
 * statement-totals.mjs — the totals a bank prints at the foot of a statement, as a second proof
 * -----------------------------------------------------------------------------
 * The one proof a reading had was the chain of balances: opening + credits - debits = closing. DFCC's "Your Combined Banking Statement" also prints, under the last row, "Transaction Summary
 * 1,536,807.95 852,027.00" — the total withdrawn and the total deposited in the period. Those two figures are the bank's own addition of every row, made independently of the running balances, and
 * a reading whose debits and credits both reach them to the cent has every row, in the right direction, whatever happened to a balance column (a sign dropped, a balance misread, a page
 * carried forward). Two independent figures agreeing to the cent is not a coincidence, so when the balance chain does NOT close but these two do, the statement is proven by them.
 *
 * Recognised only in the shapes banks really print, and only when BOTH figures are there:
 *   "Transaction Summary <withdrawals> <deposits>"      (column order read from the header: "Withdrawal (Dr)  Deposit (Cr)")
 *   "Total Debits|Withdrawals|Dr … <figure>" and "Total Credits|Deposits|Cr … <figure>"
 * A statement with several accounts prints one set per account; they are added.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

const FIGURE = String.raw`(\d{1,3}(?:,\d{3})+\.\d{2}|\d+\.\d{2})`;
const cents = value => Math.round(Number(String(value).replace(/,/g, '')) * 100);

/** @returns {{debits:number, credits:number, how:string}|null} the printed totals in cents, or null when the statement prints none in a shape recognised */
export function printedTotals(text) {
    const src = String(text || '');
    if (!src) return null;
    // the header names the column order: "Withdrawal (Dr)  Deposit (Cr)" is debits first, "Credit  Debit" the other way round
    const creditFirst = /(?:deposit\w*|credit)[^\n\d]{0,30}(?:withdraw\w*|debit)/i.test(src) && !/(?:withdraw\w*|debit)[^\n\d]{0,30}(?:deposit\w*|credit)/i.test(src);
    const pairs = [...src.matchAll(new RegExp(String.raw`transaction\s+summary[:\s]+` + FIGURE + String.raw`\s+` + FIGURE, 'gi'))];
    if (pairs.length) {
        const sum = pairs.reduce((acc, m) => { const a = cents(m[1]), b = cents(m[2]); acc.first += a; acc.second += b; return acc; }, { first: 0, second: 0 });
        return creditFirst ? { debits: sum.second, credits: sum.first, how: 'transaction-summary' } : { debits: sum.first, credits: sum.second, how: 'transaction-summary' };
    }
    const debits = [...src.matchAll(new RegExp(String.raw`total\s+(?:withdrawals?|debits?|dr)\b[^\d\n]{0,30}` + FIGURE, 'gi'))].map(m => cents(m[1]));
    const credits = [...src.matchAll(new RegExp(String.raw`total\s+(?:deposits?|credits?|cr)\b[^\d\n]{0,30}` + FIGURE, 'gi'))].map(m => cents(m[1]));
    if (debits.length && debits.length === credits.length) return { debits: debits.reduce((a, b) => a + b, 0), credits: credits.reduce((a, b) => a + b, 0), how: 'total-lines' };
    return null;
}

/**
 * Do the rows add up to the totals the statement prints?
 * @returns {{present:boolean, ok:boolean, printed?:{debits:number,credits:number}, computed?:{debits:number,credits:number}, how?:string}}  all in cents
 */
export function totalsAgree(parsed, text) {
    const printed = printedTotals(text);
    const rows = Array.isArray(parsed && parsed.rows) ? parsed.rows : [];
    if (!printed || !rows.length) return { present: false, ok: false };
    const computed = { debits: 0, credits: 0 };
    for (const row of rows) {
        if (!row || row.valid === false || !(Number(row.amount) > 0)) continue;
        if (row.direction === 'debit') computed.debits += cents(row.amount);
        else if (row.direction === 'credit') computed.credits += cents(row.amount);
        else return { present: true, ok: false, printed: { debits: printed.debits, credits: printed.credits }, computed, how: printed.how };      // a row with no direction: nothing is proven
    }
    return { present: true, ok: computed.debits === printed.debits && computed.credits === printed.credits, printed: { debits: printed.debits, credits: printed.credits }, computed, how: printed.how };
}

export default { printedTotals, totalsAgree };
