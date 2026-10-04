import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';
import handler from '../statement-guard.js';
import { runStatementSync, healMissingRows } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { REGISTRY } from '../statement-registry.mjs';

/* =============================================================================
 * A STATEMENT THE EMAIL SYSTEM FILED, WHOSE ROWS ARE MOSTLY NOT IN THE BOOKS, IS NOT "ALREADY ADDED".
 * The owner (2026-10-04, a screenshot): "DFCC Bank Statement - Jul 26.pdf · 7 transactions in your books — this statement is already in your books" for a statement
 * he could not find in the app, by email or by hand. The upload's first question is about the file's bytes; the email system had filed those very bytes, so the
 * answer was "yes", and ONE record of the statement in the books was enough to say it. The rows the books held were a fraction of the statement's: a device that had
 * not yet seen them pushed its own copy of the list over them (statement-sync.js healMissingRows), the ledger still said "filed", and the owner was locked out of both
 * doors. The ledger now says how much of the statement is really there, and "add it anyway" is always open to the owner.
 * ===========================================================================*/

const sha = text => createHash('sha256').update(text).digest('hex');
const owner = { uid: 'u', email: 'owner@example.com' };
const MAIL = 'wf-mail/owner_example_com';
const fake = makeFakeAdmin(); let fs, saved;
const call = async body => {
    let out; const res = { statusCode: 200, setHeader() {}, end(t) { out = { status: this.statusCode, body: JSON.parse(t) }; } };
    await handler({ method: 'POST', body, headers: { authorization: 'Bearer ok' } }, res); return out;
};
const ROWS = Array.from({ length: 12 }, (_, i) => [`${String(i + 2).padStart(2, '0')}/08/2026`, `SHOP NUMBER ${i + 1} COLOMBO`, 150 + i * 37.5, 'DR']);
const statement = rows => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 03/09/2026 Payment Due Date: 25/09/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${rows.map(([d, words, amount, side]) => `<tr><td>${d}</td><td>${words}</td><td>${amount.toFixed(2)} ${side}</td></tr>`).join('')}</table></body></html>`;
const FILE = statement(ROWS);
const iso = ([d]) => d.split('/').reverse().join('-');
const asked = (rows = ROWS) => ({ bank: 'Nations Trust Bank', last4: '376657XXXXX0276', periodText: '', dates: rows.map(iso), amounts: rows.map(r => r[2]), rows: rows.length, sha256: sha(FILE) });

let w;
beforeEach(async () => {
    saved = process.env.FIREBASE_SERVICE_ACCOUNT; process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
    fake.reset(); fake.setVerifier(async () => ({ uid: 'u', email: owner.email, email_verified: true }));
    const seed = { [MAIL]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] },
        [`${MAIL}/items/s0`]: { uid: 'u', bank: 'NTB', from: 'statements@nationstrust.com', filename: 'DFCC Bank Statement - Jul 26.pdf', messageId: 'm0', receivedMs: 1000, status: 'pending', cursor: 0, filed: false } };
    fs = createFirestore(seed);
    fake.admin.firestore = () => fs.db; _setAdminModule(fake.admin);
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = async () => ({ bytes: Buffer.from(FILE), filename: 'DFCC Bank Statement - Jul 26.pdf', contentSha256: sha(FILE) });
    w = { run: async () => { for (let i = 0; i < 12; i++) { const r = await runStatementSync({ action: 'drain', db: fs.db, owner, env: {}, f, read: readStatement, open: async () => [], settle: settleStatement, board: async () => null, loadAttachment, budgetMs: 20000 }); if (!r || !r.filed) break; } },
        item: () => fs.data.get(`${MAIL}/items/s0`), user: () => fs.data.get('users/u'),
        ledger: () => [...fs.data.keys()].filter(k => k.startsWith('users/u/statementLedger/')) };
    await w.run();
});
afterEach(() => { _setAdminModule(null); if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = saved; });

/** What a device that had not seen the statement does: its own copy of the lists goes over the server's, and only `keep` of the statement's records survive. */
const overwrite = keep => {
    const u = w.user(), kept = new Set(keep);
    const pick = list => (list || []).filter((r, i) => kept.has(r.date));
    fs.data.set('users/u', { ...u, expenses: pick(u.expenses), cconetime: pick(u.cconetime), incomeRecv: pick(u.incomeRecv), ccPayments: pick(u.ccPayments) });
};
const present = () => ['expenses', 'cconetime', 'incomeRecv', 'ccPayments'].reduce((n, k) => n + (w.user()[k] || []).length, 0);

describe('the worker really filed the whole statement (the starting point)', () => {
    it('all 12 rows are in the books, the item is filed, and the ledger has a row for each', () => {
        expect(w.item()).toMatchObject({ status: 'filed', filed: true });
        expect(present()).toBe(12);
        expect(w.ledger()).toHaveLength(12);
    });
    it('the same bytes by hand are turned away, saying how much of the statement is there', async () => {
        const reply = (await call({ action: 'check', sha256: sha(FILE) })).body;
        expect(reply).toMatchObject({ duplicate: true, via: 'email', canForce: true });
        expect(reply.detail).toMatch(/12 of its 12 rows are in your books/);
    });
});

describe('REPRODUCTION of the owner\'s screenshot: most of the filed rows are gone from the books', () => {
    beforeEach(() => overwrite(ROWS.slice(0, 3).map(iso)));              // 3 of 12 survive
    it('the file check does not turn the statement away for the 3 records that are left', async () => {
        expect(present()).toBe(3);
        expect((await call({ action: 'check', sha256: sha(FILE) })).body).toMatchObject({ ok: true, duplicate: false });
    });
    it('once the statement is read, the rows already in the books are named and the missing ones are for the owner to add', async () => {
        const reply = (await call({ ...asked(), action: 'check' })).body;
        expect(reply).toMatchObject({ ok: true, duplicate: false });
        expect(reply.have).toEqual([0, 1, 2]);
    });
    it('the claim at Save goes through, and the statement is then held by the upload', async () => {
        expect((await call({ ...asked(), action: 'claim', token: 'attempt-0001' })).body).toMatchObject({ ok: true, duplicate: false });
        // the upload's own records (ticked rows 3..11) join the books: now the statement is really there, and a copy is turned away
        const mine = ROWS.slice(3).map((r, at) => ({ id: `m${at}`, date: iso(r), amount: r[2], uploadClaim: 'attempt-0001', source: 'manual' }));
        fs.data.set('users/u', { ...w.user(), expenses: [...w.user().expenses, ...mine] });
        expect((await call({ ...asked(), sha256: sha('a-third-copy'), action: 'check' })).body).toMatchObject({ duplicate: true });
    });
    it('and the email system brings the lost rows back by itself (the heal window covers the statement)', async () => {
        const ledger = w.ledger();
        for (const key of ledger) fs.data.set(key, { ...fs.data.get(key), settledAt: Date.now() - 60 * 86400000 });
        expect(await healMissingRows({ db: fs.db, uid: 'u' })).toMatchObject({ requeued: 1, rows: 9 });
        await w.run();
        expect(present()).toBe(12);
        expect(w.item()).toMatchObject({ status: 'filed', filed: true });
    });
});

describe('a second email copy of a statement whose rows are lost', () => {
    it('is closed as a copy of the first, and the first one\'s rows come back once: no row is ever there twice', async () => {
        overwrite(ROWS.slice(0, 3).map(iso));
        expect(present()).toBe(3);
        fs.data.set(`${MAIL}/items/s1`, { uid: 'u', bank: 'NTB', from: 'statements@nationstrust.com', filename: 'DFCC Bank Statement - Jul 26 (copy).pdf', messageId: 'm1', receivedMs: 2000, status: 'pending', cursor: 0, filed: false });
        await w.run();
        expect(fs.data.get(`${MAIL}/items/s1`)).toMatchObject({ filed: true, duplicateOf: 's0' });
        for (const key of w.ledger()) fs.data.set(key, { ...fs.data.get(key), settledAt: Date.now() - 60 * 86400000 });
        expect(await healMissingRows({ db: fs.db, uid: 'u' })).toMatchObject({ requeued: 1, rows: 9 });
        await w.run();
        const keys = ['expenses', 'cconetime', 'incomeRecv', 'ccPayments'].flatMap(k => (w.user()[k] || []).map(r => `${r.date}|${r.amount}`));
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toHaveLength(12);
    });
});

describe('the heal reads the WHOLE ledger, not only its first 500 rows', () => {
    it('a statement whose rows sort after 500 other filed rows is still found, over the next runs', async () => {
        overwrite(ROWS.slice(0, 3).map(iso));
        const user = w.user(), filler = [];
        for (let i = 0; i < 520; i++) {
            const id = `!fill-${String(i).padStart(4, '0')}`;
            fs.data.set(`users/u/statementLedger/${id}`, { uid: 'u', status: 'filed', module: 'cconetime', sourcePath: `${MAIL}/items/other${i % 7}`, settledAt: Date.now() - 86400000 });
            filler.push({ id, date: '2026-01-01', amount: 1 });
        }
        fs.data.set('users/u', { ...user, cconetime: [...user.cconetime, ...filler] });
        for (const key of w.ledger().filter(k => !k.includes('!fill-'))) fs.data.set(key, { ...fs.data.get(key), settledAt: Date.now() - 60 * 86400000 });
        const mailRef = fs.db.doc(MAIL);
        expect(await healMissingRows({ db: fs.db, uid: 'u' })).toMatchObject({ requeued: 0 });                   // the first page alone never reaches it
        expect(await healMissingRows({ db: fs.db, uid: 'u', mailRef })).toMatchObject({ requeued: 0 });          // run 1: the first page, and where it stopped is remembered
        expect(fs.data.get(MAIL).rowHealAfter).toBeTruthy();
        expect(await healMissingRows({ db: fs.db, uid: 'u', mailRef })).toMatchObject({ requeued: 1, rows: 9 }); // run 2: the rest of the ledger
        expect(fs.data.get(MAIL).rowHealAfter).toBe('');                                                          // the walk starts over
        await w.run();
        expect(w.item()).toMatchObject({ status: 'filed', filed: true });
    });
});

describe('a statement whose rows were decided is done, however few records it left', () => {
    it('rows left out on purpose (transfers, dismissed lines) are decided, not lost: the same bytes are still turned away', async () => {
        const decided = w.ledger().slice(0, 6);
        for (const key of decided) fs.data.set(key, { ...fs.data.get(key), status: 'skipped', module: '', reason: 'decided-skip' });
        const gone = new Set(decided.map(key => key.split('/').pop()));
        const u = w.user();
        fs.data.set('users/u', { ...u, cconetime: u.cconetime.filter(r => !gone.has(r.id)), expenses: u.expenses.filter(r => !gone.has(r.id)) });
        expect(present()).toBe(6);
        expect((await call({ action: 'check', sha256: sha(FILE) })).body).toMatchObject({ duplicate: true, via: 'email' });
        expect((await call({ ...asked(), action: 'check' })).body).toMatchObject({ duplicate: true });
    });
    it('rows the owner deleted (a tombstone) are decided too', async () => {
        const u = w.user(), tomb = {};
        for (const store of ['cconetime', 'expenses']) for (const r of (u[store] || []).slice(0, 8)) (tomb[store] ||= {})[r.id] = Date.now();
        fs.data.set('users/u', { ...u, cconetime: u.cconetime.slice(8), expenses: (u.expenses || []).slice(8), _tomb: tomb });
        expect((await call({ action: 'check', sha256: sha(FILE) })).body).toMatchObject({ duplicate: true });
    });
});

describe('"add it anyway": the owner is never shut out', () => {
    it('a statement that really is in the books is added again only where it is missing: every row there is named', async () => {
        expect((await call({ ...asked(), action: 'check' })).body).toMatchObject({ duplicate: true });
        const forced = (await call({ ...asked(), action: 'check', force: true })).body;
        expect(forced).toMatchObject({ ok: true, duplicate: false });
        expect(forced.have).toEqual(ROWS.map((_, i) => i));
        expect((await call({ action: 'check', sha256: sha(FILE), force: true })).body).toMatchObject({ duplicate: false });
        expect((await call({ ...asked(), action: 'claim', token: 'attempt-0002', force: true })).body).toMatchObject({ ok: true, duplicate: false });
    });
    it('without the owner\'s word nothing changes (the flag is the owner\'s alone, and only the literal true counts)', async () => {
        for (const force of [false, 'true', 1, null]) expect((await call({ ...asked(), action: 'check', force })).body).toMatchObject({ duplicate: true });
    });
    it('a statement the email system is adding this minute is not added over it', async () => {
        w.item(); fs.data.set(`${MAIL}/items/s0`, { ...w.item(), status: 'processing', filed: false, leaseUntil: Date.now() + 60_000, leaseToken: 'worker' });
        const reply = (await call({ ...asked(), action: 'check', force: true })).body;
        expect(reply).toMatchObject({ duplicate: true });
        expect(reply.canForce).toBe(false);
    });
    it('every override is in the platform log, with counts only', async () => {
        const lines = []; const real = console.info; console.info = line => { lines.push(String(line)); };
        try { await call({ ...asked(), action: 'check', force: true }); await call({ ...asked(), action: 'check' }); } finally { console.info = real; }
        const guards = lines.filter(l => l.includes('"statement-guard"')).map(l => JSON.parse(l));
        expect(guards.map(g => g.verdict)).toEqual(['override', 'duplicate']);
        expect(guards[1]).toMatchObject({ kind: 'file', why: 'in-books', ledgerRows: 12, ledgerLost: 0 });   // the file's bytes were the question: no rows were compared
        expect(JSON.stringify(guards)).not.toMatch(/SHOP|DFCC|0276|150\.00/);
    });
});

describe('the registry still holds nothing that is not there', () => {
    it('the lookups above never left a hold for a statement that was let through', async () => {
        overwrite(ROWS.slice(0, 3).map(iso));
        await call({ ...asked(), action: 'check' });
        const holds = [...fs.data.keys()].filter(k => k.includes(REGISTRY));
        expect(holds.every(k => fs.data.get(k).via === 'email')).toBe(true);
    });
});
