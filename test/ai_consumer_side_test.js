import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

/* The AI consumer side, run as written: the real wealthflow-ai-v6.js wrapper and the real helper functions of index.html (cut out by name),
 * so a card that asks for three insights is shown to ask for them, and a failure is shown to read as words a person can act on. */
const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** The source of `function name(...) { ... }` (or `async function`) from a text, by brace matching. */
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

function loadV6() {
    const calls = [];
    const timers = [];
    const store = {};
    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
        localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
        document: { getElementById: () => null, querySelector: () => null },
        navigator: { language: 'en' },
        Image: function () {},
        callAI: async (prompt, image) => { calls.push({ prompt, image }); return 'The same short answer every time.'; },
    };
    ctx.window = ctx; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v6.js'), 'utf8'), ctx);
    timers.forEach((fn) => fn());   // the wrapper installs itself on a timer
    return { ctx, calls, ask: (p, img) => ctx.callAI(p, img) };
}

const INSIGHTS_CARD = `You are a premium Sri Lankan financial advisor AI for Nimal.
Analyze their financial data and write exactly 3 specific, actionable insights:
- Monthly Income: LKR 385,000
- Net Cash Flow: LKR 120,000/month

FORMAT:
Write exactly 3 numbered insights, each with a small emoji.
Keep total under 200 words. No markdown, no asterisks.`;

describe('the v6 wrapper leaves one-shot prompts alone', () => {
    it('hands the Insights card to the engine exactly as written, once', async () => {
        const { ctx, calls, ask } = loadV6();
        expect(ctx.callAI.__v6).toBe(true);   // the wrapper really is the thing being called
        const first = await ask(INSIGHTS_CARD);
        expect(first).toBe('The same short answer every time.');
        expect(calls).toHaveLength(1);
        expect(calls[0].prompt).toBe(INSIGHTS_CARD);
        // asked again with unchanged data: the same reply is NOT a reason to ask a second time
        await ask(INSIGHTS_CARD);
        expect(calls).toHaveLength(2);
    });
    it('does not turn a receipt prompt with an image into a chat turn', async () => {
        const { calls, ask } = loadV6();
        const receipt = 'You are the WealthFlow AI financial advisor reading a receipt. Return ONLY JSON {"vendor":"","amount":0}';
        await ask(receipt, 'aW1hZ2U=');
        expect(calls).toHaveLength(1);
        expect(calls[0].prompt).toBe(receipt);
        expect(calls[0].image).toBe('aW1hZ2U=');
    });
    it('does not read the last line of a card as a request to draw a picture', async () => {
        const { calls, ask } = loadV6();
        const card = 'You are a financial advisor AI. Summarise the month.\nEnd with: draw a picture of the budget in words.';
        const reply = await ask(card);
        expect(reply).toBe('The same short answer every time.');
        expect(calls[0].prompt).toBe(card);
    });
    it('still rewrites a real chat turn around the adaptive system prompt', async () => {
        const { calls, ask } = loadV6();
        const chat = 'You are WealthFlow AI, a financial advisor. FINANCIAL SNAPSHOT: ...\n\n--- CONVERSATION ---\nNimal: how is my spending?\nAI:';
        await ask(chat);
        expect(calls[0].prompt).not.toBe(chat);
        expect(calls[0].prompt).toContain('--- CONVERSATION ---');
        expect(calls[0].prompt).toContain('Nimal: how is my spending?');
    });
});

