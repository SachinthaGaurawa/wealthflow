import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import fs from 'node:fs';
import path from 'node:path';
import { statementView } from '../tenant-page.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'tenant-page.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'tenant.html'), 'utf8');

describe('branded tenant workspace', () => {
    it('uses the physical WealthFlow identity and shared design tokens', () => {
        expect(html).toContain('/assets/brand/wealthflow-wordmark.svg');
        expect(html).toContain('/styles/wf-tokens.css');
        expect(css).toContain('var(--wf-ink-0)');
        expect(css).toContain('var(--wf-focus)');
    });

    it('avoids heavy accent rails and supports reduced transparency and motion', () => {
        expect(css).not.toMatch(/border-(?:left|right)\s*:\s*[2-9]px/i);
        expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
        expect(css).toMatch(/@media\s*\(prefers-reduced-transparency:\s*reduce\)/);
    });

    it('makes record kind and overdue state visible without changing financial data', () => {
        const { document } = parseHTML('<!doctype html><html><body></body></html>');
        const nodes = statementView(document, {
            lenderCount: 1,
            lenders: [],
            totals: [{ currency: 'LKR', invested: 100000, interestReceived: 5000, loanOutstanding: 25000 }],
            groups: [
                { kind: 'investment', ref: 'INV-ABC123', currency: 'LKR', capital: 100000, ratePct: 12, frequency: 'monthly', interestPerPeriod: 1000, start: '2026-01-01', end: '', nextInterest: null, totalReceived: 5000, payments: [] },
                { kind: 'loan', ref: 'DEB-ABC123', currency: 'LKR', lent: 30000, repaid: 5000, outstanding: 25000, status: 'open', due: '2026-10-01', overdueDays: 8, events: [] },
            ],
        });
        document.body.append(...nodes);

        expect(document.querySelector('.tp-record.is-investment')).not.toBeNull();
        expect(document.querySelector('.tp-record.is-loan.is-overdue')).not.toBeNull();
        expect(document.querySelector('.tp-chip.tp-overdue').textContent).toBe('Open');
    });
});
