/* =============================================================================
 * wealthflow-advisor-scenarios.js — "what if I do this", worked out by code
 * -----------------------------------------------------------------------------
 * The owner asks the Advisor things like "can I buy a car for 2.5M?", "ලක්ෂ 10ක ණයක් ගත්තොත්?", "if I pay 20,000 extra on the Honda loan",
 * "what if my salary stops?". A language model is good at weighing a decision and bad at the arithmetic under it: an instalment, the interest
 * over five years, how many months a balance lasts. Left to itself it does that arithmetic in prose, differently each time, and states the
 * result as if it came from the books.
 *
 * So the arithmetic is done HERE, from the owner's own figures (the fact sheet) and the engines the screens already trust:
 *   • instalments and interest: the standard annuity formula, cross-checked in test/advisor_scenarios_test.js against wealthflow-amortize.js;
 *   • what happens to the next months of cash: wealthflow-whatif.js over the cash-flow engine, the same projection the runway card shows;
 *   • the debt-service ratio and what is left each month: the books profile the DSCR, the Score and the Debt Demolisher use.
 * The result is written as a block of text the model is told to copy. Anything the owner did not say (a rate, a term) is an ASSUMPTION and is
 * marked as one, so the model says it and the owner can correct it.
 *
 * Nothing here posts, saves or changes a record. It reads, and returns text and numbers.
 * ===========================================================================*/

import { project as amortizeProject, scheduledPayment, monthlyRate } from './wealthflow-amortize.js';
import { runScenario as whatIf, CHANGE } from './wealthflow-whatif.js';
import { lkr, currentSheet, pageDeps, isDate } from './wealthflow-advisor-facts.js';

export const SCENARIO_VERSION = 1;

const RULES = {
    DEFAULT_RATE_PCT: 14,          // used only when the owner gave no rate, and said so; the lender's quote replaces it
    RATE_SENSITIVITY: 3,           // "and if the rate is this many points higher"
    LONG_TERM_FROM: 1_000_000,     // a purchase this large is assumed financed over LONG_MONTHS, a smaller one over SHORT_MONTHS
    LONG_MONTHS: 60,
    SHORT_MONTHS: 24,
    DSR_WATCH: 30,
    DSR_HIGH: 40,
    COVER_MONTHS: 3,               // the emergency cushion the sheet already uses
    ENGINE_HORIZON: 180,           // days the cash-flow engine looks ahead for a scenario (a loan's first instalments are inside it)
    MAX_MONTHS: 600,
};

const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };
const r0 = (n) => Math.round(num(n));
const r1 = (n) => Math.round(num(n) * 10) / 10;
const pct = (n) => `${r1(n)}%`;
const safe = (fn, fallback) => { try { return fn(); } catch (_) { return fallback; } };
const clean = (s, n = 60) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/={2,}/g, '-').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, n);

/* ── the annuity arithmetic ───────────────────────────────────────────────── */

/** The level monthly instalment that clears `principal` in `months` at `annualPct` a year (0% is a straight division). */
export function emi(principal, annualPct, months) {
    const p = num(principal), n = Math.floor(num(months));
    if (!(p > 0) || !(n > 0)) return 0;
    const i = num(annualPct) / 100 / 12;
    if (!(i > 0)) return p / n;
    /* log1p/expm1 keep the denominator exact for a rate so small that 1 + i rounds to 1 (the textbook form divides by zero there) */
    return (p * i) / -Math.expm1(-n * Math.log1p(i));
}

/** A loan quoted: instalment, what is paid in all, and the interest in it. */
export function quote(principal, annualPct, months) {
    const payment = emi(principal, annualPct, months);
    const total = payment * Math.floor(num(months));
    return { principal: r0(principal), ratePct: r1(annualPct), months: Math.floor(num(months)), payment: r0(payment), total: r0(total), interest: r0(total - num(principal)) };
}

/** How a balance runs down at a fixed payment: months to clear it and the interest paid on the way (null when the payment never clears it). */
export function payDown(balance, annualPct, payment) {
    let bal = num(balance), months = 0, interest = 0;
    const i = num(annualPct) / 100 / 12, pay = num(payment);
    if (!(bal > 0)) return { months: 0, interest: 0 };
    while (bal > 0.005 && months < 1200) {
        const cost = bal * i;
        if (pay <= cost + 0.005) return null;
        interest += cost; bal = bal + cost - Math.min(pay, bal + cost); months++;
    }
    return bal > 0.005 ? null : { months, interest };
}

/* ── reading an amount in any language ────────────────────────────────────────
 *
 * "2.5M", "2,500,000", "25 lakh", "ලක්ෂ 25", "රු. 50k", "14%", "5 years", "වසර 5", "මාස 60", "20,000 a month". A number only counts as an
 * amount when something says so (a currency, a multiplier, a comma, or at least 10,000), so "in 2027" and "5 years" are not money. */

