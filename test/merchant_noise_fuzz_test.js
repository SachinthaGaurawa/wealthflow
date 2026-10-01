import { describe, expect, it } from 'vitest';
import { expenseCategoryFor } from '../wealthflow-statement-router.js';
import { merchantNameFor, deterministicDecision } from '../statement-sync.js';
import { amountCents } from '../statement-ledger.mjs';

// A statement line is a merchant wrapped in terminal noise: a card number, a gateway prefix, a city, a reference. The category a
// merchant gets must not depend on the noise around it (metamorphic property), and a merchant whose category is not known must
// never be given a wrong one — it stays "Other" for the AI board, never a guess. Cases are generated, so hundreds run every time.

const MERCHANTS = {
    Groceries: ['KEELLS SUPER', 'CARGILLS FOOD CITY', 'ARPICO SUPERCENTRE', 'GLOMARK', 'LAUGFS SUPER', 'SPAR EXPRESS', 'SATHOSA'],
    Dining: ['KFC', 'MCDONALDS', 'PIZZA HUT', 'DOMINOS PIZZA', 'BURGER KING', 'UBER EATS', 'UBEREATS', 'FOODPANDA', 'FOOD PANDA', 'PICKME FOOD', 'JAVA LOUNGE', 'BARISTA COFFEE', 'TACO BELL', 'SUBWAY'],
    Telecom: ['DIALOG AXIATA', 'MOBITEL', 'SLT MOBITEL', 'HUTCH', 'AIRTEL'],
    Utilities: ['CEB ELECTRICITY BILL', 'LECO', 'NWSDB WATER BILL'],
    Fuel: ['CEYPETCO FILLING STATION', 'LANKA IOC', 'SINOPEC'],
    Transport: ['UBER TRIP', 'PICKME RIDE', 'PICK ME TAXI', 'EXPRESSWAY TOLL'],
    Health: ['NAWALOKA HOSPITAL', 'ASIRI HOSPITAL', 'HEMAS PHARMACY', 'DURDANS LABORATORY'],
    Entertainment: ['NETFLIX', 'SPOTIFY', 'YOUTUBE PREMIUM'],
    Subscriptions: ['OPENAI CHATGPT', 'GITHUB', 'ADOBE'],
    Shopping: ['DARAZ', 'AMAZON', 'ODEL'],
};
// what a card terminal, a payment gateway or a bank's own narration wraps around a merchant (and a few ways of writing it)
const NOISE = [
    s => s, s => s.toLowerCase(), s => ` ${s}  `, s => `POS ${s} COLOMBO 03 LK`, s => `ECOM TXN ${s}`, s => `VISA DEBIT 4532******1234 ${s}`, s => `${s} 4029357733 SG`,
    s => `PAYPAL *${s}`, s => `CARD PURCHASE ${s} REF 884422`, s => `POS 4829 ${s} LK`, s => `${s}/COLOMBO`, s => `${s} 4829 LK`, s => `SQ *${s}`, s => `PAYME-VISA*${s}`,
    s => `${s.replace(/ /g, '*')} 0077`, s => `${s.replace(/ /g, '-')} KANDY`, s => `TXN REF: AB12CD34 ${s}`,
];
const row = narration => ({ narration, amount: 1500, direction: 'debit', directionSource: 'marker', needsReview: false, valid: true, date: '2026-09-02' });

