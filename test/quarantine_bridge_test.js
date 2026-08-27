/* =============================================================================
 * test/quarantine_bridge_test.js
 * -----------------------------------------------------------------------------
 * This module exists so a held statement row can reach the review queue. The
 * queue itself is not under test here — it works, and it has its own file. What
 * is under test is the translation, and two properties of it carry real weight.
 *
 * THE PRE-SELECTION IS A SAFETY CONTROL, NOT A CONVENIENCE.
 *
 * The card opens with both dropdowns already set, and the button beside them
 * files what they say. That is the one-tap review the owner asked for, and it
 * means a wrong pre-selection is confirmed exactly as fast as a right one — the
 * owner is not reading, that is the entire point of pre-selecting.
 *
 * So the tests below hammer one rule: the module offered may never be one whose
 * direction disagrees with the direction the bank proved. A row the router sent
 * to `expenses` on money that came IN must not open on `expenses`. That row is
 * quarantined precisely because those two disagree, and offering the disputed
 * answer as the default is worse than offering nothing.
 *
 * THE HASH IS WHAT STOPS THE SAME ROW BEING ASKED ABOUT TWICE.
 *
 * Pub/Sub delivers at least once. Redelivery is normal operation, and a mailbox
 * re-scan after a history id ages out produces the same statement again. The
 * queue already refuses a hash it has seen; all this module has to do is
 * produce the same hash for the same printed row. There is a test that runs one
 * statement through twice against a real de-duplicating fake and asserts the
 * owner is asked once — not that the hashes are equal, which is the same claim
 * made where it cannot fail.
 *
 * WHAT THESE TESTS CANNOT DO
 *
 * They cannot prove a filed row lands correctly in the ledger. That happens in
 * wfApplyBrainResult, inside index.html, behind wfAllocate — none of which can
 * be imported here. What is pinned instead is the CONTRACT the brain has to
 * meet for that code to do the right thing: a magnitude in `amount`, the
 * direction carried by the module, and the field names each module reads. Those
 * were read off the existing brain construction sites rather than assumed, and
 * a test asserts the amount is never negative, because a negative amount would
 * be filed as a negative expense by a writer with no reason to expect one.
 * ===========================================================================*/

import { describe, it, expect, vi } from 'vitest';
import Q, { rowHash, preselect, reasonFor, toBrain, toReview } from '../wealthflow-quarantine.js';
import { QUARANTINE, MODULE_DIRECTION, PROVEN_SOURCES } from '../wealthflow-mail-intake.js';

const held = (over = {}) => {
    const { row, routed, ...rest } = over;
    return {
        scope: 'row',
        reason: QUARANTINE.LOW_CONFIDENCE,
        detail: { confidence: 0.41, module: 'expenses' },
        bank: 'HNB',
        id: 'stmt-7',
        ...rest,
        row: {
            date: '2026-02-11',
            desc: 'POS 412345XXXXXX7788 SPAR SUPERMARKET COL 03',
            amount: 4820.5,
            direction: 'debit',
            directionSource: 'balance',
            ...(row || {}),
        },
        routed: { module: 'expenses', confidence: 0.41, needsReview: true, ...(routed || {}) },
    };
};

