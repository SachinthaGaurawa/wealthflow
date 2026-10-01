import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { textPdf } from './helpers/embedded-statements.js';
import { runStatementSync, recheckPhantomStatements, ownerCloseEmpty, reopenEmptyStatement, PHANTOM_CHECK_VERSION } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement, sourceOccurrenceId } from '../statement-ledger.mjs';

// The owner's 34 pending "reviews" are HNB account statements for months in which nothing happened: the reader
// turned a line with a month-end date and no words into one "transaction" with no amount. The statement must be
// read again and judged on its own text — closed as empty only when everything agrees, and never when it is not.
const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com';
const sha = v => createHash('sha256').update(v).digest('hex');
const head = ['HATTON NATIONAL BANK PLC', 'Account Statement', 'Account No 074-02-XXXXX-88', 'Statement Period 01/04/2024 - 30/04/2024', 'Date Description Cheque No Debit Credit Balance'];
const pdf = (...tail) => textPdf([...head, ...tail]);
const layouts = {
    phantom: pdf('30/04/2024 0.00'),
    phantomWide: pdf('30/04/2024 30/04/2024 0.00 0.00 0.00'),
    agree: pdf('Opening Balance 12,345.67', 'Closing Balance 12,345.67', 'No transactions for this period'),
    moved: pdf('Opening Balance 12,345.67', '30/04/2024 0.00', 'Closing Balance 11,000.00'),
    zeroLines: pdf('01/04/2024 B/F 0.00', '30/04/2024 Interest 0.00 0.00', '30/04/2024 C/F 0.00'),
    hidden: pdf('30-Apr-2024 0.00 12,345.67', 'POS SHOP ONE 1,500.00'),
    /* THE OWNER'S ACTUAL HNB PAGE, as the production log's layout skeleton of 2026-10-01 describes it (288 characters, 11 lines): no "statement", no
     * "account no", no period, no closing label — a title and an address, the account, LKR, a labelled "B/F 0.00", a dated "0.00", a footer. A zero
     * balance and nothing moved, for thirty-four months. */
    real: textPdf(['1', 'MRS. SILVA A B C', 'NO 12/3,TEMPLE ROAD,KANDY', 'A/C 074020123488', 'LKR', 'person@example.com HNB SMART ACCOUNT', '01.09.26 B/F 0.00', '0 0', '30-09-2026 0.00',
        'THE ACCOUNT BALANCE IS SHOWN ABOVE. REPORT ANY ERROR TO 0112 462 462', 'THIS IS A COMPUTER GENERATED DOCUMENT E&OE.']),
    /* NTB's monthly withholding-tax certificate (11823064_….pdf), as the production log's layout skeleton of 2026-10-01 describes it: no "statement", no balance,
     * no opening or closing line, no transaction — a certificate number, the bank, the depositor, an interest period, one interest line and a tax rate. */
    taxCertificate: textPdf(['Certificate No: NTB/2026/09/12345678', 'Tax Deduction Certificate', 'Name and Address of the Bank: Nations Trust Bank PLC, No.242, Union Place, Colombo 02', 'Name of the Deposit Holder: A B PERERA', 'National Identity Card No: 123456789V', 'Tax Identification No:',
        'Interest for Period : from 01-Sep-2026 to 30-Sep-2026', 'Total amount of Interest: LKR 1,234.56', 'Account Account Account Interest Tax', 'Type Number Rate Deducted', 'Savings 123456789012 5% 61.73 1,234.56']),
    realMoved: textPdf(['1', 'MRS. SILVA A B C', 'NO 12/3,TEMPLE ROAD,KANDY', 'A/C 074020123488', 'LKR', 'person@example.com HNB SMART ACCOUNT', '01.09.26 B/F 0.00', '0 0', '30-09-2026 1,250.00',
        'THE ACCOUNT BALANCE IS SHOWN ABOVE. REPORT ANY ERROR TO 0112 462 462', 'THIS IS A COMPUTER GENERATED DOCUMENT E&OE.']),
};
const board = (lines = 0) => vi.fn(async () => ({ fields: { transactionLines: lines }, unanimous: true }));
const down = () => vi.fn(async () => { throw new Error('ai-consensus-unavailable'); });

