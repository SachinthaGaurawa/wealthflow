import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { readEmbeddedStatement, _internal } from '../statement-embedded.mjs';
import { ntbDoc, amexDoc, savingsRows } from './helpers/embedded-statements.js';

// The bank's own data, read without running anything. What matters most here is
// not that a good statement is read — it is that a statement whose figures do not
// agree can never be called verified. Every mutation below changes ONE thing in
// an otherwise valid statement and must make the reader refuse it.
const verified = html => { const r = readEmbeddedStatement(html); expect(r?.recognized).toBe(true); return r; };
const summary = r => r.result.parsed.rows.map(x => [x.date, x.amount, x.direction, x.narration, x.ref]);

describe('the literal parser refuses what it does not understand', () => {
    const { parseLiteral, balancedEnd } = _internal;
    it('reads the data shapes a statement uses', () => {
        expect(parseLiteral('{ a: "x\\"y", b: 1.5, c: -2, d: [1, "two", null, true], "e-f": { g: false, }, }')).toEqual({ a: 'x"y', b: 1.5, c: -2, d: [1, 'two', null, true], 'e-f': { g: false } });
        expect(parseLiteral("{ note: 'a\\u0041b' }")).toEqual({ note: 'aAb' });
    });
    it('resolves an array a statement built earlier, and nothing else by name', () => {
        expect(parseLiteral('{ transactionData: stData }', new Map([['stData', [{ x: 1 }]]]))).toEqual({ transactionData: [{ x: 1 }] });
        expect(() => parseLiteral('{ a: evil }')).toThrow();
    });
    it('refuses calls, operators, templates and trailing code', () => {
        for (const bad of ['{ a: fetch("x") }', '{ a: 1 + 2 }', '{ a: `t` }', '{ a: 1 } ; steal()', '{ a: (1) }', '{ a: function(){} }']) expect(() => parseLiteral(bad), bad).toThrow();
    });
    it('finds the end of a literal without being fooled by braces in strings', () => {
        const s = '{ a: "}{", b: \'}\', c: { d: [1] } } trailing';
        expect(s.slice(0, balancedEnd(s, 0))).toBe('{ a: "}{", b: \'}\', c: { d: [1] } }');
        expect(balancedEnd('{ a: 1', 0)).toBe(-1);
    });
});

