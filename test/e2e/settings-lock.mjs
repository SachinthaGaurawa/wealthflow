/* The two device-lock settings in a real browser: Passcode-free entry (skipLock) must open straight to the app after a refresh when
 * on and ask for the PIN when off; the auto-lock menu must drive the idle timer (1 min, 5 min, Disabled). The 60 s timers are run
 * 240x faster so one "minute" is one tick. */
import { launchChromium, serveRepo, completeOnboarding } from './harness.mjs';
import { createCloud } from './firebase-cloud.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await serveRepo(process.cwd());
const browser = await launchChromium({ headless: true });
const cloud = createCloud();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const results = [];
const check = async (key, fn) => { try { const r = await fn(); const ok = r === true || (r && r.ok === true); results.push({ key, ok, detail: (r && r.detail) || '' }); } catch (e) { results.push({ key, ok: false, detail: 'threw ' + String(e.message).slice(0, 200) }); } };
const open = async (opts = {}) => {
  const page = await ctx.newPage();
  await cloud.attach(page);
  if (opts.fastClock) await page.addInitScript(() => { const si = window.setInterval; window.setInterval = (f, ms, ...a) => si(f, ms === 60000 ? 250 : ms, ...a); });
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  return page;
};
try {
  let page = await open();
  await completeOnboarding(page, {});
  const state = (p) => p.evaluate(() => ({ app: document.getElementById('app').classList.contains('show'), login: getComputedStyle(document.getElementById('authLogin')).display !== 'none' && document.getElementById('authScreen').classList.contains('show') }));

  await check('skipLock (Passcode-free entry): on opens straight to the app after a refresh, off asks for the PIN', async () => {
    await page.evaluate(() => showPage('settings')); await sleep(400);
    await page.evaluate(() => _applySkipLock(true)); await sleep(800);
    const stored = await page.evaluate(() => DB.getObj('auth').skipLock);
    await page.close(); page = await open(); await sleep(3500);
    const on = await state(page);
    await page.evaluate(() => showPage('settings')); await sleep(400);
    await page.evaluate(() => toggleSkipLock(false)); await sleep(800);
    await page.close(); page = await open(); await sleep(3500);
    const off = await state(page);
    return { ok: stored === true && on.app === true && off.app === false && off.login === true, detail: JSON.stringify({ stored, on, off }) };
  });
  await completeOnboarding(page, {});

  // accelerated clock: every 60 s interval becomes 250 ms, so one "minute" = one tick
  await check('autoLock (timer follows the menu: 1, 5, Disabled)', async () => {
    await page.close(); page = await open({ fastClock: true }); await completeOnboarding(page, {});
    const locked = (p) => p.evaluate(() => !document.getElementById('app').classList.contains('show'));
    const setLimit = (m) => page.evaluate((x) => { const s = DB.getObj('settings', {}); s.autoLock = x; DB.set('settings', s); }, m);
    const unlockWith = async (m) => { await setLimit(m); await completeOnboarding(page, {}); await page.evaluate(() => window.resetAutoLockTimer()); };
    await setLimit(1); await page.evaluate(() => window.resetAutoLockTimer()); await sleep(1200); const l1 = await locked(page);
    await unlockWith(30); await sleep(1500); const l5early = await locked(page); await setLimit(1); await sleep(900); const l5late = await locked(page);
    await unlockWith(0); await sleep(2500); const l0 = await locked(page);
    return { ok: l1 === true && l5early === false && l5late === true && l0 === false, detail: `1min->locked=${l1} 5min early=${l5early} late=${l5late} disabled->locked=${l0}` };
  });
} finally {
  console.log(results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.key} — ${r.detail}`).join('\n'));
  if (results.some((r) => !r.ok) || !results.length) process.exitCode = 1;
  await browser.close(); await server.close();
}
