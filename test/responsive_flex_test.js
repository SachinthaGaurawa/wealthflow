// =============================================================================
// test/responsive_flex_test.js — guardrail for the flex-overflow fixes.
//
// A flex row that pairs a flexible title/text block with `white-space: nowrap`
// buttons cannot shrink: the buttons hold their full width, the text block is
// crushed to a couple of characters per line, and the last button is pushed
// past the screen edge (then clipped by `body { overflow-x: hidden }`). The
// three fixes below pin the invariants that stop that from returning:
//
//   1. header rows must wrap,
//   2. the title/text block must be allowed to shrink (`min-width: 0`),
//   3. long unbroken strings must break instead of forcing the row wide.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

function rule(selector) {
    /* The BASE rule for this selector, not the first rule that happens to
     * MENTION it.
     *
     * The old version matched anywhere, so `body.wf-compact .setting-row {…}`
     * — a density override added later — was returned as if it were
     * `.setting-row`, and a guard about wrapping failed over a rule that says
     * nothing about wrapping. A test that reads the wrong rule is a test that
     * reports the wrong file as broken.
     *
     * "Base" means the selector stands alone in its selector list: at the start
     * of the block, or straight after a comma or a newline. */
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = html.match(new RegExp('(?:^|[,{}\\n])\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm'));
    return m ? m[1] : '';
}

describe('responsive: header/text rows wrap instead of crushing', () => {
    it('.card-hdr-row wraps so action buttons drop to their own line', () => {
        expect(rule('.card-hdr-row')).toContain('flex-wrap: wrap');
    });

    it('.card-hdr-row .card-hdr-main is allowed to shrink', () => {
        expect(rule('.card-hdr-row > .card-hdr-main')).toContain('min-width: 0');
    });

    it('.md-hdr wraps so modal titles are not squeezed by action buttons', () => {
        expect(rule('.md-hdr')).toContain('flex-wrap: wrap');
    });

    it('.md-title can shrink and break long unbroken names', () => {
        const body = rule('.md-title');
        expect(body).toContain('min-width: 0');
        expect(body).toContain('overflow-wrap');
    });

    it('.setting-row wraps so labels are not crushed by controls', () => {
        expect(rule('.setting-row')).toContain('flex-wrap: wrap');
    });

    it('.setting-info is allowed to shrink below its longest word', () => {
        expect(rule('.setting-info')).toContain('min-width: 0');
    });
});

/* =============================================================================
 * openSenderList() — the "Statement senders" modal's add-a-sender row used
 * `class="inp"` on both inputs, a class with NO base styling anywhere in this
 * file (no width, no background, no border — only an unrelated mobile-only
 * min-height rule). Both inputs rendered as bare, unstyled native <input>
 * elements at their tiny browser-default width instead of filling their flex
 * item, so the row's real content width (two undersized inputs still taking
 * their default box model) overflowed the modal and pushed the "+ Add"
 * button past the card's right edge on anything but a very narrow phone —
 * visually worse, not better, on a wider screen. `.fi` is the class every
 * other themed input in this file actually uses.
 * ===========================================================================*/
describe('the Statement senders modal inputs are actually styled', () => {
    it('never uses the unstyled "inp" class on any input', () => {
        // Guards against this exact mistake recurring anywhere in the file,
        // not just the two spots that prompted it.
        expect(html).not.toMatch(/class="inp"/);
    });

    it('_sl_addr and _sl_name use .fi, the real styled input class', () => {
        expect(html).toMatch(/id="_sl_addr" class="fi"/);
        expect(html).toMatch(/id="_sl_name" class="fi"/);
    });

    it('.fi actually has width/background/border — proof the class carries real styling', () => {
        // .fi is declared as part of a `.fi, .fs, .fta { ... }` multi-selector
        // rule, so the single-selector rule() helper above (which requires the
        // selector to sit right before the `{`) does not apply here.
        const m = html.match(/\.fi,\s*\.fs,\s*\.fta\s*\{([^}]*)\}/);
        const body = m ? m[1] : '';
        expect(body).toContain('width: 100%');
        expect(body).toContain('background');
        expect(body).toContain('border');
    });

    it('neither field is pinned to a rigid pixel width that cannot shrink on a narrow phone', () => {
        // A fixed `width:140px` on the name field, alongside a `min-width:170px`
        // email field, left no room to wrap gracefully below ~350px; both are
        // now a flex-basis so they can shrink before wrapping onto their own line.
        expect(html).toMatch(/flex:1 1 110px;min-width:110px;/);
        expect(html).toMatch(/flex:2 1 170px;min-width:170px;/);
    });

    it('the Add button never shrinks and drops out of the row before its text does', () => {
        const btnLine = html.match(/id="_sl_add" style="([^"]*)"/);
        expect(btnLine && btnLine[1]).toContain('flex-shrink:0');
    });
});
