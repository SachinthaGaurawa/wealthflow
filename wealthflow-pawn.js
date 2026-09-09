/* =============================================================================
 * wealthflow-pawn.js — a pawn ticket, the way a pawn ticket actually behaves
 * -----------------------------------------------------------------------------
 * WHAT THE LEDGER USED TO BELIEVE, AND WHY IT WAS WRONG
 *
 * The first version of this ledger could do two things to a ticket: redeem the
 * whole thing, or delete it. That is not how anybody pawns anything. The owner
 * described what really happens, and every sentence of it was unsupported:
 *
 *   "අපි සමහර වෙලාවට ඒ අදාළ ගාණක් ගෙවනවා. අතේ තියෙන මුදලක් වගේ. ටිකෙන් ටික
 *    ගෙවනවා. සමහර වෙලාවට ඔක්කොම ගෙවලා close කරනවා."
 *
 *   You pay something toward it when you have cash in hand. A bit at a time.
 *   Sometimes you pay the lot and close it.
 *
 *   "සමහර pawning තියෙනවා මාස 3කට ... අපිට මාස 3 උවර වෙනකොට මාස 12ට
 *    දික්කරගන්නවා. ඒ කියන්නේ මාස 12 interest rate එකට. තව මාස 9ක් දික් වෙනවා."
 *
 *   A three-month ticket, extended at maturity to twelve — AT THE TWELVE-MONTH
 *   RATE, which may be higher or lower than the three-month one. Nine more
 *   months are added.
 *
 * ── THE ARITHMETIC THAT FOLLOWS FROM THAT ───────────────────────────────────
 *
 * Once part payments exist, "principal × rate × months" is wrong. Pay 50,000
 * off a 200,000 ticket in month two and months three onward accrue on 150,000,
 * not on 200,000. So interest is walked MONTH BY MONTH on the balance that
 * actually stood in that month, at the rate that actually applied to it.
 *
 * A PART MONTH IS STILL A WHOLE MONTH. That is not a rounding preference, it is
 * how the counter bills: eight days into the second month is two months of
 * interest, and a calculator that says 1.26 tells the owner they owe less than
 * they will be asked for.
 *
 * INTEREST IS PAID BEFORE PRINCIPAL. Hand over cash and the broker clears the
 * interest first; only what is left reduces the advance. Recording it the other
 * way round would understate every future month.
 *
 * ── THE EXTENSION, AND THE QUESTION NOBODY CAN ANSWER FOR YOU ───────────────
 *
 * Extending a 3-month ticket to 12 at the 12-month rate has two readings, and
 * brokers genuinely do both:
 *
 *   rateFrom: 'start'     the ticket is re-issued as a 12-month one, so the new
 *                         rate applies from the pawn date — the first three
 *                         months are re-priced too.
 *   rateFrom: 'renewal'   the first three months stay at the rate they were
 *                         agreed at, and the new rate applies to the nine
 *                         months being added.
 *
 * This file refuses to guess. It asks, defaults to 'start' because that is what
 * the owner described, and shows what each one costs before it is chosen.
 *
 * The interest already run up at the moment of renewal has three real fates,
 * and all three are supported because all three happen:
 *   'paid'        handed over in cash at the counter
 *   'capitalise'  rolled into the advance, so it starts earning interest itself
 *   'carry'       left outstanding, to be settled later
 *
 * Capitalising is recorded as an event DATED AT THE RENEWAL, never by editing
 * `principal`. Editing the principal would retroactively re-price months that
 * were already billed at the old advance — a silent rewrite of history.
 *
 * ── NOTHING HERE MOVES A BALANCE ON ITS OWN ─────────────────────────────────
 *
 * Same rule as every other ledger in this app: an unconfirmed payment is
 * visible, counted separately, and moves nothing. And every write is
 * reversible, because the reason there was no undo before is that nobody wrote
 * one.
 *
 * Pure: no DOM, no storage, no network, and never `new Date()` without an
 * argument. test/pawn_test.js drives it.
 * ===========================================================================*/

const DAY_MS = 86400000;
/* The average calendar month. Used only where a genuine fraction of a month is
 * wanted; whole-month billing is counted on the calendar, not on this. */
const DAYS_PER_MONTH = 30.4375;

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const s = (v) => String(v == null ? '' : v).trim();
const money = (v) => Math.max(0, num(v));

