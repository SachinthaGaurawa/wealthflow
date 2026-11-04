/* =============================================================================
 * test/swarm_patch_test.js
 * -----------------------------------------------------------------------------
 * The fix agent failed twice on a REAL report (#492, "show the build id in
 * Settings > Software update") because
 *   (a) it chose a file from a list of bare filenames (version.js, then
 *       pwa-updater.js — a module nothing loads), and
 *   (b) the file that owns the screen, wealthflow-update-system.js (~115 KB),
 *       was far past what a model can reproduce whole, so it was never offered.
 *
 * autonomy/swarm-patch.mjs fixes both: the report's own words are searched for in
 * the code, and big files are edited with exact SEARCH/REPLACE blocks that must
 * each occur exactly once. These tests pin the contract, and then drive the REAL
 * runSwarm() end-to-end with a scripted model so the new flow is executed, not
 * just parsed.
 * ===========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Script the model; keep the real stripFences / extractJson helpers.
const script = { replies: [], calls: [] };
vi.mock('../autonomy/llm-router.mjs', async () => {
    const actual = await vi.importActual('../autonomy/llm-router.mjs');
    return {
        ...actual,
        chat: async (o) => {
            script.calls.push(o);
            const next = script.replies.shift();
            if (next === undefined) throw new Error('script exhausted');
            if (next instanceof Error) throw next;
            return { text: next, provider: o.exclude && o.exclude.includes('p1') ? 'p2' : 'p1' };
        },
    };
});

const {
    keywordsFrom, symbolsFrom, definitionRange, rankFiles, excerptFor, parsePatchBlocks, applyPatchBlocks,
    changeExcerpt, changeView, selectPromptRanked, patchPrompt,
} = await import('../autonomy/swarm-patch.mjs');
const { runSwarm, MAX_AUTHORABLE_BYTES, reviewPrompt, reviewSeesWholeChange, REVIEW_DIFF_MAX } = await import('../autonomy/agent-swarm.mjs');

const ISSUE = 'Show the build id (the short deploy sha) next to the version in Settings > Software update so I can see which build I run.';

describe('keywordsFrom — the report\'s own words', () => {
    it('keeps identifiers and UI words, drops filler', () => {
        const k = keywordsFrom(ISSUE);
        expect(k).toContain('build');
        expect(k).toContain('settings');
        expect(k).toContain('software');
        expect(k).toContain('update');
        expect(k).not.toContain('the');
        expect(k).not.toContain('which');
    });

    it('ranks `code`-quoted tokens and file names above ordinary words', () => {
        const k = keywordsFrom('The `_installedVersion` helper in wealthflow-update-system.js shows the wrong number');
        expect(k.indexOf('_installedversion')).toBeLessThan(k.indexOf('wrong'));
        expect(k.indexOf('wealthflow-update-system.js')).toBeLessThan(k.indexOf('wrong'));
    });

    it('splits camelCase so a prose report finds the identifier', () => {
        const k = keywordsFrom('checkForUpdates never fires');
        expect(k).toEqual(expect.arrayContaining(['checkforupdates', 'check', 'updates']));
    });

    it('handles empty / non-string input', () => {
        expect(keywordsFrom('')).toEqual([]);
        expect(keywordsFrom(null)).toEqual([]);
        expect(keywordsFrom(undefined)).toEqual([]);
    });

    it('is bounded', () => {
        const long = Array.from({ length: 200 }, (_, i) => `word${i}abc`).join(' ');
        expect(keywordsFrom(long).length).toBeLessThanOrEqual(24);
    });
});

describe('rankFiles — pick by content, not by filename', () => {
    const files = {
        'version.js': 'module.exports = (req,res)=>res.json({version:"1"});',
        'pwa-updater.js': 'function checkForUpdate(){ /* nothing loads this */ }',
        'wealthflow-update-system.js': [
            '// Settings > Software update card',
            'function renderSoftwareUpdateCard(){',
            '  card.innerHTML = "Software update " + version;',
            '  // show build id here',
            '}',
            ...Array.from({ length: 30 }, () => 'var settings = software.update(version);'),
        ].join('\n'),
        'unrelated.js': 'console.log("hello");',
    };
    const readFile = (f) => files[f];

    it('puts the module that owns the screen first, with the matching lines as evidence', () => {
        const r = rankFiles(ISSUE, Object.keys(files), { readFile });
        expect(r[0].file).toBe('wealthflow-update-system.js');
        expect(r[0].snippets.length).toBeGreaterThan(0);
        expect(r[0].snippets[0]).toMatch(/^L\d+:/);
        expect(r.map((x) => x.file)).not.toContain('unrelated.js');
    });

    it('returns nothing (so the caller falls back) when no keyword matches', () => {
        expect(rankFiles('zzzz qqqq', Object.keys(files), { readFile })).toEqual([]);
    });

    it('skips unreadable files instead of throwing', () => {
        const r = rankFiles(ISSUE, ['gone.js', 'wealthflow-update-system.js'], { readFile: (f) => { if (f === 'gone.js') throw new Error('ENOENT'); return files[f]; } });
        expect(r[0].file).toBe('wealthflow-update-system.js');
    });

    it('selectPromptRanked shows the model evidence, not bare names', () => {
        const r = rankFiles(ISSUE, Object.keys(files), { readFile });
        const p = selectPromptRanked(ISSUE, r);
        expect(p).toMatch(/wealthflow-update-system\.js/);
        expect(p).toMatch(/L\d+:/);
        expect(p).toMatch(/NONE/);
    });
});

