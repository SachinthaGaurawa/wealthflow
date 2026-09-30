import { describe, expect, it, vi } from 'vitest';
import { isPhantomRow, isMoneyless, scanStatementText, assessEmptiness, redactForWitness, witnessPrompt, witnessEmpty } from '../statement-emptiness.mjs';

// A month with no transactions is real. Closing one as empty is the automatic decision that hides a whole
// statement if it is wrong, so these tests try hard to make it wrong: hidden transactions, layouts where the
// date and the amount are on different lines, merchants named like balances.
const head = ['HATTON NATIONAL BANK PLC', 'Account Statement', 'Account No 074-02-XXXXX-88', 'Statement Period 01/04/2024 - 30/04/2024', 'Date Description Cheque No Debit Credit Balance'];
const text = (...tail) => [...head, ...tail].join('\n');
const phantom = { date: '2024-04-30', narration: '', amount: 0, direction: '', balance: 0, valid: false, needsReview: true };
const real = { date: '2024-04-05', narration: 'POS SHOP ONE', amount: 1500, direction: 'debit', valid: true };

describe('a phantom row is a row with no money and no words', () => {
    it.each([
        ['a zero amount and a blank description', { amount: 0, narration: '', description: '' }],
        ['an unreadable amount and nothing else', { amount: NaN }],
        ['a missing amount and whitespace', { description: '   ' }],
        ['punctuation only', { amount: 0, narration: '--' }],
    ])('%s', (_, row) => expect(isPhantomRow({ date: '2024-04-30', ...row })).toBe(true));
    it.each([
        ['an amount with no description (a real transaction whose words were lost)', { amount: 100, narration: '' }],
        ['a zero amount WITH words (a line that moved nothing)', { amount: 0, narration: 'Int.Pd 0.00' }],
        ['words and an unreadable amount (a misread)', { amount: NaN, narration: 'SALARY' }],
        ['a reference and nothing else', { amount: 0, ref: 'FT2402' }],
    ])('but not %s', (_, row) => expect(isPhantomRow({ date: '2024-04-30', ...row })).toBe(false));
    it('is false for anything that is not a row', () => { for (const v of [null, undefined, 7, 'x']) expect(isPhantomRow(v)).toBe(false); });
});

describe('a row that moves no money', () => {
    it('is a phantom or an exact zero, never a misread', () => {
        expect(isMoneyless({ amount: 0, narration: 'Interest' })).toBe(true);
        expect(isMoneyless({ amount: 0, narration: '' })).toBe(true);
        expect(isMoneyless({ amount: NaN, narration: '' })).toBe(true);
        for (const row of [{ amount: NaN, narration: 'SALARY' }, { amount: -5, narration: 'X' }, { amount: '0.00', narration: 'Y' }, { amount: 10, narration: '' }, null]) expect(isMoneyless(row), JSON.stringify(row)).toBe(false);
    });
    it('does not make a statement with a misread row look empty', () => expect(assessEmptiness({ text: text('Opening Balance 1.00', 'Closing Balance 1.00'), parsed: { rows: [{ amount: NaN, narration: 'SALARY' }] } })).toMatchObject({ decision: 'has-transactions' }));
    it('lets a statement of only "Interest 0.00" lines be judged on its text', () => expect(assessEmptiness({ text: text('01/04/2024 B/F 0.00', '30/04/2024 Interest 0.00 0.00', '30/04/2024 C/F 0.00'), parsed: { rows: [{ amount: 0, narration: 'Interest' }] } })).toMatchObject({ decision: 'empty', strength: 'strong' }));
});

