/* =============================================================================
 * test/release_notes_test.js
 * -----------------------------------------------------------------------------
 * v7.69.18 shipped a service worker that had never had a fetch handler, a
 * progress bar that had been animating over setTimeout, and a release gate that
 * counted CI work as a user update. Its entire changelog was:
 *
 *     Improvements and fixes in this release.
 *
 * The owner compared that against the release commit — which by design holds
 * nothing but version strings — and concluded the update was fake. The gate was
 * right and the experience was indefensible: a release that will not say what it
 * did cannot be told apart from one that did nothing.
 *
 * The information was never missing. It sat in the commit subjects of the range
 * being released, and in a What's-New renderer that has always accepted
 * { headline, sections: [{title, items}] } and has only ever been handed one
 * sentence. Machinery present, signal absent — twice over.
 *
 * These tests exercise the generator against a REAL git repository built in a
 * temp directory with the exact commit shapes of that range — not stubbed
 * arrays — because a generator that only works on invented objects is exactly
 * the kind of thing this codebase keeps producing.
 *
 * They deliberately do NOT read this repository's own tags. An earlier draft did,
 * passed locally, and failed in CI: the test job checks out shallow with no tags,
 * so the range resolved to nothing. Four assertions failed and a fifth passed
 * vacuously. See buildFixtureRepo() below.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    parseSubject, commitsInRange, describeRelease, touchesUserFacing, SKIP_SUBJECT,
} from '../autonomy/release-notes.cjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_CJS = fs.readFileSync(path.join(ROOT, 'release.cjs'), 'utf8');

describe('subject parsing', () => {
    it('strips the conventional-commit prefix and lifts the PR number', () => {
        const p = parseSubject('fix(update): make the update system tell the truth (#60)');
        expect(p.type).toBe('fix');
        expect(p.text).toBe('Make the update system tell the truth');
        expect(p.pr).toBe(60);
    });

    it('handles a bare subject with no prefix', () => {
        const p = parseSubject('Delete README.md');
        expect(p.text).toBe('Delete README.md');
        expect(p.pr).toBe(null);
    });

    it('does not mangle a subject containing colons or parentheses', () => {
        const p = parseSubject('fix(ci): the gate asked "does this PR need approval?" when there was none (#63)');
        expect(p.text).toMatch(/^The gate asked "does this PR need approval\?"/);
        expect(p.pr).toBe(63);
    });

    it('leaves a "(#12)" that is not at the end alone', () => {
        // Only a trailing reference is the PR link; one mid-sentence is prose.
        const p = parseSubject('fix: revert the (#12) experiment and start over');
        expect(p.pr).toBe(null);
        expect(p.text).toContain('(#12)');
    });
});

describe('bookkeeping commits never appear in notes', () => {
    it('skips release, merchant-chore, merge and revert-quote commits', () => {
        for (const s of [
            'release: v7.69.18 — patch',
            'chore(merchants): auto-expand + verify merchant list [skip ci]',
            'Merge branch main into x',
            'Merge pull request #5 from y',
        ]) {
            expect(SKIP_SUBJECT.test(s), `"${s}" should be skipped`).toBe(true);
        }
    });

    it('does NOT skip real work', () => {
        for (const s of [
            'fix(update): make the update system tell the truth (#60)',
            'feat(income): derive income from provenance (#51)',
            'perf: measure the shipped payload (#31)',
        ]) {
            expect(SKIP_SUBJECT.test(s), `"${s}" must be kept`).toBe(false);
        }
    });
});

describe('user-facing vs internal uses the SAME rule as the release gate', () => {
    it('counts shipped code as user-facing', () => {
        expect(touchesUserFacing(['sw.js'])).toBe(true);
        expect(touchesUserFacing(['wealthflow-insights.js'])).toBe(true);
        expect(touchesUserFacing(['api/router.js'])).toBe(true);
    });

    it('counts pipeline and data as not user-facing', () => {
        expect(touchesUserFacing(['.github/workflows/x.yml'])).toBe(false);
        expect(touchesUserFacing(['autonomy/discover.mjs', 'test/a_test.js'])).toBe(false);
        expect(touchesUserFacing(['merchants.json', 'CHANGELOG.md'])).toBe(false);
    });

    it('a mixed commit is user-facing — one shipped file is enough', () => {
        expect(touchesUserFacing(['.github/workflows/x.yml', 'sw.js'])).toBe(true);
    });
});

/**
 * A throwaway git repo with the exact commit shapes of the v7.69.17..v7.69.18
 * range, built here so the git plumbing is tested wherever this suite runs.
 *
 * WHY THIS EXISTS INSTEAD OF READING THIS REPO'S OWN TAGS
 * The first version of these tests called commitsInRange('v7.69.17','v7.69.18')
 * against ROOT. That passed locally and failed in CI, because the test job
 * checks out with actions/checkout's default fetch-depth: 1 — a shallow clone
 * with no tags — so the range could not be resolved and commitsInRange returned
 * [].
 *
 * Four assertions failed honestly. The fifth PASSED VACUOUSLY: it asserted that
 * JSON.stringify(structured) did not contain "release: v", and structured was
 * null, so "null" satisfied it. A test that stops testing without going red is
 * the exact defect this codebase keeps producing, and I had just written one.
 *
 * Building the history here fixes both problems at once: the git integration is
 * genuinely exercised, and it cannot silently become a no-op depending on how
 * the checkout was configured.
 */
function buildFixtureRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-notes-'));
    const git = (args) => execFileSync('git', args, {
        cwd: dir, encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
            GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
        },
    });
    git(['init', '-q', '-b', 'main']);
    const commit = (subject, files) => {
        for (const f of files) {
            fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
            fs.appendFileSync(path.join(dir, f), 'x\n');
        }
        git(['add', '-A']);
        git(['commit', '-q', '-m', subject]);
    };
    commit('base', ['README.md']);
    git(['tag', 'v7.69.17']);
    // The real shapes, in the real order.
    commit('fix(update): make the update system tell the truth (#60)',
        ['sw.js', 'wealthflow-update-system.js']);
    commit('fix(feedback): close the loop back to the owner when a fix ships (#61)',
        ['.github/workflows/autonomous-fix.yml', 'test/a_test.js']);
    commit('fix(ci): the Risk gate was blind to the files that define the Risk gate (#62)',
        ['.github/workflows/wealthflow-ci.yml']);
    commit('fix(ci): the Risk gate asked "does this PR need approval?" when there was no PR (#63)',
        ['.github/workflows/wealthflow-ci.yml', 'test/b_test.js']);
    commit('fix(discover): the scanner lost half its detectors, then refused to exit (#64)',
        ['autonomy/discover.mjs']);
    commit('chore(merchants): auto-expand + verify merchant list [skip ci]', ['merchants.json']);
    commit('release: v7.69.18 — patch', ['version.json']);
    git(['tag', 'v7.69.18']);
    return dir;
}

