import { describe, it, expect, vi } from 'vitest';
import { makeFakeAdmin } from './fake-admin.mjs';
import { syncMailbox, listAllMessages, auditClauses, AUDIT_EVERY_MS } from '../gmail-hook.js';
import { takeRefusedMessage } from '../statement-sync.js';
import { INTAKE_VERSION } from '../wealthflow-mail-ingest.mjs';
import { mergeRefused } from '../gmail-link.mjs';
import { approvedClauses } from '../wealthflow-mail-senders.mjs';

// "No statement may ever be missed, for any reason." The cursor and the 14-day overlap
// both look forward from a bookmark, so a message BEHIND the bookmark — one Gmail put in
// Spam, one an older rule refused, one from the bank's second address — was never
// looked at again. These tests run the real collection against an in-memory mailbox and
// check that the whole history is compared with what is accounted for, and that nothing
// refused is ever forgotten.

const NOTE = { emailAddress: 'owner@example.org', historyId: '1000' };
const senders = [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved', name: 'NTB', domain: 'nationstrust.com' }];
const DKIM = { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@nationstrust.com' };

const message = (id, { from = 'Statements <statements@nationstrust.com>', filename = 'Consolidated_eStatement_2026MAR_458290.html', dkim = true, subject = 'Your e-Statement', received = Date.parse('2026-04-02T05:00:00Z') } = {}) => ({
    id, internalDate: String(received),
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, ...(dkim ? [DKIM] : [])], mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'x' } }, { mimeType: /\.pdf$/i.test(filename) ? 'application/pdf' : 'text/html', filename, body: { attachmentId: 'att-' + id, size: 120 } }] },
});

function setup({ mail = {}, items = {}, inbox = [], listing, history = [] } = {}) {
    const fake = makeFakeAdmin(), db = fake.admin.firestore();
    db.runTransaction = async fn => {
        const writes = [];
        const result = await fn({ get: ref => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)) });
        for (const write of writes) await write();
        return result;
    };
    const ref = db.collection('wf-mail').doc('owner_example_org');
    const calls = [];
    const f = async url => {
        const u = decodeURIComponent(String(url)); calls.push(u);
        if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake-access' }) };
        if (u.includes('/history?')) return { ok: true, json: async () => ({ historyId: '1000', history: history.length ? [{ messagesAdded: history.map(id => ({ message: { id } })) }] : [] }) };
        if (u.includes('/messages?')) {
            if (listing === 'fail') return { ok: false, status: 500, json: async () => ({}) };
            return { ok: true, json: async () => ({ messages: (listing || inbox.map(m => m.id)).map(id => ({ id })) }) };
        }
        if (u.includes('/attachments/')) return { ok: true, json: async () => ({ data: Buffer.from('<html>statement</html>').toString('base64url') }) };
        const id = u.split('/messages/')[1]?.split('?')[0];
        const found = inbox.find(m => m.id === id);
        return found ? { ok: true, json: async () => found } : { ok: false, status: 404, json: async () => ({}) };
    };
    const ready = (async () => {
        await ref.set({ uid: 'owner', email: 'owner@example.org', refresh_token: 'fake', historyId: '999', lastReconcileMs: Date.now(), collectedSenderClauses: approvedClauses(senders), senders, ...mail });
        for (const [id, data] of Object.entries(items)) await ref.collection('items').doc(id).set(data);
    })();
    return { db, ref, f, calls, ready, run: async (note = NOTE, env = {}) => { await ready; return syncMailbox(db, note, { env, f }); } };
}
const itemsOf = async s => Object.fromEntries((await s.ref.collection('items').get()).docs.map(d => [d.id, d.data()]));
const listingCalls = s => s.calls.filter(u => u.includes('/messages?') && decodeURIComponent(u).includes('from:') && !u.includes('maxResults=1&'));      // the audit's own listings (the other ways of asking, and their size estimates, are not)

