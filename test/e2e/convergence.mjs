/* Every device on one account converges on one committed state. Real Chromium, three "devices" on ONE stateful cloud document (firebase-cloud.mjs),
 * no real account and no real data. Run from the repository root:  node test/e2e/convergence.mjs
 *
 * The conflict policy these checks exercise is the one the app already has (docs/sync-architecture.md): per-record and per-field update stamps, the later
 * stamp wins, a record deleted later than it was edited stays deleted, and a push is a transaction that merges the cloud copy before it writes.
 *
 *   1. ON, OFF, ON issued from three devices within a fraction of a second: every device and the cloud end on the last one
 *   2. records created on three devices at the same moment are all kept on every device
 *   3. the same cloud snapshot delivered again and again changes nothing and writes nothing
 *   4. a device that missed the live event (cut off) catches up by itself when it reconnects
 *   5. an upload that never answers is cut off by the deadline, shown, and retried until it lands
 *   6. books left on the device by another account are removed before the new account's data is read, and are never uploaded
 *   7. commit-to-visible latency over 24 alternating switch flips, reported as median and 95th percentile (target 1 s, a slow runner may use up to 2 s)
 *   8. no page errors
 */
import { bootDevices, settingsOf } from './devices.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); } return false; };
const results = [];
const check = async (name, fn) => {
    try { const r = await fn(); results.push({ name, ok: r === true || (r && r.ok === true), detail: (r && r.detail) || '' }); }
    catch (e) { results.push({ name, ok: false, detail: 'threw: ' + String(e.message).slice(0, 240) }); }
};
const toggle = (page, key, value) => page.evaluate(([k, v]) => toggleSetting(k, v), [key, value]);
const setting = async (page, key) => (await settingsOf(page))[key];

const w = await bootDevices(['phone', 'laptop', 'tablet']);
const { phone, laptop, tablet } = w.devices;
const all = [phone, laptop, tablet];
for (const d of all) {
    const note = d.page.locator('#wfPostUpdate');
    if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
    await d.page.route('**/api/version*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: 'abc123', version: '7.69.35' }) }));
    await d.page.route('https://firestore.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' }));
    await d.page.evaluate(() => { currentUser.getIdToken = async () => 'test-token'; });
}

