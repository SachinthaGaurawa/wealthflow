/* =============================================================================
 * test/e2e/build-boot.mjs — boot the copy that will actually be deployed
 * -----------------------------------------------------------------------------
 * build.mjs strips every comment out of the shipped app and renames every module
 * to carry a hash of its contents. test/build_test.js proves the transformation
 * is faithful — same exports, no dangling references — but "the files are
 * correct" and "the app runs" are different claims, and only one of them is what
 * the owner cares about.
 *
 * So this does the whole thing: copies the repository to a scratch directory,
 * runs the real build over it, serves THAT tree, and signs in through the app's
 * own onboarding in a real Chromium. What it asserts is what a broken build
 * would actually look like from the outside:
 *
 *   • no uncaught page errors
 *   • no same-origin request that failed — a renamed module nobody rewrote a
 *     reference to is exactly a failed same-origin request
 *   • every module's global is present, so each one was fetched, parsed and run
 *   • the dashboard rendered
 *
 * Cross-origin failures are IGNORED on purpose: the sandbox has no route to
 * cdnjs, and treating "the CDN is unreachable in CI" as a build failure would
 * make this permanently red and therefore permanently ignored.
 *
 *   node test/e2e/build-boot.mjs            build a copy and boot it
 *   node test/e2e/build-boot.mjs --keep     leave the built copy behind to look at
 *
 * Exits 0 when the built app boots clean, 1 otherwise, and prints what failed.
 * ===========================================================================*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The globals each shipped module installs. If one is missing it did not run. */
const EXPECTED_GLOBALS = [
    'WFWhen', 'WFVerify', 'WFReactive', 'WFMoneyInput', 'WFPwShapes',
    'WFIcon', 'WFVault', 'WFLiquidity', 'WFInsights', 'WFRoute', 'WFSms',
];

/** Copy the files the browser is served. Not node_modules, not the tests. */
function stage(into) {
    const skip = new Set(['node_modules', '.git', 'test', '.github', 'dist']);
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const from = path.join(ROOT, entry.name);
        const to = path.join(into, entry.name);
        if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true });
        else fs.copyFileSync(from, to);
    }
}

