// Which months of which statement is the mailbox missing?
//
// Statements are monthly. Once a bank has sent January and March, "February is
// not here" is a fact worth knowing — whatever the reason (a sender the owner has
// not approved, a refusal, a message Gmail never delivered, a bank that skipped a
// month). Nothing else in the pipeline can see it, because each message is judged
// on its own; only the SET of statements shows a hole.
//
// Pure and injectable: this file reads no database and no mailbox. It is given
// what is already stored and answers with the months that are present, in what
// state, and which are missing — and, separately, builds the Gmail search that
// looks for the missing ones.

import { filenameStem } from './wealthflow-mail-ingest.mjs';
import { institutionFor } from './wealthflow-institutions.js';
export { filenameStem };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const NAME_RE = new RegExp(`(20\\d{2})[-_ .]?(${MONTHS.join('|')})|(${MONTHS.join('|')})[-_ .]?(20\\d{2})`, 'i');
const NUM_RE = /(20\d{2})[-_ .]?(0[1-9]|1[0-2])(?!\d)/;
/* "DFCC Bank Statement - Aug 26.pdf": a month word and two digits. The bank means August 2026 (it names its files by month and two-digit year); the same shape could be read as the 26th of August. */
const SHORT_RE = new RegExp(`(?<![A-Za-z])(${MONTHS.join('|')})[A-Za-z]{0,6}[-_ .]*(\\d{2})(?!\\d)`, 'i');
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const addMonths = (key, n) => { const [y, m] = key.split('-').map(Number); const t = y * 12 + (m - 1) + n; return ym(Math.floor(t / 12), (t % 12) + 1); };
const monthEnd = key => { const [y, m] = key.split('-').map(Number); return Date.UTC(y, m, 1) - 1; };

/** The month a statement is FOR, as "YYYY-MM": from its file name, else the month it arrived. */
export function monthOf(item) {
    const name = String(item?.filename || '');
    const n = NAME_RE.exec(name);
    if (n) return ym(Number(n[1] || n[4]), MONTHS.indexOf(String(n[2] || n[3]).toUpperCase()) + 1);
    const d = NUM_RE.exec(name);
    if (d) return ym(Number(d[1]), Number(d[2]));
    const at = Number(item?.receivedMs);
    const received = Number.isFinite(at) && at > 0 ? new Date(at) : null;
    /* A statement is dated no later than the day it arrived. "Aug 26" that arrived on 4 September is August 2026 either way it is read (the month of 2026, or the 26th of August), where the month it ARRIVED
     * said September: the owner looked for August and it was filed under the month after. Year first (a bank's own file names), the day only when the year would be a statement from the future. */
    const s = received && SHORT_RE.exec(name);
    if (s) {
        const month = MONTHS.indexOf(s[1].toUpperCase()) + 1, number = Number(s[2]), arrived = received.getUTCFullYear() * 12 + received.getUTCMonth();
        const asYear = (2000 + number) * 12 + (month - 1);
        if (number >= 20 && asYear <= arrived && asYear >= arrived - 60) return ym(2000 + number, month);
        if (number >= 1 && number <= 31) return ym(received.getUTCFullYear() - (month > received.getUTCMonth() + 1 ? 1 : 0), month);
    }
    if (received) return ym(received.getUTCFullYear(), received.getUTCMonth() + 1);
    return '';
}

/** One bank however its mail was labelled: "DFCC Bank" the owner wrote and "Dfccbank" a mail domain gave are one bank, "HNB" and "Hnb" too. `name` is what to call it. */
export function bankIdentity(name) {
    const raw = String(name || '').trim();
    const known = institutionFor(raw) || institutionFor(raw.replace(/\s*bank$/i, ''));
    return known ? { key: known.id, name: known.name } : { key: raw.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/bank$/, ''), name: raw };
}
export const bankKeyOf = name => bankIdentity(name).key;

/* The statement's file name with the month and every run of digits taken out; a month word left beside the digits ("dfcc_bank_statement_aug_#") would make every month its own series. */
const coverageStem = filename => filenameStem(filename).replace(new RegExp(`_(?:${MONTHS.join('|').toLowerCase()})_(?=#)`, 'g'), '_');

/**
 * One statement product, whichever month it is: the bank plus the file name with
 * the month and every run of digits taken out. "Consolidated_eStatement_2026JAN_
 * 458290.html" and "…2026MAR_458290.html" are one series; an American Express
 * card statement is another, even from the same mailbox. The bank is one bank
 * however its mail was labelled (bankKeyOf), so a statement that came under two
 * labels is not two products with a hole in each.
 */
export function seriesOf(item) {
    return `${bankKeyOf(item?.bank)}|${coverageStem(item?.filename)}`;
}

