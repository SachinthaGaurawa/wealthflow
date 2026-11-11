/** Accessibility audit of the real app against WCAG 2.2 AA (the measurable parts), page by page, in both themes at phone and desktop widths.
 * Measures: accessible names, form labels, target size (2.5.8), text contrast (1.4.3), visible focus (2.4.7), reduced motion, page language,
 * zoom not blocked (1.4.4), heading order, dialog semantics, live regions. Prints a count per rule and the worst offenders.
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/a11y-audit.mjs [--json]
 */
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const app = await bootApp();
const { page } = app;
const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, SEED());

const PAGES = await page.evaluate(() => [...document.querySelectorAll('[id^="page-"]')].map((e) => e.id.slice(5)));
const found = {};
const add = (rule, where, detail) => { (found[rule] = found[rule] || []).push(`${where} ${detail}`); };

const audit = () => page.evaluate(() => {
    const out = [];
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
    const sel = (e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
    const root = document.querySelector('.page.active') || document.body;
    const name = (e) => (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title') || e.textContent || e.value || '').trim();
    for (const e of root.querySelectorAll('button,[role=button],a[href],[onclick]')) {
        if (!vis(e)) continue;
        const r = e.getBoundingClientRect();
        const hasName = name(e) || e.querySelector('img[alt]:not([alt=""]),svg title');
        if (!hasName) out.push(['name', sel(e), 'no accessible name']);
        if ((r.width < 24 || r.height < 24) && e.tagName !== 'A') {
            // the 24px minimum has a spacing exception: a 24px circle around the target must not touch another target
            out.push(['target', sel(e), `${Math.round(r.width)}x${Math.round(r.height)}`]);
        }
    }
    for (const e of root.querySelectorAll('input:not([type=hidden]),select,textarea')) {
        if (!vis(e)) continue;
        const lab = e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
        if (!(lab || e.closest('label') || e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title') || e.placeholder)) out.push(['label', sel(e), 'no label']);
    }
    for (const e of root.querySelectorAll('img')) if (vis(e) && !e.hasAttribute('alt')) out.push(['alt', sel(e), 'no alt']);
    // contrast of text in the visible part of the page
    const bgOf = (el) => {
        let c = [0, 0, 0, 0]; const chain = [];
        for (let n = el; n; n = n.parentElement) chain.push(n);
        const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
        let base = [255, 255, 255];
        for (let i = chain.length - 1; i >= 0; i--) {
            const b = parse(getComputedStyle(chain[i]).backgroundColor); if (!b || b[3] === 0) continue;
            base = [0, 1, 2].map((k) => b[k] * b[3] + base[k] * (1 - b[3]));
        }
        return base;
    };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const seen = new Set();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t; (t = walker.nextNode());) {
        if (!t.textContent.trim()) continue;
        const el = t.parentElement; if (!el || !vis(el) || seen.has(el)) continue;
        const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight * 3) continue;
        seen.add(el);
        const cs = getComputedStyle(el); const m = cs.color.match(/rgba?\(([^)]+)\)/); if (!m) continue;
        const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); const a = p[3] === undefined ? 1 : p[3];
        const bg = bgOf(el); const fg = [0, 1, 2].map((k) => p[k] * a + bg[k] * (1 - a));
        const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700; const large = size >= 24 || (size >= 18.66 && bold);
        if (ratio < (large ? 3 : 4.5)) { const hx = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''); out.push(['contrast', sel(el), `${ratio.toFixed(2)}:1 fg ${hx(fg)} on ${hx(bg)} "${t.textContent.trim().slice(0, 24)}" ${size}px`]); }
    }
    // heading order
    let last = 0;
    for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) { if (!vis(h)) continue; const l = +h.tagName[1]; if (last && l > last + 1) out.push(['heading', sel(h), `h${last} then h${l}`]); last = l; }
    return out;
});

const global = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    viewport: (document.querySelector('meta[name=viewport]') || {}).content || '',
    reducedMotionRule: [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.media && /prefers-reduced-motion/.test(r.media.mediaText)); } catch (_) { return false; } }),
    liveRegions: document.querySelectorAll('[aria-live],[role=status],[role=alert]').length,
    dialogs: [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].length,
    modalsWithoutRole: [...document.querySelectorAll('[id*="odal"],[class*="modal"],[id*="Overlay"]')].filter((e) => !e.getAttribute('role') && !e.closest('[role=dialog]')).length,
    skipLink: !!document.querySelector('a[href^="#"][class*="skip"]'),
    landmarks: ['main', 'nav', 'header'].map((t) => t + ':' + document.querySelectorAll(t + ',[role=' + (t === 'header' ? 'banner' : t) + ']').length).join(' '),
}));
console.log('GLOBAL', JSON.stringify(global));
if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/.test(global.viewport)) add('zoom', 'viewport', global.viewport);

for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const [W, H] of [[390, 844], [1280, 900]]) {
        await page.setViewportSize({ width: W, height: H });
        for (const id of PAGES) {
            await page.evaluate((p) => { try { showPage(p, [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'" + p + "'"))); } catch (_) {} }, id);
            await page.waitForTimeout(250);
            const active = await page.evaluate(() => (document.querySelector('.page.active') || {}).id);
            if (active !== 'page-' + id) continue;
            for (const [rule, where, detail] of await audit()) add(rule, `${theme}@${W} ${id}`, `${where} ${detail}`);
        }
    }
}

// visible focus: tab through the first controls of the dashboard and look for an indicator
await page.setViewportSize({ width: 1280, height: 900 });
await page.evaluate(() => showPage('dashboard'));
let noFocus = 0, tabbed = 0;
for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const f = await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); const r = e.getBoundingClientRect(); return { tag: e.tagName, sel: e.id || e.className, outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, shadow: cs.boxShadow !== 'none', w: r.width }; });
    if (!f || f.w === 0) continue; tabbed++;
    if (!f.outline && !f.shadow) { noFocus++; add('focus', 'dashboard', `${f.tag} ${String(f.sel).slice(0, 40)} shows no focus indicator`); }
}
console.log(`FOCUS tabbed ${tabbed} controls, ${noFocus} with no visible indicator`);

const summary = Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.length]));
console.log('SUMMARY', JSON.stringify(summary));
for (const [rule, list] of Object.entries(found)) {
    const uniq = process.env.KEEP_THEME ? [...new Set(list.map((s) => s.replace(/@\d+ /, ' ')))] : [...new Set(list.map((s) => s.replace(/^(dark|light)@\d+ /, '')))];
    console.log(`\n== ${rule}: ${list.length} hits, ${uniq.length} distinct ==`);
    for (const s of uniq.slice(0, +(process.env.SHOW || 25))) console.log('  ' + s);
}
await app.close?.();
process.exit(0);
