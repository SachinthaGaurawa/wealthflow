/* test/signout_navigation_test.js - signing out must never end in a downloaded file.
 *
 * Reported 2026-10-19: signing out of WealthFlow downloaded an empty file called "app". The app
 * had moved to /app that day (#444), so the file name is the last segment of the address the
 * sign-out navigated to. Production serves /app correctly (text/html, inline), so the answer a
 * browser can turn into a download is one that reaches the page from the service worker or from a
 * same-address reload: an empty 304/204, or a 200 that is not labelled as HTML.
 *
 * What is pinned here:
 *   - the service worker hands a navigation to "/" or "/app" a page or the original answer, never
 *     an empty 304/204 or a mislabelled body, and it recovers from the network, then from the
 *     stored copy, then by labelling a 200 body as HTML;
 *   - the worker's first fetch still carries no init (a navigate request must not be re-derived);
 *   - both sign-out paths leave for a fresh address (/app?signedout=...), not the address the
 *     browser is already on, and the page removes that mark again;
 *   - the document routes carry an explicit HTML type and an inline disposition.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SW = read('sw.js');
const APP = read('index.html');
const VERCEL = JSON.parse(read('vercel.json'));

const PAGE = '<!doctype html><title>WealthFlow</title><p>the app</p>';
const html = () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

/** Runs sw.js against a stub of the worker scope. `net(kind, req, init)` answers the two kinds of fetch. */
function loadWorker({ net }) {
    const listeners = {};
    const puts = [];
    const store = {
        _m: {},
        put: async (key, res) => { store._m[typeof key === 'string' ? key : key.url] = res; puts.push(typeof key === 'string' ? key : key.url); },
        match: async (key) => store._m[typeof key === 'string' ? key : key.url],
    };
    const calls = [];
    const self = {
        location: { origin: 'https://wf.app' },
        addEventListener: (t, f) => { listeners[t] = f; },
        registration: {}, clients: { matchAll: async () => [] }, skipWaiting() {},
    };
    const fetchStub = async (req, init) => {
        const kind = typeof req === 'string' ? 'reload' : 'navigation';
        calls.push({ kind, init, url: typeof req === 'string' ? req : req.url });
        return net(kind, req, init);
    };
    Object.assign(globalThis, {
        self, fetch: fetchStub,
        caches: { keys: async () => [], open: async () => store, delete: async () => true },
        clients: { claim() {}, matchAll: async () => [] },
    });
    new Function(SW)();
    return {
        store, calls, puts,
        async navigate(url, mode = 'navigate') {
            let out = null;
            const lifetime = [];
            listeners.fetch({
                request: { url, method: 'GET', mode },
                respondWith: (p) => { out = p; },
                waitUntil: (p) => { lifetime.push(Promise.resolve(p)); },
            });
            if (out === null) return { passthrough: true };
            let res;
            try { res = await out; } catch (e) { return { threw: true }; }
            await Promise.all(lifetime);
            return { res, text: res && typeof res.clone === 'function' && res.body ? await res.clone().text() : '' };
        },
    };
}

describe('the service worker never hands a navigation something a browser would save as a file', () => {
    it('replaces an empty 304 for /app with the page, fetched again without validators', async () => {
        const w = loadWorker({ net: (kind) => (kind === 'navigation' ? new Response(null, { status: 304 }) : html()) });
        const a = await w.navigate('https://wf.app/app');
        expect(a.res.status).toBe(200);
        expect(a.res.headers.get('Content-Type')).toMatch(/^text\/html/);
        expect(a.text).toBe(PAGE);
        const again = w.calls.find((c) => c.kind === 'reload');
        expect(again.init.cache).toBe('reload');
        expect(again.url).toBe('https://wf.app/app');
        // the good page is stored for offline, exactly as a normal answer would be
        expect(w.puts).toContain('/app');
    });

    it('does the same for "/" and keeps query launches on the same stored document', async () => {
        const w = loadWorker({ net: (kind) => (kind === 'navigation' ? new Response(null, { status: 304 }) : html()) });
        expect((await w.navigate('https://wf.app/')).text).toBe(PAGE);
        expect((await w.navigate('https://wf.app/app?signedout=k2x')).text).toBe(PAGE);
        expect(w.puts).toEqual(expect.arrayContaining(['/', '/app']));
    });

    it('replaces an empty 204 and 205 too', async () => {
        for (const status of [204, 205]) {
            const w = loadWorker({ net: (kind) => (kind === 'navigation' ? new Response(null, { status }) : html()) });
            expect((await w.navigate('https://wf.app/app')).text).toBe(PAGE);
        }
    });

    it('falls back to the stored copy of this version when the network cannot give a page', async () => {
        const w = loadWorker({ net: (kind) => { if (kind === 'reload') throw new Error('offline'); return new Response(null, { status: 304 }); } });
        const stored = html();
        w.store._m['/app'] = stored;
        const a = await w.navigate('https://wf.app/app');
        expect(a.res).toBe(stored);
        // a copy that came from the cache is not written back over itself
        expect(w.puts).toEqual([]);
    });

    it('returns the original answer, not an invented page, when nothing better exists', async () => {
        const w = loadWorker({ net: () => new Response(null, { status: 304 }) });
        const a = await w.navigate('https://wf.app/app');
        expect(a.res.status).toBe(304);
        expect(w.puts).toEqual([]);
    });

    it('replaces a 200 that is not labelled as HTML (octet-stream: the answer a browser downloads)', async () => {
        const w = loadWorker({
            net: (kind) => (kind === 'navigation'
                ? new Response(PAGE, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })
                : html()),
        });
        const a = await w.navigate('https://wf.app/app');
        expect(a.res.headers.get('Content-Type')).toMatch(/^text\/html/);
        expect(a.text).toBe(PAGE);
    });

    it('labels the body as HTML when it arrives unlabelled and the network keeps doing it', async () => {
        // new Response(string) is labelled text/plain by the platform; either way it is not HTML
        const w = loadWorker({ net: () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }) });
        const a = await w.navigate('https://wf.app/app');
        expect(a.res.status).toBe(200);
        expect(a.res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
        expect(a.text).toBe(PAGE);
    });

    it('leaves a good page alone and fetches once', async () => {
        const w = loadWorker({ net: () => html() });
        const a = await w.navigate('https://wf.app/app');
        expect(a.text).toBe(PAGE);
        expect(w.calls).toHaveLength(1);
        expect(w.calls[0].kind).toBe('navigation');
    });

    it('leaves a redirect for the browser to follow', async () => {
        const redirect = { type: 'opaqueredirect', status: 0, ok: false, clone() { return this; } };
        const w = loadWorker({ net: () => redirect });
        const a = await w.navigate('https://wf.app/app.html');
        expect(a.res).toBe(redirect);
        expect(w.calls).toHaveLength(1);
    });

    it('only checks pages: a script that answers 304 is not rewritten', async () => {
        const w = loadWorker({ net: () => new Response(null, { status: 304 }) });
        const a = await w.navigate('https://wf.app/wealthflow-ai.js', 'no-cors');
        expect(a.res.status).toBe(304);
        expect(w.calls).toHaveLength(1);
    });

    it('still gives the navigation fetch no init, so the request is never re-derived', async () => {
        const w = loadWorker({ net: (kind) => (kind === 'navigation' ? new Response(null, { status: 304 }) : html()) });
        await w.navigate('https://wf.app/app');
        expect(w.calls.find((c) => c.kind === 'navigation').init).toBeUndefined();
    });
});

