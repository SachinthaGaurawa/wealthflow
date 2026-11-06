/* =============================================================================
 * autonomy/layout-probe.mjs — measure a screen in a real browser, at real phone widths
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS (issue #514, 2026-11-04)
 *   The fix agent's proof was a Vitest file over JavaScript. A report that says "CC Instalments
 *   overlaps on a smartphone" has no JavaScript to test: it is a picture. Without a measurement
 *   there is nothing that can be red before a fix and green after it, so the agent could not
 *   honestly attempt it. This module is that measurement.
 *
 * WHAT IT MEASURES (all in real Chromium, with the app's own scripts and CSS)
 *   • horizontal overflow: the page is wider than the screen;
 *   • overlap: two visible pieces of text/controls that are not inside one another draw on top of
 *     each other;
 *   • clipping: text cut off by its own box.
 *
 * HONESTY
 *   It measures the screens and the widths it is told to. A clean result means "no overlap was
 *   found in these screens at these widths with this invented data", not "the app is perfect".
 *   If the browser cannot start it says so (`ok:false, reason`) — it never reports a clean screen
 *   it did not look at.
 * ===========================================================================*/

import { bootApp } from '../test/e2e/harness.mjs';

/** Phone, large phone, small tablet, tablet, laptop. */
export const WIDTHS = [320, 360, 390, 430, 600, 768, 1024];

/** The screens the probe knows how to open, with invented books that fill them realistically. */
export const SCREENS = {
    'cc-instalments': { page: 'ccinstall', box: '#page-ccinstall', open: 'renderCCI' },
    'cc-onetime': { page: 'cconetime', box: '#page-cconetime', open: 'renderCCOT' },
};

/** Which screen does a report talk about? '' when it names none the probe can open. (Credit-card screens only; see anyScreenFor.) */
export function screenFor(text) {
    const t = String(text || '').toLowerCase();
    if (/(cc|credit card)\s*(in)?stal?l?ments?|instal+ments?\s*(page|screen|tab)?/.test(t) && !/one[- ]?time/.test(t)) return 'cc-instalments';
    if (/(cc|credit card)\s*one[- ]?time|one[- ]?time\s*(charges?|purchases?)/.test(t)) return 'cc-onetime';
    return '';
}

/**
 * Every top-level page of the app. The probe can open any of them: a report that says "this page overlaps on my phone" is not limited to
 * the two credit-card screens (issue #524 was filed from Settings about a card screen and the lane could open neither).
 */
export const PAGES = ['dashboard', 'income', 'expenses', 'loans', 'cheques', 'subscriptions', 'targets', 'balance', 'monthly', 'liquidity',
    'sessions', 'crib', 'score', 'settings', 'ai', 'montecarlo', 'dscr', 'cashflow3d', 'debtdemo'];

/** How a person names a page, most specific first. */
const PAGE_WORDS = [
    ['expenses', /\bexpenses?\b|\bspending\b/], ['income', /\bincome\b|\bsalary\b/], ['loans', /\bloans?\b/], ['cheques', /\bcheques?\b|\bchecks?\b/],
    ['subscriptions', /\bsubscriptions?\b/], ['targets', /\btargets?\b|\bgoals?\b/], ['balance', /\bbalance\s*(sheet|page|screen)\b/],
    ['monthly', /\bmonthly\s*(plan|budget)\b/], ['liquidity', /\bliquidity\b/], ['sessions', /\bsessions?\b/], ['crib', /\bcrib\b/],
    ['score', /\b(credit\s*)?score\b/], ['dashboard', /\bdashboard\b|\bhome\s*(screen|page)\b/], ['ai', /\bai\s*(chat|advisor|assistant|page)\b/],
    ['settings', /\bsettings?\b/],
];

/** A screen key for a page id: the two credit-card screens keep their long names. */
export function screenKeyOfPage(id) {
    const p = String(id || '').trim().toLowerCase();
    if (p === 'ccinstall') return 'cc-instalments';
    if (p === 'cconetime') return 'cc-onetime';
    return PAGES.includes(p) ? p : '';
}