describe('what the statement text says about money moving', () => {
    it('reads opening and closing balance lines, in every label banks use, and ignores the dates on them', () => {
        for (const [open, close] of [['Opening Balance 12,345.67', 'Closing Balance 12,345.67'], ['01/04/2024 Balance B/F 12,345.67', '30/04/2024 Balance C/F 12,345.67'],
            ['Balance Brought Forward 12,345.67', 'Balance Carried Forward 12,345.67'], ['01-04-2024 OPENING BALANCE 12,345.67', '30-04-2024 CLOSING BALANCE 12,345.67'], ['B/F 12,345.67', 'C/F 12,345.67']]) {
            const s = scanStatementText(text(open, close));
            expect(s.openings, open).toEqual([1234567]); expect(s.closings, close).toEqual([1234567]); expect(s.suspect).toBe(0);
        }
    });
    it('does not read a date as an amount', () => { expect(scanStatementText(text('30.04.2024 Nil 0.00')).suspect).toBe(0); expect(scanStatementText(text('30.04.2024')).suspect).toBe(0); });
    it('does not read an account number or a page number as money', () => expect(scanStatementText(text('Page 1 of 1', 'Account 074020000088')).suspect).toBe(0));
    it('counts a line with a date and only zero amounts as a zero line', () => { const s = scanStatementText(text('30/04/2024 0.00 0.00')); expect(s).toMatchObject({ zeroLines: 1, suspect: 0 }); });
    it('counts positive money on any other line as suspect, dated or not, on one line or split across two', () => {
        expect(scanStatementText(text('01/04/2024 POS SHOP ONE 1,500.00 10,845.67')).suspect).toBe(1);
        expect(scanStatementText(text('01/04/2024 POS SHOP ONE', '1,500.00 10,845.67')).suspect).toBe(1);
        expect(scanStatementText(text('SHOP ONE 1500.00')).suspect).toBe(1);
        expect(scanStatementText(text('Apr 5 ATM WITHDRAWAL 20,000.00')).suspect).toBe(1);
    });
    it('does not let a merchant hide behind a balance word', () => {
        expect(scanStatementText(text('05/04/2024 BALANCE TRANSFER 50,000.00')).suspect).toBe(1);
        expect(scanStatementText(text('05/04/2024 TOTAL WINE AND SPIRITS 4,200.00')).suspect).toBe(1);
        expect(scanStatementText(text('05/04/2024 OPENING SOON RESTAURANT 900.00')).suspect).toBe(1);
        expect(scanStatementText(text('05/04/2024 CLOSING DOWN SALE 900.00')).suspect).toBe(1);
    });
    it('notices the statement saying there was no activity, and the period it covers', () => {
        expect(scanStatementText(text('No transactions for this period')).noActivity).toBe(true);
        expect(scanStatementText(text('Nil transactions')).noActivity).toBe(true);
        expect(scanStatementText(text('Nothing to see')).noActivity).toBe(false);
        expect(scanStatementText(text()).period).toBe(true);
        expect(scanStatementText('Hello\nWorld').period).toBe(false);
    });
});

