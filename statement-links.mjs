/* =============================================================================
 * statement-links.mjs — one payment, one count (everything but loans, which are loan-link.mjs)
 * -----------------------------------------------------------------------------
 * A bank statement row is the money that really moved. The owner's books may already hold the same payment under another name: typed in by
 * hand, tracked as a subscription, written as an issued cheque, or the bank paying a credit card whose purchases the card statement already
 * counts. Filing the row as a new expense or income then counts the money twice. Each matcher below answers one question on evidence only,
 * and says "no" when the evidence is thin — a row that is not matched is filed as before (the old behaviour), never dropped.
 *
 * Pure: no storage, no clock, no network.
 * ===========================================================================*/

import { sameBank } from './wealthflow-institutions.js';
import { installmentInfo } from './wealthflow-statement-router.js';
import { evidenceOf, identityOf, isTelecomBrand } from './statement-subscriptions.mjs';
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const arr = (v) => (Array.isArray(v) ? v : []);
const low = (v) => String(v == null ? '' : v).toLowerCase();
const cents = (v) => Math.round(num(v) * 100);
const words = (v) => low(v).replace(/[^a-z0-9]+/g, ' ').trim();
const dayNumber = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
const ymOf = (iso) => { const m = /^(\d{4})-(\d{2})/.exec(String(iso || '')); return m ? `${m[1]}-${m[2]}` : ''; };
const tokens = (v) => words(v).split(' ').filter((t) => t.length >= 4 && !STOP.has(t));
const STOP = new Set(['payment', 'transfer', 'credit', 'debit', 'online', 'bank', 'card', 'pos', 'transaction', 'purchase', 'salary', 'monthly', 'ceft', 'cefts', 'slips', 'inward', 'outward']);
/* Words too common in a narration to say two things are the same purchase ("salary" is not among them: salary, typed and credited, is the same salary). */
const TOO_COMMON = new Set(['payment', 'transfer', 'credit', 'debit', 'online', 'bank', 'card', 'pos', 'transaction', 'purchase', 'monthly', 'ceft', 'cefts', 'slips', 'inward', 'outward', 'other', 'expense', 'income']);
const sharesAWord = (typed, text) => words(typed).split(' ').some((w) => w.length >= 4 && !TOO_COMMON.has(w) && text.includes(w));

/* ── 1. A THING THE OWNER TYPED IN BY HAND, THEN THE STATEMENT'S ROW FOR IT ────────────────────────────────────────────────────────────────
 * Same amount to the cent, in the same direction, and the hand-made entry has not already been matched to another row. WHEN: the same day or a day either side — or, when the typed
 * words and the statement's share a word ("Keells" and "KEELLS SUPER COLOMBO"), up to three days: a purchase is typed the day it is made and a bank or a card posts it days later, and
 * the same amount to the cent with the same name in it is the same purchase, not a coincidence. (`strict`: with no word in common only the same day — used on what is already in the books.) A hand-made entry that stands for every month (recurring) is matched only when its words
 * and the statement's share one, and once per month. Two candidates that fit equally are never guessed between: the row is filed as before. */
