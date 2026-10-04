import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';
import handler from '../statement-guard.js';
import { identityOf, claimStatement, lookup, VIA, REGISTRY } from '../statement-registry.mjs';

/* =============================================================================
 * TWO DIFFERENT STATEMENTS THAT SHARE A MONTH LABEL. The owner reported (twice) that a statement which is NOT in the books — the email sync never filed
 * it, and the books hold none of its rows — is turned away on manual upload as "Already Added via Email Sync".
 *
 * Reproduced here with the real endpoint and the real registry: a card that closes on the 3rd has statements 4 Sep – 3 Oct and 4 Oct – 3 Nov. The email
 * worker keys a statement on the month of its LATEST TRANSACTION (it never reads the period text), the upload screen on the END OF THE PERIOD. Both
 * statements can therefore carry the same key (bank, card, October), and a holder written before the registry kept the days of a statement ("legacy":
 * no `days`, no `rows`) cannot be told apart from a copy — so the statement the owner is uploading is "already added" because ANOTHER statement of that
 * card is. The same flaw made the email worker close the second of two consecutive statements as a copy of the first, filing neither — which is why
 * the owner found the month missing from the automatic system too.
 *
 * The rule the fix makes true: a statement is a copy only when its TRANSACTIONS are in the books.
 * ===========================================================================*/

const sha = text => createHash('sha256').update(text).digest('hex');
const MAIL = 'wf-mail/owner_example_com';
const fake = makeFakeAdmin(); let fs, saved;
const call = async body => {
    let out; const res = { statusCode: 200, setHeader() {}, end(t) { out = { status: this.statusCode, body: JSON.parse(t) }; } };
    await handler({ method: 'POST', body, headers: { authorization: 'Bearer ok' } }, res); return out;
};
beforeEach(() => {
    saved = process.env.FIREBASE_SERVICE_ACCOUNT; process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
    fake.reset(); fake.setVerifier(async () => ({ uid: 'u', email: 'owner@example.com', email_verified: true }));
    fs = createFirestore({ [MAIL]: { uid: 'u' }, 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] } });
    fake.admin.firestore = () => fs.db; _setAdminModule(fake.admin);
});
afterEach(() => { _setAdminModule(null); if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = saved; });

/* The statement of 4 Oct – 3 Nov: the email worker filed it (its latest transaction is 30 Oct, so the worker calls it October). */
const NOV_ROWS = [['2026-10-06', 1250], ['2026-10-11', 4800.5], ['2026-10-19', 310], ['2026-10-30', 9990]];
/* The statement of 4 Sep – 3 Oct, which the email system never fetched: the owner has the PDF. Its period ends in October, its last transaction is 1 Oct. */
const OCT_ROWS = [['2026-09-06', 2100], ['2026-09-13', 560], ['2026-09-24', 7400], ['2026-10-01', 180]];
const upload = rows => ({ bank: 'Nations Trust Bank', last4: 'XXXX0276', periodText: '04/09/2026 - 03/10/2026', dates: rows.map(r => r[0]), amounts: rows.map(r => r[1]), rows: rows.length, sha256: sha('the-owners-pdf') });

/** The email statement as it stands in the books: filed by the worker (records carry the item path). `legacy` writes its registry hold as the first version
 *  of the registry did, before it kept `days`, `rows` and `door`. */
