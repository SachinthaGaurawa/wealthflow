/* =============================================================================
 * test/firebase_defer_test.js  —  issue #65
 * -----------------------------------------------------------------------------
 * "4 third-party scripts block first paint": four gstatic.com Firebase tags that
 * halted parsing until someone else's CDN answered. On a slow or filtered
 * network the app painted nothing until all four resolved.
 *
 * THE TRAP THIS FILE GUARDS
 * Adding `defer` to those tags on its own does not make the page faster — it
 * makes it dead. A deferred script executes AFTER the document is parsed, while
 * the inline block that calls firebase.initializeApp() executes DURING parsing.
 * The naive fix throws "firebase is not defined" and the owner cannot sign in to
 * his own financial app. The attribute and the init gate are one change, and a
 * future edit that reverts either half must fail here rather than in production.
 *
 * PR #67 — an autonomous agent's attempt at this same issue — was closed for
 * claiming to fix it while changing one blank line in an unrelated file, with
 * 296 lines of tests that asserted an API that does not exist. These assertions
 * are therefore deliberately about observable facts of the shipped document, and
 * the real proof is the browser sweep recorded in the PR: a full sign-in through
 * google-auth -> pin-setup -> security-question -> recovery-code -> pin-unlock
 * with 0 page errors, identical to the run before the change.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { measure, BUDGETS } from '../autonomy/perf-budget.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/**
 * index.html with HTML and JS comments stripped.
 *
 * The first draft of the two assertions below searched the raw file and failed
 * on this fix's OWN comments, which name `firebase-storage-compat.js` and
 * `firebase.storage()` while explaining why they were removed. A grep cannot
 * tell documentation from code, and the documentation is the reason the deletion
 * is reviewable. So the assertions run against what actually executes.
 */
const CODE = HTML
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

/** Every <script src=...> tag in the document, as raw text. */
const TAGS = HTML.match(/<script\b[^>]*\bsrc\s*=[^>]*>/gi) || [];
const firebaseTags = TAGS.filter((t) => /gstatic\.com\/firebasejs/.test(t));

describe('the Firebase SDK no longer blocks the first paint', () => {
    it('every remaining Firebase tag carries defer', () => {
        expect(firebaseTags.length).toBeGreaterThan(0);
        for (const t of firebaseTags) {
            expect(t, `still render-blocking: ${t}`).toMatch(/\bdefer\b/);
        }
    });

    it('no third-party script blocks the first paint at all', () => {
        const blocking = measure({ repoDir: ROOT }).renderBlockingList;
        for (const s of blocking) {
            expect(s, `third-party render-blocker: ${s}`).not.toMatch(/^https?:\/\//);
        }
    });

    it('the ratchet came down with the improvement', () => {
        // Doctrine from perf-budget.mjs: an improvement that is not ratcheted is
        // one that can be undone without anyone noticing.
        expect(BUDGETS.renderBlockingScripts).toBeLessThanOrEqual(2);
        expect(measure({ repoDir: ROOT }).renderBlockingScripts).toBeLessThanOrEqual(BUDGETS.renderBlockingScripts);
    });
});

describe('the unused storage SDK is gone, not merely deferred', () => {
    it('the tag is absent', () => {
        expect(CODE).not.toMatch(/firebase-storage-compat\.js/);
    });

    it('and it really was unused — nothing calls firebase.storage()', () => {
        // The justification for deleting rather than deferring. If a future
        // change starts using Storage, this fails and says to add the tag back.
        const strip = (src) => src
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
        const files = fs.readdirSync(ROOT).filter((f) => /\.(js|html)$/.test(f));
        for (const f of files) {
            const src = strip(fs.readFileSync(path.join(ROOT, f), 'utf8'));
            expect(src, `${f} uses firebase.storage() but the SDK is no longer loaded`)
                .not.toMatch(/firebase\s*\.\s*storage\s*\(/);
        }
    });
});

describe('the init waits for the SDK instead of assuming it', () => {
    it('initializeApp is inside a function, not straight-line parse-time code', () => {
        const i = HTML.indexOf('function _wfInitFirebase()');
        expect(i, 'the init gate is missing — deferring the tags without it breaks sign-in').toBeGreaterThan(-1);
        const init = HTML.indexOf('firebase.initializeApp(firebaseConfig);');
        expect(init).toBeGreaterThan(i);   // the call lives inside the function
    });

    it('is scheduled on DOMContentLoaded, after deferred scripts have run', () => {
        expect(HTML).toMatch(/addEventListener\('DOMContentLoaded', _wfInitFirebase\)/);
    });

    it('still works if the tags ever lose defer again', () => {
        // Belt and braces: with a blocking SDK, firebase exists at parse time and
        // the init must happen synchronously exactly as it did before.
        expect(HTML).toMatch(/if \(window\.firebase && typeof window\.firebase\.initializeApp === 'function'\) _wfInitFirebase\(\);/);
    });

    it('is idempotent — re-entry must not throw "app already exists"', () => {
        const i = HTML.indexOf('function _wfInitFirebase()');
        const body = HTML.slice(i, i + 1800);
        expect(body).toMatch(/firebase\.apps && firebase\.apps\.length/);
    });

    it('says so loudly if the SDK never arrives', () => {
        // A silent return would leave a signed-out app with no explanation —
        // the failure mode this codebase has produced too often already.
        const i = HTML.indexOf('function _wfInitFirebase()');
        expect(HTML.slice(i, i + 1800)).toMatch(/console\.error\('\[Firebase\] SDK did not load/);
    });
});

describe('the ordering assumption the fix depends on', () => {
    it('every consumer of window.db tolerates it being null', () => {
        // Deferred modules now run BEFORE the init, so they must not assume a
        // handle exists. An earlier draft tried to assert "no load-time use" with
        // /^\s*window\.db/ — which matches INDENTED lines inside function bodies
        // and flagged wealthflow-update-system.js falsely. That is the same
        // false positive that briefly fooled me while diagnosing this fix.
        //
        // The load-bearing property is not where the reference sits; it is that
        // reading it while null is survivable. Assert that directly.
        const mods = fs.readdirSync(ROOT)
            .filter((f) => /^wealthflow-.*\.js$/.test(f))
            .filter((f) => /window\.db\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
        expect(mods.length, 'no module reads window.db — retarget this test').toBeGreaterThan(0);
        for (const f of mods) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            const guarded = /window\.db\s*\|\||if\s*\(\s*!?\s*window\.db|window\.db\s*&&|typeof window\.db/.test(src);
            expect(guarded, `${f} uses window.db without guarding for null`).toBe(true);
        }
    });
});