export const TWIN_DAYS = 1, TWIN_DAYS_NAMED = 3;
export function manualTwin(records, row, { month = ymOf(row && row.date), strict = false } = {}) {
    const want = cents(row && row.amount), day = dayNumber(row && row.date);
    if (!(want > 0) || !Number.isFinite(day)) return null;
    const text = words(row.description || row.narration);
    const fits = [];
    for (const r of arr(records)) {
        if (!r || r.source === 'statement' || r.statementKey || cents(r.amount) !== want) continue;
        if (r.loanLink || r.subscriptionLink) continue;
        /* an entry the owner's own UPLOAD filed (a card charge keeps no `source` of its own) is a statement's row, not one typed by hand: it is compared as a row of a statement (statement-rowmatch.mjs), never taken for a twin */
        if (r.uploadClaim || r._batch || (r.feeMeta && r.feeMeta.source === 'statement')) continue;
        const mine = tokens(r.desc || r.name), named = mine.some((t) => text.includes(t)) || sharesAWord(r.desc || r.name, text);
        if (r.recurring) {
            if (r.statementTwins && r.statementTwins[month]) continue;
            if (!mine.length || !named || String(r.month || '') > month) continue;
            fits.push({ r, gap: 0, recurring: true });
            continue;
        }
        if (r.statementTwin) continue;
        const at = dayNumber(r.date);
        if (!Number.isFinite(at)) continue;                 // a hand-made entry with no day cannot be told from another by its day
        const gap = Math.abs(at - day);
        if (gap <= (named ? TWIN_DAYS_NAMED : strict ? 0 : TWIN_DAYS)) fits.push({ r, gap, recurring: false });
    }
    if (!fits.length) return null;
    fits.sort((a, b) => a.gap - b.gap);
    if (fits.length > 1 && fits[0].gap === fits[1].gap) return null;
    return fits[0];
}
/** Remember which row a hand-made entry stands for, so it stands for no second row (a recurring one: no second row in that month). The row's date, amount and direction are kept with it, so the
 * same statement read a second time (another copy, another message) is known for what it is: the row this entry already stands for. */
export function markTwin(twin, month, sourcePath, index, now, row = null) {
    const stamp = { sourcePath, index, ...(row ? { date: String(row.date || ''), cents: cents(row.amount), direction: String(row.direction || '') } : {}) };
    if (twin.recurring) twin.r.statementTwins = { ...(twin.r.statementTwins || {}), [month]: stamp };
    else twin.r.statementTwin = stamp;
    twin.r._ut = now;
}

/**
 * A ROW THAT IS ONLY A COPY OF ONE ALREADY ACCOUNTED FOR. A statement read a second time — another copy of the message, an overlapping statement — brings the same rows again. The first reading
 * tied each of them to something that is already counted (an entry the owner typed, a subscription, an installment plan); that something stands for ONE row, so the copy found it taken and was
 * filed as a new expense: counted twice. Same date, same amount to the cent, same direction, and the stamp names ANOTHER statement: the copy is a duplicate, whatever it was tied to.
 * @returns {string} what holds the row ('entry' | 'subscription' | 'plan'), or '' when nothing does
 */
export function accountedCopy(user, row, sourcePath) {
    const want = cents(row && row.amount), date = String((row && row.date) || ''), direction = String((row && row.direction) || 'debit');
    if (!(want > 0) || !date) return '';
    const copy = (stampSource, stampDate, stampCents, stampDirection) => !!stampSource && stampSource !== sourcePath && stampDate === date && stampCents === want && (stampDirection || 'debit') === direction;
    for (const list of [user && user.expenses, user && user.incomeRecv, user && user.cconetime]) {
        for (const r of arr(list)) {
            if (!r || r.source === 'statement') continue;
            for (const st of [r.statementTwin, ...Object.values(r.statementTwins || {})]) if (st && copy(st.sourcePath, st.date, st.cents, st.direction)) return 'entry';
        }
    }
    for (const sub of arr(user && user.subscriptions)) if (arr(sub && sub.history).some((h) => h && h.source === 'statement' && copy(h.statementKey, h.date, cents(h.amount), 'debit'))) return 'subscription';
    for (const plan of arr(user && user.ccinstall)) if (arr(plan && plan.payments).some((p) => p && p.source === 'statement' && copy(p.statementKey, new Date(num(p.paidAt)).toISOString().slice(0, 10), cents(p.amount), 'debit'))) return 'plan';
    return '';
}

