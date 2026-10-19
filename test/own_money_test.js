/* =============================================================================
 * test/own_money_test.js — one rule for "whose money is this row?", asked by both doors
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-04: July's "Cash advance cr 376657******0276" — cash drawn on the owner's AMEX ••0276 arriving in the DFCC account — was filed as +LKR 100,000 Income · Other by the email
 * system, while the owner's manual upload "knows" the card. Reproduced: the email worker's own-account rule fired only on rows worded as a transfer, the manual upload's credit routing never asked
 * the Cards & Accounts registry (and filed the same row as Income · other too), and the worker told the AI board a BANK account was a credit card whenever the four digits of its number passed a Luhn check
 * (one account in ten).
 *
 * Both doors now ask wealthflow-own-money.js. The table below is read through the real worker (statement-sync deterministicDecision) AND the real page router (wealthflow-route.js +
 * wealthflow-merchants.js, loaded the way index.html loads them) and the two must agree.
 * ===========================================================================*/
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import OwnMoney, { ownMoney, numbersIn, leavesTheBooks, nameOfOwnerIn } from '../wealthflow-own-money.js';
import { deterministicDecision, classifySlice } from '../statement-sync.js';
import { validateSettlementRow, settleStatement } from '../statement-ledger.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const registry = {
    '0276': { type: 'credit_card', bank: 'AMEX', network: 'Amex', last4: '0276' },
    '1861': { type: 'bank_account', bank: 'HNB', last4: '1861' },
};

describe('the rule itself (wealthflow-own-money.js)', () => {
    const rule = (description, direction, extra = {}) => ownMoney({ description, direction, registry, ...extra });

    it('reads the number a narration masks: the BIN, the tail, the network the digits say', () => {
        expect(numbersIn('Cash advance cr 376657******0276')).toEqual([{ last4: '0276', bin: '376657', brand: 'amex', cardShaped: true }]);
        expect(numbersIn('Outward Ceft Transfer 376657Xxxxx0276')[0]).toMatchObject({ last4: '0276', cardShaped: true });
        expect(numbersIn('Ref 0276 paid 1861')).toEqual([]);                      // a bare four digits is an amount or a reference
        expect(numbersIn('A/C XXXXXX1861')[0]).toMatchObject({ last4: '1861', cardShaped: false });
    });

    it('cash drawn on the owner\'s registered card arriving in the account is not income', () => {
        expect(rule('Cash advance cr 376657******0276', 'credit')).toMatchObject({ kind: 'card-cash-advance-in', last4: '0276', evidence: 'registered-card' });
        expect(leavesTheBooks(rule('Cash advance cr 376657******0276', 'credit'))).toBe(true);
    });

    it('a cash advance is borrowed money even when the card is not registered, and says how sure it is', () => {
        expect(rule('Cash advance cr 411111******9999', 'credit')).toMatchObject({ kind: 'card-cash-advance-in', evidence: 'card-number' });
        expect(rule('Cash advance from MB', 'credit')).toMatchObject({ kind: 'card-cash-advance-in', evidence: 'words' });
    });

    it('money from the owner\'s own registered card, with no wording, is the owner\'s own money', () => {
        expect(rule('Inward Ceft Transfer 376657Xxxxx0276', 'credit')).toMatchObject({ kind: 'card-money-in', last4: '0276' });
    });

    it('a number the owner has not registered is not claimed without a reason, a registry entry that says BANK ACCOUNT is never a card, and the digits cannot contradict the registry', () => {
        expect(rule('Inward Ceft Transfer 411111******9999', 'credit')).toBeNull();
        expect(rule('Inward Ceft Transfer XXXXXX1861', 'credit')).toBeNull();
        expect(rule('Inward Ceft Transfer 411111******0276', 'credit')).toBeNull();      // a Visa BIN at the AMEX\'s tail
        expect(rule('Inward Ceft Transfer 411111******9999', 'credit', { tails: ['9999'] })).toMatchObject({ kind: 'card-money-in', evidence: 'known-tail' });   // on one of the owner's own statements
        expect(rule('Inward Ceft Transfer XXXXXX9999', 'credit', { tails: ['9999'] })).toBeNull();                                  // a bank-account-shaped number is not a card
    });

    it('a refund or a reversal reduces an expense that is already in the books, and a fee is a fee: neither is the owner\'s own money', () => {
        expect(rule('Cash advance reversal 376657******0276', 'credit')).toBeNull();
        expect(rule('Refund 376657******0276', 'credit')).toBeNull();
        expect(rule('Ceft Charges 376657Xxxxx0276', 'debit')).toBeNull();
        expect(rule('Cash advance fee 376657******0276', 'debit')).toBeNull();
    });

    it('a payment to the owner\'s own card is named, so the doors can file it as a card payment', () => {
        expect(rule('Outward Ceft Transfer 376657Xxxxx0276', 'debit')).toMatchObject({ kind: 'card-payment-out', last4: '0276' });
        expect(leavesTheBooks(rule('Outward Ceft Transfer 376657Xxxxx0276', 'debit'))).toBe(true);       // the card's own statement carries the payment: the bank's line is not filed a second time
    });

    it('says nothing about a card\'s own statement, a row of unknown direction, or a row that names no card', () => {
        expect(rule('Cash advance cr 376657******0276', 'credit', { isCard: true })).toBeNull();
        expect(rule('Cash advance cr 376657******0276', '')).toBeNull();
        expect(rule('Salary Credit', 'credit')).toBeNull();
        expect(rule('Outward Ceft Transfer Car', 'debit')).toBeNull();
    });

    it('is exposed on the page as window.WFOwnMoney, and index.html loads it', () => {
        expect(OwnMoney.ownMoney).toBe(ownMoney);
        expect(read('index.html')).toMatch(/<script type="module" src="wealthflow-own-money\.js"><\/script>/);
    });
});

