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
    // Raised from 1_560_000 (measured 1,544,365). Three fixes in index.html, all
    // three found by LOADING the page in a real browser at six viewports rather
    // than by reading it: the online/offline probe was fetching a Markdown link
    // and so answered "online" without ever leaving the device; DB.set — the
    // write path for every record in the app — had a bare localStorage.setItem
    // that throws QuotaExceededError on a full iOS device, taking the click
    // handler down with it and skipping the cloud push below it; and 92
    // interactive elements measured under 36 px on every phone viewport, down to
    // a 15 px auth link, which a measurement after the change returns as 0.
    // Most of the growth is the comments recording WHY, which is the part a
    // later edit must not be able to undo quietly.
    // Moves ONCE, to the newly measured value with ~1.1% headroom.
    //
    // Raised again from 1_580_000 (measured 1,562,010) for v7.53.0, the per-key
    // sync clock. The record arrays already converged across devices; every
    // other field — incomeReceived, balance, cribAnalyses, settings — was still
    // on "whatever the snapshot says, copy it over local", so one incoming
    // snapshot could erase months the user had marked received while offline and
    // set no flag that would push the survivors back. _kut gives those keys the
    // recency the records had, and plain objects now union rather than replace.
    // The +19 KB is the merge itself plus the reproduction written into the
    // comment, which is the part a later edit must not be able to undo quietly.
    // Moves ONCE, to the newly measured value with ~1.1% headroom.
    htmlBytes: 1_599_000,        // measured 1,581,386
    // Raised from 1_250_000 (measured 1,230,401 / 43 modules on 2026-07-30).
    // The ratchet did its job: it caught wealthflow-income-provenance.js, the
    // module for the accepted Income Provenance proposal (#47). That growth is
    // intended and approved, so the ceiling moves to the newly measured value
    // with the same ~1.7% headroom the original carried — it is NOT slackened
    // to buy room for future drift.
    // TIGHTENED after deleting wealthflow-import-review.js — a redundant module
    // duplicating the already-wired wealthflow-review.js. Per the doctrine at
    // the top of this file, a ratchet that is not tightened after an improvement
    // quietly permits the improvement to be undone, so the reclaimed bytes are
    // taken off the ceiling rather than left as headroom for future drift.
    // TIGHTENED again after deleting BUILTIN_NOTES from
    // wealthflow-update-system.js — 250 lines and 21.7 KB of release notes for
    // 14 versions, none newer than 7.40.0, duplicating what version.json already
    // holds. It existed only to feed a fallback that showed the wrong release's
    // notes rather than none, which is how a device running v7.69.18 displayed
    // v7.40.0's feature list. Same doctrine as every other move of this number:
    // an improvement that is not ratcheted is an improvement that can be undone
    // without anyone noticing.
    // Raised from 1_290_000 (measured 1,268,930). The ratchet fired on the
    // three-layer statement parser in wealthflow-html-statement.js: an encrypted
    // NTB / AmEx Smart Statement decrypted correctly and imported ZERO
    // transactions, because its rows are held as data inside <script> and drawn
    // by JS — DOMParser never runs scripts, so the old table-only reader saw an
    // empty shell, and htmlToText strips <script> so the text fallback was empty
    // too. Reading a statement is the feature; +9 KB buys the script-data and
    // text-line layers plus the fix for amounts being taken from the description.
    // Growth that is intended and stated in the diff is what this ceiling exists
    // to force — not to forbid. It moves ONCE, to the newly measured value with
    // the same ~1.7% headroom the original carried, and is NOT slackened to buy
    // room for future drift. About 1.9 KB of comment was moved into
    // test/estatement_parse_shapes_test.js (not shipped) before raising it.
    // Raised from 1_321_000 (measured 1,299,294). The ratchet fired on the
    // sandboxed renderer in wealthflow-html-statement.js. The three-layer parser
    // the last raise bought was reading a document that had never been rendered:
    // the field diagnostic on the real file came back "tables 2 / rows 3 /
    // date-cells 0 / money-cells 0 / scripts 14 / chars 3104263" — three million
    // characters, and three table rows between them. A Smart Statement is an
    // application; its rows are drawn by its own JavaScript on load, and no
    // amount of extra layout guessing reaches data that does not exist yet. The
    // +5 KB runs it in a frame with sandbox="allow-scripts" and an injected
    // default-src 'none' CSP, and parses the DOM that comes back. Most of the
    // growth is the block comment stating WHY the containment is shaped that
    // way, which is the part a later edit must not be able to undo quietly.
    // Moves ONCE, to the newly measured value with ~1.4% headroom — TIGHTER than
    // the ~1.7% the original carried, deliberately, because a ceiling raised to
    // cover work already done should not also buy room for work not yet started.
    totalJsBytes: 1_348_000,     // measured 1,329,833 across 46 modules
    largestModuleBytes: 210_000, // measured 203,927 (wealthflow-ai-v4.js)
    // Raised from 45 (measured 43). In #52 this ceiling was deliberately left
    // alone because it had not yet failed, on the principle that lifting a
    // ceiling still holding is pre-emptive slackening. It has now genuinely
    // fired — the Data Health and Crash Forensics modules (#53, #54) take the
    // count to 47 — so it moves, once, to the measured value.
    moduleCount: 47,             // measured 46 (tightened: one module removed)
    // Raised from 48 (measured 47). The Import Review Queue (#48) adds one
    // deferred module, and the ratchet fired on exactly the tag it added —
    // which was flagged as expected before the work started, not explained
    // away afterwards. Same +1 headroom the original carried; moduleCount is
    // deliberately NOT touched, because it did not fail and raising a ceiling
    // that is still holding is the pre-emptive slackening this file exists to
    // prevent.
    // TIGHTENED: 51 -> 50. firebase-storage-compat.js was deleted outright in
    // the #65 fix -- `firebase.storage()` appears nowhere in this repository, so
    // it was downloaded and parsed on every load for nothing.
    scriptTags: 50,              // measured 49
    // TIGHTENED: 6 -> 2, the biggest move this ceiling has made. Issue #65 was
    // "4 third-party scripts block first paint": four gstatic.com Firebase tags
    // that halted parsing until someone else's CDN answered. One was deleted as
    // unused; three now carry `defer`, paired with an init that waits for them.
    // Proven by a full browser sweep signing in through
    // google-auth -> pin-setup -> security-question -> recovery-code -> pin-unlock
    // with 0 page errors and 0 console errors, identical to the run before the
    // change. The two survivors are first-party and load from this origin.
    renderBlockingScripts: 2,    // measured 2 (wealthflow-stability.js, wealthflow-icons.js)
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
 * has been fetched and executed.
 *
 * Six tags used to qualify, four of them third-party, so the first paint waited
 * on someone else's CDN four times over — issue #65. The two survivors are
 * first-party and served from this origin; see test/firebase_defer_test.js for
 * the assertion that keeps it that way.
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
