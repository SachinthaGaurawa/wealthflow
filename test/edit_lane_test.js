/* =============================================================================
 * test/edit_lane_test.js — the lane that may EDIT a screen that already exists   (owner, 2026-11-21)
 * -----------------------------------------------------------------------------
 * Pins: the scanner that tells template text from code, the markup guard (only the template text of ONE render function may change; a money
 * rule, a handler, a script, an unescaped field cannot get in), the CSS guard (the screen's own rules only, nothing that hides), the
 * find-and-replace mechanics, and the lane end to end with scripted model replies and a scripted phone run (no phone run, no change).
 * The positive fixtures are shaped like the real #655 change (a summary line and a Details button in renderCCI, rules in wf-ui.css).
 * ===========================================================================*/
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = { replies: [], prompts: [] };
vi.mock('../autonomy/llm-router.mjs', async (orig) => {
    const real = await orig();
    return { ...real, chat: vi.fn(async (o) => {
        script.prompts.push(String(o.prompt));
        const next = script.replies.shift();
        if (!next) throw new Error('no scripted reply left for: ' + String(o.prompt).slice(0, 60));
        return { text: typeof next === 'string' ? next : next.text, provider: (next && next.provider) || 'stub-author' };
    }) };
});

const E = await import('../autonomy/edit-lane.mjs');
const A = await import('../autonomy/acceptance.mjs');

const HTML = `<!doctype html><html><body><section id="page-demo"><div id="demoBody"></div></section><script>
function helperAbove() { return 1; }
function renderDemo() {
    /* months merged into one plan stay in the data */
    const arr = (DB.get('plans') || []).filter(x => x && !x.mergedInto);
    const host = $('demoBody');
    const total = arr.reduce((t, x) => t + (x.monthly || 0), 0);
    return arr.map(item => {
        const prog = progressOf(item);
        const finished = item.completed || /^done$/i.test(item.status);
        const count = (item.tags || []).length;
        return \`<tr class="\${finished ? 'done-row' : ''}"><td><div style="font-weight:600;">\${_wfEsc(item.product)}</div>\${item.notes ? \`<div class="td-m">\${_wfEsc(item.notes)}</div>\` : ''}</td><td>\${fmt(item.monthly)}</td><td><span class="pct wf-demo-sum">\${prog.pct}%</span> \${count}</td><td><button onclick="window.WFDemo && window.WFDemo.open('\${_wfJsAttr(item.id)}')">Edit</button></td></tr>\`;
    }).join('') + \`<tr><td>Total \${fmt(total)}</td></tr>\`;
}
function renderOther() { return \`<b>untouched</b>\`; }
</script></body></html>
`;
const CSS = `/* demo sheet */
#page-demo table { width: 100%; }
.wf-demo-sum { margin-top: 3px; font: 500 12px/1.4 sans-serif; color: #666; }
@media (max-width: 640px) { #page-demo td { padding: 8px 6px; } }
body { margin: 0; }
`;
const exists = (api, method) => api === 'WFDemo' && method === 'open';

/** The page after replacing `find` with `replace` inside renderDemo (a helper for the many small cases). */
const editHtml = (find, replace) => HTML.replace(find, replace);
const markup = (after) => E.checkMarkup({ before: HTML, after, fn: 'renderDemo', exists });

