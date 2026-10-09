/* =============================================================================
 * test/tenant_pdf_test.js — the statement as a file a person keeps
 * -----------------------------------------------------------------------------
 * A PDF is read by an engine that is far less forgiving than a browser tab: one wrong byte offset and some
 * readers refuse the file. So the file is checked three ways: its structure by an independent walk of the
 * cross-reference table, its pages and words by pdf.js (the engine this app already trusts to read statements),
 * and its layout rules (width tables, wrapping, page breaks) as plain functions.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { statementPdf, pdfText, textWidth, wrapText, pdfFileName, PAGE } from '../tenant-pdf.mjs';
import { buildStatement } from '../tenant-statement.mjs';
import { nicHashOf, phoneHashOf } from '../tenant-links.mjs';
import { SECRET, CANON, T0, lenderDoc } from './helpers/tenant-fixture.js';

const nicHash = nicHashOf(CANON, SECRET);
const phoneHash = phoneHashOf('+94771234567', SECRET);
const stFor = (user, over = {}) => buildStatement({ ledgers: [{ uid: 'u', user, own: true }], nicHash, phoneHash, secret: SECRET, now: T0, ...over });
const acct = (over) => ({ id: 'a1', bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'Quote your reference', showTo: 'both', active: true, createdAt: '2026-01-01', ...over });

/** Every page's text as pdf.js reads it (the engine's own view of the file, not our bytes). */
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

/** An independent reader of the cross-reference table: every entry must point at "<n> 0 obj". */
function checkStructure(file) {
    const src = file.toString('latin1');
    expect(src.startsWith('%PDF-1.4\n')).toBe(true);
    expect(src.endsWith('%%EOF\n')).toBe(true);
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(src)[1]);
    expect(src.slice(start, start + 4)).toBe('xref');
    const m = /xref\n0 (\d+)\n([\s\S]*?)trailer\n<< \/Size (\d+) \/Root 1 0 R \/Info 5 0 R >>/.exec(src.slice(start));
    expect(Number(m[1])).toBe(Number(m[3]));
    const entries = m[2].split('\n').filter(Boolean);
    expect(entries).toHaveLength(Number(m[1]));
    expect(entries[0]).toBe('0000000000 65535 f ');
    entries.slice(1).forEach((line, i) => {
        expect(line).toMatch(/^\d{10} 00000 n $/);
        const off = Number(line.slice(0, 10));
        expect(src.slice(off, off + `${i + 1} 0 obj`.length), `object ${i + 1}`).toBe(`${i + 1} 0 obj`);
    });
    // every stream's declared length is its real length
    for (const s of src.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
        const from = s.index + s[0].length;
        expect(src.slice(from + Number(s[1]), from + Number(s[1]) + 10)).toBe('\nendstream');
    }
    return entries.length;
}

describe('which characters can be printed', () => {
    it('keeps ASCII, drops accents, maps typographic punctuation, and never emits something the fonts cannot draw', () => {
        expect(pdfText('N. Perera (Colombo)')).toBe('N. Perera (Colombo)');
        expect(pdfText('José Müller Çelik')).toBe('Jose Muller Celik');
        expect(pdfText('“quoted” – dash — more… it’s')).toBe('"quoted" - dash - more... it\'s');
        expect(pdfText('a\tb\nc\r\nd')).toBe('a b c d');
        expect(pdfText('a\u0000b\u007Fc')).toBe('abc');
        expect(pdfText(null)).toBe('');
        expect(pdfText(undefined)).toBe('');
        expect(pdfText(12.5)).toBe('12.5');
    });

    it('prints "?" for letters the standard fonts do not have (Sinhala, Tamil, Arabic, CJK, emoji), one for each, so nothing silently disappears', () => {
        expect(pdfText('සිංහල')).toMatch(/^\?+$/);
        expect(pdfText('Bank ශාඛාව 1')).toMatch(/^Bank \?+ 1$/);
        expect(pdfText('银行')).toBe('??');
        expect(pdfText('A😀B')).toBe('A?B');
        for (const text of ['සිංහල', 'தமிழ்', 'العربية', '中文', '😀']) expect(/^[\x20-\x7E]*$/.test(pdfText(text))).toBe(true);
    });
});

