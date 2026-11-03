/* The whole in-app update journey, in a real browser, at a phone width and a laptop width.
 *
 * What the owner specified (requirements 4, 6, 7 and 9 of the "Autonomous Financial Operating System" brief):
 *   4. an "update available" notice on the Dashboard AND in Settings; tapping the Dashboard one lands on the Settings update section
 *   6. Update now -> a generated agreement (must be scrolled to the end) -> the PIN -> an automatic backup first -> a REAL progress
 *      bar with a countdown
 *   7. the update is the person's own choice, like a phone: nothing installs until they say so
 *   9. after the update and the PIN login, a centred, scrollable "what changed" popup with a Close button
 *
 * Nothing here is mocked in the app: the update module, the PIN check, the backup call and the file downloads all run. The
 * only thing simulated is "a newer version exists" (wfUpdate.simulate), and "the new code has arrived" is modelled the way a
 * real update does it: the device boots with a stored version older than the code that is running.
 *
 * Run: node test/e2e/update-journey.mjs     (set WF_CHROME to a Chromium binary if Playwright's own is not installed)
 */
import { bootDevices } from './devices.mjs';
import { completeOnboarding } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const note = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || '' }); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : '')); };

const w = await bootDevices(['d']);
const dev = w.devices.d;
let page = dev.page;
const PIN = '123456';
/** Reload the page the way a restart does, then sign in with the PIN like a person would. */
const reloadAndLogin = async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await completeOnboarding(page, { pin: PIN }); };

