/* =============================================================================
 * test/e2e/tenant-chart.mjs — "Balance over time" on the tenant's loan cards, in a real Chromium
 * -----------------------------------------------------------------------------
 * The unit tests pin the chart's arithmetic (tenant_tools_test.js); this asks the browser for what a person
 * sees and does: the chart is drawn at the width the screen gives it and again when that width changes, the card above
 * it says the movement the finger (or the arrow keys, or the two buttons) is on, the table below marks the same
 * row, the due date and today are on it, amounts blur with the rest of the page, Sinhala and Dark both read, and
 * nothing overflows a 320 px phone or breaks the page's policy (no inline style, no markup parsing).
 *
 * The page talks to the REAL handler (tenant-portal.js) over an in-memory Firestore and a stub gateway, with the
 * server's clock fixed, so every date on the chart is the same on every run.
 *
 * Run from the repository root:  node test/e2e/tenant-chart.mjs
 *   WF_TENANT_SHOTS=<dir> keeps a picture of each chart.
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
const NOW = Date.UTC(2026, 9, 23, 5, 0, 0);                    // 23 Oct 2026, 10:30 in Sri Lanka
const shots = process.env.WF_TENANT_SHOTS;

/* ── five loans of one person: paid off, overdue, due later, across two years, and one given yesterday ─ */
const fsx = createFirestore();
const db = fsx.db;
{ const orig = db.runTransaction.bind(db); let chain = Promise.resolve(); db.runTransaction = (fn) => { const p = chain.then(() => orig(fn)); chain = p.catch(() => {}); return p; }; }
const loan = (id, name, dueISO, events) => ({ id, name, fullName: name, dueISO, phone: '077 123 4567', nic: NIC, sms_notifications_enabled: true, sms_enabled_at: NOW - 60 * 86400e3, events: events.map(([kind, amount, date], i) => ({ id: `${id}-e${i}`, kind, amount, date, confirmed: true })) });
fsx.data.set('users/owner1', {
    settings: { currency: 'LKR' },
    payAccounts: [{ id: 'acc1', bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', showTo: 'both', active: true, createdAt: '2026-01-01', _ut: 1 }],
    income: [],
    debtors: [
        loan('paid', 'Kaushani Weerakoon', '', [['lent', 1000, '2026-10-05'], ['repayment', 150, '2026-10-06'], ['repayment', 300, '2026-10-06'], ['repayment', 100, '2026-10-09'], ['repayment', 450, '2026-10-14']]),
        loan('late', 'Kaushani Weerakoon', '2026-10-19', [['lent', 50000, '2026-09-01'], ['repayment', 20000, '2026-09-20']]),
        loan('later', 'Kaushani Weerakoon', '2026-11-15', [['lent', 250000, '2026-06-15'], ['repayment', 80000, '2026-07-01'], ['topup', 100000, '2026-08-02'], ['repayment', 60000, '2026-09-12']]),
        loan('years', 'Kaushani Weerakoon', '2027-01-30', [['lent', 5000000, '2025-12-10'], ['repayment', 1200000, '2026-03-03'], ['repayment', 800000, '2026-06-20']]),
        loan('fresh', 'Kaushani Weerakoon', '2026-12-01', [['lent', 20000, '2026-10-21']]),
        loan('today', 'Kaushani Weerakoon', '2026-12-01', [['lent', 7000, '2026-10-23']]),
    ],
});
const TOKEN = await ensureTenantToken({ db, uid: 'owner1', canonicalNic: CANON, secret: portalSecret(ENV), now: NOW - 1000 });

const sent = [];
const gateway = { configured: true, senderId: 'WealthFlow', async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; } };
const deps = { client: () => gateway, getAdminDb: async () => ({ db }), env: ENV, now: () => NOW, randomInt: crypto.randomInt, randomBytes: crypto.randomBytes, pad: null };

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

const browser = await launchChromium({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.clock.install({ time: NOW });                     // the page's own clock agrees with the server's: a session is 20 minutes from NOW
const page = await context.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`console.${m.type()}: ${m.text()}`); });

