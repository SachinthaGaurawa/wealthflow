import { readFile } from 'node:fs/promises';
import { createDecipheriv, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeCloudLayout, validateCloudTemplate } from './statement-layout.mjs';
import { readEmbeddedStatement, embeddedPdfBytes } from './statement-embedded.mjs';

const derive = promisify(pbkdf2);
export const STATEMENT_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, pages: 100, rows: 5000, passwords: 1000 });
const fail = code => { const error = new Error(code); error.code = code; throw error; };
let trustedSources;
async function tools() {
    if (!trustedSources) trustedSources = Promise.all([
        readFile(new URL('./wealthflow-statement-parser.js', import.meta.url), 'utf8'),
        readFile(new URL('./wealthflow-html-statement.js', import.meta.url), 'utf8'),
        import('linkedom'),
    ]).then(([parser, html, { DOMParser }]) => ({ parser, html, DOMParser }));
    const { parser, html, DOMParser } = await trustedSources;
    // Cache source modules, but isolate mutable input globals per parse.
    const context = vm.createContext({ window: {}, DOMParser, console: { log() {} } }, { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(parser, context, { timeout: 2000 });
    // Both exports feed rows into text lines that WFStatementParser.parseStatement()
    // re-parses, and that parser already has its own tested logic for keeping
    // two genuinely identical printed transactions distinct (see
    // statement_ledger_test.js: "does not erase legitimate repeated purchases
    // within one source"). Deduping here, one layer earlier, would drop the
    // second of two real same-day, same-amount transactions — a bank fee
    // charged twice, two identical purchases — before that logic ever saw it.
    let adapter = html.replace('return _dedupe(_fromScripts(h));', 'return _fromScripts(h);');
    if (adapter === html) fail('HTML_READER_ADAPTER_UNAVAILABLE');
    const adapter2 = adapter.replace('return _dedupe(_fromTextLines(h));', 'return _fromTextLines(h);');
    if (adapter2 === adapter) fail('HTML_READER_ADAPTER_UNAVAILABLE');
    adapter = adapter2;
    vm.runInContext(adapter, context, { timeout: 2000 });
    return { context, DOMParser };
}
function keys(passwords) {
    if (!Array.isArray(passwords) || passwords.length > STATEMENT_LIMITS.passwords) fail('INVALID_VAULT_KEYS');
    return [...new Set(passwords.filter(p => typeof p === 'string' && p.length > 0 && p.length <= 1024))];
}
function inputBytes(value) {
    if (!(value instanceof Uint8Array)) fail('INVALID_ATTACHMENT');
    if (!value.length || value.length > STATEMENT_LIMITS.bytes) fail('ATTACHMENT_SIZE_LIMIT');
    return Buffer.from(value);
}

/** Convert PDF.js items from object order to visual row/column order. */
export function pdfLinesFromItems(items, tolerance = 2) {
    const rows = [];
    const loose = [];
    for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
        if (!item || typeof item.str !== 'string' || !item.str.trim()) continue;
        const x = Number(item.transform?.[4]), y = Number(item.transform?.[5]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { loose.push({ index, text: item.str }); continue; }
        let row = rows.find(candidate => Math.abs(candidate.y - y) <= tolerance);
        if (!row) { row = { y, first: index, cells: [] }; rows.push(row); }
        row.cells.push({ x, index, text: item.str });
    }
    const visual = rows
        .sort((a, b) => b.y - a.y || a.first - b.first)
        .map(row => row.cells
            .sort((a, b) => a.x - b.x || a.index - b.index)
            .map(cell => cell.text.trim()).filter(Boolean).join(' '))
        .filter(Boolean);
    // Preserve unpositioned evidence in source order.
    visual.push(...loose.sort((a, b) => a.index - b.index).map(item => item.text.trim()).filter(Boolean));
    return visual;
}
// A consolidated statement carries one ledger per account. Reading them as one
// long ledger can never reconcile (account two does not open where account one
// closed), so each is read and reconciled against its OWN opening and closing
// balance, and the statement is only "parsed" when every one of them is.
async function parse(text, htmlForData = '') {
    const lines = String(text).split('\n');
    if (!lines.includes(SECTION_MARK)) {
        const whole = await parseWhole(text, htmlForData);
        whole.zeroActivity = movedNothing(whole.parsed);
        return whole;
    }
    // A statement with a ledger table is read from its ledger table(s) only: an
    // Overview line that happens to carry a date and an amount ("...Int.Pd to
    // 31-01-2026  0.69") is not a transaction.
    const head = [], chunks = [];
    let current = null, before = true;
    const pre = [];
    for (const line of lines) {
        if (line === SECTION_MARK) { current = []; chunks.push(current); before = false; }
        else if (line === SECTION_END) current = null;
        else { (current || head).push(line); if (before) pre.push(line); }
    }
    const context = head.filter(line => /statement period|statement date|nations trust bank|consolidated|monthly statement|american express|card\s*(?:no|number)|account\s*(?:no|number)|credit limit|minimum (?:payment|amount)/i.test(line)).slice(0, 12);
    // A summary printed above the table (a card statement's Opening / Closing
    // Balance) still belongs to a ledger that states none of its own. Only what
    // comes BEFORE the first ledger: a rewards block further down prints an
    // "Opening Balance" of its own.
    const summary = pre.filter(line => /^(?:opening|closing) balance\b/i.test(line));
    const parts = [];
    for (const chunk of chunks) {
        const own = chunk.some(line => /^(?:opening|closing) balance\b/i.test(line));
        parts.push(await parseWhole([...context, ...(own ? [] : summary), ...chunk].join('\n')));
    }
    const active = parts.filter(part => part.parsed.rows.length);
    // An account with no rows that nevertheless opened and closed on different
    // balances has lost money somewhere the reader did not see. Leaving it out of
    // the reconciliation would file the others and say nothing about it.
    const lost = parts.some(part => !part.parsed.rows.length && part.parsed.reconciliation?.ok === false);
    if (!active.length) {
        const idle = { ...parts[0], text, zeroActivity: parts.every(part => movedNothing(part.parsed)) };
        if (lost) { idle.parsed.verdict = 'unverified'; idle.parsed.understood = false; }
        return idle;
    }
    const withLost = result => {
        if (lost) { result.parsed.verdict = 'unverified'; result.parsed.understood = false; result.parsed.reason = 'An account on this statement changed balance but shows no transactions.'; }
        return result;
    };
    if (active.length === 1) return withLost({ parsed: active[0].parsed, text });
    const total = pick => active.reduce((sum, part) => sum + (Number(pick(part.parsed)) || 0), 0);
    const round = value => Math.round(value * 100) / 100;
    const recs = active.map(part => part.parsed.reconciliation || {});
    const parsed = JSON.parse(JSON.stringify(active[0].parsed));
    parsed.rows = active.flatMap(part => part.parsed.rows);
    if (parsed.rows.length > STATEMENT_LIMITS.rows) fail('STATEMENT_ROW_LIMIT');
    parsed.candidateRows = total(p => p.candidateRows);
    parsed.invalidDates = total(p => p.invalidDates);
    parsed.balanceMismatches = total(p => p.balanceMismatches);
    parsed.reconciliation = {
        opening: recs.every(r => r.opening != null) ? round(recs.reduce((a, r) => a + r.opening, 0)) : null,
        closing: recs.every(r => r.closing != null) ? round(recs.reduce((a, r) => a + r.closing, 0)) : null,
        credits: round(total(p => p.reconciliation?.credits)), debits: round(total(p => p.reconciliation?.debits)),
        expected: null, difference: null,
        ok: recs.every(r => r.ok === true) ? true : recs.some(r => r.ok === false) ? false : null,
        accounts: active.length,
    };
    const allParsed = active.every(part => part.parsed.verdict === 'parsed');
    parsed.verdict = allParsed ? 'parsed' : 'unverified';
    parsed.understood = allParsed;
    parsed.reason = allParsed ? '' : (active.find(part => part.parsed.verdict !== 'parsed')?.parsed.reason || '');
    parsed.layout = { ...(parsed.layout || {}), accounts: active.length };
    return withLost({ parsed, text });
}
// A statement whose own balances prove nothing moved: no transaction rows, no
// unreadable dates, and an opening balance equal to the closing one. Only such a
// statement may be closed as "no transactions this month" — a document the reader
// merely failed to read carries no balances to agree with each other.
function movedNothing(parsed) {
    const r = parsed?.reconciliation;
    return !!parsed && !parsed.rows.length && !parsed.invalidDates && !parsed.balanceMismatches
        && r?.ok === true && Number.isFinite(r.opening) && Number.isFinite(r.closing) && r.opening === r.closing;
}
async function parseWhole(text, htmlForData = '') {
    const { context } = await tools();
    context.inputText = text;
    context.inputHtml = htmlForData;
    try {
        let parsed = vm.runInContext('window.WFStatementParser.parseStatement(inputText)', context, { timeout: 2000 });
        // Merges rows found outside the primary <table>/plain-text reading into
        // inputText and re-parses, the same way regardless of which layer found
        // them. Neither layer below ever marks a statement understood: both can
        // assume an unmarked row's direction, so completeness always needs the
        // owner's eyes.
        const mergeEmbedded = (data, reason) => {
            if (data.length > STATEMENT_LIMITS.rows) fail('STATEMENT_ROW_LIMIT');
            if (!data.length) return false;
            const lines = data.map(r => `${r.date} ${r.narration} ${r.amount.toFixed(2)} ${r.direction === 'credit' ? 'CR' : 'DR'}`).join('\n');
            context.inputText = `${text}\n${lines}`;
            parsed = vm.runInContext('window.WFStatementParser.parseStatement(inputText)', context, { timeout: 2000 });
            parsed.verdict = 'unverified'; parsed.understood = false;
            parsed.reason = reason;
            parsed.layout ||= {};
            parsed.layout.embeddedRows = data.length;
            parsed.layout.explicitDirectionRows = data.filter(r => r.directionSource && r.directionSource !== 'assumed').length;
            parsed.layout.embeddedCompletenessVerified = false;
            text = context.inputText;
            return true;
        };
        if (!parsed.rows.length && htmlForData) {
            const scripted = vm.runInContext('window.WFHtmlStatement._layerScripts(inputHtml)', context, { timeout: 2000 });
            if (!mergeEmbedded(scripted, 'Embedded transaction data requires completeness verification.')) {
                // Neither a <table> layout the parser understood nor a script-
                // embedded data array existed. wealthflow-html-statement.js calls
                // this reading _layerText: one transaction per text line, or —
                // deliberately last, the loosest of the three — a flattened
                // date/description/amount scan for a <div> grid where no single
                // line holds a whole row. It already existed and is already
                // tested (test/estatement_parse_shapes_test.js) but nothing in
                // this file ever called it, so an export whose real transaction
                // dates are outside any <table> and never touch a <script> tag —
                // exactly what a "Consolidated eStatement" bank export can look
                // like — was unreadable to both the automatic pipeline and "Map
                // statement layout", which share this one function.
                const lined = vm.runInContext('window.WFHtmlStatement._layerText(inputHtml)', context, { timeout: 2000 });
                mergeEmbedded(lined, 'Statement rows were read line by line; verify before filing.');
            }
        }
        if (parsed.rows.length > STATEMENT_LIMITS.rows || parsed.candidateRows > STATEMENT_LIMITS.rows) fail('STATEMENT_ROW_LIMIT');
        parsed = JSON.parse(JSON.stringify(parsed));
        // "REF:S17616" appended by the column reader belongs in the row's own
        // reference, not in the description the owner will read in their ledger.
        for (const row of parsed.rows) {
            const ref = /\s*\bREF:(\S+)\s*$/.exec(row.narration || '');
            if (ref) { row.ref = ref[1]; row.narration = row.narration.slice(0, ref.index).trim(); }
        }
        const card = text.match(/(?:card|account)\s*(?:number|no\.?|#)?\s*[:\s]*([\dXx* -]{8,30})/i);
        parsed.layout ||= {};
        if (card) { const digits = card[1].replace(/\D/g, ''); if (digits.length >= 4) parsed.layout.accountLast4 = digits.slice(-4); }
        if (/american express|amex|credit card|cardholder|credit limit/i.test(headerText(text))) parsed.layout.statementType = 'credit-card';
        return { parsed, text };
    } finally { delete context.inputText; delete context.inputHtml; }
}
/* WHAT KIND OF STATEMENT IT IS is read from what the statement says about itself — never from a transaction line. A bank account's statement
 * with "CREDIT CARD PAYMENT" in one narration, or a "PAYMENT TO AMEX", is still a bank account's: reading the whole page called it a card statement,
 * and every debit became a card charge and every credit a card payment (the owner's income, gone). A transaction line carries a date AND an amount. */
const DATE_IN_LINE = /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{1,2}[\s-]+[A-Za-z]{3}[A-Za-z]*\.?(?:[\s-]+\d{2,4})?\b/;
const AMOUNT_IN_LINE = /\d[\d,]*\.\d{2}\b/;
export function headerText(text) {
    return String(text || '').split('\n').filter(line => !(DATE_IN_LINE.test(line) && AMOUNT_IN_LINE.test(line))).join('\n');
}
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// "Statement Period: 11-Jul-2026 to 10-Aug-2026" — the only place a table that
// prints "13 JUL" (no year) says which year it means.
function statementPeriodEnd(text) {
    const flat = String(text || '').replace(/\s+/g, ' ');
    const named = flat.match(/statement period\s*:?\s*\d{1,2}[-/ ][A-Za-z]{3}[A-Za-z]*[-/ ]\d{4}\s*(?:to|-|–|—)\s*(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})/i);
    const month = named && MONTH_INDEX[named[2].toLowerCase()];
    if (named && month !== undefined) return Date.UTC(Number(named[3]), month, Number(named[1]));
    // "Statement Period: 01-01-2026 to 31-01-2026", day first as printed locally.
    const numeric = flat.match(/statement period\s*:?\s*\d{1,2}[-/.]\d{1,2}[-/.]\d{4}\s*(?:to|-|–|—)\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/i);
    return numeric && Number(numeric[2]) >= 1 && Number(numeric[2]) <= 12 ? Date.UTC(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1])) : null;
}
// A yearless "13 JUL" becomes "13 Jul 2026": the latest such date that is not
// after the period's end, so a December row on a Dec–Jan statement stays in
// December of the earlier year. Anything else is returned untouched.
function withYear(cell, periodEnd) {
    const m = /^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*\.?$/.exec(String(cell || '').trim());
    const month = m && MONTH_INDEX[m[2].toLowerCase()];
    if (periodEnd === null || !m || month === undefined) return cell;
    const endYear = new Date(periodEnd).getUTCFullYear();
    // The year AFTER the period's end too: a December statement carries the 1 Jan interest posting.
    for (const year of [endYear + 1, endYear, endYear - 1]) {
        const at = Date.UTC(year, month, Number(m[1]));
        if (new Date(at).getUTCMonth() === month && at <= periodEnd + 7 * 86400000) return `${m[1]} ${m[2].slice(0, 3)} ${year}`;
    }
    return cell;
}
// Separates one account's ledger from the next in a consolidated statement, so
// each is reconciled against its OWN opening and closing balance.
const SECTION_MARK = '@@ACCOUNT@@';
const SECTION_END = '@@END@@';
const SUMMARY_LABEL = /^(?:opening balance|closing balance|previous balance|balance b\/f|balance c\/f|brought forward|carried forward)$/i;
const MONEY_ONLY = /^-?\(?\d[\d,]*(?:\.\d{1,2})?\)?(?:\s*(?:DR|CR))?$/i;
async function htmlText(html) {
    const { DOMParser } = await tools();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelectorAll('tr').length > STATEMENT_LIMITS.rows + 100) fail('STATEMENT_ROW_LIMIT');
    doc.querySelectorAll('script,style,noscript,iframe,object,embed,template,svg,canvas').forEach(n => n.remove());
    const periodEnd = statementPeriodEnd((doc.body || doc.documentElement)?.textContent);
    // Preserve column meaning before flattening the inert document. A running
    // balance or numeric reference must never become the transaction amount.
    let invalidRows = 0;
    // WHY rows were refused, by kind — counts only, so a statement that will not
    // file can say what it tripped on without ever quoting an amount or a name.
    const kinds = {};
    const bad = kind => { invalidRows++; kinds[kind] = (kinds[kind] || 0) + 1; };
    for (const table of doc.querySelectorAll('table')) {
        const rows = Array.from(table.querySelectorAll('tr')).filter(r => r.closest('table') === table);
        const cellTexts = row => Array.from(row.children).filter(n => /^(TD|TH)$/.test(n.tagName)).map(n => n.textContent.replace(/\s+/g, ' ').trim());
        // A direction column whose header is blank (a bare "Dr"/"Cr" after the
        // amount): recognised by what it holds, never by position.
        const inferMarker = from => {
            const body = rows.slice(from).map(cellTexts);
            const width = Math.max(0, ...body.map(cells => cells.length));
            for (let col = 0; col < width; col++) {
                const values = body.map(cells => cells[col]).filter(Boolean);
                if (values.length && values.every(v => /^(?:dr|cr|debit|credit)\.?$/i.test(v))) return col;
            }
            return -1;
        };
        let columns = null;
        let previousBalance = null, sumDebit = 0, sumCredit = 0;
        const lines = [];
        const money = raw => {
            const s = String(raw || '').trim();
            if (!s || /^[-–—]$/.test(s)) return 0;
            if (!/^(?:(?:LKR|Rs\.?)\s*)?\d+(?:,\d{3})*(?:\.\d{1,2})?\s*(?:DR|CR)?$/i.test(s)) return NaN;
            return Number(s.replace(/(?:LKR|Rs\.?|DR|CR)|[,\s]/gi, ''));
        };
        // A running balance may be overdrawn: "-2,500.00" or "(2,500.00)". An
        // amount never is — a negative amount is not a direction anyone printed.
        const balanceOf = raw => {
            const s = String(raw || '').trim(), paren = /^\((.*)\)$/.exec(s), neg = paren || /^[-−–]\s*\d/.test(s);
            const v = money(paren ? paren[1] : s.replace(/^[-−–]\s*/, ''));
            return neg && Number.isFinite(v) ? -v : v;
        };
        for (const [rowIndex, row] of rows.entries()) {
            const cells = cellTexts(row);
            const names = cells.map(s => s.toLowerCase().replace(/[^a-z]/g, ''));
            const index = pattern => names.findIndex(s => pattern.test(s));
            // The FIRST date column, so a "Post Date | Transaction Date" pair reads
            // the same date the device's upload reader does.
            const date = index(/^(?:transactiondate|txndate|postingdate|posteddate|postdate|date)$/);
            const description = index(/^(?:description|transactiondescription|transactiondetails|particulars|narration|merchant|details)$/);
            // "Amount" is the local-currency figure; "Transaction Amount" beside a
            // currency column is the foreign one (USD 5.00 -> LKR 1,769.93).
            const exactAmount = index(/^amount(?:lkr|rs)?$/);
            const amount = exactAmount >= 0 ? exactAmount : index(/^transactionamount$/);
            const debit = index(/^(?:debit|debits|withdrawal|withdrawals|debitamount)$/);
            const credit = index(/^(?:credit|credits|deposit|deposits|creditamount)$/);
            if (date >= 0 && description >= 0 && (amount >= 0 || (debit >= 0 && credit >= 0))) {
                if (!columns) lines.push(SECTION_MARK);
                columns = { date, description, amount, debit, credit,
                    marker: index(/^(?:drcr|crdr|direction|type)$/) >= 0 ? index(/^(?:drcr|crdr|direction|type)$/) : inferMarker(rowIndex + 1),
                    reference: index(/^(?:reference|referenceno|ref|refno|transactionreference)$/),
                    /* a column of its own for the cheque number (HNB, Sampath, DFCC print one): it is the cheque's number, kept in the narration where the Cheque Tracker reads it */
                    cheque: index(/^(?:cheque|chq|chk|check|cheq)s?(?:no|number|num|nr|ref|refno)?(?:ref|refno)?$/),
                    balance: index(/^(?:balance|runningbalance)$/) };
                continue;
            }
            if (!columns || !cells.length) { lines.push(cells.join(' ')); continue; }
            const c = columns;
            const dateCell = cells[c.date] || '';
            // The ledger's own "Total  91,832.86  67,806.90  32.93" row is not a
            // transaction — but it is the one place the bank states what the
            // rows above must add up to, so it is checked, not merely skipped.
            if (/^(?:total|sub\s*total|grand\s*total)\b/i.test(dateCell)) {
                const figures = cells.slice(1).map(balanceOf).filter(Number.isFinite);
                if (figures.length === 3 && c.debit >= 0 && c.credit > c.debit && c.balance > c.credit
                    && (Math.abs(sumDebit - figures[0]) > 0.011 || Math.abs(sumCredit - figures[1]) > 0.011
                        || (previousBalance !== null && Math.abs(previousBalance - figures[2]) > 0.011))) bad('total-row-disagrees');
                continue;
            }
            if (!dateCell) {
                // "B/F  24,058.89": the balance brought forward is the opening balance.
                if (c.balance >= 0 && /^(?:b\/?f|bal(?:ance)?\s*b\/?f|brought forward|opening balance)\.?$/i.test(cells[c.description] || '')) {
                    const opening = balanceOf(cells[c.balance]);
                    if (Number.isFinite(opening)) { lines.push(`Opening Balance ${opening.toFixed(2)}`); previousBalance = opening; continue; }
                }
                lines.push(cells.join(' ')); continue;
            }
            let value, direction = '';
            if (c.amount >= 0) {
                value = money(cells[c.amount]);
                const marker = `${cells[c.amount] || ''} ${cells[c.marker] || ''}`;
                const creditMarked = /\b(?:CR|credit)\b/i.test(marker), debitMarked = /\b(?:DR|debit)\b/i.test(marker);
                if (creditMarked !== debitMarked) direction = creditMarked ? 'CR' : 'DR';
            } else {
                const debitValue = money(cells[c.debit]), creditValue = money(cells[c.credit]);
                if (Number.isFinite(debitValue) && Number.isFinite(creditValue) && ((debitValue > 0) !== (creditValue > 0))) {
                    value = debitValue || creditValue; direction = debitValue > 0 ? 'DR' : 'CR';
                }
            }
            // A memo line that moves no money ("WTax.Pd 0.00", "Int.Pd 0.00") is
            // not a transaction, and a ledger cannot be wrong by leaving it out:
            // it adds nothing to either side. It is skipped ONLY while the running
            // balance agrees that nothing moved — a zero beside a changed balance
            // is a figure that went missing, and that still needs the owner.
            const zero = c.amount >= 0 ? value === 0
                : Number.isFinite(money(cells[c.debit])) && Number.isFinite(money(cells[c.credit])) && !money(cells[c.debit]) && !money(cells[c.credit]);
            if (zero) {
                const held = balanceOf(cells[c.balance]);
                if (c.balance >= 0 && cells[c.balance] && previousBalance !== null && Number.isFinite(held) && Math.abs(held - previousBalance) > 0.011) bad('zero-amount-balance-moved');
                else kinds.zeroAmountSkipped = (kinds.zeroAmountSkipped || 0) + 1;
                continue;
            }
            if (!Number.isFinite(value) || value <= 0 || !direction) {
                // Preserve the candidate and force review instead of silently
                // dropping a row or interpreting a conflicting column.
                bad(!Number.isFinite(value) ? 'amount-unreadable' : value <= 0 ? 'amount-not-positive' : 'direction-unclear');
                lines.push(cells.join(' '));
                continue;
            }
            if (c.balance >= 0 && cells[c.balance]) {
                const balance = balanceOf(cells[c.balance]);
                if (!Number.isFinite(balance)) bad('balance-unreadable');
                else {
                    // No B/F row: what the first row's own balance implies the
                    // opening was. Every later row is chained to the one before.
                    if (previousBalance === null) lines.push(`Opening Balance ${(direction === 'CR' ? balance - value : balance + value).toFixed(2)}`);
                    else if (Math.abs(balance - previousBalance - (direction === 'CR' ? value : -value)) > 0.011) bad('balance-chain-broken');
                    previousBalance = balance;
                }
            }
            if (direction === 'DR') sumDebit += value; else sumCredit += value;
            let narration = cells[c.description].replace(/\b(?:DR|CR)\b/gi, '').trim();
            /* the cheque number printed in its own column joins the narration unless the narration already says it ("0" and "-" in an empty cell are not numbers) */
            const chequeCell = c.cheque >= 0 ? String(cells[c.cheque] || '').trim() : '';
            const chequeDigits = (/^[\s#:.\-]*(\d{3,12})[\s]*$/.exec(chequeCell) || [])[1];
            if (chequeDigits && !narration.replace(/\D+/g, ' ').split(' ').includes(chequeDigits)) narration = `${narration} Cheque No ${chequeDigits}`.trim();
            const ref = c.reference >= 0 && cells[c.reference] ? ` REF:${cells[c.reference]}` : '';
            lines.push(`${withYear(dateCell, periodEnd)} ${narration}${ref} ${value.toFixed(2)} ${direction}`);
        }
        if (columns && previousBalance !== null) lines.push(`Closing Balance ${previousBalance.toFixed(2)}`);
        if (columns) lines.push(SECTION_END);
        if (columns) table.textContent = `\n${lines.join('\n')}\n`;
    }
    const blocks = new Set(['TR', 'DIV', 'P', 'BR', 'LI', 'H1', 'H2', 'H3', 'TABLE', 'SECTION']);
    const visit = node => {
        if (node.nodeType === 3) return node.textContent;
        let out = Array.from(node.childNodes || [], visit).join(node.tagName === 'TR' ? ' ' : '');
        return blocks.has(node.tagName) ? `\n${out}\n` : out;
    };
    const flat = visit(doc.documentElement || doc).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    // A summary printed as label and figure in two blocks ("Opening Balance" /
    // "177,324.65") is one line to the parser's balance check.
    const joined = [];
    for (let i = 0; i < flat.length; i++) {
        if (SUMMARY_LABEL.test(flat[i]) && MONEY_ONLY.test(flat[i + 1] || '')) joined.push(`${flat[i]} ${flat[++i]}`);
        else joined.push(flat[i]);
        if (flat[i] === SECTION_MARK) {
            // The account this ledger belongs to is printed just above it.
            for (let back = i - 1; back >= Math.max(0, i - 10); back--) {
                const number = /^\d{9,16}$/.exec(flat[back]);
                if (number) { joined.push(`Account No: ${number[0]}`); break; }
            }
        }
    }
    return { text: joined.join('\n'), invalidRows, kinds };
}
/** Decrypts (when needed) and returns the statement's HTML document itself. */
export async function openHtmlStatement(bytes, passwords = []) {
    let html;
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(inputBytes(bytes)); } catch (error) { if (error.code) throw error; fail('HTML_ENCODING_UNSUPPORTED'); }
    const { context } = await tools();
    context.inputHtml = html;
    let params, encrypted;
    try {
        encrypted = vm.runInContext('window.WFHtmlStatement.isEncryptedHtmlStatement(inputHtml)', context, { timeout: 1000 });
        if (encrypted) params = vm.runInContext('window.WFHtmlStatement._params(inputHtml)', context, { timeout: 1000 });
    } finally { delete context.inputHtml; }
    if (encrypted) {
        if (params.keySize !== 4 || !Number.isInteger(params.iterations) || params.iterations < 1 || params.iterations > 100000 || !/^[a-f\d]{32}$/i.test(params.salt) || !/^[a-f\d]{32}$/i.test(params.iv)) fail('HTML_ENCRYPTION_UNSUPPORTED');
        const payload = params.embedded.replace(/\s/g, '');
        if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(payload)) fail('HTML_ENVELOPE_INVALID');
        const ciphertext = Buffer.from(payload, 'base64');
        if (!ciphertext.length || ciphertext.length % 16 || ciphertext.length > STATEMENT_LIMITS.bytes) fail('HTML_ENVELOPE_INVALID');
        const candidates = keys(passwords);
        if (!candidates.length) fail('NO_VAULT_KEYS');
        let opened = '';
        for (const password of candidates) {
            const key = await derive(password, Buffer.from(params.salt, 'hex'), params.iterations, 16, 'sha1');
            try {
                const cipher = createDecipheriv('aes-128-cbc', key, Buffer.from(params.iv, 'hex'));
                const plain = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
                let decoded = new TextDecoder('utf-8', { fatal: true }).decode(plain);
                if (!/<(?:html|table|body|div|section|p)\b|<!doctype/i.test(decoded) && /^[A-Za-z\d+/=\s]+$/.test(decoded)) decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(decoded.replace(/\s/g, ''), 'base64'));
                if (/<(?:html|table|body|div|section|p)\b|<!doctype/i.test(decoded)) { opened = decoded; break; }
            } catch {} finally { key.fill(0); }
        }
        if (!opened) fail('PASSWORD_FAILED');
        html = opened;
    }
    return html;
}
async function parseHtmlDocument(html, passwords = []) {
    // The bank's own data first: exact dates, running balances and totals that must
    // agree to the cent, read without running the document. A statement it cannot
    // vouch for falls through to the drawn-table reader below, with the reason kept.
    const embedded = readEmbeddedStatement(html);
    if (embedded?.verified) {
        if (embedded.result.parsed.rows.length > STATEMENT_LIMITS.rows) fail('STATEMENT_ROW_LIMIT');
        if (embedded.result.zeroActivity === true) {
            // "Nothing moved" is the one conclusion that hides a whole month if it is wrong, so
            // it is held to a second, independent witness: the PDF the bank packs into the same
            // document. If that PDF lists transactions, the data and the PDF disagree — and a
            // statement where the bank contradicts itself goes to the owner, not to "empty".
            const evidence = { balances: 'agree', dataRows: 0, pdf: 'absent' };
            const pdf = embeddedPdfBytes(html);
            if (pdf) {
                try { evidence.pdf = (await readPdfStatement(pdf, passwords)).parsed.rows.length ? 'lists-transactions' : 'agrees'; }
                catch { evidence.pdf = 'unreadable'; }
            }
            if (evidence.pdf === 'lists-transactions') embedded.problems = [...(embedded.problems || []), 'pdf-lists-transactions'];
            else { embedded.result.emptyEvidence = evidence; return embedded.result; }
        } else return embedded.result;
    }
    const extracted = await htmlText(html);
    const result = await parse(extracted.text, html);
    if (extracted.invalidRows) markIncompleteHtml(result, extracted.invalidRows, extracted.kinds);
    else if (Object.keys(extracted.kinds).length) result.parsed.htmlReadNotes = extracted.kinds;
    if (embedded && embedded.problems?.length) result.parsed.embeddedProblems = embedded.problems.slice(0, 12);
    return result;
}
function markIncompleteHtml(result, invalidRows, kinds) {
    result.parsed.verdict = 'unverified'; result.parsed.understood = false;
    result.zeroActivity = false;
    result.parsed.htmlIncompleteRows = invalidRows;
    if (kinds) result.parsed.htmlIncompleteKinds = kinds;
    result.parsed.reason = 'HTML transaction columns contain conflicting or incomplete evidence.';
}
export async function readHtmlStatement(bytes, passwords = []) {
    return parseHtmlDocument(await openHtmlStatement(bytes, passwords), passwords);
}
/**
 * A Smart Statement draws its rows with its own JavaScript, which a serverless
 * function cannot run. The owner's device can (wealthflow-html-statement.js's
 * sandboxed renderer) and hands the rendered document back; this runs it through
 * exactly the same column-aware reading and validation as any other HTML
 * statement — nothing about the rendered rows is trusted more than a static
 * table's would be.
 */
