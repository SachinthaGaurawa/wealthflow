/* =============================================================================
 * test/e2e/people-book.mjs — the saved-people book, the contact fields and the payment details, on the real page
 * -----------------------------------------------------------------------------
 * The unit tests pin the rules (test/people_test.js); this asks the page itself, in real Chromium:
 *   - a person added once is picked from the saved list on the next loan, and the form fills itself in;
 *   - a number or a name changed on a linked form asks ONE question (update everywhere / this loan only / cancel) and does what it says;
 *   - the phone's contacts fill the form: through the browser's contact picker where there is one, through a .vcf file where there is not;
 *   - the screens: add, edit (with the "this also updates N loans" step), delete (loans untouched), search, import, file the people the
 *     ledgers already name;
 *   - the owner's bank accounts: add, switch off, edit, delete, who sees each;
 *   - nothing overflows a 320 px phone.
 *
 * Run from the repository root:  node test/e2e/people-book.mjs
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const app = await bootApp();
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => !!(window.WFPeople && window.WFSms && window.WFLiquidity && window.DB), null, { timeout: 20000 });
console.log('page: WFPeople, WFSms, WFLiquidity and DB are loaded');

const welcome = page.locator('#wfPostUpdate');
if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Return to Dashboard' }).click();
    await welcome.waitFor({ state: 'hidden' });
}

const reset = () => page.evaluate(() => { for (const k of ['debtors', 'income', 'people', 'payAccounts']) DB.set(k, []); DB.set('settings', { ...DB.getObj('settings', {}), homeCountry: undefined }); document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()); });
const toasts = () => page.evaluate(() => window.__toasts || []);
/** A form that was just saved is still fading out for a moment; open the next one only when it has gone, as a person would. */
const gone = () => page.waitForFunction(() => !document.querySelector('body > .mo:not([id])'), null, { timeout: 5000 });
const openDebtor = async (rec) => { await gone(); await page.evaluate((r) => window.openDebtorModal(r), rec); };
await page.evaluate(() => { window.__toasts = []; const o = window.notify; window.notify = (m, t) => { window.__toasts.push([m, t]); try { o(m, t); } catch (_) { /* ignore */ } }; });

/* ── 1. a person saved once is picked on the next loan ────────────────────── */
await reset();
await openDebtor(null);
await page.waitForSelector('#_db_sms_on');
assert.equal(await page.isVisible('#_db_pick'), false, 'no saved people yet: nothing to pick, so no picker');
await page.fill('#_db_name', 'Nimal Perera');
await page.fill('#_db_amount', '100000');
await page.fill('#_db_phone', '077 123 4567');
await page.fill('#_db_nic', '853400937V');
await page.click('#_db_save');
await page.waitForFunction(() => DB.get('debtors').length === 1);
let book = await page.evaluate(() => ({ people: DB.get('people'), debtors: DB.get('debtors') }));
assert.equal(book.people.length, 1, 'the first loan files the person');
assert.deepEqual({ name: book.people[0].name, phone: book.people[0].phone, nic: book.people[0].nic, country: book.people[0].country }, { name: 'Nimal Perera', phone: '+94771234567', nic: '853400937V', country: 'LK' });
assert.equal(book.debtors[0].personId, book.people[0].id);
console.log('1a. first loan         -> person filed:', book.people[0].name, book.people[0].phone);

