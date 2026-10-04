/* =============================================================================
 * test/e2e/statement-already-added.mjs — the owner's report, played in a real browser against the real endpoint
 * -----------------------------------------------------------------------------
 * "A statement the email system never filed is turned away on manual upload as Already Added." This boots the app in Chromium, signs in, and uploads
 * statement files through the CC One-Time upload button exactly as the owner does. /api/statement-guard is answered by the REAL handler
 * (statement-guard.js) over an in-memory Firestore that the REAL email worker (statement-sync.js) filled first, and whose registry holds were then
 * rewritten the way the first registry wrote them (no days, no rows): the state production carries for every statement filed before 2026-10-03.
 *
 *   1. the next billing cycle of the same card, never filed by email      -> the review opens and Save files it (no "Already Added")
 *   2. a re-download of the statement the email system DID file            -> "Already Added via Email Sync (… 2 of 2 transactions are in your books)"
 *   3. a statement that overlaps the filed one (shares one row with it)     -> the review opens with the row already there unticked and marked
 *
 * Run from the repository root:  node test/e2e/statement-already-added.mjs
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
import { REGISTRY } from '../../statement-registry.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const UID = TEST_USER.uid, MAIL = `wf-mail/${userKeyFor(TEST_USER.email)}`;
const statement = (date, rows) => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: ${date} Payment Due Date: 25/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${rows.map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table></body></html>`;
/* A card that closes on the 3rd: the cycle 4 Aug – 3 Sep (filed by email) and the cycle 4 Sep – 3 Oct (never fetched by email; the owner has the file).
 * Neither has a transaction after the 28th, so the email worker keys both on September. */
const AUG = statement('03/09/2026', [['12/08/2026', 'KEELLS STORE', 123.45, 'DR'], ['02/09/2026', 'PAYMENT THANK YOU', 50, 'CR']]);
const SEP = statement('03/10/2026', [['18/09/2026', 'CARGILLS FOOD CITY', 2450, 'DR'], ['27/09/2026', 'ODEL COLOMBO', 1999, 'DR']]);

/* ── the server side: the real worker files AUG; its holds are then rewritten as the first registry wrote them ── */
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
const fake = makeFakeAdmin();
fake.setVerifier(async () => ({ uid: UID, email: TEST_USER.email, email_verified: true }));
const store = createFirestore({
    [MAIL]: { uid: UID, email: TEST_USER.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] },
    [`${MAIL}/items/s0`]: { uid: UID, bank: 'NTB', from: 'statements@nationstrust.com', filename: 'AMEX_Statement.html', messageId: 'm0', receivedMs: 1000, status: 'pending', cursor: 0, filed: false },
    [`users/${UID}`]: { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] },
});
fake.admin.firestore = () => store.db; _setAdminModule(fake.admin);
for (let i = 0; i < 6; i++) {
    const r = await runStatementSync({ action: 'drain', db: store.db, owner: { uid: UID, email: TEST_USER.email }, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 't' }) }),
        read: readStatement, open: async () => [], settle: settleStatement, board: async () => null, loadAttachment: async () => ({ bytes: Buffer.from(AUG), filename: 'AMEX_Statement.html', contentSha256: sha(AUG) }), budgetMs: 20000 });
    if (!r || !r.filed) break;
}
assert.equal(store.data.get(`${MAIL}/items/s0`).filed, true, 'the email worker filed the August cycle');
for (const key of [...store.data.keys()].filter(k => k.startsWith(`users/${UID}/${REGISTRY}/`))) { const { days, rows, door, ...first } = store.data.get(key); store.data.set(key, first); }
const books = () => store.data.get(`users/${UID}`);
console.log('server: email filed', books().cconetime.length + books().ccPayments.length, 'rows of the August cycle; registry holds:', [...store.data.keys()].filter(k => k.includes(REGISTRY)).length, '(first-registry shape)');

