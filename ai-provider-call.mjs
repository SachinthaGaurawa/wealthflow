/* =============================================================================
 * ai-provider-call.mjs — one provider, asked for ONE answer, by a model it still serves
 * -----------------------------------------------------------------------------
 * api/vision-scan.js (the receipt scanner) named its models by hand — Ollama `llama3.2-vision` and `qwen2.5vl`, Groq `llama-3.2-90b-vision-preview`,
 * Mistral `pixtral-large-latest`, OpenRouter `qwen/qwen-2.5-vl-72b-instruct:free`, Fireworks `phi-3-vision-128k-instruct`, GitHub `gpt-4o` — and every
 * one of them has since been retired by its provider. A scan therefore answered through the OCR-then-text path alone (one reader, 70 % confidence)
 * while the engines the page promises ("12+ AI engines") each failed in a few hundred milliseconds. The statement/financial board (api/ai.js) already
 * heals a retired model by asking the provider what it serves now (ai-chat.mjs, ai-models.mjs); this file gives the scanner the same, through one
 * table instead of nine copies of the same fetch.
 *
 *   askProvider('Ollama', { keys, image, prompt, fetcher })   → { text, model }
 *
 * With an image it asks the provider's VISION slot, without one its TEXT slot (the scanner's "structure this OCR text" step). A retired model is
 * replaced from the provider's own list and remembered for hours; a quota, a key or an outage is reported as it is. Every failure carries the models
 * that were tried and what each said (chatError), so a log line or a canary report says where a provider stops. Nothing here holds a key: the caller
 * passes `keys`, named as vision-scan.js names them.
 * ===========================================================================*/

import { askChat, chatError } from './ai-chat.mjs';
import { loadModels } from './ai-models.mjs';
import { geminiBook, mimeOfBase64 } from './gemini-client.mjs';
import { OFFICIAL_ORIGIN } from './wealthflow-public-identity.mjs';

/** OpenRouter wants to know who is asking; it is the official website, as api/ai.js tells it. */
const OPENROUTER_HEADERS = { 'HTTP-Referer': OFFICIAL_ORIGIN, 'X-Title': 'WealthFlow' };

/** What each provider is, in the one place it is named. `text` / `vision` are only where a call STARTS: a retired model is replaced from `list`. */
export const PROVIDERS = Object.freeze({
    Ollama:       { kind: 'ollama', url: 'https://ollama.com/api/chat', list: 'https://ollama.com/api/tags', key: 'ollamaKey', text: 'gpt-oss:120b', vision: 'gemma4:31b' },
    Groq:         { url: 'https://api.groq.com/openai/v1/chat/completions', list: 'https://api.groq.com/openai/v1/models', key: 'groqKey', text: 'openai/gpt-oss-120b', vision: 'meta-llama/llama-4-scout-17b-16e-instruct', visionCap: 2048, jsonMode: true },
    Mistral:      { url: 'https://api.mistral.ai/v1/chat/completions', list: 'https://api.mistral.ai/v1/models', key: 'mistralKey', text: 'mistral-small-latest', vision: 'mistral-small-latest', jsonMode: true },
    Together:     { url: 'https://api.together.xyz/v1/chat/completions', list: 'https://api.together.xyz/v1/models', key: 'togetherKey', text: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', vision: 'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo' },
    Fireworks:    { url: 'https://api.fireworks.ai/inference/v1/chat/completions', list: 'https://api.fireworks.ai/inference/v1/models', key: 'fireworksKey', text: 'accounts/fireworks/models/llama-v3p3-70b-instruct', vision: 'accounts/fireworks/models/llama4-maverick-instruct-basic' },
    NVIDIA:       { url: 'https://integrate.api.nvidia.com/v1/chat/completions', list: 'https://integrate.api.nvidia.com/v1/models', key: 'nvidiaKey', text: 'nvidia/llama-3.1-nemotron-70b-instruct', vision: 'meta/llama-3.2-90b-vision-instruct' },
    DeepSeek:     { url: 'https://api.deepseek.com/chat/completions', list: 'https://api.deepseek.com/models', key: 'deepseekKey', text: 'deepseek-chat', vision: null, jsonMode: true },
    OpenRouterScan: { url: 'https://openrouter.ai/api/v1/chat/completions', list: 'https://openrouter.ai/api/v1/models', key: 'openrouterKey', text: 'inclusionai/ling-3.1-flash', vision: 'google/gemma-4-26b-a4b-it:free', openrouter: true },
    GitHubModels: { url: 'https://models.github.ai/inference/chat/completions', list: 'https://models.github.ai/catalog/models', key: 'githubToken', text: 'openai/gpt-4.1-mini', vision: 'openai/gpt-4o', jsonMode: true, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } },
});

