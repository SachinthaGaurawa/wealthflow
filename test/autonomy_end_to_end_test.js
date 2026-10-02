import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { ntbDoc, textPdf } from './helpers/embedded-statements.js';
import { runStatementSync, takeRefusedMessage } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { approvedClauses } from '../wealthflow-mail-senders.mjs';

// A year of a mailbox, with everything that used to make a statement vanish in one place:
//   JAN, FEB  filed on an earlier day, from the address the owner approved
//   MAR       the bank wrote from its OTHER address (same domain, same kind of file)
//   APR       arrived without a signature Gmail could verify
//   MAY       Gmail put it in Spam
//   JUN       arrived today, by the normal path
//   JUL       an invoice from another address at the bank's domain (must never be filed)
// The whole unattended loop runs — intake, audit, reading, filing — and then the owner's one tap.
const NOW = Date.parse('2026-07-20T12:00:00Z');
// The clock is the mailbox's: July 20, so JAN–JUN are due and nothing after is.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });
const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com';
const senders = [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved', name: 'NTB', domain: 'nationstrust.com' }];
const MONTHS = { '01': 'JAN', '02': 'FEB', '03': 'MAR', '04': 'APR', '05': 'MAY', '06': 'JUN' };
const fileName = mm => `Consolidated_eStatement_2026${MONTHS[mm]}_458290.html`;
const html = mm => ntbDoc({ period: `01-${mm}-2026 to 28-${mm}-2026`, accounts: [{ number: '200550088057', opening: 1000000, rows: [
    { date: `2026-${mm}-05`, details: `POS Transaction - SHOP ${mm}`, ref: `R${mm}`, debit: 10000 * Number(mm) },
    { date: `2026-${mm}-09`, details: `Cash Deposit - BRANCH ${mm}`, ref: `D${mm}`, credit: 500000 + Number(mm) }] }] });
const message = (id, mm, { from = 'Statements <statements@nationstrust.com>', dkim = true, filename = fileName(mm), subject = 'Your e-Statement', mime } = {}) => ({
    id, internalDate: String(Date.parse(`2026-${mm}-28T05:00:00Z`) + 5 * 86400000),
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject },
        ...(dkim ? [{ name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@nationstrust.com' }] : [])], mimeType: 'multipart/mixed',
    parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'x' } }, { mimeType: mime || 'text/html', filename, body: { attachmentId: 'att-' + id, size: 2000 } }] },
});
const filed = mm => [`${mailPath}/items/j${mm}.${fileName(mm)}.2000`, { uid: 'u', bank: 'NTB', filename: fileName(mm), messageId: `j${mm}`, from: 'Statements <statements@nationstrust.com>',
    status: 'filed', filed: true, hasReview: false, cursor: 4, totalRows: 4, receivedMs: Date.parse(`2026-${mm}-28T05:00:00Z`) + 5 * 86400000, storedMs: NOW - 40 * 86400000 }];

