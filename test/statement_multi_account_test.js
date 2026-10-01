import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { loadParser } from './statement-fixtures.mjs';
import { textPdf } from './helpers/embedded-statements.js';
import { readStatement } from '../statement-reader.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync } from '../statement-sync.js';
import { createHash } from 'node:crypto';
import { settleStatement } from '../statement-ledger.mjs';

const P = loadParser(fs);

// DFCC (production, 2026-10-01, "DFCC Bank Statement - Aug 26.pdf"): one document, TWO accounts — a Current Account and a Savings account — each with
// its own opening balance and its own running balance. The parser chained every row into one sum, so the books of the document could never balance
// ("The rows could not be proven to add up to this statement's balances"), whatever the rows said. Each account is proven on its own.
const DFCC = `
DFCC BANK PLC
Statement
Statement Period: 01/08/2026 - 31/08/2026
Balance Summary
Currency Available Balance
Current LKR 100,000.00
Savings LKR 5,000.00
Account(s) Summary
Account Number Account Type Currency Balance
123456789012 Current Account LKR 100,000.00
210987654321 Savings LKR 5,000.00
Page 1 of 2
Account Number: 123456789012
Account Type: Current Account
Transaction Period: 01/08/2026 - 31/08/2026
Currency: LKR
Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance
01/08/2026 Opening Balance 120,000.00
03/08/2026 03/08/2026 POS Transaction KEELLS SUPER 1234567890 4,000.00 116,000.00
10/08/2026 10/08/2026 SALARY CREDIT 7654321098 30,000.00 146,000.00
20/08/2026 20/08/2026 CEB ELECTRICITY BILL 9876543210 46,000.00 100,000.00
Account Number: 210987654321
Account Type: Savings
Transaction Period: 01/08/2026 - 31/08/2026
Currency: LKR
Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance
01/08/2026 Opening Balance 4,000.00
15/08/2026 15/08/2026 Interest Credit 1111111111 1,000.00 5,000.00
`;

describe('a statement with two accounts is proven account by account', () => {
    const parsed = P.parseStatement(DFCC);
    it('reads every row of both accounts and says it understood the statement', () => {
        expect(parsed.rows.map(row => [row.date, row.amount, row.direction])).toEqual([
            ['2026-08-03', 4000, 'debit'], ['2026-08-10', 30000, 'credit'], ['2026-08-20', 46000, 'debit'], ['2026-08-15', 1000, 'credit'],
        ]);
        expect(parsed.verdict).toBe('parsed');
        expect(parsed.understood).toBe(true);
        expect(parsed.reconciliation.ok).toBe(true);
        expect(parsed.reconciliation.sections).toBe(2);
    });
    it('each row says which account it belongs to (the last four digits), so the ledger never mixes the two', () => {
        expect(parsed.rows.map(row => row.card_last4)).toEqual(['9012', '9012', '9012', '4321']);
    });
    it('a row missing from ONE account still fails the proof — the other account cannot cover for it', () => {
        const missing = P.parseStatement(DFCC.replace('10/08/2026 10/08/2026 SALARY CREDIT 7654321098 30,000.00 146,000.00\n', ''));
        expect(missing.reconciliation.ok).not.toBe(true);
        expect(missing.understood).toBe(false);
        const altered = P.parseStatement(DFCC.replace('1,000.00 5,000.00', '900.00 5,000.00'));          // an amount that no longer matches the balance the bank printed
        expect(altered.understood).toBe(false);
        const oneOpening = P.parseStatement(DFCC.replace('01/08/2026 Opening Balance 4,000.00', '01/08/2026 Opening Balance 3,000.00'));
        expect(oneOpening.reconciliation.ok).not.toBe(true);                                              // the second account no longer balances on its own
        expect(oneOpening.understood).toBe(false);
    });
    it('a one-account statement is exactly as before (no account tag, the same proof)', () => {
        const single = P.parseStatement(`
01/07/2026 OPENING BALANCE 100,000.00
02/07/2026 KEELLS SUPER COLOMBO 4,250.00 95,750.00
03/07/2026 SALARY JULY 250,000.00 345,750.00
`);
        expect(single.reconciliation).toMatchObject({ ok: true });
        expect(single.reconciliation.sections).toBeUndefined();
        expect(single.rows.every(row => row.card_last4 === undefined)).toBe(true);
    });
    it('page-by-page "brought forward / carried forward" lines of ONE account still balance as one statement', () => {
        const paged = P.parseStatement(`
Account Number: 123456789012
01/07/2026 Balance B/F 100,000.00
02/07/2026 KEELLS 4,000.00 96,000.00
03/07/2026 SALARY 10,000.00 106,000.00
05/07/2026 Balance C/F 106,000.00
Page 1 of 2
05/07/2026 Balance B/F 106,000.00
06/07/2026 CEB 6,000.00 100,000.00
`);
        expect(paged.reconciliation.ok).toBe(true);
        expect(paged.understood).toBe(true);
    });
});

