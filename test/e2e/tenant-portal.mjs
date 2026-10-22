/* =============================================================================
 * test/e2e/tenant-portal.mjs — the tenant's page, in a real Chromium, against the real endpoint
 * -----------------------------------------------------------------------------
 * The unit tests pin the rules; this asks the browser: that /t/<token> opens, that the page runs under
 * the SAME Content-Security-Policy vercel.json sends (no inline script, style or foreign host), that a
 * tenant can go NIC -> code -> statement, that the statement carries no name or note, that the session
 * cookie cannot be read by script, that a reload within the session needs no new text, that signing out
 * really signs out, that a wrong code is refused and five lock the link, and that nothing overflows
 * a 320 px phone.
 *
 * The page talks to the REAL handler (tenant-portal.js) over an in-memory Firestore and a stub gateway.
 * Nothing here touches a network, a real number or the owner's data.
 *
 * Run from the repository root:  node test/e2e/tenant-portal.mjs
 * ===========================================================================*/
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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

/* ── a lender's book, with private words that must never reach the page ──── */
const fsx = createFirestore();
const db = fsx.db;
{ const orig = db.runTransaction.bind(db); let chain = Promise.resolve(); db.runTransaction = (fn) => { const p = chain.then(() => orig(fn)); chain = p.catch(() => {}); return p; }; }
fsx.data.set('users/owner1', {
    settings: { currency: 'LKR' },
    payAccounts: [
        { id: 'acc1', bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'PLEASE WRITE YOUR NIC IN THE PAYMENT REFERENCES', showTo: 'both', active: true, createdAt: '2026-01-01', _ut: 1 },
        { id: 'acc2', bank: 'Closed Bank', holder: 'Old Account', number: '1111222233', showTo: 'both', active: false, createdAt: '2026-01-02' },
    ],
    income: [{ id: 'inv1', name: 'PRIVATE DEPOSIT NAME', company: 'PRIVATE COMPANY', notes: 'PRIVATE NOTE <b>x</b>', amount: 500000, rate: 24, freq: 'monthly', start: '2026-01-05', day: '2026-01-05', sms_notifications_enabled: true, sms_enabled_at: NOW - 30 * 86400e3, nic: NIC, phone: '077 123 4567' }],
    incomeReceived: { 'inv1_2026-08': { amount: 10000, confirmedAt: NOW - 40 * 86400e3 } },
    debtors: [{ id: 'deb1', name: 'PRIVATE DEBTOR', notes: 'PRIVATE OPINION', dueISO: new Date(NOW + 330 * 60000 - 4 * 86400e3).toISOString().slice(0, 10), phone: '077 123 4567', nic: NIC, sms_notifications_enabled: true, sms_enabled_at: NOW - 30 * 86400e3, events: [
        { id: 'e1', kind: 'lent', amount: 50000, date: '2026-09-01', confirmed: true },
        { id: 'e2', kind: 'repayment', amount: 20000, date: '2026-09-20', confirmed: true },
        { id: 'e3', kind: 'repayment', amount: 777, date: '2026-09-21', confirmed: false }] }],
});
const TOKEN = await ensureTenantToken({ db, uid: 'owner1', canonicalNic: CANON, secret: portalSecret(ENV), now: NOW - 1000 });

const sent = [];
const gateway = { configured: true, senderId: 'WealthFlow', async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; } };
let skew = 0;             // the server's clock can be moved forward (the 60 s gap between two texts for one link), after the sections that need real time
const deps = { client: () => gateway, getAdminDb: async () => ({ db }), env: ENV, now: () => Date.now() + skew, randomInt: crypto.randomInt, randomBytes: crypto.randomBytes, pad: null };

/* ── the site: static files, the rewrite, the policy header, and the endpoint ─ */
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
    // the page's own files, its words, the shared NIC module and nothing else
    if (!/^\/(tenant\.html|tenant-page\.(js|css)|tenant-logo\.png|tenant-inter\.woff2|tenant-(lang|tools)\.js|wealthflow-nic\.js)$/.test(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', ...headers });
    res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`console.${m.type()}: ${m.text()}`); });
page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url()));
const hosts = new Set();
page.on('request', (r) => hosts.add(new URL(r.url()).origin));

// WF_TENANT_SHOTS=<dir> keeps a picture of each screen, for a person to look at
const shot = async (name) => { if (process.env.WF_TENANT_SHOTS) { await page.waitForTimeout(350); fs.mkdirSync(process.env.WF_TENANT_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.WF_TENANT_SHOTS, `${name}.png`), fullPage: true }); } };
const text = () => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
const noOverflow = (label) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1).then((ok) => assert.ok(ok, `${label}: the page scrolls sideways`));
const lastCode = () => { const m = /^(\d{6}) is your WealthFlow/.exec(sent.at(-1).message); return m && m[1]; };

