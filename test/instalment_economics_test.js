import { describe, it, expect } from 'vitest';
import { installmentInfo } from '../wealthflow-statement-router.js';
import { planEconomics, readPlanTable, planFor } from '../statement-plan-table.mjs';
import { applyPlanPayment } from '../statement-links.mjs';

describe('installmentInfo reads the REM BAL', () => {
  it('returns what the bank says is still owed', () => {
    const i = installmentInfo('ACME 12M NATIONS PAY INST 3 - REM BAL - 90,000.50 - <3/12>');
    expect(i).toMatchObject({ isInstallment: true, no: 3, of: 12, remaining: 90000.5 });
  });
  it('has no remaining on other plan wording', () => {
    expect(installmentInfo('INSTALLMENT 03/12 ABANS').remaining).toBeUndefined();
  });
});

describe('planEconomics', () => {
  it('proves 0% when instalments repay the original to the cent', () => {
    expect(planEconomics({ principal: 120000, monthly: 10000, months: 12 })).toMatchObject({ interestFree: true, interest: 0, rate: 0 });
    expect(planEconomics({ principal: 100000, monthly: 8333.33, months: 12 }).interestFree).toBe(true);
  });
  it('finds the annual rate when they repay more', () => {
    const e = planEconomics({ principal: 100000, monthly: 8884.88, months: 12 });   // 12% a year
    expect(e.interestFree).toBe(false);
    expect(e.interest).toBeCloseTo(6618.56, 2);
    expect(e.rate).toBeGreaterThan(11.9);
    expect(e.rate).toBeLessThan(12.1);
  });
  it('refuses nonsense', () => {
    expect(planEconomics({ principal: 100000, monthly: 5000, months: 12 })).toBeNull();
    expect(planEconomics({ principal: 0, monthly: 5000, months: 12 })).toBeNull();
    expect(planEconomics({ principal: 1000, monthly: 100, months: 1 })).toBeNull();
  });
});

describe('plan table with interest', () => {
  it('accepts an interest-bearing NTB row when three figures agree, with its rate', () => {
    const t = readPlanTable('ACME 12M NATIONS PAY  100,000.00  17,769.76  2/12  8,884.88');
    expect(t).toHaveLength(1);
    expect(t[0].rate).toBeGreaterThan(11.9);
    expect(planFor(t, 8884.88, 12)).toBe(t[0]);
  });
  it('rejects a row whose figures disagree', () => {
    expect(readPlanTable('ACME 12M NATIONS PAY  100,000.00  50,000.00  2/12  8,884.88')).toHaveLength(0);
  });
});

describe('applyPlanPayment keeps the bank outstanding in step', () => {
  it('uses the latest statement', () => {
    const plan = { id: 'p', source: 'statement', duration: 12, months: 12, date: '2026-10-01', monthly: 100, payments: [] };
    applyPlanPayment(plan, { date: '2026-11-05', amount: 100 }, 'a', 0, 1, { no: 2, of: 12, remaining: 1000 });
    applyPlanPayment(plan, { date: '2026-10-05', amount: 100 }, 'b', 0, 1, { no: 1, of: 12, remaining: 1100 });
    expect(plan.outstanding).toBe(1000);
    expect(plan.outstandingAt).toBe('2026-11-05');
  });
});
