import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import fc from 'fast-check';
import { project as amortizeProject } from '../wealthflow-amortize.js';
import advisor, { build, lkr } from '../wealthflow-advisor-facts.js';
import scenarios, { emi, quote, payDown, readNumbers, readScenario, merge, work, currentBlock } from '../wealthflow-advisor-scenarios.js';
import { page, household, factsOf, run, ym, EMPTY, p2 } from './helpers/advisor-page.js';

// "WHAT IF I DO THIS" IS WORKED OUT BY CODE, NOT BY THE MODEL.
//
// Asked "can I buy a car for 2.5M?", a language model does the arithmetic under the answer in prose: an instalment, the interest over five years, how many months
// the balance lasts. It does it differently each time and states it as if it came from the owner's books. wealthflow-advisor-scenarios.js does that arithmetic from
// the owner's own figures and the engines the screens use, and hands the model a block to copy. These tests hold the block to independent formulas (not to the
// code's own), to the amortiser and the fact sheet, and hold the reader of the owner's words to a table in English, Sinhala, Tamil and romanised Sinhala.

const money = (s) => Number(String(s).replace(/,/g, ''));
const grab = (text, re) => { const m = text.match(re); if (!m) throw new Error(`no match for ${re} in:\n${text}`); return m.slice(1).map((x) => (/^[\d,.-]+$/.test(x) ? money(x) : x)); };
const r0 = Math.round;
const r1 = (n) => Math.round(n * 10) / 10;

/** The page, its fact sheet and the dependencies the module reads, from the real index.html functions. */
function world(data = household()) {
    const { ctx, store } = page(data);
    const f = factsOf(ctx);
    const deps = advisor.pageDeps(ctx);
    return { ctx, store, f, deps };
}
const blockFor = (w, ...lines) => currentBlock(w.ctx, lines);

describe('the annuity arithmetic', () => {
    it('known instalments', () => {
        expect(r0(emi(2_500_000, 14, 60))).toBe(58171);
        expect(r0(emi(1_000_000, 12, 36))).toBe(33214);
        expect(r0(emi(1_000_000, 12, 12))).toBe(88849);
        expect(r0(emi(500_000, 0, 20))).toBe(25000);
    });
    it('a quote adds up: instalment x months is the total, total less principal is the interest', () => {
        const q = quote(2_500_000, 14, 60);
        expect(q).toMatchObject({ principal: 2_500_000, ratePct: 14, months: 60, payment: 58171 });
        expect(q.total).toBe(r0(emi(2_500_000, 14, 60) * 60));
        expect(q.interest).toBe(q.total - q.principal);
    });
    it('nothing, or nonsense, borrowed is no instalment (never NaN)', () => {
        for (const [p, r, n] of [[0, 14, 60], [-5, 14, 60], [1000, 14, 0], [NaN, 14, 60], ['abc', 'x', 'y'], [1000, NaN, 12]]) {
            expect(Number.isFinite(emi(p, r, n)), JSON.stringify([p, r, n])).toBe(true);
        }
        expect(emi(0, 14, 60)).toBe(0);
    });
    it('agrees with wealthflow-amortize.js for any loan (cross-checked against the amortiser the loans screen uses)', () => {
        fc.assert(fc.property(fc.integer({ min: 20_000, max: 20_000_000 }), fc.double({ min: 0, max: 40, noNaN: true }), fc.integer({ min: 6, max: 240 }), (principal, rate, months) => {
            const payment = emi(principal, rate, months);
            const loan = { amount: principal, rate, duration: months, monthly: payment, start: '2026-01-01', payments: [] };
            const plan = amortizeProject(loan);
            expect(plan.ok).toBe(true);
            // the level instalment clears the loan in exactly `months` instalments (a last row of a fraction of a cent is rounding, not a month)
            expect(plan.rows.filter((r) => r.payment > 0.5).length).toBe(months);
            expect(Math.abs(plan.totalInterest - (payment * months - principal))).toBeLessThan(Math.max(1, months * 0.011));
        }), { numRuns: 120 });
    });
    it('payDown walks a balance the way the amortiser does, and refuses a payment that never clears it', () => {
        const loan = { amount: 1_000_000, rate: 12, duration: 120, monthly: 20_000, start: '2026-01-01', payments: [] };
        const plan = amortizeProject(loan), walk = payDown(1_000_000, 12, 20_000);
        expect(walk.months).toBe(plan.monthsTaken);
        expect(Math.abs(walk.interest - plan.totalInterest)).toBeLessThan(1);
        expect(payDown(1_000_000, 12, 10_000)).toBeNull();      // 10,000 is the interest alone
        expect(payDown(0, 12, 100)).toEqual({ months: 0, interest: 0 });
    });
});

