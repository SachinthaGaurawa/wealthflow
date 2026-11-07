import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { textPdf } from './helpers/embedded-statements.js';
import { readStatement } from '../statement-reader.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync, unfileStatement } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';
import { incomeIn } from '../wealthflow-reactive.js';
import { matchSubscriptionForDebit } from '../statement-links.mjs';
import { deterministicDecision } from '../statement-sync.js';
import '../statement-merchants.mjs';
import { phoneKeys, brandsOf, identityOf, subscriptionToCreate, prettyPhone } from '../statement-subscriptions.mjs';

// Which subscription (or phone bill) is a statement payment? All names, numbers and amounts here are invented.

const D = (description, amount = 1000, date = '2026-03-09') => ({ description, amount, date, direction: 'debit' });

describe('the right tab and category for rows the rules used to get wrong', () => {
    const debit = text => deterministicDecision({ description: text, narration: text, amount: 1000, direction: 'debit', date: '2026-10-05' }, {});
    const credit = (text, ctx = {}) => deterministicDecision({ description: text, narration: text, amount: 1000, direction: 'credit', date: '2026-10-05' }, ctx);
    it('rent paid is Rent; cash from an ATM is a cash withdrawal', () => {
        expect(debit('HOUSE RENT OCT')).toMatchObject({ module: 'expenses', category: 'Rent' });
        expect(debit('PAYMENT TO LANDLORD')).toMatchObject({ module: 'expenses', category: 'Rent' });
        expect(debit('ATM WDL KANDY')).toMatchObject({ module: 'expenses', category: 'Cash Withdrawal' });
        expect(debit('CAR RENTAL COLOMBO').category).not.toBe('Rent');
    });
    it('money in that says where it came from is income, not a card payment; a card\'s thank-you is still a card payment', () => {
        expect(credit('PAYMENT RECEIVED FREELANCE')).toMatchObject({ module: 'incomeRecv', category: 'Business' });
        expect(credit('PAYMENT RECEIVED INVOICE 1042')).toMatchObject({ module: 'incomeRecv' });
        expect(credit('PAYMENT RECEIVED THANK YOU', { statementType: 'credit_card' })).toMatchObject({ module: 'ccPayments' });
        expect(credit('SALARY OCT SAMPLE PVT LTD')).toMatchObject({ module: 'incomeRecv', category: 'Salary' });
    });
});

describe('phone numbers are read however the bank wrote them', () => {
    it('one number, many spellings', () => {
        for (const text of ['DIALOG 0771234567', 'DIALOG 077 123 4567', 'pay +94 77-123-4567', 'IB BILL 94771234567', 'REF 0094 77 123 4567 END', 'TOPUP (077) 123.4567']) expect(phoneKeys(text), text).toEqual(['771234567']);
        expect(prettyPhone('771234567')).toBe('077 123 4567');
    });
    it('a landline, two numbers, and things that are not phone numbers', () => {
        expect(phoneKeys('SLT FIBRE 0112345678')).toEqual(['112345678']);
        expect(phoneKeys('0771234567 0711234567')).toEqual(['771234567', '711234567']);
        for (const text of ['REF 0123456789', 'ACC 07712345678901', 'CARD 4512 3456 7890 1234', 'INVOICE 1234567', 'DR 0771234']) expect(phoneKeys(text), text).toEqual([]);
    });
});

describe('brands are the business, not the spelling', () => {
    it('the words banks print for one business are one brand', () => {
        const key = text => brandsOf(text).map(b => b.key);
        expect(key('ANTHROPIC SAN FRANCISCO CA')).toEqual(['anthropic']);
        expect(key('CLAUDE.AI SUBSCRIPTION')).toEqual(['anthropic']);
        expect(key('Claude Pro')).toEqual(['anthropic']);
        expect(key('OPENAI *CHATGPT SUBSCR')).toEqual(['openai']);
        expect(key('GOOGLE *YOUTUBEPREMIUM')).toEqual(['google']);
        expect(key('APPLE.COM/BILL')).toEqual(['apple']);
        expect(key('MICROSOFT*MICROSOFT 365')).toEqual(['microsoft']);
        expect(key('DIALOG AXIATA PLC')).toEqual(['dialog']);
        expect(key('CLAUDE PERERA SALARY')).toEqual([]);          // a person called Claude is not Anthropic
        expect(key('GOOGLE *CLOUD')).toEqual([]);                  // nor is every Google charge a subscription
    });
});