describe('a Nations Trust consolidated statement', () => {
    const doc = () => ntbDoc({ accounts: [{ number: '200550088057', opening: 2405889, rows: savingsRows }] });
    it('is read from its own data and verified to the cent', () => {
        const r = verified(doc());
        expect(r.verified).toBe(true);
        expect(r.problems).toEqual([]);
        expect(summary(r)).toEqual([
            ['2026-01-02', 5599, 'debit', 'POS Transaction - SHOP ONE', 'S1001'],
            ['2026-01-03', 3000, 'debit', 'CEFTS/6719/FT/NSB/SOME NAME/100175', 'S1002'],
            ['2026-01-06', 50000, 'credit', 'Cash Deposit - BRANCH', 'S1003'],
            ['2026-02-01', 6.9, 'credit', '200550088057:Int.Pd:01-01-2026 to 31-01-2026', 'S1005'],
        ]);
        expect(r.result.parsed).toMatchObject({ verdict: 'parsed', understood: true, layout: { accountLast4: '8057', accounts: 1, zeroAmountSkipped: 1 } });
        expect(r.result.parsed.reconciliation).toMatchObject({ opening: 24058.89, closing: 24058.89 - 5599 - 3000 + 50000 + 6.9, ok: true, accounts: 1 });
        expect(r.result.parsed.rows.every(x => x.directionSource === 'balance' && x.needsReview === false && x.valid === true && x.card_last4 === '8057')).toBe(true);
    });
    it('carries the identity text the rest of the pipeline needs, without executing anything', () => {
        const r = verified(doc());
        expect(r.result.text).toMatch(/Nations Trust Bank/);
        expect(r.result.text).toMatch(/Statement Period: 01-01-2026 to 31-01-2026/);
        expect(r.result.text).toMatch(/Opening Balance 24058\.89/);
        expect(r.result.text).toMatch(/2 Jan 2026 POS Transaction - SHOP ONE REF:S1001 5599\.00 DR/);
    });
    it('reads every account, each row tagged with its own account', () => {
        const r = verified(ntbDoc({ accounts: [
            { number: '200550088057', opening: 100000, rows: [{ date: '2026-01-02', details: 'A', ref: 'S1', debit: 1000 }] },
            { kind: 'current', number: '300123456789', opening: 250000, rows: [{ date: '2026-01-03', details: 'B', ref: 'S2', credit: 5000 }, { date: '2026-01-04', details: 'A', ref: 'S3', debit: 1000 }] },
        ] }));
        expect(r.verified).toBe(true);
        expect(r.result.parsed.rows.map(x => [x.narration, x.card_last4])).toEqual([['A', '8057'], ['B', '6789'], ['A', '6789']]);
        expect(r.result.parsed.reconciliation).toMatchObject({ accounts: 2, opening: 3500, closing: 3500 - 10 + 50 - 10 });
    });
    it('gives each account the array as it stood when that account was pushed, even when the page reuses one variable', () => {
        const one = { number: '200550088057', opening: 100000, rows: [{ date: '2026-01-02', details: 'ONE', ref: 'S1', debit: 100 }] };
        const two = { number: '200550099999', opening: 200000, rows: [{ date: '2026-01-03', details: 'TWO', ref: 'S2', credit: 300 }] };
        const html = ntbDoc({ accounts: [one, two] }).replace(/stData1/g, 'stData');
        const r = verified(html);
        expect(r.verified).toBe(true);
        expect(r.result.parsed.rows.map(x => [x.narration, x.card_last4])).toEqual([['ONE', '8057'], ['TWO', '9999']]);
    });
    it('refuses keys that would reach into an object\'s prototype', () => {
        expect(() => _internal.parseLiteral('{ "__proto__": { polluted: 1 } }')).toThrow();
        expect(({}).polluted).toBeUndefined();
    });
    it('keeps two identical purchases — they are two transactions', () => {
        const same = { date: '2026-01-02', details: 'POS Transaction - SHOP', ref: '', debit: 15000 };
        const r = verified(ntbDoc({ accounts: [{ number: '200550088057', opening: 100000, rows: [same, same] }] }));
        expect(r.verified).toBe(true);
        expect(r.result.parsed.rows).toHaveLength(2);
    });
    it('reads an overdrawn current account through the sign of its balances', () => {
        const r = verified(ntbDoc({ accounts: [{ kind: 'current', number: '300123456789', opening: -200000, rows: [{ date: '2026-01-03', details: 'CEFTS', ref: 'S4', debit: 50000 }, { date: '2026-01-09', details: 'Deposit', ref: 'S5', credit: 100000 }] }] }));
        expect(r.verified).toBe(true);
        expect(r.result.parsed.reconciliation).toMatchObject({ opening: -2000, closing: -1500, ok: true });
    });
    it('accepts rows the bank printed in a different order from the one it posted them in', () => {
        // Posting order: first, second, third, fourth. Printed order swaps second and third.
        const rows = [
            { date: '2026-01-02', details: 'first', ref: 'S1', debit: 1000, balance: 99000, runDebit: 1000, runCredit: 0 },
            { date: '2026-01-02', details: 'third', ref: 'S3', debit: 500, balance: 98000, runDebit: 2000, runCredit: 0 },
            { date: '2026-01-02', details: 'second', ref: 'S2', debit: 500, balance: 98500, runDebit: 1500, runCredit: 0 },
            { date: '2026-01-03', details: 'fourth', ref: 'S4', credit: 2000, balance: 100000, runDebit: 2000, runCredit: 2000 },
        ];
        const r = verified(ntbDoc({ accounts: [{ number: '200550088057', opening: 100000, rows, closing: 100000, deposits: 2000, withdrawals: 2000 }] }));
        expect(r.problems).toEqual([]);
        expect(r.verified).toBe(true);
        expect(r.result.parsed.layout.chainReordered).toBe(1);
        // rows stay in the order the bank printed them
        expect(r.result.parsed.rows.map(x => x.narration)).toEqual(['first', 'third', 'second', 'fourth']);
    });
    it('still refuses a chain that NO ordering can satisfy', () => {
        const rows = [
            { date: '2026-01-02', details: 'first', ref: 'S1', debit: 1000, balance: 99000, runDebit: 1000, runCredit: 0 },
            { date: '2026-01-02', details: 'second', ref: 'S2', debit: 500, balance: 98000, runDebit: 1500, runCredit: 0 },
        ];
        const r = verified(ntbDoc({ accounts: [{ number: '200550088057', opening: 100000, rows, closing: 98000, deposits: 0, withdrawals: 1500 }] }));
        expect(r.verified).toBe(false);
        expect(r.problems).toContain('balance-chain-broken');
    });
    it('a ledger with no transactions and unchanged balances is a proven empty month', () => {
        const r = verified(ntbDoc({ accounts: [{ number: '200550088057', opening: 100000, rows: [] }] }));
        expect(r.verified).toBe(true);
        expect(r.result.parsed.rows).toEqual([]);
        expect(r.result).toMatchObject({ zeroActivity: true });
        expect(r.result.parsed.verdict).toBe('empty');
    });
    it('will not vouch for a statement with a section it does not file', () => {
        const withFd = doc().replace('fixedDepositAmount = "0"', 'fixedDepositAmount = "500000"');
        const r = verified(withFd);
        expect(r.verified).toBe(false);
        expect(r.problems).toContain('section-not-read:fixedDepositAmount');
    });
    it('will not vouch for a foreign-currency account', () => {
        const r = verified(ntbDoc({ accounts: [{ number: '200550088057', currency: 'USD', opening: 100000, rows: [{ date: '2026-01-02', details: 'x', ref: 'S1', debit: 100 }] }] }));
        expect(r.verified).toBe(false);
        expect(r.problems).toContain('foreign-currency-account');
    });
    it('refuses a date that is a year away from the statement period', () => {
        const r = verified(ntbDoc({ accounts: [{ number: '200550088057', opening: 100000, rows: [{ date: '2025-01-02', details: 'x', ref: 'S1', debit: 100 }] }] }));
        expect(r.verified).toBe(false);
        expect(r.problems).toContain('date-outside-period');
    });
    it('is not a Smart Statement at all when there is no data in it', () => {
        expect(readEmbeddedStatement('<html><body>' + 'x'.repeat(300) + '<table><tr><td>a</td></tr></table></body></html>')).toBeNull();
        expect(readEmbeddedStatement('')).toBeNull();
        expect(readEmbeddedStatement(null)).toBeNull();
    });
});

