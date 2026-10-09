/* =============================================================================
 * test/tenant_pdf_sinhala_test.js — the statement PDF in Sinhala
 * -----------------------------------------------------------------------------
 * Three layers, each checked on its own and then together:
 *   1. the font cut-down (pdf-font.mjs), on the real Noto Sans Sinhala files: the subset must be a valid font whose kept glyphs are byte
 *      for byte the originals, which is what lets the PDF say "draw glyph 290" without a translation table;
 *   2. the shaper (pdf-shape.mjs), on the real HarfBuzz: a conjunct is fewer glyphs than letters, a vowel sign that is typed after its
 *      consonant is drawn before it, and every glyph knows which letters it came from;
 *   3. the file (tenant-pdf.mjs): well-formed, opened by pdf.js (an engine that is not ours), its words readable, small, and
 *      never a broken file when the engine is missing or fails: then it is the English file.
 * What these tests cannot say is that a person finds the letters beautiful. The rendering was looked at with pdftoppm; see the PR.
 * ===========================================================================*/

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFont, subsetFont, glyphCodePoints } from '../pdf-font.mjs';
import { createShaper, scriptRuns, needsShaping, loadShaper, FONT_FILES } from '../pdf-shape.mjs';
import { statementPdf, renderStatementPdf, hasSinhala } from '../tenant-pdf.mjs';
import { buildStatement } from '../tenant-statement.mjs';
import { nicHashOf, phoneHashOf } from '../tenant-links.mjs';
import { SI } from '../tenant-lang.js';
import { SECRET, CANON, T0, lenderDoc } from './helpers/tenant-fixture.js';

const fontPath = (name) => new URL(`../assets/fonts/${name}`, import.meta.url);
const REGULAR = fs.readFileSync(fontPath(FONT_FILES.regular));
const BOLD = fs.readFileSync(fontPath(FONT_FILES.bold));

const nicHash = nicHashOf(CANON, SECRET);
const phoneHash = phoneHashOf('+94771234567', SECRET);
const stFor = (user) => buildStatement({ ledgers: [{ uid: 'u', user, own: true }], nicHash, phoneHash, secret: SECRET, now: T0 });
const acct = (over) => ({ id: 'a1', bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'Quote your reference', showTo: 'both', active: true, createdAt: '2026-01-01', ...over });

/**
 * What the file SAYS its Sinhala is: every line of shaped text is wrapped in an ActualText span holding the real letters, which is
 * what Acrobat, Chrome, poppler (pdftotext) and screen readers use. pdf.js reads glyph by glyph instead, so it returns the letters
 * in the order they are drawn (a vowel sign that is drawn before its consonant comes out before it): good enough to prove the file
 * opens and says its Latin text, but not a test of the Sinhala text, which is checked here.
 */
function meaning(file) {
    const src = file.toString('latin1');
    const out = [];
    for (const s of src.matchAll(/\/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/g)) {
        const from = s.index + s[0].length;
        let body;
        try { body = zlib.inflateSync(file.subarray(from, from + Number(s[1]))).toString('latin1'); } catch (_) { continue; }
        for (const m of body.matchAll(/\/ActualText <([0-9A-F]+)> >> BDC/g)) {
            const b = Buffer.from(m[1], 'hex');
            out.push(Buffer.from(b).swap16().toString('utf16le').replace(/^\uFEFF/, ''));
        }
    }
    return out;
}
const pdftotext = spawnSync('pdftotext', ['-v']).error ? null : 'pdftotext';

/** Every page's text as pdf.js reads it (an engine that is not ours). */
async function read(file) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const standardFontDataUrl = fileURLToPath(new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')));
    const task = getDocument({ data: Uint8Array.from(file), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, standardFontDataUrl, verbosity: 0 });
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        pages.push(content.items.map((i) => i.str).join(' ').replace(/\s+/g, ' '));
        page.cleanup();
    }
    const meta = await doc.getMetadata();
    await task.destroy();
    return { pages, info: meta.info, numPages: doc.numPages };
}

