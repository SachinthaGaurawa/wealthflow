#!/usr/bin/env node
/* THE BROWSER CANARY: open the release that just went live in a real browser, the way a device does, before anyone is told
 * it is fine.
 *
 * WHY THIS EXISTS (and what it is not)
 * "Confirm the new version is LIVE" reads three URLs with curl. That proves the files are served; it cannot see a release whose
 * files are all there and whose app does not start (a module that throws on load, a script that 404s, a service worker that never
 * registers, an update module that is missing, which strands every device on that build because nothing can update it again).
 * Those are the failures a person meets as a blank screen.
 *
 * It is NOT Vercel Rolling Releases. Rolling Releases sends a percentage of live traffic to the new deployment first; on this
 * project both of its endpoints answer 404 (checked 2026-11-03), so the plan does not offer it. With one owner and a few devices a
 * 5% slice would be one device, not a sample. What a free tier CAN do is look at the live release with a real browser and refuse to
 * call it healthy when the app does not boot. That is this file: five measured checks, each named when it fails.
 *
 *   node autonomy/canary.mjs --base https://www.wealthflow.lk --expect 7.69.41
 *
 * Exit 0: every check passed. Exit 1: at least one failed (the failing checks are printed, and written as JSON to --out).
 * Exit 2: the browser itself could not be started; that says nothing about the release and is never reported as a pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Checks, in the order they are judged. Each one names what a person would have seen. */
export const CHECK_IDS = ['loads', 'version', 'assets', 'errors', 'update-module', 'service-worker'];

/** An uncaught error counts against the release only when it came from the release's own code.
 *  A third-party script that throws (an ad, a map, an identity widget) is not this deploy's fault. */
export function isOwnError(err, origin) {
    const stack = String((err && (err.stack || err.message)) || err || '');
    const urls = stack.match(/https?:\/\/[^\s)'"]+/g);
    if (!urls || !urls.length) return true;          // no location at all: it is ours until shown otherwise
    return urls.some((u) => u.startsWith(origin));
}

/** Turn what the browser saw into a verdict. Pure: no browser, no network, so every branch is testable. */
export function judgeCanary(o, { expect } = {}) {
    o = o || {};
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });

    add('loads', o.status === 200 && (o.bodyTextLength || 0) > 100,
        o.status === 200 ? `HTTP 200, ${o.bodyTextLength || 0} characters of text on screen` : `the app page answered HTTP ${o.status == null ? 'nothing' : o.status}`);

    if (expect) add('version', o.version === expect, o.version ? `the page runs ${o.version}, the release is ${expect}` : `the page did not say which version it runs (expected ${expect})`);
    else add('version', !!o.version, o.version ? `the page runs ${o.version}` : 'the page did not say which version it runs');

    // nothing recorded is "not measured", never "nothing wrong"
    const bad = Array.isArray(o.failedAssets) ? o.failedAssets : null;
    add('assets', !!bad && bad.length === 0, !bad ? 'file loading was not observed' : bad.length ? `${bad.length} file(s) did not load: ${bad.slice(0, 3).map((f) => `${f.url} → ${f.status}`).join('; ')}` : 'every script and stylesheet loaded');

    const errs = Array.isArray(o.pageErrors) ? o.pageErrors : null;
    add('errors', !!errs && errs.length === 0, !errs ? 'errors were not observed' : errs.length ? `${errs.length} uncaught error(s) from the app's own code: ${String(errs[0]).slice(0, 160)}` : 'no uncaught error from the app\'s own code');

    add('update-module', o.hasUpdateModule === true, o.hasUpdateModule ? 'the update system is loaded, so the next release can reach this device' : 'the update system did not load: a device on this build could not be updated again');

    add('service-worker', o.serviceWorker === true, o.serviceWorker ? 'the service worker registered' : 'no service worker registered');

    const failing = checks.filter((c) => !c.ok);
    return { ok: failing.length === 0, checks, failing: failing.map((c) => c.id) };
}

