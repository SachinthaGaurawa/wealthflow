/* =============================================================================
 * tenant-tools.js — what a person can do WITH their statement, worked out on their own device
 * -----------------------------------------------------------------------------
 * Everything here is a pure function of the statement the server already sent (tenant-statement.mjs): it asks
 * the server for nothing, writes nothing, and cannot show anything the statement page does not already show.
 *
 *   upcoming(statement)           what is coming next: a loan's due date, the next interest, soonest first
 *   dayLabel(days, kind, t)       "Due today", "In 5 days", "3 days overdue"
 *   loanProgress(g)               how much of a loan has been paid back, 0-100
 *   termProgress(g, asOf)         how far through its term an investment is, 0-100 (or null when it has no end)
 *   calendarFile(item, ...)       an .ics reminder for one of those dates
 *   payoffPlan(loan, asOf, opts)  "if I pay X every week / fortnight / month, when am I done?", and what clears a loan by its due date
 *   planFile(plan, ...)           an .ics series with one reminder for every payment of such a plan
 *   balanceTrail(loan)            the balance after each movement of a loan, for the little chart
 *   csvFile(statement)            every movement and payment as a spreadsheet file
 *
 * Dates are Sri Lanka calendar days: the statement's own `asOf` instant is read in Sri Lanka time, so "today"
 * means the same here as on the server and in the lender's texts.
 *
 * Plain ES module, no DOM.
 * ===========================================================================*/

const DAY = 86400000;
const SL_OFFSET_MS = 330 * 60000;

const dayNo = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY : NaN;
};
const isoOfDayNo = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Today in Sri Lanka, as a day number, taken from the statement's own clock. */
export function todayNo(asOf) {
    const ms = Date.parse(String(asOf || ''));
    return Number.isFinite(ms) ? Math.floor((ms + SL_OFFSET_MS) / DAY) : NaN;
}

/**
 * What is coming up, soonest (or most overdue) first, at most `max` items.
 * kind 'loan': an open loan with a due date and money still owed. kind 'interest': an investment's next interest.
 * `days` is the whole days from today to the date (negative: that many days ago); `tone` is 'late', 'soon' (within a week) or 'ok'.
 */
export function upcoming(statement, max = 4) {
    const st = statement && typeof statement === 'object' ? statement : {};
    const today = todayNo(st.asOf);
    if (!Number.isFinite(today)) return [];
    const items = [];
    for (const g of Array.isArray(st.groups) ? st.groups : []) {
        if (!g || typeof g !== 'object') continue;
        if (g.kind === 'loan' && g.status === 'open' && num(g.outstanding) > 0) {
            const d = dayNo(g.due);
            if (!Number.isFinite(d)) continue;
            const days = d - today;
            items.push({ kind: 'loan', ref: String(g.ref || ''), currency: g.currency, date: isoOfDayNo(d), amount: num(g.outstanding), days, tone: days < 0 ? 'late' : days <= 7 ? 'soon' : 'ok' });
        } else if (g.kind === 'investment' && g.nextInterest && typeof g.nextInterest === 'object') {
            const d = dayNo(g.nextInterest.date);
            if (!Number.isFinite(d)) continue;
            // money coming TO the person is never "late" from their side: a date that has just passed reads "today"
            const days = Math.max(0, d - today);
            items.push({ kind: 'interest', ref: String(g.ref || ''), currency: g.currency, date: isoOfDayNo(d), amount: num(g.nextInterest.amount), days, tone: days <= 7 ? 'soon' : 'ok' });
        }
    }
    items.sort((a, b) => a.days - b.days || a.ref.localeCompare(b.ref));
    return items.slice(0, Math.max(0, max));
}

/** The words for a number of days. `t` is the page's translator. */
export function dayLabel(days, t) {
    const d = Math.trunc(num(days));
    if (d === 0) return t('Due today');
    if (d === 1) return t('Due tomorrow');
    if (d > 1) return t('In {n} days', { n: d });
    if (d === -1) return t('1 day overdue');
    return t('{n} days overdue', { n: -d });
}

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));

/** Share of the money paid out that has come back; null when nothing was paid out. */
export function loanProgress(g) {
    const lent = num(g && g.lent);
    return lent > 0 ? clampPct((num(g.repaid) / lent) * 100) : null;
}

/** How far through its term an investment is, by calendar days; null with no start or end. */
export function termProgress(g, asOf) {
    const a = dayNo(g && g.start);
    const b = dayNo(g && g.end);
    const now = todayNo(asOf);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(now) || b <= a) return null;
    return clampPct(((now - a) / (b - a)) * 100);
}

