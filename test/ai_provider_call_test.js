import { afterEach, describe, it, expect, vi } from 'vitest';
import { askProvider, PROVIDERS } from '../ai-provider-call.mjs';
import { createModelBook, choose } from '../ai-models.mjs';
import { resetReasoningLearning } from '../ai-chat.mjs';
import { CANARY_IMAGE_B64 } from '../ai-canary-image.mjs';

/* =============================================================================
 * THE RECEIPT SCANNER ASKS A MODEL THE PROVIDER STILL SERVES.
 *
 * api/vision-scan.js named its vision models by hand, nine times, and every name had been retired: a scan answered through the OCR-then-text path
 * alone while the "12+ engines" each failed in a few hundred milliseconds. askProvider is the one door they all use now: it starts at the provider's
 * current default, and when the provider says the model is gone it asks the provider's own list, chooses by rule, retries, and remembers.
 * ===========================================================================*/

afterEach(() => { resetReasoningLearning(); vi.useRealTimers(); });

const KEYS = { ollamaKey: 'k', groqKey: 'k', mistralKey: 'k', togetherKey: 'k', fireworksKey: 'k', nvidiaKey: 'k', deepseekKey: 'k', openrouterKey: 'k', githubToken: 'k' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const refuse = (status, text) => ({ ok: false, status, json: async () => ({}), text: async () => text });
const chatOf = (content) => reply({ choices: [{ message: { content }, finish_reason: 'stop' }] });

/** A network of one provider: `chat(model, body)` answers a request, `list` is what the provider says it serves. */
function net({ chat, list = [], listShape = 'openai' } = {}) {
    const calls = [];
    const fetcher = vi.fn(async (url, init) => {
        const u = String(url);
        const body = init && init.body ? JSON.parse(init.body) : null;
        calls.push({ url: u, init, body });
        if (init && init.method === 'GET') return listShape === 'ollama' ? reply({ models: list.map((name) => ({ name })) }) : reply({ data: list.map((id) => ({ id })) });
        return chat(body.model, body);
    });
    return { fetcher, calls, chats: () => calls.filter((c) => c.body), lists: () => calls.filter((c) => !c.body) };
}
const book = () => createModelBook();

describe('askProvider: the plain cases', () => {
    it('no key is said as no_key, a provider without a vision model is skipped for an image and still asked for text, an unknown one is refused', async () => {
        const w = net({ chat: (m) => chatOf('hi') });
        await expect(askProvider('Groq', { keys: {}, prompt: 'x', fetcher: w.fetcher, book: book() })).rejects.toThrow('no_key');
        await expect(askProvider('DeepSeek', { keys: KEYS, image: PNG, prompt: 'x', fetcher: w.fetcher, book: book() })).rejects.toThrow(/skipped \(no vision model\)/);
        expect((await askProvider('DeepSeek', { keys: KEYS, prompt: 'x', fetcher: w.fetcher, book: book() })).text).toBe('hi');
        await expect(askProvider('Nobody', { keys: KEYS, prompt: 'x', fetcher: w.fetcher })).rejects.toThrow(/not a known provider/);
        expect(w.calls.length).toBe(1);                                          // only the DeepSeek text call touched the network
    });

    it('an image goes as a data URL with the type it really is; the vision model is asked, not the text one', async () => {
        const jpeg = net({ chat: () => chatOf('{"vendor":"ACME MART","amount":1250}') });
        const out = await askProvider('Mistral', { keys: KEYS, image: CANARY_IMAGE_B64, prompt: 'read it', fetcher: jpeg.fetcher, book: book() });
        expect(out.text).toContain('ACME MART');
        const sent = jpeg.chats()[0].body;
        expect(sent.model).toBe(PROVIDERS.Mistral.vision);
        expect(sent.messages[0].content[0]).toEqual({ type: 'text', text: 'read it' });
        expect(sent.messages[0].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
        expect(jpeg.chats()[0].init.headers.Authorization).toBe('Bearer k');

        const png = net({ chat: () => chatOf('ok') });
        await askProvider('Groq', { keys: KEYS, image: PNG, prompt: 'x', fetcher: png.fetcher, book: book() });
        expect(png.chats()[0].body.messages[0].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);   // a screenshot is not labelled a JPEG
        expect(png.chats()[0].body.model).toBe(PROVIDERS.Groq.vision);
    });

    it('text is a plain string content, with the provider\'s JSON switch only where it has one and only without an image', async () => {
        const w = net({ chat: () => chatOf('{"a":1}') });
        await askProvider('Groq', { keys: KEYS, prompt: 'structure this', json: true, fetcher: w.fetcher, book: book() });
        expect(w.chats()[0].body.messages[0].content).toBe('structure this');
        expect(w.chats()[0].body.model).toBe(PROVIDERS.Groq.text);
        expect(w.chats()[0].body.response_format).toEqual({ type: 'json_object' });

        const noSwitch = net({ chat: () => chatOf('{"a":1}') });
        await askProvider('Together', { keys: KEYS, prompt: 'x', json: true, fetcher: noSwitch.fetcher, book: book() });
        expect(noSwitch.chats()[0].body.response_format).toBeUndefined();

        const withImage = net({ chat: () => chatOf('{"a":1}') });
        await askProvider('Groq', { keys: KEYS, image: PNG, prompt: 'x', json: true, fetcher: withImage.fetcher, book: book() });
        expect(withImage.chats()[0].body.response_format).toBeUndefined();        // a vision model is not asked for JSON mode
    });

    it('Ollama has its own door: images beside the text, no streaming, the reply under message.content, JSON format only when asked', async () => {
        const w = net({ chat: () => reply({ message: { content: '{"vendor":"ACME"}' }, done_reason: 'stop' }) });
        const out = await askProvider('Ollama', { keys: KEYS, image: PNG, prompt: 'read', json: true, fetcher: w.fetcher, book: book(), tokens: 900 });
        expect(out).toMatchObject({ text: '{"vendor":"ACME"}', model: PROVIDERS.Ollama.vision });
        const sent = w.chats()[0];
        expect(sent.url).toBe(PROVIDERS.Ollama.url);
        expect(sent.body).toMatchObject({ model: PROVIDERS.Ollama.vision, stream: false, format: 'json', messages: [{ role: 'user', content: 'read', images: [PNG] }] });
        expect(sent.body.options.num_predict).toBe(900);
        const free = net({ chat: () => reply({ message: { content: 'plain words' } }) });
        await askProvider('Ollama', { keys: KEYS, image: PNG, prompt: 'read', fetcher: free.fetcher, book: book() });
        expect(free.chats()[0].body.format).toBeUndefined();
    });

    it('OpenRouter is told who is asking (the official website); the others are not', async () => {
        const or = net({ chat: () => chatOf('x') });
        await askProvider('OpenRouterScan', { keys: KEYS, prompt: 'x', fetcher: or.fetcher, book: book() });
        expect(or.chats()[0].init.headers).toMatchObject({ 'HTTP-Referer': 'https://www.wealthflow.lk', 'X-Title': 'WealthFlow' });
        const g = net({ chat: () => chatOf('x') });
        await askProvider('Groq', { keys: KEYS, prompt: 'x', fetcher: g.fetcher, book: book() });
        expect(g.chats()[0].init.headers['HTTP-Referer']).toBeUndefined();
        const gh = net({ chat: () => chatOf('x') });
        await askProvider('GitHubModels', { keys: KEYS, prompt: 'x', fetcher: gh.fetcher, book: book() });
        expect(gh.chats()[0].init.headers).toMatchObject({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    });

    it('a provider with a vision ceiling is not given more for an image (Groq 2048) and is given the full budget for text', async () => {
        const img = net({ chat: () => chatOf('x') });
        await askProvider('Groq', { keys: KEYS, image: PNG, prompt: 'x', tokens: 4000, fetcher: img.fetcher, book: book() });
        expect(img.chats()[0].body.max_tokens).toBe(2048);
        const txt = net({ chat: () => chatOf('x') });
        await askProvider('Groq', { keys: KEYS, prompt: 'x', tokens: 4000, fetcher: txt.fetcher, book: book() });
        expect(txt.chats()[0].body.max_tokens).toBe(4000);
    });
});

describe('askProvider: a retired model is replaced from the provider\'s own list', () => {
    it('Mistral\'s vision model is gone: it asks what Mistral serves, picks pixtral for the image, retries once and remembers the model', async () => {
        const w = net({
            list: ['mistral-embed', 'pixtral-large-latest', 'mistral-small-latest', 'mistral-moderation-latest'],
            chat: (model) => (model === 'mistral-small-latest' ? refuse(404, '{"message":"Model not found"}') : chatOf('{"vendor":"ACME MART","amount":1250}')),
        });
        const shared = book();
        const out = await askProvider('Mistral', { keys: KEYS, image: PNG, prompt: 'read', fetcher: w.fetcher, book: shared });
        expect(out.model).toBe('pixtral-large-latest');
        expect(w.chats().map((c) => c.body.model)).toEqual(['mistral-small-latest', 'pixtral-large-latest']);
        expect(w.lists().length).toBe(1);
        // the next call goes straight to the model that worked: no list, no retired model
        await askProvider('Mistral', { keys: KEYS, image: PNG, prompt: 'read', fetcher: w.fetcher, book: shared });
        expect(w.chats().slice(2).map((c) => c.body.model)).toEqual(['pixtral-large-latest']);
        expect(w.lists().length).toBe(1);
    });

    it('text and vision are remembered apart: healing the image slot does not move the text slot', async () => {
        const w = net({ list: ['pixtral-large-latest', 'mistral-small-latest'], chat: (model, body) => (Array.isArray(body.messages[0].content) && model === 'mistral-small-latest' ? refuse(404, 'gone') : chatOf('fine')) });
        const shared = book();
        await askProvider('Mistral', { keys: KEYS, image: PNG, prompt: 'x', fetcher: w.fetcher, book: shared });
        const before = w.chats().length;
        const text = await askProvider('Mistral', { keys: KEYS, prompt: 'x', fetcher: w.fetcher, book: shared });
        expect(text.model).toBe(PROVIDERS.Mistral.text);
        expect(w.chats().length).toBe(before + 1);
    });

    it('Ollama\'s list has another shape and is read as well', async () => {
        const w = net({ listShape: 'ollama', list: ['gemma4:31b', 'gpt-oss:120b'], chat: (model) => (model === 'gpt-oss:120b' ? refuse(404, 'model not found') : reply({ message: { content: 'ok' } })) });
        const out = await askProvider('Ollama', { keys: KEYS, prompt: 'x', fetcher: w.fetcher, book: book() });
        expect(out.text).toBe('ok');
        expect(out.model).not.toBe('gpt-oss:120b');
        expect(w.lists().length).toBe(1);
    });

    it('a quota, a key or an outage is NOT a retired model: no list is fetched and the status is reported as it is', async () => {
        for (const [status, text] of [[429, 'Rate limit exceeded'], [401, 'invalid api key'], [503, 'overloaded'], [402, 'insufficient credits']]) {
            const w = net({ list: ['pixtral-large-latest'], chat: () => refuse(status, text) });
            await expect(askProvider('Mistral', { keys: KEYS, image: PNG, prompt: 'x', fetcher: w.fetcher, book: book() })).rejects.toThrow(new RegExp(`Mistral status ${status}`));
            expect(w.lists().length, `${status} must not trigger a model lookup`).toBe(0);
            expect(w.chats().length).toBe(1);
        }
    });

    it('when every replacement is also gone, the error says which models were tried and what each said', async () => {
        const w = net({ list: ['pixtral-large-latest', 'pixtral-12b-2409', 'mistral-large-latest'], chat: () => refuse(404, '{"message":"Model not found"}') });
        const error = await askProvider('Mistral', { keys: KEYS, image: PNG, prompt: 'x', fetcher: w.fetcher, book: book() }).catch((e) => e);
        expect(error.message).toMatch(/^Mistral status 404/);
        expect(error.message).toMatch(/tried mistral-small-latest→404, pixtral-large-latest→404/);
        expect(w.chats().length).toBeLessThanOrEqual(4);                          // bounded: a provider that has nothing left is not hammered
    });

    it('an HTTP 200 that is not JSON (GitHub Models answering "OK") is said plainly, not as a parse error', async () => {
        const w = net({ chat: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); }, text: async () => 'OK\r\n' }) });
        const error = await askProvider('GitHubModels', { keys: KEYS, prompt: 'x', fetcher: w.fetcher, book: book() }).catch((e) => e);
        expect(error.message).toMatch(/GitHubModels returned non-JSON \(HTTP 200\): "OK"/);
    });

    it('a reasoning model that spends its budget thinking is asked again with room, once', async () => {
        let n = 0;
        const w = net({ chat: (model, body) => (++n === 1 ? reply({ choices: [{ message: { content: '', reasoning: 'hmm '.repeat(200) }, finish_reason: 'length' }] }) : chatOf('{"done":true}')) });
        const out = await askProvider('Groq', { keys: KEYS, prompt: 'x', tokens: 900, fetcher: w.fetcher, book: book() });
        expect(out.text).toBe('{"done":true}');
        expect(w.chats()[1].body.max_tokens).toBeGreaterThan(w.chats()[0].body.max_tokens);
    });
});