/* 0. the loading screen: drawn by the page itself before any script, adopted (not rebuilt) by the script, honest about being slow ----------- */
{
    const snap = async (p, name) => { if (process.env.WF_TENANT_SHOTS) { fs.mkdirSync(process.env.WF_TENANT_SHOTS, { recursive: true }); await p.screenshot({ path: path.join(process.env.WF_TENANT_SHOTS, `${name}.png`), fullPage: true }); } };
    const probe = async (ctxOptions, holdMs, work) => {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, ...ctxOptions });
        const p = await ctx.newPage();
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        await p.addInitScript(() => {
            window.__splashRemoved = 0;
            new MutationObserver((records) => { for (const r of records) for (const n of r.removedNodes) if (n.classList && n.classList.contains('tp-splash')) window.__splashRemoved += 1; }).observe(document, { childList: true, subtree: true });
        });
        let calls = 0;
        await p.route('**/api/tenant-portal', async (route) => { calls += 1; if (calls === 1) await new Promise((r) => setTimeout(r, holdMs)); await route.continue(); });
        await p.goto(`${base}/t/${TOKEN}`, { waitUntil: 'domcontentloaded' });
        await work(p);
        assert.deepEqual(errors, []);
        await ctx.close();
    };
    // English: the sentence, the same element the page drew, then the page's own apology once it is slow, then the form
    await probe({}, 6200, async (p) => {
        await p.waitForFunction(() => { const l = document.querySelector('.tp-splash-status'); return l && l.textContent === 'Preparing your secure page'; });
        await p.waitForFunction(() => Number(getComputedStyle(document.querySelector('.tp-splash')).opacity) === 1);       // the 0.3 s hold-back and the fade are over
        const seen = await p.evaluate(() => { const el = document.querySelector('.tp-splash'); const box = el.getBoundingClientRect(); return { opacity: Number(getComputedStyle(el).opacity), role: el.getAttribute('role'), logo: document.querySelector('.tp-splash-logo').complete, name: document.querySelector('.tp-splash-name').textContent, tall: box.height >= innerHeight - 2, removed: window.__splashRemoved, stuck: !!document.querySelector('.tp-splash-stuck') }; });
        assert.equal(seen.opacity, 1, 'the loading screen is visible once the hold-back is over');
        assert.deepEqual([seen.role, seen.logo, seen.name, seen.tall, seen.stuck], ['status', true, 'WealthFlow', true, false], 'the mark, the name, the whole screen, and no "reload" line once the script runs');
        assert.equal(seen.removed, 0, 'the script adopted the splash the HTML drew instead of building another');
        await snap(p, '0-loading');
        await p.waitForFunction(() => document.querySelector('.tp-splash-status').textContent === 'This is taking longer than usual. Thank you for your patience.', null, { timeout: 8000 });
        await snap(p, '0b-loading-slow');
        await p.waitForSelector('#tp-nic', { timeout: 10000 });
        assert.equal(await p.evaluate(() => window.__splashRemoved), 1, 'and the form took its place');
    });
    // Sinhala for a browser that asks for it; and a person who asked for less motion gets a calm bar
    await probe({ locale: 'si-LK', reducedMotion: 'reduce' }, 1500, async (p) => {
        await p.waitForFunction(() => document.querySelector('.tp-splash-status').textContent === 'ඔබේ ආරක්ෂිත පිටුව සූදානම් කරමින්');
        await p.waitForFunction(() => Number(getComputedStyle(document.querySelector('.tp-splash')).opacity) === 1);
        await snap(p, '0c-loading-si');
        const calm = await p.evaluate(() => { const bar = getComputedStyle(document.querySelector('.tp-splash-bar span')); const glow = getComputedStyle(document.querySelector('.tp-splash-mark'), '::before'); return { barAnimation: bar.animationName, barWidth: bar.width, glowAnimation: glow.animationName, logoAnimation: getComputedStyle(document.querySelector('.tp-splash-logo')).animationName }; });
        assert.deepEqual([calm.barAnimation, calm.glowAnimation, calm.logoAnimation], ['none', 'none', 'none'], 'nothing moves for a person who asked for less motion');
        await p.waitForSelector('#tp-nic', { timeout: 10000 });
    });
    console.log('0. loading screen     -> drawn before the script, adopted by it, says it is slow after 5 s, Sinhala on request, still when motion is reduced');
}

/* 1. the link opens on the NIC form ------------------------------------------- */
const first = await page.goto(`${base}/t/${TOKEN}`);
assert.equal(first.status(), 200);
assert.match(first.headers()['content-security-policy'], /script-src 'self'/);
assert.equal(first.headers()['cache-control'], 'no-store, max-age=0');
await page.waitForSelector('#tp-nic');
console.log('1. link opens         -> NIC form, policy', JSON.stringify(first.headers()['content-security-policy'].slice(0, 40)) + '...');
assert.match(await text(), /Verify your identity/);
assert.match(await text(), /We will send a 6-digit verification code by text message to the mobile number your lender holds for you/);
assert.match(await text(), /If you do not have a Sri Lankan NIC, enter your passport or ID number/);
assert.equal((await page.textContent('#tp-send')).trim(), 'Verify and continue', 'the button says what it does, not what the page wants');
assert.doesNotMatch(await text(), /Send me a code|View my statement/, 'the old wording is gone');
assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tp-nic', 'the field is focused');
assert.equal(await page.title(), 'Your WealthFlow statement');
await noOverflow('NIC form');
await shot('1-nic');

/* 1a. the page is served with its hardening headers, Trusted Types is enforced in it, and it draws nothing while it is out of sight --------- */
{
    const h = first.headers();
    assert.equal(h['x-frame-options'], 'DENY');
    assert.equal(h['referrer-policy'], 'no-referrer');
    assert.equal(h['cross-origin-opener-policy'], 'same-origin');
    assert.equal(h['cross-origin-resource-policy'], 'same-origin');
    for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) assert.match(h['permissions-policy'], new RegExp(`(^|, )${f}=\\(\\)(,|$)`), `${f} is switched off for this page`);
    assert.match(h['content-security-policy'], /object-src 'none'.*require-trusted-types-for 'script'; trusted-types 'none'/);
    // enforced for real, in a page of its own (so the refusal it reports is not counted as a problem of the page under test)
    const probeCtx = await browser.newContext();
    const probe = await probeCtx.newPage();
    await probe.goto(`${base}/t/${TOKEN}`);
    await probe.waitForSelector('#tp-nic');
    const refused = await probe.evaluate(() => {
        const out = {};
        for (const [name, run] of [['innerHTML', () => { document.createElement('div').innerHTML = '<b>x</b>'; }], ['script src', () => { document.createElement('script').src = 'https://evil.example/x.js'; }]]) {
            try { run(); out[name] = 'allowed'; } catch (e) { out[name] = e.name; }
        }
        out.policies = window.trustedTypes ? (() => { try { window.trustedTypes.createPolicy('x', { createHTML: (v) => v }); return 'created'; } catch (e) { return e.name; } })() : 'unsupported';
        return out;
    });
    assert.deepEqual(refused, { innerHTML: 'TypeError', 'script src': 'TypeError', policies: 'TypeError' }, 'a string cannot reach a script sink, and no policy can be made to let one through');
    await probeCtx.close();
    // out of sight: nothing is drawn (so the phone's app-switcher picture holds nothing); back in sight: everything is
    const visibility = () => page.evaluate(() => getComputedStyle(document.querySelector('#tp-root')).visibility);
    const setSight = (state) => page.evaluate((v) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v }); document.dispatchEvent(new Event('visibilitychange')); }, state);
    assert.equal(await visibility(), 'visible');
    await setSight('hidden');
    assert.equal(await visibility(), 'hidden', 'nothing is drawn while the page is out of sight');
    await setSight('visible');
    assert.equal(await visibility(), 'visible', 'and it all comes back the moment the person does');
    assert.equal(await page.inputValue('#tp-nic'), '', 'with nothing lost');
    console.log('1a. hardening         -> frame/referrer/opener/resource/permissions headers, Trusted Types enforced (innerHTML, script src, policies refused), page blank while out of sight');
}

