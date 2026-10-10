/* =============================================================================
 * test/design_system_test.js — the interface's foundations are asserted, not hoped for
 * -----------------------------------------------------------------------------
 * The visual redesign lives in three files (wf-tokens.css, wf-ui.css, wealthflow-shell.js) and
 * a handful of lines in index.html. What can go wrong there is quiet: a token present in the dark
 * theme and missing in the light one (text becomes invisible on one of them), a grey that stopped
 * clearing 4.5:1 after someone "softened" it, a legacy variable the bridge forgot (a screen keeps
 * its old colour), a stylesheet link that lost its place in the cascade, a logo that went back to a
 * network image. Each is a string in a file, so each is asserted where it lives.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const TOKENS = read('wf-tokens.css');
const SKIN = read('wf-ui.css');
const HTML = read('index.html');
const SHELL = read('wealthflow-shell.js');
const SW = read('sw.js');

/** The text of the first CSS block whose selector is exactly `selector`. */
function block(css, selector) {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`no block for ${selector}`);
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(css.indexOf('{', at) + 1, i); }
    }
    throw new Error(`unterminated block for ${selector}`);
}
/** { '--name': 'value' } for every custom property declared directly in a block. */
function vars(body) {
    const out = {};
    for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
    return out;
}
const DARK = vars(block(TOKENS, ':root'));
const LIGHT = vars(block(TOKENS, '[data-theme="light"]'));
const resolve = (theme, name) => {
    let v = theme[name] ?? DARK[name];
    for (let i = 0; i < 4 && typeof v === 'string' && v.startsWith('var('); i += 1) {
        const ref = /var\((--[a-z0-9-]+)/i.exec(v)[1];
        v = theme[ref] ?? DARK[ref];
    }
    return v;
};

const lum = (hex) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

describe('the tokens', () => {
    const THEMED = ['bg', 'surface', 'card', 'card-2', 'card-3', 'line', 'line-2', 'line-3', 'text', 'text-2', 'text-3',
        'accent', 'accent-ink', 'pos', 'neg', 'warn', 'info', 'violet', 'teal', 'field'];

    it('define every themed colour in BOTH themes, so no screen can go blank on one of them', () => {
        for (const t of THEMED) {
            expect(DARK[`--wf-${t}`], `dark --wf-${t}`).toBeTruthy();
            expect(LIGHT[`--wf-${t}`] ?? DARK[`--wf-${t}`], `light --wf-${t}`).toBeTruthy();
        }
        // The light block may only restate tokens the dark block declares (a typo there would be silent).
        for (const k of Object.keys(LIGHT)) expect(DARK[k], `${k} is declared in light but not in dark`).toBeTruthy();
    });

    it('keep text legible: every reading grey clears WCAG AA (4.5:1) on every surface it sits on', () => {
        for (const [name, theme] of [['dark', DARK], ['light', LIGHT]]) {
            for (const fg of ['text', 'text-2', 'text-3', 'accent', 'pos', 'neg', 'warn', 'info']) {
                for (const bg of ['bg', 'surface', 'card', 'card-2']) {
                    const f = resolve(theme, `--wf-${fg}`);
                    const b = resolve(theme, `--wf-${bg}`);
                    const r = ratio(f, b);
                    expect(r, `${name}: ${fg} (${f}) on ${bg} (${b}) is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
                }
            }
        }
    });

    it('put readable ink on the gold button, and give form fields an edge that is actually visible (3:1)', () => {
        for (const [name, theme] of [['dark', DARK], ['light', LIGHT]]) {
            expect(ratio(resolve(theme, '--wf-accent-ink'), resolve(theme, '--wf-accent-fill')), `${name}: ink on gold`).toBeGreaterThanOrEqual(4.5);
            expect(ratio(resolve(theme, '--wf-line-3'), resolve(theme, '--wf-field')), `${name}: field edge`).toBeGreaterThanOrEqual(3);
        }
    });

    it('self-host the typeface, and every file the stylesheet names is a real woff2', () => {
        const files = [...TOKENS.matchAll(/url\((\/assets\/fonts\/[a-z0-9.-]+\.woff2)\)/g)].map((m) => m[1]);
        expect(files.length).toBeGreaterThanOrEqual(3);
        for (const f of files) {
            const rel = f.replace(/^\//, '');
            expect(existsSync(new URL(`../${rel}`, import.meta.url)), rel).toBe(true);
            expect(readFileSync(new URL(`../${rel}`, import.meta.url)).subarray(0, 4).toString('latin1'), `${rel} magic`).toBe('wOF2');
        }
        expect(TOKENS).toMatch(/--wf-font:\s*'Geist'/);
        expect(TOKENS).toContain("'Noto Sans Sinhala'");
    });

    it('contain no selector that styles an element, so any surface can load them safely', () => {
        const body = TOKENS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@font-face\s*\{[^}]*\}/g, '');
        const selectors = [...body.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith('@media'));
        for (const s of selectors) expect(s, `selector "${s}"`).toMatch(/^(:root|\[data-theme="light"\]|:root\[data-theme-auto\]:not\(\[data-theme\]\))$/);
    });
});

describe('the legacy bridge', () => {
    const legacy = Object.keys(vars(block(HTML.slice(HTML.indexOf('<style>')), ':root'))).filter((k) => !k.startsWith('--wf-'));
    const bridge = vars(block(SKIN, ':root'));

    it('re-points every variable index.html defines, so no screen keeps the old palette', () => {
        expect(legacy.length).toBeGreaterThan(20);
        // --shadow-like geometry that the skin does not restyle is allowed to be left alone.
        const missing = legacy.filter((k) => !(k in bridge));
        expect(missing, `legacy variables not re-pointed: ${missing.join(', ')}`).toEqual([]);
    });

    it('points every bridged colour at a token that exists', () => {
        for (const [k, v] of Object.entries(bridge)) {
            const ref = /var\((--wf-[a-z0-9-]+)\)/.exec(v);
            if (ref) expect(DARK[ref[1]], `${k} -> ${ref[1]}`).toBeTruthy();
        }
    });
});

describe('the skin', () => {
    it('uses tokens, not literals: the only hex colours are the brand tile and the sign-in panel', () => {
        const css = SKIN.replace(/\/\*[\s\S]*?\*\//g, '');
        const hexes = new Set([...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()));
        // Brand art (the logo tile and the dark sign-in panel are dark in BOTH themes on purpose) and
        // the ink that sits on a solid success/warning button.
        const allowed = new Set(['#1b2236', '#0c101b', '#0f1522', '#0a0d13', '#eef1f7', '#fff', '#ffffff', '#aab3c5', '#98a2b6', '#7e8aa1',
            '#efd58a', '#d4a94a', '#6fd49b', '#04150c', '#1f1303',
            '#000' /* an opaque mask stop, not a visible colour */]);
        const stray = [...hexes].filter((h) => !allowed.has(h));
        expect(stray, `hard-coded colours outside the allow-list: ${stray.join(', ')}`).toEqual([]);
    });

    it('keeps a visible focus ring and honours reduced motion', () => {
        expect(SKIN).toMatch(/:focus-visible\s*\{[^}]*box-shadow:\s*var\(--wf-focus\)/);
        expect(SKIN).toMatch(/prefers-reduced-motion:\s*reduce/);
    });

    it('sizes touch targets for a thumb on coarse pointers', () => {
        expect(SKIN).toMatch(/pointer:\s*coarse[\s\S]{0,200}min-height:\s*44px/);
        expect(SKIN).toMatch(/\.wf-tab\s*\{[^}]*min-height:\s*50px/);
    });

    it('does not move the app\'s stacking order (modal 200, toast 600 are index.html\'s own)', () => {
        expect(SKIN).not.toMatch(/\.mo\s*\{[^}]*z-index/);
        expect(SKIN).not.toMatch(/#notifs\s*\{[^}]*z-index/);
        expect(DARK['--wf-z-modal']).toBe('200');
        expect(DARK['--wf-z-toast']).toBe('600');
    });
});

describe('the wiring in index.html', () => {
    it('loads tokens, then the skin, after the page\'s own stylesheet and before the body', () => {
        const styleEnd = HTML.indexOf('</style>', HTML.indexOf('<style>'));
        const t = HTML.indexOf('<link rel="stylesheet" href="/wf-tokens.css">');
        const u = HTML.indexOf('<link rel="stylesheet" href="/wf-ui.css">');
        expect(styleEnd).toBeGreaterThan(0);
        expect(t).toBeGreaterThan(styleEnd);
        expect(u).toBeGreaterThan(t);
        expect(u).toBeLessThan(HTML.indexOf('</head>'));
    });

    it('draws the logo from one inline sprite instead of a network image, everywhere it shows', () => {
        expect(HTML).toMatch(/<symbol id="wf-mark"/);
        expect((HTML.match(/<use href="#wf-mark"\/>/g) || []).length).toBeGreaterThanOrEqual(4);
        // splash, both sign-in cards and the sidebar used to be a Cloudinary <img>
        for (const marker of ['class="sp-logo"', 'class="auth-logo"', 'class="sb-icon"']) {
            const at = HTML.indexOf(marker);
            expect(at, marker).toBeGreaterThan(0);
            expect(HTML.slice(at, at + 300), `${marker} still loads a network image`).not.toMatch(/<img[^>]+cloudinary/);
        }
    });

    it('loads the shell as a deferred module and describes the app, not a loan statement', () => {
        expect(HTML).toContain('<script src="wealthflow-shell.js" defer></script>');
        expect(HTML).not.toMatch(/og:title" content="WealthFlow — Loan Statement"/);
        expect(HTML).toContain('<link rel="preload" href="/assets/fonts/geist-latin.woff2" as="font" type="font/woff2" crossorigin>');
    });

    it('keeps the service worker able to serve the design system offline', () => {
        expect(SW).toMatch(/wf-\(tokens\|ui\)\\\.css/);
        expect(SW).toMatch(/assets\\\/fonts\\\/geist-/);
    });
});

describe('the shell module', () => {
    it('builds its screen list from the sidebar and navigates through the app\'s own showPage', () => {
        expect(SHELL).toContain("doc.querySelector('.sb-nav')");
        expect(SHELL).toMatch(/showPage\\\('\(\[\^'\]\+\)'/);
        expect(SHELL).toContain('window.showPage(id');
    });

    it('is presentation only: it never writes app data', () => {
        expect(SHELL).not.toMatch(/\bDB\.set\b|\bDB\.save\b|appData\s*\[[^\]]+\]\s*=/);
        expect(SHELL).not.toMatch(/\bfetch\s*\(/);
    });

    it('escapes what it takes from the page or the user\'s records before it builds markup', () => {
        // Names of loans, lenders and people reach the palette; one with a quote or a tag in it must stay text.
        // Every label/hint/group/badge that goes into a template goes through esc(); a raw `+ it.label` would not.
        expect(SHELL).not.toMatch(/['"]\s*\+\s*(it|p|g|t)\.(label|hint|group|badge|name|title)\s*\+\s*['"]\s*<|>['"]\s*\+\s*(it|p|g|t)\.(label|hint|group|badge|name|title)\b/);
        expect(SHELL).toMatch(/function esc\(/);
        expect((SHELL.match(/esc\(/g) || []).length).toBeGreaterThanOrEqual(10);
    });

    it('opens the palette from Ctrl/Cmd+K and closes every layer with Escape', () => {
        expect(SHELL).toMatch(/ctrlKey \|\| e\.metaKey\) && k === 'k'/);
        expect(SHELL).toContain("e.key === 'Escape'");
    });
});