describe('askProvider: it never waits forever', () => {
    it('a provider that never answers is given up on at the call\'s own deadline, with the provider\'s name in the message', async () => {
        const fetcher = vi.fn(() => new Promise(() => {}));
        const started = Date.now();
        await expect(askProvider('Together', { keys: KEYS, image: PNG, prompt: 'x', fetcher, book: book(), deadlineMs: 60 })).rejects.toThrow(/Together deadline exceeded after 60ms/);
        expect(Date.now() - started).toBeLessThan(1500);
    });

    it('a fetch that throws (network) is passed on as it is', async () => {
        const fetcher = vi.fn(async () => { throw new Error('fetch failed: ECONNRESET'); });
        await expect(askProvider('Together', { keys: KEYS, prompt: 'x', fetcher, book: book() })).rejects.toThrow(/ECONNRESET/);
    });
});

describe('the table', () => {
    it('every provider names a list to heal from and a key name; only DeepSeek has no vision model; no retired slug is a starting point', () => {
        for (const [name, p] of Object.entries(PROVIDERS)) {
            expect(p.list, name).toMatch(/^https:\/\//);
            expect(p.url, name).toMatch(/^https:\/\//);
            expect(p.key, name).toMatch(/Key$|Token$/);
            expect(p.text, name).toBeTruthy();
        }
        expect(Object.entries(PROVIDERS).filter(([, p]) => !p.vision).map(([n]) => n)).toEqual(['DeepSeek']);
        const start = Object.values(PROVIDERS).flatMap((p) => [p.text, p.vision]).filter(Boolean).join(' ');
        // the names the scanner used to carry, each retired by its provider
        for (const gone of ['llama3.2-vision', 'qwen2.5vl', 'llama-3.2-90b-vision-preview', 'phi-3-vision-128k-instruct', 'qwen-2.5-vl-72b-instruct']) expect(start).not.toContain(gone);
    });
});

describe('choosing an image reader from a provider\'s own list', () => {
    const ids = (...list) => list.map((id) => ({ id }));
    it('a text-only model is never chosen for an image, however the list is ordered', () => {
        const models = ids('gpt-oss:120b', 'deepseek-v3.1:671b', 'llama-3.3-70b-versatile', 'qwen3-coder:480b', 'mistral-embed');
        for (const provider of ['Ollama', 'Groq', 'Mistral', 'NVIDIA', 'Together']) expect(choose({ provider, models, vision: true }), provider).toBe('');
    });
    it('today\'s families are image readers: the retired generation is passed over for the one the list offers now', () => {
        expect(choose({ provider: 'NVIDIA', vision: true, exclude: ['meta/llama-3.2-90b-vision-instruct'], models: ids('meta/llama-3.2-90b-vision-instruct', 'meta/llama-3.3-70b-instruct', 'meta/llama-4-maverick-17b-128e-instruct', 'nvidia/nv-embedqa-e5-v5') })).toBe('meta/llama-4-maverick-17b-128e-instruct');
        expect(choose({ provider: 'Ollama', vision: true, exclude: ['gemma4:31b'], models: ids('gpt-oss:120b', 'gemma4:31b', 'qwen3-vl:235b', 'kimi-k2.5') })).toBe('qwen3-vl:235b');
        expect(choose({ provider: 'Groq', vision: true, models: ids('openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.3-70b-versatile') })).toBe('meta-llama/llama-4-scout-17b-16e-instruct');
        expect(choose({ provider: 'Mistral', vision: true, models: ids('mistral-large-latest', 'pixtral-12b-2409', 'pixtral-large-latest', 'mistral-small-latest') })).toBe('pixtral-large-latest');
        expect(choose({ provider: 'Mistral', vision: true, exclude: ['pixtral-large-latest', 'pixtral-12b-2409'], models: ids('mistral-large-latest', 'mistral-small-latest', 'mistral-embed') })).toBe('mistral-small-latest');
        expect(choose({ provider: 'OpenRouterScan', vision: true, models: [{ id: 'google/gemma-4-26b-a4b-it:free', free: true }, { id: 'openai/gpt-5', free: false }, { id: 'meta-llama/llama-3.3-70b-instruct:free', free: true }] })).toBe('google/gemma-4-26b-a4b-it:free');
        expect(choose({ provider: 'GitHubModels', vision: true, models: ids('openai/gpt-4.1-mini', 'openai/gpt-4o', 'meta/llama-3.3-70b-instruct') })).toMatch(/^openai\/gpt-4/);
    });
});
