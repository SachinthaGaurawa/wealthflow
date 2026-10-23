/* =============================================================================
 * test/e2e/contacts-device.mjs — the Contacts button beside "Mobile number" and "Second mobile number (optional)"
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-23: the button must open the device's own contact picker and put the chosen number into ITS field, never a file dialog.
 * Real Chromium; the browser's Contact Picker (navigator.contacts.select) is replaced by a stand-in so each outcome can be chosen:
 * one number, several numbers, cancel, no number, permission refused, picker already open. A real picker exists only in Chrome on Android and
 * cannot be driven here; a browser with no picker (Safari, every desktop browser) must never open a file dialog by itself.
 *
 * Run from the repository root:  node test/e2e/contacts-device.mjs
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
/** What the stand-in picker will do on the next tap: resolve with contacts, reject with an error name, or stay open. */
const picker = (behaviour) => page.evaluate((b) => {
    window.ContactsManager = window.ContactsManager || function ContactsManager() {};
    window.__pick = { calls: 0, behaviour: b, props: null };
    Object.defineProperty(navigator, 'contacts', {
        configurable: true,
        value: {
            select: (props) => {
                window.__pick.calls += 1; window.__pick.props = props;
                const x = window.__pick.behaviour;
                if (x.hang) return new Promise(() => {});
                if (x.error) return Promise.reject(Object.assign(new Error('x'), { name: x.error }));
                return Promise.resolve(x.contacts);
            },
        },
    });
}, behaviour);
const noPicker = () => page.evaluate(() => { Object.defineProperty(navigator, 'contacts', { configurable: true, value: undefined }); });
const value = (id) => page.inputValue(id);

/* A. the first button fills the first field only */
await reset(); await picker({ contacts: [{ name: ['Kamal Silva'], tel: ['077 555 1212'] }] }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone').value === '+94 77 555 1212');
assert.equal(await value('#_db_phone2'), '', 'the second field is untouched');
assert.deepEqual(await page.evaluate(() => window.__pick.props), ['name', 'tel'], 'only the name and the number are asked for');
assert.equal(fileDialogs, 0, 'no file dialog');
console.log('A. Mobile number         -> the picked number, the second field untouched');

/* B. the second button fills the second field only */
await page.fill('#_db_phone', '0771234567');
await page.evaluate(() => { window.__pick.behaviour = { contacts: [{ name: ['Nimali'], tel: ['071 222 3344'] }] }; });
await page.click('button[data-wfp="contacts2"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone2').value.replace(/\D/g, '').endsWith('712223344'));
assert.equal((await value('#_db_phone')).replace(/\D/g, ''), '0771234567', 'the first field keeps its number');
assert.equal(fileDialogs, 0);
console.log('B. Second mobile number  -> its own number, the first field untouched');

/* C. several numbers: choose one, only that one is imported */
await reset(); await picker({ contacts: [{ name: ['Ahmed'], tel: ['0771112222', '+94 71 234 5678', '0112345678'] }] }); await open();
await page.click('button[data-wfp="contacts2"][data-p="_db"]');
await page.waitForSelector('.wfp-chooser [data-c="num"]');
assert.deepEqual(await page.$$eval('.wfp-chooser [data-c="num"]', (b) => b.map((x) => x.textContent)), ['+94 77 111 2222', '+94 71 234 5678'], 'a landline cannot be texted, so it is not offered');
await page.click('.wfp-chooser [data-c="num"][data-i="1"]');
await page.waitForFunction(() => document.getElementById('_db_phone2').value.replace(/\D/g, '') === '94712345678');
assert.equal(await value('#_db_phone'), '', 'the first field is untouched');
console.log('C. several numbers       -> asked which, only that one imported');

/* D. cancelled: nothing changes, nothing is saved */
await reset(); await picker({ error: 'AbortError' }); await open();
await page.fill('#_db_phone', '0771234567');
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__pick.calls === 1);
await page.waitForTimeout(300);
assert.equal((await value('#_db_phone')).replace(/\D/g, ''), '0771234567');
assert.equal(await page.evaluate(() => DB.get('debtors').length), 0, 'nothing was saved');
assert.equal(await page.locator('.wfp-src').count(), 0, 'no extra sheet opens');
console.log('D. cancelled             -> the form is exactly as it was');