await openDebtor(null);
await page.waitForSelector('#_db_pick');
const options = await page.$$eval('#_db_pick option', (o) => o.map((x) => x.textContent));
assert.deepEqual(options, ['New person (type the details below)', 'Nimal Perera · +94 77 123 4567']);
await page.selectOption('#_db_pick', { index: 1 });
assert.equal(await page.inputValue('#_db_name'), 'Nimal Perera', 'the form fills the name');
assert.equal(await page.inputValue('#_db_phone'), '+94 77 123 4567');
assert.equal(await page.inputValue('#_db_nic'), '853400937V');
assert.equal(await page.inputValue('#_db_cc'), 'LK');
assert.equal(await page.isVisible('#_db_remember_row'), false, 'a picked person is already saved');
assert.match(await page.textContent('#_db_linked'), /Saved person: Nimal Perera/);
await page.fill('#_db_amount', '25000');
await page.click('#_db_save');
await page.waitForFunction(() => DB.get('debtors').length === 2);
book = await page.evaluate(() => ({ people: DB.get('people'), debtors: DB.get('debtors') }));
assert.equal(book.people.length, 1, 'picking does not create a second Nimal');
assert.equal(book.debtors[1].personId, book.people[0].id);
assert.equal(book.debtors[1].phone, '+94771234567');
console.log('1b. second loan        -> picked, no duplicate, linked');

// choosing "New person" after a pick clears what the pick filled in
await openDebtor(null);
await page.waitForSelector('#_db_pick');
await page.selectOption('#_db_pick', { index: 1 });
await page.selectOption('#_db_pick', { index: 0 });
assert.equal(await page.inputValue('#_db_name'), '');
assert.equal(await page.inputValue('#_db_phone'), '');
assert.equal(await page.isVisible('#_db_remember_row'), true);
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));

/* ── 2. a changed name or number asks one question ─────────────────────────── */
await openDebtor(await page.evaluate(() => DB.get('debtors')[1]));
await page.waitForSelector('#_db_phone');
await page.fill('#_db_phone', '077 999 8888');
await page.click('#_db_save');
await page.waitForSelector('.wfp-chooser [data-c="update"]');
const asked = await page.textContent('.wfp-chooser');
assert.match(asked, /Update Nimal Perera.s saved details/);
assert.match(asked, /also on 1 other loan/);
await page.click('.wfp-chooser [data-c="update"]');
await page.waitForFunction(() => DB.get('debtors')[1].phone === '+94779998888');
book = await page.evaluate(() => ({ people: DB.get('people'), debtors: DB.get('debtors') }));
assert.equal(book.people[0].phone, '+94779998888', 'the saved person has the new number');
assert.equal(book.debtors[0].phone, '+94779998888', 'and so does their OTHER loan: a text to the old number would reach somebody else');
console.log('2a. update everywhere  -> person and the other loan follow');

await openDebtor(await page.evaluate(() => DB.get('debtors')[1]));
await page.waitForSelector('#_db_phone');
await page.fill('#_db_phone', '071 111 2222');
await page.click('#_db_save');
await page.waitForSelector('.wfp-chooser [data-c="detach"]');
await page.click('.wfp-chooser [data-c="detach"]');
await page.waitForFunction(() => DB.get('debtors')[1].phone === '+94711112222');
book = await page.evaluate(() => ({ people: DB.get('people'), debtors: DB.get('debtors') }));
assert.equal(book.people[0].phone, '+94779998888', 'this loan only: the person is untouched');
assert.equal(book.debtors[0].phone, '+94779998888');
assert.equal(book.debtors[1].personId, undefined, 'and the loan is no longer linked');
console.log('2b. this loan only     -> detached, person untouched');

await openDebtor(await page.evaluate(() => DB.get('debtors')[0]));
await page.waitForSelector('#_db_phone');
await page.fill('#_db_phone', '071 333 4444');
await page.click('#_db_save');
await page.waitForSelector('.wfp-chooser [data-c="cancel"]');
await page.click('.wfp-chooser [data-c="cancel"]');
await page.waitForTimeout(400);
book = await page.evaluate(() => ({ people: DB.get('people'), debtors: DB.get('debtors') }));
assert.equal(book.debtors[0].phone, '+94779998888', 'cancel changes nothing');
assert.equal(await page.isVisible('#_db_save'), true, 'and the form is still open for the owner to carry on');
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));