describe('deciding that a statement is empty', () => {
    const parsed = (rows = [], reconciliation) => ({ rows, ...(reconciliation ? { reconciliation } : {}) });
    it('is empty, strongly, when opening and closing agree and nothing else carries money', () => {
        const a = assessEmptiness({ text: text('Opening Balance 12,345.67', 'Closing Balance 12,345.67'), parsed: parsed() });
        expect(a).toMatchObject({ decision: 'empty', strength: 'strong', evidence: { balances: 'agree' } });
    });
    it('is empty, strongly, when the statement says so outright', () => expect(assessEmptiness({ text: text('No transactions for this period'), parsed: parsed() })).toMatchObject({ decision: 'empty', strength: 'strong', evidence: { noActivityStated: true } }));
    it('is empty, weakly, from zero lines and a stated period alone — the shape the owner\'s HNB months have', () => {
        for (const lines of [['30/04/2024 0.00'], ['30/04/2024 30/04/2024 0.00 0.00 0.00'], ['30/04/2024 Nil 0.00']]) {
            expect(assessEmptiness({ text: text(...lines), parsed: parsed([phantom]) }), lines[0]).toMatchObject({ decision: 'empty', strength: 'weak', evidence: { balances: 'absent', phantomRows: 1 } });
        }
    });
    it('uses the reader\'s reconciliation when the text states no balances of its own', () => {
        expect(assessEmptiness({ text: text('30/04/2024 0.00'), parsed: parsed([phantom], { opening: 10, closing: 10, ok: true }) })).toMatchObject({ decision: 'empty', strength: 'strong' });
        expect(assessEmptiness({ text: text('30/04/2024 0.00'), parsed: parsed([phantom], { opening: 10, closing: 12 }) })).toMatchObject({ decision: 'moved' });
    });
    it('is NOT empty when the reader found a real transaction', () => expect(assessEmptiness({ text: text('Opening Balance 1.00', 'Closing Balance 1.00'), parsed: parsed([real, phantom]) })).toMatchObject({ decision: 'has-transactions', why: 'rows-were-read' }));
    it('is NOT empty when the balances agree but a line in the text carries money — debits and credits that cancel', () => {
        const a = assessEmptiness({ text: text('Opening Balance 10,000.00', '05/04/2024 CASH DEPOSIT 500.00 10,500.00', '06/04/2024 ATM WITHDRAWAL 500.00 10,000.00', 'Closing Balance 10,000.00'), parsed: parsed([], { opening: 10000, closing: 10000, ok: true }) });
        expect(a).toMatchObject({ decision: 'has-transactions', why: 'money-outside-the-balance-lines' });
    });
    it('is NOT empty when opening and closing differ, however empty the rows look', () => expect(assessEmptiness({ text: text('Opening Balance 10,000.00', 'Closing Balance 9,000.00'), parsed: parsed() })).toMatchObject({ decision: 'moved' }));
    it('is NOT empty when a balance contradicts itself', () => expect(assessEmptiness({ text: text('Opening Balance 10,000.00', 'B/F 9,999.00', 'Closing Balance 10,000.00'), parsed: parsed() })).toMatchObject({ decision: 'unsure', why: 'balances-disagree-with-themselves' }));
    it('is unsure, not empty, when nothing shows the period was empty: no period, no balances, no zero lines', () => {
        expect(assessEmptiness({ text: 'Some\nUnknown\nDocument\nWith nothing in it', parsed: parsed() })).toMatchObject({ decision: 'unsure' });
        expect(assessEmptiness({ text: text(), parsed: parsed() })).toMatchObject({ decision: 'unsure', why: 'nothing-shows-the-period-was-empty' });
    });
    it('is unsure when there is hardly any text, which is what a failed read looks like', () => expect(assessEmptiness({ text: 'Statement Period 01/04/2024 - 30/04/2024', parsed: parsed([phantom]) })).toMatchObject({ decision: 'unsure', why: 'too-little-text-to-judge' }));
    it('never throws on hostile input', () => {
        for (const input of [{}, { text: null, parsed: null }, { text: 'x'.repeat(200000), parsed: { rows: [null, 7] } }, { text: '\u0000\n‮\n9'.repeat(50) }]) expect(() => assessEmptiness(input)).not.toThrow();
        expect(assessEmptiness({ text: 'a\nb\nc', parsed: { rows: [null, 7] } }).decision).toBeTypeOf('string');
    });
    it('reads a long statement in linear time', () => {
        const big = text(...Array.from({ length: 30000 }, (_, i) => `0${(i % 9) + 1}/04/2024 0.00 0.00`));
        const t0 = Date.now(); expect(assessEmptiness({ text: big, parsed: parsed([phantom]) }).decision).toBe('empty'); expect(Date.now() - t0).toBeLessThan(3000);
    });
});

describe('the AI as a second witness', () => {
    it('masks long numbers and addresses before anything is sent, and says what to count', () => {
        const prompt = witnessPrompt(text('Account 074020000088', 'owner@example.com'));
        expect(prompt).not.toContain('074020000088'); expect(prompt).toContain('########0088'); expect(prompt).not.toContain('owner@example.com');
        expect(prompt).toContain('untrusted'); expect(prompt).toContain('transactionLines');
        expect(redactForWitness('a\n'.repeat(500), { maxLines: 10 }).split('\n')).toHaveLength(10);
    });
    it('agrees only when the board answers zero transaction lines', async () => {
        expect(await witnessEmpty({ text: 'x', board: async () => ({ fields: { transactionLines: 0 } }) })).toEqual({ available: true, agrees: true });
        expect(await witnessEmpty({ text: 'x', board: async () => ({ fields: { transactionLines: 2 } }) })).toEqual({ available: true, agrees: false });
    });
    it('is unavailable — learning nothing — when the board fails, is not unanimous, or answers nonsense', async () => {
        const board = vi.fn();
        board.mockRejectedValueOnce(new Error('ai-consensus-unavailable'));
        expect(await witnessEmpty({ text: 'x', board })).toEqual({ available: false, agrees: false });
        for (const fields of [{}, { transactionLines: '0' }, { transactionLines: -1 }, { transactionLines: 1.5 }, null]) {
            expect(await witnessEmpty({ text: 'x', board: async () => ({ fields }) }), JSON.stringify(fields)).toEqual({ available: false, agrees: false });
        }
        expect(await witnessEmpty({ text: 'x' })).toEqual({ available: false, agrees: false });
    });
});
