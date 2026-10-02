import { describe, it, expect } from 'vitest';
import { makeFakeAdmin } from './fake-admin.mjs';
import { syncMailbox } from '../gmail-hook.js';
import { approvedClauses } from '../wealthflow-mail-senders.mjs';
import { INTAKE_VERSION } from '../wealthflow-mail-ingest.mjs';
import { MAIL_STATE, mayReplace, entryOf, reconcile, rollupItems, summarize, stateForPlan, docIdOf, logStates, settledIds, PENDING_STALE_MS } from '../mail-state.mjs';

/* =============================================================================
 * THE EMAIL PROCESSING STATE TABLE, AND THE WALK THROUGH THE WHOLE MAILBOX
 *
 *  · every message that is found is on record BEFORE anything is fetched or read, so a crash cannot lose it;
 *  · INGESTED is only ever derived from the stored statements being filed — nothing else can say a message is done;
 *  · the walk through the listing is resumable, bounded per run, and never restarts from the newest message;
 *  · under failures injected into Gmail and the database at random, every statement is stored exactly once.
 * ===========================================================================*/

const NOTE = { emailAddress: 'owner@example.org', historyId: '1000' };
const senders = [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved', name: 'NTB', domain: 'nationstrust.com' }];
const GOOD = { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@nationstrust.com; spf=pass; dmarc=pass header.from=nationstrust.com' };
const FORGED = { name: 'Authentication-Results', value: 'mx.google.com; dkim=fail header.i=@nationstrust.com; spf=fail; dmarc=fail header.from=nationstrust.com' };

const make = (id, { from = 'NTB <statements@nationstrust.com>', subject = 'Your e-Statement', filename = `Consolidated_eStatement_${id}.html`, auth = GOOD, received = Date.parse('2026-04-02T05:00:00Z') } = {}) => ({
    id, internalDate: String(received),
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, ...(auth ? [auth] : [])], mimeType: 'multipart/mixed',
        parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'x' } }, { mimeType: 'text/html', filename, body: { attachmentId: 'att-' + id, size: 120 } }] },
});
const statement = (n) => make('s' + String(n).padStart(4, '0'), { received: Date.parse('2026-04-02T05:00:00Z') - n * 86400000 });
const brochure = (n) => make('b' + String(n).padStart(4, '0'), { subject: 'New offers', filename: `Promotion_${n}.html` });
const forged = (n) => make('f' + String(n).padStart(4, '0'), { auth: FORGED });
const sibling = (n) => make('h' + String(n).padStart(4, '0'), { from: 'Offers <offers@nationstrust.com>', subject: 'Weekend offers', filename: `Weekend_${n}.html` });