describe('the whole-history audit', () => {
    it('lists every message from the approved bank domains, Spam included and Trash not, and takes one the cursor had skipped', async () => {
        const s = setup({ inbox: [message('old1')] });
        const out = await s.run();
        expect(out.body).toMatchObject({ ok: true, stored: 1 });
        const q = listingCalls(s)[0];
        expect(q).toContain('from:nationstrust.com');
        expect(q).toContain('has:attachment');
        expect(q).toContain('-in:trash');
        expect(q).toContain('includeSpamTrash=true');
        const items = await itemsOf(s);
        expect(Object.values(items)).toHaveLength(1);
        expect(Object.values(items)[0]).toMatchObject({ messageId: 'old1', status: 'pending', via: 'audit' });
        const mail = (await s.ref.get()).data();
        expect(mail).toMatchObject({ auditVersion: INTAKE_VERSION, historyId: '1000' });
        expect(mail.historyAudit).toMatchObject({ listed: 1, accounted: 0, examined: 1, taken: 1, complete: true });
        expect(mail.pendingCollection).toBeNull();
    });

    it('does not fetch a message that is already stored, and says how many it accounted for', async () => {
        const s = setup({ inbox: [message('old1')], items: { 'old1.x.120': { uid: 'owner', messageId: 'old1', filename: 'Consolidated_eStatement_2026MAR_458290.html', status: 'pending' } } });
        await s.run();
        expect(s.calls.some(u => u.includes('/messages/old1?'))).toBe(false);
        expect((await s.ref.get()).data().historyAudit).toMatchObject({ listed: 1, accounted: 1, examined: 0, taken: 0, complete: true });
    });

    it('is not repeated inside a day once it has completed, and runs again after one', async () => {
        const s = setup({ inbox: [], mail: { auditVersion: INTAKE_VERSION, lastAuditMs: Date.now() - 3600_000 } });
        await s.run();
        expect(listingCalls(s)).toHaveLength(0);
        const t = setup({ inbox: [], mail: { auditVersion: INTAKE_VERSION, lastAuditMs: Date.now() - AUDIT_EVERY_MS - 1000 } });
        await t.run();
        expect(listingCalls(t)).toHaveLength(1);
    });

    it('runs again at once when the intake rules have a new version', async () => {
        const s = setup({ inbox: [], mail: { auditVersion: INTAKE_VERSION - 1, lastAuditMs: Date.now() - 6 * 60_000 } });
        await s.run();
        expect(listingCalls(s)).toHaveLength(1);
    });

    it('a listing that fails postpones the audit but never stops the mail arriving', async () => {
        const s = setup({ listing: 'fail', history: ['h1'], inbox: [message('h1')] });
        const out = await s.run();
        expect(out.body).toMatchObject({ ok: true, stored: 1 });
        const mail = (await s.ref.get()).data();
        expect(mail.auditVersion).toBeUndefined();
        expect(mail.historyId).toBe('1000');
    });

    it('a message that arrives by history and is also listed is fetched once', async () => {
        const s = setup({ history: ['m1'], inbox: [message('m1')] });
        await s.run();
        expect(s.calls.filter(u => u.includes('/messages/m1?'))).toHaveLength(1);
        const mail = (await s.ref.get()).data();
        expect(Object.values(await itemsOf(s))[0]).toMatchObject({ messageId: 'm1' });
        expect(mail.historyAudit.examined).toBe(0);
    });

    it('marks what the normal path delivered differently from what only the audit found', async () => {
        const s = setup({ history: ['h1'], listing: ['h1', 'old1'], inbox: [message('h1'), message('old1', { filename: 'Consolidated_eStatement_2026FEB_458290.html' })] });
        await s.run();
        const byMessage = Object.fromEntries(Object.values(await itemsOf(s)).map(i => [i.messageId, i]));
        expect(byMessage.h1.via).toBeUndefined();
        expect(byMessage.old1.via).toBe('audit');
    });

    it('audit clauses are whole domains of approved senders only', () => {
        expect(auditClauses([...senders, { id: 'spam@evil.example', kind: 'address', status: 'blocked', domain: 'evil.example' }])).toEqual(['from:nationstrust.com']);
        expect(auditClauses([])).toEqual([]);
    });

    it('pages through a long history and reports when it was cut short', async () => {
        let pages = 0;
        const f = async () => { pages++; return { ok: true, json: async () => ({ messages: [{ id: 'a' + pages }], nextPageToken: 'p' + pages }) }; };
        const out = await listAllMessages('t', f, ['from:x.lk'], { maxPages: 3 });
        expect(out).toMatchObject({ ok: true, complete: false });
        expect(out.ids).toEqual(['a1', 'a2', 'a3']);
    });
});

