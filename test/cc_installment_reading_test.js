import { describe, expect, it } from 'vitest';
import { routeRow, installmentInfo } from '../wealthflow-statement-router.js';
import { matchInstallmentPlan } from '../statement-links.mjs';

// What a bank prints for a card installment is not one fixed phrase. The reader has to call it a plan payment on its WORDS, read WHICH month of the plan it is
// from "n/m" or "n of m" only once the words have said it is a plan, and never take a fee about a plan, or a day like "KEELLS 05/12", for a plan.

const card = { statementType: 'credit_card' };
const bank = { statementType: 'bank_account' };
const debit = (description, amount = 12500) => ({ description, amount, drcr: 'DR' });

describe('installmentInfo: the wording of a card plan line', () => {
    it.each([
        ['INSTALLMENT 03/12 ABANS', { no: 3, of: 12, name: 'ABANS' }],
        ['EPP 05/12 SINGER', { no: 5, of: 12, name: 'SINGER' }],
        ['EZ PAYMENT INSTALLMENT 4/24', { no: 4, of: 24 }],
        ['Instalment Pymt 3 of 12 ABANS PLC', { no: 3, of: 12, name: 'ABANS PLC' }],
        ['ZERO INTEREST PLAN 04/12 SOFTLOGIC', { no: 4, of: 12, name: 'SOFTLOGIC' }],
        ['0% INTEREST INSTALMENT 2/6 DAMRO', { no: 2, of: 6, name: 'DAMRO' }],
        ['EASY PAY 6 MONTHS SINGER', { no: 0, of: 0, name: 'SINGER' }],
        ['ABANS TV INSTALMENT', { no: 0, of: 0, name: 'ABANS TV' }],
    ])('%s is a plan line', (text, want) => {
        const got = installmentInfo(text);
        expect(got.isInstallment).toBe(true);
        expect(got).toMatchObject(want);
    });
    it.each([
        'KEELLS 05/12',
        'KEELLS SUPER 03/12/2026',
        'INSTALMENT FEE',
        'PROCESSING FEE INSTALMENT PLAN 3/12',
        'LATE PAYMENT CHARGE INSTALMENT',
        'CEYPETCO FUEL STATION',
        '',
    ])('%s is not a plan payment', (text) => {
        expect(installmentInfo(text).isInstallment).toBe(false);
    });
    it('a day in the date is not the month of the plan', () => {
        expect(installmentInfo('ABANS INSTALMENT 13/09/2026')).toMatchObject({ isInstallment: true, no: 0, of: 0 });
        expect(installmentInfo('ABANS INSTALMENT 14/12')).toMatchObject({ isInstallment: true, no: 0, of: 0 });   // 14 of 12 cannot be a month of a plan
    });
});

describe('routeRow on a card statement', () => {
    it('plan lines go to CC Installments', () => {
        for (const text of ['INSTALLMENT 03/12 ABANS', 'EPP 05/12 SINGER', 'EASY PAY 6 MONTHS SINGER', 'Instalment Pymt 3 of 12', 'ZERO INTEREST PLAN 04/12 SOFTLOGIC']) {
            expect(routeRow(debit(text), card).module, text).toBe('ccinstall');
        }
    });
    it('a fee about a plan, and a plain shop with a date-like tail, are not plans', () => {
        expect(routeRow(debit('INSTALMENT PLAN PROCESSING FEE', 750), card).module).not.toBe('ccinstall');
        expect(routeRow(debit('KEELLS 05/12', 2400), card).module).not.toBe('ccinstall');
    });
    it('the same words on a bank account are not a card plan', () => {
        expect(routeRow(debit('INSTALLMENT 03/12 ABANS'), bank).module).not.toBe('ccinstall');
    });
});

describe('matchInstallmentPlan: the owner named the plan their own way', () => {
    const plan = (extra = {}) => ({ id: 'P1', product: 'Fridge', bank: 'American Express (AMEX)', monthly: 5000, total: 60000, rate: 0, duration: 12, date: '2026-01-10', completed: false, skipped: [], ...extra });
    const line = { description: 'INSTALLMENT 03/12 ABANS PLC', amount: 5000, date: '2026-09-14' };
    it('with nothing but the amount to go on, a plan line for exactly one plan of the same bank is that plan', () => {
        expect(matchInstallmentPlan(line, [plan()], { installment: true, bank: 'American Express (AMEX)' }).id).toBe('P1');
    });
    it('not when the line is not a plan line, the bank is another, or two plans have the same monthly money', () => {
        expect(matchInstallmentPlan(line, [plan()], { installment: false, bank: 'American Express (AMEX)' })).toBeNull();
        expect(matchInstallmentPlan(line, [plan()], { installment: true, bank: 'Sampath Bank' })).toBeNull();
        expect(matchInstallmentPlan(line, [plan(), plan({ id: 'P2', product: 'Washer' })], { installment: true, bank: 'American Express (AMEX)' })).toBeNull();
    });
    it('a plan the line names still wins over one that only has the same money', () => {
        const named = plan({ id: 'P2', product: 'Abans' });
        expect(matchInstallmentPlan(line, [plan(), named], { installment: true, bank: 'American Express (AMEX)' }).id).toBe('P2');
    });
});
