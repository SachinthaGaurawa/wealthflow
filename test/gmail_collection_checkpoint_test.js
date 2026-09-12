import { it, expect } from 'vitest';
import { makeFakeAdmin } from './fake-admin.mjs';
import { syncMailbox } from '../gmail-hook.js';

function database() {
    const fake = makeFakeAdmin(), db = fake.admin.firestore();
    db.runTransaction = async fn => {
        const writes = [];
        const result = await fn({ get: ref => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)) });
        for (const write of writes) await write();
        return result;
    };
    return db;
}
it('checkpoints a large collection and advances history only after every batch succeeds', async () => {
    const db = database(), ref = db.collection('wf-mail').doc('owner_example_org');
    await ref.set({ email: 'owner@example.org', refresh_token: 'test-token', historyId: '100' });
    let fail = false, downloads = 0;
    const f = async url => {
        if (url.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'test-access' }) };
        if (url.includes('/history?')) return { ok: true, json: async () => ({ historyId: '200', history: [{ messagesAdded: Array.from({ length: 25 }, (_, i) => ({ message: { id: 'm' + i } })) }] }) };
        downloads++;
        if (fail) throw new Error('temporary-outage');
        return { ok: true, json: async () => ({ id: 'm', payload: { headers: [], parts: [] } }) };
    };
    const note = { emailAddress: 'owner@example.org', historyId: '200' };
    expect((await syncMailbox(db, note, { env: {}, f })).body.collectionPending).toBe(true);
    expect((await ref.get()).data()).toMatchObject({ historyId: '100', pendingCollection: { cursor: 10 } });
    fail = true;
    expect((await syncMailbox(db, note, { env: {}, f })).status).toBe(503);
    expect((await ref.get()).data().pendingCollection.cursor).toBe(10);
    fail = false;
    await syncMailbox(db, note, { env: {}, f });
    expect((await ref.get()).data()).toMatchObject({ historyId: '100', pendingCollection: { cursor: 20 } });
    expect((await syncMailbox(db, note, { env: {}, f })).body.collectionPending).toBe(false);
    expect((await ref.get()).data()).toMatchObject({ historyId: '200', pendingCollection: null });
    expect(downloads).toBe(26);
});