describe('scanSource: template text apart from code', () => {
    it('finds templates, expressions and nested templates, and ignores comments, strings and regexes', () => {
        const src = "const a = 'a `not` template'; // `nor this`\nconst r = /`x`\\/\\$\\{/g; const b = `x ${y ? `in ${z}` : ''} z`; /* `c` */";
        const { segs } = E.scanSource(src);
        const deep = E.gatherDeep(segs);
        expect(segs.filter((s) => s.k === 'tpl')).toHaveLength(1);
        expect(deep.tpls).toHaveLength(2);
        expect(deep.exprs.map((e) => e.e.trim())).toEqual(['y ? `in ${z}` : \'\'', 'z']);
    });
    it('the skeleton ignores template text and comments but not code', () => {
        const a = E.skeletonOf(E.scanSource('x = `a`; // c\ny = 1;').segs);
        const b = E.skeletonOf(E.scanSource('x = `b ${q}`; /* d */ y = 1;').segs);
        const c = E.skeletonOf(E.scanSource('x = `a`; y = 2;').segs);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
    });
    it('refuses what it cannot read instead of guessing', () => {
        expect(() => E.scanSource('x = `never closed')).toThrow();
        expect(() => E.scanSource("x = 'never closed\n'")).toThrow();
        expect(() => E.scanSource('function f() { if (a) {', 0, false)).not.toThrow();
        expect(() => E.scanSource('function f() { if (a) {', 0, true)).toThrow();
    });
});

describe('functionRange', () => {
    it('finds one render function with its exact extent', () => {
        const r = E.functionRange(HTML, 'renderDemo');
        expect(r.ok).toBe(true);
        expect(r.src.startsWith('function renderDemo()')).toBe(true);
        expect(r.src.endsWith('}')).toBe(true);
        expect(r.src).not.toMatch(/renderOther/);
    });
    it('refuses a name that is not a render function, a missing one, and one that occurs twice', () => {
        expect(E.functionRange(HTML, 'helperAbove').ok).toBe(false);
        expect(E.functionRange(HTML, 'renderMissing').ok).toBe(false);
        expect(E.functionRange(HTML + '\nfunction renderDemo() { return 1; }', 'renderDemo').ok).toBe(false);
    });
    it('reads the real renderCCI of this repository', () => {
        const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
        const r = E.functionRange(html, 'renderCCI');
        expect(r.ok).toBe(true);
        expect(r.src.length).toBeGreaterThan(2000);
        expect(E.gatherDeep(r.segs).tpls.length).toBeGreaterThan(3);
    });
});