/* 2. a malformed NIC never reaches the server --------------------------------- */
const before = sent.length;
await page.fill('#tp-nic', '1234');
await page.click('#tp-send');
assert.match(await page.textContent('#tp-err'), /9 digits followed by V or X, or 12 digits/);
assert.match(await page.textContent('#tp-err'), /passport \/ ID number/, 'and says what to type if there is no Sri Lankan NIC');
assert.equal(await page.getAttribute('#tp-nic', 'aria-invalid'), 'true');
assert.equal(sent.length, before);
// the first keystroke of a correction takes the red mark and the message away: a field being fixed is not told off again
await page.type('#tp-nic', '5');
assert.equal(await page.getAttribute('#tp-nic', 'aria-invalid'), null, 'typing clears the red mark');
assert.equal(await page.textContent('#tp-err'), '', 'and the message under it');
await page.fill('#tp-nic', '1234');
await page.click('#tp-send');
assert.equal(await page.getAttribute('#tp-nic', 'aria-invalid'), 'true');
console.log('2. bad NIC            -> refused in the page, nothing sent');
assert.match(await text(), /passport \/ ID number/, 'the form says a passport or ID number will do');

/* 3. a wrong (but well-formed) NIC is refused where it was typed: no code, no code screen --------------- */
await page.fill('#tp-nic', '198534000999');
await page.click('#tp-send');
await page.waitForFunction(() => /could not verify these details/i.test(document.querySelector('#tp-err').textContent));
assert.equal(sent.length, before, 'no text for a NIC that is not on the link');
assert.equal(await page.locator('#tp-code').count(), 0, 'and no code screen to wait on');
assert.equal(await page.getAttribute('#tp-nic', 'aria-invalid'), 'true', 'the field is marked');
assert.equal(await page.inputValue('#tp-nic'), '198534000999', 'what was typed is kept, not wiped');
assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tp-nic', 'and focus is back on it');
assert.equal(await page.evaluate(() => { const i = document.querySelector('#tp-nic'); return i.selectionStart === 0 && i.selectionEnd === i.value.length; }), true, 'with the whole value selected, so the retype is one move');
assert.equal((await page.textContent('#tp-send')).trim(), 'Verify and continue', 'the button is ready again');
assert.equal(await page.isDisabled('#tp-send'), false);
const wrongNicWords = await page.textContent('#tp-err');
assert.match(wrongNicWords, /Please check your NIC or passport \/ ID number, or contact the person who sent you this link/);
assert.doesNotMatch(await text(), /code is on its way|has been sent/i, 'nothing here says a code went out');
await shot('1b-wrong-nic');
// switching language does not make the refusal disappear: it is said again in the other language, on the same marked field
await page.click('#tp-lang');
await page.waitForFunction(() => /ඔබේ විස්තර තහවුරු කළ නොහැකි විය/.test(document.getElementById('tp-err').textContent));
assert.equal(await page.getAttribute('#tp-nic', 'aria-invalid'), 'true');
assert.equal(await page.inputValue('#tp-nic'), '198534000999');
await shot('1b-wrong-nic-si');
await page.click('#tp-lang');
await page.waitForFunction(() => /could not verify these details/i.test(document.getElementById('tp-err').textContent));
// the first keystroke of the correction clears the mark and the message, like any other refusal
await page.type('#tp-nic', '0');
assert.equal(await page.getAttribute('#tp-nic', 'aria-invalid'), null);
assert.equal(await page.textContent('#tp-err'), '');
assert.doesNotMatch(await page.textContent('#tp-help'), /Still not matching/, 'one miss is still just a typo');

/* 4. the right NIC: one text, and the page says which phone to look at ------------------------------- */
await page.fill('#tp-nic', ' 8534-00937 v ');
await page.click('#tp-send');
await page.waitForSelector('#tp-code');
assert.equal(sent.length, before + 1);
assert.equal(sent.at(-1).to, '+94771234567');
const rightNicWords = await page.textContent('#tp-sent');
assert.match(rightNicWords, /We sent a 6-digit code by text message to\s*\+94 •• ••• •567/, 'the page says where the code went: the phone, with only its last three digits');
assert.doesNotMatch(rightNicWords, /771234567|4567/, 'and never more than the last three');
assert.equal(await page.textContent('#tp-sent .tp-sr'), 'your mobile number ending in 5 6 7', 'a screen reader is told the digits, not the dots');
assert.equal(await page.getAttribute('#tp-sent .tp-sent-num', 'aria-hidden'), 'true', 'the dots are drawn for the eye only');
assert.equal(await page.isHidden('#tp-info'), true, 'the status box has nothing to say until there is something new');
assert.doesNotMatch(await text(), /View my statement|Send a new code/);
assert.equal((await page.textContent('#tp-verify')).trim(), 'Verify code');
assert.match(await page.textContent('#tp-resend'), /Resend code in \d+s/);
assert.equal(await page.isDisabled('#tp-resend'), true);
assert.match(await page.textContent('#tp-expiry'), /expires in [23]:\d\d/);
assert.equal(await page.getAttribute('#tp-code', 'autocomplete'), 'one-time-code');
assert.equal(await page.getAttribute('#tp-code', 'inputmode'), 'numeric');
await noOverflow('code form');
await shot('2-code');
console.log('3. NIC -> code        -> a wrong NIC is refused in place (no text, no code screen, field kept and selected); the right one names the phone');

/* 5. a wrong code is refused and clears the field ----------------------------- */
const right = lastCode();
const wrong = right === '000000' ? '111111' : '000000';
await page.fill('#tp-code', '12');
await page.click('#tp-verify');
assert.match(await page.textContent('#tp-err'), /6-digit verification code/);
await page.fill('#tp-code', wrong);
await page.click('#tp-verify');
await page.waitForFunction(() => /could not verify that code/.test(document.getElementById('tp-err').textContent));
assert.equal(await page.inputValue('#tp-code'), '', 'a refused code is cleared');
assert.equal(await page.getAttribute('#tp-code', 'aria-invalid'), 'true', 'and the field is marked so the person sees which one to retype');
await page.type('#tp-code', '1');
assert.equal(await page.getAttribute('#tp-code', 'aria-invalid'), null, 'the mark goes at the first new digit');
await page.fill('#tp-code', '');
await page.fill('#tp-code', wrong);
await page.click('#tp-verify');
await page.waitForFunction(() => /could not verify that code/.test(document.getElementById('tp-err').textContent) && document.getElementById('tp-code').value === '');
console.log('4. wrong code         -> refused:', JSON.stringify(await page.textContent('#tp-err')));

