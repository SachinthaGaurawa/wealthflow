/* =============================================================================
 * statement-repair.mjs — one row the reader got wrong, found by the statement's own arithmetic
 * -----------------------------------------------------------------------------
 * A statement that does not add up used to stop whole: "These rows do not add up to the closing balance — a difference of -80,735.16. A row may be missing. 119 transactions
 * found." (DFCC, Aug 26). The difference was not an unknown: 80,735.16 is 50,000.00 + 30,735.16, and one row printed "Outward Ceft Transfer 376657XXXXX0276 50,000.00" with an
 * amount of 30,735.16 read as money IN — a debit of 50,000.00 whose amount sits in its own description, read with the balance beside it as a credit. One row read the wrong way
 * moves the total by exactly (what it should be) − (what it was); when exactly ONE correction of ONE row makes the opening balance reach the closing balance to the cent, that is not a
 * guess but the only reading the printed figures allow, and the statement is proven by it.
 *
 * The corrections tried, row by row:
 *   the amount is another figure the row itself carries (a money token in its own description, or the change between its running balance and the previous row's),
 *   the direction is the other way (only a row whose direction the reader had to ASSUME or read from wording — never one the page marked).
 * Nothing is repaired when the correction is not unique, when the statement was not read as one chain of rows with printed balances, or when the rows came from embedded data whose
 * completeness is unverified. A repaired row says so (`repaired`), and the statement says which row.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

const cents = (v) => Math.round(Number(v) * 100);
const MONEY = /(?<![\d.,])\d{1,3}(?:,\d{3})+\.\d{2}(?![\d])|(?<![\d.,])\d+\.\d{2}(?![\d])/g;
const FLAGGED = new Set(['assumed', 'keyword', 'balance-mismatch', '']);

/** The figures a row's description carries: "…0276 50,000.00" -> [50000]. */
export function figuresIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(MONEY)) { const v = Number(m[0].replace(/,/g, '')); if (Number.isFinite(v) && v > 0) out.push({ value: v, text: m[0], at: m.index }); }
    return out;
}

const effect = (model, amount, direction) => (model === 'card' ? (direction === 'credit' ? -1 : 1) : (direction === 'credit' ? 1 : -1)) * cents(amount);

/**
 * @param {object} parsed  the parser's result ({rows, reconciliation, layout, verdict, ...})
 * @returns {{parsed: object, repaired: null | {index:number, from:{amount:number,direction:string}, to:{amount:number,direction:string}, how:string}}}
 */
export function repairByArithmetic(parsed) {
    const rec = parsed && parsed.reconciliation;
    const rows = parsed && Array.isArray(parsed.rows) ? parsed.rows : [];
    const none = { parsed, repaired: null };
    if (!rec || rec.ok !== false || !rows.length || rows.length > 5000 || (parsed.layout && parsed.layout.embeddedRows)) return none;
    if (!Number.isFinite(Number(rec.opening)) || !Number.isFinite(Number(rec.closing)) || rec.opening === null || rec.closing === null) return none;
    const model = (parsed.layout && parsed.layout.statementType === 'credit-card') || rec.model === 'card' ? 'card' : 'account';
    const total = rows.reduce((sum, row) => sum + (row && row.valid !== false && Number(row.amount) > 0 && ['debit', 'credit'].includes(row.direction) ? effect(model, row.amount, row.direction) : 0), 0);
    const gap = cents(rec.closing) - (cents(rec.opening) + total);          // what the rows must move by, to reach the printed closing balance
    if (!gap) return none;
    const found = [];
    rows.forEach((row, index) => {
        if (!row || row.valid === false || !(Number(row.amount) > 0) || !['debit', 'credit'].includes(row.direction)) return;
        const was = effect(model, row.amount, row.direction);
        const amounts = new Map();                                              // value in cents -> how it was found
        for (const f of figuresIn(row.narration || row.description)) amounts.set(cents(f.value), 'a figure in the row\'s own description');
        const before = rows.slice(0, index).reverse().find(r => r && Number.isFinite(Number(r.balance)) && r.balance !== null);
        if (before && Number.isFinite(Number(row.balance)) && row.balance !== null) { const step = Math.abs(cents(row.balance) - cents(before.balance)); if (step > 0) amounts.set(step, 'the change between its running balance and the row before it'); }
        const directions = FLAGGED.has(String(row.directionSource || '')) ? ['debit', 'credit'] : [row.direction];
        for (const [amountCents, how] of amounts) for (const direction of directions) {
            if (amountCents === cents(row.amount) && direction === row.direction) continue;
            if (effect(model, amountCents / 100, direction) - was === gap) found.push({ index, amount: amountCents / 100, direction, how });
        }
        if (FLAGGED.has(String(row.directionSource || '')) && effect(model, row.amount, row.direction === 'debit' ? 'credit' : 'debit') - was === gap) found.push({ index, amount: Number(row.amount), direction: row.direction === 'debit' ? 'credit' : 'debit', how: 'the direction the reader had to assume' });
    });
    // the same correction found twice for one row (a figure that is also the balance step) is one correction
    const unique = [...new Map(found.map(f => [`${f.index}:${cents(f.amount)}:${f.direction}`, f])).values()];
    if (unique.length !== 1) return none;
    const fix = unique[0], row = rows[fix.index];
    const repairedRow = { ...row, amount: fix.amount, direction: fix.direction, directionSource: 'statement', needsReview: false, valid: true, repaired: 'arithmetic' };
    // the figure that was read as the amount no longer sits in the description
    const token = figuresIn(row.narration).find(f => cents(f.value) === cents(fix.amount));
    if (token) repairedRow.narration = (String(row.narration).slice(0, token.at) + String(row.narration).slice(token.at + token.text.length)).replace(/\s+/g, ' ').trim();
    if (repairedRow.description && token) repairedRow.description = repairedRow.narration;
    const next = { ...parsed, rows: rows.map((r, i) => (i === fix.index ? repairedRow : r)) };
    const credits = next.rows.reduce((s, r) => s + (r.valid !== false && r.direction === 'credit' ? Number(r.amount) || 0 : 0), 0), debits = next.rows.reduce((s, r) => s + (r.valid !== false && r.direction === 'debit' ? Number(r.amount) || 0 : 0), 0);
    next.reconciliation = { ...rec, credits: Math.round(credits * 100) / 100, debits: Math.round(debits * 100) / 100, expected: rec.closing, difference: 0, ok: true, repairedRow: fix.index };
    // the correction closes the arithmetic; a date the reader could not make sense of, or another row whose own balance disagrees, still keeps the statement from being called understood
    next.balanceMismatches = next.rows.filter(r => r.directionSource === 'balance-mismatch').length;
    const understood = !next.invalidDates && !next.balanceMismatches;
    next.verdict = understood ? 'parsed' : 'unverified'; next.understood = understood; next.reason = understood ? '' : (parsed.reason || '');
    return { parsed: next, repaired: { index: fix.index, from: { amount: Number(row.amount), direction: row.direction }, to: { amount: fix.amount, direction: fix.direction }, how: fix.how } };
}

export default { figuresIn, repairByArithmetic };