/* ── the browser ── */
const app = await bootApp();
const { page } = app;
const calls = [];
await page.route('**/api/statement-guard', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    let out;
    const res = { statusCode: 200, setHeader() {}, end(text) { out = { status: this.statusCode, text }; } };
    await guard({ method: 'POST', body, headers: { authorization: 'Bearer e2e' } }, res);
    calls.push({ action: body.action, duplicate: JSON.parse(out.text).duplicate === true });
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
    calls.length = 0;
    await page.setInputFiles('#ccot_ai_scan', { name, mimeType: 'text/html', buffer: Buffer.from(body) });
    await page.waitForFunction(() => document.querySelector('#_ccr_body') || (window.__notes || []).some(n => /Already Added/.test(n[0])), null, { timeout: 30000 });
    return { modal: await page.$('#_ccr_body') !== null, notes: await notes() };
}
const close = () => page.evaluate(() => { const x = document.getElementById('_ccrx'); if (x) x.click(); });

// 1. the owner's report
const first = await upload('AMEX_Statement_Oct.html', SEP);
console.log('1. next cycle  ->', first.modal ? 'review opened' : 'TURNED AWAY', '|', first.notes.map(n => n[0]).join(' / ').slice(0, 200));
assert.ok(first.modal, 'the next billing cycle is not turned away');
assert.ok(!first.notes.some(n => /Already Added/.test(n[0])), 'no "Already Added" for a statement the books do not hold');
await page.evaluate(() => document.getElementById('_ccr_save').click());      // through the button's own handler (a "what's new" panel may sit over the page)
await page.waitForFunction(() => (window.__notes || []).some(n => /Filed|Nothing added/.test(n[0])), null, { timeout: 30000 });
const saved = await notes();
console.log('   Save        ->', saved.map(n => n[0]).find(m => /Filed|Nothing/.test(m)), '| guard:', calls.map(c => `${c.action}${c.duplicate ? ':duplicate' : ''}`).join(', '));
assert.ok(calls.some(c => c.action === 'claim' && !c.duplicate), 'the claim at Save went through');
const filed = await page.evaluate(() => (window.DB && DB.get('cconetime') || []).filter(r => r.uploadClaim).map(r => r.date).sort());
assert.deepEqual(filed, ['2026-09-18', '2026-09-27']);
await page.waitForFunction(() => !document.querySelector('#_ccr_body'), null, { timeout: 5000 });

// 2. a re-download of the statement the email system DID file
const second = await upload('AMEX_Statement_Sep_redownload.html', AUG.replace('<h1>', '<h1 class="app">'));
console.log('2. real copy   ->', second.modal ? 'REVIEW OPENED' : 'turned away', '|', second.notes.map(n => n[0]).find(m => /Already/.test(m)), '| guard:', calls.map(c => `${c.action}${c.duplicate ? ':duplicate' : ''}`).join(', '));
assert.ok(!second.modal, 'a statement whose transactions are in the books is turned away');
assert.match(second.notes.map(n => n[0]).join(' '), /Already Added via Email Sync \(.*2 of 2 transactions are in your books\)/);

// 3. a statement of another period that overlaps the filed one: it shares one row (the payment of 2 Sep) and nothing else
const PART = statement('19/09/2026', [['25/08/2026', 'UBER TRIP', 880, 'DR'], ['02/09/2026', 'PAYMENT THANK YOU', 50, 'CR'], ['05/09/2026', 'PICKME FOOD', 1430, 'DR'], ['10/09/2026', 'DARAZ', 2990, 'DR']]);
const third = await upload('AMEX_Statement_Sep_full.html', PART);
const marks = await page.evaluate(() => [...document.querySelectorAll('#_ccr_body tr')].map(tr => ({ kept: tr.querySelector('._ccr_keep').checked, have: /Already in your books/.test(tr.textContent) })));
console.log('3. overlapping ->', third.modal ? 'review opened' : 'TURNED AWAY', '|', JSON.stringify(marks));
assert.ok(third.modal, 'a statement that only overlaps the filed one is not turned away');
assert.deepEqual(marks.filter(m => m.have).length, 1, 'the one row already in the books is marked');
assert.ok(marks.every(m => m.kept === !m.have), 'and left unticked; the rest stay ticked');
await close();

console.log('page errors:', app.pageErrors.filter(e => !/Chart|cdn|fetch/i.test(e)).slice(0, 3));
await app.close();
_setAdminModule(null);
console.log('OK: the owner\'s statement goes in, a real copy is still turned away, and an overlapping statement adds only what is missing');
