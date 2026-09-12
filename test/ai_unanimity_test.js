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
});
