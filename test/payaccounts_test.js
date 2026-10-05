/* =============================================================================
 * test/payaccounts_test.js — the lender's bank accounts, as the people they lend to and borrow from see them
 * -----------------------------------------------------------------------------
 * What the editor accepts, which kind of person sees which account, and the whitelist of what leaves the books.
 * The statement page and the PDF both read through publicAccounts, so what is pinned here is the most that a
 * stranger-with-an-NIC-and-a-code can ever be told about the owner's money.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { PAY_KEY, SHOW, SHOW_TEXT, LIMITS, cleanAccount, listAccounts, visibleTo, publicAccounts, accountText } from '../wealthflow-payaccounts.js';

const good = (over = {}) => ({ bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'ccEylklx', note: 'Quote your reference', showTo: 'both', active: true, ...over });
const rec = (over = {}) => ({ id: 'a1', createdAt: '2026-01-01', _ut: 9, ...good(), ...over });

describe('what the editor accepts', () => {
    it('takes a complete account and tidies it', () => {
        const out = cleanAccount(good({ bank: '  Commercial   Bank ', swift: 'cceylklx' }));
        expect(out.ok).toBe(true);
        expect(out.errors).toEqual({});
        expect(out.fields).toEqual({ bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'Quote your reference', showTo: 'both', active: true });
    });

    it('asks for the three things that make an account usable, and says which is missing', () => {
        const out = cleanAccount({});
        expect(out.ok).toBe(false);
        expect(Object.keys(out.errors).sort()).toEqual(['bank', 'holder', 'number']);
        expect(cleanAccount(good({ bank: '   ' })).errors.bank).toBeTruthy();
        expect(cleanAccount(good({ holder: '' })).errors.holder).toBeTruthy();
        expect(cleanAccount(good({ number: '' })).errors.number).toBeTruthy();
    });

    it('takes an account number as banks write them (digits, letters for an IBAN, spaces, - . /) and nothing else', () => {
        for (const ok of ['8001234567', '1234 5678 9012', '123-456-789', 'LK55 COMB 0000 1234 5678', '12/34.56']) expect(cleanAccount(good({ number: ok })).ok, ok).toBe(true);
        for (const bad of ['80012345#67', 'acct: 8001234567', '12<b>34', '١٢٣٤٥٦٧', '1234;5678']) expect(cleanAccount(good({ number: bad })).errors.number, bad).toBeTruthy();
        expect(cleanAccount(good({ number: '12 3' })).errors.number).toMatch(/too short/);
        expect(cleanAccount(good({ number: '12 3' })).fields.number).toBe('');                    // a refused number is never carried on
    });

    it('takes a SWIFT code or IBAN in capitals, and drops (and reports) one with odd characters', () => {
        expect(cleanAccount(good({ swift: 'lk55 comb 0000' })).fields.swift).toBe('LK55 COMB 0000');
        const bad = cleanAccount(good({ swift: 'CCEY-LKLX' }));
        expect(bad.ok).toBe(false);
        expect(bad.errors.swift).toBeTruthy();
        expect(bad.fields.swift).toBe('');
        expect(cleanAccount(good({ swift: '' })).ok).toBe(true);                                // optional
    });

    it('cuts every field to its limit, squashes control characters, and never lets a line break through', () => {
        const out = cleanAccount(good({ holder: 'A\u0000B\n\tC\u007F', note: 'x'.repeat(900), branch: 'y'.repeat(900), bank: 'z'.repeat(900) }));
        expect(out.fields.holder).toBe('A B C');
        expect(out.fields.note).toHaveLength(LIMITS.note);
        expect(out.fields.branch).toHaveLength(LIMITS.branch);
        expect(out.fields.bank).toHaveLength(LIMITS.bank);
        for (const v of Object.values(out.fields)) if (typeof v === 'string') expect(v).not.toMatch(/[\u0000-\u001F\u007F]/);
    });

    it('defaults to everybody, and only understands the three audiences', () => {
        expect(cleanAccount(good({ showTo: undefined })).fields.showTo).toBe('both');
        expect(cleanAccount(good({ showTo: 'everyone' })).fields.showTo).toBe('both');
        expect(cleanAccount(good({ showTo: '<x>' })).fields.showTo).toBe('both');
        for (const v of Object.values(SHOW)) expect(cleanAccount(good({ showTo: v })).fields.showTo).toBe(v);
        expect(Object.keys(SHOW_TEXT).sort()).toEqual(Object.values(SHOW).sort());
    });

    it('switched off means false however a device wrote it, and anything else is on', () => {
        for (const off of [false, 'false', 0]) expect(cleanAccount(good({ active: off })).fields.active, String(off)).toBe(false);
        for (const on of [true, undefined, 'true', 1, '', null]) expect(cleanAccount(good({ active: on })).fields.active, String(on)).toBe(true);
    });

    it('survives input that is not an object', () => {
        for (const odd of [null, undefined, 5, 'x', [], () => 1]) expect(() => cleanAccount(odd), String(odd)).not.toThrow();
    });
});

describe('the list', () => {
    it('is the usable accounts, oldest first, and never throws on a damaged entry', () => {
        const raw = [rec({ id: 'b', createdAt: '2026-02-01', number: '2222222222' }), rec({ id: 'a', createdAt: '2026-01-01', number: '1111111111' }), null, 5, 'x', {}, rec({ id: '', number: '3333333333' }), rec({ id: 'c', bank: '' }), rec({ id: 'd', number: '' })];
        expect(listAccounts(raw).map((a) => a.id)).toEqual(['a', 'b']);
        expect(listAccounts(undefined)).toEqual([]);
        expect(listAccounts('nope')).toEqual([]);
        expect(listAccounts({ length: 3 })).toEqual([]);
    });

    it('breaks a tie on the date by the id, so every device shows the same order', () => {
        const a = rec({ id: 'x2', createdAt: '2026-01-01' }); const b = rec({ id: 'x1', createdAt: '2026-01-01' });
        expect(listAccounts([a, b]).map((r) => r.id)).toEqual(['x1', 'x2']);
        expect(listAccounts([b, a]).map((r) => r.id)).toEqual(['x1', 'x2']);
    });

    it('is keyed under one name on the user\'s document', () => {
        expect(PAY_KEY).toBe('payAccounts');
    });
});

describe('who sees which account', () => {
    it('both: everybody. debtors: only those on a loan. investors: only those on an investment.', () => {
        expect(visibleTo({ showTo: 'both' }, 'A')).toBe(true);
        expect(visibleTo({ showTo: 'both' }, 'B')).toBe(true);
        expect(visibleTo({ showTo: 'debtors' }, 'B')).toBe(true);
        expect(visibleTo({ showTo: 'debtors' }, 'A')).toBe(false);
        expect(visibleTo({ showTo: 'investors' }, 'A')).toBe(true);
        expect(visibleTo({ showTo: 'investors' }, 'B')).toBe(false);
    });

    it('a switched-off account is for nobody, and an unknown audience means everybody (never nobody-by-accident, never a leak of a setting)', () => {
        expect(visibleTo({ showTo: 'both', active: false }, 'A')).toBe(false);
        expect(visibleTo({ showTo: 'weird' }, 'B')).toBe(true);
        expect(visibleTo({}, 'A')).toBe(true);
        expect(visibleTo(null, 'A')).toBe(true);
        expect(visibleTo({ showTo: 'both' }, 'C')).toBe(true);
        expect(visibleTo({ showTo: 'debtors' }, 'C')).toBe(false);
        expect(visibleTo({ showTo: 'investors' }, undefined)).toBe(false);
    });
});

describe('what leaves the books', () => {
    it('six plain fields and nothing else: not the id, the audience, the switch, a timestamp or any extra field a device added', () => {
        const [out] = publicAccounts([rec({ secret: 'PRIVATE', balance: 77777, _ut: 99, updatedAt: 'x' })]);
        expect(out).toEqual({ bank: 'Commercial Bank', holder: 'N. Perera', number: '8001234567', branch: 'Colombo 03', swift: 'CCEYLKLX', note: 'Quote your reference' });
        expect(JSON.stringify(out)).not.toMatch(/PRIVATE|77777|showTo|active|createdAt|_ut|"id"/);
    });

    it('filters by the kinds of record the person has, and takes either or both', () => {
        const raw = [rec({ id: 'd', number: '1111111111', showTo: 'debtors', createdAt: '1' }), rec({ id: 'i', number: '2222222222', showTo: 'investors', createdAt: '2' }), rec({ id: 'b', number: '3333333333', showTo: 'both', createdAt: '3' })];
        const nums = (layers) => publicAccounts(raw, layers).map((a) => a.number);
        expect(nums(['B'])).toEqual(['1111111111', '3333333333']);
        expect(nums(['A'])).toEqual(['2222222222', '3333333333']);
        expect(nums(['A', 'B'])).toEqual(['1111111111', '2222222222', '3333333333']);
        expect(nums('B')).toEqual(['1111111111', '3333333333']);
        expect(nums([])).toEqual([]);
        expect(nums(['Z'])).toEqual([]);
        expect(nums(undefined)).toEqual(['1111111111', '2222222222', '3333333333']);
    });

    it('skips an account that would not pass the editor today, and one that is switched off', () => {
        expect(publicAccounts([rec({ number: '12 3' })])).toEqual([]);
        expect(publicAccounts([rec({ swift: 'BAD-CODE' })])).toEqual([]);
        expect(publicAccounts([rec({ active: false })])).toEqual([]);
        expect(publicAccounts(null)).toEqual([]);
    });

    it('no more than the limit, however many there are', () => {
        const many = Array.from({ length: 25 }, (_, i) => rec({ id: `m${String(i).padStart(2, '0')}`, number: `70000000${String(i).padStart(2, '0')}` }));
        expect(publicAccounts(many)).toHaveLength(LIMITS.accounts);
    });

    it('hands out copies: changing what was handed out does not change the books', () => {
        const raw = [rec()];
        const [out] = publicAccounts(raw);
        out.number = 'TAMPERED';
        expect(raw[0].number).toBe('8001234567');
    });
});

describe('as text', () => {
    it('lines for pasting', () => {
        expect(accountText(good())).toBe('Bank: Commercial Bank\nAccount name: N. Perera\nAccount number: 8001234567\nBranch: Colombo 03\nSWIFT / IBAN: ccEylklx\nNote: Quote your reference');
        expect(accountText({ bank: 'B', holder: 'H', number: '12345' })).toBe('Bank: B\nAccount name: H\nAccount number: 12345');
        expect(accountText(null)).toBe('Bank: \nAccount name: \nAccount number: ');
    });
});
