import { describe, it, expect } from 'vitest';
import { unanimousDecision, trustworthy } from '../api/ai-matrix.mjs';

const expected = ['Gemini', 'Groq', 'DeepSeek'];
const reply = (name, value) => ({ name, ok: true, reply: JSON.stringify(value) });
const board = (values, roster = expected) => unanimousDecision(values, { expected: roster });
const agreed = () => expected.map(n => reply(n, { category: 'expenses', amount: 120, date: '2026-09-12' }));

describe('financial parallel board unanimity', () => {
    it('accepts matching complete typed decisions from every distinct provider', () => {
        const d = board(agreed());
        expect(d.unanimous).toBe(true);
        expect(trustworthy(d)).toBe(true);
    });
    it('does not count missing, timed out, duplicate or single providers as unanimous', () => {
        const a = agreed();
        for (const results of [a.slice(0, 2), [...a.slice(0, 2), { name: 'DeepSeek', ok: false }], [...a, a[0]]]) {
            expect(board(results).reply).toBeNull();
            expect(trustworthy(board(results))).toBe(false);
        }
        expect(board([a[0]], ['Gemini']).unanimous).toBe(false);
        expect(board([], []).unanimous).toBe(false);
    });
    it('ignores object key order but preserves amount types, array order and missing fields', () => {
        const a = agreed();
        a[2] = reply('DeepSeek', { date: '2026-09-12', amount: 120, category: 'expenses' });
        expect(board(a).unanimous).toBe(true);
        for (const value of [{ category: 'expenses', amount: '120', date: '2026-09-12' }, { category: 'expenses', amount: 120 }, { category: 'loans', amount: 120, date: '2026-09-12' }]) {
            expect(board([...a.slice(0, 2), reply('DeepSeek', value)]).reason).toBe('provider_disagreement');
        }
    });
    it('refuses malformed, qualified, empty and unexpected answers', () => {
        for (const text of ['{}', '[]', 'I cannot verify this: {"category":"expenses"}', 'null', '']) {
            expect(board([...agreed().slice(0, 2), { name: 'DeepSeek', ok: true, reply: text }]).reason).toBe('invalid_response');
        }
        expect(board([...agreed(), reply('Other', { category: 'expenses' })]).reason).toBe('unexpected_provider');
    });
    it('never assembles a fictional result from conflicting field majorities', () => {
        const d = board([reply('Gemini', { amount: 1, category: 'expenses' }), reply('Groq', { amount: 1, category: 'loans' }), reply('DeepSeek', { amount: 2, category: 'expenses' })]);
        expect(d.fields).toBeNull();
        expect(d.needsReview).toBe(true);
    });
    it('does not equate overflowing JSON numbers with null or lower a required board size', () => {
        const d = board(expected.map(name => ({ name, ok: true, reply: '{"amount":1e309}' })));
        expect(d.reason).toBe('invalid_response'); expect(d.fields).toBeNull();
        const small = unanimousDecision(agreed(), { expected, minimumProviders: 10 });
        expect(small.reason).toBe('insufficient_or_invalid_roster');
    });
});