describe('a crafted document cannot make the scan slow', () => {
    const wrap = s => `<html><body><script>${s}</script></body></html>`;
    const fast = (name, html) => { const at = Date.now(); readEmbeddedStatement(html); expect(Date.now() - at, name).toBeLessThan(1500); };
    it('stays fast on long runs, nesting, unclosed tags and huge strings', () => {
        fast('identifier run', wrap('savingsDataList.push({a:1});' + 'x'.repeat(2_000_000)));
        fast('whitespace', wrap('savingsDataList.push({a:1});' + ' '.repeat(2_000_000)));
        fast('nesting', wrap('savingsDataList.push(' + '{a:'.repeat(20000) + '1' + '}'.repeat(20000) + ');'));
        fast('huge string', wrap('savingsDataList.push({a:"' + 'x'.repeat(2_000_000) + '"});'));
        fast('unclosed scripts', '<html><body>' + '<script>'.repeat(100000));
        fast('script without >', '<html><body>' + '<script '.repeat(100000));
    });
});

describe('every single-figure corruption of a statement is refused', () => {
    const base = { number: '200550088057', opening: 2405889, rows: savingsRows };
    const good = ntbDoc({ accounts: [base] });
    const mutate = (fn) => ntbDoc({ accounts: [fn(JSON.parse(JSON.stringify(base)))] });
    const refused = html => { const r = readEmbeddedStatement(html); return !!r && r.verified === false; };
    it('an amount changed by one cent while its balance is not', () => {
        expect(refused(mutate(a => { a.rows[0].debit += 1; return a; }).replace(/runningTotal: "[\d.]+"/, m => m))).toBe(false); // generator recomputes balances: a consistent ledger is a different valid ledger
        const tampered = good.replace('transactionDebit: "5599"', 'transactionDebit: "5599.01"');
        expect(refused(tampered)).toBe(true);
    });
    it('a row dropped from the data', () => {
        expect(refused(good.replace(/stData\.push\(\{ transactionDateFull: "03-01-2026"[^}]*\}\);/, ''))).toBe(true);
    });
    it('a row duplicated in the data', () => {
        const row = /stData\.push\(\{ transactionDateFull: "06-01-2026"[^}]*\}\);/.exec(good)[0];
        expect(refused(good.replace(row, row + '\n' + row))).toBe(true);
    });
    it('the opening balance, the closing balance or a bank total changed', () => {
        expect(refused(good.replace('savingsBfBalance: "24058.89"', 'savingsBfBalance: "24058.90"'))).toBe(true);
        expect(refused(good.replace(/savingsBalance: "[\d.]+"/, 'savingsBalance: "1.00"'))).toBe(true);
        expect(refused(good.replace(/savingsWithdrawal: "[\d.]+"/, 'savingsWithdrawal: "1.00"'))).toBe(true);
        expect(refused(good.replace(/savingsDeposit: "[\d.]+"/, 'savingsDeposit: "1.00"'))).toBe(true);
    });
    it('a debit turned into a credit', () => {
        expect(refused(good.replace('transactionDebit: "5599", transactionCredit: "0"', 'transactionDebit: "0", transactionCredit: "5599"'))).toBe(true);
    });
    it('a running balance or a cumulative total that disagrees', () => {
        expect(refused(good.replace(/runningTotal: "18459\.89"/, 'runningTotal: "18459.88"'))).toBe(true);
        expect(refused(good.replace(/runningDebitTotal: "5599"/, 'runningDebitTotal: "5598"'))).toBe(true);
    });
    it('the overview total on the first page disagreeing with the accounts', () => {
        expect(refused(good.replace(/savingsAmount = "[\d.]+"/, 'savingsAmount = "1.00"'))).toBe(true);
    });
    it('a data shape it cannot parse', () => {
        expect(refused(good.replace('runningTotal: "18459.89"', 'runningTotal: hack()'))).toBe(true);
    });
});

