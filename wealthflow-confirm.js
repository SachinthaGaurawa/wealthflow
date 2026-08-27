/* =============================================================================
 * wealthflow-confirm.js — a notification button that records what it says
 * -----------------------------------------------------------------------------
 * The app already asks, on the phone's lock screen: "Did you receive your
 * salary?" with [Yes] and [Not yet]. Tapping Yes writes the payment. That whole
 * path exists and works — sw.js declares the actions, forwards the click, and
 * index.html's _silentConfirmIncome / _silentConfirmLoan do the write.
 *
 * ── THE DEFECT IT WAS BUILT WITH ────────────────────────────────────────────
 *
 * The button says "Yes". The code writes a specific number:
 *
 *     l.payments.push({ month, paid: true, amount: l.monthly, ... })
 *
 * Those are not the same claim. "Yes" answers *did it happen*. `l.monthly` is
 * *how much* — a figure the owner was never shown and never agreed to. Tap Yes
 * on a month you actually paid 150,000 against a 100,000 instalment and the
 * ledger records 100,000, silently. Every balance, every projection and every
 * payoff date downstream is then computed from a number nobody entered.
 *
 * It is the worst shape of wrong: invisible, one tap away, and self-consistent
 * afterwards. Nothing later can tell that the 100,000 was assumed rather than
 * observed.
 *
 * ── THE FIX IS NOT A BIGGER PROMPT ──────────────────────────────────────────
 *
 * The obvious repair — open the app and ask for the amount — throws away the
 * thing that makes this feature worth having, which is that it is answered
 * without unlocking anything.
 *
 * So instead the button is made to say what it does. The action is not "Yes",
 * it is "Yes — 127,000", carrying the exact figure that will be written. An
 * answer to a question that states its own amount IS consent to that amount,
 * and the common case stays one tap and no app.
 *
 * A second action, "Different amount", exists for when it is not. That one
 * deliberately writes NOTHING and defers to the app, because a figure the owner
 * has not given cannot be guessed at — which is the whole bug, and re-creating
 * it inside the fix would be a poor joke.
 *
 * There is a test that reads the number out of the button's own label and
 * asserts the intent writes that same number. Not that both are "correct" —
 * that they are EQUAL, which is the property that actually stops this defect
 * coming back when someone edits one of them.
 *
 * ── AT LEAST ONCE, HERE TOO ─────────────────────────────────────────────────
 *
 * A notification can be delivered twice, tapped twice, or replayed from an
 * outbox after the app was offline. So applying an intent is idempotent, and
 * it will not overwrite an amount the owner entered by hand with a scheduled
 * one — a stale notification tapped a week later must not undo a correction.
 * ===========================================================================*/

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const s = (v) => (v == null ? '' : String(v)).trim();
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── 1. what a person can answer ──────────────────────────────────────────── */

export const ANSWER = {
    AS_SCHEDULED: 'as-scheduled',
    DIFFERENT: 'different-amount',
    NOT_YET: 'not-yet',
};

export const KIND = { INCOME: 'income', LOAN: 'loan' };

/* The action ids that travel on the notification. Parsed back on the way in, so
 * they are defined once here rather than spelled out at both ends. */
export const ACTION_ID = {
    [ANSWER.AS_SCHEDULED]: 'yes_scheduled',
    [ANSWER.DIFFERENT]: 'yes_different',
    [ANSWER.NOT_YET]: 'not_yet',
};

const BY_ACTION_ID = Object.fromEntries(Object.entries(ACTION_ID).map(([k, v]) => [v, k]));

/** The answer an action id means, or null if it is not one of ours. */
export function answerFor(actionId) {
    return BY_ACTION_ID[s(actionId)] || null;
}

/* ── 2. the notification ──────────────────────────────────────────────────── */

/* Grouping separators, no currency symbol and no decimals: it has to be
 * readable at a glance on a lock screen, and it has to be the SAME rendering
 * the intent records, so the two can be compared. */
