/* The autonomous fix agent's proving test is repaired from its real error, not thrown away.
 *
 * WHAT HAPPENED (issue #492, attempt 3/3, 2026-11-03): the fix was written as a patch, passed the mechanical gates and the
 * independent security review, and then died at the proof stage: "the test still fails against the FIXED file". Agent 4 had
 * one try, the Vitest output that said WHY was discarded, and the whole attempt (one of three) was spent. A correct change
 * was lost to a wrong selector in a generated test.
 *
 * These tests run the real runSwarm() with a scripted model and a scripted Vitest, and check that
 *   - the real output of a failed run goes back to Agent 4 for another try (up to TEST_ROUNDS),
 *   - the run still demands red-before / green-after (a test that passes on the unfixed file is rejected and told so),
 *   - when every try fails the run says so, with the output, instead of a bare "did not prove anything",
 *   - the prompt points at the shared loader that gives a real DOM.
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
            return { text: next, provider: o.exclude && o.exclude.includes('p1') ? 'p2' : 'p1' };
        },
    };
});

const { runSwarm, testPrompt, testRepairPrompt, TEST_ROUNDS } = await import('../autonomy/agent-swarm.mjs');
const { proofEvidence } = await import('../autonomous-fix-agent.js');

const ISSUE = 'Show the build id (the short deploy sha) next to the version in Settings > Software update so I can see which build I run.';
const PATCH = [
    '<<<<<<< SEARCH',
    '        el.textContent = "Software update v" + version;',
    '=======',
    '        el.textContent = "Software update v" + version + " (build " + (window.__WF_BUILD || "?") + ")";',
    '>>>>>>> REPLACE',
].join('\n');
const PASS = '{"verdict":"PASS","severity":"none","findings":[],"reason":"display only"}';

/** A test file that is shaped like a test; `tag` is what the scripted Vitest looks at. */
const testFile = (tag) => `import { it, expect } from 'vitest';\n// ${tag}\nit('shows the build id', () => { expect(1).toBe(1); });\n`;

