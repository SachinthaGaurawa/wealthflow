import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

const HTML = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

function loanStatementBuilder() {
    const start = HTML.indexOf('function _buildLoanStatementHTML(l)');
    const endMarker = '\n        // Open the statement in a new window/tab.';
    const end = HTML.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('loan statement builder not found');

    const context = vm.createContext({
        loanProjectedSchedule: () => ({
            totalInterestActual: 20,
            totalLifetimeCost: 1020,
            schedule: [
                { month: '2026-01', label: 'January 2026', paid: true, amount: 500, scheduledAmount: 500, principalPaid: 480, interest: 20, balance: 520 },
                { month: '2026-02', label: 'February 2026', paid: false, amount: 500, scheduledAmount: 500, principalPaid: 500, interest: 0, balance: 20 },
            ],
        }),
        loanRecalculatedInstallment: () => ({ onTrack: true, remainingMonths: 1 }),
        _loanMethod: () => 'emi',
        loanCurrentBalance: () => 520,
        loanTotalInterestPaid: () => 20,
        loanEndDate: () => new Date('2026-02-01T00:00:00Z'),
        fmt: (value) => `LKR ${Number(value).toFixed(2)}`,
        WFIcon: { inline: (name) => `<svg data-icon="${name}"></svg>` },
        Date,
    });
    vm.runInContext(`${HTML.slice(start, end)}\nthis.build = _buildLoanStatementHTML;`, context);
    return context.build;
}

const LOAN = {
    id: 'loan-123456',
    name: 'Mirigama Land',
    bank: 'HNB',
    purpose: 'Land',
    amount: 1000,
    rate: 12,
    duration: 2,
    start: '2026-01-01',
    payments: [{ paid: true, amount: 500 }],
};

describe('the standalone loan statement is presentation-complete by itself', () => {
    it('renders real SVG icons instead of leaking icon tokens as visible text', () => {
        const output = loanStatementBuilder()(LOAN);
        expect(output).not.toMatch(/@[A-Za-z][A-Za-z0-9]*@/);
        expect(output).toContain('<svg');
        expect(output).toContain('Print / Save PDF');
        expect(output).toContain('Share');
        expect(output).toContain('Close');
    });
});

describe('the branded report link reaches the existing secure viewer', () => {
    it('routes an eight-character report id without exposing the internal API path', () => {
        const rewrite = VERCEL.rewrites.find((entry) => entry.source === '/r/([A-Za-z0-9]{8})');
        expect(rewrite).toEqual({
            source: '/r/([A-Za-z0-9]{8})',
            destination: '/api/router?path=statement-view&id=$1',
        });
    });
});
