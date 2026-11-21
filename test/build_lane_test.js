/* =============================================================================
 * test/build_lane_test.js — the lane that can add something NEW   (owner, 2026-11-04)
 * -----------------------------------------------------------------------------
 * Pins: what routes to the lane, what a new module may never contain, how a name is
 * accepted, that wiring is a mechanical one-line edit plus honest ceilings, and the lane
 * end to end with scripted model replies (every gate in order, and each one's veto).
 * ===========================================================================*/
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = { replies: [] };
vi.mock('../autonomy/llm-router.mjs', async (orig) => {
    const real = await orig();
    return { ...real, chat: vi.fn(async (o) => {
        const next = script.replies.shift();
        if (!next) throw new Error('no scripted reply left for: ' + String(o.prompt).slice(0, 60));
        return { text: next.text, provider: next.provider || 'stub' };
    }) };
});

const L = await import('../autonomy/build-lane.mjs');
const ROOT = path.resolve(import.meta.dirname, '..');

const GOOD = `(function (root) {
    'use strict';
    function compute(n) { var x = Number(n); return isFinite(x) ? Math.round(x * 100) / 100 : 0; }
    root.WFLoanCheck = { compute: compute };
})(typeof window !== 'undefined' ? window : globalThis);
`;
const GOOD_TEST = `import { it, expect } from 'vitest';
import * as loader from './helpers/load-browser-module.js';
it('computes', () => { const { window } = loader.loadBrowserModule('wealthflow-loan-check.js'); expect(window.WFLoanCheck.compute('2.345')).toBe(2.35); });
`;
const PLAN = JSON.stringify({ name: 'wealthflow-loan-check.js', api: 'WFLoanCheck', summary: 'Shows whether a new loan fits the monthly budget.', feasible: true });
const PASS = JSON.stringify({ verdict: 'PASS', severity: 'none', findings: [], reason: 'read-only calculator' });

function repo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-build-'));
    fs.mkdirSync(path.join(dir, 'autonomy')); fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>\n    <script src="wealthflow-update-system.js" defer></script>\n</body></html>');
    fs.writeFileSync(path.join(dir, 'wealthflow-update-system.js'), '//x');
    fs.copyFileSync(path.join(ROOT, 'autonomy', 'perf-budget.mjs'), path.join(dir, 'autonomy', 'perf-budget.mjs'));
    return dir;
}

describe('build lane routing', () => {
    it('takes requests for something new', () => {
        expect(L.buildLaneFor({ title: 'Please integrate with the CBSL exchange rate feed' }).applies).toBe(true);
        expect(L.buildLaneFor({ title: 'Add a new calculator for lease vs loan' }).applies).toBe(true);
    });
    it('leaves defect reports to the other lanes even when they say "add"', () => {
        expect(L.buildLaneFor({ title: 'Add button crashes the app' }).applies).toBe(false);
        expect(L.buildLaneFor({ title: 'New calculator is not working' }).applies).toBe(false);
    });
    it('leaves bugs and layout to the other lanes', () => {
        expect(L.buildLaneFor({ title: 'Total on the loans page is wrong' }).applies).toBe(false);
        expect(L.buildLaneFor({ title: 'Button overlaps text on phone' }).applies).toBe(false);
    });
});

describe('what a new module may never contain', () => {
    it.each([
        ['eval(x)', /eval/], ['new Function("a")', /new Function/], ['document.write("x")', /document.write/],
        ['import("./x.js")', /dynamic import/], ['DB.set("expenses", [])', /books/], ['localStorage.clear()', /clears/],
        ['firebase.firestore()', /Firebase/], ['var k="AIzaSyA1234567890abcdefghijk";', /secret/], ['el.innerHTML = `<b>${v}</b>`;', /HTML from strings/], ['el.innerHTML = userText;', /HTML from strings/], ['el.insertAdjacentHTML("beforeend", x)', /HTML from strings/],
        ['var s=document.createElement("script");', /script, iframe/], ['importScripts("x.js")', /./],
        ['var d = root.DB.get("expenses"); fetch("https://x.example/" + d);', /network/i],
    ])('refuses %s', (code, why) => {
        expect(L.forbiddenIn(code).join(' ')).toMatch(why);
    });
    it('accepts a read-only module', () => { expect(L.forbiddenIn(GOOD)).toEqual([]); });
    it('allows the network when the module never reads the books, and the books when it never uses the network', () => {
        expect(L.forbiddenIn('fetch("https://rates.example/usd").then(function (r) { return r.json(); });')).toEqual([]);
        expect(L.forbiddenIn('var a = root.DB.get("expenses") || [];')).toEqual([]);
    });
    it('allows reading the books', () => { expect(L.forbiddenIn('var a = root.DB.get("expenses") || [];')).toEqual([]); });
});

