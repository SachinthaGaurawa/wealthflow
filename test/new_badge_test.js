/* =============================================================================
 * test/new_badge_test.js — the NEW tag puts itself on a new screen or option and takes itself off after 7 days
 * -----------------------------------------------------------------------------
 * Owner, 2026-11-07: the 7 days are counted from the day the PERSON first sees the thing, not from the day it shipped, so someone who comes back after a month still gets the full week; the first sighting is kept on the account so every device agrees.
 * Owner, 2026-10-21: the AI Advisor wore a NEW tag that had been put there by hand and never came off. A NEW tag must come from the date a thing shipped (or from the first time a screen is seen), and end
 * after exactly 7 days with nobody editing anything. The page side (the pill in the sidebar and in the More sheet, expiry on a page that stays open) is driven in a real browser by test/e2e/new-badge.mjs.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { DAYS, BASELINE, SINCE, parseDay, daysLeft, fresh, newScreens, mergeSeen, sameSeen, canBeNew, dayStart, scan } from '../wealthflow-new-badge.js';

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

// ── counted from the first sighting (owner, 2026-11-07) ──────────────────────
describe('the first sighting is kept, and the earliest one wins', () => {
    it('merges two maps with the earliest stamp per key and drops anything that is not a time', () => {
        expect(mergeSeen({ a: 5, b: 9, c: 'x', d: -1 }, { a: 3, b: 11, e: 7, f: NaN })).toEqual({ a: 3, b: 9, e: 7 });
        expect(mergeSeen(null, undefined)).toEqual({});
    });
    it('is the same map when nothing differs, whatever the order of the keys', () => {
        expect(sameSeen({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
        expect(sameSeen({ a: 1 }, { a: 2 })).toBe(false);
        expect(sameSeen({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });
    it('can only be new when it shipped on the day the account began, or later', () => {
        const began = Date.UTC(2026, 10, 7, 15, 30);
        expect(canBeNew(parseDay('2026-11-07'), began)).toBe(true);
        expect(canBeNew(parseDay('2026-11-20'), began)).toBe(true);
        expect(canBeNew(parseDay('2026-11-06'), began)).toBe(false);      // part of the app the person started with
        expect(canBeNew(NaN, began)).toBe(false);
        expect(canBeNew(parseDay('2026-11-07'), NaN)).toBe(false);         // a label that cannot be justified is not shown
        expect(dayStart(began)).toBe(Date.UTC(2026, 10, 7));
    });
});

describe('scan: 7 days from when the person first sees it', () => {
    const NOW = Date.UTC(2026, 11, 20, 9, 0);          // the person comes back on 20 Dec
    function page({ shown = true, day = '2026-12-01', extra = '' } = {}) {
        const { document, window } = parseHTML('<html><body><div id="app" class="show"></div><div class="opt" data-wf-new="' + day + '"' + extra + '>Weekly digest</div></body></html>');
        const el = document.querySelector('.opt');
        Object.defineProperty(el, 'offsetWidth', { get: () => (shown ? 120 : 0), configurable: true });
        window._isDecoyMode = false;                         // parseHTML windows share their prototype chain; start every page clean
        const store = {};
        window.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
        const cloud = {};
        window.DB = { getObj: (k, d) => (cloud[k] !== undefined ? JSON.parse(JSON.stringify(cloud[k])) : d), set: (k, v) => { cloud[k] = JSON.parse(JSON.stringify(v)); } };
        return { document, window, el, store, cloud };
    }
    const KEY = 'f:2026-12-01-weekly-digest';
    const left = (p) => { const x = p.el.querySelector('.wf-new'); return x ? x.getAttribute('data-left') : null; };
    const beganOn = (p, ms) => { p.window.localStorage.setItem('wf_new_seen_v1', JSON.stringify({ [SINCE]: ms })); };

    it('gives a person who was away for weeks the full 7 days when they first see a feature that shipped weeks ago', () => {
        const p = page({ day: '2026-12-01' });
        beganOn(p, Date.UTC(2026, 9, 1));                 // began in October
        scan(p.document, p.window, NOW);
        expect(left(p)).toBe('7');                         // shipped 19 days ago, first seen today
        scan(p.document, p.window, NOW + 2 * DAY);
        expect(left(p)).toBe('5');
        scan(p.document, p.window, NOW + 7 * DAY);
        expect(left(p)).toBeNull();                        // and it does not come back
        scan(p.document, p.window, NOW + 30 * DAY);
        expect(left(p)).toBeNull();
    });
    it('does not start the week for something that has not been on screen', () => {
        const p = page({ shown: false });
        beganOn(p, Date.UTC(2026, 9, 1));
        scan(p.document, p.window, NOW);
        expect(left(p)).toBeNull();
        expect(Object.keys(JSON.parse(p.store.wf_new_seen_v1)).filter((k) => k.startsWith('f:'))).toEqual([]);
        Object.defineProperty(p.el, 'offsetWidth', { get: () => 120, configurable: true });   // opened later
        scan(p.document, p.window, NOW + 3 * DAY);
        expect(left(p)).toBe('7');
    });
    it('does not call something new that shipped before the person began', () => {
        const p = page({ day: '2026-09-15' });
        beganOn(p, Date.UTC(2026, 9, 1));
        scan(p.document, p.window, NOW);
        expect(left(p)).toBeNull();
    });
    it('does not cover a fresh install in labels: the first run only notes the day it began', () => {
        const p = page({ day: '2026-12-01' });
        scan(p.document, p.window, NOW);                   // no earlier stamp anywhere
        expect(left(p)).toBeNull();
        expect(JSON.parse(p.store.wf_new_seen_v1)[SINCE]).toBe(NOW);
        const q = page({ day: '2026-12-20' });             // shipped the same day the account began
        scan(q.document, q.window, NOW);
        expect(left(q)).toBe('7');
    });
    it('keeps the first sighting on the account, and another device counts from it, not from its own first look', () => {
        const phone = page();
        beganOn(phone, Date.UTC(2026, 9, 1));
        scan(phone.document, phone.window, NOW);
        expect(Object.keys(phone.cloud.newSeen).sort()).toEqual([KEY, SINCE].sort());
        expect(phone.cloud.newSeen[KEY]).toBe(NOW);
        const laptop = page();                             // a different browser, same account
        laptop.cloud.newSeen = JSON.parse(JSON.stringify(phone.cloud.newSeen));
        scan(laptop.document, laptop.window, NOW + 4 * DAY);
        expect(left(laptop)).toBe('3');                    // 7 - 4, not a fresh 7
        expect(JSON.parse(laptop.store.wf_new_seen_v1)[KEY]).toBe(NOW);
    });
    it('takes the earlier of the device and the account, and writes the earlier one back', () => {
        const p = page();
        beganOn(p, Date.UTC(2026, 9, 1));
        p.window.localStorage.setItem('wf_new_seen_v1', JSON.stringify({ [SINCE]: Date.UTC(2026, 9, 1), [KEY]: NOW - 5 * DAY }));
        p.cloud.newSeen = { [SINCE]: Date.UTC(2026, 9, 1), [KEY]: NOW - DAY };
        scan(p.document, p.window, NOW);
        expect(left(p)).toBe('2');
        expect(p.cloud.newSeen[KEY]).toBe(NOW - 5 * DAY);
    });
    it('writes nothing to the account when nothing changed, when signed out, or in the decoy books', () => {
        const p = page();
        beganOn(p, Date.UTC(2026, 9, 1));
        scan(p.document, p.window, NOW);
        let writes = 0; const set = p.window.DB.set; p.window.DB.set = (k, v) => { writes++; set(k, v); };
        scan(p.document, p.window, NOW + 1000);
        expect(writes).toBe(0);
        const out = page(); beganOn(out, Date.UTC(2026, 9, 1)); out.document.getElementById('app').className = '';
        scan(out.document, out.window, NOW);
        expect(out.cloud.newSeen).toBeUndefined();
        expect(left(out)).toBe('7');                       // still labelled on this device
        const decoy = page(); beganOn(decoy, Date.UTC(2026, 9, 1)); decoy.window._isDecoyMode = true;
        scan(decoy.document, decoy.window, NOW);
        expect(decoy.cloud.newSeen).toBeUndefined();
    });
    it('names a thing without an id by its date and words, with only letters, digits and dashes (safe as a field name)', () => {
        const p = page({ extra: ' data-wf-new-id="Weekly Digest ~ v2!"' });
        beganOn(p, Date.UTC(2026, 9, 1));
        scan(p.document, p.window, NOW);
        expect(Object.keys(p.cloud.newSeen)).toContain('f:weekly-digest-v2');
        expect(Object.keys(p.cloud.newSeen).every((k) => /^[A-Za-z0-9:_-]+$/.test(k))).toBe(true);
    });
    it('declares the account field, so the app reads it back after a refresh', () => {
        expect(read('index.html')).toMatch(/^\s+newSeen: \{\},/m);
    });
});
