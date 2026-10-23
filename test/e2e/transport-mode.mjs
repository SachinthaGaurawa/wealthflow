/* =============================================================================
 * test/e2e/transport-mode.mjs — the connection mode (steady / fast), decided before Firestore is first used
 * -----------------------------------------------------------------------------
 * Reported 2026-10-23: with iCloud Private Relay on, Check Connection showed "Reading your account did not answer in 12 seconds" and saving failed with
 * deadline-exceeded, while sign-in and the WealthFlow server answered. Firestore's default stream is what such networks hold up; the steady mode uses plain
 * request-and-answer calls. This drives the real page (with the Firestore stand-in recording the settings it is given):
 *   1. Safari's user agent  -> steady, applied with auto-detect off (the SDK refuses both together)
 *   2. Chrome's user agent  -> fast, no settings given (the SDK default stays)
 *   3. a saved choice of steady beats the browser; Check Connection shows the mode and its switch, and the switch saves the other choice
 * No real network, account or relay is involved: this proves the choice and the settings handed to the SDK, not how a relay behaves.
 *
 * Run from the repository root:  node test/e2e/transport-mode.mjs
 * ===========================================================================*/
import assert from 'node:assert/strict';
import { bootApp } from './harness.mjs';

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const state = (page) => page.evaluate(() => ({ t: window._wfTransport, settings: window.__fsSettings || [] }));
const ready = async (page) => {
    await page.waitForFunction(() => !!(window.WFSyncHealth && window.DB && window._wfTransport), null, { timeout: 20000 });
    const welcome = page.locator('#wfPostUpdate');
    if (await welcome.isVisible().catch(() => false)) { await welcome.getByRole('button', { name: 'Return to Dashboard' }).click(); await welcome.waitFor({ state: 'hidden' }); }
};

// 1. Safari: steady, with the exact settings the SDK needs
{
    const app = await bootApp({ userAgent: SAFARI });
    await ready(app.page);
    const r = await state(app.page);
    assert.deepEqual(r.t, { steady: true, why: 'safari' });
    assert.equal(r.settings.length, 1, 'Firestore was given its settings once');
    assert.deepEqual(r.settings[0], { experimentalForceLongPolling: true, experimentalAutoDetectLongPolling: false, merge: true });
    assert.deepEqual(app.pageErrors, []);
    console.log('1. Safari             -> steady, settings', JSON.stringify(r.settings[0]));
    await app.close();
}

// 2. Chrome: fast, the SDK default is left alone
{
    const app = await bootApp({ userAgent: CHROME });
    await ready(app.page);
    const r = await state(app.page);
    assert.deepEqual(r.t, { steady: false, why: 'default' });
    assert.equal(r.settings.length, 0, 'nothing was changed in the SDK');
    console.log('2. Chrome             -> fast, SDK default untouched');
    await app.close();
}

// 3. a saved choice wins; Check Connection shows the mode and the switch saves the other one
{
    const app = await bootApp({ userAgent: CHROME, initScript: () => { try { if (!localStorage.getItem('wf_fs_transport')) localStorage.setItem('wf_fs_transport', 'steady'); } catch (_) { } } });
    const { page } = app;
    await ready(page);
    const r = await state(page);
    assert.deepEqual(r.t, { steady: true, why: 'chosen' });
    assert.equal(r.settings.length, 1);
    await page.route('**/api/version*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 'test' }) }));
    await page.route('https://firestore.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
    await page.evaluate(() => { window.currentUser.getIdToken = async () => 'test-token'; _wfOpenSyncCheck(); });
    await page.waitForSelector('#_sc_modeBtn');
    await page.waitForFunction(() => /Connection mode: OK steady \(chosen on this device\)/.test(document.getElementById('_sc_rows').textContent));
    assert.match(await page.textContent('#_sc_modeBtn'), /Use the fast connection mode/);
    // pressing it saves "fast" and reloads; the stored value is what matters, the reload is the page's own
    await Promise.all([page.waitForEvent('load', { timeout: 15000 }), page.click('#_sc_modeBtn')]);
    assert.equal(await page.evaluate(() => localStorage.getItem('wf_fs_transport')), 'fast');
    console.log('3. saved choice       -> steady beats the browser; the switch saves "fast"');
    assert.deepEqual(app.pageErrors, []);
    await app.close();
}
console.log('\nPASS: the connection mode is chosen before Firestore is used, and can be switched');
