/* =============================================================================
 * statement-transfers.mjs — a transfer is the owner's own money moving, or somebody else's money moving
 * -----------------------------------------------------------------------------
 * Every row that said "transfer" (an outward or inward CEFT, a mobile-banking transfer) was left out of the books as "a transfer between your own accounts". Most are not: "Outward Ceft
 * Transfer Car / Chagiya / Sister / Title", "Inward Ceft Transfer Dip Refund / Loan / Order" are money paid to, and received from, other people and businesses — spending and income — and
 * a DFCC statement that is half of those showed the owner a month with half of it missing. Only the owner's OWN money moving between the owner's OWN accounts is left out (else it would
 * be counted twice, once leaving one account and once arriving in the other).
 *
 * A transfer is the owner's own when something on the page says so, and the rule needs no one's answer:
 *   the account number   the narration names one of the owner's own accounts or cards by its masked number ("376657XXXXX0276": the card the owner holds),
 *   the words            "my DFCC", "own account", "self transfer", a transfer to a savings or current account of the owner,
 *   the other leg        the same amount leaving one of the owner's accounts and arriving in another on the same statement, within three days.
 * Anything else is money to, or from, someone else.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

import { transferEvidence } from './statement-ledger.mjs';

const textOf = row => String((row && (row.narration || row.description || row.desc || row.name)) || '');
const cents = value => Math.round(Math.abs(Number(value)) * 100);
const lastFour = value => String(value == null ? '' : value).replace(/\D/g, '').slice(-4);

/* A masked account or card number: "376657XXXXX0276", "XXXX0276", "****0276", "xxxxxxxx0276". Only the masked shape counts — a bare four digits is an amount or a reference. */
const MASKED_TAIL = /(?:[x*•#]{2,}|\d{4,6}[x*•#]{2,})[\s-]?(\d{4})(?!\d)/gi;
const OWN_WORDS = new RegExp([
    String.raw`\b(?:own|self|my)\s+(?:a\/?c|acc(?:ount)?)\b`,
    String.raw`\bmy\s+(?:dfcc|hnb|ntb|nations|amex|sampath|commercial|combank|boc|peoples|seylan|ndb|pan\s*asia|union|hsbc|cargills)\b`,
    String.raw`\b(?:self|own)\s+transfer\b`,
    String.raw`\btransfer\s+(?:to|from)\s+(?:my\s+|own\s+)?(?:savings?|current|fixed\s+deposit|fd)\b`,
    String.raw`\b(?:savings?|current)\s+(?:a\/?c|account)\s+(?:transfer|to|from)\b`,
].join('|'), 'i');

/** The four-digit tails of masked numbers a narration carries: "…0276 50,000.00" -> ['0276']. */
export const tailsIn = text => [...String(text || '').matchAll(MASKED_TAIL)].map(match => match[1]);

/**
 * The owner's own account and card tails: the cards they track, the accounts their statements are for, the one this statement is for.
 * @returns {Set<string>} four-digit strings
 */
export function ownTails({ cardRegistry = {}, cards = [], statementTails = [], thisTail = '' } = {}) {
    const out = new Set();
    const add = value => { const tail = lastFour(value); if (tail.length === 4 && /^\d{4}$/.test(tail) && tail !== '0000') out.add(tail); };
    for (const key of Object.keys(cardRegistry && typeof cardRegistry === 'object' ? cardRegistry : {})) add(key);
    for (const card of Array.isArray(cards) ? cards : []) add(card && (card.card_last4 || card.last4));
    for (const tail of Array.isArray(statementTails) ? statementTails : []) add(tail);
    add(thisTail);
    return out;
}

/**
 * What says this transfer row is the owner's own money moving between the owner's own accounts, or '' when nothing does.
 * @param {object} row
 * @param {{tails?: Set<string>|string[], paired?: {has:(row:object)=>boolean}}} own
 */
export function ownTransferEvidence(row, own = {}) {
    if (!transferEvidence(row)) return '';
    const text = textOf(row), tails = own.tails instanceof Set ? own.tails : new Set(Array.isArray(own.tails) ? own.tails : []);
    if (tailsIn(text).some(tail => tails.has(tail))) return 'own-account-number';
    if (OWN_WORDS.test(text)) return 'own-account-words';
    if (own.paired && typeof own.paired.has === 'function' && own.paired.has(row)) return 'other-leg-on-the-statement';
    return '';
}

const dayOf = date => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };

/**
 * The rows of one statement that are the two legs of one transfer between two of the owner's accounts: a debit and a credit of the same amount, within three days, in two DIFFERENT accounts
 * of a consolidated statement (the rows say which), at least one of them worded as a transfer. Each row belongs to at most one pair, the nearest by date.
 * @returns {WeakSet<object>} the row objects that are a leg of a pair
 */
export function pairedTransfers(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const taken = new Set(), out = new WeakSet();
    const accountOf = row => lastFour(row && (row.card_last4 || row._ccLast4 || row.account_last4));
    list.forEach((row, i) => {
        if (!row || taken.has(i) || row.valid === false || row.direction !== 'debit' || !(Number(row.amount) > 0) || !accountOf(row)) return;
        let best = -1, bestGap = Infinity;
        list.forEach((other, j) => {
            if (j === i || taken.has(j) || !other || other.valid === false || other.direction !== 'credit' || cents(other.amount) !== cents(row.amount) || !accountOf(other) || accountOf(other) === accountOf(row)) return;
            if (!transferEvidence(row) && !transferEvidence(other)) return;
            const gap = Math.abs(dayOf(row.date) - dayOf(other.date));
            if (gap <= 3 && gap < bestGap) { best = j; bestGap = gap; }
        });
        if (best >= 0) { taken.add(i); taken.add(best); out.add(row); out.add(list[best]); }
    });
    return out;
}

/**
 * WHAT THE BOOKS HOLD TWICE, in counts only (no amount, no description): rows that two statements both filed (the same transaction under two copies of one statement, or two bank labels), and
 * a debit and a credit of the same amount within three days in two different statements, one of them worded as a transfer (the two legs of the owner's own transfer, both counted). It is what
 * tells a double count from a coincidence, in the log, without anyone being asked.
 * @returns {{records:number, sameRow:{groups:number, banks:Object<string,number>}, legs:{pairs:number, banks:Object<string,number>}}}
 */
export function recordTwins(user) {
    const keys = ['expenses', 'incomeRecv', 'cconetime', 'ccPayments'];
    const list = keys.flatMap(key => (Array.isArray(user && user[key]) ? user[key] : []).filter(rec => rec && rec.statementKey && Number(rec.amount) > 0).map(rec => ({ rec, direction: rec.direction || (key === 'incomeRecv' || key === 'ccPayments' ? 'credit' : 'debit') })));
    const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };
    const norm = text => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const seen = new Map();
    for (const { rec, direction } of list) {
        const key = [rec.date, cents(rec.amount), direction, norm(rec.desc || rec.name)].join('|');
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key).push(rec);
    }
    const sameRow = { groups: 0, banks: {} };
    for (const group of seen.values()) {
        const sources = new Set(group.map(rec => rec.statementKey));
        if (sources.size < 2) continue;
        sameRow.groups += 1;
        bump(sameRow.banks, [...new Set(group.map(rec => String(rec.bank || '?').slice(0, 20)))].sort().join('/'));
    }
    const legs = { pairs: 0, banks: {} }, used = new Set();
    const debits = list.filter(item => item.direction === 'debit'), credits = list.filter(item => item.direction === 'credit');
    for (const out of debits) {
        const hit = credits.find(into => !used.has(into.rec) && cents(into.rec.amount) === cents(out.rec.amount) && into.rec.statementKey !== out.rec.statementKey
            && Math.abs(dayOf(into.rec.date) - dayOf(out.rec.date)) <= 3 && (transferEvidence({ description: out.rec.desc }) || transferEvidence({ description: into.rec.name })));
        if (!hit) continue;
        used.add(hit.rec); legs.pairs += 1;
        bump(legs.banks, `${String(out.rec.bank || '?').slice(0, 20)}>${String(hit.rec.bank || '?').slice(0, 20)}`);
    }
    return { records: list.length, sameRow, legs };
}

export default { tailsIn, ownTails, ownTransferEvidence, pairedTransfers, recordTwins };