/* 6. the right code opens the statement ---------------------------------------- */
await page.fill('#tp-code', right);
await page.click('#tp-verify');
await page.waitForSelector('#tp-out');
const body = await text();
console.log('5. right code         -> statement', JSON.stringify(body.slice(0, 160)) + '...');
for (const want of ['Your statement', 'Investment', 'Loan', 'LKR 500,000.00', 'LKR 10,000.00', 'LKR 30,000.00', 'LKR 50,000.00', 'LKR 20,000.00', '24% per year', 'Monthly', 'Loan disbursed', 'Repayment', '1 Sep 2026', '20 Sep 2026']) assert.ok(body.includes(want), `statement shows ${want}`);
assert.ok(body.includes('853400937V') && body.includes('NIC / ID'), 'the holder card shows the person\'s own NIC');
assert.ok(await page.locator('img.tp-logo').first().evaluate((i) => i.complete && i.naturalWidth === 144), 'the WealthFlow mark loads');
for (const leak of ['PRIVATE', '198534000937', '0771234567', '077 123', 'inv1', 'deb1', '777']) assert.ok(!body.includes(leak), `statement must not show ${leak}`);
assert.match(body, /INV-[0-9A-F]{6}/);
assert.match(body, /DEB-[0-9A-F]{6}/);
assert.match(body, /session ends in \d+ min/, "a fresh session says how many whole minutes remain, not a ticking clock");
const loanCard = await page.locator('section[aria-label^="Loan"]').innerText();
assert.ok(!/interest|rate/i.test(loanCard), 'the loan card carries no interest');
assert.equal(await page.evaluate(() => (document.getElementById('tp-nic') || {}).value), undefined, 'the NIC field is gone from the page');
await noOverflow('statement');
await shot('3-statement');
// a table that has to scroll sideways on a small phone hides its last column: check at 320 px, inside the tables as well as the page
await page.setViewportSize({ width: 320, height: 700 });
const tables = await page.evaluate(() => [...document.querySelectorAll('.tp-scroll')].map((el) => el.scrollWidth <= el.clientWidth + 1));
assert.ok(tables.length === 2 && tables.every(Boolean), 'the statement tables fit a 320 px phone without scrolling: ' + JSON.stringify(tables));
await noOverflow('statement at 320');
await shot('4-statement-320');
await page.setViewportSize({ width: 390, height: 800 });

/* 6b. what a person needs next: when, where to pay, a PDF, copy, print, their own language ------ */
assert.ok(/next interest payment/i.test(body), 'the investment says when interest is next due');      // labels are upper-cased by the page's style, and innerText reports that
assert.match(body, /repayment due by\s*\S+ \S+ \d{4} \(4 days ago\)/i, 'the loan says when it was expected back, and how late it is');
for (const want of ['How to pay', 'Commercial Bank', 'N. Perera', '8001234567', 'Colombo 03', 'CCEYLKLX', 'PLEASE WRITE YOUR NIC IN THE PAYMENT REFERENCES']) assert.ok(body.includes(want), `the lender's account shows ${want}`);
assert.ok(!body.includes('Closed Bank') && !body.includes('1111222233'), 'a switched-off account is not shown');
assert.ok(!/showTo|acc1|_ut/.test(body), 'no setting or id of the account reaches the page');
assert.ok(body.toLowerCase().indexOf('how to pay') < body.toLowerCase().indexOf('capital'), 'where to pay comes before the records');
assert.ok(await page.locator('.tp-copyrow .tp-value').first().evaluate((el) => el.getBoundingClientRect().height < 30), 'the account number stays on one line (it is the thing that is typed into a banking app)');
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
await page.locator('.tp-copy').first().click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '8001234567', 'the copy button puts the account number on the clipboard');
assert.equal(await page.locator('.tp-copy').first().textContent(), 'Copied');
assert.match(await page.textContent('#tp-info'), /Copied to the clipboard/);
await page.waitForFunction(() => document.querySelector('.tp-copy').textContent === 'Copy', null, { timeout: 5000 });
await page.locator('.tp-copyall').click();
assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Bank: Commercial Bank\nAccount name: N. Perera\nAccount number: 8001234567\nBranch: Colombo 03\nSWIFT / IBAN: CCEYLKLX');
console.log('5b. where to pay      -> account shown, copy puts the number (and the lot) on the clipboard');
await shot('3b-statement-pay');

// the PDF: the browser's own download, under the page's own policy (no blob or data allowance in it)
const [download] = await Promise.all([page.waitForEvent('download'), page.click('#tp-pdf')]);
assert.match(download.suggestedFilename(), /^WealthFlow-statement-\d{4}-\d{2}-\d{2}\.pdf$/);
const pdf = fs.readFileSync(await download.path());
assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
assert.ok(pdf.subarray(-6).toString('latin1') === '%%EOF\n');
const pdfText = [...pdf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')).join('\n');
for (const want of ['(8001234567)', '(Commercial Bank)', '(500,000.00)', '(30,000.00)', 'Page 1 of']) assert.ok(pdfText.includes(want) || pdfText.includes(want.replace(/[()]/g, '')), `the PDF carries ${want}`);
assert.match(pdfText, /INV-[0-9A-F]{6}/);
assert.ok(pdfText.includes('(853400937V)'), 'the PDF names the person\'s own NIC in the holder block');
assert.ok(/\/Subtype \/Image \/Width 144/.test(pdf.toString('latin1')), 'the PDF carries the WealthFlow mark');
for (const leak of ['PRIVATE', '198534000937', '0771234567', 'Closed Bank', '1111222233']) assert.ok(!pdf.toString('latin1').includes(leak) && !pdfText.includes(leak), `the PDF must not carry ${leak}`);
await page.waitForFunction(() => /PDF is ready/.test(document.getElementById('tp-info').textContent));
assert.equal(await page.textContent('#tp-pdf'), 'Download PDF');
assert.equal(await page.isDisabled('#tp-pdf'), false, 'the button is ready for another download');
console.log('5c. PDF               ->', download.suggestedFilename(), pdf.length, 'bytes, account and figures inside, nothing private');
if (process.env.WF_TENANT_SHOTS) { fs.mkdirSync(process.env.WF_TENANT_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.WF_TENANT_SHOTS, 'statement.pdf'), pdf); }

// print: the page asks the browser to print, and the print layout hides the buttons
await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
await page.click('#tp-print');
assert.equal(await page.evaluate(() => window.__printed), 1);
await page.emulateMedia({ media: 'print' });
assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('tp-pdf')).display), 'none', 'the print layout has no buttons');
assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)', 'and prints on white');
await page.emulateMedia({ media: 'screen' });

