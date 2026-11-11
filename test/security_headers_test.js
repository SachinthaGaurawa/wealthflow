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

    it('scripts run only from files: no inline script, no inline handler, no eval (finding 1, phase 2)', () => {
        /* The build moves every inline script into a hashed file and ships handlers as data-wf-on-*
         * attributes that wealthflow-handlers.js runs without eval. With both in place the keyword is
         * unnecessary, and an injected <script> or onclick= stays inert. test/e2e/strict-csp.mjs boots
         * the built app under exactly this policy. */
        expect(CSP['script-src']).not.toContain("'unsafe-inline'");
        expect(CSP['script-src']).not.toContain("'unsafe-eval'");
        expect(CSP['script-src']).toContain("'self'");
        expect(CSP['script-src']).toContain("'wasm-unsafe-eval'");
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

describe('the statement reader sandbox page', () => {
    // The statement reader runs a bank statement (an application with its own inline scripts) in a frame. A srcdoc frame
    // would inherit the app's policy, so the frame loads wf-sandbox.html, whose response carries a policy of its own.
    const sb = parseCsp(headersFor('/wf-sandbox.html')['Content-Security-Policy']);
    it('is its own rule, later than the global one, so its policy replaces the app policy for that path', () => {
        const order = VERCEL.headers.map((r) => r.source);
        expect(order.indexOf('/wf-sandbox.html')).toBeGreaterThan(order.indexOf('/(.*)'));
        expect(fs.existsSync(path.join(ROOT, 'wf-sandbox.html'))).toBe(true);
    });
    it('allows inline script and nothing that reaches the network', () => {
        expect(sb['default-src']).toEqual(["'none'"]);
        expect(sb['script-src']).toEqual(["'unsafe-inline'", "'unsafe-eval'"]);
        for (const k of ['connect-src', 'frame-src', 'form-action']) {
            const v = sb[k] || sb['default-src'];
            expect(v, k).toEqual(["'none'"]);
        }
        expect(sb['img-src']).toEqual(['data:']);
        expect(sb['frame-ancestors']).toEqual(["'self'"]);
        expect(headersFor('/wf-sandbox.html')['X-Frame-Options']).toBe('SAMEORIGIN');
    });
    it('is the same policy the document the frame is handed declares for itself', () => {
        const m = /_SANDBOX_CSP = ((?:"[^"]*"\s*\+?\s*)+);/.exec(read('wealthflow-html-statement.js'));
        expect(m, 'the in-document policy was not found').toBeTruthy();
        const inDoc = parseCsp(m[1].split('+').map((x) => x.trim().replace(/^"|"$/g, '')).join(''));
        for (const k of Object.keys(inDoc)) expect(sb[k], k).toEqual(inDoc[k]);
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

    /* Does any rewrite answer this path? Plain sources match literally, the rest are regular expressions
     * (path-to-regexp hands a parenthesised group to RegExp unchanged). Static files are served before
     * rewrites, so a path no rewrite answers and no file exists for is a real 404. */
    const answered = (p) => VERCEL.rewrites.some((r) => (/[(:*]/.test(r.source) ? new RegExp('^' + r.source + '$').test(p) : r.source === p));
    const files = (p) => !/^\/\./.test(p) && fs.existsSync(path.join(ROOT, p.replace(/^\//, '')));   // a dot path (.git, .env) is never shipped

    it('answers any path the app does not own with a 404, never the app with a 200', () => {
        for (const p of ['/admin', '/admin/login', '/administrator', '/wp-admin/', '/wp-login.php', '/phpmyadmin', '/.env', '/.env.production', '/.git/config',
            '/.htaccess', '/server-status', '/actuator/health', '/phpinfo.php', '/anything/shell.php', '/db.sql', '/backup.bak', '/cgi-bin/test', '/.well-known/security.txt',
            '/admin-panel', '/admin_panel', '/adminpanel', '/administration', '/backend', '/panel', '/manager', '/controlpanel', '/control-panel', '/moderator', '/root', '/wp-json/wp/v2/users',
            // the ones a scanner found answering 200 after the blacklist (2026-11-11)
            '/_admin', '/account', '/accounts', '/admin1', '/admin2', '/backstage', '/control', '/cp', '/dbadmin', '/debug', '/internal', '/manage', '/management', '/owner',
            '/portal', '/private', '/secure', '/staff', '/superadmin', '/system', '/user', '/users', '/vendor', '/webadmin', '/anything-else', '/robots-not-here']) {
            expect(answered(p) || files(p), p + ' must be a 404').toBe(false);
        }
    });

    it('still serves every path the product owns', () => {
        for (const p of ['/app', '/app/', '/privacy', '/terms', '/r/abcd1234', '/t/abcdefghijklmnop', '/api/ai', '/manifest.json', '/sw.js', '/.well-known/assetlinks.json', '/merchants.json']) {
            expect(answered(p), p + ' must still be answered').toBe(true);
        }
        for (const p of ['/', '/robots.txt', '/404.html', '/share-target.html']) expect(files(p === '/' ? '/index.html' : p), p).toBe(true);
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
    });
});
