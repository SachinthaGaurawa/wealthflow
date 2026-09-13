import { it, expect } from 'vitest';
import { makeFakeAdmin } from './fake-admin.mjs';
import { syncMailbox } from '../gmail-hook.js';
import { planMessage } from '../wealthflow-mail-ingest.mjs';
import { policyFrom, approvedClauses } from '../wealthflow-mail-senders.mjs';

function setup() {
    const fake = makeFakeAdmin(), db = fake.admin.firestore();
    db.runTransaction = async fn => {
        const writes = [];
        const result = await fn({ get: ref => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)) });
        for (const write of writes) await write();
        return result;
    };
    const ref = db.collection('wf-mail').doc('owner_example_org');
    const senders = [{ id: 'statements@hnb.lk', kind: 'address', status: 'approved' }];
    return { db, ref, senders };
}

it('historically catches up a newly approved exact sender despite an advanced Gmail cursor', async () => {
    const { db, ref, senders } = setup();
    await ref.set({ email: 'owner@example.org', refresh_token: 'fake', historyId: '999', collectedSenderClauses: [], senders });
    const urls = [];
    const f = async url => {
        urls.push(url);
        if (url.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake-access' }) };
        if (url.includes('/messages?')) return { ok: true, json: async () => ({ messages: [] }) };
        throw new Error('unexpected history request');
    };
    expect((await syncMailbox(db, { emailAddress: 'owner@example.org', historyId: '1000' }, { env: {}, f })).body.ok).toBe(true);
    expect(urls.some(url => decodeURIComponent(url).includes('from:statements@hnb.lk'))).toBe(true);
    expect((await ref.get()).data().collectedSenderClauses).toEqual(approvedClauses(senders));
    expect((await ref.get()).data().historyId).toBe('1000');
});

it('recovers yesterday’s approved statement even when the Gmail cursor already skipped past it', async () => {
    const { db, ref, senders } = setup();
    await ref.set({ email: 'owner@example.org', refresh_token: 'fake', historyId: '500', collectedSenderClauses: approvedClauses(senders), senders });
    const fetched = [];
    const approved = { id: 'missed-yesterday', internalDate: String(Date.now() - 86400000), payload: {
        headers: [{ name: 'From', value: 'statements@hnb.lk' }, { name: 'Subject', value: 'Monthly Statement' }, { name: 'Authentication-Results', value: 'dkim=pass header.i=@hnb.lk' }],
        parts: [{ filename: 'Statement.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 100 } }],
    } };
    const unapproved = { ...approved, id: 'receipt', payload: { ...approved.payload,
        headers: [{ name: 'From', value: 'receipts@shop.example' }, { name: 'Subject', value: 'Receipt' }, { name: 'Authentication-Results', value: 'dkim=pass header.i=@shop.example' }],
    } };
    const f = async url => {
        const u = decodeURIComponent(String(url)); fetched.push(u);
        if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake-access' }) };
        if (u.includes('/history?')) return { ok: true, json: async () => ({ historyId: '501', history: [] }) };
        if (u.includes('/messages?')) {
            expect(u).toContain('newer_than:14d');
            expect(u).toContain('from:statements@hnb.lk');
            expect(u).not.toContain('receipts@shop.example');
            return { ok: true, json: async () => ({ messages: [{ id: approved.id }] }) };
        }
        if (u.includes('/attachments/')) return { ok: true, json: async () => ({ data: Buffer.from('%PDF approved').toString('base64url') }) };
        if (u.includes('/messages/missed-yesterday?')) return { ok: true, json: async () => approved };
        if (u.includes('/messages/receipt?')) return { ok: true, json: async () => unapproved };
        throw new Error('unexpected request ' + u);
    };
    const result = await syncMailbox(db, { emailAddress: 'owner@example.org', historyId: '501' }, { env: {}, f });
    expect(result.body).toMatchObject({ ok: true, stored: 1 });
    expect(fetched.some(u => u.includes('/messages/receipt?'))).toBe(false);
    expect((await ref.collection('items').get()).docs).toHaveLength(1);
    expect((await ref.get()).data().lastReconcileMs).toBeGreaterThan(Date.now() - 5000);
});

it('throttles the overlap after a completed reconciliation while history remains immediate', async () => {
    const { db, ref, senders } = setup();
    await ref.set({ email: 'owner@example.org', refresh_token: 'fake', historyId: '500', lastReconcileMs: Date.now(), collectedSenderClauses: approvedClauses(senders), senders });
    const urls = [];
    const f = async url => {
        const u = decodeURIComponent(String(url)); urls.push(u);
        if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake-access' }) };
        if (u.includes('/history?')) return { ok: true, json: async () => ({ historyId: '501', history: [] }) };
        throw new Error('unexpected overlap request');
    };
    expect((await syncMailbox(db, { emailAddress: 'owner@example.org', historyId: '501' }, { env: {}, f })).body.ok).toBe(true);
    expect(urls.some(u => u.includes('newer_than:'))).toBe(false);
});

it('does not reset a manifest filed by another worker while an attachment download was in flight', async () => {
    const { db, ref, senders } = setup();
    const message = { id: 'm1', internalDate: '1789000000000', snippet: 'Your monthly statement', payload: {
        headers: [{ name: 'From', value: 'statements@hnb.lk' }, { name: 'Subject', value: 'Monthly Bank Statement' }, { name: 'Authentication-Results', value: 'dkim=pass header.i=@hnb.lk' }],
        parts: [{ filename: 'Statement.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 5000 } }]
    } };
    const plan = planMessage(message, policyFrom(senders));
    expect(plan.ok).toBe(true);
    const sourceRef = ref.collection('items').doc(plan.items[0].key);
    await ref.set({ email: 'owner@example.org', refresh_token: 'fake', historyId: '100', senders, collectedSenderClauses: approvedClauses(senders) });
    const f = async url => {
        if (url.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake-access' }) };
        if (url.includes('/history?')) return { ok: true, json: async () => ({ historyId: '200', history: [{ messagesAdded: [{ message: { id: 'm1' } }] }] }) };
        if (url.includes('/attachments/')) {
            await sourceRef.set({ status: 'filed', filed: true, cursor: 7, rowSetHash: 'durable' });
            return { ok: true, json: async () => ({ data: Buffer.from('%PDF-1.7\nsynthetic statement').toString('base64url') }) };
        }
        return { ok: true, json: async () => message };
    };
    expect((await syncMailbox(db, { emailAddress: 'owner@example.org', historyId: '200' }, { env: {}, f })).body.ok).toBe(true);
    expect((await sourceRef.get()).data()).toEqual({ status: 'filed', filed: true, cursor: 7, rowSetHash: 'durable' });
});
