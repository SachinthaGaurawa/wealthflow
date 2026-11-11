/** Browser regression: every debtor, open or settled, can be deleted from the Debtors list, with a question first and an Undo after.
 * Reported 2026-11-11: the trash button on a settled debtor (LKR 0.00 lent) did nothing. Real Chromium, stubbed Firebase, invented books.
 * Run from the repository root:  node test/e2e/debtor-delete.mjs
 */
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});

const iso = (d) => d.toISOString().slice(0, 10);
const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const books = SEED();
books.debtors = [
    { id: 'DOpen', name: 'Open Debtor', events: [{ id: 'e1', kind: 'lent', amount: 1000, date: ago(30), confirmed: true }] },
    { id: 'DSettled', name: 'Settled Debtor', events: [{ id: 'e2', kind: 'lent', amount: 1000, date: ago(60), confirmed: true }, { id: 'e3', kind: 'repayment', amount: 1000, date: ago(10), confirmed: true }] },
    // the reported one: nothing lent, nothing repaid, texts on
    { id: 'DMenika', name: 'Menika', phone: '0778787998', sms_notifications_enabled: true, sms_enabled_at: 1, state: 'CLOSED', closedAt: Date.now() - 86400000, events: [] },
    { id: 'DKeep', name: 'Keep Me', events: [{ id: 'e4', kind: 'lent', amount: 500, date: ago(5), confirmed: true }] },
];
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, books);
await page.setViewportSize({ width: 430, height: 900 });
await page.evaluate(() => showPage('liquidity', [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'liquidity'"))));
await page.waitForTimeout(500);
await page.evaluate(() => setLiquidityTab('debt'));
await page.waitForTimeout(500);

const ids = () => page.evaluate(() => (DB.get('debtors') || []).map((d) => d.id).sort());
const tomb = () => page.evaluate(() => { try { return (JSON.parse(localStorage.getItem('wf2__tomb') || '{}').debtors) || {}; } catch (_) { return {}; } });
const rowOf = (name) => page.locator('#liqBody .liq-row', { hasText: name });
const confirmOpen = () => page.evaluate(() => { const m = document.getElementById('mdConfirm'); return !!m && m.classList.contains('open'); });

check(JSON.stringify(await ids()) === '["DKeep","DMenika","DOpen","DSettled"]', 'seed: four debtors');
check(await rowOf('Menika').count() === 1 && /SETTLED/.test(await rowOf('Menika').innerText()), 'Menika is listed as SETTLED');

// 1. the reported case: click the real trash button on the settled, nothing-lent debtor
await rowOf('Menika').locator('[data-liq-ddel]').click();
await page.waitForTimeout(300);
check(await confirmOpen(), 'the trash button on a settled debtor must ask "are you sure" (it used to answer with a toast and do nothing)');
const q = await page.evaluate(() => (document.getElementById('confMsg') || {}).textContent + ' | ' + (document.getElementById('confDet') || {}).textContent);
check(/Delete Menika\?/.test(q) && /repayment history/.test(q) && /stops every text/.test(q), `the question names the debtor and what goes with it: ${q}`);
check(JSON.stringify(await ids()) === '["DKeep","DMenika","DOpen","DSettled"]', 'nothing is deleted before the owner says yes');

// cancel path: nothing changes
await page.evaluate(() => closeModal('mdConfirm'));
await page.waitForTimeout(200);
check((await ids()).length === 4, 'cancelling the question deletes nothing');

// 2. confirm: only Menika goes, the neighbours stay
await rowOf('Menika').locator('[data-liq-ddel]').click();
await page.waitForTimeout(300);
await page.locator('#confBtn').click();
await page.waitForTimeout(500);
check(JSON.stringify(await ids()) === '["DKeep","DOpen","DSettled"]', `only Menika is deleted: ${JSON.stringify(await ids())}`);
check(await rowOf('Menika').count() === 0, 'the Menika row is gone from the screen');
check(await rowOf('Keep Me').count() === 1 && await rowOf('Open Debtor').count() === 1 && await rowOf('Settled Debtor').count() === 1, 'the other three rows are still listed');
const t1 = await tomb();
check(typeof t1.DMenika === 'number' && t1.DMenika > 0, `the deletion is tombstoned so no other device brings it back: ${JSON.stringify(t1)}`);

// 3. the Undo bar brings it back, and wins over the tombstone on every device
check(await page.locator('#wfUndoBar #wfUndoBtn').count() === 1 && /Undo delete/.test(await page.locator('#wfUndoBtn').innerText()), 'an "Undo delete" button is offered after a delete');
await page.locator('#wfUndoBtn').click();
await page.waitForTimeout(400);
check(JSON.stringify(await ids()) === '["DKeep","DMenika","DOpen","DSettled"]', 'Undo restores the debtor');
check(await rowOf('Menika').count() === 1, 'the restored debtor is listed again');
const t2 = await tomb();
check(t2.DMenika == null, `restoring clears the tombstone: ${JSON.stringify(t2)}`);
const merged = await page.evaluate((stale) => {
    // another device still holds Menika's old copy and the deletion's tombstone: after the undo the restored copy must beat both
    const mine = (DB.get('debtors') || []).find((d) => d.id === 'DMenika');
    const out = _wfMergeRecordArray([mine], [Object.assign({}, mine, { _ut: 1 })], { DMenika: stale });
    return out.map((d) => d.id);
}, t1.DMenika);
check(merged.includes('DMenika'), 'the restored record is newer than the tombstone, so a merge keeps it');
const restored = await page.evaluate(() => (DB.get('debtors') || []).find((d) => d.id === 'DMenika'));
check(restored && restored._ut > t1.DMenika, `the restored record carries a new stamp (${restored && restored._ut}) newer than the deletion (${t1.DMenika})`);

// 4. an open debtor and a settled one with history delete the same way
for (const [name, id] of [['Open Debtor', 'DOpen'], ['Settled Debtor', 'DSettled']]) {
    await rowOf(name).locator('[data-liq-ddel]').click();
    await page.waitForTimeout(250);
    check(await confirmOpen(), `${name}: asks first`);
    await page.locator('#confBtn').click();
    await page.waitForTimeout(400);
    check(!(await ids()).includes(id), `${name}: deleted`);
}
check(JSON.stringify(await ids()) === '["DKeep","DMenika"]', `the two untouched debtors remain: ${JSON.stringify(await ids())}`);

// 5. a page reload keeps the deletion (it was written to disk, not only to the screen)
await page.reload();
await page.waitForTimeout(1500);
check(!(await page.evaluate(() => (DB.get('debtors') || []).some((d) => d.id === 'DOpen' || d.id === 'DSettled'))), 'after a reload the deleted debtors are still gone');

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();
if (fail.length) { console.error('FAIL\n - ' + fail.join('\n - ')); process.exit(1); }
console.log('debtor-delete: ok');
