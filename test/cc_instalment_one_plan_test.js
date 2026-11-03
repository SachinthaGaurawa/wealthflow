import { describe, expect, it, vi } from 'vitest';
import { installmentInfo } from '../wealthflow-statement-router.js';
import { planFromLine, mergeInstalmentSeries, matchInstallmentPlan, applyPlanPayment, planCountedIn } from '../statement-links.mjs';
import { readStatement } from '../statement-reader.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync, repairCardInstallments } from '../statement-sync.js';
import { settleStatement, resolveReview, sourceOccurrenceId } from '../statement-ledger.mjs';

/* ONE PLAN, ONE ROW. The owner, 2026-11-03: "the durations are fake — the statement says how many instalments (or the months) there are; one instalment is one month", and "duplicates". HNB's
 * "Principle" lines said "1 of 12" in August and "2 of 12" in September, and each month was filed as a plan of its own, one month long: four rows in CC Instalments for two plans. */

describe('the length of a plan is what its line says, nothing else', () => {
    it.each([
        ['INSTALLMENT 03/12 ABANS', 12], ['Instalment Pymt 3 of 12 ABANS PLC', 12], ['EPP 05/12 SINGER', 12], ['EASY PAY 6 MONTHS SINGER', 6], ['SINGER 6 INSTALMENTS', 6], ['EASY PAY 18 MTHS ABANS', 18],
        ['ABANS TV INSTALMENT', 0], ['ABANS INSTALMENT 13/09/2026', 0], ['ABANS INSTALMENT 14/12', 0], ['INSTALMENT 1 MONTH ABANS', 0],
    ])('%s says %i', (text, length) => { expect(installmentInfo(text).length).toBe(length); });
    it('the merchant is still what is left of the words', () => {
        expect(installmentInfo('SINGER 6 INSTALMENTS').name).toBe('SINGER');
        expect(installmentInfo('EASY PAY 6 MONTHS SINGER').name).toBe('SINGER');
    });
    it('"2 of 12" is a twelve-month plan that began a month before; no length is a one-month plan that says so', () => {
        expect(planFromLine({ amount: 14639.51, date: '2026-09-24', no: 2, length: 12 })).toMatchObject({ duration: 12, months: 12, date: '2026-08-01', total: 175674.12, totalEstimated: true, paid: 2, remaining: 10 });
        expect(planFromLine({ amount: 5000, date: '2026-09-12', no: 0, length: 6 })).toMatchObject({ duration: 6, date: '2026-09-01', paid: 1, remaining: 5 });
        expect(planFromLine({ amount: 5000, date: '2026-09-12' })).toMatchObject({ duration: 1, date: '2026-09-01', durationUnknown: true, total: 5000 });
        expect(planFromLine({ amount: 5000, date: '2026-02-12', no: 3, length: 12 }).date).toBe('2025-12-01');     // across a year end
    });
});

/* the records exactly as the one-month version filed them */
const old = (id, date, amount, no, extra = {}) => ({ id, product: 'Principle', bank: 'HNB Credit Card', card_last4: '0048', buyer: 'Self', rate: 0, duration: 1, date: `${date.slice(0, 7)}-01`, completed: false, skipped: [], source: 'statement', statementKey: 'wf-mail/o/items/' + date, statementRow: 0,
    notes: `Card installment charge of ${date}${no ? ` (${no} of 12)` : ''}`, total: amount, monthly: amount, months: 1, remaining: 1, paid: 0, startDate: date, amount, desc: 'INSTALMENT PRINCIPLE', ...(no ? { installmentNo: no, installmentOf: 12 } : {}), ...extra });
const owner = () => ({ ccinstall: [old('A1', '2026-08-24', 14639.51, 1), old('A2', '2026-09-24', 14639.51, 2), old('B1', '2026-08-25', 1110, 1), old('B2', '2026-09-25', 1110, 2)] });
const shown = (user) => user.ccinstall.filter((r) => !r.mergedInto);