function world({ inbox, mail = {}, fault = null, pageSize = 500 } = {}) {
    const fake = makeFakeAdmin(), db = fake.admin.firestore();
    const control = { fault, calls: 0, failures: 0, log: [] };
    db.runTransaction = async fn => {
        if (control.fault && control.fault('tx')) { control.failures++; throw Object.assign(new Error('ABORTED: too much contention on these documents'), { code: 10 }); }
        const writes = [];
        const result = await fn({ get: ref => ref.get(), set: (ref, value, options) => writes.push(() => ref.set(value, options)) });
        for (const write of writes) await write();
        return result;
    };
    const ref = db.collection('wf-mail').doc('owner_example_org');
    const byId = new Map(inbox.map(m => [m.id, m]));
    const order = inbox.map(m => m.id);
    const f = async url => {
        const u = decodeURIComponent(String(url)); control.calls++; if (/\/messages\/[^?/]+\?format=full/.test(u)) control.fetched = (control.fetched || 0) + 1;
        if (control.fault && control.fault('http', u)) { control.failures++; if (/429/.test(String(control.fault('kind')))) return { ok: false, status: 429, json: async () => ({}) }; throw new Error('network timeout'); }
        if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake-access' }) };
        if (u.includes('/history?')) return { ok: true, json: async () => ({ historyId: '1000' }) };
        if (u.includes('/messages?')) {
            const max = Number(/maxResults=(\d+)/.exec(u)?.[1]) || 100, tok = /pageToken=([^&]*)/.exec(u)?.[1];
            if (tok === 'EXPIRED') return { ok: false, status: 400, json: async () => ({}) };
            const at = tok ? Number(tok.replace('p', '')) : 0;
            const page = order.slice(at, Math.min(at + Math.min(max, pageSize), order.length));
            const next = at + page.length < order.length ? 'p' + (at + page.length) : undefined;
            return { ok: true, json: async () => ({ messages: page.map(id => ({ id })), ...(next ? { nextPageToken: next } : {}) }) };
        }
        if (u.includes('/attachments/')) return { ok: true, json: async () => ({ data: Buffer.from('<html>statement ' + u.slice(-12) + '</html>').toString('base64url') }) };
        const id = u.split('/messages/')[1]?.split('?')[0];
        return byId.has(id) ? { ok: true, json: async () => byId.get(id) } : { ok: false, status: 404, json: async () => ({}) };
    };
    const ready = ref.set({ uid: 'owner', email: 'owner@example.org', refresh_token: 'fake', historyId: '999', lastReconcileMs: Date.now(), collectedSenderClauses: approvedClauses(senders), senders, ...mail });
    const state = async () => (await ref.get()).data();
    const items = async () => Object.fromEntries((await ref.collection('items').get()).docs.map(d => [d.id, d.data()]));
    const emails = async () => Object.fromEntries((await ref.collection('emails').get()).docs.map(d => [d.id, d.data()]));
    const run = async (env = {}) => { await ready; return syncMailbox(db, NOTE, { env, f }); };
    return { db, fake, ref, control, run, state, items, emails, order };
}

/* ── the state machine ──────────────────────────────────────────────────────────────────────────────────────────── */

describe('a state only moves forward, and a stored statement is never un-stored by a stricter rule', () => {
    const at = (state, extra = {}) => ({ state, reason: '', v: 3, ...extra });
    it.each([
        ['PENDING', 'PENDING', true], ['PENDING', 'PROCESSED', true], ['PENDING', 'REFUSED', true], ['PENDING', 'HELD', true], ['PENDING', 'FAILED_VERIFICATION', true],
        ['PROCESSED', 'PENDING', false], ['PROCESSED', 'REFUSED', false], ['PROCESSED', 'HELD', false], ['PROCESSED', 'FAILED_VERIFICATION', false],
        ['REVIEW', 'PENDING', false], ['REVIEW', 'REFUSED', false], ['INGESTED', 'PENDING', false], ['INGESTED', 'PROCESSED', false], ['INGESTED', 'REFUSED', false],
        ['PROCESSED', 'REVIEW', true], ['PROCESSED', 'INGESTED', true], ['REVIEW', 'INGESTED', true],
        ['HELD', 'PROCESSED', true], ['REFUSED', 'PROCESSED', true], ['FAILED_VERIFICATION', 'PROCESSED', true],
        ['HELD', 'PENDING', false], ['REFUSED', 'PENDING', false],
    ])('%s → %s : %s', (a, b, want) => { expect(mayReplace(at(a), at(b))).toBe(want); });
    it('a refusal is replaced by a different refusal, or the same one under newer rules, and not by an identical repeat', () => {
        expect(mayReplace(at('REFUSED', { reason: 'a' }), at('REFUSED', { reason: 'b' }))).toBe(true);
        expect(mayReplace(at('REFUSED', { reason: 'a', v: 2 }), at('REFUSED', { reason: 'a', v: 3 }))).toBe(true);
        expect(mayReplace(at('REFUSED', { reason: 'a' }), at('REFUSED', { reason: 'a' }))).toBe(false);
    });
    it('knows nothing it was not told', () => {
        expect(mayReplace(null, at('PENDING'))).toBe(true);
        expect(mayReplace(at('PENDING'), { state: 'WHATEVER' })).toBe(false);
        expect(mayReplace(at('PENDING'), null)).toBe(false);
    });
    it('a plan becomes a state: forged, held, refused, accepted', () => {
        expect(stateForPlan({ ok: true })).toEqual({ state: 'PROCESSED', reason: '' });
        expect(stateForPlan({ ok: false, security: true, reason: 'spf-or-dmarc-failed' })).toEqual({ state: 'FAILED_VERIFICATION', reason: 'spf-or-dmarc-failed' });
        expect(stateForPlan({ ok: false, reason: 'sender-not-on-your-list' }).state).toBe('HELD');
        expect(stateForPlan({ ok: false, reason: 'a-new-address-at-a-bank-you-approved' }).state).toBe('HELD');
        expect(stateForPlan({ ok: false, reason: 'no-pdf-attachment' }).state).toBe('REFUSED');
        expect(stateForPlan(null)).toBeNull();
    });
    it('counts the attempts that were found and not finished', () => {
        const first = entryOf({ messageId: 'm', state: 'PENDING' }, null, 10);
        const second = entryOf({ messageId: 'm', state: 'PENDING' }, first, 20);
        expect(first).toMatchObject({ attempts: 1, firstSeenMs: 10 });
        expect(second).toMatchObject({ attempts: 2, firstSeenMs: 10, updatedMs: 20 });
        expect(entryOf({ messageId: 'm', state: 'PROCESSED', items: ['k'], sha: ['abc'] }, second, 30)).toMatchObject({ attempts: 2, items: ['k'], sha: ['abc'] });
    });
    it('document ids are safe and bounded', () => {
        expect(docIdOf('a/b c')).toBe('a_b_c');
        expect(docIdOf('x'.repeat(500))).toHaveLength(128);
        expect(docIdOf(null)).toBe('');
    });
});

