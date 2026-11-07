import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readStatement } from '../statement-reader.mjs';
import { learnCloudLayout, proposeCloudLayouts } from '../statement-layout.mjs';
import { confirmedKeys, applyOwnerConfirmed } from '../statement-owner-confirmed.mjs';
import { fallbackDecision, deterministicDecision } from '../statement-sync.js';
import { validateSettlementRow } from '../statement-ledger.mjs';

// An INVENTED card statement (the repository is public): dotted dates the reader does not know, no running balance, no CR marks.
const lines = ['CREDIT CARD STATEMENT', 'Card Number 4000 00XX XXXX 1234', 'Credit Limit 500,000.00', 'Statement Date 30.07.2026',
    '02.07.2026 SAMPLE SUPERMARKET COLOMBO 4,250.00', '03.07.2026 PAYMENT RECEIVED THANK YOU 20,000.00', '05.07.2026 SAMPLE TELECOM 8,430.50', '09.07.2026 SAMPLE RIDE TRIP 1,250.00'];
const html = Buffer.from(`<html><body>${lines.join('\n')}</body></html>`);
const BANK = 'Sample Bank';

async function confirmedReading() {
    const cold = await readStatement({ bytes: html, filename: 's.html' });
    expect(cold.parsed.rows).toHaveLength(0);
    const offered = await proposeCloudLayouts(cold.text, { bank: BANK });
    // what the teach screen sends when the owner presses "Yes, read it this way"
    const confirmed = offered[0].rows.map(row => ({ date: row.date, amount: row.amount, direction: row.direction }));
    const learned = await learnCloudLayout(cold.text, confirmed, { bank: BANK });
    expect(learned.ok).toBe(true);
    const docId = createHash('sha256').update(JSON.stringify([BANK, learned.template.id])).digest('hex');
    const read = await readStatement({ bytes: html, filename: 's.html', bank: BANK, layouts: [{ template: learned.template, _docId: docId }], confirmedTemplateId: docId });
    return { confirmed, read, docId };
}