/** A stand-in for wfReview.add that de-duplicates on hash, as the real one does. */
const fakeQueue = () => {
    const seen = new Set();
    const calls = [];
    const add = async (brain, reason) => {
        calls.push({ brain, reason });
        if (brain && brain.hash && seen.has(brain.hash)) return null;
        if (brain && brain.hash) seen.add(brain.hash);
        return 'item-' + calls.length;
    };
    add.calls = calls;
    return add;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PRE-SELECTION
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('what the two dropdowns open on', () => {
    it('offers the router’s own answer when it agrees with the bank', () => {
        expect(preselect(held())).toEqual({ module: 'expenses', cat: null, safe: true });
    });

    it('carries a category across when there is one', () => {
        const p = preselect(held({ routed: { module: 'subscriptions', category: 'Subscriptions' } }));
        expect(p).toEqual({ module: 'subscriptions', cat: 'Subscriptions', safe: true });
    });

    it('refuses to open on a module that contradicts the bank', () => {
        /* THE TEST THIS FILE EXISTS FOR.
         *
         * Money came IN and the description read like a purchase — which is
         * exactly why the row is held. Opening the card on `expenses` and
         * putting a green button next to it turns a detected contradiction into
         * a one-tap misfiling. */
        const p = preselect(held({
            row: { direction: 'credit', directionSource: 'balance' },
            routed: { module: 'expenses', category: 'Dining', confidence: 0.9 },
        }));
        expect(p.module).toBe('income');
        expect(p.safe).toBe(false);
        expect(MODULE_DIRECTION[p.module]).toBe('credit');
    });

    it('drops the category too when the module it came with was rejected', () => {
        // Keeping "Dining" while dropping `expenses` keeps the half of the
        // answer that has no evidence behind it.
        const p = preselect(held({
            row: { direction: 'credit', directionSource: 'balance' },
            routed: { module: 'expenses', category: 'Dining' },
        }));
        expect(p.cat).toBe(null);
    });

    it('never offers a module that disagrees with the direction, for any pairing', () => {
        /* Exhaustive rather than illustrative: every module the cross-check
         * knows a direction for, against both directions. */
        for (const module of Object.keys(MODULE_DIRECTION)) {
            for (const direction of ['credit', 'debit']) {
                const p = preselect(held({ row: { direction, directionSource: 'balance' }, routed: { module } }));
                const implied = MODULE_DIRECTION[p.module];
                expect(implied, `${module} on a ${direction} offered ${p.module}`).toBe(direction);
            }
        }
    });

    it('leaves a module that is legitimately either way alone', () => {
        /* Loans and goal allocations have no fixed direction — a loan row can be
         * a repayment out or a disbursement in. Substituting a "safe" module for
         * one of those would be inventing a constraint the data does not have. */
        for (const module of ['loans', 'goal_alloc']) {
            expect(MODULE_DIRECTION[module]).toBeUndefined();
            expect(preselect(held({ routed: { module } })).module).toBe(module);
        }
    });

    it('falls back to a real module when the router produced none', () => {
        expect(preselect(held({ routed: { module: '' } })).module).toBe('expenses');
        expect(preselect(held({ row: { direction: 'credit' }, routed: { module: '' } })).module).toBe('income');
    });

    it('never throws on a malformed record', () => {
        for (const bad of [null, undefined, {}, { row: null, routed: null }]) {
            expect(() => preselect(bad)).not.toThrow();
            expect(preselect(bad).module).toBeTruthy();
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BRAIN
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the object handed to the review queue', () => {
    it('puts a magnitude in the amount and the direction in the module', () => {
        /* Every existing brain follows this: suggested_fields.amount is
         * parsed.amount, and income and expenses are told apart by module, never
         * by a sign. A negative here is filed as a negative expense. */
        const b = toBrain(held({ row: { amount: -4820.5 } }));
        expect(b.parsed.amount).toBe(4820.5);
        expect(b.routed.suggested_fields.amount).toBe(4820.5);
        expect(b.routed.module).toBe('expenses');
    });

    it('is never negative, whatever the row said', () => {
        for (const amount of [-1, -0.01, -999999, 0, 12]) {
            expect(toBrain(held({ row: { amount } })).parsed.amount).toBeGreaterThanOrEqual(0);
        }
    });

    it('sets both descriptive fields, because each module reads its own', () => {
        // income reads `source`, expenses read `desc`. Guessing between them
        // leaves whichever module the owner picks with a blank name.
        const f = toBrain(held()).routed.suggested_fields;
        expect(f.source).toBeTruthy();
        expect(f.desc).toBe(f.source);
    });

    it('prefers the identified vendor over the raw descriptor', () => {
        const b = toBrain(held({ osint: { vendor: 'SPAR SUPERMARKET' } }));
        expect(b.resolved_merchant.name).toBe('SPAR SUPERMARKET');
    });

    it('falls back to the descriptor when nothing identified it', () => {
        expect(toBrain(held()).resolved_merchant.name).toContain('SPAR SUPERMARKET');
    });

    it('dates the row from the statement, not from now', () => {
        const b = toBrain(held());
        expect(new Date(b.parsed.timestamp).toISOString().slice(0, 10)).toBe('2026-02-11');
        expect(b.routed.suggested_fields.date).toBe(b.parsed.timestamp);
    });

    it('does not invent a date the statement did not carry', () => {
        const before = Date.now();
        const b = toBrain(held({ row: { date: '' } }));
        expect(b.parsed.timestamp).toBeGreaterThanOrEqual(before);
    });

    it('marks the row as verified only when the bank’s own figures proved it', () => {
        for (const src of PROVEN_SOURCES) {
            expect(toBrain(held({ row: { directionSource: src } })).parsed.balanceVerified, src).toBe(true);
        }
        for (const src of ['wording', 'assumed', '']) {
            expect(toBrain(held({ row: { directionSource: src } })).parsed.balanceVerified, src).toBe(false);
        }
    });

    it('always arrives flagged for review, never as a settled row', () => {
        expect(toBrain(held()).routed.needsReview).toBe(true);
        expect(toBrain(held()).classified).toBe(false);
    });

    it('reports the confidence the router actually had, not a flattering one', () => {
        /* This row was held back BECAUSE the router was 41% sure. Writing a 1
         * into the object that records why it is on a review card is a lie in
         * the data, and it is the number anything later would read to decide
         * how much to trust the guess beside it. */
        const b = toBrain(held({ detail: { confidence: 0.41 }, routed: { confidence: 0.41 } }));
        expect(b.routed.confidence).toBe(0.41);
        expect(b.resolved_merchant.confidence).toBe(0.41);
    });

    it('records that the pre-selection had to be substituted', () => {
        const b = toBrain(held({
            row: { direction: 'credit', directionSource: 'balance' },
            routed: { module: 'expenses' },
        }));
        expect(b.statement.preselectSafe).toBe(false);
        expect(b.routed.module).toBe('income');
    });

    it('never throws on a malformed record', () => {
        for (const bad of [null, undefined, {}, { row: {} }]) {
            expect(() => toBrain(bad)).not.toThrow();
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IDENTITY ACROSS DELIVERIES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the same printed row is the same row', () => {
    it('hashes from what the bank printed and nothing else', () => {
        expect(rowHash(held())).toBe(rowHash(held()));
    });

    it('survives the whitespace and casing changing between deliveries', () => {
        expect(rowHash(held({ row: { desc: 'pos   412345XXXXXX7788   spar supermarket col 03' } })))
            .toBe(rowHash(held()));
    });

    it.each([
        ['a different amount', { row: { amount: 4820.51 } }],
        ['a different date', { row: { date: '2026-02-12' } }],
        ['a different direction', { row: { direction: 'credit' } }],
        ['a different bank', { bank: 'DFCC' }],
        ['a different merchant', { row: { desc: 'POS KEELLS SUPER' } }],
    ])('is a different row when it has %s', (_why, over) => {
        expect(rowHash(held(over))).not.toBe(rowHash(held()));
    });

    it('does not change because the statement was processed again', () => {
        /* If the hash moved with the delivery, the queue's de-duplication would
         * never fire and every redelivery would re-ask the owner about every
         * row. Pub/Sub redelivers as a matter of course. */
        expect(rowHash({ ...held(), id: 'stmt-99', detail: { confidence: 0.9 } }))
            .toBe(rowHash(held()));
    });

    it('is the exact string it is, so nothing can be quietly folded into it', () => {
        /* A golden value rather than a comparison, because a comparison of two
         * hashes taken in the same millisecond cannot see a Date.now() folded
         * into the recipe — that mutation survived the first run of this file
         * against a test named for exactly that defect. The format IS the
         * contract across deliveries: changing it silently invalidates every
         * de-duplication already recorded, so it should have to be changed
         * here, deliberately. */
        expect(rowHash(held()))
            .toBe('wfmail|HNB|2026-02-11|4820.50|debit|POS 412345XXXXXX7788 SPAR SUPERMARKET COL 03');
    });

    it('is the same an hour later', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-02-11T08:00:00Z'));
            const first = rowHash(held());
            vi.setSystemTime(new Date('2026-02-11T09:00:00Z'));
            expect(rowHash(held()), 'the clock is part of the identity').toBe(first);
        } finally {
            vi.useRealTimers();
        }
    });

    it('asks the owner once when the same statement arrives twice', async () => {
        const add = fakeQueue();
        const rows = [held(), held({ row: { desc: 'POS KEELLS SUPER' } })];
        const first = await toReview(rows, { add });
        const second = await toReview(rows, { add });
        expect(first.queued).toBe(2);
        expect(second.queued, 'the redelivery queued the same rows again').toBe(0);
        expect(second.duplicates).toBe(2);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * HANDING THEM OVER
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('queueing a statement’s held rows', () => {
    it('queues each row with the reason it was actually held for', async () => {
        const add = fakeQueue();
        await toReview([held()], { add });
        expect(add.calls[0].reason).toContain('41%');
        expect(add.calls[0].reason).toContain('category');
    });

    it('says which side disagreed on a contradiction', async () => {
        const r = reasonFor(held({
            reason: QUARANTINE.ROUTING_CONFLICT,
            detail: { bankSays: 'credit', descriptionSays: 'debit' },
        }));
        expect(r).toContain('credit');
        expect(r).toContain('debit');
    });

    it('always passes a reason, so the queue never writes its own', async () => {
        /* wfReview generates a fallback reason from fields a statement row does
         * not have, and would end up saying "Needs your decision" for every
         * single row. An explicit reason wins there — so one is always given. */
        for (const reason of Object.values(QUARANTINE)) {
            expect(reasonFor(held({ reason })).length).toBeGreaterThan(10);
        }
    });

    it('does not put a whole failed statement on a category card', async () => {
        /* A password that did not open, or a PDF with no text layer, is not a
         * row anyone can categorise. Two dropdowns and a green button would be
         * asking a question with no answer. */
        const add = fakeQueue();
        const r = await toReview([{ scope: 'statement', reason: QUARANTINE.PASSWORD_FAILED, bank: 'HNB' }], { add });
        expect(add.calls).toHaveLength(0);
        expect(r.queued).toBe(0);
    });

    it('reports rather than throws when there is no review queue', async () => {
        const r = await toReview([held()], {});
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('no-review-queue');
    });

    it('loses one row to a failure, not the other forty', async () => {
        let n = 0;
        const add = async () => { n += 1; if (n === 2) throw new Error('storage full'); return 'id' + n; };
        const r = await toReview([held(), held({ row: { desc: 'A SHOP' } }), held({ row: { desc: 'B SHOP' } })], { add });
        expect(r.queued).toBe(2);
        expect(r.failed).toBe(1);
    });

    it('handles an empty or absent list without complaint', async () => {
        for (const bad of [[], null, undefined]) {
            expect((await toReview(bad, { add: fakeQueue() })).queued).toBe(0);
        }
    });

    it('exports the same functions on the default object', () => {
        expect(Object.keys(Q).sort()).toEqual(['preselect', 'reasonFor', 'rowHash', 'toBrain', 'toReview']);
    });
});
