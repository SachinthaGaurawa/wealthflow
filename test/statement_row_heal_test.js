import { describe, expect, it } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { ntbDoc, savingsRows } from './helpers/embedded-statements.js';
import { runStatementSync, healMissingRows, repairStatementCategories, ROW_HEAL_MAX } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

// A statement can be filed — the ledger says so, the rows were in the owner's data — and later a device that had not
// yet seen them pushes its own copy of the list over the top. The statement still says "filed", so without a check the
// rows are gone for good. The ledger is the witness; the statement is read again and only what is missing is filed.
const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
const NOW = Date.parse('2026-09-30T12:00:00Z');

function world() {
    const html = ntbDoc({ accounts: [{ number: '200550088057', opening: 2405889, rows: savingsRows }] });
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
        [sourcePath]: { uid: 'u', bank: 'NTB', filename: 'Consolidated_eStatement_2026JAN.html', from: 'statements@nationstrust.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0 },
    });
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = async () => ({ bytes: Buffer.from(html), filename: 'Consolidated_eStatement_2026JAN.html', contentSha256: 'x' });
    const drain = async () => { let last; for (let i = 0; i < 6; i++) { last = await runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open: async () => [{ password: 'fixture-password', bank: 'NTB' }], settle: settleStatement, board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment, maxSteps: 1 }); if (last.status === 'filed' || last.status === 'needs_review') break; } return last; };
    const user = () => data.get('users/u');
    const ledger = () => [...data.entries()].filter(([k]) => k.startsWith('users/u/statementLedger/')).map(([k, v]) => ({ id: k.split('/').pop(), ...v }));
    return { db, data, drain, user, ledger, source: () => data.get(sourcePath) };
}

describe('rows that were filed and then lost are filed again, once', () => {
    it('brings back exactly the rows another device overwrote, without duplicating the rest', async () => {
        const w = world();
        expect((await w.drain()).status).toBe('filed');
        const filed = w.user().expenses.length + w.user().incomeRecv.length;
        expect(filed).toBe(4);
        const before = JSON.stringify([w.user().expenses.map(r => r.id).sort(), w.user().incomeRecv.map(r => r.id).sort()]);
        // a device that had not seen them pushes its own (empty) copy of the list
        w.data.set('users/u', { ...w.user(), expenses: [w.user().expenses[0]], incomeRecv: [] });
        expect(await healMissingRows({ db: w.db, uid: 'u' })).toEqual({ requeued: 1, rows: 3, more: false });
        expect(w.source()).toMatchObject({ status: 'pending', cursor: 0, rowHeal: { count: 1, rows: 3 } });
        await w.drain();
        expect(w.source()).toMatchObject({ status: 'filed', filed: true });
        expect(JSON.stringify([w.user().expenses.map(r => r.id).sort(), w.user().incomeRecv.map(r => r.id).sort()])).toBe(before);
        expect(w.user().expenses.length + w.user().incomeRecv.length).toBe(4);
        // and once they are back there is nothing to heal
        expect(await healMissingRows({ db: w.db, uid: 'u' })).toEqual({ requeued: 0, rows: 0, more: false });
    });
    it('leaves alone a row the owner deleted (it has a tombstone), however the list looks', async () => {
        const w = world();
        await w.drain();
        const gone = w.user().expenses[0];
        w.data.set('users/u', { ...w.user(), expenses: w.user().expenses.slice(1), _tomb: { expenses: { [gone.id]: Date.now() } } });
        expect(await healMissingRows({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 0 });
    });
    it('leaves alone rows filed before a factory reset, and rows filed so long ago that a deletion could no longer be told from a loss', async () => {
        const w = world();
        await w.drain();
        w.data.set('users/u', { ...w.user(), expenses: [], incomeRecv: [], _wipedAt: Date.now() + 1000 });
        expect(await healMissingRows({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 0 });
        w.data.set('users/u', { ...w.user(), _wipedAt: 0 });
        expect(await healMissingRows({ db: w.db, uid: 'u', now: Date.now() + 91 * 86400000 })).toMatchObject({ requeued: 0 });
    });
    it('gives up after a few tries rather than loop, and never touches a statement being processed', async () => {
        const w = world();
        await w.drain();
        w.data.set('users/u', { ...w.user(), expenses: [], incomeRecv: [] });
        w.data.set(sourcePath, { ...w.source(), rowHeal: { count: ROW_HEAL_MAX } });
        expect(await healMissingRows({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 0 });
        w.data.set(sourcePath, { ...w.source(), rowHeal: { count: 0 }, status: 'processing', leaseUntil: Date.now() + 60000 });
        expect(await healMissingRows({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 0 });
    });
    it('does nothing for a healthy account, and skips ledger entries that are not rows (skipped lines, reviews, subscriptions)', async () => {
        const w = world();
        await w.drain();
        expect(await healMissingRows({ db: w.db, uid: 'u' })).toEqual({ requeued: 0, rows: 0, more: false });
        w.data.set('users/u/statementLedger/zz', { uid: 'u', sourcePath, index: 9, status: 'filed', module: 'subscriptions', settledAt: Date.now() });
        w.data.set('users/u/statementLedger/yy', { uid: 'u', sourcePath, index: 10, status: 'skipped', module: '', settledAt: Date.now() });
        expect(await healMissingRows({ db: w.db, uid: 'u' })).toMatchObject({ requeued: 0 });
    });
    it('runs inside the unattended sync and reports how many rows it brought back', async () => {
        const w = world();
        await w.drain();
        w.data.set('users/u', { ...w.user(), expenses: [], incomeRecv: [] });
        const intake = async () => ({ body: { ok: true, collectionPending: false } });
        const f = async url => String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '5' }) } : { ok: true, json: async () => ({ access_token: 'token' }) };
        const out = await runStatementSync({ action: 'collect', db: w.db, owner, env: {}, f, read: readStatement, open: async () => [{ password: 'fixture-password', bank: 'NTB' }], settle: settleStatement, board: async () => { throw new Error('x'); }, intake,
            loadAttachment: async () => ({ bytes: Buffer.from(ntbDoc({ accounts: [{ number: '200550088057', opening: 2405889, rows: savingsRows }] })), filename: 'Consolidated_eStatement_2026JAN.html', contentSha256: 'x' }) });
        expect(out.rowsHealed).toBe(4);
        expect(w.user().expenses.length + w.user().incomeRecv.length).toBe(4);
    });
});

describe('a server repair is stamped so no device mistakes it for its own echo', () => {
    it('carries the worker\'s device id and a write time, like every other server write to the document', async () => {
        const { db, data } = createFirestore({ 'users/u': { expenses: [{ id: 'a', source: 'statement', desc: 'POS SPOTIFY PREMIUM', cat: 'Other', amount: 5, date: '2026-01-02' }], incomeRecv: [], _writeDeviceId: 'dev_laptop', _writeTs: 5 } });
        const out = await repairStatementCategories({ db, uid: 'u' });
        expect(out.total).toBe(1);
        expect(data.get('users/u')).toMatchObject({ _writeDeviceId: 'statement-worker', _lastModifiedBy: 'statement-worker' });
        expect(data.get('users/u')._writeTs).toBeGreaterThan(5);
        expect(data.get('users/u').expenses[0].cat).toBe('Entertainment');
    });
});