describe('the plan', () => {
    const ok = (o) => L.parsePlan(JSON.stringify(o), { existing: [], repoDir: repo() });
    it('accepts a sound plan', () => { expect(ok({ name: 'wealthflow-loan-check.js', api: 'WFLoanCheck', summary: 's' }).ok).toBe(true); });
    it('refuses a name outside the pattern, a bad api, or a path trick', () => {
        expect(ok({ name: '../index.html', api: 'WFLoanCheck' }).ok).toBe(false);
        expect(ok({ name: 'wealthflow-Loan.js', api: 'WFLoanCheck' }).ok).toBe(false);
        expect(ok({ name: 'wealthflow-loan-check.js', api: 'loanCheck' }).ok).toBe(false);
    });
    it('refuses a name that falls under a guarded path', () => { expect(ok({ name: 'wealthflow-auth-helper.js', api: 'WFAuthHelper' }).ok).toBe(false); });
    it('refuses what already exists', () => {
        const r = L.parsePlan(PLAN, { existing: ['wealthflow-loan-check.js'], repoDir: repo() });
        expect(r.ok).toBe(false);
    });
    it('passes on an infeasible plan with the reason', () => {
        const r = ok({ feasible: false, why_not: 'needs a secret' });
        expect(r.ok).toBe(false); expect(r.reason).toMatch(/needs a secret/);
    });
});

describe('wiring is mechanical and honest', () => {
    it('adds exactly one script line before the update-system tag', () => {
        const d = repo();
        const r = L.wireModule({ repoDir: d, name: 'wealthflow-loan-check.js', issue: 7, now: new Date('2026-11-04T00:00:00Z') });
        expect(r.ok).toBe(true);
        const html = fs.readFileSync(path.join(d, 'index.html'), 'utf8');
        expect(html.match(/wealthflow-loan-check\.js/g)).toHaveLength(2);        // the dated comment and the tag
        expect(html.indexOf('wealthflow-loan-check.js" defer')).toBeLessThan(html.indexOf('wealthflow-update-system.js" defer'));
        expect(html).toContain('2026-11-04');
    });
    it('is refused twice, and when the anchor is missing', () => {
        const d = repo();
        expect(L.wireModule({ repoDir: d, name: 'wealthflow-loan-check.js' }).ok).toBe(true);
        expect(L.wireModule({ repoDir: d, name: 'wealthflow-loan-check.js' }).ok).toBe(false);
        fs.writeFileSync(path.join(d, 'index.html'), '<html></html>');
        expect(L.wireModule({ repoDir: d, name: 'wealthflow-other.js' }).reason).toMatch(/anchor/);
    });
    it('refuses a name that is not a module', () => { expect(L.wireModule({ repoDir: repo(), name: '../etc.js' }).ok).toBe(false); });
    it('raises a ceiling only when the measured value is over it, to the measured value', () => {
        const d = repo();
        fs.writeFileSync(path.join(d, 'wealthflow-big.js'), 'x'.repeat(3_400_000));   // over totalJsBytes (2026-11-19: was 3_100_000, which the real ceiling reached; this stays over it)
        const r = L.wireModule({ repoDir: d, name: 'wealthflow-loan-check.js', issue: 7 });
        expect(r.ok).toBe(true);
        expect(r.raised.join(' ')).toMatch(/totalJsBytes/);
        expect(r.raised.join(' ')).not.toMatch(/htmlBytes/);
        expect(r.files).toEqual(['index.html', 'autonomy/perf-budget.mjs']);
        expect(fs.readFileSync(path.join(d, 'autonomy', 'perf-budget.mjs'), 'utf8')).toMatch(/raised from .* for wealthflow-loan-check\.js/);
    });
    it('touches only the budget file when nothing is over', () => {
        const d = repo();
        expect(L.wireModule({ repoDir: d, name: 'wealthflow-loan-check.js' }).files).toEqual(['index.html']);
    });
});