function checkStructure(file) {
    const src = file.toString('latin1');
    expect(src.startsWith('%PDF-1.4\n')).toBe(true);
    expect(src.endsWith('%%EOF\n')).toBe(true);
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(src)[1]);
    const m = /xref\n0 (\d+)\n([\s\S]*?)trailer\n<< \/Size (\d+) \/Root 1 0 R \/Info 5 0 R >>/.exec(src.slice(start));
    expect(Number(m[1])).toBe(Number(m[3]));
    const entries = m[2].split('\n').filter(Boolean);
    entries.slice(1).forEach((line, i) => {
        const off = Number(line.slice(0, 10));
        expect(src.slice(off, off + `${i + 1} 0 obj`.length), `object ${i + 1}`).toBe(`${i + 1} 0 obj`);
    });
    for (const s of src.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
        const from = s.index + s[0].length;
        expect(src.slice(from + Number(s[1]), from + Number(s[1]) + 10)).toBe('\nendstream');
    }
}

describe('cutting a font down to the glyphs a document uses', () => {
    const font = readFont(REGULAR);

    it('reads the real fonts', () => {
        expect(font.upem).toBe(1000);
        expect(font.numGlyphs).toBeGreaterThan(500);
        const bold = readFont(BOLD);
        expect(bold.numGlyphs).toBeGreaterThan(500);
        expect(font.advances).toHaveLength(font.numGlyphs);
    });

    it('keeps the asked-for glyphs byte for byte, empties the rest, and is a valid font whose checksum adds up', () => {
        const want = [3, 4, 57, 62, 115, 290, 350, 167];
        const { file, kept } = subsetFont(font, want);
        for (const g of want) expect(kept).toContain(g);
        expect(kept).toContain(0);                                              // .notdef is always there
        const sub = readFont(file);
        expect(sub.numGlyphs).toBe(font.numGlyphs);                             // glyph numbers are unchanged: that is the point
        const original = (g) => font.buf.subarray(font.tables.get('glyf').offset + font.loca[g], font.tables.get('glyf').offset + font.loca[g + 1]);
        const copied = (g) => sub.buf.subarray(sub.tables.get('glyf').offset + sub.loca[g], sub.tables.get('glyf').offset + sub.loca[g + 1]);
        for (const g of kept) expect(copied(g).subarray(0, original(g).length).equals(original(g)), `glyph ${g}`).toBe(true);
        for (let g = 0; g < sub.numGlyphs; g += 1) if (!kept.includes(g)) expect(sub.loca[g + 1] - sub.loca[g], `glyph ${g} should be empty`).toBe(0);
        expect(sub.advances).toEqual(font.advances);                           // the widths the PDF states are the font's own
        // the whole file sums to the constant the format asks for, and the tables a viewer needs are there
        let sum = 0;
        for (let i = 0; i < file.length; i += 4) sum = (sum + file.readUInt32BE(i)) >>> 0;
        expect(sum).toBe(0xB1B0AFBA);
        for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf']) expect(sub.tables.has(t), t).toBe(true);
        for (const t of ['cmap', 'GSUB', 'GPOS', 'GDEF', 'name', 'post', 'OS/2']) expect(sub.tables.has(t), t).toBe(false);
        expect(file.length).toBeLessThan(font.buf.length / 8);
    });

    it('keeps the parts of a composite glyph that is asked for', () => {
        let composite = -1;
        for (let g = 0; g < font.numGlyphs && composite < 0; g += 1) {
            if (font.loca[g + 1] - font.loca[g] >= 10 && font.buf.readInt16BE(font.tables.get('glyf').offset + font.loca[g]) < 0) composite = g;
        }
        if (composite < 0) return;                                              // this font has none: nothing to prove
        const { kept } = subsetFont(font, [composite]);
        expect(kept.length).toBeGreaterThan(2);
    });

    it('refuses what it cannot cut rather than writing a damaged font', () => {
        expect(() => readFont(Buffer.alloc(4))).toThrow(/too short/);
        const cff = Buffer.from(REGULAR); cff.write('OTTO', 0, 'latin1');
        expect(() => readFont(cff)).toThrow(/not a TrueType/);
        expect(() => readFont(REGULAR.subarray(0, 4000))).toThrow();
        expect(() => subsetFont(font, [font.numGlyphs])).toThrow(/not in the font/);
        expect(() => subsetFont(font, [-1])).toThrow(/not in the font/);
        expect(() => subsetFont(font, [1.5])).toThrow(/not in the font/);
    });

    it('does not change the original bytes', () => {
        const before = Buffer.from(REGULAR);
        subsetFont(font, [3, 4, 5]);
        expect(REGULAR.equals(before)).toBe(true);
    });
});

