/* =============================================================================
 * test/e2e/cross-page-probe.mjs — which hidden pages are still being written to
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Issue #66 was "3702 DOM elements on the dashboard". Measuring the running app
 * showed the 20 hidden `.page` containers holding 661 nodes — 25.8% of the DOM,
 * and by far the most attractive thing to delete. Only one page is ever visible,
 * so detaching the rest and re-attaching on navigation looks obviously correct.
 *
 * It is not. This probe wrapped Document.prototype.getElementById,
 * querySelector and querySelectorAll, then visited every nav item, and found
 * that ALL TWENTY hidden pages are read or written while inactive — between 4
 * and 30 elements each. Detaching any of them would have made those writes hit
 * nothing: no error, no failing test, just silently stale data the next time the
 * owner navigated there.
 *
 *     SAFE to detach   : 0 nodes
 *     UNSAFE           : 661 nodes
 *
 * THE GAP THIS CLOSES
 * That change would have passed the unit suite, the multi-model consensus board,
 * conftest, and the render-blocking budget. Every gate this pipeline has judges
 * structure; none of them observes behaviour at runtime. A change that is
 * structurally sound and functionally destructive is the pipeline's remaining
 * blind spot, and this file is the first instrument that can see it.
 *
 * The evidence lived in an ephemeral scratchpad and would have died with the
 * container. It is committed here so the next investigation starts with the
 * tool rather than re-deriving it.
 *
 * USAGE
 *     node test/e2e/cross-page-probe.mjs            # human-readable table
 *     node test/e2e/cross-page-probe.mjs --json     # machine-readable
 * Exit code is 0 always: this reports, it does not gate. Turning it into a gate
 * needs a baseline to ratchet against, which is a deliberate later step.
 * ===========================================================================*/

import { bootApp } from './harness.mjs';

/**
 * Patch the DOM lookup APIs to record every hit that lands inside a `.page`
 * which is not currently `.active`.
 *
 * Exported and written as a standalone function for two reasons: Playwright
 * serialises it into the page, and the test suite calls it directly against a
 * fake DOM. An instrument nobody has tested is not evidence.
 */
export function installAccessRecorder() {
    const seen = {};
    const note = (el) => {
        try {
            if (!el || typeof el.closest !== 'function') return;
            const page = el.closest('.page');
            if (!page || !page.id) return;
            if (page.classList && page.classList.contains('active')) return;
            (seen[page.id] = seen[page.id] || {})[el.id || el.tagName.toLowerCase()] = true;
        } catch (_) { /* never let instrumentation break the app */ }
    };

    const D = Document.prototype;
    const gbi = D.getElementById, qs = D.querySelector, qsa = D.querySelectorAll;
    D.getElementById = function (id) { const el = gbi.call(this, id); note(el); return el; };
    D.querySelector = function (s) { const el = qs.call(this, s); note(el); return el; };
    D.querySelectorAll = function (s) { const r = qsa.call(this, s); for (const el of r) note(el); return r; };

    globalThis.__wfCrossPage = seen;
    return seen;
}

/** Read the recorded map plus each page's size, from inside the page. */
export function collectPageFacts() {
    const raw = {};
    for (const [pid, ids] of Object.entries(globalThis.__wfCrossPage || {})) raw[pid] = Object.keys(ids);
    const pages = [...document.querySelectorAll('.page')].map((p) => ({
        id: p.id,
        nodes: 1 + p.querySelectorAll('*').length,
        active: p.classList.contains('active'),
    }));
    return { raw, pages, total: document.querySelectorAll('*').length };
}

/**
 * Turn the raw recording into a verdict. Pure, so it can be tested without a
 * browser — this is where the safe/unsafe call is actually made.
 */
export function summarise(facts) {
    // Destructuring defaults only cover `undefined`, so an explicit null — which
    // is exactly what a failed page.evaluate() hands back — would throw here.
    // Caught by this file's own test, which is the point of testing the tool.
    const { raw = {}, pages = [], total = 0 } = facts || {};
    const rows = (pages || []).map((p) => {
        const touched = raw[p.id] || [];
        return {
            id: p.id,
            nodes: p.nodes,
            active: !!p.active,
            touchedCount: touched.length,
            touched,
            // An ACTIVE page is not a candidate either way — it is on screen.
            safeToDetach: !p.active && touched.length === 0,
        };
    }).sort((a, b) => b.nodes - a.nodes);

    const safeNodes = rows.filter((r) => r.safeToDetach).reduce((n, r) => n + r.nodes, 0);
    const unsafeNodes = rows.filter((r) => !r.active && !r.safeToDetach).reduce((n, r) => n + r.nodes, 0);

    return {
        total, rows, safeNodes, unsafeNodes,
        hiddenPages: rows.filter((r) => !r.active).length,
        verdict: safeNodes === 0
            ? 'No hidden page is safe to detach — every one is written to while inactive.'
            : `${safeNodes} node(s) across ${rows.filter((r) => r.safeToDetach).length} page(s) are never touched while hidden.`,
    };
}

/** Boot the app, instrument it, visit every nav item, and report. */
export async function probeCrossPageAccess({ repoDir = process.cwd(), headless = true, settleMs = 220 } = {}) {
    const app = await bootApp({ repoDir, headless });
    try {
        // Instrument BEFORE any navigation, or the first page's writes are missed.
        await app.page.evaluate(installAccessRecorder);

        const count = await app.page.$$eval('.nav-item', (els) => els.length);
        for (let i = 0; i < count; i++) {
            try {
                const items = await app.page.$$('.nav-item');
                if (items[i]) { await items[i].click({ timeout: 2000 }); await app.page.waitForTimeout(settleMs); }
            } catch (_) { /* a nav item that will not click is not this probe's problem */ }
        }
        await app.page.waitForTimeout(600);

        const facts = await app.page.evaluate(collectPageFacts);
        return { ...summarise(facts), navItemsVisited: count, pageErrors: app.pageErrors.slice(0, 5) };
    } finally {
        await app.close();
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const json = process.argv.includes('--json');
    const r = await probeCrossPageAccess({ repoDir: process.cwd() });
    if (json) {
        console.log(JSON.stringify(r, null, 2));
    } else {
        console.log(`\n🔍 Cross-page DOM access — ${r.total} elements, ${r.hiddenPages} hidden page(s), ${r.navItemsVisited} nav items visited\n`);
        console.log('  page                 nodes   touched while inactive');
        for (const p of r.rows) {
            const t = p.active ? '[active]' : (p.touchedCount ? `YES (${p.touchedCount} els)` : 'no');
            console.log(`  ${p.id.padEnd(20)} ${String(p.nodes).padStart(5)}   ${t}`);
        }
        console.log(`\n  safe to detach : ${r.safeNodes} nodes`);
        console.log(`  unsafe         : ${r.unsafeNodes} nodes`);
        console.log(`\n  ${r.verdict}\n`);
        if (r.pageErrors.length) console.log('  page errors during the sweep:', r.pageErrors);
    }
    process.exit(0);
}
