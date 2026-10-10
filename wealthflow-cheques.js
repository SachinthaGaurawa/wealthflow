/* =============================================================================
 * wealthflow-cheques.js — what a CHEQUE row on a bank statement is, and which tracked cheque it settles   (window.WFCheques)
 * -----------------------------------------------------------------------------
 * A statement line that says "CHEQUE DEPOSIT 285943" carries everything the Cheque Tracker needs: that it is a cheque, whether the money came IN (a deposit, a realisation) or went OUT (a
 * payment, an inward clearing), its number, and — when the bank sends it back — that it was RETURNED. Three places read such lines and each had its own idea of them:
 *
 *   the manual upload     wealthflow-route.js guessed the type from loose words and let the WORDING outrank the bank's own debit/credit flag ("OUTWARD CLEARING" credit became an ISSUED cheque),
 *                         knew nothing of returns or of "CHK" / "CQ" / "PDC", and then ignored any row whose number was already in the tracker — so a pending cheque stayed pending for ever;
 *   the email worker      had no cheque reading at all (statement-links.mjs matched a debit to a pending cheque by amount alone);
 *   the statement parser  deleted the number itself: it strips a leading/trailing reference like "CHQ000123"/"285943" from a narration, and a cheque number looks exactly like one.
 *
 * This file is the ONE answer all of them ask, so a row is not one thing on the page and another by email (test/cheques_test.js reads the same rows through every door).
 *
 *   readCheque(row)                       → is it a cheque, which way did the money go, what happened to it, and its number
 *   matchTracked(read, row, cheques)      → which tracked cheque this row settles (by number first, then amount + date), or none, or "ambiguous"
 *   settleCheque(row, cheques, options)   → the whole decision: clear / bounce / create / already-there, the patch or record to write, and which book carries the row's money
 *
 * The rule that keeps the books honest: a statement money row is counted EXACTLY ONCE.
 *   issued cheque, paid out      the cheque record carries it (Cheque Tracker, cleared → the month's expenses). No expense row is added.
 *   received cheque, deposited   the credit is INCOME (an income row); the received-cheque record is tracking only (the app never sums received cheques).
 *   deposited cheque RETURNED    the cash left the account again: an expense row for the debit, and the received cheque is marked bounced.
 *   issued cheque RETURNED       the cheque is marked bounced (a bounced cheque is not counted as paid); the credit that brings the money back is consumed by that.
 * So a wrong guess can only mislabel a row, never lose it or count it twice.
 *
 * The bank's debit/credit flag decides which way the money went; the wording decides only when the flag is missing (an SMS, a pasted line).
 * Pure: no network, no clock, no storage. ESM for the server; the page loads it as a module and reads window.WFCheques.
 * ===========================================================================*/

import { institutionFor, displayBank } from './wealthflow-institutions.js';

/* ---- words ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
const STRONG = new Set(['cheque', 'cheques', 'chque', 'chques', 'cheq', 'cheqs', 'chq', 'chqs', 'pdc']);
const WEAK = new Set(['check', 'chk', 'cq']);                  // "Check In Hotel": a weak marker is a cheque only with a number beside it
const NO_WORDS = new Set(['no', 'number', 'num', 'nr', 'nbr', '#']);
const CONNECT = new Set(['dep', 'deposit', 'deposited', 'dpst', 'depo', 'payment', 'pmt', 'pay', 'paid', 'clg', 'clearing', 'clear', 'credit', 'credited', 'debit', 'debited', 'collection',
    'lodgement', 'lodgment', 'lodged', 'realised', 'realized', 'realisation', 'realization', 'honoured', 'honored', 'presented', 'returned', 'return', 'rtn', 'retn', 'rtnd', 'dishonoured',
    'dishonored', 'issued', 'issue', 'inward', 'outward', 'withdrawal', 'encashed', 'encashment', 'transfer', 'cr', 'dr', 'local', 'self', 'cash', 'cleared']);
/* a number after one of these is something else: an account, a branch, a reference, a phone, a card, an invoice … */
const OTHER_LABEL = new Set(['ac', 'acc', 'acct', 'account', 'accno', 'acno', 'br', 'brn', 'brch', 'branch', 'ref', 'refno', 'reference', 'rrn', 'txn', 'trx', 'trace', 'seq', 'tel', 'mob', 'mobile',
    'phone', 'card', 'id', 'nic', 'inv', 'invoice', 'bill', 'po', 'order', 'batch', 'utr', 'ft', 'trn', 'slip', 'voucher', 'vch', 'receipt', 'rcpt', 'stan', 'auth', 'pos', 'tid', 'mid', 'cif', 'loan',
    'policy', 'lease', 'fd', 'member', 'cust', 'customer', 'ceft', 'sltb', 'rtgs', 'swift', 'iban', 'code', 'otp', 'tx', 'txid', 'unit', 'lot']);