function mailbox({ more = [], moreBodies = {} } = {}) {
    const inbox = [
        message('mMAR', '03', { from: 'NTB E-Statements <estatements@nationstrust.com>' }),
        message('mAPR', '04', { dkim: false }),
        message('mMAY', '05'),
        message('mJUN', '06'),
        message('mINV', '06', { from: 'NTB Billing <billing@nationstrust.com>', filename: 'Invoice-0042.pdf', subject: 'Invoice', mime: 'application/pdf' }),
        ...more,
    ];
    const spam = new Set(['mMAY']);
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders, historyId: '1000', collectedSenderClauses: approvedClauses(senders), lastReconcileMs: NOW, email_verified: true },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
        ...Object.fromEntries(['01', '02'].map(filed)),
    });
    const calls = [];
    const bodies = { mMAR: html('03'), mAPR: html('04'), mMAY: html('05'), mJUN: html('06'), ...moreBodies };
    const f = vi.fn(async url => {
        const u = decodeURIComponent(String(url)); calls.push(u);
        if (u.includes('oauth2.googleapis.com')) return { ok: true, status: 200, json: async () => ({ access_token: 'token' }) };
        if (u.includes('/profile')) return { ok: true, status: 200, json: async () => ({ emailAddress: owner.email, historyId: '1000' }) };
        if (u.includes('/history?')) return { ok: true, status: 200, json: async () => ({ historyId: '1000', history: [] }) };
        if (u.includes('/attachments/')) {
            // the attachment of one message: its own statement, the same bytes every time it is asked for
            const owner = /\/messages\/([^/]+)\/attachments\//.exec(u)?.[1];
            return { ok: true, status: 200, json: async () => ({ data: Buffer.from(bodies[owner] || '<html>not a statement</html>').toString('base64url') }) };
        }
        if (u.includes('/messages?')) {
            // What Gmail lists for a query: Spam only when asked for, and the gap search ("after:2026/04/01") finds only April.
            const wantsSpam = u.includes('includeSpamTrash=true');
            // a search for one month ("after:2026/04/01 before:2026/05/22") sees only mail that arrived inside that window
            const win = /after:(\d{4})\/(\d\d)\/(\d\d) before:(\d{4})\/(\d\d)\/(\d\d)/.exec(u);
            const inWindow = m => !win || (Number(m.internalDate) >= Date.UTC(+win[1], +win[2] - 1, +win[3]) && Number(m.internalDate) < Date.UTC(+win[4], +win[5] - 1, +win[6]));
            const ids = inbox.filter(m => (wantsSpam || !spam.has(m.id)) && inWindow(m)).map(m => m.id);
            return { ok: true, status: 200, json: async () => ({ messages: ids.map(id => ({ id })) }) };
        }
        const id = u.split('/messages/')[1]?.split('?')[0];
        const found = inbox.find(m => m.id === id);
        return found ? { ok: true, status: 200, json: async () => found } : { ok: false, status: 404, json: async () => ({}) };
    });
    const open = async () => [{ password: 'fixture-password', bank: 'NTB' }];
    const run = (action = 'collect') => runStatementSync({ db, owner, action, env: {}, f, read: readStatement, open, settle: settleStatement, board: async () => { throw new Error('ai-consensus-unavailable'); }, budgetMs: 30000 });
    return { db, data, f, calls, run, mail: () => data.get(mailPath), items: () => Object.fromEntries([...data.entries()].filter(([k]) => /\/items\/[^/]+$/.test(k)).map(([k, v]) => [k.split('/').pop(), v])) };
}
const drainAll = async s => { let out; for (let i = 0; i < 12; i++) { out = await s.run(); if (!out.collectionMore && !out.attempted) break; } return out; };

