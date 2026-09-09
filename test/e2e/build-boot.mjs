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
    'WFIcon', 'WFVault', 'WFLiquidity', 'WFInsights', 'WFRoute',
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
        await verifyParses({ root: dir, files: out.modules.map((f) => out.renames.get(f) || f) });

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

            /* Every module tag must be asking for a HASHED name. An unhashed one
             * means a reference the build did not rewrite, which would be served
             * — and then cached for a year under a name that says nothing about
             * its contents. */
            const unhashed = seen.scripts.filter((s) => /wealthflow-/.test(s) && !/-[0-9a-f]{8}\.m?js$/.test(s));
            if (unhashed.length) failures.push('script tags still unhashed: ' + unhashed.join(', '));

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
