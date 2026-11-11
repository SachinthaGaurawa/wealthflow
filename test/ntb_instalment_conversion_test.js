import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { installmentInfo } from '../wealthflow-statement-router.js';
import { readPlanTable, planFor } from '../statement-plan-table.mjs';
import { conversionLegs } from '../statement-conversion.mjs';
import { cardDueRecord } from '../statement-due.mjs';
import { readStatement } from '../statement-reader.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';
import { loadParser } from './statement-fixtures.mjs';

/* A card purchase turned into an instalment plan, as Nations Trust Bank prints it (INVENTED figures, the layout is the bank's): the purchase is taken back (a credit), charged again (a debit) of the same
 * amount and words, and the first instalment follows as its own line, "INST 1 - REM BAL - 110000.00 - <1/12>". The pair cancels. It was filed as a 120,000 purchase AND a 120,000 card payment, and the
 * instalment line (which says "INST", not "instalment") as a one-time Shopping purchase: the month's spending and payments both 120,000 too big and the plan page empty. */

describe('Nations Trust plan wording', () => {
    it.each([
        ['SINGER 12M NATIONS PAY INST 1 - REM BAL - 110000.00 - <1/12>', { no: 1, of: 12, length: 12, name: 'SINGER' }],
        ['SAMPLEMART 24M NATIONS PAY INST 7 - REM BAL - 98,765.43 - <7/24>', { no: 7, of: 24, length: 24, name: 'SAMPLEMART' }],
    ])('%s is a plan line', (text, want) => { expect(installmentInfo(text)).toMatchObject({ isInstallment: true, ...want }); });
    it.each([
        'SINGER 12M NATIONS PAY',                                                    // the conversion legs name no instalment
        'SINGER 12M NATIONS PAY INST 3 - REM BAL - 90000.00 - <2/12>',               // the two numbers disagree: not read as a plan line
        'SINGER 12M NATIONS PAY INST 13 - REM BAL - 90000.00 - <13/12>',             // a month past the end
        'INSTALMENT FEE', 'KEELLS 05/12',
    ])('%s is not a plan line', text => { expect(installmentInfo(text).isInstallment).toBe(false); });
});

describe('Nations Trust "Installment Summary"', () => {
    const line = 'SINGER 12M NATIONS PAY 120,000.00 110,000.00 11/12 10,000.00';
    it('names the plan, its real total and what is left (23/24 means 23 still to pay)', () => {
        expect(readPlanTable(['Your Installment Summary', line, 'Total 120,000.00 110,000.00 10,000.00'].join('\n'))).toMatchObject([{ name: 'SINGER', months: 12, total: 120000, remainingMonths: 11, remainingAmount: 110000, monthly: 10000 }]);
        expect(readPlanTable('SAMPLEMART 24M NATIONS PAY 125,260.00 120,040.83 23/24 5,219.17')).toMatchObject([{ name: 'SAMPLEMART', months: 24, total: 125260, remainingMonths: 23, remainingAmount: 120040.83, monthly: 5219.17 }]);
    });
    it('a line whose own figures disagree is left out', () => {
        expect(readPlanTable('SINGER 12M NATIONS PAY 120,000.00 999,000.00 11/12 10,000.00')).toEqual([]);          // more owed than bought
        expect(readPlanTable('SINGER 12M NATIONS PAY 120,000.00 110,000.00 11/12 9,000.00')).toEqual([]);            // instalment times months is not the total
        expect(readPlanTable('SINGER 12M NATIONS PAY 120,000.00 110,000.00 13/12 10,000.00')).toEqual([]);           // more left than there are
    });
    it('the instalment line finds its plan by its money and its length', () => {
        const table = readPlanTable(line);
        expect(planFor(table, 10000, 12)).toMatchObject({ name: 'SINGER', total: 120000 });
        expect(planFor(table, 10000, 24)).toBeNull();
    });
});

