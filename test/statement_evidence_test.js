import { describe, expect, it } from 'vitest';
import { makeFakeAdmin } from './fake-admin.mjs';
import { syncMailbox } from '../gmail-hook.js';
import { REJECT } from '../wealthflow-mail-ingest.mjs';
import { policyWithReach } from '../bank-reach.mjs';
import { planWithEvidence, evidenceVerdict, evidenceContext, ownerBanks, bankWords, documentProof, knownLast4, bankStillOwned, sameBank } from '../statement-evidence.mjs';
import { discoveryQueries, subjectSkeleton, fileWords, listDiscovery, discoveryCensus, newTally, tally, tallyLine, attachmentKinds } from '../statement-discovery.mjs';
import { planMessage } from '../wealthflow-mail-ingest.mjs';

// THE GAP: every way of finding a bank's mail was keyed on who sent it. A statement from an address nobody listed — an older mailer, a card centre, a relay —
// was a stranger's, held for a tap nobody makes years later. The evidence rule takes it on what the mail SAYS (a statement, of exactly one of the owner's banks),
// that Google says it IS from the domain it claims, and what the DOCUMENT proves; anything less is what it was before.

const approved = (id, name) => ({ id, kind: 'address', status: 'approved', name, domain: id.split('@')[1] });
const OWNER = [approved('e-statements@hnb.lk', 'HNB'), approved('statements@dfccbank.com', 'DFCC Bank'), approved('estatement@info.nationstrust.com', 'NTB')];
const GOOD = (d) => ({ name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.i=@${d}; spf=pass; dmarc=pass header.from=${d}` });
const BAD = (d) => ({ name: 'Authentication-Results', value: `mx.google.com; dkim=fail header.i=@${d}; spf=fail; dmarc=fail header.from=${d}` });
const message = (id, { from = 'Statements <statements@hnb-mailer.example>', domain = 'hnb-mailer.example', subject = 'Your HNB Account Statement for 074-02-XXXXX-88', filename = '074-02-XXXXX-88.pdf', body = '', auth, received = Date.parse('2022-03-04T05:00:00Z') } = {}) => ({
    id, internalDate: String(received),
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, auth || GOOD(domain)], mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/plain', filename: '', body: { data: Buffer.from(body || 'Please find attached.').toString('base64url') } },
            { mimeType: /\.pdf$/i.test(filename) ? 'application/pdf' : 'text/html', filename, body: { attachmentId: 'att-' + id, size: 120 } }] },
});
const ctx = evidenceContext(OWNER);
const policy = policyWithReach(OWNER);

describe('the owner\'s banks, and the words each is called by', () => {
    it('one entry per bank, from the addresses they approved only', () => {
        expect(ownerBanks(OWNER).map((b) => b.name).sort()).toEqual(['DFCC Bank', 'HNB', 'NTB']);
        expect(ownerBanks([{ ...approved('a@x.com', 'HNB'), status: 'blocked' }, { id: 'x.com', kind: 'domain', status: 'new', name: 'HNB' }])).toEqual([]);
        expect(ownerBanks([{ id: 'hnb.lk', kind: 'domain', status: 'approved', name: 'HNB' }]).map((b) => b.name)).toEqual(['HNB']);
        expect(bankWords('HNB')).toEqual(expect.arrayContaining(['hnb', 'hatton national']));
        expect(bankWords('Some Unlisted Finance PLC')).toEqual(['some', 'unlisted']);
        expect(sameBank('DFCC Bank', 'Dfccbank')).toBe(true);
        expect(sameBank('HNB', 'Dfccbank')).toBe(false);
    });
});

describe('a statement from an address nobody listed', () => {
    it('before: held for a tap (sender-not-on-your-list). After: taken on evidence, as another desk of the bank the mail names', () => {
        const m = message('old1');
        expect(planMessage(m, policy)).toMatchObject({ ok: false, reason: REJECT.NOT_ON_YOUR_LIST });
        const plan = planWithEvidence(m, policy, ctx);
        expect(plan.ok).toBe(true);
        expect(plan).toMatchObject({ via: 'evidence', bank: 'HNB', intent: 'suspect' });
        expect(plan.items[0]).toMatchObject({ via: 'evidence', bank: 'HNB', intent: 'suspect', known: true });
    });
    it('the bank is named by the subject, the file name or (failing those) the body — and by the sender\'s own domain; exactly one', () => {
        expect(planWithEvidence(message('b', { subject: 'e-Statement', filename: 'DFCC_Statement_2022JAN.pdf', domain: 'dfcc-mailer.example', from: 'Statements <s@dfcc-mailer.example>' }), policy, ctx)).toMatchObject({ ok: true, bank: 'DFCC Bank' });
        expect(planWithEvidence(message('c', { subject: 'Your monthly statement', filename: 'stmt.pdf', body: 'Dear customer, your Hatton National Bank statement is attached.' }), policy, ctx)).toMatchObject({ ok: true, bank: 'HNB' });
        expect(planWithEvidence(message('d', { subject: 'Your HNB and DFCC statement' }), policy, ctx)).toMatchObject({ ok: false, evidence: { why: 'another-bank-is-named-in-the-subject' } });
    });
    it('NOT taken: no statement word, no bank of theirs named, an invoice, a stranger with nothing to vouch for it', () => {
        expect(planWithEvidence(message('e', { subject: 'HNB offers for you', filename: 'offer.pdf' }), policy, ctx)).toMatchObject({ ok: false, evidence: { why: 'the-subject-and-file-names-do-not-say-statement' } });
        expect(planWithEvidence(message('f', { subject: 'Your account statement', filename: 'statement.pdf', from: 'Accounts <a@accbuddy.example>', domain: 'accbuddy.example' }), policy, ctx)).toMatchObject({ ok: false, evidence: { why: 'no-bank-name-in-the-sender-domain' } });
        expect(planWithEvidence(message('g', { subject: 'HNB statement', filename: 'Invoice_10442.pdf' }), policy, ctx)).toMatchObject({ ok: false, evidence: { why: 'refused-after-release:' + REJECT.NOT_A_STATEMENT_DOC } });       // a file that says invoice is still an invoice
        expect(planWithEvidence(message('h', { subject: 'Your HNB Account Statement' }), policy, evidenceContext([]))).toMatchObject({ ok: false, reason: REJECT.NOT_ON_YOUR_LIST });
    });
    it('a bank named only where its writer typed it — a display name, a Reply-To, a Return-Path, the body of a stranger — is a stranger', () => {
        const spoof = message('s1', { from: '"statements@hnb.lk" <billing@evil.example>', domain: 'evil.example', filename: 'HNB_Statement_202604.pdf', subject: 'HNB statement' });
        expect(planWithEvidence(spoof, policy, ctx)).toMatchObject({ ok: false, evidence: { why: 'no-bank-name-in-the-sender-domain' } });
        const decoy = message('s2', { from: 'Mallory <mallory@evil.example>', domain: 'evil.example', filename: 'NTB_Statement_202604.pdf', subject: 'Your statement' });
        decoy.payload.headers.push({ name: 'Return-Path', value: '<estatement@info.nationstrust.com>' }, { name: 'Reply-To', value: 'estatement@info.nationstrust.com' });
        expect(planWithEvidence(decoy, policy, ctx)).toMatchObject({ ok: false, evidence: { why: 'no-bank-name-in-the-sender-domain' } });
        // the domain carries the name, but the mail is about another bank of theirs
        expect(planWithEvidence(message('s3', { subject: 'Your DFCC statement', filename: 'DFCC_Statement.pdf' }), policy, ctx)).toMatchObject({ ok: false, evidence: { why: 'the-mail-does-not-name-the-bank-of-its-domain' } });
    });
    it('a forgery is never released: SPF/DKIM/DMARC failing, a look-alike of a bank, a block the owner made', () => {
        expect(planWithEvidence(message('i', { auth: BAD('hnb-mailer.example') }), policy, ctx)).toMatchObject({ ok: false, reason: REJECT.AUTH_FAILED });
        expect(planWithEvidence(message('j', { from: 'HNB <statements@hnb.lk.attacker.net>', domain: 'hnb.lk.attacker.net' }), policy, ctx).ok).toBe(false);
        const blocked = [...OWNER, { id: 'statements@hnb-mailer.example', kind: 'address', status: 'blocked', name: '', domain: 'hnb-mailer.example' }];
        expect(planWithEvidence(message('k'), policyWithReach(blocked), evidenceContext(blocked))).toMatchObject({ ok: false, reason: REJECT.SENDER_BLOCKED });
        // signed by another domain than the one it claims
        const other = message('l'); other.payload.headers[2] = GOOD('somebody-else.example');
        expect(planWithEvidence(other, policy, ctx).ok).toBe(false);
    });
    it('a sender the owner approved, or another desk of an approved bank, is judged as before — evidence changes nothing for them', () => {
        const mine = message('m', { from: 'HNB <e-statements@hnb.lk>', domain: 'hnb.lk' });
        expect(planWithEvidence(mine, policy, ctx)).toEqual(planMessage(mine, policy));
        expect(planWithEvidence(mine, policy, ctx).via).toBeUndefined();
    });
    it('evidenceVerdict reads what the message says, never what the sender claims in an address alone', () => {
        const v = evidenceVerdict(message('n'), { from: 'x', subject: '' }, ctx);
        expect(v).toMatchObject({ ok: true, bank: 'HNB', approvedAddress: 'e-statements@hnb.lk' });
        expect(evidenceVerdict(message('o'), {}, { banks: [] })).toEqual({ ok: false, why: 'no-bank-approved' });
    });
});

describe('the document proves what the mail claimed', () => {
    it('it must name the bank, and show one of the accounts the owner already has statements for there', () => {
        const text = 'HATTON NATIONAL BANK PLC  Statement of Account  A/C No 0740200123 88  Opening Balance 0.00';
        expect(documentProof({ text, bank: 'HNB', known: [] })).toEqual({ ok: true });
        expect(documentProof({ text, bank: 'HNB', known: ['2388'] })).toMatchObject({ ok: false });       // "123 88" is not the account 2388
        expect(documentProof({ text: text.replace('123 88', '1232388'), bank: 'HNB', known: ['2388'] })).toEqual({ ok: true });
        expect(documentProof({ text: 'DFCC BANK statement ****2388', bank: 'HNB', known: [] })).toMatchObject({ ok: false, reason: expect.stringContaining('does not name the bank') });
        expect(documentProof({ text: 'HNB statement ****9999', bank: 'HNB', known: ['2388'] })).toMatchObject({ ok: false, reason: expect.stringContaining('none of your accounts') });
        expect(documentProof({ text: '', bank: 'HNB' }).ok).toBe(false);
    });
    it('the accounts known are those already FILED from that bank, whatever label the domain gave it', () => {
        const items = [{ bank: 'Dfccbank', filed: true, last4: '5521' }, { bank: 'DFCC Bank', status: 'filed', last4: '0099' }, { bank: 'Dfccbank', filed: false, last4: '1111' }, { bank: 'HNB', filed: true, last4: '2388' }, { bank: 'HNB', filed: true, last4: '' }];
        expect(knownLast4(items, 'DFCC Bank').sort()).toEqual(['0099', '5521']);
        expect(knownLast4(items, 'HNB')).toEqual(['2388']);
        expect(knownLast4([], 'HNB')).toEqual([]);
    });
    it('revoke the bank and what was taken on its evidence is retired', () => {
        expect(bankStillOwned(OWNER, 'HNB')).toBe(true);
        expect(bankStillOwned(OWNER.filter((e) => e.name !== 'HNB'), 'HNB')).toBe(false);
        expect(bankStillOwned(OWNER, 'Dfccbank')).toBe(true);
    });
});

describe('the other ways of asking Gmail', () => {
    const items = [
        { filed: true, subject: 'Your HNB Account Statement for 074-02-XXXXX-88', filename: '074-02-XXXXX-88.pdf' },
        { filed: true, subject: 'Your HNB Account Statement for 074-02-XXXXX-88 (Jan 2026)', filename: '074-02-XXXXX-88.pdf' },
        { filed: true, subject: 'Nations Trust Bank Consolidated eStatement MAY 2026', filename: 'Consolidated_eStatement_2026MAY_458290.html' },
        { filed: false, subject: 'Something else entirely', filename: 'nothing_special.pdf' },
    ];
    it('subjects and file names lose what changes from month to month', () => {
        expect(subjectSkeleton('Your HNB Account Statement for 074-02-XXXXX-88 (Jan 2026)')).toBe('hnb account statement');
        expect(subjectSkeleton('Nations Trust Bank Consolidated eStatement MAY 2026')).toBe('nations trust bank consolidated estatement');
        expect(fileWords(['Consolidated_eStatement_2026MAY_458290.html', 'Consolidated_eStatement_2026JUN_458290.html', '074-02-XXXXX-88.pdf'])).toEqual(['consolidated']);
    });
    it('keyword (a bank of theirs + a statement word), learned subject, learned file, and any file that says statement — none of them keyed on a sender', () => {
        const q = discoveryQueries({ list: OWNER, items });
        expect(q.map((x) => x.method)).toEqual(['keyword', 'learned-subject', 'learned-subject', 'learned-file', 'file-says']);
        expect(q[0].q).toMatch(/has:attachment \(statement OR estatement.*\) \(.*hnb.*dfcc.*\) -in:trash/);
        expect(q.every((x) => !x.q.includes('from:'))).toBe(true);
        expect(q[1].q).toContain('subject:("hnb account statement")');
        expect(discoveryQueries({ list: [], items: [] }).map((x) => x.method)).toEqual(['file-says']);
    });
    it('lists every query, unions the ids, says what each method found, and survives a query that fails', async () => {
        const seen = [];
        const f = async (url) => {
            const u = decodeURIComponent(String(url)); seen.push(u);
            if (u.includes('subject:')) return { ok: false, status: 500, json: async () => ({}) };
            return { ok: true, json: async () => ({ messages: u.includes('filename:(') ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'b' }, { id: 'c' }] }) };
        };
        const out = await listDiscovery('t', f, discoveryQueries({ list: OWNER, items }));
        expect(out.ids.sort()).toEqual(['a', 'b', 'c']);
        expect(out.methods['learned-subject']).toMatchObject({ failed: 2, listed: 0 });
        expect(out.methods.keyword).toMatchObject({ listed: 2, failed: 0 });
        expect(seen.every((u) => u.includes('includeSpamTrash=true'))).toBe(true);
    });
    it('a mailbox read that is slow is cut at its budget, and says it did not finish', async () => {
        let t = 0; const now = () => (t += 5000);
        const f = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'x' }], nextPageToken: 'n' }) });
        const out = await listDiscovery('t', f, discoveryQueries({ list: OWNER, items }), { budgetMs: 12000, now });
        expect(Object.values(out.methods).some((m) => m.complete === false)).toBe(true);
    });
    it('the census asks Gmail only for sizes (one message at most), never for mail', async () => {
        const urls = [];
        const f = async (url) => { urls.push(decodeURIComponent(String(url))); return { ok: true, json: async () => ({ resultSizeEstimate: 7 }) }; };
        const out = await discoveryCensus('t', f, { clauses: ['from:hnb.lk'], queries: discoveryQueries({ list: OWNER, items }) });
        expect(out).toEqual({ fromBanksWithFile: 7, fromBanksNoFile: 7, keywordFile: 7 });
        expect(urls.every((u) => u.includes('maxResults=1&'))).toBe(true);
    });
    it('a tally says how many were taken, why the rest were dropped, in which years, and in what file kinds — no address, no subject', () => {
        const t = newTally();
        const msg = (y, parts = []) => ({ internalDate: String(Date.parse(`${y}-05-05T00:00:00Z`)), payload: { parts } });
        tally(t, { plan: { ok: true, bank: 'HNB', from: 'S <statements@hnb-mailer.example>' }, message: msg(2021) });
        tally(t, { plan: { ok: true, bank: 'HNB', from: 'S <statements@hnb-mailer.example>' }, message: msg(2022) });
        tally(t, { plan: { ok: false, reason: 'sender-not-on-your-list', evidence: { why: 'no-bank-of-yours-is-named' }, from: 'x@accbuddy.example' }, message: msg(2022) });
        tally(t, { plan: { ok: false, reason: 'no-pdf-attachment', from: 'x@hnb-mailer.example' }, message: msg(2022, [{ filename: 'Statement.csv' }, { filename: 'a.xlsx' }]) });
        const line = tallyLine(t, { of: 9 });
        expect(line).toMatchObject({ evt: 'mail-discovery', judged: 4, taken: { HNB: 2 }, years: { 2021: 1, 2022: 1 }, kinds: { csv: 1, xlsx: 1 }, of: 9 });
        expect(line.dropped).toEqual({ 'no-bank-of-yours-is-named': 1, 'no-pdf-attachment': 1 });
        expect(line.domains['hnb-mailer.example']).toEqual({ taken: 2, dropped: 1 });
        expect(JSON.stringify(line)).not.toMatch(/Statement\.csv|statements@/);
        expect(attachmentKinds({ payload: { parts: [{ filename: 'x.PDF' }, { filename: '' }, { filename: 'noext' }] } })).toEqual({ pdf: 1, none: 1 });
    });
});

// ── from the mailbox to the stored item ──────────────────────────────────────────────────────────────────────────────────────────────
const NOTE = { emailAddress: 'owner@example.org', historyId: '1000' };
function setup({ inbox, senders = OWNER, state = {} }) {
    const fake = makeFakeAdmin(), db = fake.admin.firestore();
    db.runTransaction = async (fn) => {
        const writes = [];
        const result = await fn({ get: (ref) => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)) });
        for (const write of writes) await write();
        return result;
    };
    const ref = db.collection('wf-mail').doc('owner_example_org');
    const queries = [], logs = [], fetches = [];
    const f = async (url) => {
        const u = decodeURIComponent(String(url));
        if (/\/messages\/[^?/]+\?format=full/.test(u)) fetches.push(u);
        if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake' }) };
        if (u.includes('/history?')) return { ok: true, json: async () => ({ historyId: '1000', history: [] }) };
        if (u.includes('/messages?')) {
            queries.push(u);
            // the sender-keyed audit finds nothing; the other ways of asking find the inbox
            const bySender = u.includes('from:');
            return { ok: true, json: async () => ({ messages: bySender ? [] : inbox.map((m) => ({ id: m.id })), resultSizeEstimate: bySender ? 0 : inbox.length }) };
        }
        if (u.includes('/attachments/')) return { ok: true, json: async () => ({ data: Buffer.from('%PDF-1.4 statement').toString('base64url') }) };
        const found = inbox.find((m) => m.id === u.split('/messages/')[1]?.split('?')[0]);
        return found ? { ok: true, json: async () => found } : { ok: false, status: 404, json: async () => ({}) };
    };
    const sync = async () => {
        const original = console.info; console.info = (line) => logs.push(String(line));
        try { return await syncMailbox(db, NOTE, { env: {}, f }); } finally { console.info = original; }
    };
    return { ref, queries, logs, fetches, rerun: async (patch) => { await ref.set({ lastReconcileMs: Date.now(), ...patch }, { merge: true }); return sync(); }, run: async () => {
        await ref.set({ uid: 'owner', email: 'owner@example.org', refresh_token: 'fake', historyId: '999', lastReconcileMs: Date.now(), senders, ...state });
        const original = console.info; console.info = (line) => logs.push(String(line));
        try { return await syncMailbox(db, NOTE, { env: {}, f }); } finally { console.info = original; }
    } };
}

describe('the history audit, with the other ways of asking', () => {
    it('stores a statement of the owner\'s bank from an address nobody listed, drops a statement-word newsletter without a trace, and says what it did', async () => {
        const s = setup({ inbox: [
            message('old1'),
            message('news1', { subject: 'Your account statement is ready', filename: 'statement.pdf', from: 'Accounts <a@accbuddy.example>', domain: 'accbuddy.example' }),
            message('forged1', { auth: BAD('hnb-mailer.example') }),
        ] });
        const out = await s.run();
        expect(out.body).toMatchObject({ ok: true });
        const items = (await s.ref.collection('items').get()).docs.map((d) => d.data());
        expect(items.map((i) => i.messageId)).toEqual(['old1']);
        expect(items[0]).toMatchObject({ bank: 'HNB', via: 'evidence', status: 'pending', intent: 'suspect' });
        const state = (await s.ref.get()).data();
        // never held, never offered, never added to the owner's sender list
        expect((state.held || []).map((h) => h.messageId)).not.toContain('news1');
        expect((state.refused || []).map((h) => h.messageId)).not.toContain('news1');
        expect((state.senders || []).map((e) => e.domain || '')).not.toContain('accbuddy.example');
        // … but on record as judged, and the run said what each way of asking found
        const table = (await s.ref.collection('emails').get()).docs.map((d) => d.data());
        expect(table.find((r) => r.messageId === 'news1')).toMatchObject({ state: 'REFUSED', reason: 'not-a-statement-of-your-banks:no-bank-name-in-the-sender-domain' });
        expect(table.find((r) => r.messageId === 'old1').state).toBe('PROCESSED');
        const events = s.logs.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
        expect(events.find((e) => e.evt === 'mail-discovery-listing')).toMatchObject({ staged: 3 });
        expect(events.find((e) => e.evt === 'mail-discovery')).toMatchObject({ judged: 3, taken: { HNB: 1 }, years: { 2022: 1 } });
        expect(state.discovery).toMatchObject({ v: 1, staged: 3 });
    });
    it('asks again only after its interval — a mailbox is not listed five ways on every push', async () => {
        const s = setup({ inbox: [message('old1')], state: { discovery: { v: 1, at: Date.now() - 60000, more: false } } });
        await s.run();
        expect(s.queries.filter((q) => !q.includes('from:'))).toEqual([]);
        expect((await s.ref.collection('items').get()).docs).toHaveLength(0);
    });
    it('a message dropped for naming no bank of theirs is judged again when they approve a bank that it names', async () => {
        const inbox = [message('seylan1', { subject: 'Your Seylan statement', filename: 'statement.pdf', from: 'S <s@seylan-mailer.example>', domain: 'seylan-mailer.example' })];
        const s = setup({ inbox });
        await s.run();
        expect((await s.ref.collection('items').get()).docs).toHaveLength(0);
        expect(((await s.ref.get()).data().auditSeen || { ids: [] }).ids).not.toContain('seylan1');      // not remembered for good
        // the owner approves Seylan, and (six hours on) the same mailbox is asked again
        await s.rerun({ senders: [...OWNER, approved('statements@seylan.lk', 'Seylan Bank')], discovery: null, lastAuditMs: 0 });
        expect((await s.ref.collection('items').get()).docs.map((d) => d.data().messageId)).toEqual(['seylan1']);
        expect((await s.ref.collection('items').get()).docs[0].data()).toMatchObject({ bank: 'Seylan Bank', via: 'evidence' });
        // …and a message dropped under the SAME approvals is not fetched again
        const before = s.fetches.length, calls = s.queries.length;
        await s.rerun({ discovery: null, lastAuditMs: 0 });
        expect((await s.ref.collection('items').get()).docs).toHaveLength(1);
        expect(s.queries.length).toBeGreaterThan(calls);                  // it asked again …
        expect(s.fetches.length).toBe(before);                            // … and read nothing it had already judged
    });
});
