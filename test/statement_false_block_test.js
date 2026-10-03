import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';
import handler from '../statement-guard.js';
import { runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { identityOf, claimStatement, peekStatement, VIA, REGISTRY } from '../statement-registry.mjs';

/* =============================================================================
 * "ALREADY ADDED" MUST BE TRUE. The owner reported manual uploads turned away as "Already Added via Email Sync" for statements the email
 * system never put in the books. The lock is a registry hold written BEFORE a statement's rows are filed, so a hold can outlive what it
 * held: a statement that failed, went to review, was filed and then deleted by the owner, or was reviewed on the phone with nothing
 * ticked still held its month and its file. These tests simulate each life a statement can have and ask the real endpoint what it
 * says about it — plus the identity collisions that can make two DIFFERENT statements look like one.
 * ===========================================================================*/

const sha = text => createHash('sha256').update(text).digest('hex');
const owner = { uid: 'u', email: 'owner@example.com' };
const MAIL = 'wf-mail/owner_example_com';
const HOUR = 3600_000;
const RECENT = Date.now() - 1000, OLD = Date.now() - HOUR;

const fake = makeFakeAdmin(); let fs, saved;
const call = async (body, headers = { authorization: 'Bearer ok' }) => {
    let out; const res = { statusCode: 200, setHeader() {}, end(t) { out = { status: this.statusCode, body: JSON.parse(t) }; } };
    await handler({ method: 'POST', body, headers }, res); return out;
};
beforeEach(() => {
    saved = process.env.FIREBASE_SERVICE_ACCOUNT; process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
    fake.reset(); fake.setVerifier(async () => ({ uid: 'u', email: owner.email, email_verified: true }));
    fs = createFirestore({ [MAIL]: { uid: 'u' }, 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] } });
    fake.admin.firestore = () => fs.db; _setAdminModule(fake.admin);
});
afterEach(() => { _setAdminModule(null); if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = saved; });

/* the statement the owner is uploading: NTB card ..0276, September 2026 */
const SEPT_DATES = ['2026-09-02', '2026-09-09', '2026-09-14', '2026-09-15'];
const upload = { bank: 'Nations Trust Bank', last4: 'XXXX0276', periodText: '17/08/2026 - 16/09/2026', dates: SEPT_DATES, rows: 4, sha256: sha('the-owners-pdf') };
const septIdentity = identityOf({ bank: 'NTB', account: '0276', dates: SEPT_DATES });
const item = (id, extra = {}) => fs.data.set(`${MAIL}/items/${id}`, { uid: 'u', bank: 'NTB', status: 'pending', filed: false, cursor: 0, leaseUntil: 0, ...extra });
/* what the email worker holds the moment it starts a statement (door 'worker'); `now` ages the hold */
const hold = (id, { now = OLD, door = 'worker', identity = septIdentity, bytes = 'mailed-pdf', rows = 4 } = {}) =>
    claimStatement({ db: fs.db, uid: 'u', via: VIA.EMAIL, ref: `${MAIL}/items/${id}`, identity, sha: sha(bytes), meta: { filename: 'AMEX_Statement.pdf', rows, door }, now });
const books = (extra = {}) => fs.data.set('users/u', { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], ...extra });
const registry = () => [...fs.data.keys()].filter(k => k.startsWith(`users/u/${REGISTRY}/`));

