/** Browser regression for the layers that sit above the page: a toast never covers a dialog's actions or its close
 * button, only a few show at once and the rest wait their turn, an error never waits, and the floating AI button
 * steps aside while a dialog is open.
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/ui-overlays.mjs
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

// The app greets a signed-in person with a few toasts of its own. Let them finish so each case starts from nothing.
const quiet = async () => {
    await page.waitForFunction(() => !document.querySelector('#notifs .notif'), null, { timeout: 25000 }).catch(() => {});
    await page.evaluate(() => { const h = document.getElementById('notifs'); if (h._wfQ) h._wfQ.length = 0; h.replaceChildren(); });
};
const closeDialogs = () => page.evaluate(() => { document.querySelectorAll('.mo.open').forEach((m) => m.classList.remove('open')); document.body.style.overflow = ''; });
const theme = (t) => page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t);
const shown = () => page.evaluate(() => [...document.querySelectorAll('#notifs .notif.show')].map((e) => e.textContent.trim()));
const rect = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }, sel);
const overlap = (a, b) => !!a && !!b && a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;

const LONG = 'Reminder: LKR 23,958.00 return expected today from Fixed Deposit, 12 months, at the Kandy branch';

// ── A dialog is open and messages arrive: they sit above it, one at a time, none are lost ──
for (const [label, vp] of [['desktop 1440', { width: 1440, height: 900 }], ['laptop 1280', { width: 1280, height: 720 }], ['phone 390', { width: 390, height: 844 }]]) {
    await page.setViewportSize(vp);
    await theme('dark');
    await quiet();
    await page.evaluate(() => openModal('mdLoan'));
    await page.waitForTimeout(500);
    await page.evaluate((m) => { notify(m, 'success'); notify('Second message while the dialog is open', 'info'); }, LONG);
    await page.waitForTimeout(450);
    const first = await shown();
    check(first.length === 1, `${label}: while a dialog is open one toast shows at a time, got ${first.length}`);
    const toast = await rect('#notifs .notif.show');
    const dlg = await rect('#mdLoan .md');
    check(!overlap(toast, dlg), `${label}: the toast covers the dialog (toast ${JSON.stringify(toast)}, dialog ${JSON.stringify(dlg)})`);
    for (const sel of ['#mdLoan .md-ftr .btn', '#mdLoan .md-x', '#mdLoan .md-title']) {
        const r = await rect(sel);
        check(r && !overlap(toast, r), `${label}: the toast covers ${sel}`);
    }
    const fab = await page.evaluate(() => { const f = document.querySelector('.fab-ai-btn'); return f ? getComputedStyle(f).opacity : '0'; });
    check(Number(fab) === 0, `${label}: the floating AI button should step aside while a dialog is open, opacity ${fab}`);
    // the queued message is not dropped: it appears once the first has gone
    await page.waitForFunction(() => [...document.querySelectorAll('#notifs .notif.show')].some((e) => /Second message/.test(e.textContent)), null, { timeout: 8000 })
        .catch(() => check(false, `${label}: the queued toast never appeared`));
    await closeDialogs();
}

// ── No dialog: three at a time on a desktop, along the top edge, centred ─────
await page.setViewportSize({ width: 1440, height: 900 });
await quiet();
await page.evaluate(() => { for (let i = 1; i <= 5; i++) notify('Message number ' + i, 'info'); });
await page.waitForTimeout(450);
const five = await shown();
check(five.length === 3, `on a desktop three toasts show at once, got ${five.length}: ${five.join(' | ')}`);
const host = await rect('#notifs');
check(host && host.t < 40, `toasts should sit along the top edge, host top is ${host && host.t}`);
const first = await rect('#notifs .notif.show');
check(first && Math.abs((first.l + first.r) / 2 - 720) < 3, `a desktop toast should be centred, middle is ${first && (first.l + first.r) / 2}`);

// a tap dismisses it and the next one waiting comes in
await page.locator('#notifs .notif.show').first().click();
await page.waitForFunction(() => [...document.querySelectorAll('#notifs .notif.show')].some((e) => /Message number 4/.test(e.textContent)), null, { timeout: 4000 })
    .catch(() => check(false, 'tapping a toast should let the next waiting one in'));

// an error never waits behind others
await page.evaluate(() => notify('Could not save the loan', 'error'));
await page.waitForTimeout(450);
check((await shown()).some((t) => /Could not save the loan/.test(t)), 'an error toast must show at once even when the screen is full');

// ── Phone, no dialog: two at a time ──────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await quiet();
await page.evaluate(() => { for (let i = 1; i <= 4; i++) notify('Phone message ' + i, 'info'); });
await page.waitForTimeout(450);
const ph = await shown();
check(ph.length === 2, `on a phone two toasts show at once, got ${ph.length}`);
const phr = await rect('#notifs .notif.show');
check(phr && phr.t < 24 + 8, `a phone toast should hug the top edge, top is ${phr && phr.t}`);
check(phr && phr.l >= 15 && phr.r <= 375, `a phone toast should fit the screen width, got ${JSON.stringify(phr)}`);

// ── Closing the command palette hands focus back to the page, so "/" opens it again straight away ──
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
await page.keyboard.press('Control+k');
await page.waitForSelector('#wfPalOv.open');
await page.keyboard.press('Escape');
await page.keyboard.press('/');
const reopened = await page.waitForSelector('#wfPalOv.open', { timeout: 1500 }).then(() => true, () => false);
check(reopened, 'palette: after Escape, pressing "/" straight away did not reopen it (focus stayed on the closed palette input)');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// ── Readable in both themes ──────────────────────────────────────────────────
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
await page.setViewportSize({ width: 1440, height: 900 });
for (const t of ['dark', 'light']) {
    await theme(t);
    await quiet();
    await page.evaluate((x) => notify('Contrast check ' + x, 'success'), t);
    await page.waitForTimeout(450);
    const got = await page.evaluate(() => {
        const el = document.querySelector('#notifs .notif.show'); if (!el) return null;
        const cs = getComputedStyle(el), num = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
        return { fg: num(cs.color), bg: num(cs.backgroundColor) };
    });
    check(!!got, `${t}: no toast to measure`);
    if (got) {
        const [a, b] = [lum(got.fg), lum(got.bg)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        check(ratio >= 4.5, `${t}: toast text has contrast ${ratio.toFixed(2)}:1, needs 4.5:1`);
    }
}

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log('ok: overlays verified (toasts clear of dialogs on desktop, laptop and phone, queued not dropped, errors immediate, two themes)');