const RETURN_RE = /\b(?:return(?:ed|s)?|rtn(?:d|ed)?|retn|ret'?d|dishonou?r(?:ed|s)?|dishon|bounc(?:e|ed|es|ing)|unpaid|refer(?:red)?\s+to\s+drawer|insufficient(?:\s+funds?)?|insuff|nsf|reversal|reversed|reverse|stale|payment\s+stopped)\b/;
/* what the words say about the direction — only used when the statement gives no debit/credit flag */
const RECEIVED_WORDS = /\b(?:deposit(?:ed|s)?|dep|dpst|depo|credit(?:ed)?|cr|receiv(?:e|ed|ing)|incoming|realis(?:e|ed|ation)|realiz(?:e|ed|ation)|lodg(?:e|ed|ement|ment)|collect(?:ion|ed)|outward|remit(?:tance)?)\b/;
const ISSUED_WORDS = /\b(?:payment|pmt|pay|paid|issu(?:e|ed)|withdraw(?:al|n)|withdrew|outgoing|present(?:ed|ation)|encash(?:ed|ment)?|honou?red|drawn|debit(?:ed)?|dr|inward|self)\b/;
/* a fee ABOUT a cheque is a bank charge, not a cheque moving */
const FEE_RE = /\b(?:fees?|charges?|chgs?|chrgs?|commission|levy|surcharge|penalty|stationery)\b/;
const BOOK_RE = /\b(?:cheques?|chques?|cheqs?|chqs?)\s*(?:book|books|leaf|leaves|leaflet|stationery|pad)\b|\b(?:book|leaf|leaves)\b.{0,20}\b(?:cheques?|chq)\b/;
const STOP_RE = /\bstop\s*(?:payment|pay|pmt)\b|\bstop\s+(?:cheques?|chq)\b/;
const STAMP_RE = /\bstamp\s+duty\b/;
const TITLE_BEFORE = /\b(?:mr|mrs|ms|miss|dr|prof|rev|hon|sir|madam)\s+(?:cheques?|chq)\b/;     // "Mr Cheque Perera" is a person

const AMOUNT_RE = /\b(?:lkr|rs\.?|usd|eur|gbp)\s*\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d{2}\b/gi;
const DATE_RE = /\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b|\b\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}\b|\b\d{1,2}[-\s](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s]\d{2,4}\b/gi;

const money = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
const same = (a, b) => Math.abs(money(a) - money(b)) < 0.01;
const asDate = (value) => { const ms = Date.parse(String(value || '').slice(0, 10) + 'T00:00:00Z'); return Number.isFinite(ms) ? ms : NaN; };
const gapDays = (a, b) => { const x = asDate(a), y = asDate(b); return Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) / 86400000 : NaN; };

/** A cheque number as digits, leading zeros kept ("000123"); '' when there are none. */
export const normNo = (value) => String(value == null ? '' : value).replace(/\D+/g, '');
/** Two cheque numbers name the same cheque when their digits are equal once leading zeros are set aside ("000123" = "123"). Never true for an empty number or a lone zero. */
export function sameNo(a, b) {
    const x = normNo(a).replace(/^0+/, ''), y = normNo(b).replace(/^0+/, '');
    return x.length >= 2 && x === y;
}

