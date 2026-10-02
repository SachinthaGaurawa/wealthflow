import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { reviveRetiredSources, runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

// Production, 2026-10-02: 14 NTB statements from another desk of the approved bank (info.* beside estmt.*) were stored, retired as "the sender is no longer approved" and
// never looked at again — the owner's "years of statements that never arrive". A retired statement whose sender is right TODAY goes back in the queue.

afterEach(() => vi.restoreAllMocks());
const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com';
const A = (id, name) => ({ id, kind: 'address', status: 'approved', name, domain: id.split('@')[1] });
const SENDERS = [A('estatement@info.nationstrust.com', 'NTB'), A('e-statements@hnb.lk', 'HNB'), { id: 'promo@hnb.lk', kind: 'address', status: 'blocked', domain: 'hnb.lk' }];
const retired = (from, extra = {}) => ({ uid: 'u', bank: 'NTB', filename: 's.html', from, messageId: 'm', status: 'rejected_unapproved_sender', filed: false, cursor: 0, intent: 'stated', ...extra });
const world = (items, senders = SENDERS) => createFirestore({
    [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders },
    'wf-statement-vault/u': { uid: 'u' },
    'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] },
    ...Object.fromEntries(Object.entries(items).map(([id, data]) => [`${mailPath}/items/${id}`, data])),
});
const run = (w, extra = {}) => { const lines = []; return reviveRetiredSources({ db: w.db, mailRef: w.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', senders: SENDERS, log: l => lines.push(l), ...extra }).then(out => ({ ...out, lines })); };

describe('a statement retired for its sender is judged again under today\'s list', () => {
    it('another desk of an approved bank (no `via` was ever stored) and an exactly approved address go back in the queue; a stranger, a blocked address and a third retirement do not', async () => {
        const w = world({
            desk: retired('NTB <statements@info.nationstrust.com>'),
            card: retired('NTB <nationstrust@estmt.nationstrust.com>'),
            exact: retired('NTB <estatement@info.nationstrust.com>'),
            stranger: retired('Mallory <x@evil.example>'),
            blocked: retired('HNB Promo <promo@hnb.lk>', { bank: 'HNB' }),
            third: retired('NTB <statements@info.nationstrust.com>', { reviveCount: 2 }),
            nofrom: { ...retired(''), from: '' },
        });
        const out = await run(w);
        expect(out).toMatchObject({ revived: 3, kept: 3 });
        const at = id => w.data.get(`${mailPath}/items/${id}`);
        expect(at('desk')).toMatchObject({ status: 'pending', via: 'sibling', reviveCount: 1, filed: false, retryCount: 0, leaseToken: '' });
        expect(at('card')).toMatchObject({ status: 'pending', via: 'sibling' });
        expect(at('exact')).toMatchObject({ status: 'pending', reviveCount: 1 });
        expect(at('exact').via).toBeUndefined();
        for (const id of ['stranger', 'blocked', 'third', 'nofrom']) expect(at(id).status, id).toBe('rejected_unapproved_sender');
        expect(JSON.parse(out.lines[0])).toMatchObject({ evt: 'statement-revived', checked: 7, revived: 3, kept: 3, noSender: 1, banks: { NTB: 3 } });
        expect(out.lines[0]).not.toMatch(/statements@|evil|promo@/);        // counts and bank names only
    });
    it('a bank taken on evidence is revived while the owner still approves an address at that bank, and not after', async () => {
        const w = world({ ev: retired('S <s@ntb-mailer.example>', { via: 'evidence' }) });
        expect((await run(w)).revived).toBe(1);
        const gone = world({ ev: retired('S <s@ntb-mailer.example>', { via: 'evidence' }) });
        expect((await run(gone, { senders: [A('e-statements@hnb.lk', 'HNB')] })).revived).toBe(0);
    });
    it('revoked is revoked: with the owner\'s approval of the bank gone, nothing is revived', async () => {
        const w = world({ desk: retired('NTB <statements@info.nationstrust.com>') });
        expect((await run(w, { senders: [A('e-statements@hnb.lk', 'HNB')] })).revived).toBe(0);
        expect(w.data.get(`${mailPath}/items/desk`).status).toBe('rejected_unapproved_sender');
    });
    it('nothing to say when nothing is retired', async () => {
        const w = world({});
        const out = await run(w);
        expect(out).toMatchObject({ revived: 0, lines: [] });
    });
});

describe('and the worker then files it', () => {
    const html = `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 30/09/2026 Payment Due Date: 20/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>01/09/2026</td><td>KEELLS STORE 1</td><td>100.00 DR</td></tr></table></body></html>`;
    it('a drain run revives the retired statement, reads it and files it — in one pass', async () => {
        const w = world({ item0: retired('NTB <statements@info.nationstrust.com>', { filename: 'statement.html' }) });
        const f = async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });
        const loadAttachment = vi.fn(async () => ({ bytes: Buffer.from(html), filename: 'statement.html', contentSha256: 'x' }));
        await runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f, intake: async () => ({ body: { ok: true } }), read: readStatement, open: async () => [{ password: 'x', bank: 'NTB' }], board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); }, loadAttachment, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(`${mailPath}/items/item0`)).toMatchObject({ status: 'filed', filed: true, via: 'sibling', reviveCount: 1 });
        expect(w.data.get('users/u').cconetime).toHaveLength(1);
        expect(w.data.get(mailPath).lastReviveMs).toBeGreaterThan(0);
    });
});
