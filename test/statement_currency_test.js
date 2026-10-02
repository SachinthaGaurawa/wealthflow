import { describe, it, expect } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { adaptiveRead, linesOf, moneyIn, isMovementLine, amountForms, resolveCurrency, statementKey } from '../statement-adaptive.mjs';
import { CURRENCIES, isCurrencyCode, decimalsOf, discoverCurrency, decimalToMinor, minorToString, minorToNumber, sameCurrency } from '../statement-currency.mjs';

/* =============================================================================
 * WHICH MONEY IS THIS, AND HOW FINELY IS IT COUNTED.
 *
 * A yen statement has no cents; a Kuwaiti dinar statement has three decimals; a rupee statement has two. Counting "cents"
 * everywhere gets a yen balance wrong by a factor of a hundred and a dinar balance by ten — and the books "balance" in the wrong
 * unit. The currency is discovered from the document, amounts are integers of the currency's own minor unit (BigInt: no
 * floating-point sum or comparison anywhere), and a statement in a currency other than the account's is never filed into it.
 * ===========================================================================*/

describe('ISO 4217 table', () => {
    it('knows the zero-, two- and three-decimal currencies', () => {
        for (const c of ['JPY', 'KRW', 'VND', 'ISK', 'CLP', 'UGX']) expect(decimalsOf(c), c).toBe(0);
        for (const c of ['KWD', 'BHD', 'OMR', 'JOD', 'TND', 'IQD', 'LYD']) expect(decimalsOf(c), c).toBe(3);
        for (const c of ['LKR', 'USD', 'EUR', 'GBP', 'INR', 'AUD', 'SGD', 'CHF', 'AED', 'SAR']) expect(decimalsOf(c), c).toBe(2);
    });
    it('is exact about what is a code: three upper-case letters in the table, nothing else', () => {
        for (const c of ['LKR', 'JPY', 'KWD']) expect(isCurrencyCode(c)).toBe(true);
        for (const c of ['lkr', 'ABC', 'RS', 'LKRR', '', null, undefined, 5, 'toString', '__proto__', 'constructor']) expect(isCurrencyCode(c), String(c)).toBe(false);
        expect(Object.keys(CURRENCIES).length).toBeGreaterThan(150);
    });
    it('an unknown code counts in hundredths, the common case', () => { expect(decimalsOf('XXX')).toBe(2); expect(decimalsOf('')).toBe(2); expect(decimalsOf(null)).toBe(2); });
    it('compares the account\'s currency case-blind; an unknown statement currency never conflicts', () => {
        expect(sameCurrency('lkr', 'LKR')).toBe(true); expect(sameCurrency('', 'LKR')).toBe(true); expect(sameCurrency('USD', 'LKR')).toBe(false);
        expect(sameCurrency('MIXED', 'LKR')).toBe(false); expect(sameCurrency('LKR')).toBe(true);
    });
});

describe('exact decimal arithmetic on the minor unit', () => {
    it('reads a decimal into integers of the minor unit, never rounding', () => {
        expect(decimalToMinor('1234.50', 2)).toBe(123450n);
        expect(decimalToMinor(1234.5, 2)).toBe(123450n);
        expect(decimalToMinor('1,234.50', 2)).toBe(123450n);
        expect(decimalToMinor('1234', 0)).toBe(1234n);
        expect(decimalToMinor('1234.000', 0)).toBe(1234n);
        expect(decimalToMinor('1234.567', 3)).toBe(1234567n);
        expect(decimalToMinor('-0.05', 2)).toBe(-5n);
        expect(decimalToMinor(0, 2)).toBe(0n);
        expect(decimalToMinor('12.345', 2)).toBeNull();           // not 12.35: refused
        expect(decimalToMinor('1234.5', 0)).toBeNull();
        expect(decimalToMinor('1234.5678', 3)).toBeNull();
        for (const bad of ['', 'abc', '1e3', '1.2.3', '--1', NaN, Infinity, null, undefined, {}, [], true]) expect(decimalToMinor(bad, 2), String(bad)).toBeNull();
    });
    it('the floating-point traps are exact: 0.1 + 0.2, 1.005, 4.35 × 100, 1.15', () => {
        expect(decimalToMinor(0.1, 2) + decimalToMinor(0.2, 2)).toBe(decimalToMinor(0.3, 2));
        expect(decimalToMinor('1.005', 3)).toBe(1005n);
        expect(decimalToMinor(4.35, 2)).toBe(435n);
        expect(decimalToMinor(1.15, 2)).toBe(115n);
        expect(decimalToMinor(8.2 - 0.2 + 0.3, 2)).toBeNull();     // 8.299999999999999 is not an amount: the caller's float is the bug, and it is refused, not rounded
    });
    it('writes minor units back as the decimal a person would write', () => {
        expect(minorToString(123450n, 2)).toBe('1234.50'); expect(minorToString(5n, 2)).toBe('0.05'); expect(minorToString(-5n, 2)).toBe('-0.05');
        expect(minorToString(1234n, 0)).toBe('1234'); expect(minorToString(1234567n, 3)).toBe('1234.567'); expect(minorToString(7n, 3)).toBe('0.007'); expect(minorToString(0n, 2)).toBe('0.00');
        expect(minorToNumber(123450n, 2)).toBe(1234.5);
    });
    it('round-trips every amount, in every currency size, exactly', () => {
        let s = 1234567;
        const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s; };
        for (const d of [0, 2, 3]) for (let i = 0; i < 2000; i++) {
            const minor = BigInt(next()) * BigInt(next() % 1000) + BigInt(next() % 7);
            expect(decimalToMinor(minorToString(minor, d), d)).toBe(minor);
            expect(decimalToMinor(minorToString(-minor, d), d)).toBe(-minor);
        }
    });
});