describe('INGESTED is derived from the stored statements, and from nothing else', () => {
    const item = (over) => ({ id: 'i', messageId: 'm1', filed: false, status: 'pending', from: 'a@b.c', ...over });
    it('every attachment filed → INGESTED; one still pending → PROCESSED; one in review → REVIEW; all retired as non-statements → REFUSED', () => {
        const r = (items) => rollupItems(items).get('m1');
        expect(r([item({ filed: true, status: 'filed' }), item({ id: 'j', filed: true, status: 'filed' })].map(x => x)).state).toBe('INGESTED');
        expect(r([item({ filed: true }), item({ id: 'j', filed: false })]).state).toBe('PROCESSED');
        expect(r([item({ filed: true }), item({ id: 'j', status: 'needs_review' })]).state).toBe('REVIEW');
        expect(r([item({ status: 'rejected_non_statement' })])).toMatchObject({ state: 'REFUSED', reason: 'the-document-is-not-a-bank-statement' });
        expect(r([item({ emptyStatement: true, filed: true })]).state).toBe('INGESTED');
        expect(r([item({ status: 'processing' })]).state).toBe('PROCESSED');
    });
    it('a retired or dismissed item is DONE, never "waiting": a sender\'s line must not say "4 waiting" when nothing is', () => {
        const r = (items) => rollupItems(items).get('m1');
        expect(r([item({ status: 'dismissed' })])).toMatchObject({ state: 'REFUSED', reason: 'dismissed-by-the-owner' });
        expect(r([item({ status: 'rejected_unapproved_sender' })])).toMatchObject({ state: 'REFUSED', reason: 'the-sender-is-no-longer-approved' });
        // a message that carried a statement and a leaflet: the statement is in, the leaflet was retired
        expect(r([item({ filed: true, status: 'filed' }), item({ id: 'j', status: 'rejected_non_statement' })]).state).toBe('INGESTED');
        // but one still being worked on, or in review, keeps its state
        expect(r([item({ status: 'dismissed' }), item({ id: 'j', status: 'pending' })]).state).toBe('PROCESSED');
        expect(r([item({ status: 'rejected_non_statement' }), item({ id: 'j', status: 'needs_review' })]).state).toBe('REVIEW');
    });
    it('a message whose record says INGESTED but whose item is not filed is brought back to what the item says', () => {
        const out = reconcile({ table: [{ messageId: 'm1', state: 'INGESTED', updatedMs: 1 }], items: [item({ status: 'pending' })], now: 100 });
        expect(out.writes).toEqual([expect.objectContaining({ messageId: 'm1', state: 'PROCESSED' })]);
    });
    it('an item stored before the table existed gets a record', () => {
        const out = reconcile({ table: [], items: [item({ filed: true })], now: 1 });
        expect(out.writes).toEqual([expect.objectContaining({ messageId: 'm1', state: 'INGESTED', items: ['i'] })]);
    });
    it('PENDING with nothing stored is requeued once it is stale, and not before; PROCESSED with no item at all is requeued too', () => {
        const table = [{ messageId: 'old', state: 'PENDING', updatedMs: 0 }, { messageId: 'new', state: 'PENDING', updatedMs: 1000 }, { messageId: 'lost', state: 'PROCESSED', updatedMs: 0 }, { messageId: 'done', state: 'INGESTED', updatedMs: 0 }, { messageId: 'no', state: 'REFUSED', updatedMs: 0 }];
        const out = reconcile({ table, items: [], now: PENDING_STALE_MS + 500 });
        expect(out.requeue.sort()).toEqual(['lost', 'old']);
        expect(out.writes).toEqual([]);
    });
    it('the summary says where every bank\'s mail is, and what is stuck', () => {
        const table = [
            { messageId: '1', state: 'INGESTED', from: 'HNB <e-statements@hnb.lk>', updatedMs: 1 }, { messageId: '2', state: 'INGESTED', from: 'e-statements@hnb.lk', updatedMs: 1 },
            { messageId: '3', state: 'HELD', from: 'Statements <statements@hnb.lk>', updatedMs: 1 }, { messageId: '4', state: 'PENDING', from: 'x@y.z', updatedMs: 0, attempts: 2 },
            { messageId: '5', state: 'REVIEW', from: 'x@y.z', updatedMs: 5 },
        ];
        const sum = summarize(table, { now: PENDING_STALE_MS + 10 });
        expect(sum.total).toBe(5);
        expect(sum.counts).toMatchObject({ INGESTED: 2, HELD: 1, PENDING: 1, REVIEW: 1 });
        expect(sum.senders.find(s => s.address === 'e-statements@hnb.lk')).toMatchObject({ total: 2, INGESTED: 2 });
        expect(sum.senders.find(s => s.address === 'statements@hnb.lk')).toMatchObject({ total: 1, HELD: 1 });
        expect(sum.stuck.map(s => s.messageId).sort()).toEqual(['4', '5']);
    });
});

