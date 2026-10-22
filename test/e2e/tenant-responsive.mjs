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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

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
// the server's clock can be moved forward, so that a later screen gets a fresh hour of the per-address and per-link limits (the earlier sessions are not needed by then)
let skew = 0;
const deps = { client: () => gateway, getAdminDb: async () => ({ db }), env: ENV, now: () => Date.now() + skew, randomInt: crypto.randomInt, randomBytes: crypto.randomBytes, pad: null };

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
    if (!/^\/(tenant\.html|tenant-page\.(js|css)|tenant-logo\.png|assets\/wf-mark\.svg|tenant-inter\.woff2|tenant-(lang|tools)\.js|wealthflow-nic\.js)$/.test(file)) { res.writeHead(404); return res.end('not found'); }
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
        if (!scroller && cs.clipPath === 'none' && el.children.length === 0 && el.textContent.trim() && (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1) out.push(`${name(el)} cuts its text off`);
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
    // the name in the header is one line (it may hide on the tiniest screens, but it never breaks mid-word: "WealthFl / ow")
    for (const el of document.querySelectorAll('.tp-brand span')) {
        const r = el.getBoundingClientRect();
        if (r.width > 4 && r.height > parseFloat(getComputedStyle(el).fontSize) * 1.6) out.push(`the wordmark wraps onto two lines (${Math.round(r.width)}x${Math.round(r.height)})`);
    }
    // legibility, judged from the colours the browser actually paints: text 4.5:1 (3:1 when large), the outline of a field 3:1, a placeholder 4.5:1
    const rgba = (c) => { const m = /^rgba?\(([^)]+)\)$/.exec(c || ''); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    // the colour behind an element: its own and its ancestors' backgrounds laid over each other; null where a gradient makes that unknowable
    const behind = (el) => {
        const stack = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (/gradient\(/.test(cs.backgroundImage)) return null;
            const c = rgba(cs.backgroundColor);
            if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
        }
        let base = { r: 255, g: 255, b: 255, a: 1 };
        for (const c of stack.reverse()) base = over(c, base);
        return base;
    };
    for (const el of document.querySelectorAll('body *')) {
        if (!visible(el) || el.closest('button:disabled') || (el.disabled === true)) continue;
        const cs = getComputedStyle(el);
        const bg = behind(el);
        if (!bg) continue;
        if (el.children.length === 0 && el.textContent.trim() && !(el instanceof SVGElement)) {
            const fg = rgba(cs.color);
            if (!fg) continue;
            const text = over(fg, bg);
            const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
            const need = big ? 3 : 4.5;
            const got = ratio(text, bg);
            if (got < need) out.push(`${name(el)} "${el.textContent.trim().slice(0, 24)}" reads at ${got.toFixed(2)}:1 (needs ${need}:1)`);
        }
        if (/^(input|select)$/i.test(el.tagName)) {
            const edge = rgba(cs.borderTopColor);
            const parentBg = el.parentElement ? behind(el.parentElement) : null;
            if (edge && parentBg && parseFloat(cs.borderTopWidth) > 0) { const got = ratio(over(edge, parentBg), parentBg); if (got < 3) out.push(`${name(el)} has an outline at ${got.toFixed(2)}:1 (a field needs 3:1)`); }
            if (el.placeholder) { const ph = rgba(getComputedStyle(el, '::placeholder').color); const own = rgba(cs.backgroundColor); if (ph && own) { const got = ratio(over(ph, own), own); if (got < 4.5) out.push(`${name(el)} placeholder reads at ${got.toFixed(2)}:1 (needs 4.5:1)`); } }
        }
    }
    // the column stays readable on a wide screen
    const wrap = document.querySelector('.tp-wrap');
    if (wrap) { const wr = wrap.getBoundingClientRect(); if (wr.width > 1300) out.push(`the page stretches to ${Math.round(wr.width)}px`); const gap = Math.abs((wr.left) - (vw - wr.right)); if (wr.width < vw - 2 && gap > 2) out.push(`the column is not centred (${Math.round(wr.left)} left, ${Math.round(vw - wr.right)} right)`); }
    return out;
}

