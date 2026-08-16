/* =============================================================================
 * test/esm_require_test.js — `require` does not exist in this package, and a
 * module that cannot load must not report a configuration problem
 * -----------------------------------------------------------------------------
 * WHAT HAPPENED
 *
 * package.json declares `"type": "module"`. Every `.js` file in this repository
 * is therefore ESM, where the identifier `require` is not defined at all —
 * referencing it throws `ReferenceError: require is not defined` on the spot.
 *
 * Three files called it anyway, each inside a blanket catch:
 *
 *   release-brain.js     getAdmin()  → `catch (e) { return null; }`
 *   approve-release.js   getAdmin()  → `catch (_) { return null; }`
 *   statement-store.js   randomId()  → `catch (_) { <Math.random fallback> }`
 *
 * None of them ever executed the line after the require. And because the catch
 * was blanket, each reported the failure as something else entirely:
 *
 *   · /api/release-brain answered HTTP 200 with "FIREBASE_SERVICE_ACCOUNT not
 *     configured — brain idle." on every call, for a credential that was
 *     configured. That is why redeploying to fix the "missing env var" changed
 *     nothing, and why system/pendingRelease was never written — which is in
 *     turn why the whole proposal-intake pipeline read empty.
 *
 *   · /api/approve-release answered HTTP 500 "service account not configured".
 *     The one human ship button in the entire autonomous system could never
 *     reach Firestore. It failed CLOSED, so nothing shipped unapproved — but
 *     approving was equally impossible and the error blamed the config.
 *
 *   · statement-store's `randomId` fell through to `Math.random()` on every
 *     single call. The fallback was not a fallback; it was the only path. That
 *     id is the sole access control on a shared statement URL.
 *
 * One root cause, three symptoms, and in all three the report named the one
 * thing that was working. Same family as the discover.mjs mask and the
 * gitignored lockfile: AN INFRASTRUCTURE FAILURE WEARING THE COSTUME OF A
 * RESULT.
 *
 * The first block below is the family guard — it fails for any ESM file that
 * reaches for `require` again, not just these three.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import releaseBrainHandler from '../release-brain.js';
import approveReleaseHandler from '../approve-release.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* Strip comments before scanning. This file's own explanation quotes
 * `require('firebase-admin')` verbatim, and the fixed sources quote the deleted
 * lines in THEIR comments — scanning raw text would flag every file that
 * documents the bug and pass every file that silently still has it. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
        .join('\n');
}

const BARE_REQUIRE = /(^|[^.\w$])require\s*\(/;

function esmSources() {
    const r = spawnSync('git', ['ls-files', '*.js', '*.mjs'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, 'git ls-files failed — this guard would scan nothing').toBe(0);
    return r.stdout.split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((f) => !f.endsWith('.cjs') && !f.startsWith('node_modules/'))
        .map((f) => ({ file: f, code: stripComments(read(f)) }))
        // A file is ESM in the eyes of Node only once it uses module syntax.
        // The browser IIFEs served as classic <script> are not, and are never
        // loaded by Node, so they are out of scope here.
        .filter(({ code }) => /^\s*(export\s|import\s+[\w{*])/m.test(code));
}

describe('no ESM module in this package reaches for require()', () => {
    const sources = esmSources();

    it('found ESM files to check at all', () => {
        // Without this the suite passes loudest when the scanner is broken.
        expect(sources.length, 'the ESM scan matched nothing — the filter is wrong').toBeGreaterThan(5);
        expect(sources.map((s) => s.file)).toContain('release-brain.js');
        expect(sources.map((s) => s.file)).toContain('approve-release.js');
        expect(sources.map((s) => s.file)).toContain('statement-store.js');
    });

    it('none of them use a bare require', () => {
        const offenders = sources
            .filter(({ code }) => BARE_REQUIRE.test(code))
            // createRequire(import.meta.url) is the legitimate ESM escape hatch
            // and autonomy/self-check.mjs uses it correctly.
            .filter(({ code }) => !/createRequire/.test(code))
            .map(({ file }) => file);
        expect(offenders,
            'these throw ReferenceError on the require line; check what their catch block reports instead')
            .toEqual([]);
    });

    it('the scanner would actually catch a violation', () => {
        // Guard the guard, both ways.
        expect(BARE_REQUIRE.test(stripComments("const a = require('firebase-admin');"))).toBe(true);
        expect(BARE_REQUIRE.test(stripComments("  try { require('crypto').randomFillSync(x); }"))).toBe(true);
        // …and is not fooled by the documentation of the bug, or by a method call
        expect(BARE_REQUIRE.test(stripComments("// const a = require('firebase-admin');"))).toBe(false);
        expect(BARE_REQUIRE.test(stripComments("/* was: require('crypto') */"))).toBe(false);
        expect(BARE_REQUIRE.test(stripComments('mod.require(x);'))).toBe(false);
    });
});

// ── the specific reports, now that they can be produced at all ───────────────

