import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { recoverConsensusFailures, recoverDuplicateRows, recoverRevokedSenderReviews, reviveRetiredSources, runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

// Production, 2026-10-02: the steps that settle what is already waiting (the "POS Transaction" rows, the second copies, the retired statements to look up and put back) sat after the
// mailbox scan with no limit of their own, the runs that reached them were cut at sixty seconds ("Task timed out"), the chain stalled and the owner kept seeing the same reviews.
// Each step now has a deadline; they run first, short, at most every thirty seconds; and what the rules cannot place as a statement is retired, not asked about.

afterEach(() => vi.restoreAllMocks());
const owner = { uid: 'u', email: 'owner@example.com' };
const mail = 'wf-mail/owner_example_com';
const A = (id, name) => ({ id, kind: 'address', status: 'approved', name, domain: id.split('@')[1] });
const SENDERS = [A('estatement@info.nationstrust.com', 'NTB')];
const row = (extra = {}) => ({ date: '2026-01-12', narration: 'POS Transaction - MIRIGAMA', description: 'POS Transaction - MIRIGAMA', amount: 1234.5, direction: 'debit', directionSource: 'column', needsReview: false, valid: true, ...extra });
const down = async () => { throw new Error('ai-consensus-unavailable'); };
const gmailOk = async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });

describe('every recovery step stops at its deadline and says there is more', () => {
    const sourcePath = `${mail}/items/ntb1`;
    const reviews = (n) => {
        const out = {};
        for (let i = 0; i < n; i += 1) {
            const id = createHash('sha256').update(`${sourcePath}:${i}`).digest('hex');
            out[`users/u/statementReview/${id}`] = { uid: 'u', sourcePath, index: i, status: 'pending', reason: 'ai-consensus-unavailable', row: row({ index: i, amount: 100 + i }), bank: 'NTB' };
            out[`users/u/statementLedger/${id}`] = { uid: 'u', sourcePath, index: i, status: 'review' };
        }
        return out;
    };
    const world = (n) => createFirestore({
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {}, targets: [], loans: [] },
        [sourcePath]: { uid: 'u', bank: 'NTB', statementType: 'bank_account', last4: '', status: 'needs_review', hasReview: true, cursor: n, totalRows: n },
        ...reviews(n),
    });
    it('a deadline already past settles nothing and reports more; the same call without one settles them all', async () => {
        const late = world(6);
        expect(await recoverConsensusFailures({ db: late.db, uid: 'u', until: 0 })).toEqual({ recovered: 0, more: true });
        expect(late.data.get('users/u').expenses).toEqual([]);
        const open = world(6);
        expect((await recoverConsensusFailures({ db: open.db, uid: 'u' })).recovered).toBe(6);
        expect(open.data.get('users/u').expenses).toHaveLength(6);
    });
    it('closing second copies and dismissing revoked-sender reviews stop the same way', async () => {
        const dupId = createHash('sha256').update(`${mail}/items/copy:review:1`).digest('hex'), goneId = createHash('sha256').update(`${mail}/items/gone:review:-1`).digest('hex');
        const w = createFirestore({
            'users/u': { expenses: [{ id: 'e1', date: '2026-01-12', amount: 1234.5, desc: 'POS Transaction - MIRIGAMA', bank: 'NTB', direction: 'debit', statementKey: `${mail}/items/first`, statementRow: 1, source: 'statement' }], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
            [`${mail}/items/copy`]: { uid: 'u', bank: 'NTB', status: 'needs_review', hasReview: true, cursor: 5, totalRows: 5 },
            [`users/u/statementReview/${dupId}`]: { uid: 'u', sourcePath: `${mail}/items/copy`, index: 1, status: 'pending', reason: 'ambiguous-cross-source-match', bank: 'NTB', last4: '', row: row({ index: 1 }) },
            [`users/u/statementLedger/${dupId}`]: { uid: 'u', sourcePath: `${mail}/items/copy`, status: 'review' },
            [`${mail}/items/gone`]: { uid: 'u', bank: 'Nations Trust', status: 'needs_review', hasReview: true, filed: false },
            [`users/u/statementReview/${goneId}`]: { uid: 'u', sourcePath: `${mail}/items/gone`, index: -1, status: 'pending', reason: 'statement-sender-no-longer-approved', bank: 'Nations Trust' },
        });
        const dup = await recoverDuplicateRows({ db: w.db, uid: 'u', until: 0, log: () => {} });
        expect(dup).toMatchObject({ closed: 0, more: true });
        expect(w.data.get(`users/u/statementReview/${dupId}`).status).toBe('pending');
        expect(await recoverRevokedSenderReviews({ db: w.db, uid: 'u', until: 0 })).toEqual({ recovered: 0, more: true });
        expect(w.data.get(`users/u/statementReview/${goneId}`).status).toBe('pending');
        expect((await recoverDuplicateRows({ db: w.db, uid: 'u', log: () => {} })).closed).toBe(1);
        expect((await recoverRevokedSenderReviews({ db: w.db, uid: 'u' })).recovered).toBe(1);
        expect(w.data.get(`${mail}/items/gone`).status).toBe('dismissed');     // the seven "Nations Trust" items: no longer an open question for the owner
    });
});

