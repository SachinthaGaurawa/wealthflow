/* =============================================================================
 * test/img_alt_test.js  —  issue #36
 * -----------------------------------------------------------------------------
 * "[MEDIUM] Image without alt text in index.html", open since 31 July with
 * twenty comments and no fix. index.html is on the swarm's SENSITIVE list, so
 * the agent could never touch it — every one of those attempts was doomed
 * before it started.
 *
 * WHAT WAS ACTUALLY MISSING
 * Two real images, out of ten:
 *   · the image the user attaches to an AI chat message (a base64 data URI)
 *   · the profile photo in Settings → Account & Identity
 *
 * The other two the naive grep flags are false positives — comment lines whose
 * PROSE contains the literal string `<img>`:
 *     // ---- IMAGE GENERATION: short-circuit, return an <img> ----
 *     // Restore SAFE generated <img> tags (image generation feature).
 * A checker that cannot tell code from commentary produces exactly the kind of
 * un-actionable report that made this issue sit for a week, so this one strips
 * comments first.
 *
 * WHY THE AVATAR GETS alt="" AND NOT alt="<name>"
 * The user's name is rendered immediately beside it. An accessible name on the
 * image would make a screen reader announce the same person twice, so the image
 * is decorative and an EMPTY alt is the correct markup — not a missing one.
 * It also keeps user-controlled text out of an HTML attribute.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** index.html with HTML comments and whole-line JS comments removed. */
const CODE = HTML
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''))
    .join('\n');

/**
 * Real `<img …>` tags, on one line.
 *
 * The `[^>\n]` rather than `[^>]` is load-bearing. index.html contains this
 * JavaScript REGEX LITERAL:
 *
 *     /<img\s+src="data:image/i.test(text) || …
 *
 * With `[^>]*` the matcher swallowed everything from that literal down to the
 * next `>` several lines later and reported it as an img tag with no alt —
 * a defect that does not exist, in a file nobody could edit anyway. The first
 * draft of this very test did exactly that, which is the same "cannot tell code
 * from commentary" failure that made #36 sit for a week collecting agent noise.
 * A checker that invents findings is worse than no checker.
 */
const imgTags = (src) => src.match(/<img\b[^>\n]*>/gi) || [];

describe('every image in the shipped app has an alt attribute', () => {
    it('finds the images at all (guards against a vacuous pass)', () => {
        // If a refactor renames or templates these away, this suite must fail
        // loudly rather than quietly assert nothing.
        expect(imgTags(CODE).length).toBeGreaterThanOrEqual(6);
    });

    it('leaves none without alt', () => {
        const missing = imgTags(CODE).filter((t) => !/\balt\s*=/.test(t));
        expect(missing, `img tag(s) with no alt attribute:\n${missing.join('\n')}`).toEqual([]);
    });

    it('the attached-image preview describes itself', () => {
        const tag = imgTags(CODE).find((t) => /base64/.test(t));
        expect(tag, 'the AI chat image preview has moved — retarget this test').toBeTruthy();
        expect(tag).toMatch(/alt="Image you attached"/);
    });

    it('the settings avatar is marked decorative rather than left bare', () => {
        // alt="" is a deliberate, meaningful choice here. A MISSING alt and an
        // EMPTY alt look similar in a diff and mean opposite things to a screen
        // reader: "guess from the filename" versus "skip this, it is decoration".
        const tag = imgTags(CODE).find((t) => /\$\{userPhoto\}/.test(t));
        expect(tag, 'the settings avatar has moved — retarget this test').toBeTruthy();
        expect(tag).toMatch(/alt=""/);
    });

    it('does not interpolate user-controlled text into the avatar alt', () => {
        // The reason alt="" beats alt="${userName}" twice over: the display name
        // comes from the Google account and would land unescaped in an attribute.
        const tag = imgTags(CODE).find((t) => /\$\{userPhoto\}/.test(t));
        expect(tag).not.toMatch(/alt="\$\{/);
    });
});

describe('the checker itself is honest', () => {
    it('does not count a comment that merely mentions an img tag', () => {
        // Both of these are real lines in index.html. A grep-based report
        // flagged them as defects, which is how #36 accumulated twenty comments
        // of agent churn without a single actionable finding.
        const withComments = [
            '// ---- IMAGE GENERATION: short-circuit, return an <img> ----',
            '// Restore SAFE generated <img> tags (image generation feature).',
            '<img src="a.png" alt="real">',
        ].join('\n');
        const stripped = withComments.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
        expect(imgTags(stripped)).toHaveLength(1);
    });

    it('would still catch a genuinely bare tag', () => {
        // A checker that has never rejected anything is not a checker.
        expect(imgTags('<img src="x.png">').filter((t) => !/\balt\s*=/.test(t))).toHaveLength(1);
    });

    it('does not mistake a JavaScript regex literal for a tag', () => {
        // Verbatim shape of the line in index.html that fooled the first draft.
        const src = [
            'const looksLikeImg = /<img\\s+src="data:image/i.test(text) ||',
            '    /style="[^"]*object-fit:cover/i.test(text);',
            'el.innerHTML = `<img src="a.png" alt="ok">`;',
        ].join('\n');
        const tags = imgTags(src);
        expect(tags).toHaveLength(1);
        expect(tags[0]).toMatch(/alt="ok"/);
    });
});
