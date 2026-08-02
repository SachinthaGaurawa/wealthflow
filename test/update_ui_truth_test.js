/* =============================================================================
 * test/update_ui_truth_test.js
 * -----------------------------------------------------------------------------
 * WHAT THE OWNER SAW
 *
 * A device executing v7.69.18 displayed a sheet headed "Welcome to v7.69.15",
 * describing press-and-hold undo of an investment month and a Drive connection
 * that stays on. Neither part was true, and the two parts were not even about
 * the same release:
 *
 *   · the version came from localStorage['wf_installed_version'], which only
 *     ever advanced when the user completed the in-app update flow — so a hard
 *     refresh, which is how new code actually arrives, left it frozen;
 *   · the text came from BUILTIN_NOTES['7.40.0'], dated 2026-07-01, reached
 *     through a fallback whose comment read "never show an empty What's New".
 *
 * That fallback is the defect in one line: the UI would rather fabricate than
 * admit it does not know. An empty sheet is a missing note. A filled one is a
 * false claim about what the owner is running.
 *
 * These tests execute the real module against a stubbed DOM/localStorage rather
 * than reading it as text, because "the source no longer contains BUILTIN_NOTES"
 * and "the sheet can no longer show another release's notes" are different
 * claims and only the second is what the owner experiences.
 * ===========================================================================*/

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');

/**
 * Load the module into a fresh fake window.
 *
 * Evaluated per-test with `new Function` rather than imported: an ESM import is
 * cached, so the IIFE would run once and every later test would assert against
 * the first test's localStorage. That exact mistake cost a full debugging cycle
 * earlier in this project.
 */
function loadModule({ stored = null, manifest = null } = {}) {
    const store = new Map();
    if (stored !== null) store.set('wf_installed_version', stored);

    const el = () => ({
        style: {}, classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
        addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
        innerHTML: '', textContent: '', value: '', checked: false, dataset: {},
    });
    const win = {
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
            key: (i) => Array.from(store.keys())[i] ?? null,
            get length() { return store.size; },
        },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        addEventListener() {}, removeEventListener() {},
        location: { origin: 'https://wf.app', reload() {} },
        navigator: { userAgent: 'test', language: 'en', onLine: true },
        screen: { width: 390, height: 844 },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        fetch: async () => { throw new Error('offline in test'); },
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (f) => f(),
    };
    win.window = win;
    const doc = {
        readyState: 'complete', body: el(), documentElement: el(),
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => el(), addEventListener() {}, head: el(),
    };

    new Function('window', 'document', 'localStorage', 'sessionStorage',
        'navigator', 'screen', 'location', 'fetch', 'requestAnimationFrame',
        SRC)(
        win, doc, win.localStorage, win.sessionStorage,
        win.navigator, win.screen, win.location, win.fetch, win.requestAnimationFrame,
    );

    const api = win.wfUpdate;
    return { api, win, store };
}

describe('the hardcoded release history is gone', () => {
    it('BUILTIN_NOTES is no longer a live binding', () => {
        // Comments may still mention it — that documentation is why it left.
        const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(code).not.toMatch(/const BUILTIN_NOTES/);
        expect(code).not.toMatch(/BUILTIN_NOTES\[/);
    });

    it('took ~21 KB of duplicated history out of the bundle', () => {
        const bytes = fs.statSync(path.join(ROOT, 'wealthflow-update-system.js')).size;
        expect(bytes).toBeLessThan(105_000);
    });
});

describe('the notes fallback that fabricated history is gone', () => {
    it('no longer reaches for "the newest notes we have"', () => {
        const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        // The exact shape of the old fallback: build a merged map, sort keys
        // descending, return the newest regardless of which version was asked for.
        expect(code).not.toMatch(/Object\.assign\(\{\}, BUILTIN_NOTES/);
        expect(code).not.toMatch(/return keys\.length \? all\[keys\[0\]\] : null/);
    });

    it('_rawNotesFor returns notes for the asked-for version, or null', () => {
        const i = SRC.indexOf('function _rawNotesFor');
        expect(i, '_rawNotesFor anchor not found — retarget this test').toBeGreaterThan(-1);
        const fn = SRC.slice(i, SRC.indexOf('\n    }', i));
        expect(fn).toMatch(/_manifest\.notes\[v\]/);
        expect(fn).toMatch(/return null;/);
        // Must not consult any other version.
        expect(fn).not.toMatch(/keys\[0\]/);
    });
});

describe('the installed version reports the code that is running', () => {
    it('reconciles a stale localStorage forward to CURRENT_VERSION', () => {
        // The owner's exact situation: device remembered 7.69.15, ran 7.69.18.
        const { api } = loadModule({ stored: '7.69.15' });
        expect(api, 'wfUpdate did not initialise').toBeTruthy();
        const shipped = /const CURRENT_VERSION\s*=\s*'([\d.]+)'/.exec(SRC)[1];
        expect(api._installedVersion()).toBe(shipped);
    });

    it('writes the reconciled value back, so it stops drifting', () => {
        const { api, store } = loadModule({ stored: '7.69.15' });
        api._installedVersion();
        const shipped = /const CURRENT_VERSION\s*=\s*'([\d.]+)'/.exec(SRC)[1];
        expect(store.get('wf_installed_version')).toBe(shipped);
    });

    it('reports CURRENT_VERSION on a device that has never stored one', () => {
        const { api } = loadModule({ stored: null });
        const shipped = /const CURRENT_VERSION\s*=\s*'([\d.]+)'/.exec(SRC)[1];
        expect(api._installedVersion()).toBe(shipped);
    });

    it('does NOT rewrite a stored value that is ahead of the running code', () => {
        // A device served older code than it once ran — a rollback or a stale
        // cache. Silently lowering the record would erase the only evidence.
        const { api, store } = loadModule({ stored: '9.9.9' });
        expect(api._installedVersion()).toBe('9.9.9');
        expect(store.get('wf_installed_version')).toBe('9.9.9');
    });
});

describe('version.json now carries real notes for v7.69.18', () => {
    const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
    const n = vj.notes['7.69.18'];

    it('is the structured shape, not the old boilerplate string', () => {
        expect(typeof n).toBe('object');
        expect(JSON.stringify(n)).not.toMatch(/Improvements and fixes in this release/);
    });

    it('names the change the owner would actually notice', () => {
        const user = n.sections.find((s) => /what changed for you/i.test(s.title));
        expect(user).toBeTruthy();
        expect(user.items.join(' ')).toMatch(/update system tell the truth/i);
    });

    it('separates the four pipeline PRs from it', () => {
        const hood = n.sections.find((s) => /under the hood/i.test(s.title));
        expect(hood.items).toHaveLength(4);
    });

    it('carries no markdown — the renderer escapes its input', () => {
        expect(JSON.stringify(n)).not.toMatch(/\*\*/);
    });
});
