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
 *   the card's own layout      a CREDIT CARD statement prints a purchase as a plain amount and marks what comes back to the card (a payment, a refund) with CR, a minus or its own words. A plain
 *                              amount on such a statement with a merchant's name and no word of money coming back is a purchase. Used only on a card statement with no running balance, only
 *                              when the statement's own arithmetic does not contradict it (a statement whose opening and closing balances do NOT add up is left to the owner), and the
 *                              row says so on the record ('layout'): it is a convention of the layout, not a figure the page proves.
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

/* Words that mean money came BACK to a card. A line carrying one is never taken for a purchase by the card's layout, whatever else it says. */
const CARD_CREDIT_WORDS = /\b(?:payments?|pmt|thank\s*you|refund\w*|revers\w*|cash\s*back|cashback|credits?|adjust\w*|waiv\w*|rebate|rewards?|redeem\w*|repay\w*|received|settle\w*|transfer\s+in|cr)\b/;
export function cardCreditWords(row) { return CARD_CREDIT_WORDS.test(textOf(row)); }
/** WHICH of the fixed words above a row carries, as a name from this list only (never the row's own text): what a log line may say about why a card line was kept for the owner. '' when none. */
const CREDIT_WORD_NAMES = [[/^payments?$/, 'payment'], [/^pmt$/, 'pmt'], [/^thank/, 'thankyou'], [/^refund/, 'refund'], [/^revers/, 'reversal'], [/^cash\s*back$/, 'cashback'], [/^credits?$/, 'credit'], [/^adjust/, 'adjust'], [/^waiv/, 'waive'],
    [/^rebate$/, 'rebate'], [/^rewards?$/, 'reward'], [/^redeem/, 'redeem'], [/^repay/, 'repay'], [/^received$/, 'received'], [/^settle/, 'settle'], [/^transfer\s+in$/, 'transferin'], [/^cr$/, 'cr']];
export function cardCreditWordName(row) {
    const hit = CARD_CREDIT_WORDS.exec(textOf(row));
    if (!hit) return semanticDirection(row) === 'credit' ? 'inbound-words' : '';
    const found = CREDIT_WORD_NAMES.find(([pattern]) => pattern.test(hit[0].replace(/\s+/g, ' ')));
    return found ? found[1] : 'other';
}
const isCardStatement = (parsed, ctx) => !!(ctx && ctx.card === true) || String(parsed && parsed.layout && parsed.layout.statementType || '').toLowerCase().replace(/[^a-z]/g, '') === 'creditcard';

const flagged = (row) => !!row && row.needsReview === true && row.valid !== false && ['assumed', 'keyword'].includes(row.directionSource) && ['debit', 'credit'].includes(row.direction);
const cents = (v) => Math.round(Math.abs(Number(v)) * 100);

/**
 * The parsed statement with every flagged row whose direction is now proven marked as such. Returns new row objects only for the rows it changes.
 * @param ctx  { card: true } when the statement is known to be a credit card's (its own header, or Cards and accounts) — the reader's own `layout.statementType` is read too
 * @returns {{rows: object[], byStatement: number, byWords: number, byLayout: number}}
 */
export function proveDirections(parsed, ctx = {}) {
    const rows = Array.isArray(parsed && parsed.rows) ? parsed.rows : [];
    const rec = (parsed && parsed.reconciliation) || {};
    const balanced = rec.ok === true && Number.isFinite(Number(rec.opening)) && Number.isFinite(Number(rec.closing)) && rec.opening !== null && rec.closing !== null;
    const odd = new Map();                      // the amounts of flagged rows, by direction, to see which could cancel each other
    for (const row of rows) if (flagged(row)) { const key = `${cents(row.amount)}:${row.direction}`; odd.set(key, (odd.get(key) || 0) + 1); }
    /* THE CARD LAYOUT CONVENTION is open only on a card statement with no running balance, whose own arithmetic (when it has any) and balance checks do not contradict the rows. */
    const layoutOpen = isCardStatement(parsed, ctx) && !(parsed && parsed.layout && parsed.layout.balanceColumn) && rec.ok !== false && !(parsed && parsed.balanceMismatches) && !(parsed && parsed.invalidDates);
    let byStatement = 0, byWords = 0, byLayout = 0;
    const out = rows.map((row) => {
        if (!flagged(row)) return row;
        const other = row.direction === 'debit' ? 'credit' : 'debit';
        if (balanced && !odd.has(`${cents(row.amount)}:${other}`)) { byStatement += 1; return { ...row, directionSource: 'statement', needsReview: false }; }
        if (semanticDirection(row) === row.direction) { byWords += 1; return { ...row, directionSource: 'words', needsReview: false }; }
        if (layoutOpen && row.directionSource === 'assumed' && row.direction === 'debit' && !cardCreditWords(row) && semanticDirection(row) !== 'credit') { byLayout += 1; return { ...row, directionSource: 'layout', needsReview: false }; }
        return row;
    });
    return { rows: out, byStatement, byWords, byLayout };
}