describe('excerptFor — windows around the relevant code, capped', () => {
    const big = Array.from({ length: 4000 }, (_, i) => (i === 2000 ? '  // SOFTWAREUPDATE card marker line' : `  var filler${i} = ${i};`)).join('\n');

    it('includes the marker and its context, not the file head', () => {
        const e = excerptFor(big, ['softwareupdate']);
        expect(e.text).toContain('SOFTWAREUPDATE card marker line');
        expect(e.text).toContain('filler1990');
        expect(e.text).not.toContain('filler5 ');
        expect(e.windows[0][0]).toBeGreaterThan(1900);
    });

    it('respects the character budget', () => {
        const many = Array.from({ length: 3000 }, (_, i) => `softwareupdate line ${i} ${'x'.repeat(40)}`).join('\n');
        const e = excerptFor(many, ['softwareupdate'], { maxChars: 4000 });
        expect(e.text.length).toBeLessThan(6000);
    });

    it('falls back to the top of the file when nothing matches', () => {
        const e = excerptFor('a\nb\nc', ['nomatch']);
        expect(e.text).toContain('a');
    });

    it('annotates windows with real line numbers', () => {
        const e = excerptFor(big, ['softwareupdate']);
        expect(e.text).toMatch(/\/\/ ----- lines \d+-\d+ -----/);
    });
});

