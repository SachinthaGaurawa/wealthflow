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
await page.evaluate(() => { DB.set('debtors', []); DB.set('people', []); window.openDebtorModal(null); });
await page.waitForSelector('#_db_sms_on');
assert.equal(await page.isVisible('#_db_phone'), true, 'the number, the country and the NIC / passport are on the form (the contact fields), not folded behind the switch');
assert.equal(await page.isVisible('#_db_cc'), true);
assert.equal(await page.isVisible('#_db_nic'), true);
assert.match(await page.textContent('[data-wf-sms="_db_sms"]'), /never carry interest/, 'a loan promises no interest');

await page.fill('#_db_name', 'Nimal');
await page.fill('#_db_amount', '50000');
await page.fill('#_db_phone', '12345');
await page.check('#_db_sms_on');
await page.click('#_db_save');
const refused = await page.evaluate(() => ({ saved: (DB.get('debtors') || []).length, msg: document.getElementById('_db_pv').textContent }));
console.log('1. bad number         ->', JSON.stringify(refused));
assert.equal(refused.saved, 0, 'nothing is saved while the number is not one the gateway can reach');
assert.ok(refused.msg.length > 10, 'and the owner is told why, under the number');

await page.fill('#_db_phone', '077 123 4567');
await page.fill('#_db_nic', '853400937v');
const before = Date.now();
await page.click('#_db_save');
const saved = await page.evaluate(() => (DB.get('debtors') || [])[0]);
console.log('2. good number        ->', JSON.stringify({ on: saved.sms_notifications_enabled, at: !!saved.sms_enabled_at, phone: saved.phone, nic: saved.nic, events: saved.events.length }));
assert.equal(saved.sms_notifications_enabled, true);
assert.ok(saved.sms_enabled_at >= before - 1000 && saved.sms_enabled_at <= Date.now() + 1000, 'stamped when it was switched on');
assert.equal(saved.phone, '+94771234567', 'the number is stored as E.164, the one form every device and the server read');
assert.equal(saved.nic, '853400937V', 'the NIC is cleaned');
assert.equal(saved.events.length, 1, 'the first advance is still recorded');
assert.equal(saved.events[0].confirmed, true);
const filed = await page.evaluate(() => DB.get('people'));
assert.equal(filed.length, 1, 'the person is saved to the people list by default');
assert.equal(saved.personId, filed[0].id, 'and the loan points at them');

/* editing keeps the stamp, so history is never re-announced */
const stamp = saved.sms_enabled_at;
await page.evaluate(() => window.openDebtorModal((DB.get('debtors') || [])[0]));
await page.waitForSelector('#_db_sms_on');
assert.equal(await page.isChecked('#_db_sms_on'), true, 'the switch shows how it was left');
assert.equal(await page.inputValue('#_db_nic'), '853400937V');
assert.equal(await page.inputValue('#_db_phone'), '+94 77 123 4567');
await page.fill('#_db_name', 'Nimal Perera');
await page.click('#_db_save');
await page.waitForSelector('.wfp-chooser [data-c="update"]');          // the name of a saved person changed: the owner is asked, once
await page.click('.wfp-chooser [data-c="update"]');
await page.waitForFunction(() => (DB.get('debtors') || [])[0].name === 'Nimal Perera');
const edited = await page.evaluate(() => ({ d: (DB.get('debtors') || [])[0], p: DB.get('people')[0] }));
assert.equal(edited.d.name, 'Nimal Perera');
assert.equal(edited.p.name, 'Nimal Perera', 'and the saved person followed');
assert.equal(edited.d.sms_enabled_at, stamp, 'editing a record that is already on keeps its stamp');

/* switching it off */
await page.evaluate(() => window.openDebtorModal((DB.get('debtors') || [])[0]));
await page.waitForSelector('#_db_sms_on');
await page.uncheck('#_db_sms_on');
await page.click('#_db_save');
await page.waitForFunction(() => (DB.get('debtors') || [])[0].sms_notifications_enabled === false);
const off = await page.evaluate(() => (DB.get('debtors') || [])[0]);
console.log('3. switched off       ->', off.sms_notifications_enabled, off.phone);
assert.equal(off.sms_notifications_enabled, false);
assert.equal(off.phone, '+94771234567', 'the number is kept for when it is switched on again');

/* a person in another country: an international number and a passport, no Sri Lankan NIC anywhere */
await page.evaluate(() => window.openDebtorModal(null));
await page.waitForSelector('#_db_sms_on');
await page.fill('#_db_name', 'Ahmed Khan');
await page.fill('#_db_amount', '1000');
await page.selectOption('#_db_cc', 'AE');
await page.fill('#_db_phone', '050 123 4567');
assert.match(await page.textContent('#_db_pv'), /\+971 501 234 567 \(United Arab Emirates\)/, 'the line under the number says exactly which number the texts will go to, and where');
assert.equal(await page.inputValue('#_db_idk'), 'other', 'outside Sri Lanka the ID box starts as passport / ID');
await page.fill('#_db_nic', 'x1234567');
await page.check('#_db_sms_on');
await page.click('#_db_save');
await page.waitForFunction(() => (DB.get('debtors') || []).length === 2);
const abroad = await page.evaluate(() => (DB.get('debtors') || []).find((d) => d.name === 'Ahmed Khan'));
console.log('3b. another country   ->', JSON.stringify({ phone: abroad.phone, nic: abroad.nic, on: abroad.sms_notifications_enabled }));
assert.equal(abroad.phone, '+971501234567');
assert.equal(abroad.nic, 'ID:X1234567');
assert.equal(abroad.sms_notifications_enabled, true);