describe('measuring and wrapping', () => {
    it('uses the fonts\' own widths (Helvetica, and Helvetica-Bold for the bold lines)', () => {
        // H 722 e 556 l 222 l 222 o 556 = 2278 units
        expect(textWidth('Hello', false, 10)).toBeCloseTo(22.78, 5);
        expect(textWidth('Hello', false, 1000)).toBe(2278);
        expect(textWidth('A', true, 1000)).toBe(722);
        expect(textWidth('0123456789', false, 1000)).toBe(5560);                // digits are tabular, so a column of figures lines up
        expect(textWidth('', false, 10)).toBe(0);
    });

    it('wraps to the width and never loses a word', () => {
        const text = 'Pay by bank transfer to the account below and put the reference of the record in the transfer description';
        const lines = wrapText(text, false, 9.5, 200);
        expect(lines.length).toBeGreaterThan(2);
        for (const line of lines) expect(textWidth(line, false, 9.5)).toBeLessThanOrEqual(200 + 0.001);
        expect(lines.join(' ')).toBe(text);
    });

    it('breaks a single word that is longer than the line, and gives one empty line for nothing', () => {
        const lines = wrapText('X'.repeat(80), true, 10, 100);
        expect(lines.length).toBeGreaterThan(1);
        for (const line of lines) expect(textWidth(line, true, 10)).toBeLessThanOrEqual(100 + 0.001);
        expect(lines.join('')).toBe('X'.repeat(80));
        expect(wrapText('', false, 10, 100)).toEqual(['']);
    });
});