function emailFiled(rows, { legacy = false, item = 'nov' } = {}) {
    const path = `${MAIL}/items/${item}`;
    fs.data.set(path, { uid: 'u', bank: 'NTB', status: 'filed', filed: true, cursor: rows.length, totalRows: rows.length, contentSha256: sha('mailed-pdf') });
    const identity = identityOf({ bank: 'NTB', account: '0276', dates: rows.map(r => r[0]) });
    const doc = { via: 'email', ref: path, bank: identity.bank, account: identity.account, year: identity.year, month: identity.month, sha: sha('mailed-pdf'), filename: 'AMEX_Statement.pdf', size: 1, createdAt: Date.now() - 86400_000 };
    if (!legacy) Object.assign(doc, { days: identity.days, rows: rows.length, door: 'worker' });
    fs.data.set(`users/u/${REGISTRY}/${identity.id}`, doc);
    fs.data.set(`users/u/${REGISTRY}/h-${sha('mailed-pdf')}`, { ...doc });
    fs.data.set('users/u', { ...fs.data.get('users/u'), cconetime: rows.map(([date, amount], at) => ({ id: `c${at}`, statementKey: path, statementRow: at, source: 'statement', amount, date, desc: `ROW ${at}`, bank: 'NTB', card_last4: '0276' })) });
    return { path, identity };
}

describe('a statement that only shares a month label with one in the books is not a copy of it', () => {
    it('REPRODUCTION: the owner uploads 4 Sep – 3 Oct while the books hold 4 Oct – 3 Nov (hold written before the registry kept days)', async () => {
        emailFiled(NOV_ROWS, { legacy: true });
        const reply = (await call({ ...upload(OCT_ROWS), action: 'check' })).body;
        expect(reply).toMatchObject({ ok: true, duplicate: false });
    });
    it('the same from a device still on the old app, which sends no amounts: the days the books hold decide', async () => {
        emailFiled(NOV_ROWS, { legacy: true });
        const { amounts, ...old } = upload(OCT_ROWS);
        expect((await call({ ...old, action: 'check' })).body).toMatchObject({ ok: true, duplicate: false });
        const { amounts: _, ...copy } = upload(NOV_ROWS);
        expect((await call({ ...copy, sha256: sha('a-second-download'), action: 'check' })).body).toMatchObject({ duplicate: true, via: 'email' });
    });
    it('the same with a hold that does keep its days', async () => {
        emailFiled(NOV_ROWS);
        expect((await call({ ...upload(OCT_ROWS), action: 'check' })).body.duplicate).toBe(false);
    });
    it('at Save the claim goes through and the statement is held by the upload (its file at least)', async () => {
        emailFiled(NOV_ROWS, { legacy: true });
        expect((await call({ ...upload(OCT_ROWS), action: 'claim', token: 'attempt-0001' })).body).toMatchObject({ ok: true, duplicate: false });
        expect(fs.data.has(`users/u/${REGISTRY}/h-${sha('the-owners-pdf')}`)).toBe(true);
    });
    it('the email worker files the second statement instead of closing it as a copy of the first', async () => {
        emailFiled(OCT_ROWS, { legacy: true, item: 'oct' });
        const second = fs.data.get(`${MAIL}/items/oct`);
        expect(second.filed).toBe(true);
        const identity = identityOf({ bank: 'NTB', account: '0276', dates: NOV_ROWS.map(r => r[0]) });
        const found = await lookup({ db: fs.db, uid: 'u', claim: true, via: VIA.EMAIL, ref: `${MAIL}/items/nov`, identity, sha: sha('other-bytes'),
            rows: NOV_ROWS.length, rowKeys: NOV_ROWS.map(([date, amount]) => ({ date, amount })), meta: { filename: 'AMEX_Statement.pdf', rows: NOV_ROWS.length, door: 'worker' } });
        expect(found.ok).toBe(true);
    });
});

