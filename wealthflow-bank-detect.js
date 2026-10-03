/* =============================================================================
 * wealthflow-bank-detect.js — which bank issued this statement? Read from the statement, never asked
 * -----------------------------------------------------------------------------
 * THE PROMPT THIS REPLACES. Before a manual upload was read, a screen said "Which credit card / bank? Before AI scans the statement, please
 * confirm the issuing bank" and listed fifteen names. The statement says whose it is, and so do the owner's own cards and the mail the email
 * sync already filed; asking was the owner doing a machine's job — and doing it unreliably: a wrong tap filed a year of spending under the wrong
 * bank, and the picker's names did not match the labels the email sync writes, so a card was split in two and a statement slipped past the
 * "already added" lock.
 *
 * HOW IT DECIDES. Evidence, summed per issuer, each source counted once, every one of them able to be named on screen:
 *
 *   the statement's own words   its first lines (7) or its first screen (5), a legal-entity form such as "<bank> PLC" (+4), and a few mentions
 *                               further down (+1 each, at most 2); a line that lists several banks is a place to pay, not an issuer. A transaction row is NEVER read as evidence: its narration names other
 *                               banks ("CEFT Transfer HNB") and a bank's own name is rarely in its own narration.
 *   an AI reading               of a scanned page (6): the bank as printed, or nothing — it is told to leave the field empty rather than guess.
 *   the PDF's properties        title / author / subject (4).
 *   the file name               "DFCC Bank Statement - Aug 26.pdf" (3).
 *   the same file               already in the mailbox under a bank (12): the exact bytes are the strongest fact there is.
 *   the card or account tail    the last four digits the statement prints, found in the owner's own cards (4) or in the statements the email
 *                               sync already filed (3, or 5 for three or more): the books know which bank ••0276 is.
 *   the same file-name series   as statements already filed by email (3).
 *
 * THE BAR. A bank is named only when its total reaches 6 AND it leads the runner-up by 3. Anything less is "not identified", and the answer
 * is NEVER to guess a bank and NEVER to ask: the statement is read, filed without a bank label and checked against the books by amount and
 * date, which is how every record before the owner's first pick was filed. A wrong label is worse than none.
 *
 * ONE LABEL FOR ONE CARD. Two names come back, because two different things need them:
 *   feeKey     the key of the fee schedule the picker's name opens ('Other' when the schedule cannot be named).
 *   name       what the records carry. If the owner's books (or the mail the email sync filed) already call this card something, that exact
 *              string is reused, so a statement arriving by hand and by email groups as ONE card and its rows are recognised as the same rows
 *              (the duplicate check compares bank labels). Otherwise the picker's name, which keys the Sri Lanka fee schedule
 *              (CC_CASH_ADVANCE_FEES) — for NTB, AMEX or Visa/Mastercard by the card number's first digits, the statement's words or the books.
 *   lockName   what the statement registry locks on. It is the ISSUER's label — the one the email worker writes — so a statement taken by hand
 *              and the same statement taken by email lock on the same id (statement-coverage.mjs bankIdentity). Never the record label.
 *
 * ALWAYS CORRECTABLE. Reading is automatic, but the owner has the last word. `choose()` turns a bank the owner picked or typed on the review screen into the same answer
 * `detect()` gives (record label, issuer label for the lock, fee key), so a correction files, locks and prices exactly like an automatic one. `taught` lets the next
 * statement of that card or account be named from what the owner said (6 points: the owner's word about their own account number), and a statement that nearly names a bank
 * says which one it came closest to (`suggest`) so the owner confirms with one tap instead of searching a list.
 *
 * Pure: no network, no clock, no DOM, no storage. test/bank_detect_test.js exercises it directly.
 * ===========================================================================*/

import { INSTITUTIONS, institutionFor } from './wealthflow-institutions.js';

