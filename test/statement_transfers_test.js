import { describe, expect, it } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { tailsIn, ownTails, ownTransferEvidence, pairedTransfers, recordTwins } from '../statement-transfers.mjs';
import { runStatementSync, reopenSkippedTransfers, removeOwnTransferRecords, TRANSFER_REOPEN_VERSION, OWN_TRANSFER_VERSION } from '../statement-sync.js';
import { settleStatement, sourceOccurrenceId, lostFiledRows } from '../statement-ledger.mjs';

// DFCC, production 2026-10-02: every row worded as a transfer was left out of the books as "a transfer between your own accounts" — 87 rows. "Outward Ceft Transfer Car / Chagiya / Sister / Title / Heaven
// View" and "Inward Ceft Transfer Dip Refund / Loan / Order" are money paid to and received from other people: spending and income. Only the owner's own money between the owner's own accounts is left out.

const r = (narration, extra = {}) => ({ date: '2026-08-14', narration, amount: 50000, direction: 'debit', directionSource: 'balance', needsReview: false, valid: true, ...extra });

describe('a masked account number is read, and a bare number is not', () => {
    it('finds the tail of a masked card or account number in every shape banks print', () => {
        expect(tailsIn('Outward Ceft Transfer 376657XXXXX0276')).toEqual(['0276']);
        expect(tailsIn('To a/c XXXX1573')).toEqual(['1573']);
        expect(tailsIn('ATM ****4455 COLOMBO')).toEqual(['4455']);
        expect(tailsIn('Fund transfer xxxxxxxx0099')).toEqual(['0099']);
    });
    it('does not take an amount, a reference or a date for an account', () => {
        expect(tailsIn('Outward Ceft Transfer Car 50,000.00')).toEqual([]);
        expect(tailsIn('REF 20260814 0276')).toEqual([]);
        expect(tailsIn('')).toEqual([]);
    });
    it('the owner\'s own tails are the cards they track, the accounts their statements are for and this statement\'s own', () => {
        const tails = ownTails({ cardRegistry: { '0276': { bank: 'AMEX' }, 'x': {} }, cards: [{ card_last4: '4455' }, {}], statementTails: ['1573', '', null, '0000'], thisTail: '9988' });
        expect([...tails].sort()).toEqual(['0276', '1573', '4455', '9988']);
        expect(ownTails().size).toBe(0);
    });
});

describe('a transfer is the owner\'s own only when something on the page says so', () => {
    const own = { tails: new Set(['0276']) };
    it('their own account number', () => {
        expect(ownTransferEvidence(r('Outward Ceft Transfer 376657XXXXX0276'), own)).toBe('own-account-number');
        expect(ownTransferEvidence(r('Outward Ceft Transfer 376657XXXXX9999'), own)).toBe('');
    });
    it('their own words', () => {
        for (const text of ['Transfer Credit-Mobilebanking My Dfcc', 'Transfer to own account', 'SELF TRANSFER', 'Transfer to my savings', 'Savings A/C transfer from current', 'Online transfer to my HNB'])
            expect(ownTransferEvidence(r(text), own), text).toBe('own-account-words');
    });
    it('the other leg on the same statement', () => {
        const row = r('Outward Ceft Transfer'), paired = new WeakSet([row]);
        expect(ownTransferEvidence(row, { paired })).toBe('other-leg-on-the-statement');
        expect(ownTransferEvidence(r('Outward Ceft Transfer'), { paired })).toBe('');
    });
    it('and money to or from someone else is none of those', () => {
        for (const text of ['Outward Ceft Transfer Car', 'Outward Ceft Transfer Chagiya', 'Outward Ceft Transfer Sister', 'Inward Ceft Transfer Dip Refund', 'Inward Ceft Transfer Order', 'Transfer Credit-Mobilebanking'])
            expect(ownTransferEvidence(r(text), own), text).toBe('');
    });
    it('a row that is not worded as a transfer is not a transfer', () => {
        expect(ownTransferEvidence(r('POS Transaction KEELLS 0276'), own)).toBe('');
    });
});

