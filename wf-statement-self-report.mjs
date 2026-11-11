/* =============================================================================
 * wf-statement-self-report.mjs — the statement reader tells the fix agent when it does not trust its own reading
 * -----------------------------------------------------------------------------
 * WHY. #529: a card statement was misread for days (the bank prints "CR" BEFORE the amount) and nothing noticed until the owner asked why nine
 * items waited. The reader now checks itself against the statement's own printed "Total Payment" (printedPaymentsCheck). When that check still
 * disagrees after the model's second opinion, this module files ONE issue, so the autonomous fix agent starts the same minute instead of the owner
 * having to notice.
 *
 * THE REPOSITORY IS PUBLIC. The issue holds fixed words and COUNTS only: the reading's shape (readShape: how directions were read, whether balances
 * reconciled, how many rows are not whole transactions) and the institution's name. Never an amount, a date, a card number, a merchant or a line
 * of the statement. The test pins that no digit run of four or more survives into the issue text.
 *
 * ONE ISSUE PER KIND, NOT PER STATEMENT. A label carries the kind; an open issue with that label means "already known" and nothing is filed. A
 * closed one does not block (a fix that did not hold files again). Never fatal: every failure is swallowed into a reason string, because a report
 * must never stop a sync. This file is imported by a serverless function, so it must not import anything under autonomy/ (.vercelignore).
 * ============================================================================= */
import { resolveRepo, resolveToken, isValidRepo } from './github-repo.js';
import { fetchWithTimeout } from './fetch-timeout.mjs';

export const SELF_REPORT_LABEL = 'statement-reading';
const KINDS = {
    'printed-total-differs': {
        title: 'Statement reader: a card statement\'s payments do not add up to its printed Total Payment',
        why: 'The credit lines with payment words, as read, do not sum to the "Total Payment" the statement itself prints, and the model\'s second reading did not reach it either. The layout convention was closed for that statement, so its lines wait for review.',
        todo: 'Find what the reader misses on this kind of statement (a marker before or after the amount, a foreign-currency column, an instalment or conversion line, a total that counts something else) and make the rules read it. Add a test with an INVENTED statement; never copy real numbers, names or merchants into this public repository.',
    },
    'plan-like-line-unread': {
        title: 'Statement reader: a card line carries an instalment plan\'s marks but was not read as a plan',
        why: 'One or more card debits carry the marks of a plan line ("REM BAL" or a "<n/m>" month) that the instalment reader does not accept, so they were filed as plain purchases and CC Installments misses the plan. The reader noticed this by itself.',
        todo: 'Find the wording or arrangement (a different bank\'s plan line, an instalment number that does not match the month, a REM BAL in another place) and teach installmentInfo and the plan table to read it, on both the email worker and the manual upload. Add a test with an INVENTED statement; never copy real numbers, names or lines into the repository.',
    },
    'plan-table-unmatched': {
        title: 'Statement reader: a statement lists instalment plans but no charge was read as one of them',
        why: 'The statement\'s own plan table lists instalment plans, yet no charge line was read as a plan line or matched to a table row, so the plans may be missing from CC Installments or their charges filed as purchases. This may be benign (the month\'s charge was not due yet); it is reported once so it can be checked.',
        todo: 'Compare how the statement prints the plan\'s monthly charge with what installmentInfo, planFor and the plan table expect (a different instalment amount, a charge without plan words, a table in another layout) and make the rules read it. Add a test with an INVENTED statement; never copy real numbers, names or lines into the repository.',
    },
};

const clean = value => String(value == null ? '' : value).replace(/[^A-Za-z _-]/g, '').replace(/ {2,}/g, ' ').trim().slice(0, 40);
/* digits survive only as counts of at most three figures: no amount, date or card number can ride along */
const safeNumber = value => (Number.isFinite(Number(value)) && Math.abs(Number(value)) < 1000 ? Number(value) : 0);

