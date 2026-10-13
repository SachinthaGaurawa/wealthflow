import { afterEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import handler, { modelBook, resetProviderCooldowns } from '../api/ai.js';
import { resetReasoningLearning } from '../ai-chat.mjs';
import { resetGeminiLearning } from '../gemini-client.mjs';
import { KEYS, response, json, chat } from './helpers/ai-world.js';

/* =============================================================================
 * A REQUEST FOR WORDS IS NOT A FINANCIAL DECISION.
 *
 * api/ai.js reads the WORDING of a prompt to decide whether the answer will touch the books: the word "JSON" anywhere in it, the word "category", or an
 * image, and then five providers must return the same text. The CRIB credit analysis asks for two paragraphs of advice and begins its data block
 * "Extracted data (JSON):"; its trend line carries a `"category"` field. Both were therefore read as decisions, five providers never write the same
 * paragraph, and the answer was HTTP 422 for every owner who opened the CRIB page (the trend line failed silently, the analysis said the AI was
 * unavailable). The advisor's answer re-check ("this figure is not yours, answer again") carried the same risk.
 *
 * The caller that wants words now says so (task: 'advice'), through the two client doors that had no way to: callAIRaw and callAIInLanguage.
 * ===========================================================================*/

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function fnSource(text, name) {
    const at = text.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
    if (at < 0) throw new Error(`function ${name} not found`);
    const open = text.indexOf('{', text.indexOf(')', at));
    let depth = 0, i = open, inString = null;
    for (; i < text.length; i++) {
        const c = text[i], prev = text[i - 1];
        if (inString) { if (c === inString && prev !== '\\') inString = null; continue; }
        if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { i++; break; }
    }
    return text.slice(at, i);
}

/** The real callAIRaw / callAIInLanguage / their two helpers, with a network that records what is sent. */
function clientDoors(reply = { reply: 'words', trustworthy: false }) {
    const sent = [];
    const ctx = {
        console, setTimeout, clearTimeout, Promise, JSON, String, Object, Array, Error,
        location: { hostname: 'www.wealthflow.lk' },
        fetch: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => reply }; },
    };
    ctx.window = ctx;
    ctx._lastAIProvider = '';
    vm.createContext(ctx);
    const code = ['_wfSelectedLangName', '_wfWantsJSON', 'callAIRaw', 'callAIInLanguage'].map((n) => fnSource(html, n)).join('\n');
    vm.runInContext(`${code}\nwindow.callAIRaw = callAIRaw; window.callAIInLanguage = callAIInLanguage;`, ctx);
    return { ctx, sent };
}

const CRIB_ANALYSIS = `You are WealthFlow AI — the user's warm best friend who is also a top Sri Lankan credit expert.
Extracted data (JSON):
{"score":612,"category":"B","facilities":[]}

Write TWO clearly separated sections, and nothing else:
[ANALYSIS]
A warm read of their CRIB report.
[ADVICE]
A practical action plan.`;
const CRIB_TREND = `Here are their CRIB reports over time (newest first):
[{"date":"Aug 2026","score":590,"category":"C"},{"date":"Oct 2026","score":612,"category":"B"}]

In 1 short, warm paragraph, tell them how their credit is TRENDING.`;
const JSON_JOB = 'You are a Sri Lankan CRIB report parser. From the report text below, extract ONLY this JSON (no prose, no markdown):\n{"score":null,"category":""}\nOutput JSON ONLY.';