describe('the months of one plan, filed one by one, become one plan', () => {
    it('the four rows of the owner\'s page are two plans of twelve months, begun in August, two months paid', () => {
        const user = owner(), done = mergeInstalmentSeries(user, 1000);
        expect(done.map((d) => d.kind).sort()).toEqual(['series', 'series']);
        expect(shown(user)).toHaveLength(2);
        const [big, small] = shown(user).sort((a, b) => b.monthly - a.monthly);
        expect(big).toMatchObject({ id: 'A1', duration: 12, months: 12, date: '2026-08-01', monthly: 14639.51, total: 175674.12, totalEstimated: true, paid: 2, remaining: 10, installmentNo: 2, installmentOf: 12, completed: false, rateUnknown: true, mergedFrom: ['A2'] });
        expect(big.payments.map((p) => [p.month, p.paid, p.amount])).toEqual([['2026-08', true, 14639.51], ['2026-09', true, 14639.51]]);
        expect(small).toMatchObject({ id: 'B1', duration: 12, date: '2026-08-01', monthly: 1110, total: 13320, paid: 2, remaining: 10, mergedFrom: ['B2'] });
        expect(big.notes).toBe('Card installment charge of 2026-09-24 (2 of 12)');
        /* nothing was deleted: the other months stay in the data, finished, and say where they went (so the ledger's rows are not "missing") */
        expect(user.ccinstall.filter((r) => r.mergedInto)).toMatchObject([{ id: 'A2', mergedInto: 'A1', completed: true }, { id: 'B2', mergedInto: 'B1', completed: true }]);
        for (const ym of ['2026-08', '2026-11', '2027-07']) expect(planCountedIn(big, ym), ym).toBe(true);
        expect(planCountedIn(big, '2027-08')).toBe(false);
    });
    it('is done once: a second pass changes nothing', () => {
        const user = owner(); mergeInstalmentSeries(user, 1000);
        const before = JSON.stringify(user);
        expect(mergeInstalmentSeries(user, 2000)).toEqual([]);
        expect(JSON.stringify(user)).toBe(before);
    });
    it('reads "(2 of 12)" from the note when the record does not carry the numbers', () => {
        const user = { ccinstall: [old('A1', '2026-08-24', 14639.51, 1), old('A2', '2026-09-24', 14639.51, 2)].map((r) => { const { installmentNo, installmentOf, ...rest } = r; return rest; }) };
        expect(mergeInstalmentSeries(user, 1).map((d) => d.kind)).toEqual(['series']);
        expect(shown(user)[0]).toMatchObject({ duration: 12, installmentNo: 2, date: '2026-08-01' });
    });
    it('a single record of a stated plan gets its real length too', () => {
        const user = { ccinstall: [old('A2', '2026-09-24', 14639.51, 2)] };
        expect(mergeInstalmentSeries(user, 1).map((d) => d.kind)).toEqual(['length']);
        expect(user.ccinstall[0]).toMatchObject({ duration: 12, date: '2026-08-01', paid: 2, remaining: 10 });
    });
    it('the same statement row filed twice is one month; two different rows for one month are two plans and stay two', () => {
        const twice = { ccinstall: [old('A1', '2026-09-24', 5000, 2), old('A1b', '2026-09-24', 5000, 2, { id: 'A1b' })] };     // the very same statement row (same key and row)
        mergeInstalmentSeries(twice, 1);
        expect(shown(twice)).toHaveLength(1);
        const two = { ccinstall: [old('A1', '2026-09-24', 5000, 2), old('A1b', '2026-09-24', 5000, 2, { id: 'A1b', statementKey: 'wf-mail/o/items/other' })] };
        mergeInstalmentSeries(two, 1);
        expect(shown(two)).toHaveLength(2);
    });
    it('a plan of another card, another name or other money is another plan', () => {
        const user = { ccinstall: [old('A1', '2026-08-24', 5000, 1), old('A2', '2026-09-24', 5000, 2, { card_last4: '1111' }), old('A3', '2026-09-24', 9000, 2), old('A4', '2026-09-24', 5000, 2, { product: 'Singer' })] };
        mergeInstalmentSeries(user, 1);
        expect(shown(user)).toHaveLength(4);
        expect(shown(user).every((r) => r.duration === 12)).toBe(true);
    });
    it('a plan the owner keeps under their own name takes the months as its payments, and no second plan is made', () => {
        const mine = { id: 'P1', product: 'Principle', bank: 'HNB Credit Card', monthly: 14639.51, total: 175674.12, rate: 0, duration: 12, date: '2026-08-10', completed: false, skipped: [] };
        const user = { ccinstall: [mine, old('A1', '2026-08-24', 14639.51, 1), old('A2', '2026-09-24', 14639.51, 2)] };
        expect(mergeInstalmentSeries(user, 1).map((d) => d.kind)).toEqual(['owner-plan']);
        expect(user.ccinstall[0].payments.map((p) => p.month)).toEqual(['2026-08', '2026-09']);
        expect(shown(user)).toHaveLength(1);
    });
    it('lines that never said how long the plan is: the months seen are one plan that says its length is not on the statement', () => {
        const user = { ccinstall: [old('C1', '2026-07-12', 5000, 0, { product: 'Abans TV' }), old('C2', '2026-08-12', 5000, 0, { product: 'Abans TV' }), old('C3', '2026-09-12', 5000, 0, { product: 'Abans TV' })] };
        expect(mergeInstalmentSeries(user, 1).map((d) => d.kind)).toEqual(['series-open']);
        expect(shown(user)).toHaveLength(1);
        expect(shown(user)[0]).toMatchObject({ id: 'C1', duration: 3, date: '2026-07-01', durationUnknown: true, paid: 3, total: 15000 });
        /* and the next month's line is that plan's next month, not a fourth plan */
        const line = { description: 'ABANS TV INSTALMENT', amount: 5000, date: '2026-10-12' };
        const plan = matchInstallmentPlan(line, shown(user), { installment: true, bank: 'HNB Credit Card' });
        expect(plan.id).toBe('C1');
        applyPlanPayment(plan, line, 'wf-mail/o/items/oct', 0, 5);
        expect(plan).toMatchObject({ duration: 4, months: 4, total: 20000, paid: 4 });
    });
});

