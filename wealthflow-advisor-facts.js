/* =============================================================================
 * wealthflow-advisor-facts.js — what the AI Advisor is told about the owner's money
 * -----------------------------------------------------------------------------
 * THE FLAW THIS REMOVES
 *
 * The Advisor used to be the app's THIRD, DIVERGENT account of the owner's
 * money. buildFinancialContext() worked the figures out again, with its own
 * rules, while the screens already had one authority each:
 *
 *   income         the Monthly Plan counts what ARRIVED in the month (incomeRecv),
 *                  and deliberately leaves the Investments store out because that
 *                  money lands in the bank too (getMonthlyData, v7.36.0).
 *                  The Advisor added up the Investments store and called it
 *                  "Monthly Income": LKR 18,000 beside a salary of LKR 285,000.
 *   outflow        the Monthly Plan adds loans + card instalments + expenses
 *                  (recurring ones carried forward) + card one-offs + subscriptions
 *                  + cheques. The Advisor summed expense rows dated this month.
 *   categories     expense rows keep their category in `cat`. The Advisor read
 *                  `category`, so the owner's "Top Expenses" was "undefined: LKR 170,500".
 *   balance        the Balance page shows total − outflows + inflows. The Advisor
 *                  read `total` alone.
 *
 * Simulated on a household with a LKR 285,000 salary, the Advisor said the
 * owner was LKR 214,500 a month short; the Monthly Plan said LKR 25,700. An
 * advisor that disagrees with the dashboard is not believed, and when it is, it
 * advises from a different life.
 *
 * THE RULE THAT REPLACES IT
 *
 * This module does not work money out. It ASKS THE SCREENS' OWN ENGINES —
 * getMonthlyData() for every month, openingBalance()/summarise()/project() from
 * the cash-flow engine, project() from the amortiser, WFInsights.brief() for the
 * dashboard's own "needs your attention" — and arranges what they said into one
 * fact sheet. Where it adds anything (averages, a trend, a category's change, a
 * debt-service ratio) the arithmetic is here, in code, tested, and the model is
 * told to copy it, never to redo it.
 *
 * Pure: every input arrives through `deps`, nothing reads the clock, nothing is
 * written. test/advisor_facts_test.js runs it against the REAL getMonthlyData
 * lifted out of index.html, so the two cannot drift apart unnoticed.
 * ===========================================================================*/

import { openingBalance, summarise as cashSummary, project as cashProject } from './wealthflow-cashflow-engine.js';
import { project as amortizeProject } from './wealthflow-amortize.js';

export const FACTS_VERSION = 1;

/* ── thresholds. Rules of thumb, named here so a reviewer can argue with the number, not the code ── */
export const RULES = {
    TYPICAL_MONTHS: 3,            // "a typical month" = the mean of up to this many complete months that have income
    TREND_MONTHS: 6,              // the window the trend is read over …
    TREND_MIN_MONTHS: 4,          // … and the fewest points a trend is claimed from
    DSR_WATCH: 30,                // debt service as % of income: worth a look
    DSR_HIGH: 40,                 // … heavy; the usual ceiling lenders in Sri Lanka work to is 40-50%
    SAVINGS_LOW: 10,              // % of income saved: thin
    COVER_CRITICAL: 1,            // months of typical outflow the balance covers
    COVER_LOW: 3,
    SPIKE_RATIO: 1.3,             // a category this far above its own average …
    SPIKE_MIN_LKR: 5000,          // … by at least this much (and 3% of a typical month) is a spike
    SPIKE_MIN_SHARE: 0.03,
    MAX_CATEGORIES: 8,
    MAX_MONTHS: 12,
};

/* ── small, boring helpers ────────────────────────────────────────────────── */
const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
};
const p2 = (n) => String(n).padStart(2, '0');
const r0 = (n) => Math.round(num(n));
const r1 = (n) => Math.round(num(n) * 10) / 10;
const arr = (v) => (Array.isArray(v) ? v : []);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const ymOfDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
const isYm = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const ymFrom = (v) => { const s = String(v == null ? '' : v).slice(0, 7); return isYm(s) ? s : ''; };
const ymIndex = (ym) => Number(ym.slice(0, 4)) * 12 + (Number(ym.slice(5, 7)) - 1);
const ymAt = (index) => `${Math.floor(index / 12)}-${p2((index % 12) + 1)}`;
const daysIn = (y, m0) => new Date(y, m0 + 1, 0).getDate();
const isoLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const safe = (fn, fallback) => { try { const v = fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; } };
/* A name from the books is data. Control characters, runs of "=" (the sheet's own delimiter) and a double quote (which closes the quotes a name sits in) are
 * neutralised, and the name is cut, so nothing typed into a loan or category name can pose as part of the sheet's structure. */
const clean = (s, n = 80) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/={2,}/g, '-').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, n);

/** Least-squares slope of ys over 0..n-1. */
function slope(ys) {
    const n = ys.length;
    if (n < 2) return 0;
    const mx = (n - 1) / 2, my = mean(ys);
    let sxy = 0, sxx = 0;
    ys.forEach((y, x) => { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); });
    return sxx ? sxy / sxx : 0;
}

/** 285000 → "285,000"; -25700 → "-25,700". Whole rupees: cents are noise on a personal ledger. */
export function lkr(n) {
    const v = r0(n);
    return (v < 0 ? '-' : '') + Math.abs(v).toLocaleString('en-US');
}
const pct = (n) => `${r1(n)}%`;

/* ── the builder ──────────────────────────────────────────────────────────── */