/* ── a calendar reminder ─────────────────────────────────────────────────── */

/** iCalendar text escaping: backslash, semicolon, comma and line breaks. */
const icsText = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 bytes continue on the next line behind one space; cut between characters, never inside one. */
function fold(line) {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
        const b = new TextEncoder().encode(ch).length;
        if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
        cur += ch;
        bytes += b;
    }
    out.push(cur);
    return out.join('\r\n ');
}

const compact = (iso) => iso.replace(/-/g, '');

/**
 * An all-day event on the date, with an alert the day before.
 * @param {{kind:string, ref:string, currency:string, date:string, amount:number}} item one of upcoming()
 * @param {{t:Function, fmtMoney:Function, asOf:string}} env
 * @returns {string} the file's text (CRLF lines), or '' for an item without a usable date
 */
export function calendarFile(item, { t, fmtMoney, asOf }) {
    const d = dayNo(item && item.date);
    if (!Number.isFinite(d)) return '';
    const amount = fmtMoney(item.amount, item.currency);
    const title = item.kind === 'loan' ? t('Pay {amount} to your lender ({ref})', { amount, ref: item.ref }) : t('Interest of {amount} expected ({ref})', { amount, ref: item.ref });
    const note = t('Reminder from your WealthFlow statement. Quote the reference {ref} when you pay.', { ref: item.ref });
    const stampMs = Date.parse(String(asOf || ''));
    const stamp = new Date(Number.isFinite(stampMs) ? stampMs : 0).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WealthFlow//Statement//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${compact(item.date)}-${String(item.ref).replace(/[^A-Za-z0-9-]/g, '')}@wealthflow`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${compact(item.date)}`,
        `DTEND;VALUE=DATE:${compact(isoOfDayNo(d + 1))}`,
        `SUMMARY:${icsText(title)}`,
        `DESCRIPTION:${icsText(note)}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'TRIGGER:-P1D', 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR',
    ];
    return `${lines.map(fold).join('\r\n')}\r\n`;
}

/* ── a repayment plan ────────────────────────────────────────────────────── */

/** How often a person might pay: days between payments (a month is the same day each month, never past the 28th, so every month has it). */
export const PLAN_EVERY = Object.freeze({ weekly: 7, fortnightly: 14, monthly: 0 });
const MAX_PAYMENTS = 600;

const monthAdd = (dn, k) => { const d = new Date(dn * DAY); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, Math.min(d.getUTCDate(), 28)) / DAY; };
const stepNo = (start, every, k) => (every === 'monthly' ? monthAdd(start, k) : start + k * PLAN_EVERY[every]);
const cents = (v) => Math.round(num(v) * 100);

/**
 * What a plan of equal payments does to an open loan. The figures are only arithmetic on the balance the lender recorded (the
 * lender's books add no interest or charge to a loan, so none is added here): the first payment is one step after today, and
 * every payment is the same except the last, which is whatever is left.
 *
 * `opts.every` is 'weekly', 'fortnightly' or 'monthly' (monthly by default); `opts.amount` is the payment the person is trying.
 * Returns null when the loan is not open with something owed or the statement has no usable clock. Otherwise:
 *   { ref, currency, owed, every, byDue }  byDue is { count, amount } - the smallest equal payment that clears the loan by its
 *                                          due date - or null when there is no due date ahead
 *   plus, when the amount is usable: { amount, count, last, first, finish, onTime }
 *   (onTime: finishing on or before the due date, null without one), or { tooMany: true } when it would take over 600 payments,
 *   or { amount: 0 } while the amount is empty or not a number.
 */
export function payoffPlan(g, asOf, opts = {}) {
    if (!g || typeof g !== 'object' || g.kind !== 'loan' || g.status !== 'open') return null;
    const owedC = cents(g.outstanding);
    const today = todayNo(asOf);
    if (owedC <= 0 || !Number.isFinite(today)) return null;
    const every = Object.prototype.hasOwnProperty.call(PLAN_EVERY, opts && opts.every) ? opts.every : 'monthly';
    const owed = owedC / 100;
    const dueNo = dayNo(g.due);
    let fit = 0;
    if (Number.isFinite(dueNo) && dueNo > today) while (fit < MAX_PAYMENTS && stepNo(today, every, fit + 1) <= dueNo) fit += 1;
    // a whole rupee when the balance is large (an amount a person can type and remember), cents when it is small
    const byDue = fit > 0 ? { count: fit, amount: owedC >= 10000 ? Math.ceil(owedC / fit / 100) : Math.ceil(owedC / fit) / 100 } : null;
    const base = { ref: String(g.ref || ''), currency: g.currency, owed, every, byDue };
    const amountC = cents(opts && opts.amount);
    if (!(amountC > 0)) return { ...base, amount: 0 };
    const count = Math.ceil(owedC / amountC);
    if (count > MAX_PAYMENTS) return { ...base, amount: amountC / 100, tooMany: true };
    const first = stepNo(today, every, 1);
    const finish = stepNo(today, every, count);
    return {
        ...base,
        amount: Math.min(amountC, owedC) / 100,
        count,
        last: (owedC - amountC * (count - 1)) / 100,
        first: isoOfDayNo(first),
        finish: isoOfDayNo(finish),
        onTime: Number.isFinite(dueNo) ? finish <= dueNo : null,
    };
}

/**
 * The plan as a calendar file: one repeating all-day event from the first payment, with an alert the day before, as many times as the
 * plan has payments. '' when the plan has no payments to remind about.
 */
export function planFile(plan, { t, fmtMoney, asOf }) {
    if (!plan || !(plan.count > 0) || !(plan.amount > 0) || !Number.isFinite(dayNo(plan.first))) return '';
    const first = dayNo(plan.first);
    const rule = plan.every === 'monthly' ? 'FREQ=MONTHLY;INTERVAL=1' : `FREQ=WEEKLY;INTERVAL=${plan.every === 'fortnightly' ? 2 : 1}`;
    const title = t('Pay {amount} to your lender ({ref})', { amount: fmtMoney(plan.amount, plan.currency), ref: plan.ref });
    const note = t('Reminder from your WealthFlow statement. Quote the reference {ref} when you pay.', { ref: plan.ref });
    const stampMs = Date.parse(String(asOf || ''));
    const stamp = new Date(Number.isFinite(stampMs) ? stampMs : 0).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WealthFlow//Statement//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:plan-${compact(plan.first)}-${String(plan.ref).replace(/[^A-Za-z0-9-]/g, '')}@wealthflow`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${compact(plan.first)}`,
        `DTEND;VALUE=DATE:${compact(isoOfDayNo(first + 1))}`,
        `RRULE:${rule};COUNT=${plan.count}`,
        `SUMMARY:${icsText(title)}`,
        `DESCRIPTION:${icsText(note)}`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(title)}`, 'TRIGGER:-P1D', 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR',
    ];
    return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** The balance after each movement of a loan, oldest first, as plain numbers; [] when there is nothing to draw. */
