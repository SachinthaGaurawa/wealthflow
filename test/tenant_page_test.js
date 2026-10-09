/* =============================================================================
 * test/tenant_page_test.js — the statement page's own logic, over a tiny DOM
 * -----------------------------------------------------------------------------
 * Pure helpers, plus the statement view run over a minimal document so that what the SERVER
 * says is shown as TEXT, never parsed as markup: the page's whole defence against a name or
 * note that someone typed into the lender's book.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
globalThis.__WF_TENANT_NO_BOOT = true;
const { fmtDay, fmtMonth, fmtMoney, fmtNum, fmtAsOf, fmtClock, describeFailure, statementView, tokenFromPath, accountText, COPY } = await import('../tenant-page.js');
const { makeT } = await import('../tenant-lang.js');

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
        expect([...tags].every((t) => ['div', 'section', 'h3', 'span', 'dl', 'dt', 'dd', 'p', 'table', 'caption', 'thead', 'tbody', 'tr', 'th', 'td', 'ul', 'li', 'progress'].includes(t))).toBe(true);
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

describe('what a person needs next: when, and where to pay', () => {
    const acct = { bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'Quote your reference' };
    const base = {
        asOf: '2026-10-05T05:00:00.000Z',
        groups: [
            { kind: 'investment', ref: 'INV-9990B2', title: 'Investment', currency: 'LKR', lender: 1, capital: 500000, ratePct: 24, frequency: 'monthly', interestPerPeriod: 10000, start: '2026-01-05', end: '', nextInterest: { date: '2026-11-05', amount: 10000 }, totalReceived: 10000, payments: [] },
            { kind: 'loan', ref: 'DEB-96E5C2', title: 'Loan', currency: 'LKR', lender: 1, lent: 50000, repaid: 20000, outstanding: 30000, status: 'open', due: '2026-10-01', overdueDays: 4, events: [] },
        ],
        totals: [{ currency: 'LKR', invested: 500000, interestReceived: 10000, loanOutstanding: 30000 }],
        lenders: [{ n: 1, accounts: [acct] }], lenderCount: 1, truncated: false,
    };
    const textOf = (nodes) => nodes.map((n) => n.textContent).join(' | ');
    const buttonsOf = (nodes) => { const out = []; nodes.forEach((n) => n.walk((e) => { if (e.tag === 'button') out.push(e); })); return out; };

    it('says when the next interest is due and when a loan is expected back, and how late it is', () => {
        const text = textOf(statementView(doc, base));
        expect(text).toContain('Next interest due5 Nov 2026 (LKR 10,000.00)');
        expect(text).toContain('Expected back by1 Oct 2026 (4 days ago)');
        const one = structuredClone(base); one.groups[1].overdueDays = 1;
        expect(textOf(statementView(doc, one))).toContain('Expected back by1 Oct 2026 (1 day ago)');
        const onTime = structuredClone(base); onTime.groups[1].overdueDays = 0;
        expect(textOf(statementView(doc, onTime))).toMatch(/Expected back by1 Oct 2026(?! \()/);        // on time: the date, and no "days ago"
        const none = structuredClone(base); none.groups[0].nextInterest = null; none.groups[1].due = '';
        expect(textOf(statementView(doc, none))).not.toMatch(/Next interest due|Expected back by/);
    });

    it('shows the lender\'s bank account before the records, with the account number the biggest thing in it', () => {
        const nodes = statementView(doc, base);
        const text = textOf(nodes);
        for (const want of ['How to pay', 'Commercial Bank', 'N. Perera', '8001234567', 'Colombo 03', 'CCEYLKLX', 'Quote your reference', 'References: INV-9990B2, DEB-96E5C2']) expect(text, want).toContain(want);
        expect(text.indexOf('How to pay')).toBeLessThan(text.indexOf('Capital'));
    });

    it('has copy buttons only when the page can copy: the number, the SWIFT code, the lot, and each reference code', () => {
        expect(buttonsOf(statementView(doc, base))).toHaveLength(0);
        const copied = [];
        const nodes = statementView(doc, base, makeT('en'), { copy: (text, b) => copied.push([text, b.tag]) });
        const buttons = buttonsOf(nodes);
        expect(buttons).toHaveLength(5);
        expect(buttons.map((b) => b.attrs['aria-label'])).toEqual(['Copy: Account number', 'Copy: SWIFT / IBAN', 'Copy all details', 'Copy reference: INV-9990B2', 'Copy reference: DEB-96E5C2']);
        buttons.forEach((b) => b.listeners.click());
        expect(copied.map((c) => c[0])).toEqual(['8001234567', 'CCEYLKLX', 'Bank: Commercial Bank\nAccount name: N. Perera\nAccount number: 8001234567\nBranch: Colombo 03\nSWIFT / IBAN: CCEYLKLX', 'INV-9990B2', 'DEB-96E5C2']);
    });

    it('has no payment section when the lender gave no account, and names each lender when there are several', () => {
        const none = { ...base, lenders: [] };
        expect(textOf(statementView(doc, none))).not.toContain('How to pay');
        const two = structuredClone(base);
        two.lenderCount = 2; two.groups[1].lender = 2;
        two.lenders = [{ n: 1, accounts: [acct] }, { n: 2, accounts: [{ ...acct, bank: 'Peoples Bank', number: '9999999999' }] }];
        const text = textOf(statementView(doc, two));
        expect(text).toContain('Lender 1');
        expect(text).toContain('Lender 2');
        expect(text).toContain('Peoples Bank');
        expect(text).toContain('References: DEB-96E5C2');
    });

    it('shows an account\'s words as text, never as markup, and survives a damaged one', () => {
        const hostile = structuredClone(base);
        hostile.lenders = [{ n: 1, accounts: [{ bank: BAD, holder: BAD, number: BAD, branch: BAD, swift: BAD, note: BAD }, null, 5, {}] }, null, { n: 2 }];
        const nodes = statementView(doc, hostile, makeT('en'), { copy: () => {} });
        const tags = new Set();
        nodes.forEach((n) => n.walk((e) => tags.add(e.tag)));
        expect(tags.has('img')).toBe(false);
        expect(textOf(nodes)).toContain(BAD);
        for (const odd of [null, {}, { lenders: 'x', groups: [] }, { lenders: [{ accounts: 'x' }], groups: [] }]) expect(() => statementView(doc, odd, makeT('en'), { copy: () => {} }), JSON.stringify(odd)).not.toThrow();
    });

    it('reads in Sinhala when asked, with the figures, dates and codes untouched', () => {
        const text = textOf(statementView(doc, base, makeT('si'), { copy: () => {} }));
        for (const want of ['ගෙවන ආකාරය', 'ඊළඟ පොලිය ලැබිය යුත්තේ', 'ආපසු ගෙවිය යුත්තේ', 'දින 4කට පෙර', 'සියලු විස්තර පිටපත් කරන්න', 'ආයෝජනය', 'ණය']) expect(text, want).toContain(want);
        for (const same of ['LKR 500,000.00', '5 Nov 2026', 'INV-9990B2', 'DEB-96E5C2', '8001234567', 'Commercial Bank']) expect(text, same).toContain(same);
    });

    it('turns a refusal into the person\'s language, and the wait with it', () => {
        const si = makeT('si');
        expect(describeFailure(429, { error: 'Too many attempts. Please wait a while and try again.', retryAfterSec: 45 }, si)).toBe('උත්සාහ කිරීම් ඕනෑවට වඩා වැඩියි. කරුණාකර මද වේලාවක් රැඳී සිට නැවත උත්සාහ කරන්න. තත්පර 45කින් නැවත උත්සාහ කරන්න.');
        expect(describeFailure(429, { error: 'Too many attempts.', retryAfterSec: 900 }, si)).toBe('Too many attempts. මිනිත්තු 15කින් පමණ නැවත උත්සාහ කරන්න.');   // a sentence the table does not know stays as the server said it
        expect(describeFailure(500, null, si)).toBe('යම් දෝෂයක් සිදු විය. කරුණාකර නැවත උත්සාහ කරන්න.');
    });

    it('writes "as at" with the zone in the person\'s language', () => {
        expect(fmtAsOf('2026-10-05T05:00:00.000Z', makeT('si'))).toBe('5 Oct 2026, 10:30 (ශ්‍රී ලංකා වේලාව)');
    });

    it('turns an account into plain lines for pasting into a banking app or a message', () => {
        expect(accountText(acct)).toBe('Bank: Commercial Bank\nAccount name: N. Perera\nAccount number: 8001234567\nBranch: Colombo 03\nSWIFT / IBAN: CCEYLKLX');
        expect(accountText({ bank: 'B', holder: 'H', number: '12345' })).toBe('Bank: B\nAccount name: H\nAccount number: 12345');
        expect(accountText(null)).toBe('Bank: \nAccount name: \nAccount number: ');
        expect(accountText(acct, makeT('si'))).toContain('ගිණුම් අංකය: 8001234567');
    });
});

describe('what a person can do with the statement', () => {
    const acct = { bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567' };
    const base = {
        asOf: '2026-10-05T05:00:00.000Z',
        groups: [
            { kind: 'investment', ref: 'INV-9990B2', currency: 'LKR', capital: 500000, ratePct: 24, frequency: 'monthly', interestPerPeriod: 10000, start: '2026-01-05', end: '2027-01-05', nextInterest: { date: '2026-10-12', amount: 10000 }, totalReceived: 10000, payments: [] },
            { kind: 'loan', ref: 'DEB-96E5C2', currency: 'LKR', lent: 50000, repaid: 20000, outstanding: 30000, status: 'open', due: '2026-10-01', overdueDays: 4, events: [] },
        ],
        totals: [{ currency: 'LKR', invested: 500000, interestReceived: 10000, loanOutstanding: 30000 }],
        lenders: [{ n: 1, accounts: [acct] }], lenderCount: 1, truncated: false,
    };
    const textOf = (nodes) => nodes.map((n) => n.textContent).join(' | ');
    const find = (nodes, pick) => { const out = []; nodes.forEach((n) => n.walk((e) => { if (pick(e)) out.push(e); })); return out; };

    it('lists what is coming up, soonest first, with the days left and how late', () => {
        const text = textOf(statementView(doc, base));
        expect(text).toContain('Coming up');
        expect(text).toContain('Pay your loan1 Oct 2026 · DEB-96E5C2LKR 30,000.004 days overdue');
        expect(text).toContain('Interest expected12 Oct 2026 · INV-9990B2LKR 10,000.00In 7 days');
        expect(text.indexOf('4 days overdue')).toBeLessThan(text.indexOf('In 7 days'));
        const none = structuredClone(base); none.groups[0].nextInterest = null; none.groups[1].due = '';
        expect(textOf(statementView(doc, none))).not.toContain('Coming up');
    });

    it('has an add-to-calendar button for each date and a jump to where to pay only when the page can do them', () => {
        expect(find(statementView(doc, base), (e) => e.tag === 'button')).toHaveLength(0);
        const added = []; const jumped = [];
        const nodes = statementView(doc, base, makeT('en'), { calendar: (it) => added.push(it.ref), jump: (id) => jumped.push(id) });
        const buttons = find(nodes, (e) => e.tag === 'button');
        expect(buttons.map((b) => b.textContent)).toEqual(['Add to calendar', 'Add to calendar', 'How to pay']);
        buttons.forEach((b) => b.listeners.click());
        expect(added).toEqual(['DEB-96E5C2', 'INV-9990B2']);
        expect(jumped).toEqual(['tp-pay']);
        expect(find(nodes, (e) => e.attrs.id === 'tp-pay')).toHaveLength(1);
    });

    it('shows how much of a loan is repaid and how far an investment is through its term, as native progress bars', () => {
        const bars = find(statementView(doc, base), (e) => e.tag === 'progress');
        expect(bars.map((b) => [b.attrs.value, b.attrs['aria-label']])).toEqual([['75', 'Term: 75% complete'], ['40', '40% repaid']]);
        const open = structuredClone(base); open.groups[0].end = ''; open.groups[1].lent = 0;
        expect(find(statementView(doc, open), (e) => e.tag === 'progress')).toHaveLength(0);
    });

    it('puts the earlier rows of a long table behind one button, keeping every row in the page', () => {
        const long = structuredClone(base);
        long.groups[1].events = Array.from({ length: 12 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, kind: 'repayment', amount: 100, balance: 30000 - i * 100 }));
        const nodes = statementView(doc, long);
        const rows = find(nodes, (e) => e.tag === 'tr' && e.attrs.class === 'tp-early');
        expect(rows).toHaveLength(4);
        expect(rows.every((r) => 'hidden' in r.attrs)).toBe(true);
        expect(find(nodes, (e) => e.tag === 'tr' && !('hidden' in e.attrs)).length).toBe(1 + 8);   // the loan table's header and its 8 latest rows
        const more = find(nodes, (e) => e.tag === 'button' && /Show all/.test(e.textContent));
        expect(more.map((b) => b.textContent)).toEqual(['Show all 12']);
        const short = structuredClone(base);
        short.groups[1].events = long.groups[1].events.slice(0, 8);
        expect(find(statementView(doc, short), (e) => e.tag === 'button')).toHaveLength(0);
    });
});