export async function readRenderedHtml(html) {
    if (typeof html !== 'string' || !html.trim() || html.length > STATEMENT_LIMITS.bytes) fail('INVALID_ATTACHMENT');
    return parseHtmlDocument(html);
}
export async function readPdfStatement(bytes, passwords = []) {
    const buffer = inputBytes(bytes);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontDataUrl = fileURLToPath(new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')));
    const attempts = [undefined, ...keys(passwords)];
    for (const password of attempts) {
        let task;
        try {
            // verbosity: ERRORS (0) — this path only ever calls getTextContent(),
            // never render(), so pdfjs's Node canvas/DOMMatrix/Path2D polyfill
            // warnings and per-glyph "glyf table not found" recovery notices are
            // about a rendering path this code never takes; they were pure log
            // noise on every statement, not a sign extraction was degraded.
            task = getDocument({ data: Uint8Array.from(buffer), password, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, standardFontDataUrl, verbosity: 0 });
            const doc = await task.promise;
            if (doc.numPages > STATEMENT_LIMITS.pages) fail('STATEMENT_PAGE_LIMIT');
            const lines = [];
            let textLength = 0;
            for (let n = 1; n <= doc.numPages; n++) {
                const page = await doc.getPage(n);
                try {
                    const content = await page.getTextContent();
                    for (const item of content.items) {
                        if (typeof item.str !== 'string') continue;
                        textLength += item.str.length + 1;
                        if (textLength > STATEMENT_LIMITS.bytes) fail('STATEMENT_TEXT_LIMIT');
                    }
                    lines.push(...pdfLinesFromItems(content.items));
                } finally { page.cleanup(); }
            }
            return await parse(lines.join('\n'));
        } catch (error) {
            if (error?.name !== 'PasswordException') { if (error?.code) throw error; fail('PDF_UNREADABLE'); }
        } finally { if (task) await task.destroy().catch(() => {}); }
    }
    fail('PASSWORD_FAILED');
}
export async function readStatement({ bytes, filename = '', passwords = [], bank = '', layouts = [], confirmedTemplateId = '', rendered = null }) {
    const value = inputBytes(bytes);
    let result;
    if (value.subarray(0, 5).toString() === '%PDF-') result = await readPdfStatement(value, passwords);
    else if (/\.html?$/i.test(filename) || /^\s*(?:<!doctype html|<html)/i.test(value.subarray(0, 1024).toString())) {
        result = await readHtmlStatement(value, passwords);
        // Only a document this server could not read at all: a statement it
        // CAN read is never overridden by anything a client sent.
        if (!result.parsed.rows.length && typeof rendered?.text === 'string' && rendered.text.trim()) {
            result = await parse(rendered.text);
            result.renderedOverride = true;
            if (Number(rendered.incompleteRows) > 0) markIncompleteHtml(result, Number(rendered.incompleteRows));
            // Rows the layer scan or line scan recovered (never a real table)
            // were unverified when they were submitted; re-reading the
            // stored text alone must not quietly promote them to "parsed".
            else if (rendered.verified !== true) {
                // The owner was shown these exact rows and confirmed them
                // ("Yes, read it this way") — the same review an uploaded
                // statement gets. Every row's own date and running balance
                // must still check out, and each row still passes its own
                // settlement validation; only the statement-wide total is
                // waived, exactly as for a confirmed PDF layout below.
                if (rendered.confirmed === true && confirmedTemplateId && result.parsed.rows.length
                    && !result.parsed.invalidDates && !result.parsed.balanceMismatches) {
                    result.parsed.layout ||= {};
                    result.parsed.layout.learnedTemplate = confirmedTemplateId;
                    result.parsed.layout.reconciliationBypassed = true;
                    return result;
                }
                result.parsed.verdict = 'unverified'; result.parsed.understood = false; result.parsed.reason = 'Rendered statement rows need owner verification.';
            }
        }
    }
    else fail('ATTACHMENT_TYPE_UNSUPPORTED');
    if (result.parsed.verdict === 'parsed' || result.parsed.htmlIncompleteRows || result.parsed.reason === 'Embedded transaction data requires completeness verification.' || !bank || !Array.isArray(layouts)) return result;
    // A template is a bounded date translation, never a replacement for the
    // common parser's financial reconciliation and direction checks.
    const confirmed = confirmedTemplateId && layouts.find(saved => saved?._docId === confirmedTemplateId);
    const candidates = confirmed ? [confirmed, ...layouts.filter(saved => saved !== confirmed)] : layouts;
    for (const saved of candidates.slice(0, 6)) {
        let template;
        try { template = validateCloudTemplate(saved, bank); } catch { continue; }
        // mapReviewLayout() stores each confirmed template under a hash of
        // [bank, template.id] (statement-sync.js), never under template.id
        // alone, and stamps that same hash onto the source as
        // learnedTemplate/confirmedTemplateId. Comparing against the bare
        // structural id here made the confirmed-bypass below unreachable in
        // production: the id it was ever compared to was already a
        // different, hashed value. _docId carries the real key when the
        // caller has it (the only production caller, processOneStatement,
        // always does); tests that pass a bare template with no _docId fall
        // back to template.id so the non-bypass assertions keep working.
        const savedId = typeof saved?._docId === 'string' && saved._docId ? saved._docId : template.id;
        const translated = await normalizeCloudLayout(result.text, template, bank);
        if (translated === result.text) continue;
        const candidate = await parse(translated);
        if (candidate.parsed.rows.length && candidate.parsed.verdict === 'parsed') {
            candidate.parsed.layout ||= {};
            candidate.parsed.layout.learnedTemplate = savedId;
            return { ...candidate, text: result.text };
        }
        // The owner explicitly confirmed THIS exact reading for THIS exact
        // statement moments ago ("Map statement layout" -> "Yes"; the teach
        // screen already showed them whether it reconciled and let them
        // proceed anyway). Every row's own date and running balance still had
        // to check out (invalidDates/balanceMismatches both zero) — the only
        // thing left that can make verdict !== 'parsed' here is the
        // statement's single opening+credits-debits=closing total not
        // matching, which one unrelated fee line the reader never saw a
        // narration for is enough to cause. That is a reason to have a human
        // look, not a reason to throw away a correctly date-translated
        // statement and loop the owner back to the exact screen they just
        // confirmed. Every row below still passes through its own full
        // validateSettlementRow() checks regardless — this never files
        // anything by itself. An UNRELATED template (the six tried above,
        // opportunistically reused on some other statement from the same
        // bank) still requires the strict verdict.
        if (savedId === confirmedTemplateId && candidate.parsed.rows.length
            && !candidate.parsed.invalidDates && !candidate.parsed.balanceMismatches) {
            candidate.parsed.layout ||= {};
            candidate.parsed.layout.learnedTemplate = savedId;
            candidate.parsed.layout.reconciliationBypassed = true;
            return { ...candidate, text: result.text };
        }
    }
    return result;
}
