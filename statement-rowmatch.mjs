/* =============================================================================
 * statement-rowmatch.mjs — which rows of a statement are ALREADY in the books, whichever door filed them
 * -----------------------------------------------------------------------------
 * Production, 2026-10-04 (the owner's screenshot of the Income tab, May 2026): "Inward Ceft Transfer Dividend Paymen" 50,000 twice, "Inward Ceft Transfer" 245,000 twice — one of each pair carrying
 * the email system's note ("Filed automatically; the AI could not pick a more specific category"), the other the owner's own upload. The same statement had come in by both doors and every row was
 * counted twice. The rule each door used to tell "this row is already there" was written for ONE door: the email system compared the card/account tail to the letter (a hand upload often has none), and the
 * review's own check compared the words to the letter (a reader and the bank's e-mail word a line differently) and dropped a row that merely repeated an earlier row of the SAME statement.
 *
 * What a row IS, to the books: its day, its amount to the cent and which way the money went. Words and the account tail are evidence, not identity: they may differ between two readings of one
 * statement (never between two rows of one reading). So:
 *
 *   - Rows are COUNTED, never just looked up. A statement that shows the same payment three times on one day shows three transactions; the books must hold three, not one and not six.
 *     "Same day, same amount" is how legitimate repeated payments look (two bus fares, three identical micro-credits), so a row is only called a copy when the books hold a copy of it that is NOT
 *     one of the statement's own other rows.
 *   - The books keep, for each day+amount, as many records as the most any ONE copy of the statement shows (a statement filed by two doors is two copies of one statement). Two doors that each
 *     filed it twice hold four records and the statement shows two: the books are right with two.
 *   - Two records are copies of one statement only when a source of records (an email item, an upload, an old hand-filed batch) and the statement overlap broadly (the same rule as the registry's
 *     `coverageOf`: most of the one is in the other), or when a single row's words are the same line. A coincidence of day and amount between two UNRELATED statements is not a copy.
 *   - A known account tail or bank that differs is never a copy. An unknown one (a hand upload that could not read it) is compatible, not a conflict.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

import { bankKeyOf } from './statement-coverage.mjs';

/** The lists of the owner's document a statement row can be filed in (a subscription's history, a loan's payments and a cheque are not rows of a statement's own money). */
export const BOOK_STORES = ['expenses', 'incomeRecv', 'cconetime', 'ccinstall', 'ccPayments'];
const CREDIT_STORES = new Set(['incomeRecv', 'ccPayments']);
export const familyOfStore = store => (CREDIT_STORES.has(store) ? 'credit' : 'debit');
/** A plan keeps its first day in `date` and the charge's own in `startDate`. */
const DAY_FIELD = { ccinstall: 'startDate' };

export const centsOf = value => { const n = Math.round(Math.abs(Number(value)) * 100); return Number.isFinite(n) && n > 0 ? n : 0; };
export const tailOf = value => { const digits = String(value || '').replace(/\D+/g, ''); return digits.length >= 4 ? digits.slice(-4) : ''; };
const wordsOf = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const familyOfDirection = direction => (direction === 'credit' ? 'credit' : direction === 'debit' ? 'debit' : '');

/**
 * Two lines that are the same transaction worded differently: the same words, one the other's beginning (a bank cuts a narration short: "Dividend Paymen"), or most of their words in common.
 * Never the same just because the amount is: two different payees of one day are two different lines.
 */