/** A reply's body, whatever shape the provider chose (the shapes ai-chat.mjs reads): JSON, a 200 that is not JSON, or a refusal. */
async function readReply(response) {
    if (!response.ok) return { ok: false, status: response.status, text: await response.text().catch(() => '') };
    let raw = '';
    try { raw = await response.text(); } catch (_) { raw = ''; }
    try { return { ok: true, data: JSON.parse(raw) }; } catch (_) { return { ok: true, nonJson: raw || '(unreadable)', meta: '' }; }
}

/**
 * @param {string} name   a key of PROVIDERS
 * @param {object} o
 * @param {object} o.keys        { ollamaKey, groqKey, mistralKey, … } — the caller's own names for them
 * @param {string} [o.image]     base64; with it the vision slot is asked, without it the text slot
 * @param {string} o.prompt
 * @param {(url:string, init:object, ms:number)=>Promise<Response>} o.fetcher   a deadline-bound fetch
 * @param {object} [o.book]      a model book (ai-models.mjs); the shared one by default, so a model chosen here is not chosen again by the board
 * @param {number} [o.tokens=2048]
 * @param {number} [o.temperature=0.05]
 * @param {number} [o.timeoutMs=25000]   per request
 * @param {number} [o.deadlineMs=40000]  for the whole call, retries included (a retired model costs a request, a list and a second request)
 * @param {boolean} [o.json]     ask for a JSON object where the provider has a switch for it (text only)
 * @returns {Promise<{ text:string, model:string, trace:object[] }>}
 */
export async function askProvider(name, { keys = {}, image = '', prompt, fetcher, book = geminiBook, tokens = 2048, temperature = 0.05, timeoutMs = 25000, deadlineMs = 40000, json = false, log = () => {} } = {}) {
    const p = PROVIDERS[name];
    if (!p) throw new Error(`${name} is not a known provider`);
    const key = keys[p.key];
    if (!key) throw new Error('no_key');
    const role = image ? 'vision' : 'text';
    const first = p[role];
    if (!first) throw new Error(`${name} skipped (no ${role} model)`);

    const startedAt = Date.now();
    const left = () => Math.max(1500, deadlineMs - (Date.now() - startedAt));
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(p.headers || {}), ...(p.openrouter ? OPENROUTER_HEADERS : {}) };
    const mime = image ? mimeOfBase64(image) : '';
    const maxTokens = (n) => Math.max(64, Math.min(n, image && p.visionCap ? p.visionCap : n));

    const send = async (model, extra, room) => {
        let body;
        if (p.kind === 'ollama') {
            body = { model, messages: [{ role: 'user', content: prompt, ...(image ? { images: [image] } : {}) }], stream: false, ...(json ? { format: 'json' } : {}), options: { temperature, num_predict: maxTokens(room) }, ...extra };
        } else {
            const content = image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${mime};base64,${image}` } }] : prompt;
            body = { model, messages: [{ role: 'user', content }], temperature, max_tokens: maxTokens(room), ...extra };
            if (json && !image && p.jsonMode) body.response_format = { type: 'json_object' };
        }
        return readReply(await fetcher(p.url, { method: 'POST', headers, body: JSON.stringify(body) }, Math.min(timeoutMs, left())));
    };
    const listing = () => loadModels({ kind: p.kind === 'ollama' ? 'ollama' : 'openai', url: p.list, key, headers: p.headers, fetcher });

    let timer;
    const ran = askChat({
        name: p.openrouter ? 'OpenRouterScan' : name, slot: `${name}:${role}:scan`, book, defaultModel: first, tokens, cap: p.kind === 'ollama' ? 4096 : (image && p.visionCap) || 4096,
        kind: p.kind === 'ollama' ? 'ollama' : 'openai', send, vision: Boolean(image), listKey: p.list, load: listing, log,
    });
    const over = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} deadline exceeded after ${deadlineMs}ms`)), deadlineMs); });
    try { return await Promise.race([ran, over]); }
    catch (e) { throw chatError(name, e); }
    finally { clearTimeout(timer); ran.catch(() => {}); }
}
