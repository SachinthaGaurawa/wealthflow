import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalBank, sameBank, INSTITUTIONS } from '../wealthflow-institutions.js';
import { isCreditCardRow } from '../wealthflow-statement-router.js';
import { rowIdentity, crossSourceMatches } from '../statement-ledger.mjs';

// American Express is one bank with two names — long "American Express", short
// "AMEX". The card page showed it as two cards ("AMEX · 10" and "American
// Express (AMEX) · 48"), with payments on one and charges on the other never
// meeting. One name per bank, everywhere a bank is compared or grouped.
const LONG = 'American Express (AMEX)';

describe('canonicalBank', () => {
    it('names American Express once, whichever spelling arrives', () => {
        for (const n of ['AMEX', 'Amex', 'amex', 'American Express', 'AMERICAN EXPRESS', 'American Express (AMEX)', 'American-Express', 'AmericanExpress', ' amex card ', 'American Express Card'])
            expect(canonicalBank(n), n).toBe(LONG);
    });
    it('is the name the institution picker already uses', () => {
        expect(LONG).toBe(INSTITUTIONS.find(i => i.id === 'amex').name);
    });
    it('leaves every other bank exactly as it is', () => {
        for (const n of ['NTB', 'Nations Trust Bank (NTB)', 'Nations Trust Bank (NTB) — AMEX', 'Nations Trust Bank (NTB) — Visa/Mastercard', 'HNB', 'Commercial Bank', 'Amex Platinum', 'Express Bank', '', null, undefined])
            expect(canonicalBank(n), String(n)).toBe(n == null ? '' : String(n).trim());
    });
    it('sameBank compares by canonical name, and empty is never the same as empty', () => {
        expect(sameBank('AMEX', 'American Express (AMEX)')).toBe(true);
        expect(sameBank('american express', 'Amex')).toBe(true);
        expect(sameBank('NTB', 'AMEX')).toBe(false);
        expect(sameBank('', '')).toBe(false);
    });
});

describe('the ledger and router treat both spellings as one card', () => {
    it('a card registered under the long name matches a statement labelled with the short one', () => {
        const registry = { 4444: { type: 'credit_card', bank: LONG } };
        expect(isCreditCardRow({ card_last4: '4444' }, { cardRegistry: registry, bank: 'AMEX' })).toBe(true);
        expect(isCreditCardRow({ card_last4: '4444' }, { cardRegistry: registry, bank: 'NTB' })).toBe(false);
    });
    it('a row already filed under "AMEX" is recognised when the same row arrives under the long name', () => {
        const filed = { date: '2026-07-13', amount: 1000, desc: 'Cash advance', bank: 'AMEX', card_last4: '0276', ref: '' };
        const row = { date: '2026-07-13', amount: 1000, description: 'Cash advance', direction: 'debit', ref: '' };
        expect(rowIdentity(row, { bank: LONG, last4: '0276' }).slice(0, 6)).toEqual(rowIdentity({ ...filed, description: filed.desc }, {}).slice(0, 6));
        expect(crossSourceMatches([filed], row, { bank: LONG, last4: '0276' })).toHaveLength(1);
    });
});

// The page code lives inline in index.html: run THAT code, not a copy of it.
function pageMigration(records) {
    const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
    const start = html.indexOf('function _canonBank(n)');
    const endFn = html.indexOf('// v7.27.0 — one-time correction', start);
    expect(start).toBeGreaterThan(0);
    expect(endFn).toBeGreaterThan(start);
    const store = JSON.parse(JSON.stringify(records));
    const writes = [];
    const DB = { get: k => store[k], set: (k, v) => { store[k] = v; writes.push(k); } };
    const window = { WFInstitutions: { canonicalBank } };
    const setDirty = vi.fn();
    new Function('window', 'DB', 'setDirty', 'console', html.slice(start, endFn) + '\n_migrateBankNames();')(window, DB, setDirty, { warn: (...a) => { throw new Error(a.join(' ')); } });
    return { store, writes, setDirty, window };
}

describe('the card pages bring old records under the one name', () => {
    const records = {
        cconetime: [{ id: 'a', bank: 'AMEX', card_last4: '0276' }, { id: 'b', bank: 'American Express (AMEX)', card_last4: '0276' }, { id: 'c', bank: 'HNB' }],
        ccPayments: [{ id: 'p', bank: 'American Express' }],
        ccinstall: [{ id: 'i', bank: 'amex' }], loans: [], cheques: [{ id: 'q', bank: 'Sampath Bank' }],
    };
    it('rewrites AMEX and American Express — payments included — and nothing else', () => {
        const { store, writes, setDirty } = pageMigration(records);
        expect(store.cconetime.map(r => r.bank)).toEqual([LONG, LONG, 'HNB']);
        expect(store.ccPayments[0].bank).toBe(LONG);
        expect(store.ccinstall[0].bank).toBe(LONG);
        expect(store.cheques[0].bank).toBe('Sampath Bank');
        expect(writes.sort()).toEqual(['ccPayments', 'ccinstall', 'cconetime']);
        expect(setDirty).toHaveBeenCalledWith(true);
    });
    it('writes nothing when there is nothing to rewrite, so running it on every page draw is free', () => {
        const once = pageMigration(records).store;
        const { writes, setDirty } = pageMigration(once);
        expect(writes).toEqual([]);
        expect(setDirty).not.toHaveBeenCalled();
    });
    it('the card page groups, filters and settles by the canonical name', () => {
        const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
        const page = html.slice(html.indexOf('function _ccKey(r)'), html.indexOf('function renderCCOT()') + 6000);
        expect(page).not.toMatch(/\.map\(x => x\.bank\)/);
        expect(page).not.toMatch(/x\.bank === b\b|x\.bank === _ccotBankFilter|c\.bank === _ccotBankFilter|p\.bank === _ccotBankFilter/);
        expect(page).toMatch(/_canonBank\(x\.bank\) === _ccotBankFilter/);
    });
});