describe('a statement whose transactions ARE in the books is still turned away', () => {
    it('the very same statement, however it is worded, by the email system: "Already Added via Email Sync"', async () => {
        emailFiled(NOV_ROWS, { legacy: true });
        const reply = (await call({ ...upload(NOV_ROWS), periodText: '04/10/2026 - 03/11/2026', sha256: sha('a-second-download'), action: 'check' })).body;
        expect(reply).toMatchObject({ ok: true, duplicate: true, via: 'email', notice: 'Already Added via Email Sync' });
        expect(reply.detail).toMatch(/4 of 4 transactions are in your books/);
    });
    it('the books hold only some of its rows (an own-account transfer is never filed, the owner deleted one): still the same statement, by the email door too', async () => {
        const { path } = emailFiled(NOV_ROWS);
        fs.data.set('users/u', { ...fs.data.get('users/u'), cconetime: fs.data.get('users/u').cconetime.filter((_, at) => at === 1 || at === 3) });
        const reply = (await call({ ...upload(NOV_ROWS), periodText: '', sha256: sha('a-second-download'), action: 'check' })).body;
        expect(reply).toMatchObject({ duplicate: true, via: 'email' });
        expect(reply.detail).toMatch(/2 transactions in your books/);
        const identity = identityOf({ bank: 'NTB', account: '0276', dates: NOV_ROWS.map(r => r[0]) });
        const again = await lookup({ db: fs.db, uid: 'u', claim: true, via: VIA.EMAIL, ref: `${MAIL}/items/resent`, identity, sha: sha('resent-bytes'), rows: 4,
            rowKeys: NOV_ROWS.map(([date, amount]) => ({ date, amount })), meta: { rows: 4, door: 'worker' } });
        expect(again).toMatchObject({ duplicate: true, existing: { ref: path } });
    });
    it('a statement with a few rows more than the one in the books is the same statement when most of its rows are there', async () => {
        emailFiled(NOV_ROWS);
        const more = [...NOV_ROWS, ['2026-10-31', 75]];
        expect((await call({ ...upload(more), periodText: '', action: 'check' })).body.duplicate).toBe(true);
    });
});

/* ── the same, through the real email worker ─────────────────────────────────────────────────────────────────────────────── */
import { runStatementSync, reopenRegistryCopies } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { registryDuplicatePatch } from '../statement-registry.mjs';

