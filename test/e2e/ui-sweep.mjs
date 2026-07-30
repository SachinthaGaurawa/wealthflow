#!/usr/bin/env node
/* =============================================================================
 * test/e2e/ui-sweep.mjs — check the UI that actually rendered
 * ---------------------------------------------------------------------------
 * WHY A BROWSER AND NOT A GREP
 *   The first static sweep of index.html produced 21 findings, of which about
 *   17 were false. Both causes are structural, not fixable by a better regex:
 *
 *     • ids created at runtime (`el.id = 'wfDriveBrowser'`) look "missing"
 *     • mutually exclusive template branches look like duplicate ids — the two
 *       `id="ot_fee_override"` inputs have a literal `} else {` between them
 *
 *   A parser cannot know which branch rendered. The DOM does not have to know:
 *   it only contains what is really there. Every check below therefore runs
 *   against a live, signed-in page.
 *
 * THE BAR FOR REPORTING SOMETHING
 *   A finding must be something a user could hit. "Could be cleaner" is not a
 *   finding. Each one carries the element that proves it, so the fix agent gets
 *   evidence instead of an opinion — and so a human can dismiss it in seconds if
 *   it is wrong.
 *
 * WHAT IS DELIBERATELY IGNORED
 *   Network failures to external hosts. The CI sandbox has no egress, so fonts
 *   and CDNs fail with ERR_TUNNEL_CONNECTION_FAILED on every run. Reporting
 *   those would bury the real findings under environmental noise that says
 *   nothing about the application.
 *
 * USAGE
 *   node test/e2e/ui-sweep.mjs           human-readable
 *   node test/e2e/ui-sweep.mjs --json    machine-readable, for discover.mjs
 * ===========================================================================*/

import { bootApp } from './harness.mjs';

/** Console noise caused by the sandbox having no outbound network. */
const ENV_NOISE = /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|net::ERR_FAILED|Failed to load resource/i;

/**
 * Everything below runs INSIDE the page. It must be self-contained — no
 * closures over node scope — because it is serialised across the bridge.
 */
function collectDom() {
    const visible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        return el.offsetParent !== null || s.position === 'fixed';
    };
    const describe = (el) => {
        const id = el.id ? `#${el.id}` : '';
        const cls = (el.className && typeof el.className === 'string')
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
    };

    const out = { brokenHandlers: [], duplicateIds: [], deadAnchors: [], unlabelledControls: [], stats: {} };

    // ── 1. handlers that reference a function which does not exist ──────────
    // THE headline check: a button whose onclick names an undefined function is
    // a button that throws when clicked. Only bare `name(` calls are examined;
    // `obj.method()` needs the object resolved and is left alone rather than
    // guessed at.
    const handlerAttrs = ['onclick', 'onchange', 'oninput', 'onsubmit'];
    for (const el of document.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]')) {
        for (const attr of handlerAttrs) {
            const code = el.getAttribute(attr);
            if (!code) continue;
            for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
                const name = m[2];
                if (['if', 'for', 'while', 'switch', 'return', 'typeof', 'new', 'function', 'catch', 'void', 'this'].includes(name)) continue;
                // Resolve the name the way an inline handler does: through the
                // GLOBAL LEXICAL SCOPE, not `window`.
                //
                // `typeof window[name]` is the obvious test and it is wrong. A
                // top-level `const $ = id => document.getElementById(id)` in a
                // classic <script> creates a global binding that is NOT a
                // property of window — `window.$` is undefined while `$` is a
                // function. Checking window flagged six working buttons
                // (`$('dscrSysIncome')…`) as broken. Verified in-page:
                //   window.$ -> "undefined",  new Function('return typeof $')() -> "function"
                let exists = false;
                try { exists = new Function(`return typeof ${name}`)() === 'function'; } catch (e) { exists = false; }
                if (!exists) {
                    out.brokenHandlers.push({
                        fn: name, attr, element: describe(el), visible: visible(el),
                        snippet: code.slice(0, 90),
                    });
                }
            }
        }
    }

    // ── 2. ids duplicated in the LIVE dom ───────────────────────────────────
    // Unlike the static scan, a duplicate here is real: both elements exist at
    // once, so getElementById silently returns only the first.
    const byId = new Map();
    for (const el of document.querySelectorAll('[id]')) {
        if (!el.id) continue;
        if (!byId.has(el.id)) byId.set(el.id, []);
        byId.get(el.id).push(el);
    }
    for (const [id, els] of byId) {
        if (els.length > 1) {
            out.duplicateIds.push({
                id, count: els.length,
                anyVisible: els.some(visible),
                elements: els.slice(0, 3).map(describe),
            });
        }
    }

    // ── 3. in-page links pointing at nothing ────────────────────────────────
    for (const a of document.querySelectorAll('a[href^="#"]')) {
        const target = a.getAttribute('href').slice(1);
        if (!target || target === '!') continue;
        if (!document.getElementById(target) && !document.getElementsByName(target).length) {
            out.deadAnchors.push({ href: `#${target}`, element: describe(a), visible: visible(a) });
        }
    }

    // ── 4. controls a screen reader cannot name ─────────────────────────────
    // Only VISIBLE controls count: a hidden template button nobody can focus is
    // not an accessibility defect worth a human's attention.
    for (const el of document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')) {
        if (!visible(el)) continue;
        const name = (el.getAttribute('aria-label') || el.getAttribute('title')
            || el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
        if (!name) out.unlabelledControls.push({ element: describe(el), html: el.outerHTML.slice(0, 120) });
    }

    out.stats = {
        totalElements: document.querySelectorAll('*').length,
        totalButtons: document.querySelectorAll('button').length,
        visibleButtons: [...document.querySelectorAll('button')].filter(visible).length,
        totalIds: byId.size,
        handlersScanned: document.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]').length,
    };
    return out;
}