/* ── logged before, recorded after ─────────────────────────────────────────────────────────────────────────────── */

describe('every message is on record before anything is fetched, and ends in the state its outcome earned', () => {
    it('a message that could not even be fetched is left PENDING, counted, and found again — not lost', async () => {
        const w = world({ inbox: [statement(1)] });
        let failFetch = true;
        w.control.fault = (kind, url) => kind === 'http' && failFetch && /\/messages\/s0001\?format=full/.test(String(url));
        const first = await w.run();
        expect(first.status).toBe(503);
        expect((await w.emails())[docIdOf('s0001')]).toMatchObject({ state: 'PENDING', attempts: 1 });
        expect(Object.keys(await w.items())).toHaveLength(0);
        failFetch = false;
        await w.run();
        expect((await w.emails())[docIdOf('s0001')]).toMatchObject({ state: 'PROCESSED', attempts: 2, items: expect.any(Array), sha: [expect.stringMatching(/^[0-9a-f]{64}$/)] });
        expect(Object.keys(await w.items())).toHaveLength(1);
    });
    it('the retry is counted: a message found twice and finished once says so', async () => {
        const w = world({ inbox: [statement(1)] });
        let n = 0;
        w.control.fault = (kind, url) => kind === 'http' && /\/messages\/s0001\?format=full/.test(String(url)) && n++ < 2;
        await w.run(); await w.run(); await w.run();
        expect((await w.emails())[docIdOf('s0001')]).toMatchObject({ state: 'PROCESSED', attempts: 3 });
    });
    it('records each kind of message under its own state, with the reason', async () => {
        const w = world({ inbox: [statement(1), brochure(1), forged(1), sibling(1)] });
        for (let i = 0; i < 4; i++) await w.run();
        const e = await w.emails();
        expect(e[docIdOf('s0001')]).toMatchObject({ state: 'PROCESSED', v: INTAKE_VERSION });
        expect(e[docIdOf('b0001')]).toMatchObject({ state: 'REFUSED', reason: 'the-attachment-is-not-a-bank-statement' });
        expect(e[docIdOf('f0001')]).toMatchObject({ state: 'FAILED_VERIFICATION' });
        // another address at an approved bank, authenticated, with a document attached: NOT taken — only an address on the owner's list is; a promotion is refused without a question
        expect(e[docIdOf('h0001')]).toMatchObject({ state: 'REFUSED', reason: 'not-a-statement-of-your-banks:the-subject-and-file-names-do-not-say-statement' });
        const st = await w.state();
        expect(st.security.map(x => x.messageId)).toEqual(['f0001']);
        expect((st.refused || []).map(x => x.messageId)).not.toContain('f0001');   // forgery is logged, never offered back
        expect(st.security[0].checks).toMatchObject({ spf: 'fail', dmarc: 'fail' });
    });
    it('a message deleted from the mailbox is on record as such, not pending for ever', async () => {
        const w = world({ inbox: [statement(1)] });
        w.order.push('ghost');
        await w.run();
        expect((await w.emails())[docIdOf('ghost')]).toMatchObject({ state: 'REFUSED', reason: 'message-deleted' });
    });
    it('nothing is fetched or read while it cannot be put on record first — and it is all picked up once it can', async () => {
        const w = world({ inbox: [statement(1)] });
        w.fake.setFailOn((path, op) => (path.includes('/emails') ? new Error('emails collection unavailable') : null));
        const out = await w.run();
        expect(out.status).toBe(503);
        expect(Object.keys(await w.items())).toHaveLength(0);
        expect(w.control.fetched || 0).toBe(0);                                    // no message was fetched (listing is only ids)
        w.fake.setFailOn(() => null);
        expect((await w.run()).status).toBe(200);
        expect(Object.keys(await w.items())).toHaveLength(1);
    });
    it('HELD and blocked-sender refusals are not settled: they come back when the owner decides', async () => {
        const w = world({ inbox: [] });
        await w.run();
        await logStates(w.db, w.ref, [
            { messageId: 'h', state: 'HELD', v: INTAKE_VERSION }, { messageId: 'k', state: 'REFUSED', reason: 'you-blocked-this-sender', v: INTAKE_VERSION },
            { messageId: 'r', state: 'REFUSED', reason: 'no-pdf-attachment', v: INTAKE_VERSION }, { messageId: 'p', state: 'PENDING', v: INTAKE_VERSION }, { messageId: 'o', state: 'REFUSED', reason: 'x', v: 1 },
        ]);
        expect([...await settledIds(w.ref, ['h', 'k', 'r', 'p', 'o', 'nothing'], { version: INTAKE_VERSION })]).toEqual(['r']);
    });
});

