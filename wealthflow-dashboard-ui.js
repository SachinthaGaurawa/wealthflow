/*
 * Read-only dashboard presentation. Financial arithmetic stays in the books
 * pipeline; this module receives an already reconciled view model and never
 * mutates the user's books or browser storage.
 */
const HOST_ID = 'wfDashboardExperience';
const SVG_NS = 'http://www.w3.org/2000/svg';

const host = () => typeof document === 'undefined' ? null : document.getElementById(HOST_ID);

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
}

function svgElement(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
}

const money = (value, currency = 'LKR') => `${currency} ${(Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

function replace(content) {
    const target = host();
    if (target) target.replaceChildren(content);
    return target;
}

function emptyState() {
    const state = element('section', 'wf-dash-empty');
    state.append(
        element('h2', '', 'No financial activity yet'),
        element('p', '', 'Verified transactions will build this overview automatically.'),
    );
    return state;
}

function seriesPath(rows, key, maximum) {
    return rows.map((row, index) => {
        const x = 48 + index * 624 / Math.max(1, rows.length - 1);
        const y = 220 - Math.max(0, Number(row[key]) || 0) / maximum * 174;
        return `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
}

function chart(model) {
    const rows = model.series || [];
    const card = element('section', 'wf-dash-chart-card');
    const heading = element('div', 'wf-dash-section-head');
    heading.append(element('div', '', 'Cash flow trajectory'), element('span', '', model.year || ''));
    card.append(heading);

    const summaryId = `wfDashSummary${model.year || 'Current'}`;
    const summary = element('p', 'wf-dash-chart-summary');
    summary.id = summaryId;
    summary.dataset.wfChartSummary = '';
    summary.textContent = rows.map((row) => `${row.label}: income ${money(row.income, model.currency)}; expenses ${money(row.expense, model.currency)}`).join('. ');

    const svg = svgElement('svg', {
        viewBox: '0 0 720 260',
        role: 'img',
        'aria-label': 'Income and expenses by month',
        'aria-describedby': summaryId,
        preserveAspectRatio: 'xMidYMid meet',
    });
    svg.append(svgElement('line', { x1: 48, y1: 220, x2: 680, y2: 220, class: 'wf-dash-axis' }));
    const maximum = Math.max(1, ...rows.flatMap((row) => [Number(row.income) || 0, Number(row.expense) || 0]));

    ['income', 'expense'].forEach((key) => {
        svg.append(svgElement('path', { d: seriesPath(rows, key, maximum), class: `wf-dash-line is-${key}`, fill: 'none' }));
        rows.forEach((row, index) => {
            const label = `${row.label}, ${key}, ${money(row[key], model.currency)}`;
            const point = svgElement('circle', {
                cx: (48 + index * 624 / Math.max(1, rows.length - 1)).toFixed(1),
                cy: (220 - Math.max(0, Number(row[key]) || 0) / maximum * 174).toFixed(1),
                r: 7,
                tabindex: 0,
                'data-wf-point': key,
                'aria-label': label,
            });
            const title = svgElement('title');
            title.textContent = label;
            point.append(title);
            svg.append(point);
        });
    });
    card.append(svg, summary);
    return card;
}

function hasActivity(model) {
    return (model.overview || []).some((item) => Math.abs(Number(item.value) || 0) > 0)
        || (model.series || []).some((item) => (Number(item.income) || 0) || (Number(item.expense) || 0))
        || (model.categories || []).some((item) => Number(item.value) || 0)
        || (model.attention || []).length;
}

function render(model = {}) {
    if (!hasActivity(model)) return replace(emptyState());

    const root = element('div', 'wf-dash-experience');
    const hero = element('header', 'wf-dash-hero');
    hero.append(
        element('h1', '', 'Your money, reconciled and actionable'),
        element('span', `wf-dash-freshness is-${model.freshness?.state || 'unknown'}`, model.freshness?.label || 'Update status unavailable'),
    );
    root.append(hero);

    const overview = element('section', 'wf-dash-overview');
    (model.overview || []).forEach((item) => {
        const metric = element('article', `wf-dash-metric is-${item.tone || 'neutral'}`);
        metric.append(
            element('span', 'wf-dash-metric-label', item.label),
            element('strong', 'wf-dash-metric-value', money(item.value, model.currency)),
        );
        overview.append(metric);
    });
    root.append(overview);

    const priority = element('div', 'wf-dash-priority-grid');
    const attention = element('section', 'wf-dash-attention');
    attention.append(element('h2', '', 'Needs your attention'));
    if (!(model.attention || []).length) {
        attention.append(element('p', '', 'Everything important is reconciled.'));
    } else {
        const list = element('ul');
        model.attention.forEach((item) => {
            const row = element('li', `is-${item.severity || 'info'}`);
            row.append(element('strong', '', item.title), element('span', '', item.detail));
            list.append(row);
        });
        attention.append(list);
    }

    const provenance = element('ol', 'wf-dash-provenance');
    provenance.setAttribute('aria-label', 'Data provenance');
    [model.source?.from, model.source?.through, model.source?.to].filter(Boolean).forEach((label, index) => {
        const item = element('li');
        item.append(element('span', '', String(index + 1).padStart(2, '0')), element('strong', '', label));
        provenance.append(item);
    });
    priority.append(attention, provenance);
    root.append(priority, chart(model));

    const categories = element('section', 'wf-dash-categories');
    categories.append(element('h2', '', 'Where money went'));
    const total = (model.categories || []).reduce((sum, item) => sum + Math.max(0, Number(item.value) || 0), 0) || 1;
    (model.categories || []).forEach((item) => {
        const row = element('div', 'wf-dash-category');
        const meter = element('span', 'wf-dash-category-meter');
        meter.style.setProperty('--wf-share', `${Math.max(2, Math.round((Number(item.value) || 0) / total * 100))}%`);
        row.append(element('span', '', item.label), meter, element('strong', '', money(item.value, model.currency)));
        categories.append(row);
    });
    root.append(categories);
    return replace(root);
}

function renderSkeleton() {
    const state = element('div', 'wf-dash-experience is-loading');
    for (let index = 0; index < 3; index += 1) state.append(element('div', 'wf-dash-skeleton'));
    return replace(state);
}

function renderError() {
    const state = element('section', 'wf-dash-error');
    state.setAttribute('role', 'alert');
    state.append(
        element('h2', '', 'Dashboard unavailable'),
        element('p', '', 'Your financial records are safe. Try refreshing this view.'),
    );
    return replace(state);
}

function destroy() {
    const target = host();
    if (target) target.replaceChildren();
}

export const dashboardUI = Object.freeze({ render, renderSkeleton, renderError, destroy });
if (typeof window !== 'undefined') window.WealthFlowDashboardUI = dashboardUI;
