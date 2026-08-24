/* =============================================================================
 * test/statement_upload_accept_test.js — the statement picker must actually
 * allow an HTML e-statement to be SELECTED
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * #116 taught the app to decrypt Nations Trust / AmEx HTML e-statements
 * (PBKDF2-SHA1 → AES-CBC, unlocked with the date of birth). None of it could run,
 * because the file could not be chosen in the first place.
 *
 * index.html declares the statement input correctly:
 *
 *     <input type="file" accept="application/pdf,text/html,.pdf,.PDF,.html,.htm,…"
 *            id="ccot_ai_scan" …>
 *
 * …and then patchFileInputsV5() in wealthflow-ai-v4.js, which SELECTS
 * ccot_ai_scan, assigned straight over it:
 *
 *     inp.accept = 'image/*,…,application/pdf,.pdf,.PDF';   // no HTML
 *
 * So at runtime the input stopped accepting text/html, and iOS Files greyed out
 * every .html statement — untappable. The markup was right and the picker still
 * refused the file, which is exactly why it presented as a decryption bug.
 *
 * This is the same defect family the rest of this suite exists to catch: a
 * component confidently undoing work it never announced. The markup and the
 * runtime patch disagreed, and only the runtime one was visible to the user.
 *
 * WHY A TEST AND NOT JUST THE FIX
 *
 * The accept list is edited whenever a new capture format is added, and the
 * tempting edit is always "assign the canonical list". This fails if the merge
 * ever becomes an assignment again.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const AIV4 = fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v4.js'), 'utf8');

/** The id behind "AI Vision — Auto-Fill From Statement" → 📁 Upload File. This is
 *  the ONLY input wired to the HTML e-statement fast path (isCCOT && _isHtml). */
const STATEMENT_INPUT = 'ccot_ai_scan';

function declaredAccept(id) {
    const m = HTML.match(new RegExp(`<input type="file" accept="([^"]+)" id="${id}"`));
    return m ? m[1] : null;
}

function tokens(accept) {
    return String(accept || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Pull the REAL helper out of the shipped file and run it — not a reimplementation. */
function loadMerge() {
    const m = AIV4.match(/var EXTRA_ACCEPT_V5 = [\s\S]*?\n    function mergeAcceptV5\(declared, extra\) \{[\s\S]*?\n    \}/);
    expect(m, 'mergeAcceptV5 / EXTRA_ACCEPT_V5 not found — the patch was restructured, retarget this test').toBeTruthy();
    return new Function(`${m[0]}; return { mergeAcceptV5, EXTRA_ACCEPT_V5 };`)();
}

describe('the statement file input declares HTML', () => {
    it('found the input (guards a vacuous pass)', () => {
        expect(declaredAccept(STATEMENT_INPUT),
            `#${STATEMENT_INPUT} is gone or its accept moved — retarget this test`).toBeTruthy();
    });

    for (const t of ['text/html', '.html', '.htm']) {
        it(`accepts ${t}`, () => {
            expect(tokens(declaredAccept(STATEMENT_INPUT)),
                `the statement picker would grey out HTML e-statements (missing ${t})`).toContain(t);
        });
    }

    it('still accepts PDFs and photos, which is the common case', () => {
        const got = tokens(declaredAccept(STATEMENT_INPUT));
        expect(got).toContain('application/pdf');
        expect(got).toContain('.pdf');
        expect(got.some((x) => x.startsWith('image/'))).toBe(true);
    });
});

describe('the runtime patch may not strip what the markup declares', () => {
    it('patchFileInputsV5 merges rather than assigns', () => {
        const body = AIV4.slice(AIV4.indexOf('function patchFileInputsV5'),
            AIV4.indexOf('// Add drag-drop on AI chat area'));
        expect(body.length).toBeGreaterThan(200);
        expect(body, 'patchFileInputsV5 assigns a literal accept again, discarding the '
            + "element's declared types — this is what greyed out HTML statements on iOS")
            .not.toMatch(/inp\.accept\s*=\s*['"]/);
        expect(body, 'patchFileInputsV5 no longer merges the declared accept')
            .toMatch(/inp\.accept\s*=\s*mergeAcceptV5\(\s*inp\.getAttribute\(['"]accept['"]\)/);
    });

    it('no file input anywhere is assigned a literal accept without HTML while the '
        + 'statement input is in scope', () => {
        // Any surviving `x.accept = '<literal>'` in the v4 patch layer is the exact
        // shape of the original bug. The chat-attach patch had the same line.
        const literals = [...AIV4.matchAll(/\.accept\s*=\s*(['"])([^'"]*)\1/g)];
        const offenders = literals
            .filter(([, , v]) => !tokens(v).includes('.html'))
            .map((m) => AIV4.slice(0, m.index).split('\n').length);
        expect(offenders, `wealthflow-ai-v4.js assigns a literal accept without HTML at `
            + `line(s) ${offenders.join(', ')} — merge the declared value instead`).toEqual([]);
    });

    it('the DECLARED html survives the real patch (end-to-end, real code)', () => {
        const { mergeAcceptV5, EXTRA_ACCEPT_V5 } = loadMerge();
        const merged = tokens(mergeAcceptV5(declaredAccept(STATEMENT_INPUT), EXTRA_ACCEPT_V5));
        for (const t of ['text/html', '.html', '.htm']) {
            expect(merged, `the patch strips ${t} back off at runtime`).toContain(t);
        }
        // and the variants the patch exists to add are present too
        expect(merged).toContain('image/*');
        expect(merged).toContain('application/pdf');
    });

    it('is idempotent — it is called from more than one place', () => {
        const { mergeAcceptV5, EXTRA_ACCEPT_V5 } = loadMerge();
        const once = mergeAcceptV5(declaredAccept(STATEMENT_INPUT), EXTRA_ACCEPT_V5);
        expect(mergeAcceptV5(once, EXTRA_ACCEPT_V5)).toBe(once);
    });

    it('the old clobber would fail this test (guards the guard)', () => {
        const { mergeAcceptV5 } = loadMerge();
        const OLD = 'image/*,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.pdf,.PDF';
        // The bug was an ASSIGNMENT of OLD. Prove OLD genuinely lacks HTML, so the
        // assertions above are not passing for some unrelated reason.
        expect(tokens(OLD)).not.toContain('.html');
        // …and prove merging is what rescues it.
        expect(tokens(mergeAcceptV5('text/html,.html', OLD))).toContain('.html');
    });
});

describe('the HTML fast path can still recognise the file once picked', () => {
    it('detects by extension as well as MIME, because iOS often reports neither', () => {
        // Files handed over from iCloud Drive frequently arrive with an empty
        // file.type, so the name check is not redundant — it is the load-bearing one.
        const branch = AIV4.slice(AIV4.indexOf('HTML e-STATEMENT FAST PATH'),
            AIV4.indexOf('HTML e-STATEMENT FAST PATH') + 900);
        expect(branch).toMatch(/text\\\/html/);
        expect(branch, 'the extension fallback is gone — an iOS file with an empty '
            + 'type would no longer be recognised as a statement').toMatch(/\\\.html\?\$/);
    });
});