describe('the currency is discovered from the document', () => {
    const lines = (...l) => l.flat();
    it('an ISO code printed on the page', () => {
        expect(discoverCurrency(lines('ACCOUNT STATEMENT', 'Currency: LKR', '01/03/2026 SHOP 1,000.00 LKR')).code).toBe('LKR');
        const jp = discoverCurrency(lines('口座明細', 'Currency JPY', '2026/03/05 STORE 1,234 JPY')); expect(jp).toMatchObject({ code: 'JPY', decimals: 0, confidence: 'high' });
        expect(discoverCurrency(lines('Statement', 'KWD', '05/03/2026 SHOP 12.345 KWD')).decimals).toBe(3);
    });
    it('a symbol that means one thing', () => {
        expect(discoverCurrency(lines('Total €1.234,50', 'Saldo € 12,00')).code).toBe('EUR');
        expect(discoverCurrency(lines('Balance £100.00', '£20.00')).code).toBe('GBP');
        expect(discoverCurrency(lines('Balance US$100.00')).code).toBe('USD');
        expect(discoverCurrency(lines('残高 ¥1,234')).code).toBe('JPY');
    });
    it('the share decides, not the first hit: a rupee statement that mentions USD in a fee line is in rupees', () => {
        const doc = lines('NATIONS TRUST BANK', 'Statement in LKR', Array.from({ length: 30 }, (_, i) => `0${1 + (i % 9)}/03/2026 SHOP ${i} ${100 + i}.00 LKR`), '12/03/2026 FOREIGN FEE 5.00 USD');
        expect(discoverCurrency(doc).code).toBe('LKR');
    });
    it('a bare "Rs." is read as LKR (the owner\'s currency) but flagged as only a guess; a bare "$" as USD, also a guess', () => {
        expect(discoverCurrency(lines('Total Rs. 1,000.00')).code).toBe('LKR'); expect(discoverCurrency(lines('Total Rs. 1,000.00')).confidence).toBe('low');
        expect(discoverCurrency(lines('Total $ 100.00')).code).toBe('USD'); expect(discoverCurrency(lines('Total $ 100.00')).confidence).toBe('low');
    });
    it('nothing printed: no claim at all, and two decimals', () => {
        expect(discoverCurrency(lines('Statement', '01/03/2026 SHOP 100.00'))).toMatchObject({ code: '', decimals: 2, confidence: 'low' });
        expect(discoverCurrency('')).toMatchObject({ code: '' });
        expect(discoverCurrency(null)).toMatchObject({ code: '' });
    });
    it('three capitals that are not a currency are not one (the bank\'s own initials, a month, a reference)', () => {
        expect(discoverCurrency(lines('HNB STATEMENT', 'REF ABC', 'DEC 2026', 'ATM TXN CRD')).code).toBe('');
    });
});