/* ── 2. A DEBIT THAT IS A SUBSCRIPTION THE OWNER ALREADY TRACKS ───────────────────────────────────────────────────────────────────────────── */
/** Is this subscription counted by the monthly totals in `ym`? (the same cycle rules getMonthlyData uses) */
export function subscriptionCountedIn(sub, ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (!sub || !m) return false;
    const year = Number(m[1]), month = Number(m[2]) - 1;
    const created = sub.createdAt ? new Date(sub.createdAt) : null;
    if (created && Number.isFinite(created.getTime())) {
        if (created.getFullYear() > year || (created.getFullYear() === year && created.getMonth() > month)) return false;
        const cycle = low(sub.cycle || 'monthly');
        if ((cycle === 'yearly' || cycle === 'annual') && created.getMonth() !== month) return false;
    }
    return true;
}
/** Do two phone-number lists share a number? */
const sharesNumber = (a, b) => a.some((n) => b.includes(n));
/**
 * The one subscription a debit is a payment of, or null when none or when two fit. Evidence, strongest first (statement-subscriptions.mjs):
 *   · a phone NUMBER in the narration that an entry carries — that entry, for any amount (a phone bill changes every month), and a second payment in the same month is added to it;
 *   · a BRAND the narration and an entry both name (Anthropic / Claude, OpenAI / ChatGPT, …), or the entry's own NAME in the narration — an amount about right (a different
 *     charge from the same merchant is not its payment), and one statement payment a month.
 * Two entries that fit are told apart by an amount within 2% of what each expects; if that does not settle it, the row is not guessed.
 */
export function matchSubscriptionForDebit(row, subs) {
    const amount = num(row && row.amount), text = words(row && (row.description || row.narration)), ym = ymOf(row && row.date);
    if (!(amount > 0) || !text || !ym) return null;
    const seen = evidenceOf(row), byNumber = [], byCompany = [], byName = [];
    for (const sub of arr(subs)) {
        if (!sub || !sub.id || !subscriptionCountedIn(sub, ym)) continue;
        // a one-time bill that is already paid is finished: a later charge from the same merchant is a new payment, not that bill (reopening it is the owner's call)
        if (/^(once|one-time|onetime)$/.test(low(sub.cycle)) && (sub.paid || sub.completed)) continue;
        const identity = identityOf(sub);
        if (seen.phones.length && sharesNumber(seen.phones, identity.phones)) { byNumber.push(sub); continue; }
        // a bill's account reference is its identity as a number is: that entry, for any amount, and every payment of the month is added to it
        if (seen.refs.length && sharesNumber(seen.refs, identity.refs)) { byNumber.push(sub); continue; }
        // a phone company paid with no number on the line (a card reload at DIALOG AXIATA): the company's own entry, for any amount, and every reload of the month is added to it. A line that names a number or a
        // bill reference is never put on a company-wide entry: it belongs to that number's own.
        if (!seen.phones.length && !seen.refs.length && seen.brands.some((b) => isTelecomBrand(b) && identity.brands.includes(b.key)) && !identity.phones.length && !identity.refs.length) { byCompany.push(sub); continue; }
        // the subscription's month holds ONE amount: a second charge in the same month is its own payment and is filed as one
        if (arr(sub.history).some((h) => h && h.month === ym && h.source === 'statement')) continue;
        const name = words(sub.name);
        const named = (name.length >= 4 && (text.includes(name) || (tokens(name).length > 0 && tokens(name).every((t) => text.includes(t)))))
            || seen.brands.some((b) => identity.brands.includes(b.key));
        if (!named) continue;
        const expected = num((sub.monthOverrides && sub.monthOverrides[ym]) || sub.amount);
        if (expected > 0 && (amount < expected * 0.5 || amount > expected * 1.6)) continue;     // a different charge from the same merchant
        byName.push({ sub, expected });
    }
    if (byNumber.length) return byNumber.length === 1 ? byNumber[0] : null;     // the number is the identity: two entries with it are not guessed between
    if (byCompany.length) return byCompany.length === 1 ? byCompany[0] : null;
    if (byName.length === 1) return byName[0].sub;
    const close = byName.filter((hit) => hit.expected > 0 && Math.abs(amount - hit.expected) <= hit.expected * 0.02);
    return byName.length > 1 && close.length === 1 ? close[0].sub : null;
}