describe('matching a payment to the entry that is already there', () => {
    const phone = { id: 'P1', name: 'Mobile Connection (0771234567)', amount: 1800, cycle: 'monthly', createdAt: '2026-01-01T00:00:00Z' };
    it('the number identifies a phone bill whatever the amount, and a second payment in the month is added to it', () => {
        expect(matchSubscriptionForDebit(D('IB BILL PAYMENT 077 123 4567', 3300), [phone]).id).toBe('P1');
        expect(matchSubscriptionForDebit(D('DIALOG RELOAD 0771234567', 100), [phone]).id).toBe('P1');
        expect(matchSubscriptionForDebit(D('DIALOG RELOAD 0711234567', 100), [phone])).toBeNull();          // another number
        const paid = { ...phone, history: [{ month: '2026-03', amount: 1800, date: '2026-03-02', source: 'statement' }] };
        expect(matchSubscriptionForDebit(D('DIALOG RELOAD 0771234567', 500), [paid]).id).toBe('P1');         // same number, same month: still its payment
        expect(matchSubscriptionForDebit(D('DIALOG RELOAD 0771234567', 500), [phone, { ...phone, id: 'P2' }])).toBeNull();   // two entries with one number: not guessed
    });
    it('the brand an entry is named after is found in the bank\'s words for it', () => {
        const claude = { id: 'C1', name: 'Claude Pro', amount: 5200, cycle: 'monthly', createdAt: '2026-01-01T00:00:00Z' };
        expect(matchSubscriptionForDebit(D('ANTHROPIC SAN FRANCISCO CA', 5200), [claude]).id).toBe('C1');
        expect(matchSubscriptionForDebit(D('CLAUDE.AI SUBSCRIPTION', 5300), [claude]).id).toBe('C1');
        expect(matchSubscriptionForDebit(D('ANTHROPIC SAN FRANCISCO CA', 90000), [claude])).toBeNull();     // a different charge
        const chat = { id: 'G1', name: 'ChatGPT Plus', amount: 6000, cycle: 'monthly', createdAt: '2026-01-01T00:00:00Z' };
        expect(matchSubscriptionForDebit(D('OPENAI *CHATGPT SUBSCR', 6000), [claude, chat]).id).toBe('G1');
    });
    it('two entries of one brand are told apart by the amount, and not guessed when that does not settle it', () => {
        const icloud = { id: 'A1', name: 'iCloud', amount: 450, cycle: 'monthly', createdAt: '2026-01-01T00:00:00Z' };
        const music = { id: 'A2', name: 'Apple Music', amount: 1100, cycle: 'monthly', createdAt: '2026-01-01T00:00:00Z' };
        expect(matchSubscriptionForDebit(D('APPLE.COM/BILL', 450), [icloud, music]).id).toBe('A1');
        expect(matchSubscriptionForDebit(D('APPLE.COM/BILL', 1100), [icloud, music]).id).toBe('A2');
        expect(matchSubscriptionForDebit(D('APPLE.COM/BILL', 600), [icloud, music])).toBeNull();
    });
    it('what the manual upload stored on an entry counts as its identity', () => {
        expect(identityOf({ name: 'Home phone', merchantKeys: ['mobile:0771234567'] }).phones).toEqual(['771234567']);
        expect(identityOf({ name: 'Streaming', merchantKeys: ['brand:netflix'] }).brands).toEqual(['netflix']);
    });
});