export const PAWN_STATE = { ACTIVE: 'ACTIVE', REDEEMED: 'REDEEMED', OVERDUE: 'OVERDUE' };

/** What a payment does. Cash pays interest first unless told otherwise. */
export const PAY = {
    /** Cash, applied to interest first and then to the advance. The usual one. */
    PART: 'part',
    /** Cash, against interest only. */
    INTEREST: 'interest',
    /** Cash, straight off the advance. */
    PRINCIPAL: 'principal',
    /** Interest rolled INTO the advance at a renewal. No cash changes hands. */
    CAPITALISE: 'capitalise',
    /** Everything owed, on the day the item came back. */
    REDEEM: 'redeem',
};

/** Whether a renewal's new rate reaches back to the pawn date. */
export const RATE_FROM = { START: 'start', RENEWAL: 'renewal' };

/** How the interest standing at a renewal is dealt with. */
export const ON_INTEREST = { PAID: 'paid', CAPITALISE: 'capitalise', CARRY: 'carry' };

/* A broker can sell the item after maturity. This is the one date in the app
 * where being late costs something that paying afterwards cannot undo. */
export const MATURITY_WARN_DAYS = 14;

/* ── days ─────────────────────────────────────────────────────────────────── */

/** Parse 'YYYY-MM-DD' or an ISO timestamp to a UTC day. Null if unusable. */
export function parseDay(v) {
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    const d = new Date(v);
    return isFinite(d.getTime())
        ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
        : null;
}

export const isoOf = (day) => (day ? day.toISOString().slice(0, 10) : '');

/** Whole days between two days, never negative. */
export function daysBetween(from, to) {
    if (!from || !to) return 0;
    return Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));
}

/**
 * The same day-of-month, n months on, CLAMPED to the end of the month.
 *
 * `Date.UTC(y, m + 1, 31)` for the 31st of January silently becomes the 3rd of
 * March, which would make a monthly cycle drift and eventually skip a month
 * entirely. The 31st plus one month is the 28th (or 29th) of February.
 */
export function addMonths(day, n) {
    if (!day) return null;
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth();
    const d = day.getUTCDate();
    const lastOfTarget = new Date(Date.UTC(y, m + num(n) + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m + num(n), Math.min(d, lastOfTarget)));
}

/** The furthest this will walk. Fifty years of monthly billing is a bad date. */
export const MAX_MONTHS = 600;

/**
 * How many months of interest have been billed.
 *
 * COUNTED ON THE CALENDAR, not by dividing days by an average month, and the
 * difference is not cosmetic. The first version divided by 30.4375 and rounded
 * up, so a ticket redeemed at exactly two months — the 1st of June to the 1st
 * of August, 61 days — came to 2.004 months and was billed for THREE. An extra
 * month of interest on the day the owner walks in to settle, produced entirely
 * by an average that does not match any actual month.
 *
 * Whole months from the pawn date, then one more if there are days left over.
 * That is what "a part month is a whole month" actually means, and it is what
 * the counter does.
 *
 * The exact fraction is still available for anything that genuinely accrues
 * daily, and is still a fraction of an average month, which is right for that.
 */
export function monthsElapsed(fromISO, asOf, { roundUp = true } = {}) {
    const from = parseDay(fromISO);
    const to = asOf instanceof Date ? parseDay(asOf.toISOString()) : parseDay(asOf);
    if (!from || !to) return 0;
    const days = daysBetween(from, to);
    if (days <= 0) return 0;
    if (!roundUp) return days / DAYS_PER_MONTH;

    let whole = 0;
    while (whole < MAX_MONTHS && addMonths(from, whole + 1).getTime() <= to.getTime()) whole += 1;
    if (whole >= MAX_MONTHS) return MAX_MONTHS;
    return addMonths(from, whole).getTime() === to.getTime() ? whole : whole + 1;
}

/* ── the term schedule ────────────────────────────────────────────────────── */

/**
 * The rate periods of a ticket, oldest first.
 *
 * A ticket written before renewals existed has one rate and a maturity date;
 * that is read as a single term, so nothing about an existing record changes
 * meaning. `months: 0` means open-ended — a ticket with no maturity date, which
 * is common and must never be reported as overdue.
 */