// what is coming up, a reminder for the phone's calendar, a spreadsheet, a refresh inside the same session, and a jump to where to pay
const next = await page.locator('.tp-next').innerText();
assert.match(next, /Upcoming/i);
assert.match(next, /Loan repayment due/);
assert.match(next, /days? overdue/, 'the late loan says how late it is');
assert.match(next, /Interest payment due/);
const [ics] = await Promise.all([page.waitForEvent('download'), page.locator('.tp-next .tp-small-btn').first().click()]);
assert.match(ics.suggestedFilename(), /^WealthFlow-DEB-[0-9A-F]{6}-\d{4}-\d{2}-\d{2}\.ics$/);
const icsText = fs.readFileSync(await ics.path(), 'utf8');
assert.ok(icsText.startsWith('BEGIN:VCALENDAR\r\n') && icsText.includes('TRIGGER:-P1D') && icsText.replace(/\r\n /g, '').includes('SUMMARY:Payment of LKR 30\\,000.00 due to your lender'), 'a calendar file with the amount and an alert');
assert.ok(!/PRIVATE|853400937|0771234567/.test(icsText), 'the calendar file carries nothing private');
const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#tp-csv')]);
assert.match(csv.suggestedFilename(), /^WealthFlow-statement-\d{4}-\d{2}-\d{2}\.csv$/);
const csvText = fs.readFileSync(await csv.path(), 'utf8');
assert.ok(csvText.includes('"Reference","Type","Date","Description","Amount","Balance","Currency"') && csvText.includes('"Repayment"') && csvText.includes('"Loan disbursed"'));
assert.ok(!/PRIVATE|853400937|0771234567/.test(csvText), 'the spreadsheet carries nothing private');
await page.click('.tp-jump');
assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tp-pay', 'the jump lands on where to pay');
await page.click('#tp-refresh');
await page.waitForFunction(() => /Statement refreshed/.test((document.getElementById('tp-info') || {}).textContent || ''));
assert.ok((await text()).includes('LKR 30,000.00'), 'the same statement is back after a refresh, with no new code');
assert.ok(await page.locator('.tp-progress progress').count() >= 1, 'the loan shows its progress');
console.log('5e. extras            -> coming up, calendar file, spreadsheet, jump to pay, refresh without a new code');

// the balance card: amounts can be blurred for reading with someone nearby (and come back after a refresh), the section bar jumps, the typeface loaded
assert.equal(await page.locator('.tp-hero .tp-holder-nic').count(), 1, 'the balance card shows whose statement it is');
assert.equal(await page.getAttribute('#tp-eye', 'aria-pressed'), 'false');
await page.click('#tp-eye');
assert.equal(await page.getAttribute('#tp-eye', 'aria-pressed'), 'true');
assert.match(await page.evaluate(() => getComputedStyle(document.querySelector('.tp-hero .tp-money')).filter), /blur/, 'the amounts are blurred');
await page.click('#tp-refresh');
await page.waitForFunction(() => /Statement refreshed/.test((document.getElementById('tp-info') || {}).textContent || ''));
assert.equal(await page.getAttribute('#tp-eye', 'aria-pressed'), 'true', 'a refresh keeps the amounts hidden');
await page.click('#tp-eye');
await page.waitForFunction(() => getComputedStyle(document.querySelector('.tp-hero .tp-money')).filter === 'none', null, { timeout: 3000 });      // 'and showing them again unblurs' (it fades, so it takes a moment)
assert.ok(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px Inter'); }), 'the Inter typeface loaded from this site');
if (await page.locator('.tp-tabs').isVisible()) {
    await page.locator('.tp-tab[data-to="tp-records"]').click();
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tp-records', 'the section bar jumps to the records');
}
console.log('5f. balance card      -> holder, hide amounts (kept over a refresh), section bar, typeface');
// 5g. the repayment plan: a loan that is open can be planned, and the answer follows what is typed
{
    await page.click('.tp-plan > summary');
    const planOut = () => page.textContent('.tp-plan-out');
    assert.match(await planOut(), /Enter an amount/, 'the plan asks for an amount first');
    await page.selectOption('.tp-plan select', 'weekly');
    await page.fill('.tp-plan input', '10000');
    assert.match(await planOut(), /Payments\s*3|3\s*Payments/i, 'three weekly payments of 10,000 clear 30,000');
    assert.match(await planOut(), /Fully repaid by/i, 'and it says when it ends');
    await page.fill('.tp-plan input', '0.01');
    assert.match(await planOut(), /too many payments/, 'a tiny amount is refused in words');
    await page.fill('.tp-plan input', '10000');
    const [planIcs] = await Promise.all([page.waitForEvent('download'), page.click('.tp-plan-out .tp-small-btn')]);
    const planText = fs.readFileSync(await planIcs.path(), 'utf8');
    assert.match(planText, /RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=3/, 'the plan downloads as a repeating reminder');
    assert.ok(await page.locator('.tp-trail .tp-spark').count() >= 1, 'the loan draws its balance over time');
    await shot('3e-repayment-plan');
    console.log('5g. repayment plan    -> payments and end date follow the amount, a repeating calendar reminder, balance chart');
}
await shot('3d-statement-extras');

// light by default, one tap to dark and one back to light (there is no "follow the device" mode); the choice is not stored either
const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const luma = (rgb) => { const m = rgb.match(/\d+/g).map(Number); return (m[0] * 299 + m[1] * 587 + m[2] * 114) / 1000; };
assert.equal(await page.getAttribute('html', 'data-theme'), 'light', 'the portal opens in the light theme');
assert.equal(await page.textContent('#tp-theme'), 'Light');
assert.ok(luma(await paper()) > 200, 'and its paper is light');
await page.click('#tp-theme');
assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
assert.equal(await page.textContent('#tp-theme'), 'Dark');
assert.ok(luma(await paper()) < 80, 'dark means a dark paper');
await noOverflow('statement in the dark theme');
await shot('3b-statement-dark');
assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), '#0b1220', "the phone's status bar follows the page's dark theme");
// a phone that prefers dark does not decide: the portal stays in the theme the person picked
await page.emulateMedia({ colorScheme: 'dark' });
assert.ok(luma(await paper()) < 80, 'dark stays dark');
await page.click('#tp-theme');
assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
assert.ok(luma(await paper()) > 200, 'light stays light on a phone that prefers dark: there is no automatic mode');
assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), '#ffffff');
await page.emulateMedia({ colorScheme: 'light' });
await page.click('#tp-theme');
assert.equal(await page.getAttribute('html', 'data-theme'), 'dark', 'only two looks: a third tap is dark again');
await page.click('#tp-theme');
assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
assert.equal(await page.evaluate(() => JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)])), '[[],[]]', 'the theme is not stored');
console.log('5h. colour theme      -> light by default, only light and dark (no automatic mode), nothing stored');

