/* =============================================================================
 * statement-cheque-backfill.mjs — the cheques that statements filed BEFORE the Cheque Tracker could read them
 * -----------------------------------------------------------------------------
 * Until 2026-10-14 (PR #423) a cheque row on a bank statement was filed as an ordinary expense or income and never reached the Cheque Tracker; until 2026-10-21 a row the bank printed as "CLEARING 000123" lost its
 * number on the way and was not read as a cheque at all. Those rows are in the books already (counted once, as an expense or as income) — what is missing is the cheque itself in the Cheque tab.
 *
 * A statement is not read again for this: the record the statement filed carries its narration, its day, its money, the statement it came from and the way the money went (an expense is money out, an income
 * row money in). That is everything wealthflow-cheques.js needs, so the cheque is settled from the record, with the one reader and the one decision every door uses:
 *   an issued cheque the bank paid       the tracker gets it (added cleared, or the tracked pending one is cleared) and is tied to the expense that already counts the money (`countedBy`), so the month counts it once
 *   a cheque the owner deposited         the tracker gets it cleared; the income row stays the income
 *   a deposited cheque the bank returned the tracker gets it bounced; the expense that took the money back stays
 * An issued cheque the bank sent back (a credit filed as income before) is left alone: what that credit should have been is for the owner to judge, not a guess.
 *
 * Which records: those a statement filed BEFORE the reader was cheque-aware (createdAt before CHEQUE_AWARE_FROM, the day #423 reached production), and — for later ones — only a row whose words the first reader could
 * not have read: the cheque word run into its neighbour ("CHQPAID"), in Sinhala, or the clearing word ("CLEARING 000123"). A later row that says "cheque" in plain words was settled when it was filed (the
 * cheque it touched carries the statement's key), and one cheque holds only the LAST row of a statement that settled it more than once — so reading it again would undo what the later row did.
 * Rows are taken in the order the bank printed them (day, then place in the statement), so a deposit and its return end in the right state.
 *
 * Nothing the owner typed is touched (only records a statement filed), nothing is deleted, and a record is looked at once: it is stamped (`chequeBackfill`) with the cheque it became, so a cheque the owner
 * deletes afterwards is not made again. Unfiling the statement takes the cheque away with it (the cheque carries the statement's key, as it does when a statement files it itself).
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

import { readCheque, settleCheque } from './wealthflow-cheques.js';

/** The day the Cheque Tracker started reading statement rows in production (PR #423, 2026-10-14). */
export const CHEQUE_AWARE_FROM = '2026-10-14T00:00:00.000Z';
const PLAIN_CHEQUE_WORD = /\b(?:cheques?|chques?|cheqs?|chqs?|chk|check|cq|pdc)\b|\b(?:cheques?|chques?|cheqs?|chqs?|chk|check|cq|pdc)\d/i;
const STORES = [['expenses', 'debit', 'desc'], ['incomeRecv', 'credit', 'name']];

const eligible = (record, description) => {
    if (!record || record.source !== 'statement' || !record.statementKey || record.chequeBackfill || !record.id) return false;
    const filed = String(record.createdAt || '');
    // filed before the reader knew cheques (a record with no time is an old one), or worded in a way the first reader could not read
    return !filed || filed < CHEQUE_AWARE_FROM || !PLAIN_CHEQUE_WORD.test(description);
};

/** What the books would look like with the missing cheques added. `user` is changed in place (give it a copy); `changed` says which lists to write. */
export function planChequeBackfill(user, { now = Date.now(), limit = 60 } = {}) {
    const out = { changed: {}, created: 0, cleared: 0, bounced: 0, skipped: 0, more: false };
    if (!user || typeof user !== 'object') return out;
    if (user.cheques != null && !Array.isArray(user.cheques)) return out;
    const cheques = Array.isArray(user.cheques) ? user.cheques : [];
    const iso = new Date(now).toISOString();
    const items = [];
    for (const [store, direction, field] of STORES) {
        if (!Array.isArray(user[store])) continue;
        for (const record of user[store]) {
            const description = record ? String(record[field] || record.desc || record.name || '') : '';
            if (!description || !eligible(record, description)) continue;
            const amount = Math.abs(Number(record.amount));
            const date = String(record.date || '').slice(0, 10);
            if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            const read = readCheque({ description, direction, amount });
            if (!read.isCheque || read.fee || !read.type || read.needsReview) continue;
            // a credit that brought an ISSUED cheque's money back was filed as income before; nothing here can say what it offsets
            if (read.type === 'issued' && read.event === 'return') { out.skipped++; continue; }
            items.push({ store, direction, record, description, amount, date, read });
        }
    }
    items.sort((a, b) => a.date.localeCompare(b.date) || String(a.record.statementKey).localeCompare(String(b.record.statementKey)) || (Number(a.record.statementRow) || 0) - (Number(b.record.statementRow) || 0));
    let work = 0;
    for (const { store, direction, record, description, amount, date, read } of items) {
        // the statement (or this very row) already put the cheque in the tracker
        if (cheques.some((c) => c && (c.backfilledFrom === record.id || (c.statementKey === record.statementKey && record.statementRow != null && Number(c.statementRow) === Number(record.statementRow))))) continue;
        if (work >= limit) { out.more = true; break; }
        const rowNo = record.statementRow == null || record.statementRow === '' ? null : Number(record.statementRow);
        const where = Number.isFinite(rowNo) ? rowNo : null;
        const plan = settleCheque({ description, direction, amount, date, bank: record.bank || '', key: record.statementKey, rowNo: where },
            cheques, { id: 'chq-bf-' + String(record.id), now: iso, source: { statementKey: record.statementKey, statementRow: where, bank: record.bank || '' } });
        if (!plan.isCheque || plan.ambiguous) { out.skipped++; continue; }
        // the money is in the books already, in this record: an issued cheque is tied to it so the month does not count the payment twice
        const carries = read.type === 'issued' ? { countedBy: String(record.id) } : {};
        let touched = null;
        if (plan.action === 'create' && plan.record) {
            touched = { ...plan.record, ...carries, backfilledFrom: String(record.id), source: 'statement', _ut: now };
            cheques.push(touched); out.created++;
        } else if ((plan.action === 'clear' || plan.action === 'bounce') && plan.cheque && plan.patch) {
            // a tracked pending cheque the statement settled long ago: it is settled now, and an issued one stops being counted by itself when an expense already counts it
            touched = Object.assign(plan.cheque, plan.patch, plan.action === 'clear' && !plan.cheque.countedBy ? carries : {}, { _ut: now });
            if (plan.action === 'bounce') out.bounced++; else out.cleared++;
        } else if (plan.action === 'already' && plan.cheque && plan.cheque.id) {
            // another reading of the statement (or the owner's own upload) already settled it: this record is that cheque's money, looked at once
            touched = plan.cheque;
        } else continue;
        record.chequeBackfill = { id: String(touched.id), at: now };
        record._ut = now;
        work++;
        out.changed[store] = true; out.changed.cheques = true;
    }
    if (out.changed.cheques) user.cheques = cheques;
    return out;
}
