// =============================================================================
// Every file a Vercel function loads at run time must still exist after
// `.vercelignore` has removed its share of the repository.
//
// Found 2026-11-05 from the daily production check: /api/autonomy-status threw
//   ERR_MODULE_NOT_FOUND  /var/task/autonomy/self-check.mjs
// seven times (first seen 2026-10-10, last 2026-11-04 15:16Z). `autonomy/` is on
// `.vercelignore`, so the module is not in the function bundle. #515 removed that
// one import; nothing stopped the next one. This test is that guard, for ALL of
// them: it starts at every function entry, follows every local import (static,
// dynamic with a literal path, or require), and fails if any file on the way is
// removed by `.vercelignore`.
//
// `ignoredBy()` is build.mjs's own reader of that file, so there is one meaning
// of "ignored" in the repository (see test/build_test.js).
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { vercelIgnoreRules, ignoredBy } from '../build.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const rules = vercelIgnoreRules(ROOT);

// The three shapes of a local load: import ... from './x', import('./x'), require('./x').
const SPEC_RES = [
    /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?\bfrom\s*['"](\.[^'"]+)['"]/g,
    /(?:^|[\s;}])import\s*['"](\.[^'"]+)['"]/g,
    /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g,
];

/** Strip comments (keeping strings whole) so a path mentioned in prose is not read as a load. */
function code(src) {
    return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '');
}

function resolveLocal(fromAbs, spec) {
    const base = path.resolve(path.dirname(fromAbs), spec);
    for (const cand of [base, base + '.js', base + '.mjs', base + '.cjs', base + '.json']) {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    }
    return null;
}

/** Every local file reachable from `entry`, with the file that loaded it. */
function reach(entry) {
    const seen = new Map([[entry, null]]);
    const queue = [entry];
    while (queue.length) {
        const file = queue.shift();
        if (!/\.(m?js|cjs)$/.test(file)) continue;
        const src = code(fs.readFileSync(file, 'utf8'));
        for (const re of SPEC_RES) {
            for (const m of src.matchAll(re)) {
                const dep = resolveLocal(file, m[1]);
                if (dep && !seen.has(dep)) { seen.set(dep, file); queue.push(dep); }
            }
        }
    }
    return seen;
}

const entries = fs.readdirSync(path.join(ROOT, 'api'))
    .filter((f) => /\.m?js$/.test(f))
    .map((f) => path.join(ROOT, 'api', f));

describe('serverless bundle: nothing a function loads is removed by .vercelignore', () => {
    it('the reader sees the real rules and the real entry points', () => {
        // A checker that matched nothing would pass on any repository.
        expect(ignoredBy(rules, 'autonomy/self-check.mjs')).toBe('autonomy/');
        expect(ignoredBy(rules, 'feedback-status.js')).toBe(null);
        expect(entries.map((e) => path.basename(e))).toContain('router.js');
        const fromRouter = [...reach(path.join(ROOT, 'api', 'router.js')).keys()].map((f) => path.relative(ROOT, f));
        expect(fromRouter.length).toBeGreaterThan(40);          // the router fans out to every root handler
        expect(fromRouter).toContain('feedback-triage.js');
        expect(fromRouter).toContain('autonomy-status.js');
    });

    it('the loader finds all four shapes of a local load, and ignores comments', () => {
        const dir = fs.mkdtempSync(path.join(ROOT, '.tmp-bundle-'));
        try {
            for (const n of ['a', 'b', 'c', 'd', 'e']) fs.writeFileSync(path.join(dir, n + '.mjs'), '');
            fs.writeFileSync(path.join(dir, 'c.cjs'), '');
            const entry = path.join(dir, 'entry.mjs');
            fs.writeFileSync(entry, [
                "import { x } from './a.mjs';",
                "import './b.mjs';",
                "const m = await import('./c.mjs');",
                // split so test/esm_require_test.js does not read this fixture as a real bare require in an ES module
                "const r = req" + "uire('./c.cjs');",
                "// import('./d.mjs')",
                "/* import { y } from './e.mjs' */",
            ].join('\n'));
            const got = [...reach(entry).keys()].map((f) => path.basename(f)).sort();
            expect(got).toEqual(['a.mjs', 'b.mjs', 'c.cjs', 'c.mjs', 'entry.mjs']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    for (const entry of entries) {
        it(path.relative(ROOT, entry) + ' loads only files that ship', () => {
            const lost = [];
            for (const [file, from] of reach(entry)) {
                const rel = path.relative(ROOT, file);
                const rule = ignoredBy(rules, rel);
                if (rule) lost.push(`${rel} (removed by "${rule}"), loaded by ${path.relative(ROOT, from)}`);
            }
            expect(lost, 'these are not in /var/task, so the load throws ERR_MODULE_NOT_FOUND').toEqual([]);
        });
    }
});
