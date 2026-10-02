/* =============================================================================
 * statement-copies.mjs — the same transaction filed from two statements is one transaction
 * -----------------------------------------------------------------------------
 * Production, 2026-10-02 (`statement-twins`): 61 groups of transactions that two NTB statements both filed. Every group involved the one statement labelled March 2026 — it carried rows of
 * December, January and February as well (17, 9 and 12 of them), and 23 of March itself that another March statement also holds. A statement that covers several months, an overlapping one, a
 * second copy of the same one, or the same statement under another bank label all bring rows the books already hold from the statement of their own month: counted twice in income and in spending.
 *
 * Of the records that are the same transaction (the same account, date, amount to the cent, direction and words) the books keep as many as the most any ONE statement shows (two identical bus
 * fares on one day are two), and it keeps them from the statement of the record's own month first, then the one filed first. A record the owner has touched is never taken out: if a copy would
 * have to be, the group is left for them.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

import { bankKeyOf } from './statement-coverage.mjs';

const STORES = ['expenses', 'incomeRecv', 'cconetime', 'ccPayments'];
const norm = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cents = value => Math.round(Math.abs(Number(value)) * 100);
const createdOf = record => { const t = Date.parse(record && record.createdAt); return Number.isFinite(t) ? t : 0; };
/** Edited since it was filed: the sync stamps `_ut` on every change, and filing sets it to the moment of creation. */
export const touched = record => { const at = createdOf(record); return !!record && at > 0 && Number(record._ut) - at > 5000; };

/**
 * @param {object} user the owner's document
 * @param {{labelOf?: (statementKey:string)=>string}} options `labelOf` gives a statement's own month ("2026-03"), or '' when unknown
 * @returns {{remove: {store:string, record:object, keep:object}[], groups:number, left:number}} the records that are copies; `left`: groups left alone (a touched record, or nothing to prefer)
 */
export function statementCopies(user, { labelOf = () => '' } = {}) {
    const groups = new Map();
    for (const store of STORES) {
        for (const record of Array.isArray(user && user[store]) ? user[store] : []) {
            if (!record || record.source !== 'statement' || !record.statementKey || !(Number(record.amount) > 0) || record.loanLink || record.subscriptionLink) continue;
            const direction = record.direction || (store === 'incomeRecv' || store === 'ccPayments' ? 'credit' : 'debit');
            const key = [store, record.date, cents(record.amount), direction, norm(record.desc || record.name), String(record.card_last4 || ''), bankKeyOf(record.bank)].join('|');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ store, record });
        }
    }
    const remove = []; let found = 0, left = 0;
    for (const members of groups.values()) {
        const sources = new Map();
        for (const member of members) sources.set(member.record.statementKey, [...(sources.get(member.record.statementKey) || []), member]);
        if (sources.size < 2) continue;
        found += 1;
        const target = Math.max(...[...sources.values()].map(list => list.length));
        const date = String(members[0].record.date || '').slice(0, 7);
        const rank = member => [touched(member.record) ? 0 : 1, labelOf(member.record.statementKey) === date ? 0 : 1, createdOf(member.record), String(member.record.statementKey), Number(member.record.statementRow) || 0];
        const ordered = [...members].sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
        const keep = ordered.slice(0, target), drop = ordered.slice(target);
        if (drop.some(member => touched(member.record))) { left += 1; continue; }
        for (const member of drop) remove.push({ store: member.store, record: member.record, keep: keep[0].record });
    }
    return { remove, groups: found, left };
}

export default { statementCopies, touched };