const row = (date, narration, amount, direction, extra = {}) => ({ date, narration, amount, direction, valid: true, ...extra });
describe('the two legs of a conversion', () => {
    const credit = row('2026-10-24', 'SINGER 12M NATIONS PAY', 120000, 'credit'), debit = row('2026-10-24', 'SINGER 12M NATIONS PAY', 120000, 'debit');
    const plan = row('2026-10-24', 'SINGER 12M NATIONS PAY INST 1 - REM BAL - 110000.00 - <1/12>', 10000, 'debit');
    it('cancel: both are left out, the instalment line is not', () => {
        const legs = conversionLegs([credit, debit, plan]);
        expect(legs.has(credit)).toBe(true); expect(legs.has(debit)).toBe(true); expect(legs.has(plan)).toBe(false);
    });
    it('are found by the statement\'s own plan table when the words do not say plan', () => {
        const a = row('2026-10-24', 'SAMPLE ELECTRONICS', 120000, 'credit'), b = row('2026-10-25', 'SAMPLE ELECTRONICS', 120000, 'debit');
        expect(conversionLegs([a, b]).has(a)).toBe(false);
        const legs = conversionLegs([a, b], [{ total: 120000 }]);
        expect(legs.has(a) && legs.has(b)).toBe(true);
    });
    it('a refund of a plain purchase is a refund: no plan words, no plan table row', () => {
        const a = row('2026-10-24', 'SAMPLE SUPERMARKET', 5000, 'debit'), b = row('2026-10-24', 'SAMPLE SUPERMARKET', 5000, 'credit');
        const legs = conversionLegs([a, b]); expect(legs.has(a) || legs.has(b)).toBe(false);
    });
    it('is never a guess: another amount, other words, a different week, a lone leg or a bank account is left alone', () => {
        const other = (patch) => conversionLegs([credit, { ...debit, ...patch }]);
        expect(other({ amount: 119999.99 }).has(credit)).toBe(false);
        expect(other({ narration: 'SINGER 12M NATIONS PAY EXTRA' }).has(credit)).toBe(false);
        expect(other({ date: '2026-10-31' }).has(credit)).toBe(false);
        expect(conversionLegs([debit]).has(debit)).toBe(false);
        expect(conversionLegs([credit, debit], [], () => false).has(credit)).toBe(false);
    });
    it('two conversions of one amount on one day take two pairs, a third lone debit stays', () => {
        const c2 = { ...credit }, d2 = { ...debit }, d3 = { ...debit };
        const legs = conversionLegs([credit, debit, c2, d2, d3]);
        expect([credit, debit, c2, d2].every(r => legs.has(r))).toBe(true); expect(legs.has(d3)).toBe(false);
    });
});

describe('the foot of a Nations Trust statement', () => {
    const P = loadParser(fs);
    it('reads "Total Outstanding Due" as what is owed, beside the minimum and the date', () => {
        const out = P.parseStatement(['CREDIT CARD STATEMENT', 'Statement Period: 11-Oct-2026 to 10-Nov-2026', 'Credit Limit 300,000', 'Minimum Payment Due 3,231.00', 'Total Outstanding Due 80,775.00', 'Payment Due Date 30-NOV-2026',
            '12 OCT 12 OCT SAMPLE FOOD CITY LKR 6,000.00 6,000.00 Dr'].join('\n'));
        expect(out.due).toMatchObject({ date: '2026-11-30', minimum: 3231, closing: 80775, periodEnd: '2026-11-10' });
    });
    it('a balance the page did not print is not 0: the record leaves it out', () => {
        const rec = cardDueRecord({ due: { date: '2026-11-30', minimum: 3231, closing: null }, sourcePath: 'wf-mail/x/items/a', statementType: 'credit-card' });
        expect(rec.minimum).toBe(3231); expect('closing' in rec).toBe(false);
    });
});

