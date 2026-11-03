/* The review board's release score: shown, used for one contradiction check, and never the gate.
 *
 * "LLM as a judge" is only worth having when it does not pretend. A reviewer states a 0-100 score beside its verdict. The board
 *   - shows the lowest as the release score,
 *   - refuses a PASS that rates itself under the floor (a reviewer that says "fine, 40/100" has not approved anything),
 *   - treats a missing or garbled score as "not reported", never as a pass and never as a penalty,
 *   - and does NOT make the score the gate: unanimity on a stated PASS and the deterministic checks stay the gate.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runReviewer, tally, REVIEWERS, parseScore, releaseScore, SCORE_FLOOR } from '../consensus-review.mjs';

const ROLE = REVIEWERS[0];
const lane = { role: ROLE, primary: 'p1', fallbacks: [], shared: [] };
const reply = (o) => async (opts) => ({ text: typeof o === 'string' ? o : JSON.stringify(o), provider: opts.only[0] });
const run = (o) => runReviewer(lane, '+const a = 1;\n', false, reply(o));

describe('parseScore', () => {
    it('reads a number, a numeric string, "85/100" and "85%"', () => {
        expect(parseScore({ score: 91 })).toBe(91);
        expect(parseScore({ score: '88' })).toBe(88);
        expect(parseScore({ score: '85/100' })).toBe(85);
        expect(parseScore({ score: '85%' })).toBe(85);
        expect(parseScore({ score: 91.6 })).toBe(92);
    });
    it('refuses what cannot be a 0-100 score: missing, negative, over 100, words, booleans, objects, 0-1 scales', () => {
        for (const v of [undefined, null, -5, 101, 250, 'high', true, {}, [], NaN, 0.9, 1, 0]) expect(parseScore({ score: v }), String(v)).toBe(null);
        expect(parseScore(null)).toBe(null);
        expect(parseScore('x')).toBe(null);
    });
});

describe('releaseScore', () => {
    it('is the lowest stated score among reviewers that voted', () => {
        const r = releaseScore([{ vote: 'pass', score: 95 }, { vote: 'pass', score: 82 }, { vote: 'pass', score: 90 }]);
        expect(r).toEqual({ min: 82, mean: 89, scored: 3, of: 3 });
    });
    it('does not count a reviewer that was unreachable, and says how many scored', () => {
        const r = releaseScore([{ vote: 'pass', score: 90 }, { vote: 'pass', score: null }, { vote: 'unavailable' }]);
        expect(r).toMatchObject({ min: 90, scored: 1, of: 2 });
    });
    it('is "not reported" when nobody scored, never zero', () => {
        expect(releaseScore([{ vote: 'pass' }, { vote: 'pass' }])).toEqual({ min: null, mean: null, scored: 0, of: 2 });
        expect(releaseScore([])).toEqual({ min: null, mean: null, scored: 0, of: 0 });
        expect(releaseScore(undefined).scored).toBe(0);
    });
});

describe('runReviewer with a score', () => {
    it('the floor is 60 unless BOARD_SCORE_FLOOR says otherwise', () => expect(SCORE_FLOOR).toBe(60));

    it('a PASS with a good score stays a pass and carries its score', async () => {
        const v = await run({ verdict: 'PASS', score: 92, reason: 'fine', evidence: '', concerns: [] });
        expect(v).toMatchObject({ vote: 'pass', score: 92 });
    });
    it('a PASS that rates itself under the floor is NOT an approval, and says why', async () => {
        const v = await run({ verdict: 'PASS', score: 40, reason: 'probably fine', evidence: '', concerns: [] });
        expect(v.vote).toBe('fail');
        expect(v.score).toBe(40);
        expect(v.reason).toMatch(/scored its own verdict 40\/100, under the floor of 60/);
        expect(v.evidence).toMatch(/score 40\/100/);
        expect(tally([v, { name: 'x', vote: 'pass' }]).merge).toBe(false);
    });
    it('a PASS exactly at the floor passes', async () => {
        expect((await run({ verdict: 'PASS', score: 60, reason: 'ok', evidence: '', concerns: [] })).vote).toBe('pass');
    });
    it('a PASS with no score, or a garbled one, passes as before: no score is "not reported", not a penalty', async () => {
        for (const score of [undefined, 'n/a', 0.9, null]) {
            const v = await run({ verdict: 'PASS', ...(score === undefined ? {} : { score }), reason: 'fine', evidence: '', concerns: [] });
            expect(v.vote, String(score)).toBe('pass');
            expect(v.score).toBe(null);
        }
    });
    it('a FAIL stays a FAIL whatever the score says (a high score cannot overturn an objection)', async () => {
        const v = await run({ verdict: 'FAIL', score: 99, reason: 'real bug', evidence: '+const a = 1;', concerns: [] });
        expect(v.vote).toBe('fail');
    });
    it('the prompt asks for the score, defines the scale, and says what under 60 means', async () => {
        let seen = '';
        await runReviewer(lane, '+x\n', false, async (o) => { seen = o.prompt; return { text: '{"verdict":"PASS","score":90}', provider: 'p1' }; });
        expect(seen).toMatch(/"score":0-100/);
        expect(seen).toMatch(/90-100 = you looked and found nothing/);
        expect(seen).toMatch(/under 60 = you think it should not ship/);
    });
});

describe('the board report', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'consensus-review.mjs'), 'utf8');
    it('has a Score column and a release-score line that says a score is not the gate', () => {
        expect(src).toMatch(/\| Reviewer \| Model \| Vote \| Score \| Reason \| Evidence \|/);
        expect(src).toMatch(/\*\*Release score: \$\{rs\.min\}\/100\*\*/);
        expect(src).toMatch(/A score is an opinion: the gate is the unanimous stated PASS/);
        expect(src).toMatch(/not reported by the reviewers/);
    });
});
