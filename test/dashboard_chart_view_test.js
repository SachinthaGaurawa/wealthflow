import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The dashboard's two charts can be drawn as Charts (the line and the ring) or as Lists (bars), the owner's choice per device, and the ring's
// legend and the amount under the pointer are page elements that must never be cut off by the card or the screen.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    return html.slice(start, html.indexOf('\n        }', start) + 10);
}
const constLine = (name) => { const m = html.match(new RegExp(`^\\s*const ${name} = .*$`, 'm')); if (!m) throw new Error(`Missing ${name}`); return m[0]; };

function dash({ saved, storageThrows = false, safeDevice = false, vw = 1000, vh = 800, tipSize = { w: 220, h: 70 }, total = 0, rows = [] } = {}) {
    const els = {};
    const tip = { classList: { add() { tip.shown = true; }, remove() { tip.shown = false; } }, style: {}, setAttribute() {}, offsetWidth: tipSize.w, offsetHeight: tipSize.h, innerHTML: '' };
    const el = (id) => (els[id] = els[id] || { textContent: '', setAttribute(k, v) { this[k] = v; } });
    const context = vm.createContext({
        localStorage: { getItem: () => { if (storageThrows) throw new Error('blocked'); return saved == null ? null : saved; }, setItem() { if (storageThrows) throw new Error('blocked'); } },
        window: { _wfUseSafeDashboardCharts: () => safeDevice, innerWidth: vw, innerHeight: vh },
        document: { getElementById: (id) => (id === 'dashPieTip' ? tip : null), createElement: () => tip, body: { appendChild() {} }, querySelectorAll: () => [], documentElement: { clientWidth: vw } },
        $: (id) => el(id), fmt: (n) => 'LKR ' + n, fmtS: (n) => 'S' + n, _wfEsc: (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
        Math, Object, Number, String, parseInt,
    });
    vm.runInContext(constLine('_WF_DASH_VIEW_KEY') + '\n' + constLine('_WF_PIE_COLORS'), context);
    for (const name of ['_wfDashView', '_wfDashCategoryRows', '_wfDashLegendHtml', '_wfPieTipEl', '_wfPieFocus']) vm.runInContext(source(name), context);
    vm.runInContext(`var _dashPieRows = ${JSON.stringify(rows)}, _dashPieTotal = ${total}, _dashPieFocus = -1;`, context);
    return { context, tip, els };
}

describe('Charts / Lists switch', () => {
    it('without a choice a device takes what it can carry: charts, or lists where canvas charts once crashed the page', () => {
        expect(dash({ safeDevice: false }).context._wfDashView()).toBe('charts');
        expect(dash({ safeDevice: true }).context._wfDashView()).toBe('lists');
    });
    it('the owner\'s choice wins on any device, either way', () => {
        expect(dash({ safeDevice: true, saved: 'charts' }).context._wfDashView()).toBe('charts');
        expect(dash({ safeDevice: false, saved: 'lists' }).context._wfDashView()).toBe('lists');
    });
    it('a rubbish saved value or blocked storage falls back to the device default', () => {
        expect(dash({ safeDevice: false, saved: 'pie' }).context._wfDashView()).toBe('charts');
        expect(dash({ safeDevice: true, storageThrows: true }).context._wfDashView()).toBe('lists');
        expect(dash({ safeDevice: false, storageThrows: true }).context._wfDashView()).toBe('charts');
    });
    it('the dashboard has both buttons, the device default is charts first, and Chart.js is only fetched when charts are wanted', () => {
        expect(html).toContain('id="dashViewCharts"');
        expect(html).toContain('id="dashViewLists"');
        expect(html).toContain("onclick=\"_wfSetDashView('charts')\"");
        expect(html).toContain("onclick=\"_wfSetDashView('lists')\"");
        const dashFn = html.slice(html.indexOf('function renderDash()'), html.indexOf('function renderUpcoming()'));
        expect(dashFn.indexOf("_wfDashView() === 'charts'")).toBeLessThan(dashFn.indexOf('window._wfChartThen'));
    });
    it('the warm-up and the mail screen still decide by the device, not by the switch (no surprise Chart.js download on a phone)', () => {
        const warm = html.slice(html.indexOf('window._wfWarmCharts = function'), html.indexOf('window.ensureTF = function'));
        expect(warm).toContain('window._wfUseSafeDashboardCharts()');
        expect(warm).not.toContain('_wfDashView');
    });
});

describe('Expense Breakdown ring and legend', () => {
    it('lists the categories largest first with their share, dropping zeroes and rubbish', () => {
        const { context } = dash();
        const { rows, total } = context._wfDashCategoryRows({ Food: 300, Fuel: 100, Zero: 0, Neg: -5, Junk: 'x', Rent: 600 });
        expect(Array.from(rows).map((r) => Array.from(r))).toEqual([['Rent', 600], ['Food', 300], ['Fuel', 100]]);
        expect(total).toBe(1000);
    });
    it('draws one legend row per category, colour-coded like the ring, names escaped, shares rounded', () => {
        const { context } = dash();
        const out = context._wfDashLegendHtml({ 'A <b>': 1, B: 3 });
        expect(out).toContain('data-i="0"');
        expect(out).toContain('data-i="1"');
        expect(out).not.toContain('<b>');
        expect(out).toContain('75%'); expect(out).toContain('25%');
        expect(out.indexOf('B')).toBeLessThan(out.indexOf('A &lt;b&gt;'));
        expect(context._wfDashLegendHtml({})).toContain('No expenses');
    });
    it('the canvas legend is gone (it was drawn past the card\'s edge) and the HTML legend can shrink and scroll instead of overflowing', () => {
        const dashFn = html.slice(html.indexOf('function renderDash()'), html.indexOf('function renderUpcoming()'));
        expect(dashFn).toContain('legend: { display: false }');
        expect(dashFn).not.toContain("position: 'right'");
        expect(html).toMatch(/\.dash-pie-legend \{[^}]*min-width: 0[^}]*overflow-y: auto/);
        expect(html).toMatch(/\.dash-pie-wrap \{[^}]*flex-wrap: wrap/);
        expect(html).toMatch(/\.dash-pie-name \{[^}]*text-overflow: ellipsis/);
    });
});