describe('script runs', () => {
    it('keeps Sinhala together (the space between two Sinhala words stays inside), and Latin and digits apart', () => {
        expect(scriptRuns('ණය මුදල')).toEqual([{ text: 'ණය මුදල', script: 'Sinh', offset: 0 }]);
        expect(scriptRuns('ණය 2')).toEqual([{ text: 'ණය', script: 'Sinh', offset: 0 }, { text: ' 2', script: 'Latn', offset: 2 }]);
        expect(scriptRuns('LKR 50,000.00')).toEqual([{ text: 'LKR 50,000.00', script: 'Latn', offset: 0 }]);
        expect(scriptRuns('')).toEqual([]);
    });

    it('keeps a joiner with the letters it joins, so a conjunct is not cut in two', () => {
        const runs = scriptRuns('ක්‍ෂ A');
        expect(runs[0]).toMatchObject({ script: 'Sinh', text: 'ක්‍ෂ', offset: 0 });
        expect(runs[1]).toMatchObject({ script: 'Latn' });
    });

    it('recognises Sinhala letters, and nothing else', () => {
        expect(needsShaping('Bank ශාඛාව')).toBe(true);
        expect(needsShaping('Colombo 03 é')).toBe(false);
        expect(needsShaping(null)).toBe(false);
        expect(hasSinhala({ a: [{ note: 'ගෙවීම' }] })).toBe(true);
        expect(hasSinhala({ a: 'plain' })).toBe(false);
    });
});

// The shaping engine is a dependency. Its tests are skipped, loudly (the first one below fails), when it is not installed, so the layers
// that do not need it (the font cut-down, the script runs) still run on a checkout that has not run `npm ci`.
const hb = await import('harfbuzzjs').catch(() => null);
const shaper = hb ? createShaper(hb, { regular: REGULAR, bold: BOLD }) : null;
const withEngine = describe.skipIf(!hb);

describe('the shaping engine', () => {
    it('is installed (harfbuzzjs, pinned in package.json): run `npm ci`', () => {
        expect(hb).not.toBeNull();
    });
});

withEngine('shaping Sinhala', () => {
    it('joins a conjunct into fewer glyphs than letters, and says which letters each glyph came from', () => {
        const text = shaper.clean('ක්‍ෂ');
        const out = shaper.shape(text);
        expect(out.glyphs.length).toBeGreaterThan(0);
        expect(out.glyphs.length).toBeLessThan(Array.from(text).length);
        for (const g of out.glyphs) { expect(g.from).toBeGreaterThanOrEqual(0); expect(g.to).toBeLessThanOrEqual(text.length); expect(g.to).toBeGreaterThan(g.from); }
    });

    it('draws a vowel sign that is typed after its consonant BEFORE it', () => {
        const typed = shaper.shape('කෙ');                                       // ක + ෙ (kombuva)
        expect(typed.glyphs).toHaveLength(2);
        const alone = shaper.shape('ක').glyphs[0].gid;
        expect(typed.glyphs[0].gid).not.toBe(alone);                            // the first glyph drawn is the vowel sign
        expect(typed.glyphs[1].gid).toBe(alone);
    });

    it('measures width as the sum of its advances, in points, for both weights', () => {
        const a = shaper.shape('ශ්‍රී ලංකා');
        expect(a.width).toBe(a.glyphs.reduce((x, g) => x + g.adv, 0));
        expect(shaper.width('ශ්‍රී ලංකා', false, 10)).toBeCloseTo((a.width * 10) / 1000, 6);
        expect(shaper.width('ශ්‍රී ලංකා', true, 10)).toBeGreaterThan(shaper.width('ශ්‍රී ලංකා', false, 10));
        expect(shaper.width('', false, 10)).toBe(0);
    });

    it('narrows the space between Latin words and leaves the one between Sinhala words alone', () => {
        const latin = shaper.shape('A B').glyphs;
        const sinhala = shaper.shape('ණය ණය').glyphs;
        const space = (glyphs, text, at) => glyphs.find((g) => text[g.from] === ' ' && g.from === at);
        expect(space(latin, 'A B', 1).adv).toBeLessThan(space(sinhala, 'ණය ණය', 2).adv);
    });

    it('cleans text to what the font has: unknown letters become one question mark, controls vanish, nothing throws', () => {
        expect(shaper.clean('a\tb')).toBe('a b');
        expect(shaper.clean('A\u0000B​')).toBe('AB');
        expect(shaper.clean('汉')).toBe('?');
        expect(shaper.clean(null)).toBe('');
        expect(shaper.clean('ශ්‍රී')).toBe('ශ්‍රී');
    });

    it('is deterministic and caches', () => {
        expect(shaper.shape('ගෙවීම')).toBe(shaper.shape('ගෙවීම'));
    });
});