function setup(name, { source = {}, bytes, withBoard = board() } = {}) {
    const filename = `074-02-XXXXX-88_${name}.pdf`, sourcePath = `${mailPath}/items/item0`;
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@hnb.lk', kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
        [sourcePath]: { uid: 'u', bank: 'HNB', filename, from: 'statements@hnb.lk', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2024-05-02T05:00:00Z'), ...source },
    });
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = async () => ({ bytes: Buffer.from(bytes || layouts[name]), filename, contentSha256: 'x' });
    const open = async () => [{ password: 'fixture-password', bank: 'HNB' }];
    const drain = (extra = {}) => runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open, settle: settleStatement, board: withBoard, loadAttachment, ...extra });
    return { db, data, sourcePath, drain, board: withBoard, source: () => data.get(sourcePath), reviews: () => [...data.entries()].filter(([k]) => k.startsWith('users/u/statementReview/')).map(([k, v]) => ({ id: k.split('/').pop(), ...v })) };
}

describe('a statement with no transactions is closed when — and only when — the statement itself shows it', () => {
    it.each(['phantom', 'phantomWide'])('closes the owner\'s HNB shape (%s) as empty with the evidence, once the AI board also finds no transactions', async name => {
        const s = setup(name);
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'filed', filed: true, emptyStatement: true, hasReview: false });
        expect(s.source().emptyEvidence).toMatchObject({ balances: 'absent', how: 'rules+ai', witness: 'agrees', phantomRows: 1, pdf: 'text' });
        expect(s.reviews()).toEqual([]);
        expect(s.data.get('users/u')).toEqual({ expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] });
        expect(s.board).toHaveBeenCalledTimes(1);
        expect(s.board.mock.calls[0][0]).toContain('transactionLines'); expect(s.board.mock.calls[0][0]).not.toContain('074-02-XXXXX-88'.replace(/-/g, ''));
    });
    it('still closes it when the AI board cannot be reached, and says so in the evidence', async () => {
        const s = setup('phantom', { withBoard: down() });
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'filed', emptyStatement: true });
        expect(s.source().emptyEvidence).toMatchObject({ how: 'rules', witness: 'unavailable' });
    });
    it('does NOT close it when the AI board counts transaction lines the rules did not see', async () => {
        const s = setup('phantom', { withBoard: board(3) });
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'needs_review', reviewReason: 'statement-layout-or-reconciliation-needs-review' });
        expect(s.source().emptyStatement).not.toBe(true);
        // one question about the statement — never a row that is not on it
        expect(s.reviews()).toHaveLength(1); expect(s.reviews()[0]).toMatchObject({ index: -1, status: 'pending' });
    });
    it('closes a statement that states equal opening and closing balances and says there was no activity', async () => {
        const s = setup('agree');
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'filed', emptyStatement: true });
        expect(s.source().emptyEvidence).toMatchObject({ balances: 'agree', noActivityStated: true });
    });
    it('closes a statement made only of zero lines with words ("Interest 0.00") instead of filing it unexamined', async () => {
        const s = setup('zeroLines');
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'filed', emptyStatement: true });
        expect(s.source().emptyEvidence.balances).toBe('agree');
    });
    it('never closes a statement whose balance moved', async () => {
        const s = setup('moved');
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'needs_review' }); expect(s.source().emptyStatement).not.toBe(true);
    });
    it('never closes a statement with money on a line the reader did not turn into a row', async () => {
        const s = setup('hidden');
        await s.drain();
        expect(s.source().emptyStatement).not.toBe(true); expect(s.source().status).toBe('needs_review');
        expect(s.board).not.toHaveBeenCalled();
    });
    it('never closes a month the owner reopened, however empty it looks', async () => {
        const s = setup('phantom', { source: { emptyOverride: 'owner' } });
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'needs_review' }); expect(s.source().emptyStatement).not.toBe(true);
    });
    const unclear = textPdf(['HATTON NATIONAL BANK PLC', 'Account Statement', 'Account No 074-02-XXXXX-88', 'Date Description Debit Credit Balance', '30/04/2024 Nil']);
    it('an unclear month (nothing shows it was empty, nothing shows it was not) is closed on the rules\' finding plus the AI board\'s independent count of zero — not put to the owner', async () => {
        const s = setup('x', { bytes: unclear });
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'filed', filed: true, emptyStatement: true, hasReview: false });
        expect(s.source().emptyEvidence).toMatchObject({ how: 'rules+ai', witness: 'agrees', balances: 'absent' });
        expect(s.reviews()).toEqual([]);
        expect(s.board).toHaveBeenCalledTimes(1);
    });
    it('a month closed as empty leaves a log line of its own (fixed words, no figure), so "processed 1, filed" can be told from a filing with rows', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const s = setup('x', { bytes: unclear });
            await s.drain();
            const items = info.mock.calls.map(call => { try { return JSON.parse(String(call[0])); } catch (_) { return null; } }).filter(line => line && line.evt === 'statement-sync-item');
            expect(items).toEqual([{ evt: 'statement-sync-item', bank: 'HNB', status: 'closed_empty', how: 'rules+ai', witness: 'agrees', strength: 'witnessed', reviewsResolved: 0 }]);
        } finally { info.mockRestore(); }
    });
    it('…waits for the board when it cannot be heard (no question to the owner), and is a statement the rules could not read when the board counts lines', async () => {
        const waiting = setup('x', { bytes: unclear, withBoard: down() });
        await waiting.drain();
        expect(waiting.source().emptyStatement).not.toBe(true); expect(waiting.source().status).not.toBe('needs_review'); expect(waiting.reviews()).toEqual([]);
        const counted = setup('x', { bytes: unclear, withBoard: board(2) });
        await counted.drain();
        expect(counted.source()).toMatchObject({ status: 'needs_review', reviewReason: 'statement-layout-or-reconciliation-needs-review' });
    });
    it('asks the owner, once and plainly, only when the page itself shows money moving in totals but no row could be read', async () => {
        const s = setup('x', { bytes: textPdf(['HATTON NATIONAL BANK PLC', 'Account Statement', 'Account No 074-02-XXXXX-88', 'Date Description Debit Credit Balance', 'Total credits 5,000.00']) });
        await s.drain();
        expect(s.source().emptyStatement).not.toBe(true);
        expect(s.source().status).toBe('needs_review');
        expect(s.reviews()).toHaveLength(1);
    });
});

