import { afterEach, describe, it, expect, vi } from 'vitest';
import handler, { modelBook, resetProviderCooldowns } from '../api/ai.js';
import { resetReasoningLearning } from '../ai-chat.mjs';
import { resetGeminiLearning } from '../gemini-client.mjs';
import { ANSWER, KEYS, response, chat, world, boardRequest } from './helpers/ai-world.js';

/* A DISSENT HAS TO BE REPRODUCIBLE TO VETO.
 * Production canary, 2026-10-01 10:59: nine providers answered, eight said the same thing, and OpenRouterQwen said
 * {"decisions [{": 0, "module": "expenses", …} — valid JSON, a different object. Any valid dissent vetoes, so the one glitch refused a
 * decision eight providers agreed on (and the log called it "provider_unavailable"). The providers that disagree with a clear majority are
 * now asked once more: a glitch does not repeat and counts as agreeing; a real disagreement repeats and keeps its veto. */

afterEach(() => { modelBook.reset(); resetProviderCooldowns(); resetReasoningLearning(); resetGeminiLearning(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const GARBLE = '{"decisions [{": 0, "module": "expenses", "category": "Groceries", "allocationId": ""}';     // keys torn: mangled, not a judgement
const OTHER = '{"decisions":[{"index":0,"module":"expenses","category":"Transport","allocationId":""}]}';

/** The production roster, with `who` answering through `script(callNumber)` instead of the agreed answer. */
function scripted(who, script) {
    for (const key of KEYS) vi.stubEnv(key, 'test');
    const w = world(); const calls = { [who]: 0 };
    const re = who === 'DeepSeek' ? /deepseek/ : /api\.groq\.com.*chat|ollama\.com/;
    const fetch = vi.fn(async (url, init) => {
        const u = String(url);
        if (re.test(u) && !/\/models/.test(u)) { calls[who]++; return chat(script(calls[who])); }
        return w.fetch(url, init);
    });
    vi.stubGlobal('fetch', fetch);
    return { calls };
}
async function board() {
    const lines = [];
    const info = vi.spyOn(console, 'info').mockImplementation((line) => { lines.push(String(line)); });
    const res = response();
    try { await handler(boardRequest(), res); } finally { info.mockRestore(); }
    const log = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((l) => l && l.evt === 'ai-board');
    return { res, log };
}

describe('a provider that judges differently once does not refuse what the others agree on', () => {
    it('says another category the first time, the agreed answer the second: unanimous, asked twice, and the log says so', async () => {
        const s = scripted('DeepSeek', (n) => (n === 1 ? OTHER : ANSWER));
        const { res, log } = await board();
        expect(res.code).toBe(200); expect(res.body.unanimous).toBe(true);
        expect(res.body.answered).toContain('DeepSeek');
        expect(s.calls.DeepSeek).toBe(2);
        expect(log.reasked).toEqual([{ name: 'DeepSeek', agreed: true }]);
    });
});

describe('a mangled answer is garbage, not a vote', () => {
    it('keys torn every time: set aside as invalid, NOT asked again, the eight that agree decide', async () => {
        const s = scripted('DeepSeek', () => GARBLE);
        const { res, log } = await board();
        expect(res.code).toBe(200); expect(res.body.unanimous).toBe(true);
        expect(res.body.invalid).toEqual(['DeepSeek']); expect(res.body.answered).not.toContain('DeepSeek');
        expect(s.calls.DeepSeek).toBe(1); expect(log.reasked).toBeUndefined();
        expect(log.invalid).toEqual(['DeepSeek']);
    });
});

describe('a dissent that repeats keeps its veto — the safety rule is not weakened', () => {
    it('the same different category twice: refused as a disagreement, asked exactly twice, nothing is released', async () => {
        const s = scripted('DeepSeek', () => OTHER);
        const { res, log } = await board();
        expect(res.code).toBe(422); expect(res.body.reason).toBe('provider_disagreement');
        expect(res.body.reply).toBeNull(); expect(res.body.fields).toBeNull(); expect(res.body.trustworthy).toBe(false);
        expect(s.calls.DeepSeek).toBe(2);
        expect(log.reasked).toEqual([{ name: 'DeepSeek', agreed: false }]);
        // the log says WHO differed and how the rest grouped, so a refusal is a finding and not just a reason string
        expect(log.differing).toMatchObject({ clear: true });
        expect(log.differing.groups[0].length).toBeGreaterThanOrEqual(5); expect(log.differing.groups[1]).toEqual(['DeepSeek']);
        expect(log.differing.sample[0]).toContain('Transport');
    });
    it('a refusal in a shape of its own, every time: refused', async () => {
        scripted('DeepSeek', () => '{"error":"I cannot verify this transaction"}');
        const { res } = await board();
        expect(res.code).toBe(422); expect(res.body.reason).toBe('provider_disagreement');
    });
    it('a different answer the first time and ANOTHER different answer the second: still a veto — only agreeing with the majority clears it', async () => {
        scripted('DeepSeek', (n) => (n === 1 ? OTHER : '{"decisions":[{"index":0,"module":"expenses","category":"Utilities","allocationId":""}]}'));
        const { res } = await board();
        expect(res.code).toBe(422);
    });
    it('cannot be reached the second time: the first answer stands, and it dissents', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); let n = 0;
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            if (/deepseek/.test(String(url))) { n++; return n === 1 ? chat(OTHER) : { ok: false, status: 500, json: async () => ({}), text: async () => 'upstream error' }; }
            return w.fetch(url, init);
        }));
        const { res } = await board();
        expect(res.code).toBe(422); expect(res.body.reason).toBe('provider_disagreement');
    });
});

describe('only a clear majority is relied on', () => {
    it('with nobody dissenting no provider is asked twice', async () => {
        const s = scripted('DeepSeek', () => ANSWER);
        const { res, log } = await board();
        expect(res.code).toBe(200); expect(s.calls.DeepSeek).toBe(1); expect(log.reasked).toBeUndefined();
    });
    it('four providers dissenting is a split board, not a glitch: nobody is asked again', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world(); const asked = {};
        vi.stubGlobal('fetch', vi.fn(async (url, init) => {
            const u = String(url);
            const who = /deepseek/.test(u) ? 'DeepSeek' : /api\.groq\.com.*chat/.test(u) ? 'Groq' : /ollama\.com/.test(u) ? 'Ollama' : /fireworks.*chat/.test(u) ? 'Fireworks' : '';
            if (who && !/\/models/.test(u)) { asked[who] = (asked[who] || 0) + 1; if (who === 'Ollama') return { ok: true, status: 200, json: async () => ({ message: { content: OTHER }, done_reason: 'stop' }), text: async () => '' }; return chat(OTHER); }
            return w.fetch(url, init);
        }));
        const { res, log } = await board();
        expect(res.code).toBe(422); expect(res.body.reason).toBe('provider_disagreement');
        expect(log.reasked).toBeUndefined();
        for (const who of Object.keys(asked)) expect(asked[who], who).toBeLessThanOrEqual(2);   // Groq may be asked twice for its own reasoning-budget growth, never for a re-ask
    });
});