describe('the audit always makes progress', () => {
    it('gets through a mailbox full of bank mail that is not a statement, to the older statement behind it, fetching each message once', async () => {
        const promo = i => ({ ...message('p' + i, { subject: 'Weekend offers' }), payload: { ...message('p' + i, { subject: 'Weekend offers' }).payload, parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'hi' } }] } });
        const promos = Array.from({ length: 25 }, (_, i) => promo(i));
        const s = setup({ inbox: [...promos, message('real1')], listing: [...promos.map(p => p.id), 'real1'] });
        let runs = 0;
        for (; runs < 8; runs++) {
            await s.run(NOTE, { WF_AUDIT_MAX_IDS: '10' });
            while ((await s.ref.get()).data().pendingCollection) await s.run(NOTE, { WF_AUDIT_MAX_IDS: '10' });
            if ((await s.ref.get()).data().historyAudit?.complete) break;
            await s.ref.set({ lastAuditMs: 0 }, { merge: true });
        }
        expect(runs).toBeLessThan(8);
        expect(Object.values(await itemsOf(s)).map(i => i.messageId)).toEqual(['real1']);
        for (const p of promos) expect(s.calls.filter(u => u.includes(`/messages/${p.id}?`))).toHaveLength(1);
        expect((await s.ref.get()).data().auditVersion).toBe(INTAKE_VERSION);
    });
    it('forgets what it judged when the rules change, so the new rules see everything again', async () => {
        const s = setup({ inbox: [message('x1', { subject: 'Offers', filename: 'Promo.pdf' })], mail: { auditVersion: INTAKE_VERSION - 1, lastAuditMs: 0, auditSeen: { v: INTAKE_VERSION - 1, ids: ['x1'] } } });
        await s.run();
        expect(s.calls.some(u => u.includes('/messages/x1?'))).toBe(true);
    });
});

