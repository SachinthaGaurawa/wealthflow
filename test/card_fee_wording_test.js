import { describe, it, expect } from 'vitest';
import { routeRow, installmentInfo } from '../wealthflow-statement-router.js';

const card = { statementType: 'credit_card' };
const debit = description => ({ date: '2026-10-10', amount: 100, direction: 'debit', description });

describe('what a card line says it is', () => {
    it.each(['Interest', 'Interest Charged', 'Finance Charges', 'Late Payment Charge', 'Late Payment Fee', 'Over Limit Fee', 'SMS Alert Fee', 'Annual Fee', 'Stamp Duty', 'Cash Advance Fee', 'Fuel Surcharge Fee', 'ATM Withdrawal Fee', 'Instalment Fee 3/12', 'Instalment Interest - 3/12'])(
        '%s is a card fee, never a purchase, an advance or a plan', text => {
            expect(routeRow(debit(text), card)).toMatchObject({ module: 'cconetime', subtype: 'fee' });
        });
    it.each(['SCHOOL FEES COLOMBO', 'KEELLS SUPER', 'ATM KANDY', 'CEYPETCO FILLING STATION', 'INTEREST FREE STORE COLOMBO'])('%s is not a fee', text => {
        expect(routeRow(debit(text), card).subtype).not.toBe('fee');
    });
    it('the principal of an instalment is a plan payment, its interest is not', () => {
        expect(installmentInfo('Instalment Principle - 3/12')).toMatchObject({ isInstallment: true, no: 3, of: 12 });
        expect(installmentInfo('Instalment Interest - 3/12').isInstallment).toBe(false);
        expect(installmentInfo('Interest on Instalment 3/12').isInstallment).toBe(false);
        expect(installmentInfo('0% Interest Free Instalment 3/12 SAMPLE SHOP').isInstallment).toBe(true);
    });
});
