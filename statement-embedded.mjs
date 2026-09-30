// The bank's OWN data, read without running anything.
//
// An emailed "Smart Statement" draws its tables with JavaScript, which is why it
// used to need the owner's phone: a browser had to run the page before there was
// anything to read. But the page does not invent its rows — it draws them from
// data the bank wrote into the same document, and that data is far better
// evidence than the drawn table:
//
//   Nations Trust consolidated:  stData.push({ transactionDateFull: "02-01-2026",
//       savingsTransactionDetails, savingsTransactionRefNo, transactionDebit,
//       transactionCredit, savingsTransactionBalance, … }) for every row, then
//       savingsDataList.push({ savingsAccountNo, savingsBfBalance (opening),
//       savingsDeposit, savingsWithdrawal, savingsBalance (closing),
//       transactionData: stData })
//   Nations Trust American Express:  cardTransactionsSummaryData = { openingBalance,
//       closingBalance, payment, credits, … } and cardTransactionsDataList =
//       [{ cardNo, consumerTransactions: [{ postDate, txDate, description,
//       txConvertedAmount, crDr }] }] — plain JSON.
//
// Nothing here executes the document. The data is located, scanned as text and
// parsed by a deliberately small literal parser that refuses anything it does not
// recognise. Then the statement is held to arithmetic the bank itself supplied:
// opening + credits - debits must reach the closing balance, the rows must add
// up to the bank's own totals, and — where the bank prints a running balance —
// every row must follow from the one before it. A statement is called verified
// only when ALL of that holds, to the cent, so a misread digit, a lost row or a
// duplicated one cannot pass: it makes the arithmetic disagree.
//
// It never files anything itself. It returns the same {parsed, text} the table
// reader returns, and says why when it cannot vouch for a statement so the
// caller can fall back to the next reader instead of guessing.

const MAX_SCRIPT = 3_000_000;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MON_NAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── a literal parser that refuses what it does not understand ───────────────
class Refused extends Error {}
function parseLiteral(src, arrays = new Map()) {
    let i = 0;
    const ws = () => { for (;;) { while (i < src.length && /\s/.test(src[i])) i++; if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; } else if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); if (e < 0) throw new Refused('comment'); i = e + 2; } else return; } };
    const string = () => {
        const q = src[i++]; let out = '';
        while (i < src.length && src[i] !== q) {
            let c = src[i++];
            if (c === '\\') {
                c = src[i++];
                if (c === 'n') out += '\n'; else if (c === 't') out += '\t'; else if (c === 'r') out += '\r';
                else if (c === 'u') { const h = src.slice(i, i + 4); if (!/^[\da-f]{4}$/i.test(h)) throw new Refused('escape'); out += String.fromCharCode(parseInt(h, 16)); i += 4; }
                else if (c === 'x') { const h = src.slice(i, i + 2); if (!/^[\da-f]{2}$/i.test(h)) throw new Refused('escape'); out += String.fromCharCode(parseInt(h, 16)); i += 2; }
                else out += c;
            } else out += c;
        }
        if (src[i] !== q) throw new Refused('string');
        i++;
        return out;
    };
    const value = () => {
        ws();
        const c = src[i];
        if (c === '"' || c === "'") return string();
        if (c === '{') return object();
        if (c === '[') return array();
        const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 40));
        if (num) { i += num[0].length; return Number(num[0]); }
        const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
        if (!id) throw new Refused('token');
        i += id[0].length;
        if (id[0] === 'true') return true;
        if (id[0] === 'false') return false;
        if (id[0] === 'null') return null;
        if (id[0] === 'undefined') return undefined;
        if (arrays.has(id[0])) return arrays.get(id[0]);
        throw new Refused('identifier');
    };
    const array = () => {
        i++; const out = [];
        for (;;) { ws(); if (src[i] === ']') { i++; return out; } out.push(value()); ws(); if (src[i] === ',') i++; else if (src[i] !== ']') throw new Refused('array'); }
    };
    const object = () => {
        i++; const out = {};
        for (;;) {
            ws(); if (src[i] === '}') { i++; return out; }
            let key;
            if (src[i] === '"' || src[i] === "'") key = string();
            else { const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80)); if (!id) throw new Refused('key'); key = id[0]; i += key.length; }
            ws(); if (src[i] !== ':') throw new Refused('colon'); i++;
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Refused('key');
            out[key] = value();
            ws(); if (src[i] === ',') i++; else if (src[i] !== '}') throw new Refused('object');
        }
    };
    ws();
    const out = value();
    ws();
    if (i !== src.length) throw new Refused('trailing');
    return out;
}