/* E. a contact without a number */
await reset(); await picker({ contacts: [{ name: ['No Number'], tel: [] }] }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__pick.calls === 1);
await page.waitForTimeout(300);
assert.equal(await value('#_db_phone'), '');
assert.ok((await page.evaluate(() => window.__toasts)).some((m) => /no phone number/i.test(m)), 'and says why');
console.log('E. no number             -> nothing imported, the form is usable');

/* F. permission refused: the form stays usable and the paste route opens, never a file dialog */
await reset(); await picker({ error: 'NotAllowedError' }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForSelector('.wfp-src [data-c="paste"]');
assert.equal(fileDialogs, 0, 'a refusal does not open a file dialog');
await page.fill('.wfp-src [data-c="paste"]', '077 999 8888');
await page.click('.wfp-src [data-c="use"]');
await page.waitForFunction(() => document.getElementById('_db_phone').value === '+94 77 999 8888');
console.log('F. permission refused    -> paste route, no file dialog, manual entry works');

/* G. no picker in this browser: the sheet says so, leads with paste, opens no file dialog */
await reset(); await noPicker(); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForSelector('.wfp-src [data-c="paste"]');
await page.waitForTimeout(300);
assert.equal(fileDialogs, 0, 'no file dialog opened');
assert.match(await page.textContent('.wfp-src [data-c="nopicker"]'), /cannot open the contacts on this device/);
assert.equal(await page.isVisible('.wfp-src [data-c="file"]'), false, 'the file choice is behind its own heading');
assert.equal(await page.isVisible('.wfp-src [data-c="device"]'), false);
await page.keyboard.press('Escape');
console.log('G. no picker             -> honest sheet, paste first, file dialog never opened');

/* H. integration: the imported number is what the form saves */
await reset(); await picker({ contacts: [{ name: ['Saved Person'], tel: ['0765554433'] }] }); await open();
await page.fill('#_db_amount', '5000');
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone').value.replace(/\D/g, '') === '94765554433');
assert.equal(await value('#_db_name'), 'Saved Person');
await page.evaluate(() => { window.__pick.behaviour = { contacts: [{ name: ['Second'], tel: ['0712223344'] }] }; });
await page.click('button[data-wfp="contacts2"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone2').value.replace(/\D/g, '') === '94712223344');
await page.click('#_db_save');
await page.waitForFunction(() => DB.get('debtors').length === 1);
const saved = await page.evaluate(() => DB.get('debtors')[0]);
assert.equal(saved.phone, '+94765554433'); assert.equal(saved.phone2, '+94712223344');
assert.equal(await page.evaluate(() => DB.get('people').length), 1);
console.log('H. save                  -> both numbers persisted:', saved.phone, saved.phone2);

/* I. a number that is not a Sri Lankan mobile is refused with a reason, and the field is not changed */
await reset(); await picker({ contacts: [{ name: ['Abroad'], tel: ['+44 7911 123456'] }] }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__pick.calls === 1);
await page.waitForTimeout(300);
assert.equal(await value('#_db_phone'), '');
assert.ok((await page.evaluate(() => window.__toasts)).some((m) => /None of that contact/.test(m) && /\+44/.test(m)), 'and says which number could not be used');
console.log('I. foreign number        -> not imported (the text service reaches Sri Lanka only)');

/* J. a second tap while the picker is open does not stack another */
await reset(); await picker({ hang: true }); await open();
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => window.__pick.calls === 1);
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.click('button[data-wfp="contacts2"][data-p="_db"]');
await page.waitForTimeout(300);
assert.equal(await page.evaluate(() => window.__pick.calls), 1, 'one picker at a time');
console.log('J. second tap            -> ignored while the picker is open');

assert.equal(fileDialogs, 0, 'no file dialog opened anywhere in this run');
assert.deepEqual(errors, [], 'no page errors');
console.log('\nPASS: the Contacts buttons open the device picker and fill their own field');
await app.close();
