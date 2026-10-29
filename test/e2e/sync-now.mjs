/* =============================================================================
 * test/e2e/sync-now.mjs — Sync now syncs, does not open the advisor, and leaves nothing on screen stale
 * -----------------------------------------------------------------------------
 * Reported 2026-10-29: Sync now in the More sheet opened the AI Financial Advisor instead of syncing, and "when it syncs, everything in the whole
 * system has to refresh". On the real page, at phone size:
 *   - each of the sheet's quick buttons (Search, Sync now, Light mode) does its own job and sends NOTHING to the advisor and never opens it
 *     (the cause: the page's advisor handler matched the sheet's `data-q`);
 *   - Sync now runs every step in order (account, phone inbox, devices, then every screen), reports them, and the page you are on stays put;
 *   - a change that reached the data without a write (what a pull from another device looks like) is on the page in front AND on the dashboard
 *     behind it afterwards, and the advisor's own questions still work.
 *
 * Run from the repository root:  node test/e2e/sync-now.mjs
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const app = await bootApp({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForFunction(() => !!(window.DB && window.refreshApp && window.WFSyncHealth && window.WFSyncHealth.runRefresh && window.WFShell !== null), null, { timeout: 20000 });
console.log('page: DB, refreshApp and the step runner are loaded');

const welcome = page.locator('#wfPostUpdate');
if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Return to Dashboard' }).click();
    await welcome.waitFor({ state: 'hidden' });
}

const active = () => page.evaluate(() => { const a = document.querySelector('.page.active'); return a ? a.id.replace('page-', '') : ''; });
const openMore = async () => { await page.click('#wfTabbar button:has-text("More")'); await page.waitForSelector('.wf-sheet [data-wf-act="sync"]'); };

// the page's two servers answer: the phone inbox is empty, the text server has nothing owed
await page.route('**/api/inbox-pull', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) }));
await page.route('**/api/sms-notify', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, summary: { sent: 0 } }) }));
await page.evaluate(() => { const t = 'h.' + btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).replace(/=+$/, '') + '.s'; firebase.auth().currentUser.getIdToken = async () => t; });

// every question sent to the advisor, and the result of every Sync now
await page.evaluate(() => {
    // sendAIMessage makes the advisor page visible before it sends, so a question sent is a showPage('ai') (the advisor layers call each other, so the function itself is not wrapped)
    window.__asked = [];
    const show = window.showPage;
    window.showPage = function (id) { if (id === 'ai') window.__asked.push('showPage(ai)'); return show.apply(this, arguments); };
    window.__runs = [];
    const H = window.WFSyncHealth; const run = H.runRefresh;
    H.runRefresh = async function (steps, opts) { const r = await run.call(H, steps, opts); window.__runs.push(r); return r; };
});
await page.evaluate(() => window.showPage('expenses'));
await page.waitForFunction(() => document.querySelector('.page.active') && document.querySelector('.page.active').id === 'page-expenses');

/* ── 1. the other quick buttons do their own job and say nothing to the advisor ── */
await openMore();
await page.click('.wf-sheet [data-wf-act="search"]');
await page.waitForTimeout(400);
assert.equal(await active(), 'expenses', 'Search does not leave the page');
assert.deepEqual(await page.evaluate(() => window.__asked), [], 'Search sent nothing to the advisor');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await openMore();
const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
await page.click('.wf-sheet [data-wf-act="theme"]');
await page.waitForTimeout(500);
assert.notEqual(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), themeBefore, 'Light mode switches the theme');
assert.equal(await active(), 'expenses');
assert.deepEqual(await page.evaluate(() => window.__asked), [], 'Light mode sent nothing to the advisor');
await page.evaluate(() => window.toggleTheme());
await page.waitForTimeout(300);
console.log('1. Search, Light mode  -> each does its own job; nothing sent to the advisor, the page stays put');

/* ── 2. a change that reached the data without a write is on every screen after Sync now ── */
await page.evaluate(() => { window.appData.expenses.push({ id: 'zz-sync-1', desc: 'ZZ SYNC TEST', cat: 'Food', amount: 777, month: '2026-10', createdAt: new Date().toISOString(), _ut: Date.now() }); });
assert.doesNotMatch(await page.textContent('#page-expenses'), /ZZ SYNC TEST/, 'the page in front is stale until Sync now');
assert.doesNotMatch(await page.evaluate(() => document.getElementById('dashRecent').textContent), /ZZ SYNC TEST/, 'and so is the dashboard behind it');