describe('a tax certificate the mail only "suspects" is retired, not put to the owner as a statement that could not be proven (three NTB PDFs, 2026-10-01)', () => {
    it('is retired as a non-statement when the mail did not vouch for it and it has no statement structure', async () => {
        const s = setup('taxCertificate', { source: { bank: 'NTB', intent: 'suspect' } });
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'rejected_non_statement', filed: false });
        expect(s.source().rejectionReason).toMatch(/does not prove itself a statement/);
        expect(s.reviews()).toEqual([]);
    });
    it('is still never retired when the mail itself vouched for it (a statement with this shape stays the owner\'s to judge)', async () => {
        const s = setup('taxCertificate', { source: { bank: 'NTB', intent: 'stated' } });
        await s.drain();
        expect(s.source().status).not.toBe('rejected_non_statement');
    });
    it('a real statement that the mail suspects is NOT retired: its own structure proves it', async () => {
        const s = setup('agree', { source: { intent: 'suspect' } });
        await s.drain();
        expect(s.source().status).not.toBe('rejected_non_statement');
    });
});

describe('the owner\'s real HNB page: a zero balance, nothing moved, and a page that says nothing about itself', () => {
    it('is recognised as a ledger, closed as empty on the page alone ONLY with the AI board\'s independent count, and never reaches the owner', async () => {
        const s = setup('real');                                               // no `intent` on the item, as in production (diag.intent was "")
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'filed', filed: true, emptyStatement: true, hasReview: false });
        expect(s.source().emptyEvidence).toMatchObject({ balances: 'zero', how: 'rules+ai', witness: 'agrees', pdf: 'text' });
        expect(s.reviews()).toEqual([]);
        expect(s.board).toHaveBeenCalledTimes(1);
    });
    it('is NOT closed while the AI board cannot be reached: the page alone is not enough, so it waits (no question to the owner, nothing filed)', async () => {
        const s = setup('real', { withBoard: down() });
        await s.drain();
        expect(s.source().emptyStatement).not.toBe(true); expect(s.source().filed).not.toBe(true);
        expect(s.source().status).not.toBe('needs_review');
        expect(s.reviews()).toEqual([]);
    });
    it('waiting for ROOM is not a failed attempt; waiting because the board is down is (the 34 HNB statements took turns at the little room each run had)', async () => {
        const noRoom = setup('real', { withBoard: down() });
        await noRoom.drain({ startedAt: Date.now() - 40000 });                   // 8 s of the invocation left: no room for the board's two calls
        expect(noRoom.source()).toMatchObject({ status: 'pending', filed: false, leaseToken: '' });
        expect(Number(noRoom.source().retryCount) || 0).toBe(0);
        expect(noRoom.source().retryAt).toBeGreaterThan(Date.now());
        expect(noRoom.source().lastRetryReason).toBeUndefined();
        const down30 = setup('real', { withBoard: down() });
        await down30.drain();                                                    // plenty of room, board unreachable: an attempt that failed
        expect(down30.source()).toMatchObject({ status: 'pending', retryCount: 1 });
    });
    it('is NOT closed when the board counts transaction lines the rules did not see', async () => {
        const s = setup('real', { withBoard: board(2) });
        await s.drain();
        expect(s.source().emptyStatement).not.toBe(true); expect(s.source().status).toBe('needs_review');
    });
    it('is NOT closed when any amount on the page is not zero', async () => {
        const s = setup('realMoved');
        await s.drain();
        expect(s.source().emptyStatement).not.toBe(true);
    });
    it('and a mail that PREVIOUSLY said "unproven" or "suspect" keeps the old gate: a page that says nothing, from a mail that said nothing, is not taken on its shape', async () => {
        const s = setup('x', { bytes: textPdf(['Thanks for your order', 'Total 0.00']), source: { intent: 'suspect' } });
        await s.drain();
        expect(s.source().emptyStatement).not.toBe(true);
    });
});

