/* =============================================================================
 * test/update_honesty_test.js
 * -----------------------------------------------------------------------------
 * The owner's report, in his words: "බොරුවට පේන්න version එක update වෙන එක
 * විතරයි. Backend එකක් update වෙන්නෙ නෑ." — only the version appears to update;
 * the backend does not.
 *
 * Investigation found the releases themselves were genuine (v7.69.16..v7.69.17
 * carries 21 real commits). Three things around them were not. Each test below
 * pins one of them, and each FAILS against main as it stood at v7.69.17:
 *
 *   1. substantive.cjs counted CI/test/tooling commits as a user-facing update,
 *      so a day spent entirely on the pipeline still announced "Update
 *      available" for a build byte-identical from the user's side.
 *   2. sw.js had no fetch handler, so CACHE_NAME — rewritten by the release bot
 *      on every single release — named a cache nothing read and nothing wrote.
 *   3. the update progress bar advanced over hardcoded _sleep() calls, and the
 *      step labelled "Downloading new version files" downloaded no version file.
 *
 * These are behavioural assertions where they can be, and source assertions
 * where the behaviour lives in a service worker this harness cannot execute.
 * Source assertions are anchored on stable strings and carry a guard, because
 * an anchor that silently stops matching is a test that silently stops testing.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyDiff, isInfraFile } from '../autonomy/substantive.cjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Build a minimal unified diff touching exactly the given files. */
function diffFor(files) {
    return files.map((f) => [
        `diff --git a/${f} b/${f}`,
        `--- a/${f}`,
        `+++ b/${f}`,
        '@@ -1,1 +1,1 @@',
        '-const before = 1;',
        '+const after = 2;',
    ].join('\n')).join('\n');
}

describe('1. a version bump must mean "the app you run changed"', () => {
    it('does NOT announce an update for a day of pure pipeline work', () => {
        // Exactly the shape of this session's own quieter days.
        const r = classifyDiff(diffFor([
            '.github/workflows/auto-release.yml',
            'test/autonomy_test.js',
            'autonomy/perf-budget.mjs',
            'policy/release.rego',
        ]));
        expect(r.substantive).toBe(false);
        expect(r.infra.length).toBe(4);
        // The refusal has to explain itself, or the owner is left wondering why a
        // busy day produced nothing.
        expect(r.reason).toMatch(/pipeline|tooling/i);
    });

    it('DOES announce an update when a shipped module changes', () => {
        const r = classifyDiff(diffFor(['wealthflow-insights.js']));
        expect(r.substantive).toBe(true);
        expect(r.substantiveFiles).toContain('wealthflow-insights.js');
    });

    it('announces when app code changes even alongside pipeline churn', () => {
        // The mixed case is the one that matters: infra must never MASK a real change.
        const r = classifyDiff(diffFor([
            '.github/workflows/fuzz-gate.yml',
            'test/foo_test.js',
            'index.html',
        ]));
        expect(r.substantive).toBe(true);
        expect(r.substantiveFiles).toEqual(['index.html']);
    });

    it('treats api/ as user-facing — a serverless change is a real change', () => {
        const r = classifyDiff(diffFor(['api/router.js']));
        expect(r.substantive).toBe(true);
    });

    it('fails toward announcing when a file is unrecognised', () => {
        // Stale code in a financial app is worse than one extra prompt, so an
        // unknown path must NOT be silently classified as infrastructure.
        expect(isInfraFile('some-new-thing.js')).toBe(false);
        expect(classifyDiff(diffFor(['some-new-thing.js'])).substantive).toBe(true);
    });

    it('classifies the pipeline files by path, not by guesswork', () => {
        for (const f of ['.github/workflows/x.yml', 'test/a_test.js', 'autonomy/x.mjs',
                         'policy/p.rego', 'vitest.config.js', 'release.cjs',
                         'consensus-review.mjs', 'foo.test.js']) {
            expect(isInfraFile(f), `${f} should be infrastructure`).toBe(true);
        }
        for (const f of ['index.html', 'sw.js', 'wealthflow-review.js', 'api/ai.js']) {
            expect(isInfraFile(f), `${f} should NOT be infrastructure`).toBe(false);
        }
    });
});