describe('reading an amount in the owner\'s own words', () => {
    const one = (text) => readNumbers(text).map((n) => `${n.kind}:${n.value}${n.perMonth ? ':monthly' : ''}${n.down ? ':down' : ''}`);
    it.each([
        // [text, what it reads as]
        ['2.5M', ['amount:2500000']],
        ['2,500,000', ['amount:2500000']],
        ['Rs. 50k', ['amount:50000']],
        ['25 lakh', ['amount:2500000']],
        ['1.5 crore', ['amount:15000000']],
        ['ලක්ෂ 25', ['amount:2500000']],
        ['ලක්ෂ 10ක ණයක්', ['amount:1000000']],
        ['මිලියන 3', ['amount:3000000']],
        ['25 இலட்சம்', ['amount:2500000']],
        ['2 கோடி', ['amount:20000000']],
        ['laksha 25', ['amount:2500000']],
        ['25 lakshayak', ['amount:2500000']],
        ['14%', ['pct:14']],
        ['interest 14', ['pct:14']],
        ['පොලිය 14', ['pct:14']],
        ['5 years', ['years:5']],
        ['වසර 5', ['years:5']],
        ['wasara 5', ['years:5']],
        ['60 months', ['months:60']],
        ['මාස 60', ['months:60']],
        ['mase 60', ['months:60']],
        ['20,000 a month', ['amount:20000:monthly']],
        ['මාසයකට රු. 20,000', ['amount:20000:monthly']],
        ['மாதம் 20,000', ['amount:20000:monthly']],
        ['500k down payment', ['amount:500000:down']],
        ['250,000 with 50,000 down payment', ['amount:250000', 'amount:50000:down']],
    ])('%s', (text, expected) => expect(one(text)).toEqual(expected));
    it.each(['in 2027', 'I have 2 cars', 'on the 15th', 'version 3', '5 people', 'at 7pm'])('a number that is not money is left out: %s', (text) => expect(readNumbers(text)).toEqual([]));
    it('never throws, whatever it is given', () => {
        fc.assert(fc.property(fc.fullUnicodeString({ maxLength: 120 }), (s) => { expect(() => readNumbers(s)).not.toThrow(); expect(() => readScenario(s)).not.toThrow(); }), { numRuns: 400 });
        for (const v of [null, undefined, 0, {}, [], NaN]) { expect(() => readNumbers(v)).not.toThrow(); expect(() => readScenario(v)).not.toThrow(); }
    });
    it('every number it returns is finite and positive', () => {
        fc.assert(fc.property(fc.array(fc.oneof(fc.integer({ min: 0, max: 99_999_999 }).map(String), fc.constantFrom('lakh', 'laksha', 'ලක්ෂ', 'k', 'M', '%', 'years', 'months', 'මාස', 'Rs.', ',', '.', ' ', 'a month')), { maxLength: 12 }), (parts) => {
            for (const n of readNumbers(parts.join(' '))) { expect(Number.isFinite(n.value)).toBe(true); expect(n.value).toBeGreaterThanOrEqual(0); }
        }), { numRuns: 300 });
    });
});