/** The narration folded for reading: amounts and dates removed (their digits are never a cheque number), lower case, one space between tokens, markers split from the digits glued to them. */
function fold(description) {
    let text = String(description == null ? '' : description).replace(/[   ]/g, ' ').replace(AMOUNT_RE, ' ').replace(DATE_RE, ' ').toLowerCase();
    text = text.replace(/#/g, ' # ').replace(/[^a-z0-9#]+/g, ' ');
    text = text.replace(/\b(cheques?|chques?|cheqs?|chqs?|chk|check|cq|pdc)(no|number|num|nr)?(?=\d)/g, (all, marker, label) => marker + ' ' + (label ? label + ' ' : ''));
    return text.replace(/\s+/g, ' ').trim();
}

const directionOf = (row) => {
    const flag = String(row && row.direction != null ? row.direction : '').toLowerCase().trim();
    if (flag === 'credit' || flag === 'cr' || flag === 'c' || flag === '+') return 'credit';
    if (flag === 'debit' || flag === 'dr' || flag === 'd' || flag === '-') return 'debit';
    if (row && typeof row.signedAmount === 'number' && row.signedAmount !== 0) return row.signedAmount < 0 ? 'debit' : 'credit';
    if (row && /^\s*\[credit\]/i.test(String(row.description || ''))) return 'credit';          // the extractor's own prefix
    return '';
};

/** The cheque number a narration carries. Scored, so "CHQ DEP BR 045 285943" gives 285943 (045 is a branch) and an amount, a date, an account or a reference is never taken for one. */
function numberIn(tokens, amount) {
    const picks = [];
    const whole = Math.round(Math.abs(money(amount)));
    tokens.forEach((token, i) => {
        if (!/^\d{3,12}$/.test(token)) return;
        const prev = tokens[i - 1] || '', before = tokens[i - 2] || '', third = tokens[i - 3] || '';
        const marker = (word) => STRONG.has(word) || WEAK.has(word);
        let label = 0, labelled = false;
        if (OTHER_LABEL.has(prev) || (NO_WORDS.has(prev) && OTHER_LABEL.has(before))) return;
        if (marker(prev)) { label = 10; labelled = true; }
        else if (NO_WORDS.has(prev) && marker(before)) { label = 10; labelled = true; }
        else if (NO_WORDS.has(prev) && NO_WORDS.has(before) && marker(third)) { label = 10; labelled = true; }
        else if (CONNECT.has(prev) && (marker(before) || (CONNECT.has(before) && marker(third)))) label = 4;
        else if (NO_WORDS.has(prev)) label = 4;
        // a number the bank pads with zeros ("000285943") is the cheque it names: its length is that of the digits that count
        const padded = /^0\d{1,8}$/.test(token) && token.replace(/^0+/, '').length >= 3 ? token.replace(/^0+/, '') : token;
        const length = padded.length;
        const size = length === 6 ? 8 : length === 5 ? 4 : length === 4 ? 3 : length === 7 ? 3 : length === 8 ? 2 : length === 3 ? 1 : 0;
        // the amount echoed ("CHEQUE DEPOSIT 100000" for 100,000.00) is not a cheque number unless the narration says "No"/"#": read as an amount it can only fall back to amount + date, read as a number
        // it would hide the real cheque from the tracker
        if (Number(token) === whole && whole > 0 && !NO_WORDS.has(prev)) return;
        if (!labelled && length >= 8 && /^(?:19|20)\d{6}$/.test(token)) return;           // a yyyymmdd date
        if (!labelled && length >= 9) return;                                              // an account or a reference
        const score = size + label;
        if (score >= 5) picks.push({ token, score, at: i });
    });
    if (!picks.length) return { no: '', others: [] };
    picks.sort((a, b) => b.score - a.score || a.at - b.at);
    return { no: picks[0].token, others: picks.slice(1).filter((p) => p.score >= picks[0].score - 1).map((p) => p.token) };
}

/** Cheque text left once the cheque words, the event words and the numbers are taken out — usually the other party's name. */
export function partyFrom(description) {
    const words = fold(description).split(' ').filter((word) => word && !/^\d+$/.test(word) && word !== '#' && !STRONG.has(word) && !WEAK.has(word) && !NO_WORDS.has(word) && !CONNECT.has(word) &&
        !OTHER_LABEL.has(word) && !/^(?:rtn|rtnd|returned|dishonou?red|bounced|unpaid|clg|brn|by|to|from|of|the|and|at|on|for|a|an|nsf|insufficient|funds?|drawer|refer)$/.test(word));
    const party = words.join(' ').trim();
    return party ? party.replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 60) : '';
}

/**
 * Read one statement row.   row = { description, direction: 'debit'|'credit'|'', amount, signedAmount }
 * → { isCheque, fee, type: 'received'|'issued'|'', event: 'clear'|'return', no, returned, direction, confidence: 'high'|'medium'|'low', conflict, needsReview, reason }
 *   fee:true  a bank charge ABOUT a cheque (book, leaf, return, stop-payment, processing…) — not a cheque movement; `no` still names the cheque it is about
 *   type      the TRACKER's type: money IN is 'received', money OUT 'issued'; a RETURN flips it (a debit that brings back a deposited cheque is a received cheque going wrong)
 *   event     'clear' (it was paid / credited) or 'return' (the bank sent it back)
 */