describe('2. CACHE_NAME must name a cache that exists', () => {
    const sw = read('sw.js');

    it('has a fetch handler at all', () => {
        // The whole defect in one assertion: eight releases renamed an empty room.
        expect(sw).toMatch(/self\.addEventListener\(\s*['"]fetch['"]/);
    });

    it('actually writes to the cache CACHE_NAME identifies', () => {
        expect(sw).toMatch(/caches\.open\(CACHE_NAME\)/);
        expect(sw).toMatch(/cache\.put\(/);
        expect(sw).toMatch(/cache\.match\(/);
    });

    it('goes to the network before the cache for executable code', () => {
        // Guard: if this anchor ever stops matching, the assertions below are
        // vacuous, so assert the anchor itself is present.
        const i = sw.indexOf("self.addEventListener('fetch'");
        expect(i, 'fetch handler anchor not found — retarget this test').toBeGreaterThan(-1);
        const body = sw.slice(i);
        // The anchor is `fetch(event.request)` rather than `await fetch(...)`: the
        // call is now inside a Promise.race that bounds how long the shell waits
        // before falling back to cache, so the `await` sits on the race. The claim
        // asserted here is unchanged — the network call still precedes the cache
        // read — only the shape it is spelled in.
        const netAt = body.indexOf('fetch(event.request)');
        const cacheAt = body.indexOf('cache.match(event.request)');
        expect(netAt, 'the app shell no longer fetches at all').toBeGreaterThan(-1);
        expect(cacheAt).toBeGreaterThan(-1);
        // Network-first: the fetch must appear before the cache read.
        expect(netAt).toBeLessThan(cacheAt);
    });

    it('never passes a second argument to the app-shell fetch', () => {
        /* THE TRAP THIS PINS, which sw.js documents in its own comment and which
         * adding a deadline could easily have walked into:
         *
         * supplying ANY non-empty init for a request whose mode is 'navigate'
         * re-derives the request and downgrades that mode. `{ cache: 'no-store' }`
         * does it, and so does `{ signal }`. The cost is a white screen on the
         * app's own entry point — the one request that must never fail.
         *
         * So the shell's deadline is a Promise.race, which cancels nothing but
         * stops US waiting, rather than an AbortSignal. */
        /* Comments stripped first. sw.js EXPLAINS the trap by quoting the bad form
         * — `fetch(event.request, { cache: 'no-store' })` — so matching the raw
         * text finds the explanation rather than the code and fails against a
         * correct file. That is the same defect this whole suite exists to catch,
         * and it caught me writing this very assertion. */
        const code = sw.replace(/\/\*[\s\S]*?\*\//g, ' ')
            .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
        const i = code.indexOf("self.addEventListener('fetch'");
        expect(i, 'fetch handler anchor not found after stripping comments').toBeGreaterThan(-1);
        const body = code.slice(i);
        const m = body.match(/fetch\(event\.request[^)]*\)/);
        expect(m, 'the app-shell fetch is gone — retarget this test').toBeTruthy();
        expect(m[0], 'a second argument was added to the navigate fetch, which downgrades '
            + 'request.mode and can white-screen the app shell')
            .toBe('fetch(event.request)');
    });

    it('bounds how long the shell waits, and falls back to cache', () => {
        // Without a bound, a connection that opens and then stalls left the app
        // shell hanging forever with no recovery path.
        expect(sw, 'the app-shell fetch is unbounded again').toMatch(/Promise\.race\(\[\s*fetch\(event\.request\)/);
        expect(sw).toMatch(/NET_TIMEOUT_MS/);
        const ms = Number((sw.match(/const NET_TIMEOUT_MS = (\d+)/) || [])[1]);
        expect(ms, 'the shell timeout is missing or implausible').toBeGreaterThan(2000);
        expect(ms, 'a shell timeout this long is indistinguishable from a hang').toBeLessThanOrEqual(30000);
    });

    it('never caches the API or the update check itself', () => {
        // Caching version.json would freeze the app on the first version it saw —
        // which is the reported bug, reintroduced by the fix for it.
        expect(sw).toMatch(/pathname\.startsWith\(\s*['"]\/api\//);
        expect(sw).toMatch(/version\.json/);
        expect(sw).toMatch(/request\.method\s*!==\s*['"]GET['"]/);
    });

    it('purges every cache that is not the current version on activate', () => {
        expect(sw).toMatch(/keys\.filter\(k\s*=>\s*k\s*!==\s*CACHE_NAME\)/);
    });
});

describe('2b. the fetch handler, actually executed', () => {
    /**
     * The assertions above read sw.js as text. These RUN it against a stub of the
     * service-worker global scope, because "the file contains caches.open" and
     * "the worker serves the right thing" are different claims, and only the
     * second one is what the owner experiences. Every case below is a routing
     * decision that would be a real incident if it went the other way.
     */
    function loadWorker({ online = true } = {}) {
        const listeners = {};
        const store = {
            _m: {},
            put: async (req, res) => { store._m[req.url] = { FROM: 'CACHE', url: req.url }; },
            match: async (req) => store._m[typeof req === 'string' ? req : req.url],
        };
        const calls = { fetchInits: [] };
        const g = {
            self: {
                location: { origin: 'https://wf.app' },
                addEventListener: (t, f) => { listeners[t] = f; },
                registration: {}, clients: { matchAll: async () => [] }, skipWaiting() {},
            },
            caches: { keys: async () => [], open: async () => store, delete: async () => true },
            clients: { claim() {}, matchAll: async () => [] },
            fetch: async (req, init) => {
                calls.fetchInits.push(init);
                if (!g.online) throw new Error('offline');
                return { ok: true, FROM: 'NETWORK', url: req.url, clone: () => ({ url: req.url }) };
            },
            online,
        };
        Object.assign(globalThis, {
            self: g.self, caches: g.caches, clients: g.clients,
            fetch: g.fetch,
        });
        // Fresh evaluation each time — a cached module would carry state between tests.
        const code = read('sw.js');
        new Function(code)();
        return {
            listeners, store, calls,
            setOnline: (v) => { g.online = v; },
            async request(url, mode = 'no-cors', method = 'GET') {
                let out = 'PASSTHROUGH';
                listeners.fetch({ request: { url, method, mode }, respondWith: (p) => { out = p; } });
                if (out === 'PASSTHROUGH') return 'passthrough';
                try { return (await out).FROM; } catch (e) { return 'threw'; }
            },
        };
    }

    it('never intercepts the API, the update check, POSTs, or other origins', async () => {
        const w = loadWorker();
        expect(await w.request('https://wf.app/api/router')).toBe('passthrough');
        expect(await w.request('https://wf.app/version.json')).toBe('passthrough');
        expect(await w.request('https://wf.app/', 'navigate', 'POST')).toBe('passthrough');
        expect(await w.request('https://cdn.example.com/lib.js')).toBe('passthrough');
        expect(await w.request('https://wf.app/logo.png')).toBe('passthrough');
    });

    it('serves app code from the network and stores it for offline', async () => {
        const w = loadWorker();
        expect(await w.request('https://wf.app/wealthflow-ai.js')).toBe('NETWORK');
        w.setOnline(false);
        expect(await w.request('https://wf.app/wealthflow-ai.js')).toBe('CACHE');
    });

    it('surfaces the real error offline rather than inventing an empty page', async () => {
        const w = loadWorker();
        w.setOnline(false);
        expect(await w.request('https://wf.app/wealthflow-never-seen.js')).toBe('threw');
    });

    it('calls fetch with no init, so a navigation request is never re-derived', async () => {
        const w = loadWorker();
        await w.request('https://wf.app/index.html', 'navigate');
        expect(w.calls.fetchInits.length).toBeGreaterThan(0);
        // Passing any init downgrades mode:'navigate' — a white screen on the
        // app's own entry point. Assert the argument is genuinely absent.
        for (const init of w.calls.fetchInits) expect(init).toBeUndefined();
    });
});

describe('3. the progress bar must measure work, not setTimeout', () => {
    const src = read('wealthflow-update-system.js');
    const i = src.indexOf('const steps = [');
    const steps = src.slice(i, src.indexOf('];', i));

    it('the steps block was actually located', () => {
        expect(i, 'steps array anchor not found — retarget this test').toBeGreaterThan(-1);
        expect(steps.length).toBeGreaterThan(200);
    });

    it('contains no bare _sleep() standing in for work', () => {
        // The precise old shape: `run: async () => { await _sleep(600); }` — a step
        // whose entire body was a delay, under a label claiming security work.
        expect(steps).not.toMatch(/run:\s*async\s*\(\)\s*=>\s*\{\s*await _sleep\([0-9]+\);\s*\}/);
    });

    it('no longer claims to apply "security protocols" while doing nothing', () => {
        expect(steps).not.toMatch(/Applying security protocols/);
    });

    it('the download step really fetches the app files', () => {
        expect(steps).toMatch(/_appFileList\(\)/);
        expect(steps).toMatch(/fetch\(src,\s*\{\s*cache:\s*['"]reload['"]/);
    });

    it('derives the ETA from the observed rate rather than a constant', () => {
        expect(steps).toMatch(/elapsed\s*\/\s*frac\s*-\s*elapsed/);
    });
});

describe('the file list is read from the document, not hand-kept', () => {
    const src = read('wealthflow-update-system.js');

    it('enumerates script[src] instead of a hardcoded array', () => {
        // A hand-kept list drifts; this session deleted a module, which would have
        // left such a list fetching a 404 while still reporting success.
        expect(src).toMatch(/querySelectorAll\(\s*['"]script\[src\]['"]\s*\)/);
    });

    it('skips cross-origin scripts', () => {
        const i = src.indexOf('function _appFileList');
        expect(i, '_appFileList anchor not found — retarget this test').toBeGreaterThan(-1);
        const fn = src.slice(i, i + 1200);
        expect(fn).toMatch(/location\.origin/);
    });
});