/* ── 3. A CHEQUE THE OWNER ISSUED ──────────────────────────────────────────────────────────────────────────────────────────────────────────
 * A bank row that clears a cheque the owner issued (or deposited) is read and matched in wealthflow-cheques.js — by cheque number first, then by amount and days — and settled against the Cheque
 * Tracker by statement-ledger.mjs. It used to be matched here by the amount alone. */

/* ── 4. THE BANK PAYING A CREDIT CARD ──────────────────────────────────────────────────────────────────────────────────────────────────────── */
const CARD_PAYMENT = /\b(?:credit\s*card|card|cc|amex|visa|master\s*card|mastercard)\s*(?:payment|settlement|bill|repayment|dues?|instal?ment)\b|\bpayment\s+(?:to|for|of)\s+(?:my\s+)?(?:credit\s*)?card\b|\bpay\s+(?:to\s+)?(?:credit\s*)?card\b/i;
const BANK_GENERIC = new Set(['bank', 'plc', 'limited', 'ltd', 'credit', 'card', 'cards', 'finance', 'lanka', 'sri', 'commercial', 'national', 'of', 'the']);
const bankWords = (name) => words(name).split(' ').filter((t) => t.length >= 3 && !BANK_GENERIC.has(t));
/**
 * A debit on a BANK account that settles a credit card the owner TRACKS: the card's own statement carries the purchases, so the settlement is not
 * spending. The narration must say which card — its last four digits or its bank's name — and that card must be one the owner's books hold
 * (the card registry, or a card charge / card payment on record). A settlement of a card the books know nothing about is the only record of that
 * spending and stays an expense.
 */
export function cardSettlementDebit(row, { cardRegistry = {}, cards = [] } = {}) {
    const raw = String((row && (row.description || row.narration)) || '');
    if (!CARD_PAYMENT.test(raw)) return false;
    const text = words(raw), digits = raw.replace(/\D/g, ' ');
    const tracked = [];
    for (const [last4, entry] of Object.entries(cardRegistry || {})) tracked.push({ last4: String(last4), bank: entry && entry.bank });
    for (const c of arr(cards)) tracked.push({ last4: String((c && c.card_last4) || ''), bank: c && c.bank });
    return tracked.some((card) => (/^\d{4}$/.test(card.last4) && new RegExp(`(^|\\D)\\d*${card.last4}(\\D|$)`).test(digits))
        || bankWords(card.bank).some((w) => text.split(' ').includes(w)));
}

