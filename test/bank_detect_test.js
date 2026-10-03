import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { detect, tailsOf, networkOfBin, NAMED_AT, LEAD_BY } from '../wealthflow-bank-detect.js';
import { INSTITUTIONS, PICKER } from '../wealthflow-institutions.js';
import { bankIdentity, bankKeyOf } from '../statement-coverage.mjs';
import { identityOf } from '../statement-registry.mjs';

/* =============================================================================
 * THE BANK IS READ FROM THE STATEMENT, NEVER ASKED (wealthflow-bank-detect.js).
 * The manual upload used to stop and show fifteen buttons ("Which credit card / bank?") before a statement was read. These tests hold the replacement to the
 * three things that matter: it names the right bank, it NEVER names a wrong one (when the evidence is thin the answer is "not identified" — filed without a label,
 * checked against the books by amount and date), and what it names lands on the same registry lock the email worker uses, so "Already Added via Email Sync" still works.
 * ===========================================================================*/

const ntbAmex = `Nations Trust Bank American Express Magnet Card
Card No: 376657*****0276
Statement Period:
11-Jul-2026 to 10-Aug-2026
Credit Limit 350,000 Minimum Payment Due 8,433.98
Opening Balance 1,000.00 Closing Balance 4,700.00
13 JUL 13 JUL Cash advance LKR 1,000.00 1,000.00 Dr
16 JUL 16 JUL PAYMENT THANK YOU LKR 300.00 300.00 Cr
Please note the interest rate applicable on all transactions including carried forward outstanding balance is revised to 2.33% p.a.`;

const sampath = `Account Statement
Sampath Bank PLC
Account No: 0012 3456 7890
Statement Date 31/08/2026
Opening Balance 10,000.00
02/08/2026 CEFT Transfer HNB SAMAN KUMARA 2,500.00 7,500.00
05/08/2026 Online Transfer COMMERCIAL BANK 1,000.00 6,500.00
09/08/2026 ATM WDL BOC KOLLUPITIYA 3,000.00 3,500.00
Closing Balance 3,500.00`;

const blob = (t) => t.replace(/\n/g, '');