describe('the amount under the pointer or finger', () => {
    const rows = [['Rent', 600], ['Food', 300], ['Fuel', 100]];
    it('the canvas tooltip (cut off at the canvas) is replaced by an element of the page', () => {
        const dashFn = html.slice(html.indexOf('function renderDash()'), html.indexOf('function renderUpcoming()'));
        expect(dashFn).toMatch(/tooltip: \{ enabled: false, external:/);
        expect(html).toMatch(/\.dash-pie-tip \{[^}]*position: fixed/);
        expect(html).toMatch(/\.dash-pie-tip \{[^}]*pointer-events: none/);
    });
    it('shows category, exact amount and share, and puts the same figures in the ring\'s centre', () => {
        const { context, tip, els } = dash({ rows, total: 1000 });
        context._wfPieFocus(1, { x: 400, y: 300 });
        expect(tip.shown).toBe(true);
        expect(tip.innerHTML).toContain('Food');
        expect(tip.innerHTML).toContain('LKR 300');
        expect(tip.innerHTML).toContain('30%');
        expect(els.dashPieTotal.textContent).toBe('S300');
        expect(els.dashPieNote.textContent).toBe('Food');
    });
    it('clearing puts the total back and hides the card', () => {
        const { context, tip, els } = dash({ rows, total: 1000 });
        context._wfPieFocus(0, { x: 400, y: 300 });
        context._wfPieFocus(-1);
        expect(tip.shown).toBe(false);
        expect(els.dashPieTotal.textContent).toBe('S1000');
        expect(els.dashPieNote.textContent).toBe('spent this year');
    });
    it('stays inside the screen on all four sides, phone or desktop', () => {
        for (const [vw, vh] of [[390, 700], [1280, 800], [320, 480]]) {
            for (const at of [{ x: 0, y: 0 }, { x: vw, y: 0 }, { x: 0, y: vh }, { x: vw, y: vh }, { x: vw / 2, y: 5 }, { x: vw / 2, y: vh / 2 }, { x: vw - 3, y: vh / 2 }, { x: 2, y: vh / 2 }]) {
                const { context, tip } = dash({ rows, total: 1000, vw, vh, tipSize: { w: 220, h: 70 } });
                context._wfPieFocus(0, at);
                const left = parseInt(tip.style.left, 10), top = parseInt(tip.style.top, 10);
                expect(left).toBeGreaterThanOrEqual(8); expect(left + 220).toBeLessThanOrEqual(vw - 8);
                expect(top).toBeGreaterThanOrEqual(8); expect(top + 70).toBeLessThanOrEqual(vh - 8);
            }
        }
    });
    it('a slice near the top of the screen puts the card below it instead of above', () => {
        const { context, tip } = dash({ rows, total: 1000 });
        context._wfPieFocus(0, { x: 500, y: 20 });
        expect(parseInt(tip.style.top, 10)).toBeGreaterThan(20);
    });
    it('a slice in the lower half of the ring puts the card under the ring, one in the upper half above it — never over the slice', () => {
        const { context, tip } = dash({ rows, total: 1000, tipSize: { w: 200, h: 60 } });
        context._wfPieFocus(0, { x: 500, y: 400, below: true });
        expect(parseInt(tip.style.top, 10)).toBeGreaterThanOrEqual(400);
        context._wfPieFocus(0, { x: 500, y: 400, below: false });
        expect(parseInt(tip.style.top, 10) + 60).toBeLessThanOrEqual(400);
        const dashJs = html.slice(html.indexOf('function _wfPieSliceAt('), html.indexOf('function _wfPieFocusRow('));
        expect(dashJs).toContain('below: !upper');
    });
    it('a stale index (the rows changed under a finger) is a clear, not a crash', () => {
        const { context, tip } = dash({ rows, total: 1000 });
        expect(() => context._wfPieFocus(9, { x: 1, y: 1 })).not.toThrow();
        expect(tip.shown).toBe(false);
    });
    it('the legend answers a mouse, a keyboard and a tap, and a tap elsewhere puts it back', () => {
        const wire = html.slice(html.indexOf('function _wfPieWire()'), html.indexOf('function _renderSafeDashboardCharts('));
        for (const ev of ["'mouseover'", "'mouseleave'", "'click'", "'focusin'", "'focusout'", "'pointerdown'"]) expect(wire).toContain(ev);
        expect(html).toContain('tabindex="0"');
    });
});

describe('Monthly Overview fills its card (no blank band under the line)', () => {
    it('the line chart has no fixed height: it takes what is left of the card, and the canvas cannot make the card grow', () => {
        expect(html).not.toMatch(/id="dashChartCanvas" style="height/);
        expect(html).toMatch(/id="dashChartCanvas" class="dash-line-wrap"/);
        expect(html).toMatch(/\.dash-card-fill \{[^}]*flex-direction: column/);
        expect(html).toMatch(/\.dash-line-wrap \{[^}]*flex: 1 1 0[^}]*min-height: 230px/);
        expect(html).toMatch(/\.dash-line-plot \{[^}]*position: relative[^}]*flex: 1 1 0/);
        expect(html).toMatch(/\.dash-line-plot > canvas \{[^}]*position: absolute/);
        expect(html).toMatch(/<div class="card dash-card-fill">\s*<div class="card-header">\s*<div>\s*<div class="card-title">Monthly Overview/);
    });
    it('the chart sizes itself to its box and names its two lines with the chart\'s own legend (it belongs to the datasets, cannot overflow the card)', () => {
        const dashFn = html.slice(html.indexOf('function renderDash()'), html.indexOf('function renderUpcoming()'));
        const line = dashFn.slice(dashFn.indexOf("type: 'line'"), dashFn.indexOf("const catMap = {}"));
        expect(line).toContain('maintainAspectRatio: false');
        expect(line).toMatch(/legend: \{ display: true, position: 'top', align: 'end'/);
        expect(line).toContain("label: 'Income'"); expect(line).toContain("label: 'Expenses'");
        expect(html).not.toContain('dash-line-key');
    });
});

describe('the line chart legend follows the theme', () => {
    it('a theme switch hands the live chart the new text colour (Chart.js keeps the colour it was given)', () => {
        let colour = '#475569'; let updated = null;
        const chart = { options: { plugins: { legend: { labels: { color: '#475569' } } } }, update: (mode) => { updated = mode; } };
        const context = vm.createContext({ document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => ' ' + colour + ' ' }), window: {}, dashChartInst: chart });
        vm.runInContext(source('_wfDashLegendColor') + '\n' + source('_wfDashChartTheme'), context);
        colour = '#cbd5e1';
        context._wfDashChartTheme();
        expect(chart.options.plugins.legend.labels.color).toBe('#cbd5e1');
        expect(updated).toBe('none');
    });
    it('no chart (lists view, a phone, Chart.js not loaded) is a no-op, never an error', () => {
        const context = vm.createContext({ document: { documentElement: {} }, getComputedStyle: () => ({ getPropertyValue: () => '' }), window: {}, dashChartInst: null });
        vm.runInContext(source('_wfDashLegendColor') + '\n' + source('_wfDashChartTheme'), context);
        expect(() => context._wfDashChartTheme()).not.toThrow();
        expect(context._wfDashLegendColor()).toBe('#94a3b8');
    });
    it('the theme switch calls it, and the chart is created with the same colour helper', () => {
        const apply = html.slice(html.indexOf('function _applyThemeSafe('), html.indexOf('function toggleTheme()'));
        expect(apply).toContain('window._wfDashChartTheme()');
        const dashFn = html.slice(html.indexOf('function renderDash()'), html.indexOf('function renderUpcoming()'));
        expect(dashFn).toContain('color: _wfDashLegendColor()');
    });
});