describe('amounts in the minor unit of each currency', () => {
    it('two places: grouped western, plain, dot-grouped decimal comma — and dates are never money', () => {
        expect(moneyIn('05/03/2026 SHOP 1,234.50 98,765.43')).toEqual([123450, 9876543]);
        expect(moneyIn('05.03.2026 SHOP 1.234,50')).toEqual([123450]);
        expect(moneyIn('05/03/2026 SHOP 12.34')).toEqual([1234]);
    });
    it('no places: whole numbers, grouped any way, never a date or a year or a short reference', () => {
        expect(moneyIn('2026/03/05 STORE 1,234,567 9,000,000', 0)).toEqual([1234567, 9000000]);
        expect(moneyIn('05.03.2026 STORE 1.234.567', 0)).toEqual([1234567]);
        expect(moneyIn('05/03/2026 STORE 120', 0)).toEqual([120]);
        expect(moneyIn('05/03/2026 REF 12', 0)).toEqual([]);
    });
    it('three places: "1,234.567" is one thousand two hundred thirty-four and 567 thousandths; "1,234" is a thousand, never 1.234', () => {
        expect(moneyIn('05/03/2026 SHOP 1,234.567', 3)).toEqual([1234567]);
        expect(moneyIn('05/03/2026 SHOP 1.234,567', 3)).toEqual([1234567]);
        expect(moneyIn('05/03/2026 SHOP 1,234', 3)).toEqual([]);
    });
    it('forms an amount is printed in, per currency, from the exact integer', () => {
        expect(amountForms(123450, 2)).toEqual(expect.arrayContaining(['1234.50', '1,234.50', '1.234,50']));
        expect(amountForms(1234567, 0)).toEqual(expect.arrayContaining(['1234567', '1,234,567', '1.234.567']));
        expect(amountForms(1234567, 3)).toEqual(expect.arrayContaining(['1234.567', '1,234.567', '1.234,567']));
        expect(amountForms(9007199254740, 2)[0]).toBe('90071992547.40');
    });
    it('a movement line in yen has no decimals and is still a movement line', () => {
        expect(isMovementLine('05/03/2026 STORE 1,234', 0)).toBe(true);
        expect(isMovementLine('05/03/2026 STORE 1,234', 2)).toBe(false);
    });
});

describe('which currency a reading is in: the document decides, the model is believed only where the document backs it', () => {
    const lk = discoverCurrency(['NTB', 'Statement in LKR', ...Array.from({ length: 10 }, (_, i) => `0${1 + (i % 9)}/03/2026 SHOP ${100 + i}.00 LKR`)]);
    it('no claim → what the document shows; the same claim → that; no currency on the page → the claim is dropped', () => {
        expect(resolveCurrency(null, lk, []).code).toBe('LKR');
        expect(resolveCurrency('LKR', lk, []).code).toBe('LKR');
        expect(resolveCurrency('lkr', lk, []).code).toBe('LKR');
        expect(resolveCurrency('LKR', discoverCurrency(['x']), ['x']).code).toBe('');
    });
    it('a clearly different currency than the page shows is a PROBLEM, not an answer', () => {
        const r = resolveCurrency('USD', lk, []);
        expect(r.problem).toMatch(/USD/); expect(r.code).toBe('LKR'); expect(r.decimals).toBe(2);
    });
    it('an unclear page: the claim holds only if the code is printed on it', () => {
        const mixed = discoverCurrency(['Statement', '01/03/2026 A 10.00 LKR', '02/03/2026 B 10.00 USD']);
        expect(mixed.confidence).not.toBe('high');
        expect(resolveCurrency('USD', mixed, ['01/03/2026 A 10.00 LKR', '02/03/2026 B 10.00 USD']).code).toBe('USD');
        expect(resolveCurrency('EUR', mixed, ['01/03/2026 A 10.00 LKR', '02/03/2026 B 10.00 USD']).code).toBe(mixed.code);
    });
    it('a claim that is not a currency at all is ignored', () => {
        expect(resolveCurrency('RS', lk, []).code).toBe('LKR'); expect(resolveCurrency('<script>', lk, []).code).toBe('LKR'); expect(resolveCurrency(42, lk, []).code).toBe('LKR');
    });
});

/* ── a statement in any currency, read by a model that may lie ─────────────────────────────────────────────────────── */