describe('reading what kind of decision it is', () => {
    const view = (text) => { const r = readScenario(text); return { kind: r.kind, amount: r.amount, perMonth: r.perMonth, down: r.down, months: r.months, ratePct: r.ratePct, percent: r.percent, financed: !!r.financed }; };
    const want = (o) => ({ kind: null, amount: null, perMonth: null, down: null, months: null, ratePct: null, percent: null, financed: false, ...o });
    it.each([
        ['Can I buy a car for 2.5M?', { kind: 'purchase', amount: 2_500_000 }],
        ['I will buy a laptop 250,000 with 50,000 down payment', { kind: 'purchase', amount: 250_000, down: 50_000 }],
        ['2.5M car, 14% over 5 years', { kind: 'purchase', amount: 2_500_000, months: 60, ratePct: 14, percent: 14, financed: true }],
        ['I want a loan of 1,000,000 for 36 months at 12%', { kind: 'borrow', amount: 1_000_000, months: 36, ratePct: 12, percent: 12, financed: true }],
        ['If I pay 20,000 extra on the Honda loan', { kind: 'extra-payment', amount: 20_000 }],
        ['If I pay 20,000 extra a month on the Honda loan', { kind: 'extra-payment', perMonth: 20_000 }],
        ['pay 500,000 off the loan', { kind: 'extra-payment', amount: 500_000 }],
        ['settle the Honda loan now', { kind: 'extra-payment' }],
        ['what if my salary stops', { kind: 'income-loss' }],
        ['what if my income drops by 30%', { kind: 'income-loss', percent: 30 }],
        ['if I cut dining by 20%', { kind: 'spending-cut', percent: 20 }],
        ['how long to save 500,000', { kind: 'save', amount: 500_000 }],
        ['how long to save 500,000 at 25,000 a month', { kind: 'save', amount: 500_000, perMonth: 25_000 }],
        // Sinhala
        ['ලක්ෂ 25 ක කාර් එකක් ගන්න පුළුවන්ද?', { kind: 'purchase', amount: 2_500_000 }],
        ['ලක්ෂ 10ක ණයක් ගත්තොත් මාස 36කට?', { kind: 'borrow', amount: 1_000_000, months: 36, financed: true }],
        ['රු. 20,000 වැඩිපුර ගෙවුවොත් Honda ණය?', { kind: 'extra-payment', amount: 20_000 }],
        ['රැකියාව නැති වුණොත් කොච්චර කල් ඉන්න පුළුවන්ද?', { kind: 'income-loss' }],
        ['කෑම වියදම 20% අඩු කළොත්?', { kind: 'spending-cut', percent: 20 }],
        // Tamil
        ['மாதம் 20,000 கூடுதல் கடன் செலுத்தினால்?', { kind: 'extra-payment', perMonth: 20_000 }],
        ['25 இலட்சம் கடன் வாங்கினால்?', { kind: 'borrow', amount: 2_500_000, financed: true }],
        // romanised Sinhala
        ['laksha 25 car ekak ganna puluwanda?', { kind: 'purchase', amount: 2_500_000 }],
        ['laksha 25 nayak gattoth mase 36', { kind: 'borrow', amount: 2_500_000, months: 36, financed: true }],
    ])('%s', (text, expected) => expect(view(text)).toEqual(want(expected)));
    it.each(['hello how are you', 'in 2027 I will have 2 cars', 'what is the capital of France?', 'thanks!', 'ඔයාට කොහොමද?', 'tell me a joke'])('not a decision: %s', (text) => expect(readScenario(text).kind).toBeNull());
});

describe('follow-ups say only what changed', () => {
    it('"and over 36 months?" keeps the car and changes the term', () => {
        const s = merge(['Can I buy a car for 2.5M?', 'and over 36 months?']);
        expect(s).toMatchObject({ kind: 'purchase', amount: 2_500_000, months: 36 });
    });
    it('"what about 14%?" sets the rate of the loan being talked about', () => {
        const s = merge(['I want a loan of 1,000,000', 'what about 14%?']);
        expect(s).toMatchObject({ kind: 'borrow', amount: 1_000_000, ratePct: 14 });
    });
    it('the newest figure replaces the old one, the rest stays', () => {
        const s = merge(['loan of 1,000,000 for 36 months at 12%', 'what if 2,000,000?']);
        expect(s).toMatchObject({ kind: 'borrow', amount: 2_000_000, months: 36, ratePct: 12 });
    });
    it('a later question with no figure of its own does not drag an old scenario along', () => {
        expect(merge(['Can I buy a car for 2.5M?', 'how am I doing this month?'])).toBeNull();
        expect(merge(['Can I buy a car for 2.5M?', 'thanks'])).toBeNull();
    });
    it('a new decision replaces the old one', () => {
        expect(merge(['Can I buy a car for 2.5M?', 'what if my salary stops'])).toMatchObject({ kind: 'income-loss' });
    });
    it('only the last four lines are read', () => {
        const lines = ['Can I buy a car for 2.5M?', 'ok', 'ok', 'ok', 'ok', 'and over 36 months?'];
        expect(merge(lines)).toBeNull();
    });
    it('empty and wrong input is nothing, not an error', () => {
        for (const v of [[], '', null, undefined, [null, 3, {}], ['', '  ']]) expect(merge(v)).toBeNull();
        expect(merge('Can I buy a car for 2.5M?')).toMatchObject({ kind: 'purchase' });
    });
});

