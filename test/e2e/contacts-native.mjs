/* =============================================================================
 * test/e2e/contacts-native.mjs — the Contacts buttons inside the WealthFlow app shell (native/, Capacitor)
 * -----------------------------------------------------------------------------
 * Inside the app, the page finds `window.Capacitor` and the plugin `WealthFlowContactPicker`; its pick() opens the operating system's contact chooser.
 * Here the real page runs in Chromium with a STAND-IN for that bridge, so every answer the plugin can give is exercised: a number, several, a cancel,
 * a contact with no number, a refusal, a failure, a malformed answer, a hanging chooser. This proves the page's side of the contract. It does NOT prove
 * the native code: the Android and iOS plugin sources are not run here (see docs/device-contacts.md).
 *
 * Run from the repository root:  node test/e2e/contacts-native.mjs
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const app = await bootApp();
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let fileDialogs = 0;
page.on('filechooser', () => { fileDialogs += 1; });
await page.waitForFunction(() => !!(window.WFPeople && window.DB && window.openDebtorModal), null, { timeout: 20000 });
const welcome = page.locator('#wfPostUpdate');
if (await welcome.isVisible()) { await welcome.getByRole('button', { name: 'Return to Dashboard' }).click(); await welcome.waitFor({ state: 'hidden' }); }

await page.evaluate(() => { window.__toasts = []; const o = window.notify; window.notify = (m, ty) => { window.__toasts.push(String(m)); try { o(m, ty); } catch (_) { /* ignore */ } }; });
const gone = () => page.waitForFunction(() => !document.querySelector('body > .mo:not([id])'), null, { timeout: 5000 });
const reset = () => page.evaluate(() => { for (const k of ['debtors', 'income', 'people']) DB.set(k, []); document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()); });
const open = async () => { await gone(); await page.evaluate(() => window.openDebtorModal(null)); await page.waitForSelector('#_db_phone2'); };
/** The app shell's bridge, answering with `behaviour` on the next tap: {answer}, {reject:{code,message}} or {hang:true}. */
const shell = (behaviour) => page.evaluate((b) => {
    window.__native = { calls: 0, behaviour: b, resolve: null };
    window.Capacitor = {
        isNativePlatform: () => true,
        isPluginAvailable: (n) => n === 'WealthFlowContactPicker',
        Plugins: {
            WealthFlowContactPicker: {
                pick: () => {
                    window.__native.calls += 1;
                    const x = window.__native.behaviour;
                    if (x.hang) return new Promise((res) => { window.__native.resolve = res; });
                    if (x.reject) return Promise.reject(Object.assign(new Error(x.reject.message || 'x'), { code: x.reject.code }));
                    return Promise.resolve(x.answer);
                },
            },
        },
    };
}, behaviour);
const set = (behaviour) => page.evaluate((b) => { window.__native.behaviour = b; }, behaviour);
const value = (id) => page.inputValue(id);
const digits = (id) => page.inputValue(id).then((v) => v.replace(/\D/g, ''));

/* A. the first button: straight to the system chooser, the number lands in the first field only */
await reset(); await shell({ answer: { cancelled: false, name: 'Kamal Silva', number: '077 555 1212' } }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone').value === '+94 77 555 1212');
assert.equal(await value('#_db_phone2'), '', 'the second field is untouched');
assert.equal(await value('#_db_name'), 'Kamal Silva');
assert.equal(await page.locator('.wfp-src').count(), 0, 'no sheet: the system chooser is the interface');
console.log('A. app, Mobile number         -> system chooser, the number, no sheet');

/* B. the second button fills the second field and leaves the first alone */
await page.fill('#_db_phone', '0771234567');
await set({ answer: { cancelled: false, name: 'Nimali', number: '071 222 3344' } });
await page.click('button[data-wfp="contacts2"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone2').value.replace(/\D/g, '').endsWith('712223344'));
assert.equal(await digits('#_db_phone'), '0771234567', 'the first field keeps its number');
console.log('B. app, Second mobile number  -> its own field only');

/* C. several numbers: the page asks which */
await reset(); await shell({ answer: { cancelled: false, name: 'Ahmed', numbers: ['0771112222', '+94 71 234 5678', '0112345678'] } }); await open();
await page.click('button[data-wfp="contacts2"][data-p="_db"]');
await page.waitForSelector('.wfp-chooser [data-c="num"]');
assert.deepEqual(await page.$$eval('.wfp-chooser [data-c="num"]', (b) => b.map((x) => x.textContent)), ['+94 77 111 2222', '+94 71 234 5678']);
await page.click('.wfp-chooser [data-c="num"][data-i="0"]');
await page.waitForFunction(() => document.getElementById('_db_phone2').value.replace(/\D/g, '') === '94771112222');
assert.equal(await value('#_db_phone'), '');
console.log('C. app, several numbers       -> asked which, only that one imported');

/* D. cancelled: exactly as it was */
await reset(); await shell({ answer: { cancelled: true } }); await open();
await page.fill('#_db_phone', '0771234567');
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__native.calls === 1);
await page.waitForTimeout(300);
assert.equal(await digits('#_db_phone'), '0771234567');
assert.equal(await page.locator('.wfp-src').count(), 0);
assert.equal(await page.evaluate(() => DB.get('debtors').length), 0);
console.log('D. app, cancelled             -> the form is exactly as it was');