export function money(n) {
    return Math.round(num(n)).toLocaleString('en-US');
}

/**
 * The notification for one due item.
 *
 * The first action carries the amount in its own title. That is the entire
 * point: whoever taps it has been shown the figure that will be written.
 */
export function notificationFor(item) {
    const it = item || {};
    const kind = it.kind === KIND.LOAN ? KIND.LOAN : KIND.INCOME;
    const amount = num(it.amount);
    const name = s(it.name) || (kind === KIND.LOAN ? 'your loan' : 'your income');

    return {
        title: kind === KIND.LOAN ? `Loan payment due — ${name}` : `Income expected — ${name}`,
        body: kind === KIND.LOAN
            ? `Did you pay ${money(amount)} this month?`
            : `Did you receive ${money(amount)}?`,
        actions: [
            { action: ACTION_ID[ANSWER.AS_SCHEDULED], title: `Yes — ${money(amount)}` },
            { action: ACTION_ID[ANSWER.DIFFERENT], title: 'Different amount' },
            { action: ACTION_ID[ANSWER.NOT_YET], title: 'Not yet' },
        ],
        data: {
            kind,
            id: s(it.id),
            month: s(it.month),
            amount,
            type: 'wf_actionable',
        },
    };
}

/* ── 3. the intent ────────────────────────────────────────────────────────── */

/**
 * Turn a tapped action into a durable record of what was answered.
 *
 * Built from the notification's OWN data, so the amount recorded is the amount
 * the button displayed — not a figure looked up again later, which is how the
 * two drift apart in the first place.
 *
 * Returns null for anything unrecognised rather than a half-formed intent.
 */
export function intentFrom(actionId, data, now = Date.now()) {
    const answer = answerFor(actionId);
    const d = data || {};
    const id = s(d.id);
    const month = s(d.month);
    if (!answer || !id || !month) return null;

    return {
        answer,
        kind: d.kind === KIND.LOAN ? KIND.LOAN : KIND.INCOME,
        id,
        month,
        /* Only the as-scheduled answer carries a figure. "Different" must not,
         * because the amount is exactly what is unknown; writing the scheduled
         * one here would rebuild the defect this file exists to remove. */
        amount: answer === ANSWER.AS_SCHEDULED ? num(d.amount) : null,
        at: num(now),
    };
}

/* ── 4. applying it ───────────────────────────────────────────────────────── */

export const APPLIED = {
    RECORDED: 'recorded',
    ALREADY: 'already-recorded',
    NEEDS_APP: 'needs-the-app',
    DEFERRED: 'deferred',
    UNKNOWN_ITEM: 'no-such-item',
    NOT_APPLICABLE: 'not-applicable',
};

/** Was this month already answered, and by whom? */
function existingPayment(loan, month) {
    return arr(loan && loan.payments).find((p) => p && p.month === month) || null;
}

/**
 * Apply one intent to a loan's payment list.
 *
 * Returns `{ ok, outcome, payments }` with a NEW array — the caller decides
 * whether to store it. Nothing here mutates what it was given, so replaying an
 * outbox cannot corrupt state halfway through.
 */
export function applyToLoan(loan, intent) {
    const l = loan || {};
    const i = intent || {};
    if (i.kind !== KIND.LOAN) return { ok: false, outcome: APPLIED.NOT_APPLICABLE };

    if (i.answer === ANSWER.NOT_YET) return { ok: true, outcome: APPLIED.DEFERRED, payments: arr(l.payments) };
    if (i.answer === ANSWER.DIFFERENT) return { ok: true, outcome: APPLIED.NEEDS_APP, payments: arr(l.payments) };

    const existing = existingPayment(l, i.month);
    if (existing && existing.paid) {
        /* Already answered. A notification delivered twice, or tapped again a
         * week later, must not overwrite what is there — least of all replace a
         * figure the owner typed with the scheduled one. */
        return { ok: true, outcome: APPLIED.ALREADY, payments: arr(l.payments) };
    }

    const record = {
        month: i.month,
        paid: true,
        amount: num(i.amount),
        paidAt: num(i.at),
        notes: 'Confirmed from a notification, at the amount shown',
    };
    const payments = arr(l.payments).filter((p) => p && p.month !== i.month).concat(record);
    return { ok: true, outcome: APPLIED.RECORDED, payments, record };
}