/* ── 3. the phone's contacts, through the browser's picker ─────────────────── */
await reset();
await page.evaluate(() => {
    window.ContactsManager = window.ContactsManager || function ContactsManager() {};
    Object.defineProperty(navigator, 'contacts', { configurable: true, value: { select: async () => window.__contacts } });
    window.__contacts = [{ name: ['Kamal Silva'], tel: ['077 555 1212'] }];
});
await openDebtor(null);
await page.waitForSelector('#_db_phone');
await page.click('#_db_phone ~ button[data-wfp="contacts"], button[data-wfp="contacts"][data-p="_db"]');
await page.waitForFunction(() => document.getElementById('_db_phone').value === '+94 77 555 1212');
assert.equal(await page.inputValue('#_db_name'), 'Kamal Silva', 'an empty name box is filled from the contact');
assert.match(await page.textContent('#_db_pv'), /\+94 77 555 1212 \(Sri Lanka\)/);
console.log('3a. contact picker     -> one number fills the form');

await page.fill('#_db_name', 'Typed Name');
await page.evaluate(() => { window.__contacts = [{ name: ['Ahmed Khan'], tel: ['+971 50 123 4567', '+44 7911 123456', '0112345678'] }]; });
await page.click('button[data-wfp="contacts"][data-p="_db"]');
await page.waitForSelector('.wfp-chooser [data-c="num"]');
const numbers = await page.$$eval('.wfp-chooser [data-c="num"]', (b) => b.map((x) => x.textContent));
assert.deepEqual(numbers, ['+971 501 234 567', '+44 791 112 3456'], 'a contact with several numbers asks which; a number that cannot be texted is not offered');
await page.click('.wfp-chooser [data-c="num"][data-i="1"]');
await page.waitForFunction(() => document.getElementById('_db_cc').value === 'GB');
assert.equal(await page.inputValue('#_db_phone'), '+44 791 112 3456');
assert.equal(await page.inputValue('#_db_name'), 'Typed Name', 'a name the owner typed is not overwritten');
console.log('3b. several numbers    -> chooser, country follows the number');

/* ── 4. no contact picker (iPhone, desktop): a contacts file ───────────────── */
await page.evaluate(() => { Object.defineProperty(navigator, 'contacts', { configurable: true, value: undefined }); document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()); });
await openDebtor(null);
await page.waitForSelector('#_db_phone');
const vcf = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Dilan Fernando', 'TEL;TYPE=CELL:0712345678', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Sara Smith', 'TEL;TYPE=CELL:+1 (415) 555-2671', 'END:VCARD',
].join('\r\n');
const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('button[data-wfp="contacts"][data-p="_db"]'),
]);
await chooser.setFiles({ name: 'contacts.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcf) });
await page.waitForSelector('.wfp-chooser [data-c="q"]');
await page.fill('.wfp-chooser [data-c="q"]', 'sara');
await page.click('.wfp-chooser [data-c="num"]');
await page.waitForFunction(() => document.getElementById('_db_cc').value === 'US');
assert.equal(await page.inputValue('#_db_phone'), '+1 415 555 2671');
assert.equal(await page.inputValue('#_db_name'), 'Sara Smith');
console.log('4.  contacts file      -> parsed, searched, applied');
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));