/* the whole path: a real PDF, the worker, the books */
function pdf(texts) {
    const stream = `BT /F1 12 Tf 50 750 Td ${texts.map((t, i) => `${i ? '0 -14 Td ' : ''}(${t.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n')} ET`;
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
    let out = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const start = Buffer.byteLength(out);
    out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(out);
}
const SUMMARY = 'Opening Balance Purchases Cash Advances Interest Charges Payments Other Credits Closing Balance';
const HEAD = (period, due, minimum, closing) => ['Nations Trust Bank American Express Magnet Card', 'Monthly Statement', `Statement Period: ${period}`, 'Card No: 376657*****1234', 'Credit Limit 300,000', `Minimum Payment Due ${minimum}`, 'Past Due 0.00',
    `Total Outstanding Due ${closing}`, `Payment Due Date ${due}`, 'Your Transactions', SUMMARY];
const COLS = 'Post Date Transaction Date Description Transaction Currency Amount Amount (LKR)';
const OCT = pdf([...HEAD('11-Oct-2026 to 10-Nov-2026', '30-NOV-2026', '3,231.00', '80,775.00'), '100,000.00 148,500.00 0.00 3,000.00 275.00 50,000.00 121,000.00 80,775.00', COLS,
    '12 OCT 09 OCT ANTHROPIC* CLAUDE SUB USD 20.00 7,000.00 Dr',
    '13 OCT 13 OCT SAMPLE FOOD CITY KULIYA LKR 6,000.00 6,000.00 Dr',
    '16 OCT 14 OCT NETFLIX.COM USD 10.00 3,500.00 Dr',
    '14 OCT 14 OCT CASHBACK ON YOUR SEP NETFLIX SUBSCRIPTION LKR 1,000.00 1,000.00 Cr',
    '24 OCT 24 OCT SINGER 12M NATIONS PAY LKR 120,000.00 120,000.00 Cr',
    '24 OCT 24 OCT SINGER 12M NATIONS PAY LKR 120,000.00 120,000.00 Dr',
    '24 OCT 24 OCT SINGER 12M NATIONS PAY INST 1 - REM BAL - 110000.00 - <1/12> LKR 10,000.00 10,000.00 Dr',
    '26 OCT 26 OCT CASH PAYMENT-FINACLE LKR 50,000.00 50,000.00 Cr',
    '28 OCT 28 OCT SAMPLE FOOD DELIVERY LKR 2,000.00 2,000.00 Dr',
    '10 NOV 10 NOV DEBIT INTEREST LKR 3,000.00 3,000.00 Dr',
    '10 NOV 10 NOV STAMP DUTY LKR 275.00 275.00 Dr',
    'Your Installment Summary', 'Merchant Name Original Purchase Amount Amount Outstanding Remaining Installments Next Installment Amount', 'SINGER 12M NATIONS PAY 120,000.00 110,000.00 11/12 10,000.00', 'Total 120,000.00 110,000.00 10,000.00']);
const NOV = pdf([...HEAD('11-Nov-2026 to 10-Dec-2026', '30-DEC-2026', '3,631.00', '90,775.00'), '80,775.00 10,000.00 0.00 0.00 0.00 0.00 0.00 90,775.00', COLS,
    '24 NOV 24 NOV SINGER 12M NATIONS PAY INST 2 - REM BAL - 100000.00 - <2/12> LKR 10,000.00 10,000.00 Dr',
    'Your Installment Summary', 'Merchant Name Original Purchase Amount Amount Outstanding Remaining Installments Next Installment Amount', 'SINGER 12M NATIONS PAY 120,000.00 100,000.00 10/12 10,000.00', 'Total 120,000.00 100,000.00 10,000.00']);

async function file(user, bytes, received) {
    const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`, email = 'owner@example.com';
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email, refresh_token: 'r', autonomous: true, senders: [{ id: 'nationstrust@estmt.nationstrust.com', kind: 'address', status: 'approved', name: 'American Express (AMEX)', domain: 'estmt.nationstrust.com' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ccinstall: [], loans: [], subscriptions: [], cheques: [], cardDues: [], ...user },
        [sourcePath]: { uid: 'u', bank: 'American Express (AMEX)', filename: 'AMEX_Statement.pdf', from: 'nationstrust@estmt.nationstrust.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: received },
    });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        await runStatementSync({ action: 'drain', db, owner: { uid: 'u', email }, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), read: readStatement, open: async () => [], settle: settleStatement,
            board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment: async () => ({ bytes, filename: 'AMEX_Statement.pdf', contentSha256: String(received) }) });
    } finally { spy.mockRestore(); }
    return { user: data.get('users/u'), item: data.get(sourcePath), data };
}
const sum = list => Math.round(list.reduce((t, r) => t + Math.round(r.amount * 100), 0)) / 100;

describe('end to end: a statement with a purchase turned into a plan', () => {
    it('files the money as the owner really spent and paid it', async () => {
        const { user, item, data } = await file({}, OCT, Date.parse('2026-11-11T05:00:00Z'));
        expect(item).toMatchObject({ status: 'filed', hasReview: false, totalRows: 11 });
        /* spending: the purchases, interest and stamp duty; NOT the 120,000 that was taken back and charged again */
        expect(user.cconetime.map(r => r.amount).sort((a, b) => a - b)).toEqual([275, 2000, 3000, 3500, 6000, 7000]);
        expect(sum(user.cconetime)).toBe(21775);
        /* payments and credits: what reached the card; NOT the 120,000 reversal */
        expect(user.ccPayments.map(r => [r.desc, r.amount]).sort((a, b) => a[1] - b[1])).toEqual([['CASHBACK ON YOUR SEP NETFLIX SUBSCRIPTION', 1000], ['CASH PAYMENT-FINACLE', 50000]]);
        /* the plan: named after the shop, the real total from the statement's table, one instalment paid */
        expect(user.ccinstall).toHaveLength(1);
        expect(user.ccinstall[0]).toMatchObject({ product: 'SINGER', duration: 12, total: 120000, totalEstimated: false, monthly: 10000, paid: 1, remaining: 11, installmentNo: 1, installmentOf: 12, planRef: 'ntb-singer-12000000' });
        /* subscriptions keep their own entries, in the card's own amount (rupees, not dollars) */
        expect(user.subscriptions.map(s => [s.name, s.amount]).sort()).toEqual([['Anthropic (Claude)', 7000], ['Netflix', 3500]]);
        /* the legs are on the ledger as decided, not missing, and say why */
        const legs = [...data.entries()].filter(([path, v]) => /statementLedger/.test(path) && v.reason === 'instalment-conversion');
        expect(legs).toHaveLength(2);
        expect(legs.every(([, v]) => v.status === 'skipped' && v.module === 'skip')).toBe(true);
        /* the minimum payment and what is owed are on the dues list, the way the statement printed them */
        expect(user.cardDues).toMatchObject([{ minimum: 3231, closing: 80775, dueDate: '2026-11-30', card_last4: '1234' }]);
    });
    it('next month\'s instalment is the same plan\'s second month, not a second plan', async () => {
        const first = await file({}, OCT, Date.parse('2026-11-11T05:00:00Z'));
        const second = await file(first.user, NOV, Date.parse('2026-12-11T05:00:00Z'));
        expect(second.user.ccinstall).toHaveLength(1);
        expect(second.user.ccinstall[0]).toMatchObject({ product: 'SINGER', paid: 2, remaining: 10, installmentNo: 2 });
        expect(second.user.ccinstall[0].payments.map(p => p.month)).toEqual(['2026-10', '2026-11']);
        expect(second.user.cconetime).toHaveLength(6);
    });
});

describe('the manual upload reads the same rule', () => {
    const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    it('a credit-card upload leaves the two legs of a conversion out, through the router both doors share', () => {
        expect(html).toContain("_R.conversionLegs(txns, [], () => true)");
        expect(html).toMatch(/_acctType === 'credit_card' && _R && _R\.conversionLegs/);
    });
});