describe('the idle pass puts the owner\'s page right and says so in one counts-only line', () => {
    it('on the owner\'s own data, once', async () => {
        const { db, data } = createFirestore({ 'users/u': owner() });
        const lines = [];
        expect((await repairCardInstallments({ db, uid: 'u', log: (l) => lines.push(l) })).repaired).toBe(2);
        expect(JSON.parse(lines[0])).toMatchObject({ evt: 'card-installment-repair', repaired: 2, kinds: { series: 2 } });
        expect(JSON.stringify(lines)).not.toMatch(/Principle|14639|1110/);
        expect(shown(data.get('users/u'))).toHaveLength(2);
        expect((await repairCardInstallments({ db, uid: 'u', log: () => {} })).repaired).toBe(0);
    });
});

/* a card statement, end to end: the second month's line is the same plan's second month */
const CARD = (day, line, amount) => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 16/${day.slice(3, 5)}/2026 Payment Due Date: 10/${day.slice(3, 5)}/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>${day}/2026</td><td>${line}</td><td>${amount} DR</td></tr></table></body></html>`;
async function file(user, html, received) {
    const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`, email = 'owner@example.com';
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email, refresh_token: 'r', autonomous: true, senders: [{ id: 'nationstrust@estmt.nationstrust.com', kind: 'address', status: 'approved', name: 'American Express (AMEX)', domain: 'estmt.nationstrust.com' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ccinstall: [], loans: [], subscriptions: [], cheques: [], ...user },
        [sourcePath]: { uid: 'u', bank: 'American Express (AMEX)', filename: 'AMEX_Statement.html', from: 'nationstrust@estmt.nationstrust.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: received },
    });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        await runStatementSync({ action: 'drain', db, owner: { uid: 'u', email }, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), read: readStatement, open: async () => [], settle: settleStatement,
            board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment: async () => ({ bytes: Buffer.from(html), filename: 'AMEX_Statement.html', contentSha256: 'x' }) });
    } finally { spy.mockRestore(); }
    return data.get('users/u');
}
describe('end to end: two months of one plan', () => {
    it('August makes the twelve-month plan; September is its second month, not a second plan', async () => {
        const august = await file({}, CARD('12/08', 'INSTALMENT 01/12 PRINCIPLE', '14639.51'), Date.parse('2026-08-17T05:00:00Z'));
        expect(august.ccinstall).toHaveLength(1);
        expect(august.ccinstall[0]).toMatchObject({ duration: 12, date: '2026-08-01', paid: 1, remaining: 11, installmentNo: 1, installmentOf: 12 });
        const september = await file(august, CARD('12/09', 'INSTALMENT 02/12 PRINCIPLE', '14639.51'), Date.parse('2026-09-17T05:00:00Z'));
        expect(september.ccinstall).toHaveLength(1);
        expect(september.ccinstall[0]).toMatchObject({ duration: 12, date: '2026-08-01', paid: 2, remaining: 10, installmentNo: 2, notes: 'Card installment charge of 2026-09-12 (2 of 12)' });
        expect(september.ccinstall[0].payments.map((p) => p.month)).toEqual(['2026-08', '2026-09']);
    });
});

