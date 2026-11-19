/* =============================================================================
 * test/self_ideation_fixes_test.js — the three faults measured in the live idea engine on 2026-11-19 (owner: "you built this, but it does not work")
 *   1. the cap of 2 ideas in the pipeline stayed full for five days because two ideas the builder had given up on (`ai-stuck`) still counted as "being built"
 *   2. idea #607 (the build ID next to the version) was approved for something that had shipped weeks earlier
 *   3. every idea was a cosmetic touch of one screen, because the only evidence about the app itself was a list of module names
 * The issue list below is the real one (numbers, labels, dates) as it stood at the 05:55Z run that said "2 idea(s) already in the pipeline".
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import * as I from '../autonomy/ideas.mjs';
import * as A from '../autonomy/app-map.mjs';
import { buildPrompt, proposeOnce, renderProposal } from '../autonomy/propose.mjs';
import { buildLaneFor, newTagProblems, ensureNewTag, authorPrompt } from '../autonomy/build-lane.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const lab = (...n) => n.map((name) => ({ name }));
const LIVE = [
    { number: 625, state: 'open', title: '[PROPOSAL] Show the plain-language change summary on the update card', created_at: '2026-11-14T05:00:40Z', labels: lab('autonomous', 'ai-stuck', 'feature-proposal', 'approved-feature', 'auto-approved') },
    { number: 616, state: 'closed', state_reason: 'not_planned', title: '[PROPOSAL] Fix overlapping UI elements on phone screens', created_at: '2026-11-13T03:00:26Z', labels: lab('autonomous', 'feature-proposal', 'idea-declined') },
    { number: 607, state: 'open', title: '[PROPOSAL] Display build ID next to version in Software Update screen', created_at: '2026-11-12T08:09:56Z', labels: lab('autonomous', 'ai-stuck', 'feature-proposal', 'approved-feature', 'auto-approved') },
    { number: 443, state: 'open', title: '[PROPOSAL] Add a What changed since last visit digest', created_at: '2026-10-19T16:16:36Z', labels: lab('autonomous', 'feature-proposal') },
];
const NOW = Date.parse('2026-11-19T05:55:00Z');

describe('1. an idea the builder gave up on no longer holds a place in the pipeline', () => {
    it('the real issue list: before the fix 2 were "in the pipeline" and the engine thought of nothing; now none are', () => {
        const o = I.outcomesOf(LIVE);
        expect(o.find((x) => x.number === 607).state).toBe('stuck');
        expect(o.find((x) => x.number === 625).state).toBe('stuck');
        expect(I.inFlight(o, NOW)).toBe(0);
    });
    it('an approved idea that is still being built (no ai-stuck) still counts, so the cap still stops a flood', () => {
        const live = LIVE.map((i) => (i.number === 625 ? { ...i, labels: lab('autonomous', 'feature-proposal', 'approved-feature') } : i));
        expect(I.inFlight(I.outcomesOf(live), NOW)).toBe(1);
    });
    it('a stuck idea is still an earlier idea: it is shown to the model with the reason, and a near-copy is refused', () => {
        const o = I.outcomesOf(LIVE);
        const sig = I.signalList({ outcomes: o });
        const row = sig.find((s) => /#607/.test(s.text));
        expect(row.kind).toMatch(/builder could not build it/);
        expect(I.isRepeat('Display the build ID beside the version number', o)).toBeTruthy();
    });
});

describe('2. something that already shipped is not proposed again', () => {
    const shipped = ['Software Update shows the build next to the version (#511)', 'Cheques: the tracker settles from the statement (#423)'];
    it('a near-copy of a merged pull request title is skipped, a different idea is not', () => {
        expect(I.isShippedAlready('Show the build next to the version on the Software Update card', shipped)).toBeTruthy();
        expect(I.isShippedAlready('Show net worth over the last twelve months', shipped)).toBeNull();
    });
    it('decide() skips it before it spends a board vote', () => {
        const idea = { title: 'Show the build next to the version on the Software Update card', evidence: ['P1'], ifThen: ['If a, then b one', 'If c, then d two'], scores: { ease: 5, value: 5, small: 5, risk: 1 }, proposal: 'x'.repeat(40) };
        const v = I.decide({ idea, signals: [{ id: 'P1' }], outcomes: [], shipped, board: null });
        expect(v.act).toBe('skip');
        expect(v.why).toMatch(/already shipped/);
    });
});

describe('3. the engine is told what each part of the app already does, and where it was looked for and not found', () => {
    const mods = A.readModules(ROOT);
    it('reads a one-line summary for nearly every module of the real repository', () => {
        expect(mods.length).toBeGreaterThan(80);
        const us = mods.find((m) => m.name === 'update-system');
        expect(us.summary).toMatch(/update/i);
        expect(mods.find((m) => m.name === 'shell').summary).toMatch(/frame|tab bar|palette/i);
    });
    it('the module text fits a free-tier window', () => {
        expect(A.renderModules(mods).length).toBeLessThanOrEqual(7000);
    });
    it('the prompt carries the module summaries (A2) and the capability gaps (B1...)', () => {
        const gaps = A.capabilityGaps(A.readCapabilityText(ROOT));
        const sig = I.signalList({ capabilities: gaps, app: { moduleText: A.renderModules(mods), sections: ['dashboard'] } });
        const text = buildPrompt({ modules: [], sections: [], feedback: [], signals: sig });
        expect(text).toMatch(/A2 \[what each module already does\]/);
        expect(text).toMatch(/shell: /);
        expect(sig.some((s) => /^B\d/.test(s.id))).toBe(true);
    });
    it('every capability reported as missing really has none of its words in the code (the list cannot cry wolf)', () => {
        const text = A.readCapabilityText(ROOT);
        for (const c of A.capabilityGaps(text)) for (const re of c.words) expect(re.test(text), `${c.id}: ${re}`).toBe(false);
    });
    it('a capability whose words ARE in the code is not offered as a gap', () => {
        expect(A.capabilityGaps('the guided tour starts here; text size; keyboard shortcuts; net worth over time; weekly summary; debt-free date').map((c) => c.id)).toEqual(['record-notes']);
    });
    it('the board is shown the existing part that already does what the idea says (the #607 case)', () => {
        const near = A.closestExisting({ title: 'Display build ID next to version in Software Update screen', proposal: 'Show one small line under the version number reading Build plus a short build code.' }, mods);
        expect(near.map((m) => m.name)).toContain('update-system');
        const text = I.boardTextFor({ title: 't', problem: 'p', ifThen: [], proposal: 'q', scope: 's', risks: 'r' }, 'the owner', near);
        expect(text).toMatch(/EXISTING PARTS OF THE APP/);
        expect(text).toMatch(/update-system/);
    });
    it('an idea that resembles nothing gets an empty list, so the board text is unchanged', () => {
        expect(A.closestExisting({ title: 'zzz qqq', proposal: 'xxx yyy' }, mods)).toEqual([]);
        expect(I.boardTextFor({ title: 't', problem: 'p', ifThen: [], proposal: 'q', scope: 's', risks: 'r' })).not.toMatch(/EXISTING PARTS/);
    });
    it('summaryOf reads the dash form and the WHAT THIS IS form, and gives "" for a file with no header', () => {
        expect(A.summaryOf('/* wealthflow-x.js — the thing that does a useful job for the person */\n', 'wealthflow-x.js')).toMatch(/^the thing that does/);
        expect(A.summaryOf('/* ====\n * WHAT THIS IS. A box that remembers the last filter you used.\n * ====*/', 'wealthflow-y.js')).toMatch(/^A box that remembers/);
        expect(A.summaryOf('var a = 1;', 'wealthflow-z.js')).toBe('');
    });
});