describe('signing out leaves for a fresh address, not the one the browser is already on', () => {
    const fnBody = (name) => {
        const i = APP.indexOf(`async function ${name}(`) >= 0 ? APP.indexOf(`async function ${name}(`) : APP.indexOf(`function ${name}(`);
        expect(i, `${name} not found`).toBeGreaterThan(-1);
        return APP.slice(i, i + 3200);
    };

    it('signOutGoogle navigates through _wfSignedOutUrl and never reloads the same address', () => {
        const body = fnBody('signOutGoogle');
        expect(body).toContain('window.location.replace(_wfSignedOutUrl())');
        expect(body).not.toMatch(/location\.replace\((window\.)?location\.pathname\)/);
    });

    it('the forced sign-out (revoked session) does the same', () => {
        const i = APP.indexOf('Force a hard reload so the user lands at the Google sign-in screen');
        expect(i).toBeGreaterThan(-1);
        const near = APP.slice(i, i + 400);
        expect(near).toContain('location.replace(_wfSignedOutUrl())');
        expect(near).not.toMatch(/location\.replace\(location\.pathname\)/);
    });

    it('_wfSignedOutUrl is this path plus a one-off mark', () => {
        const m = APP.match(/function _wfSignedOutUrl\(\) \{[\s\S]*?\n        \}/);
        expect(m).toBeTruthy();
        const fn = vm.runInNewContext(`${m[0]}; _wfSignedOutUrl`, { window: { location: { pathname: '/app' } }, Date });
        const a = fn();
        expect(a).toMatch(/^\/app\?signedout=[0-9a-z]+$/);
        const g = vm.runInNewContext(`${m[0]}; _wfSignedOutUrl`, { window: { get location() { throw new Error('x'); } }, Date });
        expect(g()).toBe('/app');
    });

    it('the page removes the mark again and keeps every other parameter and the hash', () => {
        const m = APP.match(/\(function stripSignedOutMark\(\) \{[\s\S]*?\n        \}\)\(\);/);
        expect(m).toBeTruthy();
        const run = (search, hash = '') => {
            const seen = [];
            vm.runInNewContext(m[0], {
                window: { location: { search, pathname: '/app', hash } },
                history: { replaceState: (_s, _t, u) => seen.push(u) },
                URLSearchParams,
            });
            return seen;
        };
        expect(run('?signedout=k2x')).toEqual(['/app']);
        expect(run('?signedout=k2x&page=ai', '#x')).toEqual(['/app?page=ai#x']);
        expect(run('?page=ai')).toEqual([]);
        expect(run('')).toEqual([]);
    });

    it('the mark is a harmless query on the app route (revalidating headers apply to the path)', () => {
        const h = VERCEL.headers.find((x) => x.source === '/app');
        expect(h.headers).toContainEqual({ key: 'Cache-Control', value: 'no-cache, must-revalidate' });
        expect(VERCEL.rewrites.find((r) => r.source === '/app').destination).toBe('/app.html');
    });
});

describe('the document routes say exactly what they are', () => {
    for (const source of ['/', '/app', '/privacy', '/terms']) {
        it(`${source} carries an HTML type and an inline disposition`, () => {
            const h = VERCEL.headers.find((x) => x.source === source);
            expect(h, source).toBeTruthy();
            expect(h.headers).toContainEqual({ key: 'Content-Type', value: 'text/html; charset=utf-8' });
            expect(h.headers).toContainEqual({ key: 'Content-Disposition', value: 'inline' });
        });
    }
});