// ── a function the report NAMES is always shown whole (issue #507) ───────────────────────────────────────────────────────────────
// Attempt 1/3 and 2/3 on #507 failed because `_renderSettingsCard`, named in code quotes in the report, was not in the excerpt: the
// ranking prefers windows dense in the report's words ("version" is on hundreds of lines). Verified on the real file: the function
// starts at line 491 and no window covered it.
describe('symbolsFrom / definitionRange / excerptFor({pin}) — the named function is never left out', () => {
    // 300 keyword-dense clusters (the report's own words on every line) with filler between them, and the named function in the
    // middle with NONE of those words inside its body, so only pinning can bring it in.
    const REPORT = 'In `paintRow` show the build id next to the version in Settings > Software update.';
    const dense = (i) => Array.from({ length: 8 }, (_, k) => `  // software update settings version build version ${i}.${k}`);
    const filler = (i) => Array.from({ length: 40 }, (_, k) => `  var pad_${i}_${k} = ${k};`);
    const parts = [];
    for (let i = 0; i < 300; i++) {
        parts.push(...dense(i), ...filler(i));
        if (i === 150) parts.push(
            '  function paintRow(el) {',
            '      const row = el.firstChild; // ROW_BODY_MARK',
            '      if (row) { row.textContent = "x"; }',
            '      return row;',
            '  }',
        );
    }
    const SRC = parts.join('\n');

    it('symbolsFrom takes code-quoted names and camelCase / _camelCase tokens, in their original case', () => {
        expect(symbolsFrom(REPORT)).toContain('paintRow');
        expect(symbolsFrom('the row in _renderSettingsCard and `sha` too')).toEqual(expect.arrayContaining(['_renderSettingsCard', 'sha']));
        expect(symbolsFrom('plain words only')).toEqual([]);
        expect(symbolsFrom('')).toEqual([]);
        expect(symbolsFrom(null)).toEqual([]);
    });

    it('definitionRange finds declarations, arrow consts and async functions, and stops at the closing brace', () => {
        const lines = ['// c', 'function a() {', '  if (x) { y(); }', '  return 1;', '}', 'const b = (q) => {', '  return q;', '};', 'async function c() { await d(); }', 'var z = 1;'];
        expect(definitionRange(lines, 'a')).toEqual([0, 4]);      // two lines of lead-in, whole body
        expect(definitionRange(lines, 'b')).toEqual([3, 7]);
        expect(definitionRange(lines, 'c')).toEqual([6, 8]);
        expect(definitionRange(lines, 'nope')).toBeNull();
        expect(definitionRange(lines, 'a b')).toBeNull();         // not an identifier
        expect(definitionRange(lines, '')).toBeNull();
        expect(definitionRange(lines, undefined)).toBeNull();
    });

    it('a call or a property named like the function is not mistaken for its definition', () => {
        const lines = ['paintRow(el);', 'obj.function paintRow = 1;', 'x = paintRowLater(el);', 'function paintRowLater() {', '}'];
        expect(definitionRange(lines, 'paintRow')).toBeNull();
    });

    it('a huge function is capped, not dumped whole', () => {
        const big = ['function huge() {', ...Array.from({ length: 500 }, (_, i) => `  call(${i});`), '}'];
        const r = definitionRange(big, 'huge');
        expect(r[1] - r[0]).toBeLessThanOrEqual(92);
    });

    it('WITHOUT pin the named function loses to the dense windows (this is the bug), WITH pin it is shown whole', () => {
        const kws = keywordsFrom(REPORT);
        expect(excerptFor(SRC, kws).text).not.toContain('ROW_BODY_MARK');
        const e = excerptFor(SRC, kws, { pin: symbolsFrom(REPORT) });
        expect(e.text).toContain('function paintRow(el) {');
        expect(e.text).toContain('ROW_BODY_MARK');
        expect(e.text).toContain('return row;');
        expect(e.text.length).toBeLessThanOrEqual(18_000 + 400);   // the budget still holds
    });

    it('a name that is not defined in the file changes nothing', () => {
        const kws = keywordsFrom(REPORT);
        expect(excerptFor(SRC, kws, { pin: ['doesNotExist'] }).text).toBe(excerptFor(SRC, kws).text);
    });

    it('pins that do not fit their share of the budget are dropped, so they cannot starve the ranked windows', () => {
        const kws = keywordsFrom(REPORT);
        const e = excerptFor(SRC, kws, { pin: symbolsFrom(REPORT), pinChars: 10 });
        expect(e.text).not.toContain('ROW_BODY_MARK');
    });
});

