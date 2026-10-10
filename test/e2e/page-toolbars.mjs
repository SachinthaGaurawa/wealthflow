/** Browser regression for the page toolbars: the main button of Income and Expenses sits in the top row of the page, beside
 * (or, on a phone, above) the filters, at every screen width, and the page never scrolls sideways.
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/page-toolbars.mjs
 */
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, SEED());

const go = async (name) => {
    await page.evaluate((n) => showPage(n, [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'" + n + "'"))), name);
    await page.waitForTimeout(500);
};

for (const name of ['incRecv', 'expenses']) {
    await go(name);
    for (const width of [1920, 1440, 1280, 1100, 1024, 900, 768, 641, 600, 430, 390, 360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        const m = await page.evaluate((n) => {
            const bar = document.querySelector('#page-' + n + ' .sh-actions');
            const main = bar && bar.querySelector('.btn-primary');
            if (!main) return null;
            const box = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width }; };
            const others = [...bar.children].filter((c) => c !== main && c.offsetParent !== null).map(box);
            return { main: box(main), bar: box(bar), topOfOthers: Math.min(...others.map((o) => o.top)), scroll: document.documentElement.scrollWidth - innerWidth };
        }, name);
        check(!!m, `${name}: the page has no main button in its toolbar`);
        if (!m) continue;
        const where = `${name} at ${width}px`;
        check(m.scroll <= 0, `${where}: the page scrolls sideways by ${m.scroll}px`);
        check(m.main.left >= -0.5 && m.main.right <= width + 0.5, `${where}: the main button sticks out of the screen`);
        if (width <= 640) {
            check(m.main.top <= m.topOfOthers + 1, `${where}: on a phone the main button comes first, above the filters`);
            check(m.main.width >= m.bar.right - m.bar.left - 2, `${where}: on a phone the main button is as wide as the page`);
        } else {
            check(m.main.top < m.topOfOthers + 24, `${where}: the main button fell onto a line of its own below the filters`);
        }
    }
}

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();
if (fail.length) { console.error(fail.join('\n')); process.exit(1); }
console.log('the Income and Expenses toolbars keep the main button in the top row at every width');
