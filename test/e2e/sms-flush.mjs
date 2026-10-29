/* =============================================================================
 * test/e2e/sms-flush.mjs — older entries, a second number that arrives, and a text that does not depend on the page staying open
 * -----------------------------------------------------------------------------
 * The three things the owner reported on 2026-10-29, on the real page in real Chromium:
 *   1. a debtor's older entries cannot be seen (the timeline drew only the newest six): every entry is reachable, the newest first,
 *      and what was opened stays open across a repaint;
 *   2. a second number added to a saved person does not reach the loans that are theirs: it reaches a loan that was never linked,
 *      the confirmation says how many loans the edit will touch, and the debtor's card shows both numbers;
 *   3. a change made and the app closed at once: the changed records are handed to the server in ONE request that does not need the page
 *      (fetch keepalive, a token held in memory), after a moment when the page stays open and straight away when it is hidden or closed.
 *
 * Run from the repository root:  node test/e2e/sms-flush.mjs
 * No real number, account or gateway is used: the server's answer is a stub.
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const app = await bootApp();
const { page } = app;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForFunction(() => !!(window.WFSms && window.WFPeople && window.WFLiquidity && window.DB), null, { timeout: 20000 });
console.log('page: WFSms, WFPeople, WFLiquidity and DB are loaded');

const welcome = page.locator('#wfPostUpdate');
if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Return to Dashboard' }).click();
    await welcome.waitFor({ state: 'hidden' });
}

const NOW = Date.now();
const showDebtors = async (list) => {
    await page.evaluate((l) => { DB.set('debtors', l); window.showPage('liquidity'); window.setLiquidityTab('debt'); }, list);
    await page.waitForSelector('.liq-row');
};

/* ── 1. every entry of a person can be read ───────────────────────────────── */
// Kaushi's Mother as the owner described her: 830,000 lent over time, 580,000 repaid, nothing visible before September.
const events = [
    { id: 'e01', kind: 'lent', amount: 500000, date: '2026-03-02', confirmed: true },
    { id: 'e02', kind: 'repayment', amount: 50000, date: '2026-04-02', confirmed: true },
    { id: 'e03', kind: 'topup', amount: 150000, date: '2026-05-11', confirmed: true },
    { id: 'e04', kind: 'repayment', amount: 100000, date: '2026-06-02', confirmed: true },
    { id: 'e05', kind: 'topup', amount: 180000, date: '2026-07-14', confirmed: true },
    { id: 'e06', kind: 'repayment', amount: 150000, date: '2026-08-03', confirmed: true },
    { id: 'e07', kind: 'repayment', amount: 80000, date: '2026-08-20', confirmed: true },
    { id: 'e08', kind: 'repayment', amount: 100000, date: '2026-09-01', confirmed: true },
    { id: 'e09', kind: 'repayment', amount: 100000, date: '2026-09-17', confirmed: true },
];
const kaushi = (extra = {}) => ({ id: 'dK', name: "Kaushi's Mother", phone: '+94715561957', nic: '', note: '', sms_notifications_enabled: true, sms_enabled_at: NOW - 86400e3 * 200, events, ...extra });
await showDebtors([kaushi()]);
const items = () => page.$$eval('.liq-row .liq-tl-item', (n) => n.map((x) => x.textContent.replace(/\s+/g, ' ').trim()));
const first = await items();
assert.equal(first.length, 6, 'six rows drawn to begin with, newest first');
assert.match(first[0], /2026-09-17/);
assert.ok(!first.some((t) => /2026-03-02/.test(t)), 'the first advance is not among them');
const more = page.locator('.liq-row [data-wf-tl]');
assert.equal(await more.count(), 1, 'and a way to the rest');
assert.match(await more.textContent(), /Show 3 earlier entries/);
assert.equal(await more.getAttribute('aria-expanded'), 'false');
await more.click();
const all = await items();
assert.equal(all.length, 9, 'every entry is there');
assert.match(all[all.length - 1], /2026-03-02/);
assert.match(all[all.length - 1], /lent/);
assert.match(all[all.length - 1], /500,000/, 'the first advance, the oldest row, can be read, edited and undone');
assert.equal(await page.locator('.liq-row [data-wf-tl]').getAttribute('aria-expanded'), 'true');
assert.match(await page.locator('.liq-row [data-wf-tl]').textContent(), /Show fewer/);
const oldest = page.locator('.liq-tl-item', { hasText: '2026-03-02' });
assert.equal(await oldest.locator('[data-db-eedit]').count(), 1, 'an old entry has its Edit button');
assert.equal(await oldest.locator('[data-db-erm]').count(), 1, 'and its Remove button');
// a repaint (any confirmation redraws the list) keeps the rest open
await page.evaluate(() => window.renderLiquidity());
assert.equal((await items()).length, 9, 'what was opened stays open when the list is redrawn');
await page.locator('.liq-row [data-wf-tl]').click();
assert.equal((await items()).length, 6, 'and folds away again');
const summary = await page.textContent('.liq-row .liq-sub');
assert.match(summary, /830,000.* lent/);
assert.match(summary, /580,000.* repaid/);
console.log('1. older entries       -> 6 shown, "Show 3 earlier entries" opens all 9, the 2026-03-02 advance has Edit and Remove, stays open on repaint');