/* E. no number */
await reset(); await shell({ answer: { cancelled: false, name: 'No Number' } }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__toasts.some((m) => /no phone number/i.test(m)));
assert.equal(await value('#_db_phone'), '');
console.log('E. app, no number             -> says why, nothing imported');

/* F. refused or failed: words, the paste route, never a file dialog; manual entry works */
for (const reject of [{ code: 'PERMISSION_DENIED' }, { code: 'UNAVAILABLE', message: 'java.lang.IllegalStateException' }]) {
    await reset(); await shell({ reject }); await open();
    await page.click('button[data-wfp="contacts"][data-p="_db"]');
    await page.waitForSelector('.wfp-src [data-c="paste"]');
    assert.equal(fileDialogs, 0, 'a refusal does not open a file dialog');
    assert.ok(!(await page.evaluate(() => window.__toasts)).some((m) => /IllegalState/.test(m)), 'no raw plugin text reaches the person');
    await page.fill('.wfp-src [data-c="paste"]', '077 999 8888');
    await page.click('.wfp-src [data-c="use"]');
    await page.waitForFunction(() => document.getElementById('_db_phone').value === '+94 77 999 8888');
}
console.log('F. app, refused / failed      -> paste route, no file dialog, manual entry works');

/* G. a malformed answer is never a number */
for (const answer of [null, 'tel:0771234567', { number: 5 }, { weird: true }]) {
    await reset(); await shell({ answer }); await open();
    await page.click('button[data-wfp="contacts"][data-p="_db"]');
    await page.waitForSelector('.wfp-src [data-c="paste"]');
    assert.equal(await value('#_db_phone'), '', 'nothing was written for ' + JSON.stringify(answer));
}
console.log('G. app, malformed answer      -> nothing written, paste route offered');

/* H. rapid taps open one chooser; backgrounding while it is open and coming back changes nothing; the answer then lands */
await reset(); await shell({ hang: true }); await open();
await page.fill('#_db_name', 'Typed Name');
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__native.calls === 1);
for (let i = 0; i < 4; i += 1) await page.click('button[data-wfp="contacts"][data-p="_db"]', { timeout: 2000 }).catch(() => {});
await page.click('button[data-wfp="contacts2"][data-p="_db"]', { timeout: 2000 }).catch(() => {});
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
assert.equal(await page.evaluate(() => window.__native.calls), 1, 'one chooser at a time');
assert.equal(await value('#_db_name'), 'Typed Name', 'what was typed is still there');
await page.evaluate(() => window.__native.resolve({ cancelled: false, name: 'Late Answer', number: '0765554433' }));
await page.waitForFunction(() => document.getElementById('_db_phone').value.replace(/\D/g, '') === '94765554433');
assert.equal(await value('#_db_name'), 'Typed Name', 'a name already typed is not replaced by the contact\'s');
assert.equal(await value('#_db_phone2'), '');
console.log('H. app, rapid taps + background -> one chooser, typed name kept, the answer lands once');

/* I. the form closes (or the account changes) while the chooser is open: the late answer is dropped */
await reset(); await shell({ hang: true }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__native.calls === 1);
await page.evaluate(() => { document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()); });
await page.evaluate(() => window.__native.resolve({ cancelled: false, name: 'Orphan', number: '0765554433' }));
await page.waitForTimeout(400);
assert.equal(await page.evaluate(() => DB.get('debtors').length + DB.get('people').length), 0, 'nothing was created');
assert.ok(!(await page.evaluate(() => window.__toasts)).some((m) => /Orphan/.test(m)), 'and nothing was announced');
console.log('I. app, form closed mid-pick  -> the late answer is dropped');

/* J. integration: both numbers persist through the form's own Save, and the account document is untouched until then */
await reset(); await shell({ answer: { cancelled: false, name: 'Saved Person', number: '0765554433' } }); await open();
await page.fill('#_db_amount', '5000');
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone').value.replace(/\D/g, '') === '94765554433');
await set({ answer: { cancelled: false, name: 'Second', number: '0712223344' } });
await page.click('button[data-wfp="contacts2"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone2').value.replace(/\D/g, '') === '94712223344');
assert.equal(await page.evaluate(() => DB.get('debtors').length), 0, 'picking does not save');
await page.click('#_db_save');
await page.waitForFunction(() => DB.get('debtors').length === 1);
const saved = await page.evaluate(() => DB.get('debtors')[0]);
assert.equal(saved.phone, '+94765554433'); assert.equal(saved.phone2, '+94712223344');
console.log('J. app, save                  -> both numbers persisted:', saved.phone, saved.phone2);

/* K. a foreign number is refused with a reason, the field unchanged */
await reset(); await shell({ answer: { cancelled: false, name: 'Abroad', number: '+44 7911 123456' } }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__toasts.some((m) => /None of that contact/.test(m)));
assert.equal(await value('#_db_phone'), '');
console.log('K. app, foreign number        -> refused with a reason');

assert.equal(fileDialogs, 0, 'no file dialog opened anywhere in this run');
assert.deepEqual(errors, [], 'no page errors');
console.log('\nPASS: inside the app shell the Contacts buttons use the system chooser through one service');
await app.close();
