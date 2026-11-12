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
    'category-gap': {
        title: 'Statement reader: most of a statement\'s spending fell into the catch-all category',
        why: 'At least half of the spending rows of one statement (eight or more rows) were filed under "Other": neither the category rules nor the merchant list recognise most of this statement\'s merchants. The reader noticed this by itself. It may be a new bank\'s wording, a language the rules do not cover, or text garbled by the PDF.',
        todo: 'Find the pattern in how this kind of statement words its merchants (a prefix or gateway code, another language, a transliteration, a garbled text layer) and teach the category rules and the merchant list to read it, on both the email worker and the manual upload. Add a test with INVENTED merchant names; never copy real names or lines into this public repository.',
    },
    'credit-wording-on-debit': {
        title: 'Statement reader: a debit row carries credit wording (refund, reversal, cashback, salary)',
        why: 'One or more rows read as money going out say refund, reversal, cashback, salary, payroll or dividend. Money that comes in may be filed as spending: a direction read the wrong way, or a credit marker the reader missed. It can also be benign (salary paid out to staff); it is reported once so it can be checked.',
        todo: 'Look at how this kind of statement marks credits (a CR before or after the amount, a separate column, a minus sign, a reversal wording) and make the direction rules read it, on both the email worker and the manual upload. Add a test with an INVENTED statement; never copy real numbers, names or lines into this public repository.',
    },
    'garbled-text': {
        title: 'Statement reader: a statement\'s descriptions look scrambled (damaged text layer or poor OCR)',
        why: 'Nearly a third of the rows of one statement (six or more rows) have descriptions that look scrambled: replacement characters, digits inside words, or mostly symbols. The text layer of the PDF may be damaged (a font the reader could not map) or an OCR pass was poor, so merchants, categories and directions read from those lines are guesses. The reader noticed this by itself.',
        todo: 'Find what damaged the text (a custom font encoding, a two-column page read in the wrong order, a scanned page) and recover it: try the second text extractor, the page image through the vision readers, or a repair of the glyph map. Keep the rows in review rather than filed while the text is damaged. Add a test with an INVENTED scrambled line; never copy a real statement into the repository.',
    },
    'direction-guessed': {
        title: 'Statement reader: some rows of a statement have money-in or money-out that was guessed, not proven',
        why: 'On one statement most rows had their direction proven (a running balance or a marker) but a fifth or more (three rows at least) were only assumed. The rows without a balance or a Dr/Cr marker may be on the wrong side, which moves their money between income and spending. The reader noticed this by itself and it may be benign (a statement that prints a balance only on some lines).',
        todo: 'Find why these rows carry no balance or marker (a wrapped line, a page break, a second column, a foreign-currency line) and make the reader pair each amount with its Dr/Cr marker or balance, on both the email worker and the manual upload. Add a test with an INVENTED statement.',
    },
    'card-interest-unexplained': {
        title: 'Statement reader: a card statement charges interest that no plan explains',
        why: 'One or more debits on a card statement are worded interest or finance charge but are not part of an instalment plan. Interest on a card means the balance was not paid in full, or a plan costs more than its table says. The reader noticed this by itself; it may be a normal charge.',
        todo: 'Compare the interest line with the previous statement (was the whole balance paid by the due date?) and with the plan table. If it is genuine, file it as a card fee or interest so the monthly cost of the card is true; if it belongs to a plan, make the plan reader attach it. Add a test with an INVENTED statement.',
    },
    'card-credit-unrecognised': {
        title: 'Statement reader: a card credit has no payment, refund, waiver or cashback wording',
        why: 'One or more credits on a card statement carry none of the words of a payment, a refund, a reversal, a waiver or a cashback. The router files every card credit as a payment, so an unrecognised kind of credit (a reward, an offer, a statement adjustment) may be lowering what the card owes without being a payment. The reader noticed this by itself.',
        todo: 'Find the wording of this kind of credit and decide what it is: a payment (keep it), a reward or offer like a cashback (skip it, as isCardCashback does), a refund or waiver (net it against the charge). Teach the router, the email worker and the manual upload the same rule, and add a test with an INVENTED statement line; never copy a real one.',
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