function rng(seed) { let s = (seed * 2654435761) >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const group = (digits, sep) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
const printMoney = (minor, d, style = 'western') => {
    const [i, f] = minorToString(minor, d).split('.');
    return style === 'euro' ? group(i, '.') + (f ? ',' + f : '') : group(i, ',') + (f ? '.' + f : '');
};

/** A bank statement in `code`, laid out as columns [date, description, amount, balance]; returns the document and the exact truth. */
function statement(seed, { code = 'LKR', decimals = decimalsOf(code), n = 9, head = code, style = 'western', symbol = '', scale = 1000n, extraHead = [], es = false } = {}) {
    const r = rng(seed), D = decimals;
    const names = ['PICK N PAY SUPERMARKET', 'SALARY CREDIT ACME LTD', 'ATM WITHDRAWAL COLOMBO', 'ELECTRICITY BOARD BILL', 'ONLINE TRANSFER TO J SILVA', 'FUEL STATION KANDY', 'INTEREST PAID', 'RESTAURANT GRAND ORIENTAL', 'MOBILE RELOAD', 'INSURANCE PREMIUM'];
    const unit = 10n ** BigInt(D);
    const opening = BigInt(Math.floor(2000 + r() * 8000)) * unit * scale + BigInt(Math.floor(r() * 997));
    const MONTH = es ? 4 : 3, SPANISH_ABR = 'abr';
    const lines = es
        ? ['BANCO DEL SUR', 'Extracto de cuenta', ...(head ? [`Moneda: ${head}`] : []), ...extraHead, 'Cuenta: 1234567890', 'Periodo: 01 abr 2026 - 30 abr 2026', `Saldo inicial ${symbol}${printMoney(opening, D, style)}`, 'Fecha Concepto Importe Saldo']
        : ['FIRST HERITAGE BANK', 'ACCOUNT STATEMENT', ...(head ? [`Statement currency: ${head}`] : []), ...extraHead, 'Account: 1234567890', 'Period: 01/03/2026 - 31/03/2026', `Opening balance ${symbol}${printMoney(opening, D, style)}`];
    let bal = opening;
    const rows = [];
    for (let i = 0; i < n; i++) {
        const amount = BigInt(Math.floor(5 + r() * 400)) * unit * (scale / 10n || 1n) + BigInt(Math.floor(r() * 973));
        const credit = r() < 0.35 || bal < amount;
        bal += credit ? amount : -amount;
        const day = String(1 + i * 3).padStart(2, '0');
        const date = es ? `${day} ${SPANISH_ABR} 2026` : `${day}/03/2026`, description = `${names[i % names.length]} ${String.fromCharCode(65 + i)}`;
        lines.push(`${date} ${description} ${symbol}${printMoney(amount, D, style)} ${symbol}${printMoney(bal, D, style)}`);
        rows.push({ date: `2026-0${MONTH}-${day}`, dateText: date, description, amount, direction: credit ? 'credit' : 'debit', balance: bal, line: lines.length });
    }
    lines.push(`${es ? 'Saldo final' : 'Closing balance'} ${symbol}${printMoney(bal, D, style)}`);
    return { text: lines.join('\n'), lines, opening, closing: bal, rows, decimals: D, code };
}

/** A model that answers from the truth, honestly unless told to lie. */
function model(stmt, { currency = stmt.code, lie = null } = {}) {
    const calls = [];
    const ask = async (prompt) => {
        calls.push(prompt);
        const D = stmt.decimals;
        const rows = stmt.rows.map(x => ({ line: x.line, date: x.date, dateText: x.dateText, description: x.description, debit: x.direction === 'debit' ? minorToString(x.amount, D) : 0, credit: x.direction === 'credit' ? minorToString(x.amount, D) : 0, balance: minorToString(x.balance, D) }));
        if (lie === 'yen-with-cents') rows[0].debit = rows[0].debit ? rows[0].debit + '.50' : 0;
        if (lie === 'rounded-to-two') for (const row of rows) { row.debit = row.debit ? Number(row.debit).toFixed(2) : 0; row.credit = row.credit ? Number(row.credit).toFixed(2) : 0; }
        const m = stmt.rows[0].date.slice(5, 7), end = m === '04' ? '30' : '31';
        return JSON.stringify({ accounts: [{ account: '1234567890', type: 'bank', opening: minorToString(stmt.opening, D), closing: minorToString(stmt.closing, D), currency, periodStart: `2026-${m}-01`, periodEnd: `2026-${m}-${end}`, rows }] });
    };
    return { ask, calls };
}

const read = (stmt, opts) => adaptiveRead({ text: stmt.text, ask: model(stmt, opts).ask, uid: 'u' });
const exact = (res, stmt) => {
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const got = res.parsed.rows.map(r => [r.date, BigInt(Math.round(r.amount * 10 ** stmt.decimals)), r.direction]);
    expect(got).toEqual(stmt.rows.map(r => [r.date, r.amount, r.direction]));
    expect(res.parsed.reconciliation).toMatchObject({ ok: true, difference: 0 });
    expect(decimalToMinor(res.parsed.reconciliation.opening, stmt.decimals)).toBe(stmt.opening);
    expect(decimalToMinor(res.parsed.reconciliation.closing, stmt.decimals)).toBe(stmt.closing);
};

describe('a statement in any currency is read exactly, in that currency\'s own units', () => {
    const CASES = [
        { code: 'LKR', style: 'western' }, { code: 'USD', style: 'western' }, { code: 'GBP', style: 'western' }, { code: 'EUR', style: 'euro' }, { code: 'INR', style: 'western' },
        { code: 'JPY', style: 'western' }, { code: 'KRW', style: 'western' }, { code: 'VND', style: 'euro' },
        { code: 'KWD', style: 'western' }, { code: 'BHD', style: 'western' }, { code: 'OMR', style: 'euro' },
    ];
    for (const c of CASES) for (const seed of [1, 2, 3, 4, 5, 6]) {
        it(`${c.code} (${decimalsOf(c.code)} decimals, ${c.style}) seed ${seed}`, async () => {
            const stmt = statement(seed, c);
            const res = await read(stmt);
            exact(res, stmt);
            expect(res.parsed.layout.currency).toBe(c.code);
            expect(res.parsed.rows.every(r => r.currency === c.code)).toBe(true);
        });
    }
    it('the model says nothing about the currency: it is discovered from the page', async () => {
        for (const code of ['JPY', 'KWD', 'USD']) { const stmt = statement(7, { code }); const res = await read(stmt, { currency: null }); exact(res, stmt); expect(res.parsed.layout.currency).toBe(code); }
    });
    it('only a symbol is printed (€, £, ¥): the symbol names the currency', async () => {
        const eur = statement(8, { code: 'EUR', head: '', symbol: '€', style: 'euro' }); const a = await read(eur, { currency: null }); exact(a, eur); expect(a.parsed.layout.currency).toBe('EUR');
        const gbp = statement(9, { code: 'GBP', head: '', symbol: '£' }); const b = await read(gbp, { currency: null }); exact(b, gbp); expect(b.parsed.layout.currency).toBe('GBP');
    });
    it('"Rs." on a Sri Lankan statement is LKR', async () => {
        const stmt = statement(10, { code: 'LKR', head: '', symbol: 'Rs. ' }); const res = await read(stmt, { currency: null }); exact(res, stmt); expect(res.parsed.layout.currency).toBe('LKR');
    });
    it('a statement that prints no currency at all is read as before, with no currency claimed', async () => {
        const stmt = statement(11, { code: 'LKR', head: '' }); const res = await read(stmt, { currency: null }); exact(res, stmt); expect(res.parsed.layout.currency).toBeUndefined();
    });
    it('amounts far beyond what a float holds comfortably are exact (hundreds of billions)', async () => {
        for (const code of ['LKR', 'JPY', 'KWD']) { const stmt = statement(12, { code, scale: 100_000_000n }); const res = await read(stmt); exact(res, stmt); }
    });
    it('an amount past 2^53 minor units is refused, not silently rounded', async () => {
        const stmt = statement(13, { code: 'LKR', scale: 1_000_000_000_000_000n });
        const res = await read(stmt);
        expect(res.ok).toBe(false);
    });
});

describe('a model that lies about the money is caught', () => {
    it('names another currency than the one the page is printed in: rejected, never accepted as either', async () => {
        const stmt = statement(21, { code: 'LKR', n: 12 });
        const res = await read(stmt, { currency: 'USD' });
        expect(res.ok).toBe(false);
        expect(res.problems.join(' ')).toMatch(/USD/);
    });
    it('names a currency that is not on the page at all, on a page that names none: the claim is dropped and the statement is read as before', async () => {
        const stmt = statement(22, { code: 'LKR', head: '' });
        const res = await read(stmt, { currency: 'JPY' });
        exact(res, stmt);
        expect(res.parsed.layout.currency).toBeUndefined();
    });
    it('names a yen amount with cents: the amount is not exact in that currency, so it is not accepted', async () => {
        const stmt = statement(23, { code: 'JPY' });
        const res = await read(stmt, { lie: 'yen-with-cents' });
        // the first reading is refused; a later attempt may be honest, and then it is exact — never the lie
        if (res.ok) exact(res, stmt); else expect(res.ok).toBe(false);
    });
    it('rounds dinar amounts to two places: a figure that is not on the page is not accepted', async () => {
        const stmt = statement(24, { code: 'KWD' });
        const res = await adaptiveRead({ text: stmt.text, ask: model(stmt, { lie: 'rounded-to-two' }).ask, uid: 'u' });
        // the model's rounded figures are refused; the rules, reading the page's own three-decimal figures, get them exactly
        if (res.ok) { expect(res.parsed.adaptive.strategy).toBe('programmatic'); exact(res, stmt); }
    });
    it('whatever it says about currency, an accepted reading is the statement and its currency is the page\'s', async () => {
        for (let seed = 30; seed < 70; seed++) {
            const code = ['LKR', 'USD', 'JPY', 'KWD', 'EUR'][seed % 5];
            const stmt = statement(seed, { code, style: code === 'EUR' ? 'euro' : 'western' });
            const claim = [code, null, 'USD', 'JPY', 'KWD', 'XXX', 'lkr', 'EUR', 'MIXED'][seed % 9];
            const res = await adaptiveRead({ text: stmt.text, ask: model(stmt, { currency: claim }).ask, uid: 'u' });
            if (res.ok) { exact(res, stmt); expect(res.parsed.layout.currency).toBe(code); }
        }
    });
});

describe('two currencies on one document', () => {
    it('is never one currency: the layout says MIXED and carries no sum across them', async () => {
        const a = statement(41, { code: 'LKR' }), b = statement(42, { code: 'USD' });
        // two sections of one document, each in its own currency, equally prominent
        const shift = a.lines.length;
        const text = [...a.lines, ...b.lines].join('\n');
        const reply = JSON.stringify({ accounts: [
            { account: '1111111111', type: 'bank', opening: minorToString(a.opening, 2), closing: minorToString(a.closing, 2), currency: 'LKR', periodStart: '2026-03-01', periodEnd: '2026-03-31',
                rows: a.rows.map(x => ({ line: x.line, date: x.date, dateText: x.dateText, description: x.description, debit: x.direction === 'debit' ? minorToString(x.amount, 2) : 0, credit: x.direction === 'credit' ? minorToString(x.amount, 2) : 0, balance: minorToString(x.balance, 2) })) },
            { account: '2222222222', type: 'bank', opening: minorToString(b.opening, 2), closing: minorToString(b.closing, 2), currency: 'USD', periodStart: '2026-03-01', periodEnd: '2026-03-31',
                rows: b.rows.map(x => ({ line: x.line + shift, date: x.date, dateText: x.dateText, description: x.description, debit: x.direction === 'debit' ? minorToString(x.amount, 2) : 0, credit: x.direction === 'credit' ? minorToString(x.amount, 2) : 0, balance: minorToString(x.balance, 2) })) },
        ] });
        const res = await adaptiveRead({ text, ask: async () => reply, uid: 'u' });
        if (res.ok) {
            expect(res.parsed.layout.currency).toBe('MIXED');
            expect(res.parsed.reconciliation.opening).toBeUndefined();
            expect(res.parsed.reconciliation).toMatchObject({ ok: true, accounts: 2 });
        } else {
            // refused is also safe: what matters is that two currencies are never presented as one
            expect(res.ok).toBe(false);
        }
    });
});

describe('the composite key tells currencies apart', () => {
    it('the same account, period and closing figure in two currencies are two statements', () => {
        const base = { uid: 'u', account: '1234567890', start: '2026-03-01', closing: 1000 };
        expect(statementKey({ ...base, currency: 'LKR' })).not.toBe(statementKey({ ...base, currency: 'USD' }));
        expect(statementKey({ ...base, currency: 'LKR' })).toBe(statementKey({ ...base, currency: 'lkr' }));
        expect(statementKey({ ...base, currency: 'LKR' })).toMatch(/^[0-9a-f]{64}$/);
    });
    it('and other users, accounts, periods and balances', () => {
        const base = { uid: 'u', account: '1234567890', start: '2026-03-01', closing: 1000, currency: 'LKR' };
        const keys = new Set([base, { ...base, uid: 'v' }, { ...base, account: '1234567891' }, { ...base, start: '2026-04-01' }, { ...base, closing: 1000.01 }].map(statementKey));
        expect(keys.size).toBe(5);
    });
});

/* ── the worker: a statement in another currency is not filed into the account ───────────────────────────────────────── */

const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
function world({ stmt, settings, extract }) {
    const html = '<html><body>' + stmt.lines.map(l => '<p>' + l + '</p>').join('') + '</body></html>';
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@bank.example', kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ...(settings ? { settings } : {}) },
        [sourcePath]: { uid: 'u', bank: 'First Heritage', filename: 'statement_march.html', from: 'statements@bank.example', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
    });
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = async () => ({ bytes: Buffer.from(html), filename: 'statement_march.html', contentSha256: 'x' });
    const drain = async () => { let last; for (let i = 0; i < 8; i++) { last = await runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open: async () => [{ password: 'x', bank: 'First Heritage' }], settle: settleStatement, board: async () => { throw new Error('ai-consensus-unavailable'); }, extract, loadAttachment, maxSteps: 1 }); if (['filed', 'needs_review', 'rejected_non_statement'].includes(last.status)) break; } return last; };
    return { db, data, drain, source: () => data.get(sourcePath), user: () => data.get('users/u'), reviews: () => [...data.entries()].filter(([k]) => k.startsWith('users/u/statementReview/')).map(([, v]) => v) };
}