describe('markup guard: what a screen edit may change', () => {
    it('lets text and markup change, like the real #655 summary line and Details button', () => {
        const after = editHtml("</td><td>${fmt(item.monthly)}</td>", "</td><td>${fmt(item.monthly)}<div class=\"wf-demo-sum\">${fmt(item.monthly)} a month · ${prog.pct} of ${count} paid · ${finished ? 'Done' : 'Active'}</div><button type=\"button\" class=\"wf-demo-open\" aria-label=\"Open the details of ${_wfEsc(item.product)}\" onclick=\"window.WFDemo &amp;&amp; window.WFDemo.open('${_wfJsAttr(item.id)}')\">Details &rsaquo;</button></td>");
        expect(markup(after)).toMatchObject({ ok: true, problems: [] });
    });
    it('lets a nested list use its own arrow parameter', () => {
        const after = editHtml('</td><td>${fmt(item.monthly)}</td>', '</td><td>${fmt(item.monthly)}${(item.tags || []).map(t => `<i>${_wfEsc(t)}</i>`).join(\'\')}</td>');
        expect(markup(after)).toMatchObject({ ok: true, problems: [] });
    });
    it('refuses arithmetic in a new expression (a money figure cannot be changed here)', () => {
        const after = editHtml('<td>${fmt(item.monthly)}</td>', '<td>${fmt(item.monthly * 2)}</td>');
        const r = markup(after);
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/not allowed in a new expression/);
    });
    it('refuses a change to code outside the templates: a condition, a name, a number, a statement', () => {
        for (const after of [
            editHtml('item.completed ||', 'item.done ||'),
            editHtml('(x.monthly || 0)', '(x.monthly || 1)'),
            editHtml("const count = (item.tags || []).length;", "const count = (item.tags || []).length; DB.set('plans', []);"),
            editHtml('const total = arr.reduce((t, x) => t + (x.monthly || 0), 0);', 'const total = 0;'),
        ]) {
            const r = markup(after);
            expect(r.ok).toBe(false);
            expect(r.problems.join(' ')).toMatch(/code outside the template literals/);
        }
    });
    it('refuses to touch anything outside the function', () => {
        expect(markup(editHtml('return 1;', 'return 2;')).problems.join(' ')).toMatch(/before renderDemo/);
        expect(markup(editHtml('<b>untouched</b>', '<b>touched</b>')).problems.join(' ')).toMatch(/after renderDemo/);
    });
    it('refuses a database write, a global, or a call to a function the screen does not already call', () => {
        for (const expr of ["DB.set('plans', [])", 'window.location', 'localStorage.clear()', 'eval(item.id)', 'item.constructor', 'stealMoney(item)', 'new Date()']) {
            const r = markup(editHtml('<td>${fmt(item.monthly)}</td>', `<td>\${fmt(item.monthly)}\${${expr}}</td>`));
            expect(r.ok, expr).toBe(false);
        }
    });
    it('refuses a raw record field on the page (an XSS sink) but allows a number and a condition', () => {
        const raw = markup(editHtml('<td>${fmt(item.monthly)}</td>', '<td>${fmt(item.monthly)}<p>${item.notes}</p></td>'));
        expect(raw.ok).toBe(false);
        expect(raw.problems.join(' ')).toMatch(/raw field/);
        expect(markup(editHtml('<td>${fmt(item.monthly)}</td>', '<td>${fmt(item.monthly)}<p>${_wfEsc(item.notes)}</p>${item.notes ? \'*\' : \'\'}${prog.pct}</td>')).ok).toBe(true);
    });
    it('refuses scripts, forms, external addresses, hiding and url()', () => {
        for (const bad of ['<script>1</script>', '<iframe src="x"></iframe>', '<form action="/x"></form>', '<a href="https://evil.example/">x</a>', '<img src="//evil.example/p.png">', '<a href="javascript:void 0">x</a>', '<p style="display:none">hidden</p>', '<p style="background:url(x)">y</p>', '<link rel="stylesheet" href="x">']) {
            const r = markup(editHtml('<td>${fmt(item.monthly)}</td>', `<td>\${fmt(item.monthly)}${bad}</td>`));
            expect(r.ok, bad).toBe(false);
        }
    });
    it('refuses a new event handler that is not a method of a module that exists, but keeps the ones already there', () => {
        for (const h of ["evil()", "window.WFNope.open('x')", "window.WFDemo.nothing('x')", "fetch('/x')", "window.WFDemo.open('x');evil()"]) {
            const r = markup(editHtml('<td>${fmt(item.monthly)}</td>', `<td>\${fmt(item.monthly)}<button onclick="${h}">b</button></td>`));
            expect(r.ok, h).toBe(false);
        }
        expect(markup(editHtml('<td>${fmt(item.monthly)}</td>', "<td>${fmt(item.monthly)}<button onclick=\"window.WFDemo.open('${_wfJsAttr(item.id)}')\">b</button></td>")).ok).toBe(true);
    });
    it('reads the real window.WFCCInstalmentDetail.open of this repository as an existing method', () => {
        expect(E.apiMethodExists('WFCCInstalmentDetail', 'open', path.resolve(import.meta.dirname, '..'))).toBe(true);
        expect(E.apiMethodExists('WFCCInstalmentDetail', 'launchMissiles', path.resolve(import.meta.dirname, '..'))).toBe(false);
    });
});

