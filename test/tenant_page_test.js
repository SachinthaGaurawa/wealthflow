/* =============================================================================
 * test/tenant_page_test.js — the statement page's own logic, over a tiny DOM
 * -----------------------------------------------------------------------------
 * Pure helpers, plus the statement view run over a minimal document so that what the SERVER
 * says is shown as TEXT, never parsed as markup: the page's whole defence against a name or
 * note that someone typed into the lender's book.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
globalThis.__WF_TENANT_NO_BOOT = true;
const { fmtDay, fmtMonth, fmtMoney, fmtNum, fmtAsOf, fmtClock, describeFailure, statementView, tokenFromPath, COPY } = await import('../tenant-page.js');

class El {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.kids = []; this._text = ''; this.listeners = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    append(...k) { this.kids.push(...k); }
    addEventListener(t, f) { this.listeners[t] = f; }
    set textContent(v) { this._text = String(v); this.kids = []; }
    get textContent() { return this._text + this.kids.map((k) => k.textContent).join(''); }
    set className(v) { this.attrs.class = v; }
    walk(fn) { fn(this); this.kids.forEach((k) => k.walk && k.walk(fn)); }
}
class Txt { constructor(t) { this.t = t; this.nodeType = 3; } get textContent() { return this.t; } }
El.prototype.nodeType = 1;
const doc = { createElement: (t) => new El(t), createTextNode: (t) => new Txt(t) };

const BAD = '<img src=x onerror=alert(1)>';

describe('formatting', () => {
    it('writes days, months and money the way a statement does', () => {
        expect(fmtDay('2026-09-20')).toBe('20 Sep 2026');
        expect(fmtDay('2026-01-05T10:00:00Z')).toBe('5 Jan 2026');
        expect(fmtDay('')).toBe('-');
        expect(fmtDay('2026-13-01')).toBe('-');
        expect(fmtMonth('2026-08')).toBe('Aug 2026');
        expect(fmtMonth('x')).toBe('-');
        expect(fmtMoney(1234567.5, 'LKR')).toBe('LKR 1,234,567.50');
        expect(fmtNum(1234567.5)).toBe('1,234,567.50');
        expect(fmtNum('abc')).toBe('0.00');
        expect(fmtMoney('abc', 'usd')).toBe('LKR 0.00');                              // a bad figure is zero, a bad currency is the default: never markup
        expect(fmtMoney(5, BAD)).toBe('LKR 5.00');
        expect(fmtAsOf('2026-10-05T05:00:00.000Z')).toBe('5 Oct 2026, 10:30 (Sri Lanka time)');
        expect(fmtAsOf('nope')).toBe('');
        expect(fmtClock(185)).toBe('3:05');
        expect(fmtClock(-4)).toBe('0:00');
    });

    it('finds the link in the address, and only a link', () => {
        expect(tokenFromPath('/t/AbCdEfGhIjKlMnOp')).toBe('AbCdEfGhIjKlMnOp');
        expect(tokenFromPath('/t/AbCdEfGhIjKlMnOp/')).toBe('AbCdEfGhIjKlMnOp');
        for (const bad of ['/', '/t/', '/t/AbCdEfGhIjKlMnO', '/x/AbCdEfGhIjKlMnOp', '/t/AbCdEfGhIjKlMnOp/more', undefined, null]) expect(tokenFromPath(bad)).toBe('');
    });

    it('says why a request was refused, in the server\'s own words, with how long to wait', () => {
        expect(describeFailure(401, { error: 'The details or the code are not valid.' })).toBe('The details or the code are not valid.');
        expect(describeFailure(429, { error: 'Too many attempts.', retryAfterSec: 45 })).toBe('Too many attempts. Try again in 45 seconds.');
        expect(describeFailure(429, { error: 'Too many attempts.', retryAfterSec: 900 })).toBe('Too many attempts. Try again in about 15 minutes.');
        expect(describeFailure(429, null)).toMatch(/Too many attempts/);
        expect(describeFailure(503, null)).toMatch(/temporarily unavailable/);
        expect(describeFailure(500, null)).toBe(COPY.FAILED);
        expect(describeFailure(401, { error: 'x'.repeat(500) })).toBe(COPY.FAILED);        // not a sentence we wrote or the server wrote
        expect(describeFailure(401, { error: 5 })).toBe(COPY.FAILED);
    });
});

describe('the statement view', () => {
    const statement = {
        asOf: '2026-10-05T05:00:00.000Z',
        groups: [
            { kind: 'investment', ref: 'INV-9990B2', title: 'Investment', currency: 'LKR', capital: 500000, ratePct: 24, frequency: 'monthly', interestPerPeriod: 10000, start: '2026-01-05', end: '', totalReceived: 10000, payments: [{ month: '2026-08', amount: 10000, date: '2026-10-04' }] },
            { kind: 'loan', ref: 'DEB-96E5C2', title: 'Loan', currency: 'LKR', lent: 50000, repaid: 20000, outstanding: 30000, status: 'open', events: [{ date: '2026-09-01', kind: 'lent', amount: 50000, balance: 50000 }, { date: '2026-09-20', kind: 'repayment', amount: 20000, balance: 30000 }] },
        ],
        totals: [{ currency: 'LKR', invested: 500000, interestReceived: 10000, loanOutstanding: 30000 }],
        truncated: false,
    };
    const textOf = (nodes) => nodes.map((n) => n.textContent).join(' | ');

    it('shows the figures, the reference codes and the running balance', () => {
        const nodes = statementView(doc, statement);
        const text = textOf(nodes);
        for (const want of ['LKR 500,000.00', 'LKR 10,000.00', 'INV-9990B2', 'DEB-96E5C2', '24% a year', 'Monthly', '5 Jan 2026', 'Aug 2026', '4 Oct 2026', 'LKR 30,000.00', 'Loan paid out', 'Repayment', '20 Sep 2026', 'Open']) expect(text, want).toContain(want);
        expect(nodes[3].textContent).toContain('DEB-96E5C2');
        expect(nodes[3].textContent).not.toMatch(/interest|rate/i);                  // the loan card has no interest on it
    });

    it('shows every string it is given as text, never as markup', () => {
        const hostile = structuredClone(statement);
        hostile.groups[0].ref = BAD; hostile.groups[0].title = BAD; hostile.groups[0].frequency = BAD; hostile.groups[0].start = BAD;
        hostile.groups[0].payments[0].month = BAD; hostile.groups[1].events[0].kind = BAD; hostile.groups[1].status = BAD; hostile.groups[1].ref = BAD;
        hostile.totals[0].currency = BAD; hostile.groups[0].currency = BAD; hostile.groups[1].currency = BAD;
        const nodes = statementView(doc, hostile);
        const tags = new Set();
        const attrs = [];
        nodes.forEach((n) => n.walk((e) => { tags.add(e.tag); attrs.push(...Object.values(e.attrs)); }));
        expect([...tags].every((t) => ['div', 'section', 'h3', 'span', 'dl', 'dt', 'dd', 'p', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td'].includes(t))).toBe(true);
        expect(tags.has('img')).toBe(false);
        expect(textOf(nodes)).toContain(BAD);                                         // it is on the page, as characters
    });

    it('says so when there is nothing yet, and survives anything the server could send', () => {
        expect(textOf(statementView(doc, { groups: [], totals: [] }))).toMatch(/nothing to show yet/);
        for (const odd of [null, undefined, {}, [], 'x', { groups: 'x', totals: 5 }, { groups: [{ kind: 'loan', events: [] }], totals: [{ currency: 'LKR' }] }]) {
            expect(() => statementView(doc, odd), JSON.stringify(odd)).not.toThrow();
        }
        expect(textOf(statementView(doc, { ...statement, truncated: true }))).toMatch(/only the first part/);
    });

    it('shows each currency\'s totals only for what exists in it', () => {
        const onlyLoan = { ...statement, groups: [statement.groups[1]], totals: [{ currency: 'LKR', invested: 0, interestReceived: 0, loanOutstanding: 30000 }] };
        const text = textOf(statementView(doc, onlyLoan));
        expect(text).toContain('Loan outstanding');
        expect(text).not.toContain('Interest received');
        expect(text).not.toContain('Invested');
    });

    it('marks a settled loan', () => {
        const settled = structuredClone(statement);
        settled.groups[1].status = 'settled'; settled.groups[1].outstanding = 0;
        expect(textOf(statementView(doc, settled))).toContain('Settled');
    });
});
