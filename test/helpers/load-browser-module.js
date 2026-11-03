/* test/helpers/load-browser-module.js
 *
 * Run one of this repository's browser modules (the `wealthflow-*.js` IIFEs, which have no
 * `export`) against a REAL DOM, so a test can assert what a person would actually see.
 *
 *   import { loadBrowserModule } from './helpers/load-browser-module.js';
 *   const { window, document } = loadBrowserModule('wealthflow-update-system.js', {
 *       html: '<div id="wfUpdateCard"></div>',
 *   });
 *   window.wfUpdate.refresh();
 *   expect(document.getElementById('wfUpdateCard').textContent).toContain('Current version');
 *
 * WHY THIS FILE EXISTS
 * The autonomous fix agent writes one proving test per fix. It used to be told "there is no DOM,
 * hand-build a fake window" — but `linkedom` (a real DOM) is a dependency of this repository, and
 * the hand-built fakes for a 111 KB module that calls `document.getElementById(...).innerHTML = ...`
 * were what its tests kept breaking on, so a correct change was thrown away at the proof stage.
 * One shared, tested loader removes that whole class of failure for everyone who writes a test.
 *
 * Each call builds a NEW window, so no state leaks from one test to the next (an ESM `import`
 * would be cached and run the module only once).
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

function memoryStorage(seed = {}) {
    const store = new Map(Object.entries(seed).map(([k, v]) => [k, String(v)]));
    return {
        store,
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear(),
        key: (i) => Array.from(store.keys())[i] ?? null,
        get length() { return store.size; },
    };
}

/**
 * @param {string} file   module file name, relative to the repository root
 * @param {object} [opts]
 * @param {string} [opts.html]       markup placed inside <body> before the module runs
 * @param {Function} [opts.fetchImpl] fake `fetch`; the default rejects (offline)
 * @param {object} [opts.localStorage] initial localStorage entries
 * @param {object} [opts.globals]     extra globals (for example `{ firebase: null, currentUser: {...} }`)
 * @param {string} [opts.url]         page URL (default https://wf.app/)
 * @param {boolean} [opts.logs]       keep console output (default: silent)
 * @returns {{ window: object, document: object, localStorage: object, sessionStorage: object, sources: string[] }}
 */
export function loadBrowserModule(file, opts = {}) {
    const {
        html = '', fetchImpl = null, localStorage: seed = {}, globals = {},
        url = 'https://wf.app/', logs = false,
    } = opts;
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const dom = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
    const { document } = dom;

    const events = new EventTarget();
    const quiet = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
    const parsed = new URL(url);
    const localStorage = memoryStorage(seed);
    const sessionStorage = memoryStorage();

    const context = {
        document,
        localStorage, sessionStorage,
        navigator: { userAgent: 'vitest', language: 'en', onLine: true, standalone: false, serviceWorker: undefined, clipboard: { writeText: async () => {} } },
        screen: { width: 390, height: 844 },
        innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
        location: { href: parsed.href, origin: parsed.origin, pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, reload() {}, assign() {}, replace() {} },
        history: { pushState() {}, replaceState() {} },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
        fetch: fetchImpl || (async () => { throw new Error('offline in test'); }),
        console: logs ? console : quiet,
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
        cancelAnimationFrame: (id) => clearTimeout(id),
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        Event: dom.Event || Event, CustomEvent: dom.CustomEvent || CustomEvent,
        URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, Promise,
        Blob, atob, btoa, structuredClone,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        ...globals,
    };
    context.window = context;
    context.self = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(src, context, { filename: file });
    return { window: context, document, localStorage, sessionStorage, sources: [file] };
}