/**
 * Performance facts that do not depend on the machine running the sweep.
 *
 * WALL-CLOCK TIMINGS ARE DELIBERATELY NOT REPORTED. This sandbox has no egress,
 * so every CDN request times out and domContentLoaded lands around 2.3s here
 * while being far faster in production. Filing that would be reporting the CI
 * environment, not the app — the same mistake as reporting "Chart is not
 * defined" when cdnjs is simply unreachable. Timings are collected for context
 * and clearly marked advisory; only structural facts become findings.
 */
function collectPerf() {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const scripts = [...document.querySelectorAll('script[src]')];
    // A classic <script src> with neither defer nor async blocks the parser.
    const blocking = scripts.filter((s) => !s.defer && !s.async && (s.type || '') !== 'module');
    const external = blocking.filter((s) => /^(https?:)?\/\//i.test(s.getAttribute('src') || ''));
    let maxDepth = 0;
    const walk = (el, d) => { if (d > maxDepth) maxDepth = d; for (const c of el.children) walk(c, d + 1); };
    try { walk(document.body, 0); } catch { /* pathological DOM */ }
    return {
        domElements: document.querySelectorAll('*').length,
        maxDomDepth: maxDepth,
        scriptsTotal: scripts.length,
        renderBlocking: blocking.map((s) => s.getAttribute('src')).filter(Boolean),
        renderBlockingExternal: external.map((s) => s.getAttribute('src')).filter(Boolean),
        advisoryTimings: {
            domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
            loadEventMs: Math.round(nav.loadEventEnd || 0),
            note: 'advisory only — this sandbox has no network, so these are not app-representative',
        },
    };
}

/** Walk the sidebar so the sweep sees more than the landing view. */
async function visitSections(page) {
    const visited = [];
    const targets = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.sb-item, [onclick*="nav("], [onclick*="showPage"], [data-page]')];
        return items
            .filter((el) => el.offsetParent !== null)
            .map((el, i) => ({ i, label: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) }))
            .slice(0, 20);
    });
    for (const t of targets) {
        try {
            await page.evaluate((idx) => {
                const items = [...document.querySelectorAll('.sb-item, [onclick*="nav("], [onclick*="showPage"], [data-page]')]
                    .filter((el) => el.offsetParent !== null);
                if (items[idx]) items[idx].click();
            }, t.i);
            await page.waitForTimeout(350);
            visited.push(t.label);
        } catch { /* a section that refuses to open is caught by the error listener */ }
    }
    return visited;
}

