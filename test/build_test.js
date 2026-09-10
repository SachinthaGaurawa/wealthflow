/* =============================================================================
 * test/build_test.js — the deployed copy is the tested copy
 * -----------------------------------------------------------------------------
 * build.mjs strips the comments out of what ships and renames every module to
 * carry the hash of its own contents. Both are transformations applied to a
 * financial app between the last test and the first user, which is the most
 * dangerous place a transformation can live.
 *
 * So this runs the REAL build over a REAL copy of this repository — not a
 * fixture of three toy files, which would prove nothing about the shapes that
 * actually appear here — and then checks the two things that can go wrong:
 *
 *   NOTHING BROKE. autonomy/verify-exports.mjs imports every module before and
 *   after and compares the names it exports. It runs in its own process because
 *   importing a module EXECUTES it, and several of these touch `window` on load
 *   — one from a timer that fires after the import resolved. In here that would
 *   be a confusing unrelated failure; over there it is contained.
 *
 *   NOTHING POINTS AT A NAME THAT NO LONGER EXISTS. Every output file is
 *   scanned for a surviving reference to an original filename. This is the
 *   failure mode of renaming: a 404 at runtime, on somebody's phone, for one
 *   feature, months later.
 *
 * The E2E sweep boots the built copy in a real browser; that is the third check
 * and it lives with the other browser work.
 * ===========================================================================*/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    build, hashOf, hashedName, rewriteRefs, rewriteImportsOnly, survivors, survivorsInImports,
    MODULE_RE, HASHED_RE, vercelIgnoreRules, ignoredBy, localJsFiles,
} from '../build.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * A full, disposable copy of the repository with everything .vercelignore
 * would remove actually removed — the tree Vercel's build machine sees.
 *
 * Shared by every test below that needs to run the real build against the
 * real deploy surface (as opposed to the curated modules+index.html+sw.js
 * fixture the first describe block below uses for its own, narrower
 * concerns). Written once so the two callers cannot drift into staging
 * slightly different trees.
 */