// their own language, one tap, nothing remembered
assert.equal(await page.textContent('#tp-lang'), 'සිංහල');
await page.click('#tp-lang');
await page.waitForFunction(() => document.getElementById('tp-lang').textContent === 'English');
const si = await text();
const leftovers = await page.evaluate(() => {
    const out = new Set();
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE']);
    const walk = (n) => { if (n.nodeType === 3) { const t = n.textContent; (t.match(/[A-Za-z]{3,}/g) || []).forEach((w) => out.add(w)); } else if (n.nodeType === 1 && !skip.has(n.tagName)) n.childNodes.forEach(walk); };
    walk(document.body);
    return [...out];
});
// nothing on the Sinhala page may be left in English except names, acronyms and the lender's own account data
const KEEP = new Set(['WealthFlow', 'English', 'LKR', 'PDF', 'CSV', 'DEB', 'INV', 'SWIFT', 'IBAN', 'Commercial', 'Bank', 'Perera', 'Colombo', 'CCEYLKLX']);
assert.deepEqual(leftovers.filter((w) => !KEEP.has(w)), [], 'English words left on the Sinhala page');
assert.ok(/[\u0D80-\u0DFF]/.test(await page.textContent('.tp-acct-note p')) && !/PLEASE WRITE/i.test(await page.textContent('.tp-acct-note p')), "the lender's note reads in Sinhala");
assert.ok(si.includes('ඔක්තෝබර්') || si.includes('ජනවාරි') || /\d{4} [\u0D80-\u0DFF]+ \d{1,2}/.test(si), 'dates read with Sinhala month names');
for (const want of ['ඔබේ ප්‍රකාශය', 'ගෙවන ආකාරය', 'PDF බාගන්න', 'ණය', 'ආයෝජනය', 'LKR 500,000.00', '8001234567', 'Commercial Bank', 'INV-', 'DEB-']) assert.ok(si.includes(want), `the Sinhala page shows ${want}`);
assert.equal(await page.evaluate(() => document.documentElement.lang), 'si');
assert.equal(await page.getAttribute('#tp-lang', 'lang'), 'en');
assert.equal(await page.evaluate(() => JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)])), '[[],[]]', 'the language is not stored');
await noOverflow('statement in Sinhala');
await shot('3c-statement-si');
await page.setViewportSize({ width: 320, height: 700 });
await noOverflow('statement in Sinhala at 320');
await page.setViewportSize({ width: 390, height: 800 });
// the file follows the page's language: a Sinhala page gets the Sinhala file (the English one it already holds is not reused)
const [siDownload] = await Promise.all([page.waitForEvent('download'), page.click('#tp-pdf')]);
const siPdf = fs.readFileSync(await siDownload.path());
assert.ok(siPdf.toString('latin1').includes('/Lang (si)') && siPdf.toString('latin1').includes('/Subtype /Type0'), 'the Sinhala page downloads the Sinhala PDF');
assert.ok(siPdf.length > pdf.length && siPdf.length < 120 * 1024, `and it is a sensible size (${siPdf.length} bytes)`);
await page.click('#tp-lang');
await page.waitForFunction(() => document.getElementById('tp-lang').textContent === 'සිංහල');
const [enDownload] = await Promise.all([page.waitForEvent('download'), page.click('#tp-pdf')]);
assert.ok(!fs.readFileSync(await enDownload.path()).toString('latin1').includes('/Subtype /Type0'), 'and back in English the file is English again');
assert.ok((await text()).includes('Your statement'));
assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
console.log('5d. print and Sinhala -> print layout is white with no buttons; the page reads in Sinhala and back, nothing stored');

/* 7. the cookie is the session, and script cannot read it ---------------------- */
const cookies = (await context.cookies()).filter((c) => c.name === 'wf_tp');
assert.equal(cookies.length, 1);
assert.deepEqual({ httpOnly: cookies[0].httpOnly, secure: cookies[0].secure, sameSite: cookies[0].sameSite, path: cookies[0].path }, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/tenant-portal' });
assert.equal(await page.evaluate(() => document.cookie), '', 'script sees no cookie');
assert.equal(await page.evaluate(() => JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)])), '[[],[]]', 'nothing is kept in storage');
assert.ok(!page.url().includes('?') && !page.url().includes('#'), 'nothing in the address');
console.log('6. cookie             ->', JSON.stringify({ httpOnly: cookies[0].httpOnly, secure: cookies[0].secure, sameSite: cookies[0].sameSite, path: cookies[0].path }));

/* 8. a reload inside the session shows the statement without another text ------ */
const texts = sent.length;
await page.reload();
await page.waitForSelector('#tp-out');
assert.equal(sent.length, texts, 'no new text for a reload');
console.log('7. reload             -> statement again, no new text');

/* 9. the same session is no use on another link, nor with no page at all ------- */
const other = await ensureTenantToken({ db, uid: 'owner2', canonicalNic: CANON, secret: portalSecret(ENV), now: NOW - 500 });
fsx.data.set('users/owner2', { settings: {}, debtors: [] });
await page.goto(`${base}/t/${other}`);
await page.waitForSelector('#tp-nic');
assert.ok(!(await text()).includes('LKR 500,000.00'), "another link's page does not show this link's statement");
console.log('8. another link       -> asks for its own NIC and code');
// wrong NICs on that link: the third turns the hint into a plain warning, and five lock the link exactly like five wrong codes would
for (const nic of ['198534000999', '198534000998', 'N7654321']) {
    await page.fill('#tp-nic', nic);
    await page.click('#tp-send');
    await page.waitForFunction(() => /could not verify these details/i.test(document.querySelector('#tp-err').textContent));
}
assert.match(await page.textContent('#tp-help'), /Still not matching\? Please use the same NIC or passport \/ ID number you gave the person who sent you this link\. Several more incorrect attempts will pause this link for a while\./, 'the third miss says what a few more will do');
assert.equal(await page.getAttribute('#tp-help', 'class'), 'tp-help tp-help-warn');
await shot('1c-wrong-nic-warning');
for (const nic of ['198534000997', '198534000996', '198534000995']) {
    await page.fill('#tp-nic', nic);
    await page.click('#tp-send');
    await page.waitForFunction(() => /could not verify these details|Too many attempts/i.test(document.querySelector('#tp-err').textContent) && !document.querySelector('#tp-send').disabled);
}
assert.match(await page.textContent('#tp-err'), /Too many attempts/, 'the sixth try is turned away: a wrong NIC counts like a wrong code');
assert.match(await page.textContent('#tp-err'), /15 minutes/);
assert.equal(await page.locator('#tp-code').count(), 0);
console.log('8b. wrong NICs         -> a warning on the third, the link paused after five');

