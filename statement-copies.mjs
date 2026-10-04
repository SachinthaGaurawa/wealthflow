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
import { recordsOf, overlapOf, broadlySame, similarWords, isWorkerSource } from './statement-rowmatch.mjs';

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

/**
 * THE SAME STATEMENT FILED BY TWO DOORS (statement-rowmatch.mjs). Production, 2026-10-04: the email system and the owner's own upload each filed a statement's rows, and every row of it was in the books twice.
 * The matcher above never saw it: a hand upload has no `statementKey`, and its words and account tail differ from the email system's. Here a record's SOURCE is its email item, its upload or its hand-filed batch,
 * and two sources are one statement when they overlap broadly (most of the smaller is in the other). For each day+amount of such sources the books keep what the source holding the MOST of them holds — so a payment
 * that really happened twice on one day (two identical rows of one statement) stays twice — and the other sources' copies go. A record the owner has touched is never taken out (the group is left for them),
 * and an unclear account (two different known tails or banks among the records of one day+amount) is left alone. Of two sources holding as many, the one that knows its account (card tail) is kept, then the email system's:
 * its records carry the statement's key, which every other check of the books relies on.
 * @returns {{remove: {store:string, record:object, keep:object, source:string, keptSource:string}[], groups:number, left:number}}
 */
export function crossDoorCopies(user, { labelOf = () => '' } = {}) {
    const records = recordsOf(user).filter(r => r.store !== 'ccinstall');
    const bySource = new Map();
    for (const r of records) { if (!bySource.has(r.source)) bySource.set(r.source, []); bySource.get(r.source).push(r); }
    if (bySource.size < 2) return { remove: [], groups: 0, left: 0 };
    const keysOf = list => list.map(r => `${r.family}|${r.date}|${r.cents}`);   // evidence ignores WHICH list a door filed a row in (a card row hand-filed as an expense is still the same row)
    const evidence = new Map();
    const sameStatement = (a, b, lone) => {
        const id = a < b ? `${a}\n${b}` : `${b}\n${a}`;
        if (!evidence.has(id)) { const la = bySource.get(a), lb = bySource.get(b); evidence.set(id, { overlap: overlapOf(keysOf(la), keysOf(lb)), smaller: Math.min(la.length, lb.length) }); }
        const { overlap, smaller } = evidence.get(id);
        return broadlySame(overlap, smaller, lone);
    };
    const buckets = new Map();
    for (const r of records) { if (r.store === 'ccinstall') continue; const key = `${r.store}|${r.date}|${r.cents}`; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(r); }
    const remove = []; let found = 0, left = 0;
    for (const members of buckets.values()) {
        const sources = [...new Set(members.map(r => r.source))];
        if (sources.length < 2) continue;
        if (new Set(members.map(r => r.last4).filter(Boolean)).size > 1 || new Set(members.map(r => r.bank).filter(Boolean)).size > 1) continue;
        const parent = new Map(sources.map(source => [source, source]));
        const root = source => { while (parent.get(source) !== source) source = parent.get(source); return source; };
        for (let i = 0; i < sources.length; i += 1) for (let j = i + 1; j < sources.length; j += 1) {
            const a = members.filter(r => r.source === sources[i]), b = members.filter(r => r.source === sources[j]);
            if (sameStatement(sources[i], sources[j], a.length === 1 && b.length === 1 && similarWords(a[0].words, b[0].words))) parent.set(root(sources[i]), root(sources[j]));
        }
        const clusters = new Map();
        for (const source of sources) { const id = root(source); if (!clusters.has(id)) clusters.set(id, []); clusters.get(id).push(source); }
        for (const cluster of clusters.values()) {
            if (cluster.length < 2) continue;
            found += 1;
            const of = source => members.filter(r => r.source === source);
            const date = members[0].date.slice(0, 7);
            const rank = source => { const list = of(source); return [-list.length, list.some(r => touched(r.record)) ? 0 : 1, list.some(r => r.last4) ? 0 : 1, isWorkerSource(source) ? 0 : 1, labelOf(source.replace(/^k:/, '')) === date ? 0 : 1, Math.min(...list.map(r => r.created)), source]; };
            const ordered = [...cluster].sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
            const anchor = ordered[0], keep = of(anchor);
            for (const source of ordered.slice(1)) {
                const drop = of(source);
                if (drop.some(r => touched(r.record))) { left += 1; continue; }
                drop.forEach((r, at) => { const twin = keep.find(k => similarWords(k.words, r.words)) || keep[at % keep.length]; remove.push({ store: r.store, record: r.record, keep: twin.record, source, keptSource: anchor }); });
            }
        }
    }
    return { remove, groups: found, left };
}

export default { statementCopies, crossDoorCopies, touched };