/**
 * @param {object} deps
 * @param {Date}     deps.now
 * @param {object}   deps.appData                          the store the cash-flow engine reads
 * @param {(key:string)=>any[]} deps.get                   DB.get
 * @param {(y:number,m0:number)=>object} deps.monthly      getMonthlyData — the screens' own month
 * @param {(loan:object)=>number} [deps.loanBalance]       loanCurrentBalance
 * @param {(loan:object)=>Date}   [deps.loanEnd]           loanEndDate
 * @param {(extra?:object)=>object} [deps.cashOpts]        _wfCashOpts (adds the sweep ledger's legs)
 * @param {{brief:(n:number)=>object[]}} [deps.insights]   WFInsights
 * @param {object} [deps.profile]    _wfBooksProfile(now): the typical month DSCR, the Score and the Debt Demolisher all start from
 * @param {object} [deps.position]   _wfPosition(now): cash, loan balances, card plans, card charges owed, scheduled instalments
 * @param {number} [deps.freeCash]   _wfFreeCash(profile, position): what is left each month after living costs and the debt the loans ask
 * @returns {object} facts — see the shape in renderFactSheet()
 */
export function build(deps) {
    const d = deps || {};
    const now = isDate(d.now) ? d.now : new Date();
    const get = (key) => safe(() => arr(d.get(key)), []);
    const appData = d.appData && typeof d.appData === 'object' ? d.appData : {};
    if (typeof d.monthly !== 'function') return { version: FACTS_VERSION, ok: false, reason: 'no-monthly-engine', asOf: isoLocal(now), currency: 'LKR', quality: ['The Monthly Plan engine was not available, so no figures could be computed.'] };

    const year = now.getFullYear(), m0 = now.getMonth();
    const ym = ymOfDate(now);
    const dayOfMonth = now.getDate();
    const quality = [];

    /* ── 1. where the owner's records begin. Months before that are not "zero income", they are "not kept". ── */
    const seen = [];
    for (const r of get('incomeRecv')) seen.push(ymFrom(r && (r.month || r.date)));
    for (const r of get('expenses')) seen.push(ymFrom(r && (r.month || r.date)));
    for (const r of get('cconetime')) seen.push(ymFrom(r && r.date));
    const first = seen.filter(Boolean).sort()[0] || '';
    const lowest = ymAt(ymIndex(ym) - (RULES.MAX_MONTHS - 1));
    const startIdx = first && first <= ym ? ymIndex(first > lowest ? first : lowest) : ymIndex(ym);   // this month is always read

    /* ── 2. every month, from the screens' own function ── */
    const months = [];
    for (let i = startIdx; i <= ymIndex(ym); i++) {
        const key = ymAt(i);
        const y = Math.floor(i / 12), m = i % 12;
        const md = safe(() => d.monthly(y, m), null);
        if (!md || typeof md !== 'object') { quality.push(`${key} could not be read.`); continue; }
        const income = num(md.income), outflow = num(md.totalExp);
        months.push({
            ym: key, current: key === ym,
            income: r0(income), incomePending: r0(md.incomePending),
            outflow: r0(outflow),
            loans: r0(md.loanTotal), cardInstalments: r0(md.ccTotal), expenses: r0(md.expTotal),
            cardOneOff: r0(md.ccotTotal), subscriptions: r0(md.subTotal), cheques: r0(md.cheTotal),
            debtService: r0(Number.isFinite(md.debtService) ? md.debtService : num(md.loanTotal) + num(md.ccTotal)),
            loanUnpaid: r0(md.loanUnpaid),
            net: r0(income) - r0(outflow),
            savingsRatePct: income > 0 ? r1(((income - outflow) / income) * 100) : null,
            // every line that has a category, the same four lists the books profile averages categories over
            items: [].concat(arr(md.expItems), arr(md.ccotItems), arr(md.subItems), arr(md.cheItems)),
        });
    }
    const complete = months.filter((m) => !m.current);
    const thisRow = months.find((m) => m.current) || null;

    /* ── 3. a typical month. ONE definition, the books profile the DSCR, the WealthFlow Score and the Debt Demolisher start from (twelve complete
     *      months, income averaged over the months that have income, outgoings over the months that have spending), so the Advisor can never quote
     *      a different "typical" from the screen beside it. Without that profile (a page that did not provide it) the last three complete months
     *      that have income are used, and the sheet says which it is. `recent` is always the last three, kept apart so a change shows. ── */
    const meanOf = (rows, pick) => mean(rows.map(pick));
    const recentOf = (n) => {
        const rows = complete.filter((r) => r.income > 0).slice(-n);
        if (!rows.length) return null;
        const income = meanOf(rows, (r) => r.income), outflow = meanOf(rows, (r) => r.outflow);
        const saved = rows.reduce((s, r) => s + (r.income - r.outflow), 0), earned = rows.reduce((s, r) => s + r.income, 0);
        return { months: rows.length, from: rows[0].ym, to: rows[rows.length - 1].ym, income: r0(income), outflow: r0(outflow), net: r0(income) - r0(outflow), savingsRatePct: earned > 0 ? r1((saved / earned) * 100) : null };
    };
    const recent = recentOf(RULES.TYPICAL_MONTHS);
    const prof = d.profile && d.profile.basis && d.profile.basis.kind !== 'none' && Number.isFinite(d.profile.avgIncome) ? d.profile : null;
    let typical;
    if (prof) {
        const b = prof.basis, income = num(prof.avgIncome), outflow = num(prof.avgOutgo);
        typical = {
            source: 'books-profile', basis: b.kind, months: Math.max(num(b.incomeMonths), num(b.outgoMonths)), incomeMonths: num(b.incomeMonths), outgoMonths: num(b.outgoMonths),
            from: b.from || '', to: b.to || '', income: r0(income), outflow: r0(outflow), living: r0(prof.avgLiving), debtService: r0(prof.avgDebtService),
            net: r0(income) - r0(outflow), savingsRatePct: income > 0 ? r1(((income - outflow) / income) * 100) : null,
        };
        if (b.kind === 'this-month') quality.push('There is no complete month in the books yet, so the "typical month" is this month so far; it will be wrong until a month closes.');
    } else if (recent) {
        typical = Object.assign({ source: 'recent-months', basis: 'average', incomeMonths: recent.months, outgoMonths: recent.months, living: null, debtService: null }, recent);
    } else typical = null;
    const gaps = complete.filter((r) => r.income <= 0 && r.outflow > 0).map((r) => r.ym);
    if (gaps.length) quality.push(`No income is recorded for ${gaps.slice(-4).join(', ')}${gaps.length > 4 ? ' (and earlier)' : ''}; those months are left out of the income averages.`);
    if (!first) quality.push('There are no income or expense records yet, so there is no history to reason from.');
    else if (!complete.length) quality.push('Only the current month has records so far, so there is no earlier month to compare it with.');

    /* ── 4. the trend, only when there are enough months to mean it ── */
    let trend = null;
    const trendRows = complete.filter((r) => r.income > 0).slice(-RULES.TREND_MONTHS);
    if (trendRows.length >= RULES.TREND_MIN_MONTHS) {
        const mo = mean(trendRows.map((r) => r.outflow)), mi = mean(trendRows.map((r) => r.income));
        trend = {
            months: trendRows.length,
            outflowPctPerMonth: mo > 0 ? r1((slope(trendRows.map((r) => r.outflow)) / mo) * 100) : null,
            incomePctPerMonth: mi > 0 ? r1((slope(trendRows.map((r) => r.income)) / mi) * 100) : null,
        };
    }

    /* ── 5. this month so far ── */
    const thisMonth = thisRow ? {
        ym, daysLeft: daysIn(year, m0) - dayOfMonth, income: thisRow.income, incomePending: thisRow.incomePending, outflow: thisRow.outflow, expenses: thisRow.expenses, net: thisRow.net,
        incomeVsTypical: typical ? thisRow.income - typical.income : null,
        outflowVsTypical: typical ? thisRow.outflow - typical.outflow : null,
    } : null;
    if (thisRow && typical && thisRow.income <= 0 && typical.income > 0) quality.push(`No income has been recorded as received for ${ym} yet (a typical month brings ${lkr(typical.income)}).`);
    if (thisRow && thisRow.incomePending > 0) quality.push(`${lkr(thisRow.incomePending)} of ${ym} income is imported but not yet confirmed as received, so it is not counted.`);

    /* ── 6. where the expenses go: this month against the same category's average over the last complete months ── */
    const categories = [];
    if (thisRow) {
        const back = complete.slice(-3);
        const tally = (row) => { const t = new Map(); for (const it of arr(row && row.items)) { const k = clean(it && it.cat, 40) || 'Uncategorised'; t.set(k, (t.get(k) || 0) + num(it && it.amount)); } return t; };
        const now1 = tally(thisRow), past = back.map(tally);
        const catTotal = [...now1.values()].reduce((a, b) => a + b, 0);
        const names = new Set([...now1.keys(), ...past.flatMap((t) => [...t.keys()])]);
        const floor = Math.max(RULES.SPIKE_MIN_LKR, (typical ? typical.outflow : thisRow.outflow) * RULES.SPIKE_MIN_SHARE);
        for (const name of names) {
            const cur = now1.get(name) || 0;
            const avg = past.length ? mean(past.map((t) => t.get(name) || 0)) : null;
            const spike = avg !== null && avg > 0 && cur >= avg * RULES.SPIKE_RATIO && cur - avg >= floor;
            categories.push({ name, thisMonth: r0(cur), avg3: avg === null ? null : r0(avg), changePct: avg && avg > 0 ? r1(((cur - avg) / avg) * 100) : null, share: catTotal > 0 ? r1((cur / catTotal) * 100) : null, spike });
        }
        categories.sort((a, b) => Math.max(b.thisMonth, b.avg3 || 0) - Math.max(a.thisMonth, a.avg3 || 0));
        categories.length = Math.min(categories.length, RULES.MAX_CATEGORIES);
    }

    /* ── 7. debt ── */
    const loanEnd = typeof d.loanEnd === 'function' ? d.loanEnd : null;
    const loanBal = typeof d.loanBalance === 'function' ? d.loanBalance : null;
    const loans = [];
    for (const l of get('loans')) {
        if (!l || !l.start) continue;
        const end = loanEnd ? safe(() => loanEnd(l), null) : null;
        if (!isDate(end) || !(end.getTime() > now.getTime())) continue;       // the Monthly Plan's own test of "still running"
        const bal = loanBal ? safe(() => loanBal(l), null) : null;
        const plan = safe(() => amortizeProject(l), null);
        loans.push({
            name: clean(l.name, 40) || 'Loan', bank: clean(l.bank, 30), monthly: r0(l.monthly), ratePct: r1(l.rate),
            balance: bal === null ? null : r0(bal), endsOn: ymFrom(isoLocal(end)),
            paymentsLeft: plan && plan.ok ? plan.monthsRemaining : null,
            interestLeft: plan && plan.ok ? r0(plan.interestRemaining) : null,
            problem: plan && !plan.ok ? plan.reason : '',
        });
    }
    const cardPlans = get('ccinstall').filter((c) => c && !c.completed && c.date).map((c) => {
        const start = new Date(`${String(c.date).slice(0, 10)}T00:00:00`);
        const end = new Date(start); end.setMonth(end.getMonth() + num(c.duration));
        const left = Math.max(0, (end.getFullYear() - year) * 12 + (end.getMonth() - m0));
        return { product: clean(c.product, 40) || 'Card instalment', bank: clean(c.bank, 30), monthly: r0(c.monthly), monthsLeft: left };
    }).filter((c) => c.monthsLeft > 0);
    const unpaidCharges = get('cconetime').filter((c) => c && !c.paid);
    const pos = d.position && typeof d.position === 'object' ? d.position : null;
    const cardOwed = pos && Number.isFinite(pos.cardOwed) ? pos.cardOwed : unpaidCharges.reduce((s, c) => s + num(c.combinedTotal != null ? c.combinedTotal : num(c.amount) + num(c.serviceFee)), 0);
    /* what the loans and card plans ASK each month (the schedule), which is what a lender's debt-service ratio divides by income; what was PAID this month
     * can be less (an instalment not yet marked paid) and is the month row's own figure */
    const scheduled = pos && Number.isFinite(pos.minimums) ? pos.minimums : (thisRow ? thisRow.debtService : 0);
    const debt = {
        loans, cardPlans,
        cardOwed: r0(cardOwed), cardOwedCount: unpaidCharges.length,
        loanBalanceTotal: loans.every((l) => l.balance !== null) ? loans.reduce((s, l) => s + l.balance, 0) : null,
        planLeft: pos && Number.isFinite(pos.planLeft) ? r0(pos.planLeft) : null,
        monthlyService: r0(scheduled),
        paidThisMonth: thisRow ? thisRow.debtService : 0,
        unpaidThisMonth: thisRow ? thisRow.loanUnpaid : 0,
        dsrPct: typical && typical.income > 0 ? r1((scheduled / typical.income) * 100) : null,
    };
    if (debt.unpaidThisMonth > 0) quality.push(`${lkr(debt.unpaidThisMonth)} of loan instalments scheduled for ${ym} are not marked paid, so this month's outflow does not include them yet.`);

    /* ── 8. cash on hand and what is committed ── */
    const onHand = pos && Number.isFinite(pos.cash) ? pos.cash : safe(() => openingBalance(appData), null);
    const cashOpts = (extra) => safe(() => (typeof d.cashOpts === 'function' ? d.cashOpts(extra) : Object.assign({ asOf: now }, extra)), Object.assign({ asOf: now }, extra));
    const runway = safe(() => cashSummary(appData, cashOpts({ horizon: 90 })), null);
    const ahead = safe(() => cashProject(appData, cashOpts({ horizon: 30 })), null);
    const upcoming = ahead ? arr(ahead.commitments).filter((c) => c.kind === 'out').slice(0, 8).map((c) => ({ date: c.date, label: clean(c.label, 60), amount: r0(c.amount), certainty: c.certainty })) : [];
    const liquidity = {
        onHand: onHand === null ? null : r0(onHand),
        monthsOfCover: onHand !== null && typical && typical.outflow > 0 ? r1(onHand / typical.outflow) : null,
        cushion3: typical ? typical.outflow * 3 : null,
        cushionGap: onHand !== null && typical ? Math.max(0, r0(typical.outflow * 3 - onHand)) : null,
        runwayStatus: runway ? runway.status : null,
        runwayDays: runway ? runway.runwayDays : null,
        runwayDate: runway ? runway.runwayDate : null,
        safeToSpend: runway ? r0(runway.safeToSpend) : null,
        safeUntil: runway ? runway.safeUntil : null,
        tightestDate: runway ? runway.tightestDate : null,
        tightestBalance: runway ? r0(runway.tightestBalance) : null,
        freeCashPerMonth: Number.isFinite(d.freeCash) ? r0(d.freeCash) : null,
        committed30: ahead ? r0(arr(ahead.commitments).filter((c) => c.kind === 'out').reduce((s, c) => s + num(c.amount), 0)) : null,
        upcoming,
    };
    const balanceStore = appData.balance && typeof appData.balance === 'object' ? appData.balance : {};
    if (onHand === null || (!num(balanceStore.total) && !arr(balanceStore.flows).length)) quality.push('No balance is recorded on the Balance page, so cash on hand and the cover figures are not known.');

    /* ── 9. goals ── */
    const goals = get('targets').filter((t) => t && t.name).map((t) => {
        const target = num(t.amount), saved = arr(t.savings).reduce((s, x) => s + num(x && x.amount), 0);
        const end = ymFrom(t.end), begin = ymFrom(t.start);
        const left = end ? Math.max(0, ymIndex(end) - ymIndex(ym)) : null;
        const remaining = Math.max(0, target - saved);
        const elapsed = begin ? Math.max(1, ymIndex(ym) - ymIndex(begin)) : null;
        const pace = elapsed ? saved / elapsed : null;
        const needed = left !== null && remaining > 0 ? remaining / Math.max(1, left) : null;
        let status = 'no-deadline';
        if (remaining <= 0 && target > 0) status = 'complete';
        else if (left !== null && end < ym) status = 'overdue';
        else if (needed !== null && pace !== null) status = pace >= needed * 0.9 ? 'on-track' : 'behind';
        return { name: clean(t.name, 40), target: r0(target), saved: r0(saved), remaining: r0(remaining), progressPct: target > 0 ? r1((saved / target) * 100) : null, endsOn: end, monthsLeft: left, neededPerMonth: needed === null ? null : r0(needed), pacePerMonth: pace === null ? null : r0(pace), status };
    });

    /* ── 10. subscriptions and the Investments tab ── */
    const CYCLE = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1, annual: 1 };
    const subs = get('subscriptions').filter((s) => s && num(s.amount) > 0);
    const subscriptions = {
        count: subs.length,
        monthly: thisRow ? thisRow.subscriptions : 0,
        annual: r0(subs.reduce((s, x) => s + num(x.amount) * (CYCLE[String(x.cycle || 'monthly').toLowerCase()] || 12), 0)),
        top: subs.slice().sort((a, b) => num(b.amount) - num(a.amount)).slice(0, 5).map((s) => ({ name: clean(s.name, 30), amount: r0(s.amount), cycle: clean(s.cycle || 'monthly', 12) })),
    };
    const activeInvest = get('income').filter((s) => {
        if (!s) return false;
        const a = s.start ? new Date(`${String(s.start).slice(0, 10)}T00:00:00`) : null;
        const b = s.end ? new Date(`${String(s.end).slice(0, 10)}T00:00:00`) : null;
        return (!a || Number.isNaN(a.getTime()) || a <= now) && (!b || Number.isNaN(b.getTime()) || b >= now);
    });
    const investments = { sources: activeInvest.length, perPayout: r0(activeInvest.reduce((s, x) => s + num(x.monthly), 0)) };

    /* ── 11. what the dashboard already flags, so the two cannot contradict each other ── */
    const attention = safe(() => (d.insights && typeof d.insights.brief === 'function' ? d.insights.brief(6) : []), [])
        .filter((x) => x && x.title).slice(0, 6).map((x) => ({ severity: clean(x.sev, 10), title: clean(x.title, 90), detail: clean(x.body, 160) }));

    const facts = {
        version: FACTS_VERSION, ok: true, asOf: isoLocal(now), ym, currency: 'LKR',
        coverage: { firstMonth: first || null, completeMonths: complete.length },
        months, typical, recent, trend, thisMonth, categories, debt, liquidity, goals, subscriptions, investments, attention, quality,
    };
    facts.flags = flagsOf(facts);
    return facts;
}