describe('the two legs of one transfer between two of the owner\'s accounts', () => {
    const leg = (narration, direction, account, extra = {}) => r(narration, { direction, card_last4: account, ...extra });
    it('a debit in one account and a credit of the same amount in another, within three days, are one transfer', () => {
        const out = leg('Transfer', 'debit', '1111'), into = leg('Transfer Credit', 'credit', '2222', { date: '2026-08-16' });
        const paired = pairedTransfers([out, r('POS KEELLS', { amount: 4000 }), into]);
        expect(paired.has(out) && paired.has(into)).toBe(true);
    });
    it('not when they are the same account, a different amount, further apart, or neither says transfer', () => {
        const same = [leg('Transfer', 'debit', '1111'), leg('Transfer Credit', 'credit', '1111')];
        const other = [leg('Transfer', 'debit', '1111'), leg('Transfer Credit', 'credit', '2222', { amount: 49999.99 })];
        const far = [leg('Transfer', 'debit', '1111'), leg('Transfer Credit', 'credit', '2222', { date: '2026-08-20' })];
        const none = [leg('POS KEELLS', 'debit', '1111'), leg('REFUND KEELLS', 'credit', '2222')];
        for (const rows of [same, other, far, none]) expect(rows.some(row => pairedTransfers(rows).has(row))).toBe(false);
    });
    it('a row with no account, or a statement of one account, has no other leg to find', () => {
        const rows = [r('Outward Ceft Transfer'), r('Inward Ceft Transfer', { direction: 'credit' })];
        expect(rows.some(row => pairedTransfers(rows).has(row))).toBe(false);
        expect(pairedTransfers(null).has({})).toBe(false);
    });
    it('each row belongs to one pair only', () => {
        const a = leg('Transfer', 'debit', '1111'), b = leg('Transfer', 'credit', '2222'), c = leg('Transfer', 'credit', '3333');
        const paired = pairedTransfers([a, b, c]);
        expect([a, b, c].filter(row => paired.has(row))).toHaveLength(2);
    });
});