/* the counts of readShape, as a fixed-shape object (unknown keys dropped, values bounded) */
export function safeShape(shape) {
    const s = shape && typeof shape === 'object' ? shape : {}, sources = {};
    for (const [key, count] of Object.entries(s.sources || {}).slice(0, 8)) sources[clean(key)] = safeNumber(count);
    const invalid = s.invalid || {};
    return { sources, balanceColumn: !!s.balanceColumn, type: clean(s.type), opening: !!s.opening, closing: !!s.closing, reconciled: clean(s.reconciled), printed: clean(s.printed), summary: clean(s.summary),
        invalid: { noDate: safeNumber(invalid.noDate), noAmount: safeNumber(invalid.noAmount), noWords: safeNumber(invalid.noWords) } };
}

export function reportBody(kind, { bank = '', shape = {}, rows = 0, secondOpinion = '' } = {}) {
    const k = KINDS[kind];
    if (!k) return null;
    const s = safeShape(shape);
    return [
        '## Statement reader: self-report',
        '',
        '**Kind:** `' + kind + '`  ·  **Institution:** ' + (clean(bank) || 'unknown') + '  ·  **Rows read:** ' + safeNumber(rows)
            + (secondOpinion ? '  ·  **Model second opinion:** ' + clean(secondOpinion) : ''),
        '',
        '**Priority: CRITICAL.** The owner\'s books depend on this reading, and this was found by the reader itself, with nobody asking.',
        '',
        '### What happened',
        k.why,
        '',
        '### Shape of the reading (counts only)',
        '- directions read by: ' + (Object.entries(s.sources).map(([key, n]) => key + ' ' + n).join(', ') || 'none'),
        '- balance column: ' + (s.balanceColumn ? 'yes' : 'no') + '  ·  statement type: ' + (s.type || 'unknown'),
        '- printed opening found: ' + (s.opening ? 'yes' : 'no') + '  ·  printed closing found: ' + (s.closing ? 'yes' : 'no') + '  ·  reconciled: ' + (s.reconciled || 'unknown'),
        '- printed Total Payment check: ' + (s.printed || 'unknown') + '  ·  summary strip check: ' + (s.summary || 'unknown'),
        '- rows that are not whole transactions: no date ' + s.invalid.noDate + ', no amount ' + s.invalid.noAmount + ', no words ' + s.invalid.noWords,
        '',
        '### What to do',
        k.todo,
        '',
        '_Filed automatically by the statement reader. It contains counts and fixed words only; there is no statement text here on purpose (public repository)._',
    ].join('\n');
}

/**
 * @returns {Promise<{filed: boolean, reason: string, issue?: number}>} never throws
 */
export async function reportSuspectReading(kind, details = {}, { env, fetchImpl } = {}) {
    try {
        const k = KINDS[kind];
        if (!k) return { filed: false, reason: 'unknown-kind' };
        const repo = resolveRepo(env), { token } = resolveToken(env);
        if (!repo || !isValidRepo(repo) || !token) return { filed: false, reason: 'not-configured' };
        const call = fetchImpl || ((url, init) => fetchWithTimeout(url, init));
        const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'wealthflow-statement-reader' };
        const kindLabel = 'wf-' + kind;
        const found = await call('https://api.github.com/repos/' + repo + '/issues?state=open&per_page=5&labels=' + encodeURIComponent(SELF_REPORT_LABEL + ',' + kindLabel), { headers });
        if (found && found.ok) {
            const open = await found.json();
            if (Array.isArray(open) && open.length) return { filed: false, reason: 'already-open', issue: open[0].number };
        } else return { filed: false, reason: 'lookup-failed' };
        const created = await call('https://api.github.com/repos/' + repo + '/issues', {
            method: 'POST', headers,
            body: JSON.stringify({ title: k.title, body: reportBody(kind, details), labels: ['bug', 'autonomous', 'critical', SELF_REPORT_LABEL, kindLabel] }),
        });
        if (!created || !created.ok) return { filed: false, reason: 'create-failed' };
        const issue = await created.json();
        return { filed: true, reason: 'filed', issue: issue && issue.number };
    } catch (_) { return { filed: false, reason: 'error' }; }
}

export default { reportSuspectReading, reportBody, safeShape, SELF_REPORT_LABEL };
