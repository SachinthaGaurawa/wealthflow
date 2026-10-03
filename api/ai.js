// ==================== WealthFlow AI Engine v6.5 ====================
// Multi-provider AI brain with automatic failover.
// Now with proper Ollama Cloud authentication, expanded vision support,
// and improved error reporting for the new receipt-scanner module.
//
// All API keys MUST be configured as Vercel Environment Variables:
//   - WealthFlow_API_Key       (Gemini) — primary
//   - DEEPSEEK_API_KEY         (DeepSeek) — text fallback
//   - GROQ_API_KEY             (Groq Llama 3.3 + Llava vision)
//   - OLLAMA_API_KEY           (Ollama Cloud — vision + text)
//
// Notes on Ollama Cloud:
//   The correct endpoint for hosted models on ollama.com is https://ollama.com/api/chat
//   with `Authorization: Bearer $OLLAMA_API_KEY`. The chat API accepts `images` (base64
//   array) inside the `messages[].images` field for vision models.

import * as Matrix from './ai-matrix.mjs';
import { isModelGone, loadModels } from '../ai-models.mjs';
import { geminiBook, geminiGenerate, mimeOfBase64 } from '../gemini-client.mjs';
import { askChat, chatError } from '../ai-chat.mjs';
import { getAdminDb, withDeadline } from '../admin-db.mjs';
import { resetHealthMemory, serveHealth } from '../ai-health.mjs';

/* What each provider serves NOW, remembered for hours: a retired model is replaced by one the provider itself lists (ai-models.mjs).
 * One book for the whole process: Gemini's slots are shared with every other endpoint that asks Gemini (gemini-client.mjs). */
export const modelBook = geminiBook;

const providerCooldown = new Map();   // name → { until, ms, rank }
function providerCooldownMs(error) {
    const message = String(error?.message || error || '');
    if (/credit balance|billing|insufficient[_\s-]*(?:credit|quota)|payment required|status 402/i.test(message)) return 6 * 60 * 60 * 1000;
    // a model that no longer exists (404 "model not found", 410 "end of life") does not come back until the code names another:
    // asking again every fifteen seconds only spends the deadline of every call on a certain failure
    if (/status (?:404|410)\b|model (?:not found|does not exist)|not deployed|end of life|no longer available|unavailable for free/i.test(message)) return 6 * 60 * 60 * 1000;
    // a provider that answers 200 with something that is not JSON is misbehaving, not busy: half an hour, not fifteen seconds
    if (/returned non-JSON/i.test(message)) return 30 * 60 * 1000;
    if (/has no usable model right now/i.test(message)) return 10 * 60 * 1000;
    if (/unauthori[sz]ed|forbidden|invalid api key|status 401|status 403/i.test(message)) return 60 * 60 * 1000;
    if (/rate.?limit|quota|status 429/i.test(message)) return 2 * 60 * 1000;
    if (/deadline|timed?\s*out|abort/i.test(message)) return 60 * 1000;
    return 15 * 1000;
}
export function providerAvailable(name, now = Date.now()) {
    const cooling = providerCooldown.get(name);
    return !cooling || cooling.until <= now;
}
/* A cooldown that is an hour or six hours long is a provider that is DEAD (billing, a retired model, a bad key, a reply that is not JSON):
 * it stays out. One of a minute or two is a provider that was BUSY (a rate limit, a deadline, an empty reply): it is out only while the
 * board has spare — see boardRoster. */
export const HARD_COOLDOWN_MS = 10 * 60 * 1000;
/* A PROVIDER THAT KEEPS MISSING THE DEADLINE IS LEFT ALONE LONGER EACH TIME. One minute after the first miss, three after the second, five
 * after the third and every one after (inside fifteen minutes) — and a success wipes the slate. A provider that is only slow (OpenRouter's
 * Nemotron answers in 8–15 s) otherwise costs every board call the whole deadline once a minute for as long as it is configured. Never
 * long enough to count as dead (that is ten minutes): when the board is short of voters it is still asked. */
const deadlineStrikes = new Map();
export function coolProvider(name, error, now = Date.now()) {
    let ms = providerCooldownMs(error);
    const message = String(error?.message || error || '');
    if (ms < HARD_COOLDOWN_MS && /deadline|timed?\s*out|abort/i.test(message)) {
        const before = deadlineStrikes.get(name);
        const strikes = before && now - before.at < 15 * 60 * 1000 ? before.strikes + 1 : 1;
        deadlineStrikes.set(name, { strikes, at: now });
        ms = [60 * 1000, 180 * 1000, 300 * 1000][Math.min(strikes - 1, 2)];
    }
    // when a busy provider is asked again it is the quick failers first: a rate limit says so at once, a deadline keeps the board waiting
    providerCooldown.set(name, { until: now + ms, ms, rank: /deadline|timed?\s*out|abort/i.test(message) ? 2 : /rate.?limit|quota|status 429/i.test(message) ? 0 : 1 });
}
export function providerIsDead(name, now = Date.now()) {
    const cooling = providerCooldown.get(name);
    return Boolean(cooling && cooling.until > now && cooling.ms >= HARD_COOLDOWN_MS);
}
/**
 * WHO IS ASKED. Every eligible configured provider that is not resting. But a cooldown is an optimisation, never a reason to refuse: the
 * production log of 2026-10-01 shows requests refused (422) in under four seconds with no provider failure logged — a burst of
 * ordinary failures had put so many providers into a one-to-two-minute cooldown that fewer than five were left to ask, although most of
 * them would have answered. So a cooldown is honoured only while at least `needed` providers remain available (five voters plus spare);
 * below that, EVERY provider that was only BUSY (a rate limit, a deadline, an empty reply) is asked too — quick failers listed first —
 * and the ones that are DEAD (billing, a retired model, a bad key, a reply that is not JSON) never are.
 */