// a person with six entries or fewer sees no extra control
await showDebtors([kaushi({ events: events.slice(0, 4) })]);
assert.equal(await page.locator('.liq-row [data-wf-tl]').count(), 0, 'a short history has nothing to open');
console.log('   short history       -> no control');

// the pawn ledger's payment history had the same cap
await page.evaluate(() => {
    const pays = [];
    for (let i = 1; i <= 8; i += 1) pays.push({ id: 'pp' + i, kind: i % 2 ? 'interest' : 'principal', amount: 1000 * i, date: '2026-0' + Math.min(i, 9) + '-05', confirmed: true });
    DB.set('pawns', [{ id: 'pw1', item: 'Gold chain', pawnDate: '2026-01-02', principal: 100000, rate: 3, interestMode: 'simple', payments: pays }]);
    window.setLiquidityTab('pawn');
});
await page.waitForSelector('.liq-row [data-pw-prm]');
assert.equal((await items()).length, 6, 'a pawn ticket also shows six to begin with');
assert.match(await page.locator('.liq-row [data-wf-tl]').textContent(), /Show 2 earlier entries/);
await page.locator('.liq-row [data-wf-tl]').click();
assert.equal((await items()).length, 8, 'and all eight when asked');
console.log('   pawn ticket         -> 6 shown, "Show 2 earlier entries" opens all 8');
await page.evaluate(() => { DB.set('pawns', []); window.setLiquidityTab('debt'); });

/* ── 2. the card shows where the texts go ─────────────────────────────────── */
await showDebtors([kaushi({ phone2: '+94777654321', phone2_at: NOW })]);
const tels = await page.$$eval('.liq-row a[href^="tel:"]', (a) => a.map((x) => x.getAttribute('href')));
assert.deepEqual(tels, ['tel:+94715561957', 'tel:+94777654321'], 'both numbers are on the card, each one dials');
console.log('2a. the card           -> both numbers shown and dialable');

await page.evaluate((n) => {
    DB.set('income', [{ id: 'iK', name: 'Loan to Kaushi', company: "Kaushi's Mother", amount: 100000, rate: 12, start: '2026-01-05', day: '2026-01-05', freq: 'monthly', monthly: 1000, phone: '+94715561957', phone2: '+94777654321', sms_notifications_enabled: true, sms_enabled_at: n - 1e9, createdAt: new Date().toISOString() }]);
    window.showPage('income');
}, NOW);
await page.waitForSelector('.inc-card');
assert.match(await page.textContent('.inc-card'), /Texts go to .*\+94 71 556 1957.* and .*\+94 77 765 4321/, 'an investment says where its texts go');
console.log('    investment card    -> "Texts go to" both numbers');