const snap = async (locator, name) => { if (!shots) return; fs.mkdirSync(shots, { recursive: true }); await locator.evaluate((el) => el.scrollIntoView({ block: 'center' })); await page.waitForTimeout(1300); await locator.screenshot({ path: path.join(shots, `${name}.png`) }); };
// the statement lists loans by the day they began: years, later, late, paid, fresh (and the one given today, which has no chart)
const ORDER = { years: 0, later: 1, late: 2, paid: 3, fresh: 4 };
const card = (name) => page.locator('.tp-card:has(.tp-trail)').nth(ORDER[name]);

/* sign in the way a person does ---------------------------------------------- */
await page.goto(`${base}/t/${TOKEN}`);
await page.fill('#tp-nic', NIC);
await page.click('#tp-send');
await page.waitForSelector('#tp-code');
await page.fill('#tp-code', /^(\d{6}) is your WealthFlow/.exec(sent.at(-1).message)[1]);
await page.click('#tp-verify');
await page.waitForSelector('#tp-out');
await page.waitForSelector('.tp-trail .tp-ch');

const trails = page.locator('.tp-trail');
assert.equal(await trails.count(), 5, 'five of the six loans have something to draw (the one given today has no stretch of time yet)');
assert.equal(await page.locator('.tp-card[aria-label^="Loan"]').count(), 6, 'there are six loan cards');
assert.equal(await page.locator('.tp-card[aria-label^="Loan"]').last().locator('.tp-trail').count(), 0, 'and the one given today has no chart, not an empty one');

/* each chart is a real, labelled control, drawn at the width it was given ------ */
const geometry = await page.evaluate(() => [...document.querySelectorAll('.tp-trail')].map((t) => {
    const plot = t.querySelector('.tp-ch-plot');
    const svg = t.querySelector('svg.tp-ch');
    const vb = svg.viewBox.baseVal;
    return { role: plot.getAttribute('role'), label: plot.getAttribute('aria-label'), now: Number(plot.getAttribute('aria-valuenow')), max: Number(plot.getAttribute('aria-valuemax')), tab: plot.tabIndex, width: plot.clientWidth, vbw: vb.width, hidden: svg.getAttribute('aria-hidden'), marks: svg.querySelectorAll('.tp-ch-mk').length };
}));
for (const g of geometry) {
    assert.deepEqual([g.role, g.label, g.tab, g.hidden], ['slider', 'Balance over time', 0, 'true'], 'a slider a keyboard can reach, with the picture itself hidden from a screen reader');
    assert.ok(Math.abs(g.width - g.vbw) <= 1, `drawn at its own width (${g.width} vs ${g.vbw}), so the words on it are never stretched`);
    assert.equal(g.now, g.max, 'it starts on the latest point');
    assert.equal(g.marks, g.max, 'one marker for each point');
}
console.log('1. drawn              -> five charts, each a slider at its real width, starting on the latest point');

