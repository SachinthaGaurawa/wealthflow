/* =============================================================================
 * wealthflow-card-plans.js — what a card statement says about an INSTALMENT PLAN, for both doors
 * -----------------------------------------------------------------------------
 * ONE place for the plan rules the e-mail worker (statement-ledger.mjs, statement-sync.js) and the page's manual upload (index.html) both use, so a plan is read, shaped and merged the same way
 * wherever the statement came from: the statement's plan table (readPlanTable, planFor, planEconomics), the plan a line starts (planFromLine, cardPlanRecord), and the plan an existing record
 * continues (matchInstallmentPlan, applyPlanPayment). Pure: no storage, no clock, no network. Loaded by the page as a module (window.WFCardPlans) and imported by the worker.
 * (Moved here from statement-links.mjs and statement-plan-table.mjs, which re-export it; no rule changed.)
 * ===========================================================================*/
import { sameBank, canonicalBank } from './wealthflow-institutions.js';
import { installmentInfo } from './wealthflow-statement-router.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arr = (v) => (Array.isArray(v) ? v : []);
const low = (v) => String(v == null ? '' : v).toLowerCase();
const words = (v) => low(v).replace(/[^a-z0-9]+/g, ' ').trim();
const ymOf = (iso) => { const m = /^(\d{4})-(\d{2})/.exec(String(iso || '')); return m ? `${m[1]}-${m[2]}` : ''; };
const STOP = new Set(['payment', 'transfer', 'credit', 'debit', 'online', 'bank', 'card', 'pos', 'transaction', 'purchase', 'salary', 'monthly', 'ceft', 'cefts', 'slips', 'inward', 'outward']);
const tokens = (v) => words(v).split(' ').filter((t) => t.length >= 4 && !STOP.has(t));

/* ── 5. A CARD INSTALLMENT CHARGE FOR A PLAN THE OWNER ALREADY HAS ────────────────────────────────────────────────────────────────────────── */
export const addMonths = (iso, n) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); if (!m) return NaN; return Date.UTC(+m[1], +m[2] - 1 + n, +m[3]); };
/** Is this installment plan counted by the monthly totals in `ym`? (the same rule getMonthlyData uses: it has started by the month's first day and not yet ended) */
export function planCountedIn(plan, ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (!plan || plan.completed || !m || !plan.date || !(num(plan.duration) > 0)) return false;
    const first = Date.UTC(+m[1], +m[2] - 1, 1), start = addMonths(plan.date, 0), end = addMonths(plan.date, Math.floor(num(plan.duration)));
    return Number.isFinite(start) && Number.isFinite(end) && start <= first && end > first;
}
export const monthIndex = (fromIso, ym) => { const a = /^(\d{4})-(\d{2})/.exec(String(fromIso || '')), b = /^(\d{4})-(\d{2})$/.exec(String(ym || '')); return a && b ? (+b[1] - +a[1]) * 12 + (+b[2] - +a[2]) : NaN; };
/** A plan whose line never said how long it is carries on: the month straight after the last one it has counted is its next month, not a new plan. */
export const continuesUnknown = (plan, ym) => !!plan && plan.durationUnknown === true && !plan.completed && num(plan.duration) >= 1 && monthIndex(plan.date, ym) === Math.floor(num(plan.duration));
/** The one plan whose product is named in the narration, whose monthly amount is this charge (to 2%), and which the totals count this month. */
export function matchInstallmentPlan(row, plans, options = {}) {
    const amount = num(row && row.amount), text = words(row && (row.description || row.narration)), ym = ymOf(row && row.date);
    if (!(amount > 0) || !text || !ym) return null;
    const hits = [], byMoney = [];
    for (const plan of arr(plans)) {
        if (!plan || !plan.id || !(planCountedIn(plan, ym) || continuesUnknown(plan, ym)) || !(num(plan.monthly) > 0)) continue;
        if (Math.abs(amount - num(plan.monthly)) > num(plan.monthly) * 0.02) continue;
        if (arr(plan.payments).some((p) => p && p.month === ym && p.paid && p.source === 'statement')) continue;     // that month already has its charge: this one is another
        const product = tokens(plan.product);
        if (product.length && product.some((t) => text.includes(t))) hits.push(plan);
        // the owner named the plan their own way ("Fridge"), the bank wrote the shop ("ABANS PLC"): a line the bank itself calls an installment, for this plan's money, on this plan's card bank
        else if (options.installment && (!options.bank || !plan.bank || sameBank(plan.bank, options.bank))) byMoney.push(plan);
    }
    /* two plans that fit equally are told apart by the length the line states ("3/12" is a twelve-month plan), when exactly one of them is that long */
    const longEnough = (list) => { const same = options.of >= 2 ? list.filter((p) => Math.floor(num(p.installmentOf)) === options.of || Math.floor(num(p.duration)) === options.of) : []; return same.length === 1 ? same[0] : null; };
    if (hits.length) return hits.length === 1 ? hits[0] : longEnough(hits);
    return byMoney.length === 1 ? byMoney[0] : byMoney.length > 1 ? longEnough(byMoney) : null;
}
export const round2 = (v) => Math.round(num(v) * 100) / 100;
export const firstOfMonth = (iso, back = 0) => { const m = /^(\d{4})-(\d{2})/.exec(String(iso || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1 - back, 1)).toISOString().slice(0, 10) : ''; };
/**
 * WHAT A CARD PLAN LINE SAYS OF ITS PLAN, and nothing it does not say. "INSTALMENT 2/12" is the second month of a twelve-month plan (one instalment is one month): the plan is twelve months long, it began one month
 * before this charge, and its total is twelve of these charges (an ESTIMATE: the bank prints the month, not the total). A line that gives no length is kept as a one-month plan and says so (`durationUnknown`),
 * instead of showing a length nobody printed. The plan's own `date` is the first day of its first month: the totals count a plan from that month.
 */
