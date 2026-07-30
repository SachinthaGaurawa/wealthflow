/* =============================================================================
 * autonomy/perf-budget.mjs — measure the payload, and stop it getting worse
 * ---------------------------------------------------------------------------
 * WHY A RATCHET AND NOT A TARGET
 *   WealthFlow ships a 1.5 MB index.html plus 1.2 MB across 43 modules, with no
 *   build step to split or tree-shake any of it. Those numbers are not something
 *   a single pull request can fix, and pretending otherwise by setting an
 *   aspirational budget would mean a permanently red check — which gets ignored,
 *   then removed, and then the payload grows unobserved. This project has already
 *   produced three variants of that failure.
 *
 *   So the budgets below are set AT the measured current values. They cannot fix
 *   today's weight; they make it impossible to add to it silently. Every future
 *   change has to either fit in the existing envelope or state, in a diff, that
 *   it is raising the ceiling and why. Debt that is measured and held flat is a
 *   different thing from debt that is drifting.
 *
 * WHAT IS DELIBERATELY NOT MEASURED HERE
 *   Load timings. The CI sandbox has no egress, so every third-party script fails
 *   and every network measurement taken here describes the sandbox rather than the
 *   app. A number that does not mean what its name says is worse than no number,
 *   so First Paint and friends stay out of this gate — see collectPerf() in
 *   test/e2e/ui-sweep.mjs, which gathers them clearly labelled as advisory.
 *
 *   What IS measured are the facts that predict load cost and are completely
 *   network-independent: bytes shipped, request count, and how many of those
 *   requests block the first paint.
 *
 * ZERO dependencies.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';

/**
 * Ceilings, set at the values measured on 2026-07-30. Raising one is a deliberate
 * act that belongs in a diff with a reason, which is the entire point.
 */
export const BUDGETS = {
    htmlBytes: 1_560_000,        // measured 1,544,365
    totalJsBytes: 1_250_000,     // measured 1,230,401 across 43 modules
    largestModuleBytes: 210_000, // measured 203,927 (wealthflow-ai-v4.js)
    moduleCount: 45,             // measured 43
    scriptTags: 48,              // measured 47
    renderBlockingScripts: 6,    // was 7; Chart.js deferred, so the ceiling comes down
                                 // with it. A ratchet that is not tightened after an
                                 // improvement quietly permits the improvement to be undone.
};

/** Bytes of a file, or 0 if it is not there. */
function bytes(file) {
    try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Script tags that block the first paint.
 *
 * A tag is non-blocking if it carries `defer`, `async`, or `type="module"`
 * (modules are deferred by definition). Everything else halts parsing until it
 * has been fetched and executed — and four of the six here are third-party, so
 * the first paint waits on someone else's CDN.
 */
export function renderBlocking(html) {
    const tags = String(html || '').match(/<script\b[^>]*\bsrc\s*=[^>]*>/gi) || [];
    return tags
        .filter((t) => !/\b(defer|async)\b/i.test(t) && !/type\s*=\s*["']module["']/i.test(t))
        .map((t) => (/src\s*=\s*["']([^"']+)["']/i.exec(t) || [, t.slice(0, 60)])[1]);
}

/** Measure the shipped payload. Pure reads; no network, no browser. */
export function measure({ repoDir = process.cwd() } = {}) {
    const htmlPath = path.join(repoDir, 'index.html');
    const html = (() => { try { return fs.readFileSync(htmlPath, 'utf8'); } catch { return ''; } })();

    let modules = [];
    try {
        modules = fs.readdirSync(repoDir)
            .filter((f) => /^wealthflow-.*\.js$/.test(f))
            .map((f) => ({ file: f, bytes: bytes(path.join(repoDir, f)) }))
            .sort((a, b) => b.bytes - a.bytes);
    } catch { modules = []; }

    const scriptTags = (html.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length;
    const blocking = renderBlocking(html);

    return {
        htmlBytes: bytes(htmlPath),
        totalJsBytes: modules.reduce((s, m) => s + m.bytes, 0),
        moduleCount: modules.length,
        largestModule: modules[0] || { file: '(none)', bytes: 0 },
        largestModuleBytes: modules[0] ? modules[0].bytes : 0,
        scriptTags,
        renderBlockingScripts: blocking.length,
        renderBlockingList: blocking,
        modules,
    };
}

/**
 * Compare a measurement against the ceilings.
 *
 * Takes the measurement as an argument rather than measuring internally, so the
 * gate can be tested against inflated numbers. A budget check that has only ever
 * been run against a passing input has not been shown to reject anything.
 */
export function check(m = measure()) {
    const violations = [];
    for (const [key, limit] of Object.entries(BUDGETS)) {
        const value = m[key];
        if (typeof value !== 'number') continue;
        if (value > limit) violations.push({ key, value, limit, over: value - limit });
    }
    return { ok: violations.length === 0, violations, measured: m };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if ((process.argv[1] || '').endsWith('perf-budget.mjs')) {
    const m = measure();
    const r = check(m);
    const kb = (n) => (n / 1024).toFixed(0) + ' KB';
    console.log('\n📦 WealthFlow payload\n');
    console.log(`  index.html            ${kb(m.htmlBytes).padStart(10)}   (budget ${kb(BUDGETS.htmlBytes)})`);
    console.log(`  modules (${String(m.moduleCount).padStart(2)} files)   ${kb(m.totalJsBytes).padStart(10)}   (budget ${kb(BUDGETS.totalJsBytes)})`);
    console.log(`  largest module        ${kb(m.largestModuleBytes).padStart(10)}   ${m.largestModule.file}`);
    console.log(`  script requests       ${String(m.scriptTags).padStart(10)}`);
    console.log(`  render-blocking       ${String(m.renderBlockingScripts).padStart(10)}`);
    for (const s of m.renderBlockingList) console.log(`      ⛔ ${s}`);
    console.log(`\n  total shipped         ${kb(m.htmlBytes + m.totalJsBytes).padStart(10)}\n`);
    if (r.ok) {
        console.log('✅ within budget (ceilings held at the measured baseline)\n');
    } else {
        for (const v of r.violations) console.log(`❌ ${v.key}: ${v.value} exceeds ${v.limit} by ${v.over}`);
        console.log('');
    }
    process.exit(r.ok ? 0 : 1);
}