describe('a hold with nothing behind it does not turn the owner away', () => {
    it('the worker started the statement, then it failed and is waiting for its next try: the owner may add it by hand', async () => {
        item('a', { status: 'pending', retryAt: Date.now() + 60_000, retryCount: 2 });
        await hold('a');
        expect((await call({ ...upload, action: 'check' })).body).toMatchObject({ ok: true, duplicate: false });
        expect((await call({ action: 'check', sha256: sha('mailed-pdf') })).body).toMatchObject({ duplicate: false });
    });
    it('the statement went to the owner for review with nothing filed (needs_review / dead_letter): not "already added"', async () => {
        item('a', { status: 'needs_review', hasReview: true, reviewReason: 'statement-layout-or-reconciliation-needs-review' });
        await hold('a');
        expect((await call({ ...upload, action: 'check' })).body.duplicate).toBe(false);
        fs.data.set(`${MAIL}/items/a`, { ...fs.data.get(`${MAIL}/items/a`), status: 'dead_letter', hasReview: false });
        expect((await call({ ...upload, sha256: sha('another-copy'), action: 'check' })).body.duplicate).toBe(false);
    });
    it('the email statement was filed, then the owner deleted its records: its month and file are free', async () => {
        item('a', { status: 'filed', filed: true, cursor: 4, totalRows: 4, contentSha256: sha('mailed-pdf') });
        await hold('a');
        const reply = (await call({ ...upload, action: 'check' })).body;
        expect(reply).toMatchObject({ ok: true, duplicate: false });
        // the legacy twin check (an item filed before the registry, found by its bytes) says the same
        expect((await call({ action: 'check', sha256: sha('mailed-pdf') })).body.duplicate).toBe(false);
        expect((await call({ ...upload, action: 'claim', token: 'attempt-0001' })).body).toMatchObject({ duplicate: false });
        // and the month now belongs to the upload
        expect((await call({ ...upload, sha256: sha('third'), action: 'check' })).body).toMatchObject({ duplicate: true, via: 'upload' });
    });
    it('a statement filed before the registry existed whose records are gone is not a twin either', async () => {
        item('old', { status: 'filed', filed: true, contentSha256: sha('pre-registry-pdf') });
        expect((await call({ action: 'check', sha256: sha('pre-registry-pdf') })).body.duplicate).toBe(false);
    });
    it('the item was removed from the mailbox: its hold holds nothing', async () => {
        await hold('gone');
        expect((await call({ ...upload, action: 'check' })).body.duplicate).toBe(false);
    });
    it('reviewed on the phone with nothing ticked (marked filed, no records) frees the statement — after the grace for an unsynced phone', async () => {
        item('p', { status: 'pending', filed: true, filedMs: RECENT });
        await hold('p', { door: 'phone', now: RECENT });
        expect((await call({ ...upload, action: 'check' })).body).toMatchObject({ duplicate: true, via: 'email' });     // the phone may not have synced its records yet
        for (const key of registry()) fs.data.set(key, { ...fs.data.get(key), createdAt: OLD });                          // an hour on
        expect((await call({ ...upload, action: 'check' })).body.duplicate).toBe(false);
    });
});

