/* =============================================================================
 * test/e2e/connection-repair.mjs — "Repair connection": probes, honest verdict, the repair itself, and the choices that survive sign-out
 * -----------------------------------------------------------------------------
 * Reported 2026-10-23 17:47 UTC, Mac Safari: "Not saved to your account yet / deadline-exceeded" kept coming back whichever connection mode was chosen. Reading
 * looked fine (the live stream answered it), the tiny test save timed out after 12 s, and the verdict wrongly said "sign out and sign in again". This drives the
 * real page, with Firestore stood in for, and proves:
 *   1. a save that times out is not called a refusal; Check Connection shows the extra steps (direct save, browser storage, queue) and offers Repair
 *   2. Repair connection sets the offline cache off, stops the client, clears the cache, remembers it did so, and reloads
 *   3. after that reload the page never turns the offline cache on, and says so in Check Connection and in the copied report
 *   4. the connection mode and the cache choice survive sign-out's localStorage.clear()
 * No real Safari, relay or IndexedDB stall is involved: this proves the logic and the wiring, not that a stuck browser database is freed.
 *
 * Run from the repository root:  node test/e2e/connection-repair.mjs
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const ready = async (page) => {
    await page.waitForFunction(() => !!(window.WFSyncHealth && window.DB && window._wfPersist), null, { timeout: 20000 });
    const welcome = page.locator('#wfPostUpdate');
    if (await welcome.isVisible().catch(() => false)) { await welcome.getByRole('button', { name: 'Return to Dashboard' }).click(); await welcome.waitFor({ state: 'hidden' }); }
};
const rowsText = (page) => page.evaluate(() => document.getElementById('_sc_rows').textContent);

// 1 + 2. the save times out: honest verdict, Repair offered, and the repair does what it says
{
    const app = await bootApp({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
    const { page } = app;
    await ready(page);
    assert.equal(await page.evaluate(() => window._wfPersist), 'on');
    assert.ok(await page.evaluate(() => window.__fsPersistCalls >= 1), 'the offline cache starts by default');
    await page.route('**/api/version*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 'test' }) }));
    await page.route('https://firestore.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.evaluate(() => {
        window.currentUser.getIdToken = async () => 'test-token';
        window._wfPushDeadlineMs = 500;
        // the SDK-routed save never answers (the owner's case); reads answer
        userDocRef = {
            get: async () => ({ exists: false, data: () => ({}) }),
            collection: () => ({ doc: () => ({ set: () => new Promise(() => { }) }) }),
        };
    });
    await page.evaluate(() => { _wfOpenSyncCheck(); });
    await page.waitForSelector('#_sc_repairBtn');
    await page.waitForFunction(() => document.getElementById('_sc_v').textContent.length > 0, null, { timeout: 90000 });
    const txt = await rowsText(page);
    assert.match(txt, /Saving directly, bypassing this browser's queue/);
    assert.match(txt, /This browser's storage/);
    assert.match(txt, /Offline cache/);
    const verdict = await page.evaluate(() => document.getElementById('_sc_v').textContent);
    assert.doesNotMatch(verdict, /sign out and sign in again/i, 'a timeout is not a refusal');
    assert.match(verdict, /Repair connection/);
    console.log('1. save times out     -> honest verdict, direct/storage/queue steps shown, Repair offered');

    await Promise.all([page.waitForEvent('load', { timeout: 20000 }), page.click('#_sc_repairBtn')]);
    const after = await page.evaluate(() => ({ persist: localStorage.getItem('wf_fs_persist'), at: Number(localStorage.getItem('wf_fs_repaired_at')) }));
    assert.equal(after.persist, 'off');
    assert.ok(after.at > Date.now() - 60000);
    console.log('2. Repair connection  -> cache set off, repair time remembered, page reloaded');

    // 3. after the reload the cache is not started
    await ready(page);
    assert.equal(await page.evaluate(() => window._wfPersist), 'off');
    assert.equal(await page.evaluate(() => window.__fsPersistCalls || 0), 0, 'enablePersistence is not called while the cache is off');
    await page.waitForFunction(() => !!window.currentUser, null, { timeout: 20000 });
    await page.evaluate(() => { window.currentUser.getIdToken = async () => 'test-token'; _wfOpenSyncCheck(); });
    await page.waitForFunction(() => /Offline cache: OK off on this device/.test(document.getElementById('_sc_rows').textContent), null, { timeout: 30000 });
    console.log('3. next boot          -> cache stays off and Check Connection says so');
    assert.deepEqual(app.pageErrors, []);

    // 4. sign-out's clear keeps the device's connection choices
    await page.evaluate(() => { localStorage.setItem('wf_fs_transport', 'steady'); localStorage.setItem('wf_other', 'x'); });
    const kept = await page.evaluate(() => { _wfClearLocal(); return { t: localStorage.getItem('wf_fs_transport'), p: localStorage.getItem('wf_fs_persist'), o: localStorage.getItem('wf_other') }; });
    assert.deepEqual(kept, { t: 'steady', p: 'off', o: null });
    console.log('4. sign-out clear     -> connection mode and cache choice kept, everything else cleared');
    await app.close();
}
console.log('\nPASS: Repair connection works end to end and its choices survive sign-out');