await openMore();
await page.click('.wf-sheet [data-wf-act="sync"]');
await page.waitForFunction(() => window.__runs.length === 1, null, { timeout: 15000 });
const run = await page.evaluate(() => window.__runs[0]);
assert.equal(await active(), 'expenses', 'Sync now does not leave the page you are on');
assert.equal(await page.evaluate(() => document.querySelector('#page-ai').classList.contains('active')), false, 'and does not open the advisor');
assert.deepEqual(await page.evaluate(() => window.__asked), [], 'and sends nothing to it: "sync" is not a question');
const ids = run.rows.map((r) => r.id);
assert.deepEqual(ids.filter((i) => ['cloud', 'phone', 'texts', 'devices', 'screens', 'notifications', 'advisor', 'texts-log', 'update-card', 'sync-notice'].includes(i)).sort(),
    ['cloud', 'devices', 'notifications', 'phone', 'screens', 'sync-notice', 'texts', 'texts-log', 'update-card', 'advisor'].sort(), 'every step is accounted for');
assert.equal(ids[0], 'cloud', 'the account is first');
assert.ok(ids.indexOf('screens') > Math.max(ids.indexOf('phone'), ids.indexOf('devices')), 'the screens are repainted after every data step');
assert.deepEqual(run.failed, [], 'nothing failed: ' + JSON.stringify(run.rows.filter((r) => !r.ok)));
const byId = Object.fromEntries(run.rows.map((r) => [r.id, r]));
assert.equal(byId.advisor.skipped, true, 'the advisor page is only repainted when it is the page in front');
assert.equal(byId['update-card'].skipped, true, 'and the update card only when Settings is');
assert.equal(byId.texts.skipped, true, 'no text messages in use, so nothing is asked of the text server');
assert.match(await page.textContent('#page-expenses'), /ZZ SYNC TEST/, 'the page in front shows it');
assert.match(await page.evaluate(() => document.getElementById('dashRecent').textContent), /ZZ SYNC TEST/, 'so does the dashboard behind it');
console.log('2. Sync now            -> ' + ids.join(' > ') + '; the page stays put; the new record is on the page and on the dashboard');

/* ── 3. text messages in use: the server is asked to look; the advisor page is repainted when it is in front ── */
await page.evaluate(() => { window.__runs.length = 0; window.DB.set('debtors', [{ id: 'dS', name: 'Nimal', phone: '+94771234567', sms_notifications_enabled: true, sms_enabled_at: 1, events: [{ id: 'e1', kind: 'lent', amount: 1000, date: '2026-10-01', confirmed: true }] }]); });
await page.evaluate(() => window.showPage('ai'));
await page.waitForFunction(() => document.querySelector('.page.active') && document.querySelector('.page.active').id === 'page-ai');
await page.evaluate(() => { window.__asked.length = 0; });
await page.waitForTimeout(1100);                                   // the first refresh holds the button for its one full spin
await page.evaluate(() => window.refreshApp(document.getElementById('topRefreshBtn')));
await page.waitForFunction(() => window.__runs.length === 1, null, { timeout: 15000 });
const run2 = await page.evaluate(() => window.__runs[0]);
const by2 = Object.fromEntries(run2.rows.map((r) => [r.id, r]));
assert.equal(by2.texts.skipped, false, 'with text messages in use the server is asked to look');
assert.equal(by2.advisor.skipped, false, 'and the advisor page, in front, is repainted');
assert.equal(by2['update-card'].skipped, true);
assert.deepEqual(run2.failed, [], 'nothing failed: ' + JSON.stringify(run2.rows.filter((r) => !r.ok)));
assert.equal(await active(), 'ai');
console.log('3. texts on, advisor   -> text server asked, advisor page repainted');

// the advisor's own suggestion pills still send their question
await page.waitForSelector('.ai-suggestion-pill');
const pill = await page.locator('.ai-suggestion-pill').first();
const ask = await pill.getAttribute('data-q');
await pill.click();
await page.waitForFunction((q) => document.getElementById('page-ai').textContent.includes(q), ask, { timeout: 5000 });
assert.ok(ask.length > 5, 'a suggestion pill still sends its own question, which appears in the chat');
console.log('   advisor pill        -> still sends its question: "' + ask.slice(0, 50) + '"');

assert.deepEqual(errors, [], 'no page error: ' + errors.join(' | '));
await app.close();
console.log('\nsync-now e2e: all checks passed');