/* ── the investment form ──────────────────────────────────────────────────── */
await page.evaluate(() => { DB.set('income', []); window.clearIncomeForm(); window.openModal('mdIncome'); });
await page.waitForSelector('#i_sms_host summary');
assert.equal(await page.isVisible('#i_sms_on'), false, 'the investor\'s contact and text switch are folded away until they are wanted');
await page.click('#i_sms_host summary');
await page.waitForSelector('#i_sms_on', { state: 'visible' });
await page.fill('#i_name', 'Fixed Deposit');
await page.fill('#i_company', 'Kumar');
await page.fill('#i_amount', '500000');
await page.fill('#i_rate', '24');
await page.fill('#i_start', '2026-10-05');
await page.fill('#i_day', '2026-10-05');
await page.check('#i_sms_on');
await page.click('button[onclick="saveIncome()"]');
const none = await page.evaluate(() => ({ saved: (DB.get('income') || []).length, msg: document.getElementById('i_pv').textContent }));
console.log('4. no number          ->', JSON.stringify(none));
assert.equal(none.saved, 0, 'an investment switched on with no number is not saved');
assert.ok(none.msg.length > 10);

await page.fill('#i_phone', '0771234567');
await page.click('button[onclick="saveIncome()"]');
await page.waitForFunction(() => (DB.get('income') || []).length === 1);
const inv = await page.evaluate(() => (DB.get('income') || [])[0]);
console.log('5. investment saved   ->', JSON.stringify({ on: inv.sms_notifications_enabled, phone: inv.phone, at: !!inv.sms_enabled_at }));
assert.equal(inv.sms_notifications_enabled, true);
assert.equal(inv.phone, '+94771234567');
assert.ok(inv.sms_enabled_at > 0);

/* the form rebuilds the record from its inputs: an edit must carry the fields over */
const invStamp = inv.sms_enabled_at;
await page.evaluate((id) => window.editIncome(id), inv.id);
await page.waitForSelector('#i_sms_on', { state: 'visible' });      // a record with a number opens its contact section by itself
assert.equal(await page.isChecked('#i_sms_on'), true);
assert.equal(await page.inputValue('#i_phone'), '+94 77 123 4567');
await page.fill('#i_notes', 'edited');
await page.click('button[onclick="saveIncome()"]');
await page.waitForFunction(() => (DB.get('income') || [])[0].notes === 'edited');
const invEdited = await page.evaluate(() => (DB.get('income') || [])[0]);
assert.equal(invEdited.notes, 'edited');
assert.equal(invEdited.sms_notifications_enabled, true, 'saving an edit does not switch the texts off');
assert.equal(invEdited.sms_enabled_at, invStamp);
assert.equal(invEdited.phone, '+94771234567');

/* a record that never had the switch is left exactly as it was (and filing a name in the people list never switches texts on) */
await page.evaluate(() => { DB.set('people', []); DB.set('income', [{ id: 'old1', name: 'Old', company: 'Bank', amount: 1000, rate: 10, start: '2025-01-01', end: '', freq: 'monthly', day: '2025-01-01', monthly: 8.33, notes: '' }]); window.editIncome('old1'); });
await page.waitForSelector('#i_sms_host summary');
assert.equal(await page.evaluate(() => document.querySelector('#i_sms_host details').open), false, 'no number, no ID, no switch: the section stays folded');
await page.click('button[onclick="saveIncome()"]');
await page.waitForFunction(() => (DB.get('income') || [])[0].sms_notifications_enabled === false);
const untouched = await page.evaluate(() => (DB.get('income') || [])[0]);
assert.equal(untouched.sms_notifications_enabled, false, 'saving it with the switch off records "off", not a stamp');
assert.equal(untouched.sms_enabled_at, undefined);
// whoever is named on an investment is filed (a bank too: nothing tells a bank from an investor, and a person missing from the list is the worse mistake); deleting the entry sticks
assert.equal(await page.evaluate(() => DB.get('people').filter((p) => p.name === 'Bank').length), 1, 'the name on an investment is filed in the people list');
assert.equal(await page.evaluate(() => (DB.get('income') || [])[0].sms_notifications_enabled), false, 'filing a person never switches texts on');

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
await page.waitForSelector('#wfp_msgs');                       // the log is the third tab of the people screens
assert.match(await page.textContent('#wfp_msgs'), /No text messages yet/);
assert.equal(await page.getAttribute('.wfp-hub .wfp-tab[data-v="messages"]', 'aria-selected'), 'true');
await page.click('.wfp-hub [data-h="close"]');

assert.deepEqual(errors, [], 'no uncaught page errors: ' + errors.join(' | '));
console.log('the text-message switch behaves on the real page');
await app.close();