/* ── the findings, as code ────────────────────────────────────────────────── */

/**
 * Deterministic findings over a fact sheet. Each one carries the figures that
 * make it true, so the Advisor repeats them instead of inventing the reason.
 * Ordered most serious first. Used by the chat prompt now and by the briefing
 * card later: one set of judgements, not two.
 */
export function flagsOf(f) {
    const out = [];
    const add = (id, severity, text) => out.push({ id, severity, text });
    const T = f.typical;
    const rank = { high: 0, medium: 1, low: 2 };
    const free = f.liquidity ? f.liquidity.freeCashPerMonth : null;
    if (T && T.net < 0) add('deficit', 'high', `Outflow was above income in a typical month: ${lkr(T.outflow)} out against ${lkr(T.income)} in, a gap of ${lkr(-T.net)} a month.`);
    else if (free !== null && free < 0) add('short-after-debt', 'high', `After living costs and the debt payments the loans and card plans ask every month, the month ends ${lkr(-free)} short${T && T.debtService !== null && T.debtService !== undefined && f.debt && f.debt.monthlyService > T.debtService ? ` (the books average shows ${lkr(T.net)} left only because the debt payments recorded as paid average ${lkr(T.debtService)} a month, while ${lkr(f.debt.monthlyService)} is scheduled)` : ''}.`);
    else if (T && T.savingsRatePct !== null && T.savingsRatePct < RULES.SAVINGS_LOW) add('thin-savings', 'medium', `Only ${pct(T.savingsRatePct)} of income is kept in a typical month (${lkr(T.net)} of ${lkr(T.income)}).`);
    const D = f.debt;
    if (D && D.dsrPct !== null) {
        if (D.dsrPct >= RULES.DSR_HIGH) add('dsr-high', 'high', `Loan and card instalments take ${pct(D.dsrPct)} of a typical month's income (${lkr(D.monthlyService)} of ${lkr(T.income)}).`);
        else if (D.dsrPct >= RULES.DSR_WATCH) add('dsr-watch', 'medium', `Loan and card instalments take ${pct(D.dsrPct)} of a typical month's income (${lkr(D.monthlyService)} of ${lkr(T.income)}).`);
    }
    for (const l of (D && D.loans) || []) if (l.problem === 'payment-below-interest') add('loan-below-interest', 'high', `${l.name}: the instalment (${lkr(l.monthly)}) is smaller than the interest, so the balance grows.`);
    const L = f.liquidity;
    if (L) {
        if (L.runwayStatus === 'critical' || L.runwayStatus === 'at-risk') add('runway', L.runwayStatus === 'critical' ? 'high' : 'medium', `The cash-flow engine projects the balance going below zero on ${L.runwayDate}${L.runwayDays !== null ? ` (${L.runwayDays} days away)` : ''}.`);
        if (L.monthsOfCover !== null && L.monthsOfCover < RULES.COVER_CRITICAL) add('cover-critical', 'high', `The Balance page covers ${L.monthsOfCover} month of a typical outflow.`);
        else if (L.monthsOfCover !== null && L.monthsOfCover < RULES.COVER_LOW) add('cover-low', 'medium', `The Balance page covers ${L.monthsOfCover} months of a typical outflow; a ${RULES.COVER_LOW}-month cushion would be ${lkr(L.cushion3)}.`);
    }
    for (const c of f.categories || []) if (c.spike) add(`spike:${c.name}`, 'medium', `${c.name} is ${lkr(c.thisMonth)} this month against an average of ${lkr(c.avg3)} (+${pct(c.changePct)}).`);
    for (const g of f.goals || []) {
        if (g.status === 'behind') add(`goal:${g.name}`, 'medium', `${g.name}: saving ${lkr(g.pacePerMonth)} a month, but ${lkr(g.neededPerMonth)} a month is needed to finish by ${g.endsOn}.`);
        if (g.status === 'overdue') add(`goal:${g.name}`, 'medium', `${g.name}: the target month ${g.endsOn} has passed with ${lkr(g.remaining)} still to save.`);
    }
    const tr = f.trend;
    if (tr && tr.outflowPctPerMonth !== null && tr.outflowPctPerMonth >= 3 && (tr.incomePctPerMonth === null || tr.outflowPctPerMonth > tr.incomePctPerMonth + 2)) add('outflow-rising', 'medium', `Outflow has been rising about ${pct(tr.outflowPctPerMonth)} a month over the last ${tr.months} months, faster than income.`);
    return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/* ── the text the model reads ─────────────────────────────────────────────── */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* How much of each list is shown, by level. A household with a dozen loans or fifteen goals must not push the findings and the cash position out of the
 * sheet, so each list is capped, says how many more there are, and the caps tighten level by level until the sheet fits. */
const LEVELS = [
    { months: 6, loans: 8, plans: 5, goals: 8, upcoming: 6, attention: 6, flags: 10, subs: 5 },
    { months: 4, loans: 5, plans: 3, goals: 5, upcoming: 4, attention: 3, flags: 8, subs: 3 },
    { months: 3, loans: 3, plans: 2, goals: 3, upcoming: 3, attention: 0, flags: 6, subs: 2 },
];
const END_MARK = "=== END OF THE OWNER'S BOOKS ===";

/**
 * @param {object} f      from build()
 * @param {object} [o]    { maxChars = 6000, level = 0 }
 */
export function renderFactSheet(f, o = {}) {
    if (!f || f.ok === false) return `OWNER'S BOOKS: not available (${(f && f.reason) || 'no data'}). Do not state any figure about the owner's money; say the figures could not be read.`;
    const level = Math.min(LEVELS.length - 1, Math.max(0, o.level || 0));
    const cap = LEVELS[level];
    const maxMonths = Math.max(2, o.maxMonths ? Math.min(o.maxMonths, cap.months) : cap.months);
    const lines = [];
    const out = (s) => lines.push(s);
    const more = (all, n, what) => { if (all.length > n) out(`- ... and ${all.length - n} more ${what} (not shown)`); };
    const when = new Date(`${f.asOf}T00:00:00`);
    out(`=== THE OWNER'S BOOKS — worked out by WealthFlow's own screens and engines, as of ${DAY_NAMES[when.getDay()]} ${when.getDate()} ${MONTH_NAMES[when.getMonth()]} ${when.getFullYear()} (all amounts LKR) ===`);
    out('RULES FOR THESE FIGURES: copy them exactly. Never redo the arithmetic, never round them differently, never invent a figure that is not listed. If something the owner asks about is not listed here, say it is not recorded and say what to record.');
    out('');

    out('MONTHLY PLAN — the same totals as the Dashboard and the Monthly Plan. Outflow = loans + card instalments + expenses + card one-offs + subscriptions + cheques. Income = money that has arrived (the Investments tab is not added: that money arrives in the bank and is counted there).');
    const shown = f.months.slice(-maxMonths);
    if (!shown.length) out('- No income or expense records yet.');
    for (const m of shown) {
        const bits = [`income ${lkr(m.income)}`, `outflow ${lkr(m.outflow)}`, `net ${lkr(m.net)}`];
        if (m.savingsRatePct !== null && !m.current) bits.push(`savings rate ${pct(m.savingsRatePct)}`);
        const parts = [m.loans && `loans ${lkr(m.loans)}`, m.cardInstalments && `card instalments ${lkr(m.cardInstalments)}`, m.expenses && `expenses ${lkr(m.expenses)}`, m.cardOneOff && `card one-offs ${lkr(m.cardOneOff)}`, m.subscriptions && `subscriptions ${lkr(m.subscriptions)}`, m.cheques && `cheques ${lkr(m.cheques)}`].filter(Boolean);
        out(`- ${m.ym}${m.current ? ` (this month, ${f.thisMonth ? f.thisMonth.daysLeft : '?'} days left, still filling in)` : ''}: ${bits.join('; ')}${parts.length ? `  [${parts.join(', ')}]` : ''}`);
    }
    if (f.typical) {
        const T = f.typical;
        const basis = T.source === 'books-profile'
            ? (T.basis === 'this-month' ? 'this month so far (no complete month is recorded yet)' : `the books average: income over ${T.incomeMonths} month(s) that had income, outgoings over ${T.outgoMonths} month(s) that had spending, ${T.from} to ${T.to}; the same typical month the DSCR, WealthFlow Score and Debt Demolisher use`)
            : `mean of the last ${T.months} complete month(s) with income, ${T.from} to ${T.to}`;
        out(`Typical month (${basis}): income ${lkr(T.income)}; outflow ${lkr(T.outflow)}${T.living !== null && T.living !== undefined ? ` (living costs ${lkr(T.living)} + debt payments ${lkr(T.debtService)})` : ''}; net ${lkr(T.net)}${T.savingsRatePct !== null ? `; savings rate ${pct(T.savingsRatePct)}` : ''}.`);
    }
    if (f.recent && f.typical && (f.typical.source === 'books-profile') && f.recent.months >= 1) out(`Last ${f.recent.months} complete month(s) with income, ${f.recent.from} to ${f.recent.to}, for comparison: income ${lkr(f.recent.income)}; outflow ${lkr(f.recent.outflow)}; net ${lkr(f.recent.net)}${f.recent.savingsRatePct !== null ? `; savings rate ${pct(f.recent.savingsRatePct)}` : ''}.`);
    if (f.liquidity && f.liquidity.freeCashPerMonth !== null) out(`Left each month after living costs and the debt payments the loans and card plans ask: ${lkr(f.liquidity.freeCashPerMonth)} (the extra-payment pool the Debt Demolisher and the monthly saving the Wealth Simulator use).`);
    if (f.trend) out(`Trend over ${f.trend.months} months: outflow ${f.trend.outflowPctPerMonth === null ? 'n/a' : `${f.trend.outflowPctPerMonth > 0 ? '+' : ''}${pct(f.trend.outflowPctPerMonth)}`} a month; income ${f.trend.incomePctPerMonth === null ? 'n/a' : `${f.trend.incomePctPerMonth > 0 ? '+' : ''}${pct(f.trend.incomePctPerMonth)}`} a month.`);
    out('');

    if (f.categories.length) {
        out(`WHERE THE MONEY GOES — this month's categorised lines (expenses, card one-offs, subscriptions, cheques) out of the ${lkr(f.thisMonth ? f.thisMonth.outflow : 0)} outflow, each category against its own average of the last three complete months`);
        for (const c of f.categories) out(`- ${c.name}: ${lkr(c.thisMonth)}${c.avg3 !== null ? ` (average ${lkr(c.avg3)}${c.changePct !== null ? `, ${c.changePct > 0 ? '+' : ''}${pct(c.changePct)}` : ''})` : ''}${c.share !== null ? `, ${pct(c.share)} of the categorised total` : ''}${c.spike ? '  <-- spike' : ''}`);
        out('');
    }

    const D = f.debt;
    out('DEBT');
    if (!D.loans.length && !D.cardPlans.length && !D.cardOwedCount) out('- No active loans, card instalment plans or unpaid card charges are recorded.');
    for (const l of D.loans.slice(0, cap.loans)) out(`- Loan "${l.name}"${l.bank ? ` (${l.bank})` : ''}: ${lkr(l.monthly)} a month${l.ratePct ? `, ${l.ratePct}% a year` : ''}${l.balance !== null ? `, balance ${lkr(l.balance)}` : ''}${l.paymentsLeft !== null ? `, ${l.paymentsLeft} payments left` : ''}${l.endsOn ? `, term ends ${l.endsOn}` : ''}${l.interestLeft !== null ? `, interest still to pay ${lkr(l.interestLeft)}` : ''}${l.problem ? `, PROBLEM: ${l.problem}` : ''}`);
    more(D.loans, cap.loans, 'loan(s)');
    if (D.loanBalanceTotal !== null && D.loans.length > 1) out(`- All loan balances together: ${lkr(D.loanBalanceTotal)}`);
    for (const c of D.cardPlans.slice(0, cap.plans)) out(`- Card instalment "${c.product}"${c.bank ? ` (${c.bank})` : ''}: ${lkr(c.monthly)} a month, ${c.monthsLeft} month(s) left`);
    more(D.cardPlans, cap.plans, 'card plan(s)');
    if (D.cardOwedCount) out(`- Card charges not yet paid: ${lkr(D.cardOwed)} across ${D.cardOwedCount} charge(s)`);
    if (D.planLeft) out(`- Still to pay on card instalment plans: ${lkr(D.planLeft)}`);
    if (D.monthlyService) out(`- What the loans and card plans ask every month: ${lkr(D.monthlyService)}${D.dsrPct !== null ? ` = ${pct(D.dsrPct)} of a typical month's income (rule of thumb: above ${RULES.DSR_HIGH}% is heavy)` : ''}; paid so far this month: ${lkr(D.paidThisMonth)}`);
    out('');

    const L = f.liquidity;
    out('CASH AND COMMITMENTS');
    if (L.onHand !== null) out(`- On hand (Balance page: total - outflows + inflows): ${lkr(L.onHand)}${L.monthsOfCover !== null ? `, which covers ${L.monthsOfCover} months of a typical outflow; a 3-month cushion would be ${lkr(L.cushion3)} (gap ${lkr(L.cushionGap)}). This holds only if the Balance page is liquid cash` : ''}`);
    if (L.runwayStatus) out(`- Cash-flow engine, next 90 days: status ${L.runwayStatus}${L.runwayDate ? `; the balance first goes below zero on ${L.runwayDate}` : '; no shortfall projected'}; tightest point ${lkr(L.tightestBalance)} on ${L.tightestDate || 'n/a'}; safe to spend ${lkr(L.safeToSpend)} until ${L.safeUntil || 'n/a'}`);
    if (L.committed30 !== null) out(`- Dated outflows in the next 30 days: ${lkr(L.committed30)} in all${L.upcoming.length ? '; the biggest, by date:' : ''}`);
    for (const u of L.upcoming.slice(0, cap.upcoming)) out(`    · ${u.date}  ${u.label}  ${lkr(u.amount)}${u.certainty === 'expected' ? ' (date is approximate)' : ''}`);
    out('');

    if (f.goals.length) {
        out('SAVINGS GOALS');
        for (const g of f.goals.slice(0, cap.goals)) out(`- ${g.name}: saved ${lkr(g.saved)} of ${lkr(g.target)}${g.progressPct !== null ? ` (${pct(g.progressPct)})` : ''}${g.endsOn ? `, target month ${g.endsOn}` : ''}${g.neededPerMonth !== null ? `, needs ${lkr(g.neededPerMonth)} a month` : ''}${g.pacePerMonth !== null ? `, has been saving ${lkr(g.pacePerMonth)} a month` : ''}; status ${g.status}`);
        more(f.goals, cap.goals, 'goal(s)');
        out('');
    }

    if (f.subscriptions.count) {
        out(`SUBSCRIPTIONS: ${f.subscriptions.count} tracked, ${lkr(f.subscriptions.monthly)} in this month's plan, about ${lkr(f.subscriptions.annual)} a year. Largest: ${f.subscriptions.top.slice(0, cap.subs).map((s) => `${s.name} ${lkr(s.amount)}`).join(', ')}`);
        out('');
    }
    if (f.investments.sources) { out(`INVESTMENTS TAB: ${f.investments.sources} income source(s), ${lkr(f.investments.perPayout)} per payout in all. Tracked separately; not added to the monthly income above.`); out(''); }

    if (f.attention.length && cap.attention) {
        out('ALREADY FLAGGED ON THE DASHBOARD ("Needs your attention")');
        for (const a of f.attention.slice(0, cap.attention)) out(`- [${a.severity}] ${a.title}${a.detail ? ` — ${a.detail}` : ''}`);
        out('');
    }
    if (f.flags.length) {
        out('FINDINGS COMPUTED FROM THE FIGURES ABOVE (most serious first)');
        for (const x of f.flags.slice(0, cap.flags)) out(`- [${x.severity}] ${x.text}`);
        more(f.flags, cap.flags, 'finding(s)');
        out('');
    }
    if (f.quality.length) {
        out('WHAT THE BOOKS DO NOT SHOW (say so rather than guess)');
        for (const q of f.quality.slice(0, 6)) out(`- ${q}`);
        more(f.quality, 6, 'note(s)');
        out('');
    }
    out(END_MARK);

    const text = lines.join('\n');
    const maxChars = o.maxChars || 6000;
    if (text.length <= maxChars) return text;
    if (level < LEVELS.length - 1) return renderFactSheet(f, { ...o, level: level + 1 });
    /* even the tightest level does not fit (very long names): cut the middle, never the end, so the sheet still closes */
    return text.slice(0, maxChars - END_MARK.length - 40).replace(/\n[^\n]*$/, '') + `\n(the rest is left out to fit)\n${END_MARK}`;
}

/** A Date from any realm: a page that runs in its own window (or a test's sandbox) hands over Dates this module's `instanceof Date` does not recognise. */
export function isDate(x) { return Object.prototype.toString.call(x) === '[object Date]' && Number.isFinite(x.getTime()); }

/** "Now" as the page sees it (its own Date, so a pinned clock in a test or a skewed one in a browser is honoured). */
export function clockOf(w) {
    try { return typeof w.Date === 'function' ? new w.Date() : new Date(); } catch (_) { return new Date(); }
}

/* ── how the page reaches the screens' own functions ──────────────────────── */

/** The page's own books profile and position (the figures DSCR, the Score and the Debt Demolisher read), when the page has them. */
function booksFrom(w) {
    try {
        if (typeof w._wfBooksProfile !== 'function' || typeof w._wfPosition !== 'function') return {};
        const now = clockOf(w), profile = w._wfBooksProfile(now), position = w._wfPosition(now);
        const freeCash = typeof w._wfFreeCash === 'function' && profile && profile.basis && profile.basis.kind !== 'none' ? w._wfFreeCash(profile, position) : null;
        return { profile, position, freeCash };
    } catch (_) { return {}; }
}

/** Dependencies read from the page's globals; lazy, so a function the page has not defined yet is only a missing figure. */
export function pageDeps(w = globalThis) {
    const call = (name) => (typeof w[name] === 'function' ? (...a) => w[name](...a) : undefined);
    return {
        now: clockOf(w),
        appData: w.appData,
        get: (k) => (w.DB && typeof w.DB.get === 'function' ? w.DB.get(k) : []),
        monthly: call('getMonthlyData'),
        loanBalance: call('loanCurrentBalance'),
        loanEnd: call('loanEndDate'),
        cashOpts: call('_wfCashOpts'),
        insights: w.WFInsights || null,
        ...booksFrom(w),
    };
}

/** Facts and their text, from the page, in one call. Never throws: a failure is a sheet that says so. */
export function currentSheet(w = globalThis, o = {}) {
    try { const facts = build(pageDeps(w)); return { facts, text: renderFactSheet(facts, o) }; }
    catch (e) { return { facts: null, text: renderFactSheet({ ok: false, reason: `error: ${clean(e && e.message, 80)}` }) }; }
}

/* ── is this about money? (English, Sinhala, Tamil and the romanised Sinhala people actually type) ──
 *
 * The chat engine decided "is this a money question?" with an English-only regex, so a Sinhala question about loans fell through to
 * "general" and was answered with none of the owner's figures (see test/advisor_facts_test.js: of twelve everyday questions the old
 * rule recognised four). Sinhala and Tamil have no word boundaries, so these are substring tests; the words are long enough to be safe
 * and the generic ones (a car, a house, a card, gold) only count when the sentence is about the speaker. */

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CORE_WORDS = [
    // English
    'money', 'budget', 'saving', 'savings', 'save up', 'loan', 'debt', 'invest', 'income', 'expense', 'salary', 'cash flow', 'cashflow', 'portfolio', 'emi', 'instalment', 'installment', 'interest', 'inflation', 'cbsl', 'policy rate', 'exchange rate', 'treasury', 'fixed deposit', 'forex', 'usd', 'dividend', 'bond', 'crypto', 'bitcoin', 'net worth', 'wealth', 'afford', 'tax', 'epf', 'etf', 'retire', 'pension', 'mortgage', 'spending', 'spent', 'bills', 'rent', 'lease', 'credit card', 'cheque', 'subscription', 'emergency fund', 'lkr', 'rupee', 'financial', 'finance', 'repay', 'outflow',
    // Sinhala
    'මුදල්', 'සල්ලි', 'ණය', 'වාරික', 'ඉතිරි', 'ඉතුරු', 'ආදායම', 'වැටුප', 'වියදම', 'බිල්', 'පොලි', 'ආයෝජන', 'කොටස්', 'බදු', 'අයවැය', 'බජට්', 'විශ්‍රාම', 'විශ්රාම', 'රුපියල්', 'ලක්ෂ', 'මිලියන', 'කෝටි', 'කුලිය', 'අරමුදල', 'රක්ෂණ', 'ලීසිං', 'චෙක්', 'ගෙවීම', 'ගෙවන්න', 'ගෙවා', 'ආර්ථික',
    // Tamil
    'பணம்', 'கடன்', 'சேமிப்பு', 'வருமானம்', 'செலவு', 'வட்டி', 'முதலீடு', 'சம்பளம்', 'வரி', 'ரூபாய்', 'லட்சம்',
    // romanised Sinhala (spelling varies; these are the common ones)
    'salli', 'mudal', 'naya', 'nanaya', 'wiyadam', 'viyadam', 'adayama', 'adaayama', 'inithiri', 'ithiri', 'polliya', 'waarika', 'warika', 'rupiyal', 'laksha', 'lakshay',
];
const WEAK_WORDS = ['buy', 'purchase', 'car', 'vehicle', 'house', 'land', 'bank', 'balance', 'card', 'gold', 'shares', 'stock', 'insurance', 'කාර්', 'වාහන', 'නිවස', 'ඉඩම', 'බැංකු', 'කාඩ්', 'රන්', 'ගන්න පුළුවන්', 'මිලදී', 'ගිණුම', 'வாங்க', 'வங்கி', 'கணக்கு'];
/* English words must start a word ("rent" is not "cur-rent"); Sinhala and Tamil have no word boundaries, so those are plain substrings. */
const wordsRe = (words) => new RegExp(words.map((w) => (/^[a-z]/i.test(w) ? '\\b' : '') + escapeRe(w) + (/^emi$/.test(w) ? '\\b' : '')).join('|'), 'i');
const CORE_RE = wordsRe(CORE_WORDS);
const WEAK_RE = wordsRe(WEAK_WORDS);
const SELF_RE = /\b(?:my|i|i'm|me|mine|we|our)\b|මගේ|මම|මට|අපේ|අපි|எனது|என்|நான்|\b(?:mage|mata|mama|apage)\b/i;
const AMOUNT_RE = /(?:\blkr|\brs\.?|රු\.?|ரூ\.?)\s*\d|\d[\d,]*(?:\.\d+)?\s*(?:k|m|mn|million|lakh|lakhs|lac|ලක්ෂ|මිලියන|කෝටි|லட்சம்)(?![a-z])|\d{1,3}(?:,\d{2,3})+/i;

/** Is this line about the speaker's money? A core money word or an amount says yes; a generic word (car, house, card) only when the line is about "my". */
export function looksFinancial(text) {
    const t = String(text == null ? '' : text);
    return CORE_RE.test(t) || AMOUNT_RE.test(t) || (WEAK_RE.test(t) && SELF_RE.test(t));
}

/* Browser global, like the other wired modules; harmless in Node. */
const API = { FACTS_VERSION, RULES, build, flagsOf, renderFactSheet, pageDeps, currentSheet, looksFinancial, lkr };
if (typeof window !== 'undefined') window.WFAdvisorFacts = API;
export default API;
