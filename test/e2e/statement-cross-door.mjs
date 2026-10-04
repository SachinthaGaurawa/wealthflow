/* =============================================================================
 * test/e2e/statement-cross-door.mjs — the owner's duplicated rows (2026-10-04), played in a real browser against the real endpoint
 * -----------------------------------------------------------------------------
 * The same bank statement reached the books by BOTH doors — the email system and the owner's own upload — and every row was there twice ("Inward Ceft Transfer Dividend Paymen" 50,000 twice, and so on).
 * And a statement that really shows the same payment three times in one day lost two of them to the review's own duplicate check. This boots the app in Chromium, signs in, and uploads through the CC
 * One-Time upload button exactly as the owner does. /api/statement-guard is answered by the REAL handler (statement-guard.js) over an in-memory Firestore the REAL email worker (statement-sync.js) filled.
 *
 *   1. the email system filed the statement; the owner uploads it by hand (other bytes) -> every row is named "Already in your books" and unticked; Save adds nothing
 *   2. a statement with THREE identical bus fares on one day, uploaded by hand        -> all three are filed (not one)
 *   3. the same statement again, other bytes                                           -> all five rows are named; nothing is added twice
 *   4. the books hold only two of the three fares                                      -> exactly one is ticked; Save adds exactly one
 *
 * Run from the repository root:  node test/e2e/statement-cross-door.mjs
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
const REPEATS = [['05/08/2026', 'BUS FARE COLOMBO FORT', 50, 'DR'], ['05/08/2026', 'BUS FARE COLOMBO FORT', 50, 'DR'], ['05/08/2026', 'BUS FARE COLOMBO FORT', 50, 'DR'], ['06/08/2026', 'FUEL STATION KOLLUPITIYA', 4200, 'DR'], ['07/08/2026', 'SUPERMARKET BAMBALAPITIYA', 8350.5, 'DR']];
const statement = (rows, note = '') => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 03/09/2026 Payment Due Date: 25/09/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${rows.map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table><!-- ${note} --></body></html>`;
const LISTS = ['expenses', 'cconetime', 'incomeRecv', 'ccPayments'];

/* ── the server side: the real worker files the statement the email system received ── */
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
const fake = makeFakeAdmin();
fake.setVerifier(async () => ({ uid: UID, email: TEST_USER.email, email_verified: true }));
const store = createFirestore({
    [MAIL]: { uid: UID, email: TEST_USER.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] },
    [`${MAIL}/items/s0`]: { uid: UID, bank: 'NTB', from: 'statements@nationstrust.com', filename: 'NTB Statement Aug 26.pdf', messageId: 'm0', receivedMs: 1000, status: 'pending', cursor: 0, filed: false },
    [`users/${UID}`]: { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] },
});
fake.admin.firestore = () => store.db; _setAdminModule(fake.admin);
const emailFiles = async rows => {
    const file = statement(rows, 'email copy');
    for (let i = 0; i < 6; i++) {
        const r = await runStatementSync({ action: 'drain', db: store.db, owner: { uid: UID, email: TEST_USER.email }, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 't' }) }),
            read: readStatement, open: async () => [], settle: settleStatement, board: async () => null, loadAttachment: async () => ({ bytes: Buffer.from(file), filename: 'NTB Statement Aug 26.pdf', contentSha256: sha(file) }), budgetMs: 20000 });
        if (!r || !r.filed) break;
    }
};
const books = () => store.data.get(`users/${UID}`);
const count = () => LISTS.reduce((n, k) => n + (books()[k] || []).length, 0);
/* the registry does not know the owner's upload (a statement the hand reading could not name the bank or card of, a hold given back): the ROWS are what has to tell the two doors apart */
const forgetRegistry = () => { for (const key of [...store.data.keys()]) if (key.startsWith(`users/${UID}/statementRegistry/`)) store.data.delete(key); };

await emailFiles(ROWS);
assert.equal(store.data.get(`${MAIL}/items/s0`).filed, true, 'the email worker filed the statement');
assert.equal(count(), 8, 'all 8 rows were filed by email');
forgetRegistry();
console.log('server: the email system filed', count(), 'rows');

