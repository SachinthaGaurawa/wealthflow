/* =============================================================================
 * test/e2e/tenant-responsive.mjs — the tenant's page on every kind of screen
 * -----------------------------------------------------------------------------
 * The page is opened from a text message, so it meets every device there is: a 240 px feature phone, a
 * folded foldable, a phone held sideways, a tablet, a laptop, a 4K monitor, a browser zoomed to 400 %.
 * For each of those, on the sign-in screens and on a full statement (English and Sinhala), this asks the
 * browser, not the stylesheet:
 *   - the page never scrolls sideways, and nothing sticks out past the screen's edge
 *   - nothing is cut off (no clipped text, no table column hidden without a way to reach it)
 *   - every button and field can be hit with a thumb (44 px) and no text is smaller than 12 px
 *   - fields are 16 px or more, so a phone does not zoom in when one is touched
 *   - on a wide screen the page stays a readable column, centred, and does not stretch
 *   - the print layout fits an A4 page
 *
 * The page talks to the REAL handler (tenant-portal.js) over an in-memory Firestore and a stub gateway.
 *
 * Run from the repository root:  node test/e2e/tenant-responsive.mjs
 * Set WF_TENANT_SHOTS=<dir> to keep a picture of each screen for a person to look at.
 * ===========================================================================*/
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchChromium } from './harness.mjs';
import { handlePortal } from '../../tenant-portal.js';
import { ensureTenantToken, portalSecret } from '../../tenant-links.mjs';
import { createFirestore } from '../helpers/fake-firestore.js';
import { normalizeNic } from '../../wealthflow-nic.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const PAGE_HEADERS = Object.fromEntries(VERCEL.headers.find((h) => h.source === '/t/(.*)').headers.map((h) => [h.key, h.value]));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2' };

const ENV = { TENANT_PORTAL_SECRET: 'e2e-secret-'.repeat(4) };
const NIC = '853400937V';
const CANON = normalizeNic(NIC).canonical;
const NOW = Date.now();

/* ── a book that stresses the layout: long names, long numbers, big amounts, many rows ─ */
const fsx = createFirestore();
const db = fsx.db;
{ const orig = db.runTransaction.bind(db); let chain = Promise.resolve(); db.runTransaction = (fn) => { const p = chain.then(() => orig(fn)); chain = p.catch(() => {}); return p; }; }
const received = {};
for (let m = 1; m <= 9; m += 1) received[`inv1_2026-0${m}`] = { amount: 1234567.89, confirmedAt: NOW - (40 + m) * 86400e3 };
fsx.data.set('users/owner1', {
    settings: { currency: 'LKR' },
    payAccounts: [
        { id: 'acc1', bank: 'Hatton National Bank PLC (Colombo Fort Corporate Branch)', holder: 'Wickramasinghe Mudiyanselage Kumara Perera Bandara', number: '123456789012345678901234', branch: 'Colombo Fort Corporate Banking Centre', swift: 'HBLILKLXXXX', note: 'Please put your reference in the transfer and send us the slip on WhatsApp after you pay, so that we can confirm it the same day.', showTo: 'both', active: true, createdAt: '2026-01-01', _ut: 1 },
        { id: 'acc2', bank: 'DFCC Bank', holder: 'S. G. Gaurawa', number: '101001234567', branch: 'Kandy', swift: '', note: '', showTo: 'both', active: true, createdAt: '2026-01-02', _ut: 2 },
    ],
    income: [{ id: 'inv1', name: 'nick', company: 'nick', fullName: 'Wickramasinghe Mudiyanselage Kumara Perera Bandara', amount: 98765432.1, rate: 24, freq: 'monthly', start: '2026-01-05', day: '2026-01-05', sms_notifications_enabled: true, sms_enabled_at: NOW - 30 * 86400e3, nic: NIC, phone: '077 123 4567' }],
    incomeReceived: received,
    debtors: [{ id: 'deb1', name: 'nick', fullName: 'Wickramasinghe Mudiyanselage Kumara Perera Bandara', dueISO: new Date(NOW + 330 * 60000 - 4 * 86400e3).toISOString().slice(0, 10), phone: '077 123 4567', nic: NIC, sms_notifications_enabled: true, sms_enabled_at: NOW - 30 * 86400e3, events: [
        { id: 'e1', kind: 'lent', amount: 12345678.9, date: '2026-09-01', confirmed: true },
        { id: 'e2', kind: 'repayment', amount: 2000000, date: '2026-09-20', confirmed: true },
        { id: 'e3', kind: 'repayment', amount: 1500000, date: '2026-09-25', confirmed: true },
        { id: 'e4', kind: 'topup', amount: 500000, date: '2026-09-28', confirmed: true }] }],
});
const TOKEN = await ensureTenantToken({ db, uid: 'owner1', canonicalNic: CANON, secret: portalSecret(ENV), now: NOW - 1000 });