describe('the file', () => {
    it('is a well-formed PDF 1.4: every cross-reference entry points at its object and every stream is the length it says', () => {
        const file = statementPdf(stFor(lenderDoc({ payAccounts: [acct()] })), { generatedAt: T0 });
        expect(Buffer.isBuffer(file)).toBe(true);
        const pagesInFile = Number(/\/Type \/Pages \/Count (\d+)/.exec(file.toString('latin1'))[1]);
        expect(checkStructure(file)).toBe(6 + 2 * pagesInFile);                  // the free entry, 5 fixed objects, a page and its content for each page
        expect(file.length).toBeLessThan(20000);                                  // a few kilobytes: nothing is embedded
    });

    it('opens in pdf.js with the right title, page size, a page-numbered footer and the statement\'s words', async () => {
        const file = statementPdf(stFor(lenderDoc({ payAccounts: [acct()] })), { generatedAt: T0 });
        const { pages, info, numPages } = await read(file);
        expect(info.Title).toBe('WealthFlow statement');
        expect(info.Producer).toBe('WealthFlow');
        expect(numPages).toBe(pages.length);
        const all = pages.join(' ');
        expect(all).toContain('WEALTHFLOW');
        expect(all).toContain('As at: 05 Oct 2026, 10:30');
        expect(all).toMatch(/Statement No: WF-[0-9A-Z]{6}/);
        expect(all).toContain('Sri Lanka time');
        expect(all).toContain('LKR 500,000.00');
        expect(all).toMatch(/INV-[0-9A-F]{6}/);
        expect(all).toMatch(/DEB-[0-9A-F]{6}/);
        expect(all).toContain('Next interest due');
        expect(all).toContain('HOW TO PAY');
        expect(all).toContain('8001234567');
        expect(all).toContain('Commercial Bank');
        pages.forEach((p, i) => expect(p, `page ${i + 1}`).toContain(`Page ${i + 1} of ${numPages}`));
    });

    it('is the A4 size every printer has, and the date it was made is in the file', async () => {
        const file = statementPdf(stFor(lenderDoc()), { generatedAt: Date.parse('2026-10-05T05:00:00Z') });
        const src = file.toString('latin1');
        expect(src).toContain(`/MediaBox [0 0 ${PAGE.w} ${PAGE.h}]`);
        expect(src).toContain('/CreationDate (D:20261005050000Z)');
        expect(src).toContain('/BaseFont /Helvetica ');
        expect(src).toContain('/BaseFont /Helvetica-Bold ');
    });

    it('is the same bytes for the same statement, so a download can be compared with another', () => {
        const a = statementPdf(stFor(lenderDoc({ payAccounts: [acct()] })), { generatedAt: T0 });
        const b = statementPdf(stFor(lenderDoc({ payAccounts: [acct()] })), { generatedAt: T0 });
        expect(a.equals(b)).toBe(true);
    });

    it('breaks a long statement over pages: the table header repeats, no row is cut, and there is a page number on each', async () => {
        const user = lenderDoc({ payAccounts: [acct(), acct({ id: 'a2', bank: 'Sampath Bank', number: '1234 5678 9012', showTo: 'debtors', createdAt: '2026-01-02' })] });
        user.debtors[0].events = [{ id: 'e0', kind: 'lent', amount: 500000, date: '2026-01-01', confirmed: true }];
        for (let i = 1; i <= 80; i += 1) user.debtors[0].events.push({ id: `r${i}`, kind: 'repayment', amount: 1000, date: `2026-0${(i % 9) + 1}-1${i % 9}`, confirmed: true });
        const file = statementPdf(stFor(user), { generatedAt: T0 });
        checkStructure(file);
        const { pages, numPages } = await read(file);
        expect(numPages).toBeGreaterThanOrEqual(3);
        // the loan table's header appears on every page the table is on
        const withRows = pages.filter((p) => p.includes('Repayment'));
        expect(withRows.length).toBeGreaterThanOrEqual(2);
        for (const p of withRows) expect(p).toContain('DATE TRANSACTION AMOUNT (LKR) BALANCE (LKR)');
        // all 81 movements are in the file, none twice
        expect((pages.join(' ').match(/Repayment/g) || []).length).toBe(80);
        expect(pages.join(' ')).toContain('Loan paid out');
    });

    it('keeps the "How to pay" heading together with its first account, however the page falls', async () => {
        for (let rows = 0; rows <= 40; rows += 1) {
            const user = lenderDoc({ payAccounts: [acct({ note: 'x '.repeat(80) })] });
            user.debtors[0].events = [{ id: 'e0', kind: 'lent', amount: 500000, date: '2026-01-01', confirmed: true }];
            for (let i = 1; i <= rows; i += 1) user.debtors[0].events.push({ id: `r${i}`, kind: 'repayment', amount: 100, date: '2026-02-01', confirmed: true });
            const { pages } = await read(statementPdf(stFor(user), { generatedAt: T0 }));
            const at = pages.findIndex((p) => p.includes('HOW TO PAY'));
            expect(at, `rows ${rows}`).toBeGreaterThanOrEqual(0);
            expect(pages[at], `rows ${rows}`).toContain('Account number');
        }
    });

    it('has no payment section when the lender has put no account there, and no section for a kind the person has none of', async () => {
        const noPay = await read(statementPdf(stFor(lenderDoc()), { generatedAt: T0 }));
        expect(noPay.pages.join(' ')).not.toContain('HOW TO PAY');
        const user = lenderDoc({ payAccounts: [acct()] }); user.debtors = [];
        const inv = await read(statementPdf(stFor(user), { generatedAt: T0 }));
        const all = inv.pages.join(' ');
        expect(all).not.toContain('DEB-');
        expect(all).not.toContain('LOAN OUTSTANDING');
        expect(all).toContain('INVESTED');
    });

    it('names each lender when there is more than one, with that lender\'s references and accounts', async () => {
        const mine = lenderDoc({ payAccounts: [acct()] });
        const other = lenderDoc({ payAccounts: [acct({ id: 'o', bank: 'Peoples Bank', number: '9999999999' })] });
        const st = buildStatement({ ledgers: [{ uid: 'a', user: mine, own: true }, { uid: 'b', user: other, own: false }], nicHash, phoneHash, secret: SECRET, now: T0 });
        const { pages } = await read(statementPdf(st, { generatedAt: T0 }));
        const all = pages.join(' ');
        expect(all).toContain('Lender 1');
        expect(all).toContain('Lender 2');
        expect(all).toContain('Peoples Bank');
        expect(all).toContain('8001234567');
        expect(all).toContain('9999999999');
    });

    it('prints an unprintable account name as question marks rather than breaking, and escapes brackets and backslashes', async () => {
        const user = lenderDoc({ payAccounts: [acct({ holder: 'නිමල් (Perera) \\ Co' })] });
        const file = statementPdf(stFor(user), { generatedAt: T0 });
        checkStructure(file);
        const { pages } = await read(file);
        expect(pages.join(' ')).toMatch(/\?+ \(Perera\) \\ Co/);
    });

    it('says so when there is nothing to show, and when the statement was cut', async () => {
        const empty = await read(statementPdf(stFor({}), { generatedAt: T0 }));
        expect(empty.pages.join(' ')).toContain('There is nothing to show yet');
        const cut = await read(statementPdf({ ...stFor(lenderDoc()), truncated: true }, { generatedAt: T0 }));
        expect(cut.pages.join(' ')).toContain('only the first part is shown');
    });

    it('survives a statement that is not what it should be, and a missing clock', () => {
        for (const st of [null, undefined, {}, { groups: 'x', totals: 5, lenders: [null] }, { groups: [null, 1, {}], totals: [{}], lenders: [{ n: 1, accounts: [] }] }]) {
            // a hostile shape must not take the download down
            let out;
            try { out = statementPdf(st, {}); } catch (e) { out = e; }
            expect(Buffer.isBuffer(out), JSON.stringify(st)).toBe(true);
            checkStructure(out);
        }
    });

    it('is named for its date only, never for a person', () => {
        expect(pdfFileName('2026-10-05T05:00:00.000Z')).toBe('WealthFlow-statement-2026-10-05.pdf');
        expect(pdfFileName('')).toBe('WealthFlow-statement-latest.pdf');
        expect(pdfFileName('"; evil=1')).toBe('WealthFlow-statement-latest.pdf');
    });

    it('contains no compressed content that decompresses to anything but drawing operators', () => {
        const file = statementPdf(stFor(lenderDoc()), { generatedAt: T0 });
        const src = file.toString('latin1');
        let streams = 0;
        for (const m of src.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
            streams += 1;
            const text = zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
            expect(/^[\x20-\x7E\n]*$/.test(text)).toBe(true);
        }
        expect(streams).toBeGreaterThan(0);
    });
});

