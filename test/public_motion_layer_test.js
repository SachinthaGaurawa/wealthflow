/* test/public_motion_layer_test.js - the motion and scroll layer of the public pages, and the
 * look of the sign-in screen that follows them.
 *
 * The owner asked (2026-10-19) for effects on the public home page, a smooth scroll button on
 * /terms and /privacy, and the home page's gradient on the /app sign-in screen. What is pinned
 * here is what must stay true so that "effects" never turn into a page that hides its text,
 * ignores prefers-reduced-motion, listens to every scroll frame, or drags the sign-in screen
 * back to a flat black field:
 *   - the three pages load the layer, and the home page is complete without it;
 *   - wf-public.js has no scroll listener, makes no request, and the button behaves;
 *   - wf-public.css moves only transform and opacity (one named exception), keeps its motion
 *     inside prefers-reduced-motion: no-preference and has a failsafe for hidden sections;
 *   - the sign-in screen carries the home page's gradient, one accent, no em-dash.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LANDING = read('landing.html');
const PRIVACY = read('privacy.html');
const TERMS = read('terms.html');
const APP = read('index.html');
const CSS = read('assets/wf-public.css');
const JS = read('assets/wf-public.js');
const UI = read('wf-ui.css');

describe('the public pages load the layer', () => {
    it('each page links the stylesheet after its own styles and loads the script deferred', () => {
        for (const [name, html] of [['landing', LANDING], ['privacy', PRIVACY], ['terms', TERMS]]) {
            const link = html.indexOf('<link rel="stylesheet" href="/assets/wf-public.css">');
            expect(link, name).toBeGreaterThan(html.indexOf('</style>'));
            expect(html, name).toContain('<script src="/assets/wf-public.js" defer></script>');
            expect(html.indexOf('wf-public.js'), name).toBeLessThan(html.indexOf('</head>'));
        }
    });

    it('marks the home page and the two documents so the stylesheet can tell them apart', () => {
        expect(LANDING).toContain('<html lang="en" class="wfp-home">');
        expect(PRIVACY).toContain('<html lang="en" class="wfp-doc">');
        expect(TERMS).toContain('<html lang="en" class="wfp-doc">');
    });

    it('only the home page hides sections while it waits for the script, and the gate class is set before first paint', () => {
        for (const html of [LANDING, PRIVACY, TERMS]) {
            expect(html).toContain("document.documentElement.className+=' wfp-js';");
            expect(html.indexOf("wfp-js")).toBeLessThan(html.indexOf('</head>'));
        }
        expect(CSS).toMatch(/html\.wfp-home\.wfp-js :is\([^)]*\):not\(\.in\)/);
        expect(CSS).not.toMatch(/html\.wfp-doc[^{]*\{[^}]*opacity: 0/);
    });

    it('does not touch the home page forwarding script or load anything from another origin', () => {
        expect(LANDING).toMatch(/<script>\s*\(function \(\) \{[\s\S]*?l\.replace\('\/app'/);
        for (const html of [LANDING, PRIVACY, TERMS]) {
            expect(html.match(/<script[^>]*\ssrc="([^"]+)"/g).every((t) => /src="\/assets\//.test(t))).toBe(true);
        }
        // the SVG namespace is an identifier, not a request
        expect((CSS + JS).replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//);
    });
});

describe('wf-public.css', () => {
    const keyframes = [...CSS.matchAll(/@keyframes\s+(\w+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => ({ name: m[1], body: m[2] }));
    const propsOf = (body) => new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]));

    it('has the keyframes it needs', () => {
        expect(keyframes.map((k) => k.name).sort()).toEqual(['wfpArc', 'wfpDrift', 'wfpFail', 'wfpNeedle', 'wfpProgress', 'wfpRing', 'wfpUp']);
    });

    it('animates only transform and opacity, plus the one stroke it draws (the gauge arc and the progress ring)', () => {
        const allowed = new Set(['transform', 'opacity', 'stroke-dashoffset']);
        for (const k of keyframes) {
            for (const prop of propsOf(k.body)) expect(allowed.has(prop), `${k.name} animates ${prop}`).toBe(true);
        }
    });

    it('keeps every moving thing inside prefers-reduced-motion: no-preference', () => {
        const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: no-preference)'));
        const end = block.indexOf('/* ── Accessibility fallbacks');
        const motion = block.slice(0, end);
        for (const name of ['wfpUp', 'wfpNeedle', 'wfpArc', 'wfpDrift', 'wfpFail']) expect(motion, name).toContain(`animation`) && expect(motion).toContain(name);
        // the infinite ambient drift must not exist outside the gated block
        const outside = CSS.replace(motion, '');
        expect(outside).not.toMatch(/infinite/);
        expect(outside).not.toContain('wfpDrift');
        expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
        expect(CSS).toContain('@media (prefers-reduced-transparency: reduce)');
    });

    it('reveals hidden sections by itself if the script never arrives (failsafe)', () => {
        expect(CSS).toMatch(/:not\(\.in\) \{\s*opacity: 0; animation: wfpFail \.5s ease 3s forwards;/);
    });

    it('scrolls smoothly, leaves room under the sticky header and respects the reduced-motion setting', () => {
        expect(CSS).toMatch(/html \{ scroll-behavior: smooth; \}/);
        expect(CSS).toMatch(/html\.wfp-home \{ scroll-padding-top: 84px; \}/);
        expect(CSS).toMatch(/html, html\.wfp-home \{ scroll-behavior: auto; \}/);
    });

    it('has no em-dash, no emoji and no scroll-event machinery', () => {
        for (const text of [CSS, JS]) {
            expect(text).not.toContain('—');
            expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
        }
        expect(CSS).not.toMatch(/z-index:\s*(9\d\d|\d{4,})/);
    });
});

/* A DOM just big enough for wf-public.js. */
function makeEnv({ reduce = false, withIO = true, home = true } = {}) {
    const listeners = [];
    const observers = [];
    const scrolls = [];
    function el(tag) {
        const classes = new Set();
        const attrs = {};
        const e = {
            tag, attrs, children: [], style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
            classList: {
                add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
                toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
            },
            setAttribute(k, v) { attrs[k] = String(v); if (k === 'id') e.id = String(v); },
            removeAttribute(k) { delete attrs[k]; },
            appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
            addEventListener(type, fn) { (e.handlers = e.handlers || {})[type] = fn; },
            focus() { e.focused = true; },
            getBoundingClientRect: () => ({ left: 10, top: 20 }),
            closest: () => null,
        };
        Object.defineProperty(e, 'className', { get: () => [...classes].join(' '), set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); } });
        return e;
    }
    const body = el('body');
    const root = el('html');
    if (home) root.classList.add('wfp-home'); else root.classList.add('wfp-doc');
    const header = el('header');
    const main = el('main'); main.id = 'main';
    const sections = {};
    const cards = [el('article'), el('article'), el('article')];
    const parent = el('div');
    cards.forEach((c) => { c.parentNode = parent; });
    const link = el('a'); link.attrs.href = '#features'; link.getAttribute = (k) => link.attrs[k];
    const features = el('section'); features.id = 'features';
    const document = {
        documentElement: root, body, createElement: el, createElementNS: (_ns, t) => el(t),
        querySelector: (s) => (s === 'header.top' ? header : null),
        querySelectorAll: (s) => {
            if (s.includes('.card')) return cards;
            if (s.includes('nav.main a.link')) return [link];
            return [];
        },
        getElementById: (id) => (id === 'main' ? main : id === 'features' ? features : null),
        addEventListener: (type, fn, o) => listeners.push({ target: 'document', type, fn, o }),
    };
    class IO {
        constructor(cb, opts) { this.cb = cb; this.opts = opts; this.watching = []; observers.push(this); }
        observe(t) { this.watching.push(t); }
        unobserve(t) { this.watching = this.watching.filter((x) => x !== t); }
    }
    const window = {
        matchMedia: () => ({ matches: reduce }),
        scrollTo: (...a) => scrolls.push(a),
        addEventListener: (type, fn) => listeners.push({ target: 'window', type, fn }),
        requestAnimationFrame: (fn) => { fn(); return 1; },
    };
    if (withIO) window.IntersectionObserver = IO;
    const ctx = { window, document, Map, Array, Object, Math, String };
    ctx.IntersectionObserver = withIO ? IO : undefined;
    // `'IntersectionObserver' in window` must reflect support
    vm.runInNewContext(JS, ctx);
    return { document, window, listeners, observers, scrolls, header, body, cards, link, features, main, root, fab: body.children.find((c) => c.className.includes('wfp-top')), markers: body.children.filter((c) => c.tag === 'div') };
}

