/* test/card_cashback_test.js — cashback on a credit card is a reward, not a payment.
 * The bank pays the cashback into the owner's bank account (that statement files it as income). Where a card statement prints it too, it must never fill the payment pool, settle a charge,
 * lower what the card owes or its minimum. A line that also says payment / thank you is a payment whatever else it says. Names and figures are invented. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isCardCashback, routeRow } from '../wealthflow-statement-router.js';
import { deterministicDecision } from '../statement-sync.js';
import { validateSettlementRow } from '../statement-ledger.mjs';
import { settleCards, isCashbackCredit } from '../cc-fifo.mjs';
import { statementSelfAudit } from '../wf-statement-self-audit.mjs';
import cardTabs from '../wealthflow-card-tabs.js';

const CARD = { statementType: 'credit_card', card_last4: '1234', bank: 'Nations Trust Bank' };
const cardCredit = (description, amount = 1000) => ({ date: '2026-10-28', description, amount, direction: 'credit', directionSource: 'marker', needsReview: false, valid: true });

const WORDS = [
    ['CASHBACK ON YOUR OCT NETFLIX SUBSCRIPTION', true], ['Cash Back credit Oct', true], ['REBATE FOR FUEL PURCHASE', true],
    ['PAYMENT - THANK YOU', false], ['ONLINE PAYMENT RECEIVED', false], ['CASHBACK PAYMENT TO CARD', false], ['CASH PAYMENT FINACLE', false], ['MERCHANT REFUND', false], ['', false],
];

describe('what counts as a card cashback', () => {
    for (const [text, expected] of WORDS) it(`"${text}" -> ${expected}`, () => expect(isCardCashback(text)).toBe(expected));
    it('the worker, the page reconcile and the card tabs read the same words', () => {
        const page = { window: {} };
        vm.runInNewContext(readFileSync(new URL('../wealthflow-cc-reconcile.js', import.meta.url), 'utf8'), page);
        for (const [text, expected] of WORDS) {
            expect(isCashbackCredit({ desc: text })).toBe(expected);
            expect(page.window.WFReconcile.isCashbackCredit({ desc: text })).toBe(expected);
        }
        expect(isCashbackCredit({ desc: 'anything', cashback: true })).toBe(true);
    });
});

describe('a card statement cashback is left out of the card\'s books', () => {
    it('routeRow skips it on a card, files it as income on a bank account, and still files a payment as a payment', () => {
        expect(routeRow(cardCredit('CASHBACK ON YOUR OCT NETFLIX SUBSCRIPTION'), CARD)).toMatchObject({ module: 'skip', subtype: 'cashback' });
        expect(routeRow({ ...cardCredit('CASHBACK ON YOUR OCT NETFLIX SUBSCRIPTION'), statementType: 'savings' }, { statementType: 'savings' }).module).toBe('income');
        expect(routeRow(cardCredit('PAYMENT - THANK YOU', 5000), CARD).module).toBe('cc_payment');
    });
    it('the worker decides it deterministically, and the ledger accepts that only for a card credit', () => {
        const row = cardCredit('CASHBACK ON YOUR OCT NETFLIX SUBSCRIPTION');
        const decision = deterministicDecision(row, CARD);
        expect(decision).toMatchObject({ module: 'skip', cashback: true, verified: true });
        expect(validateSettlementRow(row, decision, CARD)).toBeNull();
        expect(validateSettlementRow({ ...row, description: 'KEELLS SUPER' }, decision, CARD)).toBe('cashback-requires-card-credit');
        expect(deterministicDecision(cardCredit('PAYMENT - THANK YOU', 5000), CARD)?.cashback).toBeUndefined();
    });
});

describe('a cashback already among the card payments never lowers what the card owes', () => {
    const user = (withCashback) => ({
        cconetime: [{ id: 'a', date: '2026-10-01', amount: 5000, bank: 'NTB', card_last4: '1234' }, { id: 'b', date: '2026-10-05', amount: 3000, bank: 'NTB', card_last4: '1234' }],
        ccPayments: [{ id: 'p1', date: '2026-10-20', amount: 5000, desc: 'PAYMENT - THANK YOU', bank: 'NTB', card_last4: '1234' },
            ...(withCashback ? [{ id: 'p2', date: '2026-10-28', amount: 3000, desc: 'CASHBACK ON YOUR OCT NETFLIX SUBSCRIPTION', bank: 'NTB', card_last4: '1234' }] : [])],
    });
    it('the walk gives the same answer with or without the cashback', () => {
        const without = settleCards(user(false)), withCb = settleCards(user(true));
        expect(withCb.cards[0].settled).toBe(without.cards[0].settled);
        expect(withCb.cards[0].carryCents).toBe(without.cards[0].carryCents);
        expect(withCb.cards[0].pending).toBe(1);   // the 3,000 charge is still unpaid: the cashback did not pay it
    });
    it('the minimum payment due is not lowered by it', () => {
        const dues = (payments) => cardTabs.dues([{ id: 'd', bank: 'NTB', card_last4: '1234', minimum: 2000, dueDate: '2026-11-20', statementEnd: '2026-10-25' }], payments, { today: '2026-11-05' });
        const paid = dues([{ date: '2026-10-28', amount: 1000, desc: 'CASHBACK ON YOUR OCT NETFLIX SUBSCRIPTION', bank: 'NTB', card_last4: '1234' }]);
        const none = dues([]);
        expect(paid[0].short).toBe(none[0].short);
    });
});

describe('the reader\'s self-audit is not alarmed by a card cashback', () => {
    it('a credit is never a debit-with-credit-wording finding', () => {
        expect(statementSelfAudit({ rows: [cardCredit('CASHBACK ON YOUR OCT NETFLIX SUBSCRIPTION')] })).toEqual([]);
    });
});
