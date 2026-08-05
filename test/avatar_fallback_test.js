/* =============================================================================
 * test/avatar_fallback_test.js  —  issue #74
 * -----------------------------------------------------------------------------
 * The whole of #74 is: "Please fix the issue. Please find the image and fix
 * now." — filed from the SETTINGS page, with a screenshot that lives in the
 * Firestore feedback document and is not reachable from here.
 *
 * So this is an inference, and it is labelled as one. What is NOT an inference
 * is the defect it targets: every profile avatar in the app renders
 * `currentUser.photoURL`, a Google CDN URL (lh3.googleusercontent.com). Those
 * rotate, expire, get blocked on some networks, and fail outright on a cold
 * offline start of an installed PWA. All three <img> tags using one had no
 * error handling at all, while eleven other images in index.html do — so when
 * the fetch failed the browser painted its broken-image icon where the owner's
 * face should be, on the exact screen #74 was filed from.
 *
 * Each tag already had a good no-photo fallback for an EMPTY photoURL. This
 * routes the FAILED-TO-LOAD case to the same place.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Single-line <img> tags only — see test/img_alt_test.js for why `[^>\n]`. */
const imgTags = (src) => src.match(/<img\b[^>\n]*>/gi) || [];
const avatarTags = imgTags(HTML).filter((t) => /\$\{userPhoto\}|\$\{photoURL\}/.test(t));

/** The helper, lifted out of index.html and run for real. */
function loadHelper() {
    const i = HTML.indexOf('function _wfAvatarFail(img)');
    expect(i, 'the avatar fallback helper is missing').toBeGreaterThan(-1);
    const end = HTML.indexOf('\n        }', i);
    const src = HTML.slice(i, end + 10);
    const made = [];
    const doc = {
        createElement: () => {
            const d = { textContent: '', className: '', style: { cssText: '' } };
            made.push(d);
            return d;
        },
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function('document', src + '\nreturn _wfAvatarFail;')(doc);
    return { fn, made };
}

const fakeImg = (attrs = {}) => {
    const el = {
        dataset: {}, style: { width: '' },
        getAttribute: (k) => (k in attrs ? attrs[k] : null),
        replaced: null,
        replaceWith(n) { this.replaced = n; },
    };
    return el;
};

describe('every avatar survives its photo failing to load', () => {
    it('there are avatars to protect (guards a vacuous pass)', () => {
        expect(avatarTags.length).toBe(3);
    });

    it('all three route a load failure to the fallback', () => {
        const unguarded = avatarTags.filter((t) => !/onerror\s*=\s*"_wfAvatarFail\(this\)"/.test(t));
        expect(unguarded, `avatar(s) with no onerror:\n${unguarded.join('\n')}`).toEqual([]);
    });

    it('the settings avatar falls back to the same placeholder its empty-photo branch uses', () => {
        const tag = avatarTags.find((t) => /\$\{userPhoto\}/.test(t));
        expect(tag).toMatch(/data-fallback="👤"/);
    });

    it('the sidebar avatars fall back to the initial, styled like the real one', () => {
        const side = avatarTags.filter((t) => /\$\{photoURL\}/.test(t));
        expect(side).toHaveLength(2);
        for (const t of side) {
            expect(t).toMatch(/data-fallback="\$\{initial\}"/);
            expect(t).toMatch(/data-fallback-class="sb-user-initial"/);
        }
    });
});

describe('the fallback helper itself', () => {
    it('replaces the broken image with the fallback text', () => {
        const { fn } = loadHelper();
        const img = fakeImg({ 'data-fallback': 'S' });
        fn(img);
        expect(img.replaced).toBeTruthy();
        expect(img.replaced.textContent).toBe('S');
    });

    it('uses textContent, so a display name can never inject markup', () => {
        // The initial is derived from the Google display name. Written as HTML
        // it would be an injection sink; written as text it is inert.
        const { fn } = loadHelper();
        const img = fakeImg({ 'data-fallback': '<img src=x onerror=alert(1)>' });
        fn(img);
        expect(img.replaced.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(img.replaced.innerHTML).toBeUndefined();
    });

    it('defaults to the person glyph when no fallback is given', () => {
        const { fn } = loadHelper();
        const img = fakeImg();
        fn(img);
        expect(img.replaced.textContent).toBe('👤');
    });

    it('applies the sidebar class when asked, instead of inline sizing', () => {
        const { fn } = loadHelper();
        const img = fakeImg({ 'data-fallback': 'S', 'data-fallback-class': 'sb-user-initial' });
        fn(img);
        expect(img.replaced.className).toBe('sb-user-initial');
        expect(img.replaced.style.cssText).toBe('');
    });

    it('runs once — a fallback that re-enters would loop', () => {
        const { fn } = loadHelper();
        const img = fakeImg({ 'data-fallback': 'S' });
        fn(img);
        const first = img.replaced;
        fn(img);
        expect(img.replaced).toBe(first);
    });

    it('never throws, whatever it is handed', () => {
        // A fallback that throws is worse than the broken icon it replaces.
        const { fn } = loadHelper();
        expect(() => fn(null)).not.toThrow();
        expect(() => fn(undefined)).not.toThrow();
        expect(() => fn({})).not.toThrow();
    });
});