export function readCheque(row) {
    row = row || {};
    const text = fold(row.description);
    const tokens = text ? text.split(' ') : [];
    const none = (extra) => ({ isCheque: false, fee: false, type: '', event: 'clear', no: '', returned: false, direction: directionOf(row), confidence: 'high', conflict: false, needsReview: false, reason: '', ...(extra || {}) });
    if (!tokens.length || TITLE_BEFORE.test(text)) return none();
    const strong = tokens.some((token) => STRONG.has(token));
    const { no, others } = numberIn(tokens, row.amount);
    const weakNumbered = tokens.some((token, i) => WEAK.has(token) && (/^\d{3,12}$/.test(tokens[i + 1] || '') || (NO_WORDS.has(tokens[i + 1] || '') && /^\d{3,12}$/.test(tokens[i + 2] || ''))));
    if (!strong && !weakNumbered) return none();
    // a bank charge about a cheque, never the cheque itself
    if (BOOK_RE.test(text) || STOP_RE.test(text) || STAMP_RE.test(text) || FEE_RE.test(text)) {
        return none({ fee: true, no, reason: 'a bank charge about a cheque — not a cheque movement' });
    }
    const dir = directionOf(row);
    const returned = RETURN_RE.test(text);
    const receivedWords = RECEIVED_WORDS.test(text), issuedWords = ISSUED_WORDS.test(text);
    const wording = receivedWords && !issuedWords ? 'received' : issuedWords && !receivedWords ? 'issued' : '';
    let type = '', conflict = false, confidence = 'high', reason = '';
    if (returned) {
        // a RETURN: the debit that takes back a deposited cheque is a RECEIVED cheque that failed; a credit that brings money back is an ISSUED cheque that failed
        type = dir === 'debit' ? 'received' : dir === 'credit' ? 'issued' : (wording === 'issued' ? 'issued' : 'received');
        if (!dir) confidence = 'medium';
        reason = 'cheque ' + (no ? no + ' ' : '') + 'returned by the bank';
    } else if (dir) {
        type = dir === 'credit' ? 'received' : 'issued';
        // the wording disagrees with the bank's own flag: the flag stays in charge (it is the money), the row is flagged
        if (wording && wording !== type && /\b(?:deposit|dep|dpst|realis\w*|realiz\w*|lodg\w*|paid|payment|pmt|issued|withdraw\w*|presented|encash\w*|honou?red)\b/.test(text)) { conflict = true; confidence = 'medium'; }
        reason = 'cheque ' + (no ? no + ' ' : '') + (type === 'received' ? 'credited to the account' : 'paid from the account');
    } else {
        type = wording;
        confidence = type ? 'medium' : 'low';
        reason = type ? 'cheque ' + (no ? no + ' ' : '') + 'read from the wording (the statement gave no debit/credit flag)' : 'a cheque, but which way the money went is not stated';
    }
    if (!no) confidence = confidence === 'high' ? 'medium' : 'low';
    return { isCheque: true, fee: false, type, event: returned ? 'return' : 'clear', no, returned, direction: dir, confidence, conflict, needsReview: conflict || !type, reason, otherNumbers: others };
}

/* ---- matching ------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
const bankWords = (value) => String(value || '').toLowerCase().replace(/\b(?:bank|plc|ltd|limited|of|ceylon|the|pvt|commercial|national|savings|hatton|nations|trust|people'?s|cargills)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
/** The institution a bank name stands for ("HNB", "Hnb", "Hatton National Bank (HNB)" are one), or '' when the app does not know that bank. */
const bankId = (value) => {
    const text = String(value || '').trim();
    if (!text) return '';
    try { const found = institutionFor(displayBank(text)) || institutionFor(text); return found ? String(found.lockId || found.id) : ''; } catch (_) { return ''; }
};
/** true / false when both sides name a bank, null when either is silent. "Sampath Bank PLC" = "Sampath"; "HNB" = "Hatton National Bank". */
export function sameBank(a, b) {
    const known = bankId(a), other = bankId(b);
    if (known && other) return known === other;
    const x = String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ''), y = String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!x || !y) return null;
    if (x === y || x.includes(y) || y.includes(x)) return true;
    const p = bankWords(a), q = bankWords(b);
    if (!p || !q) return false;
    return p.split(' ').some((word) => word.length >= 3 && q.split(' ').includes(word));
}
/** true only when BOTH names are banks the app knows and they are different banks. A name it cannot place is never a reason to refuse a match. */
const surelyAnotherBank = (a, b) => { const x = bankId(a), y = bankId(b); return !!x && !!y && x !== y; };

const dateOf = (cheque) => cheque.release || cheque.issue || '';
const stateRank = (cheque, event) => event === 'return' ? (cheque.status === 'cleared' ? 0 : cheque.status === 'pending' ? 1 : 2) : (cheque.status === 'pending' ? 0 : cheque.status === 'bounced' ? 1 : 2);

/* the same cheque cleared before, by this very statement row or on the same day for the same money */
function settledBefore(cheque, row, event) {
    if (row.key && cheque.statementKey && cheque.statementKey === row.key && (row.rowNo == null || cheque.statementRow == null || Number(cheque.statementRow) === Number(row.rowNo))) return true;
    const at = event === 'return' ? cheque.bouncedDate : cheque.clearedDate;
    const wanted = event === 'return' ? 'bounced' : 'cleared';
    if (cheque.status !== wanted) return false;
    const gap = gapDays(at || dateOf(cheque), row.date);
    return !Number.isFinite(gap) || gap <= 31;
}

