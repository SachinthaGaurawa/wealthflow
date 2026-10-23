/* The live listener must not die quietly. Reported 2026-10-23: "if I turn an option ON on the phone it must be ON on every device, OFF on the laptop it
 * must be OFF everywhere, in realtime". Real Chromium, two "devices" on one stateful cloud document (firebase-cloud.mjs). Run from the repository root:
 *   node test/e2e/live-sync.mjs
 *
 *   1. a switch flipped on the phone reaches the laptop within seconds, and the laptop's flip back reaches the phone (ON, OFF, ON in a row)
 *   2. a listener the server ends with an error starts again on its own, and the next change still arrives
 *   3. a listener that stays open but hears nothing is caught by the periodic read, which also starts the listener again
 *   4. a device that comes back to the foreground reads the account at once
 *   5. Check Connection reports the live listener
 *   6. no page errors
 */
import { bootDevices, settingsOf } from './devices.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
const results = [];
const check = async (name, fn) => {
    try { const r = await fn(); results.push({ name, ok: r === true || (r && r.ok === true), detail: (r && r.detail) || '' }); }
    catch (e) { results.push({ name, ok: false, detail: 'threw: ' + String(e.message).slice(0, 240) }); }
};
const toggle = (page, key, value) => page.evaluate(([k, v]) => toggleSetting(k, v), [key, value]);
const has = (key, value) => async (page) => (await settingsOf(page))[key] === value;

const w = await bootDevices(['phone', 'laptop']);
const { phone, laptop } = w.devices;
for (const d of [phone, laptop]) {
    const note = d.page.locator('#wfPostUpdate');
    if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
    await d.page.route('**/api/version*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: 'abc123', version: '7.69.35' }) }));
    await d.page.route('https://firestore.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
    await d.page.evaluate(() => { currentUser.getIdToken = async () => 'test-token'; });
}

try {
    await check('1. ON, OFF, ON in a row reaches the other device each time, within seconds', async () => {
        const trail = [];
        let ok = true;
        for (const [who, from, to, value] of [['phone', phone, laptop, false], ['laptop', laptop, phone, true], ['phone', phone, laptop, false]]) {
            const t0 = Date.now();
            await toggle(from.page, 'showSavingsRate', value);
            const got = await waitFor(() => has('showSavingsRate', value)(to.page), 6000);
            trail.push(`${who}->${value}:${got ? (Date.now() - t0) + 'ms' : 'MISSED'}`);
            ok = ok && got;
        }
        return { ok, detail: trail.join(' ') };
    });

    await check('2. a listener ended by the server starts again by itself and the next change still arrives', async () => {
        const before = await laptop.page.evaluate(() => window._wfLive.errors);
        const broken = await laptop.page.evaluate(() => window.__cloudBreakListeners('unavailable'));
        const gone = await laptop.page.evaluate(() => window.__cloudListenerCount());
        const back = await waitFor(() => laptop.page.evaluate(() => window.__cloudListenerCount() >= 1), 8000);
        await toggle(phone.page, 'haptics', false);
        const got = await waitFor(() => has('haptics', false)(laptop.page), 8000);
        const st = await laptop.page.evaluate(() => ({ errors: window._wfLive.errors, lastErr: window._wfLive.lastErr }));
        return { ok: broken >= 1 && gone === 0 && back && got && st.errors === before + 1, detail: `broken=${broken} listenersAfterBreak=${gone} listeningAgain=${back} nextChangeArrived=${got} errors=${st.errors}` };
    });

    await check('3. a silent stall is caught by the periodic read, which also restarts the listener', async () => {
        await laptop.page.evaluate(() => window.__cloudSilence(true));
        await toggle(phone.page, 'sounds', false);
        await waitFor(() => (w.cloud.doc.settings || {}).sounds === false, 6000);
        await sleep(1500);
        const stillMissing = !(await has('sounds', false)(laptop.page));
        const missedBefore = await laptop.page.evaluate(() => window._wfLive.missed);
        // the stall lasts until the read finds the gap; the read answers over the same wire the stub keeps working (only snapshots are swallowed)
        const caught = await waitFor(() => has('sounds', false)(laptop.page), 30000);
        const missedAfter = await laptop.page.evaluate(() => window._wfLive.missed);
        await laptop.page.evaluate(() => window.__cloudSilence(false));
        return { ok: stillMissing && caught && missedAfter > missedBefore, detail: `notHeardYet=${stillMissing} caughtByRead=${caught} missed ${missedBefore}->${missedAfter}` };
    });

    await check('4. coming back to the foreground reads the account at once', async () => {
        await laptop.page.evaluate(() => window.__cloudSilence(true));
        await toggle(phone.page, 'notifications', false);
        await waitFor(() => (w.cloud.doc.settings || {}).notifications === false, 6000);
        await laptop.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
        const got = await waitFor(() => has('notifications', false)(laptop.page), 4000);
        await laptop.page.evaluate(() => window.__cloudSilence(false));
        return { ok: got, detail: 'arrived within 4 s of returning: ' + got };
    });

    await check('5. Check Connection reports the live listener', async () => {
        await laptop.page.evaluate(() => _wfOpenSyncCheck());
        const seen = await waitFor(() => laptop.page.evaluate(() => /Live updates from other devices: (OK|failed)/.test((document.getElementById('_sc_rows') || {}).innerText || '')), 15000);
        const rows = await laptop.page.evaluate(() => (document.getElementById('_sc_rows') || {}).innerText || '');
        return { ok: seen && /Live updates from other devices: OK/.test(rows), detail: rows.replace(/\s+/g, ' ').slice(0, 200) };
    });

    await check('6. no page errors on either device', async () => {
        const errs = [...phone.errors, ...laptop.errors].filter((e) => !/ResizeObserver/.test(e));
        return { ok: errs.length === 0, detail: errs.slice(0, 3).join(' | ') };
    });
} finally {
    await w.close();
}

let bad = 0;
for (const r of results) { if (!r.ok) bad++; console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '\n       ' + r.detail : '')); }
console.log(`\n${results.length - bad}/${results.length} passed.`);
process.exit(bad ? 1 : 0);
