/* =============================================================================
 * test/e2e/statement-lost-rows.mjs — the owner's DFCC July report (2026-10-04), played in a real browser against the real endpoint
 * -----------------------------------------------------------------------------
 * "Already Added via Email Sync (… · 7 transactions in your books)" for a statement the owner could not find in the app, by email or by hand. The email system had filed the
 * file's bytes, and a device that had not seen the rows pushed its own copy of the lists over them: the ledger said "filed", the books held a fraction of the rows, and ONE
 * record of the statement was enough for the file check to turn the owner away at both doors. This boots the app in Chromium, signs in, and uploads through the CC One-Time upload
 * button exactly as the owner does. /api/statement-guard is answered by the REAL handler (statement-guard.js) over an in-memory Firestore the REAL email worker (statement-sync.js)
 * filled first.
 *
 *   1. 5 of the statement's 8 filed rows are gone from the books     -> the review opens: the 3 rows that are there are unticked and marked, the other 5 are ticked
 *   2. Save                                                          -> the 5 rows are filed, nothing twice
 *   3. the same file again, every row now in the books               -> turned away, and the owner is OFFERED "Add missing rows" (never shut out)
 *   4. the owner accepts                                             -> the review opens with all 8 rows already in the books, unticked and marked; nothing is added twice
 *
 * Run from the repository root:  node test/e2e/statement-lost-rows.mjs
 * No real account, mailbox or bank data is used.
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
const ROWS = Array.from({ length: 8 }, (_, i) => [`${String(i + 3).padStart(2, '0')}/08/2026`, `SHOP NUMBER ${i + 1} COLOMBO`, 150 + i * 37.5, 'DR']);
const statement = rows => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 03/09/2026 Payment Due Date: 25/09/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${rows.map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table></body></html>`;
const FILE = statement(ROWS);

/* ── the server side: the real worker files the whole statement; then a stale device's copy of the lists goes over the server's, and 3 of the 8 records survive ── */
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
const fake = makeFakeAdmin();
fake.setVerifier(async () => ({ uid: UID, email: TEST_USER.email, email_verified: true }));
const store = createFirestore({
    [MAIL]: { uid: UID, email: TEST_USER.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] },
    [`${MAIL}/items/s0`]: { uid: UID, bank: 'NTB', from: 'statements@nationstrust.com', filename: 'DFCC Bank Statement - Jul 26.pdf', messageId: 'm0', receivedMs: 1000, status: 'pending', cursor: 0, filed: false },
    [`users/${UID}`]: { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] },
});
fake.admin.firestore = () => store.db; _setAdminModule(fake.admin);
for (let i = 0; i < 6; i++) {
    const r = await runStatementSync({ action: 'drain', db: store.db, owner: { uid: UID, email: TEST_USER.email }, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 't' }) }),
        read: readStatement, open: async () => [], settle: settleStatement, board: async () => null, loadAttachment: async () => ({ bytes: Buffer.from(FILE), filename: 'DFCC Bank Statement - Jul 26.pdf', contentSha256: sha(FILE) }), budgetMs: 20000 });
    if (!r || !r.filed) break;
}
assert.equal(store.data.get(`${MAIL}/items/s0`).filed, true, 'the email worker filed the statement');
const books = () => store.data.get(`users/${UID}`);
const count = () => ['expenses', 'cconetime', 'incomeRecv', 'ccPayments'].reduce((n, k) => n + (books()[k] || []).length, 0);
assert.equal(count(), 8, 'all 8 rows were filed');
const keep = new Set(['2026-08-03', '2026-08-04', '2026-08-05']);
const u = books();
store.data.set(`users/${UID}`, { ...u, ...Object.fromEntries(['expenses', 'cconetime', 'incomeRecv', 'ccPayments'].map(k => [k, (u[k] || []).filter(r => keep.has(r.date))])) });
assert.equal(count(), 3, 'a stale device left 3 of the 8 records');
console.log('server: the email system filed 8 rows; the books now hold', count());

