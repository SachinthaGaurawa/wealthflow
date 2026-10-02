import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { reviveRetiredSources, runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

// Production, 2026-10-02: 14 NTB statements from another desk of the approved bank (info.* beside estmt.*) were stored, retired as "the sender is no longer approved" and
// never looked at again. A retired statement goes back in the queue when its sender is an EXACT address on the owner's list TODAY — and only then: another desk of the bank,
// a registered domain of it and a mail that said statement are not (the owner's rule: only the addresses they listed bring a statement in).

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
    it('an exactly approved address goes back in the queue; another desk of an approved bank, a stranger, a blocked address and a third retirement do not', async () => {
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
        expect(out).toMatchObject({ revived: 1, kept: 5 });
        const at = id => w.data.get(`${mailPath}/items/${id}`);
        expect(at('exact')).toMatchObject({ status: 'pending', reviveCount: 1, filed: false, retryCount: 0, leaseToken: '' });
        expect(at('exact').via).toBeUndefined();
        for (const id of ['desk', 'card', 'stranger', 'blocked', 'third', 'nofrom']) expect(at(id).status, id).toBe('rejected_unapproved_sender');
        expect(JSON.parse(out.lines[0])).toMatchObject({ evt: 'statement-revived', checked: 7, revived: 1, kept: 5, noSender: 1, banks: { NTB: 1 } });
        expect(out.lines[0]).not.toMatch(/statements@|evil|promo@/);        // counts and bank names only
    });
    it('a statement taken on evidence is never revived, whatever bank the owner approves — the address is not on the list', async () => {
        const w = world({ ev: retired('S <s@ntb-mailer.example>', { via: 'evidence' }) });
        expect((await run(w)).revived).toBe(0);
        const listed = world({ ev: retired('S <s@ntb-mailer.example>', { via: 'evidence' }) });
        expect((await run(listed, { senders: [...SENDERS, A('s@ntb-mailer.example', 'NTB')] })).revived).toBe(1);      // until the owner adds that address
        expect(listed.data.get(`${mailPath}/items/ev`).via).toBe('');        // the release mark is cleared: it is taken as the listed address it is
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
        const w = world({ item0: retired('NTB <estatement@info.nationstrust.com>', { filename: 'statement.html' }) });
        const f = async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });
        const loadAttachment = vi.fn(async () => ({ bytes: Buffer.from(html), filename: 'statement.html', contentSha256: 'x' }));
        await runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f, intake: async () => ({ body: { ok: true } }), read: readStatement, open: async () => [{ password: 'x', bank: 'NTB' }], board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); }, loadAttachment, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
        expect(w.data.get(`${mailPath}/items/item0`)).toMatchObject({ status: 'filed', filed: true, reviveCount: 1 });
        expect(w.data.get('users/u').cconetime).toHaveLength(1);
        expect(w.data.get(mailPath).lastReviveMs).toBeGreaterThan(0);
    });
});

describe('an item stored before the sender was recorded on it', () => {
    const gmail = (senders) => vi.fn(async (url) => {
        const id = decodeURIComponent(String(url)).split('/messages/')[1].split('?')[0];
        if (!(id in senders)) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ payload: { headers: [{ name: 'Subject', value: 'x' }, { name: 'From', value: senders[id] }] } }) };
    });
    it('the sender is read from the message (headers only, once per message), written on the item, and the item judged on it', async () => {
        const w = world({
            a: { ...retired(''), from: undefined, messageId: 'm1' },
            b: { ...retired(''), from: undefined, messageId: 'm1', filename: 'second.html' },
            c: { ...retired(''), from: undefined, messageId: 'm2' },
            d: { ...retired(''), from: undefined, messageId: 'm3' },
            e: { ...retired(''), from: undefined, messageId: 'gone' },
            f: { ...retired(''), from: undefined, messageId: '' },
        });
        for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) delete w.data.get(`${mailPath}/items/${id}`).from;
        const f = gmail({ m1: 'NTB <statements@info.nationstrust.com>', m2: 'Mallory <x@evil.example>', m3: 'NTB <estatement@info.nationstrust.com>' });
        const out = await run(w, { token: 't', f });
        const at = id => w.data.get(`${mailPath}/items/${id}`);
        expect(out.revived).toBe(1);
        expect(at('a')).toMatchObject({ status: 'rejected_unapproved_sender', from: 'NTB <statements@info.nationstrust.com>' });      // another desk: judged, kept, and the sender remembered
        expect(at('b').status).toBe('rejected_unapproved_sender');
        expect(at('d')).toMatchObject({ status: 'pending', from: 'NTB <estatement@info.nationstrust.com>' });
        expect(at('c')).toMatchObject({ status: 'rejected_unapproved_sender', from: 'Mallory <x@evil.example>' });      // judged, kept, and the sender remembered
        expect(at('e').status).toBe('rejected_unapproved_sender');
        expect(f).toHaveBeenCalledTimes(4);                                   // m1 once for two items, m2, m3, and the one that is gone
        expect(f.mock.calls.every(([url]) => String(url).includes('format=metadata&metadataHeaders=From'))).toBe(true);
        expect(JSON.parse(out.lines[0])).toMatchObject({ checked: 6, revived: 1, kept: 3, noSender: 2, lookedUp: 4, messagesGone: 1 });
    });
    it('what was written is not looked up again, and a run asks Gmail about at most `lookups` messages', async () => {
        const items = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`x${i}`, { ...retired(''), messageId: 'mm' + i }]));
        const w = world(items);
        for (const id of Object.keys(items)) delete w.data.get(`${mailPath}/items/${id}`).from;
        const f = gmail(Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['mm' + i, 'Mallory <x@evil.example>'])));
        expect(JSON.parse((await run(w, { token: 't', f, lookups: 5 })).lines[0])).toMatchObject({ lookedUp: 5, noSender: 3 });
        expect(JSON.parse((await run(w, { token: 't', f, lookups: 5 })).lines[0])).toMatchObject({ lookedUp: 3, noSender: 0 });      // the five are remembered
    });
    it('without a token nothing is asked and nothing is guessed', async () => {
        const w = world({ a: { ...retired(''), messageId: 'm1' } });
        delete w.data.get(`${mailPath}/items/a`).from;
        expect((await run(w)).revived).toBe(0);
    });
});