describe('the worker never files a statement in another currency into the account', () => {
    it('a USD statement for a rupee account goes to the owner with the reason named, and nothing reaches the ledger', async () => {
        const stmt = statement(51, { code: 'USD', es: true });
        const w = world({ stmt, extract: model(stmt).ask });
        const out = await w.drain();
        expect(out.status).toBe('needs_review');
        expect(w.source()).toMatchObject({ status: 'needs_review', reviewReason: 'statement-currency-differs', filed: false });
        expect(w.reviews().some(r => r.reason === 'statement-currency-differs')).toBe(true);
        expect([...w.user().expenses, ...w.user().incomeRecv, ...w.user().cconetime, ...w.user().ccPayments]).toEqual([]);
    });
    it('the same statement for an account kept in dollars is filed', async () => {
        const stmt = statement(51, { code: 'USD', es: true });
        const w = world({ stmt, settings: { currency: 'USD' }, extract: model(stmt).ask });
        const out = await w.drain();
        expect(out.status, JSON.stringify({ out, src: w.source() })).toBe('filed');
        expect([...w.user().expenses, ...w.user().incomeRecv].length).toBe(stmt.rows.length);      // a transfer to or from someone else is spending or income like any other row
    });
    it('a rupee statement for a rupee account is filed, and one that names no currency is too', async () => {
        for (const head of ['LKR', '']) {
            const stmt = statement(52, { code: 'LKR', head, es: true });
            const w = world({ stmt, extract: model(stmt, { currency: head ? 'LKR' : null }).ask });
            const out = await w.drain();
            expect(out.status, head).toBe('filed');
            expect([...w.user().expenses, ...w.user().incomeRecv].length).toBe(stmt.rows.length);      // a transfer to or from someone else is spending or income like any other row
        }
    });
    it('the statement\'s composite key is on the item, whichever reader produced it', async () => {
        const stmt = statement(53, { code: 'LKR', es: true });
        const w = world({ stmt, extract: model(stmt).ask });
        await w.drain();
        expect(w.source().statementKey).toMatch(/^[0-9a-f]{64}$/);
        expect(w.source().proof.key).toBe(w.source().statementKey);
    });
});