describe('the 34 reviews already waiting are re-read, not assumed', () => {
    const seed = (s, { index = 0, ledgerStatus = 'review', row } = {}) => {
        const id = sourceOccurrenceId(s.sourcePath, index);
        s.data.set(`users/u/statementReview/${id}`, { uid: 'u', sourcePath: s.sourcePath, index, status: 'pending', reason: 'invalid-transaction', row: row || { date: '2024-04-30', narration: '', amount: 0, direction: '', balance: 0, valid: false }, bank: 'HNB', filename: s.source().filename });
        s.data.set(`users/u/statementLedger/${id}`, { uid: 'u', sourcePath: s.sourcePath, index, status: ledgerStatus, fingerprint: 'old' });
        s.data.set(s.sourcePath, { ...s.source(), status: 'needs_review', hasReview: true, cursor: 1, totalRows: 1 });
        return id;
    };
    it('requeues the statement, and the next read closes it with its evidence and clears the review', async () => {
        const s = setup('phantom');
        const id = seed(s);
        expect(await recheckPhantomStatements({ db: s.db, uid: 'u' })).toEqual({ requeued: 1, more: false });
        expect(s.data.get(`users/u/statementReview/${id}`).status).toBe('superseded_by_recheck');
        expect(s.data.get(`users/u/statementLedger/${id}`).status).toBe('superseded_by_layout');
        expect(s.source()).toMatchObject({ status: 'pending', cursor: 0, phantomCheck: PHANTOM_CHECK_VERSION });
        await s.drain();
        expect(s.source()).toMatchObject({ status: 'filed', emptyStatement: true });
        expect(s.reviews().filter(r => r.status === 'pending')).toEqual([]);
    });
    it('a replay that does find a real statement leaves the owner one clear question, not the phantom row', async () => {
        const s = setup('hidden');
        const id = seed(s);
        await recheckPhantomStatements({ db: s.db, uid: 'u' });
        await s.drain();
        expect(s.data.get(`users/u/statementReview/${id}`).status).toBe('superseded_by_recheck');
        expect(s.reviews().filter(r => r.status === 'pending')).toMatchObject([{ index: -1 }]);
    });
    it('does nothing for a month the owner reopened, for one already rechecked, for real rows, or for a review about something else', async () => {
        for (const [source, row, reason] of [[{ emptyOverride: 'owner' }], [{ phantomCheck: PHANTOM_CHECK_VERSION }], [{}, { date: '2024-04-05', narration: 'POS SHOP ONE', amount: 1500, valid: false }], [{}, undefined, 'unproven-direction']]) {
            const s = setup('phantom', { source });
            const id = seed(s, { row }); if (reason) s.data.set(`users/u/statementReview/${id}`, { ...s.data.get(`users/u/statementReview/${id}`), reason });
            expect((await recheckPhantomStatements({ db: s.db, uid: 'u' })).requeued).toBe(0);
            expect(s.data.get(`users/u/statementReview/${id}`).status).toBe('pending');
        }
    });
    it('keeps any other question about the same statement, and only withdraws the phantom', async () => {
        const s = setup('phantom');
        const phantomId = seed(s);
        const otherId = sourceOccurrenceId(s.sourcePath, 1);
        s.data.set(`users/u/statementReview/${otherId}`, { uid: 'u', sourcePath: s.sourcePath, index: 1, status: 'pending', reason: 'unproven-direction', row: { date: '2024-04-05', narration: 'SHOP', amount: 10 } });
        s.data.set(`users/u/statementLedger/${otherId}`, { uid: 'u', sourcePath: s.sourcePath, index: 1, status: 'review', fingerprint: 'x' });
        await recheckPhantomStatements({ db: s.db, uid: 'u' });
        expect(s.data.get(`users/u/statementReview/${phantomId}`).status).toBe('superseded_by_recheck');
        expect(s.data.get(`users/u/statementReview/${otherId}`).status).toBe('pending');
        expect(s.data.get(`users/u/statementLedger/${otherId}`).status).toBe('review');
        expect(s.source().hasReview).toBe(true);
    });
    it('rechecks a bounded number per run and says when there are more, and is idempotent', async () => {
        const { db, data } = createFirestore({ [mailPath]: { uid: 'u' }, 'users/u': {} });
        for (let n = 0; n < 7; n++) {
            const path = `${mailPath}/items/item${n}`, id = sourceOccurrenceId(path, 0);
            data.set(path, { uid: 'u', status: 'needs_review', hasReview: true, bank: 'HNB', filename: `f${n}.pdf` });
            data.set(`users/u/statementReview/${id}`, { uid: 'u', sourcePath: path, index: 0, status: 'pending', reason: 'invalid-transaction', row: { date: '2024-04-30', narration: '', amount: 0 } });
            data.set(`users/u/statementLedger/${id}`, { uid: 'u', sourcePath: path, index: 0, status: 'review' });
        }
        expect(await recheckPhantomStatements({ db, uid: 'u', limit: 3 })).toEqual({ requeued: 3, more: true });
        expect(await recheckPhantomStatements({ db, uid: 'u', limit: 3 })).toEqual({ requeued: 3, more: true });
        expect(await recheckPhantomStatements({ db, uid: 'u', limit: 3 })).toEqual({ requeued: 1, more: false });
        expect(await recheckPhantomStatements({ db, uid: 'u', limit: 3 })).toEqual({ requeued: 0, more: false });
    });
    it('runs inside the unattended sync and reports how many it took back', async () => {
        const s = setup('phantom');
        seed(s);
        const intake = async () => ({ body: { ok: true, collectionPending: false } });
        const f = async url => String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '5' }) } : { ok: true, json: async () => ({ access_token: 'token' }) };
        const out = await runStatementSync({ action: 'collect', db: s.db, owner, env: {}, f, read: readStatement, open: async () => [{ password: 'fixture-password', bank: 'HNB' }], settle: settleStatement, board: board(), intake,
            loadAttachment: async () => ({ bytes: Buffer.from(layouts.phantom), filename: 'x.pdf', contentSha256: 'x' }) });
        expect(out.phantomRequeued).toBe(1);
        expect(s.source()).toMatchObject({ status: 'filed', emptyStatement: true });
    });
});

