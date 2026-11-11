/* One account, several devices: an update done on one device reaches the others.
 *
 * Three real browsers ("phone", "laptop", "tablet"), each with its own storage, share ONE stateful cloud document (firebase-cloud.mjs),
 * so the account record travels through the app's real per-field merge, not through a stand-in.
 *
 *   1. every device says what it runs, and all three entries survive when they write at the same moment
 *   2. an idle device that has not changed anything writes nothing more
 *   3. when the phone installs a newer version, the laptop is told within seconds: pill and Settings name the phone and the version
 *   4. the laptop that the person is using is left alone; after a quiet minute it starts the install by itself, with its progress screen
 *   5. the tablet, where "keep my devices on the same version" is off, is not told to follow
 *   6. a reload on the laptop does not move the account version (only a deliberate install does)
 *
 * The browser build is the repository's own, so "newer" is simulated the only way it can be here: version.json is answered with the next
 * patch number on the laptop and the tablet. Run from the repository root with WF_CHROME set:  node test/e2e/update-follow.mjs
 */
import { bootDevices } from './devices.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
    try { const r = await fn(); results.push({ name, ok: r === true || (r && r.ok === true), detail: (r && r.detail) || '' }); }
    catch (e) { results.push({ name, ok: false, detail: 'threw: ' + String(e.message).slice(0, 240) }); }
};
const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };

const w = await bootDevices(['phone', 'laptop', 'tablet']);
const { phone, laptop, tablet } = w.devices;
const RUNNING = await phone.page.evaluate(() => window.wfUpdate.CURRENT_VERSION);
const NEXT = RUNNING.split('.').map(Number).map((n, i) => (i === 2 ? n + 1 : n)).join('.');
const line = NEXT.split('.').slice(0, 2).join('.');
const ids = {};
for (const d of [phone, laptop, tablet]) ids[d.name] = await d.page.evaluate(() => localStorage.getItem('wf_device_id'));
const devicesInCloud = () => Object.keys(((w.cloud.doc || {}).updateSync || {}).devices || {}).filter((k) => w.cloud.doc.updateSync.devices[k]);

try {
    // The laptop and the tablet are told the server offers NEXT.
    for (const d of [laptop, tablet]) {
        await d.page.route('**/version.json*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ latest: NEXT, notes: { [NEXT]: { headline: 'Next', sections: [{ title: 'New', items: ['x'] }] } }, mandatory: [] }) }));
    }
    // The tablet opts out on its own.
    await tablet.page.evaluate(() => localStorage.setItem('wf_update_follow', '0'));

    await check('1. every device says what it runs, and all three entries survive writing together', async () => {
        const ok = await waitFor(() => devicesInCloud().length >= 3, 15000);
        const mine = Object.values(ids).every((id) => devicesInCloud().includes(id));
        return { ok: ok && mine, detail: 'devices in the account: ' + devicesInCloud().join(', ') };
    });

    await check('2. an idle device that has nothing new writes nothing', async () => {
        await sleep(2500);
        const before = w.cloud.log.length;
        await sleep(7000);
        const n = w.cloud.log.length - before;
        return { ok: n === 0, detail: n + ' cloud writes in 7 s of idling' };
    });

    // The phone installs NEXT on purpose (the same call the update screen's report makes after a landed install).
    await phone.page.evaluate(([next, id, ln]) => {
        const P = window.WF_UPDATE_POLICY;
        let s = P.reportDevice(DB.getObj('updateSync', {}), id, next, P.deviceLabel(navigator.userAgent), Date.now(), true);
        s = P.noteAgreed(s, ln, Date.now());
        DB.set('updateSync', s);
    }, [NEXT, ids.phone, line]);

    await check('3. the laptop is told: its pill and Settings name the other device and the version', async () => {
        const told = await waitFor(() => laptop.page.evaluate(() => { const f = window.wfUpdate._followState(); return !!f && f.act === 'install'; }), 15000);
        await laptop.page.evaluate(() => window.wfUpdate.refresh());
        const pill = await laptop.page.evaluate(() => (document.getElementById('wfUpdatePill') || {}).textContent || '');
        const state = await laptop.page.evaluate(() => window.wfUpdate._followState());
        const dbg = told ? '' : ' state=' + JSON.stringify(state) + ' acct=' + JSON.stringify(await laptop.page.evaluate(() => DB.getObj('updateSync', {})));
        return { ok: told && pill.includes('is on v' + NEXT) && state.version === NEXT, detail: `told=${told} pill="${pill.trim()}" from=${state && state.from && state.from.name}` + dbg };
    });

    await check('4. the person is using the laptop: nothing starts; after a quiet minute it starts by itself', async () => {
        await laptop.page.mouse.click(300, 300);   // the person touches the app
        const early = await laptop.page.evaluate(() => !!document.getElementById('wfProgress'));
        const started = await waitFor(() => laptop.page.evaluate(() => !!document.getElementById('wfProgress') || localStorage.getItem('wf_update_follow_try') !== null), 85000);
        const tried = await laptop.page.evaluate(() => JSON.parse(localStorage.getItem('wf_update_follow_try') || 'null'));
        return { ok: !early && started && tried && tried.version === NEXT, detail: `early=${early} started=${started} try=${JSON.stringify(tried)}` };
    });

    await check('5. where the person switched following off, the tablet is not told to follow', async () => {
        const s = await tablet.page.evaluate(() => window.wfUpdate._followState());
        return { ok: !!s && s.act === 'none' && s.why === 'off', detail: JSON.stringify(s) };
    });

    await check('6. the account version is the phone\'s, and the laptop\'s own reports did not move it', async () => {
        const wanted = ((w.cloud.doc || {}).updateSync || {}).wanted || '';
        return { ok: wanted.startsWith(NEXT + '|' + ids.phone + '|'), detail: 'wanted=' + wanted };
    });

    for (const d of [phone, laptop, tablet]) {
        const errs = d.errors.filter((e) => !/ResizeObserver|Script error/i.test(e));
        results.push({ name: `no uncaught page errors on ${d.name}`, ok: errs.length === 0, detail: errs.slice(0, 2).join(' | ') });
    }
} finally {
    console.log(results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n'));
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    if (results.some((r) => !r.ok) || !results.length) process.exitCode = 1;
    await w.close();
}