/* the settled loan: a staircase down to nothing, five movements --------------- */
const paid = card('paid');
{
    const read = async () => ({ when: await paid.locator('.tp-ch-when').textContent(), tag: (await paid.locator('.tp-ch-tag').textContent()).trim(), money: (await paid.locator('.tp-ch-money').textContent()).replace(/\s+/g, ' '), delta: await paid.locator('.tp-ch-delta').textContent(), done: await paid.locator('.tp-ch-done').isVisible() });
    assert.deepEqual(await read(), { when: '14 Oct 2026', tag: 'Repayment', money: 'LKR 0.00', delta: '−450.00', done: true }, 'it opens on the last repayment, with the balance after it, and says the loan is fully repaid');
    assert.equal(await paid.locator('.tp-ch-due').count(), 0, 'a loan with nothing owed has no due date on it');
    assert.equal(await paid.locator('.tp-k-now').count(), 0, 'and no "today": a settled loan stops at its last movement');
    assert.equal(await paid.locator('.tp-key-dot.tp-k-now').count(), 0, 'the key lists only what is drawn');
    const lines = await paid.locator('.tp-ch-lab').allTextContents();
    assert.ok(['0', '250', '500', '750', '1K'].every((l) => lines.includes(l)), `round figures up the side: ${lines}`);
    assert.ok(lines.includes('5 Oct') && lines.includes('14 Oct'), 'and the first and last day along the bottom');

    // the arrow keys step through the movements; Home and End jump; the table marks the same row
    await paid.locator('.tp-ch-plot').focus();
    await page.keyboard.press('ArrowLeft');
    assert.deepEqual([(await read()).when, (await read()).delta, (await read()).money], ['9 Oct 2026', '−100.00', 'LKR 450.00'], 'left goes one movement back');
    assert.equal(await paid.locator('.tp-ch-plot').getAttribute('aria-valuenow'), '4');
    assert.match(await paid.locator('.tp-ch-plot').getAttribute('aria-valuetext'), /^9 Oct 2026, Repayment: LKR 100\.00\. Balance after: LKR 450\.00$/, 'and a screen reader is told it in a sentence');
    assert.equal(await paid.locator('tbody tr.tp-row-on').count(), 1, 'one row of the table is marked');
    assert.match(await paid.locator('tbody tr.tp-row-on').textContent(), /9 Oct 2026/, 'and it is the same movement');
    await page.keyboard.press('Home');
    assert.deepEqual([(await read()).when, (await read()).tag, (await read()).delta, (await read()).money, (await read()).done], ['5 Oct 2026', 'Loan disbursed', '+1,000.00', 'LKR 1,000.00', false], 'Home is the loan being given');
    assert.equal(await paid.locator('.tp-ch-step').first().getAttribute('aria-disabled'), 'true', 'there is no earlier movement to step to');
    await page.keyboard.press('ArrowLeft');
    assert.equal((await read()).when, '5 Oct 2026', 'and one more press stays put');
    await paid.locator('.tp-ch-step').nth(1).click();
    assert.deepEqual([(await read()).when, (await read()).delta], ['6 Oct 2026', '−150.00'], 'the right-hand button goes forward');
    await paid.locator('.tp-ch-step').nth(1).click();
    assert.deepEqual([(await read()).when, (await read()).delta, (await read()).money], ['6 Oct 2026', '−300.00', 'LKR 550.00'], 'two movements on one day are two steps');
    await paid.locator('.tp-ch-plot').focus();
    await page.keyboard.press('End');
    assert.equal((await read()).money, 'LKR 0.00');
    assert.equal(await paid.locator('.tp-ch-hint').isHidden(), true, 'the hint under the chart is gone once the person has used it');
}
console.log('2. keyboard and buttons -> arrows, Home, End and the two buttons move the card, the table marks the row, a screen reader gets a sentence');

/* a finger or a mouse: the nearest movement to where it is ------------------- */
{
    const centre = async (n) => paid.locator('.tp-ch-mk').nth(n).evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const where = await centre(3);
    await page.mouse.move(where.x + 2, where.y - 40);
    assert.equal(await paid.locator('.tp-ch-when').textContent(), '9 Oct 2026', 'moving the mouse over the chart picks the movement under it');
    const first = await centre(0);
    await page.mouse.move(first.x - 6, first.y);
    assert.equal(await paid.locator('.tp-ch-when').textContent(), '5 Oct 2026', 'and just left of the first one is still the first');
    const dot = await paid.locator('.tp-ch-dot').evaluate((e) => ({ cx: Number(e.getAttribute('cx')), cy: Number(e.getAttribute('cy')) }));
    const mk = await paid.locator('.tp-ch-mk').first().evaluate((e) => ({ cx: Number(e.getAttribute('cx')), cy: Number(e.getAttribute('cy')) }));
    assert.deepEqual(dot, mk, 'the big dot sits on the movement the card talks about');
}
console.log('3. pointer            -> the nearest movement to the pointer is chosen, and the dot follows');