describe('the loan statement look', () => {
    it('has the loan statement\'s parts (details beside status, navy-headed movements with a total, a legend and a notice) and no signature or date line', async () => {
        const { pages } = await read(statementPdf(stFor(lenderDoc({ payAccounts: [acct()] })), { generatedAt: T0 }));
        const all = pages.join(' ');
        for (const want of ['Account Statement', 'LOAN DETAILS', 'ACCOUNT STATUS', 'ACCOUNT MOVEMENTS', 'TOTAL REPAID (1)', 'INTEREST RECEIVED (1)', 'TOTAL RECEIVED (1)', 'Legend:', 'not a substitute for your lender']) expect(all, want).toContain(want);
        expect(all).not.toMatch(/signature/i);
        expect(all).not.toMatch(/Account Holder/i);
        expect(all).not.toMatch(/\bDate:?\s*$/m);
    });

    it('numbers a statement from its moment, so the same statement carries the same number', async () => {
        const a = await read(statementPdf(stFor(lenderDoc({})), { generatedAt: T0 }));
        const b = await read(statementPdf(stFor(lenderDoc({})), { generatedAt: T0 + 86400000 }));
        const no = (r) => /Statement No: (WF-[0-9A-Z]{6})/.exec(r.pages[0])[1];
        expect(no(a)).toBe(no(b));
    });
});