describe('what is refused is kept on record, never forgotten', () => {
    it('records a bank message whose signature did not verify, with its reason, and does not refetch it under the same rules', async () => {
        const s = setup({ inbox: [message('bad1', { dkim: false })] });
        const out = await s.run();
        expect(out.body).toMatchObject({ ok: true, stored: 0 });
        const mail = (await s.ref.get()).data();
        expect(mail.refused).toHaveLength(1);
        expect(mail.refused[0]).toMatchObject({ messageId: 'bad1', reason: 'dkim-did-not-pass', v: INTAKE_VERSION, filename: 'Consolidated_eStatement_2026MAR_458290.html' });
        expect(mail.historyAudit).toMatchObject({ examined: 1, taken: 0, refused: 1 });
        // a second audit under the same rules accounts for it instead of fetching it again
        await s.ref.set({ lastAuditMs: 0 }, { merge: true });
        const before = s.calls.filter(u => u.includes('/messages/bad1?')).length;
        await s.run();
        expect(s.calls.filter(u => u.includes('/messages/bad1?')).length).toBe(before);
    });

    it('looks again under new rules: an entry made under an older version is examined afresh', async () => {
        const s = setup({ inbox: [message('bad1', { dkim: false })], mail: { auditVersion: INTAKE_VERSION - 1, lastAuditMs: 0,
            refused: [{ messageId: 'bad1', reason: 'dkim-did-not-pass', v: INTAKE_VERSION - 1, at: 1 }] } });
        await s.run();
        expect(s.calls.some(u => u.includes('/messages/bad1?'))).toBe(true);
        expect((await s.ref.get()).data().refused[0]).toMatchObject({ messageId: 'bad1', v: INTAKE_VERSION });
    });

    it('an attachment read as an invoice is recorded too, and so is one that is not a readable kind', async () => {
        const s = setup({ inbox: [message('inv1', { filename: 'Invoice-0008.pdf', subject: 'Invoice' }),
            { ...message('zip1', { filename: 'statement.zip', subject: 'Your statement' }), payload: { ...message('zip1').payload, parts: [{ mimeType: 'application/zip', filename: 'statement.zip', body: { attachmentId: 'z', size: 10 } }] } }] });
        await s.run();
        const refused = Object.fromEntries((await s.ref.get()).data().refused.map(r => [r.messageId, r.reason]));
        expect(refused.inv1).toBe('the-attachment-is-not-a-bank-statement');
        expect(refused.zip1).toBe('no-pdf-attachment');
    });

    it('does not record mail from a sender the owner never approved, or promotional mail with nothing attached', async () => {
        const stranger = message('s1', { from: 'Shop <receipts@shop.example>', dkim: false, filename: 'Invoice.pdf' });
        const promo = { ...message('p1', { subject: 'Weekend offers' }), payload: { ...message('p1', { subject: 'Weekend offers' }).payload, parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'hi' } }] } };
        const s = setup({ history: ['s1', 'p1'], inbox: [stranger, promo] });
        await s.run();
        expect((await s.ref.get()).data().refused || []).toEqual([]);
    });

    it('drops a refusal once that message is taken, and never stores the same message twice', async () => {
        const s = setup({ inbox: [message('m1')], mail: { refused: [{ messageId: 'm1', reason: 'dkim-did-not-pass', v: INTAKE_VERSION - 1, at: 1 }], auditVersion: INTAKE_VERSION - 1, lastAuditMs: 0 } });
        await s.run();
        expect((await s.ref.get()).data().refused).toEqual([]);
        expect(Object.values(await itemsOf(s))).toHaveLength(1);
    });

    it('mergeRefused keeps one row per message, earliest first-seen, newest first, and is bounded', () => {
        const merged = mergeRefused([{ messageId: 'a', at: 5, v: 1 }], [{ messageId: 'a', at: 9, v: 2 }, { messageId: 'b', at: 7, v: 2 }], ['zzz']);
        expect(merged).toEqual([{ messageId: 'a', at: 5, v: 2 }, { messageId: 'b', at: 7, v: 2 }]);
        expect(mergeRefused(null, Array.from({ length: 300 }, (_, i) => ({ messageId: 'm' + i })))).toHaveLength(100);
        expect(mergeRefused(undefined, [{ messageId: '' }, null, 7])).toEqual([]);
    });
});

