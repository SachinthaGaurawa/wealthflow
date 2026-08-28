/* =============================================================================
 * test/admin_db_contract_test.js — the wrapper must be destructured
 * -----------------------------------------------------------------------------
 * getAdminDb() returns { db, reason, admin } and NEVER a bare Firestore handle.
 * Reading it as one is not caught by a truthiness check, because the wrapper is
 * always truthy: the guard passes and the next line dies on
 * `db.collection is not a function`.
 *
 * TWICE, IN PRODUCTION, IN THE SAME PIPELINE.
 *
 *   gmail-link.js   — 500 on every GET, POST and DELETE. Observed: the owner
 *                     could not save a refresh token, and the Statement Sync
 *                     card reported the crash as a calm "Not connected".
 *   gmail-hook.js   — the same shape via getInboxDb(), with a guard reading
 *                     `if (!db || db.error)` for a field that has never existed
 *                     on the wrapper. NOT observed, only because nothing ever
 *                     called Gmail's users.watch, so no push has ever arrived.
 *
 * The first fix carried a guard, and the guard missed the second file — it
 * searched for the literal `getAdminDb(` and gmail-hook.js reaches the same
 * bootstrap through an ALIAS. A guard that only covers the file it was written
 * for is not a guard, which is why this one is keyed on the exported accessor
 * names rather than on one spelling, and lives in its own file rather than
 * inside the suite of whichever endpoint was broken most recently.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* Every accessor that hands back the wrapper. inbox-store.mjs re-exports
 * getAdminDb() unchanged under a second name, so both must be covered. */
const ACCESSORS = ['getAdminDb', 'getInboxDb'];

/* The modules that DEFINE and re-export the accessors are not callers. */
const DEFINERS = new Set(['admin-db.mjs', 'inbox-store.mjs']);

function sourceFiles() {
    const out = [];
    for (const dir of ['', 'api']) {
        const abs = path.join(ROOT, dir);
        for (const f of fs.readdirSync(abs)) {
            if (!/\.(js|mjs)$/.test(f)) continue;
            const rel = dir ? `${dir}/${f}` : f;
            if (DEFINERS.has(rel)) continue;
            out.push(rel);
        }
    }
    return out;
}

/** Comments discuss this very bug; they must not satisfy or trip the check. */
function codeOnly(src) {
    return String(src)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

const callers = sourceFiles()
    .map((rel) => ({ rel, src: codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8')) }))
    .filter(({ src }) => ACCESSORS.some((a) => src.includes(`${a}(`)));

describe('no shipped file reads the Admin SDK wrapper as if it were the handle', () => {
    it('finds the call sites it is meant to be guarding', () => {
        /* Without this the whole suite passes by matching nothing — which is
         * how the previous version of this guard reported success while
         * gmail-hook.js was broken. */
        expect(callers.length).toBeGreaterThan(2);
    });

    it('covers the accessor gmail-hook.js actually uses', () => {
        /* Named explicitly: the alias is the reason the first guard missed it. */
        expect(ACCESSORS).toContain('getInboxDb');
        const hook = callers.find((c) => c.rel === 'gmail-hook.js');
        expect(hook, 'gmail-hook.js is no longer among the call sites — check the accessor list').toBeTruthy();
    });

    for (const { rel, src } of callers) {
        it(`${rel} destructures every call`, () => {
            for (const accessor of ACCESSORS) {
                /* THE WHOLE LINE, to the end of it. The first version of this
                 * check matched `^[^\n]*getAdminDb\s*\(` — which stops AT the
                 * paren, so the matched text never contained `()` and the
                 * `\(\s*\)` filter below skipped every call site. It reported
                 * success against code it had not examined, which is the same
                 * class of harness bug as the brace-counting extractor that
                 * returned 178 characters of a 5,212-character function. A guard
                 * is only worth what it fails on. */
                const lines = src.match(new RegExp(`^[^\\n]*${accessor}\\s*\\([^\\n]*$`, 'gm')) || [];
                for (const line of lines) {
                    if (/^\s*(export\s+)?(async\s+)?function\s/.test(line)) continue;   // a definition
                    if (new RegExp(`return\\s+${accessor}\\s*\\(`).test(line)) continue; // a pass-through
                    if (!new RegExp(`${accessor}\\s*\\(\\s*\\)`).test(line)) continue;
                    expect(
                        line,
                        `${rel}: ${accessor}() returns { db, reason, admin } — the wrapper is always truthy, `
                        + 'so reading it as the handle passes every guard and dies on the next line',
                    ).toMatch(/\{[^}]*\bdb\b[^}]*\}\s*=/);
                }
            }
        });
    }
});

describe('the wrapper never fails as a bare null', () => {
    it('admin-db.mjs always returns a reason alongside a null handle', () => {
        /* The doctrine at the top of admin-db.mjs: a caller must be able to say
         * "not configured" rather than something that reads as "empty". */
        const src = fs.readFileSync(path.join(ROOT, 'admin-db.mjs'), 'utf8');
        const returns = src.match(/return\s*\{[^}]*db:\s*null[^}]*\}/g) || [];
        expect(returns.length).toBeGreaterThan(3);
        for (const r of returns) expect(r).toContain('reason');
    });

    it('and admin is null whenever the handle is', () => {
        /* admin.auth() on an uninitialised app throws, so handing back a module
         * that was never initialised would turn "unconfigured" into a crash. */
        const src = fs.readFileSync(path.join(ROOT, 'admin-db.mjs'), 'utf8');
        for (const r of src.match(/return\s*\{[^}]*db:\s*null[^}]*\}/g) || []) {
            expect(r, `a failure return omits admin: null — ${r.slice(0, 70)}`).toContain('admin: null');
        }
    });
});
