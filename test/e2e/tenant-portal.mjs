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
        { id: 'acc1', bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'Please quote your reference', showTo: 'both', active: true, createdAt: '2026-01-01', _ut: 1 },
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
const deps = { client: () => gateway, getAdminDb: async () => ({ db }), env: ENV, now: () => Date.now(), randomInt: crypto.randomInt, randomBytes: crypto.randomBytes, pad: null };

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

/* 1. the link opens on the NIC form ------------------------------------------- */
const first = await page.goto(`${base}/t/${TOKEN}`);
assert.equal(first.status(), 200);
assert.match(first.headers()['content-security-policy'], /script-src 'self'/);
assert.equal(first.headers()['cache-control'], 'no-store, max-age=0');
await page.waitForSelector('#tp-nic');
console.log('1. link opens         -> NIC form, policy', JSON.stringify(first.headers()['content-security-policy'].slice(0, 40)) + '...');
assert.match(await text(), /Enter your NIC/);
assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tp-nic', 'the field is focused');
assert.equal(await page.title(), 'Your WealthFlow statement');
await noOverflow('NIC form');
await shot('1-nic');

/* 2. a malformed NIC never reaches the server --------------------------------- */
const before = sent.length;
await page.fill('#tp-nic', '1234');
await page.click('#tp-send');
assert.match(await page.textContent('#tp-err'), /9 digits followed by V or X, or as 12 digits/);
assert.match(await page.textContent('#tp-err'), /passport or ID number/, 'and says what to type if there is no Sri Lankan NIC');
assert.equal(await page.getAttribute('#tp-nic', 'aria-invalid'), 'true');
assert.equal(sent.length, before);
console.log('2. bad NIC            -> refused in the page, nothing sent');
assert.match(await text(), /passport \/ ID number/, 'the form says a passport or ID number will do');

/* 3. a wrong (but well-formed) NIC looks exactly like a right one ------------- */
await page.fill('#tp-nic', '198534000999');
await page.click('#tp-send');
await page.waitForSelector('#tp-code');
const wrongNicWords = await page.textContent('#tp-info');
assert.equal(sent.length, before, 'no text for a NIC that is not on the link');
await page.click('#tp-back');
await page.waitForSelector('#tp-nic');

/* 4. the right NIC: one text, the same words ---------------------------------- */
await page.fill('#tp-nic', ' 8534-00937 v ');
await page.click('#tp-send');
await page.waitForSelector('#tp-code');
assert.equal(sent.length, before + 1);
assert.equal(sent.at(-1).to, '+94771234567');
const rightNicWords = await page.textContent('#tp-info');
assert.equal(rightNicWords, wrongNicWords, 'the page says the same thing whether or not the NIC matched');
assert.match(await page.textContent('#tp-resend'), /Send a new code \(\d+s\)/);
assert.equal(await page.isDisabled('#tp-resend'), true);
assert.match(await page.textContent('#tp-expiry'), /expires in [23]:\d\d/);
assert.equal(await page.getAttribute('#tp-code', 'autocomplete'), 'one-time-code');
assert.equal(await page.getAttribute('#tp-code', 'inputmode'), 'numeric');
await noOverflow('code form');
await shot('2-code');
console.log('3. NIC -> code        -> one text to the recorded number, identical page for a wrong NIC');

/* 5. a wrong code is refused and clears the field ----------------------------- */
const right = lastCode();
const wrong = right === '000000' ? '111111' : '000000';
await page.fill('#tp-code', '12');
await page.click('#tp-verify');
assert.match(await page.textContent('#tp-err'), /6-digit code/);
await page.fill('#tp-code', wrong);
await page.click('#tp-verify');
await page.waitForFunction(() => /not valid/.test(document.getElementById('tp-err').textContent));
assert.equal(await page.inputValue('#tp-code'), '', 'a refused code is cleared');
console.log('4. wrong code         -> refused:', JSON.stringify(await page.textContent('#tp-err')));