/**
 * Which tracked cheque does this statement row settle?
 *   read    readCheque's answer.      row = { date, amount, bank, key, rowNo, nth, claim, batch }.      cheques = the tracker's list.
 *           key / claim / batch name where the row comes from (statement, hand upload, import batch): a row never matches what its own origin wrote for another row.
 * → { status: 'matched' | 'ambiguous' | 'none', cheque, by: 'number'|'row'|'amount-date'|'', already: bool, amountDiffers: bool, candidates: [cheque…] }
 *   already:true  the tracker already shows this event (cleared / bounced) — nothing to write
 * A cheque is matched by its NUMBER first (leading zeros do not matter); only a cheque with no number to compare — or a row that prints none — falls back to the amount and the days.
 * Two records that are the same cheque twice over (same number, amount and bank) are interchangeable: the first is settled. Two that differ are never guessed between.
 */
export function matchTracked(read, row, cheques) {
    const none = (extra) => ({ status: 'none', cheque: null, by: '', already: false, amountDiffers: false, candidates: [], ...(extra || {}) });
    row = row || {};
    if (!read || !read.isCheque || !read.type) return none();
    // a cheque the owner ISSUED is drawn on the account the statement belongs to: the same number in another bank's book is another cheque
    const list = Array.isArray(cheques) ? cheques.filter((c) => c && typeof c === 'object' && c.type === read.type && !(read.type === 'issued' && surelyAnotherBank(c.bank, row.bank))) : [];
    const event = read.event;
    const done = event === 'return' ? 'bounced' : 'cleared';
    const bankKey = (value) => bankWords(value) || String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    // 1. the very row, filed before (a statement uploaded twice, or by two doors)
    const filed = list.filter((c) => row.key && c.statementKey === row.key && c.statementRow != null && row.rowNo != null && Number(c.statementRow) === Number(row.rowNo));
    if (filed.length) return { status: 'matched', cheque: filed[0], by: 'row', already: true, amountDiffers: false, candidates: filed };

    const pick = (all, by) => {
        if (!all.length) return null;
        // an issued cheque of the bank the statement belongs to comes before one with no bank written, whatever the amounts (a corrected amount still names the right cheque)
        const agreeing = read.type === 'issued' ? all.filter((c) => sameBank(c.bank, row.bank) === true) : [];
        const pool = agreeing.length ? agreeing : all;
        const exact = pool.filter((c) => same(c.amount, row.amount));
        const group = exact.length ? exact : pool;
        const ranked = group.slice().sort((a, b) =>
            stateRank(a, event) - stateRank(b, event) ||
            (sameBank(b.bank, row.bank) === true ? 1 : 0) - (sameBank(a.bank, row.bank) === true ? 1 : 0) ||
            (gapDays(dateOf(a), row.date) || 0) - (gapDays(dateOf(b), row.date) || 0));
        const best = ranked[0];
        const rivals = ranked.filter((c) => stateRank(c, event) === stateRank(best, event) && (sameBank(c.bank, row.bank) === true) === (sameBank(best.bank, row.bank) === true));
        // rivals that are the same cheque keyed twice are interchangeable; rivals that differ (another bank's book reusing the number, another amount) are not guessed between
        const alike = rivals.every((c) => same(c.amount, best.amount) && bankKey(c.bank) === bankKey(best.bank));
        if (rivals.length > 1 && !alike) return { status: 'ambiguous', cheque: null, by, already: false, amountDiffers: false, candidates: rivals };
        const already = settledBefore(best, row, event);
        // a cheque this tracker closed long ago is not THIS row's cheque: cheque books reuse numbers
        if (!already && best.status === done) return null;
        return { status: 'matched', cheque: best, by, already, amountDiffers: !same(best.amount, row.amount), candidates: rivals };
    };

    // 2. by number
    if (read.no) {
        const byNumber = list.filter((c) => sameNo(c.no, read.no));
        if (byNumber.length) {
            const hit = pick(byNumber, 'number');
            if (hit) return hit;
        }
    }
    // 3. by amount and days: a cheque logged without its number (or a row that prints none), the money equal, the days fitting — and only one that fits
    const unnumbered = (c) => !normNo(c.no);
    const open = list.filter((c) => (!read.no || unnumbered(c)) && same(c.amount, row.amount) && (event === 'return' ? (c.status === 'cleared' || c.status === 'pending') : c.status === 'pending'));
    const fitting = open.filter((c) => {
        const gap = (asDate(row.date) - asDate(dateOf(c))) / 86400000;
        if (!Number.isFinite(gap)) return false;
        // paid no sooner than a few days before its release date and no later than a month after it; a return comes after the deposit
        return event === 'return' ? gap >= -1 && gap <= 90 : gap >= -5 && gap <= 31;
    });
    if (fitting.length === 1) return { status: 'matched', cheque: fitting[0], by: 'amount-date', already: false, amountDiffers: false, candidates: fitting };
    if (fitting.length > 1) {
        const banked = fitting.filter((c) => sameBank(c.bank, row.bank) === true);
        if (banked.length === 1) return { status: 'matched', cheque: banked[0], by: 'amount-date', already: false, amountDiffers: false, candidates: fitting };
        return { status: 'ambiguous', cheque: null, by: 'amount-date', already: false, amountDiffers: false, candidates: fitting };
    }
    // 4. a row with no number that ANOTHER reading of the statement already settled: the Nth identical row is a copy only if N of them are already there. What this very statement / upload wrote
    //    is not a copy of its own next row (two identical number-less rows on one day are two cheques), so records of the same origin are left out.
    if (!read.no) {
        const mine = (c) => !!((row.key && c.statementKey === row.key) || (row.claim && c.uploadClaim === row.claim) || (row.batch && c._batch === row.batch));
        const settled = list.filter((c) => !mine(c) && c.status === done && same(c.amount, row.amount) && (event === 'return' ? c.bouncedDate : c.clearedDate) === String(row.date || '').slice(0, 10));
        if (settled.length >= Math.max(1, Number(row.nth) || 1)) return { status: 'matched', cheque: settled[0], by: 'row', already: true, amountDiffers: false, candidates: settled };
    }
    return none();
}

