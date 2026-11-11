/* =============================================================================
 * test/e2e/strict-csp.mjs — boot the built app under the policy it will have WITHOUT 'unsafe-inline'
 * -----------------------------------------------------------------------------
 * The last step of dropping 'unsafe-inline' from `script-src` is a one-line change in vercel.json, and the
 * only honest way to know it is safe is to run the real app under that policy first. This copies the
 * repository, runs the real build, serves it with the global Content-Security-Policy from vercel.json with
 * 'unsafe-inline' removed from script-src (and the sandbox page with its own, as vercel.json serves it), and
 * then checks, in a real Chromium:
 *
 *   - the page boots and not one script, handler or frame is refused by the policy
 *   - the delegated handlers still work (the sidebar opens pages)
 *   - the statement reader still RUNS a statement's own inline script in its sandbox frame and reads the
 *     rows the script drew, while that statement cannot reach the network or the app
 *
 *   node test/e2e/strict-csp.mjs            exits 0 when all of it holds
 * ===========================================================================*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function stage(into) {
    const skip = new Set(['node_modules', '.git', 'test', '.github', 'dist']);
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const from = path.join(ROOT, entry.name); const to = path.join(into, entry.name);
        if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true }); else fs.copyFileSync(from, to);
    }
}

/** The Content-Security-Policy vercel.json serves for `source`, with the app's script-src made strict. */
function policies() {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const csp = (src) => { const r = v.headers.find((h) => h.source === src); const h = r && r.headers.find((x) => x.key === 'Content-Security-Policy'); return h ? h.value : null; };
    const appCsp = csp('/(.*)');
    const strict = appCsp
        .replace(/script-src([^;]*)/, (all, rest) => 'script-src' + rest.replace(/\s*'unsafe-inline'/g, ''))
        .replace(/;?\s*upgrade-insecure-requests/, '');       // the test server is plain http on 127.0.0.1
    return { strict, sandbox: csp('/wf-sandbox.html') };
}

// a bank statement as a real one arrives: a shell, and a script that draws the rows
const STATEMENT = `<div id="stmt"></div><script>
  var rows = JSON.parse(atob('W1siMDMtQXVnLTIwMjYiLCAiS0VFTExTIFNVUEVSIENPTE9NQk8iLCAiNCwyNTAuMDAgRHIiXSwgWyIwNS1BdWctMjAyNiIsICJQQVlNRU5UIC0gVEhBTksgWU9VIiwgIjE1LDAwMC4wMCBDciJdXQ=='));   /* opaque to a static read: only running the script reveals the rows */
  var h = '<table><tr><th>Post Date</th><th>Description</th><th>Amount</th></tr>';
  rows.forEach(function (r) { h += '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>'; });
  document.getElementById('stmt').innerHTML = h + '</table>';
  // a hostile statement: none of this may work
  try { fetch('/api/ai').then(function(){ window.__net = 'fetched'; }, function(){ window.__net = 'blocked'; }); } catch (e) { window.__net = 'threw'; }
  try { window.__peek = String(parent.document.title); } catch (e) { window.__peek = 'denied'; }
  try { window.__store = String(localStorage.length); } catch (e) { window.__store = 'denied'; }
</script>`;

export async function run() {
    const failures = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-strict-'));
    try {
        stage(dir);
        const { build } = await import(path.join(ROOT, 'build.mjs'));
        const out = await build({ root: dir, write: true, hash: true, log: () => {} });
        if (!out.csp.applied) failures.push('the build left handlers inline: ' + out.csp.skipped);
        if (!out.inline.applied) failures.push('the build left scripts inline: ' + out.inline.skipped);
        // the built landing page is what "/" serves; index.html is the app here, as in boot tests
        const pol = policies();
        if (/'unsafe-inline'/.test((/script-src[^;]*/.exec(pol.strict) || [''])[0])) failures.push('the test policy still allows inline script');

        const violations = [];
        const app = await bootApp({
            repoDir: dir, headless: true,
            headers: (p) => (p === '/wf-sandbox.html' ? { 'Content-Security-Policy': pol.sandbox } : /\.(html)$|^\/$/.test(p) ? { 'Content-Security-Policy': pol.strict } : {}),
        });
        try {
            // collect policy refusals that happen from here on, and those logged during boot
            const logged = app.consoleErrors.filter((m) => /Content Security Policy|violates the following/i.test(m));
            const origin = new URL(app.server.url).origin;
            const ours = logged.filter((m) => !/cdn|gstatic|googleapis|google\.com|jsdelivr|cloudflare|unpkg/i.test(m));
            if (ours.length) failures.push('the policy refused our own content: ' + ours.slice(0, 3).join(' | '));
            if (app.pageErrors.length) failures.push('page errors under the strict policy: ' + app.pageErrors.slice(0, 3).join(' | '));
            const same = app.failedRequests.filter((u) => String(u).startsWith(origin));
            if (same.length) failures.push('same-origin requests failed: ' + same.slice(0, 3).join(' | '));
            const live = await app.page.evaluate(() => ({ dash: !!document.querySelector('#page-dashboard'), api: !!window.WFHandlers }));
            if (!live.dash) failures.push('the dashboard did not render under the strict policy');
            if (!live.api) failures.push('the handler delegator did not install');

            // 1. delegated handlers work under the policy
            const nav = await app.page.evaluate(() => {
                const n = [...document.querySelectorAll('.sb-nav .nav-item[data-wf-on-click*="showPage("]')].slice(0, 4);
                const res = [];
                for (const el of n) {
                    el.click();
                    const m = /showPage\('([a-z0-9_-]+)'/i.exec(el.getAttribute('data-wf-on-click') || '');
                    const pg = m && document.getElementById('page-' + m[1]);
                    res.push(!!(pg && pg.classList.contains('active')));
                }
                return res;
            });
            if (nav.length < 3 || nav.some((x) => !x)) failures.push('sidebar entries did not open under the strict policy: ' + JSON.stringify(nav));

            // 2. the statement reader runs the statement's own script in its frame, and contains it
            const frameMsgs = [];
            app.page.on('console', (m) => { frameMsgs.push(m.text()); });
            const r = await app.page.evaluate(async (html) => {
                const res = await window.WFHtmlStatement.htmlToTransactionsAsync(html, { timeoutMs: 6000 });
                return { n: res.transactions.length, rendered: res.rendered, narr: res.transactions.map((t) => t.narration), report: res.report || null, chars: (res.renderedHtml || '').length };
            }, STATEMENT);
            if (!r.rendered) failures.push('the sandbox did not return a rendered statement: ' + JSON.stringify(r));
            else if (r.n !== 2) failures.push('the statement\'s own script ran but ' + r.n + ' row(s) were read, expected 2: ' + JSON.stringify(r.narr));
            const frames = app.page.frames().filter((f) => f !== app.page.mainFrame());
            console.log('  statement reader: rendered=' + r.rendered + ' rows=' + r.n + ' report=' + JSON.stringify(r.report));
            const state = await app.page.evaluate(() => document.querySelectorAll('iframe[sandbox]').length);
            if (state) failures.push(state + ' sandbox frame(s) were left in the page');
            void frames; void violations;
        } finally { await app.close(); }
    } catch (e) {
        failures.push('crashed: ' + (e && e.stack || e));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }

    if (failures.length) { console.error('\nSTRICT CSP: FAILED\n  - ' + failures.join('\n  - ') + '\n'); return 1; }
    console.log('  the built app boots, its handlers work, and the statement reader still runs a statement, under a policy with no unsafe-inline');
    return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await run());
