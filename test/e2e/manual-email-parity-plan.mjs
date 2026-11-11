/* =============================================================================
 * test/e2e/manual-email-parity-plan.mjs — a card statement with INSTALMENT PLANS, filed by the email worker and by the owner's own upload, lands in the same books (2026-11-11)
 * -----------------------------------------------------------------------------
 * The e-mail worker files an instalment line as a PLAN on CC Installments (named by the statement's own plan table, with its real total and what is still owed), and the purchase that was turned into
 * the plan (a credit and a debit of the same amount) as neither spending nor a payment. The page's upload filed every one of those lines as a one-time purchase or a card payment.
 * This feeds ONE invented statement to both doors — the REAL worker over an in-memory Firestore and the REAL page (Chromium, the CC One-Time upload button, Save) — and compares what each filed:
 *   1. the plans: product, monthly, length, total, which month, what is owed, the plan reference
 *   2. the one-time charges and card payments: the conversion legs are in neither, the plan lines are not in CC One-Time
 *   3. a second upload of the next month's statement continues the SAME plan (one plan, two paid months), and Undo takes that month off again
 *
 * Run from the repository root:  node test/e2e/manual-email-parity-plan.mjs
 * No real account, mailbox or bank data is used (invented figures; the layout is the bank's).
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { bootApp } from './harness.mjs';
import { TEST_USER } from './firebase-stub.mjs';
import { createFirestore } from '../helpers/fake-firestore.js';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from '../fake-admin.mjs';
import { _setAdminModule } from '../../admin-db.mjs';
import { userKeyFor } from '../../gmail-link.mjs';
import guard from '../../statement-guard.js';
import { runStatementSync } from '../../statement-sync.js';
import { readStatement } from '../../statement-reader.mjs';
import { settleStatement } from '../../statement-ledger.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const UID = TEST_USER.uid, MAIL = `wf-mail/${userKeyFor(TEST_USER.email)}`;
const LISTS = ['cconetime', 'ccPayments', 'ccinstall', 'expenses', 'incomeRecv'];

/* an invented NTB American Express statement: a plain purchase, a purchase turned into a 12-month plan (credit + debit + first instalment), another plan's 3rd instalment, and a payment */
const ROWS = [
    ['05/08/2026', 'SUPERMARKET BAMBALAPITIYA', 8350.5, 'DR'],
    ['06/08/2026', 'SINGER 12M NATIONS PAY', 120000, 'CR'],
    ['06/08/2026', 'SINGER 12M NATIONS PAY', 120000, 'DR'],
    ['06/08/2026', 'SINGER 12M NATIONS PAY INST 1 - REM BAL - 110000.00 - <1/12>', 10000, 'DR'],
    ['10/08/2026', 'INSTALLMENT 03/12 ABANS PLC', 8333.33, 'DR'],
    ['12/08/2026', 'PAYMENT RECEIVED THANK YOU', 15000, 'CR'],
];
const statement = (rows, note = '') => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 03/09/2026 Payment Due Date: 25/09/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${rows.map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table><h3>Your Installment Summary</h3><table><tr><th>Merchant</th><th>Original</th><th>Outstanding</th><th>Remaining</th><th>Instalment</th></tr><tr><td>SINGER 12M NATIONS PAY</td><td>120,000.00</td><td>110,000.00</td><td>11/12</td><td>10,000.00</td></tr></table><!-- ${note} --></body></html>`;

/* ── the server side: the real worker files the statement the email system received ── */
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
const fake = makeFakeAdmin();
fake.setVerifier(async () => ({ uid: UID, email: TEST_USER.email, email_verified: true }));
const blank = () => ({ expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ccinstall: [], subscriptions: [] });
const store = createFirestore({
    [MAIL]: { uid: UID, email: TEST_USER.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] },
    [`${MAIL}/items/s0`]: { uid: UID, bank: 'NTB', from: 'statements@nationstrust.com', filename: 'NTB Statement Aug 26.pdf', messageId: 'm0', receivedMs: 1000, status: 'pending', cursor: 0, filed: false },
    [`users/${UID}`]: blank(),
});
fake.admin.firestore = () => store.db; _setAdminModule(fake.admin);
const file = statement(ROWS, 'email copy');
for (let i = 0; i < 8; i++) {
    const r = await runStatementSync({ action: 'drain', db: store.db, owner: { uid: UID, email: TEST_USER.email }, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 't' }) }),
        read: readStatement, open: async () => [], settle: settleStatement, board: async () => null, loadAttachment: async () => ({ bytes: Buffer.from(file), filename: 'NTB Statement Aug 26.pdf', contentSha256: sha(file) }), budgetMs: 20000 });
    if (!r || !r.filed) break;
}
const worker = store.data.get(`users/${UID}`);
const shape = r => ({ product: String(r.product || '').toUpperCase(), monthly: r.monthly, duration: r.duration, total: r.total, totalEstimated: !!r.totalEstimated, installmentNo: r.installmentNo || 0, installmentOf: r.installmentOf || 0,
    outstanding: r.outstanding == null ? null : r.outstanding, rate: r.rate, planRef: r.planRef || '', paidMonths: (r.payments || []).filter(p => p && p.paid).map(p => p.month) });
const bySort = (a, b) => a.product.localeCompare(b.product);
const workerPlans = (worker.ccinstall || []).map(shape).sort(bySort);
const listOf = (data, name) => (data[name] || []).map(r => `${String(r.desc || r.name || '').toUpperCase()}|${Number(r.amount).toFixed(2)}`).sort();
console.log('server plans:', JSON.stringify(workerPlans));
console.log('server one-time:', JSON.stringify(listOf(worker, 'cconetime')), ' payments:', JSON.stringify(listOf(worker, 'ccPayments')));

/* ── the browser: the owner uploads the very same statement by hand ── */
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
const fresh = createFirestore({ [`users/${UID}`]: blank() });
fake.admin.firestore = () => fresh.db;
const notes = () => page.evaluate(() => window.__notes.splice(0));
async function upload(name, body) {
    await page.setInputFiles('#ccot_ai_scan', { name, mimeType: 'text/html', buffer: Buffer.from(body) });
    await page.waitForFunction(() => document.querySelector('#_ccr_body') || document.querySelector('#mdConfirm.open'), null, { timeout: 30000 });
    assert.ok(await page.$('#_ccr_body'), 'the review opened');
}
const save = async () => { await page.evaluate(() => document.getElementById('_ccr_save').click()); await page.waitForFunction(() => (window.__notes || []).some(n => /Filed|Nothing added|added|Added/.test(n[0])) && !document.querySelector('#_ccr_body'), null, { timeout: 30000 }).catch(() => {}); return notes(); };
const dump = () => page.evaluate(() => { const g = k => (window.DB.get(k) || []); return { cconetime: g('cconetime'), ccPayments: g('ccPayments'), ccinstall: g('ccinstall'), expenses: g('expenses'), incomeRecv: g('incomeRecv') }; });

await upload('NTB Statement Aug 26 (hand).html', statement(ROWS, 'hand copy'));
console.log('review rows:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#_ccr_body tr')].map(tr => [tr.querySelector('._ccr_desc')?.value, tr.querySelector('._ccr_dest')?.value]))));
const filed = await save();
console.log('page notes:', JSON.stringify(filed.map(n => n[0])));
const hand = await dump();
const pagePlans = hand.ccinstall.map(shape).sort(bySort);
console.log('page plans:', JSON.stringify(pagePlans));
console.log('page one-time:', JSON.stringify(listOf(hand, 'cconetime')), ' payments:', JSON.stringify(listOf(hand, 'ccPayments')));

/* 1. the plans are the same plans */
assert.equal(workerPlans.length, 2, 'the worker files the two plans');
assert.deepEqual(pagePlans, workerPlans, 'the manual upload files the same plans as the email worker: product, monthly, length, total, month, what is owed, plan reference');
const singer = pagePlans.find(p => /SINGER/.test(p.product));
assert.equal(singer.total, 120000, "the plan table's real total, not twelve of one month's charge");
assert.equal(singer.outstanding, 110000, 'what the bank says is still owed');
/* 2. the one-time charges and the payments are the same: the conversion legs are in neither, the plan lines are not purchases */
assert.deepEqual(listOf(hand, 'cconetime'), listOf(worker, 'cconetime'), 'the one-time charges are the same');
assert.deepEqual(listOf(hand, 'ccPayments'), listOf(worker, 'ccPayments'), 'the card payments are the same');
assert.ok(!listOf(hand, 'cconetime').some(x => /SINGER|ABANS/.test(x)), 'no plan line is a one-time purchase');
assert.ok(!listOf(hand, 'ccPayments').some(x => /SINGER/.test(x)), 'the purchase turned into a plan is not a card payment');

/* 3. next month's statement continues the SAME plan, and Undo takes that month off again */
const NEXT = [['05/09/2026', 'SINGER 12M NATIONS PAY INST 2 - REM BAL - 100000.00 - <2/12>', 10000, 'DR']];
await upload('NTB Statement Sep 26 (hand).html', statement(NEXT, 'next month').replace('03/09/2026', '03/10/2026').replace('25/09/2026', '25/10/2026').replace(/11\/12/, '10/12').replace('110,000.00', '100,000.00'));
const second = await save();
console.log('page notes (next month):', JSON.stringify(second.map(n => n[0])));
const after = await dump();
const singers = after.ccinstall.filter(p => /SINGER/i.test(p.product));
assert.equal(singers.length, 1, 'next month continues the same plan, never a second one');
assert.deepEqual(singers[0].payments.filter(p => p.paid).map(p => p.month).sort(), ['2026-08', '2026-09'], 'the plan holds both months');
assert.equal(singers[0].installmentNo, 2, 'the plan is on its 2nd instalment');
assert.equal(singers[0].outstanding, 100000, 'what is owed follows the bank figure of the latest statement');
const undone = await page.evaluate(() => { const b = window.WFBatch.list().slice(-1)[0]; const r = window.WFBatch.undo(b.id); const p = (window.DB.get('ccinstall') || []).filter(x => /SINGER/i.test(x.product)); return { removed: r && r.removed, months: p.length ? p[0].payments.filter(x => x.paid).map(x => x.month) : null, outstanding: p.length ? p[0].outstanding : null, installmentNo: p.length ? p[0].installmentNo : null }; });
console.log('undo ->', JSON.stringify(undone));
assert.deepEqual(undone.months, ['2026-08'], 'Undo takes the month it added off the plan');
assert.equal(undone.outstanding, 110000, 'and the plan is as it was before');

console.log('page errors:', app.pageErrors.filter(e => !/Chart|cdn|fetch/i.test(e)).slice(0, 3));
await app.close();
_setAdminModule(null);
console.log('OK: a card statement with instalment plans is filed the same by the email worker and the manual upload, continues its plan next month, and Undo puts it back');
