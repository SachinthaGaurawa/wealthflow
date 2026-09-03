// =============================================================================
// WealthFlow Shadow Test Harness — what day is it HERE
// =============================================================================
// THE DEFECT, REPRODUCED IN A REAL BROWSER BEFORE ANYTHING WAS CHANGED
//
// Chromium, timezoneId 'Asia/Colombo', clock frozen at 2026-07-31T19:30:00Z:
//
//     local clock                       Sat Aug 01 2026 01:00:00 GMT+0530
//     new Date().toISOString()          2026-07-31T19:30:00.000Z
//     ...slice(0, 10)   ->              2026-07-31      <-- what 37 places used
//     local getFullYear/Month/Date ->   2026-08-01      <-- what the owner sees
//
// Thirty-seven places answered "what is today" in UTC. The owner is at UTC+05:30,
// so for the first five and a half hours of every day the app was a day behind —
// and on the first of a month it filed the transaction into the PREVIOUS MONTH'S
// TAB, contradicting the one promise this app is built on.
//
// It is silent. Nothing throws, nothing is missing, the number is in the wrong
// bucket, and it would be found months later as a month that does not add up.
//
// index.html already had the correct answer — `today()`, on the local getters —
// and used the wrong one fourteen times, including inside the SAME function as a
// correct local month key:
//
//     const curMonthStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}`;  // local
//     const today = now.toISOString().slice(0, 10);                         // UTC
//
// Two notions of "now" in one function is how they drift. There is now one, and
// this file is what keeps it that way.
//
// WHAT IS DELIBERATELY NOT ASSERTED AGAINST
//
// Code that BUILDS its dates with Date.UTC() and reads them back with
// toISOString() is internally consistent — wealthflow-cashflow-engine.js works
// in UTC day boundaries on purpose. Gmail search windows are UTC by the API's
// definition. Only "which calendar day is it for the person holding the phone"
// belongs to wealthflow-when.js.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/* THE TEST SETS THE CLOCK IT IS TESTING. The first version of this file asserted
 * the offset was -330 and hoped the runner happened to be in Colombo; on a UTC
 * runner — which is every CI machine — that assertion simply failed, and had it
 * been written the other way round the whole suite would have passed vacuously
 * while proving nothing about the bug. Node re-reads process.env.TZ per Date
 * operation, so setting it before the import under test is enough. */
process.env.TZ = 'Asia/Colombo';

const { ymd, ym, today, thisMonth, startOfDay, daysBetween, daysUntil, zone } =
    await import('../wealthflow-when.js');

describe('the module answers with the LOCAL calendar day', () => {
    it('exposes what its callers use (guards against a vacuous pass)', () => {
        for (const fn of [ymd, ym, today, thisMonth, startOfDay, daysBetween, daysUntil, zone]) {
            expect(typeof fn).toBe('function');
        }
    });

    it('THE REPRODUCTION: 19:30Z on 31 July is the 1st of August at +05:30', () => {
        // The zone this file set above, checked rather than assumed: if TZ ever
        // stops taking effect, this fails here instead of every assertion below
        // passing vacuously against a UTC clock.
        expect(new Date().getTimezoneOffset()).toBe(-330);

        const instant = new Date('2026-07-31T19:30:00Z');
        expect(instant.toISOString().slice(0, 10)).toBe('2026-07-31');   // what it used to say
        expect(ymd(instant)).toBe('2026-08-01');                          // what the owner sees
        expect(ym(instant)).toBe('2026-08');                              // and the tab it belongs in
    });

    it('agrees with toISOString once the two cannot disagree', () => {
        const noon = new Date('2026-07-15T06:30:00Z');   // 12:00 in Colombo
        expect(ymd(noon)).toBe(noon.toISOString().slice(0, 10));
    });

    it('accepts a Date, an epoch, or a string, and refuses nonsense quietly', () => {
        const t = Date.parse('2026-07-31T19:30:00Z');
        expect(ymd(t)).toBe('2026-08-01');
        expect(ymd(new Date(t))).toBe('2026-08-01');
        expect(ymd('2026-07-31T19:30:00Z')).toBe('2026-08-01');
        for (const bad of ['', 'not a date', NaN, {}, []]) expect(ymd(bad)).toBe('');
        expect(ym('nope')).toBe('');
        expect(startOfDay('nope')).toBe(null);
    });

    it('pads a single-digit month and day, so the key sorts', () => {
        expect(ymd(new Date(2026, 0, 5))).toBe('2026-01-05');
        expect(ym(new Date(2026, 8, 1))).toBe('2026-09');
    });

    it('today() and thisMonth() are the same answer as ymd/ym of now', () => {
        const now = new Date();
        expect(today()).toBe(ymd(now));
        expect(thisMonth()).toBe(ym(now));
        expect(today().startsWith(thisMonth())).toBe(true);
    });
});

