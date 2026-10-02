/* =============================================================================
 * statement-direction.mjs — whether a row left the account or came in, when the page did not say so
 * -----------------------------------------------------------------------------
 * A statement with no running balance and no Dr/Cr marks (an NTB account's e-statement) gives the parser nothing to read a row's direction from; it ASSUMES a debit and marks
 * the row `needsReview`, and every such row then went to the owner one transaction at a time — "CEFT Charges Mirigama, 25.00, money out: check it against the statement". Two facts
 * the page does carry settle almost all of them, and neither is a guess:
 *
 *   the statement as a whole   the parser assumes DEBIT for every row it has no evidence for, so its only possible mistake is a credit read as a debit, and that raises the
 *                              debits by twice its amount. When the opening and the closing balance the page prints are reached to the cent, no such mistake exists. A row read
 *                              as a credit from its wording (INBOUND_RE) is the other possible mistake, so a flagged debit and a flagged credit of the SAME amount (which could
 *                              cancel each other) are left alone.
 *   the words of the row       a charge, a fee, stamp duty, a POS purchase or an ATM withdrawal is money out; a salary, a refund, a reversal or interest credited is money in.
 *                              Used only when it AGREES with the direction the parser assumed — never to turn one round — and when the wording says nothing the row stays as it was.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

const lower = (v) => String(v == null ? '' : v).toLowerCase();
const textOf = (row) => lower(row && (row.narration || row.description || row.desc || '')).replace(/[*_/]+/g, ' ').replace(/\s+/g, ' ');

const REVERSAL = /\b(?:refund|refunded|reversal|reversed|chargeback|cash\s*back|cashback|reimburse\w*)\b/;
const CREDIT_WORDS = /\b(?:salary|payroll|wages|stipend|dividend|interest\s+(?:credit|credited|earned|paid\s+to\s+you)|int\.?\s*cr|credit\s+interest|cash\s+deposit|cheque\s+deposit|inward\s+(?:remittance|transfer)|remittance\s+received)\b/;
/* "charges" alone is a debit; "charge" in "chargeback" is not (REVERSAL is read first). A POS or ATM line is a purchase or a withdrawal. */
const DEBIT_WORDS = /\b(?:charges?|fees?|stamp\s+duty|debit\s+tax|commission|vat|pos(?:\s+(?:transaction|purchase))?|atm(?:\s+(?:withdrawal|wtd|cash))?|cash\s+withdrawal|card\s+purchase|ecom(?:merce)?(?:\s+transaction)?|visa\s+debit|master(?:card)?\s+debit)\b/;

/** What the words alone say: 'debit', 'credit' or '' (nothing, or both). */
export function semanticDirection(row) {
    const text = textOf(row);
    if (!text) return '';
    const reversal = REVERSAL.test(text), credit = reversal || CREDIT_WORDS.test(text), debit = DEBIT_WORDS.test(text);
    if (credit && debit && !reversal) return '';          // a salary line that also says "charges": the words disagree, so they prove nothing
    return credit ? 'credit' : debit ? 'debit' : '';
}

/** A bank's own line type — a fee, a POS purchase, an ATM withdrawal. It is never an instalment on a loan or a deposit to a savings target, whatever place name it carries. */
const INSTALMENT = /\b(?:instal+ment|repayment|emi|loan\s+payment|standing\s+order|savings\s+transfer)\b/;
export function genericBankLine(row) {
    const text = textOf(row);
    return !!text && DEBIT_WORDS.test(text) && !REVERSAL.test(text) && !INSTALMENT.test(text);
}

const flagged = (row) => !!row && row.needsReview === true && row.valid !== false && ['assumed', 'keyword'].includes(row.directionSource) && ['debit', 'credit'].includes(row.direction);
const cents = (v) => Math.round(Math.abs(Number(v)) * 100);

/**
 * The parsed statement with every flagged row whose direction is now proven marked as such. Returns new row objects only for the rows it changes.
 * @returns {{rows: object[], byStatement: number, byWords: number}}
 */
export function proveDirections(parsed) {
    const rows = Array.isArray(parsed && parsed.rows) ? parsed.rows : [];
    const rec = (parsed && parsed.reconciliation) || {};
    const balanced = rec.ok === true && Number.isFinite(Number(rec.opening)) && Number.isFinite(Number(rec.closing)) && rec.opening !== null && rec.closing !== null;
    const odd = new Map();                      // the amounts of flagged rows, by direction, to see which could cancel each other
    for (const row of rows) if (flagged(row)) { const key = `${cents(row.amount)}:${row.direction}`; odd.set(key, (odd.get(key) || 0) + 1); }
    let byStatement = 0, byWords = 0;
    const out = rows.map((row) => {
        if (!flagged(row)) return row;
        const other = row.direction === 'debit' ? 'credit' : 'debit';
        if (balanced && !odd.has(`${cents(row.amount)}:${other}`)) { byStatement += 1; return { ...row, directionSource: 'statement', needsReview: false }; }
        if (semanticDirection(row) === row.direction) { byWords += 1; return { ...row, directionSource: 'words', needsReview: false }; }
        return row;
    });
    return { rows: out, byStatement, byWords };
}

export default { semanticDirection, genericBankLine, proveDirections };
