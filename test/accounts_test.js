/* =============================================================================
 * test/accounts_test.js
 * -----------------------------------------------------------------------------
 * wealthflow-accounts.js decides which of the user's accounts a statement
 * belongs to — HNB credit card or HNB current account — which decides whether
 * its rows become card charges or bank transactions.
 *
 * THE REGISTRY IS LEARNED, BECAUSE THERE WAS NONE TO READ.
 *
 * The design this replaces was "look the account up in settings". There is no
 * such setting: `BANKS` in index.html is a static list of fifteen bank NAMES for
 * a picker, `card_last4` is stored per TRANSACTION, and `_ccotPickBankAsync()`
 * is a modal that asks which bank before every scan. A matcher written against
 * that imaginary registry would never match anything, silently. So derive()
 * builds the registry from records the user already has, and the first test
 * below is that it finds accounts in a ledger that was never configured.
 *
 * AND WHY 95% IS REACHABLE HERE WHEN IT IS NOT IN THE ROUTER.
 *
 * wealthflow-statement-router.js tops out at 0.92, so a 95% gate there
 * quarantines everything. Here three INDEPENDENT signals can agree — digits
 * from the statement body, bank from a DKIM-verified sender, product from the
 * statement's own vocabulary — and their agreement is a stronger claim than any
 * one of them. The tests pin both directions: all three agreeing must clear the
 * bar, and any one alone must not.
 *
 * A CONTRADICTION IS NOT A MISSING SIGNAL.
 *
 * The case worth most attention is wording that says "credit card" on a
 * statement matched to an account recorded as a current account. Two signals
 * agree and one disagrees. An implementation that only ADDS for agreement
 * scores that highly and routes it. It must not.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import A, {
    CREDIT_CARD, BANK_ACCOUNT, MATCH, MATCH_TEXT, CONFIDENT,
    last4Of, derive, kindFromText, last4InText, matchAccount, score, resolve,
} from '../wealthflow-accounts.js';

const HNB = 'Hatton National Bank (HNB)';
const NTB = 'Nations Trust Bank (NTB) — AMEX';

/** A ledger nobody configured — just card charges the user saved over time. */
const LEDGER = () => ({
    cconetime: [
        { bank: HNB, card_last4: '4471', amount: 5000 },
        { bank: HNB, card_last4: '4471', amount: 2000 },
        { bank: HNB, card_last4: '4471', amount: 900 },
        { bank: NTB, card_last4: '8802', amount: 12000 },
    ],
    ccinstall: [{ bank: NTB, card_last4: '8802', total: 144000 }],
    ccPayments: [{ bank: HNB, card_last4: '4471', amount: 10000 }],
    accounts: [{ bank: 'DFCC Bank', last4: '1234', kind: BANK_ACCOUNT }],
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE REGISTRY NOBODY TYPED IN
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the account list is learned from records that already exist', () => {
    it('finds accounts in a ledger that was never configured', () => {
        const got = derive(LEDGER());
        expect(got).toHaveLength(3);
        expect(got.map((a) => `${a.last4}:${a.kind}`).sort())
            .toEqual(['1234:bank-account', '4471:credit-card', '8802:credit-card']);
    });

    it('counts how often each is seen', () => {
        // An account named once could be a typo in a single row; one named
        // ninety times is a fact. The score uses this, so it has to be real.
        const seen = Object.fromEntries(derive(LEDGER()).map((a) => [a.last4, a.seen]));
        expect(seen).toEqual({ 4471: 4, 8802: 2, 1234: 1 });
    });

    /* The two ordering tests below use fixtures whose INSERTION order is the
     * reverse of the order derive() must return. The earlier version of this
     * test asserted [4, 2, 1] against LEDGER — where the accounts happen to be
     * written most-seen-first — so deleting the sort altogether still produced
     * [4, 2, 1] and the test passed. A test no mutation can fail is testing
     * nothing; the fixture has to be capable of coming out wrong. */
    it('returns the most-seen account first, whatever order the records are in', () => {
        const got = derive({
            cconetime: [
                { bank: 'Zenith Bank', card_last4: '0001' },
                { bank: 'Commercial Bank', card_last4: '0002' },
                { bank: 'Commercial Bank', card_last4: '0002' },
                { bank: 'Amana Bank', card_last4: '0003' },
                { bank: 'Amana Bank', card_last4: '0003' },
                { bank: 'Amana Bank', card_last4: '0003' },
            ],
        });
        expect(got.map((a) => a.last4), 'written least-seen-first, so an unsorted result reads 0001 first')
            .toEqual(['0003', '0002', '0001']);
        expect(got.map((a) => a.seen)).toEqual([3, 2, 1]);
    });

    it('breaks a tie on bank name, not on which record was written first', () => {
        /* Two accounts seen the same number of times must come back in a
         * stable, explainable order. Array.prototype.sort is stable, so a
         * count-only comparator leaves ties in ledger order — which changes
         * every time the user spends, and with it the account the Quarantine
         * Zone pre-selects. */
        const got = derive({
            cconetime: [
                { bank: 'Sampath Bank', card_last4: '7777' },
                { bank: 'Amana Bank', card_last4: '8888' },
            ],
        });
        expect(got.map((a) => a.bank)).toEqual(['Amana Bank', 'Sampath Bank']);
    });

    it('records which arrays it learned each one from', () => {
        const hnb = derive(LEDGER()).find((a) => a.last4 === '4471');
        expect(hnb.sources).toEqual(['ccPayments', 'cconetime']);
    });

    it('treats anything stored as a card charge as a card, with no inference', () => {
        // The kind comes from WHERE it was stored, not from guessing at the name.
        for (const src of ['cconetime', 'ccinstall', 'ccPayments']) {
            expect(derive({ [src]: [{ bank: HNB, card_last4: '1111' }] })[0].kind).toBe(CREDIT_CARD);
        }
    });

    it('does not invent a bank account out of a loan or an income row', () => {
        /* Those carry a bank name and no account number. Deriving an account
         * from them would populate the registry with entries that can never
         * match a statement, and every near-miss after that is a wrong route. */
        const got = derive({
            loans: [{ bank: HNB, name: 'Home loan', amount: 100 }],
            income: [{ company: HNB, monthly: 5 }],
        });
        expect(got).toEqual([]);
    });

    it('refuses half an identity', () => {
        expect(derive({ cconetime: [{ bank: HNB }] })).toEqual([]);
        expect(derive({ cconetime: [{ card_last4: '4471' }] })).toEqual([]);
        expect(derive({ cconetime: [{ bank: '', card_last4: '4471' }] })).toEqual([]);
    });

    it('survives an empty or malformed ledger', () => {
        for (const bad of [null, undefined, {}, { cconetime: null }, { cconetime: [null, undefined] }]) {
            expect(derive(bad)).toEqual([]);
        }
    });

    it('does not merge a card and a bank account that share digits at one bank', () => {
        // They are different accounts; collapsing them would route one as the
        // other. Ambiguity is handled at match time, not by pretending here.
        const got = derive({
            cconetime: [{ bank: HNB, card_last4: '4471' }],
            accounts: [{ bank: HNB, last4: '4471', kind: BANK_ACCOUNT }],
        });
        expect(got).toHaveLength(2);
    });
});

