/* Where is the screen drawn, and is a "fix" a fix at all?  (autonomy/symptom-home.mjs, issue #635)
 *
 * Measured fault: a report about the CC Instalments page was tried twice and nothing changed either time.
 *   - the page is drawn by renderCCI() inside index.html, which no lane may edit; the agent did not know that, ranked modules by
 *     shared words and took a statement parser that draws nothing;
 *   - the author shortened one comment and dropped the last newline; that reached the reviewer, and the same file was picked again.
 * Three repairs are pinned here:
 *   1. a change that touches only comments and whitespace is refused before anyone reviews it;
 *   2. a file an earlier try stopped on is tried last;
 *   3. the words on the screen name the file and function that draw it, and the author of a new module is shown that code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
            return { text: next, provider: (o.exclude || []).includes('p1') ? 'p2' : 'p1' };
        },
    };
});

const { codeOnly, isCosmeticChange, visibleStrings, findHome, functionAround, bestFunction, booksRead, reachabilityGap, symptomHome, homeFacts } =
    await import('../autonomy/symptom-home.mjs');
const { runSwarm, structuralCheck, swarmMayEdit } = await import('../autonomy/agent-swarm.mjs');
const { authorPrompt, planPrompt } = await import('../autonomy/build-lane.mjs');

describe('a change that touches only comments and whitespace is not a fix', () => {
    const before = [
        "/** row.plan is the statement's plan table row for it, when it printed one */",
        'function f(row) {',
        '    const plan = row.plan && row.plan.name ? row.plan : null; // the table, when there is one',
        '    return plan;',
        '}',
        '',
    ].join('\n');

    it('sees through a shortened comment and a dropped final newline (the change refused twice)', () => {
        const after = before.replace('row for it, when it printed one', 'row').replace(/\n$/, '');
        expect(after).not.toBe(before);
        expect(isCosmeticChange(before, after)).toBe(true);
    });
    it('sees through blank lines, indentation and a new line comment', () => {
        expect(isCosmeticChange(before, before.replace('return plan;', '\n\n      return   plan; // done'))).toBe(true);
    });
    it('does NOT call a real change cosmetic', () => {
        expect(isCosmeticChange(before, before.replace('row.plan : null', 'row.plan : {}'))).toBe(false);
        expect(isCosmeticChange(before, before.replace('return plan;', 'return plan || null;'))).toBe(false);
    });
    it('keeps text inside strings: changing a label is a change', () => {
        const a = "const t = 'Total CC Financed'; // x";
        expect(isCosmeticChange(a, a.replace('Financed', 'Owed'))).toBe(false);
        expect(isCosmeticChange("const u = 'http://x.lk/a'; // c", "const u = 'http://x.lk/a';")).toBe(true);
    });
    it('keeps template literals whole, so markup changes show', () => {
        const a = 'const h = `<td>${x}</td>`;';
        expect(isCosmeticChange(a, a.replace('<td>', '<td class="tap">'))).toBe(false);
    });
    it('an empty side is never "cosmetic"', () => {
        expect(isCosmeticChange('', 'x')).toBe(false);
        expect(isCosmeticChange('x', '  ')).toBe(false);
    });
    it('codeOnly drops comments and collapses whitespace outside strings', () => {
        expect(codeOnly('a  =  1; /* c */\n// d\nb = "x  y";')).toBe('a = 1; b = "x  y";');
    });
    it('structuralCheck names it, so a second author is refused it too', () => {
        const r = structuralCheck(before, before.replace('return plan;', 'return plan; // same'));
        expect(r.ok).toBe(false);
        expect(r.problems.join(' ')).toMatch(/only comments or whitespace/);
    });
});