describe('a purchase, worked out from the owner\'s books', () => {
    const w = world();
    const { f } = w;
    const text = blockFor(w, 'Can I buy a car for 2.5M?');
    it('is the block, opened and closed, with the question as understood', () => {
        expect(text.startsWith('=== WHAT-IF, WORKED OUT BY WEALTHFLOW')).toBe(true);
        expect(text.trimEnd().endsWith('=== END OF WHAT-IF ===')).toBe(true);
        expect(text).toContain('buy something that costs LKR 2,500,000');
    });
    it('says what it ASSUMED, because the owner gave no rate and no term', () => {
        expect(text).toMatch(/ASSUMED because the owner did not say: a term of 60 months; an interest rate of 14% a year/);
    });
    it('the instalment, the total paid and the interest are the annuity formula\'s', () => {
        const q = quote(2_500_000, 14, 60);
        expect(text).toContain(`instalment LKR ${lkr(q.payment)} a month, LKR ${lkr(q.total)} paid in all, of which LKR ${lkr(q.interest)} is interest`);
        const hi = quote(2_500_000, 17, 60);
        expect(text).toContain(`At 17% the instalment would be LKR ${lkr(hi.payment)} and the interest LKR ${lkr(hi.interest)}`);
    });
    it('the debt ratio and what is left each month are worked from the sheet\'s own figures', () => {
        const pay = r0(emi(2_500_000, 14, 60));
        const before = r1((f.debt.monthlyService / f.typical.income) * 100), after = r1(((f.debt.monthlyService + pay) / f.typical.income) * 100);
        expect(text).toContain(`from LKR ${lkr(f.debt.monthlyService)} to LKR ${lkr(f.debt.monthlyService + pay)} a month: ${before}% -> ${after}%`);
        expect(text).toContain(`from LKR ${lkr(f.liquidity.freeCashPerMonth)} to LKR ${lkr(f.liquidity.freeCashPerMonth - pay)}`);
    });
    it('paying cash is checked against the Balance page, and the shortfall is exact', () => {
        const short = 2_500_000 - f.liquidity.onHand;
        expect(f.liquidity.onHand).toBe(640000);
        expect(text).toContain(`A. Pay LKR 2,500,000 from the Balance page (LKR 640,000 on hand): it is LKR ${lkr(short)} more than is there`);
    });
    it('waiting and saving uses what is left each month, and says when that is nothing', () => {
        expect(f.liquidity.freeCashPerMonth).toBeLessThan(0);
        expect(text).toMatch(/C\. Wait and save\. Saving LKR 2,500,000 at what is left each month \(LKR -23,914\): nothing is left to save/);
        expect(text).toContain(`To do it in 12 months LKR ${lkr(Math.ceil(2_500_000 / 12))} a month is needed`);
    });
    it('ends with a verdict by stated rules, and the verdict is "does not fit" for this household', () => {
        expect(text).toMatch(/Verdict by the rules \(30% \/ 40% debt ratio, 3-month cushion, no month ending short\): cash: cannot be paid in cash; financed: does not fit/);
    });
    it('a down payment is taken off what is borrowed', () => {
        const t = blockFor(w, 'I want to buy a car for 2,500,000 with 500,000 down payment, 12% over 4 years');
        const q = quote(2_000_000, 12, 48);
        expect(t).toContain(`Borrow LKR 2,000,000 (LKR 2,500,000 less LKR 500,000 paid up front) over 48 months at 12% a year: instalment LKR ${lkr(q.payment)}`);
        expect(t).not.toContain('ASSUMED');
    });
    it('a smaller purchase is assumed financed over 24 months, a larger one over 60', () => {
        expect(blockFor(w, 'buy a laptop for 250,000')).toContain('a term of 24 months');
        expect(blockFor(w, 'buy a car for 2,500,000')).toContain('a term of 60 months');
        expect(scenarios.RULES.SHORT_MONTHS).toBe(24);
        expect(scenarios.RULES.LONG_MONTHS).toBe(60);
    });
});

describe('a loan, worked out', () => {
    const w = world();
    it('with every figure given, nothing is assumed', () => {
        const t = blockFor(w, 'I want a loan of 1,000,000 for 36 months at 12%');
        const q = quote(1_000_000, 12, 36);
        expect(t).not.toContain('ASSUMED');
        expect(t).toContain(`Borrow LKR 1,000,000 over 36 months at 12% a year: instalment LKR ${lkr(q.payment)} a month`);
        expect(q.payment).toBe(33214);
    });
    it('with the rate missing, only the rate is assumed', () => {
        const t = blockFor(w, 'ලක්ෂ 10ක ණයක් ගත්තොත් මාස 36කට?');
        expect(t).toMatch(/ASSUMED because the owner did not say: an interest rate of 14% a year/);
        expect(t).not.toMatch(/ASSUMED[^\n]*a term of/);
        expect(t).toContain(`instalment LKR ${lkr(quote(1_000_000, 14, 36).payment)} a month`);
    });
    it('a loan the books can carry is "fits", one that leaves the month short is not', () => {
        const rich = world(comfortable());
        expect(blockFor(rich, 'a loan of 100,000 for 12 months at 10%')).toMatch(/loan: fits/);
        expect(blockFor(w, 'a loan of 100,000 for 12 months at 10%')).toMatch(/loan: does not fit/);   // this household is already short each month
    });
    it('the cash-flow engine\'s before and after share the same starting line, and the salary assumption is stated', () => {
        const t = blockFor(w, 'Can I buy a car for 2.5M?');
        const troughs = [...t.matchAll(/lowest balance LKR ([\d,-]+) before, LKR ([\d,-]+) after/g)];
        expect(troughs.length).toBeGreaterThanOrEqual(1);
        expect(new Set(troughs.map((m) => m[1])).size).toBe(1);                     // "before" is the same baseline in every route
        expect(w.f.liquidity.runwayBasis).toBe('outflows-only');
        expect(t).toMatch(/Assumption for that line: the cash-flow engine does not project the salary by itself, so a typical income of LKR 285,000 is added on about day 28/);
    });
});

