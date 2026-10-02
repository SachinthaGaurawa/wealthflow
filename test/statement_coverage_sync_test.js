import { describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { refreshCoverage, runStatementSync } from '../statement-sync.js';
import { INTAKE_VERSION } from '../wealthflow-mail-ingest.mjs';

// A month that never arrived, or arrived and was refused, leaves no trace when each
// message is judged alone. The set of statements shows the hole, and a search of
// exactly that month says what happened to it.
const NOW = Date.parse('2026-09-30T12:00:00Z');
const mailPath = 'wf-mail/owner_example_com';
const senders = [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved', name: 'NTB' }];
const item = (month, extra = {}) => [`${mailPath}/items/m${month}`, { uid: 'u', bank: 'NTB', filename: `Consolidated_eStatement_2026${month}_458290.html`, from: 'Statements <statements@nationstrust.com>', messageId: `msg${month}`, status: 'filed', filed: true, ...extra }];
const gmailMessage = (id, from, filename = 'Consolidated_eStatement_2026MAR_458290.html', receivedMs = Date.parse('2026-04-02T05:00:00Z'), subject = 'Your e-Statement') => ({
    id, internalDate: String(receivedMs),
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@nationstrust.com' }],
        mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', filename: '', body: { data: 'x' } }, { mimeType: 'text/html', filename, body: { attachmentId: 'att-' + id, size: 2_000_000 } }] },
});
function setup({ months = ['01', '02', '04', '05', '06', '07', '08'], mail = {}, inbox = [] } = {}) {
    const seed = { [mailPath]: { uid: 'u', email: 'owner@example.com', refresh_token: 'r', autonomous: true, senders, ...mail }, ...Object.fromEntries(months.map(m => item(m))) };
    const { db, data } = createFirestore(seed);
    const calls = [];
    const f = vi.fn(async url => {
        calls.push(String(url));
        if (String(url).includes('/messages?')) return { ok: true, status: 200, json: async () => ({ messages: inbox.map(m => ({ id: m.id })) }) };
        const id = decodeURIComponent(String(url).split('/messages/')[1].split('?')[0]);
        const found = inbox.find(m => m.id === id);
        return found ? { ok: true, status: 200, json: async () => found } : { ok: false, status: 404, json: async () => ({}) };
    });
    const mailRef = db.doc(mailPath);
    return { db, data, f, calls, mailRef, mailSnap: () => data.get(mailPath) };
}
const run = s => refreshCoverage({ db: s.db, mailRef: s.mailRef, mail: s.mailSnap(), token: 't', f: s.f, now: NOW });

describe('coverage: which months did the mailbox not give us', () => {
    it('names the missing month and finds a statement that arrived but was never taken', async () => {
        const s = setup({ inbox: [gmailMessage('msgMAR', 'Statements <statements@nationstrust.com>')] });
        const out = await run(s);
        expect(out.series[0]).toMatchObject({ first: '2026-01', last: '2026-08', missing: ['2026-03'] });
        expect(out.series[0].gaps).toEqual([{ month: '2026-03', mail: [{ messageId: 'msgMAR', receivedMs: Date.parse('2026-04-02T05:00:00Z'), from: 'statements@nationstrust.com', subject: 'Your e-Statement', outcome: 'missed' }] }]);
        // …and it is queued for intake, without touching the history cursor
        expect(out.staged).toBe(1);
        expect(s.mailSnap().pendingCollection).toMatchObject({ ids: ['msgMAR'], cursor: 0, target: '', reconciled: false });
        expect(s.calls[0]).toContain('after%3A2026%2F03%2F01');
        expect(s.calls[0]).toContain('nationstrust.com');
        expect(s.calls[0]).not.toContain('has%3Aattachment');
    });
    it('does not queue what the bank wrote from another address of its own, however unlike or like its statements — only an address on the owner\'s list is taken, and the report says so', async () => {
        const s = setup({ inbox: [gmailMessage('msgMAR', 'NTB E-Statements <estatements@nationstrust.com>', 'Weekend_Offers.html', Date.parse('2026-04-02T05:00:00Z'), 'Weekend offers')] });
        const out = await run(s);
        expect(out.series[0].gaps[0].mail).toMatchObject([{ messageId: 'msgMAR', from: 'estatements@nationstrust.com', outcome: 'a-new-address-at-a-bank-you-approved' }]);
        expect(out.staged).toBe(0);
        expect(s.mailSnap().pendingCollection).toBeUndefined();
    });
    it('names the reason when the bank\'s other address sent an invoice (refused as not a statement)', async () => {
        const s = setup({ inbox: [gmailMessage('msgMAR', 'NTB Billing <billing@nationstrust.com>', 'Invoice-0042.pdf', Date.parse('2026-04-02T05:00:00Z'), 'Invoice')] });
        const out = await run(s);
        expect(out.series[0].gaps[0].mail).toMatchObject([{ messageId: 'msgMAR' }]);
        expect(out.series[0].gaps[0].mail[0].outcome).not.toBe('missed');       // refused on what it is (or has no usable attachment), never queued, never waiting on a decision
        expect(out.series[0].gaps[0].mail[0].outcome).not.toBe('a-new-address-at-a-bank-you-approved');
        expect(out.staged).toBe(0);
        expect(s.mailSnap().pendingCollection).toBeUndefined();
    });
    it('does not queue a statement from the bank\'s other address even when it is named like the ones already filed — exactly as intake will not take it', async () => {
        const s = setup({ inbox: [gmailMessage('msgMAR', 'NTB E-Statements <estatements@nationstrust.com>')] });
        const out = await run(s);
        expect(out.series[0].gaps[0].mail).toMatchObject([{ messageId: 'msgMAR', outcome: 'a-new-address-at-a-bank-you-approved' }]);
        expect(out.staged).toBe(0);
    });
    it('says when nothing from the bank arrived at all that month', async () => {
        const s = setup({ inbox: [] });
        const out = await run(s);
        expect(out.series[0].gaps).toEqual([{ month: '2026-03', mail: [] }]);
        expect(out.staged).toBe(0);
    });
    it('searches the Spam folder too, because a bank\'s statement can be mistaken for spam', async () => {
        const s = setup({ inbox: [] });
        await run(s);
        expect(s.calls[0]).toContain('includeSpamTrash=true');
    });
    it('reports what the history audit found, what was refused and why, and a log line for every statement', async () => {
        const s = setup({ months: ['01', '02', '03', '04', '05', '06', '07', '08'], mail: {
            historyAudit: { at: NOW - 1000, version: 2, listed: 61, accounted: 57, examined: 4, taken: 3, refused: 1, held: 2, complete: true },
            refused: [{ messageId: 'bad1', reason: 'dkim-did-not-pass', from: 'Statements <statements@nationstrust.com>', subject: 'Your e-Statement', filename: 'Consolidated_eStatement_2026MAR_458290.html', receivedMs: NOW - 5000, v: 2, at: 1 }],
            takeQueue: [] } });
        const out = await run(s);
        expect(out.audit).toEqual({ at: NOW - 1000, listed: 61, accounted: 57, examined: 4, taken: 3, refused: 1, held: 2, complete: true });
        expect(out.refused).toEqual([{ messageId: 'bad1', reason: 'dkim-did-not-pass', text: 'it claims to be from your bank but carries no valid signature', takeable: true, from: 'statements@nationstrust.com', subject: 'Your e-Statement', filename: 'Consolidated_eStatement_2026MAR_458290.html', receivedMs: NOW - 5000, asked: false }]);
        expect(out.log).toHaveLength(8);
        expect(out.log[0]).toMatchObject({ month: '2026-08', status: 'Synced' });
        expect(JSON.parse(JSON.stringify(out))).toEqual(out);
        expect(s.mailSnap().coverage.log).toHaveLength(8);
    });
    it('offers a tap only for refusals the owner\'s word can lift', async () => {
        const reasons = ['dkim-did-not-pass', 'signed-by-a-different-domain', 'the-attachment-is-not-a-bank-statement', 'too-many-attachments', 'attachment-too-large', 'no-pdf-attachment'];
        const s = setup({ months: ['01', '02', '03', '04', '05', '06', '07', '08'], mail: { refused: reasons.map((reason, i) => ({ messageId: 'm' + i, reason, v: 2, at: 1 })) } });
        expect((await run(s)).refused.map(r => [r.reason, r.takeable])).toEqual(reasons.map(r => [r, ['dkim-did-not-pass', 'the-attachment-is-not-a-bank-statement'].includes(r)]));   // a signature by ANOTHER domain is forgery evidence, never the owner's to lift
    });
    it('marks a refused message the owner already tapped as asked', async () => {
        const s = setup({ months: ['01', '02', '03', '04', '05', '06', '07', '08'], mail: { refused: [{ messageId: 'bad1', reason: 'dkim-did-not-pass', v: 2, at: 1 }], takeQueue: ['bad1'] } });
        expect((await run(s)).refused[0].asked).toBe(true);
    });
    it('does not search again within six hours unless what is missing has changed', async () => {
        const s = setup({ inbox: [] });
        await run(s);
        const before = s.calls.length;
        await run(s);
        expect(s.calls.length).toBe(before);
    });
    it('a complete run costs no Gmail calls at all', async () => {
        const s = setup({ months: ['01', '02', '03', '04', '05', '06', '07', '08'] });
        const out = await run(s);
        expect(out.missing).toBe(0);
        expect(s.f).not.toHaveBeenCalled();
    });
    it('does not queue a message twice, or one already stored', async () => {
        const s = setup({ inbox: [gmailMessage('msg02', 'Statements <statements@nationstrust.com>', 'Consolidated_eStatement_2026MAR_458290.html')] });
        const out = await run(s);
        expect(out.series[0].gaps[0].mail[0].outcome).toBe('stored');
        expect(out.staged).toBe(0);
    });
    it('a Gmail failure is reported as advice at most: it never stops the sync and never burns the six-hour gate', async () => {
        const s = setup({ inbox: [] });
        s.f.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        const out = await run(s);
        expect(out.missing).toBe(1);
        expect(s.mailSnap().lastGapSearchMs).toBeUndefined();
    });
    it('is returned by the sync itself, in a compact form', async () => {
        const s = setup({ inbox: [] });
        s.data.set('users/u', { expenses: [] });
        const owner = { uid: 'u', email: 'owner@example.com' };
        const f = vi.fn(async url => {
            if (String(url).endsWith('/profile')) return { ok: true, json: async () => ({ emailAddress: 'owner@example.com', historyId: '10' }) };
            if (String(url).includes('oauth') || String(url).includes('token')) return { ok: true, json: async () => ({ access_token: 't' }) };
            return s.f(url);
        });
        const intake = vi.fn(async () => ({ body: { ok: true, collectionPending: false } }));
        const result = await runStatementSync({ db: s.db, owner, action: 'collect', env: {}, f, intake, maxSteps: 1, open: async () => [], loadAttachment: async () => ({}) });
        expect(result.coverage).toMatchObject({ missing: 1, series: [{ missing: ['2026-03'] }] });
    });
});

describe('an unattended collection does not stop after ten messages', () => {
    it('keeps collecting until the staged list is exhausted', async () => {
        const s = setup({ months: ['01', '02', '03', '04', '05', '06', '07', '08'] });
        const owner = { uid: 'u', email: 'owner@example.com' };
        const f = vi.fn(async url => String(url).endsWith('/profile') ? { ok: true, json: async () => ({ emailAddress: 'owner@example.com', historyId: '10' }) } : { ok: true, json: async () => ({ access_token: 't' }) });
        let left = 4;
        const intake = vi.fn(async () => ({ body: { ok: true, collectionPending: --left > 0 } }));
        await runStatementSync({ db: s.db, owner, action: 'collect', env: {}, f, intake, maxSteps: Infinity, open: async () => [], loadAttachment: async () => ({}) });
        expect(intake).toHaveBeenCalledTimes(4);
        const one = vi.fn(async () => ({ body: { ok: true, collectionPending: true } }));
        await runStatementSync({ db: s.db, owner, action: 'collect', env: {}, f, intake: one, maxSteps: 1, open: async () => [], loadAttachment: async () => ({}) });
        expect(one).toHaveBeenCalledTimes(1);   // a browser is there to follow it
    });
});

describe('the log says what "waiting" is made of', () => {
    it('one mail-table line: counts, the waiting messages grouped by what their stored items say, and the sender domains — states and counts only', async () => {
        const s = setup({ months: ['01', '02'] });
        const emails = (id, state, extra = {}) => s.data.set(`${mailPath}/emails/${id}`, { messageId: id, state, reason: '', from: 'Statements <statements@nationstrust.com>', updatedMs: 1, v: INTAKE_VERSION, ...extra });
        emails('msg01', 'INGESTED'); emails('msg02', 'PROCESSED');                     // msg02's item is filed: the table is behind
        emails('ghost1', 'PROCESSED'); emails('ghost2', 'PENDING');                    // stored, waiting — and no item at all
        s.data.set(`${mailPath}/items/m02`, { ...s.data.get(`${mailPath}/items/m02`), status: 'dismissed', filed: false });
        const lines = [];
        const spy = vi.spyOn(console, 'info').mockImplementation(line => lines.push(String(line)));
        try { await run(s); } finally { spy.mockRestore(); }
        const out = JSON.parse(lines.find(l => l.includes('"mail-table"')));
        expect(out).toMatchObject({ evt: 'mail-table' });
        expect(out.waiting['PROCESSED:no-item'] + out.waiting['PENDING:no-item']).toBeGreaterThanOrEqual(2);
        expect(Array.isArray(out.senders) && out.senders.every(entry => !String(entry.domain).includes('@'))).toBe(true);
        expect(lines.find(l => l.includes('"mail-table"'))).not.toMatch(/statements@|msg0|ghost/);
    });
});
