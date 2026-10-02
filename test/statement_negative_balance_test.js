import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { repairByArithmetic } from '../statement-repair.mjs';
import { deterministicDecision } from '../statement-sync.js';
import { ownerWords, ownTransferEvidence } from '../statement-transfers.mjs';
import { expenseCategoryFor } from '../wealthflow-statement-router.js';

const P = loadParser(fs);

// DFCC "Your Combined Banking Statement", August 2026 (the owner's own file, production 2026-10-02): the account went overdrawn on the last day. The page prints the running balance as "-40,367.58".
// The reader dropped the sign, took 40,367.58 for the balance, and made a debit of 50,000.00 into a credit of 30,735.16 — "a difference of -80,735.16" on a statement whose own Transaction Summary
// (1,536,807.95 out, 852,027.00 in) agreed with every figure once the sign was kept. What follows is the same shape with invented names and figures.
const head = ['Client Name: MR A B C EXAMPLE', 'Account Number: 100000000001', 'Account Type: Current Account', 'Transaction Period: 01/08/2026 - 31/08/2026', 'Currency: LKR',
    'Post Date Effective Date Narration Withdrawal (Dr) Deposit (Cr) Balance'];
const overdrawn = [...head,
    '01/08/2026 Opening Balance 744.00',
    '03/08/2026 03/08/2026 Pos Transaction Pizza Hut 500.00 244.00',
    '04/08/2026 04/08/2026 Ceft Charges 376657Xxxxx0276 25.00 219.00',
    '05/08/2026 05/08/2026 Outward Ceft Transfer 376657Xxxxx0276 50,000.00 -49,781.00',
    '06/08/2026 06/08/2026 Inward Ceft Transfer Order 100,000.00 50,219.00',
    'Transaction Summary 50,525.00 100,000.00'].join('\n');

describe('a running balance below zero keeps its sign', () => {
    it('reads "-49,781.00" as the balance, the 50,000.00 as the debit that took it there, and the next credit from below zero', () => {
        const { rows, reconciliation, verdict, understood } = P.parseStatement(overdrawn);
        expect(rows.map(r => [r.amount, r.direction, r.balance])).toEqual([[500, 'debit', 244], [25, 'debit', 219], [50000, 'debit', -49781], [100000, 'credit', 50219]]);
        expect(rows.every(r => r.directionSource === 'balance' && r.needsReview === false)).toBe(true);
        expect(rows[2].narration).toBe('Outward Ceft Transfer 376657Xxxxx0276');                      // the amount is no longer left in the description
        expect(reconciliation).toMatchObject({ opening: 744, closing: 50219, credits: 100000, debits: 50525, ok: true, difference: 0 });
        expect({ verdict, understood }).toEqual({ verdict: 'parsed', understood: true });
    });
    it('and needs no arithmetic repair: the statement adds up as it was read', () => {
        expect(repairByArithmetic(P.parseStatement(overdrawn)).repaired).toBeNull();
    });
    it('a balance in brackets is below zero too, and a "CR" or "DR" after the figure still marks it', () => {
        const text = overdrawn.replace('-49,781.00', '(49,781.00)');
        expect(P.parseStatement(text).rows[2]).toMatchObject({ amount: 50000, direction: 'debit', balance: -49781 });
        const closingBelowZero = [...head, 'Opening Balance 100.00', '02/08/2026 02/08/2026 Pos Transaction Shop 150.00 -50.00', 'Closing Balance -50.00'].join('\n');
        expect(P.parseStatement(closingBelowZero).reconciliation).toMatchObject({ opening: 100, closing: -50, ok: true });
    });
    it('a "-" that stands for an empty column is not a sign: it never turns a balance negative', () => {
        const text = [...head, 'Opening Balance 1,000.00', '02/08/2026 02/08/2026 Pos Transaction Shop 150.00 - 850.00', '03/08/2026 03/08/2026 Salary - 500.00 1,350.00', 'Closing Balance 1,350.00'].join('\n');
        const { rows, reconciliation } = P.parseStatement(text);
        expect(rows.map(r => [r.amount, r.direction, r.balance])).toEqual([[150, 'debit', 850], [500, 'credit', 1350]]);
        expect(reconciliation.ok).toBe(true);
    });
    it('a figure that merely follows a hyphen inside a reference is not a sign', () => {
        const text = [...head, 'Opening Balance 1,000.00', '02/08/2026 02/08/2026 Ref Tx-100.00 Shop 150.00 850.00', 'Closing Balance 850.00'].join('\n');
        expect(P.parseStatement(text).rows[0]).toMatchObject({ amount: 150, direction: 'debit', balance: 850 });
    });
});