/** A household with room to spare: a high salary against modest spending and no loans. */
function comfortable() {
    const d = EMPTY();
    for (const k of run(2026, 3, 2026, 10)) d.incomeRecv.push({ id: `s${k}`, name: 'Salary', type: 'Salary', amount: 400000, month: k, date: `${k}-25`, received: true, source: 'statement' });
    for (let m = 3; m <= 10; m++) d.expenses.push({ id: `e${m}`, desc: 'Living', cat: 'Food & Groceries', amount: 90000, month: ym(2026, m), date: `${ym(2026, m)}-12`, source: 'statement' });
    d.balance = { total: 2_000_000, flows: [] };
    return d;
}

describe('an extra payment on a loan, worked out', () => {
    const w = world();
    const loan = w.f.debt.loans[0];
    const rate = 0.11 / 12;
    /** Independent of the module: the same loan walked a month at a time from the balance the Loans page shows. */
    function walk(balance, pay, lump = 0) {
        let b = balance - lump, n = 0, interest = 0;
        while (b > 0.005 && n < 1200) { const cost = b * rate; interest += cost; b = b + cost - Math.min(pay, b + cost); n++; }
        return { n, interest };
    }
    it('as it is, and with 20,000 extra every month, equal an independent walk from the Loans page balance', () => {
        const t = blockFor(w, 'If I pay 20,000 extra a month on the Honda loan');
        const as = walk(loan.balance, 62000), extra = walk(loan.balance, 82000);
        expect(t).toContain(`LKR ${lkr(loan.balance)} owing now (the balance on the Loans page), at 11% a year, instalment about LKR 62,000 a month`);
        expect(t).toContain(`As it is, ${as.n} payments remain`);
        expect(t).toContain(`LKR ${lkr(r0(as.interest))} of interest still to pay`);
        expect(t).toContain(`Paying LKR 20,000 extra every month: ${extra.n} payments`);
        expect(t).toContain(`${as.n - extra.n} months sooner and LKR ${lkr(r0(as.interest) - r0(extra.interest))} less interest`);
    });
    it('paying more always clears the loan sooner and never costs more interest', () => {
        fc.assert(fc.property(fc.integer({ min: 1000, max: 400_000 }), (extra) => {
            const t = blockFor(w, `If I pay ${extra.toLocaleString('en-US')} extra a month on the Honda loan`);
            const [as] = grab(t, /As it is, (\d+) payments remain/), [now] = grab(t, /extra every month: (\d+) payments/);
            expect(now).toBeLessThanOrEqual(as);
            const [sooner, less] = grab(t, /That is (\d+) months sooner and LKR ([\d,]+) less interest/);
            expect(sooner).toBe(as - now);
            expect(less).toBeGreaterThanOrEqual(0);
        }), { numRuns: 25 });
    });
    it('a lump sum is taken off the balance now', () => {
        const t = blockFor(w, 'pay 500,000 off the loan');
        const lump = walk(loan.balance, 62000, 500_000);
        expect(t).toContain(`Paying LKR 500,000 once now: ${lump.n} payments`);
        expect(t).toContain(`The Balance page holds LKR 640,000; after the lump sum LKR 140,000 would be left`);
    });
    it('"settle the loan" is the whole balance, and the Balance page decides if it can be done', () => {
        const t = blockFor(w, 'settle the Honda loan now');
        expect(t).toContain(`Paying LKR ${lkr(loan.balance)} once now: 0 payments (the loan is cleared), LKR 0 of interest`);
        expect(t).toContain('more than is there');
        expect(t).toMatch(/extra payment: cannot be paid from the Balance page/);
    });
    it('an extra amount larger than the balance is capped at the balance', () => {
        const t = blockFor(w, 'pay 9,000,000 off the loan');
        expect(t).toContain(`Paying LKR ${lkr(loan.balance)} once now`);
    });
    it('when the books lack instalments, the schedule\'s own count is shown beside the walk instead of silently disagreeing', () => {
        const t = blockFor(w, 'If I pay 20,000 extra a month on the Honda loan');
        expect(loan.paymentsLeft).toBe(55);
        expect(t).toContain("(The loan's own schedule counts 55 payments left;");
    });
    it('extra that does not fit in what is left each month says so', () => {
        expect(blockFor(w, 'If I pay 20,000 extra a month on the Honda loan')).toMatch(/after the extra LKR 20,000 it would be LKR -43,914 \(the month would end short\)/);
    });
    it('no loan, no pretending', () => {
        const none = world(comfortable());
        expect(blockFor(none, 'If I pay 20,000 extra on the loan')).toContain('No active loan is recorded');
    });
    it('names the loan the owner means', () => {
        const d = household();
        d.loans.push({ id: 'L2', name: 'Personal Loan', bank: 'BOC', start: '2026-01-01', duration: 24, monthly: 50000, amount: 1_000_000, rate: 15, payDay: 5, payments: [] });
        const two = world(d);
        expect(blockFor(two, 'if I pay 10,000 extra a month on the Personal loan')).toContain('Loan "Personal Loan"');
        expect(blockFor(two, 'if I pay 10,000 extra a month on the Honda loan')).toContain('Loan "Honda Vezel Loan"');
        expect(blockFor(two, 'if I pay 10,000 extra a month on the loan')).toContain('Loan "Honda Vezel Loan"');     // no name: the largest balance
    });
});

