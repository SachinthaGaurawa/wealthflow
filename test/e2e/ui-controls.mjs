/** Browser regression for control layout on Settings and the AI Advisor header: a drop-down shows the whole of the option it
 * holds (it used to read "LKR — Sr" or "3 (defa"), the "Last Backup" card keeps a readable text column with its button below
 * it on a phone, and the AI Advisor's icon-only Clear chat button is not stretched into a full-width bar.
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/ui-controls.mjs
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

for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const [W, H] of [[390, 844], [820, 1000], [1440, 900]]) {
        await page.setViewportSize({ width: W, height: H });
        await page.evaluate(() => showPage('settings', [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'settings'"))));
        await page.waitForTimeout(700);
        const got = await page.evaluate(() => {
            const ctx = document.createElement('canvas').getContext('2d');
            const cut = [];
            for (const s of document.querySelectorAll('#page-settings select')) {
                const r = s.getBoundingClientRect();
                const o = s.options[s.selectedIndex];
                if (r.width < 2 || !o) continue;
                const cs = getComputedStyle(s);
                ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
                const need = ctx.measureText(o.text).width, room = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
                if (need > room + 3) cut.push(`"${o.text}" needs ${Math.round(need)}px, has ${Math.round(room)}px`);
            }
            const card = document.querySelector('#page-settings .wf-bk-card');
            let bk = null;
            if (card) {
                const cr = card.getBoundingClientRect(), txt = card.children[1].getBoundingClientRect(), btn = card.querySelector('button').getBoundingClientRect();
                bk = { textW: Math.round(txt.width), btnInside: btn.left >= cr.left - 1 && btn.right <= cr.right + 1, cardInside: cr.right <= innerWidth + 1 };
            }
            return { cut, bk, over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        check(got.cut.length === 0, `${theme} @${W}: a drop-down on Settings is cut off: ${got.cut.join('; ')}`);
        check(!!got.bk, `${theme} @${W}: the Last Backup card was not found`);
        if (got.bk) {
            check(got.bk.btnInside && got.bk.cardInside, `${theme} @${W}: the Backup Now button leaves its card or the screen`);
            check(got.bk.textW >= (W <= 540 ? 200 : 260), `${theme} @${W}: the Last Backup text column is only ${got.bk.textW}px wide`);
        }
        check(got.over <= 1, `${theme} @${W}: Settings scrolls sideways by ${got.over}px`);

        await page.evaluate(() => showPage('ai', [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'ai'"))));
        await page.waitForTimeout(700);
        const ai = await page.evaluate(() => {
            const b = document.querySelector('#page-ai .sh-actions .btn-ghost'), chip = document.getElementById('aiPersonaStatus');
            const br = b.getBoundingClientRect(), cr = chip.getBoundingClientRect();
            return { btnW: Math.round(br.width), chipW: Math.round(cr.width), over: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        check(ai.btnW <= 64, `${theme} @${W}: the AI Advisor's Clear chat button is ${ai.btnW}px wide, it should keep its icon size`);
        if (W <= 540) check(ai.chipW >= 300, `${theme} @${W}: the AI Advisor status chip should take its own row, it is ${ai.chipW}px wide`);
        check(ai.over <= 1, `${theme} @${W}: the AI Advisor scrolls sideways by ${ai.over}px`);
    }
}

// ── A row of four stat cards never leaves one card alone on a second row; the Monthly Plan's six figures neither ──
const PAGES = await page.evaluate(() => [...new Set([...document.querySelectorAll('.nav-item')].map((e) => (/showPage\('([A-Za-z]+)'/.exec(e.getAttribute('onclick') || '') || [])[1]).filter(Boolean))]);
for (const [W, H] of [[390, 844], [820, 1000], [1024, 768], [1280, 800], [1440, 900]]) {
    await page.setViewportSize({ width: W, height: H });
    for (const name of PAGES) {
        await page.evaluate((n) => showPage(n, [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'" + n + "'"))), name);
        await page.waitForTimeout(450);
        const got = await page.evaluate(() => {
            const orphans = [];
            for (const g of document.querySelectorAll('.page.active :is(.g3, .g4, .g5, .mh-row, .wf-acct-stats)')) {
                const kids = [...g.children].filter((k) => k.getBoundingClientRect().width > 20 && k.getBoundingClientRect().height > 20);
                if (kids.length < 4 || kids.length > 8) continue;
                const rows = [];
                for (const k of kids) { const t = Math.round(k.getBoundingClientRect().top); const r = rows.find((x) => Math.abs(x.t - t) < 8); if (r) r.n++; else rows.push({ t, n: 1 }); }
                rows.sort((a, b) => a.t - b.t);
                if (rows.length > 1 && Math.max(...rows.map((r) => r.n)) >= 3 && rows[rows.length - 1].n === 1) orphans.push(`${String(g.className).slice(0, 24)} (${kids.length} cards, last row has 1)`);
            }
            // A tile left alone on the last row takes the whole row.
            for (const g of document.querySelectorAll('.page.active .ai-brief-stats')) {
                const kids = [...g.children]; if (kids.length < 3) continue;
                const last = kids[kids.length - 1].getBoundingClientRect(), prev = kids[kids.length - 2].getBoundingClientRect(), gr = g.getBoundingClientRect();
                if (Math.abs(last.top - prev.top) > 8 && last.width < gr.width * 0.9) orphans.push(`ai-brief-stats (last of ${kids.length} tiles is alone at ${Math.round(last.width)}px of ${Math.round(gr.width)}px)`);
            }
            // Text that should never reach a screen.
            const txt = (document.querySelector('.page.active') || {}).innerText || '';
            const leak = (txt.match(/\bundefined\b|\bNaN\b|\[object Object\]/g) || []).slice(0, 3);
            return { orphans, leak };
        });
        check(got.orphans.length === 0, `${name} @${W}: ${got.orphans.join('; ')}`);
        check(got.leak.length === 0, `${name} @${W}: the screen shows ${got.leak.join(', ')}`);
    }
}

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log('ok: Settings drop-downs show their whole value, the Last Backup card stays readable, the AI Advisor header keeps its shape, stat rows leave no orphan card and no screen shows undefined/NaN (390 to 1440)');
