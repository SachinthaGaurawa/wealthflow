import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';
import handler from '../statement-guard.js';
import { runStatementSync, unfileStatement } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { accountOf, statementMonthOf, monthOfDate, identityOf, fileIdOf, claimStatement, peekStatement, releaseStatement, noticeFor, VIA, REGISTRY } from '../statement-registry.mjs';

/* =============================================================================
 * ONE STATEMENT, ADDED ONCE — whichever door it comes through first (statement-registry.mjs).
 * The lock is a deterministic document id written in a transaction; these tests drive both doors in both orders, through the real
 * email worker and the real upload endpoint, plus re-sends, and the one thing that must NOT be blocked: another month of the same account.
 * ===========================================================================*/

const sha = text => createHash('sha256').update(text).digest('hex');
const owner = { uid: 'u', email: 'owner@example.com' };
const MAIL = 'wf-mail/owner_example_com';

describe('the composite identity', () => {
    it('keeps the last four digits of whatever mask the bank used', () => {
        for (const raw of ['376657XXXXX0276', 'XXXX-0276', '****0276', '0276', 'A/C 001-234-0276', 276 + '']) expect(accountOf(raw), raw).toBe(raw === '276' ? '276' : '0276');
        expect(accountOf('')).toBe(''); expect(accountOf(null)).toBe(''); expect(accountOf('XXXX')).toBe('');
    });
    it('reads a date however the statement writes it', () => {
        expect(monthOfDate('2026-03-14')).toEqual({ year: 2026, month: 3 });
        expect(monthOfDate('14/03/2026')).toEqual({ year: 2026, month: 3 });
        expect(monthOfDate('14 Mar 2026')).toEqual({ year: 2026, month: 3 });
        for (const bad of ['', 'garbage', '2026-13-01', '99/99/2026', null]) expect(monthOfDate(bad), String(bad)).toBeNull();
    });
    it('a statement belongs to the month it closes in: the stated period end, else the latest transaction', () => {
        expect(statementMonthOf({ periodText: '15/02/2026 - 14/03/2026' })).toEqual({ year: 2026, month: 3 });
        expect(statementMonthOf({ periodText: '01/03/2026-31/03/2026' })).toEqual({ year: 2026, month: 3 });
        expect(statementMonthOf({ dates: ['2026-02-20', '2026-03-10', '2026-02-28'] })).toEqual({ year: 2026, month: 3 });
        expect(statementMonthOf({ periodText: 'nonsense', dates: ['2026-12-31'] })).toEqual({ year: 2026, month: 12 });
        expect(statementMonthOf({})).toBeNull();
    });
    it('one bank however it is labelled, one account however it is masked, one month however it is dated — the same id', () => {
        const a = identityOf({ bank: 'NTB', account: '376657XXXXX0276', dates: ['2026-09-14'] });
        const b = identityOf({ bank: 'Nations Trust Bank', account: '****0276', periodText: '17/08/2026 - 16/09/2026' });
        expect(a.ok && b.ok).toBe(true); expect(a.id).toBe(b.id); expect(a.id).toMatch(/^[0-9a-f]{64}$/);
    });
    it('another month, another account, or another bank is another identity', () => {
        const base = { bank: 'NTB', account: '0276', dates: ['2026-09-14'] };
        const ids = new Set([identityOf(base).id, identityOf({ ...base, dates: ['2026-10-14'] }).id, identityOf({ ...base, dates: ['2027-09-14'] }).id, identityOf({ ...base, account: '0277' }).id, identityOf({ ...base, bank: 'HNB' }).id]);
        expect(ids.size).toBe(5);
    });
    it('says what is missing instead of inventing an identity', () => {
        expect(identityOf({ bank: '', account: '0276', dates: ['2026-09-14'] })).toMatchObject({ ok: false, reason: 'no-bank', id: '' });
        expect(identityOf({ bank: 'NTB', account: '', dates: ['2026-09-14'] })).toMatchObject({ ok: false, reason: 'no-account' });
        expect(identityOf({ bank: 'NTB', account: '0276', dates: [] })).toMatchObject({ ok: false, reason: 'no-period' });
    });
    it('the owner is told which door was first', () => {
        expect(noticeFor(VIA.EMAIL)).toBe('Already Added via Email Sync');
        expect(noticeFor(VIA.UPLOAD)).toBe('Already Added via Manual Upload');
    });
});