/** What the probe needs to open a screen, or null. */
export function screenDef(key) {
    if (SCREENS[key]) return SCREENS[key];
    return PAGES.includes(key) ? { page: key, box: '#page-' + key, open: null } : null;
}

/** Any screen a person's words name: the credit-card screens first, then any page by its everyday name. '' when none. */
export function anyScreenFor(text) {
    const cc = screenFor(text);
    if (cc) return cc;
    const t = String(text || '').toLowerCase();
    for (const [id, re] of PAGE_WORDS) if (re.test(t)) return id;
    return '';
}

/** The screen a machine reading of a screenshot is about: by the words on it, then by the page it names. */
export function screenFromReading(text) {
    const t = String(text || '');
    if (/total cc financed|monthly cc payments|active plans|instal+ments? plans?/i.test(t)) return 'cc-instalments';
    if (/one[- ]?time (charges?|purchases?|payments?)/i.test(t)) return 'cc-onetime';
    const line = (t.match(/SCREEN:\s*([^\n]+)/i) || [])[1] || '';
    return line ? anyScreenFor(line) : '';
}

const SEED = `(() => {
    const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    window.wfCardRegistry && window.wfCardRegistry.set({
        '0276': { type: 'credit_card', bank: 'American Express (AMEX)', name: 'AMEX Platinum', network: 'Amex', last4: '0276' },
        '2020': { type: 'credit_card', bank: 'Sampath Bank', name: 'Sampath Visa', network: 'Visa', last4: '2020' },
    });
    const c = (id, desc, amount, bank, last4, d, paid) => ({ id, desc, amount, combinedTotal: amount, serviceFee: 0, bank, card_last4: last4, type: 'purchase', date: plus(d), deadline: plus(d + 50), paid: !!paid, createdAt: new Date().toISOString() });
    DB.set('cconetime', [
        c('a1', 'Keells Super Nugegoda Junction Branch', 124500.5, 'American Express (AMEX)', '0276', -12),
        c('a2', 'Cinnamon Grand Colombo dinner for four', 289000, 'American Express (AMEX)', '0276', -30),
        c('s1', 'PickMe rides', 3150, 'Sampath Bank', '2020', -5),
    ], true);
    DB.set('ccinstall', [
        { id: 'i1', product: 'MacBook Air M3 15-inch 16GB 512GB', bank: 'American Express (AMEX)', card_last4: '0276', buyer: 'Self', total: 4200000, rate: 0, duration: 12, monthly: 350000, date: plus(-100), completed: false },
        { id: 'i2', product: 'Daikin inverter AC', bank: 'American Express (AMEX)', card_last4: '0276', buyer: 'Self', total: 288000, rate: 0, duration: 24, monthly: 12000, date: plus(-40), completed: false },
        { id: 'i3', product: 'Samsung Galaxy S25 Ultra', bank: 'Sampath Bank', card_last4: '2020', buyer: 'Self', total: 240000, rate: 8, duration: 12, monthly: 21000, date: plus(-70), completed: false },
    ], true);
})()`;