describe('the transfers that were left out are decided again, once, and nothing is filed twice', () => {
    const owner = { uid: 'u', email: 'owner@example.com' }, mail = 'wf-mail/owner_example_com', itemPath = `${mail}/items/item0`;
    const rows = [
        r('POS Transaction KEELLS', { date: '2026-08-04', amount: 4000 }),
        r('Outward Ceft Transfer Sister', { date: '2026-08-10', amount: 25000 }),
        r('Inward Ceft Transfer Dip Refund', { date: '2026-08-11', amount: 1500, direction: 'credit' }),
        r('Outward Ceft Transfer 376657XXXXX0276', { date: '2026-08-14', amount: 50000 }),
        r('Transfer Credit-Mobilebanking My Dfcc', { date: '2026-08-15', amount: 700, direction: 'credit' }),
    ];
    const parsed = { rows, verdict: 'parsed', understood: true, reason: '', invalidDates: 0, balanceMismatches: 0, layout: { statementType: 'bank_account', accountLast4: '5555' },
        reconciliation: { opening: 0, closing: 0, credits: 2200, debits: 79000, expected: 0, difference: 0, ok: true } };
    const world = () => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, lastSettleMs: 0, senders: [{ id: 'statements@dfccbank.com', kind: 'address', status: 'approved', name: 'DFCC', domain: 'dfccbank.com' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: { cardRegistry: { '0276': { bank: 'AMEX' } } } },
        [itemPath]: { uid: 'u', bank: 'DFCC', filename: 'DFCC_Statement_202608.html', from: 'statements@dfccbank.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
    });
    const run = (w, action = 'drain') => runStatementSync({ action, db: w.db, owner, env: {}, intake: async () => ({ body: { ok: true } }), open: async () => [], maxSteps: 1, budgetMs: 40000, settle: settleStatement,
        f: async url => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) }),
        board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); },
        loadAttachment: async () => ({ bytes: Buffer.from('%PDF-1.4 statement'), filename: 'DFCC_Statement_202608.html', contentSha256: 'x' }),
        read: async () => ({ text: 'DFCC BANK PLC Statement', parsed: JSON.parse(JSON.stringify(parsed)) }) });
    const amounts = (w, key) => w.data.get('users/u')[key].map(e => e.amount).sort((a, b) => a - b);
    const ledger = w => [...w.data.entries()].filter(([key]) => key.includes('/statementLedger/')).map(([key, value]) => ({ id: key.split('/').pop(), ...value }));

    // a statement filed before the rule changed carries no record of having been read under it
    const asOldRule = w => { const { transferRule, transferReopen, ...rest } = w.data.get(itemPath); w.data.set(itemPath, rest); };
    it('a new statement files money to and from others, and leaves out only the owner\'s own card and own words', async () => {
        const w = world();
        const out = await run(w);
        expect(out.status).toBe('filed');
        expect(amounts(w, 'expenses')).toEqual([4000, 25000]);
        expect(amounts(w, 'incomeRecv')).toEqual([1500]);
        expect(ledger(w).filter(e => e.status === 'skipped')).toHaveLength(2);
        expect(w.data.get('users/u').expenses.find(e => e.amount === 25000)).toMatchObject({ cat: 'Other', direction: 'debit' });
    });

    it('a statement filed under the old rule has its skipped transfers decided again: the others\' are filed, the owner\'s own stay out, and what was filed is not filed twice', async () => {
        const w = world();
        await run(w);
        // as the books stood under the old rule: every transfer row skipped, nothing of them filed
        asOldRule(w);
        const user = w.data.get('users/u');
        w.data.set('users/u', { ...user, expenses: user.expenses.filter(e => e.amount === 4000), incomeRecv: [] });
        for (const entry of ledger(w)) if ([1, 2, 3, 4].includes(entry.index)) w.data.set(`users/u/statementLedger/${entry.id}`, { ...entry, id: undefined, status: 'skipped', module: 'skip', reason: '' });
        const before = ledger(w).filter(e => e.status === 'filed').length;
        const result = await reopenSkippedTransfers({ db: w.db, uid: 'u' });
        expect(result).toEqual({ requeued: 1, rows: 4, more: false });
        expect(w.data.get(itemPath)).toMatchObject({ status: 'pending', filed: false, cursor: 0, transferReopen: { v: TRANSFER_REOPEN_VERSION, rows: 4 } });
        const out = await run(w);
        expect(out.status).toBe('filed');
        expect(amounts(w, 'expenses')).toEqual([4000, 25000]);                 // the 4,000 was not filed a second time
        expect(amounts(w, 'incomeRecv')).toEqual([1500]);
        expect(before).toBe(1);
        expect(ledger(w).filter(e => e.status === 'skipped').map(e => e.index).sort()).toEqual([3, 4]);       // the owner's own card and own words stay out
        expect(w.data.get(itemPath)).toMatchObject({ status: 'filed', filed: true });
    });

    it('is done once per version for a statement, leaves one being read alone, and a mailbox with nothing left is marked done', async () => {
        const w = world();
        await run(w);
        asOldRule(w);
        for (const entry of ledger(w)) if (entry.index === 1) w.data.set(`users/u/statementLedger/${entry.id}`, { ...entry, status: 'skipped', module: 'skip' });
        expect(await reopenSkippedTransfers({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 1 });
        // being read now: not touched again
        for (const entry of ledger(w)) if (entry.index === 1) w.data.set(`users/u/statementLedger/${entry.id}`, { ...entry, status: 'skipped', module: 'skip' });
        expect(await reopenSkippedTransfers({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 0 });
        await run(w);
        for (const entry of ledger(w)) if (entry.index === 1) w.data.set(`users/u/statementLedger/${entry.id}`, { ...entry, status: 'skipped', module: 'skip' });
        expect(await reopenSkippedTransfers({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 0, rows: 0 });        // already decided again under this version
    });

    it('the settle pass does it by itself and then marks the mailbox, so it is not looked for again', async () => {
        const w = world();
        await run(w);
        asOldRule(w);
        for (const entry of ledger(w)) if ([1, 2].includes(entry.index)) w.data.set(`users/u/statementLedger/${entry.id}`, { ...entry, status: 'skipped', module: 'skip' });
        // the first run found nothing left to decide again and marked the mailbox; a mailbox that still holds such rows is not marked
        expect(w.data.get(mail).transferReopenV).toBe(TRANSFER_REOPEN_VERSION);
        w.data.set(mail, { ...w.data.get(mail), lastSettleMs: 0, transferReopenV: 0 });
        await run(w, 'collect');
        expect(w.data.get(itemPath).transferReopen).toMatchObject({ v: TRANSFER_REOPEN_VERSION });
        for (let i = 0; i < 4; i++) { w.data.set(mail, { ...w.data.get(mail), lastSettleMs: 0 }); await run(w); }
        expect(w.data.get(mail).transferReopenV).toBe(TRANSFER_REOPEN_VERSION);
        expect(amounts(w, 'expenses')).toEqual([4000, 25000]);
        expect(amounts(w, 'incomeRecv')).toEqual([1500]);
    });

    it('a ledger entry of another kind of skip, or of another owner, is never reopened', async () => {
        const w = world();
        await run(w);
        asOldRule(w);
        w.data.set('users/u/statementLedger/other', { uid: 'someone-else', sourcePath: itemPath, index: 1, status: 'skipped', module: 'skip' });
        w.data.set('users/u/statementLedger/blank', { uid: 'u', sourcePath: itemPath, index: 2, status: 'skipped', module: '', reason: 'zero-amount' });
        // the statement's two own-account rows are skipped under today's rule; only a statement read before it is looked at
        expect(await reopenSkippedTransfers({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 1, rows: 2 });
        const fresh = world();
        await run(fresh);
        expect(await reopenSkippedTransfers({ db: fresh.db, uid: 'u' })).toMatchObject({ requeued: 0, rows: 0 });      // read under today's rule already
        expect(sourceOccurrenceId(itemPath, 1)).toMatch(/^[a-f0-9]{64}$/);
    });
});

describe('what the books hold twice is counted, in numbers only', () => {
    const rec = (extra = {}) => ({ id: Math.random().toString(36).slice(2), date: '2026-08-14', amount: 50000, desc: 'Outward Ceft Transfer Sister', cat: 'Other', statementKey: 'wf-mail/m/items/a', bank: 'Dfccbank', ...extra });
    it('one transaction filed from two copies of a statement is a twin; one statement\'s own repeated rows are not', () => {
        const twins = recordTwins({ expenses: [rec(), rec({ statementKey: 'wf-mail/m/items/b', bank: 'DFCC Bank' }), rec({ amount: 70, desc: 'POS BUS FARE' }), rec({ amount: 70, desc: 'POS BUS FARE' })] });
        expect(twins.sameRow).toEqual({ groups: 1, banks: { 'DFCC Bank/Dfccbank': 1 }, pairs: { '?|?': 1 } });
        // and which two statements share it, by the label the caller gives each
        const labelled = recordTwins({ expenses: [rec(), rec({ statementKey: 'wf-mail/m/items/b' })] }, { labelOf: key => (key.endsWith('/a') ? '2026-03:5187' : '2026-03:5187') });
        expect(labelled.sameRow.pairs).toEqual({ '2026-03:5187|2026-03:5187': 1 });
        expect(twins.records).toBe(4);
    });
    it('a debit in one statement and a credit of the same amount in another, one worded as a transfer, are the two legs of one transfer', () => {
        const twins = recordTwins({
            expenses: [rec({ amount: 3650000, desc: 'Outward Ceft Transfer', bank: 'Dfccbank' }), rec({ amount: 12, desc: 'POS KEELLS' })],
            incomeRecv: [rec({ amount: 3650000, name: 'Inward Ceft Transfer', desc: undefined, date: '2026-08-15', statementKey: 'wf-mail/m/items/c', bank: 'NTB' })],
        });
        expect(twins.legs).toEqual({ pairs: 1, banks: { 'Dfccbank>NTB': 1 } });
    });
    it('no pair when neither is worded as a transfer, or both are in one statement, and rows with no statement are ignored', () => {
        expect(recordTwins({ expenses: [rec({ desc: 'POS KEELLS' })], incomeRecv: [rec({ name: 'REFUND', desc: undefined, statementKey: 'wf-mail/m/items/c' })] }).legs.pairs).toBe(0);
        expect(recordTwins({ expenses: [rec()], incomeRecv: [rec({ name: 'Inward Ceft Transfer', desc: undefined })] }).legs.pairs).toBe(0);
        expect(recordTwins({ expenses: [{ amount: 5, date: '2026-01-01', desc: 'x' }] }).records).toBe(0);
        expect(recordTwins(null)).toEqual({ records: 0, sameRow: { groups: 0, banks: {}, pairs: {} }, legs: { pairs: 0, banks: {} } });
    });
    it('carries no amount and no description (it is written to a log)', () => {
        const twins = JSON.stringify(recordTwins({ expenses: [rec(), rec({ statementKey: 'wf-mail/m/items/b' })] }));
        expect(twins).not.toMatch(/50000|Sister|Ceft/);
    });
});

describe('the owner\'s own money already filed as spending or income is taken out, once, without a trace to heal', () => {
    const mail = 'wf-mail/owner_example_com', stmt = `${mail}/items/s1`;
    const rec = (id, extra = {}) => ({ id, source: 'statement', statementKey: stmt, date: '2026-08-10', amount: 150000, direction: 'debit', bank: 'DFCC Bank', desc: 'Outward Ceft Transfer 376657Xxxxx0276', cat: 'Other', ...extra });
    const world = (user = {}, items = {}) => createFirestore({
        [mail]: { uid: 'u', email: 'owner@example.com', autonomous: true },
        [`${mail}/items/amex1`]: { status: 'filed', bank: 'AMEX', filename: 'eStatement_376657XXXXX0276_2026AUG_265604.html', proof: { last4: '9999' }, ...items },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], settings: {}, ...user },
    });
    const mailRef = db => db.collection('wf-mail').doc('owner_example_com');
    it('a transfer naming the number in the file name of the owner\'s own card statement is the owner paying their own card', async () => {
        const w = world({ expenses: [rec('r1')] });
        const out = await removeOwnTransferRecords({ db: w.db, mailRef: mailRef(w.db), uid: 'u' });
        expect(out).toEqual({ removed: 1, more: false });
        expect(w.data.get('users/u').expenses).toEqual([]);
        expect(w.data.get('users/u')._tomb.expenses.r1).toBeGreaterThan(0);
    });
    it('leaves a transfer to someone else, a record the owner typed, a record whose category the owner changed, and what is not a transfer', async () => {
        const keep = [rec('a', { desc: 'Outward Ceft Transfer Car', amount: 126000 }), rec('b', { source: 'manual' }), rec('c', { cat: 'Savings' }), rec('d', { desc: 'POS Transaction KEELLS 0276' }), rec('e', { statementKey: '' })];
        const w = world({ expenses: keep });
        expect(await removeOwnTransferRecords({ db: w.db, mailRef: mailRef(w.db), uid: 'u' })).toEqual({ removed: 0, more: false });
        expect(w.data.get('users/u').expenses.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
    it('takes income too (the owner\'s own words), says why in the ledger, and the heal does not bring it back', async () => {
        const w = world({ incomeRecv: [{ id: 'i1', source: 'statement', statementKey: stmt, date: '2026-08-13', amount: 100000, direction: 'credit', bank: 'DFCC Bank', name: 'Transfer Credit-Mobilebanking My Dfcc', type: 'Other' }] });
        w.data.set('users/u/statementLedger/i1', { uid: 'u', sourcePath: stmt, index: 7, status: 'filed', module: 'incomeRecv', fingerprint: 'f' });
        expect(await removeOwnTransferRecords({ db: w.db, mailRef: mailRef(w.db), uid: 'u' })).toMatchObject({ removed: 1 });
        expect(w.data.get('users/u').incomeRecv).toEqual([]);
        expect(w.data.get('users/u/statementLedger/i1')).toMatchObject({ status: 'skipped', module: 'skip', reason: 'own-account', fingerprint: 'f', sourcePath: stmt });
        const user = w.data.get('users/u');
        expect(lostFiledRows({ user, entries: [{ id: 'i1', ...w.data.get('users/u/statementLedger/i1') }], now: Date.now() })).toEqual([]);
    });
    describe('cash drawn on the owner\'s own card (wealthflow-own-money.js), filed as income before the rule', () => {
        const advance = (id, extra = {}) => ({ id, source: 'statement', statementKey: stmt, date: '2026-07-10', amount: 100000, direction: 'credit', bank: 'DFCC Bank', name: 'Cash advance cr 376657******0276', type: 'Other', ...extra });
        const registry = { '0276': { type: 'credit_card', bank: 'AMEX', network: 'Amex', last4: '0276' } };
        it('is taken out of the income with a tombstone, kept whole in statementTrash, and the ledger says why', async () => {
            const w = world({ incomeRecv: [advance('c1'), advance('s1', { name: 'Salary Credit', amount: 150000, type: 'Salary' })], settings: { cardRegistry: registry } });
            w.data.set('users/u/statementLedger/c1', { uid: 'u', sourcePath: stmt, index: 4, status: 'filed', module: 'incomeRecv', fingerprint: 'f' });
            expect(await removeOwnTransferRecords({ db: w.db, mailRef: mailRef(w.db), uid: 'u' })).toEqual({ removed: 1, more: false });
            const user = w.data.get('users/u');
            expect(user.incomeRecv.map(r => r.id)).toEqual(['s1']);
            expect(user._tomb.incomeRecv.c1).toBeGreaterThan(0);
            expect(w.data.get('users/u/statementTrash/incomeRecv_c1')).toMatchObject({ store: 'incomeRecv', reason: 'own-money:card-cash-advance-in', source: stmt, record: { id: 'c1', amount: 100000, name: 'Cash advance cr 376657******0276', type: 'Other' } });
            expect(w.data.get('users/u/statementLedger/c1')).toMatchObject({ status: 'skipped', module: 'skip', reason: 'own-account' });
        });
        it('leaves a refund of an advance, a record the owner typed or recategorised, and a card the owner does not hold', async () => {
            const keep = [advance('a', { name: 'Cash advance reversal 376657******0276' }), advance('b', { source: 'manual' }), advance('c', { type: 'Loan' }), advance('d', { statementKey: '' })];
            const w = world({ incomeRecv: keep, settings: { cardRegistry: registry } });
            expect(await removeOwnTransferRecords({ db: w.db, mailRef: mailRef(w.db), uid: 'u' })).toEqual({ removed: 0, more: false });
            expect(w.data.get('users/u').incomeRecv.map(r => r.id)).toEqual(['a', 'b', 'c', 'd']);
        });
        it('also backs up what the older own-transfer rule takes out (an outward payment to the owner\'s own card)', async () => {
            const w = world({ expenses: [rec('r1')] });
            await removeOwnTransferRecords({ db: w.db, mailRef: mailRef(w.db), uid: 'u' });
            expect(w.data.get('users/u/statementTrash/expenses_r1')).toMatchObject({ reason: 'own-transfer-rule', record: { id: 'r1', amount: 150000 } });
        });
        it('runs again for an owner whose first pass ran under version 1', () => {
            expect(OWN_TRANSFER_VERSION).toBe(2);
        });
    });
    it('is bounded, says when there is more, and does not invent a ledger entry that does not exist', async () => {
        const w = world({ expenses: Array.from({ length: 5 }, (_, i) => rec('x' + i)) });
        expect(await removeOwnTransferRecords({ db: w.db, mailRef: mailRef(w.db), uid: 'u', limit: 3 })).toEqual({ removed: 3, more: true });
        expect(w.data.get('users/u').expenses).toHaveLength(2);
        expect(w.data.has('users/u/statementLedger/x0')).toBe(false);
    });
});
