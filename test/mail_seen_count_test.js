import { describe, it, expect } from 'vitest';
import { makeFakeAdmin } from './fake-admin.mjs';
import { syncMailbox } from '../gmail-hook.js';
import { approvedClauses } from '../wealthflow-mail-senders.mjs';

/* A sender's "seen" number is a count of MESSAGES. It used to go up on every scan that walked past a message again, so a bank
 * that writes once a month read "seen 555 times". Here the same three statements are found, then found again by a
 * re-scan, a requeue and a second re-scan: the number is three, and a fourth, genuinely new, message makes it four. */

const NOTE = { emailAddress: 'owner@example.org', historyId: '1000' };
const senders = [{ id: 'statements@dfccbank.com', kind: 'address', status: 'approved', name: 'DFCC Bank', domain: 'dfccbank.com', seenCount: 0 }];
const AUTH = { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@dfccbank.com; spf=pass; dmarc=pass header.from=dfccbank.com' };
const message = (id, month) => ({
    id, internalDate: String(Date.parse(`2026-${month}-02T05:00:00Z`)),
    payload: { headers: [{ name: 'From', value: 'DFCC Bank <statements@dfccbank.com>' }, { name: 'Subject', value: `DFCC Bank Statement ${month}` }, AUTH], mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'x' } }, { mimeType: 'application/pdf', filename: `Statement_2026${month}.pdf`, body: { attachmentId: 'att-' + id, size: 120 } }] },
});

function setup(inbox, history) {
    const fake = makeFakeAdmin(), db = fake.admin.firestore();
    db.runTransaction = async fn => {
        const writes = [];
        const result = await fn({ get: ref => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)) });
        for (const write of writes) await write();
        return result;
    };
    const ref = db.collection('wf-mail').doc('owner_example_org');
    let hist = history;
    const f = async url => {
        const u = decodeURIComponent(String(url));
        if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake-access' }) };
        if (u.includes('/history?')) return { ok: true, json: async () => ({ historyId: '1000', history: hist.length ? [{ messagesAdded: hist.map(id => ({ message: { id } })) }] : [] }) };
        if (u.includes('/messages?')) return { ok: true, json: async () => ({ messages: inbox.map(m => ({ id: m.id })) }) };
        if (u.includes('/attachments/')) return { ok: true, json: async () => ({ data: Buffer.from('%PDF-1.4 statement').toString('base64url') }) };
        const id = u.split('/messages/')[1]?.split('?')[0];
        const found = inbox.find(m => m.id === id);
        return found ? { ok: true, json: async () => found } : { ok: false, status: 404, json: async () => ({}) };
    };
    const ready = ref.set({ uid: 'owner', email: 'owner@example.org', refresh_token: 'fake', historyId: '999', lastReconcileMs: Date.now(), collectedSenderClauses: approvedClauses(senders), senders });
    return { ref, run: async () => { await ready; return syncMailbox(db, NOTE, { env: {}, f }); }, setHistory: h => { hist = h; }, push: m => inbox.push(m) };
}
const countOf = async s => ((await s.ref.get()).data().senders || []).find(e => e.id === 'statements@dfccbank.com').seenCount;

describe('a sender\'s seen count is of messages, not of scans', () => {
    it('three statements are three, however many times they are walked past again', async () => {
        const s = setup([message('m1', '01'), message('m2', '02'), message('m3', '03')], ['m1', 'm2', 'm3']);
        await s.run();
        expect(await countOf(s)).toBe(3);
        for (let round = 0; round < 3; round++) {
            await s.ref.set({ requeue: ['m1', 'm2', 'm3'] }, { merge: true });
            await s.run();
        }
        expect(await countOf(s)).toBe(3);
    });
    it('a genuinely new message is the fourth', async () => {
        const s = setup([message('m1', '01'), message('m2', '02'), message('m3', '03')], ['m1', 'm2', 'm3']);
        await s.run();
        s.push(message('m4', '04')); s.setHistory(['m4']);
        await s.run();
        expect(await countOf(s)).toBe(4);
    });
});