export function boardRoster(eligible, { needed = 1, now = Date.now() } = {}) {
    const asked = eligible.filter(name => providerAvailable(name, now));
    const resting = eligible.filter(name => !providerAvailable(name, now));
    let probation = [];
    if (asked.length < needed) {
        const busy = resting.filter(name => !providerIsDead(name, now)).sort((a, b) => providerCooldown.get(a).rank - providerCooldown.get(b).rank || providerCooldown.get(a).until - providerCooldown.get(b).until);
        // The ones that answer quickly — a rate limit, an empty reply — are all asked: they cost nothing to wait for. The ones that KEEP THE BOARD
        // WAITING (a missed deadline, an aborted call: rank 2) are asked only as many as are still needed to reach the target. Production log,
        // 2026-10-01: with six healthy voters and the target at eight, the two chronically slow providers were asked every time and every board
        // lasted its full thirteen seconds — fourteen HNB statements and every NTB/AMEX slice that needed it paid that — for voters that never answered.
        const quick = busy.filter(name => providerCooldown.get(name).rank < 2), slow = busy.filter(name => providerCooldown.get(name).rank >= 2);
        probation = [...quick, ...slow.slice(0, Math.max(0, needed - asked.length - quick.length))];
    }
    return { asked: [...asked, ...probation], probation, resting: resting.filter(name => !probation.includes(name)) };
}
export function resetProviderCooldowns() { providerCooldown.clear(); deadlineStrikes.clear(); }

/* Every eligible configured engine is started before any result is awaited.
 * A response is reduced only after all members settle or hit their individual
 * deadline, so a late dissent can never be silently discarded. */

export const config = {
    maxDuration: 45 // seconds — long enough for deep responses
};

// ----- Embedded fallback Ollama key (project key supplied by the project owner)
// This is intentionally low-trust: it works for low-volume use, but if you want
// production-grade limits, set OLLAMA_API_KEY in Vercel and it'll take precedence.
/* THE KEY THAT USED TO SIT HERE IS GONE, AND IT MUST BE REVOKED.
 *
 * A literal Ollama Cloud key was hardcoded at this line as a "low-trust
 * fallback" so the engine worked without configuration. This repository is
 * PUBLIC. A credential in a public file is a credential everyone has, and no
 * amount of low-trust framing changes that — the owner's standing instruction
 * is that keys are never to be exposed.
 *
 * Removing it from HEAD does not remove it from git history, so the key that
 * was here has to be revoked at the provider. That is the owner's action; this
 * change only stops the file handing it out.
 *
 * The engine now reads OLLAMA_API_KEY from the environment and nothing else.
 * Unset, it is simply not in the fan-out — there are fifteen other engines, and
 * a missing one costs a vote rather than an answer. */

