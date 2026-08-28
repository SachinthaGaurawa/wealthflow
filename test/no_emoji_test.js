/* =============================================================================
 * test/no_emoji_test.js
 * -----------------------------------------------------------------------------
 * The owner's rule, in their words: never use emoji in this system, use icons —
 * "emoji use කරාම මේ සිස්ටම් එකේ professional එක නැතුවම යනවා."
 *
 * wealthflow-icons.js already existed and its own first line says "professional
 * inline-SVG icon system (no emojis)". So the principle was not new; it was
 * simply not enforced anywhere, and new code kept reintroducing what the icon
 * system was built to remove — including, most recently, mine.
 *
 * WHY A RATCHET AND NOT A BAN
 *
 * There are 1,428 emoji characters across the app today. A single pull request
 * that removed all of them would touch nearly every screen, could not be
 * meaningfully reviewed, and would be exactly the kind of unverifiable change
 * this project has been burned by. A flat ban would therefore be red on day one,
 * which means it would be skipped, then deleted — the same failure the perf
 * budget's own header describes having produced three variants of.
 *
 * So this file does two different things:
 *
 *   1. A HARD ZERO on the surfaces built under the rule. New UI does not get to
 *      add emoji, ever. That is enforced exactly, not ratcheted.
 *   2. A RATCHET on everything else, set at the current measured count. It
 *      cannot go up. Every future change either leaves the number alone or
 *      lowers it, and the remaining migration can land screen by screen with
 *      each step actually reviewable.
 *
 * ANY LOWERING SHOULD BE TAKEN OFF THE CEILING, not left as slack — a ratchet
 * that is not tightened after an improvement quietly permits the improvement to
 * be undone.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* Pictographs, dingbats, arrows-as-symbols and the variation selector. NOT the
 * box-drawing characters (─ ═) used for comment dividers throughout this
 * repository: those are structure in source, never glyphs on a screen, and
 * catching them would make the count meaningless — 17,542 of them would swamp
 * the 1,428 that actually matter. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{23E9}-\u{23FF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/gu;

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');

function countIn(src) {
    return (String(src).match(EMOJI) || []).length;
}

/** The body of a top-level `function NAME(` in index.html. */
function fn(name) {
    const at = html.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let depth = 0;
    for (let j = html.indexOf('{', at); j < html.length; j += 1) {
        if (html[j] === '{') depth += 1;
        else if (html[j] === '}') { depth -= 1; if (depth === 0) return html.slice(at, j + 1); }
    }
    return html.slice(at);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. HARD ZERO on the surfaces built under the rule
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the screens built under this rule carry no emoji at all', () => {
    it.each([
        ['openBankVault', 'the bank password vault'],
        ['renderMailSync', 'the Statement Sync card'],
        ['_mailStageChip', 'the pipeline stage chips'],
        ['runMailSync', 'the pipeline runner'],
        ['checkSweepNudge', 'the idle-cash notification'],
    ])('%s (%s)', (name) => {
        const body = fn(name);
        expect(body, `${name} not found — this guard would pass vacuously`).toBeTruthy();
        const found = body.match(EMOJI) || [];
        expect(found, `emoji in ${name}: ${found.join(' ')}`).toEqual([]);
    });

    it('uses the icon system rather than a glyph of its own', () => {
        /* The point is not merely "no emoji" — it is that the replacement is a
         * real inline SVG inheriting colour from its container, which a
         * fixed-colour system-font glyph can never do.
         *
         * A full inventory, not a sample: a mutation that replaced the eye
         * button's icon with the plain word "show" passed a three-icon spot
         * check. Removing an icon is not an emoji violation, so the count above
         * cannot catch it — only naming each one does. */
        expect(fn('_mailStageChip')).toContain('WFIcon(icon)');
        for (const [where, icon] of [
            ['openBankVault', 'lock'],
            ['openBankVault', 'eye'],
            ['openBankVault', 'x'],
            ['renderMailSync', 'refresh'],
            ['renderMailSync', 'clock'],
            ['renderMailSync', 'cloudDownload'],
            ['checkSweepNudge', 'trendUp'],
        ]) {
            expect(fn(where), `${where} lost its ${icon} icon`).toContain(`WFIcon('${icon}')`);
        }
        // and the stage chips still name every state's icon
        const chips = fn('_mailStageChip');
        for (const icon of ['clock', 'refresh', 'lock', 'fileText', 'checkCircle', 'alert']) {
            expect(chips, `stage icon "${icon}" is gone`).toContain(`'${icon}'`);
        }
    });

    it('leaves the lock-screen TITLE plain, while the in-app banner still gets an icon', () => {
        /* Two different surfaces from one call, and they need opposite answers.
         *
         * `title` is handed to the OS notification, where body and title are
         * plain text — an inline SVG there renders as literal markup, which is
         * the same defect as the raw <b> that reached a lock screen two changes
         * ago. So the title loses its glyph and gains nothing.
         *
         * `icon` is drawn into the in-app banner's innerHTML, which does render
         * SVG, so that one becomes a real icon.
         *
         * The first version of this test asserted the whole function contained
         * no WFIcon call at all, which contradicted the design it was meant to
         * protect and failed immediately. */
        const nudge = fn('checkSweepNudge');
        expect(nudge).toContain("title: 'Idle cash'");
        expect(nudge, 'the in-app banner lost its icon').toContain("WFIcon('trendUp')");

        // and the title line itself carries no glyph of either kind
        const titleLine = (nudge.match(/title: '[^']*'/) || [''])[0];
        expect(titleLine).toBe("title: 'Idle cash'");
        expect(titleLine).not.toContain('WFIcon');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. A RATCHET on everything else
 * ═══════════════════════════════════════════════════════════════════════════*/

/* Measured 2026-08-28. LOWER THIS when emoji are removed; it must never rise.
 * The bulk is index.html (930), then wealthflow-ai-v4.js (156). Note that
 * wealthflow-icons.js's own count is mostly its legacy emoji -> icon-key
 * translation table, which exists precisely to delete emoji from call sites.
 *
 * 1428 -> 1354: the SETTINGS screen. Seventy-four glyphs off one screen, taken
 * off the ceiling rather than left as slack, per the rule above this line.
 * 1354 -> 1311: the SHARE dialog. Forty-three more, same way.
 * 1311 -> 1305: notify()'s icon table. Only six characters, but they were the
 * four glyphs printed on EVERY toast in the app — see test/notify_sink_test.js
 * for the larger reason that function was rewritten.
 *
 * The migration continues screen by screen. renderSettings was the largest
 * single function at 68 and _showShareableUrlDialog the next at 43; after those
 * come handleAIScan (27) and renderDebtDemolisher (25). */
const EMOJI_CEILING = 1305;

describe('the rest of the app can only get less emoji, never more', () => {
    it('is at or below the ceiling', () => {
        const files = ['index.html', 'sw.js']
            .concat(fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f)));
        let total = 0;
        const per = {};
        for (const f of files) {
            let src;
            try { src = read(f); } catch (_) { continue; }
            const n = countIn(src);
            if (n) { per[f] = n; total += n; }
        }
        const worst = Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([f, n]) => `${f}=${n}`).join(' ');
        expect(total, `emoji count rose to ${total} (ceiling ${EMOJI_CEILING}). Worst: ${worst}`)
            .toBeLessThanOrEqual(EMOJI_CEILING);
    });

    it('keeps the ceiling honest by failing if it is set above the real count', () => {
        /* A ceiling far above the measurement is not a ratchet, it is slack —
         * and slack is how the number drifts back up without a single test
         * going red. Kept within 5% of the truth. */
        const files = ['index.html', 'sw.js']
            .concat(fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f)));
        const total = files.reduce((t, f) => {
            try { return t + countIn(read(f)); } catch (_) { return t; }
        }, 0);
        expect(EMOJI_CEILING - total, 'the ceiling has drifted above the measurement — lower it')
            .toBeLessThanOrEqual(Math.ceil(total * 0.05));
    });

    it('the icon set covers what the remaining migration needs', () => {
        // Fifty icons is enough vocabulary that no future screen has an excuse.
        const icons = read('wealthflow-icons.js');
        const names = (icons.match(/^\s{8}[a-zA-Z][a-zA-Z0-9_]*:/gm) || []).length;
        expect(names).toBeGreaterThanOrEqual(45);
        for (const need of ['lock', 'eye', 'x', 'refresh', 'alert', 'checkCircle', 'fileText', 'clock', 'card', 'trendUp']) {
            expect(icons, `icon "${need}" is missing`).toContain(`${need}:`);
        }
    });
});