describe('a Nations Trust American Express statement', () => {
    const rows = [
        { post: '13 JUL', description: 'Cash advance from MB', amount: 10000000, dir: 'Dr' },
        { post: '16 JUL', description: 'PAYMENT THANK YOU', amount: 30000, dir: 'Cr' },
        { post: '21 JUL', tx: '19 JUL', description: 'FOREIGN MERCHANT', ccy: 'USD', amount: 500, converted: 150000, dir: 'Dr' },
        { post: '21 JUL', tx: '19 JUL', description: 'FOREIGN MERCHANT', ccy: 'USD', amount: 500, converted: 150000, dir: 'Dr' },
    ];
    const doc = extra => amexDoc({ cards: [{ cardNo: '376657*****0276', txs: rows }], opening: 100000, ...extra });
    it('is read from its own JSON and verified against the bank\'s opening and closing balance', () => {
        const r = verified(doc());
        expect(r.verified).toBe(true);
        expect(summary(r)).toEqual([
            ['2026-07-13', 100000, 'debit', 'Cash advance from MB', undefined],
            ['2026-07-16', 300, 'credit', 'PAYMENT THANK YOU', undefined],
            ['2026-07-21', 1500, 'debit', 'FOREIGN MERCHANT', undefined],
            ['2026-07-21', 1500, 'debit', 'FOREIGN MERCHANT', undefined],
        ]);
        expect(r.result.parsed).toMatchObject({ verdict: 'parsed', understood: true, layout: { accountLast4: '0276', statementType: 'credit-card' } });
        expect(r.result.parsed.reconciliation).toMatchObject({ opening: 1000, closing: 1000 - 300 + 100000 + 3000, credits: 300, debits: 103000, ok: true, model: 'card' });
    });
    it('records whether the bank\'s own summary by kind agrees with the rows, without blocking on it', () => {
        const agrees = verified(doc());
        expect(agrees.result.parsed.layout.summaryAgrees).toEqual({ credits: true, debits: true });
        const differs = verified(doc({ payment: 1, extraSummary: { purchases: 1 } }));
        expect(differs.verified).toBe(true);
        expect(differs.result.parsed.layout.summaryAgrees).toEqual({ credits: false, debits: false });
        const real = verified(amexDoc({ cards: [{ cardNo: '376657*****0276', txs: rows }], opening: 100000, extraSummary: { purchases: 3000, cashAdvances: -100000, interest: 0, charges: 0 } }));
        expect(real.result.parsed.layout.summaryAgrees).toEqual({ credits: true, debits: true });
    });
    it('gives a December row on a January statement the earlier year', () => {
        const r = verified(amexDoc({ cards: [{ cardNo: '376657*****0276', txs: [{ post: '28 DEC', description: 'A', amount: 100, dir: 'Dr' }, { post: '05 JAN', description: 'B', amount: 100, dir: 'Dr' }] }], opening: 0, cycle: { year: 2026, monthValue: 1, dayOfMonth: 10 }, period: '11-Dec-2025 to 10-Jan-2026' }));
        expect(r.verified).toBe(true);
        expect(r.result.parsed.rows.map(x => x.date)).toEqual(['2025-12-28', '2026-01-05']);
    });
    it('a month with no transactions and unchanged balances is proven empty', () => {
        const r = verified(amexDoc({ cards: [{ cardNo: '376657*****0276', txs: [] }], opening: 470000 }));
        expect(r.verified).toBe(true);
        expect(r.result).toMatchObject({ zeroActivity: true });
        expect(r.result.parsed.rows).toEqual([]);
    });
    it('refuses a statement whose closing balance is not what its rows lead to', () => {
        const r = verified(doc({ closing: 999999 }));
        expect(r.verified).toBe(false);
        expect(r.problems).toContain('balances-do-not-reconcile');
    });
    it('refuses a change to any single row', () => {
        const good = doc();
        for (const mutate of [
            h => h.replace('"txConvertedAmount":1000', '"txConvertedAmount":1001'),
            h => h.replace('"crDr":"Cr"', '"crDr":"Dr"'),
            h => h.replace('"txConvertedAmount":300', '"txConvertedAmount":301'),
        ]) {
            const tampered = mutate(good);
            if (tampered === good) continue;
            expect(readEmbeddedStatement(tampered).verified, mutate.toString()).toBe(false);
        }
        const dropped = good.replace(/\{"txId":1002[^}]*\},/, '');
        expect(dropped).not.toBe(good);
        expect(readEmbeddedStatement(dropped).verified).toBe(false);
    });
    it('refuses a row it cannot classify as debit or credit', () => {
        const r = readEmbeddedStatement(doc().replace('"crDr":"Cr"', '"crDr":"??"'));
        expect(r.verified).toBe(false);
        expect(r.problems).toContain('direction-unclear');
    });
});