describe('the server reads the two-account PDF the same way', () => {
    it('a text PDF with two accounts is understood, reconciled, and its rows carry their account', async () => {
        const result = await readStatement({ bytes: textPdf(DFCC.trim().split('\n')), filename: 'DFCC Bank Statement - Aug 26.pdf', bank: 'DFCC Bank' });
        expect(result.parsed.verdict).toBe('parsed');
        expect(result.parsed.understood).toBe(true);
        expect(result.parsed.rows).toHaveLength(4);
        expect(result.parsed.rows.map(row => row.card_last4)).toEqual(['9012', '9012', '9012', '4321']);
    });
});

describe('and files it: every row of both accounts, once', () => {
    it('is read from the mailbox item, reconciled per account, and filed with no question to the owner', async () => {
        const owner = { uid: 'u', email: 'owner@example.com' }, mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
        const { db, data } = createFirestore({
            [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@dfccbank.com', kind: 'address', status: 'approved', name: 'DFCC Bank', domain: 'dfccbank.com' }] },
            'wf-statement-vault/u': { uid: 'u' },
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
            [sourcePath]: { uid: 'u', bank: 'DFCC Bank', filename: 'DFCC Bank Statement - Aug 26.pdf', from: 'statements@dfccbank.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-09-04T05:00:00Z') },
        });
        const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
        const loadAttachment = async () => ({ bytes: textPdf(DFCC.trim().split('\n')), filename: 'DFCC Bank Statement - Aug 26.pdf', contentSha256: 'x' });
        const open = async () => [{ password: 'fixture-password', bank: 'DFCC Bank' }];
        const board = async () => { throw new Error('ai-consensus-unavailable'); };
        await runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open, settle: settleStatement, board, loadAttachment });
        expect(data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, hasReview: false });
        const user = data.get('users/u');
        expect(user.expenses).toHaveLength(2); expect(user.incomeRecv).toHaveLength(2);
        expect([...data.keys()].filter(k => k.startsWith('users/u/statementReview/'))).toEqual([]);
        expect(user.expenses.map(r => r.amount).sort((a, b) => a - b)).toEqual([4000, 46000]);
        expect(user.incomeRecv.map(r => r.amount).sort((a, b) => a - b)).toEqual([1000, 30000]);
    });
});

describe('a two-account statement that stopped before the reader could prove it is read again, and filed', () => {
    it('the DFCC Aug 26 statement, stopped for reconciliation and already replayed once, is read again by the new reader with no question to the owner', async () => {
        const owner = { uid: 'u', email: 'owner@example.com' }, mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
        const reviewId = createHash('sha256').update(sourcePath).digest('hex');
        const reason = 'statement-layout-or-reconciliation-needs-review';
        const { db, data } = createFirestore({
            [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@dfccbank.com', kind: 'address', status: 'approved', name: 'DFCC Bank', domain: 'dfccbank.com' }] },
            'wf-statement-vault/u': { uid: 'u' },
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
            [sourcePath]: { uid: 'u', bank: 'DFCC Bank', filename: 'DFCC Bank Statement - Aug 26.pdf', from: 'statements@dfccbank.com', messageId: 'm0', status: 'needs_review', reviewReason: reason, hasReview: true, filed: false, cursor: 0, wholeReplayVersion: 9, receivedMs: Date.parse('2026-09-04T05:00:00Z') },
            ['users/u/statementReview/' + reviewId]: { uid: 'u', sourcePath, index: -1, status: 'pending', reason },
        });
        const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
        const loadAttachment = async () => ({ bytes: textPdf(DFCC.trim().split('\n')), filename: 'DFCC Bank Statement - Aug 26.pdf', contentSha256: 'x' });
        const open = async () => [{ password: 'fixture-password', bank: 'DFCC Bank' }];
        const board = async () => { throw new Error('ai-consensus-unavailable'); };
        for (let run = 0; run < 3 && data.get(sourcePath).status !== 'filed'; run += 1) await runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open, settle: settleStatement, board, loadAttachment });
        expect(data.get(sourcePath)).toMatchObject({ status: 'filed', filed: true, hasReview: false, wholeReplayVersion: 10 });
        expect(data.get('users/u/statementReview/' + reviewId).status).not.toBe('pending');
        const user = data.get('users/u');
        expect(user.expenses).toHaveLength(2); expect(user.incomeRecv).toHaveLength(2);
    });
});