export function termsOf(pawn) {
    const p = pawn || {};
    const explicit = arr(p.terms)
        .map((t, i) => ({
            id: s(t && t.id) || 'term' + i,
            startISO: s(t && t.startISO) || s(p.pawnDate),
            months: Math.max(0, Math.floor(num(t && t.months))),
            rate: num(t && t.rate),
            note: s(t && t.note).slice(0, 120),
            at: num(t && t.at),
        }))
        .filter((t) => t.startISO)
        .sort((a, b) => (a.startISO < b.startISO ? -1 : a.startISO > b.startISO ? 1 : 0));
    if (explicit.length) return explicit;

    const start = s(p.pawnDate);
    if (!start) return [];
    const mat = parseDay(p.maturity);
    const from = parseDay(start);
    let months = 0;
    if (mat && from && mat > from) months = Math.max(1, Math.round(daysBetween(from, mat) / DAYS_PER_MONTH));
    return [{ id: 'term0', startISO: start, months, rate: num(p.rate), note: '', at: 0 }];
}

/**
 * The day the ticket currently matures, or null when it is open-ended.
 *
 * A TICKET THAT HAS NEVER BEEN RENEWED KEEPS ITS RECORDED DATE. Deriving it
 * from a rounded month count instead was a real regression caught by the
 * existing tests: a ticket pawned on the 20th of June maturing on the 10th of
 * September is 2.69 months, which rounds to 3, which moves the maturity to the
 * 20th of September — ten days of "you still have time" that the owner does
 * not have, on the one date in this app where being late loses the item.
 * Months are how a RENEWAL is expressed; a date is a date.
 */
export function maturityOf(pawn) {
    const p = pawn || {};
    if (!arr(p.terms).length) return parseDay(p.maturity);
    const terms = termsOf(p);
    const last = terms[terms.length - 1];
    if (!(last.months > 0)) return null;
    return addMonths(parseDay(last.startISO), last.months);
}

/**
 * The rate in force on a given day.
 *
 * Past the last term's end the last rate continues. Interest does not stop
 * because a ticket went overdue — the broker keeps charging, and a ledger that
 * quietly stopped counting would tell the owner they owe less than they do.
 */
export function rateOn(terms, dayISO) {
    const list = arr(terms);
    if (!list.length) return 0;
    const day = parseDay(dayISO);
    if (!day) return num(list[list.length - 1].rate);
    let chosen = list[0];
    for (const t of list) {
        const start = parseDay(t.startISO);
        if (start && start <= day) chosen = t;
    }
    return num(chosen.rate);
}

/* ── payments ─────────────────────────────────────────────────────────────── */

const PAY_KINDS = new Set(Object.values(PAY));

/** One payment, normalised. Unknown kinds are dropped rather than guessed at. */
export function normPayment(p) {
    if (!p || !p.id) return null;
    const kind = s(p.kind).toLowerCase();
    if (!PAY_KINDS.has(kind)) return null;
    const amount = num(p.amount);
    /* A redemption may legitimately be recorded with no figure — the ledger
     * knows what was owed. Every other kind needs one. */
    if (kind !== PAY.REDEEM && !(amount > 0)) return null;
    return {
        id: s(p.id),
        kind,
        amount: money(amount),
        date: s(p.date),
        note: s(p.note).slice(0, 200),
        /* ABSENT MEANS CONFIRMED. Every payment written before this field
         * existed describes money that already changed hands; reading a missing
         * flag as "unconfirmed" would push a whole history into a queue. */
        confirmed: p.confirmed !== false,
        at: num(p.at),
    };
}

export function paymentsOf(pawn) {
    return arr((pawn || {}).payments).map(normPayment).filter(Boolean)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1)));
}

/* ── the ledger walk ──────────────────────────────────────────────────────── */

/**
 * Month by month, what this ticket did.
 *
 * The one place the arithmetic lives. Everything else on this screen is a
 * reading of what this returns.
 *
 * `includeUnconfirmed` answers the second question the owner always has: what
 * would I owe if the payment I just logged is real? Both numbers are produced
 * so the screen can show the difference instead of picking one.
 */
