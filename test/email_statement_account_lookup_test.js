/* =============================================================================
 * test/email_statement_account_lookup_test.js
 * -----------------------------------------------------------------------------
 * Production, 2026-11-02. The owner added a new mailbox sender and its statement was "not properly checked against Cards and accounts"; then the banner said
 * "1 statement processed and need review" over an empty list.
 *
 *   1. The mailbox the owner approved is called "HNB Credit Card"; Cards and accounts says "HNB"; the statement says "Hatton National Bank". The bank of a registered
 *      card was compared letter for letter, so one bank was three, and the card's own charges were refused as "not a card charge".
 *   2. The statement was locked by a password the vault did not hold; its review item was gone, so it was counted as "needs review" with nothing to open, counted
 *      twice, and not even tried with the password the owner saved afterwards.
 *   3. A locked statement's password list was ordered by the exact bank name, six per reading.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { institutionKey, sameInstitution, bankAgrees, textNamesBank } from '../wealthflow-institutions.js';
import { identifyAccount } from '../statement-card-identity.mjs';
import { isCreditCardRow, routeRow } from '../wealthflow-statement-router.js';
import { validateSettlementRow } from '../statement-ledger.mjs';
import { candidatesFor } from '../wealthflow-vault.js';
import { coverageOf, gridOf, gridLines, auditLogOf } from '../statement-coverage.mjs';

describe('one bank, however it is written', () => {
    const SAME = [
        ['HNB', 'Hnb'], ['HNB', 'HNB Credit Card'], ['HNB', 'Hnb Cards'], ['HNB', 'Hatton National Bank PLC'], ['Hatton National Bank (HNB)', 'hnb.lk statements'],
        ['DFCC Bank', 'Dfccbank'], ['DFCC Bank', 'DFCC'], ['Nations Trust Bank', 'Nationstrust'], ['Nations Trust Bank', 'NTB'], ['Nations Trust Bank (NTB) — AMEX', 'Nations Trust Bank (NTB)'],
        ['Commercial Bank', 'Combank'], ['Sampath Bank', 'Sampath'], ["People's Bank", 'Peoples Bank'], ['Bank of Ceylon', 'Bank of Ceylon (BOC)'], ['American Express (AMEX)', 'Amex'],
        ['NDB Bank', 'National Development Bank'], ['Standard Chartered', 'Standard Chartered Bank Lanka'], ['NSB', 'National Savings Bank'], ['HSBC', 'Hsbc'], ['Pan Asia Bank', 'Panasia'],
    ];
    for (const [a, b] of SAME) it(`${a}  =  ${b}`, () => { expect(sameInstitution(a, b)).toBe(true); expect(bankAgrees(a, b)).toBe(true); expect(sameInstitution(b, a)).toBe(true); });

    const DIFFERENT = [['HNB', 'DFCC Bank'], ['Sampath Bank', 'Seylan Bank'], ['Commercial Bank', 'Bank of Ceylon'], ['NSB', 'HNB'], ['Union Bank', 'Pan Asia Bank'], ['HSBC', 'Standard Chartered']];
    for (const [a, b] of DIFFERENT) it(`${a}  ≠  ${b}`, () => { expect(sameInstitution(a, b)).toBe(false); expect(bankAgrees(a, b)).toBe(false); });

    it('an unnamed bank or "Other" says nothing against any bank; a bank that is named is never "" = ""', () => {
        for (const wild of ['', '  ', 'Other', 'other', 'Unknown', undefined, null]) expect(bankAgrees('HNB', wild)).toBe(true);
        expect(sameInstitution('', '')).toBe(false);
        expect(institutionKey('Bank')).toBe('');            // only a word that says what kind of thing it is
        expect(institutionKey('Card')).toBe('');
    });
    it('a label that names two banks is not guessed at, and the longer name wins over a product word', () => {
        expect(institutionKey('HNB and DFCC joint account')).toBe('');
        expect(institutionKey('Nations Trust Bank (NTB) — AMEX')).toBe('ntb-amex');     // "AMEX" here is the card, not American Express
        expect(institutionKey('American Express')).toBe('amex');
    });
    it('the opening text of a statement can name the bank when the mailbox label does not', () => {
        expect(textNamesBank('HATTON NATIONAL BANK PLC — Credit card statement', 'HNB')).toBe(true);
        expect(textNamesBank('Seylan Bank — statement', 'HNB')).toBe(false);
        expect(textNamesBank('', 'HNB')).toBe(false);
        expect(textNamesBank('anything', '')).toBe(false);
    });
});

describe('Cards and accounts decides what a statement is — whatever the mailbox is called', () => {
    const registry = { '1234': { type: 'credit_card', bank: 'HNB', name: 'HNB Visa' }, '5678': { type: 'bank_account', bank: 'Commercial Bank' }, '9012': { type: 'credit_card', bank: 'Other' } };
    const lookup = args => identifyAccount({ registry, ...args });

    it('the card registered as "HNB" is the card of the mailbox "HNB Credit Card" — and its charges are card charges', () => {
        const found = lookup({ last4: '1234', bank: 'HNB Credit Card', parsedType: '' });
        expect(found).toMatchObject({ state: 'registered', statementType: 'credit_card', via: 'registry', conflict: false });
        const ctx = { statementType: found.statementType, card_last4: '1234', bank: 'HNB Credit Card', cardRegistry: registry };
        const row = { date: '2026-10-05', amount: 4200, direction: 'debit', description: 'KEELLS SUPER COLOMBO', directionSource: 'column', needsReview: false, valid: true };
        const decision = { module: 'cconetime', category: 'Groceries', verified: true };
        expect(validateSettlementRow(row, decision, ctx)).toBe(null);
    });
    it('before: a card statement with no header the reader knew, from a mailbox spelt differently, was refused row by row', () => {
        // the router alone (no resolved type) now also agrees: the registry's bank and the mailbox's label are one institution
        expect(isCreditCardRow({ card_last4: '1234' }, { cardRegistry: registry, bank: 'HNB Credit Card' })).toBe(true);
        expect(isCreditCardRow({ card_last4: '1234' }, { cardRegistry: registry, bank: 'Hnb' })).toBe(true);
        expect(isCreditCardRow({ card_last4: '1234' }, { cardRegistry: registry, bank: 'Hatton National Bank (HNB)' })).toBe(true);
    });
    it('a refund on that card settles the card; it is not income', () => {
        const ctx = { statementType: 'credit_card', card_last4: '1234', bank: 'HNB Credit Card', cardRegistry: registry };
        const credit = routeRow({ date: '2026-10-09', amount: 50000, direction: 'credit', description: 'PAYMENT RECEIVED THANK YOU', card_last4: '1234' }, ctx);
        expect(credit.module).toBe('cc_payment');
    });
    it('the same digits at ANOTHER bank are another card: the registry says nothing about this statement', () => {
        expect(lookup({ last4: '1234', bank: 'Dfccbank', parsedType: '' })).toMatchObject({ state: 'other-bank', statementType: '', via: '' });
        expect(isCreditCardRow({ card_last4: '1234' }, { cardRegistry: registry, bank: 'Dfccbank' })).toBe(false);
    });
    it('…unless the statement itself names the registered bank', () => {
        expect(lookup({ last4: '1234', bank: 'Mailbox One', parsedType: '', text: 'HATTON NATIONAL BANK PLC credit card statement' })).toMatchObject({ state: 'registered', statementType: 'credit_card' });
    });
    it('a registered bank account is a bank account, and a registered "Other" bank is not held against the statement', () => {
        expect(lookup({ last4: '5678', bank: 'Combank', parsedType: '' })).toMatchObject({ state: 'registered', statementType: 'bank_account' });
        expect(lookup({ last4: '9012', bank: 'Seylan', parsedType: '' })).toMatchObject({ state: 'registered', statementType: 'credit_card' });
    });
    it('what the document itself says is kept; a disagreement is said, not hidden', () => {
        expect(lookup({ last4: '1234', bank: 'Hnb', parsedType: 'credit-card' })).toMatchObject({ state: 'registered', statementType: 'credit-card', via: 'document', conflict: false });
        expect(lookup({ last4: '1234', bank: 'Hnb', parsedType: 'bank_account' })).toMatchObject({ statementType: 'bank_account', via: 'document', conflict: true });
        expect(lookup({ last4: '1234', bank: 'Hnb', parsedType: 'loan' })).toMatchObject({ statementType: 'loan', conflict: false });
    });
    it('digits that are not registered, or not there, leave the statement exactly as the reader read it', () => {
        expect(lookup({ last4: '4321', bank: 'Hnb', parsedType: '' })).toMatchObject({ state: 'unregistered', statementType: '', entry: null });
        expect(lookup({ last4: '4321', bank: 'Hnb', parsedType: 'credit-card' })).toMatchObject({ state: 'unregistered', statementType: 'credit-card' });
        expect(lookup({ last4: '', bank: 'Hnb', parsedType: '' })).toMatchObject({ state: 'no-digits', statementType: '' });
        expect(lookup({ last4: '12', bank: 'Hnb', parsedType: '' }).state).toBe('no-digits');
        expect(identifyAccount({ last4: '1234', bank: 'Hnb' })).toMatchObject({ state: 'unregistered' });
        expect(identifyAccount({ registry: { constructor: 1, toString: 1 }, last4: '1234', bank: 'Hnb' }).state).toBe('unregistered');
        expect(identifyAccount()).toMatchObject({ state: 'no-digits' });
    });
});

describe('a locked statement: the bank\'s own password first, every other saved password after', () => {
    const vault = [{ bank: 'DFCC', password: 'dfcc-pass' }, { bank: 'Commercial Bank', password: 'com-pass' }, { bank: 'Hatton National Bank (HNB)', password: 'hnb-pass' }, { bank: '', password: 'untitled' }];
    it('"HNB Credit Card" finds the vault\'s "Hatton National Bank (HNB)" first — and still offers all the rest', () => {
        const out = candidatesFor('HNB Credit Card', vault);
        expect(out[0]).toBe('hnb-pass');
        expect(out.slice().sort()).toEqual(['com-pass', 'dfcc-pass', 'hnb-pass', 'untitled']);
    });
    it('a bank the vault does not know at all still gets every password tried', () => {
        expect(candidatesFor('Some New Bank', vault).slice().sort()).toEqual(['com-pass', 'dfcc-pass', 'hnb-pass', 'untitled']);
        expect(candidatesFor('', vault).length).toBe(4);
    });
});

describe('a locked statement is "waiting for a password", in the grid as well', () => {
    const items = [{ bank: 'HNB Credit Card', filename: 'card_2026OCT.pdf', receivedMs: Date.UTC(2026, 9, 20), status: 'needs_review', reviewReason: 'PASSWORD_FAILED' },
        { bank: 'HNB Credit Card', filename: 'card_2026SEP.pdf', receivedMs: Date.UTC(2026, 8, 20), status: 'needs_review', reviewReason: 'statement-layout-or-reconciliation-needs-review' }];
    it('says so in the owner\'s words, and a month waiting for a password is not a hole', () => {
        const lines = gridLines(gridOf(items));
        expect(lines.join(' ')).toContain('2026-10 needs its password');
        expect(lines.join(' ')).toContain('2026-09 in review');
        expect(coverageOf(items, { now: Date.UTC(2026, 10, 2) }).series[0].months['2026-10']).toBe('locked');
        expect(auditLogOf(items).map(e => e.status)).toEqual(['Needs-Review', 'Needs-Review']);
    });
});

describe('the "need review" banner counts only what there is something to open', () => {
    const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'index.html'), 'utf8');
    it('is built from the server\'s reviewQuestions and the list\'s own non-password items — a locked statement has its own strip', () => {
        expect(html).toContain('_mailSyncState.reviewQuestions = ');
        const banner = html.slice(html.indexOf('const reviewTotal = '), html.indexOf('const reviewStrip = '));
        expect(banner).toContain('st.reviewQuestions');
        expect(banner).toContain('passwordReviews');
        expect(banner).not.toMatch(/\bst\.reviewStatements\) \|\| 0, Number\(window\.WFStatementCloud/);   // the old sum of the two lists, the locked statement counted in both
    });
});

describe('the statement text can name the registered bank only when it names that bank alone, in its header', () => {
    it('a transaction line that mentions another bank does not make the statement that bank\'s', () => {
        expect(textNamesBank('DFCC BANK credit card statement\n12 OCT TRANSFER TO HNB 5,000.00', 'HNB')).toBe(false);
        expect(textNamesBank('DFCC BANK credit card statement', 'DFCC')).toBe(true);
        expect(textNamesBank('x'.repeat(3000) + ' HATTON NATIONAL BANK', 'HNB')).toBe(false);   // far from the header
    });
});