async function inspect(page, label, touch) {
    // let every finishing transition and entrance animation end first: a colour caught half-way between two themes is not what a person sees
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState === 'finished' || a.playState === 'idle' || !a.effect || a.effect.getTiming().iterations === Infinity), null, { timeout: 5000 });
    const found = await page.evaluate(audit, touch);
    for (const f of found) problems.push(`${label}: ${f}`);
}

/**
 * Every piece of text against what is really painted behind it (WCAG 1.4.3: 4.5:1, or 3:1 for large text). A tool that reads the stylesheet cannot say
 * what a translucent tile over a gradient looks like, so this one looks: it lists the text and where it sits, paints the page with the text made
 * invisible, and measures the colour under every piece, in the worst of up to 400 places along it.
 */
let decoder = null;
async function contrast(page, label) {
    // The page is made as tall as its content, so the whole of it is one picture, and the text is listed in THAT layout: a taller window can move
    // things a few pixels, and a measurement taken from the old positions would be reading the colour of the wrong place.
    const view = page.viewportSize();
    let picture;
    let items;
    try {
        let tall = 0;
        for (let i = 0; i < 4; i += 1) {
            const now = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
            if (now === tall) break;
            tall = now;
            await page.setViewportSize({ width: view.width, height: Math.max(view.height, tall) });
            await page.waitForTimeout(150);
        }
        items = await page.evaluate(() => {
            const out = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            const seen = new Set();
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!node.textContent.trim()) continue;
                const el = node.parentElement;
                if (!el || seen.has(el)) continue;
                const cs = getComputedStyle(el);
                if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[hidden], [aria-hidden="true"]')) continue;
                let opacity = 1;
                for (let e = el; e; e = e.parentElement) opacity *= Number(getComputedStyle(e).opacity);
                const range = document.createRange();
                range.selectNodeContents(node);
                const box = [...range.getClientRects()].find((q) => q.width > 1 && q.height > 1);
                if (!box) continue;
                seen.add(el);
                out.push({ text: node.textContent.trim().slice(0, 36), where: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').join('.') : ''), color: cs.color, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400, opacity, x: box.left + scrollX, y: box.top + scrollY, w: box.width, h: box.height, width: document.documentElement.scrollWidth });
            }
            return out;
        });
        await page.evaluate(() => { const sheet = new CSSStyleSheet(); sheet.replaceSync('*,*::before,*::after{color:transparent !important;-webkit-text-fill-color:transparent !important;text-shadow:none !important;caret-color:transparent !important}'); window.__bare = sheet; document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; });
        picture = await page.screenshot({ fullPage: false });
        await page.evaluate(() => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== window.__bare); });
    } finally {
        await page.setViewportSize(view);
    }
    if (!decoder) { decoder = await (await browser.newContext()).newPage(); await decoder.goto('about:blank'); }
    const weak = await decoder.evaluate(async ({ b64, items: list }) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        const lum = (r, gr, b) => 0.2126 * lin(r) + 0.7152 * lin(gr) + 0.0722 * lin(b);
        const bad = [];
        for (const it of list) {
            const k = img.width / it.width;                                           // the picture is taken at the device's pixel ratio
            const [cr, cg, cb, ca] = it.color.match(/[\d.]+/g).map(Number);
            const a = (ca === undefined ? 1 : ca) * it.opacity;
            const x0 = Math.max(0, Math.floor(it.x * k)), y0 = Math.max(0, Math.floor(it.y * k));
            const w = Math.min(Math.ceil(it.w * k), img.width - x0), h = Math.min(Math.ceil(it.h * k), img.height - y0);
            if (w < 1 || h < 1) continue;
            const data = g.getImageData(x0, y0, w, h).data;
            const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 400)));
            let worst = 99, under = '';
            for (let yy = 0; yy < h; yy += step) for (let xx = 0; xx < w; xx += step) {
                const i = (yy * w + xx) * 4;
                const l1 = lum(cr * a + data[i] * (1 - a), cg * a + data[i + 1] * (1 - a), cb * a + data[i + 2] * (1 - a)), l2 = lum(data[i], data[i + 1], data[i + 2]);
                const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
                if (ratio < worst) { worst = ratio; under = `${data[i]},${data[i + 1]},${data[i + 2]}`; }
            }
            const large = it.size >= 24 || (it.size >= 18.66 && it.weight >= 700);
            if (worst < (large ? 3 : 4.5)) bad.push(`"${it.text}" in ${it.where} at ${Math.round(it.x)},${Math.round(it.y)} is ${worst.toFixed(2)}:1 (needs ${large ? 3 : 4.5}:1; text ${it.color} x${a.toFixed(2)} on ${under})`);
        }
        return bad;
    }, { b64: picture.toString('base64'), items });
    for (const w of weak) problems.push(`${label}: text is hard to read, ${w}`);
    return items.length;
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
let contrasted = 0;                      // pieces of text whose contrast was measured against the painted page
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
    await bp.click('#tp-theme');   // dark
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
    if (width === 390) contrasted += await contrast(page, `${device}, statement`);
    await shot(page, `${tag}-2-statement`);
    await page.click('#tp-lang');
    await page.waitForFunction(() => document.getElementById('tp-lang').textContent !== 'සිංහල');
    await inspect(page, `${device} ${width}x${height}, statement in Sinhala`, touch);
    if (width === 390) contrasted += await contrast(page, `${device}, statement in Sinhala`);
    await shot(page, `${tag}-3-statement-si`);
    await ctx.close();
    n += 1;
}
console.log(`${n} screens checked, each on the sign-in forms and on a full statement in English and Sinhala`);

