/* =============================================================================
 * tenant-pdf.mjs — a person's statement as a PDF they can keep, print or forward
 * -----------------------------------------------------------------------------
 * Built from the SAME object the statement page shows (tenant-statement.mjs): the PDF has no way to ask for
 * more than the page does, so nothing private can reach a file that a phone will store and a person may send
 * on. It carries figures, dates, reference codes and the lender's payment details, under the same rules.
 *
 * WHY A WRITER OF OUR OWN. The deployment has no PDF library and a function that renders a handful of tables
 * does not justify one: this file writes PDF 1.4 directly, Flate-compressed pages, a correct cross-reference
 * table, a document title and page numbers ("Page 2 of 3") on every page.
 *
 * THE LOOK is the one of the app's own loan statement (index.html, _buildLoanStatementHTML), so the document a
 * person holds from their lender and the one the owner prints from the app read as one family: the logo mark and
 * "WealthFlow" over a double navy rule, statement number and date on the right, "Details" beside "Status" in two
 * columns, summary cards with a coloured edge, navy-headed tables with banded rows and a navy total line, a
 * legend and a boxed notice, a footer on every page. Unlike the lender's own copy it has no signature or date
 * line: it is a statement the person receives, not a form they sign.
 *
 * TWO WAYS TO DRAW TEXT.
 *   English (the default): Helvetica and Helvetica-Bold, two of the fourteen fonts every reader has, so nothing is
 *   embedded and the file is a few kilobytes. These fonts have no Sinhala, Tamil, Arabic or CJK letters: text is
 *   reduced to what they have (accents are dropped, é -> e) and anything else prints as "?", never as a broken file.
 *   Sinhala (`lang: 'si'`, or any Sinhala letters in the statement's own data, such as a bank's name or a note):
 *   the whole document is set in Noto Sans Sinhala (SIL Open Font License, assets/fonts), which also carries the Latin
 *   letters and digits, so a line mixing the two is one font. Sinhala is shaped by HarfBuzz (pdf-shape.mjs: vowel
 *   signs that are drawn before their consonant, split vowels, joined clusters), and only the glyphs the document
 *   uses are embedded (pdf-font.mjs), so the file stays small. The text carries its own meaning (ToUnicode and
 *   ActualText), so it can be searched and copied. The words come from the same table as the page (tenant-lang.js).
 *   If the shaping engine cannot be loaded the English file is returned instead: never a file with wrong letters.
 *   Other scripts (Tamil, Arabic, CJK) are not covered: they would need their own font and word table.
 *
 * Pure: no clock (`generatedAt` is passed), no network. The shaper is passed in (or loaded by `renderStatementPdf`),
 * which is the only part that reads files. Returns a Buffer.
 * ===========================================================================*/

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fmtMoney, fmtDay } from './sms-templates.mjs';
import { makeT } from './tenant-lang.js';
import { LOGO } from './tenant-logo.mjs';
import { subsetFont, glyphCodePoints } from './pdf-font.mjs';
import { loadShaper, needsShaping } from './pdf-shape.mjs';

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
const COLOR = { accent: rgb('#0b3d91'), ink: rgb('#0f172a'), mute: rgb('#6b7280'), line: rgb('#cfd6e2'), alt: rgb('#f7f9fc'), paid: rgb('#0e7c4a'), owed: rgb('#b91c1c'), balance: rgb('#fff7e6'), warn: rgb('#b45309'), warnEdge: rgb('#f59e0b'), paidBg: rgb('#f4faf6'), white: rgb('#ffffff') };

const n2 = (v) => (Math.round(v * 100) / 100).toString();
const esc = (t) => t.replace(/[\\()]/g, (c) => `\\${c}`);

/** Greedy word wrap for shaped text: the same rules as `wrapText`, measured with the font that will draw it. */
function wrapShaped(sh, text, bold, size, maxWidth) {
    const words = sh.clean(text, bold).split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    const push = () => { if (line) lines.push(line); line = ''; };
    const graphemes = (w) => (typeof Intl !== 'undefined' && Intl.Segmenter ? Array.from(new Intl.Segmenter('si', { granularity: 'grapheme' }).segment(w), (g) => g.segment) : Array.from(w));
    for (let word of words) {
        if (sh.width(word, bold, size) > maxWidth) {
            // a word wider than the line is cut between letters (never inside one), at the longest piece that fits
            const parts = graphemes(word);
            while (parts.length) {
                let n = parts.length;
                while (n > 1 && sh.width(parts.slice(0, n).join(''), bold, size) > maxWidth) n -= 1;
                push();
                lines.push(parts.splice(0, n).join(''));
            }
            continue;
        }
        const next = line ? `${line} ${word}` : word;
        if (line && sh.width(next, bold, size) > maxWidth) { push(); line = word; } else line = next;
    }
    push();
    return lines.length ? lines : [''];
}