describe('the retired statements are looked up together, within the deadline, and a message Gmail no longer has is asked about once', () => {
    const retired = (extra = {}) => ({ uid: 'u', bank: 'NTB', filename: 's.html', status: 'rejected_unapproved_sender', filed: false, cursor: 0, intent: 'stated', ...extra });
    const world = (items) => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: SENDERS },
        ...Object.fromEntries(Object.entries(items).map(([id, data]) => [`${mail}/items/${id}`, data])),
    });
    const ids = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`i${i}`, retired({ messageId: `m${i}` })]));
    const run = (w, f, extra = {}) => reviveRetiredSources({ db: w.db, mailRef: w.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', senders: SENDERS, token: 't', f, log: () => {}, ...extra });
    it('at most six requests are in flight at once, at most `lookups` are made, and the rest is `more`', async () => {
        let live = 0, peak = 0;
        const f = vi.fn(async () => { live += 1; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live -= 1; return { ok: true, status: 200, json: async () => ({ payload: { headers: [{ name: 'From', value: 'NTB <estatement@info.nationstrust.com>' }] } }) }; });
        const out = await run(world(ids), f, { lookups: 12 });
        expect(peak).toBeLessThanOrEqual(6);
        expect(peak).toBeGreaterThan(1);
        expect(f).toHaveBeenCalledTimes(12);
        expect(out).toMatchObject({ revived: 12, more: true });
    });
    it('a deadline already past asks Gmail nothing and says there is more', async () => {
        const f = vi.fn();
        const out = await run(world(ids), f, { until: 0 });
        expect(f).not.toHaveBeenCalled();
        expect(out).toMatchObject({ revived: 0, more: true });
    });
    it('a message that is gone (404) is marked on its item and never asked about again', async () => {
        const f = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
        const w = world({ a: retired({ messageId: 'gone1' }) });
        await run(w, f);
        expect(w.data.get(`${mail}/items/a`)).toMatchObject({ status: 'rejected_unapproved_sender', messageGone: true });
        await run(w, f);
        expect(f).toHaveBeenCalledTimes(1);
    });
});