// The end of the balanced {…} / […] that starts at src[start].
function balancedEnd(src, start) {
    const open = src[start], close = open === '{' ? '}' : ']';
    let depth = 0, q = '';
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === open) depth++;
        else if (c === close && --depth === 0) return i + 1;
    }
    return -1;
}

// A running balance chains every row to the one before it. When the bank lists
// rows in an order that is not the order it posted them (same-day entries), the
// data order breaks that chain even though every figure is right. Each row is an
// edge from the balance it started from to the balance it left; if ONE walk from
// the opening balance uses every edge, the rows are a permutation of a valid
// ledger — nothing missing, nothing misread, nothing duplicated. Returns the
// walk as row indexes, preferring the order the bank printed, or null.
function chainOrder(items, opening) {
    const edges = items.map(it => ({ from: it.balance - it.credit + it.debit, to: it.balance }));
    const out = new Map();
    edges.forEach((e, i) => { if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(i); });
    const ptr = new Map(), nodes = [opening], used = [-1], trail = [];
    while (nodes.length) {
        const v = nodes.at(-1), list = out.get(v), p = ptr.get(v) || 0;
        if (list && p < list.length) { ptr.set(v, p + 1); nodes.push(edges[list[p]].to); used.push(list[p]); }
        else { nodes.pop(); const e = used.pop(); if (e >= 0) trail.push(e); }
    }
    trail.reverse();
    if (trail.length !== edges.length) return null;
    let at = opening;
    for (const i of trail) { if (edges[i].from !== at) return null; at = edges[i].to; }
    return trail;
}

// Inline <script> bodies, found with plain scans (no backtracking) so a crafted
// document cannot make the search quadratic.
const scriptsOf = html => {
    const out = [], text = String(html), open = /<script\b[^>]{0,400}>/gi;
    let m;
    while ((m = open.exec(text)) !== null) {
        const bodyStart = m.index + m[0].length;
        const lower = text.indexOf('</script', bodyStart), upper = text.indexOf('</SCRIPT', bodyStart);
        const end = lower < 0 ? upper : upper < 0 ? lower : Math.min(lower, upper);
        if (end < 0) break;
        open.lastIndex = end;
        if (/\bsrc\s*=/i.test(m[0]) || end - bodyStart > MAX_SCRIPT) continue;
        out.push(text.slice(bodyStart, end));
    }
    return out;
};

