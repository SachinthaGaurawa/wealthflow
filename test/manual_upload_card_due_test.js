import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { cardDueRecord, withCardDue } from '../statement-due.mjs';
import cardTabs from '../wealthflow-card-tabs.js';

const P = loadParser(fs);
const STATEMENT = [
    'Statement of Account', 'Card Number 4111 2222 3333 4444', 'Credit Limit 400,000.00', 'Statement Period 30 Sep 2026 / 31 Oct 2026',
    'Posting Date Transaction Date Transaction Details Foreign Currency Amount Amount', 'Opening Balance 120,000.00',
    '14/10/2026 13/10/2026 SUPERMARKET KANDY, KANDY 3,250.50',
    'Payment Due Date Min Amt. Due Closing Balance', '24 Nov 2026 4,200.00 121,750.50',
].join('\n');

describe('a card statement uploaded by hand keeps its minimum-payment ask, like the e-mail worker', () => {
    const parsed = P.parseStatement(STATEMENT);
    const canonBank = b => String(b || '').trim();

    it('makes one ask with the same fields the worker keeps', () => {
        const mine = cardTabs.dueFromStatement({ due: parsed.due, isCard: true, bank: 'Invented Bank', last4: '4444', canonBank, now: 1000 });
        const theirs = cardDueRecord({ due: parsed.due, sourcePath: 'p', bank: 'Invented Bank', last4: '4444', statementType: 'credit_card', now: 1000 });
        expect(mine).toMatchObject({ bank: theirs.bank, card_last4: '4444', minimum: 4200, dueDate: '2026-11-24', closing: theirs.closing });
        expect(mine.id).toBe('due-up-invented-bank-4444-2026-11-24');
        expect(mine.id).not.toBe(theirs.id);
    });
    it('a bank-account statement, no minimum, or no real date makes nothing', () => {
        expect(cardTabs.dueFromStatement({ due: parsed.due, isCard: false, bank: 'B', last4: '4444' })).toBeNull();
        expect(cardTabs.dueFromStatement({ due: { date: '2026-11-24', minimum: 0 }, isCard: true })).toBeNull();
        expect(cardTabs.dueFromStatement({ due: { date: '2026-02-31', minimum: 100 }, isCard: true })).toBeNull();
        expect(cardTabs.dueFromStatement({ isCard: true })).toBeNull();
    });
    it('the same statement read twice is one ask, and a re-read never reopens one marked paid', () => {
        const rec = cardTabs.dueFromStatement({ due: parsed.due, isCard: true, bank: 'Invented Bank', last4: '4444', canonBank, now: 1 });
        const once = cardTabs.withDue([], rec);
        expect(once).toHaveLength(1);
        expect(cardTabs.withDue(once, { ...rec, _ut: 2 })).toBeNull();
        const better = cardTabs.withDue(once, { ...rec, minimum: 4300 });
        expect(better).toHaveLength(1);
        expect(better[0].minimum).toBe(4300);
        const paid = [{ ...once[0], paidManually: true }];
        expect(cardTabs.withDue(paid, { ...rec, minimum: 9999 })).toBeNull();
    });
    it('beside the worker\'s ask for the same statement, the CC One-Time page still shows one per card', () => {
        const mine = cardTabs.dueFromStatement({ due: parsed.due, isCard: true, bank: 'Invented Bank', last4: '4444', canonBank, now: 1 });
        const theirs = withCardDue([], cardDueRecord({ due: parsed.due, sourcePath: 'p', bank: 'Invented Bank', last4: '4444', statementType: 'credit_card', now: 1 }));
        const shown = cardTabs.dues([...theirs, mine], [], { today: '2026-11-01', canonBank });
        expect(shown).toHaveLength(1);
        expect(shown[0]).toMatchObject({ minimum: 4200, dueDate: '2026-11-24', last4: '4444' });
    });
    it('the page files it only for a credit card, after the payments, and never fails an import', () => {
        const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
        const at = html.indexOf('dueFromStatement({ due: parsed.due');
        expect(at).toBeGreaterThan(0);
        const around = html.slice(at - 400, at + 700);
        expect(around).toContain("_acctType === 'credit_card'");
        expect(around).toContain("DB.set('cardDues'");
        expect(html.lastIndexOf("DB.set('ccPayments', ccPayArr)", at)).toBeGreaterThan(at - 1500);
        expect(around).toMatch(/try \{[\s\S]*\} catch \(_\) \{\}/);
    });
});
