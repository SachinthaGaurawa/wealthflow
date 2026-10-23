/* =============================================================================
 * test/tenant_tools_test.js — what a person does with their statement, worked out on their own device
 * -----------------------------------------------------------------------------
 * Pure functions of the statement the server sent. What matters: "today" is the Sri Lanka day of the statement's own
 * clock, a loan that is late is shown as late and money coming in never is, the calendar file is a valid
 * iCalendar with the figures in it, and the spreadsheet can never run as a formula.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { upcoming, dayLabel, loanProgress, termProgress, calendarFile, csvCell, csvFile, todayNo, payoffPlan, planFile, balanceTrail, niceTicks, fmtAxis, chartData, chartLayout } from '../tenant-tools.js';
import { makeT } from '../tenant-lang.js';

const t = makeT('en');
const money = (v, c) => `${c} ${Number(v).toFixed(2)}`;
const st = (over = {}) => ({
    asOf: '2026-10-05T05:00:00.000Z',
    groups: [
        { kind: 'loan', ref: 'DEB-AAAAAA', currency: 'LKR', lent: 50000, repaid: 20000, outstanding: 30000, status: 'open', due: '2026-10-01', events: [{ date: '2026-09-01', kind: 'lent', amount: 50000, balance: 50000 }, { date: '2026-09-20', kind: 'repayment', amount: 20000, balance: 30000 }] },
        { kind: 'investment', ref: 'INV-BBBBBB', currency: 'LKR', capital: 500000, start: '2026-01-05', end: '2027-01-05', nextInterest: { date: '2026-10-12', amount: 10000 }, payments: [{ month: '2026-08', date: '2026-08-26', amount: 10000 }] },
    ],
    ...over,
});

describe('today and what is coming up', () => {
    it('reads today in Sri Lanka from the statement\'s own clock', () => {
        expect(todayNo('2026-10-05T05:00:00.000Z')).toBe(todayNo('2026-10-05T18:29:00.000Z'));          // 10:30 and 23:59 on the 5th
        expect(todayNo('2026-10-05T18:31:00.000Z')).toBe(todayNo('2026-10-05T05:00:00.000Z') + 1);       // 00:01 on the 6th in Colombo
        expect(Number.isNaN(todayNo('nope'))).toBe(true);
    });

    it('lists the late loan first, then the next interest, with days and tone', () => {
        const items = upcoming(st());
        expect(items.map((i) => [i.kind, i.ref, i.date, i.amount, i.days, i.tone])).toEqual([
            ['loan', 'DEB-AAAAAA', '2026-10-01', 30000, -4, 'late'],
            ['interest', 'INV-BBBBBB', '2026-10-12', 10000, 7, 'soon'],
        ]);
    });

    it('never calls money coming in late, and shows only money that is still owed', () => {
        const s = st();
        s.groups[1].nextInterest = { date: '2026-10-01', amount: 10000 };
        expect(upcoming(s).find((i) => i.kind === 'interest')).toMatchObject({ days: 0, tone: 'soon' });
        s.groups[0].status = 'settled'; s.groups[0].outstanding = 0;
        expect(upcoming(s).map((i) => i.kind)).toEqual(['interest']);
        s.groups[0].status = 'open'; s.groups[0].outstanding = 5; s.groups[0].due = '';
        expect(upcoming(s).map((i) => i.kind)).toEqual(['interest']);
    });

    it('survives a statement that is not what it should be', () => {
        for (const bad of [null, undefined, 'x', {}, { asOf: 'nope', groups: [] }, { asOf: '2026-10-05T05:00:00.000Z', groups: [null, 5, { kind: 'loan' }, { kind: 'investment', nextInterest: 'x' }] }]) expect(upcoming(bad)).toEqual([]);
        expect(upcoming(st(), 1)).toHaveLength(1);
        expect(upcoming(st(), 0)).toEqual([]);
    });

    it('says the days in words', () => {
        expect([0, 1, 5, -1, -4].map((d) => dayLabel(d, t))).toEqual(['Due today', 'Due tomorrow', 'In 5 days', '1 day overdue', '4 days overdue']);
        expect(dayLabel(5, makeT('si'))).toMatch(/දින 5/);
        expect(dayLabel('x', t)).toBe('Due today');
    });
});

describe('progress', () => {
    it('is the share of the loan paid back, and nothing when nothing was paid out', () => {
        expect(loanProgress({ lent: 50000, repaid: 20000 })).toBe(40);
        expect(loanProgress({ lent: 50000, repaid: 60000 })).toBe(100);
        expect(loanProgress({ lent: 0, repaid: 0 })).toBe(null);
        expect(loanProgress(null)).toBe(null);
    });

    it('is the share of an investment\'s term that has gone, and nothing without an end date', () => {
        expect(termProgress({ start: '2026-01-05', end: '2027-01-05' }, '2026-10-05T05:00:00.000Z')).toBe(75);
        expect(termProgress({ start: '2026-01-05', end: '2026-02-05' }, '2026-10-05T05:00:00.000Z')).toBe(100);
        expect(termProgress({ start: '2026-12-01', end: '2027-01-05' }, '2026-10-05T05:00:00.000Z')).toBe(0);
        expect(termProgress({ start: '2026-01-05', end: '' }, '2026-10-05T05:00:00.000Z')).toBe(null);
        expect(termProgress({ start: '2026-02-05', end: '2026-01-05' }, '2026-10-05T05:00:00.000Z')).toBe(null);
    });
});

describe('the calendar reminder', () => {
    const [loan, interest] = upcoming(st());
    const file = calendarFile(loan, { t, fmtMoney: money, asOf: '2026-10-05T05:00:00.000Z' });
    const unfolded = (text) => text.replace(/\r\n /g, '');

    it('is a well-formed iCalendar: CRLF lines, an all-day event on the due date, an alert the day before', () => {
        expect(file.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
        expect(file.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true);
        expect(file).not.toMatch(/[^\r]\n/);
        for (const want of ['DTSTART;VALUE=DATE:20261001', 'DTEND;VALUE=DATE:20261002', 'DTSTAMP:20261005T050000Z', 'TRIGGER:-P1D', 'UID:20261001-DEB-AAAAAA@wealthflow']) expect(file).toContain(want);
        expect(file).toContain('SUMMARY:Payment of LKR 30000.00 due to your lender (DEB-AAAAAA)');
        expect(unfolded(file)).toContain('Please quote reference DEB-AAAAAA when you pay.');
    });

    it('words an interest reminder as money expected, escapes what iCalendar escapes, and folds long lines', () => {
        const f = calendarFile(interest, { t, fmtMoney: money, asOf: '2026-10-05T05:00:00.000Z' });
        expect(unfolded(f)).toContain('SUMMARY:Interest payment of LKR 10000.00 due (INV-BBBBBB)');
        const odd = calendarFile({ ...loan, ref: 'A;B,C\nD' }, { t, fmtMoney: money, asOf: '2026-10-05T05:00:00.000Z' });
        expect(unfolded(odd)).toContain('SUMMARY:Payment of LKR 30000.00 due to your lender (A\\;B\\,C\\nD)');
        for (const line of calendarFile(loan, { t: makeT('si'), fmtMoney: money, asOf: '2026-10-05T05:00:00.000Z' }).split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
        expect(calendarFile({ ...loan, date: 'x' }, { t, fmtMoney: money })).toBe('');
        expect(calendarFile(null, { t, fmtMoney: money })).toBe('');
    });
});

describe('the spreadsheet', () => {
    it('has one row for every movement and every payment, with the currency in a column', () => {
        const lines = csvFile(st()).replace(/^﻿/, '').trim().split('\r\n');
        expect(lines[0]).toBe('"Reference","Type","Date","Description","Amount","Balance","Currency"');
        expect(lines.slice(1)).toEqual([
            '"DEB-AAAAAA","Loan","2026-09-01","Loan disbursed","50000.00","50000.00","LKR"',
            '"DEB-AAAAAA","Loan","2026-09-20","Repayment","20000.00","30000.00","LKR"',
            '"INV-BBBBBB","Investment","2026-08-26","Interest received for 2026-08","10000.00","","LKR"',
        ]);
        expect(csvFile(st()).startsWith('﻿')).toBe(true);
    });

    it('can never run as a formula, and quotes what needs quoting', () => {
        for (const bad of ['=1+1', '+SUM(A1)', '-2', '@x', '\tx']) expect(csvCell(bad)).toBe(`"'${bad}"`);
        expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
        expect(csvCell(null)).toBe('""');
        const s = st(); s.groups[0].ref = '=HYPERLINK("x")';
        expect(csvFile(s)).toContain(`"'=HYPERLINK(""x"")"`);
    });

    it('is only a header for an empty or damaged statement', () => {
        for (const bad of [null, {}, { groups: [null, 5] }]) expect(csvFile(bad).replace(/^﻿/, '').trim().split('\r\n')).toHaveLength(1);
    });
});

describe('a repayment plan', () => {
    const loan = (over = {}) => ({ ...st().groups[0], due: '2026-12-31', ...over });
    const ASOF = '2026-10-05T05:00:00.000Z';

    it('says how many payments, when the first and the last fall, and what the last one is', () => {
        const p = payoffPlan(loan(), ASOF, { every: 'monthly', amount: 12500 });
        expect(p).toMatchObject({ ref: 'DEB-AAAAAA', owed: 30000, amount: 12500, count: 3, last: 5000, first: '2026-11-05', finish: '2027-01-05', onTime: false });
        const w = payoffPlan(loan(), ASOF, { every: 'weekly', amount: 10000 });
        expect(w).toMatchObject({ count: 3, last: 10000, first: '2026-10-12', finish: '2026-10-26', onTime: true });
        expect(payoffPlan(loan(), ASOF, { every: 'fortnightly', amount: 7500 })).toMatchObject({ count: 4, first: '2026-10-19', finish: '2026-11-30' });
    });

    it('works in cents, so a payment that is not a round number still adds up', () => {
        const p = payoffPlan(loan({ outstanding: 100 }), ASOF, { every: 'weekly', amount: 33.33 });
        expect(p.count).toBe(4);
        expect(p.last).toBe(0.01);
        expect(p.amount * (p.count - 1) + p.last).toBeCloseTo(100, 10);
    });

    it('never plans more than the balance: one big payment is one payment', () => {
        expect(payoffPlan(loan(), ASOF, { amount: 999999 })).toMatchObject({ amount: 30000, count: 1, last: 30000 });
    });

    it('offers the equal payment that clears the loan by its due date, in whole rupees', () => {
        expect(payoffPlan(loan(), ASOF).byDue).toEqual({ count: 2, amount: 15000 });
        expect(payoffPlan(loan(), ASOF, { every: 'weekly' }).byDue).toEqual({ count: 12, amount: 2500 });
        expect(payoffPlan(loan({ outstanding: 1000 }), ASOF, { every: 'weekly' }).byDue).toEqual({ count: 12, amount: 84 });      // 83.33 rounds up, so the loan really is cleared
        expect(payoffPlan(loan({ outstanding: 50 }), ASOF, { every: 'weekly' }).byDue).toEqual({ count: 12, amount: 4.17 });       // a small balance keeps its cents
        const p = payoffPlan(loan(), ASOF, { every: 'monthly', amount: payoffPlan(loan(), ASOF).byDue.amount });
        expect(p.onTime).toBe(true);
    });

    it('has no "by the due date" for a loan that is late or has no date', () => {
        expect(payoffPlan(loan({ due: '2026-10-01' }), ASOF).byDue).toBeNull();
        expect(payoffPlan(loan({ due: '' }), ASOF, { amount: 10000 }).onTime).toBeNull();
        expect(payoffPlan(loan({ due: '2026-10-06' }), ASOF, { every: 'monthly' }).byDue).toBeNull();      // the next monthly payment would already be past it
    });

    it('keeps a monthly plan on a day every month has', () => {
        const p = payoffPlan(loan(), '2026-01-31T05:00:00.000Z', { every: 'monthly', amount: 10000 });
        expect(p.first).toBe('2026-02-28');
        expect(p.finish).toBe('2026-04-28');
    });

    it('says so when the amount is missing, wrong, or would take for ever', () => {
        for (const amount of [undefined, '', 'abc', 0, -5, NaN]) expect(payoffPlan(loan(), ASOF, { amount })).toMatchObject({ amount: 0 });
        expect(payoffPlan(loan(), ASOF, { amount: 0.01 })).toMatchObject({ tooMany: true });
        expect(payoffPlan(loan(), ASOF, { every: 'daily', amount: 10000 }).every).toBe('monthly');      // an unknown rhythm falls back, never throws
    });

    it('is nothing for a loan that is not open with something owed, or a statement without a clock', () => {
        for (const g of [loan({ status: 'settled' }), loan({ outstanding: 0 }), loan({ kind: 'investment' }), null, 5]) expect(payoffPlan(g, ASOF, { amount: 100 })).toBeNull();
        expect(payoffPlan(loan(), 'nope', { amount: 100 })).toBeNull();
    });

    it('becomes one repeating calendar entry with the right rule and count', () => {
        const env = { t, fmtMoney: money, asOf: ASOF };
        const ics = planFile(payoffPlan(loan(), ASOF, { every: 'fortnightly', amount: 7500 }), env);
        expect(ics).toContain('BEGIN:VCALENDAR');
        expect(ics).toContain('DTSTART;VALUE=DATE:20261019');
        expect(ics).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4');
        expect(ics).toContain('SUMMARY:Payment of LKR 7500.00 due to your lender (DEB-AAAAAA)');
        expect(ics).toContain('TRIGGER:-P1D');
        expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
        expect(planFile(payoffPlan(loan(), ASOF, { every: 'monthly', amount: 10000 }), env)).toContain('RRULE:FREQ=MONTHLY;INTERVAL=1;COUNT=3');
        expect(planFile(payoffPlan(loan(), ASOF, { every: 'weekly', amount: 10000 }), env)).toContain('RRULE:FREQ=WEEKLY;INTERVAL=1;COUNT=3');
        for (const bad of [null, {}, payoffPlan(loan(), ASOF), payoffPlan(loan(), ASOF, { amount: 0.01 })]) expect(planFile(bad, env)).toBe('');
    });

    it('draws a loan\'s balance from its movements', () => {
        expect(balanceTrail(st().groups[0])).toEqual([50000, 30000]);
        for (const bad of [null, {}, { events: 5 }]) expect(balanceTrail(bad)).toEqual([]);
    });
});

describe('the balance chart', () => {
    const NOW = '2026-10-23T05:00:00.000Z';
    const loan = (over = {}) => ({
        kind: 'loan', ref: 'DEB-CCCCCC', currency: 'LKR', status: 'open', due: '2026-10-30',
        events: [
            { date: '2026-10-05', kind: 'lent', amount: 1000, balance: 1000 },
            { date: '2026-10-06', kind: 'repayment', amount: 150, balance: 850 },
            { date: '2026-10-06', kind: 'repayment', amount: 300, balance: 550 },
            { date: '2026-10-09', kind: 'repayment', amount: 100, balance: 450 },
        ],
        ...over,
    });

    it('picks round figures for the up-axis that fill the chart', () => {
        expect(niceTicks(1000).ticks).toEqual([0, 250, 500, 750, 1000]);
        expect(niceTicks(730)).toEqual({ top: 750, ticks: [0, 250, 500, 750] });
        expect(niceTicks(30000).ticks).toEqual([0, 10000, 20000, 30000]);
        expect(niceTicks(5000000).ticks).toEqual([0, 2500000, 5000000]);
        expect(niceTicks(123456).top).toBe(150000);
        expect(niceTicks(0.5).ticks).toEqual([0, 0.25, 0.5]);
        for (const v of [1, 7, 99, 999, 1234, 48250, 99999, 1e6, 7.3e7]) {
            const { top, ticks } = niceTicks(v);
            expect(top).toBeGreaterThanOrEqual(v);
            expect(ticks[0]).toBe(0);
            expect(ticks.length).toBeGreaterThanOrEqual(3);
            expect(ticks.length).toBeLessThanOrEqual(5);
            expect(ticks[ticks.length - 1]).toBe(top);
        }
        for (const bad of [0, -3, 'x', null, undefined, NaN, Infinity]) expect(niceTicks(bad)).toEqual({ top: 1, ticks: [0, 1] });
    });

    it('writes axis figures short enough for a phone', () => {
        expect(['0', 7, 250, 999].map(fmtAxis)).toEqual(['0', '7', '250', '999']);
        expect([1000, 1500, 12345, 2400000, 1e6].map(fmtAxis)).toEqual(['1K', '1.5K', '12.35K', '2.4M', '1M']);
        expect(fmtAxis(-1500)).toBe('1.5K');
        expect(fmtAxis('x')).toBe('0');
    });

    it('turns a settled loan into points on a real date axis, with no extra point for today', () => {
        const d = chartData(loan({ status: 'settled', due: null, events: [
            { date: '2026-10-05', kind: 'lent', amount: 1000, balance: 1000 },
            { date: '2026-10-06', kind: 'repayment', amount: 150, balance: 850 },
            { date: '2026-10-09', kind: 'repayment', amount: 850, balance: 0 },
        ] }), NOW);
        expect(d.points.map((p) => [p.iso, p.kind, p.balance, p.index])).toEqual([
            ['2026-10-05', 'lent', 1000, 0], ['2026-10-06', 'repayment', 850, 1], ['2026-10-09', 'repayment', 0, 2],
        ]);
        expect(d.end - d.start).toBe(4);
        expect(d.settled).toBe(true);
        expect(d.active).toBe(false);
        expect(d.due).toBeNull();
        expect(d.top).toBe(1000);
        expect(d.ticks).toEqual([0, 250, 500, 750, 1000]);
        expect(d.currency).toBe('LKR');
    });

    it('keeps an open loan running to today at the balance it still has', () => {
        const d = chartData(loan({ due: null }), NOW);
        const last = d.points[d.points.length - 1];
        expect([last.kind, last.iso, last.balance, last.index, last.amount]).toEqual(['now', '2026-10-23', 450, -1, 0]);
        expect(d.active).toBe(true);
        // a movement today needs no extra point
        const same = chartData(loan({ due: null, events: [...loan().events, { date: '2026-10-23', kind: 'repayment', amount: 50, balance: 400 }] }), NOW);
        expect(same.points.some((p) => p.kind === 'now')).toBe(false);
    });

    it('marks the due date when it is on the drawn stretch, or close enough to extend it', () => {
        // due next week: the axis stretches to it, and it is not late
        const next = chartData(loan(), NOW);
        expect(next.due).toEqual({ day: next.end, iso: '2026-10-30', late: false });
        // due in the middle of the stretch and already past: late
        const late = chartData(loan({ due: '2026-10-12' }), NOW);
        expect(late.due.iso).toBe('2026-10-12');
        expect(late.due.late).toBe(true);
        expect(late.points[late.points.length - 1].iso).toBe('2026-10-23');
        // due on the last day (today): on the stretch, not late
        expect(chartData(loan({ due: '2026-10-23' }), NOW).due.late).toBe(false);
        // far in the future (a three-year loan): left off so the chart does not flatten
        expect(chartData(loan({ due: '2029-10-23' }), NOW).due).toBeNull();
        // before the loan began, or not a date, or on a settled loan: nothing
        expect(chartData(loan({ due: '2026-09-01' }), NOW).due).toBeNull();
        expect(chartData(loan({ due: 'soon' }), NOW).due).toBeNull();
        expect(chartData(loan({ status: 'settled' }), NOW).due).toBeNull();
    });

    it('draws nothing when there is nothing to see', () => {
        expect(chartData(null, NOW)).toBeNull();
        expect(chartData({}, NOW)).toBeNull();
        expect(chartData(loan({ events: 5 }), NOW)).toBeNull();
        expect(chartData(loan({ events: [] }), NOW)).toBeNull();
        // one movement on a settled loan
        expect(chartData(loan({ status: 'settled', events: [loan().events[0]] }), NOW)).toBeNull();
        // every movement on one day, and the loan is settled
        expect(chartData(loan({ status: 'settled', events: [loan().events[1], loan().events[2]] }), NOW)).toBeNull();
        // nothing was ever owed
        expect(chartData(loan({ status: 'settled', events: [
            { date: '2026-10-05', kind: 'lent', amount: 0, balance: 0 }, { date: '2026-10-06', kind: 'repayment', amount: 0, balance: 0 },
        ] }), NOW)).toBeNull();
    });

    it('skips rows it cannot place and puts the rest in date order', () => {
        const d = chartData(loan({ due: null, events: [
            { date: '2026-10-09', kind: 'repayment', amount: 100, balance: 450 },
            { date: 'garbage', kind: 'repayment', amount: 1, balance: 10 },
            { date: '2026-10-05', kind: 'lent', amount: 1000, balance: 1000 },
            { date: '2026-10-07', kind: 'repayment', amount: 1, balance: -5 },
            { date: '2026-10-08', kind: 'repayment', amount: 1, balance: 'x' },
            null,
            { date: '2026-10-06', kind: 'repayment', amount: 150, balance: 850 },
        ] }), NOW);
        expect(d.points.filter((p) => p.kind !== 'now').map((p) => [p.iso, p.balance, p.index])).toEqual([
            ['2026-10-05', 1000, 2], ['2026-10-06', 850, 6], ['2026-10-09', 450, 0],
        ]);
    });

    it('lays out a staircase that never slopes, inside the room the labels need', () => {
        const d = chartData(loan({ status: 'settled', due: null }), NOW);
        const L = chartLayout(d, 360, 200);
        expect([L.width, L.height]).toEqual([360, 200]);
        expect(L.x0).toBeGreaterThanOrEqual(30);
        expect(L.x1).toBe(344);
        expect(L.pts).toHaveLength(d.points.length);
        // every vertical step stays on the x of the movement, and every flat run is level with the balance before it
        const segs = L.line.slice(1).split(' L').map((s) => s.split(' ').map(Number));
        for (let i = 3; i < segs.length; i += 2) {
            expect(segs[i - 1][1]).toBe(segs[i - 2][1]);
            expect(segs[i][0]).toBe(segs[i - 1][0]);
        }
        expect(L.area.endsWith('Z')).toBe(true);
        // higher balance, higher on the screen; the base line is the bottom of the plot
        expect(L.yTicks[0]).toMatchObject({ v: 0, y: L.y1, label: '0' });
        expect(L.yTicks[L.yTicks.length - 1]).toMatchObject({ v: d.top, y: L.y0 });
        expect(L.pts[0].y).toBeLessThan(L.pts[L.pts.length - 1].y);
        expect(L.pts[0].x).toBe(L.x0);
        expect(L.pts[L.pts.length - 1].x).toBe(L.x1);
        // room for a marked due date above the plot only when there is one
        expect(chartLayout(chartData(loan(), NOW), 360, 200).y0).toBeGreaterThan(L.y0);
    });

    it('labels the dates with as many as fit, never crowded, starting and ending on the first and last day', () => {
        const d = chartData(loan({ status: 'settled', due: null }), NOW);
        const narrow = chartLayout(d, 240, 200);
        const wide = chartLayout(d, 1000, 240);
        expect(narrow.xTicks.length).toBeLessThanOrEqual(wide.xTicks.length);
        expect(wide.xTicks.length).toBeLessThanOrEqual(5);
        for (const L of [narrow, wide]) {
            expect(L.xTicks.length).toBeGreaterThanOrEqual(2);
            expect(L.xTicks[0]).toMatchObject({ day: d.start, anchor: 'start' });
            expect(L.xTicks[L.xTicks.length - 1]).toMatchObject({ day: d.end, anchor: 'end' });
            for (let i = 1; i < L.xTicks.length; i += 1) expect(L.xTicks[i].x - L.xTicks[i - 1].x).toBeGreaterThanOrEqual(66 - 1);
        }
        // a four-day stretch has only four dates to show
        expect(new Set(wide.xTicks.map((k) => k.day)).size).toBe(wide.xTicks.length);
    });

    it('finds the movement under a finger, and a wide label never runs off the left edge', () => {
        const d = chartData(loan({ status: 'settled', due: null }), NOW);
        const L = chartLayout(d, 360, 200);
        expect(L.nearest(-50)).toBe(0);
        expect(L.nearest(L.pts[0].x)).toBe(0);
        expect(L.nearest(9999)).toBe(L.pts.length - 1);
        expect(L.nearest(L.pts[3].x - 1)).toBe(3);
        // two movements on one day stand on one x: with no height the later one, with a height the one the pointer is nearer to
        expect(L.pts[1].x).toBe(L.pts[2].x);
        expect(L.nearest(L.pts[1].x)).toBe(2);
        expect(L.nearest(L.pts[1].x, L.pts[1].y - 5)).toBe(1);
        expect(L.nearest(L.pts[1].x + 2, L.pts[2].y + 5)).toBe(2);
        expect(L.nearest(L.pts[1].x, L.y0)).toBe(1);
        expect(L.nearest(L.pts[1].x, L.y1)).toBe(2);
        expect(L.nearest(L.pts[3].x, L.y0)).toBe(3);
        const big = chartLayout(chartData(loan({ status: 'settled', due: null, events: [
            { date: '2026-01-05', kind: 'lent', amount: 1100000, balance: 1100000 }, { date: '2026-10-09', kind: 'repayment', amount: 1100000, balance: 0 },
        ] }), NOW), 320, 200);
        expect(big.yTicks.map((k) => k.label)).toEqual(['0', '500K', '1M', '1.5M']);
        expect(big.x0).toBeGreaterThan(L.x0);
        expect(big.x0).toBeLessThanOrEqual(72);
        // a tiny canvas still gets a sane layout
        const tiny = chartLayout(d, 10, 10);
        expect(tiny.width).toBeGreaterThanOrEqual(160);
        expect(tiny.height).toBeGreaterThanOrEqual(120);
        expect(tiny.x1).toBeGreaterThan(tiny.x0);
    });
});
