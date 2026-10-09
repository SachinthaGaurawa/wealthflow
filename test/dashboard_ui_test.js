import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function model(overrides = {}) {
    return {
        year: '2026',
        currency: 'LKR',
        overview: [
            { label: 'Income', value: 240000, tone: 'positive' },
            { label: 'Expenses', value: 125000, tone: 'warning' },
            { label: 'Available', value: 115000, tone: 'neutral' },
        ],
        attention: [{ title: '2 statements need review', detail: 'Open Statement Sync', severity: 'warning' }],
        freshness: { label: 'Updated just now', state: 'fresh' },
        source: { from: 'Bank statements', through: 'Verified ledger', to: 'WealthFlow' },
        series: [
            { label: 'Jan', income: 80000, expense: 40000 },
            { label: 'Feb', income: 90000, expense: 45000 },
            { label: 'Mar', income: 70000, expense: 40000 },
        ],
        categories: [{ label: 'Housing', value: 60000 }, { label: 'Food', value: 35000 }],
        ...overrides,
    };
}

beforeEach(() => {
    const { window, document } = parseHTML('<!doctype html><html><body><main id="wfDashboardExperience"></main></body></html>');
    globalThis.window = window;
    globalThis.document = document;
});

afterEach(() => {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    vi.restoreAllMocks();
});

describe('premium dashboard presentation', () => {
    it('renders decision-ready metrics, provenance and a keyboard-readable chart', async () => {
        const { dashboardUI } = await import('../wealthflow-dashboard-ui.js');
        dashboardUI.render(model());

        const root = document.querySelector('.wf-dash-experience');
        expect(root).not.toBeNull();
        expect(root.querySelectorAll('.wf-dash-metric')).toHaveLength(3);
        expect(root.textContent).toContain('2 statements need review');
        expect(root.querySelector('.wf-dash-freshness').textContent).toBe('Updated just now');
        expect([...root.querySelectorAll('.wf-dash-provenance strong')].map((node) => node.textContent))
            .toEqual(['Bank statements', 'Verified ledger', 'WealthFlow']);

        const chart = root.querySelector('svg');
        expect(chart.getAttribute('viewBox')).toBe('0 0 720 260');
        expect(chart.getAttribute('role')).toBe('img');
        expect(chart.querySelectorAll('circle[tabindex="0"]')).toHaveLength(6);
        expect(root.querySelector('[data-wf-chart-summary]').textContent)
            .toContain('Jan: income LKR 80,000; expenses LKR 40,000');
    });

    it('does not write storage or use decorative eyebrow copy', async () => {
        const setItem = vi.fn();
        Object.defineProperty(window, 'localStorage', { configurable: true, value: { setItem } });
        const { dashboardUI } = await import('../wealthflow-dashboard-ui.js');

        dashboardUI.render(model());

        expect(setItem).not.toHaveBeenCalled();
        expect(document.querySelector('.wf-dash-eyebrow')).toBeNull();
    });

    it('has honest empty, loading and recovery states', async () => {
        const { dashboardUI } = await import('../wealthflow-dashboard-ui.js');

        dashboardUI.render(model({ overview: [], attention: [], series: [], categories: [] }));
        expect(document.querySelector('.wf-dash-empty').textContent).toContain('No financial activity yet');

        dashboardUI.renderSkeleton();
        expect(document.querySelectorAll('.wf-dash-skeleton')).toHaveLength(3);

        dashboardUI.renderError();
        expect(document.querySelector('.wf-dash-error').getAttribute('role')).toBe('alert');
        expect(document.querySelector('.wf-dash-error').textContent).toContain('Try refreshing this view');
    });
});
