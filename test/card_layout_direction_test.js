import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { proveDirections, cardCreditWords } from '../statement-direction.mjs';
import { PROVEN_DIRECTION, validateSettlementRow } from '../statement-ledger.mjs';
import { readShape, deterministicDecision } from '../statement-sync.js';

const P = loadParser(fs);

// HNB credit card e-statement (owner's file, production 2026-11-03): the statement opened, 24 rows were read, one was filed and 22 waited as "unproven-direction". A card statement prints a purchase as a
// plain amount, and the closing line of this layout is not one the parser recognises, so the statement's own arithmetic proved nothing. What follows is the same shape with invented names and figures.
const head = ['HNB Credit Card Statement', 'Card No: 4284 17XX XXXX 0048', 'Credit Limit 500,000.00', 'Previous Balance 45,000.00'];
const body = ['12/09/2026 14/09/2026 KEELLS SUPER COLOMBO 4,250.00', '15/09/2026 16/09/2026 UBER RIDE 1,250.00', '20/09/2026 21/09/2026 PAYMENT RECEIVED - THANK YOU 45,000.00 CR', '25/09/2026 26/09/2026 NETFLIX.COM 1,890.00'];
const noClosing = [...head, ...body, 'Total Outstanding 7,390.00'].join('\n');
const withClosing = [...head.slice(0, 3), 'Opening Balance 45,000.00', ...body, 'Closing Balance 7,390.00'].join('\n');
const read = (text, ctx) => { const parsed = P.parseStatement(text); return { parsed, proof: proveDirections(parsed, ctx) }; };

describe('a credit card statement the arithmetic cannot prove', () => {
    it('is read as it was before: every plain amount is an assumed debit and needs review', () => {
        const { parsed } = read(noClosing);
        expect(parsed.reconciliation.ok).toBe(null);
        expect(parsed.rows.map(r => [r.amount, r.direction, r.directionSource, r.needsReview])).toEqual([[4250, 'debit', 'assumed', true], [1250, 'debit', 'assumed', true], [45000, 'credit', 'marker', false], [1890, 'debit', 'assumed', true]]);
    });
    it('proves the purchases by the card layout, once the statement is known to be a card', () => {
        const { proof } = read(noClosing, { card: true });
        expect(proof).toMatchObject({ byLayout: 3, byStatement: 0, byWords: 0 });
        expect(proof.rows.map(r => [r.direction, r.directionSource, r.needsReview])).toEqual([['debit', 'layout', false], ['debit', 'layout', false], ['credit', 'marker', false], ['debit', 'layout', false]]);
    });
    it('and from the reader\'s own "credit-card" header, without being told', () => {
        const parsed = P.parseStatement(noClosing); parsed.layout.statementType = 'credit-card';
        expect(proveDirections(parsed).byLayout).toBe(3);
    });
    it('does nothing for a statement that is not known to be a card', () => {
        expect(read(noClosing).proof.byLayout).toBe(0);
    });
    it('does nothing when the statement\'s own opening and closing do NOT add up: the owner is asked, as before', () => {
        const wrong = withClosing.replace('Closing Balance 7,390.00', 'Closing Balance 9,999.00');
        const { parsed, proof } = read(wrong, { card: true });
        expect(parsed.reconciliation.ok).toBe(false);
        expect(proof.byLayout).toBe(0);
        expect(proof.rows.filter(r => r.needsReview).length).toBe(3);
    });
    it('a statement whose balances add up is still proven by the statement, not by the convention', () => {
        const { proof } = read(withClosing, { card: true });
        expect(proof).toMatchObject({ byStatement: 3, byLayout: 0 });
    });
    it('never takes a line that says money came back for a purchase', () => {
        const text = [...head, '12/09/2026 KEELLS SUPER COLOMBO 4,250.00', '15/09/2026 CASHBACK REWARD 150.00', '16/09/2026 REFUND AMAZON 900.00', '17/09/2026 PAYMENT THANK YOU 5,000.00', '20/09/2026 MERCHANT CREDIT ADJUSTMENT 75.00'].join('\n');
        const { proof } = read(text, { card: true });
        // only the merchant is a purchase by the layout; a refund and a cashback are credits by their words; the two the parser read as credits from a keyword stay with the owner
        expect(proof).toMatchObject({ byLayout: 1, byWords: 2 });
        expect(proof.rows.map(r => [r.direction, r.directionSource])).toEqual([['debit', 'layout'], ['credit', 'words'], ['credit', 'words'], ['credit', 'keyword'], ['credit', 'keyword']]);
        expect(proof.rows.filter(r => r.needsReview).length).toBe(2);
    });
    it('leaves a row the parser read as a credit from its words (keyword) to the owner', () => {
        const parsed = { layout: { statementType: 'credit-card', balanceColumn: false }, reconciliation: { ok: null }, rows: [{ narration: 'SOMETHING INWARD', amount: 10, direction: 'credit', directionSource: 'keyword', needsReview: true, valid: true }] };
        expect(proveDirections(parsed).byLayout).toBe(0);
    });
    it('does not open on a statement that has a running balance', () => {
        const parsed = { layout: { statementType: 'credit-card', balanceColumn: true }, reconciliation: { ok: null }, rows: [{ narration: 'KEELLS', amount: 10, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true }] };
        expect(proveDirections(parsed).byLayout).toBe(0);
    });
    it('"layout" is a proof the ledger accepts, and the filed record says how it was proven', () => {
        expect(PROVEN_DIRECTION).toContain('layout');
        const { proof } = read(noClosing, { card: true });
        const row = { ...proof.rows[0], description: proof.rows[0].narration };
        expect(validateSettlementRow(row, { verified: true, module: 'cconetime', category: 'Groceries' }, { statementType: 'credit_card' })).toBe(null);
        expect(validateSettlementRow({ ...row, directionSource: 'assumed', needsReview: true }, { verified: true, module: 'cconetime', category: 'Groceries' }, { statementType: 'credit_card' })).toBe('unproven-direction');
    });
    it('card credit words are read from the row alone', () => {
        expect(cardCreditWords({ narration: 'PAYMENT RECEIVED' })).toBe(true);
        expect(cardCreditWords({ narration: 'KEELLS SUPER' })).toBe(false);
    });
});