describe('release-brain names WHICH credential problem it hit', () => {
    const handler = releaseBrainHandler;

    const call = async (value) => {
        const prev = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (value === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
        else process.env.FIREBASE_SERVICE_ACCOUNT = value;
        try {
            const captured = {};
            const res = { status() { return res; }, json(o) { captured.body = o; return res; } };
            await handler({ query: {} }, res);
            return captured.body;
        } finally {
            if (prev === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
            else process.env.FIREBASE_SERVICE_ACCOUNT = prev;
        }
    };

    it('says "not set" only when it is genuinely not set', async () => {
        const out = await call(undefined);
        expect(out.ok).toBe(false);
        expect(out.note).toMatch(/FIREBASE_SERVICE_ACCOUNT is not set/);
    });

    it('does not call a malformed credential a missing one', async () => {
        // The distinction that cost a round of Vercel redeploys.
        const out = await call('{ not json');
        expect(out.ok).toBe(false);
        expect(out.note).toMatch(/not valid JSON/);
        expect(out.note, 'a present-but-broken credential is being reported as absent')
            .not.toMatch(/is not set/);
    });

    it('never again reports a module-load failure as a config problem', async () => {
        const a = await call(undefined);
        const b = await call('{ not json');
        expect(a.note).not.toBe(b.note);
        for (const note of [a.note, b.note]) {
            expect(note, 'the reason is empty — the caller learns nothing').toBeTruthy();
            expect(note).not.toMatch(/require is not defined/);
        }
    });
});

describe('approve-release can reach Firestore at all', () => {
    const handler = approveReleaseHandler;

    it('reports the real reason instead of a blanket "not configured"', async () => {
        const prev = process.env.FIREBASE_SERVICE_ACCOUNT;
        process.env.FIREBASE_SERVICE_ACCOUNT = '{ not json';
        try {
            let code = 0; const captured = {};
            const res = { status(c) { code = c; return res; }, json(o) { captured.body = o; return res; } };
            await handler({ method: 'POST', body: {} }, res);
            expect(code).toBe(500);
            expect(captured.body.ok).toBe(false);
            expect(captured.body.error).toMatch(/not valid JSON/);
        } finally {
            if (prev === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
            else process.env.FIREBASE_SERVICE_ACCOUNT = prev;
        }
    });

    it('still refuses to ship without an owner token', () => {
        // The safety property must survive the fix: the gate failed closed
        // before because it could not start, and must now fail closed because
        // it checks. Both guards are still in the source.
        const src = read('approve-release.js');
        expect(src).toMatch(/verifyIdToken/);
        expect(src).toMatch(/RELEASE_ADMIN_UID/);
        expect(src).toMatch(/not authorised to approve releases/);
    });
});

describe('a shared statement id is generated by a CSPRNG', () => {
    const code = stripComments(read('statement-store.js'));
    const CHARS = 'ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

    /* THE SHIPPED FUNCTION, lifted out of the source file and run for real.
     *
     * The first draft of this block re-implemented rejection sampling inside
     * the test and measured THAT. It passed against the old biased source,
     * which is the precise failure mode this whole pull request is about — a
     * check that reports on something other than the thing it names. Every
     * statistic below now comes from statement-store.js's own bytes. */
    const impl = code.match(/function randomId[\s\S]*?\n\}/);
    const measure = (draws) => {
        expect(impl, 'randomId could not be extracted — this block would measure nothing').toBeTruthy();
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
            const { randomFillSync } = await import('node:crypto');
            ${impl[0]}
            const chars = ${JSON.stringify(CHARS)};
            const counts = Object.fromEntries([...chars].map((c) => [c, 0]));
            const ids = new Set();
            let shapeOk = true;
            for (let i = 0; i < ${draws}; i++) {
                const id = randomId(8);
                ids.add(id);
                if (id.length !== 8) shapeOk = false;
                for (const c of id) {
                    if (!(c in counts)) { shapeOk = false; continue; }
                    counts[c]++;
                }
            }
            console.log(JSON.stringify({ unique: ids.size, shapeOk, counts }));
        `], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
        expect(r.stderr, 'the shipped randomId threw when run standalone').toBe('');
        expect(r.status).toBe(0);
        return JSON.parse(r.stdout);
    };

    it('imports a real random source and keeps no weak fallback', () => {
        expect(code).toMatch(/import \{ randomFillSync \} from 'node:crypto'/);
        expect(code, 'Math.random is back in the id path — that id IS the access control')
            .not.toMatch(/Math\.random/);
        expect(code, 'a silent downgrade path is back').not.toMatch(/catch[\s\S]{0,80}Math\.random/);
    });

    it('produces ids of the right shape, and draws them uniformly', () => {
        /* `b % 58` over 0..255 is biased: 256 = 4*58 + 24, so the first 24
         * characters of the alphabet came up ~25% more often than the rest,
         * shrinking the effective keyspace below the nominal 58^8.
         *
         * Measured on this machine over 2,000,000 characters: the old
         * `b % chars.length` scored chi-square 25432, rejection sampling scored
         * 66.1, against a 95% critical value of 75.6 for df=57. This runs a
         * tenth of that sample to keep the suite fast; the two populations are
         * still ~40x apart, so the bound below separates them with no doubt. */
        const N = 25_000;                       // 25k ids × 8 chars = 200k draws
        const got = measure(N);

        expect(got.shapeOk, 'an id was the wrong length or used an off-alphabet character').toBe(true);
        expect(got.unique, 'collisions appeared in 25k draws — the id space is not what it claims').toBe(N);

        const values = Object.values(got.counts);
        expect(values.length).toBe(58);
        const exp = (N * 8) / CHARS.length;
        const chi2 = values.reduce((a, v) => a + ((v - exp) ** 2) / exp, 0);
        expect(chi2, `chi-square ${chi2.toFixed(1)} over ${N * 8} draws — the id is not uniform`)
            .toBeLessThan(120);                 // df=57: 99.9% critical value is 98.3
    });
});
