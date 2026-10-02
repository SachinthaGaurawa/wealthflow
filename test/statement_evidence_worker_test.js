import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

// Nothing is taken on evidence any more: only an address on the owner's Senders list brings a statement in. An item that was (marked via 'evidence' while the rule allowed it)
// from an address that is not on the list is retired by the worker, unread and unfiled. One whose address IS on the list is read, and — wearing the old mark — is still held to what
// the mail claimed: the DOCUMENT names that bank and, where the owner already has statements from it, shows one of their accounts.

afterEach(() => vi.restoreAllMocks());

const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
const NTB = { id: 'estatement@info.nationstrust.com', kind: 'address', status: 'approved', name: 'NTB', domain: 'info.nationstrust.com' };
const LISTED = { id: 'statements@nt-mailer.example', kind: 'address', status: 'approved', name: 'NTB', domain: 'nt-mailer.example' };      // the address the item came from, once the owner has added it
const html = (heading = 'Nations Trust Bank American Express Credit Card Statement') => `<html><body><h1>${heading}</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 30/09/2026 Payment Due Date: 20/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr>${Array.from({ length: 3 }, (_, i) => `<tr><td>0${1 + i}/09/2026</td><td>KEELLS STORE ${i}</td><td>${(100 + i).toFixed(2)} DR</td></tr>`).join('')}</table></body></html>`;

function world({ senders = [NTB], doc = html(), filed = [], via = 'evidence' } = {}) {
    const items = Object.fromEntries(filed.map((x, i) => [`${mailPath}/items/filed${i}`, { uid: 'u', status: 'filed', filed: true, ...x }]));
    const fs = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] },
        [sourcePath]: { uid: 'u', bank: 'NTB', filename: 'statement.html', from: 'statements@nt-mailer.example', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'suspect', via },
        ...items,
    });
    const f = async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = vi.fn(async () => ({ bytes: Buffer.from(doc), filename: 'statement.html', contentSha256: 'x' }));
    const base = { action: 'drain', db: fs.db, owner, env: {}, f, intake: async () => ({ body: { ok: true } }), read: vi.fn(readStatement), open: async () => [{ password: 'x', bank: 'NTB' }], board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); }, loadAttachment, settle: settleStatement, maxSteps: 1, budgetMs: 40000 };
    return { ...fs, base, loadAttachment, run: () => runStatementSync(base) };
}

describe('an item from an address that is not on the owner\'s list is never read or filed', () => {
    it('whatever mark it carries (evidence, sibling, series), it is retired unread', async () => {
        for (const via of ['evidence', 'sibling', 'series']) {
            const w = world({ via });
            await w.run();
            expect(w.data.get(sourcePath), via).toMatchObject({ status: 'rejected_unapproved_sender', filed: false });
            expect(w.loadAttachment, via).not.toHaveBeenCalled();
            expect(w.data.get('users/u').cconetime, via).toEqual([]);
        }
    });
    it('and is not put back by a bank the owner approves another address of', async () => {
        const w = world({ senders: [NTB] });
        await w.run();
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'rejected_unapproved_sender' });
    });
});

describe('an item that wears the old evidence mark but whose address IS on the list still proves itself from its own document', () => {
    it('a document that names the bank — and a bank the owner has no filed statement from yet — is read and filed like any other', async () => {
        const w = world({ senders: [NTB, LISTED] });
        await w.run();
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, via: 'evidence' });
        expect(w.data.get('users/u').cconetime).toHaveLength(3);
    });
    it('a document that does not name the bank the mail said it came from is retired, never filed, and says why', async () => {
        const w = world({ doc: html('Some Other Bank Credit Card Statement'), senders: [NTB, LISTED] });
        await w.run();
        expect(w.data.get(sourcePath)).toMatchObject({ status: 'rejected_non_statement', filed: false, rejectionReason: expect.stringContaining('does not name the bank') });
        expect(w.data.get('users/u').cconetime).toEqual([]);
    });
    it('where the owner already has statements from the bank, the document must show one of THEIR accounts', async () => {
        const stranger = world({ filed: [{ bank: 'Nations Trust Bank (NTB)', last4: '9999' }], senders: [NTB, LISTED] });
        await stranger.run();
        expect(stranger.data.get(sourcePath)).toMatchObject({ status: 'rejected_non_statement', rejectionReason: expect.stringContaining('none of your accounts') });
        expect(stranger.data.get('users/u').cconetime).toEqual([]);
        const mine = world({ filed: [{ bank: 'Nations Trust Bank (NTB)', last4: '0276' }], senders: [NTB, LISTED] });
        await mine.run();
        expect(mine.data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true });
    });
    it('the same document without the evidence mark is judged as it always was (the mark adds a test, never removes one)', async () => {
        const w = world({ via: '', doc: html('Some Other Bank Credit Card Statement'), senders: [NTB, LISTED] });
        await w.run();
        expect(w.data.get(sourcePath).status).not.toBe('rejected_non_statement');
    });
});