/* ---- the whole decision --------------------------------------------------------------------------------------------------------------------------------------------------------- */
const stamp = (note, add) => { const left = String(note || '').trim(); return left ? (left.includes(add) ? left : left + ' · ' + add) : add; };

/** What the cheque was before THIS statement first touched it, so unfiling the statement puts it back exactly: its status, the days it cleared / bounced, and whose record of it it was.
 *  A second row of the same statement (cleared, then returned) keeps the first picture, not the half-way one. */
function before(cheque, provenance) {
    if (provenance.statementKey && cheque.statementKey === provenance.statementKey && cheque.prevStatus !== undefined) {
        const keep = {};
        for (const field of ['prevStatus', 'prevDates', 'prevStatement']) if (cheque[field] !== undefined) keep[field] = cheque[field];
        return keep;
    }
    return {
        prevStatus: cheque.status,
        prevDates: { clearedDate: cheque.clearedDate || '', bouncedDate: cheque.bouncedDate || '' },
        prevStatement: { statementKey: cheque.statementKey || '', statementRow: cheque.statementRow == null ? null : cheque.statementRow, uploadClaim: cheque.uploadClaim || '' },
    };
}

/**
 * Decide what one statement row does to the Cheque Tracker and to the books.
 *   row = { description, direction, amount, signedAmount, date, bank, key (the statement), rowNo, nth, ref }
 *   cheques = the tracker's list;   options = { id (for a new record), now (ISO), source ({ statementKey, statementRow, bank, uploadClaim … } copied onto what is written), note }
 * → { read, isCheque, fee, action, cheque, patch, record, filesIncome, filesExpense, ambiguous, candidates, by, review: [reason…], reason }
 *   action  'none'    not a cheque movement (a fee, or not a cheque) — the caller routes the row as it always did
 *           'already' the tracker already shows it (nothing to write on the tracker; income may still be owed — see filesIncome)
 *           'clear'   an existing cheque was paid / credited:  merge `patch` into `cheque`
 *           'bounce'  an existing cheque was returned:         merge `patch` into `cheque`
 *           'create'  no tracked cheque: write `record` (status cleared, or bounced for a return)
 *   filesIncome   the row's money is income (a deposit credit) — the caller files an income row, de-duplicated as it dedupes every income row
 *   filesExpense  the row's money is an expense (the debit that takes back a deposited cheque)
 */
