/* =============================================================================
 * test/e2e/sms-notices.mjs — the text-message switch, on the real page
 * -----------------------------------------------------------------------------
 * The unit tests pin the rules; this asks the page itself: that the switch, the phone and the NIC are in the
 * investment form and the debtor form, that a bad number is refused BEFORE anything is saved, that a good one is
 * stamped, that editing a record (which the investment form rebuilds from its inputs) does not forget the switch,
 * and that the delivered alert appears when the server mirrors a delivery.
 *
 * Run from the repository root:  node test/e2e/sms-notices.mjs
 * No real number, account or gateway is used; the page's calls to /api/sms-notify go to the harness, which does not serve them.
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const app = await bootApp();
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => !!(window.WFSms && window.WFLiquidity && window.DB), null, { timeout: 20000 });
console.log('page: WFSms, WFLiquidity and DB are loaded');

// A fresh install legitimately displays release notes: dismiss them through their own button, as the owner would.
const welcome = page.locator('#wfPostUpdate');
if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Return to Dashboard' }).click();
    await welcome.waitFor({ state: 'hidden' });
}

/* ── the debtor form ──────────────────────────────────────────────────────── */
await page.evaluate(() => { DB.set('debtors', []); window.openDebtorModal(null); });
await page.waitForSelector('#_db_sms_on');
assert.equal(await page.isVisible('#_db_sms_nic'), false, 'the number and NIC stay folded until the switch is on');
assert.match(await page.textContent('[data-wf-sms="_db_sms"]'), /never carry interest/, 'a loan promises no interest');

await page.fill('#_db_name', 'Nimal');
await page.fill('#_db_amount', '50000');
await page.fill('#_db_phone', '12345');
await page.check('#_db_sms_on');
await page.click('#_db_save');
const refused = await page.evaluate(() => ({ saved: (DB.get('debtors') || []).length, msg: document.getElementById('_db_sms_err').textContent }));
console.log('1. bad number         ->', JSON.stringify(refused));
assert.equal(refused.saved, 0, 'nothing is saved while the number is not one the gateway can reach');
assert.ok(refused.msg.length > 10, 'and the owner is told why');

await page.fill('#_db_phone', '077 123 4567');
await page.fill('#_db_sms_nic', '853400937v');
const before = Date.now();
await page.click('#_db_save');
const saved = await page.evaluate(() => (DB.get('debtors') || [])[0]);
console.log('2. good number        ->', JSON.stringify({ on: saved.sms_notifications_enabled, at: !!saved.sms_enabled_at, phone: saved.phone, nic: saved.nic, events: saved.events.length }));
assert.equal(saved.sms_notifications_enabled, true);
assert.ok(saved.sms_enabled_at >= before - 1000 && saved.sms_enabled_at <= Date.now() + 1000, 'stamped when it was switched on');
assert.equal(saved.phone, '077 123 4567');
assert.equal(saved.nic, '853400937V', 'the NIC is cleaned');
assert.equal(saved.events.length, 1, 'the first advance is still recorded');
assert.equal(saved.events[0].confirmed, true);

/* editing keeps the stamp, so history is never re-announced */
const stamp = saved.sms_enabled_at;
await page.evaluate(() => window.openDebtorModal((DB.get('debtors') || [])[0]));
await page.waitForSelector('#_db_sms_on');
assert.equal(await page.isChecked('#_db_sms_on'), true, 'the switch shows how it was left');
assert.equal(await page.inputValue('#_db_sms_nic'), '853400937V');
await page.fill('#_db_name', 'Nimal Perera');
await page.click('#_db_save');
const edited = await page.evaluate(() => (DB.get('debtors') || [])[0]);
assert.equal(edited.name, 'Nimal Perera');
assert.equal(edited.sms_enabled_at, stamp, 'editing a record that is already on keeps its stamp');

/* switching it off */
await page.evaluate(() => window.openDebtorModal((DB.get('debtors') || [])[0]));
await page.waitForSelector('#_db_sms_on');
await page.uncheck('#_db_sms_on');
await page.click('#_db_save');
const off = await page.evaluate(() => (DB.get('debtors') || [])[0]);
console.log('3. switched off       ->', off.sms_notifications_enabled, off.phone);
assert.equal(off.sms_notifications_enabled, false);
assert.equal(off.phone, '077 123 4567', 'the number is kept for when it is switched on again');