describe('the statement names its own bank', () => {
    it('a Nations Trust AMEX statement: the bank, the product (from the card number) and the AMEX fee schedule', () => {
        const r = detect({ text: ntbAmex, filename: 'eStatement_376657XXXXX0276_2026AUG.html' });
        expect(r).toMatchObject({ ok: true, issuer: 'Nations Trust Bank (NTB)', lockName: 'Nations Trust Bank (NTB)', product: 'amex', name: 'Nations Trust Bank (NTB) — AMEX', feeKey: 'Nations Trust Bank (NTB) — AMEX', tail: '0276' });
        expect(r.basis.join(' ')).toMatch(/statement names it/);
    });
    it('a Nations Trust Visa statement is the Visa/Mastercard schedule, not AMEX', () => {
        const r = detect({ text: ntbAmex.replace('American Express Magnet Card', 'Visa Platinum Credit Card').replace('376657*****0276', '4532 11XX XXXX 8841') });
        expect(r).toMatchObject({ ok: true, product: 'visa-mc', name: 'Nations Trust Bank (NTB) — Visa/Mastercard', feeKey: 'Nations Trust Bank (NTB) — Visa/Mastercard' });
    });
    it('a Nations Trust statement that never says which card is filed under the issuer, and uses the generic fee schedule rather than guessing one', () => {
        const r = detect({ text: 'Nations Trust Bank PLC\nConsolidated Monthly Statement\nSavings - MaxBonus 200550088057 LKR\nStatement Period: 01-01-2026 to 31-01-2026' });
        expect(r).toMatchObject({ ok: true, product: '', name: 'Nations Trust Bank (NTB)', feeKey: 'Other' });
    });
    it('a bank statement whose rows name three OTHER banks is still its own bank\'s', () => {
        const r = detect({ text: sampath });
        expect(r).toMatchObject({ ok: true, name: 'Sampath Bank', lockName: 'Sampath Bank', feeKey: 'Sampath Bank' });
    });
    it('a legal-entity line in the first screen names the bank; one buried far down is a single weak fact and needs a second', () => {
        const page = (notes) => ['Statement of Account', 'A/C No 074020101234', 'B/F 5,000.00', ...Array.from({ length: notes }, (_, i) => `Note line ${i} about charges`), 'Hatton National Bank PLC - Registered Office 479 T B Jayah Mawatha Colombo 10'].join('\n');
        expect(detect({ text: page(30) })).toMatchObject({ ok: true, name: 'Hatton National Bank (HNB)' });
        expect(detect({ text: page(80) }).ok).toBe(false);
        expect(detect({ text: page(80), filename: 'HNB statement.pdf' })).toMatchObject({ ok: true, name: 'Hatton National Bank (HNB)' });
    });
    it('a statement drawn from <div>s (one run of text, cells glued together) is still read from its top', () => {
        expect(detect({ text: blob(sampath) })).toMatchObject({ ok: true, name: 'Sampath Bank' });
        expect(detect({ text: blob(ntbAmex) })).toMatchObject({ ok: true, product: 'amex' });
        expect(detect({ text: 'Account StatementSampath Bank PLCAccount No: 0012 3456 7890 ' + 'lorem ipsum '.repeat(30) })).toMatchObject({ ok: true, name: 'Sampath Bank' });
    });
    it('the text a real browser gives back for a <div> e-statement: header cells glued, table rows on their own lines (found by uploading one)', () => {
        const real = 'Account StatementSampath Bank PLCCard No: 4111 11XX XXXX 8841Statement Period: 01/08/2026 - 31/08/2026\nDateDescriptionAmount\n02/08/2026KEELLS SUPER NUGEGODA1,250.00\n03/08/2026CEFT TRANSFER HNB SAMAN2,000.00';
        expect(detect({ text: real })).toMatchObject({ ok: true, name: 'Sampath Bank', tail: '8841' });
        expect(detect({ text: real.replace('Sampath Bank PLC', 'Hatton National Bank PLC') })).toMatchObject({ ok: true, name: 'Hatton National Bank (HNB)' });
    });
    it('a long line with rows inside it is read around the rows, not thrown away with them', () => {
        const header = 'Sampath Bank PLC Credit Card Statement Card No: 4111 11XX XXXX 8841 ' + 'Statement Period 01/08/2026 - 31/08/2026 ';
        const rows = Array.from({ length: 12 }, (_, i) => `0${(i % 9) + 1}/08/2026 CEFT TRANSFER HNB SAMAN ${i + 1},250.00 `).join('');
        expect(detect({ text: header + rows })).toMatchObject({ ok: true, name: 'Sampath Bank' });
    });
    it('every one of the fourteen institutions is recognised from a plain header, and its record label is its picker name', () => {
        for (const inst of INSTITUTIONS) {
            const r = detect({ text: `${inst.name.replace(/ — .*$/, '').replace(/\s*\(.*\)/, '')} PLC\nStatement of Account\nCard No: ************1234\n`, filename: `${inst.tokens[0]} statement.pdf` });
            expect(r.ok, inst.id).toBe(true);
            expect(r.issuer, inst.id).toBe(inst.mailName || inst.name);
        }
    });
});

