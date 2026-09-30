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
export { filenameStem };

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const NAME_RE = new RegExp(`(20\\d{2})[-_ .]?(${MONTHS.join('|')})|(${MONTHS.join('|')})[-_ .]?(20\\d{2})`, 'i');
const NUM_RE = /(20\d{2})[-_ .]?(0[1-9]|1[0-2])(?!\d)/;
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
    if (Number.isFinite(at) && at > 0) { const t = new Date(at); return ym(t.getUTCFullYear(), t.getUTCMonth() + 1); }
    return '';
}

/**
 * One statement product, whichever month it is: the bank plus the file name with
 * the month and every run of digits taken out. "Consolidated_eStatement_2026JAN_
 * 458290.html" and "…2026MAR_458290.html" are one series; an American Express
 * card statement is another, even from the same mailbox.
 */
export function seriesOf(item) {
    return `${String(item?.bank || '').trim().toLowerCase()}|${filenameStem(item?.filename)}`;
}

const stateOf = item => {
    const status = String(item?.status || '');
    if (item?.emptyStatement === true) return 'empty';
    if (item?.filed === true || status === 'filed') return 'filed';
    if (status === 'needs_review') return 'review';
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
        const state = stateOf(item), added = ['audit', 'gap', 'owner', 'series'].includes(String(item.via || ''));
        let status, math;
        if (state === 'filed' || state === 'empty') {
            status = added ? 'Missing-Added' : 'Synced';
            math = item.proof?.math === 'passed' ? 'PASSED' : item.proof?.math === 'owner-confirmed' ? 'OWNER-CONFIRMED' : state === 'empty' ? 'PASSED' : 'NOT-RECORDED';
        } else if (state === 'review') {
            status = 'Needs-Review';
            math = /reconcil|balance|chain|proof/i.test(String(item.reviewReason || '')) ? 'FAILED' : 'NOT-CHECKED';
        } else if (state === 'pending') {
            status = Number(item.retryCount) > 0 ? 'Failed-Queued' : 'Queued';
            math = 'NOT-CHECKED';
        } else { status = state === 'dismissed' ? 'Dismissed' : 'Rejected'; math = 'NOT-CHECKED'; }
        const at = Number(item.storedMs) || Number(item.receivedMs) || 0;
        out.push({ id: String(item.id || '').slice(0, 120), at, bank: String(item.bank || ''), file: String(item.filename).slice(0, 100), month: monthOf(item), status, math,
            via: String(item.via || ''), sha: String(item.contentSha256 || '').slice(0, 12), last4: String(item.proof?.last4 || ''), closing: Number.isFinite(Number(item.proof?.closing)) && item.proof?.closing !== null && item.proof?.closing !== undefined ? Number(item.proof.closing) : null });
    }
    out.sort((a, b) => (b.month || '').localeCompare(a.month || '') || b.at - a.at);
    return out.slice(0, limit);
}

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
