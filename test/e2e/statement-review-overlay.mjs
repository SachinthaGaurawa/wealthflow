/** Browser regression for "the screen goes dark after Open reviews" (Dashboard > Statement Sync).
 *
 * The review list was a hand-made full-screen layer around a bare `.md`. The design system (wf-ui.css) keeps a `.md` at opacity 0 until the `.mo` around it
 * is open, so the layer showed and the list did not: a dark screen, every click caught by the layer, nothing to press. Checked here, in real Chromium on
 * the real app, by pressing the real button:
 *   - the list is visible, inside the viewport and on top, at phone / tablet / desktop widths in both themes, and it closes (Close, backdrop, Escape)
 *   - "Dismiss statement" opens its confirmation ABOVE the list (it used to open underneath the layer)
 *   - a list that cannot be built shows a message with a Close button, never an empty dark layer
 *   - a `.md` outside any `.mo` is visible (the root cause)
 *   - the per-row review modal never leaves an empty dark layer behind when building it throws
 * Stubbed Firebase, invented records. Run from the repository root:  node test/e2e/statement-review-overlay.mjs
 * WF_REVIEW_ARTIFACTS optionally selects a directory for screenshots.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootApp } from './harness.mjs';
import { TEST_USER } from './firebase-stub.mjs';

const artifacts = process.env.WF_REVIEW_ARTIFACTS || '';
if (artifacts) await fs.mkdir(artifacts, { recursive: true });

const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };

const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});

// Two invented reviews: a whole statement that needs its layout mapped, and one row that needs a look.
const REVIEWS = [
    { id: 'whole', status: 'pending', bank: 'Nations Trust Bank', filename: 'eStatement_0276_2026MAY.html', index: -1, reason: 'statement-layout-or-reconciliation-needs-review' },
    { id: 'row', status: 'pending', bank: 'Sampath Bank', filename: 'statement.pdf', index: 3, reason: 'invalid-transaction', row: { date: '2026-08-02', description: 'POS PURCHASE EXAMPLE SHOP', amount: 1250 } },
];

/** Give the app's statement module a fake Firestore that serves `docs` and lets the test push a new snapshot. */
const serve = (docs) => page.evaluate(async ({ user, docs }) => {
    const wrap = docs.map((d) => ({ id: d.id, data: () => d }));
    await window.WFStatementCloud.authChanged(null);
    window.db = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ limit: () => ({ onSnapshot: (cb) => { window.__reviewPush = (list) => cb({ docs: list.map((d) => ({ id: d.id, data: () => d })) }); cb({ docs: wrap }); return () => {}; } }) }) }) }) }) };
    await window.WFStatementCloud.authChanged({ uid: user.uid, getIdToken: async () => 'token' });
}, { user: TEST_USER, docs });

const card = async () => {
    await page.evaluate(() => { showPage('dashboard'); _mailSyncState.connected = true; _mailSyncState.reviewStatements = 2; renderMailSync(); });
    await page.waitForSelector('#_ms_reviews', { timeout: 8000 });
    await page.evaluate(() => document.getElementById('_ms_reviews').scrollIntoView({ block: 'center' }));
};
const theme = (t) => page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t);
const settle = () => page.waitForTimeout(450);
const quiet = () => page.evaluate(() => { const h = document.getElementById('notifs'); if (h) { if (h._wfQ) h._wfQ.length = 0; h.replaceChildren(); } });