describe('a mailbox where every old way of losing a statement is present', () => {
    it('files what the owner\'s list allows without asking, takes nothing from any other address, and never files the invoice', async () => {
        const s = mailbox();
        const out = await drainAll(s);
        const items = Object.values(s.items());
        const by = Object.fromEntries(items.map(i => [i.messageId, i]));
        // MAY (Spam) and JUN (today) are found, stored and filed — with no tap
        for (const id of ['mMAY', 'mJUN']) expect(by[id], id).toMatchObject({ status: 'filed', filed: true });
        expect(by.mMAY.via).toBe('audit');
        // MAR came from the bank's OTHER address (its subject says statement): not on the owner's list, so not taken — held for the owner's tap, never stored
        expect(by.mMAR).toBeUndefined();
        expect((s.mail().held || []).map(h => h.messageId)).toEqual(['mMAR']);
        // APR arrived without a verifiable signature: on record with its reason, not stored, not lost
        expect(by.mAPR).toBeUndefined();
        expect(s.mail().refused).toMatchObject([{ messageId: 'mAPR', reason: 'dkim-did-not-pass' }]);
        // the invoice from another address is never filed — refused as not a statement on what it says it is, with nothing held for the owner
        expect(by.mINV).toBeUndefined();
        // the books hold exactly the two months that were filed now
        const user = s.data.get('users/u');
        expect(user.expenses.map(r => r.date).sort()).toEqual(['2026-05-05', '2026-06-05']);
        expect(user.incomeRecv.map(r => r.date).sort()).toEqual(['2026-05-09', '2026-06-09']);
        // the report says what happened
        expect(out.coverage.refused).toMatchObject([{ messageId: 'mAPR', takeable: true, asked: false }]);
        expect(out.coverage.audit).toMatchObject({ complete: true, taken: 2 });
        expect(out.coverage.series[0].missing).toEqual(['2026-03', '2026-04']);
        expect(out.coverage.series[0].gaps.map(g => g.month)).toEqual(['2026-04', '2026-03']);
        // March's statement (from the bank's other address) is named for what it is: a new address at their bank, not taken
        const april = Object.fromEntries(out.coverage.series[0].gaps[0].mail.map(m => [m.messageId, m.outcome]));
        expect(april).toEqual({ mMAR: 'a-new-address-at-a-bank-you-approved', mAPR: 'dkim-did-not-pass' });
        expect(out.coverage.log.filter(l => l.status === 'Missing-Added').map(l => l.month).sort()).toEqual(['2026-05', '2026-06']);
        expect(out.coverage.log.every(l => l.math === 'PASSED' || l.status === 'Synced')).toBe(true);
    });

    it('takes April on the owner\'s one tap, reads it, reconciles it, and leaves nothing missing', async () => {
        const s = mailbox();
        await drainAll(s);
        await takeRefusedMessage({ db: s.db, owner, messageId: 'mAPR' });
        const out = await drainAll(s);
        const apr = Object.values(s.items()).find(i => i.messageId === 'mAPR');
        expect(apr).toMatchObject({ status: 'filed', filed: true, via: 'owner' });
        expect(apr.proof).toMatchObject({ math: 'passed', rows: 2 });
        expect(s.mail().refused).toEqual([]);
        expect(s.data.get('users/u').expenses.map(r => r.date).sort()).toEqual(['2026-04-05', '2026-05-05', '2026-06-05']);
        expect(out.coverage.missing).toBe(1);        // March: from an address that is not on the list, so not taken
    });

    it('running the whole loop again changes nothing: no duplicate statements, no duplicate rows, nothing re-fetched that was judged', async () => {
        const s = mailbox();
        await takeRefusedMessage({ db: s.db, owner, messageId: 'mAPR' }).catch(() => {});
        await drainAll(s);
        const before = { items: Object.keys(s.items()).sort(), user: structuredClone(s.data.get('users/u')), fetches: s.calls.filter(u => u.includes('/messages/m')).length };
        await s.data.get(mailPath) && await s.db.doc(mailPath).set({ lastAuditMs: 0 }, { merge: true });
        await drainAll(s);
        expect(Object.keys(s.items()).sort()).toEqual(before.items);
        expect(s.data.get('users/u').expenses).toEqual(before.user.expenses);
        expect(s.data.get('users/u').incomeRecv).toEqual(before.user.incomeRecv);
        // what is held (the other address's March statement) is looked at again, because approving its sender could change the answer; nothing else is
        const again = s.calls.filter(u => u.includes('/messages/m')).length - before.fetches;
        expect(again).toBeLessThanOrEqual(2);
    });
});

