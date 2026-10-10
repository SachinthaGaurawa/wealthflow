/** Browser regression for the app frame: tab bar, "More" sheet, command palette, theme, and the
 * rule that no screen scrolls sideways. Real Chromium, stubbed Firebase, no real account.
 * Run from the repository root:  node test/e2e/ui-shell.mjs
 * WF_SHELL_ARTIFACTS optionally selects the screenshot directory (default /tmp/wealthflow-shell).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootApp } from './harness.mjs';

const artifacts = process.env.WF_SHELL_ARTIFACTS || '/tmp/wealthflow-shell';
const PAGES = ['dashboard', 'monthly', 'incRecv', 'income', 'loans', 'ccinstall', 'cconetime', 'cheques', 'liquidity', 'expenses',
    'targets', 'dscr', 'score', 'crib', 'subscriptions', 'debtdemo', 'montecarlo', 'cashflow3d', 'sessions', 'ai', 'settings'];
const WIDTHS = [360, 390, 768, 1280];

const app = await bootApp();
const { page } = app;
await fs.mkdir(artifacts, { recursive: true });
const shot = (name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

// The welcome note may be on screen after sign-in; it is not what this test is about.
const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});

// A few records so the palette has something of the user's own to find.
await page.evaluate(() => {
    DB.set('loans', [{ id: 'L1', name: 'Honda Vezel — vehicle loan', bank: 'HNB', start: '2025-03-01', duration: 60, monthly: 112400, amount: 5200000, rate: 12.5, payments: [], skipped: [] }], true);
    DB.set('subscriptions', [{ id: 'S1', name: 'Netflix <b>x</b>', amount: 3990, cycle: 'monthly', category: 'Entertainment', dueDay: 12 }], true);
});
const go = async (name) => {
    await page.evaluate((n) => showPage(n, [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes(`'${n}'`))), name);
    await page.waitForTimeout(250);
};
const activePage = () => page.evaluate(() => (document.querySelector('.page.active') || {}).id);
const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; }, sel);

// ── The design system actually loaded ────────────────────────────────────────
const sys = await page.evaluate(async () => {
    await document.fonts.ready;
    const cs = getComputedStyle(document.documentElement);
    return {
        bg: cs.getPropertyValue('--wf-bg').trim(),
        legacyBg: cs.getPropertyValue('--bg').trim(),
        font: getComputedStyle(document.body).fontFamily,
        geist: document.fonts.check('14px Geist'),
        mark: !!document.querySelector('#sidebar svg.wf-mark use'),
    };
});
check(sys.bg === '#0a0d13', `--wf-bg should be #0a0d13 in the dark theme, got "${sys.bg}"`);
check(/Geist/.test(sys.font), `body font should start with Geist, got ${sys.font}`);
check(sys.geist, 'the self-hosted Geist face did not load');
check(sys.mark, 'the sidebar logo should be the inline SVG mark');

// ── Desktop: sidebar + top bar, no tab bar; palette finds screens and the user's own records ──
await page.setViewportSize({ width: 1280, height: 900 });
await go('dashboard');
check(!(await visible('.wf-tabbar')), 'the tab bar must not show on a desktop');
check(await visible('.wf-search'), 'the search box should be in the desktop top bar');
check(!(await visible('.wf-topmark')), 'the top-bar mark is for phones; the sidebar carries the logo on desktop');
await page.keyboard.press('Control+k');
await page.waitForSelector('#wfPalOv.open');
check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'wfPalIn'), 'the palette input should take focus');
await page.keyboard.type('loan');
await page.waitForTimeout(150);
const labels = await page.$$eval('.wf-pal-it span', (els) => els.map((e) => e.textContent));
check(labels[0] === 'Bank Loans', `"loan" should rank the Bank Loans screen first, got ${JSON.stringify(labels)}`);
check(labels.includes('Add loan'), '"loan" should offer the Add loan action');
check(labels.some((l) => /Honda Vezel/.test(l)), 'the palette should find the user\'s own loan by name');
await shot('desktop-palette');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
check((await activePage()) === 'page-loans', 'Enter on the first result should open Bank Loans');
check(!(await visible('#wfPalOv.open')), 'the palette should close after choosing');
// a record name containing markup is shown as text, never executed
await page.keyboard.press('Control+k');
await page.keyboard.type('netflix');
await page.waitForTimeout(150);
check(await page.evaluate(() => !document.querySelector('#wfPalList b') && /Netflix <b>x<\/b>/.test(document.getElementById('wfPalList').textContent)),
    'a record name with markup must render as text');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(!(await page.evaluate(() => document.getElementById('wfPalOv').classList.contains('open'))), 'Escape should close the palette');
check(await page.evaluate(() => !document.documentElement.classList.contains('wf-sheet-open')), 'the page must be released when the palette closes');
await page.keyboard.press('/');
await page.waitForSelector('#wfPalOv.open');
await page.keyboard.press('Escape');

// ── Phone: tab bar, More sheet ───────────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await go('dashboard');
await page.waitForTimeout(250);
check(await visible('.wf-tabbar'), 'the tab bar should show on a phone');
check(await visible('.wf-topmark'), 'the phone header should carry the logo mark');
check(!(await visible('.mobile-btn')), 'the hamburger is replaced by the tab bar');
const tabs = await page.$$eval('.wf-tab', (els) => els.map((e) => ({ t: e.textContent.trim(), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width, cur: e.getAttribute('aria-current') })));
check(tabs.length === 5, `expected 5 tabs, got ${tabs.length}`);
check(tabs.every((t) => t.h >= 44 && t.w >= 44), 'every tab must be at least 44 px square');
check(tabs[0].cur === 'page', 'Home should be the current tab on the dashboard');
await page.locator('.wf-tab[data-page="loans"]').click();
await page.waitForTimeout(350);
check((await activePage()) === 'page-loans', 'the Loans tab should open Bank Loans');
check((await page.locator('.wf-tab[data-page="loans"]').getAttribute('aria-current')) === 'page', 'the Loans tab should be marked current');
await page.locator('.wf-tab[data-more]').click();
await page.waitForSelector('#wfSheetOv.open');
await page.waitForTimeout(450);
const sheet = await page.evaluate(() => ({
    items: [...document.querySelectorAll('.wf-item')].map((e) => e.textContent.trim()),
    groups: [...document.querySelectorAll('.wf-grp')].map((e) => e.textContent.trim()),
    h: document.querySelector('.wf-sheet').getBoundingClientRect().height,
    vh: innerHeight,
    small: [...document.querySelectorAll('.wf-item, .wf-quick button, .wf-signout')].filter((e) => e.getBoundingClientRect().height < 44).length,
}));
check(sheet.items.some((t) => /CC Installments/.test(t)) && sheet.items.some((t) => /Settings/.test(t)), `More should list the other screens, got ${JSON.stringify(sheet.items)}`);
check(sheet.groups.includes('Finance') && sheet.groups.includes('Tools'), 'More should keep the sidebar\'s groups');
check(!sheet.items.some((t) => /^(Loans|Bank Loans)$/.test(t)), 'screens already in the tab bar are not repeated in More');
check(sheet.h <= sheet.vh * 0.9, 'the sheet must leave the top of the screen visible');
check(sheet.small === 0, `${sheet.small} sheet controls are shorter than 44 px`);
await shot('mobile-more');
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
check(!(await page.evaluate(() => document.getElementById('wfSheetOv').classList.contains('open'))), 'Escape should close the sheet');
await page.locator('.wf-tab[data-more]').click();
await page.waitForSelector('#wfSheetOv.open');
await page.locator('.wf-item', { hasText: 'CC Installments' }).click();
await page.waitForTimeout(450);
check((await activePage()) === 'page-ccinstall', 'choosing an item in More should open that screen');
check((await page.locator('.wf-tab[data-more]').getAttribute('aria-current')) === 'page', 'More should be current while on a screen that lives in it');
check(!(await page.evaluate(() => document.getElementById('wfSheetOv').classList.contains('open'))), 'choosing should close the sheet');
// the tab bar steps aside while typing
await go('expenses');
await page.evaluate(() => { const i = document.createElement('input'); i.id = 'wfProbe'; i.type = 'text'; document.querySelector('#page-expenses').appendChild(i); i.focus(); });
await page.waitForTimeout(200);
check(await page.evaluate(() => document.body.classList.contains('wf-typing')), 'the tab bar should step aside while a field is focused');
await page.evaluate(() => { document.getElementById('wfProbe').blur(); document.getElementById('wfProbe').remove(); });
await page.waitForTimeout(200);
check(await page.evaluate(() => !document.body.classList.contains('wf-typing')), 'the tab bar should return when the field is left');

// ── Theme: the browser chrome follows, and both themes keep text legible ─────
await page.evaluate(() => toggleTheme());
await page.waitForTimeout(400);
const light = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    meta: document.querySelector('meta[name="theme-color"]').getAttribute('content'),
    bg: getComputedStyle(document.body).backgroundColor,
}));
check(light.theme === 'light' && light.meta === '#f4f5f8', `theme-color should follow the light theme, got ${JSON.stringify(light)}`);
await page.evaluate(() => toggleTheme());
await page.waitForTimeout(300);

// ── No screen scrolls sideways, in either theme, at any common width ─────────
for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width < 900 ? 800 : 900 });
        for (const pg of PAGES) {
            await go(pg);
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            check(over <= 1, `${theme} ${width}px ${pg}: the page scrolls sideways by ${over}px`);
        }
    }
}
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log(`ok: shell verified (tab bar, sheet, palette, theme, ${PAGES.length} screens x ${WIDTHS.length} widths x 2 themes without sideways scroll)`);
