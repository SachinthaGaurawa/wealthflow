import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';
import handler from '../statement-guard.js';
import { runStatementSync, healStatementCopies, healMissingRows } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { matchStatementRows, similarWords, sourceOf } from '../statement-rowmatch.mjs';
import { crossDoorCopies } from '../statement-copies.mjs';

/* =============================================================================
 * THE SAME STATEMENT, FILED BY BOTH DOORS, IS ONE STATEMENT.
 * The owner (2026-10-04, a screenshot of the Income tab): "Inward Ceft Transfer Dividend Paymen" 50,000 twice, "Inward Ceft Transfer" 245,000 twice, "Credit Koko0508" 10.00 twice — one of each
 * pair carrying the email system's note, the other the owner's own upload. Every row of a statement that arrived by email AND by hand was in the books twice. Each door asked "is this row already
 * there?" in its own way (the email system: words and account tail to the letter, which a hand upload rarely matches; the upload: words to the letter, and it dropped a row that merely repeated an
 * earlier row of its OWN statement). A row is now its day, its cents and the way the money went — COUNTED: a payment that really happened twice one day stays twice.
 * ===========================================================================*/

const sha = text => createHash('sha256').update(text).digest('hex');
const owner = { uid: 'u', email: 'owner@example.com' };
const MAIL = 'wf-mail/owner_example_com';
const fake = makeFakeAdmin(); let fs, saved;
const call = async body => {
    let out; const res = { statusCode: 200, setHeader() {}, end(t) { out = { status: this.statusCode, body: JSON.parse(t) }; } };
    await handler({ method: 'POST', body, headers: { authorization: 'Bearer ok' } }, res); return out;
};
const iso = ([d]) => d.split('/').reverse().join('-');
const ROWS = Array.from({ length: 12 }, (_, i) => [`${String(i + 2).padStart(2, '0')}/08/2026`, `SHOP NUMBER ${i + 1} COLOMBO`, 150 + i * 37.5, 'DR']);
/* three identical bus fares on one day are three transactions */
const REPEATS = [['05/08/2026', 'BUS FARE COLOMBO FORT', 50, 'DR'], ['05/08/2026', 'BUS FARE COLOMBO FORT', 50, 'DR'], ['05/08/2026', 'BUS FARE COLOMBO FORT', 50, 'DR'], ['06/08/2026', 'FUEL STATION KOLLUPITIYA', 4200, 'DR'], ['07/08/2026', 'SUPERMARKET BAMBALAPITIYA', 8350.5, 'DR']];
const statement = rows => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 03/09/2026 Payment Due Date: 25/09/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${rows.map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table></body></html>`;
const CREATED = '2026-10-04T10:00:00.000Z';
/** What the owner's own upload files: no statementKey, an `uploadClaim`, the account tail often unread, the words as the reader or the scan wrote them. */
const hand = (rows, { claim = 'attempt-hand-1', last4 = '', bank = 'Nations Trust Bank', words = r => r[1], first = 0 } = {}) => rows.map((r, at) => ({ id: `h${first + at}`, desc: words(r), amount: r[2], date: iso(r), uploadClaim: claim, statementKey: '', card_last4: last4, bank, feeMeta: { source: 'statement' }, createdAt: CREATED, _ut: Date.parse(CREATED) }));

let w, FILE;
/** The worker reads one statement (FILE) from one email item, over books that may already hold the owner's own upload. */
async function boot({ rows = ROWS, handRows = null, items = ['s0'], extra = {} } = {}) {
    FILE = statement(rows);
    saved = process.env.FIREBASE_SERVICE_ACCOUNT; process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
    fake.reset(); fake.setVerifier(async () => ({ uid: 'u', email: owner.email, email_verified: true }));
    const seed = { [MAIL]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] },
        'users/u': { expenses: [], incomeRecv: [], cconetime: handRows || [], ccPayments: [], subscriptions: [], ...extra } };
    items.forEach((id, at) => { seed[`${MAIL}/items/${id}`] = { uid: 'u', bank: 'NTB', from: 'statements@nationstrust.com', filename: `NTB Statement ${at}.pdf`, messageId: `m${at}`, receivedMs: 1000 + at, status: 'pending', cursor: 0, filed: false }; });
    fs = createFirestore(seed);
    fake.admin.firestore = () => fs.db; _setAdminModule(fake.admin);
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = async () => ({ bytes: Buffer.from(FILE), filename: 'statement.pdf', contentSha256: sha(FILE) });
    w = { run: async () => { for (let i = 0; i < 12; i++) { const r = await runStatementSync({ action: 'drain', db: fs.db, owner, env: {}, f, read: readStatement, open: async () => [], settle: settleStatement, board: async () => null, loadAttachment, budgetMs: 20000 }); if (!r || !r.filed) break; } },
        item: id => fs.data.get(`${MAIL}/items/${id}`), user: () => fs.data.get('users/u'),
        all: () => ['expenses', 'cconetime', 'incomeRecv', 'ccPayments'].flatMap(k => (w.user()[k] || []).map(r => ({ ...r, _store: k }))),
        ledger: () => [...fs.data.entries()].filter(([k]) => k.startsWith('users/u/statementLedger/')).map(([, v]) => v),
        trash: () => [...fs.data.entries()].filter(([k]) => k.startsWith('users/u/statementTrash/')).map(([, v]) => v) };
}
afterEach(() => { _setAdminModule(null); if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = saved; });
const askedFor = (rows, { claimed = false, bank = 'Nations Trust Bank', last4 = '', file = 'a-pdf-of-the-same-statement' } = {}) => ({ bank, last4, periodText: '', dates: rows.map(iso), amounts: rows.map(r => r[2]), directions: rows.map(r => (r[3] === 'CR' ? 'credit' : 'debit')), words: rows.map(r => r[1]), rows: rows.length, sha256: sha(file), ...(claimed ? { token: 'attempt-hand-2' } : {}) });

describe('THE EMAIL SYSTEM FILES A STATEMENT THE OWNER HAS ALREADY UPLOADED BY HAND', () => {
    it('REPRODUCTION: none of its 12 rows is filed a second time, however the hand upload worded them or whether it read the card tail', async () => {
        await boot({ handRows: hand(ROWS, { words: r => `${r[1].toLowerCase()} lk`, last4: '' }) });      // other words, no account tail
        expect(w.all()).toHaveLength(12);
        await w.run();
        expect(w.item('s0')).toMatchObject({ status: 'filed', filed: true });
        expect(w.all()).toHaveLength(12);                                                                  // before the fix: 24 (every row twice)
        expect(w.ledger().filter(e => e.reason === 'already-in-books')).toHaveLength(12);
        expect(w.all().every(r => !r.statementKey)).toBe(true);                                            // the owner's own records stand; the system added nothing
    });
    it('the same when the hand upload worded the lines exactly as the statement does (and read the tail)', async () => {
        await boot({ handRows: hand(ROWS, { last4: '0276' }) });
        await w.run();
        expect(w.all()).toHaveLength(12);
    });
    it('a hand upload of only PART of the statement: the rows it holds are not filed again and the others are', async () => {
        await boot({ handRows: hand(ROWS.slice(0, 5), { words: r => `${r[1]} (hand)` }) });
        await w.run();
        expect(w.all()).toHaveLength(12);
        expect(w.all().filter(r => r.statementKey)).toHaveLength(7);
        expect(w.ledger().filter(e => e.reason === 'already-in-books')).toHaveLength(5);
    });
    it('a payment that really happened three times on one day is three records: the hand upload holds two, the email system adds the third', async () => {
        await boot({ rows: REPEATS, handRows: hand(REPEATS.slice(0, 2), { words: r => `${r[1]} x` }) });
        await w.run();
        const fares = w.all().filter(r => r.amount === 50);
        expect(fares).toHaveLength(3);
        expect(fares.filter(r => r.statementKey)).toHaveLength(1);
        expect(w.all()).toHaveLength(5);                                                                   // the 5 rows of the statement, each once (3 fares, fuel, groceries)
    });
    it('a statement the owner has not uploaded is filed whole, as before', async () => {
        await boot();
        await w.run();
        expect(w.all()).toHaveLength(12);
        expect(w.all().every(r => r.statementKey)).toBe(true);
    });
    it('an unrelated hand-filed payment that happens to share one day and amount does not hide a row of the statement', async () => {
        await boot({ handRows: hand([['02/08/2026', 'SOMETHING ELSE ENTIRELY', 150, 'DR']], { claim: 'attempt-other', words: r => r[1] }) });
        await w.run();
        expect(w.all()).toHaveLength(13);
    });
    it('a statement read again after a heal finds the owner\'s rows again and still files nothing twice', async () => {
        await boot({ handRows: hand(ROWS, { words: r => r[1].toUpperCase().slice(0, 14) }) });
        await w.run();
        expect(w.all()).toHaveLength(12);
        fs.data.set(`${MAIL}/items/s0`, { ...w.item('s0'), status: 'pending', filed: false, cursor: 0, totalRows: null, rowSetHash: '', leaseToken: '', leaseUntil: 0, retryAt: 0 });
        for (const [key, value] of [...fs.data.entries()]) if (key.startsWith('users/u/statementLedger/')) fs.data.set(key, { ...value, status: 'superseded_by_layout' });
        await w.run();
        expect(w.all()).toHaveLength(12);
    });
});

describe('A ROW LEFT OUT BECAUSE THE OWNER\'S UPLOAD HELD IT must not be lost with that record', () => {
    it('a stale device\'s list that wipes the hand-filed rows (nobody deleted them) brings the rows back from the email', async () => {
        await boot({ handRows: hand(ROWS, { words: r => `${r[1].toLowerCase()} lk` }) });
        await w.run();
        expect(w.all()).toHaveLength(12);
        fs.data.set('users/u', { ...w.user(), cconetime: [] });                                            // the device that had not seen them pushed its own, empty list
        expect(await healMissingRows({ db: fs.db, uid: 'u' })).toMatchObject({ requeued: 1, rows: 12 });
        await w.run();
        expect(w.all()).toHaveLength(12);
        expect(w.all().every(r => r.statementKey)).toBe(true);
    });
    it('rows the owner DELETED (a tombstone) are left deleted', async () => {
        await boot({ handRows: hand(ROWS, { words: r => `${r[1].toLowerCase()} lk` }) });
        await w.run();
        const tomb = Object.fromEntries(w.user().cconetime.map(r => [r.id, Date.now()]));
        fs.data.set('users/u', { ...w.user(), cconetime: [], _tomb: { cconetime: tomb } });
        expect(await healMissingRows({ db: fs.db, uid: 'u' })).toMatchObject({ requeued: 0 });
        expect(w.all()).toHaveLength(0);
    });
    it('while the owner\'s records are there nothing is re-read', async () => {
        await boot({ handRows: hand(ROWS, { words: r => `${r[1].toLowerCase()} lk` }) });
        await w.run();
        expect(await healMissingRows({ db: fs.db, uid: 'u' })).toMatchObject({ requeued: 0 });
    });
});

describe('THE OWNER UPLOADS BY HAND A STATEMENT THE EMAIL SYSTEM HAS ALREADY FILED', () => {
    it('REPRODUCTION: every row the books already hold is named, whatever the account tail and the words (the registry does not know the bank or the card)', async () => {
        await boot();
        await w.run();
        expect(w.all()).toHaveLength(12);
        const reply = (await call({ ...askedFor(ROWS, { bank: '', last4: '' }), action: 'check' })).body;
        expect(reply).toMatchObject({ ok: true, duplicate: false });
        expect(reply.have).toEqual(ROWS.map((_, at) => at));
    });
    it('the claim at Save names them too (the rows the books took while the review was open)', async () => {
        await boot();
        await w.run();
        const reply = (await call({ ...askedFor(ROWS, { bank: '', last4: '' }), action: 'claim', token: 'attempt-hand-2' })).body;
        expect(reply.have).toEqual(ROWS.map((_, at) => at));
    });
    it('a statement the owner holds only part of is let in: the rows the books hold are named, the others are not', async () => {
        await boot({ rows: ROWS.slice(0, 6) });
        await w.run();
        const reply = (await call({ ...askedFor(ROWS, { bank: '', last4: '' }), action: 'check' })).body;
        expect(reply.have).toEqual([0, 1, 2, 3, 4, 5]);
    });
    it('a payment of the same day and amount that went the OTHER way is not the same row', async () => {
        await boot({ rows: [['05/08/2026', 'BUS FARE COLOMBO FORT', 50, 'DR'], ['06/08/2026', 'FUEL STATION KOLLUPITIYA', 4200, 'DR']] });
        await w.run();
        const reply = (await call({ ...askedFor([['05/08/2026', 'REFUND BUS FARE', 50, 'CR'], ['06/08/2026', 'FUEL STATION KOLLUPITIYA', 4200, 'DR']], { bank: '', last4: '' }), action: 'check' })).body;
        expect(reply.have).toEqual([1]);
    });
    it('three identical rows of a statement the email system filed three times are all named; a fourth identical row is not', async () => {
        await boot({ rows: REPEATS });
        await w.run();
        const four = [REPEATS[0], ...REPEATS];
        const reply = (await call({ ...askedFor(four, { bank: '', last4: '' }), action: 'check' })).body;
        expect(reply.have.filter(at => four[at][2] === 50)).toHaveLength(3);
        expect(reply.have).toHaveLength(five(four));
        function five(list) { return list.length - 1; }
    });
});

describe('THE ROW MATCHER (statement-rowmatch.mjs)', () => {
    const user = (records, store = 'expenses') => ({ [store]: records });
    const rec = (id, source, date, amount, words, extra = {}) => ({ id, desc: words, amount, date, createdAt: CREATED, ...source, ...extra });
    it('names the source of a record by where it came from', () => {
        expect(sourceOf({ statementKey: 'wf-mail/x/items/a' })).toBe('k:wf-mail/x/items/a');
        expect(sourceOf({ uploadClaim: 'tok' })).toBe('u:tok');
        expect(sourceOf({ _batch: 'b1' })).toBe('b:b1');
        expect(sourceOf({ source: 'statement' })).toBe('h:hand');
        expect(sourceOf({ desc: 'typed by the owner' })).toBe('');
    });
    it('similar words: the same line cut short, the same words reordered, not two different payees', () => {
        expect(similarWords('Inward Ceft Transfer Dividend Paymen', 'INWARD CEFT TRANSFER DIVIDEND PAYMENT')).toBe(true);
        expect(similarWords('POS PURCHASE KEELLS SUPER', 'KEELLS SUPER POS PURCHASE')).toBe(true);
        expect(similarWords('KEELLS SUPER', 'DIALOG AXIATA')).toBe(false);
        expect(similarWords('', 'KEELLS SUPER')).toBe(false);
    });
    it('does not count a source against itself', () => {
        const rows = [{ date: '2026-08-02', amount: 100, direction: 'debit', description: 'A SHOP' }, { date: '2026-08-03', amount: 200, direction: 'debit', description: 'B SHOP' }];
        const books = user([rec('1', { statementKey: 'wf-mail/x/items/a' }, '2026-08-02', 100, 'a shop', { source: 'statement' }), rec('2', { statementKey: 'wf-mail/x/items/a' }, '2026-08-03', 200, 'b shop', { source: 'statement' })]);
        expect(matchStatementRows({ user: books, rows, selfSource: 'k:wf-mail/x/items/a' }).have).toEqual([]);
        expect(matchStatementRows({ user: books, rows }).have.map(h => h.index)).toEqual([0, 1]);
    });
    it('an account tail or bank that DIFFERS is a conflict; one that is unknown is not', () => {
        const rows = [{ date: '2026-08-02', amount: 100, direction: 'debit', description: 'A SHOP' }, { date: '2026-08-03', amount: 200, direction: 'debit', description: 'B SHOP' }];
        const mk = last4 => user([rec('1', { uploadClaim: 't' }, '2026-08-02', 100, 'a shop', { card_last4: last4, source: 'statement' }), rec('2', { uploadClaim: 't' }, '2026-08-03', 200, 'b shop', { card_last4: last4, source: 'statement' })]);
        expect(matchStatementRows({ user: mk('1111'), rows, last4: '2222' }).have).toEqual([]);
        expect(matchStatementRows({ user: mk('1111'), rows, last4: '1111' }).have).toHaveLength(2);
        expect(matchStatementRows({ user: mk(''), rows, last4: '2222' }).have).toHaveLength(2);
    });
    it('rows are counted: books holding two copies of a row, filed by two sources that are the SAME statement, still cover only the rows the statement shows', () => {
        const rows = [{ date: '2026-08-05', amount: 50, direction: 'debit', description: 'BUS' }, { date: '2026-08-05', amount: 50, direction: 'debit', description: 'BUS' }, { date: '2026-08-06', amount: 70, direction: 'debit', description: 'TEA' }];
        const books = user([rec('1', { uploadClaim: 'a' }, '2026-08-05', 50, 'bus', { source: 'statement' }), rec('2', { uploadClaim: 'a' }, '2026-08-05', 50, 'bus', { source: 'statement' }), rec('3', { uploadClaim: 'a' }, '2026-08-06', 70, 'tea', { source: 'statement' }),
            rec('4', { uploadClaim: 'b' }, '2026-08-05', 50, 'bus', { source: 'statement' }), rec('5', { uploadClaim: 'b' }, '2026-08-05', 50, 'bus', { source: 'statement' }), rec('6', { uploadClaim: 'b' }, '2026-08-06', 70, 'tea', { source: 'statement' })]);
        expect(matchStatementRows({ user: books, rows }).have.map(h => h.index)).toEqual([0, 1, 2]);
    });
    it('a lone row is the same only when its words are the same line; two unrelated statements that share ONE day and amount are not copies', () => {
        const rows = [{ date: '2026-08-02', amount: 100, direction: 'debit', description: 'KEELLS SUPER' }];
        const other = user([rec('1', { uploadClaim: 'a' }, '2026-08-02', 100, 'dialog axiata', { source: 'statement' })]);
        const same = user([rec('1', { uploadClaim: 'a' }, '2026-08-02', 100, 'keells super colombo', { source: 'statement' })]);
        expect(matchStatementRows({ user: other, rows }).have).toEqual([]);
        expect(matchStatementRows({ user: same, rows }).have).toHaveLength(1);
    });
});

describe('THE BOOKS ALREADY HOLD A STATEMENT TWICE (cleanup of what was filed before the fix)', () => {
    const copies = async (opts = {}) => {
        await boot(opts);
        await w.run();
        const store = ['expenses', 'cconetime'].find(k => (w.user()[k] || []).some(r => r.statementKey));
        const mine = hand(ROWS, { words: r => `${r[1].toLowerCase()} lk`, last4: '' });
        fs.data.set('users/u', { ...w.user(), [store]: [...w.user()[store], ...mine] });
        return store;
    };
    it('REPRODUCTION: each row is twice; afterwards once, the email system\'s records stay (they know the card), and every removed record is backed up whole', async () => {
        const store = await copies();
        expect(w.all()).toHaveLength(24);
        const done = await healStatementCopies({ db: fs.db, mailRef: fs.db.doc(MAIL), uid: 'u', log: () => {} });
        expect(done.removed).toBe(12);
        expect(w.all()).toHaveLength(12);
        expect(w.all().every(r => r.statementKey)).toBe(true);
        expect(w.trash()).toHaveLength(12);
        expect(w.trash()[0]).toMatchObject({ uid: 'u', store, reason: 'copy-from-another-door' });
        expect(w.trash()[0].record).toMatchObject({ uploadClaim: 'attempt-hand-1' });                       // the whole record, so it can be put back
        for (const r of w.trash()) expect(w.user()._tomb[store][r.record.id]).toBeGreaterThan(0);              // and no device brings it back
        expect((await healStatementCopies({ db: fs.db, mailRef: fs.db.doc(MAIL), uid: 'u', log: () => {} })).removed).toBe(0);
    });
    it('a record the owner has edited is never taken out', async () => {
        await copies();
        const u = w.user(), list = u.cconetime || u.expenses;
        const key = u.cconetime.some(r => r.uploadClaim) ? 'cconetime' : 'expenses';
        fs.data.set('users/u', { ...u, [key]: u[key].map(r => (r.id === 'h3' ? { ...r, _ut: r._ut + 600000, desc: 'renamed by the owner' } : r)) });
        const done = await healStatementCopies({ db: fs.db, mailRef: fs.db.doc(MAIL), uid: 'u', log: () => {} });
        expect(done.removed).toBe(12);                                                                       // 11 untouched hand copies, and the system's copy of the row the owner edited
        expect(w.all().some(r => r.id === 'h3' && r.desc === 'renamed by the owner')).toBe(true);           // the owner's edited record stands
        expect(w.all()).toHaveLength(12);
        expect(list).toBeTruthy();
    });
    it('three identical fares filed by BOTH doors stay three, not six and not one', async () => {
        await boot({ rows: REPEATS });
        await w.run();
        const store = ['expenses', 'cconetime'].find(k => (w.user()[k] || []).some(r => r.statementKey));
        fs.data.set('users/u', { ...w.user(), [store]: [...w.user()[store], ...hand(REPEATS, { words: r => `${r[1]} x` })] });
        expect(w.all().filter(r => r.amount === 50)).toHaveLength(6);
        await healStatementCopies({ db: fs.db, mailRef: fs.db.doc(MAIL), uid: 'u', log: () => {} });
        expect(w.all().filter(r => r.amount === 50)).toHaveLength(3);
        expect(w.all()).toHaveLength(5);
    });
    it('two statements that merely share a day and an amount are left alone', async () => {
        await boot({ rows: ROWS.slice(0, 1) });
        await w.run();
        const store = ['expenses', 'cconetime'].find(k => (w.user()[k] || []).some(r => r.statementKey));
        fs.data.set('users/u', { ...w.user(), [store]: [...w.user()[store], ...hand([['02/08/2026', 'COMPLETELY DIFFERENT PAYEE', 150, 'DR']], { claim: 'other' })] });
        expect((await healStatementCopies({ db: fs.db, mailRef: fs.db.doc(MAIL), uid: 'u', log: () => {} })).removed).toBe(0);
        expect(w.all()).toHaveLength(2);
    });
    it('the owner\'s Income tab (May 2026): credits filed by the email system AND by hand collapse to one each, and a credit that really came twice stays twice', () => {
        const worker = (id, row, name, amount, date) => ({ id, name, type: 'Other', amount, month: date.slice(0, 7), date, received: true, source: 'statement', statementKey: 'wf-mail/owner/items/may', statementRow: row, bank: 'NTB', card_last4: '4821', direction: 'credit', notes: 'Filed automatically; the AI could not pick a more specific category', createdAt: CREATED, _ut: Date.parse(CREATED) });
        const mine = (id, name, amount, date) => ({ id, name, type: 'Other', amount, month: date.slice(0, 7), date, received: true, source: 'statement', uploadClaim: 'attempt-may', statementKey: '', bank: 'Nations Trust Bank', card_last4: '', createdAt: '2026-10-04T11:00:00.000Z', _ut: Date.parse('2026-10-04T11:00:00.000Z') });
        const books = { incomeRecv: [
            worker('w1', 0, 'Inward Ceft Transfer Dividend Paymen', 50000, '2026-05-12'), worker('w2', 1, 'Inward Ceft Transfer', 245000, '2026-05-14'), worker('w3', 2, 'Credit Koko0508', 10, '2026-05-20'), worker('w4', 3, 'Credit Koko0508', 10, '2026-05-20'), worker('w5', 4, 'Salary Credit', 180000, '2026-05-25'),
            mine('h1', 'INWARD CEFT TRANSFER DIVIDEND PAYMENT', 50000, '2026-05-12'), mine('h2', 'Inward Ceft Transfer', 245000, '2026-05-14'), mine('h3', 'Credit Koko0508', 10, '2026-05-20'), mine('h4', 'Credit Koko0508', 10, '2026-05-20'), mine('h5', 'SALARY CREDIT', 180000, '2026-05-25')] };
        const plan = crossDoorCopies(books);
        expect(plan.remove.map(entry => entry.record.id).sort()).toEqual(['h1', 'h2', 'h3', 'h4', 'h5']);       // the hand copies go; the email system's records (which know the account) stay
        expect(books.incomeRecv.filter(r => r.amount === 10 && !plan.remove.some(entry => entry.record === r))).toHaveLength(2);   // the two real credits of 10.00 are still two
        expect(plan.remove.every(entry => entry.keptSource === 'k:wf-mail/owner/items/may')).toBe(true);
    });
    it('two different known account tails are two accounts, never one statement', () => {
        const mk = (id, last4, claim) => ({ id, desc: 'SAME SHOP', amount: 100, date: '2026-08-02', uploadClaim: claim, card_last4: last4, bank: 'Nations Trust Bank', feeMeta: { source: 'statement' }, createdAt: CREATED, _ut: Date.parse(CREATED) });
        const books = { cconetime: ['a', 'b', 'c'].flatMap((c, at) => [mk(`${c}1`, at < 2 ? (at ? '2222' : '1111') : '', c), mk(`${c}2`, at < 2 ? (at ? '2222' : '1111') : '', c)]) };
        expect(crossDoorCopies(books).remove.length).toBe(0);
    });
});
