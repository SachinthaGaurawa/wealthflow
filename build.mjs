/* =============================================================================
 * build.mjs — the copy that ships is not the copy that is read
 * -----------------------------------------------------------------------------
 * WHAT THE OWNER ASKED FOR: strip the comments and hash the filenames at deploy
 * time. Both, and here is what each one is actually worth.
 *
 * ── STRIPPING ───────────────────────────────────────────────────────────────
 *
 * This repository puts its reasoning in the source. A comment here is the record
 * of which bug a line exists to prevent, and deleting them from the REPOSITORY
 * would remove the only thing standing between a future edit and the same bug
 * again. The owner's phone needs none of it: index.html is 1.9 MB and roughly a
 * fifth of it is prose, with another third of the modules' 1.7 MB on top.
 *
 * Measured, not guessed: index.html 1.95 MB -> 1.52 MB (-22%), modules 1.73 MB
 * -> 1.17 MB (-32%). Just under a megabyte, every version change, on a mobile
 * connection.
 *
 * ── HASHING ────────────────────────────────────────────────────────────────
 *
 * Every module is served `no-cache, must-revalidate` today, so a returning
 * visitor makes ~66 conditional requests before the app can start — most of a
 * second of round trips on a phone, spent to be told nothing changed. A content
 * hash in the filename makes each module immutable by construction: a changed
 * file gets a different name, and index.html — which stays `no-cache` — is what
 * points at it. Nothing can be served stale, because nothing is ever reused
 * under a name whose bytes changed.
 *
 * "Whose bytes changed" includes its DEPENDENCIES' bytes, and getting that
 * right turned up a real ES module cycle in this repository:
 * wealthflow-mail-ingest.mjs imports wealthflow-backfill.js for STATEMENT_TERMS,
 * backfill imports sender-discovery, and sender-discovery imports mail-ingest.
 * Legal, working, and fatal to the obvious rewrite-then-rehash-until-stable
 * approach, which has no fixpoint when two names depend on each other. See the
 * hashing step below for what is done instead.
 *
 * ── HOW A SILENT BREAKAGE IS MADE IMPOSSIBLE ────────────────────────────────
 *
 * The failure mode of renaming files is a reference nobody updated: a 404 at
 * runtime, on somebody's phone, for one feature. So:
 *
 *   1. Comments are removed by a real scanner, not a regular expression, so a
 *      `//` inside a string or a regex literal cannot corrupt the file. See
 *      build-strip.mjs.
 *   2. Every written module is parsed with `node --check`, which parses and
 *      stops. Importing would EXECUTE it, and half this app's modules touch
 *      `window` on load — one of them from a timer that fires after the import
 *      resolved. A deploy that dies on a stray timer is worse than no check.
 *   3. Stripping is checked to be idempotent — a second pass must find nothing.
 *   4. After the rename, EVERY LOCAL .js/.mjs FILE THE DEPLOY SHIPS — not only
 *      the renamed modules, index.html and sw.js — is scanned for a surviving
 *      reference to an original module filename. One hit FAILS THE BUILD. See
 *      step 3b below for why this had to widen, and what it broke in
 *      production before it did.
 *   5. test/build_test.js runs the whole thing over a real copy of this
 *      repository, imports every stripped module and compares its exported
 *      names with the original's — the strong check, run where a thrown timer
 *      fails a test instead of a deployment.
 *   6. `node test/e2e/build-boot.mjs` builds a copy, serves THAT tree, and
 *      signs into it in a real Chromium. "The files are correct" and "the app
 *      runs" are different claims and only one of them matters.
 *
 * ── AND THE CACHE HEADERS ARE SAFE IF THIS NEVER RUNS ───────────────────────
 *
 * vercel.json carries TWO rules for these files, and the split is the whole
 * safety argument:
 *
 *   /(wealthflow-…-[0-9a-f]{8}\.js)   immutable for a year + Content-Type
 *   /(wealthflow-…\.js)               Content-Type only
 *
 * They set Content-Type to the same value, so it does not matter which wins;
 * Cache-Control appears in one rule only, so there is nothing to resolve. If
 * this build ever fails to run, the files keep their original names, match only
 * the second rule, and fall back to Vercel's default `max-age=0,
 * must-revalidate`. A year-long cache can only ever attach to a name that
 * already contains the hash of what is inside it.
 *
 * ── IT WORKS IN PLACE, DELIBERATELY ─────────────────────────────────────────
 *
 * Not into dist/. Vercel serves this repository's root directly, `/api` is
 * detected there, and every rewrite in vercel.json is written against that
 * layout. Moving the served tree would change all of it at once, on a live app
 * that holds the owner's money, for no benefit — the transformation is the
 * point, not where it lands. So the build rewrites the files inside the build
 * sandbox's checkout, which is thrown away after the deploy. The git working
 * tree is never touched by CI, and running it locally without --write only
 * reports.
 *
 * ── IT LIVES AT THE ROOT, AND THAT IS NOT AN ACCIDENT ───────────────────────
 *
 * build-strip.mjs sat in autonomy/ first, and Vercel's build failed on it:
 * `.vercelignore` removes autonomy/ entirely, so the build sandbox had
 * build.mjs and not the one module it imports. Nothing local could have caught
 * that — this sandbox has the whole repository; the build machine does not.
 * The preview deployment caught it, which is what preview deployments are for.
 *
 * A build tool's dependencies have to survive .vercelignore, so they live
 * beside it at the root. test/build_test.js now reads .vercelignore and refuses
 * any import of this file that the deploy would delete.
 *
 * The second thing the preview taught, also unknowable from here: adding a
 * buildCommand changes how Vercel resolves what to SERVE. With no build command
 * it serves the repository root; with one it looks for build output, in
 * public/, and fails when there is none. Since this build rewrites the files
 * where they already are, vercel.json names the root as the output directory
 * explicitly. Both settings only make sense together, and build_test.js pins
 * that pairing.
 *
 * ── THE BUG THAT REACHED PRODUCTION, AND WHY LOCAL TESTING MISSED IT ────────
 *
 * The rewrite step above — "modules reference each other by import specifier"
 * — only ever rewrote references INSIDE the modules themselves, index.html and
 * sw.js. It shipped, and the first real user hit "Connect Gmail" and got:
 *
 *     Cannot find module '/var/task/wealthflow-mail-ingest.mjs'
 *     imported from /var/task/gmail-link.js
 *
 * gmail-link.js is a SERVER handler at the repo root — not a browser module,
 * never listed in index.html, never touched by the rewrite above — and it
 * `import`s wealthflow-mail-ingest.mjs BY ITS ORIGINAL NAME, because that is
 * the only name it has ever needed until this build started deleting it out
 * from under it. gmail-hook.js, gmail-scan.js, gmail-scan.mjs and
 * api/telegram-approve.js (the Telegram one-tap approval bot) do the same
 * thing. Every one of them kept resolving correctly in every test here,
 * because build_test.js's own fixture copied only the modules, index.html and
 * sw.js into its scratch directory — the exact files the old rewrite covered,
 * and none of the ones it didn't. A test that only looks where the code
 * already looks proves nothing about where it doesn't; this repository has
 * shipped that exact shape of bug from the browser side more than once, and
 * here it was this file's own.
 *
 * So step 3b below rewrites EVERY local .js/.mjs file the deploy ships, found
 * by walking the tree rather than by naming the ones known to need it — the
 * same lesson as the file this bug lived in. `.vercelignore` decides what "the
 * deploy ships" means, and is read once, HERE, rather than copied a third time
 * into a second test file: see vercelIgnoreRules()/ignoredBy() below.
 *
 * USAGE
 *   node build.mjs                 report what would change, write nothing
 *   node build.mjs --write         strip and hash in place (what Vercel runs)
 *   node build.mjs --write --no-hash   strip only, keep every filename
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { stripJs, stripHtml, tidy } from './build-strip.mjs';

/** Files the browser is served and that carry comments worth removing. */
export const MODULE_RE = /^wealthflow-[a-zA-Z0-9-]+\.(?:js|mjs)$/;
/** A name this build already produced. Re-running must not hash a hash. */
export const HASHED_RE = /^wealthflow-[a-zA-Z0-9-]+-[0-9a-f]{8}\.(?:js|mjs)$/;

