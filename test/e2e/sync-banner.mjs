/* A change that never reaches the account must be SEEN, and must keep trying on its own. Real Chromium, two "devices" on one stateful cloud document
 * (firebase-cloud.mjs), no real account. Reported 2026-10-23: Settle in full and Confirm on the phone sent no text (the server texts only what is uploaded);
 * the laptop's did. Run from the repository root:  node test/e2e/sync-banner.mjs
 * WF_SYNCBANNER_ARTIFACTS selects the screenshot directory (default /tmp/wealthflow-sync-banner).
 *
 *   1. a device cut off from the cloud shows "Not saved to your account yet" with the reason, Try Again and Check Connection
 *   2. when the connection returns the change uploads WITHOUT another edit, the notice goes, and the other device receives it
 *   3. Check Connection names the first step that fails while cut off, and reports all clear afterwards
 *   4. a sign-in the account rejects is called a sign-in problem
 *   5. a phone that goes to the background right after an edit uploads at once instead of waiting out the debounce
 *   6. no page errors
 */
import fs from 'node:fs/promises';
import { bootDevices } from './devices.mjs';

const artifacts = process.env.WF_SYNCBANNER_ARTIFACTS || '/tmp/wealthflow-sync-banner';
await fs.mkdir(artifacts, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };
const results = [];
const check = async (name, fn) => {
    try { const r = await fn(); results.push({ name, ok: r === true || (r && r.ok === true), detail: (r && r.detail) || '' }); }
    catch (e) { results.push({ name, ok: false, detail: 'threw: ' + String(e.message).slice(0, 240) }); }
};