describe('the log says why a statement waits (counts only)', () => {
    it('counts how the directions were read and whether the statement\'s own balances were found and agreed', () => {
        const shape = readShape(P.parseStatement(noClosing));
        expect(shape).toMatchObject({ sources: { assumed: 3, marker: 1 }, balanceColumn: false, opening: true, closing: false, reconciled: 'unknown', invalid: { noDate: 0, noAmount: 0, noWords: 0 } });
        expect(readShape(P.parseStatement(withClosing))).toMatchObject({ reconciled: 'yes', model: 'card', closing: true });
    });
    it('counts the rows that are not whole transactions', () => {
        expect(readShape({ rows: [{ date: '', amount: 5, narration: 'x' }, { date: '2026-09-01', amount: 0, narration: 'y' }, { date: '2026-09-01', amount: 5, narration: '  ' }] }).invalid).toEqual({ noDate: 1, noAmount: 1, noWords: 1 });
    });
});

describe('a card purchase keeps the category the rules gave it', () => {
    const card = { statementType: 'credit_card', cardRegistry: {}, subscriptions: [], loans: [] };
    const row = (narration) => ({ narration, description: narration, amount: 100, direction: 'debit', date: '2026-09-01', directionSource: 'layout', needsReview: false, valid: true });
    it('Keells is Groceries, Uber is Transport, on a card as on an account', () => {
        expect(deterministicDecision(row('KEELLS SUPER COLOMBO'), card)).toMatchObject({ module: 'cconetime', category: 'Groceries', verified: true });
        expect(deterministicDecision(row('UBER RIDE'), card)).toMatchObject({ module: 'cconetime', category: 'Transport' });
    });
    it('a merchant the rules cannot place is still a Card Purchase, for the merchant review to settle', () => {
        expect(deterministicDecision(row('SOME UNKNOWN SHOP 77'), card)).toMatchObject({ module: 'cconetime', category: 'Card Purchase' });
    });
});