describe('a run settles the waiting reviews FIRST, once every thirty seconds, whatever else it does', () => {
    const sourcePath = `${mail}/items/ntb1`;
    const id = createHash('sha256').update(`${sourcePath}:3`).digest('hex');
    const world = (mailExtra = {}) => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: SENDERS, ...mailExtra },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {}, targets: [], loans: [] },
        [sourcePath]: { uid: 'u', bank: 'NTB', statementType: 'bank_account', last4: '', status: 'needs_review', hasReview: true, cursor: 289, totalRows: 289 },
        [`users/u/statementReview/${id}`]: { uid: 'u', sourcePath, index: 3, status: 'pending', reason: 'ai-consensus-unavailable', row: row(), bank: 'NTB' },
        [`users/u/statementLedger/${id}`]: { uid: 'u', sourcePath, index: 3, status: 'review' },
    });
    const go = (w) => runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f: gmailOk, intake: async () => ({ body: { ok: true } }), read: readStatement, open: async () => [], board: down, extract: async () => { throw new Error('ai-extractor-unavailable'); }, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
    it('the row is filed by its direction in a run that has nothing in its queue, and the pass is stamped', async () => {
        const w = world();
        const out = await go(w);
        expect(out.consensusRecovered).toBe(1);
        expect(w.data.get('users/u').expenses).toHaveLength(1);
        expect(w.data.get(`users/u/statementReview/${id}`).status).not.toBe('pending');
        expect(w.data.get(mail).lastSettleMs).toBeGreaterThan(0);
    });
    it('a second run within thirty seconds does not do the pass again (the quiet-run recovery of old is what is left)', async () => {
        const stamp = Date.now() - 1000;
        const w = world({ lastSettleMs: stamp });
        await go(w);
        expect(w.data.get(mail).lastSettleMs).toBe(stamp);
    });
});

describe('a message today\'s rules do not take as a statement is retired, never put to the owner', () => {
    const itemPath = `${mail}/items/item0`;
    const pdf = Buffer.from('%PDF-1.4 mandate');
    const world = (item = {}) => {
        const fs = createFirestore({
            [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: SENDERS, lastSettleMs: Date.now() },
            'wf-statement-vault/u': { uid: 'u' },
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
            [itemPath]: { uid: 'u', bank: 'NTB', filename: 'Mandate.pdf', from: 'NTB <estatement@info.nationstrust.com>', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'unproven', ...item },
        });
        return fs;
    };
    const go = (w, extra = {}) => runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f: gmailOk, intake: async () => ({ body: { ok: true } }), read: readStatement, open: async () => [], board: down, extract: async () => { throw new Error('ai-extractor-unavailable'); }, settle: settleStatement, maxSteps: 1, budgetMs: 40000, ...extra });
    const replanFails = (planReason) => vi.fn(async () => { throw Object.assign(new Error('statement-sender-no-longer-approved'), { planReason }); });

    it('"the sender is no longer approved" after a re-read retires the item with the reason and never asks the owner; it is not revived a second time', async () => {
        const w = world({ bank: 'Nations Trust' });
        const out = await go(w, { loadAttachment: replanFails('not-a-statement') });
        expect(out.processed).toBe(1);
        expect(w.data.get(itemPath)).toMatchObject({ status: 'rejected_unapproved_sender', filed: false, reviveCount: 2, rejectionReason: 'not-a-statement', leaseToken: '' });
        expect([...w.data.keys()].filter(key => key.includes('/statementReview/'))).toEqual([]);
    });
    it('a statement that already has rows filed is NOT retired that way: it stays a question, as before', async () => {
        const w = world({ cursor: 7, totalRows: 40 });
        await go(w, { loadAttachment: replanFails('x') });
        expect(w.data.get(itemPath)).toMatchObject({ status: 'needs_review', hasReview: true });
        expect([...w.data.keys()].filter(key => key.includes('/statementReview/'))).toHaveLength(1);
    });

    const mandate = ['DIRECT DEBIT MANDATE', 'Customer Name: A B Perera', 'Facility Reference 000123456789', 'Effective Date 25/03/2026   Maximum Amount 5,000.00', 'Signature: ____________'].join('\n');
    const readsAs = (text) => vi.fn(async () => ({ text, parsed: { verdict: 'parsed', understood: false, rows: [{ date: '2026-03-25', narration: 'Direct debit mandate', amount: 5000, direction: 'debit', directionSource: 'assumed', valid: true, needsReview: true }], reconciliation: { ok: false }, layout: {} } }));
    it('a PDF the mail did not vouch for that never says statement, balance, opening or closing — a notice of authority — is retired as not a statement', async () => {
        const w = world({ filename: 'scan0001.pdf' });
        await go(w, { read: readsAs(['NATIONS TRUST BANK PLC', 'Notice of authority', 'Facility Reference 000123456789', 'Effective Date 25/03/2026   Maximum Amount 5,000.00', 'Signature: ____________'].join('\n')), loadAttachment: async () => ({ bytes: pdf, filename: 'scan0001.pdf', contentSha256: 'x' }) });
        expect(w.data.get(itemPath)).toMatchObject({ status: 'rejected_non_statement', filed: false });
        expect([...w.data.keys()].filter(key => key.includes('/statementReview/'))).toEqual([]);
    });
    const notice = ['NATIONS TRUST BANK PLC', 'Notice of authority', 'Facility Reference 000123456789', 'Effective Date 25/03/2026   Maximum Amount 5,000.00'].join('\n');
    it('the same page that says "balance" is a statement the reader could not prove: it goes where it always went, never retired for its words', async () => {
        const w = world({ filename: 'scan0001.pdf' });
        await go(w, { read: readsAs(`${notice}\nBalance brought forward 0.00`), loadAttachment: async () => ({ bytes: pdf, filename: 'scan0001.pdf', contentSha256: 'x' }) });
        expect(w.data.get(itemPath).status).not.toBe('rejected_non_statement');
    });
    it('a mail that says statement is never retired by the plain words of its document (only `unproven` mail is held to them; a document that names itself a form is retired below)', async () => {
        const w = world({ intent: 'stated', filename: 'e-statement.pdf' });
        await go(w, { read: readsAs(notice), loadAttachment: async () => ({ bytes: pdf, filename: 'e-statement.pdf', contentSha256: 'x' }) });
        expect(w.data.get(itemPath).status).not.toBe('rejected_non_statement');
    });
});

