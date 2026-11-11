/* =============================================================================
 * wf-statement-self-audit.mjs — the reader asks itself "what here did my rules not understand?"
 * -----------------------------------------------------------------------------
 * The reader files rows by rules it knows. A row that LOOKS like something the rules cover but is not read by them is the silent failure: "SINGER 24M ... INST 1 - REM BAL - ... <1/24>" was a
 * one-time purchase for days, because the words said INST and nobody told the reader that was a plan. This looks for such near-misses by itself, on every statement, from evidence in the
 * statement alone, and returns COUNTS (the repository is public: wf-statement-self-report.mjs files one issue per kind, with no statement text).
 *
 *   plan-like-line-unread    a row carries a plan's own marks ("REM BAL", or "<n/m>") that installmentInfo does not accept as a plan line (so it is filed as a plain purchase);
 *   plan-table-unmatched     the statement lists instalment plans (its plan table) yet not one charge line was read as a plan line or matched to a table row.
 *   category-gap             most of the spending rows fell into the catch-all "Other" category: the rules and the merchant list know almost nothing of this statement's merchants (a new bank's wording, a language, a scrambled text layer);
 *   credit-wording-on-debit  a debit row says refund, reversal, cashback, salary, payroll or dividend: money that comes IN is being filed as money going OUT (a direction read the wrong way, or a credit marker the reader missed).
 *
 * Pure: no network, no clock, no storage. Imports only the shared router and plan table (root modules: a Vercel function may import this file).
 * ===========================================================================*/
import { installmentInfo, expenseCategoryFor, isCardFeeWording } from './wealthflow-statement-router.js';
import { planFor } from './statement-plan-table.mjs';

const REM_BAL = /\brem(?:aining)?\.?\s*bal/i;
const MONTH_MARK = /<\s*\d{1,2}\s*\/\s*\d{1,2}\s*>/;
const words = (row) => String((row && (row.description != null && row.description !== '' ? row.description : row.narration)) || '');
const CREDIT_WORDS = /\b(refund(?:ed)?|reversal|reversed|cash\s*back|cashback|salary|payroll|dividend)\b/i;
const PAYMENT_WORDS = /\b(payment|thank\s*you|transfer|fund\s*transfer|atm|withdrawal)\b/i;
const GAP_MIN_ROWS = 8, GAP_SHARE = 0.5;   // fewer rows say nothing; at least half the spending in "Other" is a gap, not a few odd merchants
const isDebit = (row) => /^d/i.test(String((row && (row.direction || row.drcr)) || 'd'));

export function statementSelfAudit({ rows = [], planTable = [] } = {}) {
    const found = [];
    let unread = 0, readAsPlan = 0, matchedToTable = 0, spending = 0, generic = 0, creditWords = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !isDebit(row)) continue;
        const text = words(row), info = installmentInfo(text);
        if (info.isInstallment) { readAsPlan++; continue; }
        if (CREDIT_WORDS.test(text)) creditWords++;
        else if (text.trim().length >= 3 && !PAYMENT_WORDS.test(text) && !isCardFeeWording(text)) { spending++; if (expenseCategoryFor(row) === 'Other') generic++; }
        if (REM_BAL.test(text) || MONTH_MARK.test(text)) unread++;
        else if (Array.isArray(planTable) && planTable.length && planFor(planTable, Number(row.amount), 0)) matchedToTable++;
    }
    if (unread > 0) found.push({ kind: 'plan-like-line-unread', count: unread });
    if (Array.isArray(planTable) && planTable.length > 0 && readAsPlan === 0 && matchedToTable === 0 && unread === 0) found.push({ kind: 'plan-table-unmatched', count: planTable.length });
    if (spending >= GAP_MIN_ROWS && generic / spending >= GAP_SHARE) found.push({ kind: 'category-gap', count: generic });
    if (creditWords > 0) found.push({ kind: 'credit-wording-on-debit', count: creditWords });
    return found;
}

export default { statementSelfAudit };