describe('both doors read the same rows the same way', () => {
    let page;                                                                       // the page's router and merchant rules, loaded the way index.html loads them
    beforeAll(() => {
        const sandbox = { console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('no network in tests')) };
        sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
        sandbox.location = { hostname: 'localhost' };
        sandbox.document = { readyState: 'complete', addEventListener() {} };
        sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
        sandbox.WFOwnMoney = OwnMoney;                                               // the module script index.html loads
        sandbox.wfCardRegistry = { get: () => registry };                           // the owner's Cards & Accounts
        for (const file of ['wealthflow-merchants.js', 'wealthflow-route.js']) {
            new Function('window', 'globalThis', 'self', 'location', 'console', 'fetch', 'setTimeout', 'clearTimeout', 'document', 'localStorage', read(file))(
                sandbox, sandbox, sandbox, sandbox.location, sandbox.console, sandbox.fetch, setTimeout, clearTimeout, sandbox.document, sandbox.localStorage);
        }
        page = sandbox;
    });

    /* where the page files a row of a BANK statement: exactly what _routeAll in index.html does */
    const pageDest = (description, direction) => {
        const routed = page.WFRoute.routeTransaction({ description, amount: 1000, direction }, 'bank_account');
        let dest = routed.tab;
        const refined = page.WFMerchants.refine(description, direction, { tab: dest, category: routed.category, subName: routed.subName, subPhone: routed.subPhone, ownMoney: routed.ownMoney });
        if (refined) dest = refined.tab;
        return dest;
    };
    const allocations = (extra = {}) => {
        const a = { statementType: 'bank_account', card_last4: '', bank: 'DFCC Bank', cardRegistry: registry, ...extra };
        Object.defineProperty(a, 'own', { value: new Set(['0276', '1861']), enumerable: false });
        return a;
    };
    const workerModule = (description, direction) => deterministicDecision({ narration: description, description, direction, amount: 1000, date: '2026-07-10', directionSource: 'balance', needsReview: false }, allocations());

    it.each([
        ['Cash advance cr 376657******0276', 'credit'],
        ['Inward Ceft Transfer 376657Xxxxx0276', 'credit'],
        ['Cash advance cr 411111******9999', 'credit'],
        ['Cash advance from MB', 'credit'],
    ])('%s (%s): left out of the income by both', (description, direction) => {
        expect(pageDest(description, direction)).toBe('skip');
        expect(workerModule(description, direction)).toMatchObject({ module: 'skip', verified: true });
    });

    it.each([
        ['Cash advance reversal 376657******0276', 'credit'],
        ['Inward Ceft Transfer Dip Refund', 'credit'],
        ['Salary Credit', 'credit'],
        ['Welcome Offer MemberCash Saving', 'credit'],
    ])('%s (%s): still money in, filed as income by both', (description, direction) => {
        expect(pageDest(description, direction)).toBe('income');
        expect(workerModule(description, direction)).toMatchObject({ module: 'incomeRecv' });
    });

    it('a bank charge that carries the card\'s number is a bank charge, in both', () => {
        expect(page.WFRoute.routeTransaction({ description: 'Ceft Charges 376657Xxxxx0276', amount: 25, direction: 'debit' }, 'bank_account')).toMatchObject({ tab: 'expenses', category: 'Bank Charges' });
        expect(workerModule('Ceft Charges 376657Xxxxx0276', 'debit')).toMatchObject({ module: 'expenses', category: 'Bank Charges' });
    });

    it('a payment to the owner\'s own card is left to the card\'s own statement by both (the page used to file it as a second Card Payment)', () => {
        expect(pageDest('Outward Ceft Transfer 376657Xxxxx0276', 'debit')).toBe('skip');
        expect(workerModule('Outward Ceft Transfer 376657Xxxxx0276', 'debit')).toMatchObject({ module: 'skip', ownTransfer: expect.any(String) });
        const routed = page.WFRoute.routeTransaction({ description: 'Outward Ceft Transfer 376657Xxxxx0276', amount: 30000, direction: 'debit' }, 'bank_account');
        expect(routed).toMatchObject({ tab: 'skip', ownMoney: 'card-payment-out', ccLast4: '0276' });
        // the owner can still choose Card Payment in the review list: the row names the card it is filed against
        expect(routed.reason).toMatch(/Card Payment/);
    });

    it('a number that is no card of the owner\'s is not "the owner\'s own card": the rule leaves it alone (the page still reads a card-shaped number as a card bill, the worker as money paid out)', () => {
        expect(pageDest('Outward Ceft Transfer 411111Xxxxx9999', 'debit')).toBe('cc_payment');
        expect(workerModule('Outward Ceft Transfer 411111Xxxxx9999', 'debit')).toMatchObject({ module: 'expenses', autoDecided: 'transfer-to-others' });
    });

    describe('a transfer that names the owner (the family name, or the house name made from it)', () => {
        const NAME = 'CEFTS/6454/KULASOORIYAGE S/Transfer';
        const names = new Set(['kulasooriya']), initials = new Set(['k', 's', 'g']), local = 'gaurawasachintha';
        it('the rule reads "-ge" as the family\'s word, whole words only, and never a fee or a refund', () => {
            expect(ownMoney({ description: NAME, direction: 'credit', names, initials, local })).toMatchObject({ kind: 'own-name-transfer', evidence: 'own-name' });
            expect(ownMoney({ description: 'Transfer Credit-Mobilebanking Gaurawa', direction: 'credit', names, initials, local })).toMatchObject({ kind: 'own-name-transfer' });
            expect(ownMoney({ description: 'Outward Ceft Transfer Kulasooriya', direction: 'debit', names, initials, local })).toMatchObject({ kind: 'own-name-transfer' });
            expect(ownMoney({ description: NAME, direction: 'credit' })).toBeNull();                                   // no name known, nothing matched
            expect(ownMoney({ description: 'CEFTS/6454/PERERAGE S/Transfer', direction: 'credit', names, initials, local })).toBeNull();
            expect(ownMoney({ description: 'Transfer Kulasooriyage fee', direction: 'debit', names, initials, local })).toBeNull();
            expect(ownMoney({ description: 'Transfer refund Kulasooriya', direction: 'credit', names, initials, local })).toBeNull();
            expect(ownMoney({ description: 'POS Kulasooriya Stores', direction: 'debit', names, initials, local })).toBeNull();     // not worded as a transfer
            expect(ownMoney({ description: NAME, direction: 'credit', names, initials, local, isCard: true })).toBeNull();     // a card statement's own line
            expect(nameOfOwnerIn('Kulasooriyage S', { names, initials })).toBe('kulasooriyage');
            expect(nameOfOwnerIn('Gamage S', { names, initials })).toBe('');
            // a family has more than one member: the house name alone, or another member's initial, is not the owner
            expect(nameOfOwnerIn('Kulasooriyage S', { names })).toBe('');
            expect(nameOfOwnerIn('CEFTS/6454/KULASOORIYAGE P/Transfer', { names, initials })).toBe('');
            expect(nameOfOwnerIn('CEFTS/6454/KULASOORIYAGE SUNIL/Transfer', { names, initials })).toBe('');
            expect(nameOfOwnerIn('Transfer to Kulasooriya', { names })).toBe('kulasooriya');                     // the family name itself keeps the bar it always had
        });
        it('the worker skips it, with the owner\'s name read from the statement\'s client name', () => {
            const a = allocations({ ownerWords: { names, initials, local } });
            expect(deterministicDecision({ narration: NAME, description: NAME, direction: 'credit', amount: 9000, date: '2026-07-11', directionSource: 'balance', needsReview: false }, a)).toMatchObject({ module: 'skip', ownTransfer: 'own-name' });
            expect(deterministicDecision({ narration: NAME, description: NAME, direction: 'credit', amount: 9000, date: '2026-07-11', directionSource: 'balance', needsReview: false }, allocations())).toMatchObject({ module: 'incomeRecv' });
        });
        it('the page skips it the same way, naming the owner from the accounts they saved and the address they signed in with', () => {
            const saved = { DB: page.DB, currentUser: page.currentUser };
            try {
                page.DB = { get: (key) => (key === 'payAccounts' ? [{ holder: 'K S G Kulasooriya', bank: 'DFCC' }] : []) };
                page.currentUser = { email: 'gaurawasachintha@gmail.com' };
                expect(pageDest(NAME, 'credit')).toBe('skip');
                expect(page.WFRoute.routeTransaction({ description: NAME, amount: 9000, direction: 'credit' }, 'bank_account')).toMatchObject({ tab: 'skip', ownMoney: 'own-name-transfer' });
                expect(pageDest('CEFTS/6454/PERERAGE S/Transfer', 'credit')).toBe('income');
                page.DB = undefined; page.currentUser = undefined;                                                       // nothing known about the owner: routed as it always was
                expect(pageDest(NAME, 'credit')).toBe('income');
            } finally { page.DB = saved.DB; page.currentUser = saved.currentUser; }
        });
    });

    it('without the module loaded the page routes a row as it always did (nothing is lost, nothing is invented)', () => {
        const saved = page.WFOwnMoney;
        try {
            page.WFOwnMoney = undefined;
            expect(page.WFRoute.routeTransaction({ description: 'Cash advance cr 376657******0276', amount: 1, direction: 'credit' }, 'bank_account')).toMatchObject({ tab: 'income' });
        } finally { page.WFOwnMoney = saved; }
    });

    it('the review list keeps the rule\'s answer: refine is told the row is the owner\'s own money, and a row switched to Card Payment is filed on the card it names', () => {
        const html = read('index.html');
        expect(html).toMatch(/refine\(t\.description, t\.direction, \{[^}]*ownMoney: t\._ownMoney \}\)/);
        expect(html).toMatch(/t\._ownCard = routed\.ccLast4 \|\| ''/);
        expect(html).toMatch(/card_last4: _payT\._ccLast4 \|\| _payT\._ownCard \|\| _source\.card_last4/);
    });

    it('the AI auto-sort hands the queue each row\'s real direction (it used to hand every credit over as a debit)', () => {
        const html = read('index.html');
        expect(html).toMatch(/picked\.push\(\{ date, description: desc, amount, type: t\.direction === 'credit' \? 'credit' : 'debit' \}\)/);
    });
});