describe('runSwarm — the proving test is repaired from its real error', () => {
    let dir, runs;
    beforeEach(() => {
        script.replies = []; script.calls = []; runs = [];
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-repair-'));
        fs.mkdirSync(path.join(dir, 'test'));
        const filler = Array.from({ length: 1500 }, (_, i) => `    var pad${i} = ${i}; // padding to exceed whole-file limit`).join('\n');
        fs.writeFileSync(path.join(dir, 'wealthflow-update-system.js'), [
            '(function(){', filler,
            '    function renderSoftwareUpdateCard(el, version) {',
            '        el.textContent = "Software update v" + version;',
            '    }',
            '    window.renderSoftwareUpdateCard = renderSoftwareUpdateCard;',
            '})();', '',
        ].join('\n'));
    });

    /** Scripted Vitest: red on the unfixed file always; on the fixed file green only for a test tagged GOOD. */
    const vitest = (tf, { repoDir }) => {
        const target = fs.readFileSync(path.join(repoDir, 'wealthflow-update-system.js'), 'utf8');
        const src = fs.readFileSync(path.join(repoDir, tf), 'utf8');
        const fixed = target.includes('(build ');
        runs.push({ fixed, tag: (src.match(/\/\/ (\w+)/) || [])[1] });
        if (!fixed) return { passed: false, output: 'AssertionError: expected text to contain (build' };
        if (src.includes('PASSES_EVERYWHERE')) return { passed: true, output: '' };
        return src.includes('GOOD') ? { passed: true, output: '' } : { passed: false, output: 'TypeError: Cannot read properties of null (reading "textContent")\n    at test/x.test.js:3:44' };
    };
    const run = () => runSwarm({
        issue: { title: 'Show build id', body: ISSUE, number: 492, kind: 'feature' },
        repoDir: dir, env: { CI: '' }, runTest: vitest, log: () => {},
    });
    const head = ['wealthflow-update-system.js', PATCH, PASS];

    it('a test that fails on the fixed file goes back to Agent 4 WITH the real output, and the second try is accepted', async () => {
        script.replies = [...head, testFile('BAD'), testFile('GOOD')];
        const r = await run();
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.verified).toBe(true);
        expect(r.testFile).toMatch(/^test\/auto-wealthflow-update-system-492\.test\.js$/);
        expect(r.test).toContain('GOOD');

        const qa = script.calls.filter((c) => /Vitest test/.test(c.prompt));
        expect(qa.length).toBe(2);
        expect(qa[0].prompt).not.toMatch(/PREVIOUS TEST WAS EXECUTED/);
        expect(qa[1].prompt).toMatch(/YOUR PREVIOUS TEST WAS EXECUTED AND REJECTED/);
        expect(qa[1].prompt).toContain('Cannot read properties of null');   // the real output, not a paraphrase
        expect(qa[1].prompt).toContain('// BAD');                           // and the test it is about
        // red before, green after, for the accepted test
        expect(runs.filter((x) => x.tag === 'GOOD').map((x) => x.fixed)).toEqual([false, true]);
    });

    it('still demands red-before: a test that also passes on the UNFIXED file is rejected and the model is told why', async () => {
        const decorative = (tf, o) => { runs.push(tf); return { passed: true, output: '' }; };
        script.replies = [...head, testFile('PASSES_EVERYWHERE'), testFile('PASSES_EVERYWHERE'), testFile('PASSES_EVERYWHERE')];
        const r = await runSwarm({ issue: { title: 'Show build id', body: ISSUE, number: 492, kind: 'feature' }, repoDir: dir, env: { CI: '' }, runTest: decorative, log: () => {} });
        expect(r.ok).toBe(false);
        expect(r.stage).toBe('proof');
        expect(r.testRounds.length).toBe(TEST_ROUNDS);
        expect(r.testRounds[0].reason).toMatch(/passes against the UNFIXED file/);
        expect(script.calls.filter((c) => /PREVIOUS TEST WAS EXECUTED/.test(c.prompt))[0].prompt).toMatch(/passes against the UNFIXED file/);
    });

    it('after TEST_ROUNDS failed tries the run fails loudly and keeps the last output for the issue comment', async () => {
        script.replies = [...head, testFile('BAD'), testFile('BAD'), testFile('BAD')];
        const r = await run();
        expect(r.ok).toBe(false);
        expect(r.stage).toBe('proof');
        expect(r.reason).toMatch(new RegExp(`after ${TEST_ROUNDS} tries`));
        expect(r.testRounds.length).toBe(TEST_ROUNDS);
        expect(r.testProof.output).toContain('Cannot read properties of null');
        // the target file is handed back exactly as found
        expect(fs.readFileSync(path.join(dir, 'wealthflow-update-system.js'), 'utf8')).not.toContain('(build ');
        expect(fs.existsSync(path.join(dir, 'test', 'auto-wealthflow-update-system-492.test.js'))).toBe(false);

        const text = proofEvidence(r);
        expect(text).toMatch(/3 tries, none went from failing to passing/);
        expect(text).toContain('Cannot read properties of null');
        expect(text).toMatch(/```\n[\s\S]*\n```/);
    });

    it('output that contains a code fence cannot break out of the comment', () => {
        const text = proofEvidence({ testProof: { output: 'oops ```\n# injected heading' }, testRounds: [] });
        expect((text.match(/```/g) || []).length).toBe(2);
    });

    it('something that is not even a test counts as a try and is explained to the model', async () => {
        script.replies = [...head, 'sorry, I cannot write that test', testFile('GOOD')];
        const r = await run();
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(script.calls.filter((c) => /PREVIOUS TEST WAS EXECUTED/.test(c.prompt))[0].prompt).toMatch(/not a runnable Vitest file/);
    });
});

describe('the test prompts', () => {
    it('point the model at the shared loader with a real DOM, and say how to use it', () => {
        const p = testPrompt('some issue', 'wealthflow-update-system.js', 'before', 'after');
        expect(p).toMatch(/loadBrowserModule/);
        expect(p).toMatch(/helpers\/load-browser-module\.js/);
        expect(p).toMatch(/linkedom is installed/);
        expect(p).toMatch(/Do NOT hand-build `document`/);
    });

    it('the loader the prompt names really exists and exports what the prompt says', async () => {
        const mod = await import('./helpers/load-browser-module.js');
        expect(typeof mod.loadBrowserModule).toBe('function');
    });

    it('the repair prompt carries the output, the old test, and forbids changing the code', () => {
        const p = testRepairPrompt('issue', 'f.js', 'before', 'after', 'OLD TEST BODY', { reason: 'boom', output: 'REAL VITEST OUTPUT' });
        expect(p).toContain('REAL VITEST OUTPUT');
        expect(p).toContain('OLD TEST BODY');
        expect(p).toMatch(/Fix THE TEST/);
        expect(p).toMatch(/Return ONLY the complete test file/);
        expect(p).toMatch(/MUST FAIL/);   // the original red→green contract is repeated
    });
});
