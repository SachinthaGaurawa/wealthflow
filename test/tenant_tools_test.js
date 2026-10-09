/* =============================================================================
 * test/tenant_tools_test.js — what a person does with their statement, worked out on their own device
 * -----------------------------------------------------------------------------
 * Pure functions of the statement the server sent. What matters: "today" is the Sri Lanka day of the statement's own
 * clock, a loan that is late is shown as late and money coming in never is, the calendar file is a valid
 * iCalendar with the figures in it, and the spreadsheet can never run as a formula.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { upcoming, dayLabel, loanProgress, termProgress, calendarFile, csvCell, csvFile, todayNo } from '../tenant-tools.js';
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
        expect(file).toContain('SUMMARY:Pay LKR 30000.00 to your lender (DEB-AAAAAA)');
        expect(unfolded(file)).toContain('Quote the reference DEB-AAAAAA when you pay.');
    });

    it('words an interest reminder as money expected, escapes what iCalendar escapes, and folds long lines', () => {
        const f = calendarFile(interest, { t, fmtMoney: money, asOf: '2026-10-05T05:00:00.000Z' });
        expect(unfolded(f)).toContain('SUMMARY:Interest of LKR 10000.00 expected (INV-BBBBBB)');
        const odd = calendarFile({ ...loan, ref: 'A;B,C\nD' }, { t, fmtMoney: money, asOf: '2026-10-05T05:00:00.000Z' });
        expect(unfolded(odd)).toContain('SUMMARY:Pay LKR 30000.00 to your lender (A\\;B\\,C\\nD)');
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
            '"DEB-AAAAAA","Loan","2026-09-01","Loan paid out","50000.00","50000.00","LKR"',
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
