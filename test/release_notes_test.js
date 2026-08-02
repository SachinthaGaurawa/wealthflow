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
 * These tests pin the notes to REAL repository history, not fixtures, because a
 * generator that only works on invented commits is exactly the kind of thing
 * this codebase keeps producing.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

describe('against the real v7.69.17..v7.69.18 history', () => {
    const commits = commitsInRange('v7.69.17', 'v7.69.18', { repoDir: ROOT });
    const r = describeRelease(commits, { version: '7.69.18' });

    it('found the actual commits (not an empty range)', () => {
        expect(commits.length).toBeGreaterThan(3);
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
