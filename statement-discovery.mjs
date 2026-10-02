/* =============================================================================
 * statement-discovery.mjs — find the owner's bank mail by what it SAYS, not only by who sent it
 * -----------------------------------------------------------------------------
 * The history audit asks Gmail for "every message with an attachment from the addresses and registered domains of the banks the owner approved".
 * Anything a bank sent from anywhere else is not in that list, however old and however plainly it says "statement". This adds independent ways of
 * asking, each one a Gmail query that does not depend on the sender:
 *
 *   keyword        an attachment, a statement word, and the NAME of a bank the owner approved
 *   learned-subject the subject lines of the statements already filed (digits and months taken out): the bank's own wording, from any address
 *   learned-file   the file names of the statements already filed, for the same reason
 *   file-says      an attachment whose file name says statement
 *
 * What these find is judged exactly like all other mail (statement-evidence.mjs): a message that is not a statement of one of the owner's banks is
 * dropped without a trace in the owner's lists — never held, never asked about — and counted in the log.
 *
 * Pure except `listDiscovery` / `discoveryCensus`, which take the fetch to use. No clock, no storage.
 * ===========================================================================*/

import { ownerBanks } from './statement-evidence.mjs';
import { authed } from './google-oauth.mjs';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const DISCOVERY_VERSION = 1;
export const DISCOVERY_EVERY_MS = 6 * 3600 * 1000;
export const DISCOVERY_MAX_IDS = 120;
const STATEMENT_TERMS = '(statement OR estatement OR "e-statement" OR "e statement" OR stmt OR estmt OR "account statement")';
const NOT_TRASH = ' -in:trash';
const lower = (v) => String(v == null ? '' : v).toLowerCase();
const quote = (w) => (/^[a-z0-9]+$/i.test(w) ? w : `"${String(w).replace(/"/g, '')}"`);

const FILLER = new Set(['your', 'for', 'the', 'of', 'a', 'an', 'to', 'from', 'is', 'are', 'and', 'this', 'month', 'monthly', 'dear', 'customer', 'please', 'find', 'attached', 'no', 'a/c', 'ac']);
const MONTH = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/;

/** The wording of a subject with everything that changes from month to month taken out: "Your HNB Account Statement for 074-02-… (Jan 2026)" -> "hnb account statement". */
export function subjectSkeleton(subject) {
    const words = lower(subject).replace(/[^a-z\s]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2 && !FILLER.has(w) && !MONTH.test(w) && !/^x+$/.test(w));
    return words.slice(0, 6).join(' ');
}

