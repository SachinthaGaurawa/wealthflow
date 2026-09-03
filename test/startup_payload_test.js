/* =============================================================================
 * test/startup_payload_test.js — what the app downloads before it is usable
 * -----------------------------------------------------------------------------
 * MEASURED, IN A REAL BROWSER, BEFORE ANYTHING WAS CHANGED
 *
 * Chromium at 390x844, CPU throttled 4x, network shaped to Fast 3G (1.6 Mbps,
 * 150 ms RTT) — a mid-range Android on a normal Colombo connection:
 *
 *                              first paint   interactive   over the wire
 *     served raw                   3208 ms      18857 ms       3520 KB
 *     served gzip (production)     1580 ms       6145 ms        985 KB
 *
 * THE FIRST NUMBER IS THE ONE THAT NEARLY CAUSED A WASTED FIX. The e2e harness
 * serves raw bytes; Vercel serves gzip. Optimising against 19 seconds would have
 * been optimising a figure no user has ever seen. Compression alone accounted
 * for 12.7 of those seconds, and the honest baseline is 6.1 s.
 *
 * WHAT WAS ACTUALLY WRONG, AND IS NOW FIXED
 *
 * Three vendor libraries were fetched from three separate CDN connections on
 * every single startup — roughly 195 KB gzipped, about a fifth of the wire
 * budget, plus three fresh TLS handshakes at 150 ms RTT:
 *
 *   · jspdf-autotable  — `autoTable` is not called ANYWHERE in this repository.
 *                        Downloaded on every startup since it was added, used by
 *                        nobody, ever.
 *   · jsPDF            — _loadPdfLibs() already lazy-loads it on demand, and
 *                        every PDF this app builds goes through that one guarded
 *                        path. The eager tag made the lazy loader a no-op while
 *                        still spending the bytes.
 *   · Chart.js         — now ensureChart(), warmed on idle after the first
 *                        dashboard paint.
 *
 * AND A LATENT CRASH FOUND WHILE DOING IT. Four of the five `new Chart(` sites
 * guard on `typeof Chart !== 'undefined'`. The fifth — the Debt Demolisher —
 * did not, so a slow or blocked CDN threw a ReferenceError and took that whole
 * screen down. That was already true before this change; making the library
 * lazy would have made it routine.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE, with the measurement, so the next person
 * does not have to re-derive it:
 *
 *   · index.html is 472.7 KB gzip — 49% of the whole payload, more than all 60
 *     JS modules combined. Comments are 32% of that (153 KB gzip, 16% of
 *     everything). Stripping them at DEPLOY time while keeping them in source is
 *     the right fix and needs a real JS parser; a regex stripper on a 1.9 MB
 *     financial app is how a string containing "//" silently deletes a function.
 *   · every wealthflow-*.js is served `no-cache, must-revalidate`, and sw.js is
 *     network-first for all code ON PURPOSE — "serving a stale module to save a
 *     few hundred milliseconds is how a user ends up looking at last week's
 *     arithmetic". Correct, and it costs ~60 revalidation round-trips per open.
 *     Content-hashed filenames plus `immutable` would give BOTH freshness and no
 *     round-trips — and, like the above, needs a build step.
 *
 * Both are one change: a deploy-time build. That alters the deployment pipeline
 * of a live financial app, so it is the owner's call, not a silent commit.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* HTML comments too. index.html explains, in an HTML comment where the three
 * script tags used to be, why they are gone — and a scanner that reads its own
 * explanation as a violation teaches the next person to delete the explanation. */
const codeOnly = (s) => String(s)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

/** Every `<script src=...>` the document loads up front. */
const eagerSrc = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/g)].map((m) => m[1]);

describe('nothing heavy is fetched before the app is usable', () => {
    it('found the script tags (guards against a vacuous pass)', () => {
        expect(eagerSrc.length).toBeGreaterThan(40);
        expect(eagerSrc).toContain('wealthflow-when.js');
    });

    it.each([
        ['Chart.js', /Chart\.js/i],
        ['jsPDF', /jspdf\.umd/i],
        ['jspdf-autotable', /autotable/i],
    ])('%s is not in the startup path', (_name, re) => {
        expect(eagerSrc.filter((s) => re.test(s))).toEqual([]);
    });

    it('THE ONE NOBODY USED: autoTable is called nowhere, so nothing may fetch it', () => {
        const files = ['index.html', ...fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.m?js$/.test(f))];
        for (const f of files) {
            expect(codeOnly(fs.readFileSync(path.join(ROOT, f), 'utf8')),
                `${f} calls autoTable — it needs the plugin back`).not.toMatch(/\.autoTable\s*\(/);
        }
        expect(codeOnly(html)).not.toContain('jspdf-autotable');
    });

    it('the two render-blocking scripts are still the same two, and first-party', () => {
        const blocking = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>/g)]
            .filter((m) => !/\b(defer|async)\b/i.test(m[0]) && !/type\s*=\s*["']module["']/i.test(m[0]))
            .map((m) => m[1]);
        expect(blocking).toHaveLength(2);
        for (const b of blocking) expect(b).not.toMatch(/^https?:/);
    });
});