describe('it never names a wrong bank', () => {
    it('transaction rows are never evidence: "CEFT Transfer HNB" is a payment, not an issuer', () => {
        const rowsOnly = 'Account Statement\n02/08/2026 CEFT Transfer HNB SAMAN KUMARA 2,500.00 7,500.00\n05/08/2026 ATM WDL BOC KOLLUPITIYA 3,000.00 3,500.00\n09/08/2026 Online Transfer COMMERCIAL BANK 1,000.00 2,500.00';
        expect(detect({ text: rowsOnly })).toMatchObject({ ok: false, name: '', lockName: '' });
    });
    it('"a licensed commercial bank" is every bank\'s footer and names none of them', () => {
        const r = detect({ text: 'Statement of Account\nAccount No 12345678\nOpening Balance 100.00\nSampath Bank PLC is a licensed commercial bank regulated by the Central Bank of Sri Lanka' });
        expect(r.ok && r.name).toBe('Sampath Bank');
        expect(detect({ text: 'Statement\nThis institution is a licensed commercial bank.\nAccount No 12345678' }).ok).toBe(false);
    });
    it('a line that LISTS banks says where to pay, not whose statement it is', () => {
        const r = detect({ text: 'Credit Card Statement\nCard No: 4111 11XX XXXX 1234\nYou may pay at BOC, Commercial Bank, Sampath Bank, HNB or Seylan branches\nMinimum payment 2,000.00' });
        expect(r.ok).toBe(false);
    });
    it('two banks in the header is a tie, and a tie is not an answer', () => {
        expect(detect({ text: 'Sampath Bank PLC\nHatton National Bank PLC\nStatement' }).ok).toBe(false);
    });
    it('nothing in the statement, the cards or the history: not identified, and the answer says so in words', () => {
        const r = detect({ text: 'Statement of account\nAccount No 12345678\n01/01/2026 something 10.00' });
        expect(r).toMatchObject({ ok: false, confidence: 'none', name: '', lockName: '', feeKey: '' });
        expect(r.note).toMatch(/not identified/i);
    });
    it('a weak fact alone is not enough: the file name, or the PDF title, or the AI once, on their own', () => {
        expect(detect({ filename: 'DFCC Bank Statement - Aug 26.pdf' }).ok).toBe(false);
        expect(detect({ meta: { title: 'DFCC Bank Statement' } }).ok).toBe(false);
        expect(detect({ filename: 'DFCC Bank Statement - Aug 26.pdf', meta: { title: 'DFCC Bank Statement' } })).toMatchObject({ ok: true, name: 'DFCC Bank' });
    });
    it('a statement that names its bank outranks the owner\'s cards: a wrong label in the books never overrules the page', () => {
        const r = detect({ text: 'DFCC Bank PLC\nStatement of Account\nCard No: 4111 11XX XXXX 1234', books: [{ bank: 'Commercial Bank', last4: '1234', seen: 9 }] });
        expect(r).toMatchObject({ ok: true, name: 'DFCC Bank' });
    });
    it('a close disagreement is a conflict, and a conflict is "not identified"', () => {
        const filler = Array.from({ length: 14 }, (_, i) => `Note ${i}`).join('\n');                        // the name sits on the first screen, not in the first lines: 5 against the card's 6
        const r = detect({ text: `Statement of Account\n${filler}\nDFCC Bank\nCard No: 4111 11XX XXXX 1234`, books: [{ bank: 'Commercial Bank', last4: '1234', seen: 9 }] });
        expect(r.ok).toBe(false);
    });
    it('the owner\'s own card does not name a bank against another bank the page names, however often it is filed', () => {
        const r = detect({ text: 'Sampath Bank\nCard No: 4111 11XX XXXX 1234', books: [{ bank: 'Commercial Bank', last4: '1234', seen: 90 }] });
        expect(r.name).not.toBe('Commercial Bank');
    });
    it('two of the owner\'s cards sharing a tail, at different banks, is a tie', () => {
        const r = detect({ text: 'Credit card statement\nCard No: 4111 11XX XXXX 1234', books: [{ bank: 'Commercial Bank', last4: '1234', seen: 9 }, { bank: 'Seylan Bank', last4: '1234', seen: 9 }] });
        expect(r.ok).toBe(false);
    });
    it('a books label of the wrong NTB product is not reused', () => {
        const r = detect({ text: ntbAmex.replace('American Express Magnet Card', 'Visa Platinum Credit Card').replace('376657*****0276', '4532 11XX XXXX 0276'), books: [{ bank: 'American Express (AMEX)', last4: '0276', seen: 40 }] });
        expect(r.product).not.toBe('amex');
    });
    it('a labelled ACCOUNT number that happens to start with 4 or 5 is not a card network', () => {
        const r = detect({ text: 'Nations Trust Bank PLC\nAccount No: 4001234567890\nStatement Period 01/01/2026 - 31/01/2026' });
        expect(r.ok).toBe(true);
        expect(r.product).toBe('');
    });
    it('is total: nothing it is handed makes it throw', () => {
        for (const bad of [undefined, null, 5, 'text', {}, { text: null }, { text: 5 }, { text: {} }, { books: 'x', history: 'y' }, { books: [null, 1, {}], history: { last4: null, approved: 'x' } }, { text: 'x'.repeat(900000) }, { text: '\n'.repeat(10000) }]) {
            expect(() => detect(bad)).not.toThrow();
            expect(detect(bad)).toHaveProperty('ok');
        }
    });
    it('the bar is the documented one', () => { expect([NAMED_AT, LEAD_BY]).toEqual([6, 3]); });
});

