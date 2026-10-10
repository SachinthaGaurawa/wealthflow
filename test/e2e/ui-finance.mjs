/** Browser regression for the finance pages: amounts that never wrap, one number written once, a pay button
 * that can be read in both themes, capped insight strips, and one-line stat figures on a phone.
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/ui-finance.mjs
 * WF_FIN_ARTIFACTS optionally selects the screenshot directory (default /tmp/wealthflow-finance).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const artifacts = process.env.WF_FIN_ARTIFACTS || '/tmp/wealthflow-finance';
await fs.mkdir(artifacts, { recursive: true });
const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, SEED());
await page.setViewportSize({ width: 1440, height: 900 });

const go = async (name) => {
    await page.evaluate((n) => showPage(n, [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'" + n + "'"))), name);
    await page.waitForTimeout(900);
};
const theme = (t) => page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t);

// ── One way to write a figure: written out below a million, "M" from a million, never lakhs ──
const fm = await page.evaluate(() => ({
    mid: fmtS(184000), big: fmtS(3500000), small: fmtS(4200), neg: fmtS(-150000),
    exactMid: fmtExact(198700), exactBig: fmtExact(3500000),
}));
check(fm.mid === 'LKR 184,000', `a figure under a million is written out, got ${fm.mid}`);
check(fm.big === 'LKR 3.50M', `a figure from a million is shortened to M, got ${fm.big}`);
check(fm.neg === 'LKR -150,000', `a negative figure keeps its sign, got ${fm.neg}`);
check(!/\dL\b/.test(Object.values(fm).join(' ')), `no figure should use the lakh unit, got ${JSON.stringify(fm)}`);
check(fm.exactMid === '' && /3,500,000/.test(fm.exactBig), `the exact line appears only under an abbreviated figure, got ${JSON.stringify([fm.exactMid, fm.exactBig])}`);

// ── Monthly Plan: no amount or header figure wraps, in either theme ──────────
const oneLine = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.getBoundingClientRect().width > 0).filter((e) => e.getClientRects().length > 1 || e.getBoundingClientRect().height > 1.6 * parseFloat(getComputedStyle(e).lineHeight || 20)).map((e) => e.textContent.trim().slice(0, 40)), sel);
for (const t of ['dark', 'light']) {
    await theme(t);
    await go('monthly');
    check((await page.evaluate(() => document.querySelectorAll('#monthlyContent .td-r').length)) > 0, 'Monthly Plan should list amounts for the seeded month');
    for (const sel of ['#monthlyContent .td-r', '#monthlyContent .card-sub', '#monthlyContent .mhi-val', '#monthlyContent .mh-bal']) {
        const wrapped = await oneLine(sel);
        check(wrapped.length === 0, `${t}: ${sel} wraps onto two lines: ${wrapped.join(' | ')}`);
    }
    await page.screenshot({ path: path.join(artifacts, `monthly-${t}-1440.png`), fullPage: true });
}

// ── Bank Loans ───────────────────────────────────────────────────────────────
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
for (const t of ['dark', 'light']) {
    await theme(t);
    await go('loans');
    const cta = await page.evaluate(() => {
        const b = document.querySelector('.loan-pay-cta'); if (!b) return null;
        const cs = getComputedStyle(b), num = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        return { fg: num(cs.color), bg: num(cs.backgroundColor), anim: cs.animationName };
    });
    check(!!cta, `${t}: the loan card should offer the pay button for this month`);
    if (cta) {
        const [a, b] = [lum(cta.fg), lum(cta.bg)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        check(ratio >= 4.5, `${t}: the pay button text has contrast ${ratio.toFixed(2)}:1, needs 4.5:1`);
        check(cta.anim === 'none', `${t}: the pay button should not pulse, animation is ${cta.anim}`);
    }
    const wrappedDetails = await oneLine('.loan-card .ld-v');
    check(wrappedDetails.length === 0, `${t}: loan detail figures wrap: ${wrappedDetails.join(' | ')}`);
    const tiles = await page.evaluate(() => ({
        open: [...document.querySelectorAll('#wfLoanInsights .wfx')].filter((e) => e.getBoundingClientRect().height > 0).length,
        all: document.querySelectorAll('#wfLoanInsights .wfx').length,
        toggle: !!document.querySelector('#wfLoanInsights .wfx-toggle'),
    }));
    check(tiles.all <= 2 ? !tiles.toggle : (tiles.open === 2 && tiles.toggle), `${t}: the loan insight strip should open two tiles and offer the rest, got ${JSON.stringify(tiles)}`);
    const dup = await page.evaluate(() => [...document.querySelectorAll('#page-loans .stat-card')].filter((c) => { const v = (c.querySelector('.stat-val') || {}).textContent, m = (c.querySelector('.stat-meta') || {}).textContent; return v && m && m.replace(/\.00$/, '').trim() === v.trim(); }).length);
    check(dup === 0, `${t}: a loan stat card repeats its own figure in the line under it`);
    await page.screenshot({ path: path.join(artifacts, `loans-${t}-1440.png`), fullPage: true });
}

// ── Phone: a stat card is one line (name left, figure right), on every finance page ──
await theme('dark');
await page.setViewportSize({ width: 390, height: 844 });
for (const name of ['incRecv', 'loans', 'ccinstall', 'cheques']) {
    await go(name);
    const rows = await page.evaluate((n) => [...document.querySelectorAll('#page-' + n + ' :is(.g3,.g4,.g5) > .stat-card')].filter((c) => c.getBoundingClientRect().height > 0).map((c) => {
        const l = c.querySelector('.stat-label').getBoundingClientRect(), v = c.querySelector('.stat-val').getBoundingClientRect();
        return { h: Math.round(c.getBoundingClientRect().height), side: v.left >= l.right - 1 };
    }), name);
    check(rows.length > 0, `${name}: no stat cards found on the page`);
    check(rows.every((r) => r.h <= 92 && r.side), `${name}: phone stat cards should be one short row each, got ${JSON.stringify(rows)}`);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `${name} at 390px scrolls sideways by ${over}px`);
    await page.screenshot({ path: path.join(artifacts, `${name}-dark-390.png`), fullPage: false });
}

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log('ok: finance pages verified (figures, Monthly Plan, loan card in two themes, phone stat rows)');
