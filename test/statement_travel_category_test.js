import { describe, it, expect } from 'vitest';
import '../statement-merchants.mjs';
import { expenseCategoryFor, CLASSIFY_CATEGORIES } from '../wealthflow-statement-router.js';
import { namedCardCategory } from '../statement-sync.js';

/* Travel used to be a category the app has (index.html) and the statement server did not: flights, hotels and booking sites came out as "Other" (a row waiting for the
 * owner) or, for the national airline, as Transport. Only public brand names and generic words are used here: no card numbers, no amounts, no personal narrations. */
const category = description => expenseCategoryFor({ description });

describe('Travel on the statement server', () => {
    it('is part of the vocabulary the AI board may answer in', () => {
        expect(CLASSIFY_CATEGORIES).toContain('Travel');
    });
    it.each([
        'AGODA.COM SINGAPORE', 'AIRBNB * HM4K LONDON', 'BOOKING.COM AMSTERDAM', 'FLYDUBAI DUBAI AE', 'SRILANKAN AIRLINES COLOMBO', 'EMIRATES AIRLINE',
        'QATAR AIRWAYS', 'AIR ARABIA', 'INDIGO AIRLINES', 'JETWING HOTELS', 'CINNAMON GRAND COLOMBO', 'HILTON COLOMBO', 'SEASIDE RESORT HIKKADUWA',
    ])('%s is Travel', text => expect(category(text)).toBe('Travel'));
    it('keeps a card line as Travel instead of the plain "Card Purchase"', () => {
        expect(namedCardCategory(category('AGODA.COM SINGAPORE'))).toBe('Travel');
    });
    it.each([
        ['AIRPORT PARKING', 'Transport'], ['UBER *TRIP', 'Transport'], ['VILLA ROSA RESTAURANT', 'Dining'], ['HOTEL DE PILAWOOD RESTAURANT', 'Dining'],
        ['KEELLS SUPER', 'Groceries'], ['AMAZON PRIME VIDEO', 'Entertainment'], ['EMIRATES NBD', 'Other'], ['KANDY HOTEL', 'Other'], ['CINNAMON LIFE MALL', 'Other'],
    ])('does not capture %s (stays %s)', (text, expected) => expect(category(text)).toBe(expected));
    it('files a phone shop as Shopping, not Other', () => {
        expect(category('THE PHONE BAR COLOMBO')).toBe('Shopping');
    });
    it('files the dropdown\'s other names instead of "Other" (invented, generic words only)', () => {
        const cases = [['SALON COLOMBO', 'Personal Care'], ['BARBER SHOP', 'Personal Care'], ['SPA COLOMBO', 'Personal Care'], ['PET SHOP', 'Pets'], ['VETERINARY HOSPITAL', 'Pets'],
            ['TOY WORLD', 'Kids & Family'], ['KIDS WEAR', 'Kids & Family'], ['TEMPLE DONATION', 'Charity'], ['CHARITY DONATION', 'Charity'],
            ['INCOME TAX PAYMENT IRD', 'Government'], ['MUNICIPAL RATES', 'Government'], ['TV LICENSE', 'Government']];
        for (const [text, expected] of cases) expect(category(text), text).toBe(expected);
    });
    it('does not take an ordinary word for a software product: "POST OFFICE" is not a Subscription', () => {
        expect(category('POST OFFICE')).toBe('Other');
        expect(category('MICROSOFT OFFICE 365')).toBe('Subscriptions');
    });
});