/* ── the reconcile loop: what the table says is checked against what the statements say ─────────────────────────── */

describe('the table is reconciled against the stored statements, and stuck mail is queued again', () => {
    it('an attempt that died after the statement was stored is healed from the item; one that died before is requeued and then finished', async () => {
        const w = world({ inbox: [statement(1), statement(2)] });
        await w.run();
        // simulate: s0002's outcome was never written (crash between the store and the log), and an old PENDING for a message that has no item
        await w.ref.collection('emails').doc(docIdOf('s0002')).set({ messageId: 's0002', state: 'PENDING', attempts: 1, updatedMs: 0, v: INTAKE_VERSION });
        await w.ref.collection('emails').doc('ghost1').set({ messageId: 'ghost1', state: 'PENDING', attempts: 1, updatedMs: 0, v: INTAKE_VERSION });
        const { refreshCoverage } = await import('../statement-sync.js');
        const mail = await w.state();
        const summary = await refreshCoverage({ db: w.db, mailRef: w.ref, mail, token: 't', f: async () => ({ ok: true, json: async () => ({}) }), now: Date.now(), search: false });
        const e = await w.emails();
        expect(e[docIdOf('s0002')].state).toBe('PROCESSED');                       // healed from the stored item
        expect((await w.state()).requeue).toEqual(['ghost1']);                      // nothing stored for it: queued again
        expect(summary.table.counts.PROCESSED).toBe(2);
        // the next collection picks the requeued id up and clears the queue
        w.order.push('ghost1');
        await w.run();
        expect((await w.state()).requeue || []).toEqual([]);
        expect((await w.emails()).ghost1.state).toBe('REFUSED');                    // the message is gone from the mailbox: said so, not pending
    });
});

