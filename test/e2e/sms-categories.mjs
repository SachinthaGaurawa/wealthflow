/* =============================================================================
 * test/e2e/sms-categories.mjs — Settings > Text messages: a switch per kind of text, on the real page
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-29: choose which kinds of text may be sent. This opens Settings in real Chromium and checks the section is there, every switch starts on,
 * pressing one saves it into the synced settings (the server reads it from there) and flips it in place, and a second press turns it back on.
 *
 * Run from the repository root:  node test/e2e/sms-categories.mjs
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const app = await bootApp();
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => !!(window.WFSms && window.DB), null, { timeout: 20000 });

const welcome = page.locator('#wfPostUpdate');
if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Return to Dashboard' }).click();
    await welcome.waitFor({ state: 'hidden' });
}

await page.evaluate(() => window.showPage('settings'));
await page.waitForSelector('#_wf_sms_cats');
const keys = await page.$$eval('#_wf_sms_cats [data-sms-cat]', (n) => n.map((x) => x.getAttribute('data-sms-cat')));
assert.deepEqual(keys, ['loan', 'card', 'cheque', 'once', 'bill', 'investments', 'debtors', 'late'], 'a switch for each kind, in order');
assert.equal(await page.locator('#_wf_sms_cats .toggle.on').count(), 8, 'every kind starts on');
console.log('settings: eight switches, all on');

const loan = page.locator('#_wf_sms_cats [data-sms-cat="loan"]');
await loan.click();
assert.equal(await loan.getAttribute('aria-checked'), 'false', 'pressed once: off, in place');
const saved = await page.evaluate(() => DB.getObj('settings', {}).sms_cats);
assert.equal(saved.loan.on, false, 'and saved into the synced settings');
assert.ok(saved.loan.at > 0);
assert.equal(await page.locator('#_wf_sms_cats .toggle.on').count(), 7, 'the others are untouched');
console.log('loan switched off and saved:', JSON.stringify(saved.loan));

// the section is drawn from the stored value after a redraw of the screen
await page.evaluate(() => window.showPage('dashboard'));
await page.evaluate(() => window.showPage('settings'));
await page.waitForSelector('#_wf_sms_cats');
assert.equal(await page.locator('#_wf_sms_cats [data-sms-cat="loan"]').getAttribute('aria-checked'), 'false', 'still off after the screen is drawn again');

await page.locator('#_wf_sms_cats [data-sms-cat="loan"]').click();
const again = await page.evaluate(() => DB.getObj('settings', {}).sms_cats.loan);
assert.equal(again.on, true);
assert.equal(await page.locator('#_wf_sms_cats .toggle.on').count(), 8);
console.log('loan switched back on:', JSON.stringify(again));

assert.deepEqual(errors, [], 'no page errors');
await app.close();
console.log('OK');