describe('an account is a credit card because the owner and the statement say so, never because of its digits', () => {
    /* 0018 passes a Luhn check; so does one four-digit number in ten. It was enough to make a BANK account a credit card for the worker */
    const bank = (extra = {}) => ({ statementType: 'bank_account', card_last4: '0018', bank: 'DFCC Bank', cardRegistry: {}, ...extra });
    const row = (description, direction) => ({ narration: description, description, direction, amount: 1500, date: '2026-07-10', directionSource: 'balance', needsReview: false });

    it('a bank account whose last four digits pass a Luhn check still files money paid to other people as spending, and a subscription-like row as an expense', () => {
        expect(deterministicDecision(row('Outward Ceft Transfer Car', 'debit'), bank())).toMatchObject({ module: 'expenses', autoDecided: 'transfer-to-others' });
        expect(deterministicDecision(row('Netflix', 'debit'), bank())).toMatchObject({ module: 'expenses' });
    });

    it('the board is told the truth about the account', async () => {
        const prompts = [];
        const board = async (prompt) => { prompts.push(prompt); throw new Error('stop'); };
        await classifySlice([row('ZZQ TRADING 4412', 'debit')], bank(), { board });
        expect(prompts[0]).toContain('[BANK_OR_DEBIT_ACCOUNT]');
        expect(prompts[0]).not.toContain('[CREDIT_CARD_ACCOUNT]');
    });
});