describe('CSS guard: only this screen\'s rules, nothing that hides', () => {
    const css = (add) => E.checkCss({ before: CSS, after: CSS + add, ownClasses: new Set(['wf-demo-open']) });
    it('accepts scoped layout and look rules, like the real #655 rules', () => {
        expect(css('.wf-demo-open { min-height: 44px; padding: 6px 14px; border: 1px solid #0a0; border-radius: 8px; color: #070; }\n@media (max-width: 640px) { #page-demo .wf-demo-sum { white-space: normal; overflow-wrap: anywhere; } }\n').ok).toBe(true);
        expect(css('#page-demo .wf-demo-note { overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; }').ok).toBe(true);
        expect(css('@media (min-width: 641px) { .wf-demo-open { display: none; } }').ok).toBe(true);   // the new element, off on a desktop
    });
    it('refuses a rule that is not about this screen', () => {
        for (const bad of ['body { padding: 0; }', 'td { padding: 0; }', '* { margin: 0; }', '.card { margin: 0; }', ':root { --x: 1; }']) expect(css(bad).ok, bad).toBe(false);
    });
    it('refuses hiding, cutting, url(), quotes and properties it does not know', () => {
        for (const bad of ['.wf-demo-sum { display: none; }', '#page-demo td { visibility: hidden; }', '.wf-demo-sum { opacity: 0; }', '.wf-demo-sum { font-size: 0; }', '.wf-demo-sum { color: transparent; }', '.wf-demo-sum { overflow: hidden; }', '.wf-demo-sum { background: url(x.png); }', '.wf-demo-sum { background: #fff; content: "x"; }', '.wf-demo-sum { animation: spin 1s; }', '.wf-demo-sum { pointer-events: none; }', '.wf-demo-sum { word-break: break-all; }', '#page-demo td { display: block; }', '@keyframes k { from { top: 0; } }', '@import "x.css";', '.wf-demo-sum { transform: rotate(3deg); }']) expect(css(bad).ok, bad).toBe(false);
        // display:none of something that existed before is hiding, even in a media query
        expect(E.checkCss({ before: CSS, after: CSS + '@media (max-width: 640px) { .wf-demo-sum { display: none; } }', ownClasses: new Set() }).ok).toBe(false);
    });
    it('lets a rule be changed but never deleted', () => {
        expect(E.checkCss({ before: CSS, after: CSS.replace('width: 100%', 'width: 99%') }).ok).toBe(true);
        const gone = E.checkCss({ before: CSS, after: CSS.replace('#page-demo table { width: 100%; }\n', '') });
        expect(gone.ok).toBe(false);
        expect(gone.problems.join(' ')).toMatch(/deleted/);
        expect(E.checkCss({ before: CSS, after: CSS.replace('body { margin: 0; }', 'body { margin: 1px; }') }).ok).toBe(false);
    });
    it('keeps the number of changed rules small', () => {
        const many = Array.from({ length: 16 }, (_, i) => `.wf-demo-r${i} { margin: ${i}px; }`).join('\n');
        expect(css(many).problems.join(' ')).toMatch(/limit is 14/);
    });
});