const NUM_RE = /(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?/g;
const UNIT = {
    pct: /^\s*(?:%|percent|per ?cent|pct|ප්‍රතිශත|ප්රතිශත|சதவீதம்)/i,
    years: /^\s*(?:years?|yrs?|y\b|wasar[a-z]*|awurud[a-z]*|avurud[a-z]*|වසර|අවුරුදු|ආවුරුදු|වර්ෂ|ஆண்டு|வருட)/i,
    months: /^\s*(?:months?|mos?\b|mths?|maas[a-z]*|mase\b|masa\b|மாத|මාස(?![\u0d80-\u0dff]*ට))/i,
};
const MULT_AFTER = [
    [/^\s*(?:crore|cr\b|kotiy?a?[a-z]*|කෝටි|கோடி)/i, 1e7],
    [/^\s*(?:million|mn\b|mio\b|මිලියන|மில்லியன்)/i, 1e6],
    [/^\s*m(?![a-z])/i, 1e6],
    [/^\s*(?:lakhs?|lacs?|lac\b|laksh[a-z]*|ලක්ෂ|ලක්ශ|இலட்சம்|லட்சம்|இலட்ச|லட்ச)/i, 1e5],
    [/^\s*(?:thousand|k(?![a-z])|දහස|ஆயிரம்)/i, 1e3],
];
const MULT_BEFORE = [[/(?:\bkoti|කෝටි|கோடி)\s*$/i, 1e7], [/(?:මිලියන|மில்லியன்)\s*$/i, 1e6], [/(?:\blaksh[a-z]*|ලක්ෂ|ලක්ශ|இலட்சம்|லட்சம்)\s*$/i, 1e5]];
const CURRENCY_BEFORE = /(?:\blkr|\brs\.?|රු\.?|ரூ\.?)\s*$/i;
const CURRENCY_AFTER = /^\s*(?:lkr|rs\b|රුපියල්|ரூபாய்|\/=)/i;
const PER_MONTH = /(?:a month|per month|\/ ?month|\/mo\b|monthly|each month|every month|මසකට|මාසයකට|මාසයට|මාසෙට|මාසේට|மாதம்)/i;
/* "per month" can come before the figure too ("මාසයකට රු. 20,000", "மாதம் 20,000", "monthly 20,000") */
const PER_MONTH_BEFORE = /(?:මසකට|මාසයකට|මාසයට|මාසෙට|මාසේට|மாதம்|per month|monthly|each month|every month)\s*(?:lkr|rs\.?|රු\.?|ரூ\.?)?\s*$/i;
const RATE_BEFORE = /(?:\brate|\binterest|පොලිය|පොලී|வட்டி)[^\d]{0,14}$/i;
const YEARS_BEFORE = /(?:\byears?|\bwasar[a-z]*|\bawurud[a-z]*|වසර|අවුරුදු|ආවුරුදු)\s*[:\-]?\s*$/i;
const MONTHS_BEFORE = /(?:\bmonths?|\bmaas[a-z]*|\bmase|\bmasa|මාස)\s*[:\-]?\s*$/i;
const DOWN_NEAR = /(?:down ?payment|deposit|advance|initial payment|මූලික|අත්තිකාරම්|முன்பணம்)/i;

/**
 * Every number in the text, classified: { kind: 'amount' | 'pct' | 'years' | 'months', value, perMonth, down, at }.
 * Plain numbers that are none of those (a year, a count, "2") are left out.
 */
export function readNumbers(text) {
    const t = String(text == null ? '' : text);
    const out = [];
    NUM_RE.lastIndex = 0;
    let m;
    while ((m = NUM_RE.exec(t))) {
        const raw = m[0], at = m.index, end = at + raw.length;
        let value = parseFloat(raw.replace(/,/g, ''));
        if (!Number.isFinite(value)) continue;
        const after = t.slice(end, end + 24), before = t.slice(Math.max(0, at - 24), at), afterLong = t.slice(end, end + 70);
        if (UNIT.pct.test(after) || (RATE_BEFORE.test(before) && value <= 100 && !CURRENCY_BEFORE.test(before))) { out.push({ kind: 'pct', value, at }); continue; }
        if (UNIT.years.test(after) || YEARS_BEFORE.test(before)) { out.push({ kind: 'years', value, at }); continue; }
        if (UNIT.months.test(after) || MONTHS_BEFORE.test(before)) { out.push({ kind: 'months', value, at }); continue; }
        let explicit = raw.includes(',') || CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after);
        for (const [re, f] of MULT_AFTER) if (re.test(after)) { value *= f; explicit = true; break; }
        if (!explicit) for (const [re, f] of MULT_BEFORE) if (re.test(before)) { value *= f; explicit = true; break; }
        if (!explicit && value < 10000) continue;
        if (!explicit && value >= 1900 && value <= 2100 && !raw.includes('.')) continue;     // a year
        const near = before.slice(-18) + '|' + after.slice(0, 15);        // the words right beside it: "500k down payment", "down payment of 500k"
        const words = afterLong.replace(/^\s*(?:lkr|rs\.?|රුපියල්|\/=)/i, '').slice(0, 50).split(/\d/)[0].split(/[.?!\n]/)[0];   // what is said about it, up to the next number or the end of the sentence
        out.push({ kind: 'amount', value: Math.round(value), perMonth: PER_MONTH.test(words) || PER_MONTH_BEFORE.test(before), down: DOWN_NEAR.test(near), at });
    }
    return out;
}

/* ── what kind of question is it ──────────────────────────────────────────── */