/* the overdue loan: today, and the due date behind it, in red ------------------ */
const late = card('late');
{
    assert.equal(await late.locator('.tp-k-now.tp-ch-mk').count(), 1, 'an open loan carries on to today');
    assert.equal(await late.locator('.tp-ch-due.tp-late').count(), 1, 'its overdue date is marked, in red');
    assert.equal(await late.locator('.tp-ch-duelab').textContent(), 'Due 19 Oct', 'with the date');
    assert.equal(await late.locator('.tp-ch-when').textContent(), '23 Oct 2026', 'it opens on today');
    assert.equal((await late.locator('.tp-ch-tag').textContent()).trim(), 'Today');
    assert.equal(await late.locator('.tp-ch-delta').textContent(), 'No movement since 20 Sep 2026', 'and says nothing has happened since the last payment');
    assert.equal(await late.locator('.tp-ch-money').textContent().then((s) => s.replace(/\s+/g, ' ')), 'LKR 30,000.00');
    assert.equal(await late.locator('tbody tr.tp-row-on').count(), 0, 'today is not a row of the table, so none is marked');
    const keys = (await late.locator('.tp-ch-key li').allTextContents()).map((s) => s.trim());
    assert.deepEqual(keys, ['Money lent', 'Repayment', 'Today', 'Due date'], 'the key names what is drawn');
}
const later = card('later');
{
    assert.equal(await later.locator('.tp-ch-due').count(), 1);
    assert.equal(await later.locator('.tp-ch-due.tp-late').count(), 0, 'a date still to come is amber, not red');
    assert.equal(await later.locator('.tp-ch-duelab').textContent(), 'Due 15 Nov');
    const [lastX, dueX] = await later.evaluate((el) => [Number([...el.querySelectorAll('.tp-ch-mk')].at(-1).getAttribute('cx')), Number(el.querySelector('.tp-ch-due').getAttribute('x1'))]);
    assert.ok(dueX > lastX + 20, 'the stretch is drawn on to the due date, so today and the date are apart');
    const ends = (await later.locator('.tp-ch-lab').allTextContents()).filter((s) => /Nov|Jun/.test(s));
    assert.ok(ends.length >= 2, `dates run to the due date: ${ends}`);
    assert.match(await later.locator('.tp-ch-sum').textContent(), /Repayments made: 2 · Last repayment: 12 Sep 2026/);
    assert.match(await later.locator('.tp-ch-sum').textContent(), /Balance went from LKR 250,000\.00 to LKR 210,000\.00/);
}
const years = card('years');
{
    const labels = await years.locator('.tp-ch-lab').allTextContents();
    assert.ok(labels.some((s) => /’25/.test(s)) && labels.some((s) => /’27|’26/.test(s)), `a stretch that crosses a year puts the year on its dates: ${labels}`);
    assert.ok(labels.includes('5M') && labels.includes('2.5M'), `and millions are written short: ${labels}`);
}
const fresh = card('fresh');
assert.equal(await fresh.locator('.tp-ch-mk').count(), 2, 'a loan given two days ago draws the day it was given and today');
console.log('4. today and due date -> open loans run on to today with the due date marked (red when overdue); a settled loan stops; years are labelled; millions are short');

/* amounts blur with the rest of the page ----------------------------------------- */
{
    await page.click('#tp-eye');
    const blurred = await paid.evaluate((el) => [...el.querySelectorAll('.tp-ch-money, .tp-ch-delta, .tp-ch-lab.tp-amt')].map((e) => getComputedStyle(e).filter));
    await page.waitForTimeout(400);
    const after = await paid.evaluate((el) => [...el.querySelectorAll('.tp-ch-money, .tp-ch-delta, .tp-ch-lab.tp-amt')].map((e) => getComputedStyle(e).filter));
    assert.ok(after.length >= 4 && after.every((f) => /blur/.test(f)), `the figure, the change and the up-axis blur when amounts are hidden: ${after}`);
    void blurred;
    await snap(paid.locator('.tp-trail'), 'chart-hidden-amounts');
    await page.click('#tp-eye');
    await page.waitForTimeout(400);
}
console.log('5. hide amounts       -> the figures on the chart blur with the rest');