export function schedule(pawn, asOf, { includeUnconfirmed = false } = {}) {
    const p = pawn || {};
    const terms = termsOf(p);
    const start = parseDay(p.pawnDate);
    const today = asOf instanceof Date ? parseDay(asOf.toISOString()) : parseDay(asOf);
    const compound = s(p.interestMode).toLowerCase() === 'compound';
    const advance = money(p.principal);

    const redeemedAt = parseDay(p.redeemedAt);
    const until = redeemedAt || today;

    const empty = {
        months: [], advance, balance: advance, principalPaid: 0,
        interestAccrued: 0, interestSettled: 0, interestDue: 0,
        cashPaid: 0, capitalised: 0, credit: 0, payable: advance, monthCount: 0,
    };
    if (!start || !until || !(advance >= 0)) return empty;

    const pays = paymentsOf(p).filter((x) => (includeUnconfirmed ? true : x.confirmed))
        .filter((x) => x.kind !== PAY.REDEEM);

    let balance = advance;
    let interestDue = 0;
    let interestAccrued = 0;
    let interestSettled = 0;
    let principalPaid = 0;
    let cashPaid = 0;
    let capitalised = 0;
    let credit = 0;
    const applied = [];

    const settleInterest = (amount) => {
        const x = Math.min(amount, interestDue);
        interestDue -= x;
        interestSettled += x;
        return amount - x;
    };
    const reducePrincipal = (amount) => {
        const x = Math.min(amount, balance);
        balance -= x;
        principalPaid += x;
        return amount - x;
    };

    const applyOne = (pay) => {
        let left = pay.amount;
        let toInterest = 0;
        let toPrincipal = 0;
        if (pay.kind === PAY.CAPITALISE) {
            /* No cash. The interest standing right now moves into the advance
             * and starts earning from here — dated at the renewal, never by
             * editing `principal`, which would re-price months already billed. */
            const rolled = Math.min(pay.amount || interestDue, interestDue);
            interestDue -= rolled;
            interestSettled += rolled;
            balance += rolled;
            capitalised += rolled;
            applied.push({ ...pay, toInterest: rolled, toPrincipal: 0, rolled });
            return;
        }
        if (pay.kind === PAY.INTEREST) {
            const before = left;
            left = settleInterest(left);
            toInterest = before - left;
        } else if (pay.kind === PAY.PRINCIPAL) {
            const before = left;
            left = reducePrincipal(left);
            toPrincipal = before - left;
        } else {
            /* PART — interest first, which is how the counter applies it. */
            const b1 = left; left = settleInterest(left); toInterest = b1 - left;
            const b2 = left; left = reducePrincipal(left); toPrincipal = b2 - left;
        }
        cashPaid += pay.amount;
        credit += left;               // handed over more than was owed
        applied.push({ ...pay, toInterest, toPrincipal, rolled: 0 });
    };

    let pi = 0;
    const applyUpTo = (dayISO) => {
        while (pi < pays.length && pays[pi].date && pays[pi].date <= dayISO) { applyOne(pays[pi]); pi += 1; }
    };

    const monthCount = monthsElapsed(p.pawnDate, until, { roundUp: s(p.accrual).toLowerCase() !== 'daily' });
    const rows = [];
    for (let k = 0; k < monthCount && k < MAX_MONTHS; k += 1) {
        const from = addMonths(start, k);
        const fromISO = isoOf(from);
        /* Payments made on or before this month begins are already off the
         * balance this month accrues on. */
        applyUpTo(fromISO);
        const rate = rateOn(terms, fromISO);
        const base = compound ? balance + interestDue : balance;
        const inc = base * (rate / 100);
        interestDue += inc;
        interestAccrued += inc;
        rows.push({
            index: k + 1,
            fromISO,
            toISO: isoOf(addMonths(start, k + 1)),
            rate,
            opening: balance,
            interest: inc,
        });
    }
    applyUpTo(isoOf(until));
    /* Anything dated after today — a payment logged forward — is not applied,
     * but it is not lost either: the caller sees it in `payments`. */

    return {
        months: rows,
        monthCount,
        advance,
        balance,
        principalPaid,
        interestAccrued,
        interestSettled,
        interestDue: Math.max(0, interestDue),
        cashPaid,
        capitalised,
        credit,
        applied,
        payable: Math.max(0, balance + Math.max(0, interestDue)),
    };
}

/* ── what the screen says ─────────────────────────────────────────────────── */

/** Simple monthly rate expressed the way a rate should be compared: per year. */
export function effectiveAnnual(ratePctPerMonth, mode = 'simple') {
    const r = num(ratePctPerMonth) / 100;
    if (!(r > 0)) return 0;
    if (s(mode).toLowerCase() === 'compound') return (Math.pow(1 + r, 12) - 1) * 100;
    return r * 12 * 100;
}