describe('more evidence settles what the page alone cannot', () => {
    it('a scanned page: the bank the AI read off it, once, is enough; with the file name too it is certain', () => {
        expect(detect({ text: '', ai: { bank: 'Seylan Bank PLC', network: 'visa' } })).toMatchObject({ ok: true, name: 'Seylan Bank' });
        expect(detect({ text: '', filename: 'seylan_cc.pdf', ai: { bank: 'Seylan Bank' } })).toMatchObject({ ok: true, confidence: 'certain' });
        expect(detect({ text: '', ai: { bank: '', network: 'visa' } }).ok).toBe(false);
    });
    it('the same file already in the mailbox under a bank is the strongest fact there is', () => {
        expect(detect({ text: '', history: { sha: { bank: 'Union Bank' } } })).toMatchObject({ ok: true, name: 'Union Bank', confidence: 'certain' });
    });
    it('a card number the owner has filed three times or more names the bank on a statement that prints no bank name, and the owner\'s label is reused', () => {
        const text = 'Credit card statement\nCard No: 4111 11XX XXXX 1234\nCredit Limit 100,000';
        expect(detect({ text, books: [{ bank: 'Commercial Bank', last4: '1234', seen: 9 }] })).toMatchObject({ ok: true, name: 'Commercial Bank', feeKey: 'Commercial Bank' });
        expect(detect({ text, books: [{ bank: 'Commercial Bank', last4: '1234', seen: 2 }] }).ok).toBe(false);      // seen twice might be a typo
    });
    it('an account number in the books is weaker than a card number: on its own it does not name a bank', () => {
        expect(detect({ text: 'Statement of account\nAccount No: 001234567890', books: [{ bank: 'Peoples Bank', last4: '7890', seen: 9 }] }).ok).toBe(false);
    });
    it('the books and the email history agreeing is enough on a statement that prints only an account number', () => {
        const r = detect({ text: 'Statement of account\nAccount No: 001234567890', books: [{ bank: 'Peoples Bank', last4: '7890', seen: 2 }], history: { last4: { '7890': { 'Peoples Bank': 3 } } } });
        expect(r).toMatchObject({ ok: true, name: 'Peoples Bank' });
    });
    it('a bank outside the fifteen is still a bank when the owner approved a sender for it', () => {
        const r = detect({ text: 'Cargills Bank Limited\nStatement of Account\nAccount No 12345678', history: { approved: ['Cargills Bank', 'Sampath Bank'] } });
        expect(r).toMatchObject({ ok: true, name: 'Cargills Bank', lockName: 'Cargills Bank', feeKey: 'Other' });
    });
    it('NTB: an AMEX card the books file under the American Express name keeps that name; one filed under the mail name keeps that', () => {
        expect(detect({ text: 'Nations Trust Bank PLC\nCard No: ************0276\nStatement Period 11/07/2026 - 10/08/2026', books: [{ bank: 'American Express (AMEX)', last4: '0276', seen: 40 }] })).toMatchObject({ ok: true, name: 'American Express (AMEX)', lockName: 'Nations Trust Bank (NTB)', product: 'amex' });
        expect(detect({ text: ntbAmex, books: [{ bank: 'Nations Trust Bank (NTB)', last4: '0276', seen: 40 }] })).toMatchObject({ ok: true, name: 'Nations Trust Bank (NTB)', lockName: 'Nations Trust Bank (NTB)' });
    });
    it('American Express beside a Nations Trust header is its card, not a second bank', () => {
        const r = detect({ text: ntbAmex });
        expect(r.ranked.map((x) => x.issuer)).not.toContain('American Express (AMEX)');
    });
    it('a plain American Express statement is American Express', () => {
        expect(detect({ text: 'American Express\nCard No: 3712 345678 91007\nCredit Limit 500,000\nStatement Period 01/08/2026 - 31/08/2026' })).toMatchObject({ ok: true, name: 'American Express (AMEX)' });
    });
});