describe('4. the bar for value was raised: used most weeks, not a tweak', () => {
    it('value 3 no longer passes; 4 does', () => {
        expect(I.scoresOk({ ease: 5, value: 3, small: 5, risk: 1 }).ok).toBe(false);
        expect(I.scoresOk({ ease: 5, value: 4, small: 5, risk: 1 }).ok).toBe(true);
    });
});

describe('5. end to end with the real issue list: the run that said "2 idea(s) already in the pipeline" now thinks', () => {
    const env = { GROQ_API_KEY: 'x', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
    const budget = { LANES: { BACKGROUND: 'b' }, RESERVE_FOR_CRITICAL: 2, loadLedger: () => ({}), availableFor: () => ['groq', 'mistral'], record: (l) => l, saveLedger: () => {} };
    const good = { worthProposing: true, title: 'Show net worth month by month for the last year', problem: 'The owner sees net worth only for today and cannot tell whether it is rising.', evidence: ['B3'], ifThen: ['If net worth is shown over time, then a falling month is noticed early.', 'If it is noticed early, then the owner can act before it compounds.'], scores: { ease: 4, value: 4, small: 3, risk: 1 }, prompt: 'No view of net worth over time was found in the code.', proposal: 'A new read-only module that reads the books and draws one small line of net worth per month on the dashboard, with nothing written.', scope: 'a new module wealthflow-networth-trend.js that only reads the books, plus one script line', whyNow: 'Measured gap.', risks: 'A wrong month would mislead.' };
    const rig = () => {
        const filed = [], asked = [];
        const queue = { allIssues: async () => LIVE, createIssue: async (x) => { filed.push(x); return { number: 700 }; }, ensureLabel: async () => true, comment: async () => {}, closeIssue: async () => {}, mergedPrTitles: async () => [] };
        const run = (o = {}) => proposeOnce({ env, repoDir: ROOT, queue, budget, now: NOW, boardImpl: async ({ issueText }) => { asked.push(issueText); return { voters: 3, verdict: 'BUILD', votes: [{ provider: 'a', verdict: 'BUILD' }, { provider: 'b', verdict: 'BUILD' }, { provider: 'c', verdict: 'BUILD_SMALLER' }], easy: [], risks: [], alternatives: [], first: 'x', question: '' }; }, ...o });
        return { filed, asked, run };
    };
    it('is no longer stopped by the two ideas the builder gave up on, files the new one, and the model is shown the stuck ones', async () => {
        const r = rig(); let prompt = '';
        const out = await r.run({ proposeImpl: async (q) => { prompt = q.prompt; return [{ provider: 'groq', text: JSON.stringify(good) }]; } });
        expect(out.reason || '').not.toMatch(/already in the pipeline/);
        expect(out.approved).toBe(true);
        expect(r.filed[0].title).toMatch(/net worth/i);
        expect(prompt).toMatch(/the builder could not build it/);
        expect(prompt).toMatch(/what each module already does/);
    });
    it('an idea that restates what already shipped is skipped, and the board is never asked', async () => {
        const r = rig();
        const dup = { ...good, title: 'Display build ID next to version in Software Update screen', evidence: ['H3'] };
        const out = await r.run({ proposeImpl: async () => [{ provider: 'groq', text: JSON.stringify(dup) }] });
        expect(out.filed).toBeNull();
        expect(r.asked).toHaveLength(0);
    });
});

describe('6. an idea that is a NEW module reaches the builder that can build one', () => {
    const idea = { title: 'Show net worth month by month', problem: 'Only today is shown.', prompt: 'p', proposal: 'A read-only module that draws one line of net worth per month.', scope: 'a new module wealthflow-networth-trend.js that only reads the books, plus one script line', whyNow: 'gap', risks: 'An error in a month would mislead, a bug could show the wrong line.', evidence: ['B3'], ifThen: ['If a then b it works', 'If c then d it helps'], scores: { ease: 4, value: 4, small: 3, risk: 1 } };
    it('the scope check keeps a new file as "to be created" instead of telling the builder not to look for it', () => {
        const g = I.groundScope(idea.scope, ['index.html', 'wealthflow-shell.js']);
        expect(g.create).toEqual(['wealthflow-networth-trend.js']);
        expect(g.text).toMatch(/NEW file to be created/);
        expect(g.text).not.toMatch(/NOT in this repository/);
    });
    it('a file that is neither real nor named as new is still reported as imagined (the #607 case is not lost)', () => {
        expect(I.groundScope('src/screens/settings/software-update.js', ['index.html']).missing).toEqual(['src/screens/settings/software-update.js']);
    });
    it('the filed issue goes to the build lane even though its risks say "error" and "bug"', () => {
        const { body, title } = renderProposal(idea, { approved: true, why: 'ok', priority: 20 });
        expect(buildLaneFor({ title, body }).applies).toBe(true);
    });
    it('an ordinary defect report that happens to say "new module" in no marked proposal is still not sent there', () => {
        expect(buildLaneFor({ title: 'Crash when I open the new page', body: 'The app is broken' }).applies).toBe(false);
    });
    it('an idea whose scope is an existing module is not forced to the build lane', () => {
        const { body, title } = renderProposal({ ...idea, scope: 'wealthflow-update-system.js' }, { approved: true, why: 'ok' });
        expect(buildLaneFor({ title, body }).applies).toBe(false);
    });
});

describe('7. a module the builder makes always carries the NEW tag (nothing asked for it before)', () => {
    const today = '2026-11-19';
    const ui = (attr) => `(function (root) { var c = document.createElement('div'); ${attr} document.body.appendChild(c); })(window);`;
    it('refuses a module that shows something and has no tag, with the exact line to add', () => {
        const p = newTagProblems(ui(''), today);
        expect(p).toHaveLength(1);
        expect(p[0]).toContain(`setAttribute('data-wf-new', '${today}')`);
    });
    it('accepts the tag with today\'s date, in either quote style', () => {
        expect(newTagProblems(ui(`c.setAttribute('data-wf-new', '${today}');`), today)).toEqual([]);
        expect(newTagProblems(ui(`c.setAttribute("data-wf-new","${today}");`), today)).toEqual([]);
    });
    it('refuses another date (older may predate the person; later hides the label)', () => {
        expect(newTagProblems(ui(`c.setAttribute('data-wf-new', '2026-01-01');`), today)[0]).toMatch(/must be today/);
        expect(newTagProblems(ui(`c.setAttribute('data-wf-new', '2027-01-01');`), today)[0]).toMatch(/must be today/);
    });
    it('a pure calculator with no element has nothing to label', () => {
        expect(newTagProblems('(function(r){ r.WFX = { f: function (a) { return a + 1; } }; })(window);', today)).toEqual([]);
    });
    it('the program adds the tag next to the container id when the model left it out (seen on #635: refused twice for this alone)', () => {
        const src = "(function (root) {\n  var sheet = document.createElement('div');\n  sheet.id = 'wf-cci-detail';\n  document.body.appendChild(sheet);\n})(window);";
        const out = ensureNewTag(src, today);
        expect(out).toContain(`sheet.setAttribute('data-wf-new', '${today}');`);
        expect(out.indexOf("data-wf-new")).toBeGreaterThan(out.indexOf("sheet.id"));
        expect(out.indexOf("data-wf-new")).toBeLessThan(out.indexOf("appendChild"));
        expect(newTagProblems(out, today)).toEqual([]);
        expect(() => new Function(out)).not.toThrow();
    });
    it('also anchors on setAttribute("id", ...), corrects a wrong date, accepts dataset.wfNew, and leaves tagged or tag-free code alone', () => {
        const a = "var c = document.createElement('div');\nc.setAttribute('id', 'x-1');\ndocument.body.appendChild(c);";
        expect(newTagProblems(ensureNewTag(a, today), today)).toEqual([]);
        const wrong = ui("c.setAttribute('data-wf-new', '2026-01-01');");
        expect(ensureNewTag(wrong, today)).toContain(`'data-wf-new', '${today}'`);
        expect(newTagProblems(ensureNewTag(wrong, today), today)).toEqual([]);
        expect(newTagProblems(ui(`c.dataset.wfNew = '${today}';`), today)).toEqual([]);
        const good = ui(`c.setAttribute('data-wf-new', '${today}');`);
        expect(ensureNewTag(good, today)).toBe(good);
        const calc = '(function(r){ r.WFX = { f: function (a) { return a + 1; } }; })(window);';
        expect(ensureNewTag(calc, today)).toBe(calc);
    });
    it('a tag whose date is a variable is rewritten with the date itself (seen on #635: setAttribute("data-wf-new", NEW_DATE))', () => {
        const v = ui("c.setAttribute('data-wf-new', NEW_DATE);");
        expect(newTagProblems(v, today)).toHaveLength(1);
        const out = ensureNewTag(v, today);
        expect(out).toContain(`c.setAttribute('data-wf-new', '${today}');`);
        expect(newTagProblems(out, today)).toEqual([]);
        expect(ensureNewTag(ui('c.dataset.wfNew = D;'), today)).toContain(`c.dataset.wfNew = '${today}';`);
    });
    it('with no place to anchor it, the code is left as it is and the refusal stands', () => {
        const noId = ui('');
        expect(ensureNewTag(noId, today)).toBe(noId);
        expect(newTagProblems(noId, today)).toHaveLength(1);
    });
    it('the author is told, with the date', () => {
        expect(authorPrompt('report', { name: 'wealthflow-x.js', api: 'WFX', summary: 's' }, today)).toContain(`'data-wf-new', '${today}'`);
    });
    it('the tag it writes is one the NEW badge really understands (same date format, a week from the first look)', async () => {
        const B = await import('../wealthflow-new-badge.js');
        const ship = B.parseDay(today);
        expect(Number.isFinite(ship)).toBe(true);
        expect(B.canBeNew(ship, Date.parse('2026-10-01T00:00:00Z'))).toBe(true);
        const firstLook = Date.parse('2026-12-20T10:00:00Z');                    // a person who comes back a month later still gets the week
        expect(B.daysLeft(firstLook, firstLook)).toBe(7);
        expect(B.daysLeft(firstLook, firstLook + 7 * 86400000)).toBe(0);
    });
});

describe('8. the test writer is told how to test a NEW page module (third dry run on #635: three proving tests failed against a module that passed review)', () => {
    it('says to use the loader with the page and a fake DB, and names the screen ids when known', async () => {
        const { buildTestNote } = await import('../autonomy/build-lane.mjs');
        const plan = { name: 'wealthflow-x-y.js', api: 'WFXY' };
        const withIds = buildTestNote(plan, 'renderCCI draws into #cciBody and #cciStats');
        expect(withIds).toContain('loadBrowserModule("wealthflow-x-y.js"');
        expect(withIds).toContain('globals: { DB:');
        expect(withIds).toContain('#cciBody');
        expect(withIds).toContain('window.WFXY');
        expect(buildTestNote(plan)).not.toMatch(/has these ids/);
    });
});

describe('9. the test writer is shown the API the module really has (fourth dry run on #635: it invented showDetail)', () => {
    it('apiSurface lists what a module attaches, measured by loading it, and gives nothing when it cannot', async () => {
        const { apiSurface, buildTestNote } = await import('../autonomy/build-lane.mjs');
        const plan = { name: 'wealthflow-x-y.js', api: 'WFXY' };
        const code = "(function (root) { 'use strict'; function open(r) { return r; } root.WFXY = { open: open, version: 1 }; })(typeof window !== 'undefined' ? window : globalThis);";
        const list = await apiSurface(plan, code, process.cwd());
        expect(list).toEqual(['open()', 'version']);
        expect(await apiSurface(plan, 'syntax error here (', process.cwd())).toEqual([]);
        expect(await apiSurface(plan, code, '/nonexistent-dir')).toEqual([]);
        const note = buildTestNote(plan, '', list);
        expect(note).toContain('window.WFXY = { open(), version }');
        expect(note).toContain('Call ONLY these');
        expect(buildTestNote(plan, '', [])).not.toContain('Call ONLY these');
    });
    it('names the ids the module creates itself, never an invented one', async () => {
        const { buildTestNote } = await import('../autonomy/build-lane.mjs');
        const note = buildTestNote({ name: 'wealthflow-a-b.js', api: 'WFAB' }, '', [], "var s = document.createElement('div'); s.id = 'wf-ab-sheet'; s2.setAttribute('id', 'wf-ab-close');");
        expect(note).toContain('wf-ab-sheet, wf-ab-close');
    });
    it('a module that loops forever at load gives no list instead of hanging the lane', async () => {
        const { apiSurface } = await import('../autonomy/build-lane.mjs');
        const t0 = Date.now();
        expect(await apiSurface({ name: 'wealthflow-loop.js', api: 'WFL' }, '(function(){ while (true) {} })();', process.cwd())).toEqual([]);
        expect(Date.now() - t0).toBeLessThan(8000);
    }, 15000);
});