describe('parsePatchBlocks / applyPatchBlocks — exact, all-or-nothing edits', () => {
    const FILE = 'function a(){\n  return 1;\n}\nfunction b(){\n  return 2;\n}\n';
    const block = (s, r) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

    it('parses one and several blocks', () => {
        expect(parsePatchBlocks(block('x', 'y'))).toEqual([{ search: 'x', replace: 'y' }]);
        const two = block('a', 'b') + '\n\nsome chatter\n\n' + block('c', 'd');
        expect(parsePatchBlocks(two)).toHaveLength(2);
    });

    it('tolerates CRLF replies and surrounding prose', () => {
        const r = ('Here is the fix:\r\n' + block('x', 'y') + '\r\nDone').replace(/\n/g, '\r\n');
        expect(parsePatchBlocks(r)).toEqual([{ search: 'x', replace: 'y' }]);
    });

    it('returns [] for a reply with no blocks', () => {
        expect(parsePatchBlocks('CANNOT_FIX_SAFELY because')).toEqual([]);
        expect(parsePatchBlocks(null)).toEqual([]);
    });

    it('applies a unique SEARCH and changes only that spot', () => {
        const res = applyPatchBlocks(FILE, [{ search: '  return 1;', replace: '  return 10;' }]);
        expect(res.ok).toBe(true);
        expect(res.code).toBe('function a(){\n  return 10;\n}\nfunction b(){\n  return 2;\n}\n');
        expect(res.applied).toBe(1);
    });

    it('can insert next to an anchor line (SEARCH one line, REPLACE with it plus new lines)', () => {
        const res = applyPatchBlocks(FILE, [{ search: 'function b(){', replace: 'function b(){\n  log("b");' }]);
        expect(res.ok).toBe(true);
        expect(res.code).toContain('function b(){\n  log("b");\n  return 2;');
    });

    it('REFUSES a SEARCH that does not exist (the model invented it)', () => {
        const res = applyPatchBlocks(FILE, [{ search: 'return 99;', replace: 'return 100;' }]);
        expect(res.ok).toBe(false);
        expect(res.problems[0]).toMatch(/not found/);
    });

    it('REFUSES an ambiguous SEARCH rather than guessing which occurrence', () => {
        const res = applyPatchBlocks('x();\nx();\n', [{ search: 'x();', replace: 'y();' }]);
        expect(res.ok).toBe(false);
        expect(res.problems[0]).toMatch(/more than once/);
    });

    it('is all-or-nothing: one bad block means NO block is applied', () => {
        const res = applyPatchBlocks(FILE, [
            { search: '  return 1;', replace: '  return 10;' },
            { search: 'nope', replace: 'x' },
        ]);
        expect(res.ok).toBe(false);
        expect(res.code).toBeUndefined();
    });

    it('refuses empty SEARCH, identity replacement and empty patch', () => {
        expect(applyPatchBlocks(FILE, [{ search: '  ', replace: 'x' }]).ok).toBe(false);
        expect(applyPatchBlocks(FILE, [{ search: 'function a(){', replace: 'function a(){' }]).ok).toBe(false);
        expect(applyPatchBlocks(FILE, []).ok).toBe(false);
        expect(applyPatchBlocks(FILE, null).ok).toBe(false);
    });

    it('applies sequential blocks against the progressively edited text', () => {
        const res = applyPatchBlocks(FILE, [
            { search: '  return 1;', replace: '  return 10;' },
            { search: '  return 2;', replace: '  return 20;' },
        ]);
        expect(res.ok).toBe(true);
        expect(res.applied).toBe(2);
        expect(res.code).toContain('return 10;');
        expect(res.code).toContain('return 20;');
    });
});