describe('a phantom row among real ones is skipped without disturbing the numbering', () => {
    it('keeps every row\'s position, raises nothing for the empty one, and files the real ones', async () => {
        const { db, data } = createFirestore({ 'users/u': { expenses: [] } });
        const sourceRef = db.doc(`${mailPath}/items/item0`), now = Date.now();
        data.set(sourceRef.path, { uid: 'u', leaseToken: 't', leaseUntil: now + 60000, cursor: 0, status: 'processing', bank: 'HNB' });
        const real = { directionSource: 'column', needsReview: false, direction: 'debit' };
        const rows = [{ ...real, date: '2024-04-05', description: 'POS SHOP ONE', amount: 1500 }, { date: '2024-04-30', description: '', amount: 0, direction: '', valid: false }, { ...real, date: '2024-04-09', description: 'POS SHOP TWO', amount: 900 }];
        const decisions = rows.map(() => ({ module: 'expenses', category: 'Food', verified: true }));
        const out = await settleStatement({ db, uid: 'u', sourceRef, leaseToken: 't', rows, decisions, now, cursor: 0, totalRows: 3, bank: 'HNB', last4: '8888' });
        expect(out).toMatchObject({ review: 0, skipped: 1, status: 'filed' });
        expect(data.get(`users/u/statementLedger/${sourceOccurrenceId(sourceRef.path, 1)}`)).toMatchObject({ status: 'skipped', reason: 'empty-line', index: 1 });
        expect(data.get('users/u').expenses.map(r => [r.statementRow, r.amount])).toEqual([[0, 1500], [2, 900]]);
        expect([...data.keys()].filter(k => k.startsWith('users/u/statementReview/'))).toEqual([]);
    });
});

