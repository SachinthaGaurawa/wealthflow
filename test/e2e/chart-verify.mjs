// =============================================================================
// Verify the deferred Chart.js actually renders — no preview URL, no Google Auth
// =============================================================================
// WHY THIS EXISTS
// Verifying a chart change on a Vercel preview requires signing in, and Firebase
// rejects OAuth from any domain not on its Authorized Domains list. Vercel's
// preview hostname is `<project>-git-<branch>-<scope>.vercel.app`, so it CHANGES
// WITH EVERY BRANCH NAME, and Firebase has no wildcard for arbitrary subdomains.
// Whitelisting therefore has to happen per branch, forever, by hand — which is a
// process that will be skipped on exactly the busy day it matters.
//
// So this verifies the same thing without any of that. The harness already signs
// in through a test-only Firebase stub (never present in the production build),
// and it now serves the real Chart.js from node_modules because the CI sandbox
// cannot reach cdnjs but CAN reach npm.
//
// WHAT IT PROVES, precisely
//   1. The DEFERRED script still executes before the code that uses it. `defer`
//      preserves document order, and Chart.js sits above the deferred app
//      modules — but that is an argument, and this is a measurement.
//   2. The new `typeof Chart !== 'undefined'` guards do NOT wrongly skip when
//      Chart IS present. That is the actual risk the guards introduce, and it is
//      invisible in a sandbox where Chart never loads at all.
//
// WHAT IT DOES NOT PROVE
//   That Chart.js draws correct pixels. That is Chart.js's job and this change
//   does not touch it. `Chart.getChart(canvas)` returning a live instance is the
//   public API's own statement that a chart is attached and initialised.
// =============================================================================

import { bootApp } from './harness.mjs';

/** Charts that render as soon as the dashboard is shown. */
const ON_LOAD = ['dashChart', 'dashPie'];

export async function verifyCharts({ repoDir = process.cwd() } = {}) {
    const app = await bootApp({ repoDir });
    try {
        if (!app.chartServed) {
            throw new Error(
                'Chart.js is not available locally, so this would verify nothing.\n'
                + '  Run: npm install --no-save chart.js@4.4.1'
            );
        }

        // 1) the deferred script executed
        const loaded = await app.page.evaluate(() => typeof window.Chart);
        // 2) it executed BEFORE the app code that consumes it — proven by the app
        //    having got as far as attaching charts, checked below.
        const found = await app.page.evaluate((ids) => {
            const out = {};
            for (const id of ids) {
                const el = document.getElementById(id);
                let inst = null;
                try { inst = window.Chart && window.Chart.getChart ? window.Chart.getChart(id) : null; } catch { inst = null; }
                out[id] = {
                    canvasPresent: !!el,
                    chartAttached: !!inst,
                    type: inst && inst.config ? inst.config.type : null,
                    points: inst && inst.data && inst.data.datasets
                        ? inst.data.datasets.reduce((n, d) => n + ((d.data && d.data.length) || 0), 0)
                        : 0,
                };
            }
            return out;
        }, ON_LOAD);

        // Nothing may have thrown while doing it. A chart that renders but leaves an
        // uncaught error behind is not a pass.
        const failed = app.failedRequests || [];
        const chartErrors = app.pageErrors.filter((e) => /Chart/i.test(e));

        return { loaded, found, chartErrors, pageErrors: app.pageErrors.length, chartServed: app.chartServed, failedCdn: failed.filter((u) => /cdnjs/.test(u)).length };
    } finally {
        await app.close();
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if ((process.argv[1] || '').endsWith('chart-verify.mjs')) {
    const r = await verifyCharts();
    console.log('\n📈 Deferred Chart.js verification (real Chart.js, no preview URL, no Google Auth)\n');
    console.log(`   window.Chart after load : ${r.loaded}`);
    console.log(`   served from node_modules: ${r.chartServed}`);
    console.log(`   cdnjs requests that failed: ${r.failedCdn}\n`);

    let ok = r.loaded === 'function';
    for (const [id, v] of Object.entries(r.found)) {
        const good = v.canvasPresent && v.chartAttached;
        if (!good) ok = false;
        console.log(`   ${good ? '✅' : '❌'} #${id.padEnd(11)} canvas=${v.canvasPresent ? 'yes' : 'NO '}  chart=${v.chartAttached ? 'attached' : 'MISSING '}  type=${v.type || '-'}  datapoints=${v.points}`);
    }
    if (r.chartErrors.length) {
        ok = false;
        console.log('\n   ❌ Chart-related page errors:');
        r.chartErrors.forEach((e) => console.log('      ' + e));
    }
    console.log(`\n${ok
        ? '✅ deferred Chart.js loads in time and the guards do not skip when Chart is present'
        : '❌ deferral or guards are wrong — see above'}\n`);
    process.exit(ok ? 0 : 1);
}