// ── money in whole cents ────────────────────────────────────────────────────
const cents = v => {
    if (v === '' || v === null || v === undefined) return 0;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) return NaN;
    const c = Math.round(n * 100);
    return Math.abs(n * 100 - c) < 1e-6 ? c : NaN;
};
const fromCents = c => Math.round(c) / 100;
const money2 = c => (c / 100).toFixed(2);
const decode = s => String(s ?? '').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27|#\d+);/gi, m => {
    const t = m.slice(1, -1).toLowerCase();
    if (t === 'amp') return '&'; if (t === 'lt') return '<'; if (t === 'gt') return '>'; if (t === 'quot') return '"';
    if (t === 'apos' || t === '#39' || t === '#x27') return "'"; if (t === 'nbsp') return ' ';
    return String.fromCharCode(Number(t.slice(1)));
}).replace(/\s+/g, ' ').trim();
const isoOf = (y, m, d) => {
    const at = new Date(Date.UTC(y, m - 1, d));
    return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
};
const prettyDate = iso => `${Number(iso.slice(8))} ${MON_NAME[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

// ── Nations Trust consolidated statement ────────────────────────────────────
function ntbScripts(scripts) {
    const found = scripts.filter(s => /\b(?:savings|current)DataList\b/.test(s) && /\.push\(\s*\{/.test(s));
    return found;
}

// Replays only the two statement shapes the page uses to build its data —
// `NAME = [];` and `NAME.push({…});` — in source order, so each account gets the
// array as it stood when the account was pushed. Nothing else in the script runs.
function replayNtb(script) {
    const events = [];
    for (const m of script.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*=\s*\[\s*\]/g)) events.push({ at: m.index, kind: 'reset', name: m[1] });
    for (const m of script.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\.push\(\s*\{/g)) events.push({ at: m.index, kind: 'push', name: m[1], open: m.index + m[0].length - 1 });
    events.sort((a, b) => a.at - b.at || (a.kind === 'reset' ? -1 : 1));
    const arrays = new Map(), lists = { savings: [], current: [] };
    for (const ev of events) {
        if (ev.kind === 'reset') { arrays.set(ev.name, []); continue; }
        const end = balancedEnd(script, ev.open);
        if (end < 0) throw new Refused('unbalanced');
        const isAccount = /^(savings|current)DataList$/.exec(ev.name);
        if (!isAccount && !arrays.has(ev.name)) continue;
        const obj = parseLiteral(script.slice(ev.open, end), arrays);
        if (isAccount) lists[isAccount[1]].push(obj);
        else arrays.get(ev.name).push(obj);
    }
    return lists;
}

const pick = (obj, re, not) => { const k = Object.keys(obj).find(key => re.test(key) && !(not && not.test(key))); return k === undefined ? undefined : obj[k]; };

// "dd-mm-yyyy to dd-mm-yyyy" → the period's end date (UTC ms), for a date printed as "31-Jan".
// The statement's own period as UTC ms bounds, or null. A row dated far outside it is a typo in a year, not a transaction.
const periodOfText = text => { const m = /(\d{1,2})-(\d{1,2})-(\d{4})\s*to\s*(\d{1,2})-(\d{1,2})-(\d{4})/i.exec(String(text || '')); return m && isoOf(Number(m[3]), Number(m[2]), Number(m[1])) && isoOf(Number(m[6]), Number(m[5]), Number(m[4])) ? { start: Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])), end: Date.UTC(Number(m[6]), Number(m[5]) - 1, Number(m[4])) } : null; };
const withinPeriod = (iso, period) => !period || (Date.parse(iso) >= period.start - 10 * 86400000 && Date.parse(iso) <= period.end + 10 * 86400000);
const periodEndOf = text => { const m = /(\d{1,2})-(\d{1,2})-(\d{4})\s*to\s*(\d{1,2})-(\d{1,2})-(\d{4})/i.exec(String(text || '')); return m && isoOf(Number(m[6]), Number(m[5]), Number(m[4])) ? Date.UTC(Number(m[6]), Number(m[5]) - 1, Number(m[4])) : null; };
function yearlessDate(text, end) {
    const m = /^(\d{1,2})[-\s]([A-Za-z]{3})/.exec(String(text || '').trim());
    if (!m || !MONTHS[m[2].toLowerCase()] || end === null) return '';
    const endYear = new Date(end).getUTCFullYear();
    for (const y of [endYear + 1, endYear, endYear - 1]) { const iso = isoOf(y, MONTHS[m[2].toLowerCase()], Number(m[1])); if (iso && Date.parse(iso) <= end + 7 * 86400000) return iso; }
    return '';
}

function readNtbAccount(kind, account, problems, ctx) {
    const number = String(pick(account, /AccountNo$/) ?? '').replace(/\D/g, '');
    const currency = String(pick(account, /Currency$/) ?? '').trim().toUpperCase();
    // Savings and current accounts name the same things differently.
    const opening = cents(pick(account, /^(?:\w*BfBalance|bfBalance)$/i));
    const closing = cents(pick(account, /^(?:savings|current)Balance$/i));
    const deposits = cents(pick(account, /^(?:savingsDeposit|currentCredit)$/i)), withdrawals = cents(pick(account, /^(?:savingsWithdrawal|currentDebit)$/i));
    const list = account.transactionData;
    if (!/^\d{6,16}$/.test(number)) problems.push('account-number-unreadable');
    if (currency && currency !== 'LKR') problems.push('foreign-currency-account');
    if (!Array.isArray(list)) { problems.push('transactions-missing'); return null; }
    if ([opening, closing].some(Number.isNaN)) problems.push('balance-unreadable');
    const items = [];
    let sumDebit = 0, sumCredit = 0, zero = 0;
    for (const t of list) {
        const debit = cents(t.transactionDebit), credit = cents(t.transactionCredit), balance = cents(t.runningTotal);
        const details = decode(pick(t, /TransactionDetails$/i));
        const full = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(t.transactionDateFull ?? '').trim());
        const date = full ? isoOf(Number(full[3]), Number(full[2]), Number(full[1])) : yearlessDate(pick(t, /TransactionDate$/i), ctx.periodEnd);
        if ([debit, credit, balance].some(Number.isNaN) || debit < 0 || credit < 0) { problems.push('amount-unreadable'); continue; }
        if (!date) { problems.push('date-unreadable'); continue; }
        if (debit > 0 && credit > 0) { problems.push('debit-and-credit'); continue; }
        if (!details) { problems.push('description-missing'); continue; }
        if (!withinPeriod(date, ctx.period)) problems.push('date-outside-period');
        items.push({ debit, credit, balance, date, details, ref: String(pick(t, /TransactionRefNo$/i) ?? '').trim(),
            cumDebit: t.runningDebitTotal === undefined ? NaN : cents(t.runningDebitTotal), cumCredit: t.runningCreditTotal === undefined ? NaN : cents(t.runningCreditTotal) });
    }
    // Chain the rows: as printed if that holds, otherwise by the one ordering that does.
    let sequence = items.map((_, i) => i), reordered = false;
    if (!Number.isNaN(opening)) {
        const strict = items.every((it, k) => (k ? items[k - 1].balance : opening) + it.credit - it.debit === it.balance);
        if (!strict) {
            const walk = chainOrder(items, opening);
            if (walk) { sequence = walk; reordered = true; } else problems.push('balance-chain-broken');
        }
    }
    let runDebit = 0, runCredit = 0;
    for (const i of sequence) {
        const it = items[i];
        runDebit += it.debit; runCredit += it.credit;
        if ((!Number.isNaN(it.cumDebit) && it.cumDebit !== runDebit) || (!Number.isNaN(it.cumCredit) && it.cumCredit !== runCredit)) { problems.push('running-totals-broken'); break; }
    }
    const rows = [];
    for (const it of items) {
        if (!it.debit && !it.credit) { zero++; continue; }
        sumDebit += it.debit; sumCredit += it.credit;
        rows.push({ date: it.date, narration: it.details, amount: fromCents(it.debit || it.credit), direction: it.debit ? 'debit' : 'credit', balance: fromCents(it.balance), valid: true, balanceVerified: true,
            directionSource: 'balance', needsReview: false, ref: it.ref || undefined, card_last4: number.slice(-4) });
    }
    const chain = sequence.length ? items[sequence.at(-1)].balance : opening;
    if (!Number.isNaN(deposits) && sumCredit !== deposits) problems.push('deposits-total-disagrees');
    if (!Number.isNaN(withdrawals) && sumDebit !== withdrawals) problems.push('withdrawals-total-disagrees');
    if (!Number.isNaN(opening) && !Number.isNaN(closing) && opening + sumCredit - sumDebit !== closing) problems.push('balances-do-not-reconcile');
    if (!Number.isNaN(closing) && chain !== closing) problems.push('last-balance-is-not-closing');
    ctx.zeroSkipped += zero;
    if (reordered) ctx.reordered = (ctx.reordered || 0) + 1;
    return { number, kind, opening, closing, credits: sumCredit, debits: sumDebit, rows };
}

function periodOf(scripts) {
    for (const s of scripts) {
        const m = /\bstatementPeriod\s*=\s*["']\s*([^"']{6,60}?)\s*["']/.exec(s);
        if (m) return m[1];
    }
    return '';
}

function readNtb(html, scripts) {
    const found = ntbScripts(scripts);
    if (!found.length) return null;
    const problems = [], ctx = { zeroSkipped: 0, periodEnd: periodEndOf(periodOf(scripts)), period: periodOfText(periodOf(scripts)) };
    let lists;
    try {
        lists = { savings: [], current: [] };
        for (const s of found) { const l = replayNtb(s); lists.savings.push(...l.savings); lists.current.push(...l.current); }
    } catch (e) { return { recognized: true, verified: false, kind: 'ntb-consolidated', problems: [e instanceof Refused ? `data-shape-unsupported:${e.message}` : 'data-unreadable'] }; }
    const accounts = [];
    for (const kind of ['savings', 'current']) for (const account of lists[kind]) { const a = readNtbAccount(kind, account, problems, ctx); if (a) accounts.push(a); }
    if (!accounts.length) return null;
    // Sections that carry money this reader does not file: never silently ignored.
    const overview = k => { for (const s of scripts) { const m = new RegExp(`\\b${k}\\s*=\\s*["']?(-?[\\d.,]+)["']?`).exec(s); if (m) return cents(m[1]); } return undefined; };
    for (const k of ['fixedDepositAmount', 'investmentAmount', 'loansAmount', 'leasingAmount']) { const v = overview(k); if (v && !Number.isNaN(v) && v !== 0) problems.push(`section-not-read:${k}`); }
    for (const [kind, key] of [['savings', 'savingsAmount'], ['current', 'currentAmount']]) {
        const printed = overview(key);
        if (printed !== undefined && !Number.isNaN(printed)) {
            const total = accounts.filter(a => a.kind === kind).reduce((s, a) => s + a.closing, 0);
            if (total !== printed) problems.push(`overview-${kind}-total-disagrees`);
        }
    }
    const period = periodOf(scripts);
    const rows = accounts.flatMap(a => a.rows);
    const lines = ['Nations Trust Bank', 'Consolidated Monthly Statement', period ? `Statement Period: ${period}` : ''];
    for (const a of accounts) {
        lines.push(`Account No: ${a.number}`, '@@ACCOUNT@@', `Opening Balance ${money2(a.opening)}`);
        for (const r of a.rows) lines.push(`${prettyDate(r.date)} ${r.narration}${r.ref ? ` REF:${r.ref}` : ''} ${r.amount.toFixed(2)} ${r.direction === 'credit' ? 'CR' : 'DR'}`);
        lines.push(`Closing Balance ${money2(a.closing)}`, '@@END@@');
    }
    const verified = !problems.length;
    const recon = {
        opening: fromCents(accounts.reduce((s, a) => s + a.opening, 0)), closing: fromCents(accounts.reduce((s, a) => s + a.closing, 0)),
        credits: fromCents(accounts.reduce((s, a) => s + a.credits, 0)), debits: fromCents(accounts.reduce((s, a) => s + a.debits, 0)), accounts: accounts.length,
    };
    recon.expected = fromCents(Math.round(recon.closing * 100)); recon.difference = 0; recon.ok = verified;
    return {
        recognized: true, verified, kind: 'ntb-consolidated', problems: [...new Set(problems)],
        result: {
            text: lines.filter(Boolean).join('\n'),
            parsed: {
                rows, layout: { accountLast4: accounts[0].number.slice(-4), embedded: 'ntb', accounts: accounts.length, ...(ctx.zeroSkipped ? { zeroAmountSkipped: ctx.zeroSkipped } : {}), ...(ctx.reordered ? { chainReordered: ctx.reordered } : {}) },
                reconciliation: recon, dateOrder: 'ascending', verdict: verified ? (rows.length ? 'parsed' : 'empty') : 'unverified', understood: verified && rows.length > 0,
                reason: verified ? (rows.length ? '' : 'This statement has no transactions on it.') : 'The bank\'s own figures for this statement do not agree with its rows.',
                moneyLines: rows.length, candidateRows: rows.length, invalidDates: 0, balanceMismatches: 0,
            },
            zeroActivity: verified && !rows.length, embedded: true,
        },
    };
}