/* ── the browser ── */
const app = await bootApp();
const { page } = app;
const calls = [];
await page.route('**/api/statement-guard', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    let out;
    const res = { statusCode: 200, setHeader() {}, end(text) { out = { status: this.statusCode, text }; } };
    await guard({ method: 'POST', body, headers: { authorization: 'Bearer e2e' } }, res);
    const answer = JSON.parse(out.text);
    calls.push({ action: body.action, rows: (body.dates || []).length, directions: Array.isArray(body.directions), words: Array.isArray(body.words), duplicate: answer.duplicate === true, have: (answer.have || []).length });
    await route.fulfill({ status: out.status, contentType: 'application/json', body: out.text });
});
await page.route('**/api/ai**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }));
await page.evaluate(() => {
    const user = window.firebase.auth().currentUser; user.getIdToken = async () => 'e2e';
    window.__notes = []; const say = window.notify; window.notify = (m, t) => { window.__notes.push([String(m), t]); try { return say(m, t); } catch (_) { return undefined; } };
});
await page.waitForFunction(() => !!(window.WFStatementCloud && window.WFStatementCloud.guard), null, { timeout: 15000 });

const notes = () => page.evaluate(() => window.__notes.splice(0));
const log = () => calls.map(c => `${c.action}${c.duplicate ? ':duplicate' : ''}${c.have ? `(have ${c.have})` : ''}`).join(', ');
async function upload(name, body) {
    calls.length = 0;
    await page.setInputFiles('#ccot_ai_scan', { name, mimeType: 'text/html', buffer: Buffer.from(body) });
    await page.waitForFunction(() => document.querySelector('#_ccr_body') || document.querySelector('#mdConfirm.open') || (window.__notes || []).some(n => /Already Added/.test(n[0])), null, { timeout: 30000 });
    return { modal: await page.$('#_ccr_body') !== null, ask: await page.$('#mdConfirm.open') !== null, notes: await notes() };
}
const marks = () => page.evaluate(() => [...document.querySelectorAll('#_ccr_body tr')].filter(tr => tr.querySelector('._ccr_keep')).map(tr => ({ kept: tr.querySelector('._ccr_keep').checked, have: /Already in your books/.test(tr.textContent), words: (tr.querySelector('._ccr_desc') || {}).value || '' })));
const save = async () => { await page.evaluate(() => document.getElementById('_ccr_save').click()); await page.waitForFunction(() => (window.__notes || []).some(n => /Filed|Nothing added|added|Added/.test(n[0])) && !document.querySelector('#_ccr_body'), null, { timeout: 30000 }).catch(() => {}); return notes(); };
const mine = () => page.evaluate(lists => lists.map(k => (window.DB && DB.get(k) || []).filter(r => r.uploadClaim).length).reduce((a, b) => a + b, 0), LISTS);
const close = () => page.evaluate(() => { const x = document.getElementById('_ccrx'); if (x) x.click(); });
/** the browser's records join the server's books (the app's own sync does this in the real product) */
const sync = async () => {
    const mineByList = await page.evaluate(lists => { const o = {}; for (const k of lists) o[k] = (window.DB && DB.get(k) || []).filter(r => r.uploadClaim); return o; }, LISTS);
    const now = books();
    store.data.set(`users/${UID}`, { ...now, ...Object.fromEntries(Object.keys(mineByList).map(k => [k, [...(now[k] || []).filter(r => !r.uploadClaim), ...mineByList[k]]])) });
};

// 1. the owner's report: the same statement by hand, after the email system filed it
const first = await upload('NTB Statement Aug 26 (downloaded).html', statement(ROWS, 'hand copy'));
const m1 = await marks();
console.log('1. email first ->', first.modal ? 'review opened' : first.ask ? 'asked' : 'TURNED AWAY', '|', JSON.stringify({ have: m1.filter(m => m.have).length, ticked: m1.filter(m => m.kept).length }), '| guard:', log());
assert.ok(first.modal, 'the review opens (the file is not the email system\'s bytes)');
assert.equal(m1.length, 8);
assert.equal(m1.filter(m => m.have).length, 8, 'every row the email system filed is named "Already in your books"');
assert.equal(m1.filter(m => m.kept).length, 0, 'nothing is ticked: nothing would be filed twice');
assert.ok(calls.some(c => c.action === 'check' && c.directions && c.words), 'the page sent each row\'s direction and words');
await save();
assert.equal(await mine(), 0, 'Save added nothing');
assert.equal(count(), 8, 'the books still hold each row once');
await close();

// 2. a statement that shows the same payment three times on one day: all three are filed
store.data.set(`users/${UID}`, { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] });
forgetRegistry();
const second = await upload('NTB Statement fares.html', statement(REPEATS, 'first copy'));
const m2 = await marks();
console.log('2. repeats     ->', second.modal ? 'review opened' : 'TURNED AWAY', '|', JSON.stringify({ rows: m2.length, ticked: m2.filter(m => m.kept).length }), '| guard:', log());
assert.ok(second.modal);
assert.equal(m2.length, 5);
assert.equal(m2.filter(m => m.kept).length, 5, 'all five rows are ticked');
await save();
const filed2 = await mine();
console.log('   Save        ->', filed2, 'records filed');
assert.equal(filed2, 5, 'the three identical fares are three records (the review used to keep one)');
await sync();