const stateOf = item => {
    const status = String(item?.status || '');
    if (item?.emptyStatement === true) return 'empty';
    if (item?.filed === true || status === 'filed') return 'filed';
    if (status === 'needs_review') return 'review';
    if (status === 'dead_letter') return 'pending';       // parked after repeated failures and re-driven on a schedule: still queued, never dropped
    if (status === 'pending' || status === 'processing') return 'pending';
    if (status === 'dismissed') return 'dismissed';
    if (status.startsWith('rejected')) return 'rejected';
    return status || 'pending';
};

// A month is DUE once it is over and the bank has had `graceDays` to send it.
const dueThrough = (now, graceDays) => { const t = new Date(now - graceDays * 86400000); let key = ym(t.getUTCFullYear(), t.getUTCMonth() + 1); if (monthEnd(key) + graceDays * 86400000 > now) key = addMonths(key, -1); return key; };

const BETTER = { filed: 6, empty: 5, review: 4, pending: 3, dismissed: 2, rejected: 1 };

/**
 * @param items  stored statements: { bank, filename, receivedMs, status, filed, from }
 * @returns {{ series: Array<{ key, bank, label, first, last, months: Object<string,string>, missing: string[] }>, missing: number }}
 */
export function coverageOf(items, { now = Date.now(), graceDays = 12, dormantMonths = 4 } = {}) {
    const groups = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        const month = monthOf(item);
        if (!month || !item?.filename) continue;
        const key = seriesOf(item);
        if (!groups.has(key)) groups.set(key, { key, bank: String(item.bank || ''), label: String(item.filename).replace(NAME_RE, '').replace(/[\d_]+(?=\.)/g, '').replace(/\.(?:html?|pdf)$/i, '').replace(/[_\s]+$/g, '') || String(item.bank || ''), months: {}, froms: new Set() });
        const g = groups.get(key), state = stateOf(item);
        if (!g.months[month] || (BETTER[state] || 0) > (BETTER[g.months[month]] || 0)) g.months[month] = state;
        if (item.from) g.froms.add(String(item.from));
    }
    const due = dueThrough(now, graceDays);
    const series = [];
    let missingTotal = 0;
    for (const g of groups.values()) {
        const present = Object.keys(g.months).sort();
        const first = present[0], last = present.at(-1);
        // Trailing months count only for a series that is still arriving: one whose
        // newest statement is recent. A closed account is not a hole.
        const live = last >= addMonths(due, -dormantMonths);
        const through = live && due > last ? due : last;
        const missing = [];
        for (let m = first; m <= through; m = addMonths(m, 1)) if (!g.months[m]) missing.push(m);
        missingTotal += missing.length;
        series.push({ key: g.key, bank: g.bank, label: g.label, first, last, months: g.months, missing, froms: [...g.froms].slice(0, 4) });
    }
    series.sort((a, b) => a.label.localeCompare(b.label));
    return { series, missing: missingTotal };
}

/**
 * One line per statement saying what became of it — the per-statement audit trail.
 *
 * Synced         taken from the mailbox as it arrived and filed
 * Missing-Added  a statement the normal path had not delivered, found by the history
 *                audit, the month-gap search, a sibling address of the same bank, or
 *                the owner's tap — and then filed
 * Queued         taken, waiting its turn to be read
 * Failed-Queued  read at least once without success, waiting to try again
 * Needs-Review   read, and asking the owner about it
 *
 * `math` is what the statement proved about itself, recorded when it was filed:
 * PASSED (opening + credits − debits = closing, row by row), OWNER-CONFIRMED, FAILED
 * (it was read and did not reconcile), NOT-CHECKED (not read yet, or refused before
 * it could be) or NOT-RECORDED (filed before proofs were kept).
 */
