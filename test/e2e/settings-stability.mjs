/* Settings must not move under the finger. Measured in a real browser at a phone, a tablet and a laptop width, against the
 * cloud stub (so the sync status really cycles Syncing -> Connected after every save, as it does in production):
 *
 *   A. the Cloud Sync status pill keeps one box and one colour in all three of its states (it used to lose its background and
 *      shrink to 76px, which on a phone changed the row's height by 24px, so every switch nudged the page)
 *   B. every card that another module fills (Notifications, Software Update, Autonomous AI Engine, Autonomous Release) is
 *      there in the FIRST frame of the page, not 120-400ms later (the AI Engine card used to be put in by the first click
 *      anywhere, 476px, in the middle of the page)
 *   C. a rebuild of the page (a cloud snapshot, a finished backup) leaves the section being read exactly where it was
 *   D. flipping each switch leaves the switch itself and the page scroll where they were
 *   E. the AI services row is the same height, with the same badge box, whatever it reads (Checking, Online, Offline, Degraded, Not measured),
 *      and a rebuild shows the last reading again instead of putting "Checking..." back
 */
import { bootDevices } from './devices.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const note = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || '' });

const w = await bootDevices(['d']);
const { page } = w.devices.d;

const openSettings = async () => {
    await page.evaluate(() => showPage('settings'));
    await page.waitForSelector('#settingsContent .toggle[data-setting]', { state: 'visible', timeout: 15000 });
};
/** Wait until the page has finished everything it does on its own after opening. */
const settle = async () => {
    await page.waitForFunction(() => !!document.querySelector('#wfUpdateCard .settings-title') && !!document.querySelector('#wfntfSettingsCard[data-built="1"]'), null, { timeout: 15000 });
    await sleep(1600);
};

