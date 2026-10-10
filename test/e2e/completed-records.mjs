/** Browser regression for the "completed records are permanent" rule: every list keeps finished records on screen in
 * their own Completed section, and the Delete button on a finished record explains why it is kept instead of deleting.
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/completed-records.mjs
 */
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});

const books = SEED();
const iso = (d) => d.toISOString().slice(0, 10);
const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
books.income.push(
    { id: 'invEnded', name: 'Ended FD', company: 'BOC', amount: 500000, rate: 10, start: '2024-01-01', end: '2025-01-01', freq: 'monthly', day: '2024-01-01', monthly: 4166, notes: '', duration: 12 },
    { id: 'invClosed', name: 'Settled lease', company: 'Nimal', amount: 800000, rate: 12, start: '2025-01-01', end: '2027-01-01', freq: 'monthly', day: '2025-01-01', monthly: 8000, notes: '', duration: 24, closedAt: Date.now() - 86400000, closedEndWas: '2027-01-01' },
    // a record with no dates at all must not stop the rest of the page drawing
    { id: 'invBroken', name: 'Half-filled record', amount: 1, monthly: 0 },
);
books.loans.push({ id: 'LDone', name: 'Old personal loan', bank: 'HNB', start: '2023-01-01', duration: 12, monthly: 10000, amount: 120000, rate: 10, paymentMethod: 'emi', payments: [], skipped: [] });
books.ccinstall.push({ id: 'CDone', product: 'Old fridge', bank: 'HNB', total: 90000, rate: 0, duration: 6, monthly: 15000, date: ago(400), completed: true });
books.debtors = [
    { id: 'DOpen', name: 'Open Debtor', events: [{ id: 'e1', kind: 'lent', amount: 1000, date: ago(30) }] },
    { id: 'DSettled', name: 'Settled Debtor', events: [{ id: 'e2', kind: 'lent', amount: 1000, date: ago(60) }, { id: 'e3', kind: 'repayment', amount: 1000, date: ago(10) }] },
];
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, books);
// a charge counts as paid only when a card payment covers it, so record the payment that settles K3
await page.evaluate(() => { const k = DB.get('cconetime').find((x) => x.id === 'K3'); addCCPayment({ bank: k.bank, amount: k.amount, date: k.date, desc: 'Repayment', source: 'manual' }); reconcileCC(); });
await page.setViewportSize({ width: 1440, height: 900 });