describe('what the same statement taught the rules', () => {
    it('"Insur" is insurance, whoever sells it ("Softlogic" is also a shop)', () => {
        expect(expenseCategoryFor({ narration: 'Pos Transaction Softlogic Life Insur Colombo 02' })).toBe('Insurance');
        expect(expenseCategoryFor({ narration: 'Pos Transaction Softlogic Life Insurance Colombo 03' })).toBe('Insurance');
        expect(expenseCategoryFor({ narration: 'Pos Transaction Softlogic Holdings Odel' })).toBe('Shopping');
    });
    it('a POS or Lanka Pay fee is a bank charge, a purchase is not', () => {
        for (const text of ['Pos Transaction Fee Ac-Lkr1552200010800', 'Lpopp Charges Ac-Lkr1572100010800', 'Atm Withdrawal Fee Ac-Lkr1015000780022', 'Ceft Charges Car']) expect(expenseCategoryFor({ narration: text }), text).toBe('Bank Charges');
        expect(expenseCategoryFor({ narration: 'Pos Transaction Thushara Filling Statio Matara' })).not.toBe('Bank Charges');
    });
});

describe('a transfer that names the owner is the owner\'s own', () => {
    const own = ownerWords({ text: 'Client Name: MR K S G KULASOORIYA\nAccount Number: 1', email: 'gaurawasachintha@gmail.com' });
    it('reads the owner\'s words from the statement\'s client name and the mailbox address, and no initials or titles', () => {
        expect([...own.names]).toEqual(['kulasooriya']);
        expect(own.local).toBe('gaurawasachintha');
        expect(ownerWords()).toEqual({ names: new Set(), local: '' });
        expect(ownerWords({ email: 'a@b.c' }).local).toBe('');
    });
    it('"Transfer Credit-Mobilebanking Gaurawa" is the owner\'s money from another account; a stranger\'s name is not', () => {
        expect(ownTransferEvidence({ narration: 'Transfer Credit-Mobilebanking Gaurawa' }, own)).toBe('own-name');
        expect(ownTransferEvidence({ narration: 'Transfer to Kulasooriya' }, own)).toBe('own-name');
        for (const text of ['Outward Ceft Transfer Car', 'Transfer Debit Rich Mark', 'Inward Ceft Transfer Ftxloan', 'Transfer Credit-Mobilebanking Payment']) expect(ownTransferEvidence({ narration: text }, own), text).toBe('');
    });
    it('is decided before anything is filed: skipped as the owner\'s own, with the reason', () => {
        const allocations = { statementType: 'bank_account' };
        Object.defineProperty(allocations, 'ownerWords', { value: own, enumerable: false });
        const row = { date: '2026-08-13', narration: 'Transfer Credit-Mobilebanking Gaurawa', amount: 25000, direction: 'credit', directionSource: 'balance', needsReview: false, valid: true };
        expect(deterministicDecision(row, allocations)).toMatchObject({ module: 'skip', category: 'Transfer', ownTransfer: 'own-name' });
        expect(deterministicDecision({ ...row, narration: 'Transfer Credit-Mobilebanking Payment' }, allocations)).toMatchObject({ module: 'incomeRecv', autoDecided: 'transfer-from-others' });
    });
});