/* ── 5. A CARD INSTALLMENT CHARGE FOR A PLAN THE OWNER ALREADY HAS ────────────────────────────────────────────────────────────────────────── */
const addMonths = (iso, n) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); if (!m) return NaN; return Date.UTC(+m[1], +m[2] - 1 + n, +m[3]); };
/** Is this installment plan counted by the monthly totals in `ym`? (the same rule getMonthlyData uses: it has started by the month's first day and not yet ended) */
export function planCountedIn(plan, ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (!plan || plan.completed || !m || !plan.date || !(num(plan.duration) > 0)) return false;
    const first = Date.UTC(+m[1], +m[2] - 1, 1), start = addMonths(plan.date, 0), end = addMonths(plan.date, Math.floor(num(plan.duration)));
    return Number.isFinite(start) && Number.isFinite(end) && start <= first && end > first;
}
const monthIndex = (fromIso, ym) => { const a = /^(\d{4})-(\d{2})/.exec(String(fromIso || '')), b = /^(\d{4})-(\d{2})$/.exec(String(ym || '')); return a && b ? (+b[1] - +a[1]) * 12 + (+b[2] - +a[2]) : NaN; };
/** A plan whose line never said how long it is carries on: the month straight after the last one it has counted is its next month, not a new plan. */
const continuesUnknown = (plan, ym) => !!plan && plan.durationUnknown === true && !plan.completed && num(plan.duration) >= 1 && monthIndex(plan.date, ym) === Math.floor(num(plan.duration));
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
const round2 = (v) => Math.round(num(v) * 100) / 100;
const firstOfMonth = (iso, back = 0) => { const m = /^(\d{4})-(\d{2})/.exec(String(iso || '')); return m ? new Date(Date.UTC(+m[1], +m[2] - 1 - back, 1)).toISOString().slice(0, 10) : ''; };
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
        if (no >= 1) { plan.installmentNo = Math.max(Math.floor(num(plan.installmentNo)), no); if (!plan.installmentOf && num(info.of) >= 2) plan.installmentOf = Math.floor(num(info.of)); }
        const done = Math.max(Math.floor(num(plan.installmentNo)), arr(plan.payments).filter((p) => p && p.paid).length), length = Math.floor(num(plan.duration));
        plan.paid = length > 0 ? Math.min(done, length) : done; plan.remaining = Math.max(0, length - plan.paid);
        /* the note says the latest charge the statements showed */
        const seen = /^Card installment charge of (\d{4}-\d{2}-\d{2})/.exec(String(plan.notes || ''));
        if (seen && row.date > seen[1]) plan.notes = `Card installment charge of ${row.date}${no >= 1 && num(info.of) >= 2 ? ` (${no} of ${Math.floor(num(info.of))})` : ''}`;
    }
    plan._ut = now;
}
/**
 * A card installment record the statement worker filed in its own shape (description, startDate, months — no product, date or duration) is invisible to the
 * monthly totals, so a real card charge was missing from them. This gives such a record the plan's shape so it counts in its month — unless a plan the owner
 * already has is that charge, in which case the record stays out and the plan's month says it was paid. Returns what it did, per record.
 */
export function repairInstallmentRecords(user, now) {
    const done = [];
    const plans = arr(user && user.ccinstall);
    for (const r of plans) {
        if (!r || r.date || !r.startDate || r.source !== 'statement') continue;
        const row = { amount: r.monthly || r.total, description: r.desc || r.product, date: r.startDate };
        const plan = matchInstallmentPlan(row, plans.filter((p) => p !== r && p.date));
        if (plan) { applyPlanPayment(plan, row, r.statementKey || '', r.statementRow, now); r.planLink = plan.id; r.completed = true; r._ut = now; done.push({ id: r.id, kind: 'plan-link' }); continue; }
        /* the line says how long its plan is, when it does: that is the plan's length (one instalment is one month); when it does not, the plan is one month long and says so */
        const info = installmentInfo(String(r.desc || r.product || '')), shape = planFromLine({ amount: r.monthly || r.total, date: r.startDate, no: info.no, length: info.length });
        Object.assign(r, { product: r.product || String(info.name || r.desc || '').slice(0, 60), bank: r.bank || '', buyer: r.buyer || 'Self', rate: r.rate || 0, rateUnknown: true, ...shape, completed: false, skipped: r.skipped || [], _ut: now,
            ...(info.no && info.of ? { installmentNo: info.no, installmentOf: info.of } : {}),
            payments: arr(r.payments).length ? r.payments : [{ month: ymOf(r.startDate), paid: true, amount: num(r.monthly || r.total), paidAt: Date.parse(`${String(r.startDate).slice(0, 10)}T00:00:00Z`) || now, source: 'statement', statementKey: r.statementKey || '', statementRow: r.statementRow }] });
        done.push({ id: r.id, kind: 'shape' });
    }
    return done;
}

