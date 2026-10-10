/** Browser regression for page toolbars, the top bar and sideways-sliding tables at phone, tablet, laptop and desktop
 * widths: a page's controls (History, month picker, view switch, sort, the primary "Add …" button) stay on one row
 * wherever they can fit and the primary button is never left alone on a row; the page title is never crushed by the
 * top bar; a table's first column is solid (no text showing through it) and its action buttons stay in view.
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/ui-toolbars.mjs
 * WF_TB_ARTIFACTS optionally selects the screenshot directory (default /tmp/wealthflow-toolbars).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const artifacts = process.env.WF_TB_ARTIFACTS || '/tmp/wealthflow-toolbars';
await fs.mkdir(artifacts, { recursive: true });
const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, SEED());

const PAGES = ['incRecv', 'income', 'loans', 'ccinstall', 'cconetime', 'cheques', 'expenses', 'subscriptions', 'targets', 'balance'];
const go = async (name) => {
    await page.evaluate((n) => showPage(n, [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'" + n + "'"))), name);
    await page.waitForTimeout(650);
};
/** Rows of the visible controls in a page's toolbar, controls cut off by the screen edge, and whether the primary button sits alone. */
const toolbar = (name) => page.evaluate((n) => {
    const act = document.querySelector('#page-' + n + ' .sh-actions');
    if (!act) return null;
    const kids = [...act.querySelectorAll(':scope > *, :scope > .sh-end > *')].filter((k) => !k.classList.contains('sh-end') && k.getBoundingClientRect().width > 1 && getComputedStyle(k).display !== 'none');
    const rects = kids.map((k) => { const r = k.getBoundingClientRect(); return { k, cls: String(k.className).slice(0, 18), mid: Math.round(r.top + scrollY + r.height / 2), left: Math.round(r.left), right: Math.round(r.right) }; });
    const rows = [];
    for (const r of rects.slice().sort((a, b) => a.mid - b.mid)) {
        const last = rows[rows.length - 1];
        if (last && Math.abs(last.mid - r.mid) <= 10) last.items.push(r); else rows.push({ mid: r.mid, items: [r] });
    }
    const primary = rects.find((r) => r.k.classList.contains('btn-primary'));
    return {
        rows: rows.length,
        count: rects.length,
        clipped: rects.filter((r) => r.left < -1 || r.right > innerWidth + 1).map((r) => r.cls),
        primaryAlone: !!primary && rows.some((row) => row.items.length === 1 && row.items[0] === primary),
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
}, name);

for (const [W, H] of [[1920, 1000], [1440, 900], [1280, 800], [1180, 800], [1024, 768], [820, 1000], [390, 844]]) {
    await page.setViewportSize({ width: W, height: H });
    await page.waitForTimeout(250);

    // ── The top bar keeps the page title readable at every width ──
    await go('incRecv');
    const bar = await page.evaluate(() => {
        const t = document.querySelector('.topbar .pg-title'), r = document.querySelector('.topbar .tb-right'), m = document.querySelector('.topbar .month-badge');
        const tr = t.getBoundingClientRect(), rr = r.getBoundingClientRect(), mr = m.getBoundingClientRect();
        return { titleW: Math.round(tr.width), titleClipped: t.scrollWidth > t.clientWidth + 1, gap: Math.round(rr.left - tr.right), monthLines: Math.round(mr.height) };
    });
    check(!bar.titleClipped && bar.titleW >= 60 && bar.gap >= 0, `top bar @${W}: the page title is crushed or overlapped (${JSON.stringify(bar)})`);
    check(bar.monthLines <= 44, `top bar @${W}: the month badge wraps onto two lines (${bar.monthLines}px tall)`);

    for (const name of PAGES) {
        await go(name);
        const t = await toolbar(name);
        if (!t) { fail.push(`${name} @${W}: no .sh-actions toolbar found`); continue; }
        check(t.clipped.length === 0, `${name} @${W}: toolbar controls are cut off by the screen edge: ${t.clipped.join(', ')}`);
        check(t.over <= 1, `${name} @${W}: the page scrolls sideways by ${t.over}px`);
        // On a desktop the whole toolbar is a single row (this is what dropped "Add Income" onto a row of its own).
        if (W >= 1280) check(t.rows === 1, `${name} @${W}: the toolbar wraps onto ${t.rows} rows, it should be one`);
        // At any width the primary button is never left alone on a row while other controls exist.
        check(!(t.primaryAlone && t.count > 1), `${name} @${W}: the primary button is alone on its own row`);
        if (W === 390 && (name === 'incRecv' || name === 'expenses')) check(t.rows <= 3, `${name} @390: the toolbar takes ${t.rows} rows, at most 3 are expected`);
        if (name === 'incRecv') {
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.screenshot({ path: path.join(artifacts, `${name}-${W}.png`) });
        }
    }

    // ── Tables that slide sideways: solid first column, action buttons always in view ──
    for (const name of ['cheques', 'ccinstall', 'cconetime']) {
        await go(name);
        const tb = await page.evaluate((n) => {
            const wrap = document.querySelector('#page-' + n + ' .tbl-wrap');
            if (!wrap) return null;
            const table = wrap.querySelector('table');
            const firstTd = table.querySelector('tbody td:first-child'), lastTd = table.querySelector('tbody tr:not(.done-row) td:last-child') || table.querySelector('tbody td:last-child');
            const alpha = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return 0; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
            wrap.scrollLeft = 0;
            const wr = wrap.getBoundingClientRect(), lr = lastTd.getBoundingClientRect();
            const btn = lastTd.querySelector('.ib'), br = btn && btn.getBoundingClientRect();
            return {
                slides: wrap.scrollWidth > wrap.clientWidth + 2,
                firstBgAlpha: alpha(getComputedStyle(firstTd).backgroundColor) || (getComputedStyle(firstTd).backgroundImage !== 'none' ? 1 : 0),
                actionsInView: !!br && br.right <= wr.right + 1 && br.left >= wr.left - 1,
                firstSticky: getComputedStyle(firstTd).position === 'sticky',
                lastSticky: getComputedStyle(lastTd).position === 'sticky',
                lastRight: Math.round(lr.right - wr.right),
            };
        }, name);
        if (!tb) { fail.push(`${name} @${W}: no table found`); continue; }
        check(tb.firstBgAlpha >= 0.99, `${name} @${W}: the first column has a see-through background, scrolled text shows through it`);
        check(tb.actionsInView, `${name} @${W}: the Edit/Delete buttons are scrolled out of view (${JSON.stringify(tb)})`);
        if (tb.slides) check(tb.lastSticky, `${name} @${W}: the table slides sideways but its actions column is not pinned`);
    }
}

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log('ok: page toolbars, top bar and sliding tables verified at 390/820/1024/1180/1280/1440/1920');
