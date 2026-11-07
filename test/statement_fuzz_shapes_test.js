// Many invented statements, every combination of date style, money style, row order and currency prefix the parser reads,
// each with the rows known in advance. A bank statement is read exactly right or it is not called "parsed".
// All data here is invented (this is a public repository); the generator is seeded so a failure repeats.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';

const P = loadParser(fs);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');
const comma = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DATES = {
    'dd/mm/yyyy': (d, m, y) => `${pad(d)}/${pad(m)}/${y}`,
    'dd-mm-yyyy': (d, m, y) => `${pad(d)}-${pad(m)}-${y}`,
    'yyyy-mm-dd': (d, m, y) => `${y}-${pad(m)}-${pad(d)}`,
    'yyyy/mm/dd': (d, m, y) => `${y}/${pad(m)}/${pad(d)}`,
    'dd MMM yyyy': (d, m, y) => `${pad(d)} ${MON[m - 1]} ${y}`,
    'dd-MMM-yyyy': (d, m, y) => `${pad(d)}-${MON[m - 1]}-${y}`,
    'dd/mm/yy': (d, m, y) => `${pad(d)}/${pad(m)}/${String(y).slice(2)}`,
    'dd MMM yy': (d, m, y) => `${pad(d)} ${MON[m - 1]} ${String(y).slice(2)}`,
    'dd-MMM-yy': (d, m, y) => `${pad(d)}-${MON[m - 1]}-${String(y).slice(2)}`,
    'MMM dd, yyyy': (d, m, y) => `${MON[m - 1]} ${pad(d)}, ${y}`,
    'dd/MMM/yyyy': (d, m, y) => `${pad(d)}/${MON[m - 1]}/${y}`
};
const MONEY = {
    comma,
    plain: (v) => v.toFixed(2),
    space: (v) => comma(v).replace(/,/g, ' '),
    rs: (v) => 'Rs. ' + comma(v),
    lkr: (v) => 'LKR ' + comma(v)
};
const DESCS = ['POS 1234 SAMPLE MART COLOMBO 03', 'ATM WDL 500 KANDY', 'TFR TO 001234567890 SAMPLE NAME', 'CEFT REF 8841231 SAMPLE PAYEE', 'SAMPLE ELECTRICITY BILL 2026/10',
    'SALARY SAMPLE PVT LTD', 'ONLINE TRF 12 34', 'SHOP 12 BRANCH 3', 'FUEL SAMPLE STATION 15.5L', 'INTEREST', 'STAMP DUTY', 'CASH DEPOSIT', 'SAMPLE RESTAURANT 2 PAX'];

function seeded(seed) {
    let s = seed;
    const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
    return { rnd, pick: (a) => a[Math.floor(rnd() * a.length)] };
}

function build(seed, { newest, dateName, moneyName }) {
    const { rnd, pick } = seeded(seed);
    const df = DATES[dateName], mf = MONEY[moneyName];
    const n = 3 + Math.floor(rnd() * 10);
    let bal = Math.round(rnd() * 5e6) / 100 + 1000;
    const open = bal, truth = [], body = [];
    let day = 1;
    for (let i = 0; i < n; i++) {
        day = Math.min(28, day + Math.floor(rnd() * 3)); // several rows on one day on purpose
        const credit = rnd() < 0.3;
        const amt = Math.round((rnd() * 2e5 + 0.01) * 100) / 100;
        if (!credit && amt > bal) { i--; continue; }
        bal = Math.round((bal + (credit ? amt : -amt)) * 100) / 100;
        body.push(`${df(day, 10, 2026)} ${pick(DESCS)} ${mf(amt)} ${mf(bal)}`);
        truth.push([`2026-10-${pad(day)}`, amt, credit ? 'credit' : 'debit']);
    }
    const lines = ['ACCOUNT STATEMENT', 'Account No 0012345678', `OPENING BALANCE ${mf(open)}`, ...(newest ? body.slice().reverse() : body), `CLOSING BALANCE ${mf(bal)}`];
    return { text: lines.join('\n'), truth, closing: bal };
}

describe('invented bank statements in every shape the parser reads', () => {
    for (const dateName of Object.keys(DATES)) {
        for (const moneyName of Object.keys(MONEY)) {
            for (const newest of [false, true]) {
                it(`${dateName} | ${moneyName} | ${newest ? 'newest first' : 'oldest first'}: every row, amount and direction exact`, () => {
                    for (let k = 0; k < 6; k++) {
                        const { text, truth, closing } = build(1000 + k * 7919 + (newest ? 1 : 0), { newest, dateName, moneyName });
                        const out = P.parseStatement(text);
                        const got = out.rows.map((r) => [r.date, r.amount, r.direction]);
                        // "COLOMBO 03 104 474.78": a number that ends a description cannot be told from the first group of a spaced figure,
                        // so on that page the answer is either exactly right or not called parsed (never a silently wrong "parsed")
                        if (moneyName === 'space' && JSON.stringify(got) !== JSON.stringify(truth)) {
                            expect(out.verdict).not.toBe('parsed');
                            continue;
                        }
                        expect(got).toEqual(truth);
                        expect(out.reconciliation.ok).toBe(true);
                        expect(out.reconciliation.closing).toBe(closing);
                    }
                });
            }
        }
    }

    it('a layout it cannot read (dotted dates) is never half-read: it yields no rows, so the owner is asked', () => {
        const out = P.parseStatement(['ACCOUNT STATEMENT', 'OPENING BALANCE 1,000.00', '02.10.2026 SAMPLE SHOP 100.00 900.00', '03.10.2026 SAMPLE SHOP 50.00 850.00', 'CLOSING BALANCE 850.00'].join('\n'));
        expect(out.rows).toHaveLength(0);
        expect(out.verdict).toBe('unreadable');
    });

    it('a figure that is wrong by one cent is never called parsed', () => {
        const { text } = build(42, { newest: false, dateName: 'dd/mm/yyyy', moneyName: 'comma' });
        const bad = text.replace(/(\d)\.(\d{2})(\s+[\d,]+\.\d{2}\nCLOSING)/, (all, a, b, rest) => a + '.' + pad((+b + 1) % 100) + rest);
        expect(bad).not.toBe(text);
        const out = P.parseStatement(bad);
        expect(out.reconciliation.ok).not.toBe(true);
        expect(out.verdict).not.toBe('parsed');
    });
});