describe('a rule-based reader names no currency, so the page is asked', () => {
    const none = async () => { throw new Error('no model'); };
    it('a statement the rules read, printed in dollars for a rupee account, is held back — whatever it adds up to', async () => {
        const stmt = statement(61, { code: 'USD', n: 8 });
        const w = world({ stmt, extract: none });
        const out = await w.drain();
        expect(out.status).toBe('needs_review');
        expect(w.source()).toMatchObject({ reviewReason: 'statement-currency-differs', filed: false });
        expect([...w.user().expenses, ...w.user().incomeRecv, ...w.user().cconetime, ...w.user().ccPayments]).toEqual([]);
    });
    it('the same statement in rupees is filed', async () => {
        const stmt = statement(61, { code: 'LKR', n: 8 });
        const w = world({ stmt, extract: none });
        expect((await w.drain()).status).toBe('filed');
    });
    it('a statement held back as "another currency" before the rule was made stricter is read again by the automatic pass, and filed', async () => {
        const stmt = statement(68, { code: 'LKR', head: '', n: 8, extraHead: ['ALL transactions are subject to the bank\'s terms and conditions'] });
        const w = world({ stmt, extract: none });
        // how the old rule left it: a whole-statement review, nothing filed
        const reviewPath = 'users/u/statementReview/old';
        w.data.set(sourcePath, { ...w.source(), status: 'needs_review', reviewReason: 'statement-currency-differs', hasReview: true });
        w.data.set(reviewPath, { uid: 'u', sourcePath, index: -1, status: 'pending', reason: 'statement-currency-differs' });
        const { recoverWholeStatementFailures } = await import('../statement-sync.js');
        expect(await recoverWholeStatementFailures({ db: w.db, uid: 'u' })).toEqual({ recovered: 1, more: false });
        expect((await w.drain()).status).toBe('filed');
    });
    it('a currency code that is an ordinary English word in the small print ("ALL …") is a word, not a currency (NTB consolidated FEB, 2026-10-01)', async () => {
        const stmt = statement(66, { code: 'LKR', head: '', n: 8, extraHead: ['ALL transactions are subject to the bank\'s terms and conditions'] });
        const w = world({ stmt, extract: none });
        expect((await w.drain()).status).toBe('filed');
    });
    it('…while a foreign code printed beside the amounts still holds the statement back, labelled or not', async () => {
        const beside = world({ stmt: statement(67, { code: 'USD', head: '', symbol: 'USD ', n: 8 }), extract: none });
        const out = await beside.drain();
        expect(out.status).toBe('needs_review');
        expect(beside.source()).toMatchObject({ reviewReason: 'statement-currency-differs', filed: false });
    });
    it('a rupee statement that mentions a few dollar lines (foreign purchases) is a rupee statement', async () => {
        const stmt = statement(62, { code: 'LKR', n: 8, extraHead: ['Foreign purchases are shown in USD at the card rate'] });
        const w = world({ stmt, extract: none });
        expect((await w.drain()).status).toBe('filed');
    });
    it('a statement printing no currency at all is the account\'s own', async () => {
        const stmt = statement(63, { code: 'LKR', n: 8, head: '' });
        const w = world({ stmt, extract: none });
        expect((await w.drain()).status).toBe('filed');
    });
    it('an account kept in dollars takes the dollar statement', async () => {
        const stmt = statement(61, { code: 'USD', n: 8 });
        const w = world({ stmt, settings: { currency: 'USD' }, extract: none });
        expect((await w.drain()).status).toBe('filed');
    });
});