describe('the one question the system may ask about an empty month', () => {
    const asked = async () => {
        // a question is still put to the owner when the page shows money moving in a total and no row could be read; the review is the one the old rule raised
        const s = setup('x', { bytes: textPdf(['HATTON NATIONAL BANK PLC', 'Account Statement', 'Account No 074-02-XXXXX-88', 'Date Description Debit Credit Balance', '30/04/2024 Nil']), withBoard: down() });
        await s.drain();
        const id = createHash('sha256').update(s.sourcePath).digest('hex');
        s.data.set(s.sourcePath, { ...s.source(), status: 'needs_review', reviewReason: 'statement-empty-needs-confirmation', hasReview: true, filed: false, leaseToken: '', leaseUntil: 0 });
        s.data.set('users/u/statementReview/' + id, { uid: 'u', sourcePath: s.sourcePath, index: -1, status: 'pending', reason: 'statement-empty-needs-confirmation', bank: 'HNB', filename: 'x.pdf' });
        return { s, review: s.reviews()[0] };
    };
    it('is answered with one tap: closed empty on the owner\'s word, recorded as such, and reversible', async () => {
        const { s, review } = await asked();
        expect(await ownerCloseEmpty({ db: s.db, owner, id: review.id })).toEqual({ ok: true, closed: true });
        expect(s.source()).toMatchObject({ status: 'filed', filed: true, emptyStatement: true, hasReview: false, emptyEvidence: { how: 'owner' } });
        expect(s.reviews()[0]).toMatchObject({ status: 'resolved', resolvedBy: 'owner' });
        await reopenEmptyStatement({ db: s.db, owner, id: 'item0' });
        expect(s.source()).toMatchObject({ status: 'pending', emptyStatement: false, emptyOverride: 'owner' });
    });
    it('cannot be used on anything else: another kind of review, someone else\'s, an unknown id, or a statement already filed', async () => {
        const { s, review } = await asked();
        s.data.set(`users/u/statementReview/${review.id}`, { ...s.data.get(`users/u/statementReview/${review.id}`), reason: 'statement-layout-or-reconciliation-needs-review' });
        await expect(ownerCloseEmpty({ db: s.db, owner, id: review.id })).rejects.toThrow('not-an-empty-month-question');
        s.data.set(`users/u/statementReview/${review.id}`, { ...s.data.get(`users/u/statementReview/${review.id}`), reason: 'statement-empty-needs-confirmation' });
        await expect(ownerCloseEmpty({ db: s.db, owner: { uid: 'other', email: 'x@y.z' }, id: review.id })).rejects.toThrow('not-an-empty-month-question');
        await expect(ownerCloseEmpty({ db: s.db, owner, id: 'nope' })).rejects.toThrow();
        await expect(ownerCloseEmpty({ db: s.db, owner, id: '../x' })).rejects.toThrow('invalid-close-request');
        s.data.set(s.sourcePath, { ...s.source(), filed: true });
        await expect(ownerCloseEmpty({ db: s.db, owner, id: review.id })).rejects.toThrow('statement-not-closable');
    });
});