/**
 * Everything about one ticket, as of a day.
 *
 * Keeps every field the previous version returned, because other screens read
 * them, and adds what the owner actually needs to decide something: what it is
 * costing per day, what it would cost to clear today, and whether the thing in
 * the safe is still worth more than getting it back.
 */
export function pawnStatus(pawn, asOf) {
    const p = pawn || {};
    const today = asOf instanceof Date ? parseDay(asOf.toISOString()) : parseDay(asOf);
    const redeemed = !!p.redeemedAt || s(p.state).toUpperCase() === PAWN_STATE.REDEEMED;
    const led = schedule(p, asOf);
    const ledIf = schedule(p, asOf, { includeUnconfirmed: true });
    const maturity = maturityOf(p);
    const daysToMaturity = (maturity && today)
        ? Math.round((maturity.getTime() - today.getTime()) / DAY_MS) : null;

    let state = PAWN_STATE.ACTIVE;
    if (redeemed) state = PAWN_STATE.REDEEMED;
    else if (daysToMaturity !== null && daysToMaturity < 0) state = PAWN_STATE.OVERDUE;

    const terms = termsOf(p);
    const rateNow = rateOn(terms, isoOf(today) || s(p.pawnDate));
    const perMonth = redeemed ? 0 : led.balance * (rateNow / 100);
    const value = money(p.value);

    return {
        state,
        /* Kept for every existing caller: months billed, the interest they
         * produced, and what it takes to walk out with the item. */
        months: led.monthCount,
        principal: led.advance,
        interest: led.interestAccrued,
        payable: led.payable,
        daysToMaturity,
        warn: state === PAWN_STATE.ACTIVE && daysToMaturity !== null && daysToMaturity <= MATURITY_WARN_DAYS,

        /* The part payments the ledger could not previously hold. */
        balance: led.balance,
        principalPaid: led.principalPaid,
        interestSettled: led.interestSettled,
        interestDue: led.interestDue,
        cashPaid: led.cashPaid,
        capitalised: led.capitalised,
        credit: led.credit,
        payments: paymentsOf(p),
        pending: paymentsOf(p).filter((x) => !x.confirmed).length,
        payableIfConfirmed: ledIf.payable,

        /* What holding it costs, which is the number that decides whether to
         * redeem now or wait. */
        rate: rateNow,
        perMonth,
        perDay: perMonth / DAYS_PER_MONTH,
        annualPct: effectiveAnnual(rateNow, p.interestMode),
        terms,
        renewals: Math.max(0, terms.length - 1),
        maturityISO: isoOf(maturity),

        /* And whether the collateral is still worth getting back. Only when a
         * value was actually recorded — a guessed valuation on a gold ticket is
         * worse than none. */
        value,
        ltv: value > 0 ? led.payable / value : null,
        underwater: value > 0 && led.payable > value,
        headroom: value > 0 ? value - led.payable : null,
    };
}

/** Totals for the header of the ledger. Redeemed tickets are finished. */
export function pawnTotals(pawns, asOf) {
    let principal = 0, interest = 0, payable = 0, perMonth = 0;
    let active = 0, overdue = 0, warn = 0, pending = 0, underwater = 0, atRisk = 0;
    for (const p of arr(pawns)) {
        const st = pawnStatus(p, asOf);
        if (st.state === PAWN_STATE.REDEEMED) continue;
        principal += st.balance;
        interest += st.interestDue;
        payable += st.payable;
        perMonth += st.perMonth;
        pending += st.pending;
        active += 1;
        if (st.state === PAWN_STATE.OVERDUE) { overdue += 1; atRisk += st.value || 0; }
        if (st.warn) warn += 1;
        if (st.underwater) underwater += 1;
    }
    return {
        principal, interest, payable, perMonth, perDay: perMonth / DAYS_PER_MONTH,
        active, overdue, warn, pending, underwater, atRisk,
    };
}

/**
 * With this much cash in hand, which ticket should be cleared first?
 *
 * The question anybody with more than one ticket actually has, and the answer
 * is not "the biggest". Ranked by:
 *
 *   1. OVERDUE FIRST. Past maturity the broker may sell the item, and that is
 *      the only loss on this screen that money cannot reverse afterwards.
 *   2. Then by what clearing it stops costing every month, per rupee spent —
 *      the highest-rate ticket, not the largest one.
 *
 * `affordable` says whether the cash in hand actually covers it, and the list
 * is returned whole either way: knowing the one you cannot afford yet is worth
 * as much as knowing the one you can.
 */