try {
    const running = await page.evaluate(() => window.wfUpdate.CURRENT_VERSION);
    const target = '99.0.0';

    for (const width of [390, 1280]) {
        const tag = `[${width}px]`;
        await page.setViewportSize({ width, height: width < 600 ? 800 : 860 });
        await page.evaluate(() => { try { localStorage.removeItem('wf_claim'); } catch (_) {} });

        // ── 7. nothing is offered or installed until a newer version exists, and nothing installs by itself
        await page.evaluate(() => { wfUpdate.simulate(false); showPage('dashboard'); });
        await sleep(500);
        note(`7. ${tag} no notice while the device is current`, !(await page.$('#wfUpdatePill')));

        // ── 4. a newer version appears: the Dashboard notice and the Settings notice
        await page.evaluate((v) => wfUpdate.simulate(v), target);
        await sleep(2600);          // simulate() opens Settings and smooth-scrolls to the card; let that finish like a person would
        // simulate() also opens the What's New sheet, as the pill does; close it like a person would
        await page.evaluate(() => { const c = document.querySelector('#wfWhatsNew button.btn-primary'); if (c) c.click(); });
        await sleep(300);
        await page.evaluate(() => { showPage('dashboard'); window.scrollTo(0, 0); });
        await sleep(600);
        await page.waitForSelector('#wfUpdatePill', { timeout: 8000 });
        const pillText = await page.$eval('#wfUpdatePill', (e) => e.textContent.replace(/\s+/g, ' ').trim());
        note(`4. ${tag} the Dashboard shows "Update available — ${target}"`, pillText.includes('Update available') && pillText.includes(target), pillText);
        const pillBox = await page.$eval('#wfUpdatePill', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, w: r.width, vw: innerWidth }; });
        note(`4. ${tag} the Dashboard notice fits the screen`, pillBox.x >= 0 && pillBox.x + pillBox.w <= pillBox.vw + 1, JSON.stringify(pillBox));

        await page.click('#wfUpdatePill');
        await page.waitForFunction(() => document.getElementById('page-settings')?.classList.contains('active'), null, { timeout: 8000 });
        await sleep(2600);
        await page.evaluate(() => { const c = document.querySelector('#wfWhatsNew button.btn-primary'); if (c) c.click(); });
        await sleep(300);
        const card = await page.$eval('#wfUpdateCard', (e) => ({ text: e.textContent.replace(/\s+/g, ' '), visible: e.getBoundingClientRect().height > 0 }));
        note(`4. ${tag} tapping the Dashboard notice lands on Settings, on the Software Update card, offering "Update now"`, card.visible && /Software Update/.test(card.text) && /Update now/.test(card.text) && card.text.includes(target), card.text.slice(0, 110));

        // ── 7. the notice alone installs nothing
        const installedBefore = await page.evaluate(() => localStorage.getItem('wf_installed_version'));
        note(`7. ${tag} nothing was installed by being offered the update`, installedBefore === running, `installed=${installedBefore}`);

        // ── 6. Update now -> agreement
        await page.evaluate(() => { [...document.querySelectorAll('#wfUpdateCard button')].find((b) => /Update now/.test(b.textContent)).click(); });
        await page.waitForSelector('#wfEula', { timeout: 8000 });
        const eula = await page.evaluate(() => {
            const s = document.getElementById('wfEulaScroll'); const a = document.getElementById('wfEulaAgree');
            return { text: s.textContent, scrolls: s.scrollHeight > s.clientHeight, locked: getComputedStyle(a).pointerEvents === 'none' };
        });
        note(`6. ${tag} an agreement for this exact version is generated`, /END-USER LICENSE AGREEMENT/.test(eula.text) && eula.text.includes('v' + target), eula.text.slice(0, 60).replace(/\s+/g, ' '));
        note(`6. ${tag} "I Agree" stays locked until the agreement is scrolled to the end`, eula.locked && eula.scrolls);
        await page.evaluate(() => { const s = document.getElementById('wfEulaScroll'); s.scrollTop = s.scrollHeight; });
        await sleep(300);
        note(`6. ${tag} scrolling to the end unlocks it`, await page.evaluate(() => getComputedStyle(document.getElementById('wfEulaAgree')).pointerEvents !== 'none'));

        // ── 6. a wrong PIN stops the update; the right one lets it through
        await page.click('#wfEulaAgree');
        await page.waitForSelector('#_vp_pin', { timeout: 8000 });
        await page.fill('#_vp_pin', '000000'); await page.click('#_vp_ok'); await sleep(500);
        note(`6. ${tag} a wrong PIN is refused and no update starts`, /Incorrect PIN/.test(await page.$eval('#_vp_err', (e) => e.textContent)) && !(await page.$('#wfProgress')));
        await page.fill('#_vp_pin', PIN);

        // watch the progress overlay from the moment it exists: bar, percentage, countdown, step text
        await page.evaluate(() => {
            window.__pg = [];
            const take = () => { const b = document.getElementById('wfPgBar'); if (!b) return; window.__pg.push({ step: (document.getElementById('wfPgStep') || {}).textContent, pct: (document.getElementById('wfPgPct') || {}).textContent, eta: (document.getElementById('wfPgEta') || {}).textContent, bar: b.style.transform }); };
            new MutationObserver(take).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });   // every change, not a sample
            window.__reloads = 0;
            window.addEventListener('beforeunload', () => { try { sessionStorage.setItem('__pg', JSON.stringify(window.__pg.slice(-400))); } catch (_) {} });
        });
        const navigated = page.waitForEvent('load', { timeout: 60000 }).catch(() => null);
        await page.click('#_vp_ok');
        await navigated;
        const pg = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__pg') || '[]'));
        const steps = [...new Set(pg.map((x) => x.step))];
        const pcts = pg.map((x) => parseInt(x.pct, 10)).filter((n) => !isNaN(n));
        const etas = [...new Set(pg.map((x) => x.eta))];
        note(`6. ${tag} the backup is the first step`, /Backing up/.test(steps[0] || ''), JSON.stringify(steps.slice(0, 2)));
        note(`6. ${tag} the files are really downloaded, counted as n/total`, steps.some((s) => /Downloading new version files.*\(\d+\/\d+\)/.test(s)), JSON.stringify(steps.filter((s) => /Downloading/.test(s)).slice(-1)));
        note(`6. ${tag} the percentage only moves forward, from the start to 100`, pcts.length > 3 && pcts.every((n, i) => i === 0 || n >= pcts[i - 1]) && pcts[pcts.length - 1] === 100, `${pcts.length} samples, ${pcts[0]}..${pcts[pcts.length - 1]}`);
        note(`6. ${tag} a countdown is shown ("about Ns remaining")`, etas.some((e) => /about \d+s remaining/.test(e)), JSON.stringify(etas.slice(0, 5)));
        const pre = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('wf_preupdate_backup') || 'null'); } catch (_) { return null; } });
        note(`6. ${tag} the restore point's result before the swap is recorded as it was (saved | not-saved), and no unused copy of every wf2_ key is made`, !!pre && (pre.result === 'saved' || pre.result === 'not-saved') && !(await page.evaluate(() => localStorage.getItem('wf_preupdate_snapshot'))), JSON.stringify(pre));

        // ── the page has reloaded with the new code. The claim is settled against what really loaded.
        await sleep(2500);
        const settled = await page.evaluate(() => ({ claim: localStorage.getItem('wf_update_claim') || localStorage.getItem('wf_claim'), installed: localStorage.getItem('wf_installed_version') }));
        note(`6. ${tag} after the restart the device does not pretend: the simulated 99.0.0 never loaded, so it is not recorded as installed`, settled.installed === running, JSON.stringify(settled).slice(0, 140));
        await page.evaluate(() => wfUpdate.simulate(false));

        // ── 9. new code arrives (the device remembers an OLDER version and the update flow has cleared its welcome mark)
        //       -> after the restart and the PIN login, the welcome popup
        await page.evaluate(() => { localStorage.setItem('wf_installed_version', '7.60.0'); localStorage.setItem('wf_update_popup_seen', ''); });
        await reloadAndLogin();
        await page.waitForSelector('#wfPostUpdate', { timeout: 20000 }).catch(() => null);
        const pop = await page.evaluate(() => {
            const o = document.getElementById('wfPostUpdate'); if (!o) return null;
            const card = o.firstElementChild.getBoundingClientRect(); const cs = getComputedStyle(o);
            const body = o.querySelector('[style*="overflow-y"]') || o;
            const close = [...o.querySelectorAll('button')].find((b) => /Return to Dashboard|Close/i.test(b.textContent));
            return {
                text: o.textContent.replace(/\s+/g, ' ').trim(), centred: Math.abs((card.left + card.width / 2) - innerWidth / 2) < 3 && cs.alignItems === 'center',
                fits: card.left >= 0 && card.right <= innerWidth + 1 && card.top >= 0 && card.bottom <= innerHeight + 1,
                scrollable: /auto|scroll/.test(getComputedStyle(body).overflowY), close: !!close, closeLabel: close ? close.textContent.trim() : '',
            };
        });
        note(`9. ${tag} the "what changed" popup appears after the update`, !!pop && /Welcome to v/.test(pop.text), pop ? pop.text.slice(0, 80) : 'no popup');
        note(`9. ${tag} it is centred, fits the screen, scrolls inside, and has a button to close it`, pop && pop.centred && pop.fits && pop.scrollable && pop.close, pop ? JSON.stringify({ centred: pop.centred, fits: pop.fits, scrollable: pop.scrollable, close: pop.closeLabel }) : '');
        await page.evaluate(() => { const o = document.getElementById('wfPostUpdate'); const b = o && [...o.querySelectorAll('button')].find((x) => /Return to Dashboard|Close/i.test(x.textContent)); if (b) b.click(); });
        await sleep(600);
        note(`9. ${tag} the button closes it, and it does not come back after a refresh`, await (async () => {
            const gone = !(await page.$('#wfPostUpdate'));
            await reloadAndLogin(); await sleep(2500);
            return gone && !(await page.$('#wfPostUpdate'));
        })());
    }
    note('no uncaught page errors', dev.errors.length === 0, dev.errors.join(' | ').slice(0, 300));
} catch (e) {
    note('the journey ran to the end without an exception', false, String((e && e.stack) || e).slice(0, 500));
} finally {
    await w.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
