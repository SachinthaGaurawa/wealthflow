/* =============================================================================
 * test/sms_templates_nic_test.js — the words of every message, and the NIC
 * -----------------------------------------------------------------------------
 * The wording is a contract with the tenant AND with the account's balance: every
 * notice must be plain GSM-7 (one Sinhala letter would quadruple its cost), must fit
 * the parts the design promises, and must carry nothing secret.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { KINDS, fmtMoney, fmtDay, fmtMonth, refCode, buildMessage, otpMessage, asciiOnly, currencyOf } from '../sms-templates.mjs';
import { analyzeSms } from '../textlk.mjs';
import { normalizeNic, maskNic } from '../wealthflow-nic.js';

const LINK = 'https://wealthflow-personal.vercel.app/t/AbCdEfGhIjKlMnOp';

describe('money, dates and references', () => {
    it('formats money by hand, the same on every Node build', () => {
        expect(fmtMoney(500000)).toBe('LKR 500,000.00');
        expect(fmtMoney(12.5, 'usd')).toBe('USD 12.50');
        expect(fmtMoney(1234567.891)).toBe('LKR 1,234,567.89');
        expect(fmtMoney(0.005)).toBe('LKR 0.01');
        expect(fmtMoney(-42)).toBe('-LKR 42.00');
        expect(fmtMoney('abc')).toBe('LKR 0.00');
    });
    it('lets only a 3-letter code into the currency slot', () => {
        expect(currencyOf('<script>')).toBe('LKR');
        expect(currencyOf('lkr')).toBe('LKR');
        expect(currencyOf(undefined)).toBe('LKR');
    });
    it('formats days and months as written, with no timezone shifting', () => {
        expect(fmtDay('2026-10-05')).toBe('05 Oct 2026');
        expect(fmtDay('2026-01-31T23:30:00.000Z')).toBe('31 Jan 2026');
        expect(fmtDay('garbage')).toBe('');
        expect(fmtMonth('2026-10')).toBe('Oct 2026');
        expect(fmtMonth('2026-13')).toBe('');
    });
    it('derives a short stable reference and never exposes the record id', () => {
        const a = refCode('investment', 'abc123xyz');
        expect(a).toMatch(/^INV-[0-9A-F]{6}$/);
        expect(a).toBe(refCode('investment', 'abc123xyz'));
        expect(a).not.toContain('abc123');
        expect(refCode('debtor', 'abc123xyz')).toMatch(/^DEB-[0-9A-F]{6}$/);
        expect(refCode('debtor', 'abc123xyz').slice(4)).not.toBe(a.slice(4));
    });
});

describe('every notice, word for word', () => {
    const base = { amount: 500000, currency: 'LKR', ref: 'INV-3F9A2B', dateISO: '2026-10-05', link: LINK };
    const cases = [
        [KINDS.A_CAPITAL, { ...base, ratePct: 24 }, `Capital LKR 500,000.00 recorded, ref INV-3F9A2B (24% p.a.). Statement: ${LINK}`],
        [KINDS.A_CAPITAL, { ...base }, `Capital LKR 500,000.00 recorded, ref INV-3F9A2B. Statement: ${LINK}`],
        [KINDS.A_INTEREST, { ...base, amount: 10000, month: '2026-10' }, `Interest LKR 10,000.00 applied to ref INV-3F9A2B for Oct 2026. Statement: ${LINK}`],
        [KINDS.A_RECEIPT, { ...base, amount: 10000 }, `Receipt: LKR 10,000.00 received on 05 Oct 2026, ref INV-3F9A2B. Statement: ${LINK}`],
        [KINDS.B_DISBURSED, { ...base, amount: 50000, ref: 'DEB-1A2B3C', balance: 50000 }, `Loan LKR 50,000.00 disbursed on 05 Oct 2026, ref DEB-1A2B3C. Balance LKR 50,000.00. Statement: ${LINK}`],
        [KINDS.B_DISBURSED, { ...base, amount: 20000, ref: 'DEB-1A2B3C', balance: 70000, further: true }, `Further loan LKR 20,000.00 disbursed on 05 Oct 2026, ref DEB-1A2B3C. Balance LKR 70,000.00. Statement: ${LINK}`],
        [KINDS.B_REPAYMENT, { ...base, amount: 20000, ref: 'DEB-1A2B3C', balance: 30000 }, `Repayment LKR 20,000.00 received on 05 Oct 2026, ref DEB-1A2B3C. Balance LKR 30,000.00. Statement: ${LINK}`],
        [KINDS.B_REPAYMENT, { ...base, amount: 30000, ref: 'DEB-1A2B3C', balance: 0, settled: true }, `Repayment LKR 30,000.00 received on 05 Oct 2026, ref DEB-1A2B3C. Balance LKR 0.00. Statement: ${LINK}`],      // the final receipt is a receipt: that the loan is closed is the next text
        [KINDS.B_CLOSED, { ...base, ref: 'DEB-1A2B3C', balance: 0 }, `Loan ref DEB-1A2B3C is fully settled and closed on 05 Oct 2026. Thank you. Statement: ${LINK}`],
        [KINDS.A_CLOSED, { ...base }, `Investment ref INV-3F9A2B is fully settled and closed on 05 Oct 2026. Thank you. Statement: ${LINK}`],
    ];
    cases.push(
        [KINDS.B_BALANCE, { ...base, ref: 'DEB-1A2B3C', balance: 30000 }, `Balance LKR 30,000.00 as at 05 Oct 2026, ref DEB-1A2B3C. Statement: ${LINK}`],
        [KINDS.B_BALANCE, { ...base, ref: 'DEB-1A2B3C', balance: 0 }, `No balance outstanding on ref DEB-1A2B3C as at 05 Oct 2026, thank you. Statement: ${LINK}`],
        [KINDS.B_BALANCE, { ...base, ref: 'DEB-1A2B3C', balance: 12750000.5, dateISO: '' }, `Balance LKR 12,750,000.50, ref DEB-1A2B3C. Statement: ${LINK}`],
    );
    cases.push(
        [KINDS.B_LATE, { ...base, ref: 'DEB-1A2B3C', balance: 25000, dateISO: '2026-10-10' }, `Reminder: LKR 25,000.00 is still outstanding, due 10 Oct 2026, ref DEB-1A2B3C. Statement: ${LINK}`],
        [KINDS.B_LATE, { ...base, ref: 'DEB-1A2B3C', balance: 987654321.99, dateISO: '2026-10-10' }, `Reminder: LKR 987,654,321.99 is still outstanding, due 10 Oct 2026, ref DEB-1A2B3C. Statement: ${LINK}`],
    );
    for (const [kind, ctx, expected] of cases) {
        it(`${kind}${ctx.further ? ' (further)' : ''}${ctx.settled ? ' (settled)' : ''}`, () => {
            const text = buildMessage(kind, ctx);
            expect(text).toBe(expected);
            const a = analyzeSms(text);
            expect(a.encoding, 'a notice must be plain GSM-7').toBe('GSM-7');
            expect(a.segments, `${text.length} chars`).toBe(1);
        });
    }

    it('a typical notice with the real link is ONE part', () => {
        for (const [kind, ctx] of cases) {
            if (ctx.ratePct || ctx.settled || ctx.further) continue;
            expect(analyzeSms(buildMessage(kind, ctx)).segments, kind).toBe(1);
        }
    });

    it('leaves the link out cleanly when there is none', () => {
        expect(buildMessage(KINDS.A_INTEREST, { ...base, link: '', month: '2026-10' })).toBe('Interest LKR 500,000.00 applied to ref INV-3F9A2B for Oct 2026.');
    });

    it('returns nothing for a kind it does not know', () => {
        expect(buildMessage('nonsense', base)).toBe('');
    });

    it('puts nothing but ASCII on the air, whatever it was given', () => {
        expect(asciiOnly('Café සිංහල \u{1F600}\ttab\nnew')).toBe('Caf tab new');
        const t = buildMessage(KINDS.A_RECEIPT, { ...base, ref: 'INV-සAAA' });
        expect(/^[\x20-\x7E]+$/.test(t)).toBe(true);
    });

    it('never contains an NIC-shaped number or a name field', () => {
        for (const [kind, ctx] of cases) {
            const t = buildMessage(kind, { ...ctx, nic: '198534000937', name: 'Nimal' });
            expect(t).not.toMatch(/\d{9}[VX]|\b\d{12}\b/);
            expect(t).not.toContain('Nimal');
        }
    });
});

describe('the one-time code message', () => {
    it('says what it is, how long it lasts and never to share it', () => {
        const t = otpMessage('048213', 3);
        expect(t).toBe('048213 is your WealthFlow verification code. It expires in 3 minutes. Do not share it with anyone.');
        expect(analyzeSms(t).segments).toBe(1);
    });
    it('keeps only the digits of the code', () => {
        expect(otpMessage('12 34-56')).toContain('123456 is your');
    });
});

describe('Sri Lankan NIC', () => {
    it('accepts the old shape and converts it to the new', () => {
        const n = normalizeNic('853400937V');
        expect(n).toMatchObject({ ok: true, format: 'old', birthYear: 1985, dayOfYear: 340, female: false });
        expect(n.canonical).toBe('198534000937');
    });
    it('treats the old and new spellings of one number as the same person', () => {
        expect(normalizeNic('853400937v').canonical).toBe(normalizeNic('198534000937').canonical);
        expect(normalizeNic('853400937X').canonical).toBe('198534000937');
    });
    it('reads the 500 added for women', () => {
        const n = normalizeNic('906400937V');           // 640 = 500 + day 140
        expect(n).toMatchObject({ ok: true, female: true, dayOfYear: 140, birthYear: 1990 });
    });
    it('ignores spaces, dots and dashes', () => {
        expect(normalizeNic(' 1985-3400-0937 ').canonical).toBe('198534000937');
        expect(normalizeNic('85.3400937 V').ok).toBe(true);
    });
    it('refuses what is not an NIC', () => {
        for (const bad of ['', '12345', '85340093V', '8534009371V', '19853400093', '1985340009371', 'ABCDEFGHIJKL', '853670937V', '858670937V', '198500000937', '200086700000', '21001234567X']) {
            expect(normalizeNic(bad).ok, bad).toBe(false);
        }
    });
    it('masks all but the last three characters', () => {
        expect(maskNic('853400937V')).toBe('*********937');
        expect(maskNic('x')).toBe('***');
    });
});

describe('one part, with the statement link', () => {
    const link = 'https://wealthflow-personal.vercel.app/t/AbCdEfGhIjKlMnOp';
    const parts = (m) => analyzeSms(m).segments;

    it('every notice with a typical amount is one part, link included', () => {
        for (const kind of ['A.capital', 'A.interest', 'A.receipt', 'B.disbursed', 'B.repayment']) {
            const m = buildMessage(kind, { amount: 250000, currency: 'LKR', ref: 'DEB-96E5C2', ratePct: 24, month: '2026-10', dateISO: '2026-10-05', balance: 250000, link, further: true });
            expect(parts(m), kind).toBe(1);
            expect(m, kind).toContain(link);
        }
    });

    it('drops the date, and only the date, when a long amount would cost a second part', () => {
        const ctx = { amount: 1234567.5, currency: 'LKR', ref: 'DEB-96E5C2', dateISO: '2026-10-05', balance: 1234567.5, link, further: true };
        const m = buildMessage('B.disbursed', ctx);
        expect(parts(m)).toBe(1);
        expect(m).toContain(link);
        expect(m).toContain('DEB-96E5C2');
        expect(m).not.toContain('2026');
        // without a link nothing is trimmed
        expect(buildMessage('B.disbursed', { ...ctx, link: '' })).toContain('05 Oct 2026');
    });

    it('leaves a message alone when dropping the date would not save a part', () => {
        const ctx = { amount: 123456789012.5, currency: 'LKR', ref: 'DEB-96E5C2', dateISO: '2026-10-05', balance: 123456789012.5, link, further: true };
        const m = buildMessage('B.disbursed', ctx);
        expect(m).toContain(link);
        expect(parts(m)).toBeLessThanOrEqual(2);
    });
});