describe('day arithmetic counts LOCAL midnights', () => {
    it('THE OFF-BY-ONE: a due date is not measured from UTC midnight', () => {
        // `new Date('2026-08-01')` is UTC midnight — 05:30 local — so anything due
        // in the first five and a half hours of a day rounded to the wrong number
        // of days, and a card due today read as due tomorrow.
        const due = new Date(2026, 7, 2, 9, 0);          // 2 Aug, 09:00 local
        const from = new Date(2026, 7, 1, 1, 0);         // 1 Aug, 01:00 local
        expect(daysBetween(from, due)).toBe(1);
        expect(daysBetween(due, from)).toBe(-1);
        expect(daysBetween(from, new Date(2026, 7, 1, 23, 59))).toBe(0);
    });

    it('startOfDay is local midnight, not UTC midnight', () => {
        const d = startOfDay(new Date('2026-07-31T19:30:00Z'));
        expect(d.getFullYear()).toBe(2026);
        expect(d.getMonth()).toBe(7);          // August
        expect(d.getDate()).toBe(1);
        expect(d.getHours()).toBe(0);
    });

    it('daysUntil is measured from today, and says so when it cannot be', () => {
        expect(daysUntil(new Date())).toBe(0);
        expect(daysUntil('rubbish')).toBe(null);
    });

    it('names the zone, which is what the server has to be told', () => {
        expect(zone()).toBe('Asia/Colombo');
    });
});

describe('nothing computes "today" in UTC any more', () => {
    /* The files a browser loads. api/vision-scan.js is excluded because it runs on
     * a server that has no idea where the owner is — it now uses the `today` and
     * `tz` the client sends, and its last-resort UTC fallback is for a caller that
     * told it nothing at all. release-brain.js stamps a build on a CI runner. */
    const browserFiles = ['index.html', ...fs.readdirSync('.')
        .filter((f) => /^wealthflow-.*\.m?js$/.test(f))];

    it('there are files to check (guards against a vacuous pass)', () => {
        expect(browserFiles.length).toBeGreaterThan(30);
        expect(browserFiles).toContain('index.html');
        expect(browserFiles).toContain('wealthflow-ai-v4.js');
    });

    /* Comments stripped first: wealthflow-when.js documents the expression it
     * replaced, and a scanner that reads its own explanation as a violation
     * teaches the next person to delete the explanation. */
    const codeOnly = (s) => String(s)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

    it.each(browserFiles)('%s asks WFWhen, not toISOString', (f) => {
        const src = codeOnly(fs.readFileSync(f, 'utf8'));
        // `new Date()` — right now — turned into a day or a month key.
        const utcNow = src.match(/new Date\(\)\s*\.toISOString\(\)\s*\.(?:slice\(0,\s*(?:10|7)\)|split\('T'\)\[0\])/g);
        expect(utcNow, 'computes today in UTC: ' + (utcNow || []).join(' / ')).toBe(null);
    });
});

describe('the page and the modules are wired to it', () => {
    const html = fs.readFileSync('index.html', 'utf8');

    it('index.html loads wealthflow-when.js, before what reads it', () => {
        expect(html).toMatch(/<script[^>]+type="module"[^>]+src="wealthflow-when\.js"/);
        expect(html.indexOf('wealthflow-when.js'))
            .toBeLessThan(html.indexOf('wealthflow-scanner.js'));
    });

    it('the page has ONE today(), and it comes from the module', () => {
        expect(html).toContain('const today = () => window.WFWhen.today();');
        expect(html).toContain('const thisMonth = () => window.WFWhen.thisMonth();');
        // No silent UTC fallback: falling back to UTC is the defect being removed.
        expect(html).not.toMatch(/window\.WFWhen[\s\S]{0,80}\|\|[\s\S]{0,40}toISOString/);
    });

    it('the vision API is TOLD which day and zone the owner is in', () => {
        const v4 = fs.readFileSync('wealthflow-ai-v4.js', 'utf8');
        expect(v4).toContain('today: window.WFWhen.today(), tz: window.WFWhen.zone(),');
        const api = fs.readFileSync('api/vision-scan.js', 'utf8');
        expect(api).toContain('function todayFor(hints)');
        expect(api).toContain("new Intl.DateTimeFormat('en-CA', { timeZone: tz })");
        // and it prefers what it was told over its own UTC clock
        expect(api).not.toMatch(/hints\?\.today \|\| new Date\(\)\.toISOString/);
    });

    it('a statement date parsed from text is not re-read in UTC', () => {
        // `new Date('02 July 2026')` is LOCAL midnight; toISOString() then reads it
        // back as 18:30 on the 1st. The date printed on the statement came out a
        // day earlier than the statement says.
        const v4 = fs.readFileSync('wealthflow-ai-v4.js', 'utf8');
        expect(v4).toContain('return window.WFWhen.ymd(d3);');
    });
});

describe('the perf ratchet can see every module', () => {
    it('THE BLIND SPOT: a .mjs module used to be invisible to the byte budget', () => {
        // The filter was /^wealthflow-.*\.js$/, so wealthflow-mail-ingest.mjs and
        // wealthflow-mail-senders.mjs — 69 KB of first-party code — were never
        // counted, and any module added with that extension was free forever.
        const budget = fs.readFileSync('autonomy/perf-budget.mjs', 'utf8');
        expect(budget).toContain('/^wealthflow-.*\\.m?js$/');
    });

    it('and the count now includes them', async () => {
        const { measure } = await import('../autonomy/perf-budget.mjs');
        const m = measure();
        const onDisk = fs.readdirSync('.').filter((f) => /^wealthflow-.*\.m?js$/.test(f));
        expect(m.moduleCount).toBe(onDisk.length);
        expect(onDisk.some((f) => f.endsWith('.mjs'))).toBe(true);
    });
});
