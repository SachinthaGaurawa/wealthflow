/* =============================================================================
 * tenant-pdf.mjs — a person's statement as a PDF they can keep, print or forward
 * -----------------------------------------------------------------------------
 * Built from the SAME object the statement page shows (tenant-statement.mjs): the PDF has no way to ask for
 * more than the page does, so nothing private can reach a file that a phone will store and a person may send
 * on. It carries figures, dates, reference codes and the lender's payment details, under the same rules.
 *
 * WHY A WRITER OF OUR OWN. The deployment has no PDF library and a function that renders a handful of tables
 * does not justify one: this file writes PDF 1.4 directly (Helvetica and Helvetica-Bold, two of the fourteen
 * fonts every reader has, so nothing is embedded and the file is a few kilobytes), Flate-compressed pages, a
 * correct cross-reference table, a document title and page numbers ("Page 2 of 3") on every page.
 *
 * WHAT IT CANNOT DO, and says so rather than guessing: the standard fonts have no Sinhala, Tamil, Arabic or
 * CJK glyphs. Text is reduced to the letters those fonts have (accents are dropped, é -> e), anything else
 * prints as "?", never as a broken file. Account details are best entered in English letters and digits.
 *
 * Pure: no clock (`generatedAt` is passed), no network, no files. Returns a Buffer.
 * ===========================================================================*/

import zlib from 'node:zlib';
import { fmtMoney, fmtDay } from './sms-templates.mjs';

/* ── metrics: the advance width of every printable ASCII character, in 1/1000 em (the fonts' own AFM files) ─── */

const HELVETICA = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,         // space ! " # $ % & ' ( ) * + , - . /
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,         // 0-9 : ; < = > ?
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,        // @ A-O
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,         // P-Z [ \ ] ^ _
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,         // ` a-o
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,              // p-z { | } ~
];
const HELVETICA_BOLD = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Punctuation people paste in that has a plain equivalent in the standard fonts. */
const PUNCT = { '‘': "'", '’': "'", '‚': ',', '“': '"', '”': '"', '–': '-', '—': '-', '−': '-', '…': '...', '•': '*', ' ': ' ', '​': '', '‎': '', '‏': '' };

/** What the fonts can print: ASCII. Accents are dropped (é -> e), plain-equivalent punctuation is kept, anything else becomes "?". */
export function pdfText(value) {
    const raw = String(value == null ? '' : value);
    let out = '';
    for (const ch of raw.normalize('NFKD')) {
        const code = ch.codePointAt(0);
        if (code >= 0x300 && code <= 0x36F) continue;                          // a combining accent: the letter before it stays
        if (PUNCT[ch] !== undefined) out += PUNCT[ch];
        else if (code === 9 || code === 10 || code === 13) out += ' ';
        else if (code >= 32 && code <= 126) out += ch;
        else if (code < 32 || code === 127 || (code >= 0xD800 && code <= 0xDFFF)) continue;
        else out += '?';
    }
    return out.replace(/ {2,}/g, ' ');
}

/** Width of already-sanitised text, in points. */
export function textWidth(text, bold, size) {
    const table = bold ? HELVETICA_BOLD : HELVETICA;
    let units = 0;
    for (const ch of String(text)) { const i = ch.charCodeAt(0) - 32; units += i >= 0 && i < table.length ? table[i] : table[0]; }
    return (units * size) / 1000;
}

/** Greedy word wrap to a width; a single word longer than the line is broken where it must be. */
export function wrapText(text, bold, size, maxWidth) {
    const words = pdfText(text).split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    const push = () => { if (line) lines.push(line); line = ''; };
    for (let word of words) {
        while (textWidth(word, bold, size) > maxWidth) {
            // cut the word at the longest piece that fits
            let cut = word.length - 1;
            while (cut > 1 && textWidth(word.slice(0, cut), bold, size) > maxWidth) cut -= 1;
            push();
            lines.push(word.slice(0, cut));
            word = word.slice(cut);
        }
        const next = line ? `${line} ${word}` : word;
        if (line && textWidth(next, bold, size) > maxWidth) { push(); line = word; } else line = next;
    }
    push();
    return lines.length ? lines : [''];
}