/* 10. signing out ends it, here and on the server ------------------------------ */
await page.goto(`${base}/t/${TOKEN}`);
await page.waitForSelector('#tp-out');
// a second tab on the same session, left open on the statement
const twin = await browser.newContext({ viewport: { width: 390, height: 800 } });
await twin.addCookies(await context.cookies());
const twinPage = await twin.newPage();
await twinPage.goto(`${base}/t/${TOKEN}`);
await twinPage.waitForSelector('#tp-pdf');
await page.click('#tp-out');
await page.waitForSelector('#tp-nic');
assert.match(await page.textContent('#tp-info'), /signed out/);
assert.equal((await context.cookies()).filter((c) => c.name === 'wf_tp' && c.value).length, 0, 'the cookie is cleared');
await page.reload();
await page.waitForSelector('#tp-nic');
assert.ok(!(await text()).includes('LKR 500,000.00'), 'after sign-out a reload shows nothing');
console.log('9. sign out           -> form, cookie gone, reload shows nothing');
// the other tab's session died with it: asking for the PDF there is a clean "sign in again", not a file and not an error page
await twinPage.click('#tp-pdf');
await twinPage.waitForSelector('#tp-nic');
assert.match(await twinPage.textContent('#tp-err'), /session has ended/);
assert.ok(!(await twinPage.evaluate(() => document.body.innerText)).includes('LKR 500,000.00'), 'and the statement is wiped from that tab');
await twin.close();
console.log('9b. other tab         -> PDF after sign-out is refused, tab returns to the form');

/* 11. five wrong codes lock the link ------------------------------------------- */
await page.fill('#tp-nic', NIC);
await page.click('#tp-send');
await page.waitForSelector('#tp-code');
// the 60 s gap applies, so the text sent in step 4 is the live one only if inside its window; ask the server's own state instead
const state = () => fsx.data.get(`wf-tenants/${TOKEN}/otp/current`);
if (!state() || state().status !== 'active' || state().expiresAt < Date.now()) { /* a fresh code was withheld by the 60 s gap: the lock test needs no live code */ }
for (let i = 0; i < 5; i += 1) {
    await page.fill('#tp-code', String(100000 + i));
    await page.click('#tp-verify');
    await page.waitForFunction((n) => document.getElementById('tp-err').textContent.length > 0 && !document.getElementById('tp-verify').disabled, i);
    if (i < 4) await page.evaluate(() => { document.getElementById('tp-err').textContent = ''; });
}
const locked = await page.textContent('#tp-err');
assert.match(locked, /Too many attempts/);
assert.match(locked, /15 minutes/);
console.log('10. five wrong codes  ->', JSON.stringify(locked));

