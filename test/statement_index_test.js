import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { fingerprintOf, findFiledTwin, duplicatePatch } from '../statement-index.mjs';
import { runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { rollupItems } from '../mail-state.mjs';
import { auditLogOf } from '../statement-coverage.mjs';

/* =============================================================================
 * "PROCESSED" LIVES IN WEALTHFLOW, NOT IN GMAIL — and is asked BEFORE anything is downloaded or read.
 *
 * The mailbox is read-only, so there are no labels. A message is known by its record in the state table, an attachment by its
 * fingerprint (the item id: message + name + size), a file by the SHA-256 of its bytes. The same statement arriving again, from
 * another address or in a second message, is recognised the moment its bytes are in hand and is never filed twice.
 * ===========================================================================*/

const sha = (text) => createHash('sha256').update(text).digest('hex');
const A = 'a'.repeat(64), B = 'b'.repeat(64);

describe('fingerprintOf', () => {
    it('is the same for the same message, name and size, whatever the case of the name — and different for anything else', () => {
        const base = { messageId: 'm1', filename: 'Statement_2026MAR.pdf', size: 4000 };
        expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base, filename: 'STATEMENT_2026MAR.PDF' }));
        expect(fingerprintOf(base)).toMatch(/^[0-9a-f]{64}$/);
        for (const other of [{ messageId: 'm2' }, { filename: 'Statement_2026APR.pdf' }, { size: 4001 }]) expect(fingerprintOf({ ...base, ...other })).not.toBe(fingerprintOf(base));
    });
    it('tolerates anything', () => { expect(() => fingerprintOf()).not.toThrow(); expect(() => fingerprintOf({ size: 'x', filename: null })).not.toThrow(); });
});

describe('findFiledTwin', () => {
    const mailWith = (items) => { const { db } = createFirestore(Object.fromEntries(Object.entries(items).map(([id, v]) => [`wf-mail/k/items/${id}`, v]))); return db.collection('wf-mail').doc('k'); };
    it('finds the filed statement with the same bytes, and never itself', async () => {
        const mailRef = mailWith({ one: { contentSha256: A, filed: true, totalRows: 5 }, two: { contentSha256: A, filed: false } });
        expect((await findFiledTwin({ mailRef, sha: A, selfId: 'two' })).id).toBe('one');
        expect(await findFiledTwin({ mailRef, sha: A, selfId: 'one' })).toBeNull();
    });
    it('a statement that is not filed, a copy of another, or closed empty is not an original; other bytes are not a twin', async () => {
        const mailRef = mailWith({ pending: { contentSha256: A, filed: false, status: 'pending' }, copy: { contentSha256: A, filed: true, duplicateOf: 'orig' }, empty: { contentSha256: A, filed: true, emptyStatement: true }, other: { contentSha256: B, filed: true } });
        expect(await findFiledTwin({ mailRef, sha: A, selfId: 'x' })).toBeNull();
    });
    it('a hash that is not a hash finds nothing, and a database that cannot be read costs only the shortcut', async () => {
        const mailRef = mailWith({ one: { contentSha256: A, filed: true } });
        for (const bad of ['', 'abc', null, undefined, 'g'.repeat(64), A.toUpperCase()]) expect(await findFiledTwin({ mailRef, sha: bad, selfId: 'x' }), String(bad)).toBeNull();
        const broken = { collection: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('unavailable'); } }) }) }) };
        expect(await findFiledTwin({ mailRef: broken, sha: A, selfId: 'x' })).toBeNull();
    });
});

describe('duplicatePatch', () => {
    it('finishes the copy, points it at its original, and files nothing', () => {
        const p = duplicatePatch({ twin: { id: 'orig', data: { totalRows: 12, statementKey: 'k'.repeat(64) } }, now: 5 });
        expect(p).toMatchObject({ status: 'filed', filed: true, hasReview: false, duplicateOf: 'orig', totalRows: 12, cursor: 12, statementKey: 'k'.repeat(64), proof: { math: 'duplicate-of', of: 'orig', rows: 12 }, leaseToken: '', leaseUntil: 0, retryAt: 0, updatedAt: 5 });
        expect(duplicatePatch({ twin: { id: 'o', data: {} } })).not.toHaveProperty('cursor');
    });
});