describe('reading four digits off a number', () => {
    it.each([
        ['4471', '4471'],
        ['**** **** **** 4471', '4471'],
        ['001234567890', '7890'],
        ['123', ''],
        ['', ''],
        [null, ''],
    ])('%s -> %s', (input, want) => {
        expect(last4Of(input)).toBe(want);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS AN ACCOUNT NUMBER ON A PAGE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('finding account numbers in statement text', () => {
    it.each([
        ['a masked card number', 'Card Number: **** **** **** 4471', ['4471']],
        ['an X-masked one', 'Card No XXXX-XXXX-XXXX-8802', ['8802']],
        ['bullets', 'Card ••8802 Minimum Due', ['8802']],
        ['a long account number', 'Account 001234567890 statement', ['7890']],
    ])('reads %s', (_why, text, want) => {
        expect(last4InText(text)).toEqual(want);
    });

    it('does NOT treat a bare four-digit number as an account', () => {
        /* THE CASE THAT MISFILES A STATEMENT. A page is full of years, amounts
         * and reference numbers. If any run of four digits could be an account,
         * "Statement for 2026" and a total of "4471.00" both become account
         * numbers, and the statement is filed against whichever one happens to
         * be in the registry. */
        expect(last4InText('Statement for 2026, total 4471.00, ref 9912')).toEqual([]);
    });

    it('collects several and bounds how many', () => {
        const text = Array.from({ length: 20 }, (_, i) => `**** ${String(1000 + i)}`).join(' ');
        expect(last4InText(text).length).toBeLessThanOrEqual(8);
    });

    it('returns nothing for nothing', () => {
        for (const bad of ['', null, undefined]) expect(last4InText(bad)).toEqual([]);
    });
});

describe('what the statement says it is', () => {
    it('reads card vocabulary', () => {
        expect(kindFromText('Credit Limit 500,000  Minimum Amount Due 12,000')).toBe(CREDIT_CARD);
    });

    it('reads bank vocabulary', () => {
        expect(kindFromText('Opening Balance ... Withdrawals ... Closing Balance')).toBe(BANK_ACCOUNT);
    });

    it('refuses when BOTH vocabularies appear', () => {
        /* A combined statement, or a card statement quoting a settlement
         * account, is exactly when guessing is worst. Returning null lets the
         * other two signals decide instead of inventing a tie-break. */
        expect(kindFromText('Credit Limit 500,000 ... Opening Balance 12,000')).toBe(null);
    });

    it('refuses when neither appears', () => {
        expect(kindFromText('Dear customer, your statement is attached.')).toBe(null);
        expect(kindFromText('')).toBe(null);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MATCH
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('matching a statement to an account', () => {
    const accounts = derive(LEDGER());

    it('matches on the digits and reports what agreed', () => {
        const m = matchAccount({ bank: 'HNB', text: 'Card **** **** **** 4471 Credit Limit' }, accounts);
        expect(m.ok).toBe(true);
        expect(m.account).toMatchObject({ last4: '4471', kind: CREDIT_CARD });
        expect(m.evidence).toMatchObject({ last4: true, bank: true, textAgrees: true });
    });

    it.each([
        ['no accounts are known yet', [], { bank: 'HNB', text: '**** 4471' }, MATCH.NO_ACCOUNTS],
        ['the statement prints no number', accounts, { bank: 'HNB', text: 'Your statement is attached' }, MATCH.NO_LAST4],
        ['the digits are not on file', accounts, { bank: 'HNB', text: '**** 9999' }, MATCH.UNKNOWN_LAST4],
        ['the digits belong to another bank', accounts, { bank: 'DFCC', text: '**** 4471' }, MATCH.BANK_MISMATCH],
    ])('refuses when %s', (_why, accs, statement, reason) => {
        const m = matchAccount(statement, accs);
        expect(m.ok).toBe(false);
        expect(m.reason).toBe(reason);
    });

    it('refuses rather than picking when two of the user’s own accounts share digits', () => {
        /* Four digits are not unique, and two of the SAME person's accounts
         * ending 4471 is the only collision that matters. Taking the first is
         * how a year of card spending lands in a current account. */
        const dup = derive({
            cconetime: [{ bank: HNB, card_last4: '4471' }],
            accounts: [{ bank: HNB, last4: '4471', kind: BANK_ACCOUNT }],
        });
        const m = matchAccount({ bank: 'HNB', text: '**** 4471 Credit Limit' }, dup);
        expect(m.ok).toBe(false);
        expect(m.reason).toBe(MATCH.AMBIGUOUS);
        expect(m.detail.candidates).toHaveLength(2);
    });

    it('uses the bank to break what would otherwise be ambiguous', () => {
        // Same digits at two DIFFERENT banks is resolvable, because the sender
        // is verified. Same digits at the SAME bank is not.
        const two = derive({
            cconetime: [{ bank: HNB, card_last4: '4471' }, { bank: NTB, card_last4: '4471' }],
        });
        const m = matchAccount({ bank: 'Nations Trust', text: '**** 4471' }, two);
        expect(m.ok).toBe(true);
        expect(m.account.bank).toBe(NTB);
    });

    it('still matches with no sender at all, but records that the bank did not agree', () => {
        const m = matchAccount({ bank: '', text: '**** 4471 Credit Limit' }, accounts);
        expect(m.ok).toBe(true);
        expect(m.evidence.bank).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SCORE, AND THE BAR
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the confidence is built from agreement, not asserted', () => {
    const accounts = derive(LEDGER());
    const at = (statement) => resolve(statement, accounts);

    it('clears 95% only when all three independent signals agree', () => {
        const r = at({ bank: 'HNB', text: 'Card **** **** **** 4471  Credit Limit 500,000  Minimum Amount Due' });
        expect(r.ok).toBe(true);
        expect(r.confidence).toBeGreaterThanOrEqual(CONFIDENT);
    });

    it('falls short on two signals, however strong they look', () => {
        const r = at({ bank: 'HNB', text: 'Card **** **** **** 4471 transactions follow' });
        expect(r.ok).toBe(false);
        expect(r.confidence).toBeLessThan(CONFIDENT);
        expect(r.confidence).toBeGreaterThan(0.8);
    });

    it('falls further on one', () => {
        const digitsOnly = at({ bank: '', text: 'Card **** **** **** 4471 transactions follow' });
        const digitsAndBank = at({ bank: 'HNB', text: 'Card **** **** **** 4471 transactions follow' });
        expect(digitsOnly.confidence).toBeLessThan(digitsAndBank.confidence);
        expect(digitsOnly.ok).toBe(false);
    });

    it('a CONTRADICTION drops it far below the bar, not merely short of it', () => {
        /* Two signals agree and one disagrees. An implementation that only adds
         * for agreement scores this high and routes it. The wording says this
         * is a current account; the registry says the digits are a credit card.
         * One of them is wrong and neither is trusted. */
        const r = at({ bank: 'HNB', text: '**** 4471 Opening Balance Withdrawals Closing Balance' });
        expect(r.ok).toBe(false);
        expect(r.confidence).toBeLessThan(0.6);
    });

    it('is monotone: adding an agreeing signal never lowers it', () => {
        const base = score({ last4: true });
        expect(score({ last4: true, bank: true })).toBeGreaterThan(base);
        expect(score({ last4: true, bank: true, textAgrees: true }))
            .toBeGreaterThan(score({ last4: true, bank: true }));
        expect(score({ last4: true, bank: true, textAgrees: true, seen: 5 }))
            .toBeGreaterThanOrEqual(score({ last4: true, bank: true, textAgrees: true }));
    });

    it('never claims certainty', () => {
        expect(score({ last4: true, bank: true, textAgrees: true, seen: 999 })).toBeLessThan(1);
    });

    it('never goes below zero, whatever disagrees', () => {
        expect(score({ textAgrees: false })).toBeGreaterThanOrEqual(0);
        expect(score(null)).toBe(0);
    });

    it('lets the caller move the bar without touching the arithmetic', () => {
        const st = { bank: 'HNB', text: 'Card **** 4471 transactions follow' };
        expect(resolve(st, accounts, { confident: 0.99 }).ok).toBe(false);
        expect(resolve(st, accounts, { confident: 0.5 }).ok).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE-TAP REVIEW
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a refusal carries its best answer, so review is one tap', () => {
    const accounts = derive(LEDGER());

    it('pre-selects the most likely account when it is merely not sure enough', () => {
        const r = resolve({ bank: 'HNB', text: 'Card **** 4471 transactions follow' }, accounts);
        expect(r.ok).toBe(false);
        expect(r.suggestion).toEqual({ bank: HNB, last4: '4471', kind: CREDIT_CARD });
        expect(r.confidence).toBeGreaterThan(0);
        expect(r.bar).toBe(CONFIDENT);
    });

    it('offers nothing when there is genuinely nothing to offer', () => {
        // Suggesting an account for digits that match nothing would be a guess
        // dressed as a recommendation.
        const r = resolve({ bank: 'HNB', text: '**** 9999' }, accounts);
        expect(r.suggestion).toBeUndefined();
        expect(r.confidence).toBe(0);
    });

    it('every refusal reason has a sentence', () => {
        const reasons = [...Object.values(MATCH), 'below-the-confidence-bar'];
        expect(Object.keys(MATCH_TEXT).sort()).toEqual(reasons.sort());
    });
});

describe('the module surface', () => {
    it('decides — it never writes', () => {
        for (const k of Object.keys(A)) {
            expect(k, `${k} reads like it mutates`).not.toMatch(/^(save|write|set|apply|commit|delete)/);
        }
    });

    it('never reads the clock or the DOM', () => {
        const src = A.derive.toString() + A.resolve.toString() + A.matchAccount.toString();
        expect(src).not.toMatch(/Date\.now|new Date|document\.|localStorage/);
    });
});
