/* A setting that reverts "after a few hours" is two devices arguing about one cloud document. This replays the arguments in two real
 * browsers that share ONE stateful cloud document (firebase-cloud.mjs):
 *
 *   1. a device that was offline while another changed a switch must not undo it when it comes back, even after a page reload
 *   2. the first switch a fresh device flips must not also claim every other setting it merely has a default for
 *   3. a switch that was flipped survives a reload on the device AND reaches the other device
 *   4. two switches changed on two devices both survive (changes to different switches do not overwrite each other)
 *   5. a brand-new account's PIN is not erased by the cloud's still-empty copy of it
 *   6. Passcode-free entry flipped on one device is not turned off by the other device's older copy
 *   7. an idle, in-sync device writes nothing
 */
import { bootDevices, settingsOf } from './devices.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
    try {
        const r = await fn();
        const ok = r === true || (r && r.ok === true);
        results.push({ name, ok, detail: (r && r.detail) || '' });
    } catch (e) { results.push({ name, ok: false, detail: 'threw: ' + String(e.message).slice(0, 240) }); }
};
const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };
const toggle = (page, key, value) => page.evaluate(([k, v]) => toggleSetting(k, v), [key, value]);

const w = await bootDevices(['phone', 'laptop']);
const { phone, laptop } = w.devices;
try {
    await check('1. an offline device that reloads and reconnects does not undo another device\'s change', async () => {
        w.cloud.cutOff(laptop.page);
        await sleep(50);
        await toggle(phone.page, 'notifications', false);
        await waitFor(() => w.cloud.doc && w.cloud.doc.settings && w.cloud.doc.settings.notifications === false);
        await sleep(100);
        await toggle(laptop.page, 'compactMode', true);   // the stale device changes something else meanwhile
        await sleep(400);
        await w.reload('laptop');
        w.cloud.reconnect(laptop.page);
        await laptop.page.evaluate(() => window.__cloudDeliver());
        await sleep(2500);
        const l = await settingsOf(laptop.page);
        const c = (w.cloud.doc || {}).settings || {};
        const p = await settingsOf(phone.page);
        const ok = l.notifications === false && l.compactMode === true && c.notifications === false && c.compactMode === true && p.notifications === false && p.compactMode === true;
        return { ok, detail: JSON.stringify({ laptop: [l.notifications, l.compactMode], cloud: [c.notifications, c.compactMode], phone: [p.notifications, p.compactMode] }) };
    });

    await check('2. a fresh device\'s first switch claims only that switch', async () => {
        const fresh = await bootDevices(['solo']);
        try {
            const pg = fresh.devices.solo.page;
            await toggle(pg, 'showSavingsRate', false);
            await waitFor(() => fresh.cloud.doc && fresh.cloud.doc._kuf && fresh.cloud.doc._kuf.settings);
            await sleep(300);
            const stamped = Object.keys(((fresh.cloud.doc || {})._kuf || {}).settings || {}).filter((k) => !/^_/.test(k));
            return { ok: stamped.length === 1 && stamped[0] === 'showSavingsRate', detail: 'stamped paths: ' + JSON.stringify(stamped) };
        } finally { await fresh.close(); }
    });

    await check('3. a flipped switch survives a reload and reaches the other device', async () => {
        await toggle(phone.page, 'showSavingsRate', false);
        await waitFor(() => (w.cloud.doc.settings || {}).showSavingsRate === false);
        await w.reload('phone');
        await sleep(2000);
        const p = await settingsOf(phone.page);
        const l = await waitFor(async () => (await settingsOf(laptop.page)).showSavingsRate === false, 8000);
        return { ok: p.showSavingsRate === false && l, detail: `phone after reload=${p.showSavingsRate} laptop=${l}` };
    });

    await check('4. different switches changed on two devices both survive', async () => {
        await toggle(phone.page, 'haptics', false);
        await toggle(laptop.page, 'sounds', false);
        await sleep(2500);
        await w.reload('phone'); await w.reload('laptop');
        await sleep(2500);
        const p = await settingsOf(phone.page); const l = await settingsOf(laptop.page); const c = (w.cloud.doc || {}).settings || {};
        const ok = [p, l, c].every((s) => s.haptics === false && s.sounds === false);
        return { ok, detail: JSON.stringify({ phone: [p.haptics, p.sounds], laptop: [l.haptics, l.sounds], cloud: [c.haptics, c.sounds] }) };
    });

    await check('5. a new account\'s PIN is not erased by the cloud\'s empty copy of it', async () => {
        const fresh = await bootDevices(['solo']);
        try {
            const pg = fresh.devices.solo.page;
            const pinBefore = await pg.evaluate(() => (DB.getObj('auth', {}) || {}).pin || '');
            await sleep(2500);
            await pg.evaluate(() => window.__cloudDeliver && window.__cloudDeliver());
            await sleep(1500);
            const pinAfter = await pg.evaluate(() => (DB.getObj('auth', {}) || {}).pin || '');
            const locked = await pg.evaluate(() => document.getElementById('app').classList.contains('show'));
            return { ok: !!pinBefore && pinBefore === pinAfter && locked, detail: `pin kept=${pinBefore === pinAfter} appVisible=${locked}` };
        } finally { await fresh.close(); }
    });

    await check('6. Passcode-free entry set on one device is not undone by the other\'s older copy', async () => {
        await phone.page.evaluate(() => _applySkipLock(true));
        await waitFor(() => (w.cloud.doc.auth || {}).skipLock === true);
        await sleep(1500);
        // the laptop still holds the older copy; let it write something and reconcile
        await toggle(laptop.page, 'currency', 'USD');
        await sleep(2500);
        const c = (w.cloud.doc || {}).auth || {};
        const p = await phone.page.evaluate(() => (DB.getObj('auth', {}) || {}).skipLock);
        const l = await laptop.page.evaluate(() => (DB.getObj('auth', {}) || {}).skipLock);
        await toggle(laptop.page, 'currency', 'LKR');
        return { ok: c.skipLock === true && p === true && l === true, detail: `cloud=${c.skipLock} phone=${p} laptop=${l}` };
    });

    await check('7. an idle, in-sync device writes nothing', async () => {
        await sleep(1500);
        const before = w.cloud.log.length;
        await sleep(4000);
        const writes = w.cloud.log.length - before;
        return { ok: writes === 0, detail: `${writes} cloud writes in 4 s of idling` };
    });

    for (const d of [phone, laptop]) {
        const errs = d.errors.filter((e) => !/ResizeObserver|Script error/i.test(e));
        results.push({ name: `no uncaught page errors on ${d.name}`, ok: errs.length === 0, detail: errs.slice(0, 2).join(' | ') });
    }
} finally {
    console.log(results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n'));
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    if (results.some((r) => !r.ok) || !results.length) process.exitCode = 1;
    await w.close();
}
