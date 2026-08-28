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
    /* Brace-counted to the function's own close. The old version cut at the
     * first `\n        }`, which is a guess about indentation — adding a
     * comment or a nested block to the helper would silently truncate the
     * source under test and every assertion below would then be describing a
     * fragment. Same failure the wiring suite's extractor had. */
    let depth = 0;
    let end = HTML.indexOf('{', i);
    for (let j = end; j < HTML.length; j += 1) {
        if (HTML[j] === '{') depth += 1;
        else if (HTML[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
    }
    const src = HTML.slice(i, end);
    const made = [];
    const appended = [];
    const doc = {
        createElement: () => {
            const d = {
                textContent: '', className: '', style: { cssText: '' },
                appendChild(n) { appended.push(n); return n; },
            };
            made.push(d);
            return d;
        },
    };
    /* The icon set, modelled only as far as the helper uses it. `has` answers
     * from a fixed list, and WFIconNode returns a marker object rather than
     * markup — so a test can tell "an icon was appended" from "text was
     * written" without either becoming a string comparison. */
    const win = {
        WFIcon: Object.assign(() => '<svg/>', { has: (n) => ['user', 'lock', 'check', 'cloud'].includes(n) }),
        WFIconNode: (n) => ({ __icon: n }),
    };
    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'window', src + '\nreturn _wfAvatarFail;')(doc, win);
    return { fn, made, appended };
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
        /* `user` names an ICON now, not a glyph — and the empty-photo branch
         * beside it renders the same one, which is what this test is really
         * about: the two branches must not show different things. */
        expect(tag).toMatch(/data-fallback="user"/);
        const empty = HTML.slice(HTML.indexOf(tag), HTML.indexOf(tag) + 900);
        expect(empty, 'the empty-photo branch no longer draws the same placeholder').toContain("_ic('user')");
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

    it('defaults to the person ICON when no fallback is given', () => {
        /* Was the emoji. The icon set exists so a face on screen is not a
         * system font's idea of one. */
        const { fn, appended } = loadHelper();
        const img = fakeImg();
        fn(img);
        expect(appended.length, 'no icon node was appended').toBe(1);
        expect(appended[0].__icon).toBe('user');
        expect(img.replaced.textContent).toBe('');
    });

    it('an icon is APPENDED, never assigned as markup', () => {
        /* The invariant below, stated from the other side: the only path that
         * produces an element goes through the fixed icon table. */
        const { fn, appended } = loadHelper();
        fn(fakeImg({ 'data-fallback': 'lock' }));
        expect(appended[0].__icon).toBe('lock');
        expect(fakeImg().innerHTML).toBeUndefined();
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