describe('the whole-statement replay is part of the settle pass (the queue starved it: the front pass is skipped on every interactive run)', () => {
    const itemPath = `${mail}/items/ntb2`;
    const reviewId = createHash('sha256').update(itemPath).digest('hex');
    const world = () => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: SENDERS },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
        [itemPath]: { uid: 'u', bank: 'NTB', filename: 'Mandate.pdf', status: 'needs_review', hasReview: true, filed: false, cursor: 0, reviewReason: 'statement-layout-or-reconciliation-needs-review' },
        [`users/u/statementReview/${reviewId}`]: { uid: 'u', sourcePath: itemPath, index: -1, status: 'pending', reason: 'statement-layout-or-reconciliation-needs-review', bank: 'NTB' },
    });
    it('a statement stopped at "rows could not be proven to add up" is put back in the queue by a run that is busy with something else', async () => {
        const w = world();
        const loadAttachment = async () => { throw Object.assign(new Error('x'), { defer: 1000 }); };
        await runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f: gmailOk, intake: async () => ({ body: { ok: true } }), read: readStatement, open: async () => [], board: down, extract: async () => { throw new Error('ai-extractor-unavailable'); }, settle: settleStatement, maxSteps: 0, budgetMs: 40000, loadAttachment });
        expect(w.data.get(`users/u/statementReview/${reviewId}`).status).toBe('retried');
        expect(w.data.get(itemPath)).toMatchObject({ status: 'pending', hasReview: false, wholeReplayVersion: expect.any(Number) });
    });
});

