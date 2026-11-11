import { describe, it, expect } from 'vitest';
import { statementSelfAudit } from '../wf-statement-self-audit.mjs';
import { reportBody, reportSuspectReading } from '../wf-statement-self-report.mjs';
import { readPlanTable } from '../statement-plan-table.mjs';

const dr = (description, amount) => ({ description, amount, direction: 'debit', date: '2026-10-20' });

describe('the reader notices what its own rules did not understand', () => {
    it('a plan line it reads is not a finding', () => {
        expect(statementSelfAudit({ rows: [dr('ACME 12M NATIONS PAY INST 1 - REM BAL - 110000.00 - <1/12>', 10000), dr('KEELLS SUPER', 1500)] })).toEqual([]);
    });
    it('plan marks it does not accept are a finding, counted', () => {
        const rows = [dr('ACME 12M NATIONS PAY INST 2 - REM BAL - 110000.00 - <1/12>', 10000), dr('OTHER SHOP REM BAL 5000.00', 800), dr('KEELLS SUPER', 1500)];
        expect(statementSelfAudit({ rows })).toEqual([{ kind: 'plan-like-line-unread', count: 2 }]);
    });
    it('a plan table with no charge read as any of its plans is a finding', () => {
        const planTable = readPlanTable('ACME 12M NATIONS PAY  120,000.00  110,000.00  11/12  10,000.00');
        expect(planTable).toHaveLength(1);
        expect(statementSelfAudit({ rows: [dr('KEELLS SUPER', 1500)], planTable })).toEqual([{ kind: 'plan-table-unmatched', count: 1 }]);
        expect(statementSelfAudit({ rows: [dr('ACME CHARGE', 10000)], planTable })).toEqual([]);   // a charge of the plan's instalment: matched to its row
    });
    it('credits are never plan lines; empty input is quiet', () => {
        expect(statementSelfAudit({ rows: [{ description: 'REM BAL refund', amount: 5, direction: 'credit' }] })).toEqual([]);
        expect(statementSelfAudit()).toEqual([]);
    });
    it('the report for the new kinds holds no statement text or long numbers', () => {
        for (const kind of ['plan-like-line-unread', 'plan-table-unmatched']) {
            const body = reportBody(kind, { bank: 'NTB 4000 0000 0000 0001', rows: 12 });
            expect(body).toContain(kind);
            expect(body).not.toMatch(/\d{4,}/);
        }
    });
    it('does nothing when the deployment cannot file issues', async () => {
        expect(await reportSuspectReading('plan-like-line-unread', {}, { env: {} })).toEqual({ filed: false, reason: 'not-configured' });
    });
});