describe('a failed AI call is described in words a person can act on', () => {
    const run = (code) => { const c = { navigator: { onLine: true }, out: null }; vm.createContext(c); vm.runInContext(code, c); return c; };
    const why = (status, body, netErr, online = true) => {
        const c = { navigator: { onLine: online } }; vm.createContext(c);
        vm.runInContext(fnSource(html, '_wfAiWhy'), c);
        return vm.runInContext(`_wfAiWhy(${status}, ${JSON.stringify(body)}, ${netErr ? 'new Error("x")' : 'null'})`, c);
    };
    it.each([
        [429, { error: 'busy' }, false, /busy right now.*try again in a minute/i],
        [504, { error: 'x' }, false, /took too long/i],
        [422, { error: 'AI consensus requires review.' }, false, /could not agree.*nothing was filed/i],
        [402, { details: 'Gemini status 402: Your prepayment credits are depleted' }, false, /run out of credit.*account owner/i],
        [503, { error: 'No AI providers configured.' }, false, /not set up on the server/i],
        [503, { error: 'All AI providers are temporarily unavailable.', details: 'Groq: Provider response deadline exceeded' }, false, /took too long/i],
        [500, null, false, /did not answer just now/i],
        [0, null, true, /couldn't reach/i],
    ])('status %s reads plainly', (status, body, netErr, pattern) => {
        const text = why(status, body, netErr);
        expect(text).toMatch(pattern);
        expect(text).not.toMatch(/HTTP|Intelligence Engines|Frontend|Vercel|Gemini Failed/);
    });
    it('says "offline" when the device has no connection', () => {
        expect(why(0, null, true, false)).toMatch(/offline/i);
    });
    it('the error callAI throws carries the plain text and keeps the technical log apart', () => {
        const c = {}; vm.createContext(c);
        vm.runInContext(fnSource(html, '_wfAiFail') + fnSource(html, '_wfAiErrText'), c);
        const e = vm.runInContext(`_wfAiFail('The AI took too long to answer. Please try again.', 'All Intelligence Engines Offline. Vercel Backend HTTP 504')`, c);
        expect(e.message).toBe('The AI took too long to answer. Please try again.');
        expect(e.tech).toContain('All Intelligence Engines Offline');
        expect(vm.runInContext('_wfAiErrText', c)(e)).toBe(e.message);
        expect(vm.runInContext('_wfAiErrText', c)(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe('Something went wrong while asking the AI. Please try again.');
    });
});

describe('provider names and the Settings status reading', () => {
    it('names every provider string the board can return', () => {
        const c = {}; vm.createContext(c);
        vm.runInContext(`const _WF_AI_NAMES = ${html.match(/const _WF_AI_NAMES = (\{[^;]*\});/)[1]};` + fnSource(html, '_wfAiProviderName'), c);
        const name = (p) => vm.runInContext(`_wfAiProviderName(${JSON.stringify(p)})`, c);
        expect(name('gemini')).toBe('Gemini');
        expect(name('groq:gpt-oss-120b')).toBe('Groq');
        expect(name('openrouter:qwen-free')).toBe('OpenRouter');
        expect(name('github-models')).toBe('GitHub Models');
        expect(name('ollama:gpt-oss:120b')).toBe('Ollama');
        expect(name('cloudflare:llama-4-scout')).toBe('Cloudflare AI');
        expect(name('something-new')).toBe('');
        expect(name(null)).toBe('');
    });
    it('reads a stored canary report as online, split, low or offline', () => {
        const c = {}; vm.createContext(c);
        vm.runInContext(fnSource(html, '_aiAgeText') + fnSource(html, '_aiBoardReading'), c);
        const read = (board, ageSec = 120) => vm.runInContext(`_aiBoardReading(${JSON.stringify({ ageSec, report: board ? { board } : null })})`, c);
        expect(read({ unanimous: true, answered: 5, asked: 12, floor: 5 })).toMatchObject({ txt: '● Online', cls: 'bg-g', level: 'good' });
        expect(read({ unanimous: true, answered: 5, asked: 12, floor: 5 }).detail).toMatch(/5 of 12.*answered and agreed.*checked 2 min ago/);
        expect(read({ unanimous: false, answered: 6, asked: 12, floor: 5 })).toMatchObject({ cls: 'bg-a', level: 'split' });
        expect(read({ unanimous: false, answered: 3, asked: 12, floor: 5 })).toMatchObject({ cls: 'bg-a', level: 'low' });
        expect(read({ unanimous: false, answered: 0, asked: 12, floor: 5 })).toMatchObject({ txt: '● Offline', cls: 'bg-r' });
        expect(read(null)).toMatchObject({ level: 'none' });
    });
    it('the Settings status no longer sends a prompt to every provider each time it opens', () => {
        const probe = fnSource(html, 'probeAIEngine');
        expect(probe).not.toMatch(/method:\s*'POST'/);
        expect(html).toContain("'?' + kind + '=1'");
    });
});
