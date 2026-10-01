/* =============================================================================
 * loan-link.mjs — one loan installment, one count
 * -----------------------------------------------------------------------------
 * THE OWNER'S COMPLAINT: a loan installment paid from their own bank account was counted twice in Monthly Overview, Year Expenses and the
 * rest — once as the bank statement's debit (an expense) and once as the loan's own scheduled installment. Paid some other way (cash, another
 * account) it must still be counted once, by the loan.
 *
 * THE RULE, in one place so that no screen can disagree with another:
 *
 *   • A bank debit that IS a loan installment carries `loanLink: { loanId, month }`. The loan's payment for that month says `via: 'bank'`
 *     and names the expense (`expenseId`).
 *   • While an expense is linked to (loan, month), the loan's SCHEDULED amount for that month is not added again — the debit is the cash
 *     that really left, and it counts once. Delete the expense and the loan counts again: nothing is ever dropped, because the skip is
 *     DERIVED from the expenses that exist, never stored as a flag that can outlive them.
 *   • A link is made only on evidence: the loan's account number or name in the narration, or loan wording with exactly one candidate; or the
 *     owner saying "paid from my bank account" for that installment. A fee, a premium or a penalty is never an installment. The owner saying
 *     "cash / elsewhere" for an installment keeps every bank debit away from it.
 *
 * Pure: no DOM, no storage, no clock. Used by the statement worker (server). The screens carry the small slice they need inline (index.html
 * `_wfLinkedLoanMonths`), and test/loan_link_client_test.js holds the two to the same answers.
 * ===========================================================================*/

export const VIA = Object.freeze({ BANK: 'bank', OTHER: 'other' });
export const LOAN_CATEGORY = 'Loan Repayment';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arr = (v) => (Array.isArray(v) ? v : []);
const low = (v) => String(v == null ? '' : v).toLowerCase();
const ymOf = (v) => { const m = /^(\d{4})-(\d{2})/.exec(String(v || '')); return m ? `${m[1]}-${m[2]}` : ''; };
const cents = (v) => Math.round(num(v) * 100);

/** The schedule's month keys ("YYYY-MM"), from the start month, one per instalment — the keys `payments[].month` uses. */
export function loanMonths(loan) {
    const start = /^(\d{4})-(\d{2})/.exec(String((loan && loan.start) || ''));
    const duration = Math.floor(num(loan && loan.duration));
    if (!start || duration <= 0 || duration > 600) return [];
    const out = [];
    let y = Number(start[1]), m = Number(start[2]) - 1;
    for (let i = 0; i < duration; i += 1) {
        out.push(`${y}-${String(m + 1).padStart(2, '0')}`);
        m += 1; if (m > 11) { m = 0; y += 1; }
    }
    return out;
}

/** What this loan's installment should be, for judging whether an amount "looks like" it. Reducing-balance loans fall as they are paid. */
export function expectedInstallment(loan) {
    return num(loan && loan.monthly);
}

const GENERIC = new Set(['loan', 'loans', 'lease', 'leasing', 'emi', 'facility', 'payment', 'payments', 'installment', 'instalment', 'installments', 'instalments',
    'repayment', 'mortgage', 'rental', 'rentals', 'hire', 'purchase', 'finance', 'financing', 'credit', 'monthly', 'annual', 'account', 'number', 'bank', 'plc', 'limited']);
const LOAN_WORDS = /\b(loan|emi|instal?ments?|instal?lments?|repayment|housing loan|home loan|personal loan|vehicle loan|leasing|lease rental|hire purchase|mortgage)\b/;
/* Never the installment: what a lender charges around it. */
const NOT_AN_INSTALLMENT = /\b(fees?|charges?|penalty|penalties|stamp|duty|tax|insurance|premium|processing|valuation|legal|commission|refund|reversal|disbursement|reversed)\b/;

const digitsOf = (text) => String(text || '').replace(/\D/g, '');
function refNumbers(loan) {
    const fields = [loan.ref, loan.refNo, loan.accountNo, loan.accountNumber, loan.acct, loan.account, loan.name];
    return fields.map((v) => String(v == null ? '' : v)).join(' ').match(/\d{5,}/g) || [];
}

/**
 * Which of the owner's loans, and which of its months, is this bank debit the installment of? `null` when the evidence does not say.
 * `debit` is `{ description, amount, date }`. `expenses` (optional) lets the owner's own "paid from the bank" word find its debit.
 */
