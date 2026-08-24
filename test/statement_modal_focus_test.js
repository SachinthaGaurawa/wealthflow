/* =============================================================================
 * test/statement_modal_focus_test.js — the Unlock e-statement prompt must be
 * tappable, not merely visible
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * promptPassword() built its overlay as:
 *
 *     ov.className = 'mo';
 *     ov.style.cssText = '…;opacity:0;transition:opacity .2s;';
 *     requestAnimationFrame(function () { ov.style.opacity = '1'; });
 *
 * index.html styles `.mo` with `pointer-events:none`, and restores it only on
 * `.mo.open`. This overlay fades ITSELF in with an inline opacity and never adds
 * `.open`, so the inline opacity won (the modal looked perfect) while
 * pointer-events:none was never overridden (the modal was inert). On an iPhone
 * the DOB field could not be focused, the keyboard never opened, and Cancel and
 * Unlock did nothing — with no error anywhere, because nothing had failed.
 *
 * A modal that renders correctly and accepts no input is the same defect family
 * as the rest of this suite: the visible surface and the actual behaviour
 * disagreed, and only the invisible half was true.
 *
 * WHY THE CLASS IS GONE RATHER THAN `.open` ADDED
 *
 * Adding `.open` would trade one bug for another: index.html's Escape handler
 * does `querySelectorAll('.mo.open').forEach(m => m.classList.remove('open'))`,
 * which would make the overlay inert again WITHOUT removing it or resolving its
 * promise — an unclosable dead modal. Another handler removes every `.mo`
 * outright. This overlay styles itself entirely inline, so the class only ever
 * contributed the bug and the exposure to those two handlers.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MOD = fs.readFileSync(path.join(ROOT, 'wealthflow-html-statement.js'), 'utf8');
/* Comment-stripped view. The markup below is built by string concatenation with
 * explanatory /*…*\/ comments spliced BETWEEN the fragments, so a regex run over
 * the raw file sees the prose rather than the attribute it is looking for. */
const CODE = MOD.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The overlay construction block inside promptPassword(). */
function overlayBlock() {
    const i = MOD.indexOf('function promptPassword');
    expect(i, 'promptPassword() is gone — retarget this test').toBeGreaterThan(-1);
    const block = MOD.slice(i, MOD.indexOf('document.body.appendChild(ov)', i));
    expect(block.length).toBeGreaterThan(200);
    return block;
}

/** JUST the overlay's own cssText literal.
 *
 *  overlayBlock() spans the input markup as well, and the input also declares
 *  pointer-events — so asserting against the whole block passed even with the
 *  overlay's own pointer-events deleted. Caught by mutation-testing this file:
 *  the guard was reading the wrong bytes and reporting confidently on them,
 *  which is the exact defect class this suite exists to catch. */
function overlayCss() {
    const m = MOD.match(/ov\.style\.cssText\s*=\s*'([^']+)'/);
    expect(m, "the overlay's cssText assignment is gone — retarget this test").toBeTruthy();
    return m[1];
}

/** The inline style= attribute of the DOB input. */
function inputStyle() {
    const m = CODE.match(/id="_wfhsPw"[\s\S]*?style="([^"]+)"/);
    expect(m, 'the #_wfhsPw input or its inline style is gone — retarget this test').toBeTruthy();
    return m[1];
}

describe('the hazard in the host stylesheet is real (guards the guard)', () => {
    // If this ever stops being true the assertions below are guarding nothing.
    it('.mo disables pointer events and only .mo.open restores them', () => {
        const mo = HTML.match(/\.mo\s*\{([^}]*)\}/);
        expect(mo, '.mo rule not found in index.html').toBeTruthy();
        expect(mo[1].replace(/\s/g, ''),
            '.mo no longer sets pointer-events:none — the trap this test exists for is gone')
            .toContain('pointer-events:none');

        const open = HTML.match(/\.mo\.open\s*\{([^}]*)\}/);
        expect(open, '.mo.open rule not found').toBeTruthy();
        expect(open[1].replace(/\s/g, '')).toMatch(/pointer-events:(all|auto)/);
    });

    it('the host really does strip .open on Escape, which is why .open is not used', () => {
        expect(HTML.replace(/\s+/g, ' '),
            "index.html no longer strips .open — re-evaluate whether the overlay could "
            + 'simply use the .mo.open class after all')
            .toMatch(/querySelectorAll\('\.mo\.open'\)[^;]*classList\.remove\('open'\)/);
    });
});

describe('the Unlock e-statement overlay can receive touches', () => {
    it('does NOT take the .mo class, whose pointer-events:none it never overrode', () => {
        expect(overlayBlock(), "the overlay is back on the host's .mo class, which makes it "
            + 'inert unless .open is also added').not.toMatch(/className\s*=\s*['"]mo['"]/);
    });

    it('states pointer-events explicitly on the overlay', () => {
        expect(overlayCss(), 'the overlay does not set pointer-events, so .mo (or any '
            + 'ancestor rule setting none) makes the whole prompt untappable')
            .toMatch(/pointer-events:\s*auto/);
    });

    it('states pointer-events and text selection on the DOB input itself', () => {
        const s = inputStyle().replace(/\s/g, '');
        expect(s, 'the input does not set pointer-events').toContain('pointer-events:auto');
        expect(s, 'an inherited user-select:none can stop the caret appearing on iOS')
            .toContain('user-select:text');
        expect(s, 'the webkit-prefixed form is required on iOS Safari')
            .toContain('-webkit-user-select:text');
    });

    it('keeps the font at 16px or larger, or iOS zooms the page on focus', () => {
        const m = inputStyle().match(/font-size:\s*(\d+)px/);
        expect(m, 'the input has no explicit font-size').toBeTruthy();
        expect(Number(m[1])).toBeGreaterThanOrEqual(16);
    });

    it('is not readonly or disabled — the other two ways to make a field dead', () => {
        const decl = CODE.match(/<input id="_wfhsPw"[^>]*>/);
        expect(decl).toBeTruthy();
        expect(decl[0]).not.toMatch(/\breadonly\b/i);
        expect(decl[0]).not.toMatch(/\bdisabled\b/i);
    });

    it('still accepts a numeric keypad and 8 digits', () => {
        const decl = CODE.match(/<input id="_wfhsPw"[^>]*>/)[0];
        expect(decl).toMatch(/inputmode="numeric"/);
        expect(decl).toMatch(/maxlength="8"/);
    });
});

describe('the overlay is still reachable to its own code', () => {
    it('is findable without the class it no longer carries', () => {
        // _setError / the retry path reach it through window.__wfhsActiveOverlay,
        // not a selector, so dropping the class cannot orphan them.
        expect(MOD).toMatch(/window\.__wfhsActiveOverlay\s*=\s*ov/);
        expect(MOD).toMatch(/ov\._setError\s*=/);
    });

    it('carries a stable hook for anything that must find it by selector', () => {
        expect(overlayBlock()).toMatch(/data-wfhs-modal/);
    });
});
