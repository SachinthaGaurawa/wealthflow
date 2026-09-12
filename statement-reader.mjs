import { readFile } from 'node:fs/promises';
import { createDecipheriv, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizeCloudLayout, validateCloudTemplate } from './statement-layout.mjs';

const derive = promisify(pbkdf2);
export const STATEMENT_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, pages: 100, rows: 5000, passwords: 1000 });
const fail = code => { const error = new Error(code); error.code = code; throw error; };
let trusted;
async function tools() {
    if (!trusted) trusted = Promise.all([
        readFile(new URL('./wealthflow-statement-parser.js', import.meta.url), 'utf8'),
        readFile(new URL('./wealthflow-html-statement.js', import.meta.url), 'utf8'),
        import('linkedom'),
    ]).then(([parser, html, { DOMParser }]) => {
        const context = vm.createContext({ window: {}, DOMParser, console: { log() {} } }, { codeGeneration: { strings: false, wasm: false } });
        // These are repository-owned readers. Attachment source is NEVER evaluated.
        vm.runInContext(parser, context, { timeout: 2000 });
        // Preserve repeated printed transactions in the server data adapter.
        // This change affects only the trusted helper's exported JSON reader.
        const adapter = html.replace('return _dedupe(_fromScripts(h));', 'return _fromScripts(h);');
        if (adapter === html) fail('HTML_READER_ADAPTER_UNAVAILABLE');
        vm.runInContext(adapter, context, { timeout: 2000 });
        return { context, DOMParser };
    });
    return trusted;
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
async function parse(text, htmlForData = '') {
    const { context } = await tools();
    context.inputText = text;
    context.inputHtml = htmlForData;
    try {
        let parsed = vm.runInContext('window.WFStatementParser.parseStatement(inputText)', context, { timeout: 2000 });
        if (!parsed.rows.length && htmlForData) {
            const data = vm.runInContext('window.WFHtmlStatement._layerScripts(inputHtml)', context, { timeout: 2000 });
            if (data.length > STATEMENT_LIMITS.rows) fail('STATEMENT_ROW_LIMIT');
            if (data.length) {
                const lines = data.map(r => `${r.date} ${r.narration} ${r.amount.toFixed(2)} ${r.direction === 'credit' ? 'CR' : 'DR'}`).join('\n');
                context.inputText = `${text}\n${lines}`;
                parsed = vm.runInContext('window.WFStatementParser.parseStatement(inputText)', context, { timeout: 2000 });
                // The legacy data reader can assume unmarked debit direction.
                // Require review until the layout has explicit evidence.
                parsed.verdict = 'unverified'; parsed.understood = false;
                parsed.reason = 'Embedded transaction data requires completeness verification.';
                parsed.layout ||= {};
                parsed.layout.embeddedRows = data.length;
                parsed.layout.explicitDirectionRows = data.filter(r => r.directionSource && r.directionSource !== 'assumed').length;
                parsed.layout.embeddedCompletenessVerified = false;
                text = context.inputText;
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
export async function readHtmlStatement(bytes, passwords = []) {
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
    const extracted = await htmlText(html);
    const result = await parse(extracted.text, html);
    if (extracted.invalidRows) {
        result.parsed.verdict = 'unverified'; result.parsed.understood = false;
        result.parsed.htmlIncompleteRows = extracted.invalidRows;
        result.parsed.reason = 'HTML transaction columns contain conflicting or incomplete evidence.';
    }
    return result;
}
export async function readPdfStatement(bytes, passwords = []) {
    const buffer = inputBytes(bytes);
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontDataUrl = fileURLToPath(new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')));
    const attempts = [undefined, ...keys(passwords)];
    for (const password of attempts) {
        let task;
        try {
            task = getDocument({ data: Uint8Array.from(buffer), password, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, standardFontDataUrl });
            const doc = await task.promise;
            if (doc.numPages > STATEMENT_LIMITS.pages) fail('STATEMENT_PAGE_LIMIT');
            const lines = [];
            let textLength = 0;
            for (let n = 1; n <= doc.numPages; n++) {
                const page = await doc.getPage(n);
                try {
                    const content = await page.getTextContent();
                    let line = '', y;
                    for (const item of content.items) {
                        if (typeof item.str !== 'string') continue;
                        textLength += item.str.length + 1;
                        if (textLength > STATEMENT_LIMITS.bytes) fail('STATEMENT_TEXT_LIMIT');
                        const nextY = item.transform?.[5];
                        if (line && y !== undefined && nextY !== undefined && Math.abs(y - nextY) > 2) { lines.push(line); line = ''; }
                        line += `${line ? ' ' : ''}${item.str}`; y = nextY;
                        if (item.hasEOL) { lines.push(line); line = ''; y = undefined; }
                    }
                    if (line) lines.push(line);
                } finally { page.cleanup(); }
            }
            return await parse(lines.join('\n'));
        } catch (error) {
            if (error?.name !== 'PasswordException') { if (error?.code) throw error; fail('PDF_UNREADABLE'); }
        } finally { if (task) await task.destroy().catch(() => {}); }
    }
    fail('PASSWORD_FAILED');
}
export async function readStatement({ bytes, filename = '', passwords = [], bank = '', layouts = [] }) {
    const value = inputBytes(bytes);
    let result;
    if (value.subarray(0, 5).toString() === '%PDF-') result = await readPdfStatement(value, passwords);
    else if (/\.html?$/i.test(filename) || /^\s*(?:<!doctype html|<html)/i.test(value.subarray(0, 1024).toString())) result = await readHtmlStatement(value, passwords);
    else fail('ATTACHMENT_TYPE_UNSUPPORTED');
    if (result.parsed.verdict === 'parsed' || result.parsed.htmlIncompleteRows || result.parsed.reason === 'Embedded transaction data requires completeness verification.' || !bank || !Array.isArray(layouts)) return result;
    // A template is a bounded date translation, never a replacement for the
    // common parser's financial reconciliation and direction checks.
    for (const saved of layouts.slice(0, 6)) {
        let template;
        try { template = validateCloudTemplate(saved, bank); } catch { continue; }
        const translated = await normalizeCloudLayout(result.text, template, bank);
        if (translated === result.text) continue;
        const candidate = await parse(translated);
        if (candidate.parsed.rows.length && candidate.parsed.verdict === 'parsed') {
            candidate.parsed.layout ||= {};
            candidate.parsed.layout.learnedTemplate = template.id;
            return { ...candidate, text: result.text };
        }
    }
    return result;
}