// Helper: fetch with timeout — prevents one slow provider from blocking the chain
async function transportWithTimeout(url, options, timeoutMs = 22000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function isFinancialTask(task) {
    return typeof task === 'string' && /^(financial|extraction|categorization|routing|verification|vision)$/i.test(task);
}

export { resetHealthMemory };

export default async function handler(req, res) {
    // CORS — allow the public Vercel deployment to be called from anywhere
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    // the AI asked on demand: GET ?canary=1 / ?health=1 (ai-health.mjs); anything else is not a GET this endpoint answers
    if (req.method === 'GET') return serveHealth(req, res, { run: handler, getDb: getAdminDb, withDeadline });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { prompt, image, temperature, maxTokens, preferredProvider } = req.body || {};
    if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'Missing prompt' });
    // Financial consumers declare their intent explicitly. Conservative legacy
    // detection also prevents JSON/category callers from bypassing the board
    // through wording changes or a fastest-mode override.
    /* A caller that is ASKING FOR ADVICE says so (task: 'advice'), and is then never put through the
     * unanimous financial board. The wording of a prompt cannot say what it is for: the chat engine's
     * own system prompt describes a chart format "with JSON" and names spending categories, so every
     * chat reply and every AI Insight was read as a financial decision needing five engines to return
     * the same words — which free text never does, and the answer was HTTP 422 for everybody.
     * Whoever files money does not send this flag (they declare financialDecision or a financial
     * task), so the board still guards every decision that can reach the books. */
    // A client that predates the flag still sends the chat engine's own envelope — a conversation block
    // closed by the reply-language gate — and that envelope is never built for a financial decision.
    const chatEnvelope = /--- CONVERSATION ---[\s\S]*\[REPLY NOW — in /.test(prompt) && !image;
    const advisory = (req.body?.task === 'advice' || chatEnvelope) && req.body?.financialDecision !== true;
    const wantsJSON = !advisory && (/\bjson\b|\{[^}]*"vendor"[^}]*\}/i.test(prompt) || req.body?.responseFormat === 'json');
    const financialDecision = req.body?.financialDecision === true || (!advisory && (isFinancialTask(req.body?.task) || wantsJSON || !!image || /\bcategor(?:ize|ise|ization|isation|y|ies)\b|\broute\b[\s\S]*\btransaction/i.test(prompt)));
    const requestedDeadline = req.body?.deadlineMs;
    const deadlineMs = Number.isInteger(requestedDeadline) ? Math.max(2000, Math.min(24000, requestedDeadline)) : 24000;
    const fetchWithTimeout = (url, options, timeoutMs = 22000) => transportWithTimeout(url, options, Math.min(timeoutMs, deadlineMs));

    // Pull keys ONLY from environment (Ollama has an embedded fallback)
    const geminiKey   = process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const groqKey     = process.env.GROQ_API_KEY;
    const ollamaKey   = process.env.OLLAMA_API_KEY;
    // v7.24 — every additional provider the owner has configured in Vercel.
    const mistralKey    = process.env.MISTRAL_API_KEY;
    const togetherKey   = process.env.TOGETHER_API_KEY;
    const fireworksKey  = process.env.FIREWORKS_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const nvidiaKey     = process.env.NVIDIA_API_KEY;
    // GitHub Models is paid for by the token's own "Models: read" permission. The owner's fine-grained GH_PAT (the one Vercel already holds
    // for feedback issues) has it since 2026-10-03; GITHUB_MODELS_TOKEN does not, and answered 200 "OK" to every canary, so GH_PAT goes first.
    const githubKey     = process.env.GH_PAT || process.env.GITHUB_MODELS_TOKEN;
    const cohereKey     = process.env.COHERE_API_KEY;
    const cloudflareToken = process.env.CLOUDFLARE_AI_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
    const cloudflareAccount = process.env.CLOUDFLARE_ACCOUNT_ID;

    // Vision requests need deterministic output (low temp) and more room for detail
    const isVision = !!image;
    const temp   = (typeof temperature === 'number') ? temperature : (isVision ? 0.05 : 0.7);
    const tokens = (typeof maxTokens   === 'number') ? maxTokens   : (isVision ? 4096 : 2500);

    // ---------- ENGINE 1: GEMINI (Primary, supports vision) ----------
    async function fetchGemini() {
        if (!geminiKey) throw new Error('Gemini key not configured');
        // One shared client (gemini-client.mjs) owns everything that used to fail here and in ten other files: a retired model is
        // replaced from Google's own list, a quota answer parks that model for as long as Google said and moves to another one
        // (the quota is per model), a busy model is asked once more then another, a 400 that names a setting is re-sent without it,
        // a reply emptied by thinking is asked again with room — and none of it is asked twice in a row to fail the same way.
        const parts = [{ text: prompt }];
        if (image) parts.push({ inline_data: { mime_type: mimeOfBase64(image), data: image } });
        const structured = wantsJSON || financialDecision;
        const result = await geminiGenerate({
            key: geminiKey, parts, json: structured, thinking: structured ? 'low' : undefined,
            temperature: temp, maxOutputTokens: tokens, deadlineMs, fetcher: fetchWithTimeout, book: modelBook
        });
        return { reply: result.text, provider: `gemini:${result.model}` };
    }

    // ---------- ENGINE 2: DEEPSEEK (Fallback, text-only) ----------
    async function fetchDeepSeek() {
        if (image) throw new Error('DeepSeek skipped (text-only)');
        if (!deepseekKey) throw new Error('DeepSeek key not configured');
        const slot = 'DeepSeek:text';
        const send = async (model) => {
            const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${deepseekKey}`
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: temp,
                    max_tokens: tokens
                })
            });
            if (response.ok) return { ok: true, response };
            return { ok: false, status: response.status, text: await response.text().catch(() => '') };
        };
        let model = modelBook.current(slot) || 'deepseek-chat';
        let out = await send(model);
        if (!out.ok && isModelGone(out.status, out.text)) {
            modelBook.markBad(slot, model);
            const next = await modelBook.replacement({ slot, provider: 'DeepSeek', failed: model, load: () => loadModels({ kind: 'openai', url: 'https://api.deepseek.com/models', key: deepseekKey, fetcher: fetchWithTimeout }) });
            if (next) { const retry = await send(next); if (retry.ok) { modelBook.remember(slot, next); model = next; out = retry; } else modelBook.markBad(slot, next); }
        }
        if (!out.ok) throw new Error(`DeepSeek status ${out.status}`);
        const data = await out.response.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('DeepSeek returned empty');
        return { reply: text, provider: model === 'deepseek-chat' ? 'deepseek' : `deepseek:${model}` };
    }

    /* A reply's body, whatever the provider sent: { ok, data } for JSON, { ok, nonJson } for a 200 that is not JSON (said plainly in the
     * error, with its first words), { ok:false, status, text } for a refusal. */
    const readReply = async (r) => {
        if (!r.ok) return { ok: false, status: r.status, text: await r.text().catch(() => '') };
        try { return { ok: true, data: typeof r.json === 'function' ? await (typeof r.clone === 'function' ? r.clone() : r).json() : JSON.parse(await r.text()) }; }
        catch (_) {
            // what the 200 was, besides its words: the content type, who answered, whether we were sent somewhere else (a proxy's "OK", an HTML page)
            let meta = '';
            try { const h = r.headers && typeof r.headers.get === 'function' ? r.headers : null; meta = [h && h.get('content-type'), h && h.get('server'), r.redirected ? 'redirected' : '', r.url ? new URL(r.url).host : ''].filter(Boolean).join('; ').slice(0, 80); } catch (_) { /* advice */ }
            return { ok: true, nonJson: (typeof r.text === 'function' ? await r.text().catch(() => '') : '') || '(unreadable)', meta };
        }
    };

    // ---------- ENGINE 3: GROQ (ultra-fast text + vision via Llava) ----------
    async function fetchGroq() {
        if (!groqKey) throw new Error('Groq key not configured');
        // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16 (confirmed live: 404). gpt-oss-120b is Groq's own
        // recommended replacement — a REASONING model: its thinking shares the completion budget with the answer, so it is asked
        // for little reasoning (reasoning_effort: low) and, if it still answers nothing, given room (ai-chat.mjs).
        const slot = image ? 'Groq:vision' : 'Groq:text';
        const send = async (model, extra, maxTokens) => {
            const payload = image
                ? { model, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }] }], temperature: temp, max_tokens: Math.min(maxTokens, 2048) }
                : { model, messages: [{ role: 'user', content: prompt }], temperature: temp, max_tokens: maxTokens };
            return readReply(await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` }, body: JSON.stringify({ ...payload, ...extra })
            }));
        };
        const dflt = image ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'openai/gpt-oss-120b';
        try {
            const out = await askChat({ name: 'Groq', slot, book: modelBook, defaultModel: dflt, tokens, cap: image ? 2048 : 4096, send, vision: !!image, log: console.info,
                load: () => loadModels({ kind: 'openai', url: 'https://api.groq.com/openai/v1/models', key: groqKey, fetcher: fetchWithTimeout }) });
            return { reply: out.text, provider: out.model === dflt ? (image ? 'groq:llama-4-scout' : 'groq:gpt-oss-120b') : `groq:${out.model}` };
        } catch (e) { throw chatError('Groq', e); }
    }

    // ---------- ENGINE 4: OLLAMA CLOUD (vision + text, hosted) ----------
    // Correct endpoint for the *hosted* ollama.com API:
    //   POST https://ollama.com/api/chat   (Authorization: Bearer ...)
    // Note: model names like "gpt-oss:120b" or "llama3.2-vision:11b" work directly here. gpt-oss THINKS: its thinking shares the
    // num_predict budget with the answer (`message.thinking` beside an empty `message.content`), so it is asked to think "low".
    async function fetchOllama() {
        if (!ollamaKey) throw new Error('Ollama key not configured');

        const message = { role: 'user', content: prompt };
        if (image) message.images = [image];

        // Pick the right model: vision-capable for images, text-only otherwise
        const slot = image ? 'Ollama:vision' : 'Ollama:text';
        const send = async (model, extra, maxTokens) => readReply(await fetchWithTimeout('https://ollama.com/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ollamaKey}` },
            body: JSON.stringify({
                model,
                messages: [message],
                stream: false,
                // Suggest JSON output if the prompt hints at it
                ...(/return only.*json|extract.*json/i.test(prompt) ? { format: 'json' } : {}),
                options: { temperature: temp, num_predict: maxTokens },
                ...extra
            })
        }));
        const dflt = image ? 'llama3.2-vision' : 'gpt-oss:120b';
        try {
            const out = await askChat({ name: 'Ollama', slot, book: modelBook, defaultModel: dflt, tokens, cap: 4096, kind: 'ollama', send, vision: !!image, log: console.info,
                load: () => loadModels({ kind: 'ollama', url: 'https://ollama.com/api/tags', key: ollamaKey, fetcher: fetchWithTimeout }) });
            return { reply: out.text, provider: `ollama:${out.model}` };
        } catch (e) { throw chatError('Ollama', e); }
    }

    // ---------- ENGINES 5-14: every other provider configured in Vercel ----------
    // Most are OpenAI-compatible (/chat/completions + Bearer). One factory builds
    // them all; Cohere uses its own shape below. Each fires in parallel with
    // the rest and contributes to fastest/consensus selection.
    function makeOAI(opts) {
        return async function () {
            if (!opts.key) throw new Error(opts.name + ' key not configured');
            if (image && !opts.visionModel) throw new Error(opts.name + ' skipped (text-only)');
            const slot = `${opts.name}:${image ? 'vision' : 'text'}`;
            const content = image
                ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }]
                : prompt;
            const headers = Object.assign(
                { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.key}` },
                opts.extraHeaders || {}
            );
            const send = async (model, extra, maxTokens) => {
                const body = { model, messages: [{ role: 'user', content }], temperature: temp, max_tokens: maxTokens, ...extra };
                if (!image && opts.jsonMode && /return only.*json|extract.*json|\{[^}]*"vendor"[^}]*\}/i.test(prompt)) {
                    body.response_format = { type: 'json_object' };
                }
                return readReply(await fetchWithTimeout(opts.url, { method: 'POST', headers, body: JSON.stringify(body) }, opts.timeout || 22000));
            };
            /* THE MODEL IS GONE, NOT THE PROVIDER: ask the provider what it serves now, choose the best live model for this role,
             * try up to three, and remember the one that answers (ai-chat.mjs, ai-models.mjs). A model that answers NOTHING (a
             * thinking model that spent its budget) is asked for little reasoning, then given room, then left for the next one. */
            const dflt = image ? opts.visionModel : opts.textModel;
            try {
                const out = await askChat({ name: opts.name, slot, book: modelBook, defaultModel: dflt, tokens, cap: opts.maxTokens || 4096, send, vision: !!image, listKey: opts.list, log: console.info,
                    load: opts.list ? () => loadModels({ kind: 'openai', url: opts.list, key: opts.key, headers: opts.extraHeaders, fetcher: fetchWithTimeout }) : undefined });
                return { reply: out.text, provider: out.model === dflt ? opts.provider : `${opts.provider}:${out.model}` };
            } catch (e) { throw chatError(opts.name, e); }
        };
    }

    // mistral-large-latest is paid-tier only (confirmed live: 403 "not available in
    // your subscription tier"); mistral-small-latest is served on the free plan.
    const fetchMistral = makeOAI({ name: 'Mistral', provider: 'mistral', key: mistralKey, url: 'https://api.mistral.ai/v1/chat/completions', list: 'https://api.mistral.ai/v1/models', textModel: 'mistral-small-latest', visionModel: 'pixtral-12b-2409', jsonMode: true });
    const fetchTogether = makeOAI({ name: 'Together', provider: 'together', key: togetherKey, url: 'https://api.together.xyz/v1/chat/completions', list: 'https://api.together.xyz/v1/models', textModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', visionModel: 'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo' });
    const fetchFireworks = makeOAI({ name: 'Fireworks', provider: 'fireworks', key: fireworksKey, url: 'https://api.fireworks.ai/inference/v1/chat/completions', list: 'https://api.fireworks.ai/inference/v1/models', textModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', visionModel: 'accounts/fireworks/models/llama-v3p2-90b-vision-instruct' });
    const openRouterHeaders = { 'HTTP-Referer': 'https://wealthflow-personal.vercel.app', 'X-Title': 'WealthFlow' };
    const fetchOpenRouterFinance = makeOAI({ name: 'OpenRouterFinance', provider: 'openrouter:ling-fin-free', key: openrouterKey, url: 'https://openrouter.ai/api/v1/chat/completions', list: 'https://openrouter.ai/api/v1/models', role: 'Finance', textModel: 'inclusionai/ling-3.0-flash-fin:free', visionModel: null, extraHeaders: openRouterHeaders });
    const fetchOpenRouterQwen = makeOAI({ name: 'OpenRouterQwen', provider: 'openrouter:qwen-free', key: openrouterKey, url: 'https://openrouter.ai/api/v1/chat/completions', list: 'https://openrouter.ai/api/v1/models', role: 'Qwen', textModel: 'qwen/qwen3.8-27b:free', visionModel: 'qwen/qwen3.8-27b:free', jsonMode: false, extraHeaders: openRouterHeaders });
    const fetchOpenRouterNemotron = makeOAI({ name: 'OpenRouterNemotron', provider: 'openrouter:nemotron-free', key: openrouterKey, url: 'https://openrouter.ai/api/v1/chat/completions', list: 'https://openrouter.ai/api/v1/models', role: 'Nemotron', textModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', visionModel: null, extraHeaders: openRouterHeaders });
    // meta/llama-3.3-70b-instruct reached end of life 2026-08-26 (confirmed live:
    // 410 Gone). meta/llama-3.1-8b-instruct is NVIDIA's smaller, currently-documented
    // sibling model in the same family.
    const fetchNvidia = makeOAI({ name: 'NVIDIA', provider: 'nvidia', key: nvidiaKey, url: 'https://integrate.api.nvidia.com/v1/chat/completions', list: 'https://integrate.api.nvidia.com/v1/models', textModel: 'meta/llama-3.1-8b-instruct', visionModel: 'meta/llama-3.2-90b-vision-instruct' });
    // The old Azure-fronted endpoint and bare model names (models.inference.ai.azure.com,
    // "Llama-3.3-70B-Instruct") are retired (confirmed live: fetch failed — the host no
    // longer resolves for this traffic). Current: models.github.ai/inference, with every
    // model namespaced "<publisher>/<model>".
    const fetchGitHub = makeOAI({ name: 'GitHubModels', provider: 'github-models', key: githubKey, url: 'https://models.github.ai/inference/chat/completions', textModel: 'openai/gpt-4o-mini', visionModel: 'openai/gpt-4o', jsonMode: true, extraHeaders: { 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    const fetchCloudflare = makeOAI({
        name: 'CloudflareAI',
        provider: 'cloudflare:llama-4-scout',
        key: cloudflareToken,
        url: cloudflareAccount ? `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/ai/v1/chat/completions` : '',
        textModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
        visionModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
        jsonMode: true
    });

    // ---------- ENGINE: COHERE (native v2 chat, text-only) ----------
    async function fetchCohere() {
        if (image) throw new Error('Cohere skipped (text-only)');
        if (!cohereKey) throw new Error('Cohere key not configured');
        const r = await fetchWithTimeout('https://api.cohere.com/v2/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cohereKey}` },
            body: JSON.stringify({ model: 'command-r-plus-08-2024', messages: [{ role: 'user', content: prompt }], temperature: temp })
        });
        if (!r.ok) throw new Error(`Cohere status ${r.status}`);
        const data = await r.json();
        const text = Array.isArray(data.message?.content) ? data.message.content.map(c => c.text || '').join('') : '';
        if (!text.trim()) throw new Error('Cohere returned empty');
        return { reply: text, provider: 'cohere:command-r-plus' };
    }

    // ---------- PARALLEL MULTI-ENGINE EXECUTION ----------
    // All engines fire SIMULTANEOUSLY (not one-by-one). This is dramatically
    // faster and more reliable: a slow/down provider no longer blocks the rest.
    //
    //  • mode=corroborated → wait for every eligible configured engine, then
    //                        let api/ai-matrix.mjs reconcile all testimony.
    //  • mode=consensus    → wait for every engine, then vote (vision / JSON)
    //  • mode=fastest      → retained as a compatibility alias only. WealthFlow
    //                        never releases an answer before the full eligible
    //                        board has settled or reached its per-engine deadline.
    const errorLog = [];

    let engines;
    if (isVision) {
        // Every vision-capable provider contributes to consensus on receipts/statements.
        engines = [
            { name: 'Gemini',       fn: fetchGemini },
            { name: 'Groq',         fn: fetchGroq },
            { name: 'Ollama',       fn: fetchOllama },
            { name: 'GitHubModels', fn: fetchGitHub },
            { name: 'Together',     fn: fetchTogether },
            { name: 'Fireworks',    fn: fetchFireworks },
            { name: 'NVIDIA',       fn: fetchNvidia },
            { name: 'Mistral',      fn: fetchMistral },
            { name: 'OpenRouterQwen', fn: fetchOpenRouterQwen },
            { name: 'CloudflareAI', fn: fetchCloudflare }
        ];
    } else {
        engines = [
            { name: 'Gemini',       fn: fetchGemini },
            { name: 'DeepSeek',     fn: fetchDeepSeek },
            { name: 'Groq',         fn: fetchGroq },
            { name: 'Ollama',       fn: fetchOllama },
            { name: 'Mistral',      fn: fetchMistral },
            { name: 'Together',     fn: fetchTogether },
            { name: 'Fireworks',    fn: fetchFireworks },
            { name: 'OpenRouterFinance', fn: fetchOpenRouterFinance },
            { name: 'OpenRouterQwen', fn: fetchOpenRouterQwen },
            { name: 'OpenRouterNemotron', fn: fetchOpenRouterNemotron },
            { name: 'NVIDIA',       fn: fetchNvidia },
            { name: 'GitHubModels', fn: fetchGitHub },
            { name: 'Cohere',       fn: fetchCohere },
            { name: 'CloudflareAI', fn: fetchCloudflare }
        ];
    }

    // A missing credential is not a configured board member. Runtime failures
    // remain visible in the audit roster, but spare configured engines can
    // replace them once ten valid independent answers still agree exactly.
    // Anthropic, xAI, SambaNova and EdenAI were removed from the roster
    // entirely (2026-09-28): their Vercel accounts are out of credit/payment
    // method, so every call was a guaranteed, wasted failure that only ate
    // into the deadline budget without ever being able to vote.
    // Cerebras and HuggingFace followed (2026-10-03, the owner's decision): both answered 402 (no credit) in under half a second on
    // every canary, so they could never vote and only filled the log. Their Vercel variables are now unused by this board.
    const configured = { Gemini: geminiKey, DeepSeek: deepseekKey, Groq: groqKey, Ollama: ollamaKey,
        Mistral: mistralKey, Together: togetherKey,
        Fireworks: fireworksKey, OpenRouterFinance: openrouterKey, OpenRouterQwen: openrouterKey, OpenRouterNemotron: openrouterKey,
        NVIDIA: nvidiaKey, GitHubModels: githubKey, Cohere: cohereKey,
        CloudflareAI: cloudflareToken && cloudflareAccount };
    // Providers resting in a cooldown are not asked while the board has spare; below five voters plus three spare, every provider that
    // was only busy is asked anyway (boardRoster). Resting and probation are named in the board's log line below.
    const configuredNames = engines.filter(engine => Boolean(configured[engine.name])).map(engine => engine.name);
    // a canary run (ai-health.mjs) asks everyone configured, cooldowns ignored: it exists to find out what each provider does NOW
    const roster = req.__probe ? { asked: configuredNames, probation: [], resting: [] } : boardRoster(configuredNames, { needed: financialDecision ? 8 : 1 });
    const resting = roster.resting, probation = roster.probation;
    engines = engines.filter(engine => roster.asked.includes(engine.name));
    /* A caller that wants ONE answer it will check itself (the statement reader: nothing a model says is believed until it balances
     * to the unit) may name which providers to ask. It asks the strongest few first and widens only if they fail — instead of every
     * provider at once, which spent every quota on every call. Never honoured for a financial decision: that board is the whole
     * configured roster by design. */
    if (!financialDecision && Array.isArray(req.body?.engines)) {
        const only = new Set(req.body.engines.filter(name => typeof name === 'string').slice(0, 20));
        if (only.size) engines = engines.filter(engine => only.has(engine.name));
    }
    // The required roster must match the task capability. A configured
    // text-only provider is not a missing vision voter; every eligible provider
    // is still required and a failed eligible provider still blocks unanimity.
    const expectedNames = engines.map(engine => engine.name);
    if (!engines.length) return res.status(503).json({ error: 'No AI providers configured.', needsReview: true, trustworthy: false, corroboration: { agreed: 0, of: 0, score: 0 } });

    // Wants JSON (receipt extraction etc.) → use consensus for max accuracy.
    const requestedMode = (req.body && req.body.mode) ? String(req.body.mode) : null;
    // `fastest` and `consensus` are legacy caller vocabulary. They now both mean
    // a collective board; no endpoint path is allowed to discard late dissent.
    const mode = financialDecision ? 'unanimous' : 'collective';
    const requestedModeAlias = requestedMode || 'corroborated';
    const task = advisory ? Matrix.TASK.PROSE : isVision ? Matrix.TASK.VISION : wantsJSON ? Matrix.TASK.EXTRACTION : Matrix.TASK.PROSE;

    // Wrap each engine call so a rejection becomes a tagged result, never throws.
    function runWithin(engine, limitMs) {
        const started = Date.now();
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Provider response deadline exceeded')), limitMs);
        });
        return Promise.race([Promise.resolve()
            .then(() => engine.fn())
            .then(r => { deadlineStrikes.delete(engine.name); return { ok: true, name: engine.name, reply: r.reply, provider: r.provider, ms: Date.now() - started }; }), deadline])
            .catch(e => {
                coolProvider(engine.name, e);
                console.warn(`[AI] ${engine.name} failed:`, e.message);
                errorLog.push(`${engine.name}: ${e.message}`);
                return { ok: false, name: engine.name, error: e.message, ms: Date.now() - started };
            }).finally(() => clearTimeout(timer));
    }

    const run = (engine) => runWithin(engine, deadlineMs);

    const isValid = (txt) => typeof txt === 'string' && txt.trim().length > 1;

    // Start the entire eligible board before awaiting any member, then retain
    // every success, failure and timeout in the decision record.
    const boardStarted = Date.now();
    const results = await Promise.all(engines.map(run));
    const reasked = [];
    if (mode === 'unanimous') {
        /* A DISSENT HAS TO BE REPRODUCIBLE TO VETO. Free-tier models glitch, and any valid dissent vetoes. So when a clear majority (at
         * least the quorum, two thirds of those who answered) agree and a few providers (at most three) JUDGED differently, those
         * providers are asked ONCE MORE. One that now agrees with the majority had a glitch and counts as agreeing; one that still says
         * something else — or cannot be reached — keeps its veto. A real disagreement, or an answer a hijacked description produced,
         * is reproducible and stays a veto. (An answer whose keys are a mangled version of the majority's — ai-matrix.mjs boardReading —
         * is repeatable garbage, not a judgement: it is not asked again and the board lists it as invalid.) The quorum, the unanimity
         * rule and `needsReview` are untouched. */
        try {
            const reading = Matrix.boardReading(results.filter(r => r && r.ok).map(r => ({ name: r.name, reply: r.reply })), 5);
            // a MANGLED answer (keys torn) is repeatable garbage, not a glitch to ask again; only a differing judgement is re-asked
            if (reading.clear && reading.dissent.length > 0 && reading.dissent.length <= 3) {
                const again = await Promise.all(reading.dissent.map(name => runWithin(engines.find(e => e.name === name), Math.min(deadlineMs, 6000))));
                again.forEach((second, i) => {
                    const name = reading.dissent[i];
                    const value = second.ok ? Matrix.boardAnswer(second.reply) : null;
                    const agreed = value !== null && Matrix.canonicalAnswer(value) === reading.topKey;
                    reasked.push({ name, agreed });
                    if (agreed) results[results.findIndex(r => r && r.name === name)] = second;
                });
            }
        } catch (_) { /* advice: the board decides on what it already has */ }
        // Five independent engines already gives real cross-checking (chance
        // agreement on a categorical answer collapses fast per extra voter);
        // ten was set once, never checked against how many of the configured
        // providers are simultaneously healthy in practice, and silently
        // failed every unanimous vote whenever fewer than ten were up at once
        // — which is the normal case, not the exception, for free-tier keys.
        /* A caller whose question is a LIST OF ROWS may ask for the answer to be read row by row too (`itemwise: { path, id }`): the whole answer
         * is judged exactly as before — `unanimous` and the 422 are unchanged, so a caller that does not ask is not affected — and the body also says
         * which rows every voter agreed on (`items`). The key names are plain identifiers; anything else is ignored. */
        const itemwise = (() => {
            const spec = req.body && req.body.itemwise;
            const name = v => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(v);
            return spec && typeof spec === 'object' && name(spec.path) && (spec.id === undefined || name(spec.id)) ? { path: spec.path, id: spec.id || 'index' } : null;
        })();
        const decision = Matrix.unanimousDecision(results, { task, expected: expectedNames, minimumProviders: 5, allowUnavailable: true, ...(itemwise ? { itemwise } : {}) });
        /* ONE LINE PER FINANCIAL DECISION, so the log says why a board of sixteen did or did not reach five: who answered, who was asked
         * and failed (and how), who was resting, and the reason. (Before this the answer had to be inferred from scattered warnings.) */
        try {
            // when it refused over a disagreement, WHO differed and what the rest said is the finding — not "provider_disagreement"
            const differing = decision.unanimous || decision.reason !== 'provider_disagreement' ? null : (() => {
                const reading = Matrix.boardReading(results.filter(r => r && r.ok).map(r => ({ name: r.name, reply: r.reply })), 5);
                const key = (name) => { const a = reading.answers.find(x => x.name === name); return a ? String(a.key).slice(0, 90) : ''; };
                const groups = {}; for (const a of reading.answers) (groups[a.key.slice(0, 60)] = groups[a.key.slice(0, 60)] || []).push(a.name);
                return { clear: reading.clear, groups: Object.values(groups).sort((x, y) => y.length - x.length).slice(0, 4), sample: reading.dissent.slice(0, 2).map(key) };
            })();
            // an answer that was refused is named by WHY (cut off, prose around the JSON, broken syntax, torn keys): "invalid" alone cannot tell a model that ran out of room from one that talks first
            const invalidWhy = {};
            for (const name of decision.invalid || []) { const r = results.find(x => x && x.name === name); invalidWhy[name] = (r && r.ok ? Matrix.whyInvalid(r.reply) : null) || 'mangled-keys'; }
            console.info(JSON.stringify({ evt: 'ai-board', ok: decision.unanimous, reason: decision.reason || '', answered: decision.answered, invalid: decision.invalid, ...(decision.invalid && decision.invalid.length ? { invalidWhy } : {}),
                failed: results.filter(r => !r.ok).map(r => `${r.name}:${String(r.error || '').replace(/\s+/g, ' ').slice(0, 36)}`), resting, probation, ...(reasked.length ? { reasked } : {}), ...(differing ? { differing } : {}), ...(decision.items && !decision.items.reason ? { rows: { agreed: decision.items.agreed.length, disputed: decision.items.disputed.length } } : {}), ms: Date.now() - boardStarted }));
        } catch (_) { /* a log line never decides a financial question */ }
        // Preserve a machine-readable quarantine outcome; no partial answer is
        // released to consumers that might otherwise file a majority guess.
        return res.status(decision.unanimous ? 200 : 422).json({
            ...decision, trustworthy: Matrix.trustworthy(decision),
            engines: engines.map(e => e.name), financialDecision: true, advisoryOnly: false, consensusOf: decision.answered.length,
            ...(req.__probe ? { probe: results.map(r => ({ name: r.name, ok: r.ok === true, ms: r.ms, provider: r.provider, reply: r.reply, error: r.error })), reasked } : {}),
            consensusConfidence: decision.unanimous ? 1 : 0,
            error: decision.unanimous ? null : 'AI consensus requires review.'
        });
    }
    const good = results.filter(r => r.ok && isValid(r.reply));

    if (good.length === 0) {
        return res.status(503).json({
            error: 'All AI providers are temporarily unavailable.',
            details: errorLog.join(' | ')
        });
    }

    // Scoring: prefer the response most representative of the set.
    //  • JSON tasks → the one that parses AND agrees with the majority on key fields
    //  • Prose      → the longest substantive answer (proxy for completeness),
    //                 lightly weighted toward faster engines on ties
    function tryParse(s) {
        try {
            const m = s.match(/\{[\s\S]*\}/);
            return m ? JSON.parse(m[0]) : null;
        } catch (_) { return null; }
    }

    let best;
    let proseDecision = null;
    if (wantsJSON) {
        const parsed = good.map(r => ({ r, j: tryParse(r.reply) })).filter(x => x.j);
        if (parsed.length) {
            // v7.47.0 — MULTI-FIELD CONSENSUS. Each key field is voted on
            // INDEPENDENTLY (its own majority), so the winning extraction reflects
            // the majority on EVERY field — not just amount+vendor. Blank/missing
            // values never win a field (they're skipped in the tally), so one
            // engine returning "" can't dilute a real consensus. Fields are
            // weighted: the financial core (amount, vendor) outweighs the
            // classification fields (type, category, destination) on ties.
            const CFIELDS = [
                { k: 'amount',      w: 4, norm: v => (v === 0 || v) ? v : null },
                { k: 'vendor',      w: 3, norm: v => (v || '').toString().toLowerCase().trim() || null },
                { k: 'type',        w: 2, norm: v => (v || '').toString().toLowerCase().trim() || null },
                { k: 'category',    w: 2, norm: v => (v || '').toString().toLowerCase().trim() || null },
                { k: 'destination', w: 2, norm: v => (v || '').toString().toLowerCase().trim() || null }
            ];
            const majority = {};
            const agreement = {};
            CFIELDS.forEach(f => {
                const t = {};
                let total = 0;
                parsed.forEach(({ j }) => {
                    const val = f.norm(j ? j[f.k] : null);
                    if (val === null) return;              // skip blanks — they can't win a field
                    total++;
                    const kk = JSON.stringify(val);
                    t[kk] = (t[kk] || 0) + 1;
                });
                let bestVal, bestN = 0;
                Object.entries(t).forEach(([kk, n]) => { if (n > bestN) { bestN = n; bestVal = kk; } });
                if (bestVal !== undefined) { majority[f.k] = JSON.parse(bestVal); agreement[f.k] = { votes: bestN, of: total, ratio: total ? Math.round((bestN / total) * 1000) / 1000 : 0 }; }
            });
            // Score every parsed reply by weighted agreement with the field-wise
            // majority; the reply matching the most consensus fields wins. Falls
            // back gracefully to the first parse if nothing scores.
            let best2 = null, bestScore = -1;
            parsed.forEach(({ j, r }) => {
                let score = 0;
                CFIELDS.forEach(f => {
                    if (majority[f.k] === undefined) return;
                    if (f.norm(j ? j[f.k] : null) === majority[f.k]) score += f.w;
                });
                if (score > bestScore) { bestScore = score; best2 = r; }
            });
            best = best2 || parsed[0].r;
            // expose the fused field-wise majority so downstream can trust it even
            // if no single engine matched every field.
            // overall consensus confidence = weighted mean of per-field agreement
            let _wsum = 0, _csum = 0;
            CFIELDS.forEach(f => { const a = agreement[f.k]; if (a && a.of > 0) { _csum += f.w * a.ratio; _wsum += f.w; } });
            const _conf = _wsum ? Math.round((_csum / _wsum) * 1000) / 1000 : 0;
            try { best._consensusFields = majority; best._consensusAgreement = agreement; best._consensusConfidence = _conf; } catch (_) {}
        } else {
            best = good.sort((a, b) => b.reply.length - a.reply.length)[0];
        }
    } else {
        /* PROSE USED TO BE "THE LONGEST SUBSTANTIVE ANSWER", tie-broken by
         * speed. That is a length heuristic wearing a consensus label: it reads
         * every reply and lets none of them check any other, so the most verbose
         * engine won a vote that was never held.
         *
         * It is now a real cross-check — the answer the largest group of engines
         * actually agrees on, with disagreement and near misses reported. */
        proseDecision = Matrix.decide(good, { task });
        best = good.find(r => r.reply === proseDecision.reply && r.provider === proseDecision.provider) || good[0];
    }

    return res.status(200).json({
        reply: best.reply,
        provider: best.provider,
        mode: 'collective',
        requestedMode: requestedModeAlias,
        task,
        consensusOf: good.length,
        agreement: good.map(r => r.name),
        consensusFields: best._consensusFields || null,
        consensusConfidence: (best._consensusConfidence != null ? best._consensusConfidence : null),
        fieldAgreement: best._consensusAgreement || null,
        // Present on every path, so a caller never has to know which branch
        // produced its answer in order to find out how well supported it is.
        corroboration: proseDecision ? proseDecision.corroboration : {
            agreed: good.length, of: good.length, score: 1, dissent: [], nearMisses: [], numericConflict: false
        },
        trustworthy: proseDecision ? Matrix.trustworthy(proseDecision) : good.length >= 2,
        answered: good.map(r => r.name),
        failed: results.filter(r => !r.ok).map(r => r.name),
        latencyMs: best.ms,
        financialDecision: false, advisoryOnly: true
    });
}
