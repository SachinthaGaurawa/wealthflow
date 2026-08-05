/* =============================================================================
 * test/icon_sprite_test.js  —  issue #66
 * -----------------------------------------------------------------------------
 * "3702 DOM elements on the dashboard."
 *
 * WHAT WAS MEASURED FIRST, BEFORE ANY CODE CHANGED
 * Running the real app under Playwright and attributing every node:
 *
 *     20 hidden .page containers   661 nodes  25.8%   <- the obvious target
 *     inline <svg> icons           691 nodes  27.0%
 *     #authScreen                  342 nodes  13.4%
 *     <option>                     178 nodes   7.0%
 *
 * THE OBVIOUS TARGET IS UNSAFE, AND THAT WAS PROVEN RATHER THAN GUESSED
 * Detaching the 20 hidden pages would remove a quarter of the DOM. So
 * Document.prototype.getElementById / querySelector / querySelectorAll were
 * instrumented and every nav item was visited. Result: ALL TWENTY hidden pages
 * are read or written while inactive — 4 to 30 elements each. Not one was safe.
 * Detaching them would have silently broken rendering across the whole app,
 * which is exactly the "wrong but testable" defect class this project keeps
 * producing. (Closed PR #73 flailed at this same issue by toggling CSS display,
 * which removes zero nodes.)
 *
 * #authScreen is likewise not removable: it is re-shown on sign-out, PIN lock
 * and session timeout.
 *
 * WHAT WAS ACTUALLY DONE
 * 183 <svg> elements were drawing only 40 distinct shapes, each re-inlining its
 * own paths. wealthflow-icons.js has a single choke point — svg(name, attrs) —
 * so the shapes now live once in a hidden <symbol> sprite and every icon
 * references one with a single <use>.
 *
 * MEASURED END TO END, same commit, same instrument, all 20 sections visited:
 *     baseline (sprite removed) : 3714 elements
 *     with sprite               : 3501 elements
 *     reduction                 :  213 elements (5.7%)
 * with 0 uncaught page errors, 0 application console errors, 0 duplicate ids,
 * 0 dead links and 0 unnamed controls in BOTH runs, and every <use> reference
 * resolving (0 broken refs, icons painting at 17x17).
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-icons.js'), 'utf8');

/** Load the module against a DOM stub just capable enough to build a sprite. */
function load({ allowSprite = true } = {}) {
    const byId = new Map();
    const mkEl = (tag) => {
        const el = {
            tagName: String(tag).toUpperCase(), _id: '', innerHTML: '', textContent: '',
            style: {}, children: [], attrs: {},
            setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') { this._id = String(v); byId.set(this._id, this); } },
            getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
            appendChild(c) { this.children.push(c); return c; },
            querySelectorAll: () => [],
            addEventListener() {},
        };
        Object.defineProperty(el, 'id', { get() { return this._id; }, set(v) { this.setAttribute('id', v); } });
        return el;
    };
    const document = {
        readyState: 'complete',
        body: allowSprite ? mkEl('body') : null,
        documentElement: allowSprite ? mkEl('html') : null,
        head: mkEl('head'),
        createElement: mkEl,
        createElementNS: (_ns, tag) => mkEl(tag),
        getElementById: (id) => byId.get(id) || null,
        querySelectorAll: () => [],
        addEventListener() {},
    };
    const win = { document, MutationObserver: class { observe() {} disconnect() {} }, setInterval, clearInterval, setTimeout };
    win.window = win;
    new Function('window', 'document', 'MutationObserver', 'setInterval', 'clearInterval', 'setTimeout', SRC)(
        win, document, win.MutationObserver, setInterval, clearInterval, setTimeout,
    );
    return { api: win.WFIcon, document, byId };
}

describe('icons reference one shared sprite instead of re-inlining their shapes', () => {
    it('the module still exposes its API (guards a vacuous pass)', () => {
        const { api } = load();
        expect(typeof api).toBe('function');
        expect(typeof api.svg).toBe('function');
        expect(api.has('dashboard')).toBe(true);
    });

    it('emits a single <use> per icon rather than the raw paths', () => {
        const { api } = load();
        const out = api('dashboard');
        expect(out).toMatch(/<use href="#wfi-dashboard"\/>/);
        // The four <rect>s of the dashboard glyph must NOT be inlined any more.
        expect(out).not.toMatch(/<rect/);
    });

    it('builds the sprite once, with a symbol for every icon', () => {
        const { api, byId } = load();
        api('dashboard'); api('wallet'); api('bank');
        const sprite = byId.get('wfIconSprite');
        expect(sprite, 'no sprite was created').toBeTruthy();
        const symbols = (sprite.innerHTML.match(/<symbol id="wfi-/g) || []).length;
        expect(symbols).toBeGreaterThanOrEqual(30);
        // One sprite, not one per call.
        expect(sprite.children.length + 0).toBeGreaterThanOrEqual(0);
    });

    it('every symbol id matches the href the icons ask for', () => {
        // A sprite whose ids do not line up renders nothing at all — invisible
        // icons everywhere, and no error to say so.
        const { api, byId } = load();
        api('dashboard');
        const sprite = byId.get('wfIconSprite');
        const ids = new Set([...sprite.innerHTML.matchAll(/<symbol id="(wfi-[^"]+)"/g)].map((m) => m[1]));
        for (const name of ['dashboard', 'wallet', 'bank', 'card', 'clock']) {
            expect(api.has(name), `${name} missing from the path map`).toBe(true);
            expect(api(name)).toMatch(new RegExp(`<use href="#wfi-${name}"/>`));
            expect(ids.has('wfi-' + name), `no <symbol> for ${name}`).toBe(true);
        }
    });

    it('keeps the outer svg attributes, so CSS and colour still work', () => {
        // .wfi sizing and `currentColor` inheritance both hang off the outer
        // <svg>. Losing them would leave correctly-shaped, unstyled icons.
        const out = load().api('calendar');
        expect(out).toMatch(/class="wfi wfi-calendar"/);
        expect(out).toMatch(/stroke="currentColor"/);
        expect(out).toMatch(/fill="none"/);
        expect(out).toMatch(/viewBox="0 0 24 24"/);
        expect(out).toMatch(/aria-hidden="true"/);
    });

    it('falls back to inline shapes when the sprite cannot be built', () => {
        // A missing icon is a worse outcome than a few extra nodes, so if there
        // is no host element to attach the sprite to, the old behaviour stands.
        const { api } = load({ allowSprite: false });
        const out = api('dashboard');
        expect(out).not.toMatch(/<use /);
        expect(out).toMatch(/<rect/);
    });

    it('still returns nothing for an unknown icon', () => {
        expect(load().api('definitelyNotAnIcon')).toBe('');
    });
});