describe('the card or account number', () => {
    it('a masked card number names its network from the first digits', () => {
        expect(tailsOf(ntbAmex, 'x')).toEqual([{ tail: '0276', kind: 'card', network: 'amex' }]);
        expect(tailsOf('Card No: 4111 11XX XXXX 1234')[0]).toMatchObject({ tail: '1234', network: 'visa-mc' });
        expect(tailsOf('Card No: 5412 34XX XXXX 9876')[0]).toMatchObject({ tail: '9876', network: 'visa-mc' });
    });
    it('a bare four-digit number is never a tail: a statement is full of years and amounts', () => {
        expect(tailsOf('Statement 2026\nOpening Balance 1500.00\nPage 1 of 2')).toEqual([]);
    });
    it('the networks', () => {
        expect(['376657', '34', '37'].map(networkOfBin)).toEqual(['amex', 'amex', 'amex']);
        expect(['4532', '4'].map(networkOfBin)).toEqual(['visa-mc', 'visa-mc']);
        expect(['5412', '2221', '2720'].map(networkOfBin)).toEqual(['visa-mc', 'visa-mc', 'visa-mc']);
        expect(['6011', '9', '', '51x', '2200'].map(networkOfBin)).toEqual(['', '', '', 'visa-mc', '']);
    });
});