try {
    await check('1. ON, OFF, ON from three devices in quick succession ends on the last one everywhere', async () => {
        await toggle(phone.page, 'haptics', true);
        await waitFor(async () => (await Promise.all(all.map((d) => setting(d.page, 'haptics')))).every((v) => v === true), 6000);
        await toggle(phone.page, 'haptics', false);
        await sleep(40);
        await toggle(laptop.page, 'haptics', true);
        await sleep(40);
        await toggle(tablet.page, 'haptics', false);
        const done = await waitFor(async () => {
            const v = await Promise.all(all.map((d) => setting(d.page, 'haptics')));
            return v.every((x) => x === false) && (w.cloud.doc.settings || {}).haptics === false;
        }, 12000);
        const v = await Promise.all(all.map((d) => setting(d.page, 'haptics')));
        return { ok: done, detail: `devices=${JSON.stringify(v)} cloud=${(w.cloud.doc.settings || {}).haptics}` };
    });

    await check('2. records created on three devices at the same moment are all kept everywhere', async () => {
        const rec = (id) => ({ id, name: 'Concurrent ' + id, amount: 1000, saved: 0, savings: [], deadline: '2027-01-01' });
        await Promise.all(all.map((d, i) => d.page.evaluate((t) => { DB.set('targets', [...DB.get('targets'), t]); }, rec('c' + i))));
        const done = await waitFor(async () => {
            const sets = await Promise.all(all.map((d) => d.page.evaluate(() => DB.get('targets').map((t) => t.id).filter((id) => /^c[012]$/.test(id)).sort().join(','))));
            return sets.every((s) => s === 'c0,c1,c2') && ((w.cloud.doc || {}).targets || []).filter((t) => /^c[012]$/.test(t.id)).length === 3;
        }, 15000);
        const sets = await Promise.all(all.map((d) => d.page.evaluate(() => DB.get('targets').map((t) => t.id).filter((id) => /^c[012]$/.test(id)).sort().join(','))));
        return { ok: done, detail: JSON.stringify(sets) + ' cloud=' + ((w.cloud.doc || {}).targets || []).map((t) => t.id).join(',') };
    });

    await check('3. the same snapshot delivered again and again changes nothing and writes nothing', async () => {
        await sleep(1500);
        const before = JSON.stringify(w.cloud.doc);
        const writesBefore = w.cloud.log.length;
        const stateBefore = JSON.stringify(await settingsOf(laptop.page));
        for (let i = 0; i < 6; i++) await laptop.page.evaluate(() => window.__cloudDeliver());
        await sleep(1500);
        const same = before === JSON.stringify(w.cloud.doc) && stateBefore === JSON.stringify(await settingsOf(laptop.page));
        return { ok: same && w.cloud.log.length === writesBefore, detail: `cloud writes before=${writesBefore} after=${w.cloud.log.length} stateUnchanged=${same}` };
    });

    await check('4. a device that missed the live event catches up by itself after reconnecting', async () => {
        w.cloud.cutOff(tablet.page);
        await sleep(100);
        await toggle(phone.page, 'sounds', false);
        await waitFor(() => (w.cloud.doc.settings || {}).sounds === false, 6000);
        await sleep(500);
        const stale = (await setting(tablet.page, 'sounds')) !== false;
        w.cloud.reconnect(tablet.page);
        await tablet.page.evaluate(() => window.dispatchEvent(new Event('online')));
        const caught = await waitFor(async () => (await setting(tablet.page, 'sounds')) === false, 12000);
        return { ok: stale && caught, detail: `staleWhileCutOff=${stale} caughtUp=${caught}` };
    });

    await check('5. an upload that never answers is cut off by the deadline, shown, and retried until it lands', async () => {
        await phone.page.evaluate(() => {
            window._wfPushDeadlineMs = 1500;
            window.__origTx2 = userDocRef.firestore.runTransaction;
            window.__hangs = 0;
            userDocRef.firestore.runTransaction = function () { window.__hangs += 1; return new Promise(() => {}); };
        });
        await phone.page.evaluate((t) => { DB.set('targets', [...DB.get('targets'), t]); }, { id: 'hung1', name: 'Hung', amount: 10, saved: 0, savings: [], deadline: '2027-01-01' });
        const failed = await waitFor(() => phone.page.evaluate(() => window.__hangs >= 1), 6000);
        await sleep(2500);
        const dirty = await phone.page.evaluate(() => isDirty === true);
        await phone.page.evaluate(() => { userDocRef.firestore.runTransaction = window.__origTx2; });
        const landed = await waitFor(() => ((w.cloud.doc || {}).targets || []).some((t) => t.id === 'hung1'), 70000);
        return { ok: failed && dirty && landed, detail: `hungOnce=${failed} stillUnsavedAfterDeadline=${dirty} landedAfterwards=${landed}` };
    });

    await check('6. books left by another account are removed, never uploaded, and the new account is read clean', async () => {
        const fresh = await bootDevices(['guest']);
        try {
            const pg = fresh.devices.guest.page;
            const before = await pg.evaluate(() => localStorage.getItem('wf_account_uid'));
            await pg.evaluate(() => {
                localStorage.setItem('wf_account_uid', 'someone-else');
                localStorage.setItem('wf2_targets', JSON.stringify([{ id: 'leak1', name: 'Previous account', amount: 1, saved: 0, savings: [], deadline: '2027-01-01', _ut: Date.now() }]));
                localStorage.setItem('wf2_isDirty', '1');
            });
            const g = fresh.devices.guest;
            const p2 = await g.context.newPage();           // a plain page load: the account guard reloads it once more by itself
            await fresh.cloud.attach(p2);
            const errs2 = []; p2.on('pageerror', (e) => errs2.push(String(e.message).slice(0, 200)));
            await g.page.close();
            await p2.goto(fresh.server.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            const read = () => p2.evaluate(() => ({ uid: localStorage.getItem('wf_account_uid'), ready: typeof DB !== 'undefined' && !!DB.get, local: (DB.get('targets') || []).map((t) => t.id), dirty: localStorage.getItem('wf2_isDirty') })).catch(() => null);
            await waitFor(async () => { const r = await read(); return r && r.ready && r.uid && r.uid !== 'someone-else'; }, 25000);
            await sleep(2500);
            const st = (await read()) || { uid: null, local: [], dirty: null };
            const uploaded = ((fresh.cloud.doc || {}).targets || []).some((t) => t.id === 'leak1');
            const ok = !st.local.includes('leak1') && !uploaded && st.uid && st.uid !== 'someone-else';
            return { ok, detail: `recordedBefore=${before} afterSwitch=${st.uid} leftover=${st.local.includes('leak1')} uploaded=${uploaded}` };
        } finally { await fresh.close(); }
    });

    await check('7. commit-to-visible latency over 24 alternating flips (target 1 s at the 95th percentile, fails above 2 s)', async () => {
        const times = [];
        let value = true;
        for (let i = 0; i < 24; i++) {
            const [from, to] = i % 2 ? [laptop, phone] : [phone, laptop];
            value = !value;
            const t0 = Date.now();
            await toggle(from.page, 'compactMode', value);
            const ok = await waitFor(async () => (await setting(to.page, 'compactMode')) === value, 6000);
            times.push(ok ? Date.now() - t0 : 6000);
            await sleep(120);
        }
        const sorted = [...times].sort((a, b) => a - b);
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        return { ok: q(0.95) < 2000, detail: (q(0.95) < 1000 ? 'under the 1 s target: ' : 'ABOVE the 1 s target: ') + `median=${q(0.5)}ms p95=${q(0.95)}ms max=${sorted[sorted.length - 1]}ms (stub cloud, one machine, includes the 300 ms upload debounce)` };
    });

    await check('8. no page errors on any device', async () => {
        const errs = all.flatMap((d) => d.errors).filter((e) => !/ResizeObserver/.test(e));
        return { ok: errs.length === 0, detail: errs.slice(0, 3).join(' | ') };
    });
} finally {
    await w.close();
}

let bad = 0;
for (const r of results) { if (!r.ok) bad++; console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '\n       ' + r.detail : '')); }
console.log(`\n${results.length - bad}/${results.length} passed.`);
process.exit(bad ? 1 : 0);
