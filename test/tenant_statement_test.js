/* =============================================================================
 * test/tenant_statement_test.js — what a tenant is shown, and what they are never shown
 * -----------------------------------------------------------------------------
 * The owner's document holds every private opinion of every person. The statement is built
 * by picking named figures, so the assertions are WHITELISTS: a field that is not on the
 * list below fails the test, whoever adds it and however innocently.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { buildStatement, recordsFor, MAX_RECORDS } from '../tenant-statement.mjs';
import { nicHashOf, phoneHashOf } from '../tenant-links.mjs';
import { normalizeNic } from '../wealthflow-nic.js';
import { SECRET, NIC, CANON, PHONE, T0, lenderDoc } from './helpers/tenant-fixture.js';

const nicHash = nicHashOf(CANON, SECRET);
const phoneHash = phoneHashOf('+94771234567', SECRET);
const build = (user, over = {}) => buildStatement({ ledgers: [{ uid: 'u', user, own: true }], nicHash, phoneHash, secret: SECRET, now: T0, ...over });

const INVESTMENT_KEYS = ['kind', 'ref', 'title', 'capital', 'ratePct', 'frequency', 'interestPerPeriod', 'start', 'end', 'nextInterest', 'payments', 'totalReceived', 'currency', 'lender'];
const LOAN_KEYS = ['kind', 'ref', 'title', 'lent', 'repaid', 'outstanding', 'status', 'due', 'overdueDays', 'events', 'currency', 'lender'];

describe('what is on it', () => {
    it('shows an investment and a loan, by whitelist, under generic titles and a reference code', () => {
        const st = build(lenderDoc());
        const [inv, loan] = st.groups;
        expect(Object.keys(inv).sort()).toEqual([...INVESTMENT_KEYS].sort());
        expect(Object.keys(loan).sort()).toEqual([...LOAN_KEYS].sort());
        expect(inv).toMatchObject({ kind: 'investment', title: 'Investment', capital: 500000, ratePct: 24, frequency: 'monthly', interestPerPeriod: 10000, currency: 'LKR' });
        expect(inv.ref).toMatch(/^INV-[0-9A-F]{6}$/);
        expect(loan).toMatchObject({ kind: 'loan', title: 'Loan', lent: 50000, repaid: 20000, outstanding: 30000, status: 'open' });
        expect(loan.ref).toMatch(/^DEB-[0-9A-F]{6}$/);
        expect(Object.keys(st).sort()).toEqual(['asOf', 'groups', 'lenderCount', 'lenders', 'totals', 'truncated']);
        expect(st.totals).toEqual([{ currency: 'LKR', invested: 500000, interestReceived: 10000, loanOutstanding: 30000 }]);
    });

    it('a loan has no interest on it: not zero, not hidden, not a field at all', () => {
        const user = lenderDoc();
        user.debtors[0].rate = 36; user.debtors[0].interest = 99; user.debtors[0].monthly = 5;
        const loan = build(user).groups.find((g) => g.kind === 'loan');
        expect(JSON.stringify(loan)).not.toMatch(/interest|rate|monthly|accru/i);
        expect(loan.events.every((e) => Object.keys(e).sort().join() === 'amount,balance,date,kind')).toBe(true);
    });

    it('carries no name, note, phone, NIC, company or record id from either kind of record', () => {
        const text = JSON.stringify(build(lenderDoc()));
        for (const leak of ['PRIVATE', 'Fixed deposit', NIC, CANON, '0771234567', '077 123 4567', '94771234567', 'inv1', 'deb1', 'e1', 'e2']) expect(text, leak).not.toContain(leak);
    });

    it('shows only what the owner confirmed: a repayment nobody verified is not on the statement, nor in the balance', () => {
        const loan = build(lenderDoc()).groups.find((g) => g.kind === 'loan');
        expect(loan.events.map((e) => [e.kind, e.amount, e.balance])).toEqual([['lent', 50000, 50000], ['repayment', 20000, 30000]]);
        expect(JSON.stringify(loan)).not.toContain('777');
    });

    it('lists payments the owner confirmed, not the bookkeeping marks for months before the tenant joined', () => {
        const user = lenderDoc({
            incomeReceived: {
                'inv1_2026-08': { amount: 10000, confirmedAt: T0 - 40 * 86400e3 },
                'inv1_2026-07': { amount: 10000, confirmedAt: T0 - 70 * 86400e3, auto: true },
                'inv1_2026-06': { amount: 10000, confirmedAt: T0 - 90 * 86400e3, historical: true },
                'inv1_2026-09': { amount: 10000 },                                           // never confirmed
                'inv1_2026-10': { confirmedAt: T0 - 1000 },                                  // amount defaults to the period's interest
                'inv2_2026-08': { amount: 99, confirmedAt: T0 },                              // someone else's record
                'inv1_notamonth': { amount: 5, confirmedAt: T0 },
            },
        });
        const inv = build(user).groups[0];
        expect(inv.payments.map((p) => [p.month, p.amount])).toEqual([['2026-08', 10000], ['2026-10', 10000]]);
        expect(inv.totalReceived).toBe(20000);
        expect(inv.payments[0].date).toBe('2026-08-26');
    });

    it('is the same arithmetic the text messages use for a closed or settled loan', () => {
        const user = lenderDoc();
        user.debtors[0].events.push({ id: 'e4', kind: 'repayment', amount: 30000, date: '2026-09-25', confirmed: true });
        expect(build(user).groups.find((g) => g.kind === 'loan')).toMatchObject({ outstanding: 0, status: 'settled' });
        const closed = lenderDoc(); closed.debtors[0].closedAt = 5;
        expect(build(closed).groups.find((g) => g.kind === 'loan')).toMatchObject({ outstanding: 30000, status: 'closed' });
    });

    it('keeps currencies apart and totals each of them', () => {
        const usd = lenderDoc(); usd.settings.currency = 'usd';
        const st = buildStatement({ ledgers: [{ uid: 'a', user: lenderDoc(), own: true }, { uid: 'b', user: usd, own: true }], nicHash, phoneHash, secret: SECRET, now: T0 });
        expect(st.totals.map((t) => t.currency).sort()).toEqual(['LKR', 'USD']);
        expect(st.totals.every((t) => t.loanOutstanding === 30000 && t.invested === 500000)).toBe(true);
    });
});

describe('which records', () => {
    const rec = (over) => ({ id: 'r', nic: NIC, phone: PHONE, sms_notifications_enabled: true, ...over });

    it('only those switched on, and only those under this NIC, in either shape', () => {
        const user = { income: [rec({ id: 'on' }), rec({ id: 'off', sms_notifications_enabled: false }), rec({ id: 'str', sms_notifications_enabled: 'true' }), rec({ id: 'other', nic: '198534000999' }), rec({ id: 'none', nic: '' }), rec({ id: 'new', nic: '198534000937' }), { ...rec({}), id: '' }], debtors: [] };
        expect(recordsFor(user, { nicHash, phoneHash, secret: SECRET, own: true }).investments.map((r) => r.id)).toEqual(['on', 'new']);
    });

    it('for another lender, also the phone the code went to', () => {
        const user = { income: [], debtors: [rec({ id: 'same' }), rec({ id: 'diff', phone: '0719999999' }), rec({ id: 'nophone', phone: '' })] };
        expect(recordsFor(user, { nicHash, phoneHash, secret: SECRET, own: false }).debtors.map((r) => r.id)).toEqual(['same']);
        expect(recordsFor(user, { nicHash, phoneHash: '', secret: SECRET, own: false }).debtors).toEqual([]);          // no verified phone, nothing from anyone else
        expect(recordsFor(user, { nicHash, phoneHash, secret: SECRET, own: true }).debtors).toHaveLength(3);
    });

    it('survives a document that is not what it should be', () => {
        for (const user of [null, undefined, {}, { income: 'x', debtors: 5 }, { income: [null, 1, 'a', {}], debtors: [null, {}], incomeReceived: 7, settings: null }]) {
            expect(() => build(user)).not.toThrow();
            expect(build(user).groups).toEqual([]);
        }
        const odd = lenderDoc({ incomeReceived: null });
        odd.income[0].amount = 'lots'; odd.income[0].rate = NaN; odd.income[0].freq = '<img onerror=x>';
        const inv = build(odd).groups[0];
        expect(inv.capital).toBe(0);
        expect(inv.frequency).toBe('monthly');
    });

    it('is cut at a sane size and says so', () => {
        const income = Array.from({ length: MAX_RECORDS + 50 }, (_, i) => ({ id: `i${i}`, nic: NIC, phone: PHONE, amount: 1, rate: 1, start: '2026-01-01', sms_notifications_enabled: true }));
        const st = build({ income, debtors: [] });
        expect(st.groups).toHaveLength(MAX_RECORDS);
        expect(st.truncated).toBe(true);
    });

    it('lists the same records in the same order every time', () => {
        const a = build(lenderDoc());
        const b = build(lenderDoc());
        expect(a).toEqual(b);
        expect(a.groups.map((g) => g.kind)).toEqual(['investment', 'loan']);
        void normalizeNic;
    });
});

describe('when', () => {
    it('an investment says when its next interest is due, and how much, from the lender\'s own dates', () => {
        const user = lenderDoc(); user.income[0].day = '2026-01-05';
        const inv = build(user).groups[0];
        // T0 is 5 Oct 2026 (Sri Lanka time 10:30): the investment pays on the 5th, so today still counts
        expect(inv.nextInterest).toEqual({ date: '2026-10-05', amount: 10000 });
        const later = build(user, { now: Date.parse('2026-10-06T05:00:00Z') }).groups[0];
        expect(later.nextInterest).toEqual({ date: '2026-11-05', amount: 10000 });
    });

    it('a quarterly investment skips the months it does not pay in, and a short month pays on its last day', () => {
        const user = lenderDoc(); user.income[0].freq = 'quarterly'; user.income[0].day = '2026-01-31'; delete user.income[0].monthly;
        const g = build(user, { now: Date.parse('2026-10-06T05:00:00Z') }).groups[0];
        expect(g.nextInterest).toEqual({ date: '2026-10-31', amount: 30000 });
        const after = build(user, { now: Date.parse('2026-11-02T05:00:00Z') }).groups[0];
        expect(after.nextInterest).toEqual({ date: '2027-01-31', amount: 30000 });                       // November and December are not payment months
        const feb = lenderDoc(); feb.income[0].day = '2026-01-31';
        expect(build(feb, { now: Date.parse('2027-02-05T05:00:00Z') }).groups[0].nextInterest.date).toBe('2027-02-28');
    });

    it('an investment that has ended, or whose books do not say, has no next date', () => {
        const ended = lenderDoc(); ended.income[0].end = '2026-09-30';
        expect(build(ended).groups[0].nextInterest).toBeNull();
        const none = lenderDoc(); none.income[0].amount = 0; delete none.income[0].monthly;
        expect(build(none).groups[0].nextInterest).toBeNull();
    });

    it('a loan carries the date it is expected back only while money is owed, and how many days late', () => {
        const user = lenderDoc(); user.debtors[0].dueISO = '2026-10-01';
        expect(build(user).groups.find((g) => g.kind === 'loan')).toMatchObject({ due: '2026-10-01', overdueDays: 4 });
        user.debtors[0].dueISO = '2026-10-20';
        expect(build(user).groups.find((g) => g.kind === 'loan')).toMatchObject({ due: '2026-10-20', overdueDays: 0 });
        user.debtors[0].events.push({ id: 'e4', kind: 'repayment', amount: 30000, date: '2026-09-25', confirmed: true });
        expect(build(user).groups.find((g) => g.kind === 'loan')).toMatchObject({ due: '', overdueDays: 0 });          // paid: nothing to be late on
        const none = lenderDoc();
        expect(build(none).groups.find((g) => g.kind === 'loan')).toMatchObject({ due: '', overdueDays: 0 });
        none.debtors[0].dueISO = '<img onerror=x>';
        expect(build(none).groups.find((g) => g.kind === 'loan').due).toBe('');
    });
});

describe('where to pay', () => {
    const acct = (over) => ({ id: 'a1', bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'Quote your reference', showTo: 'both', active: true, createdAt: '2026-01-01', _ut: 5, ...over });
    const withAccounts = (accounts, over = {}) => lenderDoc({ payAccounts: accounts, ...over });

    it('shows the lender\'s account to an investor and a debtor, as six plain fields and nothing else', () => {
        const st = build(withAccounts([acct()]));
        expect(st.lenders).toEqual([{ n: 1, accounts: [{ bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'Quote your reference' }] }]);
        expect(Object.keys(st.lenders[0].accounts[0]).sort()).toEqual(['bank', 'branch', 'holder', 'note', 'number', 'swift']);
        expect(JSON.stringify(st)).not.toMatch(/showTo|active|createdAt|_ut|"id":"a1"/);
        expect(st.groups.every((g) => g.lender === 1)).toBe(true);
        expect(st.lenderCount).toBe(1);
    });

    it('an account meant for debtors is not shown to someone who is only an investor, and the other way round', () => {
        const user = (accounts, keep) => { const u = withAccounts(accounts); if (keep === 'inv') u.debtors = []; if (keep === 'loan') u.income = []; return u; };
        const accounts = [acct({ id: 'd', number: '1111111111', showTo: 'debtors', createdAt: '2026-01-01' }), acct({ id: 'i', number: '2222222222', showTo: 'investors', createdAt: '2026-01-02' }), acct({ id: 'b', number: '3333333333', showTo: 'both', createdAt: '2026-01-03' })];
        const numbers = (st) => (st.lenders[0] ? st.lenders[0].accounts.map((a) => a.number) : []);
        expect(numbers(build(user(accounts, 'inv')))).toEqual(['2222222222', '3333333333']);
        expect(numbers(build(user(accounts, 'loan')))).toEqual(['1111111111', '3333333333']);
        expect(numbers(build(user(accounts)))).toEqual(['1111111111', '2222222222', '3333333333']);       // both kinds of record: both accounts
    });

    it('a switched-off account, a damaged one and a missing list show nothing', () => {
        expect(build(withAccounts([acct({ active: false })])).lenders).toEqual([]);
        expect(build(withAccounts([acct({ number: '' }), acct({ id: 'x', bank: '' }), null, 5, 'a'])).lenders).toEqual([]);
        expect(build(withAccounts('nope')).lenders).toEqual([]);
        expect(build(lenderDoc()).lenders).toEqual([]);
    });

    it('free text in an account is never trusted: control characters are squashed and it is cut to length', () => {
        const st = build(withAccounts([acct({ holder: 'A\u0000B\n\tC', note: 'x'.repeat(500) })]));
        expect(st.lenders[0].accounts[0].holder).toBe('A B C');
        expect(st.lenders[0].accounts[0].note).toHaveLength(200);
    });

    it('another lender\'s accounts come with that lender\'s records only, numbered, and a lender with none of this person\'s records shows nothing', () => {
        const other = withAccounts([acct({ id: 'o', bank: 'People\'s Bank', number: '9999999999' })]);
        const mine = withAccounts([acct()]);
        const stranger = withAccounts([acct({ id: 's', bank: 'Stranger Bank', number: '5555555555' })], { income: [], debtors: [] });
        const st = buildStatement({ ledgers: [{ uid: 'a', user: mine, own: true }, { uid: 'b', user: other, own: false }, { uid: 'c', user: stranger, own: false }], nicHash, phoneHash, secret: SECRET, now: T0 });
        expect(st.lenderCount).toBe(2);
        expect(st.lenders.map((l) => [l.n, l.accounts[0].bank])).toEqual([[1, 'Commercial Bank'], [2, 'People\'s Bank']]);
        expect(JSON.stringify(st)).not.toContain('Stranger Bank');
        // a record from lender 2 is filed under lender 2 (it needs the phone the code went to)
        expect(new Set(st.groups.map((g) => g.lender))).toEqual(new Set([1, 2]));
    });

    it('at most ten accounts per lender', () => {
        const many = Array.from({ length: 15 }, (_, i) => acct({ id: `m${i}`, number: `70000000${String(i).padStart(2, '0')}` }));
        expect(build(withAccounts(many)).lenders[0].accounts).toHaveLength(10);
    });
});