export function settleCheque(row, cheques, options) {
    row = row || {}; options = options || {};
    let read = readCheque(row);
    // the owner sent a row that does not read as a cheque to the Cheque tab by hand: it is settled as a plain clearing, the way the bank's flag says the money went
    if (!read.isCheque && options.force && directionOf(row)) {
        read = { ...read, isCheque: true, fee: false, type: directionOf(row) === 'credit' ? 'received' : 'issued', event: 'clear', returned: false, confidence: 'low', needsReview: false, reason: 'filed to the Cheque tab by hand' };
    }
    const out = { read, isCheque: read.isCheque, fee: read.fee, action: 'none', cheque: null, patch: null, record: null, filesIncome: false, filesExpense: false, ambiguous: false, candidates: [], by: '', review: [], reason: read.reason };
    if (!read.isCheque) return out;
    if (!read.type) { out.review.push('a cheque, but the statement does not say whether the money came in or went out'); return out; }
    const amount = Math.abs(money(row.amount));
    const date = String(row.date || '').slice(0, 10);
    const hit = matchTracked(read, { ...row, amount, claim: row.claim || (options.source && options.source.uploadClaim) || '', key: row.key || (options.source && options.source.statementKey) || '' }, cheques);
    out.by = hit.by; out.candidates = hit.candidates || []; out.ambiguous = hit.status === 'ambiguous';
    if (read.needsReview) out.review.push(read.conflict ? 'the wording and the debit/credit flag disagree — filed by the flag' : 'direction unclear');
    if (out.ambiguous) out.review.push('more than one tracked cheque fits (' + out.candidates.map((c) => (c.no || '—') + ' ' + (c.party || '')).join(', ') + ') — none was changed');
    const event = read.event;
    // the books: what carries this row's money
    out.filesIncome = read.type === 'received' && event === 'clear';
    out.filesExpense = read.type === 'received' && event === 'return';
    const provenance = options.source && typeof options.source === 'object' ? options.source : {};
    const trail = (verb) => verb + ' on the bank statement ' + date + (row.bank ? ' (' + row.bank + ')' : '');

    if (hit.status === 'matched' && hit.cheque) {
        out.cheque = hit.cheque;
        if (hit.already) { out.action = 'already'; return out; }
        if (event === 'return') {
            out.action = 'bounce';
            out.patch = { status: 'bounced', bouncedDate: date, ...before(hit.cheque, provenance), ...(provenance.statementKey ? { statementKey: provenance.statementKey, statementRow: provenance.statementRow } : {}),
                ...(provenance.uploadClaim ? { uploadClaim: provenance.uploadClaim } : {}), notes: stamp(hit.cheque.notes, trail('Returned')) };
        } else {
            out.action = 'clear';
            out.patch = { status: 'cleared', clearedDate: date, ...before(hit.cheque, provenance), ...(provenance.statementKey ? { statementKey: provenance.statementKey, statementRow: provenance.statementRow } : {}),
                ...(provenance.uploadClaim ? { uploadClaim: provenance.uploadClaim } : {}), ...(hit.cheque.bank ? {} : { bank: row.bank || '' }), ...(normNo(hit.cheque.no) ? {} : (read.no ? { no: read.no } : {})), notes: stamp(hit.cheque.notes, trail('Cleared')) };
            // the bank moved this much money: that is the truth the books keep; what was typed in is kept in the note
            if (hit.amountDiffers && amount) { out.patch.amount = amount; if (hit.cheque.prevAmount === undefined || !(provenance.statementKey && hit.cheque.statementKey === provenance.statementKey)) out.patch.prevAmount = hit.cheque.amount; out.patch.notes = stamp(out.patch.notes, 'amount on file was ' + money(hit.cheque.amount)); out.review.push('the statement amount differs from the tracked cheque — the statement amount was kept'); }
        }
        return out;
    }
    // nothing tracked: the statement is the record (never lost, never counted twice)
    if (read.type === 'issued' && read.no) {
        const elsewhere = (Array.isArray(cheques) ? cheques : []).filter((c) => c && c.type === 'issued' && c.status === 'pending' && sameNo(c.no, read.no) && surelyAnotherBank(c.bank, row.bank));
        if (elsewhere.length) out.review.push('a cheque numbered ' + read.no + ' is also tracked at ' + (elsewhere[0].bank || 'another bank') + ' — this one was filed on its own; remove the duplicate if they are the same cheque');
    }
    if (out.ambiguous) { /* several fit: write a record of its own rather than touch the wrong one — the review note says why */ }
    out.action = 'create';
    out.record = {
        id: options.id || ('chq_' + Math.random().toString(36).slice(2, 10)), no: read.no || '', party: partyFrom(row.description) || 'Cheque on statement', bank: row.bank || provenance.bank || '', type: read.type,
        amount, issue: date, release: date, status: event === 'return' ? 'bounced' : 'cleared', source: 'statement',
        ...(event === 'return' ? { bouncedDate: date } : { clearedDate: date }),
        notes: stamp(options.note, trail(event === 'return' ? 'Returned' : 'Cleared')), createdAt: options.now || new Date().toISOString(),
        ...(provenance.statementKey ? { statementKey: provenance.statementKey, statementRow: provenance.statementRow, createdKey: provenance.statementKey } : {}),
        ...(provenance.uploadClaim ? { uploadClaim: provenance.uploadClaim } : {}),
    };
    return out;
}

/**
 * Is this deposit ALREADY in the owner's income? The owner often types "Rent — Silva 50,000" into Income when a cheque arrives; the bank's credit for that cheque must not become a second income.
 * Counted only when the income row has the same amount, falls within a week of the deposit, was not itself filed from a statement, AND names the cheque (its number, or a word of its
 * payer's name that the tracked cheque or the narration also carries). Returns that income row, or null.
 */
