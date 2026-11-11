/* =============================================================================
 * test/e2e/manual-email-parity.mjs — the same statement, filed by the email worker and by the owner's own upload, lands in the same books (2026-11-11)
 * -----------------------------------------------------------------------------
 * The owner's rule: the email system and the manual upload are ONE system (one is autonomous, the other by hand), so a statement must be categorised the same whichever door it came through.
 * This feeds one invented statement to both doors — the REAL email worker (statement-sync.js, no AI board) over an in-memory Firestore, and the REAL page (Chromium, the CC One-Time upload button,
 * Save) — and lists every row the two filed differently: the list it went to, or the category it carries.
 *
 * Run from the repository root:  node test/e2e/manual-email-parity.mjs      (a card statement, then a bank statement)
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
const day = n => `${String(n).padStart(2, '0')}/08/2026`;
const LISTS = ['expenses', 'cconetime', 'incomeRecv', 'ccPayments', 'subscriptions'];

/* an invented NTB American Express statement: one row of every kind a card statement carries */
const CARD = [
    ['SUPERMARKET BAMBALAPITIYA', 8350.5, 'DR'], ['FUEL STATION KOLLUPITIYA', 4200, 'DR'], ['ONLINE SHOP COLOMBO', 1900, 'DR'], ['KEELLS SUPER NAWALA', 6120, 'DR'], ['UBER TRIP COLOMBO', 850, 'DR'],
    ['NETFLIX.COM', 1490, 'DR'], ['DIALOG AXIATA 0771234567', 2300, 'DR'], ['PICKME FOOD COLOMBO', 1275, 'DR'], ['PHARMACY HEALTH GUARD', 3340, 'DR'], ['CINNAMON GRAND HOTEL', 18500, 'DR'],
    ['ANNUAL FEE', 5000, 'DR'], ['INTEREST CHARGES', 2450.75, 'DR'], ['CASH ADVANCE ATM COLOMBO', 20000, 'DR'], ['CASH ADVANCE FEE', 600, 'DR'],
    ['PAYMENT RECEIVED THANK YOU', 15000, 'CR'], ['CASHBACK CREDIT', 320, 'CR'], ['REFUND ONLINE SHOP COLOMBO', 900, 'CR'], ['REVERSAL FUEL STATION', 500, 'CR'],
].map(([words, amount, side], i) => [day(2 + (i % 26)), words, amount, side]);
const cardStatement = (rows, note = '') => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 03/09/2026 Payment Due Date: 25/09/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${rows.map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table><!-- ${note} --></body></html>`;

const BANK = [
    ['SALARY CREDIT ACME PVT LTD', 185000, 'CR'], ['OUTWARD CEFT TRANSFER CAR', 25000, 'DR'], ['INWARD CEFT TRANSFER DIP REFUND', 12000, 'CR'], ['ATM CASH WITHDRAWAL COLOMBO', 10000, 'DR'], ['CEFT CHARGES', 25, 'DR'],
    ['POS KEELLS SUPER NAWALA', 6120, 'DR'], ['DIALOG AXIATA BILL 0771234567', 2300, 'DR'], ['CEB ELECTRICITY BILL', 4800, 'DR'], ['SLT BROADBAND', 3200, 'DR'], ['INTEREST CREDIT', 410.25, 'CR'],
    ['CHEQUE DEPOSIT 285943', 50000, 'CR'], ['CHQ PAID 000123', 15000, 'DR'], ['INSURANCE PREMIUM AIA', 7800, 'DR'], ['CASHBACK CREDIT NTB AMEX', 320, 'CR'],
    ['CASH ADVANCE CR 376657******0276', 20000, 'CR'], ['CARD PAYMENT 376657XXXXX0276', 15000, 'DR'], ['SALARY ADVANCE REPAY', 5000, 'DR'], ['FUEL SHELL KOLLUPITIYA', 4200, 'DR'],
].map(([words, amount, side], i) => [day(2 + (i % 26)), words, amount, side]);
const bankStatement = (rows, note = '') => {
    let bal = 500000;
    const body = rows.map(([d, words, amount, side]) => { bal += side === 'CR' ? amount : -amount; return `<tr><td>${d}</td><td>${words}</td><td>${side === 'DR' ? amount.toFixed(2) : ''}</td><td>${side === 'CR' ? amount.toFixed(2) : ''}</td><td>${bal.toFixed(2)}</td></tr>`; }).join('');
    return `<html><body><h1>Nations Trust Bank Savings Account Statement</h1><p>Account Number: 100012345678</p><p>Statement Period: 01/08/2026 to 31/08/2026</p><p>Opening Balance 500000.00</p><table><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr>${body}</table><!-- ${note} --></body></html>`;
};
const WHICH = process.argv.includes('--bank') ? 'bank' : 'card';      // the bank run is a child of the card run: one statement per browser
const ROWS = WHICH === 'bank' ? BANK : CARD;
const statement = WHICH === 'bank' ? bankStatement : cardStatement;

/* ── the server side: the real worker files the statement the email system received ── */
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
const fake = makeFakeAdmin();
fake.setVerifier(async () => ({ uid: UID, email: TEST_USER.email, email_verified: true }));
const blank = () => ({ expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] });
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
const norm = text => String(text || '').toUpperCase().replace(/\s+/g, ' ').trim();
const wordsOf = r => norm(r.description || r.name || r.narration || r.note || r.desc || '');
const workerRows = [];
for (const list of LISTS) for (const r of worker[list] || []) workerRows.push({ list, words: wordsOf(r), amount: Number(r.amount ?? r.cost ?? 0), category: r.category || r.cat || '', type: r.type || '' });
console.log(`server: the email worker filed ${workerRows.length} of ${ROWS.length} rows`);
if (process.argv.includes('--dump')) console.log('worker sample:', JSON.stringify({ cconetime: (worker.cconetime || []).find(r => /KEELLS/i.test(wordsOf(r))), subscriptions: worker.subscriptions, cc: (worker.cconetime || []).length }));

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
/* the owner's own account is another one than the worker's: the page's guard sees empty books, so no row is named "already in your books" and every row is judged on its own words */
const fresh = createFirestore({ [`users/${UID}`]: blank() });
fake.admin.firestore = () => fresh.db;
await page.setInputFiles(WHICH === 'bank' ? '#ccot_ai_scan' : '#ccot_ai_scan', { name: 'NTB Statement Aug 26 (hand).html', mimeType: 'text/html', buffer: Buffer.from(statement(ROWS, 'hand copy')) });
await page.waitForFunction(() => document.querySelector('#_ccr_body') || document.querySelector('#mdConfirm.open'), null, { timeout: 30000 });
assert.ok(await page.$('#_ccr_body'), 'the review opened');
await page.evaluate(() => document.getElementById('_ccr_save').click());
await page.waitForFunction(() => (window.__notes || []).some(n => /Filed|Nothing added|added|Added/.test(n[0])) && !document.querySelector('#_ccr_body'), null, { timeout: 30000 }).catch(() => {});
const pageRows = await page.evaluate(lists => {
    const out = [];
    for (const list of lists) for (const r of (window.DB && DB.get(list) || [])) out.push({ list, words: String(r.description || r.name || r.narration || r.note || r.desc || '').toUpperCase().replace(/\s+/g, ' ').trim(), amount: Number(r.amount ?? r.cost ?? 0), category: r.category || r.cat || '', type: r.type || '' });
    return out;
}, LISTS);
if (process.argv.includes('--dump')) {
    console.log(JSON.stringify(await page.evaluate(lists => lists.map(l => [l, (window.DB.get(l) || []).length, (window.DB.get(l) || []).slice(0, 2)]), LISTS), null, 1).slice(0, 5000));
    console.log('notes:', JSON.stringify(await page.evaluate(() => window.__notes)));
}
console.log(`page:   the manual upload filed ${pageRows.length} of ${ROWS.length} rows`);

if (WHICH === 'card') {
    /* a card statement that carries a PAYMENT has credits and debits: it used to be taken for a bank account, so the page also missed its minimum-payment ask */
    const dues = await page.evaluate(() => (window.DB.get('cardDues') || []).map(r => ({ minimum: r.minimum, last4: r.card_last4 })));
    console.log('page:   minimum-payment asks ->', JSON.stringify(dues));
    assert.deepEqual(dues, [{ minimum: 10000, last4: '0276' }], 'the card statement keeps its minimum-payment ask');
}
const key = r => `${r.words}|${r.amount.toFixed(2)}`;
const W = new Map(workerRows.map(r => [key(r), r])), P = new Map(pageRows.map(r => [key(r), r]));
const diffs = [];
for (const row of ROWS) {
    const k = `${norm(row[1])}|${row[2].toFixed(2)}`;
    const w = W.get(k), p = P.get(k);
    const a = w ? `${w.list}/${w.category}` : '(left out)', b = p ? `${p.list}/${p.category}` : '(left out)';
    console.log(`${a === b ? 'same' : 'DIFF'}  ${row[1].padEnd(36)} ${String(row[2]).padStart(10)} ${row[3]}   email: ${a.padEnd(34)} manual: ${b}`);
    if (a !== b) diffs.push({ words: row[1], email: a, manual: b });
}
console.log(`\n${diffs.length} of ${ROWS.length} rows are filed differently by the two doors`);
console.log('page errors:', app.pageErrors.filter(e => !/Chart|cdn|fetch/i.test(e)).slice(0, 3));
await app.close();
_setAdminModule(null);
/* The two doors file every row alike, with ONE known difference: a recurring bill of a BANK account (an electricity bill, a broadband bill, an insurance premium) is a Subscription on the page and an
 * Expense at the e-mail worker, which starts a Subscription only for a brand or a phone number (statement-subscriptions.mjs). The owner decides which way it should go (open: bill account numbers). */
const KNOWN = WHICH === 'bank' ? new Set(['CEB ELECTRICITY BILL', 'SLT BROADBAND', 'INSURANCE PREMIUM AIA']) : new Set();
const unexpected = diffs.filter(d => !KNOWN.has(d.words));
assert.deepEqual(unexpected, [], `the two doors file every ${WHICH} statement row alike`);
if (WHICH === 'card') {
    const { spawnSync } = await import('node:child_process');
    const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname, '--bank'], { stdio: 'inherit', env: process.env });
    assert.equal(child.status, 0, 'the bank statement run');
}
console.log(`OK: the ${WHICH} statement is filed alike by the e-mail worker and the manual upload`);
