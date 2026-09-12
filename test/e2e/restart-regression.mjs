/** Real-browser regression: deployment discovery must preserve live edits. */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const source = await fs.readFile('wealthflow-live-update.js', 'utf8');
const rich = await fs.readFile('wealthflow-update-system.js', 'utf8');
const browser = await chromium.launch({ headless: true });
try {
    for (const width of [320, 390, 768, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        await page.setContent('<input id="draft" value="Unsaved transaction"><span id="wfVerText">running build</span>');
        await page.evaluate(() => {
            window.__sha = 'old'; window.__calls = 0; window.__refreshes = 0;
            window._wfFetchT = async () => { window.__calls++; return { ok: true, json: async () => ({ sha: window.__sha, version: '99.0.0' }) }; };
            window.__worker = new EventTarget();
            window.__worker.getRegistration = async () => ({ update: async () => { window.__refreshes++; }, addEventListener() {} });
            Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: window.__worker });
            // Exercise inaccessible storage plus a historical update marker.
            Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw Error('storage disabled'); } });
            const store = new Map([['wf_update_pending', 'obsolete']]);
            Object.defineProperty(window, 'localStorage', { configurable: true, value: {
                getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k), get length() { return store.size; }, key: i => [...store.keys()][i]
            }});
        });
        let navigations = 0;
        page.on('framenavigated', () => { navigations++; });
        await page.addScriptTag({ content: source });
        await page.addScriptTag({ content: rich.replace('window.wfUpdate = {', 'window.wfUpdate = { _watchServiceWorker,') });
        await page.evaluate(async () => {
            wfUpdate._watchServiceWorker();
            await wfLiveUpdate._check(); window.__sha = 'new';
            await Promise.all(Array.from({ length: 20 }, () => wfLiveUpdate._check()));
            wfLiveUpdate.start(); wfLiveUpdate.start();
            for (let i = 0; i < 20; i++) {
                document.querySelector('#draft').focus();
                window.dispatchEvent(new Event('focus'));
                document.dispatchEvent(new Event('visibilitychange'));
                window.__worker.dispatchEvent(new Event('controllerchange'));
                await wfLiveUpdate._check();
            }
        });
        assert.equal(navigations, 0, `${width}px: background update navigated`);
        assert.equal(await page.locator('#draft').inputValue(), 'Unsaved transaction');
        assert.equal(await page.locator('#wfVerText').textContent(), 'running build');
        assert.equal(await page.evaluate(() => window.__refreshes), 2); // live + rich background checks
        assert.equal(await page.evaluate(() => wfLiveUpdate.pendingSha()), 'new');
        console.log(`${width}px: draft preserved, no restart, one staged deployment`);
        await page.close();
    }
} finally { await browser.close(); }
