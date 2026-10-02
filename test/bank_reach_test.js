import { describe, expect, it } from 'vitest';
import { makeFakeAdmin } from './fake-admin.mjs';
import { syncMailbox } from '../gmail-hook.js';
import { planMessage } from '../wealthflow-mail-ingest.mjs';
import { policyFrom, approvedDomainClauses, approvedClauses } from '../wealthflow-mail-senders.mjs';
import { reachDomains, institutionRelation, policyWithReach, auditQuery } from '../bank-reach.mjs';

// The owner approves ONE address per bank. The history audit searched only that address's domain, so a bank's earlier statements — from its previous
// registered domain (dfcc.lk) — were never listed, never judged, never filed. A bank the owner approved is searched under every domain the institutions
// registry holds for it, and mail from one of those domains is that bank writing from another desk, decided on evidence.

const approved = (id, name) => ({ id, kind: 'address', status: 'approved', name, domain: id.split('@')[1] });
const OWNER = [approved('e-statements@hnb.lk', 'HNB'), approved('statements@dfccbank.com', 'DFCC Bank'), approved('estatement@info.nationstrust.com', 'NTB'), approved('nationstrust@estmt.nationstrust.com', 'AMEX')];

describe('which domains a bank the owner approved is searched under', () => {
    it('every registered domain of the four banks, beyond the ones already searched', () => {
        expect(reachDomains(OWNER)).toEqual(['americanexpress.com', 'amex.com', 'dfcc.lk', 'nationstrust.com']);
    });
    it('a bank the owner has not approved is never searched', () => {
        expect(reachDomains([approved('statements@dfccbank.com', 'DFCC Bank')])).toEqual(['dfcc.lk']);
        expect(reachDomains([])).toEqual([]);
        expect(reachDomains([{ ...approved('statements@dfccbank.com', 'DFCC Bank'), status: 'blocked' }])).toEqual([]);
    });
    it('the history audit lists them, beside the approved domains; the recent-mail query is unchanged', () => {
        const clauses = auditQuery(OWNER);
        for (const c of ['from:hnb.lk', 'from:dfccbank.com', 'from:info.nationstrust.com', 'from:estmt.nationstrust.com', 'from:dfcc.lk', 'from:americanexpress.com']) expect(clauses).toContain(c);
        expect(approvedDomainClauses(OWNER)).not.toContain('from:dfcc.lk');         // the exact-approval clauses themselves are unchanged
        expect(approvedClauses(OWNER).every(c => c.includes('@'))).toBe(true);
    });
});

describe('a registered domain of a bank they approved is that bank writing from another desk', () => {
    it('relation: only a registered domain (anchored at a label boundary), only for a bank with an approved address', () => {
        expect(institutionRelation(OWNER, 'DFCC Bank <statements@dfcc.lk>')).toMatchObject({ approvedAddress: 'statements@dfccbank.com', name: 'DFCC Bank', via: 'institution' });
        expect(institutionRelation(OWNER, 'e@mail.dfcc.lk')).not.toBeNull();
        expect(institutionRelation(OWNER, 'DFCC Bank <statements@dfcc.lk.attacker.net>')).toBeNull();     // anyone can write a bank's name in a display name or a look-alike domain
        expect(institutionRelation(OWNER, '"DFCC Bank" <support@evil.example>')).toBeNull();
        expect(institutionRelation([approved('e-statements@hnb.lk', 'HNB')], 'statements@dfcc.lk')).toBeNull();     // a bank they have not approved
        expect(institutionRelation(OWNER, 'Seylan <alerts@seylan.lk>')).toBeNull();
    });
});