/** Runs in the page: what is wrong inside `boxSel`. */
function measureInPage(boxSel) {
    const box = document.querySelector(boxSel);
    if (!box) return { missing: true, overflowPx: 0, overlaps: [], clipped: [], misaligned: [], spilled: [], pinnedCover: 0 };
    const vw = document.documentElement.clientWidth;
    const label = (el) => {
        const id = el.id ? '#' + el.id : '';
        const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return el.tagName.toLowerCase() + id + cls;
    };
    const textOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const visible = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
    };
    // "Things a person reads or taps": an element with its own text node, a control, or an image.
    // A piece of TEXT is measured where its letters are drawn (one box per line), not where its element's box is: a label squeezed
    // into a zero-width grid column has an empty box but still paints its words, on top of whatever sits beside it. That is the
    // overlap the owner photographed on CC Instalments (#524) and an element-box check cannot see it.
    const textBoxes = (el) => {
        const out = [];
        for (const n of el.childNodes) {
            if (n.nodeType !== 3 || !n.textContent.trim()) continue;
            const rg = document.createRange();
            rg.selectNodeContents(n);
            for (const q of rg.getClientRects()) if (q.width > 1 && q.height > 1) out.push(q);
        }
        return out;
    };
    const items = [];
    const spilled = [];
    for (const el of box.querySelectorAll('*')) {
        if (!visible(el)) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const control = /^(BUTTON|INPUT|SELECT|TEXTAREA|IMG|SVG|A)$/i.test(el.tagName);
        if (!own && !control) continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        const rects = own && !control ? textBoxes(el) : [r];
        if (!rects.length) continue;
        items.push({ el, r, rects });
        // Words drawn outside their own box (a label wider than its column) — reported even when nothing else is under them.
        if (own && !control && spilled.length < 8 && !/^(hidden|clip|auto|scroll)$/.test(cs.overflowX)) {
            const out = Math.max(...rects.map((q) => Math.max(q.right - (r.right + 2), (r.left - 2) - q.left)));
            if (out > 2 && r.width < vw) spilled.push(label(el) + ' "' + textOf(el) + '" runs ' + Math.round(out) + 'px outside its box');
        }
    }
    const hit = (a, b) => a.rects.some((x) => b.rects.some((y) => {
        const w = Math.min(x.right, y.right) - Math.max(x.left, y.left);
        const h = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
        return w > 4 && h > 4;
    }));
    // The Actions column is pinned on purpose (test/e2e/ui-toolbars.mjs requires it): on a phone it sits over the cell beside it while the
    // table scrolls. That is the accepted trade-off of a pinned column, not a layout defect, so it is counted apart and never asked to be "fixed".
    const inPinned = (el) => { const c = el.closest('td,th'); return !!c && getComputedStyle(c).position === 'sticky'; };
    let pinnedCover = 0;
    const overlaps = [];
    for (let i = 0; i < items.length && overlaps.length < 12; i++) {
        for (let j = i + 1; j < items.length && overlaps.length < 12; j++) {
            const a = items[i], b = items[j];
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            if (!hit(a, b)) continue;
            if (inPinned(a.el) || inPinned(b.el)) { pinnedCover++; continue; }
            const x = a.rects.flatMap((p) => b.rects.map((q) => ({ w: Math.min(p.right, q.right) - Math.max(p.left, q.left), h: Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) }))).filter((m) => m.w > 4 && m.h > 4).sort((m, n) => n.w * n.h - m.w * m.h)[0];
            overlaps.push({ a: label(a.el) + ' "' + textOf(a.el) + '"', b: label(b.el) + ' "' + textOf(b.el) + '"', px: Math.round(x.w) + 'x' + Math.round(x.h) });
        }
    }
    const clipped = [];
    for (const { el } of items) {
        if (clipped.length >= 8) break;
        const cs = getComputedStyle(el);
        const cutsOff = /^(hidden|clip)$/.test(cs.overflowX) || /^(hidden|clip)$/.test(cs.overflow);
        // An ellipsis on a plain label is a design choice. An ellipsis (or a hard cut) on anything with a digit is not:
        // an amount, a date or an instalment count that is cut off is a wrong number on a finance screen (#514, round 3).
        const hasDigit = /\d/.test(el.innerText || el.value || '');
        if (cutsOff && el.scrollWidth > el.clientWidth + 2 && (cs.textOverflow !== 'ellipsis' || hasDigit) && el.clientWidth > 0 && !/^(IMG|SVG|INPUT|SELECT)$/i.test(el.tagName)) {
            clipped.push(label(el) + ' "' + textOf(el) + '"');
        }
    }
    // A table whose body cells no longer sit under their headings shows an amount under the wrong title.
    const misaligned = [];
    for (const table of box.querySelectorAll('table')) {
        if (!visible(table) || misaligned.length >= 8) continue;
        const head = table.querySelector('thead tr') || table.querySelector('tr');
        const body = table.querySelector('tbody tr');
        if (!head || !body || head === body) continue;
        const hs = [...head.children].filter((c) => /^(TH|TD)$/.test(c.tagName));
        const bs = [...body.children].filter((c) => /^(TH|TD)$/.test(c.tagName));
        if (hs.length !== bs.length || [...hs, ...bs].some((c) => c.colSpan > 1)) continue;
        hs.forEach((h, i) => {
            if (!visible(h) || !visible(bs[i])) return;
            const dx = Math.abs(h.getBoundingClientRect().left - bs[i].getBoundingClientRect().left);
            if (dx > 3 && misaligned.length < 8) misaligned.push('heading "' + textOf(h) + '" is ' + Math.round(dx) + 'px away from its column');
        });
    }
    return { missing: false, overflowPx: Math.max(0, document.documentElement.scrollWidth - vw), overlaps, clipped, misaligned, spilled, pinnedCover };
}

