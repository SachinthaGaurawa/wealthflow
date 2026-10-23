/* =============================================================================
 * test/e2e/owner-otp.mjs — "Alerts to my own number", the verification-code flow on the real page
 * -----------------------------------------------------------------------------
 * The unit tests (test/sms_owner_otp_test.js) pin the server rules and the panel markup; this drives the panel in real Chromium:
 * a number typed into the box offers Send code (not Save), the code row appears, a wrong code is refused and nothing is saved, the right code
 * saves the number with the switch on, and a number that was never verified cannot be switched on. The /api/sms-notify calls are answered by this
 * script (a stand-in for the server); no real number, account or gateway is used.
 *
 * Run from the repository root:  node test/e2e/owner-otp.mjs
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const app = await bootApp();
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => !!(window.WFSms && window.DB), null, { timeout: 20000 });
const welcome = page.locator('#wfPostUpdate');
if (await welcome.isVisible()) { await welcome.getByRole('button', { name: 'Return to Dashboard' }).click(); await welcome.waitFor({ state: 'hidden' }); }

// the server stand-in: remembers the code it "texted", and answers like sms-notify.js does
const server = { code: '', phone: '', sends: 0, verifies: 0 };
await page.route('**/api/sms-notify', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const reply = (status, json) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (body.action === 'owner-otp-send') {
        server.sends += 1; server.code = '482913'; server.phone = body.phone;
        return reply(200, { ok: true, sentTo: '+94*****7998', expiresAt: Date.now() + 600000, resendAfterMs: 45000 });
    }
    if (body.action === 'owner-otp-verify') {
        server.verifies += 1;
        return body.code === server.code ? reply(200, { ok: true, phone: '+94778787998' }) : reply(400, { ok: false, error: 'wrong-code', reason: 'wrong-code', message: 'That code is not right.', triesLeft: 4 });
    }
    return reply(200, { ok: true, summary: {} });
});

await page.evaluate(() => {
    window.currentUser.getIdToken = async () => 'test-token';          // the harness's identity has no token function
    const host = document.createElement('div'); host.id = 'otpHost'; host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;overflow:auto;padding:16px;';
    document.body.appendChild(host);
    DB.set('settings', { ...DB.getObj('settings', {}), owner_sms: { enabled: false, phone: '', at: 1 } });
    window.WFSms.panelInto(host);
});
const own = () => page.evaluate(() => (DB.getObj('settings', {}).owner_sms) || {});
const msg = () => page.textContent('#_wf_own_msg');

await page.waitForSelector('#_wf_own_phone');
assert.equal(await page.getAttribute('#_wf_own_save', 'data-mode'), 'save', 'with no number typed the button saves');
assert.match(await page.textContent('#otpHost'), /new number is added only after you enter the verification code/);

// 1. a number is typed: the button becomes Send code, nothing is saved
await page.check('#_wf_own_on');
await page.fill('#_wf_own_phone', '077 878 7998');
assert.equal(await page.getAttribute('#_wf_own_save', 'data-mode'), 'send');
assert.equal((await page.textContent('#_wf_own_save')).trim(), 'Send code');
console.log('1. typing a number    -> the button reads', JSON.stringify((await page.textContent('#_wf_own_save')).trim()));

// 2. Send code on the unverified number does not save it, and shows the code row
await page.click('#_wf_own_save');
await page.waitForSelector('#_wf_own_code', { timeout: 8000 }).catch(async (e) => { console.log('DEBUG msg:', await msg(), 'sends', server.sends, 'errors', errors); throw e; });
assert.equal(server.sends, 1);
assert.deepEqual({ enabled: (await own()).enabled, phone: (await own()).phone }, { enabled: false, phone: '' }, 'nothing is saved before the code is entered');
assert.match(await msg(), /A code was sent to \+94\*+7998/);
assert.equal(await page.inputValue('#_wf_own_phone'), '077 878 7998', 'what was typed survives the redraw');
assert.equal(await page.isChecked('#_wf_own_on'), true);
assert.equal(await page.isDisabled('#_wf_own_resend'), true, 'Resend waits out the gap');
assert.match(await page.textContent('#_wf_own_resend'), /Resend code \(\d+ s\)/);
console.log('2. Send code          ->', JSON.stringify(await msg()));

// 3. a wrong code is refused, and still nothing is saved
await page.fill('#_wf_own_code', '000000');
await page.click('#_wf_own_verify');
await page.waitForFunction(() => /not right/.test(document.getElementById('_wf_own_msg').textContent));
assert.equal(server.verifies, 1);
assert.equal((await own()).phone, '', 'a wrong code saves nothing');
assert.equal((await own()).enabled, false);
console.log('3. wrong code         ->', JSON.stringify(await msg()));

// 4. a code that is not six digits is refused on the page, without asking the server
await page.fill('#_wf_own_code', '123');
await page.click('#_wf_own_verify');
assert.match(await msg(), /six digits/);
assert.equal(server.verifies, 1);

// 5. the right code saves the number with the switch on
await page.fill('#_wf_own_code', '482 913');
await page.click('#_wf_own_verify');
await page.waitForFunction(() => /Number verified/.test(document.getElementById('_wf_own_msg').textContent), null, { timeout: 8000 }).catch(async (e) => { console.log('DEBUG msg:', await msg(), 'verifies', server.verifies, errors); throw e; });
const saved = await own();
assert.equal(saved.enabled, true);
assert.equal(saved.phone, '077 878 7998', 'the number (as typed) is saved only now');
assert.equal(await page.getAttribute('#_wf_own_save', 'data-mode'), 'save');
assert.match(await page.textContent('#_wf_own_state'), /Verified: \+94 77 878 7998/);
assert.equal(await page.locator('#_wf_own_code').count(), 0, 'the code row is gone');
console.log('5. right code         ->', JSON.stringify(saved), '|', (await page.textContent('#_wf_own_state')).trim());

// 6. another number is again offered a code, the saved verified number keeps working meanwhile
await page.fill('#_wf_own_phone', '071 222 3344');
assert.equal(await page.getAttribute('#_wf_own_save', 'data-mode'), 'send');
await page.click('#_wf_own_save');
await page.waitForSelector('#_wf_own_code');
assert.equal((await own()).phone, saved.phone, 'the verified number stays saved while the new one waits for its code');
assert.equal((await own()).enabled, true);
console.log('6. a new number       -> asks for its own code, the saved one is untouched');

// 7. switching the alerts off needs no code, and keeps the verified number
await page.fill('#_wf_own_phone', '0778787998');
await page.uncheck('#_wf_own_on');
await page.click('#_wf_own_save');
await page.waitForFunction(() => /Saved/.test(document.getElementById('_wf_own_msg').textContent));
assert.equal((await own()).enabled, false);
assert.equal((await own()).phone.replace(/\D/g, ''), '0778787998', 'the verified number stays saved');

assert.deepEqual(errors, [], 'no page errors');
console.log('\nPASS: the panel adds a number only after its code is entered');
await app.close();