export function planFromLine({ amount, date, no = 0, length = 0 }) {
    const long = Math.floor(num(length)) >= 2, n = Math.floor(num(no));
    if (!long) return { duration: 1, months: 1, date: firstOfMonth(date), total: round2(amount), paid: 0, remaining: 1, durationUnknown: true };
    const done = Math.max(1, Math.min(n || 1, length));
    return { duration: length, months: length, date: firstOfMonth(date, n >= 1 ? n - 1 : 0), total: round2(num(amount) * length), totalEstimated: true, paid: done, remaining: length - done };
}
/** The plan's payment for the month, from the statement: the plan counts it (its monthly amount), the statement row does not become a second record. `info` (the line's own reading: no, of) moves a statement-made plan's progress on. */
export function applyPlanPayment(plan, row, sourcePath, index, now, info = null) {
    const month = ymOf(row.date);
    plan.payments = arr(plan.payments).filter((p) => !(p && p.month === month));
    plan.payments.push({ month, paid: true, amount: num(row.amount), paidAt: Date.parse(`${row.date}T00:00:00Z`) || now, source: 'statement', statementKey: sourcePath, statementRow: index });
    if (plan.source === 'statement' || plan.statementKey) {
        const no = info ? Math.floor(num(info.no)) : 0;
        /* a plan that never said how long it is grows by the month the statement shows */
        if (plan.durationUnknown === true) { const index = monthIndex(plan.date, month); if (index >= num(plan.duration)) { plan.duration = index + 1; plan.months = plan.duration; plan.total = round2(num(plan.monthly) * plan.duration); } }
        /* the bank's own figure for what is still owed, from the latest statement that printed one (REM BAL on the line, or the plan table's outstanding) */
        const owed = info && Number.isFinite(Number(info.remaining)) && info.remaining !== null && info.remaining !== undefined ? Number(info.remaining) : (row.plan && Number.isFinite(row.plan.remainingAmount) ? row.plan.remainingAmount : null);
        if (owed != null && owed >= 0 && row.date >= String(plan.outstandingAt || '')) { plan.outstanding = round2(owed); plan.outstandingAt = row.date; }
        if (no >= 1) { plan.installmentNo = Math.max(Math.floor(num(plan.installmentNo)), no); if (!plan.installmentOf && num(info.of) >= 2) plan.installmentOf = Math.floor(num(info.of)); }
        const done = Math.max(Math.floor(num(plan.installmentNo)), arr(plan.payments).filter((p) => p && p.paid).length), length = Math.floor(num(plan.duration));
        plan.paid = length > 0 ? Math.min(done, length) : done; plan.remaining = Math.max(0, length - plan.paid);
        /* the note says the latest charge the statements showed */
        const seen = /^Card installment charge of (\d{4}-\d{2}-\d{2})/.exec(String(plan.notes || ''));
        if (seen && row.date > seen[1]) plan.notes = `Card installment charge of ${row.date}${no >= 1 && num(info.of) >= 2 ? ` (${no} of ${Math.floor(num(info.of))})` : ''}`;
    }
    plan._ut = now;
}

/* ── the plan table a statement prints ───────────────────────────────────────────── */
/* THE PLAN TABLE A CARD STATEMENT PRINTS. See the original note below. */
const MONEY = '\\d{1,3}(?:,\\d{3})*\\.\\d{2}', moneyNum = text => Number(String(text).replace(/,/g, ''));
const LINE = new RegExp(`^\\s*(\\d{5,})\\s*[/\\\\]\\s*(.+?)\\s+(\\d{1,2})\\s+(${MONEY})\\s+(\\d{1,2})\\s+(${MONEY})\\s*$`);

