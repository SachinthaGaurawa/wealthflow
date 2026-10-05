/* =============================================================================
 * test/e2e/part-payment.mjs — a debtor pays in parts, and is told the balance
 * -----------------------------------------------------------------------------
 * On the real Debtors screen: the "Log repayment" form shows the balance that will be left (and a warning when the
 * figure is more than is owed), can count a payment at once when the owner can already see the money, says plainly
 * that the debtor is texted the balance; "Send balance" asks first, writes ONE request on the debtor and refuses a second
 * tap for ten minutes. Then the debtor, exactly as the page saved it, is handed to the server's own derivation and
 * wording, so what the page wrote is what the debtor would be sent.
 *
 * Run from the repository root:  node test/e2e/part-payment.mjs
 * No real number, account or gateway is used.
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';
import { deriveEvents, FIELDS } from '../../sms-events.mjs';
import { buildMessage, KINDS } from '../../sms-templates.mjs';
import { analyzeSms } from '../../textlk.mjs';

const app = await bootApp();
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => !!(window.WFSms && window.WFLiquidity && window.DB && window.openDebtorEvent), null, { timeout: 20000 });
console.log('page: WFSms, WFLiquidity and DB are loaded');

const welcome = page.locator('#wfPostUpdate');
if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Return to Dashboard' }).click();
    await welcome.waitFor({ state: 'hidden' });
}

const NOW = Date.now();
const seed = (extra = {}) => ({
    id: 'dA', name: 'Nimal Perera', phone: '+94771234567', nic: '853400937V', note: '',
    sms_notifications_enabled: true, sms_enabled_at: NOW - 3600e3,
    events: [{ id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-01', confirmed: true, at: NOW - 86400e3 }],
    ...extra,
});
const plain = (extra = {}) => ({ id: 'dB', name: 'Kamal', phone: '', nic: '', note: '', events: [{ id: 'f1', kind: 'lent', amount: 10000, date: '2026-10-01', confirmed: true, at: NOW - 86400e3 }], ...extra });

/** Record every toast the page shows, so a message that is promised is a message that was shown. */
await page.evaluate(() => { window.__toasts = []; const o = window.notify; window.notify = (m, t) => { window.__toasts.push(String(m)); try { return o(m, t); } catch (_) { return undefined; } }; });
const toasts = () => page.evaluate(() => window.__toasts.slice());

const showDebtors = async (list) => {
    await page.evaluate((l) => { DB.set('debtors', l); window.showPage('liquidity'); window.setLiquidityTab('debt'); }, list);
    await page.waitForSelector('.liq-row');
};

/* ── 1. the button is there only where the text could go ─────────────────── */
await showDebtors([seed(), plain()]);
assert.equal(await page.locator('[data-liq-bal]').count(), 1, 'Send balance is offered for the debtor whose texts are on, and not for the one without');
assert.match(await page.locator('[data-liq-bal]').first().textContent(), /Send balance/);
console.log('1. the button         -> only on the debtor whose texts are on');

/* ── 2. the repayment form shows what will be left ───────────────────────── */
await page.click('[data-liq-pay="0"]');
await page.waitForSelector('#_ev_amount');
assert.match(await page.locator('.md', { has: page.locator('#_ev_amount') }).textContent(), /Outstanding now:\s*\S*\s*50,000/, 'the form says what is owed before anything is typed');
const after = () => page.textContent('#_ev_after');
await page.fill('#_ev_amount', '20000');
assert.match(await after(), /Balance after this payment:.*30,000/, 'a part payment shows the balance that will be left');
await page.fill('#_ev_amount', '60000');
assert.match(await after(), /10,000.*more than.*50,000\.00 outstanding/, 'a figure typed with an extra zero is called out before it is saved');
await page.fill('#_ev_amount', '50000');
assert.match(await after(), /settles the loan/);
await page.fill('#_ev_amount', '20000');
const hintWaiting = await page.textContent('#_ev_note_hint');
assert.match(hintWaiting, /waiting for your confirmation/);
assert.match(hintWaiting, /Once it is confirmed, Nimal Perera is texted the amount and the balance that is left/, 'the owner is told what the debtor will receive, and when');
await page.check('#_ev_now');
const hintNow = await page.textContent('#_ev_note_hint');
assert.doesNotMatch(hintNow, /waiting for your confirmation/);
assert.match(hintNow, /Nimal Perera is texted the amount and the balance that is left/);
console.log('2. the form           ->', JSON.stringify({ after: (await after()).trim(), hint: hintNow.trim().slice(0, 70) }));

