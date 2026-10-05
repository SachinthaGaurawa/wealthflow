/* =============================================================================
 * test/tenant_wiring_test.js — the portal is connected, and connected safely
 * -----------------------------------------------------------------------------
 * A page nothing routes to, an endpoint nothing registers, a collection nothing seals and a policy
 * that quietly allows an inline script are all strings in files, so each is asserted where it lives.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOKEN_RE, newToken, PORTAL_PATH, linkFor } from '../tenant-links.mjs';
import { TOKEN_PATH_RE, tokenFromPath } from '../tenant-page.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const VERCEL = JSON.parse(read('vercel.json'));
const HTML = read('tenant.html');
const PAGE = read('tenant-page.js');
const CSS = read('tenant-page.css');
const RULES = read('firestore.rules');
const ROUTER = read('api/router.js');

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

describe('the route', () => {
    it('is registered with the router, under the name the cookie is scoped to', () => {
        expect(ROUTER).toMatch(/'tenant-portal': \(\) => import\('\.\.\/tenant-portal\.js'\)/);
        expect(read('tenant-portal.mjs')).toContain('Path=/api/tenant-portal');
    });

    it('rewrites exactly the link a text carries to the page, ahead of the catch-all', () => {
        const rewrites = VERCEL.rewrites;
        const at = rewrites.findIndex((r) => r.destination === '/tenant.html');
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(rewrites.findIndex((r) => r.source === '/(.*)'));
        expect(rewrites[0].source).toBe('/api/(.*)');                                   // the API is untouched
        const re = new RegExp(`^${rewrites[at].source}$`);
        for (let i = 0; i < 50; i += 1) {
            const token = newToken();
            expect(re.test(`/t/${token}`), token).toBe(true);
            expect(re.test(new URL(linkFor(token, {})).pathname)).toBe(true);
            expect(TOKEN_PATH_RE.test(`/t/${token}`)).toBe(true);
            expect(tokenFromPath(`/t/${token}/`)).toBe(token);
            expect(TOKEN_RE.test(token)).toBe(true);
        }
        for (const no of ['/t/', '/t/short', '/t/' + 'a'.repeat(17), '/t/' + 'a'.repeat(15) + '!', '/t/' + 'a'.repeat(16) + '/x', '/tt/' + 'a'.repeat(16), '/t/../etc']) {
            expect(re.test(no), no).toBe(false);
            expect(tokenFromPath(no), no).toBe('');
        }
        expect(PORTAL_PATH).toBe('/t/');
    });

    it('serves the page under a policy that refuses everything it does not need, and never caches or indexes it', () => {
        const catchAll = VERCEL.headers.findIndex((h) => h.source === '/(.*)');
        for (const source of ['/t/(.*)', '/tenant.html']) {
            const at = VERCEL.headers.findIndex((h) => h.source === source);
            expect(at, source).toBeGreaterThan(catchAll);                                // later rules win where headers collide
            const h = Object.fromEntries(VERCEL.headers[at].headers.map((x) => [x.key, x.value]));
            const csp = Object.fromEntries(h['Content-Security-Policy'].split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v.join(' ')]));
            expect(csp['default-src']).toBe("'none'");
            expect(csp['script-src']).toBe("'self'");
            expect(csp['style-src']).toBe("'self'");
            expect(csp['connect-src']).toBe("'self'");
            expect(csp['frame-ancestors']).toBe("'none'");
            expect(csp['base-uri']).toBe("'none'");
            expect(csp['form-action']).toBe("'none'");
            expect(h['Content-Security-Policy']).not.toMatch(/unsafe-|\*|https?:|data:.*script/);
            expect(h['Cache-Control']).toBe('no-store, max-age=0');
            expect(h['X-Robots-Tag']).toMatch(/noindex/);
        }
    });

    it('seals the rate-limit counters too, written out and not left to the default', () => {
        const at = RULES.indexOf('match /wf-tenant-limits/{document=**}');
        expect(at).toBeGreaterThan(0);
        expect(RULES.slice(at, at + 120)).toContain('allow read, write: if false;');
    });
});

describe('the page', () => {
    it('loads only its own two files, runs nothing inline and says what it is', () => {
        expect(HTML).toContain('<link rel="stylesheet" href="/tenant-page.css">');
        expect(HTML).toContain('<script type="module" src="/tenant-page.js"></script>');
        expect([...HTML.matchAll(/<script\b([^>]*)>/g)].every((m) => /\bsrc="\/tenant-page\.js"/.test(m[1]))).toBe(true);
        expect(HTML).not.toMatch(/\sstyle\s*=|<style\b|\son[a-z]+\s*=|javascript:|https?:\/\//i);
        expect(HTML).toContain('<meta name="referrer" content="no-referrer">');
        expect(HTML).toMatch(/<meta name="robots" content="noindex, nofollow/);
        expect(HTML).toContain('<noscript>');
        expect(HTML).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1/);
    });

    it('builds its markup with createElement and textContent only, and keeps nothing', () => {
        const src = code(PAGE);
        for (const banned of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/, /\bsetTimeout\s*\(\s*['"`]/, /localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /location\.(search|hash|href)\s*=/, /history\./, /postMessage/, /\.srcdoc/, /setAttribute\(\s*['"]style['"]/, /\.style\./, /createElement\(\s*['"]script['"]/]) {
            expect(src, String(banned)).not.toMatch(banned);
        }
    });

    it('talks to one endpoint on its own origin and imports one module', () => {
        const src = code(PAGE);
        expect(src).not.toMatch(/https?:\/\//);
        expect([...src.matchAll(/\bfetchImpl\(\s*([A-Z_]+)/g)].map((m) => m[1])).toEqual(['ENDPOINT']);
        expect(PAGE).toContain("export const ENDPOINT = '/api/tenant-portal';");
        expect([...PAGE.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])).toEqual(['./wealthflow-nic.js']);
    });

    it('loads nothing from anywhere else, and sets no inline style', () => {
        expect(CSS).not.toMatch(/@import|url\(\s*['"]?(https?:|\/\/)|expression\(/i);
        expect(CSS).toMatch(/min-height: 52px/);                                      // touch targets
        expect(CSS).toMatch(/font-size: 18px/);                                       // a phone does not zoom into the field
    });

    it('does not appear in the sitemap of anything the app precaches', () => {
        expect(read('sw.js')).not.toMatch(/tenant/);
    });

    it('is not a module the build renames: its own file names are what the page and the headers say', () => {
        expect('tenant-page.js').not.toMatch(/^wealthflow-/);
        expect('tenant-page.css').not.toMatch(/^wealthflow-/);
    });
});

describe('the owner\'s log understands the portal\'s texts', () => {
    it('lists a code that went out, and one that could not, in the words the log already uses, with no code in either', async () => {
        const { makeDb, seedTenant, gateway, codes, SECRET, NIC, T0 } = await import('./helpers/tenant-fixture.js');
        const { requestCode } = await import('../tenant-portal.mjs');
        globalThis.__WF_SMS_NO_BOOT = true;
        const { rowsOf, panelHtml } = await import('../wealthflow-sms.js');
        const docs = [];
        for (const behaviour of [undefined, () => ({ ok: false, kind: 'credit', message: 'insufficient credit', retryable: true })]) {
            const { fs, db } = makeDb();
            const token = await seedTenant(fs, db);
            await requestCode({ db, client: gateway(behaviour), token, nic: NIC, ip: 'ip', secret: SECRET, now: T0 + docs.length, random: codes('314159') });
            for (const [path, value] of fs.data.entries()) if (/^users\/owner1\/smsLog\//.test(path)) docs.push({ id: path.split('/').pop(), ...value });
        }
        expect(docs).toHaveLength(2);
        const rows = rowsOf(docs, T0);
        expect(rows.map((r) => r.label).sort()).toEqual(['Delivered', 'Failed']);
        expect(rows.find((r) => r.status === 'failed').note).toBe('insufficient credit');
        const html = panelHtml({ rows });
        expect(html).toContain('Statement portal');
        expect(html).not.toContain('314159');
    });
});