const W = {
    // each list: English as whole words, Sinhala and Tamil as substrings (they have no word boundaries)
    lose: /\b(?:lose|lost|losing) (?:my|the) (?:job|income|salary)|\bjob loss|\blaid off|\bno income|\bsalary (?:stops?|stopped|cut|drops?|falls?|reduced)|\bincome (?:stops?|stopped|drops?|falls?|falling|cut|reduced|halves)|\bpay cut|රැකියාව නැති|රැකියාව අහිමි|වැටුප නැති|වැටුප අඩු|ආදායම නැති|ආදායම අඩු|ආදායම නවතී|வேலை இழ|வருமானம் குறை/i,
    extra: /\b(?:extra|additional|prepay|pre-pay|overpay|pay (?:it |the loan )?off|payoff|settle|clear (?:the|my|this) loan|close (?:the|my) loan|early)\b|\bpay(?:ing)?\b[^.?]{0,30}\bmore\b|\bpay(?:ing)?\b[^.?]{0,25}\b(?:off|down)\b|වැඩිපුර|අමතර|ඉක්මනින් ගෙවා|ණය ගෙවා අවසන්|අවසන් කරන්න|முன்கூட்டி|கூடுதல்/i,
    cut: /\b(?:cut|reduce|lower|trim|decrease|spend less|slash)\b|අඩු කරන්න|අඩුකරන්න|අඩු කළොත්|අඩු කලොත්|குறைத்தால்|குறை/i,
    borrow: /\b(?:loan|lease|leasing|finance|financing|borrow|credit|nayak|naya)\b|ණය|ලීසිං|කතා කරන්නේ ණයක්|கடன்|குத்தகை/i,
    buy: /\b(?:buy|buying|purchase|purchasing|afford|ganna|gannada|gannath|gannawa|gattot|gattoth|gaththot)\b|ගන්න|ගන්නද|ගනිමු|ගත්තොත්|මිලදී|வாங்க|வாங்கலாமா|வாங்கினால்/i,
    strongBuy: /\b(?:buy|buying|purchase|purchasing|afford)\b|මිලදී|வாங்க|வாங்கலாமா|வாங்கினால்/i,
    item: /\b(?:car|vehicle|bike|motorbike|house|home|land|apartment|flat|laptop|phone|furniture|tv|trip|wedding)\b|කාර්|වාහන|නිවස|ඉඩම|ගෙයක්|ලැප්ටොප්|බයිසිකල්|රථ/i,
    loanWord: /\b(?:loan|lease|instalment|installment|emi|mortgage)\b|ණය|ලීසිං|கடன்/i,
    save: /\b(?:save|saving|saved|accumulate|put aside|set aside|how long)\b|ඉතිරි|ඉතුරු|කොච්චර කල්|කොපමණ කාලයක්|சேமி|எவ்வளவு காலம்/i,
};

/** The loan the owner means: named in the text (any word of its name), else the one with the largest balance. */
function pickLoan(text, loans) {
    const t = String(text || '').toLowerCase();
    const named = loans.filter((l) => l && l.name && String(l.name).toLowerCase().split(/[^a-z0-9඀-෿஀-௿]+/).filter((w) => w.length >= 3 && !/^(?:loan|bank|the|and)$/.test(w)).some((w) => t.includes(w)));
    const pool = named.length ? named : loans;
    return pool.slice().sort((a, b) => num(b.balance) - num(a.balance))[0] || null;
}

/**
 * Read one line of the owner's talk as a scenario, or null.
 * Returns { kind, amount, perMonth, down, months, ratePct, percent, ... } with only what the line itself says; `merge()` fills the rest from earlier lines.
 */
export function readScenario(text) {
    const t = String(text == null ? '' : text);
    const nums = readNumbers(t);
    const amounts = nums.filter((n) => n.kind === 'amount');
    const sc = { text: clean(t, 200), amount: null, perMonth: null, down: null, months: null, ratePct: null, percent: null, kind: null };
    const big = amounts.filter((a) => !a.perMonth && !a.down).sort((a, b) => b.value - a.value)[0];
    const monthly = amounts.find((a) => a.perMonth);
    const down = amounts.find((a) => a.down);
    if (big) sc.amount = big.value;
    if (monthly) sc.perMonth = monthly.value;
    if (down) sc.down = down.value;
    const mo = nums.find((n) => n.kind === 'months'), yr = nums.find((n) => n.kind === 'years'), pc = nums.find((n) => n.kind === 'pct');
    if (mo) sc.months = Math.round(mo.value); else if (yr) sc.months = Math.round(yr.value * 12);
    if (pc) sc.percent = pc.value;

    if (W.lose.test(t)) sc.kind = 'income-loss';
    else if (W.extra.test(t) && W.loanWord.test(t)) sc.kind = 'extra-payment';
    else if (W.cut.test(t) && sc.percent !== null) sc.kind = 'spending-cut';
    else if (W.borrow.test(t) && (sc.amount || sc.months)) sc.kind = (W.strongBuy.test(t) || W.item.test(t)) && !/\bloan of|\bborrow|\btake (?:out )?a loan|ණයක් ගන්න|ණයක් ගත්තොත්|ණය ගන්න|கடன் வாங்க|கடன் எடு/i.test(t) ? 'purchase' : 'borrow';
    else if (W.buy.test(t) && sc.amount) sc.kind = 'purchase';
    else if (W.item.test(t) && sc.amount && (sc.months !== null || sc.percent !== null)) sc.kind = 'purchase';      // "2.5M car, 14% over 5 years"
    else if (W.save.test(t) && (sc.amount || sc.perMonth)) sc.kind = 'save';
    if (sc.kind === 'borrow' || sc.kind === 'purchase') { if (sc.percent !== null) sc.ratePct = sc.percent; if (sc.kind === 'purchase' && (W.borrow.test(t) || sc.months !== null || sc.percent !== null)) sc.financed = true; }
    if (sc.kind === 'borrow') sc.financed = true;
    return sc;
}