/* ── the page ─────────────────────────────────────────────────────────────── */

export const PAGE = Object.freeze({ w: 595.28, h: 841.89, margin: 42, footerH: 46 });
const CONTENT_W = PAGE.w - 2 * PAGE.margin;

const rgb = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const COLOR = { navy: rgb('#0a0e1a'), gold: rgb('#d4af37'), ink: rgb('#1b2233'), mute: rgb('#5f6b80'), line: rgb('#d5dae3'), band: rgb('#eef1f6'), green: rgb('#0b7a55'), white: rgb('#ffffff'), soft: rgb('#c6cddb') };

const n2 = (v) => (Math.round(v * 100) / 100).toString();
const esc = (t) => t.replace(/[\\()]/g, (c) => `\\${c}`);

class Canvas {
    constructor() { this.pages = []; this.ops = null; this.y = 0; this.newPage(); }
    newPage() { this.ops = []; this.pages.push(this.ops); this.y = PAGE.margin; }
    get room() { return PAGE.h - PAGE.footerH - this.y; }
    /** Moves to a new page unless `h` more points fit. Returns true when it did. */
    ensure(h) { if (this.room >= h) return false; this.newPage(); return true; }
    rect(x, top, w, h, color, mode = 'f') {
        const [r, g, b] = color;
        const op = mode === 's' ? `${n2(r)} ${n2(g)} ${n2(b)} RG 0.6 w ${n2(x)} ${n2(PAGE.h - top - h)} ${n2(w)} ${n2(h)} re S` : `${n2(r)} ${n2(g)} ${n2(b)} rg ${n2(x)} ${n2(PAGE.h - top - h)} ${n2(w)} ${n2(h)} re f`;
        this.ops.push(op);
    }
    hline(x1, x2, top, color, width = 0.5) {
        const [r, g, b] = color;
        this.ops.push(`${n2(r)} ${n2(g)} ${n2(b)} RG ${n2(width)} w ${n2(x1)} ${n2(PAGE.h - top)} m ${n2(x2)} ${n2(PAGE.h - top)} l S`);
    }
    /** One line of text whose baseline is `base` points from the top. align: 'l' | 'r' | 'c' about x. */
    text(x, base, str, { size = 10, bold = false, color = COLOR.ink, align = 'l' } = {}) {
        const t = pdfText(str);
        if (!t) return;
        const w = textWidth(t, bold, size);
        const px = align === 'r' ? x - w : align === 'c' ? x - w / 2 : x;
        const [r, g, b] = color;
        this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${n2(size)} Tf ${n2(r)} ${n2(g)} ${n2(b)} rg ${n2(px)} ${n2(PAGE.h - base)} Td (${esc(t)}) Tj ET`);
    }
}

const timeOf = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return ''; const d = new Date(t + 330 * 60000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const dayOf = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? fmtDay(new Date(t + 330 * 60000).toISOString()) : ''; };
const month = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(String(ym || '')); return m ? fmtDay(`${m[1]}-${m[2]}-01`).slice(3) : '-'; };
const day = (iso) => fmtDay(iso) || '-';
const FREQ = { monthly: 'Monthly', quarterly: 'Every 3 months', annual: 'Yearly' };
const LOAN_EVENT = { lent: 'Loan paid out', further: 'Further advance', repayment: 'Repayment' };
const STATUS = { settled: 'Settled', closed: 'Closed', open: 'Open' };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/* ── drawing the parts ────────────────────────────────────────────────────── */

function header(c, st) {
    const bandH = 78;
    c.rect(0, 0, PAGE.w, bandH, COLOR.navy);
    c.text(PAGE.margin, 36, 'WEALTHFLOW', { size: 19, bold: true, color: COLOR.gold });
    c.text(PAGE.margin, 56, 'Statement of account', { size: 11, color: COLOR.soft });
    c.text(PAGE.w - PAGE.margin, 36, `As at ${dayOf(st.asOf)}`, { size: 12, bold: true, color: COLOR.white, align: 'r' });
    c.text(PAGE.w - PAGE.margin, 56, `${timeOf(st.asOf)}, Sri Lanka time`, { size: 9, color: COLOR.soft, align: 'r' });
    c.y = bandH + 24;
    const intro = 'Every investment and loan your lender records for you is listed here under a reference code. Quote the code when you contact your lender or make a payment.';
    for (const line of wrapText(intro, false, 9.5, CONTENT_W)) { c.text(PAGE.margin, c.y, line, { size: 9.5, color: COLOR.mute }); c.y += 13; }
    c.y += 8;
}

function sectionTitle(c, text, sub) {
    c.ensure(46);
    c.text(PAGE.margin, c.y + 11, text, { size: 13, bold: true, color: COLOR.ink });
    if (sub) c.text(PAGE.w - PAGE.margin, c.y + 11, sub, { size: 9, bold: true, color: COLOR.mute, align: 'r' });
    c.hline(PAGE.margin, PAGE.w - PAGE.margin, c.y + 19, COLOR.gold, 1.2);
    c.y += 30;
}

function summary(c, st) {
    const totals = Array.isArray(st.totals) ? st.totals : [];
    const groups = Array.isArray(st.groups) ? st.groups : [];
    if (!totals.length) return;
    sectionTitle(c, 'Summary');
    for (const t of totals) {
        const mine = groups.filter((g) => g.currency === t.currency);
        const boxes = [];
        if (mine.some((g) => g.kind === 'investment')) boxes.push(['Invested', fmtMoney(t.invested, t.currency)], ['Interest received', fmtMoney(t.interestReceived, t.currency)]);
        if (mine.some((g) => g.kind === 'loan')) boxes.push(['Loan outstanding', fmtMoney(t.loanOutstanding, t.currency)]);
        if (!boxes.length) continue;
        c.ensure(58);
        const gap = 8;
        const w = (CONTENT_W - gap * (boxes.length - 1)) / boxes.length;
        boxes.forEach(([label, figure], i) => {
            const x = PAGE.margin + i * (w + gap);
            c.rect(x, c.y, w, 44, COLOR.band);
            c.text(x + 10, c.y + 15, label.toUpperCase(), { size: 7, bold: true, color: COLOR.mute });
            c.text(x + 10, c.y + 33, figure, { size: figure.length > 20 ? 10 : 12, bold: true, color: COLOR.ink });
        });
        c.y += 54;
    }
    c.y += 4;
}

/** Label/value pairs in two columns. */
function facts(c, pairs) {
    const colW = CONTENT_W / 2;
    for (let i = 0; i < pairs.length; i += 2) {
        c.ensure(32);
        for (let k = 0; k < 2; k += 1) {
            const p = pairs[i + k];
            if (!p) continue;
            const x = PAGE.margin + k * colW;
            c.text(x, c.y + 8, p[0].toUpperCase(), { size: 7, bold: true, color: COLOR.mute });
            c.text(x, c.y + 22, p[1], { size: 10.5, bold: true, color: p[2] || COLOR.ink });
        }
        c.y += 32;
    }
}

/**
 * A table: columns are { label, w (share of the width), right? }. Rows are arrays of strings. The header repeats on a new page; a row is never split.
 */
function table(c, caption, cols, rows) {
    const total = cols.reduce((a, k) => a + k.w, 0);
    const widths = cols.map((k) => (k.w / total) * CONTENT_W);
    const rowH = 17;
    const head = () => {
        c.rect(PAGE.margin, c.y, CONTENT_W, rowH + 1, COLOR.band);
        let x = PAGE.margin;
        cols.forEach((k, i) => { c.text(k.right ? x + widths[i] - 6 : x + 6, c.y + 12, k.label.toUpperCase(), { size: 7, bold: true, color: COLOR.mute, align: k.right ? 'r' : 'l' }); x += widths[i]; });
        c.y += rowH + 1;
    };
    c.ensure(rowH * 3 + 16);
    c.text(PAGE.margin, c.y + 8, caption.toUpperCase(), { size: 7, bold: true, color: COLOR.mute });
    c.y += 14;
    head();
    for (const r of rows) {
        if (c.ensure(rowH + 2)) head();
        let x = PAGE.margin;
        r.forEach((cell, i) => { c.text(cols[i].right ? x + widths[i] - 6 : x + 6, c.y + 12, cell, { size: 9, align: cols[i].right ? 'r' : 'l' }); x += widths[i]; });
        c.hline(PAGE.margin, PAGE.w - PAGE.margin, c.y + rowH, COLOR.line, 0.4);
        c.y += rowH;
    }
    c.y += 8;
}

function note(c, text) {
    c.ensure(20);
    c.text(PAGE.margin, c.y + 10, text, { size: 9, color: COLOR.mute });
    c.y += 20;
}

function recordHead(c, g, many) {
    c.ensure(96);
    const kind = g.kind === 'loan' ? 'Loan' : 'Investment';
    c.rect(PAGE.margin, c.y, CONTENT_W, 24, COLOR.navy);
    c.text(PAGE.margin + 10, c.y + 16, kind, { size: 11, bold: true, color: COLOR.white });
    const tag = [many && g.lender ? `Lender ${g.lender}` : '', g.kind === 'loan' && STATUS[g.status] ? STATUS[g.status] : '', g.ref].filter(Boolean).join('   |   ');
    c.text(PAGE.w - PAGE.margin - 10, c.y + 16, tag, { size: 8.5, bold: true, color: COLOR.gold, align: 'r' });
    c.y += 34;
}

function investment(c, g, many) {
    const cur = g.currency;
    recordHead(c, g, many);
    const pairs = [
        ['Capital', fmtMoney(g.capital, cur)],
        ['Rate', `${num(g.ratePct)}% a year`],
        ['Interest paid', FREQ[g.frequency] || FREQ.monthly],
        ['Interest each time', fmtMoney(g.interestPerPeriod, cur)],
        ['Started', day(g.start)],
        g.end ? ['Ends', day(g.end)] : null,
        g.nextInterest ? ['Next interest due', `${day(g.nextInterest.date)}  (${fmtMoney(g.nextInterest.amount, cur)})`] : null,
        ['Interest received so far', fmtMoney(g.totalReceived, cur), COLOR.green],
    ].filter(Boolean);
    facts(c, pairs);
    const pays = Array.isArray(g.payments) ? g.payments : [];
    if (pays.length) table(c, `Payments received, in ${cur}`, [{ label: 'For', w: 3 }, { label: 'Received on', w: 3 }, { label: 'Amount', w: 3, right: true }], pays.map((p) => [month(p.month), day(p.date), fmtMoney(p.amount, cur).slice(4)]));
    else note(c, 'No payments recorded yet.');
    c.y += 6;
}

function loan(c, g, many) {
    const cur = g.currency;
    recordHead(c, g, many);
    const late = num(g.overdueDays);
    const pairs = [
        ['Paid out', fmtMoney(g.lent, cur)],
        ['Repaid', fmtMoney(g.repaid, cur)],
        ['Outstanding', fmtMoney(g.outstanding, cur), g.outstanding > 0 ? COLOR.ink : COLOR.green],
        g.due ? ['Expected back by', late > 0 ? `${day(g.due)}  (${late} day${late === 1 ? '' : 's'} ago)` : day(g.due)] : null,
    ].filter(Boolean);
    facts(c, pairs);
    const events = Array.isArray(g.events) ? g.events : [];
    if (events.length) table(c, `Movements, in ${cur}`, [{ label: 'Date', w: 3 }, { label: 'What', w: 4 }, { label: 'Amount', w: 3, right: true }, { label: 'Balance', w: 3, right: true }], events.map((e) => [day(e.date), LOAN_EVENT[e.kind] || '-', fmtMoney(e.amount, cur).slice(4), fmtMoney(e.balance, cur).slice(4)]));
    else note(c, 'Nothing recorded yet.');
    c.y += 6;
}

/** One account in a box; the account number is the largest thing in it, because it is the one that gets copied. */
function accountLayout(a) {
    const rows = [['Account name', a.holder], ['Account number', a.number, true], a.branch ? ['Branch', a.branch] : null, a.swift ? ['SWIFT / IBAN', a.swift] : null].filter(Boolean);
    const noteLines = a.note ? wrapText(a.note, false, 9, CONTENT_W - 28) : [];
    return { rows, noteLines, h: 30 + rows.length * 22 + (noteLines.length ? 8 + noteLines.length * 12 : 0) + 8 };
}

function account(c, a) {
    const { rows, noteLines, h } = accountLayout(a);
    c.ensure(h + 8);
    c.rect(PAGE.margin, c.y, CONTENT_W, h, COLOR.band);
    c.rect(PAGE.margin, c.y, 3, h, COLOR.gold);
    c.text(PAGE.margin + 14, c.y + 20, a.bank, { size: 12, bold: true });
    let y = c.y + 30;
    for (const [label, value, big] of rows) {
        c.text(PAGE.margin + 14, y + 9, label.toUpperCase(), { size: 7, bold: true, color: COLOR.mute });
        c.text(PAGE.margin + 130, y + 10, value, { size: big ? 12 : 10, bold: true });
        y += 22;
    }
    if (noteLines.length) { y += 4; for (const line of noteLines) { c.text(PAGE.margin + 14, y + 9, line, { size: 9, color: COLOR.mute }); y += 12; } }
    c.y += h + 10;
}

function payment(c, st) {
    const lenders = Array.isArray(st.lenders) ? st.lenders : [];
    if (!lenders.length) return;
    const groups = Array.isArray(st.groups) ? st.groups : [];
    const many = num(st.lenderCount) > 1;
    // the heading never sits alone at the foot of a page: it travels with its first account
    c.ensure(30 + 34 + 24 + accountLayout(lenders[0].accounts[0]).h + 8);
    sectionTitle(c, 'How to pay');
    const lead = 'Pay by bank transfer to the account below and put the reference of the record in the transfer. If the account details here look different from what your lender told you, check with your lender before sending money.';
    for (const line of wrapText(lead, false, 9.5, CONTENT_W)) { c.ensure(14); c.text(PAGE.margin, c.y + 10, line, { size: 9.5, color: COLOR.mute }); c.y += 13; }
    c.y += 8;
    for (const l of lenders) {
        const refs = groups.filter((g) => g.lender === l.n).map((g) => g.ref);
        if (many) { c.ensure(40); c.text(PAGE.margin, c.y + 10, `Lender ${l.n}`, { size: 11, bold: true }); c.y += 18; }
        if (refs.length) {
            const shown = refs.slice(0, 6).join(', ') + (refs.length > 6 ? ` and ${refs.length - 6} more` : '');
            for (const line of wrapText(`References: ${shown}`, true, 9, CONTENT_W)) { c.ensure(14); c.text(PAGE.margin, c.y + 10, line, { size: 9, bold: true, color: COLOR.ink }); c.y += 12; }
            c.y += 6;
        }
        for (const a of l.accounts) account(c, a);
    }
}

/* ── the file ─────────────────────────────────────────────────────────────── */

const pdfDate = (ms) => { const d = new Date(ms); const p = (n, w = 2) => String(n).padStart(w, '0'); return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; };

/**
 * @param {object} statement what buildStatement returned
 * @param {{generatedAt:number}} opts
 * @returns {Buffer} a complete PDF file
 */
export function statementPdf(statement, { generatedAt } = {}) {
    const raw = statement && typeof statement === 'object' ? statement : {};
    // only ever draws what has the shape of a record: a damaged entry is skipped, never allowed to take the download down
    const objects = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
    const st = { ...raw, groups: objects(raw.groups), totals: objects(raw.totals), lenders: objects(raw.lenders).filter((l) => Array.isArray(l.accounts) && l.accounts.length).map((l) => ({ ...l, accounts: objects(l.accounts) })).filter((l) => l.accounts.length) };
    const groups = st.groups;
    const made = Number.isFinite(Number(generatedAt)) ? Number(generatedAt) : Date.parse(st.asOf) || 0;
    const many = num(st.lenderCount) > 1;

    const c = new Canvas();
    header(c, st);
    if (!groups.length) {
        note(c, 'There is nothing to show yet. When your lender records something for you, it will appear here.');
    } else {
        summary(c, st);
        const inv = groups.filter((g) => g.kind === 'investment');
        const loans = groups.filter((g) => g.kind === 'loan');
        // a heading over a single record only repeats the record's own bar
        if (inv.length) { if (inv.length > 1) sectionTitle(c, 'Investments', `${inv.length} records`); inv.forEach((g) => investment(c, g, many)); }
        if (loans.length) { if (loans.length > 1) sectionTitle(c, 'Loans', `${loans.length} records`); loans.forEach((g) => loan(c, g, many)); }
        payment(c, st);
    }
    if (st.truncated) note(c, 'This statement is long, so only the first part is shown.');
    c.ensure(40);
    for (const line of wrapText('Figures are as recorded by your lender. If something looks wrong, please contact your lender.', false, 9, CONTENT_W)) { c.text(PAGE.margin, c.y + 10, line, { size: 9, color: COLOR.mute }); c.y += 12; }

    // footers, now that the page count is known
    const total = c.pages.length;
    const stamp = `Generated ${dayOf(new Date(made).toISOString())} ${timeOf(new Date(made).toISOString())} (Sri Lanka time)`;
    c.pages.forEach((ops, i) => {
        c.ops = ops;
        c.hline(PAGE.margin, PAGE.w - PAGE.margin, PAGE.h - 34, COLOR.line, 0.5);
        c.text(PAGE.margin, PAGE.h - 22, `WealthFlow statement  |  ${stamp}`, { size: 7.5, color: COLOR.mute });
        c.text(PAGE.w - PAGE.margin, PAGE.h - 22, `Page ${i + 1} of ${total}`, { size: 7.5, bold: true, color: COLOR.mute, align: 'r' });
    });

    return assemble(c.pages.map((ops) => ops.join('\n')), made);
}

/** Objects: 1 catalog, 2 page tree, 3-4 fonts, 5 info, then a page and its content for each page. */
function assemble(streams, made) {
    const pageCount = streams.length;
    const kidRefs = streams.map((_, i) => `${6 + i * 2} 0 R`);
    const objects = [];
    objects[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R /Lang (en) /ViewerPreferences << /DisplayDocTitle true >> >>', 'latin1');
    objects[2] = Buffer.from(`<< /Type /Pages /Count ${pageCount} /Kids [${kidRefs.join(' ')}] >>`, 'latin1');
    objects[3] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1');
    objects[4] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1');
    objects[5] = Buffer.from(`<< /Title (WealthFlow statement) /Producer (WealthFlow) /CreationDate (${pdfDate(made)}) >>`, 'latin1');
    streams.forEach((content, i) => {
        const body = zlib.deflateSync(Buffer.from(content, 'latin1'), { level: 9 });
        objects[6 + i * 2] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /ProcSet [/PDF /Text] >> /Contents ${7 + i * 2} 0 R >>`, 'latin1');
        objects[7 + i * 2] = Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]);
    });

    const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    const offsets = [];
    let at = parts[0].length;
    for (let id = 1; id < objects.length; id += 1) {
        offsets[id] = at;
        const chunk = Buffer.concat([Buffer.from(`${id} 0 obj\n`, 'latin1'), objects[id], Buffer.from('\nendobj\n', 'latin1')]);
        parts.push(chunk);
        at += chunk.length;
    }
    const size = objects.length;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let id = 1; id < size; id += 1) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${size} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${at}\n%%EOF\n`;
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
}

/** The file name a browser saves it under: no personal data in it, just the date. */
export const pdfFileName = (asOf) => `WealthFlow-statement-${/^\d{4}-\d{2}-\d{2}/.test(String(asOf)) ? String(asOf).slice(0, 10) : 'latest'}.pdf`;

export default { statementPdf, pdfText, textWidth, wrapText, pdfFileName, PAGE };
