/* =============================================================================
 * test/security_headers_test.js — what the browser is told about this site
 * -----------------------------------------------------------------------------
 * A third-party scan of www.wealthflow.lk (RedSentinel, 2026-11-07, 49/100) listed four findings. Each was checked
 * against the live site first, then fixed, and this file is what keeps them fixed:
 *
 *   1. Content-Security-Policy header missing          → vercel.json now sends one, and it is pinned here
 *   2. Overly permissive CORS (`*`)                    → wf-cors.mjs allow-list, enforced in api/router.js
 *   3. "Admin panel publicly accessible"               → the catch-all rewrite answered every path (/admin, /wp-admin,
 *                                                         /.env …) with the app and a 200; probe paths now get a real 404
 *   4. Sensitive paths revealed in robots.txt          → robots.txt lists none; X-Robots-Tag headers do the keeping out
 *
 * It also pins what makes the CSP safe to keep: every script a page takes from a CDN must carry an integrity hash, and the
 * CSP must name the host it comes from.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const VERCEL = JSON.parse(read('vercel.json'));

function headersFor(source) {
    const rule = VERCEL.headers.find((r) => r.source === source);
    const out = {};
    for (const h of (rule ? rule.headers : [])) out[h.key] = h.value;
    return out;
}

function parseCsp(csp) {
    const out = {};
    for (const part of csp.split(';')) {
        const t = part.trim();
        if (!t) continue;
        const [name, ...vals] = t.split(/\s+/);
        out[name] = vals;
    }
    return out;
}

const GLOBAL = headersFor('/(.*)');
const CSP = parseCsp(GLOBAL['Content-Security-Policy'] || '');

describe('Content-Security-Policy (finding 1)', () => {
    it('is sent on every response', () => {
        expect(GLOBAL['Content-Security-Policy']).toBeTruthy();
    });

    it('closes the doors that need no compatibility: plugins, <base>, framing, form posts', () => {
        expect(CSP['default-src']).toEqual(["'self'"]);
        expect(CSP['object-src']).toEqual(["'none'"]);
        expect(CSP['base-uri']).toEqual(["'self'"]);
        expect(CSP['frame-ancestors']).toEqual(["'self'"]);
        expect(CSP['form-action']).toContain("'self'");
        expect(CSP['upgrade-insecure-requests']).toBeDefined();
    });

    it('never allows eval, a bare scheme, or a wildcard host for scripts or connections', () => {
        for (const dir of ['script-src', 'connect-src', 'worker-src', 'frame-src']) {
            const v = CSP[dir];
            expect(v, dir).toBeDefined();
            expect(v, dir + ' must not allow eval').not.toContain("'unsafe-eval'");
            expect(v, dir + ' must not allow a bare https:').not.toContain('https:');
            expect(v, dir + ' must not allow *').not.toContain('*');
            expect(v.filter((x) => /^https:\/\/\*\./.test(x)), dir + ' must not allow wildcard hosts').toEqual([]);
        }
    });

    it('lets a CDN supply only the exact packages the app loads', () => {
        const cdn = CSP['script-src'].filter((x) => /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/.test(x));
        expect(cdn.length).toBeGreaterThan(0);
        for (const src of cdn) expect(src, src + ' must be a path ending in /').toMatch(/^https:\/\/[^/]+\/.+\/$/);
    });

    it('reports what it refuses, to a route that exists', () => {
        expect(CSP['report-uri']).toEqual(['/api/csp-report']);
        expect(read('api/router.js')).toMatch(/'csp-report':\s*\(\)\s*=>\s*import\('\.\.\/csp-report\.js'\)/);
    });

    it('covers every host a page script is loaded from (so a new CDN URL cannot ship unlisted)', () => {
        const files = ['index.html', 'landing.html', ...fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f))];
        const seen = new Set();
        for (const f of files) {
            for (const m of read(f).matchAll(/https:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|www\.gstatic\.com\/firebasejs|js\.puter\.com)[A-Za-z0-9._@\/-]*\.js/g)) seen.add(m[0]);
        }
        expect(seen.size).toBeGreaterThan(5);
        for (const url of seen) {
            const allowed = CSP['script-src'].some((s) => url.startsWith(s) || (s.startsWith('https://') && !s.endsWith('/') && url === s));
            expect(allowed, url + ' is loaded by the app but the CSP script-src does not allow it').toBe(true);
        }
    });

    it('does not load a third-party script that nothing calls (js.puter.com was one)', () => {
        for (const f of ['index.html', 'landing.html', 'privacy.html', 'terms.html', 'tenant.html']) {
            expect(read(f), f).not.toMatch(/<script[^>]+src=["']https:\/\/js\.puter\.com/);
        }
    });

    it('keeps the page-specific policy of the tenant portal strictly tighter than the app policy', () => {
        const t = parseCsp(headersFor('/t/(.*)')['Content-Security-Policy']);
        expect(t['script-src']).toEqual(["'self'"]);
        expect(t['connect-src']).toEqual(["'self'"]);
    });
});

describe('subresource integrity for CDN scripts', () => {
    const html = read('index.html');
    const reg = (() => {
        const m = /window\.WF_SRI = \{([\s\S]*?)\};/.exec(html);
        expect(m, 'index.html has no WF_SRI registry').toBeTruthy();
        const o = {};
        for (const e of m[1].matchAll(/'([^']+)':\s*'(sha384-[A-Za-z0-9+/]{64})'/g)) o[e[1]] = e[2];
        return o;
    })();

    it('has a sha384 hash for every CDN script URL the app can load', () => {
        const files = ['index.html', ...fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f))];
        const urls = new Set();
        for (const f of files) {
            for (const m of read(f).matchAll(/https:\/\/(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|www\.gstatic\.com\/firebasejs)[A-Za-z0-9._@\/-]*\.js\b/g)) {
                // pdf.js workers are started by pdf.js itself (no tag to put a hash on), and only the library files are loaded by a <script>
                if (/\.worker\./.test(m[0]) || /\/pdf\.worker/.test(m[0])) continue;
                urls.add(m[0]);
            }
        }
        expect(urls.size).toBeGreaterThan(5);
        for (const u of urls) expect(reg[u], u + ' is loaded from a CDN without an integrity hash').toBeTruthy();
    });

    // A mistyped hash makes the browser refuse the script, which for Firebase means the app cannot sign in. Offline CI cannot catch that,
    // so this re-fetches every hashed URL when asked (WF_SRI_VERIFY=1 npx vitest run test/security_headers_test.js).
    it.skipIf(!process.env.WF_SRI_VERIFY)('every hash matches the bytes the CDN serves right now', async () => {
        const { createHash } = await import('node:crypto');
        for (const [url, hash] of Object.entries(reg)) {
            const r = await fetch(url);
            expect(r.ok, url).toBe(true);
            const got = 'sha384-' + createHash('sha384').update(Buffer.from(await r.arrayBuffer())).digest('base64');
            expect(got, url).toBe(hash);
        }
    }, 120000);

    it('applies the hash to the three static Firebase tags and to every run-time loader', () => {
        for (const n of ['app', 'firestore', 'auth']) {
            expect(html).toMatch(new RegExp('<script src="https://www\\.gstatic\\.com/firebasejs/10\\.8\\.0/firebase-' + n + '-compat\\.js" integrity="sha384-[^"]+" crossorigin="anonymous" defer>'));
        }
        for (const n of ['app', 'firestore', 'auth']) {
            const url = 'https://www.gstatic.com/firebasejs/10.8.0/firebase-' + n + '-compat.js';
            expect(html.includes('<script src="' + url + '" integrity="' + reg[url] + '"'), n + ' tag hash differs from the registry').toBe(true);
        }
        expect(html).toContain('window.wfApplySri = function');
        for (const f of ['wealthflow-ai-v4.js', 'wealthflow-pdf-unlock.js', 'wealthflow-vision-sms.js']) {
            expect(read(f), f).toMatch(/window\.wfApplySri\)\s*window\.wfApplySri\(/);
        }
        // a floating version cannot be hashed
        expect(html).not.toMatch(/tesseract\.js@5\/dist/);
    });
});

describe('the other response headers', () => {
    it('keeps the transport and framing headers', () => {
        expect(GLOBAL['Strict-Transport-Security']).toMatch(/max-age=\d{8,}.*includeSubDomains/);
        expect(GLOBAL['X-Content-Type-Options']).toBe('nosniff');
        expect(GLOBAL['X-Frame-Options']).toBe('SAMEORIGIN');
        expect(GLOBAL['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
        expect(GLOBAL['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');   // Google sign-in is a popup
        expect(GLOBAL['Cross-Origin-Resource-Policy']).toBe('same-site');
        expect(GLOBAL['X-Permitted-Cross-Domain-Policies']).toBe('none');
    });

    it('denies the browser features the app does not use, and only keeps camera and microphone', () => {
        const pp = GLOBAL['Permissions-Policy'];
        for (const f of ['geolocation', 'payment', 'usb', 'bluetooth', 'display-capture', 'midi', 'serial', 'hid']) expect(pp).toContain(f + '=()');
        expect(pp).toContain('camera=(self)');
        expect(pp).toContain('microphone=(self)');
    });

    it('names its own origin on static files instead of the platform default `*`', () => {
        const rule = VERCEL.headers.find((r) => r.source === '/((?!api/).*)');
        expect(rule).toBeTruthy();
        const acao = rule.headers.find((h) => h.key === 'Access-Control-Allow-Origin');
        expect(acao.value).toBe('https://www.wealthflow.lk');
        const al = headersFor('/.well-known/assetlinks.json');
        expect(al['Access-Control-Allow-Origin']).toBeUndefined();
    });
});

describe('robots.txt and probe paths (findings 3 and 4)', () => {
    it('advertises no path', () => {
        const robots = read('robots.txt');
        expect(robots).not.toMatch(/^\s*Disallow:\s*\S/im);
        expect(robots).toContain('Sitemap: https://www.wealthflow.lk/sitemap.xml');
    });

    it('keeps the API and shared-statement links out of search by header instead', () => {
        const rule = VERCEL.headers.find((r) => r.source === '/(api|r)/(.*)');
        expect(rule).toBeTruthy();
        expect(rule.headers.find((h) => h.key === 'X-Robots-Tag').value).toMatch(/noindex/);
        expect(headersFor('/t/(.*)')['X-Robots-Tag']).toMatch(/noindex/);
    });

    // path-to-regexp hands a parenthesised group to RegExp unchanged, so the catch-all's source can be tried directly.
    const catchAll = VERCEL.rewrites.find((r) => r.destination === '/app.html' && r.source !== '/app');
    const re = new RegExp('^' + catchAll.source + '$');

    it('answers scanner probe paths with a 404 (no rewrite matches) instead of the app with a 200', () => {
        for (const p of ['/admin', '/admin/login', '/administrator', '/wp-admin/', '/wp-login.php', '/phpmyadmin', '/.env', '/.env.production', '/.git/config',
            '/.htaccess', '/server-status', '/actuator/health', '/phpinfo.php', '/anything/shell.php', '/db.sql', '/backup.bak', '/cgi-bin/test', '/.well-known/security.txt',
            '/admin-panel', '/admin_panel', '/adminpanel', '/administration', '/backend', '/panel', '/manager', '/controlpanel', '/control-panel', '/moderator', '/root', '/wp-json/wp/v2/users']) {
            expect(re.test(p), p + ' must not be served the app').toBe(false);
        }
    });

    it('still serves the app for every real path', () => {
        for (const p of ['/', '/app', '/app/', '/anything-else', '/administrators-guide-nothing', '/robots-not-here', '/panels-of-glass', '/rootless']) {
            // '/administrators-guide-nothing' starts with the word admin but is not the admin path
            expect(re.test(p), p + ' must still reach the app').toBe(true);
        }
    });

    it('sends the words a person may type (login, dashboard) to the app by redirect, not by serving it under an admin-looking path', () => {
        const rd = VERCEL.redirects.find((r) => /login/.test(r.source));
        expect(rd && rd.destination).toBe('/app');
        expect(rd.permanent).toBe(false);
        const rx = new RegExp('^' + rd.source + '$');
        for (const p of ['/login', '/signin', '/sign-in', '/dashboard']) expect(rx.test(p), p).toBe(true);
        expect(rx.test('/loginx')).toBe(false);
    });

    it('serves the real assetlinks.json instead of the app', () => {
        const rw = VERCEL.rewrites.find((r) => r.source === '/.well-known/assetlinks.json');
        expect(rw && rw.destination).toBe('/assetlinks.json');
        expect(VERCEL.rewrites.indexOf(rw)).toBeLessThan(VERCEL.rewrites.indexOf(catchAll));
    });
});