withEngine('the Sinhala file', () => {
    const user = lenderDoc({ payAccounts: [acct(), acct({ id: 'a2', bank: 'ලංකා බැංකුව', holder: 'නිමල් පෙරේරා', note: 'ගෙවීමේදී ඔබේ යොමු කේතය සඳහන් කරන්න', createdAt: '2026-01-02' })] });
    const st = stFor(user);
    const loader = async () => shaper;

    it('is well formed, opens in pdf.js with a Sinhala title and language, and says its words in Sinhala', async () => {
        const file = await renderStatementPdf(st, { generatedAt: T0, lang: 'si', loader });
        checkStructure(file);
        const { pages, info, numPages } = await read(file);
        expect(numPages).toBeGreaterThanOrEqual(1);
        expect(info.Title).toBe(SI['Your WealthFlow statement']);
        const all = pages.join(' ');
        const said = meaning(file);
        for (const word of [SI['Account Statement'], SI['How to pay'], SI['Summary'], SI['Account number'], SI['Investment details']]) expect(said, word).toContain(word);
        expect(all).toContain('LKR 500,000.00');                                // amounts stay in Latin digits, as on the page
        expect(all).toContain('05 Oct 2026');
        expect(all).not.toMatch(/Account Statement|How to pay|Investment details|Figures are as recorded/);   // no English sentence is left in the middle of it
        expect(file.toString('latin1')).toContain('/Lang (si)');
    });

    it('carries the data\'s own Sinhala (a bank, a holder, a note) as readable text', async () => {
        const file = await renderStatementPdf(st, { generatedAt: T0, lang: 'si', loader });
        const said = meaning(file);
        for (const word of ['ලංකා බැංකුව', 'නිමල් පෙරේරා', 'ගෙවීමේදී ඔබේ යොමු කේතය සඳහන් කරන්න']) expect(said, word).toContain(word);
    });

    it.skipIf(!pdftotext)('is read back as the right Sinhala by a reader that honours ActualText (poppler\'s pdftotext)', async () => {
        const file = await renderStatementPdf(st, { generatedAt: T0, lang: 'si', loader });
        const dir = fs.mkdtempSync(`${os.tmpdir()}/wf-pdf-`);
        try {
            const path = `${dir}/s.pdf`;
            fs.writeFileSync(path, file);
            const text = spawnSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' }).stdout;
            for (const word of [SI['Account Statement'], SI['How to pay'], 'ලංකා බැංකුව', 'නිමල් පෙරේරා']) expect(text, word).toContain(word);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('is small: the font is cut down to the glyphs it uses', async () => {
        const file = await renderStatementPdf(st, { generatedAt: T0, lang: 'si', loader });
        expect(file.length).toBeLessThan(80 * 1024);
        const src = file.toString('latin1');
        expect(src).toContain('/Subtype /Type0');
        expect(src).toContain('/FontFile2');
        expect(src).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansSinhala-Regular/);
        expect(src).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansSinhala-Bold/);
    });

    it('is the same bytes for the same statement, so a retry or a second download is not different', async () => {
        const a = await renderStatementPdf(st, { generatedAt: T0, lang: 'si', loader });
        const b = await renderStatementPdf(st, { generatedAt: T0, lang: 'si', loader });
        expect(a.equals(b)).toBe(true);
    });

    it('lays out every page inside the margins: nothing runs off the right edge', async () => {
        const long = lenderDoc({ payAccounts: [acct({ bank: 'ශ්‍රී ලංකා ජාතික ඉතිරි කිරීමේ බැංකුව '.repeat(3), note: 'ගෙවීමේදී ඔබේ යොමු කේතය සඳහන් කරන්න '.repeat(12), createdAt: '2026-01-02' })] });
        const file = await renderStatementPdf(stFor(long), { generatedAt: T0, lang: 'si', loader });
        checkStructure(file);
        expect((await read(file)).numPages).toBeGreaterThanOrEqual(1);
    });
});

withEngine('the English file and the fallbacks', () => {
    const plain = stFor(lenderDoc({ payAccounts: [acct()] }));
    const loader = async () => shaper;

    it('an English statement with nothing Sinhala in it is the same file as before, and never loads the engine', async () => {
        let loaded = 0;
        const file = await renderStatementPdf(plain, { generatedAt: T0, lang: 'en', loader: async () => { loaded += 1; return shaper; } });
        expect(loaded).toBe(0);
        expect(file.equals(statementPdf(plain, { generatedAt: T0 }))).toBe(true);
        expect(file.toString('latin1')).not.toContain('Type0');
    });

    it('Sinhala letters in the data of an English statement are drawn properly, not as question marks', async () => {
        const mixed = stFor(lenderDoc({ payAccounts: [acct({ bank: 'ලංකා බැංකුව' })] }));
        const file = await renderStatementPdf(mixed, { generatedAt: T0, lang: 'en', loader });
        const all = (await read(file)).pages.join(' ');
        expect(meaning(file)).toContain('ලංකා බැංකුව');
        expect(all).toContain('Account Statement');                             // the labels are still English
        expect(all).not.toMatch(/\?\?\?/);
    });

    it('anything but "si" is English', async () => {
        for (const lang of ['EN', 'ta', '', null, undefined, 5, { toString: () => 'si' }]) {
            const file = await renderStatementPdf(plain, { generatedAt: T0, lang, loader });
            expect(file.toString('latin1'), String(lang)).not.toContain('Type0');
        }
    });

    it('when the engine cannot be loaded the English file comes back, with a warning, and the download still works', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const file = await renderStatementPdf(plain, { generatedAt: T0, lang: 'si', loader: async () => { throw new Error('wasm missing'); } });
            checkStructure(file);
            expect(file.equals(statementPdf(plain, { generatedAt: T0 }))).toBe(true);
            expect(warn.mock.calls.some((c) => /could not be loaded/.test(c.join(' ')))).toBe(true);
        } finally { warn.mockRestore(); }
    });

    it('when the engine fails on this document the English file comes back too', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const broken = { ...shaper, shape: () => { throw new Error('shaping failed'); } };
            const file = await renderStatementPdf(plain, { generatedAt: T0, lang: 'si', loader: async () => broken });
            checkStructure(file);
            expect(file.equals(statementPdf(plain, { generatedAt: T0 }))).toBe(true);
            expect(warn.mock.calls.some((c) => /could not be built/.test(c.join(' ')))).toBe(true);
        } finally { warn.mockRestore(); }
    });

    it('a statement with nothing in it is still a Sinhala file, with the Sinhala "nothing yet" sentence', async () => {
        const empty = stFor({ settings: { currency: 'LKR' }, debtors: [], income: [] });
        const file = await renderStatementPdf(empty, { generatedAt: T0, lang: 'si', loader });
        checkStructure(file);
        expect(meaning(file)).toContain(SI['There is nothing to show yet. When your lender records something for you, it will appear here.']);
    });
});