export function similarWords(a, b) {
    const x = wordsOf(a), y = wordsOf(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const cx = x.replace(/ /g, ''), cy = y.replace(/ /g, '');
    if (Math.min(cx.length, cy.length) >= 6 && (cx.includes(cy) || cy.includes(cx))) return true;
    const tx = new Set(x.split(' ').filter(word => word.length > 1)), ty = new Set(y.split(' ').filter(word => word.length > 1));
    if (!tx.size || !ty.size) return false;
    let common = 0; for (const word of tx) if (ty.has(word)) common += 1;
    return common / (tx.size + ty.size - common) >= 0.5;
}

/**
 * WHERE A RECORD OF THE BOOKS CAME FROM, when it came from a statement: the email item (`statementKey`: its path, or a mailbox item's id), an upload (`uploadClaim`), an older hand-filed batch (`_batch`),
 * or a hand-filed row of before either was written down. '' for what the owner typed or any other record.
 */
export function sourceOf(record) {
    if (!record || typeof record !== 'object') return '';
    if (record.statementKey) return `k:${record.statementKey}`;
    if (record.uploadClaim) return `u:${record.uploadClaim}`;
    if (record._batch) return `b:${record._batch}`;
    if (record.source === 'statement' || (record.feeMeta && record.feeMeta.source === 'statement')) return 'h:hand';
    return '';
}
/** The email system's own statements (their records have a ledger). */
export const isWorkerSource = source => /^k:wf-mail\//.test(String(source || ''));

/** Every record of the books that came from a statement, as the facts a match needs. */
export function recordsOf(user) {
    const found = [];
    for (const store of BOOK_STORES) {
        for (const record of Array.isArray(user && user[store]) ? user[store] : []) {
            if (!record || typeof record !== 'object' || record.loanLink || record.subscriptionLink) continue;
            const source = sourceOf(record), cents = centsOf(record.amount);
            const date = String((DAY_FIELD[store] && record[DAY_FIELD[store]]) || record.date || '').slice(0, 10);
            if (!source || !cents || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            found.push({ store, record, id: String(record.id || ''), family: familyOfStore(store), date, cents, bank: record.bank ? bankKeyOf(record.bank) : '', last4: tailOf(record.card_last4),
                words: record.desc || record.name || record.description || '', source, created: Date.parse(record.createdAt) || 0 });
        }
    }
    return found;
}

const multiset = keys => { const counts = new Map(); for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1); return counts; };
/** How many day+amount keys two collections share, each used once (a multiset intersection). */
export function overlapOf(aKeys, bKeys) {
    const a = multiset(aKeys), b = multiset(bKeys); let overlap = 0;
    for (const [key, count] of a) overlap += Math.min(count, b.get(key) || 0);
    return overlap;
}
/** Is a source of records (or a statement) the same statement as another? Most of the smaller one is in the other; a lone row only when its words are the same line (`lone`). */
export const broadlySame = (overlap, smaller, lone = false) => (overlap >= 2 ? overlap >= 0.6 * smaller : overlap === 1 && smaller === 1 && lone);

const compatible = (r, bank, last4) => (!bank || !r.bank || r.bank === bank) && (!last4 || !r.last4 || r.last4 === last4);

/**
 * WHICH ROWS OF THIS STATEMENT THE BOOKS ALREADY HOLD, counted. `rows`: [{date, amount, direction?, description?, last4?}] in the statement's order. `selfSource`: the records of the statement being
 * filed itself (its own earlier rows are not copies of its later ones). A row is returned in `have` when the books hold a copy of it filed from ANOTHER source that is the same statement (broad overlap)
 * or the same line (similar words), within the account and bank the rows name; each such record covers one row.
 * Per day+amount the books are counted by the copy that holds the most of them (see the header): a second copy that holds the same rows adds nothing.
 * @returns {{have: {index:number, id:string, store:string, source:string}[]}} indices into `rows`
 */
export function matchStatementRows({ user, rows, bank = '', last4 = '', selfSource = '' }) {
    const out = { have: [] };
    const bankKey = bank ? bankKeyOf(bank) : '', tail = tailOf(last4);
    const mine = [];
    (Array.isArray(rows) ? rows : []).forEach((row, index) => {
        const cents = centsOf(row && row.amount), date = String((row && row.date) || '').slice(0, 10);
        if (cents && /^\d{4}-\d{2}-\d{2}$/.test(date)) mine.push({ index, key: `${date}|${cents}`, family: familyOfDirection(row.direction), words: row.description || row.narration || row.desc || '', last4: tailOf(row.last4 || row.card_last4) });
    });
    if (!mine.length) return out;
    const books = recordsOf(user).filter(r => r.source !== selfSource && compatible(r, bankKey, tail));
    if (!books.length) return out;
    const byKey = new Map(), bySource = new Map();
    for (const r of books) {
        const key = `${r.date}|${r.cents}`;
        if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(r);
        if (!bySource.has(r.source)) bySource.set(r.source, []); bySource.get(r.source).push(r);
    }
    /* A source is the same statement when most of the smaller of the two is in the other. */
    const mineKeys = mine.map(row => row.key), same = new Map();
    for (const [source, list] of bySource) same.set(source, broadlySame(overlapOf(list.map(r => `${r.date}|${r.cents}`), mineKeys), Math.min(list.length, mine.length)));
    /* the rows of one day+amount (and one direction), in the statement's order */
    const groups = new Map();
    for (const row of mine) { const id = `${row.key}|${row.family}`; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(row); }
    for (const rowsOfGroup of groups.values()) {
        const family = rowsOfGroup[0].family, key = rowsOfGroup[0].key;
        const perSource = new Map();
        for (const candidate of byKey.get(key) || []) {
            if (family && candidate.family !== family) continue;
            if (candidate.last4 && rowsOfGroup.every(row => row.last4 && row.last4 !== candidate.last4)) continue;
            if (!(same.get(candidate.source) || rowsOfGroup.some(row => similarWords(row.words, candidate.words)))) continue;
            if (!perSource.has(candidate.source)) perSource.set(candidate.source, []);
            perSource.get(candidate.source).push(candidate);
        }
        let best = null;
        for (const [source, list] of perSource) if (!best || list.length > best.list.length) best = { source, list };
        if (!best) continue;
        best.list.sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
        rowsOfGroup.slice(0, best.list.length).forEach((row, at) => out.have.push({ index: row.index, id: best.list[at].id, store: best.list[at].store, source: best.source }));
    }
    out.have.sort((a, b) => a.index - b.index);
    return out;
}

export default { BOOK_STORES, familyOfStore, centsOf, tailOf, similarWords, sourceOf, isWorkerSource, recordsOf, overlapOf, broadlySame, matchStatementRows };