const owner = { uid: 'u', email: 'owner@example.com' };
/** An NTB AMEX e-statement: `rows` are [dd/mm/yyyy, words, amount, 'DR'|'CR']. */
const statement = (date, rows) => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: ${date} Payment Due Date: 25/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${rows.map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table></body></html>`;
/* Two consecutive cycles of a card that closes on the 3rd, neither with a transaction after the 28th: the worker keys BOTH on September. */
const AUG_CYCLE = statement('03/09/2026', [['12/08/2026', 'KEELLS STORE', 123.45, 'DR'], ['02/09/2026', 'PAYMENT THANK YOU', 50, 'CR']]);
const SEP_CYCLE = statement('03/10/2026', [['18/09/2026', 'CARGILLS FOOD CITY', 2450, 'DR'], ['27/09/2026', 'ODEL COLOMBO', 1999, 'DR']]);
function world(sources, { settle = settleStatement } = {}) {
    const seed = { [MAIL]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] }, 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] } };
    sources.forEach((body, i) => { seed[`${MAIL}/items/s${i}`] = { uid: 'u', bank: 'NTB', from: 'statements@nationstrust.com', filename: 'AMEX_Statement.html', messageId: `m${i}`, receivedMs: 1000 + i, status: i ? 'held-back' : 'pending', cursor: 0, filed: false }; });
    const w = createFirestore(seed);
    fs = w; fake.admin.firestore = () => w.db;
    const loadAttachment = async source => { const body = sources[Number(source.messageId.slice(1))]; return { bytes: Buffer.from(body), filename: 'AMEX_Statement.html', contentSha256: sha(body) }; };
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const run = async () => { for (let i = 0; i < 12; i++) { const r = await runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f, read: readStatement, open: async () => [], settle, board: async () => null, loadAttachment, budgetMs: 20000 }); if (!r || !r.filed) break; } };
    const release = i => w.data.set(`${MAIL}/items/s${i}`, { ...w.data.get(`${MAIL}/items/s${i}`), status: 'pending' });
    /* what a hold written before the registry kept days looks like */
    const legacy = () => { for (const key of [...w.data.keys()].filter(k => k.startsWith(`users/u/${REGISTRY}/`))) { const { days, rows, door, ...rest } = w.data.get(key); w.data.set(key, rest); } };
    return { data: w.data, run, release, legacy, item: i => w.data.get(`${MAIL}/items/s${i}`), user: () => w.data.get('users/u') };
}

describe('through the real email worker', () => {
    it('two consecutive statements keyed on one month are both filed, even against a hold written before the registry kept days', async () => {
        const w = world([AUG_CYCLE, SEP_CYCLE]);
        await w.run();
        expect(w.item(0)).toMatchObject({ status: 'filed', filed: true });
        w.legacy(); w.release(1); await w.run();
        expect(w.item(1)).toMatchObject({ status: 'filed', filed: true });
        expect(w.item(1).duplicateOf).toBeUndefined();
        expect(w.user().cconetime.map(r => r.date).sort()).toEqual(['2026-08-12', '2026-09-18', '2026-09-27']);
    });
    it('a statement the old rule closed as a copy is read again once and filed; a real copy is closed again and left closed', async () => {
        const COPY = AUG_CYCLE.replace('<h1>', '<h1 class="resent">');                  // the same statement, re-sent in other bytes
        const w = world([AUG_CYCLE, SEP_CYCLE, COPY]);
        await w.run();
        // what the old rule did to the next cycle: closed as "Already Added via Email Sync", nothing filed
        fs.data.set(`${MAIL}/items/s1`, { ...w.item(1), ...registryDuplicatePatch({ duplicate: { kind: 'period', existing: { via: 'email' } } }) });
        w.release(2); await w.run();
        expect(w.item(2)).toMatchObject({ filed: true, duplicateOf: 'registry:email' });
        expect(w.user().cconetime).toHaveLength(1);
        const logs = [];
        const r = await reopenRegistryCopies({ db: fs.db, mailRef: fs.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', log: line => logs.push(JSON.parse(line)) });
        expect(r.reopened).toBe(2);
        expect(logs[0]).toMatchObject({ evt: 'statement-registry-copies', reopened: 2 });
        await w.run();
        expect(w.item(1)).toMatchObject({ status: 'filed', filed: true, duplicateOf: '' });
        expect(w.item(2)).toMatchObject({ filed: true, duplicateOf: 'registry:email' });     // the real copy: its transactions ARE in the books
        expect(w.user().cconetime.map(r => r.date).sort()).toEqual(['2026-08-12', '2026-09-18', '2026-09-27']);
        // and it is not reopened a second time
        expect((await reopenRegistryCopies({ db: fs.db, mailRef: fs.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', log: () => {} })).reopened).toBe(0);
    });
    it('a copy of a statement whose records the owner deleted is NOT brought back by being read again; the owner may still upload it by hand', async () => {
        const COPY = AUG_CYCLE.replace('<h1>', '<h1 class="resent">');
        const w = world([AUG_CYCLE, COPY]);
        await w.run(); w.release(1); await w.run();
        expect(w.item(1)).toMatchObject({ filed: true, duplicateOf: 'registry:email' });
        fs.data.set('users/u', { ...w.user(), cconetime: [], ccPayments: [] });                      // the owner deleted the statement
        expect((await reopenRegistryCopies({ db: fs.db, mailRef: fs.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', log: () => {} })).reopened).toBe(1);
        await w.run();
        expect(w.item(1)).toMatchObject({ filed: true, duplicateOf: 'registry:email' });
        expect(w.user().cconetime).toHaveLength(0); expect(w.user().ccPayments).toHaveLength(0);
        const byHand = { bank: 'Nations Trust Bank', last4: '376657XXXXX0276', dates: ['2026-08-12', '2026-09-02'], amounts: [123.45, 50], rows: 2, sha256: sha('a-download') };
        expect((await call({ ...byHand, action: 'check' })).body).toMatchObject({ duplicate: false });
    });
    it('the owner uploads the next cycle by hand while the books hold the last one: it goes in, and the email copy of it later is closed as a copy of the upload', async () => {
        const w = world([AUG_CYCLE, SEP_CYCLE]);
        await w.run(); w.legacy();
        const mine = { bank: 'Nations Trust Bank', last4: '376657XXXXX0276', periodText: '04/09/2026 - 03/10/2026', dates: ['2026-09-18', '2026-09-27'], amounts: [2450, 1999], rows: 2, sha256: sha('the-owners-download') };
        expect((await call({ ...mine, action: 'check' })).body).toMatchObject({ duplicate: false });
        expect((await call({ ...mine, action: 'claim', token: 'attempt-0001' })).body).toMatchObject({ duplicate: false });
        // the device files the two rows with the claim's token and syncs
        fs.data.set('users/u', { ...w.user(), cconetime: [...w.user().cconetime, { id: 'm1', date: '2026-09-18', amount: 2450, uploadClaim: 'attempt-0001' }, { id: 'm2', date: '2026-09-27', amount: 1999, uploadClaim: 'attempt-0001' }] });
        w.release(1); await w.run();
        expect(w.item(1)).toMatchObject({ filed: true, duplicateOf: 'registry:upload' });
        expect(w.user().cconetime).toHaveLength(3);
    });
});

/* ── every way the system itself can leave a hold with nothing real behind it, and every kind of record that is real ── */
describe('a hold the email system took and left with nothing behind it never turns the owner away', () => {
    const SEP_UPLOAD = { bank: 'Nations Trust Bank', last4: '376657XXXXX0276', periodText: '04/09/2026 - 03/10/2026', dates: ['2026-09-18', '2026-09-27'], amounts: [2450, 1999], rows: 2, sha256: sha('the-owners-download') };
    const hold = async (rows, ref, sha256 = 'mailed') => claimStatement({ db: fs.db, uid: 'u', via: VIA.EMAIL, ref, identity: identityOf({ bank: 'NTB', account: '0276', dates: rows.map(r => r[0]) }), sha: sha(sha256), meta: { filename: 'AMEX_Statement.pdf', rows: rows.length, door: 'worker' } });
    const ROWS = [['2026-09-18', 2450], ['2026-09-27', 1999]];
    const state = (extra = {}) => fs.data.set(`${MAIL}/items/x`, { uid: 'u', bank: 'NTB', status: 'pending', filed: false, cursor: 0, leaseUntil: 0, ...extra });
    it.each([
        ['the sync claimed it, then the attachment could not be settled (retry waiting)', { status: 'pending', retryAt: Date.now() + 60_000, retryCount: 3 }],
        ['it stopped for the owner to confirm an empty reading', { status: 'needs_review', hasReview: true, reviewReason: 'statement-empty-needs-confirmation' }],
        ['it was filed with zero rows (an empty statement)', { status: 'filed', filed: true, cursor: 0, totalRows: 0 }],
        ['it was parked as a dead letter part-way, hours ago', { status: 'dead_letter', cursor: 4, updatedAt: Date.now() - 3 * 3600_000 }],
        ['its sender was rejected afterwards', { status: 'rejected_unapproved_sender' }],
    ])('%s: the month and the file are free for a hand upload', async (_, shape) => {
        state(shape); await hold(ROWS, `${MAIL}/items/x`);
        expect((await call({ ...SEP_UPLOAD, action: 'check' })).body).toMatchObject({ ok: true, duplicate: false });
        expect((await call({ action: 'check', sha256: sha('mailed') })).body).toMatchObject({ duplicate: false });
        expect((await call({ ...SEP_UPLOAD, action: 'claim', token: 'attempt-0001' })).body).toMatchObject({ ok: true, duplicate: false });
    });
    it('the statement the worker really read: it takes its hold, then settling it fails, and the owner can still add that month by hand', async () => {
        let failing = true;
        const w = world([SEP_CYCLE], { settle: async (...args) => { if (failing) throw new Error('settle-down'); return settleStatement(...args); } });
        await w.run();
        expect(w.item(0).filed).not.toBe(true);
        expect([...w.data.keys()].filter(k => k.includes(REGISTRY) && w.data.get(k).via === 'email').length).toBeGreaterThan(0);      // the hold is really there
        expect(w.user().cconetime).toHaveLength(0);
        expect((await call({ ...SEP_UPLOAD, action: 'check' })).body).toMatchObject({ ok: true, duplicate: false });
        failing = false;                                                                                                    // and the email system, retrying, still files it
        w.data.set(`${MAIL}/items/s0`, { ...w.item(0), status: 'pending', retryAt: 0, leaseUntil: 0, leaseToken: '' }); await w.run();
        expect(w.item(0)).toMatchObject({ status: 'filed', filed: true });
        expect(w.user().cconetime.map(r => r.date).sort()).toEqual(['2026-09-18', '2026-09-27']);
    });
});

describe('every kind of record that really holds a statement counts', () => {
    const UP = { bank: 'Nations Trust Bank', last4: '376657XXXXX0276', periodText: '', dates: ['2026-10-06', '2026-10-11', '2026-10-19', '2026-10-30'], amounts: [1250, 4800.5, 310, 9990], rows: 4, sha256: sha('a-download') };
    const heldAs = (user, { status = 'filed' } = {}) => {
        const { path, identity } = emailFiled(NOV_ROWS);
        fs.data.set(path, { ...fs.data.get(path), status, filed: status === 'filed' });
        fs.data.set('users/u', { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], ...user });
        return { path, identity };
    };
    const stamp = (path, [date, amount], at) => ({ sourcePath: path, index: at, date, cents: Math.round(amount * 100), direction: 'debit' });
    it('rows the worker tied to entries the owner typed leave only stamps on those entries: the statement is still in the books', async () => {
        const path = `${MAIL}/items/nov`;
        heldAs({ expenses: NOV_ROWS.map(([date, amount], at) => ({ id: `m${at}`, date, amount, name: 'typed by hand', statementTwin: stamp(path, [date, amount], at) })) });
        const reply = (await call({ ...UP, action: 'check' })).body;
        expect(reply).toMatchObject({ duplicate: true, via: 'email' });
        expect(reply.detail).toMatch(/4 of 4 transactions are in your books/);
        // and the next cycle of the card is not blocked by them
        expect((await call({ ...upload(OCT_ROWS), action: 'check' })).body.duplicate).toBe(false);
    });
    it('a recurring entry keeps one stamp per month', async () => {
        const path = `${MAIL}/items/nov`;
        heldAs({ expenses: NOV_ROWS.map(([date, amount], at) => ({ id: `m${at}`, date: '2026-01-05', amount, recurring: true, statementTwins: { '2026-10': stamp(path, [date, amount], at) } })) });
        expect((await call({ ...UP, action: 'check' })).body).toMatchObject({ duplicate: true, via: 'email' });
        expect((await call({ ...upload(OCT_ROWS), action: 'check' })).body.duplicate).toBe(false);
    });
    it('instalment plans, cheques and subscription histories count by the day of the charge', async () => {
        const path = `${MAIL}/items/nov`;
        heldAs({ ccinstall: [{ id: 'i', date: '2026-06-01', startDate: '2026-10-06', amount: 1250, statementKey: path }], cheques: [{ id: 'q', date: '2026-10-01', clearedDate: '2026-10-11', amount: 4800.5, statementKey: path }],
            subscriptions: [{ id: 's', history: [{ date: '2026-10-19', amount: 310, statementKey: path }] }], loans: [{ id: 'l', date: '2026-10-30', amount: 9990, statementKey: path }] });
        const reply = (await call({ ...UP, action: 'check' })).body;
        expect(reply).toMatchObject({ duplicate: true, via: 'email' });
        expect(reply.detail).toMatch(/4 of 4 transactions are in your books/);
        expect((await call({ ...upload(OCT_ROWS), action: 'check' })).body.duplicate).toBe(false);
    });
});