/**
 * Apply one intent to the income-received map.
 *
 * Keyed `<id>_<YYYY-MM>`, matching what index.html already writes, so the two
 * paths cannot disagree about whether a month has been answered.
 */
export function applyToIncome(received, intent) {
    const map = received && typeof received === 'object' ? received : {};
    const i = intent || {};
    if (i.kind !== KIND.INCOME) return { ok: false, outcome: APPLIED.NOT_APPLICABLE };

    if (i.answer === ANSWER.NOT_YET) return { ok: true, outcome: APPLIED.DEFERRED, received: { ...map } };
    if (i.answer === ANSWER.DIFFERENT) return { ok: true, outcome: APPLIED.NEEDS_APP, received: { ...map } };

    const key = `${i.id}_${i.month}`;
    if (map[key]) return { ok: true, outcome: APPLIED.ALREADY, received: { ...map } };

    return {
        ok: true,
        outcome: APPLIED.RECORDED,
        key,
        received: {
            ...map,
            [key]: {
                confirmedAt: num(i.at),
                month: i.month,
                amount: num(i.amount),
                notes: 'Confirmed from a notification, at the amount shown',
            },
        },
    };
}

/* ── 5. the outbox ────────────────────────────────────────────────────────── */

/*
 * Answering on the lock screen has to work with the app closed, so the answer
 * is written somewhere durable at the moment of the tap and applied to the
 * ledger when the app is next open. That is the honest version of "without
 * opening the app": the ANSWER is captured with nothing unlocked, and the
 * ledger — which is encrypted with a key that exists only inside the app —
 * catches up the instant it can. Claiming the ledger itself is written from a
 * background context would mean the key had left the vault.
 *
 * These two functions are the queue's whole contract. Where it is stored is the
 * caller's problem; keeping it pure is what lets both the service worker and
 * the page use the same one.
 */

/** Add an intent, replacing any earlier answer for the same item and month. */
export function queue(pending, intent) {
    const list = arr(pending).filter((x) => x && !(x.id === (intent || {}).id && x.month === (intent || {}).month));
    return intent ? list.concat(intent) : list;
}

/**
 * Split a queue into what can be applied now and what is still waiting.
 *
 * Only NEEDS_APP intents stay queued — they are the ones that need a person.
 * Everything else has been dealt with and lingering would replay it forever.
 */
export function drain(pending, apply) {
    const done = [];
    const keep = [];
    for (const intent of arr(pending)) {
        if (!intent) continue;
        let outcome = APPLIED.UNKNOWN_ITEM;
        try {
            outcome = s(apply(intent)) || APPLIED.UNKNOWN_ITEM;
        } catch (_) {
            /* A single bad intent must not strand the rest of the queue. It is
             * dropped rather than retried forever: it has already failed once
             * against real state, and a queue that never empties is a queue
             * that eventually stops being drained at all. */
            outcome = APPLIED.UNKNOWN_ITEM;
        }
        if (outcome === APPLIED.NEEDS_APP) keep.push(intent);
        done.push({ intent, outcome });
    }
    return { done, keep };
}

const API = {
    ANSWER, KIND, ACTION_ID, APPLIED,
    answerFor, money, notificationFor, intentFrom,
    applyToLoan, applyToIncome, queue, drain,
};

/* The page reaches this through window, the same way every other wired
 * module here does; the ESM export is what the tests and other modules
 * import. Both spellings, one object. */
if (typeof window !== 'undefined') window.WFConfirm = API;

export default API;