// ── an old-domain statement, from the mailbox to the stored item ────────────────────────────────────────────────────────────────────
const NOTE = { emailAddress: 'owner@example.org', historyId: '1000' };
const DKIM = (d) => ({ name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.i=@${d}; spf=pass; dmarc=pass header.from=${d}` });
const message = (id, { from, filename, domain, subject = 'Your statement', received = Date.parse('2021-06-03T05:00:00Z') }) => ({
    id, internalDate: String(received),
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, DKIM(domain)], mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'x' } }, { mimeType: /\.pdf$/i.test(filename) ? 'application/pdf' : 'text/html', filename, body: { attachmentId: 'att-' + id, size: 120 } }] },
});

describe('planMessage', () => {
    it('an old-domain statement of a bank they approved is taken (it was held, "waiting on a sender decision", for ever)', () => {
        const plan = planMessage(message('old1', { from: 'DFCC Bank <statements@dfcc.lk>', filename: 'DFCC_Statement_202106.pdf', domain: 'dfcc.lk' }), policyWithReach(OWNER));
        expect(planMessage(message('old1', { from: 'DFCC Bank <statements@dfcc.lk>', filename: 'DFCC_Statement_202106.pdf', domain: 'dfcc.lk' }), policyFrom(OWNER)).ok).toBe(false);      // before
        expect(plan.ok).toBe(true);
        expect(plan.bank).toBe('DFCC Bank');
    });
    it('an invoice from the same old domain is still refused, a signature that fails is still refused, a stranger is still not on the list', () => {
        const policy = policyWithReach(OWNER);
        expect(planMessage(message('inv', { from: 'DFCC Bank <billing@dfcc.lk>', filename: 'Invoice_10442.pdf', domain: 'dfcc.lk' }), policy).ok).toBe(false);
        const forged = message('forged', { from: 'DFCC Bank <statements@dfcc.lk>', filename: 'DFCC_Statement_202106.pdf', domain: 'dfcc.lk' });
        forged.payload.headers[2] = { name: 'Authentication-Results', value: 'mx.google.com; dkim=fail header.i=@dfcc.lk; spf=fail; dmarc=fail header.from=dfcc.lk' };
        expect(planMessage(forged, policy).ok).toBe(false);
        expect(planMessage(message('spoof', { from: 'DFCC Bank <statements@dfcc-lk.example>', filename: 'DFCC_Statement_202106.pdf', domain: 'dfcc-lk.example' }), policy).ok).toBe(false);
    });
});

function setup({ inbox }) {
    const fake = makeFakeAdmin(), db = fake.admin.firestore();
    db.runTransaction = async fn => {
        const writes = [];
        const result = await fn({ get: ref => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)) });
        for (const write of writes) await write();
        return result;
    };
    const ref = db.collection('wf-mail').doc('owner_example_org');
    const queries = [];
    const f = async url => {
        const u = decodeURIComponent(String(url));
        if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake' }) };
        if (u.includes('/history?')) return { ok: true, json: async () => ({ historyId: '1000', history: [] }) };
        if (u.includes('/messages?')) { queries.push(u); return { ok: true, json: async () => ({ messages: inbox.map(m => ({ id: m.id })) }) }; }
        if (u.includes('/attachments/')) return { ok: true, json: async () => ({ data: Buffer.from('%PDF-1.4 statement').toString('base64url') }) };
        const found = inbox.find(m => m.id === u.split('/messages/')[1]?.split('?')[0]);
        return found ? { ok: true, json: async () => found } : { ok: false, status: 404, json: async () => ({}) };
    };
    return { ref, queries, run: async () => { await ref.set({ uid: 'owner', email: 'owner@example.org', refresh_token: 'fake', historyId: '999', lastReconcileMs: Date.now(), senders: OWNER }); return syncMailbox(db, NOTE, { env: {}, f }); } };
}

describe('the history audit', () => {
    it('lists the bank\'s other registered domains and stores a statement from one of them, which the owner would otherwise never have got', async () => {
        const s = setup({ inbox: [message('old1', { from: 'DFCC Bank <statements@dfcc.lk>', filename: 'DFCC_Statement_202106.pdf', domain: 'dfcc.lk' }), message('old2', { from: 'Seylan <alerts@seylan.lk>', filename: 'Statement_202106.pdf', domain: 'seylan.lk' })] });
        const out = await s.run();
        expect(out.body).toMatchObject({ ok: true });
        expect(s.queries.some(q => q.includes('from:dfcc.lk'))).toBe(true);
        const items = (await s.ref.collection('items').get()).docs.map(d => d.data());
        expect(items.map(i => i.messageId)).toContain('old1');
        expect(items.find(i => i.messageId === 'old1').bank).toBe('DFCC Bank');
        expect(items.map(i => i.messageId)).not.toContain('old2');          // a bank they never approved
    });
});