/* 6. the right code opens the statement ---------------------------------------- */
await page.fill('#tp-code', right);
await page.click('#tp-verify');
await page.waitForSelector('#tp-out');
const body = await text();
console.log('5. right code         -> statement', JSON.stringify(body.slice(0, 160)) + '...');
for (const want of ['Your statement', 'Investment', 'Loan', 'LKR 500,000.00', 'LKR 10,000.00', 'LKR 30,000.00', 'LKR 50,000.00', 'LKR 20,000.00', '24% a year', 'Monthly', 'Loan paid out', 'Repayment', '1 Sep 2026', '20 Sep 2026']) assert.ok(body.includes(want), `statement shows ${want}`);
assert.ok(body.includes('853400937V') && body.includes('NIC / ID'), 'the holder card shows the person\'s own NIC');
assert.ok(await page.locator('img.tp-logo').first().evaluate((i) => i.complete && i.naturalWidth === 144), 'the WealthFlow mark loads');
for (const leak of ['PRIVATE', '198534000937', '0771234567', '077 123', 'inv1', 'deb1', '777']) assert.ok(!body.includes(leak), `statement must not show ${leak}`);
assert.match(body, /INV-[0-9A-F]{6}/);
assert.match(body, /DEB-[0-9A-F]{6}/);
assert.match(body, /closes in \d+:\d\d/);
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
assert.ok(/next interest due/i.test(body), 'the investment says when interest is next due');      // labels are upper-cased by the page's style, and innerText reports that
assert.match(body, /expected back by\s*\S+ \S+ \d{4} \(4 days ago\)/i, 'the loan says when it was expected back, and how late it is');
for (const want of ['How to pay', 'Commercial Bank', 'N. Perera', '8001234567', 'Colombo 03', 'CCEYLKLX', 'Please quote your reference']) assert.ok(body.includes(want), `the lender's account shows ${want}`);
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
assert.match(next, /Coming up/i);
assert.match(next, /Pay your loan/);
assert.match(next, /days? overdue/, 'the late loan says how late it is');
assert.match(next, /Interest expected/);
const [ics] = await Promise.all([page.waitForEvent('download'), page.locator('.tp-next .tp-small-btn').first().click()]);
assert.match(ics.suggestedFilename(), /^WealthFlow-DEB-[0-9A-F]{6}-\d{4}-\d{2}-\d{2}\.ics$/);
const icsText = fs.readFileSync(await ics.path(), 'utf8');
assert.ok(icsText.startsWith('BEGIN:VCALENDAR\r\n') && icsText.includes('TRIGGER:-P1D') && icsText.replace(/\r\n /g, '').includes('SUMMARY:Pay LKR 30\\,000.00 to your lender'), 'a calendar file with the amount and an alert');
assert.ok(!/PRIVATE|853400937|0771234567/.test(icsText), 'the calendar file carries nothing private');
const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#tp-csv')]);
assert.match(csv.suggestedFilename(), /^WealthFlow-statement-\d{4}-\d{2}-\d{2}\.csv$/);
const csvText = fs.readFileSync(await csv.path(), 'utf8');
assert.ok(csvText.includes('"Reference","Type","Date","Description","Amount","Balance","Currency"') && csvText.includes('"Repayment"') && csvText.includes('"Loan paid out"'));
assert.ok(!/PRIVATE|853400937|0771234567/.test(csvText), 'the spreadsheet carries nothing private');
await page.click('.tp-jump');
assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tp-pay', 'the jump lands on where to pay');
await page.click('#tp-refresh');
await page.waitForFunction(() => /Updated just now/.test((document.getElementById('tp-info') || {}).textContent || ''));
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
await page.waitForFunction(() => /Updated just now/.test((document.getElementById('tp-info') || {}).textContent || ''));
assert.equal(await page.getAttribute('#tp-eye', 'aria-pressed'), 'true', 'a refresh keeps the amounts hidden');
await page.click('#tp-eye');
await page.waitForFunction(() => getComputedStyle(document.querySelector('.tp-hero .tp-money')).filter === 'none', null, { timeout: 3000 });      // 'and showing them again unblurs' (it fades, so it takes a moment)
assert.ok(await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px Inter'); }), 'the Inter typeface loaded from this site');
if (await page.locator('.tp-tabs').isVisible()) {
    await page.locator('.tp-tab[data-to="tp-records"]').click();
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tp-records', 'the section bar jumps to the records');
}
console.log('5f. balance card      -> holder, hide amounts (kept over a refresh), section bar, typeface');
await shot('3d-statement-extras');

// their own language, one tap, nothing remembered
assert.equal(await page.textContent('#tp-lang'), 'සිංහල');
await page.click('#tp-lang');
await page.waitForFunction(() => document.getElementById('tp-lang').textContent === 'English');
const si = await text();
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