describe('the lane end to end', () => {
    beforeEach(() => { script.replies = []; });
    const run = (extra = {}) => L.runBuildLane({
        issue: { number: 9, title: 'Add a new loan affordability calculator', body: 'x' }, repoDir: repo(), log: () => {},
        runTest: (() => { let n = 0; return () => ({ passed: ++n % 2 === 0, output: 'stub' }); })(),
        env: { NODE_ENV: 'test' }, ...extra,
    });

    it('plans, writes, reviews on another provider, proves the test red then green, and is ready', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: PASS, provider: 'b' }, { text: GOOD_TEST, provider: 'c' }];
        const r = await run();
        expect(r.stage).toBe('ready'); expect(r.ok).toBe(true);
        expect(r.lane).toBe('build'); expect(r.file).toBe('wealthflow-loan-check.js'); expect(r.verified).toBe(true);
        expect(r.testFile).toMatch(/^test\/auto-wealthflow-loan-check-9\.test\.js$/);
        expect(r.wire).toEqual({ name: 'wealthflow-loan-check.js' });
    });
    it('stops at a plan that says it is not feasible', async () => {
        script.replies = [{ text: JSON.stringify({ feasible: false, why_not: 'needs an account sign-in' }) }];
        const r = await run(); expect(r.ok).toBe(false); expect(r.stage).toBe('plan');
    });
    it('rejects a module that writes the books, twice, and says why', async () => {
        const bad = GOOD.replace('return isFinite', 'root.DB.set("expenses", []); return isFinite');
        script.replies = [{ text: PLAN }, { text: bad }, { text: bad }];
        const r = await run(); expect(r.ok).toBe(false); expect(r.stage).toBe('author'); expect(r.reason).toMatch(/books/);
    });
    it('honours the reviewer veto', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: JSON.stringify({ verdict: 'FAIL', severity: 'high', findings: ['x'], reason: 'leaks' }), provider: 'b' }];
        const r = await run(); expect(r.ok).toBe(false); expect(r.stage).toBe('security');
    });
    it('a medium finding goes back to the author once; the revised file is reviewed again and can pass (seen on #635: "swallowed error")', async () => {
        const med = JSON.stringify({ verdict: 'FAIL', severity: 'medium', findings: ['an empty catch swallows an error'], reason: 'Swallowed error hides failures' });
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: med, provider: 'b' }, { text: GOOD + '\n// handled', provider: 'a2' }, { text: PASS, provider: 'b2' }, { text: GOOD_TEST, provider: 'c' }];
        const r = await run();
        expect(r.ok).toBe(true); expect(r.stage).toBe('ready');
    });
    it('a second refusal, or a high finding, still ends the try; a revision that breaks a rule is not used', async () => {
        const med = JSON.stringify({ verdict: 'FAIL', severity: 'medium', findings: ['x'], reason: 'sloppy' });
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: med, provider: 'b' }, { text: GOOD + '\n// again', provider: 'a2' }, { text: med, provider: 'b2' }];
        let r = await run(); expect(r.ok).toBe(false); expect(r.stage).toBe('security');
        const bad = GOOD.replace('return isFinite', 'root.DB.set("expenses", []); return isFinite');
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: med, provider: 'b' }, { text: bad, provider: 'a2' }];
        r = await run(); expect(r.ok).toBe(false); expect(r.stage).toBe('security');
    });
    it('fails when the test never goes red to green', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: PASS, provider: 'b' }, { text: GOOD_TEST }, { text: GOOD_TEST }, { text: GOOD_TEST }];
        const r = await run({ runTest: () => ({ passed: true, output: '' }) });
        expect(r.ok).toBe(false); expect(r.stage).toBe('proof');
    });
    it('leaves no half-written module behind when it fails', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: PASS, provider: 'b' }, { text: GOOD_TEST }, { text: GOOD_TEST }, { text: GOOD_TEST }];
        const d = repo();
        await run({ repoDir: d, runTest: () => ({ passed: true, output: '' }) });
        expect(fs.existsSync(path.join(d, 'wealthflow-loan-check.js'))).toBe(false);
    });
});