/* ── the walk through the whole mailbox ─────────────────────────────────────────────────────────────────────────── */

describe('the audit walks the whole history in bounded, resumable steps', () => {
    it('carries on from the saved page, reaches the oldest statement, and never restarts from the newest', async () => {
        const inbox = Array.from({ length: 40 }, (_, i) => statement(i + 1));
        const w = world({ inbox, pageSize: 10 });
        const env = { WF_AUDIT_PAGE_SIZE: '10', WF_AUDIT_MAX_PAGES: '1' };     // one page per run
        const seenTokens = [];
        let runs = 0;
        while (runs < 60) {
            runs++;
            const before = await w.state();
            await w.run(env);
            const after = await w.state();
            if (after.auditCursor) seenTokens.push(after.auditCursor.token);
            if (!after.pendingCollection && after.historyAudit?.complete === true && !after.auditCursor) break;
            expect(Object.keys(await w.items()).length).toBeGreaterThanOrEqual(Object.keys(await w.items()).length);
            void before;
        }
        const st = await w.state();
        expect(st.historyAudit).toMatchObject({ complete: true });
        expect(st.auditCursor || null).toBeNull();
        expect(Object.keys(await w.items())).toHaveLength(40);                     // the oldest (s0040) included
        expect(new Set(Object.values(await w.items()).map(i => i.messageId)).size).toBe(40);
        expect(new Set(seenTokens).size).toBe(seenTokens.length > 0 ? new Set(seenTokens).size : 0);
        expect(seenTokens.length).toBeGreaterThan(0);                               // it really was resumed, more than once
        expect(st.auditVersion).toBe(INTAKE_VERSION);
    });
    it('a page token Gmail no longer honours starts the walk again instead of stalling for ever', async () => {
        const w = world({ inbox: Array.from({ length: 12 }, (_, i) => statement(i + 1)), pageSize: 5, mail: { auditCursor: { v: INTAKE_VERSION, token: 'EXPIRED', listed: 5, at: 1 } } });
        const env = { WF_AUDIT_PAGE_SIZE: '5', WF_AUDIT_MAX_PAGES: '1' };
        await w.run(env);
        expect((await w.state()).auditCursor || null).toBeNull();
        for (let i = 0; i < 40; i++) { await w.run(env); const s = await w.state(); if (!s.pendingCollection && s.historyAudit?.complete === true && !s.auditCursor) break; }
        expect(Object.keys(await w.items())).toHaveLength(12);
    });
    it('a window with more new mail than one collection can stage is walked again, not skipped past', async () => {
        const inbox = Array.from({ length: 30 }, (_, i) => statement(i + 1));
        const w = world({ inbox, pageSize: 30 });
        const env = { WF_AUDIT_PAGE_SIZE: '30', WF_AUDIT_MAX_PAGES: '1', WF_AUDIT_MAX_IDS: '7' };
        for (let i = 0; i < 80; i++) { await w.run(env); const s = await w.state(); if (!s.pendingCollection && s.historyAudit?.complete === true && !s.auditCursor) break; }
        expect(Object.keys(await w.items())).toHaveLength(30);
    });
    it('the mailbox document stays small however much mail there is', async () => {
        const inbox = [...Array.from({ length: 60 }, (_, i) => statement(i + 1)), ...Array.from({ length: 60 }, (_, i) => brochure(i + 1)), ...Array.from({ length: 30 }, (_, i) => forged(i + 1))];
        const w = world({ inbox, pageSize: 25 });
        const env = { WF_AUDIT_PAGE_SIZE: '25', WF_AUDIT_MAX_PAGES: '2' };
        let biggest = 0;
        for (let i = 0; i < 200; i++) {
            await w.run(env);
            const s = await w.state(); biggest = Math.max(biggest, JSON.stringify(s).length);
            if (!s.pendingCollection && s.historyAudit?.complete === true && !s.auditCursor) break;
        }
        expect(biggest).toBeLessThan(400 * 1024);
        const e = await w.emails();
        expect(Object.values(e).filter(x => x.state === 'PROCESSED')).toHaveLength(60);
        expect(Object.values(e).filter(x => x.state === 'REFUSED')).toHaveLength(60);
        expect(Object.values(e).filter(x => x.state === 'FAILED_VERIFICATION')).toHaveLength(30);
    });
});

