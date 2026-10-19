/* test/public_site_layout_test.js - the public home page, privacy policy and terms.
 *
 * Google's OAuth brand verification (2026-10-19) rejected the site because "/" was the login
 * wall. These tests pin what a verification reviewer, a crawler and an existing user must each
 * get, so that none of it can drift back:
 *   - "/" is a public page that names the app and links to the privacy policy, and nothing on
 *     the public pages needs a sign-in or loads Firebase;
 *   - the privacy policy carries the Google Limited Use statement and does not claim end-to-end
 *     encryption the code does not provide;
 *   - the deploy swap (publish-layout.mjs) puts the app at /app and fails loudly when it cannot;
 *   - every old way into the app that arrives on "/" (OAuth return, magic link, share link,
 *     installed launch) is forwarded to /app with its query intact.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { inspect, publish, LANDING_MARKER } from '../publish-layout.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const VERCEL = JSON.parse(read('vercel.json'));
const LANDING = read('landing.html');
const PRIVACY = read('privacy.html');
const TERMS = read('terms.html');
const APP = read('index.html');
const SW = read('sw.js');
const MANIFEST = JSON.parse(read('manifest.json'));

const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ');

describe('vercel.json serves the swapped layout', () => {
    it('builds the app first and then swaps the layout', () => {
        expect(VERCEL.buildCommand).toBe('node build.mjs --write && node publish-layout.mjs');
    });

    it('routes /app, /privacy and /terms before the catch-all, and the catch-all serves the app', () => {
        const src = VERCEL.rewrites.map((r) => r.source);
        const rule = (s) => VERCEL.rewrites.find((r) => r.source === s);
        expect(rule('/app').destination).toBe('/app.html');
        expect(rule('/privacy').destination).toBe('/privacy.html');
        expect(rule('/terms').destination).toBe('/terms.html');
        const catchAll = src.indexOf('/(.*)');
        expect(catchAll).toBe(src.length - 1);
        expect(VERCEL.rewrites[catchAll].destination).toBe('/app.html');
        for (const s of ['/app', '/privacy', '/terms']) expect(src.indexOf(s)).toBeLessThan(catchAll);
    });

    it('keeps the app document revalidating exactly like the old index.html', () => {
        for (const s of ['/', '/app', '/app.html']) {
            const h = VERCEL.headers.find((x) => x.source === s);
            expect(h, s).toBeTruthy();
            expect(h.headers).toContainEqual({ key: 'Cache-Control', value: 'no-cache, must-revalidate' });
        }
    });

    it('redirects the staging file names to their clean URLs', () => {
        for (const [from, to] of [['/index.html', '/'], ['/landing.html', '/'], ['/app.html', '/app'], ['/privacy.html', '/privacy'], ['/terms.html', '/terms']]) {
            expect(VERCEL.redirects).toContainEqual({ source: from, destination: to, permanent: true });
        }
    });
});

describe('the public pages', () => {
    it('the home page names the app, links the policy and terms, and offers Login / Register at /app', () => {
        expect(LANDING).toContain(LANDING_MARKER);
        expect(LANDING).toMatch(/<title>[^<]*WealthFlow[^<]*<\/title>/);
        expect(LANDING).toContain('href="/privacy"');
        expect(LANDING).toContain('href="/terms"');
        expect(LANDING).toMatch(/<a[^>]+href="\/app"[^>]*>\s*Login \/ Register/);
        for (const feature of ['Autonomous email sync', 'Parallel AI Matrix', 'DSCR calculator']) expect(LANDING).toContain(feature);
        expect(LANDING).toContain('https://www.wealthflow.lk/');
    });

    it('the privacy link is on the same domain and is not behind a sign-in', () => {
        expect(PRIVACY).toContain('<link rel="canonical" href="https://www.wealthflow.lk/privacy">');
        expect(TERMS).toContain('<link rel="canonical" href="https://www.wealthflow.lk/terms">');
        for (const html of [LANDING, PRIVACY, TERMS]) {
            expect(html).not.toMatch(/<script[^>]*src=[^>]*(firebase|gstatic)/i);
            expect(html).not.toMatch(/firebase\.(auth|initializeApp)|signInWith/);
        }
    });

    it('the privacy policy carries what Google reviews', () => {
        const t = textOf(PRIVACY);
        expect(PRIVACY).toContain('https://developers.google.com/terms/api-services-user-data-policy');
        expect(t).toContain('including the Limited Use requirements');
        for (const needle of ['Gmail', 'Google Drive', 'drive.file', 'read-only', 'myaccount.google.com/permissions',
            'We do not sell', 'Personal Data Protection Act, No. 9 of 2022', 'Contact', 'gaurawasachintha@gmail.com',
            'Last updated']) {
            expect(t, needle).toContain(needle);
        }
    });

    it('the policy does not claim end-to-end encryption, and says so plainly', () => {
        const t = textOf(PRIVACY);
        expect(t).toMatch(/not end-to-end encrypted/i);
        expect(t).toMatch(/not a zero-knowledge service/i);
        expect(t).not.toMatch(/\b(?:is|are) (?:fully )?end-to-end encrypted/i);
        expect(textOf(LANDING)).not.toMatch(/end-to-end/i);
        expect(textOf(APP.slice(APP.indexOf('id="authLogin"') - 6000, APP.indexOf('id="authLogin"')))).not.toMatch(/end-to-end encrypted/i);
    });

    it('the app login screen links the policy and terms', () => {
        const at = APP.indexOf('Encrypted in transit');
        expect(at).toBeGreaterThan(0);
        const around = APP.slice(at, at + 900);
        expect(around).toContain('href="/privacy"');
        expect(around).toContain('href="/terms"');
    });

    it('robots.txt and the sitemap list the three public pages', () => {
        expect(read('robots.txt')).toContain('Sitemap: https://www.wealthflow.lk/sitemap.xml');
        const sm = read('sitemap.xml');
        for (const u of ['/', '/privacy', '/terms']) expect(sm).toContain(`<loc>https://www.wealthflow.lk${u}</loc>`);
    });

    it('no em-dash or emoji in the public copy', () => {
        for (const html of [LANDING, PRIVACY, TERMS]) {
            expect(html).not.toContain('—');
            expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
        }
    });
});

describe('publish-layout.mjs', () => {
    const FILES = ['index.html', 'landing.html', 'privacy.html', 'terms.html'];
    const copy = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-layout-'));
        for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
        return dir;
    };

    it('accepts the repository tree as it is', () => {
        expect(inspect(ROOT)).toEqual([]);
    });

    it('swaps the app to app.html and the landing page to index.html', () => {
        const dir = copy();
        publish(dir);
        expect(fs.readFileSync(path.join(dir, 'app.html'), 'utf8')).toBe(APP);
        expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(LANDING);
        expect(fs.readFileSync(path.join(dir, 'privacy.html'), 'utf8')).toBe(PRIVACY);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('refuses a second run, which would turn the landing page into the app', () => {
        const dir = copy();
        publish(dir);
        expect(() => publish(dir)).toThrow(/already/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fails the build when a public page is missing or the landing page is not the landing page', () => {
        const dir = copy();
        fs.rmSync(path.join(dir, 'privacy.html'));
        expect(() => publish(dir)).toThrow(/privacy\.html is missing/);
        fs.copyFileSync(path.join(ROOT, 'privacy.html'), path.join(dir, 'privacy.html'));
        fs.writeFileSync(path.join(dir, 'landing.html'), '<html></html>');
        expect(() => publish(dir)).toThrow(/wf-landing marker/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fails the build when a public page would load Firebase', () => {
        const dir = copy();
        fs.appendFileSync(path.join(dir, 'terms.html'), '<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js"></script>');
        expect(() => publish(dir)).toThrow(/terms\.html must not load or call Firebase/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('the home page forwards every way into the app that used to land on "/"', () => {
    const script = (LANDING.match(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/) || [''])[0].replace(/<\/?script>/g, '');

    function run({ search = '', hash = '', standalone = false, iosStandalone = false, store = {} } = {}) {
        let replaced = null;
        const win = {
            location: { search, hash, replace: (u) => { replaced = u; } },
            matchMedia: () => ({ matches: standalone }),
            navigator: { standalone: iosStandalone },
            localStorage: { getItem: (k) => (k in store ? store[k] : null) },
        };
        win.window = win;
        vm.runInNewContext(script, { window: win, URLSearchParams });
        return replaced;
    }

    it('has the forwarding script', () => {
        expect(script.length).toBeGreaterThan(100);
    });

    it('shows the public page to a first-time visitor, a crawler and campaign links', () => {
        expect(run()).toBe(null);
        expect(run({ search: '?utm_source=x&fbclid=1&gclid=2&ref=z' })).toBe(null);
        expect(run({ search: '?public=1&code=abc' })).toBe(null);
    });

    it('forwards OAuth returns, magic links, shortcuts and share links with the query intact', () => {
        expect(run({ search: '?code=4%2Fabc&state=wfdrive_x&scope=drive.file' })).toBe('/app?code=4%2Fabc&state=wfdrive_x&scope=drive.file');
        expect(run({ search: '?recovery=1&oobCode=zz&mode=signIn' })).toBe('/app?recovery=1&oobCode=zz&mode=signIn');
        expect(run({ search: '?s=AbCdEfGh' })).toBe('/app?s=AbCdEfGh');
        expect(run({ search: '?driveauth=1' })).toBe('/app?driveauth=1');
        expect(run({ search: '?source=pwa' })).toBe('/app?source=pwa');
        expect(run({ hash: '#state=a&access_token=b' })).toBe('/app#state=a&access_token=b');
    });

    it('forwards installed launches and signed-in browsers', () => {
        expect(run({ standalone: true })).toBe('/app');
        expect(run({ iosStandalone: true })).toBe('/app');
        expect(run({ store: { wf_returning: '1' } })).toBe('/app');
    });
});

describe('the PWA and the service worker follow the app to /app', () => {
    it('launches and shortcuts open /app; the install identity is unchanged', () => {
        expect(MANIFEST.start_url).toBe('/app?source=pwa');
        expect(MANIFEST.id).toBe('/?source=pwa');
        expect(MANIFEST.scope).toBe('/');
        for (const s of MANIFEST.shortcuts) expect(s.url).toMatch(/^\/app\?/);
    });

    it('caches the app and the public home page under different keys', () => {
        const fn = SW.match(/function _shellCacheKey[\s\S]*?\n\}/)[0];
        const key = vm.runInNewContext(fn + '; _shellCacheKey', { URL });
        const nav = { mode: 'navigate' };
        expect(key(nav, new URL('https://x/app?source=pwa'))).toBe('/app');
        expect(key(nav, new URL('https://x/app.html'))).toBe('/app');
        expect(key(nav, new URL('https://x/?source=pwa'))).toBe('/');
        expect(key(nav, new URL('https://x/index.html'))).toBe('/');
        const asset = { mode: 'no-cors', url: 'a' };
        expect(key(asset, new URL('https://x/wealthflow-ui-12345678.js'))).toBe(asset);
    });

    it('treats /app as an app-shell URL and falls back to the cached app, not the home page', () => {
        expect(SW).toMatch(/p === '\/app'/);
        expect(SW).toContain("cache.match('/app')");
        expect(SW).toContain("data: { url: '/app' }");
    });
});