describe('edits: find-and-replace', () => {
    it('parses a good reply and refuses the rest', () => {
        expect(E.parseEdits({ edits: [{ file: 'index.html', find: 'a', replace: 'b' }], why: 'x' }).ok).toBe(true);
        for (const bad of [null, {}, { edits: [] }, { edits: [{ file: 'server.js', find: 'a', replace: 'b' }] }, { edits: [{ file: 'index.html', find: '', replace: 'b' }] }, { edits: [{ file: 'index.html', find: 'a', replace: 'a' }] }, { edits: Array(9).fill({ file: 'index.html', find: 'a', replace: 'b' }) }, { edits: [{ file: 'index.html', find: 'a', replace: 'b'.repeat(5000) }] }]) expect(E.parseEdits(bad).ok).toBe(false);
        expect(E.parseEdits({ feasible: false, why_not: 'needs a new number' })).toMatchObject({ ok: false });
    });
    it('applies each edit once, and refuses a find that is missing, repeated, outside the function, or overlapping', () => {
        const range = E.functionRange(HTML, 'renderDemo');
        const fnRangeOf = { start: range.start, end: range.end, name: 'renderDemo' };
        const ok = E.applyEdits({ 'index.html': HTML, 'wf-ui.css': CSS }, [{ file: 'index.html', find: 'Edit</button>', replace: 'Details</button>' }, { file: 'wf-ui.css', find: 'width: 100%', replace: 'width: 99%' }], { fnRangeOf });
        expect(ok.ok).toBe(true);
        expect(ok.files['index.html']).toContain('Details</button>');
        expect(ok.files['wf-ui.css']).toContain('99%');
        const files = { 'index.html': HTML, 'wf-ui.css': CSS };
        expect(E.applyEdits(files, [{ file: 'index.html', find: 'nothing like this', replace: 'x' }], { fnRangeOf }).problems.join(' ')).toMatch(/not there/);
        expect(E.applyEdits(files, [{ file: 'index.html', find: '<td>', replace: 'x' }], { fnRangeOf }).problems.join(' ')).toMatch(/more than once/);
        expect(E.applyEdits(files, [{ file: 'index.html', find: '<b>untouched</b>', replace: 'x' }], { fnRangeOf }).problems.join(' ')).toMatch(/outside the function/);
        expect(E.applyEdits(files, [{ file: 'wf-ui.css', find: '#page-demo table { width: 100%; }', replace: 'x' }, { file: 'wf-ui.css', find: 'width: 100%', replace: 'y' }], { fnRangeOf }).problems.join(' ')).toMatch(/overlap/);
    });
});