/* the page: the figures above the table count what the table calls Active, merged months are not listed, and nothing is shown that the statement did not print */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
describe('the CC Instalments page tells the truth', () => {
    const start = html.indexOf('function _cciEndOf('), body = html.slice(start, html.indexOf('\n        }', start) + 10);
    const endOf = (x) => { const ctx = vm.createContext({ Date }); vm.runInContext(body, ctx); return vm.runInContext('_cciEndOf', ctx)(x); };
    it('a plan ends at its start plus its length', () => { expect(endOf({ date: '2026-08-01', duration: 12 }).getFullYear()).toBe(2027); expect(endOf({ date: '2026-08-01', duration: 12 }).getMonth()).toBe(7); });
    it('a plan whose length is not on the statement is not "Done" while it is still being charged: it ends three months after the last charge seen', () => {
        const end = endOf({ date: '2026-07-01', duration: 3, durationUnknown: true, payments: [{ month: '2026-08', paid: true }, { month: '2026-09', paid: true }] });
        expect([end.getFullYear(), end.getMonth()]).toEqual([2026, 11]);
    });
    it('the figures count the plans the table calls Active, and the merged months are not listed', () => {
        expect(html).toMatch(/let arr = \(DB\.get\('ccinstall'\) \|\| \[\]\)\.filter\(x => x && !x\.mergedInto\);/);
        expect(html).toMatch(/const active = arr\.filter\(x => !_cciDone\(x\)\);/);
        expect(html).toMatch(/const finished = item\.completed \|\| end <= new Date\(\)/);
    });
    it('an estimate says it is an estimate, an unprinted rate is not "0% Free", an unprinted length is not a number', () => {
        expect(html).toContain("item.totalEstimated ? '<div class=\"td-m\" style=\"font-size:10px;\">estimate</div>'");
        expect(html).toContain("item.rateUnknown ? '<span class=\"td-m\" style=\"font-size:10px;\">not stated</span>' : '0% Free'");
        expect(html).toContain("item.durationUnknown ? item.duration + 'M+<div class=\"td-m\" style=\"font-size:10px;\">length not stated</div>' : item.duration + 'M'");
    });
});

describe('a plan line resolved from the review list is the same plan\'s next month too', () => {
    const sourcePath = 'wf-mail/owner/items/hnb1.pdf';
    const waiting = (index, narration, date) => { const id = sourceOccurrenceId(sourcePath, index);
        return { id, review: [`users/u/statementReview/${id}`, { uid: 'u', sourcePath, index, status: 'pending', reason: 'unproven-direction', bank: 'HNB Credit Card', row: { date, narration, description: narration, amount: 14639.51, direction: 'debit', directionSource: 'assumed', needsReview: true, valid: true } }], ledger: [`users/u/statementLedger/${id}`, { uid: 'u', sourcePath, index, status: 'review' }] }; };
    it('August makes the plan, September is its second month: one plan, the ledger says the row is counted by it', async () => {
        const a = waiting(0, 'INSTALMENT 01/12 PRINCIPLE', '2026-08-24'), b = waiting(1, 'INSTALMENT 02/12 PRINCIPLE', '2026-09-24');
        const { db, data } = createFirestore(Object.fromEntries([['users/u', { settings: { cardRegistry: { '0048': { type: 'credit_card', bank: 'HNB' } } } }],
            [sourcePath, { uid: 'u', bank: 'HNB Credit Card', last4: '0048', statementType: 'credit-card', cursor: 2, totalRows: 2, status: 'needs_review' }], a.review, a.ledger, b.review, b.ledger]));
        const decision = { module: 'ccinstall', category: 'Card Instalments', verified: true };
        await resolveReview({ db, uid: 'u', id: a.id, decision, row: {}, directionSource: 'layout' });
        await resolveReview({ db, uid: 'u', id: b.id, decision, row: {}, directionSource: 'layout' });
        const plans = data.get('users/u').ccinstall;
        expect(plans).toHaveLength(1);
        expect(plans[0]).toMatchObject({ duration: 12, date: '2026-08-01', installmentNo: 2, paid: 2, remaining: 10 });
        expect(plans[0].payments.map((p) => p.month)).toEqual(['2026-08', '2026-09']);
        expect(data.get(`users/${'u'}/statementLedger/${b.id}`)).toMatchObject({ status: 'duplicate', reason: 'counted-by-installment-plan', matchedId: plans[0].id });
        expect(data.get(`users/u/statementReview/${b.id}`).status).toBe('resolved');
    });
});
