/* =============================================================================
 * test/e2e/own-money.mjs — the owner's July cash advance (2026-10-04), asked of the real page
 * -----------------------------------------------------------------------------
 * "Cash advance cr 376657******0276" — cash drawn on the owner's AMEX ••0276, arriving in the DFCC account — was filed as +LKR 100,000 Income · Other. The owner's Cards & Accounts registry knows ••0276 is an AMEX
 * credit card; neither door asked it. wealthflow-own-money.js is the one rule both ask. This boots the app in Chromium, puts the card in the owner's registry through the app's own wfCardRegistry, and asks the page's
 * real router (wealthflow-route.js + wealthflow-merchants.js, with the module loaded by the real <script type="module">) where each row of a bank statement goes — then does what the owner does to a statement row in the
 * Expenses list (opens it, saves another category) and checks the manual upload's merchant memory has learned it.
 *
 * Run from the repository root:  node test/e2e/own-money.mjs
 * No real account, mailbox or bank data is used.
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const app = await bootApp();
const { page } = app;
await page.waitForFunction(() => !!(window.WFOwnMoney && window.WFRoute && window.WFMerchants && window.wfCardRegistry && window.WFStatementRouter), null, { timeout: 20000 });
console.log('page: WFOwnMoney, WFRoute, WFMerchants, wfCardRegistry and WFStatementRouter are loaded');

/* the owner's Cards & Accounts: the AMEX ••0276 and the HNB account ••1861 */
await page.evaluate(() => window.wfCardRegistry.set({
    '0276': { type: 'credit_card', bank: 'AMEX', name: 'AMEX Card', network: 'Amex', last4: '0276' },
    '1861': { type: 'bank_account', bank: 'HNB', name: 'HNB', network: '', last4: '1861' },
}));

const where = (description, direction) => page.evaluate(([d, dir]) => {
    const routed = window.WFRoute.routeTransaction({ description: d, amount: 100000, direction: dir }, 'bank_account');
    let dest = routed.tab;
    const refined = window.WFMerchants.refine(d, dir, { tab: dest, category: routed.category });
    if (refined) dest = refined.tab;
    return { dest, why: routed.reason, own: routed.ownMoney || '' };
}, [description, direction]);

const cash = await where('Cash advance cr 376657******0276', 'credit');
console.log('1. cash advance      ->', JSON.stringify(cash));
assert.equal(cash.dest, 'skip', 'cash drawn on the owner\'s AMEX is not income');
assert.equal(cash.own, 'card-cash-advance-in');

const inward = await where('Inward Ceft Transfer 376657Xxxxx0276', 'credit');
console.log('2. inward from card  ->', JSON.stringify(inward));
assert.equal(inward.dest, 'skip');

const unknown = await where('Inward Ceft Transfer 411111******9999', 'credit');
console.log('3. unregistered card ->', JSON.stringify(unknown));
assert.equal(unknown.dest, 'income', 'a card the owner does not hold is not claimed');

const salary = await where('Salary Credit', 'credit');
const refund = await where('Cash advance reversal 376657******0276', 'credit');
console.log('4. salary / reversal ->', salary.dest, '/', refund.dest);
assert.equal(salary.dest, 'income');
assert.equal(refund.dest, 'income', 'a reversal reduces an expense already in the books');

const pay = await where('Outward Ceft Transfer 376657Xxxxx0276', 'debit');
console.log('5. paying the card   ->', pay.dest);
assert.equal(pay.dest, 'cc_payment', 'a payment to the owner\'s own card is still filed as a Card Payment');

// what the owner does in the Expenses list: open a statement row and save it under another category
const learned = await page.evaluate(() => {
    DB.set('expenses', [{ id: 'e1', desc: 'POS Transaction KEELLS SUPER NUGEGODA', cat: 'Food & Groceries', amount: 1500, month: '2026-07', recurring: false, recurringType: '0', notes: '', completed: true, source: 'statement', statementKey: 'wf-mail/x/items/a', statementRow: 3, bank: 'DFCC Bank' }]);
    window.editExpense('e1');
    document.getElementById('e_cat').value = 'Dining';
    window.saveExpense();
    const record = DB.get('expenses').find(r => r.id === 'e1');
    const hit = window.WFMerchants.classify('KEELLS SUPER COLOMBO 03 4412 LK', 'debit');
    return { record: { cat: record.cat, source: record.source, statementKey: record.statementKey || '' }, hit: { category: hit.category, matched: hit.matched } };
});
console.log('6. owner correction  ->', JSON.stringify(learned));
assert.equal(learned.record.cat, 'Dining');
assert.equal(learned.record.source, 'statement');
assert.equal(learned.record.statementKey, '', 'the editor drops the statement\'s provenance: that is how the email worker knows it was corrected');
assert.equal(learned.hit.category, 'Dining', 'the manual upload now files this merchant where the owner put it');
assert.match(learned.hit.matched, /^learned:/);

console.log('page errors:', app.pageErrors.filter(e => !/Chart|cdn|fetch/i.test(e)).slice(0, 3));
await app.close();
console.log('OK: the owner\'s own card is the owner\'s own money on the real page, and a correction made in the Expenses list is remembered by the manual upload');
