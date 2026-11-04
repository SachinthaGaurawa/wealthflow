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

/** Which screen does a report talk about? '' when it names none the probe can open. */
export function screenFor(text) {
    const t = String(text || '').toLowerCase();
    if (/(cc|credit card)\s*(in)?stal?l?ments?|instal+ments?\s*(page|screen|tab)?/.test(t) && !/one[- ]?time/.test(t)) return 'cc-instalments';
    if (/(cc|credit card)\s*one[- ]?time|one[- ]?time\s*(charges?|purchases?)/.test(t)) return 'cc-onetime';
    return '';
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
    if (!box) return { missing: true, overflowPx: 0, overlaps: [], clipped: [], misaligned: [] };
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
    const items = [];
    for (const el of box.querySelectorAll('*')) {
        if (!visible(el)) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        const control = /^(BUTTON|INPUT|SELECT|TEXTAREA|IMG|SVG|A)$/i.test(el.tagName);
        if (!own && !control) continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed') continue;
        items.push({ el, r: el.getBoundingClientRect() });
    }
    const overlaps = [];
    for (let i = 0; i < items.length && overlaps.length < 12; i++) {
        for (let j = i + 1; j < items.length && overlaps.length < 12; j++) {
            const a = items[i], b = items[j];
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
            const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
            if (w > 4 && h > 4) overlaps.push({ a: label(a.el) + ' "' + textOf(a.el) + '"', b: label(b.el) + ' "' + textOf(b.el) + '"', px: Math.round(w) + 'x' + Math.round(h) });
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
    return { missing: false, overflowPx: Math.max(0, document.documentElement.scrollWidth - vw), overlaps, clipped, misaligned };
}

/**
 * Open a screen at each width and report what is wrong.
 * @returns {Promise<{ok:boolean, reason?:string, screen:string, widths:Array<{width:number, overflowPx:number, overlaps:any[], clipped:string[], misaligned:string[]}>, problems:number}>}
 */
export async function probeLayout({ screen, repoDir = process.cwd(), widths = WIDTHS, extraCss = '', ignoreAgentFixes = false } = {}) {
    const def = SCREENS[screen];
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
            await page.evaluate(([p, fn]) => { window.showPage(p); if (typeof window[fn] === 'function') window[fn](); }, [def.page, def.open]);
            await page.waitForTimeout(250);
            const m = await page.evaluate(measureInPage, def.box);
            if (!sample) sample = await page.evaluate((b) => { const tr = document.querySelector(b + ' tbody tr, ' + b + ' .card, ' + b + ' li'); return tr ? tr.outerHTML.replace(/\s+/g, ' ').replace(/ (onclick|style)="[^"]*"/g, '').slice(0, 1400) : ''; }, def.box);
            if (m.missing) return { ok: false, reason: `the screen ${def.box} was not found`, screen, widths: out, problems: 0 };
            out.push({ width, overflowPx: m.overflowPx, overlaps: m.overlaps, clipped: m.clipped, misaligned: m.misaligned || [] });
        }
        const problems = out.reduce((s, w) => s + (w.overflowPx > 2 ? 1 : 0) + w.overlaps.length + w.clipped.length + (w.misaligned || []).length, 0);
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
        if (bits.length) lines.push(`At ${w.width}px wide: ${bits.join('; ')}.`);
    }
    return lines.length ? lines.join('\n') : `No overlap, overflow or cut-off text was found at ${r.widths.map((w) => w.width).join(', ')}px wide.`;
}
