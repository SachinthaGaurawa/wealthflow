/* =============================================================================
 * test/ai_format_contract_test.js
 * -----------------------------------------------------------------------------
 * Two functions at opposite ends of index.html share a protocol that nothing
 * declared and nothing enforced.
 *
 *   buildSystemPrompt  tells the model, in its FORMATTING section, to open
 *                      warnings with a warning sign, good news with a tick and
 *                      takeaways with a bulb.
 *
 *   appendAIMessage    matches exactly those three characters at the start of
 *                      a line and turns them into the warning / success / info
 *                      callout boxes.
 *
 * Neither mentions the other. They are ~300 lines apart in a 27,000-line file.
 *
 * WHY THIS TEST EXISTS NOW. The emoji-to-icon migration has been walking this
 * file screen by screen, and buildSystemPrompt is the largest single block of
 * glyphs left in it. It looks exactly like the next thing to clean. Cleaning it
 * would stop the model emitting the markers, every long AI answer would render
 * as flat text, the emoji count would improve, and no test would go red.
 *
 * These glyphs are PROTOCOL, not decoration. This file is the thing that says
 * so out loud, and fails when the two ends stop agreeing.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function fn(name) {
    const at = HTML.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let depth = 0;
    for (let j = HTML.indexOf('{', at); j < HTML.length; j += 1) {
        if (HTML[j] === '{') depth += 1;
        else if (HTML[j] === '}') { depth -= 1; if (depth === 0) return HTML.slice(at, j + 1); }
    }
    return '';
}

const PROMPT = fn('buildSystemPrompt');
const RENDER = fn('appendAIMessage');

/* Named by code point so this file carries no emoji of its own, and so the
 * names say which is which. */
const MARKERS = {
    warning: '⚠️',
    success: '✅',
    info: '\u{1F4A1}',
};

describe('the AI answer format is a contract between two functions', () => {
    it('both ends exist', () => {
        expect(PROMPT, 'buildSystemPrompt is gone').toBeTruthy();
        expect(RENDER, 'appendAIMessage is gone').toBeTruthy();
        expect(PROMPT.length).toBeGreaterThan(2000);
    });

    /* Not "the glyph appears somewhere in the prompt" — that is too weak to be
     * worth writing. The first version of this file asserted exactly that, and
     * a mutation which stripped the marker from the worked EXAMPLE and from one
     * legend entry still passed, because the character survived elsewhere.
     *
     * What the model actually acts on is the instruction that names the marker
     * and says what it is for. So each is pinned to its own instruction line. */
    const INSTRUCTIONS = {
        warning: ['⚠️ (warnings)', "⚠️ **What's wrong**"],
        success: ['✅ (good news)'],
        info: ['\u{1F4A1} (insights)', '\u{1F4A1} **Bottom line:**'],
    };

    it.each(Object.entries(INSTRUCTIONS))(
        'the prompt still INSTRUCTS the model to use the %s marker',
        (_kind, phrases) => {
            for (const phrase of phrases) {
                expect(PROMPT,
                    `buildSystemPrompt no longer tells the model to use this marker (${phrase}), `
                    + 'so appendAIMessage will never see it and the callout it drives is dead')
                    .toContain(phrase);
            }
        },
    );

    it.each(Object.entries(MARKERS))(
        'the %s marker survives in the prompt at all',
        (_kind, glyph) => {
            expect(PROMPT.includes(glyph), 'the marker is gone from the prompt entirely').toBe(true);
        },
    );

    it.each(Object.entries(MARKERS))(
        'the renderer still matches the %s marker',
        (kind, glyph) => {
            const line = RENDER.split('\n').find((l) => l.includes(`ai-callout ${kind}`));
            expect(line, `the ${kind} callout is gone from appendAIMessage`).toBeTruthy();
            expect(line.includes(glyph),
                `the ${kind} callout no longer matches the marker the prompt asks for`)
                .toBe(true);
        },
    );

    it('the two ends name the SAME three markers, not overlapping sets', () => {
        /* The pairwise checks above would both pass if the prompt asked for a
         * fourth marker nothing renders, or if the renderer matched one the
         * prompt never requests. Neither is a crash; both are dead code that
         * looks alive. */
        const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
        const rendererMarkers = new Set(
            RENDER.split('\n')
                .filter((l) => l.includes('ai-callout '))
                .flatMap((l) => (l.slice(0, l.indexOf('/g,')).match(EMOJI) || [])),
        );
        // the variation selector rides along with the warning sign
        rendererMarkers.delete('️');
        const expected = new Set(Object.values(MARKERS).map((g) => g.replace('️', '')));
        expect([...rendererMarkers].sort(),
            'the renderer matches a marker set this test does not know about')
            .toEqual([...expected].sort());
    });

    it('each end points at the other, so the next reader is warned', () => {
        /* A test can only fail after someone has already made the change. The
         * comments are what stop it being made. */
        expect(PROMPT, 'the prompt no longer explains that its glyphs are protocol')
            .toContain('appendAIMessage');
        expect(RENDER, 'the renderer no longer explains where its markers come from')
            .toContain('buildSystemPrompt');
    });

    it('the takeaway line the prompt promises is the one the renderer catches', () => {
        /* Same coupling, second instance: the prompt is told to end long
         * replies with "Bottom line:" or "Best move:", and the renderer turns
         * exactly those words into the takeaway block. */
        for (const phrase of ['Bottom line', 'Best move']) {
            expect(PROMPT, `the prompt stopped asking for "${phrase}"`).toContain(phrase);
            expect(RENDER, `the renderer stopped catching "${phrase}"`).toContain(phrase);
        }
    });
});