const utf16hex = (text) => Buffer.from(`﻿${text}`, 'utf16le').swap16().toString('hex').toUpperCase();

class Canvas {
    /**
     * @param {{shaper?:object, lang?:string}} opts `shaper` set means the whole document is drawn in the embedded font
     */
    constructor({ shaper = null, lang = 'en' } = {}) {
        this.shaper = shaper;
        this.lang = lang === 'si' ? 'si' : 'en';
        this.t = makeT(this.lang);
        // glyph number -> the text it stands for, per weight: what ToUnicode will say, and which glyphs the font subset must keep
        this.used = { regular: new Map(), bold: new Map() };
        this.cps = { regular: null, bold: null };
        this.pages = []; this.ops = null; this.y = 0; this.newPage();
    }
    /** Sinhala letters are finer than Latin ones at the same size: the smallest labels are drawn a little larger, and wrapped paragraphs given more room between lines. */
    sz(size) { return this.lang === 'si' && size <= 8.5 ? size * 1.12 : size; }
    lh(pitch) { return this.lang === 'si' ? pitch * 1.18 : pitch; }
    /** Width of a string in points, in whichever font will draw it. */
    measure(str, bold, size) {
        if (this.shaper) return this.shaper.width(this.shaper.clean(str, bold), bold, this.sz(size));
        return textWidth(pdfText(str), bold, size);
    }
    wrap(text, bold, size, maxWidth) { return this.shaper ? wrapShaped(this.shaper, text, bold, this.sz(size), maxWidth) : wrapText(text, bold, size, maxWidth); }
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
    /** The WealthFlow mark (image object /Im1, written by `assemble`), `size` points square with its top-left corner at (x, top). */
    logo(x, top, size) {
        this.usesLogo = true;
        this.ops.push(`q ${n2(size)} 0 0 ${n2(size)} ${n2(x)} ${n2(PAGE.h - top - size)} cm /Im1 Do Q`);
    }
    hline(x1, x2, top, color, width = 0.5) {
        const [r, g, b] = color;
        this.ops.push(`${n2(r)} ${n2(g)} ${n2(b)} RG ${n2(width)} w ${n2(x1)} ${n2(PAGE.h - top)} m ${n2(x2)} ${n2(PAGE.h - top)} l S`);
    }
    /** One line of text whose baseline is `base` points from the top. align: 'l' | 'r' | 'c' about x. */
    text(x, base, str, { size = 10, bold = false, color = COLOR.ink, align = 'l' } = {}) {
        if (this.shaper) return this.shapedText(x, base, str, { size, bold, color, align });
        const t = pdfText(str);
        if (!t) return;
        const w = textWidth(t, bold, size);
        const px = align === 'r' ? x - w : align === 'c' ? x - w / 2 : x;
        const [r, g, b] = color;
        this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${n2(size)} Tf ${n2(r)} ${n2(g)} ${n2(b)} rg ${n2(px)} ${n2(PAGE.h - base)} Td (${esc(t)}) Tj ET`);
    }
    /** The same, set in the embedded font: the string is shaped, and every glyph is placed where the shaper said. */
    shapedText(x, base, str, { size: asked, bold, color, align }) {
        const sh = this.shaper;
        const size = this.sz(asked);
        const text = sh.clean(str, bold);
        if (!text) return;
        const shaped = sh.shape(text, bold);
        const scale = 1000 / sh.upem;
        const w = (shaped.width * size) / sh.upem;
        const px = align === 'r' ? x - w : align === 'c' ? x - w / 2 : x;
        const [r, g, b] = color;
        // what each glyph stands for (the ToUnicode map is per glyph, not per use, so it must say what the glyph is wherever it appears):
        // a glyph the font reaches from a character says that character; a glyph that exists only through shaping (a conjunct) says the
        // letters of its cluster that no sibling glyph already says
        const used = this.used[bold ? 'bold' : 'regular'];
        const cps = (this.cps[bold ? 'bold' : 'regular'] ||= glyphCodePoints(sh.font(bold)));
        for (let k = 0; k < shaped.glyphs.length;) {
            let end = k;
            while (end + 1 < shaped.glyphs.length && shaped.glyphs[end + 1].from === shaped.glyphs[k].from) end += 1;
            const cluster = shaped.glyphs.slice(k, end + 1);
            let rest = text.slice(cluster[0].from, cluster[0].to);
            for (const g2 of cluster) {
                if (!cps.has(g2.gid)) continue;
                const ch = String.fromCodePoint(cps.get(g2.gid));
                if (!used.has(g2.gid)) used.set(g2.gid, ch);
                const at = rest.indexOf(ch);
                if (at >= 0) rest = rest.slice(0, at) + rest.slice(at + ch.length);
            }
            let spoken = false;
            for (const g2 of cluster) {
                if (cps.has(g2.gid)) continue;
                if (!used.has(g2.gid)) used.set(g2.gid, spoken ? '' : rest);
                spoken = true;
            }
            k = end + 1;
        }
        // positions: TJ numbers are thousandths of the font size, positive moves LEFT
        const items = [];
        const move = (units) => { const n = -units * scale; if (Math.abs(n) < 0.005) return; if (typeof items[items.length - 1] === 'number') items[items.length - 1] += n; else items.push(n); };
        let out = '';
        let rise = 0;
        const flush = () => {
            if (!items.length) return;
            out += `[${items.map((v) => (typeof v === 'number' ? n2(v) : v)).join(' ')}] TJ `;
            items.length = 0;
        };
        for (const g2 of shaped.glyphs) {
            if (g2.dy !== rise) { flush(); rise = g2.dy; out += `${n2((rise * size) / sh.upem)} Ts `; }
            if (g2.dx) move(g2.dx);
            const hex = g2.gid.toString(16).padStart(4, '0');
            const last = items[items.length - 1];
            if (typeof last === 'string') items[items.length - 1] = `${last.slice(0, -1)}${hex}>`; else items.push(`<${hex}>`);
            move(g2.adv - g2.dx - sh.advanceOf(g2.gid, bold));
        }
        flush();
        if (rise !== 0) out += '0 Ts ';
        const draw = `BT /${bold ? 'F4' : 'F3'} ${n2(size)} Tf ${n2(r)} ${n2(g)} ${n2(b)} rg ${n2(px)} ${n2(PAGE.h - base)} Td ${out.trim()} ET`;
        // Sinhala is stored as glyph numbers; ActualText says what those glyphs spell, so that search and copy get the letters
        this.ops.push(needsShaping(text) ? `/Span << /ActualText <${utf16hex(text)}> >> BDC ${draw} EMC` : draw);
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
    const t = c.t;
    const top = PAGE.margin;
    // the WealthFlow mark, then the name
    c.logo(PAGE.margin, top - 2, 34);
    c.text(PAGE.margin + 44, top + 22, 'WEALTHFLOW', { size: 21, bold: true, color: COLOR.accent });
    c.text(PAGE.margin, top + 48, t('Account Statement'), { size: 11, bold: true });
    c.text(PAGE.margin, top + 61, t('Your investments and loans with your lender'), { size: 9, color: COLOR.mute });
    const right = PAGE.w - PAGE.margin;
    const meta = [[t('Statement No'), statementNo(st.asOf)], [t('As at'), `${dayOf(st.asOf)}, ${timeOf(st.asOf)}`], [t('Time zone'), t('Sri Lanka time')]];
    meta.forEach(([k, v], i) => {
        const base = top + 12 + i * 14;
        c.text(right - c.measure(v, true, 9) - 6, base, `${k}:`, { size: 9, color: COLOR.mute, align: 'r' });
        c.text(right, base, v, { size: 9, bold: true, align: 'r' });
    });
    c.hline(PAGE.margin, right, top + 72, COLOR.accent, 2.4);
    c.hline(PAGE.margin, right, top + 76, COLOR.accent, 0.6);
    c.y = top + 76 + 14;
    holder(c, st);
    const intro = t('Every investment and loan your lender records for you is listed here under a reference code. Quote the code when you contact your lender or make a payment.');
    for (const line of c.wrap(intro, false, 9.5, CONTENT_W)) { c.text(PAGE.margin, c.y, line, { size: 9.5, color: COLOR.mute }); c.y += c.lh(13); }
    c.y += 6;
}

/** Whose statement it is: the person's own full name and NIC. Nothing is drawn for a field the lender has not recorded. */
function holder(c, st) {
    const t = c.t;
    const h = st.holder && typeof st.holder === 'object' ? st.holder : {};
    const name = String(h.name || '').trim();
    const nic = String(h.nic || '').trim();
    if (!name && !nic) return;
    const boxH = 40;
    c.rect(PAGE.margin, c.y, CONTENT_W, boxH, COLOR.alt, COLOR.line);
    c.rect(PAGE.margin, c.y, 3.5, boxH, COLOR.accent);
    const nameW = name && nic ? CONTENT_W * 0.62 : CONTENT_W;
    if (name) {
        c.text(PAGE.margin + 16, c.y + 15, t('Account holder').toUpperCase(), { size: 7.5, bold: true, color: COLOR.mute });
        const line = c.wrap(name, true, 11, nameW - 24)[0];
        c.text(PAGE.margin + 16, c.y + 31, line, { size: 11, bold: true });
    }
    if (nic) {
        const x = PAGE.margin + (name ? nameW : 0) + 16;
        c.text(x, c.y + 15, t('NIC / ID').toUpperCase(), { size: 7.5, bold: true, color: COLOR.mute });
        c.text(x, c.y + 31, nic, { size: 11, bold: true });
    }
    c.y += boxH + 16;
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
    const t = c.t;
    const totals = Array.isArray(st.totals) ? st.totals : [];
    const groups = Array.isArray(st.groups) ? st.groups : [];
    if (!totals.length) return;
    sectionTitle(c, t('Summary'));
    for (const tot of totals) {
        const mine = groups.filter((g) => g.currency === tot.currency);
        const boxes = [];
        if (mine.some((g) => g.kind === 'investment')) boxes.push([t('Invested'), fmtMoney(tot.invested, tot.currency), COLOR.accent, COLOR.alt], [t('Interest received'), fmtMoney(tot.interestReceived, tot.currency), COLOR.paid, COLOR.paidBg]);
        if (mine.some((g) => g.kind === 'loan')) boxes.push([t('Loan outstanding'), fmtMoney(tot.loanOutstanding, tot.currency), tot.loanOutstanding > 0 ? COLOR.owed : COLOR.paid, tot.loanOutstanding > 0 ? COLOR.balance : COLOR.paidBg]);
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
        c.text(PAGE.margin + (c.lang === 'si' ? 124 : 112), base + i * 17 + 10, v, { size: 9, bold: true, color: color || COLOR.ink });
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
    const t = c.t;
    c.ensure(120);
    c.y += 4;
    const loan = g.kind === 'loan';
    c.rect(PAGE.margin, c.y, CONTENT_W, 26, COLOR.alt, COLOR.line);
    c.rect(PAGE.margin, c.y, 4, 26, COLOR.accent);
    c.text(PAGE.margin + 16, c.y + 17, loan ? t('Loan') : t('Investment'), { size: 12, bold: true, color: COLOR.accent });
    const tag = [many && g.lender ? t('Lender {n}', { n: g.lender }) : '', loan && STATUS[g.status] ? t(STATUS[g.status]) : '', g.ref].filter(Boolean).join('   |   ');
    c.text(PAGE.w - PAGE.margin - 12, c.y + 17, tag, { size: 9, bold: true, align: 'r' });
    c.y += 38;
}

/** "3 days" / "1 day" in the document's language. */
const daysWord = (t, n) => (n === 1 ? t('1 day') : t('{n} days', { n }));

function investment(c, g, many) {
    const t = c.t;
    const cur = g.currency;
    recordHead(c, g, many);
    const pays = Array.isArray(g.payments) ? g.payments : [];
    detailsAndStatus(c, t('Investment details'), [
        [t('Reference'), g.ref],
        [t('Capital'), fmtMoney(g.capital, cur)],
        [t('Rate'), t('{n}% a year', { n: num(g.ratePct) })],
        [t('Interest paid'), t(FREQ[g.frequency] || FREQ.monthly)],
        [t('Interest each time'), fmtMoney(g.interestPerPeriod, cur)],
        [t('Started'), day(g.start)],
        g.end ? [t('Ends'), day(g.end)] : null,
    ].filter(Boolean), t('Account status'), [
        [t('Interest received so far'), fmtMoney(g.totalReceived, cur), COLOR.paid],
        [t('Payments received'), String(pays.length)],
        g.nextInterest ? [t('Next interest due'), day(g.nextInterest.date)] : null,
        g.nextInterest ? [t('Next interest amount'), fmtMoney(g.nextInterest.amount, cur)] : null,
    ].filter(Boolean));
    if (pays.length) {
        table(c, t('Interest received ({n})', { n: pays.length }), COLOR.paid,
            [{ label: '#', w: 1 }, { label: t('For'), w: 3 }, { label: t('Received on'), w: 3 }, { label: t('Amount ({cur})', { cur }), w: 3, right: true }],
            pays.map((p, i) => [String(i + 1), month(p.month), day(p.date), { t: fmtMoney(p.amount, cur).slice(4), bold: true }]),
            [t('Total received ({n})', { n: pays.length }).toUpperCase(), '', '', fmtMoney(g.totalReceived, cur).slice(4)].map((x, i) => (i === 0 ? { t: x, bold: true } : x)));
        // the label of the total spans the first columns: only the first cell carries text
    } else note(c, t('No payments recorded yet.'));
}

const LOAN_EVENT = { lent: 'Loan paid out', further: 'Further advance', repayment: 'Repayment' };
const TAG = { lent: 'Paid out', further: 'Advance', repayment: 'Repaid' };
const TAG_COLOR = { lent: COLOR.accent, further: COLOR.accent, repayment: COLOR.paid };

function loan(c, g, many) {
    const t = c.t;
    const cur = g.currency;
    recordHead(c, g, many);
    const late = num(g.overdueDays);
    const open = g.outstanding > 0;
    const events = Array.isArray(g.events) ? g.events : [];
    detailsAndStatus(c, t('Loan details'), [
        [t('Reference'), g.ref],
        [t('Paid out'), fmtMoney(g.lent, cur)],
        g.due ? [t('Expected back by'), day(g.due)] : null,
    ].filter(Boolean), t('Account status'), [
        [t('Repaid so far'), fmtMoney(g.repaid, cur), COLOR.paid],
        [t('Outstanding'), fmtMoney(g.outstanding, cur), open ? COLOR.owed : COLOR.paid],
        [t('Status'), t(STATUS[g.status] || 'Open'), open ? (late > 0 ? COLOR.owed : COLOR.accent) : COLOR.paid],
        late > 0 ? [t('Overdue'), daysWord(t, late), COLOR.owed] : null,
    ].filter(Boolean));
    if (events.length) {
        const repayments = events.filter((e) => e.kind === 'repayment');
        const repaidSum = repayments.reduce((a, e) => a + num(e.amount), 0);
        table(c, t('Account movements ({n})', { n: events.length }), COLOR.accent,
            [{ label: '#', w: 1 }, { label: t('Date'), w: 3 }, { label: t('Transaction'), w: 4 }, { label: t('Amount ({cur})', { cur }), w: 3, right: true }, { label: t('Balance ({cur})', { cur }), w: 3, right: true }, { label: t('Type'), w: 3, center: true }],
            events.map((e, i) => {
                const tag = TAG[e.kind];
                return [String(i + 1), day(e.date), LOAN_EVENT[e.kind] ? t(LOAN_EVENT[e.kind]) : '-', { t: fmtMoney(e.amount, cur).slice(4), bold: true }, { t: fmtMoney(e.balance, cur).slice(4), bold: true, fill: num(e.balance) > 0 ? COLOR.balance : null }, { t: tag ? t(tag).toUpperCase() : '-', color: TAG_COLOR[e.kind] || COLOR.mute, bold: true }];
            }),
            [{ t: t('Total repaid ({n})', { n: repayments.length }).toUpperCase(), bold: true }, '', '', fmtMoney(repaidSum, cur).slice(4), fmtMoney(g.outstanding, cur).slice(4), '']);
    } else note(c, t('Nothing recorded yet.'));
}

/**
 * One account in a box. Every value is the same size and weight (the account number is the thing that gets copied, but a
 * statement reads as an official document when its details line up): label in grey, value in bold ink, one row pitch.
 * A note from the lender gets its own tinted panel so it is not missed.
 */
const ACCT = { pad: 16, title: 34, row: 19, valueX: 140 };

function accountLayout(c, a) {
    const t = c.t;
    const rows = [[t('Account name'), a.holder], [t('Account number'), a.number], a.branch ? [t('Branch'), a.branch] : null, a.swift ? [t('SWIFT / IBAN'), a.swift] : null].filter(Boolean);
    const noteLines = a.note ? c.wrap(a.note, false, 9, CONTENT_W - 2 * ACCT.pad - 26) : [];
    const noteH = noteLines.length ? 24 + noteLines.length * c.lh(12) : 0;
    return { rows, noteLines, noteH, h: ACCT.title + rows.length * ACCT.row + (noteH ? 10 + noteH : 0) + 12 };
}

function account(c, a) {
    const t = c.t;
    const { rows, noteLines, noteH, h } = accountLayout(c, a);
    c.ensure(h + 8);
    const x = PAGE.margin + ACCT.pad;
    c.rect(PAGE.margin, c.y, CONTENT_W, h, COLOR.alt, COLOR.line);
    c.rect(PAGE.margin, c.y, 3.5, h, COLOR.accent);
    c.text(x, c.y + 21, a.bank, { size: 11, bold: true, color: COLOR.accent });
    c.hline(x, PAGE.w - PAGE.margin - ACCT.pad, c.y + 29, COLOR.line, 0.6);
    let y = c.y + ACCT.title;
    for (const [label, value] of rows) {
        c.text(x, y + 12, label, { size: 8.5, color: COLOR.mute });
        c.text(PAGE.margin + ACCT.valueX, y + 12, value, { size: 10, bold: true });
        y += ACCT.row;
    }
    if (noteLines.length) {
        y += 10;
        const nx = PAGE.margin + ACCT.pad;
        const nw = CONTENT_W - 2 * ACCT.pad;
        c.rect(nx, y, nw, noteH, COLOR.balance, COLOR.warnEdge);
        c.rect(nx, y, 3, noteH, COLOR.warnEdge);
        c.text(nx + 13, y + 14, t('Note').toUpperCase(), { size: 7.5, bold: true, color: COLOR.warn });
        noteLines.forEach((line, i) => c.text(nx + 13, y + 27 + i * c.lh(12), line, { size: 9, color: COLOR.ink }));
    }
    c.y += h + 10;
}

function payment(c, st) {
    const t = c.t;
    const lenders = Array.isArray(st.lenders) ? st.lenders : [];
    if (!lenders.length) return;
    const groups = Array.isArray(st.groups) ? st.groups : [];
    const many = num(st.lenderCount) > 1;
    // the heading never sits alone at the foot of a page: it travels with its first account
    c.ensure(26 + 34 + 24 + accountLayout(c, lenders[0].accounts[0]).h + 8);
    sectionTitle(c, t('How to pay'));
    const lead = t('Pay by bank transfer to the account below and put the reference of the record in the transfer. If the account details here look different from what your lender told you, check with your lender before sending money.');
    for (const line of c.wrap(lead, false, 9.5, CONTENT_W)) { c.ensure(14); c.text(PAGE.margin, c.y + 10, line, { size: 9.5, color: COLOR.mute }); c.y += c.lh(13); }
    c.y += 8;
    for (const l of lenders) {
        const refs = groups.filter((g) => g.lender === l.n).map((g) => g.ref);
        if (many) { c.ensure(40); c.text(PAGE.margin, c.y + 10, t('Lender {n}', { n: l.n }), { size: 11, bold: true }); c.y += 18; }
        if (refs.length) {
            const shown = refs.slice(0, 6).join(', ') + (refs.length > 6 ? ` ${t('and {n} more', { n: refs.length - 6 })}` : '');
            for (const line of c.wrap(t('References: {refs}', { refs: shown }), true, 9, CONTENT_W)) { c.ensure(14); c.text(PAGE.margin, c.y + 10, line, { size: 9, bold: true, color: COLOR.ink }); c.y += c.lh(12); }
            c.y += 6;
        }
        for (const a of l.accounts) account(c, a);
    }
}

/** The legend that closes the loan statement; only the words for what this statement has. */
function closing(c, st) {
    const t = c.t;
    const kinds = new Set((st.groups || []).map((g) => g.kind));
    const parts = [];
    if (kinds.has('loan')) parts.push([t('Paid out').toUpperCase(), COLOR.accent, t('money lent')], [t('Repaid').toUpperCase(), COLOR.paid, t('money paid back')]);
    if (!parts.length) return;
    c.ensure(70);
    c.y += 4;
    let x = PAGE.margin;
    const lead = `${t('Legend')}:`;
    c.text(x, c.y + 9, lead, { size: 8.5, bold: true, color: COLOR.mute });
    x += c.measure(lead, true, 8.5) + 8;
    parts.forEach(([tag, color, what]) => {
        c.text(x, c.y + 9, tag, { size: 8.5, bold: true, color });
        x += c.measure(tag, true, 8.5) + 4;
        c.text(x, c.y + 9, `- ${what}`, { size: 8.5, color: COLOR.mute });
        x += c.measure(`- ${what}`, false, 8.5) + 16;
    });
    c.y += 20;
}

function notice(c, text) {
    const lines = c.wrap(text, false, 9, CONTENT_W - 28);
    const pitch = c.lh(12.5);
    const h = 16 + lines.length * pitch + 6;
    c.ensure(h + 8);
    c.rect(PAGE.margin, c.y, CONTENT_W, h, COLOR.alt);
    c.rect(PAGE.margin, c.y, 3, h, COLOR.accent);
    lines.forEach((line, i) => c.text(PAGE.margin + 14, c.y + 17 + i * pitch, line, { size: 9, color: COLOR.ink }));
    c.y += h + 8;
}

/* ── the file ─────────────────────────────────────────────────────────────── */

const pdfDate = (ms) => { const d = new Date(ms); const p = (n, w = 2) => String(n).padStart(w, '0'); return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; };

/** Is there any Sinhala in this statement's own data (a bank's name, a holder, a note)? Those need the shaper whatever language was asked for. */
export function hasSinhala(statement) {
    try { return needsShaping(JSON.stringify(statement)); } catch (_) { return false; }
}

/**
 * @param {object} statement what buildStatement returned
 * @param {{generatedAt:number, lang?:('en'|'si'), shaper?:object}} opts `shaper` (from pdf-shape.mjs) is what lets Sinhala be drawn; without it
 *   the file is English and any Sinhala letters in the data print as "?"
 * @returns {Buffer} a complete PDF file
 */
export function statementPdf(statement, { generatedAt, lang = 'en', shaper = null } = {}) {
    const raw = statement && typeof statement === 'object' ? statement : {};
    // only ever draws what has the shape of a record: a damaged entry is skipped, never allowed to take the download down
    const objects = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
    const st = { ...raw, groups: objects(raw.groups), totals: objects(raw.totals), lenders: objects(raw.lenders).filter((l) => Array.isArray(l.accounts) && l.accounts.length).map((l) => ({ ...l, accounts: objects(l.accounts) })).filter((l) => l.accounts.length) };
    const groups = st.groups;
    const made = Number.isFinite(Number(generatedAt)) ? Number(generatedAt) : Date.parse(st.asOf) || 0;
    const many = num(st.lenderCount) > 1;

    // one font for the whole document: the embedded one when Sinhala was asked for or is in the data, else Helvetica
    const sinhala = !!shaper && (lang === 'si' || hasSinhala(raw));
    const c = new Canvas({ shaper: sinhala ? shaper : null, lang: sinhala && lang === 'si' ? 'si' : 'en' });
    const t = c.t;
    header(c, st);
    if (!groups.length) {
        note(c, t('There is nothing to show yet. When your lender records something for you, it will appear here.'));
    } else {
        summary(c, st);
        const inv = groups.filter((g) => g.kind === 'investment');
        const loans = groups.filter((g) => g.kind === 'loan');
        inv.forEach((g) => investment(c, g, many));
        loans.forEach((g) => loan(c, g, many));
        payment(c, st);
        closing(c, st);
    }
    if (st.truncated) note(c, t('This statement is long, so only the first part is shown.'));
    notice(c, t('Figures are as recorded by your lender from the payments they have confirmed. This statement is for your own records and is not a substitute for your lender\'s own account. If something looks wrong, please contact your lender.'));

    // footers, now that the page count is known
    const total = c.pages.length;
    const no = statementNo(st.asOf);
    const stamp = `${t('Generated {when}', { when: `${dayOf(new Date(made).toISOString())} ${timeOf(new Date(made).toISOString())}` })} (${t('Sri Lanka time')})`;
    c.pages.forEach((ops, i) => {
        c.ops = ops;
        c.hline(PAGE.margin, PAGE.w - PAGE.margin, PAGE.h - 34, COLOR.line, 0.5);
        c.text(PAGE.margin, PAGE.h - 22, `${t('WealthFlow statement')}  |  ${no}  |  ${stamp}`, { size: 7.5, color: COLOR.mute });
        c.text(PAGE.w - PAGE.margin, PAGE.h - 22, t('Page {i} of {total}', { i: i + 1, total }), { size: 7.5, bold: true, color: COLOR.mute, align: 'r' });
    });

    return assemble(c.pages.map((ops) => ops.join('\n')), made, { canvas: c });
}

/**
 * The file for a download: loads the shaping engine only when the document needs it, and returns the English file, never a broken one,
 * if the engine cannot be loaded or fails on this document.
 * @param {object} statement
 * @param {{generatedAt:number, lang?:string, loader?:Function}} opts `loader` is for tests
 */
export async function renderStatementPdf(statement, { generatedAt, lang = 'en', loader = loadShaper } = {}) {
    const want = lang === 'si' ? 'si' : 'en';
    if (want === 'en' && !hasSinhala(statement)) return statementPdf(statement, { generatedAt });
    let shaper = null;
    try { shaper = await loader(); } catch (e) { console.warn('[WF-PORTAL] the Sinhala PDF engine could not be loaded:', String((e && e.message) || e).slice(0, 160)); }
    if (shaper) {
        try { return statementPdf(statement, { generatedAt, lang: want, shaper }); }
        catch (e) { console.warn('[WF-PORTAL] the Sinhala PDF could not be built:', String((e && e.message) || e).slice(0, 160)); }
    }
    return statementPdf(statement, { generatedAt });
}

/** The PDF objects of one embedded font weight: Type0 -> CIDFontType2 -> descriptor -> font program, and the ToUnicode map. */
function fontObjects(baseId, sh, bold, used) {
    const gids = [...used.keys()].sort((x, y) => x - y);
    const parsed = sh.font(bold);
    const { file } = subsetFont(parsed, gids);
    const tag = [...crypto.createHash('sha1').update(`${bold ? 'b' : 'r'}:${gids.join(',')}`).digest().subarray(0, 6)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
    const name = `${tag}+NotoSansSinhala-${bold ? 'Bold' : 'Regular'}`;
    const k = 1000 / parsed.upem;
    const wid = (g) => Math.round(parsed.advances[g] * k);

    // widths: consecutive glyph numbers share one entry
    const wParts = [];
    for (let i = 0; i < gids.length;) {
        let j = i;
        while (j + 1 < gids.length && gids[j + 1] === gids[j] + 1) j += 1;
        wParts.push(`${gids[i]} [${gids.slice(i, j + 1).map(wid).join(' ')}]`);
        i = j + 1;
    }
    const bfchars = gids.filter((g) => used.get(g)).map((g) => `<${g.toString(16).padStart(4, '0').toUpperCase()}> <${utf16hex(used.get(g)).slice(4)}>`);
    const blocks = [];
    for (let i = 0; i < bfchars.length; i += 100) { const part = bfchars.slice(i, i + 100); blocks.push(`${part.length} beginbfchar\n${part.join('\n')}\nendbfchar`); }
    const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;

    const stream = (dict, data) => { const body = zlib.deflateSync(data, { level: 9 }); return Buffer.concat([Buffer.from(`<< ${dict} /Filter /FlateDecode /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]); };
    const [x0, y0, x1, y1] = parsed.bbox.map((v) => Math.round(v * k));
    return [
        Buffer.from(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${baseId + 1} 0 R] /ToUnicode ${baseId + 4} 0 R >>`, 'latin1'),
        Buffer.from(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${baseId + 2} 0 R /DW 1000 /W [${wParts.join(' ')}] /CIDToGIDMap /Identity >>`, 'latin1'),
        Buffer.from(`<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [${x0} ${y0} ${x1} ${y1}] /ItalicAngle 0 /Ascent ${Math.round(parsed.ascent * k)} /Descent ${Math.round(parsed.descent * k)} /CapHeight 714 /StemV ${bold ? 140 : 80} /FontFile2 ${baseId + 3} 0 R >>`, 'latin1'),
        stream(`/Length1 ${file.length}`, file),
        stream('', Buffer.from(cmap, 'latin1')),
    ];
}