/* ── the investment form ──────────────────────────────────────────────────── */
await page.evaluate(() => { DB.set('income', []); window.clearIncomeForm(); window.openModal('mdIncome'); });
await page.waitForSelector('#i_sms_on');
await page.fill('#i_name', 'Fixed Deposit');
await page.fill('#i_company', 'Kumar');
await page.fill('#i_amount', '500000');
await page.fill('#i_rate', '24');
await page.fill('#i_start', '2026-10-05');
await page.fill('#i_day', '2026-10-05');
await page.check('#i_sms_on');
await page.click('button[onclick="saveIncome()"]');
const none = await page.evaluate(() => ({ saved: (DB.get('income') || []).length, msg: document.getElementById('i_sms_err').textContent }));
console.log('4. no number          ->', JSON.stringify(none));
assert.equal(none.saved, 0, 'an investment switched on with no number is not saved');

await page.fill('#i_sms_phone', '0771234567');
await page.click('button[onclick="saveIncome()"]');
const inv = await page.evaluate(() => (DB.get('income') || [])[0]);
console.log('5. investment saved   ->', JSON.stringify({ on: inv.sms_notifications_enabled, phone: inv.phone, at: !!inv.sms_enabled_at }));
assert.equal(inv.sms_notifications_enabled, true);
assert.equal(inv.phone, '0771234567');
assert.ok(inv.sms_enabled_at > 0);

/* the form rebuilds the record from its inputs: an edit must carry the fields over */
const invStamp = inv.sms_enabled_at;
await page.evaluate((id) => window.editIncome(id), inv.id);
await page.waitForSelector('#i_sms_on');
assert.equal(await page.isChecked('#i_sms_on'), true);
assert.equal(await page.inputValue('#i_sms_phone'), '0771234567');
await page.fill('#i_notes', 'edited');
await page.click('button[onclick="saveIncome()"]');
const invEdited = await page.evaluate(() => (DB.get('income') || [])[0]);
assert.equal(invEdited.notes, 'edited');
assert.equal(invEdited.sms_notifications_enabled, true, 'saving an edit does not switch the texts off');
assert.equal(invEdited.sms_enabled_at, invStamp);
assert.equal(invEdited.phone, '0771234567');

/* a record that never had the switch is left exactly as it was */
await page.evaluate(() => { DB.set('income', [{ id: 'old1', name: 'Old', company: 'Bank', amount: 1000, rate: 10, start: '2025-01-01', end: '', freq: 'monthly', day: '2025-01-01', monthly: 8.33, notes: '' }]); window.editIncome('old1'); });
await page.waitForSelector('#i_sms_on');
assert.equal(await page.isChecked('#i_sms_on'), false);
await page.click('button[onclick="saveIncome()"]');
const untouched = await page.evaluate(() => (DB.get('income') || [])[0]);
assert.equal(untouched.sms_notifications_enabled, false, 'saving it with the switch off records "off", not a stamp');
assert.equal(untouched.sms_enabled_at, undefined);

/* ── the alert and the log ────────────────────────────────────────────────── */
const alert = await page.evaluate(async () => {
    const seen = [];
    const orig = window.notify;
    window.notify = (m, t) => { seen.push([m, t]); };
    // what the server mirrors when a delivery goes out, handed to the page's own announcer
    const mod = await import(document.querySelector('script[src*="wealthflow-sms"]').src);
    const out = mod.announce([{ id: 'x1', status: 'sent', sentAt: 5, to: '+94*****4567', ref: 'DEB-1A2B3C', alert: mod.ALERT_TITLE }], { seenSentAt: 0, first: false });
    window.notify = orig;
    return { toasts: out.toasts, seen };
});
console.log('6. delivery alert     ->', JSON.stringify(alert.toasts));
assert.equal(alert.toasts.length, 1);
assert.equal(alert.toasts[0].text, 'Admin Alert: SMS Delivered Successfully to Tenant');

await page.evaluate(() => window.WFSms.openPanel());
await page.waitForSelector('#_wf_sms_body');
assert.match(await page.textContent('#_wf_sms_body'), /No text messages yet/);
await page.click('#_wf_sms_x');

assert.deepEqual(errors, [], 'no uncaught page errors: ' + errors.join(' | '));
console.log('the text-message switch behaves on the real page');
await app.close();
