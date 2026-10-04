/* =============================================================================
 * statement-history.mjs — what the owner has already decided, remembered
 * -----------------------------------------------------------------------------
 * The rules know a few hundred merchants by name; everything else was "Other" and was put to a board of AI models that must all agree, which for an unknown merchant they rarely do. The
 * owner, meanwhile, has already told the system where "KEELLS SUPER MIRIGAMA" or "DIALOG AXIATA" goes — every time they filed one by hand, corrected a category, or confirmed a review. A
 * merchant the books already hold under ONE category, repeatedly, is that category: the owner's own past decisions are the strongest evidence there is, and they cost nothing to ask.
 *
 * The memory is built from the owner's expense and income records (never from a transaction's amount), keyed by the merchant name merchantNameFor() takes out of a bank narration, and
 * answers only when it is sure: at least two filings, and one category for at least four in five of them. "Other" and "Needs Review" are never learned. It never overrides a rule that
 * already named a category, a transfer, a card line or an allocation — except for a statement row the owner opened and corrected themselves (below): that is their answer, and it comes first.
 *
 * "Groceries" (a statement row, filed before the names were aligned) and "Food & Groceries" (a row the owner typed) are ONE category: the memory counts them together, in the classifier's word
 * (classifierName), and the ledger files the dropdown's (expenseEntryName).
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

import { classifierName } from './wealthflow-statement-router.js';

const EMPTY = new Set(['', 'other', 'needs review', 'uncategorized', 'uncategorised', 'misc', 'miscellaneous', 'unknown', 'transfer', 'duplicate']);
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

function tally(map, key, category, nameOf = (name) => name) {
    if (!key || EMPTY.has(lower(category))) return;
    const entry = map.get(key) || new Map();
    category = nameOf(category);
    entry.set(category, (entry.get(category) || 0) + 1);
    map.set(key, entry);
}

function verdict(entry, { minCount = 2, share = 0.8 } = {}) {
    if (!entry) return null;
    let total = 0, best = null, bestCount = 0;
    for (const [category, count] of entry) { total += count; if (count > bestCount) { best = category; bestCount = count; } }
    return total >= minCount && bestCount / total >= share ? { category: best, count: bestCount, of: total } : null;
}

/* A RECORD THE OWNER CORRECTED. The Expenses editor rebuilds a record from its form, which drops the statement's provenance (statementKey, statementRow, bank): a record still marked source "statement"
 * but without its statement is a statement row the owner opened and saved — their own answer to "what is this?", given about the system's. One such correction settles the merchant, even over a category
 * the rules named ("never correct the same merchant twice"); a typed entry (source "manual") or a row nobody touched does not have that weight. */
const isCorrection = (record) => !!record && record.source === 'statement' && !record.statementKey && !record.uploadClaim;

/**
 * @param {object} user         the owner's document ({expenses, incomeRecv})
 * @param {(row:object)=>string} keyOf   the merchant key of a narration (statement-sync's merchantNameFor)
 * @returns {{expense:(row:object)=>({category:string,count:number,of:number}|null), income:(row:object)=>({category:string,count:number,of:number}|null), hint:(row:object)=>(object|null), size:number}}
 */
export function buildHistory(user, keyOf) {
    const expenses = new Map(), income = new Map(), corrected = new Map();
    for (const record of Array.isArray(user && user.expenses) ? user.expenses : []) {
        if (!record || !record.desc) continue;
        tally(expenses, keyOf({ narration: record.desc }), record.cat || record.category, classifierName);
        if (isCorrection(record)) tally(corrected, keyOf({ narration: record.desc }), record.cat || record.category, classifierName);
    }
    for (const record of Array.isArray(user && user.incomeRecv) ? user.incomeRecv : []) if (record && record.name) tally(income, keyOf({ narration: record.name }), record.type || record.category);
    const minKey = (key) => key.length >= 4;
    return {
        expense: (row) => {
            const key = keyOf(row);
            if (!key || !minKey(key)) return null;
            const fixed = verdict(corrected.get(key), { minCount: 1 });
            return fixed ? { ...fixed, corrected: true } : verdict(expenses.get(key));
        },
        income: (row) => { const key = keyOf(row); return key && minKey(key) ? verdict(income.get(key)) : null; },
        // weaker than a verdict, still evidence: the AI is told what the owner has used for this merchant, so its answer and the owner's habit are not strangers
        hint: (row) => { const key = keyOf(row); const entry = key && minKey(key) ? (expenses.get(key) || income.get(key)) : null; return verdict(entry, { minCount: 1, share: 0.5 }); },
        size: expenses.size + income.size,
    };
}

export default { buildHistory };
