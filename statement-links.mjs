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

/* ── 1. A THING THE OWNER TYPED IN BY HAND, THEN THE STATEMENT'S ROW FOR IT ────────────────────────────────────────────────────────────────
 * Same amount to the cent, on the same day or the day either side, in the same direction, and the hand-made entry has not already been matched to
 * another row. A hand-made entry that stands for every month (recurring) is matched only when its words and the statement's share one, and once
 * per month. Two candidates that fit equally are never guessed between: the row is filed as before. */
export function manualTwin(records, row, { month = ymOf(row && row.date) } = {}) {
    const want = cents(row && row.amount), day = dayNumber(row && row.date);
    if (!(want > 0) || !Number.isFinite(day)) return null;
    const text = words(row.description || row.narration);
    const fits = [];
    for (const r of arr(records)) {
        if (!r || r.source === 'statement' || r.statementKey || cents(r.amount) !== want) continue;
        if (r.loanLink || r.subscriptionLink) continue;
        if (r.recurring) {
            if (r.statementTwins && r.statementTwins[month]) continue;
            const mine = tokens(r.desc || r.name);
            if (!mine.length || !mine.some((t) => text.includes(t)) || String(r.month || '') > month) continue;
            fits.push({ r, gap: 0, recurring: true });
            continue;
        }
        if (r.statementTwin) continue;
        const at = dayNumber(r.date);
        if (!Number.isFinite(at)) continue;                 // a hand-made entry with no day cannot be told from another by its day
        const gap = Math.abs(at - day);
        if (gap <= 1) fits.push({ r, gap, recurring: false });
    }
    if (!fits.length) return null;
    fits.sort((a, b) => a.gap - b.gap);
    if (fits.length > 1 && fits[0].gap === fits[1].gap) return null;
    return fits[0];
}
/** Remember which row a hand-made entry stands for, so it stands for no second row (a recurring one: no second row in that month). */
export function markTwin(twin, month, sourcePath, index, now) {
    const stamp = { sourcePath, index };
    if (twin.recurring) twin.r.statementTwins = { ...(twin.r.statementTwins || {}), [month]: stamp };
    else twin.r.statementTwin = stamp;
    twin.r._ut = now;
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

/* ── 3. A DEBIT THAT IS A CHEQUE THE OWNER ISSUED ──────────────────────────────────────────────────────────────────────────────────────────── */
const CHEQUE_WORD = /\b(chq|cheque|check|chk)\b/;
/** The one issued cheque this bank debit clears: the cheque number in the narration, or the same amount to the cent within ten days of its date. */
export function matchChequeForDebit(row, cheques) {
    const text = low(row && (row.description || row.narration)), amount = cents(row && row.amount), day = dayNumber(row && row.date);
    if (!CHEQUE_WORD.test(text) || !(amount > 0) || !Number.isFinite(day)) return null;
    const digits = text.match(/\d{3,}/g) || [];
    const fits = [];
    for (const c of arr(cheques)) {
        if (!c || c.type === 'received' || c.status === 'bounced' || cents(c.amount) !== amount) continue;
        const no = String(c.no || '').replace(/\D/g, '');
        const byNumber = no.length >= 3 && digits.some((d) => d.replace(/^0+/, '') === no.replace(/^0+/, ''));
        const at = dayNumber(c.release || c.issue);
        const byDate = Number.isFinite(at) && Math.abs(at - day) <= 10;
        if (byNumber || byDate) fits.push({ c, byNumber });
    }
    if (!fits.length) return null;
    const numbered = fits.filter((f) => f.byNumber);
    const pool = numbered.length ? numbered : fits;
    return pool.length === 1 ? pool[0].c : null;
}

/* ── 4. THE BANK PAYING A CREDIT CARD ──────────────────────────────────────────────────────────────────────────────────────────────────────── */
const CARD_PAYMENT = /\b(?:credit\s*card|card|cc|amex|visa|master\s*card|mastercard)\s*(?:payment|settlement|bill|repayment|dues?|instal?ment)\b|\bpayment\s+(?:to|for|of)\s+(?:my\s+)?(?:credit\s*)?card\b|\bpay\s+(?:to\s+)?(?:credit\s*)?card\b/i;
/**
 * A debit on a BANK account that settles a credit card the owner tracks: the card's own statement carries the purchases, so the settlement is
 * not spending. Only when the owner tracks at least one card (otherwise this payment is the only record of that spending and stays an expense).
 */
export function cardSettlementDebit(row, { cardRegistry = {}, trackedCards = 0 } = {}) {
    const text = String((row && (row.description || row.narration)) || '');
    if (!CARD_PAYMENT.test(text)) return false;
    return Object.keys(cardRegistry || {}).length > 0 || num(trackedCards) > 0;
}

export default { manualTwin, markTwin, subscriptionCountedIn, matchSubscriptionForDebit, matchChequeForDebit, cardSettlementDebit };