describe('a payment that is plainly a subscription starts its own entry', () => {
    it('a brand that is bought by subscription', () => {
        expect(subscriptionToCreate(D('ANTHROPIC SAN FRANCISCO CA', 5200))).toMatchObject({ name: 'Anthropic (Claude)', category: 'Software' });
        expect(subscriptionToCreate(D('NETFLIX.COM', 1500))).toMatchObject({ name: 'Netflix', category: 'Streaming' });
        expect(subscriptionToCreate(D('ICLOUD STORAGE', 450))).toMatchObject({ category: 'Software' });
        expect(subscriptionToCreate(D('APPLE.COM/BILL', 450))).toBeNull();            // as often an app bought once: it finds an entry the owner tracks, but starts none
    });
    it('a mobile number being paid', () => {
        expect(subscriptionToCreate(D('DIALOG 0771234567', 1800))).toMatchObject({ name: 'Dialog 077 123 4567', category: 'Telecom', merchantKeys: ['mobile:0771234567'] });
        expect(subscriptionToCreate(D('IB BILL PAYMENT 077 123 4567', 1800))).toMatchObject({ name: 'Mobile 077 123 4567', category: 'Telecom' });
    });
    it('not a transfer to a person, not a company without a number, not two numbers, not money in', () => {
        expect(subscriptionToCreate(D('CEFT TRANSFER J SMITH 0771234567', 2000))).toBeNull();
        expect(subscriptionToCreate(D('LOAN INSTALMENT 0741234567', 45230.5))).toBeNull();          // an account number that looks like a phone number
        expect(subscriptionToCreate(D('PAYMENT 0771234567', 1800))).toBeNull();                     // a number alone is not enough
        expect(subscriptionToCreate(D('DIALOG', 1800))).toBeNull();
        expect(subscriptionToCreate(D('DIALOG 0771234567 0711234567', 1800))).toBeNull();
        expect(subscriptionToCreate(D('POS KEELLS SUPER', 4000))).toBeNull();
        expect(subscriptionToCreate({ ...D('NETFLIX.COM', 1500), direction: 'credit' })).toBeNull();
    });
});

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const src = n => { const s = html.indexOf(`function ${n}(`); const from = html.slice(s - 6, s) === 'async ' ? s - 6 : s; return html.slice(from, html.indexOf('\n        }', s) + 10); };
function monthly(user, year = 2026, month = 2) {
    const store = { loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [], ...user };
    const ctx = vm.createContext({ DB: { get: k => store[k] || [] }, p2: n => String(n).padStart(2, '0'), window: { WFReactive: { incomeIn } }, Date });
    for (const n of ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', 'loanEndDate', 'getLoanMonthlyForDate', '_wfLinkedLoanMonths', 'getCCIMonthlyForDate', '_wfFindLoanDebit', '_wfMonthIsFuture', 'getMonthlyData']) vm.runInContext(src(n), ctx);
    return ctx.getMonthlyData(year, month);
}
const STATEMENT = rows => `
HATTON NATIONAL BANK PLC
Statement Period: 01/03/2026 - 31/03/2026
Account Number: 074020012388
Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance
01/03/2026 Opening Balance 500,000.00
${rows}
`;
async function file(user, rows, whole = false) {
    const owner = { uid: 'u', email: 'owner@example.com' }, mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@hnb.lk', kind: 'address', status: 'approved', name: 'HNB', domain: 'hnb.lk' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ccinstall: [], loans: [], subscriptions: [], cheques: [], ...user },
        [sourcePath]: { uid: 'u', bank: 'HNB', filename: 'statement.pdf', from: 'statements@hnb.lk', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-04-02T05:00:00Z') },
    });
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        await runStatementSync({ action: 'drain', db, owner, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), read: readStatement, open: async () => [{ password: 'p', bank: 'HNB' }], settle: settleStatement,
            board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment: async () => ({ bytes: textPdf(STATEMENT(rows).trim().split('\n')), filename: 'statement.pdf', contentSha256: 'x' }) });
    } finally { spy.mockRestore(); }
    return { user: data.get('users/u'), item: data.get(sourcePath), data, db, sourcePath };
}
const row = (day, text, dr, cr, bal) => `${day}/03/2026 ${day}/03/2026 ${text} ${dr || ''} ${cr || ''} ${bal}`.replace(/\s+/g, ' ');