describe('losing income, cutting spending, saving', () => {
    const w = world();
    const { f } = w;
    it('income stops: the Balance page over the typical month\'s outflow, from the same typical month as the sheet', () => {
        const t = blockFor(w, 'what if my salary stops');
        const burn = f.typical.outflow;
        expect(t).toContain('ASSUMED because the owner did not say: the income stops completely');
        expect(t).toContain(`a typical month brings LKR 0 against LKR ${lkr(burn)} going out`);
        expect(t).toContain(`The month would end LKR ${lkr(burn)} short; the Balance page (LKR 640,000) would last about ${r1(640000 / burn)} months`);
        expect(t).toContain('less than a 3-month cushion');
    });
    it('income falls 30%: the shortfall is outflow less 70% of income', () => {
        const t = blockFor(w, 'what if my income drops by 30%');
        const income = 285000 * 0.7, burn = f.typical.outflow - income;
        expect(t).toContain(`brings LKR ${lkr(income)} against LKR ${lkr(f.typical.outflow)}`);
        expect(t).toContain(`end LKR ${lkr(burn)} short`);
        expect(t).toContain(`would last about ${r1(640000 / burn)} months`);
    });
    it('a household that spends well under its income still stands a 30% fall', () => {
        const rich = world(comfortable());
        const t = blockFor(rich, 'what if my income drops by 30%');
        expect(t).toContain('Income would still cover everything that goes out');
    });
    it('a spending cut on a named category uses that category\'s own three-month average', () => {
        const dining = f.categories.find((c) => c.name === 'Dining');
        const t = blockFor(w, 'if I cut dining by 20%');
        const save = dining.avg3 * 0.2;
        expect(t).toContain(`Cutting Dining (about LKR ${lkr(dining.avg3)} a month) by 20% frees LKR ${lkr(save)} a month, LKR ${lkr(save * 12)} a year`);
        expect(t).toContain(`from LKR ${lkr(f.liquidity.freeCashPerMonth)} to LKR ${lkr(f.liquidity.freeCashPerMonth + save)}`);
    });
    it('a cut with no category is on living costs, and says it assumed so', () => {
        const t = blockFor(w, 'what if I cut spending by 10%');
        const save = f.typical.living * 0.1;
        expect(t).toContain('ASSUMED because the owner did not say: no category was named');
        expect(t).toContain(`frees LKR ${lkr(save)} a month`);
    });
    it('how long to save: the amount over the monthly figure the owner named', () => {
        const t = blockFor(w, 'how long to save 500,000 at 25,000 a month');
        expect(t).toContain('takes 20 months (2028-06)');
    });
    it('how long to save with nothing left each month is "never", not a division by zero', () => {
        const t = blockFor(w, 'how long to save 500,000');
        expect(t).toContain('nothing is left to save each month');
        expect(t).not.toMatch(/Infinity|NaN/);
    });
});