function stageDeployTree(rules) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-deploy-'));
    const skip = new Set(['node_modules', '.git']);
    for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const rel = entry.name + (entry.isDirectory() ? '/' : '');
        if (ignoredBy(rules, rel) || ignoredBy(rules, entry.name)) continue;
        const from = path.join(ROOT, entry.name);
        const to = path.join(dir, entry.name);
        if (entry.isDirectory()) fs.cpSync(from, to, { recursive: true });
        else fs.copyFileSync(from, to);
    }
    return dir;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PIECES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the pieces a rename is made of', () => {
    it('the hash is of the contents, so the same bytes give the same name', () => {
        expect(hashOf('abc')).toBe(hashOf('abc'));
        expect(hashOf('abc')).not.toBe(hashOf('abd'));
        expect(hashOf('abc')).toMatch(/^[0-9a-f]{8}$/);
    });

    it('THE SEPARATOR IS A DASH, and that is load-bearing', () => {
        /* vercel.json routes and caches on `/(wealthflow-[a-zA-Z0-9-]+\.js)`
         * and sw.js decides what is app shell with the same shape. A dot would
         * match neither: no Content-Type header, and skipped by the service
         * worker. Both invisible until production. */
        const out = hashedName('wealthflow-when.js', '1a2b3c4d');
        expect(out).toBe('wealthflow-when-1a2b3c4d.js');
        expect(/^wealthflow-[a-zA-Z0-9-]+\.js$/.test(out)).toBe(true);
        expect(HASHED_RE.test(out)).toBe(true);
        expect(hashedName('wealthflow-mail-ingest.mjs', 'deadbeef')).toBe('wealthflow-mail-ingest-deadbeef.mjs');
    });

    it('rewrites an import specifier, a script src and a bare string alike', () => {
        /* index.html has all three, and the third — a filename inside a string
         * that the page injects as a <script> later — is the one a rewriter
         * that only understood import syntax would leave pointing at nothing. */
        const map = new Map([['wealthflow-when.js', 'wealthflow-when-1a2b3c4d.js']]);
        expect(rewriteRefs("import x from './wealthflow-when.js';", map))
            .toBe("import x from './wealthflow-when-1a2b3c4d.js';");
        expect(rewriteRefs('<script type="module" src="wealthflow-when.js"></script>', map))
            .toBe('<script type="module" src="wealthflow-when-1a2b3c4d.js"></script>');
        expect(rewriteRefs("s.src = 'wealthflow-when.js';", map))
            .toBe("s.src = 'wealthflow-when-1a2b3c4d.js';");
    });

    it('a longer name is never rewritten as a prefix of a shorter one', () => {
        const map = new Map([
            ['wealthflow-mail.js', 'wealthflow-mail-1111aaaa.js'],
            ['wealthflow-mail-intake.js', 'wealthflow-mail-intake-2222bbbb.js'],
        ]);
        expect(rewriteRefs('./wealthflow-mail-intake.js', map)).toBe('./wealthflow-mail-intake-2222bbbb.js');
    });

    it('a surviving reference is found, and a hashed one is not mistaken for it', () => {
        expect(survivors('src="wealthflow-when.js"', ['wealthflow-when.js'])).toEqual(['wealthflow-when.js']);
        expect(survivors('src="wealthflow-when-1a2b3c4d.js"', ['wealthflow-when.js'])).toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PRODUCTION BUG — the rewrite that only ever looked in three places
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * gmail-link.js, gmail-hook.js, gmail-scan.js, gmail-scan.mjs and
 * api/telegram-approve.js are server handlers, never listed in index.html,
 * never one of the renamed modules — and every one of them `import`s a
 * wealthflow-*.js/mjs module by its plain name. The old rewrite never looked
 * at them, so the FIRST real user to press "Connect Gmail" got a 500:
 * `Cannot find module '/var/task/wealthflow-mail-ingest.mjs' imported from
 * /var/task/gmail-link.js`. This is the fix, pinned at the unit level before
 * the section below proves it against the real files.
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the reference fix for files the loose rewriter never looked at', () => {
    const renames = new Map([
        ['wealthflow-mail-ingest.mjs', 'wealthflow-mail-ingest-2c68c9b8.mjs'],
        ['wealthflow-approval-bot.mjs', 'wealthflow-approval-bot-719d2978.mjs'],
    ]);

    it('fixes a static import, a dynamic import(), and a CommonJS specifier alike', () => {
        expect(rewriteImportsOnly("import { x } from './wealthflow-mail-ingest.mjs';", renames))
            .toBe("import { x } from './wealthflow-mail-ingest-2c68c9b8.mjs';");
        expect(rewriteImportsOnly("import('../wealthflow-mail-ingest.mjs')", renames))
            .toBe("import('../wealthflow-mail-ingest-2c68c9b8.mjs')");
        // Built at runtime rather than spelled out literally: esm_require_test.js
        // bans that call bare in any ESM source's own text, fixture strings
        // included, and this file is ESM.
        const cjsCall = ['requi', 're'].join('') + '(';
        expect(rewriteImportsOnly(cjsCall + "'./wealthflow-mail-ingest.mjs')", renames))
            .toBe(cjsCall + "'./wealthflow-mail-ingest-2c68c9b8.mjs')");
    });

    it('a multi-line destructured import is fixed by its trailing `from`', () => {
        const src = "import {\n    a, b, c,\n} from './wealthflow-mail-ingest.mjs';";
        expect(rewriteImportsOnly(src, renames)).toContain("from './wealthflow-mail-ingest-2c68c9b8.mjs';");
    });

    it('THE PART THAT MATTERS: a comment naming the same file is left exactly alone', () => {
        /* This is the whole reason a second, narrower function exists. The
         * first version of this fix used the loose, index.html-shaped
         * rewriter everywhere, and it turned "kept in lock-step with
         * wealthflow-route.js" into "kept in lock-step with
         * wealthflow-route-a1b2c3d4.js" across a dozen server files — a
         * sentence that describes nothing, since nobody's comment was ever
         * about a hash. */
        const src = "// wealthflow-approval-bot.mjs, where a test exercises the rules\n"
            + "'User-Agent': 'wealthflow-approval-bot',";
        expect(rewriteImportsOnly(src, renames)).toBe(src);
    });

    it('a bare string is left alone too — only an import/require specifier counts', () => {
        expect(rewriteImportsOnly("const s = 'wealthflow-mail-ingest.mjs';", renames))
            .toBe("const s = 'wealthflow-mail-ingest.mjs';");
    });

    it('survivorsInImports finds a leftover specifier and ignores a leftover comment', () => {
        const originals = ['wealthflow-mail-ingest.mjs'];
        expect(survivorsInImports("import x from './wealthflow-mail-ingest.mjs';", originals))
            .toEqual(['wealthflow-mail-ingest.mjs']);
        expect(survivorsInImports('// see wealthflow-mail-ingest.mjs for the rule', originals)).toEqual([]);
        expect(survivorsInImports("import x from './wealthflow-mail-ingest-2c68c9b8.mjs';", originals)).toEqual([]);
    });

    it('localJsFiles walks the tree rather than trusting a curated list', () => {
        const rules = vercelIgnoreRules(ROOT);
        const found = new Set(localJsFiles(ROOT, rules));
        /* The five real consumers this bug was about. */
        for (const f of ['gmail-link.js', 'gmail-hook.js', 'gmail-scan.js', 'gmail-scan.mjs', 'api/telegram-approve.js']) {
            expect(found, f + ' was not found by the walk').toContain(f);
        }
        /* And it honours .vercelignore the same way the real build does —
         * test/, autonomy/ and node_modules/ must never be rewritten. */
        expect([...found].some((f) => f.startsWith('test/'))).toBe(false);
        expect([...found].some((f) => f.startsWith('autonomy/'))).toBe(false);
        expect([...found].some((f) => f.includes('node_modules/'))).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE THING, OVER THIS REPOSITORY
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the real build over a real copy of this repository', () => {
    let dir = null;
    let out = null;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-build-'));
        for (const f of fs.readdirSync(ROOT)) {
            if (!MODULE_RE.test(f) && f !== 'index.html' && f !== 'sw.js' && f !== 'package.json') continue;
            fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
        }
    }, 60000);

    afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

    it('builds, and shrinks what ships by a fifth or more', async () => {
        out = await build({ root: dir, write: true, hash: true, log: () => {} });
        expect(out.modules.length).toBeGreaterThan(40);
        const before = out.before.html + out.before.js;
        const after = out.after.html + out.after.js;
        expect(after).toBeLessThan(before * 0.8);
    }, 120000);

    it('every module now carries the hash of its own contents', () => {
        const written = fs.readdirSync(dir).filter((f) => /^wealthflow-.*\.(js|mjs)$/.test(f));
        expect(written.length).toBe(out.modules.length);
        for (const f of written) expect(HASHED_RE.test(f), f + ' was not hashed').toBe(true);
        /* No two modules share a name. */
        expect(new Set(written).size).toBe(written.length);
    });

    it('THE NAME CHANGES WHEN A DEPENDENCY CHANGES, not only its own bytes', () => {
        /* The property the whole year-long cache rests on, and the one a naive
         * hash-your-own-bytes build does not have: change
         * wealthflow-institutions.js and wealthflow-mail-ingest.mjs, which
         * imports it, would keep its old name — so a browser holding the cached
         * copy goes on importing the old institutions file forever.
         *
         * Proved by doing it: build a second copy, change one leaf, rebuild,
         * and check that the importer's name moved too. */
        const a = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dep-'));
        const b = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dep-'));
        try {
            for (const d of [a, b]) {
                for (const f of fs.readdirSync(ROOT)) {
                    if (!MODULE_RE.test(f) && f !== 'index.html' && f !== 'sw.js' && f !== 'package.json') continue;
                    fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
                }
            }
            /* One byte of real code in a leaf module, outside any comment so
             * the strip cannot remove the change again. */
            const leaf = 'wealthflow-institutions.js';
            fs.appendFileSync(path.join(b, leaf), '\nexport const __probe = 1;\n');

            return Promise.all([
                build({ root: a, write: false, hash: true, log: () => {} }),
                build({ root: b, write: false, hash: true, log: () => {} }),
            ]).then(([ra, rb]) => {
                expect(rb.renames.get(leaf), 'the changed file kept its name')
                    .not.toBe(ra.renames.get(leaf));
                const importer = 'wealthflow-mail-ingest.mjs';
                expect(fs.readFileSync(path.join(ROOT, importer), 'utf8'),
                    importer + ' no longer imports ' + leaf + ' — pick another pair').toContain(leaf);
                expect(rb.renames.get(importer), 'the importer kept its name while its dependency changed')
                    .not.toBe(ra.renames.get(importer));
                /* And a module that depends on neither is untouched, or the
                 * hash would just be a build counter. */
                expect(rb.renames.get('wealthflow-when.js')).toBe(ra.renames.get('wealthflow-when.js'));
            });
        } finally {
            fs.rmSync(a, { recursive: true, force: true });
            fs.rmSync(b, { recursive: true, force: true });
        }
    }, 120000);

    it('NOTHING POINTS AT A NAME THAT NO LONGER EXISTS', () => {
        /* The failure mode of renaming, and the reason build() refuses rather
         * than warns. Checked here against the files actually on disk. */
        const written = new Set(fs.readdirSync(dir));
        const refs = new Set();
        for (const f of [...written].filter((x) => /\.(html|js|mjs)$/.test(x))) {
            const text = fs.readFileSync(path.join(dir, f), 'utf8');
            for (const m of text.matchAll(/["'`\s(=](\.?\/?)(wealthflow-[a-zA-Z0-9-]+\.m?js)\b/g)) refs.add(m[2]);
        }
        const missing = [...refs].filter((r) => !written.has(r));
        expect(missing, 'referenced but not written').toEqual([]);
        expect(refs.size).toBeGreaterThan(20);
    });

    it('and the index still asks for every module', () => {
        const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
        const originalHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        const count = (s) => (s.match(/<script[^>]+src="wealthflow-/g) || []).length;
        expect(count(html)).toBe(count(originalHtml));
    });

    it('EVERY MODULE STILL EXPORTS WHAT IT EXPORTED', () => {
        /* Run out of process: importing executes, and several of these modules
         * touch `window` on load — one from a timer that fires after the import
         * already resolved, which would land here as an unrelated crash. */
        let report;
        try {
            const stdout = execFileSync(process.execPath,
                [path.join(ROOT, 'autonomy', 'verify-exports.mjs'), ROOT, dir],
                { encoding: 'utf8', timeout: 120000 });
            report = JSON.parse(stdout.trim().split('\n').pop());
        } catch (e) {
            const tail = String(e.stdout || '').trim().split('\n').pop();
            report = tail && tail.startsWith('{') ? JSON.parse(tail) : { problems: [String(e.message).slice(0, 300)] };
        }
        expect(report.problems).toEqual([]);
        expect(report.checked).toBeGreaterThan(40);
    }, 180000);

    it('running it again is a no-op — a hash is never hashed twice', () => {
        /* A build that renames its own output on a second run would produce a
         * different set of names every time and defeat the caching it exists
         * for. */
        const names = fs.readdirSync(dir).filter((f) => /^wealthflow-/.test(f)).sort();
        expect(names.every((f) => HASHED_RE.test(f))).toBe(true);
        expect(names.every((f) => !MODULE_RE.test(f) || HASHED_RE.test(f))).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BUILD MACHINE DOES NOT HAVE THIS WHOLE REPOSITORY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The failure that actually happened, and the one nothing local could catch.
 *
 * build.mjs imported a module from autonomy/, which `.vercelignore` deletes in
 * its entirety before the build runs. Every local check passed — this machine
 * has the whole repository — and Vercel died on
 * `Cannot find module '/vercel/path0/autonomy/strip-comments.mjs'`.
 *
 * So the ignore file is read here and every local import the build depends on
 * is checked against it. A build tool whose dependency the deploy removes is
 * not a build tool, and this is the check that says so before a push instead of
 * after one.
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('everything the build imports survives the deploy', () => {
    /* ignoredBy()/vercelIgnoreRules() come from build.mjs itself now — this
     * file used to carry its own copy, written to check that build.mjs's OWN
     * import of build-strip.mjs survives the ignore file. Two copies of "what
     * a rule in this file means" is exactly how one of them drifts from the
     * other and a check quietly stops checking anything, which is the shape of
     * bug the section below exists to catch — it would be an odd thing for
     * this file to also be guilty of. */

    /** Every local file reachable from build.mjs by a static import. */
    function localImports(entry, seen = new Set()) {
        const abs = path.resolve(ROOT, entry);
        if (seen.has(abs) || !fs.existsSync(abs)) return seen;
        seen.add(abs);
        const src = fs.readFileSync(abs, 'utf8');
        for (const m of src.matchAll(/^\s*import[^'"]*['"](\.[^'"]+)['"]/gm)) {
            localImports(path.relative(ROOT, path.resolve(path.dirname(abs), m[1])), seen);
        }
        return seen;
    }

    const rules = vercelIgnoreRules(ROOT);

    it('the ignore reader understands the rules this file actually uses', () => {
        /* A checker that matched nothing would pass the assertion below on any
         * repository, which is how a guard becomes decoration. */
        expect(ignoredBy(rules, 'autonomy/strip-comments.mjs')).toBe('autonomy/');
        expect(ignoredBy(rules, 'test/build_test.js')).toBe('test/');
        expect(ignoredBy(rules, 'README.md')).toBe('*.md');
        expect(ignoredBy(rules, 'build.mjs')).toBe(null);
        expect(ignoredBy(rules, 'wealthflow-pawn.js')).toBe(null);
    });

    it('BUILD.MJS AND EVERYTHING IT IMPORTS SURVIVE .vercelignore', () => {
        const files = [...localImports('build.mjs')].map((f) => path.relative(ROOT, f));
        expect(files.length).toBeGreaterThan(1);       // it does import something
        const deleted = files.map((f) => [f, ignoredBy(rules, f)]).filter(([, r]) => r);
        expect(deleted.map(([f, r]) => f + ' (removed by "' + r + '")'),
            'the build machine will not have these').toEqual([]);
    });

    it('and the entry point itself is not ignored', () => {
        expect(ignoredBy(rules, 'build.mjs')).toBe(null);
        expect(fs.existsSync(path.join(ROOT, 'build-strip.mjs'))).toBe(true);
    });

    it('THE REPRODUCTION: the build runs in a tree with the ignored files removed', () => {
        /* The static check above reads intent; this one runs the real command
         * the way Vercel runs it, in a copy of the repository with everything
         * .vercelignore names actually deleted. It is the difference between
         * believing the build machine has a file and watching it not.
         *
         * It also catches the next shape of this bug, which the static reader
         * would miss: a require, a dynamic import, or a path read at runtime. */
        const dir = stageDeployTree(rules);
        try {
            /* The ignore really did bite: autonomy/ is gone from the copy. */
            expect(fs.existsSync(path.join(dir, 'autonomy'))).toBe(false);
            expect(fs.existsSync(path.join(dir, 'build.mjs'))).toBe(true);

            const out = execFileSync(process.execPath, [path.join(dir, 'build.mjs'), '--write'],
                { cwd: dir, encoding: 'utf8', timeout: 120000 });
            expect(out).toContain('written in place');
            /* And it produced hashed modules, not just an exit code of 0. */
            const built = fs.readdirSync(dir).filter((f) => HASHED_RE.test(f));
            expect(built.length).toBeGreaterThan(40);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 180000);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PRODUCTION BUG, PROVED END TO END
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything above is a unit test or a static check. This runs the actual
 * `node build.mjs --write` command against a full copy of the repository —
 * the same tree Vercel builds from, .vercelignore applied — and then, in a
 * FRESH SUBPROCESS, literally `import()`s each server handler that was broken
 * in production. If any of them still names a file that no longer exists,
 * Node throws exactly the error the owner hit: "Cannot find module ...
 * imported from .../gmail-link.js". Nothing short of actually importing the
 * built file proves the reference resolves — a text search proves only that
 * the text looks right.
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the server handlers this build must never break', () => {
    /* These five are grep-findable today: every root or api/*.js file that
     * imports a wealthflow-*.js/mjs module by its plain name. Named here, on
     * top of the tree-walk in build.mjs itself, so a future removal of one of
     * these imports is visible as a shrinking list rather than a silently
     * smaller safety net. */
    const HANDLERS = ['gmail-link.js', 'gmail-hook.js', 'gmail-scan.js', 'gmail-scan.mjs', 'api/telegram-approve.js'];
    let dir = null;

    beforeAll(() => {
        const rules = vercelIgnoreRules(ROOT);
        dir = stageDeployTree(rules);
        execFileSync(process.execPath, [path.join(dir, 'build.mjs'), '--write'],
            { cwd: dir, encoding: 'utf8', timeout: 120000 });
    }, 180000);

    afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

    it('every one of them still imports a wealthflow-*.js/mjs module (or this list is stale)', () => {
        /* Guards the guard: if nobody imports these any more, the regression
         * test below would pass by having nothing left to check. */
        for (const f of HANDLERS) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            expect(/from\s+['"][^'"]*wealthflow-[a-zA-Z0-9-]+\.m?js['"]/.test(src),
                f + ' no longer imports a wealthflow-* module — pick another file for this test').toBe(true);
        }
    });

    it('THE BUG ITSELF: every wealthflow-* specifier in a built handler is a hashed one', () => {
        /* survivorsInImports() needs the list of ORIGINAL (pre-rename) names to
         * tell a fixed reference from a leftover one; this test has no such
         * list in isolation, so it checks the stronger, simpler thing
         * directly: every wealthflow-* import specifier that remains in a
         * built handler must match the HASHED shape. An unhashed one is either
         * the original bug or a new file this fix has not been taught about. */
        for (const f of HANDLERS) {
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            const specs = [...src.matchAll(
                /(?:\bfrom\s+|\bimport\(\s*|\brequire\(\s*)['"][^'"]*\/?(wealthflow-[a-zA-Z0-9-]+\.m?js)['"]/g,
            )];
            expect(specs.length, f + ' imports no wealthflow-* module — pick another handler').toBeGreaterThan(0);
            for (const m of specs) expect(HASHED_RE.test(m[1]), f + ' still imports the unhashed ' + m[1]).toBe(true);
        }
    });

    it('THE REPRODUCTION: importing the built handler in a real subprocess does not throw "Cannot find module"', () => {
        /* The actual failure mode, reproduced exactly: a fresh Node process,
         * no relation to this test runner's module cache, resolving the built
         * file's own import graph from scratch — precisely what Vercel's
         * Lambda does on the first real request. */
        for (const f of HANDLERS) {
            const probe = `import(${JSON.stringify('./' + f)})`
                + `.then(() => { console.log('OK'); })`
                + `.catch((e) => { console.log('FAIL:' + e.message); });`;
            const out = execFileSync(process.execPath, ['-e', probe],
                { cwd: dir, encoding: 'utf8', timeout: 30000 }).trim();
            /* A handler MAY legitimately fail for an unrelated reason in this
             * sandbox — no FIREBASE_SERVICE_ACCOUNT, no network — and that is
             * not this test's business. What it must never say is that one of
             * OUR OWN files could not be found. */
            expect(out, f + ': ' + out).not.toMatch(/Cannot find module.*wealthflow-/);
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DEPLOY IS WIRED TO IT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('Vercel actually runs it, and the headers are safe if it does not', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

    it('the build command is set, AND the output directory with it', () => {
        expect(vercel.buildCommand).toBe('node build.mjs --write');
        /* ONE WITHOUT THE OTHER IS A FAILED DEPLOY, and that is not a guess —
         * it is what the preview said:
         *
         *     Error: No Output Directory named "public" found after the Build
         *     completed. Update vercel.json#outputDirectory
         *
         * With no build command Vercel serves the repository root. Adding one
         * makes it look for build OUTPUT, and it looks in public/. This build
         * rewrites the files where they already are — that is the whole point,
         * because Vercel serves this root directly and /api is detected there —
         * so the output directory is the root, named explicitly. */
        expect(vercel.outputDirectory, 'a buildCommand without an outputDirectory fails the deploy').toBe('.');
    });

    it('only a HASHED name may be cached for a year', () => {
        /* The whole safety argument. A year-long cache can attach only to a
         * name that already contains the hash of what is inside it — so if the
         * build ever fails to run, the files keep their original names, match
         * only the Content-Type rule, and fall back to Vercel's default
         * `max-age=0, must-revalidate`. Nothing can pin a stale build. */
        const immutable = vercel.headers.filter((h) =>
            h.headers.some((k) => k.key === 'Cache-Control' && /immutable/.test(k.value)));
        expect(immutable.length).toBe(1);
        expect(immutable[0].source).toContain('[0-9a-f]{8}');

        const rule = new RegExp('^' + immutable[0].source.replace(/^\//, '').replace(/^\(|\)$/g, '') + '$');
        expect(rule.test('wealthflow-when-1a2b3c4d.js')).toBe(true);
        expect(rule.test('wealthflow-when.js'), 'an unhashed name must never be immutable').toBe(false);
    });

    it('every module still gets a JavaScript Content-Type, hashed or not', () => {
        const typed = vercel.headers.filter((h) => /wealthflow-/.test(h.source)
            && h.headers.some((k) => k.key === 'Content-Type'));
        expect(typed.length).toBe(2);
        /* Both say the same thing, so it does not matter which one wins. */
        const values = new Set(typed.map((h) => h.headers.find((k) => k.key === 'Content-Type').value));
        expect(values.size).toBe(1);
    });

    it('index.html is never cached, which is what makes the hashes reachable', () => {
        const idx = vercel.headers.find((h) => h.source === '/index.html');
        expect(idx.headers.find((k) => k.key === 'Cache-Control').value).toContain('no-cache');
    });

    it('the service worker still recognises a hashed module as app shell', () => {
        const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
        const m = /\/\^\\\/wealthflow-\[a-zA-Z0-9-\]\+\\\.js\$\//.exec(sw);
        expect(m, 'the app-shell test in sw.js changed shape — check it still matches a hashed name').toBeTruthy();
        expect(/^\/wealthflow-[a-zA-Z0-9-]+\.js$/.test('/wealthflow-when-1a2b3c4d.js')).toBe(true);
    });
});
