import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { readCheque } from '../wealthflow-cheques.js';
import { pdfLinesFromItems, readStatement } from '../statement-reader.mjs';

/* A cheque on a bank statement carries its number, but banks print it in many places: inside the description, on the line below it, after the balance, in a column of its own. These pin every shape the reader
 * has to get right, and the shapes it must leave alone (a bare number is only a cheque's when something says so). */
const parser = loadParser(fs);
const HEAD = ['SOME BANK PLC', 'Statement Period: 01/03/2026 - 31/03/2026', 'Account Number: 8001234567', 'Date Description Cheque No Debit Credit Balance', '01/03/2026 Opening Balance 500,000.00'];
function first(lines) {
    const parsed = parser.parseStatement([...HEAD, ...lines].join('\n'));
    const row = parsed.rows[0];
    return { rows: parsed.rows.length, narration: row?.narration, cheque: row ? readCheque({ description: row.narration, direction: row.direction, amount: row.amount }) : null };
}

describe('cheque number on the statement line', () => {
    it.each([
        ['inside the description', ['12/03/2026 CHEQUE DEPOSIT 285943 50,000.00 550,000.00']],
        ['on a line of its own below the row', ['12/03/2026 CHEQUE DEPOSIT 50,000.00 550,000.00', '285943']],
        ['below the row with a label and the payer', ['12/03/2026 CHEQUE DEPOSIT 50,000.00 550,000.00', 'No 285943 RAJ TRADERS']],
        ['after the balance', ['12/03/2026 CHEQUE DEPOSIT 50,000.00 550,000.00 285943']],
        ['after the balance with a label', ['12/03/2026 CHEQUE DEPOSIT 50,000.00 550,000.00 CHQ NO 285943']],
        ['glued to the type word', ['12/03/2026 CHQDEP285943 50,000.00 550,000.00']],
    ])('reads %s', (_name, lines) => {
        const r = first(lines);
        expect(r.rows).toBe(1);
        expect(r.cheque.isCheque).toBe(true);
        expect(r.cheque.no).toBe('285943');
        expect(r.cheque.type).toBe('received');
    });

    it('reads the Sinhala word', () => {
        const r = first(['12/03/2026 චෙක්පත 285943 50,000.00 550,000.00']);
        expect(r.cheque.isCheque).toBe(true);
        expect(r.cheque.no).toBe('285943');
    });

    it('leaves a bare number under a row that is not a cheque alone', () => {
        const r = first(['12/03/2026 SALARY MARCH 50,000.00 550,000.00', '285943']);
        expect(r.rows).toBe(1);
        expect(r.cheque.isCheque).toBe(false);
        expect(r.narration).not.toContain('285943');
    });

    it('keeps a cheque with no number as a cheque with no number', () => {
        const r = first(['12/03/2026 CHEQUE DEPOSIT 50,000.00 550,000.00']);
        expect(r.cheque.isCheque).toBe(true);
        expect(r.cheque.no).toBe('');
    });
});

const cell = (str, x, y, width) => ({ str, transform: [1, 0, 0, 1, x, y], width: width ?? str.length * 5 });
const page = (rows, top = 700) => rows.flatMap((cells, i) => cells.map(([str, x, width]) => cell(str, x, top - i * 14, width)));