describe('property: a ledger generated from a model is read back exactly, and any single-cent corruption is refused', () => {
    const rowArb = fc.record({
        day: fc.integer({ min: 1, max: 28 }), debit: fc.integer({ min: 0, max: 2_000_000 }), credit: fc.integer({ min: 0, max: 2_000_000 }),
        words: fc.array(fc.constantFrom('POS', 'Transaction', 'CEFTS', 'SHOP', 'PLC', 'Colombo', 'ATM', 'Fee', 'Int.Pd', 'WTax.Pd', 'MOBILE', 'Payment', '&amp;'), { minLength: 1, maxLength: 5 }),
    });
    const build = (rawRows, opening) => {
        const rows = rawRows.map((r, i) => ({ date: `2026-01-${String(r.day).padStart(2, '0')}`, details: r.words.join(' ') + ' ' + i, ref: `S${1000 + i}`, ...(r.debit % 2 ? { debit: r.debit } : { credit: r.credit }) }));
        rows.sort((a, b) => a.date.localeCompare(b.date));
        return rows;
    };
    it('reads the exact rows of any valid ledger', () => {
        fc.assert(fc.property(fc.array(rowArb, { maxLength: 40 }), fc.integer({ min: -5_000_000, max: 50_000_000 }), (raw, opening) => {
            const rows = build(raw, opening);
            const r = readEmbeddedStatement(ntbDoc({ accounts: [{ number: '200550088057', opening, rows }] }));
            expect(r.verified, JSON.stringify(r.problems)).toBe(true);
            const expected = rows.filter(x => (x.debit || 0) + (x.credit || 0) > 0);
            expect(r.result.parsed.rows.map(x => [x.date, Math.round(x.amount * 100), x.direction, x.ref])).toEqual(expected.map(x => [x.date, x.debit || x.credit, x.debit ? 'debit' : 'credit', x.ref]));
        }), { numRuns: 200, seed: 20260930 });
    });
    it('never verifies a ledger in which one amount was changed by a cent', () => {
        fc.assert(fc.property(fc.array(rowArb, { minLength: 1, maxLength: 30 }), fc.integer({ min: 0, max: 50_000_000 }), fc.nat(), (raw, opening, pickRow) => {
            const rows = build(raw, opening).filter(x => (x.debit || 0) + (x.credit || 0) > 0);
            fc.pre(rows.length > 0);
            const html = ntbDoc({ accounts: [{ number: '200550088057', opening, rows }] });
            const target = rows[pickRow % rows.length];
            const field = target.debit ? 'transactionDebit' : 'transactionCredit';
            const amount = target.debit || target.credit;
            const before = `${field}: ${JSON.stringify((amount / 100).toFixed(2).replace(/\.00$/, ''))}`;
            const after = `${field}: ${JSON.stringify(((amount + 1) / 100).toFixed(2).replace(/\.00$/, ''))}`;
            const at = html.indexOf(`savingsTransactionRefNo: " ${target.ref}"`);
            const cut = html.indexOf(before, at);
            fc.pre(at >= 0 && cut >= 0);
            const tampered = html.slice(0, cut) + after + html.slice(cut + before.length);
            expect(readEmbeddedStatement(tampered).verified).toBe(false);
        }), { numRuns: 200, seed: 20260930 });
    });
    it('reads any generated card statement and refuses one whose closing balance is off by a cent', () => {
        const txArb = fc.record({ day: fc.integer({ min: 1, max: 9 }), amount: fc.integer({ min: 1, max: 5_000_000 }), dir: fc.constantFrom('Dr', 'Cr'), word: fc.constantFrom('SHOP', 'ANTHROPIC', 'FUEL SURCHARGE', 'PAYMENT THANK YOU', 'STAMP DUTY') });
        fc.assert(fc.property(fc.array(txArb, { maxLength: 40 }), fc.integer({ min: 0, max: 90_000_000 }), (raw, opening) => {
            const txs = raw.map((t, i) => ({ post: `${String(t.day).padStart(2, '0')} AUG`, description: `${t.word} ${i}`, amount: t.amount, dir: t.dir }));
            const r = readEmbeddedStatement(amexDoc({ cards: [{ cardNo: '376657*****0276', txs }], opening }));
            expect(r.verified, JSON.stringify(r.problems)).toBe(true);
            expect(r.result.parsed.rows).toHaveLength(txs.length);
            const cr = txs.filter(t => t.dir === 'Cr').reduce((s, t) => s + t.amount, 0), dr = txs.filter(t => t.dir === 'Dr').reduce((s, t) => s + t.amount, 0);
            const off = readEmbeddedStatement(amexDoc({ cards: [{ cardNo: '376657*****0276', txs }], opening, closing: opening - cr + dr + 1 }));
            expect(off.verified).toBe(false);
        }), { numRuns: 200, seed: 20260930 });
    });
});