/* ── 2b. a second number added to a saved person reaches a loan that was never linked ─ */
await page.evaluate(() => { for (const k of ['debtors', 'income', 'people']) DB.set(k, []); });
await page.evaluate(() => WFPeople.openHub('people'));
await page.waitForSelector('.wfp-hub');
// the owner adds the person to the book
await page.click('.wfp-hub [data-h="add"]');
await page.waitForSelector('#_pp_name');
await page.fill('#_pp_name', "Kaushi's Mother");
await page.fill('#_pp_phone', '071 556 1957');
await page.click('.wfp-hub [data-h="save"]');
await page.waitForFunction(() => DB.get('people').length === 1);
// a loan of theirs that was never linked (made on another phone, or before the book): saved with no link
await page.evaluate((n) => {
    DB.set('debtors', [{ id: 'dU', name: "Kaushi's Mother", phone: '+94715561957', nic: '', events: [{ id: 'u1', kind: 'lent', amount: 830000, date: '2026-03-02', confirmed: true }], sms_notifications_enabled: true, sms_enabled_at: n - 1e9, _ut: n - 86400e3, createdAt: new Date(n - 86400e3).toISOString() }]);
}, NOW);
assert.equal(await page.evaluate(() => DB.get('debtors')[0].personId), undefined, 'the loan really is unlinked');
// the owner adds the second number to the contact
await page.click('.wfp-hub .wfp-card:has-text("Kaushi")');
await page.waitForSelector('#_pp_phone2');
await page.fill('#_pp_phone2', '077 765 4321');
await page.click('.wfp-hub [data-h="save"]');
await page.waitForSelector('.wfp-hub [data-h="savego"]');
assert.match(await page.textContent('.wfp-hub .wfp-warn'), /This also updates 1 loan/, 'the owner is told the loan will be updated, not "nothing else changes"');
await page.click('.wfp-hub [data-h="savego"]');
await page.waitForFunction(() => DB.get('debtors')[0].phone2 === '+94777654321', null, { timeout: 8000 });
const linked = await page.evaluate(() => ({ d: DB.get('debtors')[0], p: DB.get('people')[0] }));
assert.equal(linked.d.personId, linked.p.id, 'the loan is now the person\'s');
assert.equal(linked.d.phone, '+94715561957', 'the first number is untouched');
assert.ok(linked.d.phone2_at > 0, 'the second number is new to the loan, so what happened before is history for it, not news');
await page.evaluate(() => document.querySelectorAll('.wfp-hub, .mo').forEach((m) => { if (!m.id) m.remove(); }));
console.log('2b. second number      -> reaches the unlinked loan, which is now linked; the first number is untouched');