describe('changeExcerpt — reviewers must see the CHANGE, not the top of the file', () => {
    const head = Array.from({ length: 500 }, (_, i) => `// header ${i}`).join('\n');
    const before = `${head}\nfunction card(){ return "v1"; }\n`;
    const after = `${head}\nfunction card(){ return "v1 build " + sha; }\n`;

    it('shows the edited line and not the unchanged head', () => {
        const d = changeExcerpt(before, after);
        expect(d).toContain('+function card(){ return "v1 build " + sha; }');
        expect(d).toContain('-function card(){ return "v1"; }');
        expect(d).not.toContain('// header 3');
        expect(d).not.toMatch(/^diff --git/m);
    });

    it('truncates oversized diffs but says so', () => {
        const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
        const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
        const d = changeExcerpt(a, b, { max: 500 });
        expect(d.length).toBeLessThan(700);
        expect(d).toMatch(/diff truncated/);
    });

    it('changeView reports truncation, so a caller can refuse a change the reviewer did not see in full', () => {
        const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
        const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
        expect(changeView(a, b, { max: 500 }).truncated).toBe(true);
        expect(changeView(a, b, { max: 500 }).text).toBe(changeExcerpt(a, b, { max: 500 }));
        expect(changeView(a, b, { max: 1e6 }).truncated).toBe(false);
        expect(changeView('x\n', 'x\ny\n').truncated).toBe(false);
    });

    it('reviewSeesWholeChange: true for small files and small diffs of big files, false past the reviewer\'s limit', () => {
        expect(reviewSeesWholeChange('a', 'b')).toBe(true);
        expect(reviewSeesWholeChange(before, after)).toBe(true);                       // 500-line file, one-line edit
        const big = Array.from({ length: 6000 }, (_, i) => `line ${i} of the original module`).join('\n');
        const rewritten = Array.from({ length: 6000 }, (_, i) => `line ${i} of the REWRITTEN module`).join('\n');
        expect(big.length).toBeGreaterThan(REVIEW_DIFF_MAX);
        expect(reviewSeesWholeChange(big, rewritten)).toBe(false);
        expect(reviewSeesWholeChange(big, big + '\nonce more')).toBe(true);
    });

    it('reviewPrompt switches to the diff for big files and keeps excerpts for small ones', () => {
        expect(reviewPrompt(ISSUE, 'm.js', before, after)).toMatch(/unified diff/);
        expect(reviewPrompt(ISSUE, 'm.js', 'a', 'b')).toMatch(/BEFORE \(excerpt\)/);
    });

    it('patchPrompt states the exact reply format and the escape hatch', () => {
        const p = patchPrompt(ISSUE, 'f.js', 'EXCERPT', 1234);
        expect(p).toMatch(/<<<<<<< SEARCH/);
        expect(p).toMatch(/>>>>>>> REPLACE/);
        expect(p).toMatch(/CANNOT_FIX_SAFELY/);
        expect(p).toMatch(/1234 lines/);
    });
});