describe('perf ceiling', () => {
    it('raises htmlBytes to the measured value with headroom and a dated reason, and leaves it alone when it fits', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-edit-budget-'));
        fs.mkdirSync(path.join(dir, 'autonomy'));
        fs.writeFileSync(path.join(dir, 'autonomy', 'perf-budget.mjs'), 'export const BUDGETS = {\n    htmlBytes: 1_000, // 2026-11-01: first\n    other: 5,\n};\n');
        expect(E.raiseHtmlCeiling({ repoDir: dir, htmlBytes: 900 })).toEqual({ ok: true, changed: false });
        const r = E.raiseHtmlCeiling({ repoDir: dir, htmlBytes: 1_200, issue: 7, now: new Date('2026-11-21T00:00:00Z') });
        expect(r).toMatchObject({ ok: true, changed: true, from: 1000, to: 1500 });
        expect(r.text).toMatch(/htmlBytes: 1_500, \/\/ 2026-11-21: raised from 1000 for an edit to a screen \(edit lane, #7\); measured 1200\. \/\/ 2026-11-01: first/);
        expect(r.text).toMatch(/other: 5/);
    });
});

describe('pageScopeOf', () => {
    it('finds the page a function draws into from the ids it fetches', () => {
        expect(E.pageScopeOf(HTML, E.functionRange(HTML, 'renderDemo').src)).toBe('#page-demo');
        expect(E.pageScopeOf(HTML, 'function renderX() { return 1; }')).toBe('');
    });
});

describe('editLaneFor', () => {
    const home = { found: true, file: 'index.html', fn: 'renderDemo', mayEdit: false };
    it('applies to a bug or ui report about a render function in index.html', () => {
        expect(E.editLaneFor({ home, kind: 'bug' }).applies).toBe(true);
        expect(E.editLaneFor({ home, kind: 'ui' }).applies).toBe(true);
    });
    it('does not apply to anything else, and can be switched off', () => {
        expect(E.editLaneFor({ home, kind: 'feature' }).applies).toBe(false);
        expect(E.editLaneFor({ home: { ...home, file: 'wealthflow-x.js' }, kind: 'bug' }).applies).toBe(false);
        expect(E.editLaneFor({ home: { ...home, fn: 'helperAbove' }, kind: 'bug' }).applies).toBe(false);
        expect(E.editLaneFor({ home: { found: false }, kind: 'bug' }).applies).toBe(false);
        expect(E.editLaneFor({ home, kind: 'bug', env: { WF_EDIT_LANE: '0' } }).applies).toBe(false);
    });
});

describe('runEditLane: end to end with scripted replies', () => {
    const makeRepo = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-edit-lane-'));
        fs.mkdirSync(path.join(dir, 'autonomy'));
        fs.writeFileSync(path.join(dir, 'index.html'), HTML);
        fs.writeFileSync(path.join(dir, 'wf-ui.css'), CSS);
        fs.writeFileSync(path.join(dir, 'autonomy', 'perf-budget.mjs'), `export const BUDGETS = {\n    htmlBytes: ${Buffer.byteLength(HTML) + 10}, // first\n};\n`);
        fs.writeFileSync(path.join(dir, 'wealthflow-demo.js'), '(function (root) { root.WFDemo = { open(id) { return id; } }; })(window);');
        return dir;
    };
    const issue = { number: 700, title: 'I cannot see how much of each plan is paid', body: 'On my phone the plan rows show a name only. Please show months paid.' };
    const home = { found: true, file: 'index.html', fn: 'renderDemo', mayEdit: false, books: ['plans'] };
    const good = JSON.stringify({ feasible: true, why: 'Rows said nothing about progress; each row now says how far it is and has a Details button.', edits: [
        { file: 'index.html', find: '</td><td>${fmt(item.monthly)}</td>', replace: '</td><td>${fmt(item.monthly)}<div class="wf-demo-sum">${prog.pct}% paid · ${finished ? \'Done\' : \'Active\'}</div></td>' },
        { file: 'wf-ui.css', find: '.wf-demo-sum { margin-top: 3px;', replace: '.wf-demo-sum { margin-top: 4px; overflow-wrap: anywhere;' },
    ] });
    const arithmetic = JSON.stringify({ feasible: true, why: 'x', edits: [{ file: 'index.html', find: '<td>${fmt(item.monthly)}</td>', replace: '<td>${fmt(item.monthly * 2)}</td>' }] });
    const passed = { status: 'passed', findings: [], blocking: [], notes: [], judges: ['a', 'b'], criteria: ['shows progress'], shots: [], evidence: 'x' };
    const pass = { text: JSON.stringify({ verdict: 'PASS', severity: 'none', findings: [], reason: 'markup only' }), provider: 'stub-reviewer' };
    const run = (dir, accept, extra = {}) => E.runEditLane({ issue, home, repoDir: dir, env: {}, log: () => {}, accept, deps: { exists }, ...extra });

    it('edits the screen, proves it on a phone, gets an independent PASS, and returns the files', async () => {
        const dir = makeRepo();
        script.replies = [good, pass]; script.prompts = [];
        const accept = vi.fn(async ({ module: m }) => {
            expect(m.name).toBe('index.html');
            expect(Object.keys(m.overlay).sort()).toEqual(['index.html', 'wf-ui.css']);
            expect(m.overlay['index.html']).toContain('wf-demo-sum');
            expect(m.overlay['index.html']).not.toMatch(/integrity=/);
            return passed;
        });
        const r = await run(dir, accept);
        expect(r).toMatchObject({ ok: true, stage: 'ready', lane: 'edit', role: 'ui', file: 'index.html' });
        expect(r.code).toContain('${prog.pct}% paid');
        expect(r.files['wf-ui.css']).toContain('margin-top: 4px');
        expect(r.files['autonomy/perf-budget.mjs']).toMatch(/raised from/);
        expect(r.acceptance.summary).toMatch(/PASSED/);
        expect(r.review.verdict).toBe('PASS');
        expect(r.providers.author).toBe('stub-author');
        // nothing is written to the repository by the lane itself
        expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toBe(HTML);
        expect(fs.readFileSync(path.join(dir, 'wf-ui.css'), 'utf8')).toBe(CSS);
        // the reviewer saw the whole change, the author saw the real function and the real rules
        expect(script.prompts[0]).toMatch(/function renderDemo\(\)/);
        expect(script.prompts[0]).toMatch(/\.wf-demo-sum/);
        expect(script.prompts[1]).toMatch(/Adversarially review/);
        expect(script.prompts[1]).toMatch(/wf-demo-sum/);
    });

    it('sends a refused edit back to the author with the reason, and gives up after three', async () => {
        const dir = makeRepo();
        script.replies = [arithmetic, arithmetic, arithmetic]; script.prompts = [];
        const accept = vi.fn(async () => passed);
        const r = await run(dir, accept);
        expect(r).toMatchObject({ ok: false, stage: 'author' });
        expect(r.reason).toMatch(/not allowed in a new expression/);
        expect(script.prompts[1]).toMatch(/WHAT WAS WRONG WITH THEM/);
        expect(accept).not.toHaveBeenCalled();
    });

    it('a second author try that fits is used', async () => {
        const dir = makeRepo();
        script.replies = [arithmetic, good, pass]; script.prompts = [];
        const r = await run(dir, async () => passed);
        expect(r.ok).toBe(true);
    });

    it('stops at once when the author says it needs logic, not words', async () => {
        const dir = makeRepo();
        script.replies = [JSON.stringify({ feasible: false, why_not: 'it needs a number the function does not compute' })]; script.prompts = [];
        const r = await run(dir, async () => passed);
        expect(r).toMatchObject({ ok: false, stage: 'author' });
        expect(r.reason).toMatch(/needs a number/);
        expect(script.prompts).toHaveLength(1);
    });

    it('gives the findings of a phone run back to the author, runs again, and ships what then passes', async () => {
        const dir = makeRepo();
        script.replies = [good, good, pass]; script.prompts = [];
        const problems = { status: 'problems', findings: [{ kind: 'missing', severity: 'high', quote: 'Edit', why: 'No row says which product', blocking: true, agreed: true, source: 'both judges' }], blocking: [{ kind: 'missing', severity: 'high', quote: 'Edit', why: 'No row says which product', blocking: true }], notes: [], judges: ['a', 'b'] };
        const accept = vi.fn().mockResolvedValueOnce(problems).mockResolvedValueOnce(passed);
        const r = await run(dir, accept);
        expect(r.ok).toBe(true);
        expect(accept).toHaveBeenCalledTimes(2);
        expect(r.acceptance.rounds).toHaveLength(1);
        expect(script.prompts[1]).toMatch(/No row says which product/);
    });

    it('opens nothing when the phone run still finds problems after two revisions', async () => {
        const dir = makeRepo();
        script.replies = [good, good, good]; script.prompts = [];
        const problems = { status: 'problems', findings: [], blocking: [{ kind: 'wrong', severity: 'high', quote: 'q', why: 'still broken', blocking: true }], notes: [], judges: ['a', 'b'] };
        const r = await run(dir, async () => problems);
        expect(r).toMatchObject({ ok: false, stage: 'acceptance' });
        expect(r.reason).toMatch(/did not pass the phone run/);
    });

    it('an inconclusive, skipped or missing phone run is not a pass', async () => {
        for (const accept of [async () => ({ status: 'inconclusive', findings: [], blocking: [], reason: 'no judge answered' }), async () => ({ status: 'skipped', findings: [], blocking: [], reason: 'Chromium could not start' }), null, async () => { throw new Error('boom'); }]) {
            const dir = makeRepo();
            script.replies = [good]; script.prompts = [];
            const r = await run(dir, accept);
            expect(r.ok).toBe(false);
            expect(r.stage).toBe('acceptance');
        }
    });

    it('an independent reviewer\'s FAIL is a veto, and the reviewer is asked to be a different provider', async () => {
        const dir = makeRepo();
        script.replies = [good, { text: JSON.stringify({ verdict: 'FAIL', severity: 'high', findings: ['x'], reason: 'a handler calls something else' }), provider: 'stub-reviewer' }]; script.prompts = [];
        const llm = await import('../autonomy/llm-router.mjs');
        const r = await run(dir, async () => passed);
        expect(r).toMatchObject({ ok: false, stage: 'security' });
        expect(r.reason).toMatch(/Agent 5 veto/);
        const last = llm.chat.mock.calls[llm.chat.mock.calls.length - 1][0];
        expect(last.exclude).toEqual(['stub-author']);
    });

    it('does not accept an edit that changes nothing', async () => {
        const dir = makeRepo();
        script.replies = Array(3).fill(JSON.stringify({ feasible: true, why: 'x', edits: [{ file: 'wf-ui.css', find: '.wf-demo-sum { margin-top: 3px;', replace: '.wf-demo-sum { margin-top: 3px;' }] })); script.prompts = [];
        const r = await run(dir, async () => passed);
        expect(r.ok).toBe(false);
    });
});