/**
 * THE STATEMENT'S OWN ARITHMETIC DECIDES A FEW LINES THE WORDS CANNOT. The reader assumed every unmarked line is a debit and added up its rows: credits (what it could read as money in) and debits (the rest). The statement prints
 * its opening and closing balance. If some of the lines kept as debits are really credits, the balances miss by exactly twice their sum (an account: closing = opening + credits - debits; a card, which prints what is
 * OWED: closing = opening - credits + debits). So the sum of the lines that are really credits is half the miss, to the cent. Given the few lines that LOOK like money coming back (the candidates, by their words), this
 * finds the ones whose sum is that half: when exactly one choice of them does it, on the layout asked for, every candidate is proven, the chosen ones as credits and the rest as debits. No choice, or more than one:
 * nothing is proven and the owner is asked as before. At most 16 candidates (the choices are counted, not guessed); sums are in cents. `models` is the layout(s) the statement can be in ('card' for a statement
 * known to be a card's: asking both lets the sign of the miss pick the layout, which a card statement must never have done for it). A `none` says only WHY, in a fixed word (never an amount): the balances miss the wrong
 * way (sign), by an odd cent (odd), by more than all the candidates together (range), or by an amount no choice of them makes (subset).
 * @param {{opening:number, closing:number, credits:number, debits:number, candidates:{id:string, amount:number}[], models?:('bank'|'card')[]}} input
 * @returns {{fit:'unique'|'none'|'ambiguous'|'unusable', credit?:string[], debit?:string[], model?:'bank'|'card', reason?:'sign'|'odd'|'range'|'subset'}}
 */
export function proveByTotals({ opening, closing, credits, debits, candidates, models = ['bank', 'card'] }) {
    const money = (v) => (v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Math.round(Number(v) * 100));
    const o = money(opening), c = money(closing), cr = money(credits), db = money(debits);
    const list = Array.isArray(candidates) ? candidates.filter((x) => x && Number.isFinite(money(x.amount)) && money(x.amount) > 0) : [];
    if (![o, c, cr, db].every(Number.isFinite) || !list.length || list.length > 16 || list.length !== candidates.length) return { fit: 'unusable' };
    const amounts = list.map((x) => money(x.amount)), count = 1 << amounts.length, sums = new Float64Array(count), total = amounts.reduce((a, b) => a + b, 0);
    for (let mask = 1; mask < count; mask++) { const low = mask & -mask; sums[mask] = sums[mask ^ low] + amounts[31 - Math.clz32(low)]; }
    const found = new Map();           // mask -> model
    const rank = { sign: 0, odd: 1, range: 2, subset: 3 };
    let reason = 'sign';
    const worse = (next) => { if (rank[next] > rank[reason]) reason = next; };
    for (const [model, miss] of [['bank', c - (o + cr - db)], ['card', (o - cr + db) - c]]) {
        if (!models.includes(model)) continue;
        if (miss < 0) continue;
        if (miss % 2) { worse('odd'); continue; }
        const half = miss / 2;
        if (half > total) { worse('range'); continue; }
        worse('subset');
        for (let mask = 0; mask < count; mask++) if (sums[mask] === half && !found.has(mask)) found.set(mask, model);
    }
    if (!found.size) return { fit: 'none', reason };
    if (found.size > 1) return { fit: 'ambiguous' };
    const [[mask, model]] = [...found];
    return { fit: 'unique', model, credit: list.filter((_, i) => mask & (1 << i)).map((x) => x.id), debit: list.filter((_, i) => !(mask & (1 << i))).map((x) => x.id) };
}

export default { semanticDirection, genericBankLine, proveDirections, cardCreditWords, cardCreditWordName, proveByTotals };