export function auditLogOf(items, { limit = 60 } = {}) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
        if (!item?.filename) continue;
        const state = stateOf(item), added = ['audit', 'gap', 'owner', 'series', 'sibling'].includes(String(item.via || ''));
        let status, math;
        if (state === 'filed' || state === 'empty') {
            status = added ? 'Missing-Added' : 'Synced';
            math = item.proof?.math === 'passed' ? 'PASSED' : item.proof?.math === 'owner-confirmed' ? 'OWNER-CONFIRMED' : item.proof?.math === 'duplicate-of' ? 'DUPLICATE' : state === 'empty' ? 'PASSED' : 'NOT-RECORDED';
        } else if (state === 'review') {
            status = 'Needs-Review';
            math = /reconcil|balance|chain|proof/i.test(String(item.reviewReason || '')) ? 'FAILED' : 'NOT-CHECKED';
        } else if (state === 'pending') {
            status = Number(item.retryCount) > 0 ? 'Failed-Queued' : 'Queued';
            math = 'NOT-CHECKED';
        } else { status = state === 'dismissed' ? 'Dismissed' : 'Rejected'; math = 'NOT-CHECKED'; }
        const at = Number(item.storedMs) || Number(item.receivedMs) || 0;
        out.push({ id: String(item.id || '').slice(0, 120), at, bank: String(item.bank || ''), file: String(item.filename).slice(0, 100), month: monthOf(item), status, math, rows: Number.isSafeInteger(Number(item.proof?.rows ?? item.totalRows)) ? Math.max(0, Number(item.proof?.rows ?? item.totalRows)) : 0,
            via: String(item.via || ''), sha: String(item.contentSha256 || '').slice(0, 12), last4: String(item.proof?.last4 || ''), closing: Number.isFinite(Number(item.proof?.closing)) && item.proof?.closing !== null && item.proof?.closing !== undefined ? Number(item.proof.closing) : null });
    }
    out.sort((a, b) => (b.month || '').localeCompare(a.month || '') || b.at - a.at);
    return out.slice(0, limit);
}

/**
 * What the books hold, bank by bank and month by month — the thing the owner looks for ("where is August?") and the review list cannot show, because a statement that is filed is no longer waiting for anything.
 * Every statement of one bank is one line however its mail was labelled; each month says what became of its statement(s) and how many rows they brought in (a second copy of a statement adds none).
 * @returns {Array<{bank:string, months:Object<string,[string,number]>, earlier:number}>}  newest month first within a bank; banks in name order
 */
export function gridOf(items, { months = 18, banks = 12 } = {}) {
    const by = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        const month = monthOf(item);
        if (!month || !item?.filename) continue;
        const id = bankIdentity(item.bank), entry = by.get(id.key) || { bank: id.name, months: new Map() };
        by.set(id.key, entry);
        const state = stateOf(item), rows = item.duplicateOf || item.proof?.math === 'duplicate-of' ? 0 : Math.max(0, Number(item.proof?.rows ?? item.totalRows) || 0);
        const had = entry.months.get(month) || ['', 0];
        entry.months.set(month, [(BETTER[state] || 0) > (BETTER[had[0]] || 0) ? state : had[0], had[1] + (state === 'filed' ? rows : 0)]);
    }
    return [...by.values()].sort((a, b) => a.bank.localeCompare(b.bank)).slice(0, banks).map(entry => {
        const keys = [...entry.months.keys()].sort().reverse();
        return { bank: entry.bank, months: Object.fromEntries(keys.slice(0, months).map(k => [k, entry.months.get(k)])), earlier: Math.max(0, keys.length - months) };
    });
}

/** The grid as the lines the overlay shows, one per bank — formatted here so the browser carries a loop and nothing else: "DFCC Bank: 2026-08 filed (77 rows) · 2026-07 in review · 3 earlier". */
const STATE_WORDS = { filed: 'filed', empty: 'nothing moved', review: 'in review', pending: 'being read', dismissed: 'dismissed', rejected: 'not a statement' };
export const gridLines = grid => (Array.isArray(grid) ? grid : []).map(g => `${g.bank}: ` + Object.entries(g.months).map(([m, v]) => `${m} ${STATE_WORDS[v[0]] || v[0]}${v[1] ? ` (${v[1]} rows)` : ''}`).join(' · ') + (g.earlier ? ` · ${g.earlier} earlier` : ''));

const pad = n => String(n).padStart(2, '0');
const ymd = t => `${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}`;

/**
 * The Gmail search for one missing month of one series: everything the bank's
 * domain sent from the start of the month to three weeks after it (a statement
 * for the month is issued after it ends), with NO attachment or keyword filter —
 * the point is to see what arrived, including what was refused.
 */
export function gapQuery(month, domains) {
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1)), to = new Date(Date.UTC(y, m, 22));
    const clauses = [...new Set(domains.map(d => String(d || '').toLowerCase().replace(/^.*@/, '').replace(/[^a-z0-9.-]/g, '')).filter(Boolean))].map(d => `from:${d}`);
    if (!clauses.length) return '';
    return `after:${ymd(from)} before:${ymd(to)} {${clauses.join(' ')}}`;
}

/** The sending domains a series has come from, out of the From headers stored with it. */
export function domainsOf(froms) {
    const out = new Set();
    for (const from of froms || []) {
        const m = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(String(from).replace(/"(?:[^"\\]|\\.)*"/g, ' '));
        if (m) out.add(m[1].toLowerCase());
    }
    return [...out];
}

export const _internal = { addMonths, dueThrough };