/* ── 5. the screens ───────────────────────────────────────────────────────── */
await reset();
await page.evaluate(() => {
    DB.set('debtors', [
        { id: 'd1', name: 'Nimal Perera', phone: '077 123 4567', nic: '853400937V', events: [{ id: 'e1', kind: 'lent', amount: 1000, confirmed: true, date: '2026-10-01' }], createdAt: new Date().toISOString() },
        { id: 'd2', name: 'Nimal Perera', phone: '', nic: '198534000937', events: [], createdAt: new Date().toISOString() },
        { id: 'd3', name: 'Kamal', phone: '', nic: '', events: [], createdAt: new Date().toISOString() },
    ]);
    DB.set('income', [
        { id: 'i1', name: 'Fixed deposit', company: 'Commercial Bank', amount: 1000, rate: 10, start: '2026-01-01', freq: 'monthly', day: '2026-01-01', monthly: 8, createdAt: new Date().toISOString() },
        { id: 'i2', name: 'Loan from Ahmed', company: 'Ahmed Khan', phone: '+971501234567', nic: 'ID:X1234567', amount: 1000, rate: 10, start: '2026-01-01', freq: 'monthly', day: '2026-01-01', monthly: 8, createdAt: new Date().toISOString() },
    ]);
    WFPeople.openHub('people');
});
await page.waitForSelector('.wfp-hub #wfp_list');
assert.match(await page.textContent('.wfp-hub .wfp-note'), /4 loans and investments name somebody who is not in this list yet/, 'three loans and an investor with a number are named; a bank is not a person');
await page.click('.wfp-hub [data-h="harvest"]');
await page.waitForFunction(() => DB.get('people').length === 3);
book = await page.evaluate(() => ({ people: DB.get('people'), debtors: DB.get('debtors'), income: DB.get('income') }));
assert.deepEqual(book.people.map((p) => p.name).sort(), ['Ahmed Khan', 'Kamal', 'Nimal Perera'], 'two loans to Nimal (one NIC in two shapes) are one Nimal');
assert.equal(book.debtors[0].personId, book.debtors[1].personId);
assert.equal(book.income[0].personId, undefined, 'the bank is left alone');
assert.equal(book.debtors[0].phone, '077 123 4567', 'a ledger record keeps every other field exactly as it was');
assert.equal(await page.isVisible('.wfp-hub .wfp-note'), false, 'nothing left to file');
console.log('5a. file the ledgers   -> 3 people from 4 records, bank untouched');

// the list: who they are and what they are on
const rows = await page.$$eval('.wfp-hub .wfp-card .wfp-name', (e) => e.map((x) => x.textContent));
assert.deepEqual(rows, ['Ahmed Khan', 'Kamal', 'Nimal Perera'], 'A to Z');
assert.match(await page.textContent('.wfp-hub .wfp-card:has-text("Nimal")'), /2 loans/);
await page.fill('#wfp_q', '771234');
assert.deepEqual(await page.$$eval('.wfp-hub .wfp-card .wfp-name', (e) => e.map((x) => x.textContent)), ['Nimal Perera'], 'search by part of a number');
await page.fill('#wfp_q', 'zzz');
assert.match(await page.textContent('#wfp_list'), /Nobody matches/);
await page.fill('#wfp_q', '');

// edit: the "this also updates" step names what will change
await page.click('.wfp-hub .wfp-card:has-text("Nimal")');
await page.waitForSelector('#_pp_name');
await page.fill('#_pp_phone', '071 222 3333');
await page.fill('#_pp_email', 'nimal@example.com');
await page.click('.wfp-hub [data-h="save"]');
await page.waitForSelector('.wfp-hub [data-h="savego"]');
assert.match(await page.textContent('.wfp-hub .wfp-warn'), /This also updates 2 loans/);
await page.click('.wfp-hub [data-h="savego"]');
await page.waitForFunction(() => DB.get('debtors')[0].phone === '+94712223333');
book = await page.evaluate(() => ({ people: DB.get('people'), debtors: DB.get('debtors') }));
assert.equal(book.debtors[1].phone, '+94712223333');
assert.equal(book.people.find((p) => p.name === 'Nimal Perera').email, 'nimal@example.com');
console.log('5b. edit a person      -> confirmed, carried to both loans');

// a note-only edit touches no ledger and asks nothing
await page.click('.wfp-hub .wfp-card:has-text("Nimal")');
await page.waitForSelector('#_pp_note');
const debtorsBefore = await page.evaluate(() => JSON.stringify(DB.get('debtors')));
await page.fill('#_pp_note', 'repays on the 5th');
await page.click('.wfp-hub [data-h="save"]');
await page.waitForFunction(() => DB.get('people').find((p) => p.name === 'Nimal Perera').note === 'repays on the 5th');
assert.equal(await page.evaluate(() => JSON.stringify(DB.get('debtors'))), debtorsBefore, 'a note changes no loan');