describe('the owner can take a refused message with one tap', () => {
    const owner = { uid: 'owner', email: 'owner@example.org' };
    it('queues it, and the next collection takes it despite the failed signature, then clears the record', async () => {
        const s = setup({ inbox: [message('bad1', { dkim: false })] });
        await s.run();
        expect((await s.ref.get()).data().refused).toHaveLength(1);
        expect(await takeRefusedMessage({ db: s.db, owner, messageId: 'bad1' })).toEqual({ ok: true, queued: true });
        expect((await s.ref.get()).data().takeQueue).toEqual(['bad1']);
        const out = await s.run();
        expect(out.body).toMatchObject({ ok: true, stored: 1 });
        const items = Object.values(await itemsOf(s));
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ messageId: 'bad1', status: 'pending', via: 'owner' });
        const mail = (await s.ref.get()).data();
        expect(mail.refused).toEqual([]);
        expect(mail.takeQueue).toEqual([]);
    });

    it('an invoice-named attachment is taken on the owner’s word, and only that message', async () => {
        const s = setup({ inbox: [message('inv1', { filename: 'Invoice-0008.pdf', subject: 'Invoice' }), message('inv2', { filename: 'Invoice-0009.pdf', subject: 'Invoice' })] });
        await s.run();
        await takeRefusedMessage({ db: s.db, owner, messageId: 'inv1' });
        await s.run();
        const ids = Object.values(await itemsOf(s)).map(i => i.messageId);
        expect(ids).toEqual(['inv1']);
        expect((await s.ref.get()).data().refused.map(r => r.messageId)).toEqual(['inv2']);
    });

    it('drops a refusal whose message has since been deleted from the mailbox, rather than keeping a ghost', async () => {
        const s = setup({ inbox: [], mail: { refused: [{ messageId: 'gone1', reason: 'dkim-did-not-pass', v: INTAKE_VERSION, at: 1 }], takeQueue: ['gone1'] } });
        await s.run();
        expect((await s.ref.get()).data().refused).toEqual([]);
    });
    it('refuses a message that is not on the refused list, a malformed id, and another owner', async () => {
        const s = setup({ mail: { refused: [{ messageId: 'bad1', reason: 'dkim-did-not-pass', v: 2, at: 1 }] } });
        await s.ready;
        await expect(takeRefusedMessage({ db: s.db, owner, messageId: 'other1234' })).rejects.toThrow('not-a-refused-message');
        await expect(takeRefusedMessage({ db: s.db, owner, messageId: '../x' })).rejects.toThrow('invalid-take-request');
        await expect(takeRefusedMessage({ db: s.db, owner: { uid: 'intruder', email: 'owner@example.org' }, messageId: 'bad1' })).rejects.toThrow('not-your-mailbox');
        expect((await s.ref.get()).data().takeQueue).toBeUndefined();
    });

    it('never lifts the sender rule: a forced message from an address that is not approved is still refused', async () => {
        const s = setup({ inbox: [message('x1', { from: 'Evil <x@evil.example>', dkim: false })], mail: { takeQueue: ['x1'], refused: [{ messageId: 'x1', reason: 'dkim-did-not-pass', v: 2, at: 1 }] } });
        await s.run();
        expect(Object.values(await itemsOf(s))).toHaveLength(0);
    });
});

