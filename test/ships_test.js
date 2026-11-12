/* =============================================================================
 * test/ships_test.js
 * -----------------------------------------------------------------------------
 * Pull request #605 changed CI workflows, agent scripts, tests and documents, and no file of the app. On six of its nine
 * review rounds the user-impact seat (on one provider) blocked it with "the user will see a new update notice" and
 * "the user will see a new screen, Pacemaker", citing a row of an ideas table and a workflow's `name:` line. Whenever
 * the seat ran on another provider it passed. Both objections quoted a real added line, so no existing check caught them.
 *
 * Which files reach the person's device is not a matter of opinion: `.vercelignore` says. The seat is now TOLD that
 * (and told that "nothing on screen changes" is the right answer when nothing is served), and an objection that says
 * the person will SEE a line that is never served is rejected as not a finding.
 *
 * What must NOT happen: a real concern thrown out. Those cases are tested as hard as the replay.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseIgnore, shipsToUser, changedFilesOf, splitByShipping, shippedPartOf, userFactsBlock, claimsSight, filesOfAddedLine, seesWhatNeverShips } from '../autonomy/ships.mjs';
import { runReviewer, REVIEWERS, prompt, DEPLOY_IGNORE, prioritiseDiff } from '../consensus-review.mjs';

const LIST = parseIgnore(fs.readFileSync('.vercelignore', 'utf8'));
const USER = REVIEWERS.find((r) => r.name === 'user-impact');
const SEC = REVIEWERS.find((r) => r.name === 'security');
const file = (name, added) => `diff --git a/${name} b/${name}\nindex 111..222 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,${added.length + 1} @@\n context\n${added.map((l) => '+' + l).join('\n')}\n`;

// The two lines the seat cited on #605, as they were added.
const ROADMAP_ROW = '| 9 | **One update notice a day at most**: when a newer ordinary version arrives after the person chose "later", it replaces the waiting notice and keeps their choice, it does not ask again | If three updates land in a day and each one asks again, then the person learns to dismiss update notices |';
const WORKFLOW_NAME = 'name: Pacemaker (wakes scheduled jobs GitHub skipped)';
const PR_605 = file('.github/workflows/pacemaker.yml', [WORKFLOW_NAME, 'on:', '  schedule:', "    - cron: '7,27,47 * * * *'"])
    + file('autonomy/pacemaker.mjs', ['export const GRACE_MIN = 25;'])
    + file('docs/superior-system-research.md', [ROADMAP_ROW])
    + file('test/pacemaker_test.js', ["it('reads a cron line', () => {});"]);
const APP_CHANGE = file('index.html', ['<button class="btn" id="update-later">Later</button>']) + file('.github/workflows/pacemaker.yml', [WORKFLOW_NAME]);

const says = (obj) => { const f = async () => ({ text: JSON.stringify(obj), provider: 'cohere' }); return f; };
const lane = (role) => ({ role, primary: 'cohere', fallbacks: [] });

describe('which files reach the person', () => {
    it('reads the real deploy list: the app ships, the machinery does not', () => {
        for (const f of ['index.html', 'wealthflow-batches.js', 'sw.js', 'api/ai.js', 'firestore.rules', 'package.json', 'wf-charter.mjs']) expect(shipsToUser(f, LIST), f).toBe(true);
        for (const f of ['.github/workflows/pacemaker.yml', 'autonomy/pacemaker.mjs', 'docs/update-system-reliability-research.md', 'README.md', 'test/route_test.js', 'autonomous-fix-agent.js', 'consensus-review.mjs', 'release.cjs', 'native/android/App.java']) expect(shipsToUser(f, LIST), f).toBe(false);
        expect(DEPLOY_IGNORE.length).toBe(LIST.length);
    });

    it('when the list cannot be read, every file is treated as shipped (never assume harmless)', () => {
        expect(shipsToUser('autonomy/pacemaker.mjs', [])).toBe(true);
        expect(splitByShipping(PR_605, []).unknown).toBe(true);
        expect(userFactsBlock(PR_605, [])).toBe('');
        expect(seesWhatNeverShips('The user will see a new screen.', WORKFLOW_NAME, PR_605, [])).toBe(null);
    });

    it('a pattern keeps its meaning: anchored, any depth, and a later ! keeps a file', () => {
        const p = parseIgnore('/native/\ntest/\n*.md\nbuild/**\n!build/keep.js\n# a comment\n');
        expect(shipsToUser('native/a.java', p)).toBe(false);
        expect(shipsToUser('src/native/a.java', p)).toBe(true);          // anchored to the root
        expect(shipsToUser('pkg/test/a.js', p)).toBe(false);             // a folder name matches at any depth
        expect(shipsToUser('testing/a.js', p)).toBe(true);
        expect(shipsToUser('notes.md', p)).toBe(false);
        expect(shipsToUser('notes.mdx', p)).toBe(true);
        expect(shipsToUser('build/x/y.js', p)).toBe(false);
        expect(shipsToUser('build/keep.js', p)).toBe(true);
    });

    it('lists every changed file, also those a trimmed diff could only name in its manifest', () => {
        expect(changedFilesOf(PR_605)).toEqual(['.github/workflows/pacemaker.yml', 'autonomy/pacemaker.mjs', 'docs/superior-system-research.md', 'test/pacemaker_test.js']);
        const big = file('index.html', Array.from({ length: 400 }, (_, i) => `<div class="card">row ${i} ${'x'.repeat(60)}</div>`)) + PR_605;
        const cut = prioritiseDiff(big, 6000);
        expect(cut.truncated).toBe(true);
        expect(changedFilesOf(cut.text)).toEqual(expect.arrayContaining(['index.html', 'docs/superior-system-research.md', 'test/pacemaker_test.js']));
        expect(splitByShipping(cut.text, LIST).shipped).toEqual(['index.html']);
    });

    it('only the hunks of served files count as interface code', () => {
        expect(shippedPartOf(PR_605, LIST)).toBe('');
        expect(shippedPartOf(APP_CHANGE, LIST)).toContain('update-later');
        expect(shippedPartOf(APP_CHANGE, LIST)).not.toContain('Pacemaker');
    });
});

describe('#605 replayed: an objection about a line the person never receives', () => {
    it('both real objections are recognised as claims of sight about unserved lines', () => {
        const a = seesWhatNeverShips('The user will see a new update notice, which may be confusing and make the app feel less trustworthy.', '+' + ROADMAP_ROW, PR_605, LIST);
        expect(a).toMatch(/docs\/superior-system-research\.md/);
        expect(a).toMatch(/never served/);
        const b = seesWhatNeverShips('The user will see a new screen, "Pacemaker", which is not explained and may be confusing.', '+' + WORKFLOW_NAME, PR_605, LIST);
        expect(b).toMatch(/pacemaker\.yml.*CI workflow/);
        expect(filesOfAddedLine(PR_605, '+' + WORKFLOW_NAME)).toEqual(['.github/workflows/pacemaker.yml']);
    });

    it('the board no longer blocks on it: the vote is a pass that carries the rejected objection', async () => {
        const out = await runReviewer(lane(USER), PR_605, false, says({ verdict: 'FAIL', reason: 'The user will see a new screen, "Pacemaker", which is not explained and may be confusing.', evidence: '+' + WORKFLOW_NAME, concerns: [] }));
        expect(out.vote).toBe('pass');
        expect(out.rejectedFinding.why).toMatch(/never served to their device/);
        expect(out.rejectedFinding.reason).toMatch(/Pacemaker/);          // what was said is kept, for a person to overrule
    });

    it('with no evidence at all, the same claim is rejected only because NO file in the change is served', async () => {
        const claim = { verdict: 'FAIL', reason: 'The user will see a new update notice.', evidence: '', concerns: [] };
        expect((await runReviewer(lane(USER), PR_605, false, says(claim))).vote).toBe('pass');
        expect((await runReviewer(lane(USER), APP_CHANGE, false, says(claim))).vote).toBe('fail');
    });
});

describe('what it must never throw out', () => {
    it('an objection about a line in the app stands', async () => {
        const out = await runReviewer(lane(USER), APP_CHANGE, false, says({ verdict: 'FAIL', reason: 'The user will see a new button labelled "Later" with no explanation of what it postpones.', evidence: '+<button class="btn" id="update-later">Later</button>', concerns: [] }));
        expect(out.vote).toBe('fail');
        expect(out.rejectedFinding).toBe(null);
    });

    it('an INDIRECT effect of a workflow line stands: it does not claim the person sees the line', async () => {
        const reason = 'A fix the owner is waiting for can now arrive up to two hours later, because the release waits for a quiet window.';
        expect(claimsSight(reason)).toBe(false);
        const out = await runReviewer(lane(USER), PR_605, false, says({ verdict: 'FAIL', reason, evidence: "+    - cron: '7,27,47 * * * *'", concerns: [] }));
        expect(out.vote).toBe('fail');
    });

    it('another seat is never touched: a security objection to a workflow line stands whatever it says', async () => {
        const out = await runReviewer(lane(SEC), PR_605, false, says({ verdict: 'FAIL', reason: 'An attacker will see a new way to start workflows.', evidence: '+' + WORKFLOW_NAME, concerns: [] }));
        expect(out.vote).toBe('fail');
    });

    it('a change that edits the deploy list itself is judged with no facts assumed', async () => {
        const d = PR_605 + file('.vercelignore', ['index.html']);
        expect(splitByShipping(d, LIST).unknown).toBe(true);
        expect(userFactsBlock(d, LIST)).toBe('');
        const out = await runReviewer(lane(USER), d, false, says({ verdict: 'FAIL', reason: 'The user will see a new screen, "Pacemaker".', evidence: '+' + WORKFLOW_NAME, concerns: [] }));
        expect(out.vote).toBe('fail');
    });

    it('a line added to both a served and an unserved file is treated as served', () => {
        const d = file('index.html', ['const TITLE = "Pacemaker status";']) + file('autonomy/x.mjs', ['const TITLE = "Pacemaker status";']);
        expect(seesWhatNeverShips('The user will see a new screen.', '+const TITLE = "Pacemaker status";', d, LIST)).toBe(null);
    });

    it('survives junk', () => {
        expect(seesWhatNeverShips(null, null, null, LIST)).toBe(null);
        expect(changedFilesOf(undefined)).toEqual([]);
        expect(filesOfAddedLine('', '')).toEqual([]);
        expect(shippedPartOf(null, LIST)).toBe('');
    });
});

describe('the seat is told the facts before it answers', () => {
    it('only the user-impact seat gets them, and they say that inventing a screen is not asked for', () => {
        const p = prompt(USER, PR_605, false);
        expect(p).toMatch(/FACTS ABOUT THIS CHANGE/);
        expect(p).toMatch(/NONE of the 4 files/);
        expect(p).toMatch(/does NOT ask you to invent/);
        expect(p).toMatch(/INDIRECTLY/);
        expect(p.indexOf('FACTS ABOUT THIS CHANGE')).toBeLessThan(p.indexOf('DIFF ('));      // read before the diff
        expect(prompt(SEC, PR_605, false)).not.toMatch(/FACTS ABOUT THIS CHANGE/);
    });

    it('when the app does change, the served files are named and nothing excuses a denial', () => {
        const p = prompt(USER, APP_CHANGE, false);
        expect(p).toMatch(/Files served to the person's device: `index\.html`/);
        expect(p).not.toMatch(/does NOT ask you to invent/);
        expect(p).toMatch(/never reach the device \(CI workflow\)/);
    });

    it('interface words inside a test or an agent script no longer make a true "nothing on screen changes" a false denial', async () => {
        const d = file('test/new_badge_test.js', ['el.innerHTML = \'<button class="btn">New</button>\';']) + file('autonomy/ideas.mjs', ['export const MAX_BOARDS = 2;']);
        const out = await runReviewer(lane(USER), d, false, says({ verdict: 'PASS', score: 90, reason: 'Nothing the user will see changes: the files are a test and an agent script, so there are no user-facing changes.', evidence: '', concerns: [] }));
        expect(out.vote).toBe('pass');
        expect(out.correctedReason).toBe(null);
    });

    it('the old guard still holds for the app: denying a real interface change is still corrected', async () => {
        const out = await runReviewer(lane(USER), APP_CHANGE, false, says({ verdict: 'PASS', score: 90, reason: 'There are no user-facing changes in this pull request.', evidence: '', concerns: [] }));
        expect(out.vote).toBe('pass');
        expect(out.correctedReason).toMatch(/no user-facing changes/);
    });
});
