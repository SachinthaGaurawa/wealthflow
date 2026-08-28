/* =============================================================================
 * test/ai_chat_icons_test.js
 * -----------------------------------------------------------------------------
 * The AI chat message, migrated from emoji to icons. This screen has the
 * awkward shape the others did not:
 *
 *   1. SOME OF ITS GLYPHS ARE PATTERNS, NOT OUTPUT.
 *
 *      appendAIMessage turns the model's own markdown-ish output into callouts:
 *
 *          f.replace(/(^|\n)⚠️\s*(.+)/g, '…<span class="ai-callout-icon">…')
 *                          ^^                        ^^
 *                    what the MODEL wrote      what the READER sees
 *
 *      Only the second is ours to change. Strip the glyph from the match side
 *      and the callouts simply stop appearing — a silent loss of formatting on
 *      every AI answer, with the emoji count going down as if it had gone well.
 *      So this screen does NOT reach zero, and that is correct. What it must
 *      reach is: every remaining glyph is on a pattern.
 *
 *   2. ITS BUTTON LABELS ARE SWAPPED BY THEIR OWN HANDLERS.
 *
 *      "Copy" becomes "Copied", "Read" becomes "Stop". The handlers assigned
 *      `btn.textContent`, which replaces every child — so an icon put in that
 *      button would survive exactly until the first click. The label moved into
 *      its own span and the handlers now change only that.
 *
 *   3. TWO SINKS, AS EVER. The avatar and the Edit button are textContent, so
 *      they take NODES; everything else is innerHTML and takes _ic().
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ICONS = fs.readFileSync(path.join(ROOT, 'wealthflow-icons.js'), 'utf8');

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

const APPEND = fn('appendAIMessage');
const ALOUD = fn('_readAIAloud');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;

describe('the AI chat message', () => {
    it('was found', () => {
        expect(APPEND, 'appendAIMessage is gone').toBeTruthy();
        expect(ALOUD, '_readAIAloud is gone').toBeTruthy();
        expect(APPEND.length).toBeGreaterThan(4000);
    });

    /* ── the patterns must survive ─────────────────────────────────────────*/
    it('still RECOGNISES the glyphs the model writes', () => {
        /* The load-bearing assertion of this file. These three characters are
         * input, not output. A migration that "cleaned" them would delete the
         * callout feature outright and look like progress on the count. */
        for (const [glyph, kind] of [['⚠️', 'warning'], ['✅', 'success'], ['\u{1F4A1}', 'info']]) {
            const line = APPEND.split('\n').find((l) => l.includes(`ai-callout ${kind}`));
            expect(line, `the ${kind} callout is gone`).toBeTruthy();
            expect(line, `the ${kind} callout stopped matching what the model writes`)
                .toContain(glyph);
        }
    });

    it('every glyph left in the function is on a pattern, never on output', () => {
        const offenders = [];
        APPEND.split('\n').forEach((l, i) => {
            if (!EMOJI.test(l)) return;
            EMOJI.lastIndex = 0;
            const isReplace = /f = f\.replace\(\//.test(l);
            // the pattern half is everything before the regex's closing `/g,`
            const patternHalf = isReplace ? l.slice(0, l.indexOf('/g,')) : '';
            const outputHalf = isReplace ? l.slice(l.indexOf('/g,')) : l;
            const stray = outputHalf.match(EMOJI) || [];
            if (!isReplace || stray.length) offenders.push(`line +${i}: ${l.trim().slice(0, 90)}`);
            expect(patternHalf.length, 'unreachable — kept so the variable is used').toBeGreaterThanOrEqual(0);
        });
        expect(offenders, `emoji on the OUTPUT side:\n${offenders.join('\n')}`).toEqual([]);
    });

    /* ── the two textContent sinks take nodes ──────────────────────────────*/
    it('the avatar is an icon NODE, because it is written with textContent', () => {
        const av = APPEND.slice(APPEND.indexOf('ai-avatar'), APPEND.indexOf('ai-bubble '));
        expect(av, 'the avatar lost its icon').toContain('WFIconNode');
        expect(av).toContain("'user' : 'bot'");
        expect(av, 'a WFIcon STRING in a textContent sink renders as literal markup')
            .not.toMatch(/textContent\s*=\s*[^;]*WFIcon\(/);
    });

    it('the Edit button is an icon NODE for the same reason', () => {
        const seg = APPEND.slice(APPEND.indexOf('editBtn.className'), APPEND.indexOf('editBtn.onclick'));
        expect(seg).toContain("WFIconNode('edit')");
        expect(seg).toContain("' Edit'");
    });

    /* ── the buttons whose labels move ─────────────────────────────────────*/
    it('Copy and Read carry an icon beside a label their handlers can swap', () => {
        for (const [icon, label] of [['copy', 'Copy'], ['volume', 'Read']]) {
            expect(APPEND, `the ${label} button lost its ${icon} icon`).toContain(`data-wfi="${icon}"`);
            expect(APPEND, `the ${label} button has no swappable label`)
                .toContain(`<span class="ai-btn-label">${label}</span>`);
        }
    });

    it('no handler overwrites a button that contains an icon', () => {
        /* btn.textContent = '…' replaces every child, icon included. Every one
         * of these went through _aiBtnLabel instead. */
        expect(ALOUD, '_readAIAloud still wipes the button').not.toMatch(/btn\.textContent\s*=/);
        expect(fn('_aiCopyAnswer'), 'the copy handler still wipes the button')
            .not.toMatch(/btn\.textContent\s*=/);
        expect(fn('_aiBtnLabel'), 'the label helper is missing').toBeTruthy();
    });

    it('the copy handler is a function, not a quoted IIFE in an attribute', () => {
        expect(APPEND).toContain('onclick="_aiCopyAnswer(this)"');
        expect(APPEND, 'the inline clipboard IIFE is back').not.toContain('navigator.clipboard.writeText(b.getAttribute');
        expect(fn('_aiCopyAnswer'), 'the extracted handler still copies').toContain('clipboard');
    });

    it('_readAIAloud carries no glyph at all', () => {
        const found = ALOUD.match(EMOJI) || [];
        expect(found, `emoji in _readAIAloud: ${found.join(' ')}`).toEqual([]);
    });

    /* ── the provider label ────────────────────────────────────────────────*/
    it('names every provider, with one mark for all of them', () => {
        /* Deliberate: the vendor's NAME is the text beside the icon, so a
         * different glyph per vendor distinguished nothing the words did not.
         * Asserted rather than left implicit, so the choice is visible. */
        for (const name of ['Gemini', 'Groq', 'DeepSeek']) {
            expect(APPEND, `the ${name} label is gone`).toContain(`'${name}'`);
        }
        expect(APPEND).toContain("_ic('bot')");
        expect(APPEND, 'the unknown-provider fallback is gone').toContain("|| 'AI'");
    });

    /* ── icons exist ───────────────────────────────────────────────────────*/
    it('every icon this screen names is in the icon set', () => {
        for (const n of ['user', 'bot', 'alert', 'checkCircle', 'info', 'target', 'copy', 'volume', 'edit', 'thumbsUp', 'thumbsDown']) {
            expect(ICONS, `icon "${n}" is missing`).toContain(`${n}:`);
        }
    });

    it('the volume icon added for Read is a real shape, not an empty entry', () => {
        const m = ICONS.match(/volume:'([^']*)'/);
        expect(m, 'volume: is not defined').toBeTruthy();
        expect(m[1].length, 'volume: is an empty icon').toBeGreaterThan(40);
        expect(m[1]).toContain('<path');
    });

    it('is not overridden by a sibling file', () => {
        for (const f of fs.readdirSync(ROOT).filter((x) => /^wealthflow-.*\.js$/.test(x))) {
            expect(fs.readFileSync(path.join(ROOT, f), 'utf8'),
                `${f} replaces appendAIMessage — migrate the replacement instead`)
                .not.toMatch(/window\.appendAIMessage\s*=\s*[A-Za-z_$]/);
        }
    });
});