describe('runSwarm: a cosmetic change moves on to the next file, and earlier tries go last', () => {
    const A = 'wealthflow-card-note.js';
    const B = 'wealthflow-card-view.js';
    const mod = (word) => ['(function () {', `    window.wf${word} = {`, '        init: function () {', `            var el = document.getElementById('wf${word}');`, "            el.textContent = 'Card note ' + '1.0';", '        },', '    };', '})();', ''].join('\n');
    const PASS = '{"verdict":"PASS","severity":"none","findings":[],"reason":"display only"}';
    let dir, logs;
    beforeEach(() => {
        script.replies = []; script.calls = []; logs = [];
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));
        fs.mkdirSync(path.join(dir, 'test'));
        fs.writeFileSync(path.join(dir, A), mod('Note'));
        fs.writeFileSync(path.join(dir, B), mod('View'));
        fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ latest: '1.0.0', version: '1.0.0', notes: [] }));
    });
    const run = (extra = {}) => runSwarm({ issue: { title: 'Card note is cut off', body: 'The card note text is cut off in the card view.', number: 5, kind: 'bug' }, repoDir: dir, env: {}, writeTest: false, log: (m) => logs.push(String(m)), ...extra });

    it('a comment-only change from the first file never reaches the reviewer; the next file is tried', async () => {
        const cosmetic = mod('Note').replace('(function () {', '// tidy\n(function () {');
        const real = mod('View').replace("'Card note ' + '1.0'", "'Card note ' + '1.0' + ' ok'");
        script.replies = [A, cosmetic, real, PASS];
        const r = await run();
        expect(r.ok).toBe(true);
        expect(r.file).toBe(B);
        expect(logs.join('\n')).toMatch(/only touches comments or whitespace/);
        expect(script.calls.length).toBe(4);   // select, author A, author B, review of B
        expect(script.calls[3].system).toMatch(/Chaos Security Auditor/);
    }, 120_000);

    it('when every candidate is cosmetic the run ends at "author" with the reason, never at "security"', async () => {
        const cosmetic = (w) => mod(w).replace('(function () {', '// tidy\n(function () {');
        script.replies = [A, cosmetic('Note'), cosmetic('View')];
        const r = await run();
        expect(r.ok).toBe(false);
        expect(r.stage).toBe('author');
        expect(r.reason).toMatch(/comments or whitespace/);
    }, 120_000);

    it('a file earlier tries stopped on is tried after the others, even when the model picks it', async () => {
        const real = mod('View').replace("'Card note ' + '1.0'", "'Card note ' + '1.0' + ' ok'");
        script.replies = [A, real, PASS];
        const r = await run({ triedFiles: [A] });
        expect(r.ok).toBe(true);
        expect(r.file).toBe(B);
        expect(script.calls[1].prompt).toContain(B);
        expect(logs.join('\n')).toMatch(new RegExp(`earlier tries stopped on ${A}`));
    }, 120_000);

    it('an empty list changes nothing', async () => {
        const real = mod('Note').replace("'Card note ' + '1.0'", "'Card note ' + '1.0' + ' ok'");
        script.replies = [A, real, PASS];
        const r = await run({ triedFiles: [] });
        expect(r.ok).toBe(true);
        expect(r.file).toBe(A);
    }, 120_000);
});

const READING = [
    'Some words the person wrote about the screen.',
    '### What the AI saw in the screenshot',
    'TRANSCRIPT:',
    '23:37', '49', 'CC Instalments', 'History', 'Product', 'Monthly', 'Date', 'Skip Month', '+ Add Instalment', 'All cards',
    '2 cards · 3 plans', 'HNB Credit Car…', 'Monthly CC Payments', 'due each month', 'LKR 20,968.68', 'Total CC Financed', 'Active Plans',
    'Card installment charge of 2026-10-23 …', 'Home', 'Income',
    '',
    'SCREEN: The "CC Instalments" page of the WealthFlow app.',
    '### System diagnosis',
    '| Build | 7.69.99 |',
    '```json', '{"missing":31,"closedEmpty":24,"complete":true,"refused":[]}', '```',
].join('\n');

describe('visibleStrings: the words a person can read on the screen', () => {
    const got = visibleStrings(READING);
    it('keeps screen labels', () => {
        expect(got).toEqual(expect.arrayContaining(['CC Instalments', 'Monthly CC Payments', 'Total CC Financed', 'Active Plans', 'Skip Month', 'All cards']));
    });
    it('drops times, bare numbers and everyday single words', () => {
        for (const x of ['23:37', '49', 'History', 'Home', 'Income', 'Product', 'Monthly', 'Date']) expect(got).not.toContain(x);
    });
    it('drops field names from the diagnosis block (not on the screen)', () => {
        for (const x of ['missing', 'closedEmpty', 'complete', 'refused']) expect(got).not.toContain(x);
    });
    it('is empty for text with no screenshot and no quoted words', () => {
        expect(visibleStrings('the total is wrong')).toEqual([]);
        expect(visibleStrings('')).toEqual([]);
    });
});

describe('reachabilityGap: cannot be seen, opened or tapped (not "wrong" or "broken")', () => {
    it.each([
        'There is no way to see which products correspond to CC Instalments and view their details. Clicking it does not navigate inside.',
        'I cannot open the plan on my phone',
        "I can't see the details of each plan",
        'Tapping a row does nothing',
        'the row is not clickable',
        'unable to view the product list',
        'There is no button to open a plan',
    ])('is a gap: %s', (t) => expect(reachabilityGap(t)).toBe(true));
    it.each([
        'The total is wrong',
        'The monthly figure shows 12,000 instead of 21,000',
        'App crashes after login',
        'Add a dark mode',
        '',
    ])('is not a gap: %s', (t) => expect(reachabilityGap(t)).toBe(false));
});