export function matchLoanForDebit(debit, loans, { onlyOpenMonths = false } = {}) {
    const amount = num(debit && debit.amount), month = ymOf(debit && debit.date);
    if (!(amount > 0) || !month) return null;
    const text = low(debit.description).replace(/[*_/]+/g, ' ');
    if (!text.trim() || NOT_AN_INSTALLMENT.test(text)) return null;
    const digits = digitsOf(text);
    const wording = LOAN_WORDS.test(text);
    const candidates = [];
    for (const loan of arr(loans)) {
        if (!loan || !loan.id || !loanMonths(loan).includes(month)) continue;
        const pay = arr(loan.payments).find((p) => p && p.month === month) || null;
        // "Cash / elsewhere" is the owner's word that the bank was not used for this installment — only the loan's own number overrides it
        const refHit = refNumbers(loan).some((n) => text.includes(n) || (digits && digits.includes(n)));
        if (pay && pay.paid && pay.via === VIA.OTHER && !refHit) continue;
        if (onlyOpenMonths && pay && pay.paid && pay.expenseId) continue;
        const expected = expectedInstallment(loan);
        if (expected > 0 && amount < expected * 0.5) continue;          // a fraction of an installment is not the installment
        let score = 0;
        const bank = low(loan.bank).trim(), name = low(loan.name).trim();
        if (refHit) score += 5;
        let nameHit = false;
        if (name.length >= 4 && text.includes(name)) { score += 4; nameHit = true; }
        else if (name) for (const word of name.split(/\s+/)) if (word.length >= 4 && !GENERIC.has(word) && text.includes(word)) { score += 2; nameHit = true; }
        if (bank && text.includes(bank)) score += 3;
        else if (bank) { const token = bank.split(/\s+/)[0]; if (token.length >= 3 && text.includes(token)) score += 2; }
        if (wording) score += 1;
        // The owner said "paid from my bank account" for this month, for about this amount: the debit is found by what they said, whatever the narration
        const said = !!(pay && pay.paid && pay.via === VIA.BANK && !pay.expenseId && expected > 0 && Math.abs(amount - num(pay.amount || expected)) <= Math.max(1, num(pay.amount || expected)) * 0.02);
        if (said) score += 6;
        if (expected > 0) { const r = Math.abs(amount - expected) / expected; if (r < 0.02) score += 3; else if (r < 0.1) score += 1; }
        candidates.push({ loan, month, score, refHit, nameHit, said });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0], second = candidates[1];
    const strong = best.refHit || best.nameHit || best.said;
    // no loan wording and no identifier: a bare bank name or a matching amount is a coincidence, never a loan payment
    if (!wording && !strong) return null;
    if (second && second.score === best.score) return null;               // two loans fit equally: ambiguous, never guessed
    if (!strong && best.score < 2 && candidates.length > 1) return null;
    return { loan: best.loan, month, score: best.score, why: best.said ? 'owner-said-bank' : best.refHit ? 'account-number' : best.nameHit ? 'loan-name' : 'loan-wording' };
}

/** The expense's own month, the way the monthly totals place it. */
const expenseMonth = (e) => ymOf(e && (e.month || e.date));

/**
 * The (loan, month) pairs whose installment a bank debit already counts: `Set('loanId|YYYY-MM')`.
 * A link counts only while it still describes the expense (same month); a recurring expense linked to a loan stands for every month of
 * that loan from its own month on.
 */
export function linkedLoanMonths(expenses, loans) {
    const out = new Set();
    const byId = new Map(arr(loans).filter(Boolean).map((l) => [l.id, l]));
    for (const e of arr(expenses)) {
        const link = e && e.loanLink;
        if (!link || !link.loanId || !ymOf(link.month)) continue;
        if (e.recurring) {
            const loan = byId.get(link.loanId);
            for (const m of loan ? loanMonths(loan) : [link.month]) if (m >= expenseMonth(e)) out.add(`${link.loanId}|${m}`);
        } else if (expenseMonth(e) === ymOf(link.month)) out.add(`${link.loanId}|${ymOf(link.month)}`);
    }
    return out;
}

/** Make `record` (an expense) the installment of `loan` for `month`: the link, the category, and the loan's payment for that month. Mutates both. */
export function linkExpenseToLoan(user, record, loan, month, now = Date.now()) {
    record.loanLink = { loanId: loan.id, month };
    record.cat = LOAN_CATEGORY;
    loan.payments = arr(loan.payments);
    const linked = arr(user && user.expenses).concat([record]).filter((e, i, all) => e && e.loanLink && e.loanLink.loanId === loan.id && e.loanLink.month === month && all.indexOf(e) === i);
    const total = linked.reduce((s, e) => s + num(e.amount), 0);
    const paidAt = Date.parse(`${String(record.date || '').slice(0, 10)}T00:00:00Z`) || now;
    const had = loan.payments.findIndex((p) => p && p.month === month);
    const entry = { month, paid: true, amount: total, paidAt, via: VIA.BANK, source: 'statement', expenseId: record.id,
        notes: `Matched to the bank debit on ${String(record.date || '').slice(0, 10)}` };
    if (had > -1) {
        const old = loan.payments[had];
        loan.payments[had] = { ...old, ...entry, notes: old && old.notes && old.via !== VIA.BANK ? old.notes : entry.notes };
    } else loan.payments.push(entry);
    loan._ut = now;
    return entry;
}

/**
 * Link every expense that already IS an installment (older statement imports, a hand-typed "loan payment"). Idempotent: an expense that is
 * linked is left alone. Returns the list of what was linked; `user.expenses` and `user.loans` are updated in place.
 */
export function healLoanLinks(user, now = Date.now(), { limit = 200 } = {}) {
    const done = [];
    const loans = arr(user && user.loans);
    if (!loans.length) return done;
    for (const e of arr(user && user.expenses)) {
        if (done.length >= limit) break;
        if (!e || e.loanLink || e.recurring || !(num(e.amount) > 0)) continue;
        if (e.direction && e.direction !== 'debit') continue;
        const hit = matchLoanForDebit({ description: e.desc || e.name || '', amount: e.amount, date: e.date || (e.month ? `${e.month}-15` : '') }, loans);
        if (!hit) continue;
        // a month that already has a different debit linked is left to the first one unless the owner said which
        linkExpenseToLoan(user, e, hit.loan, hit.month, now);
        done.push({ expenseId: e.id, loanId: hit.loan.id, month: hit.month, why: hit.why });
    }
    return done;
}

/** For the screens: is this loan's installment for `ym` already counted by a bank debit? */
export function loanCountedByExpense(linked, loanId, ym) { return !!(linked && linked.has && linked.has(`${loanId}|${ym}`)); }

export default { VIA, LOAN_CATEGORY, loanMonths, expectedInstallment, matchLoanForDebit, linkedLoanMonths, linkExpenseToLoan, healLoanLinks, loanCountedByExpense };