// ── the REAL runSwarm, with a scripted model ────────────────────────────────
describe('runSwarm — large-file patch mode, end to end', () => {
    let dir;
    beforeEach(() => {
        script.replies = []; script.calls = [];
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-swarm-'));
        fs.mkdirSync(path.join(dir, 'test'));
        // a decoy that matches by NAME only, and the real owner of the screen (> 32 KB)
        fs.writeFileSync(path.join(dir, 'version.js'), 'module.exports = function version(req,res){ res.end("x"); };\n');
        const filler = Array.from({ length: 1500 }, (_, i) => `    var pad${i} = ${i}; // padding to exceed whole-file limit`).join('\n');
        const owner = [
            '(function(){',
            filler,
            '    function renderSoftwareUpdateCard(el, version) {',
            '        el.textContent = "Software update v" + version;',
            '    }',
            '    window.renderSoftwareUpdateCard = renderSoftwareUpdateCard;',
            '})();',
            '',
        ].join('\n');
        expect(owner.length).toBeGreaterThan(MAX_AUTHORABLE_BYTES);
        fs.writeFileSync(path.join(dir, 'wealthflow-update-system.js'), owner);
    });

    const PATCH = [
        '<<<<<<< SEARCH',
        '        el.textContent = "Software update v" + version;',
        '=======',
        '        el.textContent = "Software update v" + version + " (build " + (window.__WF_BUILD || "?") + ")";',
        '>>>>>>> REPLACE',
    ].join('\n');

    it('selects by content, patches the 115 KB-class file, and hands the security reviewer the DIFF', async () => {
        script.replies = [
            'wealthflow-update-system.js',                                    // stage 1: select
            PATCH,                                                            // stage 2: patch
            '{"verdict":"PASS","severity":"none","findings":[],"reason":"display only"}', // stage 4
        ];
        const r = await runSwarm({ issue: { title: 'Show build id', body: ISSUE, number: 7, kind: 'feature' }, repoDir: dir, env: { CI: '' }, writeTest: false, log: () => {} });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.file).toBe('wealthflow-update-system.js');
        expect(r.code).toContain('(build ');
        expect(r.code).toContain('var pad1499'); // the rest of the file is intact

        // selection prompt carried evidence (matching lines), not bare names
        expect(script.calls[0].prompt).toMatch(/L\d+:/);
        // the model was asked for patch blocks, not a 115 KB rewrite
        expect(script.calls[1].prompt).toMatch(/<<<<<<< SEARCH/);
        expect(script.calls[1].prompt.length).toBeLessThan(40_000);
        // the independent reviewer saw the change itself
        expect(script.calls[2].prompt).toMatch(/unified diff/);
        expect(script.calls[2].prompt).toContain('(build ');
    });

    it('the function the report names reaches the author even when other windows are denser in the report\'s words (#507)', async () => {
        const dense = (i) => Array.from({ length: 8 }, (_, k) => `    // software update settings version build version ${i}.${k}`);
        const pad = (i) => Array.from({ length: 40 }, (_, k) => `    var pad_${i}_${k} = ${k};`);
        const parts = ['(function(){'];
        for (let i = 0; i < 60; i++) {                      // ~100 KB, like the real module, under the patchable ceiling
            parts.push(...dense(i), ...pad(i));
            if (i === 30) parts.push('    function paintRow(el) {', '        el.textContent = "row"; // NAMED_FN_BODY', '    }');
        }
        parts.push('})();', '');
        fs.writeFileSync(path.join(dir, 'wealthflow-update-system.js'), parts.join('\n'));
        fs.rmSync(path.join(dir, 'version.js'));   // one candidate: the owner of the screen
        const report = 'Show the build id next to the version in Settings > Software update. The text is written by `paintRow`.';
        const patch = '<<<<<<< SEARCH\n        el.textContent = "row"; // NAMED_FN_BODY\n=======\n        el.textContent = "row b"; // NAMED_FN_BODY\n>>>>>>> REPLACE';
        script.replies = ['wealthflow-update-system.js', patch, '{"verdict":"PASS","severity":"none","findings":[],"reason":"display only"}'];
        const r = await runSwarm({ issue: { title: 'Show build id', body: report, number: 507, kind: 'feature' }, repoDir: dir, env: { CI: '' }, writeTest: false, log: () => {} });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const authorCall = script.calls.find((c) => /<<<<<<< SEARCH/.test(c.prompt));
        expect(authorCall, 'the author was asked for patch blocks').toBeTruthy();
        expect(authorCall.prompt).toContain('function paintRow(el) {');
        expect(authorCall.prompt).toContain('NAMED_FN_BODY');
    });

    it('a rejected patch gets ONE retry with the reason, then a loud, specific failure', async () => {
        const bad = '<<<<<<< SEARCH\nthis line is not in the file\n=======\nx\n>>>>>>> REPLACE';
        script.replies = ['wealthflow-update-system.js', bad, bad, 'CANNOT_FIX_SAFELY this endpoint does not render the screen'];
        const r = await runSwarm({ issue: { title: 't', body: ISSUE, number: 8, kind: 'feature' }, repoDir: dir, env: { CI: '' }, writeTest: false, log: () => {} });
        expect(r.ok).toBe(false);
        expect(r.stage).toBe('author');
        expect(r.reason).toMatch(/patch could not be applied/);
        expect(r.reason).toMatch(/version\.js: CANNOT_FIX_SAFELY/);     // every candidate's obstacle is named
        expect(script.calls[2].prompt).toMatch(/PREVIOUS REPLY WAS REJECTED/);
        expect(fs.readFileSync(path.join(dir, 'wealthflow-update-system.js'), 'utf8')).toContain('"Software update v" + version;');
    });

    it('a wrong first pick does not end the run: the next best match is tried', async () => {
        script.replies = [
            'version.js',                                                      // select: the decoy
            'CANNOT_FIX_SAFELY this is an API endpoint, not the screen',       // decoy author attempt
            PATCH,                                                             // next candidate patches
            '{"verdict":"PASS","severity":"none","findings":[],"reason":"ok"}',
        ];
        const r = await runSwarm({ issue: { title: 'Show build id', body: ISSUE, number: 9, kind: 'feature' }, repoDir: dir, env: { CI: '' }, writeTest: false, log: () => {} });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.file).toBe('wealthflow-update-system.js');
    });

    it('the independent security veto still stops a patched change', async () => {
        script.replies = [
            'wealthflow-update-system.js', PATCH,
            '{"verdict":"FAIL","severity":"high","findings":["xss"],"reason":"unsafe sink"}',
        ];
        const r = await runSwarm({ issue: { title: 'Show build id', body: ISSUE, number: 10, kind: 'feature' }, repoDir: dir, env: { CI: '' }, writeTest: false, log: () => {} });
        expect(r.ok).toBe(false);
        expect(r.stage).toBe('security');
    });

    it('a patch that breaks syntax is refused by the mechanical gates, not shipped', async () => {
        const broken = [
            '<<<<<<< SEARCH',
            '        el.textContent = "Software update v" + version;',
            '=======',
            '        el.textContent = "Software update v" + ;',
            '>>>>>>> REPLACE',
        ].join('\n');
        script.replies = ['wealthflow-update-system.js', broken];
        const r = await runSwarm({ issue: { title: 'Show build id', body: ISSUE, number: 11, kind: 'feature' }, repoDir: dir, env: { CI: '' }, writeTest: false, log: () => {} });
        expect(r.ok).toBe(false);
        expect(['syntax', 'structure']).toContain(r.stage);
    });

    // Codex review on #493: the reviewer was handed only the first part of a long diff, and its
    // PASS was accepted for the whole change — edits after the cutoff skipped the veto.
    it('FAILS CLOSED when the change is longer than the security reviewer can read — a PASS on a prefix is not accepted', async () => {
        const bulk = Array.from({ length: 4000 }, (_, i) => `        var added${i} = ${i};`).join('\n');
        const huge = [
            '<<<<<<< SEARCH',
            '        el.textContent = "Software update v" + version;',
            '=======',
            '        el.textContent = "Software update v" + version;',
            bulk,
            '>>>>>>> REPLACE',
        ].join('\n');
        script.replies = [
            'wealthflow-update-system.js', huge,
            '{"verdict":"PASS","severity":"none","findings":[],"reason":"looked fine"}',   // must never be asked for
        ];
        const r = await runSwarm({ issue: { title: 'Show build id', body: ISSUE, number: 13, kind: 'feature' }, repoDir: dir, env: { CI: '' }, writeTest: false, log: () => {} });
        expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(false);
        expect(r.stage).toBe('review_too_large');
        expect(r.review.verdict).toBe('FAIL');
        expect(r.reason).toMatch(/split|smaller/);
        // the reviewer was never consulted about a change it could not read in full
        expect(script.calls.length).toBe(2);
    });

    it('sensitive files are never candidates, however well they match', async () => {
        fs.writeFileSync(path.join(dir, 'sw.js'), 'self.addEventListener("fetch", function(){}); // software update build id settings\n');
        fs.writeFileSync(path.join(dir, 'index.html'), '<html>software update build id settings</html>');
        script.replies = ['sw.js', ...Array(6).fill('CANNOT_FIX_SAFELY not mine')];
        const r = await runSwarm({ issue: { title: 'Show build id', body: ISSUE, number: 12, kind: 'feature' }, repoDir: dir, env: { CI: '' }, writeTest: false, log: () => {} });
        const touched = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8');
        expect(touched).toContain('self.addEventListener("fetch", function(){});');
        // sw.js was never in the offered list
        expect(script.calls[0].prompt).not.toMatch(/- sw\.js/);
        expect(r.file === undefined || r.file !== 'sw.js').toBe(true);
    });
});