// a refused edit says why under the field and keeps what was typed
await page.click('.wfp-hub .wfp-card:has-text("Kamal")');
await page.waitForSelector('#_pp_name');
await page.fill('#_pp_phone', '12');
await page.fill('#_pp_name', 'Kamal Silva');
await page.click('.wfp-hub [data-h="save"]');
await page.waitForSelector('#_pp_pv.bad');
assert.match(await page.textContent('#_pp_pv'), /wrong number of digits/);
assert.equal(await page.inputValue('#_pp_name'), 'Kamal Silva', 'what was typed is kept');
await page.fill('#_pp_phone', '');
await page.click('.wfp-hub [data-h="save"]');
await page.waitForSelector('.wfp-hub [data-h="savego"]');                  // a new name reaches Kamal's loan too, so the owner confirms
assert.match(await page.textContent('.wfp-hub .wfp-warn'), /This also updates 1 loan\./);
await page.click('.wfp-hub [data-h="savego"]');
await page.waitForFunction(() => DB.get('people').some((p) => p.name === 'Kamal Silva'));
assert.equal(await page.evaluate(() => DB.get('debtors').find((d) => d.id === 'd3').name), 'Kamal Silva');

// add a person from another country, with a passport
await page.click('.wfp-hub [data-h="add"]');
await page.waitForSelector('#_pp_name');
await page.fill('#_pp_name', 'Maria Garcia');
await page.selectOption('#_pp_cc', 'ES');
await page.fill('#_pp_phone', '612 345 678');
assert.match(await page.textContent('#_pp_pv'), /\+34 612 345 678 \(Spain\)/);
await page.fill('#_pp_nic', 'ab123456');
await page.click('.wfp-hub [data-h="save"]');
await page.waitForFunction(() => DB.get('people').some((p) => p.name === 'Maria Garcia'));
const maria = await page.evaluate(() => DB.get('people').find((p) => p.name === 'Maria Garcia'));
assert.deepEqual({ phone: maria.phone, country: maria.country, nic: maria.nic }, { phone: '+34612345678', country: 'ES', nic: 'ID:AB123456' });
console.log('5c. add from abroad    -> +34 number and passport kept');

// the same person again is refused, and says who
await page.click('.wfp-hub [data-h="add"]');
await page.waitForSelector('#_pp_name');
await page.fill('#_pp_name', 'maria  garcia');
await page.selectOption('#_pp_cc', 'ES');
await page.fill('#_pp_phone', '612345678');
await page.click('.wfp-hub [data-h="save"]');
await page.waitForSelector('.wfp-hub .wfp-pv.bad');
assert.match(await page.textContent('.wfp-hub .wfp-pv.bad'), /Maria Garcia is already in the list/);
await page.click('.wfp-hub [data-h="back"]');

// delete: the loans stay exactly as they are
await page.click('.wfp-hub .wfp-card:has-text("Nimal")');
await page.waitForSelector('[data-h="del"]');
await page.click('.wfp-hub [data-h="del"]');
assert.match(await page.textContent('.wfp-hub .wfp-warn'), /2 loans stay exactly as they are/);
const loansBefore = await page.evaluate(() => JSON.stringify(DB.get('debtors')));
await page.click('.wfp-hub [data-h="delgo"]');
await page.waitForFunction(() => !DB.get('people').some((p) => p.name === 'Nimal Perera'));
assert.equal(await page.evaluate(() => JSON.stringify(DB.get('debtors'))), loansBefore, 'deleting a person touches no loan');
console.log('5d. delete a person    -> loans unchanged');