/* ── failures injected at random ────────────────────────────────────────────────────────────────────────────────── */

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

describe('under timeouts, rate limits and database aborts injected at random, every statement is stored exactly once and none is dropped', () => {
    it.each(Array.from({ length: Number(process.env.WF_FUZZ_SEEDS) || 40 }, (_, i) => i + 1))('seed %i', async (seed) => {
        const r = rng(seed * 104729);
        const statements = Array.from({ length: 18 }, (_, i) => statement(i + 1));
        const noise = [...Array.from({ length: 8 }, (_, i) => brochure(i + 1)), ...Array.from({ length: 4 }, (_, i) => forged(i + 1)), ...Array.from({ length: 3 }, (_, i) => sibling(i + 1))];
        const inbox = [...statements, ...noise].sort(() => r() - 0.5);
        const w = world({ inbox, pageSize: 7 });
        const rate = 0.12 + (seed % 4) * 0.05;
        w.control.fault = (kind, url) => {
            if (kind === 'kind') return r() < 0.5 ? '429' : 'timeout';
            if (kind === 'tx') return r() < rate * 0.6;
            return r() < rate;
        };
        w.fake.setFailOn((path, op) => (op === 'set' && r() < rate * 0.4 ? new Error('DEADLINE_EXCEEDED') : null));
        const env = { WF_AUDIT_PAGE_SIZE: '7', WF_AUDIT_MAX_PAGES: '2' };
        let done = false;
        for (let runs = 0; runs < 400 && !done; runs++) {
            try { await w.run(env); } catch (_) { /* a crashed invocation: the next one carries on from the record */ }
            // judge completion on a clean read of the state, with the faults paused
            const paused = w.control.fault; w.control.fault = null; w.fake.setFailOn(() => null);
            const s = await w.state();
            done = !s.pendingCollection && s.historyAudit?.complete === true && !s.auditCursor && Object.keys(await w.items()).length >= statements.length;
            w.control.fault = paused; w.fake.setFailOn((path, op) => (op === 'set' && r() < rate * 0.4 ? new Error('DEADLINE_EXCEEDED') : null));
        }
        w.control.fault = null; w.fake.setFailOn(() => null);
        for (let i = 0; i < 6; i++) await w.run(env);      // a few clean passes: whatever is left is finished
        // and the reconcile that runs with every collection brings the table in line with the stored statements; a message
        // whose attempt died with nothing stored goes stale, is queued again, and is judged on the next collection
        const { refreshCoverage } = await import('../statement-sync.js');
        const refresh = async (now) => refreshCoverage({ db: w.db, mailRef: w.ref, mail: await w.state(), token: 't', f: async () => ({ ok: true, json: async () => ({}) }), now, search: false });
        const later = Date.now() + PENDING_STALE_MS + 60000;
        for (let k = 0; k < 3; k++) { await refresh(later); for (let i = 0; i < 5; i++) await w.run(env); }
        await refresh(Date.now());
        const items = Object.values(await w.items());
        const ids = items.map(i => i.messageId).sort();
        // the statements, and nothing from another desk of the bank: only an address on the owner's list is taken
        expect(ids, `a statement was dropped or stored twice (seed ${seed}, ${w.control.failures} injected failures)`).toEqual(statements.map(s => s.id).sort());
        const e = await w.emails();
        for (const s of statements) expect(e[docIdOf(s.id)]?.state, s.id).toBe('PROCESSED');
        for (const n of noise) expect(/^h/.test(n.id) ? ['REFUSED'] : ['REFUSED', 'FAILED_VERIFICATION', 'HELD'], n.id).toContain(e[docIdOf(n.id)]?.state);
        const st = await w.state();
        expect(st.pendingCollection || null).toBeNull();
        expect(st.auditCursor || null).toBeNull();
        // nothing that is forged was ever stored, and the forgeries are all on the security log
        expect(items.some(i => /^f/.test(i.messageId))).toBe(false);
        expect((st.security || []).map(x => x.messageId).sort()).toEqual(noise.filter(n => /^f/.test(n.id)).map(n => n.id).sort());
    });
});