describe('the lock', () => {
    const identity = identityOf({ bank: 'NTB', account: '0276', dates: ['2026-09-14'] });
    const A = sha('file-a'), B = sha('file-b');
    it('the first door in wins and the second is told who it was; the same holder may take it again', async () => {
        const { db } = createFirestore();
        expect(await claimStatement({ db, uid: 'u', via: VIA.EMAIL, ref: 'wf-mail/x/items/1', identity, sha: A })).toMatchObject({ ok: true, claimed: expect.any(Array) });
        const second = await claimStatement({ db, uid: 'u', via: VIA.UPLOAD, ref: 'upload:t1', identity, sha: B });
        expect(second).toMatchObject({ ok: false, duplicate: true, kind: 'period', existing: { via: 'email' } });
        expect(await claimStatement({ db, uid: 'u', via: VIA.EMAIL, ref: 'wf-mail/x/items/1', identity, sha: A })).toMatchObject({ ok: true });
    });
    it('the exact file is held even where its period cannot be read', async () => {
        const { db } = createFirestore();
        await claimStatement({ db, uid: 'u', via: VIA.UPLOAD, ref: 'upload:t1', identity: { ok: false }, sha: A });
        expect(await claimStatement({ db, uid: 'u', via: VIA.EMAIL, ref: 'p', identity: { ok: false }, sha: A })).toMatchObject({ ok: false, kind: 'file', existing: { via: 'upload' } });
        expect(await claimStatement({ db, uid: 'u', via: VIA.EMAIL, ref: 'p', identity: { ok: false }, sha: B })).toMatchObject({ ok: true });
    });
    it('a different month of the same account is not blocked', async () => {
        const { db } = createFirestore();
        await claimStatement({ db, uid: 'u', via: VIA.EMAIL, ref: 'e1', identity, sha: A });
        const october = identityOf({ bank: 'NTB', account: '0276', dates: ['2026-10-14'] });
        expect(await claimStatement({ db, uid: 'u', via: VIA.UPLOAD, ref: 'upload:t', identity: october, sha: B })).toMatchObject({ ok: true });
    });
    it("one owner's statements never block another's", async () => {
        const { db } = createFirestore();
        await claimStatement({ db, uid: 'u', via: VIA.EMAIL, ref: 'e1', identity, sha: A });
        expect(await claimStatement({ db, uid: 'someone-else', via: VIA.UPLOAD, ref: 'upload:t', identity, sha: A })).toMatchObject({ ok: true });
    });
    it('peek never takes anything, and release gives it back', async () => {
        const { db } = createFirestore();
        expect(await peekStatement({ db, uid: 'u', identity, sha: A })).toEqual({ duplicate: false });
        expect(await peekStatement({ db, uid: 'u', identity, sha: A })).toEqual({ duplicate: false });
        await claimStatement({ db, uid: 'u', via: VIA.EMAIL, ref: 'e1', identity, sha: A });
        expect(await peekStatement({ db, uid: 'u', identity, sha: B })).toMatchObject({ duplicate: true, kind: 'period' });
        expect(await peekStatement({ db, uid: 'u', identity: null, sha: A })).toMatchObject({ duplicate: true, kind: 'file' });
        expect(await releaseStatement({ db, uid: 'u', ref: 'e1' })).toBe(2);
        expect(await peekStatement({ db, uid: 'u', identity, sha: A })).toEqual({ duplicate: false });
    });
    it('refuses a claim that names no door or no holder', async () => {
        const { db } = createFirestore();
        await expect(claimStatement({ db, uid: 'u', via: 'carrier-pigeon', ref: 'x', identity })).rejects.toThrow('invalid-statement-claim');
        await expect(claimStatement({ db, uid: 'u', via: VIA.EMAIL, ref: '', identity })).rejects.toThrow('invalid-statement-claim');
        expect(fileIdOf('nope')).toBe('');
    });
});