/**
 * Open a screen at each width and report what is wrong.
 * @returns {Promise<{ok:boolean, reason?:string, screen:string, widths:Array<{width:number, overflowPx:number, overlaps:any[], clipped:string[], misaligned:string[]}>, problems:number}>}
 */
export async function probeLayout({ screen, repoDir = process.cwd(), widths = WIDTHS, extraCss = '', ignoreAgentFixes = false } = {}) {
    const def = screenDef(screen);
    if (!def) return { ok: false, reason: `the probe cannot open "${screen}"`, screen, widths: [], problems: 0 };
    let app;
    try { app = await bootApp({ repoDir }); }
    catch (e) { return { ok: false, reason: 'the browser could not start: ' + String((e && e.message) || e).slice(0, 160), screen, widths: [], problems: 0 }; }
    try {
        const { page } = app;
        await page.waitForFunction(() => !!(window.wfCardRegistry && window.DB && typeof window.showPage === 'function'), null, { timeout: 20000 });
        const note = page.locator('#wfPostUpdate');
        if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
        // For the probe's own tests: measure the page as if no fix had ever been appended to wf-agent-fixes.css.
        if (ignoreAgentFixes) await page.evaluate(() => document.querySelectorAll('link[href*="wf-agent-fixes.css"]').forEach((l) => l.remove()));
        await page.evaluate(SEED);
        if (extraCss) await page.addStyleTag({ content: extraCss });
        const out = [];
        let sample = '';
        for (const width of widths) {
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(([p, fn]) => { window.showPage(p); if (fn && typeof window[fn] === 'function') window[fn](); }, [def.page, def.open]);
            await page.waitForTimeout(250);
            const m = await page.evaluate(measureInPage, def.box);
            if (!sample) sample = await page.evaluate((b) => { const tr = document.querySelector(b + ' tbody tr, ' + b + ' .card, ' + b + ' li'); return tr ? tr.outerHTML.replace(/\s+/g, ' ').replace(/ (onclick|style)="[^"]*"/g, '').slice(0, 1400) : ''; }, def.box);
            if (m.missing) return { ok: false, reason: `the screen ${def.box} was not found`, screen, widths: out, problems: 0 };
            out.push({ width, overflowPx: m.overflowPx, overlaps: m.overlaps, clipped: m.clipped, misaligned: m.misaligned || [], spilled: m.spilled || [], pinnedCover: m.pinnedCover || 0 });
        }
        const problems = out.reduce((s, w) => s + (w.overflowPx > 2 ? 1 : 0) + w.overlaps.length + w.clipped.length + (w.misaligned || []).length + (w.spilled || []).length, 0);
        return { ok: true, screen, widths: out, problems, sample };
    } catch (e) {
        return { ok: false, reason: 'the measurement failed: ' + String((e && e.message) || e).slice(0, 200), screen, widths: [], problems: 0 };
    } finally { await app.close().catch(() => {}); }
}

/** A few plain lines for a prompt, a log or a PR body: repeated rows are counted, not listed. */
export function describeProbe(r) {
    if (!r || !r.ok) return 'The layout could not be measured' + (r && r.reason ? ' (' + r.reason + ')' : '') + '.';
    const lines = [];
    const kind = (s) => String(s).replace(/ ".*?"/g, '');
    for (const w of r.widths) {
        const bits = [];
        if (w.overflowPx > 2) bits.push(`the page is ${w.overflowPx}px wider than the screen`);
        const groups = new Map();
        for (const o of w.overlaps) {
            const k = kind(o.a) + ' overlaps ' + kind(o.b);
            const g = groups.get(k) || { n: 0, px: o.px, ex: o };
            g.n++; groups.set(k, g);
        }
        for (const [k, g] of [...groups].slice(0, 5)) bits.push(`${k}${g.n > 1 ? ` (${g.n} times, e.g. ${g.px})` : ` (${g.px})`}${g.n === 1 ? '' : ''} — e.g. "${String(g.ex.a).match(/"(.*)"/)?.[1] || ''}" with "${String(g.ex.b).match(/"(.*)"/)?.[1] || ''}"`);
        if (groups.size > 5) bits.push(`and ${groups.size - 5} more kinds`);
        for (const c of w.clipped.slice(0, 3)) bits.push(`text is cut off: ${c}`);
        for (const c of (w.misaligned || []).slice(0, 2)) bits.push(`columns no longer line up: ${c}`);
        for (const c of (w.spilled || []).slice(0, 3)) bits.push(`text spills out of its box: ${c}`);
        if (bits.length) lines.push(`At ${w.width}px wide: ${bits.join('; ')}.`);
    }
    return lines.length ? lines.join('\n') : `No overlap, overflow or cut-off text was found at ${r.widths.map((w) => w.width).join(', ')}px wide.`;
}

/**
 * No page was named and no screenshot could be read: look at every page at the reported phone width and say which ones are broken.
 * Slower than opening one page (one browser, every page), so it only runs when nothing else says where to look.
 * Table furniture (a pinned Actions column over its neighbour) is the accepted trade-off of the sticky column and is not counted here.
 * @returns {Promise<{ok:boolean, reason?:string, ranked:Array<{screen:string, score:number, problems:number}>}>}
 */
export async function sweepScreens({ repoDir = process.cwd(), width = 390, pages = PAGES } = {}) {
    let app;
    try { app = await bootApp({ repoDir }); }
    catch (e) { return { ok: false, reason: 'the browser could not start: ' + String((e && e.message) || e).slice(0, 160), ranked: [] }; }
    try {
        const { page } = app;
        await page.waitForFunction(() => !!(window.wfCardRegistry && window.DB && typeof window.showPage === 'function'), null, { timeout: 20000 });
        const note = page.locator('#wfPostUpdate');
        if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
        await page.evaluate(SEED);
        await page.setViewportSize({ width, height: 900 });
        const ranked = [];
        const all = [...new Set([...pages, 'ccinstall', 'cconetime'])];
        for (const id of all) {
            const def = id === 'ccinstall' ? SCREENS['cc-instalments'] : id === 'cconetime' ? SCREENS['cc-onetime'] : screenDef(id);
            if (!def) continue;
            await page.evaluate(([p, fn]) => { window.showPage(p); if (fn && typeof window[fn] === 'function') window[fn](); }, [def.page, def.open]);
            await page.waitForTimeout(200);
            const m = await page.evaluate(measureInPage, def.box).catch(() => null);
            if (!m || m.missing) continue;
            const furniture = (o) => /^(th|svg|button\.ib)/.test(o.a) || /^(th|svg|button\.ib)/.test(o.b) || /\bACTIONS\b/i.test(o.a + o.b);
            const real = m.overlaps.filter((o) => !furniture(o));
            const score = m.spilled.length * 3 + real.length + (m.overflowPx > 2 ? 2 : 0) + m.clipped.length;
            if (score > 0) ranked.push({ screen: screenKeyOfPage(id) || id, score, problems: m.overlaps.length + m.spilled.length + m.clipped.length + (m.overflowPx > 2 ? 1 : 0) });
        }
        ranked.sort((a, b) => b.score - a.score);
        return { ok: true, ranked };
    } catch (e) {
        return { ok: false, reason: 'the sweep failed: ' + String((e && e.message) || e).slice(0, 200), ranked: [] };
    } finally { await app.close().catch(() => {}); }
}
