/* =============================================================================
 * test/confirm_test.js
 * -----------------------------------------------------------------------------
 * THE PROPERTY THIS FILE EXISTS FOR
 *
 *   the number printed on the button === the number written to the ledger
 *
 * Not "both are correct" — EQUAL. Two separate assertions that each figure is
 * right would both keep passing after someone changed one of them, which is
 * exactly how the defect being fixed here got in: sw.js showed a button reading
 * "Yes", and index.html wrote `amount: l.monthly`. Each was defensible alone.
 * Together they meant a lock-screen tap recorded a figure the owner was never
 * shown and never agreed to.
 *
 * So the test below reads the digits back out of the button's own title and
 * asserts the intent carries that same value. Change either side without the
 * other and it fails.
 *
 * WHY "DIFFERENT AMOUNT" WRITES NOTHING
 *
 * The tempting shortcut is to have it record the scheduled figure and let the
 * owner correct it later. That is the original bug with an extra step: a number
 * nobody gave, sitting in the ledger, driving projections until someone
 * notices. It writes nothing and defers, and there is a test asserting the
 * absence rather than the presence.
 *
 * WHY IDEMPOTENCE IS NOT OPTIONAL HERE
 *
 * A notification can be delivered twice, tapped twice, or replayed out of an
 * outbox after the phone comes back online. The one that matters most is a
 * stale notification tapped a week after the owner already entered the real
 * amount by hand — that must not overwrite 150,000 with the scheduled 127,000.
 * Its own test, because it is the case that silently destroys a correction.
 *
 * WHAT THESE TESTS CANNOT DO
 *
 * They cannot prove a real phone renders three actions, or that a service
 * worker can reach the queue with the app closed. Both need a device and a
 * push subscription. What is pinned is everything that decides WHAT gets
 * written once a button is tapped, which is where the money is.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import C, {
    ANSWER, KIND, ACTION_ID, APPLIED,
    answerFor, money, notificationFor, intentFrom,
    applyToLoan, applyToIncome, queue, drain,
} from '../wealthflow-confirm.js';

const LOAN_DUE = { kind: KIND.LOAN, id: 'loan-1', month: '2026-08', amount: 127_000, name: 'HNB Home Loan' };
const INCOME_DUE = { kind: KIND.INCOME, id: 'inc-1', month: '2026-08', amount: 450_000, name: 'Salary' };

/** Pull the digits back out of a rendered button title. */
const digitsIn = (title) => Number(String(title).replace(/[^\d]/g, ''));

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the button says exactly what it writes', () => {
    it.each([
        ['a loan payment', LOAN_DUE],
        ['an income', INCOME_DUE],
    ])('records the figure shown on the button, for %s', (_why, due) => {
        /* THE TEST THIS FILE EXISTS FOR. The assertion is equality between the
         * two, read independently — the label is parsed back to a number rather
         * than compared to a constant, so changing either side alone fails. */
        const n = notificationFor(due);
        const yes = n.actions.find((a) => a.action === ACTION_ID[ANSWER.AS_SCHEDULED]);
        const intent = intentFrom(yes.action, n.data);

        expect(digitsIn(yes.title), 'the button did not show a figure at all').toBeGreaterThan(0);
        expect(intent.amount, 'the ledger would record a number the button never showed')
            .toBe(digitsIn(yes.title));
    });

    it('shows the amount in the question too, not only on the button', () => {
        expect(digitsIn(notificationFor(LOAN_DUE).body)).toBe(127_000);
        expect(digitsIn(notificationFor(INCOME_DUE).body)).toBe(450_000);
    });

    it('takes the amount from the notification, not from a fresh lookup', () => {
        /* The figure travels with the notification. Looking it up again at tap
         * time is how the shown and the written values drift apart when the
         * instalment changes between the two moments. */
        const n = notificationFor(LOAN_DUE);
        n.data.amount = 999;                     // as if the schedule changed since
        expect(intentFrom(ACTION_ID[ANSWER.AS_SCHEDULED], n.data).amount).toBe(999);
    });

    it('offers a way out when the amount was not the scheduled one', () => {
        const titles = notificationFor(LOAN_DUE).actions.map((a) => a.title);
        expect(titles).toHaveLength(3);
        expect(titles.some((t) => /different/i.test(t))).toBe(true);
        expect(titles.some((t) => /not yet/i.test(t))).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT "DIFFERENT" MUST NOT DO
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('an amount the owner has not given is never invented', () => {
    it('carries no figure at all', () => {
        const i = intentFrom(ACTION_ID[ANSWER.DIFFERENT], notificationFor(LOAN_DUE).data);
        expect(i.answer).toBe(ANSWER.DIFFERENT);
        expect(i.amount, 'recording the scheduled amount here is the original bug, with a step').toBe(null);
    });

    it('writes nothing to the loan and asks for the app', () => {
        const loan = { id: 'loan-1', monthly: 127_000, payments: [] };
        const r = applyToLoan(loan, intentFrom(ACTION_ID[ANSWER.DIFFERENT], notificationFor(LOAN_DUE).data));
        expect(r.outcome).toBe(APPLIED.NEEDS_APP);
        expect(r.payments).toEqual([]);
    });

    it('writes nothing to income either', () => {
        const r = applyToIncome({}, intentFrom(ACTION_ID[ANSWER.DIFFERENT], notificationFor(INCOME_DUE).data));
        expect(r.outcome).toBe(APPLIED.NEEDS_APP);
        expect(r.received).toEqual({});
    });

    it('"not yet" writes nothing and is not an error', () => {
        const loan = { id: 'loan-1', payments: [] };
        const r = applyToLoan(loan, intentFrom(ACTION_ID[ANSWER.NOT_YET], notificationFor(LOAN_DUE).data));
        expect(r.ok).toBe(true);
        expect(r.outcome).toBe(APPLIED.DEFERRED);
        expect(r.payments).toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * TAPPED TWICE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the same answer arriving more than once', () => {
    const intent = () => intentFrom(ACTION_ID[ANSWER.AS_SCHEDULED], notificationFor(LOAN_DUE).data, 1000);

    it('records once, however many times it is applied', () => {
        const loan = { id: 'loan-1', monthly: 127_000, payments: [] };
        const first = applyToLoan(loan, intent());
        const second = applyToLoan({ ...loan, payments: first.payments }, intent());
        expect(first.outcome).toBe(APPLIED.RECORDED);
        expect(second.outcome).toBe(APPLIED.ALREADY);
        expect(second.payments).toHaveLength(1);
    });

    it('NEVER overwrites an amount the owner entered by hand', () => {
        /* The case that silently destroys a correction: the owner paid 150,000,
         * typed it in, and a week later taps the stale notification still
         * sitting on the lock screen. */
        const loan = {
            id: 'loan-1', monthly: 127_000,
            payments: [{ month: '2026-08', paid: true, amount: 150_000, notes: 'typed by hand' }],
        };
        const r = applyToLoan(loan, intent());
        expect(r.outcome).toBe(APPLIED.ALREADY);
        expect(r.payments[0].amount, 'a correction was overwritten by the scheduled figure').toBe(150_000);
        expect(r.payments[0].notes).toBe('typed by hand');
    });

    it('does the same for income', () => {
        const i = intentFrom(ACTION_ID[ANSWER.AS_SCHEDULED], notificationFor(INCOME_DUE).data, 1000);
        const first = applyToIncome({}, i);
        const second = applyToIncome(first.received, i);
        expect(second.outcome).toBe(APPLIED.ALREADY);
        expect(Object.keys(second.received)).toHaveLength(1);
    });

    it('replaces an unpaid placeholder rather than duplicating the month', () => {
        const loan = { id: 'loan-1', monthly: 127_000, payments: [{ month: '2026-08', paid: false }] };
        const r = applyToLoan(loan, intent());
        expect(r.outcome).toBe(APPLIED.RECORDED);
        expect(r.payments).toHaveLength(1);
        expect(r.payments[0].paid).toBe(true);
    });

    it('does not modify what it was handed', () => {
        const loan = { id: 'loan-1', monthly: 127_000, payments: [] };
        const before = JSON.stringify(loan);
        applyToLoan(loan, intent());
        expect(JSON.stringify(loan)).toBe(before);
    });

    it('keys income the way index.html already does', () => {
        // `<id>_<YYYY-MM>`. A different key means the two paths disagree about
        // whether a month has been answered, and the owner is asked twice.
        const r = applyToIncome({}, intentFrom(ACTION_ID[ANSWER.AS_SCHEDULED], notificationFor(INCOME_DUE).data));
        expect(r.key).toBe('inc-1_2026-08');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PARSING WHAT COMES BACK
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('reading a tapped action', () => {
    it('maps every action it declares', () => {
        for (const [answer, id] of Object.entries(ACTION_ID)) {
            expect(answerFor(id)).toBe(answer);
        }
    });

    it.each([
        ['an action from some other feature', 'open_app'],
        ['an empty action', ''],
        ['no action at all', undefined],
    ])('returns null for %s', (_why, id) => {
        expect(answerFor(id)).toBe(null);
        expect(intentFrom(id, notificationFor(LOAN_DUE).data)).toBe(null);
    });

    it.each([
        ['no id', { kind: 'loan', month: '2026-08' }],
        ['no month', { kind: 'loan', id: 'loan-1' }],
        ['nothing at all', {}],
        ['not an object', null],
    ])('refuses a half-formed notification with %s', (_why, data) => {
        expect(intentFrom(ACTION_ID[ANSWER.AS_SCHEDULED], data)).toBe(null);
    });

    it('defaults an unrecognised kind to income rather than guessing a loan', () => {
        // Income writes to a map keyed by month; a loan writes into a payment
        // schedule. Mistaking one for the other is the more damaging direction.
        const i = intentFrom(ACTION_ID[ANSWER.AS_SCHEDULED], { kind: 'nonsense', id: 'x', month: '2026-08', amount: 5 });
        expect(i.kind).toBe(KIND.INCOME);
    });

    it('refuses to apply an answer to the wrong kind of ledger', () => {
        /* An income intent pushed into a loan's payment schedule writes a
         * payment against a debt that was never paid, and a loan intent into
         * the income map credits money that never arrived. The guards against
         * that were the one thing no test reached on the first mutation run —
         * both directions, because they are separate lines. */
        const incomeIntent = intentFrom(ACTION_ID[ANSWER.AS_SCHEDULED], notificationFor(INCOME_DUE).data);
        const loanIntent = intentFrom(ACTION_ID[ANSWER.AS_SCHEDULED], notificationFor(LOAN_DUE).data);

        const toLoan = applyToLoan({ id: 'loan-1', payments: [] }, incomeIntent);
        expect(toLoan.ok, 'an income answer was written into a loan schedule').toBe(false);
        expect(toLoan.outcome).toBe(APPLIED.NOT_APPLICABLE);
        expect(toLoan.payments).toBeUndefined();

        const toIncome = applyToIncome({}, loanIntent);
        expect(toIncome.ok, 'a loan answer credited income that never arrived').toBe(false);
        expect(toIncome.outcome).toBe(APPLIED.NOT_APPLICABLE);
        expect(toIncome.received).toBeUndefined();
    });

    it('never throws on hostile input', () => {
        for (const bad of [null, undefined, 0, 'x', [], { data: 1 }]) {
            expect(() => intentFrom(bad, bad)).not.toThrow();
            expect(() => notificationFor(bad)).not.toThrow();
            expect(() => applyToLoan(bad, bad)).not.toThrow();
            expect(() => applyToIncome(bad, bad)).not.toThrow();
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE OUTBOX
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('answers captured while the app was closed', () => {
    const mk = (id, month, answer = ANSWER.AS_SCHEDULED) =>
        intentFrom(ACTION_ID[answer], { kind: KIND.LOAN, id, month, amount: 100 }, 1);

    it('keeps only the latest answer for one item and month', () => {
        /* Tapped "Not yet", then thought better of it and tapped "Yes". Two
         * contradictory answers in the queue would apply in whatever order the
         * drain happened to run. */
        let q = [];
        q = queue(q, mk('loan-1', '2026-08', ANSWER.NOT_YET));
        q = queue(q, mk('loan-1', '2026-08', ANSWER.AS_SCHEDULED));
        expect(q).toHaveLength(1);
        expect(q[0].answer).toBe(ANSWER.AS_SCHEDULED);
    });

    it('keeps answers for different months side by side', () => {
        let q = queue([], mk('loan-1', '2026-07'));
        q = queue(q, mk('loan-1', '2026-08'));
        expect(q).toHaveLength(2);
    });

    it('clears what it applied and keeps only what still needs a person', () => {
        const q = [mk('a', '2026-08'), mk('b', '2026-08', ANSWER.DIFFERENT), mk('c', '2026-08')];
        const { done, keep } = drain(q, (i) => (i.answer === ANSWER.DIFFERENT ? APPLIED.NEEDS_APP : APPLIED.RECORDED));
        expect(done).toHaveLength(3);
        expect(keep).toHaveLength(1);
        expect(keep[0].id).toBe('b');
    });

    it('one bad intent does not strand the rest of the queue', () => {
        const q = [mk('a', '2026-08'), mk('boom', '2026-08'), mk('c', '2026-08')];
        const { done, keep } = drain(q, (i) => {
            if (i.id === 'boom') throw new Error('no such loan');
            return APPLIED.RECORDED;
        });
        expect(done).toHaveLength(3);
        expect(keep, 'a failing intent would be retried forever').toHaveLength(0);
    });

    it('drains an empty or malformed queue without complaint', () => {
        for (const bad of [[], null, undefined, [null, undefined]]) {
            expect(drain(bad, () => APPLIED.RECORDED).keep).toEqual([]);
        }
    });

    it('exports the whole contract', () => {
        for (const fn of ['notificationFor', 'intentFrom', 'applyToLoan', 'applyToIncome', 'queue', 'drain']) {
            expect(typeof C[fn], fn).toBe('function');
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RENDERING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the figure on a lock screen', () => {
    it.each([
        [127000, '127,000'],
        [450000, '450,000'],
        [1284933.11, '1,284,933'],
        [0, '0'],
    ])('renders %s readably', (n, expected) => {
        expect(money(n)).toBe(expected);
    });

    it('does not render a currency symbol it might get wrong', () => {
        expect(money(127000)).not.toMatch(/[A-Za-z$₨]/);
    });

    it('survives a missing or nonsense amount', () => {
        for (const bad of [null, undefined, NaN, 'abc']) expect(money(bad)).toBe('0');
    });
});
