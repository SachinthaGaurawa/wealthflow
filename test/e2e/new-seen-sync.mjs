/* The NEW label counts its 7 days from the first time the PERSON sees a thing, and every device of the account agrees on that day.
 *
 * Two real browsers ("phone", "laptop") share ONE stateful cloud document (firebase-cloud.mjs), so the stamp travels through the app's real per-field merge.
 *
 *   1. the phone is the first to see a new option: it shows 7 days left and writes the first sighting to the account
 *   2. the laptop receives that sighting through the sync; four days later the laptop shows 3 days left, not a fresh 7
 *   3. the phone agrees with the laptop; after 7 days from the first look the label is gone on both and a reload does not bring it back
 *   4. a thing nobody opened starts its week only at the first look, however long ago it shipped
 *
 * Run from the repository root with WF_CHROME set:  node test/e2e/new-seen-sync.mjs
 */
import { bootDevices } from './devices.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = async (name, fn) => {
    try { const r = await fn(); results.push({ name, ok: r === true || (r && r.ok === true), detail: (r && r.detail) || '' }); }
    catch (e) { results.push({ name, ok: false, detail: 'threw: ' + String(e.message).slice(0, 240) }); }
};
const waitFor = async (fn, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } return false; };
const DAY = 86400000;

const w = await bootDevices(['phone', 'laptop']);
const { phone, laptop } = w.devices;
const rowHtml = (name, shippedDaysAgo) => `<div class="tst-new" id="${name}" data-wf-new="${new Date(Date.now() - shippedDaysAgo * DAY).toISOString().slice(0, 10)}" style="display:block;min-height:24px">${name}</div>`;
const left = (d, id, at) => d.page.evaluate(([i, t]) => { window.WFNew.scan(document, window, t); const p = document.querySelector('#' + i + ' > .wf-new'); return p ? p.getAttribute('data-left') : null; }, [id, at]);

try {
    // The account began a month ago (so a thing that shipped last week can be new to it).
    await phone.page.evaluate(() => {
        const began = Date.now() - 30 * 86400000;
        const all = JSON.parse(localStorage.getItem('wf_new_seen_v1') || '{}'); all._since = began; localStorage.setItem('wf_new_seen_v1', JSON.stringify(all));
        DB.set('newSeen', { ...DB.getObj('newSeen', {}), _since: began });
    });
    await waitFor(async () => laptop.page.evaluate((b) => (DB.getObj('newSeen', {})._since || Infinity) < b, Date.now() - 20 * DAY));
    await phone.page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h), rowHtml('digestRow', 3));

    const t0 = Date.now();
    await check('1. the phone sees the option first: 7 days left, and the first look is written to the account', async () => {
        const l = await left(phone, 'digestRow', t0);
        const ok = await waitFor(() => Object.keys((w.cloud.doc || {}).newSeen || {}).some((k) => k.startsWith('f:')), 15000);
        return { ok: l === '7' && ok, detail: `left=${l} account keys=${Object.keys((w.cloud.doc || {}).newSeen || {}).join(',')}` };
    });

    await check('2. four days later the laptop shows 3 days left (counted from the PHONE\'s first look), not a fresh 7', async () => {
        await laptop.page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h), rowHtml('digestRow', 3));
        const got = await waitFor(async () => laptop.page.evaluate(() => Object.keys(DB.getObj('newSeen', {})).some((k) => k.startsWith('f:'))), 15000);
        const l = await left(laptop, 'digestRow', t0 + 4 * DAY + 3600000);
        return { ok: got && l === '3', detail: `synced=${got} left=${l}` };
    });

    await check('3. the phone agrees with the laptop on the same day', async () => {
        const l = await left(phone, 'digestRow', t0 + 4 * DAY + 3600000);
        return { ok: l === '3', detail: `left=${l}` };
    });

    await check('4. after 7 days from the first look the label is gone on both devices, and a reload does not bring it back', async () => {
        const a = await left(phone, 'digestRow', t0 + 7 * DAY + 60000);
        const b = await left(laptop, 'digestRow', t0 + 7 * DAY + 60000);
        await laptop.page.reload(); await sleep(2500);
        await laptop.page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h), rowHtml('digestRow', 3));
        const c = await left(laptop, 'digestRow', t0 + 9 * DAY);
        return { ok: a === null && b === null && c === null, detail: `phone=${a} laptop=${b} after reload=${c}` };
    });

    await check('5. a thing nobody opened starts its week at the first look, however long ago it shipped', async () => {
        await laptop.page.evaluate((h) => document.body.insertAdjacentHTML('beforeend', h.replace('display:block', 'display:none')), rowHtml('lateRow', 20));
        const hidden = await left(laptop, 'lateRow', t0 + 10 * DAY);
        await laptop.page.evaluate(() => { document.getElementById('lateRow').style.display = 'block'; });
        const shown = await left(laptop, 'lateRow', t0 + 25 * DAY);
        return { ok: hidden === null && shown === '7', detail: `hidden=${hidden} then opened=${shown}` };
    });
} finally {
    await w.close?.();
}
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail ? '  [' + r.detail + ']' : ''));
if (bad.length) { console.error(`NEW-SEEN SYNC FAILED: ${bad.length} of ${results.length}`); process.exit(1); }
console.log(`new-seen-sync e2e: ${results.length}/${results.length} passed`);
process.exit(0);
