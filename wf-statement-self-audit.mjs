/* =============================================================================
 * wf-statement-self-audit.mjs — the reader asks itself "what here did my rules not understand?"
 * -----------------------------------------------------------------------------
 * The reader files rows by rules it knows. A row that LOOKS like something the rules cover but is not read by them is the silent failure: "SINGER 24M ... INST 1 - REM BAL - ... <1/24>" was a
 * one-time purchase for days, because the words said INST and nobody told the reader that was a plan. This looks for such near-misses by itself, on every statement, from evidence in the
 * statement alone, and returns COUNTS (the repository is public: wf-statement-self-report.mjs files one issue per kind, with no statement text).
 *
 *   plan-like-line-unread    a row carries a plan's own marks ("REM BAL", or "<n/m>") that installmentInfo does not accept as a plan line (so it is filed as a plain purchase);
 *   plan-table-unmatched     the statement lists instalment plans (its plan table) yet not one charge line was read as a plan line or matched to a table row.
 *
 * Pure: no network, no clock, no storage. Imports only the shared router and plan table (root modules: a Vercel function may import this file).
 * ===========================================================================*/
import { installmentInfo } from './wealthflow-statement-router.js';
import { planFor } from './statement-plan-table.mjs';

const REM_BAL = /\brem(?:aining)?\.?\s*bal/i;
const MONTH_MARK = /<\s*\d{1,2}\s*\/\s*\d{1,2}\s*>/;
const words = (row) => String((row && (row.description != null && row.description !== '' ? row.description : row.narration)) || '');
const isDebit = (row) => /^d/i.test(String((row && (row.direction || row.drcr)) || 'd'));

export function statementSelfAudit({ rows = [], planTable = [] } = {}) {
    const found = [];
    let unread = 0, readAsPlan = 0, matchedToTable = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !isDebit(row)) continue;
        const text = words(row), info = installmentInfo(text);
        if (info.isInstallment) { readAsPlan++; continue; }
        if (REM_BAL.test(text) || MONTH_MARK.test(text)) unread++;
        else if (Array.isArray(planTable) && planTable.length && planFor(planTable, Number(row.amount), 0)) matchedToTable++;
    }
    if (unread > 0) found.push({ kind: 'plan-like-line-unread', count: unread });
    if (Array.isArray(planTable) && planTable.length > 0 && readAsPlan === 0 && matchedToTable === 0 && unread === 0) found.push({ kind: 'plan-table-unmatched', count: planTable.length });
    return found;
}

export default { statementSelfAudit };