/**
 * Was this page error caused by a third-party script that never loaded?
 *
 * The CI sandbox has no egress, so `<script src="https://cdnjs…/chart.umd.min.js">`
 * fails and the app throws `Chart is not defined` on every run. That says
 * nothing about the code — reporting it would train the reader to ignore the
 * "uncaught page errors" line, which is the one line that must stay meaningful.
 *
 * Only `<Name> is not defined` errors are excused, and only when a remote script
 * whose URL mentions that name actually failed. A genuine typo'd identifier is
 * still reported, because no failed request will match it.
 */
export function isMissingVendorGlobal(message, failedUrls) {
    const m = /^(?:Uncaught )?ReferenceError: (\w+) is not defined/.exec(message)
        || /^(\w+) is not defined/.exec(message);
    if (!m) return false;
    const name = m[1].toLowerCase();
    return failedUrls.some((u) => u.toLowerCase().includes(name));
}

export async function runSweep({ repoDir = process.cwd() } = {}) {
    const app = await bootApp({ repoDir });
    try {
        if (!app.gates.includes('pin-unlock') && !app.gates.includes('google-auth')) {
            throw new Error(`onboarding did not complete; gates=${JSON.stringify(app.gates)}`);
        }
        const sections = await visitSections(app.page);
        const dom = await app.page.evaluate(collectDom);
        const perf = await app.page.evaluate(collectPerf);
        const realConsoleErrors = app.consoleErrors.filter((e) => !ENV_NOISE.test(e));
        const failed = app.failedRequests || [];
        const realPageErrors = app.pageErrors.filter((e) => !isMissingVendorGlobal(e, failed));
        const vendorGlobals = app.pageErrors.filter((e) => isMissingVendorGlobal(e, failed));
        return {
            gates: app.gates,
            sections,
            ...dom,
            perf,
            pageErrors: realPageErrors,
            consoleErrors: realConsoleErrors,
            offlineVendorErrors: vendorGlobals,
            suppressedEnvErrors: (app.consoleErrors.length - realConsoleErrors.length) + vendorGlobals.length,
        };
    } finally {
        await app.close();
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if ((process.argv[1] || '').endsWith('ui-sweep.mjs')) {
    const r = await runSweep();
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(r, null, 2));
    } else {
        console.log(`\n🖥️  Runtime UI sweep — signed in through: ${r.gates.join(' → ')}`);
        console.log(`   sections visited : ${r.sections.length}`);
        console.log(`   DOM              : ${r.stats.totalElements} elements, ${r.stats.visibleButtons}/${r.stats.totalButtons} buttons visible, ${r.stats.handlersScanned} inline handlers`);
        console.log(`   env noise hidden : ${r.suppressedEnvErrors} offline-sandbox console errors\n`);
        const section = (title, rows, fmt) => {
            console.log(`${rows.length ? '❌' : '✅'} ${title}: ${rows.length}`);
            rows.slice(0, 10).forEach((x) => console.log('     ' + fmt(x)));
        };
        section('handlers calling an undefined function', r.brokenHandlers, (x) => `${x.fn}()  on ${x.element}${x.visible ? '  [VISIBLE]' : ''}`);
        section('ids duplicated in the live DOM', r.duplicateIds, (x) => `#${x.id} ×${x.count}${x.anyVisible ? '  [VISIBLE]' : ''}`);
        section('dead in-page links', r.deadAnchors, (x) => `${x.href}  on ${x.element}`);
        section('visible controls with no accessible name', r.unlabelledControls, (x) => x.element);
        section('uncaught page errors', r.pageErrors, (x) => x);
        if (r.offlineVendorErrors.length) {
            console.log(`⚪ third-party globals missing because the sandbox is offline (not app defects): ${r.offlineVendorErrors.length}`);
            r.offlineVendorErrors.slice(0, 5).forEach((x) => console.log('     ' + x));
        }
        section('application console errors', r.consoleErrors, (x) => x);
    }
    process.exit(0);
}
