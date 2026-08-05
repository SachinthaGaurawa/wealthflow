/* =============================================================================
 * test/agent_churn_test.js  —  why issue #71 was retried fifteen times
 * -----------------------------------------------------------------------------
 * Issue #71 is the owner's highest-severity report: "Notifications have a bug.
 * This is a critical issue. Very critical". Between 2 and 5 August the agent
 * attempted it FIFTEEN times. Every comment announced "attempt 1/3":
 *
 *     9 ×  author    — "model returned no change"
 *     6 ×  structure — "unbalanced braces" / "output lost 54-56% of the file"
 *
 * TWO INDEPENDENT DEFECTS, EACH SUFFICIENT ON ITS OWN
 *
 * 1. THE COUNTER NEVER ADVANCED.
 *    autonomy/state/issue-N.json only reaches the repo on the paths that open a
 *    PR — autonomous-fix.yml runs `git add -- autonomy/state` inside the success
 *    branches only. A failed attempt writes it to the runner's disk and the
 *    runner is destroyed. `autonomy/state/` holds exactly one file, issue-48,
 *    and none for #71 after fifteen tries. So isStuck() never fired, `ai-stuck`
 *    was never applied, and the owner was never asked.
 *
 *    The durable signal existed the whole time: every attempt posts a comment
 *    marked `<!-- wf-agent-attempt -->`, and attemptsFrom() has counted exactly
 *    those from the start — exported, tested, and called by nothing.
 *
 * 2. THE FILE WAS TOO BIG TO REWRITE.
 *    candidateFiles() offered anything up to 120 KB while authorPrompt() asks
 *    for the COMPLETE file at maxTokens 16_000, and llm-router.mjs declares no
 *    per-provider output cap. wealthflow-notifications.js is 42 KB. It was never
 *    winnable, and the failure message never said so.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attemptsFrom } from '../autonomy/work-queue.mjs';
import {
    candidateFiles, oversizedFiles, MAX_AUTHORABLE_BYTES,
} from '../autonomy/agent-swarm.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const attempt = (n) => Array.from({ length: n }, () => ({ body: '<!-- wf-agent-attempt -->\n### 🤖 Autonomous attempt' }));

describe('the attempt count survives a failed run', () => {
    it('counts the agent\'s own comment trail', () => {
        expect(attemptsFrom(attempt(15))).toBe(15);
    });

    it('ignores comments that are not attempts', () => {
        const mixed = [...attempt(2), { body: 'a human saying something' }, { body: '### ✅ Shipped in v7.69.19' }];
        expect(attemptsFrom(mixed)).toBe(2);
    });

    it('survives junk without throwing', () => {
        expect(attemptsFrom(null)).toBe(0);
        expect(attemptsFrom([{ }, { body: null }, { body: 123 }])).toBe(0);
    });

    it('#71 would now be recognised as stuck on the very next run', () => {
        // The regression that matters: fifteen real comments exist on that
        // issue today. Under the old readState-only path this was 0.
        const MAX_ATTEMPTS = 3;
        expect(attemptsFrom(attempt(15))).toBeGreaterThanOrEqual(MAX_ATTEMPTS);
    });

    it('the agent actually calls it now — it had no caller at all before', () => {
        // attemptsFrom() and issueComments() were exported and unit-tested from
        // the start, and nothing in production referenced either. That is the
        // defect this whole file is about, so assert the wiring exists.
        const src = fs.readFileSync(path.join(ROOT, 'autonomous-fix-agent.js'), 'utf8');
        expect(src).toMatch(/Q\.attemptsFrom\(await Q\.issueComments\(number\)\)/);
        expect(src).toMatch(/reconcileAttempts\(number, readState\(number\)\)/);
    });
});

describe('the agent only takes files it can actually rewrite', () => {
    const sandbox = () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-size-'));
        fs.writeFileSync(path.join(dir, 'wealthflow-small.js'), 'x'.repeat(10_000));
        fs.writeFileSync(path.join(dir, 'wealthflow-huge.js'), 'x'.repeat(42_386)); // the real notifications size
        return dir;
    };

    it('excludes a file larger than one model response', () => {
        const dir = sandbox();
        const picked = candidateFiles(fs.readdirSync(dir), { repoDir: dir });
        expect(picked).toContain('wealthflow-small.js');
        expect(picked).not.toContain('wealthflow-huge.js');
    });

    it('reports the oversized file instead of silently dropping it', () => {
        // Silently excluding it would just move the mystery: the owner would get
        // "no safe editable file matches this issue" fifteen more times.
        const dir = sandbox();
        const over = oversizedFiles(fs.readdirSync(dir), { repoDir: dir });
        expect(over.map((x) => x.file)).toEqual(['wealthflow-huge.js']);
        expect(over[0].bytes).toBe(42_386);
    });

    it('the ceiling is well under what the author step can emit', () => {
        // 16k output tokens at ~3.3 B/token is ~53 KB in the best case, and the
        // router declares no per-provider cap, so free tiers may deliver far
        // less. The ceiling has to survive a provider halving the request.
        expect(MAX_AUTHORABLE_BYTES).toBeLessThanOrEqual(32_000);
        expect(MAX_AUTHORABLE_BYTES).toBeGreaterThan(16_000);   // not so tight it excludes everything
    });

    it('the real notifications module is over the line, and honestly so', () => {
        // The file behind #70 and #71. This test exists to make the tradeoff
        // explicit rather than incidental: it is out of the agent's reach, and
        // the pipeline now says so instead of failing forever.
        const bytes = fs.statSync(path.join(ROOT, 'wealthflow-notifications.js')).size;
        expect(bytes).toBeGreaterThan(MAX_AUTHORABLE_BYTES);
        const over = oversizedFiles(fs.readdirSync(ROOT), { repoDir: ROOT });
        expect(over.map((x) => x.file)).toContain('wealthflow-notifications.js');
    });

    it('still leaves most of the app selectable — not a cure by amputation', () => {
        const picked = candidateFiles(fs.readdirSync(ROOT), { repoDir: ROOT });
        expect(picked.length).toBeGreaterThanOrEqual(25);
        expect(picked).toContain('wealthflow-icons.js');
    });

    it('a sensitive file is still excluded regardless of size', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-sens-'));
        fs.writeFileSync(path.join(dir, 'vitest.config.js'), 'x'.repeat(100));
        fs.writeFileSync(path.join(dir, 'wealthflow-ok.js'), 'x'.repeat(100));
        const picked = candidateFiles(fs.readdirSync(dir), { repoDir: dir });
        expect(picked).toEqual(['wealthflow-ok.js']);
    });
});
