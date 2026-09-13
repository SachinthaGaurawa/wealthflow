import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('iOS dashboard compositor stability', () => {
    it('marks iOS before the stylesheet and disables crash-position restoration', () => {
        const boot = html.slice(0, html.indexOf('<meta charset'));
        expect(boot).toContain("document.documentElement.classList.add('wf-ios-stable')");
        expect(boot).toContain("history.scrollRestoration = 'manual'");
    });

    it('does not auto-load Chart.js for the mobile dashboard', () => {
        const start = html.indexOf('window._wfWarmCharts = function');
        const end = html.indexOf('window.ensureTF = function', start);
        const warm = html.slice(start, end);
        expect(warm).toContain('window._wfUseSafeDashboardCharts()')
        expect(warm.indexOf('window._wfUseSafeDashboardCharts()')).toBeLessThan(warm.indexOf('window.ensureChart()'));
    });

    it('keeps the financial values in accessible DOM charts on mobile', () => {
        expect(html).toContain('id="dashChartSafe"');
        expect(html).toContain('id="dashPieSafe"');
        expect(html).toContain("months.map((m, i) => '<div class=\"dash-safe-row\">'");
        expect(html).toContain('Object.entries(categories || {})');
    });

    it('guards both dashboard Chart constructors behind the safe-mode decision', () => {
        const start = html.indexOf('function renderDash()');
        const end = html.indexOf('function renderUpcoming()', start);
        const dash = html.slice(start, end);
        expect(dash.match(/if \(!_safeDashCharts && [^)]+typeof Chart !== 'undefined'\)/g)).toHaveLength(2);
        expect(dash).toContain('_renderSafeDashboardCharts(months, incData, expData, catMap)');
    });

    it('defers reactive and cloud snapshot paints through one scroll-idle gate', () => {
        expect(html).toContain("_wfAfterScrollIdle('reactive-paint'");
        expect(html).toContain("_wfAfterScrollIdle('cloud-snapshot-paint'");
        expect(html).toContain("window._wfAfterScrollIdle = _wfAfterScrollIdle");
    });
});