/** Open the page in a real Chromium and collect what judgeCanary needs. Throws only when the browser cannot start. */
export async function observe({ base, chromePath, timeoutMs = 45000, settleMs = 3000, swWaitMs = 15000, playwright } = {}) {
    const pw = playwright || (await import('playwright'));
    const launch = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    const exe = chromePath || process.env.WF_CHROME;
    if (exe) launch.executablePath = exe;
    const browser = await pw.chromium.launch(launch);
    try {
        const ctx = await browser.newContext({ serviceWorkers: 'allow' });
        const page = await ctx.newPage();
        const origin = new URL(base).origin;
        const o = { pageErrors: [], failedAssets: [] };
        page.on('pageerror', (e) => { if (isOwnError(e, origin)) o.pageErrors.push(String((e && e.message) || e)); });
        page.on('response', (r) => {
            try {
                const req = r.request(), type = req.resourceType();
                if (r.url().startsWith(origin) && (type === 'script' || type === 'stylesheet') && r.status() >= 400) o.failedAssets.push({ url: r.url().replace(origin, ''), status: r.status() });
            } catch (_) { /* a response we cannot describe is not evidence */ }
        });
        page.on('requestfailed', (req) => {
            try {
                const type = req.resourceType();
                if (req.url().startsWith(origin) && (type === 'script' || type === 'stylesheet')) o.failedAssets.push({ url: req.url().replace(origin, ''), status: 'failed (' + ((req.failure() && req.failure().errorText) || 'network') + ')' });
            } catch (_) { /* as above */ }
        });
        const url = base.replace(/\/+$/, '') + '/app?canary=' + Date.now();
        let resp = null;
        try { resp = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs }); } catch (e) { o.pageErrors.push('navigation: ' + String(e && e.message).slice(0, 160)); }
        o.status = resp ? resp.status() : null;
        // a page that did not even answer 200 has nothing further to measure: do not spend a minute waiting for it
        if (o.status !== 200) return o;
        try { await page.waitForFunction(() => !!window.WF_APP_VERSION, null, { timeout: Math.min(timeoutMs, 20000) }); } catch (_) { /* judged below as "did not say" */ }
        // a module that throws while the app is starting does so after `load`; give boot a moment to show its hand
        await page.waitForTimeout(settleMs);
        const seen = await page.evaluate(async (waitMs) => {
            let sw = false;
            try {
                for (let t = 0; t <= waitMs && !sw; t += 1000) {
                    sw = !!(navigator.serviceWorker && (await navigator.serviceWorker.getRegistration()));
                    if (!sw) await new Promise((r) => setTimeout(r, 1000));
                }
            } catch (_) { sw = false; }
            return {
                version: window.WF_APP_VERSION || null,
                hasUpdateModule: !!(window.wfUpdate && typeof window.wfUpdate.start === 'function'),
                bodyTextLength: ((document.body && document.body.innerText) || '').trim().length,
                serviceWorker: sw,
            };
        }, swWaitMs).catch(() => ({}));
        return { ...o, ...seen };
    } finally {
        await browser.close().catch(() => {});
    }
}

export async function runCanary(opts = {}) {
    const o = await observe(opts);
    return { observed: o, verdict: judgeCanary(o, { expect: opts.expect }) };
}

function arg(name) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : undefined; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const base = arg('base') || process.env.PUBLIC_BASE_URL || 'https://www.wealthflow.lk';
    const expect = arg('expect') || undefined;
    const out = arg('out');
    let r;
    try {
        r = await runCanary({ base, expect });
    } catch (e) {
        console.error('[canary] the browser could not be started: ' + String((e && e.message) || e).slice(0, 300));
        process.exit(2);
    }
    for (const c of r.verdict.checks) console.log(`${c.ok ? 'ok   ' : 'FAIL '} ${c.id} — ${c.detail}`);
    if (out) { try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(r, null, 2)); } catch (_) { /* the log above is the record */ } }
    console.log(r.verdict.ok ? `[canary] ${base} passed all ${r.verdict.checks.length} checks` : `[canary] ${base} FAILED: ${r.verdict.failing.join(', ')}`);
    process.exit(r.verdict.ok ? 0 : 1);
}