/**
 * Newest line first. A follow-up ("and over 36 months?") says only what changed, so it inherits the rest from the earlier line that named the
 * kind of decision — but only when the newest line contributes at least one figure of its own, so an unrelated later question does not drag an
 * old scenario along.
 */
export function merge(lines) {
    const list = (Array.isArray(lines) ? lines : [lines]).filter((x) => typeof x === 'string' && x.trim()).slice(-4);
    if (!list.length) return null;
    const read = list.map(readScenario);
    const last = read[read.length - 1];
    const own = ['amount', 'perMonth', 'down', 'months', 'ratePct', 'percent'].some((k) => last[k] !== null);
    if (last.kind) return last;
    if (!own) return null;
    for (let i = read.length - 2; i >= 0; i--) {
        if (!read[i].kind) continue;
        const base = read[i];
        const out = { ...base };
        for (const k of ['amount', 'perMonth', 'down', 'months', 'ratePct', 'percent']) if (last[k] !== null) out[k] = last[k];
        if (last.percent !== null && (base.kind === 'borrow' || base.kind === 'purchase')) out.ratePct = last.percent;
        out.text = clean(`${base.text} / ${last.text}`, 260);
        return out;
    }
    return null;
}

/* ── working it out ───────────────────────────────────────────────────────── */