/** Objects: 1 catalog, 2 page tree, 3-4 fonts, 5 info, then a page and its content for each page, then the embedded fonts (five objects each). */
function assemble(streams, made, { canvas = null } = {}) {
    const pageCount = streams.length;
    const kidRefs = streams.map((_, i) => `${6 + i * 2} 0 R`);
    const sh = canvas && canvas.shaper;
    const si = !!sh && canvas.lang === 'si';
    // the embedded fonts that were used, each with the object number it will have
    let next = 6 + pageCount * 2;
    const embedded = [];
    if (sh) for (const [bold, res] of [[false, 'F3'], [true, 'F4']]) {
        const used = canvas.used[bold ? 'bold' : 'regular'];
        if (!used.size) continue;
        embedded.push({ res, id: next, objects: fontObjects(next, sh, bold, used) });
        next += 5;
    }
    // the logo (an RGB image with its own alpha channel as a soft mask) goes after the fonts
    let logoId = 0;
    if (canvas && canvas.usesLogo) { logoId = next; next += 2; }
    const xobj = logoId ? `/XObject << /Im1 ${logoId} 0 R >> ` : '';
    const fontRes = ['/F1 3 0 R', '/F2 4 0 R', ...embedded.map((f) => `/${f.res} ${f.id} 0 R`)].join(' ');
    const title = si ? `<${utf16hex(canvas.t('Your WealthFlow statement'))}>` : '(WealthFlow statement)';

    const objects = [];
    objects[1] = Buffer.from(`<< /Type /Catalog /Pages 2 0 R /Lang (${si ? 'si' : 'en'}) /ViewerPreferences << /DisplayDocTitle true >> >>`, 'latin1');
    objects[2] = Buffer.from(`<< /Type /Pages /Count ${pageCount} /Kids [${kidRefs.join(' ')}] >>`, 'latin1');
    objects[3] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1');
    objects[4] = Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>', 'latin1');
    objects[5] = Buffer.from(`<< /Title ${title} /Producer (WealthFlow) /CreationDate (${pdfDate(made)}) >>`, 'latin1');
    streams.forEach((content, i) => {
        const body = zlib.deflateSync(Buffer.from(content, 'latin1'), { level: 9 });
        objects[6 + i * 2] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] /Resources << /Font << ${fontRes} >> ${xobj}/ProcSet [/PDF /Text${logoId ? ' /ImageC' : ''}] >> /Contents ${7 + i * 2} 0 R >>`, 'latin1');
        objects[7 + i * 2] = Buffer.concat([Buffer.from(`<< /Filter /FlateDecode /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]);
    });
    if (logoId) {
        const flate = (b64) => Buffer.from(b64, 'base64');
        const img = (dict, data) => Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${LOGO.width} /Height ${LOGO.height} ${dict} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
        objects[logoId] = img(`/ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${logoId + 1} 0 R`, flate(LOGO.rgb));
        objects[logoId + 1] = img('/ColorSpace /DeviceGray /BitsPerComponent 8', flate(LOGO.alpha));
    }
    for (const f of embedded) f.objects.forEach((o, k) => { objects[f.id + k] = o; });

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

export default { statementPdf, renderStatementPdf, hasSinhala, pdfText, textWidth, wrapText, pdfFileName, PAGE };