describe('where is the screen drawn', () => {
    let dir;
    const INDEX = [
        '<html><body>',
        '<!-- CC Instalments tab -->',
        '<script>',
        '        function renderOneTime() {',
        "            const rows = DB.get('cconetime') || [];",
        "            document.getElementById('ot').innerHTML = rows.map(r => `<tr><td>${r.desc}</td></tr>`).join('') + 'All cards';",
        '        }',
        '        function renderCCI() {',
        "            let arr = (DB.get('ccinstall') || []).filter(x => x && !x.mergedInto);",
        "            $('cciStats').innerHTML = `<div class=\"stat-label\">Monthly CC Payments</div><div class=\"stat-meta\">due each month</div>",
        '                <div class="stat-label">Total CC Financed</div><div class="stat-label">Active Plans</div>`;',
        "            $('cciBody').innerHTML = arr.map(item => `<tr><td>${item.product}</td></tr>`).join('');",
        '        }',
        '</script></body></html>',
    ].join('\n');
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-home-'));
        fs.writeFileSync(path.join(dir, 'index.html'), INDEX);
        // a decoy: a parser that shares ONE phrase with the screen and draws nothing
        fs.writeFileSync(path.join(dir, 'wealthflow-card-plans.js'), '// builds the Monthly CC Payments figure\nfunction cardPlanRecord(row) { return { plan: row.plan }; }\n');
    });

    it('names the file and the function that draw the words, not the nearest decoy', () => {
        const h = symptomHome(READING, { repoDir: dir, mayEdit: (f) => f !== 'index.html' });
        expect(h.found).toBe(true);
        expect(h.file).toBe('index.html');
        expect(h.fn).toBe('renderCCI');   // not renderOneTime, although "All cards" sits there
        expect(h.mayEdit).toBe(false);
        expect(h.books).toEqual(['ccinstall']);
        expect(h.code).toContain("$('cciBody')");
        expect(h.others).not.toContain('index.html');
    });
    it('one shared phrase is not a home', () => {
        expect(findHome(['Monthly CC Payments', 'Nothing Else Here'], { repoDir: dir }).map((x) => x.file)).toEqual([]);
    });
    it('says plainly when it cannot tell', () => {
        const h = symptomHome('the total is wrong', { repoDir: dir });
        expect(h.found).toBe(false);
        expect(h.why).toMatch(/fewer than two/);
    });
    it('functionAround returns the whole enclosing function, braces balanced', () => {
        const f = functionAround(INDEX, 'Monthly CC Payments');
        expect(f.name).toBe('renderCCI');
        expect(f.code.trim().startsWith('function renderCCI')).toBe(true);
        expect(f.code.trim().endsWith('}')).toBe(true);
    });
    it('bestFunction prefers the function holding most words', () => {
        expect(bestFunction(INDEX, ['All cards', 'Monthly CC Payments', 'Total CC Financed', 'Active Plans']).name).toBe('renderCCI');
    });
    it('a very long function is cut honestly and says so', () => {
        const long = 'function big() {\n' + '    x();\n'.repeat(3000) + "    show('Needle Words');\n" + '    y();\n'.repeat(500) + '}\n';
        const f = functionAround(long, 'Needle Words', { maxChars: 2000 });
        expect(f.code.length).toBeLessThan(2200);
        expect(f.code).toContain('Needle Words');
        expect(f.code).toMatch(/left out/);
    });
    it('booksRead lists each book once', () => {
        expect(booksRead("DB.get('ab'); DB.get( \"bc\" ); DB.get('ab'); DB.set('cd', 1)")).toEqual(['ab', 'bc']);
    });
    it('homeFacts tells an author what it may and may not do, and shows the real code', () => {
        const h = symptomHome(READING, { repoDir: dir, mayEdit: () => false });
        const t = homeFacts(h);
        expect(t).toMatch(/renderCCI\(\)/);
        expect(t).toMatch(/NO lane may edit/);
        expect(t).toMatch(/DB\.get\('ccinstall'\)/);
        expect(t).toMatch(/NEW read-only module/);
        expect(t).toContain("$('cciBody')");
        expect(homeFacts({ found: false })).toBe('');
    });
    it('index.html is never something the swarm may open', () => {
        expect(swarmMayEdit('index.html', process.cwd())).toBe(false);
    });
});

describe('the build lane shows the author the real screen code', () => {
    const facts = homeFacts({ found: true, file: 'index.html', mayEdit: false, fn: 'renderCCI', books: ['ccinstall'], code: "function renderCCI() { $('cciBody').innerHTML = ''; }" });
    const plan = { name: 'wealthflow-plan-detail.js', api: 'WFPlanDetail', summary: 'shows a plan' };
    it('the author prompt carries the screen code and the attach-from-outside rule', () => {
        const t = authorPrompt('report', plan, '2026-11-20', facts);
        expect(t).toMatch(/THE SCREEN THE REPORT IS ABOUT/);
        expect(t).toContain('cciBody');
        expect(t).toMatch(/delegated listener/);
        expect(t).toMatch(/never invent a selector/);
    });
    it('without facts the prompt is exactly what it was', () => {
        expect(authorPrompt('report', plan, '2026-11-20')).not.toMatch(/THE SCREEN THE REPORT IS ABOUT/);
        expect(authorPrompt('report', plan, '2026-11-20', '')).toBe(authorPrompt('report', plan, '2026-11-20'));
    });
    it('the plan prompt names where the screen is drawn', () => {
        expect(planPrompt('report', [], facts)).toMatch(/WHERE THE SCREEN IS DRAWN/);
        expect(planPrompt('report', [])).not.toMatch(/WHERE THE SCREEN IS DRAWN/);
    });
});
