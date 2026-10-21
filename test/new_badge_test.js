/* =============================================================================
 * test/new_badge_test.js — the NEW tag puts itself on a new screen or option and takes itself off after 7 days
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-21: the AI Advisor wore a NEW tag that had been put there by hand and never came off. A NEW tag must come from the date a thing shipped (or from the first time a screen is seen), and end
 * after exactly 7 days with nobody editing anything. The page side (the pill in the sidebar and in the More sheet, expiry on a page that stays open) is driven in a real browser by test/e2e/new-badge.mjs.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DAYS, BASELINE, parseDay, daysLeft, fresh, newScreens } from '../wealthflow-new-badge.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const DAY = 86400000;
const shipped = parseDay('2026-10-21');

describe('the 7 days', () => {
    it('is exactly 7', () => expect(DAYS).toBe(7));
    it('counts down from 7 on the day it shipped to 1 on the last day, then it is over', () => {
        const left = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((d) => daysLeft(shipped, shipped + d * DAY + 3600000));
        expect(left).toEqual([7, 6, 5, 4, 3, 2, 1, 0, 0]);
    });
    it('is over at the seven day mark, to the millisecond', () => {
        expect(fresh(shipped, shipped + 7 * DAY - 1)).toBe(true);
        expect(fresh(shipped, shipped + 7 * DAY)).toBe(false);
    });
    it('does not come back: a month later it is still over', () => expect(daysLeft(shipped, shipped + 30 * DAY)).toBe(0));
    it('shows from a day early, so a date written in one time zone is not hidden in another', () => {
        expect(fresh(shipped, shipped - DAY / 2)).toBe(true);
        expect(fresh(shipped, shipped - 2 * DAY)).toBe(false);
    });
    it('never shows for a start that is not a time', () => {
        expect(daysLeft(NaN, shipped)).toBe(0);
        expect(daysLeft(shipped, NaN)).toBe(0);
        expect(daysLeft(undefined, shipped)).toBe(0);
    });
});

describe('parseDay', () => {
    it('reads a calendar day as UTC midnight', () => expect(parseDay('2026-10-21')).toBe(Date.UTC(2026, 9, 21)));
    it('refuses anything that is not a real day', () => {
        for (const bad of ['', null, undefined, '2026-13-01', '2026-02-30', '21/10/2026', '2026-1-1', 'tomorrow', '2026-10-21T00:00:00Z']) expect(parseDay(bad)).toBeNaN();
    });
});

describe('a screen that is new', () => {
    it('is any sidebar screen that is not in BASELINE, with no list to edit', () => {
        expect(newScreens(["showPage('dashboard',this)", "showPage('zakat',this)", "showPage('ai',this)", "showPage('goals2',this)"])).toEqual(['zakat', 'goals2']);
    });
    it('is named once however often it appears, and sign-out or an empty onclick is not a screen', () => {
        expect(newScreens(["showPage('zakat',this)", "showPage('zakat',this)", 'signOutGoogle()', '', null])).toEqual(['zakat']);
    });
    it('knows every screen the sidebar has today (so nothing existing is called new on first load)', () => {
        const html = read('index.html');
        const nav = html.slice(html.indexOf('class="sb-nav"'), html.indexOf('class="sb-footer"'));
        const ids = [...nav.matchAll(/showPage\('([^']+)'/g)].map((m) => m[1]);
        expect(ids.length).toBeGreaterThan(15);
        expect(ids.filter((id) => !BASELINE.includes(id))).toEqual([]);
    });
});

describe('the page', () => {
    const html = read('index.html');
    it('no longer puts a NEW tag on the AI Advisor by hand', () => {
        expect(html).not.toMatch(/textContent\s*=\s*'NEW'/);
        expect(html).not.toMatch(/id="nb-ai"[^>]*>\s*NEW\s*</);
    });
    it('loads the module, deferred (a module script is deferred), and the More sheet knows the tag', () => {
        expect(html).toContain('<script type="module" src="wealthflow-new-badge.js"></script>');
        const shell = read('wealthflow-shell.js');
        expect(shell).toContain("isNew: !!el.querySelector('.wf-new')");
        expect(shell).toContain('wf-badge-new');
        expect(shell).toContain(".nav-icon, .nb, .wf-new");
    });
    it('styles the tag in one place, with tokens only, and does not animate it forever', () => {
        const css = read('wf-ui.css');
        const at = css.indexOf('30. NEW TAG');
        expect(at).toBeGreaterThan(0);
        const body = css.slice(at);
        expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(body).not.toMatch(/infinite/);
        expect(body).toMatch(/prefers-reduced-motion: reduce\) \{ \.wf-new \{ animation: none/);
    });
    it('does not count as needing attention: the More dot reads badge, never the NEW tag', () => {
        const shell = read('wealthflow-shell.js');
        expect(shell).toMatch(/return p\.badge && !MAIN_TABS/);
    });
});