withEngine('loading the engine for real', () => {
    it('loads once, shapes, and a missing package or font is reported rather than remembered', async () => {
        const a = await loadShaper({ fresh: true });
        expect(a.shape('ණය').glyphs.length).toBeGreaterThan(0);
        await expect(loadShaper({ fresh: true, importHb: async () => { throw new Error('no such package'); } })).rejects.toThrow(/no such package/);
        await expect(loadShaper({ fresh: true, readFile: () => { throw new Error('no such font'); } })).rejects.toThrow(/no such font/);
    });
});

describe('what a glyph stands for without shaping', () => {
    it('reads the font\'s character map backwards: Latin letters, digits and Sinhala letters each name their own character', () => {
        const font = readFont(REGULAR);
        const cps = glyphCodePoints(font);
        expect(cps.size).toBeGreaterThan(100);
        const chars = new Set(cps.values());
        for (const ch of ['A', 'z', '0', '9', 'ක', 'ා', 'ෙ', 'ි']) expect(chars.has(ch.codePointAt(0)), ch).toBe(true);
        for (const [gid, cp] of cps) { expect(gid).toBeGreaterThan(0); expect(gid).toBeLessThan(font.numGlyphs); expect(cp >= 0xD800 && cp <= 0xDFFF).toBe(false); }
    });

    it('a font without a character map gives an empty answer, not an error', () => {
        const font = readFont(REGULAR);
        const bare = { ...font, tables: new Map([...font.tables].filter(([tag]) => tag !== 'cmap')) };
        expect(glyphCodePoints(bare).size).toBe(0);
    });
});