// ── Nations Trust American Express card statement ───────────────────────────
function readAmex(html, scripts) {
    const s = scripts.find(t => /\bcardTransactionsDataList\s*=\s*\[/.test(t) && /\bcardTransactionsSummaryData\s*=\s*\{/.test(t));
    if (!s) return null;
    const problems = [];
    let summary, cards;
    try {
        const at = (name, open) => { const m = new RegExp(`\\b${name}\\s*=\\s*${open === '{' ? '\\{' : '\\['}`).exec(s); const start = m.index + m[0].length - 1; const end = balancedEnd(s, start); if (end < 0) throw new Refused('unbalanced'); return parseLiteral(s.slice(start, end)); };
        summary = at('cardTransactionsSummaryData', '{'); cards = at('cardTransactionsDataList', '[');
    } catch (e) { return { recognized: true, verified: false, kind: 'amex-card', problems: [e instanceof Refused ? `data-shape-unsupported:${e.message}` : 'data-unreadable'] }; }
    if (!Array.isArray(cards) || !cards.length) return { recognized: true, verified: false, kind: 'amex-card', problems: ['cards-missing'] };
    const cycle = summary.cycleDate || {};
    const cy = Number(cycle.year), cm = Number(cycle.monthValue), cd = Number(cycle.dayOfMonth);
    const cycleIso = isoOf(cy, cm, cd);
    if (!cycleIso) problems.push('statement-date-unreadable');
    const opening = cents(summary.openingBalance), closing = cents(summary.closingBalance);
    if (Number.isNaN(opening) || Number.isNaN(closing)) problems.push('balance-unreadable');
    // "13 JUL" has no year: the latest such date not after the statement date
    // (plus the few days a posting can trail it) is the one meant.
    const yearOf = (day, mon) => {
        if (!cycleIso) return '';
        const limit = Date.UTC(cy, cm - 1, cd) + 7 * 86400000;
        for (const y of [cy, cy - 1]) { const iso = isoOf(y, mon, day); if (iso && Date.parse(iso) <= limit) return iso; }
        return '';
    };
    const rows = [];
    let debits = 0, credits = 0;
    const seenCards = [];
    for (const card of cards) {
        const number = String(card.cardNo ?? '').replace(/[^\dXx*]/g, '');
        const last4 = number.replace(/\D/g, '').slice(-4);
        if (!/^\d{4}$/.test(last4)) problems.push('card-number-unreadable');
        seenCards.push(number);
        const list = card.consumerTransactions;
        if (!Array.isArray(list)) { problems.push('transactions-missing'); continue; }
        for (const t of list) {
            const m = /^(\d{1,2})\s+([A-Za-z]{3})/.exec(String(t.postDate ?? '').trim());
            const date = m && MONTHS[m[2].toLowerCase()] ? yearOf(Number(m[1]), MONTHS[m[2].toLowerCase()]) : '';
            const amount = cents(t.txConvertedAmount ?? t.txAmount);
            const dir = String(t.crDr ?? '').trim().toLowerCase();
            const description = decode(t.description);
            if (!date) { problems.push('date-unreadable'); continue; }
            if (Date.parse(date) < Date.UTC(cy, cm - 1, cd) - 50 * 86400000) problems.push('date-outside-period');
            if (Number.isNaN(amount) || amount < 0) { problems.push('amount-unreadable'); continue; }
            if (dir !== 'dr' && dir !== 'cr') { problems.push('direction-unclear'); continue; }
            if (!description) { problems.push('description-missing'); continue; }
            if (amount === 0) continue;
            if (dir === 'dr') debits += amount; else credits += amount;
            rows.push({ date, narration: description, amount: fromCents(amount), direction: dir === 'dr' ? 'debit' : 'credit', balance: null, valid: true, balanceVerified: false, directionSource: 'marker', needsReview: false, card_last4: last4 });
        }
    }
    if (!Number.isNaN(opening) && !Number.isNaN(closing) && opening - credits + debits !== closing) problems.push('balances-do-not-reconcile');
    // The bank also summarises the same rows by kind. That is corroboration, not
    // the proof (the opening/closing arithmetic above is), so it is recorded for
    // the diagnostics rather than allowed to block a statement whose rows are exact.
    const paid = cents(summary.payment), credited = cents(summary.credits);
    const kinds = ['purchases', 'cashAdvances', 'interest', 'charges'].map(k => cents(summary[k]));
    const summaryAgrees = {
        credits: ![paid, credited].some(Number.isNaN) ? paid + credited === credits : null,
        debits: kinds.every(v => !Number.isNaN(v)) ? kinds.reduce((s, v) => s + Math.abs(v), 0) === debits : null,
    };
    const period = (() => { for (const t of scripts) { const m = /\bstatementPeriod\s*=\s*["']\s*([^"']{6,60}?)\s*["']/.exec(t); if (m) return m[1]; } return ''; })();
    const last4 = rows[0]?.card_last4 || seenCards[0]?.replace(/\D/g, '').slice(-4) || '';
    const verified = !problems.length;
    const lines = ['Nations Trust Bank American Express', `Card No: ${seenCards[0] || ''}`, period ? `Statement Period: ${period}` : '',
        `Opening Balance ${Number.isNaN(opening) ? '' : money2(opening)}`, `Closing Balance ${Number.isNaN(closing) ? '' : money2(closing)}`, '@@ACCOUNT@@'];
    for (const r of rows) lines.push(`${prettyDate(r.date)} ${r.narration} ${r.amount.toFixed(2)} ${r.direction === 'credit' ? 'CR' : 'DR'}`);
    lines.push('@@END@@');
    return {
        recognized: true, verified, kind: 'amex-card', problems: [...new Set(problems)],
        result: {
            text: lines.filter(Boolean).join('\n'),
            parsed: {
                rows, layout: { accountLast4: last4, statementType: 'credit-card', embedded: 'amex', cards: cards.length, summaryAgrees },
                reconciliation: { opening: fromCents(opening), closing: fromCents(closing), credits: fromCents(credits), debits: fromCents(debits), expected: fromCents(closing), difference: 0, ok: verified, model: 'card' },
                dateOrder: 'ascending', verdict: verified ? (rows.length ? 'parsed' : 'empty') : 'unverified', understood: verified && rows.length > 0,
                reason: verified ? (rows.length ? '' : 'This statement has no transactions on it.') : 'The bank\'s own figures for this statement do not agree with its rows.',
                moneyLines: rows.length, candidateRows: rows.length, invalidDates: 0, balanceMismatches: 0,
            },
            zeroActivity: verified && !rows.length, embedded: true,
        },
    };
}

/**
 * Reads a decrypted Smart Statement from the data inside it.
 * null            — not a document this reader knows the shape of
 * {recognized, verified:false, problems} — known shape, but the bank's figures
 *                   do not add up (or a section is one this does not file)
 * {recognized, verified:true, result}    — every figure agrees to the cent
 */
export function readEmbeddedStatement(html) {
    if (typeof html !== 'string' || html.length < 200) return null;
    let scripts;
    try { scripts = scriptsOf(html); } catch { return null; }
    if (!scripts.length) return null;
    try { return readAmex(html, scripts) || readNtb(html, scripts); }
    catch (e) { return { recognized: true, verified: false, kind: 'unknown', problems: [e instanceof Refused ? `data-shape-unsupported:${e.message}` : 'data-unreadable'] }; }
}

/** The PDF the bank packs into the same document (base64, for its own "Download PDF" button), or null. */
export function embeddedPdfBytes(html) {
    try {
        for (const s of scriptsOf(html)) {
            const at = s.indexOf('pdfContent');
            if (at < 0) continue;
            const m = /pdfContent\s*=\s*["']\s*([A-Za-z0-9+/=\s]{64,})["']/.exec(s.slice(at, at + 12_000_000));
            if (m) { const bytes = Buffer.from(m[1].replace(/\s/g, ''), 'base64'); if (bytes.subarray(0, 5).toString() === '%PDF-') return bytes; }
        }
    } catch { /* no usable pdf */ }
    return null;
}

export const _internal = { parseLiteral, balancedEnd, cents };