describe('a hold with the statement really behind it still turns the owner away — and says what is there', () => {
    it('records the worker filed carry the item path: "Already Added via Email Sync", naming month and count', async () => {
        item('a', { status: 'filed', filed: true, cursor: 4, totalRows: 4 });
        await hold('a');
        books({ cconetime: [{ id: 'c1', statementKey: `${MAIL}/items/a`, amount: 10, date: '2026-09-14' }], ccPayments: [{ id: 'p1', statementKey: `${MAIL}/items/a`, amount: 50, date: '2026-09-15' }] });
        const reply = (await call({ ...upload, action: 'check' })).body;
        expect(reply).toMatchObject({ duplicate: true, via: 'email', notice: 'Already Added via Email Sync' });
        expect(reply.detail).toMatch(/Sep 2026/); expect(reply.detail).toMatch(/2 transactions in your books/);
        expect(reply.ref).toBeUndefined(); expect(JSON.stringify(reply)).not.toContain('wf-mail');
    });
    it('records the phone filed carry the item id: the same', async () => {
        item('p', { status: 'pending', filed: true, filedMs: OLD });
        await hold('p', { door: 'phone', now: OLD });
        books({ expenses: [{ id: 'e1', statementKey: 'p', amount: 10, date: '2026-09-14' }] });
        expect((await call({ ...upload, action: 'check' })).body).toMatchObject({ duplicate: true, via: 'email' });
    });
    it('a record of a subscription history, a card instalment plan or a cheque counts too', async () => {
        item('a', { status: 'filed', filed: true });
        await hold('a');
        books({ subscriptions: [{ id: 's', history: [{ date: '2026-09-02', statementKey: `${MAIL}/items/a` }] }] });
        expect((await call({ ...upload, action: 'check' })).body.duplicate).toBe(true);
        books({ ccinstall: [{ id: 'i', payments: [{ statementKey: `${MAIL}/items/a` }] }] });
        expect((await call({ ...upload, action: 'check' })).body.duplicate).toBe(true);
        books({ cheques: [{ id: 'q', statementKey: `${MAIL}/items/a` }] });
        expect((await call({ ...upload, action: 'check' })).body.duplicate).toBe(true);
    });
    it('a statement the worker is working on this minute, or has part-way through, is being added: not free', async () => {
        item('a', { status: 'processing', leaseUntil: Date.now() + 30_000 });
        await hold('a');
        expect((await call({ ...upload, action: 'check' })).body).toMatchObject({ duplicate: true, via: 'email' });
        expect((await call({ ...upload, action: 'check' })).body.detail).toMatch(/being added right now/);
        item('a', { status: 'pending', cursor: 10, totalRows: 40, leaseUntil: 0 });
        expect((await call({ ...upload, action: 'check' })).body.duplicate).toBe(true);
        item('a', { status: 'dead_letter', cursor: 10, totalRows: 40, leaseUntil: 0 });      // parked with its place kept, and re-driven
        expect((await call({ ...upload, action: 'check' })).body.duplicate).toBe(true);
    });
    it('a hand upload: held while its records exist (however old), held while younger than ten minutes, free once old and empty', async () => {
        await call({ ...upload, action: 'claim', token: 'attempt-0001' });
        const key = `users/u/${REGISTRY}/${septIdentity.id}`, other = { ...upload, sha256: sha('again'), action: 'check' };
        const age = ms => fs.data.set(key, { ...fs.data.get(key), createdAt: Date.now() - ms });
        age(HOUR); books({ expenses: [{ id: 'e', uploadClaim: 'attempt-0001' }] });
        expect((await call(other)).body).toMatchObject({ duplicate: true, via: 'upload', notice: 'Already Added via Manual Upload' });
        books(); age(5000);
        expect((await call(other)).body.duplicate).toBe(true);
        age(HOUR);
        expect((await call(other)).body.duplicate).toBe(false);
    });
});

describe('two DIFFERENT statements are not one', () => {
    it('the next billing cycle that happens to close in the same calendar month is not a copy of the last', async () => {
        // cycle 4 Aug - 3 Sep ends with its last purchase on 1 Sep; the cycle 4 Sep - 3 Oct is read as September too when its last purchase is on 28 Sep? No: its dates are different days
        const first = identityOf({ bank: 'NTB', account: '0276', dates: ['2026-08-05', '2026-08-20', '2026-09-01'] });
        const second = identityOf({ bank: 'NTB', account: '0276', dates: ['2026-09-05', '2026-09-12', '2026-09-28'] });
        expect(first.id).toBe(second.id);                                                  // the month alone cannot tell them apart
        item('a', { status: 'filed', filed: true });
        await claimStatement({ db: fs.db, uid: 'u', via: VIA.EMAIL, ref: `${MAIL}/items/a`, identity: first, sha: sha('cycle-one'), meta: { rows: 3, door: 'worker' }, now: OLD });
        books({ cconetime: [{ id: 'c', statementKey: `${MAIL}/items/a` }] });
        const next = { bank: 'NTB', last4: '0276', dates: ['2026-09-05', '2026-09-12', '2026-09-28'], rows: 3, sha256: sha('cycle-two') };
        expect((await call({ ...next, action: 'check' })).body.duplicate).toBe(false);
        expect((await call({ ...next, action: 'claim', token: 'attempt-0001' })).body.duplicate).toBe(false);
        // and it is held for what it is: its own file, though not the month the first one already holds
        expect((await call({ action: 'check', sha256: sha('cycle-two') })).body).toMatchObject({ duplicate: true, via: 'upload' });
        expect(registry()).toHaveLength(3);
    });
    it('a statement of several months or several accounts is not a copy of one month it contains', async () => {
        item('a', { status: 'filed', filed: true });
        await hold('a', { rows: 4 });
        books({ cconetime: [{ id: 'c', statementKey: `${MAIL}/items/a` }] });
        const quarter = { ...upload, rows: 60, sha256: sha('three-months'), dates: ['2026-07-03', '2026-07-19', '2026-08-02', '2026-08-30', '2026-09-02', '2026-09-09', '2026-09-14', '2026-09-15'] };
        expect((await call({ ...quarter, action: 'check' })).body.duplicate).toBe(false);
    });
    it('the same statement in other bytes — even read a little differently — is still the same statement', async () => {
        item('a', { status: 'filed', filed: true });
        await hold('a', { rows: 4 });
        books({ cconetime: [{ id: 'c', statementKey: `${MAIL}/items/a` }] });
        expect((await call({ ...upload, sha256: sha('re-downloaded'), action: 'check' })).body).toMatchObject({ duplicate: true, via: 'email', kind: 'period' });
        const partial = { ...upload, sha256: sha('photo-of-it'), dates: ['2026-09-14', '2026-09-15'], rows: 2 };
        expect((await call({ ...partial, action: 'check' })).body.duplicate).toBe(true);
        const padded = { ...upload, sha256: sha('with-summary-lines'), rows: 6 };
        expect((await call({ ...padded, action: 'check' })).body.duplicate).toBe(true);
    });
    it('a hold from before this rule, with no dates or count on it, is judged as it always was', async () => {
        item('a', { status: 'filed', filed: true });
        await hold('a');
        const key = `users/u/${REGISTRY}/${septIdentity.id}`, { days, rows, ...bare } = fs.data.get(key);
        fs.data.set(key, bare);
        books({ cconetime: [{ id: 'c', statementKey: `${MAIL}/items/a` }] });
        expect((await call({ ...upload, sha256: sha('x'), dates: ['2026-09-30'], rows: 90, action: 'check' })).body.duplicate).toBe(true);
    });
});