/* 11b. the phone's own offer of the texted code (WebOTP): fills the field and checks it; stops waiting when the person types, asks again or leaves --------- */
{
    const two = [['199012345678', '077 765 4321'], ['198812345671', '077 765 4322'], ['199512345678', '077 765 4323']];
    const tokens = [];
    for (const [i, [nic, phone]] of two.entries()) {
        assert.equal(normalizeNic(nic).ok, true);
        fsx.data.get('users/owner1').debtors.push({ id: `deb-otp${i}`, name: 'nick', phone, nic, sms_notifications_enabled: true, sms_enabled_at: NOW - 30 * 86400e3, events: [{ id: 'f1', kind: 'lent', amount: 1000, date: '2026-09-01', confirmed: true }] });
        tokens.push(await ensureTenantToken({ db, uid: 'owner1', canonicalNic: normalizeNic(nic).canonical, secret: portalSecret(ENV), now: NOW - 1000 }));
    }
    const lastLine = () => sent.at(-1).message.split('\n').at(-1);
    const newestCode = () => /^(\d{6})/.exec(sent.at(-1).message)[1];
    const open = async (token) => {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
        // a browser that offers the code: the page's request stays open until the "SMS" arrives (release) or the page withdraws it (abort)
        await ctx.addInitScript(() => {
            window.__otp = { calls: 0, aborted: 0, transport: '', release: null };
            window.OTPCredential = function OTPCredential() {};
            Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: (opts) => new Promise((resolve, reject) => {
                if (!opts || !opts.otp) return reject(new TypeError('not a code request'));
                window.__otp.calls += 1;
                window.__otp.transport = opts.otp.transport.join(',');
                const withdraw = () => { window.__otp.aborted += 1; reject(new DOMException('aborted', 'AbortError')); };
                if (opts.signal) { if (opts.signal.aborted) return withdraw(); opts.signal.addEventListener('abort', withdraw, { once: true }); }
                window.__otp.release = (code) => resolve({ code });
            }) } });
        });
        const p = await ctx.newPage();
        const errs = [];
        p.on('pageerror', (e) => errs.push(e.message));
        await p.clock.install();                                            // from the start, so the page's own clock is the one that can be moved on (the 60 s before "Resend" opens)
        await p.goto(`${base}/t/${token}`);
        await p.waitForSelector('#tp-nic');
        return { ctx, p, errs };
    };
    const otp = (p) => p.evaluate(() => ({ calls: window.__otp.calls, aborted: window.__otp.aborted, transport: window.__otp.transport }));
    const askFor = async (p, nic) => { await p.fill('#tp-nic', nic); await p.click('#tp-send'); await p.waitForSelector('#tp-code'); };

    // (a) the code arrives, the person taps Allow in the phone's own sheet, and they are in, without typing a digit
    {
        const { ctx, p, errs } = await open(tokens[0]);
        await askFor(p, two[0][0]);
        assert.deepEqual(await otp(p), { calls: 1, aborted: 0, transport: 'sms' }, 'the page asked the phone for a text-message code, once');
        assert.equal(lastLine(), `@www.wealthflow.lk #${newestCode()}`, 'the text ends with the origin-bound line');
        assert.equal(await p.getAttribute('#tp-code', 'aria-describedby'), 'tp-sent tp-info tp-err', 'the field is described by where the code went, by any news and by any refusal');
        await p.evaluate((c) => window.__otp.release(c), newestCode());
        await p.waitForSelector('#tp-out', { timeout: 8000 });
        assert.deepEqual(errs, []);
        await ctx.close();
    }
    // (b) typing the code by hand withdraws the offer; leaving the screen withdraws it; asking for a new text withdraws the old wait and starts one
    {
        const { ctx, p, errs } = await open(tokens[1]);
        await askFor(p, two[1][0]);
        assert.deepEqual(await otp(p), { calls: 1, aborted: 0, transport: 'sms' });
        await p.fill('#tp-code', '000000');
        await p.click('#tp-verify');
        await p.waitForFunction(() => document.getElementById('tp-err').textContent.length > 0 && !document.getElementById('tp-verify').disabled);
        assert.deepEqual(await otp(p), { calls: 1, aborted: 1, transport: 'sms' }, 'submitting by hand withdrew the wait, and the wrong code did not start another');
        assert.equal(await p.getAttribute('#tp-code', 'aria-invalid'), 'true');
        await p.click('#tp-back');
        await p.waitForSelector('#tp-nic');
        assert.equal((await otp(p)).aborted, 1);
        skew += 61000;                                                      // the server's 60 s gap between two texts for one link
        await askFor(p, two[1][0]);
        assert.deepEqual(await otp(p), { calls: 2, aborted: 1, transport: 'sms' }, 'a new code screen is a new wait');
        await p.click('#tp-lang');                                          // redrawing the screen keeps the wait that is open: it does not stack another or start over
        await p.waitForSelector('#tp-code');
        assert.deepEqual(await otp(p), { calls: 2, aborted: 1, transport: 'sms' });
        await p.click('#tp-lang');                                          // and back to English
        await p.waitForFunction(() => document.documentElement.lang === 'en');
        assert.deepEqual(await otp(p), { calls: 2, aborted: 1, transport: 'sms' });
        await p.click('#tp-back');
        await p.waitForSelector('#tp-nic');
        assert.deepEqual(await otp(p), { calls: 2, aborted: 2, transport: 'sms' }, 'leaving the code screen withdrew the wait');
        skew += 61000;
        await askFor(p, two[1][0]);
        await p.clock.fastForward(61000);
        skew += 61000;
        await p.waitForFunction(() => !document.getElementById('tp-resend').disabled, null, { timeout: 5000 });
        const before = await otp(p);
        await p.click('#tp-resend');
        await p.waitForFunction(() => /new verification code has been sent/i.test(document.getElementById('tp-info').textContent));
        const after = await otp(p);
        assert.equal(after.aborted, before.aborted + 1, 'asking for a new text withdrew the wait for the old one');
        assert.equal(after.calls, before.calls + 1, 'and began a wait for the new one');
        await p.evaluate((c) => window.__otp.release(c), newestCode());
        await p.waitForSelector('#tp-out', { timeout: 8000 });
        assert.deepEqual(errs, []);
        await ctx.close();
    }
    // (d) the text can reach the phone before the page has the server's answer: the wait is already open, and the code goes in as the code screen appears
    {
        const { ctx, p, errs } = await open(tokens[2]);
        let letGo = null;
        const held = new Promise((resolve) => { letGo = resolve; });
        await p.route('**/api/tenant-portal', async (route) => {
            const body = route.request().postData() || '';
            if (!body.includes('"request"')) return route.continue();
            const answer = await route.fetch();                          // the server has sent the text by now
            await held;                                                  // ...but the page has not been told yet
            return route.fulfill({ response: answer });
        });
        const before = sent.length;
        await p.fill('#tp-nic', two[2][0]);
        await p.click('#tp-send');
        await p.waitForFunction(() => window.__otp.calls === 1);
        assert.equal((await otp(p)).calls, 1, 'the wait began with the request, before any answer');
        for (let i = 0; i < 100 && sent.length === before; i += 1) await p.waitForTimeout(50);
        assert.equal(sent.length, before + 1, 'the text went out while the request was still open');
        await p.evaluate((c) => window.__otp.release(c), newestCode());   // the phone hands the code over while the page still shows the first screen
        await p.waitForTimeout(200);
        assert.equal(await p.locator('#tp-code').count(), 0, 'the answer has not arrived, so the code screen is not there yet');
        letGo();
        await p.waitForSelector('#tp-out', { timeout: 8000 });
        assert.deepEqual(await otp(p), { calls: 1, aborted: 0, transport: 'sms' }, 'one wait, never restarted, and nothing left hanging');
        assert.deepEqual(errs, []);
        await ctx.close();
    }
    // (c) a browser with no such offer behaves exactly as before: the field is there, typing works
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
        const p = await ctx.newPage();
        await p.addInitScript(() => { try { delete window.OTPCredential; } catch (_) { window.OTPCredential = undefined; } });
        await p.goto(`${base}/t/${TOKEN}`);
        await p.waitForSelector('#tp-nic');
        assert.equal(await p.getAttribute('#tp-send', 'type'), 'submit');
        await ctx.close();
    }
    console.log('11b. WebOTP           -> the phone fills the code when it can, even when the text beats the answer; typing, resending and leaving withdraw the wait; no error anywhere');
}

/* 12. layouts: nothing scrolls sideways on a small phone or a desktop ---------- */
const verdicts = [];
for (const [w, h] of [[320, 640], [375, 812], [768, 1024], [1280, 800]]) {
    const ctx2 = await browser.newContext({ viewport: { width: w, height: h } });
    const p2 = await ctx2.newPage();
    await p2.goto(`${base}/t/${TOKEN}`);
    await p2.waitForSelector('#tp-nic');
    verdicts.push([w, await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)]);
    await ctx2.close();
}
assert.ok(verdicts.every(([, ok]) => ok), 'no horizontal scroll at ' + JSON.stringify(verdicts));
console.log('11. layouts           ->', JSON.stringify(verdicts));

/* 13. a link that is not a link ------------------------------------------------- */
const bad = await page.goto(`${base}/t/short`);
assert.equal(bad.status(), 404, 'only a 16-character link reaches the page');

assert.deepEqual([...hosts], [base], 'the page only ever talked to its own origin: ' + [...hosts].join(', '));
// Chromium logs every non-2xx fetch as a console error; the 401s (no session yet, wrong code), the 429 (the lock) and the 404 (/t/short) are this script's own doing and the point of it. Anything else, a policy violation above all, fails.
const expected = /Failed to load resource: the server responded with a status of (401|404|429)/;
assert.deepEqual(problems.filter((p) => !expected.test(p)), [], 'no console errors or policy violations: ' + problems.join(' | '));
console.log('the tenant page works on a real browser, under its real policy');
await browser.close();
server.close();