/* ── the upload door: the real endpoint ───────────────────────────────────────────────────────────────────────────── */
describe('the upload door (POST /api/statement-guard)', () => {
    const fake = makeFakeAdmin(); let fs, saved;
    const call = async (body, headers = { authorization: 'Bearer ok' }, method = 'POST') => {
        let out; const res = { statusCode: 200, setHeader() {}, end(t) { out = { status: this.statusCode, body: JSON.parse(t) }; } };
        await handler({ method, body, headers }, res); return out;
    };
    beforeEach(() => {
        saved = process.env.FIREBASE_SERVICE_ACCOUNT; process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
        fake.reset(); fake.setVerifier(async () => ({ uid: 'u', email: owner.email, email_verified: true }));
        fs = createFirestore({ [MAIL]: { uid: 'u' } }); fake.admin.firestore = () => fs.db; _setAdminModule(fake.admin);
    });
    afterEach(() => { _setAdminModule(null); if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = saved; });
    const stmt = { bank: 'Nations Trust Bank', last4: 'XXXX0276', periodText: '17/08/2026 - 16/09/2026', sha256: sha('upload-1') };

    it('needs a verified sign-in, a POST, and something to check', async () => {
        expect((await call(stmt, {})).status).toBe(401);
        expect((await call(stmt, undefined, 'GET')).status).toBe(405);
        expect((await call({ action: 'check' })).status).toBe(400);
        expect((await call({ ...stmt, action: 'claim' })).body.reason).toBe('token-required');
        expect((await call({ ...stmt, action: 'nope' })).status).toBe(400);
    });
    it('UPLOAD FIRST: a first upload is taken; the same file again, or the same month from other bytes, is "Already Added via Manual Upload"', async () => {
        expect((await call({ ...stmt, action: 'check' })).body).toMatchObject({ ok: true, duplicate: false });
        expect((await call({ ...stmt, action: 'claim', token: 'attempt-0001' })).body).toMatchObject({ duplicate: false, identified: true });
        // the owner picks the same file again
        expect((await call({ action: 'check', sha256: stmt.sha256 })).body).toMatchObject({ duplicate: true, via: 'upload', notice: 'Already Added via Manual Upload' });
        // a re-downloaded copy of the statement: other bytes, same bank + account + month
        expect((await call({ ...stmt, sha256: sha('re-downloaded'), action: 'check' })).body).toMatchObject({ duplicate: true, via: 'upload', kind: 'period' });
        expect((await call({ ...stmt, sha256: sha('re-downloaded'), action: 'claim', token: 'attempt-0002' })).body).toMatchObject({ duplicate: true, notice: 'Already Added via Manual Upload' });
    });
    it('retrying the SAME upload attempt after a dropped answer is not a duplicate', async () => {
        await call({ ...stmt, action: 'claim', token: 'attempt-0001' });
        expect((await call({ ...stmt, action: 'claim', token: 'attempt-0001' })).body.duplicate).toBe(false);
    });
    it('EMAIL FIRST: a statement the email sync filed is "Already Added via Email Sync" — by registry, and for history by the hash on the mailbox item', async () => {
        await claimStatement({ db: fs.db, uid: 'u', via: VIA.EMAIL, ref: `${MAIL}/items/s0`, identity: identityOf({ bank: 'NTB', account: '0276', dates: ['2026-09-14'] }), sha: sha('mailed') });
        expect((await call({ ...stmt, sha256: sha('different-bytes'), action: 'check' })).body).toMatchObject({ duplicate: true, via: 'email', notice: 'Already Added via Email Sync' });
        fs.data.set(`${MAIL}/items/old`, { uid: 'u', filed: true, contentSha256: sha('filed-before-the-registry') });
        expect((await call({ action: 'check', sha256: sha('filed-before-the-registry') })).body).toMatchObject({ duplicate: true, via: 'email', notice: 'Already Added via Email Sync' });
    });
    it('another month of the same account is added', async () => {
        await call({ ...stmt, action: 'claim', token: 'attempt-0001' });
        const next = { ...stmt, periodText: '17/09/2026 - 16/10/2026', sha256: sha('october') };
        expect((await call({ ...next, action: 'check' })).body.duplicate).toBe(false);
        expect((await call({ ...next, action: 'claim', token: 'attempt-0002' })).body.duplicate).toBe(false);
    });
    it('release gives a statement back so it can be added again', async () => {
        await call({ ...stmt, action: 'claim', token: 'attempt-0001' });
        expect((await call({ action: 'release', id: 'upload:attempt-0001' })).body.released).toBe(2);
        expect((await call({ ...stmt, action: 'check' })).body.duplicate).toBe(false);
    });
    it('answers 503 rather than a false "not a duplicate" when the registry cannot be read', async () => {
        fake.admin.firestore = () => ({ collection: () => { throw new Error('down'); } });
        expect((await call({ ...stmt, action: 'check' })).status).toBe(503);
    });
});