describe('end to end: the Subscriptions tab gets the payment, once', () => {
    it('Anthropic with no entry: an entry is started with this month\'s amount, and nothing lands on Expenses', async () => {
        const { user, item } = await file({}, row('07', 'ANTHROPIC SAN FRANCISCO CA', '5,200.00', '', '494,800.00'));
        expect(item.status).toBe('filed');
        expect(user.expenses).toHaveLength(0);
        expect(user.subscriptions).toHaveLength(1);
        expect(user.subscriptions[0]).toMatchObject({ name: 'Anthropic (Claude)', category: 'Software', autoCreated: true, source: 'statement', monthOverrides: { '2026-03': 5200 } });
        expect(user.subscriptions[0].history).toHaveLength(1);
        expect(monthly(user).totalExp).toBe(5200);
    });
    it('Claude with an entry the owner named "Claude Pro": that entry gets the month, no second entry', async () => {
        const { user } = await file({ subscriptions: [{ id: 'C1', name: 'Claude Pro', amount: 5000, cycle: 'monthly', category: 'Software', createdAt: '2026-01-01T00:00:00Z' }] }, row('07', 'CLAUDE.AI SUBSCRIPTION', '5,200.00', '', '494,800.00'));
        expect(user.subscriptions).toHaveLength(1);
        expect(user.subscriptions[0]).toMatchObject({ id: 'C1', monthOverrides: { '2026-03': 5200 } });
        expect(user.expenses).toHaveLength(0);
    });
    it('a mobile number paid twice in a month: one entry for the number, the month holds the total, both payments are listed', async () => {
        const { user } = await file({}, [row('03', 'IB BILL PAYMENT 077 123 4567', '1,800.00', '', '498,200.00'), row('09', 'DIALOG RELOAD 0771234567', '500.00', '', '497,700.00')].join('\n'));
        expect(user.expenses).toHaveLength(0);
        expect(user.subscriptions).toHaveLength(1);
        expect(user.subscriptions[0].history.map(h => h.amount)).toEqual([1800, 500]);
        expect(user.subscriptions[0].monthOverrides['2026-03']).toBe(2300);
        expect(monthly(user).totalExp).toBe(2300);
    });
    it('a transfer to a person that carries a number stays an expense, and starts nothing', async () => {
        const { user } = await file({}, row('07', 'CEFT TRANSFER J SMITH 0771234567', '2,000.00', '', '498,000.00'));
        expect(user.subscriptions).toHaveLength(0);
        expect(user.expenses).toHaveLength(1);
    });
    it('unfiling the statement takes the entry it started away with it, and an entry the owner had stays', async () => {
        const owner = { id: 'C1', name: 'Netflix', amount: 1500, cycle: 'monthly', category: 'Streaming', createdAt: '2026-01-01T00:00:00Z' };
        const { user, sourcePath, db, data } = await file({ subscriptions: [owner] }, [row('07', 'ANTHROPIC SAN FRANCISCO CA', '5,200.00', '', '494,800.00'), row('08', 'NETFLIX.COM', '1,500.00', '', '493,300.00')].join('\n'), true);
        expect(user.subscriptions).toHaveLength(2);
        await unfileStatement({ db, uid: 'u', itemRef: db.doc(sourcePath) });
        const back = data.get('users/u');
        expect(back.subscriptions.map(s => s.id)).toEqual(['C1']);
        expect(back.subscriptions[0].history || []).toHaveLength(0);
        expect(back.subscriptions[0].monthOverrides || {}).toEqual({});
        expect(Object.keys(back._tomb.subscriptions)).toHaveLength(1);
    });
});