// import from a contacts file (no contact picker in this browser)
const vcf2 = ['A:1'].join('');
const bulk = [
    ['Dilan Fernando', '0712345678'], ['Sara Smith', '+1 (415) 555-2671'], ['Landline Only', '011 234 5678'], ['Maria Garcia', '+34 612 345 678'],
].map(([n, t]) => `BEGIN:VCARD\r\nVERSION:3.0\r\nFN:${n}\r\nTEL:${t}\r\nEND:VCARD`).join('\r\n');
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.wfp-hub [data-h="import"]')]);
await fc.setFiles({ name: 'all.vcf', mimeType: 'text/vcard', buffer: Buffer.from(bulk) });
await page.waitForSelector('.wfp-hub [data-h="impgo"]');
assert.equal(await page.isDisabled('.wfp-hub [data-h="impgo"]'), true, 'nothing is added until the owner ticks it');
assert.equal(await page.isDisabled('.wfp-hub .wfp-imp:has-text("Landline Only") input'), true, 'a number that cannot be texted cannot be ticked');
await page.click('.wfp-hub [data-h="impall"]');
assert.match(await page.textContent('.wfp-hub [data-h="impgo"]'), /Add 3 people/);
await page.click('.wfp-hub [data-h="impgo"]');
await page.waitForFunction(() => DB.get('people').some((p) => p.name === 'Dilan Fernando'));
const after = await page.evaluate(() => DB.get('people').map((p) => p.name).sort());
assert.deepEqual(after, ['Ahmed Khan', 'Dilan Fernando', 'Kamal Silva', 'Maria Garcia', 'Sara Smith'], 'Maria was already in the list: she is counted, not doubled');
assert.ok((await toasts()).some(([m]) => /Added 2 people \(1 already in your list\)/.test(m)), 'and the owner is told');
console.log('5e. import             -> 2 added, 1 duplicate skipped, landline refused');
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));

/* ── 6. the owner's bank accounts ─────────────────────────────────────────── */
await page.evaluate(() => { DB.set('payAccounts', []); WFPeople.openHub('pay'); });
await page.waitForSelector('.wfp-hub [data-h="acc-add"]');
assert.match(await page.textContent('.wfp-hub'), /No account yet/);
await page.click('.wfp-hub [data-h="acc-add"]');
await page.waitForSelector('#_pa_bank');
await page.click('.wfp-hub [data-h="acc-save"]');
await page.waitForSelector('.wfp-hub .wfp-pv.bad');
assert.equal(await page.evaluate(() => DB.get('payAccounts').length), 0, 'an empty account is refused, under the fields');
await page.fill('#_pa_bank', 'Commercial Bank of Ceylon');
await page.fill('#_pa_holder', 'S. Gaurawa');
await page.fill('#_pa_number', '8001 234 567');
await page.fill('#_pa_branch', 'Colombo 03');
await page.fill('#_pa_swift', 'cceylklx');
await page.selectOption('#_pa_show', 'debtors');
await page.click('.wfp-hub [data-h="acc-save"]');
await page.waitForFunction(() => DB.get('payAccounts').length === 1);
let acc = await page.evaluate(() => DB.get('payAccounts')[0]);
assert.deepEqual({ bank: acc.bank, number: acc.number, swift: acc.swift, showTo: acc.showTo, active: acc.active }, { bank: 'Commercial Bank of Ceylon', number: '8001 234 567', swift: 'CCEYLKLX', showTo: 'debtors', active: true });
assert.match(await page.textContent('.wfp-hub'), /Debtors only/);
assert.match(await page.textContent('.wfp-hub'), /How it looks on a statement page/);

await page.click('.wfp-hub [data-h="acc-toggle"]');                    // switched off
await page.waitForFunction(() => DB.get('payAccounts')[0].active === false);
assert.doesNotMatch(await page.textContent('.wfp-hub'), /How it looks on a statement page/, 'a switched-off account is not previewed: it is not shown');
await page.click('.wfp-hub [data-h="acc-toggle"]');
await page.waitForFunction(() => DB.get('payAccounts')[0].active === true);

await page.click('.wfp-hub [data-h="acc-edit"]');
await page.waitForSelector('#_pa_note');
await page.fill('#_pa_note', 'Write your NIC in the reference');
await page.selectOption('#_pa_show', 'both');
await page.click('.wfp-hub [data-h="acc-save"]');
await page.waitForFunction(() => DB.get('payAccounts')[0].note === 'Write your NIC in the reference');
assert.equal(await page.evaluate(() => DB.get('payAccounts').length), 1, 'an edit does not add a second account');

