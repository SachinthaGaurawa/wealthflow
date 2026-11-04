/* =============================================================================
 * test/concept_board_test.js — new ideas are discussed by several AIs first   (owner, 2026-11-04)
 * Pins: which reports go to the board, strict parsing of a vote, a merge that never loses a
 * risk, that the board never vetoes, that one idea is discussed once, and the agent wiring.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as B from '../autonomy/concept-board.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const vote = (o = {}) => JSON.stringify({ clear: true, easy: 'One tap from the home screen', risks: ['Do not change saved records'], first_version: 'A read-only card', missing: '', verdict: 'BUILD', ...o });

describe('which reports are ideas', () => {
    it('takes features and "can you add" requests', () => {
        expect(B.conceptBoardFor({ title: 'x' }, 'feature')).toBe(true);
        expect(B.conceptBoardFor({ title: 'Can you add a savings goal tracker', body: '' }, 'bug')).toBe(true);
    });
    it('leaves defects and layout alone', () => {
        expect(B.conceptBoardFor({ title: 'App crash when I add a loan', body: '' }, 'bug')).toBe(false);
        expect(B.conceptBoardFor({ title: 'Total is wrong', body: '' }, 'bug')).toBe(false);
    });
});

describe('a vote', () => {
    it('is parsed strictly', () => {
        const v = B.parseVote(vote(), 'groq');
        expect(v).toMatchObject({ provider: 'groq', verdict: 'BUILD', first: 'A read-only card' });
        expect(v.risks).toEqual(['Do not change saved records']);
    });
    it('is refused when it is not JSON or has no known verdict', () => {
        expect(B.parseVote('looks good to me')).toBeNull();
        expect(B.parseVote(vote({ verdict: 'MAYBE' }))).toBeNull();
    });
    it('is trimmed to a safe size', () => {
        const v = B.parseVote(vote({ easy: 'x'.repeat(2000), risks: ['a', 'b', 'c', 'd', 'e'] }));
        expect(v.easy.length).toBeLessThanOrEqual(320); expect(v.risks).toHaveLength(3);
    });
});

describe('the merge', () => {
    const v = (o) => B.parseVote(vote(o), o.p || 'p');
    it('keeps every distinct risk once and every easy-to-use idea with its author', () => {
        const s = B.synthesize([v({ p: 'a', risks: ['Slow on old phones'] }), v({ p: 'b', risks: ['slow on old phones', 'Rounding'] }), v({ p: 'c', easy: 'Pre-fill from last month' })]);
        expect(s.risks).toEqual(['Slow on old phones', 'Rounding', 'Do not change saved records']);
        expect(s.easy.map((e) => e.provider)).toEqual(['a', 'b', 'c']);
    });
    it('goes ahead on BUILD, shrinks on BUILD_SMALLER, asks only when most members ask', () => {
        expect(B.synthesize([v({}), v({}), v({})]).verdict).toBe('BUILD');
        expect(B.synthesize([v({ verdict: 'BUILD_SMALLER' }), v({ verdict: 'BUILD_SMALLER' }), v({})]).verdict).toBe('BUILD_SMALLER');
        expect(B.synthesize([v({ verdict: 'ASK_OWNER', missing: 'Which bank?' }), v({ verdict: 'ASK_OWNER' }), v({})]).verdict).toBe('ASK_OWNER');
        expect(B.synthesize([v({ verdict: 'ASK_OWNER', missing: 'Which bank?' }), v({}), v({})]).verdict).toBe('BUILD_SMALLER');
    });
    it('carries the question to the owner only on ASK_OWNER', () => {
        expect(B.synthesize([v({ verdict: 'ASK_OWNER', missing: 'Which bank?' }), v({ verdict: 'ASK_OWNER' })]).question).toBe('Which bank?');
        expect(B.synthesize([v({}), v({})]).question).toBe('');
    });
    it('is a plain BUILD with no voters', () => { expect(B.synthesize([]).verdict).toBe('BUILD'); expect(B.briefFor(B.synthesize([]))).toBe(''); });
});

describe('what the author and the owner see', () => {
    const s = B.synthesize([B.parseVote(vote(), 'a'), B.parseVote(vote({ easy: 'Show it on the dashboard' }), 'b')]);
    it('the brief puts being easy to use first and does not replace the owner\'s words', () => {
        const b = B.briefFor(s);
        expect(b).toMatch(/BOARD BRIEF/); expect(b.indexOf('EASY TO USE')).toBeLessThan(b.indexOf('first version'));
        expect(b).toMatch(/the owner's words above stay the decision/);
    });
    it('the comment is readable, carries the marker, and can be read back', () => {
        const c = B.renderComment(s);
        expect(c).toContain(B.BOARD_MARKER); expect(c).toMatch(/Making it easy to use/);
        expect(B.parseStoredBoard(c)).toMatchObject({ voters: 2, verdict: 'BUILD' });
        expect(c).not.toMatch(/-->[^\n]*-->/);
    });
    it('a damaged stored board is ignored, not trusted', () => {
        expect(B.parseStoredBoard('<!-- wf-board-json:%7Bbroken -->')).toBeNull();
        expect(B.parseStoredBoard('nothing here')).toBeNull();
    });
});

describe('running the board', () => {
    it('asks three providers and merges what comes back', async () => {
        const ask = async (o, n) => { expect(n).toBe(3); expect(o.prompt).toMatch(/EASY to use/); return [{ text: vote(), provider: 'a' }, { text: 'garbage', provider: 'b' }, { text: vote({ verdict: 'BUILD_SMALLER' }), provider: 'c' }]; };
        const s = await B.runConceptBoard({ issueText: 'add a goal tracker', ask });
        expect(s.voters).toBe(2);
    });
    it('never stops the work: a failing provider layer gives an empty board', async () => {
        const s = await B.runConceptBoard({ issueText: 'x', ask: async () => { throw new Error('no providers'); } });
        expect(s).toMatchObject({ voters: 0, verdict: 'BUILD' });
    });
});

describe('wired into the agent', () => {
    const agent = fs.readFileSync(path.join(ROOT, 'autonomous-fix-agent.js'), 'utf8');
    it('discusses an idea once, posts it, and gives the brief to the lanes', () => {
        expect(agent).toMatch(/conceptBoardFor\(/); expect(agent).toMatch(/parseStoredBoard\(prior\.body\)/);
        expect(agent).toMatch(/boardComment\(board\)/); expect(agent).toMatch(/laneBody = shot\.body \+ briefFor\(board\)/);
        expect(agent).toMatch(/body: laneBody, kind/);
    });
    it('does not send a layout report through the board', () => { expect(agent).toMatch(/!lane\.applies && conceptBoardFor/); });
});