/** Eight hex characters of SHA-256. Collision risk at this scale is nil. */
export function hashOf(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/** `wealthflow-when.js` + a hash -> `wealthflow-when-1a2b3c4d.js`.
 *
 * A DASH and not a dot, which is load-bearing: vercel.json routes and caches on
 * `/(wealthflow-[a-zA-Z0-9-]+\.js)` and sw.js decides what is app shell with
 * the same shape. `wealthflow-when.1a2b3c4d.js` matches neither, so it would
 * be served without the Content-Type header a module needs and skipped by the
 * service worker — two failures, both invisible until production. */
export function hashedName(file, hash) {
    const dot = file.lastIndexOf('.');
    return file.slice(0, dot) + '-' + hash + file.slice(dot);
}

/**
 * Rewrite every reference to a renamed module.
 *
 * Longest name first, so one module's name can never be rewritten as a prefix
 * of another's. Plain text replacement on purpose: a reference may be an import
 * specifier, a script src, or a filename inside a string that the page injects
 * later — index.html has all three — and a rewrite that only understood import
 * syntax would leave the third kind pointing at a file that no longer exists.
 */
export function rewriteRefs(text, renames) {
    let out = String(text == null ? '' : text);
    const names = [...renames.keys()].sort((a, b) => b.length - a.length);
    for (const from of names) {
        out = out.split(from).join(renames.get(from));
    }
    return out;
}

/**
 * The same idea as rewriteRefs, narrowed to only what Node's module resolver
 * actually reads: the quoted path inside an `import ... from`, `import(...)`
 * or `require(...)`.
 *
 * rewriteRefs is deliberately loose text replacement, because index.html has a
 * third shape neither of those cover — a filename built as a bare string and
 * handed to `document.createElement('script').src` at runtime — and a rewrite
 * that only understood import syntax would leave that one pointing at nothing.
 *
 * Every OTHER local file this build touches is a server module with none of
 * that: gmail-link.js and its kind import a renamed module exactly once, as a
 * literal specifier, and say nothing else about it FUNCTIONALLY — but they say
 * a great deal about it in PROSE, in comments that name the file they are
 * describing. The loose rewriter cannot tell "the specifier Node resolves"
 * from "a sentence explaining what that file does", so an early version of
 * this fix rewrote comments across a dozen files into nonsense like "kept in
 * lock-step with wealthflow-route-a1b2c3d4.js" — true of nothing, since
 * nobody's comment was ever about a hash. This one only touches the specifier.
 */
export function rewriteImportsOnly(text, renames) {
    return String(text == null ? '' : text).replace(
        /(\bfrom\s+|\bimport\(\s*|\brequire\(\s*|\bnew\s+URL\(\s*)(['"])([^'"]+?)\2/g,
        (whole, prefix, quote, spec) => {
            const base = spec.split('/').pop();
            if (!renames.has(base)) return whole;
            return prefix + quote + spec.slice(0, spec.length - base.length) + renames.get(base) + quote;
        },
    );
}

/** Every original module filename still mentioned anywhere. Empty or the build fails. */
export function survivors(text, originals) {
    const found = [];
    for (const name of originals) {
        /* Bounded so `wealthflow-when-1a2b3c4d.js` does not count as a mention
         * of `wealthflow-when.js`; the hash sits before the dot, so an exact
         * match of the original is a genuine leftover. */
        const re = new RegExp('(^|[^a-zA-Z0-9-])' + name.replace(/[.]/g, '\\.') + '(?![a-zA-Z0-9-])');
        if (re.test(text)) found.push(name);
    }
    return found;
}

/**
 * The same check as survivors(), narrowed to import/require specifiers — the
 * counterpart to rewriteImportsOnly(). A server file's COMMENTS are meant to
 * still say the plain name after this build runs; that is not a leftover
 * reference, it is prose, and survivors() would wrongly fail the build on
 * every doc comment that names a file it is talking about.
 */
export function survivorsInImports(text, originals) {
    const found = new Set();
    const known = new Set(originals);
    const re = /(?:\bfrom\s+|\bimport\(\s*|\brequire\(\s*|\bnew\s+URL\(\s*)(['"])([^'"]+?)\1/g;
    let m;
    while ((m = re.exec(text))) {
        const base = m[2].split('/').pop();
        if (known.has(base)) found.add(base);
    }
    return [...found];
}

/**
 * .vercelignore, read once and shared by the build and its own test.
 *
 * There used to be a second copy of this reader inside test/build_test.js,
 * written to check that build.mjs's OWN import of build-strip.mjs survives the
 * ignore file. Two copies of "what does a rule in this file mean" is how one
 * of them drifts from the other and a check quietly stops checking anything —
 * the same defect this file's header now has a story about. The test imports
 * this one.
 */
export function vercelIgnoreRules(root) {
    const p = path.join(root, '.vercelignore');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n');
}

/** The rule that removes `relPath` before the build runs, or null if none does. */
export function ignoredBy(rules, relPath) {
    for (const raw of rules) {
        const rule = raw.trim();
        if (!rule || rule.startsWith('#')) continue;
        if (rule.endsWith('/')) {                       // a whole directory
            if (relPath.startsWith(rule) || relPath.startsWith(rule.slice(0, -1) + '/')) return rule;
        } else if (rule.startsWith('*.')) {             // an extension
            if (relPath.endsWith(rule.slice(1))) return rule;
        } else if (relPath === rule || relPath.endsWith('/' + rule)) {
            return rule;
        }
    }
    return null;
}

/* Directories never walked, deploy-ignored or not: a VCS/tooling directory is
 * never part of what ships, and node_modules is both enormous and something
 * this build must never rewrite the inside of. */
const NEVER_WALK = new Set(['node_modules', '.git', '.vercel']);

/**
 * Every local .js/.mjs file the deploy actually ships, found by walking rather
 * than by naming the ones already known to matter — see the header on why that
 * distinction is the whole fix.
 */
export function localJsFiles(root, rules) {
    const out = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = path.relative(root, path.join(dir, entry.name));
            if (entry.isDirectory()) {
                if (NEVER_WALK.has(entry.name)) continue;
                if (ignoredBy(rules, rel + '/')) continue;
                walk(path.join(dir, entry.name));
                continue;
            }
            if (!/\.(?:js|mjs)$/.test(entry.name)) continue;
            if (ignoredBy(rules, rel)) continue;
            out.push(rel);
        }
    })(root);
    return out;
}

const kb = (n) => (n / 1024).toFixed(0).padStart(6) + ' KB';

export async function build({ root = process.cwd(), write = false, hash = true, log = console.log } = {}) {
    const all = fs.readdirSync(root);
    const modules = all.filter((f) => MODULE_RE.test(f) && !HASHED_RE.test(f)).sort();
    if (!modules.length) throw new Error('no modules found in ' + root + ' — wrong directory?');

    const before = { html: 0, js: 0 };
    const after = { html: 0, js: 0 };
    const renames = new Map();
    const stripped = new Map();          // original filename -> stripped text
    const problems = [];

    /* ── 1. strip every module, and prove each one still parses ───────────── */
    for (const f of modules) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        const text = tidy(stripJs(src).text);
        before.js += Buffer.byteLength(src);
        after.js += Buffer.byteLength(text);
        stripped.set(f, text);
        /* Idempotent: a second pass must find nothing. If it does, the first
         * pass mistook something for a comment or left one behind. */
        const again = stripJs(text);
        if (again.comments !== 0) problems.push(f + ': stripping is not idempotent (' + again.comments + ' left)');
    }

    /* ── 2. hash, and work out the new names ──────────────────────────────
     *
     * A NAME MUST CHANGE WHEN ANYTHING IT DEPENDS ON CHANGES, or a year-long
     * cache is a trap. Hashing each file's own bytes is not enough: change
     * wealthflow-institutions.js and wealthflow-mail-ingest.mjs, which imports
     * it, keeps its old name — so a browser holding the cached copy goes on
     * importing the old institutions file forever.
     *
     * The obvious repair — rewrite the imports, then hash, repeating until the
     * names stop moving — DOES NOT TERMINATE HERE, and finding out why was the
     * useful part: wealthflow-mail-ingest.mjs imports wealthflow-backfill.js
     * for STATEMENT_TERMS, and backfill imports sender-discovery, which imports
     * mail-ingest. A real ES module cycle, legal and working. Each name would
     * then depend on the other's, and there is no fixpoint.
     *
     * So the hash is taken over the module's own stripped bytes plus the own-
     * hashes of everything it can reach, sorted. Cycles are handled by
     * construction — two modules in a cycle reach the same set, so the
     * dependency half of their hashes matches while their own halves still
     * differ — and one pass answers it.
     */
    const deps = new Map();
    const own = new Map();
    for (const f of modules) {
        own.set(f, hashOf(stripped.get(f)));
        deps.set(f, modules.filter((m) => m !== f && stripped.get(f).includes(m)));
    }
    if (hash) {
        for (const f of modules) {
            /* Everything reachable, including through a cycle. */
            const seen = new Set();
            const stack = [...deps.get(f)];
            while (stack.length) {
                const d = stack.pop();
                if (seen.has(d)) continue;
                seen.add(d);
                for (const n of deps.get(d) || []) stack.push(n);
            }
            const world = [...seen].sort().map((d) => d + ':' + own.get(d)).join('|');
            renames.set(f, hashedName(f, hashOf(own.get(f) + '|' + world)));
        }
    }

    /* ── 3. index.html and sw.js ──────────────────────────────────────────── */
    const htmlPath = path.join(root, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');
    before.html = Buffer.byteLength(html);
    let htmlOut = tidy(stripHtml(html).text);
    htmlOut = rewriteRefs(htmlOut, renames);
    after.html = Buffer.byteLength(htmlOut);

    const swPath = path.join(root, 'sw.js');
    let swOut = null;
    if (fs.existsSync(swPath)) {
        swOut = rewriteRefs(tidy(stripJs(fs.readFileSync(swPath, 'utf8')).text), renames);
    }

    /* Modules reference each other by import specifier. */
    for (const f of modules) stripped.set(f, rewriteRefs(stripped.get(f), renames));

    /* ── 3b. EVERY OTHER LOCAL FILE THAT REFERENCES A RENAMED MODULE ───────
     *
     * The production bug, closed at its actual size. gmail-link.js,
     * gmail-hook.js, gmail-scan.js, gmail-scan.mjs and api/telegram-approve.js
     * are server handlers — never listed in index.html, never one of the
     * `modules` above — that `import` a wealthflow-*.js/mjs module by its
     * plain name because that name has never changed before. They are found
     * by WALKING what the deploy ships, per .vercelignore, rather than by
     * being named — the same reason the walk exists at all is that naming them
     * is exactly what missed them the first time.
     *
     * Comments are NOT stripped from these files, and neither are their OWN
     * comments rewritten — that was never the ask for server code that never
     * reaches a browser, and touching more than the broken reference is risk
     * this fix does not need. rewriteImportsOnly() touches the specifier Node
     * actually resolves and nothing else; a file untouched by any rename, or
     * only mentioning one in prose, is untouched, full stop. */
    const otherFiles = new Map();      // relPath -> rewritten text, only if it changed
    let others = [];                   // every such file, walked once and reused below
    if (hash) {
        const rules = vercelIgnoreRules(root);
        const moduleNames = new Set(modules);
        others = localJsFiles(root, rules).filter((rel) => rel !== 'sw.js' && !moduleNames.has(rel));
        for (const rel of others) {
            const before2 = fs.readFileSync(path.join(root, rel), 'utf8');
            const after2 = rewriteImportsOnly(before2, renames);
            if (after2 !== before2) otherFiles.set(rel, after2);
        }
    }

    /* ── 4. nothing may still point at a name that will not exist ─────────── */
    if (hash) {
        const originals = modules;
        const check = [['index.html', htmlOut, survivors], ...(swOut === null ? [] : [['sw.js', swOut, survivors]]),
            ...modules.map((f) => [f, stripped.get(f), survivors]),
            /* Every OTHER shipped .js/.mjs file, changed or not — a file this
             * rewrite pass never touched must still be checked, because "it
             * references nothing renamed" and "the rewrite silently failed to
             * catch what it references" read identically without this. Checked
             * with the specifier-scoped reader, so a comment that still names
             * the plain file — which it is meant to — is not mistaken for the
             * bug this exists to catch. */
            ...others.map((rel) => [rel, otherFiles.has(rel) ? otherFiles.get(rel)
                : fs.readFileSync(path.join(root, rel), 'utf8'), survivorsInImports])];
        for (const [name, text, check1] of check) {
            const left = check1(text, originals);
            if (left.length) problems.push(name + ' still references: ' + left.join(', '));
        }
    }

    if (problems.length) {
        const err = new Error('build refused:\n  ' + problems.join('\n  '));
        err.problems = problems;
        throw err;
    }

    /* ── 5. write, if asked ───────────────────────────────────────────────── */
    if (write) {
        fs.writeFileSync(htmlPath, htmlOut);
        if (swOut !== null) fs.writeFileSync(swPath, swOut);
        for (const f of modules) {
            const target = renames.get(f) || f;
            fs.writeFileSync(path.join(root, target), stripped.get(f));
            /* The original is removed only after its replacement is on disk, so
             * an interrupted build leaves a working tree rather than a hole. */
            if (target !== f) fs.rmSync(path.join(root, f));
        }
        /* Same discipline: a server handler's fixed reference is written back
         * to the SAME path it already lives at — it is not renamed, it is not
         * hashed, only the one broken line inside it changes. */
        for (const [rel, text] of otherFiles) fs.writeFileSync(path.join(root, rel), text);
    }

    const total = { before: before.html + before.js, after: after.html + after.js };
    log('');
    log('  index.html   ' + kb(before.html) + ' -> ' + kb(after.html));
    log('  ' + String(modules.length).padStart(2) + ' modules   ' + kb(before.js) + ' -> ' + kb(after.js));
    log('  ─────────────────────────────────');
    log('  shipped      ' + kb(total.before) + ' -> ' + kb(total.after)
        + '   (' + (100 * (1 - total.after / total.before)).toFixed(1) + '% smaller)');
    log(hash ? '  filenames    content-hashed, immutable' : '  filenames    unchanged');
    if (otherFiles.size) {
        log('  server refs  fixed in ' + otherFiles.size + ' file' + (otherFiles.size === 1 ? '' : 's')
            + ': ' + [...otherFiles.keys()].join(', '));
    }
    log(write ? '  written in place' : '  DRY RUN — nothing written (pass --write)');
    log('');

    return { modules, renames, before, after, htmlOut, swOut, stripped, otherFiles };
}

/**
 * Check that every written module still PARSES — without running it.
 *
 * `node --check` and not `import()`, and the difference matters here. Importing
 * a module executes it, and half of this app's modules touch `window` or
 * `localStorage` the moment they load: in Node they throw, some of them from a
 * setTimeout that fires after the import resolved. A deploy build that
 * intermittently dies on somebody else's stray timer is worse than no check at
 * all. --check parses and stops, which is exactly the question being asked.
 *
 * The stronger check — import each module and compare its exported names with
 * the original's — is real and is run in test/build_test.js, where a thrown
 * timer fails a test instead of a deployment.
 */
export async function verifyParses({ root, files, log = console.log }) {
    const { execFile } = await import('node:child_process');
    const bad = [];
    await Promise.all(files.map((f) => new Promise((resolve) => {
        execFile(process.execPath, ['--check', path.join(root, f)], (err, _out, stderr) => {
            if (err) bad.push(f + ': ' + String(stderr || err.message).split('\n').slice(0, 3).join(' ').slice(0, 200));
            resolve();
        });
    })));
    if (bad.length) throw new Error('stripped modules do not parse:\n  ' + bad.join('\n  '));
    log('  ' + files.length + ' modules parse after stripping');
    return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    const write = process.argv.includes('--write');
    const hash = !process.argv.includes('--no-hash');
    try {
        const out = await build({ root: process.cwd(), write, hash });
        if (write) {
            await verifyParses({
                root: process.cwd(),
                files: out.modules.map((f) => out.renames.get(f) || f),
            });
        }
        process.exit(0);
    } catch (e) {
        console.error('\n' + (e && e.message ? e.message : e) + '\n');
        process.exit(1);
    }
}