/* ── the browser ── */
const app = await bootApp();
const { page } = app;
const calls = [];
await page.route('**/api/statement-guard', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    let out;
    const res = { statusCode: 200, setHeader() {}, end(text) { out = { status: this.statusCode, text }; } };
    await guard({ method: 'POST', body, headers: { authorization: 'Bearer e2e' } }, res);
    calls.push({ action: body.action, force: body.force === true, duplicate: JSON.parse(out.text).duplicate === true });
    await route.fulfill({ status: out.status, contentType: 'application/json', body: out.text });
});
await page.route('**/api/ai**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
await page.evaluate(() => {
    const user = window.firebase.auth().currentUser; user.getIdToken = async () => 'e2e';
    window.__notes = []; const say = window.notify; window.notify = (m, t) => { window.__notes.push([String(m), t]); try { return say(m, t); } catch (_) { return undefined; } };
});
await page.waitForFunction(() => !!(window.WFStatementCloud && window.WFStatementCloud.guard), null, { timeout: 15000 });

const notes = () => page.evaluate(() => window.__notes.splice(0));
const log = () => calls.map(c => `${c.action}${c.force ? '+force' : ''}${c.duplicate ? ':duplicate' : ''}`).join(', ');
async function upload(name, body) {
    calls.length = 0;
    await page.setInputFiles('#ccot_ai_scan', { name, mimeType: 'text/html', buffer: Buffer.from(body) });
    await page.waitForFunction(() => document.querySelector('#_ccr_body') || document.querySelector('#mdConfirm.open') || (window.__notes || []).some(n => /Already Added/.test(n[0])), null, { timeout: 30000 });
    return { modal: await page.$('#_ccr_body') !== null, ask: await page.$('#mdConfirm.open') !== null, notes: await notes() };
}
const marks = () => page.evaluate(() => [...document.querySelectorAll('#_ccr_body tr')].filter(tr => tr.querySelector('._ccr_keep')).map(tr => ({ kept: tr.querySelector('._ccr_keep').checked, have: /Already in your books/.test(tr.textContent) })));
const close = () => page.evaluate(() => { const x = document.getElementById('_ccrx'); if (x) x.click(); });

// 1. the owner's report: the same file, 3 of its 8 filed rows left in the books
const first = await upload('DFCC Bank Statement - Jul 26.html', FILE);
const m1 = await marks();
console.log('1. lost rows   ->', first.modal ? 'review opened' : 'TURNED AWAY', '|', JSON.stringify({ have: m1.filter(m => m.have).length, ticked: m1.filter(m => m.kept).length }), '| guard:', log());
assert.ok(first.modal && !first.ask, 'the statement is not turned away for the 3 records that are left');
assert.ok(!first.notes.some(n => /Already Added/.test(n[0])), 'no "Already Added" for a statement whose rows are mostly not in the books');
assert.equal(m1.length, 8);
assert.equal(m1.filter(m => m.have).length, 3, 'the 3 rows that are there are named');
assert.ok(m1.every(m => m.kept === !m.have), 'the 3 are unticked, the 5 missing ones ticked');

// 2. Save: the missing rows go in
await page.evaluate(() => document.getElementById('_ccr_save').click());
await page.waitForFunction(() => (window.__notes || []).some(n => /Filed|Nothing added/.test(n[0])), null, { timeout: 30000 });
const saved = await notes();
console.log('2. Save        ->', saved.map(n => n[0]).find(m => /Filed|Nothing/.test(m)), '| guard:', log());
assert.ok(calls.some(c => c.action === 'claim' && !c.duplicate), 'the claim at Save went through');
const inApp = await page.evaluate(() => ['expenses', 'cconetime', 'incomeRecv', 'ccPayments'].map(k => (window.DB && DB.get(k) || []).filter(r => r.uploadClaim).length).reduce((a, b) => a + b, 0));
assert.equal(inApp, 5, 'exactly the 5 missing rows were filed, no row twice');
await page.waitForFunction(() => !document.querySelector('#_ccr_body'), null, { timeout: 5000 });

// the browser's lists are what the app syncs; the server's books take the same rows (the app's own save does this in the real product)
const mine = await page.evaluate(() => { const o = {}; for (const k of ['expenses', 'cconetime', 'incomeRecv', 'ccPayments']) o[k] = (window.DB && DB.get(k) || []).filter(r => r.uploadClaim); return o; });
const now = books();
store.data.set(`users/${UID}`, { ...now, ...Object.fromEntries(Object.keys(mine).map(k => [k, [...(now[k] || []), ...mine[k]]])) });
assert.equal(count(), 8, 'the books now hold all 8 rows');

// 3. the same file again: every row is in the books, so it is turned away — and the owner is offered "add anyway"
const second = await upload('DFCC Bank Statement - Jul 26 (1).html', FILE);
console.log('3. real copy   ->', second.modal ? 'REVIEW OPENED' : second.ask ? 'turned away, owner asked' : 'turned away, toast only', '|', second.notes.map(n => n[0]).find(m => /Already/.test(m)) || '', '| guard:', log());
assert.ok(!second.modal, 'a statement whose rows are all in the books is turned away');
assert.ok(second.ask, 'the owner is offered "Add missing rows" and is never shut out');
const dialog = await page.evaluate(() => ({ title: document.getElementById('confMsg').textContent, button: document.getElementById('confBtn').textContent }));
assert.match(dialog.title, /Already Added/);
assert.match(dialog.button, /Add missing rows/);

// 4. the owner accepts: the review opens, and every row that is already there is left unticked
await page.evaluate(() => document.getElementById('confBtn').click());
await page.waitForSelector('#_ccr_body', { timeout: 30000 });
const m4 = await marks();
console.log('4. add anyway  ->', 'review opened', '|', JSON.stringify({ have: m4.filter(m => m.have).length, ticked: m4.filter(m => m.kept).length }), '| guard:', log());
assert.equal(m4.length, 8);
assert.equal(m4.filter(m => m.have).length, 8, 'all 8 rows are already in the books and named');
assert.equal(m4.filter(m => m.kept).length, 0, 'nothing is ticked: nothing would be added twice');
assert.ok(calls.some(c => c.force), 'the server was told it was the owner\'s word');
await close();

console.log('page errors:', app.pageErrors.filter(e => !/Chart|cdn|fetch/i.test(e)).slice(0, 3));
await app.close();
_setAdminModule(null);
console.log('OK: a statement whose rows are mostly gone is added again, a statement fully in the books is turned away with "Add missing rows" offered, and no row is ever added twice');