/** What a person sees: is the list there, readable, inside the screen and on top of everything else? */
const seen = () => page.evaluate(() => {
    const o = document.querySelector('.wf-statement-review, body > [role="dialog"][aria-modal]');
    const md = o && o.querySelector('.md');
    if (!md) return { present: !!o };
    const r = md.getBoundingClientRect(), cs = getComputedStyle(md);
    const top = (x, y) => { const e = document.elementFromPoint(x, y); return !!e && md.contains(e); };
    const close = [...md.querySelectorAll('button')].find((b) => /^Close$/.test(b.textContent.trim()));
    const cr = close && close.getBoundingClientRect();
    return {
        present: true, open: o.classList.contains('open'), opacity: Number(cs.opacity), text: md.textContent,
        inside: r.left >= -0.5 && r.top >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5,
        wide: r.width > 200 && r.height > 80,
        onTop: top(r.left + r.width / 2, r.top + Math.min(r.height / 2, 60)),
        closeOnTop: !!cr && top(cr.left + cr.width / 2, cr.top + cr.height / 2),
        sideways: document.documentElement.scrollWidth > innerWidth + 1,
    };
});
/** Clear whatever a failed step left on screen, so one finding does not hide the next. */
const clear = () => page.evaluate(() => {
    document.querySelectorAll('.wf-statement-review, body > [role="dialog"][aria-modal]').forEach((o) => o.remove());
    document.querySelectorAll('.mo.open').forEach((o) => o.classList.remove('open'));
});
/** Press a button the way a person would. A button that cannot be pressed is a finding, not a hang. */
const tap = async (locator, what) => {
    try { await locator.first().click({ timeout: 3000 }); return true; }
    catch (_) { fail.push(`${what} cannot be pressed (something covers it)`); await clear(); return false; }
};
const open = (at) => tap(page.locator('#_ms_reviews'), `${at}: the Open reviews button`);
const press = (name, at) => tap(page.locator('.wf-statement-review .md button', { hasText: name }), `${at}: the ${name} button`);
const nothingLeft = () => page.evaluate(() => ({
    list: !!document.querySelector('.wf-statement-review, body > [role="dialog"][aria-modal]'),
    open: document.querySelectorAll('.mo.open').length,
}));

await serve(REVIEWS);

// ── The real button, every width and both themes ─────────────────────────────
for (const [label, vp] of [['phone 390', { width: 390, height: 844 }], ['tablet 820', { width: 820, height: 1100 }], ['laptop 1280', { width: 1280, height: 720 }], ['desktop 1440', { width: 1440, height: 900 }]]) {
    for (const t of ['dark', 'light']) {
        await page.setViewportSize(vp);
        await theme(t);
        await card();
        await quiet();
        await open(`${label} ${t}`);
        await settle();
        const s = await seen();
        const at = `${label} ${t}`;
        check(s.present, `${at}: Open reviews showed nothing`);
        if (!s.present) continue;
        check(s.open, `${at}: the list is not an open dialog`);
        check(s.opacity === 1, `${at}: the list is invisible (opacity ${s.opacity}) under the dark layer`);
        check(s.wide && s.inside, `${at}: the list is not fully on screen`);
        check(s.onTop && s.closeOnTop, `${at}: something else covers the list or its Close button`);
        check(!s.sideways, `${at}: the page scrolls sideways`);
        check(/Map statement layout/.test(s.text) && /Dismiss statement/.test(s.text) && /Review/.test(s.text), `${at}: the review actions are missing`);
        if (artifacts) await page.screenshot({ path: path.join(artifacts, `review-${label.replace(' ', '-')}-${t}.png`) });
        await press(/^Close$/, at);
        await settle();
        const after = await nothingLeft();
        check(!after.list && after.open === 0, `${at}: after Close a dark layer is still on screen (${JSON.stringify(after)})`);
    }
}

// ── Closing it every way a person tries ──────────────────────────────────────
await page.setViewportSize({ width: 1280, height: 720 });
await theme('dark');
await card();
await open('tap outside');
await settle();
await page.mouse.click(6, 6);                                   // the dark area beside the list
await settle();
let gone = await nothingLeft();
check(!gone.list && gone.open === 0, `a tap on the dark area should close the list (${JSON.stringify(gone)})`);

await card();
await open('Escape');
await settle();
await page.keyboard.press('Escape');
await settle();
await page.evaluate((d) => window.__reviewPush(d), REVIEWS);   // the next snapshot must not bring a hidden list back
gone = await nothingLeft();
check(!gone.list && gone.open === 0, `Escape should close the list and leave nothing behind (${JSON.stringify(gone)})`);

