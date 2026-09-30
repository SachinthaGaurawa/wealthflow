import { afterEach, describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import handler, { resetProviderCooldowns } from '../api/ai.js';

// The owner's screen said "All Intelligence Engines Offline. Vercel Backend HTTP 422". The prompt the chat engine
// REALLY sends — built here by the real wealthflow-ai-v6.js, wrapped the way callAI() wraps it — went to the real
// endpoint handler with two working providers. It must be answered, not sent to the unanimous financial board.
const ROOT = path.resolve(import.meta.dirname, '..');
const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
afterEach(() => { resetProviderCooldowns(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function realChatPrompt(intent, userLine) {
    const store = {};
    const ctx = { console: { log() {}, warn() {}, error() {} }, setInterval: () => 0, setTimeout: () => 0, clearInterval() {}, clearTimeout() {},
        localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } }, document: { getElementById: () => null, querySelector: () => null }, navigator: { language: 'en' } };
    ctx.window = ctx; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v6.js'), 'utf8'), ctx);
    const system = ctx.WealthFlowAIv6.adaptiveSystemPrompt(intent, userLine);
    // callAI(): _sys + '\n\n' + (conversation tail closed by the reply-language gate)
    return system + '\n\n--- CONVERSATION ---\nUser: ' + userLine + '\n\n[REPLY NOW — in English only, as their warm caring best friend. No English unless English IS English. Just reply naturally in English.]\nAI:';
}
const twoProviders = () => {
    vi.stubEnv('GEMINI_API_KEY', 'test'); vi.stubEnv('GROQ_API_KEY', 'test');
    vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => url.includes('googleapis')
        ? { candidates: [{ content: { parts: [{ text: '1. You kept 40% of your income this month. 2. Watch the card balance. 3. Top up the emergency fund.' }] } }] }
        : { choices: [{ message: { content: 'Your savings rate is healthy this month. Keep the card balance in check and top up the emergency fund.' } }] } })));
};

describe('the prompt the chat engine really sends', () => {
    it.each([['finance', 'write exactly 3 insights about my month'], ['general', 'hello there'], ['finance', 'how is my spending by category?']])('is answered (%s: %s), by the new client and by one that predates the flag', async (intent, line) => {
        const prompt = realChatPrompt(intent, line);
        // why it failed: the wording alone reads as a request for JSON
        expect(/\bjson\b/i.test(prompt)).toBe(true);
        for (const body of [{ prompt, task: 'advice' }, { prompt }]) {
            twoProviders();
            const res = response();
            await handler({ method: 'POST', body }, res);
            expect(res.code, JSON.stringify(Object.keys(body))).toBe(200);
            expect(res.body.reply).toMatch(/emergency fund|income/);
            expect(res.body.financialDecision).toBe(false);
            expect(res.body.answered).toEqual(['Gemini', 'Groq']);
            // and never asked either provider for JSON
            for (const [, options] of fetch.mock.calls) expect(String(options?.body || '')).not.toContain('responseMimeType');
        }
    });
    it('is not the way a financial decision is asked: that still needs the board, with or without the same words', async () => {
        twoProviders();
        const res = response();
        await handler({ method: 'POST', body: { prompt: realChatPrompt('finance', 'x'), task: 'advice', financialDecision: true } }, res);
        expect(res.code).toBe(422);
        expect(res.body.reply).toBeNull();
    });
});