/* ── the email door: the real worker ─────────────────────────────────────────────────────────────────────────────── */
const html = (variant = 0, day = '14/09/2026') => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 16/09/2026 Payment Due Date: 10/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>${day}</td><td>KEELLS STORE</td><td>${(123.45 + variant).toFixed(2)} DR</td></tr><tr><td>15/09/2026</td><td>PAYMENT THANK YOU</td><td>${(50 + variant).toFixed(2)} CR</td></tr></table></body></html>`;
function world(sources, seedExtra = {}) {
    const seed = { [MAIL]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] }, 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] }, ...seedExtra };
    sources.forEach((s, i) => { seed[`${MAIL}/items/s${i}`] = { uid: 'u', bank: 'NTB', from: 'statements@nationstrust.com', filename: 'AMEX_Statement.html', messageId: `m${i}`, receivedMs: 1000 + i, status: 'pending', cursor: 0, filed: false }; });
    const { db, data } = createFirestore(seed);
    const loadAttachment = async source => { const body = sources[Number(source.messageId.slice(1))].html; return { bytes: Buffer.from(body), filename: 'AMEX_Statement.html', contentSha256: sha(body) }; };
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const run = async () => { for (let i = 0; i < 12; i++) { const r = await runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open: async () => [], settle: settleStatement, board: async () => null, loadAttachment, budgetMs: 20000 }); if (!r || !r.filed) break; } };
    return { db, data, run, item: i => data.get(`${MAIL}/items/s${i}`), user: () => data.get('users/u'), registry: () => [...data.keys()].filter(k => k.startsWith(`users/u/${REGISTRY}/`)) };
}
const UPLOAD_ID = identityOf({ bank: 'Nations Trust Bank', account: '****0276', periodText: '17/08/2026 - 16/09/2026' });

describe('the email door, through the real worker', () => {
    it('EMAIL FIRST: the statement is filed once and holds its month and its file in the registry', async () => {
        const w = world([{ html: html(0) }]);
        await w.run();
        expect(w.item(0)).toMatchObject({ status: 'filed', filed: true }); expect(w.item(0).duplicateOf).toBeUndefined();
        expect(w.user().cconetime).toHaveLength(1);
        expect(w.registry()).toHaveLength(2);
        expect(w.data.get(`users/u/${REGISTRY}/${UPLOAD_ID.id}`)).toMatchObject({ via: 'email', bank: expect.any(String), account: '0276', year: 2026, month: 9, ref: `${MAIL}/items/s0` });
    });
    it('UPLOAD FIRST: the owner already uploaded this month, so the email attachment is skipped — nothing filed, nothing asked, said plainly', async () => {
        const w = world([{ html: html(0) }]);
        await claimStatement({ db: w.db, uid: 'u', via: VIA.UPLOAD, ref: 'upload:t1', identity: UPLOAD_ID, sha: sha('what-the-owner-uploaded') });
        await w.run();
        expect(w.item(0)).toMatchObject({ status: 'filed', filed: true, duplicateOf: 'registry:upload', blockedBy: 'period', blockedVia: 'upload', proof: { math: 'duplicate-of' } });
        expect(w.user().cconetime).toHaveLength(0); expect(w.user().ccPayments).toHaveLength(0);
        expect([...w.data.keys()].some(k => k.startsWith('users/u/statementReview/'))).toBe(false);
    });
    it('UPLOAD FIRST, the very same file: skipped by its hash before it is even read', async () => {
        const w = world([{ html: html(0) }]);
        await claimStatement({ db: w.db, uid: 'u', via: VIA.UPLOAD, ref: 'upload:t1', identity: { ok: false }, sha: sha(html(0)) });
        await w.run();
        expect(w.item(0)).toMatchObject({ filed: true, duplicateOf: 'registry:upload', blockedBy: 'file' });
        expect(w.user().cconetime).toHaveLength(0);
    });
    it('a re-send of the same email, and a second copy from another address, are filed once', async () => {
        const w = world([{ html: html(0) }, { html: html(0) }, { html: html(1) }]);
        await w.run();
        expect([0, 1, 2].every(i => w.item(i).filed === true)).toBe(true);
        expect([0, 1, 2].filter(i => w.item(i).duplicateOf)).toHaveLength(2);
        expect(w.user().cconetime).toHaveLength(1); expect(w.user().ccPayments).toHaveLength(1);
    });
    it('another month of the same card is NOT blocked by the owner\'s upload of September', async () => {
        const october = html(0, '14/10/2026').replace('16/09/2026', '16/10/2026').replace('15/09/2026', '15/10/2026');
        const w = world([{ html: october }]);
        await claimStatement({ db: w.db, uid: 'u', via: VIA.UPLOAD, ref: 'upload:t1', identity: UPLOAD_ID, sha: sha('september-upload') });
        await w.run();
        expect(w.item(0).duplicateOf).toBeUndefined(); expect(w.user().cconetime).toHaveLength(1);
        expect(w.registry()).toHaveLength(4);
    });
    it('running it all again changes nothing', async () => {
        const w = world([{ html: html(0) }]);
        await w.run(); const before = JSON.stringify([w.user(), w.item(0), w.registry().map(k => w.data.get(k))]);
        await w.run(); await w.run();
        expect(JSON.stringify([w.user(), w.item(0), w.registry().map(k => w.data.get(k))])).toBe(before);
    });
    it('un-filing an email statement gives its month back', async () => {
        const w = world([{ html: html(0) }]);
        await w.run();
        expect(w.registry()).toHaveLength(2);
        await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(`${MAIL}/items/s0`) });
        expect(w.registry()).toHaveLength(0);
    });
});

describe('the wiring', () => {
    it('the endpoint is routed and the registry is sealed to the server in the rules', async () => {
        const { readFileSync } = await import('node:fs');
        expect(readFileSync('api/router.js', 'utf8')).toContain("'statement-guard': () => import('../statement-guard.js')");
        expect(readFileSync('firestore.rules', 'utf8')).toMatch(/'statementLayouts', 'statementRegistry'\]/);
    });
    it('the upload screen asks before reading and claims at save', async () => {
        const { readFileSync } = await import('node:fs');
        const ai = readFileSync('wealthflow-ai-v4.js', 'utf8'), index = readFileSync('index.html', 'utf8'), cloud = readFileSync('wealthflow-statement-cloud.js', 'utf8');
        expect(ai).toContain('_wfStatementGuard().file(file)'); expect(ai).toContain('_wfGuardParsed(');
        expect(index).toContain('window.WFStatementCloud.guard.claim(parsed._wfGuard)');
        expect(cloud).toContain("request('/api/statement-guard','POST'");
    });
});