describe('the ledger leaves such a row out instead of putting it in front of the owner', () => {
    const credit = { date: '2026-07-10', amount: 100000, description: 'Cash advance cr 376657******0276', direction: 'credit', directionSource: 'balance', needsReview: false };
    const skip = { module: 'skip', category: 'Transfer', verified: true, deterministic: true };

    it('a skip needs evidence: a transfer\'s wording, or the owner\'s own card in the row — nothing else is left out', () => {
        const ctx = { statementType: 'bank_account', cardRegistry: registry };
        expect(validateSettlementRow(credit, skip, ctx)).toBeNull();
        expect(validateSettlementRow({ ...credit, description: 'Salary Credit' }, skip, ctx)).toBe('skip-requires-transfer-evidence');
        expect(validateSettlementRow({ ...credit, description: 'Cash advance cr 376657******0276', direction: 'credit' }, skip, { statementType: 'credit_card', cardRegistry: registry })).toBe('skip-requires-transfer-evidence');
    });

    it('a statement that carries it is filed without a review and without an income record', async () => {
        const docs = new Map([['users/u', { incomeRecv: [], expenses: [], settings: { cardRegistry: registry } }], ['sources/s', { uid: 'u', cursor: 0, leaseToken: 'token', leaseUntil: 2000 }]]);
        const collection = (p) => ({ doc: (id) => ref(`${p}/${id}`), where: (field, op, value) => ({ query: true, path: p, field, value }) });
        const ref = (p) => ({ path: p, id: p.split('/').at(-1), collection: (name) => collection(`${p}/${name}`) });
        const db = {
            collection, doc: ref,
            async runTransaction(fn) {
                const pending = [];
                const result = await fn({
                    async get(r) { if (r.query) return { docs: [] }; return { exists: docs.has(r.path), data: () => structuredClone(docs.get(r.path)) }; },
                    set(r, value, opts) { pending.push([r.path, structuredClone(value), opts]); },
                });
                for (const [p, value, opts] of pending) docs.set(p, opts?.merge ? { ...docs.get(p), ...value } : value);
                return result;
            },
        };
        const rows = [credit, { ...credit, description: 'Salary Credit', amount: 150000 }];
        const decisions = rows.map((r) => deterministicDecision({ ...r, narration: r.description }, { statementType: 'bank_account', card_last4: '', bank: 'DFCC Bank', cardRegistry: registry }));
        const out = await settleStatement({ db, uid: 'u', sourceRef: ref('sources/s'), leaseToken: 'token', now: 1000, rows, decisions, cursor: 0, totalRows: 2, bank: 'DFCC Bank', last4: '', statementType: 'bank_account', cardRegistry: registry });
        expect(out).toMatchObject({ filed: 1, skipped: 1, review: 0 });
        expect(docs.get('users/u').incomeRecv.map((r) => r.name)).toEqual(['Salary Credit']);
        expect([...docs.keys()].some((p) => p.includes('/statementReview/'))).toBe(false);
    });
});