/* ── 3. counted at once: it is a confirmed row, and the owner is told a text is queued ─ */
await page.click('#_ev_save');
await page.waitForFunction(() => (DB.get('debtors') || [])[0].events.length === 2);
const counted = await page.evaluate(() => (DB.get('debtors') || [])[0]);
const rep = counted.events[1];
assert.equal(rep.kind, 'repayment');
assert.equal(rep.amount, 20000);
assert.equal(rep.confirmed, true, 'ticking "I can already see this" counts it now');
assert.ok(rep.at > 0, 'and it carries the moment it was written, which is when the debtor is texted about it');
assert.ok((await toasts()).some((m) => /Repayment counted.*text with the new balance is queued/.test(m)), 'the owner is told: ' + (await toasts()).join(' | '));
console.log('3. counted now        ->', JSON.stringify({ confirmed: rep.confirmed, toast: (await toasts()).slice(-1)[0] }));

/* the server's own reading of what the page saved: the text the debtor is sent for this part payment */
const serverView = (debtor, at) => deriveEvents({ settings: { currency: 'LKR' }, debtors: [debtor] }, at);
const repText = (() => {
    const ev = serverView(counted, Date.now()).events.find((e) => e.kind === KINDS.B_REPAYMENT);
    assert.ok(ev, 'the repayment is owed as a notice');
    return buildMessage(ev.kind, { ...ev, link: 'https://wealthflow-personal.vercel.app/t/AbCdEfGhIjKlMnOp' });
})();
console.log('   the text           ->', repText);
assert.match(repText, /^Repayment LKR 20,000\.00 received.*Balance LKR 30,000\.00\./, 'the part payment and the balance that is left, in one text');
assert.equal(analyzeSms(repText).segments, 1);

/* ── 4. logged but not yet counted: nothing is texted, nothing is promised ─ */
await page.click('[data-liq-pay="0"]');
await page.waitForSelector('#_ev_amount');
assert.equal(await page.isChecked('#_ev_now'), false, 'the owner\'s rule stands: a repayment is only counted at once when they say so');
await page.fill('#_ev_amount', '5000');
await page.click('#_ev_save');
await page.waitForFunction(() => (DB.get('debtors') || [])[0].events.length === 3);
const logged = await page.evaluate(() => (DB.get('debtors') || [])[0]);
assert.equal(logged.events[2].confirmed, false);
assert.ok((await toasts()).some((m) => /Logged — confirm it on the dashboard/.test(m)));
assert.equal(serverView(logged, Date.now()).events.filter((e) => e.kind === KINDS.B_REPAYMENT).length, 1, 'no text for money nobody has confirmed');

/* confirming it from the row says a text is queued, and then the balance in that text is the new one */
await page.waitForSelector('[data-db-conf]');
await page.click('[data-db-conf]');
await page.waitForFunction(() => (DB.get('debtors') || [])[0].events[2].confirmed === true);
assert.ok((await toasts()).some((m) => /^Confirmed · a text with the new balance is queued/.test(m)), (await toasts()).join(' | '));
const confirmedAll = await page.evaluate(() => (DB.get('debtors') || [])[0]);
const texts = serverView(confirmedAll, Date.now()).events.filter((e) => e.kind === KINDS.B_REPAYMENT).map((e) => buildMessage(e.kind, { ...e, link: '' }));
assert.equal(texts.length, 2);
assert.match(texts[1], /Repayment LKR 5,000\.00.*Balance LKR 25,000\.00\./, 'the second part payment says what is left after both');
console.log('4. logged then counted ->', texts.join(' / '));