const sent = [];
const gateway = { configured: true, senderId: 'WealthFlow', async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; } };
const deps = { client: () => gateway, getAdminDb: async () => ({ db }), env: ENV, now: () => Date.now(), randomInt: crypto.randomInt, randomBytes: crypto.randomBytes, pad: null };

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/tenant-portal') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (_) { req.body = undefined; }
            await handlePortal(req, res, deps);
        });
        return;
    }
    let file = url.pathname;
    const headers = {};
    if (/^\/t\/[A-Za-z0-9_-]{16}$/.test(file)) { file = '/tenant.html'; Object.assign(headers, PAGE_HEADERS); }
    const f = path.resolve(ROOT, '.' + file);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
    if (!/^\/(tenant\.html|tenant-page\.(js|css)|tenant-logo\.png|tenant-inter\.woff2|tenant-(lang|tools)\.js|wealthflow-nic\.js)$/.test(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', ...headers });
    res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ── the screens people really use (CSS pixels, as the browser reports them) ─────────── */
const DEVICES = [
    // [name, width, height, touch]
    ['feature phone', 240, 320, true],
    ['Galaxy Fold, folded', 280, 653, true],
    ['iPhone SE (1st gen)', 320, 568, true],
    ['small Android', 360, 640, true],
    ['iPhone SE / 8', 375, 667, true],
    ['iPhone 14', 390, 844, true],
    ['Pixel 7', 412, 915, true],
    ['iPhone Pro Max', 430, 932, true],
    ['phone, landscape (small)', 568, 320, true],
    ['phone, landscape', 667, 375, true],
    ['phone, landscape (large)', 915, 412, true],
    ['Galaxy Fold, opened', 673, 841, true],
    ['small tablet', 600, 960, true],
    ['iPad mini', 744, 1133, true],
    ['iPad', 820, 1180, true],
    ['tablet, landscape', 1180, 820, true],
    ['laptop', 1366, 768, false],
    ['desktop', 1920, 1080, false],
    ['large monitor', 2560, 1440, false],
    ['ultrawide', 3440, 1440, false],
    ['browser zoomed to 400 percent', 320, 256, false],
];

const browser = await launchChromium({ headless: true });
const problems = [];
const shotsDir = process.env.WF_TENANT_SHOTS;
if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* what a screen gets wrong, judged by the browser's own layout ----------------------- */
function audit(touch) {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const sideways = document.documentElement.scrollWidth - vw;
    if (sideways > 1) out.push(`the page scrolls sideways by ${sideways}px`);
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && el.getClientRects().length > 0 && !el.closest('[hidden]') && !el.closest('.tp-offscreen'); };
    const name = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
    for (const el of document.querySelectorAll('body *')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        const scroller = el.closest('.tp-scroll');
        // nothing may stick out of the screen, unless it sits inside a box that scrolls on purpose
        if (!scroller || el === scroller) {
            if (r.right > vw + 1) out.push(`${name(el)} sticks out past the right edge (${Math.round(r.right)} > ${vw})`);
            if (r.left < -1) out.push(`${name(el)} sticks out past the left edge (${Math.round(r.left)})`);
        }
        // text that is cut off rather than wrapped
        const cs = getComputedStyle(el);
        if (!scroller && el.children.length === 0 && el.textContent.trim() && (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1) out.push(`${name(el)} cuts its text off`);
        // the size of text
        if (el.children.length === 0 && el.textContent.trim() && parseFloat(cs.fontSize) < 12) out.push(`${name(el)} text is ${cs.fontSize}, under 12px`);
    }
    // a thumb needs 44 px; a field needs 16 px so a phone does not zoom
    for (const el of document.querySelectorAll('button, input, a[href], select, textarea')) {
        if (!visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (touch && (r.height < 43.5 || r.width < 43.5) && !el.classList.contains('tp-chip')) out.push(`${name(el)} is ${Math.round(r.width)}x${Math.round(r.height)}, too small to touch`);
        if (/^(input|select|textarea)$/i.test(el.tagName) && parseFloat(getComputedStyle(el).fontSize) < 16) out.push(`${name(el)} font is under 16px, a phone would zoom in`);
    }
    // a table that scrolls must say so by being able to scroll; one that doesn't must fit
    for (const el of document.querySelectorAll('.tp-scroll')) {
        if (!visible(el)) continue;
        const ox = getComputedStyle(el).overflowX;
        if (el.scrollWidth > el.clientWidth + 1 && !/auto|scroll/.test(ox)) out.push(`${name(el)} hides a column it cannot scroll to`);
    }
    // the column stays readable on a wide screen
    const wrap = document.querySelector('.tp-wrap');
    if (wrap) { const wr = wrap.getBoundingClientRect(); if (wr.width > 1300) out.push(`the page stretches to ${Math.round(wr.width)}px`); const gap = Math.abs((wr.left) - (vw - wr.right)); if (wr.width < vw - 2 && gap > 2) out.push(`the column is not centred (${Math.round(wr.left)} left, ${Math.round(vw - wr.right)} right)`); }
    return out;
}

async function inspect(page, label, touch) {
    const found = await page.evaluate(audit, touch);
    for (const f of found) problems.push(`${label}: ${f}`);
}

const shot = async (page, name) => { if (!shotsDir) return; await page.waitForTimeout(700); await page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: true }); };

/* sign in once; the cookie is the session, so every later screen only has to reload ---- */
const first = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p1 = await first.newPage();
await p1.goto(`${base}/t/${TOKEN}`);
await p1.waitForSelector('#tp-nic');
await p1.fill('#tp-nic', NIC);
await p1.click('#tp-send');
await p1.waitForSelector('#tp-code');
const code = /^(\d{6}) is your WealthFlow/.exec(sent.at(-1).message)[1];
await p1.fill('#tp-code', code);
await p1.click('#tp-verify');
await p1.waitForSelector('#tp-out');
const cookies = await first.cookies();
await first.close();

let n = 0;
for (const [device, width, height, touch] of DEVICES) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch && width < 1000, deviceScaleFactor: touch ? 2 : 1 });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${device}: pageerror ${e.message}`));
    const tag = `${String(width).padStart(4, '0')}x${height}-${slug(device)}`;

    // the sign-in screens (a fresh context has no session)
    const bare = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch && width < 1000, deviceScaleFactor: touch ? 2 : 1 });
    const bp = await bare.newPage();
    await bp.goto(`${base}/t/${TOKEN}`);
    await bp.waitForSelector('#tp-nic');
    await inspect(bp, `${device} ${width}x${height}, NIC form`, touch);
    await shot(bp, `${tag}-1-nic`);
    await bp.fill('#tp-nic', '1234');
    await bp.click('#tp-send');
    await bp.waitForFunction(() => document.getElementById('tp-err') && document.getElementById('tp-err').textContent.length > 0);
    await inspect(bp, `${device} ${width}x${height}, NIC form with an error`, touch);
    await bare.close();

    // the statement, English then Sinhala
    await page.goto(`${base}/t/${TOKEN}`);
    await page.waitForSelector('#tp-out');
    await inspect(page, `${device} ${width}x${height}, statement`, touch);
    await shot(page, `${tag}-2-statement`);
    await page.click('#tp-lang');
    await page.waitForFunction(() => document.getElementById('tp-lang').textContent !== 'සිංහල');
    await inspect(page, `${device} ${width}x${height}, statement in Sinhala`, touch);
    await shot(page, `${tag}-3-statement-si`);
    await ctx.close();
    n += 1;
}
console.log(`${n} screens checked, each on the sign-in forms and on a full statement in English and Sinhala`);

/* the dark theme follows the phone: the same checks on three sizes, and the page really is dark ---- */
for (const [device, width, height, touch] of [['dark phone', 390, 844, true], ['dark tablet', 744, 1133, true], ['dark laptop', 1366, 768, false]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, colorScheme: 'dark', deviceScaleFactor: touch ? 2 : 1 });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${device}: pageerror ${e.message}`));
    const tag = `${String(width).padStart(4, '0')}x${height}-${slug(device)}`;
    await page.goto(`${base}/t/${TOKEN}`);
    await page.waitForSelector('#tp-out');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    if (r + g + b > 150) problems.push(`${device}: the page is not dark (${bg})`);
    await inspect(page, `${device} ${width}x${height}, statement`, touch);
    await shot(page, `${tag}-2-statement`);
    await ctx.close();
    const bare = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, colorScheme: 'dark' });
    const bp = await bare.newPage();
    await bp.goto(`${base}/t/${TOKEN}`);
    await bp.waitForSelector('#tp-nic');
    await inspect(bp, `${device} ${width}x${height}, NIC form`, touch);
    await shot(bp, `${tag}-1-nic`);
    await bare.close();
}
console.log('the dark theme was checked on a phone, a tablet and a laptop');

/* the print layout fits an A4 page --------------------------------------------------- */
{
    const ctx = await browser.newContext({ viewport: { width: 794, height: 1123 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(`${base}/t/${TOKEN}`);
    await page.waitForSelector('#tp-out');
    await page.emulateMedia({ media: 'print' });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) problems.push(`print layout is ${over}px wider than an A4 page`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'print-a4.png'), fullPage: true });
    await ctx.close();
}

await browser.close();
server.close();
assert.deepEqual(problems, [], 'the page does not fit every screen:\n  ' + problems.join('\n  '));
console.log('the tenant page fits every screen it was tried on');