try {
    for (const width of [390, 820, 1280]) {
        await page.setViewportSize({ width, height: width < 600 ? 800 : 860 });
        await page.evaluate(() => showPage('dashboard'));
        await sleep(400);

        // ---- B. the finished page is in the first frame
        await page.evaluate(() => { window.__first = null; });
        await page.evaluate(() => {
            showPage('settings');
            requestAnimationFrame(() => {
                const ids = ['wfntfSettingsCard', 'wfUpdateCard', 'wfIntelPanel', 'wfReleasePanel'];
                window.__first = ids.map((id) => { const e = document.getElementById(id); return [id, !!e && (e.textContent || '').trim().length > 20]; });
            });
        });
        await sleep(300);
        const first = await page.evaluate(() => window.__first);
        const missing = (first || []).filter(([, ok]) => !ok).map(([id]) => id);
        note(`B. [${width}px] every card is filled in the first frame of the page`, first && missing.length === 0, missing.length ? 'late: ' + missing.join(', ') : '');
        await settle();

        // ---- the heights of everything then stay put while the page idles
        const idle = await page.evaluate(() => new Promise((resolve) => {
            const out = []; const t0 = performance.now();
            (function tick() { out.push({ h: document.body.scrollHeight, n: document.querySelectorAll('#settingsContent > .settings-section').length }); if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else resolve(out); })();
        }));
        const hs = idle.map((s) => s.h); const ns = idle.map((s) => s.n);
        note(`B. [${width}px] an open Settings page does not change height or gain cards by itself`, Math.max(...hs) - Math.min(...hs) <= 1 && Math.max(...ns) === Math.min(...ns), `height ${Math.min(...hs)}..${Math.max(...hs)}, cards ${Math.min(...ns)}..${Math.max(...ns)}`);

        // ---- A. the status pill, through a real save
        await page.evaluate(() => document.getElementById('settingsCloudStatus').scrollIntoView({ block: 'center' }));
        await sleep(300);
        await page.evaluate(() => {
            window.__pill = [];
            const b = document.getElementById('settingsCloudStatus');
            const row = b.closest('.setting-row'); const sec = row.closest('.settings-section');
            const snap = () => { const r = b.getBoundingClientRect(); window.__pill.push({ text: b.textContent, w: Math.round(r.width), h: Math.round(r.height), row: Math.round(row.getBoundingClientRect().height), sec: Math.round(sec.getBoundingClientRect().height), bg: getComputedStyle(b).backgroundColor }); };
            snap();
            window.__pillMo = new MutationObserver(snap); window.__pillMo.observe(b, { attributes: true, childList: true, characterData: true, subtree: true });
            document.querySelector('#settingsContent .toggle[data-setting="showSavingsRate"]').click();
        });
        await sleep(1500);
        const pill = await page.evaluate(() => { window.__pillMo.disconnect(); const p = window.__pill; document.querySelector('#settingsContent .toggle[data-setting="showSavingsRate"]').click(); return p; });
        const texts = [...new Set(pill.map((s) => s.text))];
        const same = (k) => pill.every((s) => s[k] === pill[0][k]);
        note(`A. [${width}px] the sync pill keeps its size, its row and its section through Syncing -> Connected`, pill.length >= 2 && texts.length >= 2 && pill[0].w > 0 && pill[0].h > 0 && same('w') && same('h') && same('row') && same('sec'),
            `states ${JSON.stringify(texts)} sizes ${JSON.stringify([...new Set(pill.map((s) => s.w + 'x' + s.h + ' row' + s.row + ' sec' + s.sec))])}`);
        note(`A. [${width}px] the sync pill never loses its background`, pill.every((s) => s.bg !== 'rgba(0, 0, 0, 0)' && s.bg !== 'transparent'), JSON.stringify([...new Set(pill.map((s) => s.bg))]));
        await sleep(800);

        // ---- C. a rebuild keeps the reader's place
        await page.evaluate(() => { const e = document.getElementById('wfPwaSection'); window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 160); });
        await sleep(400);
        const before = await page.evaluate(() => ({ top: Math.round(document.getElementById('wfPwaSection').getBoundingClientRect().top), sy: Math.round(scrollY), h: document.body.scrollHeight }));
        await page.evaluate(() => { window.__rb = []; const src = () => { const e = document.getElementById('wfPwaSection'); return { top: e ? Math.round(e.getBoundingClientRect().top) : null, sy: Math.round(scrollY), h: document.body.scrollHeight }; }; renderSettings(); window.__rb.push(src()); let n = 0; (function tick() { window.__rb.push(src()); if (++n < 70) requestAnimationFrame(tick); })(); });
        await sleep(1800);
        const rb = await page.evaluate(() => window.__rb);
        const worst = Math.max(...rb.map((s) => Math.abs((s.top === null ? 9999 : s.top) - before.top)));
        const worstY = Math.max(...rb.map((s) => Math.abs(s.sy - before.sy)));
        const worstH = Math.max(...rb.map((s) => Math.abs(s.h - before.h)));
        note(`C. [${width}px] rebuilding the page keeps the section on screen in place for every frame`, worst <= 1 && worstY <= 1 && worstH <= 2, `max move ${worst}px, scroll ${worstY}px, height ${worstH}px`);

        // ---- E. the AI services row
        const reads = [
            ['\u25CF Checking\u2026', 'bg-gr', 'Several independent AI services answer together; anything that touches your money is filed only when they agree. Keys stay on the server.'],
            ['\u25CF Online', 'bg-g', '8 of 8 AI services answered and agreed \u00B7 checked just now.'],
            ['\u25CF Offline', 'bg-r', 'The AI service is not deployed on this server (got a non-JSON 404 answer).'],
            ['\u25CF Degraded', 'bg-a', 'Only 3 of 8 AI services answered (4 are needed to file anything) \u00B7 checked 59 min ago. Most free services are busy or out of credit.'],
            ['\u25CF Not measured yet', 'bg-gr', 'No reading of the AI services yet. Press Run Diagnostic to measure them now.'],
        ];
        const rows = await page.evaluate((rs) => rs.map(([txt, cls, detail]) => {
            const b = document.getElementById('aiEngineHealth'); const l = document.getElementById('aiEngineDetail');
            b.textContent = txt; b.className = 'badge ' + cls + ' wf-ai-badge'; l.textContent = detail;
            const sec = b.closest('.settings-section'); const r = b.getBoundingClientRect();
            return { txt, h: Math.round(sec.getBoundingClientRect().height), w: Math.round(r.width) };
        }), reads);
        note(`E. [${width}px] the AI services row keeps one height and one badge width for all five readings`, new Set(rows.map((r) => r.h)).size === 1 && new Set(rows.map((r) => r.w)).size === 1 && rows[0].w > 0, JSON.stringify(rows.map((r) => r.h + '/' + r.w)));
        const kept = await page.evaluate(() => {
            const want = '\u25CF Online';
            _aiHealthCache = { cls: 'bg-g', txt: want, detail: '8 of 8 AI services answered and agreed \u00B7 checked just now.', ts: Date.now() };
            renderSettings();
            const b = document.getElementById('aiEngineHealth'); const l = document.getElementById('aiEngineDetail');
            return { badge: b.textContent, cls: b.className, detail: l.textContent, want };
        });
        note(`E. [${width}px] a rebuild shows the last AI reading in its first frame, not "Checking..."`, kept.badge === kept.want && /bg-g/.test(kept.cls) && /8 of 8/.test(kept.detail), JSON.stringify(kept));
        await settle();

        // ---- D. every switch
        const keys = await page.evaluate(() => [...new Set([...document.querySelectorAll('#settingsContent .toggle[data-setting]')].map((e) => e.dataset.setting))]);
        const moved = [];
        for (const key of keys) {
            await page.evaluate((k) => { document.querySelector(`#settingsContent .toggle[data-setting="${k}"]`).scrollIntoView({ block: 'center' }); }, key);
            await sleep(120);
            const m = await page.evaluate(([k]) => new Promise((resolve) => {
                const el = document.querySelector(`#settingsContent .toggle[data-setting="${k}"]`);
                const top0 = el.getBoundingClientRect().top; const sy0 = scrollY;
                const secs0 = [...document.querySelectorAll('#settingsContent > .settings-section')].map((s) => Math.round(s.getBoundingClientRect().top + scrollY));
                let worst = 0, worstY = 0; const t0 = performance.now();
                el.click();
                (function tick() {
                    const e2 = document.querySelector(`#settingsContent .toggle[data-setting="${k}"]`);
                    if (!e2) { worst = 9999; } else { worst = Math.max(worst, Math.abs(e2.getBoundingClientRect().top - top0)); }
                    worstY = Math.max(worstY, Math.abs(scrollY - sy0));
                    if (performance.now() - t0 < 700) requestAnimationFrame(tick);
                    else {
                        const secs1 = [...document.querySelectorAll('#settingsContent > .settings-section')].map((s) => Math.round(s.getBoundingClientRect().top + scrollY));
                        resolve({ worst: Math.round(worst), worstY: Math.round(worstY), sections: secs0.length === secs1.length });
                    }
                })();
            }), [key]);
            // switching Compact Mode on purpose tightens every card, so the switch itself legitimately moves; it must still keep the scroll
            const limit = key === 'compactMode' ? Infinity : 1;
            if (m.worst > limit || m.worstY > 1 || !m.sections) moved.push(`${key}: moved ${m.worst}px, scroll ${m.worstY}px${m.sections ? '' : ', a card appeared/vanished'}`);
            // put it back (a switch that opens a confirmation instead of flipping is closed again)
            await page.evaluate((k) => { const el = document.querySelector(`#settingsContent .toggle[data-setting="${k}"]`); if (el) el.click(); }, key);
            await sleep(120);
            await page.evaluate(() => { try { document.querySelectorAll('.modal.show, .modal-bg.show, .confirm-overlay, .wf-confirm').forEach((m) => { const c = m.querySelector('[data-close], .btn-ghost, .btn-secondary'); if (c) c.click(); }); } catch (_) {} });
        }
        note(`D. [${width}px] none of the ${keys.length} switches moves itself or the page when flipped`, moved.length === 0, moved.slice(0, 6).join(' | '));
    }

    const errs = w.devices.d.errors.filter((e) => !/ResizeObserver|Script error/i.test(e));
    note('no uncaught page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
} finally {
    console.log(results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`).join('\n'));
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    if (results.some((r) => !r.ok) || !results.length) process.exitCode = 1;
    await w.close();
}