describe('what it names lands on the registry lock the email sync uses', () => {
    /* The lock id is sha256(bank | last 4 | year | month). The email worker writes the ISSUER's label; the upload door passes `lockName`. They must normalise to one key. */
    const emailLabel = (inst) => inst.mailName || inst.name;
    it('for every institution, the label the upload door sends locks exactly where the email worker\'s label does', () => {
        for (const inst of INSTITUTIONS) {
            const r = detect({ text: `${inst.tokens[0]} Bank PLC\nCard No: ************1234\n`, filename: `${inst.tokens[0]} statement.pdf`, history: { approved: [emailLabel(inst)] } });
            expect(r.ok, inst.id).toBe(true);
            expect(bankKeyOf(r.lockName), inst.id).toBe(bankKeyOf(emailLabel(inst)));
        }
    });
    it('the two Nations Trust products are ONE bank to the lock — it is the issuer, not the card, that a statement belongs to', () => {
        const keys = new Set(INSTITUTIONS.filter((i) => /nations trust/i.test(i.name)).flatMap((i) => [bankKeyOf(i.name), bankKeyOf(i.mailName)]));
        expect(keys.size).toBe(1);
        expect([...keys][0]).toBe('ntb-amex');                       // the id every NTB statement the email sync ever filed already carries
    });
    it('every picker name still resolves to its own institution, and the fifteen labels fall on fourteen keys', () => {
        const keys = INSTITUTIONS.map((i) => bankKeyOf(i.name));
        expect(new Set(keys).size).toBe(INSTITUTIONS.length - 1);     // NTB's two products share one key
        for (const name of PICKER.filter((n) => n !== 'Other')) expect(bankIdentity(name).key, name).toMatch(/^[a-z0-9-]+$/);
    });
    it('a domain-style or bare label the email worker may write lands on the same key as the picker name', () => {
        expect(bankKeyOf('Nations Trust Bank')).toBe(bankKeyOf('Nations Trust Bank (NTB)'));
        expect(bankKeyOf('NTB')).toBe(bankKeyOf('Nations Trust Bank (NTB) — Visa/Mastercard'));
        expect(bankKeyOf('HNB')).toBe(bankKeyOf('Hatton National Bank (HNB)'));
        expect(bankKeyOf('Hnb')).toBe(bankKeyOf('Hatton National Bank (HNB)'));          // what a mail domain gives
        expect(bankKeyOf('Dfccbank')).toBe(bankKeyOf('DFCC Bank'));
        expect(bankKeyOf('Nationstrust')).toBe(bankKeyOf('Nations Trust Bank (NTB)'));
        expect(bankKeyOf('DFCC')).toBe(bankKeyOf('DFCC Bank'));
        expect(bankKeyOf('Cargills Bank')).toBe('cargills');           // a bank the registry does not know is keyed on its own name, as before
    });
    it('the same statement by hand and by email is the same lock id', () => {
        const byHand = detect({ text: ntbAmex });
        const month = { periodText: '11/07/2026 - 10/08/2026' };
        const hand = identityOf({ bank: byHand.lockName, account: '0276', ...month });
        const mail = identityOf({ bank: 'Nations Trust Bank (NTB)', account: '376657XXXXX0276', ...month });
        expect(hand.ok && mail.ok).toBe(true);
        expect(hand.id).toBe(mail.id);
    });
    it('the record label also lands on the same key as the issuer label, so a row filed under it is the same bank to every comparison', () => {
        for (const text of [ntbAmex, sampath, 'Seylan Bank PLC\nStatement\nCard No: ************5555']) {
            const r = detect({ text });
            expect(r.ok).toBe(true);
            expect(bankKeyOf(r.name)).toBe(bankKeyOf(r.lockName));
        }
    });
    it('when the bank is not identified the lock is asked for no bank at all (the sha lock still holds)', () => {
        const r = detect({ text: 'Statement of account\nAccount No 12345678' });
        expect(r.lockName).toBe('');
        expect(identityOf({ bank: r.lockName, account: '5678', periodText: '01/08/2026 - 31/08/2026' })).toMatchObject({ ok: false, reason: 'no-bank' });
    });
});

describe('the fee schedule is still the right one', () => {
    const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
    const keysOf = (table) => {
        const start = html.indexOf(`const ${table} = {`);
        expect(start, table).toBeGreaterThan(0);
        const body = html.slice(start, html.indexOf('};', start));
        return [...body.matchAll(/^\s*'([^']+)':\s*\{/gm)].map((m) => m[1]);
    };
    it('every feeKey the detector can return opens an entry of the cash-advance and fuel schedules', () => {
        const cash = keysOf('CC_CASH_ADVANCE_FEES'), fuel = keysOf('CC_FUEL_FEES');
        for (const inst of INSTITUTIONS) {
            const r = detect({ text: `${inst.tokens[0]} Bank PLC\nStatement of Account\nCard No: ${/amex|ntb-amex/.test(inst.id) ? '376657*****0276' : '4532 11XX XXXX 1234'}\n`, filename: `${inst.tokens[0]} statement.pdf` });
            expect(r.ok, inst.id).toBe(true);
            expect(cash, r.feeKey).toContain(r.feeKey);
            expect(fuel, r.feeKey).toContain(r.feeKey);
        }
        expect(cash).toContain('Other');
    });
    it('the picker name the detector uses for a record is the schedule\'s own key for every bank it knows', () => {
        const cash = keysOf('CC_CASH_ADVANCE_FEES');
        for (const inst of INSTITUTIONS) expect(cash, inst.id).toContain(inst.name);
    });
});