export function clearFirst(pawns, cash, asOf) {
    const rows = [];
    for (const p of arr(pawns)) {
        if (!p || !p.id) continue;
        const st = pawnStatus(p, asOf);
        if (st.state === PAWN_STATE.REDEEMED) continue;
        rows.push({
            id: p.id,
            item: s(p.item) || 'Pawned item',
            payable: st.payable,
            perMonth: st.perMonth,
            rate: st.rate,
            state: st.state,
            daysToMaturity: st.daysToMaturity,
            underwater: st.underwater,
            /* Interest per rupee it takes to clear. A small ticket at 3% beats a
             * large one at 1.5% for every rupee you have. */
            costPerRupee: st.payable > 0 ? st.perMonth / st.payable : 0,
            reason: st.state === PAWN_STATE.OVERDUE
                ? 'past maturity — the broker may sell it'
                : st.warn
                    ? st.daysToMaturity + ' days before the broker may sell it'
                    : 'stops ' + Math.round(st.perMonth) + ' a month at ' + st.rate + '%',
        });
    }
    rows.sort((a, b) => {
        const risk = (r) => (r.state === PAWN_STATE.OVERDUE ? 0 : (r.daysToMaturity !== null && r.daysToMaturity <= MATURITY_WARN_DAYS ? 1 : 2));
        if (risk(a) !== risk(b)) return risk(a) - risk(b);
        return b.costPerRupee - a.costPerRupee;
    });
    let left = money(cash);
    for (const r of rows) {
        r.affordable = left >= r.payable && r.payable > 0;
        if (r.affordable) left -= r.payable;
    }
    return { rows, leftover: left };
}

/* ── the writes, as pure transformations ──────────────────────────────────── */

/**
 * Record money paid toward a ticket.
 *
 * Nothing is confirmed by default, because nothing in this app moves a balance
 * without a person saying it happened.
 */
export function addPayment(pawn, { kind = PAY.PART, amount, date, note = '', id, now = 0, confirmed = false } = {}) {
    const p = pawn || {};
    const k = s(kind).toLowerCase();
    if (!PAY_KINDS.has(k)) return { ok: false, reason: 'unknown-kind', pawn: p };
    if (!s(id)) return { ok: false, reason: 'no-id', pawn: p };
    const amt = num(amount);
    if (k !== PAY.REDEEM && k !== PAY.CAPITALISE && !(amt > 0)) {
        return { ok: false, reason: 'no-amount', pawn: p };
    }
    const pay = {
        id: s(id), kind: k, amount: money(amt), date: s(date),
        note: s(note).slice(0, 200), confirmed: !!confirmed, at: num(now),
    };
    return { ok: true, pawn: { ...p, payments: [...arr(p.payments), pay] }, payment: pay };
}

/** Change one payment. The edit that did not exist. */
export function updatePayment(pawn, paymentId, fields = {}) {
    const p = pawn || {};
    const id = s(paymentId);
    let hit = false;
    const payments = arr(p.payments).map((x) => {
        if (!x || s(x.id) !== id) return x;
        hit = true;
        const next = { ...x };
        if (fields.amount !== undefined) next.amount = money(fields.amount);
        if (fields.date !== undefined) next.date = s(fields.date);
        if (fields.note !== undefined) next.note = s(fields.note).slice(0, 200);
        if (fields.kind !== undefined && PAY_KINDS.has(s(fields.kind).toLowerCase())) {
            next.kind = s(fields.kind).toLowerCase();
        }
        return next;
    });
    return { ok: hit, pawn: hit ? { ...p, payments } : p };
}

/** Take one payment back off the ledger. The undo that did not exist. */
export function removePayment(pawn, paymentId) {
    const p = pawn || {};
    const id = s(paymentId);
    const payments = arr(p.payments).filter((x) => x && s(x.id) !== id);
    const hit = payments.length !== arr(p.payments).length;
    return { ok: hit, pawn: hit ? { ...p, payments } : p };
}

export function confirmPayment(pawn, paymentId, { now = 0 } = {}) {
    const p = pawn || {};
    const id = s(paymentId);
    let hit = false;
    const payments = arr(p.payments).map((x) => {
        if (!x || s(x.id) !== id) return x;
        hit = true;
        return { ...x, confirmed: true, confirmedAt: num(now) };
    });
    return { ok: hit, pawn: hit ? { ...p, payments } : p };
}

