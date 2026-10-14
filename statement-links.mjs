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
/** The one subscription whose name is in the narration and whose amount is about right; null when none or when two fit. */
export function matchSubscriptionForDebit(row, subs) {
    const amount = num(row && row.amount), text = words(row && (row.description || row.narration)), ym = ymOf(row && row.date);
    if (!(amount > 0) || !text || !ym) return null;
    const hits = [];
    for (const sub of arr(subs)) {
        if (!sub || !sub.id || !subscriptionCountedIn(sub, ym)) continue;
        // a one-time bill that is already paid is finished: a later charge from the same merchant is a new payment, not that bill (reopening it is the owner's call)
        if (/^(once|one-time|onetime)$/.test(low(sub.cycle)) && (sub.paid || sub.completed)) continue;
        // the subscription's month holds ONE amount: a second charge in the same month is its own payment and is filed as one
        if (arr(sub.history).some((h) => h && h.month === ym && h.source === 'statement')) continue;
        const name = words(sub.name);
        if (name.length < 4) continue;
        const named = text.includes(name) || (tokens(name).length > 0 && tokens(name).every((t) => text.includes(t)));
        if (!named) continue;
        const expected = num((sub.monthOverrides && sub.monthOverrides[ym]) || sub.amount);
        if (expected > 0 && (amount < expected * 0.5 || amount > expected * 1.6)) continue;     // a different charge from the same merchant
        hits.push(sub);
    }
    return hits.length === 1 ? hits[0] : null;
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
/** The one plan whose product is named in the narration, whose monthly amount is this charge (to 2%), and which the totals count this month. */
export function matchInstallmentPlan(row, plans) {
    const amount = num(row && row.amount), text = words(row && (row.description || row.narration)), ym = ymOf(row && row.date);
    if (!(amount > 0) || !text || !ym) return null;
    const hits = [];
    for (const plan of arr(plans)) {
        if (!plan || !plan.id || !planCountedIn(plan, ym) || !(num(plan.monthly) > 0)) continue;
        if (Math.abs(amount - num(plan.monthly)) > num(plan.monthly) * 0.02) continue;
        if (arr(plan.payments).some((p) => p && p.month === ym && p.paid && p.source === 'statement')) continue;     // that month already has its charge: this one is another
        const product = tokens(plan.product);
        if (product.length && product.some((t) => text.includes(t))) hits.push(plan);
    }
    return hits.length === 1 ? hits[0] : null;
}
/** The plan's payment for the month, from the statement: the plan counts it (its monthly amount), the statement row does not become a second record. */
export function applyPlanPayment(plan, row, sourcePath, index, now) {
    const month = ymOf(row.date);
    plan.payments = arr(plan.payments).filter((p) => !(p && p.month === month));
    plan.payments.push({ month, paid: true, amount: num(row.amount), paidAt: Date.parse(`${row.date}T00:00:00Z`) || now, source: 'statement', statementKey: sourcePath, statementRow: index });
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
        Object.assign(r, { product: r.product || String(r.desc || '').slice(0, 60), bank: r.bank || '', buyer: r.buyer || 'Self', rate: r.rate || 0, duration: 1, date: `${String(r.startDate).slice(0, 7)}-01`, completed: false, skipped: r.skipped || [], _ut: now });
        done.push({ id: r.id, kind: 'shape' });
    }
    return done;
}

export default { manualTwin, markTwin, accountedCopy, planCountedIn, matchInstallmentPlan, applyPlanPayment, repairInstallmentRecords, subscriptionCountedIn, matchSubscriptionForDebit, cardSettlementDebit };
