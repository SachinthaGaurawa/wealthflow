/* =============================================================================
 * statement-owner-confirmed.mjs — what the owner CONFIRMED on the "Map statement layout" screen stays confirmed
 * -----------------------------------------------------------------------------
 * WHY. The teach screen shows every row with its date, words, In/Out and amount, and the owner presses "Yes, read it this way". The server then
 * saved only the layout TEMPLATE (a date shape) and read the statement again from scratch; the re-reading marked every row whose direction rests on
 * an assumption or on a word (`needsReview: true`, source `assumed` or `keyword`), and the ledger refuses such a row ("unproven-direction"). A card
 * statement with no running balance and no CR marks is exactly that, so after "Yes" the statement came straight back to Open reviews with its rows
 * unfiled and the owner's confirmation was thrown away. (Reproduced with an invented statement in test/statement_owner_confirmed_test.js.)
 *
 * THE RULE. The owner's "Yes" is the strongest proof of a row's direction there is: they looked at the statement and at the row. So the confirmed
 * rows are kept on the statement's record as bare keys (date, cents, direction; no words, no names), and when that statement is read again with that
 * layout, each row that matches a confirmed key takes the owner's direction as a `marker` (the same proof the owner's own decision in a review carries).
 * Nothing else changes: the row still passes every settlement check, the classification (rules, merchant list, AI board) still decides WHERE it goes,
 * and a row that matches no confirmed key keeps whatever the reader made of it. A key is used once, so two equal-looking rows need two confirmations.
 * ============================================================================= */

const MAX_KEYS = 5000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const cents = amount => { const value = Number(amount); return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0; };

/** The rows the owner confirmed, as `date|cents|d` (d = debit) or `date|cents|c` (c = credit). Anything that is not a whole row is left out. */
export function confirmedKeys(rows) {
    const keys = [];
    for (const row of Array.isArray(rows) ? rows : []) {
        const date = String(row?.date || ''), amount = cents(row?.amount);
        if (!DATE.test(date) || !amount || !['debit', 'credit'].includes(row?.direction)) continue;
        keys.push(`${date}|${amount}|${row.direction === 'credit' ? 'c' : 'd'}`);
        if (keys.length >= MAX_KEYS) break;
    }
    return keys;
}

/**
 * @param {Array<object>} rows  the reader's rows, in statement order
 * @param {string[]} keys       what `confirmedKeys` stored when the owner pressed Yes
 * @returns {{rows: Array<object>, applied: number}}  never mutates its input
 */
export function applyOwnerConfirmed(rows, keys) {
    const list = Array.isArray(rows) ? rows : [];
    if (!Array.isArray(keys) || !keys.length || !list.length) return { rows: list, applied: 0 };
    const queues = new Map();
    for (const key of keys) {
        const [date, amount, flag] = String(key).split('|');
        if (!DATE.test(date) || !/^\d+$/.test(amount || '') || !['c', 'd'].includes(flag)) continue;
        const at = `${date}|${amount}`;
        if (!queues.has(at)) queues.set(at, []);
        queues.get(at).push(flag === 'c' ? 'credit' : 'debit');
    }
    let applied = 0;
    const out = list.map(row => {
        if (!row || !(Number(row.amount) > 0)) return row;
        const queue = queues.get(`${row.date}|${cents(row.amount)}`);
        if (!queue || !queue.length) return row;
        // prefer the confirmed direction the reader already agrees with, so two equal amounts on one day keep their own directions
        const same = queue.indexOf(row.direction);
        const direction = queue.splice(same >= 0 ? same : 0, 1)[0];
        applied += 1;
        return { ...row, direction, directionSource: 'marker', needsReview: false, valid: true, ownerConfirmed: true };
    });
    return { rows: out, applied };
}

export default { confirmedKeys, applyOwnerConfirmed };