/* a different width draws it again, a different language and theme read ------------ */
{
    await page.setViewportSize({ width: 760, height: 900 });
    await page.waitForFunction(() => { const p = document.querySelector('.tp-ch-plot'); return Math.abs(p.clientWidth - document.querySelector('svg.tp-ch').viewBox.baseVal.width) <= 1 && p.clientWidth > 450; });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.waitForFunction(() => { const p = document.querySelector('.tp-ch-plot'); return Math.abs(p.clientWidth - document.querySelector('svg.tp-ch').viewBox.baseVal.width) <= 1 && p.clientWidth < 270; });
    const fits = await page.evaluate(() => ({ sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, smallest: Math.min(...[...document.querySelectorAll('.tp-trail text')].map((t) => parseFloat(getComputedStyle(t).fontSize))), buttons: [...document.querySelectorAll('.tp-ch-step')].every((b) => b.getBoundingClientRect().width >= 44 && b.getBoundingClientRect().height >= 44) }));
    assert.deepEqual(fits, { sideways: false, smallest: Math.max(12, fits.smallest), buttons: true }, 'a 320 px phone: no sideways scroll, nothing under 12 px, finger-sized buttons');
    assert.ok(fits.smallest >= 12);
    await snap(paid.locator('.tp-trail'), 'chart-320');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('.tp-ch-plot').clientWidth > 270);
    await snap(paid.locator('.tp-trail'), 'chart-390');
    await snap(late.locator('.tp-trail'), 'chart-390-overdue');
    await snap(later.locator('.tp-trail'), 'chart-390-later');
    await snap(years.locator('.tp-trail'), 'chart-390-years');

    await page.click('#tp-theme');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    const ink = await paid.evaluate((el) => ({ line: getComputedStyle(el.querySelector('.tp-ch-line')).stroke, text: getComputedStyle(el.querySelector('.tp-ch-lab')).fill, bg: getComputedStyle(el.querySelector('.tp-trail')).backgroundColor }));
    assert.notEqual(ink.line, ink.bg, 'the line is not the colour of its own panel');
    await snap(paid.locator('.tp-trail'), 'chart-390-dark');
    await snap(late.locator('.tp-trail'), 'chart-390-overdue-dark');
    await page.click('#tp-theme');

    await page.click('#tp-lang');
    await page.waitForFunction(() => /ඉන් පසු ශේෂය|අද ශේෂය/.test(document.querySelector('.tp-ch-label').textContent));
    const si = await card('late').evaluate((el) => ({ label: el.querySelector('.tp-ch-label').textContent, tag: el.querySelector('.tp-ch-tag').textContent.trim(), due: el.querySelector('.tp-ch-duelab').textContent, hint: el.querySelector('.tp-ch-hint').textContent }));
    assert.deepEqual([si.label, si.tag], ['අද ශේෂය', 'අද'], 'Sinhala: the card');
    assert.match(si.due, /^නියමිත දිනය /, 'Sinhala: the due flag');
    assert.match(si.hint, /ප්‍රස්ථාරය/, 'Sinhala: the hint');
    await snap(card('late').locator('.tp-trail'), 'chart-390-overdue-si');
    await page.click('#tp-lang');
    await page.waitForFunction(() => /Balance today/.test(document.querySelector('.tp-ch-label').textContent));
}
console.log('6. width, theme, language -> redrawn at each width, nothing under 12 px or 44 px on 320, dark and Sinhala read');

/* a wide screen: the chart takes the width of its card, taller, with more dates along the bottom ----------- */
{
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => document.querySelector('.tp-ch-plot').clientWidth > 500);
    const wide = await page.evaluate(() => ({ svgH: document.querySelector('svg.tp-ch').viewBox.baseVal.height, dates: [...document.querySelector('.tp-trail').querySelectorAll('.tp-ch-lab')].length, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
    assert.equal(wide.sideways, false);
    assert.ok(wide.svgH >= 216, `taller than on a phone: ${wide.svgH}`);
    await snap(paid.locator('.tp-trail'), 'chart-1280');
    await snap(late.locator('.tp-trail'), 'chart-1280-overdue');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('.tp-ch-plot').clientWidth < 360);
}

/* a person who asked for less motion gets the line, not the drawing of it ---------- */
{
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await page.evaluate(() => getComputedStyle(document.querySelector('.tp-ch-line')).animationName);
    assert.equal(still, 'none', 'no animation under reduced motion');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
}

// Chromium logs every non-2xx fetch as a console error: the 401 (no session yet, before the code) and the 404 (the icon the page does not ship) are expected; a policy violation or a script error is not
const expected = /Failed to load resource: the server responded with a status of (401|404)/;
assert.deepEqual(problems.filter((p) => !expected.test(p)), [], 'no console errors or policy violations: ' + problems.join(' | '));
console.log('the balance chart works on a real browser, under the page\'s real policy');
await browser.close();
server.close();