// 3. the same statement again (other bytes): every row is named
forgetRegistry();
const third = await upload('NTB Statement fares (again).html', statement(REPEATS, 'second copy'));
const m3 = await marks();
console.log('3. again       ->', third.modal ? 'review opened' : third.ask ? 'asked' : 'turned away', '|', JSON.stringify({ have: m3.filter(m => m.have).length, ticked: m3.filter(m => m.kept).length }), '| guard:', log());
assert.ok(third.modal && m3.length === 5);
assert.equal(m3.filter(m => m.have).length, 5, 'all five rows (three identical fares among them) are named');
assert.equal(m3.filter(m => m.kept).length, 0);
await save();
assert.equal(await mine(), 5, 'nothing was added twice');
await close();

// 4. the books hold only two of the three fares (a stale device lost one): exactly one is ticked and exactly one is added
const u = books();
let dropped = false;
const without = k => (u[k] || []).filter(r => { if (!dropped && r.uploadClaim && r.amount === 50) { dropped = true; return false; } return true; });
store.data.set(`users/${UID}`, { ...u, ...Object.fromEntries(LISTS.map(k => [k, without(k)])) });
await page.evaluate(lists => { let dropped = false; for (const k of lists) { const list = (window.DB && DB.get(k)) || []; const kept = list.filter(r => { if (!dropped && r.uploadClaim && r.amount === 50) { dropped = true; return false; } return true; }); if (kept.length !== list.length) DB.set(k, kept); } }, LISTS);
assert.equal(await mine(), 4, 'both copies of the books now hold two of the three fares');
forgetRegistry();
const fourth = await upload('NTB Statement fares (third).html', statement(REPEATS, 'third copy'));
const m4 = await marks();
console.log('4. one lost    ->', fourth.modal ? 'review opened' : 'TURNED AWAY', '|', JSON.stringify({ have: m4.filter(m => m.have).length, ticked: m4.filter(m => m.kept).length }), '| guard:', log());
assert.ok(fourth.modal && m4.length === 5);
assert.equal(m4.filter(m => m.have).length, 4, 'the four rows the books hold are named');
assert.equal(m4.filter(m => m.kept).length, 1, 'only the lost fare is ticked');
await save();
assert.equal(await mine(), 5, 'exactly the one lost fare was added back: three fares again, nothing twice');

console.log('page errors:', app.pageErrors.filter(e => !/Chart|cdn|fetch/i.test(e)).slice(0, 3));
await app.close();
_setAdminModule(null);
console.log('OK: a statement the email system filed is not filed again by hand, repeated payments of one day stay repeated, and a lost row is added back exactly once');
