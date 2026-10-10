/** Browser regression for the tracking and tools pages: every page names itself in the top bar, explainer notes
 * read in both themes, and the sessions page says only what the code does.
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/ui-tools.mjs
 */
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, SEED());
await page.setViewportSize({ width: 1280, height: 900 });

const go = async (name) => {
    await page.evaluate((n) => showPage(n, [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'" + n + "'"))), name);
    await page.waitForTimeout(900);
};

// ── Every page names itself in the top bar (CRIB and Balance used to show the raw page id) ──
const pages = await page.evaluate(() => [...document.querySelectorAll('.page')].map((p) => p.id.replace(/^page-/, '')));
check(pages.length >= 20, `expected the app's pages, found ${pages.length}`);
for (const name of pages) {
    await go(name);
    const title = await page.evaluate(() => (document.getElementById('pgTitle') || {}).textContent || '');
    check(title.trim().length > 0 && title.trim() !== name, `page "${name}" shows "${title.trim()}" in the top bar instead of a title`);
}

// ── Explainer notes: readable in both themes ─────────────────────────────────
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const [name, sel] of [['debtdemo', '#debtDemoContent .wf-note'], ['montecarlo', '#page-montecarlo .wf-note']]) {
        await go(name);
        const got = await page.evaluate((s) => {
            const el = document.querySelector(s); if (!el) return null;
            const cs = getComputedStyle(el), num = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
            return { fg: num(cs.color), bg: num(cs.backgroundColor) };
        }, sel);
        check(!!got, `${theme}: ${name} should show its explainer as a .wf-note`);
        if (got) {
            const [a, b] = [lum(got.fg), lum(got.bg)].sort((x, y) => y - x);
            const ratio = (a + 0.05) / (b + 0.05);
            check(ratio >= 4.5, `${theme}: the ${name} note has contrast ${ratio.toFixed(2)}:1, needs 4.5:1`);
        }
    }
}

// ── Sessions: plain statements, no marketing claims ──────────────────────────
await go('sessions');
const text = await page.evaluate(() => document.getElementById('page-sessions').innerText);
check(!/military|hyper-accurate|milliseconds|enterprise-grade/i.test(text), 'the sessions page should not make claims the code does not back');
check(/How this list works/.test(text) && /75 seconds/.test(text), 'the sessions page should explain how online status is decided');

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log('ok: tools and tracking pages verified (titles, explainer notes in two themes, honest sessions copy)');