const addMonths = (d, n) => { const x = new Date(d.getTime()); x.setMonth(x.getMonth() + n); return x; };
const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The day of the month the salary usually arrives: the most common day among the recent received rows, kept to 1-28 so it exists in every month. */
function payDay(rows) {
    const days = (Array.isArray(rows) ? rows : []).filter((r) => r && r.received !== false && /^\d{4}-\d{2}-\d{2}/.test(String(r.date || ''))).slice(-12).map((r) => Math.min(28, Number(String(r.date).slice(8, 10))));
    if (!days.length) return 28;
    const n = new Map();
    for (const d of days) n.set(d, (n.get(d) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

/**
 * The engine only counts income it has been told is coming (a dated receivable, an Investments-tab source). A salary known only as months already received is not in
 * its projection, so a before-and-after taken from it would be "if no salary ever arrives again" and every purchase would look ruinous. When the sheet says that is
 * the case, the typical income is added on the usual pay day to BOTH sides of the comparison, and the assumption is stated.
 */
function expectedIncome(f, deps, now) {
    const L = f.liquidity, T = f.typical;
    if (!L || L.runwayBasis !== 'outflows-only' || !T || !(T.income > 0)) return { items: [], note: '' };
    const day = payDay(deps && typeof deps.get === 'function' ? safe(() => deps.get('incomeRecv'), []) : []);
    const items = [];
    for (let k = 0; k <= Math.ceil(RULES.ENGINE_HORIZON / 28) + 1; k++) {
        const d = new Date(now.getFullYear(), now.getMonth() + k, day);
        if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate()) || d > new Date(now.getTime() + RULES.ENGINE_HORIZON * 86400000)) continue;
        items.push({ date: isoOf(d), kind: 'in', amount: T.income, label: 'Typical income (assumed)', source: 'advisor', certainty: 'expected' });
    }
    return { items, note: `the cash-flow engine does not project the salary by itself, so a typical income of LKR ${lkr(T.income)} is added on about day ${day} of each month, before and after` };
}

/** What the cash-flow engine says about the next months with and without a change; null when it cannot run. */
function engineView(deps, changes, f) {
    if (!deps || !deps.appData || typeof deps.appData !== 'object') return null;
    const now = isDate(deps.now) ? deps.now : new Date();
    const base = safe(() => (typeof deps.cashOpts === 'function' ? deps.cashOpts({ horizon: RULES.ENGINE_HORIZON }) : {}), {});
    const opts = Object.assign({}, base, { asOf: now, horizon: RULES.ENGINE_HORIZON });
    const inc = f ? expectedIncome(f, deps, now) : { items: [], note: '' };
    if (inc.items.length) opts.extraCommitments = (Array.isArray(base.extraCommitments) ? base.extraCommitments : []).concat(inc.items);
    const r = safe(() => whatIf(deps.appData, { changes }, opts), null);
    if (!r) return null;
    const d = r.delta;
    return {
        verdict: d.verdict, safety: r.safety,
        runwayBefore: d.runway.before, runwayAfter: d.runway.after,
        troughBefore: r0(d.tightest.before), troughAfter: r0(d.tightest.after), troughDate: d.tightest.dateAfter,
        rejected: r.rejected.length,
        incomeNote: inc.note,
    };
}
function engineLines(v) {
    if (!v) return [];
    const out = [`   Cash-flow engine, next ${RULES.ENGINE_HORIZON} days: lowest balance LKR ${lkr(v.troughBefore)} before, LKR ${lkr(v.troughAfter)} after${v.troughDate ? ` (on ${v.troughDate})` : ''}; ${v.runwayAfter ? `the balance would go below zero on ${v.runwayAfter}` : 'the balance would stay above zero'}${v.runwayBefore && !v.runwayAfter ? ' (it was heading below zero before)' : v.runwayBefore ? ` (before: ${v.runwayBefore})` : ''}; verdict ${v.safety}.`];
    if (v.incomeNote) out.push(`   (Assumption for that line: ${v.incomeNote}.)`);
    return out;
}

function ratioNote(dsr) {
    if (dsr === null) return '';
    return dsr >= RULES.DSR_HIGH ? ` (heavy: above ${RULES.DSR_HIGH}%)` : dsr >= RULES.DSR_WATCH ? ` (watch: above ${RULES.DSR_WATCH}%)` : ' (comfortable: under ' + RULES.DSR_WATCH + '%)';
}

/** The financing half of a purchase or a loan: the instalment, what it does to the debt ratio and to what is left each month. */
function financing(sc, f, deps, label) {
    const T = f.typical, L = f.liquidity, D = f.debt;
    const assumed = [];
    const principal = Math.max(0, num(sc.amount) - num(sc.down));
    let months = sc.months, rate = sc.ratePct;
    if (!months) { months = sc.amount >= RULES.LONG_TERM_FROM ? RULES.LONG_MONTHS : RULES.SHORT_MONTHS; assumed.push(`a term of ${months} months`); }
    if (rate === null || rate === undefined) { rate = RULES.DEFAULT_RATE_PCT; assumed.push(`an interest rate of ${rate}% a year (replace it with the lender's quote)`); }
    months = Math.max(1, Math.min(RULES.MAX_MONTHS, Math.floor(months)));
    const q = quote(principal, rate, months), hi = quote(principal, rate + RULES.RATE_SENSITIVITY, months);
    const lines = [`${label} Borrow LKR ${lkr(q.principal)}${sc.down ? ` (LKR ${lkr(sc.amount)} less LKR ${lkr(sc.down)} paid up front)` : ''} over ${q.months} months at ${q.ratePct}% a year: instalment LKR ${lkr(q.payment)} a month, LKR ${lkr(q.total)} paid in all, of which LKR ${lkr(q.interest)} is interest. At ${r1(rate + RULES.RATE_SENSITIVITY)}% the instalment would be LKR ${lkr(hi.payment)} and the interest LKR ${lkr(hi.interest)}.`];
    const sched = D ? num(D.monthlyService) : 0;
    const income = T ? num(T.income) : 0;
    const dsrAfter = income > 0 ? r1(((sched + q.payment) / income) * 100) : null;
    if (income > 0) lines.push(`   Debt payments would go from LKR ${lkr(sched)} to LKR ${lkr(sched + q.payment)} a month: ${pct(dsrBefore(sched, income))} -> ${pct(dsrAfter)} of a typical month's income${ratioNote(dsrAfter)}.`);
    let freeAfter = null;
    if (L && L.freeCashPerMonth !== null && L.freeCashPerMonth !== undefined) {
        freeAfter = L.freeCashPerMonth - q.payment;
        lines.push(`   What is left each month after living costs and debt payments would go from LKR ${lkr(L.freeCashPerMonth)} to LKR ${lkr(freeAfter)}${freeAfter < 0 ? ' (the month would end short)' : ''}.`);
    }
    const start = (deps && isDate(deps.now) ? deps.now : new Date());
    const first = addMonths(new Date(start.getFullYear(), start.getMonth(), 1), 1);
    const eng = engineView(deps, [{ type: CHANGE.RECURRING, kind: 'out', amount: q.payment, from: isoOf(first), day: 1, months: q.months, label: 'New loan instalment' }], f);
    lines.push(...engineLines(eng));
    let verdict;
    if (freeAfter !== null && freeAfter < 0) verdict = 'does not fit: after living costs and every debt payment the month would end short';
    else if (dsrAfter !== null && dsrAfter >= RULES.DSR_HIGH) verdict = `does not fit comfortably: the debt payments would take ${pct(dsrAfter)} of income`;
    else if ((dsrAfter !== null && dsrAfter >= RULES.DSR_WATCH) || (eng && eng.safety === 'riskier')) verdict = 'fits, but tight';
    else verdict = 'fits';
    return { lines, assumed, verdict, payment: q.payment, dsrAfter, freeAfter };
}
function dsrBefore(sched, income) { return income > 0 ? r1((sched / income) * 100) : 0; }

/** Paying cash for a purchase from the Balance page. */
function cashRoute(sc, f, deps, label) {
    const L = f.liquidity, T = f.typical;
    const lines = [];
    const need = num(sc.amount) - num(sc.down);
    let verdict = 'unknown';
    if (L && L.onHand !== null && L.onHand !== undefined) {
        const after = L.onHand - need;
        const cover = T && T.outflow > 0 ? r1(after / T.outflow) : null;
        const cushion = T ? T.outflow * RULES.COVER_MONTHS : null;
        lines.push(`${label} Pay LKR ${lkr(need)} from the Balance page (LKR ${lkr(L.onHand)} on hand): ${after >= 0 ? `LKR ${lkr(after)} would be left${cover !== null ? `, which covers ${cover} months of a typical outflow` : ''}${cushion !== null && after < cushion ? `; a ${RULES.COVER_MONTHS}-month cushion would be LKR ${lkr(cushion)}, so it would be LKR ${lkr(cushion - after)} short of that` : ''}` : `it is LKR ${lkr(-after)} more than is there`}.`);
        const eng = after >= 0 ? engineView(deps, [{ type: CHANGE.ONE_OFF, kind: 'out', amount: need, date: isoOf(deps && isDate(deps.now) ? deps.now : new Date()), label: 'Purchase' }], f) : null;
        lines.push(...engineLines(eng));
        verdict = after < 0 ? 'cannot be paid in cash' : (cushion !== null && after < cushion) || (eng && eng.safety === 'riskier') ? 'can be paid in cash but leaves the cushion thin' : 'can be paid in cash and keeps the cushion';
    } else lines.push(`${label} Pay LKR ${lkr(need)} in cash: the Balance page has no recorded balance, so what would be left is not known.`);
    return { lines, verdict };
}

/** How long it takes to save an amount at what is left each month. */
function saveRoute(amount, perMonth, f, label) {
    const L = f.liquidity, T = f.typical;
    const lines = [];
    const rate = perMonth || (L && L.freeCashPerMonth > 0 ? L.freeCashPerMonth : 0);
    const src = perMonth ? 'at the LKR ' + lkr(perMonth) + ' a month the owner named' : `at what is left each month (LKR ${lkr(L ? L.freeCashPerMonth : 0)})`;
    if (rate > 0) {
        const n = Math.ceil(amount / rate);
        lines.push(`${label} Saving LKR ${lkr(amount)} ${src} takes ${n} months (${ymOf(addMonths(new Date(f.asOf + 'T00:00:00'), n))}); nothing else is counted, not even the Balance page.`);
    } else lines.push(`${label} Saving LKR ${lkr(amount)} ${src}: nothing is left to save each month, so it would never be reached from monthly income alone.`);
    if (L && L.onHand !== null && L.onHand !== undefined && T) {
        const spare = Math.max(0, L.onHand - T.outflow * RULES.COVER_MONTHS);
        lines.push(`   The Balance page holds LKR ${lkr(L.onHand)}; above a ${RULES.COVER_MONTHS}-month cushion (LKR ${lkr(T.outflow * RULES.COVER_MONTHS)}) that is LKR ${lkr(spare)} that could go towards it.`);
    }
    const target = Math.ceil(amount / 12);
    if (L && L.freeCashPerMonth !== null && L.freeCashPerMonth !== undefined) lines.push(`   To do it in 12 months LKR ${lkr(target)} a month is needed${L.freeCashPerMonth < target ? `, which is LKR ${lkr(target - L.freeCashPerMonth)} more than is left each month now` : ', which fits in what is left each month'}.`);
    return { lines, months: rate > 0 ? Math.ceil(amount / rate) : null };
}

function extraPayment(sc, f, deps) {
    const loans = safe(() => (f.debt.loans || []).map((l) => ({ ...l })), []);
    const lines = [];
    const raw = deps && typeof deps.get === 'function' ? safe(() => deps.get('loans'), []) : [];
    const pick = pickLoan(sc.text, loans);
    if (!pick) return { lines: ['No active loan is recorded, so there is nothing to pay down.'], verdict: 'no-loan' };
    const rawLoan = raw.find((l) => l && l.name && clean(l.name, 40) === pick.name) || null;
    if (!rawLoan) return { lines: [`Loan "${pick.name}": its terms could not be read, so the effect of an extra payment is not known.`], verdict: 'unknown' };
    const plan = amortizeProject(rawLoan);
    if (!plan.ok) return { lines: [`Loan "${pick.name}": ${plan.reason === 'payment-below-interest' ? 'the instalment is smaller than the interest, so the balance grows and no payoff date exists' : 'the loan cannot be projected from its terms'}.`], verdict: 'unknown' };
    /* The walk starts from the balance the Loans page shows (the same figure as the fact sheet) and pays the loan's own scheduled instalment each month, with the extra on top;
     * "as it is" is the same walk with no extra, so the two are compared like with like. The amortiser supplies the first month still to pay and the schedule's own count of payments
     * left, which is shown when the two differ (they do when instalments are missing from the records). */
    const asOfYm = String(f.asOf || '').slice(0, 7);
    const next = plan.rows.find((r) => !r.recorded && r.month >= asOfYm);
    const startMonth = next ? next.month : asOfYm;
    const bal = Number.isFinite(pick.balance) && pick.balance > 0 ? pick.balance : (next ? next.opening : 0);
    if (!(bal > 0)) return { lines: [`Loan "${pick.name}": nothing is owing on it.`], verdict: 'no-loan' };
    const rate = num(rawLoan.rate), i = monthlyRate(rawLoan);
    const walk = (extraEach, lump) => {
        let b = Math.max(0, bal - lump), months = 0, interest = 0;
        while (b > 0.005 && months < 1200) {
            const cost = b * i;
            const pay = scheduledPayment(rawLoan, b) + extraEach;
            if (pay <= cost + 0.005) return null;
            interest += cost; b = b + cost - Math.min(pay, b + cost); months++;
        }
        return b > 0.005 ? null : { months, interest };
    };
    const base = walk(0, 0);
    if (!base) return { lines: [`Loan "${pick.name}": at the instalment it is set to, the balance does not clear, so a payoff date cannot be worked out.`], verdict: 'unknown' };
    const extraEach = sc.perMonth || 0;
    // no figure at all ("settle the loan", "pay it off") means paying the whole balance now
    const lump = !sc.perMonth && sc.amount ? Math.min(sc.amount, bal) : (!sc.perMonth ? bal : 0);
    const withExtra = walk(extraEach, lump);
    if (!withExtra) return { lines: [`Loan "${pick.name}": with that payment the balance still cannot be cleared, so a payoff date cannot be worked out.`], verdict: 'unknown' };
    const [oy, om] = startMonth.split('-').map(Number);
    const monthAt = (n) => ymOf(new Date(oy, om - 1 + Math.max(0, n - 1), 1));
    lines.push(`Loan "${pick.name}": LKR ${lkr(bal)} owing now (the balance on the Loans page), at ${rate}% a year, instalment about LKR ${lkr(scheduledPayment(rawLoan, bal))} a month. As it is, ${base.months} payments remain (the last in ${monthAt(base.months)}) with LKR ${lkr(base.interest)} of interest still to pay.`);
    if (Math.abs(base.months - plan.monthsRemaining) > 1) lines.push(`   (The loan's own schedule counts ${plan.monthsRemaining} payments left; the figures here start from the balance owing now, so they differ when instalments are missing from the records.)`);
    lines.push(`   ${lump ? `Paying LKR ${lkr(lump)} once now` : `Paying LKR ${lkr(extraEach)} extra every month`}: ${withExtra.months} payments${withExtra.months ? ` (the last in ${monthAt(withExtra.months)})` : ' (the loan is cleared)'}, LKR ${lkr(withExtra.interest)} of interest. That is ${Math.max(0, base.months - withExtra.months)} months sooner and LKR ${lkr(Math.max(0, r0(base.interest) - r0(withExtra.interest)))} less interest.`);
    const L = f.liquidity;
    let verdict = 'fits';
    if (extraEach && L && L.freeCashPerMonth !== null && L.freeCashPerMonth !== undefined) {
        lines.push(`   What is left each month now is LKR ${lkr(L.freeCashPerMonth)}; after the extra LKR ${lkr(extraEach)} it would be LKR ${lkr(L.freeCashPerMonth - extraEach)}${L.freeCashPerMonth - extraEach < 0 ? ' (the month would end short)' : ''}.`);
        if (L.freeCashPerMonth - extraEach < 0) verdict = 'does not fit in what is left each month';
    }
    if (lump && L && L.onHand !== null && L.onHand !== undefined) {
        const left = L.onHand - lump, cushion = f.typical ? f.typical.outflow * RULES.COVER_MONTHS : null;
        lines.push(`   The Balance page holds LKR ${lkr(L.onHand)}; ${left < 0 ? `the lump sum is LKR ${lkr(-left)} more than is there` : `after the lump sum LKR ${lkr(left)} would be left${cushion !== null && left < cushion ? `, below a ${RULES.COVER_MONTHS}-month cushion (LKR ${lkr(cushion)})` : ''}`}.`);
        if (left < 0) verdict = 'cannot be paid from the Balance page';
        else if (cushion !== null && left < cushion) verdict = 'can be paid but leaves the cushion thin';
    }
    return { lines, verdict, assumed: [] };
}

function incomeLoss(sc, f) {
    const T = f.typical, L = f.liquidity;
    if (!T || !(T.income > 0) || !L || L.onHand === null || L.onHand === undefined) return { lines: ['The typical income or the Balance page is not recorded, so how long the money would last cannot be worked out.'], verdict: 'unknown', assumed: [] };
    const assumed = [];
    let q = sc.percent;
    if (q === null || q === undefined) { q = 100; assumed.push('the income stops completely (no percentage was given)'); }
    q = Math.max(0, Math.min(100, q));
    const income = T.income * (1 - q / 100);
    const burn = T.outflow - income;
    const lines = [`If income falls by ${pct(q)}, a typical month brings LKR ${lkr(income)} against LKR ${lkr(T.outflow)} going out (the same typical month as the sheet).`];
    let verdict;
    if (burn <= 0) { lines.push('   Income would still cover everything that goes out.'); verdict = 'income still covers outflow'; }
    else {
        const months = L.onHand / burn;
        lines.push(`   The month would end LKR ${lkr(burn)} short; the Balance page (LKR ${lkr(L.onHand)}) would last about ${r1(Math.max(0, months))} months at that rate${months < 3 ? ', less than a 3-month cushion' : ''}.`);
        verdict = months < 3 ? 'under three months of cover' : 'three months or more of cover';
    }
    return { lines, verdict, assumed };
}

function spendingCut(sc, f) {
    const q = Math.max(0, Math.min(100, num(sc.percent)));
    const text = String(sc.text || '').toLowerCase();
    const cat = (f.categories || []).find((c) => c && c.name && text.includes(String(c.name).toLowerCase().split(/\s*&\s*|\s+/)[0]) && String(c.name).length >= 3);
    const T = f.typical, L = f.liquidity;
    const assumed = [];
    let base, what;
    if (cat) { base = cat.avg3 !== null && cat.avg3 !== undefined ? cat.avg3 : cat.thisMonth; what = `${cat.name} (about LKR ${lkr(base)} a month)`; }
    else if (T && T.living !== null && T.living !== undefined) { base = T.living; what = `all living costs (LKR ${lkr(base)} a month, debt payments apart)`; assumed.push('no category was named, so the cut applies to all living costs'); }
    else return { lines: ['No spending history is recorded, so the effect of a cut cannot be worked out.'], verdict: 'unknown', assumed };
    const save = base * (q / 100);
    const lines = [`Cutting ${what} by ${pct(q)} frees LKR ${lkr(save)} a month, LKR ${lkr(save * 12)} a year.`];
    if (L && L.freeCashPerMonth !== null && L.freeCashPerMonth !== undefined) lines.push(`   What is left each month would go from LKR ${lkr(L.freeCashPerMonth)} to LKR ${lkr(L.freeCashPerMonth + save)}.`);
    return { lines, verdict: 'worked-out', assumed };
}

/**
 * Work a scenario out. `f` is the fact sheet's structure (build()), `deps` the same dependencies (appData, get, cashOpts, now).
 * Returns { ok, kind, text } where text is the block the model is given.
 */
export function work(sc, f, deps) {
    if (!sc || !sc.kind || !f || f.ok === false) return { ok: false, kind: sc && sc.kind || null, text: '' };
    if ((sc.kind === 'borrow' || sc.kind === 'purchase') && !(sc.amount > 0)) return { ok: false, kind: sc.kind, text: '' };
    if (sc.kind === 'spending-cut' && !(sc.percent > 0)) return { ok: false, kind: sc.kind, text: '' };
    const parts = [];
    let assumed = [], verdicts = [], understood;
    if (sc.kind === 'purchase') {
        understood = `buy something that costs LKR ${lkr(sc.amount)}${sc.down ? ` with LKR ${lkr(sc.down)} up front` : ''}`;
        const A = cashRoute(sc, f, deps, 'A.');
        parts.push(...A.lines); verdicts.push(`cash: ${A.verdict}`);
        const B = financing({ ...sc, financed: true }, f, deps, 'B.');
        parts.push(...B.lines); assumed.push(...B.assumed); verdicts.push(`financed: ${B.verdict}`);
        const C = saveRoute(Math.max(0, num(sc.amount) - num(sc.down)), null, f, 'C. Wait and save.');
        parts.push(...C.lines);
    } else if (sc.kind === 'borrow') {
        understood = `borrow LKR ${lkr(sc.amount)}${sc.months ? ` over ${sc.months} months` : ''}${sc.ratePct !== null ? ` at ${sc.ratePct}%` : ''}`;
        const B = financing(sc, f, deps, 'Loan.');
        parts.push(...B.lines); assumed.push(...B.assumed); verdicts.push(`loan: ${B.verdict}`);
    } else if (sc.kind === 'extra-payment') {
        const E = extraPayment(sc, f, deps);
        understood = sc.perMonth ? `pay LKR ${lkr(sc.perMonth)} extra a month on a loan` : sc.amount ? `pay LKR ${lkr(sc.amount)} off a loan now` : 'settle a loan in full now';
        parts.push(...E.lines); verdicts.push(`extra payment: ${E.verdict}`);
    } else if (sc.kind === 'save') {
        understood = `save LKR ${lkr(sc.amount || 0)}${sc.perMonth ? ` at LKR ${lkr(sc.perMonth)} a month` : ''}`;
        if (!(sc.amount > 0)) return { ok: false, kind: sc.kind, text: '' };
        const S = saveRoute(sc.amount, sc.perMonth, f, 'Answer.');
        parts.push(...S.lines);
    } else if (sc.kind === 'income-loss') {
        const I = incomeLoss(sc, f);
        understood = 'income falls or stops';
        parts.push(...I.lines); assumed.push(...I.assumed); verdicts.push(`income loss: ${I.verdict}`);
    } else if (sc.kind === 'spending-cut') {
        const S = spendingCut(sc, f);
        understood = `cut spending by ${pct(sc.percent)}`;
        parts.push(...S.lines); assumed.push(...S.assumed);
    } else return { ok: false, kind: sc.kind, text: '' };

    const head = ['=== WHAT-IF, WORKED OUT BY WEALTHFLOW (arithmetic done by code from the books above: copy these figures, do not recompute them) ==='];
    head.push(`Question understood as: ${understood}. If that is not what the owner meant, say what you assumed.`);
    if (assumed.length) head.push(`ASSUMED because the owner did not say: ${assumed.join('; ')}. Say so, and say it can be replaced.`);
    const text = [...head, ...parts, ...(verdicts.length ? [`Verdict by the rules (${RULES.DSR_WATCH}% / ${RULES.DSR_HIGH}% debt ratio, ${RULES.COVER_MONTHS}-month cushion, no month ending short): ${verdicts.join('; ')}.`] : []), '=== END OF WHAT-IF ==='].join('\n');
    return { ok: true, kind: sc.kind, text, understood, assumed, verdicts };
}

/** One call from the page: the owner's recent lines in, a block of text (or '') out. Never throws. */
export function currentBlock(w = globalThis, lines = []) {
    try {
        const sc = merge(lines);
        if (!sc) return '';
        const sheet = currentSheet(w);
        if (!sheet.facts || !sheet.facts.ok) return '';
        const deps = pageDeps(w);
        const r = work(sc, sheet.facts, deps);
        return r.ok ? r.text : '';
    } catch (_) { return ''; }
}

const API = { SCENARIO_VERSION, RULES, emi, quote, payDown, readNumbers, readScenario, merge, work, currentBlock };
if (typeof window !== 'undefined') window.WFAdvisorScenarios = API;
export default API;