// ── "Dismiss statement" asks its question ABOVE the list ─────────────────────
await serve(REVIEWS);
await card();
await open('Dismiss');
await settle();
const pressed = await press(/^Dismiss statement$/, 'Dismiss statement');
await settle();
const ask = await page.evaluate(() => {
    const m = document.getElementById('mdConfirm'), b = document.getElementById('confBtn');
    if (!m || !b || !m.classList.contains('open')) return { open: false };
    const r = b.getBoundingClientRect(), e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { open: true, reachable: e === b || b.contains(e) };
});
check(!pressed || ask.open, 'Dismiss statement did not open its confirmation');
check(!pressed || ask.reachable, 'the confirmation opened underneath the review list: its button cannot be pressed');
await page.evaluate(() => { closeModal('mdConfirm'); });
await press(/^Close$/, 'after the confirmation');

// ── A list that cannot be built says so and can be closed ────────────────────
await serve(REVIEWS);
await card();
await open('broken list');
await settle();
const broken = await page.evaluate(() => {
    const bad = { id: 'bad', status: 'pending', bank: 'X', index: -1, reason: 'statement-layout-or-reconciliation-needs-review', row: { description: { toString() { throw new Error('unreadable record'); } } } };
    let threw = '';
    try { window.__reviewPush([bad]); } catch (e) { threw = String(e && e.message || e); }
    const md = document.querySelector('.wf-statement-review .md');
    const cs = md && getComputedStyle(md);
    return { threw, shown: !!md, opacity: cs && Number(cs.opacity), text: md && md.textContent, close: !!(md && [...md.querySelectorAll('button')].find((b) => /^Close$/.test(b.textContent.trim()))) };
});
check(!broken.threw, `a record that cannot be drawn made the list throw (${broken.threw})`);
check(broken.shown && broken.opacity === 1, 'a list that cannot be built left an empty dark layer instead of a message');
check(/could not be shown/.test(broken.text || '') && broken.close, 'the failure message and its Close button are missing');
await press(/^Close$/, 'failure message');
await settle();
gone = await nothingLeft();
check(!gone.list && gone.open === 0, `closing the failure message left a layer behind (${JSON.stringify(gone)})`);

// ── The root cause: a dialog box outside any dialog layer is visible ─────────
for (const vp of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(vp);
    const op = await page.evaluate(() => {
        const d = document.createElement('div'); d.className = 'md'; d.id = '__bare_md'; d.textContent = 'probe'; document.body.appendChild(d);
        const v = Number(getComputedStyle(d).opacity); d.remove(); return v;
    });
    check(op === 1, `a .md outside a .mo is invisible at ${vp.width}px (opacity ${op})`);
}

// ── The per-row review modal never leaves an empty dark layer when it cannot be built ──
await page.setViewportSize({ width: 1280, height: 720 });
const modal = await page.evaluate(async () => {
    if (typeof window._wfEsc !== 'function') return { skipped: 'no _wfEsc' };
    const real = window._wfEsc, before = document.querySelectorAll('.mo').length;
    window._wfEsc = (s) => { if (String(s).includes('BOOM-ROW')) throw new Error('cannot draw this row'); return real(s); };
    let threw = false;
    try { window._showCCReviewModal({ transactions: [{ date: '2026-08-02', description: 'BOOM-ROW', amount: 100, direction: 'debit', type: 'purchase' }], cloudReview: async () => {} }, 'Bank'); }
    catch (_) { threw = true; }
    finally { window._wfEsc = real; }
    await new Promise((r) => setTimeout(r, 400));
    const empties = [...document.querySelectorAll('.mo')].filter((o) => !o.querySelector('.md'));
    return { threw, empties: empties.length, open: document.querySelectorAll('.mo.open').length, added: document.querySelectorAll('.mo').length - before };
});
if (modal.skipped) fail.push(`review modal case skipped: ${modal.skipped}`);
else {
    check(modal.threw, 'the failing row should still raise its error to the caller');
    check(modal.empties === 0 && modal.open === 0, `the per-row review left an empty dark layer behind (${JSON.stringify(modal)})`);
}

if (app.pageErrors.length) fail.push(`uncaught page errors: ${app.pageErrors.join(' | ')}`);
await app.close();

if (fail.length) {
    console.error(`FAIL: ${fail.length} problem(s)\n - ${fail.join('\n - ')}`);
    process.exit(1);
}
assert.equal(fail.length, 0);
console.log('ok: the review list is visible, on top and closable at 4 widths in 2 themes; Dismiss asks above it; a list that cannot be built says so; no empty dark layer is ever left');
