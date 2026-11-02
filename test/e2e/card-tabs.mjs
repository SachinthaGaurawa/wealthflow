/** Browser run of the card tabs on CC One-Time and CC Instalments (wealthflow-card-tabs.js), and of the Cards-and-accounts rule behind them (owner, 2026-11-02).
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/card-tabs.mjs [screenshot-dir]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp } from './harness.mjs';

const shots = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const app = await bootApp();
const { page } = app;
await page.waitForFunction(() => !!(window.WFCardTabs && window.WFOwnMoney && window.wfCardRegistry && window.WFRoute), null, { timeout: 20000 });
const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});

await page.evaluate(() => {
    const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    window.wfCardRegistry.set({
        '0276': { type: 'credit_card', bank: 'American Express (AMEX)', name: 'AMEX Platinum', network: 'Amex', last4: '0276' },
        '4408': { type: 'credit_card', bank: 'American Express (AMEX)', name: 'AMEX Gold', network: 'Amex', last4: '4408' },
        '2020': { type: 'credit_card', bank: 'Sampath Bank', name: 'Sampath Visa', network: 'Visa', last4: '2020' },
        '0018': { type: 'bank_account', bank: 'DFCC Bank', name: 'DFCC Savings', network: '', last4: '0018' },
    });
    const c = (id, desc, amount, bank, last4, dayFrom, paid = false) => ({ id, desc, amount, combinedTotal: amount, serviceFee: 0, bank, card_last4: last4, type: 'purchase', date: plus(dayFrom), deadline: plus(dayFrom + 50), paid, createdAt: new Date().toISOString() });
    DB.set('cconetime', [
        c('a1', 'Keells Super Nugegoda', 12450.5, 'American Express (AMEX)', '0276', -12),
        c('a2', 'Cinnamon Grand dinner', 28900, 'American Express (AMEX)', '0276', -30),
        c('a3', 'Daraz order', 7600.25, 'American Express (AMEX)', '0276', -55),
        c('g1', 'Singer Mega home appliance', 64200, 'American Express (AMEX)', '4408', -8),
        c('g2', 'Fuel Ceypetco Kollupitiya', 9800, 'American Express (AMEX)', '4408', -3),
        c('s1', 'PickMe rides', 3150, 'Sampath Bank', '2020', -5),
        c('s2', 'Dialog Axiata bill', 4690, 'Sampath Bank', '2020', -20, true),
    ], true);
    DB.set('ccPayments', [
        { id: 'p1', bank: 'American Express (AMEX)', card_last4: '0276', amount: 10000, date: plus(-6), desc: 'CASH PAYMENT-FINACLE', source: 'statement', statementKey: 'wf-mail/x/items/amex1' },
        { id: 'p2', bank: 'Sampath Bank', card_last4: '2020', amount: 4690, date: plus(-18), desc: 'PAYMENT RECEIVED', source: 'manual' },
    ], true);
    DB.set('ccinstall', [
        { id: 'i1', product: 'MacBook Air M3', bank: 'American Express (AMEX)', card_last4: '0276', buyer: 'Self', total: 420000, rate: 0, duration: 12, monthly: 35000, date: plus(-100), completed: false },
        { id: 'i2', product: 'Daikin inverter AC', bank: 'American Express (AMEX)', card_last4: '4408', buyer: 'Self', total: 288000, rate: 0, duration: 24, monthly: 12000, date: plus(-40), completed: false },
        { id: 'i3', product: 'Samsung Galaxy S25', bank: 'Sampath Bank', card_last4: '2020', buyer: 'Self', total: 240000, rate: 8, duration: 12, monthly: 21000, date: plus(-70), completed: false },
    ], true);
});

const goto = async (name) => { await page.evaluate((n) => { showPage(n); if (n === 'cconetime') { renderCCOT(); } else { renderCCI(); } }, name); await page.waitForTimeout(250); };
const tabs = async (bar) => page.$$eval(`#${bar} [role=tab]`, (els) => els.map((e) => ({ text: e.innerText.replace(/\s+/g, ' ').trim(), on: e.getAttribute('aria-selected') === 'true', tab: e.tabIndex })));
const rows = async (body) => (await page.$$eval(`#${body} tr`, (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean))).filter((r) => !/^Completed /.test(r));
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// ── CC One-Time ───────────────────────────────────────────────────────────────
await goto('cconetime');
let t = await tabs('ccotFilterBar');
console.log('CC One-Time tabs:', JSON.stringify(t.map((x) => x.text)));
assert.equal(t.length, 4, '"All cards" and one tab for each of the three cards (two AMEX cards are two tabs)');
assert.ok(t[0].on && t[0].tab === 0 && t.slice(1).every((x) => x.tab === -1), 'All cards is chosen and is the one stop in the tab order');
assert.ok(t.some((x) => /American Express \(AMEX\).*••0276/.test(x.text)) && t.some((x) => /••4408/.test(x.text)) && t.some((x) => /Sampath Bank.*••2020/.test(x.text)));
assert.equal((await rows('ccotBody')).length, 7, 'all seven charges together');

// pick the AMEX ••0276 tab
await page.click('#ccotFilterBar [role=tab]:has-text("••0276")');
await page.waitForTimeout(150);
assert.equal((await rows('ccotBody')).length, 3, 'only that card\'s three charges');
t = await tabs('ccotFilterBar');
assert.ok(t.find((x) => /••0276/.test(x.text)).on, 'the chosen tab is selected');
const panel = await page.$eval('#ccotReconcilePanel', (e) => e.innerText.replace(/\s+/g, ' '));
assert.match(panel, /CASH PAYMENT-FINACLE/); assert.doesNotMatch(panel, /PAYMENT RECEIVED/, 'the payments panel shows this card\'s payments only');

// keyboard: arrow moves to the next tab and focus follows
await page.focus('#ccotFilterBar [role=tab][aria-selected=true]');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(250);
t = await tabs('ccotFilterBar');
const focused = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-card-tab'));
assert.ok(t.filter((x) => x.on).length === 1 && focused, 'one tab chosen, and the keyboard focus is on a tab');
await page.keyboard.press('Home'); await page.waitForTimeout(200);
assert.equal((await rows('ccotBody')).length, 7, 'Home goes back to All cards');

// a payment recorded under a tab is filed on that card
await page.click('#ccotFilterBar [role=tab]:has-text("••2020")'); await page.waitForTimeout(150);
await page.evaluate(() => openCCPaymentModal());
await page.fill('#_ccpay_amt', '1,000'); await page.click('#_ccp_save'); await page.waitForTimeout(200);
const filed = await page.evaluate(() => DB.get('ccPayments').filter((p) => p.amount === 1000).map((p) => ({ bank: p.bank, last4: p.card_last4 })));
assert.deepEqual(filed, [{ bank: 'Sampath Bank', last4: '2020' }]);
await page.click('#ccotFilterBar [role=tab]:has-text("All cards")'); await page.waitForTimeout(150);

// ── CC Instalments ────────────────────────────────────────────────────────────
await goto('ccinstall');
t = await tabs('cciFilterBar');
console.log('CC Instalments tabs:', JSON.stringify(t.map((x) => x.text)));
assert.equal(t.length, 4);
assert.match(t.find((x) => /••4408/.test(x.text)).text, /Monthly\s*LKR\s*12,000/);
assert.equal((await rows('cciBody')).length, 3);
await page.click('#cciFilterBar [role=tab]:has-text("••0276")'); await page.waitForTimeout(150);
const plans = await rows('cciBody');
assert.equal(plans.length, 1); assert.match(plans[0], /MacBook Air M3/);
assert.match(await page.$eval('#cciStats', (e) => e.innerText.replace(/\s+/g, ' ')), /Active Plans\s*1/);
await page.click('#cciFilterBar [role=tab]:has-text("All cards")'); await page.waitForTimeout(150);

// ── one card: no tabs, the screen as it was ───────────────────────────────────
await page.evaluate(() => { DB.set('cconetime', DB.get('cconetime').filter((x) => x.card_last4 === '0276'), true); DB.set('ccinstall', DB.get('ccinstall').filter((x) => x.card_last4 === '0276'), true); });
await goto('cconetime');
assert.equal(await page.$eval('#ccotFilterBar', (e) => getComputedStyle(e).display), 'none', 'a single card needs no tabs');
await goto('ccinstall');
assert.equal(await page.$eval('#cciFilterBar', (e) => getComputedStyle(e).display), 'none');

// ── the owner's rule: a bank line that names one of the registered cards ─────
const rule = await page.evaluate(() => ({
    card: window.WFRoute.ownCardNamed('Outward Ceft Transfer 376657Xxxxx0276'),
    account: window.WFRoute.ownCardNamed('Outward Ceft Transfer 435555Xxxxx0018'),
    stranger: window.WFRoute.ownCardNamed('Outward Ceft Transfer 411111Xxxxx9999'),
    held: window.WFRoute.routeTransaction({ description: 'Outward Ceft Transfer 411111Xxxxx9999', amount: 5000, direction: 'debit' }, 'bank_account'),
    pay: window.WFRoute.routeTransaction({ description: 'Outward Ceft Transfer 376657Xxxxx0276', amount: 5000, direction: 'debit' }, 'bank_account'),
    shape: window.WFMerchants.classify('Outward Ceft Transfer 376657Xxxxx0276', 'debit').goesTo,
}));
console.log('rule:', JSON.stringify({ card: rule.card, account: rule.account, stranger: rule.stranger, held: rule.held.tab + '/' + rule.held.needsReview, pay: rule.pay.tab, shape: rule.shape }));
assert.equal(rule.card && rule.card.last4, '0276'); assert.equal(rule.account, null, 'a number Cards and accounts calls a bank account is not a card'); assert.equal(rule.stranger, null);
assert.equal(rule.held.tab, 'expenses'); assert.equal(rule.held.needsReview, true, 'a card-shaped number nobody registered is held for a look, never a card payment');
assert.equal(rule.pay.tab, 'skip'); assert.notEqual(rule.shape, 'cc_payment', 'the shape of a number alone no longer files a card payment');

// ── screenshots: two cards of one bank and a third, both screens, phone to desktop, dark and light ──
if (shots) {
    await page.evaluate(() => {
        const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
        const c = (id, desc, amount, bank, last4, dayFrom, paid = false) => ({ id, desc, amount, combinedTotal: amount, serviceFee: 0, bank, card_last4: last4, type: 'purchase', date: plus(dayFrom), deadline: plus(dayFrom + 50), paid, createdAt: new Date().toISOString() });
        DB.set('cconetime', [
            c('a1', 'Keells Super Nugegoda', 12450.5, 'American Express (AMEX)', '0276', -12), c('a2', 'Cinnamon Grand dinner', 28900, 'American Express (AMEX)', '0276', -30), c('a3', 'Daraz order', 7600.25, 'American Express (AMEX)', '0276', -55),
            c('g1', 'Singer Mega home appliance', 64200, 'American Express (AMEX)', '4408', -8), c('g2', 'Fuel Ceypetco Kollupitiya', 9800, 'American Express (AMEX)', '4408', -3),
            c('s1', 'PickMe rides', 3150, 'Sampath Bank', '2020', -5), c('s2', 'Dialog Axiata bill', 4690, 'Sampath Bank', '2020', -20, true),
        ], true);
        DB.set('ccinstall', [
            { id: 'i1', product: 'MacBook Air M3', bank: 'American Express (AMEX)', card_last4: '0276', buyer: 'Self', total: 420000, rate: 0, duration: 12, monthly: 35000, date: plus(-100), completed: false },
            { id: 'i2', product: 'Daikin inverter AC', bank: 'American Express (AMEX)', card_last4: '4408', buyer: 'Self', total: 288000, rate: 0, duration: 24, monthly: 12000, date: plus(-40), completed: false },
            { id: 'i3', product: 'Samsung Galaxy S25', bank: 'Sampath Bank', card_last4: '2020', buyer: 'Self', total: 240000, rate: 8, duration: 12, monthly: 21000, date: plus(-70), completed: false },
        ], true);
    });
    for (const theme of ['dark', 'light']) {
        await page.evaluate((th) => { document.documentElement.setAttribute('data-theme', th); }, theme);
        for (const width of [390, 820, 1024, 1280, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            for (const [name, bar] of [['cconetime', 'ccotFilterBar'], ['ccinstall', 'cciFilterBar']]) {
                await goto(name);
                if (name === 'cconetime') await page.click('#ccotFilterBar [role=tab]:has-text("••0276")'); else await page.click('#cciFilterBar [role=tab]:has-text("••4408")');
                await page.waitForTimeout(250);
                // the chosen card's tab must be inside the visible row, also when the row scrolls sideways on a phone
                const inView = await page.evaluate((id) => { const row = document.querySelector('#' + id + ' .wf-ctabs'), on = row && row.querySelector('.wf-ctab.is-on'); if (!row || !on) return false; const r = row.getBoundingClientRect(), t = on.getBoundingClientRect(); return t.left >= r.left - 1 && t.right <= r.right + 1; }, bar);
                assert.ok(inView, `the chosen card's tab is in view at ${width}px (${name}, ${theme})`);
                assert.ok((await overflow()) <= 1, `no sideways page scroll at ${width}px (${name}, ${theme}): ${await overflow()}`);
                await page.screenshot({ path: path.join(shots, `${name}-${theme}-${width}.png`) });
            }
        }
    }
}

const errors = app.pageErrors.filter((e) => !/Chart|cdn|fetch/i.test(e));
console.log('page errors:', errors.slice(0, 3));
assert.deepEqual(errors, []);
await app.close();
console.log('OK: one tab per card on CC One-Time and CC Instalments, scoped payments, keyboard, one card = no tabs, and the Cards-and-accounts rule on the real page');