describe('it never invents, mutates or breaks', () => {
    it('no figure is NaN, undefined or Infinity in any block for any phrase (property test)', () => {
        const w = world();
        const phrase = fc.oneof(
            fc.tuple(fc.constantFrom('buy a car for', 'loan of', 'ලක්ෂ', 'how long to save', 'pay', 'if I pay extra', 'cut dining by', 'what if my income drops by', 'ණයක් ගත්තොත්', 'laksha'),
                fc.integer({ min: 0, max: 99_999_999 }), fc.constantFrom('', ' for 12 months', ' at 18%', ' a month', ' 20%', ' wasara 3', ' mase 6', ' with 100k down payment', ' at 0%', ' over 1200 months'))
                .map(([a, n, b]) => `${a} ${n.toLocaleString('en-US')}${b}`),
            fc.fullUnicodeString({ maxLength: 60 }),
        );
        fc.assert(fc.property(phrase, (s) => {
            const t = blockFor(w, s);
            expect(t).not.toMatch(/NaN|undefined|Infinity|\[object/);
            if (t) { expect(t.startsWith('=== WHAT-IF')).toBe(true); expect(t.trimEnd().endsWith('=== END OF WHAT-IF ===')).toBe(true); expect(t.length).toBeLessThan(4500); }
        }), { numRuns: 300 });
    }, 60000);
    it('a zero or silly rate and term still give a sane quote', () => {
        const w = world();
        for (const s of ['loan of 1,000,000 at 0% for 24 months', 'loan of 1,000,000 at 100% for 6 months', 'loan of 1,000,000 for 5000 months', 'loan of 1,000 for 1 month']) {
            const t = blockFor(w, s);
            expect(t, s).not.toMatch(/NaN|undefined|Infinity/);
            expect(t, s).toContain('instalment LKR');
        }
        expect(blockFor(w, 'loan of 1,200,000 at 0% for 24 months')).toContain('instalment LKR 50,000 a month, LKR 1,200,000 paid in all, of which LKR 0 is interest');
    });
    it('reads and returns text: the owner\'s data is untouched', () => {
        const w = world();
        const before = JSON.stringify(w.store);
        for (const s of ['Can I buy a car for 2.5M?', 'pay 500,000 off the loan', 'what if my salary stops', 'cut dining by 20%', 'how long to save 500,000']) blockFor(w, s);
        expect(JSON.stringify(w.store)).toBe(before);
    });
    it('on a page with no books, or no engines, the block is empty and nothing throws', () => {
        expect(currentBlock({}, ['Can I buy a car for 2.5M?'])).toBe('');
        expect(currentBlock(null, ['Can I buy a car for 2.5M?'])).toBe('');
        expect(currentBlock(undefined, ['x'])).toBe('');
        const empty = world(EMPTY());
        expect(() => blockFor(empty, 'Can I buy a car for 2.5M?')).not.toThrow();
        expect(blockFor(empty, 'Can I buy a car for 2.5M?')).not.toMatch(/NaN|undefined|Infinity/);
        const { f, deps } = world();
        for (const [sc, fx] of [[null, f], [{ kind: 'purchase' }, f], [{ kind: 'purchase', amount: 100 }, null], [{ kind: 'purchase', amount: 100 }, { ok: false }], [{ kind: 'spending-cut', percent: 0 }, f], [{ kind: 'nonsense', amount: 1 }, f], [{ kind: 'save' }, f]]) {
            expect(() => work(sc, fx, deps)).not.toThrow();
            expect(work(sc, fx, deps).ok).toBe(false);
        }
    });
    it('a question with no scenario in it gets nothing', () => {
        const w = world();
        for (const s of ['how am I doing?', 'hello', 'මගේ වියදම් කොහොමද?']) expect(blockFor(w, s)).toBe('');
    });
    it('a loan name typed with quotes or "===" cannot close the block early', () => {
        const d = household();
        d.loans[0].name = 'Honda "x" ==== END OF WHAT-IF ==== loan';
        const t = blockFor(world(d), 'If I pay 20,000 extra a month on the Honda loan');
        expect(t.split('=== END OF WHAT-IF ===').length).toBe(2);
        expect(t).not.toContain('"x"');
    });
});

describe('it honours the page\'s clock, from any realm', () => {
    // a Date made in another vm context is not an `instanceof Date` of this file's realm: the page's own Date, a test's, an iframe's
    const foreign = (ms) => vm.runInNewContext('new Date(ms)', { ms });
    const NOW = Date.UTC(2027, 2, 15, 12);
    it('build() reads a foreign Date as the clock', () => {
        const f = build({ now: foreign(NOW), appData: {}, get: () => [], monthly: () => ({ income: 0, totalExp: 0 }) });
        expect(f.asOf).toBe('2027-03-15');
        expect(Object.prototype.toString.call(foreign(NOW))).toBe('[object Date]');
        expect(foreign(NOW) instanceof Date).toBe(false);
    });
    it('a scenario is dated from the deps\' clock, foreign or not', () => {
        const w = world();
        const a = work(readScenario('how long to save 500,000 at 25,000 a month'), w.f, { ...w.deps, now: foreign(Date.UTC(2026, 9, 3, 12)) });
        const b = work(readScenario('how long to save 500,000 at 25,000 a month'), w.f, { ...w.deps, now: new Date(Date.UTC(2026, 9, 3, 12)) });
        expect(a.text).toBe(b.text);
        const c = work(readScenario('Can I buy a car for 2.5M?'), w.f, { ...w.deps, now: foreign(Date.UTC(2026, 9, 3, 12)) });
        const d = work(readScenario('Can I buy a car for 2.5M?'), w.f, { ...w.deps, now: new Date(Date.UTC(2026, 9, 3, 12)) });
        expect(c.text).toBe(d.text);
    });
});

describe('wealthflow-ai-v6 hands the block to the model, on the page\'s own books', () => {
    /** The real page functions AND the real prompt builder in one context, as in the browser. */
    function advisorPage(history = []) {
        const { ctx } = page(household());
        Object.assign(ctx, {
            console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval() {}, clearTimeout() {},
            localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null, querySelector: () => null }, navigator: { language: 'en' },
            getAIHistory: () => history,
        });
        vm.runInContext(readFileSync(new URL('../wealthflow-ai-v6.js', import.meta.url), 'utf8'), ctx);
        return ctx;
    }
    const HEAD = '=== WHAT-IF, WORKED OUT BY WEALTHFLOW';
    it('a decision gets the block after the sheet, with the figures worked out', () => {
        const ctx = advisorPage();
        const p = ctx.WealthFlowAIv6.adaptiveSystemPrompt('finance', 'Can I buy a car for 2.5M?');
        expect(p).toContain("=== THE OWNER'S BOOKS");
        expect(p).toContain(HEAD);
        expect(p.indexOf(HEAD)).toBeGreaterThan(p.indexOf("=== THE OWNER'S BOOKS"));
        expect(p).toContain('instalment LKR 58,171 a month');
    });
    it('the same question in Sinhala gets the same figures', () => {
        const ctx = advisorPage();
        const p = ctx.WealthFlowAIv6.adaptiveSystemPrompt('finance', 'ලක්ෂ 25 ක කාර් එකක් ගන්න පුළුවන්ද?');
        expect(p).toContain('instalment LKR 58,171 a month');
    });
    it('a follow-up is read with the line before it', () => {
        const ctx = advisorPage([{ role: 'user', content: 'Can I buy a car for 2.5M?' }, { role: 'assistant', content: 'It depends.' }, { role: 'user', content: 'and over 36 months?' }]);
        const p = ctx.WealthFlowAIv6.adaptiveSystemPrompt('finance', 'and over 36 months?');
        expect(p).toContain(`Borrow LKR 2,500,000 over 36 months at 14% a year: instalment LKR ${lkr(quote(2_500_000, 14, 36).payment)} a month`);
    });
    it('a plain money question gets the sheet and no block', () => {
        const p = advisorPage().WealthFlowAIv6.adaptiveSystemPrompt('finance', 'how am I doing this month?');
        expect(p).toContain("=== THE OWNER'S BOOKS");
        expect(p).not.toContain(HEAD);
    });
    it('code and image requests never get either, even with a figure in them', () => {
        const ctx = advisorPage();
        expect(ctx.WealthFlowAIv6.adaptiveSystemPrompt('code', 'write a function to buy a car for 2.5M')).not.toContain(HEAD);
        expect(ctx.WealthFlowAIv6.adaptiveSystemPrompt('image_gen', 'draw a car for 2.5M')).not.toContain(HEAD);
    });
    it('the finance protocol tells the model to copy the block and name what was assumed', () => {
        const p = advisorPage().WealthFlowAIv6.adaptiveSystemPrompt('finance', 'Can I buy a car for 2.5M?');
        expect(p).toMatch(/WHAT-IF/);
        expect(p).toMatch(/assum/i);
    });
    it('without the scenario module the prompt is the sheet alone', () => {
        const ctx = advisorPage();
        delete ctx.WFAdvisorScenarios;
        const p = ctx.WealthFlowAIv6.adaptiveSystemPrompt('finance', 'Can I buy a car for 2.5M?');
        expect(p).toContain("=== THE OWNER'S BOOKS");
        expect(p).not.toContain(HEAD);
    });
});

describe('the module registers itself the way the page expects', () => {
    it('exposes the same API on the default export', () => {
        for (const k of ['emi', 'quote', 'payDown', 'readNumbers', 'readScenario', 'merge', 'work', 'currentBlock', 'RULES', 'SCENARIO_VERSION']) expect(scenarios[k], k).toBeDefined();
        expect(p2(3)).toBe('03');
    });
});