const go = async (name) => {
    await page.evaluate((n) => showPage(n, [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'" + n + "'"))), name);
    await page.waitForTimeout(700);
};
const visible = (sel) => page.evaluate((s) => [...document.querySelectorAll(s)].some((e) => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden'), sel);
const text = (sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
const count = (key) => page.evaluate((k) => (DB.get(k) || []).length, key);

// ── The rule itself ──────────────────────────────────────────────────────────
const rule = await page.evaluate(() => ({
    inv: [_wfIsDone('investment', { end: '2020-01-01' }), _wfIsDone('investment', { closedAt: 5 }), _wfIsDone('investment', { end: '2999-01-01' }), _wfIsDone('investment', { end: '' })],
    cci: [_wfIsDone('ccinstall', { completed: true }), _wfIsDone('ccinstall', {})],
    cheque: [_wfIsDone('cheque', { status: 'cleared' }), _wfIsDone('cheque', { status: 'pending' }), _wfIsDone('cheque', { status: 'bounced' })],
    ccot: [_wfIsDone('ccot', { paid: true }), _wfIsDone('ccot', { paid: false })],
    target: [_wfIsDone('target', { amount: 100, savings: [{ amount: 100 }] }), _wfIsDone('target', { amount: 100, savings: [{ amount: 50 }] })],
    nothing: _wfIsDone('investment', null),
}));
check(JSON.stringify(rule.inv) === '[true,true,false,false]', `investment rule: ${JSON.stringify(rule.inv)}`);
check(JSON.stringify(rule.cci) === '[true,false]', `instalment rule: ${JSON.stringify(rule.cci)}`);
check(JSON.stringify(rule.cheque) === '[true,false,false]', `cheque rule (only cleared is complete): ${JSON.stringify(rule.cheque)}`);
check(JSON.stringify(rule.ccot) === '[true,false]', `card payment rule: ${JSON.stringify(rule.ccot)}`);
check(JSON.stringify(rule.target) === '[true,false]', `target rule: ${JSON.stringify(rule.target)}`);
check(rule.nothing === false, 'a missing record is not "done"');

// ── Investments: Completed section always on screen, no Show/Hide, a broken record cannot blank it ──
await go('income');
const inv = await page.evaluate(() => ({
    label: (document.querySelector('#incomeList .wf-done-label') || {}).textContent || '',
    wrap: !!document.getElementById('endedIncomeWrap'),
    wrapVisible: !!document.getElementById('endedIncomeWrap') && document.getElementById('endedIncomeWrap').getBoundingClientRect().height > 0,
    toggle: !!document.querySelector('#incomeList button[onclick*="toggleEnded"]'),
    cards: document.querySelectorAll('#endedIncomeWrap .inc-card').length,
    active: document.querySelectorAll('#incomeList .inc-card:not(.income-archive-card)').length,
}));
check(/Completed investments \(\d+\)/.test(inv.label) && /kept for your records/.test(inv.label), `Investments needs a Completed section header, got ${JSON.stringify(inv.label)}`);
check(inv.wrap && inv.wrapVisible, 'completed investments must be on screen');
check(!inv.toggle, 'there must be no Show/Hide button for completed investments');
check(inv.cards >= 2, `both the ended and the settled investment should be listed, found ${inv.cards}`);
check(inv.active >= 3, `the active investments should still be listed, found ${inv.active}`);
const html = await page.evaluate(() => document.getElementById('incomeList').textContent);
check(/Ended FD/.test(html) && /Settled lease/.test(html), 'completed investments should be listed by name');

// ── Delete is refused on a finished record, allowed on an open one ──
const before = await page.evaluate(() => ({
    income: DB.get('income').length, loans: DB.get('loans').length, ccinstall: DB.get('ccinstall').length, cheques: DB.get('cheques').length,
    cconetime: DB.get('cconetime').length, debtors: DB.get('debtors').length,
}));
await page.evaluate(() => { deleteIncome('invEnded'); deleteIncome('invClosed'); deleteLoan('LDone'); deleteCCI('CDone'); deleteCheque('Q3'); deleteCCOT('K3'); _deleteDebtor(DB.get('debtors').find((d) => d.id === 'DSettled')); });
await page.waitForTimeout(300);
check(!(await visible('.confirm-overlay, #wfConfirm, .wf-confirm')), 'no "are you sure" dialog should open for a finished record');
const after = await page.evaluate(() => ({
    income: DB.get('income').length, loans: DB.get('loans').length, ccinstall: DB.get('ccinstall').length, cheques: DB.get('cheques').length,
    cconetime: DB.get('cconetime').length, debtors: DB.get('debtors').length,
}));
check(JSON.stringify(before) === JSON.stringify(after), `finished records must survive Delete: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
await page.evaluate(() => deleteIncome('inv2'));
await page.waitForTimeout(300);
check(await page.evaluate(() => /Delete Income Source\?/.test(document.body.textContent)), 'an open investment still asks before deleting');
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Delete/.test(x.textContent) && x.className.includes('btn-danger')); if (b) b.click(); });
await page.waitForTimeout(300);
check((await count('income')) === before.income - 1, 'an open investment can still be deleted');

// ── Other tabs: Completed section header, finished record still listed ──
await go('loans');
check(/Completed loans \(\d+\)/.test(await text('#loansList')) && /Old personal loan/.test(await text('#loansList')), 'Loans: finished loan listed under a Completed header');
await go('ccinstall');
check(/Completed instalments \(\d+\)/.test(await text('#cciBody')) && /Old fridge/.test(await text('#cciBody')), 'Instalments: completed plan listed under a Completed header');
await go('cconetime');
check(/Completed card payments \(\d+\)/.test(await text('#ccotBody')), 'Card payments: paid charges listed under a Completed header');
await go('cheques');
check(/Completed cheques \(\d+\)/.test(await text('#chequeBody')) && /004377/.test(await text('#chequeBody')), 'Cheques: cleared cheque listed under a Completed header');
const order = await page.evaluate(() => { const r = [...document.querySelectorAll('#chequeBody tr')].map((x) => x.className.includes('wf-done-sep') ? 'SEP' : x.className.includes('done-row') ? 'done' : 'open'); return r.join(','); });
check(/^(open,)+SEP,(done,?)+$/.test(order), `Cheques: open ones first, then the Completed header, then finished ones: ${order}`);
await go('liquidity');
await page.evaluate(() => setLiquidityTab('debt'));
await page.waitForTimeout(500);
check(/Settled Debtor/.test(await text('#page-liquidity')) && /SETTLED/.test(await text('#page-liquidity')), 'Debtors: settled debtor still listed');

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log('ok: completed records verified (rule, Investments section, Delete refused on finished records, Completed sections on every tab)');