/* WHAT A PLAN COSTS, from three printed figures and nothing else: the original amount (`principal`), the instalment and the months. Instalment x months is what is paid back; when that is the original amount to the cent
 * (a cent of rounding a month) the plan is interest-free, which is a proof, not a guess. When it is more, the difference is the interest and the annual rate is the one that makes the instalments repay the original
 * amount (a level-payment loan, solved by bisection on the monthly rate: nominal APR = 12 x monthly rate). Less than the original, or a nonsense figure, is no plan: null. */
export function planEconomics({ principal, monthly, months }) {
    const P = Number(principal), m = Number(monthly), n = Math.floor(Number(months));
    if (!(P > 0) || !(m > 0) || !(n >= 2) || n > 120) return null;
    const payable = Math.round(m * n * 100) / 100, tol = n * 0.01 + 0.01;
    if (Math.abs(payable - P) <= tol) return { interestFree: true, interest: 0, rate: 0, payable };
    if (payable < P) return null;
    const pv = (r) => m * (1 - Math.pow(1 + r, -n)) / r;
    let lo = 1e-9, hi = 1;
    if (pv(hi) > P) return null;
    for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (pv(mid) > P) lo = mid; else hi = mid; }
    return { interestFree: false, interest: Math.round((payable - P) * 100) / 100, rate: Math.round(((lo + hi) / 2) * 12 * 10000) / 100, payable };
}

/* NATIONS TRUST BANK's "Your Installment Summary": merchant, original purchase amount, amount outstanding, REMAINING instalments as "23/24" (23 still to pay of 24) and the next instalment's amount.
 * "SINGER 24M NATIONS PAY  125,260.00  120,040.83  23/24  5,219.17". It is evidence only when its own figures agree: the instalment times the months is the original amount, and the
 * original amount less the instalments already paid is what is outstanding (to the cent, with a cent of rounding for each month). */