describe('the lane runs the change on a phone and revises on what it finds (#635, 2026-11-20)', () => {
    beforeEach(() => { script.replies = []; });
    const run = (extra = {}) => L.runBuildLane({
        issue: { number: 9, title: 'Add a new loan affordability calculator', body: 'x' }, repoDir: repo(), log: () => {},
        runTest: (() => { let n = 0; return () => ({ passed: ++n % 2 === 0, output: 'stub' }); })(),
        env: { NODE_ENV: 'test' }, ...extra,
    });
    const problem = (extra = {}) => ({ kind: 'contradiction', severity: 'high', quote: 'Paid 0 of 12', why: 'the table says 3 of 12', fix: '', blocking: true, agreed: true, source: 'both judges', ...extra });
    const result = (status, blocking = []) => ({ status, blocking, findings: blocking, notes: [], judges: ['x', 'y'], criteria: [], shots: [] });

    it('hands the problems to the author, runs the revised file again, and reports a pass', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: GOOD + '\n// fixed the count', provider: 'a2' }, { text: PASS, provider: 'b' }, { text: GOOD_TEST, provider: 'c' }];
        const seen = [];
        const accept = async (o) => { seen.push(o.module.code); return seen.length === 1 ? result('problems', [problem()]) : result('passed'); };
        const r = await run({ accept });
        expect(r.ok).toBe(true);
        expect(seen).toHaveLength(2); expect(seen[1]).toMatch(/fixed the count/);
        expect(r.code).toMatch(/fixed the count/);
        expect(r.acceptance.status).toBe('passed'); expect(r.acceptance.rounds).toHaveLength(1);
        expect(r.acceptance.summary).toMatch(/PASSED/);
    });
    it('after two revisions the remaining problems go into the result as known issues, not hidden', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: GOOD + '\n// r1', provider: 'a' }, { text: GOOD + '\n// r2', provider: 'a' }, { text: PASS, provider: 'b' }, { text: GOOD_TEST, provider: 'c' }];
        const r = await run({ accept: async () => result('problems', [problem()]) });
        expect(r.ok).toBe(true); expect(r.acceptance.status).toBe('problems'); expect(r.acceptance.rounds).toHaveLength(3);
        expect(r.acceptance.summary).toMatch(/Known issues/); expect(r.acceptance.summary).toMatch(/Paid 0 of 12/);
    });
    it('a tap that still changes nothing ends the try', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: GOOD + '\n// r1', provider: 'a' }, { text: GOOD + '\n// r2', provider: 'a' }];
        const dead = problem({ measure: 'dead_tap', source: 'measured', kind: 'wrong', why: 'Tapping #row changed nothing' });
        const r = await run({ accept: async () => result('problems', [dead]) });
        expect(r.ok).toBe(false); expect(r.stage).toBe('acceptance'); expect(r.reason).toMatch(/changes nothing/);
    });
    it('a run that could not start never blocks and never claims a pass', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: PASS, provider: 'b' }, { text: GOOD_TEST, provider: 'c' }];
        const r = await run({ accept: async () => ({ status: 'skipped', reason: 'no browser', findings: [], blocking: [], notes: [], judges: [] }) });
        expect(r.ok).toBe(true); expect(r.acceptance.status).toBe('skipped'); expect(r.acceptance.summary).toMatch(/not run/);
    });
    it('without accept nothing changes: no acceptance in the result', async () => {
        script.replies = [{ text: PLAN }, { text: GOOD, provider: 'a' }, { text: PASS, provider: 'b' }, { text: GOOD_TEST, provider: 'c' }];
        const r = await run(); expect(r.ok).toBe(true); expect(r.acceptance).toBe(null);
    });
    it('revision mode: no plan is asked for, the author sees the shipped file and the findings, the module is not wired again, the file is put back', async () => {
        const d = repo(); fs.writeFileSync(path.join(d, 'wealthflow-loan-check.js'), GOOD);
        const prompts = [];
        script.replies = [{ text: GOOD + '\n// revised', provider: 'a' }, { text: PASS, provider: 'b' }, { text: GOOD_TEST, provider: 'c' }];
        const llm = await import('../autonomy/llm-router.mjs');
        const r = await L.runBuildLane({
            issue: { number: 9, title: 'Add a new loan affordability calculator', body: 'x' }, repoDir: d, log: () => {}, env: { NODE_ENV: 'test' },
            runTest: (() => { let n = 0; return () => ({ passed: ++n % 2 === 0, output: 'stub' }); })(),
            revise: { file: 'wealthflow-loan-check.js', code: GOOD, findings: '1. [contradiction] Paid 0 of 12 - on screen: "Paid so far 3/12"' },
        });
        for (const call of llm.chat.mock.calls.slice(-3)) prompts.push(String(call[0].prompt));
        expect(r.ok).toBe(true); expect(r.revision).toBe(true); expect(r.wire).toBe(null); expect(r.providers.plan).toBe('revision');
        expect(prompts[0]).toMatch(/THE FILE AS IT SHIPPED/); expect(prompts[0]).toMatch(/Paid so far 3\/12/);
        expect(r.code).toMatch(/revised/);
        expect(fs.readFileSync(path.join(d, 'wealthflow-loan-check.js'), 'utf8')).toBe(GOOD);   // the proof run leaves the tree as it found it
    });
    it('a revision of something that has no module name or API is refused, not guessed', async () => {
        const r = await run({ revise: { file: '../x.js', code: 'x', findings: '1. y' } });
        expect(r.ok).toBe(false); expect(r.stage).toBe('plan');
    });
});