export function incomeCounted(row, cheque, incomes) {
    row = row || {};
    const amount = Math.abs(money(row.amount));
    const words = (value) => new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STRONG.has(w) && !CONNECT.has(w) && !/^(?:bank|branch|payment|transfer|clearing|local|plc|limited|account)$/.test(w)));
    const mine = new Set([...words(partyFrom(row.description)), ...words(cheque && cheque.party)]);
    const no = normNo(cheque && cheque.no) || readCheque(row).no;
    for (const income of Array.isArray(incomes) ? incomes : []) {
        if (!income || income.source === 'statement' || !same(income.amount, amount)) continue;
        const gap = gapDays(income.date || (income.month ? income.month + '-15' : ''), row.date);
        if (!Number.isFinite(gap) || gap > 7) continue;
        const text = String(income.name || income.desc || '') + ' ' + String(income.notes || '');
        if (no && no.replace(/^0+/, '').length >= 3 && text.replace(/\D+/g, ' ').split(' ').some((digits) => sameNo(digits, no))) return income;
        if ([...words(text)].some((word) => mine.has(word))) return income;
    }
    return null;
}

/* ---- the payment the owner ALSO typed in ------------------------------------------------------------------------------------------------------------------------------------------ */
/* An issued cheque the bank paid IS the payment; but the owner often typed the same payment into Expenses too (or pasted the bank's SMS). The page's manual upload has to find that entry the way
 * the email worker does (statement-links.mjs manualTwin — the same rule, kept in step by test/cheques_test.js, which runs both over the same cases): the same amount to the cent, the same day or a
 * day either side (three when the typed words and the narration share a word), not already standing for another row, and never two that fit equally. */
const TW_STOP = new Set(['payment', 'transfer', 'credit', 'debit', 'online', 'bank', 'card', 'pos', 'transaction', 'purchase', 'salary', 'monthly', 'ceft', 'cefts', 'slips', 'inward', 'outward']);
const TW_COMMON = new Set(['payment', 'transfer', 'credit', 'debit', 'online', 'bank', 'card', 'pos', 'transaction', 'purchase', 'monthly', 'ceft', 'cefts', 'slips', 'inward', 'outward', 'other', 'expense', 'income']);
const twWords = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const twTokens = (v) => twWords(v).split(' ').filter((t) => t.length >= 4 && !TW_STOP.has(t));
const twShares = (typed, text) => twWords(typed).split(' ').some((w) => w.length >= 4 && !TW_COMMON.has(w) && text.includes(w));
const twDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
const twCents = (v) => Math.round(money(v) * 100);
/** @returns {{r: object, gap: number, recurring: boolean}|null} the entry the owner typed for this payment, or null */
export function typedTwin(records, row, { strict = false } = {}) {
    const want = twCents(row && row.amount), day = twDay(row && row.date);
    if (!(want > 0) || !Number.isFinite(day)) return null;
    const month = String((row && row.date) || '').slice(0, 7);
    const text = twWords(row.description || row.narration);
    const fits = [];
    for (const r of Array.isArray(records) ? records : []) {
        if (!r || r.source === 'statement' || r.statementKey || twCents(r.amount) !== want) continue;
        if (r.loanLink || r.subscriptionLink) continue;
        if (r.uploadClaim || r._batch || (r.feeMeta && r.feeMeta.source === 'statement')) continue;
        const mine = twTokens(r.desc || r.name), named = mine.some((t) => text.includes(t)) || twShares(r.desc || r.name, text);
        if (r.recurring) {
            if (r.statementTwins && r.statementTwins[month]) continue;
            if (!mine.length || !named || String(r.month || '') > month) continue;
            fits.push({ r, gap: 0, recurring: true });
            continue;
        }
        if (r.statementTwin) continue;
        const at = twDay(r.date);
        if (!Number.isFinite(at)) continue;
        const gap = Math.abs(at - day);
        if (gap <= (named ? 3 : strict ? 0 : 1)) fits.push({ r, gap, recurring: false });
    }
    if (!fits.length) return null;
    fits.sort((a, b) => a.gap - b.gap);
    if (fits.length > 1 && fits[0].gap === fits[1].gap) return null;
    return fits[0];
}
/** Tie the typed entry to the statement row it stands for (the stamp the worker writes, statement-links.mjs markTwin), so it stands for no second row. */
export function stampTwin(twin, row, key, index, now) {
    const stampOf = { sourcePath: key, index, date: String(row.date || ''), cents: twCents(row.amount), direction: String(row.direction || '') };
    if (twin.recurring) twin.r.statementTwins = { ...(twin.r.statementTwins || {}), [String(row.date || '').slice(0, 7)]: stampOf };
    else twin.r.statementTwin = stampOf;
    twin.r._ut = now;
    return twin.r;
}

const API = { readCheque, matchTracked, settleCheque, incomeCounted, normNo, sameNo, sameBank, partyFrom, typedTwin, stampTwin };

if (typeof window !== 'undefined') window.WFCheques = API;

export default API;
