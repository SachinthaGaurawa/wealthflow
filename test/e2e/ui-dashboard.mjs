/** Browser regression for the dashboard: reading order, summary bar, capped feeds, chart axis units,
 * and no sideways scroll in either theme. Real Chromium, stubbed Firebase, invented books.
 * Run from the repository root:  node test/e2e/ui-dashboard.mjs
 * WF_DASH_ARTIFACTS optionally selects the screenshot directory (default /tmp/wealthflow-dashboard).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const artifacts = process.env.WF_DASH_ARTIFACTS || '/tmp/wealthflow-dashboard';
await fs.mkdir(artifacts, { recursive: true });
const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, SEED());
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => showPage('dashboard', document.querySelector('.nav-item')));
await page.waitForTimeout(1200);

const y = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e || getComputedStyle(e).display === 'none') return null; return Math.round(e.getBoundingClientRect().top); }, sel);
const visibleCount = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().height > 0).length, sel);

// ── Reading order: money first, housekeeping last ────────────────────────────
const order = {};
for (const [k, sel] of Object.entries({ greet: '#wfGreet', stats: '#dashStats', runway: '#wfRunway', brief: '#wfBrief', queue: '#wfVerifyQueue', charts: '.dash-chart-row', lists: '#page-dashboard > .g2', sync: '#wfMailSync', ai: '#page-dashboard > .golden-frame' })) order[k] = await y(sel);
const seq = ['greet', 'stats', 'runway', 'brief', 'queue', 'charts', 'lists', 'sync', 'ai'].filter((k) => order[k] != null);
check(order.greet != null && order.stats != null, `greeting and summary bar should both be on the page, got ${JSON.stringify(order)}`);
check(seq.every((k, i) => i === 0 || order[seq[i - 1]] <= order[k]), `blocks are out of order: ${JSON.stringify(order)}`);
check(await page.evaluate(() => /^Good (morning|afternoon|evening|night)/.test((document.querySelector('.wf-greet-h') || {}).textContent || '')), 'the greeting should open with a part of the day');

// ── Summary bar ──────────────────────────────────────────────────────────────
const stats = await page.evaluate(() => ({
    cards: document.querySelectorAll('#dashStats .stat-card').length,
    neg: document.querySelectorAll('#dashStats .stat-val.is-neg').length,
    cols: getComputedStyle(document.getElementById('dashStats')).gridTemplateColumns.split(' ').length,
}));
check(stats.cards === 5, `expected 5 summary figures, got ${stats.cards}`);
check(stats.cols === 5, `the summary bar should be five columns on a desktop, got ${stats.cols}`);
check(stats.neg >= 1, 'a negative net saving should be marked is-neg');

// ── Attention feed: three open, the rest one tap away, and the choice survives a redraw ──
check((await visibleCount('#wfBrief .wfx')) === 3, `the attention feed should show 3 tiles, shows ${await visibleCount('#wfBrief .wfx')}`);
const toggleText = await page.evaluate(() => (document.querySelector('#wfBrief .wfx-toggle') || {}).textContent);
check(/^Show \d+ more$/.test(toggleText || ''), `the feed needs a "Show N more" toggle, got ${JSON.stringify(toggleText)}`);
await page.locator('#wfBrief .wfx-toggle').click();
const opened = await visibleCount('#wfBrief .wfx');
check(opened > 3, `tapping the toggle should reveal the rest, shows ${opened}`);
check((await page.locator('#wfBrief .wfx-toggle').getAttribute('aria-expanded')) === 'true', 'the toggle should say it is expanded');
await page.evaluate(() => renderDash());
await page.waitForTimeout(300);
check((await visibleCount('#wfBrief .wfx')) === opened, 'an open feed should stay open when the dashboard redraws');
await page.locator('#wfBrief .wfx-toggle').click();
check((await visibleCount('#wfBrief .wfx')) === 3, 'tapping again should fold the feed back to 3');

// ── Confirmation queue: four open, the rest one tap away, nothing about the rows' behaviour changed ──
const q0 = await visibleCount('#wfVerifyQueue .wf-vq-row');
check(q0 === 4, `the confirmation queue should show 4 rows, shows ${q0}`);
const total = await page.evaluate(() => document.querySelectorAll('#wfVerifyQueue .wf-vq-row').length);
check(total > 4, 'the seeded books should have more than four rows waiting');
await page.locator('#wfVerifyQueue [data-vq-toggle]').click();
check((await visibleCount('#wfVerifyQueue .wf-vq-row')) === total, 'the toggle should reveal every row');
check(await page.evaluate(() => [...document.querySelectorAll('#wfVerifyQueue [data-vq-ok]')].length === document.querySelectorAll('#wfVerifyQueue .wf-vq-row').length), 'every row keeps its confirm button, shown or not');
await page.locator('#wfVerifyQueue [data-vq-toggle]').click();

// ── Chart axis: one unit for the whole axis ─────────────────────────────────
const ax = await page.evaluate(() => {
    const t = (vals) => vals.map((v) => ({ value: v }));
    const run = (vals) => vals.map((v, i, a) => fmtAxis(v, i, t(a)));
    return { m: run([0, 200000, 400000, 600000, 800000, 1000000, 1200000]), k: run([0, 200000, 400000, 600000]), small: run([0, 2000, 4000]) };
});
check(ax.m.join() === '0,0.2M,0.4M,0.6M,0.8M,1.0M,1.2M', `a million-scale axis should use one unit and one precision, got ${ax.m.join()}`);
check(ax.k.join() === '0,200K,400K,600K', `a hundred-thousand-scale axis should read 200K, 400K, 600K, got ${ax.k.join()}`);
check(ax.small.join() === '0,2,000,4,000', `a small axis stays in plain numbers, got ${ax.small.join()}`);

// ── No sideways scroll, both themes, common widths ───────────────────────────
for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const width of [360, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: width < 900 ? 800 : 900 });
        await page.waitForTimeout(250);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(over <= 1, `${theme} ${width}px: the dashboard scrolls sideways by ${over}px`);
        if (width === 1440 || width === 390) await page.screenshot({ path: path.join(artifacts, `dashboard-${theme}-${width}.png`), fullPage: true });
    }
}
if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log('ok: dashboard verified (order, summary bar, capped feeds, axis units, no sideways scroll in two themes)');
