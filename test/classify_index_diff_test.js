/* =============================================================================
 * test/classify_index_diff_test.js
 * -----------------------------------------------------------------------------
 * WHAT IS BEING PINNED
 *
 * autonomy/classify-index-diff.mjs creates a path by which a change to
 * index.html can merge WITHOUT a human approval. policy/wealthflow.rego RULE 2
 * exists because "the most attractive fix for any failing check is to delete the
 * check", and a content-aware downgrade is the most sophisticated version of
 * exactly that. So this suite is not here to show the classifier works on good
 * input. It is here to show it REFUSES on bad input.
 *
 * Every test below that matters is run against KNOWN-BAD synthetic content. A
 * guard that is only ever exercised on a clean codebase proves nothing — that
 * lesson cost this project two rounds of tests that passed while the guard they
 * described was inert.
 *
 * THE ASSERTIONS PIN CONDITIONS, NOT TEXT.
 * An earlier generation of tests in this repo asserted that a line of source
 * "was present", so mutating `if (x)` to `if (false)` left the text in place and
 * the suite stayed green. Everything here calls the real function and asserts on
 * its returned verdict.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    SELF_PATH, MAX_CHANGED_LINES, MAX_TOUCHED_DECLS, UNATTENDED_SYMBOLS,
    scanRegions, tokenizeRegion, findDeclarations, looksPrivileged, nameSegments,
    sweepLine, parseUnifiedDiff, classify,
} from '../autonomy/classify-index-diff.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/* Real `git diff --unified=0` between two texts. The classifier parses git's
 * output, so generating the diff any other way would test the parser against a
 * generator written by the same hand. */
function gitDiff(a, b) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wfclass-'));
    try {
        fs.writeFileSync(path.join(d, 'a'), a);
        fs.writeFileSync(path.join(d, 'b'), b);
        try {
            execFileSync('git', ['diff', '--no-index', '--unified=0', '--no-color', 'a', 'b'],
                { cwd: d, encoding: 'utf8', maxBuffer: 1 << 28 });
            return '';
        } catch (e) {
            if (e.status === 1) return e.stdout;   // git: files differ
            throw e;
        }
    } finally {
        fs.rmSync(d, { recursive: true, force: true });
    }
}

const verdict = (baseText, headText, changedFiles = ['index.html']) =>
    classify({ baseText, headText, diff: gitDiff(baseText, headText), changedFiles });

/* A miniature index.html with the same shape as the real one: a style block, a
 * markup body, and a script block holding one allowlisted symbol and one that
 * is not on the list. `fmtN` is a real entry in UNATTENDED_SYMBOLS. */
const DOC = [
    /*  1 */ '<!doctype html>',
    /*  2 */ '<html><head>',
    /*  3 */ '<style>',
    /*  4 */ '.card { padding: 12px; }',
    /*  5 */ '.card .value { font-size: 14px; }',
    /*  6 */ '</style>',
    /*  7 */ '</head><body>',
    /*  8 */ '<div id="host"></div>',
    /*  9 */ '<p>Hello</p>',
    /* 10 */ '<script>',
    /* 11 */ '    var BOOT = 1;',
    /* 12 */ '    const fmtN = (n) => Number(n).toFixed(2);',
    /* 13 */ '    function renderRunway(days) {',
    /* 14 */ '        return fmtN(days);',
    /* 15 */ '    }',
    /* 16 */ '</script>',
    /* 17 */ '</body></html>',
].join('\n');

