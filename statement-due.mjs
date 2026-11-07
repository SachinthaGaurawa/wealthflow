/* THE MINIMUM PAYMENT A CARD STATEMENT ASKS FOR, kept as what it is: a date the bank must have the money by, and the least that must reach it.
 *
 * It is not a transaction, and it is not a charge: filing it as a row (as the foot of a card statement used to be read) put a "payment" of 6,119.81 on the books that nobody made. The parser reads the figure and the date
 * off the statement's foot (wealthflow-statement-parser.js `due`); this turns them into ONE record per statement, in the owner's `cardDues` list, which the CC One-Time page shows as its own highlighted section.
 *
 * Pure: no clock, no database. The id comes from the statement, so reading the same statement again makes the same record, and removing the statement removes it (statementKey is what unfileStatement looks for).
 */
import { createHash } from 'node:crypto';
import { canonicalBank } from './wealthflow-institutions.js';

const cents = value => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
const isDay = value => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '')); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
export const isCardStatement = statementType => String(statementType || '').toLowerCase().replace(/[^a-z]/g, '') === 'creditcard';

/**
 * @param due            parsed.due  { date:'YYYY-MM-DD', minimum:number|null, closing:number|null }
 * @param sourcePath     the statement's path (its identity)
 * @returns the record to keep, or null when the statement is not a card's, or does not print both a minimum above zero and a real date
 */
export function cardDueRecord({ due, sourcePath, bank = '', last4 = '', statementType = '', now = Date.now() } = {}) {
    if (!due || !sourcePath || !isCardStatement(statementType)) return null;
    const minimum = cents(due.minimum);
    if (!minimum || !isDay(due.date)) return null;
    const closing = cents(due.closing);
    return {
        id: `due-${createHash('sha256').update(String(sourcePath)).digest('hex').slice(0, 20)}`,
        bank: canonicalBank(bank || ''), card_last4: String(last4 || '').replace(/\D/g, '').slice(-4),
        minimum: minimum / 100, dueDate: due.date, ...(closing !== null ? { closing: closing / 100 } : {}), ...(isDay(due.periodEnd) ? { statementEnd: due.periodEnd } : {}),
        statementKey: String(sourcePath), source: 'statement', createdAt: new Date(now).toISOString(), _ut: now,
    };
}

/** Add the record to the owner's list; the same statement's record is replaced (a better reading corrects it), never doubled. Returns the new list, or null when nothing changed. */
export function withCardDue(list, record) {
    if (!record) return null;
    const have = Array.isArray(list) ? list : [];
    const same = have.find(entry => entry && entry.id === record.id);
    if (same && same.minimum === record.minimum && same.dueDate === record.dueDate && same.closing === record.closing && same.statementEnd === record.statementEnd && same.card_last4 === record.card_last4 && same.bank === record.bank) return null;
    if (same && same.paidManually) return null;                       // the owner has already marked it paid: a re-read never reopens it
    return [...have.filter(entry => !entry || entry.id !== record.id), same ? { ...record, createdAt: same.createdAt || record.createdAt } : record];
}