await page.click('.wfp-hub [data-h="acc-edit"]');
await page.waitForSelector('[data-h="acc-del"]');
await page.click('.wfp-hub [data-h="acc-del"]');
await page.click('.wfp-hub [data-h="acc-delgo"]');
await page.waitForFunction(() => DB.get('payAccounts').length === 0);
console.log('6.  payment details    -> add, validate, switch off, edit, delete');
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));

/* ── 7. a number typed without a country code is read in the owner's own country ── */
await reset();
await page.evaluate(() => WFPeople.openHub('people'));
await page.waitForSelector('#wfp_home');
assert.equal(await page.inputValue('#wfp_home'), 'LK');
await page.selectOption('#wfp_home', 'AE');
await page.waitForFunction(() => DB.getObj('settings', {}).homeCountry === 'AE');
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));
await openDebtor(null);
await page.waitForSelector('#_db_cc');
assert.equal(await page.inputValue('#_db_cc'), 'AE', 'new forms open on the owner\'s country');
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));
await page.evaluate(() => DB.set('settings', { ...DB.getObj('settings', {}), homeCountry: 'LK' }));
// one number for somebody abroad never turns later local numbers into foreign ones
await openDebtor(null);
await page.waitForSelector('#_db_cc');
await page.selectOption('#_db_cc', 'GB');
await page.fill('#_db_name', 'Abroad');
await page.fill('#_db_amount', '10');
await page.fill('#_db_phone', '07911 123456');
await page.click('#_db_save');
await page.waitForFunction(() => DB.get('debtors').length === 1);
await openDebtor(null);
await page.waitForSelector('#_db_cc');
assert.equal(await page.inputValue('#_db_cc'), 'LK', 'the last form\'s country is not remembered');
console.log('7.  home country       -> explicit, never "the last one used"');
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));

/* ── 8. nothing overflows a 320 px phone ──────────────────────────────────── */
await page.setViewportSize({ width: 320, height: 640 });
await page.evaluate(() => { DB.set('people', [{ id: 'p1', name: 'A Very Long Name That Might Break A Narrow Layout Perera', phone: '+94771234567', country: 'LK', nic: '853400937V' }]); WFPeople.openHub('people'); });
await page.waitForSelector('.wfp-hub .wfp-card');
const overflow = async (label) => {
    const o = await page.evaluate(() => {
        const bad = [];
        const hub = document.querySelector('.mo.open .md') || document.body;
        const box = hub.getBoundingClientRect();
        hub.querySelectorAll('*').forEach((el) => { const r = el.getBoundingClientRect(); if (r.width && r.right > box.right + 1 && getComputedStyle(el).position !== 'fixed') bad.push((el.id || el.className || el.tagName) + ':' + Math.round(r.right - box.right)); });
        return { page: document.documentElement.scrollWidth - window.innerWidth, bad: bad.slice(0, 5) };
    });
    assert.ok(o.page <= 1, `${label}: the page scrolls sideways by ${o.page}px`);
    assert.deepEqual(o.bad, [], `${label}: elements stick out of the dialog`);
};
await overflow('people list');
await page.click('.wfp-hub [data-h="add"]');
await page.waitForSelector('#_pp_name');
await overflow('person form');
await page.click('.wfp-hub [data-h="back"]');
await page.click('.wfp-hub [data-v="pay"]');
await page.click('.wfp-hub [data-h="acc-add"]');
await page.waitForSelector('#_pa_bank');
await overflow('account form');
await page.evaluate(() => document.querySelectorAll('body > .mo:not([id])').forEach((m) => m.remove()));
await openDebtor(null);
await page.waitForSelector('#_db_phone');
await overflow('debtor form');
console.log('8.  320 px             -> no sideways scroll in the list, the forms or the account editor');

assert.deepEqual(errors, [], 'no uncaught page errors: ' + errors.join(' | '));
console.log('the saved-people book behaves on the real page');
await app.close();