describe('the owner\'s "Yes, read it this way" stays confirmed', () => {
    it('reproduces the bug: the re-reading alone leaves every row unproven, so nothing could be filed', async () => {
        const { read } = await confirmedReading();
        expect(read.parsed.rows).toHaveLength(4);
        const ctx = { statementType: 'credit-card', card_last4: '1234', bank: BANK };
        // every row is refused by the ledger as `unproven-direction`, whatever the classification says
        for (const row of read.parsed.rows) expect(validateSettlementRow(row, { module: 'cconetime', category: 'Card Purchase', verified: true }, ctx)).toBe('unproven-direction');
        expect(read.parsed.rows.every(row => row.needsReview === true)).toBe(true);
    });
    it('with the owner\'s confirmation applied, every row is proven and lands on the card tabs only', async () => {
        const { confirmed, read } = await confirmedReading();
        const { rows, applied } = applyOwnerConfirmed(read.parsed.rows, confirmedKeys(confirmed));
        expect(applied).toBe(4);
        const ctx = { statementType: 'credit-card', card_last4: '1234', bank: BANK };
        const modules = rows.map(row => {
            const decision = deterministicDecision(row, ctx).verified ? deterministicDecision(row, ctx) : fallbackDecision(row, ctx);
            expect(decision && decision.verified).toBe(true);
            expect(validateSettlementRow(row, decision, ctx)).toBeFalsy();
            return decision.module;
        });
        // purchases are one-time card charges, the payment is a card payment: never expenses or income
        expect(modules.filter(m => m === 'cconetime')).toHaveLength(3);
        expect(modules.filter(m => m === 'ccPayments')).toHaveLength(1);
        expect(modules.every(m => ['cconetime', 'ccinstall', 'ccPayments'].includes(m))).toBe(true);
    });
    it('on a bank statement the same confirmation files spending as expenses and money in as income', () => {
        const rows = [
            { date: '2026-07-02', amount: 4250, direction: 'debit', directionSource: 'assumed', needsReview: true, narration: 'SAMPLE SUPERMARKET', valid: true },
            { date: '2026-07-03', amount: 250000, direction: 'credit', directionSource: 'keyword', needsReview: true, narration: 'SALARY JULY', valid: true },
        ];
        const { rows: proven } = applyOwnerConfirmed(rows, confirmedKeys(rows));
        const ctx = { statementType: 'bank', bank: BANK };
        const decisions = proven.map(row => (deterministicDecision(row, ctx).verified ? deterministicDecision(row, ctx) : fallbackDecision(row, ctx)));
        expect(decisions.map(d => d.module)).toEqual(['expenses', 'incomeRecv']);
        proven.forEach((row, at) => expect(validateSettlementRow(row, decisions[at], ctx)).toBeFalsy());
    });
    it('the owner\'s direction wins over the reader\'s guess, and a key is used once', () => {
        const rows = [
            { date: '2026-07-02', amount: 10, direction: 'debit', directionSource: 'assumed', needsReview: true, narration: 'A' },
            { date: '2026-07-02', amount: 10, direction: 'debit', directionSource: 'assumed', needsReview: true, narration: 'B' },
            { date: '2026-07-03', amount: 7.25, direction: 'debit', directionSource: 'assumed', needsReview: true, narration: 'C' },
        ];
        const keys = confirmedKeys([{ date: '2026-07-02', amount: 10, direction: 'debit' }, { date: '2026-07-03', amount: 7.25, direction: 'credit' }]);
        const out = applyOwnerConfirmed(rows, keys);
        expect(out.applied).toBe(2);
        expect(out.rows[0]).toMatchObject({ direction: 'debit', directionSource: 'marker', needsReview: false });
        expect(out.rows[1].needsReview).toBe(true);                           // the second equal row was never confirmed
        expect(out.rows[2]).toMatchObject({ direction: 'credit', directionSource: 'marker', needsReview: false });
        expect(rows[0].needsReview).toBe(true);                               // input untouched
    });
    it('stores keys only (no words), and ignores anything that is not a whole row', () => {
        const keys = confirmedKeys([{ date: '2026-07-02', amount: 4250, direction: 'debit', narration: 'SAMPLE SUPERMARKET' }, { date: 'x', amount: 1, direction: 'debit' }, { date: '2026-07-03', amount: 0, direction: 'credit' }, { date: '2026-07-04', amount: 5, direction: 'unknown' }]);
        expect(keys).toEqual(['2026-07-02|425000|d']);
        expect(applyOwnerConfirmed([{ date: '2026-07-02', amount: 4250, direction: 'credit' }], []).applied).toBe(0);
        expect(applyOwnerConfirmed(null, keys).applied).toBe(0);
    });
    it('a row the page leaves unmarked is chosen by the owner, learned, and filed on that choice', async () => {
        const text = ['ACCOUNT STATEMENT', 'OPENING BALANCE 100,000.00', '02.07.2026 SAMPLE SUPERMARKET 4,250.00 95,750.00', '03.07.2026 SAMPLE MYSTERY ITEM 500.00 95,750.00', '05.07.2026 SAMPLE SALARY 250,000.00 345,750.00', 'CLOSING BALANCE 345,750.00'].join('\n');
        const page = Buffer.from(`<html><body>${text}</body></html>`);
        const cold = await readStatement({ bytes: page, filename: 's.html' });
        const offered = await proposeCloudLayouts(cold.text, { bank: BANK });
        expect(offered[0].rows.some(row => !row.direction)).toBe(true);        // the teach screen offers "Choose…" for it
        // the owner picks Out for the unmarked row and presses Yes
        const confirmed = offered[0].rows.map(row => ({ date: row.date, amount: row.amount, direction: row.direction || 'debit' }));
        const learned = await learnCloudLayout(cold.text, confirmed, { bank: BANK });
        expect(learned.ok).toBe(true);
        // …but a direction the reader DID prove cannot be flipped by a confirmation
        const flipped = confirmed.map((row, at) => (at === 0 ? { ...row, direction: 'credit' } : row));
        expect((await learnCloudLayout(cold.text, flipped, { bank: BANK })).ok).toBe(false);
        const docId = createHash('sha256').update(JSON.stringify([BANK, learned.template.id])).digest('hex');
        const read = await readStatement({ bytes: page, filename: 's.html', bank: BANK, layouts: [{ template: learned.template, _docId: docId }], confirmedTemplateId: docId });
        const { rows, applied } = applyOwnerConfirmed(read.parsed.rows, confirmedKeys(confirmed));
        expect(applied).toBe(3);
        const ctx = { statementType: 'bank', bank: BANK };
        const mystery = rows.find(row => row.amount === 500);
        expect(mystery).toMatchObject({ direction: 'debit', directionSource: 'marker', needsReview: false, valid: true });
        const decision = deterministicDecision(mystery, ctx).verified ? deterministicDecision(mystery, ctx) : fallbackDecision(mystery, ctx);
        expect(validateSettlementRow(mystery, decision, ctx)).toBeFalsy();
    });
});

describe('the teach screen and the server are wired to the same confirmation', () => {
    const page = fs.readFileSync('index.html', 'utf8');
    const at = page.indexOf('function _showLayoutTeachModal');
    const modal = page.slice(at, page.indexOf('window._showLayoutTeachModal = _showLayoutTeachModal'));
    const sync = fs.readFileSync('statement-sync.js', 'utf8');
    it('an unmarked row is chosen on the screen, and Yes is refused while one is left open', () => {
        expect(modal).toMatch(/createElement\('select'\)/);
        expect(modal).toMatch(/row\.direction = pick\.value/);
        expect(modal).toMatch(/Choose In or Out/);
        expect(modal).not.toMatch(/'Not stated'/);
    });
    it('the server keeps what the owner confirmed and applies it when the statement is read again', () => {
        expect(sync).toMatch(/ownerConfirmed: confirmedKeys\(rows\)/);
        expect(sync).toMatch(/applyOwnerConfirmed\(parsed\.rows, claimed\.ownerConfirmed\)/);
        expect(sync.indexOf('applyOwnerConfirmed(parsed.rows')).toBeLessThan(sync.indexOf('THE ROWS THE PAGE LEFT UNMARKED ARE PROVEN BY THE STATEMENT'));
    });
});
