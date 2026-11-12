import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import R from '../wealthflow-statement-router.js';
import { INCOME_ONLY, decisionProblem } from '../statement-board.mjs';

const credit = (description) => R.routeRow({ description, amount: 1000, direction: 'credit', date: '2026-10-05' }, { statementType: 'savings' });

describe('bank side: a cashback is a reward, a refund gives money back', () => {
    it('files a cashback credit as income named Cashback', () => {
        for (const d of ['CASHBACK ON YOUR OCT NETFLIX SUBSCRIPTION', 'CARD REBATE CREDIT', 'Cash Back Reward']) {
            const r = credit(d);
            expect([r.module, r.category]).toEqual(['income', 'Cashback']);
        }
    });
    it('keeps refunds, reversals and chargebacks as Refund, and a reversal of a cashback is a refund', () => {
        for (const d of ['REFUND FROM DARAZ ORDER 123', 'CHARGEBACK CREDIT', 'CASHBACK REVERSAL', 'REIMBURSEMENT']) {
            expect(credit(d).category).toBe('Refund');
        }
    });
    it('the board accepts Cashback as an income name, and the page can hold it', () => {
        expect(INCOME_ONLY).toContain('Cashback');
        expect(R.CLASSIFY_CATEGORIES || []).toBeDefined();
        const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
        expect(html).toMatch(/const INC_TYPES = \[[^\]]*'Cashback'/);
    });
    it('a Cashback decision is not refused as a category of another kind', () => {
        const d = { module: 'income', category: 'Cashback' };
        expect(decisionProblem(d, 0)).not.toBe('category-of-another-kind');
    });
});