describe('wf-public.js', () => {
    it('never listens to the scroll event, makes no request and touches no account code', () => {
        const env = makeEnv();
        expect(env.listeners.map((l) => l.type)).not.toContain('scroll');
        expect(JS).not.toMatch(/addEventListener\(\s*['"]scroll/);
        expect(JS).not.toMatch(/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|indexedDB|firebase)\b/);
        expect(JS).not.toMatch(/innerHTML|insertAdjacentHTML|eval\(|document\.write/);
    });

    it('adds one back-to-top button, named for screen readers, hidden until the first screen has passed', () => {
        const env = makeEnv();
        const fabs = env.body.children.filter((c) => c.className.includes('wfp-top'));
        expect(fabs).toHaveLength(1);
        expect(fabs[0].attrs['aria-label']).toBe('Back to top');
        expect(fabs[0].type).toBe('button');
        expect(fabs[0].classList.contains('is-on')).toBe(false);
        const marker = env.observers[1];
        marker.cb([{ isIntersecting: true, boundingClientRect: { top: 560 } }]);
        expect(env.fab.classList.contains('is-on')).toBe(false);
        marker.cb([{ isIntersecting: false, boundingClientRect: { top: -40 } }]);
        expect(env.fab.classList.contains('is-on')).toBe(true);
        // below the viewport on a short screen is not "scrolled past"
        marker.cb([{ isIntersecting: false, boundingClientRect: { top: 560 } }]);
        expect(env.fab.classList.contains('is-on')).toBe(false);
    });

    it('settles the header once the page has moved', () => {
        const env = makeEnv();
        const marker = env.observers[0];
        marker.cb([{ isIntersecting: false, boundingClientRect: { top: -2 } }]);
        expect(env.header.classList.contains('is-stuck')).toBe(true);
        marker.cb([{ isIntersecting: true, boundingClientRect: { top: 8 } }]);
        expect(env.header.classList.contains('is-stuck')).toBe(false);
    });

    it('scrolls to the top smoothly, or instantly when the reader asked for less motion, and moves focus to the content', () => {
        const smooth = makeEnv();
        smooth.fab.handlers.click();
        expect(smooth.scrolls).toEqual([[{ top: 0, behavior: 'smooth' }]]);
        expect(smooth.main.focused).toBe(true);
        expect(smooth.main.attrs.tabindex).toBe('-1');
        const calm = makeEnv({ reduce: true });
        calm.fab.handlers.click();
        expect(calm.scrolls).toEqual([[{ top: 0, behavior: 'auto' }]]);
    });

    it('shows the button at once where IntersectionObserver is missing', () => {
        const env = makeEnv({ withIO: false });
        expect(env.fab.classList.contains('is-on')).toBe(true);
        expect(env.observers).toHaveLength(0);
    });

    it('home: staggers a group of cards, reveals each as it arrives and stops watching it', () => {
        const env = makeEnv();
        expect(env.cards.map((c) => c.style.props['--i'])).toEqual([0, 1, 2]);
        const reveal = env.observers[2];
        expect(reveal.watching).toHaveLength(3);
        reveal.cb([{ isIntersecting: false, target: env.cards[0] }, { isIntersecting: true, target: env.cards[1] }]);
        expect(env.cards[0].classList.contains('in')).toBe(false);
        expect(env.cards[1].classList.contains('in')).toBe(true);
        expect(reveal.watching).not.toContain(env.cards[1]);
    });

    it('home: marks the section being read in the menu', () => {
        const env = makeEnv();
        const spy = env.observers[3];
        spy.cb([{ isIntersecting: true, target: env.features }]);
        expect(env.link.attrs['aria-current']).toBe('location');
        spy.cb([{ isIntersecting: false, target: env.features }]);
        expect(env.link.attrs['aria-current']).toBeUndefined();
    });

    it('home: with reduced motion, or without IntersectionObserver, everything is shown immediately', () => {
        for (const opts of [{ reduce: true }, { withIO: false }]) {
            const env = makeEnv(opts);
            expect(env.cards.every((c) => c.classList.contains('in'))).toBe(true);
        }
    });

    it('a document page gets the button and the header, and nothing of the home page behaviour', () => {
        const env = makeEnv({ home: false });
        expect(env.fab).toBeTruthy();
        expect(env.observers).toHaveLength(2);
        expect(env.cards.some((c) => c.classList.contains('in'))).toBe(false);
        expect(env.listeners).toHaveLength(0);
    });

    it('the pointer light follows only a mouse, once per frame', () => {
        const env = makeEnv();
        const move = env.listeners.find((l) => l.type === 'pointermove');
        expect(move.o).toEqual({ passive: true });
        const card = env.cards[0];
        move.fn({ pointerType: 'touch', target: { closest: () => card }, clientX: 50, clientY: 60 });
        expect(card.style.props['--mx']).toBeUndefined();
        move.fn({ pointerType: 'mouse', target: { closest: () => card }, clientX: 50, clientY: 60 });
        expect(card.style.props['--mx']).toBe('40px');
        expect(card.style.props['--my']).toBe('40px');
    });
});

describe('the /app sign-in screen wears the home page look', () => {
    const block = UI.slice(UI.indexOf('/* ═════════════════ 4. SIGN-IN'), UI.indexOf('/* ═════════════════ 5. SHELL'));

    it('uses the home page gradient and is pinned to its dark palette in every theme', () => {
        expect(block).toContain('radial-gradient(1200px 600px at 85% -10%, rgba(212, 175, 55, .14), transparent 60%)');
        expect(block).toContain('radial-gradient(900px 500px at -10% 10%, rgba(23, 50, 99, .7), transparent 60%)');
        expect(block).toContain('linear-gradient(180deg, #071226, #050d1c)');
        const screen = block.slice(block.indexOf('#authScreen {'), block.indexOf('.auth-box {'));
        for (const token of ['--wf-bg', '--wf-text', '--wf-text-2', '--wf-card', '--wf-accent:', '--text:', '--text2:', '--accent:', 'color-scheme: dark', 'color: var(--wf-text)']) {
            expect(screen, token).toContain(token);
        }
        // the landing page and the sign-in screen use the same two navy and gold values
        expect(LANDING).toContain('--navy-900:#071226');
        expect(LANDING).toContain('--navy-950:#050d1c');
    });

    it('has one accent: the slide icons are gold, the headline emphasis is the landing gold, nothing decorative is green', () => {
        expect(block).toMatch(/\.auth-slide \.as-ic \{ color: var\(--wf-gold-400\) !important; \}/);
        expect(block).toContain('.ab-head h2 em { font-style: normal; background: linear-gradient(135deg, #f1d98d, #d4af37);');
        expect(block).toMatch(/\.ab-foot svg \{[^}]*color: var\(--wf-gold-400\)/);
        expect(block).not.toMatch(/6fd49b/);
    });

    it('moves only through transform and opacity, and stands still for reduced motion', () => {
        for (const m of block.matchAll(/@keyframes\s+(\w+)\s*\{([^]*?)\}\s*\}?/g)) {
            expect(m[2], m[1]).not.toMatch(/\b(top|left|width|height|margin|padding|background)\s*:/);
        }
        expect(block).toContain('@media (prefers-reduced-motion: no-preference)');
        expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.auth-box \{ animation: none; \} \}/);
        expect(block).toContain('@media (prefers-reduced-transparency: reduce)');
    });

    it('shows the sign-in copy without an em-dash', () => {
        const from = APP.indexOf('<div id="authScreen">');
        const to = APP.indexOf('id="authLogin"');
        expect(APP.slice(from, to)).not.toContain('—');
        const forgot = APP.slice(APP.indexOf('id="authForgot"'), APP.indexOf('id="authForgot"') + 4000);
        expect(forgot).not.toContain('—');
    });

    it('does not add anything to the app page or its scripts (both are held to a size budget)', () => {
        expect(APP).toContain('<div id="authScreen">');
        expect(UI).not.toMatch(/<script/);
    });
});