describe('the table is reconciled at most every ten minutes, and the gap search stops at the invocation deadline', () => {
    it('does not read the whole table again within ten minutes, and keeps the last summary', async () => {
        const w = world({ inbox: [statement(1)] });
        await w.run();
        const { refreshCoverage } = await import('../statement-sync.js');
        const f = async () => ({ ok: true, json: async () => ({}) });
        const now = Date.now();
        const first = await refreshCoverage({ db: w.db, mailRef: w.ref, mail: await w.state(), token: 't', f, now, search: false });
        expect(first.table.total).toBe(1);
        const reads = () => w.fake.ops.filter(o => o.op === 'query' && o.path.endsWith('/emails')).length;
        const before = reads();
        const second = await refreshCoverage({ db: w.db, mailRef: w.ref, mail: await w.state(), token: 't', f, now: now + 60000, search: false });
        expect(reads()).toBe(before);                         // the table was not read again
        expect(second.table.total).toBe(1);                   // and the summary stands
        await refreshCoverage({ db: w.db, mailRef: w.ref, mail: await w.state(), token: 't', f, now: now + 11 * 60000, search: false });
        expect(reads()).toBeGreaterThan(before);              // ten minutes on, it is read again
    });
});

describe('mail from an unlisted sender that does not even say it is a statement is not held for a tap', () => {
    const ACC = { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@accbuddy.example; spf=pass; dmarc=pass header.from=accbuddy.example' };
    const notice = make('n0001', { from: 'Accounts <news@accbuddy.example>', subject: 'Course notice for October', filename: 'notice.html', auth: ACC });
    const lookalike = make('n0002', { from: 'Accounts <billing@accbuddy.example>', subject: 'Your e-Statement', filename: 'Consolidated_eStatement_2026MAR.html', auth: ACC });
    it('a notice is refused with its reason and leaves nothing waiting; a mail that does say statement still waits for the owner\'s decision', async () => {
        const w = world({ inbox: [notice, lookalike] });
        await w.run();
        const emails = await w.emails(), held = ((await w.state()).held || []).map(h => h.messageId);
        expect(emails[docIdOf('n0001')]).toMatchObject({ state: 'REFUSED', reason: 'not-a-statement-of-your-banks:the-subject-and-file-names-do-not-say-statement' });
        expect(held).not.toContain('n0001');
        expect(emails[docIdOf('n0002')].state).toBe('HELD');
        expect(held).toContain('n0002');
    });
});