/* ── every life a holder can be in, against one rule ───────────────────────────────────────────────────────────────── */
describe('every state a holder can be in', () => {
    const states = {                                   // what the mailbox item looks like in each life of a statement
        missing: null,
        'pending, first row not reached': { status: 'pending', cursor: 0, retryAt: Date.now() + 60_000 },
        'pending, part-way': { status: 'pending', cursor: 12, totalRows: 40 },
        'working this minute': { status: 'processing', leaseUntil: Date.now() + 30_000 },
        'lease expired, first row not reached': { status: 'processing', cursor: 0, leaseUntil: Date.now() - 1000 },
        'in review': { status: 'needs_review', hasReview: true },
        'dead letter, first row not reached': { status: 'dead_letter', cursor: 0 },
        'dead letter, part-way': { status: 'dead_letter', cursor: 12 },
        filed: { status: 'filed', filed: true, cursor: 4, totalRows: 4 },
        'rejected': { status: 'rejected_unapproved_sender' },
    };
    const working = name => ['pending, part-way', 'working this minute', 'dead letter, part-way'].includes(name);
    for (const door of ['worker', 'phone']) for (const [name, shape] of Object.entries(states)) for (const records of [true, false]) for (const fresh of [true, false]) {
        it(`${door} hold · ${name} · ${records ? 'records in the books' : 'no records'} · ${fresh ? 'just taken' : 'an hour old'}: believed exactly when something is behind it`, async () => {
            if (shape) item('h', shape);
            await hold('h', { door, now: fresh ? Date.now() - 1000 : OLD });
            books(records ? { expenses: [{ id: 'e', statementKey: door === 'phone' ? 'h' : `${MAIL}/items/h` }] } : {});
            const believed = records || (shape && working(name)) || (door === 'phone' && fresh);
            expect((await call({ ...upload, action: 'check' })).body.duplicate, 'check').toBe(!!believed);
            expect(registry().length > 0, 'a hold nothing is behind is given back; a believed one stays').toBe(!!believed);
        });
    }
    for (const records of [true, false]) for (const fresh of [true, false]) {
        it(`hand upload hold · ${records ? 'records carry its token' : 'no records'} · ${fresh ? 'just taken' : 'an hour old'}`, async () => {
            await call({ ...upload, action: 'claim', token: 'attempt-0001' });
            const key = `users/u/${REGISTRY}/${septIdentity.id}`;
            fs.data.set(key, { ...fs.data.get(key), createdAt: fresh ? Date.now() - 1000 : OLD });
            books(records ? { expenses: [{ id: 'e', uploadClaim: 'attempt-0001' }] } : {});
            expect((await call({ ...upload, sha256: sha('again'), action: 'check' })).body.duplicate).toBe(records || fresh);
        });
    }
});

