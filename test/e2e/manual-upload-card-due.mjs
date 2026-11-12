/* =============================================================================
 * test/e2e/manual-upload-card-due.mjs — a card statement uploaded by hand keeps the minimum payment it asks for (2026-11-11)
 * -----------------------------------------------------------------------------
 * The e-mail worker files one `cardDues` record per statement. The page's own upload filed the charges and payments but never that ask, so CC One-Time said nothing about the minimum until the
 * same statement came by e-mail. This boots the app in Chromium, uploads an invented card statement through the CC One-Time button as the owner does, saves it, and checks:
 *
 *   1. Save leaves ONE cardDues record: the minimum, the due date, the card, the bank
 *   2. the CC One-Time page shows "Minimum payment due" for it, and the minimum is not a charge or a payment
 *   3. read again, the same ask changes nothing, a better reading replaces it, and one the owner marked paid stays paid
 *
 * Run from the repository root:  node test/e2e/manual-upload-card-due.mjs
 * No real account, mailbox or bank data is used.
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';
import { createFirestore } from '../helpers/fake-firestore.js';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from '../fake-admin.mjs';
import { _setAdminModule } from '../../admin-db.mjs';
import { TEST_USER } from './firebase-stub.mjs';
import guard from '../../statement-guard.js';

const rows = [['05/08/2026', 'SUPERMARKET BAMBALAPITIYA', 8350.5, 'DR'], ['06/08/2026', 'FUEL STATION KOLLUPITIYA', 4200, 'DR'], ['07/08/2026', 'ONLINE SHOP COLOMBO', 1900, 'DR']];
const dmy = d => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`, iso = d => d.toISOString().slice(0, 10);
const dueOn = new Date(Date.now() + 12 * 86400000), stmtOn = new Date(Date.now() - 13 * 86400000);      // a due date still ahead: the page hides an ask long overdue
const statement = note => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: ${dmy(stmtOn)} Payment Due Date: ${dmy(dueOn)}</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${(note === 'first' ? rows : [...rows, ['08/08/2026', 'BOOKSHOP ' + note.toUpperCase(), 777, 'DR']]).map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table><!-- ${note} --></body></html>`;

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
const fake = makeFakeAdmin();
fake.setVerifier(async () => ({ uid: TEST_USER.uid, email: TEST_USER.email, email_verified: true }));
const store = createFirestore({ [`users/${TEST_USER.uid}`]: { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] } });
fake.admin.firestore = () => store.db; _setAdminModule(fake.admin);

const app = await bootApp();
const { page } = app;
await page.route('**/api/statement-guard', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    let out;
    const res = { statusCode: 200, setHeader() {}, end(text) { out = { status: this.statusCode, text }; } };
    await guard({ method: 'POST', body, headers: { authorization: 'Bearer e2e' } }, res);
    await route.fulfill({ status: out.status, contentType: 'application/json', body: out.text });
});
await page.route('**/api/ai**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
await page.evaluate(() => {
    const user = window.firebase.auth().currentUser; user.getIdToken = async () => 'e2e';
    window.__notes = []; const say = window.notify; window.notify = (m, t) => { window.__notes.push([String(m), t]); try { return say(m, t); } catch (_) { return undefined; } };
});
await page.waitForFunction(() => !!(window.WFStatementCloud && window.WFStatementCloud.guard), null, { timeout: 15000 });

const notes = () => page.evaluate(() => window.__notes.splice(0));
async function upload(name, body) {
    await page.setInputFiles('#ccot_ai_scan', { name, mimeType: 'text/html', buffer: Buffer.from(body) });
    await page.waitForFunction(() => document.querySelector('#_ccr_body') || document.querySelector('#mdConfirm.open'), null, { timeout: 30000 });
    assert.ok(await page.$('#_ccr_body'), 'the review opened');
}
const save = async () => { await page.evaluate(() => document.getElementById('_ccr_save').click()); await page.waitForFunction(() => (window.__notes || []).some(n => /Filed|Nothing added|added|Added/.test(n[0])) && !document.querySelector('#_ccr_body'), null, { timeout: 30000 }).catch(() => {}); return notes(); };
const dues = () => page.evaluate(() => (window.DB.get('cardDues') || []).map(r => ({ id: r.id, bank: r.bank, last4: r.card_last4, minimum: r.minimum, dueDate: r.dueDate, paid: !!r.paidManually })));

await upload('NTB Statement Aug 26.html', statement('first'));
await save();
const d1 = await dues();
console.log('1. after Save ->', JSON.stringify(d1));
assert.equal(d1.length, 1, 'one ask');
assert.equal(d1[0].minimum, 10000, 'the minimum the statement prints');
assert.equal(d1[0].dueDate, iso(dueOn), 'the date the statement prints');
assert.ok(d1[0].bank, 'the bank is named');
assert.equal(d1[0].last4, '0276', 'the card is the one whose masked number the statement prints');
const charges = await page.evaluate(() => (window.DB.get('cconetime') || []).map(r => r.amount).sort((a, b) => a - b));
assert.deepEqual(charges, [1900, 4200, 8350.5], 'the minimum is not a charge, and nothing was filed as a payment for it');
assert.equal(await page.evaluate(() => (window.DB.get('ccPayments') || []).length), 0, 'no payment was made up');

await page.evaluate(() => { try { renderCCOT(); } catch (_) {} });
const shown = await page.evaluate(() => /Minimum payment due/.test(document.body.innerText) || !!document.querySelector('.wf-due-card'));
console.log('2. CC One-Time shows the ask ->', shown);
assert.ok(shown, 'the CC One-Time page shows the minimum payment section');

/* The page's guard turns the same statement away on a second upload ("already added"), so the re-read rules are played on the saved record with the page's own functions. */
const again = await page.evaluate(() => {
    const CT = window.WFCardTabs, have = window.DB.get('cardDues') || [], r0 = have[0];
    const rec = CT.dueFromStatement({ due: { date: r0.dueDate, minimum: r0.minimum, closing: r0.closing }, isCard: true, bank: r0.bank, last4: r0.card_last4 });
    const same = CT.withDue(have, rec);
    const better = CT.withDue(have, { ...rec, minimum: r0.minimum + 100 });
    const paidList = [{ ...r0, paidManually: true }];
    return { sameId: rec.id === r0.id, same, betterLen: better && better.length, betterMin: better && better[0].minimum, reopened: CT.withDue(paidList, { ...rec, minimum: 1 }) };
});
console.log('3. re-read rules ->', JSON.stringify(again));
assert.equal(again.sameId, true, 'the same statement names the same ask');
assert.equal(again.same, null, 'the same ask read again changes nothing');
assert.equal(again.betterLen, 1, 'a better reading replaces the ask, never doubles it');
assert.equal(again.betterMin, 10100);
assert.equal(again.reopened, null, 'an ask the owner marked paid is never reopened by a re-read');

/* Undo of the import takes the ask off again: it is on the batch, not a row. */
const undone = await page.evaluate(() => {
    const b = (window.WFBatch.list() || []).slice(-1)[0];
    const had = (window.DB.get('cardDues') || []).length;
    const out = window.WFBatch.undo(b.id);
    return { had, after: (window.DB.get('cardDues') || []).length, removed: out && out.removed && out.removed.cardDues };
});
console.log('4. Undo ->', JSON.stringify(undone));
assert.deepEqual(undone, { had: 1, after: 0, removed: 1 }, 'Undo takes the minimum-payment ask off again');

console.log('page errors:', app.pageErrors.filter(e => !/Chart|cdn|fetch/i.test(e)).slice(0, 3));
await app.close();
_setAdminModule(null);
console.log('OK: a card statement uploaded by hand keeps its minimum-payment ask once, as its own record, never as a charge or payment');