describe('a document that calls itself a form is not a statement, whatever the mail around it says', () => {
    const itemPath = `${mail}/items/item0`;
    const pdf = Buffer.from('%PDF-1.4 form');
    const world = (item = {}) => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: SENDERS, lastSettleMs: Date.now() },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
        [itemPath]: { uid: 'u', bank: 'NTB', filename: 'Mandate.pdf', from: 'NTB <estatement@info.nationstrust.com>', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated', ...item },
    });
    const go = (w, text, filename = 'Mandate.pdf') => runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f: gmailOk, intake: async () => ({ body: { ok: true } }), open: async () => [], board: down, extract: async () => { throw new Error('ai-extractor-unavailable'); }, settle: settleStatement, maxSteps: 1, budgetMs: 40000,
        read: async () => ({ text, parsed: { verdict: 'parsed', understood: true, rows: [{ date: '2026-03-25', narration: 'Mandate fee', amount: 5000, direction: 'debit', directionSource: 'assumed', valid: true, needsReview: true }], reconciliation: { ok: false, opening: 10, closing: 20 }, layout: {} } }),
        loadAttachment: async () => ({ bytes: pdf, filename, contentSha256: 'x' }) });
    const mandate = ['NATIONS TRUST BANK', 'DIRECT DEBIT MANDATE', 'Statement balance of my credit card account will be debited on the due date', 'Effective Date 25/03/2026   Maximum Amount 5,000.00', 'Opening balance 10.00  Closing balance 20.00'].join('\n');
    it('the mail says statement, the document says MANDATE in its title and its rows do not reconcile: retired, with the reason (the mail\'s words and a "balance" in the small print do not save it)', async () => {
        const w = world();
        await go(w, ['NATIONS TRUST BANK PLC', 'DIRECT DEBIT MANDATE', 'Authority to debit the account named below', 'Effective Date 25/03/2026   Maximum Amount 5,000.00', 'Opening balance 10.00  Closing balance 20.00'].join('\n'));
        expect(w.data.get(itemPath)).toMatchObject({ status: 'rejected_non_statement', rejectionReason: expect.stringContaining('mandate') });
        expect([...w.data.keys()].filter(key => key.includes('/statementReview/'))).toEqual([]);
    });
    it('the file name alone is enough when the title is silent', async () => {
        const w = world();
        await go(w, ['Nations Trust Bank PLC', 'Authority to debit the account named below', 'Effective Date 25/03/2026   Maximum Amount 5,000.00'].join('\n'));
        expect(w.data.get(itemPath)).toMatchObject({ status: 'rejected_non_statement' });
    });
    it('a title that says statement is never a form, even with "terms and conditions" beside it', async () => {
        const w = world({ filename: 'e-statementPDF.pdf' });
        await go(w, ['NATIONS TRUST BANK', 'Credit Card Statement - Terms and Conditions apply', mandate].join('\n'), 'e-statementPDF.pdf');
        expect(w.data.get(itemPath).status).not.toBe('rejected_non_statement');
    });
});

describe('the owner\'s audit screen is built from the last report when this run made no new one', () => {
    const stored = { at: 123, missing: 0, empties: [], refused: [], log: [{ month: '2026-08', bank: 'DFCC', file: 'DFCC Bank Statement - Aug 26.pdf', status: 'filed', math: 'ok' }], table: { total: 5, counts: { INGESTED: 5 }, senders: [] } };
    const world = (extra = {}) => createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: SENDERS, lastSettleMs: Date.now(), coverage: stored, ...extra },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} },
    });
    const go = (w) => runStatementSync({ action: 'collect', interactive: true, db: w.db, owner, env: {}, f: gmailOk, intake: async () => ({ body: { ok: true } }), read: readStatement, open: async () => [], board: down, extract: async () => { throw new Error('ai-extractor-unavailable'); }, settle: settleStatement, maxSteps: 1, budgetMs: 40000 });
    it('an interactive run inside the ninety seconds (no housekeeping) still returns the stored report, so the screen is never empty', async () => {
        const out = await go(world({ lastFrontMs: Date.now() }));
        expect(out.coverage).toEqual(stored);
    });
    it('nothing is invented when no report was ever made', async () => {
        const w = world({ lastFrontMs: Date.now() });
        const bare = createFirestore({ [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: SENDERS, lastSettleMs: Date.now(), lastFrontMs: Date.now() }, 'wf-statement-vault/u': { uid: 'u' }, 'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], subscriptions: [], settings: {} } });
        expect((await go(bare)).coverage).toBeUndefined();
        void w;
    });
});