/** Undo a confirmation. Confirming the wrong row was previously permanent. */
export function unconfirmPayment(pawn, paymentId) {
    const p = pawn || {};
    const id = s(paymentId);
    let hit = false;
    const payments = arr(p.payments).map((x) => {
        if (!x || s(x.id) !== id) return x;
        hit = true;
        const next = { ...x, confirmed: false };
        delete next.confirmedAt;
        return next;
    });
    return { ok: hit, pawn: hit ? { ...p, payments } : p };
}

/**
 * Extend a ticket past its maturity — the renewal.
 *
 * `toMonths` is the TOTAL term measured from the pawn date, because that is how
 * it is spoken about: "extend it to twelve months". `addMonths` is offered for
 * the other way of saying the same thing.
 *
 * See the header for what `rateFrom` and `onInterest` mean; neither is guessed.
 */
export function extendTerm(pawn, {
    toMonths, addMonths: extraMonths, rate, rateFrom = RATE_FROM.START,
    onInterest = ON_INTEREST.CARRY, date, id, now = 0, note = '', confirmed = false,
} = {}) {
    const p = pawn || {};
    if (p.redeemedAt) return { ok: false, reason: 'already-redeemed', pawn: p };
    const terms = termsOf(p);
    if (!terms.length) return { ok: false, reason: 'no-pawn-date', pawn: p };
    if (!s(id)) return { ok: false, reason: 'no-id', pawn: p };

    const start = parseDay(p.pawnDate);
    /* Measured from the maturity that is actually in force, so a ticket whose
     * recorded end date is not a whole number of months from the pawn date is
     * not quietly re-dated by extending it. */
    const matNow = maturityOf(p);
    const current = (start && matNow && matNow > start)
        ? Math.max(1, Math.round(daysBetween(start, matNow) / DAYS_PER_MONTH))
        : terms.reduce((a, t) => a + t.months, 0) || 0;
    let total = Math.floor(num(toMonths));
    if (!(total > 0)) total = current + Math.max(0, Math.floor(num(extraMonths)));
    if (!(total > current)) return { ok: false, reason: 'not-longer', pawn: p };

    const newRate = num(rate) > 0 ? num(rate) : num(terms[terms.length - 1].rate);
    const renewalISO = s(date) || isoOf(maturityOf(p)) || s(p.pawnDate);

    let nextTerms;
    if (s(rateFrom) === RATE_FROM.RENEWAL) {
        /* The months already billed keep the rate they were agreed at, and the
         * new rate applies only to what is being added. */
        const kept = terms.map((t) => ({ ...t }));
        const renewalDay = parseDay(renewalISO) || start;
        const usedMonths = Math.max(0, Math.round(daysBetween(start, renewalDay) / DAYS_PER_MONTH));
        nextTerms = [...kept, {
            id: s(id), startISO: isoOf(renewalDay), months: Math.max(1, total - usedMonths),
            rate: newRate, note: s(note).slice(0, 120), at: num(now),
        }];
    } else {
        /* Re-issued as a longer ticket, so the new rate applies from the pawn
         * date. This is what the owner described, so it is the default. */
        nextTerms = [{
            id: s(id), startISO: s(p.pawnDate), months: total, rate: newRate,
            note: s(note).slice(0, 120), at: num(now),
        }];
    }

    let next = { ...p, terms: nextTerms };
    /* `maturity` is kept in step so anything still reading the old field — a
     * report, an export, a screen not yet updated — does not disagree with the
     * ledger. A record that contradicts itself is worse than an old one. */
    next.maturity = isoOf(maturityOf(next)) || s(p.maturity);
    next.rate = newRate;

    const mode = s(onInterest).toLowerCase();
    let payment = null;
    if (mode === ON_INTEREST.PAID || mode === ON_INTEREST.CAPITALISE) {
        const due = schedule(next, parseDay(renewalISO) || new Date(num(now))).interestDue;
        if (due > 0) {
            const r = addPayment(next, {
                kind: mode === ON_INTEREST.PAID ? PAY.INTEREST : PAY.CAPITALISE,
                amount: due,
                date: renewalISO,
                note: mode === ON_INTEREST.PAID ? 'Interest paid at renewal' : 'Interest rolled into the advance at renewal',
                id: s(id) + '-int',
                now,
                /* Capitalising is not a payment somebody has to confirm having
                 * made — it is a term of the renewal itself. Cash handed over
                 * still waits, like every other payment in this app. */
                confirmed: mode === ON_INTEREST.CAPITALISE ? true : !!confirmed,
            });
            if (r.ok) { next = r.pawn; payment = r.payment; }
        }
    }

    return { ok: true, pawn: next, payment, terms: nextTerms, totalMonths: total, rate: newRate };
}