const edit = (i, text) => { const L = DOC.split('\n'); L[i - 1] = text; return L.join('\n'); };
const insertAfter = (i, ...text) => {
    const L = DOC.split('\n'); L.splice(i, 0, ...text); return L.join('\n');
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. REGION SCANNING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('scanRegions', () => {
    it('separates style, markup, script, and boundary lines', () => {
        const r = scanRegions(DOC.split('\n'));
        expect(r[2]).toBe('boundary');   // <style>
        expect(r[3]).toBe('style');
        expect(r[5]).toBe('boundary');   // </style>
        expect(r[7]).toBe('markup');
        expect(r[9]).toBe('boundary');   // <script>
        expect(r[10]).toBe('script');
        expect(r[15]).toBe('boundary');  // </script>
        expect(r[16]).toBe('markup');
    });

    it('does NOT treat the text "<script>" inside a script body as a new block', () => {
        // index.html:6967 really contains `// The four Firebase <script> tags`.
        // A scanner that re-opened on it would still be in `script` afterwards by
        // luck; the failure shows up as a mis-marked boundary line, which is
        // always sensitive and would gate that comment forever.
        const lines = ['<script>', '// see the <script> tags above', 'var a = 1;', '</script>'];
        const r = scanRegions(lines);
        expect(r[1]).toBe('script');
        expect(r[2]).toBe('script');
    });

    it('DOES end the block on `</script` inside a body, exactly as a browser does', () => {
        const lines = ['<script>', 'var s = "</script>";', 'still markup', '<p>x</p>'];
        const r = scanRegions(lines);
        expect(r[1]).toBe('boundary');
        expect(r[2]).toBe('markup');
    });

    it('marks a single-line `<script src=...></script>` as a boundary and stays in markup', () => {
        const lines = ['<p>a</p>', '<script src="m.js" defer></script>', '<p>b</p>'];
        const r = scanRegions(lines);
        expect(r[1]).toBe('boundary');
        expect(r[2]).toBe('markup');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. THE TOKENISER — the load-bearing integrity check
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('tokenizeRegion', () => {
    const ok = (src) => tokenizeRegion(src).ok;

    it('balances plain code', () => {
        expect(ok('function a() { if (x) { y(); } }')).toBe(true);
    });

    it('ignores braces inside single- and double-quoted strings', () => {
        const t = tokenizeRegion('var a = "{{{";\nvar b = \'}}}\';\n');
        expect(t.ok).toBe(true);
        expect(t.lineDepth[2]).toBe(0);
    });

    it('ignores braces inside comments', () => {
        const t = tokenizeRegion('// {{{\n/* }}} */\nvar a = 1;\n');
        expect(t.ok).toBe(true);
        expect(t.lineDepth[2]).toBe(0);
    });

    it('handles template literals, including nested ${} substitutions', () => {
        const t = tokenizeRegion('var h = `a${ {x:1}.x }b${ `${ 2 }` }c`;\nvar z = 0;\n');
        expect(t.ok).toBe(true);
        expect(t.lineDepth[1]).toBe(0);
    });

    it('ignores braces inside regex literals and their character classes', () => {
        const t = tokenizeRegion('var re = /[{}]{1,2}/g;\nvar z = 0;\n');
        expect(t.ok).toBe(true);
        expect(t.lineDepth[1]).toBe(0);
    });

    it('does not mistake division for a regex literal', () => {
        const t = tokenizeRegion('var a = b / c;\nvar d = e / f;\nvar z = 0;\n');
        expect(t.ok).toBe(true);
        expect(t.lineDepth[2]).toBe(0);
    });

    it('REFUSES when the region ends at a non-zero brace depth', () => {
        const t = tokenizeRegion('function a() { if (x) {');
        expect(t.ok).toBe(false);
        expect(t.reason).toMatch(/depth/);
    });

    it('REFUSES when brace depth goes negative', () => {
        const t = tokenizeRegion('} function a() {}');
        expect(t.ok).toBe(false);
        expect(t.reason).toMatch(/negative/);
    });

    it('REFUSES an unterminated string literal', () => {
        const t = tokenizeRegion('var a = "oops;\nvar b = 1;\n');
        expect(t.ok).toBe(false);
    });

    it('REFUSES a region that ends inside a block comment', () => {
        const t = tokenizeRegion('/* never closed\nvar a = 1;\n');
        expect(t.ok).toBe(false);
        expect(t.reason).toMatch(/block/);
    });

    it('reports the brace depth at the start of each line', () => {
        const t = tokenizeRegion('function a() {\n  var x = 1;\n}\nvar y = 2;\n');
        expect(t.lineDepth[0]).toBe(0);
        expect(t.lineDepth[1]).toBe(1);
        expect(t.lineDepth[2]).toBe(1);
        expect(t.lineDepth[3]).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. THE REAL index.html — the integrity check that actually matters
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the real index.html', () => {
    const text = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const lines = text.split('\n');
    const regions = scanRegions(lines);
    const blocks = [];
    {
        let start = -1;
        for (let i = 0; i <= regions.length; i++) {
            if (i < regions.length && regions[i] === 'script') { if (start < 0) start = i; }
            else if (start >= 0) { blocks.push([start, i - 1]); start = -1; }
        }
    }

    it('parses every script block with the depth returning to zero', () => {
        // If this ever fails, the classifier will refuse to classify anything —
        // which is the safe outcome, but it means the file grew a construct the
        // tokeniser does not model and the reason belongs in the failure message.
        expect(blocks.length).toBeGreaterThan(0);
        for (const [a, b] of blocks) {
            const t = tokenizeRegion(lines.slice(a, b + 1).join('\n'));
            expect(t.ok, `script block at line ${a + 1}: ${t.reason}`).toBe(true);
        }
    });

    it('finds the top-level declarations, and finds a lot of them', () => {
        let n = 0;
        for (const [a, b] of blocks) {
            const body = lines.slice(a, b + 1);
            n += findDeclarations(body, a, tokenizeRegion(body.join('\n'))).length;
        }
        expect(n).toBeGreaterThan(400);
    });

    it('EVERY allowlisted symbol still exists as a top-level declaration', () => {
        // A stale allowlist is a silent one: an entry naming a symbol that no
        // longer exists costs nothing and hides the fact that the list was never
        // revisited. A renamed symbol must fall OFF the list, not linger on it.
        const names = new Set();
        for (const [a, b] of blocks) {
            const body = lines.slice(a, b + 1);
            for (const d of findDeclarations(body, a, tokenizeRegion(body.join('\n')))) {
                names.add(d.name);
            }
        }
        for (const sym of UNATTENDED_SYMBOLS) {
            expect(names.has(sym), `${sym} is on the allowlist but is not a top-level declaration`).toBe(true);
        }
    });

    it('EVERY allowlisted symbol has a body that is still inert', () => {
        // Membership is necessary, not sufficient — but if a listed symbol has
        // already grown a capability, the list itself is wrong and should be
        // corrected rather than relied on to be overridden at classify time.
        const decls = [];
        for (const [a, b] of blocks) {
            const body = lines.slice(a, b + 1);
            const found = findDeclarations(body, a, tokenizeRegion(body.join('\n')));
            for (let k = 0; k < found.length; k++) {
                decls.push({
                    name: found[k].name,
                    line: found[k].line,
                    end: (k + 1 < found.length) ? found[k + 1].line - 1 : b,
                });
            }
        }
        for (const sym of UNATTENDED_SYMBOLS) {
            for (const d of decls.filter((x) => x.name === sym)) {
                for (let i = d.line; i <= d.end; i++) {
                    const why = sweepLine(lines[i], regions[i]);
                    expect(why, `${sym} reaches ${why} at index.html:${i + 1}`).toBe(null);
                }
            }
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. THE ALLOWLIST IS AN ALLOWLIST
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the unattended-symbol allowlist', () => {
    it('contains nothing that looks privileged', () => {
        for (const sym of UNATTENDED_SYMBOLS) {
            expect(looksPrivileged(sym), `${sym} is on the allowlist and looks privileged`).toBe(false);
        }
    });

    it('is small — this is a list somebody read, not a list that accumulated', () => {
        expect(UNATTENDED_SYMBOLS.size).toBeLessThanOrEqual(40);
    });

    it('the advisory denylist catches the names that defeated the first design', () => {
        // These nine were all pronounced "free" by the name-based version of this
        // classifier. The denylist is no longer load-bearing, but it is the thing
        // that guards the allowlist, so it must recognise them.
        for (const n of ['signInWithGoogle', 'appData', '_wfDedupRecordIds',
            '_wfExpectBulkRemoval', '_wfRehydrateFromDisk', '_WF_KUT_EXEMPT',
            '_computeCashAdvanceFee', '_computeFuelFee', 'onmousemove']) {
            expect(looksPrivileged(n), `${n} slipped past the denylist`).toBe(true);
        }
    });

    it('splits camelCase and underscores into segments', () => {
        expect(nameSegments('_wfApplyCloudData')).toEqual(['wf', 'apply', 'cloud', 'data']);
        expect(nameSegments('WF_APP_VERSION')).toEqual(['wf', 'app', 'version']);
        expect(nameSegments('signInWithGoogle')).toEqual(['sign', 'in', 'with', 'google']);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. THE CONTENT SWEEP — every pattern run against known-bad input
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('sweepLine', () => {
    const BAD = [
        ['<script src="x.js"></script>', 'a script tag'],
        ['<iframe src="x"></iframe>', 'an embedding'],
        ['<form action="/x">', 'a form'],
        ['<button formaction="/x">go</button>', 'formaction'],
        ['<div onclick="go()">x</div>', 'an inline handler'],
        ['<a href="javascript:go()">x</a>', 'a javascript: URL'],
        ['<iframe srcdoc="<b>x</b>">', 'srcdoc'],
        ['<img src="data:text/html,<script>">', 'a data:text/html URL'],
        ['eval("x")', 'eval'],
        ['var f = new Function("return 1");', 'new Function'],
        ['el.innerHTML = render(rows);', 'innerHTML with a value'],
        ['el.insertAdjacentHTML("beforeend", s);', 'insertAdjacentHTML'],
        ['document.write("x");', 'document.write'],
        ['localStorage.setItem("k", v);', 'localStorage'],
        ['sessionStorage.getItem("k");', 'sessionStorage'],
        ['await fetch("/api/x");', 'fetch'],
        ['new XMLHttpRequest();', 'XMLHttpRequest'],
        ['navigator.serviceWorker.register("/sw.js");', 'serviceWorker'],
        ['w.postMessage({a:1});', 'postMessage'],
        ['firebase.firestore().doc(p).set(v);', 'firebase'],
        ['await crypto.subtle.digest("SHA-256", b);', 'crypto.subtle'],
        ['var s = atob(x);', 'atob'],
        ['.x { behavior: url(#default#x); }', 'a legacy CSS vector'],
        ['@import url("//evil/x.css");', 'a CSS @import'],
    ];

    for (const [line, label] of BAD) {
        it(`rejects ${label}`, () => {
            expect(sweepLine(line, 'script'), line).not.toBe(null);
        });
    }

    const GOOD = [
        '.card { border-radius: 14px; padding: 16px 20px; }',
        '<div id="wfRunwayHost" class="wf-runway-card"></div>',
        'return Number(n).toFixed(2);',
        'const MONTHS = ["Jan", "Feb", "Mar"];',
        'el.textContent = String(v);',
    ];
    for (const line of GOOD) {
        it(`allows: ${line.slice(0, 44)}`, () => {
            expect(sweepLine(line, 'script'), line).toBe(null);
        });
    }

    it('allows `innerHTML = ""` — there is nothing to interpolate', () => {
        expect(sweepLine("host.innerHTML = '';", 'script')).toBe(null);
        expect(sweepLine('host.innerHTML = "";', 'script')).toBe(null);
        expect(sweepLine('host.innerHTML = `<b>static</b>`;', 'script')).toBe(null);
    });

    it('does NOT extend that exemption to a concatenation or a substitution', () => {
        // The clear-exemption anchors at end-of-statement precisely so a prefix
        // match cannot carry a payload past it.
        expect(sweepLine("host.innerHTML = '' + userText;", 'script')).not.toBe(null);
        expect(sweepLine('host.innerHTML = `<b>${userText}</b>`;', 'script')).not.toBe(null);
        expect(sweepLine("host.innerHTML = ''; danger(x);", 'script')).not.toBe(null);
    });

    it('lets an ordinary closing tag through in markup', () => {
        // Rejecting `</` cost a plain version-string bump in the settings panel,
        // and this app builds all of its UI from HTML template literals.
        expect(sweepLine('  <div class="setting-info">WealthFlow v7.69.24</div>', 'markup')).toBe(null);
        expect(sweepLine('  html += `<div class="row">${label}</div>`;', 'script')).toBe(null);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. DIFF PARSING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('parseUnifiedDiff', () => {
    it('reads line numbers on both sides of a real git diff', () => {
        const a = 'one\ntwo\nthree\n';
        const b = 'one\nTWO\nthree\nfour\n';
        const { removed, added } = parseUnifiedDiff(gitDiff(a, b));
        expect(removed).toEqual([{ line: 2, text: 'two' }]);
        expect(added.map((x) => x.line)).toEqual([2, 4]);
        expect(added.map((x) => x.text)).toEqual(['TWO', 'four']);
    });

    it('handles a pure deletion and a pure insertion', () => {
        expect(parseUnifiedDiff(gitDiff('a\nb\nc\n', 'a\nc\n')).removed)
            .toEqual([{ line: 2, text: 'b' }]);
        expect(parseUnifiedDiff(gitDiff('a\nc\n', 'a\nb\nc\n')).added)
            .toEqual([{ line: 2, text: 'b' }]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 7. THE VERDICT — the only thing a workflow reads
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('classify — what it lets through', () => {
    it('allows a CSS value change', () => {
        const r = verdict(DOC, edit(4, '.card { padding: 16px; }'));
        expect(r.verdict).toBe('safe');
        expect(r.regions).toEqual(['style']);
    });

    it('allows new CSS rules', () => {
        const r = verdict(DOC, insertAfter(5,
            '.wf-runway { border-radius: 14px; }',
            '.wf-runway .value { font-variant-numeric: tabular-nums; }'));
        expect(r.verdict).toBe('safe');
    });

    it('allows a plain markup container', () => {
        const r = verdict(DOC, insertAfter(8, '<div id="wfRunwayHost" class="wf-runway"></div>'));
        expect(r.verdict).toBe('safe');
        expect(r.regions).toEqual(['markup']);
    });

    it('allows an edit inside an allowlisted symbol, and names it', () => {
        const r = verdict(DOC, edit(12, '    const fmtN = (n) => Number(n).toFixed(2) + "";'));
        expect(r.verdict).toBe('safe');
        expect(r.functions).toEqual(['fmtN']);
    });
});

describe('classify — what it refuses', () => {
    const refuses = (name, headText, pattern) => {
        it(name, () => {
            const r = verdict(DOC, headText);
            expect(r.verdict).toBe('sensitive');
            if (pattern) expect(r.reason).toMatch(pattern);
        });
    };

    refuses('an edit inside a symbol that is not on the allowlist',
        edit(14, '        return fmtN(days) + "d";'), /renderRunway.*allowlist/);

    refuses('a NEW top-level symbol, because it is not on the allowlist either',
        insertAfter(12, '    const sneak = () => 1;'), /allowlist/);

    refuses('a changed line in the script preamble, before any declaration',
        edit(11, '    var BOOT = 2;'), /allowlist/);

    refuses('a changed line in a script region with no declaration at all',
        [
            '<html><body>', '<script>', '  doThing();', '</script>', '</body></html>',
        ].join('\n').replace('  doThing();', '  doThingElse();'),
        /.*/);

    refuses('an inline event handler added to markup',
        insertAfter(8, '<div onclick="go()">x</div>'), /event-handler/);

    refuses('a script tag added to markup',
        insertAfter(8, '<script src="evil.js"></script>'), /boundary|script tag/);

    refuses('an @import smuggled into the stylesheet',
        insertAfter(5, '@import url("//evil/x.css");'), /@import/);

    refuses('a moved region boundary',
        edit(16, '</script> '), /boundary/);

    refuses('a storage write inside an allowlisted symbol',
        edit(12, '    const fmtN = (n) => { localStorage.setItem("n", n); return n; };'),
        /storage/);

    refuses('a network call inside an allowlisted symbol',
        edit(12, '    const fmtN = (n) => fetch("/x").then(() => n);'), /network/);

    /* THE BODY SWEEP NEEDS ITS OWN CASE, AND HERE IS WHY.
     *
     * The two tests above put `localStorage.setItem` and `fetch(` on the CHANGED
     * line, so the added-line sweep rejected them before attribution ever ran.
     * Both passed, and a mutation blanking the body sweep entirely left the suite
     * green — the guard was untested by the tests written for it.
     *
     * What the body sweep actually defends is the other shape: an allowlisted
     * symbol that ALREADY contains a capability, edited on a line that is itself
     * perfectly clean. Membership must not be a standing permit. */
    const DIRTY_BODY = [
        '<html><head><style>', '.card { padding: 12px; }', '</style></head><body>',
        '<script>',
        '    var BOOT = 1;',
        '    const fmtN = function (n) {',
        '        var places = 2;',
        "        localStorage.setItem('lastFmt', n);",
        '        return Number(n).toFixed(places);',
        '    };',
        '</script>', '</body></html>',
    ].join('\n');
    const CLEAN_BODY = DIRTY_BODY.split('\n')
        .filter((l) => !l.includes('localStorage')).join('\n');
    const bump = (doc) => doc.replace('var places = 2;', 'var places = 3;');

    it('refuses a clean edit inside an allowlisted symbol whose body is not clean', () => {
        const r = verdict(DIRTY_BODY, bump(DIRTY_BODY));
        expect(r.verdict).toBe('sensitive');
        expect(r.reason).toMatch(/fmtN is on the allowlist.*storage/);
    });

    it('and allows the same edit once that capability is gone — it is the body, not the name', () => {
        // The control. Without it the test above would also pass if the symbol
        // were simply being rejected for some unrelated reason.
        expect(verdict(CLEAN_BODY, bump(CLEAN_BODY)).verdict).toBe('safe');
    });

    it('refuses when this file is itself in the changed set', () => {
        // A pull request must not be able to edit the classifier and then be
        // judged by the edited version. The change here is otherwise safe.
        const r = verdict(DOC, edit(4, '.card { padding: 16px; }'),
            ['index.html', SELF_PATH]);
        expect(r.verdict).toBe('sensitive');
        expect(r.reason).toMatch(/classifier itself/);
    });

    it('refuses a diff it could not parse any changed lines out of', () => {
        expect(classify({ baseText: DOC, headText: DOC, diff: '' }).verdict).toBe('sensitive');
    });

    it('refuses when the file is missing on one side', () => {
        expect(classify({ baseText: undefined, headText: DOC, diff: 'x' }).verdict).toBe('sensitive');
        expect(classify({ baseText: DOC, headText: undefined, diff: 'x' }).verdict).toBe('sensitive');
    });

    it('refuses when the head file will not tokenise', () => {
        // A file the parser cannot model is a file the classifier has no opinion
        // about, and "no opinion" must read as "sensitive", never as "safe".
        const broken = DOC.replace('    var BOOT = 1;', '    var BOOT = 1; if (x) {');
        const r = verdict(DOC, broken);
        expect(r.verdict).toBe('sensitive');
        expect(r.reason).toMatch(/could not be parsed/);
    });

    it('refuses a change larger than the line cap, even an all-CSS one', () => {
        const rules = Array.from({ length: MAX_CHANGED_LINES + 5 },
            (_, i) => `.gen-${i} { padding: ${i}px; }`);
        const r = verdict(DOC, insertAfter(5, ...rules));
        expect(r.verdict).toBe('sensitive');
        expect(r.reason).toMatch(new RegExp(String(MAX_CHANGED_LINES)));
    });

    it('caps the number of distinct symbols a single unattended change may touch', () => {
        expect(MAX_TOUCHED_DECLS).toBeGreaterThan(0);
        expect(MAX_TOUCHED_DECLS).toBeLessThanOrEqual(80);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 8. THE DEFAULT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('classify fails closed', () => {
    it('never returns "safe" from a thrown error', () => {
        // classify() is total by construction, but the property that matters is
        // that no input shape produces a permissive verdict by accident.
        for (const bad of [
            { baseText: null, headText: null, diff: null },
            { baseText: DOC, headText: DOC, diff: '@@ garbage @@' },
            { baseText: '', headText: '', diff: '@@ -1 +1 @@\n-a\n+b\n' },
        ]) {
            let r;
            try { r = classify(bad); } catch { r = { verdict: 'threw' }; }
            expect(r.verdict, JSON.stringify(bad).slice(0, 60)).not.toBe('safe');
        }
    });

    it('only ever emits one of two verdicts', () => {
        for (const r of [
            verdict(DOC, edit(4, '.card { padding: 16px; }')),
            verdict(DOC, edit(14, '        return 1;')),
        ]) {
            expect(['safe', 'sensitive']).toContain(r.verdict);
        }
    });
});