/* ── the real worker, both ways ─────────────────────────────────────────────────────────────────────────────────── */
const html = (variant = 0, day = '14/09/2026') => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 16/09/2026 Payment Due Date: 10/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>${day}</td><td>KEELLS STORE</td><td>${(123.45 + variant).toFixed(2)} DR</td></tr><tr><td>15/09/2026</td><td>PAYMENT THANK YOU</td><td>${(50 + variant).toFixed(2)} CR</td></tr></table></body></html>`;
function world(sources, { failSettle = () => false } = {}) {
    const seed = { [MAIL]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] }, 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] } };
    sources.forEach((s, i) => { seed[`${MAIL}/items/s${i}`] = { uid: 'u', bank: 'NTB', from: 'statements@nationstrust.com', filename: 'AMEX_Statement.html', messageId: `m${i}`, receivedMs: 1000 + i, status: 'pending', cursor: 0, filed: false }; });
    const w = createFirestore(seed);
    fs = w; fake.admin.firestore = () => w.db;                                // the endpoint and the worker see ONE database
    const loadAttachment = async source => { const body = sources[Number(source.messageId.slice(1))].html; return { bytes: Buffer.from(body), filename: 'AMEX_Statement.html', contentSha256: sha(body) }; };
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const settle = async (...args) => { if (failSettle()) throw new Error('the database blinked'); return settleStatement(...args); };
    const run = async () => { for (let i = 0; i < 12; i++) { const r = await runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f, read: readStatement, open: async () => [], settle, board: async () => null, loadAttachment, budgetMs: 20000 }); if (!r || !r.filed) break; } };
    return { db: w.db, data: w.data, run, item: i => w.data.get(`${MAIL}/items/s${i}`), user: () => w.data.get('users/u') };
}

describe('through the real worker', () => {
    it('a statement the worker took and then failed on holds nothing the owner cannot override', async () => {
        let fail = true;
        const w = world([{ html: html(0) }], { failSettle: () => fail });
        await w.run();
        expect(w.item(0).filed).toBe(false); expect(w.user().cconetime).toHaveLength(0);
        expect(registry().length).toBeGreaterThan(0);                                     // the hold the failed attempt left behind
        const mine = { bank: 'Nations Trust Bank', last4: '376657XXXXX0276', dates: ['2026-09-14', '2026-09-15'], rows: 2, periodText: '' };
        expect((await call({ ...mine, action: 'check' })).body).toMatchObject({ ok: true, duplicate: false });
        expect((await call({ action: 'check', sha256: sha(html(0)) })).body.duplicate).toBe(false);
        // the worker's own next try is unharmed: it files the statement once
        fail = false; w.data.set(`${MAIL}/items/s0`, { ...w.item(0), retryAt: 0 }); await w.run();             // its back-off has passed
        expect(w.item(0)).toMatchObject({ status: 'filed', filed: true }); expect(w.item(0).duplicateOf).toBeUndefined();
        expect(w.user().cconetime).toHaveLength(1); expect(w.user().ccPayments).toHaveLength(1);
    });
    it('what the worker filed turns a manual upload away; the owner deleting it frees the month; the later email is then held by the upload', async () => {
        const w = world([{ html: html(0) }, { html: html(1) }]);
        fs.data.set(`${MAIL}/items/s1`, { ...fs.data.get(`${MAIL}/items/s1`), status: 'rejected_non_statement' });      // only the first is swept now
        await w.run();
        expect(w.user().cconetime).toHaveLength(1);
        const mine = { bank: 'Nations Trust Bank', last4: '376657XXXXX0276', dates: ['2026-09-14', '2026-09-15'], rows: 2 };
        const blocked = (await call({ ...mine, sha256: sha('the-owners-copy'), action: 'check' })).body;
        expect(blocked).toMatchObject({ duplicate: true, via: 'email', notice: 'Already Added via Email Sync' });
        expect(blocked.detail).toMatch(/2 transactions in your books/);
        // the owner deletes the statement's records on the device and the books sync
        w.data.set('users/u', { ...w.user(), cconetime: [], ccPayments: [] });
        expect((await call({ ...mine, sha256: sha('the-owners-copy'), action: 'claim', token: 'attempt-0001' })).body).toMatchObject({ duplicate: false });
        // the same statement then arrives by email again, in other bytes: the upload is its holder now
        w.data.set(`${MAIL}/items/s1`, { ...w.data.get(`${MAIL}/items/s1`), status: 'pending' });
        w.data.set('users/u', { ...w.user(), expenses: [{ id: 'e', uploadClaim: 'attempt-0001' }] });
        await w.run();
        expect(w.item(1)).toMatchObject({ filed: true, duplicateOf: 'registry:upload' });
    });
    it('an owner upload with no records left (deleted) does not block the email sweep of the same month', async () => {
        const w = world([{ html: html(0) }]);
        const mine = { bank: 'Nations Trust Bank', last4: '376657XXXXX0276', dates: ['2026-09-14', '2026-09-15'], rows: 2, sha256: sha('the-owners-copy') };
        await call({ ...mine, action: 'claim', token: 'attempt-0001' });
        const key = [...registry()].find(k => w.data.get(k).via === 'upload');
        for (const k of registry()) w.data.set(k, { ...w.data.get(k), createdAt: OLD });
        await w.run();                                                                    // no record carries 'attempt-0001': the upload holds nothing
        expect(w.item(0)).toMatchObject({ status: 'filed', filed: true }); expect(w.item(0).duplicateOf).toBeUndefined();
        expect(w.user().cconetime).toHaveLength(1);
        expect(key).toBeTruthy();
    });
    it('an owner upload whose records exist DOES hold the email sweep (the original rule is intact)', async () => {
        const w = world([{ html: html(0) }]);
        const mine = { bank: 'Nations Trust Bank', last4: '376657XXXXX0276', dates: ['2026-09-14', '2026-09-15'], rows: 2, sha256: sha('the-owners-copy') };
        await call({ ...mine, action: 'claim', token: 'attempt-0001' });
        for (const k of registry()) w.data.set(k, { ...w.data.get(k), createdAt: OLD });
        w.data.set('users/u', { ...w.user(), expenses: [{ id: 'e', uploadClaim: 'attempt-0001' }] });
        await w.run();
        expect(w.item(0)).toMatchObject({ filed: true, duplicateOf: 'registry:upload', blockedBy: 'period' });
        expect(w.user().cconetime).toHaveLength(0);
    });
});

describe('the lock itself', () => {
    it('peek and claim agree on what is a different statement', async () => {
        const first = identityOf({ bank: 'NTB', account: '0276', dates: ['2026-08-05', '2026-09-01'] });
        const second = identityOf({ bank: 'NTB', account: '0276', dates: ['2026-09-05', '2026-09-28'] });
        await claimStatement({ db: fs.db, uid: 'u', via: VIA.EMAIL, ref: 'e1', identity: first, sha: sha('one'), meta: { rows: 2 } });
        expect(await peekStatement({ db: fs.db, uid: 'u', identity: second, sha: sha('two'), ref: 'x', rows: 2 })).toEqual({ duplicate: false });
        expect(await peekStatement({ db: fs.db, uid: 'u', identity: first, sha: sha('three'), ref: 'x', rows: 2 })).toMatchObject({ duplicate: true, kind: 'period' });
        expect(await claimStatement({ db: fs.db, uid: 'u', via: VIA.UPLOAD, ref: 'upload:t', identity: second, sha: sha('two'), meta: { rows: 2 } })).toMatchObject({ ok: true });
    });
});