describe('a statement taken from the bank\'s other address', () => {
    const pendingSibling = { uid: 'u', bank: 'NTB', filename: fileName('03'), messageId: 'mMAR', from: 'NTB E-Statements <estatements@nationstrust.com>', status: 'pending', filed: false, hasReview: false, cursor: 0, via: 'series', size: 2000, receivedMs: Date.parse('2026-04-02T05:00:00Z') };
    const seed = (s, extra = {}) => { s.data.set(`${mailPath}/items/mMAR.${fileName('03')}.2000`, { ...pendingSibling, ...extra }); };
    it('is retired unread, not filed, even while the owner approves another address at that bank — only an address on the list is taken', async () => {
        const s = mailbox(); seed(s);
        await drainAll(s);
        expect(s.data.get(`${mailPath}/items/mMAR.${fileName('03')}.2000`)).toMatchObject({ status: 'rejected_unapproved_sender', filed: false });
        expect(s.data.get('users/u').expenses.map(r => r.date)).not.toContain('2026-03-05');
    });
    it('is retired, not filed, once the owner has revoked every address at that bank', async () => {
        const s = mailbox(); seed(s);
        s.data.set(mailPath, { ...s.data.get(mailPath), senders: [] });
        await drainAll(s);
        expect(s.data.get(`${mailPath}/items/mMAR.${fileName('03')}.2000`).status).toBe('rejected_unapproved_sender');
        expect(s.data.get('users/u').expenses).toEqual([]);
    });
    it('is never filed by the same route when it was not taken by series (an ordinary message from the sibling stays unapproved)', async () => {
        const s = mailbox(); seed(s, { via: undefined });
        await drainAll(s);
        expect(s.data.get(`${mailPath}/items/mMAR.${fileName('03')}.2000`).status).toBe('rejected_unapproved_sender');
    });
});

describe('the bank\'s other desks are not taken — only the owner\'s list is a way in, and nothing waits for the owner to decide whether an email is real', () => {
    const at = (m, day) => ({ ...m, internalDate: String(Date.parse(`2026-07-${day}T05:00:00Z`)) });
    const more = [
        // a marketing mail with a PDF, from a mail host of the bank's own organisation, signed by it (the "Colombo Fashion Week" mail the owner was asked about)
        at(message('mFASH', '07', { from: 'NTB Customer Service <news@customerservice.nationstrust.com>', subject: 'Here\'s what took shape on Day 01 of Colombo Fashion Week', filename: 'FashionWeek_Day01.pdf', mime: 'application/pdf' }), '08'),
        // a genuine statement from another desk, with a plain subject and a plain file name: nothing in the mail says statement
        at(message('mSIB', '07', { from: 'NTB Desk <desk@nationstrust.com>', subject: 'Your documents', filename: '5996631318_455.html' }), '10'),
        // the same desk without a signature Gmail could verify: never taken
        at(message('mFORGE', '07', { from: 'NTB Desk <desk@nationstrust.com>', subject: 'Your documents', filename: '5996631318_456.html', dkim: false }), '11'),
    ];
    const moreBodies = { mFASH: textPdf(['Colombo Fashion Week presented by Nations Trust Bank', 'Day 01 highlights from the runway', 'Tickets from Rs. 2,500.00 at the door']), mSIB: html('07'), mFORGE: html('07') };
    it('a brochure from another desk is not taken, not stored, not held — and the owner is asked nothing', async () => {
        const s = mailbox({ more, moreBodies });
        await drainAll(s);
        const by = Object.fromEntries(Object.values(s.items()).map(i => [i.messageId, i]));
        expect(by.mFASH).toBeUndefined();
        expect([...s.data.keys()].filter(k => k.startsWith('users/u/statementReview/'))).toEqual([]);      // the owner is asked nothing
        expect((s.mail().held || []).map(h => h.messageId)).not.toContain('mFASH');
    });
    it('a genuine statement from another desk with nothing in the mail saying statement is NOT taken either — the list is the only way in', async () => {
        const s = mailbox({ more, moreBodies });
        await drainAll(s);
        expect(Object.values(s.items()).find(i => i.messageId === 'mSIB')).toBeUndefined();
        expect(s.data.get('users/u').expenses.map(r => r.date)).not.toContain('2026-07-05');
    });
    it('the same desk with no verifiable signature is never taken', async () => {
        const s = mailbox({ more, moreBodies });
        await drainAll(s);
        expect(Object.values(s.items()).find(i => i.messageId === 'mFORGE')).toBeUndefined();
    });
});
