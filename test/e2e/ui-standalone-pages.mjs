/** Browser regression for the two small pages that sit outside the app shell: share-target.html (the Quick Capture page the
 * phone's Share sheet opens) and 404.html (the old-host redirect notice). Both must be on the WealthFlow design tokens, the
 * share page must follow the theme saved by the app, nothing may scroll sideways on a phone, and the capture flow must still
 * show its result. Real Chromium, the API stubbed. Run from the repository root:  node test/e2e/ui-standalone-pages.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { launchChromium } from './harness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
    const p = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
    fs.readFile(p, (e, b) => {
        if (e) { r.writeHead(404); r.end(); return; }
        r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); r.end(b);
    });
}).listen(0);
const base = `http://localhost:${srv.address().port}`;
const browser = await launchChromium();
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };
const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

for (const theme of ['dark', 'light']) {
    for (const W of [390, 1280]) {
        const ctx = await browser.newContext({ viewport: { width: W, height: 780 }, colorScheme: theme === 'dark' ? 'light' : 'dark' });
        const page = await ctx.newPage();
        await page.addInitScript((t) => { try { localStorage.setItem('wf2_settings', JSON.stringify({ theme: t })); } catch (_) {} }, theme);
        await page.route('**/api/sms-ingest', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, classified: true, routed: { module: 'expenses', suggested_fields: { desc: 'Keells <img src=x onerror="window.__xss=1">', amount: 4250 } }, parsed: { currency: 'LKR' } }),
        }));
        const tag = `share-target ${theme} ${W}`;
        await page.goto(`${base}/share-target.html`);
        await page.waitForTimeout(400);
        const got = await page.evaluate(() => ({
            theme: document.documentElement.getAttribute('data-theme'),
            bg: getComputedStyle(document.body).backgroundColor,
            btn: getComputedStyle(document.getElementById('goBtn')).backgroundColor,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            logo: !!document.querySelector('img.brand') && document.querySelector('img.brand').complete && document.querySelector('img.brand').naturalWidth > 0,
            zoomLocked: /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(document.querySelector('meta[name=viewport]').content),
            taFont: parseFloat(getComputedStyle(document.getElementById('txt')).fontSize),
        }));
        check(got.theme === theme, `${tag}: page theme is ${got.theme}, the app saved ${theme}`);
        check(theme === 'dark' ? lum(got.bg) < 0.2 : lum(got.bg) > 0.8, `${tag}: background ${got.bg} does not match the ${theme} theme`);
        check(got.btn !== 'rgb(16, 185, 129)' && !/gradient/.test(got.btn), `${tag}: primary button still uses the old green/gold gradient`);
        check(got.overflowX <= 0, `${tag}: page scrolls sideways by ${got.overflowX}px`);
        check(got.logo, `${tag}: WealthFlow mark did not load`);
        check(!got.zoomLocked, `${tag}: viewport blocks pinch zoom`);
        check(got.taFont >= 16, `${tag}: textarea is ${got.taFont}px, iOS would zoom the page on focus`);
        await page.fill('#txt', 'Spent LKR 4,250.00 at Keells on card ending 1234');
        await page.click('#goBtn');
        await page.waitForSelector('#result.ok', { timeout: 4000 }).catch(() => {});
        const res = await page.evaluate(() => document.getElementById('result').innerText);
        check(/Logged as/.test(res) && /4,250/.test(res), `${tag}: capture result did not render ("${res.slice(0, 60)}")`);
        await page.waitForTimeout(300);
        const injected = await page.evaluate(() => ({ ran: !!window.__xss, img: !!document.querySelector('#result img') }));
        check(!injected.ran && !injected.img, `${tag}: text echoed from the shared SMS was parsed as markup`);
        check(/<img src=x/.test(res), `${tag}: echoed text should be shown literally, got "${res.slice(0, 80)}"`);
        await ctx.close();
    }
}

for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(`${base}/404.html`);
    const got = await page.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        font: getComputedStyle(document.body).fontFamily,
        link: !!document.querySelector('a[href="https://www.wealthflow.lk"]'),
        mark: !!document.querySelector('img[alt="WealthFlow"]'),
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    const tag = `404 ${scheme}`;
    check(scheme === 'dark' ? lum(got.bg) < 0.2 : lum(got.bg) > 0.8, `${tag}: background ${got.bg} does not follow the device scheme`);
    check(!/^"?Times/i.test(got.font), `${tag}: still the browser's default serif font`);
    check(got.link && got.mark, `${tag}: link to www.wealthflow.lk or the logo is missing`);
    check(got.overflowX <= 0, `${tag}: page scrolls sideways`);
    await ctx.close();
}

await browser.close(); srv.close();
if (fail.length) { console.error(fail.map((f) => ' - ' + f).join('\n')); process.exit(1); }
console.log('ui-standalone-pages: share-target and 404 on the design tokens, both themes, no sideways scroll, capture flow intact');