/* ── through the real worker ───────────────────────────────────────────────────────────────────────────────────────── */
const owner = { uid: 'u', email: 'owner@example.com' };
const MAIL = 'wf-mail/owner_example_com';
const html = (variant = 0) => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX${String(276 + Math.round(variant)).padStart(4, '0')}</p><p>Statement Date: 16/09/2026 Payment Due Date: 10/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>14/09/2026</td><td>KEELLS STORE</td><td>${(123.45 + variant).toFixed(2)} DR</td></tr><tr><td>15/09/2026</td><td>PAYMENT THANK YOU</td><td>${(50 + variant).toFixed(2)} CR</td></tr></table></body></html>`;

function world(sources) {
    const seed = { [MAIL]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] }, 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] } };
    sources.forEach((s, i) => { seed[`${MAIL}/items/s${i}`] = { uid: 'u', bank: 'NTB', from: 'statements@nationstrust.com', filename: 'AMEX_Statement.html', messageId: `m${i}`, receivedMs: 1000 + (s.received ?? i), status: 'pending', cursor: 0, filed: false, ...(s.item || {}) }; });
    const { db, data } = createFirestore(seed);
    const loads = [];
    const loadAttachment = async (source) => { loads.push(source.messageId); const body = sources[Number(source.messageId.slice(1))].html; return { bytes: Buffer.from(body), filename: 'AMEX_Statement.html', contentSha256: sha(body) }; };
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const run = async () => { let last; for (let i = 0; i < 12; i++) { last = await runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open: async () => [], settle: settleStatement, board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment, maxSteps: Infinity }); if (!last.morePending) break; } return last; };
    return { db, data, run, loads, item: (i) => data.get(`${MAIL}/items/s${i}`), user: () => data.get('users/u') };
}

describe('the same file again, through the worker', () => {
    it('is filed ONCE: the second copy is recorded as a duplicate of the first and never read or classified', async () => {
        const w = world([{ html: html(0) }, { html: html(0) }, { html: html(0) }]);
        await w.run();
        const items = [0, 1, 2].map(w.item);
        expect(items.every((i) => i.filed === true && i.status === 'filed')).toBe(true);
        expect(items.filter((i) => i.duplicateOf)).toHaveLength(2);
        const original = items.find((i) => !i.duplicateOf);
        for (const copy of items.filter((i) => i.duplicateOf)) expect(copy).toMatchObject({ duplicateOf: expect.any(String), proof: { math: 'duplicate-of' }, contentSha256: original.contentSha256 });
        // one purchase and one payment in the ledger, however many times the bank sent it
        expect(w.user().cconetime).toHaveLength(1); expect(w.user().ccPayments).toHaveLength(1);
    });
    it('different statements (another card) are all filed — the same card and month in other bytes is the registry\'s business, see statement_registry_test.js', async () => {
        const w = world([{ html: html(0) }, { html: html(1) }, { html: html(2) }]);
        await w.run();
        expect([0, 1, 2].every((i) => w.item(i).filed === true && !w.item(i).duplicateOf)).toBe(true);
        expect(w.user().cconetime).toHaveLength(3);
    });
    it('the owner sees it for what it is: counted as ingested, the audit log says DUPLICATE, and nothing is asked', async () => {
        const w = world([{ html: html(0) }, { html: html(0) }]);
        await w.run();
        const items = [0, 1].map((i) => ({ id: `s${i}`, ...w.item(i) }));
        const rolled = rollupItems(items);
        expect([...rolled.values()].every((r) => r.state === 'INGESTED')).toBe(true);
        const log = auditLogOf(items);
        expect(log).toHaveLength(2); expect(log.filter((e) => e.math === 'DUPLICATE')).toHaveLength(1); expect(log.every((e) => e.status === 'Synced')).toBe(true);
        expect([...w.data.keys()].some((k) => k.startsWith('users/u/statementReview/'))).toBe(false);
    });
    it('running it all again changes nothing', async () => {
        const w = world([{ html: html(0) }, { html: html(0) }]);
        await w.run(); const before = JSON.stringify([w.user(), w.item(0), w.item(1)]);
        await w.run(); await w.run();
        expect(JSON.stringify([w.user(), w.item(0), w.item(1)])).toBe(before);
    });
    it('a statement already part-way through is never turned into a duplicate half-way', async () => {
        const w = world([{ html: html(0) }, { html: html(0), item: { cursor: 1, totalRows: 2 } }]);
        // the first is filed; the second has cursor 1 of 2 and is finished by the worker as a statement, not skipped as a copy
        await w.run();
        expect(w.item(1).duplicateOf).toBeUndefined();
    });
    it('the hash is recorded on the item the moment it is known, even when the loader does not', async () => {
        const w = world([{ html: html(0) }]);
        await w.run();
        expect(w.item(0).contentSha256).toBe(sha(html(0)));
    });
});