describe('a bank that writes from a second address', () => {
    const filed = { 'jan.x.1': { uid: 'owner', messageId: 'jan', filename: 'Consolidated_eStatement_2026JAN_458290.html', filed: true, status: 'filed' } };
    it('is taken when its subject calls it a statement — however it is named — and leaves the held list; its document must then prove itself', async () => {
        const s = setup({ items: filed, history: ['sib1'], inbox: [message('sib1', { from: 'NTB E-Statements <estatements@nationstrust.com>' })],
            mail: { held: [{ messageId: 'sib1', key: 'sib1', reason: 'a-new-address-at-a-bank-you-approved', from: 'estatements@nationstrust.com', heldMs: 5 }] } });
        const out = await s.run();
        expect(out.body).toMatchObject({ ok: true, stored: 1 });
        const stored = Object.values(await itemsOf(s)).find(i => i.messageId === 'sib1');
        expect(stored).toMatchObject({ status: 'pending', via: 'sibling', known: true, intent: 'suspect' });
        expect((await s.ref.get()).data().held).toEqual([]);
    });
    it('is taken when the subject is plain but the attachment is named like a statement already filed (a sibling on evidence; the series is the stronger case of the same rule)', async () => {
        const plainFiled = { 'jan.x.1': { uid: 'owner', messageId: 'jan', filename: 'Consolidated_Account_2026JAN_458290.html', filed: true, status: 'filed' } };
        const s = setup({ items: plainFiled, history: ['sib1b'], inbox: [message('sib1b', { from: 'NTB Desk <desk@nationstrust.com>', subject: 'Your documents', filename: 'Consolidated_Account_2026MAR_458290.html' })] });
        await s.run();
        expect(Object.values(await itemsOf(s)).find(i => i.messageId === 'sib1b')).toMatchObject({ status: 'pending', via: 'sibling', known: true, intent: 'suspect' });
    });
    it('a promotion from the bank\'s other address is refused as not a statement (its file name says promotion) — not stored, and nothing is held for the owner', async () => {
        const s = setup({ items: filed, history: ['sib2'], inbox: [message('sib2', { from: 'NTB Offers <offers@nationstrust.com>', filename: 'Weekend_Promotion.html', subject: 'Offers' })] });
        await s.run();
        expect(Object.values(await itemsOf(s)).filter(i => i.messageId === 'sib2')).toHaveLength(0);
        expect((await s.ref.get()).data().held || []).toEqual([]);
    });
    it('is taken even when nothing has been filed yet, because its subject says statement — and it must prove itself before anything is filed', async () => {
        const s = setup({ history: ['sib3'], inbox: [message('sib3', { from: 'NTB E-Statements <estatements@nationstrust.com>' })] });
        await s.run();
        expect(Object.values(await itemsOf(s)).find(i => i.messageId === 'sib3')).toMatchObject({ via: 'sibling', intent: 'suspect' });
    });
    it('is taken when nothing has been filed and nothing in the mail says statement — nothing is held for a decision', async () => {
        const s = setup({ history: ['sib3b'], inbox: [message('sib3b', { from: 'NTB Friends <friends@nationstrust.com>', filename: 'Weekend_Offer.html', subject: 'Offers for you' })] });
        await s.run();
        expect(Object.values(await itemsOf(s)).find(i => i.messageId === 'sib3b')).toMatchObject({ via: 'sibling', intent: 'suspect' });
        expect((await s.ref.get()).data().held || []).toEqual([]);
    });
    it('still needs a passing signature from the bank’s own domain', async () => {
        const s = setup({ items: filed, history: ['sib4'], inbox: [message('sib4', { from: 'NTB E-Statements <estatements@nationstrust.com>', dkim: false })] });
        await s.run();
        expect(Object.values(await itemsOf(s)).filter(i => i.messageId === 'sib4')).toHaveLength(0);
    });
    it('does not release a different bank’s address just because its attachment has the same name', async () => {
        const s = setup({ items: filed, history: ['sib5'], inbox: [{ ...message('sib5', { from: 'Other <statements@otherbank.lk>' }), payload: { ...message('sib5', { from: 'Other <statements@otherbank.lk>' }).payload, headers: [{ name: 'From', value: 'Other <statements@otherbank.lk>' }, { name: 'Subject', value: 'Your e-Statement' }, { name: 'Authentication-Results', value: 'dkim=pass header.i=@otherbank.lk' }] } }] });
        await s.run();
        expect(Object.values(await itemsOf(s)).filter(i => i.messageId === 'sib5')).toHaveLength(0);
    });
});

describe('"waiting on a sender decision" is only what is still a question about the sender', () => {
    const held = id => ({ messageId: id, key: id, reason: 'a-new-address-at-a-bank-you-approved', from: 'estatements@nationstrust.com', heldMs: 5 });
    it('a held message that is judged again and turns out to be a promotion leaves the held list (it used to stay for ever)', async () => {
        const s = setup({ mail: { held: [held('promo1')] }, inbox: [message('promo1', { from: 'NTB Friends <friends@nationstrust.com>', filename: 'Weekend_Promotion_Offer.html', subject: 'Offers for you' })] });
        await s.run();
        const mail = (await s.ref.get()).data();
        expect(mail.held || []).toEqual([]);
        expect(mail.historyAudit).toMatchObject({ held: 0 });
    });
    it('the audit says in the platform log what is held: reason codes and sender domains with counts, never an address or a subject', async () => {
        const s = setup({ mail: { held: [held('keep1')] }, inbox: [message('keep1', { from: 'Someone <someone@nationstrust.com>', dkim: false })] });
        const lines = [];
        const spy = vi.spyOn(console, 'info').mockImplementation(line => lines.push(String(line)));
        try { await s.run(); } finally { spy.mockRestore(); }
        const line = lines.find(l => l.includes('"mail-audit"'));
        expect(line).toBeTruthy();
        const out = JSON.parse(line);
        expect(out).toMatchObject({ evt: 'mail-audit', listed: 1, examined: 1, taken: 0, complete: true });
        expect(Object.values(out.heldAt).reduce((a, b) => a + b, 0)).toBe(out.held);
        expect(line).not.toMatch(/someone@|estatements@|Your e-Statement/);
    });
});