describe('cheque number column of a PDF statement', () => {
    const header = [['Date', 30], ['Description', 90], ['Cheque', 250], ['No', 285], ['Debit', 340], ['Credit', 400], ['Balance', 470]];

    it('tags the number under the Cheque No header even when the description names no cheque', () => {
        const lines = pdfLinesFromItems(page([header,
            [['12/03/2026', 30], ['LOCAL DEPOSIT', 90], ['285943', 250], ['50,000.00', 400], ['550,000.00', 470]],
            [['13/03/2026', 30], ['RAJ TRADERS', 90], ['000123', 250], ['10,000.00', 340], ['540,000.00', 470]],
            [['14/03/2026', 30], ['SALARY', 90], ['25,000.00', 400], ['565,000.00', 470]]]));
        expect(lines[1]).toBe('12/03/2026 LOCAL DEPOSIT Cheque No 285943 50,000.00 550,000.00');
        expect(lines[2]).toBe('13/03/2026 RAJ TRADERS Cheque No 000123 10,000.00 540,000.00');
        expect(lines[3]).toBe('14/03/2026 SALARY 25,000.00 565,000.00');
    });

    it('does not turn the bank\'s all-zero filler into a cheque', () => {
        const lines = pdfLinesFromItems(page([header, [['12/03/2026', 30], ['ATM WITHDRAWAL', 90], ['000000', 250], ['5,000.00', 340], ['545,000.00', 470]]]));
        expect(lines[1]).toBe('12/03/2026 ATM WITHDRAWAL 000000 5,000.00 545,000.00');
    });

    it('leaves digits in other columns alone', () => {
        const lines = pdfLinesFromItems(page([header, [['12/03/2026', 30], ['REF 123456789', 90], ['5,000.00', 340], ['545,000.00', 470]]]));
        expect(lines[1]).not.toContain('Cheque No');
    });

    it('takes a "Chq/Ref No" number only on a row that names a cheque, and carries the column to the next page', () => {
        const mixed = [['Date', 30], ['Narration', 90], ['Chq/Ref No', 250], ['Debit', 340], ['Credit', 400], ['Balance', 470]];
        const carry = {};
        const one = pdfLinesFromItems(page([mixed,
            [['12/03/2026', 30], ['CHEQUE DEPOSIT', 90], ['285943', 250], ['50,000.00', 400], ['550,000.00', 470]],
            [['13/03/2026', 30], ['ATM WDL', 90], ['8801234', 250], ['5,000.00', 340], ['545,000.00', 470]]]), 2, carry);
        const two = pdfLinesFromItems(page([[['15/03/2026', 30], ['CHEQUE PAID', 90], ['000777', 250], ['5,000.00', 340], ['540,000.00', 470]]]), 2, carry);
        expect(one[1]).toBe('12/03/2026 CHEQUE DEPOSIT Cheque No 285943 50,000.00 550,000.00');
        expect(one[2]).toBe('13/03/2026 ATM WDL 8801234 5,000.00 545,000.00');
        expect(two[0]).toBe('15/03/2026 CHEQUE PAID Cheque No 000777 5,000.00 540,000.00');
    });

    it('still reads a page with no header at all as before', () => {
        const lines = pdfLinesFromItems(page([[['12/03/2026', 30], ['LOCAL DEPOSIT', 90], ['285943', 250], ['50,000.00', 400]]]));
        expect(lines).toEqual(['12/03/2026 LOCAL DEPOSIT 285943 50,000.00']);
    });

    it('goes all the way: the statement reader hands the Cheque Tracker the number', () => {
        const lines = pdfLinesFromItems(page([header, [['12/03/2026', 30], ['LOCAL DEPOSIT', 90], ['285943', 250], ['50,000.00', 400], ['550,000.00', 470]]]));
        const parsed = parser.parseStatement([...HEAD.slice(0, 3), ...lines.slice(0, 1), '01/03/2026 Opening Balance 500,000.00', ...lines.slice(1)].join('\n'));
        const c = readCheque({ description: parsed.rows[0].narration, direction: parsed.rows[0].direction, amount: parsed.rows[0].amount });
        expect(c.isCheque).toBe(true);
        expect(c.no).toBe('285943');
    });
});

describe('cheque number column of an HTML statement', () => {
    const doc = (head, body) => Buffer.from(`<html><body><h1>Some Bank PLC</h1><p>Statement Period: 01/03/2026 - 31/03/2026</p><p>Account Number: 8001234567</p><table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></body></html>`);
    const read = async (head, body) => (await readStatement({ bytes: doc(head, body), filename: 's.html', passwords: [] })).parsed.rows;

    it.each([
        ['Cheque No'], ['Chq No'], ['Instrument No'], ['Instr. No'], ['Cheque Number'],
    ])('reads the number under "%s"', async (label) => {
        const rows = await read(['Date', 'Description', label, 'Debit', 'Credit', 'Balance'], [['12/03/2026', 'LOCAL DEPOSIT', '285943', '', '50,000.00', '550,000.00']]);
        const c = readCheque({ description: rows[0].narration, direction: rows[0].direction, amount: rows[0].amount });
        expect(c.no).toBe('285943');
        expect(c.isCheque).toBe(true);
    });

    it('reads a labelled cell and skips the all-zero filler', async () => {
        const rows = await read(['Date', 'Description', 'Cheque No', 'Debit', 'Credit', 'Balance'], [
            ['12/03/2026', 'LOCAL DEPOSIT', 'CHQ-285943', '', '50,000.00', '550,000.00'],
            ['13/03/2026', 'ATM WITHDRAWAL', '000000', '5,000.00', '', '545,000.00']]);
        expect(rows[0].narration).toContain('285943');
        expect(rows[1].narration).not.toContain('000000');
    });

    it('takes a "Chq/Ref No" number only on a row that names a cheque', async () => {
        const rows = await read(['Date', 'Description', 'Chq/Ref No', 'Debit', 'Credit', 'Balance'], [
            ['12/03/2026', 'CHEQUE DEPOSIT', '285943', '', '50,000.00', '550,000.00'],
            ['13/03/2026', 'ATM WDL', '8801234', '5,000.00', '', '545,000.00']]);
        expect(rows[0].narration).toContain('285943');
        expect(rows[1].narration).not.toContain('8801234');
    });
});