describe('the client doors: a caller that wants words says so', () => {
    it('callAIInLanguage on a prose prompt asks for advice (words), with no board mode', async () => {
        const { ctx, sent } = clientDoors();
        const out = await ctx.callAIInLanguage(CRIB_ANALYSIS);
        expect(out).toBe('words');
        expect(sent).toHaveLength(1);
        expect(sent[0].body.task).toBe('advice');
        expect(sent[0].body.mode).toBeUndefined();
        expect(sent[0].body.prompt).toMatch(/Reply ENTIRELY in English only/);      // the reply-language gate is still added
    });

    it('callAIRaw takes the same word from a caller that sets it (the advisor\'s answer re-check)', async () => {
        const { ctx, sent } = clientDoors();
        await ctx.callAIRaw('Rewrite your answer using only these figures.', null, { task: 'advice' });
        expect(sent[0].body).toMatchObject({ task: 'advice' });
        expect(sent[0].body.mode).toBeUndefined();
    });

    it('a JSON job is never turned into advice: it still goes to the board, as a decision', async () => {
        const { ctx, sent } = clientDoors({ reply: '{"score":612}', trustworthy: true, financialDecision: true });
        await ctx.callAIRaw(JSON_JOB, null, { json: true, mode: 'consensus' });
        expect(sent[0].body.task).toBeUndefined();
        expect(sent[0].body.mode).toBe('consensus');
        // …and callAIInLanguage on a JSON prompt does not add the word either
        const second = clientDoors({ reply: '{"score":612}', trustworthy: true, financialDecision: true });
        await second.ctx.callAIInLanguage(JSON_JOB);
        expect(second.sent[0].body.task).toBeUndefined();
        // even a caller that sets task on a JSON job cannot talk its way out of the board
        const third = clientDoors({ reply: '{"score":612}', trustworthy: true, financialDecision: true });
        await third.ctx.callAIRaw(JSON_JOB, null, { json: true, task: 'advice' });
        expect(third.sent[0].body.task).toBeUndefined();
        expect(third.sent[0].body.mode).toBe('consensus');
    });

    it('the callers are wired: the CRIB page and the advisor re-check use them', () => {
        expect(html).toMatch(/callAIRaw\(p, null, \{ task: 'advice' \}\)/);
        const crib = fs.readFileSync(path.join(ROOT, 'wealthflow-crib.js'), 'utf8');
        expect(crib).toMatch(/callAIRaw\(_langGate\(prompt\), image \|\| null, \{ task: 'advice' \}\)/);
    });
});

describe('the endpoint: why it mattered', () => {
    afterEach(() => { modelBook.reset(); resetProviderCooldowns(); resetReasoningLearning(); resetGeminiLearning(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

    /** Every provider answers, and no two answer in the same words — as providers do when asked to write. */
    function writers() {
        let n = 0;
        return vi.fn(async (url, init) => {
            const u = String(url);
            if (init && init.method === 'GET') return json({ data: [], models: [] });
            if (/\/models(\?|$)/.test(u)) return json({ data: [], models: [] });
            const text = `Here is my own reading, number ${++n}: your score is a bit low, and I would start with the arrears. ${'x'.repeat(n)}`;
            if (/googleapis/.test(u)) return json({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
            if (/ollama\.com/.test(u)) return json({ message: { content: text }, done_reason: 'stop' });
            return chat(text);
        });
    }
    const post = async (body) => { const res = response(); await handler({ method: 'POST', body, headers: {} }, res); return res; };

    it('the CRIB analysis, asked the way the page used to, is refused as a disagreement; asked as advice, it is answered', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', writers());
        const old = await post({ prompt: CRIB_ANALYSIS });
        expect(old.code).toBe(422);                                              // the board needs JSON that agrees; paragraphs are neither
        expect(old.body.unanimous).toBe(false);
        expect(old.body.reply).toBeFalsy();
        const now = await post({ prompt: CRIB_ANALYSIS, task: 'advice' });
        expect(now.code).toBe(200);
        expect(now.body.reply).toMatch(/Here is my own reading/);
        expect(now.body.financialDecision).toBe(false);
    });

    it('the trend line (a "category" field in the data) the same', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', writers());
        expect((await post({ prompt: CRIB_TREND })).code).toBe(422);
        expect((await post({ prompt: CRIB_TREND, task: 'advice' })).code).toBe(200);
    });

    it('asking for advice does not open a door for a decision: a JSON job that also says task:advice is still read by the board', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', writers());
        const res = await post({ prompt: JSON_JOB, task: 'advice', financialDecision: true });
        expect(res.code).toBe(422);                                              // free text from five providers is not unanimous: refused, never guessed
        expect(res.body.unanimous).toBe(false);
        expect(res.body.reply).toBeFalsy();
    });

    it('a refusal says which door the request came through, without a word of its content', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', writers());
        const asked = async (body) => {
            const lines = [];
            const info = vi.spyOn(console, 'info').mockImplementation((line) => { lines.push(String(line)); });
            try { await post(body); } finally { info.mockRestore(); }
            return lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((l) => l && l.evt === 'ai-board');
        };
        expect(await asked({ prompt: CRIB_TREND })).toMatchObject({ ask: 'wording', chars: CRIB_TREND.length, ok: false });
        expect(await asked({ prompt: CRIB_ANALYSIS })).toMatchObject({ ask: 'json-word' });
        expect(await asked({ prompt: 'Give one word.', financialDecision: true })).toMatchObject({ ask: 'flagged' });
        expect(await asked({ prompt: 'Give one word.', task: 'extraction' })).toMatchObject({ ask: 'task' });
        const line = JSON.stringify(await asked({ prompt: 'secret-merchant-narration 1234 Nimal' + ' json', financialDecision: true }));
        expect(line).not.toContain('secret-merchant-narration');
    });
});