/* ── 5. Send balance: one question, one request, a pause before the next ──── */
await page.waitForSelector('[data-liq-bal]');
await page.click('[data-liq-bal]');
await page.waitForSelector('#mdConfirm.open, #mdConfirm[style*="flex"], #confBtn', { state: 'visible' });
const ask = await page.textContent('#confDet');
assert.match(await page.textContent('#confMsg'), /Text the balance to Nimal Perera\?/);
assert.match(ask, /25,000.*outstanding.*statement/, 'the question names the figure that will be sent: ' + ask);
await page.click('#confBtn');
await page.waitForFunction(() => ((DB.get('debtors') || [])[0].sms_requests || []).length === 1);
const asked = await page.evaluate(() => (DB.get('debtors') || [])[0]);
assert.match(asked.sms_requests[0].id, /^[A-Za-z0-9_-]{4,40}$/);
assert.ok(Math.abs(asked.sms_requests[0].at - Date.now()) < 15000);
assert.deepEqual(Object.keys(asked.sms_requests[0]).sort(), ['at', 'id'], 'the request names no amount and no recipient: the server writes the text from the books');
assert.ok((await toasts()).some((m) => /Balance text queued/.test(m)));
assert.equal(asked.events.length, 3, 'the ledger is untouched');

const bal = serverView(asked, Date.now()).events.find((e) => e.kind === KINDS.B_BALANCE);
assert.ok(bal, 'the server derives the balance text from that request');
const balText = buildMessage(bal.kind, { ...bal, link: 'https://wealthflow-personal.vercel.app/t/AbCdEfGhIjKlMnOp' });
console.log('5. send balance       ->', balText);
assert.match(balText, /^Balance LKR 25,000\.00 as at \d{2} \w{3} \d{4}, ref DEB-[0-9A-F]{6}\. Statement: https:/);
assert.equal(analyzeSms(balText).segments, 1);

await page.click('[data-liq-bal]');                                // refused before any question is asked: the pause is checked first
await page.waitForFunction(() => window.__toasts.some((m) => /sent a moment ago.*again in \d+ min/.test(m)));
assert.equal(await page.isVisible('#confBtn'), false, 'no confirmation is shown for a request that would be refused');
assert.equal(await page.evaluate(() => (DB.get('debtors') || [])[0].sms_requests.length), 1, 'a second tap right away writes nothing, so it cannot spend a second unit');
console.log('   second tap         ->', (await toasts()).slice(-1)[0]);

/* ── 6. a debtor with the texts off: no promise of a text, and no button ─── */
await page.evaluate(() => { const l = DB.get('debtors'); l[0].sms_notifications_enabled = false; DB.set('debtors', l); window.renderLiquidity(); });
assert.equal(await page.locator('[data-liq-bal]').count(), 0);
await page.click('[data-liq-pay="0"]');
await page.waitForSelector('#_ev_amount');
await page.fill('#_ev_amount', '1000');
assert.doesNotMatch(await page.textContent('#_ev_note_hint'), /texted/, 'nothing is promised that will not happen');
await page.click('#_liq_x');
await page.waitForSelector('#_ev_amount', { state: 'detached' });
console.log('6. texts off          -> no button, no promise');

/* ── 7. a further advance says what the balance will be, and is texted too ── */
await page.evaluate(() => { const l = DB.get('debtors'); l[0].sms_notifications_enabled = true; DB.set('debtors', l); window.renderLiquidity(); });
await page.click('[data-liq-top="0"]');
await page.waitForSelector('#_ev_amount');
await page.fill('#_ev_amount', '10000');
assert.match(await after(), /Balance after this advance:.*35,000/);
assert.equal(await page.locator('#_ev_now').count(), 0, 'a further advance is money already handed over: there is nothing to confirm');
await page.click('#_liq_x');
await page.waitForSelector('#_ev_amount', { state: 'detached' });

assert.deepEqual(errors, [], 'no uncaught page errors: ' + errors.join(' | '));
console.log('a debtor who pays in parts is told the balance, on the real page');
await app.close();