describe('the acceptance run serves an edited page', () => {
    it('hands the overlay to the browser and does not inject a module script', async () => {
        const seen = {};
        const boot = vi.fn(async (o) => { seen.o = o; throw new Error('stop here'); });
        const deps = { chat: vi.fn(async () => ({ text: JSON.stringify({ criteria: ['c'], books: {}, steps: [{ do: 'render', fn: 'renderDemo' }, { do: 'shot', label: 'a' }] }), provider: 'p' })), boot };
        const r = await A.runAcceptance({ issue: { title: 't', body: 'b' }, module: { name: 'index.html', api: '', code: 'function renderDemo() {}', overlay: { 'index.html': '<html></html>' } }, deps, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wf-acc-')) });
        expect(r.status).toBe('skipped');
        expect(seen.o.overlay).toEqual({ 'index.html': '<html></html>' });
        expect(seen.o.htmlTransform).toBeUndefined();
        expect(deps.chat.mock.calls[0][0].prompt).toMatch(/EDITED/);
    });
    it('still serves a new module the old way', async () => {
        const boot = vi.fn(async (o) => { throw new Error(String(Object.keys(o.overlay)) + (typeof o.htmlTransform)); });
        const deps = { chat: vi.fn(async () => ({ text: JSON.stringify({ criteria: [], books: {}, steps: [{ do: 'render', fn: 'renderX' }] }), provider: 'p' })), boot };
        const r = await A.runAcceptance({ issue: { title: 't', body: 'b' }, module: { name: 'wealthflow-x.js', api: 'WFX', code: 'x' }, deps, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wf-acc-')) });
        expect(r.reason).toMatch(/wealthflow-x\.jsfunction/);
    });
});

describe('the agent and the workflow', () => {
    const agent = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'autonomous-fix-agent.js'), 'utf8');
    const wf = fs.readFileSync(path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'autonomous-fix.yml'), 'utf8');
    it('tries the edit lane for a screen no other lane may edit, before the build lane, and falls back to it', () => {
        const i = agent.indexOf('editLaneFor({ home, kind })');
        const b = agent.indexOf('if (lockedScreen) {', i);
        expect(i).toBeGreaterThan(0);
        expect(b).toBeGreaterThan(i);
        expect(agent).toMatch(/edit lane \(\$\{edited\.stage\}\)/);
    });
    it('writes the edit lane\'s other files from an allowlist of three paths', () => {
        expect(agent).toMatch(/new Set\(\['index\.html', 'wf-ui\.css', 'autonomy\/perf-budget\.mjs'\]\)/);
    });
    it('stages exactly those three paths in both ship modes', () => {
        const loops = wf.match(/for EXTRA in ([^;]+); do/g) || [];
        expect(loops).toHaveLength(2);
        for (const l of loops) expect(l).toBe('for EXTRA in index.html wf-ui.css autonomy/perf-budget.mjs; do');
    });
    it('puts the lane in the pull request body', () => {
        expect(agent).toMatch(/Screen edited in place/);
    });
});
