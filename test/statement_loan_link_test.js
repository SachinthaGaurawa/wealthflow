import { describe, expect, it, vi } from 'vitest';
import { textPdf } from './helpers/embedded-statements.js';
import { readStatement } from '../statement-reader.mjs';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync, healLoanInstallments } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';

// The owner's complaint: a loan installment paid from the bank account was counted twice — as the statement's debit and by the loan's own
// schedule. The worker now links such a debit to the loan's month as it files it, and links the ones already in the books.

const STATEMENT = `
HATTON NATIONAL BANK PLC
Statement Period: 01/03/2026 - 31/03/2026
Account Number: 074020012388
Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance
01/03/2026 Opening Balance 200,000.00
05/03/2026 05/03/2026 LOAN INSTALMENT 0741234567 45,230.50 154,769.50
09/03/2026 09/03/2026 POS Transaction KEELLS SUPER 1234567890 4,000.00 150,769.50
12/03/2026 12/03/2026 LOAN PROCESSING FEE 2,500.00 148,269.50
`;
const loan = (extra = {}) => ({ id: 'L1', name: 'Honda Vezel Loan', bank: 'HNB', accountNo: '0741234567', start: '2026-01-05', duration: 12, monthly: 45230.5, rate: 12, payments: [], ...extra });

function world({ loans = [loan()], expenses = [] } = {}) {
    const owner = { uid: 'u', email: 'owner@example.com' }, mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@hnb.lk', kind: 'address', status: 'approved', name: 'HNB', domain: 'hnb.lk' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses, incomeRecv: [], cconetime: [], ccPayments: [], loans },
        [sourcePath]: { uid: 'u', bank: 'HNB', filename: 'statement.pdf', from: 'statements@hnb.lk', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-04-02T05:00:00Z') },
    });
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = async () => ({ bytes: textPdf(STATEMENT.trim().split('\n')), filename: 'statement.pdf', contentSha256: 'x' });
    const open = async () => [{ password: 'fixture-password', bank: 'HNB' }];
    const board = async () => { throw new Error('ai-consensus-unavailable'); };
    const run = () => runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open, settle: settleStatement, board, loadAttachment });
    return { db, data, run, sourcePath, mailPath };
}
const monthTotal = (user, ym) => {
    const linked = new Set((user.expenses || []).filter(e => e.loanLink && e.month === e.loanLink.month).map(e => `${e.loanLink.loanId}|${e.loanLink.month}`));
    return (user.loans || []).reduce((s, l) => s + (l.start <= `${ym}-31` && !linked.has(`${l.id}|${ym}`) ? l.monthly : 0), 0) + (user.expenses || []).filter(e => e.month === ym).reduce((s, e) => s + e.amount, 0);
};

describe('a statement debit that is the loan installment is linked as it is filed', () => {
    it('links the installment to the loan\'s month, files the other debits as before, and the month counts the installment once', async () => {
        const w = world(); await w.run();
        expect(w.data.get(w.sourcePath)).toMatchObject({ status: 'filed', hasReview: false });
        const user = w.data.get('users/u');
        const installment = user.expenses.find(e => /LOAN INSTALMENT/.test(e.desc)), fee = user.expenses.find(e => /PROCESSING FEE/.test(e.desc)), shop = user.expenses.find(e => /KEELLS/.test(e.desc));
        expect(installment).toMatchObject({ loanLink: { loanId: 'L1', month: '2026-03' }, cat: 'Loan Repayment', amount: 45230.5 });
        expect(fee.loanLink).toBeUndefined();                      // a fee is never the installment
        expect(shop.loanLink).toBeUndefined();
        expect(user.loans[0].payments).toEqual([expect.objectContaining({ month: '2026-03', paid: true, via: 'bank', source: 'statement', expenseId: installment.id, amount: 45230.5 })]);
        // March: the loan's 45,230.50 is counted by the debit alone; plus the shop and the fee
        expect(monthTotal(user, '2026-03')).toBeCloseTo(45230.5 + 4000 + 2500, 2);
    });
    it('the owner said this installment was paid in cash: the bank debit is not tied to it', async () => {
        const w = world({ loans: [loan({ accountNo: '', payments: [{ month: '2026-03', paid: true, amount: 45230.5, via: 'other' }] })] }); await w.run();
        const user = w.data.get('users/u');
        expect(user.expenses.find(e => /LOAN INSTALMENT/.test(e.desc)).loanLink).toBeUndefined();
        expect(user.loans[0].payments).toEqual([expect.objectContaining({ via: 'other' })]);
    });
    it('no loan on the books: an ordinary expense, as before', async () => {
        const w = world({ loans: [] }); await w.run();
        expect(w.data.get('users/u').expenses.every(e => !e.loanLink)).toBe(true);
        expect(w.data.get('users/u').expenses).toHaveLength(3);
    });
});

describe('the debits already in the books are linked once', () => {
    const old = (extra = {}) => ({ id: 'E1', desc: 'LOAN INSTALMENT 0741234567', amount: 45230.5, date: '2026-03-05', month: '2026-03', source: 'statement', direction: 'debit', ...extra });
    it('links an installment imported before the link existed, says so in one log line, and does it only once', async () => {
        const w = world({ expenses: [old(), old({ id: 'E2', desc: 'KEELLS SUPER', amount: 4000 })] });
        const lines = [];
        const first = await healLoanInstallments({ db: w.db, uid: 'u', log: line => lines.push(line) });
        expect(first.linked).toBe(1);
        expect(JSON.parse(lines[0])).toMatchObject({ evt: 'loan-link-heal', linked: 1, why: { 'account-number': 1 } });
        expect(lines[0]).not.toMatch(/0741234567|LOAN INSTALMENT/);
        const user = w.data.get('users/u');
        expect(user.expenses.find(e => e.id === 'E1')).toMatchObject({ loanLink: { loanId: 'L1', month: '2026-03' }, cat: 'Loan Repayment' });
        expect(user.expenses.find(e => e.id === 'E2').loanLink).toBeUndefined();
        expect(monthTotal(user, '2026-03')).toBeCloseTo(45230.5 + 4000, 2);
        expect((await healLoanInstallments({ db: w.db, uid: 'u', log: () => {} })).linked).toBe(0);
    });
    it('an idle run does it on its own, at most once every half hour', async () => {
        const w = world({ expenses: [old({ id: 'FEB', date: '2026-02-05', month: '2026-02' })] });      // February's: not on the March statement the run also files
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
        try { await w.run(); } finally { spy.mockRestore(); }
        expect(w.data.get('users/u').expenses.find(e => e.id === 'FEB')).toMatchObject({ loanLink: { loanId: 'L1', month: '2026-02' } });
        expect(w.data.get(w.mailPath).lastLoanHealMs).toBeGreaterThan(0);
    });
});