describe('the reason a board gives is the true one (production 2026-10-01: nine answered, one disagreed, the log said "provider_unavailable")', () => {
    const six = ['A', 'B', 'C', 'D', 'E', 'F'], seven = [...six, 'G'];
    const live = (names, value) => names.map(name => reply(name, value));
    const ask = (results, roster) => unanimousDecision(results, { expected: roster, minimumProviders: 5, allowUnavailable: true });
    const answer = { decisions: [{ index: 0, module: 'expenses', category: 'Groceries', allocationId: '' }] };

    it('five answered and agree while two failed: unanimous — availability is not a vote', () => {
        const d = ask([...live(six.slice(0, 5), answer), { name: 'F', ok: false, error: 'x' }, { name: 'G', ok: false, error: 'y' }], seven);
        expect(d.unanimous).toBe(true); expect(d.reason).toBeNull();
    });
    it('a quorum answered, one of them differs, and others failed: the reason is DISAGREEMENT, not unavailability', () => {
        const d = ask([...live(six.slice(0, 5), answer), reply('F', { decisions: [{ index: 0, module: 'expenses', category: 'Transport', allocationId: '' }] }), { name: 'G', ok: false, error: 'y' }], seven);
        expect(d.unanimous).toBe(false); expect(d.fields).toBeNull(); expect(d.reason).toBe('provider_disagreement');
    });
    it('an answer whose keys are a MANGLED version of the majority\'s is invalid — it is not a vote, and it does not veto the eight that agree', () => {
        const d = ask([...live(six.slice(0, 5), answer), reply('F', { 'decisions [{': 0, module: 'expenses', category: 'Groceries' }), { name: 'G', ok: false, error: 'y' }], seven);
        expect(d.unanimous).toBe(true); expect(d.invalid).toEqual(['F']); expect(d.answered).not.toContain('F'); expect(d.fields).toEqual(answer);
    });
    it('but any OTHER difference is a dissent that vetoes — another shape, a rejection, a refusal, another value', () => {
        for (const odd of [{ verdict: 'reject' }, { error: 'I cannot verify this' }, { decisions: [], approved: false }, { decision: [{ index: 0 }] }, { decisions: 'x' }]) {
            const d = ask([...live(six.slice(0, 5), answer), reply('F', odd), { name: 'G', ok: false, error: 'y' }], seven);
            expect(d.unanimous, JSON.stringify(odd)).toBe(false); expect(d.reason).toBe('provider_disagreement'); expect(d.reply).toBeNull();
        }
    });
    it('a key that merely CONTAINS the required word is a word of its own, not a torn key: it vetoes', () => {
        const yes = { approved: true }, run = (odd) => ask([...live(six.slice(0, 5), yes), reply('F', odd), { name: 'G', ok: false, error: 'y' }], seven);
        for (const odd of [{ not_approved: true }, { approved_by_nobody: 1 }, { unapproved: true }, { approvedNot: true }]) expect(run(odd).unanimous, JSON.stringify(odd)).toBe(false);
        for (const torn of [{ 'approved [{': 1 }, { '"approved': true }, { 'approved,': 0 }]) expect(run(torn).unanimous, JSON.stringify(torn)).toBe(true);
        const decisions = ask([...live(six.slice(0, 5), answer), reply('F', { decisions_rejected: true }), { name: 'G', ok: false, error: 'y' }], seven);
        expect(decisions.unanimous).toBe(false); expect(decisions.reason).toBe('provider_disagreement');
    });
    it('a peer review: {"approved":false} vetoes, {"verdict":"reject"} vetoes, only a mangled key is set aside', () => {
        const yes = { approved: true };
        const run = (odd) => ask([...live(six.slice(0, 5), yes), reply('F', odd), { name: 'G', ok: false, error: 'y' }], seven);
        expect(run({ approved: false }).unanimous).toBe(false);
        expect(run({ verdict: 'reject' }).unanimous).toBe(false);
        expect(run({ 'approved [{': 1 }).unanimous).toBe(true);
    });
    it('without a clear majority nothing is called mangled: a split board is split', () => {
        const four = live(['A', 'B', 'C', 'D'], answer), others = live(['E', 'F', 'G'], { 'decisions [{': 0 });
        const d = ask([...four, ...others], seven);
        expect(d.unanimous).toBe(false);
    });
    it('the rule belongs to the financial board only: without allowUnavailable a mangled answer is a dissent as before', () => {
        const d = unanimousDecision([...live(six.slice(0, 5), answer), reply('F', { 'decisions [{': 0 })], { expected: six, minimumProviders: 5 });
        expect(d.unanimous).toBe(false);
    });
    it('below the quorum the reason is still unavailability (or invalid answers), as before', () => {
        expect(ask([...live(['A', 'B', 'C'], answer), { name: 'D', ok: false, error: 'x' }], ['A', 'B', 'C', 'D']).reason).toBe('insufficient_or_invalid_roster');
        expect(ask([...live(['A', 'B', 'C', 'D'], answer), { name: 'E', ok: false, error: 'x' }], ['A', 'B', 'C', 'D', 'E']).reason).toBe('provider_unavailable');
        expect(ask([...live(['A', 'B', 'C', 'D'], answer), { name: 'E', ok: true, reply: 'not json' }], ['A', 'B', 'C', 'D', 'E']).reason).toBe('invalid_response');
    });
    it('without allowUnavailable the old order stands: a failed member is unavailability even if the rest differ', () => {
        const d = unanimousDecision([...live(['A', 'B'], answer), reply('C', { x: 1 }), { name: 'D', ok: false }], { expected: ['A', 'B', 'C', 'D'], minimumProviders: 2 });
        expect(d.reason).toBe('provider_unavailable');
    });
});