describe('with every model down, the rules read a statement in any currency exactly, in that currency\'s own units', () => {
    const down = async () => { throw new Error('every provider is down'); };
    for (const c of [{ code: 'LKR' }, { code: 'USD' }, { code: 'GBP' }, { code: 'EUR', style: 'euro' }, { code: 'JPY' }, { code: 'KRW' }, { code: 'VND', style: 'euro' }, { code: 'KWD' }, { code: 'BHD' }, { code: 'OMR', style: 'euro' }]) {
        for (const seed of [1, 2, 3, 4]) {
            it(`${c.code} seed ${seed}`, async () => {
                const stmt = statement(seed, { ...c, style: c.style || 'western' });
                const res = await adaptiveRead({ text: stmt.text, ask: down, uid: 'u' });
                exact(res, stmt);
                expect(res.parsed.adaptive.strategy).toBe('programmatic');
                expect(res.parsed.layout.currency).toBe(c.code);
            });
        }
    }
    it('symbols only (€, £, Rs.) are still the currency', async () => {
        for (const [code, symbol, style] of [['EUR', '€', 'euro'], ['GBP', '£', 'western'], ['LKR', 'Rs. ', 'western']]) {
            const stmt = statement(9, { code, head: '', symbol, style });
            const res = await adaptiveRead({ text: stmt.text, ask: down, uid: 'u' });
            exact(res, stmt); expect(res.parsed.layout.currency).toBe(code);
        }
    });
});