const w = await bootDevices(['phone', 'laptop']);
const { phone, laptop } = w.devices;
const banner = (page) => page.evaluate(() => {
    const el = document.getElementById('syncBanner');
    if (!el || !el.classList.contains('show')) return null;
    return { text: el.innerText, tone: el.className };
});
const target = (id) => ({ id, name: 'Sync check ' + id, amount: 5000, saved: 0, savings: [], deadline: '2027-01-01' });
// the sandbox has no route to our own API or to Google: answer both, so the connection check has something to test
for (const d of [phone, laptop]) {
    const note = d.page.locator('#wfPostUpdate');           // the "What's new" card the first launch after an update shows
    if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
    await d.page.route('**/api/version*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: 'abc123', version: '7.69.35' }) }));
    await d.page.route('https://firestore.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
    await d.page.evaluate(() => { currentUser.getIdToken = async () => 'test-token'; });
}

try {
    await check('0. the module is loaded and no notice shows while the account has everything', async () => {
        const has = await phone.page.evaluate(() => !!(window.WFSyncHealth && window.WFSyncHealth.createTracker));
        return { ok: has && (await banner(phone.page)) === null, detail: 'WFSyncHealth=' + has };
    });

    await check('1. cut off from the cloud, an edit shows "Not saved to your account yet" with the reason and both buttons', async () => {
        w.cloud.cutOff(phone.page);
        await sleep(100);
        await phone.page.evaluate((t) => { DB.set('targets', [t]); }, target('t1'));
        const shown = await waitFor(async () => !!(await banner(phone.page)), 20000);
        const b = await banner(phone.page);
        if (b) await phone.page.screenshot({ path: artifacts + '/1-notice.png' });
        const text = (b && b.text) || '';
        const ok = shown && /Not saved to your account yet/.test(text) && /could not reach your cloud account/.test(text) && /Try Again/.test(text) && /Check Connection/.test(text) && /text messages/.test(text) && /Code: unavailable/.test(text);
        return { ok, detail: text.replace(/\s+/g, ' ').slice(0, 300) };
    });

    await check('2. when the connection returns, the change uploads with NO further edit and the other device receives it', async () => {
        w.cloud.reconnect(phone.page);
        const up = await waitFor(() => ((w.cloud.doc || {}).targets || []).some((x) => x.id === 't1'), 60000);
        const gone = await waitFor(async () => (await banner(phone.page)) === null, 12000);
        await laptop.page.evaluate(() => window.__cloudDeliver());
        const there = await waitFor(() => laptop.page.evaluate(() => (DB.get('targets') || []).some((x) => x.id === 't1')), 10000);
        return { ok: up && gone && there, detail: `uploaded=${up} noticeGone=${gone} onOtherDevice=${there}` };
    });

    await check('3. Check Connection names the failing step while cut off, and reports all clear afterwards', async () => {
        w.cloud.cutOff(phone.page);
        await phone.page.evaluate(() => _wfOpenSyncCheck());
        await waitFor(() => phone.page.evaluate(() => /Reading your account: (OK|failed)/.test(document.getElementById('_sc_rows').innerText)), 15000);
        await waitFor(() => phone.page.evaluate(() => document.getElementById('_sc_v').innerText.length > 5), 15000);
        const cut = await phone.page.evaluate(() => ({ rows: document.getElementById('_sc_rows').innerText, verdict: document.getElementById('_sc_v').innerText }));
        await phone.page.screenshot({ path: artifacts + '/3-check-failed.png' });
        w.cloud.reconnect(phone.page);
        await phone.page.click('#_sc_run');
        await waitFor(() => phone.page.evaluate(() => /Everything an upload needs is working/.test(document.getElementById('_sc_v').innerText)), 15000);
        const clear = await phone.page.evaluate(() => document.getElementById('_sc_v').innerText);
        await phone.page.screenshot({ path: artifacts + '/3-check-clear.png' });
        const ok = /Reading your account: failed/.test(cut.rows) && /could not read your account|cannot reach/.test(cut.verdict) && /Everything an upload needs is working/.test(clear);
        return { ok, detail: cut.verdict.slice(0, 160) + ' || ' + clear.slice(0, 80) };
    });

    await check('4. a sign-in the account rejects is called a sign-in problem, and the retry renews the token first', async () => {
        await phone.page.evaluate(() => { const real = window.firebase.firestore; window.__renewals = 0; currentUser.getIdToken = async () => { window.__renewals += 1; return 't'; }; window.__origTx = userDocRef.firestore.runTransaction; userDocRef.firestore.runTransaction = () => Promise.reject(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' })); });
        await phone.page.evaluate((t) => { DB.set('targets', [t]); }, target('t2'));
        const shown = await waitFor(async () => { const b = await banner(phone.page); return !!b && /sign out and sign in again/i.test(b.text); }, 25000);
        const renewed = await waitFor(() => phone.page.evaluate(() => window.__renewals > 0), 20000);
        await phone.page.screenshot({ path: artifacts + '/4-signin.png' });
        await phone.page.evaluate(() => { userDocRef.firestore.runTransaction = window.__origTx; });
        const up = await waitFor(() => ((w.cloud.doc || {}).targets || []).some((x) => x.id === 't2'), 70000);
        return { ok: shown && renewed && up, detail: `signinNotice=${shown} tokenRenewed=${renewed} uploadedAfterFix=${up}` };
    });

    await check('5. going to the background right after an edit uploads at once', async () => {
        await phone.page.evaluate((t) => { DB.set('targets', [t]); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }, target('t3'));
        const quick = await waitFor(() => ((w.cloud.doc || {}).targets || []).some((x) => x.id === 't3'), 1500);
        await phone.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); });
        return { ok: quick, detail: 'uploaded within 1.5 s of leaving: ' + quick };
    });

    await check('6. no page errors on either device', async () => {
        const errs = [...phone.errors, ...laptop.errors].filter((e) => !/ResizeObserver/.test(e));
        return { ok: errs.length === 0, detail: errs.slice(0, 3).join(' | ') + ' ' + JSON.stringify({ phone: phone.errors, laptop: laptop.errors }).slice(0, 400) };
    });
} finally {
    await w.close();
}

let bad = 0;
for (const r of results) { if (!r.ok) bad++; console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '\n       ' + r.detail : '')); }
console.log(`\n${results.length - bad}/${results.length} passed. Screenshots: ${artifacts}`);
process.exit(bad ? 1 : 0);
