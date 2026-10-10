import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import handler from '../api/vision-scan.js';
import { geminiBook, resetGeminiLearning } from '../gemini-client.mjs';
import { resetReasoningLearning } from '../ai-chat.mjs';
import { CANARY_IMAGE_B64 } from '../ai-canary-image.mjs';

/* =============================================================================
 * THE RECEIPT SCANNER, END TO END, WITH THE WORLD AS IT IS TODAY.
 *
 * Every vision model this file once named by hand (Ollama llama3.2-vision and qwen2.5vl, Groq llama-3.2-90b-vision-preview, Mistral pixtral-large-latest,
 * OpenRouter qwen-2.5-vl-72b-instruct:free, Fireworks phi-3-vision-128k-instruct, …) has been retired by its provider. A scan answered through OCR alone while
 * the engines the page advertises failed in a few hundred milliseconds. The scanner now asks each provider what it serves (ai-provider-call.mjs) and
 * names, in its reply, the model that read the receipt.
 * ===========================================================================*/

const ROOT = path.resolve(import.meta.dirname, '..');
const RECEIPT = JSON.stringify({ vendor: 'ACME MART', amount: 1250, date: '2026-10-01', category: 'Groceries', currency: 'LKR' });
const ENV = { OLLAMA_API_KEY: 'o', GROQ_API_KEY: 'g', MISTRAL_API_KEY: 'm', TOGETHER_API_KEY: 't', NVIDIA_API_KEY: 'n', FIREWORKS_API_KEY: 'f', OPENROUTER_API_KEY: 'r', GH_PAT: 'pat-token', GITHUB_MODELS_TOKEN: 'old-token' };

const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const refuse = (status, text) => ({ ok: false, status, json: async () => ({}), text: async () => text });
const chat = (content) => reply({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });

/** Today's providers: some still serve the model the table starts from, some have retired it and list what they serve now. */
function world() {
    const log = [];
    const fetch = vi.fn(async (url, init = {}) => {
        const u = String(url);
        const body = init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : null;
        log.push({ u, body, headers: init.headers || {}, method: init.method || 'GET' });
        if (body && /^https:\/\/(?!vision\.google)/.test(u) && !body.model && !body.requests) return refuse(400, 'no model');
        // ---- lists
        if (/ollama\.com\/api\/tags/.test(u)) return reply({ models: [{ name: 'qwen3-vl:235b' }, { name: 'gemma4:31b-cloud' }, { name: 'gpt-oss:120b' }] });
        if (/integrate\.api\.nvidia\.com.*\/models$/.test(u)) return reply({ data: [{ id: 'meta/llama-4-maverick-17b-128e-instruct' }, { id: 'nvidia/nv-embedqa-e5-v5' }, { id: 'meta/llama-3.3-70b-instruct' }] });
        if (/\/models$/.test(u) || /\/catalog\/models$/.test(u)) return reply({ data: [] });
        // ---- chats
        if (/ollama\.com\/api\/chat/.test(u)) return body.model === 'gemma4:31b' ? refuse(404, '{"error":"model \'gemma4:31b\' not found"}') : reply({ message: { content: RECEIPT }, done_reason: 'stop' });
        if (/api\.groq\.com/.test(u)) return chat(RECEIPT);
        if (/api\.mistral\.ai/.test(u)) return refuse(429, '{"message":"Rate limit exceeded"}');
        if (/api\.together\.xyz/.test(u)) return chat(RECEIPT);
        if (/integrate\.api\.nvidia\.com/.test(u)) return body.model === 'meta/llama-3.2-90b-vision-instruct' ? refuse(410, '{"detail":"The model has reached its end of life"}') : chat(RECEIPT);
        if (/models\.github\.ai/.test(u)) return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); }, text: async () => 'OK\r\n' };
        if (/api\.fireworks\.ai/.test(u)) return chat(RECEIPT);
        if (/openrouter\.ai/.test(u)) return chat(RECEIPT);
        return refuse(404, 'unexpected url ' + u);
    });
    return { fetch, log };
}

beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    for (const k of ['WealthFlow_API_Key', 'GEMINI_API_KEY', 'GOOGLE_VISION_API_KEY', 'CLOUD_VISION_API_KEY', 'VISION_API_KEY', 'COHERE_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'HUGGINGFACE_API_KEY', 'HF_TOKEN', 'GITHUB_TOKEN', 'NIM_API_KEY', 'OCR_SPACE_API_KEY']) vi.stubEnv(k, '');
    geminiBook.reset(); resetGeminiLearning(); resetReasoningLearning();
});
afterEach(() => { geminiBook.reset(); resetGeminiLearning(); resetReasoningLearning(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const scan = async (mode, image = CANARY_IMAGE_B64) => { const res = response(); await handler({ method: 'POST', body: { image, mode, hints: {} } }, res); return res; };

describe('ultra scan: every engine asks a model its provider serves today', () => {
    it('the engines that can read answer, a retired model is replaced from the provider\'s own list, and the reply says which model read it', async () => {
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        const res = await scan('ultra');
        expect(res.code).toBe(200);
        expect(res.body.result).toMatchObject({ vendor: 'ACME MART', amount: 1250 });
        const by = Object.fromEntries(res.body.engines.map((e) => [e.name, e]));
        // still served: the starting model reads it
        for (const name of ['groq', 'together', 'fireworks', 'openrouter']) expect(by[name], name).toMatchObject({ success: true, model: expect.any(String) });
        // retired: Ollama's gemma4:31b and NVIDIA's llama-3.2-90b — replaced from what each says it serves
        expect(by.ollama).toMatchObject({ success: true });
        expect(by.ollama.model).not.toBe('gemma4:31b');
        expect(by.ollama.model).toMatch(/vl|gemma/);
        expect(by.nvidia).toMatchObject({ success: true, model: 'meta/llama-4-maverick-17b-128e-instruct' });
        // a quota and a 200 "OK" are reported as what they are
        expect(by.mistral).toMatchObject({ success: false });
        expect(by.mistral.error).toMatch(/Mistral status 429/);
        expect(by['github-models']).toMatchObject({ success: false });
        expect(by['github-models'].error).toMatch(/non-JSON \(HTTP 200\): "OK"/);
    });

    it('no engine is asked for a model the providers retired', async () => {
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        await scan('ultra');
        const asked = w.log.filter((c) => c.body && c.body.model).map((c) => c.body.model);
        for (const gone of ['llama3.2-vision', 'qwen2.5vl', 'llama-3.2-90b-vision-preview', 'phi-3-vision-128k-instruct', 'qwen-2.5-vl-72b-instruct', 'pixtral-large-latest']) expect(asked.join(' ')).not.toContain(gone);
        expect(asked.length).toBeGreaterThan(6);
    });

    it('the picture goes out as the JPEG it is, to every reader, in the shape that provider takes', async () => {
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        await scan('ultra');
        const chats = w.log.filter((c) => c.body && c.body.messages);
        const openAiShaped = chats.filter((c) => Array.isArray(c.body.messages[0].content));
        expect(openAiShaped.length).toBeGreaterThan(3);
        for (const c of openAiShaped) expect(c.body.messages[0].content[1].image_url.url, c.u).toMatch(/^data:image\/jpeg;base64,\/9j\//);
        const ollama = chats.filter((c) => /ollama\.com\/api\/chat/.test(c.u));
        expect(ollama.length).toBeGreaterThan(0);
        for (const c of ollama) expect(c.body.messages[0].images).toEqual([CANARY_IMAGE_B64]);
    });

    it('a PNG screenshot is not labelled a JPEG', async () => {
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='.padEnd(200, 'A');
        await scan('deep', png);
        const sent = w.log.filter((c) => c.body && Array.isArray(c.body.messages && c.body.messages[0].content));
        expect(sent.length).toBeGreaterThan(0);
        for (const c of sent) expect(c.body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    });

    it('GitHub Models is asked with the token that carries the Models permission first (GH_PAT), not the one that answered "OK"', async () => {
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        await scan('ultra');
        const gh = w.log.filter((c) => /models\.github\.ai\/inference/.test(c.u));
        expect(gh.length).toBeGreaterThan(0);
        for (const c of gh) expect(c.headers.Authorization).toBe('Bearer pat-token');
    });
});

describe('quick scan: the first reader that answers ends it, one after another with short deadlines', () => {
    it('Ollama (healed) answers and nothing else is asked', async () => {
        const w = world(); vi.stubGlobal('fetch', w.fetch);
        const res = await scan('quick');
        expect(res.code).toBe(200);
        expect(res.body.mode).toBe('quick');
        expect(res.body.engines).toHaveLength(1);
        expect(res.body.engines[0]).toMatchObject({ name: 'ollama', success: true });
        expect(w.log.some((c) => /api\.groq\.com/.test(c.u))).toBe(false);
    });
});

describe('the source', () => {
    const source = fs.readFileSync(path.join(ROOT, 'api/vision-scan.js'), 'utf8');
    it('no provider\'s model is named in the scanner any more; they all go through askProvider', () => {
        for (const gone of ['llama3.2-vision', 'qwen2.5vl', 'llama-3.2-90b-vision-preview', 'phi-3-vision-128k-instruct', 'qwen-2.5-vl-72b-instruct', 'pixtral-large-latest', 'model: \'gpt-4o\'']) expect(source, gone).not.toContain(gone);
        expect(source).toContain("from '../ai-provider-call.mjs'");
        expect(source).toMatch(/process\.env\.GH_PAT \|\| process\.env\.GITHUB_MODELS_TOKEN/);
    });
    it('Cerebras and SambaNova (removed from the board) are no longer asked to structure OCR text', () => {
        expect(source).not.toMatch(/cerebras\.ai|sambanova\.ai/i);
    });
});