/** Undo a renewal: drop the last term and anything it wrote. */
export function undoLastExtension(pawn) {
    const p = pawn || {};
    const terms = arr(p.terms);
    if (terms.length < 2) return { ok: false, reason: 'nothing-to-undo', pawn: p };
    const dropped = terms[terms.length - 1];
    const kept = terms.slice(0, -1);
    const payments = arr(p.payments).filter((x) => x && s(x.id) !== s(dropped.id) + '-int');
    const next = { ...p, terms: kept, payments };
    next.maturity = isoOf(maturityOf(next)) || '';
    next.rate = num(kept[kept.length - 1].rate);
    return { ok: true, pawn: next, dropped };
}

/**
 * The item came back.
 *
 * It writes the final payment as well as stamping the date, because a ticket
 * closed with no closing payment in its history is a ledger that does not add
 * up. What was paid is what was owed on the day.
 */
export function redeem(pawn, { date, id, now = 0, amount } = {}) {
    const p = pawn || {};
    if (p.redeemedAt) return { ok: false, reason: 'already-redeemed', pawn: p };
    const on = s(date) || isoOf(parseDay(new Date(num(now)).toISOString()));
    const st = schedule(p, parseDay(on) || new Date(num(now)));
    const paid = num(amount) > 0 ? num(amount) : st.payable;
    let next = { ...p };
    if (s(id)) {
        const r = addPayment(next, {
            kind: PAY.REDEEM, amount: paid, date: on, note: 'Redeemed', id, now, confirmed: true,
        });
        if (r.ok) next = r.pawn;
    }
    return {
        ok: true,
        pawn: { ...next, redeemedAt: on, state: PAWN_STATE.REDEEMED, redeemedFor: paid },
        paid,
    };
}

/** Undo a redemption. Pressing the wrong button was previously permanent. */
export function unredeem(pawn) {
    const p = pawn || {};
    if (!p.redeemedAt && s(p.state).toUpperCase() !== PAWN_STATE.REDEEMED) {
        return { ok: false, reason: 'not-redeemed', pawn: p };
    }
    const next = { ...p, payments: arr(p.payments).filter((x) => x && s(x.kind).toLowerCase() !== PAY.REDEEM) };
    delete next.redeemedAt;
    delete next.redeemedFor;
    next.state = PAWN_STATE.ACTIVE;
    return { ok: true, pawn: next };
}

/** The unconfirmed payments, in the shape the dashboard queue already draws. */
export function pendingPawn(pawns, asOf) {
    const rows = [];
    for (const p of arr(pawns)) {
        if (!p || !p.id) continue;
        for (const pay of paymentsOf(p)) {
            if (pay.confirmed) continue;
            rows.push({
                key: 'pawn:' + p.id + ':' + pay.id,
                kind: 'outflow',
                source: 'pawn',
                sourceId: p.id,
                eventId: pay.id,
                name: s(p.item) || 'Pawned item',
                company: pay.kind === PAY.INTEREST ? 'Interest'
                    : pay.kind === PAY.PRINCIPAL ? 'Off the advance' : 'Part payment',
                amount: pay.amount,
                monthKey: s(pay.date).slice(0, 7),
                dueISO: s(pay.date),
                state: 'PENDING',
                daysLate: 0,
                late: false,
            });
        }
    }
    rows.sort((a, b) => (a.dueISO < b.dueISO ? -1 : a.dueISO > b.dueISO ? 1 : 0));
    return rows;
}

const API = {
    PAWN_STATE, PAY, RATE_FROM, ON_INTEREST, MATURITY_WARN_DAYS,
    parseDay, isoOf, daysBetween, addMonths, monthsElapsed,
    termsOf, maturityOf, rateOn, normPayment, paymentsOf,
    schedule, pawnStatus, pawnTotals, effectiveAnnual, clearFirst,
    addPayment, updatePayment, removePayment, confirmPayment, unconfirmPayment,
    extendTerm, undoLastExtension, redeem, unredeem, pendingPawn,
};

if (typeof window !== 'undefined') window.WFPawn = API;

export default API;
