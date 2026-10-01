import { describe, it, expect, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { syncMailbox } from '../gmail-hook.js';
import { runStatementSync, refreshCoverage } from '../statement-sync.js';
import { approvedClauses } from '../wealthflow-mail-senders.mjs';
import { INTAKE_VERSION } from '../wealthflow-mail-ingest.mjs';
import { readTable, summarize, MAIL_STATE } from '../mail-state.mjs';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

/* =============================================================================
 * THE FOUR BANKS ON THE OWNER'S SENDERS LIST, FROM THE MAILBOX TO THE LEDGER, in one run.
 *
 *   HNB   e-statements@hnb.lk                       DFCC  statements@dfccbank.com
 *   NTB   estatement@info.nationstrust.com          AMEX  nationstrust@estmt.nationstrust.com
 *
 * Every statement below arrives the way a real bank's mail system sends it — a display name, a comment after a bare address,
 * upper case, a bulk mailer signing for the bank from a sub-domain, SPF and DMARC with no signature at all, a sibling
 * sub-domain of the same organisation — beside mail that is NOT the bank's (a display-name spoof, a DMARC failure, a purchase
 * receipt). From the first message found to the last row in the ledger, with the AI board down (as in production), the claim is:
 *
 *   · every genuine statement is ingested, and each bank's statements appear;
 *   · every forgery is refused and logged as such, and none reaches the ledger;
 *   · the per-sender figures the owner sees are DISTINCT EMAILS and where each is — not how many times a scan walked past;
 *   · running it all again changes nothing (no duplicate rows, no inflated counts).
 * ===========================================================================*/

const OWNER = { uid: 'u', email: 'owner@example.org' };
const NOTE = { emailAddress: OWNER.email, historyId: '1000' };
const MAIL = 'wf-mail/owner_example_org';
const G = 'mx.google.com; ';

const BANKS = {
    HNB:  { address: 'e-statements@hnb.lk', domain: 'hnb.lk' },
    NTB:  { address: 'estatement@info.nationstrust.com', domain: 'info.nationstrust.com' },
    DFCC: { address: 'statements@dfccbank.com', domain: 'dfccbank.com' },
    AMEX: { address: 'nationstrust@estmt.nationstrust.com', domain: 'estmt.nationstrust.com' },
};
const senders = Object.entries(BANKS).map(([name, b]) => ({ id: b.address, kind: 'address', status: 'approved', name: name === 'DFCC' ? 'DFCC Bank' : name, domain: b.domain }));

// the same card statement, different amounts per message, so no two are the same statement
const statementHtml = (variant) => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 16/09/2026 Payment Due Date: 10/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>14/09/2026</td><td>KEELLS STORE</td><td>${(123.45 + variant).toFixed(2)} DR</td></tr><tr><td>15/09/2026</td><td>PAYMENT THANK YOU</td><td>${(50 + variant).toFixed(2)} CR</td></tr></table></body></html>`;

const auth = {
    signed: (d) => G + `dkim=pass header.i=@${d}; spf=pass; dmarc=pass header.from=${d}`,
    parentSigned: (d, parent) => G + `dkim=pass header.i=@${parent}; spf=pass; dmarc=pass header.from=${d}`,
    subdomainSigned: (d) => G + `dkim=pass header.i=@mail.${d}; spf=pass smtp.mailfrom=bounce.sendgrid.net; dmarc=pass header.from=${d}`,
    spfDmarcOnly: (d) => G + `spf=pass smtp.mailfrom=${d}; dmarc=pass header.from=${d}`,
    siblingSigned: (d, sib) => G + `dkim=pass header.i=@${sib}; spf=pass; dmarc=pass header.from=${d}`,
    dmarcFail: (d) => G + `dkim=pass header.i=@sendgrid.net; spf=fail; dmarc=fail (p=NONE) header.from=${d}`,
};

let n = 0;
const inbox = [];
const add = (id, { from, auth: a, subject = 'Your account statement', file = 'Statement_202606.html', extraHeaders = [], received = Date.parse('2026-06-02T05:00:00Z') }) => {
    inbox.push({ id, variant: n++, received, message: { id, internalDate: String(received), payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, ...(a ? [{ name: 'Authentication-Results', value: a }] : []), ...extraHeaders],
        parts: [{ mimeType: 'text/plain', filename: '', body: { data: Buffer.from('Your statement is attached.').toString('base64url') } }, { mimeType: 'text/html', filename: file, body: { attachmentId: 'att-' + id, size: 5000 } }] } } });
    return id;
};

// ── genuine statements ────────────────────────────────────────────────────────────────────────────────────────────────
const GENUINE = [
    add('dfcc-1', { from: 'DFCC Bank <statements@dfccbank.com>', auth: auth.signed('dfccbank.com'), file: 'DFCC_Statement_202601.html', received: Date.parse('2026-01-03T05:00:00Z') }),
    add('dfcc-2', { from: 'statements@dfccbank.com (DFCC Bank)', auth: auth.subdomainSigned('dfccbank.com'), file: 'DFCC_Statement_202602.html', received: Date.parse('2026-02-03T05:00:00Z') }),
    add('dfcc-3', { from: '"DFCC, Statements" <STATEMENTS@DFCCBANK.COM>', auth: auth.spfDmarcOnly('dfccbank.com'), file: 'DFCC_Statement_202603.html', received: Date.parse('2026-03-03T05:00:00Z') }),
    add('ntb-1', { from: 'NTB eStatement <estatement@info.nationstrust.com>', auth: auth.parentSigned('info.nationstrust.com', 'nationstrust.com'), file: 'NTB_Statement_202601.html', received: Date.parse('2026-01-04T05:00:00Z') }),
    add('ntb-2', { from: 'estatement@info.nationstrust.com (Nations Trust Bank)', auth: auth.siblingSigned('info.nationstrust.com', 'estmt.nationstrust.com'), file: 'NTB_Statement_202602.html', received: Date.parse('2026-02-04T05:00:00Z') }),
    add('ntb-3', { from: '=?UTF-8?B?TlRCIGVTdGF0ZW1lbnQ=?= <ESTATEMENT@INFO.NATIONSTRUST.COM>', auth: auth.signed('info.nationstrust.com'), file: 'NTB_Statement_202603.html', received: Date.parse('2026-03-04T05:00:00Z') }),
    add('amex-1', { from: 'American Express <nationstrust@estmt.nationstrust.com>', auth: auth.signed('estmt.nationstrust.com'), file: 'AMEX_Statement_202601.html', received: Date.parse('2026-01-05T05:00:00Z') }),
    add('amex-2', { from: 'nationstrust@estmt.nationstrust.com (AMEX)', auth: auth.parentSigned('estmt.nationstrust.com', 'nationstrust.com'), file: 'AMEX_Statement_202602.html', received: Date.parse('2026-02-05T05:00:00Z') }),
    add('amex-3', { from: '"Nations Trust, AMEX" <nationstrust@estmt.nationstrust.com>', auth: auth.spfDmarcOnly('estmt.nationstrust.com'), file: 'AMEX_Statement_202603.html', received: Date.parse('2026-03-05T05:00:00Z') }),
    add('hnb-1', { from: 'HNB <e-statements@hnb.lk>', auth: auth.signed('hnb.lk'), file: 'HNB_Statement_202601.html', received: Date.parse('2026-01-06T05:00:00Z') }),
    add('hnb-2', { from: 'e-statements@hnb.lk (HNB e-Statements)', auth: auth.spfDmarcOnly('hnb.lk'), file: 'HNB_Statement_202602.html', received: Date.parse('2026-02-06T05:00:00Z'), extraHeaders: [{ name: 'Return-Path', value: '<bounces@mailer.example>' }, { name: 'Reply-To', value: 'noreply@hnb.lk' }] }),
    add('hnb-3', { from: '"HNB" <E-STATEMENTS@HNB.LK>', auth: auth.signed('hnb.lk'), file: 'HNB_Statement_202603.html', received: Date.parse('2026-03-06T05:00:00Z') }),
];
// ── what must NOT get in ──────────────────────────────────────────────────────────────────────────────────────────────
const FORGED = [
    add('spoof-name', { from: '"statements@dfccbank.com" <billing@evil.example>', auth: auth.signed('evil.example'), file: 'DFCC_Statement_202604.html' }),
    add('dmarc-fail', { from: 'DFCC Bank <statements@dfccbank.com>', auth: auth.dmarcFail('dfccbank.com'), file: 'DFCC_Statement_202605.html' }),
    add('two-mailboxes', { from: 'HNB <e-statements@hnb.lk>, Other <x@evil.example>', auth: auth.signed('hnb.lk'), file: 'HNB_Statement_202604.html' }),
    add('return-path-decoy', { from: 'Mallory <mallory@evil.example>', auth: auth.signed('evil.example'), file: 'NTB_Statement_202604.html', extraHeaders: [{ name: 'Return-Path', value: '<estatement@info.nationstrust.com>' }, { name: 'Reply-To', value: 'estatement@info.nationstrust.com' }] }),
];
const REFUSED = [
    add('receipt', { from: 'AMEX <nationstrust@estmt.nationstrust.com>', auth: auth.signed('estmt.nationstrust.com'), subject: 'Your order confirmed - receipt', file: 'Receipt_10442.html' }),
];

function world() {
    const { db, data } = createFirestore({
        [MAIL]: { uid: OWNER.uid, email: OWNER.email, refresh_token: 'fake', autonomous: true, historyId: '999', senders },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [] },
    });
    const calls = [];
    const f = vi.fn(async (url) => {
        const u = decodeURIComponent(String(url)); calls.push(u);
        if (u.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'fake-access' }) };
        if (u.endsWith('/profile')) return { ok: true, json: async () => ({ emailAddress: OWNER.email, historyId: '1000' }) };
        if (u.includes('/history?')) return { ok: true, json: async () => ({ historyId: '1000', history: [] }) };
        if (u.includes('/messages?')) return { ok: true, json: async () => ({ messages: inbox.map(m => ({ id: m.id })) }) };
        const att = inbox.find(m => u.includes('/messages/' + m.id + '/attachments/'));
        if (att) return { ok: true, json: async () => ({ data: Buffer.from(statementHtml(att.variant)).toString('base64url') }) };
        const msg = inbox.find(m => u.includes('/messages/' + m.id + '?'));
        return msg ? { ok: true, json: async () => msg.message } : { ok: false, status: 404, json: async () => ({}) };
    });
    return { db, data, f, calls };
}

async function intakeAll(w) {
    for (let i = 0; i < 30; i++) {
        const out = await syncMailbox(w.db, NOTE, { env: {}, f: w.f });
        if (!out.body.collectionPending) return out;
    }
    throw new Error('the collection never finished');
}
async function fileAll(w) {
    let last;
    for (let i = 0; i < 80; i++) {
        last = await runStatementSync({ action: 'drain', db: w.db, owner: OWNER, env: {}, f: w.f, read: readStatement, open: async () => [], settle: settleStatement, board: async () => { throw Object.assign(new Error('ai-consensus-unavailable'), { outage: true }); },
            extract: async () => { throw new Error('ai-extractor-unavailable'); }, interactive: true, maxSteps: Infinity });
        if (!last.morePending) break;
    }
    return last;
}

describe('four banks, from the mailbox to the ledger, with the AI board down', () => {
    it('every genuine statement is ingested, every forgery is refused, and the figures the owner sees are distinct emails', async () => {
        const w = world();
        await intakeAll(w);
        const items = [...w.data.entries()].filter(([k]) => k.startsWith(MAIL + '/items/')).map(([, v]) => v);

        // — only the genuine statements were stored
        expect(items.map(i => i.messageId).sort()).toEqual([...GENUINE].sort());
        for (const bad of [...FORGED, ...REFUSED]) expect(items.some(i => i.messageId === bad), bad).toBe(false);

        await fileAll(w);
        const stored = [...w.data.entries()].filter(([k]) => k.startsWith(MAIL + '/items/')).map(([, v]) => v);
        expect(stored.every(i => i.filed === true), JSON.stringify(stored.filter(i => !i.filed).map(i => [i.messageId, i.status, i.reviewReason, i.lastRetryReason]))).toBe(true);
        const user = w.data.get('users/u');
        expect(user.cconetime).toHaveLength(GENUINE.length);           // one purchase per statement
        expect(user.ccPayments).toHaveLength(GENUINE.length);
        // each bank's statements are there, newest and oldest alike
        for (const [prefix, bank] of [['dfcc', 'DFCC Bank'], ['ntb', 'NTB'], ['amex', 'AMEX'], ['hnb', 'HNB']]) {
            const mine = stored.filter(i => i.messageId.startsWith(prefix));
            expect(mine, bank).toHaveLength(3);
            expect(new Set(mine.map(i => i.bank))).toEqual(new Set([bank]));
        }

        // — the table, as the owner's screen reads it
        const mail = w.data.get(MAIL);
        const coverage = await refreshCoverage({ db: w.db, mailRef: w.db.collection('wf-mail').doc('owner_example_org'), mail, token: 't', f: w.f, search: false });
        const funnel = Object.fromEntries(coverage.table.senders.map(r => [r.address, r]));
        for (const bank of Object.values(BANKS)) expect(funnel[bank.address], bank.address).toMatchObject({ INGESTED: 3 });
        const table = summarize(await readTable(w.db.collection('wf-mail').doc('owner_example_org')));
        expect(table.counts[MAIL_STATE.INGESTED]).toBe(GENUINE.length);
        // what claimed to be a bank and failed its own authentication (a DMARC failure, two mailboxes in one From) is logged as forged
        const byId = Object.fromEntries((await readTable(w.db.collection('wf-mail').doc('owner_example_org'))).map(r => [r.messageId, r.state]));
        expect(byId['dmarc-fail']).toBe(MAIL_STATE.FAILED_VERIFICATION);
        expect(byId['two-mailboxes']).toBe(MAIL_STATE.FAILED_VERIFICATION);
        expect(table.counts[MAIL_STATE.FAILED_VERIFICATION]).toBe(2);
        expect(coverage.securityCount).toBe(2);
        // mail from somebody else who merely NAMES a bank (in a display name, in Return-Path / Reply-To) is a stranger: never ingested
        for (const id of ['spoof-name', 'return-path-decoy', 'receipt']) expect([MAIL_STATE.INGESTED, MAIL_STATE.PROCESSED, MAIL_STATE.REVIEW], id).not.toContain(byId[id]);

        // — distinct emails: the senders list's own counter is of messages, not of scans
        const seenOf = (id) => (w.data.get(MAIL).senders.find(e => e.id === id) || {}).seenCount;
        for (const bank of Object.values(BANKS)) expect(seenOf(bank.address), bank.address).toBeLessThanOrEqual(5);
    });

    it('running the whole thing again changes nothing: no duplicate rows, no inflated counts, no new items', async () => {
        const w = world();
        await intakeAll(w); await fileAll(w);
        const snapshot = () => ({
            items: [...w.data.keys()].filter(k => k.startsWith(MAIL + '/items/')).length,
            rows: w.data.get('users/u').cconetime.length + w.data.get('users/u').ccPayments.length,
            seen: Object.fromEntries(w.data.get(MAIL).senders.map(e => [e.id, e.seenCount])),
        });
        const first = snapshot();
        for (let round = 0; round < 3; round++) {
            await w.db.collection('wf-mail').doc('owner_example_org').set({ requeue: inbox.map(m => m.id) }, { merge: true });
            await intakeAll(w); await fileAll(w);
        }
        expect(snapshot()).toEqual(first);
    });

    it('the AI board being down is paid for once: the whole backlog is classified without it', async () => {
        const w = world();
        await intakeAll(w);
        const board = vi.fn(async () => { throw Object.assign(new Error('ai-consensus-unavailable'), { outage: true }); });
        for (let i = 0; i < 30; i++) {
            const out = await runStatementSync({ action: 'drain', db: w.db, owner: OWNER, env: {}, f: w.f, read: readStatement, open: async () => [], settle: settleStatement, board, extract: async () => { throw new Error('x'); }, interactive: true, maxSteps: Infinity });
            if (!out.morePending) break;
        }
        expect(board.mock.calls.length).toBeLessThanOrEqual(2);
        expect([...w.data.entries()].filter(([k]) => k.startsWith(MAIL + '/items/')).every(([, v]) => v.filed === true)).toBe(true);
    });
});

describe('the statements the version-3 rules turned away are judged again under the new rules', () => {
    it('a mailbox that already refused the six genuine messages takes them on its next pass, without any message arriving', async () => {
        const w = world();
        // the state production is in: the audit ran under rules version 3, took the six it understood, and recorded the other six as refused
        const mailRef = w.db.collection('wf-mail').doc('owner_example_org');
        const OLD = ['dfcc-2', 'dfcc-3', 'ntb-2', 'amex-2', 'amex-3', 'hnb-2'];
        for (const id of OLD) await mailRef.collection('emails').doc(id).set({ messageId: id, state: 'REFUSED', reason: 'dkim-did-not-pass', from: 'x', v: 3, firstSeenMs: 1, updatedMs: 1, attempts: 1 });
        await mailRef.set({ historyId: '1000', lastReconcileMs: Date.now(), auditVersion: 3, lastAuditMs: Date.now() - 6 * 60_000, collectedSenderClauses: approvedClauses(senders) }, { merge: true });
        for (const id of GENUINE.filter(g => !OLD.includes(g))) await mailRef.collection('emails').doc(id).set({ messageId: id, state: 'INGESTED', reason: '', from: 'x', v: 3, firstSeenMs: 1, updatedMs: 1, attempts: 1 });
        // the six it took are already stored; the six it refused are not
        for (const [id, m] of inbox.map(x => [x.id, x])) if (GENUINE.includes(id) && !OLD.includes(id)) await mailRef.collection('items').doc(`${id}.stored`).set({ uid: 'u', messageId: id, status: 'filed', filed: true, bank: 'x', filename: 'x.html' });
        await intakeAll(w);
        const taken = [...w.data.entries()].filter(([k]) => k.startsWith(MAIL + '/items/')).map(([, v]) => v.messageId);
        for (const id of OLD) expect(taken, id).toContain(id);
        expect(w.data.get(MAIL).auditVersion).toBe(INTAKE_VERSION);
        // the forgeries are still not
        for (const bad of [...FORGED, ...REFUSED]) expect(taken, bad).not.toContain(bad);
    });
});
