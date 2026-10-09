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
 * THE LOOK is the one of the app's own loan statement (index.html, _buildLoanStatementHTML), so the document a
 * person holds from their lender and the one the owner prints from the app read as one family: the logo mark and
 * "WealthFlow" over a double navy rule, statement number and date on the right, "Details" beside "Status" in two
 * columns, summary cards with a coloured edge, navy-headed tables with banded rows and a navy total line, a
 * legend and a boxed notice, a footer on every page. Unlike the lender's own copy it has no signature or date
 * line: it is a statement the person receives, not a form they sign.
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
/* the palette of the app's loan statement: navy for structure, green for money in, red for money owed, amber behind a balance */
const COLOR = { accent: rgb('#0b3d91'), ink: rgb('#0f172a'), mute: rgb('#6b7280'), line: rgb('#cfd6e2'), alt: rgb('#f7f9fc'), paid: rgb('#0e7c4a'), owed: rgb('#b91c1c'), balance: rgb('#fff7e6'), paidBg: rgb('#f4faf6'), white: rgb('#ffffff') };

const n2 = (v) => (Math.round(v * 100) / 100).toString();
const esc = (t) => t.replace(/[\\()]/g, (c) => `\\${c}`);

class Canvas {
    constructor() { this.pages = []; this.ops = null; this.y = 0; this.newPage(); }
    newPage() { this.ops = []; this.pages.push(this.ops); this.y = PAGE.margin; }
    get room() { return PAGE.h - PAGE.footerH - this.y; }
    /** Moves to a new page unless `h` more points fit. Returns true when it did. */
    ensure(h) { if (this.room >= h) return false; this.newPage(); return true; }
    /** A filled box, optionally with a hairline border. */
    rect(x, top, w, h, fill, border) {
        const at = `${n2(x)} ${n2(PAGE.h - top - h)} ${n2(w)} ${n2(h)} re`;
        if (fill) { const [r, g, b] = fill; this.ops.push(`${n2(r)} ${n2(g)} ${n2(b)} rg ${at} f`); }
        if (border) { const [r, g, b] = border; this.ops.push(`${n2(r)} ${n2(g)} ${n2(b)} RG 0.6 w ${at} S`); }
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
const STATUS = { settled: 'Settled', closed: 'Closed', open: 'Open' };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** The statement's own number: the same for the same moment, so two downloads of one statement agree. */
const statementNo = (asOf) => `WF-${(Date.parse(asOf) || 0).toString(36).toUpperCase().slice(-6).padStart(6, '0')}`;

/* ── drawing the parts ────────────────────────────────────────────────────── */

function header(c, st) {
    const top = PAGE.margin;
    // the logo mark: a navy square with a white W, then the name
    c.rect(PAGE.margin, top, 30, 30, COLOR.accent);
    c.text(PAGE.margin + 15, top + 22, 'W', { size: 19, bold: true, color: COLOR.white, align: 'c' });
    c.text(PAGE.margin + 40, top + 22, 'WEALTHFLOW', { size: 21, bold: true, color: COLOR.accent });
    c.text(PAGE.margin, top + 48, 'Account Statement', { size: 11, bold: true });
    c.text(PAGE.margin, top + 61, 'Your investments and loans with your lender', { size: 9, color: COLOR.mute });
    const right = PAGE.w - PAGE.margin;
    const meta = [['Statement No', statementNo(st.asOf)], ['As at', `${dayOf(st.asOf)}, ${timeOf(st.asOf)}`], ['Time zone', 'Sri Lanka time']];
    meta.forEach(([k, v], i) => {
        const base = top + 12 + i * 14;
        c.text(right - textWidth(pdfText(v), true, 9) - 6, base, `${k}:`, { size: 9, color: COLOR.mute, align: 'r' });
        c.text(right, base, v, { size: 9, bold: true, align: 'r' });
    });
    c.hline(PAGE.margin, right, top + 72, COLOR.accent, 2.4);
    c.hline(PAGE.margin, right, top + 76, COLOR.accent, 0.6);
    c.y = top + 76 + 18;
    const intro = 'Every investment and loan your lender records for you is listed here under a reference code. Quote the code when you contact your lender or make a payment.';
    for (const line of wrapText(intro, false, 9.5, CONTENT_W)) { c.text(PAGE.margin, c.y, line, { size: 9.5, color: COLOR.mute }); c.y += 13; }
    c.y += 6;
}

/** The small uppercase navy heading with a hairline under it, in the loan statement's "section-title" style. */
function sectionTitle(c, text, sub, { x = PAGE.margin, w = CONTENT_W, square } = {}) {
    c.ensure(40);
    let tx = x;
    if (square) { c.rect(x, c.y + 3, 8, 8, square); tx += 14; }
    c.text(tx, c.y + 11, text.toUpperCase(), { size: 9, bold: true, color: COLOR.accent });
    if (sub) c.text(x + w, c.y + 11, sub, { size: 8, bold: true, color: COLOR.mute, align: 'r' });
    c.hline(x, x + w, c.y + 17, COLOR.line, 0.7);
    c.y += 26;
}

/** Summary cards with a coloured left edge, like the loan statement's "Paid installments" / "Remaining" pair. */
function summary(c, st) {
    const totals = Array.isArray(st.totals) ? st.totals : [];
    const groups = Array.isArray(st.groups) ? st.groups : [];
    if (!totals.length) return;
    sectionTitle(c, 'Summary');
    for (const t of totals) {
        const mine = groups.filter((g) => g.currency === t.currency);
        const boxes = [];
        if (mine.some((g) => g.kind === 'investment')) boxes.push(['Invested', fmtMoney(t.invested, t.currency), COLOR.accent, COLOR.alt], ['Interest received', fmtMoney(t.interestReceived, t.currency), COLOR.paid, COLOR.paidBg]);
        if (mine.some((g) => g.kind === 'loan')) boxes.push(['Loan outstanding', fmtMoney(t.loanOutstanding, t.currency), t.loanOutstanding > 0 ? COLOR.owed : COLOR.paid, t.loanOutstanding > 0 ? COLOR.balance : COLOR.paidBg]);
        if (!boxes.length) continue;
        c.ensure(62);
        const gap = 10;
        const w = (CONTENT_W - gap * (boxes.length - 1)) / boxes.length;
        boxes.forEach(([label, figure, edge, bg], i) => {
            const x = PAGE.margin + i * (w + gap);
            c.rect(x, c.y, w, 50, bg, COLOR.line);
            c.rect(x, c.y, 3.5, 50, edge);
            c.text(x + 14, c.y + 16, label.toUpperCase(), { size: 7.5, bold: true, color: COLOR.mute });
            c.text(x + 14, c.y + 37, figure, { size: figure.length > 20 ? 12 : 15, bold: true, color: edge });
        });
        c.y += 62;
    }
}

/**
 * "Details" beside "Status": two columns of label and value rows. Each row is [label, value, colour?]. The left
 * column's values sit by their labels, the right column's are set against the right edge, as in the loan statement.
 */
function detailsAndStatus(c, leftTitle, left, rightTitle, right) {
    const gap = 24;
    const colW = (CONTENT_W - gap) / 2;
    const rows = Math.max(left.length, right.length);
    c.ensure(26 + rows * 17 + 8);
    const top = c.y;
    sectionTitle(c, leftTitle, null, { x: PAGE.margin, w: colW });
    c.y = top;
    sectionTitle(c, rightTitle, null, { x: PAGE.margin + colW + gap, w: colW });
    const base = c.y;
    left.forEach(([k, v, color], i) => {
        c.text(PAGE.margin, base + i * 17 + 10, k, { size: 9, color: COLOR.mute });
        c.text(PAGE.margin + 112, base + i * 17 + 10, v, { size: 9, bold: true, color: color || COLOR.ink });
    });
    right.forEach(([k, v, color], i) => {
        const x = PAGE.margin + colW + gap;
        c.text(x, base + i * 17 + 10, k, { size: 9, color: COLOR.mute });
        c.text(x + colW, base + i * 17 + 10, v, { size: 9, bold: true, color: color || COLOR.ink, align: 'r' });
    });
    c.y = base + rows * 17 + 8;
}

/**
 * A table in the loan statement's manner: navy header with white capitals, banded rows, a navy total line.
 * Columns are { label, w (share of the width), right?, center? }. A cell is a string or { t, color, bold, fill }.
 * The header repeats on a new page; a row is never split.
 */
function table(c, title, square, cols, rows, total) {
    const sum = cols.reduce((a, k) => a + k.w, 0);
    const widths = cols.map((k) => (k.w / sum) * CONTENT_W);
    const rowH = 18;
    const put = (cell, i, base, extra = {}) => {
        const k = cols[i];
        const o = cell && typeof cell === 'object' ? cell : { t: cell };
        const ax = k.right ? 'r' : k.center ? 'c' : 'l';
        let x = PAGE.margin;
        for (let j = 0; j < i; j += 1) x += widths[j];
        const px = k.right ? x + widths[i] - 8 : k.center ? x + widths[i] / 2 : x + 8;
        c.text(px, base, o.t, { size: 9, align: ax, color: o.color || extra.color || COLOR.ink, bold: o.bold || extra.bold });
    };
    const head = () => {
        c.rect(PAGE.margin, c.y, CONTENT_W, rowH + 2, COLOR.accent);
        let x = PAGE.margin;
        cols.forEach((k, i) => {
            const px = k.right ? x + widths[i] - 8 : k.center ? x + widths[i] / 2 : x + 8;
            c.text(px, c.y + 13, k.label.toUpperCase(), { size: 7.5, bold: true, color: COLOR.white, align: k.right ? 'r' : k.center ? 'c' : 'l' });
            x += widths[i];
        });
        c.y += rowH + 2;
    };
    c.ensure(26 + (rowH + 2) + rowH * 2);
    sectionTitle(c, title, null, { square });
    head();
    rows.forEach((r, n) => {
        if (c.ensure(rowH + 1)) head();
        c.rect(PAGE.margin, c.y, CONTENT_W, rowH, n % 2 ? COLOR.alt : COLOR.white);
        let x = PAGE.margin;
        r.forEach((cell, i) => {
            if (cell && typeof cell === 'object' && cell.fill) c.rect(x, c.y, widths[i], rowH, cell.fill);
            put(cell, i, c.y + 12.5);
            x += widths[i];
        });
        c.hline(PAGE.margin, PAGE.w - PAGE.margin, c.y + rowH, COLOR.line, 0.4);
        c.y += rowH;
    });
    if (total) {
        if (c.ensure(rowH + 4)) head();
        c.rect(PAGE.margin, c.y, CONTENT_W, rowH + 2, COLOR.accent);
        total.forEach((cell, i) => { if (cell) put(cell, i, c.y + 13, { color: COLOR.white, bold: true }); });
        c.y += rowH + 2;
    }
    c.y += 12;
}

function note(c, text) {
    c.ensure(20);
    c.text(PAGE.margin, c.y + 10, text, { size: 9, color: COLOR.mute });
    c.y += 20;
}

/** The heading of a record: what it is, its reference code and (for a loan) whether it is open. */
function recordHead(c, g, many) {
    c.ensure(120);
    c.y += 4;
    const loan = g.kind === 'loan';
    c.rect(PAGE.margin, c.y, CONTENT_W, 26, COLOR.alt, COLOR.line);
    c.rect(PAGE.margin, c.y, 4, 26, COLOR.accent);
    c.text(PAGE.margin + 16, c.y + 17, loan ? 'Loan' : 'Investment', { size: 12, bold: true, color: COLOR.accent });
    const tag = [many && g.lender ? `Lender ${g.lender}` : '', loan && STATUS[g.status] ? STATUS[g.status] : '', g.ref].filter(Boolean).join('   |   ');
    c.text(PAGE.w - PAGE.margin - 12, c.y + 17, tag, { size: 9, bold: true, align: 'r' });
    c.y += 38;
}

function investment(c, g, many) {
    const cur = g.currency;
    recordHead(c, g, many);
    const pays = Array.isArray(g.payments) ? g.payments : [];
    detailsAndStatus(c, 'Investment details', [
        ['Reference', g.ref],
        ['Capital', fmtMoney(g.capital, cur)],
        ['Rate', `${num(g.ratePct)}% a year`],
        ['Interest paid', FREQ[g.frequency] || FREQ.monthly],
        ['Interest each time', fmtMoney(g.interestPerPeriod, cur)],
        ['Started', day(g.start)],
        g.end ? ['Ends', day(g.end)] : null,
    ].filter(Boolean), 'Account status', [
        ['Interest received so far', fmtMoney(g.totalReceived, cur), COLOR.paid],
        ['Payments received', String(pays.length)],
        g.nextInterest ? ['Next interest due', day(g.nextInterest.date)] : null,
        g.nextInterest ? ['Next interest amount', fmtMoney(g.nextInterest.amount, cur)] : null,
    ].filter(Boolean));
    if (pays.length) {
        table(c, `Interest received (${pays.length})`, COLOR.paid,
            [{ label: '#', w: 1 }, { label: 'For', w: 3 }, { label: 'Received on', w: 3 }, { label: `Amount (${cur})`, w: 3, right: true }],
            pays.map((p, i) => [String(i + 1), month(p.month), day(p.date), { t: fmtMoney(p.amount, cur).slice(4), bold: true }]),
            [`TOTAL RECEIVED (${pays.length})`, '', '', fmtMoney(g.totalReceived, cur).slice(4)].map((t, i) => (i === 0 ? { t, bold: true } : t)));
        // the label of the total spans the first columns: only the first cell carries text
    } else note(c, 'No payments recorded yet.');
}

const MOVEMENT = {
    lent: { word: 'Loan paid out', tag: 'PAID OUT', color: COLOR.accent },
    further: { word: 'Further advance', tag: 'ADVANCE', color: COLOR.accent },
    repayment: { word: 'Repayment', tag: 'REPAID', color: COLOR.paid },
};

function loan(c, g, many) {
    const cur = g.currency;
    recordHead(c, g, many);
    const late = num(g.overdueDays);
    const open = g.outstanding > 0;
    const events = Array.isArray(g.events) ? g.events : [];
    detailsAndStatus(c, 'Loan details', [
        ['Reference', g.ref],
        ['Paid out', fmtMoney(g.lent, cur)],
        g.due ? ['Expected back by', day(g.due)] : null,
    ].filter(Boolean), 'Account status', [
        ['Repaid so far', fmtMoney(g.repaid, cur), COLOR.paid],
        ['Outstanding', fmtMoney(g.outstanding, cur), open ? COLOR.owed : COLOR.paid],
        ['Status', STATUS[g.status] || 'Open', open ? (late > 0 ? COLOR.owed : COLOR.accent) : COLOR.paid],
        late > 0 ? ['Overdue', `${late} day${late === 1 ? '' : 's'}`, COLOR.owed] : null,
    ].filter(Boolean));
    if (events.length) {
        const repayments = events.filter((e) => e.kind === 'repayment');
        const repaidSum = repayments.reduce((a, e) => a + num(e.amount), 0);
        table(c, `Account movements (${events.length})`, COLOR.accent,
            [{ label: '#', w: 1 }, { label: 'Date', w: 3 }, { label: 'Transaction', w: 4 }, { label: `Amount (${cur})`, w: 3, right: true }, { label: `Balance (${cur})`, w: 3, right: true }, { label: 'Type', w: 3, center: true }],
            events.map((e, i) => {
                const m = MOVEMENT[e.kind] || { word: '-', tag: '-', color: COLOR.mute };
                return [String(i + 1), day(e.date), m.word, { t: fmtMoney(e.amount, cur).slice(4), bold: true }, { t: fmtMoney(e.balance, cur).slice(4), bold: true, fill: num(e.balance) > 0 ? COLOR.balance : null }, { t: m.tag, color: m.color, bold: true }];
            }),
            [{ t: `TOTAL REPAID (${repayments.length})`, bold: true }, '', '', fmtMoney(repaidSum, cur).slice(4), fmtMoney(g.outstanding, cur).slice(4), '']);
    } else note(c, 'Nothing recorded yet.');
}

/** One account in a box; the account number is the largest thing in it, because it is the one that gets copied. */
function accountLayout(a) {
    const rows = [['Account name', a.holder], ['Account number', a.number, true], a.branch ? ['Branch', a.branch] : null, a.swift ? ['SWIFT / IBAN', a.swift] : null].filter(Boolean);
    const noteLines = a.note ? wrapText(a.note, false, 9, CONTENT_W - 28) : [];
    return { rows, noteLines, h: 32 + rows.length * 22 + (noteLines.length ? 8 + noteLines.length * 12 : 0) + 8 };
}

function account(c, a) {
    const { rows, noteLines, h } = accountLayout(a);
    c.ensure(h + 8);
    c.rect(PAGE.margin, c.y, CONTENT_W, h, COLOR.alt, COLOR.line);
    c.rect(PAGE.margin, c.y, 3.5, h, COLOR.accent);
    c.text(PAGE.margin + 16, c.y + 21, a.bank, { size: 12, bold: true, color: COLOR.accent });
    let y = c.y + 32;
    for (const [label, value, big] of rows) {
        c.text(PAGE.margin + 16, y + 10, label, { size: 8.5, color: COLOR.mute });
        c.text(PAGE.margin + 130, y + 11, value, { size: big ? 13 : 10, bold: true });
        y += 22;
    }
    if (noteLines.length) { y += 4; for (const line of noteLines) { c.text(PAGE.margin + 16, y + 9, line, { size: 9, color: COLOR.mute }); y += 12; } }
    c.y += h + 10;
}

function payment(c, st) {
    const lenders = Array.isArray(st.lenders) ? st.lenders : [];
    if (!lenders.length) return;
    const groups = Array.isArray(st.groups) ? st.groups : [];
    const many = num(st.lenderCount) > 1;
    // the heading never sits alone at the foot of a page: it travels with its first account
    c.ensure(26 + 34 + 24 + accountLayout(lenders[0].accounts[0]).h + 8);
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

/** The legend and the boxed notice that close the loan statement; only the words for what this statement has. */
function closing(c, st) {
    const kinds = new Set((st.groups || []).map((g) => g.kind));
    const parts = [];
    if (kinds.has('loan')) parts.push(['PAID OUT', COLOR.accent, 'money lent'], ['REPAID', COLOR.paid, 'money paid back']);
    if (!parts.length) return;
    c.ensure(70);
    c.y += 4;
    let x = PAGE.margin;
    c.text(x, c.y + 9, 'Legend:', { size: 8.5, bold: true, color: COLOR.mute });
    x += 44;
    parts.forEach(([tag, color, what]) => {
        c.text(x, c.y + 9, tag, { size: 8.5, bold: true, color });
        x += textWidth(tag, true, 8.5) + 4;
        c.text(x, c.y + 9, `- ${what}`, { size: 8.5, color: COLOR.mute });
        x += textWidth(`- ${what}`, false, 8.5) + 16;
    });
    c.y += 20;
}

function notice(c, text) {
    const lines = wrapText(text, false, 9, CONTENT_W - 28);
    const h = 16 + lines.length * 12.5 + 6;
    c.ensure(h + 8);
    c.rect(PAGE.margin, c.y, CONTENT_W, h, COLOR.alt);
    c.rect(PAGE.margin, c.y, 3, h, COLOR.accent);
    lines.forEach((line, i) => c.text(PAGE.margin + 14, c.y + 17 + i * 12.5, line, { size: 9, color: COLOR.ink }));
    c.y += h + 8;
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
        inv.forEach((g) => investment(c, g, many));
        loans.forEach((g) => loan(c, g, many));
        payment(c, st);
        closing(c, st);
    }
    if (st.truncated) note(c, 'This statement is long, so only the first part is shown.');
    notice(c, 'Figures are as recorded by your lender from the payments they have confirmed. This statement is for your own records and is not a substitute for your lender\'s own account. If something looks wrong, please contact your lender.');

    // footers, now that the page count is known
    const total = c.pages.length;
    const no = statementNo(st.asOf);
    const stamp = `Generated ${dayOf(new Date(made).toISOString())} ${timeOf(new Date(made).toISOString())} (Sri Lanka time)`;
    c.pages.forEach((ops, i) => {
        c.ops = ops;
        c.hline(PAGE.margin, PAGE.w - PAGE.margin, PAGE.h - 34, COLOR.line, 0.5);
        c.text(PAGE.margin, PAGE.h - 22, `WealthFlow statement  |  ${no}  |  ${stamp}`, { size: 7.5, color: COLOR.mute });
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