/**
 * ONE PLAN, ONE ROW. Before a plan line said how long its plan was, every month of a card plan was filed as a plan of its own, one month long: "2 of 12" in September was a second, separate "1M" plan next to
 * "1 of 12" in August, the totals counted each only in its own month, and the twelve months to come were missing. This puts them right, in the owner's own list, without deleting anything:
 *   - a run of such records that are the same plan (same card, same name, same length, the same monthly money to 2%, each month once) becomes ONE plan of the length the statements print: it begins in the
 *     month its first instalment was due (this charge's month less the instalments before it), its months paid are the months the statements showed, and its total is the monthly money times its length
 *     (an estimate: `totalEstimated`). The other records stay in the data, finished and marked `mergedInto` (so the list hides them, and nothing that looks for the statement's rows finds them missing);
 *   - a run that is a plan the owner already has under their own name (the same rule a new line is matched by) is not a plan at all: its months are that plan's payments;
 *   - a record whose line did not say how many instalments it had is left alone, and says so (`durationUnknown`).
 * Two records for the same month are merged only when they are the same statement row; otherwise they are two plans and stay two.
 */
const noteOf = (r) => { const m = /\((\d{1,2}) of (\d{1,2})\)/.exec(String((r && r.notes) || '')); return m ? { no: Number(m[1]), of: Number(m[2]) } : { no: 0, of: 0 }; };
const chargeDateOf = (r) => { const m = /^Card installment charge of (\d{4}-\d{2}-\d{2})/.exec(String((r && r.notes) || '')); return String((r && (r.startDate || (m && m[1]))) || (r && r.date) || '').slice(0, 10); };
const sameRow = (a, b) => !!(a.statementKey && a.statementKey === b.statementKey && a.statementRow === b.statementRow);
/** the records of one plan, in order: the same monthly money (2%), and a month (and a number, when the line has one) not yet taken unless it is the very same statement row */
function splitSeries(list) {
    const series = [];
    for (const e of list) {
        const home = series.find((s) => Math.abs(num(e.r.monthly) - num(s[0].r.monthly)) <= num(s[0].r.monthly) * 0.02 && !s.some((x) => (ymOf(x.date) === ymOf(e.date) || (e.no && x.no === e.no)) && !sameRow(x.r, e.r)));
        if (home) home.push(e); else series.push([e]);
    }
    return series;
}
const paidMonths = (run, now) => { const months = new Map(); for (const e of run) { const month = ymOf(e.date); if (!months.has(month)) months.set(month, { month, paid: true, amount: num(e.r.monthly), paidAt: Date.parse(`${e.date}T00:00:00Z`) || now, source: 'statement', statementKey: e.r.statementKey || '', statementRow: e.r.statementRow }); } return months; };
export function mergeInstalmentSeries(user, now) {
    const plans = arr(user && user.ccinstall), done = [], owned = plans.filter((p) => p && p.date && p.source !== 'statement' && !p.statementKey && !p.completed && !p.mergedInto);
    const stated = new Map(), loose = new Map();
    const put = (map, key, e) => (map.get(key) || map.set(key, []).get(key)).push(e);
    for (const r of plans) {
        if (!r || !(r.source === 'statement' || r.statementKey) || r.mergedInto || r.planLink || r.completed === true || r.durationUnknown) continue;
        if (Math.floor(num(r.duration)) !== 1 || !(num(r.monthly) > 0) || !words(r.product)) continue;
        /* a record filed before the length was kept still carries the line's own words (`desc`): "INSTALMENT 2/12 ..." or "EASY PAY 6 MONTHS ...". The saved numbers come first, then the note, then those words;
         * a line that prints the length but not which instalment it is ("6 MONTHS") is a plan of that length with the instalment number unknown (no = 0), never a plan of unknown length */
        const note = noteOf(r), said = installmentInfo(String(r.desc || r.product || '')), date = chargeDateOf(r);
        let no = Math.floor(num(r.installmentNo)) || note.no || said.no, of = Math.floor(num(r.installmentOf)) || note.of || said.of;
        if (!(of >= 2) && said.length >= 2) { of = said.length; no = 0; }
        if (!ymOf(date)) continue;
        const key = [words(r.bank), String(r.card_last4 || ''), words(r.product)].join('|');
        if (of >= 2 && no >= 0 && no <= of) put(stated, `${key}|${of}`, { r, no, of, date }); else if (!(of >= 2)) put(loose, key, { r, no: 0, of: 0, date });
    }
    const byDate = (a, b) => a.date.localeCompare(b.date) || a.no - b.no;
    /* plans whose lines state their length: one plan of that length */
    for (const list of stated.values()) {
        for (const run of splitSeries(list.sort(byDate))) {
            const base = run[0], latest = run.reduce((a, b) => (b.no >= a.no ? b : a)), months = paidMonths(run, now);
            /* a plan the owner keeps under their own name takes the months as its payments */
            const theirs = matchInstallmentPlan({ amount: num(latest.r.monthly), description: `${base.r.product} instalment`, date: latest.date }, owned, { installment: true, bank: base.r.bank, of: base.of });
            if (theirs) {
                for (const e of run) { applyPlanPayment(theirs, { amount: num(e.r.monthly), date: e.date }, e.r.statementKey || '', e.r.statementRow, now); e.r.planLink = theirs.id; e.r.completed = true; e.r.mergedInto = theirs.id; e.r._ut = now; }
                done.push({ id: theirs.id, kind: 'owner-plan', merged: run.length }); continue;
            }
            const shape = planFromLine({ amount: num(latest.r.monthly), date: base.date, no: base.no, length: base.of });
            Object.assign(base.r, { duration: shape.duration, months: shape.months, date: shape.date, monthly: num(latest.r.monthly), total: round2(num(latest.r.monthly) * base.of), totalEstimated: true,
                ...(latest.no >= 1 ? { installmentNo: latest.no } : {}), installmentOf: base.of, paid: Math.min(base.of, Math.max(latest.no, months.size)), payments: [...months.values()], rateUnknown: true, notes: latest.r.notes || base.r.notes, completed: false, _ut: now });
            base.r.remaining = Math.max(0, base.of - base.r.paid);
            for (const e of run) if (e !== base) { e.r.completed = true; e.r.mergedInto = base.r.id; e.r._ut = now; }
            if (run.length > 1) base.r.mergedFrom = run.filter((e) => e !== base).map((e) => e.r.id);
            done.push({ id: base.r.id, kind: run.length > 1 ? 'series' : 'length', merged: run.length });
        }
    }
    /* plans whose lines never said how long they are: the months seen are one plan that is at least that long, and it says its length is not on the statement */
    for (const list of loose.values()) {
        for (const run of splitSeries(list.sort(byDate))) {
            const base = run[0], latest = run[run.length - 1], months = paidMonths(run, now);
            const span = monthIndex(base.date, ymOf(latest.date)) + 1;
            Object.assign(base.r, { duration: Math.max(1, span), months: Math.max(1, span), date: firstOfMonth(base.date), monthly: num(latest.r.monthly), total: round2(num(latest.r.monthly) * Math.max(1, span)), durationUnknown: true, rateUnknown: true,
                payments: [...months.values()], paid: months.size, remaining: 0, completed: false, _ut: now });
            for (const e of run) if (e !== base) { e.r.completed = true; e.r.mergedInto = base.r.id; e.r._ut = now; }
            if (run.length > 1) base.r.mergedFrom = run.filter((e) => e !== base).map((e) => e.r.id);
            done.push({ id: base.r.id, kind: run.length > 1 ? 'series-open' : 'open', merged: run.length });
        }
    }
    return done;
}

export default { manualTwin, markTwin, accountedCopy, planCountedIn, matchInstallmentPlan, applyPlanPayment, repairInstallmentRecords, subscriptionCountedIn, matchSubscriptionForDebit, cardSettlementDebit, planFromLine, mergeInstalmentSeries };
