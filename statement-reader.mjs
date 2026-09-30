import { readFile } from 'node:fs/promises';
import { createDecipheriv, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeCloudLayout, validateCloudTemplate } from './statement-layout.mjs';

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
async function parse(text, htmlForData = '') {
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
        const card = text.match(/(?:card|account)\s*(?:number|no\.?|#)?\s*[:\s]*([\dXx* -]{8,30})/i);
        parsed.layout ||= {};
        if (card) { const digits = card[1].replace(/\D/g, ''); if (digits.length >= 4) parsed.layout.accountLast4 = digits.slice(-4); }
        if (/american express|amex|credit card|cardholder|credit limit/i.test(text)) parsed.layout.statementType = 'credit-card';
        return { parsed, text };
    } finally { delete context.inputText; delete context.inputHtml; }
}
async function htmlText(html) {
    const { DOMParser } = await tools();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelectorAll('tr').length > STATEMENT_LIMITS.rows + 100) fail('STATEMENT_ROW_LIMIT');
    doc.querySelectorAll('script,style,noscript,iframe,object,embed,template,svg,canvas').forEach(n => n.remove());
    // Preserve column meaning before flattening the inert document. A running
    // balance or numeric reference must never become the transaction amount.
    let invalidRows = 0;
    for (const table of doc.querySelectorAll('table')) {
        const rows = Array.from(table.querySelectorAll('tr')).filter(r => r.closest('table') === table);
        let columns = null;
        let previousBalance = null;
        const lines = [];
        for (const row of rows) {
            const cells = Array.from(row.children).filter(n => /^(TD|TH)$/.test(n.tagName)).map(n => n.textContent.replace(/\s+/g, ' ').trim());
            const names = cells.map(s => s.toLowerCase().replace(/[^a-z]/g, ''));
            const index = pattern => names.findIndex(s => pattern.test(s));
            const date = index(/^(?:transactiondate|postingdate|posteddate|date)$/);
            const description = index(/^(?:description|transactiondescription|particulars|narration|merchant|details)$/);
            const amount = index(/^(?:amount|transactionamount)$/);
            const debit = index(/^(?:debit|debits|withdrawal|withdrawals|debitamount)$/);
            const credit = index(/^(?:credit|credits|deposit|deposits|creditamount)$/);
            if (date >= 0 && description >= 0 && (amount >= 0 || (debit >= 0 && credit >= 0))) {
                columns = { date, description, amount, debit, credit,
                    marker: index(/^(?:drcr|crdr|direction|type)$/),
                    reference: index(/^(?:reference|referenceno|ref|refno|transactionreference)$/),
                    balance: index(/^(?:balance|runningbalance)$/) };
                continue;
            }
            if (!columns || !cells.length) { lines.push(cells.join(' ')); continue; }
            const c = columns;
            if (!cells[c.date]) { lines.push(cells.join(' ')); continue; }
            const money = raw => {
                const s = String(raw || '').trim();
                if (!s || /^[-–—]$/.test(s)) return 0;
                if (!/^(?:(?:LKR|Rs\.?)\s*)?\d+(?:,\d{3})*(?:\.\d{1,2})?\s*(?:DR|CR)?$/i.test(s)) return NaN;
                return Number(s.replace(/(?:LKR|Rs\.?|DR|CR)|[,\s]/gi, ''));
            };
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
            if (!Number.isFinite(value) || value <= 0 || !direction) {
                // Preserve the candidate and force review instead of silently
                // dropping a row or interpreting a conflicting column.
                invalidRows++;
                lines.push(cells.join(' '));
                continue;
            }
            if (c.balance >= 0 && cells[c.balance]) {
                const balance = money(cells[c.balance]);
                if (!Number.isFinite(balance)) invalidRows++;
                else {
                    if (previousBalance !== null && Math.abs(balance - previousBalance - (direction === 'CR' ? value : -value)) > 0.011) invalidRows++;
                    previousBalance = balance;
                }
            }
            const narration = cells[c.description].replace(/\b(?:DR|CR)\b/gi, '').trim();
            const ref = c.reference >= 0 && cells[c.reference] ? ` REF:${cells[c.reference]}` : '';
            lines.push(`${cells[c.date]} ${narration}${ref} ${value.toFixed(2)} ${direction}`);
        }
        if (columns) table.textContent = `\n${lines.join('\n')}\n`;
    }
    const blocks = new Set(['TR', 'DIV', 'P', 'BR', 'LI', 'H1', 'H2', 'H3', 'TABLE', 'SECTION']);
    const visit = node => {
        if (node.nodeType === 3) return node.textContent;
        let out = Array.from(node.childNodes || [], visit).join(node.tagName === 'TR' ? ' ' : '');
        return blocks.has(node.tagName) ? `\n${out}\n` : out;
    };
    return { text: visit(doc.documentElement || doc).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'), invalidRows };
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
async function parseHtmlDocument(html) {
    const extracted = await htmlText(html);
    const result = await parse(extracted.text, html);
    if (extracted.invalidRows) markIncompleteHtml(result, extracted.invalidRows);
    return result;
}
function markIncompleteHtml(result, invalidRows) {
    result.parsed.verdict = 'unverified'; result.parsed.understood = false;
    result.parsed.htmlIncompleteRows = invalidRows;
    result.parsed.reason = 'HTML transaction columns contain conflicting or incomplete evidence.';
}
export async function readHtmlStatement(bytes, passwords = []) {
    return parseHtmlDocument(await openHtmlStatement(bytes, passwords));
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