describe('wiring into the agent and the workflow', () => {
    const agent = fs.readFileSync(path.join(ROOT, 'autonomous-fix-agent.js'), 'utf8');
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'autonomous-fix.yml'), 'utf8');
    it('the agent routes new things to the lane and falls back to it for features nothing could take', () => {
        expect(agent).toMatch(/buildLaneFor\(/); expect(agent).toMatch(/runBuildLane\(/);
        // 2026-11-19 (#635): the fall-back is one function, and it also takes a report about something that cannot be seen or opened
        expect(agent).toMatch(/\(kind === 'feature' \|\| reachabilityGap\(reportText\)\) && \['select', 'author', 'structure', 'security'\]\.includes\(r\.stage\)/);
    });
    it('the agent wires a built module mechanically and lists the extra files', () => {
        expect(agent).toMatch(/wireModule\(\{ repoDir: REPO_DIR/); expect(agent).toMatch(/extraFiles,/);
    });
    it('the workflow sees an untracked new file as a change and stages the extra files', () => {
        expect(wf).toMatch(/git status --porcelain -- "\$FILE"/);
        expect(wf.match(/extraFiles/g).length).toBeGreaterThanOrEqual(2);
        expect(wf).not.toMatch(/if git diff --quiet -- "\$FILE"/);
    });
});

describe('the fix workflow stages only what the build lane may touch', () => {
    const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'autonomous-fix.yml'), 'utf8');
    it('sees an untracked new module as a change', () => { expect(yml).toMatch(/git status --porcelain -- "\$FILE"/); });
    it('stages index.html, wf-ui.css (the edit lane) and the budget only when the PR file lists them', () => {
        expect(yml.match(/for EXTRA in index\.html wf-ui\.css autonomy\/perf-budget\.mjs/g)).toHaveLength(2);
        expect(yml).toMatch(/extraFiles \|\| \[\]\)\.includes\(process\.argv\[1\]\)/);
    });
});