export function balanceTrail(g) {
    const ev = g && Array.isArray(g.events) ? g.events : [];
    return ev.map((e) => num(e && e.balance)).filter((n) => Number.isFinite(n));
}

/* ── a spreadsheet ───────────────────────────────────────────────────────── */

/** A cell as CSV: quoted, and defanged if a spreadsheet would run it as a formula. */
export function csvCell(value) {
    let s = String(value == null ? '' : value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}

const KIND_WORD = { lent: 'Loan paid out', further: 'Further advance', repayment: 'Repayment' };
const fixed = (v) => num(v).toFixed(2);

/**
 * Every movement of every loan and every payment received on every investment, one row each, oldest first inside
 * a record, with the currency in its own column. The words are English and fixed: a file for keeping and
 * sorting, not for reading aloud. A byte-order mark makes Excel read it as UTF-8.
 */
export function csvFile(statement) {
    const st = statement && typeof statement === 'object' ? statement : {};
    const rows = [['Reference', 'Type', 'Date', 'Description', 'Amount', 'Balance', 'Currency']];
    for (const g of Array.isArray(st.groups) ? st.groups : []) {
        if (!g || typeof g !== 'object') continue;
        if (g.kind === 'loan') {
            for (const e of Array.isArray(g.events) ? g.events : []) rows.push([g.ref, 'Loan', String(e.date || '').slice(0, 10), KIND_WORD[e.kind] || '', fixed(e.amount), fixed(e.balance), g.currency]);
        } else if (g.kind === 'investment') {
            for (const p of Array.isArray(g.payments) ? g.payments : []) rows.push([g.ref, 'Investment', String(p.date || '').slice(0, 10), `Interest received for ${String(p.month || '')}`, fixed(p.amount), '', g.currency]);
        }
    }
    return `\uFEFF${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export default { todayNo, upcoming, dayLabel, loanProgress, termProgress, calendarFile, payoffPlan, planFile, balanceTrail, PLAN_EVERY, csvCell, csvFile };