export async function run({ keep = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-built-'));
    const failures = [];
    try {
        stage(dir);
        const { build, verifyParses } = await import(path.join(ROOT, 'build.mjs'));
        const out = await build({ root: dir, write: true, hash: true });
        await verifyParses({ root: dir, files: [...out.modules.map((f) => out.renames.get(f) || f), ...out.inline.files.map((x) => x.name)] });

        const app = await bootApp({ repoDir: dir, headless: true });
        try {
            if (app.pageErrors.length) failures.push('uncaught page errors: ' + app.pageErrors.join(' | '));

            const origin = new URL(app.server.url).origin;
            const ours = app.failedRequests.filter((u) => String(u).startsWith(origin));
            if (ours.length) failures.push('same-origin requests failed: ' + ours.join(' | '));

            const seen = await app.page.evaluate((names) => ({
                dash: !!document.querySelector('#page-dashboard'),
                missing: names.filter((n) => !window[n]),
                scripts: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')),
            }), EXPECTED_GLOBALS);

            if (!seen.dash) failures.push('the dashboard did not render');
            if (seen.missing.length) failures.push('modules did not run: ' + seen.missing.join(', '));

            /* THE HANDLERS (build.mjs step 1b). The shipped page has no inline handler left, the delegator runs
             * the same ones, and text it was not shipped is refused. Skipped only if the build left handlers inline. */
            if (out.csp && out.csp.applied) {
                const h = await app.page.evaluate(async () => {
                    const q = (sel) => document.querySelectorAll(sel).length;
                    const res = { inline: q('[onclick],[onchange],[oninput],[onerror],[onkeydown],[onsubmit]'), carriers: q('[data-wf-on-click]'), api: !!(window.WFHandlers && window.WFHandlers.shapes) };
                    // 1. a sidebar entry opens its page, as `onclick="showPage('x', this)"` did
                    const navs = [...document.querySelectorAll('.sb-nav .nav-item[data-wf-on-click*="showPage("]')];
                    res.navs = navs.length;
                    const opened = [];
                    for (const n of navs.slice(0, 6)) {
                        n.click();
                        const m = /showPage\('([a-z0-9_-]+)'/i.exec(n.getAttribute('data-wf-on-click') || '');
                        const pg = m && document.getElementById('page-' + m[1]);
                        opened.push(!!(pg && pg.classList.contains('active')));
                    }
                    res.opened = opened;
                    // 2. a modal opens and closes through openModal(...) / closeModal(...)
                    const op = document.querySelector('[data-wf-on-click^="openModal(\'mdExpense\')"], [data-wf-on-click^="openModal(\'mdIncome\')"]');
                    if (op) {
                        const id = /openModal\('([A-Za-z]+)'/.exec(op.getAttribute('data-wf-on-click'))[1];
                        op.click();
                        const el = document.getElementById(id);
                        res.modalOpen = !!(el && (el.classList.contains('open') || el.classList.contains('show') || el.classList.contains('active') || getComputedStyle(el).display !== 'none'));
                        const cl = el && el.querySelector('[data-wf-on-click^="closeModal("]');
                        if (cl) cl.click();
                        res.modalClosed = !!(el && !(el.classList.contains('open') || el.classList.contains('show') || el.classList.contains('active')));
                    }
                    // 2b. every handler on every screen just visited is a shipped shape whose names exist on window (nothing is run)
                    const allNavs = [...document.querySelectorAll('.sb-nav .nav-item[data-wf-on-click*="showPage("]')];
                    for (const n of allNavs) n.click();
                    const known = new Set(['document', 'window', 'parseInt', 'parseFloat', 'Math', 'Number', 'String', 'JSON', 'Date', 'setTimeout', 'navigator', 'location', 'history', 'console']);
                    res.checked = 0; res.notShipped = []; res.missingNames = [];
                    for (const el of document.querySelectorAll('*')) {
                        for (const a of el.attributes) {
                            if (!a.name.startsWith('data-wf-on-')) continue;
                            res.checked += 1;
                            if (!window.WFHandlers.allowed(a.value)) { res.notShipped.push(a.value.slice(0, 60)); continue; }
                            for (const r of window.WFHandlers.roots(a.value)) if (!known.has(r) && !(r in window)) res.missingNames.push(r + ' in ' + a.value.slice(0, 50));
                        }
                    }
                    // 3. text that was not shipped is refused, and does nothing
                    window.__wfInjected = 0;
                    const evil = document.createElement('div');
                    evil.setAttribute('data-wf-on-click', 'window.__wfInjected = 1');
                    document.body.appendChild(evil);
                    evil.click();
                    res.injected = window.__wfInjected;
                    evil.remove();
                    return res;
                });
                if (h.inline) failures.push('the built page still has ' + h.inline + ' inline handler attribute(s)');
                if (!h.api) failures.push('wealthflow-handlers.js did not install (no window.WFHandlers)');
                if (h.carriers < 50) failures.push('only ' + h.carriers + ' elements carry a handler: the rename did not happen');
                if (h.navs < 3 || h.opened.some((x) => !x)) failures.push('sidebar entries did not open their pages through the delegator: ' + JSON.stringify(h.opened));
                if (h.modalOpen === false || h.modalClosed === false) failures.push('a modal did not open and close through the delegator: ' + JSON.stringify({ open: h.modalOpen, closed: h.modalClosed }));
                if (h.notShipped.length) failures.push(h.notShipped.length + ' rendered handler(s) have a shape that was not shipped, e.g. ' + h.notShipped.slice(0, 3).join(' | '));
                if (h.missingNames.length) failures.push('rendered handlers name something not on window: ' + [...new Set(h.missingNames)].slice(0, 6).join(' | '));
                if (h.checked < 100) failures.push('only ' + h.checked + ' rendered handlers were checked');
                if (h.injected) failures.push('a handler that was not shipped RAN (the shape check is not working)');
                console.log('  handlers: ' + h.carriers + ' elements carry one, ' + out.csp.shapes + ' shapes allowed, ' + h.checked + ' rendered ones verified, ' + h.navs + ' nav entries opened pages, foreign text refused');
            } else console.log('  handlers left inline: ' + (out.csp && out.csp.skipped));

            /* INLINE SCRIPTS (build.mjs step 3a). No shipped page carries an inline script body, the app still booted
             * with them as files (the dashboard rendered and every module ran above), and every page that had one now points at a file
             * that exists. Skipped only if the build left them inline. */
            if (out.inline && out.inline.applied) {
                const { inlineScriptsLeft } = await import(path.join(ROOT, 'wf-inline-extract.mjs'));
                const pages = ['index.html', 'landing.html', 'share-target.html', '404.html', 'privacy.html', 'terms.html'];
                for (const f of pages) {
                    const text = fs.readFileSync(path.join(dir, f), 'utf8');
                    const left = inlineScriptsLeft(text);
                    if (left.length) failures.push(f + ' still has ' + left.length + ' inline script(s): ' + left[0]);
                    for (const m of text.matchAll(/src="\/(wealthflow-inline-[A-Za-z0-9-]+\.js)"/g)) {
                        if (!fs.existsSync(path.join(dir, m[1]))) failures.push(f + ' loads ' + m[1] + ' which was not written');
                    }
                }
                const live = await app.page.evaluate(() => [...document.scripts].filter((s) => !s.src && s.textContent.trim() && (!s.type || /javascript/.test(s.type))).length);
                if (live) failures.push('the booted page has ' + live + ' inline script element(s)');
                if (out.inline.files.length < 5) failures.push('only ' + out.inline.files.length + ' inline script files were made');
                console.log('  inline scripts: ' + out.inline.files.length + ' files, no page carries one');
            } else console.log('  inline scripts left inline: ' + (out.inline && out.inline.skipped));

            /* Every module tag must be asking for a HASHED name. An unhashed one
             * means a reference the build did not rewrite, which would be served
             * — and then cached for a year under a name that says nothing about
             * its contents. */
            const unhashed = seen.scripts.filter((s) => /wealthflow-/.test(s) && !/-[0-9a-f]{8}\.m?js$/.test(s));
            if (unhashed.length) failures.push('script tags still unhashed: ' + unhashed.join(', '));

            /* The tenant statement page is a second entry point with its own script, which imports a RENAMED module. It is not listed in
             * index.html, so nothing above would notice a build that left its import pointing at a name that no longer exists. */
            {
                const tp = await app.browser.newPage();
                const tpErrors = [];
                const tpFailed = [];
                tp.on('pageerror', (e) => tpErrors.push(String((e && e.message) || e).slice(0, 200)));
                tp.on('requestfailed', (r) => tpFailed.push(r.url()));
                const link = '/t/AbCdEfGhIjKlMnOp';
                await tp.route('**' + link, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(dir, 'tenant.html'), 'utf8') }));
                await tp.route('**/api/tenant-portal', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'no session' }) }));
                await tp.goto(origin + link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const form = await tp.waitForSelector('#tp-nic', { timeout: 15000 }).then(() => true, () => false);
                const src = fs.readFileSync(path.join(dir, 'tenant-page.js'), 'utf8');
                const imported = /from\s*['"]\.\/(wealthflow-nic-[0-9a-f]{8}\.js)['"]/.exec(src);
                await tp.close();
                if (!form) failures.push('the built tenant page did not render its form');
                if (!imported) failures.push('the built tenant page still imports an unhashed module');
                else if (!fs.existsSync(path.join(dir, imported[1]))) failures.push('the built tenant page imports a file that does not exist: ' + imported[1]);
                if (tpErrors.length) failures.push('tenant page errors: ' + tpErrors.join(' | '));
                if (tpFailed.filter((u) => String(u).startsWith(origin)).length) failures.push('tenant page requests failed: ' + tpFailed.join(' | '));
                console.log('  built tenant page rendered its form, importing ' + (imported ? imported[1] : 'nothing'));
            }

            console.log('  built app booted: ' + seen.scripts.length + ' script tags, '
                + (EXPECTED_GLOBALS.length - seen.missing.length) + '/' + EXPECTED_GLOBALS.length + ' modules live');
        } finally {
            await app.close();
        }
    } catch (e) {
        failures.push(String((e && e.message) || e));
    } finally {
        if (keep) console.log('  built copy left at ' + dir);
        else fs.rmSync(dir, { recursive: true, force: true });
    }
    return failures;
}

if (process.argv[1] && process.argv[1].endsWith('build-boot.mjs')) {
    const failures = await run({ keep: process.argv.includes('--keep') });
    if (failures.length) {
        console.error('\nthe built app does not boot:\n  ' + failures.join('\n  ') + '\n');
        process.exit(1);
    }
    console.log('  the deployed copy boots clean\n');
    process.exit(0);
}
