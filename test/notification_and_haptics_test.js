/* =============================================================================
 * test/notification_and_haptics_test.js
 * -----------------------------------------------------------------------------
 * Two defects that had been shipping for a long time, both invisible in a unit
 * test because in both cases each individual function was correct.
 *
 * 1. TWO NOTIFICATIONS FOR ONE EVENT
 *
 *    showActionableBanner called sendSmartNotification() AND
 *    _showOSNotification() unconditionally. Both reach
 *    registration.showNotification, and their tags never collapse —
 *    'wealthflow-ai-<timestamp>' against 'wf-actionable-<id>' — so one income
 *    reminder put two entries on the lock screen, one of them buttonless. Every
 *    actionable banner in the app has done this since the actionable path was
 *    added, which is why it never looked like a regression.
 *
 * 2. INTENSITY APPLIED TWICE
 *
 *    _vibrate() has scaled patterns by _getHapticMultiplier() for a long time.
 *    The first version of the new four-level engine scaled AGAIN inside
 *    triggerHaptic, so "heavy" would have been 1.7 x 1.5 = 2.55x. Nobody could
 *    have felt that precisely enough to report it, and the tests would all have
 *    passed. It is pinned here because the only defence is one choke point.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');

/* Sliced to the NEXT top-level function, not by counting braces.
 *
 * Brace counting looks obvious and is wrong here. Both functions this file
 * cares about take a DESTRUCTURED parameter — `showActionableBanner({ id,
 * title, … })` — so the first `{` after the name belongs to the parameter list
 * and closes at the end of it. The extractor returned 178 characters of a
 * 5,200-character function and every assertion below failed against a body it
 * had never seen. A boundary is not fooled by either braces or template
 * literals. */
function fn(name) {
    const decl = new RegExp(`^[ \\t]*(?:async )?function ${name}\\s*\\(`, 'm');
    const m = decl.exec(html);
    if (!m) return '';
    const from = m.index;
    const after = html.slice(from + m[0].length);
    const next = after.search(/^ {8}(?:async )?function \w+\s*\(/m);
    return next < 0 ? html.slice(from) : html.slice(from, from + m[0].length + next);
}

const code = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE EVENT, ONE NOTIFICATION
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a single event reaches the device once', () => {
    const banner = fn('showActionableBanner');

    it('found the function', () => expect(banner).toBeTruthy());

    it('the plain mirror is a fallback, not a second send', () => {
        /* THE FIX. It must be reachable only through the "did the actionable one
         * show?" answer — never called straight through as it was. */
        expect(banner).toContain('const _plainMirror = ()');
        expect(banner).toContain('.then((shown) => { if (!shown) _plainMirror(); })');
    });

    it('never calls sendSmartNotification unconditionally again', () => {
        const c = code(banner);
        const direct = c.split('\n').filter((l) => /sendSmartNotification\(/.test(l));
        // The only call lives inside _plainMirror.
        expect(direct.length, 'more than one sendSmartNotification call site').toBe(1);
        const at = c.indexOf('sendSmartNotification(');
        const mirrorAt = c.indexOf('const _plainMirror');
        const gateAt = c.indexOf('_showOSNotification(');
        expect(mirrorAt).toBeGreaterThan(0);
        expect(at, 'the mirror call escaped the fallback').toBeGreaterThan(mirrorAt);
        expect(at, 'the mirror still runs before the actionable attempt').toBeLessThan(gateAt);
    });

    it('still falls back when the actionable notification is refused', () => {
        // Losing the fallback would be a regression the other direction: on a
        // browser with no service worker the owner would get nothing at all.
        expect(banner).toContain('.catch(() => _plainMirror());');
    });

    it('_showOSNotification reports whether it actually showed', () => {
        /* Asking the four preconditions again in the caller is how the two paths
         * would drift back into sending two notifications. */
        const os = fn('_showOSNotification');
        expect(os).toContain("if (!('Notification' in window)) return false;");
        expect(os).toContain("if (Notification.permission !== 'granted') return false;");
        expect(os).toContain("if (!('serviceWorker' in navigator)) return false;");
        expect(os).toContain('if (!reg) return false;');
        expect(os, 'the success path does not report success').toContain('return true;');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * INTENSITY
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('haptic intensity has four levels and one scaling point', () => {
    it('offers exactly Off, Subtle, Standard, Heavy', () => {
        expect(html).toContain("const HAPTIC_LEVELS = ['off', 'subtle', 'standard', 'heavy'];");
        for (const label of ['>Off<', '>Subtle<', '>Standard<', '>Heavy<']) {
            expect(html, `the ${label} option is missing from settings`).toContain(label);
        }
    });

    it('SCALES IN ONE PLACE, and that place is _vibrate', () => {
        /* The bug this pins: the first version scaled inside triggerHaptic too,
         * on top of the multiplier _vibrate had already applied for months. */
        const t = code(fn('triggerHaptic'));
        expect(t, 'triggerHaptic scales the pattern itself again').not.toContain('_hapticScale');
        expect(t).toContain('const buzz = (p) => _vibrate(p);');
        expect(code(fn('_vibrate'))).toContain('_getHapticMultiplier()');
    });

    it('handles off in triggerHaptic, where the silent channels are', () => {
        /* A zero multiplier would still leave the iOS Taptic trick and the
         * visual ripple firing — neither goes through _vibrate. */
        const t = fn('triggerHaptic');
        expect(t).toContain("if (hapticIntensity() === 'off') return;");
        const offAt = t.indexOf("=== 'off'");
        expect(t.indexOf('_iosHaptic'), 'off is decided after the iOS channel runs').toBeGreaterThan(offAt);
        expect(t.indexOf('_visualHaptic'), 'off is decided after the ripple runs').toBeGreaterThan(offAt);
    });

    it('keeps working for installs holding the older names', () => {
        // The setting already existed as gentle/standard/intense. Resetting
        // those on update would silently change how the app feels.
        expect(html).toContain("const HAPTIC_ALIASES = { gentle: 'subtle', intense: 'heavy'");
    });

    it('the legacy on/off switch still wins', () => {
        expect(fn('hapticIntensity')).toContain("if (st.haptics === false) return 'off';");
    });

    it('the settings dropdown shows the level actually in force', () => {
        /* Comparing against the RAW stored value would leave an install holding
         * "gentle" showing nothing selected, because no option has that value
         * any more. */
        expect(html).toContain("<option value=\"subtle\" ${hapticIntensity() === 'subtle' ? 'selected' : ''}>");
        expect(html).not.toContain("(s.hapticIntensity || 'standard') === 'gentle'");
    });

    it('gives every level a gain, and only off is silent', () => {
        expect(html).toContain("const HAPTIC_GAIN = { off: 0, subtle: 0.5, standard: 1, heavy: 1.6 };");
    });
});