/* the dark theme, chosen with the button: the same checks on three sizes, and the page really is dark ---- */
for (const [device, width, height, touch] of [['dark phone', 390, 844, true], ['dark tablet', 744, 1133, true], ['dark laptop', 1366, 768, false]]) {
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, colorScheme: 'dark', deviceScaleFactor: touch ? 2 : 1 });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`${device}: pageerror ${e.message}`));
    const tag = `${String(width).padStart(4, '0')}x${height}-${slug(device)}`;
    await page.goto(`${base}/t/${TOKEN}`);
    await page.waitForSelector('#tp-out');
    const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r0, g0, b0] = (await paper()).match(/\d+/g).map(Number);
    if (r0 + g0 + b0 < 600) problems.push(`${device}: the page opens dark on a dark device without being asked (the default is light, and there is no automatic mode)`);
    await page.click('#tp-theme');   // light -> dark: the person's choice (there is no automatic mode)
    const bg = await paper();
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    if (r + g + b > 150) problems.push(`${device}: the page is not dark (${bg})`);
    await inspect(page, `${device} ${width}x${height}, statement`, touch);
    if (width === 390) contrasted += await contrast(page, `${device}, statement`);
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

/* the sign-in answers: the loading screen, a refused NIC (with the warning that follows a few), and the code screen that names the phone ---- */
// Each screen gets its own hour on the server's clock (the limits are per address and per link), and this runs last: moving the clock ends the earlier session.
async function signInStates(device, width, height, touch, dark) {
    skew += 3 * 3600e3;
    const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch && width < 1000, deviceScaleFactor: touch ? 2 : 1 });
    const page = await ctx.newPage();
    const label = `${device} ${width}x${height}${dark ? ', dark' : ''}`;
    const tag = `${String(width).padStart(4, '0')}x${height}-${slug(device)}${dark ? '-dark' : ''}`;
    page.on('pageerror', (e) => problems.push(`${label}: pageerror ${e.message}`));
    // the loading screen, held on screen by a slow first answer
    let calls = 0;
    let release;
    const held = new Promise((r) => { release = r; });
    await page.route('**/api/tenant-portal', async (route) => { calls += 1; if (calls === 1) await held; await route.continue(); });
    await page.goto(`${base}/t/${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.tp-splash')).opacity) === 1 && document.querySelector('.tp-splash-status').textContent.length > 0);
    if (dark) await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(dark ? 400 : 0);
    await inspect(page, `${label}, loading screen`, touch);
    await shot(page, `${tag}-0-loading`);
    release();
    await page.waitForSelector('#tp-nic');
    if (dark) await page.click('#tp-theme');
    // three wrong NICs: the refusal, then the hint that turns into a warning
    for (const nic of ['198534000999', '198534000998', 'N7654321']) {
        await page.fill('#tp-nic', nic);
        await page.click('#tp-send');
        await page.waitForFunction(() => /could not verify these details/i.test(document.getElementById('tp-err').textContent));
        if (nic === '198534000999') {
            await inspect(page, `${label}, details refused`, touch);
            await shot(page, `${tag}-1b-refused`);
        }
    }
    await page.waitForFunction(() => /Still not matching/.test(document.getElementById('tp-help').textContent));
    await inspect(page, `${label}, details refused three times`, touch);
    if (width === 390) contrasted += await contrast(page, `${label}, details refused three times`);
    await shot(page, `${tag}-1c-refused-warning`);
    // the right NIC: the code screen names the phone
    await page.fill('#tp-nic', NIC);
    await page.click('#tp-send');
    await page.waitForSelector('#tp-code');
    const info = await page.textContent('#tp-sent');
    if (!/\+94 •• ••• •567/.test(info) || /771234567|4567/.test(info)) problems.push(`${label}: the code screen should name only the last three digits (${info})`);
    const sentBox = await page.evaluate(() => { const r = document.querySelector('#tp-sent').getBoundingClientRect(); const n = document.querySelector('#tp-sent .tp-sent-num'); return { right: r.right, vw: document.documentElement.clientWidth, numWraps: n.getClientRects().length > 1 || n.scrollWidth > n.clientWidth + 1 }; });
    if (sentBox.right > sentBox.vw + 1 || sentBox.numWraps) problems.push(`${label}: the phone card is cut off or its number breaks (${JSON.stringify(sentBox)})`);
    await inspect(page, `${label}, code screen`, touch);
    if (width === 390) contrasted += await contrast(page, `${label}, code screen`);
    await shot(page, `${tag}-1d-code`);
    const code2 = /^(\d{6}) is your WealthFlow/.exec(sent.at(-1).message)[1];
    await page.fill('#tp-code', code2);
    await page.click('#tp-verify');
    await page.waitForSelector('#tp-out');     // and the lock counters are clear again for the next screen
    await ctx.close();
}
for (const d of [['feature phone', 240, 320, true], ['iPhone SE (1st gen)', 320, 568, true], ['iPhone 14', 390, 844, true], ['phone, landscape', 667, 375, true], ['iPad mini', 744, 1133, true], ['laptop', 1366, 768, false], ['desktop', 1920, 1080, false]]) await signInStates(...d, false);
for (const d of [['dark phone', 390, 844, true], ['dark laptop', 1366, 768, false]]) await signInStates(...d, true);
console.log('the loading screen, a refused NIC (and its warning) and the code screen were checked on seven screens and two dark ones');
console.log(`${contrasted} pieces of text were measured against the page behind them (4.5:1, or 3:1 for large text)`);
assert.ok(contrasted > 100, 'the contrast check looked at a real amount of text');

await browser.close();
server.close();
assert.deepEqual(problems, [], 'the page does not fit every screen:\n  ' + problems.join('\n  '));
console.log('the tenant page fits every screen it was tried on');