const NTB_LINE = new RegExp(`^\\s*([A-Za-z].*?)\\s+(${MONEY})\\s+(${MONEY})\\s+(\\d{1,2})\\s*/\\s*(\\d{1,2})\\s+(${MONEY})\\s*$`);
const NTB_BRAND = /\b\d{1,2}\s*m\b|\bnations\s*(?:easy\s*)?pay\b/gi;
function ntbPlan(line) {
    const m = NTB_LINE.exec(line);
    if (!m) return null;
    const total = moneyNum(m[2]), outstanding = moneyNum(m[3]), remainingMonths = Number(m[4]), months = Number(m[5]), monthly = moneyNum(m[6]);
    const name = m[1].replace(NTB_BRAND, ' ').replace(/[^A-Za-z0-9&' .-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '').trim();
    if (name.length < 2 || months < 2 || remainingMonths < 0 || remainingMonths > months || !(total > 0) || !(monthly > 0) || outstanding > total + 0.01) return null;
    const payable = monthly * months, owedByInstalments = Math.abs(monthly * remainingMonths - outstanding) <= remainingMonths * 0.01 + 0.02;
    const free = Math.abs(payable - total) <= months * 0.01 + 0.01;
    /* the instalment and the months tell the original amount (interest-free), or - when they add up to MORE and the bank's outstanding is exactly the instalments still to pay - an interest-bearing plan whose original is `total`: three printed figures agree, none is guessed */
    if (!free && !(payable > total && payable <= total * 1.6 && owedByInstalments)) return null;
    if (Math.abs(total - monthly * (months - remainingMonths) - outstanding) > (months - remainingMonths) * 0.01 + 0.02 && !owedByInstalments) return null;   // …and what is still owed
    const eco = planEconomics({ principal: total, monthly, months });
    return { ref: `ntb-${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${Math.round(total * 100)}`, name: name.slice(0, 60), months, total, remainingMonths, remainingAmount: outstanding, monthly, ...(eco ? { interest: eco.interest, rate: eco.rate } : {}) };
}

/** The plans a statement's text lists, each as { ref, name, months, total, remainingMonths, remainingAmount }; lines that do not add up are left out. */
export function readPlanTable(text) {
    const plans = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (line.length > 240) continue;      // a table row is short: a whole statement flattened into one line (a page that kept no line breaks) has no row to read, and its first words are not a plan's name
        const ntb = ntbPlan(line);
        if (ntb) { plans.push(ntb); continue; }
        const m = LINE.exec(line);
        if (!m) continue;
        const months = Number(m[3]), total = moneyNum(m[4]), remainingMonths = Number(m[5]), remainingAmount = moneyNum(m[6]);
        const name = m[2].replace(/\s*\([A-Za-z]{0,4}\)?\s*$/, '').replace(/\s+/g, ' ').trim();     // the table cuts a long name off with "(LAN"
        if (name.length < 2 || months < 2 || !(total > 0) || remainingMonths > months || remainingAmount > total + 0.01) continue;
        if (Math.abs(remainingAmount - total * remainingMonths / months) > total * 0.01) continue;      // the months and the money must tell the same story
        plans.push({ ref: m[1], name: name.slice(0, 60), months, total, remainingMonths, remainingAmount });
    }
    return plans;
}

/** The ONE table row a charge of `amount` belongs to (its monthly money, to the cent), or null: two rows with the same monthly money cannot be told apart, so neither is guessed. */
export function planFor(table, amount, of = 0) {
    const hits = (table || []).filter(plan => Math.abs((plan.monthly || plan.total / plan.months) - Number(amount)) <= 0.02 && (!(of >= 2) || plan.months === of));
    return hits.length === 1 ? hits[0] : null;
}

/* ── the record a card instalment line files as ────────────────────────────────────── */
/** The plan record a card statement's instalment line files (CC Installments), the same shape whichever door read the statement. `row` is the statement line (amount, date, and `plan`: the statement's plan table row
 *  for it, when it printed one); `base` carries the provenance the door stamps on its records (id, statementKey, bank, card_last4 ...); `context` has `bank`, `sourcePath`, `index`; `decision.category` is the label. */
export function cardPlanRecord({ row, desc, decision, context, base, now }) {
        // "INSTALLMENT 03/12 ABANS" is the 3rd of 12 of the Abans plan: the plan is named after the merchant, and the note says which month this charge is
        const plan = installmentInfo(desc), table = row.plan && row.plan.name ? row.plan : null;
        const ofText = plan.no && plan.of ? ` (${plan.no} of ${plan.of})` : '';
        /* the statement's own plan table (statement-plan-table.mjs) names the plan and prints its real total: "Instalment Principle - 3/12" is one of its rows, not a plan called "Principle" */
        const shape = { ...planFromLine({ amount: row.amount, date: row.date, no: plan.no || (table ? table.months - table.remainingMonths : 0), length: plan.length || (table ? table.months : 0) }),
            ...(table ? { total: table.total, totalEstimated: false, planRef: table.ref } : {}) };
        /* WHAT THE STATEMENT PROVES ABOUT THE PLAN'S MONEY, and no more. The plan table's original amount with its instalment and months says the rate (0% is a proof when they tally; an APR when the instalments repay more).
         * Without a table, the line's own REM BAL after instalment n of m gives the total paid back (REM BAL + n instalments) - exact when it equals m instalments, but not the rate: the original amount is not printed there. */
        const eco = table && table.monthly ? planEconomics({ principal: table.total, monthly: table.monthly, months: table.months }) : null;
        const owed = table && Number.isFinite(table.remainingAmount) ? table.remainingAmount : (Number.isFinite(plan.remaining) ? plan.remaining : null);
        if (eco) Object.assign(shape, { rate: eco.rate, rateUnknown: false, ...(eco.interest > 0 ? { interest: eco.interest } : {}) });
        else if (!table && Number.isFinite(plan.remaining) && plan.no && plan.of >= 2) {
            const payable = Math.round((plan.remaining + row.amount * plan.no) * 100) / 100;
            if (Math.abs(payable - row.amount * plan.of) <= plan.of * 0.01 + 0.01) Object.assign(shape, { total: payable, totalEstimated: false });
        }
        return { ...base, desc, product: (table ? table.name : plan.name || desc).slice(0, 60), bank: canonicalBank(context.bank || ''), buyer: 'Self', rate: 0, rateUnknown: true, ...shape, ...(owed != null ? { outstanding: owed, outstandingAt: row.date } : {}), completed: false, skipped: [], notes: `Card installment charge of ${row.date}${ofText}`,
            monthly: row.amount, startDate: row.date, category: decision.category, payments: [{ month: row.date.slice(0, 7), paid: true, amount: row.amount, paidAt: Date.parse(`${row.date}T00:00:00Z`) || now, source: 'statement', statementKey: context.sourcePath, statementRow: context.index }],
            ...(plan.no && plan.of ? { installmentNo: plan.no, installmentOf: plan.of } : {}) };
}

const API = { readPlanTable, planFor, planEconomics, planFromLine, cardPlanRecord, matchInstallmentPlan, applyPlanPayment, planCountedIn };
if (typeof window !== 'undefined') window.WFCardPlans = API;
export default API;