describe('against a real git repo carrying the v7.69.17..v7.69.18 shapes', () => {
    const dir = buildFixtureRepo();
    const commits = commitsInRange('v7.69.17', 'v7.69.18', { repoDir: dir });
    const r = describeRelease(commits, { version: '7.69.18' });

    it('reads the range through actual git, not a stubbed list', () => {
        // Guards the vacuous-pass failure mode: if this is 0, every assertion
        // below is meaningless, so fail here first and say why.
        expect(commits.length, 'commitsInRange returned nothing — git plumbing broken').toBe(7);
        expect(commits[0].files.length).toBeGreaterThan(0);
    });

    it('separates the one change the owner would notice from the four he would not', () => {
        expect(r.userFacing).toBe(1);
        expect(r.internal).toBe(4);
        expect(r.summary).toMatch(/1 change you may notice, 4 internal/);
    });

    it('names the service-worker work rather than saying "improvements"', () => {
        expect(r.markdown).toMatch(/update system tell the truth/i);
        expect(r.markdown).toMatch(/#60/);
        expect(r.markdown).not.toMatch(/Improvements and fixes/);
    });

    it('puts the pipeline PRs under the hood, not in front of the owner', () => {
        const [userSec, internalSec] = r.structured.sections;
        expect(userSec.title).toBe('What changed for you');
        expect(userSec.items).toHaveLength(1);
        expect(internalSec.title).toBe('Under the hood');
        expect(internalSec.items.join(' ')).toMatch(/#6[1-4]/);
    });

    it('excludes the release commit and the merchant chore from both sections', () => {
        // This assertion is only meaningful if structured exists — a null here
        // stringifies to "null" and would satisfy both negative matches while
        // testing nothing. That is precisely how this test passed in CI while
        // its four siblings failed.
        expect(r.structured, 'nothing to inspect — the negative matches below would be vacuous').not.toBe(null);
        const all = JSON.stringify(r.structured);
        expect(all).not.toMatch(/release: v/);
        expect(all).not.toMatch(/auto-expand/);
    });
});

describe('the shape the What\'s-New sheet can actually render', () => {
    const r = describeRelease(
        [{ sha: 'a', subject: 'fix(x): thing (#1)', files: ['sw.js'] }],
        { version: '9.9.9' },
    );

    it('emits { headline, sections:[{title, items}] } — what _normNotes passes through', () => {
        // _normNotes short-circuits on `Array.isArray(n.sections)`, so this shape
        // reaches the renderer untouched and draws as a real sectioned sheet.
        expect(Array.isArray(r.structured.sections)).toBe(true);
        expect(r.structured.headline).toBe("What's new in v9.9.9");
        expect(r.structured.sections[0].items[0]).toBe('Thing (#1)');
    });

    it('sends plain text, never markdown — the renderer escapes its input', () => {
        // A "**bold**" here would display literally as asterisks to the owner.
        const flat = JSON.stringify(r.structured);
        expect(flat).not.toMatch(/\*\*/);
        expect(flat).not.toMatch(/^- /m);
    });
});

describe('an undescribable release says so instead of padding', () => {
    it('returns null structured notes and an honest line', () => {
        const r = describeRelease([{ sha: 'a', subject: 'release: v1.2.3', files: ['version.json'] }]);
        expect(r.userFacing).toBe(0);
        expect(r.internal).toBe(0);
        expect(r.structured).toBe(null);
        expect(r.markdown).toMatch(/No described changes/);
        expect(r.markdown).not.toMatch(/Improvements and fixes/);
    });

    it('says "nothing user-facing" plainly when only internals changed', () => {
        const r = describeRelease([
            { sha: 'a', subject: 'ci: bump runner (#9)', files: ['.github/workflows/x.yml'] },
        ]);
        expect(r.userFacing).toBe(0);
        expect(r.summary).toMatch(/nothing user-facing/);
        expect(r.structured.sections[0].title).toBe('Internal changes only');
    });
});

describe('release.cjs consumes it, and the boilerplate is gone', () => {
    it('no longer EMITS the sentence that caused this', () => {
        // Asserted against executable code with comments stripped. The first
        // draft of this test failed on release.cjs's own comment, which quotes
        // the old line verbatim to explain why it was removed — a grep cannot
        // tell documentation from behaviour, and the documentation is worth
        // keeping. What matters is that nothing can still assign it.
        const code = RELEASE_CJS
            .split('\n')
            .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
            .join('\n');
        expect(code).not.toMatch(/Improvements and fixes in this release/);
        // And the fallback that remains must not pretend to describe anything.
        expect(code).toMatch(/Maintenance release — see the commit log for details/);
    });

    it('derives notes and stores them module-scoped for both writers', () => {
        expect(RELEASE_CJS).toMatch(/require\('\.\/autonomy\/release-notes\.cjs'\)\.notesForRelease/);
        expect(RELEASE_CJS).toMatch(/RELEASE_NOTES = AUTO_NOTES/);
    });

    it('version.json gets the structured object, CHANGELOG gets the markdown', () => {
        // One source, two renderings. Two independent summaries of one release
        // is how a changelog and a What's-New sheet drift apart.
        expect(RELEASE_CJS).toMatch(/vj\.notes\[next\] = \(RELEASE_NOTES && RELEASE_NOTES\.structured\)/);
        expect(RELEASE_CJS).toMatch(/const detail = \(RELEASE_NOTES && RELEASE_NOTES\.markdown\)/);
    });

    it('an explicit --note still wins over the derived text', () => {
        // Deriving must not override a human who said what the release is.
        const i = RELEASE_CJS.indexOf('let AUTO_NOTES = null;');
        expect(i, 'anchor not found — retarget this test').toBeGreaterThan(-1);
        expect(RELEASE_CJS.slice(i, i + 400)).toMatch(/if \(!NOTE\) \{/);
    });
});