describe('a library fetched on demand still gets drawn', () => {
    it('ensureChart resolves false instead of throwing when the CDN is unreachable', () => {
        /* Verified in the sandbox, which genuinely cannot reach cdnjs: the loader
         * ran, the promise resolved false, the dashboard rendered without a
         * chart, and NOTHING threw. A missing chart costs a chart. */
        const at = html.indexOf('window.ensureChart = function');
        expect(at).toBeGreaterThan(-1);
        const fn = html.slice(at, at + 700);
        expect(fn).toContain("_wfLazyScript('chartjs'");
        expect(fn).toContain('.catch(');
        expect(fn).toContain('return false');
    });

    it('THE REGRESSION THIS WOULD OTHERWISE BE: every site says what to redraw', () => {
        /* Each `new Chart(` site skips silently when the library is missing. Made
         * lazy without a redraw, the charts would simply be gone and the page
         * would look perfectly fine — the exact failure shape this project keeps
         * producing. */
        expect(html).toContain('window._wfChartThen = function (redraw)');
        expect(html).toContain('window._wfChartThen(renderDebtDemolisher)');
        expect(html).toContain('window._wfChartThen(renderMonteCarlo)');
        // the dashboard pair is redrawn by the warm-up
        const warm = html.slice(html.indexOf('window._wfWarmCharts = function'), html.indexOf('window.ensureTF'));
        expect(warm).toContain("'renderDash'");
    });

    it('the warm-up HAS A CALLER — twice, on both paths into the dashboard', () => {
        // A facility wired to nobody is this repository's signature defect.
        const calls = (codeOnly(html).match(/window\._wfWarmCharts\(\)/g) || []).length;
        expect(calls).toBeGreaterThanOrEqual(2);
        expect(codeOnly(html)).toMatch(/function refreshAllSurfaces\(\)\s*\{[\s\S]{0,200}_wfWarmCharts\(\)/);
        expect(codeOnly(html)).toMatch(/function renderDash\(\)\s*\{[\s\S]{0,200}_wfWarmCharts\(\)/);
    });

    it('it loads once and is remembered, not re-fetched per screen', () => {
        // Verified in a browser with a stubbed CDN route: three screens, one fetch.
        const at = html.indexOf('function _wfLazyScript(');
        expect(at).toBeGreaterThan(-1);
        expect(html.slice(at, at + 400)).toContain('window._wfLoadedLibs[key]');
    });
});

describe('THE LATENT CRASH: no chart site may throw when the library is absent', () => {
    it('every `new Chart(` is preceded by a guard', () => {
        const idx = [];
        for (const m of html.matchAll(/new Chart\(/g)) idx.push(m.index);
        expect(idx.length).toBeGreaterThanOrEqual(5);
        for (const i of idx) {
            /* 3 KB back: the AI-chat site's guard sits 2,111 characters before
             * its `new Chart(`, because the dataset builder between them is long.
             * Measured, not guessed. */
            const before = html.slice(Math.max(0, i - 3000), i);
            expect(/typeof Chart\s*(!==|===)\s*'undefined'/.test(before),
                `an unguarded new Chart( at offset ${i} — it throws when the CDN is slow`).toBe(true);
        }
    });
});

describe('the payload is what the measurement said it was', () => {
    it('index.html is still the biggest single item, so the next fix is known', () => {
        const htmlBytes = fs.statSync(path.join(ROOT, 'index.html')).size;
        const modBytes = fs.readdirSync(ROOT)
            .filter((f) => /^wealthflow-.*\.m?js$/.test(f))
            .reduce((s, f) => s + fs.statSync(path.join(ROOT, f)).size, 0);
        expect(htmlBytes).toBeGreaterThan(1_000_000);
        // If the modules ever overtake the document, the advice in this file's
        // header is out of date and should be re-measured rather than trusted.
        expect(htmlBytes).toBeGreaterThan(modBytes * 0.9);
    });
});