describe('the email system, end to end, on the owner\'s July statement', () => {
    const owner = { uid: 'u', email: 'owner@example.com' }, mail = 'wf-mail/owner_example_com', itemPath = `${mail}/items/item0`;
    const line = (narration, extra = {}) => ({ date: '2026-07-10', narration, amount: 1000, direction: 'credit', directionSource: 'balance', needsReview: false, valid: true, ...extra });
    const rows = [
        line('Monthly MemberCash savings', { date: '2026-07-02', amount: 1181 }),
        line('Cash advance cr 376657******0276', { date: '2026-07-09', amount: 100000 }),
        line('CEFTS/6454/KULASOORIYAGE S/Transfer', { date: '2026-07-11', amount: 9000 }),
        line('Pos Transaction Koko C', { date: '2026-07-16', amount: 3904.67, direction: 'debit' }),
        line('Ceft Charges 376657Xxxxx0276', { date: '2026-07-16', amount: 25, direction: 'debit' }),
    ];
    const parsed = { rows, verdict: 'parsed', understood: true, reason: '', invalidDates: 0, balanceMismatches: 0, layout: { statementType: 'bank_account', accountLast4: '5555' },
        reconciliation: { opening: 0, closing: 0, credits: 110181, debits: 3929.67, expected: 0, difference: 0, ok: true } };
    const world = async (cardRegistry, extraUser = {}) => {
        const { createFirestore } = await import('./helpers/fake-firestore.js');
        const { runStatementSync } = await import('../statement-sync.js');
        const w = createFirestore({
            [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, lastSettleMs: 0, senders: [{ id: 'statements@dfccbank.com', kind: 'address', status: 'approved', name: 'DFCC', domain: 'dfccbank.com' }] },
            'wf-statement-vault/u': { uid: 'u' },
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: { cardRegistry }, ...extraUser },
            [itemPath]: { uid: 'u', bank: 'DFCC', filename: 'DFCC_Statement_202607.html', from: 'statements@dfccbank.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
        });
        const out = await runStatementSync({ action: 'drain', db: w.db, owner, env: {}, intake: async () => ({ body: { ok: true } }), open: async () => [], maxSteps: 1, budgetMs: 40000, settle: settleStatement,
            f: async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) }),
            board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); },
            loadAttachment: async () => ({ bytes: Buffer.from('%PDF-1.4 statement'), filename: 'DFCC_Statement_202607.html', contentSha256: 'x' }),
            read: async () => ({ text: 'DFCC BANK PLC Statement', parsed: JSON.parse(JSON.stringify(parsed)) }) });
        return { w, out };
    };
    const ledger = (w) => [...w.data.entries()].filter(([key]) => key.includes('/statementLedger/')).map(([, value]) => value);

    it('the cash advance is left out of the income, the rest of the month is filed, nothing is asked of the owner', async () => {
        const { w, out } = await world({ '0276': { type: 'credit_card', bank: 'AMEX', network: 'Amex', last4: '0276' } });
        expect(out.status).toBe('filed');
        const books = w.data.get('users/u');
        expect(books.incomeRecv.map((r) => r.name).sort()).toEqual(['CEFTS/6454/KULASOORIYAGE S/Transfer', 'Monthly MemberCash savings']);
        expect(books.incomeRecv.some((r) => r.amount === 100000)).toBe(false);
        expect(books.expenses.map((r) => r.desc).sort()).toEqual(['Ceft Charges 376657Xxxxx0276', 'Pos Transaction Koko C']);
        expect(ledger(w).filter((e) => e.status === 'skipped')).toHaveLength(1);
        expect(ledger(w).filter((e) => e.status === 'review')).toHaveLength(0);
        expect([...w.data.keys()].some((key) => key.includes('/statementReview/'))).toBe(false);
    });

    it('the transfer from an account in the owner\'s own name is left out too once the owner\'s saved accounts say whose name that is', async () => {
        const { w, out } = await world({ '0276': { type: 'credit_card', bank: 'AMEX', network: 'Amex', last4: '0276' } }, { payAccounts: [{ holder: 'K S G Kulasooriya', bank: 'DFCC', number: '1234567890' }] });
        expect(out.status).toBe('filed');
        expect(w.data.get('users/u').incomeRecv.map((r) => r.name)).toEqual(['Monthly MemberCash savings']);
        expect(ledger(w).filter((e) => e.status === 'skipped')).toHaveLength(2);
        expect(ledger(w).filter((e) => e.status === 'review')).toHaveLength(0);
    });

    it('with no card registered at all, a "cash advance" credit is still not income (only the account holder can draw cash into their own account)', async () => {
        const { w } = await world({});
        expect(w.data.get('users/u').incomeRecv.some((r) => r.amount === 100000)).toBe(false);
        expect(ledger(w).filter((e) => e.status === 'skipped')).toHaveLength(1);
    });
});