/* ── 3. a change made and the page closed at once ─────────────────────────── */
// a token the page can hold in memory (the stub has none), and a record of every request to the server
const jwt = await page.evaluate(() => { const b = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); return 'h.' + b({ exp: Math.floor(Date.now() / 1000) + 3600 }) + '.s'; });
await page.evaluate((t) => {
    firebase.auth().currentUser.getIdToken = async () => t;
    window.__calls = [];
    const real = window.fetch;
    window.fetch = (url, init) => {
        if (String(url).includes('/api/sms-notify')) {
            window.__calls.push({ url: String(url), keepalive: !!(init && init.keepalive), auth: (init && init.headers && init.headers.Authorization) || '', body: JSON.parse((init && init.body) || '{}'), at: Date.now() });
            if (window.__fail) return Promise.reject(new TypeError('Load failed'));
            return Promise.resolve(new Response(JSON.stringify({ ok: true, summary: { sent: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return real.call(window, url, init);
    };
    // the page has just opened or come back to the front: it takes a fresh token and keeps it
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis || 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
}, jwt);
await page.waitForTimeout(300);
// the account cannot be reached (offline), so the page's own upload cannot finish: the case that used to lose the text
await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
const pending = (id, amount) => ({ id, kind: 'repayment', amount, date: '2026-10-29', confirmed: false, at: Date.now() });
await showDebtors([kaushi({ events: [{ id: 'e0', kind: 'lent', amount: 830000, date: '2026-03-02', confirmed: true }, pending('p1', 100000), pending('p2', 50000)], phone2: '+94777654321', phone2_at: NOW - 86400e3 })]);
await page.evaluate(() => { localStorage.removeItem('wf_sms_sig_e2e-sweep-user'); window.__calls.length = 0; });

// 3a. the owner confirms a repayment and leaves the page open: the changed record goes after a moment, not after the upload and its wait
const t0 = await page.evaluate(() => Date.now());
// (the seeding above is itself a change, handed over a moment after it: this looks for the request that carries the confirmation)
const confirmedP1 = (c) => c.body.action === 'flush' && c.body.records.debtors.some((d) => (d.events || []).some((e) => e.id === 'p1' && e.confirmed === true));
await page.click('[data-db-conf="0|p1"]');
await page.waitForFunction(() => window.__calls.some((c) => c.body.action === 'flush' && c.body.records.debtors.some((d) => (d.events || []).some((e) => e.id === 'p1' && e.confirmed === true))), null, { timeout: 6000 });
const a = await page.evaluate(() => window.__calls.find((c) => c.body.action === 'flush' && c.body.records.debtors.some((d) => (d.events || []).some((e) => e.id === 'p1' && e.confirmed === true))));
assert.ok(a.at - t0 < 1500, 'sent within a moment of the tap (' + (a.at - t0) + ' ms), not after the upload and the pause that follows it');
assert.equal(a.keepalive, true, 'a request the browser finishes without the page');
assert.equal(a.auth, 'Bearer ' + jwt, 'with the token the page already held');
assert.equal(a.body.records.debtors.length, 1);
const sentEvents = a.body.records.debtors[0].events;
assert.equal(sentEvents.find((e) => e.id === 'p1').confirmed, true, 'the record carries the repayment that was just confirmed');
assert.equal(a.body.records.debtors[0].phone2, '+94777654321', 'and the second number, so it is texted too');
assert.equal(a.body.records.debtors[0].name, "Kaushi's Mother");
console.log('3a. page stays open    -> one flush request ' + (a.at - t0) + ' ms after the tap, keepalive, token in the header, record + both numbers');

// 3b. the owner confirms another and the page goes to the background at once: sent in the same breath, without waiting for anything
await page.evaluate(() => { window.__calls.length = 0; });
await page.click('[data-db-conf="0|p2"]');
const hidden = await page.evaluate(() => {
    window.__vis = 'hidden';
    const t = Date.now();
    document.dispatchEvent(new Event('visibilitychange'));
    return { calls: window.__calls.filter((c) => c.body.action === 'flush').map((c) => ({ keepalive: c.keepalive, reason: c.body.reason, ms: c.at - t, ids: c.body.records.debtors.map((d) => d.id), confirmed: c.body.records.debtors.flatMap((d) => d.events).filter((e) => e.id === 'p2').map((e) => e.confirmed) })) };
});
assert.equal(hidden.calls.length, 1, 'the page being hidden sends the change at once');
assert.deepEqual(hidden.calls[0], { keepalive: true, reason: 'hidden', ms: hidden.calls[0].ms, ids: ['dK'], confirmed: [true] });
assert.ok(hidden.calls[0].ms < 50, 'in the same moment (' + hidden.calls[0].ms + ' ms), nothing asynchronous in the way');
console.log('3b. page hidden        -> sent in the same moment (' + hidden.calls[0].ms + ' ms) with the second repayment');

// 3c. a page that closes with nothing new to say sends nothing (the answer to the request above has had time to arrive, as it does on a real phone)
await page.waitForTimeout(400);
await page.evaluate(() => { window.__calls.length = 0; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pagehide')); });
await page.waitForTimeout(200);
assert.equal(await page.evaluate(() => window.__calls.filter((c) => c.body.action === 'flush').length), 0, 'the server has already looked at this state: the same request is not sent again');
console.log('3c. nothing new        -> nothing sent on hide or close');

// 3c2. a debtor deleted at once: the server is told, so it does not text about the copy it still holds
// (the server has looked at the debtor already: the page remembers that, and deleting the last record that texts is still a change it must report)
assert.ok(await page.evaluate(() => localStorage.getItem('wf_sms_sig_e2e-sweep-user')), 'the page remembers the server has looked');
await page.evaluate(() => { window.__vis = 'visible'; window.__calls.length = 0; });
await page.evaluate(() => { DB.set('debtors', []); });
await page.waitForFunction(() => window.__calls.some((c) => c.body.action === 'flush'), null, { timeout: 6000 });
const del = await page.evaluate(() => window.__calls.find((c) => c.body.action === 'flush').body);
assert.ok(del.tombs.debtors.dK > 0, 'the deletion of the debtor travels with the flush');
assert.deepEqual(del.records.debtors, [], 'and carries no record of it');
console.log('3c2. debtor deleted    -> the flush carries its tombstone');

// 3c3. the last record that texts is deleted before the server has ever answered on this device: it still has to be told
await page.evaluate(() => { window.__calls.length = 0; DB.set('debtors', [{ id: 'dQ', name: 'Quick', phone: '+94771234567', sms_notifications_enabled: true, sms_enabled_at: 1, events: [{ id: 'q1', kind: 'lent', amount: 5000, date: '2026-10-29', confirmed: true }] }]); });
await page.waitForFunction(() => window.__calls.some((c) => c.body.action === 'flush' && c.body.records.debtors.some((d) => d.id === 'dQ')), null, { timeout: 6000 });
await page.waitForTimeout(300);
await page.evaluate(() => { localStorage.removeItem('wf_sms_sig_e2e-sweep-user'); window.__calls.length = 0; DB.set('debtors', []); });
await page.waitForFunction(() => window.__calls.some((c) => c.body.action === 'flush'), null, { timeout: 6000 });
const quick = await page.evaluate(() => window.__calls.find((c) => c.body.action === 'flush').body);
assert.ok(quick.tombs.debtors.dQ > 0, 'the deletion reaches the server although it has never answered on this device (the signature is empty and nothing was stored)');
console.log('3c3. last record gone  -> still reported before the server has ever answered');

// 3d. a book that never used texts costs no request at all
await page.evaluate(() => { window.__vis = 'visible'; window.__calls.length = 0; localStorage.removeItem('wf_sms_sig_e2e-sweep-user'); localStorage.removeItem('wf_sms_used_e2e-sweep-user'); });
await page.evaluate(() => { DB.set('debtors', [{ id: 'dN', name: 'Plain', phone: '', events: [{ id: 'n1', kind: 'lent', amount: 1000, date: '2026-10-29', confirmed: true }], _ut: Date.now() }]); window.__vis = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(1800);
// (the page's own timed look at the server, the one it makes after opening, is a nudge and not a flush: only flushes are counted)
assert.equal(await page.evaluate(() => window.__calls.filter((c) => c.body.action === 'flush').length), 0, 'a debtor whose texts were never switched on sends nothing');
console.log('3d. texts never on     -> no request');


// 3e. a request that never got an answer (no network, the app killed) leaves the change owed, and the page hands it over again when it is next in front
await page.evaluate(() => { window.__vis = 'visible'; window.__calls.length = 0; window.__fail = true; localStorage.removeItem('wf_sms_sig_e2e-sweep-user'); });
await page.evaluate(() => { DB.set('debtors', [{ id: 'dR', name: 'Retry', phone: '+94771234567', sms_notifications_enabled: true, sms_enabled_at: 1, events: [{ id: 'r1', kind: 'lent', amount: 5000, date: '2026-10-29', confirmed: true }], _ut: Date.now() }]); });
await page.waitForFunction(() => window.__calls.some((c) => c.body.action === 'flush' && c.body.records.debtors.some((d) => d.id === 'dR')), null, { timeout: 6000 });
await page.waitForTimeout(200);
assert.ok(Number(await page.evaluate(() => localStorage.getItem('wf_sms_outbox_e2e-sweep-user'))) > 0, 'the change is still owed: the request got no answer');
await page.evaluate(() => { window.__fail = false; window.__calls.length = 0; document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForFunction(() => window.__calls.some((c) => c.body.action === 'flush' && c.body.reason === 'outbox' && c.body.records.debtors.some((d) => d.id === 'dR')), null, { timeout: 8000 });
await page.waitForFunction(() => Number(localStorage.getItem('wf_sms_outbox_e2e-sweep-user')) === 0, null, { timeout: 4000 });
console.log('3e. no answer          -> owed, handed over again as the records when the page is next in front, then no longer owed');

assert.deepEqual(errors, [], 'no page error: ' + errors.join(' | '));
await app.close();
console.log('\nsms-flush e2e: all checks passed');