const GENERIC_FILE_WORDS = new Set(['pdf', 'html', 'htm', 'statement', 'statements', 'estatement', 'stmt', 'estmt', 'document', 'attachment', 'file']);
/** The alphabetic words in the file names of filed statements, most common first. */
export function fileWords(filenames) {
    const count = new Map();
    for (const name of filenames) for (const w of new Set(lower(name).replace(/\.[a-z0-9]{2,5}$/, '').split(/[^a-z]+/).filter((x) => x.length >= 5 && !GENERIC_FILE_WORDS.has(x) && !/^(.)\1+$/.test(x)))) count.set(w, (count.get(w) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([w]) => w);
}

/**
 * The Gmail queries, in the order they are tried. `items` are the stored statements (any with `filed`, `subject`, `filename`).
 * @returns {{method:string, q:string}[]}
 */
export function discoveryQueries({ list, items = [] } = {}) {
    const out = [];
    const banks = ownerBanks(list);
    const words = [...new Set(banks.flatMap((b) => b.words))].slice(0, 24);
    if (words.length) out.push({ method: 'keyword', q: `has:attachment ${STATEMENT_TERMS} (${words.map(quote).join(' OR ')})${NOT_TRASH}` });
    const filed = (Array.isArray(items) ? items : []).filter((i) => i && (i.filed === true || i.status === 'filed'));
    const skeletons = new Map();
    for (const i of filed) { const s = subjectSkeleton(i.subject); if (s.split(' ').length >= 2) skeletons.set(s, (skeletons.get(s) || 0) + 1); }
    for (const [s] of [...skeletons.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4)) out.push({ method: 'learned-subject', q: `has:attachment subject:(${quote(s)})${NOT_TRASH}` });
    const learned = fileWords(filed.map((i) => i.filename).filter(Boolean)).slice(0, 3);
    for (const w of learned) out.push({ method: 'learned-file', q: `has:attachment filename:${w}${NOT_TRASH}` });
    out.push({ method: 'file-says', q: `has:attachment filename:(statement OR estatement OR "e-statement" OR stmt OR estmt)${NOT_TRASH}` });
    return out;
}

/**
 * Walk every query for its message ids, bounded. Returns the union and, per method, what it listed — so the log can say which method found what.
 * A query that fails is skipped (the others still count) and reported as `failed`.
 */
export async function listDiscovery(token, f, queries, { pageSize = 100, maxPages = 3, budgetMs = 12000, now = Date.now } = {}) {
    const deadline = now() + budgetMs;
    const ids = new Set(), methods = {};
    for (const { method, q } of queries) {
        const entry = methods[method] = methods[method] || { queries: 0, listed: 0, failed: 0, complete: true };
        entry.queries += 1;
        let pageToken = '';
        for (let page = 0; page < maxPages; page += 1) {
            if (now() > deadline) { entry.complete = false; break; }
            let out;
            try {
                const r = await f(`${GMAIL}/messages?maxResults=${pageSize}&includeSpamTrash=true&q=${encodeURIComponent(q)}${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`, { headers: authed(token) });
                if (!r.ok) { entry.failed += 1; break; }
                out = await r.json();
            } catch (_) { entry.failed += 1; break; }
            for (const m of out.messages || []) if (m && m.id) { ids.add(String(m.id)); entry.listed += 1; }
            pageToken = out.nextPageToken;
            if (!pageToken) break;
            if (page === maxPages - 1) entry.complete = false;
        }
    }
    return { ids: [...ids], methods };
}

/**
 * How much bank mail the mailbox holds that the sender-keyed audit cannot count, by Gmail's own estimate (one cheap call each, no message read):
 * the same domains WITHOUT an attachment (a statement that is a link, not a file), and the keyword search's whole size.
 */
export async function discoveryCensus(token, f, { clauses = [], queries = [] } = {}) {
    const size = async (q) => {
        try {
            const r = await f(`${GMAIL}/messages?maxResults=1&includeSpamTrash=true&q=${encodeURIComponent(q)}`, { headers: authed(token) });
            return r.ok ? Number((await r.json()).resultSizeEstimate) || 0 : -1;
        } catch (_) { return -1; }
    };
    const out = {};
    if (clauses.length) {
        out.fromBanksWithFile = await size(`has:attachment {${clauses.join(' ')}}${NOT_TRASH}`);
        out.fromBanksNoFile = await size(`-has:attachment ${STATEMENT_TERMS} {${clauses.join(' ')}}${NOT_TRASH}`);
    }
    const keyword = queries.find((q) => q.method === 'keyword');
    if (keyword) out.keywordFile = await size(keyword.q);
    return out;
}

/** The kinds of file a message carries, by extension — to see a bank that mails csv/xlsx/zip statements the intake does not take. */
export function attachmentKinds(message) {
    const kinds = {};
    const visit = (p) => {
        if (!p) return;
        if (Array.isArray(p.parts)) p.parts.forEach(visit);
        const name = lower(p.filename);
        if (!name) return;
        const ext = (/\.([a-z0-9]{1,5})$/.exec(name) || [])[1] || 'none';
        kinds[ext] = (kinds[ext] || 0) + 1;
    };
    visit(message && message.payload);
    return kinds;
}

/**
 * A running tally of what discovery judged, kept as small counts for ONE log line: no address, subject or file name. `domain` is the sender's domain and
 * `year` the year it arrived — which is what the owner's "years of statements" is made of.
 */
export function newTally() { return { judged: 0, taken: {}, dropped: {}, domains: {}, years: {}, kinds: {} }; }
export function tally(t, { plan, message, bank = '' }) {
    t.judged += 1;
    const domain = String(plan && plan.from || '').toLowerCase().replace(/^.*@/, '').replace(/[^a-z0-9.-]/g, '').slice(0, 40) || '?';
    const year = new Date(Number(message && message.internalDate) || 0).getUTCFullYear();
    if (plan && plan.ok) {
        const key = String(bank || plan.bank || '?').slice(0, 24);
        t.taken[key] = (t.taken[key] || 0) + 1;
        t.years[year] = (t.years[year] || 0) + 1;
        const d = t.domains[domain] = t.domains[domain] || { taken: 0, dropped: 0 };
        d.taken += 1;
    } else {
        const why = String((plan && ((plan.evidence && plan.evidence.why) || plan.reason)) || '?').replace(/\d{4,}/g, '#').slice(0, 60);
        t.dropped[why] = (t.dropped[why] || 0) + 1;
        const d = t.domains[domain] = t.domains[domain] || { taken: 0, dropped: 0 };
        d.dropped += 1;
        if (plan && plan.reason === 'no-pdf-attachment') for (const [ext, n] of Object.entries(attachmentKinds(message))) t.kinds[ext] = (t.kinds[ext] || 0) + n;
    }
    return t;
}
/** The tally as the log line carries it: the busiest domains only. */
export function tallyLine(t, extra = {}) {
    const top = Object.entries(t.domains).sort((a, b) => (b[1].taken - a[1].taken) || (b[1].dropped - a[1].dropped)).slice(0, 10);
    return { evt: 'mail-discovery', judged: t.judged, taken: t.taken, dropped: t.dropped, years: t.years, kinds: t.kinds, domains: Object.fromEntries(top), ...extra };
}

export default { DISCOVERY_VERSION, discoveryQueries, listDiscovery, discoveryCensus, subjectSkeleton, fileWords, attachmentKinds, newTally, tally, tallyLine };