const str = (v) => String(v == null ? '' : v);
const norm = (v) => str(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const padded = (v) => ' ' + norm(v) + ' ';

const MONEY = /\d{1,3}(?:,\d{3})+\.\d{2}(?!\d)|\d+\.\d{2}(?!\d)/;
const DATE = /\d{1,2}[/\-.](?:\d{1,2}|[a-z]{3})[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;

/* THE BAR. */
export const NAMED_AT = 6;
export const LEAD_BY = 3;

/* Issuers: the institutions registry with the two NTB entries folded into one issuer (they share a mailbox and a statement; only the card differs). */
const GROUPS = (() => {
    const by = new Map();
    for (const inst of INSTITUTIONS) {
        const key = inst.mailName ? 'ntb' : inst.id;
        const g = by.get(key) || { key, issuer: inst.mailName || inst.name, members: [], words: [] };
        g.members.push(inst);
        for (const t of inst.tokens) { const w = norm(t); if (w && !g.words.includes(w)) g.words.push(w); }
        by.set(key, g);
    }
    return [...by.values()];
})();

const groupOfInstitution = (inst) => (inst ? GROUPS.find((g) => g.members.includes(inst)) || null : null);
const mentions = (g, text) => { const h = padded(text); return g.words.some((w) => h.includes(' ' + w + ' ')); };

/* A mail domain gives its bank as one run of letters ("Nationstrust", "Dfccbank"): the institution whose name or token is those letters with the spaces taken out. The same rule the registry
 * lock applies (statement-coverage.mjs bankIdentity), so a label the email sync wrote groups with its bank here exactly as it locks with it there. */
const squash = (v) => str(v).toLowerCase().replace(/[^a-z0-9]+/g, '');
function runTogether(label) {
    const run = squash(label).replace(/bank$/, '');
    return run.length >= 5 ? INSTITUTIONS.find((i) => [i.name, ...i.tokens].some((t) => { const w = squash(t).replace(/bank$/, ''); return w.length >= 5 && w === run; })) || null : null;
}

/** The issuer a bank label belongs to: a known institution, else a label of the owner's own (an address they approved, a card they filed). */
function groupOfLabel(label, extra) {
    const clean = str(label).trim();
    if (!clean) return null;
    const known = groupOfInstitution(institutionFor(clean)) || GROUPS.find((g) => mentions(g, clean))
        || groupOfInstitution(institutionFor(clean.replace(/\s*bank$/i, ''))) || groupOfInstitution(runTogether(clean));
    if (known) return known;
    const key = 'x:' + norm(clean);
    let g = extra.get(key);
    if (!g) {
        const full = norm(clean), bare = full.replace(/ bank$/, '');
        g = { key, issuer: clean, members: [], words: bare.length >= 6 && bare !== full ? [full, bare] : [full], custom: true };
        extra.set(key, g);
    }
    return g;
}

/* ── the statement's text ─────────────────────────────────────────────────── */

/** A statement drawn from <div>s and read back with textContent has its neighbouring cells glued together ("Account StatementSampath Bank PLCCard No: …"). Break the glue at a
 *  lower→Upper or ACRONYMWord seam — never at a digit: a card mask such as "376657XXXXX0276" must stay whole. */
const unglue = (v) => v.replace(/([a-z])([A-Z])|([A-Z])([A-Z][a-z])/g, (m, a, b, c, d) => (a ? a + ' ' + b : c + ' ' + d));
const ROW_SPAN = new RegExp('(?:' + DATE.source + ').{0,140}?(?:' + MONEY.source + ')', 'gi');

/** Lines that are not transaction rows. A row (a date and an amount together) carries somebody else's narration, so it is never evidence of the issuer. */
function proseOf(text) {
    const raw = str(text).slice(0, 400000);
    const lines = raw.split(/\r?\n/);
    const out = [];
    const take = (line) => {
        const clean = line.replace(/\s+/g, ' ').trim();
        if (!clean || (DATE.test(clean) && MONEY.test(clean))) return;
        out.push(clean.slice(0, 600));
    };
    for (const line of lines) {
        const flat = unglue(line).replace(/\s+/g, ' ').trim();
        if (flat.length > 300 || (lines.length < 4 && flat.length > 200)) {
            /* One run of text with the rows inside it. Cut out each "date … amount" stretch (a row), then read what is left in overlapping windows of about a line, so the first
             * window is still the top of the page and a name is never lost to a cut. */
            const rest = flat.replace(ROW_SPAN, ' ');
            for (let at = 0; at < rest.length && out.length < 2500; at += 100) take(rest.slice(at, at + 140));
        } else take(flat);
        if (out.length >= 2500) break;
    }
    return out;
}

/* Phrases that contain a bank's words without naming that bank: every Sri Lankan bank's footer calls itself "a licensed commercial bank". */
const GENERIC_PHRASES = /\b(?:licen[sc]ed|registered|other|any|local|all)\s+commercial\s+banks?\b/gi;

/**
 * One entry per line: which issuers it names, and whether it is a LIST of banks ("pay at BOC, Commercial Bank, Sampath …") — a line that names two or
 * more banks says where to pay, not whose statement this is, so it counts as a passing mention only. American Express beside a bank is its card, not a second bank.
 */
function readLines(prose, issuers) {
    return prose.map((line) => {
        const h = padded(line.replace(GENERIC_PHRASES, ' ')), hits = new Map();
        for (const g of issuers) { const w = g.words.find((x) => h.includes(' ' + x + ' ')); if (w) hits.set(g.key, w); }
        return { h, hits, list: [...hits.keys()].filter((k) => k !== 'amex').length >= 2 };
    });
}

/** What the statement's words say about one issuer: its first lines (7) or first screen (5), a legal-entity form anywhere (+4), a couple of mentions further down (+1 each, at most 2). */
function wordsAbout(g, lines) {
    let top = false, head = false, legal = false, body = 0;
    lines.forEach((ln, i) => {
        const hit = ln.hits.get(g.key);
        if (!hit) return;
        if (ln.list) { body += 1; return; }
        if (i < 12) top = true; else if (i < 40) head = true; else body += 1;
        if (!legal && new RegExp(' ' + hit + ' (?:[a-z]+ ){0,2}(?:plc|ltd|limited|pcl|corporation) ').test(ln.h)) legal = true;
    });
    return (top ? 7 : head ? 5 : 0) + (legal ? 4 : 0) + Math.min(body, 2);
}

/* ── the card or account number ───────────────────────────────────────────── */

/** The network a card number's first digits name: 34/37 American Express, 4 Visa, 51–55 and 2221–2720 Mastercard. '' when they name none. */
export function networkOfBin(bin) {
    const d = str(bin).replace(/\D/g, '');
    if (/^3[47]/.test(d)) return 'amex';
    if (/^4/.test(d)) return 'visa-mc';
    if (/^5[1-5]/.test(d) || (d.length >= 4 && Number(d.slice(0, 4)) >= 2221 && Number(d.slice(0, 4)) <= 2720)) return 'visa-mc';
    return '';
}

/**
 * The card / account tails a statement prints, strongest first: a masked card number ("376657*****0276", "4111 11XX XXXX 1234" — its first digits name the
 * network), a labelled account number, a bare mask ("XXXX1234"). A bare four-digit number is never read as one: a statement is full of years and amounts.
 * @returns {Array<{tail:string, kind:'card'|'labelled'|'masked', network:string}>}
 */
export function tailsOf(text, filename = '') {
    const prose = Array.isArray(text) ? text : proseOf(text);
    const found = new Map();
    const note = (tail, kind, bin = '') => {
        if (!/^\d{4}$/.test(tail)) return;
        const prev = found.get(tail), network = networkOfBin(bin);
        if (!prev) found.set(tail, { tail, kind, network });
        else if (!prev.network && network) prev.network = network;
    };
    const scan = (line) => {
        for (const m of line.matchAll(/(\d{6,8})[xX*•·#]{2,}(\d{4})(?!\d)/g)) note(m[2], 'card', m[1]);
        for (const m of line.matchAll(/\b(\d{4}[ -]?\d{2,4})[ -]?[xX*•·#]{2,4}[ -]?[xX*•·#]{2,4}[ -]?(\d{4})(?!\d)/g)) note(m[2], 'card', m[1]);
        for (const m of line.matchAll(/(?:a\/c|acct|account|card)\s*(?:no|number|num|#)?\.?\s*[:.-]?\s*([\dxX*•\- ]{6,40}\d{4})(?!\d)/gi)) note(m[1].replace(/\D+/g, '').slice(-4), 'labelled');
        for (const m of line.matchAll(/(?:[*xX•·#]\s*){2,}[-\s]*(\d{4})\b/g)) note(m[1], 'masked');
    };
    scan(str(filename));
    prose.slice(0, 120).forEach(scan);
    return [...found.values()].slice(0, 4);
}

/* ── the answer ───────────────────────────────────────────────────────────── */

const SAYS = { doc: 'the statement names it', ai: 'an AI reading of the page', meta: "the PDF's own properties", file: 'the file name', sha: 'the same file already in your mailbox', last4: 'the card number in your email history', series: 'the same file-name series in your email history', books: 'the card number in your own cards', taught: 'you set the bank for this card or account before' };

/** The NTB product a bank label names ('' when it names none) — "Nations Trust Bank (NTB) — AMEX" is the AMEX card, the bare mail name is neither. */
const productOfLabel = (label) => { const n = norm(label); return /amex|american express/.test(n) ? 'amex' : /visa|master/.test(n) ? 'visa-mc' : ''; };

/**
 * What a bank is called on a record, and which fee schedule it opens — one place, so a bank the page named and a bank the owner chose are labelled identically.
 *   name    the owner's existing label for this card (books, taught, mailbox) when it is the same issuer, else the picker name (or the owner's own words for a bank outside the fifteen).
 *   feeKey  the key of the Sri Lanka fee schedule: only a bank the picker knew — and for NTB only once the card's product is known — names one; anything else is "Other".
 */
function labelling(g, product, ctx) {
    const { mine = [], taught = [], tailSet = [], hist = {}, extra } = ctx;
    const kin = (o) => o === g || (g.key === 'ntb' && product === 'amex' && o.key === 'amex') || (g.key === 'amex' && o.key === 'ntb');
    const seen = [];
    for (const a of mine.slice().sort((x, y) => (Number(y.seen) || 0) - (Number(x.seen) || 0))) seen.push(a.bank);
    for (const a of taught) if (a && a.bank && tailSet.includes(String(a.last4))) seen.push(a.bank);
    for (const tail of tailSet) for (const [label] of Object.entries((hist.last4 || {})[tail] || {}).sort((x, y) => y[1] - x[1])) seen.push(label);
    if (hist.sha && hist.sha.bank) seen.push(hist.sha.bank);
    if (hist.series && hist.series.bank) seen.push(hist.series.bank);
    for (const label of hist.approved || []) seen.push(label);
    const used = seen.find((label) => { const o = groupOfLabel(label, extra), p = productOfLabel(label); return o && kin(o) && !(g.key === 'ntb' && product && p && p !== product); });
    const picker = g.custom ? g.issuer
        : g.key === 'ntb' ? (product === 'amex' ? g.members[0].name : product === 'visa-mc' ? g.members[1].name : g.issuer)
            : g.members[0].name;
    return { name: str(used).trim() || picker, picker, feeKey: g.custom || (g.key === 'ntb' && !product) ? 'Other' : picker };
}

/** WHICH NTB CARD. The fee schedule differs (AMEX: 5% + LKR 1,250; Visa/Mastercard: 4%, min LKR 600), so the product is read from the first digits of the card number,
 *  then the statement's own words, then the owner's cards — and left out (the issuer's own label, which is what the email sync writes) when none of them says. */
function productOf(g, { tails = [], lines = [], ai = null, mine = [] }) {
    if (g.key !== 'ntb') return { product: '', basis: '' };
    const votes = { amex: 0, 'visa-mc': 0 };
    for (const t of tails) if (t.network) votes[t.network] += 8;
    const h = lines.map((ln) => ln.h).join(' ');
    if (/ (?:american express|amex) /.test(h)) votes.amex += 3;
    if (/ (?:visa|master ?card) /.test(h)) votes['visa-mc'] += 3;
    if (ai && ai.network) { const n = norm(ai.network); if (/amex|american/.test(n)) votes.amex += 4; else if (/visa|master/.test(n)) votes['visa-mc'] += 4; }
    for (const a of mine) { const p = productOfLabel(a.bank); if (p) votes[p] += 6; }
    const [best, other] = votes.amex >= votes['visa-mc'] ? ['amex', 'visa-mc'] : ['visa-mc', 'amex'];
    return votes[best] >= 4 && votes[best] - votes[other] >= 3 ? { product: best, basis: tails.some((t) => t.network === best) ? 'the card number' : 'the statement' } : { product: '', basis: '' };
}

/**
 * @param {{ text?:string, filename?:string, meta?:object|null, ai?:{bank?:string,network?:string}|null,
 *           books?:Array<{bank:string,last4:string,seen?:number}>,
 *           taught?:Array<{bank:string,last4:string}>,
 *           history?:{ approved?:string[], sha?:{bank:string}|null, last4?:Object<string,Object<string,number>>, series?:{bank:string,count?:number}|null }|null }} input
 *   `books` is wealthflow-accounts.js derive(); `history` is what /api/statement-guard `identify` answers from the mailbox; `taught` is what the owner themselves said on the review screen
 *   about a card or account number before (wealthflow-ai-v4.js WFBankMemory).
 * @returns {{ ok:boolean, name:string, lockName:string, feeKey:string, issuer:string, product:''|'amex'|'visa-mc', confidence:'certain'|'strong'|'none', basis:string[], tail:string,
 *             tails:Array<{tail:string,kind:string,network:string}>, ranked:Array<{issuer:string,total:number}>, suggest:Array<object>, why:string[], note:string }}
 *   `suggest` (only when not identified): up to two banks that came closest, each shaped like a successful answer, for the owner to confirm with one tap — never filed on their own.
 */
export function detect(input) {
    const { text = '', filename = '', meta = null, ai = null, books = [], taught = [], history = null } = input && typeof input === 'object' ? input : {};
    const extra = new Map();
    const prose = proseOf(text), tails = tailsOf(prose, filename);
    const hist = history && typeof history === 'object' ? history : {};
    const told = (Array.isArray(taught) ? taught : []).filter((a) => a && str(a.bank).trim() && /^\d{4}$/.test(str(a.last4)));
    const groups = new Map(GROUPS.map((g) => [g.key, { g, ev: {}, total: 0 }]));
    const slot = (g) => { if (!groups.has(g.key)) groups.set(g.key, { g, ev: {}, total: 0 }); return groups.get(g.key); };
    const give = (g, kind, points) => { if (g && points) { const s = slot(g); s.ev[kind] = Math.max(s.ev[kind] || 0, points); } };

    /* The owner's own labels become candidates too: an approved sender or a filed card that is not one of the fifteen is still a bank, and the email sync labels its statements with exactly that name. */
    const labels = [...(Array.isArray(hist.approved) ? hist.approved : [])];
    if (hist.sha && hist.sha.bank) labels.push(hist.sha.bank);
    if (hist.series && hist.series.bank) labels.push(hist.series.bank);
    for (const byLabel of Object.values(hist.last4 || {})) labels.push(...Object.keys(byLabel || {}));
    for (const a of Array.isArray(books) ? books : []) labels.push(a && a.bank);
    for (const a of told) labels.push(a.bank);
    for (const label of labels) groupOfLabel(label, extra);
    for (const g of extra.values()) slot(g);

    const lines = readLines(prose, [...groups.values()].map((s) => s.g));
    for (const { g } of [...groups.values()]) {
        give(g, 'doc', wordsAbout(g, lines));
        if (filename && mentions(g, filename)) give(g, 'file', 3);
        if (meta && typeof meta === 'object' && mentions(g, ['title', 'author', 'subject', 'keywords'].map((k) => str(meta[k])).join(' '))) give(g, 'meta', 4);
        if (ai && ai.bank && mentions(g, ai.bank)) give(g, 'ai', 6);
    }
    if (hist.sha && hist.sha.bank) give(groupOfLabel(hist.sha.bank, extra), 'sha', 12);
    if (hist.series && hist.series.bank) give(groupOfLabel(hist.series.bank, extra), 'series', 3);
    const tailSet = tails.map((t) => t.tail);
    for (const tail of tailSet) {
        for (const [label, count] of Object.entries((hist.last4 || {})[tail] || {})) give(groupOfLabel(label, extra), 'last4', Number(count) >= 3 ? 5 : 3);
    }
    const mine = (Array.isArray(books) ? books : []).filter((a) => a && a.bank && tailSet.includes(String(a.last4)));
    const kindOf = new Map(tails.map((t) => [t.tail, t.kind]));
    const ownCard = new Set();           // issuers of a card number printed on this statement that the owner has filed three times or more
    for (const a of mine) {
        const g = groupOfLabel(a.bank, extra);
        give(g, 'books', 4);
        if (kindOf.get(String(a.last4)) === 'card' && Number(a.seen) >= 3) ownCard.add(g.key);
    }
    /* THE OWNER'S OWN WORD. A card or account number printed on this statement that the owner earlier said belongs to a bank (a correction on the review screen) names that bank by itself:
     * 6 points, so it never stands against a statement that names another bank (that one scores 7 or more from its own header) — a disagreement is a conflict, and a conflict is "not identified". */
    for (const a of told) if (tailSet.includes(String(a.last4))) give(groupOfLabel(a.bank, extra), 'taught', NAMED_AT);

    /* AMERICAN EXPRESS IS A NETWORK WHEN A BANK ISSUES IT. A Nations Trust statement prints "American Express" on its card: that is the product, not the issuer. */
    const ntb = groups.get('ntb'), amex = groups.get('amex');
    const amexIsNetwork = !!(ntb && amex && Object.values(ntb.ev).reduce((a, b) => a + b, 0) >= 5 && Object.keys(amex.ev).length);
    if (amexIsNetwork) amex.ev = {};

    const ranked = [...groups.values()].map((s) => ({ ...s, total: Object.values(s.ev).reduce((a, b) => a + b, 0) })).filter((s) => s.total > 0).sort((a, b) => b.total - a.total);
    /* An approved sender settles a tie it cannot make: +1, only to a candidate that already has evidence of its own. */
    const approved = (Array.isArray(hist.approved) ? hist.approved : []).map((n) => groupOfLabel(n, extra)).filter(Boolean);
    for (const s of ranked) if (approved.includes(s.g) && s.total >= 3) s.total += 1;
    ranked.sort((a, b) => b.total - a.total);
    /* THE OWNER'S OWN CARD. A card number printed on this statement, in full form, that the owner has already filed three times or more is a fact about THEM: it names the bank even when
     * the statement prints no bank name at all (a logo, a scan read as text). It never stands against a statement that does name another bank (that one scores 3 or more from its own words). */
    if (ranked[0] && ranked[0].total < NAMED_AT && ranked[0].ev.books && ownCard.has(ranked[0].g.key) && !(ranked[1] && ranked[1].total >= 3)) ranked[0].total = NAMED_AT;

    const ctx = { mine, taught: told, tailSet, hist, extra };
    const tailsOut = tails.map((t) => ({ tail: t.tail, kind: t.kind, network: t.network }));
    const answer = (s, ok) => {
        const kinds = Object.keys(s.ev).filter((k) => s.ev[k] > 0);
        const { product, basis: productBasis } = productOf(s.g, { tails, lines, ai, mine });
        const { name, feeKey } = labelling(s.g, product, ctx);
        const basis = kinds.map((k) => SAYS[k]).filter(Boolean);
        if (product && productBasis) basis.push(`${productBasis} says ${product === 'amex' ? 'American Express' : 'Visa/Mastercard'}`);
        return { ok, name, lockName: s.g.issuer, feeKey, issuer: s.g.issuer, product, confidence: s.total >= 10 || (kinds.length >= 2 && s.total >= 8) ? 'certain' : 'strong', basis, points: s.total };
    };

    const win = ranked[0], second = ranked[1];
    const rankedOut = ranked.slice(0, 4).map((s) => ({ issuer: s.g.issuer, total: s.total }));
    if (!win || win.total < NAMED_AT || (second && win.total - second.total < LEAD_BY)) {
        /* NOT NAMED — and says why, and who came closest. A candidate with some real evidence (3 points: a header mention, the file name and a footer, a card seen twice) is offered for one-tap
         * confirmation; it is never filed under without the owner's tap. A close contest offers both. */
        const suggest = ranked.filter((s) => s.total >= 3 && (!win || win.total - s.total < LEAD_BY + 3)).slice(0, 2).map((s) => ({ ...answer(s, false), ok: false }));
        const why = [];
        if (!ranked.some((s) => s.ev.doc)) why.push('The statement text does not name a bank (often it is only a logo picture).');
        else if (win && second && win.total >= NAMED_AT) why.push('Two banks are named about equally, so neither is taken.');
        else if (win) why.push(`The closest was ${win.g.issuer}, at ${win.total} of the ${NAMED_AT} points needed.`);
        if (!tailSet.length) why.push('No card or account number was found on it to look up.');
        else if (!mine.length && !told.length && !Object.keys(hist.last4 || {}).length) why.push(`Card or account ••${tailSet[0]} is not in your books or your email history.`);
        if (history === null) why.push('Your email history could not be checked.');
        return { ok: false, name: '', lockName: '', feeKey: '', issuer: '', product: '', confidence: 'none', basis: [], tail: tailSet[0] || '', tails: tailsOut, ranked: rankedOut, suggest, why,
            note: 'Bank not identified: nothing in the statement, your cards or your email history names it, so it was filed without a bank label.' };
    }

    const a = answer(win, true);
    return { ok: true, name: a.name, lockName: a.lockName, feeKey: a.feeKey, issuer: a.issuer, product: a.product, confidence: a.confidence, basis: a.basis, tail: tailSet[0] || '', tails: tailsOut, ranked: rankedOut, suggest: [], why: [],
        note: `Bank identified automatically: ${a.name} (${a.basis.join('; ')}).` };
}

/**
 * THE OWNER'S WORD. A bank the owner picked or typed on the review screen, turned into the same answer `detect()` gives, so a correction is labelled, locked and priced exactly like an
 * automatic one. A blank label clears the bank (the statement is filed without one, as an unidentified statement is). A name the fifteen know — however typed ("dfcc", "Sampath") — is that
 * institution; anything else is the owner's own bank, kept as typed (fee schedule "Other").
 * @param {string} label
 * @param {{ tails?:Array<{tail:string}|string>, filename?:string, books?:Array<object>, taught?:Array<object>, history?:object|null }} [ctx]  what `detect()` returned as `tails`, plus the same books / history it was given
 */
export function choose(label, ctx) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const tails = (Array.isArray(c.tails) ? c.tails : []).map((t) => (t && typeof t === 'object' ? t : { tail: str(t), kind: 'labelled', network: '' })).filter((t) => /^\d{4}$/.test(str(t.tail)));
    const tailSet = tails.map((t) => t.tail);
    const clean = str(label).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!clean) {
        return { ok: false, manual: true, cleared: true, name: '', lockName: '', feeKey: '', issuer: '', product: '', confidence: 'none', basis: [], tail: tailSet[0] || '', tails, ranked: [], suggest: [], why: [],
            note: 'No bank label: the owner chose to file this statement without one.' };
    }
    const extra = new Map();
    const hist = c.history && typeof c.history === 'object' ? c.history : {};
    const mine = (Array.isArray(c.books) ? c.books : []).filter((a) => a && a.bank && tailSet.includes(String(a.last4)));
    const told = (Array.isArray(c.taught) ? c.taught : []).filter((a) => a && str(a.bank).trim() && /^\d{4}$/.test(str(a.last4)));
    for (const a of mine) groupOfLabel(a.bank, extra);
    for (const a of told) groupOfLabel(a.bank, extra);
    const exact = INSTITUTIONS.find((i) => norm(i.name) === norm(clean));
    const g = (exact && groupOfInstitution(exact)) || groupOfLabel(clean, extra);
    /* The product an NTB choice names comes from the picker entry itself (AMEX / Visa/Mastercard), or from the words the owner typed. */
    const product = g.key === 'ntb' ? (exact ? (exact === g.members[0] ? 'amex' : 'visa-mc') : productOfLabel(clean)) : '';
    /* Labelled the way the owner's books already label this card, else the picker's name; a bank of the owner's own is kept in the owner's words. */
    const { name, feeKey } = labelling(g, product, { mine, taught: told, tailSet, hist, extra });
    return { ok: true, manual: true, name, lockName: g.issuer, feeKey, issuer: g.issuer, product, confidence: 'certain', basis: ['you chose it'], tail: tailSet[0] || '', tails, ranked: [], suggest: [], why: [],
        note: `Bank set by the owner: ${name}.` };
}

const API = { detect, choose, tailsOf, networkOfBin, NAMED_AT, LEAD_BY };

if (typeof window !== 'undefined') window.WFBankDetect = API;

export default API;
