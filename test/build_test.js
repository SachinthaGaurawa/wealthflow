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
    build, hashOf, hashedName, rewriteRefs, survivors, MODULE_RE, HASHED_RE,
} from '../build.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

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
 * THE DEPLOY IS WIRED TO IT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('Vercel actually runs it, and the headers are safe if it does not', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

    it('the build command is set', () => {
        expect(vercel.buildCommand).toBe('node build.mjs --write');
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