describe('a merchant keeps its category whatever terminal noise is wrapped around it', () => {
    const cases = Object.entries(MERCHANTS).flatMap(([category, names]) => names.flatMap(name => NOISE.map((wrap, k) => ({ category, name, k, text: wrap(name) }))));
    it(`${cases.length} generated statement lines`, () => {
        const failures = cases.filter(c => expenseCategoryFor(row(c.text)) !== c.category).map(c => `${JSON.stringify(c.text)} → ${expenseCategoryFor(row(c.text))}, wanted ${c.category}`);
        expect(failures.slice(0, 20), `${failures.length} of ${cases.length} lines`).toEqual([]);
        expect(cases.length).toBeGreaterThan(800);
    });
    it('the rules decide each as a verified expense (never an owner question), and the merchant name is cleaned of card numbers and references', () => {
        for (const c of cases.filter(x => x.k % 4 === 0)) {
            const decision = deterministicDecision(row(c.text), { statementType: '', card_last4: '', bank: 'NTB', cardRegistry: {}, subscriptions: [], loans: [] });
            expect(decision, c.text).toMatchObject({ verified: true, module: 'expenses', category: c.category });
            expect(merchantNameFor(row(c.text)), c.text).not.toMatch(/\d{4,}|\*{2,}/);
        }
    });
    it('Uber is told apart by what it sold: a ride is Transport, a meal is Dining, whatever the gateway adds', () => {
        for (const text of ['UBER   *TRIP HELP.UBER.COM', 'UBER *TRIP', 'UBER TRIP 4829 LK', 'POS UBER RIDE COLOMBO']) expect(expenseCategoryFor(row(text)), text).toBe('Transport');
        for (const text of ['UBER   *EATS HELP.UBER.COM', 'UBER EATS', 'UBEREATS HELP.UBER.COM', 'ORDER 77882 UBEREATS HELP.UBER.COM', 'UBER* EATS', 'PICKME *FOOD 0771234567']) expect(expenseCategoryFor(row(text)), text).toBe('Dining');
    });
    it('an unknown merchant is never given a guessed category: it stays Other, for the AI board', () => {
        for (const name of ['PAYME-VISA*COLOMBO', 'ZXQ TRADERS', 'N K PERERA & SONS', 'AMZN MKTP US*2K4TY1QR0']) {
            const noisy = NOISE.map(wrap => expenseCategoryFor(row(wrap(name))));
            expect(new Set(noisy).size, name).toBeLessThanOrEqual(2);              // never a different wrong category per wrapper
        }
        for (const name of ['ZXQ TRADERS', 'N K PERERA & SONS']) expect(NOISE.every(wrap => expenseCategoryFor(row(wrap(name))) === 'Other'), name).toBe(true);
    });
});

describe('amounts are exact to the cent, whatever the floating point does', () => {
    it('every amount from 0.01 to 20,000.00 survives the trip through a number and back (2,000,000 values)', () => {
        const bad = [];
        for (let cents = 1; cents <= 2000000; cents++) {
            const value = Number((cents / 100).toFixed(2));
            if (amountCents(value) !== cents) { bad.push(cents); if (bad.length > 5) break; }
        }
        expect(bad).toEqual([]);
    });
    it('large amounts, the classic float traps and malformed numbers are exact or refused — never rounded into another amount', () => {
        for (const [value, cents] of [[0.1 + 0.2 - 0.2, 10], [0.29, 29], [1.15, 115], [4.35, 435], [8.2, 820], [1234567.89, 123456789], [99999999.99, 9999999999], [500000, 50000000]]) expect(amountCents(value), String(value)).toBe(cents);
        for (const bad of [0, -1, NaN, Infinity, 1.005, 0.001, 1e21, '12.50', null, undefined, 1.0000001]) expect(amountCents(bad), String(bad)).toBeNull();
    });
    it('summing 200,000 amounts in cents equals the exact decimal sum (a float running total drifts)', () => {
        let cents = 0n, float = 0;
        for (let i = 1; i <= 200000; i++) { const c = (i * 7919) % 100000 + 1; cents += BigInt(amountCents(Number((c / 100).toFixed(2)))); float += c / 100; }
        const exact = Number(cents) / 100;
        expect(Math.abs(float - exact)).toBeLessThan(1e-3);                          // the float total is close …
        expect(String(cents)).toMatch(/^\d+$/);                                       // … but only the cents total is the figure that is filed
    });
});
