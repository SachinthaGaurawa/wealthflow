/* =============================================================================
 * test/ai_matrix_test.js — the Parallel AI Matrix
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG, STATED PLAINLY
 *
 * api/ai.js has always fired every engine in parallel. On the default path for
 * prose and chat it then read exactly one of them — the first to return —
 * and discarded the other fifteen answers unread. Sixteen witnesses, one
 * testimony taken.
 *
 * These tests hold that door shut. The central one is `no silos`: given more
 * than one answer, a decision may not rest on a single engine without SAYING
 * that it does. Everything else here supports that claim or guards a way it
 * could be lost.
 *
 * No network, no clock, no environment — `decide()` is handed the results a
 * fan-out would have produced.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    TASK, SPECIALISTS, orderFor, normaliseReply, tokensOf, similarity,
    numbersOf, numbersAgree, ordinalsOf, monthsOf, contradicts, sameClaim, isNearMiss,
    parseJson, fieldVote, decide, trustworthy,
} from '../api/ai-matrix.mjs';

const ok = (name, reply, provider) => ({ ok: true, name, reply, provider: provider || name.toLowerCase(), ms: 10 });
const bad = (name, error) => ({ ok: false, name, error: error || 'timeout', ms: 20 });

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RULE THE WHOLE MODULE EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('no silos: one engine is never quietly the answer', () => {
    it('two engines agreeing produce a corroborated answer, not a race winner', () => {
        const d = decide([
            ok('Groq', 'The loan clears on 5 March 2027.'),
            ok('Gemini', 'The loan clears on 5 March 2027.'),
            ok('Cohere', 'Nothing in the ledger resembles a loan at all.'),
        ], { task: TASK.PROSE });

        expect(d.mode).toBe('corroborated');
        expect(d.corroboration.agreed).toBe(2);
        expect(d.corroboration.of).toBe(3);
        expect(d.reply).toContain('5 March 2027');
    });

    it('the FASTEST engine does not win by being fastest', () => {
        // The old behaviour: first valid reply returned, full stop. Here the
        // first result is the odd one out, and it loses to the pair behind it.
        const d = decide([
            { ...ok('Groq', 'Your balance is fine, spend freely.'), ms: 1 },
            { ...ok('Gemini', 'You go under on 12 October and must not spend now.'), ms: 900 },
            { ...ok('Mistral', 'You go under on 12 October and must not spend now.'), ms: 950 },
        ], { task: TASK.PROSE });

        expect(d.reply).toContain('12 October');
        expect(d.corroboration.dissent.map((x) => x.name)).toContain('Groq');
    });

    it('when nothing corroborates the winner the mode says SPLIT, not consensus', () => {
        const d = decide([
            ok('Groq', 'Alpha beta gamma delta.'),
            ok('Gemini', 'Entirely unrelated words about something else.'),
        ], { task: TASK.PROSE });

        expect(d.mode).toBe('split');
        expect(d.corroboration.agreed).toBe(1);
        expect(trustworthy(d)).toBe(false);
    });

    it('a single answer is returned as SOLO, with the reason named', () => {
        const d = decide([ok('Groq', 'The only answer there was.'), bad('Gemini'), bad('Mistral')], { task: TASK.PROSE });
        expect(d.mode).toBe('solo');
        expect(d.soloReason).toContain('one engine');
        expect(d.failed).toEqual(['Gemini', 'Mistral']);
        expect(trustworthy(d)).toBe(false);
    });

    it('no answers at all is reported as such, never as an empty consensus', () => {
        const d = decide([bad('Groq'), bad('Gemini')], { task: TASK.PROSE });
        expect(d.mode).toBe('none');
        expect(d.reply).toBeNull();
        expect(trustworthy(d)).toBe(false);
    });

    it('EVERY mode that rests on one engine is refused by trustworthy()', () => {
        // The enforcement point. If a future mode is added that can return a
        // one-engine answer, it has to come through here to be trusted.
        for (const results of [
            [ok('A', 'lonely')],                                   // solo
            [ok('A', 'one thing'), ok('B', 'utterly other words')], // split
            [bad('A'), bad('B')],                                  // none
        ]) {
            expect(trustworthy(decide(results, { task: TASK.PROSE }))).toBe(false);
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DELEGATION THAT CANNOT BECOME A SILO
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the specialist leads, and can still be outvoted', () => {
    it('orders the leads for a task first and keeps everyone else', () => {
        const o = orderFor(TASK.VISION, ['Cohere', 'Groq', 'Gemini', 'Unknown']);
        expect(o[0]).toBe('Gemini');
        expect(o).toHaveLength(4);
        expect(o).toContain('Unknown');
    });

    it('is a total order — nobody is dropped, whatever the table says', () => {
        fc.assert(fc.property(
            fc.array(fc.constantFrom('Gemini', 'Groq', 'Cohere', 'Zeta', 'Anthropic'), { maxLength: 8 }),
            (names) => {
                const o = orderFor(TASK.PROSE, names);
                expect(o.length).toBe(names.length);
                expect([...o].sort()).toEqual([...names].sort());
            },
        ), { numRuns: runs(200) });
    });

    it('the lead breaks a tie', () => {
        const d = decide([
            ok('Cohere', 'Answer one, entirely distinct.'),
            ok('Anthropic', 'Answer two, completely different words.'),
        ], { task: TASK.PROSE });
        // Both stand alone, so support is equal; Anthropic leads TASK.PROSE.
        expect(d.provider).toBe('anthropic');
        expect(d.mode).toBe('split');
    });

    it('the lead does NOT beat a majority that disagrees with it', () => {
        // The whole point of the mandate: a CEO may delegate, and may still be
        // told they are wrong by the people who did the work.
        const d = decide([
            ok('Anthropic', 'The rent is due on the third.'),
            ok('Groq', 'The rent is due on the fifteenth.'),
            ok('Mistral', 'The rent is due on the fifteenth.'),
        ], { task: TASK.PROSE });

        expect(d.reply).toContain('fifteenth');
        // Anthropic lands in nearMisses rather than dissent: it reads like the
        // winner and names a different day, which is the more dangerous shape
        // and is reported as such. See the near-miss section below.
        expect(d.corroboration.nearMisses.map((x) => x.name)).toEqual(['Anthropic']);
        expect(trustworthy(d)).toBe(false);
    });

    it('an unknown engine is never excluded, only unranked', () => {
        const d = decide([
            ok('BrandNewEngine', 'Shared conclusion about the figure.'),
            ok('AlsoNew', 'Shared conclusion about the figure.'),
        ], { task: TASK.PROSE });
        expect(d.mode).toBe('corroborated');
        expect(d.corroboration.agreed).toBe(2);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS IN A FINANCIAL APP
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the near miss: reads like agreement, names something else', () => {
    /* WHY THIS SECTION EXISTS, AND WHAT IT CAUGHT.
     *
     * The first version of this module clustered prose on word overlap alone.
     * A test in the section above — a lead engine saying "due on the third"
     * against two saying "due on the fifteenth" — failed, and it failed for a
     * real reason rather than a wrong expectation:
     *
     *     "The rent is due on the third."     vs
     *     "The rent is due on the fifteenth." → overlap 0.71
     *     "You run out on 12 October."        vs
     *     "Your balance goes negative on 12 October." → overlap ~0.4
     *
     * Word overlap scores the CONTRADICTING pair higher than the AGREEING one.
     * The ordering is inverted, so no threshold could have fixed it. The three
     * rent answers all landed in one cluster and the tie went to whichever
     * engine the specialist table ranked first — the exact silo this module
     * exists to remove, rebuilt out of a similarity metric.
     *
     * Corroboration now needs the wording to overlap AND the specifics not to
     * contradict. An obvious disagreement was always safe; this is the shape
     * that is not.
     */
    it('two engines naming different amounts do NOT corroborate each other', () => {
        const d = decide([
            ok('Gemini', 'Your total outstanding balance is 245000 rupees this month.'),
            ok('Mistral', 'Your total outstanding balance is 254000 rupees this month.'),
        ], { task: TASK.PROSE });

        expect(d.mode).toBe('split');                      // NOT corroborated
        expect(d.corroboration.agreed).toBe(1);
        expect(d.corroboration.nearMisses).toHaveLength(1);
        expect(d.corroboration.nearMisses[0].name).toBe('Mistral');
        expect(d.corroboration.numericConflict).toBe(true);
        expect(trustworthy(d)).toBe(false);
    });

    it('a near miss is listed apart from ordinary dissent', () => {
        const d = decide([
            ok('Gemini', 'Your outstanding balance is 245000 rupees this month.'),
            ok('Mistral', 'Your outstanding balance is 254000 rupees this month.'),
            ok('Cohere', 'I have no information about any balance whatsoever.'),
        ], { task: TASK.PROSE });

        expect(d.corroboration.nearMisses.map((x) => x.name)).toEqual(['Mistral']);
        expect(d.corroboration.dissent.map((x) => x.name)).toEqual(['Cohere']);
    });

    it('refuses to trust a near miss even inside a large cluster', () => {
        const d = decide([
            ok('A', 'The payment of 5000 clears on Friday.'),
            ok('B', 'The payment of 5000 clears on Friday.'),
            ok('C', 'The payment of 5000 clears on Friday.'),
            ok('D', 'The payment of 9000 clears on Friday.'),
        ], { task: TASK.PROSE });

        expect(d.mode).toBe('corroborated');
        expect(d.corroboration.agreed).toBe(3);
        expect(d.corroboration.nearMisses.map((x) => x.name)).toEqual(['D']);
        expect(trustworthy(d)).toBe(false);   // three agreeing is not enough
    });

    it('contradicts() only fires when BOTH replies name a specific', () => {
        // Less detail is not disagreement. Otherwise every terser answer would
        // be counted as contradicting the fuller one and nothing would cluster.
        expect(contradicts('You owe 5000.', 'You owe money.')).toBe(false);
        expect(contradicts('You owe 5000.', 'You owe 9000.')).toBe(true);
        expect(contradicts('Due on the third.', 'Due soon.')).toBe(false);
        expect(contradicts('Due on the third.', 'Due on the fifteenth.')).toBe(true);
        expect(contradicts('Due in October.', 'Due in November.')).toBe(true);
        expect(contradicts('Due in October.', 'Due next month.')).toBe(false);
    });

    it('sameClaim needs both halves, and isNearMiss is exactly the gap between them', () => {
        const a = 'The rent is due on the third.';
        const b = 'The rent is due on the fifteenth.';
        const c = 'Nothing here resembles rent in any way.';
        expect(similarity(a, b)).toBeGreaterThan(0.6);   // reads the same
        expect(sameClaim(a, b)).toBe(false);             // is not the same
        expect(isNearMiss(a, b)).toBe(true);
        expect(isNearMiss(a, c)).toBe(false);            // plain disagreement
        expect(sameClaim(a, a)).toBe(true);
    });

    it('reads the ordinal and month vocabularies it claims to', () => {
        expect([...ordinalsOf('due on the fifteenth')]).toEqual(['fifteenth']);
        expect([...monthsOf('due in Oct or November')].sort()).toEqual(['november', 'oct']);
        expect(ordinalsOf('no ordinals here').size).toBe(0);
    });

    it('does not cry conflict when the figures match', () => {
        const d = decide([
            ok('Gemini', 'Your total outstanding balance is 245000 rupees this month.'),
            ok('Mistral', 'Your total outstanding balance is 245,000 rupees this month.'),
        ], { task: TASK.PROSE });
        expect(d.corroboration.numericConflict).toBe(false);
        expect(trustworthy(d)).toBe(true);
    });

    it('reads a formatted figure and a bare one as the same number', () => {
        expect(numbersAgree('1,250.00 due', 'due 1250')).toBe(true);
        expect(numbersAgree('1,250.00 due', 'due 1250.01')).toBe(false);
        expect([...numbersOf('Rs. 1,250.50 and 3 items')].sort((a, b) => a - b)).toEqual([3, 1250.5]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SINHALA
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('Sinhala answers are compared, not erased', () => {
    // An ASCII-only word regex reduces every Sinhala reply to the empty string.
    // Every Sinhala answer would then look identical to every other, and the
    // matrix would report unanimous agreement about nothing at all.
    const A = 'ඔබේ ශේෂය මේ මාසයේ ප්‍රමාණවත් වේ';
    const B = 'ඔබේ ශේෂය මේ මාසයේ ප්‍රමාණවත් වේ';
    const C = 'ඔබ ඔක්තෝබර් මාසයේ මුදල් හිඟ වේ';

    it('keeps Sinhala words through normalisation', () => {
        expect(normaliseReply(A).length).toBeGreaterThan(10);
        expect(tokensOf(A).size).toBeGreaterThan(3);
    });

    it('two identical Sinhala answers are the same claim', () => {
        expect(similarity(A, B)).toBe(1);
    });

    it('two DIFFERENT Sinhala answers are not', () => {
        expect(similarity(A, C)).toBeLessThan(0.6);
    });

    it('corroborates in Sinhala the same way it does in English', () => {
        const d = decide([ok('Gemini', A), ok('Mistral', B), ok('Groq', C)], { task: TASK.PROSE });
        expect(d.mode).toBe('corroborated');
        expect(d.corroboration.agreed).toBe(2);
        expect(d.corroboration.dissent.map((x) => x.name)).toEqual(['Groq']);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * JSON EXTRACTION
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('structured answers are voted on field by field', () => {
    const r = (name, obj) => ok(name, JSON.stringify(obj));

    it('takes the majority value per field, not the majority document', () => {
        const d = decide([
            r('Gemini', { vendor: 'Keells', amount: 4500, type: 'expense' }),
            r('Mistral', { vendor: 'Keells', amount: 4500, type: 'income' }),
            r('Groq', { vendor: 'Cargills', amount: 4500, type: 'expense' }),
        ], { task: TASK.EXTRACTION, json: true });

        expect(d.mode).toBe('consensus');
        expect(d.fields.vendor).toBe('Keells');
        expect(d.fields.amount).toBe(4500);
        expect(d.fields.type).toBe('expense');
        expect(d.fieldAgreement.amount).toBe(1);
        expect(d.fieldAgreement.vendor).toBeCloseTo(2 / 3, 6);
    });

    it('a field only one engine named is reported as uncorroborated, not as agreed', () => {
        const d = decide([
            r('Gemini', { vendor: 'Keells', note: 'possibly a refund' }),
            r('Mistral', { vendor: 'Keells' }),
            r('Groq', { vendor: 'Keells' }),
        ], { task: TASK.EXTRACTION, json: true });
        expect(d.fieldAgreement.vendor).toBe(1);
        expect(d.fieldAgreement.note).toBeCloseTo(1 / 3, 6);
    });

    it('does not split a vote between 12 and "12"', () => {
        const { majority, agreement } = fieldVote([{ amount: 12 }, { amount: '12' }, { amount: 99 }]);
        expect(agreement.amount).toBeCloseTo(2 / 3, 6);
        expect(String(majority.amount)).toBe('12');
    });

    it('reads JSON out of a fenced code block', () => {
        expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
        expect(parseJson('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
        expect(parseJson('not json at all')).toBeNull();
        expect(parseJson('[1,2,3]')).toBeNull();     // an array is not a record
    });

    it('falls back to prose clustering rather than pretending a vote was held', () => {
        const d = decide([
            ok('Gemini', 'I could not read the receipt clearly enough to extract it.'),
            ok('Mistral', 'I could not read the receipt clearly enough to extract it.'),
        ], { task: TASK.EXTRACTION, json: true });
        expect(d.mode).toBe('corroborated');
        expect(d.fields).toBeUndefined();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ROBUSTNESS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('never throws, whatever the engines return', () => {
    it('ignores empty and whitespace-only replies', () => {
        const d = decide([ok('A', '   '), ok('B', ''), ok('C', 'A real answer.')], { task: TASK.PROSE });
        expect(d.mode).toBe('solo');
        expect(d.answered).toEqual(['C']);
    });

    it('survives arbitrary junk', () => {
        fc.assert(fc.property(
            fc.array(fc.record({
                ok: fc.boolean(),
                name: fc.string({ maxLength: 12 }),
                reply: fc.oneof(fc.string({ maxLength: 80 }), fc.constant(null), fc.constant(undefined)),
            }), { maxLength: 6 }),
            (results) => {
                expect(() => decide(results, { task: TASK.PROSE })).not.toThrow();
                const d = decide(results, { task: TASK.PROSE });
                expect(typeof d.mode).toBe('string');
                expect(d.corroboration.agreed).toBeLessThanOrEqual(d.corroboration.of || 1);
            },
        ), { numRuns: runs(300) });
    });

    it('handles a non-array argument without inventing an answer', () => {
        for (const junk of [null, undefined, 'nonsense', 42, {}]) {
            const d = decide(junk, { task: TASK.PROSE });
            expect(d.mode).toBe('none');
            expect(d.reply).toBeNull();
        }
    });

    it('the specialist table names only tasks the router knows', () => {
        // Guards the quiet failure where a task string is renamed in one place:
        // orderFor() would silently return an unranked list for ever after.
        for (const k of Object.keys(SPECIALISTS)) {
            expect(Object.values(TASK)).toContain(k);
        }
        for (const t of Object.values(TASK)) {
            expect(Array.isArray(SPECIALISTS[t])).toBe(true);
        }
    });
});
